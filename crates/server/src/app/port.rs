//! Narrow spine port traits decoupling L1/L2/L3 domains without importing any
//! concrete server domain modules.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::broadcast;
use vibevalley_protocol::{ApiError, ArtifactCard, BlockRef, ChatMessage, Cron, CronRequest, MediaJob, QuotedBlock, Session};

use crate::transport::api::BoxFuture;

/// Read-only memory recall port injected into session drivers without coupling
/// `team/agent` or `work/session` to `team/memory`.
pub trait MemoryRecallPort: Send + Sync {
    fn recall_text<'a>(&'a self, agent: &'a str, session: Option<&'a str>, repo: &'a str, query: &'a str) -> BoxFuture<'a, String>;
}

/// Narrow orchestrator briefing port used by `collab/voice` (L2 -> L1 port).
pub trait VoiceOrchestratorPort: Send + Sync {
    /// Sends a voice line to the orchestrator and waits up to `wait` for its spoken reply.
    /// When `wait` is zero, fires asynchronously without waiting.
    fn brief<'a>(&'a self, line: String, wait: Duration) -> BoxFuture<'a, Option<String>>;
}

/// Narrow artifact block-quoting port injected into `collab/channel::Chat::open`.
pub trait ChannelQuotePort: Send + Sync {
    fn quote(&self, refs: &[BlockRef]) -> Vec<QuotedBlock>;
}

/// Events emitted by `collab/channel::Chat` for message inserts and edits.
#[derive(Debug, Clone)]
pub enum ChannelMessageEvent {
    Posted {
        message: ChatMessage,
        thread_issue_id: Option<String>,
        answers: Option<String>,
    },
    Edited(ChatMessage),
}

/// Narrow channel message stream port used by `content/library` (L2)
/// so it indexes attachments on posted and edited user messages without importing `collab/channel`.
pub trait ChannelMessageEventsPort: Send + Sync {
    fn subscribe_message_events(&self) -> broadcast::Receiver<ChannelMessageEvent>;
}

/// Narrow media job stream port used by `content/library` (L2) without importing `content/media`.
pub trait MediaJobEventsPort: Send + Sync {
    fn subscribe_job_updates(&self) -> broadcast::Receiver<Vec<MediaJob>>;
}

/// Future returning `(channel_id, message_number)` locations keyed by `message_id`.
pub type MessageLocationsFuture<'a> = Pin<Box<dyn Future<Output = HashMap<String, (String, i64)>> + Send + 'a>>;

/// Narrow channel announcement port for L2 peer domains (`content/artifact`,
/// `content/media`, `work/issue`) so they never import `collab/channel`.
pub trait ChannelAnnouncePort: Send + Sync {
    fn default_channel(&self) -> String;
    fn place_exists(&self, id: &str) -> bool;
    fn orchestrator_in(&self, channel: &str) -> String;
    fn place_of_async<'a>(&'a self, who: &'a str, target: &'a str) -> BoxFuture<'a, Result<String, ApiError>>;
    fn post_card_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        card: ArtifactCard,
        run: Option<String>,
        send_key: String,
    ) -> BoxFuture<'a, Result<ChatMessage, ApiError>>;
    fn post_attachments_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        attachments: Vec<String>,
        send_key: String,
    ) -> BoxFuture<'a, Result<ChatMessage, ApiError>>;
    fn issue_thread_async<'a>(
        &'a self,
        issue_id: &'a str,
        title: &'a str,
        preferred_channel: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, ApiError>>;
    fn issue_thread_id(&self, issue_id: &str) -> Option<String>;
    fn say_in_async<'a>(&'a self, channel: &'a str, text: &'a str, send_key: String) -> BoxFuture<'a, Result<ChatMessage, ApiError>>;
    fn history_async<'a>(&'a self, channel: &'a str, limit: i64) -> BoxFuture<'a, Result<Vec<ChatMessage>, ApiError>>;
    fn message_locations<'a>(&'a self, ids: &'a [String]) -> MessageLocationsFuture<'a>;
}

/// Read-only `vv://` resource reader port decoupling `team/tool` from `team/mcp`.
pub trait ResourcePort: Send + Sync {
    fn read_async<'a>(
        &'a self,
        reader: Option<&'a Session>,
        uri: &'a str,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> BoxFuture<'a, Result<String, String>>;
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
    fn session_for_token<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Option<Session>>;
    fn call_helper_async<'a>(&'a self, session: Session, name: &'a str, args: &'a Value) -> BoxFuture<'a, Result<String, String>>;
}

/// Narrow cron -> orchestrator trigger port eliminating `work/cron -> team/orchestrator`.
pub trait CronOrchestratorPort: Send + Sync {
    fn hear_cron(&self, agent: &str, channel: &str, line: &str) -> bool;
}

/// Narrow cron tool port allowing L3 `team/tool` to inspect/create/delete crons
/// without importing L3 `work/cron`.
pub trait CronToolPort: Send + Sync {
    fn list_async(&self) -> BoxFuture<'_, Result<Vec<Cron>, ApiError>>;
    fn create_async<'a>(&'a self, by: &'a str, req: &'a CronRequest) -> BoxFuture<'a, Result<Cron, ApiError>>;
    fn delete_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), ApiError>>;
}

/// Read-only attachment byte access port allowing L1 `infra/machine` to serve
/// `MachineAttachmentFetch` over the WS bus without importing `content/attachment`.
pub trait AttachmentReadPort: Send + Sync {
    fn read_bytes<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(String, Vec<u8>), ApiError>>;
}
