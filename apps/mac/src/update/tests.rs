use std::io::Write as _;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::get;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::{CancellationToken, DropGuard};

use super::bundle::{extract_login_path, merge_path_entries};
use super::fetch::{FailureKind, measure};
use super::releases::{Manual, Stage};
use super::updater::{
    Feed, SWAP_SCRIPT, Staged, State, Updater, cleanup_old_versions, cleanup_stale_bundle_leftovers, feed_of, recover_swap_failure, writable,
};

async fn spawn_mock(router: Router) -> (SocketAddr, DropGuard) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let guard = cancel.clone().drop_guard();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
    });
    (addr, guard)
}

#[test]
fn regression_a_failed_replacement_restores_the_previous_bundle() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("VibeValley.app");
    let next = dir.path().join("next.app");
    let old = dir.path().join("previous.app");
    let updates_dir = dir.path().join("updates");
    std::fs::create_dir(&current).unwrap();
    std::fs::create_dir(&next).unwrap();
    std::fs::write(current.join("version"), "old").unwrap();
    std::fs::write(next.join("version"), "new").unwrap();
    let mv = dir.path().join("mv");
    std::fs::write(&mv, "#!/bin/sh\ncase \"$1\" in */next.app) exit 1;; esac\nexec /bin/mv \"$@\"\n").unwrap();
    std::fs::set_permissions(&mv, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut finished = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let pid = finished.id();
    finished.wait().unwrap();
    let status = std::process::Command::new("/bin/sh")
        .args(["-c", SWAP_SCRIPT, "swap"])
        .arg(pid.to_string())
        .arg(&current)
        .arg(&next)
        .arg(&old)
        .arg("0")
        .arg(&updates_dir)
        .arg("0.2.0")
        .arg("https://example.test/v0.2.0")
        .env("PATH", dir.path())
        .status()
        .unwrap();
    assert!(!status.success());
    assert_eq!(std::fs::read_to_string(current.join("version")).unwrap(), "old");
    assert_eq!(std::fs::read_to_string(next.join("version")).unwrap(), "new");
    assert!(!old.exists());

    let log = std::fs::read_to_string(updates_dir.join("swap.log")).unwrap();
    assert!(log.contains("swap failed (0.2.0)"), "{log}");
    let marker = std::fs::read_to_string(updates_dir.join("swap-failed.txt")).unwrap();
    let lines: Vec<&str> = marker.lines().collect();
    assert_eq!(lines[0], "0.2.0");
    assert!(lines[1].contains("could not move updated app into place"), "{marker}");
    assert_eq!(lines[2], "https://example.test/v0.2.0");
    assert!(
        std::fs::read_dir(&updates_dir)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp.")),
        "atomic swap-failed marker left a temp file behind"
    );
}

#[test]
fn successful_replacement_removes_previous_bundle_backup_and_stale_marker() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("VibeValley-Alpha.app");
    let next = dir.path().join(".VibeValley-update-1.app");
    let old = dir.path().join(".VibeValley-previous-1.app");
    let updates_dir = dir.path().join("updates");
    std::fs::create_dir(&current).unwrap();
    std::fs::create_dir(&next).unwrap();
    std::fs::create_dir(&updates_dir).unwrap();
    std::fs::write(current.join("version"), "old").unwrap();
    std::fs::write(next.join("version"), "new").unwrap();
    std::fs::write(updates_dir.join("swap-failed.txt"), "0.1.9\nold error\n").unwrap();
    let mut finished = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let pid = finished.id();
    finished.wait().unwrap();
    let status = std::process::Command::new("/bin/sh")
        .args(["-c", SWAP_SCRIPT, "swap"])
        .arg(pid.to_string())
        .arg(&current)
        .arg(&next)
        .arg(&old)
        .arg("0")
        .arg(&updates_dir)
        .arg("0.2.0")
        .arg("")
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read_to_string(current.join("version")).unwrap(), "new");
    assert!(!next.exists());
    assert!(!old.exists());
    assert!(!updates_dir.join("swap-failed.txt").exists());
}

#[test]
fn swap_failed_marker_recovers_on_startup_and_clears_when_version_matches() {
    let dir = tempfile::tempdir().unwrap();
    let updates_dir = dir.path().join("updates");
    std::fs::create_dir(&updates_dir).unwrap();
    let marker = updates_dir.join("swap-failed.txt");

    // Different version -> starts in Failed(Install) with page and deletes marker.
    std::fs::write(&marker, "0.2.0\ncould not move updated app into place\nhttps://example.test/v0.2.0\n").unwrap();
    let updater = Updater::new(
        "0.1.0".into(),
        None,
        updates_dir.clone(),
        Feed::Manifest("https://example.test/release.json".into()),
    );
    assert!(!marker.exists());
    assert_eq!(
        *updater.state.lock(),
        State::Failed {
            kind: FailureKind::Install,
            why: "Failed to install 0.2.0: could not move updated app into place".into(),
            page: Some("https://example.test/v0.2.0".into()),
        }
    );

    // Matching version -> update actually succeeded, silently clear marker and start Idle.
    std::fs::write(&marker, "0.2.0\nstale error\nhttps://example.test/v0.2.0\n").unwrap();
    let recovered = recover_swap_failure(&updates_dir, "0.2.0");
    assert!(recovered.is_none());
    assert!(!marker.exists());
}

#[test]
fn only_a_packaged_tagged_app_asks_and_within_its_own_stage() {
    assert_eq!(feed_of(None, None, false, "0.4.0"), Feed::Off);
    assert_eq!(feed_of(Some("http://127.0.0.1:1/release.json"), None, false, "0.4.0"), Feed::Off);
    assert_eq!(feed_of(None, Some("file:///dist/release.json"), false, "0.4.0-alpha.1"), Feed::Off);
    assert_eq!(feed_of(None, None, true, "0.0.0"), Feed::Off);
    assert_eq!(feed_of(None, Some("file:///dist/release.json"), true, "0.0.0"), Feed::Off);
    assert_eq!(feed_of(None, None, true, "not a version"), Feed::Off);
    assert_eq!(feed_of(None, None, true, "0.4.0"), Feed::Stage(Stage::Stable));
    assert_eq!(feed_of(None, None, true, "0.4.0-beta.2"), Feed::Stage(Stage::Beta));
    assert_eq!(feed_of(None, None, true, "0.4.0-alpha.1"), Feed::Stage(Stage::Alpha));
    assert_eq!(feed_of(Some(""), None, true, "0.4.0"), Feed::Stage(Stage::Stable));
    assert_eq!(feed_of(Some("off"), Some("file:///dist/release.json"), true, "0.4.0-alpha.1"), Feed::Off);
    assert_eq!(
        feed_of(Some("http://127.0.0.1:1/release.json"), Some("file:///dist/release.json"), true, "0.0.0"),
        Feed::Manifest("http://127.0.0.1:1/release.json".into())
    );
}

#[test]
fn alpha_uses_local_plist_file_feed_while_beta_and_release_ignore_it() {
    let local = "file:///Users/dev/vibevalley/apps/mac/dist/release.json";
    assert_eq!(feed_of(None, Some(local), true, "0.1.0-alpha.1"), Feed::Manifest(local.into()));
    assert_eq!(feed_of(Some(""), Some(local), true, "0.1.0-alpha.1"), Feed::Manifest(local.into()));
    // Beta and Release never read local file:// feeds from Info.plist.
    assert_eq!(feed_of(None, Some(local), true, "0.1.0-beta.1"), Feed::Stage(Stage::Beta));
    assert_eq!(feed_of(None, Some(local), true, "0.1.0"), Feed::Stage(Stage::Stable));
    // Valid https:// plist feeds are accepted across packaged channels; plain http:// is ignored.
    let https = "https://releases.vibevalley.dev/release.json";
    assert_eq!(feed_of(None, Some(https), true, "0.1.0-beta.1"), Feed::Manifest(https.into()));
    assert_eq!(feed_of(None, Some(https), true, "0.1.0"), Feed::Manifest(https.into()));
    assert_eq!(
        feed_of(None, Some("http://127.0.0.1:8787/release.json"), true, "0.1.0-alpha.1"),
        Feed::Stage(Stage::Alpha)
    );
}

#[tokio::test]
async fn manual_recheck_recovers_from_failed_and_idle_without_clobbering_ready() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = dir.path().join("release.json");
    let feed_url = url::Url::from_file_path(&manifest).unwrap().to_string();
    let updater = Updater::new("0.1.0-alpha.1".into(), None, dir.path().join("updates"), Feed::Manifest(feed_url));
    *updater.state.lock() = State::Failed {
        kind: FailureKind::Network,
        why: "previous error".into(),
        page: None,
    };

    // Re-checking from Failed when release.json does not exist yet settles cleanly to Idle with checkedAt.
    updater.check().await;
    match *updater.state.lock() {
        State::Idle { checked_at } => assert!(checked_at.is_some()),
        ref other => panic!("expected Idle, got {other:?}"),
    }

    // Writing a newer local alpha manifest is picked up immediately on the next Idle check.
    std::fs::write(&manifest, r#"{"version":"0.1.0-alpha.2","notes":["Local fix"],"page":"","builds":[]}"#).unwrap();
    updater.check().await;
    assert_eq!(
        *updater.state.lock(),
        State::Manual {
            next: "0.1.0-alpha.2".into(),
            why: Manual::NoBuild,
            page: String::new(),
        }
    );

    // Once Ready, an extra check must not disturb the staged update.
    let ready = State::Ready {
        next: "0.1.0-alpha.2".into(),
        notes: vec!["Local fix".into()],
        page: String::new(),
    };
    *updater.state.lock() = ready.clone();
    updater.check().await;
    assert_eq!(*updater.state.lock(), ready);
}

#[test]
fn each_state_is_said_in_the_contracts_shape() {
    assert_eq!(State::Disabled.json("0.1.0"), json!({ "_tag": "disabled", "version": "0.1.0" }));
    assert_eq!(State::Idle { checked_at: None }.json("0.1.0"), json!({ "_tag": "idle", "version": "0.1.0" }));
    assert_eq!(
        State::Idle {
            checked_at: Some(1_700_000_000_000)
        }
        .json("0.1.0"),
        json!({ "_tag": "idle", "version": "0.1.0", "checkedAt": 1_700_000_000_000_i64 })
    );
    assert_eq!(State::Checking.json("0.1.0"), json!({ "_tag": "checking", "version": "0.1.0" }));
    assert_eq!(
        State::Downloading {
            next: "0.2.0".into(),
            percent: 40,
            downloaded_bytes: 400,
            total_bytes: 1000,
            speed_bps: None,
        }
        .json("0.1.0"),
        json!({ "_tag": "downloading", "version": "0.1.0", "next": "0.2.0", "percent": 40, "downloadedBytes": 400, "totalBytes": 1000 })
    );
    assert_eq!(
        State::Downloading {
            next: "0.2.0".into(),
            percent: 75,
            downloaded_bytes: 750,
            total_bytes: 1000,
            speed_bps: Some(12345),
        }
        .json("0.1.0"),
        json!({
            "_tag": "downloading",
            "version": "0.1.0",
            "next": "0.2.0",
            "percent": 75,
            "downloadedBytes": 750,
            "totalBytes": 1000,
            "speedBps": 12345
        })
    );
    assert_eq!(
        State::Verifying { next: "0.2.0".into() }.json("0.1.0"),
        json!({ "_tag": "verifying", "version": "0.1.0", "next": "0.2.0" })
    );
    assert_eq!(
        State::Ready {
            next: "0.2.0".into(),
            notes: vec!["One".into()],
            page: "p".into()
        }
        .json("0.1.0"),
        json!({ "_tag": "ready", "version": "0.1.0", "next": "0.2.0", "notes": ["One"], "newFarm": false, "page": "p" })
    );
    assert_eq!(
        State::Installing { next: "0.2.0".into() }.json("0.1.0"),
        json!({ "_tag": "installing", "version": "0.1.0", "next": "0.2.0" })
    );
    assert_eq!(
        State::Manual {
            next: "0.2.0".into(),
            why: Manual::DiskImage,
            page: "p".into()
        }
        .json("0.1.0"),
        json!({ "_tag": "manual", "version": "0.1.0", "next": "0.2.0", "why": "diskImage", "page": "p" })
    );
    assert_eq!(
        State::Failed {
            kind: FailureKind::Network,
            why: "x".into(),
            page: None,
        }
        .json("0.1.0"),
        json!({ "_tag": "failed", "version": "0.1.0", "kind": "network", "why": "x" })
    );
    assert_eq!(
        State::Failed {
            kind: FailureKind::Install,
            why: "boom".into(),
            page: Some("https://example.test/v0.2.0".into()),
        }
        .json("0.1.0"),
        json!({ "_tag": "failed", "version": "0.1.0", "kind": "install", "why": "boom", "page": "https://example.test/v0.2.0" })
    );
}

#[tokio::test]
async fn an_app_outside_a_bundle_starts_disabled_never_asks_and_has_nothing_to_swap() {
    let dir = tempfile::tempdir().unwrap();
    let updater = Updater::new("0.1.0".into(), None, dir.path().to_path_buf(), Feed::Off);
    assert_eq!(updater.state()["_tag"], "disabled");
    assert!(!updater.begin_check());
    updater.check().await;
    assert_eq!(updater.state()["_tag"], "disabled");
    assert_eq!(updater.swap(true).await.unwrap_err(), "no update is ready");
    assert!(writable(dir.path()).await);
    assert!(!writable(&dir.path().join("missing")).await);
}

#[tokio::test]
async fn begin_check_is_non_blocking_emits_push_events_and_deduplicates_concurrent_checks() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = dir.path().join("release.json");
    std::fs::write(&manifest, r#"{"version":"0.1.0","notes":[],"page":"","builds":[]}"#).unwrap();
    let feed_url = url::Url::from_file_path(&manifest).unwrap().to_string();
    let updater = Updater::new("0.1.0".into(), None, dir.path().join("updates"), Feed::Manifest(feed_url));
    let mut rx = updater.subscribe();
    assert_eq!(rx.borrow()["_tag"], "idle");

    assert!(updater.begin_check());
    // Second concurrent check is ignored while already Checking.
    assert!(!updater.begin_check());

    rx.changed().await.unwrap();
    assert_eq!(rx.borrow_and_update()["_tag"], "checking");

    updater.run_check().await;
    rx.changed().await.unwrap();
    let settled = rx.borrow_and_update().clone();
    assert_eq!(settled["_tag"], "idle");
    assert!(settled["checkedAt"].as_i64().is_some());
}

#[tokio::test]
async fn updater_classifies_http_and_manifest_failures_and_uses_etag_cache() {
    let dir = tempfile::tempdir().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let not_modified_hits = Arc::new(AtomicUsize::new(0));
    let server_hits = hits.clone();
    let server_304 = not_modified_hits.clone();

    let app = Router::new()
        .route("/403", get(|| async { (StatusCode::FORBIDDEN, "rate limited") }))
        .route("/bad-json", get(|| async { (StatusCode::OK, "not json") }))
        .route(
            "/bad-version",
            get(|| async { (StatusCode::OK, r#"{"version":"bad","page":"https://example.test/p","builds":[]}"#) }),
        )
        .route(
            "/etag",
            get(move |headers: HeaderMap| {
                server_hits.fetch_add(1, Ordering::SeqCst);
                let s304 = server_304.clone();
                async move {
                    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some("\"etag-1\"") {
                        s304.fetch_add(1, Ordering::SeqCst);
                        Response::builder().status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap()
                    } else {
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::ETAG, "\"etag-1\"")
                            .body(Body::from(r#"{"version":"0.1.0","notes":[],"page":"","builds":[]}"#))
                            .unwrap()
                    }
                }
            }),
        );
    let (addr, _guard) = spawn_mock(app).await;

    let rate_limited = Updater::new("0.1.0".into(), None, dir.path().join("u1"), Feed::Manifest(format!("http://{addr}/403")));
    rate_limited.check().await;
    assert_eq!(rate_limited.state()["_tag"], "failed");
    assert_eq!(rate_limited.state()["kind"], "rateLimit");

    let bad_json = Updater::new("0.1.0".into(), None, dir.path().join("u2"), Feed::Manifest(format!("http://{addr}/bad-json")));
    bad_json.check().await;
    assert_eq!(bad_json.state()["_tag"], "failed");
    assert_eq!(bad_json.state()["kind"], "integrity");

    let bad_ver = Updater::new(
        "0.1.0".into(),
        None,
        dir.path().join("u3"),
        Feed::Manifest(format!("http://{addr}/bad-version")),
    );
    bad_ver.check().await;
    assert_eq!(bad_ver.state()["_tag"], "failed");
    assert_eq!(bad_ver.state()["kind"], "integrity");
    assert_eq!(bad_ver.state()["page"], "https://example.test/p");

    // ETag cache hit across consecutive checks.
    let cached = Updater::new("0.1.0".into(), None, dir.path().join("u4"), Feed::Manifest(format!("http://{addr}/etag")));
    cached.check().await;
    assert_eq!(cached.state()["_tag"], "idle");
    cached.check().await;
    assert_eq!(cached.state()["_tag"], "idle");
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    assert_eq!(not_modified_hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn swap_emits_installing_and_transitions_to_failed_install_if_staging_fails() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("VibeValley.app");
    std::fs::create_dir(&bundle).unwrap();
    let updater = Updater::new(
        "0.1.0".into(),
        Some(bundle.clone()),
        dir.path().join("updates"),
        Feed::Manifest("https://example.test/release.json".into()),
    );
    *updater.staged.lock() = Some(Staged {
        version: "0.2.0".into(),
        page: "https://example.test/v0.2.0".into(),
        app: dir.path().join("missing-staged.app"),
        bundle,
    });
    *updater.state.lock() = State::Ready {
        next: "0.2.0".into(),
        notes: vec![],
        page: "https://example.test/v0.2.0".into(),
    };

    let mut rx = updater.subscribe();
    let watcher = tokio::spawn(async move {
        let mut seen = Vec::new();
        while rx.changed().await.is_ok() {
            let tag = rx.borrow_and_update()["_tag"].as_str().unwrap_or_default().to_string();
            let done = tag == "failed";
            seen.push(tag);
            if done {
                break;
            }
        }
        seen
    });
    tokio::task::yield_now().await;

    let swap_err = updater.swap(true).await.unwrap_err();
    assert!(swap_err.contains("cannot stage beside"), "{swap_err}");
    let seen = watcher.await.unwrap();
    assert!(seen.contains(&"installing".to_string()), "expected installing transition, saw {seen:?}");
    assert!(seen.contains(&"failed".to_string()), "expected failed transition, saw {seen:?}");
    let final_state = updater.state();
    assert_eq!(final_state["_tag"], "failed");
    assert_eq!(final_state["kind"], "install");
    assert_eq!(final_state["page"], "https://example.test/v0.2.0");
}

#[tokio::test]
async fn cleanup_removes_obsolete_version_dirs_and_stale_bundle_leftovers() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    std::fs::create_dir_all(updates.join("0.1.0")).unwrap();
    std::fs::create_dir_all(updates.join("0.2.0-alpha.1")).unwrap();
    std::fs::create_dir_all(updates.join("0.3.0")).unwrap();
    std::fs::create_dir_all(updates.join("non-version-dir")).unwrap();
    std::fs::write(updates.join("swap.log"), "log").unwrap();
    std::fs::write(updates.join("swap.sh"), "#!/bin/sh\n").unwrap();

    cleanup_old_versions(&updates, "0.3.0").await;

    assert!(!updates.join("0.1.0").exists());
    assert!(!updates.join("0.2.0-alpha.1").exists());
    assert!(updates.join("0.3.0").is_dir());
    assert!(updates.join("non-version-dir").is_dir());
    assert!(updates.join("swap.log").is_file());
    assert!(updates.join("swap.sh").is_file());

    let bundle = dir.path().join("VibeValley.app");
    std::fs::create_dir(&bundle).unwrap();
    let mut finished = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let dead_pid = finished.id();
    finished.wait().unwrap();
    let own_pid = std::process::id();

    let dead_update = dir.path().join(format!(".VibeValley-update-{dead_pid}.app"));
    let dead_prev = dir.path().join(format!(".VibeValley-previous-{dead_pid}.app"));
    let own_update = dir.path().join(format!(".VibeValley-update-{own_pid}.app"));
    std::fs::create_dir(&dead_update).unwrap();
    std::fs::create_dir(&dead_prev).unwrap();
    std::fs::create_dir(&own_update).unwrap();

    cleanup_stale_bundle_leftovers(&bundle).await;

    assert!(!dead_update.exists());
    assert!(!dead_prev.exists());
    assert!(own_update.is_dir());
    assert!(bundle.is_dir());
}

#[tokio::test]
async fn end_to_end_check_emits_verifying_stages_update_and_cleans_old_versions() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = tempfile::tempdir().unwrap();
    let apps_dir = dir.path().join("apps");
    let dist_dir = dir.path().join("dist");
    let updates_dir = dir.path().join("updates");
    std::fs::create_dir_all(&apps_dir).unwrap();
    std::fs::create_dir_all(&dist_dir).unwrap();
    std::fs::create_dir_all(updates_dir.join("0.0.9")).unwrap();

    let make_signed_bundle = |parent: &std::path::Path, version: &str| {
        let app = parent.join("VibeValley.app");
        let macos = app.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>\
             <key>CFBundleExecutable</key><string>VibeValley</string>\
             <key>CFBundleIdentifier</key><string>dev.vibevalley.app</string>\
             <key>CFBundleShortVersionString</key><string>{version}</string>\
             <key>VibeValleyVersion</key><string>{version}</string>\
             </dict></plist>"
        );
        std::fs::write(app.join("Contents/Info.plist"), plist).unwrap();
        let bin = macos.join("VibeValley");
        std::fs::copy("/usr/bin/true", &bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let signed = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--deep", "--sign", "-"])
            .arg(&app)
            .status()
            .unwrap();
        assert!(signed.success(), "ad-hoc codesign failed");
        app
    };

    let running_app = make_signed_bundle(&apps_dir, "0.1.0");
    let next_staging = dir.path().join("next_src");
    std::fs::create_dir_all(&next_staging).unwrap();
    let next_app = make_signed_bundle(&next_staging, "0.2.0");

    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let zip_name = format!("VibeValley-0.2.0-{arch}.zip");
    let zip_path = dist_dir.join(&zip_name);
    let packed = std::process::Command::new("/usr/bin/ditto")
        .args(["-c", "-k", "--keepParent"])
        .arg(&next_app)
        .arg(&zip_path)
        .status()
        .unwrap();
    assert!(packed.success());

    let (size, sha512) = measure(&zip_path).unwrap();
    let zip_bytes = Arc::new(std::fs::read(&zip_path).unwrap());
    let manifest_json = Arc::new(
        json!({
            "version": "0.2.0",
            "notes": ["Faster updates"],
            "page": "https://example.test/v0.2.0",
            "builds": [{ "arch": arch, "file": zip_name, "size": size, "sha512": sha512 }]
        })
        .to_string(),
    );

    let m_body = manifest_json.clone();
    let z_body = zip_bytes.clone();
    let router = Router::new()
        .route(
            "/release.json",
            get(move || {
                let body = m_body.clone();
                async move { (StatusCode::OK, (*body).clone()) }
            }),
        )
        .route(
            &format!("/{zip_name}"),
            get(move || {
                let bytes = z_body.clone();
                async move { (StatusCode::OK, (*bytes).clone()) }
            }),
        );
    let (addr, _guard) = spawn_mock(router).await;

    let updater = Updater::new(
        "0.1.0".into(),
        Some(running_app),
        updates_dir.clone(),
        Feed::Manifest(format!("http://{addr}/release.json")),
    );

    let mut rx = updater.subscribe();
    let seen = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let seen_task = seen.clone();
    let watcher = tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            let tag = rx.borrow_and_update()["_tag"].as_str().unwrap_or_default().to_string();
            let done = tag == "ready" || tag == "failed";
            seen_task.lock().push(tag);
            if done {
                break;
            }
        }
    });
    // Let the watcher subscribe to the watch channel's notify before check starts.
    tokio::task::yield_now().await;

    updater.check().await;
    let _ = watcher.await;

    let final_state = updater.state();
    assert_eq!(final_state["_tag"], "ready", "unexpected state: {final_state}");
    assert_eq!(final_state["next"], "0.2.0");
    assert_eq!(final_state["notes"], json!(["Faster updates"]));

    // Old version folder was cleaned up once 0.2.0 was staged.
    assert!(!updates_dir.join("0.0.9").exists());
    assert!(updates_dir.join("0.2.0").is_dir());

    let tags = seen.lock().clone();
    assert!(tags.contains(&"verifying".to_string()), "expected verifying transition, saw {tags:?}");
    assert!(tags.contains(&"ready".to_string()), "tags: {tags:?}");
    let _ = std::io::stdout().flush();
}

#[test]
fn login_path_extraction_and_merging_preserve_overrides_and_user_tools() {
    assert_eq!(
        extract_login_path("banner\n__VV_PATH__/opt/homebrew/bin:/usr/bin__VV_END__\n"),
        Some("/opt/homebrew/bin:/usr/bin")
    );
    assert_eq!(extract_login_path("__VV_PATH____VV_END__"), None);
    let launchd = std::ffi::OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin");
    let login = std::ffi::OsStr::new("/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    assert_eq!(merge_path_entries(Some(launchd), login), login);
    let custom = std::ffi::OsStr::new("/tmp/mock-bin:/usr/bin:/bin");
    assert_eq!(
        merge_path_entries(Some(custom), login),
        std::ffi::OsStr::new("/tmp/mock-bin:/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    );
}
