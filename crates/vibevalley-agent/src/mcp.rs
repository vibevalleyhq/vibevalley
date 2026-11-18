//! MCP servers an agent profile attaches, their tools offered to the model
//! as `server__tool`. Ported from VibeValley
//! `packages/agent/src/infra/mcp.ts`: stdio and streamable HTTP servers,
//! 120 s for connecting and for each call, a server that cannot be reached
//! reported (not fatal), results flattened to text.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::model::ToolSpec;
use crate::tool::{Tool, ToolOutput};

const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const PROTOCOL_VERSION: &str = "2025-06-18";

/// `mcp.json` as VibeValley and Claude Code write it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct McpConfig {
    #[serde(rename = "mcpServers", default)]
    pub servers: BTreeMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum McpServerConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

impl McpConfig {
    pub fn read(path: &std::path::Path) -> Result<McpConfig, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{} 不是 JSON 或配置形状不对：{e}", path.display()))
    }
}

/// The server's name first, only characters function names allow.
pub fn tool_name(server: &str, tool: &str) -> String {
    format!("{server}__{tool}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect()
}

/// Text of an MCP result's content blocks.
pub fn content_text(content: &[Value]) -> String {
    let parts: Vec<String> = content
        .iter()
        .map(|block| match block["type"].as_str().unwrap_or_default() {
            "text" => block["text"].as_str().unwrap_or_default().to_string(),
            "image" => "[image]".into(),
            "audio" => "[audio]".into(),
            "resource_link" => "[resource_link]".into(),
            "resource" => match (block.pointer("/resource/text"), block.pointer("/resource/uri")) {
                (Some(Value::String(t)), _) if !t.is_empty() => t.clone(),
                (_, Some(Value::String(u))) => format!("[{u}]"),
                _ => "[资源]".into(),
            },
            _ => String::new(),
        })
        .collect();
    parts.join("\n").trim().to_string()
}

/// Connected servers. Dropping it and its tools closes them.
pub struct McpHub {
    servers: Vec<(String, Arc<Client>)>,
    /// Servers that could not be reached, with why.
    pub failures: Vec<(String, String)>,
}

impl McpHub {
    /// Connects every server of `config`, each within 120 s, in parallel.
    pub fn connect(config: &McpConfig) -> McpHub {
        let results: Vec<(String, Result<Client, String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = config
                .servers
                .iter()
                .map(|(name, cfg)| {
                    let name = name.clone();
                    scope.spawn(move || (name, Client::connect(cfg)))
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        let mut servers = Vec::new();
        let mut failures = Vec::new();
        for (name, result) in results {
            match result {
                Ok(client) => servers.push((name, Arc::new(client))),
                Err(why) => failures.push((name.clone(), format!("连不上 MCP 服务 {name}：{why}"))),
            }
        }
        McpHub { servers, failures }
    }

    /// Every tool of every connected server.
    pub fn tools(&self) -> Vec<Box<dyn Tool>> {
        let mut out: Vec<Box<dyn Tool>> = Vec::new();
        for (server, client) in &self.servers {
            let Ok(tools) = client.list_all_tools() else { continue };
            for value in tools {
                let remote = value["name"].as_str().unwrap_or_default().to_string();
                if remote.is_empty() {
                    continue;
                }
                let description = value["description"].as_str().unwrap_or_default();
                out.push(Box::new(McpTool {
                    spec: ToolSpec {
                        name: tool_name(server, &remote),
                        description: format!("（{server}）{description}"),
                        parameters: value.get("inputSchema").cloned().unwrap_or_else(|| json!({"type": "object"})),
                    },
                    server: server.clone(),
                    remote,
                    read_only: value.pointer("/annotations/readOnlyHint").and_then(Value::as_bool).unwrap_or(false),
                    client: client.clone(),
                }));
            }
        }
        out
    }
}

enum Transport {
    Stdio(StdioTransport),
    Http(HttpTransport),
}

struct Client {
    next_id: AtomicU64,
    transport: Transport,
}

impl Client {
    fn connect(cfg: &McpServerConfig) -> Result<Client, String> {
        let transport = match cfg {
            McpServerConfig::Stdio { command, args, env, cwd } => Transport::Stdio(StdioTransport::spawn(command, args, env, cwd.as_deref())?),
            McpServerConfig::Http { url, headers } => Transport::Http(HttpTransport::new(url, headers)),
        };
        let client = Client {
            next_id: AtomicU64::new(1),
            transport,
        };
        client.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "vibevalley", "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        client.notify("notifications/initialized", json!({}));
        Ok(client)
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let msg = match &self.transport {
            Transport::Stdio(stdio) => stdio.request(id, &req)?,
            Transport::Http(http) => http.request(id, &req)?,
        };
        if let Some(err) = msg.get("error") {
            let reason = err.get("message").and_then(Value::as_str).cloned_or_json(err);
            return Err(reason);
        }
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notify(&self, method: &str, params: Value) {
        let note = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        match &self.transport {
            Transport::Stdio(stdio) => stdio.notify(&note),
            Transport::Http(http) => http.notify(&note),
        }
    }

    fn list_all_tools(&self) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..64 {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let result = self.request("tools/list", params)?;
            if let Some(items) = result.get("tools").and_then(Value::as_array) {
                out.extend(items.iter().cloned());
            }
            match result.get("nextCursor").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                Some(next) => cursor = Some(next.to_string()),
                None => break,
            }
        }
        Ok(out)
    }
}

trait ErrorText {
    fn cloned_or_json(self, fallback: &Value) -> String;
}

impl ErrorText for Option<&str> {
    fn cloned_or_json(self, fallback: &Value) -> String {
        self.map(str::to_owned).unwrap_or_else(|| fallback.to_string())
    }
}

struct StdioTransport {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, flume::Sender<Value>>>>,
    child: Mutex<Child>,
}

impl StdioTransport {
    fn spawn(command: &str, args: &[String], env: &BTreeMap<String, String>, cwd: Option<&str>) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args).envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or_else(|| "missing child stdin".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "missing child stdout".to_string())?;
        let pending: Arc<Mutex<HashMap<u64, flume::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let waiters = pending.clone();
        std::thread::Builder::new()
            .name("vibevalley-mcp-stdio".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(trimmed) else { continue };
                    let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                    let tx = waiters.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                    if let Some(tx) = tx {
                        let _ = tx.send(msg);
                    }
                }
                // Drop remaining senders so in-flight callers wake immediately on EOF.
                waiters.lock().unwrap_or_else(|e| e.into_inner()).clear();
            })
            .map_err(|e| e.to_string())?;
        Ok(StdioTransport {
            stdin: Mutex::new(stdin),
            pending,
            child: Mutex::new(child),
        })
    }

    fn write_line(&self, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        stdin.write_all(&line).and_then(|()| stdin.flush()).map_err(|e| e.to_string())
    }

    fn request(&self, id: u64, req: &Value) -> Result<Value, String> {
        let (tx, rx) = flume::bounded(1);
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        if let Err(e) = self.write_line(req) {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(msg) => Ok(msg),
            Err(flume::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                Err("timed out".into())
            }
            Err(flume::RecvTimeoutError::Disconnected) => Err("connection closed".into()),
        }
    }

    fn notify(&self, note: &Value) {
        let _ = self.write_line(note);
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    }
}

struct HttpTransport {
    url: String,
    headers: BTreeMap<String, String>,
    session_id: Mutex<Option<String>>,
    agent: ureq::Agent,
}

impl HttpTransport {
    fn new(url: &str, headers: &BTreeMap<String, String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(CALL_TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        HttpTransport {
            url: url.to_owned(),
            headers: headers.clone(),
            session_id: Mutex::new(None),
            agent,
        }
    }

    fn send(&self, body: &Value) -> Result<(u16, String, BufReader<impl std::io::Read>), String> {
        let mut req = self
            .agent
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(sid) = self.session_id.lock().unwrap_or_else(|e| e.into_inner()).as_deref() {
            req = req.header("mcp-session-id", sid);
        }
        let payload = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let response = req.send(&payload[..]).map_err(|e| match e {
            ureq::Error::Timeout(_) => "timed out".to_string(),
            other => other.to_string(),
        })?;
        if let Some(sid) = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *self.session_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(sid.to_owned());
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let reader = BufReader::new(response.into_body().into_reader());
        Ok((status, content_type, reader))
    }

    fn request(&self, id: u64, req: &Value) -> Result<Value, String> {
        let (status, content_type, mut reader) = self.send(req)?;
        if !(200..300).contains(&status) {
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut reader, &mut text);
            return Err(format!("HTTP {status}: {}", text.trim()));
        }
        if content_type.contains("text/event-stream") {
            let mut data_lines = Vec::new();
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if n == 0 || trimmed.is_empty() {
                    if !data_lines.is_empty() {
                        let joined = data_lines.join("\n");
                        data_lines.clear();
                        if let Ok(msg) = serde_json::from_str::<Value>(&joined)
                            && msg.get("id").and_then(Value::as_u64) == Some(id)
                        {
                            return Ok(msg);
                        }
                    }
                    if n == 0 {
                        break;
                    }
                    continue;
                }
                if let Some(rest) = trimmed.strip_prefix("data:") {
                    data_lines.push(rest.trim_start().to_owned());
                }
            }
            Err("stream ended without response".into())
        } else {
            serde_json::from_reader(reader).map_err(|e| e.to_string())
        }
    }

    fn notify(&self, note: &Value) {
        let _ = self.send(note);
    }
}

struct McpTool {
    spec: ToolSpec,
    server: String,
    remote: String,
    read_only: bool,
    client: Arc<Client>,
}

impl Tool for McpTool {
    fn is_mcp(&self) -> bool {
        true
    }

    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn replay_safe(&self) -> bool {
        self.read_only
    }

    fn execute(&self, args: &Value) -> ToolOutput {
        let arguments = match args {
            Value::Object(map) => Value::Object(map.clone()),
            _ => Value::Object(Map::new()),
        };
        match self.client.request("tools/call", json!({ "name": self.remote, "arguments": arguments })) {
            Err(e) => ToolOutput::error(format!("{} 的 {} 出错：{e}", self.server, self.remote)),
            Ok(value) => {
                let blocks = value["content"].as_array().cloned().unwrap_or_default();
                let mut text = content_text(&blocks);
                if text.is_empty() {
                    text = value.get("structuredContent").map(Value::to_string).unwrap_or_else(|| "（没有内容）".into());
                }
                if value["isError"].as_bool().unwrap_or(false) {
                    ToolOutput::error(text)
                } else {
                    ToolOutput::ok(text)
                }
            }
        }
    }
}
