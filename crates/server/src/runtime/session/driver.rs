//! Who runs an issue's agent: the runtime asks a [`SessionDriver`] to turn an
//! assigned agent into an OAR runtime and its options. Standalone, an agent is
//! a runtime id ([`RuntimeDriver`]); the server injects profile-backed drivers
//! from `crate::agent` without creating any compile-time dependency on `agent/`.

use std::sync::Arc;

use vibevalley_protocol::{Deliverable, Issue, LOCAL_MACHINE_ID};
use vibevalley_runtime::oar::{Installation, Registry, Runtime};

use crate::BoxFuture;
use crate::runtime::{Result, RuntimeError};

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

/// Lightweight profile metadata exposed by [`SessionDriver::profile_info`] so
/// `runtime/` and `issue/` never import `crate::agent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfileInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub is_orchestrator: bool,
}

/// What a session on an agent opens with.
pub struct Drive {
    /// The agent as the issue's assignment and the session name it.
    pub agent: String,
    pub runtime: Arc<dyn Runtime>,
    /// The runtime as the session names it (`Session.runtime`).
    pub runtime_id: String,
    /// Execution machine id (`"local"` or remote/sandbox machine id).
    pub machine_id: String,
    /// True when executing in-process on the control plane host.
    pub is_local: bool,
    /// What the session is called after: `<name> #<n>`.
    pub name: String,
    pub model: Option<String>,
    pub env: Vec<(String, String)>,
    pub persona: Option<Persona>,
    pub effort: Option<String>,
    pub mcp_servers: Vec<vibevalley_runtime::oar::McpServer>,
    pub disallowed_tools: Vec<String>,
}

impl Drive {
    pub(super) fn work_instructions(&self, rules: String, prompt: String) -> (Option<String>, String) {
        match self.runtime.id() {
            "kimi" | "codebuddy" => (None, format!("{rules}\n\n---\n\n{prompt}")),
            _ => (Some(rules), prompt),
        }
    }
}

pub trait SessionDriver: Send + Sync {
    /// Refuses an agent named on an issue that cannot be named.
    fn check(&self, agent: &str) -> Result<()>;

    /// What the agent runs `issue` on now; `None` is nobody assigned.
    fn drive<'a>(&'a self, agent: Option<&'a str>, issue: &'a Issue) -> BoxFuture<'a, Result<Drive>>;

    /// What a direct workspace session opens on, named by runtime id.
    fn drive_runtime<'a>(&'a self, runtime: &'a str, model: Option<&'a str>, effort: Option<&'a str>) -> BoxFuture<'a, Result<Drive>>;

    /// Who drafts `issue` (`refine`); the board assigns it when nobody is.
    fn drafter<'a>(&'a self, issue: &'a Issue) -> BoxFuture<'a, Result<Drive>> {
        self.drive(issue.assigned_agent(), issue)
    }

    /// Normalizes a user-provided agent name or id into its canonical profile key.
    fn resolve_agent_key(&self, agent: &str) -> String {
        agent.trim().to_string()
    }

    /// Looks up lightweight profile metadata without importing `crate::agent`.
    fn profile_info(&self, _id: &str) -> Option<AgentProfileInfo> {
        None
    }

    /// What the agent remembers for a round on `input`, set before the input; `""` is nothing.
    fn recall<'a>(&'a self, _agent: &'a str, _session: &'a str, _repo: &'a str, _input: &'a str) -> BoxFuture<'a, String> {
        Box::pin(async { String::new() })
    }

    /// The rules a helper works an issue by (its appended system prompt).
    fn rules(&self, _place: &HelperPlace, deliver: Deliverable) -> String {
        super::report::instructions(deliver)
    }

    /// The rules a helper talks by in a channel, with no issue.
    fn talk_rules(&self, cwd: &str, channel: &str, id: &str) -> String {
        format!(
            "You are @{id}, talking with the user in {channel}. Your own folder is {cwd}; write files only there. Your last answer of a round is posted in the channel."
        )
    }
}

/// Where a helper works an issue, for its rules.
pub struct HelperPlace {
    pub repo: String,
    /// None: the repo's own folder, no branch of its own.
    pub branch: Option<String>,
    pub cwd: String,
    /// The helper's own id (`@w3`).
    pub id: String,
    pub pull_request: bool,
    /// The work root's AGENTS.md: rules for every repo on this machine.
    pub house: String,
}

/// An agent is a runtime id; nobody assigned runs `claude`.
pub struct RuntimeDriver {
    pub registry: Arc<Registry>,
    pub model: Option<String>,
}

impl SessionDriver for RuntimeDriver {
    fn check(&self, agent: &str) -> Result<()> {
        self.registry.require(agent).map(|_| ()).map_err(RuntimeError::from)
    }

    fn drive<'a>(&'a self, agent: Option<&'a str>, _issue: &'a Issue) -> BoxFuture<'a, Result<Drive>> {
        let agent = agent.filter(|a| !a.trim().is_empty()).unwrap_or("claude");
        self.drive_runtime(agent, None, None)
    }

    fn drive_runtime<'a>(&'a self, runtime_id: &'a str, model: Option<&'a str>, effort: Option<&'a str>) -> BoxFuture<'a, Result<Drive>> {
        Box::pin(async move {
            let runtime_id = runtime_id.trim();
            let runtime = self.registry.require(runtime_id)?;
            match runtime.installation().await {
                Installation::Available { .. } => {}
                Installation::LoginRequired { .. } => return Err(RuntimeError::Other(format!("{runtime_id} requires a local sign-in"))),
                Installation::NotInstalled => return Err(RuntimeError::Other(format!("{runtime_id} is not installed"))),
                Installation::Unusable { reason } => return Err(RuntimeError::Other(format!("{runtime_id} cannot be used: {reason}"))),
            }
            let wire_id = runtime.id().strip_prefix("acp:").unwrap_or(runtime.id()).to_string();
            Ok(Drive {
                agent: wire_id.clone(),
                runtime_id: wire_id,
                machine_id: LOCAL_MACHINE_ID.to_string(),
                is_local: true,
                name: runtime.display_name().to_string(),
                runtime,
                model: model.map(str::trim).filter(|m| !m.is_empty()).map(String::from).or_else(|| self.model.clone()),
                env: vec![],
                persona: None,
                effort: effort.map(str::trim).filter(|e| !e.is_empty()).map(String::from),
                mcp_servers: vec![],
                disallowed_tools: vec![],
            })
        })
    }
}
