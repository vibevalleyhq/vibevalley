//! A Rust implementation of the oar (Open Agent Runtime) interface:
//! one API to drive many local coding agents. See https://github.com/botiverse/oar
//!
//! The public API is executor-agnostic: no method needs a tokio (or any other)
//! runtime context. Events arrive on `flume` channels, which work from sync
//! code and from any async executor. Control calls are non-blocking unless
//! documented otherwise.
//!
//! CONTRACT: the items in this file are the public API other crates compile
//! against. The owner may add items; do not rename or remove existing ones.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

mod accounting;
pub mod acp;
pub use accounting::TokenTotals;
mod claude;
mod codex;
pub mod core;
mod frames;
mod process;
pub mod record;
pub mod scripted;
mod sdk;
pub mod subagent;
pub mod voyage;

pub use crate::oar::core::{StatusFold, derive_status, rejection};
pub use crate::oar::record::{RecordHeader, read_record_with_header};

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("runtime `{0}` is not registered")]
    UnknownRuntime(String),
    #[error("runtime is not installed or not usable: {0}")]
    NotAvailable(String),
    /// The runtime cannot honor a requested option. Returned before anything
    /// is opened; options are never silently dropped.
    #[error("unsupported option `{option}`: {reason}")]
    Unsupported { option: String, reason: String },
    #[error("control call rejected: {0}")]
    Rejected(String),
    #[error("io: {0}")]
    Io(String),
    #[error("protocol: {0}")]
    Protocol(String),
}

impl AgentError {
    /// For `Rejected`: the one-word reason before the first `:` (one of the
    /// constants in [`rejection`]), so callers branch on a word, not prose.
    pub fn rejection_code(&self) -> Option<&str> {
        match self {
            AgentError::Rejected(reason) => Some(reason.split(':').next().unwrap_or(reason).trim()),
            _ => None,
        }
    }
}

pub type Result<T> = std::result::Result<T, AgentError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Installation {
    Available { version: Option<String>, path: PathBuf },
    NotInstalled,
    LoginRequired { path: PathBuf },
    Unusable { reason: String },
}

/// What a runtime can do. Options outside these are refused at open time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub resume: bool,
    pub steer: bool,
    pub queue: bool,
    pub permission_requests: bool,
    pub model_selection: bool,
    pub subagents: bool,
    pub usage: bool,
    #[serde(default)]
    pub config_options: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    /// Reasoning efforts the model takes (`low`, `medium`, ...); empty when
    /// the runtime does not say.
    #[serde(default)]
    pub effort_levels: Vec<String>,
    #[serde(default)]
    pub default_effort: Option<String>,
    /// The runtime's own default model.
    #[serde(default)]
    pub is_default: bool,
}

impl ModelInfo {
    pub fn new(id: impl Into<String>, display_name: impl Into<String>) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            display_name: display_name.into(),
            effort_levels: vec![],
            default_effort: None,
            is_default: false,
        }
    }
}

/// Runs `command` (`claude`, `codex`, `opencode`, ...) from `path` instead of
/// the one found on PATH; `None` goes back to PATH. VibeValley's
/// `OAR_<COMMAND>_BIN` environment variable is honoured too, below this.
pub fn set_binary(command: &str, path: Option<std::path::PathBuf>) {
    process::set_binary(command, path);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PermissionMode {
    /// Ask before every tool that writes or executes.
    #[default]
    Ask,
    /// File edits are allowed; commands still ask.
    AcceptEdits,
    /// Never ask.
    Bypass,
    /// Read-only planning.
    Plan,
}

#[derive(Debug, Clone, Default)]
pub struct SessionOptions {
    pub baseline_timeout: Option<std::time::Duration>,
    pub request_timeout: Option<std::time::Duration>,
    pub bin_path: Option<PathBuf>,
    pub base_env: Option<Vec<(String, String)>>,
    pub unset_env: Vec<String>,
    pub name: Option<String>,
    pub service_tier: Option<String>,
    pub additional_directories: Vec<PathBuf>,
    pub output_schema: Option<serde_json::Value>,
    pub launch_args: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// Resume an earlier session by its id (works across processes).
    pub resume: Option<String>,
    pub permission_mode: PermissionMode,
    pub append_system_prompt: Option<String>,
    pub env: Vec<(String, String)>,
    /// When set, every event is also appended to this JSONL record file.
    pub record_to: Option<PathBuf>,
    /// Reasoning effort (`low`, `medium`, `high`, ...), as the model lists it.
    pub effort: Option<String>,
    /// MCP servers the session may use besides the runtime's own.
    pub mcp_servers: Vec<McpServer>,
    /// Tools the agent may not call, by the runtime's own tool names.
    pub disallowed_tools: Vec<String>,
    /// Replaces the runtime's own system prompt (VibeValley's persona mode
    /// `replace`); `append_system_prompt` still goes after it.
    pub system_prompt: Option<String>,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusableOption {
    SystemPrompt,
    AppendSystemPrompt,
    Effort,
    DisallowedTools,
    AllowedTools,
    Name,
    ServiceTier,
    AdditionalDirectories,
    OutputSchema,
    LaunchArgs,
}

impl RefusableOption {
    fn name(self) -> &'static str {
        use RefusableOption::*;
        match self {
            SystemPrompt => "system_prompt",
            AppendSystemPrompt => "append_system_prompt",
            Effort => "effort",
            DisallowedTools => "disallowed_tools",
            AllowedTools => "allowed_tools",
            Name => "name",
            ServiceTier => "service_tier",
            AdditionalDirectories => "additional_directories",
            OutputSchema => "output_schema",
            LaunchArgs => "launch_args",
        }
    }
    fn supplied(self, o: &SessionOptions) -> bool {
        use RefusableOption::*;
        match self {
            SystemPrompt => o.system_prompt.as_ref().is_some_and(|s| !s.is_empty()),
            AppendSystemPrompt => o.append_system_prompt.as_ref().is_some_and(|s| !s.is_empty()),
            Effort => o.effort.as_ref().is_some_and(|s| !s.is_empty()),
            DisallowedTools => !o.disallowed_tools.is_empty(),
            AllowedTools => !o.allowed_tools.is_empty(),
            Name => o.name.as_ref().is_some_and(|s| !s.is_empty()),
            ServiceTier => o.service_tier.as_ref().is_some_and(|s| !s.is_empty()),
            AdditionalDirectories => !o.additional_directories.is_empty(),
            OutputSchema => o.output_schema.is_some(),
            LaunchArgs => !o.launch_args.is_empty(),
        }
    }
}
fn refused_options(runtime: &str) -> &'static [RefusableOption] {
    use RefusableOption::*;
    match runtime {
        "claude" => &[Name, ServiceTier, LaunchArgs],
        "codex" => &[AllowedTools, AdditionalDirectories, Name, ServiceTier, LaunchArgs],
        "qwen" => &[Effort, Name, ServiceTier, OutputSchema, LaunchArgs],
        "qoder" => &[Effort, Name, ServiceTier, AdditionalDirectories, OutputSchema, LaunchArgs],
        "kimi" | "codebuddy" => &[
            SystemPrompt,
            AppendSystemPrompt,
            DisallowedTools,
            AllowedTools,
            AdditionalDirectories,
            OutputSchema,
            Name,
            ServiceTier,
            LaunchArgs,
        ],
        "antigravity" => &[SystemPrompt, DisallowedTools, AllowedTools, OutputSchema, Name, ServiceTier, LaunchArgs],
        "grok" | "opencode" => &[
            DisallowedTools,
            AllowedTools,
            AdditionalDirectories,
            OutputSchema,
            Name,
            ServiceTier,
            LaunchArgs,
        ],
        id if id.starts_with("acp:") => &[
            DisallowedTools,
            AllowedTools,
            AdditionalDirectories,
            OutputSchema,
            Name,
            ServiceTier,
            LaunchArgs,
        ],
        _ => &[],
    }
}

impl SessionOptions {
    fn binary(&self, name: &str) -> Result<PathBuf> {
        self.bin_path.clone().map_or_else(|| process::require_binary(name), Ok)
    }
    fn prepare(&mut self, runtime: &str) -> Result<()> {
        self.validate_for(runtime)?;
        if self.cwd.as_os_str().is_empty() {
            self.cwd = std::env::current_dir().map_err(|e| AgentError::Io(e.to_string()))?;
        }
        core::check_cwd(&self.cwd)
    }
    pub fn validate_for(&self, runtime: &str) -> Result<()> {
        if let Some(option) = refused_options(runtime).iter().find(|o| o.supplied(self)) {
            let name = option.name();
            return Err(AgentError::Unsupported {
                option: name.into(),
                reason: format!("{runtime} does not support {name}"),
            });
        }
        Ok(())
    }
}

/// One usage bucket of an account (oar's `AccountUsageWindow`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// For display (`Current session`, `Codex · 5 hours`).
    pub label: String,
    /// 0 to 1.
    pub used_ratio: f64,
    /// ISO 8601 UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    /// The runtime's own key, stable across reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// The signed-in account's subscription usage (oar's `AccountUsageSnapshot`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AccountUsage {
    #[serde(rename_all = "camelCase")]
    Available {
        #[serde(skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        email: Option<String>,
        rate_limited: bool,
        windows: Vec<UsageWindow>,
    },
    /// `not_authenticated`, `credentials_missing`, ...
    ReauthRequired { reason: String },
    /// `capability_unavailable`, `unsupported_auth_mode`, `endpoint_unavailable`, ...
    Unsupported { reason: String },
}

/// An MCP server as VibeValley and Claude Code configure one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpServer {
    Stdio {
        name: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Vec<(String, String)>,
        #[serde(default)]
        cwd: Option<PathBuf>,
    },
    Http {
        name: String,
        url: String,
        #[serde(default)]
        headers: Vec<(String, String)>,
    },
}

impl McpServer {
    pub fn name(&self) -> &str {
        match self {
            McpServer::Stdio { name, .. } | McpServer::Http { name, .. } => name,
        }
    }

    /// The entry under `mcpServers` in Claude Code's config shape.
    pub fn config_entry(&self) -> serde_json::Value {
        let map = |pairs: &[(String, String)]| pairs.iter().map(|(k, v)| (k.clone(), serde_json::json!(v))).collect::<serde_json::Map<_, _>>();
        match self {
            McpServer::Stdio { command, args, env, cwd, .. } => {
                let mut entry = serde_json::json!({ "command": command, "args": args, "env": map(env) });
                if let Some(cwd) = cwd {
                    entry["cwd"] = serde_json::json!(cwd);
                }
                entry
            }
            McpServer::Http { url, headers, .. } => serde_json::json!({ "type": "http", "url": url, "headers": map(headers) }),
        }
    }
}

/// `{ "mcpServers": { name: entry } }`.
pub fn mcp_config(servers: &[McpServer]) -> serde_json::Value {
    let entries: serde_json::Map<_, _> = servers.iter().map(|s| (s.name().to_string(), s.config_entry())).collect();
    serde_json::json!({ "mcpServers": entries })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContentBlock {
    Text(String),
    /// A file (or a line range of it) attached as context.
    File {
        path: PathBuf,
        lines: Option<(u32, u32)>,
    },
    Image {
        path: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    Completed,
    Aborted,
    MaxTurns,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlways,
    Deny { message: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteractionDecision {
    Select { option_id: String },
    Custom { text: String },
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubagentStatus {
    PendingInit,
    Running,
    Interrupted,
    Completed,
    Errored,
    Shutdown,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubagentPlanStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentPlanStep {
    pub step: String,
    pub status: SubagentPlanStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentSnapshot {
    pub parent_thread_id: Option<String>,
    pub agent_name: Option<String>,
    pub status: Option<SubagentStatus>,
    pub message: Option<String>,
}

impl SubagentSnapshot {
    fn unsupported() -> AgentError {
        AgentError::Unsupported {
            option: "read_subagent".into(),
            reason: "runtime cannot read a saved child thread".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolAction {
    RunCommand,
    ReadFile,
    EditFile,
    Search,
    Web,
    Mcp,
    Wait,
    Other,
}

pub fn tool_action(name: &str, input: &serde_json::Value) -> ToolAction {
    if let Some(kind) = input.get("kind").and_then(serde_json::Value::as_str) {
        match kind {
            "execute" => return ToolAction::RunCommand,
            "read" => return ToolAction::ReadFile,
            "edit" | "delete" | "move" => return ToolAction::EditFile,
            "search" => return ToolAction::Search,
            "fetch" => return ToolAction::Web,
            _ => {}
        }
    }
    match name {
        "Bash" | "BashOutput" | "shell" | "exec_command" | "local_shell" | "commandExecution" | "execute" | "run_command" | "command_status"
        | "send_command_input" => ToolAction::RunCommand,
        "Read" | "NotebookRead" | "read_file" | "read" | "view_file" | "view_file_outline" | "view_code_item" => ToolAction::ReadFile,
        "Edit"
        | "Write"
        | "MultiEdit"
        | "NotebookEdit"
        | "apply_patch"
        | "fileChange"
        | "edit"
        | "delete"
        | "move"
        | "write_to_file"
        | "replace_file_content"
        | "multi_replace_file_content" => ToolAction::EditFile,
        "Grep" | "Glob" | "LS" | "search" | "grep_search" | "find_by_name" | "list_dir" => ToolAction::Search,
        "WebFetch" | "WebSearch" | "web_search" | "webSearch" | "fetch" | "read_url_content" | "search_web" => ToolAction::Web,
        "collabAgentToolCall" if input["tool"] == "wait" => ToolAction::Wait,
        "mcpToolCall" => ToolAction::Mcp,
        n if n.starts_with("mcp__") || n.starts_with("mcp:") => ToolAction::Mcp,
        _ => ToolAction::Other,
    }
}

/// One fact. `seq` is strictly increasing within a session. `agent_path` is
/// empty for the root agent and names the chain of subagents otherwise.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub agent_path: Vec<String>,
    /// Milliseconds since the Unix epoch.
    pub at_ms: u64,
    pub kind: EventKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    SessionStarted {
        session_id: String,
        model: Option<String>,
    },
    TurnStarted {
        prompt: String,
    },
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ToolCallStarted {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolCallFinished {
        id: String,
        ok: bool,
        output: String,
    },
    SubagentSpawned {
        parent_thread_id: String,
        thread_id: String,
        task: Option<String>,
        agent_name: Option<String>,
    },
    SubagentWait {
        thread_id: String,
        call_id: String,
        targets: Vec<String>,
        waiting: bool,
    },
    SubagentMessage {
        thread_id: String,
        turn_id: String,
        text: String,
    },
    SubagentPlanUpdated {
        thread_id: String,
        turn_id: String,
        steps: Vec<SubagentPlanStep>,
    },
    SubagentStatusChanged {
        thread_id: String,
        turn_id: Option<String>,
        status: SubagentStatus,
        message: Option<String>,
    },
    FileChanged {
        path: PathBuf,
        change: FileChangeKind,
    },
    /// The agent waits until `Session::respond_permission` is called.
    PermissionRequested {
        request_id: String,
        tool: String,
        input: serde_json::Value,
        summary: String,
    },
    PermissionResolved {
        request_id: String,
        decision: PermissionDecision,
    },
    /// The agent asks an interactive question (e.g. `agy` `interaction_*`) and
    /// waits until `Session::respond_interaction` is called; never auto-approved.
    InteractionRequested {
        request_id: String,
        question: String,
        options: Vec<InteractionOption>,
        allow_custom: bool,
    },
    InteractionResolved {
        request_id: String,
        decision: InteractionDecision,
    },
    /// The agent asks the user something and waits for the next prompt.
    Question {
        text: String,
    },
    TurnFinished {
        reason: StopReason,
        usage: Usage,
    },
    Error {
        message: String,
    },
    SessionEnded,
}

/// Coarse state derived from the event stream, for badges and queues.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionStatus {
    Idle,
    Running,
    WaitingPermission,
    WaitingReply,
    Ended,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlAction {
    Prompt,
    Steer,
    Queue,
    Withdraw,
    Abort,
    Compact,
    StopTask,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlStatus {
    Accepted,
    Rejected,
    Unsupported,
    NotRunning,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlOutcome {
    pub action: ControlAction,
    pub status: ControlStatus,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub span_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub input_id: String,
}
/// One conversation with a runtime.
pub trait Session: Send + Sync {
    fn id(&self) -> String;
    fn control(&self, action: ControlAction, arg: &str, input_id: &str, span_id: &str) -> Result<ControlOutcome>;
    fn usage(&self) -> Option<TokenTotals> {
        self.records()
            .iter()
            .rev()
            .filter(|r| r.agent_path.is_empty())
            .flat_map(|r| r.events.iter().rev())
            .find(|e| e["kind"] == "usage")
            .and_then(|e| serde_json::from_value(e["usage"]["tokens"].clone()).ok())
    }
    fn records(&self) -> Vec<voyage::Record>;
    fn subscribe_records(&self, after: Option<u64>) -> flume::Receiver<voyage::Record>;
    fn wait(&self) -> Result<()> {
        let events = self.events();
        for e in events {
            if matches!(e.kind, EventKind::SessionEnded) {
                break;
            }
        }
        Ok(())
    }
    fn resume_id(&self) -> Option<String> {
        Some(self.id())
    }
    /// Resolves the outcome of the specified child turn. Without its turn id,
    /// only thread identity is recoverable.
    fn read_subagent(&self, _thread_id: &str, _turn_id: Option<&str>) -> Result<SubagentSnapshot> {
        Err(SubagentSnapshot::unsupported())
    }
    fn runtime_id(&self) -> &str;
    fn status(&self) -> SessionStatus;
    /// A new receiver that yields every event from now on. May be called
    /// several times; each receiver gets every event.
    fn events(&self) -> flume::Receiver<Event>;
    /// Starts a turn. Rejected while a turn is running (use `steer`/`queue`).
    fn prompt(&self, content: Vec<ContentBlock>) -> Result<()>;
    /// Injects a message into the running turn.
    fn steer(&self, content: Vec<ContentBlock>) -> Result<()>;
    /// Runs after the current turn finishes.
    fn queue(&self, content: Vec<ContentBlock>) -> Result<()>;
    fn abort(&self) -> Result<()>;
    fn respond_permission(&self, request_id: &str, decision: PermissionDecision) -> Result<()>;
    fn respond_interaction(&self, _request_id: &str, _decision: InteractionDecision) -> Result<()> {
        Err(AgentError::Unsupported {
            option: "respond_interaction".into(),
            reason: "runtime has no interactive question channel".into(),
        })
    }
    fn set_config(&self, _model: Option<&str>, _effort: Option<&str>, _permission_mode: Option<PermissionMode>) -> Result<()> {
        Err(AgentError::Unsupported {
            option: "set_config".into(),
            reason: "runtime does not support live config updates".into(),
        })
    }
    /// Stops the underlying process. The session can still be resumed by id.
    fn dispose(&self);
    /// Like `events`, but the receiver first yields every event emitted so
    /// far (so a subscriber attached after `open` still sees
    /// `SessionStarted`). Sessions that keep no history fall back to `events`.
    fn events_with_history(&self) -> flume::Receiver<Event> {
        self.events()
    }
}

/// One agent backend (Claude Code, Codex, a generic ACP agent, ...).
pub trait Runtime: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn capabilities(&self) -> Capabilities;
    fn refused_options(&self) -> &'static [RefusableOption] {
        refused_options(self.id())
    }
    /// Blocking: probes the local machine.
    fn installation(&self) -> Installation;
    /// Blocking.
    fn list_models(&self) -> Result<Vec<ModelInfo>>;
    /// Blocking until the session is ready to accept a prompt.
    fn open(&self, opts: SessionOptions) -> Result<Arc<dyn Session>>;
    /// The account's subscription usage. Blocking (it may start the CLI);
    /// never call it on a UI thread.
    fn account_usage(&self) -> Result<AccountUsage> {
        Ok(AccountUsage::Unsupported {
            reason: "capability_unavailable".into(),
        })
    }
}

pub struct Registry {
    runtimes: Vec<Arc<dyn Runtime>>,
}

impl Registry {
    pub fn new() -> Self {
        Self { runtimes: Vec::new() }
    }

    pub fn register(&mut self, runtime: Arc<dyn Runtime>) {
        if let Some(slot) = self.runtimes.iter_mut().find(|r| r.id() == runtime.id()) {
            *slot = runtime;
        } else {
            self.runtimes.push(runtime);
        }
    }

    pub fn list(&self) -> &[Arc<dyn Runtime>] {
        &self.runtimes
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Runtime>> {
        self.runtimes
            .iter()
            .find(|r| r.id() == id)
            .or_else(|| {
                self.runtimes
                    .iter()
                    .find(|r| r.id().strip_prefix("acp:") == Some(id) || id.strip_prefix("acp:") == Some(r.id()))
            })
            .cloned()
    }

    pub fn require(&self, id: &str) -> Result<Arc<dyn Runtime>> {
        self.get(id).ok_or_else(|| AgentError::UnknownRuntime(id.to_string()))
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

/// Registry with every built-in runtime: `claude`, `codex`, and `acp:*`,
/// plus `scripted` (no binary, no login; replays a demo script).
pub fn default_runtimes() -> Registry {
    let mut registry = Registry::new();
    registry.register(Arc::new(claude::ClaudeRuntime::new()));
    registry.register(Arc::new(codex::CodexRuntime::new()));
    for spec in acp::builtin_agents() {
        registry.register(Arc::new(acp::AcpRuntime::new(spec)));
    }
    registry.register(Arc::new(sdk::SdkRuntime::Qwen));
    registry.register(Arc::new(sdk::SdkRuntime::Qoder));
    registry.register(Arc::new(scripted::ScriptedRuntime::demo()));
    registry
}

/// Reads a JSONL record file written through `SessionOptions::record_to`.
pub fn read_record(path: &std::path::Path) -> Result<Vec<Event>> {
    record::read_record_with_header(path).map(|(_, events)| events)
}

#[cfg(test)]
mod tests;
