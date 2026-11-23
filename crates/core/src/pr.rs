//! Pull-request rules, pure parts only.

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
