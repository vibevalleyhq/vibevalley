//! Minimal cycle-breaking port traits shared across flat server domains.
//!
//! Only edges that would otherwise form a module dependency cycle belong here;
//! all acyclic dependencies pass concrete `Arc<Domain>` handles directly.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{ApiError, ArtifactCard, ChatMessage, ConnectorID, Issue, Millis, Run, Session};

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

/// Breaks the `agent/profile (L1) -> agent/memory (L2)` layer boundary so `AgentDriver` recalls agent memories without importing `agent/memory`.
pub trait MemoryRecallPort: Send + Sync {
    fn recall_text<'a>(&'a self, agent: &'a str, session: Option<&'a str>, repo: &'a str, query: &'a str) -> BoxFuture<'a, String>;
}

/// Decouples `voice` live-call briefing from concrete `orchestrator` construction and offline voice tests.
pub trait VoiceOrchestratorPort: Send + Sync {
    fn brief<'a>(&'a self, line: String, wait: Duration) -> BoxFuture<'a, Option<String>>;
}

/// Where a scheduled digest cron delivers its summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum DigestTargets {
    /// Configured default targets (linked WeChat when connected).
    #[default]
    Default,
    /// Explicit connector list (e.g. `Weixin`, `Feishu`).
    Connectors(Vec<ConnectorID>),
    /// Every currently connected and paired connector.
    AllConnected,
}

/// Delivers formatted scheduled progress digests from `cron` to `connector` without a `cron -> connector` edge.
pub trait DigestDeliveryPort: Send + Sync {
    fn deliver_digest_async<'a>(&'a self, cron_id: &'a str, at: Millis, targets: DigestTargets, text: &'a str) -> BoxFuture<'a, Result<usize, ApiError>>;
}

/// Lookup callback resolving the owning cron id for a given issue id.
pub type CronLookupFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Breaks `cron -> issue` so `cron` drives scheduled issues/digests without importing `crate::issue`.
pub trait CronBoardPort: Send + Sync {
    fn set_cron_of_issue<'a>(&'a self, lookup: CronLookupFn) -> BoxFuture<'a, ()>;
    fn refresh_issue_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, ()>;
    fn issue_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Issue>, ApiError>>;
    fn issues_async(&self) -> BoxFuture<'_, Result<Vec<Issue>, ApiError>>;
    fn sessions_async(&self) -> BoxFuture<'_, Result<Vec<Session>, ApiError>>;
    fn runs_async<'a>(&'a self, issue_id: &'a str) -> BoxFuture<'a, Result<Vec<Run>, ApiError>>;
    fn create_for_cron_async<'a>(
        &'a self,
        title: &'a str,
        description: &'a str,
        repo: Option<PathBuf>,
        agent: &'a str,
        cron_id: &'a str,
    ) -> BoxFuture<'a, Result<Issue, ApiError>>;
    fn move_to_todo_async<'a>(&'a self, id: &'a str, words: Option<&'a str>) -> BoxFuture<'a, Result<(), ApiError>>;
    fn tell_async<'a>(&'a self, id: &'a str, words: &'a str) -> BoxFuture<'a, Result<(), ApiError>>;
}
