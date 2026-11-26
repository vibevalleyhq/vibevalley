use parking_lot::Mutex;
use serde_json::json;

use super::bundle::{extract_login_path, merge_path_entries};
use super::releases::{Manual, Stage};
use super::updater::{Feed, SWAP_SCRIPT, State, Updater, feed_of, writable};

#[test]
fn regression_a_failed_replacement_restores_the_previous_bundle() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("VibeValley.app");
    let next = dir.path().join("next.app");
    let old = dir.path().join("previous.app");
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
        .env("PATH", dir.path())
        .status()
        .unwrap();
    assert!(!status.success());
    assert_eq!(std::fs::read_to_string(current.join("version")).unwrap(), "old");
    assert_eq!(std::fs::read_to_string(next.join("version")).unwrap(), "new");
    assert!(!old.exists());
}

#[test]
fn successful_replacement_removes_previous_bundle_backup() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("VibeValley-Alpha.app");
    let next = dir.path().join(".VibeValley-update-1.app");
    let old = dir.path().join(".VibeValley-previous-1.app");
    std::fs::create_dir(&current).unwrap();
    std::fs::create_dir(&next).unwrap();
    std::fs::write(current.join("version"), "old").unwrap();
    std::fs::write(next.join("version"), "new").unwrap();
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
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read_to_string(current.join("version")).unwrap(), "new");
    assert!(!next.exists());
    assert!(!old.exists());
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
    let updater = Updater {
        version: "0.1.0-alpha.1".into(),
        bundle: None,
        dir: dir.path().join("updates"),
        feed: Feed::Manifest(feed_url),
        state: Mutex::new(State::Failed { why: "previous error".into() }),
        staged: Mutex::new(None),
    };

    // Re-checking from Failed when release.json does not exist yet settles cleanly to Idle.
    updater.check().await;
    assert_eq!(*updater.state.lock(), State::Idle);

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
    assert_eq!(State::Idle.json("0.1.0"), json!({ "_tag": "idle", "version": "0.1.0" }));
    assert_eq!(
        State::Downloading {
            next: "0.2.0".into(),
            percent: 40
        }
        .json("0.1.0"),
        json!({ "_tag": "downloading", "version": "0.1.0", "next": "0.2.0", "percent": 40 })
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
        State::Manual {
            next: "0.2.0".into(),
            why: Manual::DiskImage,
            page: "p".into()
        }
        .json("0.1.0"),
        json!({ "_tag": "manual", "version": "0.1.0", "next": "0.2.0", "why": "diskImage", "page": "p" })
    );
    assert_eq!(
        State::Failed { why: "x".into() }.json("0.1.0"),
        json!({ "_tag": "failed", "version": "0.1.0", "why": "x" })
    );
}

#[tokio::test]
async fn an_app_outside_a_bundle_never_asks_and_has_nothing_to_swap() {
    let dir = tempfile::tempdir().unwrap();
    let updater = Updater {
        version: "0.1.0".into(),
        bundle: None,
        dir: dir.path().to_path_buf(),
        feed: Feed::Off,
        state: Mutex::new(State::Idle),
        staged: Mutex::new(None),
    };
    updater.check().await;
    assert_eq!(updater.state()["_tag"], "idle");
    assert!(!updater.swap(true).await);
    assert!(writable(dir.path()).await);
    assert!(!writable(&dir.path().join("missing")).await);
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
