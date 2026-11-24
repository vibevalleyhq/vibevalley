//! Pure agent execution runtime (`runtime/`): session engine, event trajectories,
//! durable delivery mailboxes, and git worktree management.
//!
//! Has zero compile-time dependency on `crate::agent` or `crate::issue`:
//! `agent/` implements [`SessionDriver`] and injects it at boot.

pub mod session;
pub mod worktree;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use vibevalley_core::{Refusal, SliceMask, derive_issues};
use vibevalley_protocol::{
    ApiError, Assignment, Conflict, CriterionCheck, Execution, ExecutionPolicy, Finding, Issue, IssueAnswer, IssueCanceled, IssueGetInput, Landing, LastRun,
    Millis, Outcome, Phase, Question, Run, Session, SessionBindingInput, SessionChildTranscript, SessionChildTranscriptInput, SessionController,
    SessionEventListInput, SessionEventPage, SessionOpenWorkspaceInput, SessionRespondInteractionInput, SessionRespondPermissionInput, SessionSendInput,
    SessionSetConfigInput, SessionWatchPayload, SessionWorkspace,
};
use vibevalley_runtime::oar::{PermissionMode, Registry};

pub use session::{
    ANSWER_ONLY, AgentProfileInfo, DraftEnd, Drive, HelperPlace, Hire, Journal, MailboxEntry, MailboxSource, MailboxStatus, News, Persona, Report,
    ReportQuestion, ReportStatus, Rounds, RuntimeDriver, SessionDriver, SessionEngine, SessionLifecycleEvent, Trajectory, WorkspaceSnapshot, trigger_of,
};
pub(crate) use session::{OUTBOX_SESSION_REPORTED, OutboxSessionReported};
pub use worktree::{Changes, Delivery, Joined, Landed, Leave, Leaving, OnDisk, Worktree, issue_branch};

use crate::context::{Context, now};
use crate::db::DbError;
use crate::storage::Storage;

/// Errors returned by [`Runtime`], [`Worktree`], and [`crate::issue::Board`].
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
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
    Store(#[from] DbError),
    #[error("{0}")]
    Other(String),
    /// A refusal already worded for the endpoint (from a [`SessionDriver`]).
    #[error("{}", .0.message)]
    Api(ApiError),
}

pub type BoardError = RuntimeError;
pub type Result<T> = std::result::Result<T, RuntimeError>;

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

/// Configuration for the execution runtime, worktree layout, and concurrency limits.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
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

pub type BoardConfig = RuntimeConfig;

impl RuntimeConfig {
    pub fn under(dir: &Path) -> RuntimeConfig {
        RuntimeConfig {
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
    pub fn beside(store_path: &Path) -> RuntimeConfig {
        RuntimeConfig::under(store_path.parent().unwrap_or(Path::new(".")))
    }
}

pub(crate) fn io(e: std::io::Error) -> RuntimeError {
    RuntimeError::Other(e.to_string())
}

/// By id, number or `#number`.
pub(crate) fn find_issue<'a>(issues: &'a [Issue], reference: &str) -> Option<&'a Issue> {
    let r = reference.trim().trim_start_matches('#');
    issues.iter().find(|t| t.id == r || t.number.to_string() == r)
}

pub(crate) fn derive_all_issues(raw_issues: &[Issue], sessions: &[Session]) -> Vec<Issue> {
    let mut out = derive_issues(raw_issues, sessions);
    if out.len() < raw_issues.len() {
        let seen: HashSet<String> = out.iter().map(|i| i.id.clone()).collect();
        for issue in raw_issues {
            if !seen.contains(&issue.id) {
                out.extend(derive_issues(std::slice::from_ref(issue), sessions));
            }
        }
    }
    out
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
/// edit of its fields (`Board::edit_async`). [`IssueChange::fold`] is the
/// one place each is written.
#[derive(Debug, Clone)]
pub enum IssueChange {
    Queued,
    Unqueued,
    Reopened,
    Revived,
    Answered,
    Delivered(Landing, Option<String>),
    Canceled(IssueCanceled),
    Conflicted(Conflict),
    Stuck {
        why: String,
        conflict: Option<Conflict>,
    },
    MergedIntoParent {
        frozen: Option<Vec<String>>,
    },
    Reviewed(Option<vibevalley_protocol::ReviewRevision>),
    ProjectChecked(vibevalley_protocol::ProjectCheckReceipt),
    Failed {
        findings: Vec<Finding>,
    },
    Drafted {
        title: String,
        description: String,
        criteria: Vec<String>,
        questions: Vec<Question>,
    },
    Reported {
        questions: Option<Vec<Question>>,
        checks: Vec<CriterionCheck>,
        answer: Option<IssueAnswer>,
    },
    Assigned(String),
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

/// Reopens stored sessions on server boot: interrupts active non-recoverable runs,
/// marks lost worktrees as departed, and seeds live farm stations.
pub async fn reopen_sessions_async(ctx: &Arc<Context>) -> Result<Opened> {
    let durable = ctx.service.durable()?;
    let stored = ctx.service.session.all().await?;
    let all_extras = ctx.service.session.extras().await?;
    let mut recoverable_ids = HashSet::new();
    for s in &stored {
        if s.phase.is_working()
            && !s.is_refining()
            && s.runtime == vibevalley_runtime::agent::runtime::ID
            && let Some(extra) = all_extras.get(&s.id)
            && let (Some(run_id), Some(vendor)) = (extra.run.as_deref(), extra.agent_session.as_deref())
        {
            let conv = vibevalley_runtime::agent::harness::worker_conversation(vendor);
            let req = format!("work:{run_id}");
            if durable
                .read_with_async((conv.as_str(), req.as_str()), |tx, &(conv, req)| {
                    Box::pin(tx.submission_by_request_async(conv, req))
                })
                .await?
                .is_some()
            {
                recoverable_ids.insert(s.id.clone());
            }
        }
    }

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
            let session_svc = ctx.service.session.clone();
            let (updated_session, run) = durable
                .write_with_async((session_svc, session, at, summary, lost), |tx, state| {
                    let session_svc = state.0.clone();
                    let mut session = state.1.clone();
                    let at = state.2;
                    let summary = state.3;
                    let lost = state.4;
                    Box::pin(async move {
                        let extras = session_svc.extras_in_tx(tx.transaction()).await.map_err(DbError::into_durable_error)?;
                        let recovery = session::delivery::interrupt_on_reopen(&session_svc, tx, &session, extras.get(&session.id), at, summary).await?;
                        session.last_run = Some(LastRun {
                            needs_reconciliation: recovery.as_ref().is_some_and(|(_, rec)| *rec),
                            outcome: Outcome::Interrupted,
                            summary: summary.into(),
                            at,
                            spent: None,
                            answer: None,
                        });
                        if let Some(children) = &session.subagents {
                            session_svc
                                .put_subagents_in_tx(tx.transaction(), children)
                                .await
                                .map_err(DbError::into_durable_error)?;
                        }
                        session_svc
                            .put_in_tx(tx.transaction(), &session, lost)
                            .await
                            .map_err(DbError::into_durable_error)?;
                        Ok((session, recovery.map(|(run_id, _)| run_id)))
                    })
                })
                .await?;
            session = updated_session;
            if let Some(run) = run {
                opened.interrupted.push((session.id.clone(), run));
            }
        } else if lost {
            ctx.service.session.put(&session, true).await?;
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
            ctx.live.ensure_play_station(session, &others, None);
        }
    }
    ctx.mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
    Ok(opened)
}

/// Top-level facade grouping the session engine, trajectory logger, and worktree manager.
pub struct Runtime {
    ctx: Arc<Context>,
    session: SessionEngine,
    trajectory: Arc<Trajectory>,
    worktree: Arc<Worktree>,
}

impl Runtime {
    /// Opens the execution runtime on `ctx` with the given `drivers` and `config`.
    /// Runs reopen recovery and returns `(Arc<Runtime>, Opened)` so `issue::Board`
    /// can settle lost/draft issues.
    pub async fn open_async(ctx: Arc<Context>, drivers: Arc<dyn SessionDriver>, config: RuntimeConfig) -> Result<(Arc<Runtime>, Opened)> {
        tokio::fs::create_dir_all(config.data_dir.join("reports")).await.map_err(io)?;
        tokio::fs::create_dir_all(config.data_dir.join("records")).await.map_err(io)?;
        let opened = reopen_sessions_async(&ctx).await?;
        let config = Arc::new(config);
        let worktree = Arc::new(Worktree::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));
        let trajectory = Trajectory::open(ctx.clone());
        let write_lock = Arc::new(AsyncMutex::new(()));
        let session = SessionEngine::new_async(ctx.clone(), write_lock, drivers, worktree.clone(), config, Some(trajectory.clone())).await?;
        session.recover_on_connect(opened.recoverable.clone());
        session.record_interrupted_async(opened.interrupted.clone()).await;
        Ok((
            Arc::new(Runtime {
                ctx,
                session,
                trajectory,
                worktree,
            }),
            opened,
        ))
    }

    /// Standalone convenience constructor using [`RuntimeDriver`] over `registry`.
    pub async fn open_with_registry_async(ctx: Arc<Context>, registry: Arc<Registry>, config: RuntimeConfig) -> Result<(Arc<Runtime>, Opened)> {
        let drivers = Arc::new(RuntimeDriver {
            registry,
            model: config.model.clone(),
        });
        Self::open_async(ctx, drivers, config).await
    }

    pub fn ctx(&self) -> &Arc<Context> {
        &self.ctx
    }

    pub fn session_engine(&self) -> &SessionEngine {
        &self.session
    }

    pub fn trajectory(&self) -> &Arc<Trajectory> {
        &self.trajectory
    }

    pub fn worktree(&self) -> &Arc<Worktree> {
        &self.worktree
    }

    pub fn driver(&self) -> &Arc<dyn SessionDriver> {
        self.session.driver()
    }

    pub fn config(&self) -> &RuntimeConfig {
        self.session.config()
    }

    pub fn write_lock(&self) -> &Arc<AsyncMutex<()>> {
        self.session.write_lock()
    }

    pub fn durable_store(&self) -> &vibevalley_runtime::agent::durable::Store {
        self.session.durable_store()
    }

    /// Disposes live agent handles and flushes all open trajectories.
    pub async fn close_async(&self) {
        self.session.close();
        self.trajectory.close_async().await;
    }

    pub fn set_mcp_url(&self, url: String) {
        self.session.set_mcp_url(url);
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<SessionLifecycleEvent> {
        self.session.subscribe_events()
    }

    pub fn who(&self, token: &str) -> Option<String> {
        self.session.who(token)
    }

    pub fn base_branch(&self, session: &str) -> Option<String> {
        self.session.base_branch(session)
    }

    pub async fn get_async(&self, id: &str) -> Option<Session> {
        self.session.session_async(id).await
    }

    pub async fn session_async(&self, id: &str) -> Option<Session> {
        self.session.session_async(id).await
    }

    pub async fn past_session_async(&self, id: &str) -> Option<Session> {
        self.session.past_session_async(id).await
    }

    pub async fn list_async(&self) -> Vec<Session> {
        self.session.list_async().await
    }

    pub async fn sessions_async(&self) -> Result<Vec<Session>> {
        self.session.sessions_async().await
    }

    pub async fn runs_async(&self, issue: &str) -> Result<Vec<Run>> {
        self.session.runs_async(issue).await
    }

    pub async fn stop_async(&self, id: &str) -> std::result::Result<(), ApiError> {
        self.session.stop_async(id).await
    }

    pub async fn report_async(&self, session: &str, report: &Report) -> Result<()> {
        self.session.report_async(session, report).await
    }

    pub async fn upsert_orchestrator_async(&self, session: &Session) -> std::result::Result<(), ApiError> {
        self.session.upsert_orchestrator_async(session).await
    }

    pub async fn review_work_async(&self, vendor: &str, run_id: &str, candidate: &str) -> Result<Option<(Issue, Report)>> {
        self.session.review_work_async(vendor, run_id, candidate).await
    }

    pub async fn enqueue_mailbox_async(
        &self,
        session_id: &str,
        idempotency_key: &str,
        source: MailboxSource,
        source_message_id: Option<&str>,
        payload: &str,
    ) -> Result<MailboxEntry> {
        self.session
            .enqueue_mailbox_async(session_id, idempotency_key, source, source_message_id, payload)
            .await
    }

    pub async fn withdraw_mailbox_async(&self, idempotency_key: &str) -> Result<bool> {
        self.session.withdraw_mailbox_async(idempotency_key).await
    }

    pub async fn withdraw_mailbox_by_message_async(&self, message_id: &str) -> Result<u64> {
        self.session.withdraw_mailbox_by_message_async(message_id).await
    }

    pub async fn claim_next_mailbox_async(&self, session_id: &str) -> Result<Option<MailboxEntry>> {
        self.session.claim_next_mailbox_async(session_id).await
    }

    pub async fn claim_mailbox_by_key_async(&self, idempotency_key: &str) -> Result<bool> {
        self.session.claim_mailbox_by_key_async(idempotency_key).await
    }

    pub async fn settle_mailbox_async(&self, id: i64, ok: bool, result: Option<&str>) -> Result<()> {
        self.session.settle_mailbox_async(id, ok, result).await
    }

    pub async fn mailbox_entries_async(&self, session_id: &str) -> Result<Vec<MailboxEntry>> {
        self.session.mailbox_entries_async(session_id).await
    }

    // --- Router dispatch helpers for `Session*` & `Watch` endpoints ---

    pub(crate) async fn list_endpoint_async(
        &self,
        profile: Option<String>,
        controller: Option<SessionController>,
    ) -> std::result::Result<Vec<Session>, ApiError> {
        self.session.list_endpoint_async(profile, controller).await
    }

    pub(crate) async fn get_endpoint_async(&self, id: &str) -> std::result::Result<Session, ApiError> {
        self.session.get_endpoint_async(id).await
    }

    pub(crate) async fn event_list_endpoint_async(&self, input: &SessionEventListInput) -> std::result::Result<SessionEventPage, ApiError> {
        self.session.event_list_endpoint_async(input).await
    }

    pub(crate) async fn stop_endpoint_async(&self, id: &str) -> std::result::Result<(), ApiError> {
        self.session.stop_endpoint_async(id).await
    }

    pub(crate) async fn open_workspace_endpoint_async(&self, input: SessionOpenWorkspaceInput) -> std::result::Result<SessionWorkspace, ApiError> {
        self.session.open_workspace_endpoint_async(input).await
    }

    pub(crate) async fn close_workspace_endpoint_async(&self, id: &str) -> std::result::Result<(), ApiError> {
        self.session.close_workspace_endpoint_async(id).await
    }

    pub(crate) async fn send_workspace_endpoint_async(
        &self,
        input: SessionSendInput,
        storage: Option<&Storage>,
        trace_id: Option<u64>,
    ) -> std::result::Result<Session, ApiError> {
        self.session.send_workspace_endpoint_async(input, storage, trace_id).await
    }

    pub(crate) async fn respond_permission_endpoint_async(&self, input: SessionRespondPermissionInput) -> std::result::Result<(), ApiError> {
        self.session.respond_permission_endpoint_async(input).await
    }

    pub(crate) async fn respond_interaction_endpoint_async(&self, input: SessionRespondInteractionInput) -> std::result::Result<(), ApiError> {
        self.session.respond_interaction_endpoint_async(input).await
    }

    pub(crate) async fn set_config_endpoint_async(&self, input: SessionSetConfigInput) -> std::result::Result<SessionWorkspace, ApiError> {
        self.session.set_config_endpoint_async(input).await
    }

    pub(crate) async fn child_transcript_endpoint_async(&self, input: SessionChildTranscriptInput) -> std::result::Result<SessionChildTranscript, ApiError> {
        self.session.child_transcript_endpoint_async(input).await
    }

    pub(crate) async fn attach_binding_endpoint_async(&self, input: SessionBindingInput) -> std::result::Result<Session, ApiError> {
        self.session.attach_binding_endpoint_async(input).await
    }

    pub(crate) async fn detach_binding_endpoint_async(&self, input: SessionBindingInput) -> std::result::Result<Session, ApiError> {
        self.session.detach_binding_endpoint_async(input).await
    }

    pub(crate) async fn watch_session_async(&self, input: SessionWatchPayload, sink: crate::context::Sink) -> std::result::Result<(), ApiError> {
        self.session.watch_session_async(input, sink).await
    }

    pub(crate) async fn watch_issue_async(&self, input: IssueGetInput, sink: crate::context::Sink) -> std::result::Result<(), ApiError> {
        self.session.watch_issue_async(input, sink).await
    }
}
