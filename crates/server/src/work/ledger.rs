//! The board's one write path. Issues and sessions live in SQLite (`ServerDb`),
//! live ephemeral run telemetry lives in `LiveOverlay`, and commits mark dirty
//! slices on `SliceProjector` (and optionally enqueue durable notifications in
//! `Outbox`).
//!
//! Also here, because all three board modules (issue, session, workplace)
//! share them: the board's config, its error, and its counters.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::app::live::LiveOverlay;
use crate::app::outbox::Outbox;
use crate::app::slice::SliceProjector;
use crate::db::ServerDb;
use parking_lot::Mutex;
use sea_orm::{DatabaseConnection, DatabaseTransaction, DbErr};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_core::{BoardInput, LiveSnapshot, Refusal, SessionInput, SliceMask, derive_issues, overlay_sessions, project_board, project_sessions};
use vibevalley_protocol::{
    Assignment, Conflict, CriterionCheck, Execution, ExecutionPolicy, Finding, Issue, IssueAnswer, IssueCanceled, Landing, LastRun, Millis, Outcome, Phase,
    PullRequest, Question, Run, Session, SessionSubagents, SliceBundle,
};
use vibevalley_runtime::agent::durable::BoxFuture;
use vibevalley_runtime::oar::PermissionMode;

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
    Store(#[from] DbErr),
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
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

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

/// Every way an issue on the board changes after it is made, besides an
/// edit of its fields (`IssueStore::edit_async`). [`IssueChange::fold`] is the
/// one place each is written.
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
    pub(crate) fn dirty_mask(&self) -> SliceMask {
        let base = SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM;
        match self {
            IssueChange::Reopened
            | IssueChange::Delivered(_, _)
            | IssueChange::Conflicted(_)
            | IssueChange::Stuck { conflict: Some(_), .. }
            | IssueChange::MergedIntoParent { .. }
            | IssueChange::Started { .. } => base | SliceMask::SESSIONS,
            IssueChange::Queued
            | IssueChange::Unqueued
            | IssueChange::Revived
            | IssueChange::Answered
            | IssueChange::Canceled(_)
            | IssueChange::Stuck { conflict: None, .. }
            | IssueChange::ProjectChecked(_)
            | IssueChange::Reviewed(_)
            | IssueChange::Failed { .. }
            | IssueChange::Drafted { .. }
            | IssueChange::Reported { .. }
            | IssueChange::Assigned(_) => base,
        }
    }

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

/// Narrow SeaORM issue persistence port injected by `work/issue` so `work/ledger`
/// stays strictly below `work/issue` in the module DAG.
pub trait IssuePersistence: Send + Sync {
    fn all<'a>(&'a self, db: &'a DatabaseConnection) -> BoxFuture<'a, std::result::Result<Vec<Issue>, DbErr>>;
    fn get<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, std::result::Result<Option<Issue>, DbErr>>;
    fn put<'a>(&'a self, tx: &'a DatabaseTransaction, issue: &'a Issue) -> BoxFuture<'a, std::result::Result<(), DbErr>>;
    fn remove<'a>(&'a self, tx: &'a DatabaseTransaction, id: &'a str) -> BoxFuture<'a, std::result::Result<(), DbErr>>;
}

/// Narrow SeaORM session persistence & reopen-recovery port injected by
/// `work/session` so `work/ledger` stays strictly below `work/session`.
pub trait SessionPersistence: Send + Sync {
    fn all<'a>(&'a self, db: &'a DatabaseConnection) -> BoxFuture<'a, std::result::Result<Vec<Session>, DbErr>>;
    fn get<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, std::result::Result<Option<Session>, DbErr>>;
    fn past<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, std::result::Result<Option<Session>, DbErr>>;
    fn put<'a>(&'a self, tx: &'a DatabaseTransaction, s: &'a Session, departed: bool) -> BoxFuture<'a, std::result::Result<(), DbErr>>;
    fn put_subagents<'a>(&'a self, tx: &'a DatabaseTransaction, summary: &'a SessionSubagents) -> BoxFuture<'a, std::result::Result<(), DbErr>>;
    fn active_run<'a>(&'a self, tx: &'a DatabaseTransaction, session: &'a str, run: &'a str, root: &'a str) -> BoxFuture<'a, std::result::Result<bool, DbErr>>;
    fn run<'a>(&'a self, db: &'a DatabaseConnection, id: &'a str) -> BoxFuture<'a, std::result::Result<Option<Run>, DbErr>>;
    fn recoverable_ids<'a>(
        &'a self,
        db: &'a DatabaseConnection,
        durable: &'a vibevalley_runtime::agent::durable::Store,
        stored: &'a [Session],
    ) -> BoxFuture<'a, Result<HashSet<String>>>;
    fn interrupt_on_reopen<'a, 'tx>(
        &'a self,
        tx: &'a mut vibevalley_runtime::agent::durable::Tx<'tx>,
        session: &'a Session,
        at: Millis,
        summary: &'a str,
    ) -> BoxFuture<'a, vibevalley_runtime::agent::durable::Result<Option<ReopenInterrupt>>>
    where
        'tx: 'a;
}

pub struct Ledger {
    pub(crate) durable: vibevalley_runtime::agent::durable::Store,
    db: Arc<ServerDb>,
    live: Arc<LiveOverlay>,
    projector: Arc<SliceProjector>,
    outbox: Arc<Outbox>,
    issues: Arc<dyn IssuePersistence>,
    sessions: Arc<dyn SessionPersistence>,
    /// Held across every read-modify-write transaction of an issue or session.
    write: AsyncMutex<()>,
    cron_of_issue: Mutex<Option<CronOfIssue>>,
    pull_of_issue: Mutex<Option<PullOfIssue>>,
}

impl Ledger {
    /// The board as stored, without taking it: for reading while another
    /// process holds it.
    pub async fn snapshot_async(path: &Path, issues: &dyn IssuePersistence, sessions: &dyn SessionPersistence) -> Result<SliceBundle> {
        let server_db = ServerDb::open_config(&crate::db::DatabaseConfig::Sqlite { path: path.to_path_buf() })?;
        let stored_sessions = sessions.all(server_db.read_conn()).await?;
        let stored_issues = issues.all(server_db.read_conn()).await?;
        server_db.close_async().await;
        let derived_issues = derive_issues(&stored_issues, &stored_sessions);
        let live = LiveSnapshot::default();
        let board = project_board(
            &BoardInput {
                issues: derived_issues.clone(),
                sessions: stored_sessions.clone(),
                ..Default::default()
            },
            &live,
            0,
        );
        let sessions_slice = project_sessions(
            &SessionInput {
                sessions: stored_sessions,
                issues: derived_issues,
                ..Default::default()
            },
            &live,
            0,
        );
        Ok(SliceBundle {
            board: Some(board),
            sessions: Some(sessions_slice),
            ..Default::default()
        })
    }

    /// Opens the ledger against SQLite + spine primitives. A working session was
    /// interrupted: it rests now, its run counted. A session whose worktree is
    /// gone is dropped and its issue listed as lost.
    pub async fn open_async(
        db: Arc<ServerDb>,
        live: Arc<LiveOverlay>,
        projector: Arc<SliceProjector>,
        outbox: Arc<Outbox>,
        issue_store: Arc<dyn IssuePersistence>,
        session_store: Arc<dyn SessionPersistence>,
    ) -> Result<(Ledger, Opened)> {
        let durable = db.durable()?;
        let stored = session_store.all(db.read_conn()).await?;
        let recoverable_ids = session_store.recoverable_ids(db.read_conn(), &durable, &stored).await?;
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
                let (updated_session, run) = durable
                    .write_with_async((&session_store, session, at, summary, lost), |tx, ctx| {
                        let session_store = ctx.0.clone();
                        let mut session = ctx.1.clone();
                        let at = ctx.2;
                        let summary = ctx.3;
                        let lost = ctx.4;
                        Box::pin(async move {
                            let recovery = session_store.interrupt_on_reopen(tx, &session, at, summary).await?;
                            session.last_run = Some(LastRun {
                                needs_reconciliation: recovery.as_ref().is_some_and(|r| r.needs_reconciliation),
                                outcome: Outcome::Interrupted,
                                summary: summary.into(),
                                at,
                                spent: None,
                                answer: None,
                            });
                            if let Some(children) = &session.subagents {
                                session_store.put_subagents(tx.transaction(), children).await?;
                            }
                            session_store.put(tx.transaction(), &session, lost).await?;
                            Ok((session, recovery.map(|r| r.run_id)))
                        })
                    })
                    .await?;
                session = updated_session;
                if let Some(run) = run {
                    opened.interrupted.push((session.id.clone(), run));
                }
            } else if lost {
                durable
                    .write_with_async((&session_store, &session), |tx, &(session_store, session)| {
                        Box::pin(async move { Ok(session_store.put(tx.transaction(), session, true).await?) })
                    })
                    .await?;
            }
            if lost {
                opened.lost.extend(session.issue_id().map(String::from));
            } else {
                sessions.push(session);
            }
        }
        for (idx, session) in sessions.iter().enumerate() {
            if vibevalley_core::status::is_farm_worker(session) {
                let others: Vec<&Session> = sessions.iter().take(idx).collect();
                live.ensure_play_station(session, &others, None);
            }
        }
        projector.mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        let ledger = Ledger {
            durable,
            db,
            live,
            projector,
            outbox,
            issues: issue_store,
            sessions: session_store,
            write: AsyncMutex::new(()),
            cron_of_issue: Mutex::new(None),
            pull_of_issue: Mutex::new(None),
        };
        Ok((ledger, opened))
    }

    pub fn db(&self) -> &Arc<ServerDb> {
        &self.db
    }

    pub fn live(&self) -> &Arc<LiveOverlay> {
        &self.live
    }

    pub fn projector(&self) -> &Arc<SliceProjector> {
        &self.projector
    }

    pub fn outbox(&self) -> &Arc<Outbox> {
        &self.outbox
    }

    pub fn seq(&self) -> i64 {
        self.projector.seq()
    }

    pub fn mark_dirty(&self, dirty: SliceMask) -> i64 {
        self.projector.mark_dirty(dirty)
    }

    /// Registers the owner-backed `Issue.cron` projection and marks slices dirty.
    pub async fn use_cron_of_issue_async(&self, lookup: CronOfIssue) {
        *self.cron_of_issue.lock() = Some(lookup);
        self.projector.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
    }

    /// Registers the owner-backed `Issue.pull_request` projection and marks slices dirty.
    pub async fn use_pull_of_issue_async(&self, lookup: PullOfIssue) {
        *self.pull_of_issue.lock() = Some(lookup);
        self.projector.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
    }

    /// Re-projects `cron` and `pull_request` onto `id` without touching SQLite.
    pub async fn refresh_issue_async(&self, _id: &str) {
        self.projector.mark_dirty(SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM);
    }

    pub(crate) async fn read_db_async<R>(&self, query: impl AsyncFnOnce(&DatabaseConnection) -> std::result::Result<R, DbErr>) -> Result<R> {
        Ok(query(self.db.read_conn()).await?)
    }

    pub(crate) async fn write_db_async<R>(&self, query: impl AsyncFnOnce(&DatabaseConnection) -> std::result::Result<R, DbErr>) -> Result<R> {
        Ok(query(self.db.write_conn()).await?)
    }

    fn enrich_issue(&self, issue: &mut Issue) {
        if let Some(lookup) = self.cron_of_issue.lock().as_ref() {
            issue.cron = lookup(&issue.id);
        }
        if let Some(lookup) = self.pull_of_issue.lock().as_ref() {
            issue.pull_request = lookup(&issue.id);
        }
    }

    pub async fn raw_issues_async(&self) -> Result<Vec<Issue>> {
        let mut issues = self.issues.all(self.db.read_conn()).await?;
        for issue in &mut issues {
            self.enrich_issue(issue);
        }
        Ok(issues)
    }

    pub async fn sessions_async(&self) -> Result<Vec<Session>> {
        let stored = self.sessions.all(self.db.read_conn()).await?;
        let overlays = self.live.core_session_overlays();
        Ok(overlay_sessions(&stored, &overlays))
    }

    pub async fn issues_async(&self) -> Result<Vec<Issue>> {
        let (raw_issues, sessions) = tokio::try_join!(self.raw_issues_async(), self.sessions_async())?;
        Ok(derive_all_issues(&raw_issues, &sessions))
    }

    /// By id, number or `#number`.
    pub async fn issue_async(&self, reference: &str) -> Result<Option<Issue>> {
        let (raw_issues, sessions) = tokio::try_join!(self.raw_issues_async(), self.sessions_async())?;
        let Some(target) = find(&raw_issues, reference) else {
            return Ok(None);
        };
        let target_id = target.id.clone();
        let derived = derive_issues(&raw_issues, &sessions);
        if let Some(found) = derived.into_iter().find(|i| i.id == target_id) {
            return Ok(Some(found));
        }
        // Older closed issue trimmed from BoardSlice retention: derive alone.
        let single = derive_issues(std::slice::from_ref(target), &sessions);
        Ok(single.into_iter().next())
    }

    pub async fn session_async(&self, id: &str) -> Result<Option<Session>> {
        let Some(stored) = self.sessions.get(self.db.read_conn(), id).await? else {
            return Ok(None);
        };
        let overlays = self.live.core_session_overlays();
        Ok(overlay_sessions(&[stored], &overlays).into_iter().next())
    }

    /// A session that left the board, as it was when it did.
    pub async fn past_session_async(&self, id: &str) -> Option<Session> {
        self.sessions.past(self.db.read_conn(), id).await.ok().flatten()
    }

    /// `change` made to issue `id`; the issue as it is after.
    pub async fn change_async(&self, id: &str, change: IssueChange) -> Result<Issue> {
        self.change_commit_async(id, change, SliceMask::NONE, |_| Box::pin(async { Ok(()) })).await
    }

    pub(crate) async fn change_commit_async<F>(&self, id: &str, change: IssueChange, extra_dirty: SliceMask, also: F) -> Result<Issue>
    where
        F: for<'call, 'tx> FnOnce(&'call mut vibevalley_runtime::agent::durable::Tx<'tx>) -> BoxFuture<'call, vibevalley_runtime::agent::durable::Result<()>>
            + Send,
    {
        let dirty = change.dirty_mask() | extra_dirty;
        let id = {
            let _write = self.write.lock().await;
            let raw = self.raw_issues_async().await?;
            let mut issue = find(&raw, id).cloned().ok_or_else(|| BoardError::NoIssue(id.into()))?;
            let at = now();
            change.fold(&mut issue, at);
            let issue_id = issue.id.clone();
            let also = Mutex::new(Some(also));
            self.durable
                .write_with_async((self, &issue, &also), |tx, &(ledger, issue, also)| {
                    let also = also.lock().take().expect("change_commit_async calls once");
                    Box::pin(async move {
                        also(tx).await?;
                        ledger.issues.put(tx.transaction(), issue).await?;
                        Ok(())
                    })
                })
                .await?;
            self.projector.mark_dirty(dirty);
            issue_id
        };
        self.issue_async(&id).await?.ok_or(BoardError::NoIssue(id))
    }

    pub async fn put_issues_async(&self, issues: &[Issue]) -> Result<()> {
        let _write = self.write.lock().await;
        let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
        let issue_store = &self.issues;
        let (_, written_dirty) = self
            .db
            .write_dirty_with(BoardError::Store, |tx| {
                Box::pin(async move {
                    for issue in issues {
                        issue_store.put(tx, issue).await?;
                    }
                    Ok(((), dirty))
                })
            })
            .await?;
        self.projector.mark_dirty(written_dirty);
        Ok(())
    }

    pub async fn remove_issue_async(&self, id: &str) -> Result<()> {
        let _write = self.write.lock().await;
        let dirty = SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM;
        let issue_store = &self.issues;
        let (_, written_dirty) = self
            .db
            .write_dirty_with(BoardError::Store, |tx| {
                Box::pin(async move {
                    issue_store.remove(tx, id).await?;
                    Ok(((), dirty))
                })
            })
            .await?;
        self.projector.mark_dirty(written_dirty);
        Ok(())
    }

    pub(crate) async fn commit_tx_async<R>(
        &self,
        dirty: SliceMask,
        f: impl for<'call> FnOnce(&'call DatabaseTransaction, &'call dyn IssuePersistence, &'call dyn SessionPersistence) -> BoxFuture<'call, Result<(R, bool)>>
        + Send,
    ) -> Result<R>
    where
        R: Send,
    {
        let _write = self.write.lock().await;
        let issue_store = self.issues.as_ref();
        let session_store = self.sessions.as_ref();
        let ((result, wake_outbox), written_dirty) = self
            .db
            .write_dirty_with(BoardError::Store, |tx| {
                Box::pin(async move {
                    let (result, wake_outbox) = f(tx, issue_store, session_store).await?;
                    Ok(((result, wake_outbox), dirty))
                })
            })
            .await?;
        self.projector.mark_dirty(written_dirty);
        if wake_outbox {
            self.outbox.wake();
        }
        Ok(result)
    }

    pub(crate) async fn commit_durable_async<R>(
        &self,
        dirty: SliceMask,
        f: impl for<'call, 'tx> FnOnce(
            &'call mut vibevalley_runtime::agent::durable::Tx<'tx>,
            &'call dyn IssuePersistence,
            &'call dyn SessionPersistence,
        ) -> BoxFuture<'call, vibevalley_runtime::agent::durable::Result<(R, bool)>>
        + Send,
    ) -> Result<R>
    where
        R: Send,
    {
        let _write = self.write.lock().await;
        let f = Mutex::new(Some(f));
        let (result, wake_outbox) = self
            .durable
            .write_with_async((self, &f), |tx, &(ledger, f)| {
                let f = f.lock().take().expect("commit_durable_async calls once");
                Box::pin(async move { f(tx, ledger.issues.as_ref(), ledger.sessions.as_ref()).await })
            })
            .await?;
        self.projector.mark_dirty(dirty);
        if wake_outbox {
            self.outbox.wake();
        }
        Ok(result)
    }

    pub(crate) async fn update_subagents_async(
        &self,
        session_id: &str,
        run: &str,
        root: &str,
        observe: impl FnOnce(&Session) -> Option<SessionSubagents>,
    ) -> Result<()> {
        let _write = self.write.lock().await;
        let Some(current_session) = self.session_async(session_id).await? else {
            return Ok(());
        };
        let Some(summary) = observe(&current_session) else {
            return Ok(());
        };
        let current = self
            .durable
            .write_with_async((self, session_id, run, root, &summary), |tx, &(ledger, session_id, run, root, summary)| {
                Box::pin(async move {
                    let db = tx.transaction();
                    let active = ledger.sessions.active_run(db, session_id, run, root).await?;
                    if active {
                        ledger.sessions.put_subagents(db, summary).await?;
                    }
                    Ok(active)
                })
            })
            .await?;
        if current {
            self.live.update_session(session_id, |snap| {
                snap.subagents = Some(Some(summary));
            });
            self.projector
                .mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        }
        Ok(())
    }

    pub(crate) async fn reconcile_subagents_async(&self, session: &str, before: &SessionSubagents, after: SessionSubagents) -> Result<()> {
        let _write = self.write.lock().await;
        let stored = self.sessions.run(self.db.read_conn(), &before.run).await?;
        if !stored.is_some_and(|r| r.session == session && r.subagents.as_ref() == Some(before)) {
            return Ok(());
        }
        let matches_live = self.session_async(session).await?.is_some_and(|s| s.subagents.as_ref() == Some(before));
        self.durable
            .write_with_async((self, &after), |tx, &(ledger, after)| {
                Box::pin(async move { Ok(ledger.sessions.put_subagents(tx.transaction(), after).await?) })
            })
            .await?;
        if matches_live {
            self.live.update_session(session, |snap| {
                snap.subagents = Some(Some(after));
            });
            self.projector
                .mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        }
        Ok(())
    }

    /// The next number of `counter`, above `at_least`.
    pub async fn next_async(&self, counter: &str, at_least: i64) -> Result<i64> {
        let _write = self.write.lock().await;
        self.write_db_async(async |db| crate::db::next_seq_async(db, counter, at_least).await).await
    }
}

fn derive_all_issues(raw_issues: &[Issue], sessions: &[Session]) -> Vec<Issue> {
    let mut out = derive_issues(raw_issues, sessions);
    if out.len() < raw_issues.len() {
        let seen: HashSet<&str> = out.iter().map(|i| i.id.as_str()).collect();
        for issue in raw_issues {
            if !seen.contains(issue.id.as_str()) {
                out.extend(derive_issues(std::slice::from_ref(issue), sessions));
            }
        }
    }
    out
}
