//! The board's one write path. Issues and sessions are stored in
//! `vibevalley-store`, then folded into the state as facts (`Facts`: the
//! hub's `Core`, or a [`LocalFacts`] standing alone), and every subscriber
//! gets the new frame. The issue and session modules change an existing
//! issue only by an [`IssueChange`]; a new or edited issue and every session
//! change go out as protocol facts through [`Ledger::apply`].
//!
//! Also here, because all three board modules (issue, session, workplace)
//! share them: the board's config, its error, and its counters.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use vibevalley_core::{Applied, Core, Refusal};
use vibevalley_oar::PermissionMode;
use vibevalley_protocol::{
    Assignment, Conflict, CriterionCheck, Execution, Fact, Finding, Issue, IssueAnswer, IssueCanceled, Landing, LastRun, Millis, Outcome, Phase, Question,
    Session, SpaceState, StateFrame as Frame,
};
use vibevalley_store::Store;

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
    /// the default does not ask.
    pub permission: PermissionMode,
    pub model: Option<String>,
    /// A working session with no event for this long is quiet.
    pub quiet_after: Duration,
    /// Where repos live by name (`<work root>/repos`). When set, an issue's
    /// `repo` under it is kept as its name, and a bare name is looked for
    /// there; otherwise `repo` is a path.
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

    /// Next to the store.
    pub fn beside(store_path: &Path) -> BoardConfig {
        BoardConfig::under(store_path.parent().unwrap_or(Path::new(".")))
    }
}

pub(crate) fn now() -> Millis {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as Millis).unwrap_or(0)
}

pub(crate) fn io(e: std::io::Error) -> BoardError {
    BoardError::Other(e.to_string())
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// By id, number or `#number`.
pub(crate) fn find<'a>(issues: &'a [Issue], reference: &str) -> Option<&'a Issue> {
    let r = reference.trim().trim_start_matches('#');
    issues.iter().find(|t| t.id == r || t.number.to_string() == r)
}

/// Where the board's facts go and its state is read: the server's one
/// state (`Hub`) or, standing alone, a [`LocalFacts`]. `apply` folds a batch
/// as one commit (`Core.apply`); neither method may call back into the board.
pub trait Facts: Send + Sync {
    fn apply(&self, facts: Vec<Fact>) -> Applied;
    /// Calls `f` once with the state now.
    fn read(&self, f: &mut dyn FnMut(&SpaceState));
    fn frame(&self) -> Frame;
    /// One step of a session's work, in order, for its work log (the
    /// journal). Must not call back into the board.
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

/// Every way an issue on the board changes after it is made, besides an
/// edit of its fields (`Board::edit`). [`IssueChange::fold`] is the one place
/// each is written.
#[derive(Debug, Clone)]
pub enum IssueChange {
    /// Waits in todo to be sent.
    Queued,
    /// Leaves the queue.
    Unqueued,
    /// Sent back for another round: open again, its questions, conflict and
    /// review cleared.
    Reopened,
    /// A canceled issue comes back to the backlog.
    Revived,
    /// The user's words answer its questions and take back a reviewer's pass.
    Answered,
    /// Accepted and delivered.
    Delivered(Landing),
    /// Closed without delivering.
    Canceled(IssueCanceled),
    /// Merging it into `base` would conflict.
    Conflicted(Conflict),
    /// A child that could not merge into its parent: why, and the conflict
    /// when that was it.
    Stuck { why: String, conflict: Option<Conflict> },
    /// A child merged into its parent's branch; an acceptance child's files
    /// are frozen from now on.
    MergedIntoParent { frozen: Option<Vec<String>> },
    /// The reviewer passed it; every finding is resolved.
    Reviewed,
    /// The reviewer failed it with these findings (all of them, old and new).
    Failed { findings: Vec<Finding> },
    /// A drafting session wrote it up.
    Drafted {
        title: String,
        description: String,
        criteria: Vec<String>,
        questions: Vec<Question>,
    },
    /// A round's report: questions (none kept when interrupted), the
    /// helper's word on each criterion, and an answer.
    Reported {
        questions: Option<Vec<Question>>,
        checks: Vec<CriterionCheck>,
        answer: Option<IssueAnswer>,
    },
    /// Assigned to `agent` when nobody was (the drafter).
    Assigned(String),
    /// A session started working it: it leaves the queue, and a new worker
    /// is its current assignment's newest execution.
    Started { session: String, worker: bool },
}

impl IssueChange {
    pub fn fold(self, t: &mut Issue, at: Millis) {
        match self {
            IssueChange::Queued => t.queued_at = Some(at),
            IssueChange::Unqueued => t.queued_at = None,
            IssueChange::Reopened => {
                t.closed_at = None;
                t.delivered = None;
                t.canceled = None;
                t.questions.clear();
                t.conflict = None;
                t.reviewed_at = None;
                t.queued_at = Some(at);
            }
            IssueChange::Revived => {
                t.closed_at = None;
                t.canceled = None;
                t.queued_at = None;
            }
            IssueChange::Answered => {
                t.questions.clear();
                t.reviewed_at = None;
                t.queued_at = Some(at);
            }
            IssueChange::Delivered(landing) => {
                t.delivered = Some(landing);
                t.closed_at = Some(at);
                t.conflict = None;
                t.queued_at = None;
                t.questions.clear();
            }
            IssueChange::Canceled(why) => {
                t.canceled = Some(why);
                t.closed_at = Some(at);
                t.queued_at = None;
            }
            IssueChange::Conflicted(conflict) => t.conflict = Some(conflict),
            IssueChange::Stuck { why, conflict } => {
                if conflict.is_some() {
                    t.conflict = conflict;
                }
                t.questions = vec![Question {
                    question: why,
                    options: vec![],
                }];
            }
            IssueChange::MergedIntoParent { frozen } => {
                if let (Some(c), Some(frozen)) = (t.constraints.as_mut(), frozen) {
                    c.frozen = frozen;
                }
                t.delivered = Some(Landing::MergedIntoParent);
                t.closed_at = Some(at);
                t.conflict = None;
                t.questions.clear();
            }
            IssueChange::Reviewed => {
                t.reviewed_at = Some(at);
                for f in &mut t.findings {
                    f.resolved = true;
                }
            }
            IssueChange::Failed { findings } => {
                t.findings = findings;
                t.reviewed_at = None;
            }
            IssueChange::Drafted {
                title,
                description,
                criteria,
                questions,
            } => {
                t.title = title;
                t.description = description;
                t.criteria = criteria;
                t.questions = questions;
            }
            IssueChange::Reported { questions, checks, answer } => {
                if let Some(q) = questions {
                    t.questions = q;
                }
                if !checks.is_empty() {
                    t.checks = checks;
                }
                if answer.is_some() {
                    t.answer = answer;
                }
            }
            IssueChange::Assigned(agent) => t.assignments.push(Assignment {
                id: format!("{}-a{}", t.id, t.assignments.len() + 1),
                issue: t.id.clone(),
                agent,
                assigned_at: at,
                ended_at: None,
                executions: vec![],
            }),
            IssueChange::Started { session, worker } => {
                t.queued_at = None;
                if worker
                    && t.latest_session_id() != Some(&session)
                    && let Some(a) = t.assignments.iter_mut().rev().find(|a| a.ended_at.is_none())
                {
                    a.executions.push(Execution::Worker { session, started_at: at });
                }
            }
        }
    }
}

const ISSUE: &str = "issue";
const SESSION: &str = "issue-session";
/// Sessions that left, as they were when they did: an issue's history still names them.
const PAST_SESSION: &str = "issue-session-past";
const COUNTERS: (&str, &str) = ("issue-board", "counters");

/// What opening found that the board must still settle.
#[derive(Default)]
pub struct Opened {
    /// Sessions that were working when the last process ended.
    pub interrupted: Vec<String>,
    /// Issues whose session's worktree is gone.
    pub lost: Vec<String>,
    /// Drafting sessions cut short.
    pub drafts: Vec<String>,
}

pub struct Ledger {
    store: Arc<Store>,
    facts: Arc<dyn Facts>,
    /// Held across every apply and every read-modify-apply of an issue.
    write: Mutex<()>,
    /// Each subscriber's sender and a receiver to drop a stale frame with.
    subscribers: Mutex<Vec<(flume::Sender<Frame>, flume::Receiver<Frame>)>>,
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

fn put<T: Serialize>(store: &Store, kind: &str, id: &str, value: &T) -> Result<()> {
    Ok(store.put_doc(kind, id, &serde_json::to_value(value).unwrap_or_default())?)
}

impl Ledger {
    /// The board as stored, without taking it: for reading while another
    /// process holds it.
    pub fn snapshot(store: &Store) -> Result<Frame> {
        let (sessions, issues) = load(store)?;
        let facts = LocalFacts::default();
        facts.apply(loaded(sessions, issues));
        Ok(facts.frame())
    }

    /// Loads what is stored into `facts`. A working session was interrupted:
    /// it rests now, its run counted. A session whose worktree is gone is
    /// dropped and its issue listed as lost.
    pub fn open(store: Arc<Store>, facts: Arc<dyn Facts>) -> Result<(Ledger, Opened)> {
        let (stored, issues) = load(&store)?;
        let mut sessions = Vec::new();
        let mut opened = Opened::default();
        for mut session in stored {
            if session.worktree.as_deref().is_some_and(|w| !Path::new(w).exists()) {
                store.delete_doc(SESSION, &session.id)?;
                opened.lost.extend(session.issue.clone());
                continue;
            }
            if session.refining {
                opened.drafts.push(session.id.clone());
            }
            if session.phase.is_working() {
                opened.interrupted.push(session.id.clone());
                session.phase = Phase::resting();
                session.runs += 1;
                session.last_run = Some(LastRun {
                    outcome: Outcome::Interrupted,
                    summary: "Interrupted: VibeValley was closed while it worked".into(),
                    at: now(),
                    spent: None,
                    answer: None,
                });
                put(&store, SESSION, &session.id, &session)?;
            }
            sessions.push(session);
        }
        facts.apply(loaded(sessions, issues));
        let ledger = Ledger {
            store,
            facts,
            write: Mutex::new(()),
            subscribers: Mutex::new(Vec::new()),
        };
        Ok((ledger, opened))
    }

    /// The store, for the documents a module keeps of its own (a session's
    /// extras and runs, an issue's waiting words).
    pub(crate) fn store(&self) -> &Store {
        &self.store
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

    pub fn state(&self) -> SpaceState {
        self.read(SpaceState::clone)
    }

    /// By id, number or `#number`.
    pub fn issue(&self, reference: &str) -> Option<Issue> {
        self.read(|s| find(&s.issues, reference).cloned())
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        self.read(|s| s.sessions.iter().find(|s| s.id == id).cloned())
    }

    /// A session that left the board, as it was when it did.
    pub fn past_session(&self, id: &str) -> Option<Session> {
        let value = self.store.doc(PAST_SESSION, id).ok()??;
        serde_json::from_value(value).ok()
    }

    /// The newest frame after every change; a receiver that falls behind
    /// skips to the newest.
    pub fn subscribe(&self) -> flume::Receiver<Frame> {
        let (tx, rx) = flume::bounded(1);
        let _ = tx.try_send(self.facts.frame());
        lock(&self.subscribers).push((tx, rx.clone()));
        rx
    }

    /// One step of a session's work, for its log.
    pub fn log(&self, session: &str, step: Step) {
        self.facts.log(session, step);
    }

    /// Stores `facts`, folds them in as one commit and tells the subscribers.
    pub fn apply(&self, facts: Vec<Fact>) -> Result<()> {
        let _write = lock(&self.write);
        self.apply_locked(facts)
    }

    /// `change` made to issue `id`; the issue as it is after.
    pub fn change(&self, id: &str, change: IssueChange) -> Result<Issue> {
        self.change_with(id, change, |fact| vec![fact])
    }

    /// `change` made to issue `id`, committed as the facts `batch` makes
    /// around the issue's own.
    pub fn change_with(&self, id: &str, change: IssueChange, batch: impl FnOnce(Fact) -> Vec<Fact>) -> Result<Issue> {
        let id = {
            let _write = lock(&self.write);
            let mut issue = self.issue(id).ok_or_else(|| BoardError::NoIssue(id.into()))?;
            let at = now();
            change.fold(&mut issue, at);
            let id = issue.id.clone();
            self.apply_locked(batch(Fact::issue_changed(at, issue)))?;
            id
        };
        self.issue(&id).ok_or(BoardError::NoIssue(id))
    }

    fn apply_locked(&self, facts: Vec<Fact>) -> Result<()> {
        // Stored first, then published.
        for fact in &facts {
            match fact {
                Fact::IssueChanged(vibevalley_protocol::FactIssueChanged { issue, .. }) => put(&self.store, ISSUE, &issue.id, issue)?,
                Fact::IssueRemoved(vibevalley_protocol::FactIssueRemoved { id, .. }) => self.store.delete_doc(ISSUE, id)?,
                Fact::SessionLeft(vibevalley_protocol::FactSessionLeft { id, closed, .. }) => {
                    if let Some(mut past) = self.session(id) {
                        if let Some(closed) = closed {
                            past.phase = Phase::Closed(vibevalley_protocol::PhaseClosed { at: now(), closed: *closed });
                        }
                        put(&self.store, PAST_SESSION, id, &past)?;
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
                _ => None,
            };
            if let Some(id) = id
                && let Some(s) = self.session(id)
            {
                put(&self.store, SESSION, id, &s)?;
            }
        }
        let mut subscribers = lock(&self.subscribers);
        if !applied.transitions.is_empty() && !subscribers.is_empty() {
            let frame = self.facts.frame();
            subscribers.retain(|(tx, stale)| {
                let _ = stale.try_recv();
                !matches!(tx.try_send(frame.clone()), Err(flume::TrySendError::Disconnected(_)))
            });
        }
        Ok(())
    }

    /// The next number of `counter`, above `at_least`.
    pub fn next(&self, counter: &str, at_least: i64) -> Result<i64> {
        let _write = lock(&self.write);
        let mut counters = self.store.doc(COUNTERS.0, COUNTERS.1)?.unwrap_or_else(|| serde_json::json!({}));
        let n = counters[counter].as_i64().unwrap_or(0).max(at_least) + 1;
        counters[counter] = n.into();
        self.store.put_doc(COUNTERS.0, COUNTERS.1, &counters)?;
        Ok(n)
    }
}
