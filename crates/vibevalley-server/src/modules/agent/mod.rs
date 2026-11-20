//! `agent.*`, `skill.*` and `runtime.*`: the profiles, their skills and
//! templates, and the runtimes they run on.

use std::path::Path;
use std::sync::Arc;

use vibevalley_oar::Registry;
use vibevalley_protocol::{AgentValidation, RuntimeSettings, ops};

use crate::Hub;
use crate::base::{LookIn, missing};

pub mod drive;
pub mod presets;
pub mod profile;
pub mod runtime;

pub use profile::Profiles;
pub use runtime::Fleet;

/// The agents: their profiles (`config.json`) and the runtimes.
pub struct Agents {
    pub profiles: Arc<Profiles>,
    pub fleet: Arc<Fleet>,
    memories: std::sync::OnceLock<std::sync::Weak<crate::modules::memory::Memories>>,
}

impl Agents {
    /// What the profiles remember: recalled at the start of each round.
    pub fn attach_memories(&self, memories: &Arc<crate::modules::memory::Memories>) {
        let _ = self.memories.set(Arc::downgrade(memories));
    }

    pub(crate) fn memories(&self) -> Option<Arc<crate::modules::memory::Memories>> {
        self.memories.get().and_then(std::sync::Weak::upgrade)
    }

    /// `makeAgent`: the profiles under `home` (a new farm gets the default
    /// orchestrator and the `starters`), the runtimes in `registry`,
    /// probed in the background when `background`.
    pub fn open(hub: &Arc<Hub>, home: &Path, starters: &[String], registry: Arc<Registry>, background: bool) -> std::io::Result<Arc<Agents>> {
        let profiles = Profiles::open(home, starters)?;
        let fleet = Fleet::new(registry, profiles.clone(), hub, background);
        Ok(Arc::new(Agents {
            profiles,
            fleet,
            memories: Default::default(),
        }))
    }
}

fn no_runtime(id: &str) -> vibevalley_protocol::ApiError {
    missing(format!("runtime {id}"), LookIn::Runtime)
}

pub fn install(hub: &Hub, agents: Arc<Agents>) {
    let p = agents.profiles.clone();
    let f = agents.fleet.clone();

    hub.on::<ops::RuntimeList>({
        let f = f.clone();
        move |_, ()| Ok(f.runtimes())
    });
    hub.on::<ops::RuntimeRefresh>({
        let f = f.clone();
        move |_, i| f.refresh(&i.id).ok_or_else(|| no_runtime(&i.id))
    });
    hub.on::<ops::RuntimeSettingUpdate>({
        let f = f.clone();
        move |_, i| {
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
        }
    });

    macro_rules! on {
        ($op:ty, |$p:ident, $i:pat_param| $body:expr) => {{
            let $p = p.clone();
            hub.on::<$op>(move |_, $i| $body);
        }};
    }
    on!(ops::AgentList, |p, ()| Ok(p.all()));
    on!(ops::AgentCreate, |p, a| p.create(a));
    on!(ops::AgentUpdate, |p, a| p.save(a));
    on!(ops::AgentDelete, |p, i| p.remove(&i.id));
    on!(ops::AgentPreviewDelete, |p, i| p.preview_remove(&i.id));
    on!(ops::AgentTemplateList, |p, ()| Ok(p.templates()));
    on!(ops::AgentTemplateInstall, |p, i| p.install_template(&i.id));
    on!(ops::AgentTemplateUpdate, |p, i| p.update_from_template(&i.agent));
    on!(ops::AgentTemplateAdd, |p, i| p.add_template(&i.path));
    on!(ops::AgentTemplateDelete, |p, i| p.remove_template(&i.id));
    on!(ops::AgentTemplatePreviewDelete, |p, i| p.preview_remove_template(&i.id));
    on!(ops::SkillList, |p, ()| Ok(p.skills()));
    on!(ops::SkillCreate, |p, k| p.create_skill(k));
    on!(ops::SkillUpdate, |p, k| p.save_skill(k));
    on!(ops::SkillDelete, |p, i| p.remove_skill(&i.id));
    on!(ops::SkillPreviewDelete, |p, i| p.preview_remove_skill(&i.id));

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
