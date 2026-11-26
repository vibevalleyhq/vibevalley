//! `session.*` and the `issue.watch` stream: agent sessions, their work logs,
//! mailbox deliveries, direct workspace chat, and live watch streams.

pub(crate) mod delivery;
pub mod driver;
mod engine;
mod gen_table;
pub mod journal;
pub mod mailbox;
mod manager;
mod news;
pub mod report;
pub mod run;
mod subagent;
mod talk;
mod types;
mod workspace;

pub use driver::{AgentProfileInfo, Drive, HelperPlace, Persona, RuntimeDriver, SessionDriver};
pub use engine::{DraftEnd, Hire, PermissionEvent, Rounds, SessionEngine, SessionLifecycleEvent};
pub(crate) use engine::{OUTBOX_SESSION_REPORTED, OutboxSessionReported};
pub use journal::{Journal, Trajectory};
pub use mailbox::{MailboxEntry, MailboxSource, MailboxStatus};
pub use news::News;
pub use report::{ANSWER_ONLY, Report, ReportQuestion, ReportStatus};
pub use run::trigger_of;
pub use workspace::WorkspaceSnapshot;
