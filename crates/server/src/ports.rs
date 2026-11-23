//! Narrow spine port traits decoupling L1/L2/L3 domains without importing any
//! concrete server domain modules.

use std::time::Duration;

use serde_json::Value;
use tokio::sync::broadcast;
use vibevalley_core::Applied;
use vibevalley_protocol::{ApiError, ArtifactCard, BlockRef, ChatMessage, Fact, QuotedBlock, Session, SliceBundle, SpaceState};

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

/// Read-only attachment byte access port allowing L1 `infra/machine` to serve
/// `MachineAttachmentFetch` over the WS bus without importing `content/attachment`.
pub trait AttachmentReadPort: Send + Sync {
    fn read_bytes(&self, id: &str) -> Result<(String, Vec<u8>), ApiError>;
}
