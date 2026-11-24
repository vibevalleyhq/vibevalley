//! Each session's work log (`journal.ts`): the steps it took as
//! `SessionEvent`s, pushed live every 300 ms and written out to SQLite
//! (`session_event`) every 1.5 s while they change.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio::task::JoinHandle as TaskHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use vibevalley_core::rules::cut;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    EventTokens, Outcome, SessionEvent, SessionEventType, SessionInteractionOption, SessionInteractionRequest, SessionInteractionResolution,
    SessionPermissionRequest, ToolAction,
};

use crate::modules::work::ledger::Step;
use crate::{Hub, now};

const KEEP_EVENTS: usize = 240;
const TEXT_MAX: usize = 6000;
pub const ASKED_MAX: usize = 2000;
const INPUT_MAX: usize = 4000;
const OUTPUT_HEAD: usize = 2000;
const OUTPUT_TAIL: usize = 4000;
const PUSH_AFTER: Duration = Duration::from_millis(300);
const SAVE_AFTER: Duration = Duration::from_millis(1500);

fn clip_output(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n <= OUTPUT_HEAD + OUTPUT_TAIL + 40 {
        return text.to_string();
    }
    let head: String = chars[..OUTPUT_HEAD].iter().collect();
    let tail: String = chars[n - OUTPUT_TAIL..].iter().collect();
    format!(
        "{head}\n{}\n{tail}",
        t("server.session.log.clipped", &[("n", (n - OUTPUT_HEAD - OUTPUT_TAIL).into())])
    )
}

fn blank(kind: SessionEventType, text: String) -> SessionEvent {
    SessionEvent {
        seq: 0,
        revision: 0,
        time: 0,
        r#type: kind,
        run: None,
        call: None,
        under: None,
        thread_id: None,
        text,
        action: None,
        action_text: None,
        tool: None,
        input: None,
        output: None,
        ok: None,
        tokens: None,
        connection: None,
        permission: None,
        interaction: None,
        interaction_resolution: None,
    }
}

fn append_capped(dst: &mut String, units: &mut usize, truncated: &mut bool, delta: &str, max: usize) -> bool {
    if *truncated || delta.is_empty() {
        return false;
    }
    if delta.is_ascii() && *units + delta.len() <= max {
        dst.push_str(delta);
        *units += delta.len();
        return true;
    }
    let before = dst.len();
    for ch in delta.chars() {
        let len = ch.len_utf16();
        if *units + len > max {
            dst.push('…');
            *truncated = true;
            break;
        }
        dst.push(ch);
        *units += len;
    }
    dst.len() != before
}

enum Draft {
    None,
    Text {
        event: SessionEvent,
        who: String,
        units: usize,
        truncated: bool,
    },
    /// A call whose input is not known yet.
    Tool {
        event: SessionEvent,
    },
}

type From<'a> = &'a [String];

fn call_key(from: From, call: &str) -> String {
    format!("{}|{call}", from.join("/"))
}

/// One session's log (`makeJournal`).
pub struct Journal {
    steps: Vec<SessionEvent>,
    next: i64,
    calls: HashMap<String, i64>,
    started: HashMap<String, i64>,
    draft: Draft,
    dirty: Vec<i64>,
    dirty_store: Vec<i64>,
    evicted_dirty: HashMap<i64, SessionEvent>,
    pushing: Option<Instant>,
    saving: Option<Instant>,
    urgent: bool,
    run: Option<String>,
    keep: usize,
}

impl Journal {
    pub fn new(initial: Vec<SessionEvent>) -> Journal {
        let next = initial.last().map(|e| e.seq + 1).unwrap_or(0);
        Journal {
            steps: initial,
            next,
            calls: HashMap::new(),
            started: HashMap::new(),
            draft: Draft::None,
            dirty: vec![],
            dirty_store: vec![],
            evicted_dirty: HashMap::new(),
            pushing: None,
            saving: None,
            urgent: false,
            run: None,
            keep: KEEP_EVENTS,
        }
    }

    fn current_draft(&self) -> Option<&SessionEvent> {
        match &self.draft {
            Draft::None => None,
            Draft::Text { event, .. } | Draft::Tool { event, .. } => Some(event),
        }
    }

    /// The log, oldest first, with what is being written last.
    pub fn events(&self) -> Vec<SessionEvent> {
        let mut out = self.steps.clone();
        out.extend(self.current_draft().cloned());
        out
    }

    fn changed(&mut self, n: i64) {
        if !self.dirty.contains(&n) {
            self.dirty.push(n);
        }
        if !self.dirty_store.contains(&n) {
            self.dirty_store.push(n);
        }
        self.pushing.get_or_insert_with(Instant::now);
        self.saving.get_or_insert_with(Instant::now);
    }

    /// The steps changed since the last push, once their 300 ms are up (or
    /// now with `all`).
    pub fn due(&mut self, all: bool) -> Vec<SessionEvent> {
        match self.pushing {
            Some(at) if all || at.elapsed() >= PUSH_AFTER => {}
            _ => return vec![],
        }
        self.pushing = None;
        let dirty = std::mem::take(&mut self.dirty);
        let draft = self.current_draft().cloned();
        dirty
            .into_iter()
            .filter_map(|n| {
                self.steps
                    .iter()
                    .rev()
                    .find(|s| s.seq == n)
                    .cloned()
                    .or_else(|| draft.clone().filter(|d| d.seq == n))
                    .or_else(|| self.evicted_dirty.get(&n).cloned())
            })
            .collect()
    }

    /// Collects events modified since the last SQLite flush (respecting `SAVE_AFTER` when `only_if_due` is set).
    pub fn take_dirty_for_save(&mut self, only_if_due: bool) -> Vec<SessionEvent> {
        if only_if_due {
            match self.saving {
                Some(at) if at.elapsed() >= SAVE_AFTER => {}
                _ => return vec![],
            }
        }
        self.saving = None;
        let dirty = std::mem::take(&mut self.dirty_store);
        if dirty.is_empty() {
            return vec![];
        }
        let draft = self.current_draft().cloned();
        dirty
            .into_iter()
            .filter_map(|n| {
                self.steps
                    .iter()
                    .rev()
                    .find(|s| s.seq == n)
                    .cloned()
                    .or_else(|| draft.clone().filter(|d| d.seq == n))
                    .or_else(|| self.evicted_dirty.get(&n).cloned())
            })
            .collect()
    }

    fn next_deadline(&self) -> Option<Instant> {
        match (self.pushing, self.saving) {
            (Some(p), Some(s)) => Some((p + PUSH_AFTER).min(s + SAVE_AFTER)),
            (Some(p), None) => Some(p + PUSH_AFTER),
            (None, Some(s)) => Some(s + SAVE_AFTER),
            (None, None) => None,
        }
    }

    fn parent_of(&self, from: From) -> Option<i64> {
        let (call, rest) = from.split_last()?;
        Some(self.started.get(&call_key(rest, call)).copied().unwrap_or(-1))
    }

    fn stamp(&mut self, mut step: SessionEvent, from: From) -> SessionEvent {
        step.seq = self.next;
        self.next += 1;
        step.revision = 0;
        step.time = now();
        step.under = self.parent_of(from);
        step.thread_id = from.last().cloned();
        step.run = self.run.clone();
        step
    }

    fn seal(&mut self) {
        if let Draft::Text { event, .. } | Draft::Tool { event, .. } = std::mem::replace(&mut self.draft, Draft::None) {
            self.append(event);
        }
    }

    fn add(&mut self, step: SessionEvent, from: From) -> i64 {
        self.seal();
        let s = self.stamp(step, from);
        let n = s.seq;
        self.append(s);
        n
    }

    fn append(&mut self, step: SessionEvent) {
        let n = step.seq;
        self.steps.push(step);
        if self.steps.len() > self.keep {
            let drop = self.steps.len() - self.keep;
            for ev in self.steps.drain(..drop) {
                if self.dirty_store.contains(&ev.seq) {
                    self.evicted_dirty.insert(ev.seq, ev);
                }
            }
        }
        self.changed(n);
    }

    fn make_draft(&mut self, e: SessionEvent, from: From, call: Option<String>, units: usize, truncated: bool) -> i64 {
        self.seal();
        let event = self.stamp(e, from);
        let n = event.seq;
        self.draft = match call {
            Some(_) => Draft::Tool { event },
            None => Draft::Text {
                event,
                who: from.join("/"),
                units,
                truncated,
            },
        };
        self.changed(n);
        n
    }

    pub fn run_started(&mut self, id: &str) {
        self.run = Some(id.to_string());
        self.add(blank(SessionEventType::RunStart, String::new()), &[]);
    }

    pub fn run_ended(&mut self, id: &str, outcome: Outcome) {
        if self.run.as_deref() != Some(id) {
            return;
        }
        let text = serde_json::to_value(outcome)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        self.add(blank(SessionEventType::RunEnd, text), &[]);
        self.run = None;
    }

    pub fn asked(&mut self, text: &str, from: From) {
        self.add(blank(SessionEventType::UserMessage, cut(text.trim(), ASKED_MAX)), from);
    }

    fn run_on(&mut self, kind: SessionEventType, text: &str, from: From) {
        if text.is_empty() {
            return;
        }
        let who = from.join("/");
        if let Draft::Text {
            event,
            who: w,
            units,
            truncated,
        } = &mut self.draft
            && event.r#type == kind
            && *w == who
        {
            if append_capped(&mut event.text, units, truncated, text, TEXT_MAX) {
                event.revision += 1;
                let n = event.seq;
                self.changed(n);
            }
            return;
        }
        let mut buf = String::with_capacity(text.len().min(TEXT_MAX));
        let mut units = 0;
        let mut truncated = false;
        append_capped(&mut buf, &mut units, &mut truncated, text, TEXT_MAX);
        self.make_draft(blank(kind, buf), from, None, units, truncated);
    }

    pub fn said(&mut self, text: &str, from: From) {
        self.run_on(SessionEventType::AssistantMessage, text, from);
    }

    pub fn thought(&mut self, text: &str, from: From) {
        self.run_on(SessionEventType::AssistantThinking, text, from);
    }

    pub fn tool_started(&mut self, call: &str, text: String, action: ToolAction, tool: &str, input: Option<String>, from: From) {
        let mut step = blank(SessionEventType::ToolCall, text);
        step.action_text = Some(t(&format!("shared.action.{}", action.as_str()), &[]));
        step.action = Some(action);
        step.tool = Some(tool.to_string());
        let key = call_key(from, call);
        let n = match input {
            Some(input) => {
                step.input = Some(cut(&input, INPUT_MAX));
                self.add(step, from)
            }
            None => self.make_draft(step, from, Some(key.clone()), 0, false),
        };
        self.calls.insert(key.clone(), n);
        self.started.insert(key, n);
    }

    pub fn tool_ended(&mut self, call: &str, output: &str, ok: bool, from: From) {
        let key = call_key(from, call);
        let Some(n) = self.calls.remove(&key) else { return };
        let mut step = blank(SessionEventType::ToolResult, String::new());
        step.call = Some(n);
        step.ok = Some(ok);
        if !output.trim().is_empty() {
            step.output = Some(clip_output(output.trim_end()));
        }
        self.add(step, from);
    }

    pub fn note(&mut self, kind: SessionEventType, text: &str, from: From) {
        self.add(blank(kind, text.to_string()), from);
        if matches!(kind, SessionEventType::RunError) {
            self.urgent = true;
        }
    }

    pub fn permission_requested(&mut self, request: SessionPermissionRequest, from: From) {
        let mut step = blank(SessionEventType::PermissionRequest, request.summary.clone());
        step.tool = Some(request.tool.clone());
        step.input = request.input.clone();
        step.permission = Some(request);
        self.add(step, from);
        self.urgent = true;
    }

    pub fn permission_resolved(&mut self, request_id: &str, decision: &vibevalley_runtime::oar::PermissionDecision, from: From) {
        let (text, allowed) = match decision {
            vibevalley_runtime::oar::PermissionDecision::AllowOnce => ("allowOnce".to_string(), true),
            vibevalley_runtime::oar::PermissionDecision::AllowAlways => ("allowAlways".to_string(), true),
            vibevalley_runtime::oar::PermissionDecision::Deny { message } => {
                (message.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or("deny").to_string(), false)
            }
        };
        let mut step = blank(SessionEventType::PermissionResolved, text);
        step.ok = Some(allowed);
        step.permission = Some(SessionPermissionRequest {
            request_id: request_id.to_string(),
            tool: String::new(),
            summary: String::new(),
            input: None,
        });
        self.add(step, from);
        self.urgent = true;
    }

    pub fn interaction_requested(&mut self, request: SessionInteractionRequest, from: From) {
        let mut step = blank(SessionEventType::InteractionRequest, request.question.clone());
        step.interaction = Some(request);
        self.add(step, from);
        self.urgent = true;
    }

    pub fn interaction_resolved(&mut self, resolution: SessionInteractionResolution, from: From) {
        let text = resolution.choice.clone().unwrap_or_else(|| {
            if resolution.accepted {
                "accepted".to_string()
            } else {
                "cancelled".to_string()
            }
        });
        let mut step = blank(SessionEventType::InteractionResolved, text);
        step.ok = Some(resolution.accepted);
        step.interaction_resolution = Some(resolution);
        self.add(step, from);
        self.urgent = true;
    }

    pub fn usage(&mut self, tokens: EventTokens, from: From) {
        let mut step = blank(SessionEventType::LlmUsage, String::new());
        step.tokens = Some(tokens);
        self.add(step, from);
        self.urgent = true;
    }

    fn take_urgent(&mut self) -> bool {
        std::mem::take(&mut self.urgent)
    }

    /// Seals what is being written.
    pub fn close(&mut self) {
        self.seal();
    }

    pub fn body(&self) -> String {
        serde_json::to_string(&self.steps).unwrap_or_else(|_| "[]".into())
    }
}

pub(super) fn event_tokens_of(usage: &vibevalley_runtime::oar::Usage) -> Option<EventTokens> {
    if usage.input_tokens.is_none()
        && usage.output_tokens.is_none()
        && usage.cache_read_tokens.is_none()
        && usage.cache_write_tokens.is_none()
        && usage.reasoning_tokens.is_none()
        && usage.context_used_tokens.is_none()
        && usage.context_window_tokens.is_none()
    {
        return None;
    }
    let to_i64 = |v: Option<u64>| v.and_then(|n| i64::try_from(n).ok());
    Some(EventTokens {
        input: to_i64(usage.input_tokens).unwrap_or(0),
        cache_read: to_i64(usage.cache_read_tokens).unwrap_or(0),
        output: to_i64(usage.output_tokens).unwrap_or(0),
        cache_write: to_i64(usage.cache_write_tokens),
        reasoning: to_i64(usage.reasoning_tokens),
        context_used: to_i64(usage.context_used_tokens),
        context_window: to_i64(usage.context_window_tokens),
    })
}

/// What a tool call is shown as: the command, file, pattern or address it
/// names, near the session's folder; else the tool's name.
pub(super) fn tool_detail(input: &serde_json::Value, cwd: &str) -> String {
    let pick = [
        "command",
        "cmd",
        "file_path",
        "filePath",
        "TargetFile",
        "targetFile",
        "AbsolutePath",
        "absolutePath",
        "path",
        "notebook_path",
        "pattern",
        "url",
        "query",
    ];
    let found = pick.iter().find_map(|k| match &input[*k] {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        serde_json::Value::Array(a) if !a.is_empty() => Some(a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" ")),
        _ => None,
    });
    let Some(detail) = found else { return String::new() };
    if cwd.is_empty() {
        return detail;
    }
    let prefix = format!("{}/", cwd.trim_end_matches('/'));
    let detail = detail.strip_prefix(&format!("cd {cwd} && ")).map(String::from).unwrap_or(detail);
    detail.replace(&prefix, "")
}

pub(super) fn tool_action(name: &str, input: &serde_json::Value) -> ToolAction {
    use vibevalley_runtime::oar::ToolAction as Oar;
    match vibevalley_runtime::oar::tool_action(name, input) {
        Oar::RunCommand => ToolAction::RunCommand,
        Oar::ReadFile => ToolAction::ReadFile,
        Oar::EditFile => ToolAction::EditFile,
        Oar::Search => ToolAction::Search,
        Oar::Web => ToolAction::Web,
        Oar::Mcp => ToolAction::Mcp,
        Oar::Wait => ToolAction::Wait,
        Oar::Other => ToolAction::Other,
    }
}

/// Nothing that leads out of the folder.
fn known_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Every session's log (`Trajectories`): hot drafts in memory, full durable
/// history in SQLite `session_event` with cursor pagination.
pub struct Trajectories {
    db: Arc<crate::base::ServerDb>,
    open: Mutex<HashMap<String, Journal>>,
    hub: Weak<Hub>,
    wake: Arc<Notify>,
    worker: Mutex<Option<(CancellationToken, TaskHandle<()>)>>,
}

impl Trajectories {
    /// Opens SQLite `session_event` on the shared `ServerDb` and starts the event-driven pusher/flusher task.
    pub fn open(db: Arc<crate::base::ServerDb>, hub: &Arc<Hub>) -> Arc<Trajectories> {
        let wake = Arc::new(Notify::new());
        let t = Arc::new(Trajectories {
            db,
            open: Mutex::default(),
            hub: Arc::downgrade(hub),
            wake: wake.clone(),
            worker: Mutex::new(None),
        });
        let weak = Arc::downgrade(&t);
        let cancel = hub.child_token();
        let task_cancel = cancel.clone();
        let handle = hub.spawn_task(async move {
            loop {
                if task_cancel.is_cancelled() {
                    if let Some(t) = weak.upgrade() {
                        let _ = tokio::task::spawn_blocking(move || t.finish_all()).await;
                    }
                    return;
                }
                let deadline = {
                    let Some(t) = weak.upgrade() else { return };
                    if t.hub.strong_count() == 0 {
                        let _ = tokio::task::spawn_blocking(move || t.finish_all()).await;
                        return;
                    }
                    t.next_deadline()
                };
                let stop = match deadline {
                    None => tokio::select! {
                        biased;
                        _ = task_cancel.cancelled() => true,
                        _ = wake.notified() => false,
                    },
                    Some(at) => {
                        if at <= Instant::now() {
                            false
                        } else {
                            tokio::select! {
                                biased;
                                _ = task_cancel.cancelled() => true,
                                _ = wake.notified() => false,
                                _ = tokio::time::sleep_until(at) => false,
                            }
                        }
                    }
                };
                let Some(t) = weak.upgrade() else { return };
                if stop || t.hub.strong_count() == 0 {
                    let _ = tokio::task::spawn_blocking(move || t.finish_all()).await;
                    return;
                }
                let _ = tokio::task::spawn_blocking(move || t.flush(false)).await;
            }
        });
        *t.worker.lock() = Some((cancel, handle));
        t
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.open.lock().values().filter_map(Journal::next_deadline).min()
    }

    fn notify_worker(&self) {
        self.wake.notify_one();
    }

    fn load_tail(&self, id: &str) -> Vec<SessionEvent> {
        crate::modules::work::block_on(super::db::list_events_tail(self.db.read_conn(), id, "", KEEP_EVENTS as i64)).unwrap_or_default()
    }

    fn persist_dirty(&self, writes: Vec<(String, Vec<SessionEvent>)>) {
        if writes.is_empty() {
            return;
        }
        if let Err(e) = crate::modules::work::block_on(async {
            use sea_orm::{DatabaseBackend, SqliteTransactionMode, TransactionOptions, TransactionTrait as _};
            let w = self.db.write_conn();
            let opts = TransactionOptions {
                sqlite_transaction_mode: (w.get_database_backend() == DatabaseBackend::Sqlite).then_some(SqliteTransactionMode::Immediate),
                ..Default::default()
            };
            let tx = w.begin_with_options(opts).await?;
            for (id, events) in writes {
                super::db::upsert_events(&tx, &id, &events).await?;
            }
            tx.commit().await
        }) {
            eprintln!("vibevalley: persisting session events: {e}");
        }
    }

    fn flush_session(&self, id: &str) {
        let dirty = {
            let mut open = self.open.lock();
            open.get_mut(id).map(|j| j.take_dirty_for_save(false)).unwrap_or_default()
        };
        if !dirty.is_empty() {
            self.persist_dirty(vec![(id.to_string(), dirty)]);
        }
    }

    /// Pushes what is due and writes out changed events to SQLite.
    pub fn flush(&self, all: bool) {
        let mut pushes = Vec::new();
        let mut writes = Vec::new();
        {
            let mut open = self.open.lock();
            for (id, j) in open.iter_mut() {
                for e in j.due(all) {
                    pushes.push((id.clone(), e));
                }
                let dirty = j.take_dirty_for_save(!all);
                if !dirty.is_empty() {
                    writes.push((id.clone(), dirty));
                }
            }
        }
        if let Some(hub) = self.hub.upgrade() {
            for (id, e) in pushes {
                hub.session_event(&id, e);
            }
        }
        self.persist_dirty(writes);
    }

    fn with<R>(&self, id: &str, f: impl FnOnce(&mut Journal) -> R) -> Option<R> {
        if !known_id(id) {
            return None;
        }
        let existing_tail = if self.open.lock().contains_key(id) { None } else { Some(self.load_tail(id)) };
        let (out, dirty) = {
            let mut open = self.open.lock();
            let j = open.entry(id.to_string()).or_insert_with(|| Journal::new(existing_tail.unwrap_or_default()));
            let out = f(j);
            (out, j.next_deadline().is_some())
        };
        if dirty {
            self.notify_worker();
        }
        Some(out)
    }

    /// A session's log, oldest first; a run's only when `run` is given.
    pub fn events(&self, id: &str, run: Option<&str>) -> Option<Vec<SessionEvent>> {
        if !known_id(id) {
            return None;
        }
        self.flush_session(id);
        let is_open = self.open.lock().contains_key(id);
        let run_id = run.filter(|r| !r.is_empty()).unwrap_or("");
        let (has_any, events) = crate::modules::work::block_on(async {
            let r = self.db.read_conn();
            let max_seq = super::db::max_event_seq(r, id).await?;
            if max_seq < 0 && !is_open {
                return Ok::<_, sea_orm::DbErr>((false, vec![]));
            }
            let rows = super::db::list_events_tail(r, id, run_id, 1_000_000).await?;
            Ok((true, rows))
        })
        .ok()?;
        has_any.then_some(events)
    }

    /// Cursor-paged events for `session.event.list`.
    pub fn events_page(&self, input: &vibevalley_protocol::SessionEventListInput) -> Option<vibevalley_protocol::SessionEventPage> {
        if !known_id(&input.id) {
            return None;
        }
        self.flush_session(&input.id);
        let limit = input.limit.unwrap_or(200).clamp(1, 1000);
        let run_id = input.run.as_deref().unwrap_or("");
        let fetch = limit + 1;
        let mut events = crate::modules::work::block_on(async {
            let r = self.db.read_conn();
            if let Some(after) = input.after_seq {
                super::db::list_events_after(r, &input.id, run_id, after, fetch).await
            } else if let Some(before) = input.before_seq {
                super::db::list_events_before(r, &input.id, run_id, before, fetch).await
            } else {
                super::db::list_events_tail(r, &input.id, run_id, fetch).await
            }
        })
        .unwrap_or_default();
        let has_more = events.len() > limit as usize;
        if has_more {
            if input.after_seq.is_some() {
                events.truncate(limit as usize);
            } else {
                // Backward/tail queries returned ascending after `.reverse()`, so index 0 is the oldest extra item.
                events.drain(0..events.len() - limit as usize);
            }
        }
        let oldest_seq = events.first().map(|e| e.seq);
        let newest_seq = events.last().map(|e| e.seq);
        Some(vibevalley_protocol::SessionEventPage {
            events,
            has_more,
            oldest_seq,
            newest_seq,
        })
    }

    /// Seals and flushes a session's open log to SQLite.
    pub fn finish(&self, id: &str) {
        let Some(mut j) = self.open.lock().remove(id) else { return };
        j.close();
        let pushes = j.due(true);
        let dirty = j.take_dirty_for_save(false);
        if let Some(hub) = self.hub.upgrade() {
            for e in pushes {
                hub.session_event(id, e);
            }
        }
        if !dirty.is_empty() {
            self.persist_dirty(vec![(id.to_string(), dirty)]);
        }
    }

    fn finish_all(&self) {
        let ids: Vec<String> = self.open.lock().keys().cloned().collect();
        for id in ids {
            self.finish(&id);
        }
    }

    /// Asynchronously stops the flusher worker and seals/flushes every open
    /// log without calling `rt::block_on` on the worker handle.
    pub async fn close_async(&self) {
        let worker = self.worker.lock().take();
        if let Some((cancel, handle)) = worker {
            cancel.cancel();
            let _ = handle.await;
        }
        self.finish_all();
    }

    /// Seals and flushes every open log.
    pub fn close(&self) {
        if let Some((cancel, handle)) = self.worker.lock().take() {
            cancel.cancel();
            let _ = crate::modules::work::block_on(handle);
        }
        self.finish_all();
    }

    /// The open log of `id`, for writing to it.
    pub fn with_log<R>(&self, id: &str, f: impl FnOnce(&mut Journal) -> R) -> Option<R> {
        self.with(id, f)
    }

    /// Session ids that currently have an open in-memory journal.
    pub fn open_session_ids(&self) -> Vec<String> {
        self.open.lock().keys().cloned().collect()
    }

    /// Deletes a session's log.
    pub fn forget(&self, id: &str) {
        if !known_id(id) {
            return;
        }
        self.open.lock().remove(id);
        let _ = crate::modules::work::block_on(super::db::delete_events(self.db.write_conn(), id));
    }

    /// Takes one of the board's steps for session `id` working in `cwd`.
    pub fn step(&self, id: &str, cwd: &str, step: Step) {
        let urgent = self
            .with(id, |j| {
                match step {
                    Step::RunStarted { run } => j.run_started(&run),
                    Step::RunEnded { run, outcome } => {
                        j.run_ended(&run, outcome);
                        j.close();
                    }
                    Step::Asked { text } => j.asked(&text, &[]),
                    Step::Agent(event) => {
                        let from = event.agent_path.as_slice();
                        use vibevalley_runtime::oar::EventKind as K;
                        match event.kind {
                            K::TextDelta { text } => j.said(&text, from),
                            K::ThinkingDelta { text } => j.thought(&text, from),
                            K::ToolCallStarted { id: call, name, input } => {
                                let detail = tool_detail(&input, cwd);
                                let text = if detail.is_empty() { name.clone() } else { detail };
                                let action = tool_action(&name, &input);
                                let input = match &input {
                                    serde_json::Value::Null => None,
                                    serde_json::Value::String(s) => Some(s.clone()),
                                    v => Some(v.to_string()),
                                };
                                j.tool_started(&call, text, action, &name, input, from);
                            }
                            K::ToolCallFinished { id: call, ok, output } => j.tool_ended(&call, &output, ok, from),
                            K::PermissionRequested {
                                request_id,
                                tool,
                                input,
                                summary,
                            } => {
                                let req = SessionPermissionRequest {
                                    request_id,
                                    tool,
                                    summary,
                                    input: super::workspace::clip_json_input(&input),
                                };
                                j.permission_requested(req, from);
                            }
                            K::PermissionResolved { request_id, decision } => j.permission_resolved(&request_id, &decision, from),
                            K::InteractionRequested {
                                request_id,
                                question,
                                options,
                                allow_custom,
                            } => {
                                let req = SessionInteractionRequest {
                                    request_id,
                                    question,
                                    options: options
                                        .into_iter()
                                        .map(|o| SessionInteractionOption {
                                            id: o.id,
                                            label: o.label,
                                            description: o.description,
                                            warning: o.warning,
                                        })
                                        .collect(),
                                    allow_custom,
                                };
                                j.interaction_requested(req, from);
                            }
                            K::InteractionResolved { request_id, decision } => {
                                let resolution = match decision {
                                    vibevalley_runtime::oar::InteractionDecision::Select { option_id } => SessionInteractionResolution {
                                        request_id,
                                        accepted: true,
                                        choice: Some(option_id),
                                    },
                                    vibevalley_runtime::oar::InteractionDecision::Custom { text } => SessionInteractionResolution {
                                        request_id,
                                        accepted: true,
                                        choice: Some(text),
                                    },
                                    vibevalley_runtime::oar::InteractionDecision::Cancel => SessionInteractionResolution {
                                        request_id,
                                        accepted: false,
                                        choice: None,
                                    },
                                };
                                j.interaction_resolved(resolution, from);
                            }
                            K::TurnFinished { usage, .. } if from.is_empty() => {
                                if let Some(tokens) = event_tokens_of(&usage) {
                                    j.usage(tokens, from);
                                }
                            }
                            K::Question { text } => j.said(&text, from),
                            K::Error { message } => j.note(SessionEventType::RunError, &message, from),
                            _ => {}
                        }
                    }
                }
                if j.take_urgent() { j.due(true) } else { vec![] }
            })
            .unwrap_or_default();
        if !urgent.is_empty()
            && let Some(hub) = self.hub.upgrade()
        {
            for e in urgent {
                hub.session_event(id, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use vibevalley_protocol::LiveEvent;

    use super::*;
    use crate::Server;

    #[test]
    fn run_on_appends_streaming_text_in_place_and_caps_at_text_max() {
        let mut journal = Journal::new(vec![]);
        for _ in 0..(TEXT_MAX + 50) {
            journal.said("a", &[]);
        }
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].text.len(), TEXT_MAX + '…'.len_utf8());
        assert!(events[0].text.ends_with('…'));
        assert_eq!(events[0].revision, TEXT_MAX as i64);

        let mut cjk = Journal::new(vec![]);
        let chunk = "中".repeat(2500);
        cjk.said(&chunk, &[]);
        cjk.said(&chunk, &[]);
        cjk.said(&chunk, &[]);
        let ev = &cjk.events()[0];
        assert_eq!(ev.text.chars().count(), TEXT_MAX + 1);
        assert!(ev.text.ends_with('…'));
    }

    #[test]
    fn tool_detail_extracts_antigravity_and_camel_case_path_keys() {
        let cwd = "/repo/project";
        for key in ["TargetFile", "AbsolutePath", "targetFile", "absolutePath", "filePath"] {
            let input = json!({ key: "/repo/project/src/main.rs" });
            assert_eq!(tool_detail(&input, cwd), "src/main.rs", "failed for key {key}");
        }
        assert_eq!(tool_detail(&json!({ "TargetFile": "/other/file.rs" }), cwd), "/other/file.rs");
    }

    #[test]
    fn trajectories_event_driven_worker_wakes_flushes_and_closes_when_idle() {
        let home = tempfile::tempdir().unwrap();
        let db = crate::base::ServerDb::open(home.path()).unwrap();
        let hub = Hub::new(vibevalley_core::Core::default().state().clone());

        // Idle close returns immediately without polling delay.
        let idle = Trajectories::open(db.clone(), &hub);
        assert!(idle.next_deadline().is_none());
        let start = std::time::Instant::now();
        idle.close();
        assert!(start.elapsed() < Duration::from_secs(1));

        let tr = Trajectories::open(db.clone(), &hub);
        let live = hub.live();
        tr.step("w1", "", Step::Asked { text: "hello".into() });
        assert!(tr.next_deadline().is_some());

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut saw_push = false;
        while std::time::Instant::now() < deadline {
            match live.recv_timeout(Duration::from_millis(50)) {
                Ok(LiveEvent::Event(ev)) if ev.id == "w1" && ev.activity.text == "hello" => {
                    saw_push = true;
                    break;
                }
                Ok(_) => {}
                Err(flume::RecvTimeoutError::Timeout) => {}
                Err(flume::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(saw_push, "event-driven journal worker should flush pending push at PUSH_AFTER");
        tr.close();
        assert!(home.path().join("server.db").is_file());
        assert!(!home.path().join("events").exists());

        // Cursor pagination beyond the hot RAM window (KEEP_EVENTS = 240).
        let tr2 = Trajectories::open(db.clone(), &hub);
        for i in 1..=260 {
            tr2.step("w-long", "", Step::Asked { text: format!("step-{i}") });
        }
        let page1 = tr2
            .events_page(&vibevalley_protocol::SessionEventListInput {
                id: "w-long".into(),
                run: None,
                before_seq: None,
                after_seq: None,
                limit: Some(100),
            })
            .unwrap();
        assert_eq!(page1.events.len(), 100);
        assert!(page1.has_more);
        assert_eq!(page1.oldest_seq, Some(160));
        assert_eq!(page1.newest_seq, Some(259));

        let page2 = tr2
            .events_page(&vibevalley_protocol::SessionEventListInput {
                id: "w-long".into(),
                run: None,
                before_seq: page1.oldest_seq,
                after_seq: None,
                limit: Some(200),
            })
            .unwrap();
        assert_eq!(page2.events.len(), 160);
        assert!(!page2.has_more);
        assert_eq!(page2.oldest_seq, Some(0));
        assert_eq!(page2.newest_seq, Some(159));
        tr2.close();

        // Evicted burst (>240 steps closed directly without prior flush) still persists completely to SQLite.
        let tr3 = Trajectories::open(db.clone(), &hub);
        for i in 0..265 {
            tr3.step("w-burst", "", Step::Asked { text: format!("burst-{i}") });
        }
        tr3.close();
        let tr4 = Trajectories::open(db, &hub);
        let burst = tr4
            .events_page(&vibevalley_protocol::SessionEventListInput {
                id: "w-burst".into(),
                run: None,
                before_seq: None,
                after_seq: None,
                limit: Some(500),
            })
            .unwrap();
        assert_eq!(burst.events.len(), 265);
        assert_eq!(burst.oldest_seq, Some(0));
        assert_eq!(burst.newest_seq, Some(264));
        tr4.close();
    }

    #[tokio::test(start_paused = true)]
    async fn trajectories_push_and_close_async_follow_virtual_clock() {
        let wall_start = std::time::Instant::now();
        let home = tempfile::tempdir().unwrap();
        let db = crate::base::ServerDb::open(home.path()).unwrap();
        let hub = Hub::new(vibevalley_core::Core::default().state().clone());
        let mut live = hub.subscribe_live();
        let tr = Trajectories::open(db.clone(), &hub);

        tr.step("w-vclock", "", Step::Asked { text: "virtual".into() });
        assert!(tr.next_deadline().is_some());

        tokio::time::advance(PUSH_AFTER - Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(live.try_recv().is_err(), "push must wait for full PUSH_AFTER window");

        tokio::time::advance(Duration::from_millis(1)).await;
        let event = live.recv().await.expect("live event pushed at PUSH_AFTER");
        match event {
            LiveEvent::Event(ev) => {
                assert_eq!(ev.id, "w-vclock");
                assert_eq!(ev.activity.text, "virtual");
            }
            other => panic!("unexpected live event: {other:?}"),
        }

        tr.close_async().await;
        hub.close_async().await;
        db.close();
        assert!(
            wall_start.elapsed() < Duration::from_secs(1),
            "virtual-clock journal push & close_async must finish instantaneously, took {:?}",
            wall_start.elapsed()
        );
    }
}
