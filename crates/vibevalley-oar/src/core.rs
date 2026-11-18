//! The shared session kernel: sequencing, fan-out, status, history, the
//! record writer hook, and the control rules every adapter obeys.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::record::Recorder;
use crate::{AgentError, Capabilities, ContentBlock, Event, EventKind, PermissionDecision, Result, Session, SessionStatus, StopReason, Usage};

/// One-word reasons carried at the front of `AgentError::Rejected`
/// (`"busy: a turn is running"`); see `AgentError::rejection_code`. The words
/// are oar's `RejectionCode`s where one exists.
pub mod rejection {
    /// `prompt` while a turn is running.
    pub const BUSY: &str = "busy";
    /// `steer` / `abort` with nothing running.
    pub const NO_ACTIVE_TURN: &str = "no_active_turn";
    /// Any control after `dispose`.
    pub const DISPOSED: &str = "disposed";
    /// Any control after the runtime process went away on its own.
    pub const RUNTIME_EXITED: &str = "runtime_exited";
    /// `respond_permission` for an id that is not waiting.
    pub const UNKNOWN_REQUEST: &str = "unknown_request";
    /// Input the runtime cannot take (empty, an unreadable attachment).
    pub const UNSUPPORTED: &str = "unsupported";
    /// The runtime said no; the rest of the string is its message.
    pub const RUNTIME_REFUSED: &str = "runtime_refused";
}

pub(crate) fn rejected(code: &str, detail: impl AsRef<str>) -> AgentError {
    AgentError::Rejected(format!("{code}: {}", detail.as_ref()))
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Derives `SessionStatus` from events, one at a time. The same fold backs
/// `Session::status()`, so a status rebuilt from a record matches the live one.
///
/// Rules: a root `TurnStarted` runs until the root `TurnFinished`; while any
/// permission request (root or subagent) is unanswered the status is
/// `WaitingPermission`; a `Question` shows as `WaitingReply` once its turn
/// has finished; a turn that finished with `StopReason::Error`, or an `Error`
/// outside a turn, shows as `Failed` until the next turn starts; after
/// `SessionEnded` the status is `Failed` if it was failed, else `Ended`.
/// How many events a session keeps in memory for `events_with_history`.
pub const HISTORY_LIMIT: usize = 10_000;

#[derive(Debug, Clone, Default)]
pub struct StatusFold {
    turn_active: bool,
    pending_permissions: Vec<(String, Vec<String>)>,
    question: bool,
    failed: bool,
    ended: bool,
}

impl StatusFold {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&mut self, event: &Event) -> SessionStatus {
        let root = event.agent_path.is_empty();
        match &event.kind {
            EventKind::TurnStarted { .. } if root => {
                self.turn_active = true;
                self.question = false;
                self.failed = false;
                self.pending_permissions.clear();
            }
            EventKind::PermissionRequested { request_id, .. } => {
                self.pending_permissions.push((request_id.clone(), event.agent_path.clone()));
            }
            EventKind::PermissionResolved { request_id, .. } => {
                self.pending_permissions.retain(|(id, _)| id != request_id);
            }
            EventKind::Question { .. } if root => self.question = true,
            EventKind::TurnFinished { reason, .. } if root => {
                self.turn_active = false;
                self.pending_permissions.clear();
                self.failed = *reason == StopReason::Error;
            }
            EventKind::Error { .. } if !self.turn_active => self.failed = true,
            EventKind::SessionEnded => self.ended = true,
            _ => {}
        }
        self.status()
    }

    pub fn status(&self) -> SessionStatus {
        if self.ended {
            if self.failed { SessionStatus::Failed } else { SessionStatus::Ended }
        } else if self.turn_active {
            if self.pending_permissions.is_empty() {
                SessionStatus::Running
            } else {
                SessionStatus::WaitingPermission
            }
        } else if self.failed {
            SessionStatus::Failed
        } else if self.question {
            SessionStatus::WaitingReply
        } else {
            SessionStatus::Idle
        }
    }

    pub fn turn_active(&self) -> bool {
        self.turn_active
    }

    /// Ids of the permission requests still waiting for an answer.
    pub fn pending_permissions(&self) -> Vec<String> {
        self.pending_permissions.iter().map(|(id, _)| id.clone()).collect()
    }

    fn permission_path(&self, request_id: &str) -> Option<Vec<String>> {
        self.pending_permissions.iter().find(|(id, _)| id == request_id).map(|(_, p)| p.clone())
    }
}

/// The status after a whole event sequence (for example one from `read_record`).
pub fn derive_status<'a>(events: impl IntoIterator<Item = &'a Event>) -> SessionStatus {
    let mut fold = StatusFold::new();
    for event in events {
        fold.apply(event);
    }
    fold.status()
}

struct CoreState {
    next_seq: u64,
    subscribers: Vec<flume::Sender<Event>>,
    /// The newest `HISTORY_LIMIT` events, for late subscribers. The record
    /// file, when one is set, keeps everything.
    history: std::collections::VecDeque<Event>,
    fold: StatusFold,
    recorder: Option<Recorder>,
    ended: bool,
    disposed: bool,
    queue: VecDeque<Vec<ContentBlock>>,
}

type TurnHook = Arc<dyn Fn() + Send + Sync>;

pub(crate) struct SessionCore {
    runtime_id: String,
    session_id: String,
    state: Mutex<CoreState>,
    after_turn: Mutex<Option<TurnHook>>,
}

impl SessionCore {
    pub(crate) fn new(runtime_id: &str, session_id: &str, recorder: Option<Recorder>) -> Arc<Self> {
        Arc::new(Self {
            runtime_id: runtime_id.to_string(),
            session_id: session_id.to_string(),
            state: Mutex::new(CoreState {
                next_seq: 0,
                subscribers: Vec::new(),
                history: std::collections::VecDeque::new(),
                fold: StatusFold::new(),
                recorder,
                ended: false,
                disposed: false,
                queue: VecDeque::new(),
            }),
            after_turn: Mutex::new(None),
        })
    }

    fn lock(&self) -> MutexGuard<'_, CoreState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    fn emit_locked(&self, state: &mut CoreState, agent_path: Vec<String>, kind: EventKind) {
        if state.ended {
            return;
        }
        let event = Event {
            seq: state.next_seq,
            agent_path,
            at_ms: now_ms(),
            kind,
        };
        state.next_seq += 1;
        state.fold.apply(&event);
        if let Some(recorder) = state.recorder.as_mut()
            && recorder.write(&event).is_err()
        {
            // A full disk must not take the session down with it.
            state.recorder = None;
        }
        state.subscribers.retain(|subscriber| subscriber.send(event.clone()).is_ok());
        if matches!(event.kind, EventKind::SessionEnded) {
            state.ended = true;
            if let Some(mut recorder) = state.recorder.take() {
                recorder.end("session_ended");
            }
            // Receivers then see the channel close after the last event.
            state.subscribers.clear();
        }
        if state.history.len() == HISTORY_LIMIT {
            state.history.pop_front();
        }
        state.history.push_back(event);
    }

    pub(crate) fn emit(&self, agent_path: Vec<String>, kind: EventKind) {
        let finished_root_turn = agent_path.is_empty() && matches!(kind, EventKind::TurnFinished { .. });
        {
            let mut state = self.lock();
            self.emit_locked(&mut state, agent_path, kind);
        }
        if finished_root_turn {
            // Cloned out: the hook can finish another turn and re-enter `emit`.
            let hook = self.after_turn.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some(hook) = hook {
                hook();
            }
        }
    }

    pub(crate) fn emit_root(&self, kind: EventKind) {
        self.emit(Vec::new(), kind);
    }

    pub(crate) fn status(&self) -> SessionStatus {
        self.lock().fold.status()
    }

    pub(crate) fn turn_active(&self) -> bool {
        self.lock().fold.turn_active()
    }

    pub(crate) fn subscribe(&self, with_history: bool) -> flume::Receiver<Event> {
        let (tx, rx) = flume::unbounded();
        let mut state = self.lock();
        if with_history {
            for event in &state.history {
                let _ = tx.send(event.clone());
            }
        }
        if !state.ended {
            state.subscribers.push(tx);
        }
        rx
    }

    fn unreachable(state: &CoreState) -> Option<AgentError> {
        if state.disposed {
            Some(rejected(rejection::DISPOSED, "the session was disposed"))
        } else if state.ended {
            Some(rejected(rejection::RUNTIME_EXITED, "the runtime process has exited"))
        } else {
            None
        }
    }

    /// Atomically: refuse when unreachable or busy, else record the turn's start.
    pub(crate) fn begin_turn(&self, prompt: &str) -> Result<()> {
        let mut state = self.lock();
        if let Some(error) = Self::unreachable(&state) {
            return Err(error);
        }
        if state.fold.turn_active() {
            return Err(rejected(rejection::BUSY, "a turn is running; use steer or queue"));
        }
        self.emit_locked(&mut state, Vec::new(), EventKind::TurnStarted { prompt: prompt.to_string() });
        Ok(())
    }

    /// Starts the turn when idle (`Ok(true)`), else holds the input (`Ok(false)`).
    fn begin_turn_or_queue(&self, content: &[ContentBlock]) -> Result<bool> {
        let mut state = self.lock();
        if let Some(error) = Self::unreachable(&state) {
            return Err(error);
        }
        if state.fold.turn_active() || !state.queue.is_empty() {
            state.queue.push_back(content.to_vec());
            return Ok(false);
        }
        self.emit_locked(&mut state, Vec::new(), EventKind::TurnStarted { prompt: render_text(content) });
        Ok(true)
    }

    fn next_queued(&self) -> Option<Vec<ContentBlock>> {
        let mut state = self.lock();
        if state.ended || state.fold.turn_active() {
            return None;
        }
        let next = state.queue.pop_front()?;
        self.emit_locked(&mut state, Vec::new(), EventKind::TurnStarted { prompt: render_text(&next) });
        Some(next)
    }

    /// Ends the stream: an optional error, the open turn's end, `SessionEnded`.
    /// Idempotent; whoever notices the end first (dispose or process exit) wins.
    pub(crate) fn finish(&self, error: Option<String>) {
        let mut state = self.lock();
        if state.ended {
            return;
        }
        let disposed = state.disposed;
        if let Some(message) = error
            && !disposed
        {
            self.emit_locked(&mut state, Vec::new(), EventKind::Error { message });
        }
        if state.fold.turn_active() {
            let reason = if disposed { StopReason::Aborted } else { StopReason::Error };
            self.emit_locked(
                &mut state,
                Vec::new(),
                EventKind::TurnFinished {
                    reason,
                    usage: Usage::default(),
                },
            );
        }
        state.queue.clear();
        self.emit_locked(&mut state, Vec::new(), EventKind::SessionEnded);
    }

    pub(crate) fn is_disposed(&self) -> bool {
        self.lock().disposed
    }
}

/// What an adapter supplies; `CoreSession` wraps it with the shared rules.
pub(crate) trait Driver: Send + Sync + 'static {
    /// Refuses content the runtime cannot take, before the turn is recorded.
    fn check_content(&self, _content: &[ContentBlock]) -> Result<()> {
        Ok(())
    }
    fn start_turn(&self, content: Vec<ContentBlock>) -> Result<()>;
    fn steer(&self, content: Vec<ContentBlock>) -> Result<()>;
    fn abort(&self) -> Result<()>;
    fn respond_permission(&self, request_id: &str, decision: &PermissionDecision) -> Result<()>;
    fn dispose(&self);
}

pub(crate) struct CoreSession<D: Driver> {
    core: Arc<SessionCore>,
    driver: D,
    capabilities: Capabilities,
}

impl<D: Driver> CoreSession<D> {
    pub(crate) fn new(core: Arc<SessionCore>, driver: D, capabilities: Capabilities) -> Arc<Self> {
        let session = Arc::new(Self {
            core: core.clone(),
            driver,
            capabilities,
        });
        let weak: Weak<Self> = Arc::downgrade(&session);
        *core.after_turn.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(move || {
            if let Some(session) = weak.upgrade() {
                session.drain_queue();
            }
        }));
        session
    }

    fn drain_queue(&self) {
        if let Some(content) = self.core.next_queued() {
            let _ = self.run_turn(content);
        }
    }

    /// The turn's start is already recorded; a failed hand-over ends it.
    fn run_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        if let Err(error) = self.driver.start_turn(content) {
            self.core.emit_root(EventKind::Error { message: error.to_string() });
            self.core.emit_root(EventKind::TurnFinished {
                reason: StopReason::Error,
                usage: Usage::default(),
            });
            return Err(error);
        }
        Ok(())
    }

    fn check(&self, content: &[ContentBlock]) -> Result<()> {
        if content.is_empty() {
            return Err(rejected(rejection::UNSUPPORTED, "empty input"));
        }
        self.driver.check_content(content)
    }
}

impl<D: Driver> Session for CoreSession<D> {
    fn id(&self) -> String {
        self.core.session_id().to_string()
    }

    fn runtime_id(&self) -> &str {
        self.core.runtime_id()
    }

    fn status(&self) -> SessionStatus {
        self.core.status()
    }

    fn events(&self) -> flume::Receiver<Event> {
        self.core.subscribe(false)
    }

    fn events_with_history(&self) -> flume::Receiver<Event> {
        self.core.subscribe(true)
    }

    fn prompt(&self, content: Vec<ContentBlock>) -> Result<()> {
        self.check(&content)?;
        self.core.begin_turn(&render_text(&content))?;
        self.run_turn(content)
    }

    fn steer(&self, content: Vec<ContentBlock>) -> Result<()> {
        if !self.capabilities.steer {
            return Err(AgentError::Unsupported {
                option: "steer".into(),
                reason: format!("{} cannot inject input into a running turn; use queue", self.core.runtime_id()),
            });
        }
        self.check(&content)?;
        {
            let state = self.core.lock();
            if let Some(error) = SessionCore::unreachable(&state) {
                return Err(error);
            }
            if !state.fold.turn_active() {
                return Err(rejected(rejection::NO_ACTIVE_TURN, "nothing is running; use prompt"));
            }
        }
        self.driver.steer(content)
    }

    fn queue(&self, content: Vec<ContentBlock>) -> Result<()> {
        if !self.capabilities.queue {
            return Err(AgentError::Unsupported {
                option: "queue".into(),
                reason: format!("{} does not hold input", self.core.runtime_id()),
            });
        }
        self.check(&content)?;
        if self.core.begin_turn_or_queue(&content)? {
            return self.run_turn(content);
        }
        Ok(())
    }

    /// Also withdraws input still held by `queue`: a stopped session must
    /// not start the next turn by itself.
    fn abort(&self) -> Result<()> {
        {
            let mut state = self.core.lock();
            if let Some(error) = SessionCore::unreachable(&state) {
                return Err(error);
            }
            if !state.fold.turn_active() {
                return Err(rejected(rejection::NO_ACTIVE_TURN, "nothing is running"));
            }
            state.queue.clear();
        }
        self.driver.abort()
    }

    fn respond_permission(&self, request_id: &str, decision: PermissionDecision) -> Result<()> {
        let path = {
            let state = self.core.lock();
            if let Some(error) = SessionCore::unreachable(&state) {
                return Err(error);
            }
            state.fold.permission_path(request_id)
        };
        let Some(path) = path else {
            return Err(rejected(rejection::UNKNOWN_REQUEST, format!("no permission request `{request_id}` is waiting")));
        };
        self.driver.respond_permission(request_id, &decision)?;
        self.core.emit(
            path,
            EventKind::PermissionResolved {
                request_id: request_id.to_string(),
                decision,
            },
        );
        Ok(())
    }

    fn dispose(&self) {
        {
            let mut state = self.core.lock();
            if state.disposed {
                return;
            }
            state.disposed = true;
        }
        self.driver.dispose();
        self.core.finish(None);
    }
}

impl<D: Driver> Drop for CoreSession<D> {
    fn drop(&mut self) {
        if !self.core.is_disposed() {
            self.driver.dispose();
            self.core.finish(None);
        }
    }
}

/// The prompt as one string, for `TurnStarted` and for text-only runtimes.
pub(crate) fn render_text(content: &[ContentBlock]) -> String {
    let mut out = String::new();
    for block in content {
        if !out.is_empty() {
            out.push('\n');
        }
        match block {
            ContentBlock::Text(text) => out.push_str(text),
            ContentBlock::File { path, lines: Some((from, to)) } => {
                out.push_str(&format!("@{}:{from}-{to}", path.display()));
            }
            ContentBlock::File { path, lines: None } => out.push_str(&format!("@{}", path.display())),
            ContentBlock::Image { path } => out.push_str(&format!("[image: {}]", path.display())),
        }
    }
    out
}

pub(crate) fn absolute(cwd: &std::path::Path, path: &std::path::Path) -> PathBuf {
    if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) }
}

/// A file attachment as text for the model: a reference, and for a line
/// range the lines themselves (1-based, inclusive).
pub(crate) fn file_as_text(cwd: &std::path::Path, path: &std::path::Path, lines: Option<(u32, u32)>) -> Result<String> {
    let full = absolute(cwd, path);
    let Some((from, to)) = lines else {
        return Ok(format!("File: {}", full.display()));
    };
    let text = std::fs::read_to_string(&full).map_err(|e| rejected(rejection::UNSUPPORTED, format!("cannot read {}: {e}", full.display())))?;
    let excerpt: Vec<&str> = text
        .lines()
        .skip(from.saturating_sub(1) as usize)
        .take((to.saturating_sub(from) + 1) as usize)
        .collect();
    Ok(format!("File: {} (lines {from}-{to})\n```\n{}\n```", full.display(), excerpt.join("\n")))
}

/// Options every process adapter checks the same way, before anything starts.
pub(crate) fn check_cwd(cwd: &std::path::Path) -> Result<()> {
    if cwd.as_os_str().is_empty() {
        return Err(AgentError::Unsupported {
            option: "cwd".into(),
            reason: "a working directory is required".into(),
        });
    }
    if !cwd.is_dir() {
        return Err(AgentError::Unsupported {
            option: "cwd".into(),
            reason: format!("{} is not a directory", cwd.display()),
        });
    }
    Ok(())
}
