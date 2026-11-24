//! Unit & integration tests for `vibevalley machine` CLI, `$VIBEVALLEY_HOME/machine-auth.json` (`0o600`),
//! `EventRingBuffer` (`seq`-indexed replay), `InputDeduplicator` (`input_id` idempotency),
//! local `/mcp` HTTP proxy tunneling, permission responses, reconnect recovery, and git worktree isolation.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, StatusCode as AxumStatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request as WsRequest, Response as WsResponse};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_util::sync::CancellationToken;
use vibevalley_cli::machine_agent::session::{EVENT_RING_CAPACITY, EventRingBuffer, InputDeduplicator, InputOutcome};
use vibevalley_cli::machine_agent::{
    MACHINE_AUTH_FILE, MachineAgent, MachineAgentConfig, MachineAuthConfig, Secret, load_machine_auth, machine_ws_url, save_machine_auth,
};
use vibevalley_protocol::{
    MachineHello, MachineHelloAck, MachineInputKind, MachineMcpResponse, MachinePing, MachinePlatform, MachineSessionAttach, MachineSessionEvent,
    MachineSessionInput, MachineSessionOpen, MachineSessionRespond, MachineWireFrame, MachineWorktreeCleanup, MachineWorktreePrepare,
};
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};
use vibevalley_runtime::oar::{Event, EventKind, McpServer, Registry};

type WsStream = tokio_tungstenite::WebSocketStream<TcpStream>;

async fn send_frame(ws: &mut WsStream, frame: &MachineWireFrame) {
    let text = serde_json::to_string(frame).unwrap();
    ws.send(WsMessage::Text(text.into())).await.unwrap();
}

async fn recv_frame(ws: &mut WsStream) -> MachineWireFrame {
    let timeout = Duration::from_secs(10);
    tokio::time::timeout(timeout, async {
        loop {
            match ws.next().await {
                Some(Ok(WsMessage::Text(text))) => return serde_json::from_str::<MachineWireFrame>(text.as_str()).unwrap(),
                Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => continue,
                other => panic!("unexpected WS message while awaiting frame: {other:?}"),
            }
        }
    })
    .await
    .expect("timed out waiting for MachineWireFrame")
}

#[allow(clippy::result_large_err)]
async fn accept_ws_with_auth(listener: &TcpListener, expected_bearer: &str) -> (WsStream, MachineHello) {
    let (stream, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .expect("timed out waiting for WS accept")
        .unwrap();
    let expected = format!("Bearer {expected_bearer}");
    let mut ws = tokio_tungstenite::accept_hdr_async(stream, move |req: &WsRequest, resp: WsResponse| -> Result<WsResponse, ErrorResponse> {
        let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
        assert_eq!(req.uri().path(), "/api/v1/machine/ws");
        if auth != expected {
            let mut err = ErrorResponse::new(Some("unauthorized".into()));
            *err.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(err);
        }
        Ok(resp)
    })
    .await
    .unwrap();

    let hello = match recv_frame(&mut ws).await {
        MachineWireFrame::MachineHello(h) => h,
        other => panic!("expected MachineHello first, got {other:?}"),
    };
    match recv_frame(&mut ws).await {
        MachineWireFrame::MachineInventory(inv) => assert_eq!(inv.machine_id, hello.machine_id),
        other => panic!("expected MachineInventory second, got {other:?}"),
    }
    send_frame(
        &mut ws,
        &MachineWireFrame::MachineHelloAck(MachineHelloAck {
            machine_id: hello.machine_id.clone(),
            server_version: "0.2.0-test".into(),
            heartbeat_ms: 15_000,
        }),
    )
    .await;
    (ws, hello)
}

fn cli_run(home: &Path, args: &[&str], env: &[(&str, &str)]) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_vibevalley"))
        .args(args)
        .env("VIBEVALLEY_HOME", home)
        .env_remove("VIBEVALLEY_SERVER")
        .env_remove("VIBEVALLEY_TOKEN")
        .env_remove("VIBEVALLEY_REMOTE_TOKEN")
        .env_remove("VIBEVALLEY_WORK_ROOT")
        .envs(env.iter().copied())
        .output()
        .unwrap();
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
        String::from_utf8_lossy(&output.stderr).trim_end().to_string(),
    )
}

#[test]
fn machine_agent_ring_buffer_and_idempotency() {
    // 1. EventRingBuffer: monotonic seq = 1.., bounded capacity eviction, exact replay_after ordering.
    let mut ring = EventRingBuffer::new(4);
    for idx in 0..6u64 {
        let ev = Event {
            seq: idx,
            agent_path: vec![],
            at_ms: 1_700_000_000_000 + idx,
            kind: EventKind::TextDelta { text: format!("chunk-{idx}") },
        };
        let wire = ring.push("sess-ring", &ev);
        assert_eq!(wire.seq, idx + 1);
        assert_eq!(wire.session_id, "sess-ring");
        assert!(!wire.terminal);
    }
    assert_eq!(ring.len(), 4);
    assert_eq!(ring.last_seq(), 6);
    assert_eq!(EVENT_RING_CAPACITY, 4096);

    let replayed: Vec<u64> = ring.replay_after(4).into_iter().map(|e| e.seq).collect();
    assert_eq!(replayed, vec![5, 6]);
    let all_retained: Vec<u64> = ring.replay_after(0).into_iter().map(|e| e.seq).collect();
    assert_eq!(all_retained, vec![3, 4, 5, 6]);
    assert!(ring.replay_after(6).is_empty());

    let ended = Event {
        seq: 99,
        agent_path: vec![],
        at_ms: 1_700_000_000_100,
        kind: EventKind::SessionEnded,
    };
    assert!(ring.push("sess-ring", &ended).terminal);

    // 2. InputDeduplicator: bounded FIFO eviction + duplicate lookup.
    let mut dedup = InputDeduplicator::new(2);
    assert_eq!(dedup.get("in-1"), None);
    dedup.record("in-1".into(), InputOutcome { ok: true, error: None });
    dedup.record(
        "in-2".into(),
        InputOutcome {
            ok: false,
            error: Some("busy".into()),
        },
    );
    assert_eq!(dedup.get("in-1").map(|o| o.ok), Some(true));
    assert_eq!(dedup.get("in-2").and_then(|o| o.error.as_deref()), Some("busy"));
    dedup.record("in-3".into(), InputOutcome { ok: true, error: None });
    assert_eq!(dedup.len(), 2);
    assert_eq!(dedup.get("in-1"), None);
    assert_eq!(dedup.get("in-3").map(|o| o.ok), Some(true));

    // 3. machine-auth.json 0o600 persistence & zero token leak in Debug.
    let home = tempfile::tempdir().unwrap();
    assert_eq!(load_machine_auth(home.path()).unwrap(), None);
    let raw_tok = "vv_dev_machine_secret_0123456789abcdef";
    let cfg = MachineAuthConfig {
        server: "http://100.64.0.9:8890".into(),
        token: Secret::new(raw_tok),
        machine_id: "gpu-box-1".into(),
        machine_name: "GPU Box".into(),
        device_id: "dev_machine_1".into(),
        server_name: Some("Studio".into()),
        scope: Some("remote:runtime".into()),
    };
    let debug = format!("{cfg:?}");
    assert!(!debug.contains(raw_tok), "MachineAuthConfig Debug leaked token: {debug}");

    let saved_path = save_machine_auth(home.path(), &cfg).unwrap();
    assert_eq!(saved_path, home.path().join(MACHINE_AUTH_FILE));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&saved_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "machine-auth.json must be 0600, got {mode:o}");
    }
    let loaded = load_machine_auth(home.path()).unwrap().unwrap();
    assert_eq!(loaded, cfg);

    assert_eq!(machine_ws_url("https://mac.ts.net:8890/").unwrap(), "wss://mac.ts.net:8890/api/v1/machine/ws");
    assert_eq!(machine_ws_url("http://127.0.0.1:8790").unwrap(), "ws://127.0.0.1:8790/api/v1/machine/ws");
}

#[test]
fn machine_agent_reconnect_replays_missed_events_and_deduplicates_retried_inputs() {
    vibevalley_runtime::rt::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let workdir = tempfile::tempdir().unwrap();
        let token = "vv_dev_ws_reconnect_token_12345678";

        let turn_count = Arc::new(AtomicUsize::new(0));
        let turn_count_rt = turn_count.clone();
        let script = Script::computed(Arc::new(move |ask| {
            let n = turn_count_rt.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(vec![Step::sleep_ms(120), Step::text(format!("reply-{n}:{}", ask.prompt))])
        }));
        let mut registry = Registry::new();
        registry.register(Arc::new(ScriptedRuntime::new("scripted", script)));

        let mut cfg = MachineAgentConfig::new(
            format!("http://{addr}"),
            Secret::new(token),
            "devbox-1".into(),
            "Devbox One".into(),
            workdir.path().to_path_buf(),
        );
        cfg.reconnect_base_delay = Duration::from_millis(40);
        cfg.reconnect_max_delay = Duration::from_millis(160);

        let cancel = CancellationToken::new();
        let agent = Arc::new(MachineAgent::new_async(cfg, Arc::new(registry), cancel.clone()).await);
        let agent_task = {
            let agent = agent.clone();
            tokio::spawn(async move { agent.run().await })
        };

        // Connection #1: handshake, ping/pong, open session, send input, then drop WS mid-turn!
        let (mut ws1, hello1) = accept_ws_with_auth(&listener, token).await;
        assert_eq!(hello1.machine_id, "devbox-1");
        assert!(hello1.runtimes.iter().any(|r| r.id == "scripted" && r.available));

        send_frame(&mut ws1, &MachineWireFrame::MachinePing(MachinePing { ts: 42_000 })).await;
        match recv_frame(&mut ws1).await {
            MachineWireFrame::MachinePong(pong) => assert_eq!(pong.ts, 42_000),
            other => panic!("expected MachinePong, got {other:?}"),
        }

        send_frame(
            &mut ws1,
            &MachineWireFrame::MachineSessionOpen(MachineSessionOpen {
                request_id: "open-1".into(),
                session_id: "sess-1".into(),
                runtime_id: "scripted".into(),
                ..Default::default()
            }),
        )
        .await;

        let opened = match recv_frame(&mut ws1).await {
            MachineWireFrame::MachineSessionOpened(opened) => opened,
            other => panic!("expected MachineSessionOpened, got {other:?}"),
        };
        assert!(opened.ok, "open failed: {:?}", opened.error);
        assert!(opened.workdir.is_some());

        // Receive seq=1 (SessionStarted) before starting the turn.
        let first_ev = match recv_frame(&mut ws1).await {
            MachineWireFrame::MachineSessionEvent(ev) => ev,
            other => panic!("expected seq=1 SessionStarted event, got {other:?}"),
        };
        assert_eq!(first_ev.seq, 1);

        // Start turn with input_id = "in-1" and verify ack.
        let input_req = MachineSessionInput {
            request_id: "req-in-1".into(),
            session_id: "sess-1".into(),
            input_id: "in-1".into(),
            kind: MachineInputKind::Prompt,
            text: Some("build feature".into()),
            model: None,
            effort: None,
        };
        send_frame(&mut ws1, &MachineWireFrame::MachineSessionInput(input_req.clone())).await;
        loop {
            match recv_frame(&mut ws1).await {
                MachineWireFrame::MachineSessionAck(ack) => {
                    assert_eq!(ack.request_id, "req-in-1");
                    assert_eq!(ack.input_id, "in-1");
                    assert!(ack.ok, "input failed: {:?}", ack.error);
                    break;
                }
                MachineWireFrame::MachineSessionEvent(_) => continue,
                other => panic!("unexpected frame while waiting for ack: {other:?}"),
            }
        }

        // Drop WS #1 immediately while the scripted turn is sleeping for 120ms!
        drop(ws1);

        // Wait briefly so the OAR turn finishes while disconnected, buffering events in the ring buffer.
        tokio::time::sleep(Duration::from_millis(220)).await;

        // Connection #2: agent automatically reconnects and keeps the local OAR session alive!
        let (mut ws2, hello2) = accept_ws_with_auth(&listener, token).await;
        assert_eq!(hello2.machine_id, "devbox-1");

        // Attach after seq=1 and verify every missed event (TurnStarted, TextDelta, TurnFinished) replays in exact order!
        send_frame(
            &mut ws2,
            &MachineWireFrame::MachineSessionAttach(MachineSessionAttach {
                request_id: "attach-1".into(),
                session_id: "sess-1".into(),
                after_seq: 1,
            }),
        )
        .await;

        let mut replayed: Vec<MachineSessionEvent> = Vec::new();
        loop {
            match recv_frame(&mut ws2).await {
                MachineWireFrame::MachineSessionEvent(ev) => {
                    let parsed: Event = serde_json::from_str(&ev.event_json).unwrap();
                    let finished = matches!(parsed.kind, EventKind::TurnFinished { .. });
                    replayed.push(ev);
                    if finished {
                        break;
                    }
                }
                other => panic!("expected replayed MachineSessionEvent, got {other:?}"),
            }
        }
        assert!(replayed.len() >= 3, "expected TurnStarted + TextDelta + TurnFinished, got {replayed:?}");
        for pair in replayed.windows(2) {
            assert_eq!(pair[1].seq, pair[0].seq + 1, "replayed seq must be contiguous: {replayed:?}");
        }
        assert_eq!(replayed[0].seq, 2);
        assert!(
            replayed.iter().any(|e| e.event_json.contains("reply-1:build feature")),
            "missing echoed reply in replayed events: {replayed:?}"
        );

        // Retry the exact same input_id after reconnect: must NOT re-execute the OAR turn!
        let mut retry_req = input_req;
        retry_req.request_id = "req-in-1-retry".into();
        send_frame(&mut ws2, &MachineWireFrame::MachineSessionInput(retry_req)).await;
        match recv_frame(&mut ws2).await {
            MachineWireFrame::MachineSessionAck(ack) => {
                assert_eq!(ack.request_id, "req-in-1-retry");
                assert_eq!(ack.input_id, "in-1");
                assert!(ack.ok);
            }
            other => panic!("expected deduplicated MachineSessionAck, got {other:?}"),
        }
        assert_eq!(turn_count.load(Ordering::SeqCst), 1, "retried input_id executed twice!");

        // Clean dispose via MachineInputKind::Dispose.
        send_frame(
            &mut ws2,
            &MachineWireFrame::MachineSessionInput(MachineSessionInput {
                request_id: "req-dispose".into(),
                session_id: "sess-1".into(),
                input_id: "in-dispose".into(),
                kind: MachineInputKind::Dispose,
                text: None,
                model: None,
                effort: None,
            }),
        )
        .await;
        loop {
            match recv_frame(&mut ws2).await {
                MachineWireFrame::MachineSessionAck(ack) if ack.request_id == "req-dispose" => {
                    assert!(ack.ok);
                    break;
                }
                MachineWireFrame::MachineSessionEvent(_) => continue,
                other => panic!("unexpected frame during dispose: {other:?}"),
            }
        }

        cancel.cancel();
        agent_task.await.unwrap().unwrap();
    });
}

#[test]
fn machine_agent_local_mcp_proxy_and_permission_respond_round_trip() {
    vibevalley_runtime::rt::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let workdir = tempfile::tempdir().unwrap();
        let ws_token = "vv_dev_mcp_proxy_token_12345678";
        let mcp_session_token = "helper-session-token-xyz";

        // Computed scripted turn calls the session's ephemeral local `/mcp` HTTP proxy using the injected token,
        // then waits on a permission request resolved by `MachineSessionRespond`.
        let script = Script::computed(Arc::new(move |ask| {
            let Some(McpServer::Http { url, headers, .. }) = ask.mcp_servers.first() else {
                return Err("missing injected local McpServer::Http".into());
            };
            let auth_header = headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
                .map(|(_, v)| v.clone())
                .ok_or_else(|| "missing authorization header on local McpServer".to_string())?;

            let http = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
            let resp = http
                .post(url)
                .header("content-type", "application/json")
                .header("authorization", auth_header)
                .body(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}"#)
                .send()
                .map_err(|e| format!("local MCP POST failed: {e}"))?;
            let status = resp.status().as_u16();
            let body = resp.text().map_err(|e| e.to_string())?;
            Ok(vec![
                Step::text(format!("mcp_status={status} body={body}")),
                Step::Permission {
                    request_id: "perm-99".into(),
                    tool: "Bash".into(),
                    input: json!({ "command": "cargo test" }),
                    summary: "Run cargo test".into(),
                    denied: vec![Step::text("denied")],
                },
                Step::text(" approved!"),
            ])
        }));

        let mut registry = Registry::new();
        registry.register(Arc::new(ScriptedRuntime::new("scripted", script)));

        let cfg = MachineAgentConfig::new(
            format!("http://{addr}"),
            Secret::new(ws_token),
            "mcp-box".into(),
            "MCP Box".into(),
            workdir.path().to_path_buf(),
        );
        let cancel = CancellationToken::new();
        let agent = Arc::new(MachineAgent::new_async(cfg, Arc::new(registry), cancel.clone()).await);
        let agent_task = {
            let agent = agent.clone();
            tokio::spawn(async move { agent.run().await })
        };

        let (mut ws, _) = accept_ws_with_auth(&listener, ws_token).await;

        send_frame(
            &mut ws,
            &MachineWireFrame::MachineSessionOpen(MachineSessionOpen {
                request_id: "open-mcp".into(),
                session_id: "sess-mcp".into(),
                runtime_id: "scripted".into(),
                mcp_session_token: Some(mcp_session_token.into()),
                ..Default::default()
            }),
        )
        .await;
        match recv_frame(&mut ws).await {
            MachineWireFrame::MachineSessionOpened(o) => assert!(o.ok, "{:?}", o.error),
            other => panic!("expected MachineSessionOpened, got {other:?}"),
        }

        send_frame(
            &mut ws,
            &MachineWireFrame::MachineSessionInput(MachineSessionInput {
                request_id: "in-mcp".into(),
                session_id: "sess-mcp".into(),
                input_id: "id-mcp-1".into(),
                kind: MachineInputKind::Prompt,
                text: Some("call mcp".into()),
                model: None,
                effort: None,
            }),
        )
        .await;

        let mut saw_mcp_request = false;
        let mut collected_text = String::new();
        loop {
            match recv_frame(&mut ws).await {
                MachineWireFrame::MachineMcpRequest(mcp_req) => {
                    saw_mcp_request = true;
                    assert_eq!(mcp_req.session_id, "sess-mcp");
                    assert_eq!(mcp_req.session_token, mcp_session_token);
                    assert_eq!(mcp_req.method, "POST");
                    assert_eq!(mcp_req.path, "/mcp");
                    assert!(mcp_req.body.contains("\"tools/list\""), "body={}", mcp_req.body);
                    send_frame(
                        &mut ws,
                        &MachineWireFrame::MachineMcpResponse(MachineMcpResponse {
                            request_id: mcp_req.request_id,
                            status: 200,
                            content_type: "application/json; charset=utf-8".into(),
                            body: r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[{"name":"say"}]}}"#.into(),
                        }),
                    )
                    .await;
                }
                MachineWireFrame::MachineSessionEvent(ev) => {
                    let parsed: Event = serde_json::from_str(&ev.event_json).unwrap();
                    match parsed.kind {
                        EventKind::TextDelta { text } => collected_text.push_str(&text),
                        EventKind::PermissionRequested { request_id, .. } => {
                            assert_eq!(request_id, "perm-99");
                            send_frame(
                                &mut ws,
                                &MachineWireFrame::MachineSessionRespond(MachineSessionRespond {
                                    request_id: "resp-99".into(),
                                    session_id: "sess-mcp".into(),
                                    target_id: request_id,
                                    allow: true,
                                    answer: None,
                                }),
                            )
                            .await;
                        }
                        EventKind::TurnFinished { .. } => break,
                        _ => {}
                    }
                }
                MachineWireFrame::MachineSessionAck(_) => {}
                other => panic!("unexpected frame: {other:?}"),
            }
        }

        assert!(saw_mcp_request, "expected proxied MachineMcpRequest over WS");
        assert!(collected_text.contains("mcp_status=200"), "text={collected_text}");
        assert!(collected_text.contains("\"say\""), "text={collected_text}");
        assert!(collected_text.contains("approved!"), "text={collected_text}");

        cancel.cancel();
        agent_task.await.unwrap().unwrap();
    });
}

#[test]
fn machine_agent_worktree_prepare_cleanup_and_path_guard() {
    vibevalley_runtime::rt::block_on(async {
        let tmp = tempfile::tempdir().unwrap();
        let workdir = tmp.path().join("machine-work");
        let repo_dir = workdir.join("repos").join("demo");
        std::fs::create_dir_all(&repo_dir).unwrap();

        let git = |args: &[&str]| {
            let status = Command::new("git")
                .current_dir(&repo_dir)
                .args(args)
                .env("GIT_AUTHOR_NAME", "Tester")
                .env("GIT_AUTHOR_EMAIL", "tester@example.com")
                .env("GIT_COMMITTER_NAME", "Tester")
                .env("GIT_COMMITTER_EMAIL", "tester@example.com")
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        git(&["init", "-b", "main"]);
        std::fs::write(repo_dir.join("README.md"), "hello\n").unwrap();
        git(&["add", "README.md"]);
        git(&["commit", "-m", "init"]);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "vv_dev_worktree_token_12345678";

        let mut registry = Registry::new();
        registry.register(Arc::new(ScriptedRuntime::new("scripted", Script::echo())));
        let cfg = MachineAgentConfig::new(
            format!("http://{addr}"),
            Secret::new(token),
            "wt-box".into(),
            "Worktree Box".into(),
            workdir.clone(),
        );
        let cancel = CancellationToken::new();
        let agent = Arc::new(MachineAgent::new_async(cfg, Arc::new(registry), cancel.clone()).await);
        let agent_task = {
            let agent = agent.clone();
            tokio::spawn(async move { agent.run().await })
        };

        let (mut ws, hello) = accept_ws_with_auth(&listener, token).await;
        assert!(hello.worktree_supported);

        // Prepare isolated worktree for task-42 on branch feat/task-42.
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineWorktreePrepare(MachineWorktreePrepare {
                request_id: "wt-prep-1".into(),
                task_id: "task-42".into(),
                repo_ref: "demo".into(),
                branch: Some("feat/task-42".into()),
                base_ref: Some("main".into()),
            }),
        )
        .await;
        let prepared = match recv_frame(&mut ws).await {
            MachineWireFrame::MachineWorktreeResult(res) => res,
            other => panic!("expected MachineWorktreeResult, got {other:?}"),
        };
        assert!(prepared.ok, "prepare failed: {:?}", prepared.error);
        assert_eq!(prepared.branch.as_deref(), Some("feat/task-42"));
        let wt_path = Path::new(prepared.workdir.as_deref().unwrap()).to_path_buf();
        assert!(wt_path.join("README.md").is_file());
        assert!(wt_path.starts_with(std::fs::canonicalize(workdir.join("worktrees")).unwrap()));

        // Guard: cleanup MUST refuse a path outside `--workdir/worktrees`.
        let outside_dir = tmp.path().join("outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineWorktreeCleanup(MachineWorktreeCleanup {
                request_id: "wt-clean-bad".into(),
                task_id: "task-42".into(),
                workdir: outside_dir.display().to_string(),
            }),
        )
        .await;
        let rejected = match recv_frame(&mut ws).await {
            MachineWireFrame::MachineWorktreeResult(res) => res,
            other => panic!("expected MachineWorktreeResult, got {other:?}"),
        };
        assert!(!rejected.ok, "outside path cleanup must be refused");
        assert!(outside_dir.is_dir(), "outside directory must remain untouched");

        // Cleanup the actual worktree cleanly.
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineWorktreeCleanup(MachineWorktreeCleanup {
                request_id: "wt-clean-ok".into(),
                task_id: "task-42".into(),
                workdir: wt_path.display().to_string(),
            }),
        )
        .await;
        let cleaned = match recv_frame(&mut ws).await {
            MachineWireFrame::MachineWorktreeResult(res) => res,
            other => panic!("expected MachineWorktreeResult, got {other:?}"),
        };
        assert!(cleaned.ok, "cleanup failed: {:?}", cleaned.error);
        assert!(!wt_path.exists(), "worktree should have been removed");

        cancel.cancel();
        agent_task.await.unwrap().unwrap();
    });
}

#[derive(Clone)]
struct MockControlPlane {
    state: Arc<Mutex<MockControlPlaneState>>,
    machine_token: &'static str,
    sandbox_token: &'static str,
}

#[derive(Default)]
struct MockControlPlaneState {
    http_requests: Vec<(String, String, Option<String>, Value)>,
    ws_hellos: Vec<(String, MachineHello)>,
}

async fn recv_axum_frame(ws: &mut WebSocket) -> Option<MachineWireFrame> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match ws.recv().await {
                Some(Ok(AxumWsMessage::Text(text))) => return serde_json::from_str::<MachineWireFrame>(text.as_str()).ok(),
                Some(Ok(AxumWsMessage::Ping(_) | AxumWsMessage::Pong(_))) => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
}

async fn handle_mock_ws(State(cp): State<MockControlPlane>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if auth == "Bearer vv_dev_forbidden_client_scope" {
        return (AxumStatusCode::FORBIDDEN, "forbidden scope").into_response();
    }
    ws.on_upgrade(move |mut socket| async move {
        let Some(MachineWireFrame::MachineHello(hello)) = recv_axum_frame(&mut socket).await else {
            return;
        };
        let _ = recv_axum_frame(&mut socket).await; // MachineInventory
        let ack = serde_json::to_string(&MachineWireFrame::MachineHelloAck(MachineHelloAck {
            machine_id: hello.machine_id.clone(),
            server_version: "0.2.0".into(),
            heartbeat_ms: 15_000,
        }))
        .unwrap();
        let _ = socket.send(AxumWsMessage::Text(ack.into())).await;
        cp.state.lock().ws_hellos.push((auth, hello));
        let _ = socket.send(AxumWsMessage::Close(None)).await;
    })
}

async fn handle_mock_http(State(cp): State<MockControlPlane>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let method_str = method.to_string();
    let path = uri.path().to_string();
    let body_json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(ToString::to_string);
    cp.state.lock().http_requests.push((method_str.clone(), path.clone(), auth, body_json.clone()));

    let (status, resp_body) = match (method_str.as_str(), path.as_str()) {
        ("POST", "/api/v1/machine/list") => (
            AxumStatusCode::OK,
            json!({
                "bizCode": 0,
                "message": "ok",
                "data": [
                    {
                        "id": "local",
                        "name": "Local Mac",
                        "platform": "macos",
                        "status": "online",
                        "here": true,
                        "ephemeral": false,
                        "worktreeSupported": true,
                        "joinedAt": 1700000000000i64,
                        "runtimes": [{
                            "id": "claude",
                            "label": "Claude Code",
                            "models": [],
                            "capabilities": ["listModels", "mcpServers"],
                            "available": true
                        }]
                    },
                    {
                        "id": "gpu-1",
                        "name": "GPU Box",
                        "platform": "linux",
                        "status": "online",
                        "here": false,
                        "ephemeral": false,
                        "worktreeSupported": true,
                        "joinedAt": 1700000000100i64,
                        "runtimes": [{
                            "id": "codex",
                            "label": "Codex",
                            "models": [],
                            "capabilities": ["listModels"],
                            "available": true
                        }]
                    }
                ]
            })
            .to_string(),
        ),
        ("POST", "/api/v1/remote/pair/exchange") => {
            let platform = body_json["platform"].as_str().unwrap_or("machine");
            let scope = body_json["scope"].as_str().unwrap_or("remote:runtime");
            let name = body_json["deviceName"].as_str().unwrap_or("machine");
            let (dev_id, token) = if platform == "sandbox" {
                ("dev_sbx_01", cp.sandbox_token)
            } else {
                ("dev_machine_01", cp.machine_token)
            };
            (
                AxumStatusCode::OK,
                json!({
                    "bizCode": 0,
                    "message": "ok",
                    "data": {
                        "device": {
                            "id": dev_id,
                            "name": name,
                            "platform": platform,
                            "scope": scope,
                            "createdAt": 1700000000000i64
                        },
                        "token": token,
                        "serverName": "Mock Control Plane",
                        "version": "0.2.0"
                    }
                })
                .to_string(),
            )
        }
        _ => (AxumStatusCode::NOT_FOUND, json!({ "bizCode": 40400, "message": "not found" }).to_string()),
    };

    (status, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], resp_body)
}

#[test]
fn cli_machine_list_and_machine_up_pair_exchange_persistence_and_ephemeral() {
    let state = Arc::new(Mutex::new(MockControlPlaneState::default()));
    let machine_token = "vv_dev_paired_machine_token_9876543210";
    let sandbox_token = "vv_dev_ephemeral_sbx_token_1122334455";
    let list_token = "vv_dev_cli_list_token_5566778899";

    let cp = MockControlPlane {
        state: state.clone(),
        machine_token,
        sandbox_token,
    };
    let app = Router::new()
        .route("/api/v1/machine/ws", get(handle_mock_ws))
        .fallback(handle_mock_http)
        .with_state(cp);
    let (server_url, _server_guard) = vibevalley_runtime::rt::block_on(async move {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
        });
        (format!("http://{addr}"), guard)
    });
    let home = tempfile::tempdir().unwrap();

    // 1. `vibevalley machine list --json` & compact table with Bearer auth.
    let (code, out, err) = cli_run(home.path(), &["--server", &server_url, "--token", list_token, "machine", "list", "--json"], &[]);
    assert_eq!(code, 0, "stderr: {err}");
    let listed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert_eq!(listed[0]["id"], "local");
    assert_eq!(listed[1]["id"], "gpu-1");

    let (code_txt, out_txt, err_txt) = cli_run(home.path(), &["--server", &server_url, "--token", list_token, "machine", "list"], &[]);
    assert_eq!(code_txt, 0, "stderr: {err_txt}");
    assert!(
        out_txt.contains("local") && out_txt.contains("gpu-1") && out_txt.contains("online"),
        "{out_txt}"
    );

    {
        let st = state.lock();
        let req = &st.http_requests[0];
        assert_eq!(req.0, "POST");
        assert_eq!(req.1, "/api/v1/machine/list");
        assert_eq!(req.2.as_deref(), Some(format!("Bearer {list_token}").as_str()));
    }

    // 2. `vibevalley machine up --server <url> --code ABC234 --name gpu-box --scripted --once`:
    //    exchanges with platform=machine, scope=remote:runtime, persists 0o600 machine-auth.json, ZERO token echo!
    let (code, out, err) = cli_run(
        home.path(),
        &[
            "machine",
            "up",
            "--server",
            &server_url,
            "--code",
            "ABC234",
            "--name",
            "gpu-box",
            "--scripted",
            "--once",
        ],
        &[],
    );
    assert_eq!(code, 0, "stdout={out}\nstderr={err}");
    assert!(!out.contains(machine_token) && !err.contains(machine_token), "raw token echoed!");

    let auth_file = home.path().join(MACHINE_AUTH_FILE);
    assert!(auth_file.is_file(), "machine-auth.json must be created for non-ephemeral machine");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&auth_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "machine-auth.json mode must be 0600, got {mode:o}");
    }
    let saved = load_machine_auth(home.path()).unwrap().unwrap();
    assert_eq!(saved.token.expose(), machine_token);
    assert_eq!(saved.machine_id, "dev_machine_01");
    assert_eq!(saved.machine_name, "gpu-box");

    {
        let st = state.lock();
        let ex = st.http_requests.iter().find(|r| r.1 == "/api/v1/remote/pair/exchange").unwrap();
        assert_eq!(ex.3["code"], "ABC234");
        assert_eq!(ex.3["platform"], "machine");
        assert_eq!(ex.3["scope"], "remote:runtime");
        assert_eq!(ex.3["deviceName"], "gpu-box");

        let (ws_auth, hello) = &st.ws_hellos[0];
        assert_eq!(ws_auth, &format!("Bearer {machine_token}"));
        assert_eq!(hello.machine_id, "dev_machine_01");
        assert!(!hello.ephemeral);
        assert!(hello.runtimes.iter().any(|r| r.id == "scripted" && r.available));
    }

    // 3. Re-running `vibevalley machine up --scripted --once` reuses saved `machine-auth.json`!
    let (code, out, err) = cli_run(home.path(), &["machine", "up", "--scripted", "--once"], &[]);
    assert_eq!(code, 0, "stdout={out}\nstderr={err}");
    assert_eq!(state.lock().ws_hellos.len(), 2);
    assert_eq!(state.lock().ws_hellos[1].0, format!("Bearer {machine_token}"));

    // 4. Ephemeral sandbox (`--ephemeral --code SBX999`): uses platform=sandbox, does NOT write machine-auth.json!
    let sbx_home = tempfile::tempdir().unwrap();
    let (code, out, err) = cli_run(
        sbx_home.path(),
        &[
            "machine",
            "up",
            "--server",
            &server_url,
            "--code",
            "SBX999",
            "--machine-id",
            "sbx-custom-9",
            "--ephemeral",
            "--scripted",
            "--once",
        ],
        &[],
    );
    assert_eq!(code, 0, "stdout={out}\nstderr={err}");
    assert!(!out.contains(sandbox_token) && !err.contains(sandbox_token), "sandbox token echoed!");
    assert!(
        !sbx_home.path().join(MACHINE_AUTH_FILE).exists(),
        "ephemeral machine must NOT persist machine-auth.json"
    );
    {
        let st = state.lock();
        let ex = st.http_requests.iter().rfind(|r| r.1 == "/api/v1/remote/pair/exchange").unwrap();
        assert_eq!(ex.3["code"], "SBX999");
        assert_eq!(ex.3["platform"], "sandbox");
        assert_eq!(ex.3["scope"], "remote:runtime");

        let (ws_auth, hello) = st.ws_hellos.last().unwrap();
        assert_eq!(ws_auth, &format!("Bearer {sandbox_token}"));
        assert_eq!(hello.machine_id, "sbx-custom-9");
        assert!(hello.ephemeral);
        assert_eq!(hello.platform, MachinePlatform::Container);
    }

    // 5. VIBEVALLEY_TOKEN env var works cleanly without `--token` or `--code`.
    let env_home = tempfile::tempdir().unwrap();
    let (code, _, err) = cli_run(
        env_home.path(),
        &["machine", "up", "--server", &server_url, "--scripted", "--once"],
        &[("VIBEVALLEY_TOKEN", "vv_dev_env_machine_token")],
    );
    assert_eq!(code, 0, "stderr={err}");
    assert_eq!(state.lock().ws_hellos.last().unwrap().0, "Bearer vv_dev_env_machine_token");

    // 6. CLI argument validation & HTTP 403 rejection.
    let (code, _, err) = cli_run(
        env_home.path(),
        &["machine", "up", "--server", &server_url, "--code", "AAA111", "--token", "tok"],
        &[],
    );
    assert_eq!(code, 2);
    assert!(err.contains("ConflictingOption"), "{err}");

    let (code, _, err) = cli_run(env_home.path(), &["machine", "up", "--server", &server_url, "--token", "tok", "--dry-run"], &[]);
    assert_eq!(code, 2);
    assert!(err.contains("NoDryRun"), "{err}");

    let (code, _, err) = cli_run(env_home.path(), &["machine", "up", "--scripted", "--once"], &[]);
    assert_eq!(code, 2);
    assert!(err.contains("MissingArgument"), "{err}");

    let (code, _, err) = cli_run(
        env_home.path(),
        &[
            "machine",
            "up",
            "--server",
            &server_url,
            "--token",
            "vv_dev_forbidden_client_scope",
            "--scripted",
            "--once",
        ],
        &[],
    );
    assert_eq!(code, 3);
    assert!(err.contains("Forbidden"), "{err}");
}

#[test]
fn local_mcp_proxy_status_codes_limits_and_cleanup() {
    vibevalley_runtime::rt::block_on(async {
        use tokio::sync::mpsc;
        use vibevalley_cli::machine_agent::TransportSlot;
        use vibevalley_cli::machine_agent::mcp_proxy::{LocalMcpProxy, PendingMcpMap, resolve_mcp_response};

        let transport = Arc::new(TransportSlot::new());
        let pending = Arc::new(PendingMcpMap::default());
        let cancel = CancellationToken::new();
        let proxy = LocalMcpProxy::start("sess-edge".into(), "default-tok".into(), transport.clone(), pending.clone(), cancel.clone())
            .await
            .unwrap();

        let base_url = proxy.url().trim_end_matches("/mcp").to_string();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        // 404 on unknown path, 405 on non-POST method, 413 on payload > 16 MiB.
        let r404 = client.post(format!("{base_url}/other")).body("{}").send().await.unwrap();
        assert_eq!(r404.status().as_u16(), 404);

        let r405 = client.get(proxy.url()).send().await.unwrap();
        assert_eq!(r405.status().as_u16(), 405);

        let oversize = vec![b'a'; 16 * 1024 * 1024 + 1];
        let r413 = client.post(proxy.url()).body(oversize).send().await.unwrap();
        assert_eq!(r413.status().as_u16(), 413);
        assert!(pending.lock().is_empty());

        // 503 with JSON-RPC error when machine WS transport is disconnected; pending map cleaned up.
        let r503 = client.post(proxy.url()).body("{}").send().await.unwrap();
        assert_eq!(r503.status().as_u16(), 503);
        assert!(
            r503.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json")),
            "expected application/json content-type on 503 disconnect"
        );
        assert!(r503.text().await.unwrap().contains("machine websocket disconnected"));
        assert!(pending.lock().is_empty());

        // Connect mock transport channel to exercise 200, 202, bearer fallback/override, 502, and shutdown 503.
        let (tx, mut rx) = mpsc::unbounded_channel::<MachineWireFrame>();
        transport.install(tx);

        // 1. Default session token fallback + query string preservation + 202 empty content-type fallback.
        let req_fut = client.post(format!("{}?v=1", proxy.url())).body(r#"{"jsonrpc":"2.0"}"#).send();
        let responder = async {
            let MachineWireFrame::MachineMcpRequest(req) = rx.recv().await.unwrap() else {
                panic!("expected MachineMcpRequest");
            };
            assert_eq!(req.session_id, "sess-edge");
            assert_eq!(req.session_token, "default-tok");
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/mcp?v=1");
            assert!(resolve_mcp_response(
                &pending,
                MachineMcpResponse {
                    request_id: req.request_id,
                    status: 202,
                    content_type: String::new(),
                    body: String::new(),
                },
            ));
        };
        let (resp202, ()) = tokio::join!(req_fut, responder);
        let resp202 = resp202.unwrap();
        assert_eq!(resp202.status().as_u16(), 202);
        assert_eq!(
            resp202.headers().get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/json; charset=utf-8")
        );
        assert!(pending.lock().is_empty());

        // 2. Bearer override + 200 OK.
        let req_fut = client
            .post(proxy.url())
            .header("authorization", "Bearer override-tok")
            .body(r#"{"id":1}"#)
            .send();
        let responder = async {
            let MachineWireFrame::MachineMcpRequest(req) = rx.recv().await.unwrap() else {
                panic!("expected MachineMcpRequest");
            };
            assert_eq!(req.session_token, "override-tok");
            assert!(resolve_mcp_response(
                &pending,
                MachineMcpResponse {
                    request_id: req.request_id,
                    status: 200,
                    content_type: "application/json".into(),
                    body: r#"{"ok":true}"#.into(),
                },
            ));
        };
        let (resp200, ()) = tokio::join!(req_fut, responder);
        let resp200 = resp200.unwrap();
        assert_eq!(resp200.status().as_u16(), 200);
        assert_eq!(resp200.text().await.unwrap(), r#"{"ok":true}"#);
        assert!(pending.lock().is_empty());

        // 3. 502 Bad Gateway when upstream drops the response sender without sending.
        let req_fut = client.post(proxy.url()).body("{}").send();
        let dropper = async {
            let MachineWireFrame::MachineMcpRequest(req) = rx.recv().await.unwrap() else {
                panic!("expected MachineMcpRequest");
            };
            let _dropped = pending.lock().remove(&req.request_id);
        };
        let (resp502, ()) = tokio::join!(req_fut, dropper);
        let resp502 = resp502.unwrap();
        assert_eq!(resp502.status().as_u16(), 502);
        assert_eq!(resp502.text().await.unwrap(), "upstream closed");
        assert!(pending.lock().is_empty());

        // 4. 503 when proxy shuts down while a request is in flight; pending map cleaned up.
        let req_fut = client.post(proxy.url()).body("{}").send();
        let canceller = async {
            let MachineWireFrame::MachineMcpRequest(_req) = rx.recv().await.unwrap() else {
                panic!("expected MachineMcpRequest");
            };
            proxy.shutdown();
        };
        let (resp_shutdown, ()) = tokio::join!(req_fut, canceller);
        let resp_shutdown = resp_shutdown.unwrap();
        assert_eq!(resp_shutdown.status().as_u16(), 503);
        assert_eq!(resp_shutdown.text().await.unwrap(), "proxy shutting down");
        assert!(pending.lock().is_empty());
    });
}
