//! `agent.*`, `skill.*`, and `runtime.*`: agent profiles, skills, templates,
//! and the runtime fleet they execute on.

pub mod drive;
pub mod preset;
#[allow(clippy::module_inception)]
pub mod profile;
pub mod runtime;
pub mod text;

use std::path::Path;
use std::sync::Arc;

use vibevalley_protocol::{
    Agent, AgentRole, AgentTemplate, AgentValidation, ApiError, Installation, PersonaMode, Preview, RuntimeInfo, RuntimeSettings, Skill,
};
use vibevalley_runtime::machine::MachineRegistry;
use vibevalley_runtime::oar::Registry;

use crate::context::Context;
use crate::context::error::{LookIn, missing};
use crate::context::port::CronAgentPort;

pub use drive::{AgentDriver, instructions};
pub use profile::ProfileStore;
pub use runtime::RuntimeFleet;

/// Agent profiles (`config.json`), skills, templates, and the runtime fleet.
pub struct Profile {
    pub store: Arc<ProfileStore>,
    pub fleet: Arc<RuntimeFleet>,
}

impl CronAgentPort for Profile {
    fn resolve_agent_id(&self, named: &str) -> Option<String> {
        self.named(named).map(|a| a.id)
    }
}

impl Profile {
    /// Opens agent profiles under `home` and probes runtimes in `registry` when `background` is set.
    pub async fn open_async(ctx: Arc<Context>, home: &Path, starters: &[String], registry: Arc<Registry>, background: bool) -> std::io::Result<Arc<Profile>> {
        let machines = Arc::new(MachineRegistry::with_local(registry.clone()));
        Self::open_with_machines_async(ctx, home, starters, registry, machines, background).await
    }

    /// Same as [`Self::open_async`], routing execution targets through a shared [`MachineRegistry`].
    pub async fn open_with_machines_async(
        ctx: Arc<Context>,
        home: &Path,
        starters: &[String],
        registry: Arc<Registry>,
        machines: Arc<MachineRegistry>,
        background: bool,
    ) -> std::io::Result<Arc<Profile>> {
        let store = ProfileStore::open_async(home, starters).await?;
        let fleet = RuntimeFleet::new_with_machines(registry, machines, store.clone(), ctx, background);
        Ok(Arc::new(Profile { store, fleet }))
    }

    pub fn close(&self) {
        self.fleet.close();
    }

    pub fn all(&self) -> Vec<Agent> {
        self.store.all()
    }

    pub fn agents(&self) -> Vec<Agent> {
        self.store.agents()
    }

    pub fn orchestrators(&self) -> Vec<Agent> {
        self.store.orchestrators()
    }

    pub fn is_orchestrator(&self, id: &str) -> bool {
        self.store.is_orchestrator(id)
    }

    pub fn agent(&self, id: &str) -> Option<Agent> {
        self.store.agent(id)
    }

    pub fn named(&self, key: &str) -> Option<Agent> {
        self.store.named(key)
    }

    pub fn skills(&self) -> Vec<Skill> {
        self.store.skills()
    }

    pub async fn templates_async(&self) -> Vec<AgentTemplate> {
        self.store.templates_async().await
    }

    pub fn runtimes(&self) -> Vec<RuntimeInfo> {
        self.fleet.runtimes()
    }

    pub async fn runtime_refresh_async(&self, id: &str) -> Result<RuntimeInfo, ApiError> {
        self.fleet.refresh_async(id).await.ok_or_else(|| no_runtime(id))
    }

    pub async fn runtime_setting_update_async(&self, id: &str, settings: RuntimeSettings) -> Result<RuntimeInfo, ApiError> {
        let fleet = self.fleet.clone();
        let id_owned = id.to_string();
        fleet.update_async(&id_owned, settings).await?.ok_or_else(|| no_runtime(id))
    }

    pub(crate) async fn runtime_setting_update_input_async(&self, r: vibevalley_protocol::RuntimeSettingUpdateInput) -> Result<RuntimeInfo, ApiError> {
        self.runtime_setting_update_async(
            &r.id,
            RuntimeSettings {
                enabled: r.enabled,
                bin_path: r.bin_path,
                default_model: r.default_model,
                default_effort: r.default_effort,
                env: r.env,
                daily_budget: r.daily_budget,
                max_working: r.max_working,
            },
        )
        .await
    }

    pub async fn agent_create_async(&self, a: Agent) -> Result<Agent, ApiError> {
        self.store.create_async(a).await
    }

    pub async fn agent_update_async(&self, a: Agent) -> Result<Agent, ApiError> {
        self.store.save_async(a).await
    }

    pub async fn agent_delete_async(&self, id: &str) -> Result<(), ApiError> {
        self.store.remove_async(id).await
    }

    pub fn agent_preview_delete(&self, id: &str) -> Result<Preview, ApiError> {
        self.store.preview_remove(id)
    }

    pub async fn agent_template_install_async(&self, id: &str, runtime: Option<&str>) -> Result<Agent, ApiError> {
        let override_cfg = self
            .store
            .template_of_async(id)
            .await
            .and_then(|item| resolve_install_runtime(&self.fleet, &item, runtime));
        self.store.install_template_with_runtime_async(id, override_cfg).await
    }

    pub async fn agent_template_update_async(&self, agent: &str) -> Result<Agent, ApiError> {
        self.store.update_from_template_async(agent).await
    }

    pub async fn agent_template_add_async(&self, path: &str) -> Result<AgentTemplate, ApiError> {
        self.store.add_template_async(path).await
    }

    pub async fn agent_template_delete_async(&self, id: &str) -> Result<(), ApiError> {
        self.store.remove_template_async(id).await
    }

    pub async fn agent_template_preview_delete_async(&self, id: &str) -> Result<Preview, ApiError> {
        self.store.preview_remove_template_async(id).await
    }

    pub async fn skill_create_async(&self, skill: Skill) -> Result<Skill, ApiError> {
        self.store.create_skill_async(skill).await
    }

    pub async fn skill_update_async(&self, skill: Skill) -> Result<Skill, ApiError> {
        self.store.save_skill_async(skill).await
    }

    pub async fn skill_delete_async(&self, id: &str) -> Result<(), ApiError> {
        self.store.remove_skill_async(id).await
    }

    pub fn skill_preview_delete(&self, id: &str) -> Result<Preview, ApiError> {
        self.store.preview_remove_skill(id)
    }

    pub async fn validate_async(&self, agents: &[Agent]) -> Vec<AgentValidation> {
        let mut out = Vec::with_capacity(agents.len());
        for a in agents {
            out.push(AgentValidation {
                id: a.id.clone(),
                problems: self.fleet.problems_of_async(a).await,
            });
        }
        out
    }
}

fn no_runtime(id: &str) -> ApiError {
    missing(format!("runtime {id}"), LookIn::Runtime)
}

/// Resolves which runtime and persona mode a template install should use:
/// honors an explicit runtime override when given, otherwise keeps the
/// template's runtime when available & enabled, else picks the first
/// available & enabled runtime in the fleet and adjusts `persona_mode` if that
/// runtime refuses system prompts.
fn resolve_install_runtime(fleet: &Arc<RuntimeFleet>, template: &AgentTemplate, requested: Option<&str>) -> Option<(String, PersonaMode)> {
    if template.role == AgentRole::Orchestrator {
        return None;
    }
    let runtimes = fleet.runtimes();
    let is_usable = |r: &RuntimeInfo| r.settings.enabled && matches!(r.installation, Installation::Available(_));
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
        .unwrap_or_else(|| preset::support_of(&runtime).refused);
    let persona_mode = if template.persona_mode != PersonaMode::Prompt && (refused.contains_key("appendSystemPrompt") || refused.contains_key("systemPrompt")) {
        PersonaMode::Prompt
    } else {
        template.persona_mode
    };
    Some((runtime, persona_mode))
}
