#![allow(clippy::disallowed_types, reason = "standalone synchronous test fixture binary")]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

fn main() {
    let raw_args: Vec<String> = env::args().collect();
    let (start_log_arg, args) = extract_record_start(&raw_args);

    let start_log = start_log_arg.or_else(|| env::var("VV_FIXTURE_START_LOG").ok().filter(|s| !s.is_empty()));
    if let Some(path) = start_log {
        let mut file = OpenOptions::new().create(true).append(true).open(&path).expect("open start log");
        file.write_all(b"start\n").expect("write start log");
        file.flush().expect("flush start log");
    }

    let (mode, mode_args) = resolve_mode(&args);
    match mode.as_str() {
        "echo_mcp" => run_echo_mcp(),
        "cancellable_mcp" => run_cancellable_mcp(),
        "cli_replay" => run_cli_replay(),
        "sdk_replay" => run_sdk_replay(&mode_args),
        "capture_codex" => run_capture_codex(&mode_args),
        "pause" => loop {
            thread::park();
        },
        other => {
            eprintln!("vv_test_fixture: unknown fixture mode '{other}' (set VV_FIXTURE or pass mode as first argument)");
            std::process::exit(2);
        }
    }
}

fn extract_record_start(raw_args: &[String]) -> (Option<String>, Vec<String>) {
    let mut start_log = None;
    let mut filtered = Vec::with_capacity(raw_args.len());
    let mut i = 0;
    while i < raw_args.len() {
        if i > 0
            && raw_args[i] == "--record-start"
            && let Some(path) = raw_args.get(i + 1)
        {
            start_log = Some(path.clone());
            i += 2;
            continue;
        }
        filtered.push(raw_args[i].clone());
        i += 1;
    }
    (start_log, filtered)
}

fn is_known_mode(s: &str) -> bool {
    matches!(s, "echo_mcp" | "cancellable_mcp" | "cli_replay" | "sdk_replay" | "capture_codex" | "pause")
}

fn resolve_mode(args: &[String]) -> (String, Vec<String>) {
    if let Ok(mode) = env::var("VV_FIXTURE")
        && !mode.is_empty()
    {
        return (mode, args.to_vec());
    }
    if let Some(first) = args.get(1)
        && is_known_mode(first)
    {
        let mut rest = Vec::with_capacity(args.len().saturating_sub(1));
        if let Some(prog) = args.first() {
            rest.push(prog.clone());
        }
        rest.extend_from_slice(&args[2..]);
        return (first.clone(), rest);
    }
    if env::var_os("OAR_REPLAY_FILE").is_some() {
        return ("cli_replay".into(), args.to_vec());
    }
    if env::var_os("REPLAY_LOG").is_some() {
        return ("sdk_replay".into(), args.to_vec());
    }
    if env::var_os("MCP_TEST_PORT").is_some() {
        return ("cancellable_mcp".into(), args.to_vec());
    }
    ("".into(), args.to_vec())
}

fn write_json_line(out: &mut impl Write, value: &Value) {
    let line = serde_json::to_string(value).expect("serialize json");
    writeln!(out, "{line}").expect("write stdout");
    out.flush().expect("flush stdout");
}

fn mcp_reply(out: &mut impl Write, id: &Value, result: Value) {
    write_json_line(out, &json!({"jsonrpc": "2.0", "id": id, "result": result}));
}

fn run_echo_mcp() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("read stdin");
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = serde_json::from_str(&line).expect("parse jsonrpc");
        let Some(id) = msg.get("id").filter(|v| !v.is_null()) else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        match method {
            "initialize" => mcp_reply(
                &mut stdout,
                id,
                json!({
                    "protocolVersion": msg["params"]["protocolVersion"],
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "echo", "version": "1.0"}
                }),
            ),
            "tools/list" => mcp_reply(
                &mut stdout,
                id,
                json!({
                    "tools": [
                        {
                            "name": "echo",
                            "description": "Echoes text",
                            "annotations": {"readOnlyHint": true},
                            "inputSchema": {
                                "type": "object",
                                "properties": {"text": {"type": "string"}},
                                "required": ["text"]
                            }
                        },
                        {
                            "name": "fail",
                            "description": "Always fails",
                            "inputSchema": {"type": "object"}
                        }
                    ]
                }),
            ),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or_default();
                if name == "echo" {
                    let text = msg["params"]["arguments"]["text"].as_str().unwrap_or_default();
                    mcp_reply(&mut stdout, id, json!({"content": [{"type": "text", "text": format!("echo: {text}")}]}));
                } else {
                    mcp_reply(&mut stdout, id, json!({"content": [{"type": "text", "text": "it broke"}], "isError": true}));
                }
            }
            _ => write_json_line(&mut stdout, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "no"}})),
        }
    }
}

fn json_id_display(id: &Value) -> String {
    match id.as_str() {
        Some(s) => s.to_string(),
        None => id.to_string(),
    }
}

fn run_cancellable_mcp() {
    let port: u16 = env::var("MCP_TEST_PORT").expect("MCP_TEST_PORT").parse().expect("valid port");
    let mut events = TcpStream::connect(("127.0.0.1", port)).expect("connect MCP_TEST_PORT");
    writeln!(events, "{}", std::process::id()).expect("write pid");
    events.flush().expect("flush pid");

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("read stdin");
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = serde_json::from_str(&line).expect("parse jsonrpc");
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        match method {
            "initialize" => {
                if let Some(id) = msg.get("id") {
                    mcp_reply(
                        &mut stdout,
                        id,
                        json!({
                            "protocolVersion": msg["params"]["protocolVersion"],
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "cancellable", "version": "1"}
                        }),
                    );
                }
            }
            "tools/list" => {
                if let Some(id) = msg.get("id") {
                    mcp_reply(&mut stdout, id, json!({"tools": [{"name": "wait", "inputSchema": {"type": "object"}}]}));
                }
            }
            "tools/call" => {
                let ping = msg["params"]["arguments"]["ping"].as_bool() == Some(true);
                if ping {
                    if let Some(id) = msg.get("id") {
                        mcp_reply(&mut stdout, id, json!({"content": [{"type": "text", "text": "pong"}]}));
                    }
                } else {
                    writeln!(events, "begin:{}", json_id_display(&msg["id"])).expect("write begin");
                    events.flush().expect("flush begin");
                }
            }
            "notifications/cancelled" => {
                writeln!(events, "cancel:{}", json_id_display(&msg["params"]["requestId"])).expect("write cancel");
                events.flush().expect("flush cancel");
            }
            _ => {}
        }
    }
}

fn run_cli_replay() {
    let replay_path = env::var("OAR_REPLAY_FILE").expect("OAR_REPLAY_FILE");
    let responses: Value = serde_json::from_str(&fs::read_to_string(&replay_path).expect("read OAR_REPLAY_FILE")).expect("parse OAR_REPLAY_FILE");

    let mut _child_guard = None;
    if let Ok(child_path) = env::var("OAR_REPLAY_CHILD")
        && !child_path.is_empty()
    {
        let exe = env::current_exe().expect("current_exe");
        let child = Command::new(exe)
            .env("VV_FIXTURE", "pause")
            .env_remove("OAR_REPLAY_CHILD")
            .env_remove("OAR_REPLAY_FILE")
            .env_remove("OAR_REPLAY_GATE")
            .env_remove("OAR_REPLAY_EXIT")
            .env_remove("VV_FIXTURE_START_LOG")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn pause child");
        let pids = json!([std::process::id(), child.id()]);
        fs::write(&child_path, pids.to_string()).expect("write OAR_REPLAY_CHILD");
        _child_guard = Some(child);
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for raw in stdin.lock().lines() {
        let raw = raw.expect("read stdin");
        if raw.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&raw).expect("parse request json");
        let mut operation = request
            .get("method")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                request
                    .get("request")
                    .and_then(|r| r.get("subtype"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| request.get("type").and_then(Value::as_str).filter(|s| !s.is_empty()))
            .unwrap_or_default()
            .to_string();

        if let Some(content) = request.get("message").and_then(|m| m.get("content")).and_then(Value::as_str) {
            if content == "hold" || content == "release" {
                operation = content.to_string();
            } else if content == "/compact" {
                operation = "compact".to_string();
            }
        }

        if operation == "user"
            && let Ok(code_str) = env::var("OAR_REPLAY_EXIT")
        {
            let code: i32 = code_str.parse().expect("valid exit code");
            std::process::exit(code);
        }

        let Some(records) = responses.get(&operation).and_then(Value::as_array) else {
            continue;
        };

        for (index, record) in records.iter().enumerate() {
            if index == 1
                && operation == "thread/compact/start"
                && let Ok(gate_path) = env::var("OAR_REPLAY_GATE")
            {
                let mut gate = UnixStream::connect(&gate_path).expect("connect OAR_REPLAY_GATE");
                gate.write_all(b"held").expect("write held");
                gate.flush().expect("flush held");
                let _ = gate.read(&mut [0u8; 1]);
            }

            let mut row = record.clone();
            if let Some(obj) = row.as_object_mut() {
                if obj.get("id") == Some(&json!(9412)) {
                    let Some(req_id) = request.get("id") else {
                        continue;
                    };
                    obj.insert("id".into(), req_id.clone());
                }
                if let Some(resp) = obj.get_mut("response").and_then(Value::as_object_mut)
                    && resp.contains_key("request_id")
                {
                    resp.insert("request_id".into(), request["request_id"].clone());
                }
            }
            write_json_line(&mut stdout, &row);
        }
    }
}

fn run_sdk_replay(args: &[String]) {
    let observed = PathBuf::from(env::var("REPLAY_LOG").expect("REPLAY_LOG"));
    let record = |entry: &Value| {
        let mut stream = OpenOptions::new().create(true).append(true).open(&observed).expect("open REPLAY_LOG");
        writeln!(stream, "{}", serde_json::to_string(entry).expect("serialize log")).expect("write REPLAY_LOG");
    };

    let file_info = |flag: &str| -> Value {
        let Some(pos) = args.iter().position(|a| a == flag) else {
            return Value::Null;
        };
        let Some(path_str) = args.get(pos + 1) else {
            return Value::Null;
        };
        let path = Path::new(path_str);
        let parent_mode = fs::metadata(path.parent().expect("parent")).expect("parent meta").permissions().mode() & 0o7777;
        let file_mode = fs::metadata(path).expect("file meta").permissions().mode() & 0o7777;
        let text = fs::read_to_string(path).expect("read flag file");
        json!([path_str, parent_mode, file_mode, text])
    };

    record(&json!({
        "argv": args.get(1..).unwrap_or(&[]),
        "usage": env::var("QODER_EXPOSE_TOKEN_USAGE").ok(),
        "prompt": file_info("--system-prompt-file"),
        "append": file_info("--append-system-prompt-file"),
        "mcp": file_info("--mcp-config"),
    }));

    let has_sdk_channel = args.iter().any(|a| a == "--channel=SDK");
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("read stdin");
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(&line).expect("parse message");
        record(&message);
        match message.get("type").and_then(Value::as_str) {
            Some("control_request") => {
                write_json_line(
                    &mut stdout,
                    &json!({
                        "type": "control_response",
                        "response": {"subtype": "success", "request_id": message["request_id"]}
                    }),
                );
                if message["request"]["subtype"] == "initialize" {
                    write_json_line(&mut stdout, &json!({"type": "system", "subtype": "init", "session_id": "vendor-42"}));
                }
            }
            Some("user") => {
                write_json_line(
                    &mut stdout,
                    &json!({
                        "type": "assistant",
                        "session_id": "vendor-42",
                        "message": {"content": [{"type": "text", "text": "hello sdk"}]}
                    }),
                );
                let usage = if has_sdk_channel {
                    json!({"input_tokens": 30, "output_tokens": 12})
                } else {
                    Value::Null
                };
                write_json_line(
                    &mut stdout,
                    &json!({
                        "type": "result",
                        "subtype": "success",
                        "session_id": "vendor-42",
                        "usage": usage
                    }),
                );
            }
            _ => {}
        }
    }
}

// ---- capture_codex mode (standalone reproducer for codex-0.170.0-collaboration.json) ----

struct WaitGate {
    ready: Mutex<bool>,
    cv: Condvar,
}

impl WaitGate {
    fn new() -> Self {
        Self {
            ready: Mutex::new(false),
            cv: Condvar::new(),
        }
    }
    fn set(&self) {
        let mut guard = self.ready.lock().unwrap();
        *guard = true;
        self.cv.notify_all();
    }
    fn wait(&self, timeout: Duration) {
        let mut guard = self.ready.lock().unwrap();
        let deadline = Instant::now() + timeout;
        while !*guard {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (g, res) = self.cv.wait_timeout(guard, deadline - now).unwrap();
            guard = g;
            if res.timed_out() {
                break;
            }
        }
    }
}

fn handle_responses_connection(mut stream: TcpStream, gate: &WaitGate, seq: &Mutex<u64>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut content_length: usize = 0;
    let mut has_auth = false;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, val)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = val.trim().parse().unwrap_or(0);
            } else if name.trim().eq_ignore_ascii_case("authorization") && !val.trim().is_empty() {
                has_auth = true;
            }
        }
    }
    if method != "POST" || path != "/v1/responses" || has_auth {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).unwrap();
    let request: Value = serde_json::from_slice(&body).unwrap();

    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
    let send_event = |stream: &mut TcpStream, kind: &str, mut fields: Map<String, Value>| {
        fields.insert("type".into(), Value::String(kind.into()));
        let payload = format!("event: {kind}\ndata: {}\n\n", Value::Object(fields));
        let _ = stream.write_all(payload.as_bytes());
        let _ = stream.flush();
    };
    let send_tool = |stream: &mut TcpStream, name: &str, args: Value, index: usize| {
        let call_id = format!("{name}{index}");
        let item = json!({
            "id": format!("item_{call_id}"),
            "call_id": call_id,
            "type": "function_call",
            "namespace": "collaboration",
            "name": name,
            "status": "completed",
            "arguments": args.to_string(),
        });
        let mut added = Map::new();
        added.insert("output_index".into(), json!(index));
        added.insert("item".into(), item.clone());
        send_event(stream, "response.output_item.added", added);
        let mut done = Map::new();
        done.insert("output_index".into(), json!(index));
        done.insert("item".into(), item);
        send_event(stream, "response.output_item.done", done);
    };

    let items = request.get("input").and_then(Value::as_array).cloned().unwrap_or_default();
    let calls: BTreeSet<String> = items
        .iter()
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("function_call"))
        .filter_map(|i| i.get("name").and_then(Value::as_str).map(String::from))
        .collect();
    let prompt = serde_json::to_string(&items).unwrap();
    let id_num = {
        let mut g = seq.lock().unwrap();
        *g += 1;
        *g
    };
    let response_id = format!("r_{id_num}");
    let mut created = Map::new();
    created.insert("response".into(), json!({"id": response_id, "status": "in_progress", "output": []}));
    send_event(&mut stream, "response.created", created);

    if calls.contains("spawn_agent") && !calls.contains("wait_agent") {
        send_tool(&mut stream, "wait_agent", json!({"timeout_ms": 10000}), 0);
        gate.set();
    } else if !calls.contains("wait_agent") && prompt.contains("Delegate two fixture checks.") {
        for (i, name) in ["audit", "verify"].iter().enumerate() {
            send_tool(
                &mut stream,
                "spawn_agent",
                json!({"task_name": name, "message": format!("Fixture task {name}."), "fork_turns": "none"}),
                i,
            );
        }
    } else {
        gate.wait(Duration::from_secs(5));
        if prompt.contains("Fixture task verify.") && calls.is_empty() {
            let mut failed = Map::new();
            failed.insert(
                "response".into(),
                json!({"id": response_id, "status": "failed", "error": {"code": "invalid_prompt", "message": "Fixture failure"}}),
            );
            send_event(&mut stream, "response.failed", failed);
            return;
        }
        let item = json!({
            "type": "message",
            "role": "assistant",
            "id": format!("message_{response_id}"),
            "status": "completed",
            "content": [{"type": "output_text", "text": "Done.", "annotations": []}]
        });
        let mut added = Map::new();
        added.insert("output_index".into(), json!(0));
        added.insert(
            "item".into(),
            json!({"type": "message", "role": "assistant", "id": item["id"], "status": "in_progress", "content": []}),
        );
        send_event(&mut stream, "response.output_item.added", added);
        let mut delta = Map::new();
        delta.insert("item_id".into(), item["id"].clone());
        delta.insert("output_index".into(), json!(0));
        delta.insert("content_index".into(), json!(0));
        delta.insert("delta".into(), json!("Done."));
        send_event(&mut stream, "response.output_text.delta", delta);
        let mut done = Map::new();
        done.insert("output_index".into(), json!(0));
        done.insert("item".into(), item);
        send_event(&mut stream, "response.output_item.done", done);
    }

    let mut completed = Map::new();
    completed.insert(
        "response".into(),
        json!({"id": response_id, "status": "completed", "output": [], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}),
    );
    send_event(&mut stream, "response.completed", completed);
}

struct RpcClient {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    rx: std::sync::mpsc::Receiver<Option<Value>>,
    notifications: Vec<Value>,
    next_id: u64,
}

impl RpcClient {
    fn start(binary: &Path, temp: &Path, port: Option<u16>) -> Self {
        let mut rules = String::from("(version 1) (allow default) (deny network-outbound)");
        if let Some(port) = port {
            rules.push_str(&format!(" (allow network-outbound (remote ip \"localhost:{port}\"))"));
        }
        let home = env::var("HOME").unwrap_or_default();
        for suffix in [".codex", "Library/Keychains"] {
            let p = Path::new(&home).join(suffix);
            rules.push_str(&format!(" (deny file-read* file-write* (subpath {}))", json!(p.to_string_lossy())));
        }
        let mut child = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &rules])
            .arg(binary)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(temp.join("work"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("CODEX_HOME", temp.join("config"))
            .env("TMPDIR", temp)
            .env("NO_PROXY", "localhost,127.0.0.1")
            .env("no_proxy", "localhost,127.0.0.1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sandboxed app-server");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        if let Ok(v) = serde_json::from_str::<Value>(&l) {
                            let _ = tx.send(Some(v));
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let _ = tx.send(None);
        });
        let mut rpc = Self {
            child,
            stdin,
            rx,
            notifications: Vec::new(),
            next_id: 0,
        };
        rpc.call(
            "initialize",
            json!({"clientInfo": {"name": "vibevalley", "version": "1"}, "capabilities": {"experimentalApi": true}}),
        );
        rpc.send(json!({"method": "initialized"}));
        rpc
    }

    fn next(&mut self) -> Value {
        let msg = self
            .rx
            .recv_timeout(Duration::from_secs(20))
            .expect("rpc timeout")
            .expect("app-server closed stdout");
        if msg.get("method").is_some() {
            self.notifications.push(msg.clone());
        }
        msg
    }

    fn send(&mut self, mut message: Value) {
        if let Some(obj) = message.as_object_mut() {
            obj.insert("jsonrpc".into(), json!("2.0"));
        }
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"id": id, "method": method, "params": params}));
        loop {
            let msg = self.next();
            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err) = msg.get("error") {
                    panic!("rpc error: {err}");
                }
                return msg["result"].clone();
            }
        }
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pick_fields(obj: &Value, keys: &[&str]) -> Value {
    let mut map = Map::new();
    if let Some(src) = obj.as_object() {
        for &key in keys {
            if let Some(val) = src.get(key) {
                map.insert(key.into(), val.clone());
            }
        }
    }
    Value::Object(map)
}

fn run_capture_codex(args: &[String]) {
    let binary = Path::new(args.get(1).expect("usage: vv_test_fixture capture_codex /path/to/codex"))
        .canonicalize()
        .expect("codex binary");
    let version = String::from_utf8(Command::new(&binary).arg("--version").output().expect("codex --version").stdout)
        .expect("utf8 version")
        .trim()
        .to_string();
    let dir = tempfile::tempdir().expect("tempdir");
    let work = dir.path().join("work");
    let config = dir.path().join("config");
    fs::create_dir_all(&work).unwrap();
    fs::create_dir_all(&config).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    fs::write(
        config.join("config.toml"),
        format!(
            "model_provider = \"probe\"\n\
             model = \"gpt-5.5\"\n\
             approval_policy = \"never\"\n\
             sandbox_mode = \"read-only\"\n\
             cli_auth_credentials_store = \"file\"\n\
             check_for_update_on_startup = false\n\
             [analytics]\nenabled = false\n\
             [features]\nmulti_agent_v2 = true\n\
             [model_providers.probe]\n\
             name = \"Loopback\"\n\
             base_url = \"http://127.0.0.1:{port}/v1\"\n\
             wire_api = \"responses\"\n\
             requires_openai_auth = false\n\
             supports_websockets = false\n\
             request_max_retries = 0\n\
             stream_max_retries = 0\n"
        ),
    )
    .unwrap();

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_srv = stop.clone();
    let gate = Arc::new(WaitGate::new());
    let seq = Arc::new(Mutex::new(0u64));
    let server_handle = thread::spawn(move || {
        while !stop_srv.load(std::sync::atomic::Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let gate = gate.clone();
                    let seq = seq.clone();
                    thread::spawn(move || handle_responses_connection(stream, &gate, &seq));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::park_timeout(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });

    let (root, frames) = {
        let mut rpc = RpcClient::start(&binary, dir.path(), Some(port));
        let root = rpc.call("thread/start", json!({"cwd": work, "approvalPolicy": "never", "sandbox": "read-only"}))["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        rpc.call(
            "turn/start",
            json!({"threadId": root, "input": [{"type": "text", "text": "Delegate two fixture checks."}]}),
        );
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let finished: BTreeSet<String> = rpc
                .notifications
                .iter()
                .filter(|m| m["method"] == "turn/completed")
                .filter_map(|m| m["params"]["threadId"].as_str().map(String::from))
                .collect();
            if finished.len() >= 3 {
                break;
            }
            assert!(Instant::now() < deadline, "expected parent and both child turns to finish");
            rpc.next();
        }
        (root, rpc.notifications.clone())
    };
    stop.store(true, std::sync::atomic::Ordering::Release);
    server_handle.thread().unpark();
    let _ = server_handle.join();

    let mut children: BTreeMap<String, String> = BTreeMap::new();
    for m in &frames {
        let item = &m["params"]["item"];
        if item["type"] == "subAgentActivity"
            && let (Some(tid), Some(path)) = (item["agentThreadId"].as_str(), item["agentPath"].as_str())
        {
            children.insert(tid.into(), path.into());
        }
    }
    let mut sorted_children: Vec<(String, String)> = children.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    sorted_children.sort_by(|a, b| a.1.cmp(&b.1));

    let reads: Vec<Value> = {
        let mut reader = RpcClient::start(&binary, dir.path(), None);
        let resumed = reader.call("thread/resume", json!({"threadId": root, "excludeTurns": true}));
        assert_eq!(resumed["thread"]["turns"], json!([]));
        sorted_children
            .iter()
            .map(|(child, _)| reader.call("thread/read", json!({"threadId": child, "includeTurns": true}))["thread"].clone())
            .collect()
    };

    let mut ids: HashMap<String, String> = HashMap::new();
    ids.insert(root, "root-thread".into());
    for (child, path) in &children {
        let base = path.rsplit('/').next().unwrap_or(path);
        ids.insert(child.clone(), format!("{base}-thread"));
    }
    for frame in &frames {
        if frame["method"] == "turn/started"
            && let (Some(turn_id), Some(thread_id)) = (frame["params"]["turn"]["id"].as_str(), frame["params"]["threadId"].as_str())
            && let Some(alias) = ids.get(thread_id)
        {
            ids.insert(turn_id.into(), format!("{}-turn", alias.strip_suffix("-thread").unwrap_or(alias)));
        }
    }

    let mut notifications = Vec::new();
    for frame in &frames {
        let method = frame["method"].as_str().unwrap_or_default();
        if !matches!(
            method,
            "turn/started" | "turn/completed" | "item/started" | "item/completed" | "item/agentMessage/delta" | "error"
        ) {
            continue;
        }
        let p = &frame["params"];
        let mut keep = match pick_fields(p, &["threadId", "turnId", "error", "delta", "willRetry", "itemId"]) {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        if let Some(item) = p.get("item") {
            if item.get("type").and_then(Value::as_str) == Some("userMessage") {
                continue;
            }
            keep.insert(
                "item".into(),
                pick_fields(
                    item,
                    &[
                        "type",
                        "kind",
                        "id",
                        "tool",
                        "status",
                        "agentThreadId",
                        "agentPath",
                        "senderThreadId",
                        "receiverThreadIds",
                        "prompt",
                        "agentsStates",
                        "text",
                    ],
                ),
            );
        }
        if let Some(turn) = p.get("turn") {
            keep.insert("turn".into(), pick_fields(turn, &["id", "status", "error"]));
        }
        notifications.push(json!({"method": method, "params": Value::Object(keep)}));
    }

    let snapshots: Vec<Value> = reads
        .iter()
        .map(|thread| {
            let mut record = match pick_fields(thread, &["id", "parentThreadId", "preview", "source"]) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            let turns: Vec<Value> = thread["turns"]
                .as_array()
                .unwrap()
                .iter()
                .map(|turn| {
                    let mut t = match pick_fields(turn, &["id", "status", "error"]) {
                        Value::Object(m) => m,
                        _ => Map::new(),
                    };
                    let items: Vec<Value> = turn["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|item| pick_fields(item, &["type", "text"]))
                        .collect();
                    t.insert("items".into(), Value::Array(items));
                    Value::Object(t)
                })
                .collect();
            record.insert("turns".into(), Value::Array(turns));
            json!({"thread": Value::Object(record)})
        })
        .collect();

    let mut data = serde_json::to_string_pretty(&json!({"notifications": notifications, "reads": snapshots})).unwrap();
    for (original, stable) in &ids {
        data = data.replace(original, stable);
    }
    if let Ok(home) = env::var("HOME")
        && !home.is_empty()
        && data.contains(&home)
    {
        panic!("unredacted home path in selected fields");
    }
    let mut result: Value = serde_json::from_str(&data).unwrap();
    result["capture"] = json!({
        "cli": version,
        "features": {"multi_agent_v2": true},
        "transport": "stdio",
        "origin": "Isolated macOS app-server with scripted Responses on loopback, with credentials omitted and external connections denied.",
        "reread": "Fresh app-server process with networking denied; thread/resume excluded turns before thread/read of known child ids.",
        "redaction": "Preserves notification order and selected fields, substitutes thread/turn ids, omits disk paths, timestamps and token counts.",
        "reproducer": "vv_test_fixture capture_codex",
    });
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
