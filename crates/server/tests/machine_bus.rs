//! End-to-end offline integration tests for Wave 3B:
//! - `/api/v1/machine/ws` Bearer auth (401) & `remote:runtime` scope enforcement (403 -> 101)
//! - `MachineHello` / `MachineInventory` -> `machine.list` & `SessionsSlice.machines`, ephemeral `MachineRemoved`
//! - PR-first issue dispatch skipping local git worktree creation and forwarding `repo_ref`/`branch`/`base_ref`
//! - Disconnect-resilient remote sessions with `input_id` propagation & lossless `MachineSessionAttach { after_seq }` replay
//! - `MachineMcpRequest` -> `MachineMcpResponse` reverse tunnel & `MachineAttachmentFetch` -> `MachineAttachmentData`
//! - `Hub::on_system_wake()` waking subscribers and pinging connected machines

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use vibevalley_protocol::{
    BizCode, Caller, LOCAL_MACHINE_ID, MachineAttachmentFetch, MachineHello, MachineInputKind, MachineInventory, MachineMcpRequest, MachinePlatform,
    MachineRuntimeSummary, MachineSessionAck, MachineSessionEvent, MachineSessionOpened, MachineStatus, MachineWireFrame, SCOPE_REMOTE_CLIENT,
    SCOPE_REMOTE_MACHINE,
};
use vibevalley_runtime::machine::RuntimeRef as RtRuntimeRef;
use vibevalley_runtime::oar::{ContentBlock, Event, EventKind, SessionOptions, StopReason, Usage};
use vibevalley_server::transport::http::serve;

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn start_server(dir: &std::path::Path) -> vibevalley_server::Started {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    vibevalley_server::start(vibevalley_server::ServerConfig {
        version: "3.0.0-machine-test".into(),
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        debug_enabled: false,
        ..vibevalley_server::ServerConfig::under(dir)
    })
    .unwrap()
}

fn http_client() -> reqwest::blocking::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap()
}

fn enable_remote(started: &vibevalley_server::Started) -> String {
    let enabled = started
        .hub
        .call_as(Caller::User, "remote.enable", json!({ "bindAddr": "127.0.0.1", "port": 0 }));
    assert_eq!(enabled.biz_code, 0, "{}", enabled.message);
    enabled.data.unwrap()["url"].as_str().unwrap().to_string()
}

fn pair_device(started: &vibevalley_server::Started, remote_url: &str, platform: &str, name: &str, scope: Option<&str>) -> String {
    let code = started.test_internals().remote.pair_create_with_scope(scope).unwrap().code;
    let res = http_client()
        .post(format!("{remote_url}/api/v1/remote/pair/exchange"))
        .json(&json!({ "code": code, "deviceName": name, "platform": platform }))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let body: Value = res.json().unwrap();
    assert_eq!(body["bizCode"], 0, "{body}");
    body["data"]["token"].as_str().unwrap().to_string()
}

fn ws_url(http_base: &str, query: Option<&str>) -> String {
    let base = http_base.replacen("http://", "ws://", 1);
    match query {
        Some(q) => format!("{base}/api/v1/machine/ws?{q}"),
        None => format!("{base}/api/v1/machine/ws"),
    }
}

async fn connect_ws(url: &str, bearer: Option<&str>) -> Result<WsStream, u16> {
    let mut req = url.into_client_request().unwrap();
    if let Some(token) = bearer {
        req.headers_mut().insert(AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
    }
    match tokio_tungstenite::connect_async(req).await {
        Ok((ws, resp)) => {
            assert_eq!(resp.status().as_u16(), 101);
            Ok(ws)
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => Err(resp.status().as_u16()),
        Err(err) => panic!("unexpected ws error for {url}: {err}"),
    }
}

async fn send_frame(ws: &mut WsStream, frame: &MachineWireFrame) {
    let raw = serde_json::to_string(frame).unwrap();
    ws.send(Message::Text(raw.into())).await.unwrap();
}

async fn recv_frame(ws: &mut WsStream) -> MachineWireFrame {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next())
            .await
            .expect("timed out waiting for WS frame")
            .expect("WS stream closed unexpectedly")
            .expect("WS read error");
        match msg {
            Message::Text(text) => return serde_json::from_str(&text).expect("valid MachineWireFrame"),
            Message::Ping(payload) => {
                let _ = ws.send(Message::Pong(payload)).await;
            }
            Message::Pong(_) => continue,
            other => panic!("unexpected WS message: {other:?}"),
        }
    }
}

fn runtime_summary(id: &str, label: &str) -> MachineRuntimeSummary {
    MachineRuntimeSummary {
        id: id.into(),
        label: label.into(),
        models: vec![],
        capabilities: vec![],
        available: true,
    }
}

#[test]
fn machine_ws_enforces_bearer_auth_and_machine_scope_on_loopback_and_remote() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let local_listener = serve(started.hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let remote_url = enable_remote(&started);

    let client_token = pair_device(&started, &remote_url, "ios", "Client iPhone", Some(SCOPE_REMOTE_CLIENT));
    let machine_token = pair_device(&started, &remote_url, "machine", "Linux Runner", Some(SCOPE_REMOTE_MACHINE));

    vibevalley_runtime::rt::block_on(async {
        for base in [local_listener.url(), remote_url.clone()] {
            // Unauthenticated -> 401
            assert_eq!(connect_ws(&ws_url(&base, None), None).await.unwrap_err(), 401, "{base} unauth");
            // Invalid Bearer -> 401
            assert_eq!(
                connect_ws(&ws_url(&base, None), Some("vv_dev_invalid")).await.unwrap_err(),
                401,
                "{base} invalid bearer"
            );
            // Invalid query token -> 401
            assert_eq!(
                connect_ws(&ws_url(&base, Some("token=vv_dev_invalid")), None).await.unwrap_err(),
                401,
                "{base} invalid query"
            );
            // Client scope (`remote:default`) -> 403
            assert_eq!(
                connect_ws(&ws_url(&base, None), Some(&client_token)).await.unwrap_err(),
                403,
                "{base} client scope bearer"
            );
            assert_eq!(
                connect_ws(&ws_url(&base, Some(&format!("token={client_token}"))), None).await.unwrap_err(),
                403,
                "{base} client scope query"
            );
            // Machine scope (`remote:runtime`) -> 101 upgrade via Bearer AND via ?token=
            let mut ws_header = connect_ws(&ws_url(&base, None), Some(&machine_token)).await.expect("bearer upgrade");
            let _ = ws_header.close(None).await;

            let mut ws_query = connect_ws(&ws_url(&base, Some(&format!("token={machine_token}"))), None)
                .await
                .expect("query token upgrade");
            let _ = ws_query.close(None).await;
        }
    });

    // Plain HTTP probe without WS upgrade header still returns 401 / 403 with protocol BizCode before upgrade rejection.
    let client = http_client();
    let unauth_resp = client.get(format!("{remote_url}/api/v1/machine/ws")).send().unwrap();
    assert_eq!(unauth_resp.status().as_u16(), 401);
    assert_eq!(unauth_resp.json::<Value>().unwrap()["bizCode"], BizCode::Unauthorized.code());

    let wrong_scope_resp = client
        .get(format!("{remote_url}/api/v1/machine/ws"))
        .header("authorization", format!("Bearer {client_token}"))
        .send()
        .unwrap();
    assert_eq!(wrong_scope_resp.status().as_u16(), 403);
    assert_eq!(wrong_scope_resp.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());

    drop(local_listener);
    started.close();
}

#[test]
fn machine_hello_inventory_and_ephemeral_sandbox_disconnect_project_into_slices() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let remote_url = enable_remote(&started);
    let machine_token = pair_device(&started, &remote_url, "machine", "Fleet Runner", Some(SCOPE_REMOTE_MACHINE));

    // Local machine is always present immediately at boot.
    let initial = started.hub.call_as(Caller::User, "machine.list", json!({}));
    assert_eq!(initial.biz_code, 0, "{}", initial.message);
    let list: Vec<vibevalley_protocol::MachineInfo> = serde_json::from_value(initial.data.unwrap()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, LOCAL_MACHINE_ID);
    assert!(list[0].here);
    assert_eq!(list[0].status, MachineStatus::Online);
    assert!(started.hub.sessions_slice().machines.iter().any(|m| m.id == LOCAL_MACHINE_ID && m.here));

    vibevalley_runtime::rt::block_on(async {
        // 1. Connect persistent remote machine `gpu-1`.
        let mut gpu_ws = connect_ws(&ws_url(&remote_url, None), Some(&machine_token)).await.unwrap();
        send_frame(
            &mut gpu_ws,
            &MachineWireFrame::MachineHello(MachineHello {
                machine_id: "gpu-1".into(),
                name: "GPU Devbox".into(),
                platform: MachinePlatform::Linux,
                ephemeral: false,
                worktree_supported: true,
                runtimes: vec![runtime_summary("claude", "Claude Code")],
            }),
        )
        .await;
        match recv_frame(&mut gpu_ws).await {
            MachineWireFrame::MachineHelloAck(ack) => {
                assert_eq!(ack.machine_id, "gpu-1");
                assert_eq!(ack.server_version, "3.0.0-machine-test");
                assert!(ack.heartbeat_ms > 0);
            }
            other => panic!("expected helloAck, got {other:?}"),
        }

        // Send updated inventory adding `codex`.
        send_frame(
            &mut gpu_ws,
            &MachineWireFrame::MachineInventory(MachineInventory {
                machine_id: "gpu-1".into(),
                runtimes: vec![runtime_summary("claude", "Claude Code"), runtime_summary("codex", "Codex")],
            }),
        )
        .await;

        crate::support::wait_until_transition_async(&started.hub, Duration::from_secs(3), "gpu-1 inventory updated", || {
            started
                .hub
                .sessions_slice()
                .machines
                .iter()
                .any(|m| m.id == "gpu-1" && m.online && m.runtimes == vec!["claude", "codex"])
                .then_some(())
        })
        .await;

        let listed: Vec<vibevalley_protocol::MachineInfo> =
            serde_json::from_value(started.hub.call_as(Caller::User, "machine.list", json!({})).data.unwrap()).unwrap();
        let gpu = listed.iter().find(|m| m.id == "gpu-1").expect("gpu-1 in machine.list");
        assert_eq!(gpu.status, MachineStatus::Online);
        assert_eq!(gpu.runtimes.len(), 2);
        assert!(!gpu.ephemeral);
        assert!(gpu.worktree_supported);

        // 2. Connect ephemeral sandbox `sbx-9`.
        let mut sbx_ws = connect_ws(&ws_url(&remote_url, None), Some(&machine_token)).await.unwrap();
        send_frame(
            &mut sbx_ws,
            &MachineWireFrame::MachineHello(MachineHello {
                machine_id: "sbx-9".into(),
                name: "CI Sandbox #9".into(),
                platform: MachinePlatform::Container,
                ephemeral: true,
                worktree_supported: true,
                runtimes: vec![runtime_summary("scripted", "Scripted")],
            }),
        )
        .await;
        assert!(matches!(recv_frame(&mut sbx_ws).await, MachineWireFrame::MachineHelloAck(_)));

        crate::support::wait_until_transition_async(&started.hub, Duration::from_secs(3), "sbx-9 online", || {
            started
                .hub
                .sessions_slice()
                .machines
                .iter()
                .any(|m| m.id == "sbx-9" && m.ephemeral && m.online)
                .then_some(())
        })
        .await;

        // 3. Disconnect ephemeral sandbox -> emitted `MachineRemoved` drops it completely.
        let _ = sbx_ws.close(None).await;
        drop(sbx_ws);
        crate::support::wait_until_transition_async(&started.hub, Duration::from_secs(3), "sbx-9 removed", || {
            (!started.hub.sessions_slice().machines.iter().any(|m| m.id == "sbx-9")).then_some(())
        })
        .await;
        let after_sbx: Vec<vibevalley_protocol::MachineInfo> =
            serde_json::from_value(started.hub.call_as(Caller::User, "machine.list", json!({})).data.unwrap()).unwrap();
        assert!(!after_sbx.iter().any(|m| m.id == "sbx-9"));

        // 4. Disconnect persistent `gpu-1` -> stays listed with `Offline`.
        let _ = gpu_ws.close(None).await;
        drop(gpu_ws);
        crate::support::wait_until_transition_async(&started.hub, Duration::from_secs(3), "gpu-1 offline", || {
            started
                .hub
                .sessions_slice()
                .machines
                .iter()
                .any(|m| m.id == "gpu-1" && !m.online && m.status == Some(MachineStatus::Offline))
                .then_some(())
        })
        .await;
    });

    started.close();
}

#[test]
fn remote_session_disconnect_reconnect_replays_losslessly_and_skips_local_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let remote_url = enable_remote(&started);
    let machine_token = pair_device(&started, &remote_url, "machine", "GPU Worker", Some(SCOPE_REMOTE_MACHINE));

    // Create a local repo with an `origin` remote URL so PR-first dispatch resolves `repo_ref`.
    let repo_created = started.hub.call_as(Caller::User, "repo.create", json!({ "name": "demo" }));
    assert_eq!(repo_created.biz_code, 0, "{}", repo_created.message);
    let repo_path = dir.path().join("repos/demo");
    let git_status = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["remote", "add", "origin", "https://github.com/botiverse/demo.git"])
        .status()
        .unwrap();
    assert!(git_status.success());

    // Create an agent profile that targets remote runtime `"claude"` (not installed locally).
    let mut profile = started.test_internals().agents.profiles.install_template("reviewer").unwrap();
    profile.runtime = "claude".into();
    profile.name = "Remote Builder".into();
    let profile = started.test_internals().agents.profiles.save(profile).unwrap();

    // Connect remote machine `gpu-dev` advertising `"claude"`.
    let mut ws = vibevalley_runtime::rt::block_on(async {
        let mut ws = connect_ws(&ws_url(&remote_url, None), Some(&machine_token)).await.unwrap();
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineHello(MachineHello {
                machine_id: "gpu-dev".into(),
                name: "GPU Dev".into(),
                platform: MachinePlatform::Linux,
                ephemeral: false,
                worktree_supported: true,
                runtimes: vec![runtime_summary("claude", "Claude Code")],
            }),
        )
        .await;
        assert!(matches!(recv_frame(&mut ws).await, MachineWireFrame::MachineHelloAck(_)));
        ws
    });

    // Create an issue pinned to `machineId: "gpu-dev"` and dispatch it via `issue.status.update`.
    let created = started.hub.call_as(
        Caller::User,
        "issue.create",
        json!({
            "title": "Build remote feature",
            "repo": "demo",
            "agent": profile.id,
            "machineId": "gpu-dev"
        }),
    );
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let issue_id = created.data.as_ref().unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(created.data.as_ref().unwrap()["machineId"], "gpu-dev");

    // Dispatch on a background thread since `issue.status.update` waits for `session.opened` + `session.ack`.
    let hub_dispatch = started.hub.clone();
    let issue_id_for_dispatch = issue_id.clone();
    let dispatch_handle =
        std::thread::spawn(move || hub_dispatch.call_as(Caller::User, "issue.status.update", json!({ "id": issue_id_for_dispatch, "status": "todo" })));

    // Drive the remote WS side of `session.open`, `session.input`, partial events, DROP, RECONNECT, and lossless replay!
    let (session_id, mcp_token) = vibevalley_runtime::rt::block_on(async {
        // 1. Expect `MachineSessionOpen` with PR-first dispatch metadata.
        let open = match recv_frame(&mut ws).await {
            MachineWireFrame::MachineSessionOpen(open) => open,
            other => panic!("expected session.open, got {other:?}"),
        };
        assert_eq!(open.runtime_id, "claude");
        assert_eq!(open.repo_ref.as_deref(), Some("https://github.com/botiverse/demo.git"));
        assert_eq!(open.branch.as_deref(), Some("vibevalley/issue-1"));
        assert_eq!(open.base_ref.as_deref(), Some("main"));
        let mcp_token = open.mcp_session_token.clone().expect("remote session must receive mcp_session_token");
        assert!(!mcp_token.is_empty());

        send_frame(
            &mut ws,
            &MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                request_id: open.request_id,
                session_id: open.session_id.clone(),
                ok: true,
                workdir: Some("/remote/worktrees/demo.1".into()),
                error: None,
            }),
        )
        .await;

        // 2. Expect `MachineSessionInput` with deterministic `input_id` (`work:...`).
        let input = match recv_frame(&mut ws).await {
            MachineWireFrame::MachineSessionInput(inp) => inp,
            other => panic!("expected session.input, got {other:?}"),
        };
        assert_eq!(input.session_id, open.session_id);
        assert_eq!(input.kind, MachineInputKind::Prompt);
        assert!(input.input_id.starts_with("work:"), "expected work:<run> input_id, got {}", input.input_id);

        send_frame(
            &mut ws,
            &MachineWireFrame::MachineSessionAck(MachineSessionAck {
                request_id: input.request_id,
                session_id: input.session_id,
                input_id: input.input_id,
                ok: true,
                error: None,
            }),
        )
        .await;

        // 3. Stream events seq 1 & 2 before simulating an abrupt WS disconnect.
        let ev1 = Event {
            seq: 1,
            agent_path: vec![],
            at_ms: 1001,
            kind: EventKind::TurnStarted { prompt: "go".into() },
        };
        let ev2 = Event {
            seq: 2,
            agent_path: vec![],
            at_ms: 1002,
            kind: EventKind::TextDelta { text: "alpha-".into() },
        };
        for ev in [&ev1, &ev2] {
            send_frame(
                &mut ws,
                &MachineWireFrame::MachineSessionEvent(MachineSessionEvent {
                    session_id: open.session_id.clone(),
                    seq: ev.seq,
                    at: ev.at_ms as i64,
                    event_json: serde_json::to_string(ev).unwrap(),
                    terminal: false,
                }),
            )
            .await;
        }
        // Small sync via ping/pong so the server processes seq 1 & 2 before we drop the socket.
        send_frame(&mut ws, &MachineWireFrame::MachinePing(vibevalley_protocol::MachinePing { ts: 42 })).await;
        assert!(matches!(recv_frame(&mut ws).await, MachineWireFrame::MachinePong(_)));

        // 4. DROP WS connection while session is mid-turn!
        let _ = ws.close(None).await;
        drop(ws);

        (open.session_id, mcp_token)
    });

    // Confirm dispatch succeeded AND ZERO local git worktree was created!
    let dispatch_env = dispatch_handle.join().unwrap();
    assert_eq!(dispatch_env.biz_code, 0, "{}", dispatch_env.message);
    let local_worktrees: Vec<_> = std::fs::read_dir(dir.path().join("worktrees")).unwrap().flatten().collect();
    assert!(
        local_worktrees.is_empty(),
        "remote dispatch must skip local worktree creation: {local_worktrees:?}"
    );

    // Confirm machine transitioned to Offline while session stayed alive.
    crate::support::wait_until_transition(&started.hub, Duration::from_secs(3), "gpu-dev offline", || {
        started
            .hub
            .sessions_slice()
            .machines
            .iter()
            .any(|m| m.id == "gpu-dev" && !m.online)
            .then_some(())
    });
    assert!(started.test_internals().board.sessions().is_live(&session_id));
    assert_eq!(started.test_internals().board.session(&session_id).unwrap().machine.as_deref(), Some("gpu-dev"));

    // 5. RECONNECT with the same `machine_id = "gpu-dev"` -> expect `MachineSessionAttach { after_seq: 2 }`!
    vibevalley_runtime::rt::block_on(async {
        let mut ws2 = connect_ws(&ws_url(&remote_url, None), Some(&machine_token)).await.unwrap();
        send_frame(
            &mut ws2,
            &MachineWireFrame::MachineHello(MachineHello {
                machine_id: "gpu-dev".into(),
                name: "GPU Dev".into(),
                platform: MachinePlatform::Linux,
                ephemeral: false,
                worktree_supported: true,
                runtimes: vec![runtime_summary("claude", "Claude Code")],
            }),
        )
        .await;
        assert!(matches!(recv_frame(&mut ws2).await, MachineWireFrame::MachineHelloAck(_)));

        let attach = match recv_frame(&mut ws2).await {
            MachineWireFrame::MachineSessionAttach(att) => att,
            other => panic!("expected session.attach on reconnect, got {other:?}"),
        };
        assert_eq!(attach.session_id, session_id);
        assert_eq!(attach.after_seq, 2);

        // Replay duplicate seq 2 (must be deduplicated!) + missed seq 3 & 4.
        let replay = [
            Event {
                seq: 2,
                agent_path: vec![],
                at_ms: 1002,
                kind: EventKind::TextDelta { text: "alpha-".into() },
            },
            Event {
                seq: 3,
                agent_path: vec![],
                at_ms: 1003,
                kind: EventKind::TextDelta { text: "omega".into() },
            },
            Event {
                seq: 4,
                agent_path: vec![],
                at_ms: 1004,
                kind: EventKind::TurnFinished {
                    reason: StopReason::Completed,
                    usage: Usage::default(),
                },
            },
        ];
        for ev in &replay {
            send_frame(
                &mut ws2,
                &MachineWireFrame::MachineSessionEvent(MachineSessionEvent {
                    session_id: session_id.clone(),
                    seq: ev.seq,
                    at: ev.at_ms as i64,
                    event_json: serde_json::to_string(ev).unwrap(),
                    terminal: false,
                }),
            )
            .await;
        }

        // Also verify reverse MCP tunnel on this reconnected WS using the session's minted token!
        send_frame(
            &mut ws2,
            &MachineWireFrame::MachineMcpRequest(MachineMcpRequest {
                request_id: "mcp-1".into(),
                session_id: session_id.clone(),
                session_token: mcp_token.clone(),
                method: "POST".into(),
                path: "/mcp".into(),
                body: json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }).to_string(),
            }),
        )
        .await;
        match recv_frame(&mut ws2).await {
            MachineWireFrame::MachineMcpResponse(resp) => {
                assert_eq!(resp.request_id, "mcp-1");
                assert_eq!(resp.status, 200);
                let parsed: Value = serde_json::from_str(&resp.body).unwrap();
                assert_eq!(parsed["id"], 7);
                assert!(parsed["result"]["tools"].is_array(), "{parsed}");
            }
            other => panic!("expected mcp.response, got {other:?}"),
        }

        // Security guard: `vv_dev_` device tokens must be refused (403) on MCP tunnel.
        send_frame(
            &mut ws2,
            &MachineWireFrame::MachineMcpRequest(MachineMcpRequest {
                request_id: "mcp-bad".into(),
                session_id: session_id.clone(),
                session_token: machine_token.clone(),
                method: "POST".into(),
                path: "/mcp".into(),
                body: json!({ "jsonrpc": "2.0", "id": 8, "method": "initialize" }).to_string(),
            }),
        )
        .await;
        match recv_frame(&mut ws2).await {
            MachineWireFrame::MachineMcpResponse(resp) => {
                assert_eq!(resp.request_id, "mcp-bad");
                assert_eq!(resp.status, 403);
            }
            other => panic!("expected 403 mcp.response, got {other:?}"),
        }

        let _ = ws2.close(None).await;
    });

    // Wait for TurnFinished to settle the issue into InReview and verify NO duplicate `alpha-`!
    crate::support::wait_until_transition(&started.hub, Duration::from_secs(3), "issue InReview", || {
        started
            .test_internals()
            .board
            .issue(&issue_id)
            .is_some_and(|i| i.status == vibevalley_protocol::IssueStatus::InReview)
            .then_some(())
    });
    let session = started.test_internals().board.session(&session_id).unwrap();
    let summary = session.last_run.as_ref().map(|r| r.summary.as_str()).unwrap_or("");
    assert_eq!(summary, "alpha-omega", "duplicate seq 2 must not be replayed into output");

    // Verify `MachineSessionInput` idempotent `input_id` propagation directly via `MachineRegistry::resolve`.
    let mut ws3 = vibevalley_runtime::rt::block_on(async {
        let mut ws = connect_ws(&ws_url(&remote_url, None), Some(&machine_token)).await.unwrap();
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineHello(MachineHello {
                machine_id: "gpu-ctrl".into(),
                name: "GPU Control".into(),
                platform: MachinePlatform::Linux,
                ephemeral: true,
                worktree_supported: false,
                runtimes: vec![runtime_summary("codex", "Codex")],
            }),
        )
        .await;
        assert!(matches!(recv_frame(&mut ws).await, MachineWireFrame::MachineHelloAck(_)));
        ws
    });
    crate::support::wait_until_transition(&started.hub, Duration::from_secs(2), "gpu-ctrl registered", || {
        started.test_internals().machines.registry().get("gpu-ctrl").map(|_| ())
    });
    let (_, rt) = started
        .test_internals()
        .machines
        .registry()
        .resolve(&RtRuntimeRef::new("gpu-ctrl", "codex"))
        .expect("resolve gpu-ctrl/codex");

    let rt_thread = std::thread::spawn(move || {
        let sess = rt.open(SessionOptions::default()).unwrap();
        sess.steer(vec![ContentBlock::Text("focus tests".into())]).unwrap();
        sess.queue(vec![ContentBlock::Text("then lint".into())]).unwrap();
        sess.set_config(Some("o3"), Some("high"), None).unwrap();
        sess.abort().unwrap();
        sess.dispose();
    });

    vibevalley_runtime::rt::block_on(async {
        let open = match recv_frame(&mut ws3).await {
            MachineWireFrame::MachineSessionOpen(o) => o,
            other => panic!("expected open, got {other:?}"),
        };
        send_frame(
            &mut ws3,
            &MachineWireFrame::MachineSessionOpened(MachineSessionOpened {
                request_id: open.request_id,
                session_id: open.session_id,
                ok: true,
                workdir: None,
                error: None,
            }),
        )
        .await;

        let expected = [
            MachineInputKind::Steer,
            MachineInputKind::Queue,
            MachineInputKind::SetConfig,
            MachineInputKind::Abort,
            MachineInputKind::Dispose,
        ];
        for kind in expected {
            let inp = match recv_frame(&mut ws3).await {
                MachineWireFrame::MachineSessionInput(i) => i,
                other => panic!("expected {kind:?}, got {other:?}"),
            };
            assert_eq!(inp.kind, kind);
            assert!(!inp.input_id.is_empty(), "{kind:?} must carry input_id");
            if kind == MachineInputKind::SetConfig {
                assert_eq!(inp.model.as_deref(), Some("o3"));
                assert_eq!(inp.effort.as_deref(), Some("high"));
            }
            if kind != MachineInputKind::Dispose {
                send_frame(
                    &mut ws3,
                    &MachineWireFrame::MachineSessionAck(MachineSessionAck {
                        request_id: inp.request_id,
                        session_id: inp.session_id,
                        input_id: inp.input_id,
                        ok: true,
                        error: None,
                    }),
                )
                .await;
            }
        }
        let _ = ws3.close(None).await;
    });
    rt_thread.join().unwrap();

    started.close();
}

#[test]
fn machine_attachment_fetch_and_system_wake_hook_work_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let started = start_server(dir.path());
    let remote_url = enable_remote(&started);
    let machine_token = pair_device(&started, &remote_url, "machine", "Attach Runner", Some(SCOPE_REMOTE_MACHINE));

    let payload = b"remote-machine-attachment-bytes";
    let created = started.hub.call_as(
        Caller::User,
        "attachment.create",
        json!({
            "name": "spec.txt",
            "type": "text/plain",
            "data": base64::engine::general_purpose::STANDARD.encode(payload),
        }),
    );
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let att_id = created.data.unwrap()["id"].as_str().unwrap().to_string();

    let mut wake_a = started.hub.subscribe_wake();
    let mut wake_b = started.hub.subscribe_wake();
    assert_eq!(started.hub.wake_count(), 0);

    vibevalley_runtime::rt::block_on(async {
        let mut ws = connect_ws(&ws_url(&remote_url, None), Some(&machine_token)).await.unwrap();
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineHello(MachineHello {
                machine_id: "wake-box".into(),
                name: "Wake Box".into(),
                platform: MachinePlatform::Macos,
                ephemeral: true,
                worktree_supported: false,
                runtimes: vec![],
            }),
        )
        .await;
        assert!(matches!(recv_frame(&mut ws).await, MachineWireFrame::MachineHelloAck(_)));

        // Attachment fetch hit
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineAttachmentFetch(MachineAttachmentFetch {
                request_id: "att-1".into(),
                attachment_id: att_id,
            }),
        )
        .await;
        match recv_frame(&mut ws).await {
            MachineWireFrame::MachineAttachmentData(data) => {
                assert_eq!(data.request_id, "att-1");
                assert!(data.ok);
                assert_eq!(data.mime.as_deref(), Some("text/plain"));
                let decoded = base64::engine::general_purpose::STANDARD.decode(data.bytes_b64.as_deref().unwrap()).unwrap();
                assert_eq!(decoded, payload);
            }
            other => panic!("expected attachment.data, got {other:?}"),
        }

        // Attachment fetch miss
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineAttachmentFetch(MachineAttachmentFetch {
                request_id: "att-miss".into(),
                attachment_id: "does-not-exist".into(),
            }),
        )
        .await;
        match recv_frame(&mut ws).await {
            MachineWireFrame::MachineAttachmentData(data) => {
                assert_eq!(data.request_id, "att-miss");
                assert!(!data.ok);
                assert!(data.error.is_some());
            }
            other => panic!("expected attachment.data error, got {other:?}"),
        }

        // Trigger `Hub::on_system_wake()` -> both subscribers wake AND connected machine gets an immediate MachinePing!
        started.hub.on_system_wake();
        assert_eq!(started.hub.wake_count(), 1);
        tokio::time::timeout(Duration::from_secs(2), wake_a.changed()).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(2), wake_b.changed()).await.unwrap().unwrap();
        assert_eq!(*wake_a.borrow_and_update(), 1);
        assert_eq!(*wake_b.borrow_and_update(), 1);

        match recv_frame(&mut ws).await {
            MachineWireFrame::MachinePing(ping) => assert!(ping.ts > 0),
            other => panic!("expected MachinePing on system wake, got {other:?}"),
        }

        started.hub.on_system_wake();
        tokio::time::timeout(Duration::from_secs(2), wake_a.changed()).await.unwrap().unwrap();
        assert_eq!(*wake_a.borrow_and_update(), 2);

        let _ = ws.close(None).await;
    });

    // Verify invalid `machine_id == "local"` is rejected with MachineWireError.
    vibevalley_runtime::rt::block_on(async {
        let mut ws = connect_ws(&ws_url(&remote_url, None), Some(&machine_token)).await.unwrap();
        send_frame(
            &mut ws,
            &MachineWireFrame::MachineHello(MachineHello {
                machine_id: LOCAL_MACHINE_ID.into(),
                name: "Spoof".into(),
                platform: MachinePlatform::Linux,
                ephemeral: false,
                worktree_supported: false,
                runtimes: vec![],
            }),
        )
        .await;
        match recv_frame(&mut ws).await {
            MachineWireFrame::MachineWireError(err) => assert_eq!(err.code, "invalid_machine_id"),
            other => panic!("expected invalid_machine_id error, got {other:?}"),
        }
        let _ = ws.close(None).await;
    });

    // Clean shutdown with zero Arc cycles.
    let weak_hub = Arc::downgrade(&started.hub);
    started.close();
    drop(started);
    assert_eq!(weak_hub.strong_count(), 0, "Hub must drop cleanly after Started::close");
}
