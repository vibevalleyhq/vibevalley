use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use vibevalley_runtime::BoxFuture;
use vibevalley_runtime::agent::core::engine::{KIND as GENERATION_KIND, PHASE_PREPARE};
use vibevalley_runtime::agent::durable::{Store, SubmissionStatus, Task};
use vibevalley_runtime::agent::harness::worker_conversation;
use vibevalley_runtime::agent::runtime::{VibeValleyRuntime, default_registry};
use vibevalley_runtime::agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, ToolCall};
use vibevalley_runtime::oar::{
    AgentError, ContentBlock, ControlAction, ControlStatus, Event, EventKind, FileChangeKind, Installation, PermissionDecision, PermissionMode, Runtime,
    SessionOptions, SessionStatus, StopReason, SubagentStatus,
};

const WAIT: Duration = Duration::from_secs(10);

fn text(s: &str) -> Vec<ContentBlock> {
    vec![ContentBlock::Text(s.into())]
}

async fn until(rx: &mut tokio::sync::mpsc::Receiver<Event>, stop: impl Fn(&EventKind) -> bool) -> Vec<Event> {
    let mut out = Vec::new();
    loop {
        let event = tokio::time::timeout(WAIT, rx.recv())
            .await
            .expect("event before timeout")
            .expect("channel open");
        let done = stop(&event.kind);
        out.push(event);
        if done {
            return out;
        }
    }
}

fn turn_finished(kind: &EventKind) -> bool {
    matches!(kind, EventKind::TurnFinished { .. })
}

fn texts(events: &[Event]) -> String {
    events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

struct Answers {
    queue: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl ModelClient for Answers {
    fn complete<'a>(&'a self, req: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> BoxFuture<'a, vibevalley_runtime::agent::Result<Completion>> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(req.clone());
            let c = self.queue.lock().unwrap().pop_front().expect("an answer");
            if let Some(t) = &c.message.content {
                on(Delta::Text(t.clone()));
            }
            Ok(c)
        })
    }
}

fn answers(list: Vec<Completion>) -> Arc<Answers> {
    Arc::new(Answers {
        queue: Mutex::new(list.into()),
        seen: Default::default(),
    })
}

fn msg(content: Option<&str>, calls: Vec<ToolCall>) -> Completion {
    Completion {
        finish: if calls.is_empty() { FinishReason::Stop } else { FinishReason::ToolCalls },
        message: Message {
            role: Role::Assistant,
            content: content.map(str::to_string),
            reasoning: None,
            tool_calls: calls,
            tool_call_id: None,
        },
        usage: vibevalley_runtime::agent::Usage {
            input: 1000,
            output: 100,
            cache_read: 0,
        },
    }
}

#[test]
fn default_registry_includes_vibevalley_and_external_runtimes() {
    let registry = default_registry();
    for id in [
        "claude",
        "codex",
        "antigravity",
        "grok",
        "kimi",
        "codebuddy",
        "opencode",
        "vibevalley",
        "scripted",
    ] {
        assert!(registry.get(id).is_some(), "{id}");
    }
}

#[tokio::test]
async fn list_models_and_capabilities_reflect_unified_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf());
    let caps = runtime.capabilities();
    assert!(caps.resume);
    assert!(caps.steer);
    assert!(caps.queue);
    assert!(caps.permission_requests);
    assert!(caps.model_selection);
    assert!(caps.subagents);
    assert!(caps.usage);

    let models = runtime.list_models().await.unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]
    );
    assert!(models[0].is_default);
    assert_eq!(models[0].effort_levels, vec!["high", "max"]);
}

#[tokio::test]
async fn a_disallowed_tool_is_not_there_and_a_replacing_prompt_is_used() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let write = ToolCall {
        id: "t1".into(),
        name: "write".into(),
        arguments: json!({"path": "x.txt", "content": "no"}).to_string(),
    };
    let runtime =
        VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(answers(vec![msg(None, vec![write]), msg(Some("ok"), vec![])]));
    let session = runtime
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Bypass,
            disallowed_tools: vec!["write".into()],
            system_prompt: Some("你是测试员。".into()),
            effort: Some("high".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    session.prompt(text("make x.txt")).await.unwrap();
    until(&mut rx, turn_finished).await;
    assert!(!work.path().join("x.txt").exists(), "write was taken away");
}

#[tokio::test]
async fn writes_a_file_and_reports_cost() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let write = ToolCall {
        id: "t1".into(),
        name: "write".into(),
        arguments: json!({"path": "hello.txt", "content": "hi"}).to_string(),
    };
    let runtime =
        VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(answers(vec![msg(None, vec![write]), msg(Some("Wrote it."), vec![])]));
    assert!(matches!(runtime.installation().await, Installation::Available { .. }));
    let session = runtime
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Bypass,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    session.prompt(text("make hello.txt")).await.unwrap();
    let events = until(&mut rx, turn_finished).await;
    assert_eq!(std::fs::read_to_string(work.path().join("hello.txt")).unwrap(), "hi");
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.kind, EventKind::ToolCallStarted { name, .. } if name == "write"))
    );
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::FileChanged {
            change: FileChangeKind::Created,
            ..
        }
    )));
    assert_eq!(texts(&events), "Wrote it.");
    let EventKind::TurnFinished { reason, usage } = &events.last().unwrap().kind else {
        unreachable!()
    };
    assert_eq!(*reason, StopReason::Completed);
    assert!(usage.cost_usd.is_some_and(|c| c > 0.0));
}

#[tokio::test]
async fn without_a_key_it_is_unusable_and_resume_needs_a_known_session() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf());
    assert!(matches!(runtime.installation().await, Installation::Unusable { .. }));
    let err = runtime
        .open(SessionOptions {
            cwd: std::env::temp_dir(),
            resume: Some("vv-nope".into()),
            ..Default::default()
        })
        .await
        .err()
        .unwrap();
    assert_eq!(err.rejection_code(), Some("session_not_found"));
    let err = runtime
        .open(SessionOptions {
            cwd: std::env::temp_dir(),
            model: Some("gpt".into()),
            ..Default::default()
        })
        .await
        .err()
        .unwrap();
    assert!(matches!(err, AgentError::Unsupported { .. }));
}

#[tokio::test]
async fn a_turn_cut_off_by_a_crash_finishes_when_the_session_is_resumed() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("execution.db")).await.unwrap();
    let conv = worker_conversation("vv-crashed");
    store
        .write_async(move |tx| {
            Box::pin(async move {
                tx.create_conversation_async(&conv, "deepseek-flash").await?;
                tx.append_entry_async(&conv, "pi.system", &json!({"text": "You are helpful.", "delta": false}))
                    .await?;
                tx.append_entry_async(&conv, "pi.user", &json!({"text": "finish me", "source": "agent"}))
                    .await?;
                let (sub, _) = tx.submit_async(&conv, "req-crash", "prompt", &json!({"text": "finish me"}), None).await?;
                let sub = tx.set_submission_status_async(&sub.id, SubmissionStatus::Placed).await?;
                let mut task = Task::new(GENERATION_KIND, PHASE_PREPARE);
                task.id = format!("gen-{}", sub.id);
                task.conversation_id = conv.clone();
                task.checkpoint = json!({
                    "prompt": "finish me",
                    "submission": sub.id,
                    "requestId": "req-crash",
                });
                tx.create_task_async(task).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    store.close().await.unwrap();

    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(answers(vec![msg(Some("finished"), vec![])]));
    let session = runtime
        .open(SessionOptions {
            cwd: std::env::temp_dir(),
            resume: Some("vv-crashed".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events_with_history();
    let events = until(&mut rx, turn_finished).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.kind, EventKind::TurnStarted { prompt } if prompt == "finish me"))
    );
    assert_eq!(texts(&events), "finished");
}

#[tokio::test]
async fn plan_mode_gets_read_only_tools_including_grep_find_ls() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("hello.rs"), "pub fn marker_token() {}\n").unwrap();

    let recorded_tools: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    struct SpyClient {
        tools: Arc<Mutex<Vec<String>>>,
    }
    impl ModelClient for SpyClient {
        fn complete<'a>(&'a self, req: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> BoxFuture<'a, vibevalley_runtime::agent::Result<Completion>> {
            Box::pin(async move {
                *self.tools.lock().unwrap() = req.tools.iter().map(|t| t.name.clone()).collect();
                on(Delta::Text("planned".into()));
                Ok(msg(Some("planned"), vec![]))
            })
        }
    }

    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(Arc::new(SpyClient { tools: recorded_tools.clone() }));
    let session = runtime
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Plan,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    session.prompt(text("inspect repo")).await.unwrap();
    until(&mut rx, turn_finished).await;

    let names = recorded_tools.lock().unwrap().clone();
    for expected in ["read", "grep", "find", "ls", "load_skill"] {
        assert!(names.iter().any(|n| n == expected), "missing {expected} in {names:?}");
    }
    for forbidden in ["write", "edit", "bash", "spawn_agent"] {
        assert!(!names.iter().any(|n| n == forbidden), "unexpected {forbidden} in {names:?}");
    }
}

#[tokio::test]
async fn permission_mode_ask_forwards_permission_requested_and_honors_allow_and_deny() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let allow_call = ToolCall {
        id: "perm-1".into(),
        name: "write".into(),
        arguments: json!({"path": "ok.txt", "content": "yes"}).to_string(),
    };
    let deny_call = ToolCall {
        id: "perm-2".into(),
        name: "write".into(),
        arguments: json!({"path": "no.txt", "content": "no"}).to_string(),
    };
    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(answers(vec![
        msg(None, vec![allow_call]),
        msg(Some("wrote ok"), vec![]),
        msg(None, vec![deny_call]),
        msg(Some("skipped no"), vec![]),
    ]));
    let session = runtime
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Ask,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events();

    session.prompt(text("create ok")).await.unwrap();
    let first_events = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, tool, .. } = &first_events.last().unwrap().kind else {
        unreachable!()
    };
    assert_eq!(request_id, "perm-1");
    assert_eq!(tool, "write");
    assert_eq!(session.status(), SessionStatus::WaitingPermission);
    session.respond_permission("perm-1", PermissionDecision::AllowOnce).await.unwrap();
    let rest = until(&mut rx, turn_finished).await;
    assert_eq!(texts(&rest), "wrote ok");
    assert_eq!(std::fs::read_to_string(work.path().join("ok.txt")).unwrap(), "yes");

    session.prompt(text("create no")).await.unwrap();
    let second_events = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, .. } = &second_events.last().unwrap().kind else {
        unreachable!()
    };
    assert_eq!(request_id, "perm-2");
    session
        .respond_permission(
            "perm-2",
            PermissionDecision::Deny {
                message: Some("user declined".into()),
            },
        )
        .await
        .unwrap();
    let rest2 = until(&mut rx, turn_finished).await;
    assert_eq!(texts(&rest2), "skipped no");
    assert!(!work.path().join("no.txt").exists());
}

#[tokio::test]
async fn steer_interrupts_remaining_queued_tool_calls_in_running_turn() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let client = answers(vec![
        msg(
            None,
            vec![
                ToolCall {
                    id: "c1".into(),
                    name: "bash".into(),
                    arguments: json!({
                        "command": format!(
                            "python3 -c \"import socket; s=socket.create_connection(('127.0.0.1',{port})); s.recv(1)\""
                        )
                    })
                    .to_string(),
                },
                ToolCall {
                    id: "c2".into(),
                    name: "write".into(),
                    arguments: json!({"path": "skipped.txt", "content": "should not run"}).to_string(),
                },
            ],
        ),
        msg(Some("steered ok"), vec![]),
    ]);

    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(client.clone());
    let session = runtime
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Bypass,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    session.prompt(text("do batch")).await.unwrap();

    let (mut sock, _) = listener.accept().await.unwrap();
    session.steer(text("abort second tool and finish")).await.unwrap();
    let _ = sock.write_all(b"go").await;
    drop(sock);

    let events = until(&mut rx, turn_finished).await;
    assert_eq!(texts(&events), "steered ok");
    assert!(!work.path().join("skipped.txt").exists());

    let seen = client.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    let second_texts: Vec<String> = seen[1].messages.iter().filter_map(|m| m.content.clone()).collect();
    assert!(second_texts.iter().any(|t| t == "abort second tool and finish"), "{second_texts:?}");
    assert!(second_texts.iter().any(|t| t.contains("skipped due to user steering")), "{second_texts:?}");
}

#[tokio::test]
async fn subagent_events_forward_through_oar_session() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let spawn = ToolCall {
        id: "sp1".into(),
        name: "spawn_agent".into(),
        arguments: json!({"brief": "check repo", "label": "scout"}).to_string(),
    };
    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(answers(vec![
        msg(None, vec![spawn]),
        msg(Some("child checked"), vec![]),
        msg(Some("parent complete"), vec![]),
    ]));
    let session = runtime
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Bypass,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    session.prompt(text("delegate")).await.unwrap();
    let events = until(&mut rx, turn_finished).await;

    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentSpawned { agent_name, task, .. }
            if agent_name.as_deref() == Some("scout") && task.as_deref() == Some("check repo")
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentStatusChanged {
            status: SubagentStatus::Running,
            ..
        }
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentStatusChanged {
            status: SubagentStatus::Completed,
            ..
        }
    )));
    assert_eq!(texts(&events), "parent complete");
}

#[tokio::test]
async fn vibevalley_runtime_supports_manual_compact_and_codemode_tool() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let runtime = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(answers(vec![
        msg(Some("turn one"), vec![]),
        msg(Some("turn two"), vec![]),
        msg(Some("turn three"), vec![]),
        msg(Some("## Goal\ncompacted summary"), vec![]),
        msg(Some("turn four"), vec![]),
    ]));
    let session = runtime
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Bypass,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    for prompt in ["p1", "p2", "p3"] {
        session.prompt(text(prompt)).await.unwrap();
        until(&mut rx, turn_finished).await;
    }

    let compact = session.control(ControlAction::Compact, "", "c1", "c1").await.unwrap();
    assert_eq!(compact.status, ControlStatus::Accepted);

    session.prompt(text("p4")).await.unwrap();
    let events = until(&mut rx, turn_finished).await;
    assert_eq!(texts(&events), "turn four");
}
