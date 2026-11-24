//! `agent.*`, `skill.*` and `runtime.*`: the profiles, their skills and
//! templates, and the runtimes they run on.

use std::path::Path;
use std::sync::Arc;

use vibevalley_protocol::{AgentRole, AgentValidation, ApiError, BizCode, Installation, PersonaMode, RuntimeSettings, ops};
use vibevalley_runtime::machine::MachineRegistry;
use vibevalley_runtime::oar::Registry;

use crate::Hub;
use crate::app::hub::refusal::{LookIn, missing};

pub mod drive;
pub mod presets;
pub mod profile;
pub mod runtime;

pub use drive::instructions;
pub use profile::Profiles;
pub use runtime::Fleet;

/// The agents: their profiles (`config.json`) and the runtimes.
pub struct Agents {
    pub profiles: Arc<Profiles>,
    pub fleet: Arc<Fleet>,
}

impl Agents {
    /// `makeAgent`: the profiles under `home` (a new farm gets the default
    /// orchestrator and the `starters`), the runtimes in `registry`,
    /// probed in the background when `background`.
    pub fn open(hub: &Arc<Hub>, home: &Path, starters: &[String], registry: Arc<Registry>, background: bool) -> std::io::Result<Arc<Agents>> {
        let machines = Arc::new(MachineRegistry::with_local(registry.clone()));
        Self::open_with_machines(hub, home, starters, registry, machines, background)
    }

    /// `open`, routing execution targets through a shared `MachineRegistry`.
    pub fn open_with_machines(
        hub: &Arc<Hub>,
        home: &Path,
        starters: &[String],
        registry: Arc<Registry>,
        machines: Arc<MachineRegistry>,
        background: bool,
    ) -> std::io::Result<Arc<Agents>> {
        let profiles = Profiles::open(home, starters)?;
        let fleet = Fleet::new_with_machines(registry, machines, profiles.clone(), hub, background);
        Ok(Arc::new(Agents { profiles, fleet }))
    }
}

fn no_runtime(id: &str) -> vibevalley_protocol::ApiError {
    missing(format!("runtime {id}"), LookIn::Runtime)
}

/// Resolves which runtime and persona mode a template install should use:
/// honors an explicit runtime override when given, otherwise keeps the
/// template's runtime when available & enabled, else picks the first
/// available & enabled runtime in the fleet and adjusts `persona_mode` if that
/// runtime refuses system prompts.
fn resolve_install_runtime(fleet: &Arc<Fleet>, template: &vibevalley_protocol::AgentTemplate, requested: Option<&str>) -> Option<(String, PersonaMode)> {
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

pub fn install(hub: &Hub, agents: Arc<Agents>) {
    let p = agents.profiles.clone();
    let f = agents.fleet.clone();

    hub.on::<ops::RuntimeList>({
        let f = f.clone();
        move |_, ()| Ok(f.runtimes())
    });
    hub.on_async::<ops::RuntimeRefresh, _, _>({
        let f = f.clone();
        move |_, i| {
            let f = f.clone();
            async move { f.refresh_async(&i.id).await.ok_or_else(|| no_runtime(&i.id)) }
        }
    });
    hub.on_async::<ops::RuntimeSettingUpdate, _, _>({
        let f = f.clone();
        move |_, i| {
            let f = f.clone();
            async move {
                crate::spawn_blocking_traced(move || {
                    let settings = RuntimeSettings {
                        enabled: i.enabled,
                        bin_path: i.bin_path,
                        default_model: i.default_model,
                        default_effort: i.default_effort,
                        env: i.env,
                        daily_budget: i.daily_budget,
                        max_working: i.max_working,
                    };
                    f.update(&i.id, settings)?.ok_or_else(|| no_runtime(&i.id))
                })
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
            }
        }
    });

    macro_rules! on_blocking {
        ($op:ty, |$p:ident, $i:pat_param| $body:expr) => {{
            let $p = p.clone();
            hub.on_async::<$op, _, _>(move |_, $i| {
                let $p = $p.clone();
                async move {
                    crate::spawn_blocking_traced(move || $body)
                        .await
                        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
                }
            });
        }};
    }
    hub.on::<ops::AgentList>({
        let p = p.clone();
        move |_, ()| Ok(p.all())
    });
    on_blocking!(ops::AgentCreate, |p, a| p.create(a));
    on_blocking!(ops::AgentUpdate, |p, a| p.save(a));
    on_blocking!(ops::AgentDelete, |p, i| p.remove(&i.id));
    on_blocking!(ops::AgentPreviewDelete, |p, i| p.preview_remove(&i.id));
    hub.on::<ops::AgentTemplateList>({
        let p = p.clone();
        move |_, ()| Ok(p.templates())
    });
    hub.on_async::<ops::AgentTemplateInstall, _, _>({
        let p = p.clone();
        let f = f.clone();
        move |_, i| {
            let p = p.clone();
            let f = f.clone();
            async move {
                crate::spawn_blocking_traced(move || {
                    let override_cfg = p.template_of(&i.id).and_then(|item| resolve_install_runtime(&f, &item, i.runtime.as_deref()));
                    p.install_template_with_runtime(&i.id, override_cfg)
                })
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
            }
        }
    });
    on_blocking!(ops::AgentTemplateUpdate, |p, i| p.update_from_template(&i.agent));
    on_blocking!(ops::AgentTemplateAdd, |p, i| p.add_template(&i.path));
    on_blocking!(ops::AgentTemplateDelete, |p, i| p.remove_template(&i.id));
    on_blocking!(ops::AgentTemplatePreviewDelete, |p, i| p.preview_remove_template(&i.id));
    hub.on::<ops::SkillList>({
        let p = p.clone();
        move |_, ()| Ok(p.skills())
    });
    on_blocking!(ops::SkillCreate, |p, k| p.create_skill(k));
    on_blocking!(ops::SkillUpdate, |p, k| p.save_skill(k));
    on_blocking!(ops::SkillDelete, |p, i| p.remove_skill(&i.id));
    on_blocking!(ops::SkillPreviewDelete, |p, i| p.preview_remove_skill(&i.id));

    hub.on::<ops::AgentValidate>(move |_, body| {
        Ok(body
            .agents
            .iter()
            .map(|a| AgentValidation {
                id: a.id.clone(),
                problems: f.problems_of(a),
            })
            .collect())
    });
}
