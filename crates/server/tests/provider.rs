//! Unified model providers (`provider.*`), 1-key-per-provider validation,
//! offline verification + capability discovery, and scene fallback policies.

use std::io::Cursor;
use std::sync::Arc;

use serde_json::{Value, json};
use vibevalley_protocol::{
    BizCode, ModelCapability, ProviderConnectionAdapter, ProviderScene, ProviderUpdate, ProviderVerificationStatus, ProviderVerifyRequest,
};
use vibevalley_server::context::http::{Fetch, FetchError, Request, Response};
use vibevalley_server::provider::{Provider, connections_over, infer_model_capabilities};
use vibevalley_server::setting::{Setting, SettingConfig};

fn empty() -> Value {
    json!({
        "revision": 0,
        "connections": [],
        "orchestrator": null,
        "polish": null,
        "image": null,
        "understanding": null,
        "speech": null,
        "live": null,
        "speakers": null,
        "voiceDesign": null,
        "transcription": null,
        "vision": null,
        "scenePolicies": []
    })
}

fn update(change: impl FnOnce(&mut Value)) -> ProviderUpdate {
    let mut u = empty();
    u["connections"] = json!([{ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key" }]);
    change(&mut u);
    serde_json::from_value(u).unwrap()
}

fn mock_fetch(handler: impl Fn(Request) -> Result<Response, FetchError> + Send + Sync + 'static) -> Arc<dyn Fetch> {
    Arc::new(handler)
}

#[test]
fn invalid_connection_changes_and_duplicate_adapters_are_refused() {
    let c = json!({ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key" });
    let with = |k: &str, v: Value| {
        let mut c = c.clone();
        c[k] = v;
        json!([c])
    };
    let cases: Vec<(&str, Value)> = vec![
        ("connections", json!([c.clone(), c.clone()])),
        // 1 provider = 1 API Key: duplicate adapter under a different id is refused.
        (
            "connections",
            json!([
                c.clone(),
                { "id": "moss-2", "name": "MOSS 2", "adapter": "moss", "enabled": true, "key": "other-key" }
            ]),
        ),
        ("connections", with("id", "../invalid".into())),
        ("connections", with("name", " ".into())),
        ("connections", with("name", "x".repeat(81).into())),
        ("connections", with("key", " ".into())),
        ("connections", with("key", "a b".into())),
        ("connections", with("key", "x".repeat(4097).into())),
        ("connections", with("baseUrl", "ftp://example.com".into())),
        ("connections", with("baseUrl", "https://bad url.com".into())),
        ("live", json!({ "connection": "missing", "model": "moss-live-1.0" })),
        ("speech", json!({ "connection": "missing", "model": "moss-tts-1.5-flash" })),
        ("speech", json!({ "connection": "moss", "model": "moss-ttsd-1.0" })),
        ("speech", json!({ "connection": "moss", "model": "moss-tts-1.5-flash-2099-01-01" })),
        ("understanding", json!({ "connection": "missing", "model": "moss-vl-1.0" })),
        ("understanding", json!({ "connection": "moss", "model": "moss-image-base-1.0" })),
        ("transcription", json!({ "connection": "moss", "model": "moss-image" })),
        ("image", json!({ "connection": "missing", "model": "moss-image-base-1.0" })),
        ("image", json!({ "connection": "moss", "model": "moss-transcribe-1.0" })),
        // Fallback policy referencing an unconfigured connection or duplicate scene is refused.
        (
            "scenePolicies",
            json!([{ "scene": "orchestrator", "fallbacks": [{ "connection": "missing", "model": "deepseek-chat" }] }]),
        ),
        (
            "scenePolicies",
            json!([
                { "scene": "polish", "fallbacks": [] },
                { "scene": "polish", "fallbacks": [] }
            ]),
        ),
    ];
    for (i, (k, v)) in cases.into_iter().enumerate() {
        let u = update(|u| u[k] = v);
        let e = connections_over(&Default::default(), &u).expect_err(&format!("case {i}"));
        assert_eq!(e.biz_code, BizCode::ProviderRefused, "case {i}");
        assert!(!e.message.contains("test-key"));
    }
}

#[test]
fn capability_inference_tags_deepseek_minimax_moss_openai_and_anthropic() {
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::DeepSeek, "deepseek-chat"),
        vec![ModelCapability::Chat]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::MiniMax, "MiniMax-M2.5"),
        vec![ModelCapability::Chat]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::MiniMax, "speech-02-hd"),
        vec![ModelCapability::Tts]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::Moss, "moss-transcribe-1.0"),
        vec![ModelCapability::Asr]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::Moss, "moss-tts-1.5-flash"),
        vec![ModelCapability::Tts]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::Moss, "moss-live-1.0"),
        vec![ModelCapability::Realtime]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::Moss, "moss-vl-realtime-1.0"),
        vec![ModelCapability::Vision, ModelCapability::Realtime]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::Moss, "moss-image-base-1.0"),
        vec![ModelCapability::Image]
    );
    assert_eq!(
        infer_model_capabilities(ProviderConnectionAdapter::Anthropic, "claude-sonnet-4-5"),
        vec![ModelCapability::Chat, ModelCapability::Vision]
    );
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
    vibevalley_runtime::rt::block_on(async {
        let setting = Setting::open_async(SettingConfig {
            home: home.path().into(),
            work_root: home.path().into(),
            ..Default::default()
        })
        .await;
        let p = Provider::new(setting.clone(), Arc::new(vibevalley_server::context::Http));
        let first = p
            .update_async(&update(|u| u["speech"] = json!({ "connection": "moss", "model": "moss-tts-1.5-flash" })))
            .await
            .unwrap();
        assert_eq!(first.revision, 1);
        let shown = serde_json::to_value(&first).unwrap();
        assert_eq!(shown["connections"][0]["key"], json!({ "source": "settings", "hint": "…-key" }));
        // Omitted keeps the key; a stale revision is refused.
        let mut again = update(|u| {
            u["revision"] = 1.into();
            u["connections"][0].as_object_mut().unwrap().remove("key");
        });
        assert_eq!(p.update_async(&update(|_| {})).await.unwrap_err().biz_code, BizCode::ProviderRefused);
        let kept = p.update_async(&again).await.unwrap();
        assert_eq!(serde_json::to_value(&kept).unwrap()["connections"][0]["key"]["hint"], "…-key");
        // Cleared while bound is refused.
        again.revision = 2;
        again.connections[0].key = Some(None);
        again.speech = Some(vibevalley_protocol::ProviderBinding {
            connection: "moss".into(),
            model: "moss-tts-1.5-flash".into(),
        });
        assert_eq!(p.update_async(&again).await.unwrap_err().biz_code, BizCode::ProviderRefused);
        // The settings' readiness reads the same providers.
        let reopened = Setting::open_async(SettingConfig {
            home: home.path().into(),
            work_root: home.path().into(),
            ..Default::default()
        })
        .await;
        assert_eq!(serde_json::to_value(reopened.providers()).unwrap()["connections"][0]["key"], "test-key");
        let _ = Arc::strong_count(&setting);
        // Model discovery refuses an old revision before any call.
        assert_eq!(p.models_async("moss", 0).await.unwrap_err().biz_code, BizCode::ProviderRefused);
    });
}

#[test]
fn verify_auto_fetches_tagged_models_records_failures_and_validates_scene_policies() {
    let home = tempfile::tempdir().unwrap();
    vibevalley_runtime::rt::block_on(async {
        let setting = Setting::open_async(SettingConfig {
            home: home.path().into(),
            work_root: home.path().into(),
            ..Default::default()
        })
        .await;

        let fetch = mock_fetch(|req| {
            let auth = req.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.as_str()).unwrap_or("");
            if req.url.contains("api.deepseek.com") {
                if auth == "Bearer sk-bad-key" {
                    return Ok(Response {
                        status: 401,
                        headers: vec![],
                        body: Box::new(Cursor::new(b"{}".to_vec())),
                    });
                }
                let body = serde_json::to_vec(&json!({
                    "object": "list",
                    "data": [
                        { "id": "deepseek-chat", "owned_by": "deepseek" },
                        { "id": "deepseek-reasoner", "owned_by": "deepseek" }
                    ]
                }))
                .unwrap();
                return Ok(Response {
                    status: 200,
                    headers: vec![],
                    body: Box::new(Cursor::new(body)),
                });
            }
            if req.url.contains("api.minimaxi.com") {
                let body = serde_json::to_vec(&json!({
                    "object": "list",
                    "data": [
                        { "id": "MiniMax-M2.5", "owned_by": "minimax" },
                        { "id": "speech-02-hd", "owned_by": "minimax" }
                    ]
                }))
                .unwrap();
                return Ok(Response {
                    status: 200,
                    headers: vec![],
                    body: Box::new(Cursor::new(body)),
                });
            }
            Err(FetchError::Network("unexpected url".into()))
        });

        let provider = Provider::new(setting.clone(), fetch);
        let saved = provider
            .update_async(
                &serde_json::from_value(json!({
                    "revision": 0,
                    "connections": [
                        { "id": "deepseek", "name": "DeepSeek", "adapter": "deepseek", "enabled": true, "key": "sk-bad-key" },
                        { "id": "minimax", "name": "MiniMax", "adapter": "minimax", "enabled": true, "key": "mm-good-key" }
                    ],
                    "orchestrator": null, "polish": null, "speech": null, "understanding": null,
                    "image": null, "live": null, "speakers": null, "voiceDesign": null,
                    "transcription": null, "vision": null, "scenePolicies": []
                }))
                .unwrap(),
            )
            .await
            .unwrap();

        // Failed auth records verification = failed without dropping revision sync.
        let failed = provider
            .verify_async(&ProviderVerifyRequest {
                connection: "deepseek".into(),
                revision: saved.revision,
            })
            .await
            .unwrap();
        let ds_fail = failed.connections.iter().find(|c| c.id == "deepseek").unwrap();
        assert_eq!(ds_fail.verification.as_ref().unwrap().status, ProviderVerificationStatus::Failed);
        assert!(ds_fail.verification.as_ref().unwrap().error.is_some());

        // Replace with good DeepSeek key, verify both DeepSeek and MiniMax.
        let fixed = provider
            .update_async(
                &serde_json::from_value(json!({
                    "revision": failed.revision,
                    "connections": [
                        { "id": "deepseek", "name": "DeepSeek", "adapter": "deepseek", "enabled": true, "key": "sk-good-key" },
                        { "id": "minimax", "name": "MiniMax", "adapter": "minimax", "enabled": true }
                    ],
                    "orchestrator": null, "polish": null, "speech": null, "understanding": null,
                    "image": null, "live": null, "speakers": null, "voiceDesign": null,
                    "transcription": null, "vision": null, "scenePolicies": []
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let v1 = provider
            .verify_async(&ProviderVerifyRequest {
                connection: "deepseek".into(),
                revision: fixed.revision,
            })
            .await
            .unwrap();
        let v2 = provider
            .verify_async(&ProviderVerifyRequest {
                connection: "minimax".into(),
                revision: v1.revision,
            })
            .await
            .unwrap();

        let ds = v2.connections.iter().find(|c| c.id == "deepseek").unwrap();
        assert_eq!(ds.verification.as_ref().unwrap().status, ProviderVerificationStatus::Verified);
        assert_eq!(ds.models.len(), 2);
        assert_eq!(ds.models[0].capabilities, vec![ModelCapability::Chat]);

        let mm = v2.connections.iter().find(|c| c.id == "minimax").unwrap();
        assert_eq!(mm.models[0].capabilities, vec![ModelCapability::Chat]);
        assert_eq!(mm.models[1].capabilities, vec![ModelCapability::Tts]);

        // Selecting an incompatible capability (e.g. TTS model for orchestrator chat) is refused.
        let bad_scene = provider
            .update_async(
                &serde_json::from_value(json!({
                    "revision": v2.revision,
                    "connections": [
                        { "id": "deepseek", "name": "DeepSeek", "adapter": "deepseek", "enabled": true },
                        { "id": "minimax", "name": "MiniMax", "adapter": "minimax", "enabled": true }
                    ],
                    "orchestrator": { "connection": "minimax", "model": "speech-02-hd" },
                    "polish": null, "speech": null, "understanding": null,
                    "image": null, "live": null, "speakers": null, "voiceDesign": null,
                    "transcription": null, "vision": null, "scenePolicies": []
                }))
                .unwrap(),
            )
            .await;
        assert_eq!(bad_scene.unwrap_err().biz_code, BizCode::ProviderRefused);

        // Valid scene bindings + fallback policy save and resolve cleanly.
        let bound = provider
            .update_async(
                &serde_json::from_value(json!({
                    "revision": v2.revision,
                    "connections": [
                        { "id": "deepseek", "name": "DeepSeek", "adapter": "deepseek", "enabled": true },
                        { "id": "minimax", "name": "MiniMax", "adapter": "minimax", "enabled": true }
                    ],
                    "orchestrator": { "connection": "deepseek", "model": "deepseek-chat" },
                    "polish": { "connection": "deepseek", "model": "deepseek-chat" },
                    "speech": { "connection": "minimax", "model": "speech-02-hd" },
                    "understanding": null, "image": null, "live": null, "speakers": null,
                    "voiceDesign": null, "transcription": null, "vision": null,
                    "scenePolicies": [
                        {
                            "scene": "orchestrator",
                            "fallbacks": [{ "connection": "minimax", "model": "MiniMax-M2.5" }]
                        }
                    ]
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bound.orchestrator.as_ref().unwrap().model, "deepseek-chat");
        assert_eq!(bound.scene_policies[0].fallbacks[0].model, "MiniMax-M2.5");

        let resolved = setting.scene_accounts(ProviderScene::Orchestrator);
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].model, "deepseek-chat");
        assert_eq!(resolved[1].model, "MiniMax-M2.5");
    });
}
