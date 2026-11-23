//! Mock-HTTP end-to-end tests for `vibevalley auth`, `vibevalley remote`, credentials storage,
//! target/token precedence, non-leakage across servers, and Bearer header propagation.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_util::sync::{CancellationToken, DropGuard};

#[derive(Debug, Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

impl RecordedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(String::as_str)
    }

    fn json_body(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

struct MockResponse(Response);

impl MockResponse {
    fn ok_envelope(data: Value) -> Self {
        Self::ok_json(json!({ "bizCode": 0, "message": "ok", "data": data }))
    }

    fn ok_void() -> Self {
        Self::ok_json(json!({ "bizCode": 0, "message": "ok" }))
    }

    fn ok_json(data: Value) -> Self {
        Self((StatusCode::OK, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], data.to_string()).into_response())
    }

    fn ok_bytes(content_type: &'static str, bytes: &[u8]) -> Self {
        Self((StatusCode::OK, [(header::CONTENT_TYPE, content_type)], bytes.to_vec()).into_response())
    }

    fn sse_event(data: Value) -> Self {
        let stream = futures_util::stream::once(async move { Ok::<_, Infallible>(Event::default().data(data.to_string())) });
        Self(Sse::new(stream).into_response())
    }

    fn error(status: u16, biz_code: u32, message: &str) -> Self {
        let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = json!({ "bizCode": biz_code, "message": message }).to_string();
        Self((code, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], body).into_response())
    }
}

struct MockServer {
    url: String,
    recorded: Arc<Mutex<Vec<RecordedRequest>>>,
    _guard: DropGuard,
}

impl MockServer {
    fn start(handler: impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static) -> Self {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let recorded_bg = recorded.clone();
        let handler = Arc::new(handler);

        let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let recorded_bg = recorded_bg.clone();
            let handler = handler.clone();
            async move {
                let req = RecordedRequest {
                    method: method.to_string(),
                    path: uri.path_and_query().map_or_else(|| uri.path().to_string(), ToString::to_string),
                    headers: headers
                        .iter()
                        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
                        .collect(),
                    body: String::from_utf8_lossy(&body).to_string(),
                };
                recorded_bg.lock().unwrap().push(req.clone());
                handler(&req).0
            }
        });

        let (url, _guard) = vibevalley_runtime::rt::block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let cancel = CancellationToken::new();
            let guard = cancel.clone().drop_guard();
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
            });
            (format!("http://{addr}"), guard)
        });

        Self { url, recorded, _guard }
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.recorded.lock().unwrap().clone()
    }

    fn clear(&self) {
        self.recorded.lock().unwrap().clear();
    }
}

struct Ran {
    code: i32,
    out: String,
    raw_out: Vec<u8>,
    stderr: String,
    failure: Option<Value>,
}

impl Ran {
    fn tag(&self) -> &str {
        self.failure.as_ref().and_then(|f| f["error"]["tag"].as_str()).unwrap_or("")
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.out).unwrap_or_else(|e| panic!("invalid JSON stdout: {e}\nstdout: {}\nstderr: {}", self.out, self.stderr))
    }
}

fn cli(home: &Path, args: &[&str], env: &[(&str, &str)]) -> Ran {
    let output = Command::new(env!("CARGO_BIN_EXE_vibevalley"))
        .args(args)
        .env("VIBEVALLEY_HOME", home)
        .env_remove("VIBEVALLEY_SERVER")
        .env_remove("VIBEVALLEY_REMOTE_TOKEN")
        .env_remove("DEEPSEEK_API_KEY")
        .envs(env.iter().copied())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ran {
        code: output.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
        raw_out: output.stdout,
        failure: stderr.lines().last().and_then(|l| serde_json::from_str(l).ok()),
        stderr,
    }
}

#[test]
fn auth_login_code_pair_url_token_whoami_status_and_logout_round_trip() {
    let valid_token = "vv_dev_cli_test_token_0123456789abcdef";
    let token_login_val = "vv_dev_direct_token_fedcba9876543210";
    let srv = MockServer::start(move |req| match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/v1/remote/pair/exchange") => {
            let body = req.json_body();
            let scope = body["scope"].as_str().unwrap_or("remote:default");
            let name = body["deviceName"].as_str().unwrap_or("cli");
            MockResponse::ok_envelope(json!({
                "device": {
                    "id": "dev_cli_001",
                    "name": name,
                    "platform": "cli",
                    "scope": scope,
                    "createdAt": 1700000000000i64
                },
                "token": valid_token,
                "serverName": "Lucas Mac Studio",
                "version": "0.2.0"
            }))
        }
        ("GET", "/api/v1/health") => MockResponse::ok_json(json!({ "ok": true, "version": "0.2.0" })),
        ("POST", "/api/v1/remote/whoami") => match req.header("authorization") {
            Some(auth) if auth == format!("Bearer {valid_token}") => MockResponse::ok_envelope(json!({
                "device": {
                    "id": "dev_cli_001",
                    "name": "my-laptop",
                    "platform": "cli",
                    "scope": "remote:default",
                    "createdAt": 1700000000000i64
                },
                "caller": "remote",
                "serverName": "Lucas Mac Studio",
                "version": "0.2.0",
                "channel": "dev"
            })),
            Some(auth) if auth == format!("Bearer {token_login_val}") => MockResponse::ok_envelope(json!({
                "device": {
                    "id": "dev_direct_99",
                    "name": "ci-runner",
                    "platform": "cli",
                    "scope": "remote:runtime",
                    "createdAt": 1700000000000i64
                },
                "caller": "remote",
                "serverName": "Build Hub",
                "version": "0.2.0",
                "channel": "dev"
            })),
            Some(_) => MockResponse::error(401, 40100, "invalid bearer token"),
            None => MockResponse::ok_envelope(json!({
                "caller": "user",
                "serverName": "Lucas Mac Studio",
                "version": "0.2.0",
                "channel": "dev"
            })),
        },
        ("POST", "/api/v1/remote/device/revoke") => MockResponse::ok_void(),
        _ => MockResponse::error(404, 40400, "not found"),
    });

    let home = tempfile::tempdir().unwrap();

    // 1. Pair with SERVER_URL + --code + --name + --json
    let logged_in = cli(
        home.path(),
        &["auth", "login", &srv.url, "--code", "ABC234", "--name", "my-laptop", "--json"],
        &[],
    );
    assert_eq!(logged_in.code, 0, "stderr: {}", logged_in.stderr);
    assert!(
        !logged_in.out.contains(valid_token) && !logged_in.stderr.contains(valid_token),
        "raw token leaked into CLI output!"
    );
    let login_json = logged_in.json();
    assert_eq!(login_json["server"], srv.url);
    assert_eq!(login_json["deviceId"], "dev_cli_001");
    assert_eq!(login_json["deviceName"], "my-laptop");
    assert_eq!(login_json["serverName"], "Lucas Mac Studio");
    assert_eq!(login_json["scope"], "remote:default");

    // Verify wire request shape for pair exchange
    let reqs = srv.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].path, "/api/v1/remote/pair/exchange");
    assert_eq!(reqs[0].header("authorization"), None);
    let ex_body = reqs[0].json_body();
    assert_eq!(ex_body["code"], "ABC234");
    assert_eq!(ex_body["deviceName"], "my-laptop");
    assert_eq!(ex_body["platform"], "cli");
    assert_eq!(ex_body["scope"], "remote:default");

    // Verify auth.json exists with 0600 permissions and expected schema
    let auth_file = home.path().join("auth.json");
    assert!(auth_file.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&auth_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&auth_file).unwrap()).unwrap();
    assert_eq!(stored["server"], srv.url);
    assert_eq!(stored["token"], valid_token);
    assert_eq!(stored["device_id"], "dev_cli_001");
    assert_eq!(stored["device_name"], "my-laptop");
    assert_eq!(stored["server_name"], "Lucas Mac Studio");
    assert_eq!(stored["scope"], "remote:default");

    // 2. auth whoami & auth status (without --server: picks up auth.json!)
    srv.clear();
    let whoami = cli(home.path(), &["auth", "whoami", "--json"], &[]);
    assert_eq!(whoami.code, 0, "stderr: {}", whoami.stderr);
    assert!(!whoami.out.contains(valid_token));
    let wj = whoami.json();
    assert_eq!(wj["server"], srv.url);
    assert_eq!(wj["authMode"], "remote-bearer");
    assert_eq!(wj["deviceId"], "dev_cli_001");
    assert_eq!(wj["deviceName"], "my-laptop");
    assert_eq!(wj["scope"], "remote:default");
    assert_eq!(wj["connected"], true);
    assert_eq!(wj["authenticated"], true);
    assert_eq!(wj["caller"], "remote");

    let reqs = srv.requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("GET", "/api/v1/health"));
    assert_eq!(reqs[0].header("authorization"), Some(format!("Bearer {valid_token}").as_str()));
    assert_eq!((reqs[1].method.as_str(), reqs[1].path.as_str()), ("POST", "/api/v1/remote/whoami"));
    assert_eq!(reqs[1].header("authorization"), Some(format!("Bearer {valid_token}").as_str()));

    // Bad --token rejected by whoami (exit 3 REFUSED), while status exits 0 with authenticated=false
    let bad_whoami = cli(home.path(), &["auth", "whoami", "--token", "vv_dev_wrong_token", "--json"], &[]);
    assert_eq!((bad_whoami.code, bad_whoami.tag()), (3, "Unauthorized"));
    assert_eq!(bad_whoami.json()["authenticated"], false);

    let bad_status = cli(home.path(), &["auth", "status", "--token", "vv_dev_wrong_token", "--json"], &[]);
    assert_eq!(bad_status.code, 0, "stderr: {}", bad_status.stderr);
    assert_eq!(bad_status.json()["authenticated"], false);
    assert_eq!(bad_status.json()["connected"], true);

    // 3. auth login --pair-url with custom --scope
    srv.clear();
    let encoded_url = srv.url.replace(':', "%3A").replace('/', "%2F");
    let pair_url = format!("vibevalley://pair?url={encoded_url}&code=XYZ789");
    let paired = cli(
        home.path(),
        &["auth", "login", "--pair-url", &pair_url, "--scope", "remote:runtime", "--json"],
        &[],
    );
    assert_eq!(paired.code, 0, "stderr: {}", paired.stderr);
    assert_eq!(paired.json()["scope"], "remote:runtime");
    let reqs = srv.requests();
    assert_eq!(reqs[0].json_body()["code"], "XYZ789");
    assert_eq!(reqs[0].json_body()["scope"], "remote:runtime");
    assert_eq!(reqs[0].header("authorization"), None);

    // 4. auth login --token (validates token directly against server)
    srv.clear();
    let bad_tok_login = cli(home.path(), &["auth", "login", &srv.url, "--token", "vv_dev_bad"], &[]);
    assert_eq!(bad_tok_login.code, 3);

    let tok_login = cli(home.path(), &["auth", "login", &srv.url, "--token", token_login_val, "--json"], &[]);
    assert_eq!(tok_login.code, 0, "stderr: {}", tok_login.stderr);
    assert!(!tok_login.out.contains(token_login_val));
    assert_eq!(tok_login.json()["deviceId"], "dev_direct_99");
    assert_eq!(tok_login.json()["deviceName"], "ci-runner");
    assert_eq!(tok_login.json()["scope"], "remote:runtime");

    // 5. auth logout --revoke calls remote.device.revoke then removes auth.json; second logout is idempotent
    srv.clear();
    let out1 = cli(home.path(), &["auth", "logout", "--revoke", "--json"], &[]);
    assert_eq!(out1.code, 0, "stderr: {}", out1.stderr);
    let o1 = out1.json();
    assert_eq!(o1["removed"], true);
    assert_eq!(o1["revoked"], true);
    assert_eq!(o1["deviceId"], "dev_direct_99");
    assert!(!auth_file.exists());
    let reqs = srv.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].path, "/api/v1/remote/device/revoke");
    assert_eq!(reqs[0].json_body()["id"], "dev_direct_99");

    let out2 = cli(home.path(), &["auth", "logout", "--json"], &[]);
    assert_eq!(out2.code, 0);
    assert_eq!(out2.json()["removed"], false);

    // 6. After logout, auth status against --server reports local-loopback
    let local_status = cli(home.path(), &["auth", "status", "--server", &srv.url, "--json"], &[]);
    assert_eq!(local_status.code, 0);
    let ls = local_status.json();
    assert_eq!(ls["authMode"], "local-loopback");
    assert_eq!(ls["connected"], true);
    assert_eq!(ls["caller"], "user");
}

#[test]
fn target_precedence_bearer_delivery_and_no_token_leak_to_different_server() {
    let token_a = "vv_dev_server_a_secret_token_111111";
    let token_env = "vv_dev_env_override_token_222222";
    let token_flag = "vv_dev_flag_override_token_333333";

    let server_a = MockServer::start(|req| match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/v1/issue/list") => MockResponse::ok_envelope(json!([])),
        ("GET", "/api/v1/attachment/att-1") => MockResponse::ok_bytes("text/plain", b"secret-bytes"),
        ("GET", "/api/v1/slice/board") => MockResponse::sse_event(json!({ "seq": 7, "issues": [] })),
        _ => MockResponse::error(404, 40400, "not found"),
    });
    let server_b = MockServer::start(|req| match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/v1/issue/list") => MockResponse::ok_envelope(json!([])),
        ("GET", "/api/v1/health") => MockResponse::error(405, 40500, "use POST"),
        ("POST", "/api/v1/server/health/get") => MockResponse::ok_envelope(json!({ "ok": true, "version": "0.9.9" })),
        ("POST", "/api/v1/remote/whoami") => MockResponse::ok_envelope(json!({
            "caller": "user",
            "serverName": "Local Mac",
            "version": "0.9.9",
            "channel": "dev"
        })),
        _ => MockResponse::error(404, 40400, "not found"),
    });

    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("auth.json"),
        json!({
            "server": server_a.url,
            "token": token_a,
            "device_id": "dev_a",
            "device_name": "macbook",
            "scope": "remote:default"
        })
        .to_string(),
    )
    .unwrap();

    // 1. Default invocation uses auth.json server + Bearer token across POST RPC, attachment download, and SSE stream
    let list_a = cli(home.path(), &["issue", "list", "--json"], &[]);
    assert_eq!(list_a.code, 0, "stderr: {}", list_a.stderr);

    let dl_a = cli(home.path(), &["attachment", "get", "att-1"], &[]);
    assert_eq!(dl_a.code, 0, "stderr: {}", dl_a.stderr);
    assert_eq!(dl_a.raw_out, b"secret-bytes");

    let sse_a = cli(home.path(), &["state", "--slice", "board", "--watch", "--timeout", "1", "--json"], &[]);
    assert!(sse_a.out.contains("\"seq\":7"), "sse stdout: {} stderr: {}", sse_a.out, sse_a.stderr);

    let reqs_a = server_a.requests();
    assert_eq!(reqs_a.len(), 3);
    for req in &reqs_a {
        assert_eq!(
            req.header("authorization"),
            Some(format!("Bearer {token_a}").as_str()),
            "missing Bearer on {} {}",
            req.method,
            req.path
        );
    }

    // 2. --server matching normalized auth.json (with trailing slash) STILL attaches stored token
    server_a.clear();
    let with_slash = format!("{}/", server_a.url);
    let same_match = cli(home.path(), &["--server", &with_slash, "issue", "list", "--json"], &[]);
    assert_eq!(same_match.code, 0);
    assert_eq!(server_a.requests()[0].header("authorization"), Some(format!("Bearer {token_a}").as_str()));

    // 3. --server pointing to a DIFFERENT server MUST NOT leak auth.json token!
    let list_b = cli(home.path(), &["--server", &server_b.url, "issue", "list", "--json"], &[]);
    assert_eq!(list_b.code, 0, "stderr: {}", list_b.stderr);
    assert_eq!(
        server_b.requests()[0].header("authorization"),
        None,
        "stored token leaked to different --server!"
    );

    // 4. VIBEVALLEY_SERVER pointing to server_b ALSO MUST NOT leak auth.json token!
    server_b.clear();
    let list_b_env = cli(home.path(), &["issue", "list", "--json"], &[("VIBEVALLEY_SERVER", &server_b.url)]);
    assert_eq!(list_b_env.code, 0);
    assert_eq!(
        server_b.requests()[0].header("authorization"),
        None,
        "stored token leaked to different VIBEVALLEY_SERVER!"
    );

    // 5. Explicit --token beats VIBEVALLEY_REMOTE_TOKEN which beats auth.json
    server_a.clear();
    let env_tok_res = cli(home.path(), &["issue", "list", "--json"], &[("VIBEVALLEY_REMOTE_TOKEN", token_env)]);
    assert_eq!(env_tok_res.code, 0);
    assert_eq!(server_a.requests()[0].header("authorization"), Some(format!("Bearer {token_env}").as_str()));

    server_a.clear();
    let flag_tok_res = cli(
        home.path(),
        &["--token", token_flag, "issue", "list", "--json"],
        &[("VIBEVALLEY_REMOTE_TOKEN", token_env)],
    );
    assert_eq!(flag_tok_res.code, 0);
    assert_eq!(server_a.requests()[0].header("authorization"), Some(format!("Bearer {token_flag}").as_str()));

    // 6. Health probe falls back to POST /api/v1/server/health/get when GET /api/v1/health returns 405
    server_b.clear();
    let fallback_whoami = cli(home.path(), &["--server", &server_b.url, "auth", "whoami", "--json"], &[]);
    assert_eq!(fallback_whoami.code, 0, "stderr: {}", fallback_whoami.stderr);
    let fw = fallback_whoami.json();
    assert_eq!(fw["connected"], true);
    assert_eq!(fw["version"], "0.9.9");
    assert_eq!(fw["authMode"], "local-loopback");
    let b_paths: Vec<String> = server_b.requests().into_iter().map(|r| r.path).collect();
    assert!(b_paths.iter().any(|p| p == "/api/v1/health"));
    assert!(b_paths.iter().any(|p| p == "/api/v1/server/health/get"));
}

#[test]
fn remote_subcommands_status_enable_disable_code_and_revoke() {
    let srv = MockServer::start(|req| match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/v1/remote/status") => MockResponse::ok_envelope(json!({
            "enabled": true,
            "listening": true,
            "bindAddr": "100.64.0.5",
            "port": 8890,
            "tailscaleIp": "100.64.0.5",
            "tailscaleHost": "mac-studio.tailnet.ts.net",
            "tailscaleOnline": true,
            "url": "http://100.64.0.5:8890",
            "devices": [{
                "id": "dev_phone_1",
                "name": "iPhone",
                "platform": "ios",
                "scope": "remote:default",
                "createdAt": 1700000000000i64
            }]
        })),
        ("POST", "/api/v1/remote/enable") => {
            let body = req.json_body();
            let bind = body["bindAddr"].as_str().unwrap_or("127.0.0.1");
            let port = body["port"].as_u64().unwrap_or(8890);
            MockResponse::ok_envelope(json!({
                "enabled": true,
                "listening": true,
                "bindAddr": bind,
                "port": port,
                "tailscaleOnline": false,
                "url": format!("http://{bind}:{port}"),
                "devices": []
            }))
        }
        ("POST", "/api/v1/remote/disable") => MockResponse::ok_envelope(json!({
            "enabled": false,
            "listening": false,
            "port": 8890,
            "tailscaleOnline": false,
            "devices": []
        })),
        ("POST", "/api/v1/remote/pair/create") => {
            let body = req.json_body();
            let scope = body.get("scope").and_then(Value::as_str).unwrap_or("remote:default");
            MockResponse::ok_envelope(json!({
                "code": "K7P9M2",
                "pairUrl": "vibevalley://pair?url=http%3A%2F%2F100.64.0.5%3A8890&code=K7P9M2",
                "url": "http://100.64.0.5:8890",
                "expiresAt": 1700000300000i64,
                "scope": scope
            }))
        }
        ("POST", "/api/v1/remote/device/revoke") => MockResponse::ok_void(),
        _ => MockResponse::error(404, 40400, "not found"),
    });

    let home = tempfile::tempdir().unwrap();

    // remote status (text & json)
    let st_text = cli(home.path(), &["--server", &srv.url, "remote", "status"], &[]);
    assert_eq!(st_text.code, 0, "stderr: {}", st_text.stderr);
    assert!(st_text.out.contains("enabled") && st_text.out.contains("dev_phone_1"), "{}", st_text.out);
    let st_json = cli(home.path(), &["--server", &srv.url, "remote", "status", "--json"], &[]).json();
    assert_eq!(st_json["enabled"], true);
    assert_eq!(st_json["devices"][0]["id"], "dev_phone_1");

    // remote enable
    let en = cli(
        home.path(),
        &["--server", &srv.url, "remote", "enable", "--bind", "127.0.0.1", "--port", "8891", "--json"],
        &[],
    );
    assert_eq!(en.code, 0, "stderr: {}", en.stderr);
    assert_eq!(en.json()["port"], 8891);

    // remote disable
    let dis = cli(home.path(), &["--server", &srv.url, "remote", "disable", "--json"], &[]);
    assert_eq!(dis.code, 0, "stderr: {}", dis.stderr);
    assert_eq!(dis.json()["enabled"], false);

    // remote code [--scope]
    srv.clear();
    let code_text = cli(home.path(), &["--server", &srv.url, "remote", "code", "--scope", "remote:runtime"], &[]);
    assert_eq!(code_text.code, 0, "stderr: {}", code_text.stderr);
    assert!(code_text.out.contains("K7P9M2"), "{}", code_text.out);
    assert!(code_text.out.contains("vibevalley://pair?"), "{}", code_text.out);
    assert!(code_text.out.contains("remote:runtime"), "{}", code_text.out);
    assert_eq!(srv.requests()[0].path, "/api/v1/remote/pair/create");
    assert_eq!(srv.requests()[0].json_body()["scope"], "remote:runtime");

    let code_json = cli(home.path(), &["--server", &srv.url, "remote", "code", "--json"], &[]).json();
    assert_eq!(code_json["code"], "K7P9M2");

    // remote revoke
    srv.clear();
    let rev = cli(home.path(), &["--server", &srv.url, "remote", "revoke", "dev_phone_1"], &[]);
    assert_eq!(rev.code, 0, "stderr: {}", rev.stderr);
    assert!(rev.out.contains("revoked dev_phone_1"), "{}", rev.out);
    assert_eq!(srv.requests()[0].path, "/api/v1/remote/device/revoke");
    assert_eq!(srv.requests()[0].json_body()["id"], "dev_phone_1");
}

#[test]
fn auth_logout_revoke_still_removes_auth_json_when_server_refuses() {
    let srv = MockServer::start(|_| MockResponse::error(403, 40300, "forbidden"));
    let home = tempfile::tempdir().unwrap();
    let auth_file = home.path().join("auth.json");
    std::fs::write(
        &auth_file,
        json!({
            "server": srv.url,
            "token": "vv_dev_some_token_123456",
            "device_id": "dev_x",
            "device_name": "box"
        })
        .to_string(),
    )
    .unwrap();

    let out = cli(home.path(), &["auth", "logout", "--revoke", "--json"], &[]);
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    let body = out.json();
    assert_eq!(body["removed"], true);
    assert_eq!(body["revoked"], false);
    assert!(body["revokeError"].is_string());
    assert!(!auth_file.exists());
}
