//! The orchestrator over a scripted model: the user's words in #general
//! wake it with the farm's situation; its tool call records an issue; its
//! words are said in #general; a cron for no profile reaches it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::Caller;
use vibevalley_runtime::agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, ToolCall, Usage};

struct Scripted {
    answers: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl ModelClient for Scripted {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> vibevalley_runtime::agent::Result<Completion> {
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
    assert!(system.starts_with("你是 VibeValley 的主助手"), "{system}");
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

    // The trajectory has the turn, and the orchestrator writes an oar-voyage/3 record.
    let page = user("session.event.list", json!({ "id": "orchestrator" }));
    assert!(page.to_string().contains("issue_create"), "{page}");
    let record_path = dir.path().join("records").join("orchestrator.jsonl");
    let (header, recorded_events) = vibevalley_runtime::oar::read_record_with_header(&record_path).unwrap();
    assert_eq!(header.as_ref().map(|h| h.format.as_str()), Some("oar-voyage/3"));
    assert!(
        recorded_events
            .iter()
            .any(|e| matches!(&e.kind, vibevalley_runtime::oar::EventKind::ToolCallStarted { name, .. } if name == "issue_create")),
        "{recorded_events:?}"
    );

    // The user marks that answer wrong: the turn is kept as a case to replay.
    let asked = page["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["type"] == "user/message")
        .unwrap_or_else(|| panic!("{page}"));
    let said = page["events"].as_array().unwrap().iter().find(|e| e["type"] != "user/message").unwrap();
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
    let at = vibevalley_server::now() + 120;
    user(
        "cron.create",
        json!({ "name": "早会", "text": "看看昨天的活", "when": { "kind": "once", "at": at } }),
    );
    std::thread::sleep(Duration::from_millis(150));
    started.crons.tick();
    until("the cron's turn", || {
        let seen = model.seen.lock().unwrap();
        seen.iter()
            .any(|r| r.messages.last().and_then(|m| m.content.clone()).is_some_and(|c| c.contains("[来源：定时]")))
            .then_some(())
    });
    started.board.close();
}

fn approval_fixture(home: &std::path::Path) -> (Arc<Scripted>, vibevalley_server::ServerConfig) {
    use vibevalley_runtime::agent::extensions::governance::Policy;
    let model = Arc::new(Scripted {
        answers: Mutex::new([call("approval-1", "issue_create", json!({"title":"Approved work"})), say("done")].into()),
        seen: Default::default(),
    });
    let mut cfg = vibevalley_server::ServerConfig {
        model_client: Some(model.clone()),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        ..vibevalley_server::ServerConfig::under(home)
    };
    cfg.tool_permissions.overrides.insert("issue_create".into(), Policy::AlwaysAsk);
    (model, cfg)
}

fn ask_to_create_issue(started: &vibevalley_server::Started) -> String {
    let channel = started.chat.default_channel();
    let sent = started.hub.call_as(
        Caller::User,
        "channel.message.send",
        json!({"id":channel,"text":"create a task","sendKey":"stable-input"}),
    );
    assert_eq!(sent.biz_code, 0);
    channel
}

fn pending_approvals(hub: &vibevalley_server::Hub) -> Value {
    let reply = hub.call_as(Caller::User, "orchestrator.approval.list", json!({}));
    assert_eq!(reply.biz_code, 0);
    reply.data.unwrap()
}

#[test]
fn durable_approval_survives_restart_and_one_competing_decision_wins() {
    let home = tempfile::tempdir().unwrap();
    let (model, cfg) = approval_fixture(home.path());
    let started = vibevalley_server::start(cfg.clone()).unwrap();
    let channel = ask_to_create_issue(&started);
    let card = until("pending approval", || pending_approvals(&started.hub).as_array()?.first().cloned());
    assert_eq!(card["toolName"], "issue_create");
    assert_eq!(card["toolCallId"], "approval-1");
    started.close();

    let reopened = vibevalley_server::start(cfg).unwrap();
    assert_eq!(pending_approvals(&reopened.hub), json!([card]));
    let resolve = |p| reopened.hub.call_as(Caller::User, "orchestrator.approval.resolve", p);
    let approved = json!({
        "conversationId":card["conversationId"],"taskId":card["taskId"],"toolCallId":card["toolCallId"],"approved":true
    });
    let mut foreign = approved.clone();
    foreign["conversationId"] = json!("wrong");
    assert_ne!(resolve(foreign).biz_code, 0);
    let denied_as_helper = reopened.hub.call_as(Caller::Session, "orchestrator.approval.resolve", approved.clone());
    assert_ne!(denied_as_helper.biz_code, 0);
    assert_eq!(pending_approvals(&reopened.hub), json!([card]));

    let answers = std::thread::scope(|s| {
        let a = s.spawn(|| resolve(approved.clone()));
        let b = s.spawn(|| resolve(approved.clone()));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!((answers.0.biz_code, answers.1.biz_code), (0, 0));
    let mut opposite = approved.clone();
    opposite["approved"] = json!(false);
    assert_ne!(resolve(opposite).biz_code, 0);
    until("assistant reported after recovery", || {
        let messages = reopened.hub.call_as(Caller::User, "channel.message.list", json!({"id":channel})).data?;
        messages.as_array()?.iter().any(|m| m["text"] == "done").then_some(())
    });
    let list = reopened.hub.call_as(Caller::User, "issue.list", json!({})).data.unwrap();
    assert_eq!(list.as_array().unwrap().iter().filter(|i| i["title"] == "Approved work").count(), 1);
    assert_eq!(pending_approvals(&reopened.hub), json!([]));
    assert_eq!(model.seen.lock().unwrap().len(), 2);
    reopened.close();
}

#[test]
fn crash_restores_the_builtin_worker_in_the_same_issue_run() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use vibevalley_protocol::IssueStageKind;
    const CHILD: &str = "VV_TEST_CRASHED_BUILTIN_HOME";
    struct CrashModel {
        crash: bool,
        calls: AtomicUsize,
    }
    impl ModelClient for CrashModel {
        fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> vibevalley_runtime::agent::Result<Completion> {
            let n = self.calls.fetch_add(1, Ordering::AcqRel);
            if self.crash && n == 0 {
                return Ok(call("append-once", "bash", json!({"command":"printf x >> durable-count.txt"})));
            }
            assert!(
                request
                    .messages
                    .iter()
                    .any(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some("append-once")),
                "expected committed tool result"
            );
            if self.crash {
                std::process::exit(87);
            }
            let text = "recovered same worker";
            on(Delta::Text(text.into()));
            Ok(say(text))
        }
    }
    fn launch(path: &std::path::Path, model: Arc<CrashModel>) -> (vibevalley_server::Started, vibevalley_server::transport::http::Listener) {
        let server = vibevalley_server::start(vibevalley_server::ServerConfig {
            model_client: Some(model),
            probe_runtimes: false,
            tick_crons: false,
            link_previews: false,
            orchestrator_listens: false,
            ..vibevalley_server::ServerConfig::under(path)
        })
        .unwrap();
        let listen = vibevalley_server::transport::http::serve(server.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
        server.board.sessions().set_mcp_url(format!("{}/mcp", listen.url()));
        (server, listen)
    }
    if let Some(home) = std::env::var_os(CHILD) {
        let (start, _listen) = launch(
            std::path::Path::new(&home),
            Arc::new(CrashModel {
                crash: true,
                calls: AtomicUsize::new(0),
            }),
        );
        let call = |op: &str, p: Value| {
            let e = start.hub.call_as(Caller::User, op, p);
            assert_eq!(e.biz_code, 0, "{e:?}");
            e.data.unwrap_or(Value::Null)
        };
        call("repo.create", json!({"name":"demo"}));
        let mut helper = start.agents.profiles.install_template("reviewer").unwrap();
        helper.runtime = "vibevalley".into();
        helper.model = "deepseek-flash".into();
        helper.name = "Durable worker".into();
        start.agents.profiles.save(helper).unwrap();
        let issue = call("issue.create", json!({"title":"Record one line","repo":"demo","agent":"Durable worker"}));
        call("issue.status.update", json!({"id":issue["id"],"status":"todo"}));
        until("process exit", || None::<()>);
        unreachable!();
    }
    let home = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "orchestrator::crash_restores_the_builtin_worker_in_the_same_issue_run",
            "--nocapture",
        ])
        .env(CHILD, home.path())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(87),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let model = Arc::new(CrashModel {
        crash: false,
        calls: AtomicUsize::new(0),
    });
    let (start, _listen) = launch(home.path(), model.clone());
    let issue = until("worker recovered", || {
        start.board.issue("1").filter(|i| i.stage.state == IssueStageKind::Reviewing)
    });
    let session = start.board.session(issue.latest_session_id().unwrap()).unwrap();
    assert_eq!(
        std::fs::read(std::path::Path::new(session.cwd.as_deref().unwrap()).join("durable-count.txt")).unwrap(),
        b"x"
    );
    let runs = start.board.runs(&issue.id).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].summary, "recovered same worker");
    assert_eq!(session.runs, 1);
    assert_eq!(model.calls.load(Ordering::Acquire), 1);
    start.close();
}

#[test]
fn regression_the_orchestrator_uses_one_mcp_connection_across_generation_phases() {
    use vibevalley_protocol::{MCPServer, MCPServerStdio};
    use vibevalley_runtime::agent::extensions::governance::{Permissions, Policy};

    let dir = tempfile::tempdir().unwrap();
    let starts = dir.path().join("starts");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/tests/fixtures/echo_mcp.py");
    let model = Arc::new(Scripted {
        answers: Mutex::new(VecDeque::from([
            call("external", "probe__echo", json!({"text":"server roundtrip"})),
            say("external done"),
        ])),
        seen: Default::default(),
    });
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(vibevalley_runtime::oar::Registry::new())),
        probe_runtimes: false,
        link_previews: false,
        watch_pkm: false,
        tick_crons: false,
        tool_permissions: Permissions {
            overrides: [("probe__echo".into(), Policy::AlwaysAllow)].into(),
            ..Default::default()
        },
        model_client: Some(model.clone()),
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .unwrap();
    let mut profile = started.agents.profiles.agent("orchestrator").unwrap();
    profile.mcp_servers.push(MCPServer::Stdio(MCPServerStdio {
        name: "probe".into(),
        command: "python3".into(),
        args: vec![
            "-I".into(),
            "-c".into(),
            "import sys,runpy; open(sys.argv[1],'a').write('start\\n'); runpy.run_path(sys.argv[2])".into(),
            starts.to_string_lossy().into_owned(),
            script.to_string_lossy().into_owned(),
        ],
        env: Default::default(),
    }));
    profile.disallowed_tools.push("probe__fail".into());
    started.agents.profiles.save(profile.clone()).unwrap();
    let send = |key: &str| {
        let res = started.hub.call_as(
            Caller::User,
            "channel.message.send",
            json!({"id":started.chat.default_channel(),"text":key,"sendKey":key}),
        );
        assert_eq!(res.biz_code, 0, "{res:?}");
    };
    send("call the profile tool");
    until("MCP result reached the orchestrator model", || {
        model
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| {
                r.messages
                    .iter()
                    .any(|m| m.tool_call_id.as_deref() == Some("external") && m.content.as_deref() == Some("echo: server roundtrip"))
            })
            .then_some(())
    });
    {
        let requests = model.seen.lock().unwrap();
        assert!(
            requests
                .iter()
                .all(|r| r.tools.iter().any(|t| t.name == "probe__echo") && r.tools.iter().all(|t| t.name != "probe__fail"))
        );
    }
    assert_eq!(std::fs::read_to_string(starts).unwrap(), "start\n");
    profile.mcp_servers.clear();
    started.agents.profiles.save(profile).unwrap();
    send("after removing the server");
    until("the removed profile tool disappears", || {
        model
            .seen
            .lock()
            .unwrap()
            .last()
            .is_some_and(|r| r.tools.iter().all(|t| !t.name.starts_with("probe__")))
            .then_some(())
    });
    started.close();
}

#[test]
fn regression_a_stale_approval_cannot_grant_the_next_call_over_http() {
    use vibevalley_protocol::{Envelope, InboxFrom, InboxKind, InboxTarget, Issue, OrchestratorApproval, SliceKind};
    use vibevalley_server::Server;

    let home = tempfile::tempdir().unwrap();
    let (model, cfg) = approval_fixture(home.path());
    model
        .answers
        .lock()
        .unwrap()
        .insert(1, call("approval-2", "issue_create", json!({"title":"Denied work"})));
    let started = vibevalley_server::start(cfg.clone()).unwrap();
    let http = vibevalley_server::transport::http::serve(started.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let channel = ask_to_create_issue(&started);
    let request = |path: &str, input: Value| -> Envelope {
        let url = format!("{}/api/v1/{path}", http.url());
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        agent.post(url).send_json(input).unwrap().body_mut().read_json().unwrap()
    };
    let list = |filter| -> Vec<OrchestratorApproval> {
        let reply = request("orchestrator/approval/list", filter);
        assert_eq!(reply.biz_code, 0);
        serde_json::from_value(reply.data.unwrap()).unwrap()
    };
    let first = until("first approval", || list(json!({})).into_iter().next());
    assert_eq!(first.tool_call_id, "approval-1");
    assert_eq!(serde_json::from_str::<Value>(&first.arguments_json).unwrap(), json!({"title":"Approved work"}));
    assert!(list(json!({"conversationId":"another-assistant"})).is_empty());
    // Durable permission_park alerts are ignored by RuntimeInboxObserver; budget_reached alerts project into InboxSlice.
    assert!(
        started.hub.inbox_slice().items.iter().all(|i| !matches!(i.from, InboxFrom::Runtime(_))),
        "permission_park must not appear in InboxSlice"
    );
    let decision = |approval: &OrchestratorApproval, approved: bool| json!({"conversationId":approval.conversation_id,"taskId":approval.task_id,"toolCallId":approval.tool_call_id,"approved":approved});
    let mut ambiguous = decision(&first, true);
    ambiguous.as_object_mut().unwrap().remove("toolCallId");
    assert_ne!(request("orchestrator/approval/resolve", ambiguous).biz_code, 0);
    assert_eq!(request("orchestrator/approval/resolve", decision(&first, true)).biz_code, 0);

    let filter = json!({"conversationId":first.conversation_id});
    let second = until("second approval", || {
        list(filter.clone()).into_iter().find(|item| item.tool_call_id == "approval-2")
    });
    assert_eq!(second.task_id, first.task_id);
    assert_eq!(request("orchestrator/approval/resolve", decision(&first, true)).biz_code, 0);
    assert_eq!(list(filter).into_iter().next().unwrap().tool_call_id, second.tool_call_id);
    assert_eq!(request("orchestrator/approval/resolve", decision(&second, false)).biz_code, 0);

    // Emit a durable pi.inbox budget_reached alert and verify it lands immediately in InboxSlice & slice_snapshot.
    started
        .orchestrator
        .execution
        .store()
        .write(|tx| {
            tx.alert(
                Some(&first.conversation_id),
                &json!({
                    "kind": "budget_reached",
                    "taskId": first.task_id,
                    "conversationId": first.conversation_id,
                    "title": "Session budget reached",
                    "message": "Budget cap hit",
                    "createdAtMs": 123456,
                }),
            )?;
            Ok(())
        })
        .unwrap();
    let runtime_alert = until("budget_reached alert in InboxSlice", || {
        started.hub.inbox_slice().items.into_iter().find(|i| i.kind == InboxKind::BudgetReached)
    });
    assert_eq!(runtime_alert.from, InboxFrom::Runtime(vibevalley_protocol::InboxFromRuntime {}));
    assert_eq!(
        runtime_alert.target,
        InboxTarget::Runtime(vibevalley_protocol::InboxTargetRuntime {
            task_id: first.task_id.clone(),
            session_id: Some(first.conversation_id.clone()),
        })
    );
    assert_eq!(runtime_alert.text, "Budget cap hit");
    let snap = started.hub.slice_snapshot(SliceKind::Inbox);
    assert!(snap["items"].as_array().unwrap().iter().any(|i| i["kind"] == "budget_reached"), "{snap}");
    let raised = started.hub.raise_budget(json!({
        "conversationId": first.conversation_id,
        "taskId": first.task_id,
        "newMaxCostMicros": 10_000,
    }));
    assert_eq!(raised.biz_code, 0, "{raised:?}");
    assert_eq!(raised.data.unwrap()["maxCostMicros"], 10_000);
    until("assistant's approved round settled", || {
        let messages = started.hub.call_as(Caller::User, "channel.message.list", json!({"id":channel})).data?;
        messages.as_array()?.iter().any(|m| m["text"] == "done").then_some(())
    });
    assert!(list(json!({})).is_empty());
    let issues: Vec<Issue> = serde_json::from_value(request("issue/list", json!({})).data.unwrap()).unwrap();
    assert!(!issues.iter().any(|i| i.title == "Denied work"));
    let issue_id = issues.into_iter().find(|i| i.title == "Approved work").unwrap().id;

    drop(http);
    started.close();
    let reopened = vibevalley_server::start(cfg).unwrap();
    assert_eq!(pending_approvals(&reopened.hub), json!([]));
    let result = reopened.hub.call_as(Caller::User, "issue.list", json!({}));
    let issues: Vec<Issue> = serde_json::from_value(result.data.unwrap()).unwrap();
    let recovered: Vec<_> = issues.into_iter().filter(|i| i.title == "Approved work").map(|i| i.id).collect();
    assert_eq!(recovered, [issue_id]);
    assert_eq!(model.seen.lock().unwrap().len(), 3);
    reopened.close();
}

mod grading;
