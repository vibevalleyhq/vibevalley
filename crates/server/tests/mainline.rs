use std::collections::VecDeque;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller, IssueStageKind, IssueStatus};
use vibevalley_runtime::agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, ToolCall, Usage};
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};
use vibevalley_runtime::oar::{McpServer, Registry};
use vibevalley_server::{ServerConfig, Started};

struct Model(Mutex<VecDeque<Completion>>);

impl ModelClient for Model {
    fn complete(&self, _: &ChatRequest, on: &mut dyn FnMut(Delta)) -> vibevalley_runtime::agent::Result<Completion> {
        let answer = self.0.lock().unwrap().pop_front().unwrap_or_else(|| answer(None));
        if let Some(text) = &answer.message.content {
            on(Delta::Text(text.clone()));
        }
        Ok(answer)
    }
}

fn answer(tool: Option<ToolCall>) -> Completion {
    let has_tool = tool.is_some();
    Completion {
        message: Message {
            role: Role::Assistant,
            content: tool.is_none().then(|| "已派出。".into()),
            reasoning: None,
            tool_calls: tool.into_iter().collect(),
            tool_call_id: None,
        },
        finish: if has_tool { FinishReason::ToolCalls } else { FinishReason::Stop },
        usage: Usage {
            input: 1,
            output: 1,
            cache_read: 0,
        },
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().into()
}

fn call(url: &str, op: &str, input: Value) -> Value {
    let mut response = ureq::post(&format!("{url}/api/v1/{}", op.replace('.', "/"))).send_json(input).unwrap();
    let envelope: Value = response.body_mut().read_json().unwrap();
    assert_eq!(envelope["bizCode"], 0, "{op}: {envelope}");
    envelope["data"].clone()
}

fn until<T>(server: &Started, what: &str, mut read: impl FnMut() -> Option<T>) -> T {
    let board_dirty = server.hub.watch_slice_signal(vibevalley_protocol::SliceKind::Board, false);
    let sessions_dirty = server.hub.watch_slice_signal(vibevalley_protocol::SliceKind::Sessions, false);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out: {what}");
        let _ = flume::Selector::new()
            .recv(&board_dirty, |_| ())
            .recv(&sessions_dirty, |_| ())
            .wait_timeout(Duration::from_millis(50));
    }
}

fn config(home: &Path, model: Arc<Model>) -> ServerConfig {
    let mut registry = Registry::new();
    registry.register(Arc::new(ScriptedRuntime::new("scripted", Script::computed(Arc::new(|ask| {
        let file = format!("round-{}.txt", ask.turn + 1);
        std::fs::write(ask.cwd.join(&file), format!("{}\n", ask.prompt)).map_err(|e| e.to_string())?;
        git(&ask.cwd, &["add", &file]);
        git(&ask.cwd, &["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", &file]);
        let (url, headers) = ask.mcp_servers.iter().find_map(|m| match m {
            McpServer::Http { name, url, headers } if name == "vibevalley" => Some((url, headers)),
            _ => None,
        }).ok_or("missing MCP door")?;
        let mut request = ureq::post(url);
        for (name, value) in headers { request = request.header(name, value); }
        let mut response = request.send_json(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "issue_report", "arguments": { "summary": format!("committed {file}"), "remember": [{ "text": "The mainline uses real git", "scope": "all" }] }
        }})).map_err(|e| e.to_string())?;
        let reply: Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
        if reply.get("error").is_some() || !reply["result"].is_object() || reply["result"]["isError"] == true { return Err(reply.to_string()); }
        Ok(vec![
            Step::text(format!("committed {file}")),
            Step::Emit(vibevalley_runtime::oar::EventKind::TurnFinished {
                reason: vibevalley_runtime::oar::StopReason::Completed,
                usage: vibevalley_runtime::oar::Usage {
                    input_tokens: Some(30),
                    output_tokens: Some(12),
                    cost_usd: Some(0.001),
                    ..Default::default()
                },
            }),
        ])
    })))));
    ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        watch_pkm: false,
        model_client: Some(model),
        ..ServerConfig::under(home)
    }
}

#[test]
fn regression_mainline_dispatch_report_follow_up_merge_schedule_and_reopen() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(Model(Mutex::new(VecDeque::new())));
    let server = vibevalley_server::start(config(dir.path(), model.clone())).unwrap();
    let listener = vibevalley_server::transport::http::serve(server.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let url = listener.url();
    server.board.sessions().set_mcp_url(format!("{url}/mcp"));
    call(&url, "repo.create", json!({ "name": "demo" }));
    let mut helper = server.agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    helper.name = "Worker".into();
    server.agents.profiles.save(helper).unwrap();
    let issue = call(&url, "issue.create", json!({ "title": "Write a file", "repo": "demo", "agent": "Worker" }));
    let id = issue["id"].as_str().unwrap().to_string();
    call(&url, "issue.status.update", json!({ "id": id, "status": "todo" }));
    let first = until(&server, "first report", || {
        server.board.issue(&id).filter(|i| i.stage.state == IssueStageKind::Reviewing)
    });
    let session = first.latest_session_id().unwrap().clone();
    let worker = server.board.session(&session).unwrap();
    assert!(Path::new(worker.cwd.as_ref().unwrap()).starts_with(dir.path().join("worktrees")));
    let thread = until(&server, "issue thread", || server.chat.issue_thread_id(&id));
    until(&server, "report in issue thread", || {
        server
            .chat
            .history(&thread, None, None)
            .unwrap()
            .iter()
            .any(|m| m.text.contains("committed round-1.txt"))
            .then_some(())
    });
    until(&server, "report memory stored", || {
        server
            .memories
            .list(worker.profile.as_deref().unwrap())
            .unwrap()
            .iter()
            .any(|m| m.text == "The mainline uses real git")
            .then_some(())
    });
    call(
        &url,
        "channel.message.send",
        json!({ "id": thread, "text": "Add the second file", "sendKey": "follow-up" }),
    );
    until(&server, "second report", || {
        server.board.session(&session).filter(|s| s.runs >= 2 && !s.phase.is_working())
    });
    let runs = call(&url, "issue.run.list", json!({ "id": id }));
    assert_eq!(runs.as_array().unwrap().len(), 2, "{runs}");
    assert!(runs.to_string().contains("committed round-2.txt"), "{runs}");
    assert_eq!(runs[0]["spent"], json!({"tokens":42}));
    assert_eq!(runs[1]["spent"], json!({"tokens":42}));
    let timeline = call(&url, "issue.timeline.get", json!({"id":id}));
    assert_eq!(timeline["spent"], json!({"tokens":84}));
    let last = call(&url, "session.get", json!({"id":session}));
    assert_eq!(last["lastRun"]["spent"], json!({"tokens":42}));
    let events = call(&url, "session.event.list", json!({ "id": session }));
    assert!(events.to_string().contains("Add the second file"), "{events}");
    let changes = call(&url, "issue.diff.get", json!({ "id": id }));
    assert!(changes.to_string().contains("round-2.txt"), "{changes}");
    call(&url, "issue.status.update", json!({ "id": id, "status": "done" }));
    assert_eq!(server.board.issue(&id).unwrap().status, IssueStatus::Done);
    assert!(dir.path().join("repos/demo/round-2.txt").exists());
    assert!(git(&dir.path().join("repos/demo"), &["log", "--oneline", "main"]).contains("round-2.txt"));

    let draft = call(&url, "issue.create", json!({ "title": "Draft permissions", "repo": "demo", "agent": "Worker" }));
    let denied = server.hub.call_as(Caller::Session, "issue.refine", json!({ "id": draft["id"] }));
    assert_eq!(denied.biz_code, BizCode::Forbidden.code());
    call(
        &url,
        "issue.comment.create",
        json!({"id":draft["id"], "text":"For the implementer", "sendKey":"queued-before-draft"}),
    );
    let allowed = server.hub.call_as(Caller::Orchestrator, "issue.refine", json!({ "id": draft["id"] }));
    assert_eq!(allowed.biz_code, 0, "{allowed:?}");
    until(&server, "assistant draft finished", || {
        server.board.issue(draft["id"].as_str().unwrap()).filter(|i| i.refining.is_none())
    });

    let draft_id = draft["id"].as_str().unwrap();
    let run = server.board.runs(draft_id).unwrap().pop().unwrap();
    assert!(run.heard.is_empty());
    let queued = server
        .board
        .sessions()
        .durable_store()
        .read(|tx| {
            assert!(tx.document("run", &run.id, "issue.report")?.is_none());
            tx.submissions(&format!("issue:{draft_id}"))
        })
        .unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].status, vibevalley_runtime::agent::durable::SubmissionStatus::Queued);

    model.0.lock().unwrap().extend([
        answer(Some(ToolCall {
            id: "dispatch".into(),
            name: "issue_create".into(),
            arguments: json!({
                "title": "Assistant task", "repo": "demo", "agent": "Worker", "start": true
            })
            .to_string(),
        })),
        answer(None),
    ]);
    call(
        &url,
        "channel.message.send",
        json!({ "id": server.chat.default_channel(), "text": "Please dispatch the assistant task", "sendKey": "dispatch" }),
    );
    let assistant_issue = until(&server, "assistant dispatched", || {
        server
            .board
            .read(|s| s.issues.iter().find(|i| i.title == "Assistant task" && i.was_sent()).cloned())
    });
    until(&server, "assistant task reported", || {
        server.board.issue(&assistant_issue.id).filter(|i| i.stage.state == IssueStageKind::Reviewing)
    });
    let cron = call(
        &url,
        "cron.create",
        json!({ "name": "Scheduled task", "text": "Write a scheduled file", "agent": "Worker", "repo": "demo", "when": { "kind": "once", "at": vibevalley_server::now() + 100 } }),
    );
    let scheduled = until(&server, "cron dispatched", || {
        server.crons.tick();
        server
            .board
            .read(|s| s.issues.iter().find(|i| i.cron.as_deref() == cron["id"].as_str() && i.was_sent()).cloned())
    });
    until(&server, "cron reported", || {
        server.board.issue(&scheduled.id).filter(|i| i.stage.state == IssueStageKind::Reviewing)
    });
    server.crons.tick();
    assert_eq!(server.board.read(|s| s.issues.iter().filter(|i| i.cron.is_some()).count()), 1);
    server.close();
    drop(listener);
    drop(server);

    let reopened = vibevalley_server::start(config(dir.path(), model)).unwrap();
    assert_eq!(reopened.board.issue(&id).unwrap().status, IssueStatus::Done);
    assert_eq!(reopened.board.runs(&id).unwrap().len(), 2);
    assert!(
        reopened
            .memories
            .list(worker.profile.as_deref().unwrap())
            .unwrap()
            .iter()
            .any(|m| m.text == "The mainline uses real git")
    );
    assert!(reopened.board.past_session(&session).is_some());
    assert!(
        reopened
            .chat
            .history(&thread, None, None)
            .unwrap()
            .iter()
            .any(|m| m.text == "Add the second file")
    );
    assert_eq!(reopened.board.issue(&scheduled.id).unwrap().stage.state, IssueStageKind::Reviewing);
    reopened.close();
}

mod recovery;
