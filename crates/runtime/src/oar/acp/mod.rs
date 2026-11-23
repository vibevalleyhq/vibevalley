//! Any agent that speaks the Agent Client Protocol (ACP) on stdio.
//!
//! Generic ACP agents use ACP v1 via `agent-client-protocol`'s `Client.v1()`
//! over a line transport bound to a child process we manage directly.
//! `AcpFlavor::Antigravity` extends the flow for `agy >= 1.5.0` (ACP v2
//! handshake, stdout auth-URL pre-filtering, `_meta.antigravity.systemPrompt`,
//! client-side permissions with non-auto-approved `interaction_*` questions,
//! payload normalization, mid-turn `session/prompt` steering, background
//! continuation, and read-only SQLite silent-error detection).

pub(crate) mod antigravity;
pub(crate) mod antigravity_db;
pub(crate) mod antigravity_swarm;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    CancelNotification, Implementation, InitializeRequest, LoadSessionRequest, NewSessionRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, ResumeSessionRequest, SelectedPermissionOutcome, SetSessionConfigOptionRequest, SetSessionModeRequest, SystemPrompt,
};
use agent_client_protocol::{Agent, Builder, Client, ConnectionTo, Lines, Responder, UntypedMessage};
use base64::Engine;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::oar::core::{CoreSession, Driver, SessionCore, absolute, file_as_text, rejected, rejection};
use crate::oar::process::{AbortWatchdog, LineChild, Spawn, find_binary, run_capture};
use crate::oar::record::{self, Recorder};
use crate::oar::{
    AgentError, Capabilities, ChildTranscriptStep, ContentBlock, EventKind, FileChangeKind, Installation, InteractionDecision, InteractionOption, ModelInfo,
    PermissionDecision, PermissionMode, Result, Runtime, Session, SessionOptions, StopReason, SubagentSnapshot, SubagentStatus, SwarmMemberState,
    SwarmSnapshot, Usage,
};

const OPEN_TIMEOUT: Duration = Duration::from_secs(120);
const ABORT_GRACE: Duration = Duration::from_secs(10);
const CONFIG_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum AcpFlavor {
    #[default]
    Generic,
    Antigravity,
}

impl AcpFlavor {
    pub(crate) fn of(runtime_id: &str) -> Self {
        if matches!(runtime_id, "antigravity" | "acp:antigravity") {
            Self::Antigravity
        } else {
            Self::Generic
        }
    }
}

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
        AcpAgentSpec::new("antigravity", "Antigravity CLI", "agy", ["acp"]),
        AcpAgentSpec::new("grok", "Grok CLI", "grok", ["agent", "stdio"]),
        AcpAgentSpec::new("kimi", "Kimi CLI", "kimi", ["acp"]),
        AcpAgentSpec::new("codebuddy", "CodeBuddy CLI", "codebuddy", ["--acp"]),
        AcpAgentSpec::new("opencode", "OpenCode (ACP)", "opencode", ["acp"]),
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
    flavor: AcpFlavor,
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
    pub(crate) fn for_flavor(flavor: AcpFlavor) -> Self {
        Self { flavor, tools: HashMap::new() }
    }

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
            tool.input = match self.flavor {
                AcpFlavor::Generic => input.clone(),
                AcpFlavor::Antigravity => {
                    let kind = (!tool.kind.is_empty()).then_some(tool.kind.as_str());
                    antigravity::normalize_tool_input(input, kind)
                }
            };
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
        let input = match self.flavor {
            AcpFlavor::Generic => tool.input.clone(),
            AcpFlavor::Antigravity => {
                let kind = (!tool.kind.is_empty()).then_some(tool.kind.as_str());
                antigravity::normalize_tool_input(&tool.input, kind)
            }
        };
        out.push(EventKind::ToolCallStarted {
            id: id.to_string(),
            name,
            input,
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
                    let tool_kind = (!tool.kind.is_empty()).then_some(tool.kind.as_str());
                    let output = match self.flavor {
                        AcpFlavor::Generic => update
                            .get("content")
                            .and_then(content_text)
                            .or_else(|| match update.get("rawOutput") {
                                Some(Value::String(text)) => Some(text.clone()),
                                Some(Value::Null) | None => None,
                                Some(raw) => str_of(raw, "output").map(str::to_string).or_else(|| Some(raw.to_string())),
                            })
                            .unwrap_or_else(|| status.to_string()),
                        AcpFlavor::Antigravity => update
                            .get("content")
                            .and_then(content_text)
                            .map(|t| antigravity::normalize_tool_text(&t, tool_kind))
                            .or_else(|| update.get("rawOutput").and_then(|raw| antigravity::normalize_tool_output(raw, tool_kind)))
                            .unwrap_or_else(|| status.to_string()),
                    };
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

/// Mode ids that mean the same as a `PermissionMode`, across generic ACP agents.
pub(crate) fn matching_mode(mode: PermissionMode, available: &[String]) -> Option<&String> {
    let wanted: &[&str] = match mode {
        PermissionMode::Ask => return None,
        PermissionMode::AcceptEdits => &["acceptedits", "autoedit", "autoaccept", "autoacceptedits"],
        PermissionMode::Bypass => &["bypasspermissions", "bypass", "yolo", "fullaccess", "dontask"],
        PermissionMode::Plan => &["plan", "planmode", "readonly"],
    };
    available.iter().find(|id| wanted.contains(&normalize(id).as_str()))
}

fn config_option_in<'a>(options: &'a [Value], category: &str) -> Option<&'a Value> {
    options
        .iter()
        .find(|o| str_of(o, "category") == Some(category) || str_of(o, "id") == Some(category))
}

fn config_option<'a>(session: &'a Value, category: &str) -> Option<&'a Value> {
    let options = session.get("configOptions").and_then(Value::as_array)?;
    config_option_in(options, category)
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

pub(crate) fn extract_effort_config(config_options: &[Value]) -> (Vec<String>, Option<String>) {
    let Some(opt) = config_option_in(config_options, "thought_level").or_else(|| config_option_in(config_options, "reasoning_effort")) else {
        return (Vec::new(), None);
    };
    let levels = select_values(opt).into_iter().map(|(v, _)| v).collect();
    let default_effort = str_of(opt, "currentValue").map(str::to_string);
    (levels, default_effort)
}

pub(crate) fn models_of(session: &Value) -> Vec<ModelInfo> {
    let current = current_model(session);
    let mut models = if let Some(option) = config_option(session, "model") {
        select_values(option)
            .into_iter()
            .map(|(id, display_name)| ModelInfo::new(id, display_name))
            .collect::<Vec<_>>()
    } else {
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
    };
    if let Some(cur) = current.as_deref() {
        for model in &mut models {
            if model.id == cur {
                model.is_default = true;
            }
        }
    }
    models
}

fn current_model(session: &Value) -> Option<String> {
    config_option(session, "model")
        .and_then(|o| str_of(o, "currentValue"))
        .or_else(|| session.pointer("/models/currentModelId").and_then(Value::as_str))
        .map(str::to_string)
}

fn session_config_options(reply: &Value) -> Option<Vec<Value>> {
    reply.get("configOptions").and_then(Value::as_array).cloned()
}

struct PendingPermission {
    responder: Responder<RequestPermissionResponse>,
    options: OptionSet,
}

struct PendingInteraction {
    responder: Responder<RequestPermissionResponse>,
    options: Vec<InteractionOption>,
    allow_custom: bool,
}

enum Command {
    Steer(Vec<Value>),
    Prompt(Vec<Value>),
    SetConfig {
        model: Option<String>,
        effort: Option<String>,
        permission_mode: Option<PermissionMode>,
        reply: flume::Sender<Result<()>>,
    },
    Cancel,
    Shutdown,
}

struct Opened {
    session_id: String,
    model: Option<String>,
    title: Option<String>,
    image_input: bool,
    /// The agent's `session/new` answer, for `list_models`.
    session: Value,
    /// Populated when `list_models` probes per-model `thought_level` options.
    probed_models: Option<Vec<ModelInfo>>,
    available_modes: Vec<String>,
    config_options: Vec<Value>,
}

struct Shared {
    runtime_id: String,
    flavor: AcpFlavor,
    child: OnceLock<Arc<LineChild>>,
    core: OnceLock<Arc<SessionCore>>,
    acp_session: OnceLock<String>,
    session_title: Mutex<Option<String>>,
    base_dir: OnceLock<PathBuf>,
    db_path: OnceLock<PathBuf>,
    auth_notice: OnceLock<String>,
    projector: Mutex<Projector>,
    pending: Mutex<HashMap<String, PendingPermission>>,
    pending_interactions: Mutex<HashMap<String, PendingInteraction>>,
    next_permission: AtomicU64,
    permission_mode: Mutex<PermissionMode>,
    available_modes: Mutex<Vec<String>>,
    config_options: Mutex<Vec<Value>>,
    /// `session/load` replays the old conversation; that is not new output.
    replaying: AtomicBool,
    abort_wanted: AtomicBool,
    watchdog: Arc<AbortWatchdog>,
    image_input: AtomicBool,
    in_flight_prompts: AtomicU64,
    background: Mutex<antigravity::BackgroundTracker>,
    has_child_activity: AtomicBool,
    child_activity: Mutex<antigravity::ChildActivityTracker>,
    swarm_reader: Mutex<Option<antigravity_swarm::SwarmReader>>,
    detached_continuation: AtomicBool,
    turn_start_step_idx: Mutex<Option<i64>>,
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
        let mut paths = self.children.lock();
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
        let line = self
            .updates
            .lock()
            .pop_front()
            .unwrap_or_else(|| json!({"jsonrpc":"2.0","method":"session/update","params":params}).to_string());
        if let Some(update) = params.get("update")
            && str_of(update, "sessionUpdate") == Some("session_info_update")
            && str_of(params, "sessionId").is_none_or(|id| self.acp_session.get().is_none_or(|root| root == id))
            && let Some(title) = str_of(update, "title").map(str::trim).filter(|t| !t.is_empty())
        {
            *self.session_title.lock() = Some(title.to_string());
        }
        if self.replaying.load(Ordering::SeqCst) {
            return;
        }
        let Some(core) = self.core.get() else { return };
        let Some(update) = params.get("update") else { return };
        let path = self.agent_path(params);
        let update_kind = str_of(update, "sessionUpdate").unwrap_or_default();
        let mut child_events = Vec::new();
        if self.flavor == AcpFlavor::Antigravity
            && path.is_empty()
            && matches!(update_kind, "tool_call" | "tool_call_update")
            && let Some(tool_id) = str_of(update, "toolCallId")
        {
            let title = str_of(update, "title").unwrap_or_default();
            let kind = str_of(update, "kind").unwrap_or_default();
            let status = str_of(update, "status").unwrap_or_default();
            self.background.lock().on_tool_update(tool_id, title, kind, update.get("rawInput"), status);
            let parent_id = self.acp_session.get().map(String::as_str).unwrap_or_default();
            let (matched, mapped) = self.child_activity.lock().on_tool_update(parent_id, update);
            if matched {
                self.has_child_activity.store(true, Ordering::SeqCst);
                child_events = mapped;
            }
        }
        let frame_type = format!("session/update/{update_kind}");
        let _frame = core.record_raw(&frame_type, path.clone(), &line, params);
        let events = self.projector.lock().update(update);
        for kind in events.into_iter().chain(child_events) {
            core.emit(path.clone(), kind);
        }
        if self.flavor == AcpFlavor::Antigravity
            && path.is_empty()
            && update_kind == "usage_update"
            && self.in_flight_prompts.load(Ordering::SeqCst) == 0
            && self.detached_continuation.swap(false, Ordering::SeqCst)
        {
            self.background.lock().clear();
            let (reason, error) = self.check_silent_error(StopReason::Completed, None);
            self.turn_finished(reason, error);
        }
    }

    fn auto_allow(&self, tool_kind: Option<&str>) -> bool {
        let mode = *self.permission_mode.lock();
        match self.flavor {
            AcpFlavor::Antigravity => antigravity::client_auto_allow(mode, tool_kind),
            AcpFlavor::Generic => match mode {
                PermissionMode::Bypass => true,
                PermissionMode::AcceptEdits => matches!(tool_kind, Some("edit" | "delete" | "move")),
                PermissionMode::Ask | PermissionMode::Plan => false,
            },
        }
    }

    fn on_permission(&self, request: &Value, responder: Responder<RequestPermissionResponse>) {
        let cancelled = || RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        let Some(core) = self.core.get() else {
            let _ = responder.respond(cancelled());
            return;
        };
        let tool_call = request.get("toolCall").cloned().unwrap_or(Value::Null);
        let options_val = request.get("options").unwrap_or(&Value::Null);
        let path = self.agent_path(request);

        // `interaction_*` questions are routed to the dedicated interaction channel
        // and MUST NEVER be auto-approved, even under `PermissionMode::Bypass`.
        if self.flavor == AcpFlavor::Antigravity && antigravity::is_interaction_request(&tool_call) {
            let (question, options, allow_custom) = antigravity::parse_interaction(&tool_call, options_val);
            let request_id = format!("int-{}", self.next_permission.fetch_add(1, Ordering::SeqCst));
            self.pending_interactions.lock().insert(
                request_id.clone(),
                PendingInteraction {
                    responder,
                    options: options.clone(),
                    allow_custom,
                },
            );
            core.emit(
                path,
                EventKind::InteractionRequested {
                    request_id,
                    question,
                    options,
                    allow_custom,
                },
            );
            return;
        }

        let options = OptionSet::from_json(options_val);
        for kind in self.projector.lock().permission_tool(&tool_call) {
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
        let mut summary = str_of(&tool_call, "title").unwrap_or("tool").to_string();
        let tool_kind = str_of(&tool_call, "kind");
        let mut input = match tool_call.get("rawInput") {
            Some(input) if !is_empty_input(input) => match self.flavor {
                AcpFlavor::Generic => input.clone(),
                AcpFlavor::Antigravity => antigravity::normalize_tool_input(input, tool_kind),
            },
            _ => match self.flavor {
                AcpFlavor::Generic => tool_call.clone(),
                AcpFlavor::Antigravity => antigravity::normalize_tool_input(&tool_call, tool_kind),
            },
        };
        if self.flavor == AcpFlavor::Antigravity {
            let warnings = antigravity::extract_security_warnings(options_val);
            if !warnings.is_empty() {
                if let Value::Object(map) = &mut input {
                    map.insert("_securityWarnings".to_string(), json!(warnings));
                }
                summary = format!("{summary} [warning: {}]", warnings.join("; "));
            }
        }
        self.pending.lock().insert(request_id.clone(), PendingPermission { responder, options });
        core.emit(
            path,
            EventKind::PermissionRequested {
                request_id,
                tool: tool_kind.unwrap_or("tool").to_string(),
                input,
                summary,
            },
        );
    }

    /// ACP requires every open permission / interaction request to be answered
    /// `cancelled` once the turn is cancelled.
    fn cancel_pending(&self) {
        let pending: Vec<(String, PendingPermission)> = self.pending.lock().drain().collect();
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
        let interactions: Vec<(String, PendingInteraction)> = self.pending_interactions.lock().drain().collect();
        for (request_id, pending) in interactions {
            let _ = pending.responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
            if let Some(core) = self.core.get() {
                core.emit_root(EventKind::InteractionResolved {
                    request_id,
                    decision: InteractionDecision::Cancel,
                });
            }
        }
    }

    fn check_silent_error(&self, reason: StopReason, error: Option<String>) -> (StopReason, Option<String>) {
        if self.flavor != AcpFlavor::Antigravity {
            return (reason, error);
        }
        let start_idx = self.turn_start_step_idx.lock().take();
        let (Some(path), Some(after_idx)) = (self.db_path.get(), start_idx) else {
            return (reason, error);
        };
        if let Some(silent) = antigravity_db::detect_silent_error(path, after_idx) {
            if silent.invalid_thinking_signature
                && let Some(core) = self.core.get()
            {
                core.mark_unresumable();
            }
            return (StopReason::Error, Some(silent.message));
        }
        (reason, error)
    }

    fn swarm_snapshot(&self) -> Option<SwarmSnapshot> {
        if self.flavor != AcpFlavor::Antigravity {
            return None;
        }
        let mut guard = self.swarm_reader.lock();
        let reader = guard.as_mut()?;
        // Avoid parsing swarm files on single-agent chats until either a swarm/subagent
        // tool fires or `swarm.json` appears on disk (e.g. `/swarm` or resumed session).
        if !self.has_child_activity.load(Ordering::SeqCst) {
            if !reader.has_swarm_file() {
                return None;
            }
            self.has_child_activity.store(true, Ordering::SeqCst);
        }
        reader.poll_snapshot()
    }

    fn read_child_transcript(&self, conversation_id: &str, limit: usize) -> Vec<ChildTranscriptStep> {
        if self.flavor != AcpFlavor::Antigravity {
            return Vec::new();
        }
        let Some(base) = self.base_dir.get() else {
            return Vec::new();
        };
        antigravity_swarm::read_child_transcript(base, conversation_id, limit)
    }

    fn read_subagent(&self, thread_id: &str, _turn_id: Option<&str>) -> Result<SubagentSnapshot> {
        if self.flavor != AcpFlavor::Antigravity {
            return Err(AgentError::Unsupported {
                option: "read_subagent".into(),
                reason: "runtime cannot read a saved child thread".into(),
            });
        }
        let parent_thread_id = self.acp_session.get().cloned();
        let last_message = |conv_id: &str| -> (Option<String>, Option<SubagentStatus>) {
            let steps = self.read_child_transcript(conv_id, 5);
            let msg = steps.iter().rev().find_map(|s| s.error.clone().or_else(|| s.content.clone()));
            let derived = steps.last().map(|s| {
                if s.error.is_some() || s.kind == "ERROR_MESSAGE" {
                    SubagentStatus::Errored
                } else if s.status.as_deref().is_some_and(|st| st.eq_ignore_ascii_case("RUNNING")) {
                    SubagentStatus::Running
                } else {
                    SubagentStatus::Completed
                }
            });
            (msg, derived)
        };

        if let Some(swarm) = self.swarm_snapshot()
            && let Some(member) = swarm.members.iter().find(|m| m.name == thread_id || m.conversation_id == thread_id)
        {
            let status = match member.state {
                SwarmMemberState::Working | SwarmMemberState::Waiting => SubagentStatus::Running,
                SwarmMemberState::Stopped => SubagentStatus::Interrupted,
                SwarmMemberState::Killed => SubagentStatus::Shutdown,
            };
            let (message, _) = last_message(&member.conversation_id);
            return Ok(SubagentSnapshot {
                parent_thread_id,
                agent_name: Some(member.name.clone()),
                status: Some(status),
                message,
            });
        }

        if let Some(db_path) = self.db_path.get() {
            let children = antigravity_db::list_invoked_subagents(db_path, antigravity_db::MAX_CHILDREN);
            if let Some(child) = children
                .into_iter()
                .find(|c| c.conversation_id.as_deref() == Some(thread_id) || c.role.as_deref() == Some(thread_id))
            {
                let (message, status) = child
                    .conversation_id
                    .as_deref()
                    .map(last_message)
                    .unwrap_or((None, Some(SubagentStatus::Running)));
                return Ok(SubagentSnapshot {
                    parent_thread_id,
                    agent_name: child.role,
                    status: status.or(Some(SubagentStatus::Running)),
                    message,
                });
            }
        }

        Ok(SubagentSnapshot {
            parent_thread_id,
            agent_name: None,
            status: Some(SubagentStatus::NotFound),
            message: None,
        })
    }

    fn turn_finished(&self, reason: StopReason, error: Option<String>) {
        self.cancel_pending();
        self.abort_wanted.store(false, Ordering::SeqCst);
        self.detached_continuation.store(false, Ordering::SeqCst);
        self.watchdog.on_turn_finished();
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

fn error_code(error: &agent_client_protocol::Error) -> Option<i64> {
    serde_json::to_value(error.code).ok().and_then(|c| c.as_i64())
}

fn acp_error(context: &str, error: &agent_client_protocol::Error) -> String {
    let code = error_code(error).unwrap_or(0);
    match &error.data {
        Some(data) if !data.is_null() => format!("{context}: {} ({code}): {data}", error.message),
        _ => format!("{context}: {} ({code})", error.message),
    }
}

fn is_auth_required(flavor: AcpFlavor, error: &agent_client_protocol::Error) -> bool {
    let code = error_code(error);
    match flavor {
        AcpFlavor::Generic => code == Some(-32000),
        AcpFlavor::Antigravity => antigravity::is_auth_error(code, &error.message, error.data.as_ref()),
    }
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

async fn send_set_config_option(
    cx: &ConnectionTo<Agent>,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> std::result::Result<Value, agent_client_protocol::Error> {
    let msg = UntypedMessage::new(
        "session/set_config_option",
        json!({
            "sessionId": session_id,
            "configId": config_id,
            "value": value,
        }),
    )?;
    cx.send_request(msg).block_task().await
}

/// Initialize, authenticate (if configured/non-interactive), open the session,
/// and apply options; everything that can refuse an option happens here before
/// `open` returns a session.
async fn handshake(cx: &ConnectionTo<Agent>, shared: &Shared, opts: &SessionOptions, probe_models: bool) -> Result<Opened> {
    let name = &shared.runtime_id;
    let init = match shared.flavor {
        AcpFlavor::Generic => {
            let reply = cx
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1).client_info(Implementation::new("vibevalley", env!("CARGO_PKG_VERSION")).title("VibeValley")),
                )
                .block_task()
                .await
                .map_err(|e| AgentError::Protocol(acp_error("initialize", &e)))?;
            serde_json::to_value(&reply).unwrap_or(Value::Null)
        }
        AcpFlavor::Antigravity => {
            let req = UntypedMessage::new("initialize", antigravity::initialize_params()).map_err(|e| AgentError::Protocol(acp_error("initialize", &e)))?;
            cx.send_request(req)
                .block_task()
                .await
                .map_err(|e| AgentError::Protocol(acp_error("initialize", &e)))?
        }
    };

    let auth_error = |context: &str, error: &agent_client_protocol::Error| -> AgentError {
        let methods: Vec<&str> = init
            .get("authMethods")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| str_of(m, "name").or_else(|| str_of(m, "id")))
            .collect();
        let hint = match shared.flavor {
            AcpFlavor::Antigravity => "Run `agy acp --login` first.",
            AcpFlavor::Generic => "Log in with the agent's own CLI first.",
        };
        AgentError::NotAvailable(format!(
            "{name} needs a login before it can open a session ({context}): {} (methods: {}). {hint}",
            error.message,
            methods.join(", ")
        ))
    };

    if shared.flavor == AcpFlavor::Antigravity
        && let Some(method_id) = antigravity::pick_auth_method(&init, &opts.env, opts.base_env.as_deref())
    {
        let auth_req =
            UntypedMessage::new("authenticate", json!({ "methodId": method_id })).map_err(|e| AgentError::Protocol(acp_error("authenticate", &e)))?;
        cx.send_request(auth_req).block_task().await.map_err(|e| {
            if is_auth_required(shared.flavor, &e) {
                auth_error("authenticate", &e)
            } else {
                AgentError::NotAvailable(acp_error("authenticate", &e))
            }
        })?;
    }

    let capabilities = init.get("agentCapabilities").cloned().unwrap_or(Value::Null);
    let session_capability = |key: &str| capabilities.pointer(&format!("/sessionCapabilities/{key}")).is_some_and(|v| !v.is_null());
    let image_input = capabilities.pointer("/promptCapabilities/image").and_then(Value::as_bool) == Some(true);

    let mut meta = Map::new();
    let system_prompt = match shared.flavor {
        AcpFlavor::Antigravity => {
            if let Some(extra) = opts.append_system_prompt.as_deref().filter(|s| !s.is_empty()) {
                if let Some(agy_meta) = antigravity::build_session_meta(&init, Some(extra)) {
                    meta.extend(agy_meta);
                    None
                } else if session_capability("systemPrompt") {
                    Some(
                        typed::<SystemPrompt>(json!({ "mode": "append", "content": [{ "type": "text", "text": extra }] }))
                            .map_err(|e| AgentError::Protocol(acp_error("system prompt", &e)))?,
                    )
                } else {
                    return Err(unsupported(
                        "append_system_prompt",
                        format!("{name} does not advertise `_meta.antigravity.systemPrompt.append`"),
                    ));
                }
            } else {
                None
            }
        }
        AcpFlavor::Generic => {
            // A replacing prompt overrides the agent's own, with the appended part after it.
            let (mode, text) = match (&opts.system_prompt, &opts.append_system_prompt) {
                (None, None) => ("append", None),
                (None, Some(extra)) => ("append", Some(extra.clone())),
                (Some(own), None) => ("override", Some(own.clone())),
                (Some(own), Some(extra)) => ("override", Some(format!("{own}\n\n{extra}"))),
            };
            let sp = match text {
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
            if sp.is_none() {
                if let Some(text) = &opts.system_prompt {
                    meta.insert("systemPrompt".into(), json!(text));
                }
                if let Some(text) = &opts.append_system_prompt {
                    meta.insert("appendSystemPrompt".into(), json!(text));
                }
            }
            sp
        }
    };

    let mcp_servers: Vec<agent_client_protocol::v1::schema::McpServer> = typed(json!(
        opts.mcp_servers
            .iter()
            .map(|server| match server {
                crate::oar::McpServer::Stdio { name, command, args, env, .. } => json!({
                    "name": name, "command": command, "args": args,
                    "env": env.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>(),
                }),
                crate::oar::McpServer::Http { name, url, headers } => json!({
                    "type": "http", "name": name, "url": url,
                    "headers": headers.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>(),
                }),
            })
            .collect::<Vec<_>>()
    ))
    .map_err(|e| AgentError::Protocol(acp_error("mcp servers", &e)))?;

    let open_error = |context: &str, error: agent_client_protocol::Error| {
        if is_auth_required(shared.flavor, &error) {
            auth_error(context, &error)
        } else if opts.resume.is_some() {
            AgentError::Rejected(format!("session_not_found: {}", acp_error(context, &error)))
        } else {
            AgentError::Protocol(acp_error(context, &error))
        }
    };

    let (session_id, session) = match &opts.resume {
        None => {
            let mut request = NewSessionRequest::new(&opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let params = serde_json::to_value(&request).map_err(|e| AgentError::Protocol(format!("session/new: {e}")))?;
            let msg = UntypedMessage::new("session/new", params).map_err(|e| AgentError::Protocol(acp_error("session/new", &e)))?;
            let reply = cx.send_request(msg).block_task().await.map_err(|e| open_error("session/new", e))?;
            let id = str_of(&reply, "sessionId")
                .map(str::to_string)
                .ok_or_else(|| AgentError::Protocol("session/new returned no sessionId".into()))?;
            (id, reply)
        }
        Some(id) if session_capability("resume") => {
            let mut request = ResumeSessionRequest::new(id.clone(), &opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let params = serde_json::to_value(&request).map_err(|e| AgentError::Protocol(format!("session/resume: {e}")))?;
            let msg = UntypedMessage::new("session/resume", params).map_err(|e| AgentError::Protocol(acp_error("session/resume", &e)))?;
            let reply = cx.send_request(msg).block_task().await.map_err(|e| open_error("session/resume", e))?;
            (id.clone(), reply)
        }
        Some(id) if capabilities.get("loadSession").and_then(Value::as_bool) == Some(true) || session_capability("load") => {
            let mut request = LoadSessionRequest::new(id.clone(), &opts.cwd).mcp_servers(mcp_servers.clone());
            if !meta.is_empty() {
                request.meta = Some(meta.clone());
            }
            if let Some(prompt) = system_prompt {
                request = request.system_prompt(prompt);
            }
            let params = serde_json::to_value(&request).map_err(|e| AgentError::Protocol(format!("session/load: {e}")))?;
            let msg = UntypedMessage::new("session/load", params).map_err(|e| AgentError::Protocol(acp_error("session/load", &e)))?;
            shared.replaying.store(true, Ordering::SeqCst);
            let reply = cx.send_request(msg).block_task().await;
            shared.replaying.store(false, Ordering::SeqCst);
            let reply = reply.map_err(|e| open_error("session/load", e))?;
            (id.clone(), reply)
        }
        Some(_) => return Err(unsupported("resume", format!("{name} can neither resume nor load a session"))),
    };

    let mut config_options = session_config_options(&session).unwrap_or_default();

    // `list_models()` on Antigravity probes each advertised model once in the
    // throwaway session so each `ModelInfo` carries its `thought_level` options.
    let probed_models = if probe_models && shared.flavor == AcpFlavor::Antigravity {
        let mut models = models_of(&session);
        let model_config_id = config_option_in(&config_options, "model").and_then(|o| str_of(o, "id")).map(str::to_string);
        let initial_model = current_model(&session);
        if let Some(config_id) = model_config_id {
            for model in &mut models {
                if initial_model.as_deref() == Some(model.id.as_str()) {
                    let (levels, default_effort) = extract_effort_config(&config_options);
                    model.effort_levels = levels;
                    model.default_effort = default_effort;
                    continue;
                }
                if let Ok(reply) = send_set_config_option(cx, &session_id, &config_id, &model.id).await
                    && let Some(updated) = session_config_options(&reply)
                {
                    let (levels, default_effort) = extract_effort_config(&updated);
                    model.effort_levels = levels;
                    model.default_effort = default_effort;
                    config_options = updated;
                }
            }
        }
        Some(models)
    } else {
        None
    };

    let mut model = current_model(&session);
    if let Some(wanted) = &opts.model {
        let listed = models_of(&session);
        if !listed.is_empty() && !listed.iter().any(|m| &m.id == wanted) {
            return Err(unsupported("model", format!("{name} does not list model `{wanted}` (see list_models)")));
        }
        match config_option_in(&config_options, "model").and_then(|o| str_of(o, "id")).map(str::to_string) {
            Some(config_id) => {
                let reply = send_set_config_option(cx, &session_id, &config_id, wanted)
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                if let Some(updated) = session_config_options(&reply) {
                    config_options = updated;
                }
            }
            None => {
                let message = UntypedMessage::new("session/set_model", json!({ "sessionId": session_id, "modelId": wanted }))
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                cx.send_request(message)
                    .block_task()
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
            }
        }
        model = Some(wanted.clone());
    }

    if let Some(effort) = &opts.effort {
        let config_id = config_option_in(&config_options, "thought_level")
            .or_else(|| config_option_in(&config_options, "reasoning_effort"))
            .and_then(|o| str_of(o, "id"))
            .unwrap_or(match shared.flavor {
                AcpFlavor::Antigravity => "thought_level",
                AcpFlavor::Generic => "reasoning_effort",
            })
            .to_string();
        let reply = send_set_config_option(cx, &session_id, &config_id, effort)
            .await
            .map_err(|e| unsupported("effort", acp_error("the agent refused the reasoning effort", &e)))?;
        if let Some(updated) = session_config_options(&reply) {
            config_options = updated;
        }
    }

    let modes: Vec<String> = session
        .pointer("/modes/availableModes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| str_of(m, "id").map(str::to_string))
        .collect();
    let mode_option = config_option_in(&config_options, "mode");
    let option_modes: Vec<String> = mode_option.map(select_values).unwrap_or_default().into_iter().map(|(id, _)| id).collect();
    let available_modes = if !modes.is_empty() { modes.clone() } else { option_modes.clone() };

    match shared.flavor {
        AcpFlavor::Antigravity => {
            if let Some(wire_mode) =
                antigravity::wire_mode_for(opts.permission_mode, &available_modes, false).map_err(|reason| unsupported("permission_mode", reason))?
            {
                apply_wire_mode(cx, &session_id, &modes, mode_option, &wire_mode).await?;
            }
        }
        AcpFlavor::Generic => {
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
        }
    }

    let title = str_of(&session, "title").map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);

    Ok(Opened {
        session_id,
        model,
        title,
        image_input,
        session,
        probed_models,
        available_modes,
        config_options,
    })
}

async fn apply_wire_mode(cx: &ConnectionTo<Agent>, session_id: &str, modes: &[String], mode_option: Option<&Value>, wire_mode: &str) -> Result<()> {
    if modes.iter().any(|m| m == wire_mode) {
        cx.send_request(SetSessionModeRequest::new(session_id.to_string(), wire_mode.to_string()))
            .block_task()
            .await
            .map_err(|e| unsupported("permission_mode", acp_error("the agent refused the mode", &e)))?;
        return Ok(());
    }
    if let Some(config_id) = mode_option.and_then(|o| str_of(o, "id")) {
        send_set_config_option(cx, session_id, config_id, wire_mode)
            .await
            .map_err(|e| unsupported("permission_mode", acp_error("the agent refused the mode", &e)))?;
        return Ok(());
    }
    cx.send_request(SetSessionModeRequest::new(session_id.to_string(), wire_mode.to_string()))
        .block_task()
        .await
        .map_err(|e| unsupported("permission_mode", acp_error("the agent refused the mode", &e)))?;
    Ok(())
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

fn dispatch_prompt(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    session_id: &str,
    blocks: Vec<Value>,
) -> std::result::Result<(), agent_client_protocol::Error> {
    if shared.flavor == AcpFlavor::Antigravity {
        shared.detached_continuation.store(false, Ordering::SeqCst);
        let prev = shared.in_flight_prompts.fetch_add(1, Ordering::SeqCst);
        if prev == 0 {
            let start_idx = shared.db_path.get().and_then(|p| antigravity_db::latest_step_index(p));
            *shared.turn_start_step_idx.lock() = start_idx;
        }
    }
    let request = UntypedMessage::new("session/prompt", json!({ "sessionId": session_id, "prompt": blocks }))?;
    let shared = shared.clone();
    // Ordered: the answer is handled after every update that preceded it.
    cx.send_request(request).on_receiving_result(move |result| async move {
        match result {
            Ok(reply) => {
                let raw_stop = str_of(&reply, "stopReason").map(str::to_string);
                let _frame = shared
                    .core
                    .get()
                    .map(|core| core.record_raw("session/prompt_result", vec![], &reply.to_string(), &reply));
                match shared.flavor {
                    AcpFlavor::Generic => {
                        let (reason, error) = stop_reason(&reply);
                        shared.turn_finished(reason, error);
                    }
                    AcpFlavor::Antigravity => {
                        let remaining = shared.in_flight_prompts.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
                        if remaining > 0 {
                            return Ok(());
                        }
                        let (mut reason, mut error) = stop_reason(&reply);
                        if matches!(raw_stop.as_deref(), Some("end_turn" | "refusal")) {
                            (reason, error) = shared.check_silent_error(reason, error);
                        }
                        if reason == StopReason::Completed && shared.background.lock().has_open() && !shared.abort_wanted.load(Ordering::SeqCst) {
                            shared.detached_continuation.store(true, Ordering::SeqCst);
                            return Ok(());
                        }
                        shared.turn_finished(reason, error);
                    }
                }
            }
            Err(error) => {
                if shared.flavor == AcpFlavor::Antigravity {
                    let remaining = shared.in_flight_prompts.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
                    if remaining > 0 {
                        return Ok(());
                    }
                }
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
    Ok(())
}

async fn apply_live_config(
    cx: &ConnectionTo<Agent>,
    shared: &Shared,
    session_id: &str,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<PermissionMode>,
) -> Result<()> {
    let mut config_options = shared.config_options.lock().clone();
    if let Some(wanted) = model {
        match config_option_in(&config_options, "model").and_then(|o| str_of(o, "id")).map(str::to_string) {
            Some(config_id) => {
                let reply = send_set_config_option(cx, session_id, &config_id, &wanted)
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                if let Some(updated) = session_config_options(&reply) {
                    config_options = updated;
                }
            }
            None => {
                let msg = UntypedMessage::new("session/set_model", json!({ "sessionId": session_id, "modelId": wanted }))
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
                cx.send_request(msg)
                    .block_task()
                    .await
                    .map_err(|e| unsupported("model", acp_error("the agent refused the model", &e)))?;
            }
        }
    }
    if let Some(wanted_effort) = effort {
        let config_id = config_option_in(&config_options, "thought_level")
            .or_else(|| config_option_in(&config_options, "reasoning_effort"))
            .and_then(|o| str_of(o, "id"))
            .unwrap_or(match shared.flavor {
                AcpFlavor::Antigravity => "thought_level",
                AcpFlavor::Generic => "reasoning_effort",
            })
            .to_string();
        let reply = send_set_config_option(cx, session_id, &config_id, &wanted_effort)
            .await
            .map_err(|e| unsupported("effort", acp_error("the agent refused the reasoning effort", &e)))?;
        if let Some(updated) = session_config_options(&reply) {
            config_options = updated;
        }
    }
    *shared.config_options.lock() = config_options.clone();

    if let Some(wanted_mode) = permission_mode {
        let prev_mode = *shared.permission_mode.lock();
        let available = shared.available_modes.lock().clone();
        let mode_option = config_option_in(&config_options, "mode");
        match shared.flavor {
            AcpFlavor::Antigravity => {
                if let Some(wire_mode) = antigravity::wire_mode_for(wanted_mode, &available, prev_mode == PermissionMode::Plan)
                    .map_err(|reason| unsupported("permission_mode", reason))?
                {
                    apply_wire_mode(cx, session_id, &available, mode_option, &wire_mode).await?;
                }
            }
            AcpFlavor::Generic => {
                if wanted_mode != PermissionMode::Ask {
                    if let Some(mode) = matching_mode(wanted_mode, &available) {
                        apply_wire_mode(cx, session_id, &available, mode_option, mode).await?;
                    } else if wanted_mode == PermissionMode::Plan {
                        return Err(unsupported(
                            "permission_mode",
                            format!("{} has no plan mode (its modes: {available:?})", shared.runtime_id),
                        ));
                    }
                }
            }
        }
        *shared.permission_mode.lock() = wanted_mode;
    }
    Ok(())
}

async fn serve(
    cx: ConnectionTo<Agent>,
    shared: Arc<Shared>,
    opts: SessionOptions,
    probe_models: bool,
    commands: flume::Receiver<Command>,
    ready: flume::Sender<Result<Opened>>,
) -> std::result::Result<(), agent_client_protocol::Error> {
    let opened = match handshake(&cx, &shared, &opts, probe_models).await {
        Ok(opened) => opened,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Ok(());
        }
    };
    let session_id = opened.session_id.clone();
    let _ = shared.acp_session.set(session_id.clone());
    if let Some(title) = opened.title.clone() {
        let mut slot = shared.session_title.lock();
        if slot.is_none() {
            *slot = Some(title);
        }
    }
    *shared.available_modes.lock() = opened.available_modes.clone();
    *shared.config_options.lock() = opened.config_options.clone();
    shared.image_input.store(opened.image_input, Ordering::SeqCst);
    if ready.send(Ok(opened)).is_err() {
        return Ok(());
    }
    while let Ok(command) = commands.recv_async().await {
        match command {
            Command::Prompt(blocks) => {
                dispatch_prompt(&cx, &shared, &session_id, blocks)?;
            }
            Command::Steer(blocks) => match shared.flavor {
                AcpFlavor::Generic => {
                    cx.send_notification(UntypedMessage::new("session/steer", json!({"sessionId": session_id, "prompt": blocks}))?)?;
                }
                AcpFlavor::Antigravity => {
                    dispatch_prompt(&cx, &shared, &session_id, blocks)?;
                }
            },
            Command::SetConfig {
                model,
                effort,
                permission_mode,
                reply,
            } => {
                let outcome = apply_live_config(&cx, &shared, &session_id, model, effort, permission_mode).await;
                let _ = reply.send(outcome);
            }
            Command::Cancel => {
                shared.cancel_pending();
                shared.background.lock().clear();
                let was_detached = shared.detached_continuation.swap(false, Ordering::SeqCst);
                cx.send_notification(CancelNotification::new(session_id.clone()))?;
                if was_detached && shared.in_flight_prompts.load(Ordering::SeqCst) == 0 {
                    shared.turn_finished(StopReason::Aborted, None);
                }
            }
            Command::Shutdown => break,
        }
    }
    Ok(())
}

async fn run_connection(
    shared: Arc<Shared>,
    child: Arc<LineChild>,
    incoming: flume::Receiver<Option<std::io::Result<String>>>,
    opts: SessionOptions,
    probe_models: bool,
    commands: flume::Receiver<Command>,
    ready: flume::Sender<Result<Opened>>,
) {
    let incoming = Box::pin(futures_util::stream::unfold(incoming, |rx| async move {
        rx.recv_async().await.ok().flatten().map(|line| (line, rx))
    }));
    let outgoing = Box::pin(futures_util::sink::unfold(child, |child, line: String| async move {
        child.write_line_async(&line).await.map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok::<_, std::io::Error>(child)
    }));
    let updates = shared.clone();
    let permissions = shared.clone();
    let serving = shared.clone();
    let ready_failed = ready.clone();
    let result = Builder::new(Client)
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
            serve(cx, serving, opts, probe_models, commands, ready)
        })
        .await;
    let child_error = shared.child.get().map(|c| c.stderr_text()).unwrap_or_default();
    let mut message = match &result {
        Ok(()) => format!("{} closed the connection", shared.runtime_id),
        Err(error) => acp_error(&format!("{} connection failed", shared.runtime_id), error),
    };
    if !child_error.trim().is_empty() {
        message.push_str(": ");
        message.push_str(child_error.trim());
    }
    if let Some(auth_msg) = shared.auth_notice.get() {
        let _ = ready_failed.send(Err(AgentError::NotAvailable(auth_msg.clone())));
    } else {
        // Still waiting in `open`: the handshake never finished.
        let _ = ready_failed.send(Err(AgentError::Protocol(message.clone())));
    }
    if let Some(child) = shared.child.get() {
        child.kill_async().await;
    }
    if let Some(core) = shared.core.get() {
        core.observe_exit(shared.child.get().and_then(|c| c.status()));
        shared.watchdog.finish_on_exit(core, message);
    } else {
        shared.watchdog.wake();
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
    fn read_subagent(&self, thread_id: &str, turn_id: Option<&str>) -> Result<SubagentSnapshot> {
        self.shared.read_subagent(thread_id, turn_id)
    }

    fn swarm_snapshot(&self) -> Option<SwarmSnapshot> {
        self.shared.swarm_snapshot()
    }

    fn read_child_transcript(&self, conversation_id: &str, limit: usize) -> Vec<ChildTranscriptStep> {
        self.shared.read_child_transcript(conversation_id, limit)
    }

    fn session_title(&self) -> Option<String> {
        self.shared.session_title.lock().clone()
    }

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
        if let (Some(core), Some(child)) = (self.shared.core.get(), self.shared.child.get()) {
            self.shared.watchdog.arm(ABORT_GRACE, core.clone(), child.clone());
        }
        Ok(())
    }

    /// ACP answers with one of the agent's own options; a denial's message
    /// has no field to travel in and is not delivered.
    fn respond_permission(&self, request_id: &str, decision: &PermissionDecision) -> Result<()> {
        let mut pending = self.shared.pending.lock();
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

    fn respond_interaction(&self, request_id: &str, decision: &InteractionDecision) -> Result<()> {
        let mut pending = self.shared.pending_interactions.lock();
        let Some(entry) = pending.get(request_id) else {
            return Err(rejected(
                rejection::UNKNOWN_REQUEST,
                format!("the agent no longer waits on interaction `{request_id}`"),
            ));
        };
        let response = match decision {
            InteractionDecision::Select { option_id } => {
                if !entry.options.is_empty() && !entry.options.iter().any(|o| o.id == *option_id) {
                    return Err(rejected(rejection::UNSUPPORTED, format!("unknown interaction option `{option_id}`")));
                }
                RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id.clone())))
            }
            InteractionDecision::Custom { text } => {
                if !entry.allow_custom {
                    return Err(rejected(rejection::UNSUPPORTED, "this interaction does not accept custom free-text replies"));
                }
                let custom_id = entry
                    .options
                    .iter()
                    .find(|o| {
                        matches!(o.id.to_ascii_lowercase().as_str(), "custom" | "other" | "freeform")
                            || o.kind
                                .as_deref()
                                .is_some_and(|k| matches!(k.to_ascii_lowercase().as_str(), "custom" | "other" | "freeform"))
                    })
                    .or_else(|| entry.options.first())
                    .map(|o| o.id.clone())
                    .unwrap_or_else(|| "custom".to_string());
                let mut meta = Map::new();
                meta.insert("customText".to_string(), json!(text));
                meta.insert("text".to_string(), json!(text));
                meta.insert("answer".to_string(), json!(text));
                RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(custom_id).meta(meta.clone()))).meta(meta)
            }
            InteractionDecision::Cancel => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
        };
        let entry = pending.remove(request_id).expect("checked above");
        entry
            .responder
            .respond(response)
            .map_err(|e| AgentError::Io(acp_error("interaction answer", &e)))
    }

    fn set_config(&self, model: Option<&str>, effort: Option<&str>, permission_mode: Option<PermissionMode>) -> Result<()> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(Command::SetConfig {
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            permission_mode,
            reply: reply_tx,
        })?;
        reply_rx
            .recv_timeout(CONFIG_TIMEOUT)
            .map_err(|_| AgentError::Protocol("timed out waiting for session config update".into()))?
    }

    fn dispose(&self) {
        let _ = self.shared.commands.send(Command::Shutdown);
        if let Some(child) = self.shared.child.get() {
            child.kill();
            if let Some(core) = self.shared.core.get() {
                core.observe_exit(child.status());
            }
        }
        self.shared.watchdog.wake();
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

    fn flavor(&self) -> AcpFlavor {
        AcpFlavor::of(&self.spec.id)
    }

    fn connect(&self, opts: &SessionOptions, probe_models: bool) -> Result<Connected> {
        let flavor = self.flavor();
        let binary = opts.binary(&self.spec.command)?;
        let spawn_args = match flavor {
            AcpFlavor::Generic => self.spec.args.clone(),
            AcpFlavor::Antigravity => antigravity::spawn_args(&self.spec.args, opts),
        };
        let spawn_env = match flavor {
            AcpFlavor::Generic => opts.env.clone(),
            AcpFlavor::Antigravity => antigravity::spawn_env(opts),
        };
        let (commands_tx, commands_rx) = flume::unbounded();
        let shared = Arc::new(Shared {
            runtime_id: self.spec.id.clone(),
            flavor,
            child: OnceLock::new(),
            core: OnceLock::new(),
            acp_session: OnceLock::new(),
            session_title: Mutex::new(None),
            base_dir: OnceLock::new(),
            db_path: OnceLock::new(),
            auth_notice: OnceLock::new(),
            projector: Mutex::new(Projector::for_flavor(flavor)),
            pending: Mutex::new(HashMap::new()),
            pending_interactions: Mutex::new(HashMap::new()),
            next_permission: AtomicU64::new(1),
            permission_mode: Mutex::new(opts.permission_mode),
            available_modes: Mutex::new(Vec::new()),
            config_options: Mutex::new(Vec::new()),
            replaying: AtomicBool::new(false),
            abort_wanted: AtomicBool::new(false),
            watchdog: AbortWatchdog::new(),
            image_input: AtomicBool::new(false),
            in_flight_prompts: AtomicU64::new(0),
            background: Mutex::new(antigravity::BackgroundTracker::default()),
            has_child_activity: AtomicBool::new(false),
            child_activity: Mutex::new(antigravity::ChildActivityTracker::default()),
            swarm_reader: Mutex::new(None),
            detached_continuation: AtomicBool::new(false),
            turn_start_step_idx: Mutex::new(None),
            children: Default::default(),
            updates: Default::default(),
            commands: commands_tx,
            cwd: opts.cwd.clone(),
        });
        let (incoming_tx, incoming_rx) = flume::unbounded::<Option<std::io::Result<String>>>();
        let (ready_tx, ready_rx) = flume::bounded(2);
        let on_line = {
            let incoming = incoming_tx.clone();
            let shared = shared.clone();
            let ready_auth = ready_tx.clone();
            move |line: &str| {
                if flavor == AcpFlavor::Antigravity
                    && let Some(url) = antigravity::auth_url_line(line)
                {
                    let msg = format!("antigravity requires login before opening an ACP session; run `agy acp --login` (auth URL: {url})");
                    let _ = shared.auth_notice.set(msg.clone());
                    let _ = ready_auth.send(Err(AgentError::NotAvailable(msg)));
                    if let Some(child) = shared.child.get() {
                        child.kill();
                    }
                    return;
                }
                if let Ok(v) = serde_json::from_str::<Value>(line)
                    && v["method"] == "session/update"
                {
                    shared.updates.lock().push_back(line.to_string());
                }
                let _ = incoming.send(Some(Ok(line.to_string())));
            }
        };
        // Closing the stream is how the connection learns the agent is gone.
        let on_exit = move |_code: Option<i32>, _stderr: String| {
            let _ = incoming_tx.send(None);
        };
        let child = LineChild::spawn(
            Spawn {
                label: &self.spec.id,
                binary: &binary,
                args: spawn_args.clone(),
                cwd: &opts.cwd,
                env: &spawn_env,
                options: Some(opts),
                env_remove: &[],
            },
            on_line,
            on_exit,
        )?;
        let _ = shared.child.set(child.clone());
        crate::rt::current_or_global_handle().spawn(run_connection(
            shared.clone(),
            child.clone(),
            incoming_rx,
            opts.clone(),
            probe_models,
            commands_rx,
            ready_tx,
        ));
        match ready_rx.recv_timeout(opts.request_timeout.unwrap_or(OPEN_TIMEOUT)) {
            Ok(Ok(opened)) => {
                if flavor == AcpFlavor::Antigravity
                    && let Some((gemini_dir, app_data_dir)) = antigravity::resolve_db_dirs(&spawn_args, &spawn_env, opts.base_env.as_deref())
                {
                    if let Some(base) = antigravity_db::base_data_dir(&gemini_dir, &app_data_dir) {
                        let reader = antigravity_swarm::SwarmReader::new(base.clone(), opened.session_id.clone());
                        if reader.has_swarm_file() {
                            shared.has_child_activity.store(true, Ordering::SeqCst);
                        }
                        *shared.swarm_reader.lock() = Some(reader);
                        let _ = shared.base_dir.set(base);
                    }
                    if let Some(path) = antigravity_db::conversation_db_path(&opened.session_id, &gemini_dir, &app_data_dir) {
                        let _ = shared.db_path.set(path);
                    }
                }
                Ok(Connected { shared, opened })
            }
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
        if let Some(spec) = crate::oar::runtime_spec(self.id()) {
            return spec.capabilities;
        }
        Capabilities {
            resume: true,
            steer: false,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: false,
            usage: true,
            config_options: false,
        }
    }

    fn installation(&self) -> Installation {
        let Some(path) = find_binary(&self.spec.command) else {
            return Installation::NotInstalled;
        };
        let version =
            run_capture(&path, &["--version"], Duration::from_secs(15)).and_then(|out| out.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string));
        match self.flavor() {
            AcpFlavor::Generic => Installation::Available { version, path },
            AcpFlavor::Antigravity => antigravity::check_installation(path, version),
        }
    }

    fn account_usage(&self) -> Result<crate::oar::AccountUsage> {
        match self.flavor() {
            AcpFlavor::Antigravity => {
                let Some(path) = find_binary(&self.spec.command) else {
                    return Ok(crate::oar::AccountUsage::Unsupported {
                        reason: "not_installed".into(),
                    });
                };
                antigravity::read_account_usage(&path)
            }
            AcpFlavor::Generic => Ok(crate::oar::AccountUsage::Unsupported {
                reason: "not_supported".into(),
            }),
        }
    }

    /// Opens a throwaway session in the temp directory to read the agent's
    /// model list (ACP has no other way to ask).
    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let opts = SessionOptions {
            cwd: std::env::temp_dir(),
            ..Default::default()
        };
        let connected = self.connect(&opts, true)?;
        let _ = connected.shared.commands.send(Command::Shutdown);
        if let Some(child) = connected.shared.child.get() {
            child.kill();
        }
        Ok(connected.opened.probed_models.unwrap_or_else(|| models_of(&connected.opened.session)))
    }

    fn open(&self, mut opts: SessionOptions) -> Result<Arc<dyn Session>> {
        opts.prepare(self.id())?;
        let file = record::open_file(opts.record_to.as_deref())?;
        let Connected { shared, opened } = self.connect(&opts, false)?;
        let recorder = Recorder::start(file, &self.spec.id, &opened.session_id, &opts.cwd, opened.model.as_deref());
        let core = SessionCore::new(&self.spec.id, &opened.session_id, recorder);
        if opts.resume.is_some() && self.flavor() == AcpFlavor::Generic {
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
