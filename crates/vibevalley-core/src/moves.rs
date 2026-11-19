//! The moves a user may make on the board. Ported from VibeValley
//! `apps/server/src/modules/issue/moves.ts` (`statusMove`, `statusMoves`).
//! The reasons are values, not sentences: the UI words them.

use serde::{Deserialize, Serialize};

use vibevalley_i18n::t;
use vibevalley_protocol::*;

/// What a move does. `InProgress` and `InReview` are the session's to reach,
/// never the user's.
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
    /// → done: accepted and delivered as the issue says.
    Complete,
    /// in_progress, in_review → canceled: its session goes home.
    Cancel,
    /// backlog, todo → canceled: never sent.
    Drop,
}

/// Why a move is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum Refusal {
    /// A sub-issue merged into its parent goes with the parent.
    InGraph,
    Same,
    /// Only a session moves an issue into these.
    ByHelpers,
    /// A draft is being written by this session.
    Drafting {
        name: String,
    },
    /// This round failed: send it back with words, or close it.
    Failed,
    /// It is being worked on.
    Working,
    /// Closed after being sent: reopen it into todo.
    Reopen,
    /// Closed before being sent: revive it into the backlog.
    Revive,
    Cannot {
        from: IssueStatus,
        to: IssueStatus,
    },
}

impl Refusal {
    /// The reason as VibeValley says it (`statusMove`'s second value).
    pub fn text(&self) -> String {
        match self {
            Refusal::InGraph => t("server.issue.move.inGraph", &[]),
            Refusal::Same => t("server.issue.move.same", &[]),
            Refusal::ByHelpers => t("server.issue.move.byHelpers", &[]),
            Refusal::Drafting { name } => t("server.issue.move.drafting", &[("name", name.clone().into())]),
            Refusal::Failed => t("server.issue.move.failed", &[]),
            Refusal::Working => t("server.issue.move.working", &[]),
            Refusal::Reopen => t("server.issue.move.reopen", &[]),
            Refusal::Revive => t("server.issue.move.revive", &[]),
            Refusal::Cannot { from, to } => t(
                "server.issue.move.cannot",
                &[
                    ("from", t(&format!("shared.status.{}", from.as_str()), &[]).into()),
                    ("to", t(&format!("shared.status.{}", to.as_str()), &[]).into()),
                ],
            ),
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
    if issue.delivered == Some(Landing::MergedIntoParent) {
        return Err(Refusal::InGraph);
    }
    if from == to {
        return Err(Refusal::Same);
    }
    if matches!(to, InProgress | InReview) {
        return Err(Refusal::ByHelpers);
    }
    let sent = issue.was_sent();
    let stage = &issue.stage;
    match from {
        Backlog => match to {
            Todo => match &issue.refining {
                Some(r) => return Err(Refusal::Drafting { name: r.name.clone() }),
                None => return Ok(Move::Start),
            },
            Canceled => return Ok(Move::Drop),
            _ => {}
        },
        Todo => match to {
            Backlog => return Ok(Move::Unqueue),
            Canceled => return Ok(Move::Drop),
            _ => {}
        },
        InProgress => {
            if to == Done && stage.stuck == Some(StuckReason::Failed) {
                return Err(Refusal::Failed);
            }
            let recoverable = stage.state == IssueStageKind::Asking || (stage.state == IssueStageKind::Stuck && stage.stuck != Some(StuckReason::Quiet));
            if to == Todo && recoverable {
                return Ok(Move::Round);
            }
            if to == Done && stage.stuck == Some(StuckReason::Interrupted) {
                return Ok(Move::Complete);
            }
            return if to == Canceled { Ok(Move::Cancel) } else { Err(Refusal::Working) };
        }
        InReview => match to {
            Todo => return Ok(Move::Round),
            // A round that failed is never done.
            Done => {
                return if stage.stuck == Some(StuckReason::Failed) {
                    Err(Refusal::Failed)
                } else {
                    Ok(Move::Complete)
                };
            }
            Canceled => return Ok(Move::Cancel),
            _ => {}
        },
        Done | Canceled => {
            if to == Todo && sent {
                return Ok(Move::Reopen);
            }
            if to == Backlog && !sent {
                return Ok(Move::Revive);
            }
            return Err(if sent { Refusal::Reopen } else { Refusal::Revive });
        }
    }
    Err(Refusal::Cannot { from, to })
}

pub fn status_moves(issue: &Issue) -> Vec<IssueStatus> {
    IssueStatus::ALL.into_iter().filter(|to| status_move(issue, *to).is_ok()).collect()
}
