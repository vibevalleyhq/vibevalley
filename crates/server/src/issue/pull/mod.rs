//! Standalone Pull Requests domain module: branch publication (`repo.pr.submit`),
//! durable `pull` / `pull_event` tables via `ctx.service.issue`, synchronous
//! `PullIndex`, remote state refresh, GitHub CI/review polling, and
//! `vv://github/...` snapshots.

pub mod poll;
pub mod publish;
pub mod snapshot;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, BranchPublication, Caller, PublishPlatform, PullRequest, PullRequestState, SubmitBranch};

use super::board::Board;
use crate::context::error::refused as refuse;
use crate::context::{Context, now};
use crate::log::spawn_blocking_traced;
use crate::repo::Repo;
use crate::service::internal_db;

pub use crate::service::issue::{KnownPullEvent, PullRecord, UpsertPullInput};
use publish::HostRunner;
pub use publish::{Answer, HostRun, HostedRepo, Network, Publisher, hosted_origin};
pub use snapshot::{GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, actions_job_of, checks_fingerprint, checks_verdict};

const DEFAULT_POLL_SECONDS: u64 = 180;

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
    ctx: Arc<Context>,
    index: Arc<Mutex<PullIndex>>,
    pub(crate) publisher: Arc<Publisher>,
    pub(crate) repos: Option<Arc<Repo>>,
    pub(crate) board: Option<Arc<Board>>,
    pub(crate) gh: HostRunner,
    pub(crate) glab: HostRunner,
    pub(crate) refresh_lock: tokio::sync::Mutex<()>,
    pub(crate) poll_lock: tokio::sync::Mutex<()>,
    closed: std::sync::atomic::AtomicBool,
    poller: Mutex<Option<(CancellationToken, tokio::task::JoinHandle<()>)>>,
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
        publish::remote_pull_state(&hosted, number, runner).await
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
        snapshot::fetch_snapshot(&self.gh, &remote, number).await
    }

    pub async fn refresh_async(&self) {
        poll::refresh(self).await;
    }

    pub async fn poll_async(&self) {
        poll::poll(self).await;
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

    /// Starts the background PR refresh/poll loop on `ctx.task`.
    pub fn start_poller(self: &Arc<Self>, poll_seconds: Option<u64>) {
        let Some(secs) = poll_seconds else { return };
        let interval = Duration::from_secs(if secs > 0 { secs } else { DEFAULT_POLL_SECONDS });
        let cancel = self.ctx.task.child_token();
        let task_cancel = cancel.clone();
        let weak = Arc::downgrade(self);
        let span = tracing::debug_span!("pull.poll", interval_secs = interval.as_secs());
        let handle = self.ctx.task.spawn(
            async move {
                let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        biased;
                        _ = task_cancel.cancelled() => return,
                        _ = timer.tick() => {}
                    }
                    if task_cancel.is_cancelled() {
                        return;
                    }
                    let Some(p) = weak.upgrade() else { return };
                    if p.closed.load(std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    tokio::select! {
                        biased;
                        _ = task_cancel.cancelled() => return,
                        _ = async {
                            p.refresh_async().await;
                            p.poll_async().await;
                        } => {}
                    }
                }
            }
            .instrument(span),
        );
        *self.poller.lock() = Some((cancel, handle));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{Http, LiveState, Outbox, StateFeed, TaskGroup};
    use crate::issue::{Board, BoardConfig, NewIssue};
    use crate::service::Service;
    use vibevalley_protocol::{Deliverable, IssueCanceled, IssueStatus, Landing};
    use vibevalley_runtime::oar::Registry;

    async fn test_context(dir: &Path) -> Arc<Context> {
        let service = Service::open(dir).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
        Arc::new(Context::new(
            service,
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            http.clone(),
            http,
        ))
    }

    fn fake_record(id: &str, number: i64, state: PullRequestState, issue_id: Option<&str>, updated_at: i64) -> PullRecord {
        PullRecord {
            id: id.into(),
            platform: PublishPlatform::Github,
            repo: "acme/demo".into(),
            number,
            url: format!("https://github.com/acme/demo/pull/{number}"),
            branch: format!("vibevalley/issue-{number}"),
            base: "main".into(),
            state,
            issue_id: issue_id.map(str::to_owned),
            check_fingerprint: String::new(),
            check_revision: 0,
            created_at: 100,
            updated_at,
        }
    }

    #[test]
    fn pull_index_prefers_open_then_newest_then_highest_number() {
        let mut idx = PullIndex::default();
        idx.put(fake_record("p1", 1, PullRequestState::Closed, Some("i1"), 200));
        idx.put(fake_record("p2", 2, PullRequestState::Open, Some("i1"), 150));
        assert_eq!(idx.of_issue("i1").map(|p| p.number), Some(2));

        // Closing #2 promotes the newer closed #1 (updated_at 200 > 150)
        idx.put(fake_record("p2", 2, PullRequestState::Closed, Some("i1"), 150));
        assert_eq!(idx.of_issue("i1").map(|p| p.number), Some(1));

        // Tie on state + updated_at picks highest number
        idx.put(fake_record("p3", 5, PullRequestState::Closed, Some("i1"), 200));
        assert_eq!(idx.of_issue("i1").map(|p| p.number), Some(5));
    }

    #[test]
    fn checks_verdict_and_fingerprint_are_order_independent() {
        let a = GitHubCheck {
            name: "build".into(),
            status: "COMPLETED".into(),
            conclusion: "SUCCESS".into(),
            url: "https://github.com/acme/demo/actions/runs/1/job/10".into(),
        };
        let b = GitHubCheck {
            name: "test".into(),
            status: "COMPLETED".into(),
            conclusion: "FAILURE".into(),
            url: "https://github.com/acme/demo/actions/runs/1/job/20".into(),
        };
        let fp1 = checks_fingerprint("abc123", &[a.clone(), b.clone()]);
        let fp2 = checks_fingerprint("abc123", &[b.clone(), a.clone()]);
        assert_eq!(fp1, fp2);
        let checks = [a, b];
        let (failed, finished) = checks_verdict(&checks);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].name, "test");
        assert!(finished);
        assert_eq!(actions_job_of("https://github.com/acme/demo/actions/runs/1/job/4299"), Some("4299".into()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pull_refresh_poll_snapshot_and_issue_fk_preservation() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = test_context(dir.path()).await;
        let mut reg = Registry::new();
        reg.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
        let board = Board::open_standalone_async(ctx.clone(), Arc::new(reg), BoardConfig::under(dir.path()))
            .await
            .unwrap();

        let issue = board
            .create_async(NewIssue {
                title: "Ship PR".into(),
                description: "Deliver via followed PR".into(),
                agent: "scripted".into(),
                deliver: Deliverable::Change,
                ..Default::default()
            })
            .await
            .unwrap();

        let pr_state = Arc::new(Mutex::new("OPEN".to_string()));
        let pr_state_gh = pr_state.clone();
        let gh: HostRun = Arc::new(move |args: &[String]| {
            let joined = args.join(" ");
            if joined.starts_with("pr view ") && joined.contains("--json state") && !joined.contains("headRefOid") {
                return Answer {
                    ok: true,
                    out: format!(r#"{{"state":"{}"}}"#, pr_state_gh.lock()),
                    missing: false,
                };
            }
            if joined.starts_with("pr view ") && joined.contains("headRefOid") {
                return Answer {
                    ok: true,
                    out: r#"{"state":"OPEN","headRefOid":"deadbeef","statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/acme/demo/actions/runs/1/job/77"}]}"#.into(),
                    missing: false,
                };
            }
            if joined == "api user" {
                return Answer {
                    ok: true,
                    out: r#"{"login":"me"}"#.into(),
                    missing: false,
                };
            }
            if joined.contains("/pulls/9/reviews") {
                return Answer {
                    ok: true,
                    out: r#"[{"id":100,"user":{"login":"coderabbitai[bot]","type":"Bot"},"state":"COMMENTED","body":"Please fix","submitted_at":"2026-11-19T00:00:01Z"},{"id":101,"user":{"login":"me","type":"User"},"state":"COMMENTED","body":"self","submitted_at":"2026-11-19T00:00:02Z"}]"#.into(),
                    missing: false,
                };
            }
            if joined.contains("/pulls/9/comments") {
                return Answer {
                    ok: true,
                    out: r#"[{"id":200,"user":{"login":"coderabbitai[bot]","type":"Bot"},"pull_request_review_id":100,"path":"src/lib.rs","line":12,"diff_hunk":"@@ -1,2 +1,2 @@\n-a\n+b","body":"nit","created_at":"2026-11-19T00:00:03Z"}]"#.into(),
                    missing: false,
                };
            }
            if joined.contains("/issues/9/comments") {
                return Answer {
                    ok: true,
                    out: r#"[{"id":300,"user":{"login":"coderabbitai[bot]","type":"Bot"},"body":"round 2","created_at":"2026-11-19T00:00:04Z"}]"#.into(),
                    missing: false,
                };
            }
            if joined.starts_with("run view --job 77") {
                return Answer {
                    ok: true,
                    out: "error: assertion failed".into(),
                    missing: false,
                };
            }
            Answer {
                ok: false,
                out: String::new(),
                missing: false,
            }
        });

        let pulls = Pull::open_async(ctx.clone(), Arc::new(Publisher::default()), None, Some(board.clone()), Some(gh.clone()), None)
            .await
            .unwrap();

        // Upsert linked PR and standalone PR (issue_id = None)
        let linked = pulls
            .upsert_async(UpsertPullInput {
                platform: PublishPlatform::Github,
                repo: "acme/demo".into(),
                number: 9,
                url: "https://github.com/acme/demo/pull/9".into(),
                branch: "vibevalley/issue-1".into(),
                base: "main".into(),
                state: PullRequestState::Open,
                issue_id: Some(issue.id.clone()),
                at: 1000,
            })
            .await
            .unwrap();
        let standalone = pulls
            .upsert_async(UpsertPullInput {
                platform: PublishPlatform::Github,
                repo: "acme/demo".into(),
                number: 10,
                url: "https://github.com/acme/demo/pull/10".into(),
                branch: "feat/standalone".into(),
                base: "main".into(),
                state: PullRequestState::Open,
                issue_id: None,
                at: 1001,
            })
            .await
            .unwrap();
        assert_eq!(standalone.issue_id, None);
        board.refresh_issue_async(&issue.id).await;
        assert_eq!(
            board.issue_async(&issue.id).await.unwrap().unwrap().pull_request.as_ref().map(|p| p.number),
            Some(9)
        );

        // Updating the issue MUST NOT null pull.issue_id (regression test for PutIssue ON CONFLICT DO UPDATE)
        board.move_to_async(&issue.id, IssueStatus::Todo, None).await.unwrap();
        let reopened = Pull::open_async(ctx.clone(), Arc::new(Publisher::default()), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(reopened.find("acme/demo", 9).unwrap().issue_id.as_deref(), Some(issue.id.as_str()));

        // Direct PR snapshot fetch (`snapshot::fetch_snapshot` via `HostRunner`)
        let snap = snapshot::fetch_snapshot(&pulls.gh, "acme/demo", 9).await.unwrap();
        assert_eq!(snap.head, "deadbeef");
        let (failed, _) = checks_verdict(&snap.checks);
        assert_eq!(failed.len(), 1);

        // Poll CI + reviews/comments: viewer skipped, review+inline comment share bot_round 1, standalone bot comment gets bot_round 2
        pulls.poll_async().await;
        let after_poll = pulls.find("acme/demo", 9).unwrap();
        assert_eq!(after_poll.check_revision, 1);
        assert!(!after_poll.check_fingerprint.is_empty());
        let events = pulls.known_events_async(&linked.id).await.unwrap();
        assert_eq!(events.len(), 3, "viewer review must be skipped: {events:?}");
        let r_review = events.iter().find(|e| e.key.ends_with(":review:100")).unwrap();
        let r_inline = events.iter().find(|e| e.key.ends_with(":comment:200")).unwrap();
        let r_second = events.iter().find(|e| e.key.ends_with(":comment:300")).unwrap();
        assert_eq!(r_review.bot_round, Some(1));
        assert_eq!(r_inline.bot_round, Some(1));
        assert_eq!(r_second.bot_round, Some(2));

        // Second poll with unchanged snapshot does not increment check_revision
        pulls.poll_async().await;
        assert_eq!(pulls.find("acme/demo", 9).unwrap().check_revision, 1);

        // Refresh transitions PR to MERGED -> settles issue as Landing::PullRequest
        *pr_state.lock() = "MERGED".into();
        pulls.refresh_async().await;
        assert_eq!(pulls.find("acme/demo", 9).unwrap().state, PullRequestState::Merged);
        let settled = board.issue_async(&issue.id).await.unwrap().unwrap();
        assert_eq!(settled.delivered, Some(Landing::PullRequest));

        // Closing an issue's PR settles as Dismissed
        let issue2 = board
            .create_async(NewIssue {
                title: "Close PR".into(),
                description: "Deliver via followed PR".into(),
                agent: "scripted".into(),
                deliver: Deliverable::Change,
                ..Default::default()
            })
            .await
            .unwrap();
        pulls
            .upsert_async(UpsertPullInput {
                platform: PublishPlatform::Github,
                repo: "acme/demo".into(),
                number: 11,
                url: "https://github.com/acme/demo/pull/11".into(),
                branch: "vibevalley/issue-2".into(),
                base: "main".into(),
                state: PullRequestState::Open,
                issue_id: Some(issue2.id.clone()),
                at: 1002,
            })
            .await
            .unwrap();
        board.refresh_issue_async(&issue2.id).await;
        *pr_state.lock() = "CLOSED".into();
        pulls.refresh_async().await;
        assert_eq!(board.issue_async(&issue2.id).await.unwrap().unwrap().canceled, Some(IssueCanceled::Dismissed));

        pulls.close_async().await;
        board.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pull_background_poller_preserves_pull_poll_span_and_stops_on_runtime_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = test_context(dir.path()).await;
        let seen_span = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen_span_gh = seen_span.clone();
        let notify = Arc::new(tokio::sync::Notify::new());
        let notify_gh = notify.clone();
        let gh: HostRun = Arc::new(move |args: &[String]| {
            let current = tracing::Span::current();
            if current.metadata().is_some_and(|m| m.name() == "pull.poll") {
                seen_span_gh.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            if args.first().map(String::as_str) == Some("pr") {
                notify_gh.notify_one();
                return Answer {
                    ok: true,
                    out: r#"{"state":"MERGED"}"#.into(),
                    missing: false,
                };
            }
            Answer {
                ok: false,
                out: String::new(),
                missing: false,
            }
        });
        let pulls = Pull::open_async(ctx.clone(), Arc::new(Publisher::default()), None, None, Some(gh), None)
            .await
            .unwrap();
        pulls
            .upsert_async(UpsertPullInput {
                platform: PublishPlatform::Github,
                repo: "acme/demo".into(),
                number: 42,
                url: "https://github.com/acme/demo/pull/42".into(),
                branch: "feat/span".into(),
                base: "main".into(),
                state: PullRequestState::Open,
                issue_id: None,
                at: 1000,
            })
            .await
            .unwrap();

        let subscriber = tracing_subscriber::fmt().with_max_level(tracing::Level::DEBUG).with_test_writer().finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        pulls.start_poller(Some(1));

        tokio::time::timeout(Duration::from_secs(5), notify.notified())
            .await
            .expect("background pull poller should fire within 5s");
        assert!(
            seen_span.load(std::sync::atomic::Ordering::SeqCst),
            "pull.poll span must propagate into HostRunner"
        );

        pulls.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
    }
}
