use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as ClientWsMsg;
use vibevalley_protocol::home::{debug_json_path, read_debug_endpoint};
use vibevalley_protocol::{
    HostVdpCallPayload, VDP_PROTOCOL_VERSION, VdpCommand, VdpError, VdpLogEntriesResult, VdpLogEntry, VdpLogLevel, VdpNotification, VdpPageFrameEvent,
    VdpRequest, VdpTarget, VdpTargetAttachParams, VdpTargetAttachResult, VdpTargetDetachParams, VdpTargetKind, VdpTargetListResult, VdpUiBounds,
    VdpUiInspectAtResult, VdpVersionInfo, VdpWireMessage,
};

use super::executor::{hit_from_hosted_node, select_deepest_hit};
use super::parse_debug_port_from;
use super::vdp::{BoxFuture, VdpDispatcher, VdpServer, call_remote_vdp, resolve_loopback_ws_url, resolve_ui_response, ui_requests};

#[derive(Default)]
struct MockDispatcher {
    route: Mutex<String>,
    dark: AtomicBool,
    ui_log_enabled: AtomicBool,
}

impl MockDispatcher {
    fn new() -> Self {
        Self {
            route: Mutex::new("/issues".into()),
            dark: AtomicBool::new(false),
            ui_log_enabled: AtomicBool::new(false),
        }
    }
}

impl VdpDispatcher for MockDispatcher {
    fn list_targets(&self, attached: HashSet<String>) -> BoxFuture<'_, Result<Vec<VdpTarget>, VdpError>> {
        let route = self.route.lock().clone();
        Box::pin(async move {
            Ok(vec![
                VdpTarget {
                    id: "shell".into(),
                    kind: VdpTargetKind::Shell,
                    title: "VibeValley Shell".into(),
                    url: Some(route.clone()),
                    attached: attached.contains("shell"),
                },
                VdpTarget {
                    id: "view:workbench".into(),
                    kind: VdpTargetKind::View,
                    title: "Workbench".into(),
                    url: Some(route),
                    attached: attached.contains("view:workbench"),
                },
                VdpTarget {
                    id: "server".into(),
                    kind: VdpTargetKind::Server,
                    title: "Embedded Server".into(),
                    url: Some("http://127.0.0.1:8790".into()),
                    attached: attached.contains("server"),
                },
            ])
        })
    }

    fn dispatch(&self, command: VdpCommand, _attached_target: Option<String>) -> BoxFuture<'_, Result<Value, VdpError>> {
        Box::pin(async move {
            match command {
                VdpCommand::ShellGetState => Ok(json!({
                    "loaded": true,
                    "route": self.route.lock().clone(),
                    "theme_dark": self.dark.load(Ordering::Relaxed),
                })),
                VdpCommand::ShellNavigate(params) => {
                    *self.route.lock() = params.route;
                    Ok(json!({ "ok": true }))
                }
                VdpCommand::ShellSetTheme(params) => {
                    let next = params.dark.unwrap_or_else(|| !self.dark.load(Ordering::Relaxed));
                    self.dark.store(next, Ordering::Relaxed);
                    Ok(json!({ "ok": true, "themeDark": next }))
                }
                other => Err(VdpError::method_not_found(other.method())),
            }
        })
    }

    fn set_ui_log_enabled(&self, enabled: bool) -> BoxFuture<'_, ()> {
        self.ui_log_enabled.store(enabled, Ordering::Relaxed);
        Box::pin(async {})
    }
}

#[test]
fn debug_port_parser_handles_cli_flag_env_and_disabled_default() {
    assert_eq!(parse_debug_port_from(Vec::<String>::new(), None), None);
    assert_eq!(parse_debug_port_from(Vec::<String>::new(), Some("")), None);
    assert_eq!(parse_debug_port_from(Vec::<String>::new(), Some("invalid")), None);
    assert_eq!(parse_debug_port_from(Vec::<String>::new(), Some("0")), Some(0));
    assert_eq!(parse_debug_port_from(Vec::<String>::new(), Some("9222")), Some(9222));
    assert_eq!(parse_debug_port_from(["--remote-debugging-port=9333"], Some("9222")), Some(9333));
    assert_eq!(parse_debug_port_from(["--foo", "--remote-debugging-port", "0"], Some("9222")), Some(0));
    assert_eq!(parse_debug_port_from(["--remote-debugging-port=nope"], Some("9222")), None);
}

#[test]
fn inspector_hit_selection_prefers_smallest_leaf_and_translates_surface_origin() {
    let root = VdpUiInspectAtResult {
        hit: true,
        surface: Some("workbench".into()),
        test_id: Some("view:workbench".into()),
        role: Some("root".into()),
        bounds: Some(VdpUiBounds {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        }),
        ..Default::default()
    };
    let panel = VdpUiInspectAtResult {
        hit: true,
        surface: Some("workspace".into()),
        test_id: Some("pane:diorama:farm".into()),
        role: Some("canvas".into()),
        source: Some("apps/mac/src/diorama/view.rs:1".into()),
        bounds: Some(VdpUiBounds {
            x: 64.0,
            y: 0.0,
            width: 800.0,
            height: 800.0,
        }),
        ..Default::default()
    };
    let button = hit_from_hosted_node(
        "sidebar",
        64.0,
        0.0,
        &vibevalley_protocol::VdpUiNode {
            test_id: Some("sidebar-tab-git".into()),
            role: Some("button".into()),
            text: Some("Git".into()),
            route: None,
            source: Some("apps/mac/ui/workspace/Sidebar.tsx:88".into()),
            bounds: Some(VdpUiBounds {
                x: 16.0,
                y: 40.0,
                width: 48.0,
                height: 24.0,
            }),
            pressable: Some(true),
            children: None,
        },
    )
    .unwrap();
    assert_eq!(button.bounds.unwrap().x, 80.0);

    let chosen = select_deepest_hit(90.0, 50.0, vec![root, panel, button]).unwrap();
    assert_eq!(chosen.test_id.as_deref(), Some("sidebar-tab-git"));
    assert_eq!(chosen.source.as_deref(), Some("apps/mac/ui/workspace/Sidebar.tsx:88"));
    assert!(select_deepest_hit(1500.0, 50.0, vec![]).is_none());
}

#[test]
fn resolve_loopback_ws_url_rejects_non_loopback_and_non_ws_schemes() {
    let ok = resolve_loopback_ws_url(&HostVdpCallPayload {
        ws_url: Some("ws://127.0.0.1:9222/devtools".into()),
        port: None,
        token: Some("tok123".into()),
        method: "Target.list".into(),
        params: None,
        session_id: None,
        timeout_ms: None,
    })
    .unwrap();
    assert_eq!(ok, "ws://127.0.0.1:9222/devtools?token=tok123");

    let by_port = resolve_loopback_ws_url(&HostVdpCallPayload {
        ws_url: None,
        port: Some(9223),
        token: Some("abc".into()),
        method: "Target.list".into(),
        params: None,
        session_id: None,
        timeout_ms: None,
    })
    .unwrap();
    assert_eq!(by_port, "ws://127.0.0.1:9223/devtools?token=abc");

    for bad in [
        "ws://192.168.1.5:9222/devtools",
        "ws://example.com:9222/devtools",
        "http://127.0.0.1:9222/devtools",
    ] {
        let err = resolve_loopback_ws_url(&HostVdpCallPayload {
            ws_url: Some(bad.into()),
            port: None,
            token: None,
            method: "Target.list".into(),
            params: None,
            session_id: None,
            timeout_ms: None,
        })
        .unwrap_err();
        assert!(!err.is_empty(), "expected rejection for {bad}");
    }
}

#[tokio::test]
async fn vdp_server_enforces_auth_writes_0600_debug_json_and_handles_http_ws_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let dispatcher = Arc::new(MockDispatcher::new());
    let server = VdpServer::start_for_test(0, dir.path().to_path_buf(), dispatcher.clone()).expect("start VDP server");
    let info = server.endpoint_info().clone();

    // 1. debug.json exists with 0600 permissions and is discoverable via protocol home helper.
    let debug_path = debug_json_path(dir.path());
    assert!(debug_path.is_file());
    let mode = std::fs::metadata(&debug_path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "debug.json must have 0600 permissions");
    let discovered = read_debug_endpoint(dir.path()).expect("read_debug_endpoint");
    assert_eq!(discovered, info);
    assert_eq!(info.protocol_version, VDP_PROTOCOL_VERSION);
    assert!(info.port > 0);
    assert_eq!(info.token.len(), 64);

    // 2. Unauthenticated HTTP & WS requests are rejected with 401.
    let client = reqwest::Client::new();
    for path in ["/json/version", "/json/list", "/devtools"] {
        let resp = client.get(format!("{}{path}", info.http_url)).send().await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED, "missing token on {path}");
        let wrong = client.get(format!("{}{path}?token=wrong-token", info.http_url)).send().await.unwrap();
        assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED, "wrong token on {path}");
    }

    // 3. Authenticated GET /json/version (Bearer & ?token=) returns VdpVersionInfo without token.
    let version_resp = client
        .get(format!("{}/json/version", info.http_url))
        .bearer_auth(&info.token)
        .send()
        .await
        .unwrap();
    assert_eq!(version_resp.status(), reqwest::StatusCode::OK);
    let version_raw: Value = version_resp.json().await.unwrap();
    assert!(version_raw.get("token").is_none(), "/json/version must never expose token");
    let version: VdpVersionInfo = serde_json::from_value(version_raw).unwrap();
    assert_eq!(version.port, info.port);
    assert_eq!(version.pid, info.pid);

    // 4. Authenticated GET /json/list returns targets.
    let list_resp = client.get(format!("{}/json/list?token={}", info.http_url, info.token)).send().await.unwrap();
    assert_eq!(list_resp.status(), reqwest::StatusCode::OK);
    let targets: Vec<VdpTarget> = list_resp.json().await.unwrap();
    assert!(targets.iter().any(|t| t.id == "shell" && t.kind == VdpTargetKind::Shell));
    assert!(targets.iter().any(|t| t.id == "view:workbench" && t.kind == VdpTargetKind::View));

    // 5. WebSocket JSON-RPC round-trip: Target.list, Target.attach, Shell.getState, Shell.navigate, Log.enable + live events.
    let (mut ws, _) = tokio_tungstenite::connect_async(info.ws_url_with_token()).await.expect("connect WS");

    async fn rpc(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        req: VdpRequest,
    ) -> vibevalley_protocol::VdpResponse {
        ws.send(ClientWsMsg::Text(serde_json::to_string(&req).unwrap().into())).await.unwrap();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(3), ws.next())
                .await
                .expect("WS response timeout")
                .expect("WS open")
                .expect("WS frame ok");
            if let ClientWsMsg::Text(text) = frame
                && let Ok(VdpWireMessage::Response(resp)) = serde_json::from_str::<VdpWireMessage>(&text)
                && resp.id == req.id
            {
                return resp;
            }
        }
    }

    let list_res = rpc(&mut ws, VdpRequest::from_command(1, &VdpCommand::TargetList, None))
        .await
        .into_result()
        .unwrap();
    let list_parsed: VdpTargetListResult = serde_json::from_value(list_res).unwrap();
    assert_eq!(list_parsed.targets.len(), 3);

    let attach_res = rpc(
        &mut ws,
        VdpRequest::from_command(
            2,
            &VdpCommand::TargetAttach(VdpTargetAttachParams {
                target_id: "view:workbench".into(),
            }),
            None,
        ),
    )
    .await
    .into_result()
    .unwrap();
    let attached: VdpTargetAttachResult = serde_json::from_value(attach_res).unwrap();
    assert!(attached.target.attached);

    let state_before = rpc(
        &mut ws,
        VdpRequest::from_command(3, &VdpCommand::ShellGetState, Some(attached.session_id.clone())),
    )
    .await
    .into_result()
    .unwrap();
    assert_eq!(state_before["route"], "/issues");

    let nav_res = rpc(
        &mut ws,
        VdpRequest::from_command(
            4,
            &VdpCommand::ShellNavigate(vibevalley_protocol::VdpShellNavigateParams { route: "/library".into() }),
            None,
        ),
    )
    .await
    .into_result()
    .unwrap();
    assert_eq!(nav_res["ok"], true);

    let state_after = rpc(&mut ws, VdpRequest::from_command(5, &VdpCommand::ShellGetState, None))
        .await
        .into_result()
        .unwrap();
    assert_eq!(state_after["route"], "/library");

    // Unknown method & malformed JSON return structured JSON-RPC errors.
    let unknown = rpc(&mut ws, VdpRequest::new(6, "NoSuch.method", json!({}), None))
        .await
        .into_result()
        .unwrap_err();
    assert_eq!(unknown.code, VdpError::METHOD_NOT_FOUND);

    ws.send(ClientWsMsg::Text("{not-json".into())).await.unwrap();
    let parse_err_frame = tokio::time::timeout(Duration::from_secs(3), ws.next()).await.unwrap().unwrap().unwrap();
    let ClientWsMsg::Text(parse_err_text) = parse_err_frame else {
        panic!("expected text frame");
    };
    let VdpWireMessage::Response(parse_err_resp) = serde_json::from_str::<VdpWireMessage>(&parse_err_text).unwrap() else {
        panic!("expected response");
    };
    assert_eq!(parse_err_resp.into_result().unwrap_err().code, VdpError::PARSE_ERROR);

    // Log.enable activates UI log flag, pushes live events over WS, and buffers for Log.getEntries.
    let log_on = rpc(&mut ws, VdpRequest::from_command(7, &VdpCommand::LogEnable, None))
        .await
        .into_result()
        .unwrap();
    assert_eq!(log_on["ok"], true);
    assert!(dispatcher.ui_log_enabled.load(Ordering::Relaxed));

    server.hub().emit(VdpNotification::LogEntry(VdpLogEntry {
        level: VdpLogLevel::Warn,
        source: "vibevalley::test".into(),
        message: "hello live log".into(),
        timestamp: 1_700_000_000_000,
        fields: None,
    }));
    server.hub().emit(VdpNotification::PageFrame(VdpPageFrameEvent {
        frame_ms: 4.2,
        timestamp: 1_700_000_000_010,
        width: Some(1280.0),
        height: Some(820.0),
    }));

    let ev_frame = tokio::time::timeout(Duration::from_secs(3), ws.next()).await.unwrap().unwrap().unwrap();
    let ClientWsMsg::Text(ev_text) = ev_frame else {
        panic!("expected event text frame");
    };
    let VdpWireMessage::Event(ev) = serde_json::from_str::<VdpWireMessage>(&ev_text).unwrap() else {
        panic!("expected VdpWireMessage::Event");
    };
    assert_eq!(ev.method, "Log.entry");
    assert_eq!(ev.params["message"], "hello live log");

    let entries_val = rpc(&mut ws, VdpRequest::from_command(8, &VdpCommand::LogGetEntries(Default::default()), None))
        .await
        .into_result()
        .unwrap();
    let entries: VdpLogEntriesResult = serde_json::from_value(entries_val).unwrap();
    assert_eq!(entries.entries.len(), 2);
    assert_eq!(entries.latest_id, 2);

    let detach = rpc(
        &mut ws,
        VdpRequest::from_command(
            9,
            &VdpCommand::TargetDetach(VdpTargetDetachParams {
                session_id: attached.session_id,
            }),
            None,
        ),
    )
    .await
    .into_result()
    .unwrap();
    assert_eq!(detach["ok"], true);

    let log_off = rpc(&mut ws, VdpRequest::from_command(10, &VdpCommand::LogDisable, None))
        .await
        .into_result()
        .unwrap();
    assert_eq!(log_off["ok"], true);
    assert!(!dispatcher.ui_log_enabled.load(Ordering::Relaxed));

    // 6. call_remote_vdp proxy works end-to-end against live server and maps auth failure cleanly.
    let proxy_ok = call_remote_vdp(HostVdpCallPayload {
        ws_url: Some(info.ws_url.clone()),
        port: None,
        token: Some(info.token.clone()),
        method: "Shell.getState".into(),
        params: None,
        session_id: None,
        timeout_ms: Some(3000),
    })
    .await;
    assert_eq!(proxy_ok.biz_code, 0);
    assert_eq!(proxy_ok.data.as_ref().unwrap()["route"], "/library");

    let proxy_unauth = call_remote_vdp(HostVdpCallPayload {
        ws_url: None,
        port: Some(info.port),
        token: Some("bad-token".into()),
        method: "Shell.getState".into(),
        params: None,
        session_id: None,
        timeout_ms: Some(3000),
    })
    .await;
    assert_eq!(proxy_unauth.biz_code, vibevalley_server::gateway::bridge::BizCode::Unauthorized.code());

    // 7. Graceful shutdown removes debug.json.
    drop(ws);
    server.shutdown();
    assert!(!debug_path.exists(), "debug.json must be removed on shutdown");
}

#[tokio::test]
async fn ui_probe_pending_table_resolves_success_error_and_cleans_up_on_drop() {
    let (rx, mut guard) = ui_requests().register("req-ok".into());
    assert!(resolve_ui_response(&json!({
        "type": "vdp_ui_res",
        "reqId": "req-ok",
        "result": { "nodes": [{ "testId": "nav-library" }] }
    })));
    guard.disarm();
    let val = rx.await.unwrap().unwrap();
    assert_eq!(val["nodes"][0]["testId"], "nav-library");

    let (rx_err, mut guard_err) = ui_requests().register("req-err".into());
    assert!(resolve_ui_response(&json!({
        "type": "vdp_ui_res",
        "reqId": "req-err",
        "error": { "code": -32000, "message": "not found" }
    })));
    guard_err.disarm();
    let err = rx_err.await.unwrap().unwrap_err();
    assert_eq!(err.code, VdpError::UNAVAILABLE);
    assert_eq!(err.message, "not found");

    // Dropping an armed guard removes the pending entry cleanly.
    let (_rx_dropped, guard_dropped) = ui_requests().register("req-timeout".into());
    drop(guard_dropped);
    assert!(!resolve_ui_response(&json!({ "type": "vdp_ui_res", "reqId": "req-timeout", "result": {} })));
}
