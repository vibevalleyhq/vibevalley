use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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
    /// constants in [`rejection`](crate::rejection)), so callers branch on a word, not prose.
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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

/// Structured remote-machine dispatch metadata attached to a session open request.
/// Replaces the legacy `__VIBEVALLEY_REMOTE_*` environment variable smuggling so
/// worker metadata never leaks into child process environments.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct RemoteDispatchMeta {
    pub session_id: Option<String>,
    pub repo_ref: Option<String>,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    pub mcp_session_token: Option<String>,
}

impl std::fmt::Debug for RemoteDispatchMeta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteDispatchMeta")
            .field("session_id", &self.session_id)
            .field("repo_ref", &self.repo_ref)
            .field("branch", &self.branch)
            .field("base_ref", &self.base_ref)
            .field("mcp_session_token", &self.mcp_session_token.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
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
    /// Structured metadata for remote machine dispatch (`RemoteRuntime`).
    pub remote_dispatch: Option<RemoteDispatchMeta>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnOptions {
    /// Causal trace id propagated into recorded `voyage::Record` entries (`Some(0)` is treated as `None`).
    pub trace_id: Option<u64>,
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
    pub fn snake_name(self) -> &'static str {
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

    pub fn camel_name(self) -> &'static str {
        use RefusableOption::*;
        match self {
            SystemPrompt => "systemPrompt",
            AppendSystemPrompt => "appendSystemPrompt",
            Effort => "effort",
            DisallowedTools => "disallowedTools",
            AllowedTools => "allowedTools",
            Name => "name",
            ServiceTier => "serviceTier",
            AdditionalDirectories => "additionalDirectories",
            OutputSchema => "outputSchema",
            LaunchArgs => "launchArgs",
        }
    }

    pub(super) fn supplied(self, o: &SessionOptions) -> bool {
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

    /// Converts a pure `vibevalley_mcp::McpServerConfig` into an OAR session `McpServer`.
    ///
    /// When `stateless` is set on `StreamableHttp`, ensures the SEP-2243
    /// `MCP-Protocol-Version` header is present so ACP and CLI agents negotiate
    /// stateless Streamable HTTP cleanly.
    pub fn from_mcp_config(config: &vibevalley_mcp::McpServerConfig) -> Self {
        match &config.transport {
            vibevalley_mcp::McpTransportSpec::Stdio { command, args, env } => Self::Stdio {
                name: config.name.clone(),
                command: command.clone(),
                args: args.clone(),
                env: env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                cwd: None,
            },
            vibevalley_mcp::McpTransportSpec::StreamableHttp { url, headers, stateless } => {
                let mut pairs: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                if *stateless && !pairs.iter().any(|(k, _)| k.eq_ignore_ascii_case(vibevalley_mcp::HEADER_PROTOCOL_VERSION)) {
                    pairs.push((
                        vibevalley_mcp::HEADER_PROTOCOL_VERSION.to_owned(),
                        vibevalley_mcp::PROTOCOL_STATELESS.to_owned(),
                    ));
                }
                Self::Http {
                    name: config.name.clone(),
                    url: url.clone(),
                    headers: pairs,
                }
            }
        }
    }

    /// Converts this OAR session `McpServer` into a transport-agnostic `McpServerConfig`.
    pub fn to_mcp_config(&self) -> vibevalley_mcp::McpServerConfig {
        match self {
            Self::Stdio { name, command, args, env, .. } => vibevalley_mcp::McpServerConfig {
                name: name.clone(),
                transport: vibevalley_mcp::McpTransportSpec::Stdio {
                    command: command.clone(),
                    args: args.clone(),
                    env: env.iter().cloned().collect(),
                },
            },
            Self::Http { name, url, headers } => {
                let stateless = headers
                    .iter()
                    .any(|(k, v)| k.eq_ignore_ascii_case(vibevalley_mcp::HEADER_PROTOCOL_VERSION) && v.trim() == vibevalley_mcp::PROTOCOL_STATELESS);
                vibevalley_mcp::McpServerConfig {
                    name: name.clone(),
                    transport: vibevalley_mcp::McpTransportSpec::StreamableHttp {
                        url: url.clone(),
                        headers: headers.iter().cloned().collect(),
                        stateless,
                    },
                }
            }
        }
    }
}

impl From<vibevalley_mcp::McpServerConfig> for McpServer {
    fn from(config: vibevalley_mcp::McpServerConfig) -> Self {
        Self::from_mcp_config(&config)
    }
}

impl From<&vibevalley_mcp::McpServerConfig> for McpServer {
    fn from(config: &vibevalley_mcp::McpServerConfig) -> Self {
        Self::from_mcp_config(config)
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
    pub(super) fn unsupported() -> AgentError {
        AgentError::Unsupported {
            option: "read_subagent".into(),
            reason: "runtime cannot read a saved child thread".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwarmMemberState {
    Working,
    Waiting,
    Stopped,
    Killed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmMember {
    pub name: String,
    pub conversation_id: String,
    pub role: String,
    pub state: SwarmMemberState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmPlanThread {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default)]
    pub tasks: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmPlan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_line: Option<String>,
    #[serde(default)]
    pub tasks: BTreeMap<String, String>,
    #[serde(default)]
    pub threads: Vec<SwarmPlanThread>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmMessage {
    pub seq: u64,
    pub agent: String,
    pub text: String,
    pub time: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmSnapshot {
    pub swarm_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub members: Vec<SwarmMember>,
    pub working_count: u32,
    pub waiting_count: u32,
    pub stopped_count: u32,
    pub killed_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<SwarmPlan>,
    pub messages: Vec<SwarmMessage>,
    pub total_messages: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildToolCall {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildTranscriptStep {
    pub step_index: u64,
    pub source: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ChildToolCall>,
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
