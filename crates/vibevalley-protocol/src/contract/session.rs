#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

#[allow(unused_imports)]
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use ts_rs::TS;

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::wire::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Doing {
    pub action: SessionAction,
    pub label: String,
}

/// A Doing as the frame tells it: its action in the user's words.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct DoingView {
    pub action: SessionAction,
    pub label: String,
    pub action_text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PhaseWorking {
    pub since: i64,
    pub quiet_since: Option<i64>,
    pub retry: Option<Retry>,
    pub doing: Doing,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PhaseWorkingView {
    pub since: i64,
    pub quiet_since: Option<i64>,
    pub retry: Option<Retry>,
    pub doing: DoingView,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PhaseDone {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PhaseFailed {}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PhaseResting {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PhaseClosed {
    pub at: i64,
    pub closed: SessionClose,
}

/// Told apart by `_tag`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct IssueAnswer {
    pub conclusion: String,
    pub evidence: Vec<String>,
    pub unsure: Vec<String>,
    pub next: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub outcome: Outcome,
    pub summary: String,
    pub at: i64,
    pub spent: Option<Spent>,
    /// The conclusion it handed back in the block an answer issue asks for, when one could be read.
    pub answer: Option<IssueAnswer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ToolConnection {
    pub server: String,
    pub status: ToolConnectionStatus,
    pub reason: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
    pub role: AgentRole,
    pub name: String,
    pub agent: String,
    pub runtime: String,
    pub brief: String,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub hired_at: i64,
    pub runs: i64,
    pub last_run: Option<LastRun>,
    pub spent: Option<Spent>,
    pub channel: Option<String>,
    #[ts(as = "Option<crate::typescript::IssueId>")]
    pub issue: Option<IssueId>,
    pub refining: bool,
    pub tool_connections: Option<Vec<ToolConnection>>,
    /// The machine it works on; none for an agent hosted in the server's process.
    pub machine: Option<String>,
    pub phase: Phase,
}

/// reduce never sees these: the words are the frame's (projection/frame.ts).
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
    pub role: AgentRole,
    pub name: String,
    pub agent: String,
    pub runtime: String,
    pub brief: String,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub hired_at: i64,
    pub runs: i64,
    pub last_run: Option<LastRun>,
    pub spent: Option<Spent>,
    pub channel: Option<String>,
    #[ts(as = "Option<crate::typescript::IssueId>")]
    pub issue: Option<IssueId>,
    pub refining: bool,
    pub tool_connections: Option<Vec<ToolConnection>>,
    pub machine: Option<String>,
    pub phase: PhaseView,
    pub phase_text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
    pub const ALL: [SessionEventType; 11] = [
        SessionEventType::RunStart,
        SessionEventType::UserMessage,
        SessionEventType::MemoryRecalled,
        SessionEventType::AssistantThinking,
        SessionEventType::AssistantMessage,
        SessionEventType::ToolCall,
        SessionEventType::ToolResult,
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
            SessionEventType::LlmRetry => "llm/retry",
            SessionEventType::LlmUsage => "llm/usage",
            SessionEventType::RunError => "run/error",
            SessionEventType::RunEnd => "run/end",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct EventTokens {
    pub input: i64,
    pub cache_read: i64,
    pub output: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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
    pub text: String,
    pub action: Option<ToolAction>,
    pub action_text: Option<String>,
    pub tool: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    pub ok: Option<bool>,
    pub tokens: Option<EventTokens>,
    pub connection: Option<ToolConnection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
    #[ts(as = "Option<crate::typescript::IssueId>")]
    pub issue: Option<IssueId>,
    pub triggered_by: RunTrigger,
    pub heard: Vec<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub outcome: Option<Outcome>,
    pub summary: String,
    pub spent: Option<Spent>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactSessionPhaseChanged {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
    pub phase: Phase,
    pub channel: Option<String>,
    pub spent: Option<Spent>,
    pub brief: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactSessionChanged {
    pub at: i64,
    pub session: Session,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactSessionLeft {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
    pub closed: Option<SessionClose>,
    pub merged: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactSessionToolChanged {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
    pub connection: ToolConnection,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactSessionToolsReset {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
}

/// A computer the farm's helpers work on. Today the one this server runs on; others join from the command line.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub name: String,
    /// The server's own machine: its helpers run in the server's process.
    pub here: bool,
    /// Reachable now: the server can hire helpers on it.
    pub online: bool,
    pub joined_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactMachineChanged {
    pub at: i64,
    pub machine: Machine,
}

/// `PhaseResting` where nothing else is taken: its `_tag` written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "_tag")]
pub enum PhaseRestingOnly {
    #[serde(rename = "resting")]
    Resting(PhaseResting),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SessionStopInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SessionListInput {
    pub agent: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SessionGetInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventListInput {
    pub id: String,
    pub run: Option<String>,
}

crate::typescript::module! {
    "session";
    types: [SessionAction,
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
    Session,
    SessionView,
    SessionEventType,
    ToolAction,
    EventTokens,
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
    PhaseRestingOnly,
    SessionStopInput,
    SessionListInput,
    SessionGetInput,
    SessionEventListInput];
    aliases: [];
}
