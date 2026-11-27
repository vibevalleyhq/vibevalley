use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vibevalley_core::{Refusal, SliceMask, derive_issues};
use vibevalley_protocol::{
    ApiError, Assignment, Conflict, CriterionCheck, Execution, Finding, HumanPause, Issue, IssueAnswer, IssueCanceled, IssueMandate, Landing, Millis, Outcome,
    Question, Session,
};
use vibevalley_runtime::oar::PermissionMode;

use crate::service::DbError;

/// Errors returned by [`super::Runtime`], [`super::Worktree`], and [`crate::issue::Board`].
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
    /// A refusal already worded for the endpoint (from a [`super::SessionDriver`]).
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
    /// Shared repository manager for resolving mounted external repos and symlinks.
    pub repo: Option<std::sync::Arc<crate::repo::Repo>>,
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
            repo: None,
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
    Paused(HumanPause),
    Resumed,
    Mandate(IssueMandate),
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
            | IssueChange::Assigned(_)
            | IssueChange::Paused(_)
            | IssueChange::Resumed
            | IssueChange::Mandate(_) => base,
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
                t.mandate.pause = None;
            }
            IssueChange::Revived => {
                t.closed_at = None;
                t.canceled = None;
                t.queued_at = None;
                t.mandate.pause = None;
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
                t.mandate.pause = None;
            }
            IssueChange::Canceled(why) => {
                t.canceled = Some(why);
                t.closed_at = Some(at);
                t.queued_at = None;
                t.mandate.pause = None;
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
                    t.mandate.pause = None;
                    if t.latest_session_id() != Some(&session)
                        && let Some(a) = t.assignments.iter_mut().rev().find(|a| a.ended_at.is_none())
                    {
                        a.executions.push(Execution::Worker { session, started_at: at });
                    }
                }
            }
            IssueChange::Paused(pause) => {
                t.mandate.pause = Some(pause);
                t.queued_at = None;
            }
            IssueChange::Resumed => {
                t.mandate.pause = None;
            }
            IssueChange::Mandate(mandate) => {
                t.mandate = mandate;
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
