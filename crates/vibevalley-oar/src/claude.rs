//! Claude Code, driven through `claude -p` with stream-json on both pipes.
//!
//! Protocol notes (verified against claude 2.1.322):
//! - `--permission-prompt-tool stdio` makes claude ask the host: it sends a
//!   `control_request` `can_use_tool` and waits for our `control_response`.
//! - `system/init` only arrives with the first prompt, so `open` confirms
//!   readiness with an `initialize` control request, whose answer also lists
//!   the models.
//! - `result.total_cost_usd` is the process's running total; turns report
//!   the difference.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};

use crate::core::{CoreSession, Driver, SessionCore, absolute, file_as_text, lock, rejected, rejection};
use crate::process::{LineChild, LoginCheck, LoginStatus, Spawn, probe_installation_with, require_binary};
use crate::record::{self, Recorder};
use crate::{
    AccountUsage, AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, Installation, ModelInfo, PermissionDecision, PermissionMode, Result,
    Runtime, Session, SessionOptions, StopReason, Usage, UsageWindow,
};

const ID: &str = "claude";
const OPEN_TIMEOUT: Duration = Duration::from_secs(60);
const ABORT_GRACE: Duration = Duration::from_secs(10);

/// Variables a running Claude Code sets for its own children. A claude we
/// start must not inherit them, or it believes it is part of that session
/// (the list is oar's `CLAUDE_PARENT_SESSION_MARKERS`).
const PARENT_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
    "CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_HOST_WORKTREE",
    "CLAUDE_CODE_HOST_WORKTREE_FENCE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
];

const FILE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];

pub(crate) struct ClaudeRuntime;

impl ClaudeRuntime {
    pub(crate) fn new() -> Self {
        Self
    }
}

fn permission_mode_flag(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Bypass => "bypassPermissions",
        PermissionMode::Plan => "plan",
    }
}

/// `claude auth status` prints JSON with `loggedIn`.
const LOGIN: LoginCheck = LoginCheck {
    args: &["auth", "status"],
    status: claude_login_status,
};

pub(crate) fn claude_login_status(ok: bool, text: &str) -> LoginStatus {
    let start = text.find('{').unwrap_or(0);
    let reported = serde_json::from_str::<Value>(&text[start..])
        .ok()
        .and_then(|status| status.get("loggedIn").and_then(Value::as_bool));
    match reported {
        Some(false) => LoginStatus::SignedOut,
        Some(true) => LoginStatus::SignedIn,
        None if ok => LoginStatus::SignedIn,
        None => LoginStatus::Unknown,
    }
}

pub(crate) fn launch_args(session_id: &str, opts: &SessionOptions) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        permission_mode_flag(opts.permission_mode),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(if opts.resume.is_some() { "--resume".into() } else { "--session-id".into() });
    args.push(session_id.to_string());
    if let Some(model) = &opts.model {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(prompt) = &opts.system_prompt {
        args.push("--system-prompt".into());
        args.push(prompt.clone());
    }
    if let Some(prompt) = &opts.append_system_prompt {
        args.push("--append-system-prompt".into());
        args.push(prompt.clone());
    }
    if let Some(effort) = &opts.effort {
        args.push("--effort".into());
        args.push(effort.clone());
    }
    if !opts.allowed_tools.is_empty() {
        args.extend(["--allowed-tools".into(), opts.allowed_tools.join(",")]);
    }
    for dir in &opts.additional_directories {
        args.extend(["--add-dir".into(), dir.to_string_lossy().into_owned()]);
    }
    if let Some(schema) = &opts.output_schema {
        args.extend(["--json-schema".into(), schema.to_string()]);
    }
    if !opts.disallowed_tools.is_empty() {
        args.push("--disallowed-tools".into());
        args.extend(opts.disallowed_tools.iter().cloned());
    }
    args
}

/// What one stdout line means, before any session state is touched.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Out {
    Event(Vec<String>, EventKind),
    /// The root agent is producing output (opens a turn nobody prompted for).
    RootActivity,
    ControlResponse {
        request_id: String,
        result: std::result::Result<Value, String>,
    },
    Permission {
        request_id: String,
        agent_path: Vec<String>,
        tool: String,
        input: Value,
        summary: String,
        suggestions: Value,
    },
    /// `AskUserQuestion`: surfaced as a `Question`, answered by the next prompt.
    Question {
        request_id: String,
        text: String,
    },
    PermissionCancelled {
        request_id: String,
    },
}

struct ToolInfo {
    name: String,
    input: Value,
    agent_path: Vec<String>,
}

/// stream-json stdout → events, as a pure fold (tests feed it fixtures).
#[derive(Default)]
pub(crate) struct Projector {
    streamed_messages: HashSet<String>,
    tools: HashMap<String, ToolInfo>,
    last_total_cost: f64,
    pub(crate) abort_requested: bool,
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match str_of(block, "type") {
                Some("text") => str_of(block, "text").unwrap_or_default().to_string(),
                Some(other) => format!("[{other}]"),
                None => block.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn question_text(input: &Value) -> String {
    let questions = input.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut lines = Vec::new();
    for question in &questions {
        lines.push(str_of(question, "question").unwrap_or_default().to_string());
        for option in question.get("options").and_then(Value::as_array).into_iter().flatten() {
            let label = str_of(option, "label").unwrap_or_default();
            match str_of(option, "description") {
                Some(description) if !description.is_empty() => lines.push(format!("- {label}: {description}")),
                _ => lines.push(format!("- {label}")),
            }
        }
    }
    if lines.is_empty() { input.to_string() } else { lines.join("\n") }
}

fn permission_summary(request: &Value) -> String {
    let tool = str_of(request, "display_name").or_else(|| str_of(request, "tool_name")).unwrap_or("tool");
    let input = request.get("input").unwrap_or(&Value::Null);
    let detail = str_of(input, "command")
        .or_else(|| str_of(request, "description"))
        .or_else(|| str_of(input, "file_path"))
        .or_else(|| str_of(input, "url"))
        .unwrap_or_default();
    if detail.is_empty() { tool.to_string() } else { format!("{tool}: {detail}") }
}

impl Projector {
    fn agent_path(&self, message: &Value) -> Vec<String> {
        match str_of(message, "parent_tool_use_id") {
            Some(parent) => {
                let mut path = self.tools.get(parent).map(|t| t.agent_path.clone()).unwrap_or_default();
                path.push(parent.to_string());
                path
            }
            None => Vec::new(),
        }
    }

    pub(crate) fn feed(&mut self, message: &Value) -> Vec<Out> {
        let mut out = Vec::new();
        match str_of(message, "type").unwrap_or_default() {
            "stream_event" => {
                let path = self.agent_path(message);
                let event = message.get("event").unwrap_or(&Value::Null);
                match str_of(event, "type").unwrap_or_default() {
                    "message_start" => {
                        if let Some(id) = event.pointer("/message/id").and_then(Value::as_str) {
                            self.streamed_messages.insert(id.to_string());
                        }
                        if path.is_empty() {
                            out.push(Out::RootActivity);
                        }
                    }
                    "content_block_delta" => {
                        let delta = event.get("delta").unwrap_or(&Value::Null);
                        match str_of(delta, "type") {
                            Some("text_delta") => {
                                let text = str_of(delta, "text").unwrap_or_default();
                                if !text.is_empty() {
                                    out.push(Out::Event(path, EventKind::TextDelta { text: text.to_string() }));
                                }
                            }
                            Some("thinking_delta") => {
                                let text = str_of(delta, "thinking").unwrap_or_default();
                                if !text.is_empty() {
                                    out.push(Out::Event(path, EventKind::ThinkingDelta { text: text.to_string() }));
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let path = self.agent_path(message);
                if path.is_empty() {
                    out.push(Out::RootActivity);
                }
                let inner = message.get("message").unwrap_or(&Value::Null);
                // Text of a message that streamed already arrived as deltas.
                let streamed = str_of(inner, "id").is_some_and(|id| self.streamed_messages.contains(id));
                for block in inner.get("content").and_then(Value::as_array).into_iter().flatten() {
                    match str_of(block, "type") {
                        Some("text") if !streamed => {
                            if let Some(text) = str_of(block, "text").filter(|t| !t.is_empty()) {
                                out.push(Out::Event(path.clone(), EventKind::TextDelta { text: text.to_string() }));
                            }
                        }
                        Some("thinking") if !streamed => {
                            if let Some(text) = str_of(block, "thinking").filter(|t| !t.is_empty()) {
                                out.push(Out::Event(path.clone(), EventKind::ThinkingDelta { text: text.to_string() }));
                            }
                        }
                        Some("tool_use") => {
                            let id = str_of(block, "id").unwrap_or_default().to_string();
                            let name = str_of(block, "name").unwrap_or_default().to_string();
                            let input = block.get("input").cloned().unwrap_or(Value::Null);
                            self.tools.insert(
                                id.clone(),
                                ToolInfo {
                                    name: name.clone(),
                                    input: input.clone(),
                                    agent_path: path.clone(),
                                },
                            );
                            out.push(Out::Event(path.clone(), EventKind::ToolCallStarted { id, name, input }));
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                let path = self.agent_path(message);
                let blocks = message.pointer("/message/content").and_then(Value::as_array);
                for block in blocks.into_iter().flatten() {
                    if str_of(block, "type") != Some("tool_result") {
                        continue;
                    }
                    let id = str_of(block, "tool_use_id").unwrap_or_default().to_string();
                    let ok = block.get("is_error").and_then(Value::as_bool) != Some(true);
                    out.push(Out::Event(
                        path.clone(),
                        EventKind::ToolCallFinished {
                            id: id.clone(),
                            ok,
                            output: tool_result_text(block.get("content")),
                        },
                    ));
                    let Some(tool) = self.tools.get(&id) else { continue };
                    if !ok || !FILE_TOOLS.contains(&tool.name.as_str()) {
                        continue;
                    }
                    let result = message.get("tool_use_result").unwrap_or(&Value::Null);
                    let file = str_of(result, "filePath")
                        .or_else(|| str_of(&tool.input, "file_path"))
                        .or_else(|| str_of(&tool.input, "notebook_path"));
                    if let Some(file) = file {
                        let change = if str_of(result, "type") == Some("create") {
                            FileChangeKind::Created
                        } else {
                            FileChangeKind::Modified
                        };
                        out.push(Out::Event(
                            path.clone(),
                            EventKind::FileChanged {
                                path: PathBuf::from(file),
                                change,
                            },
                        ));
                    }
                }
            }
            "result" => {
                let subtype = str_of(message, "subtype").unwrap_or_default();
                let is_error = message.get("is_error").and_then(Value::as_bool) == Some(true);
                let aborted = std::mem::take(&mut self.abort_requested);
                let reason = if subtype == "success" && !is_error {
                    StopReason::Completed
                } else if aborted {
                    StopReason::Aborted
                } else if subtype == "error_max_turns" {
                    StopReason::MaxTurns
                } else {
                    StopReason::Error
                };
                if reason == StopReason::Error {
                    let detail = str_of(message, "result")
                        .map(str::to_string)
                        .or_else(|| message.get("errors").filter(|e| !e.is_null()).map(Value::to_string))
                        .unwrap_or_else(|| subtype.to_string());
                    out.push(Out::Event(Vec::new(), EventKind::Error { message: detail }));
                }
                let usage = message.get("usage").unwrap_or(&Value::Null);
                let count = |key: &str| usage.get(key).and_then(Value::as_u64);
                // Cache reads and writes are input too (oar's TokenTotals.input).
                let input_tokens =
                    count("input_tokens").map(|base| base + count("cache_read_input_tokens").unwrap_or(0) + count("cache_creation_input_tokens").unwrap_or(0));
                let cost_usd = message.get("total_cost_usd").and_then(Value::as_f64).map(|total| {
                    let turn = (total - self.last_total_cost).max(0.0);
                    self.last_total_cost = total;
                    turn
                });
                out.push(Out::Event(
                    Vec::new(),
                    EventKind::TurnFinished {
                        reason,
                        usage: Usage {
                            input_tokens,
                            output_tokens: count("output_tokens"),
                            cost_usd,
                        },
                    },
                ));
            }
            "control_response" => {
                let response = message.get("response").unwrap_or(&Value::Null);
                let request_id = str_of(response, "request_id").unwrap_or_default().to_string();
                let result = if str_of(response, "subtype") == Some("success") {
                    Ok(response.get("response").cloned().unwrap_or(Value::Null))
                } else {
                    Err(str_of(response, "error").unwrap_or("control request failed").to_string())
                };
                out.push(Out::ControlResponse { request_id, result });
            }
            "control_request" => {
                let request_id = str_of(message, "request_id").unwrap_or_default().to_string();
                let request = message.get("request").unwrap_or(&Value::Null);
                if str_of(request, "subtype") == Some("can_use_tool") {
                    let tool = str_of(request, "tool_name").unwrap_or_default().to_string();
                    let input = request.get("input").cloned().unwrap_or(Value::Null);
                    if tool == "AskUserQuestion" {
                        out.push(Out::Question {
                            request_id,
                            text: question_text(&input),
                        });
                    } else {
                        let agent_path = str_of(request, "tool_use_id")
                            .and_then(|id| self.tools.get(id))
                            .map(|t| t.agent_path.clone())
                            .unwrap_or_default();
                        out.push(Out::Permission {
                            request_id,
                            agent_path,
                            summary: permission_summary(request),
                            tool,
                            input,
                            suggestions: request.get("permission_suggestions").cloned().unwrap_or(Value::Null),
                        });
                    }
                }
            }
            "control_cancel_request" => {
                out.push(Out::PermissionCancelled {
                    request_id: str_of(message, "request_id").unwrap_or_default().to_string(),
                });
            }
            _ => {}
        }
        out
    }
}

struct PendingPermission {
    tool: String,
    input: Value,
    suggestions: Value,
    agent_path: Vec<String>,
}

struct Shared {
    core: Arc<SessionCore>,
    child: OnceLock<Arc<LineChild>>,
    projector: Mutex<Projector>,
    pending: Mutex<HashMap<String, PendingPermission>>,
    control: Mutex<HashMap<String, flume::Sender<std::result::Result<Value, String>>>>,
    /// Steers written during the turn that just ended; one of them is the
    /// likely cause when claude starts another turn by itself.
    steers: Mutex<VecDeque<String>>,
    next_control: AtomicU64,
    opened: AtomicBool,
    exit: Mutex<Option<String>>,
    abort_killed: AtomicBool,
    turns_finished: AtomicU64,
    cwd: PathBuf,
    timeout: Duration,
    secrets: Mutex<Option<tempfile::TempDir>>,
}

impl Shared {
    fn child(&self) -> Result<&Arc<LineChild>> {
        self.child.get().ok_or_else(|| AgentError::Io("claude is not running".into()))
    }

    fn control_request(&self, request: Value) -> Result<flume::Receiver<std::result::Result<Value, String>>> {
        let id = format!("vibevalley-{}", self.next_control.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = flume::bounded(1);
        lock(&self.control).insert(id.clone(), tx);
        self.child()?
            .write_json(&json!({ "type": "control_request", "request_id": id, "request": request }))?;
        Ok(rx)
    }

    fn answer(&self, request_id: &str, response: Value) -> Result<()> {
        self.child()?.write_json(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request_id, "response": response },
        }))
    }

    fn on_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else { return };
        if self.core.runtime_id() != ID
            && message.get("parent_tool_use_id").is_none_or(Value::is_null)
            && let Some(id) = str_of(&message, "session_id").filter(|id| !id.is_empty())
            && self.core.identify(id)
        {
            self.core.emit_root(EventKind::SessionStarted {
                session_id: id.into(),
                model: str_of(&message, "model").map(String::from),
            });
        }
        let path = lock(&self.projector).agent_path(&message);
        let ty = str_of(&message, "type").unwrap_or("unknown");
        let kind = str_of(&message, "subtype").map_or_else(|| ty.to_owned(), |s| format!("{ty}/{s}"));
        let _frame = self.core.record_raw(&kind, path, line, &message);
        let outs = lock(&self.projector).feed(&message);
        for out in outs {
            match out {
                Out::RootActivity => {
                    if self.opened.load(Ordering::SeqCst) && !self.core.turn_active() {
                        let steer = lock(&self.steers).drain(..).collect::<Vec<_>>().join("\n");
                        let _ = self.core.begin_turn(&steer);
                    }
                }
                Out::Event(path, kind) => {
                    let finished = path.is_empty() && matches!(kind, EventKind::TurnFinished { .. });
                    if finished {
                        lock(&self.pending).clear();
                        self.turns_finished.fetch_add(1, Ordering::SeqCst);
                    }
                    self.core.emit(path, kind);
                }
                Out::ControlResponse { request_id, result } => {
                    if let Some(waiter) = lock(&self.control).remove(&request_id) {
                        let _ = waiter.send(result);
                    }
                }
                Out::Permission {
                    request_id,
                    agent_path,
                    tool,
                    input,
                    summary,
                    suggestions,
                } => {
                    lock(&self.pending).insert(
                        request_id.clone(),
                        PendingPermission {
                            tool: tool.clone(),
                            input: input.clone(),
                            suggestions,
                            agent_path: agent_path.clone(),
                        },
                    );
                    self.core.emit(
                        agent_path,
                        EventKind::PermissionRequested {
                            request_id,
                            tool,
                            input,
                            summary,
                        },
                    );
                }
                Out::Question { request_id, text } => {
                    self.core.emit_root(EventKind::Question { text });
                    // The contract answers a question with the next prompt, so
                    // the tool is declined and the turn left to end.
                    let _ = self.answer(
                        &request_id,
                        json!({
                            "behavior": "deny",
                            "message": "The question was shown to the user. Stop here; they will answer in their next message.",
                        }),
                    );
                }
                Out::PermissionCancelled { request_id } => {
                    if let Some(pending) = lock(&self.pending).remove(&request_id) {
                        self.core.emit(
                            pending.agent_path,
                            EventKind::PermissionResolved {
                                request_id,
                                decision: PermissionDecision::Deny {
                                    message: Some("withdrawn by claude".into()),
                                },
                            },
                        );
                    }
                }
            }
        }
    }

    fn on_exit(&self, code: Option<i32>, stderr: String) {
        self.core.observe_exit(self.child.get().and_then(|c| c.status()));
        lock(&self.secrets).take();
        let runtime = self.core.runtime_id();
        let mut message = match code {
            Some(code) => format!("{runtime} exited with status {code}"),
            None => format!("{runtime} exited"),
        };
        if !stderr.trim().is_empty() {
            message.push_str(": ");
            message.push_str(stderr.trim());
        }
        for (_, waiter) in lock(&self.control).drain() {
            let _ = waiter.send(Err(message.clone()));
        }
        *lock(&self.exit) = Some(message.clone());
        if self.opened.load(Ordering::SeqCst) {
            self.finish(message);
        }
    }

    fn finish(&self, message: String) {
        if self.abort_killed.load(Ordering::SeqCst) && self.core.turn_active() {
            self.core.emit_root(EventKind::TurnFinished {
                reason: StopReason::Aborted,
                usage: Usage::default(),
            });
            self.core.finish(None);
        } else {
            self.core.finish(Some(message));
        }
    }
}

fn image_media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn user_content(cwd: &Path, content: &[ContentBlock]) -> Result<Vec<Value>> {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text(text) => Ok(json!({ "type": "text", "text": text })),
            ContentBlock::File { path, lines } => Ok(json!({ "type": "text", "text": file_as_text(cwd, path, *lines)? })),
            ContentBlock::Image { path } => {
                let full = absolute(cwd, path);
                let media_type = image_media_type(&full).ok_or_else(|| {
                    rejected(
                        rejection::UNSUPPORTED,
                        format!("{}: claude reads png, jpeg, gif and webp images", full.display()),
                    )
                })?;
                let bytes = std::fs::read(&full).map_err(|e| rejected(rejection::UNSUPPORTED, format!("cannot read {}: {e}", full.display())))?;
                Ok(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    },
                }))
            }
        })
        .collect()
}

struct ClaudeDriver {
    shared: Arc<Shared>,
}

impl ClaudeDriver {
    fn send_user(&self, content: &[ContentBlock]) -> Result<()> {
        let blocks = if content.iter().all(|b| matches!(b, ContentBlock::Text(_))) {
            json!(crate::core::render_text(content))
        } else {
            json!(user_content(&self.shared.cwd, content)?)
        };
        self.shared.child()?.write_json(&json!({
            "type": "user",
            "message": { "role": "user", "content": blocks },
            "parent_tool_use_id": null,
            "uuid": self.shared.core.span_id(),
            "session_id": self.shared.core.session_id(),
        }))
    }
}

impl Driver for ClaudeDriver {
    fn check_content(&self, content: &[ContentBlock]) -> Result<()> {
        user_content(&self.shared.cwd, content).map(|_| ())
    }

    fn start_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        lock(&self.shared.steers).clear();
        self.send_user(&content)
    }

    fn steer(&self, content: Vec<ContentBlock>) -> Result<()> {
        self.send_user(&content)?;
        lock(&self.shared.steers).push_back(crate::core::render_text(&content));
        Ok(())
    }

    fn abort(&self) -> Result<()> {
        lock(&self.shared.projector).abort_requested = true;
        // The interrupt's own answer says nothing new; the `result` frame ends the turn.
        drop(self.shared.control_request(json!({ "subtype": "interrupt" }))?);
        let shared = self.shared.clone();
        let turn = shared.turns_finished.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + ABORT_GRACE;
            while std::time::Instant::now() < deadline {
                if shared.turns_finished.load(Ordering::SeqCst) != turn || !shared.core.turn_active() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // claude did not stop: take the process down; resume continues the session.
            shared.abort_killed.store(true, Ordering::SeqCst);
            if let Some(child) = shared.child.get() {
                child.kill();
            }
        });
        Ok(())
    }

    fn respond_permission(&self, request_id: &str, decision: &PermissionDecision) -> Result<()> {
        let Some(pending) = lock(&self.shared.pending).remove(request_id) else {
            return Err(rejected(rejection::UNKNOWN_REQUEST, format!("claude no longer waits on `{request_id}`")));
        };
        let response = match decision {
            PermissionDecision::AllowOnce => json!({ "behavior": "allow", "updatedInput": pending.input }),
            PermissionDecision::AllowAlways => {
                // claude's own suggestion when it made one, else a session rule for the tool.
                let updates = match pending.suggestions.as_array() {
                    Some(suggestions) if !suggestions.is_empty() => pending.suggestions.clone(),
                    _ => json!([{
                        "type": "addRules",
                        "rules": [{ "toolName": pending.tool }],
                        "behavior": "allow",
                        "destination": "session",
                    }]),
                };
                json!({ "behavior": "allow", "updatedInput": pending.input, "updatedPermissions": updates })
            }
            PermissionDecision::Deny { message } => json!({
                "behavior": "deny",
                "message": message.clone().unwrap_or_else(|| "The user denied this tool use.".into()),
            }),
        };
        self.shared.answer(request_id, response)
    }

    fn compact(&self) -> Result<()> {
        if self.shared.core.runtime_id() == "qwen" {
            return Err(AgentError::Unsupported {
                option: "compact".into(),
                reason: "Qwen has no manual compact operation".into(),
            });
        }
        self.shared
            .child()?
            .write_json(&json!({"type":"user","session_id":self.shared.core.session_id(),"message":{"role":"user","content":"/compact"}}))
    }
    fn stop_task(&self, id: &str) -> Result<()> {
        self.shared
            .control_request(json!({"subtype":"stop_task","task_id":id}))?
            .recv_timeout(self.shared.timeout)
            .map_err(|_| AgentError::Protocol("timed out stopping task".into()))?
            .map(|_| ())
            .map_err(|e| rejected("stop_task_failed", e))
    }
    fn dispose(&self) {
        if let Some(child) = self.shared.child.get() {
            child.kill();
            self.shared.core.observe_exit(child.status());
        }
        lock(&self.shared.secrets).take();
    }
}

struct Started {
    shared: Arc<Shared>,
    init: Value,
}

pub(super) struct StreamLaunch {
    pub runtime: &'static str,
    pub args: Vec<String>,
    pub initialize: Option<Value>,
    pub secrets: Option<tempfile::TempDir>,
}

pub(crate) fn claude_launch(session_id: &str, opts: &SessionOptions) -> Result<StreamLaunch> {
    let mut args = launch_args(session_id, opts);
    let secrets = if opts.mcp_servers.is_empty() {
        None
    } else {
        let dir = crate::sdk::private_dir("oar-claude-")?;
        args.extend([
            "--mcp-config".into(),
            crate::sdk::secret(dir.path(), "mcp.json", crate::mcp_config(&opts.mcp_servers).to_string().as_bytes())?,
        ]);
        Some(dir)
    };
    Ok(StreamLaunch {
        runtime: ID,
        args,
        initialize: Some(json!({"subtype":"initialize","hooks":null})),
        secrets,
    })
}

fn start(binary: &Path, session_id: &str, opts: &SessionOptions, recorder: Option<Recorder>) -> Result<Started> {
    let launch = claude_launch(session_id, opts)?;
    start_stream(binary, session_id, opts, recorder, launch)
}

fn start_stream(binary: &Path, session_id: &str, opts: &SessionOptions, recorder: Option<Recorder>, launch: StreamLaunch) -> Result<Started> {
    let core = SessionCore::new(launch.runtime, session_id, recorder);
    let shared = Arc::new(Shared {
        core,
        child: OnceLock::new(),
        projector: Mutex::new(Projector::default()),
        pending: Mutex::new(HashMap::new()),
        control: Mutex::new(HashMap::new()),
        steers: Mutex::new(VecDeque::new()),
        next_control: AtomicU64::new(1),
        opened: AtomicBool::new(false),
        exit: Mutex::new(None),
        abort_killed: AtomicBool::new(false),
        turns_finished: AtomicU64::new(0),
        cwd: opts.cwd.clone(),
        timeout: opts.request_timeout.unwrap_or(OPEN_TIMEOUT),
        secrets: Mutex::new(launch.secrets),
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
            label: launch.runtime,
            binary,
            args: launch.args,
            cwd: &opts.cwd,
            env: &opts.env,
            options: Some(opts),
            env_remove: if launch.runtime == ID { PARENT_SESSION_MARKERS } else { &[] },
        },
        on_line,
        on_exit,
    )?;
    let _ = shared.child.set(child.clone());
    let Some(initialize) = launch.initialize else {
        return Ok(Started { shared, init: Value::Null });
    };
    let ready = shared.control_request(initialize);
    let init = match ready.and_then(|rx| {
        rx.recv_timeout(shared.timeout)
            .map_err(|_| AgentError::Protocol(format!("{} did not answer `initialize` in time", launch.runtime)))
    }) {
        Ok(Ok(init)) => init,
        Ok(Err(message)) => {
            child.kill();
            return Err(open_failure(opts, message));
        }
        Err(error) => {
            child.kill();
            return Err(error);
        }
    };
    if opts.resume.is_some() && launch.runtime == ID {
        let baseline = shared
            .control_request(json!({"subtype":"get_usage"}))
            .ok()
            .and_then(|rx| rx.recv_timeout(opts.baseline_timeout.unwrap_or(Duration::from_secs(5))).ok())
            .and_then(|r| r.ok());
        shared
            .core
            .resume_meter(baseline.as_ref().unwrap_or(&Value::Null), "missing_resume_usage_fields");
    }
    Ok(Started { shared, init })
}

fn open_failure(opts: &SessionOptions, message: String) -> AgentError {
    let lowered = message.to_ascii_lowercase();
    if opts.resume.is_some() && (lowered.contains("no conversation found") || lowered.contains("session")) {
        return AgentError::Rejected(format!("session_not_found: {message}"));
    }
    if lowered.contains("login") || lowered.contains("api key") || lowered.contains("authenticat") {
        return AgentError::NotAvailable(message);
    }
    AgentError::Protocol(message)
}

fn models_of(init: &Value) -> Vec<ModelInfo> {
    init.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = str_of(model, "value")?.to_string();
            let display_name = str_of(model, "displayName").unwrap_or(&id).to_string();
            Some(ModelInfo::new(id, display_name))
        })
        .collect()
}

fn resolved_model(init: &Value, requested: Option<&str>) -> Option<String> {
    let wanted = requested.unwrap_or("default");
    init.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|model| str_of(model, "value") == Some(wanted))
        .and_then(|model| str_of(model, "resolvedModel"))
        .map(str::to_string)
        .or_else(|| requested.map(str::to_string))
}

impl Runtime for ClaudeRuntime {
    fn id(&self) -> &str {
        ID
    }

    fn display_name(&self) -> &str {
        "Claude Code"
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
        let help = crate::process::run_capture(&binary, &["--help"], std::time::Duration::from_secs(10)).unwrap_or_default();
        if !help.contains("--safe-mode") {
            // Never query without isolation from the user's hooks and MCP servers.
            return Ok(AccountUsage::Unsupported {
                reason: "unsupported_installation".into(),
            });
        }
        read_account_usage(&binary)
    }

    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let binary = require_binary(ID)?;
        let opts = SessionOptions {
            cwd: std::env::temp_dir(),
            ..Default::default()
        };
        let started = start(&binary, &uuid::Uuid::new_v4().to_string(), &opts, None)?;
        if let Some(child) = started.shared.child.get() {
            child.kill();
        }
        Ok(models_of(&started.init))
    }

    /// Every `SessionOptions` field maps to a claude flag, so nothing is
    /// refused here beyond an unusable `cwd`. A `resume` id claude does not
    /// know fails the open (`Rejected("session_not_found: ...")`).
    fn open(&self, mut opts: SessionOptions) -> Result<Arc<dyn Session>> {
        opts.prepare(ID)?;
        if let Some(resume) = &opts.resume
            && resume.trim().is_empty()
        {
            return Err(AgentError::Unsupported {
                option: "resume".into(),
                reason: format!("invalid empty Claude session id: {resume:?}"),
            });
        }
        let binary = opts.binary(ID)?;
        let file = record::open_file(opts.record_to.as_deref())?;
        let session_id = opts.resume.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let recorder = Recorder::start(file, ID, &session_id, &opts.cwd, opts.model.as_deref());
        let started = start(&binary, &session_id, &opts, recorder)?;
        Ok(running(started, &opts, self.capabilities()))
    }
}

pub(super) fn open_sdk(binary: &Path, opts: &SessionOptions, caps: Capabilities, launch: StreamLaunch) -> Result<Arc<dyn Session>> {
    let id = opts.resume.clone().unwrap_or_else(|| format!("{}-pending", launch.runtime));
    let file = record::open_file(opts.record_to.as_deref())?;
    let recorder = Recorder::start(file, launch.runtime, &id, &opts.cwd, opts.model.as_deref());
    let started = start_stream(binary, &id, opts, recorder, launch)?;
    Ok(running(started, opts, caps))
}

fn running(started: Started, opts: &SessionOptions, caps: Capabilities) -> Arc<dyn Session> {
    let shared = started.shared;
    shared.core.emit_root(EventKind::SessionStarted {
        session_id: shared.core.session_id(),
        model: resolved_model(&started.init, opts.model.as_deref()),
    });
    shared.opened.store(true, Ordering::SeqCst);
    if let Some(message) = lock(&shared.exit).clone() {
        shared.finish(message);
    }
    let core = shared.core.clone();
    CoreSession::new(core, ClaudeDriver { shared }, caps)
}

/// `get_usage`'s answer as oar projects it (`claudeAccountUsage`).
pub(crate) fn usage_of(reply: &Value, email: Option<String>) -> Option<AccountUsage> {
    const HOUR_MS: u64 = 3_600_000;
    const WEEK_MS: u64 = 7 * 24 * HOUR_MS;
    let limits = reply.get("rate_limits")?;
    let mut windows = Vec::new();
    let mut add = |label: &str, key: &str, duration_ms: Option<u64>| {
        let entry = &limits[key];
        let Some(percent) = entry.get("utilization").and_then(Value::as_f64) else {
            return;
        };
        if !(0.0..=100.0).contains(&percent) {
            return;
        }
        windows.push(UsageWindow {
            label: label.into(),
            used_ratio: (percent / 100.0 * 1e6).round() / 1e6,
            resets_at: entry.get("resets_at").and_then(Value::as_str).map(str::to_string),
            id: Some(key.into()),
            duration_ms,
        });
    };
    add("Current session", "five_hour", Some(5 * HOUR_MS));
    add("Current week (all models)", "seven_day", Some(WEEK_MS));
    add("Current week (OAuth apps)", "seven_day_oauth_apps", Some(WEEK_MS));
    add("Current week (Opus)", "seven_day_opus", Some(WEEK_MS));
    add("Current week (Sonnet)", "seven_day_sonnet", Some(WEEK_MS));
    let included_exhausted = windows.iter().any(|w| w.used_ratio >= 1.0);
    let extra = &limits["extra_usage"];
    let mut extra_open = false;
    if extra.get("is_enabled").and_then(Value::as_bool) == Some(true)
        && let Some(percent) = extra.get("utilization").and_then(Value::as_f64)
    {
        extra_open = percent < 100.0;
        windows.push(UsageWindow {
            label: "Extra usage".into(),
            used_ratio: percent / 100.0,
            resets_at: None,
            id: Some("extra_usage".into()),
            duration_ms: None,
        });
    }
    if windows.is_empty() {
        return None;
    }
    let plan = reply
        .get("subscription_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    Some(AccountUsage::Available {
        plan,
        email,
        rate_limited: included_exhausted && !extra_open,
        windows,
    })
}

/// A separate `claude -p --safe-mode` (no hooks, no MCP servers, no prompt)
/// asked `initialize` and `get_usage`, as oar does.
pub(crate) fn read_account_usage(binary: &Path) -> Result<AccountUsage> {
    let (tx, rx) = flume::unbounded::<Value>();
    let child = LineChild::spawn(
        Spawn {
            label: "claude-usage",
            binary,
            args: [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--safe-mode",
            ]
            .map(str::to_string)
            .to_vec(),
            cwd: &std::env::temp_dir(),
            env: &[],
            options: None,
            env_remove: PARENT_SESSION_MARKERS,
        },
        move |line| {
            if let Ok(v) = serde_json::from_str::<Value>(line)
                && v["type"] == "control_response"
            {
                let _ = tx.send(v["response"].clone());
            }
        },
        |_, _| {},
    )?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let ask = |id: &str, subtype: &str| -> Result<Value> {
        child.write_json(&json!({ "type": "control_request", "request_id": id, "request": { "subtype": subtype } }))?;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let reply = rx
                .recv_timeout(left)
                .map_err(|_| AgentError::Io("claude did not answer the usage query in time".into()))?;
            if reply["request_id"] == id {
                return Ok(reply);
            }
        }
    };
    let result = (|| {
        let init = ask("usage-init", "initialize")?;
        let email = init.pointer("/response/account/email").and_then(Value::as_str).map(str::to_string);
        let reply = ask("usage-read", "get_usage")?;
        if reply["subtype"] != "success" {
            let detail = reply["error"].as_str().unwrap_or("malformed control response").to_lowercase();
            if detail.contains("not logged in") || detail.contains("authentication required") || detail.contains("/login") {
                return Ok(AccountUsage::ReauthRequired {
                    reason: "not_authenticated".into(),
                });
            }
            if detail.contains("unsupported") || detail.contains("unknown control request") || detail.contains("not supported") {
                return Ok(AccountUsage::Unsupported {
                    reason: "endpoint_unavailable".into(),
                });
            }
            return Err(AgentError::Protocol(format!("claude usage query failed: {detail}")));
        }
        let response = &reply["response"];
        if response.get("rate_limits_available").and_then(Value::as_bool) == Some(false) {
            return Ok(AccountUsage::Unsupported {
                reason: "quota_unavailable".into(),
            });
        }
        usage_of(response, email).ok_or_else(|| AgentError::Protocol("claude get_usage returned no usable windows".into()))
    })();
    child.kill();
    result
}
