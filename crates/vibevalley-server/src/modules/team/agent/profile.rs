//! The profiles, skills and runtime settings kept in `<home>/config.json`,
//! and the templates profiles are installed from (built in, and added under
//! `<home>/agent-templates`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    Agent, AgentFrom, AgentRole, AgentTemplate, AgentTemplateSource, ApiError, BizCode, Build, DEFAULT_ORCHESTRATOR, Head, Look, ORCHESTRATOR_RUNTIME,
    OrchestratorLook, Outfit, PersonaMode, Preview, RuntimeSettings, Skill, Species, TemplateCategory,
};

use super::presets::default_settings;
use crate::base::{LookIn, missing};
use crate::lock;

static BUILT_IN: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/assets/agent");

/// The files a template is made of: nothing else in its folder is read or
/// copied.
const TEMPLATE_FILES: [&str; 4] = ["agent.json", "agent.en.json", "persona.md", "persona.en.md"];

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::AgentRefused, text)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    agents: Vec<Agent>,
    skills: Vec<Skill>,
    settings: BTreeMap<String, RuntimeSettings>,
}

/// `castHash`: each code point's leading UTF-16 unit, as the client picks
/// an animal.
fn cast_hash(s: &str) -> u32 {
    s.chars().fold(0u32, |h, ch| {
        let mut units = [0u16; 2];
        let unit = ch.encode_utf16(&mut units)[0];
        h.wrapping_mul(31).wrapping_add(unit as u32)
    })
}

pub fn with_cast(mut a: Agent) -> Agent {
    let look = &mut a.look;
    if look.species.is_none() {
        look.species = Some(Species::ALL[(cast_hash(&a.id) as usize) % Species::ALL.len()]);
    }
    if look.outfit.is_none() {
        look.outfit = Some(Outfit::Farmer);
    }
    look.orchestrator = if a.role == AgentRole::Orchestrator {
        Some(look.orchestrator.unwrap_or(OrchestratorLook::Farmer))
    } else {
        None
    };
    a
}

/// A profile's look written before `build` and `head` existed is filled in.
fn look_filled(mut raw: Value) -> Value {
    if let Some(look) = raw.get_mut("look").and_then(Value::as_object_mut) {
        for key in ["species", "outfit", "orchestrator"] {
            look.entry(key).or_insert(Value::Null);
        }
        if look.get("build").is_none_or(Value::is_null) {
            look.insert("build".into(), "biped".into());
        }
        if look.get("head").is_none_or(Value::is_null) {
            look.insert("head".into(), "rounded".into());
        }
    }
    raw
}

fn read_stored(text: &str) -> Result<Stored, String> {
    #[derive(Deserialize)]
    struct File {
        agents: Vec<Value>,
        skills: Vec<Skill>,
        settings: BTreeMap<String, RuntimeSettings>,
    }
    let file: File = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let agents = file
        .agents
        .into_iter()
        .map(|a| crate::decode::<Agent>(look_filled(a)).map_err(|e| e.message))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Stored {
        agents,
        skills: file.skills,
        settings: file.settings,
    })
}

#[derive(Deserialize, Default)]
struct LookFile {
    species: Option<Species>,
    outfit: Option<Outfit>,
    orchestrator: Option<OrchestratorLook>,
    build: Option<Build>,
    head: Option<Head>,
    body: Option<String>,
    trim: Option<String>,
    hat: Option<String>,
    eye: Option<String>,
    avatar: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateFile {
    id: String,
    version: i64,
    role: AgentRole,
    name: String,
    duty: Option<String>,
    category: Option<TemplateCategory>,
    style: Option<String>,
    tags: Option<Vec<String>>,
    runtime: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    persona_mode: Option<PersonaMode>,
    worktree: Option<bool>,
    look: Option<LookFile>,
    skills: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct WordsFile {
    name: Option<String>,
    duty: Option<String>,
    style: Option<String>,
    tags: Option<Vec<String>>,
}

/// Lowercase letters, digits and -, at most 32, not starting with -.
fn good_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn unreadable(path: &str, why: impl std::fmt::Display) -> String {
    t("server.agent.template.unreadable", &[("file", path.into()), ("why", why.to_string().into())])
}

fn read_json<A: serde::de::DeserializeOwned>(text_of: &dyn Fn(&str) -> Option<String>, dir: &str, file: &str) -> Result<Option<A>, String> {
    let path = format!("{dir}/{file}");
    let Some(text) = text_of(&path) else { return Ok(None) };
    let raw: Value = serde_json::from_str(&text).map_err(|e| unreadable(&path, e))?;
    crate::decode::<A>(raw).map(Some).map_err(|e| unreadable(&path, e.message))
}

/// `templateFrom`: a template folder read in the farm's language (English
/// falls back to the Chinese file by file). `Err` is why it is not one.
fn template_from(text_of: &dyn Fn(&str) -> Option<String>, dir: &str, source: AgentTemplateSource) -> Result<AgentTemplate, String> {
    let agent_json = format!("{dir}/agent.json");
    let item: TemplateFile = read_json(text_of, dir, "agent.json")?.ok_or_else(|| t("server.agent.template.noFile", &[("file", agent_json.clone().into())]))?;
    if !good_id(&item.id) {
        return Err(t("server.agent.template.badId", &[("file", agent_json.into()), ("id", item.id.into())]));
    }
    if item.version < 1 {
        return Err(t("server.agent.template.badVersion", &[("file", agent_json.into())]));
    }
    if item.role == AgentRole::Orchestrator && item.runtime.as_deref().is_some_and(|r| r != ORCHESTRATOR_RUNTIME) {
        return Err(t("server.agent.orchestratorRuntime", &[("runtime", ORCHESTRATOR_RUNTIME.into())]));
    }
    if item.role == AgentRole::Worker && item.runtime.as_deref().unwrap_or("").is_empty() {
        return Err(t("server.agent.template.noRuntime", &[("file", agent_json.into())]));
    }
    let en = vibevalley_i18n::locale() == "en";
    let words: Option<WordsFile> = if en { read_json(text_of, dir, "agent.en.json")? } else { None };
    let text = |file: &str| text_of(&format!("{dir}/{file}")).map(|s| s.trim().to_string());
    let persona = (if en { text("persona.en.md") } else { None })
        .or_else(|| text("persona.md"))
        .unwrap_or_default();
    let look = item.look.unwrap_or_default();
    let words = words.unwrap_or(WordsFile {
        name: None,
        duty: None,
        style: None,
        tags: None,
    });
    let style = words.style.or(item.style).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(AgentTemplate {
        id: item.id,
        version: item.version,
        role: item.role,
        name: words.name.unwrap_or(item.name),
        duty: words.duty.or(item.duty).unwrap_or_default(),
        tags: words.tags.or(item.tags).unwrap_or_default(),
        runtime: if item.role == AgentRole::Orchestrator {
            ORCHESTRATOR_RUNTIME.into()
        } else {
            item.runtime.unwrap_or_else(|| ORCHESTRATOR_RUNTIME.into())
        },
        model: item.model.unwrap_or_default(),
        effort: item.effort.unwrap_or_default(),
        persona_mode: item.persona_mode.unwrap_or(PersonaMode::Append),
        worktree: item.worktree.unwrap_or(item.role == AgentRole::Worker),
        look: Look {
            species: look.species,
            outfit: look.outfit,
            orchestrator: look.orchestrator,
            build: look.build.unwrap_or(Build::Biped),
            head: look.head.unwrap_or(Head::Rounded),
            body: look.body.unwrap_or_default(),
            trim: look.trim.unwrap_or_default(),
            hat: look.hat.unwrap_or_default(),
            eye: look.eye.unwrap_or_default(),
            avatar: look.avatar.filter(|s| !s.is_empty()),
        },
        persona,
        source,
        category: item.category,
        style,
        skills: item.skills.unwrap_or_default(),
        installed: vec![],
    })
}

/// A template folder on disk; a missing file is none, one that cannot be
/// read is why it is not a template.
fn read_template(dir: &Path, source: AgentTemplateSource) -> Result<AgentTemplate, String> {
    let mut texts = BTreeMap::new();
    let dir_text = dir.to_string_lossy().into_owned();
    for f in TEMPLATE_FILES {
        let path = dir.join(f);
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                texts.insert(format!("{dir_text}/{f}"), text);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(unreadable(&path.to_string_lossy(), e)),
        }
    }
    template_from(&|p| texts.get(p).cloned(), &dir_text, source)
}

/// The ids of the built-in templates, in the order they are listed.
fn built_in_ids() -> Vec<String> {
    let index = BUILT_IN.get_file("templates/index.json").and_then(|f| f.contents_utf8()).unwrap_or("[]");
    serde_json::from_str(index).unwrap_or_default()
}

pub fn built_in_templates() -> Vec<AgentTemplate> {
    let text_of = |p: &str| BUILT_IN.get_file(p).and_then(|f| f.contents_utf8()).map(str::to_string);
    built_in_ids()
        .iter()
        .map(|id| template_from(&text_of, &format!("templates/{id}"), AgentTemplateSource::BuiltIn).expect("a built-in template reads"))
        .collect()
}

pub fn built_in_skills() -> Vec<Skill> {
    let en = vibevalley_i18n::locale() == "en";
    let Some(dir) = BUILT_IN.get_dir("skills") else { return vec![] };
    let mut ids: Vec<String> = dir
        .dirs()
        .filter_map(|d| d.path().file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    ids.sort();
    ids.into_iter()
        .filter_map(|id| {
            let read = |f: &str| BUILT_IN.get_file(format!("skills/{id}/{f}")).and_then(|f| f.contents_utf8());
            let text = (if en { read("SKILL.en.md") } else { None }).or_else(|| read("SKILL.md"))?;
            let head = vibevalley_agent::resources::skills::front_matter(text);
            Some(Skill {
                name: head.get("name").cloned().unwrap_or_else(|| id.clone()),
                description: head.get("description").cloned().unwrap_or_default(),
                body: vibevalley_agent::resources::skills::skill_body(text),
                built_in: Some(true),
                id,
            })
        })
        .collect()
}

fn added_dir(home: &Path) -> PathBuf {
    home.join("agent-templates")
}

/// The templates added on this machine; a folder that no longer reads is
/// left out.
fn added_templates(home: &Path) -> Vec<AgentTemplate> {
    let Ok(entries) = std::fs::read_dir(added_dir(home)) else { return vec![] };
    let mut names: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    names.sort();
    names.iter().filter_map(|dir| read_template(dir, AgentTemplateSource::Added).ok()).collect()
}

fn copy_template(from: &Path, home: &Path, id: &str) -> std::io::Result<()> {
    let to = added_dir(home).join(id);
    std::fs::create_dir_all(&to)?;
    for f in TEMPLATE_FILES {
        match std::fs::copy(from.join(f), to.join(f)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// A new profile from a template, under the id and name given.
fn profile_of(item: &AgentTemplate, id: String, name: String) -> Agent {
    Agent {
        id,
        name,
        role: item.role,
        duty: item.duty.clone(),
        enabled: true,
        runtime: item.runtime.clone(),
        model: item.model.clone(),
        effort: item.effort.clone(),
        persona: item.persona.clone(),
        persona_mode: item.persona_mode,
        skills: item.skills.clone(),
        mcp_servers: vec![],
        disallowed_tools: vec![],
        env: BTreeMap::new(),
        workdir: String::new(),
        worktree: item.worktree,
        tags: item.tags.clone(),
        look: item.look.clone(),
        from: Some(AgentFrom {
            template: item.id.clone(),
            version: item.version,
        }),
    }
}

/// A profile made again from its template's version now: the template's
/// words of the work are replaced, the user's own skill ticks stay.
fn updated_from(item: &AgentTemplate, a: &Agent) -> Agent {
    let mut skills = a.skills.clone();
    for s in &item.skills {
        if !skills.contains(s) {
            skills.push(s.clone());
        }
    }
    let mut look = a.look.clone();
    if look.avatar.is_none() {
        look.avatar = item.look.avatar.clone();
    }
    Agent {
        duty: item.duty.clone(),
        tags: item.tags.clone(),
        persona: item.persona.clone(),
        persona_mode: item.persona_mode,
        worktree: item.worktree,
        look,
        skills,
        from: Some(AgentFrom {
            template: item.id.clone(),
            version: item.version,
        }),
        ..a.clone()
    }
}

fn free(want: &str, taken: &[&str], join: &str) -> String {
    if !taken.contains(&want) {
        return want.into();
    }
    (2..)
        .map(|n| format!("{want}{join}{n}"))
        .find(|c| !taken.contains(&c.as_str()))
        .expect("a free name")
}

fn installed(template: &AgentTemplate, beside: &[Agent], id: Option<&str>) -> Agent {
    let ids: Vec<&str> = beside.iter().map(|a| a.id.as_str()).collect();
    let names: Vec<&str> = beside.iter().map(|a| a.name.as_str()).collect();
    let id = id.map(str::to_string).unwrap_or_else(|| free(&template.id, &ids, "-"));
    profile_of(template, id, free(&template.name, &names, " "))
}

fn upsert<T: Clone>(list: &[T], item: T, id: impl Fn(&T) -> &str) -> Vec<T> {
    let key = id(&item).to_string();
    if list.iter().any(|x| id(x) == key) {
        list.iter().map(|x| if id(x) == key { item.clone() } else { x.clone() }).collect()
    } else {
        let mut out = list.to_vec();
        out.push(item);
        out
    }
}

/// A hook run before `save`/`create` returns; an `Err` refuses the call.
pub type Keep = Arc<dyn Fn(&Agent) -> Result<(), ApiError> + Send + Sync>;

/// `ProfileStore`.
pub struct Profiles {
    home: PathBuf,
    file: PathBuf,
    stored: Mutex<Stored>,
    keeps: Mutex<Vec<Keep>>,
}

impl Profiles {
    /// Reads `<home>/config.json`; a file that cannot be read is kept aside
    /// (`config.json.unreadable-<ms>`) and the profiles start from the
    /// default orchestrator and the `starters` (built-in template ids).
    pub fn open(home: &Path, starters: &[String]) -> std::io::Result<Arc<Profiles>> {
        let file = home.join("config.json");
        let read = match std::fs::read_to_string(&file) {
            Ok(text) => match read_stored(&text) {
                Ok(s) => Some(s),
                Err(_) => {
                    std::fs::rename(&file, format!("{}.unreadable-{}", file.to_string_lossy(), crate::now()))?;
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let built_in = built_in_templates();
        let mut s = read.unwrap_or_else(|| {
            let mut agents = Vec::new();
            for id in starters {
                if let Some(item) = built_in.iter().find(|x| x.id == *id) {
                    let made = installed(item, &agents, None);
                    agents.push(made);
                }
            }
            Stored { agents, ..Default::default() }
        });
        // The default orchestrator is always there, and always one.
        if s.agents.iter().any(|a| a.id == DEFAULT_ORCHESTRATOR) {
            for a in s.agents.iter_mut().filter(|a| a.id == DEFAULT_ORCHESTRATOR) {
                a.role = AgentRole::Orchestrator;
            }
        } else {
            let item = built_in.iter().find(|x| x.id == DEFAULT_ORCHESTRATOR).expect("the built-in orchestrator");
            let made = installed(item, &s.agents, Some(DEFAULT_ORCHESTRATOR));
            s.agents.insert(0, made);
        }
        s.agents = s.agents.into_iter().map(with_cast).collect();
        let profiles = Profiles {
            home: home.to_path_buf(),
            file,
            stored: Mutex::new(Stored::default()),
            keeps: Mutex::default(),
        };
        profiles.write(&s)?;
        *lock(&profiles.stored) = s;
        Ok(Arc::new(profiles))
    }

    fn write(&self, s: &Stored) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.home)?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string(s).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, &self.file)
    }

    /// A change is kept only once it is on disk.
    fn change<R>(&self, f: impl FnOnce(&mut Stored) -> Result<R, ApiError>) -> Result<R, ApiError> {
        let mut guard = lock(&self.stored);
        let mut next = guard.clone();
        let out = f(&mut next)?;
        self.write(&next).map_err(|e| {
            refused(t(
                "server.agent.notSaved",
                &[("file", self.file.to_string_lossy().into_owned().into()), ("why", e.to_string().into())],
            ))
        })?;
        *guard = next;
        Ok(out)
    }

    fn saved(&self, agent: Agent) -> Result<Agent, ApiError> {
        let keeps = lock(&self.keeps).clone();
        for keep in keeps {
            keep(&agent)?;
        }
        Ok(agent)
    }

    pub fn when_kept(&self, keep: Keep) {
        lock(&self.keeps).push(keep);
    }

    pub fn all(&self) -> Vec<Agent> {
        lock(&self.stored).agents.clone()
    }

    /// Helper profiles only: the ones work is sent to.
    pub fn agents(&self) -> Vec<Agent> {
        self.all().into_iter().filter(|a| a.role == AgentRole::Worker).collect()
    }

    pub fn orchestrators(&self) -> Vec<Agent> {
        self.all().into_iter().filter(|a| a.role == AgentRole::Orchestrator).collect()
    }

    pub fn is_orchestrator(&self, id: &str) -> bool {
        lock(&self.stored).agents.iter().any(|a| a.id == id && a.role == AgentRole::Orchestrator)
    }

    pub fn agent(&self, id: &str) -> Option<Agent> {
        lock(&self.stored).agents.iter().find(|a| a.id == id).cloned()
    }

    /// A helper by id, else by name.
    pub fn named(&self, key: &str) -> Option<Agent> {
        let k = key.trim();
        let helpers = self.agents();
        helpers.iter().find(|a| a.id == k).or_else(|| helpers.iter().find(|a| a.name == k)).cloned()
    }

    /// Built-in skills first; they shadow a user skill saved under the same id.
    pub fn skills(&self) -> Vec<Skill> {
        let own = built_in_skills();
        let mut out = own.clone();
        out.extend(lock(&self.stored).skills.iter().filter(|k| !own.iter().any(|o| o.id == k.id)).cloned());
        out
    }

    pub fn settings(&self, runtime: &str) -> RuntimeSettings {
        lock(&self.stored).settings.get(runtime).cloned().unwrap_or_else(default_settings)
    }

    pub fn save_settings(&self, runtime: &str, settings: RuntimeSettings) -> Result<RuntimeSettings, ApiError> {
        self.change(|s| {
            s.settings.insert(runtime.into(), settings.clone());
            Ok(settings)
        })
    }

    /// Why a profile cannot be kept as it is.
    fn role_problem(a: &Agent) -> Option<String> {
        if a.id == DEFAULT_ORCHESTRATOR && a.role != AgentRole::Orchestrator {
            return Some(t("server.agent.defaultStaysOrchestrator", &[]));
        }
        if a.role == AgentRole::Orchestrator && a.runtime != ORCHESTRATOR_RUNTIME {
            return Some(t("server.agent.orchestratorRuntime", &[("runtime", ORCHESTRATOR_RUNTIME.into())]));
        }
        None
    }

    pub fn save(&self, a: Agent) -> Result<Agent, ApiError> {
        if let Some(why) = Self::role_problem(&a) {
            return Err(refused(why));
        }
        let cast = with_cast(a);
        self.change(|s| {
            s.agents = upsert(&s.agents, cast.clone(), |a| &a.id);
            Ok(())
        })?;
        self.saved(cast)
    }

    pub fn create(&self, draft: Agent) -> Result<Agent, ApiError> {
        if !draft.id.is_empty() {
            return Err(refused(t("server.agent.newAgentId", &[])));
        }
        if let Some(why) = Self::role_problem(&draft) {
            return Err(refused(why));
        }
        let created = self.change(|s| {
            let n = (1..).find(|n| !s.agents.iter().any(|a| a.id == format!("agent-{n}"))).expect("a free id");
            let created = with_cast(Agent {
                id: format!("agent-{n}"),
                ..draft
            });
            s.agents.push(created.clone());
            Ok(created)
        })?;
        self.saved(created)
    }

    fn deletable_agent(&self, id: &str) -> Result<Agent, ApiError> {
        if id == DEFAULT_ORCHESTRATOR {
            return Err(refused(t("server.agent.orchestratorStays", &[])));
        }
        self.agent(id)
            .ok_or_else(|| missing(t("server.agent.noAgent", &[("id", id.into())]), LookIn::Agent))
    }

    pub fn remove(&self, id: &str) -> Result<(), ApiError> {
        self.deletable_agent(id)?;
        self.change(|s| {
            s.agents.retain(|a| a.id != id);
            Ok(())
        })
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let a = self.deletable_agent(id)?;
        Ok(Preview {
            does: vec![t(
                "server.agent.removeAgent",
                &[("name", a.name.into()), ("id", a.id.into()), ("runtime", a.runtime.into())],
            )],
        })
    }

    fn not_built_in(id: &str) -> Result<(), ApiError> {
        match built_in_skills().into_iter().find(|k| k.id == id) {
            Some(k) => Err(refused(t("server.agent.builtInSkill", &[("name", k.name.into())]))),
            None => Ok(()),
        }
    }

    fn deletable_skill(&self, id: &str) -> Result<Skill, ApiError> {
        Self::not_built_in(id)?;
        lock(&self.stored)
            .skills
            .iter()
            .find(|k| k.id == id)
            .cloned()
            .ok_or_else(|| missing(t("server.agent.noSkill", &[("id", id.into())]), LookIn::Skill))
    }

    pub fn save_skill(&self, skill: Skill) -> Result<Skill, ApiError> {
        Self::not_built_in(&skill.id)?;
        let kept = Skill { built_in: None, ..skill };
        self.change(|s| {
            s.skills = upsert(&s.skills, kept.clone(), |k| &k.id);
            Ok(())
        })?;
        Ok(kept)
    }

    pub fn create_skill(&self, draft: Skill) -> Result<Skill, ApiError> {
        if !draft.id.is_empty() {
            return Err(refused(t("server.agent.newSkillId", &[])));
        }
        let mut stem = String::new();
        for c in draft.name.to_lowercase().chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                stem.push(c);
            } else if !stem.ends_with('-') {
                stem.push('-');
            }
        }
        let stem = stem.trim_matches('-').to_string();
        let stem = if stem.is_empty() { "skill".to_string() } else { stem };
        let own: BTreeSet<String> = built_in_skills().into_iter().map(|k| k.id).collect();
        self.change(|s| {
            let taken = |x: &str| own.contains(x) || s.skills.iter().any(|k| k.id == x);
            let mut id = stem.clone();
            let mut n = 2;
            while taken(&id) {
                id = format!("{stem}-{n}");
                n += 1;
            }
            let created = Skill { id, built_in: None, ..draft };
            s.skills.push(created.clone());
            Ok(created)
        })
    }

    pub fn remove_skill(&self, id: &str) -> Result<(), ApiError> {
        self.deletable_skill(id)?;
        self.change(|s| {
            s.skills.retain(|k| k.id != id);
            for a in &mut s.agents {
                a.skills.retain(|k| k != id);
            }
            Ok(())
        })
    }

    pub fn preview_remove_skill(&self, id: &str) -> Result<Preview, ApiError> {
        let k = self.deletable_skill(id)?;
        let holders: Vec<String> = lock(&self.stored)
            .agents
            .iter()
            .filter(|a| a.skills.iter().any(|s| s == id))
            .map(|a| t("server.agent.quoted", &[("name", a.name.clone().into())]))
            .collect();
        let mut does = vec![t("server.agent.removeSkill", &[("name", k.name.into())])];
        if !holders.is_empty() {
            does.push(t("server.agent.unequip", &[("holders", list(&holders).into())]));
        }
        Ok(Preview { does })
    }

    /// Built in, then added; re-read on each call so a folder added or
    /// removed by hand shows at once.
    pub fn templates(&self) -> Vec<AgentTemplate> {
        let agents = self.all();
        let mut all = built_in_templates();
        all.extend(added_templates(&self.home));
        for item in &mut all {
            item.installed = agents
                .iter()
                .filter(|a| a.from.as_ref().is_some_and(|f| f.template == item.id))
                .map(|a| a.id.clone())
                .collect();
        }
        all
    }

    pub fn template_of(&self, id: &str) -> Option<AgentTemplate> {
        self.templates().into_iter().find(|x| x.id == id)
    }

    fn no_template(id: &str) -> ApiError {
        missing(t("server.agent.template.noTemplate", &[("id", id.into())]), LookIn::Template)
    }

    fn deletable_template(&self, id: &str) -> Result<AgentTemplate, ApiError> {
        let item = self.template_of(id).ok_or_else(|| Self::no_template(id))?;
        if item.source == AgentTemplateSource::BuiltIn {
            return Err(refused(t("server.agent.template.builtIn", &[("id", id.into())])));
        }
        Ok(item)
    }

    pub fn install_template(&self, id: &str) -> Result<Agent, ApiError> {
        self.install_template_with_runtime(id, None)
    }

    pub fn install_template_with_runtime(&self, id: &str, runtime_override: Option<(String, PersonaMode)>) -> Result<Agent, ApiError> {
        let mut item = self.template_of(id).ok_or_else(|| Self::no_template(id))?;
        if let Some((runtime, persona_mode)) = runtime_override
            && item.role != AgentRole::Orchestrator
        {
            item.runtime = runtime;
            item.persona_mode = persona_mode;
        }
        let made = self.change(|s| {
            let made = with_cast(installed(&item, &s.agents, None));
            s.agents.push(made.clone());
            Ok(made)
        })?;
        self.saved(made)
    }

    pub fn update_from_template(&self, agent: &str) -> Result<Agent, ApiError> {
        let a = self
            .agent(agent)
            .ok_or_else(|| missing(t("server.agent.noAgent", &[("id", agent.into())]), LookIn::Agent))?;
        let Some(from) = &a.from else {
            return Err(refused(t("server.agent.template.notFrom", &[("name", a.name.clone().into())])));
        };
        let item = self.template_of(&from.template).ok_or_else(|| {
            refused(t(
                "server.agent.template.gone",
                &[("name", a.name.clone().into()), ("template", from.template.clone().into())],
            ))
        })?;
        let next = with_cast(updated_from(&item, &a));
        self.change(|s| {
            s.agents = upsert(&s.agents, next.clone(), |a| &a.id);
            Ok(())
        })?;
        self.saved(next)
    }

    pub fn add_template(&self, path: &str) -> Result<AgentTemplate, ApiError> {
        let item = read_template(Path::new(path), AgentTemplateSource::Added).map_err(refused)?;
        if self.template_of(&item.id).is_some() {
            return Err(refused(t("server.agent.template.taken", &[("id", item.id.into())])));
        }
        copy_template(Path::new(path), &self.home, &item.id)
            .map_err(|e| refused(t("server.agent.notSaved", &[("file", path.into()), ("why", e.to_string().into())])))?;
        Ok(AgentTemplate { installed: vec![], ..item })
    }

    pub fn remove_template(&self, id: &str) -> Result<(), ApiError> {
        let item = self.deletable_template(id)?;
        match std::fs::remove_dir_all(added_dir(&self.home).join(&item.id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(refused(t("server.agent.notSaved", &[("file", id.into()), ("why", e.to_string().into())])))
            }
            _ => Ok(()),
        }
    }

    pub fn preview_remove_template(&self, id: &str) -> Result<Preview, ApiError> {
        let item = self.deletable_template(id)?;
        let does = if item.installed.is_empty() {
            t("server.agent.template.delete", &[("name", item.name.into())])
        } else {
            t(
                "server.agent.template.deleteKept",
                &[("name", item.name.into()), ("installed", item.installed.len().into())],
            )
        };
        Ok(Preview { does: vec![does] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_templates_read_and_start_with_the_orchestrator() {
        vibevalley_i18n::set_locale("zh");
        let all = built_in_templates();
        assert_eq!(all.len(), built_in_ids().len());
        assert_eq!(all[0].id, DEFAULT_ORCHESTRATOR);
        assert_eq!(all[0].runtime, ORCHESTRATOR_RUNTIME);
        assert!(all[1..].iter().all(|x| x.role == AgentRole::Worker));
        let skills: BTreeSet<String> = built_in_skills().into_iter().map(|k| k.id).collect();
        for item in &all {
            for s in &item.skills {
                assert!(skills.contains(s), "{} names {s}", item.id);
            }
        }
    }

    #[test]
    fn cast_hash_matches_js() {
        // Math.imul(h, 31) + unit, >>> 0, over "agent-1".
        let mut h: u32 = 0;
        for u in "agent-1".encode_utf16() {
            h = h.wrapping_mul(31).wrapping_add(u as u32);
        }
        assert_eq!(cast_hash("agent-1"), h);
    }
}
