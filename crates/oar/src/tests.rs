//! Offline tests: the scripted runtime for session behavior, and the Claude
//! and Codex projectors fed with traces captured from real runs
//! (`tests/fixtures`, scrubbed of account data).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::scripted::{Script, ScriptedRuntime, Step};
use crate::*;

const WAIT: Duration = Duration::from_secs(10);

fn opts() -> SessionOptions {
    SessionOptions {
        cwd: std::env::temp_dir(),
        ..Default::default()
    }
}

fn text(s: &str) -> Vec<ContentBlock> {
    vec![ContentBlock::Text(s.into())]
}

/// Events up to and including the first one `stop` accepts.
async fn until(rx: &mut tokio::sync::mpsc::Receiver<Event>, stop: impl Fn(&EventKind) -> bool) -> Vec<Event> {
    let mut out = Vec::new();
    loop {
        let event = tokio::time::timeout(WAIT, rx.recv())
            .await
            .expect("event before timeout")
            .expect("channel open before stop event");
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

// ---- scripted runtime: session behavior ----------------------------------

#[tokio::test]
async fn every_subscriber_gets_every_event_in_order() {
    let runtime = ScriptedRuntime::new("s", Script::echo());
    let session = runtime.open(opts()).await.unwrap();
    let mut a = session.events();
    let mut b = session.events();
    session.prompt(text("hello")).await.unwrap();
    let ea = until(&mut a, turn_finished).await;
    let eb = until(&mut b, turn_finished).await;
    assert_eq!(ea, eb);
    assert_eq!(texts(&ea), "hello");
    assert!(ea.windows(2).all(|w| w[0].seq < w[1].seq), "seq strictly increases");
    assert!(ea.iter().all(|e| e.agent_path.is_empty()));
}

#[tokio::test]
async fn status_follows_the_turn() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(200), Step::text("ok")]));
    let session = runtime.open(opts()).await.unwrap();
    let mut rx = session.events();
    assert_eq!(session.status(), SessionStatus::Idle);
    session.prompt(text("go")).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::TurnStarted { .. })).await;
    assert_eq!(session.status(), SessionStatus::Running);
    let events = until(&mut rx, turn_finished).await;
    assert_eq!(session.status(), SessionStatus::Idle);
    assert_eq!(derive_status(&events), SessionStatus::Idle);
}

#[tokio::test]
async fn a_second_prompt_while_running_is_rejected_busy() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(500), Step::text("ok")]));
    let session = runtime.open(opts()).await.unwrap();
    let mut rx = session.events();
    session.prompt(text("one")).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::TurnStarted { .. })).await;
    let err = session.prompt(text("two")).await.unwrap_err();
    assert_eq!(err.rejection_code(), Some(rejection::BUSY), "{err}");
    until(&mut rx, turn_finished).await;
}

#[tokio::test]
async fn queued_input_runs_after_the_current_turn() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(200), Step::text("{prompt}")]));
    let session = runtime.open(opts()).await.unwrap();
    let mut rx = session.events();
    session.prompt(text("first")).await.unwrap();
    session.queue(text("second")).await.unwrap();
    let first = until(&mut rx, turn_finished).await;
    let second = until(&mut rx, turn_finished).await;
    assert_eq!(texts(&first), "first");
    assert_eq!(texts(&second), "second");
}

#[tokio::test]
async fn abort_ends_the_turn_as_aborted() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(5_000), Step::text("late")]));
    let session = runtime.open(opts()).await.unwrap();
    let mut rx = session.events();
    session.prompt(text("go")).await.unwrap();
    until(&mut rx, |k| matches!(k, EventKind::TurnStarted { .. })).await;
    session.abort().await.unwrap();
    let events = until(&mut rx, turn_finished).await;
    match &events.last().unwrap().kind {
        EventKind::TurnFinished { reason, .. } => assert_eq!(*reason, StopReason::Aborted),
        other => panic!("{other:?}"),
    }
    assert!(!texts(&events).contains("late"));
    let err = session.abort().await.unwrap_err();
    assert_eq!(err.rejection_code(), Some(rejection::NO_ACTIVE_TURN), "{err}");
}

#[tokio::test]
async fn permission_waits_for_an_answer_and_denial_takes_the_denied_branch() {
    let runtime = ScriptedRuntime::demo();
    for (decision, expect_file) in [
        (PermissionDecision::AllowOnce, true),
        (PermissionDecision::Deny { message: Some("no".into()) }, false),
    ] {
        let session = runtime.open(opts()).await.unwrap();
        let mut rx = session.events();
        session.prompt(text("write a note")).await.unwrap();
        let before = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
        let EventKind::PermissionRequested { request_id, tool, .. } = &before.last().unwrap().kind else {
            unreachable!()
        };
        assert_eq!(tool, "Write");
        assert_eq!(session.status(), SessionStatus::WaitingPermission);
        session.respond_permission(request_id, decision.clone()).await.unwrap();
        let after = until(&mut rx, turn_finished).await;
        assert!(matches!(after[0].kind, EventKind::PermissionResolved { .. }));
        let wrote = after.iter().any(|e| matches!(e.kind, EventKind::FileChanged { .. }));
        assert_eq!(wrote, expect_file, "{decision:?}");
        let err = session.respond_permission(request_id, PermissionDecision::AllowOnce).await.unwrap_err();
        assert_eq!(err.rejection_code(), Some(rejection::UNKNOWN_REQUEST), "{err}");
    }
}

#[tokio::test]
async fn subagent_events_carry_their_path() {
    let runtime = ScriptedRuntime::demo();
    let session = runtime.open(opts()).await.unwrap();
    let mut rx = session.events();
    session.prompt(text("x")).await.unwrap();
    let before = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, .. } = &before.last().unwrap().kind else {
        unreachable!()
    };
    session.respond_permission(request_id, PermissionDecision::AllowOnce).await.unwrap();
    let after = until(&mut rx, turn_finished).await;
    let sub: Vec<_> = after.iter().filter(|e| !e.agent_path.is_empty()).collect();
    assert_eq!(sub.len(), 1);
    assert_eq!(sub[0].agent_path, vec!["task-1".to_string()]);
}

#[tokio::test]
async fn unsupported_options_are_refused_before_opening() {
    let runtime = ScriptedRuntime::new("s", Script::echo());
    let err = runtime
        .open(SessionOptions {
            resume: Some("abc".into()),
            ..opts()
        })
        .await
        .err()
        .expect("refused");
    assert!(matches!(&err, AgentError::Unsupported { option, .. } if option == "resume"), "{err}");
    let err = runtime
        .open(SessionOptions {
            model: Some("no-such-model".into()),
            ..opts()
        })
        .await
        .err()
        .expect("refused");
    assert!(matches!(&err, AgentError::Unsupported { option, .. } if option == "model"), "{err}");
    let err = runtime
        .open(SessionOptions {
            cwd: PathBuf::from("/definitely/not/here"),
            ..opts()
        })
        .await
        .err()
        .expect("refused");
    assert!(matches!(&err, AgentError::Unsupported { option, .. } if option == "cwd"), "{err}");
}

#[tokio::test]
async fn record_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run.jsonl");
    let runtime = ScriptedRuntime::demo();
    let session = runtime
        .open(SessionOptions {
            record_to: Some(path.clone()),
            ..opts()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    session.prompt(text("go")).await.unwrap();
    let mut seen = until(&mut rx, |k| matches!(k, EventKind::PermissionRequested { .. })).await;
    let EventKind::PermissionRequested { request_id, .. } = &seen.last().unwrap().kind else {
        unreachable!()
    };
    session.respond_permission(request_id, PermissionDecision::AllowOnce).await.unwrap();
    seen.extend(until(&mut rx, turn_finished).await);
    session.dispose().await;
    seen.extend(until(&mut rx, |k| matches!(k, EventKind::SessionEnded)).await);

    let read = read_record(&path).unwrap();
    // The receiver subscribed after open, so the record also holds what came
    // before (SessionStarted); compare from the first event both have.
    let start = read.iter().position(|e| e.seq == seen[0].seq).expect("overlap");
    let read_kinds: Vec<_> = read[start..].iter().map(|e| (&e.seq, &e.agent_path, &e.kind)).collect();
    let seen_kinds: Vec<_> = seen.iter().map(|e| (&e.seq, &e.agent_path, &e.kind)).collect();
    assert_eq!(read_kinds, seen_kinds);
    let (header, _) = read_record_with_header(&path).unwrap();
    assert!(header.is_some());
}

#[test]
fn default_registry_lists_the_builtin_runtimes() {
    let registry = default_runtimes();
    for id in ["claude", "codex", "antigravity", "grok", "kimi", "codebuddy", "opencode", "scripted"] {
        assert!(registry.get(id).is_some(), "{id}");
    }
    assert!(registry.get("vibevalley").is_none());
    assert!(registry.get("acp:gemini").is_none());
    assert!(matches!(registry.require("nope"), Err(AgentError::UnknownRuntime(_))));
}

// ---- projectors fed with captured traces ---------------------------------

fn fixture(name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// The lines the agent sent us.
fn received(name: &str) -> Vec<Value> {
    fixture(name).into_iter().filter(|l| l["dir"] == "recv").map(|mut l| l["line"].take()).collect()
}

fn claude_events(name: &str) -> Vec<crate::claude::Out> {
    let mut projector = crate::claude::Projector::default();
    received(name).iter().flat_map(|m| projector.feed(m)).collect()
}

fn claude_kinds(out: &[crate::claude::Out]) -> Vec<&EventKind> {
    out.iter()
        .filter_map(|o| match o {
            crate::claude::Out::Event(_, kind) => Some(kind),
            _ => None,
        })
        .collect()
}

#[test]
fn claude_reply_projects_text_and_a_completed_turn_with_cost() {
    let out = claude_events("claude-reply.jsonl");
    let kinds = claude_kinds(&out);
    let reply: String = kinds
        .iter()
        .filter_map(|k| match k {
            EventKind::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(reply.trim().to_lowercase().trim_end_matches('.'), "ok");
    let finished: Vec<_> = kinds.iter().filter(|k| turn_finished(k)).collect();
    assert_eq!(finished.len(), 1);
    let EventKind::TurnFinished { reason, usage } = finished[0] else {
        unreachable!()
    };
    assert_eq!(*reason, StopReason::Completed);
    assert!(usage.cost_usd.is_some_and(|c| c > 0.0), "{usage:?}");
    assert!(usage.output_tokens.is_some_and(|t| t > 0), "{usage:?}");
}

#[test]
fn claude_edit_projects_permission_tool_call_and_file_change() {
    let out = claude_events("claude-edit.jsonl");
    let permission = out
        .iter()
        .find_map(|o| match o {
            crate::claude::Out::Permission { tool, .. } => Some(tool.clone()),
            _ => None,
        })
        .expect("a permission request");
    assert_eq!(permission, "Write");
    let kinds = claude_kinds(&out);
    let started = kinds.iter().find_map(|k| match k {
        EventKind::ToolCallStarted { id, name, .. } => Some((id.clone(), name.clone())),
        _ => None,
    });
    let (id, name) = started.expect("tool call started");
    assert_eq!(name, "Write");
    assert!(
        kinds
            .iter()
            .any(|k| matches!(k, EventKind::ToolCallFinished { id: f, ok: true, .. } if *f == id))
    );
    assert!(kinds.iter().any(|k| matches!(
        k,
        EventKind::FileChanged { path, change: FileChangeKind::Created } if path.ends_with("hello.txt")
    )));
}

fn codex_root_thread(name: &str) -> String {
    received(name)
        .iter()
        .find_map(|m| m.pointer("/result/thread/id").and_then(Value::as_str).map(str::to_string))
        .expect("thread/start result")
}

fn codex_events(name: &str) -> (Vec<EventKind>, Vec<crate::codex::ServerRequest>) {
    let mut projector = crate::codex::Projector::new(&codex_root_thread(name));
    let mut events = Vec::new();
    let mut requests = Vec::new();
    for message in received(name) {
        let Some(method) = message["method"].as_str() else { continue };
        let params = &message["params"];
        if message.get("id").is_some_and(|id| !id.is_null()) {
            requests.push(projector.server_request(method, params));
        } else {
            events.extend(projector.notification(method, params).into_iter().map(|(_, k)| k));
        }
    }
    (events, requests)
}

#[test]
fn codex_reply_projects_text_and_a_completed_turn_with_tokens() {
    let (events, requests) = codex_events("codex-reply.jsonl");
    assert!(requests.is_empty());
    let reply: String = events
        .iter()
        .filter_map(|k| match k {
            EventKind::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(reply.trim().to_lowercase().trim_end_matches('.'), "ok");
    let finished: Vec<_> = events.iter().filter(|k| turn_finished(k)).collect();
    assert_eq!(finished.len(), 1, "{events:#?}");
    let EventKind::TurnFinished { reason, usage } = finished[0] else {
        unreachable!()
    };
    assert_eq!(*reason, StopReason::Completed);
    assert!(usage.input_tokens.is_some_and(|t| t > 0), "{usage:?}");
}

#[test]
fn codex_edit_asks_for_approval_and_runs_the_command() {
    let (events, requests) = codex_events("codex-edit.jsonl");
    assert!(
        requests.iter().any(|r| matches!(r, crate::codex::ServerRequest::Permission { .. })),
        "{requests:?}"
    );
    assert!(events.iter().any(|k| matches!(k, EventKind::ToolCallStarted { .. })));
    assert!(events.iter().any(|k| matches!(k, EventKind::ToolCallFinished { ok: true, .. })));
    assert!(events.iter().any(turn_finished));
}

// ---- ACP ---------------------------------------------------------------------

#[test]
fn acp_session_new_from_opencode_lists_models() {
    let session = received("acp-opencode-error.jsonl")
        .into_iter()
        .find_map(|m| m.get("result").filter(|r| r.get("sessionId").is_some()).cloned())
        .expect("session/new result");
    let models = crate::acp::models_of(&session);
    assert!(models.len() > 10, "{}", models.len());
    assert!(models.iter().all(|m| !m.id.is_empty()));
}

#[test]
fn acp_updates_project_text_tools_and_file_changes() {
    use serde_json::json;
    let mut p = crate::acp::Projector::default();
    let mut out = Vec::new();
    for update in [
        json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}}),
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Writing "}}),
        // opencode opens a call with empty input; the start waits for it.
        json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "write", "kind": "edit", "status": "pending", "rawInput": {}}),
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress", "rawInput": {"filePath": "a.txt"}}),
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
               "content": [{"type": "diff", "path": "/w/a.txt", "oldText": null, "newText": "hi"}]}),
        json!({"sessionUpdate": "tool_call", "toolCallId": "t2", "title": "bash", "kind": "execute", "status": "failed",
               "rawInput": {"command": "false"}, "rawOutput": {"output": "exit 1"}}),
    ] {
        out.extend(p.update(&update));
    }
    assert!(matches!(&out[0], EventKind::ThinkingDelta { text } if text == "thinking"));
    assert!(matches!(&out[1], EventKind::TextDelta { text } if text == "Writing "));
    assert!(matches!(&out[2], EventKind::ToolCallStarted { id, name, input } if id == "t1" && name == "write" && input["filePath"] == "a.txt"));
    assert!(matches!(&out[3], EventKind::ToolCallFinished { id, ok: true, .. } if id == "t1"));
    assert!(matches!(&out[4], EventKind::FileChanged { path, change: FileChangeKind::Created } if path.ends_with("a.txt")));
    assert!(matches!(&out[5], EventKind::ToolCallStarted { id, .. } if id == "t2"));
    assert!(matches!(&out[6], EventKind::ToolCallFinished { id, ok: false, output } if id == "t2" && output == "exit 1"));
    assert_eq!(out.len(), 7, "{out:#?}");
}

#[test]
fn login_status_is_read_from_each_cli() {
    use crate::{claude::claude_login_status, codex::codex_login_status, process::LoginStatus};
    assert_eq!(
        claude_login_status(true, r#"{"loggedIn": true, "authMethod": "claude.ai"}"#),
        LoginStatus::SignedIn
    );
    assert_eq!(claude_login_status(true, r#"{"loggedIn": false}"#), LoginStatus::SignedOut);
    assert_eq!(claude_login_status(false, "error: something"), LoginStatus::Unknown);
    assert_eq!(codex_login_status(true, "Logged in using ChatGPT\n"), LoginStatus::SignedIn);
    assert_eq!(codex_login_status(false, "Not logged in\n"), LoginStatus::SignedOut);
    assert_eq!(codex_login_status(true, "Not logged in\n"), LoginStatus::SignedOut);
    assert_eq!(codex_login_status(false, "connection reset"), LoginStatus::Unknown);
    assert_eq!(claude_login_status(false, r#"{"loggedIn":false}"#), LoginStatus::SignedOut);
    assert_eq!(claude_login_status(false, "connection reset"), LoginStatus::Unknown);
}

#[tokio::test]
#[ignore = "probes the real CLIs on this machine"]
async fn installed_runtimes_report_their_login() {
    for id in ["claude", "codex"] {
        let runtime = default_runtimes().require(id).unwrap();
        println!("{id}: {:?}", runtime.installation().await);
    }
}

#[test]
fn a_set_binary_wins_over_path_and_can_be_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("my-claude");
    std::fs::write(&fake, "#!/bin/sh\necho 9.9.9\n").unwrap();
    std::os::unix::fs::PermissionsExt::set_mode(&mut std::fs::metadata(&fake).unwrap().permissions(), 0o755);
    std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    crate::set_binary("vibevalley-test-agent", Some(fake.clone()));
    assert_eq!(crate::process::find_binary("vibevalley-test-agent"), Some(fake));
    crate::set_binary("vibevalley-test-agent", Some(dir.path().join("missing")));
    assert_eq!(crate::process::find_binary("vibevalley-test-agent"), None);
    crate::set_binary("vibevalley-test-agent", None);
    assert_eq!(crate::process::find_binary("vibevalley-test-agent"), None);
}

#[test]
fn session_options_reach_claude_and_codex() {
    let opts = SessionOptions {
        effort: Some("high".into()),
        system_prompt: Some("own".into()),
        disallowed_tools: vec!["Bash".into(), "Write".into()],
        mcp_servers: vec![
            McpServer::Stdio {
                name: "fs".into(),
                command: "mcp-fs".into(),
                args: vec!["/tmp".into()],
                env: vec![("K".into(), "v".into())],
                cwd: None,
            },
            McpServer::Http {
                name: "web".into(),
                url: "http://127.0.0.1:9/mcp".into(),
                headers: vec![("Authorization".into(), "Bearer t".into())],
            },
        ],
        ..opts()
    };
    let launch = crate::claude::claude_launch("s1", &opts).unwrap();
    let args = &launch.args;
    let after = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone());
    assert_eq!(after("--effort").as_deref(), Some("high"));
    assert_eq!(after("--system-prompt").as_deref(), Some("own"));
    let config: Value = serde_json::from_slice(&std::fs::read(after("--mcp-config").unwrap()).unwrap()).unwrap();
    assert_eq!(config["mcpServers"]["fs"]["command"], "mcp-fs");
    assert_eq!(config["mcpServers"]["web"]["type"], "http");
    assert_eq!(config["mcpServers"]["web"]["headers"]["Authorization"], "Bearer t");
    assert_eq!(after("--disallowed-tools").as_deref(), Some("Bash"));
    assert!(args.contains(&"Write".into()));
    assert!(!args.iter().any(|a| a.contains("Bearer t")));

    let (_, params) = crate::codex::open_request(&opts);
    assert_eq!(params["baseInstructions"], "own");
    assert_eq!(params["config"]["model_reasoning_effort"], "high");
    assert_eq!(params["config"]["disallowed_tools"], serde_json::json!(["Bash", "Write"]));
    assert_eq!(params["config"]["mcp_servers"]["fs"]["args"][0], "/tmp");
    assert_eq!(params["config"]["mcp_servers"]["web"]["http_headers"]["Authorization"], "Bearer t");
}

#[test]
fn account_usage_as_oar_projects_it() {
    let codex = serde_json::json!({
        "rateLimits": { "limitId": "codex", "limitName": null, "primary": { "usedPercent": 50, "windowDurationMins": 10080, "resetsAt": 1787820410 }, "secondary": null, "planType": "pro", "rateLimitReachedType": null },
        "rateLimitsByLimitId": {
            "codex_bengalfox": { "limitId": "codex_bengalfox", "limitName": "GPT-5.3-Codex-Spark", "primary": { "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1787322278 }, "secondary": { "usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 1787909078 }, "planType": "pro" },
            "codex": { "limitId": "codex", "primary": { "usedPercent": 50, "windowDurationMins": 10080, "resetsAt": 1787820410 }, "planType": "pro" }
        }
    });
    let AccountUsage::Available {
        plan, rate_limited, windows, ..
    } = crate::codex::usage_of(&codex, None).unwrap()
    else {
        panic!()
    };
    assert_eq!(plan.as_deref(), Some("pro"));
    assert!(rate_limited, "a window at 100% is a limit reached");
    let labels: Vec<&str> = windows.iter().map(|w| w.label.as_str()).collect();
    assert_eq!(labels, ["Codex · 1 week", "GPT-5.3-Codex-Spark · 5 hours", "GPT-5.3-Codex-Spark · 1 week"]);
    assert_eq!(windows[0].used_ratio, 0.5);
    assert_eq!(windows[0].id.as_deref(), Some("codex:primary"));
    assert_eq!(windows[0].duration_ms, Some(10080 * 60_000));
    assert_eq!(windows[0].resets_at.as_deref(), Some("2026-08-27T08:46:50.000Z"));

    let claude = serde_json::json!({
        "subscription_type": "team",
        "rate_limits_available": true,
        "rate_limits": {
            "five_hour": { "utilization": 82, "resets_at": "2026-11-13T06:09:59.661724+00:00" },
            "seven_day": { "utilization": 14, "resets_at": "2026-11-19T19:59:59.661743+00:00" },
            "seven_day_opus": null,
            "extra_usage": { "is_enabled": false, "utilization": null }
        }
    });
    let usage = crate::claude::usage_of(&claude, Some("a@b.c".into())).unwrap();
    let AccountUsage::Available {
        plan,
        email,
        rate_limited,
        windows,
    } = &usage
    else {
        panic!()
    };
    assert_eq!((plan.as_deref(), email.as_deref(), *rate_limited), (Some("team"), Some("a@b.c"), false));
    assert_eq!(
        windows.iter().map(|w| (w.label.as_str(), w.used_ratio)).collect::<Vec<_>>(),
        [("Current session", 0.82), ("Current week (all models)", 0.14)]
    );
    let wire = serde_json::to_value(&usage).unwrap();
    assert_eq!(wire["kind"], "available");
    assert_eq!(wire["rateLimited"], false);
    assert_eq!(wire["windows"][0]["usedRatio"], 0.82);
    assert_eq!(wire["windows"][0]["durationMs"], 5 * 3_600_000);
    assert_eq!(
        serde_json::to_value(AccountUsage::ReauthRequired {
            reason: "not_authenticated".into()
        })
        .unwrap(),
        serde_json::json!({ "kind": "reauth_required", "reason": "not_authenticated" })
    );
}

#[test]
fn antigravity_usage_parses_real_payload_orders_windows_and_handles_errors() {
    let raw = r#"{
      "conversation_id": "",
      "status": "SUCCESS",
      "num_turns": 0,
      "command": {
        "name": "usage",
        "data": {
          "groups": [
            {
              "name": "Gemini Models",
              "buckets": [
                { "id": "gemini-weekly", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 0.6147, "reset_time": "2026-11-28T08:48:18Z" },
                { "id": "gemini-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": 0.8367, "reset_time": "2026-11-23T16:55:14Z" }
              ]
            },
            {
              "name": "Claude and GPT models",
              "buckets": [
                { "id": "3p-weekly", "window": "weekly", "remaining_fraction": 1, "reset_time": "2026-11-30T15:01:10Z" },
                { "id": "3p-5h", "window": "5h", "remaining_fraction": 1, "reset_time": "2026-11-23T20:01:10Z" }
              ]
            }
          ]
        }
      }
    }"#;
    let AccountUsage::Available {
        plan,
        email,
        rate_limited,
        windows,
    } = crate::acp::antigravity::usage_of(raw).unwrap()
    else {
        panic!("expected Available usage");
    };
    assert_eq!(plan, None);
    assert_eq!(email, None);
    assert!(!rate_limited);
    assert_eq!(
        windows
            .iter()
            .map(|w| (w.label.as_str(), w.used_ratio, w.resets_at.as_deref()))
            .collect::<Vec<_>>(),
        vec![
            ("Gemini · 5h", 0.1633, Some("2026-11-23T16:55:14Z")),
            ("Gemini · 7d", 0.3853, Some("2026-11-28T08:48:18Z")),
            ("Claude/GPT · 5h", 0.0, Some("2026-11-23T20:01:10Z")),
            ("Claude/GPT · 7d", 0.0, Some("2026-11-30T15:01:10Z")),
        ]
    );
    assert_eq!(windows[0].id.as_deref(), Some("gemini-5h"));
    assert_eq!(windows[0].duration_ms, Some(5 * 3_600_000));
    assert_eq!(windows[1].id.as_deref(), Some("gemini-weekly"));
    assert_eq!(windows[1].duration_ms, Some(7 * 24 * 3_600_000));

    // Partial multi-group exhaustion is not globally rate_limited; total exhaustion is.
    let partial = r#"{
      "status": "SUCCESS",
      "command": {
        "name": "usage",
        "data": {
          "groups": [
            { "name": "Gemini Models", "buckets": [{ "id": "g5", "window": "5h", "remaining_fraction": 0 }] },
            { "name": "Claude and GPT models", "buckets": [{ "id": "c5", "window": "5h", "remaining_fraction": 0.9 }] }
          ]
        }
      }
    }"#;
    assert!(matches!(
        crate::acp::antigravity::usage_of(partial).unwrap(),
        AccountUsage::Available { rate_limited: false, .. }
    ));

    let total = r#"{
      "status": "SUCCESS",
      "command": {
        "name": "usage",
        "data": {
          "groups": [
            { "name": "Gemini Models", "buckets": [{ "id": "g5", "window": "5h", "remaining_fraction": 0 }] },
            { "name": "Claude and GPT models", "buckets": [{ "id": "c7", "window": "weekly", "remaining_fraction": -0.1 }] }
          ]
        }
      }
    }"#;
    let AccountUsage::Available { rate_limited, windows, .. } = crate::acp::antigravity::usage_of(total).unwrap() else {
        panic!("expected Available");
    };
    assert!(rate_limited);
    assert_eq!(windows[1].used_ratio, 1.0);

    // Fallback group name strips trailing " Models" / " models".
    let custom_group = r#"{
      "status": "SUCCESS",
      "command": {
        "name": "usage",
        "data": {
          "groups": [
            { "name": "Preview Models", "buckets": [{ "window": "5h", "remaining_fraction": 0.5 }] }
          ]
        }
      }
    }"#;
    let AccountUsage::Available { windows, .. } = crate::acp::antigravity::usage_of(custom_group).unwrap() else {
        panic!("expected Available");
    };
    assert_eq!(windows[0].label, "Preview · 5h");

    // Auth / login-required outputs map to ReauthRequired.
    for auth_raw in [
        "Open the following link to authenticate the ACP server: https://example.com/auth",
        "Error: not logged in. Run agy login.",
        "Authentication required to access quota",
        "Login required",
        r#"{"status":"ERROR","error":"Authentication required"}"#,
        r#"{"status":"AUTH_REQUIRED","response":"Please sign in"}"#,
    ] {
        assert_eq!(
            crate::acp::antigravity::usage_of(auth_raw).unwrap(),
            AccountUsage::ReauthRequired {
                reason: "not_authenticated".into()
            },
            "input: {auth_raw}"
        );
    }

    // Empty / unsupported payloads map to Unsupported.
    for unsupported_raw in [
        "",
        "{}",
        r#"{"status":"SUCCESS","command":{"name":"status","data":{"groups":[]}}}"#,
        r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}}"#,
        r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[]}]}}}"#,
    ] {
        assert_eq!(
            crate::acp::antigravity::usage_of(unsupported_raw).unwrap(),
            AccountUsage::Unsupported {
                reason: "quota_unavailable".into()
            },
            "input: {unsupported_raw}"
        );
    }
}

#[tokio::test]
async fn antigravity_read_account_usage_and_acp_runtime_dispatch() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let ok_script = dir.path().join("fake-agy-ok");
    std::fs::write(
        &ok_script,
        r#"#!/bin/sh
if [ "$AGY_CLI_DISABLE_AUTO_UPDATE" != "1" ]; then
  echo "missing disable auto update" >&2
  exit 1
fi
if [ "$1" != "--print" ] || [ "$2" != "/usage" ] || [ "$3" != "--output-format" ] || [ "$4" != "json" ]; then
  echo "bad args: $*" >&2
  exit 2
fi
cat <<'EOF'
{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.75,"reset_time":"2026-11-23T16:55:14Z"}]}]}}}
EOF
"#,
    )
    .unwrap();
    std::fs::set_permissions(&ok_script, PermissionsExt::from_mode(0o755)).unwrap();

    let usage = crate::acp::antigravity::read_account_usage(&ok_script).await.unwrap();
    let AccountUsage::Available { windows, .. } = usage else {
        panic!("expected Available, got {usage:?}");
    };
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].label, "Gemini · 5h");
    assert_eq!(windows[0].used_ratio, 0.25);

    let auth_script = dir.path().join("fake-agy-auth");
    std::fs::write(
        &auth_script,
        "#!/bin/sh\necho 'Open the following link to authenticate: https://auth.local' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&auth_script, PermissionsExt::from_mode(0o755)).unwrap();
    assert_eq!(
        crate::acp::antigravity::read_account_usage(&auth_script).await.unwrap(),
        AccountUsage::ReauthRequired {
            reason: "not_authenticated".into()
        }
    );

    let generic = crate::acp::AcpRuntime::new(crate::acp::AcpAgentSpec::new("opencode", "OpenCode", "opencode", ["acp"]));
    assert_eq!(
        generic.account_usage().await.unwrap(),
        AccountUsage::Unsupported {
            reason: "not_supported".into()
        }
    );
}

#[test]
fn regression_only_root_usage_reported_in_this_turn_is_charged() {
    use serde_json::json;
    let core = crate::core::SessionCore::new("qwen", "meter", None);
    let mut rx = core.subscribe(false);
    let mut turn = |root: Option<Value>, child: Option<Value>| {
        core.begin_turn("run").unwrap();
        for (path, payload) in [(vec![], root), (vec!["child".into()], child)] {
            if let Some(payload) = payload {
                let msg = json!({"type":"result","usage":payload});
                drop(core.record_raw("result", path, &msg.to_string(), &msg));
            }
        }
        core.emit_root(EventKind::TurnFinished {
            reason: StopReason::Completed,
            usage: Usage::default(),
        });
        loop {
            if let EventKind::TurnFinished { usage, .. } = rx.try_recv().unwrap().kind {
                break (usage.input_tokens, usage.output_tokens);
            }
        }
    };
    assert_eq!(
        turn(
            Some(json!({"input_tokens":30,"output_tokens":12})),
            Some(json!({"input_tokens":999,"output_tokens":88}))
        ),
        (Some(30), Some(12))
    );
    assert_eq!(turn(None, None), (None, None));
    assert_eq!(turn(Some(json!({"input_tokens":35})), None), (None, None));
    assert_eq!(turn(Some(json!({"input_tokens":2,"output_tokens":0})), None), (Some(2), Some(0)));
    assert_eq!(turn(None, Some(json!({"input_tokens":100,"output_tokens":50}))), (None, None));
}

#[test]
fn regression_cumulative_usage_requires_a_known_preceding_turn_boundary() {
    let core = crate::core::SessionCore::new("claude", "cumulative", None);
    let mut events = core.subscribe(false);
    let mut turn = |totals: Option<(u64, u64)>| {
        core.begin_turn("work").unwrap();
        if let Some((input, output)) = totals {
            let frame = serde_json::json!({"type":"result","modelUsage":{"model":{"inputTokens":input,"outputTokens":output}}});
            drop(core.record_raw("result", vec![], &frame.to_string(), &frame));
        }
        core.emit_root(EventKind::TurnFinished {
            reason: StopReason::Completed,
            usage: Usage::default(),
        });
        loop {
            if let EventKind::TurnFinished { usage, .. } = events.try_recv().unwrap().kind {
                break (usage.input_tokens, usage.output_tokens);
            }
        }
    };
    assert_eq!(turn(Some((8, 2))), (Some(8), Some(2)));
    assert_eq!(turn(None), (None, None));
    assert_eq!(turn(Some((21, 6))), (None, None));
    assert_eq!(turn(Some((24, 7))), (Some(3), Some(1)));
}

#[test]
fn regression_antigravity_external_accounting_uses_gemini_additive_totals_even_when_resumed() {
    use serde_json::json;
    let core = crate::core::SessionCore::new("antigravity", "agy-meter", None);
    // Even if a caller marks the meter resumed, Antigravity stays in per-turn mode.
    core.resume_meter(&Value::Null, "acp_resume_baseline_unknown");
    let mut rx = core.subscribe(false);
    core.begin_turn("first").unwrap();
    let frame = json!({
        "sessionId": "agy-meter",
        "update": {
            "sessionUpdate": "usage_update",
            "used": 12_000,
            "size": 1_000_000,
            "usage": {
                "inputTokens": 400,
                "cachedReadTokens": 1_600,
                "cachedWriteTokens": 200,
                "outputTokens": 150,
                "thoughtTokens": 350
            }
        }
    });
    drop(core.record_raw("session/update/usage_update", vec![], &frame.to_string(), &frame));
    core.emit_root(EventKind::TurnFinished {
        reason: StopReason::Completed,
        usage: Usage::default(),
    });
    let usage = loop {
        if let EventKind::TurnFinished { usage, .. } = rx.try_recv().unwrap().kind {
            break usage;
        }
    };
    assert_eq!(usage.input_tokens, Some(2_000));
    assert_eq!(usage.output_tokens, Some(500));
    assert_eq!(usage.cache_read_tokens, Some(1_600));
    assert_eq!(usage.cache_write_tokens, Some(200));
    assert_eq!(usage.reasoning_tokens, Some(350));
    assert_eq!(usage.context_used_tokens, Some(12_000));
    assert_eq!(usage.context_window_tokens, Some(1_000_000));
}

static OBSERVER_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct ClearObserverOnDrop;
impl Drop for ClearObserverOnDrop {
    fn drop(&mut self) {
        set_observer(None);
    }
}

#[tokio::test]
async fn observer_receives_events_outside_session_lock_and_stops_when_cleared() {
    let _serial = OBSERVER_TEST_LOCK.lock().await;
    let _cleanup = ClearObserverOnDrop;
    set_observer(None);
    assert!(!has_observer());

    let mut caps = ScriptedRuntime::new("s", Script::echo()).capabilities();
    caps.resume = true;
    let runtime = ScriptedRuntime::new("s", Script::echo()).with_capabilities(caps);
    let expected_id = format!("observer-test-{}", uuid::Uuid::new_v4());
    let session = runtime
        .open(SessionOptions {
            resume: Some(expected_id.clone()),
            ..opts()
        })
        .await
        .unwrap();
    assert_eq!(session.id(), expected_id);
    let (obs_tx, mut obs_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Event)>();

    struct RecordingObserver {
        target_session: String,
        session: std::sync::Arc<dyn Session>,
        tx: tokio::sync::mpsc::UnboundedSender<(String, Event)>,
    }
    impl OarObserver for RecordingObserver {
        fn on_event(&self, session_id: &str, event: &Event) {
            if session_id != self.target_session {
                return;
            }
            // Re-entering session accessors proves the callback runs outside `SessionCore`'s state mutex.
            let _ = self.session.status();
            let _ = self.session.records();
            let _ = self.tx.send((session_id.to_owned(), event.clone()));
        }
    }

    set_observer(Some(std::sync::Arc::new(RecordingObserver {
        target_session: expected_id.clone(),
        session: session.clone(),
        tx: obs_tx,
    })));
    assert!(has_observer());

    let mut rx = session.events();
    session.prompt(text("hello")).await.unwrap();
    until(&mut rx, turn_finished).await;

    let mut first_batch = Vec::new();
    loop {
        let item = tokio::time::timeout(WAIT, obs_rx.recv())
            .await
            .expect("observer event before timeout")
            .expect("observer sender open");
        let done = turn_finished(&item.1.kind);
        first_batch.push(item);
        if done {
            break;
        }
    }
    assert!(first_batch.iter().all(|(sid, _)| sid == &expected_id));
    assert!(first_batch.iter().any(|(_, e)| matches!(e.kind, EventKind::TurnStarted { .. })));
    assert!(
        first_batch
            .iter()
            .any(|(_, e)| matches!(&e.kind, EventKind::TextDelta { text } if text == "hello"))
    );
    assert!(first_batch.iter().any(|(_, e)| matches!(e.kind, EventKind::TurnFinished { .. })));

    set_observer(None);
    assert!(!has_observer());

    session.prompt(text("world")).await.unwrap();
    until(&mut rx, turn_finished).await;
    session.dispose().await;
    until(&mut rx, |k| matches!(k, EventKind::SessionEnded)).await;

    assert!(obs_rx.try_recv().is_err(), "cleared observer must not receive further events");

    // Regression: dropping an observer that owns the last `Arc<dyn Session>` inside `set_observer(None)` must not self-deadlock on `OBSERVER`.
    let owned_session = runtime.open(opts()).await.unwrap();
    struct SessionOwningObserver(#[allow(dead_code)] std::sync::Arc<dyn Session>);
    impl OarObserver for SessionOwningObserver {
        fn on_event(&self, _session_id: &str, _event: &Event) {}
    }
    set_observer(Some(std::sync::Arc::new(SessionOwningObserver(owned_session))));
    set_observer(None);
    assert!(!has_observer());
}

#[tokio::test]
async fn trace_id_propagates_to_voyage_jsonl_and_omits_none_or_zero() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("traced.jsonl");
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(50), Step::text("{prompt}")]));
    let session = runtime
        .open(SessionOptions {
            record_to: Some(path.clone()),
            ..opts()
        })
        .await
        .unwrap();
    let mut rx = session.events();

    session.prompt_with(text("turn-none"), TurnOptions::default()).await.unwrap();
    until(&mut rx, turn_finished).await;

    session.prompt_with(text("turn-zero"), TurnOptions { trace_id: Some(0) }).await.unwrap();
    until(&mut rx, turn_finished).await;

    session.prompt_with(text("turn-traced"), TurnOptions { trace_id: Some(777) }).await.unwrap();
    session.queue_with(text("turn-queued"), TurnOptions { trace_id: Some(888) }).await.unwrap();
    until(&mut rx, turn_finished).await;
    until(&mut rx, turn_finished).await;

    session.prompt(text("turn-after")).await.unwrap();
    until(&mut rx, turn_finished).await;
    session.dispose().await;
    until(&mut rx, |k| matches!(k, EventKind::SessionEnded)).await;

    let raw_jsonl = std::fs::read_to_string(&path).unwrap();
    let raw_lines: Vec<Value> = raw_jsonl.lines().skip(1).map(|l| serde_json::from_str(l).unwrap()).collect();

    let mut reader = crate::voyage::Reader::new(std::io::BufReader::new(std::fs::File::open(&path).unwrap())).unwrap();
    let mut records = Vec::new();
    while let Some(rec) = reader.read().unwrap() {
        records.push(rec);
    }
    assert_eq!(raw_lines.len(), records.len());

    let line_for_text = |needle: &str| {
        records
            .iter()
            .zip(raw_lines.iter())
            .find(|(rec, _)| rec.events.iter().any(|e| e["kind"] == "text_delta" && e["text"] == needle))
            .unwrap_or_else(|| panic!("missing record for {needle}"))
    };

    for unset in ["turn-none", "turn-zero", "turn-after"] {
        let (rec, json_line) = line_for_text(unset);
        assert_eq!(rec.trace_id, None, "{unset}");
        assert!(json_line.get("traceId").is_none(), "traceId must be omitted for {unset}: {json_line}");
    }

    for (label, expected) in [("turn-traced", 777_u64), ("turn-queued", 888_u64)] {
        let (rec, json_line) = line_for_text(label);
        assert_eq!(rec.trace_id, Some(expected), "{label}");
        assert_eq!(json_line["traceId"], serde_json::json!(expected), "{label}");
    }

    let mut zero_rec = crate::voyage::Record::new(crate::voyage::Kind::Frame, "s".into(), 1);
    zero_rec.trace_id = Some(0);
    let encoded = serde_json::to_string(&zero_rec).unwrap();
    assert!(!encoded.contains("traceId"), "Some(0) must be omitted from JSON: {encoded}");
    let decoded_zero: crate::voyage::Record = serde_json::from_str(r#"{"seq":0,"kind":"frame","sessionId":"s","agentPath":[],"traceId":0}"#).unwrap();
    assert_eq!(decoded_zero.trace_id, None);
    let decoded_nonzero: crate::voyage::Record = serde_json::from_str(r#"{"seq":0,"kind":"frame","sessionId":"s","agentPath":[],"traceId":42}"#).unwrap();
    assert_eq!(decoded_nonzero.trace_id, Some(42));
}

#[test]
fn builtin_runtime_specs_match_default_runtimes_and_exclude_dsh() {
    assert!(runtime_spec("dsh").is_none());
    let registry = default_runtimes();
    for spec in BUILTIN_RUNTIME_SPECS {
        if spec.id == "vibevalley" {
            continue;
        }
        let rt = registry.get(spec.id).unwrap_or_else(|| panic!("missing runtime {}", spec.id));
        assert_eq!(rt.id(), spec.id);
        assert_eq!(rt.display_name(), spec.display_name);
        assert_eq!(rt.capabilities(), spec.capabilities, "capabilities drift for {}", spec.id);
        assert_eq!(runtime_refused_options(spec.id), spec.refused_options, "refused_options drift for {}", spec.id);
    }
    for rt in registry.list() {
        if rt.id() == "scripted" {
            continue;
        }
        assert!(runtime_spec(rt.id()).is_some(), "runtime {} missing from BUILTIN_RUNTIME_SPECS", rt.id());
    }
}

#[tokio::test]
async fn core_session_records_read_back_from_disk_and_cap_in_memory_history() {
    // When `record_to` is set, records are streamed to disk and read back on demand.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recorded.jsonl");
    let runtime = ScriptedRuntime::new("s", Script::echo());
    let session = runtime
        .open(SessionOptions {
            record_to: Some(path.clone()),
            ..opts()
        })
        .await
        .unwrap();
    let mut rx = session.events();
    session.prompt(text("disk-backed")).await.unwrap();
    until(&mut rx, turn_finished).await;
    let from_disk = session.records();
    assert!(!from_disk.is_empty(), "records() must read back persisted records");
    assert!(
        from_disk
            .iter()
            .any(|r| r.events.iter().any(|e| e["kind"] == "text_delta" && e["text"] == "disk-backed"))
    );
    session.dispose().await;
    until(&mut rx, |k| matches!(k, EventKind::SessionEnded)).await;

    // When `record_to` is None, in-memory history stays bounded at 1024 records.
    let mut steps = Vec::with_capacity(1_100);
    for i in 0..1_100 {
        steps.push(Step::text(format!("chunk-{i}")));
    }
    let big_rt = ScriptedRuntime::new("s", Script::new().turn(steps));
    let mem_session = big_rt.open(opts()).await.unwrap();
    let mut mem_rx = mem_session.events();
    mem_session.prompt(text("go")).await.unwrap();
    until(&mut mem_rx, turn_finished).await;
    let capped = mem_session.records();
    assert_eq!(capped.len(), 1_024, "unrecorded history must be capped at 1024 records");
    assert!(capped.windows(2).all(|w| w[0].seq < w[1].seq), "retained tail remains strictly ordered");
    mem_session.dispose().await;
    until(&mut mem_rx, |k| matches!(k, EventKind::SessionEnded)).await;
}

#[test]
fn acp_mcp_forwarding_preserves_http_headers_stateless_meta_and_stdio_v1_v2() {
    use serde_json::json;
    use vibevalley_mcp::{EXT_SKILLS, HEADER_PROTOCOL_VERSION, META_PROTOCOL_VERSION, McpServerConfig, PROTOCOL_STATELESS, SKILL_URI_SCHEME};

    let vv_http = McpServerConfig::streamable_http("vibevalley", "http://127.0.0.1:8789/mcp", true)
        .with_header("Authorization", "Bearer tok-xyz")
        .with_header("X-VibeValley-Session", "sess-1");
    let local_stdio = McpServerConfig::stdio(
        "local-tools",
        "/usr/local/bin/vibevalley",
        vec!["mcp".into(), "--channel".into(), "alpha".into()],
    )
    .with_env("VIBEVALLEY_CHANNEL", "alpha");

    // Round-trip McpServerConfig <-> oar::McpServer keeps stateless flag & headers.
    let converted = McpServer::from_mcp_config(&vv_http);
    let round_tripped = converted.to_mcp_config();
    assert_eq!(round_tripped.name, "vibevalley");
    assert!(matches!(
        round_tripped.transport,
        vibevalley_mcp::McpTransportSpec::StreamableHttp {
            ref url,
            ref headers,
            stateless: true,
        } if url == "http://127.0.0.1:8789/mcp"
            && headers.get("Authorization").map(String::as_str) == Some("Bearer tok-xyz")
            && headers.get(HEADER_PROTOCOL_VERSION).map(String::as_str) == Some(PROTOCOL_STATELESS)
    ));

    // ACP v2 (Antigravity): HTTP preserves headers + stateless/skills _meta; Stdio carries `type: "stdio"`.
    let v2 = crate::acp::encode_acp_mcp_server_configs(crate::acp::AcpFlavor::Antigravity, &[vv_http.clone(), local_stdio.clone()]).unwrap();
    assert_eq!(v2.len(), 2);
    assert_eq!(v2[0]["type"], "http");
    assert_eq!(v2[0]["name"], "vibevalley");
    assert_eq!(v2[0]["url"], "http://127.0.0.1:8789/mcp");
    let v2_headers = v2[0]["headers"].as_array().unwrap();
    assert!(v2_headers.contains(&json!({ "name": "Authorization", "value": "Bearer tok-xyz" })));
    assert!(v2_headers.contains(&json!({ "name": "X-VibeValley-Session", "value": "sess-1" })));
    assert!(v2_headers.contains(&json!({ "name": HEADER_PROTOCOL_VERSION, "value": PROTOCOL_STATELESS })));
    assert_eq!(v2[0]["_meta"][META_PROTOCOL_VERSION], PROTOCOL_STATELESS);
    assert_eq!(v2[0]["_meta"][EXT_SKILLS]["scheme"], SKILL_URI_SCHEME);

    assert_eq!(v2[1]["type"], "stdio");
    assert_eq!(v2[1]["name"], "local-tools");
    assert_eq!(v2[1]["command"], "/usr/local/bin/vibevalley");
    assert_eq!(v2[1]["args"], json!(["mcp", "--channel", "alpha"]));
    assert_eq!(v2[1]["env"], json!([{ "name": "VIBEVALLEY_CHANNEL", "value": "alpha" }]));

    // ACP v1 (Generic): HTTP validates against v1 schema without dropping headers or _meta; Stdio is untagged.
    let v1 = crate::acp::encode_acp_mcp_server_configs(crate::acp::AcpFlavor::Generic, &[vv_http, local_stdio]).unwrap();
    assert_eq!(v1.len(), 2);
    assert_eq!(v1[0]["type"], "http");
    assert_eq!(v1[0]["url"], "http://127.0.0.1:8789/mcp");
    assert_eq!(v1[0]["_meta"][META_PROTOCOL_VERSION], PROTOCOL_STATELESS);
    assert_eq!(v1[0]["_meta"][EXT_SKILLS]["scheme"], SKILL_URI_SCHEME);
    let v1_headers = v1[0]["headers"].as_array().unwrap();
    assert!(v1_headers.contains(&json!({ "name": "Authorization", "value": "Bearer tok-xyz" })));
    assert!(v1_headers.contains(&json!({ "name": HEADER_PROTOCOL_VERSION, "value": PROTOCOL_STATELESS })));
    assert!(v1[1].get("type").is_none());
    assert_eq!(v1[1]["command"], "/usr/local/bin/vibevalley");

    // Capability probes handle both ACP v1 and v2 shapes.
    assert!(crate::acp::agent_supports_http_mcp(
        crate::acp::AcpFlavor::Generic,
        &json!({ "agentCapabilities": { "mcpCapabilities": { "http": true } } })
    ));
    assert!(crate::acp::agent_supports_http_mcp(
        crate::acp::AcpFlavor::Antigravity,
        &json!({ "agentCapabilities": { "session": { "mcp": { "http": {} } } } })
    ));
    assert!(!crate::acp::agent_supports_http_mcp(
        crate::acp::AcpFlavor::Generic,
        &json!({ "agentCapabilities": {} })
    ));
}

#[tokio::test]
async fn acp_runtime_open_forwards_stateless_http_mcp_and_headers_over_wire() {
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;
    use vibevalley_mcp::{EXT_SKILLS, HEADER_PROTOCOL_VERSION, META_PROTOCOL_VERSION, McpServerConfig, PROTOCOL_STATELESS, SKILL_URI_SCHEME};

    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("acp-wire.jsonl");
    let fake_agy = dir.path().join("fake-agy-acp");
    std::fs::write(
        &fake_agy,
        format!(
            r#"#!/usr/bin/env python3
import json, sys

log_path = {log_path:?}
for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    msg = json.loads(line)
    method = msg.get("method")
    msg_id = msg.get("id")
    if method == "initialize":
        reply = {{
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {{
                "protocolVersion": 2,
                "agentCapabilities": {{"session": {{"mcp": {{"http": {{}}, "stdio": {{}}}}}}}},
            }},
        }}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()
    elif method == "session/new":
        reply = {{
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {{"sessionId": "sess-acp-1"}},
        }}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()
"#,
            log_path = log_path.to_string_lossy()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake_agy, PermissionsExt::from_mode(0o755)).unwrap();

    let vv_mcp = McpServerConfig::streamable_http("vibevalley", "http://127.0.0.1:8789/mcp", true).with_header("Authorization", "Bearer vv-acp-token");
    let runtime = crate::acp::AcpRuntime::new(crate::acp::AcpAgentSpec::new("antigravity", "Antigravity CLI", "agy", ["acp"]));
    let session = runtime
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(fake_agy),
            request_timeout: Some(Duration::from_secs(5)),
            mcp_servers: vec![McpServer::from_mcp_config(&vv_mcp)],
            ..Default::default()
        })
        .await
        .unwrap();
    session.dispose().await;

    let captured = std::fs::read_to_string(&log_path).unwrap();
    let new_req: Value = captured
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|v| v["method"] == "session/new")
        .expect("session/new request logged");
    let servers = new_req["params"]["mcpServers"].as_array().expect("mcpServers array");
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0]["type"], "http");
    assert_eq!(servers[0]["name"], "vibevalley");
    assert_eq!(servers[0]["url"], "http://127.0.0.1:8789/mcp");
    let headers = servers[0]["headers"].as_array().unwrap();
    assert!(headers.contains(&json!({ "name": "Authorization", "value": "Bearer vv-acp-token" })));
    assert!(headers.contains(&json!({ "name": HEADER_PROTOCOL_VERSION, "value": PROTOCOL_STATELESS })));
    assert_eq!(servers[0]["_meta"][META_PROTOCOL_VERSION], PROTOCOL_STATELESS);
    assert_eq!(servers[0]["_meta"][EXT_SKILLS]["scheme"], SKILL_URI_SCHEME);
}

#[tokio::test]
async fn oar_core_evicts_slow_event_subscriber_without_blocking_fast_subscribers() {
    let core = crate::core::SessionCore::new("scripted", "sess-backpressure", None);
    let mut slow_rx = core.subscribe_with_capacity(4);
    let mut fast_rx = core.subscribe_with_capacity(64);

    for i in 0..20usize {
        core.emit_root(EventKind::TextDelta { text: format!("chunk-{i}") });
    }

    let mut fast_got = Vec::new();
    while let Ok(ev) = fast_rx.try_recv() {
        fast_got.push(ev);
    }
    assert_eq!(fast_got.len(), 20, "fast subscriber must receive every event");
    assert_eq!(fast_got.first().map(|e| e.seq), Some(0));
    assert_eq!(fast_got.last().map(|e| e.seq), Some(19));

    let mut slow_got = Vec::new();
    while let Some(ev) = slow_rx.recv().await {
        slow_got.push(ev);
    }
    assert_eq!(slow_got.len(), 4, "slow subscriber must be bounded to capacity and evicted on overflow");
    assert_eq!(slow_got.last().map(|e| e.seq), Some(3));
}

#[test]
fn remote_dispatch_meta_debug_redacts_mcp_session_token() {
    let meta = RemoteDispatchMeta {
        session_id: Some("sess-1".into()),
        repo_ref: Some("https://example.invalid/repo.git".into()),
        branch: Some("feat/x".into()),
        base_ref: Some("main".into()),
        mcp_session_token: Some("super-secret-token-value".into()),
    };
    let rendered = format!("{meta:?}");
    assert!(
        !rendered.contains("super-secret-token-value"),
        "Debug output must redact mcp_session_token: {rendered}"
    );
    assert!(rendered.contains("[REDACTED]"));
}
