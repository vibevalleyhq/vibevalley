//! Core issue domain types: [`BoardError`], [`BoardConfig`],
//! [`IssueChange`] state machine transitions, and round-report evaluation helpers.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use vibevalley_core::{Refusal, SliceMask, derive_issues};
use vibevalley_protocol::{
    ApiError, Assignment, Conflict, CriterionCheck, Deliverable, DeliveryReceipt, Execution, Finding, HumanPause, Issue, IssueAnswer, IssueCanceled,
    IssueMandate, Landing, Millis, Outcome, PullRequest, PullRequestState, Question, Session,
};
use vibevalley_runtime::oar::StopReason;

use crate::runtime::{Report, ReportQuestion, ReportStatus, RuntimeConfig, RuntimeError};
use crate::service::DbError;
use crate::service::issue::PullRecord;

/// Configuration for the issue board (aliased to [`RuntimeConfig`]).
pub type BoardConfig = RuntimeConfig;

/// Errors returned by [`super::Board`] and [`super::IssueState`].
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
    #[error("another VibeValley process holds the board ({0})")]
    Busy(PathBuf),
    #[error("agent: {0}")]
    Agent(#[from] vibevalley_runtime::oar::AgentError),
    #[error("store: {0}")]
    Store(#[from] DbError),
    #[error("{0}")]
    Other(String),
    /// A refusal already worded for the endpoint.
    #[error("{}", .0.message)]
    Api(ApiError),
}

impl From<RuntimeError> for BoardError {
    fn from(err: RuntimeError) -> Self {
        match err {
            RuntimeError::Durable(e) => Self::Durable(e),
            RuntimeError::Agent(e) => Self::Agent(e),
            RuntimeError::Store(e) => Self::Store(e),
            RuntimeError::Other(s) => Self::Other(s),
            RuntimeError::Api(e) => Self::Api(e),
        }
    }
}

pub type Result<T> = std::result::Result<T, BoardError>;

pub(crate) fn board_io(e: std::io::Error) -> BoardError {
    BoardError::Other(e.to_string())
}

/// Lookup an issue by id, number, or `#number`.
pub(crate) fn find_issue<'a>(issues: &'a [Issue], reference: &str) -> Option<&'a Issue> {
    let r = reference.trim().trim_start_matches('#');
    issues.iter().find(|t| t.id == r || t.number.to_string() == r)
}

/// Ranking rule choosing the primary pull request for an issue (Open > newest > highest number).
pub(crate) fn prefers_pull_for_issue(candidate: &PullRecord, current: &PullRecord) -> bool {
    let cand_open = candidate.state == PullRequestState::Open;
    let curr_open = current.state == PullRequestState::Open;
    if cand_open != curr_open {
        return cand_open;
    }
    if candidate.updated_at != current.updated_at {
        return candidate.updated_at > current.updated_at;
    }
    candidate.number >= current.number
}

fn pull_record_to_summary(row: &PullRecord) -> PullRequest {
    PullRequest {
        url: row.url.clone(),
        number: row.number,
        state: row.state,
    }
}

/// Projects the primary [`PullRequest`] per issue id from persisted [`PullRecord`] rows.
pub(crate) fn best_pulls_by_issue(rows: &[PullRecord]) -> HashMap<String, PullRequest> {
    let mut best: HashMap<&str, &PullRecord> = HashMap::new();
    for row in rows {
        let Some(issue_id) = row.issue_id.as_deref() else {
            continue;
        };
        match best.get(issue_id) {
            Some(curr) if !prefers_pull_for_issue(row, curr) => {}
            _ => {
                best.insert(issue_id, row);
            }
        }
    }
    best.into_iter().map(|(id, row)| (id.to_owned(), pull_record_to_summary(row))).collect()
}

/// Projects the primary [`PullRequest`] for one `issue_id` from persisted [`PullRecord`] rows.
pub(crate) fn best_pull_for_issue(rows: &[PullRecord], issue_id: &str) -> Option<PullRequest> {
    let mut best: Option<&PullRecord> = None;
    for row in rows {
        if row.issue_id.as_deref() != Some(issue_id) {
            continue;
        }
        if best.is_none_or(|curr| prefers_pull_for_issue(row, curr)) {
            best = Some(row);
        }
    }
    best.map(pull_record_to_summary)
}

/// Canonical issue derivation over raw issues and overlaid sessions, ensuring
/// archived/closed issues outside the board window are still derived individually.
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
    Delivered(Landing, Option<DeliveryReceipt>),
    Canceled(IssueCanceled),
    Stuck {
        why: String,
        conflict: Option<Conflict>,
    },
    Reviewed(Option<vibevalley_protocol::ReviewRevision>),
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
        delivery_receipt: Option<DeliveryReceipt>,
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
            IssueChange::Reopened | IssueChange::Delivered(_, _) | IssueChange::Stuck { conflict: Some(_), .. } | IssueChange::Started { .. } => {
                base | SliceMask::SESSIONS
            }
            IssueChange::Queued
            | IssueChange::Unqueued
            | IssueChange::Revived
            | IssueChange::Answered
            | IssueChange::Canceled(_)
            | IssueChange::Stuck { conflict: None, .. }
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
            IssueChange::Delivered(landing, receipt) => {
                if let Some(receipt) = receipt {
                    if let DeliveryReceipt::Commit { sha, .. } = &receipt {
                        t.delivery_evidence.get_or_insert_with(Default::default).merged_commit = Some(sha.clone());
                    }
                    t.delivery_receipt = Some(receipt);
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
            IssueChange::Stuck { why, conflict } => {
                if conflict.is_some() {
                    t.conflict = conflict;
                }
                t.questions = vec![Question {
                    question: why,
                    options: vec![],
                }];
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
            IssueChange::Reported {
                questions,
                checks,
                answer,
                delivery_receipt,
            } => {
                if let Some(q) = questions {
                    t.questions = q;
                }
                if !checks.is_empty() {
                    t.checks = checks;
                }
                if answer.is_some() {
                    t.answer = answer;
                }
                if delivery_receipt.is_some() {
                    t.delivery_receipt = delivery_receipt;
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

/// What a work round handed back, from its report or else from what the agent said.
pub(crate) struct Round {
    pub outcome: Outcome,
    pub summary: String,
    pub questions: Vec<Question>,
    pub checks: Vec<CriterionCheck>,
    pub answer: Option<IssueAnswer>,
    pub delivery_receipt: Option<DeliveryReceipt>,
}

pub(crate) fn read_round(issue: &Issue, reason: StopReason, report: Option<&Report>, said: &str, asked: &[Question]) -> Round {
    let outcome = match (&reason, report) {
        (StopReason::Aborted, _) => Outcome::Interrupted,
        (StopReason::Error | StopReason::MaxTurns, _) => Outcome::Failed,
        (StopReason::Completed, Some(r)) if r.status == ReportStatus::Failed => Outcome::Failed,
        (StopReason::Completed, _) => Outcome::Completed,
    };
    let declared = report.map(|r| r.summary.trim().to_string()).filter(|s| !s.is_empty());
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
    let mut questions: Vec<Question> = match report {
        Some(r) if !r.questions.is_empty() => r.questions.iter().map(ReportQuestion::to_question).collect(),
        _ => vibevalley_core::text::questions_from_text(said),
    };
    questions.extend(asked.iter().cloned());
    if outcome == Outcome::Completed && questions.is_empty() && report.is_some_and(|r| r.status == ReportStatus::Blocked) {
        questions.push(Question {
            question: summary.clone(),
            options: vec![],
        });
    }
    let questions = vibevalley_core::refine::open_questions(&questions);
    let answer: Option<IssueAnswer> = report.and_then(|r| r.answer.clone()).or_else(|| {
        (issue.deliver == Deliverable::Answer && outcome == Outcome::Completed && !said.trim().is_empty()).then(|| IssueAnswer {
            conclusion: said.trim().to_string(),
            evidence: vec![],
            unsure: vec![],
            next: vec![],
        })
    });
    let checks = report
        .map(|r| r.checks.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| vibevalley_core::text::checks_from_text(said));
    let delivery_receipt = report.and_then(|r| r.delivery_receipt.clone());
    Round {
        outcome,
        summary,
        questions,
        checks,
        answer,
        delivery_receipt,
    }
}
