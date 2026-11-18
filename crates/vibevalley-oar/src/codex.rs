//! Codex, driven through `codex app-server` (JSON-RPC lines on stdio).
//!
//! One app-server process per session. Shapes follow the schema the binary
//! itself emits (`codex app-server generate-json-schema`, checked against
//! codex-cli 0.167.0) and oar's codex adapter.
//!
//! `PermissionMode` becomes an approval policy plus a sandbox:
//!
//! | mode | approvalPolicy | sandbox |
//! | --- | --- | --- |
//! | `Ask` | `untrusted` | `read-only` |
//! | `AcceptEdits` | `untrusted` | `workspace-write` |
//! | `Bypass` | `never` | `danger-full-access` |
//! | `Plan` | `never` | `read-only` |
//!
//! Codex decides by itself which commands are "trusted" (plain reads) and
//! runs those without asking in every mode.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};

use crate::core::{CoreSession, Driver, SessionCore, absolute, check_cwd, file_as_text, lock, rejected, rejection};
use crate::process::{LineChild, LoginCheck, Spawn, probe_installation_with, require_binary};
use crate::record::{self, Recorder};
use crate::{
    AccountUsage, AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, Installation, McpServer, ModelInfo, PermissionDecision, PermissionMode,
    Result, Runtime, Session, SessionOptions, StopReason, Usage, UsageWindow,
};

const ID: &str = "codex";
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const ABORT_GRACE: Duration = Duration::from_secs(10);

pub(crate) struct CodexRuntime;

impl CodexRuntime {
    pub(crate) fn new() -> Self {
        Self
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `codex login status` exits non-zero and says "Not logged in" otherwise.
const LOGIN: LoginCheck = LoginCheck {
    args: &["login", "status"],
    logged_in: codex_logged_in,
};

pub(crate) fn codex_logged_in(ok: bool, text: &str) -> bool {
    ok && !text.to_ascii_lowercase().contains("not logged in")
}

pub(crate) fn policy(mode: PermissionMode) -> (&'static str, &'static str) {
    match mode {
        PermissionMode::Ask => ("untrusted", "read-only"),
        PermissionMode::AcceptEdits => ("untrusted", "workspace-write"),
        PermissionMode::Bypass => ("never", "danger-full-access"),
        PermissionMode::Plan => ("never", "read-only"),
    }
}

pub(crate) fn open_request(opts: &SessionOptions) -> (&'static str, Value) {
    let (approval, sandbox) = policy(opts.permission_mode);
    let mut params = json!({
        "cwd": opts.cwd,
        "approvalPolicy": approval,
        "sandbox": sandbox,
    });
    let fields = params.as_object_mut().expect("object literal");
    if let Some(model) = &opts.model {
        fields.insert("model".into(), json!(model));
    }
    if let Some(prompt) = &opts.system_prompt {
        fields.insert("baseInstructions".into(), json!(prompt));
    }
    if let Some(prompt) = &opts.append_system_prompt {
        // Appended as a developer message; `baseInstructions` replaces codex's own prompt.
        fields.insert("developerInstructions".into(), json!(prompt));
    }
    // Overrides by dotted path, as `codex -c key=value`.
    let mut config = serde_json::Map::new();
    if let Some(effort) = &opts.effort {
        config.insert("model_reasoning_effort".into(), json!(effort));
    }
    for server in &opts.mcp_servers {
        let entry = match server {
            McpServer::Stdio { command, args, env, cwd, .. } => {
                let mut entry = json!({ "command": command, "args": args, "env": env.iter().cloned().collect::<std::collections::BTreeMap<_, _>>() });
                if let Some(cwd) = cwd {
                    entry["cwd"] = json!(cwd);
                }
                entry
            }
            McpServer::Http { url, headers, .. } => {
                json!({ "url": url, "http_headers": headers.iter().cloned().collect::<std::collections::BTreeMap<_, _>>() })
            }
        };
        config.insert(format!("mcp_servers.{}", server.name()), entry);
    }
    if !config.is_empty() {
        fields.insert("config".into(), Value::Object(config));
    }
    match &opts.resume {
        Some(thread) => {
            fields.insert("threadId".into(), json!(thread));
            fields.insert("excludeTurns".into(), json!(true));
            ("thread/resume", params)
        }
        None => ("thread/start", params),
    }
}

const TOOL_ITEMS: &[&str] = &[
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
    "collabAgentToolCall",
    "imageView",
];

fn tool_name(item: &Value) -> String {
    let kind = str_of(item, "type").unwrap_or("tool");
    match kind {
        "mcpToolCall" => format!("mcp:{}/{}", str_of(item, "server").unwrap_or("?"), str_of(item, "tool").unwrap_or("?")),
        "dynamicToolCall" => str_of(item, "tool").unwrap_or(kind).to_string(),
        _ => kind.to_string(),
    }
}

fn tool_input(item: &Value) -> Value {
    let pick = |keys: &[&str]| {
        let mut out = serde_json::Map::new();
        for key in keys {
            if let Some(value) = item.get(*key).filter(|v| !v.is_null()) {
                out.insert((*key).to_string(), value.clone());
            }
        }
        Value::Object(out)
    };
    match str_of(item, "type").unwrap_or_default() {
        "commandExecution" => pick(&["command", "cwd"]),
        "fileChange" => pick(&["changes"]),
        "mcpToolCall" | "dynamicToolCall" => item.get("arguments").cloned().unwrap_or(Value::Null),
        "webSearch" => pick(&["query", "action"]),
        "collabAgentToolCall" => pick(&["tool", "prompt", "receiverThreadIds"]),
        "imageView" => pick(&["path"]),
        _ => Value::Null,
    }
}

fn tool_output(item: &Value) -> String {
    let status = str_of(item, "status").unwrap_or_default();
    match str_of(item, "type").unwrap_or_default() {
        "commandExecution" => match str_of(item, "aggregatedOutput") {
            Some(output) if !output.is_empty() => output.to_string(),
            _ => status.to_string(),
        },
        "mcpToolCall" => {
            if let Some(message) = item.pointer("/error/message").and_then(Value::as_str) {
                return format!("error: {message}");
            }
            let blocks = item.pointer("/result/content").and_then(Value::as_array);
            let texts: Vec<&str> = blocks.into_iter().flatten().filter_map(|b| str_of(b, "text")).collect();
            if texts.is_empty() {
                item.get("result")
                    .filter(|r| !r.is_null())
                    .map(Value::to_string)
                    .unwrap_or_else(|| status.to_string())
            } else {
                texts.join("\n")
            }
        }
        "dynamicToolCall" => item
            .get("contentItems")
            .filter(|c| !c.is_null())
            .map(Value::to_string)
            .unwrap_or_else(|| status.to_string()),
        "webSearch" => item.get("results").filter(|r| !r.is_null()).map(Value::to_string).unwrap_or_default(),
        _ => status.to_string(),
    }
}

fn tool_ok(item: &Value) -> bool {
    match str_of(item, "status") {
        Some("completed") => item.get("exitCode").and_then(Value::as_i64).is_none_or(|code| code == 0),
        Some(_) => false,
        // webSearch and imageView carry no status; finishing is success.
        None => item.get("success").and_then(Value::as_bool).unwrap_or(true),
    }
}

fn file_changes(item: &Value) -> Vec<EventKind> {
    let mut out = Vec::new();
    for change in item.get("changes").and_then(Value::as_array).into_iter().flatten() {
        let Some(path) = str_of(change, "path") else { continue };
        let kind = change.get("kind").unwrap_or(&Value::Null);
        let event = |path: &str, change| EventKind::FileChanged {
            path: PathBuf::from(path),
            change,
        };
        match str_of(kind, "type") {
            Some("add") => out.push(event(path, FileChangeKind::Created)),
            Some("delete") => out.push(event(path, FileChangeKind::Deleted)),
            _ => match str_of(kind, "move_path") {
                Some(moved) => {
                    out.push(event(path, FileChangeKind::Deleted));
                    out.push(event(moved, FileChangeKind::Created));
                }
                None => out.push(event(path, FileChangeKind::Modified)),
            },
        }
    }
    out
}

/// A request codex sent us, classified.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ServerRequest {
    Permission {
        agent_path: Vec<String>,
        tool: String,
        input: Value,
        summary: String,
    },
    Question {
        text: String,
    },
    /// Not a decision we can make (auth refresh, client-side tools, ...).
    Unsupported,
}

/// app-server notifications → events, as a pure fold (tests feed it fixtures).
pub(crate) struct Projector {
    root_thread: String,
    streamed_items: HashSet<String>,
    items: HashMap<String, Value>,
    total: Option<(u64, u64)>,
    turn_baseline: Option<(u64, u64)>,
    error_in_turn: bool,
    last_error: Option<String>,
}

impl Projector {
    pub(crate) fn new(root_thread: &str) -> Self {
        Self {
            root_thread: root_thread.to_string(),
            streamed_items: HashSet::new(),
            items: HashMap::new(),
            total: None,
            turn_baseline: None,
            error_in_turn: false,
            last_error: None,
        }
    }

    fn path(&self, params: &Value) -> Vec<String> {
        match str_of(params, "threadId") {
            Some(thread) if thread != self.root_thread => vec![thread.to_string()],
            _ => Vec::new(),
        }
    }

    pub(crate) fn notification(&mut self, method: &str, params: &Value) -> Vec<(Vec<String>, EventKind)> {
        let path = self.path(params);
        let root = path.is_empty();
        let mut out = Vec::new();
        let delta = || str_of(params, "delta").filter(|d| !d.is_empty()).map(str::to_string);
        match method {
            "item/agentMessage/delta" => {
                if let Some(text) = delta() {
                    self.streamed_items.insert(str_of(params, "itemId").unwrap_or_default().to_string());
                    out.push((path, EventKind::TextDelta { text }));
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                if let Some(text) = delta() {
                    self.streamed_items.insert(str_of(params, "itemId").unwrap_or_default().to_string());
                    out.push((path, EventKind::ThinkingDelta { text }));
                }
            }
            "item/reasoning/summaryPartAdded" => {
                let id = str_of(params, "itemId").unwrap_or_default();
                if self.streamed_items.contains(id) {
                    out.push((path, EventKind::ThinkingDelta { text: "\n\n".into() }));
                }
            }
            "item/started" => {
                let item = params.get("item").unwrap_or(&Value::Null);
                let kind = str_of(item, "type").unwrap_or_default();
                if TOOL_ITEMS.contains(&kind) {
                    let id = str_of(item, "id").unwrap_or_default().to_string();
                    self.items.insert(id.clone(), item.clone());
                    out.push((
                        path,
                        EventKind::ToolCallStarted {
                            id,
                            name: tool_name(item),
                            input: tool_input(item),
                        },
                    ));
                }
            }
            "item/completed" => {
                let item = params.get("item").unwrap_or(&Value::Null);
                let id = str_of(item, "id").unwrap_or_default().to_string();
                match str_of(item, "type").unwrap_or_default() {
                    // Whole text only when nothing streamed for the item.
                    "agentMessage" if !self.streamed_items.contains(&id) => {
                        if let Some(text) = str_of(item, "text").filter(|t| !t.is_empty()) {
                            out.push((path, EventKind::TextDelta { text: text.to_string() }));
                        }
                    }
                    "reasoning" if !self.streamed_items.contains(&id) => {
                        let parts = |key: &str| -> Vec<String> {
                            item.get(key)
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                                .filter_map(|p| p.as_str().map(str::to_string))
                                .collect()
                        };
                        let mut text = parts("summary");
                        if text.is_empty() {
                            text = parts("content");
                        }
                        if !text.is_empty() {
                            out.push((path, EventKind::ThinkingDelta { text: text.join("\n\n") }));
                        }
                    }
                    kind if TOOL_ITEMS.contains(&kind) => {
                        if self.items.remove(&id).is_none() {
                            // Completed without a start (a resumed or replayed item): open it first.
                            out.push((
                                path.clone(),
                                EventKind::ToolCallStarted {
                                    id: id.clone(),
                                    name: tool_name(item),
                                    input: tool_input(item),
                                },
                            ));
                        }
                        let ok = tool_ok(item);
                        out.push((
                            path.clone(),
                            EventKind::ToolCallFinished {
                                id,
                                ok,
                                output: tool_output(item),
                            },
                        ));
                        if ok && kind == "fileChange" {
                            out.extend(file_changes(item).into_iter().map(|event| (path.clone(), event)));
                        }
                    }
                    _ => {}
                }
            }
            "thread/tokenUsage/updated" if root => {
                let total = params.pointer("/tokenUsage/total").unwrap_or(&Value::Null);
                let count = |key: &str| total.get(key).and_then(Value::as_u64);
                if let (Some(input), Some(output)) = (count("inputTokens"), count("outputTokens")) {
                    self.total = Some((input, output));
                }
            }
            "turn/started" if root => {
                // `total` spans the thread's life; a turn's usage is the growth since here.
                self.turn_baseline = Some(self.total.unwrap_or((0, 0)));
                self.error_in_turn = false;
                self.last_error = None;
            }
            "error" => {
                let error = params.get("error").unwrap_or(&Value::Null);
                let mut message = str_of(error, "message").unwrap_or("codex reported an error").to_string();
                if let Some(details) = str_of(error, "additionalDetails").filter(|d| !d.is_empty()) {
                    message.push_str(": ");
                    message.push_str(details);
                }
                if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                    self.last_error = Some(message);
                } else {
                    self.error_in_turn = true;
                    out.push((path, EventKind::Error { message }));
                }
            }
            "turn/completed" => {
                let turn = params.get("turn").unwrap_or(&Value::Null);
                let reason = match str_of(turn, "status") {
                    Some("completed") => StopReason::Completed,
                    Some("interrupted") => StopReason::Aborted,
                    _ => StopReason::Error,
                };
                if reason == StopReason::Error && !(root && self.error_in_turn) {
                    let message = turn
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| self.last_error.clone())
                        .unwrap_or_else(|| format!("codex turn {}", str_of(turn, "status").unwrap_or("failed")));
                    out.push((path.clone(), EventKind::Error { message }));
                }
                let usage = match (root, self.total, self.turn_baseline.take()) {
                    (true, Some((input, output)), Some((base_input, base_output))) => Usage {
                        input_tokens: Some(input.saturating_sub(base_input)),
                        output_tokens: Some(output.saturating_sub(base_output)),
                        cost_usd: None,
                    },
                    _ => Usage::default(),
                };
                out.push((path, EventKind::TurnFinished { reason, usage }));
            }
            _ => {}
        }
        out
    }

    pub(crate) fn server_request(&self, method: &str, params: &Value) -> ServerRequest {
        let agent_path = self.path(params);
        let reason = str_of(params, "reason").filter(|r| !r.is_empty());
        match method {
            "item/commandExecution/requestApproval" | "execCommandApproval" => {
                let command = match params.get("command") {
                    Some(Value::String(command)) => command.clone(),
                    Some(Value::Array(parts)) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
                    _ => String::new(),
                };
                let mut input = json!({ "command": command });
                for key in ["cwd", "reason"] {
                    if let Some(value) = params.get(key).filter(|v| !v.is_null()) {
                        input[key] = value.clone();
                    }
                }
                let summary = match reason {
                    Some(reason) if command.is_empty() => reason.to_string(),
                    _ => format!("Run: {command}"),
                };
                ServerRequest::Permission {
                    agent_path,
                    tool: "commandExecution".into(),
                    input,
                    summary,
                }
            }
            "item/fileChange/requestApproval" | "applyPatchApproval" => {
                let changes = str_of(params, "itemId")
                    .and_then(|id| self.items.get(id))
                    .and_then(|item| item.get("changes").cloned())
                    .or_else(|| params.get("fileChanges").cloned())
                    .unwrap_or(Value::Null);
                let paths: Vec<String> = match &changes {
                    Value::Array(list) => list.iter().filter_map(|c| str_of(c, "path").map(str::to_string)).collect(),
                    Value::Object(map) => map.keys().cloned().collect(),
                    _ => Vec::new(),
                };
                let mut input = json!({ "changes": changes });
                for key in ["reason", "grantRoot"] {
                    if let Some(value) = params.get(key).filter(|v| !v.is_null()) {
                        input[key] = value.clone();
                    }
                }
                let summary = if paths.is_empty() {
                    reason.unwrap_or("Apply file changes").to_string()
                } else {
                    format!("Edit: {}", paths.join(", "))
                };
                ServerRequest::Permission {
                    agent_path,
                    tool: "fileChange".into(),
                    input,
                    summary,
                }
            }
            "item/permissions/requestApproval" => ServerRequest::Permission {
                agent_path,
                tool: "permissions".into(),
                input: json!({ "permissions": params.get("permissions"), "reason": params.get("reason") }),
                summary: reason.unwrap_or("Grant additional permissions").to_string(),
            },
            "item/tool/requestUserInput" => {
                let questions = params.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
                let text = questions.iter().filter_map(|q| str_of(q, "question")).collect::<Vec<_>>().join("\n");
                ServerRequest::Question { text }
            }
            _ => ServerRequest::Unsupported,
        }
    }
}

/// codex's reply body for a decision on `method`.
pub(crate) fn decision_reply(method: &str, params: &Value, decision: &PermissionDecision) -> Value {
    let modern = |once: &str, always: &str, no: &str| match decision {
        PermissionDecision::AllowOnce => json!({ "decision": once }),
        PermissionDecision::AllowAlways => json!({ "decision": always }),
        PermissionDecision::Deny { .. } => json!({ "decision": no }),
    };
    match method {
        "execCommandApproval" | "applyPatchApproval" => modern("approved", "approved_for_session", "denied"),
        "item/permissions/requestApproval" => match decision {
            PermissionDecision::AllowOnce => json!({ "permissions": params.get("permissions"), "scope": "turn" }),
            PermissionDecision::AllowAlways => json!({ "permissions": params.get("permissions"), "scope": "session" }),
            PermissionDecision::Deny { .. } => json!({ "permissions": {} }),
        },
        _ => modern("accept", "acceptForSession", "decline"),
    }
}

type RpcResult = std::result::Result<Value, String>;
type RpcCallback = Box<dyn FnOnce(RpcResult) + Send>;

struct PendingApproval {
    native_id: Value,
    method: String,
    params: Value,
}

struct Shared {
    child: OnceLock<Arc<LineChild>>,
    next_id: AtomicU64,
    calls: Mutex<HashMap<u64, RpcCallback>>,
    /// Set once the thread exists; lines before that are only RPC replies.
    session: OnceLock<SessionState>,
    /// Notifications that arrived before `session` was set, in wire order.
    early: Mutex<Vec<(String, Value)>>,
    exit: Mutex<Option<String>>,
}

struct SessionState {
    core: Arc<SessionCore>,
    projector: Mutex<Projector>,
    thread_id: String,
    turn_id: Mutex<Option<String>>,
    abort_wanted: AtomicBool,
    abort_killed: AtomicBool,
    turns_finished: AtomicU64,
    approvals: Mutex<HashMap<String, PendingApproval>>,
    cwd: PathBuf,
}

impl Shared {
    fn child(&self) -> Result<&Arc<LineChild>> {
        self.child.get().ok_or_else(|| AgentError::Io("codex is not running".into()))
    }

    fn call_async(&self, method: &str, params: Value, callback: RpcCallback) -> Result<()> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        lock(&self.calls).insert(id, callback);
        let sent = self
            .child()
            .and_then(|c| c.write_json(&json!({ "id": id, "method": method, "params": params })));
        if sent.is_err() {
            lock(&self.calls).remove(&id);
        }
        sent
    }

    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let (tx, rx) = flume::bounded(1);
        self.call_async(method, params, Box::new(move |result| drop(tx.send(result))))?;
        match rx.recv_timeout(RPC_TIMEOUT) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(AgentError::Protocol(format!("codex {method}: {message}"))),
            Err(_) => Err(AgentError::Protocol(format!("codex did not answer {method} in time"))),
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.child()?.write_json(&json!({ "method": method, "params": params }))
    }

    fn reply(&self, id: &Value, body: std::result::Result<Value, (i64, &str)>) {
        let message = match body {
            Ok(result) => json!({ "id": id, "result": result }),
            Err((code, message)) => json!({ "id": id, "error": { "code": code, "message": message } }),
        };
        if let Ok(child) = self.child() {
            let _ = child.write_json(&message);
        }
    }

    fn interrupt(&self, session: &SessionState, turn_id: &str) {
        let _ = self.call_async("turn/interrupt", json!({ "threadId": session.thread_id, "turnId": turn_id }), Box::new(|_| {}));
    }

    fn on_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else { return };
        let method = str_of(&message, "method");
        let id = message.get("id").filter(|id| !id.is_null());
        match (method, id) {
            (None, Some(id)) => {
                let Some(callback) = id.as_u64().and_then(|id| lock(&self.calls).remove(&id)) else {
                    return;
                };
                let result = match message.get("error") {
                    Some(error) if !error.is_null() => Err(str_of(error, "message").map(str::to_string).unwrap_or_else(|| error.to_string())),
                    _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                callback(result);
            }
            (Some(method), Some(id)) => self.on_server_request(method, id, message.get("params").unwrap_or(&Value::Null)),
            (Some(method), None) => {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let session = {
                    let mut early = lock(&self.early);
                    match self.session.get() {
                        Some(session) => session,
                        None => {
                            early.push((method.to_string(), params));
                            return;
                        }
                    }
                };
                self.on_notification(session, method, &params);
            }
            (None, None) => {}
        }
    }

    fn on_notification(&self, session: &SessionState, method: &str, params: &Value) {
        let events = lock(&session.projector).notification(method, params);
        let root = str_of(params, "threadId").is_none_or(|thread| thread == session.thread_id);
        if root && method == "turn/started" {
            let turn_id = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
            *lock(&session.turn_id) = turn_id.clone();
            // A turn codex started by itself still has a beginning.
            let _ = session.core.begin_turn("");
            if let Some(turn_id) = turn_id
                && session.abort_wanted.load(Ordering::SeqCst)
            {
                self.interrupt(session, &turn_id);
            }
        }
        for (path, kind) in events {
            if path.is_empty() && matches!(kind, EventKind::TurnFinished { .. }) {
                *lock(&session.turn_id) = None;
                session.abort_wanted.store(false, Ordering::SeqCst);
                session.turns_finished.fetch_add(1, Ordering::SeqCst);
                lock(&session.approvals).clear();
            }
            session.core.emit(path, kind);
        }
        if method == "serverRequest/resolved" {
            // codex withdrew a request (the turn was interrupted, or another client answered).
            let id = params
                .get("requestId")
                .map(|id| id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string()));
            if let Some(id) = id
                && lock(&session.approvals).remove(&id).is_some()
            {
                session.core.emit_root(EventKind::PermissionResolved {
                    request_id: id,
                    decision: PermissionDecision::Deny {
                        message: Some("withdrawn by codex".into()),
                    },
                });
            }
        }
    }

    fn on_server_request(&self, method: &str, id: &Value, params: &Value) {
        let Some(session) = self.session.get() else {
            self.reply(id, Err((-32601, "method not found")));
            return;
        };
        let request = lock(&session.projector).server_request(method, params);
        match request {
            ServerRequest::Permission {
                agent_path,
                tool,
                input,
                summary,
            } => {
                let request_id = id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string());
                lock(&session.approvals).insert(
                    request_id.clone(),
                    PendingApproval {
                        native_id: id.clone(),
                        method: method.to_string(),
                        params: params.clone(),
                    },
                );
                session.core.emit(
                    agent_path,
                    EventKind::PermissionRequested {
                        request_id,
                        tool,
                        input,
                        summary,
                    },
                );
            }
            ServerRequest::Question { text } => {
                session.core.emit_root(EventKind::Question { text });
                // Answered empty: the contract answers a question with the next prompt.
                self.reply(id, Ok(json!({ "answers": {} })));
            }
            ServerRequest::Unsupported => self.reply(id, Err((-32601, "method not found"))),
        }
    }

    fn on_exit(&self, code: Option<i32>, stderr: String) {
        let mut message = match code {
            Some(code) => format!("codex app-server exited with status {code}"),
            None => "codex app-server exited".to_string(),
        };
        if !stderr.trim().is_empty() {
            message.push_str(": ");
            message.push_str(stderr.trim());
        }
        let calls: Vec<RpcCallback> = lock(&self.calls).drain().map(|(_, callback)| callback).collect();
        for callback in calls {
            callback(Err(message.clone()));
        }
        *lock(&self.exit) = Some(message.clone());
        if let Some(session) = self.session.get() {
            finish(session, message);
        }
    }
}

fn finish(session: &SessionState, message: String) {
    if session.abort_killed.load(Ordering::SeqCst) && session.core.turn_active() {
        session.core.emit_root(EventKind::TurnFinished {
            reason: StopReason::Aborted,
            usage: Usage::default(),
        });
        session.core.finish(None);
    } else {
        session.core.finish(Some(message));
    }
}

fn user_input(cwd: &Path, content: &[ContentBlock]) -> Result<Vec<Value>> {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text(text) => Ok(json!({ "type": "text", "text": text, "text_elements": [] })),
            ContentBlock::File { path, lines } => Ok(json!({ "type": "text", "text": file_as_text(cwd, path, *lines)?, "text_elements": [] })),
            ContentBlock::Image { path } => {
                let full = absolute(cwd, path);
                if !full.is_file() {
                    return Err(rejected(rejection::UNSUPPORTED, format!("{} is not a file", full.display())));
                }
                Ok(json!({ "type": "localImage", "path": full }))
            }
        })
        .collect()
}

struct CodexDriver {
    shared: Arc<Shared>,
}

impl CodexDriver {
    fn session(&self) -> &SessionState {
        self.shared.session.get().expect("driver exists only after the thread opened")
    }
}

impl Driver for CodexDriver {
    fn check_content(&self, content: &[ContentBlock]) -> Result<()> {
        user_input(&self.session().cwd, content).map(|_| ())
    }

    fn start_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        let session = self.session();
        let input = user_input(&session.cwd, &content)?;
        let shared = self.shared.clone();
        self.shared.call_async(
            "turn/start",
            json!({ "threadId": session.thread_id, "input": input }),
            Box::new(move |result| {
                let Some(session) = shared.session.get() else { return };
                match result {
                    Ok(reply) => {
                        if let Some(turn_id) = reply.pointer("/turn/id").and_then(Value::as_str) {
                            lock(&session.turn_id).get_or_insert_with(|| turn_id.to_string());
                        }
                    }
                    Err(message) => {
                        session.core.emit_root(EventKind::Error {
                            message: format!("codex refused the turn: {message}"),
                        });
                        session.core.emit_root(EventKind::TurnFinished {
                            reason: StopReason::Error,
                            usage: Usage::default(),
                        });
                    }
                }
            }),
        )
    }

    fn steer(&self, content: Vec<ContentBlock>) -> Result<()> {
        let session = self.session();
        let Some(turn_id) = lock(&session.turn_id).clone() else {
            return Err(rejected(rejection::NO_ACTIVE_TURN, "codex has not reported the running turn's id yet"));
        };
        let input = user_input(&session.cwd, &content)?;
        let shared = self.shared.clone();
        self.shared.call_async(
            "turn/steer",
            json!({ "threadId": session.thread_id, "expectedTurnId": turn_id, "input": input }),
            Box::new(move |result| {
                // Acceptance was already answered; a late refusal can only be reported as a fact.
                if let (Err(message), Some(session)) = (result, shared.session.get()) {
                    session.core.emit_root(EventKind::Error {
                        message: format!("codex refused the steer: {message}"),
                    });
                }
            }),
        )
    }

    fn abort(&self) -> Result<()> {
        let session = self.session();
        session.abort_wanted.store(true, Ordering::SeqCst);
        if let Some(turn_id) = lock(&session.turn_id).clone() {
            self.shared.interrupt(session, &turn_id);
        }
        let shared = self.shared.clone();
        let turn = session.turns_finished.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            let Some(session) = shared.session.get() else { return };
            let deadline = std::time::Instant::now() + ABORT_GRACE;
            while std::time::Instant::now() < deadline {
                if session.turns_finished.load(Ordering::SeqCst) != turn || !session.core.turn_active() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            session.abort_killed.store(true, Ordering::SeqCst);
            if let Some(child) = shared.child.get() {
                child.kill();
            }
        });
        Ok(())
    }

    /// codex has no field for a denial's message; it is not delivered.
    fn respond_permission(&self, request_id: &str, decision: &PermissionDecision) -> Result<()> {
        let Some(pending) = lock(&self.session().approvals).remove(request_id) else {
            return Err(rejected(rejection::UNKNOWN_REQUEST, format!("codex no longer waits on `{request_id}`")));
        };
        self.shared
            .reply(&pending.native_id, Ok(decision_reply(&pending.method, &pending.params, decision)));
        Ok(())
    }

    fn dispose(&self) {
        if let Some(child) = self.shared.child.get() {
            child.kill();
        }
    }
}

fn connect(binary: &Path, cwd: &Path, env: &[(String, String)]) -> Result<Arc<Shared>> {
    let shared = Arc::new(Shared {
        child: OnceLock::new(),
        next_id: AtomicU64::new(1),
        calls: Mutex::new(HashMap::new()),
        session: OnceLock::new(),
        early: Mutex::new(Vec::new()),
        exit: Mutex::new(None),
    });
    let on_line = {
        let shared = shared.clone();
        move |line: &str| shared.on_line(line)
    };
    let on_exit = {
        let shared = shared.clone();
        move |code: Option<i32>, stderr: String| shared.on_exit(code, stderr)
    };
    let child = LineChild::spawn(
        Spawn {
            label: ID,
            binary,
            args: vec!["app-server".into(), "--listen".into(), "stdio://".into()],
            cwd,
            env,
            env_remove: &[],
        },
        on_line,
        on_exit,
    )?;
    let _ = shared.child.set(child.clone());
    let initialized = shared
        .call(
            "initialize",
            json!({
                "clientInfo": { "name": "vibevalley", "title": "VibeValley", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true },
            }),
        )
        .and_then(|_| shared.notify("initialized", json!({})));
    if let Err(error) = initialized {
        child.kill();
        return Err(error);
    }
    Ok(shared)
}

impl Runtime for CodexRuntime {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        "Codex"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
        }
    }

    fn installation(&self) -> Installation {
        probe_installation_with(ID, Some(&LOGIN))
    }

    fn account_usage(&self) -> Result<AccountUsage> {
        let binary = require_binary(ID)?;
        let shared = connect(&binary, &std::env::temp_dir(), &[])?;
        // Account first: an API-key login has no subscription windows, and
        // the rate-limit read would wrongly say to log in again.
        let account = shared.call("account/read", json!({})).ok();
        let result = if account.as_ref().is_some_and(non_subscription) {
            Ok(AccountUsage::Unsupported {
                reason: "unsupported_auth_mode".into(),
            })
        } else {
            match shared.call("account/rateLimits/read", json!({})) {
                Ok(limits) => usage_of(&limits, account.as_ref().and_then(email_of))
                    .ok_or_else(|| AgentError::Protocol("codex returned no usable account usage windows".into())),
                Err(AgentError::Protocol(m)) if m.to_lowercase().contains("auth") => Ok(AccountUsage::ReauthRequired {
                    reason: "not_authenticated".into(),
                }),
                Err(e) => Err(e),
            }
        };
        if let Some(child) = shared.child.get() {
            child.kill();
        }
        result
    }

    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let binary = require_binary(ID)?;
        let shared = connect(&binary, &std::env::temp_dir(), &[])?;
        let mut models = Vec::new();
        let mut cursor = Value::Null;
        let result = loop {
            let page = match shared.call("model/list", json!({ "cursor": cursor, "limit": 100 })) {
                Ok(page) => page,
                Err(error) => break Err(error),
            };
            for model in page.get("data").and_then(Value::as_array).into_iter().flatten() {
                if model.get("hidden").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let Some(id) = str_of(model, "model").or_else(|| str_of(model, "id")) else {
                    continue;
                };
                let mut info = ModelInfo::new(id, str_of(model, "displayName").unwrap_or(id));
                info.effort_levels = model
                    .get("supportedReasoningEfforts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| str_of(e, "reasoningEffort").map(str::to_string))
                    .collect();
                info.default_effort = str_of(model, "defaultReasoningEffort").map(str::to_string);
                info.is_default = model.get("isDefault").and_then(Value::as_bool) == Some(true);
                models.push(info);
            }
            cursor = page.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                break Ok(());
            }
        };
        if let Some(child) = shared.child.get() {
            child.kill();
        }
        result.map(|_| models)
    }

    /// Every `SessionOptions` field has a codex seam (see the module docs for
    /// `permission_mode`). A model codex does not end up running, or a
    /// `resume` id it does not know, fails the open before a session exists.
    fn open(&self, opts: SessionOptions) -> Result<Arc<dyn Session>> {
        check_cwd(&opts.cwd)?;
        if !opts.disallowed_tools.is_empty() {
            return Err(AgentError::Unsupported {
                option: "disallowed_tools".into(),
                reason: "codex has no setting that forbids single tools".into(),
            });
        }
        let binary = require_binary(ID)?;
        let file = record::open_file(opts.record_to.as_deref())?;
        let shared = connect(&binary, &opts.cwd, &opts.env)?;
        let kill = |error: AgentError| {
            if let Some(child) = shared.child.get() {
                child.kill();
            }
            error
        };
        let (method, params) = open_request(&opts);
        let reply = shared.call(method, params).map_err(|error| {
            kill(match (&opts.resume, error) {
                (Some(_), AgentError::Protocol(message)) => AgentError::Rejected(format!("session_not_found: {message}")),
                (_, error) => error,
            })
        })?;
        let Some(thread_id) = reply.pointer("/thread/id").and_then(Value::as_str).map(str::to_string) else {
            return Err(kill(AgentError::Protocol(format!("codex {method} returned no thread id"))));
        };
        let model = str_of(&reply, "model").map(str::to_string);
        if let (Some(wanted), Some(running)) = (&opts.model, &model)
            && wanted != running
        {
            return Err(kill(AgentError::Unsupported {
                option: "model".into(),
                reason: format!("codex runs `{running}` although `{wanted}` was requested"),
            }));
        }
        let recorder = Recorder::start(file, ID, &thread_id, &opts.cwd, model.as_deref());
        let core = SessionCore::new(ID, &thread_id, recorder);
        core.emit_root(EventKind::SessionStarted {
            session_id: thread_id.clone(),
            model,
        });
        let _ = shared.session.set(SessionState {
            core: core.clone(),
            projector: Mutex::new(Projector::new(&thread_id)),
            thread_id,
            turn_id: Mutex::new(None),
            abort_wanted: AtomicBool::new(false),
            abort_killed: AtomicBool::new(false),
            turns_finished: AtomicU64::new(0),
            approvals: Mutex::new(HashMap::new()),
            cwd: opts.cwd.clone(),
        });
        if let Some(session) = shared.session.get() {
            let held: Vec<(String, Value)> = std::mem::take(&mut *lock(&shared.early));
            for (method, params) in held {
                shared.on_notification(session, &method, &params);
            }
            let exited = lock(&shared.exit).clone();
            if let Some(message) = exited {
                finish(session, message);
            }
        }
        Ok(CoreSession::new(core, CodexDriver { shared }, self.capabilities()))
    }
}

fn non_subscription(account: &Value) -> bool {
    let kind = account.pointer("/account/type").and_then(Value::as_str);
    matches!(kind, Some("apiKey" | "amazonBedrock")) || account.get("requiresOpenaiAuth") == Some(&json!(false))
}

/// Only a ChatGPT (subscription) login has an account email worth showing.
fn email_of(account: &Value) -> Option<String> {
    let account = account.get("account")?;
    (account.get("type")? == "chatgpt")
        .then(|| account.get("email")?.as_str().map(str::to_string))
        .flatten()
}

fn window_label(minutes: Option<f64>) -> String {
    let Some(m) = minutes.filter(|m| *m > 0.0).map(|m| m as u64) else {
        return "Usage limit".into();
    };
    let unit = |n: u64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    if m % (7 * 24 * 60) == 0 {
        unit(m / (7 * 24 * 60), "week", "weeks")
    } else if m % (24 * 60) == 0 {
        unit(m / (24 * 60), "day", "days")
    } else if m % 60 == 0 {
        unit(m / 60, "hour", "hours")
    } else {
        format!("{m} minutes")
    }
}

/// `account/rateLimits/read` as oar projects it (`projectCodexUsage`): the
/// single-bucket view first, then the other buckets by limit id.
pub(crate) fn usage_of(result: &Value, email: Option<String>) -> Option<AccountUsage> {
    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty() && s.len() <= 80).map(str::to_string);
    let historical = result.get("rateLimits").filter(|v| v.is_object());
    let primary_id = historical.and_then(|h| text(&h["limitId"]));
    let mut buckets: Vec<&Value> = historical.into_iter().collect();
    if let Some(indexed) = result.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for (id, bucket) in indexed {
            if !bucket.is_object() {
                continue;
            }
            if primary_id
                .as_deref()
                .is_some_and(|p| p == id || Some(p.to_string()) == text(&bucket["limitId"]))
            {
                continue;
            }
            buckets.push(bucket);
        }
    }
    let (mut windows, mut rate_limited, mut plan) = (Vec::new(), false, None);
    for bucket in buckets {
        let limit_id = text(&bucket["limitId"]);
        let source = text(&bucket["limitName"]).or_else(|| limit_id.as_deref().map(|id| if id == "codex" { "Codex".to_string() } else { id.to_string() }));
        plan = plan.or_else(|| text(&bucket["planType"]));
        rate_limited |= !bucket["rateLimitReachedType"].is_null();
        for kind in ["primary", "secondary"] {
            let w = &bucket[kind];
            let Some(used) = w.get("usedPercent").and_then(Value::as_f64).filter(|u| (0.0..=100.0).contains(u)) else {
                continue;
            };
            let minutes = w.get("windowDurationMins").and_then(Value::as_f64);
            let duration = window_label(minutes);
            windows.push(UsageWindow {
                label: match &source {
                    Some(s) => format!("{s} · {duration}"),
                    None => duration,
                },
                used_ratio: (used / 100.0 * 1e6).round() / 1e6,
                resets_at: w
                    .get("resetsAt")
                    .and_then(Value::as_i64)
                    .and_then(|s| jiff::Timestamp::from_second(s).ok())
                    .map(|t| t.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
                id: limit_id.as_ref().map(|id| format!("{id}:{kind}")),
                duration_ms: minutes.filter(|m| *m > 0.0).map(|m| (m * 60_000.0) as u64),
            });
            rate_limited |= used >= 100.0;
        }
    }
    if windows.is_empty() {
        return None;
    }
    Some(AccountUsage::Available {
        plan,
        email,
        rate_limited,
        windows,
    })
}
