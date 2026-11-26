//! End-to-end stdio MCP tests for `vibevalley mcp`:
//! spawns the real CLI binary over piped stdin/stdout against a mock VibeValley HTTP server
//! and a mock loopback VDP WebSocket server, verifying JSON-RPC 2.0 framing, Issues CRUD,
//! VDP live inspection + screenshot image content block, error resilience, and zero token leakage.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use base64::Engine;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_protocol::{
    Applied, AppliedIssue, Assignment, Attachment, AttachmentUpload, Deliverable, Issue, IssueCommentCreateInput, IssueConversationGetInput, IssueFilter,
    IssueGetInput, IssueMandate, IssueRequest, IssueStage, IssueStageKind, IssueStatus, IssueStatusUpdateInput, IssueUpdateInput, MandateStrength, Priority,
    SayRequest, VDP_PROTOCOL_VERSION, VdpCommand, VdpEndpointInfo, VdpError, VdpInputResult, VdpRequest, VdpResponse, VdpScreenshotResult, VdpTarget,
    VdpTargetKind, VdpTargetListResult, VdpUiBounds, VdpUiNode, VdpUiPressResult, VdpUiQueryResult, VdpVersionInfo, home,
};

// ---------------------------------------------------------------------------
// Mock VibeValley HTTP RPC Server (Issues + Attachments + Channel)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct MockIssueState {
    issues: Arc<Mutex<Vec<Issue>>>,
    comments: Arc<Mutex<Vec<(String, String)>>>,
    channel_messages: Arc<Mutex<Vec<SayRequest>>>,
    attachments: Arc<Mutex<Vec<Attachment>>>,
    next_number: Arc<Mutex<i64>>,
}

impl MockIssueState {
    fn new() -> Self {
        Self {
            issues: Arc::new(Mutex::new(Vec::new())),
            comments: Arc::new(Mutex::new(Vec::new())),
            channel_messages: Arc::new(Mutex::new(Vec::new())),
            attachments: Arc::new(Mutex::new(Vec::new())),
            next_number: Arc::new(Mutex::new(1)),
        }
    }

    fn make_issue(&self, req: IssueRequest) -> Issue {
        let mut next = self.next_number.lock();
        let number = *next;
        *next += 1;
        let id = format!("iss-{number}");
        let assignments = req
            .agent
            .map(|agent| {
                vec![Assignment {
                    id: format!("asg-{number}"),
                    issue: id.clone(),
                    agent,
                    assigned_at: 1_700_000_000_000,
                    ended_at: None,
                    executions: Vec::new(),
                }]
            })
            .unwrap_or_default();
        Issue {
            constraints: req.constraints,
            id,
            number,
            title: req.title,
            description: req.description.unwrap_or_default(),
            mandate: IssueMandate {
                origin_trigger_id: None,
                strength: MandateStrength::Explicit,
                max_bot_review_rounds: 0,
                auto_submit_pr: false,
            },
            conflict: None,
            repo: req.repo,
            machine_id: req.machine_id,
            assignments,
            priority: req.priority.unwrap_or(Priority::Medium),
            rank: Some(number),
            created_at: 1_700_000_000_000,
            queued_at: None,
            closed_at: None,
            delivered: None,
            canceled: None,
            parent: req.parent,
            blocked_by: req.blocked_by.unwrap_or_default(),
            cron: None,
            status: IssueStatus::Backlog,
            moves: vec![IssueStatus::Todo, IssueStatus::Canceled],
            pull_request: None,
            deliver: req.deliver.unwrap_or(Deliverable::Change),
            reviewed_at: None,
            delivery_evidence: None,
            findings: Vec::new(),
            questions: Vec::new(),
            criteria: req.criteria.unwrap_or_default(),
            checks: Vec::new(),
            refining: None,
            last_run: None,
            answer: None,
            stage: IssueStage {
                state: IssueStageKind::Draft,
                since: None,
                stuck: None,
                lead: None,
                acts: Vec::new(),
            },
            attachments: Vec::new(),
            tags: req.tags.unwrap_or_default(),
            start_at: req.start_at,
            due_at: req.due_at,
        }
    }
}

fn ok_envelope(data: impl serde::Serialize) -> (StatusCode, axum::Json<Value>) {
    (
        StatusCode::OK,
        axum::Json(json!({
            "bizCode": 0,
            "message": "ok",
            "data": data,
        })),
    )
}

fn err_envelope(status: StatusCode, biz_code: u32, message: &str) -> (StatusCode, axum::Json<Value>) {
    (
        status,
        axum::Json(json!({
            "bizCode": biz_code,
            "message": message,
        })),
    )
}

fn find_issue_index(issues: &[Issue], id_or_num: &str) -> Option<usize> {
    let key = id_or_num.trim_start_matches('#');
    issues.iter().position(|i| i.id == key || i.number.to_string() == key)
}

async fn handle_issue_list(State(state): State<MockIssueState>, axum::Json(filter): axum::Json<IssueFilter>) -> impl IntoResponse {
    let issues = state.issues.lock();
    let mut matched: Vec<Issue> = issues
        .iter()
        .filter(|i| filter.status.is_none_or(|s| i.status == s))
        .filter(|i| filter.repo.as_deref().is_none_or(|r| i.repo.as_deref() == Some(r)))
        .filter(|i| filter.text.as_deref().is_none_or(|t| i.title.contains(t) || i.description.contains(t)))
        .cloned()
        .collect();
    if let Some(limit) = filter.limit {
        matched.truncate(limit.max(0) as usize);
    }
    ok_envelope(matched)
}

async fn handle_issue_get(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueGetInput>) -> impl IntoResponse {
    let issues = state.issues.lock();
    match find_issue_index(&issues, &input.id) {
        Some(idx) => ok_envelope(issues[idx].clone()).into_response(),
        None => err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response(),
    }
}

async fn handle_issue_create(State(state): State<MockIssueState>, axum::Json(req): axum::Json<IssueRequest>) -> impl IntoResponse {
    let issue = state.make_issue(req);
    state.issues.lock().push(issue.clone());
    ok_envelope(AppliedIssue::from_issue(issue, 1))
}

async fn handle_issue_update(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueUpdateInput>) -> impl IntoResponse {
    let mut issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    let issue = &mut issues[idx];
    if let Some(title) = input.title {
        issue.title = title;
    }
    if let Some(description) = input.description {
        issue.description = description;
    }
    if let Some(priority) = input.priority {
        issue.priority = priority;
    }
    if let Some(repo) = input.repo {
        issue.repo = Some(repo);
    }
    if let Some(criteria) = input.criteria {
        issue.criteria = criteria;
    }
    ok_envelope(AppliedIssue::from_issue(issue.clone(), 2)).into_response()
}

async fn handle_issue_status_update(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueStatusUpdateInput>) -> impl IntoResponse {
    let mut issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    let issue = &mut issues[idx];
    if let Some(edit) = input.edit {
        if let Some(title) = edit.title {
            issue.title = title;
        }
        if let Some(description) = edit.description {
            issue.description = description;
        }
        if let Some(priority) = edit.priority {
            issue.priority = priority;
        }
    }
    issue.status = input.status;
    ok_envelope(AppliedIssue::from_issue(issue.clone(), 3)).into_response()
}

async fn handle_issue_comment_create(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueCommentCreateInput>) -> impl IntoResponse {
    let issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    let issue = issues[idx].clone();
    state.comments.lock().push((issue.id.clone(), input.text));
    ok_envelope(Applied { seq: 4 }).into_response()
}

async fn handle_issue_conversation_get(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueConversationGetInput>) -> impl IntoResponse {
    let issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    ok_envelope(Some(format!("thread-{}", issues[idx].id))).into_response()
}

async fn handle_channel_message_send(State(state): State<MockIssueState>, axum::Json(req): axum::Json<SayRequest>) -> impl IntoResponse {
    state.channel_messages.lock().push(req);
    ok_envelope(Value::Null)
}

async fn handle_attachment_create(State(state): State<MockIssueState>, axum::Json(req): axum::Json<AttachmentUpload>) -> impl IntoResponse {
    let bytes = base64::engine::general_purpose::STANDARD.decode(req.data.trim()).unwrap_or_default();
    let mut list = state.attachments.lock();
    let att = Attachment {
        id: format!("att-{}", list.len() + 1),
        name: req.name,
        r#type: req.r#type,
        size: bytes.len() as i64,
    };
    list.push(att.clone());
    ok_envelope(att)
}

struct MockIssueServer {
    url: String,
    comments: Arc<Mutex<Vec<(String, String)>>>,
    channel_messages: Arc<Mutex<Vec<SayRequest>>>,
    attachments: Arc<Mutex<Vec<Attachment>>>,
    _guard: DropGuard,
}

impl MockIssueServer {
    fn start() -> Self {
        let state = MockIssueState::new();
        let comments = state.comments.clone();
        let channel_messages = state.channel_messages.clone();
        let attachments = state.attachments.clone();
        let (url, guard) = vibevalley_runtime::rt::block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let router = Router::new()
                .route("/api/v1/issue/list", post(handle_issue_list))
                .route("/api/v1/issue/get", post(handle_issue_get))
                .route("/api/v1/issue/create", post(handle_issue_create))
                .route("/api/v1/issue/update", post(handle_issue_update))
                .route("/api/v1/issue/status/update", post(handle_issue_status_update))
                .route("/api/v1/issue/comment/create", post(handle_issue_comment_create))
                .route("/api/v1/issue/conversation/get", post(handle_issue_conversation_get))
                .route("/api/v1/channel/message/send", post(handle_channel_message_send))
                .route("/api/v1/attachment/create", post(handle_attachment_create))
                .with_state(state);
            let cancel = CancellationToken::new();
            let guard = cancel.clone().drop_guard();
            tokio::spawn(async move {
                let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
            });
            (format!("http://{addr}"), guard)
        });
        Self {
            url,
            comments,
            channel_messages,
            attachments,
            _guard: guard,
        }
    }
}

// ---------------------------------------------------------------------------
// Mock Loopback VDP WebSocket Server
// ---------------------------------------------------------------------------

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

fn check_vdp_auth(headers: &HeaderMap, query: &TokenQuery, expected: &str) -> bool {
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

async fn handle_vdp_version(State(state): State<MockVdpState>, headers: HeaderMap, Query(query): Query<TokenQuery>) -> impl IntoResponse {
    if !check_vdp_auth(&headers, &query, &state.info.token) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let version: VdpVersionInfo = state.info.version_info();
    (StatusCode::OK, axum::Json(version)).into_response()
}

async fn handle_vdp_ws(State(state): State<MockVdpState>, headers: HeaderMap, Query(query): Query<TokenQuery>, ws: WebSocketUpgrade) -> impl IntoResponse {
    if !check_vdp_auth(&headers, &query, &state.info.token) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| drive_mock_vdp(socket, state))
}

async fn send_ws_json(socket: &mut WebSocket, value: &impl serde::Serialize) {
    let text = serde_json::to_string(value).unwrap();
    let _ = socket.send(AxumWsMessage::Text(text.into())).await;
}

async fn drive_mock_vdp(mut socket: WebSocket, state: MockVdpState) {
    while let Some(Ok(msg)) = socket.recv().await {
        let AxumWsMessage::Text(text) = msg else {
            continue;
        };
        let req: VdpRequest = match serde_json::from_str(text.as_str()) {
            Ok(req) => req,
            Err(err) => {
                send_ws_json(&mut socket, &VdpResponse::err(0, VdpError::parse_error(err.to_string()), None)).await;
                continue;
            }
        };
        state.recorded.lock().push(req.clone());

        if req.method == "Custom.echo" {
            let res = VdpResponse::ok(req.id, json!({ "echo": req.params, "sessionId": req.session_id }), req.session_id);
            send_ws_json(&mut socket, &res).await;
            continue;
        }
        if req.method == "Custom.leakCheck" {
            let res = VdpResponse::err(req.id, VdpError::internal(format!("boom token={}", state.info.token)), req.session_id);
            send_ws_json(&mut socket, &res).await;
            continue;
        }

        let cmd = match req.decode_command() {
            Ok(cmd) => cmd,
            Err(err) => {
                send_ws_json(&mut socket, &VdpResponse::err(req.id, err, req.session_id)).await;
                continue;
            }
        };

        match cmd {
            VdpCommand::TargetList => {
                let res = VdpTargetListResult {
                    targets: vec![
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
                            url: Some("/issues".into()),
                            attached: true,
                        },
                    ],
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(res).unwrap(), req.session_id)).await;
            }
            VdpCommand::ShellGetState => {
                let val = json!({
                    "route": "/issues",
                    "themeDark": false,
                    "width": 1440.0,
                    "height": 900.0,
                });
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, val, req.session_id)).await;
            }
            VdpCommand::ShellNavigate(p) => {
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, json!({ "ok": true, "route": p.route }), req.session_id)).await;
            }
            VdpCommand::ShellResize(p) => {
                send_ws_json(
                    &mut socket,
                    &VdpResponse::ok(req.id, json!({ "ok": true, "width": p.width, "height": p.height }), req.session_id),
                )
                .await;
            }
            VdpCommand::ShellSetTheme(p) => {
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, json!({ "ok": true, "dark": p.dark }), req.session_id)).await;
            }
            VdpCommand::UiQuery(p) => {
                let out = VdpUiQueryResult {
                    view: p.view.unwrap_or_else(|| "workbench".into()),
                    nodes: vec![VdpUiNode {
                        test_id: Some("nav-issues".into()),
                        role: Some("button".into()),
                        text: Some("Issues".into()),
                        bounds: Some(VdpUiBounds {
                            x: 12.0,
                            y: 64.0,
                            width: 120.0,
                            height: 36.0,
                        }),
                        pressable: Some(true),
                        children: None,
                    }],
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            VdpCommand::UiPress(p) => {
                let out = VdpUiPressResult {
                    view: p.view.unwrap_or_else(|| "workbench".into()),
                    test_id: p.test_id,
                    pressed: true,
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            VdpCommand::PageCaptureScreenshot(p) => {
                let shot = VdpScreenshotResult {
                    mime: "image/png".into(),
                    data: base64::engine::general_purpose::STANDARD.encode(&state.png_bytes),
                    width: p.width.unwrap_or(1280),
                    height: p.height.unwrap_or(800),
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(shot).unwrap(), req.session_id)).await;
            }
            VdpCommand::InputDispatchKey(_) | VdpCommand::InputTypeText(_) | VdpCommand::InputDispatchMouse(_) => {
                let out = VdpInputResult { handled: true };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            _ => {
                send_ws_json(
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
        let png_bytes = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
        ];

        let (guard, info) = vibevalley_runtime::rt::block_on({
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
                    app_version: "0.1.0-mcp-test".into(),
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
                    .route("/json/version", get(handle_vdp_version))
                    .route("/devtools", get(handle_vdp_ws))
                    .with_state(state);
                let cancel = CancellationToken::new();
                let guard = cancel.clone().drop_guard();
                tokio::spawn(async move {
                    let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
                });
                (guard, info)
            }
        });

        let debug_guard = home::write_debug_endpoint(home_dir.path(), &info).unwrap();
        Self {
            home_dir,
            info,
            recorded,
            png_bytes,
            _debug_guard: debug_guard,
            _server_guard: guard,
        }
    }
}

// ---------------------------------------------------------------------------
// Stdio MCP Process Harness
// ---------------------------------------------------------------------------

struct McpProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl McpProcess {
    fn spawn(home_dir: &Path, server_url: &str, extra_args: &[&str]) -> Self {
        let mut args = vec!["--server", server_url, "mcp"];
        args.extend_from_slice(extra_args);
        let mut child = Command::new(env!("CARGO_BIN_EXE_vibevalley"))
            .args(args)
            .env("VIBEVALLEY_HOME", home_dir)
            .env_remove("VIBEVALLEY_SERVER")
            .env_remove("VIBEVALLEY_REMOTE_TOKEN")
            .env_remove("VIBEVALLEY_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin: Some(stdin),
            stdout,
        }
    }

    fn send_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn send(&mut self, msg: &Value) {
        self.send_raw(&serde_json::to_string(msg).unwrap());
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).unwrap();
        assert!(n > 0, "MCP server closed stdout unexpectedly");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("invalid JSON on MCP stdout: {e}\nline: {line:?}"))
    }

    fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        let resp = self.recv();
        assert_eq!(resp["jsonrpc"], "2.0", "{resp}");
        assert_eq!(resp["id"], id, "{resp}");
        resp
    }

    fn call_tool(&mut self, id: u64, name: &str, arguments: Value) -> Value {
        let resp = self.request(
            id,
            "tools/call",
            json!({
                "name": name,
                "arguments": arguments,
            }),
        );
        assert!(resp.get("error").is_none(), "unexpected JSON-RPC error for {name}: {resp}");
        resp["result"].clone()
    }

    fn finish(mut self) -> i32 {
        drop(self.stdin.take());
        let status = self.child.wait().unwrap();
        status.code().unwrap_or(-1)
    }
}

#[test]
fn mcp_stdio_end_to_end_issues_vdp_screenshot_and_security() {
    let secret_token = "vdp-super-secret-token-999";
    let issue_srv = MockIssueServer::start();
    let vdp_host = MockVdpHost::start(secret_token);
    let isolated_home = tempfile::tempdir().unwrap();
    let vdp_home_str = vdp_host.home_dir.path().to_str().unwrap();

    let mut mcp = McpProcess::spawn(isolated_home.path(), &issue_srv.url, &["--home", vdp_home_str]);

    // 1. Initialize handshake & notifications/initialized (must not emit a response).
    let init = mcp.request(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-03-26",
            "clientInfo": { "name": "agy-test", "version": "1.0.0" }
        }),
    );
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["serverInfo"]["name"], "vibevalley");
    assert!(init["result"]["capabilities"]["tools"].is_object());

    mcp.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    let ping = mcp.request(2, "ping", json!({}));
    assert_eq!(ping["result"], json!({}));

    // 2. tools/list exposes the complete Issues + VDP tool surface.
    let list_resp = mcp.request(3, "tools/list", json!({}));
    let tools = list_resp["result"]["tools"].as_array().unwrap();
    let tool_names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for expected in [
        "vv_issue_list",
        "vv_issue_get",
        "vv_issue_create",
        "vv_issue_update",
        "vv_issue_comment",
        "vv_attachment_upload",
        "vv_vdp_discover",
        "vv_vdp_targets",
        "vv_vdp_state",
        "vv_vdp_navigate",
        "vv_vdp_resize",
        "vv_vdp_theme",
        "vv_vdp_ui_query",
        "vv_vdp_ui_press",
        "vv_vdp_screenshot",
        "vv_vdp_input",
        "vv_vdp_call",
    ] {
        assert!(tool_names.contains(&expected), "missing tool {expected} in {tool_names:?}");
    }

    // 3. Issues workflow: create (with status transition), list (filtered by agent & status), get, update, comment.
    let created = mcp.call_tool(
        10,
        "vv_issue_create",
        json!({
            "title": "Fix rail active highlight",
            "description": "Captured via VDP scan",
            "priority": "high",
            "status": "todo",
            "repo": "vibevalley",
            "agent": "frontend",
            "criteria": ["Left indicator bar matches rail geometry"]
        }),
    );
    assert_ne!(created["isError"], true, "{created}");
    let created_json: Value = serde_json::from_str(created["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(created_json["number"], 1);
    assert_eq!(created_json["status"], "todo");
    assert_eq!(created_json["priority"], "high");

    let _second = mcp.call_tool(
        11,
        "vv_issue_create",
        json!({
            "title": "Backend cleanup",
            "agent": "backend",
            "repo": "vibevalley"
        }),
    );

    let listed = mcp.call_tool(12, "vv_issue_list", json!({ "status": "todo", "agent": "frontend" }));
    assert_ne!(listed["isError"], true, "{listed}");
    let listed_json: Value = serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listed_json["count"], 1);
    assert_eq!(listed_json["issues"][0]["title"], "Fix rail active highlight");

    let got = mcp.call_tool(13, "vv_issue_get", json!({ "id": "#1" }));
    assert_ne!(got["isError"], true, "{got}");
    let got_json: Value = serde_json::from_str(got["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(got_json["criteria"], json!(["Left indicator bar matches rail geometry"]));

    let updated = mcp.call_tool(
        14,
        "vv_issue_update",
        json!({
            "id": "1",
            "title": "Fix rail active highlight (verified)",
            "status": "done",
            "priority": "medium"
        }),
    );
    assert_ne!(updated["isError"], true, "{updated}");
    let updated_json: Value = serde_json::from_str(updated["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(updated_json["status"], "done");
    assert_eq!(updated_json["title"], "Fix rail active highlight (verified)");

    let commented = mcp.call_tool(15, "vv_issue_comment", json!({ "issueId": "1", "text": "Verified on round 2 screenshot" }));
    assert_ne!(commented["isError"], true, "{commented}");
    assert_eq!(issue_srv.comments.lock().len(), 1);

    // Upload a local PNG via vv_attachment_upload and post a compare comment with attachments.
    let local_png = isolated_home.path().join("before.png");
    std::fs::write(&local_png, &vdp_host.png_bytes).unwrap();
    let uploaded = mcp.call_tool(16, "vv_attachment_upload", json!({ "path": local_png.to_str().unwrap(), "name": "before.png" }));
    assert_ne!(uploaded["isError"], true, "{uploaded}");
    let uploaded_json: Value = serde_json::from_str(uploaded["content"][0]["text"].as_str().unwrap()).unwrap();
    let before_att_id = uploaded_json["id"].as_str().unwrap().to_string();
    assert_eq!(uploaded_json["type"], "image/png");
    assert_eq!(uploaded_json["size"], vdp_host.png_bytes.len() as i64);

    let commented_with_att = mcp.call_tool(
        17,
        "vv_issue_comment",
        json!({
            "issueId": "1",
            "text": "Before/after comparison attached",
            "attachments": [before_att_id]
        }),
    );
    assert_ne!(commented_with_att["isError"], true, "{commented_with_att}");
    assert_eq!(issue_srv.channel_messages.lock().len(), 1);
    assert_eq!(issue_srv.channel_messages.lock()[0].attachments.as_deref(), Some(&["att-1".to_string()][..]));

    // 4. VDP live debugging: discover (no token leak!), targets, state, navigate, resize, theme, ui_query, ui_press, input, call.
    let discovered = mcp.call_tool(20, "vv_vdp_discover", json!({}));
    assert_ne!(discovered["isError"], true, "{discovered}");
    let disc_text = discovered["content"][0]["text"].as_str().unwrap();
    assert!(!disc_text.contains(secret_token), "vv_vdp_discover leaked token: {disc_text}");
    let disc_json: Value = serde_json::from_str(disc_text).unwrap();
    assert!(
        disc_json["instances"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["port"] == vdp_host.info.port && i.get("token").is_none()),
        "{disc_json}"
    );

    let targets = mcp.call_tool(21, "vv_vdp_targets", json!({}));
    let targets_json: Value = serde_json::from_str(targets["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(targets_json["targets"].as_array().unwrap().len(), 2);

    let state = mcp.call_tool(22, "vv_vdp_state", json!({}));
    let state_text = state["content"][0]["text"].as_str().unwrap();
    assert!(!state_text.contains(secret_token));
    let state_json: Value = serde_json::from_str(state_text).unwrap();
    assert_eq!(state_json["route"], "/issues");

    let nav = mcp.call_tool(23, "vv_vdp_navigate", json!({ "route": "/library" }));
    assert_ne!(nav["isError"], true, "{nav}");
    let resize = mcp.call_tool(24, "vv_vdp_resize", json!({ "width": 1280, "height": 800 }));
    assert_ne!(resize["isError"], true, "{resize}");
    let theme = mcp.call_tool(25, "vv_vdp_theme", json!({ "mode": "dark" }));
    assert_ne!(theme["isError"], true, "{theme}");

    let query = mcp.call_tool(26, "vv_vdp_ui_query", json!({ "testId": "nav-issues", "view": "workbench" }));
    let query_json: Value = serde_json::from_str(query["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(query_json["nodes"][0]["bounds"]["width"], 120.0);

    let press = mcp.call_tool(27, "vv_vdp_ui_press", json!({ "testId": "nav-issues" }));
    let press_json: Value = serde_json::from_str(press["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(press_json["pressed"], true);

    assert_ne!(mcp.call_tool(28, "vv_vdp_input", json!({ "kind": "key", "keys": "cmd-k" }))["isError"], true);
    assert_ne!(mcp.call_tool(29, "vv_vdp_input", json!({ "kind": "type", "text": "hello" }))["isError"], true);
    assert_ne!(
        mcp.call_tool(30, "vv_vdp_input", json!({ "kind": "click", "x": 100, "y": 200, "right": true }))["isError"],
        true
    );

    let raw = mcp.call_tool(
        31,
        "vv_vdp_call",
        json!({ "method": "Custom.echo", "params": { "a": 1 }, "sessionId": "sess-9" }),
    );
    let raw_json: Value = serde_json::from_str(raw["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(raw_json["echo"]["a"], 1);
    assert_eq!(raw_json["sessionId"], "sess-9");

    // 5. Screenshot returns BOTH inline MCP image block and text summary, writes exact PNG bytes to outPath,
    // and optionally uploads via attachment.create when uploadAttachment=true.
    let shot_dir = tempfile::tempdir().unwrap();
    let out_path = shot_dir.path().join("captures").join("live.png");
    let shot = mcp.call_tool(
        32,
        "vv_vdp_screenshot",
        json!({
            "target": "shell",
            "width": 1280,
            "height": 800,
            "outPath": out_path.to_str().unwrap(),
            "uploadAttachment": true
        }),
    );
    assert_ne!(shot["isError"], true, "{shot}");
    let blocks = shot["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2, "{shot}");
    assert_eq!(blocks[0]["type"], "image");
    assert_eq!(blocks[0]["mimeType"], "image/png");
    let decoded = base64::engine::general_purpose::STANDARD.decode(blocks[0]["data"].as_str().unwrap()).unwrap();
    assert_eq!(decoded, vdp_host.png_bytes);
    assert_eq!(std::fs::read(&out_path).unwrap(), vdp_host.png_bytes);
    let summary = blocks[1]["text"].as_str().unwrap();
    assert!(summary.contains("1280x800"), "{summary}");
    assert!(summary.contains(out_path.to_str().unwrap()), "{summary}");
    assert!(summary.contains("attachmentId=att-2"), "{summary}");
    assert!(!summary.contains(secret_token));
    assert_eq!(issue_srv.attachments.lock().len(), 2);

    // 6. Error resilience & secret scrubbing: RPC/VDP failures return isError: true without crashing the loop.
    let missing_issue = mcp.call_tool(40, "vv_issue_get", json!({ "id": "999" }));
    assert_eq!(missing_issue["isError"], true, "{missing_issue}");

    let empty_home = tempfile::tempdir().unwrap();
    let unreachable_vdp = mcp.call_tool(41, "vv_vdp_state", json!({ "home": empty_home.path().to_str().unwrap() }));
    assert_eq!(unreachable_vdp["isError"], true, "{unreachable_vdp}");

    let scrubbed_err = mcp.call_tool(42, "vv_vdp_call", json!({ "method": "Custom.leakCheck" }));
    assert_eq!(scrubbed_err["isError"], true, "{scrubbed_err}");
    let err_text = scrubbed_err["content"][0]["text"].as_str().unwrap();
    assert!(!err_text.contains(secret_token), "VDP error leaked token: {err_text}");
    assert!(err_text.contains("[redacted]"), "expected redaction marker: {err_text}");

    let bad_args = mcp.call_tool(43, "vv_vdp_resize", json!({ "width": -10, "height": 500 }));
    assert_eq!(bad_args["isError"], true, "{bad_args}");

    // Malformed JSON line yields JSON-RPC -32700 parse error and server continues serving.
    mcp.send_raw("{broken-json");
    let parse_err = mcp.recv();
    assert_eq!(parse_err["error"]["code"], -32700, "{parse_err}");

    let alive = mcp.request(44, "ping", json!({}));
    assert_eq!(alive["result"], json!({}));

    // Verify expected VDP methods reached the mock host.
    let recorded_methods: Vec<String> = vdp_host.recorded.lock().iter().map(|r| r.method.clone()).collect();
    assert!(recorded_methods.contains(&"Shell.getState".to_string()));
    assert!(recorded_methods.contains(&"Page.captureScreenshot".to_string()));
    assert!(recorded_methods.contains(&"UI.query".to_string()));
    assert!(recorded_methods.contains(&"UI.press".to_string()));

    assert_eq!(mcp.finish(), 0);
}
