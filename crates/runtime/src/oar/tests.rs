//! Offline tests: the scripted runtime for session behavior, and the Claude
//! and Codex projectors fed with traces captured from real runs
//! (`tests/fixtures`, scrubbed of account data).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::oar::scripted::{Script, ScriptedRuntime, Step};
use crate::oar::*;

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
fn until(rx: &flume::Receiver<Event>, stop: impl Fn(&EventKind) -> bool) -> Vec<Event> {
    let mut out = Vec::new();
    loop {
        let event = rx.recv_timeout(WAIT).expect("event before timeout");
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

#[test]
fn every_subscriber_gets_every_event_in_order() {
    let runtime = ScriptedRuntime::new("s", Script::echo());
    let session = runtime.open(opts()).unwrap();
    let a = session.events();
    let b = session.events();
    session.prompt(text("hello")).unwrap();
    let ea = until(&a, turn_finished);
    let eb = until(&b, turn_finished);
    assert_eq!(ea, eb);
    assert_eq!(texts(&ea), "hello");
    assert!(ea.windows(2).all(|w| w[0].seq < w[1].seq), "seq strictly increases");
    assert!(ea.iter().all(|e| e.agent_path.is_empty()));
}

#[test]
fn status_follows_the_turn() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(200), Step::text("ok")]));
    let session = runtime.open(opts()).unwrap();
    let rx = session.events();
    assert_eq!(session.status(), SessionStatus::Idle);
    session.prompt(text("go")).unwrap();
    until(&rx, |k| matches!(k, EventKind::TurnStarted { .. }));
    assert_eq!(session.status(), SessionStatus::Running);
    let events = until(&rx, turn_finished);
    assert_eq!(session.status(), SessionStatus::Idle);
    assert_eq!(derive_status(&events), SessionStatus::Idle);
}

#[test]
fn a_second_prompt_while_running_is_rejected_busy() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(500), Step::text("ok")]));
    let session = runtime.open(opts()).unwrap();
    let rx = session.events();
    session.prompt(text("one")).unwrap();
    until(&rx, |k| matches!(k, EventKind::TurnStarted { .. }));
    let err = session.prompt(text("two")).unwrap_err();
    assert_eq!(err.rejection_code(), Some(rejection::BUSY), "{err}");
    until(&rx, turn_finished);
}

#[test]
fn queued_input_runs_after_the_current_turn() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(200), Step::text("{prompt}")]));
    let session = runtime.open(opts()).unwrap();
    let rx = session.events();
    session.prompt(text("first")).unwrap();
    session.queue(text("second")).unwrap();
    let first = until(&rx, turn_finished);
    let second = until(&rx, turn_finished);
    assert_eq!(texts(&first), "first");
    assert_eq!(texts(&second), "second");
}

#[test]
fn abort_ends_the_turn_as_aborted() {
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(5_000), Step::text("late")]));
    let session = runtime.open(opts()).unwrap();
    let rx = session.events();
    session.prompt(text("go")).unwrap();
    until(&rx, |k| matches!(k, EventKind::TurnStarted { .. }));
    session.abort().unwrap();
    let events = until(&rx, turn_finished);
    match &events.last().unwrap().kind {
        EventKind::TurnFinished { reason, .. } => assert_eq!(*reason, StopReason::Aborted),
        other => panic!("{other:?}"),
    }
    assert!(!texts(&events).contains("late"));
    let err = session.abort().unwrap_err();
    assert_eq!(err.rejection_code(), Some(rejection::NO_ACTIVE_TURN), "{err}");
}

#[test]
fn permission_waits_for_an_answer_and_denial_takes_the_denied_branch() {
    let runtime = ScriptedRuntime::demo();
    for (decision, expect_file) in [
        (PermissionDecision::AllowOnce, true),
        (PermissionDecision::Deny { message: Some("no".into()) }, false),
    ] {
        let session = runtime.open(opts()).unwrap();
        let rx = session.events();
        session.prompt(text("write a note")).unwrap();
        let before = until(&rx, |k| matches!(k, EventKind::PermissionRequested { .. }));
        let EventKind::PermissionRequested { request_id, tool, .. } = &before.last().unwrap().kind else {
            unreachable!()
        };
        assert_eq!(tool, "Write");
        assert_eq!(session.status(), SessionStatus::WaitingPermission);
        session.respond_permission(request_id, decision.clone()).unwrap();
        let after = until(&rx, turn_finished);
        assert!(matches!(after[0].kind, EventKind::PermissionResolved { .. }));
        let wrote = after.iter().any(|e| matches!(e.kind, EventKind::FileChanged { .. }));
        assert_eq!(wrote, expect_file, "{decision:?}");
        let err = session.respond_permission(request_id, PermissionDecision::AllowOnce).unwrap_err();
        assert_eq!(err.rejection_code(), Some(rejection::UNKNOWN_REQUEST), "{err}");
    }
}

#[test]
fn subagent_events_carry_their_path() {
    let runtime = ScriptedRuntime::demo();
    let session = runtime.open(opts()).unwrap();
    let rx = session.events();
    session.prompt(text("x")).unwrap();
    let before = until(&rx, |k| matches!(k, EventKind::PermissionRequested { .. }));
    let EventKind::PermissionRequested { request_id, .. } = &before.last().unwrap().kind else {
        unreachable!()
    };
    session.respond_permission(request_id, PermissionDecision::AllowOnce).unwrap();
    let after = until(&rx, turn_finished);
    let sub: Vec<_> = after.iter().filter(|e| !e.agent_path.is_empty()).collect();
    assert_eq!(sub.len(), 1);
    assert_eq!(sub[0].agent_path, vec!["task-1".to_string()]);
}

#[test]
fn unsupported_options_are_refused_before_opening() {
    let runtime = ScriptedRuntime::new("s", Script::echo());
    let err = runtime
        .open(SessionOptions {
            resume: Some("abc".into()),
            ..opts()
        })
        .err()
        .expect("refused");
    assert!(matches!(&err, AgentError::Unsupported { option, .. } if option == "resume"), "{err}");
    let err = runtime
        .open(SessionOptions {
            model: Some("no-such-model".into()),
            ..opts()
        })
        .err()
        .expect("refused");
    assert!(matches!(&err, AgentError::Unsupported { option, .. } if option == "model"), "{err}");
    let err = runtime
        .open(SessionOptions {
            cwd: PathBuf::from("/definitely/not/here"),
            ..opts()
        })
        .err()
        .expect("refused");
    assert!(matches!(&err, AgentError::Unsupported { option, .. } if option == "cwd"), "{err}");
}

#[test]
fn record_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run.jsonl");
    let runtime = ScriptedRuntime::demo();
    let session = runtime
        .open(SessionOptions {
            record_to: Some(path.clone()),
            ..opts()
        })
        .unwrap();
    let rx = session.events();
    session.prompt(text("go")).unwrap();
    let mut seen = until(&rx, |k| matches!(k, EventKind::PermissionRequested { .. }));
    let EventKind::PermissionRequested { request_id, .. } = &seen.last().unwrap().kind else {
        unreachable!()
    };
    session.respond_permission(request_id, PermissionDecision::AllowOnce).unwrap();
    seen.extend(until(&rx, turn_finished));
    session.dispose();
    seen.extend(until(&rx, |k| matches!(k, EventKind::SessionEnded)));

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

fn claude_events(name: &str) -> Vec<crate::oar::claude::Out> {
    let mut projector = crate::oar::claude::Projector::default();
    received(name).iter().flat_map(|m| projector.feed(m)).collect()
}

fn claude_kinds(out: &[crate::oar::claude::Out]) -> Vec<&EventKind> {
    out.iter()
        .filter_map(|o| match o {
            crate::oar::claude::Out::Event(_, kind) => Some(kind),
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
            crate::oar::claude::Out::Permission { tool, .. } => Some(tool.clone()),
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

fn codex_events(name: &str) -> (Vec<EventKind>, Vec<crate::oar::codex::ServerRequest>) {
    let mut projector = crate::oar::codex::Projector::new(&codex_root_thread(name));
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
        requests.iter().any(|r| matches!(r, crate::oar::codex::ServerRequest::Permission { .. })),
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
    let models = crate::oar::acp::models_of(&session);
    assert!(models.len() > 10, "{}", models.len());
    assert!(models.iter().all(|m| !m.id.is_empty()));
}

#[test]
fn acp_updates_project_text_tools_and_file_changes() {
    use serde_json::json;
    let mut p = crate::oar::acp::Projector::default();
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
    use crate::oar::{claude::claude_login_status, codex::codex_login_status, process::LoginStatus};
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

#[test]
#[ignore = "probes the real CLIs on this machine"]
fn installed_runtimes_report_their_login() {
    for id in ["claude", "codex"] {
        let runtime = default_runtimes().require(id).unwrap();
        println!("{id}: {:?}", runtime.installation());
    }
}

#[test]
fn a_set_binary_wins_over_path_and_can_be_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("my-claude");
    std::fs::write(&fake, "#!/bin/sh\necho 9.9.9\n").unwrap();
    std::os::unix::fs::PermissionsExt::set_mode(&mut std::fs::metadata(&fake).unwrap().permissions(), 0o755);
    std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    crate::oar::set_binary("vibevalley-test-agent", Some(fake.clone()));
    assert_eq!(crate::oar::process::find_binary("vibevalley-test-agent"), Some(fake));
    crate::oar::set_binary("vibevalley-test-agent", Some(dir.path().join("missing")));
    assert_eq!(crate::oar::process::find_binary("vibevalley-test-agent"), None);
    crate::oar::set_binary("vibevalley-test-agent", None);
    assert_eq!(crate::oar::process::find_binary("vibevalley-test-agent"), None);
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
    let launch = crate::oar::claude::claude_launch("s1", &opts).unwrap();
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

    let (_, params) = crate::oar::codex::open_request(&opts);
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
    } = crate::oar::codex::usage_of(&codex, None).unwrap()
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
    let usage = crate::oar::claude::usage_of(&claude, Some("a@b.c".into())).unwrap();
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
    } = crate::oar::acp::antigravity::usage_of(raw).unwrap()
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
        crate::oar::acp::antigravity::usage_of(partial).unwrap(),
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
    let AccountUsage::Available { rate_limited, windows, .. } = crate::oar::acp::antigravity::usage_of(total).unwrap() else {
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
    let AccountUsage::Available { windows, .. } = crate::oar::acp::antigravity::usage_of(custom_group).unwrap() else {
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
            crate::oar::acp::antigravity::usage_of(auth_raw).unwrap(),
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
            crate::oar::acp::antigravity::usage_of(unsupported_raw).unwrap(),
            AccountUsage::Unsupported {
                reason: "quota_unavailable".into()
            },
            "input: {unsupported_raw}"
        );
    }
}

#[test]
fn antigravity_read_account_usage_and_acp_runtime_dispatch() {
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

    let usage = crate::oar::acp::antigravity::read_account_usage(&ok_script).unwrap();
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
        crate::oar::acp::antigravity::read_account_usage(&auth_script).unwrap(),
        AccountUsage::ReauthRequired {
            reason: "not_authenticated".into()
        }
    );

    let generic = crate::oar::acp::AcpRuntime::new(crate::oar::acp::AcpAgentSpec::new("opencode", "OpenCode", "opencode", ["acp"]));
    assert_eq!(
        generic.account_usage().unwrap(),
        AccountUsage::Unsupported {
            reason: "not_supported".into()
        }
    );
}

#[test]
fn regression_only_root_usage_reported_in_this_turn_is_charged() {
    use serde_json::json;
    let core = crate::oar::core::SessionCore::new("qwen", "meter", None);
    let rx = core.subscribe(false);
    let turn = |root: Option<Value>, child: Option<Value>| {
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
            if let EventKind::TurnFinished { usage, .. } = rx.recv_timeout(Duration::from_secs(2)).unwrap().kind {
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
    let core = crate::oar::core::SessionCore::new("claude", "cumulative", None);
    let events = core.subscribe(false);
    let turn = |totals: Option<(u64, u64)>| {
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
            if let EventKind::TurnFinished { usage, .. } = events.recv_timeout(Duration::from_secs(2)).unwrap().kind {
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
    let core = crate::oar::core::SessionCore::new("antigravity", "agy-meter", None);
    // Even if a caller marks the meter resumed, Antigravity stays in per-turn mode.
    core.resume_meter(&Value::Null, "acp_resume_baseline_unknown");
    let rx = core.subscribe(false);
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
        if let EventKind::TurnFinished { usage, .. } = rx.recv_timeout(Duration::from_secs(2)).unwrap().kind {
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

static OBSERVER_TEST_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

struct ClearObserverOnDrop;
impl Drop for ClearObserverOnDrop {
    fn drop(&mut self) {
        set_observer(None);
    }
}

#[test]
fn observer_receives_events_outside_session_lock_and_stops_when_cleared() {
    let _serial = OBSERVER_TEST_LOCK.lock();
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
        .unwrap();
    assert_eq!(session.id(), expected_id);
    let (obs_tx, obs_rx) = flume::unbounded::<(String, Event)>();

    struct RecordingObserver {
        target_session: String,
        session: std::sync::Arc<dyn Session>,
        tx: flume::Sender<(String, Event)>,
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

    let rx = session.events();
    session.prompt(text("hello")).unwrap();
    until(&rx, turn_finished);

    let mut first_batch = Vec::new();
    loop {
        let item = obs_rx.recv_timeout(WAIT).expect("observer event before timeout");
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

    session.prompt(text("world")).unwrap();
    until(&rx, turn_finished);
    session.dispose();
    until(&rx, |k| matches!(k, EventKind::SessionEnded));

    assert!(obs_rx.try_recv().is_err(), "cleared observer must not receive further events");

    // Regression: dropping an observer that owns the last `Arc<dyn Session>` inside `set_observer(None)` must not self-deadlock on `OBSERVER`.
    let owned_session = runtime.open(opts()).unwrap();
    struct SessionOwningObserver(#[allow(dead_code)] std::sync::Arc<dyn Session>);
    impl OarObserver for SessionOwningObserver {
        fn on_event(&self, _session_id: &str, _event: &Event) {}
    }
    set_observer(Some(std::sync::Arc::new(SessionOwningObserver(owned_session))));
    set_observer(None);
    assert!(!has_observer());
}

#[test]
fn trace_id_propagates_to_voyage_jsonl_and_omits_none_or_zero() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("traced.jsonl");
    let runtime = ScriptedRuntime::new("s", Script::new().turn(vec![Step::sleep_ms(50), Step::text("{prompt}")]));
    let session = runtime
        .open(SessionOptions {
            record_to: Some(path.clone()),
            ..opts()
        })
        .unwrap();
    let rx = session.events();

    session.prompt_with(text("turn-none"), TurnOptions::default()).unwrap();
    until(&rx, turn_finished);

    session.prompt_with(text("turn-zero"), TurnOptions { trace_id: Some(0) }).unwrap();
    until(&rx, turn_finished);

    session.prompt_with(text("turn-traced"), TurnOptions { trace_id: Some(777) }).unwrap();
    session.queue_with(text("turn-queued"), TurnOptions { trace_id: Some(888) }).unwrap();
    until(&rx, turn_finished);
    until(&rx, turn_finished);

    session.prompt(text("turn-after")).unwrap();
    until(&rx, turn_finished);
    session.dispose();
    until(&rx, |k| matches!(k, EventKind::SessionEnded));

    let raw_jsonl = std::fs::read_to_string(&path).unwrap();
    let raw_lines: Vec<Value> = raw_jsonl.lines().skip(1).map(|l| serde_json::from_str(l).unwrap()).collect();

    let mut reader = crate::oar::voyage::Reader::new(std::io::BufReader::new(std::fs::File::open(&path).unwrap())).unwrap();
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

    let mut zero_rec = crate::oar::voyage::Record::new(crate::oar::voyage::Kind::Frame, "s".into(), 1);
    zero_rec.trace_id = Some(0);
    let encoded = serde_json::to_string(&zero_rec).unwrap();
    assert!(!encoded.contains("traceId"), "Some(0) must be omitted from JSON: {encoded}");
    let decoded_zero: crate::oar::voyage::Record = serde_json::from_str(r#"{"seq":0,"kind":"frame","sessionId":"s","agentPath":[],"traceId":0}"#).unwrap();
    assert_eq!(decoded_zero.trace_id, None);
    let decoded_nonzero: crate::oar::voyage::Record = serde_json::from_str(r#"{"seq":0,"kind":"frame","sessionId":"s","agentPath":[],"traceId":42}"#).unwrap();
    assert_eq!(decoded_nonzero.trace_id, Some(42));
}

#[test]
fn builtin_runtime_specs_match_default_registry_and_exclude_dsh() {
    assert!(runtime_spec("dsh").is_none());
    let registry = crate::agent::runtime::default_registry();
    for spec in BUILTIN_RUNTIME_SPECS {
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

#[test]
fn core_session_records_read_back_from_disk_and_cap_in_memory_history() {
    // When `record_to` is set, records are streamed to disk and read back on demand.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recorded.jsonl");
    let runtime = ScriptedRuntime::new("s", Script::echo());
    let session = runtime
        .open(SessionOptions {
            record_to: Some(path.clone()),
            ..opts()
        })
        .unwrap();
    let rx = session.events();
    session.prompt(text("disk-backed")).unwrap();
    until(&rx, turn_finished);
    let from_disk = session.records();
    assert!(!from_disk.is_empty(), "records() must read back persisted records");
    assert!(
        from_disk
            .iter()
            .any(|r| r.events.iter().any(|e| e["kind"] == "text_delta" && e["text"] == "disk-backed"))
    );
    session.dispose();
    until(&rx, |k| matches!(k, EventKind::SessionEnded));

    // When `record_to` is None, in-memory history stays bounded at 1024 records.
    let mut steps = Vec::with_capacity(1_100);
    for i in 0..1_100 {
        steps.push(Step::text(format!("chunk-{i}")));
    }
    let big_rt = ScriptedRuntime::new("s", Script::new().turn(steps));
    let mem_session = big_rt.open(opts()).unwrap();
    let mem_rx = mem_session.events();
    mem_session.prompt(text("go")).unwrap();
    until(&mem_rx, turn_finished);
    let capped = mem_session.records();
    assert_eq!(capped.len(), 1_024, "unrecorded history must be capped at 1024 records");
    assert!(capped.windows(2).all(|w| w[0].seq < w[1].seq), "retained tail remains strictly ordered");
    mem_session.dispose();
    until(&mem_rx, |k| matches!(k, EventKind::SessionEnded));
}
