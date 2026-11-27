//! Offline unit/regression tests, mock stdio ACP subprocess integration tests,
//! and an opt-in (`#[ignore]`) local `agy >= 1.5.0` smoke test for the
//! Antigravity OAR ACP adapter.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_runtime::oar::acp::{AcpAgentSpec, AcpRuntime};
use vibevalley_runtime::oar::{
    AgentError, ContentBlock, Event, EventKind, Installation, InteractionDecision, PermissionMode, RefusableOption, Runtime, SessionOptions, SessionStatus,
    StatusFold, StopReason, ToolAction, Usage, default_runtimes, tool_action,
};

const WAIT: Duration = Duration::from_secs(15);

fn write_executable(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).expect("write mock script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod +x");
    path
}

async fn recv_until(rx: &mut tokio::sync::mpsc::Receiver<Event>, stop: impl Fn(&EventKind) -> bool) -> Vec<Event> {
    let mut out = Vec::new();
    loop {
        let ev = tokio::time::timeout(WAIT, rx.recv())
            .await
            .expect("expected event before timeout")
            .expect("channel open before stop event");
        let done = stop(&ev.kind);
        out.push(ev);
        if done {
            return out;
        }
    }
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

// ---- Core accounting, StatusFold, capabilities, tool_action -----------------

#[test]
fn antigravity_capabilities_and_refused_options() {
    let rt = default_runtimes().require("antigravity").expect("antigravity registered");
    let caps = rt.capabilities();
    assert!(caps.resume);
    assert!(caps.steer);
    assert!(caps.queue);
    assert!(caps.permission_requests);
    assert!(caps.model_selection);
    assert!(caps.usage);
    assert!(caps.config_options);

    let refused = rt.refused_options();
    assert!(refused.contains(&RefusableOption::SystemPrompt));
    assert!(refused.contains(&RefusableOption::DisallowedTools));
    assert!(refused.contains(&RefusableOption::AllowedTools));
    assert!(!refused.contains(&RefusableOption::AppendSystemPrompt));
    assert!(!refused.contains(&RefusableOption::Effort));
    assert!(!refused.contains(&RefusableOption::AdditionalDirectories));

    let ok_opts = SessionOptions {
        append_system_prompt: Some("extra".into()),
        effort: Some("high".into()),
        additional_directories: vec![PathBuf::from("/tmp")],
        ..Default::default()
    };
    assert!(ok_opts.validate_for("antigravity").is_ok());

    let bad_opts = SessionOptions {
        system_prompt: Some("replace".into()),
        ..Default::default()
    };
    assert!(matches!(
        bad_opts.validate_for("antigravity"),
        Err(AgentError::Unsupported { option, .. }) if option == "system_prompt"
    ));
}

#[test]
fn tool_action_classifies_acp_kinds_and_antigravity_names() {
    assert_eq!(tool_action("arbitrary", &json!({"kind": "execute"})), ToolAction::RunCommand);
    assert_eq!(tool_action("arbitrary", &json!({"kind": "read"})), ToolAction::ReadFile);
    assert_eq!(tool_action("arbitrary", &json!({"kind": "edit"})), ToolAction::EditFile);
    assert_eq!(tool_action("arbitrary", &json!({"kind": "delete"})), ToolAction::EditFile);
    assert_eq!(tool_action("arbitrary", &json!({"kind": "move"})), ToolAction::EditFile);
    assert_eq!(tool_action("arbitrary", &json!({"kind": "search"})), ToolAction::Search);
    assert_eq!(tool_action("arbitrary", &json!({"kind": "fetch"})), ToolAction::Web);

    assert_eq!(tool_action("run_command", &json!({})), ToolAction::RunCommand);
    assert_eq!(tool_action("view_file", &json!({})), ToolAction::ReadFile);
    assert_eq!(tool_action("replace_file_content", &json!({})), ToolAction::EditFile);
    assert_eq!(tool_action("grep_search", &json!({})), ToolAction::Search);
    assert_eq!(tool_action("read_url_content", &json!({})), ToolAction::Web);
}

#[test]
fn status_fold_transitions_to_waiting_reply_on_interaction() {
    let mut fold = StatusFold::new();
    let mk = |seq, kind| Event {
        seq,
        agent_path: vec![],
        at_ms: 0,
        kind,
    };
    assert_eq!(fold.apply(&mk(0, EventKind::TurnStarted { prompt: "hi".into() })), SessionStatus::Running);
    assert_eq!(
        fold.apply(&mk(
            1,
            EventKind::InteractionRequested {
                request_id: "int-1".into(),
                question: "Pick one".into(),
                options: vec![],
                allow_custom: true,
            },
        )),
        SessionStatus::WaitingReply
    );
    assert_eq!(fold.pending_interactions(), vec!["int-1".to_string()]);
    assert_eq!(
        fold.apply(&mk(
            2,
            EventKind::InteractionResolved {
                request_id: "int-1".into(),
                decision: InteractionDecision::Custom { text: "yes".into() },
            },
        )),
        SessionStatus::Running
    );
    assert!(fold.pending_interactions().is_empty());
    assert_eq!(
        fold.apply(&mk(
            3,
            EventKind::TurnFinished {
                reason: StopReason::Completed,
                usage: Usage::default(),
            },
        )),
        SessionStatus::Idle
    );
}

// ---- Mock stdio ACP integration tests ---------------------------------------

#[tokio::test]
async fn antigravity_stdout_auth_banner_prefiltered_without_jsonrpc_error() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_executable(
        dir.path(),
        "fake-agy-auth",
        r#"#!/usr/bin/env python3
import sys
print("Open the following link to authenticate the ACP server: https://auth.example.test/agy?code=123", flush=True)
sys.stdin.read()
"#,
    );
    let rt = AcpRuntime::new(AcpAgentSpec::new("antigravity", "Antigravity CLI", script.to_string_lossy(), ["acp"]));
    let err = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            request_timeout: Some(Duration::from_secs(5)),
            ..Default::default()
        })
        .await
        .err()
        .expect("should fail with NotAvailable");
    match err {
        AgentError::NotAvailable(msg) => {
            assert!(msg.contains("agy acp --login"), "{msg}");
            assert!(msg.contains("https://auth.example.test/agy?code=123"), "{msg}");
        }
        other => panic!("expected NotAvailable, got {other:?}"),
    }
}

const MOCK_AGY_SCRIPT: &str = r#"#!/usr/bin/env python3
import json, os, sqlite3, sys

trace_path = os.environ.get("MOCK_TRACE_FILE")
mode = os.environ.get("MOCK_SCENARIO", "standard")
db_path = os.environ.get("MOCK_SILENT_DB")

def log(entry):
    if trace_path:
        with open(trace_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

log({
    "kind": "spawn",
    "argv": sys.argv[1:],
    "AGY_CLI_DISABLE_AUTO_UPDATE": os.environ.get("AGY_CLI_DISABLE_AUTO_UPDATE"),
    "PYTHONUNBUFFERED": os.environ.get("PYTHONUNBUFFERED"),
})

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def config_for(model_id, effort=None):
    if model_id == "gemini-3-flash":
        levels = [
            {"value": "minimal", "name": "Minimal"},
            {"value": "low", "name": "Low"},
        ]
        cur_eff = effort or "minimal"
    else:
        levels = [
            {"value": "low", "name": "Low"},
            {"value": "medium", "name": "Medium"},
            {"value": "high", "name": "High"},
        ]
        cur_eff = effort or "medium"
    return [
        {
            "id": "model",
            "category": "model",
            "name": "Model",
            "type": "select",
            "currentValue": model_id,
            "options": [
                {"value": "gemini-3-pro", "name": "Gemini 3 Pro"},
                {"value": "gemini-3-flash", "name": "Gemini 3 Flash"},
            ],
        },
        {
            "id": "thought_level",
            "category": "thought_level",
            "name": "Thought Level",
            "type": "select",
            "currentValue": cur_eff,
            "options": levels,
        },
    ]

current_model = "gemini-3-pro"
current_effort = "medium"
session_id = "sess-silent" if mode == "silent_db" else "sess-agy-1"
pending_prompt_ids = []
turn_count = 0
perm_req_id = 500
waiting_for_interaction = None
waiting_for_perm = None
steer_prompt_id = None

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    log({"kind": "recv", "msg": msg})
    method = msg.get("method")
    req_id = msg.get("id")

    # Response to a server->client request (e.g. session/request_permission)
    if method is None and req_id is not None:
        if req_id == waiting_for_perm:
            waiting_for_perm = None
            # Next, send an interaction_* question that MUST NOT be auto-approved.
            perm_req_id += 1
            waiting_for_interaction = perm_req_id
            send({
                "jsonrpc": "2.0",
                "id": waiting_for_interaction,
                "method": "session/request_permission",
                "params": {
                    "sessionId": session_id,
                    "toolCall": {
                        "toolCallId": "interaction_deploy_1",
                        "title": "Select environment",
                        "kind": "other",
                        "rawInput": {"question": "Which target?", "allowCustom": True},
                    },
                    "options": [
                        {
                            "optionId": "opt-a",
                            "name": "Production",
                            "kind": "allow_once",
                            "_meta": {"agy.security.warning": "Affects live users"},
                        },
                        {
                            "optionId": "opt-b",
                            "name": "Staging",
                            "kind": "allow_once",
                        },
                    ],
                },
            })
        elif req_id == waiting_for_interaction:
            waiting_for_interaction = None
            chosen = msg.get("result", {}).get("outcome", {}).get("optionId", "none")
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "call-exec-1",
                        "title": "run_command",
                        "kind": "execute",
                        "status": "completed",
                        "rawInput": {
                            "CommandLine": "echo hi",
                            "WorkingDirectory": "/work",
                        },
                        "rawOutput": {
                            "combinedOutput": "hi data:image/png;base64,AAAA",
                            "formatted_output": "hi data:image/png;base64,AAAA",
                            "exit_code": 0,
                        },
                    },
                },
            })
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": f"chosen:{chosen}"},
                    },
                },
            })
            pid = pending_prompt_ids.pop(0)
            send({"jsonrpc": "2.0", "id": pid, "result": {"stopReason": "end_turn"}})
        continue

    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 2,
                "authMethods": [
                    {"id": "cached-token", "name": "Cached Token", "type": "cached"},
                    {"id": "browser-oauth", "name": "Browser Login", "interactive": True},
                ],
                "agentCapabilities": {
                    "loadSession": False,
                    "promptCapabilities": {"image": True},
                    "sessionCapabilities": {
                        "resume": {},
                    },
                    "_meta": {
                        "antigravity": {
                            "systemPrompt": {"append": True},
                        }
                    },
                },
            },
        })
    elif method == "authenticate":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method in ("session/new", "session/resume"):
        sid = msg["params"].get("sessionId", session_id)
        session_id = sid
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": sid,
                "modes": {
                    "currentModeId": "default",
                    "availableModes": [
                        {"id": "default", "name": "Default"},
                        {"id": "yolo", "name": "YOLO"},
                        {"id": "auto_edit", "name": "Auto Edit"},
                    ],
                },
                "configOptions": config_for(current_model, current_effort),
            },
        })
    elif method == "session/set_config_option":
        cid = msg["params"]["configId"]
        val = msg["params"]["value"]
        if cid == "model":
            current_model = val
            current_effort = "minimal" if val == "gemini-3-flash" else "medium"
        elif cid == "thought_level":
            current_effort = val
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"configOptions": config_for(current_model, current_effort)},
        })
    elif method == "session/set_mode":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32602, "message": f"mode rejected: {msg['params'].get('modeId')}"},
        })
    elif method == "session/prompt":
        turn_count += 1
        if mode == "interaction":
            pending_prompt_ids.append(req_id)
            perm_req_id += 1
            waiting_for_perm = perm_req_id
            # First ask a normal execute tool permission (should auto-allow in Bypass).
            send({
                "jsonrpc": "2.0",
                "id": waiting_for_perm,
                "method": "session/request_permission",
                "params": {
                    "sessionId": session_id,
                    "toolCall": {
                        "toolCallId": "tool-auto-1",
                        "title": "run_command",
                        "kind": "execute",
                        "rawInput": {"CommandLine": "ls"},
                    },
                    "options": [
                        {"optionId": "allow_once", "name": "Allow once", "kind": "allow_once"},
                        {"optionId": "reject_once", "name": "Deny", "kind": "reject_once"},
                    ],
                },
            })
        elif mode == "steer_background":
            if len(pending_prompt_ids) == 0:
                pending_prompt_ids.append(req_id)
                # Emit an open non-daemon execute tool call and wait for steer prompt.
                send({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": "bg-cmd-1",
                            "title": "run_command",
                            "kind": "execute",
                            "status": "in_progress",
                            "rawInput": {"CommandLine": "long-job", "IsDaemon": False},
                        },
                    },
                })
            else:
                # Second session/prompt arrived mid-turn (steer)!
                first_id = pending_prompt_ids.pop(0)
                send({"jsonrpc": "2.0", "id": first_id, "result": {"stopReason": "end_turn"}})
                send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
                # Now emit detached updates after both prompts returned!
                send({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "bg-cmd-1",
                            "status": "completed",
                            "rawOutput": {"combinedOutput": "bg-output"},
                        },
                    },
                })
                send({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "bg done"},
                        },
                    },
                })
                send({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "usage_update",
                            "used": 9000,
                            "size": 1000000,
                            "usage": {
                                "inputTokens": 120,
                                "cachedReadTokens": 880,
                                "outputTokens": 45,
                                "thoughtTokens": 55,
                            },
                        },
                    },
                })
        elif mode == "silent_db":
            if db_path:
                conn = sqlite3.connect(db_path)
                if turn_count == 1:
                    conn.execute(
                        "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)",
                        (1, 17, b"Error 429, Message: Quota limit hit, Status: RESOURCE_EXHAUSTED\nreason:QUOTA_EXHAUSTED quotaResetDelay:\"15s\""),
                    )
                else:
                    conn.execute(
                        "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)",
                        (2, 17, b"Error 400, Message: Invalid thinking signature, Status: INVALID_THINKING_SIGNATURE"),
                    )
                conn.commit()
                conn.close()
            send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
        else:
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": f"ok:{current_model}:{current_effort}"},
                    },
                },
            })
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "usage_update",
                        "used": 5000,
                        "size": 1000000,
                        "usage": {
                            "inputTokens": 300,
                            "cachedReadTokens": 700,
                            "cachedWriteTokens": 50,
                            "outputTokens": 80,
                            "thoughtTokens": 20,
                        },
                    },
                },
            })
            send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
"#;

#[tokio::test]
async fn antigravity_v2_handshake_auth_append_prompt_config_order_and_models() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_executable(dir.path(), "mock-agy", MOCK_AGY_SCRIPT);
    let trace_list = dir.path().join("trace-list.jsonl");
    let trace_open = dir.path().join("trace-open.jsonl");
    let trace_resume = dir.path().join("trace-resume.jsonl");
    let extra_dir = dir.path().join("extra");
    std::fs::create_dir_all(&extra_dir).unwrap();

    // 1. list_models probes each model's thought_level dynamically.
    let rt = AcpRuntime::new(AcpAgentSpec::new("antigravity", "Antigravity CLI", script.to_string_lossy(), ["acp"]));
    let models = rt.list_models().await.expect("list_models");
    assert_eq!(models.len(), 2);
    let pro = models.iter().find(|m| m.id == "gemini-3-pro").unwrap();
    assert!(pro.is_default);
    assert_eq!(pro.effort_levels, vec!["low", "medium", "high"]);
    assert_eq!(pro.default_effort.as_deref(), Some("medium"));
    let flash = models.iter().find(|m| m.id == "gemini-3-flash").unwrap();
    assert!(!flash.is_default);
    assert_eq!(flash.effort_levels, vec!["minimal", "low"]);
    assert_eq!(flash.default_effort.as_deref(), Some("minimal"));
    let _ = trace_list;

    // 2. Plan mode is refused when server does not advertise `plan`.
    let plan_err = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script.clone()),
            permission_mode: PermissionMode::Plan,
            ..Default::default()
        })
        .await
        .err()
        .expect("plan refused");
    assert!(matches!(plan_err, AgentError::Unsupported { option, .. } if option == "permission_mode"));

    // 3. Fresh open with Bypass + append_system_prompt + model + effort + additional_directories.
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script.clone()),
            model: Some("gemini-3-pro".into()),
            effort: Some("high".into()),
            append_system_prompt: Some("Stay concise.".into()),
            additional_directories: vec![extra_dir.clone()],
            permission_mode: PermissionMode::Bypass,
            env: vec![("MOCK_TRACE_FILE".into(), trace_open.to_string_lossy().into_owned())],
            ..Default::default()
        })
        .await
        .expect("open session");

    let mut rx = session.events();
    session.prompt(vec![ContentBlock::Text("hello".into())]).await.unwrap();
    let events = recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    let EventKind::TurnFinished { reason, usage } = &events.last().unwrap().kind else {
        unreachable!()
    };
    assert_eq!(*reason, StopReason::Completed);
    assert_eq!(usage.input_tokens, Some(1_000));
    assert_eq!(usage.output_tokens, Some(100));
    assert_eq!(usage.cache_read_tokens, Some(700));
    assert_eq!(usage.cache_write_tokens, Some(50));
    assert_eq!(usage.reasoning_tokens, Some(20));
    assert_eq!(usage.context_used_tokens, Some(5_000));
    assert_eq!(usage.context_window_tokens, Some(1_000_000));

    // Live set_config switches model -> thought_level -> AcceptEdits without wire auto_edit.
    session
        .set_config(Some("gemini-3-flash"), Some("low"), Some(PermissionMode::AcceptEdits))
        .await
        .expect("set_config");
    session.prompt(vec![ContentBlock::Text("after config".into())]).await.unwrap();
    let events2 = recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    let reply2: String = events2
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(reply2, "ok:gemini-3-flash:low");
    session.dispose().await;

    // Inspect recorded wire sequence.
    let entries = read_jsonl(&trace_open);
    let spawn = entries.iter().find(|e| e["kind"] == "spawn").expect("spawn entry");
    assert_eq!(spawn["AGY_CLI_DISABLE_AUTO_UPDATE"], "1");
    assert_eq!(spawn["PYTHONUNBUFFERED"], "1");
    let argv: Vec<&str> = spawn["argv"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(
        argv.contains(&"--dangerously-skip-permissions"),
        "Bypass must launch agy acp in YOLO mode: {argv:?}"
    );
    assert!(argv.windows(2).any(|w| w[0] == "--add-dir" && w[1] == extra_dir.to_string_lossy()));

    let methods: Vec<&str> = entries
        .iter()
        .filter(|e| e["kind"] == "recv")
        .filter_map(|e| e.pointer("/msg/method").and_then(Value::as_str))
        .collect();
    assert!(!methods.contains(&"session/set_mode"), "must never send yolo/auto_edit: {methods:?}");

    let init_pos = methods.iter().position(|m| *m == "initialize").unwrap();
    let auth_pos = methods.iter().position(|m| *m == "authenticate").unwrap();
    let new_pos = methods.iter().position(|m| *m == "session/new").unwrap();
    assert!(init_pos < auth_pos && auth_pos < new_pos, "{methods:?}");

    let init_msg = entries
        .iter()
        .find(|e| e.pointer("/msg/method").and_then(Value::as_str) == Some("initialize"))
        .unwrap();
    assert_eq!(init_msg.pointer("/msg/params/protocolVersion"), Some(&json!(2)));
    assert_eq!(init_msg.pointer("/msg/params/clientCapabilities/fs/readTextFile"), Some(&json!(false)));
    assert_eq!(init_msg.pointer("/msg/params/clientCapabilities/fs/writeTextFile"), Some(&json!(false)));
    assert_eq!(init_msg.pointer("/msg/params/clientCapabilities/terminal"), Some(&json!(false)));

    let new_msg = entries
        .iter()
        .find(|e| e.pointer("/msg/method").and_then(Value::as_str) == Some("session/new"))
        .unwrap();
    assert_eq!(
        new_msg.pointer("/msg/params/_meta/antigravity/systemPrompt/append"),
        Some(&json!("Stay concise."))
    );

    let config_calls: Vec<(&str, &str)> = entries
        .iter()
        .filter(|e| e.pointer("/msg/method").and_then(Value::as_str) == Some("session/set_config_option"))
        .map(|e| {
            (
                e.pointer("/msg/params/configId").and_then(Value::as_str).unwrap(),
                e.pointer("/msg/params/value").and_then(Value::as_str).unwrap(),
            )
        })
        .collect();
    assert_eq!(
        config_calls,
        vec![
            ("model", "gemini-3-pro"),
            ("thought_level", "high"),
            ("model", "gemini-3-flash"),
            ("thought_level", "low"),
        ]
    );

    // 4. Resume session ALSO sends `_meta.antigravity.systemPrompt.append` and reports non-zero per-turn usage.
    let resumed = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            resume: Some("sess-agy-1".into()),
            append_system_prompt: Some("Still concise.".into()),
            env: vec![("MOCK_TRACE_FILE".into(), trace_resume.to_string_lossy().into_owned())],
            ..Default::default()
        })
        .await
        .expect("resume session");
    let mut rx_res = resumed.events();
    resumed.prompt(vec![ContentBlock::Text("resumed".into())]).await.unwrap();
    let res_events = recv_until(&mut rx_res, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    let EventKind::TurnFinished { usage: res_usage, .. } = &res_events.last().unwrap().kind else {
        unreachable!()
    };
    assert_eq!(res_usage.input_tokens, Some(1_000));
    assert_eq!(res_usage.output_tokens, Some(100));
    resumed.dispose().await;

    let res_entries = read_jsonl(&trace_resume);
    let res_spawn = res_entries.iter().find(|e| e["kind"] == "spawn").expect("resume spawn entry");
    let res_argv: Vec<&str> = res_spawn["argv"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(
        !res_argv.contains(&"--dangerously-skip-permissions"),
        "Ask mode must not pass --dangerously-skip-permissions: {res_argv:?}"
    );
    let resume_msg = res_entries
        .iter()
        .find(|e| e.pointer("/msg/method").and_then(Value::as_str) == Some("session/resume"))
        .expect("session/resume sent");
    assert_eq!(
        resume_msg.pointer("/msg/params/_meta/antigravity/systemPrompt/append"),
        Some(&json!("Still concise."))
    );
}

#[tokio::test]
async fn antigravity_interaction_never_auto_approved_in_bypass_and_normalizes_tool_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_executable(dir.path(), "mock-agy-interaction", MOCK_AGY_SCRIPT);
    let rt = AcpRuntime::new(AcpAgentSpec::new("antigravity", "Antigravity CLI", script.to_string_lossy(), ["acp"]));
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            permission_mode: PermissionMode::Bypass,
            env: vec![("MOCK_SCENARIO".into(), "interaction".into())],
            ..Default::default()
        })
        .await
        .expect("open interaction session");

    let mut rx = session.events();
    session.prompt(vec![ContentBlock::Text("deploy".into())]).await.unwrap();

    // Must NOT emit PermissionRequested for the normal execute tool (auto-approved in Bypass),
    // and MUST pause on InteractionRequested for `interaction_deploy_1`.
    let before = recv_until(&mut rx, |k| matches!(k, EventKind::InteractionRequested { .. })).await;
    assert!(
        !before.iter().any(|e| matches!(e.kind, EventKind::PermissionRequested { .. })),
        "normal execute tool should have auto-approved under Bypass: {before:#?}"
    );
    let EventKind::InteractionRequested {
        request_id,
        question,
        options,
        allow_custom,
    } = &before.last().unwrap().kind
    else {
        unreachable!()
    };
    assert_eq!(question, "Which target?");
    assert!(*allow_custom);
    assert_eq!(options.len(), 2);
    assert_eq!(options[0].warning.as_deref(), Some("Affects live users"));
    assert_eq!(session.status(), SessionStatus::WaitingReply);

    session
        .respond_interaction(request_id, InteractionDecision::Select { option_id: "opt-b".into() })
        .await
        .expect("respond_interaction");

    let after = recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    assert!(after.iter().any(|e| matches!(e.kind, EventKind::InteractionResolved { .. })));

    let tool_started = after
        .iter()
        .find_map(|e| match &e.kind {
            EventKind::ToolCallStarted { id, input, .. } if id == "call-exec-1" => Some(input),
            _ => None,
        })
        .expect("normalized tool call started");
    assert_eq!(tool_started["command"], "echo hi");
    assert_eq!(tool_started["cwd"], "/work");
    assert_eq!(tool_started["kind"], "execute");

    let tool_out = after
        .iter()
        .find_map(|e| match &e.kind {
            EventKind::ToolCallFinished { id, output, .. } if id == "call-exec-1" => Some(output.as_str()),
            _ => None,
        })
        .expect("normalized tool call finished");
    assert_eq!(tool_out, "hi [inline image omitted]");

    let text: String = after
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "chosen:opt-b");
    session.dispose().await;
}

#[tokio::test]
async fn antigravity_mid_turn_steer_and_detached_background_continuation() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_executable(dir.path(), "mock-agy-steer", MOCK_AGY_SCRIPT);
    let trace = dir.path().join("trace-steer.jsonl");
    let rt = AcpRuntime::new(AcpAgentSpec::new("antigravity", "Antigravity CLI", script.to_string_lossy(), ["acp"]));
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            env: vec![
                ("MOCK_SCENARIO".into(), "steer_background".into()),
                ("MOCK_TRACE_FILE".into(), trace.to_string_lossy().into_owned()),
            ],
            ..Default::default()
        })
        .await
        .expect("open steer session");

    let mut rx = session.events();
    session.prompt(vec![ContentBlock::Text("start bg".into())]).await.unwrap();
    // Wait until the open background execute tool call arrives.
    recv_until(&mut rx, |k| matches!(k, EventKind::ToolCallStarted { id, .. } if id == "bg-cmd-1")).await;

    // Mid-turn steer sends another `session/prompt` (NOT `session/steer` or `session/cancel`).
    session.steer(vec![ContentBlock::Text("also summarize".into())]).await.expect("steer");

    // Turn only finishes AFTER detached `bg-cmd-1` completes, `"bg done"` streams, and `usage_update` lands.
    let rest = recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    let bg_text: String = rest
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(bg_text, "bg done");
    let EventKind::TurnFinished { reason, usage } = &rest.last().unwrap().kind else {
        unreachable!()
    };
    assert_eq!(*reason, StopReason::Completed);
    assert_eq!(usage.input_tokens, Some(1_000)); // 120 + 880
    assert_eq!(usage.output_tokens, Some(100)); // 45 + 55
    assert_eq!(usage.context_used_tokens, Some(9_000));
    session.dispose().await;

    let entries = read_jsonl(&trace);
    let methods: Vec<&str> = entries
        .iter()
        .filter(|e| e["kind"] == "recv")
        .filter_map(|e| e.pointer("/msg/method").and_then(Value::as_str))
        .collect();
    assert_eq!(methods.iter().filter(|m| **m == "session/prompt").count(), 2, "{methods:?}");
    assert!(!methods.contains(&"session/steer"), "{methods:?}");
    assert!(!methods.contains(&"session/cancel"), "{methods:?}");
}

#[tokio::test]
async fn antigravity_silent_db_error_upgrades_end_turn_and_marks_unresumable() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_executable(dir.path(), "mock-agy-db", MOCK_AGY_SCRIPT);
    let gemini_dir = dir.path().join("gemini");
    let conv_dir = gemini_dir.join("antigravity-cli").join("conversations");
    std::fs::create_dir_all(&conv_dir).unwrap();
    let db_path = conv_dir.join("sess-silent.db");

    // Create the steps table matching agy 1.5.14 schema via python3 sqlite3.
    let status = tokio::process::Command::new("python3")
        .args([
            "-c",
            "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0)'); c.execute('INSERT INTO steps (idx, step_type, step_payload) VALUES (0, 5, ?)', (b'init',)); c.commit()",
            &db_path.to_string_lossy(),
        ])
        .status()
        .await
        .expect("seed sqlite db");
    assert!(status.success());

    let rt = AcpRuntime::new(AcpAgentSpec::new(
        "antigravity",
        "Antigravity CLI",
        script.to_string_lossy(),
        ["acp", "--gemini-dir", &gemini_dir.to_string_lossy()],
    ));
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            env: vec![
                ("MOCK_SCENARIO".into(), "silent_db".into()),
                ("MOCK_SILENT_DB".into(), db_path.to_string_lossy().into_owned()),
            ],
            ..Default::default()
        })
        .await
        .expect("open silent_db session");

    let mut rx = session.events();

    // Turn 1: silent 429 QUOTA_EXHAUSTED -> upgraded to StopReason::Error, still resumable.
    session.prompt(vec![ContentBlock::Text("turn 1".into())]).await.unwrap();
    let t1 = recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    assert!(matches!(t1.last().unwrap().kind, EventKind::TurnFinished { reason: StopReason::Error, .. }));
    let err1 = t1
        .iter()
        .find_map(|e| match &e.kind {
            EventKind::Error { message } => Some(message.as_str()),
            _ => None,
        })
        .expect("Error event emitted");
    assert!(err1.contains("429") && err1.contains("QUOTA_EXHAUSTED") && err1.contains("15s"), "{err1}");
    assert_eq!(session.resume_id().as_deref(), Some("sess-silent"));

    // Turn 2: silent INVALID_THINKING_SIGNATURE -> upgraded to StopReason::Error AND resume_id() == None.
    session.prompt(vec![ContentBlock::Text("turn 2".into())]).await.unwrap();
    let t2 = recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    assert!(matches!(t2.last().unwrap().kind, EventKind::TurnFinished { reason: StopReason::Error, .. }));
    assert_eq!(session.resume_id(), None, "INVALID_THINKING_SIGNATURE must mark session unresumable");
    session.dispose().await;
}

#[tokio::test]
async fn antigravity_session_info_update_sets_and_updates_session_title_ignoring_blank_and_child() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_executable(
        dir.path(),
        "mock-agy-title",
        r#"#!/usr/bin/env python3
import json, sys

session_id = "sess-title-1"
turn = 0

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 2,
                "agentCapabilities": {"sessionCapabilities": {"resume": {}}},
            },
        })
    elif method == "session/new":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"sessionId": session_id, "title": "  Initial ACP Title  "},
        })
    elif method == "session/prompt":
        turn += 1
        if turn == 1:
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "session_info_update", "title": "  Fix terminal titles  "},
                },
            })
            # Blank title and child session update must NOT overwrite root title.
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "session_info_update", "title": "   "},
                },
            })
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "child-sub-9",
                    "update": {"sessionUpdate": "session_info_update", "title": "Child Worker Title"},
                },
            })
        else:
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "session_info_update", "title": "Swarm Title Polish"},
                },
            })
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
"#,
    );

    let rt = AcpRuntime::new(AcpAgentSpec::new("antigravity", "Antigravity CLI", script.to_string_lossy(), ["acp"]));
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            ..Default::default()
        })
        .await
        .expect("open title session");
    assert_eq!(session.session_title().as_deref(), Some("Initial ACP Title"));

    let mut rx = session.events();
    session.prompt(vec![ContentBlock::Text("first".into())]).await.unwrap();
    recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    assert_eq!(session.session_title().as_deref(), Some("Fix terminal titles"));

    session.prompt(vec![ContentBlock::Text("second".into())]).await.unwrap();
    recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;
    assert_eq!(session.session_title().as_deref(), Some("Swarm Title Polish"));
    session.dispose().await;
}

// ---- Opt-in real local `agy 1.5+` smoke test --------------------------------

#[tokio::test]
#[ignore = "probes real local agy >= 1.5.0 CLI and spends quota"]
async fn live_antigravity_local_smoke() {
    let rt = default_runtimes().require("antigravity").expect("antigravity runtime");
    let install = rt.installation().await;
    println!("[agy smoke] installation = {install:?}");
    let Installation::Available { version, path } = install else {
        panic!("expected local agy >= 1.5.0 to be installed and available");
    };
    assert!(version.is_some(), "version should be detected for {}", path.display());

    let models = rt.list_models().await.expect("list_models");
    println!("[agy smoke] models ({}):", models.len());
    for m in &models {
        println!(
            "  - {} ({}) default={} default_effort={:?} efforts={:?}",
            m.id, m.display_name, m.is_default, m.default_effort, m.effort_levels
        );
    }
    assert!(!models.is_empty(), "expected at least one advertised model");

    let dir = tempfile::tempdir().unwrap();
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            append_system_prompt: Some("You are being verified by an automated smoke test. Keep replies ultra short.".into()),
            permission_mode: PermissionMode::Bypass,
            ..Default::default()
        })
        .await
        .expect("open fresh antigravity session");
    let session_id = session.id();
    println!("[agy smoke] opened fresh session_id = {session_id}");
    let mut rx = session.events();
    session.prompt(vec![ContentBlock::Text("Reply with the single word ok.".into())]).await.unwrap();
    let mut reply = String::new();
    let fresh_usage = loop {
        let ev = tokio::time::timeout(Duration::from_secs(120), rx.recv())
            .await
            .expect("event within 120s")
            .expect("channel open");
        match ev.kind {
            EventKind::TextDelta { text } => reply.push_str(&text),
            EventKind::Error { message } => panic!("unexpected error on fresh turn: {message}"),
            EventKind::TurnFinished { reason, usage } => {
                assert_eq!(reason, StopReason::Completed, "fresh turn reason");
                break usage;
            }
            _ => {}
        }
    };
    println!("[agy smoke] fresh reply = {reply:?}, usage = {fresh_usage:?}");
    assert!(reply.to_lowercase().contains("ok"), "{reply:?}");
    assert!(
        fresh_usage.input_tokens.is_some_and(|n| n > 0),
        "expected non-zero input_tokens: {fresh_usage:?}"
    );
    assert!(
        fresh_usage.output_tokens.is_some_and(|n| n > 0),
        "expected non-zero output_tokens: {fresh_usage:?}"
    );

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let db = home.join(".gemini/antigravity-cli/conversations").join(format!("{session_id}.db"));
        println!("[agy smoke] conversation db exists={} path={}", db.is_file(), db.display());
        assert!(db.is_file(), "expected conversation db at {}", db.display());
    }
    session.dispose().await;

    // Resume the same session and confirm per-turn usage is still reported.
    let resumed = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            resume: Some(session_id.clone()),
            append_system_prompt: Some("Keep replies ultra short.".into()),
            permission_mode: PermissionMode::Bypass,
            ..Default::default()
        })
        .await
        .expect("resume antigravity session");
    let mut rx2 = resumed.events();
    resumed
        .prompt(vec![ContentBlock::Text("Now reply with the single word pong.".into())])
        .await
        .unwrap();
    let mut reply2 = String::new();
    let resumed_usage = loop {
        let ev = tokio::time::timeout(Duration::from_secs(120), rx2.recv())
            .await
            .expect("resumed event within 120s")
            .expect("channel open");
        match ev.kind {
            EventKind::TextDelta { text } => reply2.push_str(&text),
            EventKind::Error { message } => panic!("unexpected error on resumed turn: {message}"),
            EventKind::TurnFinished { reason, usage } => {
                assert_eq!(reason, StopReason::Completed, "resumed turn reason");
                break usage;
            }
            _ => {}
        }
    };
    println!("[agy smoke] resumed reply = {reply2:?}, usage = {resumed_usage:?}");
    assert!(reply2.to_lowercase().contains("pong"), "{reply2:?}");
    assert!(
        resumed_usage.input_tokens.is_some_and(|n| n > 0),
        "expected non-zero resumed input_tokens: {resumed_usage:?}"
    );
    assert!(
        resumed_usage.output_tokens.is_some_and(|n| n > 0),
        "expected non-zero resumed output_tokens: {resumed_usage:?}"
    );

    // Exercise steer + abort + dispose cleanly.
    resumed
        .prompt(vec![ContentBlock::Text("Count slowly from 1 to 300, one number per line.".into())])
        .await
        .unwrap();
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(120), rx2.recv())
            .await
            .expect("stream start")
            .expect("channel open");
        if matches!(ev.kind, EventKind::TextDelta { .. } | EventKind::ThinkingDelta { .. }) {
            break;
        }
        if matches!(ev.kind, EventKind::TurnFinished { .. }) {
            break;
        }
    }
    if resumed.status() == SessionStatus::Running {
        let _ = resumed.steer(vec![ContentBlock::Text("Stop counting and wait.".into())]).await;
        let _ = resumed.abort().await;
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(60), rx2.recv())
                .await
                .expect("turn end after abort")
                .expect("channel open");
            if let EventKind::TurnFinished { reason, .. } = ev.kind {
                println!("[agy smoke] post-steer/abort stop reason = {reason:?}");
                break;
            }
        }
    }
    resumed.dispose().await;
}
