use std::collections::HashMap;
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
use crate::log::spawn_blocking_traced;
use crate::repo::Repo;
use crate::service::internal_db;
use crate::service::issue::{KnownPullEvent, PullRecord, UpsertPullInput};

pub(super) const DEFAULT_POLL_SECONDS: u64 = 180;

fn prefers_for_issue(candidate: &PullRecord, current: &PullRecord) -> bool {
    let cand_open = candidate.state == PullRequestState::Open;
    let curr_open = current.state == PullRequestState::Open;
    if cand_open != curr_open {
        return cand_open;
    }
    if candidate.updated_at != current.updated_at {
        return candidate.updated_at > current.updated_at;
    }
    candidate.number >= current.number
}

/// Synchronous in-memory index of tracked pull requests for fast issue projection.
#[derive(Default)]
pub struct PullIndex {
    by_id: HashMap<String, PullRecord>,
    by_repo_number: HashMap<(String, i64), PullRecord>,
    by_issue: HashMap<String, PullRecord>,
}

impl PullIndex {
    pub fn load(&mut self, rows: Vec<PullRecord>) {
        self.by_id.clear();
        self.by_repo_number.clear();
        self.by_issue.clear();
        for row in rows {
            self.put(row);
        }
    }

    pub fn put(&mut self, next: PullRecord) -> PullRecord {
        let previous = self.by_id.get(&next.id).cloned();
        if let Some(prev) = &previous {
            self.by_repo_number.remove(&(prev.repo.clone(), prev.number));
        }
        self.by_id.insert(next.id.clone(), next.clone());
        self.by_repo_number.insert((next.repo.clone(), next.number), next.clone());
        if let Some(prev_issue) = previous.as_ref().and_then(|p| p.issue_id.as_deref())
            && next.issue_id.as_deref() != Some(prev_issue)
        {
            self.recompute_issue(prev_issue);
        }
        if let Some(issue_id) = next.issue_id.as_deref() {
            self.recompute_issue(issue_id);
        }
        next
    }

    fn recompute_issue(&mut self, issue_id: &str) {
        let mut best: Option<&PullRecord> = None;
        for item in self.by_id.values() {
            if item.issue_id.as_deref() != Some(issue_id) {
                continue;
            }
            if best.is_none_or(|curr| prefers_for_issue(item, curr)) {
                best = Some(item);
            }
        }
        if let Some(best) = best.cloned() {
            self.by_issue.insert(issue_id.into(), best);
        } else {
            self.by_issue.remove(issue_id);
        }
    }

    pub fn of_issue(&self, issue_id: &str) -> Option<PullRequest> {
        let found = self.by_issue.get(issue_id)?;
        Some(PullRequest {
            url: found.url.clone(),
            number: found.number,
            state: found.state,
        })
    }

    pub fn find(&self, repo: &str, number: i64) -> Option<PullRecord> {
        self.by_repo_number.get(&(repo.into(), number)).cloned()
    }

    pub fn all(&self) -> Vec<PullRecord> {
        let mut items: Vec<PullRecord> = self.by_id.values().cloned().collect();
        items.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        items
    }

    pub fn active(&self) -> Vec<PullRecord> {
        let mut items: Vec<PullRecord> = self.by_id.values().filter(|item| item.state == PullRequestState::Open).cloned().collect();
        items.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        items
    }
}

/// Pull request tracking, publishing, and polling service.
pub struct Pull {
    pub(super) ctx: Arc<Context>,
    index: Arc<Mutex<PullIndex>>,
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
    /// Loads tracked pull requests from `ctx.service.issue` and wires
    /// `Issue.pull_request` projection onto `board` when present.
    pub async fn open_async(
        ctx: Arc<Context>,
        publisher: Arc<Publisher>,
        repos: Option<Arc<Repo>>,
        board: Option<Arc<Board>>,
        gh: Option<HostRun>,
        glab: Option<HostRun>,
    ) -> Result<Arc<Pull>, ApiError> {
        let rows = ctx.service.issue.list_pulls().await.map_err(internal_db)?;
        let mut idx = PullIndex::default();
        idx.load(rows);
        let index = Arc::new(Mutex::new(idx));
        if let Some(board) = &board {
            let idx = index.clone();
            board.use_pull_of_issue_async(Arc::new(move |issue_id| idx.lock().of_issue(issue_id))).await;
        }
        Ok(Arc::new(Pull {
            ctx,
            index,
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

    pub fn of_issue(&self, issue_id: &str) -> Option<PullRequest> {
        self.index.lock().of_issue(issue_id)
    }

    pub fn find(&self, repo: &str, number: i64) -> Option<PullRecord> {
        self.index.lock().find(repo, number)
    }

    pub fn list(&self) -> Vec<PullRecord> {
        self.index.lock().all()
    }

    pub fn open_pulls(&self) -> Vec<PullRecord> {
        self.index.lock().active()
    }

    pub async fn upsert_async(&self, input: UpsertPullInput) -> Result<PullRecord, ApiError> {
        let record = self.ctx.service.issue.upsert_pull(input).await.map_err(internal_db)?;
        Ok(self.index.lock().put(record))
    }

    pub async fn set_state_async(&self, id: &str, state: PullRequestState, at: i64) -> Result<PullRecord, ApiError> {
        let record = self.ctx.service.issue.set_pull_state(id, state, at).await.map_err(internal_db)?;
        Ok(self.index.lock().put(record))
    }

    pub async fn observe_checks_async(&self, id: &str, fingerprint: &str, revision: i64, at: i64) -> Result<PullRecord, ApiError> {
        let record = self
            .ctx
            .service
            .issue
            .observe_pull_checks(id, fingerprint, revision, at)
            .await
            .map_err(internal_db)?;
        Ok(self.index.lock().put(record))
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
        let discovered_root = vibevalley_git::Repo::discover_async(Path::new(cwd))
            .await
            .ok()
            .flatten()
            .map(|r| r.root().to_path_buf())?;
        let root_real = tokio::fs::canonicalize(&discovered_root).await.ok()?;
        let listed = repos.list_async().await;
        for p in listed {
            if tokio::fs::canonicalize(&p.path).await.ok().as_ref() == Some(&root_real) {
                return Some(p.name);
            }
        }
        None
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
        let listed = repos.list_async().await;
        let name = name.to_string();
        spawn_blocking_traced(move || {
            let found = listed
                .into_iter()
                .find(|p| p.name == name)
                .ok_or_else(|| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])))?;
            let origin = vibevalley_git::read::remote_url(&found.path, "origin").ok().flatten().unwrap_or_default();
            let hosted = hosted_origin(&origin).ok_or_else(|| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])))?;
            if let Some(want) = platform
                && hosted.platform != want
            {
                return Err(refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])));
            }
            Ok(hosted)
        })
        .await
        .map_err(|_| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])))?
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
        let existing = self.find(repo, number).or_else(|| self.find(&hosted.name, number));
        if let Some(row) = existing {
            let _ = self.set_state_async(&row.id, PullRequestState::Merged, now()).await;
            if let (Some(board), Some(issue_id)) = (self.board.as_ref(), row.issue_id.as_deref()) {
                let _ = board.settle_pull_async(issue_id, PullRequestState::Merged).await;
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
