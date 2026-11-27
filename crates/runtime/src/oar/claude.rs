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
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::BoxFuture;
use crate::oar::core::{CoreSession, Driver, SessionCore, absolute, file_as_text, rejected, rejection};
use crate::oar::process::{AbortWatchdog, LineChild, LoginCheck, LoginStatus, Spawn, probe_installation_with, require_binary};
use crate::oar::record::{self, Recorder};
use crate::oar::{
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAuthStatus {
    #[serde(default)]
    logged_in: Option<bool>,
}

pub(crate) fn claude_login_status(ok: bool, text: &str) -> LoginStatus {
    let start = text.find('{').unwrap_or(0);
    let reported = serde_json::from_str::<WireAuthStatus>(&text[start..]).ok().and_then(|s| s.logged_in);
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

#[derive(Default, Deserialize)]
struct WireMeta {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    parent_tool_use_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireMessage {
    StreamEvent {
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(default)]
        event: Option<WireStreamEvent>,
    },
    Assistant {
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(default)]
        message: Option<WireAssistantMessage>,
    },
    User {
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(default)]
        message: Option<WireUserMessage>,
        #[serde(default)]
        tool_use_result: Option<WireToolUseResult>,
    },
    Result {
        #[serde(default)]
        subtype: Option<String>,
        #[serde(default)]
        is_error: Option<bool>,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        errors: Option<Value>,
        #[serde(default)]
        usage: Option<WireTurnUsage>,
        #[serde(default)]
        total_cost_usd: Option<f64>,
    },
    ControlResponse {
        #[serde(default)]
        response: Option<WireControlResponse>,
    },
    ControlRequest {
        #[serde(default)]
        request_id: Option<String>,
        #[serde(default)]
        request: Option<WireControlRequest>,
    },
    ControlCancelRequest {
        #[serde(default)]
        request_id: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireStreamEvent {
    MessageStart {
        #[serde(default)]
        message: Option<WireMessageRef>,
    },
    ContentBlockDelta {
        #[serde(default)]
        delta: Option<WireContentDelta>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct WireMessageRef {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireContentDelta {
    TextDelta {
        #[serde(default)]
        text: Option<String>,
    },
    ThinkingDelta {
        #[serde(default)]
        thinking: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct WireAssistantMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    content: Option<Vec<WireAssistantBlock>>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireAssistantBlock {
    Text {
        #[serde(default)]
        text: Option<String>,
    },
    Thinking {
        #[serde(default)]
        thinking: Option<String>,
    },
    ToolUse {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        input: Value,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct WireUserMessage {
    #[serde(default)]
    content: Option<WireUserContent>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireUserContent {
    Blocks(Vec<WireUserBlock>),
    Other(#[allow(dead_code)] Value),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireUserBlock {
    ToolResult {
        #[serde(default)]
        tool_use_id: Option<String>,
        #[serde(default)]
        is_error: Option<bool>,
        #[serde(default)]
        content: Option<WireToolResultContent>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireToolResultContent {
    Text(String),
    Blocks(Vec<WireToolResultBlock>),
    Other(Value),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireToolResultBlock {
    Typed {
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        text: Option<String>,
    },
    Raw(Value),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireToolUseResult {
    Object {
        #[serde(rename = "type", default)]
        kind: Option<String>,
        #[serde(rename = "filePath", default)]
        file_path: Option<String>,
    },
    Other(#[allow(dead_code)] Value),
}

#[derive(Default, Deserialize)]
struct WireFileToolInput {
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    notebook_path: Option<String>,
}

#[derive(Deserialize)]
struct WireTurnUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct WireControlResponse {
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    response: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct WireCanUseTool {
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    permission_suggestions: Value,
}

#[derive(Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
enum WireControlRequest {
    CanUseTool(Box<WireCanUseTool>),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct WireAskUserQuestionInput {
    #[serde(default)]
    questions: Option<Vec<WireAskQuestion>>,
}

#[derive(Deserialize)]
struct WireAskQuestion {
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    options: Option<Vec<WireAskQuestionOption>>,
}

#[derive(Deserialize)]
struct WireAskQuestionOption {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Default, Deserialize)]
struct WirePermissionInputDetail {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

fn tool_result_text(content: Option<WireToolResultContent>) -> String {
    match content {
        Some(WireToolResultContent::Text(text)) => text,
        Some(WireToolResultContent::Blocks(blocks)) => blocks
            .into_iter()
            .map(|block| match block {
                WireToolResultBlock::Typed { kind, text } if kind == "text" => text.unwrap_or_default(),
                WireToolResultBlock::Typed { kind, .. } => format!("[{kind}]"),
                WireToolResultBlock::Raw(raw) => raw.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(WireToolResultContent::Other(Value::Null)) | None => String::new(),
        Some(WireToolResultContent::Other(other)) => other.to_string(),
    }
}

fn question_text(input: &Value) -> String {
    let parsed = WireAskUserQuestionInput::deserialize(input).ok();
    let mut lines = Vec::new();
    for question in parsed.and_then(|p| p.questions).into_iter().flatten() {
        lines.push(question.question.unwrap_or_default());
        for option in question.options.into_iter().flatten() {
            let label = option.label.unwrap_or_default();
            match option.description.as_deref() {
                Some(description) if !description.is_empty() => lines.push(format!("- {label}: {description}")),
                _ => lines.push(format!("- {label}")),
            }
        }
    }
    if lines.is_empty() { input.to_string() } else { lines.join("\n") }
}

fn permission_summary(display_name: Option<&str>, tool_name: Option<&str>, description: Option<&str>, input: &Value) -> String {
    let tool = display_name.or(tool_name).unwrap_or("tool");
    let detail_fields = WirePermissionInputDetail::deserialize(input).unwrap_or_default();
    let detail = detail_fields
        .command
        .as_deref()
        .or(description)
        .or(detail_fields.file_path.as_deref())
        .or(detail_fields.url.as_deref())
        .unwrap_or_default();
    if detail.is_empty() { tool.to_string() } else { format!("{tool}: {detail}") }
}

impl Projector {
    fn agent_path(&self, parent_tool_use_id: Option<&str>) -> Vec<String> {
        match parent_tool_use_id {
            Some(parent) => {
                let mut path = self.tools.get(parent).map(|t| t.agent_path.clone()).unwrap_or_default();
                path.push(parent.to_string());
                path
            }
            None => Vec::new(),
        }
    }

    pub(crate) fn feed(&mut self, message: &Value) -> Vec<Out> {
        let Ok(frame) = WireMessage::deserialize(message) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match frame {
            WireMessage::StreamEvent { parent_tool_use_id, event } => {
                let path = self.agent_path(parent_tool_use_id.as_deref());
                match event {
                    Some(WireStreamEvent::MessageStart { message }) => {
                        if let Some(id) = message.and_then(|m| m.id) {
                            self.streamed_messages.insert(id);
                        }
                        if path.is_empty() {
                            out.push(Out::RootActivity);
                        }
                    }
                    Some(WireStreamEvent::ContentBlockDelta { delta }) => match delta {
                        Some(WireContentDelta::TextDelta { text }) => {
                            if let Some(text) = text.filter(|t| !t.is_empty()) {
                                out.push(Out::Event(path, EventKind::TextDelta { text }));
                            }
                        }
                        Some(WireContentDelta::ThinkingDelta { thinking }) => {
                            if let Some(text) = thinking.filter(|t| !t.is_empty()) {
                                out.push(Out::Event(path, EventKind::ThinkingDelta { text }));
                            }
                        }
                        Some(WireContentDelta::Other) | None => {}
                    },
                    Some(WireStreamEvent::Other) | None => {}
                }
            }
            WireMessage::Assistant { parent_tool_use_id, message } => {
                let path = self.agent_path(parent_tool_use_id.as_deref());
                if path.is_empty() {
                    out.push(Out::RootActivity);
                }
                let Some(inner) = message else { return out };
                // Text of a message that streamed already arrived as deltas.
                let streamed = inner.id.as_deref().is_some_and(|id| self.streamed_messages.contains(id));
                for block in inner.content.into_iter().flatten() {
                    match block {
                        WireAssistantBlock::Text { text } if !streamed => {
                            if let Some(text) = text.filter(|t| !t.is_empty()) {
                                out.push(Out::Event(path.clone(), EventKind::TextDelta { text }));
                            }
                        }
                        WireAssistantBlock::Thinking { thinking } if !streamed => {
                            if let Some(text) = thinking.filter(|t| !t.is_empty()) {
                                out.push(Out::Event(path.clone(), EventKind::ThinkingDelta { text }));
                            }
                        }
                        WireAssistantBlock::ToolUse { id, name, input } => {
                            let id = id.unwrap_or_default();
                            let name = name.unwrap_or_default();
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
                        WireAssistantBlock::Text { .. } | WireAssistantBlock::Thinking { .. } | WireAssistantBlock::Other => {}
                    }
                }
            }
            WireMessage::User {
                parent_tool_use_id,
                message,
                tool_use_result,
            } => {
                let path = self.agent_path(parent_tool_use_id.as_deref());
                let blocks = match message.and_then(|m| m.content) {
                    Some(WireUserContent::Blocks(blocks)) => blocks,
                    _ => Vec::new(),
                };
                let (result_kind, result_file_path) = match &tool_use_result {
                    Some(WireToolUseResult::Object { kind, file_path }) => (kind.as_deref(), file_path.as_deref()),
                    _ => (None, None),
                };
                for block in blocks {
                    let WireUserBlock::ToolResult {
                        tool_use_id,
                        is_error,
                        content,
                    } = block
                    else {
                        continue;
                    };
                    let id = tool_use_id.unwrap_or_default();
                    let ok = is_error != Some(true);
                    out.push(Out::Event(
                        path.clone(),
                        EventKind::ToolCallFinished {
                            id: id.clone(),
                            ok,
                            output: tool_result_text(content),
                        },
                    ));
                    let Some(tool) = self.tools.get(&id) else { continue };
                    if !ok || !FILE_TOOLS.contains(&tool.name.as_str()) {
                        continue;
                    }
                    let file_input = WireFileToolInput::deserialize(&tool.input).unwrap_or_default();
                    let file = result_file_path.or(file_input.file_path.as_deref()).or(file_input.notebook_path.as_deref());
                    if let Some(file) = file {
                        let change = if result_kind == Some("create") {
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
            WireMessage::Result {
                subtype,
                is_error,
                result,
                errors,
                usage,
                total_cost_usd,
            } => {
                let subtype = subtype.unwrap_or_default();
                let is_error = is_error == Some(true);
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
                    let detail = result
                        .as_ref()
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| errors.as_ref().filter(|e| !e.is_null()).map(Value::to_string))
                        .unwrap_or(subtype);
                    out.push(Out::Event(Vec::new(), EventKind::Error { message: detail }));
                }
                // Cache reads and writes are input too (oar's TokenTotals.input).
                let input_tokens = usage.as_ref().and_then(|u| {
                    u.input_tokens
                        .map(|base| base + u.cache_read_input_tokens.unwrap_or(0) + u.cache_creation_input_tokens.unwrap_or(0))
                });
                let output_tokens = usage.as_ref().and_then(|u| u.output_tokens);
                let cost_usd = total_cost_usd.map(|total| {
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
                            output_tokens,
                            cost_usd,
                            ..Default::default()
                        },
                    },
                ));
            }
            WireMessage::ControlResponse { response } => {
                let (request_id, result) = match response {
                    Some(resp) => {
                        let request_id = resp.request_id.unwrap_or_default();
                        let res = if resp.subtype.as_deref() == Some("success") {
                            Ok(resp.response.unwrap_or(Value::Null))
                        } else {
                            Err(resp.error.unwrap_or_else(|| "control request failed".into()))
                        };
                        (request_id, res)
                    }
                    None => (String::new(), Err("control request failed".into())),
                };
                out.push(Out::ControlResponse { request_id, result });
            }
            WireMessage::ControlRequest { request_id, request } => {
                let request_id = request_id.unwrap_or_default();
                if let Some(WireControlRequest::CanUseTool(req)) = request {
                    let WireCanUseTool {
                        tool_name,
                        display_name,
                        description,
                        tool_use_id,
                        input,
                        permission_suggestions,
                    } = *req;
                    let tool = tool_name.unwrap_or_default();
                    if tool == "AskUserQuestion" {
                        out.push(Out::Question {
                            request_id,
                            text: question_text(&input),
                        });
                    } else {
                        let agent_path = tool_use_id
                            .as_deref()
                            .and_then(|id| self.tools.get(id))
                            .map(|t| t.agent_path.clone())
                            .unwrap_or_default();
                        let summary = permission_summary(display_name.as_deref(), Some(tool.as_str()), description.as_deref(), &input);
                        out.push(Out::Permission {
                            request_id,
                            agent_path,
                            summary,
                            tool,
                            input,
                            suggestions: permission_suggestions,
                        });
                    }
                }
            }
            WireMessage::ControlCancelRequest { request_id } => {
                out.push(Out::PermissionCancelled {
                    request_id: request_id.unwrap_or_default(),
                });
            }
            WireMessage::Other => {}
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
    control: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
    /// Steers written during the turn that just ended; one of them is the
    /// likely cause when claude starts another turn by itself.
    steers: Mutex<VecDeque<String>>,
    next_control: AtomicU64,
    opened: AtomicBool,
    exit: Mutex<Option<String>>,
    watchdog: Arc<AbortWatchdog>,
    cwd: PathBuf,
    timeout: Duration,
    secrets: Mutex<Option<tempfile::TempDir>>,
}

impl Shared {
    fn child(&self) -> Result<&Arc<LineChild>> {
        self.child.get().ok_or_else(|| AgentError::Io("claude is not running".into()))
    }

    async fn control_request(&self, request: Value) -> Result<oneshot::Receiver<std::result::Result<Value, String>>> {
        let id = format!("vibevalley-{}", self.next_control.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.control.lock().insert(id.clone(), tx);
        let sent = self
            .child()?
            .write_json(&json!({ "type": "control_request", "request_id": id, "request": request }))
            .await;
        if let Err(err) = sent {
            self.control.lock().remove(&id);
            return Err(err);
        }
        Ok(rx)
    }

    async fn answer(&self, request_id: &str, response: Value) -> Result<()> {
        self.child()?
            .write_json(&json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": request_id, "response": response },
            }))
            .await
    }

    async fn on_line(&self, line: &str) {
        let message = match serde_json::from_str::<Value>(line) {
            Ok(v) => v,
            Err(err) => {
                if !line.trim().is_empty() {
                    tracing::warn!(runtime = %self.core.runtime_id(), error = %err, line_len = line.len(), "claude dropped malformed JSON stdout line");
                }
                return;
            }
        };
        let mut questions_to_answer = Vec::new();
        {
            let meta = WireMeta::deserialize(&message).unwrap_or_default();
            if self.core.runtime_id() != ID
                && meta.parent_tool_use_id.is_none()
                && let Some(id) = meta.session_id.as_deref().filter(|id| !id.is_empty())
                && self.core.identify(id)
            {
                self.core.emit_root(EventKind::SessionStarted {
                    session_id: id.into(),
                    model: meta.model.clone(),
                });
            }
            let path = self.projector.lock().agent_path(meta.parent_tool_use_id.as_deref());
            let ty = meta.kind.as_deref().unwrap_or("unknown");
            let kind = meta.subtype.as_deref().map_or_else(|| ty.to_owned(), |s| format!("{ty}/{s}"));
            let _frame = self.core.record_raw(&kind, path, line, &message);
            let outs = self.projector.lock().feed(&message);
            for out in outs {
                match out {
                    Out::RootActivity => {
                        if self.opened.load(Ordering::SeqCst) && !self.core.turn_active() {
                            let steer = self.steers.lock().drain(..).collect::<Vec<_>>().join("\n");
                            let _ = self.core.begin_turn(&steer);
                        }
                    }
                    Out::Event(path, kind) => {
                        let finished = path.is_empty() && matches!(kind, EventKind::TurnFinished { .. });
                        if finished {
                            self.pending.lock().clear();
                            self.watchdog.on_turn_finished();
                        }
                        self.core.emit(path, kind);
                    }
                    Out::ControlResponse { request_id, result } => {
                        if let Some(waiter) = self.control.lock().remove(&request_id) {
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
                        self.pending.lock().insert(
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
                        questions_to_answer.push(request_id);
                    }
                    Out::PermissionCancelled { request_id } => {
                        if let Some(pending) = self.pending.lock().remove(&request_id) {
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
        for request_id in questions_to_answer {
            if let Err(err) = self
                .answer(
                    &request_id,
                    json!({
                        "behavior": "deny",
                        "message": "The question was shown to the user. Stop here; they will answer in their next message.",
                    }),
                )
                .await
            {
                tracing::warn!(runtime = %self.core.runtime_id(), request_id = %request_id, error = %err, "claude failed to write question control response");
            }
        }
    }

    fn on_exit(&self, code: Option<i32>, stderr: String) {
        self.core.observe_exit(self.child.get().and_then(|c| c.status()));
        self.secrets.lock().take();
        let runtime = self.core.runtime_id();
        let mut message = match code {
            Some(code) => format!("{runtime} exited with status {code}"),
            None => format!("{runtime} exited"),
        };
        if !stderr.trim().is_empty() {
            message.push_str(": ");
            message.push_str(stderr.trim());
        }
        for (_, waiter) in self.control.lock().drain() {
            let _ = waiter.send(Err(message.clone()));
        }
        *self.exit.lock() = Some(message.clone());
        if self.opened.load(Ordering::SeqCst) {
            self.watchdog.finish_on_exit(&self.core, message);
        } else {
            self.watchdog.wake();
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
    async fn send_user(&self, content: &[ContentBlock]) -> Result<()> {
        let blocks = if content.iter().all(|b| matches!(b, ContentBlock::Text(_))) {
            json!(crate::oar::core::render_text(content))
        } else {
            json!(user_content(&self.shared.cwd, content)?)
        };
        self.shared
            .child()?
            .write_json(&json!({
                "type": "user",
                "message": { "role": "user", "content": blocks },
                "parent_tool_use_id": null,
                "uuid": self.shared.core.span_id(),
                "session_id": self.shared.core.session_id(),
            }))
            .await
    }
}

impl Driver for ClaudeDriver {
    fn check_content(&self, content: &[ContentBlock]) -> Result<()> {
        user_content(&self.shared.cwd, content).map(|_| ())
    }

    fn start_turn(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.shared.steers.lock().clear();
            self.send_user(&content).await
        })
    }

    fn steer(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.send_user(&content).await?;
            self.shared.steers.lock().push_back(crate::oar::core::render_text(&content));
            Ok(())
        })
    }

    fn abort(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.shared.projector.lock().abort_requested = true;
            // The interrupt's own answer says nothing new; the `result` frame ends the turn.
            drop(self.shared.control_request(json!({ "subtype": "interrupt" })).await?);
            if let Some(child) = self.shared.child.get() {
                self.shared.watchdog.arm(ABORT_GRACE, self.shared.core.clone(), child.clone());
            }
            Ok(())
        })
    }

    fn respond_permission<'a>(&'a self, request_id: &'a str, decision: &'a PermissionDecision) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let Some(pending) = self.shared.pending.lock().remove(request_id) else {
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
            self.shared.answer(request_id, response).await
        })
    }

    fn compact(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if self.shared.core.runtime_id() == "qwen" {
                return Err(AgentError::Unsupported {
                    option: "compact".into(),
                    reason: "Qwen has no manual compact operation".into(),
                });
            }
            self.shared
                .child()?
                .write_json(&json!({"type":"user","session_id":self.shared.core.session_id(),"message":{"role":"user","content":"/compact"}}))
                .await
        })
    }
    fn stop_task<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let rx = self.shared.control_request(json!({"subtype":"stop_task","task_id":id})).await?;
            tokio::time::timeout(self.shared.timeout, rx)
                .await
                .map_err(|_| AgentError::Protocol("timed out stopping task".into()))?
                .map_err(|_| AgentError::Protocol("timed out stopping task".into()))?
                .map(|_| ())
                .map_err(|e| rejected("stop_task_failed", e))
        })
    }
    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Some(child) = self.shared.child.get() {
                child.kill().await;
                self.shared.core.observe_exit(child.status());
            }
            self.shared.watchdog.wake();
            self.shared.secrets.lock().take();
        })
    }
    fn signal_dispose(&self) {
        if let Some(child) = self.shared.child.get() {
            child.signal_kill();
            self.shared.core.observe_exit(child.status());
        }
        self.shared.watchdog.wake();
        self.shared.secrets.lock().take();
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
        let dir = crate::oar::process::private_dir("oar-claude-")?;
        args.extend([
            "--mcp-config".into(),
            crate::oar::process::secret(dir.path(), "mcp.json", crate::oar::mcp_config(&opts.mcp_servers).to_string().as_bytes())?,
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

async fn start(binary: &Path, session_id: &str, opts: &SessionOptions, recorder: Option<Recorder>) -> Result<Started> {
    let launch = claude_launch(session_id, opts)?;
    start_stream(binary, session_id, opts, recorder, launch).await
}

async fn start_stream(binary: &Path, session_id: &str, opts: &SessionOptions, recorder: Option<Recorder>, launch: StreamLaunch) -> Result<Started> {
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
        watchdog: AbortWatchdog::new(),
        cwd: opts.cwd.clone(),
        timeout: opts.request_timeout.unwrap_or(OPEN_TIMEOUT),
        secrets: Mutex::new(launch.secrets),
    });
    let on_line = {
        let shared = shared.clone();
        move |line: String| {
            let shared = shared.clone();
            async move { shared.on_line(&line).await }
        }
    };
    let on_exit = {
        let shared = shared.clone();
        move |code: Option<i32>, stderr: String| async move { shared.on_exit(code, stderr) }
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
    let init_res = match shared.control_request(initialize).await {
        Ok(rx) => match tokio::time::timeout(shared.timeout, rx).await {
            Ok(Ok(Ok(init))) => Ok(init),
            Ok(Ok(Err(message))) => Err(open_failure(opts, message)),
            Ok(Err(_)) | Err(_) => Err(AgentError::Protocol(format!("{} did not answer `initialize` in time", launch.runtime))),
        },
        Err(error) => Err(error),
    };
    let init = match init_res {
        Ok(init) => init,
        Err(error) => {
            child.kill().await;
            return Err(error);
        }
    };
    if opts.resume.is_some() && launch.runtime == ID {
        let baseline = match shared.control_request(json!({"subtype":"get_usage"})).await {
            Ok(rx) => tokio::time::timeout(opts.baseline_timeout.unwrap_or(Duration::from_secs(5)), rx)
                .await
                .ok()
                .and_then(|r| r.ok())
                .and_then(|r| r.ok()),
            Err(_) => None,
        };
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

#[derive(Default, Deserialize)]
struct WireInitResponse {
    #[serde(default)]
    models: Option<Vec<WireInitModel>>,
    #[serde(default)]
    account: Option<WireInitAccount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireInitModel {
    value: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    resolved_model: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireInitAccount {
    Object {
        #[serde(default)]
        email: Option<String>,
    },
    Other(#[allow(dead_code)] Value),
}

fn models_of(init: &Value) -> Vec<ModelInfo> {
    let parsed = WireInitResponse::deserialize(init).unwrap_or_default();
    parsed
        .models
        .into_iter()
        .flatten()
        .map(|model| {
            let display_name = model.display_name.unwrap_or_else(|| model.value.clone());
            ModelInfo::new(model.value, display_name)
        })
        .collect()
}

fn resolved_model(init: &Value, requested: Option<&str>) -> Option<String> {
    let wanted = requested.unwrap_or("default");
    let parsed = WireInitResponse::deserialize(init).unwrap_or_default();
    parsed
        .models
        .into_iter()
        .flatten()
        .find(|model| model.value == wanted)
        .and_then(|model| model.resolved_model)
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
        crate::oar::runtime_spec(ID).expect("claude runtime spec").capabilities
    }

    fn installation(&self) -> BoxFuture<'_, Installation> {
        Box::pin(async { probe_installation_with(ID, Some(&LOGIN)).await })
    }

    fn account_usage(&self) -> BoxFuture<'_, Result<AccountUsage>> {
        Box::pin(async {
            let binary = require_binary(ID)?;
            let help = crate::oar::process::run_capture(&binary, &["--help"], std::time::Duration::from_secs(10))
                .await
                .unwrap_or_default();
            if !help.contains("--safe-mode") {
                // Never query without isolation from the user's hooks and MCP servers.
                return Ok(AccountUsage::Unsupported {
                    reason: "unsupported_installation".into(),
                });
            }
            read_account_usage(&binary).await
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>>> {
        Box::pin(async {
            let binary = require_binary(ID)?;
            let opts = SessionOptions {
                cwd: std::env::temp_dir(),
                ..Default::default()
            };
            let started = start(&binary, &uuid::Uuid::new_v4().to_string(), &opts, None).await?;
            if let Some(child) = started.shared.child.get() {
                child.kill().await;
            }
            Ok(models_of(&started.init))
        })
    }

    /// Every `SessionOptions` field maps to a claude flag, so nothing is
    /// refused here beyond an unusable `cwd`. A `resume` id claude does not
    /// know fails the open (`Rejected("session_not_found: ...")`).
    fn open(&self, mut opts: SessionOptions) -> BoxFuture<'_, Result<Arc<dyn Session>>> {
        Box::pin(async move {
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
            let started = start(&binary, &session_id, &opts, recorder).await?;
            Ok(running(started, &opts, self.capabilities()))
        })
    }
}

pub(super) async fn open_sdk(binary: &Path, opts: &SessionOptions, caps: Capabilities, launch: StreamLaunch) -> Result<Arc<dyn Session>> {
    let id = opts.resume.clone().unwrap_or_else(|| format!("{}-pending", launch.runtime));
    let file = record::open_file(opts.record_to.as_deref())?;
    let recorder = Recorder::start(file, launch.runtime, &id, &opts.cwd, opts.model.as_deref());
    let started = start_stream(binary, &id, opts, recorder, launch).await?;
    Ok(running(started, opts, caps))
}

fn running(started: Started, opts: &SessionOptions, caps: Capabilities) -> Arc<dyn Session> {
    let shared = started.shared;
    shared.core.emit_root(EventKind::SessionStarted {
        session_id: shared.core.session_id(),
        model: resolved_model(&started.init, opts.model.as_deref()),
    });
    shared.opened.store(true, Ordering::SeqCst);
    if let Some(message) = shared.exit.lock().clone() {
        shared.watchdog.finish_on_exit(&shared.core, message);
    }
    let core = shared.core.clone();
    CoreSession::new(core, ClaudeDriver { shared }, caps)
}

#[derive(Default, Deserialize)]
struct WireUsageReply {
    #[serde(default)]
    rate_limits_available: Option<bool>,
    #[serde(default)]
    subscription_type: Option<String>,
    #[serde(default)]
    rate_limits: Option<WireRateLimits>,
}

#[derive(Deserialize)]
struct WireRateLimits {
    #[serde(default)]
    five_hour: Option<WireRateWindow>,
    #[serde(default)]
    seven_day: Option<WireRateWindow>,
    #[serde(default)]
    seven_day_oauth_apps: Option<WireRateWindow>,
    #[serde(default)]
    seven_day_opus: Option<WireRateWindow>,
    #[serde(default)]
    seven_day_sonnet: Option<WireRateWindow>,
    #[serde(default)]
    extra_usage: Option<WireExtraUsage>,
}

#[derive(Deserialize)]
struct WireRateWindow {
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    resets_at: Option<String>,
}

#[derive(Deserialize)]
struct WireExtraUsage {
    #[serde(default)]
    is_enabled: Option<bool>,
    #[serde(default)]
    utilization: Option<f64>,
}

#[derive(Deserialize)]
struct WireControlEnvelope {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    response: Option<WireControlResponse>,
}

/// `get_usage`'s answer as oar projects it (`claudeAccountUsage`).
#[cfg(test)]
pub(crate) fn usage_of(reply: &Value, email: Option<String>) -> Option<AccountUsage> {
    let parsed = WireUsageReply::deserialize(reply).ok()?;
    usage_from_reply(parsed, email)
}

fn usage_from_reply(parsed: WireUsageReply, email: Option<String>) -> Option<AccountUsage> {
    const HOUR_MS: u64 = 3_600_000;
    const WEEK_MS: u64 = 7 * 24 * HOUR_MS;
    let limits = parsed.rate_limits?;
    let mut windows = Vec::new();
    let mut add = |label: &str, key: &str, entry: Option<WireRateWindow>, duration_ms: Option<u64>| {
        let entry = entry?;
        let percent = entry.utilization?;
        if !(0.0..=100.0).contains(&percent) {
            return None;
        }
        windows.push(UsageWindow {
            label: label.into(),
            used_ratio: (percent / 100.0 * 1e6).round() / 1e6,
            resets_at: entry.resets_at,
            id: Some(key.into()),
            duration_ms,
        });
        Some(())
    };
    add("Current session", "five_hour", limits.five_hour, Some(5 * HOUR_MS));
    add("Current week (all models)", "seven_day", limits.seven_day, Some(WEEK_MS));
    add("Current week (OAuth apps)", "seven_day_oauth_apps", limits.seven_day_oauth_apps, Some(WEEK_MS));
    add("Current week (Opus)", "seven_day_opus", limits.seven_day_opus, Some(WEEK_MS));
    add("Current week (Sonnet)", "seven_day_sonnet", limits.seven_day_sonnet, Some(WEEK_MS));
    let included_exhausted = windows.iter().any(|w| w.used_ratio >= 1.0);
    let mut extra_open = false;
    if let Some(extra) = limits.extra_usage
        && extra.is_enabled == Some(true)
        && let Some(percent) = extra.utilization
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
    let plan = parsed.subscription_type.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
    Some(AccountUsage::Available {
        plan,
        email,
        rate_limited: included_exhausted && !extra_open,
        windows,
    })
}

/// A separate `claude -p --safe-mode` (no hooks, no MCP servers, no prompt)
/// asked `initialize` and `get_usage`, as oar does.
pub(crate) async fn read_account_usage(binary: &Path) -> Result<AccountUsage> {
    let (tx, mut rx) = mpsc::channel::<WireControlResponse>(64);
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
            let tx = tx.clone();
            async move {
                if let Ok(env) = serde_json::from_str::<WireControlEnvelope>(&line)
                    && env.kind.as_deref() == Some("control_response")
                    && let Some(resp) = env.response
                {
                    let _ = tx.send(resp).await;
                }
            }
        },
        |_, _| async {},
    )?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    async fn ask(
        child: &Arc<LineChild>,
        rx: &mut mpsc::Receiver<WireControlResponse>,
        deadline: tokio::time::Instant,
        id: &str,
        subtype: &'static str,
    ) -> Result<WireControlResponse> {
        child
            .write_json(&json!({ "type": "control_request", "request_id": id, "request": { "subtype": subtype } }))
            .await?;
        loop {
            let reply = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .map_err(|_| AgentError::Io("claude did not answer the usage query in time".into()))?
                .ok_or_else(|| AgentError::Io("claude did not answer the usage query in time".into()))?;
            if reply.request_id.as_deref() == Some(id) {
                return Ok(reply);
            }
        }
    }
    let result = async {
        let init = ask(&child, &mut rx, deadline, "usage-init", "initialize").await?;
        let email = init
            .response
            .as_ref()
            .and_then(|v| WireInitResponse::deserialize(v).ok())
            .and_then(|r| match r.account {
                Some(WireInitAccount::Object { email }) => email,
                _ => None,
            });
        let reply = ask(&child, &mut rx, deadline, "usage-read", "get_usage").await?;
        if reply.subtype.as_deref() != Some("success") {
            let detail = reply.error.as_deref().unwrap_or("malformed control response").to_lowercase();
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
        let response = reply.response.unwrap_or(Value::Null);
        let parsed = WireUsageReply::deserialize(&response).unwrap_or_default();
        if parsed.rate_limits_available == Some(false) {
            return Ok(AccountUsage::Unsupported {
                reason: "quota_unavailable".into(),
            });
        }
        usage_from_reply(parsed, email).ok_or_else(|| AgentError::Protocol("claude get_usage returned no usable windows".into()))
    }
    .await;
    child.kill().await;
    result
}
