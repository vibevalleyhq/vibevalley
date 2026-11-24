//! `agent.*`, `skill.*` and `runtime.*`: the profiles, their skills and
//! templates, and the runtimes they run on.

use std::path::Path;
use std::sync::Arc;

use vibevalley_protocol::{
    Agent, AgentRole, AgentTemplate, AgentValidation, ApiError, BizCode, Installation, PersonaMode, RuntimeInfo, RuntimeSettings, Skill,
};
use vibevalley_runtime::machine::MachineRegistry;
use vibevalley_runtime::oar::Registry;

use crate::app::live::LiveOverlay;
use crate::app::refusal::{LookIn, missing};
use crate::app::runtime::Runtime;

pub mod drive;
pub mod presets;
pub mod profile;
pub mod runtime;

pub use drive::instructions;
pub use profile::Profiles;
pub use runtime::RuntimeFleet;

/// The agents: their profiles (`config.json`) and the runtimes.
pub struct AgentStore {
    pub profiles: Arc<Profiles>,
    pub fleet: Arc<RuntimeFleet>,
}

impl AgentStore {
    /// `makeAgent`: the profiles under `home` (a new farm gets the default
    /// orchestrator and the `starters`), the runtimes in `registry`,
    /// probed in the background when `background`.
    pub fn open(
        runtime: &Arc<Runtime>,
        live: Arc<LiveOverlay>,
        home: &Path,
        starters: &[String],
        registry: Arc<Registry>,
        background: bool,
    ) -> std::io::Result<Arc<AgentStore>> {
        let machines = Arc::new(MachineRegistry::with_local(registry.clone()));
        Self::open_with_machines(runtime, live, home, starters, registry, machines, background)
    }

    /// `open`, routing execution targets through a shared `MachineRegistry`.
    pub fn open_with_machines(
        runtime: &Arc<Runtime>,
        live: Arc<LiveOverlay>,
        home: &Path,
        starters: &[String],
        registry: Arc<Registry>,
        machines: Arc<MachineRegistry>,
        background: bool,
    ) -> std::io::Result<Arc<AgentStore>> {
        let profiles = Profiles::open(home, starters)?;
        let fleet = RuntimeFleet::new_with_machines(registry, machines, profiles.clone(), runtime, live, background);
        Ok(Arc::new(AgentStore { profiles, fleet }))
    }

    pub async fn runtime_refresh_async(&self, id: &str) -> Result<RuntimeInfo, ApiError> {
        self.fleet.refresh_async(id).await.ok_or_else(|| no_runtime(id))
    }

    pub async fn runtime_setting_update_async(&self, id: &str, settings: RuntimeSettings) -> Result<RuntimeInfo, ApiError> {
        let fleet = self.fleet.clone();
        let id_owned = id.to_string();
        fleet
            .update_async(&id_owned, settings)
            .await?
            .ok_or_else(|| no_runtime(id))
    }

    pub async fn agent_create_async(&self, a: Agent) -> Result<Agent, ApiError> {
        let p = self.profiles.clone();
        run_blocking(move || p.create(a)).await
    }

    pub async fn agent_update_async(&self, a: Agent) -> Result<Agent, ApiError> {
        let p = self.profiles.clone();
        run_blocking(move || p.save(a)).await
    }

    pub async fn agent_delete_async(&self, id: &str) -> Result<(), ApiError> {
        let p = self.profiles.clone();
        let id = id.to_string();
        run_blocking(move || p.remove(&id)).await
    }

    pub async fn agent_preview_delete_async(&self, id: &str) -> Result<vibevalley_protocol::Preview, ApiError> {
        let p = self.profiles.clone();
        let id = id.to_string();
        run_blocking(move || p.preview_remove(&id)).await
    }

    pub async fn agent_template_install_async(&self, id: &str, runtime: Option<&str>) -> Result<Agent, ApiError> {
        let p = self.profiles.clone();
        let f = self.fleet.clone();
        let id = id.to_string();
        let runtime = runtime.map(str::to_string);
        run_blocking(move || {
            let override_cfg = p.template_of(&id).and_then(|item| resolve_install_runtime(&f, &item, runtime.as_deref()));
            p.install_template_with_runtime(&id, override_cfg)
        })
        .await
    }

    pub async fn agent_template_update_async(&self, agent: &str) -> Result<Agent, ApiError> {
        let p = self.profiles.clone();
        let agent = agent.to_string();
        run_blocking(move || p.update_from_template(&agent)).await
    }

    pub async fn agent_template_add_async(&self, path: &str) -> Result<AgentTemplate, ApiError> {
        let p = self.profiles.clone();
        let path = path.to_string();
        run_blocking(move || p.add_template(&path)).await
    }

    pub async fn agent_template_delete_async(&self, id: &str) -> Result<(), ApiError> {
        let p = self.profiles.clone();
        let id = id.to_string();
        run_blocking(move || p.remove_template(&id)).await
    }

    pub async fn agent_template_preview_delete_async(&self, id: &str) -> Result<vibevalley_protocol::Preview, ApiError> {
        let p = self.profiles.clone();
        let id = id.to_string();
        run_blocking(move || p.preview_remove_template(&id)).await
    }

    pub async fn skill_create_async(&self, skill: Skill) -> Result<Skill, ApiError> {
        let p = self.profiles.clone();
        run_blocking(move || p.create_skill(skill)).await
    }

    pub async fn skill_update_async(&self, skill: Skill) -> Result<Skill, ApiError> {
        let p = self.profiles.clone();
        run_blocking(move || p.save_skill(skill)).await
    }

    pub async fn skill_delete_async(&self, id: &str) -> Result<(), ApiError> {
        let p = self.profiles.clone();
        let id = id.to_string();
        run_blocking(move || p.remove_skill(&id)).await
    }

    pub async fn skill_preview_delete_async(&self, id: &str) -> Result<vibevalley_protocol::Preview, ApiError> {
        let p = self.profiles.clone();
        let id = id.to_string();
        run_blocking(move || p.preview_remove_skill(&id)).await
    }

    pub fn validate(&self, agents: &[Agent]) -> Vec<AgentValidation> {
        agents
            .iter()
            .map(|a| AgentValidation {
                id: a.id.clone(),
                problems: self.fleet.problems_of(a),
            })
            .collect()
    }
}

async fn run_blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, ApiError> {
    crate::spawn_blocking_traced(work)
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
}

fn no_runtime(id: &str) -> vibevalley_protocol::ApiError {
    missing(format!("runtime {id}"), LookIn::Runtime)
}

/// Resolves which runtime and persona mode a template install should use:
/// honors an explicit runtime override when given, otherwise keeps the
/// template's runtime when available & enabled, else picks the first
/// available & enabled runtime in the fleet and adjusts `persona_mode` if that
/// runtime refuses system prompts.
fn resolve_install_runtime(fleet: &Arc<RuntimeFleet>, template: &vibevalley_protocol::AgentTemplate, requested: Option<&str>) -> Option<(String, PersonaMode)> {
    if template.role == AgentRole::Orchestrator {
        return None;
    }
    let runtimes = fleet.runtimes();
    let is_usable = |r: &vibevalley_protocol::RuntimeInfo| r.settings.enabled && matches!(r.installation, Installation::Available(_));
    let runtime = requested.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| {
        if runtimes.iter().any(|r| r.id == template.runtime && is_usable(r)) {
            template.runtime.clone()
        } else {
            runtimes
                .iter()
                .find(|r| is_usable(r))
                .map(|r| r.id.clone())
                .unwrap_or_else(|| template.runtime.clone())
        }
    });
    let refused = runtimes
        .iter()
        .find(|r| r.id == runtime)
        .map(|r| r.support.refused.clone())
        .unwrap_or_else(|| presets::support_of(&runtime).refused);
    let persona_mode = if template.persona_mode != PersonaMode::Prompt && (refused.contains_key("appendSystemPrompt") || refused.contains_key("systemPrompt")) {
        PersonaMode::Prompt
    } else {
        template.persona_mode
    };
    Some((runtime, persona_mode))
}
