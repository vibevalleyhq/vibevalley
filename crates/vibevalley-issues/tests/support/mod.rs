//! A scripted runtime whose turns can touch the worktree (a test-only hook
//! run when a turn starts), temporary repositories and a board on them.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vibevalley_issues::{Board, BoardConfig};
use vibevalley_oar::scripted::{Script, ScriptedRuntime, Step};
use vibevalley_oar::{
    Capabilities, ContentBlock, Event, Installation, ModelInfo, PermissionDecision, Registry, Runtime, Session, SessionOptions, SessionStatus,
};
use vibevalley_protocol::{Issue, IssueStageKind as StageKind};
use vibevalley_store::Store;

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
    fn list_models(&self) -> vibevalley_oar::Result<Vec<ModelInfo>> {
        Ok(vec![])
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_oar::Result<Arc<dyn Session>> {
        // Where `Board::report` keeps this session's report: beside its record, by the same name.
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
    fn prompt(&self, content: Vec<ContentBlock>) -> vibevalley_oar::Result<()> {
        let prompt = prompt_text(&content);
        self.prompts.lock().unwrap().push(prompt.clone());
        let index = self.turns.fetch_add(1, Ordering::SeqCst);
        (self.hook)(&Turn {
            cwd: self.cwd.clone(),
            report: self.report.clone(),
            prompt,
            index,
        });
        self.inner.prompt(content)
    }
    fn steer(&self, content: Vec<ContentBlock>) -> vibevalley_oar::Result<()> {
        self.prompts.lock().unwrap().push(format!("(steer) {}", prompt_text(&content)));
        self.inner.steer(content)
    }
    fn queue(&self, content: Vec<ContentBlock>) -> vibevalley_oar::Result<()> {
        self.inner.queue(content)
    }
    fn abort(&self) -> vibevalley_oar::Result<()> {
        self.inner.abort()
    }
    fn respond_permission(&self, request_id: &str, decision: PermissionDecision) -> vibevalley_oar::Result<()> {
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
    pub board: Board,
    pub store: Arc<Store>,
    pub registry: Arc<Registry>,
}

pub fn config(dir: &Path) -> BoardConfig {
    let mut config = BoardConfig::under(&dir.join("vibevalley"));
    config.quiet_after = Duration::from_secs(600);
    config
}

pub fn world(runtimes: Vec<Arc<dyn Runtime>>, tune: impl FnOnce(&mut BoardConfig)) -> World {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::new();
    for r in runtimes {
        registry.register(r);
    }
    let registry = Arc::new(registry);
    let store = Arc::new(Store::open(&dir.path().join("state.db")).unwrap());
    let mut config = config(dir.path());
    tune(&mut config);
    let board = Board::open(store.clone(), registry.clone(), config).unwrap();
    World { dir, board, store, registry }
}

/// Waits until `pred` holds of the issue, or panics after 15 s.
pub fn wait_issue(board: &Board, id: &str, what: &str, pred: impl Fn(&Issue) -> bool) -> Issue {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(issue) = board.issue(id)
            && pred(&issue)
        {
            return issue;
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for {what}: {:#?}", board.issue(id));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn wait_stage(board: &Board, id: &str, state: StageKind) -> Issue {
    wait_issue(board, id, &format!("{state:?}"), |t| t.stage.state == state)
}
