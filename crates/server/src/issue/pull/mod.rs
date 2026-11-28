//! Standalone Pull Requests domain module: branch publication (`repo.pr.submit`),
//! durable `pull` table via `ctx.service.issue`, remote state refresh, GitHub
//! CI/review polling, and `vv://github/...` snapshots.

pub mod poll;
pub use crate::repo::publish;
mod service;
pub mod snapshot;

pub use crate::service::issue::{KnownPullEvent, PullRecord, UpsertPullInput};
pub use publish::{Answer, HostRun, HostedRepo, Network, Publisher, hosted_origin};
pub use service::Pull;
pub use snapshot::{GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, actions_job_of, checks_fingerprint, checks_verdict};

#[cfg(test)]
mod tests;
