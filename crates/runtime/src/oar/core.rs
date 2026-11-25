//! The shared session kernel: sequencing, fan-out, status, history, the
//! record writer hook, and the control rules every adapter obeys.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use arc_swap::ArcSwapOption;
use parking_lot::{Mutex, MutexGuard};
use tokio::sync::mpsc;

use crate::BoxFuture;
use crate::oar::record::Recorder;
use crate::oar::voyage::{normalize_trace_id, now_ms};
use crate::oar::{
    AgentError, Capabilities, ContentBlock, Event, EventKind, InteractionDecision, PermissionDecision, PermissionMode, Result, Session, SessionStatus,
    StopReason, TurnOptions, Usage,
};

pub trait OarObserver: Send + Sync {
    fn on_event(&self, session_id: &str, event: &Event);
}

struct ObserverSlot(Arc<dyn OarObserver>);

static OBSERVER: ArcSwapOption<ObserverSlot> = ArcSwapOption::const_empty();

pub fn set_observer(observer: Option<Arc<dyn OarObserver>>) {
    OBSERVER.store(observer.map(|obs| Arc::new(ObserverSlot(obs))));
}

pub fn has_observer() -> bool {
    OBSERVER.load().is_some()
}

fn notify_observer(session_id: &str, event: &Event) {
    if let Some(slot) = OBSERVER.load_full() {
        slot.0.on_event(session_id, event);
    }
}

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
/// Cap on in-memory voyage records when no disk `record_to` file is attached.
pub const RECORD_HISTORY_LIMIT: usize = 1_024;

#[derive(Debug, Clone, Default)]
pub struct StatusFold {
    turn_active: bool,
    pending_permissions: Vec<(String, Vec<String>)>,
    pending_interactions: Vec<(String, Vec<String>)>,
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
                self.pending_interactions.clear();
            }
            EventKind::PermissionRequested { request_id, .. } => {
                self.pending_permissions.push((request_id.clone(), event.agent_path.clone()));
            }
            EventKind::PermissionResolved { request_id, .. } => {
                self.pending_permissions.retain(|(id, _)| id != request_id);
            }
            EventKind::InteractionRequested { request_id, .. } => {
                self.pending_interactions.push((request_id.clone(), event.agent_path.clone()));
            }
            EventKind::InteractionResolved { request_id, .. } => {
                self.pending_interactions.retain(|(id, _)| id != request_id);
            }
            EventKind::Question { .. } if root => self.question = true,
            EventKind::TurnFinished { reason, .. } if root => {
                self.turn_active = false;
                self.pending_permissions.clear();
                self.pending_interactions.clear();
                self.failed = *reason == StopReason::Error;
            }
            EventKind::Error { .. } if root && !self.turn_active => self.failed = true,
            EventKind::SessionEnded => self.ended = true,
            _ => {}
        }
        self.status()
    }

    pub fn status(&self) -> SessionStatus {
        if self.ended {
            if self.failed { SessionStatus::Failed } else { SessionStatus::Ended }
        } else if !self.pending_interactions.is_empty() {
            SessionStatus::WaitingReply
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

    /// Ids of the interactive questions still waiting for a reply.
    pub fn pending_interactions(&self) -> Vec<String> {
        self.pending_interactions.iter().map(|(id, _)| id.clone()).collect()
    }

    fn permission_path(&self, request_id: &str) -> Option<Vec<String>> {
        self.pending_permissions.iter().find(|(id, _)| id == request_id).map(|(_, p)| p.clone())
    }

    fn interaction_path(&self, request_id: &str) -> Option<Vec<String>> {
        self.pending_interactions.iter().find(|(id, _)| id == request_id).map(|(_, p)| p.clone())
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
    subscribers: Vec<mpsc::UnboundedSender<Event>>,
    /// The newest `HISTORY_LIMIT` events, for late subscribers. The record
    /// file, when one is set, keeps everything.
    history: std::collections::VecDeque<Event>,
    fold: StatusFold,
    recorder: Option<Recorder>,
    /// Disk backing file and sequence offset when `record_to` is set; avoids
    /// duplicating every raw wire frame into RAM when no live consumer reads `records()`.
    record_path: Option<PathBuf>,
    record_base: u64,
    next_record_seq: u64,
    records: VecDeque<crate::oar::voyage::Record>,
    last_usage: Option<crate::oar::TokenTotals>,
    frames: std::collections::HashMap<std::thread::ThreadId, crate::oar::voyage::Record>,
    record_subscribers: Vec<mpsc::UnboundedSender<crate::oar::voyage::Record>>,
    ended: bool,
    disposed: bool,
    unresumable: bool,
    queue: VecDeque<QueuedInput>,
    meter: crate::oar::accounting::Meter,
    extras: crate::oar::frames::Frames,
    last_error: Option<String>,
    process_exit: Option<(i32, String)>,
    exit_error: Option<String>,
    previous_turn: Option<crate::oar::TokenTotals>,
    root_usage_seen: bool,
    child_meters: std::collections::HashMap<Vec<String>, crate::oar::accounting::Meter>,
    compacting: bool,
    manual_compaction: bool,
    input_id: String,
    span_id: String,
    trace_id: Option<u64>,
}

struct QueuedInput {
    content: Vec<ContentBlock>,
    id: String,
    span: String,
    trace_id: Option<u64>,
}

type TurnHook = Arc<dyn Fn() + Send + Sync>;

pub struct SessionCore {
    runtime_id: String,
    session_id: Mutex<String>,
    state: Mutex<CoreState>,
    after_turn: Mutex<Option<TurnHook>>,
}

pub(crate) struct FrameGuard<'a> {
    core: &'a SessionCore,
    producer: std::thread::ThreadId,
}
impl Drop for FrameGuard<'_> {
    fn drop(&mut self) {
        self.core.flush_frame(&mut self.core.lock(), self.producer);
    }
}

impl SessionCore {
    pub fn new(runtime_id: &str, session_id: &str, recorder: Option<Recorder>) -> Arc<Self> {
        let record_path = recorder.as_ref().map(|r| r.path().to_path_buf());
        let record_base = recorder.as_ref().map_or(0, Recorder::base);
        Arc::new(Self {
            runtime_id: runtime_id.to_string(),
            session_id: Mutex::new(session_id.to_string()),
            state: Mutex::new(CoreState {
                next_seq: 0,
                subscribers: Vec::new(),
                history: std::collections::VecDeque::new(),
                fold: StatusFold::new(),
                recorder,
                record_path,
                record_base,
                next_record_seq: 0,
                records: VecDeque::new(),
                last_usage: None,
                frames: Default::default(),
                record_subscribers: vec![],
                ended: false,
                disposed: false,
                unresumable: false,
                queue: VecDeque::new(),
                meter: Default::default(),
                extras: Default::default(),
                last_error: None,
                process_exit: None,
                exit_error: None,
                previous_turn: Some(Default::default()),
                root_usage_seen: false,
                child_meters: Default::default(),
                compacting: false,
                manual_compaction: false,
                input_id: String::new(),
                span_id: String::new(),
                trace_id: None,
            }),
            after_turn: Mutex::new(None),
        })
    }

    fn lock(&self) -> MutexGuard<'_, CoreState> {
        self.state.lock()
    }

    pub(crate) fn session_id(&self) -> String {
        self.session_id.lock().clone()
    }

    pub(crate) fn identify(&self, id: &str) -> bool {
        let mut known = self.session_id.lock();
        if known.as_str() == id {
            return false;
        }
        *known = id.to_owned();
        true
    }

    pub(crate) fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub(crate) fn mark_unresumable(&self) {
        self.lock().unresumable = true;
    }

    fn external(&self) -> bool {
        matches!(
            self.runtime_id(),
            "claude" | "codex" | "antigravity" | "qwen" | "qoder" | "kimi" | "grok" | "opencode" | "codebuddy"
        ) || self.runtime_id().starts_with("acp:")
    }

    fn emit_locked(&self, state: &mut CoreState, agent_path: Vec<String>, mut kind: EventKind) -> Option<(String, Event)> {
        if state.ended {
            return None;
        }
        if agent_path.is_empty() && self.external() {
            match &mut kind {
                EventKind::TurnStarted { .. } => {
                    state.root_usage_seen = false;
                    state.meter.turn_local = None;
                }
                EventKind::TurnFinished { usage, .. } => {
                    let total = state.root_usage_seen.then_some(state.meter.totals).flatten();
                    let delta = total.and_then(|total| {
                        state.meter.turn_local.or_else(|| {
                            let base = state.previous_turn?;
                            if base == crate::oar::TokenTotals::default() {
                                return Some(total);
                            }
                            (total.input_tokens >= base.input_tokens && total.output_tokens >= base.output_tokens).then(|| total.subtract(base))
                        })
                    });
                    *usage = delta.map(|d| d.native_with_context(state.meter.last_context_pair)).unwrap_or_else(|| {
                        let (context_used_tokens, context_window_tokens) = match state.meter.last_context_pair {
                            Some((u, w)) if u > 0 && w > 0 => (Some(u), Some(w)),
                            _ => (None, None),
                        };
                        Usage {
                            context_used_tokens,
                            context_window_tokens,
                            ..Default::default()
                        }
                    });
                    state.previous_turn = total;
                }
                _ => {}
            }
        }
        if state.manual_compaction && agent_path.is_empty() && matches!(kind, EventKind::TurnFinished { .. }) {
            if state.compacting {
                self.compact_event(state, false, "completed");
            }
            state.compacting = false;
            state.manual_compaction = false;
            state.span_id.clear();
            state.trace_id = None;
            return None;
        }
        let event = Event {
            seq: state.next_seq,
            agent_path,
            at_ms: now_ms(),
            kind,
        };
        state.next_seq += 1;
        state.fold.apply(&event);
        if event.agent_path.is_empty() && matches!(event.kind, EventKind::TurnStarted { .. }) && state.span_id.is_empty() {
            state.span_id = format!("turn-{}", event.seq);
        }
        let mut envelope = crate::oar::voyage::Record::event(self.session_id(), &event);
        // Lock-free atomic check avoids cloning when no observer is installed; callbacks run after callers drop `state`.
        let observed = has_observer().then(|| (envelope.session_id.clone(), event.clone()));
        if event.agent_path.is_empty() {
            if let EventKind::Error { message } = &event.kind {
                state.last_error = Some(message.clone());
            }
            if matches!(event.kind, EventKind::TurnStarted { .. }) {
                envelope.frame_type = match self.runtime_id() {
                    "claude" | "qwen" | "qoder" => "user_prompt",
                    "codex" => "turn/start",
                    _ => "session/prompt",
                }
                .into();
                if !state.input_id.is_empty() {
                    envelope.events[0]["requestId"] = serde_json::json!(state.input_id);
                }
                state.last_error = None;
            }
            if matches!(event.kind, EventKind::TurnFinished { reason: StopReason::Error, .. })
                && let Some(end) = envelope.events.iter_mut().find(|v| v["kind"] == "turn_ended")
            {
                let reason = state.last_error.as_deref().unwrap_or("runtime failed");
                end["outcome"]["reason"] = serde_json::json!(reason);
                end["outcome"]["failure"] = serde_json::json!(crate::oar::frames::failure(reason));
            }
        }
        if matches!(event.kind, EventKind::SessionEnded)
            && let Some((code, signal)) = &state.process_exit
        {
            envelope.frame_type = "exited".into();
            envelope.marker = Some(serde_json::json!({"name":"exited"}));
            envelope.events = vec![serde_json::json!({"kind":"exited","code":code})];
            if !signal.is_empty() {
                envelope.events[0]["signal"] = serde_json::json!(signal);
            }
        }
        if self.external() {
            envelope.events.retain(|e| e["kind"] != "usage");
        }
        let producer = std::thread::current().id();
        if let Some(frame) = state.frames.get_mut(&producer)
            && frame.agent_path == event.agent_path
        {
            frame.events.append(&mut envelope.events);
            frame.native_events.append(&mut envelope.native_events);
            if matches!(event.kind, EventKind::TurnFinished { .. } | EventKind::SessionEnded) {
                self.flush_frame(state, producer);
            }
        } else {
            // A single notification can update the caller and several child paths.
            // Flush earlier native events before writing an event on another path.
            if state.frames.get(&producer).is_some_and(|frame| !frame.native_events.is_empty()) {
                self.flush_frame(state, producer);
            }
            self.record_locked(state, envelope);
        }
        if event.agent_path.is_empty() && matches!(event.kind, EventKind::TurnFinished { .. }) {
            state.span_id.clear();
            state.trace_id = None;
        }
        state.subscribers.retain(|subscriber| subscriber.send(event.clone()).is_ok());
        if matches!(event.kind, EventKind::SessionEnded) {
            state.ended = true;
            state.recorder.take();
            state.record_subscribers.clear();
            // Receivers then see the channel close after the last event.
            state.subscribers.clear();
        }
        if state.history.len() == HISTORY_LIMIT {
            state.history.pop_front();
        }
        state.history.push_back(event);
        observed
    }

    fn record_locked(&self, state: &mut CoreState, mut record: crate::oar::voyage::Record) {
        record.seq = state.next_record_seq;
        state.next_record_seq += 1;
        if record.span_id.is_empty() {
            record.span_id = state.span_id.clone();
        }
        record.trace_id = normalize_trace_id(record.trace_id).or(state.trace_id);
        if record.agent_path.is_empty() {
            for e in &record.events {
                if e["kind"] == "usage" {
                    state.last_usage = serde_json::from_value(e["usage"]["tokens"].clone()).ok();
                }
            }
        }
        if let Some(recorder) = state.recorder.as_mut()
            && recorder.write(&record).is_err()
        {
            state.recorder = None;
        }
        if !state.record_subscribers.is_empty() {
            state.record_subscribers.retain(|s| s.send(record.clone()).is_ok());
        }
        if state.record_path.is_none() {
            if state.records.len() == RECORD_HISTORY_LIMIT {
                state.records.pop_front();
            }
            state.records.push_back(record);
        }
    }

    pub(crate) fn resume_meter(&self, base: &serde_json::Value, reason: &'static str) {
        let mut s = self.lock();
        s.meter.resume(reason);
        s.meter.baseline(base);
    }

    fn compact_event(&self, state: &mut CoreState, start: bool, why: &str) {
        let mut rec = crate::oar::voyage::Record::new(crate::oar::voyage::Kind::Frame, self.session_id(), now_ms());
        let e = if start {
            serde_json::json!({"kind":"compaction_started","trigger":why})
        } else {
            serde_json::json!({"kind":"compaction_ended","compactionOutcome":why})
        };
        rec.frame_type = e["kind"].as_str().unwrap_or_default().into();
        rec.events.push(e);
        self.record_locked(state, rec);
    }
    pub fn span_id(&self) -> String {
        self.lock().span_id.clone()
    }
    pub(crate) fn child_session(&self, parent: &str, child: &str, path: &[String]) {
        let mut rec = crate::oar::voyage::Record::new(crate::oar::voyage::Kind::Marker, self.session_id(), now_ms());
        rec.frame_type = if self.runtime_id() == "codex" {
            "child_thread_associated"
        } else {
            "child_session_associated"
        }
        .into();
        rec.agent_path = path.to_vec();
        rec.events
            .push(serde_json::json!({"kind":"child_session","parentSessionId":parent,"childSessionId":child}));
        self.record_locked(&mut self.lock(), rec);
    }
    fn flush_frame(&self, state: &mut CoreState, producer: std::thread::ThreadId) {
        if let Some(mut rec) = state.frames.remove(&producer) {
            rec.events.sort_by_key(|e| e["kind"] == "usage");
            if self.runtime_id() == "codex"
                && matches!(rec.frame_type.as_str(), "item/started" | "item/completed")
                && let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&rec.raw)
            {
                let item = &raw["params"]["item"];
                for e in &mut rec.events {
                    if e["kind"] == "tool_call_started" && item["type"] == "commandExecution" {
                        e["tool"] = serde_json::json!("bash");
                    }
                    if e["kind"] == "tool_call_ended"
                        && let Some(code) = item["exitCode"].as_i64()
                    {
                        e["exitCode"] = serde_json::json!(code);
                    }
                }
            }
            self.record_locked(state, rec);
        }
    }
    #[must_use]
    pub(crate) fn record_raw(&self, kind: &str, path: Vec<String>, line: &str, frame: &serde_json::Value) -> FrameGuard<'_> {
        let producer = std::thread::current().id();
        let guard = FrameGuard { core: self, producer };
        let mut state = self.lock();
        if state.ended {
            return guard;
        }
        let mut record = crate::oar::voyage::Record::new(crate::oar::voyage::Kind::Frame, self.session_id(), now_ms());
        let compact_item = matches!(
            frame.pointer("/item/type").and_then(serde_json::Value::as_str),
            Some("contextCompaction" | "compaction")
        );
        if (kind == "system/status" && frame["status"] == "compacting" || kind == "item/started" && compact_item) && !state.compacting {
            state.compacting = true;
            self.compact_event(&mut state, true, "auto");
        }
        if kind == "system/compact_boundary" || kind == "item/completed" && compact_item {
            self.compact_event(&mut state, false, "completed");
            state.compacting = false;
        }
        let meter = if path.is_empty() {
            &mut state.meter
        } else {
            state.child_meters.entry(path.clone()).or_default()
        };
        let telemetry = match self.runtime_id() {
            "claude" | "qwen" | "qoder" => meter.stream(self.runtime_id(), frame),
            "codex" => meter.codex(kind, frame, path.is_empty()),
            runtime if kind == "session/prompt_result" => meter.acp(
                runtime,
                &serde_json::json!({
                    "sessionUpdate": "usage_update",
                    "usage": frame["usage"],
                    "used": frame.get("used").or_else(|| frame.pointer("/context/used")),
                    "size": frame.get("size").or_else(|| frame.pointer("/context/size")),
                }),
            ),
            runtime => meter.acp(runtime, &frame["update"]),
        };
        if let Some(ev) = telemetry {
            if path.is_empty() {
                state.root_usage_seen = true;
            }
            record.events.push(ev);
        }
        record.events.extend(state.extras.extras(kind, &path, frame));
        record.agent_path = path;
        record.raw = line.as_bytes().to_vec();
        record.frame_type = kind.to_string();
        record.span_id = state.span_id.clone();
        record.trace_id = state.trace_id;
        self.flush_frame(&mut state, producer);
        state.frames.insert(producer, record);
        guard
    }

    pub(crate) fn emit(&self, agent_path: Vec<String>, kind: EventKind) {
        let finished_root_turn = agent_path.is_empty() && matches!(kind, EventKind::TurnFinished { .. });
        let observed = {
            let mut state = self.lock();
            self.emit_locked(&mut state, agent_path, kind)
        };
        if let Some((session_id, event)) = observed {
            notify_observer(&session_id, &event);
        }
        if finished_root_turn {
            // Cloned out: the hook can finish another turn and re-enter `emit`.
            let hook = self.after_turn.lock().clone();
            if let Some(hook) = hook {
                hook();
            }
        }
    }

    pub fn emit_root(&self, kind: EventKind) {
        self.emit(Vec::new(), kind);
    }

    pub(crate) fn status(&self) -> SessionStatus {
        self.lock().fold.status()
    }

    pub(crate) fn turn_active(&self) -> bool {
        self.lock().fold.turn_active()
    }

    pub(crate) fn subscribe(&self, with_history: bool) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded_channel();
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
    pub fn begin_turn(&self, prompt: &str) -> Result<()> {
        self.begin_turn_with(prompt, TurnOptions::default())
    }

    pub fn begin_turn_with(&self, prompt: &str, opts: TurnOptions) -> Result<()> {
        self.begin_span(prompt, "", "", opts.trace_id)
    }

    fn begin_span(&self, prompt: &str, input_id: &str, span: &str, trace_id: Option<u64>) -> Result<()> {
        let observed = {
            let mut state = self.lock();
            if let Some(error) = Self::unreachable(&state) {
                return Err(error);
            }
            if state.compacting {
                return Err(rejected("compacting", "compaction is running"));
            }
            if state.fold.turn_active() {
                return Err(rejected(rejection::BUSY, "a turn is running; use steer or queue"));
            }
            state.span_id = span.into();
            state.input_id = input_id.into();
            state.trace_id = normalize_trace_id(trace_id);
            self.emit_locked(&mut state, Vec::new(), EventKind::TurnStarted { prompt: prompt.to_string() })
        };
        if let Some((session_id, event)) = observed {
            notify_observer(&session_id, &event);
        }
        Ok(())
    }

    /// Starts the turn when idle (`Ok(true)`), else holds the input (`Ok(false)`).
    fn begin_turn_or_queue(&self, content: &[ContentBlock], id: &str, span: &str, trace_id: Option<u64>) -> Result<bool> {
        let trace_id = normalize_trace_id(trace_id);
        let observed = {
            let mut state = self.lock();
            if let Some(error) = Self::unreachable(&state) {
                return Err(error);
            }
            if state.compacting && self.runtime_id() == "codex" {
                return Err(rejected("compacting", "manual compaction is running"));
            }
            if state.compacting || state.fold.turn_active() || !state.queue.is_empty() {
                state.queue.push_back(QueuedInput {
                    content: content.to_vec(),
                    id: id.into(),
                    span: span.into(),
                    trace_id,
                });
                return Ok(false);
            }
            state.span_id = span.into();
            state.input_id = id.into();
            state.trace_id = trace_id;
            self.emit_locked(&mut state, Vec::new(), EventKind::TurnStarted { prompt: render_text(content) })
        };
        if let Some((session_id, event)) = observed {
            notify_observer(&session_id, &event);
        }
        Ok(true)
    }

    fn next_queued(&self) -> Option<Vec<ContentBlock>> {
        let (next, observed) = {
            let mut state = self.lock();
            if state.ended || state.compacting || state.fold.turn_active() {
                return None;
            }
            let input = state.queue.pop_front()?;
            state.span_id = input.span;
            state.input_id = input.id;
            state.trace_id = input.trace_id;
            let next = input.content;
            let observed = self.emit_locked(&mut state, Vec::new(), EventKind::TurnStarted { prompt: render_text(&next) });
            (next, observed)
        };
        if let Some((session_id, event)) = observed {
            notify_observer(&session_id, &event);
        }
        Some(next)
    }

    /// Ends the stream: an optional error, the open turn's end, `SessionEnded`.
    /// Idempotent; whoever notices the end first (dispose or process exit) wins.
    pub(crate) fn observe_exit(&self, status: Option<(i32, String)>) {
        if let Some(status) = status {
            self.lock().process_exit = Some(status);
        }
    }
    pub fn finish(&self, error: Option<String>) {
        let observed = {
            let mut state = self.lock();
            if state.ended {
                return;
            }
            let mut out: [Option<(String, Event)>; 3] = [None, None, None];
            let disposed = state.disposed;
            let clean = state.process_exit.as_ref().is_some_and(|(code, _)| *code == 0);
            if let Some(message) = error.filter(|_| !clean)
                && !disposed
            {
                state.exit_error = Some(message.clone());
                out[0] = self.emit_locked(&mut state, Vec::new(), EventKind::Error { message });
            }
            if state.fold.turn_active() {
                let reason = if disposed || clean { StopReason::Aborted } else { StopReason::Error };
                out[1] = self.emit_locked(
                    &mut state,
                    Vec::new(),
                    EventKind::TurnFinished {
                        reason,
                        usage: Usage::default(),
                    },
                );
            }
            state.queue.clear();
            out[2] = self.emit_locked(&mut state, Vec::new(), EventKind::SessionEnded);
            out
        };
        for (session_id, event) in observed.into_iter().flatten() {
            notify_observer(&session_id, &event);
        }
    }

    pub(crate) fn is_disposed(&self) -> bool {
        self.lock().disposed
    }
}

/// What an adapter supplies; `CoreSession` wraps it with the shared rules.
pub trait Driver: Send + Sync + 'static {
    fn read_subagent<'a>(&'a self, _thread_id: &'a str, _turn_id: Option<&'a str>) -> BoxFuture<'a, Result<crate::oar::SubagentSnapshot>> {
        Box::pin(async { Err(crate::oar::SubagentSnapshot::unsupported()) })
    }
    fn swarm_snapshot(&self) -> Option<crate::oar::SwarmSnapshot> {
        None
    }
    fn read_child_transcript(&self, _conversation_id: &str, _limit: usize) -> Vec<crate::oar::ChildTranscriptStep> {
        Vec::new()
    }
    fn session_title(&self) -> Option<String> {
        None
    }
    /// Refuses content the runtime cannot take, before the turn is recorded.
    fn check_content(&self, _content: &[ContentBlock]) -> Result<()> {
        Ok(())
    }
    fn start_turn(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>>;
    fn steer(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>>;
    fn abort(&self) -> BoxFuture<'_, Result<()>>;
    fn compact(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            Err(AgentError::Unsupported {
                option: "compact".into(),
                reason: "runtime has no manual compaction".into(),
            })
        })
    }
    fn stop_task<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async {
            Err(AgentError::Unsupported {
                option: "stop_task".into(),
                reason: "runtime cannot stop individual tasks".into(),
            })
        })
    }
    fn respond_permission<'a>(&'a self, request_id: &'a str, decision: &'a PermissionDecision) -> BoxFuture<'a, Result<()>>;
    fn respond_interaction<'a>(&'a self, _request_id: &'a str, _decision: &'a InteractionDecision) -> BoxFuture<'a, Result<()>> {
        Box::pin(async {
            Err(AgentError::Unsupported {
                option: "respond_interaction".into(),
                reason: "runtime has no interactive question channel".into(),
            })
        })
    }
    fn set_config<'a>(&'a self, _model: Option<&'a str>, _effort: Option<&'a str>, _permission_mode: Option<PermissionMode>) -> BoxFuture<'a, Result<()>> {
        Box::pin(async {
            Err(AgentError::Unsupported {
                option: "set_config".into(),
                reason: "runtime does not support live config updates".into(),
            })
        })
    }
    fn dispose(&self) -> BoxFuture<'_, ()>;
    /// Non-blocking signal to tear down driver resources on `Drop`.
    fn signal_dispose(&self) {}
}

pub struct CoreSession<D: Driver> {
    core: Arc<SessionCore>,
    driver: D,
    capabilities: Capabilities,
}

impl<D: Driver> CoreSession<D> {
    pub fn new(core: Arc<SessionCore>, driver: D, capabilities: Capabilities) -> Arc<Self> {
        let session = Arc::new(Self {
            core: core.clone(),
            driver,
            capabilities,
        });
        let weak: Weak<Self> = Arc::downgrade(&session);
        *core.after_turn.lock() = Some(Arc::new(move || {
            if let Some(session) = weak.upgrade() {
                session.drain_queue();
            }
        }));
        session
    }

    fn drain_queue(self: Arc<Self>) {
        if let Some(content) = self.core.next_queued() {
            crate::rt::current_or_global_handle().spawn(async move {
                let _ = self.run_turn(content).await;
            });
        }
    }

    /// The turn's start is already recorded; a failed hand-over ends it.
    async fn run_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        if let Err(error) = self.driver.start_turn(content).await {
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

impl<D: Driver> CoreSession<D> {
    async fn legacy_control(&self, action: crate::oar::ControlAction, content: Vec<ContentBlock>, opts: TurnOptions) -> Result<()> {
        let (_, error) = self.dispatch(action, content, "", "", "", opts).await?;
        match error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    async fn dispatch(
        &self,
        action: crate::oar::ControlAction,
        content: Vec<ContentBlock>,
        arg: &str,
        input_id: &str,
        span_id: &str,
        opts: TurnOptions,
    ) -> Result<(crate::oar::ControlOutcome, Option<AgentError>)> {
        use crate::oar::{ControlAction as A, ControlStatus as S};
        let trace_id = normalize_trace_id(opts.trace_id);
        let result = match action {
            A::Prompt => match self
                .check(&content)
                .and_then(|_| self.core.begin_span(&render_text(&content), input_id, span_id, trace_id))
            {
                Ok(()) => self.run_turn(content).await,
                Err(err) => Err(err),
            },
            A::Steer => self.steer_input(content).await,
            A::Queue if self.capabilities.queue => match self
                .check(&content)
                .and_then(|_| self.core.begin_turn_or_queue(&content, input_id, span_id, trace_id))
            {
                Ok(true) => self.run_turn(content).await,
                Ok(false) => Ok(()),
                Err(err) => Err(err),
            },
            A::Queue => Err(AgentError::Unsupported {
                option: "queue".into(),
                reason: "runtime does not hold input".into(),
            }),
            A::Abort => self.abort_input().await,
            A::Withdraw => {
                let mut state = self.core.lock();
                if let Some(e) = SessionCore::unreachable(&state) {
                    Err(e)
                } else if let Some(index) = state.queue.iter().position(|q| !arg.is_empty() && q.id == arg) {
                    state.queue.remove(index);
                    Ok(())
                } else {
                    Err(rejected("not_found", "input is not queued"))
                }
            }
            A::Compact if !matches!(self.runtime_id(), "claude" | "codex" | "qoder") => Err(AgentError::Unsupported {
                option: "compact".into(),
                reason: "no manual compaction".into(),
            }),
            A::Compact | A::StopTask => {
                let precheck = {
                    let mut state = self.core.lock();
                    if let Some(e) = SessionCore::unreachable(&state) {
                        Err(e)
                    } else if action == A::Compact && (state.fold.turn_active() || state.compacting) {
                        Err(rejected("busy", "cannot compact during a turn"))
                    } else if action == A::StopTask && arg.trim().is_empty() {
                        Err(rejected("invalid_task_id", "task identifier is empty"))
                    } else {
                        if action == A::Compact {
                            state.compacting = true;
                            state.manual_compaction = true;
                            state.span_id = format!("compact-{}", state.next_record_seq);
                            state.trace_id = trace_id;
                            self.core.compact_event(&mut state, true, "manual");
                        }
                        Ok(())
                    }
                };
                match precheck {
                    Err(e) => Err(e),
                    Ok(()) if action == A::Compact => {
                        let result = self.driver.compact().await;
                        if result.is_err() {
                            let mut state = self.core.lock();
                            state.compacting = false;
                            state.manual_compaction = false;
                            self.core.compact_event(&mut state, false, "failed");
                            state.span_id.clear();
                            state.trace_id = None;
                        }
                        result
                    }
                    Ok(()) => self.driver.stop_task(arg).await,
                }
            }
        };
        let (status, code, reason) = match &result {
            Ok(()) => (S::Accepted, "".into(), String::new()),
            Err(AgentError::Unsupported { reason, .. }) => (S::Unsupported, "unsupported".into(), reason.clone()),
            Err(e @ AgentError::Rejected(_)) => {
                let code = e.rejection_code().unwrap_or("rejected");
                (
                    if matches!(code, rejection::DISPOSED | rejection::RUNTIME_EXITED) {
                        S::NotRunning
                    } else {
                        S::Rejected
                    },
                    if matches!(code, rejection::DISPOSED | rejection::RUNTIME_EXITED) {
                        "not_running".into()
                    } else {
                        code.to_owned()
                    },
                    e.to_string(),
                )
            }
            Err(_) => return result.map(|_| unreachable!()),
        };
        let mut state = self.core.lock();
        let span = if !span_id.is_empty() { span_id.to_owned() } else { state.span_id.clone() };
        let outcome = crate::oar::ControlOutcome {
            action,
            status,
            code,
            reason,
            span_id: span.clone(),
            input_id: if action == A::Withdraw { arg.into() } else { input_id.into() },
        };
        let mut rec = crate::oar::voyage::Record::new(crate::oar::voyage::Kind::Control, self.id(), now_ms());
        rec.span_id = span;
        rec.trace_id = trace_id.or(state.trace_id);
        let mut control = serde_json::json!({"action":action,"outcome":outcome});
        if !outcome.input_id.is_empty() {
            control["inputId"] = serde_json::json!(outcome.input_id);
        }
        if action == A::StopTask {
            control["taskId"] = serde_json::json!(arg);
        }
        rec.frame_type = control["action"].as_str().unwrap_or_default().into();
        rec.control = Some(control);
        self.core.record_locked(&mut state, rec);
        Ok((outcome, result.err()))
    }

    async fn steer_input(&self, content: Vec<ContentBlock>) -> Result<()> {
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
        self.driver.steer(content).await
    }

    async fn abort_input(&self) -> Result<()> {
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
        self.driver.abort().await
    }
}

impl<D: Driver> Session for CoreSession<D> {
    fn id(&self) -> String {
        self.core.session_id()
    }

    fn control<'a>(
        &'a self,
        action: crate::oar::ControlAction,
        arg: &'a str,
        input_id: &'a str,
        span_id: &'a str,
    ) -> BoxFuture<'a, Result<crate::oar::ControlOutcome>> {
        self.control_with(action, arg, input_id, span_id, TurnOptions::default())
    }
    fn control_with<'a>(
        &'a self,
        action: crate::oar::ControlAction,
        arg: &'a str,
        input_id: &'a str,
        span_id: &'a str,
        opts: TurnOptions,
    ) -> BoxFuture<'a, Result<crate::oar::ControlOutcome>> {
        Box::pin(async move {
            self.dispatch(action, vec![ContentBlock::Text(arg.into())], arg, input_id, span_id, opts)
                .await
                .map(|(outcome, _)| outcome)
        })
    }
    fn wait(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let mut rx = self.events();
            while let Some(e) = rx.recv().await {
                if matches!(e.kind, EventKind::SessionEnded) {
                    break;
                }
            }
            match self.core.lock().exit_error.clone() {
                Some(e) => Err(AgentError::Io(e)),
                None => Ok(()),
            }
        })
    }
    fn usage(&self) -> Option<crate::oar::TokenTotals> {
        self.core.lock().last_usage
    }

    fn records(&self) -> Vec<crate::oar::voyage::Record> {
        let state = self.core.lock();
        if let Some(path) = state.record_path.clone() {
            let base = state.record_base;
            let count = state.next_record_seq;
            drop(state);
            return crate::oar::record::read_session_records(&path, base, count);
        }
        state.records.iter().cloned().collect()
    }

    fn subscribe_records(&self, after: Option<u64>) -> mpsc::UnboundedReceiver<crate::oar::voyage::Record> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut state = self.core.lock();
        let needs_history = after.is_none_or(|seq| seq + 1 < state.next_record_seq);
        if needs_history {
            if let Some(path) = state.record_path.as_deref() {
                for rec in crate::oar::record::read_session_records(path, state.record_base, state.next_record_seq) {
                    if after.is_none_or(|seq| rec.seq > seq) {
                        let _ = tx.send(rec);
                    }
                }
            } else {
                for rec in state.records.iter().filter(|r| after.is_none_or(|seq| r.seq > seq)) {
                    let _ = tx.send(rec.clone());
                }
            }
        }
        if !state.ended {
            state.record_subscribers.push(tx);
        }
        rx
    }
    fn resume_id(&self) -> Option<String> {
        if self.core.lock().unresumable {
            return None;
        }
        let id = self.id();
        if (self.runtime_id() == "qwen" && id == "qwen-pending") || (self.runtime_id() == "qoder" && id == "qoder-pending") {
            return None;
        }
        Some(id)
    }

    fn read_subagent<'a>(&'a self, thread_id: &'a str, turn_id: Option<&'a str>) -> BoxFuture<'a, Result<crate::oar::SubagentSnapshot>> {
        self.driver.read_subagent(thread_id, turn_id)
    }
    fn swarm_snapshot(&self) -> Option<crate::oar::SwarmSnapshot> {
        self.driver.swarm_snapshot()
    }
    fn read_child_transcript(&self, conversation_id: &str, limit: usize) -> Vec<crate::oar::ChildTranscriptStep> {
        self.driver.read_child_transcript(conversation_id, limit)
    }
    fn session_title(&self) -> Option<String> {
        self.driver.session_title()
    }
    fn runtime_id(&self) -> &str {
        self.core.runtime_id()
    }

    fn status(&self) -> SessionStatus {
        self.core.status()
    }

    fn events(&self) -> mpsc::UnboundedReceiver<Event> {
        self.core.subscribe(false)
    }

    fn events_with_history(&self) -> mpsc::UnboundedReceiver<Event> {
        self.core.subscribe(true)
    }

    fn prompt(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        self.prompt_with(content, TurnOptions::default())
    }
    fn prompt_with(&self, content: Vec<ContentBlock>, opts: TurnOptions) -> BoxFuture<'_, Result<()>> {
        Box::pin(self.legacy_control(crate::oar::ControlAction::Prompt, content, opts))
    }
    fn steer(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        Box::pin(self.legacy_control(crate::oar::ControlAction::Steer, content, TurnOptions::default()))
    }
    fn queue(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        self.queue_with(content, TurnOptions::default())
    }
    fn queue_with(&self, content: Vec<ContentBlock>, opts: TurnOptions) -> BoxFuture<'_, Result<()>> {
        Box::pin(self.legacy_control(crate::oar::ControlAction::Queue, content, opts))
    }
    fn abort(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(self.legacy_control(crate::oar::ControlAction::Abort, vec![], TurnOptions::default()))
    }
    fn respond_permission<'a>(&'a self, request_id: &'a str, decision: PermissionDecision) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
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
            self.driver.respond_permission(request_id, &decision).await?;
            self.core.emit(
                path,
                EventKind::PermissionResolved {
                    request_id: request_id.to_string(),
                    decision,
                },
            );
            Ok(())
        })
    }

    fn respond_interaction<'a>(&'a self, request_id: &'a str, decision: InteractionDecision) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let path = {
                let state = self.core.lock();
                if let Some(error) = SessionCore::unreachable(&state) {
                    return Err(error);
                }
                state.fold.interaction_path(request_id)
            };
            let Some(path) = path else {
                return Err(rejected(
                    rejection::UNKNOWN_REQUEST,
                    format!("no interaction request `{request_id}` is waiting"),
                ));
            };
            self.driver.respond_interaction(request_id, &decision).await?;
            self.core.emit(
                path,
                EventKind::InteractionResolved {
                    request_id: request_id.to_string(),
                    decision,
                },
            );
            Ok(())
        })
    }

    fn set_config<'a>(&'a self, model: Option<&'a str>, effort: Option<&'a str>, permission_mode: Option<PermissionMode>) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            {
                let state = self.core.lock();
                if let Some(error) = SessionCore::unreachable(&state) {
                    return Err(error);
                }
            }
            self.driver.set_config(model, effort, permission_mode).await
        })
    }

    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            {
                let mut state = self.core.lock();
                if state.disposed {
                    return;
                }
                state.disposed = true;
            }
            self.driver.dispose().await;
            self.core.finish(None);
        })
    }

    fn signal_dispose(&self) {
        {
            let mut state = self.core.lock();
            if state.disposed {
                return;
            }
            state.disposed = true;
        }
        self.driver.signal_dispose();
        self.core.finish(None);
    }
}

impl<D: Driver> Drop for CoreSession<D> {
    fn drop(&mut self) {
        if !self.core.is_disposed() {
            self.driver.signal_dispose();
            self.core.finish(None);
        }
    }
}

/// The prompt as one string, for `TurnStarted` and for text-only runtimes.
pub fn render_text(content: &[ContentBlock]) -> String {
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
pub fn check_cwd(cwd: &std::path::Path) -> Result<()> {
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
