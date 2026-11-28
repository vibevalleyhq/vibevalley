//! `repo.*` and `github.*`: the repositories under `<work root>/repos`,
//! created or cloned by name, their activity and languages, and whether `gh`
//! can open pull requests on them.
//!
//! `git` is the system binary (as everywhere in VibeValley); the calls here
//! (`init`, `clone`, `log --all`) are ones `vibevalley-git` does not offer.

mod github;
mod local;
pub mod publish;
mod stats;

pub(crate) use github::{GitHubApiError, GitHubRest, TokenSource};
pub use github::{github_origin, github_repository, probe_github_async};
pub use local::{Repo, RepoFolder, good_name, repo_problem};
pub use publish::{Answer, HostRun, HostedRepo, Network, Publisher, check_repository, hosted_origin};
pub use stats::{activity_of, contributions_of_async, stack_of};
