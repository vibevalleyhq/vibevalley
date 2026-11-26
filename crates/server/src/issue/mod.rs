//! Issues domain (`issue/`): the issue board (`Board`), lightweight state
//! coordination (`IssueState`), channel bridges (`IssueChat`, `SessionChat`),
//! pull request publication/polling (`Pull`), and all `Issue*` / `RepoPrSubmit`
//! router handlers.

mod actions;
pub mod board;
pub mod chat;
pub mod edit;
pub mod family;
pub mod pull;
pub mod refine;
mod session_chat;
pub mod starter;
pub mod store;
#[cfg(test)]
mod tests;

pub use actions::next_steps;
pub use board::{Board, NewIssue, Sent};
pub use chat::IssueChat;
pub use family::{ChildDraft, MAX_CHILDREN};
pub use pull::{
    Answer, GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, HostRun, HostedRepo, KnownPullEvent, Network, Publisher, Pull, PullIndex, PullRecord,
    UpsertPullInput, actions_job_of, checks_fingerprint, checks_verdict, hosted_origin,
};
pub use session_chat::SessionChat;
pub use store::{BoardConfig, BoardError, CronOfIssue, IssueChange, IssueState, Opened, PullOfIssue, Result, Step, Undelivered};
