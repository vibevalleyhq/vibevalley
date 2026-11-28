//! Shared subprocess lifecycle, pending-request correlation, and wire helpers
//! factored out of the `claude`, `codex`, and `acp` OAR providers.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::{Mutex, MutexGuard};
use serde_json::Value;

use crate::core::{SessionCore, rejected, rejection};
use crate::process::{AbortWatchdog, LineChild};
use crate::record::{self, Recorder};
use crate::{AgentError, EventKind, PermissionDecision, Result, SessionOptions};

/// Grace period before an unresponsive aborted subprocess is forcibly killed.
pub(crate) const ABORT_GRACE: Duration = Duration::from_secs(10);

pub(crate) fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Formats a subprocess exit status with optional trimmed stderr tail.
pub(crate) fn format_exit_message(label: &str, code: Option<i32>, stderr: &str) -> String {
    let mut message = match code {
        Some(code) => format!("{label} exited with status {code}"),
        None => format!("{label} exited"),
    };
    append_stderr(&mut message, stderr);
    message
}

pub(crate) fn append_stderr(message: &mut String, stderr: &str) {
    let trimmed = stderr.trim();
    if !trimmed.is_empty() {
        message.push_str(": ");
        message.push_str(trimmed);
    }
}

/// Decodes one NDJSON stdout line, logging a warning for non-empty malformed lines.
pub(crate) fn parse_stdout_json(runtime: &str, line: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(line) {
        Ok(v) => Some(v),
        Err(err) => {
            if !line.trim().is_empty() {
                tracing::warn!(runtime = %runtime, error = %err, line_len = line.len(), "dropped malformed JSON stdout line");
            }
            None
        }
    }
}

/// Converts a `[0.0, 100.0]` percentage into a `[0.0, 1.0]` ratio rounded to 6 decimal places.
pub(crate) fn ratio_from_percent(percent: f64) -> f64 {
    (percent / 100.0 * 1e6).round() / 1e6
}

/// Opens the optional voyage record file and constructs the session kernel.
pub(crate) fn open_session_core(runtime_id: &str, session_id: &str, opts: &SessionOptions, model: Option<&str>) -> Result<Arc<SessionCore>> {
    let file = record::open_file(opts.record_to.as_deref())?;
    let recorder = Recorder::start(file, runtime_id, session_id, &opts.cwd, model);
    Ok(SessionCore::new(runtime_id, session_id, recorder))
}

/// Shared subprocess handle + abort watchdog + exit message latch for line-oriented providers.
pub(crate) struct ChildProcess {
    child: OnceLock<Arc<LineChild>>,
    watchdog: Arc<AbortWatchdog>,
    exit: Mutex<Option<String>>,
}

impl ChildProcess {
    pub(crate) fn new() -> Self {
        Self {
            child: OnceLock::new(),
            watchdog: AbortWatchdog::new(),
            exit: Mutex::new(None),
        }
    }

    pub(crate) fn attach(&self, child: Arc<LineChild>) {
        let _ = self.child.set(child);
    }

    pub(crate) fn require(&self, label: &str) -> Result<&Arc<LineChild>> {
        self.child.get().ok_or_else(|| AgentError::Io(format!("{label} is not running")))
    }

    pub(crate) fn status(&self) -> Option<(i32, String)> {
        self.child.get().and_then(|c| c.status())
    }

    pub(crate) fn stderr_text(&self) -> String {
        self.child.get().map(|c| c.stderr_text()).unwrap_or_default()
    }

    pub(crate) fn on_turn_finished(&self) {
        self.watchdog.on_turn_finished();
    }

    pub(crate) fn arm_abort(&self, core: &Arc<SessionCore>) {
        if let Some(child) = self.child.get() {
            self.watchdog.arm(ABORT_GRACE, core.clone(), child.clone());
        }
    }

    pub(crate) fn record_exit(&self, message: String) {
        *self.exit.lock() = Some(message);
    }

    pub(crate) fn exit_message(&self) -> Option<String> {
        self.exit.lock().clone()
    }

    /// Finishes the session kernel (if opened) when the child exits, or wakes any abort watchdog.
    pub(crate) fn finish_exit(&self, core: Option<&SessionCore>, message: String) {
        if let Some(core) = core {
            core.observe_exit(self.status());
            self.watchdog.finish_on_exit(core, message);
        } else {
            self.watchdog.wake();
        }
    }

    pub(crate) async fn kill_child(&self) {
        if let Some(child) = self.child.get() {
            child.kill().await;
        }
    }

    pub(crate) async fn dispose(&self, core: Option<&SessionCore>) {
        if let Some(child) = self.child.get() {
            child.kill().await;
            if let Some(core) = core {
                core.observe_exit(child.status());
            }
        }
        self.watchdog.wake();
    }

    pub(crate) fn signal_dispose(&self, core: Option<&SessionCore>) {
        if let Some(child) = self.child.get() {
            child.signal_kill();
            if let Some(core) = core {
                core.observe_exit(child.status());
            }
        }
        self.watchdog.wake();
    }
}

/// Correlated pending permission or interaction table keyed by request id.
pub(crate) struct PendingTable<V> {
    entries: Mutex<HashMap<String, V>>,
}

impl<V> Default for PendingTable<V> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<V> PendingTable<V> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn insert(&self, request_id: String, entry: V) {
        self.entries.lock().insert(request_id, entry);
    }

    pub(crate) fn remove(&self, request_id: &str) -> Option<V> {
        self.entries.lock().remove(request_id)
    }

    pub(crate) fn take(&self, request_id: &str, runtime_label: &str) -> Result<V> {
        self.entries
            .lock()
            .remove(request_id)
            .ok_or_else(|| rejected(rejection::UNKNOWN_REQUEST, format!("{runtime_label} no longer waits on `{request_id}`")))
    }

    pub(crate) fn clear(&self) {
        self.entries.lock().clear();
    }

    pub(crate) fn drain_all(&self) -> Vec<(String, V)> {
        self.entries.lock().drain().collect()
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, HashMap<String, V>> {
        self.entries.lock()
    }

    /// Removes a withdrawn permission request and emits the standard `PermissionResolved` denial.
    pub(crate) fn withdraw_permission(&self, request_id: String, core: &SessionCore, agent_path: impl FnOnce(&V) -> Vec<String>, reason: &str) {
        if let Some(entry) = self.remove(&request_id) {
            core.emit(
                agent_path(&entry),
                EventKind::PermissionResolved {
                    request_id,
                    decision: PermissionDecision::Deny {
                        message: Some(reason.to_owned()),
                    },
                },
            );
        }
    }
}

/// Monotonically numbered outbound RPC / control-request waiter table.
pub(crate) struct PendingCalls<K, V> {
    next_id: AtomicU64,
    pending: Mutex<HashMap<K, V>>,
}

impl<K: Eq + Hash, V> PendingCalls<K, V> {
    pub(crate) fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn next_seq(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub(crate) fn insert(&self, key: K, waiter: V) {
        self.pending.lock().insert(key, waiter);
    }

    pub(crate) fn remove(&self, key: &K) -> Option<V> {
        self.pending.lock().remove(key)
    }

    pub(crate) fn drain_all(&self) -> Vec<(K, V)> {
        self.pending.lock().drain().collect()
    }
}
