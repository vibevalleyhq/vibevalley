//! Pure cron scheduler capability (`cron/`): schedule evaluation, persistence,
//! cron-to-issue link storage, and due-job claiming (`take_due_async`).
//!
//! Zero direct dependency on `issue/`, `channel/`, `connector/`, or `agent/`.
//! Cross-domain cron execution (digest delivery, orchestrator wakeups, and
//! scheduled issue dispatch) lives in [`crate::orchestration::cron`].

mod service;

pub use service::{DEFAULT_CHANNEL, DueCron, Scheduler};
