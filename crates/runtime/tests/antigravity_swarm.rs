//! Offline integration tests for Antigravity Swarm V1 Layer 1 + Layer 2:
//! - ACP tool calls (`swarm`, `invoke_subagent`, `swarm_wait`, `post_message`) -> `EventKind::Subagent*`
//! - Read-only mtime-cached `/swarm` sidecar (`swarm.json`, `members.json`, `plan.json`, `board.jsonl`)
//! - Shared bounded `read_child_transcript` (256 KiB tail seek, 4000-char clamp, symlink & traversal guards)
//! - SQLite `step_type = 127` (`INVOKE_SUBAGENT`) protobuf inspection via `Session::read_subagent`

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use vibevalley_runtime::oar::acp::{AcpAgentSpec, AcpRuntime};
use vibevalley_runtime::oar::{AgentError, ContentBlock, Event, EventKind, Runtime, SessionOptions, SubagentStatus, SwarmMemberState, default_runtimes};

const WAIT: Duration = Duration::from_secs(15);

fn write_executable(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).expect("write mock script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod +x");
    path
}

async fn recv_until(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Event>, stop: impl Fn(&EventKind) -> bool) -> Vec<Event> {
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

const MOCK_SWARM_AGY: &str = r#"#!/usr/bin/env python3
import json, os, sqlite3, sys

session_id = os.environ.get("MOCK_SESSION_ID", "sess-swarm-1")
gemini_home = os.environ.get("GEMINI_HOME", "")
scenario = os.environ.get("MOCK_SWARM_SCENARIO", "full")

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def enc_varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            b |= 0x80
        out.append(b)
        if not v:
            break
    return bytes(out)

def enc_len(field_no, payload):
    return enc_varint((field_no << 3) | 2) + enc_varint(len(payload)) + payload

def seed_sidecar():
    base = os.path.join(gemini_home, "antigravity-cli")
    swarm_dir = os.path.join(base, "brain", session_id, ".system_generated", "swarm")
    os.makedirs(swarm_dir, exist_ok=True)
    with open(os.path.join(swarm_dir, "swarm.json"), "w", encoding="utf-8") as f:
        json.dump({
            "version": 1,
            "backend": "local",
            "swarm_id": "swarm-live-1",
            "created_at": "2026-11-22T05:00:00Z",
        }, f)
    with open(os.path.join(swarm_dir, "members.json"), "w", encoding="utf-8") as f:
        json.dump({
            "title": "Antigravity Swarm V1",
            "members": {
                "worker-a": {
                    "conversation_id": "conv-worker-a",
                    "role": "worker",
                    "phase": "RUNNING",
                    "wake_mode": "working",
                    "killed": False,
                    "model": "gemini-4-neon",
                    "workspace_mode": "inherit",
                },
                "coordinator": {
                    "conversation_id": session_id,
                    "role": "coordinator",
                    "phase": "RUNNING",
                    "wake_mode": "mentions",
                    "wait_since": 1,
                    "last_read_seq": 1,
                    "killed": False,
                    "applied_model": "gemini-4-neon",
                    "workspace_mode": "inherit",
                },
                "worker-idle": {
                    "conversation_id": "conv-worker-idle",
                    "role": "worker",
                    "phase": "STOPPED",
                    "wake_mode": "mentions",
                    "killed": False,
                    "model": "gemini-3-flash",
                    "workspace_mode": "share",
                },
            },
        }, f)
    with open(os.path.join(swarm_dir, "plan.json"), "w", encoding="utf-8") as f:
        json.dump({
            "goal": {"title": "Ship Swarm V1", "line": "OAR + Protocol + UI"},
            "tasks": {"worker-a": "Implement sidecar reader"},
            "threads": [{"id": "core", "title": "Runtime", "goal": "OAR Layer 1+2", "tasks": ["worker-a"]}],
        }, f)
    with open(os.path.join(swarm_dir, "board.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps({
            "seq": 1,
            "agent": "coordinator",
            "text": "@worker-a Implement sidecar reader",
            "time": "2026-11-22 13:50:00",
            "kind": "brief",
        }) + "\n")

    worker_logs = os.path.join(base, "brain", "conv-worker-a", ".system_generated", "logs")
    os.makedirs(worker_logs, exist_ok=True)
    with open(os.path.join(worker_logs, "transcript.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps({
            "step_index": 1,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "created_at": "2026-11-22T05:01:00Z",
            "model": "gemini-4-neon",
            "input_tokens": 500,
            "cache_read_tokens": 200,
            "output_tokens": 80,
            "thinking": "Reading antigravity_db.rs",
            "content": "Implemented read-only sidecar reader.",
            "tool_calls": [{"name": "read_file", "args": {"Path": "crates/runtime/src/oar/acp/antigravity_db.rs"}}],
        }) + "\n")

    sub_conv = "5d4f594b-ca4a-4e3c-a081-171ddb1d2d1d"
    sub_logs = os.path.join(base, "brain", sub_conv, ".system_generated", "logs")
    os.makedirs(sub_logs, exist_ok=True)
    with open(os.path.join(sub_logs, "transcript.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps({
            "step_index": 1,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "content": "Inspected protocol shapes cleanly.",
        }) + "\n")

    conv_dir = os.path.join(base, "conversations")
    os.makedirs(conv_dir, exist_ok=True)
    db_file = os.path.join(conv_dir, f"{session_id}.db")
    conn = sqlite3.connect(db_file)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS steps (
            idx integer PRIMARY KEY,
            step_type integer NOT NULL DEFAULT 0,
            status integer NOT NULL DEFAULT 0,
            step_payload blob,
            error_details blob
        )
    """)
    inner = (
        enc_len(1, b"explore")
        + enc_len(2, b"Inspect protocol shapes")
        + enc_len(3, sub_conv.encode("utf-8"))
        + enc_len(4, os.path.join(sub_logs, "transcript.jsonl").encode("utf-8"))
    )
    wrapper = enc_len(127, inner)
    conn.execute("INSERT OR REPLACE INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)", (1, 127, 2, wrapper))
    conn.commit()
    conn.close()

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
                "agentCapabilities": {
                    "sessionCapabilities": {"resume": {}},
                    "_meta": {"antigravity": {"systemPrompt": {"append": True}}},
                },
            },
        })
    elif method in ("session/new", "session/resume"):
        sid = msg["params"].get("sessionId", session_id)
        session_id = sid
        send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": sid}})
    elif method == "session/prompt":
        if scenario == "full":
            seed_sidecar()
            updates = [
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-swarm-add",
                    "title": "swarm",
                    "kind": "other",
                    "status": "in_progress",
                    "rawInput": {"action": "add", "name": "worker-a", "brief": "Implement sidecar reader"},
                },
                {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-swarm-add",
                    "status": "completed",
                    "rawOutput": {"status": "added"},
                },
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-post-1",
                    "title": "post_message",
                    "kind": "other",
                    "status": "completed",
                    "rawInput": {"text": "@worker-a start now"},
                },
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-wait-1",
                    "title": "swarm_wait",
                    "kind": "other",
                    "status": "in_progress",
                    "rawInput": {"since": 1},
                },
                {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-wait-1",
                    "status": "completed",
                },
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-sub-1",
                    "title": "invoke_subagent",
                    "kind": "other",
                    "status": "in_progress",
                    "rawInput": {"agent_type": "explore", "prompt": "Inspect protocol shapes"},
                },
                {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-sub-1",
                    "status": "completed",
                    "rawOutput": {"summary": "Inspected protocol shapes cleanly."},
                },
                {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-swarm-kill",
                    "title": "swarm",
                    "kind": "other",
                    "status": "completed",
                    "rawInput": {"action": "kill", "name": "worker-a"},
                },
            ]
            for u in updates:
                send({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {"sessionId": session_id, "update": u},
                })
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
"#;

#[tokio::test]
async fn antigravity_swarm_layer1_events_layer2_sidecar_and_read_subagent() {
    let rt_default = default_runtimes().require("antigravity").expect("antigravity registered");
    assert!(rt_default.capabilities().subagents);

    let dir = tempfile::tempdir().unwrap();
    let gemini_home = dir.path().join("gemini");
    std::fs::create_dir_all(&gemini_home).unwrap();
    let script = write_executable(dir.path(), "mock-agy-swarm", MOCK_SWARM_AGY);

    let rt = AcpRuntime::new(AcpAgentSpec::new("antigravity", "Antigravity CLI", script.to_string_lossy(), ["acp"]));
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            env: vec![
                ("GEMINI_HOME".into(), gemini_home.to_string_lossy().into_owned()),
                ("MOCK_SESSION_ID".into(), "sess-swarm-1".into()),
                ("MOCK_SWARM_SCENARIO".into(), "full".into()),
            ],
            ..Default::default()
        })
        .await
        .expect("open mock antigravity session");

    // Before any swarm/subagent activity, swarm_snapshot is None (no sidecar I/O).
    assert_eq!(session.swarm_snapshot(), None);

    let mut rx = session.events();
    session.prompt(vec![ContentBlock::Text("/swarm go".into())]).await.unwrap();
    let events = recv_until(&mut rx, |k| matches!(k, EventKind::TurnFinished { .. })).await;

    // Verify Layer 1 EventKind::Subagent* projections.
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentSpawned { parent_thread_id, thread_id, agent_name, task }
            if parent_thread_id == "sess-swarm-1"
            && thread_id == "worker-a"
            && agent_name.as_deref() == Some("worker-a")
            && task.as_deref() == Some("Implement sidecar reader")
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentStatusChanged { thread_id, status: SubagentStatus::Running, .. } if thread_id == "worker-a"
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentStatusChanged { thread_id, status: SubagentStatus::Shutdown, .. } if thread_id == "worker-a"
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentMessage { thread_id, text, .. } if thread_id == "swarm-board" && text == "@worker-a start now"
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentWait { call_id, targets, waiting: true, .. } if call_id == "call-wait-1" && targets == &vec!["board".to_string()]
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentWait { call_id, waiting: false, .. } if call_id == "call-wait-1"
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentSpawned { thread_id, agent_name, task, .. }
            if thread_id == "call-sub-1"
            && agent_name.as_deref() == Some("explore")
            && task.as_deref() == Some("Inspect protocol shapes")
    )));
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::SubagentStatusChanged { thread_id, status: SubagentStatus::Completed, message, .. }
            if thread_id == "call-sub-1" && message.as_deref() == Some("Inspected protocol shapes cleanly.")
    )));

    // Verify Layer 2 SwarmSnapshot.
    let snap = session.swarm_snapshot().expect("swarm snapshot present");
    assert_eq!(snap.swarm_id, "swarm-live-1");
    assert_eq!(snap.title.as_deref(), Some("Antigravity Swarm V1"));
    assert_eq!(snap.working_count, 1);
    assert_eq!(snap.waiting_count, 1);
    assert_eq!(snap.stopped_count, 1);
    assert_eq!(snap.killed_count, 0);
    let member_names: Vec<&str> = snap.members.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(member_names, vec!["coordinator", "worker-a", "worker-idle"]);
    assert_eq!(snap.members[0].state, SwarmMemberState::Waiting);
    assert_eq!(snap.members[1].state, SwarmMemberState::Working);
    assert_eq!(snap.members[1].task.as_deref(), Some("Implement sidecar reader"));
    assert_eq!(snap.members[2].state, SwarmMemberState::Stopped);
    assert_eq!(snap.messages.len(), 1);
    assert_eq!(snap.total_messages, 1);

    // Verify shared bounded transcript reader on worker & subagent conversations.
    let worker_steps = session.read_child_transcript("conv-worker-a", 10);
    assert_eq!(worker_steps.len(), 1);
    assert_eq!(worker_steps[0].thinking.as_deref(), Some("Reading antigravity_db.rs"));
    assert_eq!(worker_steps[0].content.as_deref(), Some("Implemented read-only sidecar reader."));
    assert_eq!(worker_steps[0].input_tokens, Some(500));
    assert_eq!(worker_steps[0].tool_calls.len(), 1);
    assert_eq!(worker_steps[0].tool_calls[0].name, "read_file");
    assert!(session.read_child_transcript("../escape", 10).is_empty());

    // Verify read_subagent resolves both a swarm worker and an invoke_subagent SQLite step_type=127 row.
    let worker_snap = session.read_subagent("worker-a", None).await.expect("read swarm worker");
    assert_eq!(worker_snap.agent_name.as_deref(), Some("worker-a"));
    assert_eq!(worker_snap.status, Some(SubagentStatus::Running));
    assert_eq!(worker_snap.message.as_deref(), Some("Implemented read-only sidecar reader."));

    let sub_snap = session
        .read_subagent("5d4f594b-ca4a-4e3c-a081-171ddb1d2d1d", None)
        .await
        .expect("read invoke_subagent");
    assert_eq!(sub_snap.agent_name.as_deref(), Some("explore"));
    assert_eq!(sub_snap.status, Some(SubagentStatus::Completed));
    assert_eq!(sub_snap.message.as_deref(), Some("Inspected protocol shapes cleanly."));

    session.dispose().await;
}

#[tokio::test]
async fn resumed_antigravity_session_detects_preexisting_swarm_without_tool_calls() {
    let dir = tempfile::tempdir().unwrap();
    let gemini_home = dir.path().join("gemini");
    let swarm_dir = gemini_home
        .join("antigravity-cli")
        .join("brain")
        .join("sess-preexisting")
        .join(".system_generated")
        .join("swarm");
    std::fs::create_dir_all(&swarm_dir).unwrap();
    std::fs::write(swarm_dir.join("swarm.json"), r#"{"swarm_id":"sw-resumed"}"#).unwrap();
    std::fs::write(
        swarm_dir.join("members.json"),
        r#"{"title":"Resumed Swarm","members":{"coordinator":{"conversation_id":"sess-preexisting","role":"coordinator","phase":"RUNNING","wake_mode":"mentions","killed":false}}}"#,
    )
    .unwrap();
    std::fs::write(
        swarm_dir.join("board.jsonl"),
        "{\"seq\":7,\"agent\":\"coordinator\",\"text\":\"resumed\",\"time\":\"13:55\"}\n",
    )
    .unwrap();

    let script = write_executable(dir.path(), "mock-agy-resume", MOCK_SWARM_AGY);
    let rt = AcpRuntime::new(AcpAgentSpec::new("antigravity", "Antigravity CLI", script.to_string_lossy(), ["acp"]));
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            resume: Some("sess-preexisting".into()),
            env: vec![
                ("GEMINI_HOME".into(), gemini_home.to_string_lossy().into_owned()),
                ("MOCK_SWARM_SCENARIO".into(), "idle".into()),
            ],
            ..Default::default()
        })
        .await
        .expect("open resumed session");

    let snap = session.swarm_snapshot().expect("preexisting swarm detected");
    assert_eq!(snap.swarm_id, "sw-resumed");
    assert_eq!(snap.title.as_deref(), Some("Resumed Swarm"));
    assert_eq!(snap.messages.len(), 1);
    assert_eq!(snap.messages[0].seq, 7);
    session.dispose().await;
}

#[tokio::test]
async fn generic_acp_session_keeps_swarm_and_subagent_sidecars_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_executable(dir.path(), "mock-generic", MOCK_SWARM_AGY);
    let rt = AcpRuntime::new(AcpAgentSpec::new("acp:generic-test", "Generic ACP", script.to_string_lossy(), ["acp"]));
    let session = rt
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            bin_path: Some(script),
            env: vec![("MOCK_SWARM_SCENARIO".into(), "idle".into())],
            ..Default::default()
        })
        .await
        .expect("open generic acp session");

    assert_eq!(session.swarm_snapshot(), None);
    assert!(session.read_child_transcript("conv-worker-a", 10).is_empty());
    assert!(matches!(
        session.read_subagent("worker-a", None).await,
        Err(AgentError::Unsupported { option, .. }) if option == "read_subagent"
    ));
    session.dispose().await;
}
