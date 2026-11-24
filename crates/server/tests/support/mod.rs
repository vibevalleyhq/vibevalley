//! A scripted runtime whose turns can touch the worktree (a test-only hook
//! run when a turn starts), temporary repositories and a board on them.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use vibevalley_core::empty_space_state;
use vibevalley_protocol::{Issue, IssueStageKind as StageKind, SliceKind};
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};
use vibevalley_runtime::oar::{
    Capabilities, ContentBlock, Event, Installation, ModelInfo, PermissionDecision, Registry, Runtime, Session, SessionOptions, SessionStatus,
};
use vibevalley_server::Hub;
use vibevalley_server::collab::channel::Chat;
use vibevalley_server::work::issue::Board;
use vibevalley_server::work::ledger::{BoardConfig, BoardError};

/// Opens a separate connection for assertions or SQLite failure injection.
pub fn inspect_db(path: &Path) -> sqlx::SqliteConnection {
    use sqlx::ConnectOptions;
    vibevalley_runtime::rt::block_on(sqlx::sqlite::SqliteConnectOptions::new().filename(path).connect()).unwrap()
}

pub fn execute_sql(connection: &mut sqlx::SqliteConnection, sql: &'static str) {
    vibevalley_runtime::rt::block_on(sqlx::raw_sql(sql).execute(connection)).unwrap();
}

/// What a hook sees of a turn.
#[derive(Debug, Clone)]
pub struct Turn {
    pub cwd: PathBuf,
    pub report: PathBuf,
    pub prompt: String,
    /// Turns of this agent session so far, from 0.
    pub index: usize,
}

impl Turn {
    pub fn write(&self, name: &str, content: &str) {
        let path = self.cwd.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    pub fn commit(&self, name: &str, content: &str) {
        self.write(name, content);
        git(&self.cwd, &["add", "."]);
        git(&self.cwd, &["commit", "-q", "-m", &format!("write {name}")]);
    }

    pub fn report(&self, json: &str) {
        std::fs::write(&self.report, json).unwrap();
    }

    pub fn done(&self, summary: &str) {
        self.report(&format!(r#"{{"status":"done","summary":"{summary}"}}"#));
    }
}

pub type Hook = Arc<dyn Fn(&Turn) + Send + Sync>;

pub struct HookRuntime {
    id: String,
    script: Script,
    /// Scripts for later opens of the runtime (a reopened session).
    later: Vec<Script>,
    opened: AtomicUsize,
    hook: Hook,
    pub prompts: Arc<Mutex<Vec<String>>>,
}

impl HookRuntime {
    pub fn new(id: &str, script: Script, hook: impl Fn(&Turn) + Send + Sync + 'static) -> Arc<HookRuntime> {
        Self::with_later(id, script, vec![], hook)
    }

    pub fn with_later(id: &str, script: Script, later: Vec<Script>, hook: impl Fn(&Turn) + Send + Sync + 'static) -> Arc<HookRuntime> {
        Arc::new(HookRuntime {
            id: id.into(),
            script,
            later,
            opened: AtomicUsize::new(0),
            hook: Arc::new(hook),
            prompts: Arc::default(),
        })
    }
}

impl Runtime for HookRuntime {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        "Test"
    }
    fn capabilities(&self) -> Capabilities {
        ScriptedRuntime::new(&self.id, Script::new()).capabilities()
    }
    fn installation(&self) -> Installation {
        Installation::Available {
            version: None,
            path: PathBuf::from("(test)"),
        }
    }
    fn list_models(&self) -> vibevalley_runtime::oar::Result<Vec<ModelInfo>> {
        Ok(vec![])
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::oar::Result<Arc<dyn Session>> {
        // Where `Sessions::report` keeps this session's report: beside its record, by the same name.
        let record = opts.record_to.clone().expect("the board records every session");
        let report = record
            .parent()
            .and_then(|d| d.parent())
            .unwrap()
            .join("reports")
            .join(record.with_extension("json").file_name().unwrap());
        let cwd = opts.cwd.clone();
        let n = self.opened.fetch_add(1, Ordering::SeqCst);
        let script = if n == 0 {
            &self.script
        } else {
            self.later.get(n - 1).or(self.later.last()).unwrap_or(&self.script)
        };
        let inner = ScriptedRuntime::new(&self.id, script.clone()).open(opts)?;
        Ok(Arc::new(HookSession {
            inner,
            cwd,
            report,
            turns: AtomicUsize::new(0),
            hook: self.hook.clone(),
            prompts: self.prompts.clone(),
        }))
    }
}

struct HookSession {
    inner: Arc<dyn Session>,
    cwd: PathBuf,
    report: PathBuf,
    turns: AtomicUsize,
    hook: Hook,
    prompts: Arc<Mutex<Vec<String>>>,
}

fn prompt_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl Session for HookSession {
    fn records(&self) -> Vec<vibevalley_runtime::oar::voyage::Record> {
        self.inner.records()
    }
    fn subscribe_records(&self, after: Option<u64>) -> flume::Receiver<vibevalley_runtime::oar::voyage::Record> {
        self.inner.subscribe_records(after)
    }
    fn control(
        &self,
        action: vibevalley_runtime::oar::ControlAction,
        arg: &str,
        input_id: &str,
        span_id: &str,
    ) -> vibevalley_runtime::oar::Result<vibevalley_runtime::oar::ControlOutcome> {
        self.inner.control(action, arg, input_id, span_id)
    }
    fn control_with(
        &self,
        action: vibevalley_runtime::oar::ControlAction,
        arg: &str,
        input_id: &str,
        span_id: &str,
        opts: vibevalley_runtime::oar::TurnOptions,
    ) -> vibevalley_runtime::oar::Result<vibevalley_runtime::oar::ControlOutcome> {
        self.inner.control_with(action, arg, input_id, span_id, opts)
    }
    fn id(&self) -> String {
        self.inner.id()
    }
    fn runtime_id(&self) -> &str {
        self.inner.runtime_id()
    }
    fn status(&self) -> SessionStatus {
        self.inner.status()
    }
    fn events(&self) -> flume::Receiver<Event> {
        self.inner.events()
    }
    fn prompt(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
        self.prompt_with(content, vibevalley_runtime::oar::TurnOptions::default())
    }
    fn prompt_with(&self, content: Vec<ContentBlock>, opts: vibevalley_runtime::oar::TurnOptions) -> vibevalley_runtime::oar::Result<()> {
        let prompt = prompt_text(&content);
        self.prompts.lock().unwrap().push(prompt.clone());
        let index = self.turns.fetch_add(1, Ordering::SeqCst);
        (self.hook)(&Turn {
            cwd: self.cwd.clone(),
            report: self.report.clone(),
            prompt,
            index,
        });
        self.inner.prompt_with(content, opts)
    }
    fn steer(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
        self.prompts.lock().unwrap().push(format!("(steer) {}", prompt_text(&content)));
        self.inner.steer(content)
    }
    fn queue(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
        self.inner.queue(content)
    }
    fn queue_with(&self, content: Vec<ContentBlock>, opts: vibevalley_runtime::oar::TurnOptions) -> vibevalley_runtime::oar::Result<()> {
        self.inner.queue_with(content, opts)
    }
    fn abort(&self) -> vibevalley_runtime::oar::Result<()> {
        self.inner.abort()
    }
    fn respond_permission(&self, request_id: &str, decision: PermissionDecision) -> vibevalley_runtime::oar::Result<()> {
        self.inner.respond_permission(request_id, decision)
    }
    fn dispose(&self) {
        self.inner.dispose()
    }
}

/// One text step, then the turn completes.
pub fn quick() -> Script {
    Script::new().turn(vec![Step::text("Working on it.\n\nDone, committed.")])
}

/// The first turn waits `ms` (stoppable); later ones complete at once.
pub fn slow_first(ms: u64) -> Script {
    Script::new()
        .turn(vec![Step::sleep_ms(ms), Step::text("finished the slow turn")])
        .turn(vec![Step::text("done")])
}

/// Deterministic gate that holds each turn until released by the test.
#[derive(Clone)]
pub struct TurnGate {
    tx: flume::Sender<()>,
    rx: flume::Receiver<()>,
}

impl Default for TurnGate {
    fn default() -> Self {
        Self::new()
    }
}

impl TurnGate {
    pub fn new() -> Self {
        let (tx, rx) = flume::unbounded();
        Self { tx, rx }
    }

    /// Unblocks one gated turn.
    pub fn release(&self) {
        let _ = self.tx.send(());
    }

    /// Unblocks `count` gated turns.
    pub fn release_n(&self, count: usize) {
        for _ in 0..count {
            self.release();
        }
    }

    /// A `Script` whose turns block on the gate (15 s safety ceiling) before emitting `text`.
    pub fn script(&self, text: impl Into<String>) -> Script {
        let rx = self.rx.clone();
        let text = text.into();
        Script::computed(Arc::new(move |_| {
            let _ = rx.recv_timeout(Duration::from_secs(15));
            Ok(vec![Step::text(text.clone())])
        }))
    }
}

pub fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository on `main` with one commit.
pub fn repo(dir: &Path, name: &str) -> PathBuf {
    let root = dir.join(name);
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    std::fs::write(root.join("README.md"), "hello\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "first"]);
    root.canonicalize().unwrap()
}

static BOARD_HUBS: LazyLock<Mutex<HashMap<PathBuf, Weak<Hub>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn register_board_hub(data_dir: &Path, hub: &Arc<Hub>) {
    let mut map = BOARD_HUBS.lock().unwrap();
    map.retain(|_, weak| weak.strong_count() > 0);
    map.insert(data_dir.to_path_buf(), Arc::downgrade(hub));
}

fn hub_for_board(board: &Board) -> Option<Arc<Hub>> {
    BOARD_HUBS.lock().unwrap().get(&board.config().data_dir).and_then(Weak::upgrade)
}

pub struct World {
    pub dir: tempfile::TempDir,
    pub board: Board,
    pub hub: Arc<Hub>,
    pub store: PathBuf,
    pub registry: Arc<Registry>,
}

pub fn config(dir: &Path) -> BoardConfig {
    let mut config = BoardConfig::under(&dir.join("vibevalley"));
    config.quiet_after = Duration::from_secs(600);
    config
}

pub fn open_board(store: &Path, registry: Arc<Registry>, config: BoardConfig) -> Result<(Board, Arc<Hub>), BoardError> {
    let hub = Hub::new(empty_space_state());
    let data_dir = config.data_dir.clone();
    let board = Board::open_on(store, registry, config, hub.clone())?;
    register_board_hub(&data_dir, &hub);
    Ok((board, hub))
}

pub fn world(runtimes: Vec<Arc<dyn Runtime>>, tune: impl FnOnce(&mut BoardConfig)) -> World {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::new();
    for r in runtimes {
        registry.register(r);
    }
    let registry = Arc::new(registry);
    let store = dir.path().join("server.db");
    let mut config = config(dir.path());
    tune(&mut config);
    let (board, hub) = open_board(&store, registry.clone(), config).unwrap();
    World {
        dir,
        board,
        hub,
        store,
        registry,
    }
}

/// Event-driven waiter subscribed to `hub.subscribe_transitions`. Returns `None` on timeout.
pub async fn try_wait_until_transition_async<T>(hub: &Hub, timeout: Duration, mut pred: impl FnMut() -> Option<T>) -> Option<T> {
    let notify = Arc::new(Notify::new());
    let wake = notify.clone();
    let sub = hub.subscribe_transitions("test-wait-transition", move |_, _| {
        wake.notify_one();
    });
    let res = tokio::time::timeout(timeout, async {
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(val) = pred() {
                return val;
            }
            notified.await;
        }
    })
    .await
    .ok();
    sub.close_async().await;
    res
}

/// Async event-driven waiter waking immediately on every `hub.apply` transition.
pub async fn wait_until_transition_async<T>(hub: &Hub, timeout: Duration, what: &str, pred: impl FnMut() -> Option<T>) -> T {
    try_wait_until_transition_async(hub, timeout, pred)
        .await
        .unwrap_or_else(|| panic!("timed out after {timeout:?} waiting for {what}"))
}

/// Sync event-driven waiter waking immediately on every `hub.apply` transition.
/// Evaluates `pred` on the caller's thread so predicates may safely perform blocking I/O.
pub fn try_wait_until_transition<T>(hub: &Hub, timeout: Duration, mut pred: impl FnMut() -> Option<T>) -> Option<T> {
    let (tx, rx) = flume::bounded::<()>(1);
    let sub = hub.subscribe_transitions("test-wait-transition", move |_, _| {
        let _ = tx.try_send(());
    });
    let deadline = Instant::now() + timeout;
    let out = loop {
        while rx.try_recv().is_ok() {}
        if let Some(val) = pred() {
            break Some(val);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break None;
        };
        if rx.recv_timeout(remaining).is_err() {
            break pred();
        }
    };
    drop(sub);
    out
}

/// Sync event-driven waiter waking immediately on every `hub.apply` transition.
pub fn wait_until_transition<T>(hub: &Hub, timeout: Duration, what: &str, pred: impl FnMut() -> Option<T>) -> T {
    try_wait_until_transition(hub, timeout, pred).unwrap_or_else(|| panic!("timed out after {timeout:?} waiting for {what}"))
}

/// Async event-driven waiter subscribed to a single `SliceFeed`.
pub async fn wait_until_slice_async<T>(hub: &Hub, kind: SliceKind, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let mut sub = hub.subscribe_slice_feed(kind);
    tokio::time::timeout(timeout, async {
        loop {
            let _ = sub.borrow_and_update(false);
            if let Some(val) = pred() {
                return Some(val);
            }
            if !sub.changed().await {
                return pred();
            }
        }
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| panic!("timed out after {timeout:?} waiting for {what}"))
}

/// Sync event-driven waiter subscribed to a single `SliceFeed`.
/// Evaluates `pred` on the caller's thread so predicates may safely perform blocking I/O.
pub fn wait_until_slice<T>(hub: &Hub, kind: SliceKind, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let mut sub = hub.subscribe_slice_feed(kind);
    let deadline = Instant::now() + timeout;
    loop {
        let _ = sub.borrow_and_update(false);
        if let Some(val) = pred() {
            return val;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            panic!("timed out after {timeout:?} waiting for {what}");
        };
        let changed = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(remaining, sub.changed()).await });
        match changed {
            Ok(true) => {}
            Ok(false) | Err(_) => {
                if let Some(val) = pred() {
                    return val;
                }
                panic!("timed out after {timeout:?} waiting for {what}");
            }
        }
    }
}

/// Event-driven waiter waking on both `hub.subscribe_transitions` and `hub.subscribe_live`.
/// Evaluates `pred` on the caller's thread so predicates may safely perform blocking I/O.
pub fn wait_until_live<T>(hub: &Hub, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let (tx, rx) = flume::bounded::<()>(1);
    let sub = hub.subscribe_transitions("test-wait-live", move |_, _| {
        let _ = tx.try_send(());
    });
    let mut live = hub.subscribe_live();
    let deadline = Instant::now() + timeout;
    let mut live_open = true;
    let out = loop {
        while rx.try_recv().is_ok() {}
        if let Some(val) = pred() {
            break Some(val);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break None;
        };
        let wait_res = vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(remaining, async {
                if live_open {
                    tokio::select! {
                        _ = rx.recv_async() => true,
                        res = live.recv() => !matches!(res, Err(tokio::sync::broadcast::error::RecvError::Closed)),
                    }
                } else {
                    let _ = rx.recv_async().await;
                    false
                }
            })
            .await
        });
        match wait_res {
            Ok(still_open) => live_open = still_open,
            Err(_) => break pred(),
        }
    };
    drop(sub);
    out.unwrap_or_else(|| panic!("timed out after {timeout:?} waiting for {what}"))
}

/// Event-driven waiter subscribed to `chat.subscribe_events()`.
/// Evaluates `pred` on the caller's thread so predicates may safely perform blocking I/O.
pub fn wait_until_channel_event<T>(chat: &Chat, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let mut rx = chat.subscribe_events();
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(val) = pred() {
            return val;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            panic!("timed out after {timeout:?} waiting for {what}");
        };
        let res = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(remaining, rx.recv()).await });
        match res {
            Ok(Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) | Err(_) => {
                if let Some(val) = pred() {
                    return val;
                }
                panic!("timed out after {timeout:?} waiting for {what}");
            }
        }
    }
}

/// Hybrid waiter for async SQLite background subscribers (e.g. `Memories`, `Library`,
/// `session_mailbox`, durable approvals) that persist directly to SQLite without emitting
/// a follow-up Hub transition. Wakes immediately on Hub transitions when provided and
/// uses a bounded `flume::Receiver::recv_timeout` fallback on the caller's thread.
pub fn wait_until_settled<T>(hub: Option<&Hub>, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let (tx, rx) = flume::bounded::<()>(1);
    let sub = hub.map(|h| {
        let tx = tx.clone();
        h.subscribe_transitions("test-wait-settled", move |_, _| {
            let _ = tx.try_send(());
        })
    });
    let deadline = Instant::now() + timeout;
    let out = loop {
        while rx.try_recv().is_ok() {}
        if let Some(val) = pred() {
            break Some(val);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break None;
        };
        let step = remaining.min(Duration::from_millis(5));
        let _ = rx.recv_timeout(step);
    };
    drop(sub);
    drop(tx);
    out.unwrap_or_else(|| panic!("timed out after {timeout:?} waiting for {what}"))
}

/// Waits until `pred` holds of the issue, or panics after 15 s.
pub fn wait_issue(board: &Board, id: &str, what: &str, pred: impl Fn(&Issue) -> bool) -> Issue {
    let timeout = Duration::from_secs(15);
    if let Some(hub) = hub_for_board(board) {
        return try_wait_until_transition(&hub, timeout, || board.issue(id).filter(|issue| pred(issue)))
            .unwrap_or_else(|| panic!("timed out waiting for {what}: {:#?}", board.issue(id)));
    }
    wait_until_settled(None, timeout, what, || board.issue(id).filter(|issue| pred(issue)))
}

pub fn wait_stage(board: &Board, id: &str, state: StageKind) -> Issue {
    wait_issue(board, id, &format!("{state:?}"), |t| t.stage.state == state)
}
