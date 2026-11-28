use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::platform::objc_app::{self, CfPrefValue};
use crate::platform::oslog_ffi::{OS_LOG_TYPE_DEBUG, OS_LOG_TYPE_DEFAULT, OS_LOG_TYPE_ERROR, OS_LOG_TYPE_INFO};
use crate::platform::system_observer_ffi;

use super::editors::{build_editor_options, probe_gui_editors_with, resolve_editor_basename};
use super::ops::{APPLE_FONT_SMOOTHING_KEY, MAX_RANDOM_BYTES, app_icon_candidates, disable_default_font_smoothing_for};
use super::oslog::{oslog_category_index, oslog_type_for};
use super::*;

#[test]
fn regression_conflict_files_open_only_inside_the_issue_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("issue");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("file.ts"), "branch").unwrap();
    std::fs::write(dir.path().join("file.ts"), "main").unwrap();
    assert_eq!(
        worktree_file(&root, Path::new("file.ts")).unwrap().1,
        root.join("file.ts").canonicalize().unwrap()
    );
    assert!(worktree_file(&root, Path::new("../file.ts")).is_none());
    assert!(worktree_file(&root, &dir.path().join("file.ts")).is_none());
    assert!(worktree_file(&root, Path::new("deleted.ts")).is_none());
    std::os::unix::fs::symlink(dir.path().join("file.ts"), root.join("link")).unwrap();
    assert!(worktree_file(&root, Path::new("link")).is_none());
}

#[test]
fn regression_hosted_views_use_the_same_directory_as_the_host_store() {
    use std::ffi::OsStr;
    use vibevalley_protocol::home::ReleaseChannel;

    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("host.db");
    let paths = Storage::for_channel(Some(state.as_os_str()), ReleaseChannel::Release);
    assert_eq!(paths.database, state);
    assert_eq!(paths.views, root.path().join("host.db.nsh"));
    let sibling = Storage::for_channel(Some(root.path().join("other.db").as_os_str()), ReleaseChannel::Alpha);
    assert_eq!(sibling.views, root.path().join("other.db.nsh"));
    let isolated = Storage::for_channel(Some(root.path().join("state.db").as_os_str()), ReleaseChannel::Dev);
    assert_eq!(isolated.views, root.path().join("nsh"));
    let empty_override = Storage::for_channel(Some(OsStr::new("")), ReleaseChannel::Alpha);
    assert!(empty_override.database.ends_with("Library/Application Support/VibeValley-alpha/state.db"));
    assert!(empty_override.views.ends_with("Library/Application Support/VibeValley-alpha/nsh"));

    for (channel, dir_name) in [
        (ReleaseChannel::Release, "VibeValley"),
        (ReleaseChannel::Beta, "VibeValley-beta"),
        (ReleaseChannel::Alpha, "VibeValley-alpha"),
        (ReleaseChannel::Dev, "VibeValley-dev"),
    ] {
        let storage = Storage::for_channel(None, channel);
        assert!(
            storage.database.ends_with(format!("Library/Application Support/{dir_name}/state.db")),
            "unexpected db path for {channel:?}: {}",
            storage.database.display()
        );
        assert!(
            storage.views.ends_with(format!("Library/Application Support/{dir_name}/nsh")),
            "unexpected views path for {channel:?}: {}",
            storage.views.display()
        );
    }
}

#[test]
fn app_icon_candidates_prefer_bundle_then_channel_then_fallback() {
    use vibevalley_protocol::home::ReleaseChannel;

    let manifest = Path::new("/repo/apps/mac");
    let assets = Path::new("/repo/assets");

    let bundled = app_icon_candidates(
        ReleaseChannel::Alpha,
        Some(Path::new("/Applications/VibeValley.app/Contents/MacOS/vibevalley-mac")),
        manifest,
        assets,
    );
    assert_eq!(
        bundled,
        vec![
            PathBuf::from("/Applications/VibeValley.app/Contents/Resources/icon.icns"),
            PathBuf::from("/repo/apps/mac/resources/icon-alpha.icns"),
            PathBuf::from("/repo/apps/mac/resources/appicon-alpha.png"),
            PathBuf::from("/repo/apps/mac/resources/icon.icns"),
            PathBuf::from("/repo/assets/icons/app-256.png"),
        ]
    );

    let dev = app_icon_candidates(ReleaseChannel::Dev, Some(Path::new("/repo/target/debug/vibevalley-mac")), manifest, assets);
    assert_eq!(
        dev,
        vec![
            PathBuf::from("/repo/apps/mac/resources/icon-dev.icns"),
            PathBuf::from("/repo/apps/mac/resources/appicon-dev.png"),
            PathBuf::from("/repo/apps/mac/resources/icon.icns"),
            PathBuf::from("/repo/assets/icons/app-256.png"),
        ]
    );

    let beta = app_icon_candidates(ReleaseChannel::Beta, None, manifest, assets);
    assert_eq!(beta[0], PathBuf::from("/repo/apps/mac/resources/icon-beta.icns"));
    assert_eq!(beta[1], PathBuf::from("/repo/apps/mac/resources/appicon-beta.png"));

    let release = app_icon_candidates(ReleaseChannel::Release, None, manifest, assets);
    assert_eq!(
        release,
        vec![
            PathBuf::from("/repo/apps/mac/resources/icon.icns"),
            PathBuf::from("/repo/apps/mac/resources/appicon-release.png"),
            PathBuf::from("/repo/assets/icons/app-256.png"),
        ]
    );
}

#[test]
fn native_notify_open_and_reveal_validate_safely_without_shell_outs() {
    assert!(!objc_app::has_bundle_identifier());
    assert!(notify("VibeValley", "Task completed").is_ok());

    let missing = Path::new("/nonexistent/vibevalley-missing-file");
    assert!(open(missing).is_err());
    assert!(reveal(missing).is_err());
}

#[test]
fn system_observer_receives_wake_notifications_and_unregisters_on_drop() {
    let wakes = Arc::new(AtomicUsize::new(0));
    let wakes_cb = wakes.clone();
    let observer = observe_system_wake(move || {
        wakes_cb.fetch_add(1, Ordering::SeqCst);
    });

    system_observer_ffi::post_synthetic_wake_notification();
    assert_eq!(wakes.load(Ordering::SeqCst), 1);

    drop(observer);
    system_observer_ffi::post_synthetic_wake_notification();
    assert_eq!(wakes.load(Ordering::SeqCst), 1, "observer must unregister on drop");
}

#[test]
fn oslog_layer_maps_categories_levels_and_emits_events() {
    use tracing_subscriber::layer::SubscriberExt as _;

    assert_eq!(oslog_category_index("vibevalley_mac::shell"), 0);
    assert_eq!(oslog_category_index("vibevalley_server::hub"), 1);
    assert_eq!(oslog_category_index("vibevalley_runtime::oar"), 2);
    assert_eq!(oslog_category_index("other::crate"), 7);
    assert_eq!(oslog_type_for(&tracing::Level::ERROR), OS_LOG_TYPE_ERROR);
    assert_eq!(oslog_type_for(&tracing::Level::WARN), OS_LOG_TYPE_DEFAULT);
    assert_eq!(oslog_type_for(&tracing::Level::INFO), OS_LOG_TYPE_INFO);
    assert_eq!(oslog_type_for(&tracing::Level::DEBUG), OS_LOG_TYPE_DEBUG);

    let subscriber = tracing_subscriber::registry().with(OsLogLayer::new());
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(target: "vibevalley_mac::test", count = 3, "unified logging smoke test");
    });
}

#[test]
fn read_file_gives_bytes_name_and_type_and_refuses_folders() {
    use base64::Engine as _;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("截图 1.png");
    std::fs::write(&file, b"\x89PNG").unwrap();
    let v = read_file(&file).unwrap();
    assert_eq!(v["type"], "image/png");
    assert_eq!(v["name"], "截图 1.png");
    assert_eq!(
        base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap()).unwrap(),
        b"\x89PNG"
    );
    assert!(read_file(dir.path()).is_err());
    assert!(read_file(&dir.path().join("nope")).is_err());
}

#[test]
fn sha256_and_random_bytes_and_stateless_host_ops() {
    assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let a = random_bytes_hex(16).unwrap();
    let b = random_bytes_hex(16).unwrap();
    assert_eq!(a.len(), 32);
    assert_ne!(a, b);
    assert_eq!(random_seed_hex().len(), 64);
    assert!(random_bytes_hex(0).is_err());
    assert!(random_bytes_hex(MAX_RANDOM_BYTES + 1).is_err());

    let sha_op = decode_host_op("host.sha256", serde_json::json!({ "text": "abc" })).unwrap();
    let sha_env = handle_stateless_op(&sha_op).unwrap();
    assert_eq!(sha_env.biz_code, 0);
    assert_eq!(sha_env.data.unwrap()["hex"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    let qr_op = decode_host_op("host.qr", serde_json::json!({ "text": "hello", "border": 2 })).unwrap();
    let qr_env = handle_stateless_op(&qr_op).unwrap();
    assert_eq!(qr_env.biz_code, 0);
    assert_eq!(qr_env.data.unwrap()["size"], 25);

    let unknown = decode_host_op("host.doesNotExist", serde_json::json!({})).unwrap_err();
    assert_eq!(unknown.biz_code, vibevalley_server::gateway::bridge::BizCode::RouteNotFound.code());
    let malformed = decode_host_op("host.sha256", serde_json::json!({})).unwrap_err();
    assert_eq!(malformed.biz_code, vibevalley_server::gateway::bridge::BizCode::InvalidInput.code());

    let assets_op = decode_host_op("host.assetsDir", serde_json::json!({})).unwrap();
    assert_eq!(assets_op, vibevalley_protocol::HostOp::AssetsDir);
    assert!(handle_stateless_op(&assets_op).is_none());
}

#[test]
fn disable_default_font_smoothing_sets_zero_without_overriding_explicit_value() {
    let unset_key = "VibeValleyTestFontSmoothingUnset";
    assert_eq!(objc_app::cf_app_pref(unset_key), CfPrefValue::Unset);
    disable_default_font_smoothing_for(unset_key);
    assert_eq!(objc_app::cf_app_pref(unset_key), CfPrefValue::Int(0));

    let override_key = "VibeValleyTestFontSmoothingOverride";
    objc_app::with_volatile_argument_int(override_key, 2, || {
        disable_default_font_smoothing_for(override_key);
        assert_eq!(objc_app::cf_app_pref(override_key), CfPrefValue::Int(2));
    });

    let before = objc_app::cf_app_pref(APPLE_FONT_SMOOTHING_KEY);
    disable_default_font_smoothing();
    match before {
        CfPrefValue::Unset => assert_eq!(objc_app::cf_app_pref(APPLE_FONT_SMOOTHING_KEY), CfPrefValue::Int(0)),
        explicit => assert_eq!(objc_app::cf_app_pref(APPLE_FONT_SMOOTHING_KEY), explicit),
    }
}

#[test]
fn editor_detection_orders_gui_apps_before_terminal_and_default_app() {
    let home = Path::new("/Users/tester");
    let gui = probe_gui_editors_with(
        |bundle_id| match bundle_id {
            "com.todesktop.230313mzl4w4u92" => Some(PathBuf::from("/Applications/Cursor.app")),
            "com.microsoft.VSCodeInsiders" => Some(PathBuf::from("/Applications/Visual Studio Code - Insiders.app")),
            _ => None,
        },
        |path| path == Path::new("/Users/tester/Applications/Zed.app"),
        Some(home),
    );
    let options = build_editor_options(gui, Some("/opt/homebrew/bin/nvim --clean"));

    assert_eq!(options.len(), 5);
    assert_eq!(options[0].label, "Cursor");
    assert_eq!(options[0].subtitle, None);
    assert_eq!(
        options[0].target,
        EditorTarget::Cursor {
            app_path: PathBuf::from("/Applications/Cursor.app")
        }
    );
    assert!(options[0].target.is_gui());

    assert_eq!(options[1].label, "VS Code");
    assert_eq!(options[1].subtitle.as_deref(), Some("Insiders"));
    assert_eq!(
        options[1].target,
        EditorTarget::VsCode {
            app_path: PathBuf::from("/Applications/Visual Studio Code - Insiders.app")
        }
    );
    assert!(options[1].target.is_gui());

    assert_eq!(options[2].label, "Zed");
    assert_eq!(options[2].subtitle, None);
    assert_eq!(
        options[2].target,
        EditorTarget::Zed {
            app_path: PathBuf::from("/Users/tester/Applications/Zed.app")
        }
    );
    assert!(options[2].target.is_gui());

    assert_eq!(options[3].label, "Terminal ($EDITOR)");
    assert_eq!(options[3].subtitle.as_deref(), Some("nvim"));
    assert_eq!(options[3].target, EditorTarget::TerminalEditor);
    assert!(!options[3].target.is_gui());

    assert_eq!(options[4].label, "Default App");
    assert_eq!(options[4].subtitle.as_deref(), Some("macOS"));
    assert_eq!(options[4].target, EditorTarget::DefaultApp);
    assert!(!options[4].target.is_gui());
}

#[test]
fn editor_detection_falls_back_cleanly_when_no_gui_editors_installed() {
    let gui = probe_gui_editors_with(|_| None, |_| false, None);
    assert!(gui.is_empty());

    let options = build_editor_options(gui, None);
    assert_eq!(options.len(), 2);
    assert_eq!(options[0].target, EditorTarget::TerminalEditor);
    assert_eq!(options[0].subtitle.as_deref(), Some("vi"));
    assert_eq!(options[1].target, EditorTarget::DefaultApp);

    assert_eq!(resolve_editor_basename(Some("")), "vi");
    assert_eq!(resolve_editor_basename(Some("   ")), "vi");
    assert_eq!(resolve_editor_basename(Some("\"/usr/local/bin/hx\" -c foo")), "hx");
    assert_eq!(resolve_editor_basename(Some("code --wait")), "code");
}

#[test]
fn open_with_app_rejects_missing_app_or_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("README.md");
    std::fs::write(&file, "# hi").unwrap();

    assert!(open_with_app(Path::new("/nonexistent/NoEditor.app"), &file).is_err());
    assert!(open_with_app(dir.path(), &dir.path().join("missing.md")).is_err());
}

#[test]
fn filter_mono_fonts_selects_sorts_and_dedups_monospace_families() {
    let filtered = filter_mono_fonts([
        "Helvetica".to_string(),
        "Menlo".to_string(),
        "JetBrainsMono Nerd Font".to_string(),
        "PingFang SC".to_string(),
        "Maple Mono NF CN".to_string(),
        "Menlo".to_string(),
        "Fira Code".to_string(),
        "Sarasa Gothic SC".to_string(),
        "Times New Roman".to_string(),
    ]);
    assert_eq!(
        filtered,
        vec!["Fira Code", "JetBrainsMono Nerd Font", "Maple Mono NF CN", "Menlo", "Sarasa Gothic SC",]
    );
}

#[test]
fn mono_fonts_enumerates_and_populates_non_blocking_cache() {
    let fonts = mono_fonts();
    assert_eq!(cached_mono_fonts(), Some(fonts.as_slice()));
    #[cfg(target_os = "macos")]
    assert!(fonts.iter().any(|name| name == "Menlo" || name == "Monaco" || name.contains("Mono")));
}
