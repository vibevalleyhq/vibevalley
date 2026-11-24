//! The orchestrator over a scripted model: the user's words in #general
//! wake it with the farm's situation; its tool call records an issue; its
//! words are said in #general; a cron for no profile reaches it.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_core::{Clock, ManualClock};
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

struct SignaledScripted {
    answers: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
    seen_changed: Condvar,
}

impl SignaledScripted {
    fn new(answers: impl Into<VecDeque<Completion>>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            seen: Mutex::new(vec![]),
            seen_changed: Condvar::new(),
        })
    }

    fn wait_seen(&self, what: &str, mut pred: impl FnMut(&[ChatRequest]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut guard = self.seen.lock().unwrap();
        loop {
            if pred(&guard) {
                return;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                panic!("waited for {what}");
            };
            let (next, res) = self.seen_changed.wait_timeout(guard, remaining).unwrap();
            guard = next;
            if res.timed_out() && !pred(&guard) {
                panic!("waited for {what}");
            }
        }
    }
}

impl ModelClient for SignaledScripted {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> vibevalley_runtime::agent::Result<Completion> {
        {
            self.seen.lock().unwrap().push(request.clone());
            self.seen_changed.notify_all();
        }
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| say("好的。"));
        if let Some(t) = &answer.message.content {
            on(Delta::Text(t.clone()));
        }
        Ok(answer)
    }
}

fn until<T>(what: &str, f: impl FnMut() -> Option<T>) -> T {
    crate::support::wait_until_settled(None, Duration::from_secs(30), what, f)
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

#[test]
fn the_orchestrator_hears_the_user_and_records_an_issue() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let model = SignaledScripted::new([
        call("c1", "issue_create", json!({ "title": "在 demo 里写 README", "repo": "demo" })),
        say("记下了 #1，在备选里。"),
        call("c2", "cron_list", json!({})),
        say("到点了，看过了。"),
    ]);
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let started = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        model_client: Some(model.clone()),
        clock: clock.clone(),
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let hub = started.router().clone();
    let user = |op: &str, p: Value| {
        let e = hub.call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };
    user("repo.create", json!({ "name": "demo" }));
    // The orchestrator is on duty in the state.
    let on_duty = crate::support::board_sessions(started.test_internals().board)
        .into_iter()
        .find(|h| h.id == "orchestrator")
        .expect("on duty");
    assert_eq!(serde_json::to_value(on_duty.role).unwrap(), "orchestrator");

    let general = started.test_internals().channel.default_channel();
    user(
        "channel.message.send",
        json!({ "id": general, "text": "帮我在 demo 里把 README 写了", "sendKey": "ask" }),
    );
    let words = crate::support::wait_until_channel_event(started.test_internals().channel, Duration::from_secs(30), "the orchestrator's words", || {
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
    let at = clock.now_ms() + 120;
    user(
        "cron.create",
        json!({ "name": "早会", "text": "看看昨天的活", "when": { "kind": "once", "at": at } }),
    );
    clock.advance(Duration::from_millis(150));
    vibevalley_runtime::rt::block_on(started.test_internals().cron.tick_async());
    model.wait_seen("the cron's turn", |seen| {
        seen.iter()
            .any(|r| r.messages.last().and_then(|m| m.content.clone()).is_some_and(|c| c.contains("[来源：定时]")))
    });
    started.close_blocking();
}

fn approval_fixture(home: &std::path::Path) -> (Arc<SignaledScripted>, vibevalley_server::Config) {
    use vibevalley_runtime::agent::extensions::governance::Policy;
    let model = SignaledScripted::new([call("approval-1", "issue_create", json!({"title":"Approved work"})), say("done")]);
    let mut cfg = vibevalley_server::Config {
        model_client: Some(model.clone()),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        ..vibevalley_server::Config::under(home)
    };
    cfg.tool_permissions.overrides.insert("issue_create".into(), Policy::AlwaysAsk);
    (model, cfg)
}

fn ask_to_create_issue(started: &vibevalley_server::App) -> String {
    let channel = started.test_internals().channel.default_channel();
    let sent = started.router().call_as(
        Caller::User,
        "channel.message.send",
        json!({"id":channel,"text":"create a task","sendKey":"stable-input"}),
    );
    assert_eq!(sent.biz_code, 0);
    channel
}

fn pending_approvals(router: &vibevalley_server::Router) -> Value {
    let reply = router.call_as(Caller::User, "orchestrator.approval.list", json!({}));
    assert_eq!(reply.biz_code, 0);
    reply.data.unwrap()
}

#[test]
fn durable_approval_survives_restart_and_one_competing_decision_wins() {
    let home = tempfile::tempdir().unwrap();
    let (model, cfg) = approval_fixture(home.path());
    let started = vibevalley_server::create_app_blocking(cfg.clone()).unwrap();
    let channel = ask_to_create_issue(&started);
    let card = crate::support::wait_until_settled(Some(started.ctx()), Duration::from_secs(30), "pending approval", || {
        pending_approvals(started.router()).as_array()?.first().cloned()
    });
    assert_eq!(card["toolName"], "issue_create");
    assert_eq!(card["toolCallId"], "approval-1");
    started.close_blocking();

    let reopened = vibevalley_server::create_app_blocking(cfg).unwrap();
    assert_eq!(pending_approvals(reopened.router()), json!([card]));
    let resolve = |p| reopened.router().call_as(Caller::User, "orchestrator.approval.resolve", p);
    let approved = json!({
        "conversationId":card["conversationId"],"taskId":card["taskId"],"toolCallId":card["toolCallId"],"approved":true
    });
    let mut foreign = approved.clone();
    foreign["conversationId"] = json!("wrong");
    assert_ne!(resolve(foreign).biz_code, 0);
    let denied_as_helper = reopened.router().call_as(Caller::Session, "orchestrator.approval.resolve", approved.clone());
    assert_ne!(denied_as_helper.biz_code, 0);
    assert_eq!(pending_approvals(reopened.router()), json!([card]));

    let answers = std::thread::scope(|s| {
        let a = s.spawn(|| resolve(approved.clone()));
        let b = s.spawn(|| resolve(approved.clone()));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!((answers.0.biz_code, answers.1.biz_code), (0, 0));
    let mut opposite = approved.clone();
    opposite["approved"] = json!(false);
    assert_ne!(resolve(opposite).biz_code, 0);
    crate::support::wait_until_channel_event(
        reopened.test_internals().channel,
        Duration::from_secs(30),
        "assistant reported after recovery",
        || {
            let messages = reopened.router().call_as(Caller::User, "channel.message.list", json!({"id":channel})).data?;
            messages.as_array()?.iter().any(|m| m["text"] == "done").then_some(())
        },
    );
    let list = reopened.router().call_as(Caller::User, "issue.list", json!({})).data.unwrap();
    assert_eq!(list.as_array().unwrap().iter().filter(|i| i["title"] == "Approved work").count(), 1);
    assert_eq!(pending_approvals(reopened.router()), json!([]));
    assert_eq!(model.seen.lock().unwrap().len(), 2);
    reopened.close_blocking();
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
    fn launch(path: &std::path::Path, model: Arc<CrashModel>) -> (vibevalley_server::App, vibevalley_server::gateway::http::Listener) {
        let server = vibevalley_server::create_app_blocking(vibevalley_server::Config {
            model_client: Some(model),
            probe_runtimes: false,
            tick_crons: false,
            link_previews: false,
            orchestrator_listens: false,
            ..vibevalley_server::Config::under(path)
        })
        .unwrap();
        let listen = vibevalley_server::gateway::http::serve(server.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
        server.set_mcp_url(format!("{}/mcp", listen.url()));
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
            let e = start.router().call_as(Caller::User, op, p);
            assert_eq!(e.biz_code, 0, "{e:?}");
            e.data.unwrap_or(Value::Null)
        };
        call("repo.create", json!({"name":"demo"}));
        let mut helper = vibevalley_runtime::rt::block_on(start.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
        helper.runtime = "vibevalley".into();
        helper.model = "deepseek-flash".into();
        helper.name = "Durable worker".into();
        vibevalley_runtime::rt::block_on(start.test_internals().agent.profile.store.save_async(helper)).unwrap();
        let issue = call("issue.create", json!({"title":"Record one line","repo":"demo","agent":"Durable worker"}));
        call("issue.status.update", json!({"id":issue["id"],"status":"todo"}));
        std::thread::park_timeout(Duration::from_secs(30));
        panic!("child worker did not crash with exit code 87");
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
    let issue = crate::support::wait_until_transition(start.ctx(), Duration::from_secs(30), "worker recovered", || {
        crate::support::board_issue(start.test_internals().board, "1").filter(|i| i.stage.state == IssueStageKind::Reviewing)
    });
    let session = crate::support::board_session(start.test_internals().board, issue.latest_session_id().unwrap()).unwrap();
    assert_eq!(
        std::fs::read(std::path::Path::new(session.cwd.as_deref().unwrap()).join("durable-count.txt")).unwrap(),
        b"x"
    );
    let runs = vibevalley_runtime::rt::block_on(start.test_internals().board.runs_async(&issue.id)).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].summary, "recovered same worker");
    assert_eq!(session.runs, 1);
    assert_eq!(model.calls.load(Ordering::Acquire), 1);
    start.close_blocking();
}

fn vv_test_fixture_bin() -> &'static std::path::Path {
    static BIN: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    BIN.get_or_init(|| {
        let bin_name = format!("vv_test_fixture{}", std::env::consts::EXE_SUFFIX);
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("crates/server sits two levels below workspace root");
        let mut candidates = Vec::new();
        if let Ok(exe) = std::env::current_exe()
            && let Some(dir) = exe.parent().and_then(|p| p.parent())
        {
            candidates.push(dir.join(&bin_name));
        }
        if let Some(target_dir) = std::env::var_os("CARGO_TARGET_DIR") {
            candidates.push(std::path::PathBuf::from(target_dir).join("debug").join(&bin_name));
        }
        candidates.push(workspace_root.join("target").join("debug").join(&bin_name));
        if let Some(found) = candidates.iter().find(|p| p.is_file()) {
            return found.clone();
        }
        let status = std::process::Command::new("cargo")
            .args(["build", "-q", "-p", "vibevalley-runtime", "--bin", "vv_test_fixture"])
            .current_dir(workspace_root)
            .status()
            .expect("spawn cargo build for vv_test_fixture");
        assert!(status.success(), "cargo build -p vibevalley-runtime --bin vv_test_fixture failed: {status}");
        candidates
            .into_iter()
            .find(|p| p.is_file())
            .expect("vv_test_fixture binary missing after cargo build")
    })
}

#[test]
fn regression_the_orchestrator_uses_one_mcp_connection_across_generation_phases() {
    use vibevalley_protocol::{MCPServer, MCPServerStdio};
    use vibevalley_runtime::agent::extensions::governance::{Permissions, Policy};

    let dir = tempfile::tempdir().unwrap();
    let starts = dir.path().join("starts");
    let fixture = vv_test_fixture_bin();
    let model = SignaledScripted::new([call("external", "probe__echo", json!({"text":"server roundtrip"})), say("external done")]);
    let started = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(vibevalley_runtime::oar::Registry::new())),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        tool_permissions: Permissions {
            overrides: [("probe__echo".into(), Policy::AlwaysAllow)].into(),
            ..Default::default()
        },
        model_client: Some(model.clone()),
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let mut profile = started.test_internals().agent.profile.agent("orchestrator").unwrap();
    profile.mcp_servers.push(MCPServer::Stdio(MCPServerStdio {
        name: "probe".into(),
        command: fixture.to_string_lossy().into_owned(),
        args: vec!["--record-start".into(), starts.to_string_lossy().into_owned(), "echo_mcp".into()],
        env: Default::default(),
    }));
    profile.disallowed_tools.push("probe__fail".into());
    vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(profile.clone())).unwrap();
    let send = |key: &str| {
        let res = started.router().call_as(
            Caller::User,
            "channel.message.send",
            json!({"id":started.test_internals().channel.default_channel(),"text":key,"sendKey":key}),
        );
        assert_eq!(res.biz_code, 0, "{res:?}");
    };
    send("call the profile tool");
    model.wait_seen("MCP result reached the orchestrator model", |seen| {
        seen.iter().any(|r| {
            r.messages
                .iter()
                .any(|m| m.tool_call_id.as_deref() == Some("external") && m.content.as_deref() == Some("echo: server roundtrip"))
        })
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
    vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(profile)).unwrap();
    send("after removing the server");
    model.wait_seen("the removed profile tool disappears", |seen| {
        seen.last().is_some_and(|r| r.tools.iter().all(|t| !t.name.starts_with("probe__")))
    });
    started.close_blocking();
}

#[test]
fn regression_a_stale_approval_cannot_grant_the_next_call_over_http() {
    use vibevalley_protocol::{Envelope, InboxFrom, InboxKind, InboxSlice, InboxTarget, Issue, OrchestratorApproval, SliceKind};

    let home = tempfile::tempdir().unwrap();
    let (model, cfg) = approval_fixture(home.path());
    model
        .answers
        .lock()
        .unwrap()
        .insert(1, call("approval-2", "issue_create", json!({"title":"Denied work"})));
    let started = vibevalley_server::create_app_blocking(cfg.clone()).unwrap();
    let http = vibevalley_server::gateway::http::serve(started.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let channel = ask_to_create_issue(&started);
    let request = |path: &str, input: Value| -> Envelope {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let url = format!("{}/api/v1/{path}", http.url());
        let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
        client.post(url).json(&input).send().unwrap().json().unwrap()
    };
    let list = |filter| -> Vec<OrchestratorApproval> {
        let reply = request("orchestrator/approval/list", filter);
        assert_eq!(reply.biz_code, 0);
        serde_json::from_value(reply.data.unwrap()).unwrap()
    };
    let inbox_slice = |app: &vibevalley_server::App| -> InboxSlice {
        vibevalley_runtime::rt::block_on(app.ctx().feed.flush());
        serde_json::from_str(&app.ctx().feed.snapshot_json(SliceKind::Inbox)).unwrap()
    };
    let first = crate::support::wait_until_settled(Some(started.ctx()), Duration::from_secs(30), "first approval", || {
        list(json!({})).into_iter().next()
    });
    assert_eq!(first.tool_call_id, "approval-1");
    assert_eq!(serde_json::from_str::<Value>(&first.arguments_json).unwrap(), json!({"title":"Approved work"}));
    assert!(list(json!({"conversationId":"another-assistant"})).is_empty());
    // Durable permission_park alerts are ignored by RuntimeInboxObserver; budget_reached alerts project into InboxSlice.
    assert!(
        inbox_slice(&started).items.iter().all(|i| !matches!(i.from, InboxFrom::Runtime(_))),
        "permission_park must not appear in InboxSlice"
    );
    let decision = |approval: &OrchestratorApproval, approved: bool| json!({"conversationId":approval.conversation_id,"taskId":approval.task_id,"toolCallId":approval.tool_call_id,"approved":approved});
    let mut ambiguous = decision(&first, true);
    ambiguous.as_object_mut().unwrap().remove("toolCallId");
    assert_ne!(request("orchestrator/approval/resolve", ambiguous).biz_code, 0);
    assert_eq!(request("orchestrator/approval/resolve", decision(&first, true)).biz_code, 0);

    let filter = json!({"conversationId":first.conversation_id});
    let second = crate::support::wait_until_settled(Some(started.ctx()), Duration::from_secs(30), "second approval", || {
        list(filter.clone()).into_iter().find(|item| item.tool_call_id == "approval-2")
    });
    assert_eq!(second.task_id, first.task_id);
    assert_eq!(request("orchestrator/approval/resolve", decision(&first, true)).biz_code, 0);
    assert_eq!(list(filter).into_iter().next().unwrap().tool_call_id, second.tool_call_id);
    assert_eq!(request("orchestrator/approval/resolve", decision(&second, false)).biz_code, 0);

    // Emit a durable pi.inbox budget_reached alert and verify it lands immediately in InboxSlice & slice_snapshot.
    started
        .test_internals()
        .agent
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
    let runtime_alert = crate::support::wait_until_slice(
        started.ctx(),
        SliceKind::Inbox,
        Duration::from_secs(30),
        "budget_reached alert in InboxSlice",
        || inbox_slice(&started).items.into_iter().find(|i| i.kind == InboxKind::BudgetReached),
    );
    assert_eq!(runtime_alert.from, InboxFrom::Runtime(vibevalley_protocol::InboxFromRuntime {}));
    assert_eq!(
        runtime_alert.target,
        InboxTarget::Runtime(vibevalley_protocol::InboxTargetRuntime {
            task_id: first.task_id.clone(),
            session_id: Some(first.conversation_id.clone()),
        })
    );
    assert_eq!(runtime_alert.text, "Budget cap hit");
    let snap: Value = serde_json::from_str(&started.ctx().feed.snapshot_json(SliceKind::Inbox)).unwrap();
    assert!(snap["items"].as_array().unwrap().iter().any(|i| i["kind"] == "budget_reached"), "{snap}");
    crate::support::wait_until_channel_event(
        started.test_internals().channel,
        Duration::from_secs(30),
        "assistant's approved round settled",
        || {
            let messages = started.router().call_as(Caller::User, "channel.message.list", json!({"id":channel})).data?;
            messages.as_array()?.iter().any(|m| m["text"] == "done").then_some(())
        },
    );
    assert!(list(json!({})).is_empty());
    let issues: Vec<Issue> = serde_json::from_value(request("issue/list", json!({})).data.unwrap()).unwrap();
    assert!(!issues.iter().any(|i| i.title == "Denied work"));
    let issue_id = issues.into_iter().find(|i| i.title == "Approved work").unwrap().id;

    drop(http);
    started.close_blocking();
    let reopened = vibevalley_server::create_app_blocking(cfg).unwrap();
    assert_eq!(pending_approvals(reopened.router()), json!([]));
    let result = reopened.router().call_as(Caller::User, "issue.list", json!({}));
    let issues: Vec<Issue> = serde_json::from_value(result.data.unwrap()).unwrap();
    let recovered: Vec<_> = issues.into_iter().filter(|i| i.title == "Approved work").map(|i| i.id).collect();
    assert_eq!(recovered, [issue_id]);
    assert_eq!(model.seen.lock().unwrap().len(), 3);
    reopened.close_blocking();
}

mod grading;
