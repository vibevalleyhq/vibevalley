//! Who runs an issue's agent: the board asks a `Drivers` to turn the
//! issue's assigned agent into a runtime and its options. Standalone, an
//! agent is a runtime id (`RuntimeDrivers`); the server hands in profiles.

use std::sync::Arc;

use vibevalley_oar::{Installation, Registry, Runtime};
use vibevalley_protocol::Issue;

use crate::{BoardError, Result};

/// Where a profile's persona goes (VibeValley `personaMode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Persona {
    /// Added to the system prompt (`append`).
    System(String),
    /// In place of the runtime's own system prompt (`replace`).
    Replace(String),
    /// Put before the first words of a session (`prompt`).
    Prompt(String),
}

/// What a session on an agent opens with.
pub struct Drive {
    /// The agent as the issue's assignment and the session name it.
    pub agent: String,
    pub runtime: Arc<dyn Runtime>,
    /// The runtime as the session names it (`Session.runtime`).
    pub runtime_id: String,
    /// What the session is called after: `<name> #<n>`.
    pub name: String,
    pub model: Option<String>,
    pub env: Vec<(String, String)>,
    pub persona: Option<Persona>,
    pub effort: Option<String>,
    pub mcp_servers: Vec<vibevalley_oar::McpServer>,
    pub disallowed_tools: Vec<String>,
}

pub trait Drivers: Send + Sync {
    /// Refuses an agent named on an issue that cannot be named.
    fn check(&self, agent: &str) -> Result<()>;
    /// What the agent runs `issue` on now; `None` is nobody assigned.
    fn drive(&self, agent: Option<&str>, issue: &Issue) -> Result<Drive>;
    /// Who drafts `issue` (`refine`); the board assigns it when nobody is.
    fn drafter(&self, issue: &Issue) -> Result<Drive> {
        self.drive(issue.assigned_agent(), issue)
    }
    /// What the agent remembers for a round on `input` (VibeValley
    /// `recallBlock`), set before the input; "" is nothing.
    fn recall(&self, _agent: &str, _session: &str, _repo: &str, _input: &str) -> String {
        String::new()
    }
}

/// An agent is a runtime id; nobody assigned runs `claude`.
pub struct RuntimeDrivers {
    pub registry: Arc<Registry>,
    pub model: Option<String>,
}

impl Drivers for RuntimeDrivers {
    fn check(&self, agent: &str) -> Result<()> {
        self.registry.require(agent).map(|_| ()).map_err(BoardError::from)
    }

    fn drive(&self, agent: Option<&str>, _issue: &Issue) -> Result<Drive> {
        let agent = agent.filter(|a| !a.trim().is_empty()).unwrap_or("claude");
        let runtime = self.registry.require(agent)?;
        match runtime.installation() {
            Installation::Available { .. } => {}
            Installation::NotInstalled => return Err(BoardError::Other(format!("{agent} is not installed"))),
            Installation::Unusable { reason } => return Err(BoardError::Other(format!("{agent} cannot be used: {reason}"))),
        }
        Ok(Drive {
            agent: agent.to_string(),
            runtime_id: runtime.id().to_string(),
            name: runtime.display_name().to_string(),
            runtime,
            model: self.model.clone(),
            env: vec![],
            persona: None,
            effort: None,
            mcp_servers: vec![],
            disallowed_tools: vec![],
        })
    }
}
