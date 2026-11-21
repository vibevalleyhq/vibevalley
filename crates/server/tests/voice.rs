//! `voice.*` through its endpoints, offline: Agora's REST, the dictation
//! address and MOSS answered by the test, the orchestrator by a scripted
//! model.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller, Envelope, VoiceFix};
use vibevalley_runtime::agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, Usage};
use vibevalley_server::modules::collab::voice::line::Tunnel;
use vibevalley_server::modules::collab::voice::moss::{Realtime, Verdict};
use vibevalley_server::modules::collab::voice::{self, LineConfig, Voice};
use vibevalley_server::modules::content::media::vendor::{Fetch, FetchError, Request, Response};
use vibevalley_server::modules::infra::setting::Secret;

const APP: &str = "11111111111111111111111111111111";
const CERTIFICATE: &str = "22222222222222222222222222222222";

struct Scripted {
    answers: Mutex<VecDeque<&'static str>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl ModelClient for Scripted {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> vibevalley_runtime::agent::Result<Completion> {
        self.seen.lock().unwrap().push(request.clone());
        let text = self.answers.lock().unwrap().pop_front().unwrap_or("好的。");
        on(Delta::Text(text.into()));
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
    }
}

/// One request as the vendor saw it.
#[derive(Clone)]
struct Seen {
    call: String,
    authorization: String,
    kind: String,
    body: String,
}

/// Agora, MOSS and the user's own dictation address, kept and answered as set.
#[derive(Default)]
struct Vendors {
    seen: Mutex<Vec<Seen>>,
    /// What the next request whose address contains the text is answered with, once.
    next: Mutex<Vec<(&'static str, u16, &'static str)>>,
}

impl Vendors {
    fn answer(&self, of: &'static str, status: u16, body: &'static str) {
        self.next.lock().unwrap().push((of, status, body));
    }

    fn calls(&self, of: &str) -> Vec<Seen> {
        self.seen.lock().unwrap().iter().filter(|s| s.call.contains(of)).cloned().collect()
    }
}

impl Fetch for Vendors {
    fn fetch(&self, r: Request) -> Result<Response, FetchError> {
        let (mut kind, mut bytes) = (String::new(), Vec::new());
        if let Some((k, mut b)) = r.body {
            kind = k;
            std::io::Read::read_to_end(&mut b, &mut bytes).unwrap();
        }
        let authorization = r.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.clone()).unwrap_or_default();
        self.seen.lock().unwrap().push(Seen {
            call: format!("{} {}", r.method, r.url),
            authorization,
            kind,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        });
        let set = {
            let mut next = self.next.lock().unwrap();
            next.iter().position(|(of, _, _)| r.url.contains(of)).map(|i| next.remove(i))
        };
        let (status, body) = match set {
            Some((_, status, body)) => (status, body),
            None if r.url.ends_with("/join") => (200, r#"{"agent_id":"parity-agent"}"#),
            None if r.url.ends_with("/audio/transcriptions") => (200, r#"{"text":"  写个 README  "}"#),
            None => (200, "{}"),
        };
        Ok(Response {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: Box::new(std::io::Cursor::new(body.as_bytes().to_vec())),
        })
    }
}

struct Live(Mutex<Verdict>);

impl Realtime for Live {
    fn verify(&self, key: &Secret, model: &str) -> Verdict {
        assert_eq!((key.expose(), model), ("test-key", "moss-live-1.0"));
        self.0.lock().unwrap().clone()
    }
}

struct Farm {
    _dir: tempfile::TempDir,
    started: vibevalley_server::Started,
    voice: Arc<Voice>,
    vendors: Arc<Vendors>,
    live: Arc<Live>,
    model: Arc<Scripted>,
}

impl Farm {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.started.hub.call_as(Caller::User, op, payload)
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

    fn credentials(&self, answer: Value) {
        self.ok(
            "setting.update",
            json!({ "agoraAppId": APP, "agoraAppCertificate": CERTIFICATE, "voice": { "answer": answer } }),
        );
    }

    /// One MOSS account, bound to dictation and to Live.
    fn moss(&self) {
        self.ok(
            "provider.update",
            json!({ "revision": 0, "connections": [{ "id": "moss", "name": "MOSS", "adapter": "moss", "enabled": true, "key": "test-key" }],
                "dictation": { "connection": "moss", "model": "moss-transcribe-1.0" }, "live": { "connection": "moss", "model": "moss-live-1.0" },
                "image": null, "understanding": null, "speech": null, "speakers": null, "voiceDesign": null, "transcription": null, "vision": null }),
        );
    }

    fn messages(&self) -> Vec<Value> {
        let general = self.started.chat.default_channel();
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
        self.voice.close();
        self.started.close();
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
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        model_client: Some(model.clone()),
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .unwrap();
    let vendors = Arc::new(Vendors::default());
    let live = Arc::new(Live(Mutex::new(Verdict::Ok)));
    // The server's own voice with the vendors, the tunnel and the waits of the test.
    let voice = Voice::open(voice::Parts {
        hub: Arc::downgrade(&started.hub),
        setting: started.setting.clone(),
        chat: started.chat.clone(),
        orchestrator: started.orchestrator.clone(),
        fetch: vendors.clone(),
        realtime: Some(live.clone()),
        line: LineConfig {
            port: 0,
            url: String::new(),
            tunnel: Some(Arc::new(|port| {
                Ok(Tunnel {
                    url: format!("http://127.0.0.1:{port}"),
                    close: Box::new(|| {}),
                })
            })),
        },
        pause: Some(Arc::new(|_| {})),
    });
    voice::install(&started.hub, voice.clone());
    Farm {
        _dir: dir,
        started,
        voice,
        vendors,
        live,
        model,
    }
}

fn until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < deadline, "waited for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn every_voice_endpoint_is_served() {
    let f = farm(&[]);
    for op in [
        "voice.hear",
        "voice.dictate",
        "voice.moss.verify",
        "voice.grant.create",
        "voice.grant.renew",
        "voice.call.start",
        "voice.call.stop",
        "voice.call.hear",
        "voice.call.say",
    ] {
        assert!(f.started.hub.answers(op), "{op}");
    }
}

#[test]
fn a_grant_is_signed_only_with_credentials_and_renewed() {
    let f = farm(&[]);
    let none = f.refused("voice.grant.create", json!(null), BizCode::VoiceUnavailable);
    assert!(none.message.contains("App ID"), "{}", none.message);
    assert_eq!(none.error.unwrap().settings, Some(VoiceFix::Call));

    f.credentials(json!({ "vendor": "agora", "model": "gpt-4.1-mini" }));
    let grant = f.ok("voice.grant.create", json!(null));
    let (channel, uid) = (grant["channel"].as_str().unwrap(), grant["uid"].as_str().unwrap());
    assert_eq!(grant["appId"], APP);
    assert!(
        channel.starts_with("vibevalley-") && uid.parse::<u32>().is_ok_and(|n| (1000..10_000_000).contains(&n)),
        "{grant}"
    );
    assert!(grant["token"].as_str().unwrap().starts_with("007"));

    let renewed = f.ok("voice.grant.renew", json!({ "channel": channel, "uid": uid }));
    assert_eq!((renewed["channel"].as_str(), renewed["uid"].as_str()), (Some(channel), Some(uid)));
    assert!(renewed["token"].as_str().unwrap().starts_with("007"));
    // The grant keeps the credentials it was issued with, whatever the settings say later.
    f.ok("setting.update", json!({ "agoraAppId": "", "agoraAppCertificate": "" }));
    assert_eq!(f.ok("voice.grant.renew", json!({ "channel": channel, "uid": uid }))["appId"], APP);

    let gone = f.refused(
        "voice.grant.renew",
        json!({ "channel": "vibevalley-0-nobody", "uid": "1000" }),
        BizCode::VoiceUnavailable,
    );
    assert_eq!(gone.message, "这通电话的语音凭据已经失效，请重新接通");
    f.refused(
        "voice.call.start",
        json!({ "channel": "vibevalley-0-nobody", "uid": "1000" }),
        BizCode::VoiceUnavailable,
    );
}

#[test]
fn a_call_with_a_model_of_its_own_keeps_what_was_heard_and_said() {
    let f = farm(&["#3 做完了，等你验收。"]);
    f.credentials(json!({ "vendor": "agora", "model": "gpt-4.1-mini" }));
    let grant = f.ok("voice.grant.create", json!(null));
    let (channel, uid) = (grant["channel"].clone(), grant["uid"].clone());
    let call = f.ok("voice.call.start", json!({ "channel": channel, "uid": uid }));
    assert_eq!(call["agentId"], "parity-agent");

    let join = f.vendors.calls("/join").remove(0);
    assert_eq!(
        join.call,
        format!("POST https://api-us-west-1.agora.io/api/conversational-ai-agent/v2/projects/{APP}/join")
    );
    assert!(join.authorization.starts_with("agora token=007"));
    let asked: Value = serde_json::from_str(&join.body).unwrap();
    assert_eq!(asked["preset"], "openai_gpt_4_1_mini,minimax_speech_2_6_turbo");
    // Only this call's user is listened to, in this call's channel.
    assert_eq!(asked["properties"]["channel"], channel);
    assert_eq!(asked["properties"]["remote_rtc_uids"], json!([uid]));
    assert_eq!(asked["properties"]["agent_rtc_uid"], "123456");
    assert!(asked["properties"]["token"].as_str().unwrap().starts_with("007"));
    let greeting = asked["properties"]["llm"]["greeting_message"].as_str().unwrap().to_string();
    assert!(!greeting.is_empty());

    // A grant starts one call.
    let again = f.refused("voice.call.start", json!({ "channel": channel, "uid": uid }), BizCode::VoiceUnavailable);
    assert_eq!(again.message, "这通电话已经在接通");

    // What the call's model heard is the user's spoken words in the chat, once per key.
    f.ok(
        "voice.call.hear",
        json!({ "agentId": "parity-agent", "text": "语音消息", "sendKey": "voice-1" }),
    );
    f.ok(
        "voice.call.hear",
        json!({ "agentId": "parity-agent", "text": "语音消息", "sendKey": "voice-1" }),
    );
    let heard: Vec<Value> = f.messages().into_iter().filter(|m| m["text"] == "语音消息").collect();
    assert_eq!(heard.len(), 1);
    assert_eq!(
        (heard[0]["from"].as_str(), heard[0]["spoken"].as_bool()),
        (Some("user"), Some(true)),
        "{}",
        heard[0]
    );
    // A client that does not name its call is heard on the one call there is.
    f.ok("voice.hear", json!({ "text": "不带电话号的一句", "sendKey": "voice-2" }));
    assert!(f.message("不带电话号的一句").is_some());

    // What it said is the orchestrator's spoken words; its greeting is not kept.
    f.ok("voice.call.say", json!({ "agentId": "parity-agent", "text": format!(" {greeting} ") }));
    f.ok("voice.call.say", json!({ "agentId": "parity-agent", "text": "好，让小吴去跑测试。" }));
    assert!(f.message(&greeting).is_none());
    let said = f.message("好，让小吴去跑测试。").expect("kept");
    assert_eq!((said["from"].as_str(), said["spoken"].as_bool()), (Some("orchestrator"), Some(true)), "{said}");

    // The orchestrator's own words are read out on the call, in pieces Agora takes.
    assert!(f.voice.speak(&format!("{}。{}", "一".repeat(120), "二".repeat(120))));
    let spoken = f.vendors.calls("/agents/parity-agent/speak");
    assert_eq!(spoken.len(), 2);
    assert_eq!(serde_json::from_str::<Value>(&spoken[1].body).unwrap()["text"], "二".repeat(120));

    // Agora already letting the agent go counts as left.
    f.vendors
        .answer("/leave", 400, r#"{"detail":"Agent is already in the process of shutting down"}"#);
    f.ok("voice.call.stop", json!({ "agentId": "parity-agent" }));
    assert_eq!(f.vendors.calls("/agents/parity-agent/leave").len(), 1);
    let hung = f.refused(
        "voice.call.hear",
        json!({ "agentId": "parity-agent", "text": "还在吗" }),
        BizCode::VoiceCallFailed,
    );
    assert_eq!(hung.message, "这通电话已经挂了");
    f.refused("voice.call.say", json!({ "agentId": "parity-agent", "text": "在" }), BizCode::VoiceCallFailed);
    assert_eq!(
        f.refused("voice.hear", json!({ "text": "喂" }), BizCode::VoiceCallFailed).message,
        "没有正在接通的电话"
    );
    assert!(!f.voice.speak("没人听"));

    // An agent of an earlier run is asked to leave all the same; a refusal is said.
    f.vendors.answer("/leave", 403, r#"{"detail":"boom"}"#);
    let failed = f.refused("voice.call.stop", json!({ "agentId": "other" }), BizCode::VoiceCallFailed);
    assert!(failed.message.contains("boom"), "{}", failed.message);
}

#[test]
fn a_call_that_answers_a_ring_opens_with_what_rang() {
    let f = farm(&["#3 做完了，等你验收。"]);
    f.credentials(json!({ "vendor": "agora", "model": "gpt-4.1-mini" }));
    let grant = f.ok("voice.grant.create", json!(null));
    f.ok(
        "voice.call.start",
        json!({ "channel": grant["channel"], "uid": grant["uid"], "about": "#3 等你验收" }),
    );
    let asked: Value = serde_json::from_str(&f.vendors.calls("/join")[0].body).unwrap();
    assert_eq!(asked["properties"]["llm"]["greeting_message"], "");
    let spoken = until("the ring's reason read out", || f.vendors.calls("/speak").first().cloned());
    assert_eq!(serde_json::from_str::<Value>(&spoken.body).unwrap()["text"], "#3 做完了，等你验收。");
    let seen = f.model.seen.lock().unwrap();
    let input = seen[0].messages.last().unwrap().content.clone().unwrap_or_default();
    assert!(
        input.contains("[来源：通话]\n用户接起了你打的电话。你打电话是为了这件事：#3 等你验收"),
        "{input}"
    );
}

#[test]
fn a_join_that_agora_refuses_frees_the_grant_and_a_missing_key_says_where_to_fix_it() {
    let f = farm(&[]);
    f.credentials(json!({ "vendor": "deepseek", "model": "deepseek-chat" }));
    let grant = f.ok("voice.grant.create", json!(null));
    let start = json!({ "channel": grant["channel"], "uid": grant["uid"] });
    let no_key = f.refused("voice.call.start", start.clone(), BizCode::VoiceUnavailable);
    assert!(no_key.message.contains("DeepSeek"), "{}", no_key.message);
    assert_eq!(no_key.error.unwrap().settings, Some(VoiceFix::Models));
    assert!(f.vendors.calls("/join").is_empty());
    // The grant went with the failed start.
    f.refused("voice.call.start", start, BizCode::VoiceUnavailable);

    f.credentials(json!({ "vendor": "agora", "model": "gpt-5-mini" }));
    let grant = f.ok("voice.grant.create", json!(null));
    f.vendors.answer("/join", 403, r#"{"detail":"no such project"}"#);
    let refused = f.refused(
        "voice.call.start",
        json!({ "channel": grant["channel"], "uid": grant["uid"] }),
        BizCode::VoiceCallFailed,
    );
    assert_eq!(refused.message, "请主助手进频道失败：HTTP 403: no such project");
}

#[test]
fn the_orchestrator_answers_a_call_on_its_own_line() {
    let f = farm(&["看板上有三张工单。"]);
    f.credentials(json!({ "vendor": "orchestrator" }));
    let grant = f.ok("voice.grant.create", json!(null));
    let call = f.ok("voice.call.start", json!({ "channel": grant["channel"], "uid": grant["uid"] }));
    let asked: Value = serde_json::from_str(&f.vendors.calls("/join")[0].body).unwrap();
    let llm = &asked["properties"]["llm"];
    let (url, key) = (llm["url"].as_str().unwrap(), llm["api_key"].as_str().unwrap());
    assert!(url.starts_with("http://127.0.0.1:") && url.contains("/llm/") && !key.is_empty(), "{llm}");
    assert_eq!(llm["params"]["model"], "vibevalley-orchestrator");
    assert_eq!(asked["preset"], "minimax_speech_2_6_turbo");
    assert_eq!(f.voice.lines(), 1);

    // Agora's model call, as the tunnel brings it: the user's words in, the orchestrator's out.
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let ask = json!({ "model": "vibevalley-orchestrator", "stream": true,
        "messages": [{ "role": "system", "content": "persona" }, { "role": "user", "content": "看板上有几张工单？" }] });
    let mut answered = agent.post(url).header("authorization", &format!("Bearer {key}")).send(ask.to_string()).unwrap();
    assert_eq!(answered.status().as_u16(), 200);
    let body = answered.body_mut().read_to_string().unwrap();
    assert!(body.contains("看板上有三张工单。") && body.ends_with("data: [DONE]\n\n"), "{body}");

    // Both sides are in the chat as spoken words, and the orchestrator was told it is on the phone.
    let heard = f.message("看板上有几张工单？").expect("the user's words");
    assert_eq!((heard["from"].as_str(), heard["spoken"].as_bool()), (Some("user"), Some(true)), "{heard}");
    let said = f.message("看板上有三张工单。").expect("the orchestrator's words");
    assert_eq!((said["from"].as_str(), said["spoken"].as_bool()), (Some("orchestrator"), Some(true)), "{said}");
    // The line has them already: the client's transcript of this call is not kept twice.
    f.ok("voice.call.hear", json!({ "agentId": call["agentId"], "text": "看板上有几张工单？" }));
    assert_eq!(f.messages().iter().filter(|m| m["text"] == "看板上有几张工单？").count(), 1);

    f.ok("voice.call.stop", json!({ "agentId": call["agentId"] }));
    assert_eq!(f.voice.lines(), 0);
    let closed = agent.post(url).header("authorization", &format!("Bearer {key}")).send(ask.to_string()).unwrap();
    assert_eq!(closed.status().as_u16(), 401);
}

#[test]
fn dictation_goes_to_moss_by_default_and_to_an_address_of_the_users_own() {
    let f = farm(&[]);
    let audio = "aGVsbG8gd2F2";
    let unset = f.refused("voice.dictate", json!({ "audio": audio, "format": "wav" }), BizCode::VoiceUnavailable);
    assert_eq!(unset.error.unwrap().settings, Some(VoiceFix::Dictation));

    f.moss();
    assert_eq!(
        f.ok("voice.dictate", json!({ "audio": audio, "format": "wav" })),
        json!({ "text": "写个 README" })
    );
    let sent = f.vendors.calls("/audio/transcriptions").remove(0);
    assert_eq!(sent.call, "POST https://api.mosi.cn/v1/audio/transcriptions");
    assert_eq!(sent.authorization, "Bearer test-key");
    assert!(sent.kind.starts_with("multipart/form-data; boundary="), "{}", sent.kind);
    for part in [
        "name=\"file\"; filename=\"dictation.wav\"\r\ncontent-type: audio/wav\r\n\r\nhello wav\r\n",
        "name=\"model\"\r\n\r\nmoss-transcribe-1.0\r\n",
        "name=\"response_format\"\r\n\r\njson\r\n",
    ] {
        assert!(sent.body.contains(part), "{part}: {}", sent.body);
    }

    // A recording that cannot be one is refused before anything is asked.
    let before = f.vendors.calls("/audio/transcriptions").len();
    f.refused("voice.dictate", json!({ "audio": audio, "format": "aiff" }), BizCode::VoiceRefused);
    f.refused("voice.dictate", json!({ "audio": "", "format": "wav" }), BizCode::VoiceRefused);
    assert_eq!(f.vendors.calls("/audio/transcriptions").len(), before);

    // What the address says of a failure is kept; an answer of another shape is said so.
    f.vendors.answer("/audio/transcriptions", 500, r#"{"error":{"message":"model overloaded"}}"#);
    let failed = f.refused("voice.dictate", json!({ "audio": audio, "format": "mp3" }), BizCode::VoiceUnavailable);
    assert_eq!(failed.message, "听写的地址回了 500：model overloaded");
    f.vendors.answer("/audio/transcriptions", 200, "<html>");
    let shape = f.refused("voice.dictate", json!({ "audio": audio, "format": "mp3" }), BizCode::VoiceUnavailable);
    assert_eq!(shape.message, "听写的地址回的不是 OpenAI 的转写格式");

    // The user's own address and model, with its own key.
    f.ok(
        "setting.update",
        json!({ "dictation": { "via": "own", "url": "https://asr.example.com/v1", "model": "whisper-x" }, "dictationKey": "own-key" }),
    );
    f.ok("voice.dictate", json!({ "audio": audio, "format": ".M4A" }));
    let own = f.vendors.calls("asr.example.com").remove(0);
    assert_eq!(
        (own.call.as_str(), own.authorization.as_str()),
        ("POST https://asr.example.com/v1/audio/transcriptions", "Bearer own-key")
    );
    assert!(own.body.contains("filename=\"dictation.m4a\"\r\ncontent-type: audio/mp4") && own.body.contains("whisper-x"));
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
fn a_farm_call_runs_over_moss_live_without_agora() {
    let f = farm(&["一共三张，两张在做。"]);
    f.ok(
        "setting.update",
        json!({ "voice": { "answer": { "vendor": "moss" }, "persona": "你是助手。" } }),
    );
    let none = f.refused("voice.grant.create", json!(null), BizCode::VoiceUnavailable);
    assert_eq!(none.error.unwrap().settings, Some(VoiceFix::Moss));
    f.moss();

    let grant = f.ok("voice.grant.create", json!(null));
    assert_eq!((grant["appId"].as_str(), grant["token"].as_str()), (Some("moss"), Some("moss")));
    let (channel, uid) = (grant["channel"].as_str().unwrap().to_string(), grant["uid"].clone());
    assert_eq!(f.ok("voice.grant.renew", json!({ "channel": channel, "uid": uid }))["appId"], "moss");
    let call = f.ok("voice.call.start", json!({ "channel": channel, "uid": uid }));
    let agent = format!("moss-{channel}");
    assert_eq!(call["agentId"], agent.as_str());
    // No Agora credentials, no REST call, no line.
    assert!(f.vendors.seen.lock().unwrap().is_empty());
    assert_eq!(f.voice.lines(), 0);

    // The host's line: where to connect, with which key, and the session's settings.
    let line = f.voice.moss_line().unwrap();
    assert_eq!(
        (line.url.as_str(), line.key.expose()),
        ("wss://api.mosi.cn/v1/realtime?model=moss-live-1.0", "test-key")
    );
    assert!(f.voice.moss_line().is_err());
    let update: Value = serde_json::from_str(&line.session_update()).unwrap();
    assert_eq!(update["session"]["persona"]["prompt"], "你是助手。");
    assert_eq!(update["session"]["tools"][0]["name"], "ask_orchestrator");

    // Words for the call wait until MOSS has taken the settings.
    assert!(f.voice.speak("小吴的测试跑完了。"));
    assert!(line.outgoing.try_recv().is_err());
    line.heard(r#"{"action":"session.updated","data":{"error":""}}"#);
    let commentary: Value = serde_json::from_str(&line.outgoing.try_recv().unwrap()).unwrap();
    assert_eq!(
        (commentary["action"].as_str(), commentary["content"].as_str()),
        (Some("session.commentary.append"), Some("小吴的测试跑完了。"))
    );
    assert!(f.voice.speak("后面的直接送到。"));
    assert!(line.outgoing.try_recv().unwrap().contains("后面的直接送到。"));

    // The model's tool call is put to the orchestrator, answered, and gone on with once MOSS has the answer.
    let asked = json!({ "action": "response.function_call_arguments.done",
        "data": { "call_id": "c1", "name": "ask_orchestrator", "arguments": "{\"question\":\"现在有几张工单？\"}" } })
    .to_string();
    line.heard(&asked);
    line.heard(&asked);
    let output: Value = serde_json::from_str(&line.outgoing.recv_timeout(Duration::from_secs(30)).unwrap()).unwrap();
    assert_eq!(
        output,
        json!({ "action": "conversation.item.create", "item": { "type": "function_call_output", "call_id": "c1", "output": "一共三张，两张在做。" } })
    );
    line.heard(r#"{"action":"conversation.item.created","data":{"item":{"type":"function_call_output","call_id":"c1"}}}"#);
    assert_eq!(
        line.outgoing.try_recv().unwrap(),
        r#"{"action":"response.create","response":{"call_ids":["c1"]}}"#
    );
    // The same call is run once.
    assert!(line.outgoing.recv_timeout(Duration::from_millis(300)).is_err());
    assert_eq!(f.model.seen.lock().unwrap().len(), 1);
    let input = f.model.seen.lock().unwrap()[0].messages.last().unwrap().content.clone().unwrap_or_default();
    assert!(input.ends_with("[来源：通话]\n现在有几张工单？"), "{input}");

    // What MOSS heard and said is kept as on any call with its own model.
    f.ok("voice.call.hear", json!({ "agentId": agent, "text": "现在有几张工单？", "sendKey": "m-1" }));
    f.ok("voice.call.say", json!({ "agentId": agent, "text": "一共三张，两张在做。" }));
    assert_eq!(f.message("现在有几张工单？").unwrap()["spoken"], true);

    // The host's socket closing ends the call.
    drop(line);
    f.refused("voice.call.hear", json!({ "agentId": agent, "text": "喂" }), BizCode::VoiceCallFailed);
    f.ok("voice.call.stop", json!({ "agentId": agent }));
    assert!(f.voice.moss_line().is_ok());
}
