//! VibeValley `platform/provider/connections.test.ts` and the provider
//! endpoints over the settings file.

use std::sync::Arc;

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, ProviderUpdate};
use vibevalley_server::infra::provider::{Provider, connections_over};
use vibevalley_server::infra::setting::{Setting, SettingConfig};

fn empty() -> Value {
    json!({ "revision": 0, "connections": [], "image": null, "understanding": null, "speech": null,
            "live": null, "speakers": null, "voiceDesign": null, "transcription": null, "vision": null })
}

fn update(change: impl FnOnce(&mut Value)) -> ProviderUpdate {
    let mut u = empty();
    u["connections"] = json!([{ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key" }]);
    change(&mut u);
    serde_json::from_value(u).unwrap()
}

#[test]
fn invalid_connection_changes_are_refused() {
    let c = json!({ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key" });
    let with = |k: &str, v: Value| {
        let mut c = c.clone();
        c[k] = v;
        json!([c])
    };
    let cases: Vec<(&str, Value)> = vec![
        ("connections", json!([c.clone(), c.clone()])),
        ("connections", with("id", "../invalid".into())),
        ("connections", with("name", " ".into())),
        ("connections", with("name", "x".repeat(81).into())),
        ("connections", with("key", " ".into())),
        ("connections", with("key", "a b".into())),
        ("connections", with("key", "x".repeat(4097).into())),
        (
            "connections",
            Value::Array(
                (0..33)
                    .map(|i| {
                        let mut x = c.clone();
                        x["id"] = format!("connection-{i}").into();
                        x
                    })
                    .collect(),
            ),
        ),
        ("live", json!({ "connection": "missing", "model": "moss-live-1.0" })),
        ("speech", json!({ "connection": "missing", "model": "moss-tts-1.5-flash" })),
        ("speech", json!({ "connection": "moss", "model": "moss-ttsd-1.0" })),
        ("speech", json!({ "connection": "moss", "model": "moss-tts-1.5-flash-2099-01-01" })),
        ("understanding", json!({ "connection": "missing", "model": "moss-vl-1.0" })),
        ("understanding", json!({ "connection": "moss", "model": "moss-image-base-1.0" })),
        ("transcription", json!({ "connection": "moss", "model": "moss-image" })),
        ("image", json!({ "connection": "missing", "model": "moss-image-base-1.0" })),
        ("image", json!({ "connection": "moss", "model": "moss-transcribe-1.0" })),
    ];
    for (i, (k, v)) in cases.into_iter().enumerate() {
        let u = update(|u| u[k] = v);
        let e = connections_over(&Default::default(), &u).expect_err(&format!("case {i}"));
        assert_eq!(e.biz_code, BizCode::ProviderRefused, "case {i}");
        assert!(!e.message.contains("test-key"));
    }
}

#[test]
fn an_unconfigured_connection_is_saved_without_a_default() {
    let u = update(|u| u["connections"] = json!([{ "id": "moss", "name": " MOSS ", "adapter": "moss", "enabled": true }]));
    let saved = serde_json::to_value(connections_over(&Default::default(), &u).unwrap()).unwrap();
    assert_eq!(
        saved["connections"],
        json!([{ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "" }])
    );
    assert_eq!(saved["revision"], 1);
    assert!(saved["speech"].is_null() && saved["vision"].is_null());
}

#[test]
fn updates_keep_the_key_and_follow_revisions() {
    let home = tempfile::tempdir().unwrap();
    let setting = Setting::open(SettingConfig {
        home: home.path().into(),
        work_root: home.path().into(),
        ..Default::default()
    });
    let p = Provider::new(setting.clone(), std::sync::Arc::new(vibevalley_server::infra::http::Http));
    let first = p
        .update(&update(|u| u["speech"] = json!({ "connection": "moss", "model": "moss-tts-1.5-flash" })))
        .unwrap();
    assert_eq!(first.revision, 1);
    let shown = serde_json::to_value(&first).unwrap();
    assert_eq!(shown["connections"][0]["key"], json!({ "source": "settings", "hint": "…-key" }));
    // Omitted keeps the key; a stale revision is refused.
    let mut again = update(|u| {
        u["revision"] = 1.into();
        u["connections"][0].as_object_mut().unwrap().remove("key");
    });
    assert_eq!(p.update(&update(|_| {})).unwrap_err().biz_code, BizCode::ProviderRefused);
    let kept = p.update(&again).unwrap();
    assert_eq!(serde_json::to_value(&kept).unwrap()["connections"][0]["key"]["hint"], "…-key");
    // Cleared while bound is refused.
    again.revision = 2;
    again.connections[0].key = Some(None);
    again.speech = Some(vibevalley_protocol::ProviderBinding {
        connection: "moss".into(),
        model: "moss-tts-1.5-flash".into(),
    });
    assert_eq!(p.update(&again).unwrap_err().biz_code, BizCode::ProviderRefused);
    // The settings' readiness reads the same providers.
    let reopened = Setting::open(SettingConfig {
        home: home.path().into(),
        work_root: home.path().into(),
        ..Default::default()
    });
    assert_eq!(serde_json::to_value(reopened.providers()).unwrap()["connections"][0]["key"], "test-key");
    let _ = Arc::strong_count(&setting);
    // Model discovery refuses an old revision before any call.
    assert_eq!(
        vibevalley_runtime::rt::block_on(p.models_async("moss", 0)).unwrap_err().biz_code,
        BizCode::ProviderRefused
    );
}
