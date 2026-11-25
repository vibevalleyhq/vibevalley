//! Standalone local HTTP server for interactive UML exploration (`cargo xtask uml viewer`).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use serde::{Deserialize, Serialize};

use super::{
    Policy, ProposalEval, TopologyIr, compute_metrics_mtime_stamp, evaluate_proposals, generate_ir, load_or_init_policy, policy_path, render_svg, topology_path,
};
use crate::qa::lang::locate_member;
use crate::qa::{Lang, crap_snapshot_path, read_json, write_json};

const VIEWER_HTML: &str = include_str!("viewer.html");

#[derive(Debug, Clone, Serialize)]
pub struct ViewerState {
    pub policy: Policy,
    pub ir: TopologyIr,
    pub metrics_mtime: String,
    pub proposals_eval: Vec<ProposalEval>,
}

#[derive(Debug, Deserialize)]
struct PolicyUpdateRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    hierarchical: Option<bool>,
    #[serde(default)]
    foreign: Option<Vec<String>>,
    #[serde(default)]
    order: Option<Vec<String>>,
    #[serde(default)]
    levels: Option<Vec<Vec<String>>>,
    #[serde(default)]
    omit: Option<Vec<String>>,
    #[serde(default)]
    edge_kinds: Option<std::collections::BTreeMap<String, super::EdgeKind>>,
    #[serde(default)]
    proposals: Option<Vec<super::Proposal>>,
}

#[derive(Debug, Deserialize)]
struct ActionRequest {
    action: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
}

#[derive(Debug, Serialize)]
struct ActionResponse {
    ok: bool,
    action: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    state: ViewerState,
}

struct ServerContext {
    root: PathBuf,
    lock: Mutex<()>,
}

pub struct ViewerServer {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl ViewerServer {
    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn shutdown(mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ViewerServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if self.handle.is_some() {
            let _ = TcpStream::connect(self.addr);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }
}

pub fn build_viewer_state(root: &Path, force_regen: bool) -> Result<ViewerState, String> {
    let policy = load_or_init_policy(root)?;
    let topo_file = topology_path(root);
    let ir = if force_regen || !topo_file.exists() {
        generate_ir(root, &policy, &[])?
    } else {
        match read_json::<TopologyIr>(&topo_file) {
            Ok(existing) => existing,
            Err(_) => generate_ir(root, &policy, &[])?,
        }
    };
    let proposals_eval = evaluate_proposals(&ir, &policy.proposals);
    let metrics_mtime = compute_metrics_mtime_stamp(root);
    Ok(ViewerState {
        policy,
        ir,
        metrics_mtime,
        proposals_eval,
    })
}

pub fn start_server(root: &Path, port: u16) -> Result<ViewerServer, String> {
    let bind_addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&bind_addr).map_err(|err| format!("failed to bind {bind_addr}: {err}"))?;
    let addr = listener.local_addr().map_err(|err| format!("failed to inspect local address: {err}"))?;

    // Ensure initial policy & IR exist before accepting requests.
    let _ = build_viewer_state(root, false)?;

    let ctx = Arc::new(ServerContext {
        root: root.to_path_buf(),
        lock: Mutex::new(()),
    });
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_flag = Arc::clone(&shutdown);

    let handle = thread::spawn(move || {
        for incoming in listener.incoming() {
            if shutdown_flag.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = incoming else {
                continue;
            };
            if shutdown_flag.load(Ordering::SeqCst) {
                break;
            }
            let ctx_clone = Arc::clone(&ctx);
            thread::spawn(move || {
                handle_connection(stream, &ctx_clone);
            });
        }
    });

    Ok(ViewerServer {
        addr,
        shutdown,
        handle: Some(handle),
    })
}

struct HttpRequest {
    method: String,
    path: String,
    query: String,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    let n = reader
        .read_line(&mut request_line)
        .map_err(|err| format!("failed to read request line: {err}"))?;
    if n == 0 {
        return Err("empty request".to_owned());
    }
    let mut parts = request_line.trim_end_matches(['\r', '\n']).split_whitespace();
    let method = parts.next().unwrap_or("GET").to_ascii_uppercase();
    let target = parts.next().unwrap_or("/");
    let (path, query) = target
        .split_once('?')
        .map_or((target.to_owned(), String::new()), |(p, q)| (p.to_owned(), q.to_owned()));

    let mut content_length = 0usize;
    loop {
        let mut header_line = String::new();
        let read = reader.read_line(&mut header_line).map_err(|err| format!("failed to read header: {err}"))?;
        if read == 0 || header_line == "\r\n" || header_line == "\n" {
            break;
        }
        if let Some((name, val)) = header_line.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
            && let Ok(len) = val.trim().parse::<usize>()
        {
            content_length = len.min(8 * 1024 * 1024);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).map_err(|err| format!("failed to read body: {err}"))?;
    }

    Ok(HttpRequest { method, path, query, body })
}

fn send_response(stream: &mut TcpStream, status: u16, status_text: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn send_json<T: Serialize>(stream: &mut TcpStream, status: u16, status_text: &str, value: &T) {
    match serde_json::to_vec(value) {
        Ok(bytes) => send_response(stream, status, status_text, "application/json; charset=utf-8", &bytes),
        Err(err) => send_error(stream, 500, "Internal Server Error", &format!("JSON serialization failed: {err}")),
    }
}

fn send_error(stream: &mut TcpStream, status: u16, status_text: &str, message: &str) {
    let payload = serde_json::json!({ "ok": false, "error": message });
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    send_response(stream, status, status_text, "application/json; charset=utf-8", &bytes);
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((h << 4) | l);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_query_params(query: &str) -> std::collections::BTreeMap<String, String> {
    let mut map = std::collections::BTreeMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(percent_decode(k), percent_decode(v));
    }
    map
}

fn is_safe_relative_file(file: &str) -> bool {
    let path = Path::new(file);
    if path.is_absolute() {
        return false;
    }
    !path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

fn parse_lang(raw: &str) -> Option<Lang> {
    match raw.to_ascii_lowercase().as_str() {
        "rust" | "rs" => Some(Lang::Rust),
        "typescript" | "ts" | "tsx" | "js" | "jsx" => Some(Lang::TypeScript),
        _ => None,
    }
}

fn handle_connection(mut stream: TcpStream, ctx: &ServerContext) {
    let Ok(req) = read_http_request(&mut stream) else {
        return;
    };

    if req.method == "OPTIONS" {
        send_response(&mut stream, 204, "No Content", "text/plain; charset=utf-8", b"");
        return;
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => {
            send_response(&mut stream, 200, "OK", "text/html; charset=utf-8", VIEWER_HTML.as_bytes());
        }
        ("GET", "/api/state") => {
            let _guard = ctx.lock.lock().ok();
            match build_viewer_state(&ctx.root, false) {
                Ok(state) => send_json(&mut stream, 200, "OK", &state),
                Err(err) => send_error(&mut stream, 500, "Internal Server Error", &err),
            }
        }
        ("GET", "/api/source") => {
            let params = parse_query_params(&req.query);
            let Some(file) = params.get("file").filter(|s| !s.is_empty()) else {
                send_error(&mut stream, 400, "Bad Request", "missing `file` query parameter");
                return;
            };
            if !is_safe_relative_file(file) {
                send_error(&mut stream, 400, "Bad Request", "invalid file path");
                return;
            }
            let lang = params.get("lang").and_then(|s| parse_lang(s)).or_else(|| Lang::from_path(Path::new(file)));
            let Some(lang) = lang else {
                send_error(&mut stream, 400, "Bad Request", "unknown or missing `lang`");
                return;
            };
            let name = params.get("name").cloned().unwrap_or_default();
            let line_hint = params.get("line").and_then(|s| s.parse::<usize>().ok());

            match locate_member(&ctx.root, lang, Path::new(file), &name, line_hint) {
                Ok(loc) => send_json(&mut stream, 200, "OK", &loc),
                Err(err) => send_error(&mut stream, 404, "Not Found", &err),
            }
        }
        ("GET", "/api/export/svg") => {
            let params = parse_query_params(&req.query);
            let scope = params.get("scope").map_or("root", String::as_str);
            let _guard = ctx.lock.lock().ok();
            match build_viewer_state(&ctx.root, false) {
                Ok(state) => {
                    let svg = render_svg(&state.ir, &state.policy, scope);
                    send_response(&mut stream, 200, "OK", "image/svg+xml; charset=utf-8", svg.as_bytes());
                }
                Err(err) => send_error(&mut stream, 500, "Internal Server Error", &err),
            }
        }
        ("POST", "/api/policy") => {
            let Ok(patch) = serde_json::from_slice::<PolicyUpdateRequest>(&req.body) else {
                send_error(&mut stream, 400, "Bad Request", "invalid policy JSON payload");
                return;
            };
            let _guard = ctx.lock.lock().ok();
            let result = (|| -> Result<ViewerState, String> {
                let mut policy = load_or_init_policy(&ctx.root)?;
                if let Some(title) = patch.title {
                    policy.title = title;
                }
                if let Some(prefix) = patch.prefix {
                    policy.prefix = prefix;
                }
                if let Some(hierarchical) = patch.hierarchical {
                    policy.hierarchical = hierarchical;
                }
                if let Some(foreign) = patch.foreign {
                    policy.foreign = foreign;
                }
                if let Some(order) = patch.order {
                    policy.order = order;
                }
                if let Some(levels) = patch.levels {
                    policy.levels = levels;
                }
                if let Some(omit) = patch.omit {
                    policy.omit = omit;
                }
                if let Some(edge_kinds) = patch.edge_kinds {
                    policy.edge_kinds = edge_kinds;
                }
                if let Some(proposals) = patch.proposals {
                    policy.proposals = proposals;
                }
                write_json(&policy_path(&ctx.root), &policy)?;
                generate_ir(&ctx.root, &policy, &[])?;
                build_viewer_state(&ctx.root, false)
            })();
            match result {
                Ok(state) => send_json(&mut stream, 200, "OK", &state),
                Err(err) => send_error(&mut stream, 500, "Internal Server Error", &err),
            }
        }
        ("POST", "/api/action") => {
            let Ok(action_req) = serde_json::from_slice::<ActionRequest>(&req.body) else {
                send_error(&mut stream, 400, "Bad Request", "invalid action JSON payload");
                return;
            };
            let _guard = ctx.lock.lock().ok();
            match handle_action(&ctx.root, action_req) {
                Ok(resp) => send_json(&mut stream, 200, "OK", &resp),
                Err(err) => send_error(&mut stream, 400, "Bad Request", &err),
            }
        }
        _ => {
            send_error(&mut stream, 404, "Not Found", &format!("unknown route {} {}", req.method, req.path));
        }
    }
}

fn spawn_xtask_subcommand(root: &Path, sub_args: &[String]) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|err| format!("failed to locate xtask binary: {err}"))?;
    let output = Command::new(exe)
        .args(sub_args)
        .current_dir(root)
        .output()
        .map_err(|err| format!("failed to spawn {}: {err}", sub_args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}").trim().to_owned();
    if output.status.success() || output.status.code() == Some(2) || output.status.code() == Some(3) {
        Ok(combined)
    } else {
        Err(if combined.is_empty() {
            format!("command `{}` exited with {}", sub_args.join(" "), output.status)
        } else {
            combined
        })
    }
}

fn handle_action(root: &Path, req: ActionRequest) -> Result<ActionResponse, String> {
    let _ = (&req.lang, &req.namespace);
    match req.action.as_str() {
        "regen" => {
            let state = build_viewer_state(root, true)?;
            Ok(ActionResponse {
                ok: true,
                action: req.action,
                message: format!(
                    "Regenerated IR: {} classes, {} edges ({} violations)",
                    state.ir.stats.total_classes, state.ir.stats.total_edges, state.ir.stats.violating_edges
                ),
                output: None,
                state,
            })
        }
        "omit" => {
            let target = req.target.ok_or_else(|| "omit action requires `target`".to_owned())?;
            let mut policy = load_or_init_policy(root)?;
            if !policy.omit.contains(&target) {
                policy.omit.push(target.clone());
                write_json(&policy_path(root), &policy)?;
            }
            let state = build_viewer_state(root, true)?;
            Ok(ActionResponse {
                ok: true,
                action: req.action,
                message: format!("Omitted `{target}`"),
                output: None,
                state,
            })
        }
        "unomit" => {
            let target = req.target.ok_or_else(|| "unomit action requires `target`".to_owned())?;
            let mut policy = load_or_init_policy(root)?;
            policy.omit.retain(|item| item != &target);
            write_json(&policy_path(root), &policy)?;
            let state = build_viewer_state(root, true)?;
            Ok(ActionResponse {
                ok: true,
                action: req.action,
                message: format!("Restored `{target}`"),
                output: None,
                state,
            })
        }
        "refresh_crap" => {
            let mut args = vec!["crap".to_owned()];
            if crap_snapshot_path(root).exists() || root.join("target/coverage/rust/lcov.info").exists() {
                args.push("--use-existing-coverage".to_owned());
            } else {
                args.push("--no-coverage".to_owned());
            }
            if let Some(file) = req.file.filter(|f| !f.is_empty() && is_safe_relative_file(f)) {
                args.push(file);
            } else if let Some(target) = req.target.filter(|t| !t.is_empty()) {
                args.push(target);
            }
            let out = spawn_xtask_subcommand(root, &args)?;
            let state = build_viewer_state(root, true)?;
            Ok(ActionResponse {
                ok: true,
                action: req.action,
                message: "Refreshed CRAP metrics".to_owned(),
                output: Some(out),
                state,
            })
        }
        "refresh_mutation" | "refresh_all_mutation" => {
            let mut args = vec!["mutate".to_owned()];
            if req.action == "refresh_all_mutation" {
                args.push("--mutate-all".to_owned());
            }
            if let Some(file) = req.file.filter(|f| !f.is_empty() && is_safe_relative_file(f)) {
                args.push(file);
            } else if let Some(target) = req.target.filter(|t| !t.is_empty()) {
                args.push(target);
            }
            let out = spawn_xtask_subcommand(root, &args)?;
            let state = build_viewer_state(root, true)?;
            Ok(ActionResponse {
                ok: true,
                action: req.action,
                message: "Refreshed mutation metrics".to_owned(),
                output: Some(out),
                state,
            })
        }
        other => Err(format!("unknown action `{other}`")),
    }
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml viewer [--port <N>] [--open]");
        return Ok(0);
    }

    let mut port: u16 = 7470;
    let mut open_browser = false;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                let raw = args.get(i + 1).ok_or_else(|| "--port requires a port number".to_owned())?;
                port = raw.parse::<u16>().map_err(|err| format!("invalid port `{raw}`: {err}"))?;
                i += 2;
            }
            "--open" => {
                open_browser = true;
                i += 1;
            }
            other => return Err(format!("unknown option `{other}` (expected --port <N>, --open)")),
        }
    }

    let mut server = start_server(root, port)?;
    let url = format!("http://127.0.0.1:{}", server.port());
    println!("VibeValley UML Viewer listening on {url}");
    if open_browser {
        #[cfg(target_os = "macos")]
        let _ = Command::new("open").arg(&url).spawn();
        #[cfg(target_os = "linux")]
        let _ = Command::new("xdg-open").arg(&url).spawn();
    }

    if let Some(handle) = server.handle.take() {
        let _ = handle.join();
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-viewer-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn send_raw_http(addr: SocketAddr, raw_req: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.write_all(raw_req.as_bytes()).unwrap();
        stream.flush().unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        let status_line = head.lines().next().unwrap();
        let code: u16 = status_line.split_whitespace().nth(1).unwrap().parse().unwrap();
        (code, body.to_owned())
    }

    #[test]
    fn ephemeral_http_server_serves_viewer_state_source_policy_action_and_svg() {
        let dir = temp_dir("http");
        fs::create_dir_all(dir.join("src/domain")).unwrap();
        fs::write(dir.join("src/domain/order.rs"), "pub fn hello(x: i32) -> i32 {\n    x + 1\n}\n").unwrap();

        let server = start_server(&dir, 0).unwrap();
        let addr = server.addr();
        assert!(server.port() > 0);

        let (code_html, body_html) = send_raw_http(addr, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        assert_eq!(code_html, 200);
        assert!(body_html.contains("VibeValley UML Viewer"));
        assert!(
            body_html.contains("for (const sub of pos.subs.slice(0, 8))"),
            "viewer.html must cap nested sub-box iteration to match subPositions slice"
        );
        assert!(body_html.contains("id=\"btn-foreign\""), "viewer.html must expose Show Foreign toggle button");
        assert!(body_html.contains("showForeign: false"), "Show Foreign must default to false");
        assert!(body_html.contains("FOREIGN_MAX_PER_ROW = 5"), "foreign ovals must wrap at 5 per row");
        assert!(body_html.contains("id=\"search-input\""), "viewer.html must expose quick fuzzy search box");
        assert!(body_html.contains("navigateToSearchMatch"), "fuzzy search must navigate/open matching nodes");
        assert!(body_html.contains("matchLevelEntry"), "viewer.html must support multi-segment levels matching");
        assert!(
            body_html.contains("isDependencyViolating"),
            "viewer.html must match Rust dependency violation rules"
        );

        let (code_state, body_state) = send_raw_http(addr, "GET /api/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        assert_eq!(code_state, 200);
        let state_json: serde_json::Value = serde_json::from_str(&body_state).unwrap();
        assert!(state_json.get("policy").is_some());
        assert!(state_json.get("ir").is_some());
        assert!(state_json.get("metrics_mtime").is_some());

        let (code_src, body_src) = send_raw_http(
            addr,
            "GET /api/source?lang=rust&file=src%2Fdomain%2Forder.rs&name=hello&line=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(code_src, 200);
        let src_json: serde_json::Value = serde_json::from_str(&body_src).unwrap();
        assert_eq!(src_json["target_line"], 1);
        assert!(src_json["snippet"].as_array().unwrap().iter().any(|l| l["highlight"] == true));

        let (code_svg, body_svg) = send_raw_http(addr, "GET /api/export/svg HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        assert_eq!(code_svg, 200);
        assert!(body_svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));

        let regen_body = r#"{"action":"regen"}"#;
        let regen_req = format!(
            "POST /api/action HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{regen_body}",
            regen_body.len()
        );
        let (code_action, body_action) = send_raw_http(addr, &regen_req);
        assert_eq!(code_action, 200);
        let action_json: serde_json::Value = serde_json::from_str(&body_action).unwrap();
        assert_eq!(action_json["ok"], true);
        assert_eq!(action_json["action"], "regen");
        assert!(action_json["state"]["ir"]["stats"]["total_classes"].as_u64().unwrap() >= 1);

        let policy_body = r#"{"omit":["app.domain.unused"],"proposals":[{"id":"p1","name":"Test Proposal","layers":[["domain"]],"omit":[]}]}"#;
        let policy_req = format!(
            "POST /api/policy HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{policy_body}",
            policy_body.len()
        );
        let (code_pol, body_pol) = send_raw_http(addr, &policy_req);
        assert_eq!(code_pol, 200);
        let pol_json: serde_json::Value = serde_json::from_str(&body_pol).unwrap();
        assert_eq!(pol_json["policy"]["proposals"][0]["id"], "p1");

        server.shutdown();
        let _ = fs::remove_dir_all(&dir);
    }
}
