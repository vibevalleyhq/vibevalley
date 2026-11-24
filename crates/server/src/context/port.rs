//! Minimal cycle-breaking port traits shared across flat server domains.
//!
//! Only edges that would otherwise form a module dependency cycle belong here;
//! all acyclic dependencies pass concrete `Arc<Domain>` handles directly.

use std::time::Duration;

use vibevalley_protocol::{ApiError, ArtifactCard, ChatMessage, Session};

use crate::BoxFuture;

/// Breaks the `cron <-> orchestrator` cycle so `cron` triggers the orchestrator while `orchestrator`/`tool` manages crons.
pub trait CronOrchestratorPort: Send + Sync {
    fn hear_cron<'a>(&'a self, agent: &'a str, channel: &'a str, line: &'a str) -> BoxFuture<'a, bool>;
}

/// Breaks the `agent <-> cron` cycle so `cron` resolves agent ids/names without importing `crate::agent::Profile`.
pub trait CronAgentPort: Send + Sync {
    fn resolve_agent_id(&self, named: &str) -> Option<String>;
}

/// Breaks the `channel <- artifact` layering edge so `Chat` implements card/attachment announcements directly.
pub trait ChannelAnnounce: Send + Sync {
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
}

/// Breaks the `runtime/session -> memory` cycle so session drivers recall agent memories without importing `memory`.
pub trait MemoryRecallPort: Send + Sync {
    fn recall_text<'a>(&'a self, agent: &'a str, session: Option<&'a str>, repo: &'a str, query: &'a str) -> BoxFuture<'a, String>;
}

/// Decouples `voice` live-call briefing from concrete `orchestrator` construction and offline voice tests.
pub trait VoiceOrchestratorPort: Send + Sync {
    fn brief<'a>(&'a self, line: String, wait: Duration) -> BoxFuture<'a, Option<String>>;
}

/// Tool schema description exposed to the MCP door without importing `tool`.
#[derive(Debug, Clone)]
pub struct ToolSpecWire {
    pub name: String,
    pub description: String,
    pub parameters_json: String,
}

/// Breaks the `mcp <-> tool` cycle so the MCP door dispatches helper tool calls while `tool` reads `vv://` resources.
pub trait ToolDispatchPort: Send + Sync {
    fn helper_tools(&self) -> Vec<ToolSpecWire>;
    fn session_for_token<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Option<Session>>;
    fn call_helper_async<'a>(&'a self, session: Session, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>>;
}
