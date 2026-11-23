//! Standalone Pull Requests domain module: branch publication (`repo.pr.submit`),
//! durable `pull` / `pull_event` tables in `server.db`, synchronous `PullIndex`,
//! remote state refresh, GitHub CI/review polling, and `vv://github/...` snapshots.

pub mod poll;
pub mod publish;
pub mod snapshot;
pub mod store;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, BranchPublication, Caller, PublishPlatform, PullRequest, PullRequestState, SubmitBranch, ops};

use crate::base::{ServerDb, refused as refuse};
use crate::modules::work::issue::Board;
use crate::modules::work::repo::Repos;
use crate::{Hub, now};

use publish::HostRunner;
pub use publish::{Answer, HostRun, HostedRepo, Network, Publisher, hosted_origin};
pub use snapshot::{GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, actions_job_of, checks_fingerprint, checks_verdict};
pub use store::{KnownPullEvent, PullIndex, PullRecord, PullStore, UpsertPullInput};

const DEFAULT_POLL_SECONDS: u64 = 180;

pub struct Pulls {
    pub(crate) store: PullStore,
    pub(crate) publisher: Arc<Publisher>,
    pub(crate) repos: Option<Arc<Repos>>,
    pub(crate) board: Option<Board>,
    pub(crate) gh: HostRunner,
    pub(crate) glab: HostRunner,
    pub(crate) refresh_lock: tokio::sync::Mutex<()>,
    pub(crate) poll_lock: tokio::sync::Mutex<()>,
    closed: std::sync::atomic::AtomicBool,
    poller: Mutex<Option<(CancellationToken, tokio::task::JoinHandle<()>)>>,
}

impl Pulls {
    /// Opens `pull` and `pull_event` on the shared `ServerDb` and wires
    /// `Issue.pull_request` projection onto `board` when present.
    pub fn open(
        db: Arc<ServerDb>,
        publisher: Arc<Publisher>,
        repos: Option<Arc<Repos>>,
        board: Option<Board>,
        gh: Option<HostRun>,
        glab: Option<HostRun>,
    ) -> Result<Arc<Pulls>, ApiError> {
        let store = PullStore::open(db)?;
        if let Some(board) = &board {
            let idx = store.index();
            board.use_pull_of_issue(Arc::new(move |issue_id| idx.lock().of_issue(issue_id)));
        }
        Ok(Arc::new(Pulls {
            store,
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

    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some((cancel, handle)) = self.poller.lock().take() {
            cancel.cancel();
            handle.abort();
        }
    }

    pub fn of_issue(&self, issue_id: &str) -> Option<PullRequest> {
        self.store.of_issue(issue_id)
    }

    pub fn find(&self, repo: &str, number: i64) -> Option<PullRecord> {
        self.store.find(repo, number)
    }

    pub fn list(&self) -> Vec<PullRecord> {
        self.store.all()
    }

    pub fn store(&self) -> &PullStore {
        &self.store
    }

    async fn infer_farm_repo_async(&self, cwd: &str) -> Option<String> {
        let repos = self.repos.clone()?;
        let cwd = cwd.to_string();
        crate::spawn_blocking_traced(move || {
            let discovered = vibevalley_git::Repo::discover(Path::new(&cwd)).ok()??;
            let root_real = std::fs::canonicalize(discovered.root()).ok()?;
            let listed = repos.list();
            listed
                .into_iter()
                .find(|p| std::fs::canonicalize(&p.path).ok().as_ref() == Some(&root_real))
                .map(|p| p.name)
        })
        .await
        .ok()
        .flatten()
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
        let name = name.to_string();
        crate::spawn_blocking_traced(move || {
            let found = repos
                .list()
                .into_iter()
                .find(|p| p.name == name)
                .ok_or_else(|| refuse(BizCode::RepoRefused, t("server.repo.github.notGithub", &[])))?;
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&found.path)
                .args(["remote", "get-url", "origin"])
                .output()
                .ok();
            let origin = output
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
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
            self.store
                .upsert_async(UpsertPullInput {
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
            if let (Some(board), Some(id)) = (self.board.clone(), issue_id.map(str::to_owned)) {
                let _ = crate::spawn_blocking_traced(move || board.refresh_issue(&id)).await;
            }
        }
        Ok(out)
    }

    /// Sync shim for synchronous callers (e.g. `team/tool/issue`).
    pub fn publish(&self, req: &SubmitBranch, issue_id: Option<&str>) -> Result<BranchPublication, ApiError> {
        vibevalley_runtime::rt::block_on(self.publish_async(req, issue_id))
    }

    /// Fetches a GitHub pull request snapshot (`checks`, `reviews`, `comments`).
    pub async fn snapshot_async(&self, repo: &str, number: i64) -> Result<GitHubPullSnapshot, ApiError> {
        let remote = self.github_remote_async(repo).await?;
        snapshot::fetch_snapshot(&self.gh, &remote, number).await
    }

    /// Sync shim for synchronous callers (e.g. `team/mcp/resource`).
    pub fn snapshot(&self, repo: &str, number: i64) -> Result<GitHubPullSnapshot, ApiError> {
        vibevalley_runtime::rt::block_on(self.snapshot_async(repo, number))
    }

    pub async fn refresh_async(&self) {
        poll::refresh(self).await;
    }

    pub async fn poll_async(&self) {
        poll::poll(self).await;
    }
}

/// Registers `repo.pr.submit` (user-only) and optionally starts the background poller.
pub fn install(hub: &Hub, pulls: Arc<Pulls>, poll_seconds: Option<u64>) {
    let p = pulls.clone();
    hub.on_async::<ops::RepoPrSubmit, _, _>(move |ctx, req| {
        let p = p.clone();
        async move {
            if ctx.caller != Caller::User {
                return Err(refuse(BizCode::RepoRefused, t("server.repo.publish.userOnly", &[])));
            }
            let issue_id = if let Some(board) = p.board.clone() {
                let cwd = req.cwd.clone();
                let branch = req.branch.clone();
                crate::spawn_blocking_traced(move || board.open_issue_for_branch(&cwd, &branch).map(|i| i.id))
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            p.publish_async(&req, issue_id.as_deref()).await
        }
    });

    if let Some(secs) = poll_seconds {
        let interval = Duration::from_secs(if secs > 0 { secs } else { DEFAULT_POLL_SECONDS });
        let cancel = hub.child_token();
        let task_cancel = cancel.clone();
        let weak = Arc::downgrade(&pulls);
        let span = tracing::debug_span!("pull.poll", interval_secs = interval.as_secs());
        let handle = hub.spawn_task(
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
        *pulls.poller.lock() = Some((cancel, handle));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::team::mcp::{ResourceReadArgs, Resources};
    use crate::modules::work::issue::{Board, NewIssue};
    use crate::modules::work::ledger::BoardConfig;
    use crate::modules::work::session::Trajectories;
    use vibevalley_protocol::{Deliverable, IssueCanceled, IssueStatus, Landing};
    use vibevalley_runtime::oar::Registry;

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
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let mut reg = Registry::new();
        reg.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
        let board = Board::open_on(
            &dir.path().join("server.db"),
            Arc::new(reg),
            BoardConfig::under(dir.path()),
            Arc::new(Arc::downgrade(&hub)),
        )
        .unwrap();

        let issue = board
            .create(NewIssue {
                title: "Ship PR".into(),
                description: "Deliver via followed PR".into(),
                agent: "scripted".into(),
                deliver: Deliverable::Change,
                ..Default::default()
            })
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

        let db = ServerDb::open(dir.path()).unwrap();
        let pulls = Pulls::open(db.clone(), Arc::new(Publisher::default()), None, Some(board.clone()), Some(gh.clone()), None).unwrap();

        // Upsert linked PR and standalone PR (issue_id = None)
        let linked = pulls
            .store()
            .upsert(UpsertPullInput {
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
            .unwrap();
        let standalone = pulls
            .store()
            .upsert(UpsertPullInput {
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
            .unwrap();
        assert_eq!(standalone.issue_id, None);
        board.refresh_issue(&issue.id);
        assert_eq!(board.issue(&issue.id).unwrap().pull_request.as_ref().map(|p| p.number), Some(9));

        // Updating the issue MUST NOT null pull.issue_id (regression test for PutIssue ON CONFLICT DO UPDATE)
        board.move_to(&issue.id, IssueStatus::Todo, None).unwrap();
        let reopened_store = PullStore::open(db.clone()).unwrap();
        assert_eq!(reopened_store.find("acme/demo", 9).unwrap().issue_id.as_deref(), Some(issue.id.as_str()));

        // Snapshot via MCP resource_read (`vv://github/acme/demo/pulls/9` and `/checks`)
        let attachments = crate::modules::content::attachment::Attachments::open(dir.path(), db.clone());
        let chat = crate::modules::collab::channel::Chat::open(db.clone(), &hub, attachments, None, false).unwrap();
        let trajectories = Trajectories::open(db, &hub);
        let resources = Resources::with_pulls(board.clone(), chat, trajectories, pulls.clone());
        let page = resources
            .read(
                None,
                &ResourceReadArgs {
                    uri: "vv://github/acme/demo/pulls/9/checks".into(),
                    offset: None,
                    limit: None,
                },
            )
            .unwrap();
        assert!(page.contains("deadbeef") && page.contains("FAILURE"), "{page}");

        // Poll CI + reviews/comments: viewer skipped, review+inline comment share bot_round 1, standalone bot comment gets bot_round 2
        pulls.poll_async().await;
        let after_poll = pulls.find("acme/demo", 9).unwrap();
        assert_eq!(after_poll.check_revision, 1);
        assert!(!after_poll.check_fingerprint.is_empty());
        let events = pulls.store().known_events_async(&linked.id).await.unwrap();
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
        let settled = board.issue(&issue.id).unwrap();
        assert_eq!(settled.delivered, Some(Landing::PullRequest));

        // Closing an issue's PR settles as Dismissed
        let issue2 = board
            .create(NewIssue {
                title: "Close PR".into(),
                description: "Deliver via followed PR".into(),
                agent: "scripted".into(),
                deliver: Deliverable::Change,
                ..Default::default()
            })
            .unwrap();
        pulls
            .store()
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
        board.refresh_issue(&issue2.id);
        *pr_state.lock() = "CLOSED".into();
        pulls.refresh_async().await;
        assert_eq!(board.issue(&issue2.id).unwrap().canceled, Some(IssueCanceled::Dismissed));

        pulls.close_async().await;
        board.close();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pull_background_poller_preserves_pull_poll_span_and_stops_on_hub_close() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let db = ServerDb::open(dir.path()).unwrap();
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
        let pulls = Pulls::open(db, Arc::new(Publisher::default()), None, None, Some(gh), None).unwrap();
        pulls
            .store()
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
        install(&hub, pulls.clone(), Some(1));

        tokio::time::timeout(Duration::from_secs(5), notify.notified())
            .await
            .expect("background pull poller should fire within 5s");
        assert!(
            seen_span.load(std::sync::atomic::Ordering::SeqCst),
            "pull.poll span must propagate into HostRunner"
        );

        pulls.close_async().await;
        hub.close_async().await;
    }
}
