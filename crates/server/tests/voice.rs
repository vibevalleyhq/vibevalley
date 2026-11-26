//! `voice.*` through its endpoints, offline: MOSS Live answered by the test,
//! the orchestrator by a scripted model.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller, Envelope, VoiceFix};
use vibevalley_runtime::agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, Usage};
use vibevalley_server::app::{Overrides, create_app_with_overrides_blocking};
use vibevalley_server::gateway::bridge::LiveVoiceLine as _;
use vibevalley_server::setting::Secret;
use vibevalley_server::voice::Voice;
use vibevalley_server::voice::moss::{Realtime, Verdict};
use vibevalley_server::{App, Config};

struct Scripted {
    answers: Mutex<VecDeque<&'static str>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl ModelClient for Scripted {
    fn complete<'a>(
        &'a self,
        request: &'a ChatRequest,
        on: &'a mut (dyn FnMut(Delta) + Send),
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::agent::Result<Completion>> {
        self.seen.lock().unwrap().push(request.clone());
        let text = self.answers.lock().unwrap().pop_front().unwrap_or("好的。");
        on(Delta::Text(text.into()));
        Box::pin(async move {
            Ok(Completion {
                message: Message {
                    role: Role::Assistant,
                    content: Some(text.into()),
                    reasoning: None,
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                finish: FinishReason::Stop,
                usage: Usage {
                    input: 100,
                    output: 10,
                    cache_read: 0,
                },
            })
        })
    }
}

struct Live(Mutex<Verdict>);

impl Realtime for Live {
    fn verify_async<'a>(&'a self, key: &'a Secret, model: &'a str) -> vibevalley_server::BoxFuture<'a, Verdict> {
        let _ = (key, model);
        assert_eq!((key.expose(), model), ("test-key", "moss-live-1.0"));
        let verdict = self.0.lock().unwrap().clone();
        Box::pin(async move { verdict })
    }
}

struct Farm {
    _dir: tempfile::TempDir,
    app: App,
    live: Arc<Live>,
    model: Arc<Scripted>,
}

impl Farm {
    fn voice(&self) -> &Arc<Voice> {
        self.app.test_internals().voice
    }

    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.app.router().call_as(Caller::User, op, payload)
    }

    fn ok(&self, op: &str, payload: Value) -> Value {
        let e = self.call(op, payload);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    }

    fn refused(&self, op: &str, payload: Value, code: BizCode) -> Envelope {
        let e = self.call(op, payload);
        assert_eq!(e.biz_code, code.code(), "{op}: {}", e.message);
        e
    }

    /// One MOSS account bound to Live.
    fn moss(&self) {
        self.ok(
            "provider.update",
            json!({
                "revision": 0,
                "connections": [{ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key" }],
                "live": { "connection": "moss", "model": "moss-live-1.0" },
                "image": null, "understanding": null, "speech": null, "speakers": null,
                "voiceDesign": null, "transcription": null, "vision": null
            }),
        );
    }

    fn messages(&self) -> Vec<Value> {
        let general = self.app.test_internals().channel.default_channel();
        self.ok("channel.message.list", json!({ "id": general }))
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn message(&self, text: &str) -> Option<Value> {
        self.messages().into_iter().find(|m| m["text"] == text)
    }
}

impl Drop for Farm {
    fn drop(&mut self) {
        self.app.close_blocking();
    }
}

fn farm(answers: &[&'static str]) -> Farm {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(Scripted {
        answers: Mutex::new(answers.iter().copied().collect()),
        seen: Mutex::new(vec![]),
    });
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let live = Arc::new(Live(Mutex::new(Verdict::Ok)));
    let app = create_app_with_overrides_blocking(
        Config {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            link_previews: false,
            tick_crons: false,
            model_client: Some(model.clone()),
            ..Config::under(dir.path())
        },
        Overrides {
            voice_realtime: Some(live.clone()),
            ..Overrides::default()
        },
    )
    .unwrap();
    Farm { _dir: dir, app, live, model }
}

#[test]
fn every_voice_endpoint_is_served_and_retired_endpoints_are_gone() {
    let f = farm(&[]);
    for op in [
        "voice.hear",
        "voice.moss.verify",
        "voice.grant.create",
        "voice.call.start",
        "voice.call.stop",
        "voice.call.hear",
        "voice.call.say",
    ] {
        assert!(f.app.router().answers(op), "{op}");
    }
    for retired in ["voice.dictate", "voice.grant.renew"] {
        assert!(!f.app.router().answers(retired), "retired endpoint still registered: {retired}");
    }
}

#[test]
fn moss_live_is_asked_whether_it_takes_the_bound_key() {
    let f = farm(&[]);
    assert_eq!(
        f.ok("voice.moss.verify", json!(null))["problem"],
        "请先在 AI 服务中为 MOSS Live 绑定已启用的连接"
    );
    f.moss();
    assert_eq!(f.ok("voice.moss.verify", json!(null))["problem"], "");
    *f.live.0.lock().unwrap() = Verdict::Refused("invalid key".into());
    assert_eq!(f.ok("voice.moss.verify", json!(null))["problem"], "MOSS Live 不认这个 Key：invalid key");
    *f.live.0.lock().unwrap() = Verdict::Silent;
    assert_eq!(f.ok("voice.moss.verify", json!(null))["problem"], "MOSS Live 8 秒内没回应");
}

#[test]
fn a_farm_call_runs_over_moss_live() {
    let f = farm(&["一共三张，两张在做。"]);
    f.ok("setting.update", json!({ "voice": { "persona": "你是助手。", "greeting": "我在呢。" } }));
    let none = f.refused("voice.grant.create", json!(null), BizCode::VoiceUnavailable);
    assert_eq!(none.error.unwrap().settings, Some(VoiceFix::Moss));
    f.moss();

    let grant = f.ok("voice.grant.create", json!(null));
    let (channel, uid) = (grant["channel"].as_str().unwrap().to_string(), grant["uid"].as_str().unwrap().to_string());
    assert!(
        channel.starts_with("vibevalley-") && uid.parse::<u32>().is_ok_and(|n| (1000..10_000_000).contains(&n)),
        "{grant}"
    );
    assert!(grant.get("appId").is_none() && grant.get("token").is_none(), "{grant}");

    // Unknown grant is refused.
    f.refused(
        "voice.call.start",
        json!({ "channel": "vibevalley-0-nobody", "uid": "1000" }),
        BizCode::VoiceUnavailable,
    );

    let call = f.ok("voice.call.start", json!({ "channel": channel, "uid": uid }));
    let agent = format!("moss-{channel}");
    assert_eq!(call["agentId"], agent.as_str());
    // A grant starts only one call.
    let again = f.refused("voice.call.start", json!({ "channel": channel, "uid": uid }), BizCode::VoiceUnavailable);
    assert_eq!(again.message, "这通电话已经在接通");

    // The host's line: where to connect, with which key, and the session's settings.
    let line = f.voice().moss_line().unwrap();
    assert_eq!(
        (line.url.as_str(), line.key.expose()),
        ("wss://api.mosi.cn/v1/realtime?model=moss-live-1.0", "test-key")
    );
    assert!(f.voice().moss_line().is_err());
    let mut outgoing = line.take_outgoing().unwrap();
    let recv_timeout = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>, wait: Duration| -> Option<String> {
        vibevalley_runtime::rt::block_on(async { tokio::time::timeout(wait, rx.recv()).await.ok().flatten() })
    };
    let update: Value = serde_json::from_str(&line.session_update()).unwrap();
    assert_eq!(update["session"]["persona"]["prompt"], "你是助手。");
    assert_eq!(update["session"]["tools"][0]["name"], "ask_orchestrator");

    // Words for the call wait until MOSS has taken the settings.
    assert!(f.voice().speak("小吴的测试跑完了。"));
    assert!(outgoing.try_recv().is_err());
    line.heard(r#"{"action":"session.updated","data":{"error":""}}"#);
    let commentary: Value = serde_json::from_str(&outgoing.try_recv().unwrap()).unwrap();
    assert_eq!(
        (commentary["action"].as_str(), commentary["content"].as_str()),
        (Some("session.commentary.append"), Some("小吴的测试跑完了。"))
    );
    assert!(f.voice().speak("后面的直接送到。"));
    assert!(outgoing.try_recv().unwrap().contains("后面的直接送到。"));

    // The model's tool call is put to the orchestrator, answered, and resumed once MOSS acks the output.
    let asked = json!({
        "action": "response.function_call_arguments.done",
        "data": { "call_id": "c1", "name": "ask_orchestrator", "arguments": "{\"question\":\"现在有几张工单？\"}" }
    })
    .to_string();
    line.heard(&asked);
    line.heard(&asked);
    let output: Value = serde_json::from_str(&recv_timeout(&mut outgoing, Duration::from_secs(30)).unwrap()).unwrap();
    assert_eq!(
        output,
        json!({ "action": "conversation.item.create", "item": { "type": "function_call_output", "call_id": "c1", "output": "一共三张，两张在做。" } })
    );
    line.heard(r#"{"action":"conversation.item.created","data":{"item":{"type":"function_call_output","call_id":"c1"}}}"#);
    assert_eq!(outgoing.try_recv().unwrap(), r#"{"action":"response.create","response":{"call_ids":["c1"]}}"#);
    // Duplicate call_id is executed once.
    assert!(recv_timeout(&mut outgoing, Duration::from_millis(300)).is_none());
    assert_eq!(f.model.seen.lock().unwrap().len(), 1);
    let input = f.model.seen.lock().unwrap()[0].messages.last().unwrap().content.clone().unwrap_or_default();
    assert!(input.ends_with("[来源：通话]\n现在有几张工单？"), "{input}");

    // Heard and said transcripts go into chat; sendKey deduplicates, greeting is skipped.
    f.ok("voice.call.hear", json!({ "agentId": agent, "text": "现在有几张工单？", "sendKey": "m-1" }));
    f.ok("voice.call.hear", json!({ "agentId": agent, "text": "现在有几张工单？", "sendKey": "m-1" }));
    assert_eq!(f.messages().iter().filter(|m| m["text"] == "现在有几张工单？").count(), 1);
    assert_eq!(f.message("现在有几张工单？").unwrap()["spoken"], true);

    f.ok("voice.hear", json!({ "text": "不带电话号的一句", "sendKey": "m-2" }));
    assert!(f.message("不带电话号的一句").is_some());

    f.ok("voice.call.say", json!({ "agentId": agent, "text": " 我在呢。 " }));
    f.ok("voice.call.say", json!({ "agentId": agent, "text": "一共三张，两张在做。" }));
    assert!(f.message("我在呢。").is_none());
    let said = f.message("一共三张，两张在做。").expect("kept");
    assert_eq!((said["from"].as_str(), said["spoken"].as_bool()), (Some("orchestrator"), Some(true)), "{said}");

    // The host's socket closing ends the call.
    drop(line);
    f.refused("voice.call.hear", json!({ "agentId": agent, "text": "喂" }), BizCode::VoiceCallFailed);
    f.refused("voice.call.say", json!({ "agentId": agent, "text": "在" }), BizCode::VoiceCallFailed);
    assert_eq!(
        f.refused("voice.hear", json!({ "text": "喂" }), BizCode::VoiceCallFailed).message,
        "没有正在接通的电话"
    );
    assert!(!f.voice().speak("没人听"));
    f.ok("voice.call.stop", json!({ "agentId": agent }));
    assert!(f.voice().moss_line().is_ok());
}

#[test]
fn a_moss_call_answering_a_ring_speaks_what_rang() {
    let f = farm(&["#3 做完了，等你验收。"]);
    f.moss();
    let line = f.voice().moss_line().unwrap();
    let mut outgoing = line.take_outgoing().unwrap();
    let _ = line.session_update();
    line.heard(r#"{"action":"session.updated","data":{"error":""}}"#);

    let grant = f.ok("voice.grant.create", json!(null));
    let call = f.ok(
        "voice.call.start",
        json!({ "channel": grant["channel"], "uid": grant["uid"], "about": "#3 等你验收" }),
    );
    let raw = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(30), outgoing.recv()).await })
        .ok()
        .flatten()
        .expect("ring commentary delivered");
    let frame: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(frame["action"], "session.commentary.append");
    assert_eq!(frame["content"], "#3 做完了，等你验收。");

    let seen = f.model.seen.lock().unwrap();
    let input = seen[0].messages.last().unwrap().content.clone().unwrap_or_default();
    assert!(
        input.contains("[来源：通话]\n用户接起了你打的电话。你打电话是为了这件事：#3 等你验收"),
        "{input}"
    );
    drop(seen);
    f.ok("voice.call.stop", json!({ "agentId": call["agentId"] }));
}
