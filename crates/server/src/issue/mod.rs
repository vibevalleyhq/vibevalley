//! Pure issue domain capability (`issue/`): the issue board (`Board`), state
//! transitions (`IssueChange`, `IssueState`), pull request tracking (`Pull`),
//! and single-domain `Issue*` / `RepoPrSubmit` handlers.
//!
//! Zero direct dependency on `channel/`, `cron/`, `connector/`, `note/`, or `voice/`.

mod actions;
pub mod board;
pub mod edit;
pub mod family;
pub mod pull;
pub mod refine;
pub mod starter;
pub mod store;
#[cfg(test)]
mod tests;
pub mod types;

pub use actions::next_steps;
pub use board::{Board, NewIssue, Sent};
pub use family::{ChildDraft, MAX_CHILDREN};
pub use pull::{
    Answer, GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, HostRun, HostedRepo, KnownPullEvent, Network, Publisher, Pull, PullIndex, PullRecord,
    UpsertPullInput, actions_job_of, checks_fingerprint, checks_verdict, hosted_origin,
};
pub use store::{IssueState, Opened, Step};
pub use types::{BoardConfig, BoardError, IssueChange, Result};
