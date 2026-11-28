//! `repo.pr.submit` over a local bare repository standing in for GitHub
//! (publish.test.ts): preview, refusals, the push and the pull request,
//! the check, a conflict with the base, and the user-only rule.

use crate::support::{RouterTestExt as _, ServerTestExt as _};
mod support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::json;
use vibevalley_protocol::{BranchCheck, Caller, SubmitBranch};
use vibevalley_server::issue::pull::{Answer, HostRun, Network, Publisher, hosted_origin};

fn git(cwd: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git").current_dir(cwd).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

/// The hosted remote is the bare repository, whatever its URL says.
struct Local(PathBuf);

impl Network for Local {
    fn tip(&self, cwd: &Path, _: &str, branch: &str) -> Result<String, String> {
        let out = git(cwd, &["ls-remote", "--refs", self.0.to_str().unwrap(), &format!("refs/heads/{branch}")]);
        out.split('\t')
            .next()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "no ref".into())
    }
    fn fetch(&self, cwd: &Path, _: &str, branch: &str) -> Result<(), String> {
        git(cwd, &["fetch", "--no-tags", self.0.to_str().unwrap(), &format!("refs/heads/{branch}")]);
        Ok(())
    }
    fn push(&self, cwd: &Path, _: &str, branch: &str, sha: &str) -> Result<(), String> {
        git(cwd, &["push", self.0.to_str().unwrap(), &format!("{sha}:refs/heads/{branch}")]);
        Ok(())
    }
}

struct Farm {
    _dir: tempfile::TempDir,
    bare: PathBuf,
    work: PathBuf,
    asked: Arc<Mutex<Vec<Vec<String>>>>,
    publisher: Publisher,
}

fn farm() -> Farm {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let bare = root.join("remote.git");
    let work = root.join("farm");
    std::fs::create_dir_all(&work).unwrap();
    git(&root, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
    git(&work, &["init", "-q", "-b", "main"]);
    git(&work, &["config", "user.email", "me@farm.test"]);
    git(&work, &["config", "user.name", "me"]);
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-q", "-m", "first"]);
    git(&work, &["push", "-q", bare.to_str().unwrap(), "main"]);
    git(&work, &["remote", "add", "origin", "https://github.com/acme/farm.git"]);
    git(&work, &["checkout", "-q", "-b", "fix"]);
    std::fs::write(work.join("a.txt"), "two\n").unwrap();
    git(&work, &["commit", "-q", "-am", "fix it"]);
    let asked = Arc::new(Mutex::new(vec![]));
    let a = asked.clone();
    let gh: HostRun = Arc::new(move |args: &[String]| {
        a.lock().unwrap().push(args.to_vec());
        let out = match (args[0].as_str(), args.get(1).map(String::as_str)) {
            ("repo", Some("view")) => r#"{"defaultBranchRef":{"name":"main"}}"#.to_string(),
            ("pr", Some("list")) => "[]".to_string(),
            ("pr", Some("create")) => "https://github.com/acme/farm/pull/7\n".to_string(),
            _ => String::new(),
        };
        Answer { ok: true, out, missing: false }
    });
    let glab: HostRun = Arc::new(|_: &[String]| Answer {
        ok: false,
        out: String::new(),
        missing: true,
    });
    let publisher = Publisher::new(gh, glab, Arc::new(Local(bare.clone())));
    Farm {
        _dir: dir,
        bare,
        work,
        asked,
        publisher,
    }
}

fn request(f: &Farm) -> SubmitBranch {
    SubmitBranch {
        cwd: f.work.display().to_string(),
        branch: "fix".into(),
        sha: git(&f.work, &["rev-parse", "HEAD"]),
        base: "main".into(),
        title: "fix: say two".into(),
        body: "## What changed".into(),
        dry_run: None,
    }
}

#[test]
fn hosted_origins_are_read_strictly() {
    let o = hosted_origin("git@github.com:acme/farm.git").unwrap();
    assert_eq!((o.host.as_str(), o.name.as_str()), ("github.com", "acme/farm"));
    assert!(hosted_origin("https://gitlab.com/acme/group/farm").is_some());
    assert!(hosted_origin("https://github.com/acme/group/farm").is_none());
    assert!(hosted_origin("https://example.com/acme/farm").is_none());
    assert!(hosted_origin("https://github.com/acme/..").is_none());
}

#[test]
fn a_branch_is_previewed_pushed_and_opened() {
    vibevalley_i18n::set_locale("en");
    let f = farm();
    let preview = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&SubmitBranch {
        dry_run: Some(true),
        ..request(&f)
    }))
    .unwrap();
    assert_eq!(
        (preview.check, preview.pushed, preview.repository.as_str()),
        (BranchCheck::Preview, false, "acme/farm")
    );

    let done = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&request(&f))).unwrap();
    assert!(done.pushed);
    assert_eq!(
        (done.number, done.url.as_deref(), done.reused),
        (Some(7), Some("https://github.com/acme/farm/pull/7"), Some(false))
    );
    assert_eq!(done.check, BranchCheck::NotRun);
    assert_eq!(git(&f.bare, &["rev-parse", "refs/heads/fix"]), done.sha);
    let asked = f.asked.lock().unwrap();
    assert!(
        asked
            .iter()
            .any(|a| a[..2] == ["pr".to_string(), "create".to_string()] && a.contains(&"fix: say two".to_string()))
    );
}

#[test]
fn refusals_say_what_is_wrong() {
    vibevalley_i18n::set_locale("en");
    let f = farm();
    let bad = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&SubmitBranch {
        sha: "nope".into(),
        ..request(&f)
    }))
    .unwrap_err();
    assert!(bad.message.contains("cwd / sha / title"), "{}", bad.message);
    let base = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&SubmitBranch {
        branch: "main".into(),
        ..request(&f)
    }))
    .unwrap_err();
    assert!(base.message.contains("checkout changed or dirty"), "{}", base.message);
    std::fs::write(f.work.join("b.txt"), "dirty").unwrap();
    let dirty = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&request(&f))).unwrap_err();
    assert!(dirty.message.contains("checkout changed or dirty"), "{}", dirty.message);
    std::fs::remove_file(f.work.join("b.txt")).unwrap();
    git(&f.work, &["remote", "add", "other", "https://github.com/acme/other.git"]);
    let two = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&request(&f))).unwrap_err();
    assert!(two.message.contains("ambiguous remote"), "{}", two.message);
    git(&f.work, &["remote", "remove", "other"]);

    // The base moved on to a change that clashes.
    let other = f.work.parent().unwrap().join("other");
    git(f.work.parent().unwrap(), &["clone", "-q", f.bare.to_str().unwrap(), other.to_str().unwrap()]);
    git(&other, &["config", "user.email", "them@farm.test"]);
    git(&other, &["config", "user.name", "them"]);
    std::fs::write(other.join("a.txt"), "three\n").unwrap();
    git(&other, &["commit", "-q", "-am", "theirs"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let clash = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&request(&f))).unwrap_err();
    assert!(clash.message.contains("main"), "{}", clash.message);
    assert!(
        std::process::Command::new("git")
            .current_dir(&f.bare)
            .args(["rev-parse", "--verify", "refs/heads/fix"])
            .output()
            .map(|o| !o.status.success())
            .unwrap()
    );
}

#[test]
fn the_repos_check_runs_before_the_push() {
    vibevalley_i18n::set_locale("en");
    let f = farm();
    std::fs::create_dir_all(f.work.join(".vibevalley")).unwrap();
    let check = f.work.join(".vibevalley/check");
    std::fs::write(&check, "#!/bin/sh\necho checking\necho broken >&2\nexit 3\n").unwrap();
    std::process::Command::new("chmod").arg("+x").arg(&check).status().unwrap();
    git(&f.work, &["add", "."]);
    git(&f.work, &["commit", "-q", "-m", "check"]);
    let failed = vibevalley_runtime::rt::block_on(f.publisher.submit_async(&request(&f))).unwrap_err();
    assert!(
        failed.message.contains("exit status 3") && failed.message.contains("broken"),
        "{}",
        failed.message
    );
    std::fs::write(&check, "#!/bin/sh\nexit 0\n").unwrap();
    git(&f.work, &["commit", "-q", "-am", "check passes"]);
    assert_eq!(
        vibevalley_runtime::rt::block_on(f.publisher.submit_async(&request(&f))).unwrap().check,
        BranchCheck::Passed
    );
}

#[test]
fn only_the_user_publishes() {
    let dir = tempfile::tempdir().unwrap();
    let app = vibevalley_server::app::create_app_with_overrides_blocking(
        vibevalley_server::Config {
            probe_runtimes: false,
            tick_crons: false,
            link_previews: false,
            orchestrator_listens: false,
            ..vibevalley_server::Config::under(dir.path())
        },
        vibevalley_server::app::Overrides {
            publisher: Some(Arc::new(farm().publisher)),
            ..Default::default()
        },
    )
    .unwrap();
    let asked = json!({ "cwd": "/tmp", "branch": "fix", "sha": "0", "base": "main", "title": "t", "body": "" });
    let e = app.router().call_as(Caller::Remote, "repo.pr.submit", asked);
    // The router's `can` refuses it before the endpoint's own rule does.
    let codes = [vibevalley_protocol::BizCode::Forbidden.code(), vibevalley_protocol::BizCode::RepoRefused.code()];
    assert!(codes.contains(&e.biz_code), "{}", e.message);
    app.close_blocking();
}

#[test]
fn pull_request_issue_mandates_records_and_completes_cleanly() {
    use std::time::Duration;
    use vibevalley_protocol::{Landing, PullRequest, PullRequestState};
    use vibevalley_runtime::oar::{Registry, scripted::ScriptedRuntime};
    use vibevalley_server::Config;
    use vibevalley_server::app::{Overrides, create_app_with_overrides_blocking};

    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let bare = root.join("remote.git");
    git(&root, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);

    let gh: HostRun = Arc::new(|args: &[String]| {
        let out = match (args[0].as_str(), args.get(1).map(String::as_str)) {
            ("repo", Some("view")) => r#"{"defaultBranchRef":{"name":"main"}}"#.to_string(),
            ("pr", Some("list")) => "[]".to_string(),
            ("pr", Some("create")) => "https://github.com/acme/farm/pull/7\n".to_string(),
            _ => String::new(),
        };
        Answer { ok: true, out, missing: false }
    });
    let glab: HostRun = Arc::new(|_: &[String]| Answer {
        ok: false,
        out: String::new(),
        missing: true,
    });
    let publisher = Arc::new(Publisher::new(gh, glab, Arc::new(Local(bare.clone()))));

    let mut registry = Registry::new();
    registry.register(Arc::new(ScriptedRuntime::demo()));

    let started = create_app_with_overrides_blocking(
        Config {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            tick_crons: false,
            link_previews: false,
            offline_media: true,
            orchestrator_listens: false,
            ..Config::under(&root)
        },
        Overrides {
            publisher: Some(publisher),
            ..Default::default()
        },
    )
    .unwrap();

    let repo_dir = root.join("repos/farm");
    std::fs::create_dir_all(&repo_dir).unwrap();
    git(&repo_dir, &["init", "-q", "-b", "main"]);
    git(&repo_dir, &["config", "user.email", "me@farm.test"]);
    git(&repo_dir, &["config", "user.name", "me"]);
    std::fs::write(repo_dir.join("a.txt"), "one\n").unwrap();
    git(&repo_dir, &["add", "."]);
    git(&repo_dir, &["commit", "-q", "-m", "first"]);
    git(&repo_dir, &["push", "-q", bare.to_str().unwrap(), "main"]);
    git(&repo_dir, &["remote", "add", "origin", "https://github.com/acme/farm.git"]);

    let mut coder = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    coder.runtime = "scripted".into();
    coder.name = "Coder".into();
    let coder = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(coder)).unwrap();
    let agent_id = coder.id.as_str();

    let created = started
        .router()
        .call(
            "issue.create",
            json!({
                "title": "Open PR for feature",
                "repo": "farm",
                "agent": agent_id,
                "deliver": "pull_request",
                "autoSubmitPr": true
            }),
        )
        .data
        .unwrap();
    let issue_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["mandate"]["autoSubmitPr"], true);
    assert_eq!(created["mandate"]["strength"], "explicit");

    assert_eq!(
        started
            .router()
            .call("issue.status.update", json!({ "id": &issue_id, "status": "todo" }))
            .biz_code,
        0
    );

    let worktree = crate::support::wait_until_transition(started.ctx(), Duration::from_secs(5), "InReview", || {
        let issue = crate::support::board_issue(started.test_internals().board, &issue_id)?;
        if issue.status == vibevalley_protocol::IssueStatus::InReview {
            let sid = issue.latest_session_id()?;
            let session = crate::support::board_session(started.test_internals().board, sid)?;
            return session.cwd.clone().map(PathBuf::from);
        }
        None
    });

    // Completing before a PR is recorded is refused.
    let refused = started.router().call("issue.status.update", json!({ "id": &issue_id, "status": "done" }));
    assert_ne!(refused.biz_code, 0);

    // Autonomous agent creates its feature branch, commits a change, and publishes it via repo.pr.submit.
    git(&worktree, &["config", "user.email", "helper@farm.test"]);
    git(&worktree, &["config", "user.name", "helper"]);
    git(&worktree, &["checkout", "-q", "-b", "vibevalley/issue-1"]);
    std::fs::write(worktree.join("a.txt"), "two\n").unwrap();
    git(&worktree, &["commit", "-q", "-am", "feat: two"]);
    let sha = git(&worktree, &["rev-parse", "HEAD"]);
    let branch = git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]);

    let pubbed = started.router().call(
        "repo.pr.submit",
        json!({
            "cwd": worktree.display().to_string(),
            "branch": branch,
            "sha": sha,
            "base": "main",
            "title": "feat: two",
            "body": "## What changed"
        }),
    );
    assert_eq!(pubbed.biz_code, 0, "{}", pubbed.message);

    let recorded = crate::support::board_issue(started.test_internals().board, &issue_id).unwrap();
    assert_eq!(
        recorded.pull_request,
        Some(PullRequest {
            url: "https://github.com/acme/farm/pull/7".into(),
            number: 7,
            state: PullRequestState::Open,
        })
    );

    // Preview and complete now succeed with Landing::Submitted and keep the PR branch.
    let preview = started
        .router()
        .call("issue.status.previewUpdate", json!({ "id": &issue_id, "status": "done" }));
    assert_eq!(preview.biz_code, 0, "{}", preview.message);

    let done = started.router().call("issue.status.update", json!({ "id": &issue_id, "status": "done" }));
    assert_eq!(done.biz_code, 0, "{}", done.message);
    let finished = crate::support::board_issue(started.test_internals().board, &issue_id).unwrap();
    assert_eq!(finished.delivered, Some(Landing::Submitted));
    assert_eq!(git(&repo_dir, &["rev-parse", &format!("refs/heads/{branch}")]), sha);

    // A change-delivering issue whose followed PR merges finishes automatically with Landing::PullRequest.
    let change_issue = started
        .router()
        .call(
            "issue.create",
            json!({
                "title": "Follow merged PR",
                "repo": "farm",
                "agent": agent_id,
                "deliver": "change"
            }),
        )
        .data
        .unwrap();
    let change_id = change_issue["id"].as_str().unwrap();
    vibevalley_runtime::rt::block_on(started.test_internals().pull.upsert_async(vibevalley_server::issue::pull::UpsertPullInput {
        platform: vibevalley_protocol::PublishPlatform::Github,
        repo: "acme/farm".into(),
        number: 8,
        url: "https://github.com/acme/farm/pull/8".into(),
        branch: "vibevalley/issue-2".into(),
        base: "main".into(),
        state: PullRequestState::Merged,
        issue_id: Some(change_id.into()),
        at: 1000,
    }))
    .unwrap();
    let merged = vibevalley_runtime::rt::block_on(started.test_internals().board.settle_pull_async(change_id, PullRequestState::Merged))
        .unwrap()
        .unwrap();
    assert_eq!(merged.delivered, Some(Landing::PullRequest));

    started.close_blocking();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn github_token_direct_rest_creates_refreshes_merges_and_errors_without_credentials() {
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::Json;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post, put};
    use tokio_util::sync::CancellationToken;
    use vibevalley_protocol::{BizCode, PublishPlatform, PullRequestState};
    use vibevalley_server::Config;
    use vibevalley_server::app::{Overrides, create_app_with_overrides_blocking};

    #[derive(Clone, Default)]
    struct MockPrState {
        created: Arc<AtomicBool>,
        merged: Arc<AtomicBool>,
    }

    vibevalley_i18n::set_locale("en");
    let state = MockPrState::default();
    let router = axum::Router::new()
        .route(
            "/repos/acme/farm",
            get(|| async {
                Json(json!({
                    "default_branch": "main",
                    "permissions": { "push": true }
                }))
            }),
        )
        .route("/repos/acme/farm/pulls", get(|| async { Json(json!([])) }))
        .route(
            "/repos/acme/farm/pulls",
            post(
                |State(st): State<MockPrState>, headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                    assert_eq!(headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer ghp_direct_token"));
                    assert_eq!(body["head"], "fix");
                    assert_eq!(body["base"], "main");
                    assert_eq!(body["title"], "fix: say two");
                    st.created.store(true, Ordering::SeqCst);
                    (
                        StatusCode::CREATED,
                        Json(json!({
                            "number": 7,
                            "html_url": "https://github.com/acme/farm/pull/7",
                            "state": "open"
                        })),
                    )
                },
            ),
        )
        .route(
            "/repos/acme/farm/pulls/7",
            get(|State(st): State<MockPrState>| async move {
                if st.merged.load(Ordering::SeqCst) {
                    Json(json!({
                        "number": 7,
                        "html_url": "https://github.com/acme/farm/pull/7",
                        "state": "closed",
                        "merged": true,
                        "merged_at": "2026-11-27T00:00:00Z"
                    }))
                } else {
                    Json(json!({
                        "number": 7,
                        "html_url": "https://github.com/acme/farm/pull/7",
                        "state": "open",
                        "merged": false,
                        "merged_at": null
                    }))
                }
            }),
        )
        .route(
            "/repos/acme/farm/pulls/7/merge",
            put(|State(st): State<MockPrState>, Json(body): Json<serde_json::Value>| async move {
                assert_eq!(body["merge_method"], "squash");
                st.merged.store(true, Ordering::SeqCst);
                Json(json!({ "merged": true }))
            }),
        )
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let _guard = cancel.clone().drop_guard();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
    });
    let base_url = format!("http://{addr}");

    let mut f = farm();
    let missing_gh: HostRun = Arc::new(|_: &[String]| Answer {
        ok: false,
        out: String::new(),
        missing: true,
    });
    let missing_glab: HostRun = Arc::new(|_: &[String]| Answer {
        ok: false,
        out: String::new(),
        missing: true,
    });

    // Missing both gh and GitHub Token returns explicit missing-credentials error.
    let no_creds_publisher = Publisher::new(missing_gh.clone(), missing_glab.clone(), Arc::new(Local(f.bare.clone())));
    let no_creds_err = no_creds_publisher.submit_async(&request(&f)).await.unwrap_err();
    assert_eq!(no_creds_err.biz_code, BizCode::RepoRefused);
    assert!(no_creds_err.message.contains("GitHub Token"), "{}", no_creds_err.message);
    let repo_hosted = hosted_origin("https://github.com/acme/farm.git").unwrap();
    let merge_no_creds = no_creds_publisher.merge_pull_async(&repo_hosted, 7, Some("squash")).await.unwrap_err();
    assert_eq!(merge_no_creds.biz_code, BizCode::RepoRefused);
    assert!(merge_no_creds.message.contains("GitHub Token"), "{}", merge_no_creds.message);

    // With GitHub Token + missing gh: create PR, refresh state, and merge PR directly via REST API.
    f.publisher = Publisher::new(missing_gh, missing_glab, Arc::new(Local(f.bare.clone()))).with_github_api_for_test(base_url, Some("ghp_direct_token".into()));
    let app_home = tempfile::tempdir().unwrap();
    let publisher = Arc::new(f.publisher);
    let app = tokio::task::spawn_blocking({
        let home = app_home.path().to_path_buf();
        let pub_clone = publisher.clone();
        move || {
            create_app_with_overrides_blocking(
                Config {
                    probe_runtimes: false,
                    tick_crons: false,
                    link_previews: false,
                    orchestrator_listens: false,
                    ..Config::under(&home)
                },
                Overrides {
                    publisher: Some(pub_clone),
                    ..Default::default()
                },
            )
            .unwrap()
        }
    })
    .await
    .unwrap();

    let pull_svc = app.test_internals().pull.clone();
    let created = pull_svc
        .publish_async(
            &SubmitBranch {
                cwd: f.work.display().to_string(),
                branch: "fix".into(),
                sha: git(&f.work, &["rev-parse", "HEAD"]),
                base: "main".into(),
                title: "fix: say two".into(),
                body: "## What changed".into(),
                dry_run: None,
            },
            None,
        )
        .await
        .unwrap();
    assert!(state.created.load(Ordering::SeqCst));
    assert_eq!(created.number, Some(7));
    assert_eq!(created.url.as_deref(), Some("https://github.com/acme/farm/pull/7"));

    let open_state = pull_svc.pull_request_state_async("acme/farm", 7, Some(PublishPlatform::Github)).await.unwrap();
    assert_eq!(open_state, PullRequestState::Open);

    let merged_state = pull_svc
        .merge_pull_async("acme/farm", 7, Some(PublishPlatform::Github), Some("squash"))
        .await
        .unwrap();
    assert_eq!(merged_state, PullRequestState::Merged);
    assert!(state.merged.load(Ordering::SeqCst));

    let refreshed = pull_svc.pull_request_state_async("acme/farm", 7, Some(PublishPlatform::Github)).await.unwrap();
    assert_eq!(refreshed, PullRequestState::Merged);

    tokio::task::spawn_blocking(move || app.close_blocking()).await.unwrap();
}
