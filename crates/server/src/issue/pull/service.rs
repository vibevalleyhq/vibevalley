use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, BranchPublication, Caller, PublishPlatform, PullRequest, PullRequestState, SubmitBranch};

use super::super::board::Board;
use super::publish::{self, HostRun, HostRunner, HostedRepo, Publisher, hosted_origin};
use super::snapshot::{self, GitHubPullSnapshot};
use crate::context::error::refused as refuse;
use crate::context::{Context, now};
use crate::repo::Repo;
use crate::service::internal_db;
use crate::service::issue::{KnownPullEvent, PullRecord, UpsertPullInput};

pub(super) const DEFAULT_POLL_SECONDS: u64 = 180;

/// Pull request tracking, publishing, and polling service.
pub struct Pull {
    pub(super) ctx: Arc<Context>,
    pub(crate) publisher: Arc<Publisher>,
    pub(crate) repos: Option<Arc<Repo>>,
    pub(crate) board: Option<Arc<Board>>,
    pub(crate) gh: HostRunner,
    pub(crate) glab: HostRunner,
    pub(crate) refresh_lock: tokio::sync::Mutex<()>,
    pub(crate) poll_lock: tokio::sync::Mutex<()>,
    pub(super) closed: std::sync::atomic::AtomicBool,
    pub(super) poller: Mutex<Option<(CancellationToken, tokio::task::JoinHandle<()>)>>,
}

impl Pull {
    /// Constructs a pull request tracking service backed by `ctx.service.issue`.
    pub async fn open_async(
        ctx: Arc<Context>,
        publisher: Arc<Publisher>,
        repos: Option<Arc<Repo>>,
        board: Option<Arc<Board>>,
        gh: Option<HostRun>,
        glab: Option<HostRun>,
    ) -> Result<Arc<Pull>, ApiError> {
        Ok(Arc::new(Pull {
            ctx,
            publisher,
            repos,
            board,
            gh: gh.map_or(HostRunner::Cli("gh"), HostRunner::Custom),
            glab: glab.map_or(HostRunner::Cli("glab"), HostRunner::Custom),
            refresh_lock: tokio::sync::Mutex::new(()),
            poll_lock: tokio::sync::Mutex::new(()),
            closed: Default::default(),
            poller: Mutex::new(None),
        }))
    }

    pub async fn close_async(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::Relaxed);
        let poller = self.poller.lock().take();
        if let Some((cancel, handle)) = poller {
            cancel.cancel();
            let _ = handle.await;
        }
    }

    pub async fn of_issue_async(&self, issue_id: &str) -> Result<Option<PullRequest>, ApiError> {
        self.ctx.service.issue.pull_of_issue(issue_id).await.map_err(internal_db)
    }

    pub async fn find_async(&self, repo: &str, number: i64) -> Option<PullRecord> {
        self.ctx.service.issue.find_pull(repo, number).await.ok().flatten()
    }

    pub async fn list_async(&self) -> Result<Vec<PullRecord>, ApiError> {
        self.ctx.service.issue.list_pulls().await.map_err(internal_db)
    }

    pub async fn open_pulls_async(&self) -> Vec<PullRecord> {
        self.ctx.service.issue.open_pulls().await.unwrap_or_default()
    }

    pub async fn upsert_async(&self, input: UpsertPullInput) -> Result<PullRecord, ApiError> {
        self.ctx.service.issue.upsert_pull(input).await.map_err(internal_db)
    }

    pub async fn set_state_async(&self, id: &str, state: PullRequestState, at: i64) -> Result<PullRecord, ApiError> {
        self.ctx.service.issue.set_pull_state(id, state, at).await.map_err(internal_db)
    }

    pub async fn observe_checks_async(&self, id: &str, fingerprint: &str, revision: i64, at: i64) -> Result<PullRecord, ApiError> {
        self.ctx
            .service
            .issue
            .observe_pull_checks(id, fingerprint, revision, at)
            .await
            .map_err(internal_db)
    }

    pub async fn known_events_async(&self, pull_id: &str) -> Result<Vec<KnownPullEvent>, ApiError> {
        self.ctx.service.issue.known_pull_events(pull_id).await.map_err(internal_db)
    }

    pub async fn keep_event_async(&self, pull_id: &str, key: &str, bot_round_key: Option<&str>, bot_round: Option<i64>) -> Result<(), ApiError> {
        self.ctx
            .service
            .issue
            .keep_pull_event(pull_id, key, bot_round_key, bot_round)
            .await
            .map_err(internal_db)
    }

    async fn infer_farm_repo_async(&self, cwd: &str) -> Option<String> {
        let repos = self.repos.clone()?;
        repos.infer_name_for_dir_async(Path::new(cwd)).await
    }

    pub(crate) async fn hosted_repo_of_async(&self, name: &str, platform: Option<PublishPlatform>) -> Result<HostedRepo, ApiError> {
        if name.contains('/') {
            let chosen = platform.unwrap_or(PublishPlatform::Github);
            let host = match chosen {
                PublishPlatform::Github => "github.com",
                PublishPlatform::Gitlab => "gitlab.com",
            };
            return hosted_origin(&format!("https://{host}/{name}")).ok_or_else(|| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])));
        }
        let repos = self
            .repos
            .clone()
            .ok_or_else(|| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])))?;
        let origin = repos
            .origin_url_async(name)
            .await
            .ok_or_else(|| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])))?;
        let hosted = hosted_origin(&origin).ok_or_else(|| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])))?;
        if let Some(want) = platform
            && hosted.platform != want
        {
            return Err(refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])));
        }
        Ok(hosted)
    }

    pub(crate) async fn github_remote_async(&self, name: &str) -> Result<String, ApiError> {
        Ok(self.hosted_repo_of_async(name, Some(PublishPlatform::Github)).await?.name)
    }

    pub async fn pull_request_state_async(&self, repo: &str, number: i64, platform: Option<PublishPlatform>) -> Result<PullRequestState, ApiError> {
        let hosted = self.hosted_repo_of_async(repo, platform).await?;
        let runner = match hosted.platform {
            PublishPlatform::Github => &self.gh,
            PublishPlatform::Gitlab => &self.glab,
        };
        publish::remote_pull_state(&hosted, number, runner, self.publisher.github_rest()).await
    }

    /// Merges a pull/merge request remotely (`PUT /pulls/{n}/merge` or CLI) and settles any tracked record.
    pub async fn merge_pull_async(
        &self,
        repo: &str,
        number: i64,
        platform: Option<PublishPlatform>,
        method: Option<&str>,
    ) -> Result<PullRequestState, ApiError> {
        let hosted = self.hosted_repo_of_async(repo, platform).await?;
        self.publisher.merge_pull_async(&hosted, number, method).await?;
        let existing = match self.find_async(repo, number).await {
            Some(row) => Some(row),
            None => self.find_async(&hosted.name, number).await,
        };
        if let Some(row) = existing {
            if let Err(err) = self.set_state_async(&row.id, PullRequestState::Merged, now()).await {
                tracing::warn!(pull_id = %row.id, error = %err, "pull.merge failed to persist merged PR state");
            }
            if let (Some(board), Some(issue_id)) = (self.board.as_ref(), row.issue_id.as_deref())
                && let Err(err) = board.settle_pull_async(issue_id, PullRequestState::Merged).await
            {
                tracing::warn!(pull_id = %row.id, issue_id, error = %err, "pull.merge failed to settle linked issue");
            }
        }
        Ok(PullRequestState::Merged)
    }

    /// Publishes a branch via `Publisher::submit_async` and durably tracks non-dry-run
    /// pull/merge requests (both issue-linked and standalone `issue_id = None`).
    pub async fn publish_async(&self, req: &SubmitBranch, issue_id: Option<&str>) -> Result<BranchPublication, ApiError> {
        let out = self.publisher.submit_async(req).await?;
        if req.dry_run != Some(true)
            && out.pushed
            && let (Some(number), Some(url)) = (out.number, out.url.as_ref())
        {
            let tracked_repo = self.infer_farm_repo_async(&req.cwd).await.unwrap_or_else(|| out.repository.clone());
            self.upsert_async(UpsertPullInput {
                platform: out.platform,
                repo: tracked_repo,
                number,
                url: url.clone(),
                branch: out.branch.clone(),
                base: out.base.clone(),
                state: PullRequestState::Open,
                issue_id: issue_id.map(str::to_owned),
                at: now(),
            })
            .await?;
            if let (Some(board), Some(id)) = (self.board.as_ref(), issue_id) {
                board.refresh_issue_async(id).await;
            }
        }
        Ok(out)
    }

    /// Fetches a GitHub pull request snapshot (`checks`, `reviews`, `comments`).
    pub async fn snapshot_async(&self, repo: &str, number: i64) -> Result<GitHubPullSnapshot, ApiError> {
        let remote = self.github_remote_async(repo).await?;
        snapshot::fetch_snapshot(&self.gh, self.publisher.github_rest(), &remote, number).await
    }

    /// `repo.pr.submit`: domain router handler for submitting a branch as a PR/MR.
    pub(crate) async fn submit_pr_async(&self, caller: Caller, req: &SubmitBranch) -> Result<BranchPublication, ApiError> {
        if caller != Caller::User {
            return Err(refuse(BizCode::RepoRefused, t("server.repo.publish.userOnly", &[])));
        }
        let issue_id = if let Some(board) = &self.board {
            board.open_issue_for_branch_async(&req.cwd, &req.branch).await.map(|i| i.id)
        } else {
            None
        };
        self.publish_async(req, issue_id.as_deref()).await
    }
}
