//! The orchestrator over a scripted model: the user's words in #general
//! wake it with the farm's situation; its tool call records an issue; its
//! words are said in #general; a cron for no profile reaches it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, ToolCall, Usage};
use vibevalley_protocol::Caller;

struct Scripted {
    answers: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl ModelClient for Scripted {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> vibevalley_agent::Result<Completion> {
        self.seen.lock().unwrap().push(request.clone());
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| say("好的。"));
        if let Some(t) = &answer.message.content {
            on(Delta::Text(t.clone()));
        }
        Ok(answer)
    }
}

fn say(text: &str) -> Completion {
    Completion {
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
    }
}

fn call(id: &str, name: &str, args: Value) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: None,
            reasoning: None,
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: args.to_string(),
            }],
            tool_call_id: None,
        },
        finish: FinishReason::ToolCalls,
        usage: Usage {
            input: 100,
            output: 10,
            cache_read: 0,
        },
    }
}

fn until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < deadline, "waited for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_orchestrator_hears_the_user_and_records_an_issue() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(Scripted {
        answers: Mutex::new(VecDeque::from([
            call("c1", "issue_create", json!({ "title": "在 demo 里写 README", "repo": "demo" })),
            say("记下了 #1，在备选里。"),
            call("c2", "cron_list", json!({})),
            say("到点了，看过了。"),
        ])),
        seen: Mutex::new(vec![]),
    });
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        model_client: Some(model.clone()),
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .unwrap();
    let hub = started.hub.clone();
    let user = |op: &str, p: Value| {
        let e = hub.call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };
    user("repo.create", json!({ "name": "demo" }));
    // The orchestrator is on duty in the state.
    let on_duty = hub.read(|s| s.sessions.iter().find(|h| h.id == "orchestrator").cloned()).expect("on duty");
    assert_eq!(serde_json::to_value(on_duty.role).unwrap(), "orchestrator");

    let general = started.chat.default_channel();
    user(
        "channel.message.send",
        json!({ "id": general, "text": "帮我在 demo 里把 README 写了", "sendKey": "ask" }),
    );
    let words = until("the orchestrator's words", || {
        let said = user("channel.message.list", json!({ "id": general }));
        said.as_array()?
            .iter()
            .find(|m| m["from"] == "orchestrator" && m["text"] == "记下了 #1，在备选里。")
            .cloned()
    });
    assert_eq!(words["kind"], "chat", "{words}");

    let issues = user("issue.list", json!({}));
    let issue = issues
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["title"] == "在 demo 里写 README")
        .unwrap_or_else(|| panic!("{issues}"));
    assert_eq!(issue["status"], "backlog");

    let seen = model.seen.lock().unwrap().clone();
    let first = &seen[0];
    let names: Vec<&str> = first.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(&names[..3], ["issue_list", "issue_get", "issue_create"]);
    assert!(names.contains(&"remember") && names.contains(&"load_skill"), "{names:?}");
    let system = first.messages[0].content.clone().unwrap_or_default();
    assert!(system.starts_with("你是码农场物语的助手"), "{system}");
    let input = first.messages.last().unwrap().content.clone().unwrap_or_default();
    assert!(
        input.contains("【现在】") && input.contains("【现状】") && input.contains("仓库（工作目录"),
        "{input}"
    );
    assert!(input.ends_with("[来源：用户]\n用户说：帮我在 demo 里把 README 写了"), "{input}");
    let result = seen[1]
        .messages
        .iter()
        .find(|m| m.role == Role::Tool)
        .and_then(|m| m.content.clone())
        .unwrap_or_default();
    assert_eq!(result, "记下了：#1「在 demo 里写 README」，在备选里，没开工");

    // The trajectory has the turn.
    let events = user("session.event.list", json!({ "id": "orchestrator" }));
    assert!(events.to_string().contains("issue_create"), "{events}");

    // The user marks that answer wrong: the turn is kept as a case to replay.
    let asked = events
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["type"] == "user/message")
        .unwrap_or_else(|| panic!("{events}"));
    let said = events.as_array().unwrap().iter().find(|e| e["type"] != "user/message").unwrap();
    let marked = user("orchestrator.eval.create", json!({ "on": asked["seq"], "want": " 应该先看一眼地里 " }));
    let file = std::path::PathBuf::from(marked["file"].as_str().unwrap());
    assert_eq!(file, dir.path().join("evals").join(format!("{}.json", marked["id"].as_str().unwrap())));
    let case: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(case["want"], "应该先看一眼地里");
    assert!(case["input"].as_str().unwrap().ends_with("用户说：帮我在 demo 里把 README 写了"), "{case}");
    assert!(case["tools"].as_array().unwrap().iter().any(|t| t == "issue_create"), "{case}");
    assert_eq!(case["did"].as_array().unwrap().last().unwrap()["content"], "记下了 #1，在备选里。", "{case}");
    assert_eq!(case["before"], json!([]), "the first turn has nothing before it");
    let refusal = |p: Value| hub.call_as(Caller::User, "orchestrator.eval.create", p).biz_code;
    assert_eq!(
        refusal(json!({ "on": 9999, "want": "x" })),
        vibevalley_protocol::BizCode::SessionNotFound.code()
    );
    assert_eq!(
        refusal(json!({ "on": asked["seq"], "want": "  " })),
        vibevalley_protocol::BizCode::Refused.code()
    );
    assert_eq!(refusal(json!({ "on": said["seq"], "want": "x" })), vibevalley_protocol::BizCode::Refused.code());

    // A cron for no profile: said in #general, handed to the orchestrator.
    let at = vibevalley_server::now() + 300;
    user(
        "cron.create",
        json!({ "name": "早会", "text": "看看昨天的活", "when": { "kind": "once", "at": at } }),
    );
    std::thread::sleep(Duration::from_millis(400));
    started.crons.tick();
    until("the cron's turn", || {
        let seen = model.seen.lock().unwrap();
        seen.iter()
            .any(|r| r.messages.last().and_then(|m| m.content.clone()).is_some_and(|c| c.contains("[来源：定时]")))
            .then_some(())
    });
    started.board.close();
}
