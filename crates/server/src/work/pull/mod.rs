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

use crate::app::refusal::refused as refuse;
use crate::app::runtime::Runtime;
use crate::db::ServerDb;
use crate::work::issue::IssueStore;
use crate::work::ledger::now;
use crate::work::repo::RepoStore;

use publish::HostRunner;
pub use publish::{Answer, HostRun, HostedRepo, Network, Publisher, hosted_origin};
pub use snapshot::{GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, actions_job_of, checks_fingerprint, checks_verdict};
pub use store::{KnownPullEvent, PullIndex, PullRecord, PullRepo, UpsertPullInput};

const DEFAULT_POLL_SECONDS: u64 = 180;

pub struct PullStore {
    pub(crate) store: PullRepo,
    pub(crate) publisher: Arc<Publisher>,
    pub(crate) repos: Option<Arc<RepoStore>>,
    pub(crate) board: Option<IssueStore>,
    pub(crate) gh: HostRunner,
    pub(crate) glab: HostRunner,
    pub(crate) refresh_lock: tokio::sync::Mutex<()>,
    pub(crate) poll_lock: tokio::sync::Mutex<()>,
    closed: std::sync::atomic::AtomicBool,
    poller: Mutex<Option<(CancellationToken, tokio::task::JoinHandle<()>)>>,
}

impl PullStore {
    /// Opens `pull` and `pull_event` on the shared `ServerDb` and wires
    /// `Issue.pull_request` projection onto `board` when present.
    pub async fn open_async(
        db: Arc<ServerDb>,
        publisher: Arc<Publisher>,
        repos: Option<Arc<RepoStore>>,
        board: Option<IssueStore>,
        gh: Option<HostRun>,
        glab: Option<HostRun>,
    ) -> Result<Arc<PullStore>, ApiError> {
        let store = PullRepo::open_async(db).await?;
        if let Some(board) = &board {
            let idx = store.index();
            board.use_pull_of_issue_async(Arc::new(move |issue_id| idx.lock().of_issue(issue_id))).await;
        }
        Ok(Arc::new(PullStore {
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

    pub fn store(&self) -> &PullRepo {
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

    /// Starts the background PR refresh/poll loop on `runtime`.
    pub fn start_poller(self: &Arc<Self>, runtime: &Runtime, poll_seconds: Option<u64>) {
        let Some(secs) = poll_seconds else { return };
        let interval = Duration::from_secs(if secs > 0 { secs } else { DEFAULT_POLL_SECONDS });
        let cancel = runtime.child_token();
        let task_cancel = cancel.clone();
        let weak = Arc::downgrade(self);
        let span = tracing::debug_span!("pull.poll", interval_secs = interval.as_secs());
        let handle = runtime.spawn(
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
    use crate::app::live::LiveOverlay;
    use crate::app::outbox::Outbox;
    use crate::app::slice::SliceProjector;
    use crate::work::issue::{IssueStore, NewIssue};
    use crate::work::ledger::BoardConfig;
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
        let db_path = dir.path().join("server.db");
        let db = ServerDb::open_config(&crate::db::DatabaseConfig::Sqlite { path: db_path.clone() }).unwrap();
        let live = LiveOverlay::new();
        let projector = SliceProjector::new();
        let outbox = Outbox::new(db.clone());
        let runtime = Runtime::new();
        let mut reg = Registry::new();
        reg.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
        let board = IssueStore::open_async(
            &db_path,
            live,
            projector,
            outbox,
            runtime.clone(),
            Arc::new(reg),
            BoardConfig::under(dir.path()),
            None,
        )
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

        let pulls = PullStore::open_async(db.clone(), Arc::new(Publisher::default()), None, Some(board.clone()), Some(gh.clone()), None)
            .await
            .unwrap();

        // Upsert linked PR and standalone PR (issue_id = None)
        let linked = pulls
            .store()
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
            .store()
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
        let reopened_store = PullRepo::open_async(db.clone()).await.unwrap();
        assert_eq!(reopened_store.find("acme/demo", 9).unwrap().issue_id.as_deref(), Some(issue.id.as_str()));

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
        board.refresh_issue_async(&issue2.id).await;
        *pr_state.lock() = "CLOSED".into();
        pulls.refresh_async().await;
        assert_eq!(board.issue_async(&issue2.id).await.unwrap().unwrap().canceled, Some(IssueCanceled::Dismissed));

        pulls.close_async().await;
        board.close();
        let _ = runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pull_background_poller_preserves_pull_poll_span_and_stops_on_runtime_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new();
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
        let pulls = PullStore::open_async(db, Arc::new(Publisher::default()), None, None, Some(gh), None)
            .await
            .unwrap();
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
        pulls.start_poller(&runtime, Some(1));

        tokio::time::timeout(Duration::from_secs(5), notify.notified())
            .await
            .expect("background pull poller should fire within 5s");
        assert!(
            seen_span.load(std::sync::atomic::Ordering::SeqCst),
            "pull.poll span must propagate into HostRunner"
        );

        pulls.close_async().await;
        let _ = runtime.shutdown(Duration::from_secs(1)).await;
    }
}
