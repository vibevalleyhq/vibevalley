//! Pure agent execution runtime (`runtime/`): session engine, event trajectories,
//! durable delivery mailboxes, and git worktree management.
//!
//! Has zero compile-time dependency on `crate::agent` or `crate::issue`:
//! `agent/` implements [`SessionDriver`] and injects it at boot.

mod mcp;
mod service;
pub mod session;
mod types;
pub mod worktree;

pub use service::{Runtime, reopen_sessions_async};
pub(crate) use session::delivery::IssueReportDoc;
pub use session::{
    ANSWER_ONLY, AgentProfileInfo, DraftEnd, Drive, HelperPlace, Hire, Journal, MailboxEntry, MailboxSource, MailboxStatus, News, Persona, Report,
    ReportQuestion, ReportStatus, Rounds, RuntimeDriver, SessionDriver, SessionEngine, SessionLifecycleEvent, Trajectory, WorkspaceSnapshot, trigger_of,
};
pub(crate) use session::{OUTBOX_SESSION_REPORTED, OutboxSessionReported};
pub use types::{BoardConfig, BoardError, IssueChange, Opened, Result, RuntimeConfig, RuntimeError, Step, Undelivered};
pub(crate) use types::{derive_all_issues, find_issue, io};
pub use worktree::{Changes, Delivery, Joined, Landed, Leave, Leaving, OnDisk, Worktree, issue_branch};
