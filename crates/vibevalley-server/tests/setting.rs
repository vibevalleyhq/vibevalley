//! `setting.*`, ported from VibeValley `platform/setting/setting.test.ts`.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::{Value, json};
use vibevalley_core::empty_space_state;
use vibevalley_server::modules::setting::{Setting, SettingConfig};
use vibevalley_server::{Hub, Server};

fn config(home: &Path) -> SettingConfig {
    SettingConfig {
        home: home.to_path_buf(),
        work_root: home.join("work"),
        version: "test".into(),
        deepseek_api_key: "sk-from-config-0000".into(),
        voice_id: "English_captivating_female1".into(),
        ..Default::default()
    }
}

fn file(home: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(home.join("settings.json")).unwrap()).unwrap()
}

fn hub(home: &Path) -> std::sync::Arc<Hub> {
    let hub = Hub::new(empty_space_state());
    vibevalley_server::modules::setting::install(&hub, Setting::open(config(home)));
    hub
}

fn call(hub: &Hub, op: &str, payload: Value) -> Value {
    serde_json::to_value(hub.call(op, payload)).unwrap()
}

#[test]
fn a_key_saved_here_wins_over_the_configurations_and_only_its_end_is_shown() {
    let dir = tempfile::tempdir().unwrap();
    let hub = hub(dir.path());
    let before = call(&hub, "setting.get", Value::Null)["data"].clone();
    assert_eq!(before["deepseekApiKey"], json!({ "source": "config", "hint": "…0000" }));
    assert_eq!(before["agoraAppId"], json!({ "source": null }));
    assert_eq!(before["paths"]["worktrees"], dir.path().join("work/worktrees").to_string_lossy().as_ref());
    let app_id = "0123456789abcdef0123456789abcdef";
    let cert = "abcdef0123456789abcdef0123452222";
    let after = call(
        &hub,
        "setting.update",
        json!({ "deepseekApiKey": " sk-saved-in-settings-1234 ", "agoraAppId": app_id, "agoraAppCertificate": cert }),
    )["data"]
        .clone();
    assert_eq!(after["deepseekApiKey"], json!({ "source": "settings", "hint": "…1234" }));
    assert_eq!(after["agoraAppId"], json!({ "source": "settings", "value": app_id }));
    assert_eq!(after["agoraAppCertificate"], json!({ "source": "settings", "hint": "…2222" }));
    assert_eq!(after["readiness"]["call"], json!({ "ready": true }));
    assert!(!after.to_string().contains("sk-saved"));
    let mode = std::fs::metadata(dir.path().join("settings.json")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(
        file(dir.path()),
        json!({ "deepseekApiKey": "sk-saved-in-settings-1234", "agoraAppId": app_id, "agoraAppCertificate": cert })
    );
    let cleared = call(&hub, "setting.update", json!({ "deepseekApiKey": "" }))["data"].clone();
    assert_eq!(cleared["deepseekApiKey"], json!({ "source": "config", "hint": "…0000" }));
    assert!(file(dir.path()).get("deepseekApiKey").is_none());
    // Read again from the file.
    let again = Setting::open(config(dir.path()));
    assert_eq!(again.status().agora_app_id.value.as_deref(), Some(app_id));
}

#[test]
fn nothing_is_saved_when_something_cannot_be_right() {
    let dir = tempfile::tempdir().unwrap();
    let hub = hub(dir.path());
    let refused = call(&hub, "setting.update", json!({ "agoraAppId": "nope", "deepseekApiKey": "sk-fine-12345" }));
    assert_eq!(refused["bizCode"], 700007);
    assert!(refused["message"].as_str().unwrap().contains("App ID"), "{refused}");
    assert!(!dir.path().join("settings.json").exists());
    let problem = call(&hub, "setting.validate", json!({ "voice": { "persona": "  " } }));
    assert!(!problem["data"]["problem"].as_str().unwrap().is_empty());
}

#[test]
fn the_voice_keeps_only_what_differs_from_its_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let hub = hub(dir.path());
    let before = call(&hub, "setting.get", Value::Null)["data"].clone();
    assert_eq!(before["voiceDefaults"]["answer"], json!({ "vendor": "orchestrator" }));
    assert_eq!(
        before["voiceDefaults"]["tts"],
        json!({ "vendor": "minimax", "model": "speech_2_6_turbo", "voiceId": "English_captivating_female1" })
    );
    assert_eq!(before["voice"], before["voiceDefaults"]);
    let saved = call(
        &hub,
        "setting.update",
        json!({ "voice": { "area": "CN", "silenceMs": 600, "greeting": "在呢。" } }),
    );
    assert_eq!(saved["data"]["voice"]["area"], "CN");
    assert_eq!(file(dir.path())["voice"], json!({ "area": "CN", "silenceMs": 600, "greeting": "在呢。" }));
    let reset = call(&hub, "setting.update", json!({ "voice": before["voiceDefaults"] }))["data"].clone();
    assert_eq!(reset["voice"], reset["voiceDefaults"]);
    assert!(file(dir.path()).get("voice").is_none());
    let range = call(&hub, "setting.update", json!({ "voice": { "silenceMs": 50 } }));
    assert!(range["message"].as_str().unwrap().contains("200 到 2000"), "{range}");
}

#[test]
fn a_voice_vendors_key_is_a_hint_and_readiness_follows_the_providers() {
    let dir = tempfile::tempdir().unwrap();
    let setting = Setting::open(config(dir.path()));
    let status = serde_json::to_value(setting.status()).unwrap();
    assert_eq!(status["ttsKey"], json!({ "source": null }));
    assert_eq!(status["readiness"]["live"], json!({ "ready": false, "missing": "mossAccount" }));
    let update: vibevalley_protocol::SettingsUpdate = serde_json::from_value(json!({ "ttsKey": "azure-speech-key-9f3a" })).unwrap();
    let after = serde_json::to_value(setting.save(&update).unwrap()).unwrap();
    assert_eq!(after["ttsKey"], json!({ "source": "settings", "hint": "…9f3a" }));
    assert!(!after.to_string().contains("azure-speech-key"));
    setting
        .update_providers(|mut p| {
            p["revision"] = 1.into();
            p["connections"] = json!([{ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-private-key" }]);
            p["live"] = json!({ "connection": "moss", "model": "moss-live-1.0" });
            Ok(p)
        })
        .unwrap();
    let ready = serde_json::to_value(setting.status()).unwrap();
    assert_eq!(ready["readiness"]["live"], json!({ "ready": true }));
    assert_eq!(ready["readiness"]["image"], json!({ "ready": false, "missing": "binding" }));
    assert!(!ready.to_string().contains("test-private-key"));
    assert_eq!(setting.providers()["revision"], 1);
}
