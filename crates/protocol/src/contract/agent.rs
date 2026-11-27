#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum AgentProblemLevel {
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "warn")]
    Warn,
}

impl AgentProblemLevel {
    pub const ALL: [AgentProblemLevel; 2] = [AgentProblemLevel::Error, AgentProblemLevel::Warn];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentProblemLevel::Error => "error",
            AgentProblemLevel::Warn => "warn",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentProblem {
    pub field: String,
    pub level: AgentProblemLevel,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum PersonaMode {
    #[serde(rename = "append")]
    Append,
    #[serde(rename = "replace")]
    Replace,
    #[serde(rename = "prompt")]
    Prompt,
}

impl PersonaMode {
    pub const ALL: [PersonaMode; 3] = [PersonaMode::Append, PersonaMode::Replace, PersonaMode::Prompt];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            PersonaMode::Append => "append",
            PersonaMode::Replace => "replace",
            PersonaMode::Prompt => "prompt",
        }
    }
}

/// Capability groups controlling which built-in farm tools an agent profile can call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Toolset {
    #[serde(rename = "issue")]
    Issue,
    #[serde(rename = "session")]
    Session,
    #[serde(rename = "channel")]
    Channel,
    #[serde(rename = "repo")]
    Repo,
    #[serde(rename = "cron")]
    Cron,
    #[serde(rename = "resource")]
    Resource,
    #[serde(rename = "memory")]
    Memory,
    #[serde(rename = "media")]
    Media,
    #[serde(rename = "library")]
    Library,
    #[serde(rename = "note")]
    Note,
}

impl Toolset {
    pub const ALL: [Toolset; 10] = [
        Toolset::Issue,
        Toolset::Session,
        Toolset::Channel,
        Toolset::Repo,
        Toolset::Cron,
        Toolset::Resource,
        Toolset::Memory,
        Toolset::Media,
        Toolset::Library,
        Toolset::Note,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Toolset::Issue => "issue",
            Toolset::Session => "session",
            Toolset::Channel => "channel",
            Toolset::Repo => "repo",
            Toolset::Cron => "cron",
            Toolset::Resource => "resource",
            Toolset::Memory => "memory",
            Toolset::Media => "media",
            Toolset::Library => "library",
            Toolset::Note => "note",
        }
    }

    /// Default enabled toolsets for an agent role.
    pub fn defaults_for(role: AgentRole) -> Vec<Toolset> {
        match role {
            AgentRole::Orchestrator => Self::ALL.to_vec(),
            AgentRole::Worker => vec![
                Toolset::Issue,
                Toolset::Session,
                Toolset::Channel,
                Toolset::Resource,
                Toolset::Memory,
                Toolset::Library,
                Toolset::Note,
            ],
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MCPServerStdio {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MCPServerHTTP {
    pub name: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

/// Told apart by `type`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "type")]
pub enum MCPServer {
    #[serde(rename = "stdio")]
    Stdio(MCPServerStdio),
    #[serde(rename = "http")]
    Http(MCPServerHTTP),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Species {
    #[serde(rename = "bear")]
    Bear,
    #[serde(rename = "rabbit")]
    Rabbit,
    #[serde(rename = "fox")]
    Fox,
    #[serde(rename = "cat")]
    Cat,
    #[serde(rename = "owl")]
    Owl,
    #[serde(rename = "hedgehog")]
    Hedgehog,
    #[serde(rename = "raccoon")]
    Raccoon,
}

impl Species {
    pub const ALL: [Species; 7] = [
        Species::Bear,
        Species::Rabbit,
        Species::Fox,
        Species::Cat,
        Species::Owl,
        Species::Hedgehog,
        Species::Raccoon,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Species::Bear => "bear",
            Species::Rabbit => "rabbit",
            Species::Fox => "fox",
            Species::Cat => "cat",
            Species::Owl => "owl",
            Species::Hedgehog => "hedgehog",
            Species::Raccoon => "raccoon",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Outfit {
    #[serde(rename = "farmer")]
    Farmer,
    #[serde(rename = "gardener")]
    Gardener,
    #[serde(rename = "rain")]
    Rain,
    #[serde(rename = "winter")]
    Winter,
}

impl Outfit {
    pub const ALL: [Outfit; 4] = [Outfit::Farmer, Outfit::Gardener, Outfit::Rain, Outfit::Winter];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Outfit::Farmer => "farmer",
            Outfit::Gardener => "gardener",
            Outfit::Rain => "rain",
            Outfit::Winter => "winter",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Build {
    #[serde(rename = "biped")]
    Biped,
    #[serde(rename = "treads")]
    Treads,
    #[serde(rename = "wheel")]
    Wheel,
    #[serde(rename = "hopper")]
    Hopper,
    #[serde(rename = "hover")]
    Hover,
}

impl Build {
    pub const ALL: [Build; 5] = [Build::Biped, Build::Treads, Build::Wheel, Build::Hopper, Build::Hover];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Build::Biped => "biped",
            Build::Treads => "treads",
            Build::Wheel => "wheel",
            Build::Hopper => "hopper",
            Build::Hover => "hover",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Head {
    #[serde(rename = "rounded")]
    Rounded,
    #[serde(rename = "terminal")]
    Terminal,
    #[serde(rename = "dome")]
    Dome,
    #[serde(rename = "orb")]
    Orb,
    #[serde(rename = "saucer")]
    Saucer,
}

impl Head {
    pub const ALL: [Head; 5] = [Head::Rounded, Head::Terminal, Head::Dome, Head::Orb, Head::Saucer];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Head::Rounded => "rounded",
            Head::Terminal => "terminal",
            Head::Dome => "dome",
            Head::Orb => "orb",
            Head::Saucer => "saucer",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum OrchestratorLook {
    #[serde(rename = "farmer")]
    Farmer,
    #[serde(rename = "foreman")]
    Foreman,
    #[serde(rename = "auntie")]
    Auntie,
    #[serde(rename = "grandpa")]
    Grandpa,
    #[serde(rename = "gardener")]
    Gardener,
    #[serde(rename = "robot")]
    Robot,
}

impl OrchestratorLook {
    pub const ALL: [OrchestratorLook; 6] = [
        OrchestratorLook::Farmer,
        OrchestratorLook::Foreman,
        OrchestratorLook::Auntie,
        OrchestratorLook::Grandpa,
        OrchestratorLook::Gardener,
        OrchestratorLook::Robot,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            OrchestratorLook::Farmer => "farmer",
            OrchestratorLook::Foreman => "foreman",
            OrchestratorLook::Auntie => "auntie",
            OrchestratorLook::Grandpa => "grandpa",
            OrchestratorLook::Gardener => "gardener",
            OrchestratorLook::Robot => "robot",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Look {
    /// null until the server fills it from the id.
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub species: Option<Species>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub outfit: Option<Outfit>,
    /// An orchestrator's look (default is farmer). A helper has null.
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub orchestrator: Option<OrchestratorLook>,
    pub build: Build,
    pub head: Head,
    pub body: String,
    pub trim: String,
    pub hat: String,
    pub eye: String,
    /// Optional portrait asset id (`avatar-*`), used instead of the default species portrait when set.
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum TemplateCategory {
    Engineering,
    Product,
    Research,
    Orchestration,
}

impl TemplateCategory {
    pub const ALL: [TemplateCategory; 4] = [
        TemplateCategory::Engineering,
        TemplateCategory::Product,
        TemplateCategory::Research,
        TemplateCategory::Orchestration,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateCategory::Engineering => "engineering",
            TemplateCategory::Product => "product",
            TemplateCategory::Research => "research",
            TemplateCategory::Orchestration => "orchestration",
        }
    }
}

/// Where a profile came from: a template's id and the version it had then.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentFrom {
    pub template: String,
    pub version: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: AgentRole,
    /// What it does, in a sentence (duty): orchestrators read it to pick who takes a job.
    pub duty: String,
    pub enabled: bool,
    pub runtime: String,
    /// Target execution host id when pinned to a specific machine; omitted lets the control plane route.
    #[serde(default)]
    pub machine_id: Option<String>,
    pub model: String,
    pub effort: String,
    pub persona: String,
    pub persona_mode: PersonaMode,
    pub skills: Vec<String>,
    #[serde(default)]
    pub toolsets: Vec<Toolset>,
    pub mcp_servers: Vec<MCPServer>,
    pub disallowed_tools: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub workdir: String,
    pub worktree: bool,
    pub tags: Vec<String>,
    pub look: Look,
    /// Optional MOSS voice ID paired with serialized channel report playback.
    #[serde(default)]
    pub voice: Option<String>,
    /// The template it was installed from, at that template's version; none for one made by hand.
    pub from: Option<AgentFrom>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum AgentTemplateSource {
    #[serde(rename = "builtIn")]
    BuiltIn,
    #[serde(rename = "added")]
    Added,
}

impl AgentTemplateSource {
    pub const ALL: [AgentTemplateSource; 2] = [AgentTemplateSource::BuiltIn, AgentTemplateSource::Added];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentTemplateSource::BuiltIn => "builtIn",
            AgentTemplateSource::Added => "added",
        }
    }
}

/// A recipe for a profile (agent.json and persona.md in a folder), in the farm's language: installing it makes a profile.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplate {
    pub id: String,
    /// Raised when the template changes: a profile installed at a lower one has an update.
    pub version: i64,
    pub role: AgentRole,
    pub name: String,
    pub duty: String,
    pub tags: Vec<String>,
    /// The runtime it is written for.
    pub runtime: String,
    pub model: String,
    pub effort: String,
    pub persona_mode: PersonaMode,
    pub worktree: bool,
    pub look: Look,
    pub persona: String,
    pub source: AgentTemplateSource,
    /// Built-in role category (`engineering`, `product`, `research`, `orchestration`).
    pub category: Option<TemplateCategory>,
    /// Concise summary of this template's working style and strengths.
    pub style: Option<String>,
    /// The built-in skills a profile installed from it has ticked, by id.
    pub skills: Vec<String>,
    /// The profiles installed from it, by id.
    pub installed: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentValidateRequest {
    pub agents: Vec<Agent>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentValidation {
    pub id: String,
    pub problems: Vec<AgentProblem>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    /// Shipped with VibeValley (apps/server/src/agent/skills): read-only, changed only by updating VibeValley.
    pub built_in: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentDeleteInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateInstallInput {
    pub id: String,
    pub runtime: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateUpdateInput {
    pub agent: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateAddInput {
    pub path: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SkillDeleteInput {
    pub id: String,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "agent";
    types: [AgentProblemLevel,
    AgentProblem,
    PersonaMode,
    Toolset,
    MCPServerStdio,
    MCPServerHTTP,
    MCPServer,
    Species,
    Outfit,
    Build,
    Head,
    OrchestratorLook,
    Look,
    AgentFrom,
    Agent,
    AgentTemplateSource,
    TemplateCategory,
    AgentTemplate,
    AgentValidateRequest,
    AgentValidation,
    Skill,
    AgentDeleteInput,
    AgentTemplateInstallInput,
    AgentTemplateUpdateInput,
    AgentTemplateAddInput,
    SkillDeleteInput];
    aliases: [];
}
