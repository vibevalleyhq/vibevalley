//! The board's one write path. Issues and sessions are stored in
//! SQLite tables in `server.db`, then folded into the state as facts (`Facts`: the
//! hub's `Core`, or a [`LocalFacts`] standing alone), and every subscriber
//! gets the new frame. The issue and session modules change an existing
//! issue only by an [`IssueChange`]; a new or edited issue and every session
//! change go out as protocol facts through [`Ledger::apply`].
//!
//! Also here, because all three board modules (issue, session, workplace)
//! share them: the board's config, its error, and its counters.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::base::ServerDb;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use vibevalley_core::{Applied, Core, Refusal};
use vibevalley_protocol::{
    Assignment, Conflict, CriterionCheck, Execution, ExecutionPolicy, Fact, Finding, Issue, IssueAnswer, IssueCanceled, Landing, LastRun, Millis, Outcome,
    Phase, PullRequest, Question, Run, Session, SessionSubagents, SliceBundle, SpaceState,
};
use vibevalley_runtime::agent::durable::Sqlite;
use vibevalley_runtime::oar::PermissionMode;

pub use crate::ports::Facts;

#[derive(Debug, thiserror::Error)]
pub enum BoardError {
    #[error("durable: {0}")]
    Durable(#[from] vibevalley_runtime::agent::durable::Error),
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
    Agent(#[from] vibevalley_runtime::oar::AgentError),
    #[error("git: {0}")]
    Git(#[from] vibevalley_git::GitError),
    #[error("store: {0}")]
    Store(#[from] sqlx::Error),
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

pub(crate) use crate::now;

pub(crate) fn io(e: std::io::Error) -> BoardError {
    BoardError::Other(e.to_string())
}

/// By id, number or `#number`.
pub(crate) fn find<'a>(issues: &'a [Issue], reference: &str) -> Option<&'a Issue> {
    let r = reference.trim().trim_start_matches('#');
    issues.iter().find(|t| t.id == r || t.number.to_string() == r)
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
    Agent(vibevalley_runtime::oar::Event),
}

/// A state of the board's own, for a board without a server.
#[derive(Default)]
pub struct LocalFacts(Mutex<Core>);

impl Facts for LocalFacts {
    fn apply(&self, facts: Vec<Fact>) -> Applied {
        self.0.lock().apply(facts)
    }

    fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
        f(self.0.lock().state())
    }

    fn bundle(&self) -> SliceBundle {
        self.0.lock().slice_bundle(vec![])
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
    Delivered(Landing, Option<String>),
    /// Closed without delivering.
    Canceled(IssueCanceled),
    /// Merging it into `base` would conflict.
    Conflicted(Conflict),
    /// A child that could not merge into its parent: why, and the conflict
    /// when that was it.
    Stuck {
        why: String,
        conflict: Option<Conflict>,
    },
    /// A child merged into its parent's branch; an acceptance child's files
    /// are frozen from now on.
    MergedIntoParent {
        frozen: Option<Vec<String>>,
    },
    /// The reviewer passed it; every finding is resolved.
    Reviewed(Option<vibevalley_protocol::ReviewRevision>),
    ProjectChecked(vibevalley_protocol::ProjectCheckReceipt),
    /// The reviewer failed it with these findings (all of them, old and new).
    Failed {
        findings: Vec<Finding>,
    },
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
    Started {
        session: String,
        worker: bool,
    },
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
            IssueChange::Delivered(landing, commit) => {
                if let Some(id) = commit {
                    t.delivery_evidence.get_or_insert_with(Default::default).merged_commit = Some(id);
                }
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
            IssueChange::ProjectChecked(receipt) => {
                t.delivery_evidence.get_or_insert_with(Default::default).check = Some(receipt);
            }
            IssueChange::Reviewed(revision) => {
                if let Some(revision) = revision {
                    let evidence = t.delivery_evidence.get_or_insert_with(Default::default);
                    if evidence.reviews.last().is_none_or(|r| r.revision != revision) {
                        evidence.reviews.push(vibevalley_protocol::CodeReview { at, revision });
                    }
                }
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
            IssueChange::Assigned(agent) => {
                if let Some(c) = t.assignments.iter_mut().rev().find(|a| a.ended_at.is_none()) {
                    c.ended_at = Some(at);
                }
                t.assignments.push(Assignment {
                    id: format!("{}-a{}", t.id, t.assignments.len() + 1),
                    issue: t.id.clone(),
                    agent,
                    assigned_at: at,
                    ended_at: None,
                    executions: vec![],
                });
            }
            IssueChange::Started { session, worker } => {
                t.queued_at = None;
                if worker {
                    t.questions.clear();
                    t.reviewed_at = None;
                    if t.latest_session_id() != Some(&session)
                        && let Some(a) = t.assignments.iter_mut().rev().find(|a| a.ended_at.is_none())
                    {
                        a.executions.push(Execution::Worker { session, started_at: at });
                    }
                }
            }
        }
    }
}

/// What opening found that the board must still settle.
#[derive(Default)]
pub struct Opened {
    /// Sessions and their interrupted runs for the work log.
    pub interrupted: Vec<(String, String)>,
    pub recoverable: Vec<String>,
    /// Issues whose session's worktree is gone.
    pub lost: Vec<String>,
    /// Drafting sessions cut short.
    pub drafts: Vec<String>,
}

pub type CronOfIssue = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type PullOfIssue = Arc<dyn Fn(&str) -> Option<PullRequest> + Send + Sync>;

/// Result of interrupting a working session's open run when reopening the ledger.
pub struct ReopenInterrupt {
    pub run_id: String,
    pub needs_reconciliation: bool,
}

/// Narrow SQLite issue persistence port injected by `work/issue` so `work/ledger`
/// stays strictly below `work/issue` in the module DAG.
pub trait IssueStore: Send + Sync {
    fn all(&self, db: &Sqlite<'_>) -> sqlx::Result<Vec<Issue>>;
    fn put(&self, db: &Sqlite<'_>, issue: &Issue) -> sqlx::Result<()>;
    fn remove(&self, db: &Sqlite<'_>, id: &str) -> sqlx::Result<()>;
}

/// Narrow SQLite session persistence & reopen-recovery port injected by
/// `work/session` so `work/ledger` stays strictly below `work/session`.
pub trait SessionStore: Send + Sync {
    fn all(&self, db: &Sqlite<'_>) -> sqlx::Result<Vec<Session>>;
    fn past(&self, db: &Sqlite<'_>, id: &str) -> sqlx::Result<Option<Session>>;
    fn put(&self, db: &Sqlite<'_>, s: &Session, departed: bool) -> sqlx::Result<()>;
    fn put_subagents(&self, db: &Sqlite<'_>, summary: &SessionSubagents) -> sqlx::Result<()>;
    fn active_run(&self, db: &Sqlite<'_>, session: &str, run: &str, root: &str) -> sqlx::Result<bool>;
    fn run(&self, db: &Sqlite<'_>, id: &str) -> sqlx::Result<Option<Run>>;
    fn recoverable_ids(&self, db: &Sqlite<'_>, durable: &vibevalley_runtime::agent::durable::Store, stored: &[Session]) -> Result<HashSet<String>>;
    fn interrupt_on_reopen(
        &self,
        tx: &mut vibevalley_runtime::agent::durable::Tx<'_>,
        session: &Session,
        at: Millis,
        summary: &str,
    ) -> vibevalley_runtime::agent::durable::Result<Option<ReopenInterrupt>>;
}

pub struct Ledger {
    pub(crate) durable: vibevalley_runtime::agent::durable::Store,
    db: Arc<ServerDb>,
    issues: Arc<dyn IssueStore>,
    sessions: Arc<dyn SessionStore>,
    facts: Arc<dyn Facts>,
    /// Held across every apply and every read-modify-apply of an issue.
    write: Mutex<()>,
    cron_of_issue: Mutex<Option<CronOfIssue>>,
    pull_of_issue: Mutex<Option<PullOfIssue>>,
}

fn loaded(sessions: Vec<Session>, issues: Vec<Issue>) -> Vec<Fact> {
    let at = now();
    let mut facts: Vec<Fact> = sessions.into_iter().map(|session| Fact::session_changed(at, session)).collect();
    facts.extend(issues.into_iter().map(|issue| Fact::issue_changed(at, issue)));
    facts
}

impl Ledger {
    /// The board as stored, without taking it: for reading while another
    /// process holds it.
    pub fn snapshot(path: &Path, issues: &dyn IssueStore, sessions: &dyn SessionStore) -> Result<SliceBundle> {
        let server_db = ServerDb::open_at(path)?;
        let mut conn = server_db.acquire()?;
        let db = Sqlite::new(&mut conn);
        let stored_sessions = sessions.all(&db)?;
        let stored_issues = issues.all(&db)?;
        drop(conn);
        let facts = LocalFacts::default();
        facts.apply(loaded(stored_sessions, stored_issues));
        Ok(facts.bundle())
    }

    /// Loads what is stored into `facts`. A working session was interrupted:
    /// it rests now, its run counted. A session whose worktree is gone is
    /// dropped and its issue listed as lost.
    pub fn open(db: Arc<ServerDb>, facts: Arc<dyn Facts>, issue_store: Arc<dyn IssueStore>, session_store: Arc<dyn SessionStore>) -> Result<(Ledger, Opened)> {
        let durable = db.durable()?;
        let (stored, issues, recoverable_ids) = {
            let mut conn = db.acquire()?;
            let sqlite = Sqlite::new(&mut conn);
            let stored = session_store.all(&sqlite)?;
            let issues = issue_store.all(&sqlite)?;
            let recoverable_ids = session_store.recoverable_ids(&sqlite, &durable, &stored)?;
            (stored, issues, recoverable_ids)
        };
        let mut sessions = Vec::new();
        let mut opened = Opened::default();
        for mut session in stored {
            let lost = session.machine.is_none()
                && matches!(session.policy, ExecutionPolicy::ManagedWorktree { .. })
                && session.cwd.as_deref().is_some_and(|w| !Path::new(w).exists());
            if !lost && session.is_refining() {
                opened.drafts.push(session.id.clone());
            }
            if session.phase.is_working() && !lost && !session.is_refining() && recoverable_ids.contains(&session.id) {
                opened.recoverable.push(session.id.clone());
            } else if session.phase.is_working() {
                let at = now();
                let summary = "Interrupted: VibeValley was closed while it worked";
                if let Some(children) = &mut session.subagents {
                    children.disconnected_at.get_or_insert(at);
                }
                session.phase = Phase::resting();
                session.runs += 1;
                let run = durable.write(|tx| {
                    let recovery = session_store.interrupt_on_reopen(tx, &session, at, summary)?;
                    session.last_run = Some(LastRun {
                        needs_reconciliation: recovery.as_ref().is_some_and(|r| r.needs_reconciliation),
                        outcome: Outcome::Interrupted,
                        summary: summary.into(),
                        at,
                        spent: None,
                        answer: None,
                    });
                    if let Some(children) = &session.subagents {
                        session_store.put_subagents(tx.connection(), children)?;
                    }
                    session_store.put(tx.connection(), &session, lost)?;
                    Ok(recovery.map(|r| r.run_id))
                })?;
                if let Some(run) = run {
                    opened.interrupted.push((session.id.clone(), run));
                }
            } else if lost {
                let mut conn = db.acquire()?;
                session_store.put(&Sqlite::new(&mut conn), &session, true)?;
            }
            if lost {
                opened.lost.extend(session.issue_id().map(String::from));
            } else {
                sessions.push(session);
            }
        }
        facts.apply(loaded(sessions, issues));
        let ledger = Ledger {
            durable,
            db,
            issues: issue_store,
            sessions: session_store,
            facts,
            write: Mutex::new(()),
            cron_of_issue: Mutex::new(None),
            pull_of_issue: Mutex::new(None),
        };
        Ok((ledger, opened))
    }

    /// Registers the owner-backed `Issue.cron` projection and syncs current issues.
    pub fn use_cron_of_issue(&self, lookup: CronOfIssue) {
        let _write = self.write.lock();
        *self.cron_of_issue.lock() = Some(lookup.clone());
        let at = now();
        let mut facts = Vec::new();
        for mut issue in self.state().issues {
            let next = lookup(&issue.id);
            if issue.cron != next {
                issue.cron = next;
                facts.push(Fact::issue_changed(at, issue));
            }
        }
        if !facts.is_empty() {
            self.publish(facts);
        }
    }

    /// Registers the owner-backed `Issue.pull_request` projection and syncs current issues.
    pub fn use_pull_of_issue(&self, lookup: PullOfIssue) {
        let _write = self.write.lock();
        *self.pull_of_issue.lock() = Some(lookup.clone());
        let at = now();
        let mut facts = Vec::new();
        for mut issue in self.state().issues {
            let next = lookup(&issue.id);
            if issue.pull_request != next {
                issue.pull_request = next;
                facts.push(Fact::issue_changed(at, issue));
            }
        }
        if !facts.is_empty() {
            self.publish(facts);
        }
    }

    /// Re-projects `cron` and `pull_request` onto `id` from their owners without touching SQLite.
    pub fn refresh_issue(&self, id: &str) {
        let _write = self.write.lock();
        let Some(mut issue) = self.issue(id) else { return };
        let mut changed = false;
        if let Some(lookup) = self.cron_of_issue.lock().clone() {
            let next = lookup(&issue.id);
            if issue.cron != next {
                issue.cron = next;
                changed = true;
            }
        }
        if let Some(lookup) = self.pull_of_issue.lock().clone() {
            let next = lookup(&issue.id);
            if issue.pull_request != next {
                issue.pull_request = next;
                changed = true;
            }
        }
        if changed {
            self.publish(vec![Fact::issue_changed(now(), issue)]);
        }
    }

    pub(crate) fn database<R>(&self, query: impl FnOnce(&Sqlite<'_>) -> sqlx::Result<R>) -> Result<R> {
        let mut conn = self.db.acquire()?;
        Ok(query(&Sqlite::new(&mut conn))?)
    }

    pub fn bundle(&self) -> SliceBundle {
        self.facts.bundle()
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
        self.database(|db| self.sessions.past(db, id)).ok().flatten()
    }

    /// Stores `facts`, folds them in as one commit.
    pub fn apply(&self, facts: Vec<Fact>) -> Result<()> {
        let _write = self.write.lock();
        self.apply_locked(facts, |_| Ok(()))
    }

    /// `change` made to issue `id`; the issue as it is after.
    pub fn change(&self, id: &str, change: IssueChange) -> Result<Issue> {
        self.change_with(id, change, |fact| vec![fact])
    }

    /// `change` made to issue `id`, committed as the facts `batch` makes
    /// around the issue's own.
    pub fn change_with(&self, id: &str, change: IssueChange, batch: impl FnOnce(Fact) -> Vec<Fact>) -> Result<Issue> {
        self.change_commit(id, change, batch, |_| Ok(()))
    }

    pub(crate) fn change_commit(
        &self,
        id: &str,
        change: IssueChange,
        batch: impl FnOnce(Fact) -> Vec<Fact>,
        also: impl FnOnce(&mut vibevalley_runtime::agent::durable::Tx<'_>) -> vibevalley_runtime::agent::durable::Result<()>,
    ) -> Result<Issue> {
        let id = {
            let _write = self.write.lock();
            let mut issue = self.issue(id).ok_or_else(|| BoardError::NoIssue(id.into()))?;
            let at = now();
            change.fold(&mut issue, at);
            let id = issue.id.clone();
            self.apply_locked(batch(Fact::issue_changed(at, issue)), also)?;
            id
        };
        self.issue(&id).ok_or(BoardError::NoIssue(id))
    }

    fn apply_locked(
        &self,
        facts: Vec<Fact>,
        also: impl FnOnce(&mut vibevalley_runtime::agent::durable::Tx<'_>) -> vibevalley_runtime::agent::durable::Result<()>,
    ) -> Result<()> {
        let mut prospective = self.state();
        self.durable.write(|write| {
            also(write)?;
            let tx = write.connection();
            for fact in &facts {
                match fact {
                    Fact::IssueChanged(vibevalley_protocol::FactIssueChanged { issue, .. }) => self.issues.put(tx, issue)?,
                    Fact::IssueRemoved(vibevalley_protocol::FactIssueRemoved { id, .. }) => self.issues.remove(tx, id)?,
                    Fact::SessionSubagentsChanged(f) => {
                        if let Some(summary) = &f.subagents {
                            self.sessions.put_subagents(tx, summary)?;
                        }
                    }
                    Fact::SessionLeft(vibevalley_protocol::FactSessionLeft { id, closed, at, .. }) => {
                        if let Some(mut past) = prospective.sessions.iter().find(|s| &s.id == id).cloned() {
                            if let Some(closed) = closed {
                                past.phase = Phase::Closed(vibevalley_protocol::PhaseClosed { at: *at, closed: *closed });
                            }
                            self.sessions.put(tx, &past, true)?;
                        }
                    }
                    _ => {}
                }
                vibevalley_core::reduce(&mut prospective, fact);
                let id = match fact {
                    Fact::SessionChanged(vibevalley_protocol::FactSessionChanged { session, .. }) => Some(&session.id),
                    Fact::SessionPhaseChanged(vibevalley_protocol::FactSessionPhaseChanged { id, .. })
                    | Fact::SessionReported(vibevalley_protocol::FactSessionReported { id, .. }) => Some(id),
                    _ => None,
                };
                if let Some(id) = id
                    && let Some(session) = prospective.sessions.iter().find(|s| &s.id == id)
                {
                    self.sessions.put(tx, session, false)?;
                }
            }
            Ok(())
        })?;
        self.publish(facts);
        Ok(())
    }

    fn publish(&self, facts: Vec<Fact>) {
        self.facts.apply(facts);
    }

    pub(crate) fn update_subagents(
        &self,
        session_id: &str,
        run: &str,
        root: &str,
        observe: impl FnOnce(&Session) -> Option<vibevalley_protocol::FactSessionSubagentsChanged>,
    ) -> Result<()> {
        let _write = self.write.lock();
        let Some(fact) = self.session(session_id).as_ref().and_then(observe) else {
            return Ok(());
        };
        let current = self.durable.write(|tx| {
            let db = tx.connection();
            let active = self.sessions.active_run(db, session_id, run, root)?;
            if active && let Some(summary) = &fact.subagents {
                self.sessions.put_subagents(db, summary)?;
            }
            Ok(active)
        })?;
        if current {
            self.publish(vec![Fact::SessionSubagentsChanged(fact)]);
        }
        Ok(())
    }

    pub(crate) fn reconcile_subagents(
        &self,
        session: &str,
        before: &vibevalley_protocol::SessionSubagents,
        after: vibevalley_protocol::SessionSubagents,
    ) -> Result<()> {
        let _write = self.write.lock();
        let stored = self.database(|db| self.sessions.run(db, &before.run))?;
        if !stored.is_some_and(|r| r.session == session && r.subagents.as_ref() == Some(before)) {
            return Ok(());
        }
        if self.session(session).is_some_and(|s| s.subagents.as_ref() == Some(before)) {
            let fact = vibevalley_protocol::FactSessionSubagentsChanged {
                at: now(),
                id: session.into(),
                subagents: Some(after),
            };
            self.apply_locked(vec![Fact::SessionSubagentsChanged(fact)], |_| Ok(()))
        } else {
            self.durable.write(|tx| Ok(self.sessions.put_subagents(tx.connection(), &after)?))?;
            Ok(())
        }
    }

    /// The next number of `counter`, above `at_least`.
    pub fn next(&self, counter: &str, at_least: i64) -> Result<i64> {
        let _write = self.write.lock();
        self.database(|db| crate::db::next_seq(db, counter, at_least))
    }
}
