use std::sync::Arc;

use tokio::sync::mpsc;

use super::accounting::TokenTotals;
use super::specs::runtime_refused_options;
use super::types::{
    AccountUsage, AgentError, Capabilities, ChildTranscriptStep, ContentBlock, ControlAction, ControlOutcome, Event, EventKind, Installation,
    InteractionDecision, ModelInfo, PermissionDecision, PermissionMode, RefusableOption, Result, SessionOptions, SessionStatus, SubagentSnapshot,
    SwarmSnapshot, TurnOptions,
};
use super::voyage;
use crate::BoxFuture;

/// One conversation with a runtime.
pub trait Session: Send + Sync {
    fn id(&self) -> String;
    fn control<'a>(&'a self, action: ControlAction, arg: &'a str, input_id: &'a str, span_id: &'a str) -> BoxFuture<'a, Result<ControlOutcome>>;
    fn control_with<'a>(
        &'a self,
        action: ControlAction,
        arg: &'a str,
        input_id: &'a str,
        span_id: &'a str,
        _opts: TurnOptions,
    ) -> BoxFuture<'a, Result<ControlOutcome>> {
        self.control(action, arg, input_id, span_id)
    }
    fn usage(&self) -> Option<TokenTotals> {
        self.records()
            .iter()
            .rev()
            .filter(|r| r.agent_path.is_empty())
            .flat_map(|r| r.events.iter().rev())
            .find(|e| e["kind"] == "usage")
            .and_then(|e| serde_json::from_value(e["usage"]["tokens"].clone()).ok())
    }
    fn records(&self) -> Vec<voyage::Record>;
    fn subscribe_records(&self, after: Option<u64>) -> mpsc::Receiver<voyage::Record>;
    fn wait(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let mut events = self.events();
            while let Some(e) = events.recv().await {
                if matches!(e.kind, EventKind::SessionEnded) {
                    break;
                }
            }
            Ok(())
        })
    }
    fn resume_id(&self) -> Option<String> {
        Some(self.id())
    }
    /// Resolves the outcome of the specified child turn. Without its turn id,
    /// only thread identity is recoverable.
    fn read_subagent<'a>(&'a self, _thread_id: &'a str, _turn_id: Option<&'a str>) -> BoxFuture<'a, Result<SubagentSnapshot>> {
        Box::pin(async { Err(SubagentSnapshot::unsupported()) })
    }
    /// Snapshot of an active native swarm sidecar (e.g. Antigravity `/swarm`),
    /// or `None` when the session has no swarm.
    fn swarm_snapshot(&self) -> Option<SwarmSnapshot> {
        None
    }
    /// Bounded recent steps from a child agent or swarm member's transcript.
    fn read_child_transcript(&self, _conversation_id: &str, _limit: usize) -> Vec<ChildTranscriptStep> {
        Vec::new()
    }
    /// Real session title reported by the runtime (e.g. ACP `session_info_update`
    /// or Codex `thread/name/updated`), when available.
    fn session_title(&self) -> Option<String> {
        None
    }
    fn runtime_id(&self) -> &str;
    fn status(&self) -> SessionStatus;
    /// A new bounded receiver that yields every event from now on. May be called
    /// several times; slow subscribers are evicted if their buffer fills.
    fn events(&self) -> mpsc::Receiver<Event>;
    /// Starts a turn. Rejected while a turn is running (use `steer`/`queue`).
    fn prompt(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>>;
    fn prompt_with(&self, content: Vec<ContentBlock>, _opts: TurnOptions) -> BoxFuture<'_, Result<()>> {
        self.prompt(content)
    }
    /// Injects a message into the running turn.
    fn steer(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>>;
    /// Runs after the current turn finishes.
    fn queue(&self, content: Vec<ContentBlock>) -> BoxFuture<'_, Result<()>>;
    fn queue_with(&self, content: Vec<ContentBlock>, _opts: TurnOptions) -> BoxFuture<'_, Result<()>> {
        self.queue(content)
    }
    fn abort(&self) -> BoxFuture<'_, Result<()>>;
    fn respond_permission<'a>(&'a self, request_id: &'a str, decision: PermissionDecision) -> BoxFuture<'a, Result<()>>;
    fn respond_interaction<'a>(&'a self, _request_id: &'a str, _decision: InteractionDecision) -> BoxFuture<'a, Result<()>> {
        Box::pin(async {
            Err(AgentError::Unsupported {
                option: "respond_interaction".into(),
                reason: "runtime has no interactive question channel".into(),
            })
        })
    }
    fn set_config<'a>(&'a self, _model: Option<&'a str>, _effort: Option<&'a str>, _permission_mode: Option<PermissionMode>) -> BoxFuture<'a, Result<()>> {
        Box::pin(async {
            Err(AgentError::Unsupported {
                option: "set_config".into(),
                reason: "runtime does not support live config updates".into(),
            })
        })
    }
    /// Stops the underlying process and awaits teardown. The session can still be resumed by id.
    fn dispose(&self) -> BoxFuture<'_, ()>;
    /// Non-blocking signal to begin stopping the underlying process (used by `Drop`).
    fn signal_dispose(&self) {}
    /// Like `events`, but the receiver first yields every event emitted so
    /// far (so a subscriber attached after `open` still sees
    /// `SessionStarted`). Sessions that keep no history fall back to `events`.
    fn events_with_history(&self) -> mpsc::Receiver<Event> {
        self.events()
    }
}

/// One agent backend (Claude Code, Codex, a generic ACP agent, ...).
pub trait Runtime: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn capabilities(&self) -> Capabilities;
    fn refused_options(&self) -> &'static [RefusableOption] {
        runtime_refused_options(self.id())
    }
    /// Probes the local machine asynchronously.
    fn installation(&self) -> BoxFuture<'_, Installation>;
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>>>;
    /// Resolves once the session is ready to accept a prompt.
    fn open(&self, opts: SessionOptions) -> BoxFuture<'_, Result<Arc<dyn Session>>>;
    /// The account's subscription usage.
    fn account_usage(&self) -> BoxFuture<'_, Result<AccountUsage>> {
        Box::pin(async {
            Ok(AccountUsage::Unsupported {
                reason: "capability_unavailable".into(),
            })
        })
    }
    /// User-level MCP server entries configured on the local host for this runtime,
    /// or `Ok(None)` when the runtime does not map to a host MCP config.
    fn list_mcp_servers(&self) -> BoxFuture<'_, Result<Option<Vec<super::mcp_install::HostMcpServer>>>> {
        let host = super::mcp_install::McpHostId::parse(self.id());
        Box::pin(async move {
            let Some(host) = host else {
                return Ok(None);
            };
            tokio::task::spawn_blocking(move || super::mcp_install::list_host_mcp_servers(host))
                .await
                .map_err(|e| AgentError::Io(e.to_string()))?
                .map(Some)
                .map_err(|e| AgentError::Io(e.to_string()))
        })
    }
}

pub(crate) fn find_runtime(runtimes: &[Arc<dyn Runtime>], id: &str) -> Option<Arc<dyn Runtime>> {
    runtimes
        .iter()
        .find(|r| r.id() == id)
        .or_else(|| {
            runtimes
                .iter()
                .find(|r| r.id().strip_prefix("acp:") == Some(id) || id.strip_prefix("acp:") == Some(r.id()))
        })
        .cloned()
}
