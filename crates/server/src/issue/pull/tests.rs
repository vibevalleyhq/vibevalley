use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use vibevalley_protocol::{Deliverable, IssueCanceled, IssueStatus, Landing, PublishPlatform, PullRequestState};
use vibevalley_runtime::oar::Registry;

use super::publish::{Answer, HostRun, Publisher};
use super::service::{Pull, PullIndex};
use super::snapshot::{self, GitHubCheck, actions_job_of, checks_fingerprint, checks_verdict};
use crate::context::{Context, Http, LiveState, Outbox, StateFeed, TaskGroup};
use crate::issue::{Board, BoardConfig, NewIssue};
use crate::service::Service;
use crate::service::issue::{PullRecord, UpsertPullInput};

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
    let snap = snapshot::fetch_snapshot(&pulls.gh, None, "acme/demo", 9).await.unwrap();
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fetch_snapshot_uses_github_rest_api_for_checks_and_errors_without_credentials() {
    use axum::Json;
    use axum::routing::get;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::publish::HostRunner;
    use crate::repo::GitHubRest;
    use crate::setting::Secret;

    vibevalley_i18n::set_locale("en");
    let router = axum::Router::new()
        .route(
            "/repos/acme/demo/pulls/12",
            get(|| async {
                Json(json!({
                    "state": "closed",
                    "merged": true,
                    "merged_at": "2026-11-27T00:00:00Z",
                    "head": { "sha": "deadbeef1234" }
                }))
            }),
        )
        .route(
            "/repos/acme/demo/commits/deadbeef1234/check-runs",
            get(|| async {
                Json(json!({
                    "check_runs": [
                        {
                            "name": "ci / rust",
                            "status": "completed",
                            "conclusion": "success",
                            "details_url": "https://github.com/acme/demo/actions/runs/9/job/99"
                        }
                    ]
                }))
            }),
        )
        .route("/repos/acme/demo/pulls/12/reviews", get(|| async { Json(json!([])) }))
        .route("/repos/acme/demo/pulls/12/comments", get(|| async { Json(json!([])) }))
        .route("/repos/acme/demo/issues/12/comments", get(|| async { Json(json!([])) }))
        .route("/user", get(|| async { Json(json!({ "login": "octocat" })) }));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let _guard = cancel.clone().drop_guard();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
    });

    let missing_gh = HostRunner::Custom(Arc::new(|_| Answer {
        ok: false,
        out: String::new(),
        missing: true,
    }));
    let rest = GitHubRest::with_base(format!("http://{addr}"), Arc::new(|| Some(Secret::new("ghp_snap"))));
    let snap = snapshot::fetch_snapshot(&missing_gh, Some(&rest), "acme/demo", 12).await.unwrap();
    assert_eq!(snap.state, "MERGED");
    assert_eq!(snap.head, "deadbeef1234");
    assert_eq!(snap.viewer, "octocat");
    assert_eq!(snap.checks.len(), 1);
    assert_eq!(snap.checks[0].name, "ci / rust");
    assert_eq!(snap.checks[0].status, "COMPLETED");
    assert_eq!(snap.checks[0].conclusion, "SUCCESS");

    let missing_err = snapshot::fetch_snapshot(&missing_gh, None, "acme/demo", 12).await.unwrap_err();
    assert_eq!(missing_err.biz_code, vibevalley_protocol::BizCode::RepoRefused.code());
    assert!(missing_err.message.contains("GitHub Token"), "{}", missing_err.message);
}
