//! Agent domain facade consolidating profiles, memory, MCP door/resources,
//! tool registry, and durable orchestrator.

pub mod drive;
pub mod mcp;
pub mod memory;
pub mod orchestrator;
pub mod profile;
pub mod tool;

use std::path::PathBuf;
use std::sync::Arc;

use vibevalley_runtime::agent::ModelClient;
use vibevalley_runtime::agent::extensions::governance::Permissions;

use crate::channel::Chat;
use crate::context::Context;
use crate::cron::Scheduler as CronScheduler;
use crate::issue::{Board, Pull};
use crate::note::Manager as NoteManager;
use crate::repo::Repo;
use crate::runtime::Runtime;
use crate::setting::Setting;
use crate::storage::Storage;

pub use drive::{AgentDriver, instructions};
pub use mcp::{HelperRunMode, Mcp, Resource, ResourceReadArgs, ToolDispatchPort, ToolSpecWire, tool_allowed_in_mode};
pub use memory::{By, FinishedRun, Memory, Note};
pub use orchestrator::{Execution, Input, Orchestrator, Parts as OrchestratorParts, PendingExecution, Reply, RuntimeInboxObserver, Source};
pub use profile::{Profile, ProfileStore, RuntimeFleet};
pub use tool::{Held, Route, RouteSource, Tool, ToolRegistry, Who, held, helper, orchestrator as orchestrator_tools, unrun};

/// Inputs needed to assemble [`Agent`] (`Resource`, `ToolRegistry`, `Mcp`, and `Orchestrator`).
pub struct AgentAssemblyParts {
    pub ctx: Arc<Context>,
    pub setting: Arc<Setting>,
    pub profile: Arc<Profile>,
    pub memory: Arc<Memory>,
    pub channel: Arc<Chat>,
    pub board: Arc<Board>,
    pub runtime: Arc<Runtime>,
    pub repo: Arc<Repo>,
    pub pull: Arc<Pull>,
    pub cron: Arc<CronScheduler>,
    pub note: Arc<NoteManager>,
    pub storage: Arc<Storage>,
    pub pending_execution: PendingExecution,
    pub permissions: Permissions,
    pub home: PathBuf,
    pub version: String,
    pub model_client: Option<Arc<dyn ModelClient>>,
}

/// Unified facade grouping all agent-domain sub-services.
pub struct Agent {
    pub profile: Arc<Profile>,
    pub memory: Arc<Memory>,
    pub mcp: Arc<Mcp>,
    pub resource: Arc<Resource>,
    pub tool: Arc<ToolRegistry>,
    pub orchestrator: Arc<Orchestrator>,
}

impl Agent {
    pub fn new(
        profile: Arc<Profile>,
        memory: Arc<Memory>,
        mcp: Arc<Mcp>,
        resource: Arc<Resource>,
        tool: Arc<ToolRegistry>,
        orchestrator: Arc<Orchestrator>,
    ) -> Arc<Self> {
        Arc::new(Self {
            profile,
            memory,
            mcp,
            resource,
            tool,
            orchestrator,
        })
    }

    /// Assembles `Resource`, `ToolRegistry`, `Mcp`, and `Orchestrator` into a unified [`Agent`] facade.
    pub async fn assemble_async(parts: AgentAssemblyParts) -> Result<Arc<Self>, (&'static str, String)> {
        let resource = Resource::with_pull(parts.ctx.clone(), parts.channel.clone(), parts.runtime.clone(), parts.pull.clone());
        let tool = Arc::new(ToolRegistry {
            ctx: parts.ctx.clone(),
            resource: resource.clone(),
            cron: parts.cron,
            profile: parts.profile.clone(),
            memory: parts.memory.clone(),
            issue: parts.board.clone(),
            runtime: parts.runtime.clone(),
            repo: parts.repo.clone(),
            chat: parts.channel.clone(),
            pull: parts.pull,
            note: parts.note.clone(),
            storage: parts.storage,
            repos_root: parts.repo.root().to_path_buf(),
        });
        let mcp = Mcp::with_home(tool.clone(), parts.version, parts.home.clone());
        let key = parts.setting;
        let orchestrator = Box::pin(Orchestrator::open_async(OrchestratorParts {
            ctx: parts.ctx,
            pending_execution: Some(parts.pending_execution),
            permissions: parts.permissions,
            tool: tool.clone(),
            profile: parts.profile.clone(),
            chat: parts.channel,
            issue: parts.board,
            runtime: parts.runtime,
            repo: parts.repo,
            memory: parts.memory.clone(),
            note: parts.note,
            home: parts.home,
            key: Arc::new(move || key.deepseek_api_key()),
            client: parts.model_client,
        }))
        .await
        .map_err(|e| ("durable execution", e.to_string()))?;
        orchestrator.start_inbox_observer().await.map_err(|e| ("durable projection", e.to_string()))?;
        Ok(Self::new(parts.profile, parts.memory, mcp, resource, tool, orchestrator))
    }

    /// Cooperatively shuts down runtime probes and the orchestrator.
    pub async fn close_async(&self) {
        self.profile.close();
        self.orchestrator.close_async().await;
    }
}
