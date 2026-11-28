//! Pure agent execution runtime (`runtime/`): session engine, event trajectories,
//! and durable delivery mailboxes.
//!
//! Has zero compile-time dependency on `crate::agent` or `crate::issue`:
//! `agent/` implements [`SessionDriver`] and injects it at boot.

mod mcp;
mod service;
pub mod session;
mod types;

pub use service::{Runtime, reopen_sessions_async};
#[cfg(test)]
pub(crate) use session::delivery::IssueReportDoc;
pub use session::{
    ANSWER_ONLY, ActiveRunSnapshot, AgentProfileInfo, AtomicTxHook, DraftEnd, Drive, HelperPlace, Hire, Journal, MailboxEntry, MailboxSource, MailboxStatus,
    News, PermissionEvent, Persona, Report, ReportQuestion, ReportStatus, RoundEnd, Rounds, RunMode, RuntimeDriver, SessionDriver, SessionEngine,
    SessionLifecycleEvent, Trajectory, WorkspaceSnapshot, combine_report_and_failure, trigger_of,
};
pub(crate) use session::{OUTBOX_SESSION_REPORTED, OutboxSessionReported};
pub(crate) use types::io;
pub use types::{Opened, Result, RuntimeConfig, RuntimeError, Step};
