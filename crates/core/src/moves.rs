//! The moves a user may make on the board.
//! The reasons are values, not sentences: the UI words them.

use serde::{Deserialize, Serialize};

use vibevalley_i18n::t;
use vibevalley_protocol::*;

/// What a move does. For sent issues, `InProgress` and `InReview` belong to the
/// session; unsent issues can also be tracked across them with `Track`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Move {
    /// backlog → todo: sent now, or waits in todo for room.
    Start,
    /// todo → backlog.
    Unqueue,
    /// → todo: another round, with the user's words or the server's own.
    Round,
    /// done, canceled → todo: taken up again, with the user's words.
    Reopen,
    /// canceled before it was ever sent → backlog.
    Revive,
    /// Unsent issue tracked across backlog, todo, in_progress, and in_review.
    Track,
    /// → done: accepted and delivered as the issue says.
    Complete,
    /// in_progress, in_review → canceled: its session goes home.
    Cancel,
    /// backlog, todo, in_progress, in_review → canceled: never sent.
    Drop,
}

/// Why a move is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum Refusal {
    Same,
    /// A draft is being written by this session.
    Drafting {
        name: String,
    },
    /// This round failed: send it back with words, or close it.
    Failed,
}

impl Refusal {
    /// The reason as VibeValley says it (`statusMove`'s second value).
    pub fn text(&self) -> String {
        match self {
            Refusal::Same => t("server.issue.move.same", &[]),
            Refusal::Drafting { name } => t("server.issue.move.drafting", &[("name", name.clone().into())]),
            Refusal::Failed => t("server.issue.move.failed", &[]),
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text())
    }
}

pub fn status_move(issue: &Issue, to: IssueStatus) -> Result<Move, Refusal> {
    use IssueStatus::*;
    let from = issue.status;
    if from == to {
        return Err(Refusal::Same);
    }
    let sent = issue.was_sent();
    if !sent {
        return Ok(match (from, to) {
            (Backlog, Todo) => match &issue.refining {
                Some(r) => return Err(Refusal::Drafting { name: r.name.clone() }),
                None => Move::Start,
            },
            (Todo, Backlog) => Move::Unqueue,
            (_, Done) => Move::Complete,
            (_, Canceled) => Move::Drop,
            (Done | Canceled, Backlog) => Move::Revive,
            _ => Move::Track,
        });
    }
    let stage = &issue.stage;
    if to == Done && matches!(from, InProgress | InReview) && stage.stuck == Some(StuckReason::Failed) {
        return Err(Refusal::Failed);
    }
    Ok(match (from, to) {
        (Backlog, Todo) => match &issue.refining {
            Some(r) => return Err(Refusal::Drafting { name: r.name.clone() }),
            None => Move::Start,
        },
        (Todo, Backlog) => Move::Unqueue,
        (InProgress | InReview, Todo) => Move::Round,
        (Done | Canceled, Todo) => Move::Reopen,
        (_, Done) => Move::Complete,
        (_, Canceled) => Move::Cancel,
        (_, Backlog | InProgress | InReview) => Move::Track,
        (Todo, Todo) => unreachable!(),
    })
}

pub fn status_moves(issue: &Issue) -> Vec<IssueStatus> {
    IssueStatus::ALL.into_iter().filter(|to| status_move(issue, *to).is_ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backlog_and_todo_allow_direct_done_and_canceled() {
        let mut issue = Issue::new("i1", 1, "Manual UX review", 100);
        assert_eq!(status_move(&issue, IssueStatus::Done), Ok(Move::Complete));
        assert_eq!(status_move(&issue, IssueStatus::Canceled), Ok(Move::Drop));
        assert_eq!(status_move(&issue, IssueStatus::Todo), Ok(Move::Start));

        issue.status = IssueStatus::Todo;
        assert_eq!(status_move(&issue, IssueStatus::Done), Ok(Move::Complete));
        assert_eq!(status_move(&issue, IssueStatus::Canceled), Ok(Move::Drop));
        assert_eq!(status_move(&issue, IssueStatus::Backlog), Ok(Move::Unqueue));

        // Unsent manual completion can revive back to backlog.
        issue.status = IssueStatus::Done;
        issue.delivered = Some(Landing::None);
        issue.closed_at = Some(200);
        assert_eq!(status_move(&issue, IssueStatus::Backlog), Ok(Move::Revive));
    }

    #[test]
    fn running_and_failed_sessions_keep_completion_safety() {
        let mut issue = Issue::new("i2", 2, "Running issue", 100);
        issue.last_run = Some(IssueLastRun {
            started_at: 100,
            ended_at: None,
            outcome: None,
        });
        issue.status = IssueStatus::InProgress;
        issue.stage.state = IssueStageKind::Working;
        assert_eq!(status_move(&issue, IssueStatus::InReview), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Done), Ok(Move::Complete));
        assert_eq!(status_move(&issue, IssueStatus::Canceled), Ok(Move::Cancel));
        assert_eq!(status_move(&issue, IssueStatus::Backlog), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Todo), Ok(Move::Round));

        issue.stage.state = IssueStageKind::Stuck;
        issue.stage.stuck = Some(StuckReason::Failed);
        assert_eq!(status_move(&issue, IssueStatus::Done), Err(Refusal::Failed));
    }

    #[test]
    fn unsent_issues_unlock_all_six_statuses_while_keeping_graph_protection() {
        let mut issue = Issue::new("i3", 3, "External MCP tracked", 100);
        assert_eq!(status_move(&issue, IssueStatus::InProgress), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::InReview), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Todo), Ok(Move::Start));
        assert_eq!(status_move(&issue, IssueStatus::Done), Ok(Move::Complete));
        assert_eq!(status_move(&issue, IssueStatus::Canceled), Ok(Move::Drop));

        issue.status = IssueStatus::InProgress;
        assert_eq!(status_move(&issue, IssueStatus::InProgress), Err(Refusal::Same));
        assert_eq!(status_move(&issue, IssueStatus::InReview), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Todo), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Backlog), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Done), Ok(Move::Complete));
        assert_eq!(status_move(&issue, IssueStatus::Canceled), Ok(Move::Drop));

        issue.status = IssueStatus::InReview;
        assert_eq!(status_move(&issue, IssueStatus::InProgress), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Todo), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Backlog), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Done), Ok(Move::Complete));
        assert_eq!(status_move(&issue, IssueStatus::Canceled), Ok(Move::Drop));

        issue.status = IssueStatus::Done;
        issue.delivered = Some(Landing::None);
        assert_eq!(status_move(&issue, IssueStatus::Backlog), Ok(Move::Revive));
        assert_eq!(status_move(&issue, IssueStatus::InProgress), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::InReview), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Todo), Ok(Move::Track));
        assert_eq!(status_move(&issue, IssueStatus::Canceled), Ok(Move::Drop));
    }
}
