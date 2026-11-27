#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ModelCapability {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "asr")]
    Asr,
    #[serde(rename = "tts")]
    Tts,
    #[serde(rename = "realtime")]
    Realtime,
    #[serde(rename = "vision")]
    Vision,
    #[serde(rename = "image")]
    Image,
}

impl ModelCapability {
    pub const ALL: [ModelCapability; 6] = [
        ModelCapability::Chat,
        ModelCapability::Asr,
        ModelCapability::Tts,
        ModelCapability::Realtime,
        ModelCapability::Vision,
        ModelCapability::Image,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ModelCapability::Chat => "chat",
            ModelCapability::Asr => "asr",
            ModelCapability::Tts => "tts",
            ModelCapability::Realtime => "realtime",
            ModelCapability::Vision => "vision",
            ModelCapability::Image => "image",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub owner: String,
    #[serde(default)]
    pub capabilities: Vec<ModelCapability>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ProviderConnectionAdapter {
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "minimax")]
    MiniMax,
    #[serde(rename = "moss")]
    Moss,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
}

impl ProviderConnectionAdapter {
    pub const ALL: [ProviderConnectionAdapter; 5] = [
        ProviderConnectionAdapter::DeepSeek,
        ProviderConnectionAdapter::MiniMax,
        ProviderConnectionAdapter::Moss,
        ProviderConnectionAdapter::OpenAi,
        ProviderConnectionAdapter::Anthropic,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderConnectionAdapter::DeepSeek => "deepseek",
            ProviderConnectionAdapter::MiniMax => "minimax",
            ProviderConnectionAdapter::Moss => "moss",
            ProviderConnectionAdapter::OpenAi => "openai",
            ProviderConnectionAdapter::Anthropic => "anthropic",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ProviderVerificationStatus {
    #[default]
    #[serde(rename = "unverified")]
    Unverified,
    #[serde(rename = "verified")]
    Verified,
    #[serde(rename = "failed")]
    Failed,
}

impl ProviderVerificationStatus {
    pub const ALL: [ProviderVerificationStatus; 3] = [
        ProviderVerificationStatus::Unverified,
        ProviderVerificationStatus::Verified,
        ProviderVerificationStatus::Failed,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderVerificationStatus::Unverified => "unverified",
            ProviderVerificationStatus::Verified => "verified",
            ProviderVerificationStatus::Failed => "failed",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderVerification {
    pub status: ProviderVerificationStatus,
    pub checked_at: Option<i64>,
    pub error: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnection {
    pub id: String,
    pub name: String,
    pub adapter: ProviderConnectionAdapter,
    pub enabled: bool,
    pub key: KeyStatus,
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    pub verification: Option<ProviderVerification>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderBinding {
    pub connection: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ProviderScene {
    #[serde(rename = "orchestrator")]
    Orchestrator,
    #[serde(rename = "polish")]
    Polish,
    #[serde(rename = "transcription")]
    Transcription,
    #[serde(rename = "speech")]
    Speech,
    #[serde(rename = "speakers")]
    Speakers,
    #[serde(rename = "voiceDesign")]
    VoiceDesign,
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "vision")]
    Vision,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "understanding")]
    Understanding,
}

impl ProviderScene {
    pub const ALL: [ProviderScene; 10] = [
        ProviderScene::Orchestrator,
        ProviderScene::Polish,
        ProviderScene::Transcription,
        ProviderScene::Speech,
        ProviderScene::Speakers,
        ProviderScene::VoiceDesign,
        ProviderScene::Live,
        ProviderScene::Vision,
        ProviderScene::Image,
        ProviderScene::Understanding,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderScene::Orchestrator => "orchestrator",
            ProviderScene::Polish => "polish",
            ProviderScene::Transcription => "transcription",
            ProviderScene::Speech => "speech",
            ProviderScene::Speakers => "speakers",
            ProviderScene::VoiceDesign => "voiceDesign",
            ProviderScene::Live => "live",
            ProviderScene::Vision => "vision",
            ProviderScene::Image => "image",
            ProviderScene::Understanding => "understanding",
        }
    }

    pub fn required_capability(self) -> ModelCapability {
        match self {
            ProviderScene::Orchestrator | ProviderScene::Polish => ModelCapability::Chat,
            ProviderScene::Transcription => ModelCapability::Asr,
            ProviderScene::Speech | ProviderScene::Speakers | ProviderScene::VoiceDesign => ModelCapability::Tts,
            ProviderScene::Live => ModelCapability::Realtime,
            ProviderScene::Vision | ProviderScene::Understanding => ModelCapability::Vision,
            ProviderScene::Image => ModelCapability::Image,
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderScenePolicy {
    pub scene: ProviderScene,
    #[serde(default)]
    pub fallbacks: Vec<ProviderBinding>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub revision: i64,
    pub connections: Vec<ProviderConnection>,
    #[serde(default)]
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub orchestrator: Option<ProviderBinding>,
    #[serde(default)]
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub polish: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub image: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub live: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub speakers: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub voice_design: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub transcription: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub vision: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub understanding: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub speech: Option<ProviderBinding>,
    #[serde(default)]
    pub scene_policies: Vec<ProviderScenePolicy>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionUpdate {
    pub id: String,
    pub name: String,
    pub adapter: ProviderConnectionAdapter,
    pub enabled: bool,
    /// Omitted keeps the credential; null clears it; a nonempty string replaces it.
    #[serde(default, with = "::serde_with::rust::double_option")]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, as = "Option<String>"))]
    pub key: Option<Option<String>>,
    /// Omitted keeps the base URL; null clears it; a nonempty string replaces it.
    #[serde(default, with = "::serde_with::rust::double_option")]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, as = "Option<String>"))]
    pub base_url: Option<Option<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpdate {
    pub revision: i64,
    pub connections: Vec<ProviderConnectionUpdate>,
    #[serde(default)]
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub orchestrator: Option<ProviderBinding>,
    #[serde(default)]
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub polish: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub speech: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub understanding: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub image: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub live: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub speakers: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub voice_design: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub transcription: Option<ProviderBinding>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub vision: Option<ProviderBinding>,
    #[serde(default)]
    pub scene_policies: Vec<ProviderScenePolicy>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderVerifyRequest {
    pub connection: String,
    pub revision: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelRequest {
    pub connection: String,
    pub revision: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderVoiceRequest {
    pub connection: String,
    pub revision: i64,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub after: Option<String>,
    pub status: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderVoiceListingVoices {
    pub id: String,
    pub name: String,
    pub created_at_seconds: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderVoiceListing {
    pub connection: String,
    pub revision: i64,
    pub voices: Vec<ProviderVoiceListingVoices>,
    pub has_more: bool,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub next_cursor: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelListing {
    pub connection: String,
    pub revision: i64,
    pub models: Vec<ProviderModel>,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "provider";
    types: [ModelCapability,
    ProviderModel,
    ProviderConnectionAdapter,
    ProviderVerificationStatus,
    ProviderVerification,
    ProviderConnection,
    ProviderBinding,
    ProviderScene,
    ProviderScenePolicy,
    ProviderStatus,
    ProviderConnectionUpdate,
    ProviderUpdate,
    ProviderVerifyRequest,
    ProviderModelRequest,
    ProviderVoiceRequest,
    ProviderVoiceListingVoices,
    ProviderVoiceListing,
    ProviderModelListing];
    aliases: [];
}
