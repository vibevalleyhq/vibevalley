//! Mock loopback Axum HTTP/WebSocket integration tests for `vibevalley debug`:
//! discovery, auth rejection, connection resolution (`--home`, `--port`, `--url`, `--token`),
//! every typed VDP RPC command, screenshot base64 decoding & disk write, `ui-wait`, raw `call`,
//! and live `watch` event streaming (human + NDJSON).

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use base64::Engine;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_protocol::{
    VDP_PROTOCOL_VERSION, VdpAckResult, VdpCommand, VdpEndpointInfo, VdpError, VdpEvent, VdpInputResult, VdpLogEntry, VdpLogLevel, VdpNotification,
    VdpPageFrameEvent, VdpPageMetrics, VdpRequest, VdpResponse, VdpScreenshotResult, VdpTarget, VdpTargetKind, VdpTargetListResult, VdpUiBounds,
    VdpUiConsoleEvent, VdpUiNode, VdpUiPressResult, VdpUiQueryResult, VdpUiTreeResult, VdpUiWaitForResult, VdpVersionInfo, home,
};

#[derive(Clone)]
struct MockVdpState {
    info: VdpEndpointInfo,
    recorded: Arc<Mutex<Vec<VdpRequest>>>,
    png_bytes: Vec<u8>,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

fn check_auth(headers: &HeaderMap, query: &TokenQuery, expected: &str) -> bool {
    if let Some(bearer) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        && bearer == expected
    {
        return true;
    }
    query.token.as_deref() == Some(expected)
}

async fn handle_version(State(state): State<MockVdpState>, headers: HeaderMap, Query(query): Query<TokenQuery>) -> impl IntoResponse {
    if !check_auth(&headers, &query, &state.info.token) {
        return (StatusCode::UNAUTHORIZED, "missing or invalid VDP token").into_response();
    }
    let version: VdpVersionInfo = state.info.version_info();
    (StatusCode::OK, axum::Json(version)).into_response()
}

async fn handle_list(State(state): State<MockVdpState>, headers: HeaderMap, Query(query): Query<TokenQuery>) -> impl IntoResponse {
    if !check_auth(&headers, &query, &state.info.token) {
        return (StatusCode::UNAUTHORIZED, "missing or invalid VDP token").into_response();
    }
    (StatusCode::OK, axum::Json(mock_targets())).into_response()
}

async fn handle_ws(State(state): State<MockVdpState>, headers: HeaderMap, Query(query): Query<TokenQuery>, ws: WebSocketUpgrade) -> impl IntoResponse {
    if !check_auth(&headers, &query, &state.info.token) {
        return (StatusCode::UNAUTHORIZED, "missing or invalid VDP token").into_response();
    }
    ws.on_upgrade(move |socket| drive_mock_vdp_ws(socket, state))
}

fn mock_targets() -> Vec<VdpTarget> {
    vec![
        VdpTarget {
            id: "shell".into(),
            kind: VdpTargetKind::Shell,
            title: "VibeValley".into(),
            url: Some("/issues".into()),
            attached: false,
        },
        VdpTarget {
            id: "view:workbench".into(),
            kind: VdpTargetKind::View,
            title: "Workbench".into(),
            url: Some("/library".into()),
            attached: true,
        },
        VdpTarget {
            id: "server".into(),
            kind: VdpTargetKind::Server,
            title: "Local Server".into(),
            url: None,
            attached: false,
        },
    ]
}

fn mock_node() -> VdpUiNode {
    VdpUiNode {
        test_id: Some("nav-library".into()),
        role: Some("button".into()),
        text: Some("Library".into()),
        bounds: Some(VdpUiBounds {
            x: 16.0,
            y: 120.0,
            width: 180.0,
            height: 32.0,
        }),
        pressable: Some(true),
        children: None,
    }
}

async fn send_json(socket: &mut WebSocket, value: &impl serde::Serialize) {
    let text = serde_json::to_string(value).unwrap();
    let _ = socket.send(AxumWsMessage::Text(text.into())).await;
}

async fn drive_mock_vdp_ws(mut socket: WebSocket, state: MockVdpState) {
    while let Some(Ok(msg)) = socket.recv().await {
        let AxumWsMessage::Text(text) = msg else {
            continue;
        };
        let req: VdpRequest = match serde_json::from_str(text.as_str()) {
            Ok(req) => req,
            Err(err) => {
                send_json(&mut socket, &VdpResponse::err(0, VdpError::parse_error(err.to_string()), None)).await;
                continue;
            }
        };
        state.recorded.lock().push(req.clone());

        if req.method == "Custom.ping" {
            let res = VdpResponse::ok(
                req.id,
                json!({
                    "pong": true,
                    "echo": req.params,
                    "sessionId": req.session_id,
                }),
                req.session_id.clone(),
            );
            send_json(&mut socket, &res).await;
            continue;
        }

        let cmd = match req.decode_command() {
            Ok(cmd) => cmd,
            Err(err) => {
                send_json(&mut socket, &VdpResponse::err(req.id, err, req.session_id)).await;
                continue;
            }
        };

        match cmd {
            VdpCommand::TargetList => {
                let res = VdpResponse::ok(
                    req.id,
                    serde_json::to_value(VdpTargetListResult { targets: mock_targets() }).unwrap(),
                    req.session_id,
                );
                send_json(&mut socket, &res).await;
            }
            VdpCommand::ShellGetState => {
                let res = VdpResponse::ok(
                    req.id,
                    json!({
                        "route": "/library",
                        "themeDark": true,
                        "width": 1440.0,
                        "height": 900.0,
                        "panes": [{ "id": "main", "kind": "hosted" }],
                    }),
                    req.session_id,
                );
                send_json(&mut socket, &res).await;
            }
            VdpCommand::ShellNavigate(p) => {
                let res = VdpResponse::ok(req.id, json!({ "ok": true, "route": p.route }), req.session_id);
                send_json(&mut socket, &res).await;
            }
            VdpCommand::ShellResize(p) => {
                let res = VdpResponse::ok(req.id, json!({ "ok": true, "width": p.width, "height": p.height }), req.session_id);
                send_json(&mut socket, &res).await;
            }
            VdpCommand::ShellSetTheme(p) => {
                let res = VdpResponse::ok(req.id, json!({ "ok": true, "dark": p.dark }), req.session_id);
                send_json(&mut socket, &res).await;
            }
            VdpCommand::PageCaptureScreenshot(p) => {
                let shot = VdpScreenshotResult {
                    mime: "image/png".into(),
                    data: base64::engine::general_purpose::STANDARD.encode(&state.png_bytes),
                    width: p.width.unwrap_or(1440),
                    height: p.height.unwrap_or(900),
                };
                send_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(shot).unwrap(), req.session_id)).await;
            }
            VdpCommand::PageGetMetrics => {
                let metrics = VdpPageMetrics {
                    width: 1440.0,
                    height: 900.0,
                    scale_factor: 2.0,
                    theme_dark: true,
                    last_frame_ms: Some(4.25),
                };
                send_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(metrics).unwrap(), req.session_id)).await;
            }
            VdpCommand::InputDispatchKey(_) | VdpCommand::InputTypeText(_) | VdpCommand::InputDispatchMouse(_) => {
                let out = VdpInputResult { handled: true };
                send_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            VdpCommand::UiGetTree(p) => {
                let tree = VdpUiTreeResult {
                    view: p.view.unwrap_or_else(|| "workbench".into()),
                    route: Some("/library".into()),
                    nodes: vec![VdpUiNode {
                        test_id: Some("sidebar".into()),
                        role: Some("navigation".into()),
                        text: None,
                        bounds: Some(VdpUiBounds {
                            x: 0.0,
                            y: 0.0,
                            width: 240.0,
                            height: 900.0,
                        }),
                        pressable: Some(false),
                        children: Some(vec![mock_node()]),
                    }],
                };
                send_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(tree).unwrap(), req.session_id)).await;
            }
            VdpCommand::UiQuery(p) => {
                let out = VdpUiQueryResult {
                    view: p.view.unwrap_or_else(|| "workbench".into()),
                    nodes: vec![mock_node()],
                };
                send_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            VdpCommand::UiPress(p) => {
                let out = VdpUiPressResult {
                    view: p.view.unwrap_or_else(|| "workbench".into()),
                    test_id: p.test_id,
                    pressed: true,
                };
                send_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            VdpCommand::UiWaitFor(p) => {
                if p.test_id.as_deref() == Some("never-appears") {
                    send_json(
                        &mut socket,
                        &VdpResponse::err(req.id, VdpError::timeout("UI.waitFor timed out"), req.session_id),
                    )
                    .await;
                } else {
                    let out = VdpUiWaitForResult {
                        view: p.view.unwrap_or_else(|| "workbench".into()),
                        matched: true,
                        node: Some(mock_node()),
                        elapsed_ms: 42,
                    };
                    send_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
                }
            }
            VdpCommand::ServerSlice(p) => {
                let res = VdpResponse::ok(req.id, json!({ "slice": p.name, "seq": 17, "issues": [] }), req.session_id);
                send_json(&mut socket, &res).await;
            }
            VdpCommand::ServerInvoke(p) => {
                let res = VdpResponse::ok(req.id, json!({ "method": p.method, "params": p.params, "ok": true }), req.session_id);
                send_json(&mut socket, &res).await;
            }
            VdpCommand::LogEnable => {
                // Push one event before the response to verify buffered event handling,
                // then ack Log.enable, then push two more events.
                let pre_ev = VdpEvent::from_notification(
                    &VdpNotification::LogEntry(VdpLogEntry {
                        level: VdpLogLevel::Info,
                        source: "shell".into(),
                        message: "vdp attached".into(),
                        timestamp: 1_700_000_000_001,
                        fields: None,
                    }),
                    None,
                );
                send_json(&mut socket, &pre_ev).await;
                send_json(
                    &mut socket,
                    &VdpResponse::ok(req.id, serde_json::to_value(VdpAckResult { ok: true }).unwrap(), req.session_id),
                )
                .await;
                let frame_ev = VdpEvent::from_notification(
                    &VdpNotification::PageFrame(VdpPageFrameEvent {
                        frame_ms: 6.5,
                        timestamp: 1_700_000_000_002,
                        width: Some(1440.0),
                        height: Some(900.0),
                    }),
                    None,
                );
                let console_ev = VdpEvent::from_notification(
                    &VdpNotification::UiConsole(VdpUiConsoleEvent {
                        view: "workbench".into(),
                        level: VdpLogLevel::Warn,
                        message: "slow query".into(),
                        timestamp: 1_700_000_000_003,
                    }),
                    None,
                );
                send_json(&mut socket, &frame_ev).await;
                send_json(&mut socket, &console_ev).await;
            }
            VdpCommand::LogDisable => {
                send_json(
                    &mut socket,
                    &VdpResponse::ok(req.id, serde_json::to_value(VdpAckResult { ok: true }).unwrap(), req.session_id),
                )
                .await;
            }
            _ => {
                send_json(
                    &mut socket,
                    &VdpResponse::err(req.id, VdpError::unavailable("unimplemented in mock"), req.session_id),
                )
                .await;
            }
        }
    }
}

struct MockVdpHost {
    home_dir: tempfile::TempDir,
    info: VdpEndpointInfo,
    recorded: Arc<Mutex<Vec<VdpRequest>>>,
    png_bytes: Vec<u8>,
    _debug_guard: home::DebugEndpointGuard,
    _server_guard: DropGuard,
}

impl MockVdpHost {
    fn start(token: &str) -> Self {
        let home_dir = tempfile::tempdir().unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        // Minimal valid PNG header + IEND bytes for binary round-trip verification.
        let png_bytes = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R', 0x00, 0x00, 0x00, 0x01,
        ];

        let (port, server_guard, info) = vibevalley_runtime::rt::block_on({
            let home_path = home_dir.path().to_path_buf();
            let token = token.to_string();
            let recorded = recorded.clone();
            let png_bytes = png_bytes.clone();
            async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let info = VdpEndpointInfo {
                    protocol_version: VDP_PROTOCOL_VERSION.into(),
                    pid: std::process::id(),
                    channel: "dev".into(),
                    app_version: "0.1.0-test".into(),
                    home: home_path.display().to_string(),
                    port: addr.port(),
                    http_url: format!("http://127.0.0.1:{}", addr.port()),
                    ws_url: format!("ws://127.0.0.1:{}/devtools", addr.port()),
                    token,
                    started_at: 1_700_000_000_000,
                };
                let state = MockVdpState {
                    info: info.clone(),
                    recorded,
                    png_bytes,
                };
                let app = Router::new()
                    .route("/json/version", get(handle_version))
                    .route("/json/list", get(handle_list))
                    .route("/devtools", get(handle_ws))
                    .with_state(state);
                let cancel = CancellationToken::new();
                let guard = cancel.clone().drop_guard();
                tokio::spawn(async move {
                    let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
                });
                (addr.port(), guard, info)
            }
        });

        let debug_guard = home::write_debug_endpoint(home_dir.path(), &info).unwrap();
        assert_eq!(info.port, port);

        Self {
            home_dir,
            info,
            recorded,
            png_bytes,
            _debug_guard: debug_guard,
            _server_guard: server_guard,
        }
    }

    fn take_recorded(&self) -> Vec<VdpRequest> {
        std::mem::take(&mut *self.recorded.lock())
    }
}

struct CliOut {
    code: i32,
    stdout: String,
    failure: Option<Value>,
}

impl CliOut {
    fn tag(&self) -> &str {
        self.failure.as_ref().and_then(|f| f["error"]["tag"].as_str()).unwrap_or("")
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.stdout).unwrap_or_else(|e| panic!("invalid JSON stdout: {e}\nstdout: {}\nfailure: {:?}", self.stdout, self.failure))
    }
}

fn run_cli(home_dir: &Path, args: &[&str]) -> CliOut {
    let output = Command::new(env!("CARGO_BIN_EXE_vibevalley"))
        .args(args)
        .env("VIBEVALLEY_HOME", home_dir)
        .env_remove("VIBEVALLEY_SERVER")
        .env_remove("VIBEVALLEY_REMOTE_TOKEN")
        .env_remove("VIBEVALLEY_TOKEN")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    CliOut {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
        failure: stderr.lines().last().and_then(|l| serde_json::from_str(l).ok()),
    }
}

#[test]
fn debug_discover_auth_and_connection_resolution() {
    let host = MockVdpHost::start("vdp-secret-token-42");
    let isolated_home = tempfile::tempdir().unwrap();
    let home_str = host.home_dir.path().to_str().unwrap();

    // 1. Discover finds the live sandbox via --home without leaking token.
    let disc = run_cli(isolated_home.path(), &["debug", "discover", "--home", home_str, "--json"]);
    assert_eq!(disc.code, 0, "{:?}", disc.failure);
    let items = disc.json();
    let found = items
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["port"] == host.info.port)
        .expect("discovered sandbox endpoint");
    assert_eq!(found["channel"], "dev");
    assert_eq!(found["wsUrl"], host.info.ws_url);
    assert!(found.get("token").is_none(), "discover must never expose token");
    assert!(!disc.stdout.contains("vdp-secret-token-42"));

    // 2. Auth rejection on HTTP /json/version and WS /devtools with wrong token.
    let bad_http = run_cli(isolated_home.path(), &["debug", "version", "--home", home_str, "--token", "wrong-token"]);
    assert_eq!((bad_http.code, bad_http.tag()), (3, "Unauthorized"), "{:?}", bad_http.failure);

    let bad_ws = run_cli(
        isolated_home.path(),
        &["debug", "targets", "--url", &host.info.ws_url, "--token", "wrong-token"],
    );
    assert_eq!((bad_ws.code, bad_ws.tag()), (3, "Unauthorized"), "{:?}", bad_ws.failure);

    let no_tok = run_cli(isolated_home.path(), &["debug", "targets", "--url", &host.info.ws_url]);
    assert_eq!((no_tok.code, no_tok.tag()), (3, "Unauthorized"), "{:?}", no_tok.failure);

    // 3. Explicit --url + --token succeeds on both version and WS RPC.
    let ver = run_cli(
        isolated_home.path(),
        &["debug", "version", "--url", &host.info.ws_url, "--token", "vdp-secret-token-42", "--json"],
    );
    assert_eq!(ver.code, 0, "{:?}", ver.failure);
    assert_eq!(ver.json()["port"], host.info.port);

    // 4. Explicit --port discovers matching token from VIBEVALLEY_HOME/debug.json.
    let port_str = host.info.port.to_string();
    let by_port = run_cli(host.home_dir.path(), &["debug", "targets", "--port", &port_str, "--json"]);
    assert_eq!(by_port.code, 0, "{:?}", by_port.failure);
    assert_eq!(by_port.json()["targets"].as_array().unwrap().len(), 3);

    // 5. Missing --home debug.json returns Unreachable (exit 5).
    let empty_home = tempfile::tempdir().unwrap();
    let missing = run_cli(isolated_home.path(), &["debug", "state", "--home", empty_home.path().to_str().unwrap()]);
    assert_eq!((missing.code, missing.tag()), (5, "Unreachable"), "{:?}", missing.failure);
}

#[test]
fn debug_commands_screenshot_ui_wait_raw_call_and_watch() {
    let host = MockVdpHost::start("vdp-secret-token-99");
    let home = host.home_dir.path();

    // Targets & State (human + JSON).
    let targets = run_cli(home, &["debug", "targets"]);
    assert_eq!(targets.code, 0, "{:?}", targets.failure);
    assert!(
        targets.stdout.contains("view:workbench") && targets.stdout.contains("attached"),
        "{}",
        targets.stdout
    );

    let state = run_cli(home, &["debug", "state"]);
    assert_eq!(state.code, 0, "{:?}", state.failure);
    assert!(
        state.stdout.contains("route /library") && state.stdout.contains("theme dark"),
        "{}",
        state.stdout
    );

    // Shell mutations: navigate, resize, theme (--dark, --light, --toggle).
    assert_eq!(run_cli(home, &["debug", "navigate", "/channels"]).code, 0);
    assert_eq!(run_cli(home, &["debug", "resize", "1280", "720"]).code, 0);
    assert_eq!(run_cli(home, &["debug", "theme", "--dark"]).code, 0);
    assert_eq!(run_cli(home, &["debug", "theme", "--light"]).code, 0);
    assert_eq!(run_cli(home, &["debug", "theme", "--toggle"]).code, 0);

    // Input.* commands print handled.
    let key = run_cli(home, &["debug", "key", "cmd-k"]);
    assert_eq!(key.code, 0, "{:?}", key.failure);
    assert!(key.stdout.contains("handled true"), "{}", key.stdout);

    let typed = run_cli(home, &["debug", "type", "hello"]);
    assert_eq!(typed.code, 0, "{:?}", typed.failure);
    assert!(typed.stdout.contains("handled true"), "{}", typed.stdout);

    let clicked = run_cli(home, &["debug", "click", "120", "240", "--right"]);
    assert_eq!(clicked.code, 0, "{:?}", clicked.failure);
    assert!(clicked.stdout.contains("handled true"), "{}", clicked.stdout);

    // Screenshot decodes base64 PNG and writes exact bytes to disk.
    let shot_dir = tempfile::tempdir().unwrap();
    let shot_path = shot_dir.path().join("nested").join("capture.png");
    let shot = run_cli(
        home,
        &[
            "debug",
            "screenshot",
            shot_path.to_str().unwrap(),
            "--target",
            "webview",
            "--width",
            "640",
            "--height",
            "480",
            "--json",
        ],
    );
    assert_eq!(shot.code, 0, "{:?}", shot.failure);
    let shot_json = shot.json();
    assert_eq!(shot_json["width"], 640);
    assert_eq!(shot_json["height"], 480);
    assert_eq!(shot_json["mime"], "image/png");
    assert_eq!(shot_json["bytes"], host.png_bytes.len());
    assert_eq!(std::fs::read(&shot_path).unwrap(), host.png_bytes);

    // UI.* commands: tree, query (verifying bounds!), press, wait (success + timeout).
    let tree = run_cli(home, &["debug", "ui-tree", "--view", "workbench", "--max-depth", "3"]);
    assert_eq!(tree.code, 0, "{:?}", tree.failure);
    assert!(tree.stdout.contains("#sidebar") && tree.stdout.contains("#nav-library"), "{}", tree.stdout);

    let query = run_cli(
        home,
        &[
            "debug",
            "ui-query",
            "--test-id",
            "nav-library",
            "--text",
            "Library",
            "--role",
            "button",
            "--view",
            "workbench",
        ],
    );
    assert_eq!(query.code, 0, "{:?}", query.failure);
    assert!(query.stdout.contains("{x: 16, y: 120, width: 180, height: 32}"), "{}", query.stdout);

    let press = run_cli(home, &["debug", "ui-press", "nav-library", "--view", "workbench"]);
    assert_eq!(press.code, 0, "{:?}", press.failure);
    assert!(press.stdout.contains("pressed"), "{}", press.stdout);

    let waited = run_cli(home, &["debug", "ui-wait", "--test-id", "nav-library", "--timeout-ms", "2000", "--json"]);
    assert_eq!(waited.code, 0, "{:?}", waited.failure);
    assert_eq!(waited.json()["matched"], true);
    assert_eq!(waited.json()["elapsedMs"], 42);

    let timed_out = run_cli(home, &["debug", "ui-wait", "--test-id", "never-appears", "--timeout-ms", "100"]);
    assert_eq!((timed_out.code, timed_out.tag()), (1, "Timeout"), "{:?}", timed_out.failure);

    // Server.slice, Server.invoke, and raw call.
    let slice = run_cli(home, &["debug", "server-slice", "board", "--json"]);
    assert_eq!(slice.code, 0, "{:?}", slice.failure);
    assert_eq!(slice.json()["slice"], "board");

    let rpc = run_cli(home, &["debug", "server-rpc", "debug.snapshot", r#"{"verbose":true}"#, "--json"]);
    assert_eq!(rpc.code, 0, "{:?}", rpc.failure);
    assert_eq!(rpc.json()["method"], "debug.snapshot");
    assert_eq!(rpc.json()["params"]["verbose"], true);

    let raw_call = run_cli(home, &["debug", "call", "Custom.ping", r#"{"n":7}"#, "--session-id", "sess-1", "--json"]);
    assert_eq!(raw_call.code, 0, "{:?}", raw_call.failure);
    assert_eq!(raw_call.json()["pong"], true);
    assert_eq!(raw_call.json()["echo"]["n"], 7);
    assert_eq!(raw_call.json()["sessionId"], "sess-1");

    let unknown = run_cli(home, &["debug", "call", "Nope.unknown"]);
    assert_eq!((unknown.code, unknown.tag()), (4, "MethodNotFound"), "{:?}", unknown.failure);

    // Verify exact wire params sent for theme and click.
    let recorded = host.take_recorded();
    let theme_calls: Vec<Option<bool>> = recorded
        .iter()
        .filter(|r| r.method == "Shell.setTheme")
        .map(|r| r.params.get("dark").and_then(Value::as_bool))
        .collect();
    assert_eq!(theme_calls, vec![Some(true), Some(false), None]);
    let click_req = recorded.iter().find(|r| r.method == "Input.dispatchMouse").unwrap();
    assert_eq!(click_req.params["kind"], "click");
    assert_eq!(click_req.params["button"], "right");

    // Watch streams live events in NDJSON (--json) and human mode, stopping cleanly at --limit.
    let watch_json = run_cli(home, &["debug", "watch", "--limit", "3", "--json"]);
    assert_eq!(watch_json.code, 0, "{:?}", watch_json.failure);
    let ndjson_lines: Vec<Value> = watch_json.stdout.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(ndjson_lines.len(), 3);
    assert_eq!(ndjson_lines[0]["method"], "Log.entry");
    assert_eq!(ndjson_lines[1]["method"], "Page.frame");
    assert_eq!(ndjson_lines[2]["method"], "UI.console");

    let watch_human = run_cli(home, &["debug", "watch", "--limit", "3"]);
    assert_eq!(watch_human.code, 0, "{:?}", watch_human.failure);
    assert_eq!(watch_human.stdout.lines().count(), 3);
    assert!(watch_human.stdout.contains("Log.entry") && watch_human.stdout.contains("vdp attached"));
    assert!(watch_human.stdout.contains("Page.frame") && watch_human.stdout.contains("6.50ms"));
    assert!(watch_human.stdout.contains("UI.console") && watch_human.stdout.contains("slow query"));

    let watch_reqs = host.take_recorded();
    assert!(watch_reqs.iter().any(|r| r.method == "Log.enable"));
    assert!(watch_reqs.iter().any(|r| r.method == "Log.disable"));
}
