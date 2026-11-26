//! Standalone Pull Requests domain module: branch publication (`repo.pr.submit`),
//! durable `pull` / `pull_event` tables via `ctx.service.issue`, synchronous
//! `PullIndex`, remote state refresh, GitHub CI/review polling, and
//! `vv://github/...` snapshots.

pub mod poll;
pub mod publish;
mod service;
pub mod snapshot;

pub use crate::service::issue::{KnownPullEvent, PullRecord, UpsertPullInput};
pub use publish::{Answer, HostRun, HostedRepo, Network, Publisher, hosted_origin};
pub use service::{Pull, PullIndex};
pub use snapshot::{GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, actions_job_of, checks_fingerprint, checks_verdict};

#[cfg(test)]
mod tests;
