//! Any agent that speaks the Agent Client Protocol (ACP v1) on stdio.
//!
//! The connection is the `agent-client-protocol` crate's `Client.v1()` over a
//! line transport bound to a child process we start ourselves (so cwd, env
//! and termination stay ours). It runs on one private thread per session
//! with `futures::executor`; no async runtime is required of the caller.
//!
//! How `SessionOptions` map onto ACP:
//! - `resume`: `session/resume` when the agent advertises it, else
//!   `session/load` (its history replay is not re-emitted), else refused.
//! - `model`: the session's `model` config option (`session/set_config_option`)
//!   or the older `models` list (`session/set_model`); refused when the agent
//!   offers neither or does not list the model.
//! - `append_system_prompt`: only with `sessionCapabilities.systemPrompt`;
//!   refused otherwise.
//! - `permission_mode`: ACP agents ask through `session/request_permission`
//!   when their own policy says so. `Ask` leaves the agent in its default
//!   mode. `Plan` needs a plan mode on the agent and is refused without one.
//!   `AcceptEdits` and `Bypass` switch the agent's matching mode when it has
//!   one and, either way, are enforced on our side: `Bypass` answers every
//!   request with its allow option, `AcceptEdits` those of kind `edit`,
//!   `delete` and `move`.
//!
//! Not available over ACP: `steer` (refused; use `queue`), a denial's
//! message, token usage, and the agent's own login flow (an agent that
//! answers "auth required" fails the open with `NotAvailable`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    CancelNotification, Implementation, InitializeRequest, LoadSessionRequest, NewSessionRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, ResumeSessionRequest, SelectedPermissionOutcome, SetSessionConfigOptionRequest, SetSessionModeRequest, SystemPrompt,
};
use agent_client_protocol::v1::{ConnectionTo, Responder};
use agent_client_protocol::{Agent, Client, Lines, UntypedMessage};
use base64::Engine;
use serde_json::{Value, json};

use crate::core::{CoreSession, Driver, SessionCore, absolute, check_cwd, file_as_text, lock, rejected, rejection};
use crate::process::{LineChild, Spawn, find_binary, run_capture};
use crate::record::{self, Recorder};
use crate::{
    AgentError, Capabilities, ContentBlock, EventKind, FileChangeKind, Installation, ModelInfo, PermissionDecision, PermissionMode, Result, Runtime, Session,
    SessionOptions, StopReason, Usage,
};

const OPEN_TIMEOUT: Duration = Duration::from_secs(120);
const ABORT_GRACE: Duration = Duration::from_secs(10);

/// How to start one ACP agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpAgentSpec {
    /// Registry id; built-ins use `acp:<name>`.
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
}

impl AcpAgentSpec {
    pub fn new(id: impl Into<String>, display_name: impl Into<String>, command: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            id: id.into(),
            display_name: display_name.into(),
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    /// From one command line (`"my-agent --acp"`); quotes group words.
    pub fn from_command_line(id: impl Into<String>, display_name: impl Into<String>, line: &str) -> Result<Self> {
        let mut words = split_command_line(line)?.into_iter();
        let command = words.next().ok_or_else(|| AgentError::Unsupported {
            option: "command".into(),
            reason: "the ACP command line is empty".into(),
        })?;
        Ok(Self {
            id: id.into(),
            display_name: display_name.into(),
            command,
            args: words.collect(),
        })
    }
}

fn split_command_line(line: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') | (None, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                    in_word = true;
                }
            }
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            (None, c) => {
                current.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return Err(AgentError::Unsupported {
            option: "command".into(),
            reason: "unterminated quote".into(),
        });
    }
    if in_word {
        words.push(current);
    }
    Ok(words)
}

/// The built-in ACP launch profiles.
pub fn builtin_agents() -> Vec<AcpAgentSpec> {
    vec![
        AcpAgentSpec::new("acp:gemini", "Gemini CLI (ACP)", "gemini", ["--acp"]),
        AcpAgentSpec::new("grok", "Grok CLI", "grok", ["agent", "stdio"]),
        AcpAgentSpec::new("kimi", "Kimi CLI", "kimi", ["acp"]),
        AcpAgentSpec::new("codebuddy", "CodeBuddy CLI", "codebuddy", ["--acp"]),
        AcpAgentSpec::new("acp:opencode", "OpenCode (ACP)", "opencode", ["acp"]),
    ]
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(content_text).collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(_) => match str_of(value, "type") {
            // A ToolCallContent wrapping a ContentBlock.
            Some("content") => value.get("content").and_then(content_text),
            Some("diff") | Some("terminal") => None,
            _ => str_of(value, "text").map(str::to_string),
        },
        _ => None,
    }
}

struct ToolState {
    started: bool,
    finished: bool,
    name: String,
    kind: String,
    input: Value,
    /// path → whether the diff creates the file.
    diffs: Vec<(PathBuf, bool)>,
    locations: Vec<PathBuf>,
}

/// `session/update` → events, as a pure fold (tests feed it fixtures).
#[derive(Default)]
pub(crate) struct Projector {
    tools: HashMap<String, ToolState>,
}

fn is_empty_input(input: &Value) -> bool {
    match input {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

impl Projector {
    fn absorb(&mut self, update: &Value) -> Option<String> {
        let id = str_of(update, "toolCallId")?.to_string();
        let tool = self.tools.entry(id.clone()).or_insert_with(|| ToolState {
            started: false,
            finished: false,
            name: String::new(),
            kind: String::new(),
            input: Value::Null,
            diffs: Vec::new(),
            locations: Vec::new(),
        });
        // The opening title names the tool; later titles are progress text.
        if tool.name.is_empty()
            && let Some(title) = str_of(update, "title").filter(|t| !t.is_empty())
        {
            tool.name = title.to_string();
        }
        if let Some(kind) = str_of(update, "kind") {
            tool.kind = kind.to_string();
        }
        if let Some(input) = update.get("rawInput").filter(|input| !is_empty_input(input)) {
            tool.input = input.clone();
        }
        for item in update.get("content").and_then(Value::as_array).into_iter().flatten() {
            if str_of(item, "type") == Some("diff")
                && let Some(path) = str_of(item, "path")
            {
                let created = item.get("oldText").is_none_or(Value::is_null);
                let path = PathBuf::from(path);
                if !tool.diffs.iter().any(|(known, _)| known == &path) {
                    tool.diffs.push((path, created));
                }
            }
        }
        for location in update.get("locations").and_then(Value::as_array).into_iter().flatten() {
            if let Some(path) = str_of(location, "path") {
                let path = PathBuf::from(path);
                if !tool.locations.contains(&path) {
                    tool.locations.push(path);
                }
            }
        }
        Some(id)
    }

    fn start(&mut self, id: &str, out: &mut Vec<EventKind>) {
        let Some(tool) = self.tools.get_mut(id) else { return };
        if tool.started {
            return;
        }
        tool.started = true;
        let name = if !tool.name.is_empty() {
            tool.name.clone()
        } else if !tool.kind.is_empty() {
            tool.kind.clone()
        } else {
            "tool".to_string()
        };
        out.push(EventKind::ToolCallStarted {
            id: id.to_string(),
            name,
            input: tool.input.clone(),
        });
    }

    /// Makes sure a tool call the agent asks permission for has been announced.
    pub(crate) fn permission_tool(&mut self, tool_call: &Value) -> Vec<EventKind> {
        let mut out = Vec::new();
        if let Some(id) = self.absorb(tool_call) {
            self.start(&id, &mut out);
        }
        out
    }

    pub(crate) fn update(&mut self, update: &Value) -> Vec<EventKind> {
        let mut out = Vec::new();
        let text = || update.get("content").and_then(content_text).filter(|t| !t.is_empty());
        match str_of(update, "sessionUpdate").unwrap_or_default() {
            "agent_message_chunk" => {
                if let Some(text) = text() {
                    out.push(EventKind::TextDelta { text });
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = text() {
                    out.push(EventKind::ThinkingDelta { text });
                }
            }
            kind @ ("tool_call" | "tool_call_update") => {
                let Some(id) = self.absorb(update) else { return out };
                let status = str_of(update, "status").unwrap_or_default();
                let terminal = matches!(status, "completed" | "failed" | "cancelled");
                // Agents often open a call before its arguments exist
                // (opencode: `rawInput: {}`); the start waits one update for them.
                let hold = kind == "tool_call" && !terminal && status != "in_progress" && self.tools.get(&id).is_some_and(|t| is_empty_input(&t.input));
                if !hold {
                    self.start(&id, &mut out);
                }
                let Some(tool) = self.tools.get_mut(&id) else { return out };
                if terminal && !tool.finished {
                    tool.finished = true;
                    let ok = status == "completed";
                    let output = update
                        .get("content")
                        .and_then(content_text)
                        .or_else(|| match update.get("rawOutput") {
                            Some(Value::String(text)) => Some(text.clone()),
                            Some(Value::Null) | None => None,
                            Some(raw) => str_of(raw, "output").map(str::to_string).or_else(|| Some(raw.to_string())),
                        })
                        .unwrap_or_else(|| status.to_string());
                    out.push(EventKind::ToolCallFinished { id: id.clone(), ok, output });
                    if ok {
                        if !tool.diffs.is_empty() {
                            for (path, created) in &tool.diffs {
                                let change = if *created { FileChangeKind::Created } else { FileChangeKind::Modified };
                                out.push(EventKind::FileChanged { path: path.clone(), change });
                            }
                        } else if matches!(tool.kind.as_str(), "edit" | "delete") {
                            let change = if tool.kind == "delete" {
                                FileChangeKind::Deleted
                            } else {
                                FileChangeKind::Modified
                            };
                            for path in &tool.locations {
                                out.push(EventKind::FileChanged {
                                    path: path.clone(),
                                    change: change.clone(),
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        out
    }
}

/// The agent's permission options, reduced to what a decision needs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OptionSet {
    options: Vec<(String, String)>,
}

impl OptionSet {
    pub(crate) fn from_json(options: &Value) -> Self {
        Self {
            options: options
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| Some((str_of(o, "kind")?.to_string(), str_of(o, "optionId")?.to_string())))
                .collect(),
        }
    }

    fn of_kind(&self, kind: &str) -> Option<String> {
        self.options.iter().find(|(k, _)| k == kind).map(|(_, id)| id.clone())
    }

    /// The option id for a decision; `Ok(None)` answers "cancelled".
    pub(crate) fn pick(&self, decision: &PermissionDecision) -> Result<Option<String>> {
        match decision {
            PermissionDecision::AllowOnce => {
                self.of_kind("allow_once")
                    .or_else(|| self.of_kind("allow_always"))
                    .map(Some)
                    .ok_or_else(|| AgentError::Unsupported {
                        option: "AllowOnce".into(),
                        reason: "the agent offered no allow option for this request".into(),
                    })
            }
            PermissionDecision::AllowAlways => self.of_kind("allow_always").map(Some).ok_or_else(|| AgentError::Unsupported {
                option: "AllowAlways".into(),
                reason: "the agent offered no allow-always option for this request; answer AllowOnce".into(),
            }),
            PermissionDecision::Deny { .. } => Ok(self.of_kind("reject_once").or_else(|| self.of_kind("reject_always"))),
        }
    }
}

fn normalize(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

/// Mode ids that mean the same as a `PermissionMode`, across agents
/// (gemini: `autoEdit`, `yolo`, `plan`; opencode: `plan`; claude-style ids).
pub(crate) fn matching_mode(mode: PermissionMode, available: &[String]) -> Option<&String> {
    let wanted: &[&str] = match mode {
        PermissionMode::Ask => return None,
        PermissionMode::AcceptEdits => &["acceptedits", "autoedit", "autoaccept", "autoacceptedits"],
        PermissionMode::Bypass => &["bypasspermissions", "bypass", "yolo", "fullaccess", "dontask"],
        PermissionMode::Plan => &["plan", "planmode", "readonly"],
    };
    available.iter().find(|id| wanted.contains(&normalize(id).as_str()))
}

fn config_option<'a>(session: &'a Value, category: &str) -> Option<&'a Value> {
    session
        .get("configOptions")
        .and_then(Value::as_array)?
        .iter()
        .find(|o| str_of(o, "category") == Some(category) || str_of(o, "id") == Some(category))
}

fn select_values(option: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in option.get("options").and_then(Value::as_array).into_iter().flatten() {
        // Either a flat option or a group of them.
        let nested = entry.get("options").and_then(Value::as_array);
        for item in nested.map(|n| n.iter().collect::<Vec<_>>()).unwrap_or_else(|| vec![entry]) {
            if let Some(value) = str_of(item, "value") {
                out.push((value.to_string(), str_of(item, "name").unwrap_or(value).to_string()));
            }
        }
    }
    out
}

pub(crate) fn models_of(session: &Value) -> Vec<ModelInfo> {
    if let Some(option) = config_option(session, "model") {
        return select_values(option)
            .into_iter()
            .map(|(id, display_name)| ModelInfo::new(id, display_name))
            .collect();
    }
    session
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = str_of(m, "modelId")?.to_string();
            Some(ModelInfo::new(id.clone(), str_of(m, "name").unwrap_or(&id)))
        })
        .collect()
}

fn current_model(session: &Value) -> Option<String> {
    config_option(session, "model")
        .and_then(|o| str_of(o, "currentValue"))
        .or_else(|| session.pointer("/models/currentModelId").and_then(Value::as_str))
        .map(str::to_string)
}

struct PendingPermission {
    responder: Responder<RequestPermissionResponse>,
    options: OptionSet,
}

enum Command {
    Steer(Vec<Value>),
    Prompt(Vec<Value>),
    Cancel,
    Shutdown,
}

struct Opened {
    session_id: String,
    model: Option<String>,
    image_input: bool,
    /// The agent's `session/new` answer, for `list_models`.
    session: Value,
}

struct Shared {
    runtime_id: String,
    child: OnceLock<Arc<LineChild>>,
    core: OnceLock<Arc<SessionCore>>,
    acp_session: OnceLock<String>,
    projector: Mutex<Projector>,
    pending: Mutex<HashMap<String, PendingPermission>>,
    next_permission: AtomicU64,
    permission_mode: PermissionMode,
    /// `session/load` replays the old conversation; that is not new output.
    replaying: AtomicBool,
    abort_wanted: AtomicBool,
    abort_killed: AtomicBool,
    turns_finished: AtomicU64,
    image_input: AtomicBool,
    children: Mutex<HashMap<String, Vec<String>>>,
    updates: Mutex<std::collections::VecDeque<String>>,
    commands: flume::Sender<Command>,
    cwd: PathBuf,
}

impl Shared {
    fn agent_path(&self, params: &Value) -> Vec<String> {
        let root = self.acp_session.get().map(String::as_str).unwrap_or_default();
        let meta = params
            .pointer("/_meta/opencode~1child-session")
            .or_else(|| params.pointer("/update/_meta/opencode~1child-session"));
        let mut id = str_of(params, "sessionId").unwrap_or(root);
        let mut paths = lock(&self.children);
        if let Some(meta) = meta
            && let Some(child) = meta
                .as_str()
                .or_else(|| ["childSessionId", "sessionId", "id"].into_iter().find_map(|k| str_of(meta, k)))
            && child != root
        {
            let parent = str_of(meta, "parentSessionId").or_else(|| str_of(meta, "parentId")).unwrap_or(id);
            let mut parent_path = paths
                .get(parent)
                .cloned()
                .unwrap_or_else(|| if parent == root { vec![] } else { vec![parent.to_owned()] });
            parent_path.push(child.to_string());
            if !paths.contains_key(child) {
                if let Some(core) = self.core.get() {
                    core.child_session(parent, child, &parent_path);
                }
                paths.insert(child.to_owned(), parent_path);
            }
            id = child;
        }
        paths.get(id).cloned().unwrap_or_else(|| if id != root { vec![id.into()] } else { vec![] })
    }

    fn on_update(&self, params: &Value) {
        let line = lock(&self.updates)
            .pop_front()
            .unwrap_or_else(|| json!({"jsonrpc":"2.0","method":"session/update","params":params}).to_string());
        if self.replaying.load(Ordering::SeqCst) {
            return;
        }
        let Some(core) = self.core.get() else { return };
        let Some(update) = params.get("update") else { return };
        let path = self.agent_path(params);
        let frame_type = format!("session/update/{}", str_of(update, "sessionUpdate").unwrap_or_default());
        let _frame = core.record_raw(&frame_type, path.clone(), &line, params);
        let events = lock(&self.projector).update(update);
        for kind in events {
            core.emit(path.clone(), kind);
        }
    }

    fn auto_allow(&self, tool_kind: Option<&str>) -> bool {
        match self.permission_mode {
            PermissionMode::Bypass => true,
            PermissionMode::AcceptEdits => matches!(tool_kind, Some("edit" | "delete" | "move")),
            PermissionMode::Ask | PermissionMode::Plan => false,
        }
    }

    fn on_permission(&self, request: &Value, responder: Responder<RequestPermissionResponse>) {
        let cancelled = || RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        let Some(core) = self.core.get() else {
            let _ = responder.respond(cancelled());
            return;
        };
        let tool_call = request.get("toolCall").cloned().unwrap_or(Value::Null);
        let options = OptionSet::from_json(request.get("options").unwrap_or(&Value::Null));
        let path = self.agent_path(request);
        for kind in lock(&self.projector).permission_tool(&tool_call) {
            core.emit(path.clone(), kind);
        }
        if self.auto_allow(str_of(&tool_call, "kind"))
            && let Ok(Some(option)) = options.pick(&PermissionDecision::AllowOnce)
        {
            let _ = responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(option),
            )));
            return;
        }
        let request_id = format!("perm-{}", self.next_permission.fetch_add(1, Ordering::SeqCst));
        let title = str_of(&tool_call, "title").unwrap_or("tool").to_string();
        let input = match tool_call.get("rawInput") {
            Some(input) if !is_empty_input(input) => input.clone(),
            _ => tool_call.clone(),
        };
        lock(&self.pending).insert(request_id.clone(), PendingPermission { responder, options });
        core.emit(
            path,
            EventKind::PermissionRequested {
                request_id,
                tool: str_of(&tool_call, "kind").unwrap_or("tool").to_string(),
                input,
                summary: title,
            },
        );
    }

    /// ACP requires every open permission request to be answered `cancelled`
    /// once the turn is cancelled.
    fn cancel_pending(&self) {
        let pending: Vec<(String, PendingPermission)> = lock(&self.pending).drain().collect();
        for (request_id, pending) in pending {
            let _ = pending.responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
            if let Some(core) = self.core.get() {
                core.emit_root(EventKind::PermissionResolved {
                    request_id,
                    decision: PermissionDecision::Deny {
                        message: Some("cancelled".into()),
                    },
                });
            }
        }
    }

    fn turn_finished(&self, reason: StopReason, error: Option<String>) {
        self.cancel_pending();
        self.abort_wanted.store(false, Ordering::SeqCst);
        self.turns_finished.fetch_add(1, Ordering::SeqCst);
        let Some(core) = self.core.get() else { return };
        if let Some(message) = error {
            core.emit_root(EventKind::Error { message });
        }
        core.emit_root(EventKind::TurnFinished {
            reason,
            usage: Usage::default(),
        });
    }
}

fn acp_error(context: &str, error: &agent_client_protocol::Error) -> String {
    let code = serde_json::to_value(error.code).ok().and_then(|c| c.as_i64()).unwrap_or(0);
    match &error.data {
        Some(data) if !data.is_null() => format!("{context}: {} ({code}): {data}", error.message),
        _ => format!("{context}: {} ({code})", error.message),
    }
}

fn is_auth_required(error: &agent_client_protocol::Error) -> bool {
    serde_json::to_value(error.code).ok().and_then(|c| c.as_i64()) == Some(-32000)
}

fn unsupported(option: &str, reason: impl Into<String>) -> AgentError {
    AgentError::Unsupported {
        option: option.into(),
        reason: reason.into(),
    }
}

fn typed<T: serde::de::DeserializeOwned>(value: Value) -> std::result::Result<T, agent_client_protocol::Error> {
    serde_json::from_value(value).map_err(|e| agent_client_protocol::Error::internal_error().data(e.to_string()))
}

/// Initialize, open the session and apply the options; everything that can
/// refuse an option happens here, before `open` returns a session.
async fn handshake(cx: &ConnectionTo<Agent>, shared: &Shared, opts: &SessionOptions) -> Result<Opened> {
    let name = &shared.runtime_id;
    let init = cx
        .send_request(InitializeRequest::new(ProtocolVersion::V1).client_info(Implementation::new("vibevalley", env!("CARGO_PKG_VERSION")).title("VibeValley")))
        .block_task()
        .await
        .map_err(|e| AgentError::Protocol(acp_error("initialize", &e)))?;
    let init = serde_json::to_value(&init).unwrap_or(Value::Null);
    let capabilities = init.get("agentCapabilities").cloned().unwrap_or(Value::Null);
    let session_capability = |key: &str| capabilities.pointer(&format!("/sessionCapabilities/{key}")).is_some_and(|v| !v.is_null());
    let image_input = capabilities.pointer("/promptCapabilities/image").and_then(Value::as_bool) == Some(true);

    // A replacing prompt overrides the agent's own, with the appended part after it.
    let (mode, text) = match (&opts.system_prompt, &opts.append_system_prompt) {
        (None, None) => ("append", None),
        (None, Some(extra)) => ("append", Some(extra.clone())),
        (Some(own), None) => ("override", Some(own.clone())),
        (Some(own), Some(extra)) => ("override", Some(format!("{own}\n\n{extra}"))),
    };
    let system_prompt = match text {
        None => None,
        Some(_) if matches!(name.as_str(), "grok" | "acp:opencode" | "opencode") && !session_capability("systemPrompt") => None,
        Some(_) if !session_capability("systemPrompt") => {
            let option = if opts.system_prompt.is_some() {
                "system_prompt"
            } else {
                "append_system_prompt"
            };
            return Err(unsupported(option, format!("{name} does not accept a system prompt over ACP")));
        }
        Some(text) => Some(
            typed::<SystemPrompt>(json!({ "mode": mode, "content": [{ "type": "text", "text": text }] }))
                .map_err(|e| AgentError::Protocol(acp_error("system prompt", &e)))?,
        ),
    };
    let mcp_servers: Vec<agent_client_protocol::v1::schema::McpServer> = typed(json!(
        opts.mcp_servers
            .iter()
            .map(|server| match server {
                crate::McpServer::Stdio { name, command, args, env, .. } => json!({
                    "name": name, "command": command, "args": args,
                    "env": env.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>(),
                }),
                crate::McpServer::Http { name, url, headers } => json!({
                    "type": "http", "name": name, "url": url,
                    "headers": headers.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>(),
                }),
            })
            .collect::<Vec<_>>()
    ))
    .map_err(|e| AgentError::Protocol(acp_error("mcp servers", &e)))?;

    let open_error = |context: &str, error: agent_client_protocol::Error| {
        if is_auth_required(&error) {
            let methods: Vec<&str> = init
                .get("authMethods")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|m| str_of(m, "name"))
                .collect();
            AgentError::NotAvailable(format!(
                "{name} needs a login before it can open a session: {} (its methods: {}). Log in with the agent's own CLI first.",
                error.message,
                methods.join(", ")
            ))
        } else if opts.resume.is_some() {
            AgentError::Rejected(format!("session_not_found: {}", acp_error(context, &error)))
        } else {
            AgentError::Protocol(acp_error(context, &error))
        }
    };

    let mut meta = serde_json::Map::new();
    if system_prompt.is_none() {
        if let Some(text) = &opts.system_prompt {
            meta.insert("systemPrompt".into(), json!(text));
        }
        if let Some(text) = &opts.append_system_prompt {
            meta.insert("appendSystemPrompt".into(), json!(text));
        }
    }
    let (session_id, session) = match &opts.resume {
        None => {
            let mut request = NewSessionRequest::new(&opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let reply = cx.send_request(request).block_task().await.map_err(|e| open_error("session/new", e))?;
            (reply.session_id.to_string(), serde_json::to_value(&reply).unwrap_or(Value::Null))
        }
        Some(id) if session_capability("resume") => {
            let mut request = ResumeSessionRequest::new(id.clone(), &opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let reply = cx.send_request(request).block_task().await.map_err(|e| open_error("session/resume", e))?;
            (id.clone(), serde_json::to_value(&reply).unwrap_or(Value::Null))
        }
        Some(id) if capabilities.get("loadSession").and_then(Value::as_bool) == Some(true) || session_capability("load") => {
            let mut request = LoadSessionRequest::new(id.clone(), &opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            shared.replaying.store(true, Ordering::SeqCst);
            let reply = cx.send_request(request).block_task().await;
            shared.replaying.store(false, Ordering::SeqCst);
            let reply = reply.map_err(|e| open_error("session/load", e))?;
            (id.clone(), serde_json::to_value(&reply).unwrap_or(Value::Null))
        }
        Some(_) => return Err(unsupported("resume", format!("{name} can neither resume nor load a session"))),
    };

    let mut model = current_model(&session);
    if let Some(wanted) = &opts.model {
        let listed = models_of(&session);
        if !listed.is_empty() && !listed.iter().any(|m| &m.id == wanted) {
            let reason = if listed.is_empty() {
                format!("{name} offers no model selection over ACP")
            } else {
                format!("{name} does not list model `{wanted}` (see list_models)")
            };
            return Err(unsupported("model", reason));
        }
        let outcome = match config_option(&session, "model").and_then(|o| str_of(o, "id")) {
            Some(config_id) => cx
                .send_request(SetSessionConfigOptionRequest::new(session_id.clone(), config_id.to_string(), wanted.as_str()))
                .block_task()
                .await
                .map(|_| ()),
            None => match UntypedMessage::new("session/set_model", json!({ "sessionId": session_id, "modelId": wanted })) {
                Ok(message) => cx.send_request(message).block_task().await.map(|_| ()),
                Err(error) => Err(error),
            },
        };
        outcome.map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
        model = Some(wanted.clone());
    }

    if let Some(effort) = &opts.effort {
        let id = config_option(&session, "thought_level")
            .and_then(|o| str_of(o, "id"))
            .unwrap_or("reasoning_effort");
        cx.send_request(SetSessionConfigOptionRequest::new(session_id.clone(), id.to_string(), effort.as_str()))
            .block_task()
            .await
            .map_err(|e| unsupported("effort", acp_error("the agent refused the reasoning effort", &e)))?;
    }

    let modes: Vec<String> = session
        .pointer("/modes/availableModes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| str_of(m, "id").map(str::to_string))
        .collect();
    let mode_option = config_option(&session, "mode");
    let option_modes: Vec<String> = mode_option.map(select_values).unwrap_or_default().into_iter().map(|(id, _)| id).collect();
    if opts.permission_mode != PermissionMode::Ask {
        let set = if let Some(mode) = matching_mode(opts.permission_mode, &modes) {
            Some(
                cx.send_request(SetSessionModeRequest::new(session_id.clone(), mode.clone()))
                    .block_task()
                    .await
                    .map(|_| ()),
            )
        } else if let (Some(mode), Some(config_id)) = (matching_mode(opts.permission_mode, &option_modes), mode_option.and_then(|o| str_of(o, "id"))) {
            Some(
                cx.send_request(SetSessionConfigOptionRequest::new(session_id.clone(), config_id.to_string(), mode.as_str()))
                    .block_task()
                    .await
                    .map(|_| ()),
            )
        } else {
            None
        };
        match (set, opts.permission_mode) {
            (Some(Ok(())), _) => {}
            (Some(Err(error)), _) => {
                return Err(unsupported("permission_mode", acp_error("the agent refused the mode", &error)));
            }
            // Enforced by answering its permission requests ourselves.
            (None, PermissionMode::AcceptEdits | PermissionMode::Bypass) => {}
            (None, _) => {
                let known: Vec<&String> = modes.iter().chain(option_modes.iter()).collect();
                return Err(unsupported("permission_mode", format!("{name} has no plan mode (its modes: {known:?})")));
            }
        }
    }
    Ok(Opened {
        session_id,
        model,
        image_input,
        session,
    })
}

fn stop_reason(reply: &Value) -> (StopReason, Option<String>) {
    match str_of(reply, "stopReason") {
        Some("end_turn") => (StopReason::Completed, None),
        Some("cancelled") => (StopReason::Aborted, None),
        Some("max_turn_requests") => (StopReason::MaxTurns, None),
        Some("max_tokens") => (StopReason::Error, Some("the model ran out of output tokens".into())),
        Some("refusal") => (StopReason::Error, Some("the model refused to continue".into())),
        other => (StopReason::Error, Some(format!("unknown stop reason {other:?}"))),
    }
}

async fn serve(
    cx: ConnectionTo<Agent>,
    shared: Arc<Shared>,
    opts: SessionOptions,
    commands: flume::Receiver<Command>,
    ready: flume::Sender<Result<Opened>>,
) -> std::result::Result<(), agent_client_protocol::Error> {
    let opened = match handshake(&cx, &shared, &opts).await {
        Ok(opened) => opened,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Ok(());
        }
    };
    let session_id = opened.session_id.clone();
    let _ = shared.acp_session.set(session_id.clone());
    shared.image_input.store(opened.image_input, Ordering::SeqCst);
    if ready.send(Ok(opened)).is_err() {
        return Ok(());
    }
    while let Ok(command) = commands.recv_async().await {
        match command {
            Command::Prompt(blocks) => {
                let request = UntypedMessage::new("session/prompt", json!({ "sessionId": session_id, "prompt": blocks }))?;
                let shared = shared.clone();
                // Ordered: the answer is handled after every update that preceded it.
                cx.send_request(request).on_receiving_result(move |result| async move {
                    match result {
                        Ok(reply) => {
                            let _frame = shared
                                .core
                                .get()
                                .map(|core| core.record_raw("session/prompt/result", vec![], &reply.to_string(), &reply));
                            let (reason, error) = stop_reason(&reply);
                            shared.turn_finished(reason, error);
                        }
                        Err(error) => {
                            let reason = if shared.abort_wanted.load(Ordering::SeqCst) {
                                StopReason::Aborted
                            } else {
                                StopReason::Error
                            };
                            let message = (reason == StopReason::Error).then(|| acp_error("session/prompt", &error));
                            shared.turn_finished(reason, message);
                        }
                    }
                    Ok(())
                })?;
            }
            Command::Steer(blocks) => {
                cx.send_notification(UntypedMessage::new("session/steer", json!({"sessionId":session_id, "prompt":blocks}))?)?;
            }
            Command::Cancel => {
                shared.cancel_pending();
                cx.send_notification(CancelNotification::new(session_id.clone()))?;
            }
            Command::Shutdown => break,
        }
    }
    Ok(())
}

fn connection_thread(
    shared: Arc<Shared>,
    child: Arc<LineChild>,
    incoming: futures::channel::mpsc::UnboundedReceiver<std::io::Result<String>>,
    opts: SessionOptions,
    commands: flume::Receiver<Command>,
    ready: flume::Sender<Result<Opened>>,
) {
    let outgoing = Box::pin(futures::sink::unfold(child, |child, line: String| async move {
        child.write_line(&line).map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok::<_, std::io::Error>(child)
    }));
    let updates = shared.clone();
    let permissions = shared.clone();
    let serving = shared.clone();
    let ready_failed = ready.clone();
    let connection = Client
        .v1()
        .name("vibevalley")
        .on_receive_notification(
            async move |notification: UntypedMessage, _cx| {
                if notification.method() == "session/update" {
                    updates.on_update(notification.params());
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                permissions.on_permission(&serde_json::to_value(&request).unwrap_or(Value::Null), responder);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(Lines::new(outgoing, incoming), |cx: ConnectionTo<Agent>| {
            serve(cx, serving, opts, commands, ready)
        });
    let result = futures::executor::block_on(connection);
    let child_error = shared.child.get().map(|c| c.stderr_text()).unwrap_or_default();
    let mut message = match &result {
        Ok(()) => format!("{} closed the connection", shared.runtime_id),
        Err(error) => acp_error(&format!("{} connection failed", shared.runtime_id), error),
    };
    if !child_error.trim().is_empty() {
        message.push_str(": ");
        message.push_str(child_error.trim());
    }
    // Still waiting in `open`: the handshake never finished.
    let _ = ready_failed.send(Err(AgentError::Protocol(message.clone())));
    if let Some(child) = shared.child.get() {
        child.kill();
    }
    if let Some(core) = shared.core.get() {
        if shared.abort_killed.load(Ordering::SeqCst) && core.turn_active() {
            core.emit_root(EventKind::TurnFinished {
                reason: StopReason::Aborted,
                usage: Usage::default(),
            });
            core.finish(None);
        } else {
            core.finish(Some(message));
        }
    }
}

fn prompt_blocks(cwd: &Path, image_input: bool, content: &[ContentBlock]) -> Result<Vec<Value>> {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text(text) => Ok(json!({ "type": "text", "text": text })),
            ContentBlock::File { path, lines: None } => {
                let full = absolute(cwd, path);
                let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                Ok(json!({ "type": "resource_link", "name": name, "uri": format!("file://{}", full.display()) }))
            }
            ContentBlock::File { path, lines } => Ok(json!({ "type": "text", "text": file_as_text(cwd, path, *lines)? })),
            ContentBlock::Image { path } => {
                let full = absolute(cwd, path);
                if !image_input {
                    return Err(rejected(rejection::UNSUPPORTED, "this agent does not take image input"));
                }
                let mime = match full.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
                    Some("png") => "image/png",
                    Some("jpg" | "jpeg") => "image/jpeg",
                    Some("gif") => "image/gif",
                    Some("webp") => "image/webp",
                    _ => return Err(rejected(rejection::UNSUPPORTED, format!("{}: unknown image type", full.display()))),
                };
                let bytes = std::fs::read(&full).map_err(|e| rejected(rejection::UNSUPPORTED, format!("cannot read {}: {e}", full.display())))?;
                Ok(json!({
                    "type": "image",
                    "mimeType": mime,
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }))
            }
        })
        .collect()
}

struct AcpDriver {
    shared: Arc<Shared>,
}

impl AcpDriver {
    fn blocks(&self, content: &[ContentBlock]) -> Result<Vec<Value>> {
        prompt_blocks(&self.shared.cwd, self.shared.image_input.load(Ordering::SeqCst), content)
    }

    fn send(&self, command: Command) -> Result<()> {
        self.shared
            .commands
            .send(command)
            .map_err(|_| AgentError::Io("the ACP connection is closed".into()))
    }
}

impl Driver for AcpDriver {
    fn check_content(&self, content: &[ContentBlock]) -> Result<()> {
        self.blocks(content).map(|_| ())
    }

    fn start_turn(&self, content: Vec<ContentBlock>) -> Result<()> {
        self.send(Command::Prompt(self.blocks(&content)?))
    }

    fn steer(&self, content: Vec<ContentBlock>) -> Result<()> {
        self.send(Command::Steer(self.blocks(&content)?))
    }

    fn abort(&self) -> Result<()> {
        self.shared.abort_wanted.store(true, Ordering::SeqCst);
        self.send(Command::Cancel)?;
        let shared = self.shared.clone();
        let turn = shared.turns_finished.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + ABORT_GRACE;
            while std::time::Instant::now() < deadline {
                let active = shared.core.get().is_some_and(|core| core.turn_active());
                if shared.turns_finished.load(Ordering::SeqCst) != turn || !active {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            shared.abort_killed.store(true, Ordering::SeqCst);
            if let Some(child) = shared.child.get() {
                child.kill();
            }
        });
        Ok(())
    }

    /// ACP answers with one of the agent's own options; a denial's message
    /// has no field to travel in and is not delivered.
    fn respond_permission(&self, request_id: &str, decision: &PermissionDecision) -> Result<()> {
        let mut pending = lock(&self.shared.pending);
        let Some(entry) = pending.get(request_id) else {
            return Err(rejected(rejection::UNKNOWN_REQUEST, format!("the agent no longer waits on `{request_id}`")));
        };
        // Refused before the request is taken, so it can be answered again.
        let outcome = match entry.options.pick(decision)? {
            Some(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option)),
            None => RequestPermissionOutcome::Cancelled,
        };
        let entry = pending.remove(request_id).expect("checked above");
        entry
            .responder
            .respond(RequestPermissionResponse::new(outcome))
            .map_err(|e| AgentError::Io(acp_error("permission answer", &e)))
    }

    fn dispose(&self) {
        let _ = self.shared.commands.send(Command::Shutdown);
        if let Some(child) = self.shared.child.get() {
            child.kill();
        }
    }
}

pub struct AcpRuntime {
    spec: AcpAgentSpec,
}

struct Connected {
    shared: Arc<Shared>,
    opened: Opened,
}

impl AcpRuntime {
    pub fn new(spec: AcpAgentSpec) -> Self {
        Self { spec }
    }

    pub fn spec(&self) -> &AcpAgentSpec {
        &self.spec
    }

    fn connect(&self, opts: &SessionOptions) -> Result<Connected> {
        let binary = opts.binary(&self.spec.command)?;
        let (commands_tx, commands_rx) = flume::unbounded();
        let shared = Arc::new(Shared {
            runtime_id: self.spec.id.clone(),
            child: OnceLock::new(),
            core: OnceLock::new(),
            acp_session: OnceLock::new(),
            projector: Mutex::new(Projector::default()),
            pending: Mutex::new(HashMap::new()),
            next_permission: AtomicU64::new(1),
            permission_mode: opts.permission_mode,
            replaying: AtomicBool::new(false),
            abort_wanted: AtomicBool::new(false),
            abort_killed: AtomicBool::new(false),
            turns_finished: AtomicU64::new(0),
            image_input: AtomicBool::new(false),
            children: Default::default(),
            updates: Default::default(),
            commands: commands_tx,
            cwd: opts.cwd.clone(),
        });
        let (incoming_tx, incoming_rx) = futures::channel::mpsc::unbounded::<std::io::Result<String>>();
        let on_line = {
            let incoming = incoming_tx.clone();
            let shared = shared.clone();
            move |line: &str| {
                if let Ok(v) = serde_json::from_str::<Value>(line)
                    && v["method"] == "session/update"
                {
                    lock(&shared.updates).push_back(line.to_string());
                }
                let _ = incoming.unbounded_send(Ok(line.to_string()));
            }
        };
        // Closing the stream is how the connection learns the agent is gone.
        let on_exit = move |_code: Option<i32>, _stderr: String| incoming_tx.close_channel();
        let child = LineChild::spawn(
            Spawn {
                label: &self.spec.id,
                binary: &binary,
                args: self.spec.args.clone(),
                cwd: &opts.cwd,
                env: &opts.env,
                options: Some(opts),
                env_remove: &[],
            },
            on_line,
            on_exit,
        )?;
        let _ = shared.child.set(child.clone());
        let (ready_tx, ready_rx) = flume::bounded(2);
        let thread = {
            let shared = shared.clone();
            let child = child.clone();
            let opts = opts.clone();
            std::thread::Builder::new()
                .name(format!("vibevalley-agent-{}", self.spec.id))
                .spawn(move || connection_thread(shared, child, incoming_rx, opts, commands_rx, ready_tx))
        };
        if let Err(error) = thread {
            child.kill();
            return Err(AgentError::Io(format!("cannot start the ACP thread: {error}")));
        }
        match ready_rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(opened)) => Ok(Connected { shared, opened }),
            Ok(Err(error)) => {
                child.kill();
                Err(error)
            }
            Err(_) => {
                child.kill();
                Err(AgentError::Protocol(format!("{} did not open a session in time", self.spec.id)))
            }
        }
    }
}

impl Runtime for AcpRuntime {
    fn id(&self) -> &str {
        &self.spec.id
    }

    fn display_name(&self) -> &str {
        &self.spec.display_name
    }

    /// What the adapter can do with an agent that offers it; the agent's own
    /// capabilities are only known after `initialize`, so `resume` and
    /// `model` can still be refused at open.
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            resume: true,
            steer: matches!(self.id(), "grok" | "acp:opencode" | "opencode"),
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: false,
            usage: false,
        }
    }

    fn installation(&self) -> Installation {
        let Some(path) = find_binary(&self.spec.command) else {
            return Installation::NotInstalled;
        };
        let version =
            run_capture(&path, &["--version"], Duration::from_secs(15)).and_then(|out| out.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string));
        Installation::Available { version, path }
    }

    /// Opens a throwaway session in the temp directory to read the agent's
    /// model list (ACP has no other way to ask).
    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let opts = SessionOptions {
            cwd: std::env::temp_dir(),
            ..Default::default()
        };
        let connected = self.connect(&opts)?;
        let _ = connected.shared.commands.send(Command::Shutdown);
        if let Some(child) = connected.shared.child.get() {
            child.kill();
        }
        Ok(models_of(&connected.opened.session))
    }

    fn open(&self, opts: SessionOptions) -> Result<Arc<dyn Session>> {
        opts.validate_for(self.id())?;
        check_cwd(&opts.cwd)?;
        if !opts.disallowed_tools.is_empty() {
            return Err(unsupported("disallowed_tools", "ACP has no per-session tool blocklist"));
        }
        if matches!(self.id(), "kimi" | "codebuddy") {
            if opts.system_prompt.is_some() {
                return Err(unsupported("system_prompt", "this agent has no system prompt option"));
            }
            if opts.append_system_prompt.is_some() {
                return Err(unsupported("append_system_prompt", "this agent has no appended system prompt option"));
            }
        }
        let file = record::open_file(opts.record_to.as_deref())?;
        let Connected { shared, opened } = self.connect(&opts)?;
        let recorder = Recorder::start(file, &self.spec.id, &opened.session_id, &opts.cwd, opened.model.as_deref());
        let core = SessionCore::new(&self.spec.id, &opened.session_id, recorder);
        if opts.resume.is_some() {
            core.resume_meter(&Value::Null, "acp_resume_baseline_unknown");
        }
        core.emit_root(EventKind::SessionStarted {
            session_id: opened.session_id.clone(),
            model: opened.model.clone(),
        });
        let _ = shared.core.set(core.clone());
        // The connection may have died between the handshake and here.
        if shared.commands.is_disconnected() {
            core.finish(Some(format!("{} closed the connection", self.spec.id)));
        }
        Ok(CoreSession::new(core, AcpDriver { shared }, self.capabilities()))
    }
}
