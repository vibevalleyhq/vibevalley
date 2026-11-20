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
fn regression_only_root_usage_reported_in_this_turn_is_charged() {
    use serde_json::json;
    let core = crate::core::SessionCore::new("qwen", "meter", None);
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
    let core = crate::core::SessionCore::new("claude", "cumulative", None);
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
