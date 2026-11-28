#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use crate::wire::*;

/// An issue's id (not its number).
pub type IssueId = String;

/// A session's id: w1, w2…, for the whole life of the farm.
pub type SessionId = String;

/// A note's id.
pub type NoteId = String;

/// A suggested change to a note file.
pub type SuggestionId = String;

pub type MessageId = String;

/// Unified collaboration participant identity across humans, agent profiles, and live sessions.
/// Canonical wire format: `user:<id>` · `agent:<profile>` · `session:<id>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ParticipantId {
    User(String),
    Agent(String),
    Session(String),
}

impl ParticipantId {
    pub fn user(id: impl Into<String>) -> Self {
        Self::User(id.into())
    }

    pub fn agent(profile: impl Into<String>) -> Self {
        Self::Agent(profile.into())
    }

    pub fn session(id: impl Into<String>) -> Self {
        Self::Session(id.into())
    }

    /// Default interactive local user (`user:self`).
    pub fn local_user() -> Self {
        Self::User("self".to_owned())
    }

    pub fn from_parts(kind: &str, id: impl Into<String>) -> Option<Self> {
        let id = id.into();
        if id.is_empty() {
            return None;
        }
        match kind {
            "user" => Some(Self::User(id)),
            "agent" => Some(Self::Agent(id)),
            "session" => Some(Self::Session(id)),
            _ => None,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        let (kind, id) = s.split_once(':')?;
        Self::from_parts(kind, id)
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::User(_) => "user",
            Self::Agent(_) => "agent",
            Self::Session(_) => "session",
        }
    }

    pub fn raw_id(&self) -> &str {
        match self {
            Self::User(id) | Self::Agent(id) | Self::Session(id) => id,
        }
    }

    pub fn is_human(&self) -> bool {
        matches!(self, Self::User(_))
    }

    pub fn is_agent(&self) -> bool {
        matches!(self, Self::Agent(_) | Self::Session(_))
    }
}

impl std::fmt::Display for ParticipantId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.kind_str(), self.raw_id())
    }
}

impl std::str::FromStr for ParticipantId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s).ok_or_else(|| format!("invalid ParticipantId {s:?}; expected user:<id>, agent:<profile>, or session:<id>"))
    }
}

impl Serialize for ParticipantId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ParticipantId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        s.parse::<Self>().map_err(serde::de::Error::custom)
    }
}

#[cfg(feature = "ts-gen")]
impl TS for ParticipantId {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &ts_rs::Config) -> String {
        "ParticipantId".to_owned()
    }

    fn inline(cfg: &ts_rs::Config) -> String {
        Self::name(cfg)
    }

    fn decl(_: &ts_rs::Config) -> String {
        "type ParticipantId = `user:${string}` | `agent:${string}` | `session:${string}`;".to_owned()
    }
}

/// What checking a form before saving it found: the first thing that would be refused, if any.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub problem: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ActorKind {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "system")]
    System,
}

impl ActorKind {
    pub const ALL: [ActorKind; 3] = [ActorKind::User, ActorKind::Agent, ActorKind::System];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ActorKind::User => "user",
            ActorKind::Agent => "agent",
            ActorKind::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum AgentRole {
    #[serde(rename = "orchestrator")]
    Orchestrator,
    #[serde(rename = "worker")]
    Worker,
}

impl AgentRole {
    pub const ALL: [AgentRole; 2] = [AgentRole::Orchestrator, AgentRole::Worker];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentRole::Orchestrator => "orchestrator",
            AgentRole::Worker => "worker",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum Actor {
    #[serde(rename = "user", rename_all = "camelCase")]
    User { id: String, name: Option<String> },
    #[serde(rename = "agent", rename_all = "camelCase")]
    Agent {
        id: String,
        role: AgentRole,
        name: Option<String>,
        for_user: Option<bool>,
    },
    #[serde(rename = "system", rename_all = "camelCase")]
    System { id: String, name: Option<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Outcome {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "interrupted")]
    Interrupted,
}

impl Outcome {
    pub const ALL: [Outcome; 3] = [Outcome::Completed, Outcome::Failed, Outcome::Interrupted];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Failed => "failed",
            Outcome::Interrupted => "interrupted",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Spent {
    pub tokens: i64,
    pub cny: Option<JsNumber>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Retry {
    pub attempt: i64,
    pub of: Option<i64>,
}

/// What a command that changes things would do, as its dry run answers it (an endpoint's `dryRun`): nothing was changed.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// What it would do, in order, one step a line.
    pub does: Vec<String>,
}

/// A change with nothing to answer but when it shows (issue.comment.create).
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub seq: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum KeySource {
    #[serde(rename = "settings")]
    Settings,
    #[serde(rename = "config")]
    Config,
}

impl KeySource {
    pub const ALL: [KeySource; 2] = [KeySource::Settings, KeySource::Config];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            KeySource::Settings => "settings",
            KeySource::Config => "config",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub source: Option<KeySource>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Locale {
    #[serde(rename = "zh")]
    Zh,
    #[serde(rename = "en")]
    En,
}

impl Locale {
    pub const ALL: [Locale; 2] = [Locale::Zh, Locale::En];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Locale::Zh => "zh",
            Locale::En => "en",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum CompareAnnotationSide {
    #[serde(rename = "before")]
    Before,
    #[serde(rename = "after")]
    After,
    #[serde(rename = "both")]
    Both,
}

impl CompareAnnotationSide {
    pub const ALL: [CompareAnnotationSide; 3] = [CompareAnnotationSide::Before, CompareAnnotationSide::After, CompareAnnotationSide::Both];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            CompareAnnotationSide::Before => "before",
            CompareAnnotationSide::After => "after",
            CompareAnnotationSide::Both => "both",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum CompareAnnotationTone {
    #[serde(rename = "issue")]
    Issue,
    #[serde(rename = "fixed")]
    Fixed,
    #[serde(rename = "note")]
    Note,
}

impl CompareAnnotationTone {
    pub const ALL: [CompareAnnotationTone; 3] = [CompareAnnotationTone::Issue, CompareAnnotationTone::Fixed, CompareAnnotationTone::Note];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            CompareAnnotationTone::Issue => "issue",
            CompareAnnotationTone::Fixed => "fixed",
            CompareAnnotationTone::Note => "note",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CompareImage {
    pub attachment: Option<String>,
    pub url: Option<String>,
    pub label: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CompareAnnotation {
    pub n: i64,
    pub side: Option<CompareAnnotationSide>,
    pub rect: [f64; 4],
    pub tone: Option<CompareAnnotationTone>,
    pub note: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CompareSpec {
    pub title: Option<String>,
    pub before: Option<CompareImage>,
    pub after: Option<CompareImage>,
    pub image: Option<CompareImage>,
    pub annotations: Option<Vec<CompareAnnotation>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompareMarkdownSegment {
    #[serde(rename_all = "camelCase")]
    Markdown { text: String },
    #[serde(rename_all = "camelCase")]
    Compare { raw: String, spec: CompareSpec },
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "common";
    types: [ParticipantId,
    Validation,
    ActorKind,
    AgentRole,
    Actor,
    Outcome,
    Spent,
    Retry,
    Preview,
    Applied,
    KeySource,
    KeyStatus,
    Locale,
    CompareAnnotationSide,
    CompareAnnotationTone,
    CompareImage,
    CompareAnnotation,
    CompareSpec,
    CompareMarkdownSegment];
    aliases: [];
}
