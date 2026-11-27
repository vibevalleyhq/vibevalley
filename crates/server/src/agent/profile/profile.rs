//! The profiles, skills and runtime settings kept in `<home>/config.json`,
//! and the templates profiles are installed from (built in, and added under
//! `<home>/agent-templates`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use include_dir::{Dir, include_dir};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    Agent, AgentExecutionMode, AgentFrom, AgentRegisterInput, AgentRole, AgentTemplate, AgentTemplateSource, ApiError, BizCode, Build, DEFAULT_ORCHESTRATOR,
    Head, Look, ORCHESTRATOR_RUNTIME, OrchestratorLook, Outfit, PersonaMode, Preview, RuntimeSettings, Skill, Species, TemplateCategory, Toolset,
};

use super::preset::default_settings;
use crate::context::error::{LookIn, missing};

fn decode_value<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ApiError> {
    serde_json::from_value(value).map_err(|e| ApiError::new(BizCode::InvalidInput, e.to_string()))
}

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
    settings: BTreeMap<String, RuntimeSettings>,
    #[serde(skip)]
    user_skills: Vec<Skill>,
}

struct ReadConfig {
    stored: Stored,
    migrated_skills: Vec<Skill>,
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

pub const WORKER_ROLE_AVATARS: [&str; 13] = [
    "avatar-fullstack",
    "avatar-architect",
    "avatar-frontend",
    "avatar-backend",
    "avatar-reviewer",
    "avatar-tester",
    "avatar-designer",
    "avatar-product",
    "avatar-scout",
    "avatar-docs",
    "avatar-pages",
    "avatar-slides",
    "avatar-collector",
];

fn is_valid_role_avatar(avatar: &str) -> bool {
    avatar == "avatar-orchestrator" || WORKER_ROLE_AVATARS.contains(&avatar)
}

fn fnv1a_hash(text: &str) -> u32 {
    text.chars().fold(2166136261u32, |mut hash, ch| {
        let mut units = [0u16; 2];
        let unit = ch.encode_utf16(&mut units)[0];
        hash ^= unit as u32;
        hash.wrapping_mul(16777619)
    })
}

/// Deterministic Papertrails portrait assignment matching UI `assignWorkerAvatars` collision probing.
pub fn assign_worker_avatar(id: &str, name: &str, beside: &[Agent]) -> String {
    let used: BTreeSet<&str> = beside.iter().filter_map(|a| a.look.avatar.as_deref()).filter(|s| !s.is_empty()).collect();
    let seed = if !id.trim().is_empty() {
        id.trim()
    } else if !name.trim().is_empty() {
        name.trim()
    } else {
        "worker"
    };
    let pool_size = WORKER_ROLE_AVATARS.len();
    let start = (fnv1a_hash(seed) as usize) % pool_size;
    for step in 0..pool_size {
        let candidate = WORKER_ROLE_AVATARS[(start + step) % pool_size];
        if !used.contains(candidate) {
            return candidate.to_string();
        }
    }
    WORKER_ROLE_AVATARS[start].to_string()
}

fn code_prefix(role: AgentRole) -> char {
    match role {
        AgentRole::Orchestrator => 'O',
        AgentRole::Worker => 'W',
    }
}

fn normalize_code_for_role(raw: &str, role: AgentRole) -> Option<String> {
    let trimmed = raw.trim();
    let (prefix, rest) = trimmed.split_once('-')?;
    let expected = code_prefix(role);
    if !prefix.eq_ignore_ascii_case(&expected.to_string()) || rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = rest.parse().ok()?;
    (n >= 1).then(|| format!("{expected}-{n:02}"))
}

fn next_free_code(role: AgentRole, beside: &[Agent]) -> String {
    let prefix = code_prefix(role);
    (1u32..)
        .map(|n| format!("{prefix}-{n:02}"))
        .find(|cand| !beside.iter().any(|a| a.code.eq_ignore_ascii_case(cand)))
        .expect("a free teammate code")
}

fn ensure_agent_codes(agents: &mut [Agent]) {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut need_assign = Vec::new();
    for (idx, a) in agents.iter_mut().enumerate() {
        if let Some(norm) = normalize_code_for_role(&a.code, a.role)
            && seen.insert(norm.to_ascii_uppercase())
        {
            a.code = norm;
        } else {
            need_assign.push(idx);
        }
    }
    for idx in need_assign {
        let prefix = code_prefix(agents[idx].role);
        let code = (1u32..)
            .map(|n| format!("{prefix}-{n:02}"))
            .find(|cand| seen.insert(cand.to_ascii_uppercase()))
            .expect("a free teammate code");
        agents[idx].code = code;
    }
}

fn resolve_agent_code(raw: &str, role: AgentRole, beside: &[Agent], self_id: Option<&str>) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        if let Some(id) = self_id
            && let Some(existing) = beside.iter().find(|a| a.id == id)
            && let Some(norm) = normalize_code_for_role(&existing.code, role)
            && !beside.iter().any(|a| a.id != id && a.code.eq_ignore_ascii_case(&norm))
        {
            return Ok(norm);
        }
        return Ok(next_free_code(role, beside));
    }
    let normalized = normalize_code_for_role(trimmed, role).ok_or_else(|| refused(t("server.agent.invalidCode", &[("code", trimmed.into())])))?;
    if let Some(other) = beside
        .iter()
        .find(|a| Some(a.id.as_str()) != self_id && a.code.eq_ignore_ascii_case(&normalized))
    {
        return Err(refused(t(
            "server.agent.duplicateCode",
            &[("code", normalized.into()), ("other", other.name.clone().into())],
        )));
    }
    Ok(normalized)
}

fn slug_ascii(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn derive_external_id(runtime: &str, name: &str) -> String {
    let r = slug_ascii(runtime);
    let n = slug_ascii(name);
    match (r.as_str(), n.as_str()) {
        ("", "") => format!("ext-{:08x}", fnv1a_hash(name.trim())),
        (_, "") => format!("{r}-{:08x}", fnv1a_hash(name.trim())),
        ("", _) | ("external", _) => n,
        _ if n == r || n.starts_with(&format!("{r}-")) => n,
        _ => format!("{r}-{n}"),
    }
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

/// A profile's look written before `build`, `head`, or `toolsets` existed is filled in.
fn profile_filled(mut raw: Value) -> Value {
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
    if raw.get("toolsets").is_none_or(Value::is_null) {
        let role = match raw.get("role").and_then(Value::as_str) {
            Some("orchestrator") => AgentRole::Orchestrator,
            _ => AgentRole::Worker,
        };
        if let Some(obj) = raw.as_object_mut() {
            obj.insert(
                "toolsets".into(),
                serde_json::to_value(Toolset::defaults_for(role)).unwrap_or(Value::Array(vec![])),
            );
        }
    }
    raw
}

fn read_stored(text: &str) -> Result<ReadConfig, String> {
    #[derive(Deserialize)]
    struct File {
        agents: Vec<Value>,
        #[serde(default)]
        skills: Vec<Skill>,
        settings: BTreeMap<String, RuntimeSettings>,
    }
    let file: File = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let agents = file
        .agents
        .into_iter()
        .map(|a| decode_value::<Agent>(profile_filled(a)).map_err(|e| e.message))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ReadConfig {
        stored: Stored {
            agents,
            settings: file.settings,
            user_skills: Vec::new(),
        },
        migrated_skills: file.skills,
    })
}

fn skills_dir(home: &Path) -> PathBuf {
    home.join("skills")
}

fn valid_skill_id(id: &str) -> bool {
    !id.is_empty() && !matches!(id, "." | "..") && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn skill_file(home: &Path, id: &str) -> PathBuf {
    skills_dir(home).join(id).join("SKILL.md")
}

fn yaml_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.contains('\n') {
        let indented: String = trimmed.lines().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n");
        return format!("|\n{indented}");
    }
    if trimmed.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quotes =
        trimmed.contains(':') || trimmed.contains('#') || matches!(trimmed.as_bytes()[0], b'>' | b'|' | b'-' | b'[' | b'{' | b'"' | b'\'' | b'*' | b'&' | b'!');
    if !needs_quotes {
        trimmed.to_string()
    } else if !trimmed.contains('"') {
        format!("\"{trimmed}\"")
    } else if !trimmed.contains('\'') {
        format!("'{trimmed}'")
    } else {
        format!("\"{}\"", trimmed.replace('"', ""))
    }
}

fn format_skill_markdown(skill: &Skill) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", yaml_scalar(&skill.name)));
    if !skill.description.trim().is_empty() {
        out.push_str(&format!("description: {}\n", yaml_scalar(&skill.description)));
    }
    out.push_str("---\n\n");
    if !skill.body.trim().is_empty() {
        out.push_str(skill.body.trim());
        out.push('\n');
    }
    out
}

async fn read_user_skills_async(home: &Path) -> Vec<Skill> {
    let Ok(mut entries) = tokio::fs::read_dir(skills_dir(home)).await else {
        return vec![];
    };
    let mut dirs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_dir()) {
            dirs.push(path);
        }
    }
    dirs.sort();
    let own: BTreeSet<String> = built_in_skills().into_iter().map(|k| k.id).collect();
    let mut out = Vec::new();
    for dir in dirs {
        let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        if !valid_skill_id(&id) || own.contains(&id) {
            continue;
        }
        let Ok(text) = tokio::fs::read_to_string(dir.join("SKILL.md")).await else {
            continue;
        };
        let head = vibevalley_runtime::agent::resources::skills::front_matter(&text);
        out.push(Skill {
            name: head.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| id.clone()),
            description: head.get("description").cloned().unwrap_or_default(),
            body: vibevalley_runtime::agent::resources::skills::skill_body(&text),
            built_in: None,
            id,
        });
    }
    out
}

async fn write_user_skill_async(home: &Path, skill: &Skill) -> std::io::Result<()> {
    let dir = skills_dir(home).join(&skill.id);
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join("SKILL.md");
    let tmp = dir.join("SKILL.md.tmp");
    tokio::fs::write(&tmp, format_skill_markdown(skill)).await?;
    tokio::fs::rename(&tmp, &path).await
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
    decode_value::<A>(raw).map(Some).map_err(|e| unreadable(&path, e.message))
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
async fn read_template_async(dir: &Path, source: AgentTemplateSource) -> Result<AgentTemplate, String> {
    let mut texts = BTreeMap::new();
    let dir_text = dir.to_string_lossy().into_owned();
    for f in TEMPLATE_FILES {
        let path = dir.join(f);
        match tokio::fs::read_to_string(&path).await {
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
            let head = vibevalley_runtime::agent::resources::skills::front_matter(text);
            Some(Skill {
                name: head.get("name").cloned().unwrap_or_else(|| id.clone()),
                description: head.get("description").cloned().unwrap_or_default(),
                body: vibevalley_runtime::agent::resources::skills::skill_body(text),
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
async fn added_templates_async(home: &Path) -> Vec<AgentTemplate> {
    let Ok(mut entries) = tokio::fs::read_dir(added_dir(home)).await else {
        return vec![];
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        names.push(entry.path());
    }
    names.sort();
    let mut out = Vec::new();
    for dir in names {
        if let Ok(item) = read_template_async(&dir, AgentTemplateSource::Added).await {
            out.push(item);
        }
    }
    out
}

async fn copy_template_async(from: &Path, home: &Path, id: &str) -> std::io::Result<()> {
    let to = added_dir(home).join(id);
    tokio::fs::create_dir_all(&to).await?;
    for f in TEMPLATE_FILES {
        match tokio::fs::copy(from.join(f), to.join(f)).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// A new profile from a template, under the id and name given.
fn profile_of(item: &AgentTemplate, id: String, code: String, name: String) -> Agent {
    Agent {
        id,
        code,
        name,
        role: item.role,
        mode: AgentExecutionMode::Managed,
        duty: item.duty.clone(),
        enabled: true,
        runtime: item.runtime.clone(),
        machine_id: None,
        model: item.model.clone(),
        effort: item.effort.clone(),
        persona: item.persona.clone(),
        persona_mode: item.persona_mode,
        skills: item.skills.clone(),
        toolsets: Toolset::defaults_for(item.role),
        mcp_servers: vec![],
        disallowed_tools: vec![],
        env: BTreeMap::new(),
        workdir: String::new(),
        worktree: item.worktree,
        tags: item.tags.clone(),
        look: item.look.clone(),
        voice: None,
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
    let code = next_free_code(template.role, beside);
    profile_of(template, id, code, free(&template.name, &names, " "))
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

/// Disk-backed agent profile, skill, and runtime settings store (`<home>/config.json`).
pub struct ProfileStore {
    home: PathBuf,
    file: PathBuf,
    stored: Mutex<Stored>,
    keeps: Mutex<Vec<Keep>>,
    write_gate: tokio::sync::Semaphore,
}

impl ProfileStore {
    /// Reads `<home>/config.json`; a file that cannot be read is kept aside
    /// (`config.json.unreadable-<ms>`) and the profiles start from the
    /// default orchestrator and the `starters` (built-in template ids).
    pub async fn open_async(home: &Path, starters: &[String]) -> std::io::Result<Arc<ProfileStore>> {
        let file = home.join("config.json");
        let read = match tokio::fs::read_to_string(&file).await {
            Ok(text) => match read_stored(&text) {
                Ok(s) => Some(s),
                Err(_) => {
                    tokio::fs::rename(&file, format!("{}.unreadable-{}", file.to_string_lossy(), crate::context::now())).await?;
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let built_in = built_in_templates();
        let (mut s, migrated_skills) = match read {
            Some(r) => (r.stored, r.migrated_skills),
            None => {
                let mut agents = Vec::new();
                for id in starters {
                    if let Some(item) = built_in.iter().find(|x| x.id == *id) {
                        let made = installed(item, &agents, None);
                        agents.push(made);
                    }
                }
                (Stored { agents, ..Default::default() }, Vec::new())
            }
        };
        for skill in migrated_skills {
            if !valid_skill_id(&skill.id) || Self::not_built_in(&skill.id).is_err() {
                continue;
            }
            if tokio::fs::try_exists(skill_file(home, &skill.id)).await.unwrap_or(false) {
                continue;
            }
            write_user_skill_async(home, &skill).await?;
        }
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
        ensure_agent_codes(&mut s.agents);
        s.user_skills = read_user_skills_async(home).await;
        let profiles = ProfileStore {
            home: home.to_path_buf(),
            file,
            stored: Mutex::new(Stored::default()),
            keeps: Mutex::default(),
            write_gate: tokio::sync::Semaphore::new(1),
        };
        profiles.write_async(&s).await?;
        *profiles.stored.lock() = s;
        Ok(Arc::new(profiles))
    }

    async fn write_async(&self, s: &Stored) -> std::io::Result<()> {
        tokio::fs::create_dir_all(&self.home).await?;
        let tmp = self.file.with_extension("json.tmp");
        tokio::fs::write(&tmp, serde_json::to_string(s).map_err(std::io::Error::other)?).await?;
        tokio::fs::rename(&tmp, &self.file).await
    }

    /// A change is kept only once it is on disk.
    async fn change_async<R>(&self, f: impl FnOnce(&mut Stored) -> Result<R, ApiError>) -> Result<R, ApiError> {
        let _permit = self
            .write_gate
            .acquire()
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        let mut next = self.stored.lock().clone();
        let out = f(&mut next)?;
        self.write_async(&next).await.map_err(|e| {
            refused(t(
                "server.agent.notSaved",
                &[("file", self.file.to_string_lossy().into_owned().into()), ("why", e.to_string().into())],
            ))
        })?;
        *self.stored.lock() = next;
        Ok(out)
    }

    fn saved(&self, agent: Agent) -> Result<Agent, ApiError> {
        let keeps = self.keeps.lock().clone();
        for keep in keeps {
            keep(&agent)?;
        }
        Ok(agent)
    }

    pub fn when_kept(&self, keep: Keep) {
        self.keeps.lock().push(keep);
    }

    pub fn all(&self) -> Vec<Agent> {
        self.stored.lock().agents.clone()
    }

    /// Worker profiles (managed and external) on the teammates roster.
    pub fn agents(&self) -> Vec<Agent> {
        self.all().into_iter().filter(|a| a.role == AgentRole::Worker).collect()
    }

    /// Managed worker profiles eligible for automatic OAR dispatch.
    pub fn managed_workers(&self) -> Vec<Agent> {
        self.all()
            .into_iter()
            .filter(|a| a.role == AgentRole::Worker && a.mode == AgentExecutionMode::Managed)
            .collect()
    }

    pub fn orchestrators(&self) -> Vec<Agent> {
        self.all().into_iter().filter(|a| a.role == AgentRole::Orchestrator).collect()
    }

    pub fn is_orchestrator(&self, id: &str) -> bool {
        self.stored.lock().agents.iter().any(|a| a.id == id && a.role == AgentRole::Orchestrator)
    }

    pub fn agent(&self, id: &str) -> Option<Agent> {
        self.stored.lock().agents.iter().find(|a| a.id == id).cloned()
    }

    /// A worker by id, teammate code (`W-XX`), or name.
    pub fn named(&self, key: &str) -> Option<Agent> {
        let k = key.trim();
        let helpers = self.agents();
        helpers
            .iter()
            .find(|a| a.id == k)
            .or_else(|| helpers.iter().find(|a| a.code.eq_ignore_ascii_case(k)))
            .or_else(|| helpers.iter().find(|a| a.name == k))
            .cloned()
    }

    /// Built-in skills first, followed by user skills loaded from `<home>/skills/<id>/SKILL.md`.
    pub fn skills(&self) -> Vec<Skill> {
        let mut out = built_in_skills();
        out.extend(self.stored.lock().user_skills.clone());
        out
    }

    pub fn settings(&self, runtime: &str) -> RuntimeSettings {
        self.stored.lock().settings.get(runtime).cloned().unwrap_or_else(default_settings)
    }

    pub async fn save_settings_async(&self, runtime: &str, settings: RuntimeSettings) -> Result<RuntimeSettings, ApiError> {
        self.change_async(|s| {
            s.settings.insert(runtime.into(), settings.clone());
            Ok(settings)
        })
        .await
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

    pub async fn save_async(&self, a: Agent) -> Result<Agent, ApiError> {
        if let Some(why) = Self::role_problem(&a) {
            return Err(refused(why));
        }
        let saved = self
            .change_async(|s| {
                let raw_code = match s.agents.iter().find(|existing| existing.id == a.id) {
                    Some(existing) if existing.role != a.role && a.code.trim() == existing.code => "",
                    _ => a.code.as_str(),
                };
                let code = resolve_agent_code(raw_code, a.role, &s.agents, Some(&a.id))?;
                let cast = with_cast(Agent { code, ..a });
                s.agents = upsert(&s.agents, cast.clone(), |x| &x.id);
                Ok(cast)
            })
            .await?;
        self.saved(saved)
    }

    pub async fn create_async(&self, draft: Agent) -> Result<Agent, ApiError> {
        if !draft.id.is_empty() {
            return Err(refused(t("server.agent.newAgentId", &[])));
        }
        if let Some(why) = Self::role_problem(&draft) {
            return Err(refused(why));
        }
        let created = self
            .change_async(|s| {
                let n = (1..).find(|n| !s.agents.iter().any(|a| a.id == format!("agent-{n}"))).expect("a free id");
                let code = resolve_agent_code(&draft.code, draft.role, &s.agents, None)?;
                let created = with_cast(Agent {
                    id: format!("agent-{n}"),
                    code,
                    ..draft
                });
                s.agents.push(created.clone());
                Ok(created)
            })
            .await?;
        self.saved(created)
    }

    /// Idempotently registers or updates an `External` worker teammate with a permanent `W-XX` code and deterministic Papertrails avatar.
    pub async fn register_external_async(&self, input: AgentRegisterInput) -> Result<Agent, ApiError> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(refused(t("server.agent.registerMissingName", &[])));
        }
        let explicit_avatar = match input.avatar.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(av) => {
                if !is_valid_role_avatar(av) {
                    return Err(refused(t("server.agent.invalidAvatar", &[("avatar", av.into())])));
                }
                Some(av.to_string())
            }
            None => None,
        };
        let explicit_runtime = input.runtime.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let id = match input.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => raw.to_string(),
            None => derive_external_id(explicit_runtime.as_deref().unwrap_or("external"), &name),
        };
        let saved = self
            .change_async(|s| {
                if let Some(existing) = s.agents.iter().find(|a| a.id == id).cloned() {
                    if existing.role != AgentRole::Worker || existing.mode != AgentExecutionMode::External {
                        return Err(refused(t("server.agent.cannotOverwriteManaged", &[("id", id.clone().into())])));
                    }
                    let code = match input.code.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                        Some(raw_code) => resolve_agent_code(raw_code, AgentRole::Worker, &s.agents, Some(&id))?,
                        None => resolve_agent_code("", AgentRole::Worker, &s.agents, Some(&id))?,
                    };
                    let mut look = existing.look.clone();
                    if let Some(av) = explicit_avatar {
                        look.avatar = Some(av);
                    } else if look.avatar.as_deref().is_none_or(str::is_empty) {
                        look.avatar = Some(assign_worker_avatar(&id, &name, &s.agents));
                    }
                    let next = with_cast(Agent {
                        code,
                        name,
                        enabled: true,
                        runtime: explicit_runtime.unwrap_or(existing.runtime),
                        duty: input.duty.as_deref().map(str::trim).map(str::to_string).unwrap_or(existing.duty),
                        tags: input.tags.unwrap_or(existing.tags),
                        look,
                        ..existing
                    });
                    s.agents = upsert(&s.agents, next.clone(), |x| &x.id);
                    return Ok(next);
                }

                let code = resolve_agent_code(input.code.as_deref().unwrap_or_default(), AgentRole::Worker, &s.agents, None)?;
                let avatar = explicit_avatar.unwrap_or_else(|| assign_worker_avatar(&id, &name, &s.agents));
                let created = with_cast(Agent {
                    id,
                    code,
                    name,
                    role: AgentRole::Worker,
                    mode: AgentExecutionMode::External,
                    duty: input.duty.as_deref().map(str::trim).unwrap_or_default().to_string(),
                    enabled: true,
                    runtime: explicit_runtime.unwrap_or_else(|| "external".to_string()),
                    machine_id: None,
                    model: String::new(),
                    effort: String::new(),
                    persona: String::new(),
                    persona_mode: PersonaMode::Append,
                    skills: vec![],
                    toolsets: vec![],
                    mcp_servers: vec![],
                    disallowed_tools: vec![],
                    env: BTreeMap::new(),
                    workdir: String::new(),
                    worktree: false,
                    tags: input.tags.unwrap_or_default(),
                    look: Look {
                        species: None,
                        outfit: None,
                        orchestrator: None,
                        build: Build::Biped,
                        head: Head::Rounded,
                        body: String::new(),
                        trim: String::new(),
                        hat: String::new(),
                        eye: String::new(),
                        avatar: Some(avatar),
                    },
                    voice: None,
                    from: None,
                });
                s.agents.push(created.clone());
                Ok(created)
            })
            .await?;
        self.saved(saved)
    }

    fn deletable_agent(&self, id: &str) -> Result<Agent, ApiError> {
        if id == DEFAULT_ORCHESTRATOR {
            return Err(refused(t("server.agent.orchestratorStays", &[])));
        }
        self.agent(id)
            .ok_or_else(|| missing(t("server.agent.noAgent", &[("id", id.into())]), LookIn::Agent))
    }

    pub async fn remove_async(&self, id: &str) -> Result<(), ApiError> {
        self.deletable_agent(id)?;
        self.change_async(|s| {
            s.agents.retain(|a| a.id != id);
            Ok(())
        })
        .await
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
        self.stored
            .lock()
            .user_skills
            .iter()
            .find(|k| k.id == id)
            .cloned()
            .ok_or_else(|| missing(t("server.agent.noSkill", &[("id", id.into())]), LookIn::Skill))
    }

    pub async fn save_skill_async(&self, skill: Skill) -> Result<Skill, ApiError> {
        Self::not_built_in(&skill.id)?;
        if !valid_skill_id(&skill.id) {
            return Err(refused(t("server.agent.noSkill", &[("id", skill.id.clone().into())])));
        }
        let _permit = self
            .write_gate
            .acquire()
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        let kept = Skill { built_in: None, ..skill };
        write_user_skill_async(&self.home, &kept).await.map_err(|e| {
            refused(t(
                "server.agent.notSaved",
                &[
                    ("file", skill_file(&self.home, &kept.id).to_string_lossy().into_owned().into()),
                    ("why", e.to_string().into()),
                ],
            ))
        })?;
        let mut guard = self.stored.lock();
        guard.user_skills = upsert(&guard.user_skills, kept.clone(), |k| &k.id);
        Ok(kept)
    }

    pub async fn create_skill_async(&self, draft: Skill) -> Result<Skill, ApiError> {
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
        let _permit = self
            .write_gate
            .acquire()
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        let existing: BTreeSet<String> = read_user_skills_async(&self.home).await.into_iter().map(|k| k.id).collect();
        let mut id = stem.clone();
        let mut n = 2;
        while own.contains(&id) || existing.contains(&id) || tokio::fs::try_exists(skills_dir(&self.home).join(&id)).await.unwrap_or(false) {
            id = format!("{stem}-{n}");
            n += 1;
        }
        let created = Skill { id, built_in: None, ..draft };
        write_user_skill_async(&self.home, &created).await.map_err(|e| {
            refused(t(
                "server.agent.notSaved",
                &[
                    ("file", skill_file(&self.home, &created.id).to_string_lossy().into_owned().into()),
                    ("why", e.to_string().into()),
                ],
            ))
        })?;
        self.stored.lock().user_skills.push(created.clone());
        Ok(created)
    }

    pub async fn remove_skill_async(&self, id: &str) -> Result<(), ApiError> {
        self.deletable_skill(id)?;
        let dir = skills_dir(&self.home).join(id);
        self.change_async(|s| {
            s.user_skills.retain(|k| k.id != id);
            for a in &mut s.agents {
                a.skills.retain(|k| k != id);
            }
            Ok(())
        })
        .await?;
        match tokio::fs::remove_dir_all(&dir).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(refused(t(
                "server.agent.notSaved",
                &[("file", dir.to_string_lossy().into_owned().into()), ("why", e.to_string().into())],
            ))),
            _ => Ok(()),
        }
    }

    pub fn preview_remove_skill(&self, id: &str) -> Result<Preview, ApiError> {
        let k = self.deletable_skill(id)?;
        let holders: Vec<String> = self
            .stored
            .lock()
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
    pub async fn templates_async(&self) -> Vec<AgentTemplate> {
        let agents = self.all();
        let mut all = built_in_templates();
        all.extend(added_templates_async(&self.home).await);
        for item in &mut all {
            item.installed = agents
                .iter()
                .filter(|a| a.from.as_ref().is_some_and(|f| f.template == item.id))
                .map(|a| a.id.clone())
                .collect();
        }
        all
    }

    pub async fn template_of_async(&self, id: &str) -> Option<AgentTemplate> {
        self.templates_async().await.into_iter().find(|x| x.id == id)
    }

    fn no_template(id: &str) -> ApiError {
        missing(t("server.agent.template.noTemplate", &[("id", id.into())]), LookIn::Template)
    }

    async fn deletable_template_async(&self, id: &str) -> Result<AgentTemplate, ApiError> {
        let item = self.template_of_async(id).await.ok_or_else(|| Self::no_template(id))?;
        if item.source == AgentTemplateSource::BuiltIn {
            return Err(refused(t("server.agent.template.builtIn", &[("id", id.into())])));
        }
        Ok(item)
    }

    pub async fn install_template_async(&self, id: &str) -> Result<Agent, ApiError> {
        self.install_template_with_runtime_async(id, None).await
    }

    pub async fn install_template_with_runtime_async(&self, id: &str, runtime_override: Option<(String, PersonaMode)>) -> Result<Agent, ApiError> {
        let mut item = self.template_of_async(id).await.ok_or_else(|| Self::no_template(id))?;
        if let Some((runtime, persona_mode)) = runtime_override
            && item.role != AgentRole::Orchestrator
        {
            item.runtime = runtime;
            item.persona_mode = persona_mode;
        }
        let made = self
            .change_async(|s| {
                let made = with_cast(installed(&item, &s.agents, None));
                s.agents.push(made.clone());
                Ok(made)
            })
            .await?;
        self.saved(made)
    }

    pub async fn update_from_template_async(&self, agent: &str) -> Result<Agent, ApiError> {
        let a = self
            .agent(agent)
            .ok_or_else(|| missing(t("server.agent.noAgent", &[("id", agent.into())]), LookIn::Agent))?;
        let Some(from) = &a.from else {
            return Err(refused(t("server.agent.template.notFrom", &[("name", a.name.clone().into())])));
        };
        let item = self.template_of_async(&from.template).await.ok_or_else(|| {
            refused(t(
                "server.agent.template.gone",
                &[("name", a.name.clone().into()), ("template", from.template.clone().into())],
            ))
        })?;
        let next = with_cast(updated_from(&item, &a));
        self.change_async(|s| {
            s.agents = upsert(&s.agents, next.clone(), |a| &a.id);
            Ok(())
        })
        .await?;
        self.saved(next)
    }

    pub async fn add_template_async(&self, path: &str) -> Result<AgentTemplate, ApiError> {
        let item = read_template_async(Path::new(path), AgentTemplateSource::Added).await.map_err(refused)?;
        if self.template_of_async(&item.id).await.is_some() {
            return Err(refused(t("server.agent.template.taken", &[("id", item.id.into())])));
        }
        copy_template_async(Path::new(path), &self.home, &item.id)
            .await
            .map_err(|e| refused(t("server.agent.notSaved", &[("file", path.into()), ("why", e.to_string().into())])))?;
        Ok(AgentTemplate { installed: vec![], ..item })
    }

    pub async fn remove_template_async(&self, id: &str) -> Result<(), ApiError> {
        let item = self.deletable_template_async(id).await?;
        match tokio::fs::remove_dir_all(added_dir(&self.home).join(&item.id)).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(refused(t("server.agent.notSaved", &[("file", id.into()), ("why", e.to_string().into())])))
            }
            _ => Ok(()),
        }
    }

    pub async fn preview_remove_template_async(&self, id: &str) -> Result<Preview, ApiError> {
        let item = self.deletable_template_async(id).await?;
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

    #[test]
    fn worker_avatar_assignment_is_deterministic_and_avoids_collisions() {
        let mut a1 = profile_of(&built_in_templates()[1], "ext-1".into(), "W-01".into(), "Ext 1".into());
        a1.look.avatar = None;
        let first = assign_worker_avatar("ext-1", "Ext 1", &[]);
        let second = assign_worker_avatar("ext-1", "Ext 1", &[]);
        assert_eq!(first, second);
        assert!(WORKER_ROLE_AVATARS.contains(&first.as_str()));

        a1.look.avatar = Some(first.clone());
        let avoided = assign_worker_avatar("ext-1", "Ext 1", &[a1]);
        assert_ne!(avoided, first);
    }

    #[test]
    fn code_allocation_assigns_unique_o_and_w_codes() {
        let mut list = vec![
            profile_of(&built_in_templates()[0], "default".into(), String::new(), "Coordinator".into()),
            profile_of(&built_in_templates()[1], "dev".into(), "W-02".into(), "Dev".into()),
            profile_of(&built_in_templates()[1], "qa".into(), "W-02".into(), "QA".into()),
        ];
        ensure_agent_codes(&mut list);
        assert_eq!(list[0].code, "O-01");
        assert_eq!(list[1].code, "W-02");
        assert_eq!(list[2].code, "W-01");
    }
}
