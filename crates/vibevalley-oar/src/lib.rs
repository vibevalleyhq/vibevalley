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

pub mod acp;
mod claude;
mod codex;
mod core;
mod process;
pub mod record;
pub mod scripted;
pub mod vibevalley;

pub use crate::core::{StatusFold, derive_status, rejection};
pub use crate::record::{RecordHeader, read_record_with_header};

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
    Available {
        version: Option<String>,
        path: PathBuf,
    },
    NotInstalled,
    /// Installed but unusable (not logged in, too old, ...).
    Unusable {
        reason: String,
    },
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlways,
    Deny { message: Option<String> },
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

/// One conversation with a runtime.
pub trait Session: Send + Sync {
    fn id(&self) -> String;
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
        self.runtimes.push(runtime);
    }

    pub fn list(&self) -> &[Arc<dyn Runtime>] {
        &self.runtimes
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Runtime>> {
        self.runtimes.iter().find(|r| r.id() == id).cloned()
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
    registry.register(Arc::new(vibevalley::VibeValleyRuntime::from_env()));
    registry.register(Arc::new(scripted::ScriptedRuntime::demo()));
    registry
}

/// Reads a JSONL record file written through `SessionOptions::record_to`.
/// Also reads `oar-voyage/3` logs written by oar itself (lossy; see `record`).
pub fn read_record(path: &std::path::Path) -> Result<Vec<Event>> {
    record::read_record_with_header(path).map(|(_, events)| events)
}

#[cfg(test)]
mod tests;
