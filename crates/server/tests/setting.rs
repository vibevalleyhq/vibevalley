//! `setting.*`, ported from VibeValley `platform/setting/setting.test.ts`.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::{Value, json};
use vibevalley_server::setting::{Setting, SettingConfig};
use vibevalley_server::{App, Config, Server, create_app_blocking};

fn config(home: &Path) -> SettingConfig {
    SettingConfig {
        home: home.to_path_buf(),
        work_root: home.join("work"),
        version: "test".into(),
        deepseek_api_key: "sk-from-config-0000".into(),
        ..Default::default()
    }
}

fn file(home: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(home.join("settings.json")).unwrap()).unwrap()
}

fn app(home: &Path) -> App {
    create_app_blocking(Config {
        home: home.to_path_buf(),
        work_root: home.join("work"),
        version: "test".into(),
        deepseek_api_key: "sk-from-config-0000".into(),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(home)
    })
    .unwrap()
}

fn call(app: &App, op: &str, payload: Value) -> Value {
    serde_json::to_value(app.router().call(op, payload)).unwrap()
}

#[test]
fn a_key_saved_here_wins_over_the_configurations_and_only_its_end_is_shown() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let before = call(&app, "setting.get", Value::Null)["data"].clone();
    assert_eq!(before["deepseekApiKey"], json!({ "source": "config", "hint": "…0000" }));
    assert_eq!(before["paths"]["worktrees"], dir.path().join("work/worktrees").to_string_lossy().as_ref());
    assert!(before["paths"].get("pkm").is_none());
    let after = call(
        &app,
        "setting.update",
        json!({ "deepseekApiKey": " sk-saved-in-settings-1234 ", "locale": "en" }),
    )["data"]
        .clone();
    assert_eq!(after["deepseekApiKey"], json!({ "source": "settings", "hint": "…1234" }));
    assert_eq!(after["locale"], "en");
    assert_eq!(after["readiness"]["orchestrator"], json!({ "ready": true }));
    assert_eq!(after["readiness"]["call"], json!({ "ready": false, "missing": "mossAccount" }));
    assert!(!after.to_string().contains("sk-saved"));
    let mode = std::fs::metadata(dir.path().join("settings.json")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(file(dir.path()), json!({ "locale": "en", "deepseekApiKey": "sk-saved-in-settings-1234" }));
    let cleared = call(&app, "setting.update", json!({ "deepseekApiKey": "" }))["data"].clone();
    assert_eq!(cleared["deepseekApiKey"], json!({ "source": "config", "hint": "…0000" }));
    assert!(file(dir.path()).get("deepseekApiKey").is_none());
    // Read again from the file.
    let again = vibevalley_runtime::rt::block_on(Setting::open_async(config(dir.path())));
    assert_eq!(again.status().locale, vibevalley_protocol::Locale::En);
    app.close_blocking();
}

#[test]
fn nothing_is_saved_when_something_cannot_be_right() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let refused = call(&app, "setting.update", json!({ "deepseekApiKey": "short" }));
    assert_eq!(refused["bizCode"], 700007);
    assert!(!dir.path().join("settings.json").exists());
    let problem = call(&app, "setting.validate", json!({ "voice": { "persona": "  " } }));
    assert!(!problem["data"]["problem"].as_str().unwrap().is_empty());
    app.close_blocking();
}

#[test]
fn the_voice_keeps_only_what_differs_from_its_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let before = call(&app, "setting.get", Value::Null)["data"].clone();
    assert!(!before["voiceDefaults"]["persona"].as_str().unwrap().is_empty());
    assert!(!before["voiceDefaults"]["greeting"].as_str().unwrap().is_empty());
    assert_eq!(before["voice"], before["voiceDefaults"]);
    let saved = call(&app, "setting.update", json!({ "voice": { "greeting": "在呢。" } }));
    assert_eq!(saved["data"]["voice"]["greeting"], "在呢。");
    assert_eq!(file(dir.path())["voice"], json!({ "greeting": "在呢。" }));
    let reset = call(&app, "setting.update", json!({ "voice": before["voiceDefaults"] }))["data"].clone();
    assert_eq!(reset["voice"], reset["voiceDefaults"]);
    assert!(file(dir.path()).get("voice").is_none());
    app.close_blocking();
}

#[test]
fn readiness_follows_moss_providers_and_hides_keys() {
    let dir = tempfile::tempdir().unwrap();
    vibevalley_runtime::rt::block_on(async {
        let setting = Setting::open_async(config(dir.path())).await;
        let status = serde_json::to_value(setting.status()).unwrap();
        assert_eq!(status["readiness"]["live"], json!({ "ready": false, "missing": "mossAccount" }));
        assert_eq!(status["readiness"]["call"], json!({ "ready": false, "missing": "mossAccount" }));
        assert!(status["readiness"].get("dictation").is_none());
        setting
            .update_providers_async(|p| {
                let mut p = serde_json::to_value(p).unwrap();
                p["revision"] = 1.into();
                p["connections"] = json!([{ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-private-key" }]);
                p["live"] = json!({ "connection": "moss", "model": "moss-live-1.0" });
                Ok(serde_json::from_value(p).unwrap())
            })
            .await
            .unwrap();
        let ready = serde_json::to_value(setting.status()).unwrap();
        assert_eq!(ready["readiness"]["live"], json!({ "ready": true }));
        assert_eq!(ready["readiness"]["call"], json!({ "ready": true }));
        assert_eq!(ready["readiness"]["image"], json!({ "ready": false, "missing": "binding" }));
        assert!(!ready.to_string().contains("test-private-key"));
        assert_eq!(setting.providers().revision, 1);
    });
}

#[test]
fn user_profile_persists_merges_and_clears_fields() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let before = call(&app, "setting.get", Value::Null)["data"].clone();
    assert!(before.get("profile").is_none());
    assert_eq!(before["storageBackend"], "local_fs");

    let saved = call(
        &app,
        "setting.update",
        json!({
            "profile": {
                "displayName": "  Lucas  ",
                "avatarPreset": "avatar-orchestrator",
                "tagline": "Building VibeValley"
            }
        }),
    )["data"]
        .clone();
    assert_eq!(
        saved["profile"],
        json!({
            "displayName": "Lucas",
            "avatarPreset": "avatar-orchestrator",
            "tagline": "Building VibeValley"
        })
    );

    // Partial update keeps other fields and allows switching to custom attachment while clearing preset.
    let updated = call(
        &app,
        "setting.update",
        json!({
            "profile": {
                "avatarAttachmentId": "att-123",
                "avatarPreset": ""
            }
        }),
    )["data"]
        .clone();
    assert_eq!(
        updated["profile"],
        json!({
            "displayName": "Lucas",
            "avatarAttachmentId": "att-123",
            "tagline": "Building VibeValley"
        })
    );

    // Clearing all fields drops `profile` from settings.json cleanly.
    let cleared = call(
        &app,
        "setting.update",
        json!({
            "profile": {
                "displayName": "",
                "avatarAttachmentId": "",
                "tagline": ""
            }
        }),
    )["data"]
        .clone();
    assert!(cleared.get("profile").is_none());
    assert!(file(dir.path()).get("profile").is_none());

    // Excessively long displayName is refused.
    let too_long = "x".repeat(81);
    let refused = call(&app, "setting.update", json!({ "profile": { "displayName": too_long } }));
    assert_eq!(refused["bizCode"], 700007);

    app.close_blocking();
}

#[test]
fn github_token_saves_masks_clears_and_never_leaks_via_debug() {
    use vibevalley_server::setting::Secret;

    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        home: dir.path().to_path_buf(),
        work_root: dir.path().join("work"),
        version: "test".into(),
        deepseek_api_key: "sk-from-config-0000".into(),
        github_token: Some(Secret::new("ghp_from_config_0000")),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(dir.path())
    };
    let debug_cfg = format!("{cfg:?}");
    assert!(!debug_cfg.contains("ghp_from_config_0000"), "Config Debug must mask github_token");

    let app = create_app_blocking(cfg).unwrap();
    let before = call(&app, "setting.get", Value::Null)["data"].clone();
    assert_eq!(before["githubToken"], json!({ "source": "config", "hint": "…0000" }));
    assert!(!before.to_string().contains("ghp_from_config"));

    let saved = call(&app, "setting.update", json!({ "githubToken": " github_pat_saved_9999 " }))["data"].clone();
    assert_eq!(saved["githubToken"], json!({ "source": "settings", "hint": "…9999" }));
    assert!(!saved.to_string().contains("github_pat_saved"));
    assert_eq!(file(dir.path())["githubToken"], "github_pat_saved_9999");

    let cleared = call(&app, "setting.update", json!({ "githubToken": "" }))["data"].clone();
    assert_eq!(cleared["githubToken"], json!({ "source": "config", "hint": "…0000" }));
    assert!(file(dir.path()).get("githubToken").is_none());

    app.close_blocking();
}
