//! Narrow spine port traits decoupling L1/L2/L3 domains without importing any
//! concrete server domain modules.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::broadcast;
use vibevalley_core::Applied;
use vibevalley_protocol::{
    ApiError, ArtifactCard, ArtifactViewContext, BlockRef, ChannelType, ChatMessage, Fact, MessageKind, QuotedBlock, Session, SliceBundle, SpaceState,
    SubjectKind,
};

/// Where domain facts go and core state is read: the server's one state
/// (`Hub`) or, standing alone, a `LocalFacts`.
pub trait Facts: Send + Sync {
    fn apply(&self, facts: Vec<Fact>) -> Applied;
    /// Calls `f` once with the state now.
    fn read(&self, f: &mut dyn FnMut(&SpaceState));
    fn bundle(&self) -> SliceBundle;
}

/// Read-only memory recall port injected into session drivers without coupling
/// `team/agent` or `work/session` to `team/memory`.
pub trait MemoryRecallPort: Send + Sync {
    fn recall_text(&self, agent: &str, session: Option<&str>, repo: &str, query: &str) -> String;
}

/// Narrow orchestrator briefing port used by `collab/voice` (L2 -> L1 port).
pub trait VoiceOrchestratorPort: Send + Sync {
    /// Sends a voice line to the orchestrator and waits up to `wait` for its spoken reply.
    /// When `wait` is zero, fires asynchronously without waiting.
    fn brief(&self, line: String, wait: Duration) -> Option<String>;
}

/// Narrow artifact block-quoting port injected into `collab/channel::Chat::open`.
pub trait ChannelQuotePort: Send + Sync {
    fn quote(&self, refs: &[BlockRef]) -> Vec<QuotedBlock>;
}

/// Narrow channel message-edit stream port used by `content/library` (L2)
/// so it indexes attachments on edited user messages without importing `collab/channel`.
pub trait ChannelMessageEventsPort: Send + Sync {
    fn subscribe_edited_messages(&self) -> broadcast::Receiver<ChatMessage>;
}

/// Narrow channel announcement port for L2 peer domains (`content/artifact`,
/// `content/media`, `work/issue`) so they never import `collab/channel`.
pub trait ChannelAnnouncePort: Send + Sync {
    fn default_channel(&self) -> String;
    fn place_exists(&self, id: &str) -> bool;
    fn orchestrator_in(&self, channel: &str) -> String;
    fn place_of(&self, who: &str, target: &str) -> Result<String, ApiError>;
    fn post_card(&self, from: &str, channel: &str, text: &str, card: ArtifactCard, run: Option<String>, send_key: String) -> Result<ChatMessage, ApiError>;
    fn post_attachments(&self, from: &str, channel: &str, text: &str, attachments: Vec<String>, send_key: String) -> Result<ChatMessage, ApiError>;
    fn issue_thread(&self, issue_id: &str, title: &str, preferred_channel: Option<&str>) -> Result<String, ApiError>;
    fn issue_thread_id(&self, issue_id: &str) -> Option<String>;
    fn say_in(&self, channel: &str, text: &str, send_key: String) -> Result<ChatMessage, ApiError>;
    fn history(&self, channel: &str, limit: i64) -> Result<Vec<ChatMessage>, ApiError>;
}

/// Pure delivery target kind mirrored across the L2 work <-> collab boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelDeliveryKind {
    Issue,
    Session,
    Direct,
    Orchestrator,
}

/// Pure queued delivery descriptor returned by [`ChannelDispatchPort`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelDelivery {
    pub id: i64,
    pub message_id: String,
    pub channel_id: String,
    pub recipient_kind: ChannelDeliveryKind,
    pub recipient_id: String,
    pub reason: String,
    pub wakes: bool,
}

/// Pure committed message snapshot delivered over [`ChannelDispatchPort`].
#[derive(Debug, Clone)]
pub struct ChannelPostedMessage {
    pub event_seq: i64,
    pub id: String,
    pub channel_id: String,
    pub number: i64,
    pub sender_id: String,
    pub sender_kind: String,
    pub sender_name: String,
    pub sender_agent: Option<String>,
    pub kind: MessageKind,
    pub body: String,
    pub view_context: Option<ArtifactViewContext>,
    pub reply_number: Option<i64>,
    pub edited_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub channel_name: String,
    pub channel_type: ChannelType,
    pub peer: Option<String>,
    pub orchestrator: String,
    pub mentions: Vec<String>,
    pub members: Vec<String>,
    pub topic: Option<(SubjectKind, String)>,
}

/// One committed message and its routed deliveries for downstream lanes.
#[derive(Debug, Clone)]
pub struct ChannelDispatchedBatch {
    pub committed: Arc<ChannelPostedMessage>,
    pub deliveries: Vec<ChannelDelivery>,
}

/// Participant seat metadata for [`ChannelDispatchPort::seat`] and notes.
#[derive(Debug, Clone, Default)]
pub struct ChannelSeat {
    pub id: String,
    pub name: String,
    pub agent: Option<String>,
    pub home: Option<String>,
}

/// Pure place metadata returned by [`ChannelDispatchPort::place`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelPlace {
    pub id: String,
    pub r#type: ChannelType,
    pub peer: Option<String>,
    pub parent: Option<String>,
    pub name: Option<String>,
    pub last_number: i64,
    pub root: Option<(String, i64)>,
    pub topic: Option<(SubjectKind, String)>,
}

/// Thread subject metadata for [`ChannelNoteRequest`].
#[derive(Debug, Clone)]
pub struct ChannelThreadSubject {
    pub kind: SubjectKind,
    pub id: String,
    pub owner: String,
}

/// Pure note request posted into a channel or thread on behalf of a worker/issue.
#[derive(Debug, Clone)]
pub struct ChannelNoteRequest {
    pub channel: String,
    pub from: String,
    pub kind: MessageKind,
    pub text: String,
    pub meta_json: Option<String>,
    pub topic: Option<ChannelThreadSubject>,
    pub member: Option<String>,
    pub seat: Option<ChannelSeat>,
}

/// Pure system notice request.
#[derive(Debug, Clone, Default)]
pub struct ChannelNoticeRequest {
    pub channel: String,
    pub text: String,
    pub code: String,
    pub send_key: String,
    pub until_user_speaks: bool,
}

/// Pure channel participant record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelParticipant {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub agent_id: Option<String>,
    pub home_id: Option<String>,
    pub left_at: Option<i64>,
}

/// Pure channel dispatch & thread lifecycle port used by `work/chat` (L2)
/// so `work` has zero concrete imports of `collab/channel`.
pub trait ChannelDispatchPort: Send + Sync {
    fn dispatches(&self) -> flume::Receiver<ChannelDispatchedBatch>;
    fn subscribe_removals(&self) -> broadcast::Receiver<String>;
    fn pending_deliveries(&self, kind: ChannelDeliveryKind) -> Result<Vec<ChannelDelivery>, ApiError>;
    fn pending_deliveries_for(&self, kind: ChannelDeliveryKind, recipient_id: &str, max_id: i64) -> Result<Vec<ChannelDelivery>, ApiError>;
    fn delivery_is_pending(&self, id: i64) -> Result<bool, ApiError>;
    fn committed_of(&self, message_id: &str) -> Result<Option<ChannelPostedMessage>, ApiError>;
    fn settle_delivery(&self, id: i64, delivered: bool) -> Result<(), ApiError>;
    fn withdraw_delivery(&self, id: i64) -> Result<(), ApiError>;
    fn mark_seen(&self, participant: &str, message_id: &str) -> Result<(), ApiError>;
    fn react(&self, id: &str, who: &str, emoji: &str, on: bool) -> Result<ChatMessage, ApiError>;
    fn note(&self, req: ChannelNoteRequest) -> Result<String, ApiError>;
    fn note_once(&self, req: ChannelNoteRequest, send_key: Option<String>) -> Result<String, ApiError>;
    fn notice(&self, req: ChannelNoticeRequest);
    fn seat(&self, seat: ChannelSeat) -> Result<(), ApiError>;
    fn leave(&self, participant: &str) -> Result<(), ApiError>;
    fn add_follower(&self, thread: &str, participant: &str) -> Result<(), ApiError>;
    fn members_of(&self, channel: &str) -> Vec<String>;
    fn participants(&self) -> Vec<ChannelParticipant>;
    fn home_of(&self, participant: &str) -> Option<String>;
    fn place(&self, id: &str) -> Option<ChannelPlace>;
    fn default_channel(&self) -> String;
    fn orchestrator_in(&self, channel: &str) -> String;
    fn target_of(&self, channel: &str) -> Option<String>;
    fn thread_about(&self, kind: SubjectKind, id: &str) -> Option<String>;
    fn latest(&self, channel: &str) -> Result<i64, ApiError>;
    fn read_up_to(&self, participant: &str, channel: &str, upto: i64) -> Result<(), ApiError>;
    fn dispatch_count(&self, channel: &str) -> Result<i64, ApiError>;
    fn issue_thread(&self, issue_id: &str, title: &str, preferred_channel: Option<&str>) -> Result<String, ApiError>;
    fn issue_thread_id(&self, issue_id: &str) -> Option<String>;
    fn say_in(&self, channel: &str, text: &str, send_key: String) -> Result<ChatMessage, ApiError>;
    fn ensure_seated(&self, cb: Arc<dyn Fn(&str) + Send + Sync>);
}

/// Read-only `vv://` resource reader port decoupling `team/tool` from `team/mcp`.
pub trait ResourcePort: Send + Sync {
    fn read(&self, reader: Option<&Session>, uri: &str, offset: Option<i64>, limit: Option<i64>) -> Result<String, String>;
}

/// Tool schema description exposed to the MCP door without importing `team/tool`.
#[derive(Debug, Clone)]
pub struct ToolSpecWire {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Helper tool dispatch port decoupling `team/mcp::Door` from `team/tool`.
pub trait ToolDispatchPort: Send + Sync {
    fn helper_tools(&self) -> Vec<ToolSpecWire>;
    fn session_for_token(&self, token: &str) -> Option<Session>;
    fn call_helper(&self, session: Session, name: &str, args: &Value) -> Result<String, String>;
}

/// Narrow cron -> orchestrator trigger port eliminating `work/cron -> team/orchestrator`.
pub trait CronOrchestratorPort: Send + Sync {
    fn hear_cron(&self, agent: &str, channel: &str, line: &str) -> bool;
}
