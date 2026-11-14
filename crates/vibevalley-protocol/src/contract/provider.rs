#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

#[allow(unused_imports)]
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use ts_rs::TS;

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::wire::*;

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub owner: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum ProviderConnectionAdapter {
    #[serde(rename = "moss")]
    Moss,
}

impl ProviderConnectionAdapter {
    pub const ALL: [ProviderConnectionAdapter; 1] = [ProviderConnectionAdapter::Moss];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderConnectionAdapter::Moss => "moss",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnection {
    pub id: String,
    pub name: String,
    pub adapter: ProviderConnectionAdapter,
    pub enabled: bool,
    pub key: KeyStatus,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBinding {
    pub connection: String,
    pub model: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub revision: i64,
    pub connections: Vec<ProviderConnection>,
    #[serialize_always]
    #[ts(optional = false)]
    pub dictation: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub image: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub live: Option<ProviderBinding>,
    pub live_models: Vec<String>,
    #[serialize_always]
    #[ts(optional = false)]
    pub speakers: Option<ProviderBinding>,
    pub speakers_models: Vec<String>,
    #[serialize_always]
    #[ts(optional = false)]
    pub voice_design: Option<ProviderBinding>,
    pub voice_design_models: Vec<String>,
    #[serialize_always]
    #[ts(optional = false)]
    pub transcription: Option<ProviderBinding>,
    pub transcription_models: Vec<String>,
    #[serialize_always]
    #[ts(optional = false)]
    pub vision: Option<ProviderBinding>,
    pub vision_models: Vec<String>,
    pub dictation_models: Vec<String>,
    pub image_models: Vec<String>,
    #[serialize_always]
    #[ts(optional = false)]
    pub understanding: Option<ProviderBinding>,
    pub understanding_models: Vec<String>,
    #[serialize_always]
    #[ts(optional = false)]
    pub speech: Option<ProviderBinding>,
    pub speech_models: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionUpdate {
    pub id: String,
    pub name: String,
    pub adapter: ProviderConnectionAdapter,
    pub enabled: bool,
    /// Omitted keeps the credential; null clears it; a nonempty string replaces it.
    #[serde(default, with = "::serde_with::rust::double_option")]
    #[ts(optional = nullable, as = "Option<String>")]
    pub key: Option<Option<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpdate {
    #[serialize_always]
    #[ts(optional = false)]
    pub speech: Option<ProviderBinding>,
    pub revision: i64,
    pub connections: Vec<ProviderConnectionUpdate>,
    #[serialize_always]
    #[ts(optional = false)]
    pub understanding: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub dictation: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub image: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub live: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub speakers: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub voice_design: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub transcription: Option<ProviderBinding>,
    #[serialize_always]
    #[ts(optional = false)]
    pub vision: Option<ProviderBinding>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelRequest {
    pub connection: String,
    pub revision: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderVoiceListingVoices {
    pub id: String,
    pub name: String,
    pub created_at_seconds: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderVoiceListing {
    pub connection: String,
    pub revision: i64,
    pub voices: Vec<ProviderVoiceListingVoices>,
    pub has_more: bool,
    #[serialize_always]
    #[ts(optional = false)]
    pub next_cursor: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelListing {
    pub connection: String,
    pub revision: i64,
    pub models: Vec<ProviderModel>,
}

crate::typescript::module! {
    "provider";
    types: [ProviderModel,
    ProviderConnectionAdapter,
    ProviderConnection,
    ProviderBinding,
    ProviderStatus,
    ProviderConnectionUpdate,
    ProviderUpdate,
    ProviderModelRequest,
    ProviderVoiceRequest,
    ProviderVoiceListingVoices,
    ProviderVoiceListing,
    ProviderModelListing];
    aliases: [];
}
