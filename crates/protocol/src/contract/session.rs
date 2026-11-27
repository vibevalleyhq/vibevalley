#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum SessionAction {
    #[serde(rename = "run_command")]
    RunCommand,
    #[serde(rename = "read_file")]
    ReadFile,
    #[serde(rename = "edit_file")]
    EditFile,
    #[serde(rename = "search")]
    Search,
    #[serde(rename = "web")]
    Web,
    #[serde(rename = "mcp")]
    Mcp,
    #[serde(rename = "wait")]
    Wait,
    #[serde(rename = "other")]
    Other,
    #[serde(rename = "thinking")]
    Thinking,
    #[serde(rename = "speaking_text")]
    SpeakingText,
    #[serde(rename = "none")]
    None,
}

impl SessionAction {
    pub const ALL: [SessionAction; 11] = [
        SessionAction::RunCommand,
        SessionAction::ReadFile,
        SessionAction::EditFile,
        SessionAction::Search,
        SessionAction::Web,
        SessionAction::Mcp,
        SessionAction::Wait,
        SessionAction::Other,
        SessionAction::Thinking,
        SessionAction::SpeakingText,
        SessionAction::None,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SessionAction::RunCommand => "run_command",
            SessionAction::ReadFile => "read_file",
            SessionAction::EditFile => "edit_file",
            SessionAction::Search => "search",
            SessionAction::Web => "web",
            SessionAction::Mcp => "mcp",
            SessionAction::Wait => "wait",
            SessionAction::Other => "other",
            SessionAction::Thinking => "thinking",
            SessionAction::SpeakingText => "speaking_text",
            SessionAction::None => "none",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Doing {
    pub action: SessionAction,
    pub label: String,
}

/// A Doing as the frame tells it: its action in the user's words.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DoingView {
    pub action: SessionAction,
    pub label: String,
    pub action_text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PhaseWorking {
    pub since: i64,
    pub quiet_since: Option<i64>,
    pub retry: Option<Retry>,
    pub doing: Doing,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PhaseWorkingView {
    pub since: i64,
    pub quiet_since: Option<i64>,
    pub retry: Option<Retry>,
    pub doing: DoingView,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PhaseDone {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PhaseFailed {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PhaseResting {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum SessionClose {
    #[serde(rename = "merged")]
    Merged,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "dismissed")]
    Dismissed,
    #[serde(rename = "lost")]
    Lost,
}

impl SessionClose {
    pub const ALL: [SessionClose; 4] = [SessionClose::Merged, SessionClose::Completed, SessionClose::Dismissed, SessionClose::Lost];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SessionClose::Merged => "merged",
            SessionClose::Completed => "completed",
            SessionClose::Dismissed => "dismissed",
            SessionClose::Lost => "lost",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PhaseClosed {
    pub at: i64,
    pub closed: SessionClose,
}

/// Told apart by `_tag`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum Phase {
    #[serde(rename = "working")]
    Working(PhaseWorking),
    #[serde(rename = "done")]
    Done(PhaseDone),
    #[serde(rename = "failed")]
    Failed(PhaseFailed),
    #[serde(rename = "resting")]
    Resting(PhaseResting),
    #[serde(rename = "closed")]
    Closed(PhaseClosed),
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum PhaseView {
    #[serde(rename = "working")]
    Working(PhaseWorkingView),
    #[serde(rename = "done")]
    Done(PhaseDone),
    #[serde(rename = "failed")]
    Failed(PhaseFailed),
    #[serde(rename = "resting")]
    Resting(PhaseResting),
    #[serde(rename = "closed")]
    Closed(PhaseClosed),
}

/// What an answer issue concludes, as its helper hands it back.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct IssueAnswer {
    pub conclusion: String,
    pub evidence: Vec<String>,
    pub unsure: Vec<String>,
    pub next: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
    pub needs_reconciliation: bool,
    pub outcome: Outcome,
    pub summary: String,
    pub at: i64,
    pub spent: Option<Spent>,
    /// The conclusion it handed back in the block an answer issue asks for, when one could be read.
    pub answer: Option<IssueAnswer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ToolConnectionStatus {
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "cancelled")]
    Cancelled,
}

impl ToolConnectionStatus {
    pub const ALL: [ToolConnectionStatus; 5] = [
        ToolConnectionStatus::Unknown,
        ToolConnectionStatus::Starting,
        ToolConnectionStatus::Ready,
        ToolConnectionStatus::Failed,
        ToolConnectionStatus::Cancelled,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ToolConnectionStatus::Unknown => "unknown",
            ToolConnectionStatus::Starting => "starting",
            ToolConnectionStatus::Ready => "ready",
            ToolConnectionStatus::Failed => "failed",
            ToolConnectionStatus::Cancelled => "cancelled",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ToolConnection {
    pub server: String,
    pub status: ToolConnectionStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
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
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum SubagentStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub struct SubagentStep {
    pub step: String,
    pub status: SubagentStepStatus,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SubagentThread {
    pub thread_id: String,
    pub agent_name: Option<String>,
    pub parent_thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub steps: Option<Vec<SubagentStep>>,
    pub task: Option<String>,
    pub status: Option<SubagentStatus>,
    pub last_activity: Option<String>,
    pub last_action: Option<ToolAction>,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SubagentWait {
    pub thread_id: String,
    pub call_id: String,
    pub targets: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSubagents {
    pub run: String,
    pub root_thread_id: String,
    pub disconnected_at: Option<i64>,
    pub threads: Vec<SubagentThread>,
    pub waits: Vec<SubagentWait>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionController {
    User,
    IssueBoard,
    Channel,
    Orchestrator,
}

impl SessionController {
    pub const ALL: [SessionController; 4] = [
        SessionController::User,
        SessionController::IssueBoard,
        SessionController::Channel,
        SessionController::Orchestrator,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SessionController::User => "user",
            SessionController::IssueBoard => "issueBoard",
            SessionController::Channel => "channel",
            SessionController::Orchestrator => "orchestrator",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecutionPolicy {
    #[serde(rename_all = "camelCase")]
    DirectCwd {
        repo: Option<String>,
        permission_mode: SessionPermissionMode,
    },
    #[serde(rename_all = "camelCase")]
    ManagedWorktree {
        repo: String,
        branch: Option<String>,
    },
    SandboxDir,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextRef {
    #[serde(rename_all = "camelCase")]
    Issue {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::IssueId"))]
        id: IssueId,
        refining: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    Channel { id: String },
    #[serde(rename_all = "camelCase")]
    Artifact {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
        id: ArtifactId,
    },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub controller: SessionController,
    pub role: Option<AgentRole>,
    pub name: String,
    pub profile: Option<String>,
    pub runtime: String,
    pub brief: String,
    pub cwd: Option<String>,
    pub policy: ExecutionPolicy,
    pub bindings: Vec<ContextRef>,
    pub hired_at: i64,
    pub runs: i64,
    pub last_run: Option<LastRun>,
    pub spent: Option<Spent>,
    pub subagents: Option<SessionSubagents>,
    pub tool_connections: Option<Vec<ToolConnection>>,
    pub telemetry: Option<SessionTelemetry>,
    /// The machine it works on; none for an agent hosted in the server's process.
    pub machine: Option<String>,
    pub phase: Phase,
}

/// reduce never sees these: the words are the frame's (projection/frame.ts).
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub controller: SessionController,
    pub role: Option<AgentRole>,
    pub name: String,
    pub profile: Option<String>,
    pub runtime: String,
    pub brief: String,
    pub cwd: Option<String>,
    pub policy: ExecutionPolicy,
    pub bindings: Vec<ContextRef>,
    pub hired_at: i64,
    pub runs: i64,
    pub last_run: Option<LastRun>,
    pub spent: Option<Spent>,
    pub subagents: Option<SessionSubagents>,
    pub tool_connections: Option<Vec<ToolConnection>>,
    pub telemetry: Option<SessionTelemetry>,
    pub machine: Option<String>,
    pub phase: PhaseView,
    pub phase_text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum SessionEventType {
    #[serde(rename = "run/start")]
    RunStart,
    #[serde(rename = "user/message")]
    UserMessage,
    #[serde(rename = "memory/recalled")]
    MemoryRecalled,
    #[serde(rename = "assistant/thinking")]
    AssistantThinking,
    #[serde(rename = "assistant/message")]
    AssistantMessage,
    #[serde(rename = "tool/call")]
    ToolCall,
    #[serde(rename = "tool/result")]
    ToolResult,
    #[serde(rename = "permission/request")]
    PermissionRequest,
    #[serde(rename = "permission/resolved")]
    PermissionResolved,
    #[serde(rename = "interaction/request")]
    InteractionRequest,
    #[serde(rename = "interaction/resolved")]
    InteractionResolved,
    #[serde(rename = "llm/retry")]
    LlmRetry,
    #[serde(rename = "llm/usage")]
    LlmUsage,
    #[serde(rename = "run/error")]
    RunError,
    #[serde(rename = "run/end")]
    RunEnd,
}

impl SessionEventType {
    pub const ALL: [SessionEventType; 15] = [
        SessionEventType::RunStart,
        SessionEventType::UserMessage,
        SessionEventType::MemoryRecalled,
        SessionEventType::AssistantThinking,
        SessionEventType::AssistantMessage,
        SessionEventType::ToolCall,
        SessionEventType::ToolResult,
        SessionEventType::PermissionRequest,
        SessionEventType::PermissionResolved,
        SessionEventType::InteractionRequest,
        SessionEventType::InteractionResolved,
        SessionEventType::LlmRetry,
        SessionEventType::LlmUsage,
        SessionEventType::RunError,
        SessionEventType::RunEnd,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SessionEventType::RunStart => "run/start",
            SessionEventType::UserMessage => "user/message",
            SessionEventType::MemoryRecalled => "memory/recalled",
            SessionEventType::AssistantThinking => "assistant/thinking",
            SessionEventType::AssistantMessage => "assistant/message",
            SessionEventType::ToolCall => "tool/call",
            SessionEventType::ToolResult => "tool/result",
            SessionEventType::PermissionRequest => "permission/request",
            SessionEventType::PermissionResolved => "permission/resolved",
            SessionEventType::InteractionRequest => "interaction/request",
            SessionEventType::InteractionResolved => "interaction/resolved",
            SessionEventType::LlmRetry => "llm/retry",
            SessionEventType::LlmUsage => "llm/usage",
            SessionEventType::RunError => "run/error",
            SessionEventType::RunEnd => "run/end",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ToolAction {
    #[serde(rename = "run_command")]
    RunCommand,
    #[serde(rename = "read_file")]
    ReadFile,
    #[serde(rename = "edit_file")]
    EditFile,
    #[serde(rename = "search")]
    Search,
    #[serde(rename = "web")]
    Web,
    #[serde(rename = "mcp")]
    Mcp,
    #[serde(rename = "wait")]
    Wait,
    #[serde(rename = "other")]
    Other,
}

impl ToolAction {
    pub const ALL: [ToolAction; 8] = [
        ToolAction::RunCommand,
        ToolAction::ReadFile,
        ToolAction::EditFile,
        ToolAction::Search,
        ToolAction::Web,
        ToolAction::Mcp,
        ToolAction::Wait,
        ToolAction::Other,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ToolAction::RunCommand => "run_command",
            ToolAction::ReadFile => "read_file",
            ToolAction::EditFile => "edit_file",
            ToolAction::Search => "search",
            ToolAction::Web => "web",
            ToolAction::Mcp => "mcp",
            ToolAction::Wait => "wait",
            ToolAction::Other => "other",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct EventTokens {
    pub input: i64,
    pub cache_read: i64,
    pub output: i64,
    pub cache_write: Option<i64>,
    pub reasoning: Option<i64>,
    pub context_used: Option<i64>,
    pub context_window: Option<i64>,
}

/// Aggregated token usage, context saturation, and retry/error counts for a session.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionTelemetry {
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub cache_write_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub context_used: Option<i64>,
    pub context_window: Option<i64>,
    pub llm_retries: i64,
    pub run_errors: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionPermissionMode {
    #[default]
    Ask,
    AcceptEdits,
    Bypass,
    ReadOnly,
}

impl SessionPermissionMode {
    pub const ALL: [SessionPermissionMode; 4] = [
        SessionPermissionMode::Ask,
        SessionPermissionMode::AcceptEdits,
        SessionPermissionMode::Bypass,
        SessionPermissionMode::ReadOnly,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionPermissionMode::Ask => "ask",
            SessionPermissionMode::AcceptEdits => "acceptEdits",
            SessionPermissionMode::Bypass => "bypass",
            SessionPermissionMode::ReadOnly => "readOnly",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionPermissionDecision {
    AllowOnce,
    AllowAlways,
    Deny,
}

impl SessionPermissionDecision {
    pub const ALL: [SessionPermissionDecision; 3] = [
        SessionPermissionDecision::AllowOnce,
        SessionPermissionDecision::AllowAlways,
        SessionPermissionDecision::Deny,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionPermissionDecision::AllowOnce => "allowOnce",
            SessionPermissionDecision::AllowAlways => "allowAlways",
            SessionPermissionDecision::Deny => "deny",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionPermissionRequest {
    pub request_id: String,
    pub tool: String,
    pub summary: String,
    pub input: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionInteractionOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub warning: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionInteractionRequest {
    pub request_id: String,
    pub question: String,
    pub options: Vec<SessionInteractionOption>,
    pub allow_custom: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionInteractionResolution {
    pub request_id: String,
    pub accepted: bool,
    pub choice: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub seq: i64,
    /// Increases when this step's streaming text or input changes; independent of transport delivery order.
    pub revision: i64,
    pub time: i64,
    pub r#type: SessionEventType,
    pub run: Option<String>,
    pub call: Option<i64>,
    pub under: Option<i64>,
    pub thread_id: Option<String>,
    pub text: String,
    pub action: Option<ToolAction>,
    pub action_text: Option<String>,
    pub tool: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    pub ok: Option<bool>,
    pub tokens: Option<EventTokens>,
    pub connection: Option<ToolConnection>,
    pub permission: Option<SessionPermissionRequest>,
    pub interaction: Option<SessionInteractionRequest>,
    pub interaction_resolution: Option<SessionInteractionResolution>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum RunTriggerKind {
    #[serde(rename = "issue")]
    Issue,
    #[serde(rename = "comment")]
    Comment,
    #[serde(rename = "cron")]
    Cron,
    #[serde(rename = "refine")]
    Refine,
    #[serde(rename = "runtime")]
    Runtime,
}

impl RunTriggerKind {
    pub const ALL: [RunTriggerKind; 5] = [
        RunTriggerKind::Issue,
        RunTriggerKind::Comment,
        RunTriggerKind::Cron,
        RunTriggerKind::Refine,
        RunTriggerKind::Runtime,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            RunTriggerKind::Issue => "issue",
            RunTriggerKind::Comment => "comment",
            RunTriggerKind::Cron => "cron",
            RunTriggerKind::Refine => "refine",
            RunTriggerKind::Runtime => "runtime",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RunTrigger {
    pub kind: RunTriggerKind,
    pub message: Option<String>,
    /// Where the input was said and its reply belongs.
    pub channel: Option<String>,
    pub cron: Option<String>,
    pub missed: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// The external worker disconnected before acknowledging its changes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
    pub needs_reconciliation: bool,
    pub id: String,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub session: SessionId,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::IssueId>"))]
    pub issue: Option<IssueId>,
    pub subagents: Option<SessionSubagents>,
    pub triggered_by: RunTrigger,
    pub heard: Vec<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub outcome: Option<Outcome>,
    pub summary: String,
    pub spent: Option<Spent>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactSessionPhaseChanged {
    pub at: i64,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub phase: Phase,
    pub channel: Option<String>,
    pub spent: Option<Spent>,
    pub brief: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactSessionSubagentsChanged {
    pub at: i64,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub subagents: Option<SessionSubagents>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactSessionChanged {
    pub at: i64,
    pub session: Session,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactSessionLeft {
    pub at: i64,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub closed: Option<SessionClose>,
    pub merged: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactSessionToolChanged {
    pub at: i64,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub connection: ToolConnection,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactSessionToolsReset {
    pub at: i64,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
}

/// A computer the farm's helpers work on. Today the one this server runs on; others join from the command line.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub name: String,
    /// The server's own machine: its helpers run in the server's process.
    pub here: bool,
    /// Reachable now: the server can hire helpers on it.
    pub online: bool,
    pub joined_at: i64,
    #[serde(default)]
    pub platform: Option<MachinePlatform>,
    #[serde(default)]
    pub status: Option<MachineStatus>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
    pub ephemeral: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<Vec<String>>", optional))]
    pub runtimes: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactMachineChanged {
    pub at: i64,
    pub machine: Machine,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactMachineRemoved {
    pub at: i64,
    pub id: String,
}

/// `PhaseResting` where nothing else is taken: its `_tag` written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(tag = "_tag")]
pub enum PhaseRestingOnly {
    #[serde(rename = "resting")]
    Resting(PhaseResting),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionStopInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionListInput {
    pub profile: Option<String>,
    pub controller: Option<SessionController>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionGetInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionEventListInput {
    pub id: String,
    pub run: Option<String>,
    pub before_seq: Option<i64>,
    pub after_seq: Option<i64>,
    pub limit: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryRunView {
    pub run: Option<String>,
    pub asked: Option<SessionEvent>,
    pub steps: Vec<SessionEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum TrajectoryWaterfallLane {
    #[serde(rename = "asked")]
    Asked,
    #[serde(rename = "model")]
    Model,
    #[serde(rename = "tool")]
    Tool,
}

impl TrajectoryWaterfallLane {
    pub const ALL: [TrajectoryWaterfallLane; 3] = [TrajectoryWaterfallLane::Asked, TrajectoryWaterfallLane::Model, TrajectoryWaterfallLane::Tool];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            TrajectoryWaterfallLane::Asked => "asked",
            TrajectoryWaterfallLane::Model => "model",
            TrajectoryWaterfallLane::Tool => "tool",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryLaneSpan {
    pub lane: TrajectoryWaterfallLane,
    pub start: i64,
    pub end: i64,
    pub seq: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryWaterfall {
    pub runs: Vec<[i64; 2]>,
    pub spans: Vec<TrajectoryLaneSpan>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TrajectorySummary {
    pub runs: i64,
    pub steps: i64,
    pub model_ms: i64,
    pub tool_ms: i64,
    pub input: i64,
    pub cache_read: i64,
    pub output: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryStepDuration {
    pub seq: i64,
    pub duration_ms: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryStepMeta {
    pub seq: i64,
    pub duration_ms: i64,
    pub readable_input: Option<String>,
    pub collapsed_summary: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionTrajectoryProjection {
    pub shown: Vec<SessionEvent>,
    pub runs: Vec<TrajectoryRunView>,
    pub waterfall: TrajectoryWaterfall,
    pub summary: TrajectorySummary,
    pub step_durations: Vec<TrajectoryStepDuration>,
    pub step_meta: Vec<TrajectoryStepMeta>,
    pub telemetry: SessionTelemetry,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ActivityStep {
    pub step: SessionEvent,
    pub duration_ms: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ActivityEditedFile {
    pub path: String,
    pub line: Option<i64>,
    pub can_diff: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ActivityCommandPreview {
    pub seq: i64,
    pub command: String,
    pub running: bool,
    pub failed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum TodoStepStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "in_progress")]
    InProgress,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "skipped")]
    Skipped,
    #[serde(rename = "failed")]
    Failed,
}

impl TodoStepStatus {
    pub const ALL: [TodoStepStatus; 5] = [
        TodoStepStatus::Pending,
        TodoStepStatus::InProgress,
        TodoStepStatus::Done,
        TodoStepStatus::Skipped,
        TodoStepStatus::Failed,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            TodoStepStatus::Pending => "pending",
            TodoStepStatus::InProgress => "in_progress",
            TodoStepStatus::Done => "done",
            TodoStepStatus::Skipped => "skipped",
            TodoStepStatus::Failed => "failed",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TodoStep {
    pub title: String,
    pub status: TodoStepStatus,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TodoChecklist {
    pub seq: i64,
    pub steps: Vec<TodoStep>,
    pub done_count: i64,
    pub in_progress_count: i64,
    pub failed_count: i64,
    pub total_count: i64,
    pub active_step: Option<TodoStep>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    pub total_steps: i64,
    pub thinking_count: i64,
    pub read_count: i64,
    pub search_count: i64,
    pub edit_count: i64,
    pub command_count: i64,
    pub other_tool_count: i64,
    pub total_tools: i64,
    pub running_count: i64,
    pub failed_count: i64,
    pub started_at: i64,
    pub duration_ms: i64,
    pub edited_files: Vec<ActivityEditedFile>,
    pub latest_command: Option<ActivityCommandPreview>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatFeedItem {
    #[serde(rename_all = "camelCase")]
    Step {
        key: String,
        step: SessionEvent,
        duration_ms: Option<i64>,
        trailing: bool,
    },
    #[serde(rename_all = "camelCase")]
    Activity {
        key: String,
        steps: Vec<ActivityStep>,
        summary: ActivitySummary,
        trailing: bool,
    },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ToolTarget {
    pub path: String,
    pub line: Option<i64>,
    pub can_diff: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ToolDetails {
    pub headline: String,
    pub formatted_input: String,
    pub output_lines: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChatTelemetry {
    pub cached_read: i64,
    pub uncached_input: i64,
    pub total_input: i64,
    pub output: i64,
    pub reasoning: i64,
    pub context_used: i64,
    pub context_window: i64,
    pub context_pct: i64,
    pub cache_hit_pct: i64,
    pub turns: i64,
    pub tool_count: i64,
    pub has_data: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BoardTextTokenKind {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "mention")]
    Mention,
    #[serde(rename = "seq")]
    Seq,
    #[serde(rename = "tag")]
    Tag,
}

impl BoardTextTokenKind {
    pub const ALL: [BoardTextTokenKind; 4] = [
        BoardTextTokenKind::Text,
        BoardTextTokenKind::Mention,
        BoardTextTokenKind::Seq,
        BoardTextTokenKind::Tag,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            BoardTextTokenKind::Text => "text",
            BoardTextTokenKind::Mention => "mention",
            BoardTextTokenKind::Seq => "seq",
            BoardTextTokenKind::Tag => "tag",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BoardTextToken {
    pub kind: BoardTextTokenKind,
    pub value: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChatToolStepProjection {
    pub seq: i64,
    pub target: Option<ToolTarget>,
    pub details: ToolDetails,
    pub todo: Option<TodoChecklist>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionProjection {
    pub visible_steps: Vec<SessionEvent>,
    pub feed_items: Vec<ChatFeedItem>,
    pub latest_todos: Option<TodoChecklist>,
    pub telemetry: ChatTelemetry,
    pub tool_entries: Vec<ChatToolStepProjection>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionEventPage {
    pub events: Vec<SessionEvent>,
    pub has_more: bool,
    pub oldest_seq: Option<i64>,
    pub newest_seq: Option<i64>,
    pub trajectory: Option<SessionTrajectoryProjection>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingInput {
    pub id: String,
    pub binding: ContextRef,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionContextFile {
    pub path: String,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenWorkspaceInput {
    pub session_id: Option<String>,
    pub runtime: String,
    pub cwd: String,
    pub repo: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<SessionPermissionMode>,
    pub title: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseWorkspaceInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkspace {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
    pub id: SessionId,
    pub session: Session,
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: SessionPermissionMode,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSendInput {
    pub id: String,
    pub text: String,
    pub attachments: Option<Vec<String>>,
    pub context_files: Option<Vec<SessionContextFile>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionRespondPermissionInput {
    pub id: String,
    pub request_id: String,
    pub decision: SessionPermissionDecision,
    pub message: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionRespondInteractionInput {
    pub id: String,
    pub request_id: String,
    pub option_id: Option<String>,
    pub text: Option<String>,
    pub cancelled: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSetConfigInput {
    pub id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<SessionPermissionMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionSwarmRole {
    Coordinator,
    Worker,
}

impl SessionSwarmRole {
    pub const ALL: [SessionSwarmRole; 2] = [SessionSwarmRole::Coordinator, SessionSwarmRole::Worker];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionSwarmRole::Coordinator => "coordinator",
            SessionSwarmRole::Worker => "worker",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionSwarmMemberState {
    Working,
    Waiting,
    Stopped,
    Killed,
}

impl SessionSwarmMemberState {
    pub const ALL: [SessionSwarmMemberState; 4] = [
        SessionSwarmMemberState::Working,
        SessionSwarmMemberState::Waiting,
        SessionSwarmMemberState::Stopped,
        SessionSwarmMemberState::Killed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionSwarmMemberState::Working => "working",
            SessionSwarmMemberState::Waiting => "waiting",
            SessionSwarmMemberState::Stopped => "stopped",
            SessionSwarmMemberState::Killed => "killed",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSwarmMember {
    pub name: String,
    pub conversation_id: String,
    pub role: SessionSwarmRole,
    pub state: SessionSwarmMemberState,
    pub wake_mode: Option<String>,
    pub wait_since: Option<i64>,
    pub model: Option<String>,
    pub workspace_mode: Option<String>,
    pub task: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSwarmThread {
    pub id: String,
    pub title: String,
    pub goal: Option<String>,
    pub members: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSwarmOverview {
    pub goal_title: Option<String>,
    pub goal_line: Option<String>,
    pub threads: Vec<SessionSwarmThread>,
    pub tasks: std::collections::BTreeMap<String, String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSwarmMessage {
    pub seq: i64,
    pub agent: String,
    pub text: String,
    pub time: String,
    pub kind: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionSwarmState {
    pub swarm_id: String,
    pub title: Option<String>,
    pub working_count: i64,
    pub active_count: i64,
    pub members: Vec<SessionSwarmMember>,
    pub overview: Option<SessionSwarmOverview>,
    pub messages: Vec<SessionSwarmMessage>,
    pub total_messages: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionChildToolCall {
    pub name: String,
    pub args: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionChildStep {
    pub step_index: i64,
    pub source: String,
    pub kind: String,
    pub status: Option<String>,
    pub created_at: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub content: Option<String>,
    pub error: Option<String>,
    pub tool_calls: Vec<SessionChildToolCall>,
    pub input_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionChildTranscriptInput {
    pub id: String,
    pub conversation_id: String,
    pub limit: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionChildTranscript {
    pub conversation_id: String,
    pub steps: Vec<SessionChildStep>,
}

/// Request to manually compact conversation context for a session.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionCompactInput {
    pub id: String,
}

/// Result of manually compacting conversation context for a session.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionCompactResult {
    pub id: String,
    pub compacted: bool,
    pub summary: Option<String>,
    pub reason: Option<String>,
}

/// Request to execute a durable CodeMode JavaScript task within a session's context.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionRunCodeInput {
    pub id: String,
    pub script: String,
    pub seed: Option<crate::JsNumber>,
    pub timeout_ms: Option<i64>,
    pub max_steps: Option<i64>,
}

/// Result of a durable CodeMode script execution.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionRunCodeResult {
    pub id: String,
    pub task_id: String,
    pub output_json: String,
    pub executed_steps: i64,
    pub replayed_calls: i64,
    pub replayed_sleeps: i64,
    pub virtual_now_ms: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SessionWatchPayload {
    pub id: String,
    pub after_seq: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionWatchEvent {
    #[serde(rename_all = "camelCase")]
    State {
        session: Session,
        title: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        permission_mode: SessionPermissionMode,
        pending_permissions: Vec<SessionPermissionRequest>,
        pending_interactions: Vec<SessionInteractionRequest>,
        tokens: Option<EventTokens>,
        swarm: Option<SessionSwarmState>,
    },
    #[serde(rename_all = "camelCase")]
    History {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
        session: SessionId,
        events: Vec<SessionEvent>,
        projection: Option<ChatSessionProjection>,
    },
    #[serde(rename_all = "camelCase")]
    Event {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
        session: SessionId,
        event: SessionEvent,
        projection: Option<ChatSessionProjection>,
    },
    #[serde(rename_all = "camelCase")]
    Missing {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SessionId"))]
        session: SessionId,
    },
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "session";
    types: [SessionAction,
    SessionController,
    ExecutionPolicy,
    ContextRef,
    Doing,
    DoingView,
    PhaseWorking,
    PhaseWorkingView,
    PhaseDone,
    PhaseFailed,
    PhaseResting,
    SessionClose,
    PhaseClosed,
    Phase,
    PhaseView,
    IssueAnswer,
    LastRun,
    ToolConnectionStatus,
    ToolConnection,
    SubagentStatus,
    SubagentStepStatus,
    SubagentStep,
    SubagentThread,
    SubagentWait,
    SessionSubagents,
    FactSessionSubagentsChanged,
    Session,
    SessionView,
    SessionEventType,
    ToolAction,
    EventTokens,
    SessionTelemetry,
    SessionPermissionMode,
    SessionPermissionDecision,
    SessionPermissionRequest,
    SessionInteractionOption,
    SessionInteractionRequest,
    SessionInteractionResolution,
    SessionEvent,
    RunTriggerKind,
    RunTrigger,
    Run,
    FactSessionPhaseChanged,
    FactSessionChanged,
    FactSessionLeft,
    FactSessionToolChanged,
    FactSessionToolsReset,
    Machine,
    FactMachineChanged,
    FactMachineRemoved,
    PhaseRestingOnly,
    SessionStopInput,
    SessionListInput,
    SessionGetInput,
    SessionEventListInput,
    TrajectoryRunView,
    TrajectoryWaterfallLane,
    TrajectoryLaneSpan,
    TrajectoryWaterfall,
    TrajectorySummary,
    TrajectoryStepDuration,
    TrajectoryStepMeta,
    SessionTrajectoryProjection,
    ActivityStep,
    ActivityEditedFile,
    ActivityCommandPreview,
    TodoStepStatus,
    TodoStep,
    TodoChecklist,
    ActivitySummary,
    ChatFeedItem,
    ToolTarget,
    ToolDetails,
    ChatToolStepProjection,
    ChatTelemetry,
    BoardTextTokenKind,
    BoardTextToken,
    ChatSessionProjection,
    SessionEventPage,
    SessionBindingInput,
    SessionContextFile,
    SessionOpenWorkspaceInput,
    SessionCloseWorkspaceInput,
    SessionWorkspace,
    SessionSendInput,
    SessionRespondPermissionInput,
    SessionRespondInteractionInput,
    SessionSetConfigInput,
    SessionSwarmRole,
    SessionSwarmMemberState,
    SessionSwarmMember,
    SessionSwarmThread,
    SessionSwarmOverview,
    SessionSwarmMessage,
    SessionSwarmState,
    SessionChildToolCall,
    SessionChildStep,
    SessionChildTranscriptInput,
    SessionChildTranscript,
    SessionCompactInput,
    SessionCompactResult,
    SessionRunCodeInput,
    SessionRunCodeResult,
    SessionWatchPayload,
    SessionWatchEvent];
    aliases: [];
}
