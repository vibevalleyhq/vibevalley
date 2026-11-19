//! Each session's work log (`journal.ts`): the steps it took as
//! `SessionEvent`s, kept at `<home>/events/<id>.json`, pushed live every
//! 300 ms and written out every 1.5 s while they change.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use vibevalley_core::rules::cut;
use vibevalley_i18n::t;
use vibevalley_protocol::{Outcome, SessionEvent, SessionEventType, ToolAction};

use crate::modules::ledger::Step;
use crate::{Hub, lock, now};

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
    }
}

enum Draft {
    None,
    Text {
        event: SessionEvent,
        who: String,
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
    pushing: Option<Instant>,
    saving: Option<Instant>,
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
            pushing: None,
            saving: None,
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
            })
            .collect()
    }

    /// Whether the file is due to be written (1.5 s after a change).
    pub fn save_due(&mut self, all: bool) -> bool {
        match self.saving {
            Some(at) if all || at.elapsed() >= SAVE_AFTER => {
                self.saving = None;
                true
            }
            _ => false,
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
            self.steps.drain(..drop);
        }
        self.changed(n);
    }

    fn make_draft(&mut self, e: SessionEvent, from: From, call: Option<String>) -> i64 {
        self.seal();
        let event = self.stamp(e, from);
        let n = event.seq;
        self.draft = match call {
            Some(_) => Draft::Tool { event },
            None => Draft::Text { event, who: from.join("/") },
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
        if let Draft::Text { event, who: w } = &mut self.draft
            && event.r#type == kind
            && *w == who
        {
            event.text = cut(&(event.text.clone() + text), TEXT_MAX);
            event.revision += 1;
            let n = event.seq;
            self.changed(n);
            return;
        }
        self.make_draft(blank(kind, cut(text, TEXT_MAX)), from, None);
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
            None => self.make_draft(step, from, Some(key.clone())),
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
    }

    /// Seals what is being written.
    pub fn close(&mut self) {
        self.seal();
    }

    pub fn body(&self) -> String {
        serde_json::to_string(&self.steps).unwrap_or_else(|_| "[]".into())
    }
}

/// What a tool call is shown as: the command, file, pattern or address it
/// names, near the session's folder; else the tool's name.
pub(super) fn tool_detail(input: &serde_json::Value, cwd: &str) -> String {
    let pick = ["command", "cmd", "file_path", "path", "notebook_path", "pattern", "url", "query"];
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
    use vibevalley_oar::ToolAction as Oar;
    match vibevalley_oar::tool_action(name, input) {
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

/// Every session's log (`makeTrajectories`): the ones being written in
/// memory, the others on disk.
pub struct Trajectories {
    dir: PathBuf,
    open: Mutex<HashMap<String, Journal>>,
    hub: Weak<Hub>,
    stop: Mutex<Option<flume::Sender<()>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

fn write_out(file: &Path, body: String) {
    let tmp = file.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

fn read_journal(file: &Path) -> Option<Vec<SessionEvent>> {
    let body = std::fs::read_to_string(file).ok()?;
    match serde_json::from_str(&body) {
        Ok(events) => Some(events),
        Err(_) => {
            let _ = std::fs::remove_file(file);
            None
        }
    }
}

impl Trajectories {
    /// The logs under `<home>/events`; a thread pushes and writes them out
    /// until the hub is gone.
    pub fn open(home: &Path, hub: &Arc<Hub>) -> Arc<Trajectories> {
        let dir = home.join("events");
        let _ = std::fs::create_dir_all(&dir);
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        let t = Arc::new(Trajectories {
            dir,
            open: Mutex::default(),
            hub: Arc::downgrade(hub),
            stop: Mutex::new(Some(stop_tx)),
            thread: Mutex::new(None),
        });
        let weak = Arc::downgrade(&t);
        if let Ok(handle) = std::thread::Builder::new().name("vibevalley-journal".into()).spawn(move || {
            loop {
                let stopped = !matches!(stop_rx.recv_timeout(Duration::from_millis(100)), Err(flume::RecvTimeoutError::Timeout));
                let Some(t) = weak.upgrade() else { return };
                if stopped || t.hub.strong_count() == 0 {
                    t.finish_all();
                    return;
                }
                t.flush(false);
            }
        }) {
            *lock(&t.thread) = Some(handle);
        }
        t
    }

    fn file_of(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Pushes what is due and writes out the files that are.
    pub fn flush(&self, all: bool) {
        let mut pushes = Vec::new();
        let mut writes = Vec::new();
        {
            let mut open = lock(&self.open);
            for (id, j) in open.iter_mut() {
                for e in j.due(all) {
                    pushes.push((id.clone(), e));
                }
                if j.save_due(all) {
                    writes.push((self.file_of(id), j.body()));
                }
            }
        }
        if let Some(hub) = self.hub.upgrade() {
            for (id, e) in pushes {
                hub.session_event(&id, e);
            }
        }
        for (file, body) in writes {
            write_out(&file, body);
        }
    }

    fn with<R>(&self, id: &str, f: impl FnOnce(&mut Journal) -> R) -> Option<R> {
        if !known_id(id) {
            return None;
        }
        let mut open = lock(&self.open);
        let j = open
            .entry(id.to_string())
            .or_insert_with(|| Journal::new(read_journal(&self.file_of(id)).unwrap_or_default()));
        Some(f(j))
    }

    /// A session's log, oldest first; a run's only when `run` is given.
    pub fn events(&self, id: &str, run: Option<&str>) -> Option<Vec<SessionEvent>> {
        if !known_id(id) {
            return None;
        }
        let all = match lock(&self.open).get(id) {
            Some(j) => Some(j.events()),
            None => read_journal(&self.file_of(id)),
        }?;
        Some(match run.filter(|r| !r.is_empty()) {
            Some(r) => all.into_iter().filter(|e| e.run.as_deref() == Some(r)).collect(),
            None => all,
        })
    }

    /// Writes a session's log out and lets it go; it stays on disk.
    pub fn finish(&self, id: &str) {
        let Some(mut j) = lock(&self.open).remove(id) else { return };
        j.close();
        let pushes = j.due(true);
        if let Some(hub) = self.hub.upgrade() {
            for e in pushes {
                hub.session_event(id, e);
            }
        }
        write_out(&self.file_of(id), j.body());
    }

    fn finish_all(&self) {
        let ids: Vec<String> = lock(&self.open).keys().cloned().collect();
        for id in ids {
            self.finish(&id);
        }
    }

    /// Seals and writes out every log still open.
    pub fn close(&self) {
        let _ = lock(&self.stop).take();
        if let Some(handle) = lock(&self.thread).take()
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
        self.finish_all();
    }

    /// The open log of `id` (taken up from disk), for writing to it.
    pub fn with_log<R>(&self, id: &str, f: impl FnOnce(&mut Journal) -> R) -> Option<R> {
        self.with(id, f)
    }

    /// Deletes a session's log.
    pub fn forget(&self, id: &str) {
        if !known_id(id) {
            return;
        }
        lock(&self.open).remove(id);
        let _ = std::fs::remove_file(self.file_of(id));
    }

    /// Takes one of the board's steps for session `id` working in `cwd`.
    pub fn step(&self, id: &str, cwd: &str, step: Step) {
        self.with(id, |j| match step {
            Step::RunStarted { run } => j.run_started(&run),
            Step::RunEnded { run, outcome } => {
                j.run_ended(&run, outcome);
                j.close();
            }
            Step::Asked { text } => j.asked(&text, &[]),
            Step::Agent(event) => {
                let from = event.agent_path.as_slice();
                use vibevalley_oar::EventKind as K;
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
                    K::Question { text } => j.said(&text, from),
                    K::Error { message } => j.note(SessionEventType::RunError, &message, from),
                    _ => {}
                }
            }
        });
    }
}
