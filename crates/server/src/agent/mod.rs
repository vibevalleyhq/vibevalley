//! Agent domain facade consolidating profiles, memory, MCP door/resources,
//! tool registry, and durable orchestrator.

pub mod mcp;
pub mod memory;
pub mod orchestrator;
pub mod profile;
pub mod tool;

use std::sync::Arc;

pub use mcp::{Mcp, Resource, ResourceReadArgs, ToolDispatchPort, ToolSpecWire};
pub use memory::{By, FinishedRun, Memory, Note};
pub use orchestrator::{Execution, Input, Orchestrator, Parts as OrchestratorParts, PendingExecution, Reply, RuntimeInboxObserver};
pub use profile::{AgentDriver, Profile, ProfileStore, RuntimeFleet, instructions};
pub use tool::{Held, Route, Tool, ToolRegistry, Who, held, helper, orchestrator as orchestrator_tools, unrun};

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

    /// Cooperatively shuts down runtime probes and the orchestrator.
    pub async fn close_async(&self) {
        self.profile.close();
        self.orchestrator.close_async().await;
    }
}
