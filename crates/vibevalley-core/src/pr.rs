//! Pull-request rules, pure parts only. Ported from VibeValley
//! `apps/server/src/modules/issue/landing.ts` (`landingRouteOf`,
//! `goesByPullRequest`), `merge.ts` (`finishesWithPullRequest`) and
//! `github.ts` (`checksVerdict`). VibeValley has no GitHub runner yet: nothing
//! submits or polls pull requests.

use serde::{Deserialize, Serialize};

use vibevalley_protocol::*;

/// The issue's work goes in as a pull request: one is open, or its repo
/// goes by pull requests.
pub fn goes_by_pull_request(issue: &Issue, uses_pull_requests: bool) -> bool {
    issue.pull_request.as_ref().is_some_and(|pr| pr.state == PullRequestState::Open) || uses_pull_requests
}

/// A followed pull request's end finishes its issue: one still open that
/// delivers by merging (one that delivers the pull request itself is done
/// already, and a closed one only keeps the state).
pub fn finishes_with_pull_request(issue: &Issue) -> bool {
    issue.deliver != Deliverable::PullRequest && issue.closed_at.is_none()
}

/// How an issue's work goes in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandingRoute {
    /// From the issue's own checkout: no session holds it and its children
    /// merged into it.
    Checkout {
        repo: String,
    },
    NotStarted,
    /// Its session is gone.
    HelperGone {
        session: SessionId,
    },
    PullRequest {
        session: SessionId,
    },
    Merge {
        session: SessionId,
    },
}

/// `last` is the issue's newest session, `reachable` whether it is still
/// there to hand its workplace over.
pub fn landing_route_of(issue: &Issue, last: Option<&str>, reachable: bool, from_checkout: bool, uses_pull_requests: bool) -> LandingRoute {
    if let Some(repo) = &issue.repo
        && (last.is_none() || !reachable)
        && from_checkout
    {
        return LandingRoute::Checkout { repo: repo.clone() };
    }
    let Some(last) = last else { return LandingRoute::NotStarted };
    let session = last.to_string();
    if !reachable {
        return LandingRoute::HelperGone { session };
    }
    if issue.repo.is_some() && goes_by_pull_request(issue, uses_pull_requests) {
        return LandingRoute::PullRequest { session };
    }
    LandingRoute::Merge { session }
}

/// One CI check of a pull request, as GitHub reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CiCheck {
    pub name: String,
    pub status: String,
    pub conclusion: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecksVerdict {
    pub failed: Vec<CiCheck>,
    pub finished: bool,
}

const FAILED: [&str; 8] = [
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "CANCELED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
];
const FINISHED: [&str; 4] = ["COMPLETED", "SUCCESS", "FAILURE", "ERROR"];

/// A pull request's checks as its session is told of them: the failed ones,
/// and whether every one has finished.
pub fn checks_verdict(checks: &[CiCheck]) -> ChecksVerdict {
    let word = |c: &CiCheck| {
        if c.conclusion.is_empty() {
            c.status.to_uppercase()
        } else {
            c.conclusion.to_uppercase()
        }
    };
    ChecksVerdict {
        failed: checks.iter().filter(|c| FAILED.contains(&word(c).as_str())).cloned().collect(),
        finished: !checks.is_empty()
            && checks
                .iter()
                .all(|c| !c.conclusion.is_empty() || FINISHED.contains(&c.status.to_uppercase().as_str())),
    }
}
