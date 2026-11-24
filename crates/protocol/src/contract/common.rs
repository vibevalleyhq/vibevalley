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

/// An artifact's id.
pub type ArtifactId = String;

/// A suggested change to an artifact file.
pub type SuggestionId = String;

pub type MessageId = String;

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

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "common";
    types: [Validation,
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
    Locale];
    aliases: [];
}
