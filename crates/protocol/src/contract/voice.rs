#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum CallState {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "connecting")]
    Connecting,
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "ending")]
    Ending,
    #[serde(rename = "error")]
    Error,
}

impl CallState {
    pub const ALL: [CallState; 5] = [CallState::Idle, CallState::Connecting, CallState::Live, CallState::Ending, CallState::Error];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            CallState::Idle => "idle",
            CallState::Connecting => "connecting",
            CallState::Live => "live",
            CallState::Ending => "ending",
            CallState::Error => "error",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactCallChanged {
    pub at: i64,
    pub state: CallState,
    pub reason: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceCall {
    pub agent_id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceGrant {
    pub channel: String,
    pub uid: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    pub persona: String,
    pub greeting: String,
}

/// A change to the voice settings: the keys it names.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdateVoice {
    pub persona: Option<String>,
    pub greeting: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceSaid {
    pub agent_id: String,
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceHeard {
    pub agent_id: String,
    pub text: String,
    /// The profile the user picked; absent for none.
    pub agent: Option<String>,
    pub send_key: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceCallStart {
    pub channel: String,
    pub uid: String,
    /// The call answers a ring: what rang, which the orchestrator says first instead of the greeting.
    pub about: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceHearInput {
    pub text: String,
    pub agent: Option<String>,
    pub send_key: Option<String>,
}

/// Credentials identifying an active server-tracked ASR dictation session.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceAsrGrant {
    pub session_id: String,
    pub model: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceAsrStopInput {
    pub session_id: String,
}

/// WAV audio payload submitted for one-shot MOSS transcription (`voice.asr.transcribe`).
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceAsrTranscribeInput {
    pub wav_base64: String,
    pub session_id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct VoiceAsrResult {
    pub text: String,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "voice";
    types: [CallState,
    FactCallChanged,
    VoiceCall,
    VoiceGrant,
    VoiceSettings,
    SettingsUpdateVoice,
    VoiceSaid,
    VoiceHeard,
    VoiceCallStart,
    VoiceHearInput,
    VoiceAsrGrant,
    VoiceAsrStopInput,
    VoiceAsrTranscribeInput,
    VoiceAsrResult];
    aliases: [];
}
