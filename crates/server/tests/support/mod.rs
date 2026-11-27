//! A scripted runtime whose turns can touch the worktree (a test-only hook
//! run when a turn starts), temporary repositories and a board on them.

#![allow(dead_code)]
#![allow(clippy::disallowed_types, reason = "synchronous TurnGate test barrier")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vibevalley_core::empty_space_state;
use vibevalley_core::projection::{BoardInput, InboxInput, SessionInput, derive_issues, project_board, project_inbox, project_sessions};
use vibevalley_protocol::{Issue, IssueStageKind as StageKind, Session as ProtocolSession, SliceBundle, SliceKind};
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};
use vibevalley_runtime::oar::{
    Capabilities, ContentBlock, Event, Installation, ModelInfo, PermissionDecision, Registry, Runtime, Session, SessionOptions, SessionStatus,
};
use vibevalley_server::channel::Chat;
use vibevalley_server::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use vibevalley_server::db::DatabaseConfig;
use vibevalley_server::issue::{Board, BoardConfig, BoardError};
use vibevalley_server::runtime::{Changes, Runtime as ServerRuntime, RuntimeDriver};
use vibevalley_server::service::Service;

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
    fn installation(&self) -> vibevalley_runtime::BoxFuture<'_, Installation> {
        Box::pin(async {
            Installation::Available {
                version: None,
                path: PathBuf::from("(test)"),
            }
        })
    }
    fn list_models(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn Session>>> {
        Box::pin(async move {
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
            let inner = ScriptedRuntime::new(&self.id, script.clone()).open(opts).await?;
            Ok(Arc::new(HookSession {
                inner,
                cwd,
                report,
                turns: AtomicUsize::new(0),
                hook: self.hook.clone(),
                prompts: self.prompts.clone(),
            }) as Arc<dyn Session>)
        })
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
    fn subscribe_records(&self, after: Option<u64>) -> tokio::sync::mpsc::Receiver<vibevalley_runtime::oar::voyage::Record> {
        self.inner.subscribe_records(after)
    }
    fn control<'a>(
        &'a self,
        action: vibevalley_runtime::oar::ControlAction,
        arg: &'a str,
        input_id: &'a str,
        span_id: &'a str,
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<vibevalley_runtime::oar::ControlOutcome>> {
        self.inner.control(action, arg, input_id, span_id)
    }
    fn control_with<'a>(
        &'a self,
        action: vibevalley_runtime::oar::ControlAction,
        arg: &'a str,
        input_id: &'a str,
        span_id: &'a str,
        opts: vibevalley_runtime::oar::TurnOptions,
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<vibevalley_runtime::oar::ControlOutcome>> {
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
    fn events(&self) -> tokio::sync::mpsc::Receiver<Event> {
        self.inner.events()
    }
    fn prompt(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.prompt_with(content, vibevalley_runtime::oar::TurnOptions::default())
    }
    fn prompt_with(
        &self,
        content: Vec<ContentBlock>,
        opts: vibevalley_runtime::oar::TurnOptions,
    ) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        Box::pin(async move {
            let prompt = prompt_text(&content);
            self.prompts.lock().unwrap().push(prompt.clone());
            let index = self.turns.fetch_add(1, Ordering::SeqCst);
            (self.hook)(&Turn {
                cwd: self.cwd.clone(),
                report: self.report.clone(),
                prompt,
                index,
            });
            self.inner.prompt_with(content, opts).await
        })
    }
    fn steer(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.prompts.lock().unwrap().push(format!("(steer) {}", prompt_text(&content)));
        self.inner.steer(content)
    }
    fn queue(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.inner.queue(content)
    }
    fn queue_with(
        &self,
        content: Vec<ContentBlock>,
        opts: vibevalley_runtime::oar::TurnOptions,
    ) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.inner.queue_with(content, opts)
    }
    fn abort(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.inner.abort()
    }
    fn respond_permission<'a>(
        &'a self,
        request_id: &'a str,
        decision: PermissionDecision,
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<()>> {
        self.inner.respond_permission(request_id, decision)
    }
    fn dispose(&self) -> vibevalley_runtime::BoxFuture<'_, ()> {
        self.inner.dispose()
    }
    fn signal_dispose(&self) {
        self.inner.signal_dispose();
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
    permits: Arc<(std::sync::Mutex<usize>, std::sync::Condvar)>,
}

impl Default for TurnGate {
    fn default() -> Self {
        Self::new()
    }
}

impl TurnGate {
    pub fn new() -> Self {
        Self {
            permits: Arc::new((std::sync::Mutex::new(0), std::sync::Condvar::new())),
        }
    }

    /// Unblocks one gated turn.
    pub fn release(&self) {
        let (lock, cv) = &*self.permits;
        *lock.lock().unwrap() += 1;
        cv.notify_one();
    }

    /// Unblocks `count` gated turns.
    pub fn release_n(&self, count: usize) {
        let (lock, cv) = &*self.permits;
        *lock.lock().unwrap() += count;
        cv.notify_all();
    }

    /// A `Script` whose turns block on the gate (15 s safety ceiling) before emitting `text`.
    pub fn script(&self, text: impl Into<String>) -> Script {
        let permits = self.permits.clone();
        let text = text.into();
        Script::computed(Arc::new(move |_| {
            let (lock, cv) = &*permits;
            let (mut guard, _) = cv
                .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(15), |count| *count == 0)
                .unwrap();
            if *guard > 0 {
                *guard -= 1;
            }
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

pub struct World {
    pub dir: tempfile::TempDir,
    pub ctx: Arc<Context>,
    pub runtime: Arc<ServerRuntime>,
    pub board: Arc<Board>,
    pub store: PathBuf,
    pub registry: Arc<Registry>,
}

pub fn config(dir: &Path) -> BoardConfig {
    let mut config = BoardConfig::under(&dir.join("vibevalley"));
    config.quiet_after = Duration::from_secs(600);
    config
}

pub fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    vibevalley_runtime::rt::block_on(fut)
}

pub fn open_board(store: &Path, registry: Arc<Registry>, config: BoardConfig) -> Result<(Arc<Board>, Arc<Context>), BoardError> {
    block_on(async move {
        let service = Service::open_config(&DatabaseConfig::Sqlite { path: store.to_path_buf() }).await?;
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service)),
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let (runtime, opened) = ServerRuntime::open_async(ctx.clone(), Arc::new(RuntimeDriver { registry, model: None }), config).await?;
        let board = Board::open_async(ctx.clone(), runtime, opened, None, None).await?;
        Ok((board, ctx))
    })
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
    let (board, ctx) = open_board(&store, registry.clone(), config).unwrap();
    let runtime = board.runtime().clone();
    World {
        dir,
        ctx,
        runtime,
        board,
        store,
        registry,
    }
}

pub fn board_issue(board: &Board, id: &str) -> Option<Issue> {
    block_on(board.issue_async(id)).ok().flatten()
}

pub fn board_issues(board: &Board) -> Vec<Issue> {
    block_on(board.issues_async()).unwrap_or_default()
}

pub fn board_session(board: &Board, id: &str) -> Option<ProtocolSession> {
    block_on(board.session_async(id))
}

pub fn board_sessions(board: &Board) -> Vec<ProtocolSession> {
    block_on(board.sessions_async()).unwrap_or_default()
}

pub fn board_changes(board: &Board, id: &str) -> vibevalley_server::issue::Result<Changes> {
    block_on(board.changes_async(id))
}

pub fn board_bundle(board: &Board) -> SliceBundle {
    block_on(async {
        let raw_issues = board.raw_issues_async().await.unwrap_or_default();
        let sessions = board.sessions_async().await.unwrap_or_default();
        let issues = derive_issues(&raw_issues, &sessions);
        let live = board.ctx().live.to_core_snapshot(false);
        let empty = vibevalley_core::slice_bundle(&empty_space_state(), vec![], 0);
        let board_slice = project_board(
            &BoardInput {
                issues: issues.clone(),
                sessions: sessions.clone(),
                ..Default::default()
            },
            &live,
            0,
        );
        let sessions_slice = project_sessions(
            &SessionInput {
                sessions: sessions.clone(),
                issues,
                ..Default::default()
            },
            &live,
            0,
        );
        let (call, call_reason) = board.ctx().live.call_snapshot();
        let inbox = project_inbox(
            &InboxInput {
                issues: raw_issues,
                sessions,
                runtime_inbox_items: board.ctx().live.runtime_inbox_snapshot(),
                call,
                call_reason,
                ..Default::default()
            },
            &live,
            0,
        );
        SliceBundle {
            seq: board.seq(),
            board: board_slice,
            sessions: sessions_slice,
            collab: empty.collab,
            inbox,
            ops: empty.ops,
            farm: empty.farm,
        }
    })
}

/// Event-driven waiter waking on `ctx.feed` (`dirty` + `cycles`) and `ctx.live`. Returns `None` on timeout.
pub async fn try_wait_until_transition_async<T>(ctx: &Context, timeout: Duration, mut pred: impl FnMut() -> Option<T>) -> Option<T> {
    let mut dirty = ctx.feed.subscribe_dirty();
    let mut cycles = ctx.feed.subscribe_cycles();
    let mut live = ctx.live.subscribe_live();
    let _ = *dirty.borrow_and_update();
    let _ = *cycles.borrow_and_update();
    tokio::time::timeout(timeout, async {
        loop {
            if ctx.feed.has_unprojected_dirty() {
                ctx.feed.flush().await;
            }
            if let Some(val) = pred() {
                return Some(val);
            }
            tokio::select! {
                _ = dirty.changed() => {}
                _ = cycles.changed() => {}
                res = live.recv() => {
                    if matches!(res, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                        if ctx.feed.has_unprojected_dirty() {
                            ctx.feed.flush().await;
                        }
                        return pred();
                    }
                }
            }
        }
    })
    .await
    .ok()
    .flatten()
}

/// Async event-driven waiter waking on `ctx.feed` (`dirty` + `cycles`) and `ctx.live`.
pub async fn wait_until_transition_async<T>(ctx: &Context, timeout: Duration, what: &str, pred: impl FnMut() -> Option<T>) -> T {
    try_wait_until_transition_async(ctx, timeout, pred)
        .await
        .unwrap_or_else(|| panic!("timed out after {timeout:?} waiting for {what}"))
}

/// Sync event-driven waiter waking immediately on `ctx.feed` / `ctx.live`.
pub fn try_wait_until_transition<T>(ctx: &Context, timeout: Duration, mut pred: impl FnMut() -> Option<T>) -> Option<T> {
    let mut dirty = ctx.feed.subscribe_dirty();
    let mut cycles = ctx.feed.subscribe_cycles();
    let mut live = ctx.live.subscribe_live();
    let _ = *dirty.borrow_and_update();
    let _ = *cycles.borrow_and_update();
    let deadline = Instant::now() + timeout;
    loop {
        if ctx.feed.has_unprojected_dirty() {
            block_on(ctx.feed.flush());
        }
        if let Some(val) = pred() {
            return Some(val);
        }
        let remaining = deadline.checked_duration_since(Instant::now())?;
        let res = block_on(async {
            tokio::time::timeout(remaining, async {
                tokio::select! {
                    r = dirty.changed() => r.is_ok(),
                    r = cycles.changed() => r.is_ok(),
                    r = live.recv() => !matches!(r, Err(tokio::sync::broadcast::error::RecvError::Closed)),
                }
            })
            .await
        });
        match res {
            Ok(true) => {}
            Ok(false) | Err(_) => {
                if ctx.feed.has_unprojected_dirty() {
                    block_on(ctx.feed.flush());
                }
                return pred();
            }
        }
    }
}

/// Sync event-driven waiter waking immediately on `ctx.feed` / `ctx.live`.
pub fn wait_until_transition<T>(ctx: &Context, timeout: Duration, what: &str, pred: impl FnMut() -> Option<T>) -> T {
    try_wait_until_transition(ctx, timeout, pred).unwrap_or_else(|| panic!("timed out after {timeout:?} waiting for {what}"))
}

/// Async event-driven waiter subscribed to a single `SliceFeed`.
pub async fn wait_until_slice_async<T>(ctx: &Context, kind: SliceKind, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let mut sub = ctx.feed.subscribe(kind);
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
pub fn wait_until_slice<T>(ctx: &Context, kind: SliceKind, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let mut sub = ctx.feed.subscribe(kind);
    let deadline = Instant::now() + timeout;
    loop {
        let _ = sub.borrow_and_update(false);
        if let Some(val) = pred() {
            return val;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            panic!("timed out after {timeout:?} waiting for {what}");
        };
        let changed = block_on(async { tokio::time::timeout(remaining, sub.changed()).await });
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

/// Event-driven waiter waking on `ctx.feed` and `ctx.live`.
pub fn wait_until_live<T>(ctx: &Context, timeout: Duration, what: &str, pred: impl FnMut() -> Option<T>) -> T {
    wait_until_transition(ctx, timeout, what, pred)
}

/// Event-driven waiter subscribed to `chat.subscribe_events()`.
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
        let res = block_on(async { tokio::time::timeout(remaining, rx.recv()).await });
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

/// Hybrid waiter for async SQLite background subscribers (wakes immediately on `ctx.feed`
/// when provided and uses a short bounded wait fallback on the caller's thread).
pub fn wait_until_settled<T>(ctx: Option<&Context>, timeout: Duration, what: &str, mut pred: impl FnMut() -> Option<T>) -> T {
    let mut dirty = ctx.map(|c| c.feed.subscribe_dirty());
    let mut cycles = ctx.map(|c| c.feed.subscribe_cycles());
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(val) = pred() {
            return val;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            panic!("timed out after {timeout:?} waiting for {what}");
        };
        let step = remaining.min(Duration::from_millis(5));
        if let (Some(d), Some(c)) = (dirty.as_mut(), cycles.as_mut()) {
            let _ = block_on(async {
                tokio::time::timeout(step, async {
                    tokio::select! {
                        _ = d.changed() => {}
                        _ = c.changed() => {}
                    }
                })
                .await
            });
        } else {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let _ = rx.recv_timeout(step);
            drop(tx);
        }
    }
}

/// Waits until `pred` holds of the issue, or panics after 15 s.
pub fn wait_issue(board: &Board, id: &str, what: &str, pred: impl Fn(&Issue) -> bool) -> Issue {
    let timeout = Duration::from_secs(15);
    try_wait_until_transition(board.ctx(), timeout, || board_issue(board, id).filter(|issue| pred(issue)))
        .unwrap_or_else(|| panic!("timed out waiting for {what}: {:#?}", board_issue(board, id)))
}

pub fn wait_stage(board: &Board, id: &str, state: StageKind) -> Issue {
    wait_issue(board, id, &format!("{state:?}"), |t| t.stage.state == state)
}

/// Test-only synchronous convenience wrappers over the async-first [`Server`] trait.
pub trait ServerTestExt {
    fn call(&self, op: &str, payload: serde_json::Value) -> vibevalley_protocol::Envelope;
    fn call_with(&self, ctx: &vibevalley_server::gateway::api::CallerContext, op: &str, payload: serde_json::Value) -> vibevalley_protocol::Envelope;
    #[allow(clippy::result_large_err)]
    fn subscribe(&self, name: &str, payload: serde_json::Value)
    -> Result<(u64, tokio::sync::mpsc::Receiver<serde_json::Value>), vibevalley_protocol::Envelope>;
    #[allow(clippy::result_large_err)]
    fn subscribe_with(
        &self,
        ctx: &vibevalley_server::gateway::api::CallerContext,
        name: &str,
        payload: serde_json::Value,
    ) -> Result<(u64, tokio::sync::mpsc::Receiver<serde_json::Value>), vibevalley_protocol::Envelope>;
    fn slice_snapshot(&self, slice: SliceKind) -> serde_json::Value;
    fn watch_slice(
        &self,
        slice: SliceKind,
        after_seq: Option<i64>,
        stop: &tokio_util::sync::CancellationToken,
        receive: &mut dyn FnMut(i64, &serde_json::Value),
    );
}

impl<T: vibevalley_server::gateway::api::Server + ?Sized> ServerTestExt for Arc<T> {
    fn call(&self, op: &str, payload: serde_json::Value) -> vibevalley_protocol::Envelope {
        self.call_with(&vibevalley_server::gateway::api::CallerContext::local(), op, payload)
    }

    fn call_with(&self, ctx: &vibevalley_server::gateway::api::CallerContext, op: &str, payload: serde_json::Value) -> vibevalley_protocol::Envelope {
        vibevalley_runtime::rt::block_on(self.clone().call_with_async(ctx.clone(), op.to_owned(), payload))
    }

    fn subscribe(
        &self,
        name: &str,
        payload: serde_json::Value,
    ) -> Result<(u64, tokio::sync::mpsc::Receiver<serde_json::Value>), vibevalley_protocol::Envelope> {
        self.subscribe_with(&vibevalley_server::gateway::api::CallerContext::local(), name, payload)
    }

    fn subscribe_with(
        &self,
        ctx: &vibevalley_server::gateway::api::CallerContext,
        name: &str,
        payload: serde_json::Value,
    ) -> Result<(u64, tokio::sync::mpsc::Receiver<serde_json::Value>), vibevalley_protocol::Envelope> {
        vibevalley_runtime::rt::block_on(self.clone().subscribe_with_async(ctx.clone(), name.to_owned(), payload))
    }

    fn slice_snapshot(&self, slice: SliceKind) -> serde_json::Value {
        let json = vibevalley_runtime::rt::block_on(self.clone().slice_snapshot_json_async(slice));
        serde_json::from_str(&json).unwrap_or(serde_json::Value::Null)
    }

    fn watch_slice(
        &self,
        slice: SliceKind,
        after_seq: Option<i64>,
        stop: &tokio_util::sync::CancellationToken,
        receive: &mut dyn FnMut(i64, &serde_json::Value),
    ) {
        use tokio_stream::StreamExt as _;
        let server = self.clone();
        vibevalley_runtime::rt::block_on(async {
            let Some(sub) = server.clone().subscribe_slice_async(slice).await else {
                return;
            };
            let topic = sub.topic();
            let mut stream = sub.into_json_watch_stream(after_seq);
            loop {
                let next = tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    item = stream.next() => item,
                };
                let Some((seq, json_str)) = next else { break };
                if let Some(gate) = server.fault_gate() {
                    if gate.should_disconnect(topic) {
                        break;
                    }
                    let delay = gate.delay_ms(topic);
                    if delay > 0 {
                        tokio::select! {
                            biased;
                            _ = stop.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                        }
                    }
                }
                if stop.is_cancelled() {
                    break;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    receive(seq, &v);
                }
            }
        });
    }
}

/// Test-only synchronous convenience wrappers on [`vibevalley_server::Router`].
pub trait RouterTestExt {
    fn call_as(&self, caller: vibevalley_protocol::Caller, op: &str, payload: serde_json::Value) -> vibevalley_protocol::Envelope;
    fn invoke<O: vibevalley_protocol::Op>(
        &self,
        ctx: &vibevalley_server::gateway::api::CallerContext,
        input: O::Input,
    ) -> Result<O::Result, vibevalley_protocol::ApiError>
    where
        O::Result: serde::de::DeserializeOwned;
    fn invoke_as<O: vibevalley_protocol::Op>(&self, caller: vibevalley_protocol::Caller, input: O::Input) -> Result<O::Result, vibevalley_protocol::ApiError>
    where
        O::Result: serde::de::DeserializeOwned;
}

impl RouterTestExt for vibevalley_server::Router {
    fn call_as(&self, caller: vibevalley_protocol::Caller, op: &str, payload: serde_json::Value) -> vibevalley_protocol::Envelope {
        vibevalley_runtime::rt::block_on(self.call_as_async(caller, op, payload))
    }

    fn invoke<O: vibevalley_protocol::Op>(
        &self,
        ctx: &vibevalley_server::gateway::api::CallerContext,
        input: O::Input,
    ) -> Result<O::Result, vibevalley_protocol::ApiError>
    where
        O::Result: serde::de::DeserializeOwned,
    {
        vibevalley_runtime::rt::block_on(self.invoke_async::<O>(ctx, input))
    }

    fn invoke_as<O: vibevalley_protocol::Op>(&self, caller: vibevalley_protocol::Caller, input: O::Input) -> Result<O::Result, vibevalley_protocol::ApiError>
    where
        O::Result: serde::de::DeserializeOwned,
    {
        vibevalley_runtime::rt::block_on(self.invoke_as_async::<O>(caller, input))
    }
}
