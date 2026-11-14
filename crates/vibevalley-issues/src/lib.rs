//! The issue board at work: it keeps the workflow state (`vibevalley-core`),
//! stores it (`vibevalley-store`), runs each issue's agent in the issue's own git
//! worktree (`vibevalley-oar`, `vibevalley-git`) and delivers the result.
//!
//! The rules are VibeValley's (see `vibevalley-core`); this crate is the part of
//! VibeValley's `issue` and `session` modules that does I/O, reduced to what
//! one person on one machine needs: no channels, no mailbox, no cron, no
//! pull requests. `docs/workflow.md` lists every difference.
//!
//! Every method blocks and may be called from any thread; the UI calls it
//! off its own thread and reads frames from `subscribe`. One process holds
//! a board at a time (a lock file next to its data); others read it with
//! [`Board::snapshot`].

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use vibevalley_core::{Applied, CheckoutChecks, Core, Move, Refusal, status_move};
use vibevalley_git::{MergeCheck, Repo};
use vibevalley_oar::{ContentBlock, EventKind, McpServer, PermissionDecision, PermissionMode, Registry, SessionOptions, StopReason};
use vibevalley_protocol::{
    Assignment, Conflict, Deliverable, Doing, Execution, Fact, Issue, IssueAnswer, IssueCanceled, IssueConstraints, IssueStageKind as StageKind, IssueStatus,
    Landing, LastRun, Millis, Outcome, Phase, PhaseWorking, Priority, Question, RunTriggerKind, Session, SessionAction, SpaceState, StateFrame as Frame,
    StuckReason,
};
use vibevalley_store::Store;

mod check;
mod drivers;
mod edits;
mod git;
mod report;
mod runs;
mod talk;

pub use drivers::{Drive, Drivers, HelperPlace, Persona, RuntimeDrivers};
pub use report::{ANSWER_ONLY, Report, ReportQuestion, ReportStatus};

#[derive(Debug, thiserror::Error)]
pub enum BoardError {
    #[error("no issue {0}")]
    NoIssue(String),
    #[error("move refused: {0:?}")]
    Refused(Refusal),
    #[error("this move needs words: say what to do this time")]
    WordsRequired,
    #[error("no room: {0}")]
    NoRoom(String),
    #[error("{0} is not inside a git repository")]
    NotARepo(PathBuf),
    #[error("another VibeValley process holds the board ({0})")]
    Busy(PathBuf),
    #[error("not delivered: {0}")]
    NotDelivered(Undelivered),
    #[error("agent: {0}")]
    Agent(#[from] vibevalley_oar::AgentError),
    #[error("git: {0}")]
    Git(#[from] vibevalley_git::GitError),
    #[error("store: {0}")]
    Store(#[from] vibevalley_store::StoreError),
    #[error("{0}")]
    Other(String),
    /// A refusal already worded for the endpoint (from a `Drivers`).
    #[error("{}", .0.message)]
    Api(vibevalley_protocol::ApiError),
}

/// Why completing did not deliver. The issue says it too (its conflict, or
/// the round the check sent it back for).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum Undelivered {
    /// Merging into `base` would conflict; the issue stays in review with
    /// its conflict set.
    Conflict { base: String, files: Vec<String> },
    /// The project check failed; `sent_back` when its session got the
    /// output to fix it.
    CheckFailed { output: String, sent_back: bool },
}

impl std::fmt::Display for Undelivered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Undelivered::Conflict { base, files } => {
                write!(f, "merging into {base} would conflict in {}", files.join(", "))
            }
            Undelivered::CheckFailed { output, sent_back } => {
                let then = if *sent_back { "; sent back to the agent" } else { "" };
                write!(f, "the project check failed{then}:\n{output}")
            }
        }
    }
}

pub type Result<T> = std::result::Result<T, BoardError>;

#[derive(Debug, Clone)]
pub struct BoardConfig {
    /// Sessions working at once in the whole workspace.
    pub space_limit: usize,
    /// Sessions working at once per repository (0: no limit of its own).
    pub per_repo: usize,
    /// Where issue worktrees are created: `<dir>/<repo>.<number>`.
    pub worktrees_dir: PathBuf,
    /// Where agent records, reports and the lock go.
    pub data_dir: PathBuf,
    /// What agents may do without asking. The workflow runs unattended, so
    /// the default does not ask (as in VibeValley).
    pub permission: PermissionMode,
    pub model: Option<String>,
    /// A working session with no event for this long is quiet.
    pub quiet_after: Duration,
    /// Where repos live by name (VibeValley's `<work root>/repos`). When
    /// set, an issue's `repo` under it is kept as its name, and a bare name
    /// is looked for there; otherwise `repo` is a path.
    pub repos_dir: Option<PathBuf>,
}

impl BoardConfig {
    pub fn under(dir: &Path) -> BoardConfig {
        BoardConfig {
            space_limit: 6,
            per_repo: 3,
            worktrees_dir: dir.join("worktrees"),
            data_dir: dir.join("issues"),
            permission: PermissionMode::Bypass,
            model: None,
            quiet_after: Duration::from_secs(240),
            repos_dir: None,
        }
    }

    /// Next to the store: `~/Library/Application Support/VibeValley/worktrees`
    /// and `.../VibeValley/issues` for the default store.
    pub fn beside(store_path: &Path) -> BoardConfig {
        BoardConfig::under(store_path.parent().unwrap_or(Path::new(".")))
    }
}

/// What the user writes down.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewIssue {
    pub title: String,
    pub description: String,
    pub criteria: Vec<String>,
    /// A path inside the repository it changes; none for an answer only.
    pub repo: Option<PathBuf>,
    /// The runtime that does it (`claude`, `codex`, `acp:…`, `scripted`).
    pub agent: String,
    pub deliver: Deliverable,
    #[serde(default)]
    pub priority: Priority,
    /// Its parent issue (id or number); the child works on a branch cut
    /// from the parent's and merges into it.
    #[serde(default)]
    pub parent: Option<String>,
    /// Issues (ids or numbers) it waits for.
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub constraints: Option<IssueConstraints>,
    /// The cron that keeps it (VibeValley `Issue.cron`).
    #[serde(default)]
    pub cron: Option<String>,
}

/// One child of a split, as VibeValley's `IssueChildDraft`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChildDraft {
    /// The draft's own id, which its siblings' `needs` name.
    pub id: String,
    pub title: String,
    pub brief: String,
    pub needs: Vec<String>,
    pub acceptance: bool,
    pub check: Option<String>,
    pub scope: Vec<String>,
    /// Defaults to the parent's agent.
    pub agent: Option<String>,
}

/// At most this many children per split (VibeValley's `maxChildren`).
pub const MAX_CHILDREN: usize = 12;

/// What became of a request to send an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "sent", rename_all = "snake_case")]
pub enum Sent {
    /// A session works on it.
    Working { session: String },
    /// It waits in todo: for room, or for the issues it is blocked by.
    Queued { blocked_by: Vec<String> },
}

/// An issue's work: the commits on its branch, the diff, what is not
/// committed yet, and whether merging it would conflict.
#[derive(Debug, Clone)]
pub struct Changes {
    pub base: String,
    pub branch: String,
    pub worktree: PathBuf,
    pub commits: Vec<vibevalley_git::Commit>,
    pub files: Vec<vibevalley_git::FileDiff>,
    pub uncommitted: Vec<vibevalley_git::FileDiff>,
    pub conflicts: Vec<PathBuf>,
    /// Commits on the base its branch does not have.
    pub behind: usize,
}

const ISSUE: &str = "issue";
const SESSION: &str = "issue-session";
/// Sessions that left, as they were when they did: an issue's history still names them.
const PAST_SESSION: &str = "issue-session-past";
const WORDS: &str = "issue-words";
/// What the board keeps of a session beyond its wire shape.
const SESSION_EXTRA: &str = "issue-session-extra";
const COUNTERS: (&str, &str) = ("issue-board", "counters");

fn now() -> Millis {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as Millis).unwrap_or(0)
}

fn io(e: std::io::Error) -> BoardError {
    BoardError::Other(e.to_string())
}

pub fn issue_branch(number: i64) -> String {
    format!("vibevalley/issue-{number}")
}

/// A session this process is driving. `generation` tells a pump whether
/// the session it reads is still the one on the board.
struct Live {
    agent: Arc<dyn vibevalley_oar::Session>,
    generation: u64,
}

/// What the board keeps of a session beyond the wire `Session`: the
/// runtime's own session to resume, and the branch its work forked from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Extra {
    agent_session: Option<String>,
    base: Option<String>,
    /// The run going on now, until its round ends.
    #[serde(default)]
    run: Option<String>,
}

/// `SessionAction` of a tool by its name (Claude Code's and Codex's).
fn action_of_tool(name: &str) -> SessionAction {
    match name {
        "Bash" | "shell" | "exec_command" | "local_shell" => SessionAction::RunCommand,
        "Read" | "NotebookRead" | "read_file" => SessionAction::ReadFile,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "apply_patch" => SessionAction::EditFile,
        "Grep" | "Glob" | "LS" | "search" => SessionAction::Search,
        "WebFetch" | "WebSearch" | "web_search" => SessionAction::Web,
        n if n.starts_with("mcp__") => SessionAction::Mcp,
        _ => SessionAction::Other,
    }
}

/// Where the board's facts go and its state is read: the server's one
/// state (`vibevalley_server::Hub`) or, standing alone, a [`LocalFacts`].
/// `apply` folds a batch as one commit (`Core.apply`); neither method may
/// call back into the board.
pub trait Facts: Send + Sync {
    fn apply(&self, facts: Vec<Fact>) -> Applied;
    /// Calls `f` once with the state now.
    fn read(&self, f: &mut dyn FnMut(&SpaceState));
    fn frame(&self) -> Frame;
    /// One step of a session's work, in order, for its work log
    /// (VibeValley's journal). Must not call back into the board.
    fn log(&self, _session: &str, _step: Step) {}
}

/// What a session's work log is told.
#[derive(Debug, Clone)]
pub enum Step {
    /// A round starts (`runStarted`).
    RunStarted { run: String },
    /// The round ends with `outcome` (`runEnded`).
    RunEnded { run: String, outcome: Outcome },
    /// Words sent to the agent (`asked`).
    Asked { text: String },
    /// What the agent did.
    Agent(vibevalley_oar::Event),
}

/// A state of the board's own, for a board without a server.
#[derive(Default)]
pub struct LocalFacts(Mutex<Core>);

impl Facts for LocalFacts {
    fn apply(&self, facts: Vec<Fact>) -> Applied {
        lock(&self.0).apply(facts)
    }

    fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
        f(lock(&self.0).state())
    }

    fn frame(&self) -> Frame {
        lock(&self.0).frame(vec![])
    }
}

struct Inner {
    extras: HashMap<String, Extra>,
    live: HashMap<String, Live>,
    /// Each subscriber's sender and a receiver to drop a stale frame with.
    subscribers: Vec<(flume::Sender<Frame>, flume::Receiver<Frame>)>,
    generation: u64,
}

/// The helpers' MCP door as the board hands it out: where it is, and which
/// helper each bearer token names.
#[derive(Default)]
struct Door {
    url: Option<String>,
    tokens: HashMap<String, String>,
}

#[derive(Clone)]
pub struct Board {
    inner: Arc<Mutex<Inner>>,
    door: Arc<Mutex<Door>>,
    facts: Arc<dyn Facts>,
    /// Held by every change to the workflow (not by event pumps), so rooms
    /// are counted and issues sent one at a time. Taken before `inner`.
    work: Arc<Mutex<()>>,
    lock: Arc<Mutex<Option<File>>>,
    store: Arc<Store>,
    drivers: Arc<dyn Drivers>,
    config: Arc<BoardConfig>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn load(store: &Store) -> Result<(Vec<Session>, Vec<Issue>)> {
    let sessions = store.docs(SESSION)?.into_iter().filter_map(|(_, v)| serde_json::from_value(v).ok()).collect();
    let issues = store.docs(ISSUE)?.into_iter().filter_map(|(_, v)| serde_json::from_value(v).ok()).collect();
    Ok((sessions, issues))
}

fn loaded(sessions: Vec<Session>, issues: Vec<Issue>) -> Vec<Fact> {
    let at = now();
    let mut facts: Vec<Fact> = sessions.into_iter().map(|session| Fact::session_changed(at, session)).collect();
    facts.extend(issues.into_iter().map(|issue| Fact::issue_changed(at, issue)));
    facts
}

impl Board {
    /// The board as stored, without taking it: for reading while another
    /// process holds it. Working sessions show as they were last stored.
    pub fn snapshot(store: &Store) -> Result<Frame> {
        let (sessions, issues) = load(store)?;
        let facts = LocalFacts::default();
        facts.apply(loaded(sessions, issues));
        Ok(facts.frame())
    }

    /// Takes the board and loads it. A session that was working when the
    /// last process ended was interrupted: its run is over and it rests
    /// until the next words, as VibeValley does for external agents. A
    /// session whose worktree is gone leaves, and its open issue is
    /// canceled as lost. Call `refresh_queue` afterwards to send what waits.
    pub fn open(store: Arc<Store>, registry: Arc<Registry>, config: BoardConfig) -> Result<Board> {
        Board::open_on(store, registry, config, Arc::new(LocalFacts::default()))
    }

    /// `open`, with the board's issues and sessions in `facts` (the server's
    /// state): what is stored is applied there first.
    pub fn open_on(store: Arc<Store>, registry: Arc<Registry>, config: BoardConfig, facts: Arc<dyn Facts>) -> Result<Board> {
        let drivers = Arc::new(RuntimeDrivers {
            registry,
            model: config.model.clone(),
        });
        Board::open_with(store, drivers, config, facts)
    }

    /// `open_on`, with issues' agents run by `drivers`.
    pub fn open_with(store: Arc<Store>, drivers: Arc<dyn Drivers>, config: BoardConfig, facts: Arc<dyn Facts>) -> Result<Board> {
        std::fs::create_dir_all(config.data_dir.join("reports")).map_err(io)?;
        std::fs::create_dir_all(config.data_dir.join("records")).map_err(io)?;
        let lock_path = config.data_dir.join("board.lock");
        let file = File::create(&lock_path).map_err(io)?;
        // A child process forked while the last holder had it open may hold
        // it a moment longer.
        let deadline = Instant::now() + Duration::from_secs(2);
        while file.try_lock().is_err() {
            if Instant::now() > deadline {
                return Err(BoardError::Busy(lock_path));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let (stored_sessions, issues) = load(&store)?;
        let mut sessions = Vec::new();
        let mut lost = Vec::new();
        let mut drafts = Vec::new();
        let mut interrupted = Vec::new();
        for mut session in stored_sessions {
            if session.worktree.as_deref().is_some_and(|w| !Path::new(w).exists()) {
                store.delete_doc(SESSION, &session.id)?;
                lost.extend(session.issue.clone());
                continue;
            }
            if session.refining {
                drafts.push(session.clone());
            }
            if session.phase.is_working() {
                interrupted.push(session.id.clone());
                session.phase = Phase::resting();
                session.runs += 1;
                session.last_run = Some(LastRun {
                    outcome: Outcome::Interrupted,
                    summary: "Interrupted: VibeValley was closed while it worked".into(),
                    at: now(),
                    spent: None,
                    answer: None,
                });
                store.put_doc(SESSION, &session.id, &serde_json::to_value(&session).unwrap_or_default())?;
            }
            sessions.push(session);
        }
        let extras = store
            .docs(SESSION_EXTRA)?
            .into_iter()
            .filter_map(|(id, v)| Some((id, serde_json::from_value(v).ok()?)))
            .collect();
        facts.apply(loaded(sessions, issues));
        let inner = Inner {
            extras,
            live: HashMap::new(),
            subscribers: Vec::new(),
            generation: 0,
        };
        let board = Board {
            inner: Arc::new(Mutex::new(inner)),
            door: Arc::new(Mutex::new(Door::default())),
            facts,
            work: Arc::new(Mutex::new(())),
            lock: Arc::new(Mutex::new(Some(file))),
            store,
            drivers,
            config: Arc::new(config),
        };
        for id in interrupted {
            board.end_run(&id, Outcome::Interrupted, "Interrupted: VibeValley was closed while it worked", None)?;
        }
        {
            let _work = lock(&board.work);
            for id in lost {
                if let Ok(issue) = board.stored(&id)
                    && !issue.status.is_closed()
                    && issue.latest_session_id().is_some()
                {
                    board.close_issue(&issue, IssueCanceled::Lost)?;
                }
            }
            // A draft cut short leaves its issue as it was.
            for draft in drafts {
                board.dismiss(&draft.id, Workplace::Discard)?;
            }
        }
        Ok(board)
    }

    /// Lets the board go: the agents this process drives stop (their
    /// rounds are recorded as interrupted by the next `open`) and the lock
    /// is released.
    pub fn close(&self) {
        let live: Vec<Live> = lock(&self.inner).live.drain().map(|(_, l)| l).collect();
        for l in live {
            l.agent.dispose();
        }
        lock(&self.lock).take();
    }

    pub fn config(&self) -> &BoardConfig {
        &self.config
    }

    pub fn frame(&self) -> Frame {
        self.facts.frame()
    }

    /// Reads the state the board's facts went into.
    pub fn read<R>(&self, f: impl FnOnce(&SpaceState) -> R) -> R {
        let mut f = Some(f);
        let mut out = None;
        self.facts.read(&mut |s| {
            if let Some(f) = f.take() {
                out = Some(f(s));
            }
        });
        out.expect("Facts::read calls back once")
    }

    /// The newest frame after every change; a receiver that falls behind
    /// skips to the newest.
    pub fn subscribe(&self) -> flume::Receiver<Frame> {
        let (tx, rx) = flume::bounded(1);
        let mut inner = lock(&self.inner);
        let _ = tx.try_send(self.facts.frame());
        inner.subscribers.push((tx, rx.clone()));
        rx
    }

    /// By id, number or `#number`.
    pub fn issue(&self, reference: &str) -> Option<Issue> {
        self.read(|s| find(&s.issues, reference).cloned())
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        self.read(|s| s.sessions.iter().find(|s| s.id == id).cloned())
    }

    /// Whether this process drives the session now.
    /// A session that left the board, as it was when it did.
    pub fn past_session(&self, id: &str) -> Option<Session> {
        let value = self.store.doc(PAST_SESSION, id).ok()??;
        serde_json::from_value(value).ok()
    }

    pub fn is_live(&self, session: &str) -> bool {
        lock(&self.inner).live.contains_key(session)
    }

    /// The record file of a session's agent events.
    pub fn record_path(&self, session: &str) -> PathBuf {
        self.config.data_dir.join("records").join(format!("{session}.jsonl"))
    }

    pub fn report_path(&self, session: &str) -> PathBuf {
        self.config.data_dir.join("reports").join(format!("{session}.json"))
    }

    /// `<work root>/AGENTS.md`, the rules every repo on this machine shares.
    fn house_rules(&self) -> String {
        let Some(root) = self.config.repos_dir.as_deref().and_then(Path::parent) else {
            return String::new();
        };
        std::fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default()
    }

    /// Where helpers reach the farm's MCP door (`http://<addr>/mcp`); a helper
    /// started before it is known gets no door.
    pub fn set_mcp_url(&self, url: String) {
        lock(&self.door).url = Some(url);
    }

    /// The helper a bearer token names.
    pub fn who(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        lock(&self.door).tokens.get(token).cloned()
    }

    /// The helper's door entry, minting its token once.
    fn door_for(&self, session: &str) -> Option<McpServer> {
        let mut door = lock(&self.door);
        let url = door.url.clone()?;
        let token = match door.tokens.iter().find(|(_, s)| s.as_str() == session) {
            Some((t, _)) => t.clone(),
            None => {
                let t = uuid::Uuid::new_v4().simple().to_string();
                door.tokens.insert(t.clone(), session.to_string());
                t
            }
        };
        Some(McpServer::Http {
            name: "vibevalley".into(),
            url,
            headers: vec![("authorization".into(), format!("Bearer {token}"))],
        })
    }

    fn close_door(&self, session: &str) {
        lock(&self.door).tokens.retain(|_, s| s != session);
    }

    /// What the helper hands back at the end of its round (`issue_report`),
    /// read when the round ends.
    pub fn report(&self, session: &str, report: &Report) -> Result<()> {
        let path = self.report_path(session);
        let failed = |e: &dyn std::fmt::Display| BoardError::Other(format!("the report for {session}: {e}"));
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| failed(&e))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(report).map_err(|e| failed(&e))?).map_err(|e| failed(&e))?;
        std::fs::rename(tmp, path).map_err(|e| failed(&e))
    }

    fn stored(&self, reference: &str) -> Result<Issue> {
        self.issue(reference).ok_or_else(|| BoardError::NoIssue(reference.to_string()))
    }

    fn state(&self) -> SpaceState {
        self.read(SpaceState::clone)
    }

    fn apply(&self, facts: Vec<Fact>) -> Result<()> {
        let mut inner = lock(&self.inner);
        self.apply_in(&mut inner, facts)
    }

    fn apply_in(&self, inner: &mut Inner, facts: Vec<Fact>) -> Result<()> {
        // Stored first, then published.
        for fact in &facts {
            match fact {
                Fact::IssueChanged(vibevalley_protocol::FactIssueChanged { issue, .. }) => {
                    self.store.put_doc(ISSUE, &issue.id, &serde_json::to_value(issue).unwrap_or_default())?
                }
                Fact::IssueRemoved(vibevalley_protocol::FactIssueRemoved { id, .. }) => self.store.delete_doc(ISSUE, id)?,
                Fact::SessionLeft(vibevalley_protocol::FactSessionLeft { id, closed, .. }) => {
                    if let Some(mut past) = self.session(id) {
                        if let Some(closed) = closed {
                            past.phase = Phase::Closed(vibevalley_protocol::PhaseClosed { at: now(), closed: *closed });
                        }
                        self.store.put_doc(PAST_SESSION, id, &serde_json::to_value(&past).unwrap_or_default())?;
                    }
                    self.store.delete_doc(SESSION, id)?
                }
                _ => {}
            }
        }
        let applied = self.facts.apply(facts);
        // Sessions are stored as the core holds them: phase and last run
        // come from several facts.
        for fact in applied.transitions.iter().map(|t| &t.fact) {
            let id = match fact {
                Fact::SessionChanged(vibevalley_protocol::FactSessionChanged { session, .. }) => Some(&session.id),
                Fact::SessionPhaseChanged(vibevalley_protocol::FactSessionPhaseChanged { id, .. })
                | Fact::SessionReported(vibevalley_protocol::FactSessionReported { id, .. }) => Some(id),
                Fact::SessionLeft(vibevalley_protocol::FactSessionLeft { id, .. }) => {
                    inner.extras.remove(id);
                    self.store.delete_doc(SESSION_EXTRA, id)?;
                    None
                }
                _ => None,
            };
            if let Some(id) = id
                && let Some(s) = self.session(id)
            {
                self.store.put_doc(SESSION, id, &serde_json::to_value(&s).unwrap_or_default())?;
            }
        }
        if !applied.transitions.is_empty() && !inner.subscribers.is_empty() {
            let frame = self.facts.frame();
            inner.subscribers.retain(|(tx, stale)| {
                let _ = stale.try_recv();
                !matches!(tx.try_send(frame.clone()), Err(flume::TrySendError::Disconnected(_)))
            });
        }
        Ok(())
    }

    fn extra(&self, session: &str) -> Extra {
        lock(&self.inner).extras.get(session).cloned().unwrap_or_default()
    }

    fn set_extra(&self, session: &str, change: impl FnOnce(&mut Extra)) -> Result<()> {
        let mut inner = lock(&self.inner);
        let extra = inner.extras.entry(session.to_string()).or_default();
        change(extra);
        let value = serde_json::to_value(&*extra).unwrap_or_default();
        self.store.put_doc(SESSION_EXTRA, session, &value)?;
        Ok(())
    }

    /// The branch a session's work forked from.
    pub fn base_branch(&self, session: &str) -> Option<String> {
        self.extra(session).base
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut Issue)) -> Result<Issue> {
        let mut inner = lock(&self.inner);
        let mut issue = self.issue(id).ok_or_else(|| BoardError::NoIssue(id.into()))?;
        change(&mut issue);
        let id = issue.id.clone();
        self.apply_in(&mut inner, vec![Fact::issue_changed(now(), issue)])?;
        drop(inner);
        self.stored(&id)
    }

    fn next(&self, counter: &str, at_least: i64) -> Result<i64> {
        let mut counters = self.store.doc(COUNTERS.0, COUNTERS.1)?.unwrap_or_else(|| serde_json::json!({}));
        let n = counters[counter].as_i64().unwrap_or(0).max(at_least) + 1;
        counters[counter] = n.into();
        self.store.put_doc(COUNTERS.0, COUNTERS.1, &counters)?;
        Ok(n)
    }

    // ----- what the user does -----

    pub fn create(&self, new: NewIssue) -> Result<Issue> {
        let _work = lock(&self.work);
        let repo = match &new.repo {
            Some(path) => Some(self.ensure_repo(self.repo_dir(&path.to_string_lossy()))?),
            None => None,
        };
        if !new.agent.trim().is_empty() {
            self.drivers.check(new.agent.trim())?;
        }
        let (title, description) =
            vibevalley_core::brief::issue_words(&new.title, &new.description).ok_or_else(|| BoardError::Other("the issue has no title".into()))?;
        let state = self.state();
        let parent = match &new.parent {
            Some(p) => Some(find(&state.issues, p).cloned().ok_or_else(|| BoardError::NoIssue(p.clone()))?),
            None => None,
        };
        let mut blocked_by = Vec::new();
        for b in &new.blocked_by {
            blocked_by.push(find(&state.issues, b).ok_or_else(|| BoardError::NoIssue(b.clone()))?.id.clone());
        }
        if let Some(p) = &parent
            && p.status.is_closed()
        {
            return Err(BoardError::Other(format!("issue #{} is closed", p.number)));
        }
        let repo_root = match (&repo, &parent) {
            (Some(r), _) => Some(self.repo_ref(r.root())),
            (None, Some(p)) => p.repo.clone(),
            (None, None) => None,
        };
        let stored_max = state.issues.iter().map(|t| t.number).max().unwrap_or(0);
        let number = self.next("issue", stored_max)?;
        let id = format!("i{number}");
        let mut graph: Vec<(String, Option<String>, Vec<String>)> =
            state.issues.iter().map(|t| (t.id.clone(), t.parent.clone(), t.blocked_by.clone())).collect();
        graph.push((id.clone(), parent.as_ref().map(|p| p.id.clone()), blocked_by.clone()));
        let problems = vibevalley_core::dependency_problems(&graph);
        if !problems.is_empty() {
            return Err(BoardError::Other(format!("the dependencies do not form a DAG: {problems:?}")));
        }
        if new
            .constraints
            .as_ref()
            .is_some_and(|c| c.acceptance && c.check.as_deref().unwrap_or("").is_empty())
        {
            return Err(BoardError::Other("an acceptance issue needs a check command".into()));
        }
        let at = now();
        let mut issue = Issue::new(&id, number, title, at);
        issue.description = description;
        issue.criteria = vibevalley_core::refine::kept(&new.criteria);
        issue.deliver = new.deliver;
        issue.repo = repo_root;
        issue.priority = parent.as_ref().map(|p| p.priority).unwrap_or(new.priority);
        let parent_agent = parent.as_ref().and_then(|p| p.assigned_agent()).map(String::from);
        issue.parent = parent.map(|p| p.id);
        issue.blocked_by = blocked_by;
        issue.constraints = new.constraints;
        issue.cron = new.cron;
        let agent = new.agent.trim().to_string();
        let agent = if agent.is_empty() { parent_agent.unwrap_or_default() } else { agent };
        if !agent.is_empty() {
            issue.assignments = vec![Assignment {
                id: format!("{id}-a1"),
                issue: id.clone(),
                agent,
                assigned_at: at,
                ended_at: None,
                executions: vec![],
            }];
        }
        self.apply(vec![Fact::issue_changed(at, issue)])?;
        self.stored(&id)
    }

    /// The user moves an issue on the board. `words` carry what to do this
    /// time for a round or a reopen.
    pub fn move_to(&self, reference: &str, to: IssueStatus, words: Option<&str>) -> Result<Move> {
        let _work = lock(&self.work);
        let issue = self.stored(reference)?;
        let mv = status_move(&issue, to).map_err(BoardError::Refused)?;
        let words = words.map(str::trim).filter(|w| !w.is_empty()).map(String::from);
        match mv {
            Move::Start => {
                if let Some(w) = words {
                    self.keep_words(&issue.id, &w)?;
                }
                self.update(&issue.id, |t| t.queued_at = Some(now()))?;
                self.send(&issue.id, None, RunTriggerKind::Issue)?;
            }
            Move::Unqueue => {
                self.update(&issue.id, |t| t.queued_at = None)?;
            }
            Move::Round | Move::Reopen => {
                // Sending back what was handed in takes the user's findings;
                // the server words the rest (cure, resume, resolve).
                let required = mv == Move::Reopen || issue.stage.state == StageKind::Reviewing;
                let words = match words {
                    Some(w) => w,
                    None if required => return Err(BoardError::WordsRequired),
                    None => default_words(&issue),
                };
                self.room_for_round(&issue)?;
                self.update(&issue.id, |t| {
                    t.closed_at = None;
                    t.delivered = None;
                    t.canceled = None;
                    t.questions.clear();
                    t.conflict = None;
                    t.reviewed_at = None;
                    t.queued_at = Some(now());
                })?;
                self.send(&issue.id, Some(words), RunTriggerKind::Comment)?;
            }
            Move::Revive => {
                self.update(&issue.id, |t| {
                    t.closed_at = None;
                    t.canceled = None;
                    t.queued_at = None;
                })?;
            }
            Move::Complete => self.complete(&issue)?,
            Move::Cancel | Move::Drop => {
                self.close_issue(&issue, IssueCanceled::Dismissed)?;
                self.refresh_queue_locked();
            }
        }
        Ok(mv)
    }

    /// A round for a session still on the board needs room now (VibeValley
    /// refuses the delivery); a new session may wait in todo.
    fn room_for_round(&self, issue: &Issue) -> Result<()> {
        let Some(session) = self.on_board(issue) else { return Ok(()) };
        let (space, repo) = self.room(issue, &session.id);
        if space == 0 || repo == 0 {
            return Err(BoardError::NoRoom(format!(
                "{} sessions work in the space (limit {}), {} in this repository",
                self.space_busy(),
                self.config.space_limit,
                self.config.per_repo.saturating_sub(repo.min(self.config.per_repo))
            )));
        }
        Ok(())
    }

    /// Words to the issue's session: an answer to its question, or a note.
    /// Steers the running turn when the runtime can; otherwise the next
    /// round starts with them. Words for an issue not sent yet wait for it.
    pub fn tell(&self, reference: &str, words: &str) -> Result<()> {
        let words = words.trim();
        if words.is_empty() {
            return Err(BoardError::WordsRequired);
        }
        let _work = lock(&self.work);
        let issue = self.stored(reference)?;
        if issue.status.is_closed() {
            return Err(BoardError::Refused(if issue.was_sent() { Refusal::Reopen } else { Refusal::Revive }));
        }
        let session = self.on_board(&issue);
        if let Some(s) = &session
            && s.phase.is_working()
        {
            let agent = lock(&self.inner).live.get(&s.id).map(|l| l.agent.clone());
            if let Some(agent) = agent {
                self.facts.log(&s.id, Step::Asked { text: words.to_string() });
                return match agent.steer(text(words)) {
                    Ok(()) => Ok(()),
                    Err(_) => Ok(agent.queue(text(words))?),
                };
            }
        }
        match issue.status {
            IssueStatus::Backlog | IssueStatus::Todo => self.keep_words(&issue.id, words),
            _ => {
                self.room_for_round(&issue)?;
                // The user speaking answers the questions and takes back a
                // reviewer's pass.
                self.update(&issue.id, |t| {
                    t.questions.clear();
                    t.reviewed_at = None;
                    t.queued_at = Some(now());
                })?;
                self.send(&issue.id, Some(words.to_string()), RunTriggerKind::Comment).map(|_| ())
            }
        }
    }

    /// Stops the running turn of the issue's session.
    pub fn stop(&self, reference: &str) -> Result<()> {
        let issue = self.stored(reference)?;
        let refining = issue.refining.as_ref().map(|r| r.session.clone());
        let session = refining.or_else(|| issue.latest_session_id().cloned());
        let agent = session.and_then(|s| lock(&self.inner).live.get(&s).map(|l| l.agent.clone()));
        let agent = agent.ok_or_else(|| BoardError::Other("nothing is running".into()))?;
        agent.abort()?;
        Ok(())
    }

    /// Sends queued issues while there is room, in board order. Children in
    /// review are merged into their parents first.
    pub fn refresh_queue(&self) -> Result<()> {
        let _work = lock(&self.work);
        self.join_children()?;
        self.refresh_queue_locked();
        Ok(())
    }

    fn refresh_queue_locked(&self) {
        let queued: Vec<String> = self
            .state()
            .issues
            .iter()
            .filter(|t| t.status == IssueStatus::Todo && t.queued_at.is_some())
            .map(|t| t.id.clone())
            .collect();
        for id in queued {
            if let Err(e) = self.send(&id, None, RunTriggerKind::Issue) {
                // One that cannot go any more leaves the queue.
                eprintln!("vibevalley: issue {id} could not be sent: {e}");
                let _ = self.update(&id, |t| t.queued_at = None);
            }
        }
    }

    // ----- sending -----

    /// The issue's newest session, while it is on the board.
    fn on_board(&self, issue: &Issue) -> Option<Session> {
        let id = issue.latest_session_id()?;
        self.session(id)
    }

    fn room(&self, issue: &Issue, except: &str) -> (usize, usize) {
        let room = self.read(|s| {
            vibevalley_core::rules::room_left(
                &s.sessions,
                issue.repo.as_deref().unwrap_or(""),
                self.config.space_limit,
                self.config.per_repo,
                except,
            )
        });
        (room.farm, room.repo.unwrap_or(usize::MAX))
    }

    fn space_busy(&self) -> usize {
        self.read(|s| s.sessions.iter().filter(|s| s.phase.is_working()).count())
    }

    fn keep_words(&self, id: &str, words: &str) -> Result<()> {
        let mut kept: Vec<String> = self.store.doc(WORDS, id)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        kept.push(words.to_string());
        self.store.put_doc(WORDS, id, &serde_json::to_value(kept).unwrap_or_default())?;
        Ok(())
    }

    fn take_words(&self, id: &str) -> Result<Option<String>> {
        let kept: Vec<String> = self.store.doc(WORDS, id)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        self.store.delete_doc(WORDS, id)?;
        Ok((!kept.is_empty()).then(|| kept.join("\n\n")))
    }

    /// Starts (or continues) the issue's session when its blockers are done
    /// and there is room; else it waits in todo and `refresh_queue` sends
    /// it later. Holds `work`.
    fn send(&self, id: &str, words: Option<String>, kind: RunTriggerKind) -> Result<Sent> {
        let issue = self.stored(id)?;
        let state = self.state();
        let blocked = vibevalley_core::blocked_issues(&issue, &state.issues);
        let session = self.on_board(&issue);
        let (space, repo) = self.room(&issue, session.as_ref().map(|s| s.id.as_str()).unwrap_or(""));
        if !blocked.is_empty() || space == 0 || repo == 0 {
            if let Some(w) = &words {
                self.keep_words(id, w)?;
            }
            return Ok(Sent::Queued { blocked_by: blocked });
        }
        let kept = self.take_words(id)?;
        let words = match (kept, words) {
            (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
            (a, b) => a.or(b),
        };
        let result = match session {
            Some(s) => self.continue_session(&issue, &s, words.clone(), kind),
            None => self.hire(&issue, words.clone(), kind),
        };
        match result {
            Ok(session) => Ok(Sent::Working { session }),
            Err(e) => {
                // Not sent: it leaves the queue, the words stay for the next try.
                if let Some(w) = &words {
                    let _ = self.keep_words(id, w);
                }
                let _ = self.update(id, |t| t.queued_at = None);
                Err(e)
            }
        }
    }

    /// The worktree an issue works in: `<worktrees>/<repo>.<number>` on its
    /// branch, cut from `base`.
    fn workplace(&self, main: &Repo, number: i64, base: &str) -> Result<(PathBuf, String)> {
        let name = main.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dir = self.config.worktrees_dir.join(format!("{name}.{number}"));
        let branch = issue_branch(number);
        if dir.join(".git").exists() {
            return Ok((dir, branch));
        }
        std::fs::create_dir_all(&self.config.worktrees_dir).map_err(io)?;
        if git::branch_exists(main.root(), &branch)? {
            git::add_worktree_on(main, &dir, &branch)?;
        } else {
            main.worktree_add(&dir, &branch, Some(base))?;
        }
        Ok((dir, branch))
    }

    fn main_repo(&self, issue: &Issue) -> Result<Option<Repo>> {
        match &issue.repo {
            None => Ok(None),
            Some(repo) => Ok(Some(self.ensure_repo(self.repo_dir(repo))?)),
        }
    }

    /// The repo at `dir`; a folder under the work root that is not one yet (or not there) becomes one, with a first empty commit.
    fn ensure_repo(&self, dir: PathBuf) -> Result<Repo> {
        if let Some(repo) = Repo::discover(&dir)? {
            return Ok(repo);
        }
        let ours = self.config.repos_dir.as_ref().is_some_and(|root| dir.starts_with(root));
        if !ours {
            return Err(BoardError::NotARepo(dir));
        }
        std::fs::create_dir_all(&dir).map_err(|e| BoardError::Other(format!("{}: {e}", dir.display())))?;
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"])
                .args(args)
                .output()
                .map_err(|e| BoardError::Other(e.to_string()))
        };
        git(&["init", "-q", "-b", "main"])?;
        git(&["commit", "-q", "--allow-empty", "-m", "Start"])?;
        Repo::discover(&dir)?.ok_or(BoardError::NotARepo(dir))
    }

    /// Where an issue's `repo` is: a bare name under `repos_dir`, else the
    /// path as written.
    pub fn repo_dir(&self, repo: &str) -> PathBuf {
        match &self.config.repos_dir {
            Some(root) if !repo.is_empty() && !repo.contains('/') => root.join(repo),
            _ => PathBuf::from(repo),
        }
    }

    /// How an issue names a repository's top: its name when it is right
    /// under `repos_dir`, else its path.
    pub fn repo_ref(&self, top: &Path) -> String {
        if let Some(root) = &self.config.repos_dir {
            let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
            let top = std::fs::canonicalize(top).unwrap_or_else(|_| top.to_path_buf());
            if top.parent() == Some(root.as_path())
                && let Some(name) = top.file_name()
            {
                return name.to_string_lossy().into_owned();
            }
        }
        top.to_string_lossy().into_owned()
    }

    fn main_branch(main: &Repo) -> Result<String> {
        main.status()?
            .branch
            .ok_or_else(|| BoardError::Other("the main checkout has no branch checked out".into()))
    }

    /// The branch a child's work forks from: its parent's, made from the
    /// main branch when the parent never had one.
    fn base_of(&self, issue: &Issue, main: &Repo) -> Result<String> {
        let Some(parent) = issue.parent.as_ref().and_then(|p| self.issue(p)) else {
            return Self::main_branch(main);
        };
        let branch = issue_branch(parent.number);
        if !git::branch_exists(main.root(), &branch)? {
            main.create_branch(&branch, Some(&Self::main_branch(main)?))?;
        }
        Ok(branch)
    }

    fn hire(&self, issue: &Issue, words: Option<String>, kind: RunTriggerKind) -> Result<String> {
        let drive = self.drivers.drive(issue.assigned_agent(), issue)?;
        let main = self.main_repo(issue)?;
        let (cwd, branch, base) = match &main {
            Some(main) => {
                let base = self.base_of(issue, main)?;
                let (dir, branch) = self.workplace(main, issue.number, &base)?;
                (dir, Some(branch), Some(base))
            }
            None => {
                let dir = self.config.data_dir.join("contexts").join(&issue.id);
                std::fs::create_dir_all(&dir).map_err(io)?;
                (dir, None, None)
            }
        };
        let number = self.next("session", 0)?;
        let session_id = format!("w{number}");
        let mut session = Session::worker(&session_id, format!("{} #{}", drive.name, issue.number), now());
        session.agent = drive.agent.clone();
        session.runtime = drive.runtime_id.clone();
        session.brief = issue.title.clone();
        session.repo = issue.repo.clone();
        session.branch = branch;
        self.set_extra(&session_id, |e| e.base = base)?;
        session.worktree = Some(cwd.to_string_lossy().into_owned());
        session.issue = Some(issue.id.clone());
        let all = self.state().issues;
        let prompt = brief(issue, &all, words.as_deref());
        self.start_session(drive, session, issue, prompt, false, runs::trigger_of(kind, words))
    }

    /// Opens the agent for `session`, puts it on the board and sends the
    /// first prompt. `resume` reopens the runtime's own session.
    fn start_session(
        &self,
        drive: Drive,
        mut session: Session,
        issue: &Issue,
        prompt: String,
        resume: bool,
        trigger: vibevalley_protocol::RunTrigger,
    ) -> Result<String> {
        let runtime = drive.runtime.clone();
        let report = self.report_path(&session.id);
        let _ = std::fs::remove_file(&report);
        let cwd = PathBuf::from(session.worktree.clone().unwrap_or_default());
        let instructions = if session.refining {
            "You are drafting an issue for VibeValley's board. Do not change or commit files.".to_string()
        } else {
            let place = HelperPlace {
                repo: session.repo.clone().unwrap_or_default(),
                branch: session.branch.clone(),
                cwd: session.worktree.clone().unwrap_or_default(),
                id: session.id.clone(),
                pull_request: issue.deliver == Deliverable::PullRequest,
                house: self.house_rules(),
            };
            self.drivers.rules(&place, issue.deliver)
        };
        let system_prompt = match &drive.persona {
            Some(Persona::Replace(persona)) => Some(persona.clone()),
            _ => None,
        };
        let (instructions, prompt) = match &drive.persona {
            Some(Persona::System(persona)) => (format!("{persona}\n\n{instructions}"), prompt),
            Some(Persona::Prompt(persona)) if !resume => (instructions, format!("{persona}\n\n---\n\n{prompt}")),
            _ => (instructions, prompt),
        };
        let env = drive.env.clone();
        let mut mcp_servers: Vec<McpServer> = self.door_for(&session.id).into_iter().collect();
        mcp_servers.extend(drive.mcp_servers.iter().cloned());
        #[allow(clippy::needless_update, reason = "fields vibevalley-oar adds later")]
        let opts = SessionOptions {
            cwd,
            model: drive.model.clone(),
            resume: if resume { self.extra(&session.id).agent_session } else { None },
            permission_mode: self.config.permission,
            append_system_prompt: Some(instructions),
            env,
            record_to: Some(self.record_path(&session.id)),
            effort: drive.effort.clone(),
            mcp_servers,
            disallowed_tools: drive.disallowed_tools.clone(),
            system_prompt,
            ..Default::default()
        };
        let agent = runtime.open(opts)?;
        self.set_extra(&session.id, |e| e.agent_session = Some(agent.id()))?;
        session.phase = Phase::working(now(), SessionAction::Thinking, "");
        let events = agent.events();
        let generation = {
            let mut inner = lock(&self.inner);
            let mut facts = vec![Fact::session_changed(now(), session.clone())];
            if let Some(mut updated) = self.issue(&issue.id) {
                updated.queued_at = None;
                if !session.refining
                    && updated.latest_session_id() != Some(&session.id)
                    && let Some(a) = updated.assignments.iter_mut().rev().find(|a| a.ended_at.is_none())
                {
                    a.executions.push(Execution::Worker {
                        session: session.id.clone(),
                        started_at: now(),
                    });
                }
                facts.push(Fact::issue_changed(now(), updated));
            }
            inner.generation += 1;
            let generation = inner.generation;
            inner.live.insert(
                session.id.clone(),
                Live {
                    agent: agent.clone(),
                    generation,
                },
            );
            self.apply_in(&mut inner, facts)?;
            generation
        };
        let board = self.clone();
        let session_id = session.id.clone();
        std::thread::Builder::new()
            .name(format!("vibevalley-{session_id}"))
            .spawn(move || board.pump(&session_id, generation, events))
            .map_err(io)?;
        self.begin_run(&session.id, &issue.id, trigger)?;
        let prompt = self.with_recall(&session, prompt);
        self.facts.log(&session.id, Step::Asked { text: prompt.clone() });
        if let Err(e) = agent.prompt(text(&prompt)) {
            let _ = self.dismiss(&session.id, Workplace::Keep);
            return Err(e.into());
        }
        Ok(session.id)
    }

    /// `withRecall`: what the agent remembers, set apart before the input.
    fn with_recall(&self, session: &Session, input: String) -> String {
        let block = self.drivers.recall(&session.agent, &session.id, session.repo.as_deref().unwrap_or(""), &input);
        if block.is_empty() { input } else { format!("{block}\n\n---\n\n{input}") }
    }

    /// The next round for a session on the board: its agent if this process
    /// still drives it, else reopened (resumed when the runtime can).
    fn continue_session(&self, issue: &Issue, session: &Session, words: Option<String>, kind: RunTriggerKind) -> Result<String> {
        let words = words.unwrap_or_else(|| default_words(issue));
        let trigger = runs::trigger_of(kind, Some(words.clone()));
        let agent = lock(&self.inner).live.get(&session.id).map(|l| l.agent.clone());
        match agent {
            Some(agent) => {
                let _ = std::fs::remove_file(self.report_path(&session.id));
                // Working from now, not from when the pump reads the turn's
                // start: the room is counted by it.
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                self.apply(vec![self.phase_changed(session.id.clone(), phase)])?;
                self.begin_run(&session.id, &issue.id, trigger)?;
                let words = self.with_recall(session, words);
                self.facts.log(&session.id, Step::Asked { text: words.clone() });
                agent.prompt(text(&words))?;
                self.update(&issue.id, |t| t.queued_at = None)?;
                Ok(session.id.clone())
            }
            None => {
                let drive = self.drivers.drive(Some(session.agent.as_str()).filter(|a| !a.is_empty()), issue)?;
                let resume = drive.runtime.capabilities().resume && self.extra(&session.id).agent_session.is_some();
                let prompt = if resume {
                    words
                } else {
                    let all = self.state().issues;
                    format!(
                        "{}\n\nYou are taking this issue up again in its worktree; earlier work is on its branch: \
                         check `git status` and `git log` first.",
                        brief(issue, &all, Some(&words))
                    )
                };
                self.start_session(drive, session.clone(), issue, prompt, resume, trigger)
            }
        }
    }

    // ----- a session's events -----

    fn current(&self, session: &str, generation: u64) -> bool {
        lock(&self.inner).live.get(session).is_some_and(|l| l.generation == generation)
    }

    /// Turns the agent's events into facts until the session ends or leaves.
    fn pump(&self, session_id: &str, generation: u64, events: flume::Receiver<vibevalley_oar::Event>) {
        let mut said = String::new();
        let mut asked: Vec<Question> = Vec::new();
        let mut last_event = Instant::now();
        let tick = self.config.quiet_after.min(Duration::from_secs(5)).max(Duration::from_millis(20));
        loop {
            let event = match events.recv_timeout(tick) {
                Ok(event) => event,
                Err(flume::RecvTimeoutError::Timeout) => {
                    if !self.current(session_id, generation) {
                        return;
                    }
                    if last_event.elapsed() >= self.config.quiet_after {
                        self.set_quiet(session_id, Some(now()));
                    }
                    continue;
                }
                Err(flume::RecvTimeoutError::Disconnected) => break,
            };
            if !self.current(session_id, generation) {
                return;
            }
            last_event = Instant::now();
            self.set_quiet(session_id, None);
            self.facts.log(session_id, Step::Agent(event.clone()));
            let root = event.agent_path.is_empty();
            match event.kind {
                EventKind::TurnStarted { .. } if root => {
                    said.clear();
                    asked.clear();
                    let phase = Phase::working(now(), SessionAction::Thinking, "");
                    let _ = self.apply(vec![self.phase_changed(session_id, phase)]);
                }
                EventKind::TextDelta { text } if root => said.push_str(&text),
                EventKind::ToolCallStarted { name, .. } if root => self.set_doing(
                    session_id,
                    Doing {
                        action: action_of_tool(&name),
                        label: name,
                    },
                ),
                EventKind::Question { text } if root => {
                    asked.push(Question {
                        question: text,
                        options: vec![],
                    });
                }
                EventKind::PermissionRequested { request_id, .. } if self.config.permission == PermissionMode::Bypass => {
                    let agent = lock(&self.inner).live.get(session_id).map(|l| l.agent.clone());
                    if let Some(agent) = agent {
                        let _ = agent.respond_permission(&request_id, PermissionDecision::AllowOnce);
                    }
                }
                EventKind::TurnFinished { reason, .. } if root => {
                    self.finish_run(session_id, reason, &said, &asked);
                    self.after_round();
                }
                EventKind::SessionEnded => break,
                _ => {}
            }
        }
        let mut inner = lock(&self.inner);
        if inner.live.get(session_id).is_some_and(|l| l.generation == generation) {
            inner.live.remove(session_id);
        }
    }

    /// A phase change keeps the session where it talks: the fact carries
    /// the channel, and an absent one would clear it.
    fn phase_changed(&self, id: impl Into<String>, phase: Phase) -> Fact {
        let id = id.into();
        let channel = self.session(&id).and_then(|s| s.channel);
        Fact::session_phase_changed(now(), id, phase, channel)
    }

    fn working(&self, session_id: &str) -> Option<PhaseWorking> {
        self.read(|s| {
            s.sessions.iter().find(|s| s.id == session_id).and_then(|s| match &s.phase {
                Phase::Working(p) => Some(p.clone()),
                _ => None,
            })
        })
    }

    fn set_doing(&self, session_id: &str, doing: Doing) {
        let Some(p) = self.working(session_id) else { return };
        let phase = Phase::Working(PhaseWorking { doing, quiet_since: None, ..p });
        let _ = self.apply(vec![self.phase_changed(session_id, phase)]);
    }

    fn set_quiet(&self, session_id: &str, quiet: Option<Millis>) {
        let Some(p) = self.working(session_id) else { return };
        if p.quiet_since.is_some() == quiet.is_some() {
            return;
        }
        let phase = Phase::Working(PhaseWorking { quiet_since: quiet, ..p });
        let _ = self.apply(vec![self.phase_changed(session_id, phase)]);
    }

    fn finish_run(&self, session_id: &str, reason: StopReason, said: &str, asked: &[Question]) {
        let Some(session) = self.session(session_id) else { return };
        if session.issue.is_none() && session.channel.is_some() {
            self.finish_talk(&session, reason, said);
            return;
        }
        let Some(issue) = session.issue.as_deref().and_then(|i| self.issue(i)) else {
            return;
        };
        if session.refining {
            self.finish_draft(&session, &issue, reason, said, asked);
            return;
        }
        let report = Report::read(&self.report_path(session_id));
        let outcome = match (&reason, &report) {
            (StopReason::Aborted, _) => Outcome::Interrupted,
            (StopReason::Error | StopReason::MaxTurns, _) => Outcome::Failed,
            (StopReason::Completed, Some(r)) if r.status == ReportStatus::Failed => Outcome::Failed,
            (StopReason::Completed, _) => Outcome::Completed,
        };
        let declared = report.as_ref().map(|r| r.summary.trim().to_string()).filter(|s| !s.is_empty());
        let summary = declared.unwrap_or_else(|| {
            let read = vibevalley_core::text::summary_of(said);
            if !read.is_empty() {
                read
            } else if outcome == Outcome::Completed {
                "Done.".into()
            } else {
                "Did not finish.".into()
            }
        });
        let summary = vibevalley_core::text::clip(&summary, 400);
        let mut questions: Vec<Question> = match &report {
            Some(r) if !r.questions.is_empty() => r.questions.iter().map(ReportQuestion::to_question).collect(),
            _ => vibevalley_core::text::questions_from_text(said),
        };
        questions.extend(asked.iter().cloned());
        if outcome == Outcome::Completed && questions.is_empty() && report.as_ref().is_some_and(|r| r.status == ReportStatus::Blocked) {
            questions.push(Question {
                question: summary.clone(),
                options: vec![],
            });
        }
        let questions = vibevalley_core::refine::open_questions(&questions);
        let answer: Option<IssueAnswer> = report.as_ref().and_then(|r| r.answer.clone()).or_else(|| {
            (issue.deliver == Deliverable::Answer && outcome == Outcome::Completed && !said.trim().is_empty()).then(|| IssueAnswer {
                conclusion: said.trim().to_string(),
                evidence: vec![],
                unsure: vec![],
                next: vec![],
            })
        });
        let checks = report
            .as_ref()
            .map(|r| r.checks.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| vibevalley_core::text::checks_from_text(said));
        let _ = self.end_run(session_id, outcome, &summary, None);
        let mut inner = lock(&self.inner);
        let Some(mut issue) = self.issue(&issue.id) else { return };
        issue.questions = if outcome == Outcome::Interrupted { issue.questions } else { questions };
        // The helper's word on each criterion is the issue's (lifecycle.ts `recordReport`).
        if !checks.is_empty() {
            issue.checks = checks.clone();
        }
        if answer.is_some() {
            issue.answer = answer.clone();
        }
        let runs = session.runs + 1;
        let _ = self.apply_in(
            &mut inner,
            vec![
                Fact::issue_changed(now(), issue),
                Fact::SessionReported(vibevalley_protocol::FactSessionReported {
                    at: now(),
                    id: session_id.into(),
                    run: None,
                    outcome,
                    phase: None,
                    summary,
                    runs,
                    spent: None,
                    questions: vec![],
                    checks,
                    answer,
                }),
            ],
        );
        drop(inner);
        if let Some(r) = report.as_ref().filter(|r| !r.remember.is_empty()) {
            self.drivers
                .remember(&session.agent, session_id, session.repo.as_deref().unwrap_or(""), &r.remember);
        }
    }

    /// After every round: children in review merge into their parents,
    /// then what waits is sent.
    fn after_round(&self) {
        let _work = lock(&self.work);
        if let Err(e) = self.join_children() {
            eprintln!("vibevalley: child issues could not be merged: {e}");
        }
        self.refresh_queue_locked();
    }

    // ----- delivering -----

    /// The issue's work as it stands: in its session's worktree, else (a
    /// parent whose children merged into it) its own checkout.
    pub fn changes(&self, reference: &str) -> Result<Changes> {
        let issue = self.stored(reference)?;
        let main = self.main_repo(&issue)?.ok_or_else(|| BoardError::Other("the issue has no repository".into()))?;
        let base = self.session_base(&issue, &main)?;
        let branch = issue_branch(issue.number);
        // A parent no session worked has no checkout: its children merged into its branch, read in the repo itself.
        let (place, head) = match self.place_of(&issue, &main, false)? {
            Some(place) => (place, "HEAD".to_string()),
            None if git::branch_exists(main.root(), &branch)? => (main.clone(), branch.clone()),
            None => return Err(BoardError::Other("never sent".into())),
        };
        let from = git::merge_base(place.root(), &base, &head)?;
        let commits = place.log(Some(&format!("{from}..{head}")), 0, 200)?;
        let files = place.diff(&vibevalley_git::DiffTarget::Range { from, to: head.clone() }, None)?;
        let uncommitted = if head == "HEAD" {
            place.diff(&vibevalley_git::DiffTarget::Uncommitted, None)?
        } else {
            vec![]
        };
        let target = if issue.parent.is_some() { base.clone() } else { Self::main_branch(&main)? };
        let conflicts = match merge_check_into(&main, &target, &branch)? {
            MergeCheck::Conflicts(files) => files,
            _ => vec![],
        };
        let behind = if git::branch_exists(main.root(), &branch)? {
            git::commits_between(main.root(), &branch, &base)?
        } else {
            0
        };
        Ok(Changes {
            base,
            branch,
            worktree: place.root().to_path_buf(),
            commits,
            files,
            uncommitted,
            conflicts,
            behind,
        })
    }

    fn session_base(&self, issue: &Issue, main: &Repo) -> Result<String> {
        match self.on_board(issue).and_then(|s| self.extra(&s.id).base) {
            Some(base) => Ok(base),
            None => self.base_of(issue, main),
        }
    }

    /// Where the issue's work is: its session's worktree, or its own
    /// checkout (made when `make`).
    fn place_of(&self, issue: &Issue, main: &Repo, make: bool) -> Result<Option<Repo>> {
        if let Some(path) = self.on_board(issue).and_then(|s| s.worktree)
            && let Some(repo) = Repo::discover(Path::new(&path))?
        {
            return Ok(Some(repo));
        }
        let name = main.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dir = self.config.worktrees_dir.join(format!("{name}.{}", issue.number));
        if dir.join(".git").exists() {
            return Ok(Repo::discover(&dir)?);
        }
        if !make || !git::branch_exists(main.root(), &issue_branch(issue.number))? {
            return Ok(None);
        }
        let (dir, _) = self.workplace(main, issue.number, &Self::main_branch(main)?)?;
        Ok(Repo::discover(&dir)?)
    }

    /// Accepted: deliver as the issue says.
    fn complete(&self, issue: &Issue) -> Result<()> {
        let session = self.on_board(issue);
        let main = self.main_repo(issue)?;
        let branch = issue_branch(issue.number);
        let landing = match (issue.deliver, &main) {
            (Deliverable::PullRequest, _) => {
                return Err(BoardError::Other("pull requests are not delivered by VibeValley yet".into()));
            }
            (_, None) | (Deliverable::Answer, _) => Landing::None,
            (Deliverable::Branch, Some(main)) => {
                let base = self.session_base(issue, main)?;
                let has = git::branch_exists(main.root(), &branch)? && git::commits_between(main.root(), &base, &branch)? > 0;
                if has { Landing::Kept } else { Landing::None }
            }
            (Deliverable::Change, Some(main)) => {
                let has_children = self.state().issues.iter().any(|t| t.parent.as_ref() == Some(&issue.id));
                let place = self
                    .place_of(issue, main, has_children)?
                    .ok_or_else(|| BoardError::Other("never sent: there is no work to merge".into()))?;
                // Whatever the agent left uncommitted goes in with the rest.
                place.commit_all(&format!("Issue #{}: {}", issue.number, issue.title))?;
                let target = Self::main_branch(main)?;
                if let MergeCheck::Conflicts(files) = main.merge_check(&branch)? {
                    let files: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
                    let conflict = Conflict {
                        base: target.clone(),
                        files: files.clone(),
                    };
                    self.update(&issue.id, |t| t.conflict = Some(conflict))?;
                    return Err(BoardError::NotDelivered(Undelivered::Conflict { base: target, files }));
                }
                if let Err(output) = check::run_project_check(place.root()) {
                    let sent_back = session.is_some() && self.room_for_round(issue).is_ok();
                    if sent_back {
                        self.update(&issue.id, |t| t.queued_at = Some(now()))?;
                        let words = format!("The project check failed. Fix it and commit:\n\n{output}");
                        self.send(&issue.id, Some(words), RunTriggerKind::Comment)?;
                    }
                    return Err(BoardError::NotDelivered(Undelivered::CheckFailed { output, sent_back }));
                }
                match main.merge_check(&branch)? {
                    MergeCheck::UpToDate => Landing::None,
                    _ => {
                        main.merge(&branch, Some(&format!("Merge issue #{}: {}", issue.number, issue.title)))?;
                        Landing::Merged
                    }
                }
            }
        };
        if let Some(s) = &session {
            let place = if issue.deliver == Deliverable::Branch {
                Workplace::KeepBranch
            } else {
                Workplace::Discard
            };
            self.dismiss(&s.id, place)?;
        } else if let Some(main) = &main {
            self.clear_checkout(issue, main)?;
        }
        self.update(&issue.id, |t| {
            t.delivered = Some(landing);
            t.closed_at = Some(now());
            t.conflict = None;
            t.queued_at = None;
            t.questions.clear();
        })?;
        let _ = self.take_words(&issue.id);
        self.refresh_queue_locked();
        Ok(())
    }

    /// Not done any more: its session goes home (leftovers committed on its
    /// branch, which stays when it has commits), its open children with it.
    fn close_issue(&self, issue: &Issue, why: IssueCanceled) -> Result<()> {
        let children: Vec<Issue> = self
            .state()
            .issues
            .into_iter()
            .filter(|t| t.parent.as_ref() == Some(&issue.id) && !t.status.is_closed())
            .collect();
        for child in children {
            self.close_issue(&child, why)?;
        }
        if let Some(r) = &issue.refining {
            self.dismiss(&r.session, Workplace::Discard)?;
        }
        if let Some(s) = self.on_board(issue) {
            self.dismiss(&s.id, Workplace::KeepBranch)?;
        }
        let _ = self.take_words(&issue.id);
        self.update(&issue.id, |t| {
            t.canceled = Some(why);
            t.closed_at = Some(now());
            t.queued_at = None;
        })?;
        Ok(())
    }

    /// A parent's own checkout, after it merged: removed, its branch too.
    fn clear_checkout(&self, issue: &Issue, main: &Repo) -> Result<()> {
        let name = main.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dir = self.config.worktrees_dir.join(format!("{name}.{}", issue.number));
        git::remove_worktree(main, &dir)?;
        let target = Self::main_branch(main)?;
        git::delete_branch_if_merged(main.root(), &issue_branch(issue.number), &target)?;
        Ok(())
    }

    /// Lets a session go: its agent stops, its worktree is removed (after
    /// committing leftovers when the branch is kept), and its branch is
    /// deleted when nothing on it is unmerged (or always, for `Discard`).
    fn dismiss(&self, session_id: &str, place: Workplace) -> Result<()> {
        let live = lock(&self.inner).live.remove(session_id);
        if let Some(live) = live {
            let _ = live.agent.abort();
            live.agent.dispose();
        }
        let session = self.session(session_id);
        if session.as_ref().is_some_and(|s| s.phase.is_working()) {
            self.end_run(session_id, Outcome::Interrupted, "", None)?;
        }
        if let Some(s) = &session
            && place != Workplace::Keep
            && let (Some(repo), Some(worktree), Some(branch)) = (&s.repo, &s.worktree, &s.branch)
            && let Some(main) = Repo::discover(&self.repo_dir(repo))?
        {
            let dir = PathBuf::from(worktree);
            if place == Workplace::KeepBranch
                && let Some(wt) = Repo::discover(&dir)?
            {
                wt.commit_all(&format!("{}: uncommitted work when it was let go", s.name))?;
            }
            git::remove_worktree(&main, &dir)?;
            let into = self.extra(&s.id).base.map(Ok).unwrap_or_else(|| Self::main_branch(&main))?;
            let discard = place == Workplace::Discard && !git::has_unmerged(main.root(), branch, &into).unwrap_or(true);
            if discard || s.refining {
                git::delete_branch(main.root(), branch)?;
            } else {
                git::delete_branch_if_merged(main.root(), branch, &into)?;
            }
        }
        let _ = std::fs::remove_file(self.report_path(session_id));
        self.close_door(session_id);
        if session.is_some() {
            self.apply(vec![Fact::session_left(now(), session_id, None)])?;
        }
        Ok(())
    }

    // ----- parent and child issues -----

    /// Splits an open issue into child issues, all queued: each goes once
    /// the siblings it needs are done. Ported from VibeValley `split.ts`.
    pub fn split(&self, reference: &str, drafts: Vec<ChildDraft>) -> Result<Vec<Issue>> {
        let _work = lock(&self.work);
        let parent = self.stored(reference)?;
        if parent.status.is_closed() {
            return Err(BoardError::Other(format!("issue #{} is closed", parent.number)));
        }
        let Some(repo) = parent.repo.clone() else {
            return Err(BoardError::Other("only an issue with a repository can be split".into()));
        };
        let state = self.state();
        if state.issues.iter().any(|t| t.parent.as_ref() == Some(&parent.id)) {
            return Err(BoardError::Other(format!("issue #{} is split already", parent.number)));
        }
        let nodes: Vec<vibevalley_core::DagNode> = drafts
            .iter()
            .map(|d| vibevalley_core::DagNode {
                id: d.id.clone(),
                after: d.needs.clone(),
            })
            .collect();
        if drafts.is_empty()
            || drafts.len() > MAX_CHILDREN
            || drafts.iter().any(|d| !vibevalley_core::dag_id_valid(&d.id))
            || !vibevalley_core::dag_problems(&nodes).is_empty()
        {
            return Err(BoardError::Other(format!(
                "a split is 1 to {MAX_CHILDREN} children with ASCII ids whose needs form a DAG"
            )));
        }
        if drafts.iter().any(|d| d.acceptance && d.check.as_deref().unwrap_or("").trim().is_empty()) {
            return Err(BoardError::Other("an acceptance child needs a check command".into()));
        }
        if let Some(s) = self.on_board(&parent) {
            if s.phase.is_working() {
                return Err(BoardError::Other("the parent's session is working; split it when it rests".into()));
            }
            if let Some(wt) = s.worktree.as_deref().and_then(|w| Repo::discover(Path::new(w)).ok().flatten()) {
                wt.commit_all(&format!("Issue #{}: work before the split", parent.number))?;
            }
        }
        let agent_of_parent = parent.assigned_agent().unwrap_or("").to_string();
        for d in &drafts {
            let agent = d.agent.as_deref().unwrap_or(&agent_of_parent);
            if !agent.trim().is_empty() {
                self.drivers.check(agent)?;
            }
        }
        let mut ids: HashMap<String, String> = HashMap::new();
        let mut made = Vec::new();
        let at = now();
        for d in &drafts {
            let number = self.next("issue", state.issues.iter().map(|t| t.number).max().unwrap_or(0))?;
            let id = format!("i{number}");
            ids.insert(d.id.clone(), id.clone());
            let (title, description) = if d.title.trim().is_empty() {
                (d.brief.trim().to_string(), String::new())
            } else {
                (d.title.trim().to_string(), d.brief.trim().to_string())
            };
            let mut child = Issue::new(&id, number, title, at);
            child.description = description;
            child.repo = Some(repo.clone());
            child.parent = Some(parent.id.clone());
            child.priority = parent.priority;
            child.deliver = Deliverable::Change;
            child.blocked_by = d.needs.iter().filter_map(|n| ids.get(n).cloned()).collect();
            child.constraints = Some(IssueConstraints {
                acceptance: d.acceptance,
                scope: d.scope.clone(),
                frozen: vec![],
                check: d.check.clone().filter(|c| !c.trim().is_empty()),
            });
            child.queued_at = Some(at);
            let agent = d.agent.clone().unwrap_or_else(|| agent_of_parent.clone());
            if !agent.trim().is_empty() {
                child.assignments = vec![Assignment {
                    id: format!("{id}-a1"),
                    issue: id.clone(),
                    agent,
                    assigned_at: at,
                    ended_at: None,
                    executions: vec![],
                }];
            }
            made.push(id);
            self.apply(vec![Fact::issue_changed(at, child)])?;
        }
        self.refresh_queue_locked();
        Ok(made.iter().filter_map(|id| self.issue(id)).collect())
    }

    /// Children whose round is in review are checked and merged into their
    /// parent's branch. Ported from VibeValley `joinChildren`.
    fn join_children(&self) -> Result<()> {
        let reviewing: Vec<Issue> = self
            .state()
            .issues
            .into_iter()
            .filter(|t| t.parent.is_some() && t.stage.state == StageKind::Reviewing)
            .collect();
        for child in reviewing {
            self.join_one(&child)?;
        }
        Ok(())
    }

    fn join_one(&self, child: &Issue) -> Result<()> {
        let Some(parent) = child.parent.as_deref().and_then(|p| self.issue(p)) else {
            return Ok(());
        };
        if parent.status.is_closed() {
            return Ok(());
        }
        let Some(main) = self.main_repo(&parent)? else { return Ok(()) };
        let Some(session) = self.on_board(child) else { return Ok(()) };
        // The parent's session is busy in the parent's worktree: wait.
        if self.on_board(&parent).is_some_and(|s| s.phase.is_working()) {
            return Ok(());
        }
        let Some(place) = session.worktree.as_deref().and_then(|w| Repo::discover(Path::new(w)).ok().flatten()) else {
            return Ok(());
        };
        let all = self.state().issues;
        let checks = vibevalley_core::child_checks(child, &all);
        let parent_branch = issue_branch(parent.number);
        let verified = place
            .commit_all(&format!("Issue #{}: {}", child.number, child.title))
            .map_err(|e| e.to_string())
            .and_then(|_| verify_checkout(place.root(), &parent_branch, &checks));
        let frozen = match verified {
            Ok(frozen) => frozen,
            Err(why) => {
                self.update(&child.id, |t| {
                    t.questions = vec![Question {
                        question: why,
                        options: vec![],
                    }]
                })?;
                return Ok(());
            }
        };
        // Into the parent's checkout when it has one; else straight into its
        // branch, which nothing has checked out.
        let checkout = self.place_of(&parent, &main, false)?;
        if checkout.is_none() && !git::branch_exists(main.root(), &parent_branch)? {
            return Err(BoardError::Other(format!("issue #{} has no branch", parent.number)));
        }
        let branch = issue_branch(child.number);
        let check = match &checkout {
            Some(target) => target.merge_check(&branch)?,
            None => main.merge_check_between(&parent_branch, &branch)?,
        };
        match check {
            MergeCheck::Conflicts(files) => {
                let files: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
                let why = format!("Merging into {parent_branch} would conflict in {}", files.join(", "));
                let conflict = Conflict {
                    base: parent_branch.clone(),
                    files,
                };
                self.update(&child.id, |t| {
                    t.conflict = Some(conflict);
                    t.questions = vec![Question {
                        question: why,
                        options: vec![],
                    }];
                })?;
                return Ok(());
            }
            MergeCheck::UpToDate => {}
            MergeCheck::Clean => {
                let message = format!("Merge issue #{} into #{}", child.number, parent.number);
                match &checkout {
                    Some(target) => target.merge(&branch, Some(&message))?,
                    None => main.merge_into(&parent_branch, &branch, &message)?,
                };
            }
        }
        self.dismiss(&session.id, Workplace::Discard)?;
        self.update(&child.id, |t| {
            if let (Some(c), Some(frozen)) = (t.constraints.as_mut(), frozen) {
                c.frozen = frozen;
            }
            t.delivered = Some(Landing::MergedIntoParent);
            t.closed_at = Some(now());
            t.conflict = None;
            t.questions.clear();
        })?;
        Ok(())
    }

    // ----- drafting -----

    /// Sends a drafting session to write the issue up from `words`: it
    /// reads the code read-only and hands back a title, description,
    /// criteria and questions, which are written onto the issue. Ported from
    /// VibeValley `refinement.ts`.
    pub fn refine(&self, reference: &str, words: &str) -> Result<String> {
        self.refine_with(reference, words, "")
    }

    /// `refine`, with the issue's discussion so far for the drafting prompt.
    pub fn refine_with(&self, reference: &str, words: &str, discussion: &str) -> Result<String> {
        let _work = lock(&self.work);
        let issue = self.stored(reference)?;
        if issue.status != IssueStatus::Backlog {
            return Err(BoardError::Other("only an issue in the backlog is drafted".into()));
        }
        if let Some(r) = &issue.refining {
            return Err(BoardError::Refused(Refusal::Drafting { name: r.name.clone() }));
        }
        let drive = self.drivers.drafter(&issue)?;
        let (space, repo) = self.room(&issue, "");
        if space == 0 || repo == 0 {
            return Err(BoardError::NoRoom("no room for a drafting session".into()));
        }
        let main = self.main_repo(&issue)?;
        let (cwd, branch, base) = match &main {
            Some(main) => {
                let base = Self::main_branch(main)?;
                // Each draft starts from the main branch.
                let name = main.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let dir = self.config.worktrees_dir.join(format!("{name}.{}", issue.number));
                git::remove_worktree(main, &dir)?;
                git::delete_branch(main.root(), &issue_branch(issue.number))?;
                let (dir, branch) = self.workplace(main, issue.number, &base)?;
                (dir, Some(branch), Some(base))
            }
            None => {
                let dir = self.config.data_dir.join("contexts").join(&issue.id);
                std::fs::create_dir_all(&dir).map_err(io)?;
                (dir, None, None)
            }
        };
        let word = words.trim();
        let prompt = vibevalley_core::refine::refinement_brief(
            &issue.title,
            &issue.description,
            &issue.criteria,
            &issue.questions,
            word,
            issue.repo.as_deref(),
            discussion,
        );
        let number = self.next("session", 0)?;
        let mut session = Session::worker(format!("w{number}"), format!("{} (draft #{})", drive.name, issue.number), now());
        session.agent = drive.agent.clone();
        session.runtime = drive.runtime_id.clone();
        session.brief = format!("Draft: {}", issue.title);
        session.repo = issue.repo.clone();
        session.branch = branch;
        self.set_extra(&session.id, |e| e.base = base)?;
        session.worktree = Some(cwd.to_string_lossy().into_owned());
        session.issue = Some(issue.id.clone());
        session.refining = true;
        let issue = if issue.assigned_agent().is_none() && !drive.agent.is_empty() {
            let at = now();
            self.update(&issue.id, |t| {
                t.assignments.push(Assignment {
                    id: format!("{}-a{}", t.id, t.assignments.len() + 1),
                    issue: t.id.clone(),
                    agent: drive.agent.clone(),
                    assigned_at: at,
                    ended_at: None,
                    executions: vec![],
                })
            })?
        } else {
            issue
        };
        let trigger = runs::trigger_of(RunTriggerKind::Refine, Some(word.to_string()).filter(|w| !w.is_empty()));
        self.start_session(drive, session, &issue, prompt, false, trigger)
    }

    fn finish_draft(&self, session: &Session, issue: &Issue, reason: StopReason, said: &str, asked: &[Question]) {
        let read = if reason == StopReason::Completed {
            vibevalley_core::refine::parse_refinement(said)
        } else {
            Err(format!("the draft did not finish ({reason:?})"))
        };
        let (outcome, said_back) = match &read {
            Ok(draft) => (Outcome::Completed, draft.title.clone()),
            Err(problem) => (
                if reason == StopReason::Aborted {
                    Outcome::Interrupted
                } else {
                    Outcome::Failed
                },
                problem.clone(),
            ),
        };
        let _ = self.end_run(&session.id, outcome, &said_back, None);
        // What the issue's thread is told (refinement.ts `handedBack`).
        let name = |key: &str, extra: (&str, String)| vibevalley_i18n::t(key, &[("name", session.name.clone().into()), (extra.0, extra.1.into())]);
        let told = match read {
            Ok(draft) => {
                let mut questions = vibevalley_core::text::questions_from_text(said);
                questions.extend(asked.iter().cloned());
                let questions = vibevalley_core::refine::open_questions(&questions);
                let description = vibevalley_core::refine::refinement_description(&draft);
                let criteria = vibevalley_core::refine::kept(&draft.criteria);
                let mut parts = vec![draft.title.clone(), description.clone()];
                parts.extend(criteria.iter().cloned());
                parts.extend(questions.iter().map(|q| {
                    std::iter::once(q.question.clone())
                        .chain(q.options.iter().cloned())
                        .collect::<Vec<_>>()
                        .join("\n")
                }));
                if let Err(e) = self.update(&issue.id, |t| {
                    t.title = draft.title.clone();
                    t.description = description;
                    t.criteria = criteria;
                    t.questions = questions;
                }) {
                    eprintln!("vibevalley: draft of issue {}: {e}", issue.id);
                }
                parts.join("\n\n")
            }
            Err(problem) if reason == StopReason::Completed => name("server.issue.refinement.unread", ("problem", problem)),
            Err(_) => name("server.issue.refinement.unfinished", ("summary", vibevalley_core::text::summary_of(said))),
        };
        let _ = self.apply(vec![Fact::SessionReported(vibevalley_protocol::FactSessionReported {
            at: now(),
            id: session.id.clone(),
            run: None,
            outcome,
            phase: None,
            summary: told,
            runs: session.runs + 1,
            spent: None,
            questions: vec![],
            checks: vec![],
            answer: None,
        })]);
        // Not under `work`: a draft only touches its own issue and session.
        if let Err(e) = self.dismiss(&session.id, Workplace::Discard) {
            eprintln!("vibevalley: draft session {}: {e}", session.id);
        }
    }
}

/// What happens to a session's worktree when it leaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Workplace {
    /// Left as it is.
    Keep,
    /// Leftovers committed on the branch; worktree removed; branch kept
    /// when it has unmerged commits.
    KeepBranch,
    /// Worktree removed; branch deleted when nothing on it is unmerged
    /// (always, for a draft).
    Discard,
}

fn find<'a>(issues: &'a [Issue], reference: &str) -> Option<&'a Issue> {
    let r = reference.trim().trim_start_matches('#');
    issues.iter().find(|t| t.id == r || t.number.to_string() == r)
}

fn merge_check_into(main: &Repo, target: &str, branch: &str) -> Result<MergeCheck> {
    if !git::branch_exists(main.root(), branch)? {
        return Ok(MergeCheck::UpToDate);
    }
    Ok(main.merge_check_between(target, branch)?)
}

/// A child's checks run in its worktree, against the parent's branch.
/// Returns the files to freeze for an acceptance child. Ported from
/// VibeValley `verifyCheckout` (`modules/repo/repo.ts`).
fn verify_checkout(root: &Path, parent_branch: &str, checks: &CheckoutChecks) -> std::result::Result<Option<Vec<String>>, String> {
    let changed = || git::changed_files(root, parent_branch).map_err(|e| e.to_string());
    match checks {
        CheckoutChecks::Acceptance { check } => {
            if check.is_empty() {
                return Err("an acceptance child needs a check command".into());
            }
            if check::run_command(root, check).is_ok() {
                return Err(format!("The acceptance check `{check}` passed; it must fail before the feature is built."));
            }
            changed().map(Some)
        }
        CheckoutChecks::Plain { frozen, checks } => {
            let check_frozen = || -> std::result::Result<(), String> {
                let touched: Vec<String> = changed()?.into_iter().filter(|f| frozen.contains(f)).collect();
                if touched.is_empty() {
                    Ok(())
                } else {
                    Err(format!("These frozen acceptance files were changed: {}", touched.join(", ")))
                }
            };
            if !frozen.is_empty() {
                check_frozen()?;
            }
            for check in checks {
                if let Err(output) = check::run_command(root, check) {
                    return Err(format!("The check `{check}` failed:\n{output}"));
                }
            }
            if !frozen.is_empty() {
                check_frozen()?;
            }
            Ok(None)
        }
    }
}

fn text(s: &str) -> Vec<ContentBlock> {
    vec![ContentBlock::Text(s.to_string())]
}

fn default_words(issue: &Issue) -> String {
    match issue.stage.stuck {
        Some(StuckReason::Conflict) => {
            let base = issue.conflict.as_ref().map(|c| c.base.as_str()).unwrap_or("the base branch");
            format!(
                "Your branch conflicts with {base}. Merge {base} into your branch, resolve the conflicts, run the \
                 tests and commit."
            )
        }
        Some(StuckReason::Failed) => "The last round failed. Find out why, fix it and try again.".into(),
        Some(StuckReason::Interrupted) => "You were interrupted. Check `git status` and `git log`, then carry on.".into(),
        _ => "Carry on.".into(),
    }
}

/// What the agent is told to do.
fn brief(issue: &Issue, all: &[Issue], words: Option<&str>) -> String {
    let frozen: Vec<String> = vibevalley_core::acceptance_ancestors(issue, all)
        .iter()
        .flat_map(|t| t.constraints.as_ref().map(|c| c.frozen.clone()).unwrap_or_default())
        .collect();
    let brief = vibevalley_core::prompts::issue_brief(&issue.title, &issue.description, &issue.criteria, issue.deliver);
    let constraints = vibevalley_core::work_constraints(issue.constraints.as_ref(), &frozen);
    let brief = [brief, constraints].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
    match words.map(str::trim).filter(|w| !w.is_empty()) {
        Some(words) => format!("{words}{}", vibevalley_i18n::t("server.issue.brief.original", &[("brief", brief.into())])),
        None => brief,
    }
}
