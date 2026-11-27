#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::wire::*;

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MemorySourceInfo {
    pub name: String,
    pub label: String,
    pub on: bool,
    pub off: String,
    pub can_list: bool,
    pub can_forget: bool,
    pub transcripts: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MemorySourceKind {
    #[serde(rename = "nowledge")]
    Nowledge,
    #[serde(rename = "everos")]
    Everos,
}

impl MemorySourceKind {
    pub const ALL: [MemorySourceKind; 2] = [MemorySourceKind::Nowledge, MemorySourceKind::Everos];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MemorySourceKind::Nowledge => "nowledge",
            MemorySourceKind::Everos => "everos",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    pub kind: MemorySourceKind,
    pub url: String,
    pub enabled: bool,
    pub read: bool,
    pub write: bool,
    pub everything: bool,
    pub user: Option<String>,
    pub key: KeyStatus,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SpacePaths {
    pub repos: String,
    /// Named `<repo>.<issue number>`.
    pub worktrees: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Missing {
    #[serde(rename = "deepseekKey")]
    DeepseekKey,
    #[serde(rename = "mossAccount")]
    MossAccount,
    #[serde(rename = "mossKey")]
    MossKey,
    #[serde(rename = "mossOff")]
    MossOff,
    #[serde(rename = "binding")]
    Binding,
}

impl Missing {
    pub const ALL: [Missing; 5] = [Missing::DeepseekKey, Missing::MossAccount, Missing::MossKey, Missing::MossOff, Missing::Binding];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Missing::DeepseekKey => "deepseekKey",
            Missing::MossAccount => "mossAccount",
            Missing::MossKey => "mossKey",
            Missing::MossOff => "mossOff",
            Missing::Binding => "binding",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(untagged)]
pub enum Readiness {
    True { ready: LitTrue },
    False { ready: LitFalse, missing: Missing },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum Feature {
    #[serde(rename = "orchestrator")]
    Orchestrator,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "understanding")]
    Understanding,
    #[serde(rename = "speech")]
    Speech,
    #[serde(rename = "speakers")]
    Speakers,
    #[serde(rename = "voiceDesign")]
    VoiceDesign,
    #[serde(rename = "transcription")]
    Transcription,
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "vision")]
    Vision,
    #[serde(rename = "call")]
    Call,
}

impl Feature {
    pub const ALL: [Feature; 10] = [
        Feature::Orchestrator,
        Feature::Image,
        Feature::Understanding,
        Feature::Speech,
        Feature::Speakers,
        Feature::VoiceDesign,
        Feature::Transcription,
        Feature::Live,
        Feature::Vision,
        Feature::Call,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Feature::Orchestrator => "orchestrator",
            Feature::Image => "image",
            Feature::Understanding => "understanding",
            Feature::Speech => "speech",
            Feature::Speakers => "speakers",
            Feature::VoiceDesign => "voiceDesign",
            Feature::Transcription => "transcription",
            Feature::Live => "live",
            Feature::Vision => "vision",
            Feature::Call => "call",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub display_name: Option<String>,
    pub avatar_attachment_id: Option<String>,
    pub avatar_preset: Option<String>,
    pub tagline: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SettingsStatus {
    pub file: String,
    pub home: String,
    pub paths: SpacePaths,
    pub version: String,
    pub locale: Locale,
    pub deepseek_api_key: KeyStatus,
    pub github_token: KeyStatus,
    pub voice: VoiceSettings,
    pub voice_defaults: VoiceSettings,
    /// Local configuration check only; does not probe remote endpoints.
    #[cfg_attr(feature = "ts-gen", ts(type = "Record<Feature, Readiness>"))]
    pub readiness: BTreeMap<Feature, Readiness>,
    pub memory_sources: Vec<MemorySource>,
    pub profile: Option<UserProfile>,
    pub storage_backend: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MemorySourceUpdate {
    pub kind: MemorySourceKind,
    pub url: String,
    pub enabled: bool,
    pub read: bool,
    pub write: bool,
    pub everything: Option<bool>,
    pub user: Option<String>,
    pub key: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub locale: Option<Locale>,
    pub deepseek_api_key: Option<String>,
    pub github_token: Option<String>,
    pub voice: Option<SettingsUpdateVoice>,
    pub memory_sources: Option<Vec<MemorySourceUpdate>>,
    pub profile: Option<UserProfile>,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "setting";
    types: [MemorySourceInfo,
    MemorySourceKind,
    MemorySource,
    SpacePaths,
    Missing,
    Readiness,
    Feature,
    UserProfile,
    SettingsStatus,
    MemorySourceUpdate,
    SettingsUpdate];
    aliases: [];
}
