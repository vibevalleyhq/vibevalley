//! Minimal cycle-breaking port traits shared across flat server domains.
//!
//! Only edges that would otherwise form a module dependency cycle belong here;
//! all acyclic dependencies pass concrete `Arc<Domain>` handles directly.

use std::time::Duration;

use serde_json::Value;
use vibevalley_protocol::Session;

use crate::BoxFuture;

/// Breaks the `cron <-> orchestrator` cycle so `cron` triggers the orchestrator while `orchestrator`/`tool` manages crons.
pub trait CronOrchestratorPort: Send + Sync {
    fn hear_cron(&self, agent: &str, channel: &str, line: &str) -> bool;
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
    pub parameters: Value,
}

/// Breaks the `mcp <-> tool` cycle so the MCP door dispatches helper tool calls while `tool` reads `vv://` resources.
pub trait ToolDispatchPort: Send + Sync {
    fn helper_tools(&self) -> Vec<ToolSpecWire>;
    fn session_for_token<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Option<Session>>;
    fn call_helper_async<'a>(&'a self, session: Session, name: &'a str, args: &'a Value) -> BoxFuture<'a, Result<String, String>>;
}
