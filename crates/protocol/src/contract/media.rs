#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::wire::*;

pub type Id = String;

pub type VoiceId = String;

pub type SpeakerId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaAudioFormat {
    #[serde(rename = "wav")]
    Wav,
    #[serde(rename = "mp3")]
    Mp3,
    #[serde(rename = "flac")]
    Flac,
    #[serde(rename = "aac")]
    Aac,
    #[serde(rename = "opus")]
    Opus,
    #[serde(rename = "pcm")]
    Pcm,
}

impl MediaAudioFormat {
    pub const ALL: [MediaAudioFormat; 6] = [
        MediaAudioFormat::Wav,
        MediaAudioFormat::Mp3,
        MediaAudioFormat::Flac,
        MediaAudioFormat::Aac,
        MediaAudioFormat::Opus,
        MediaAudioFormat::Pcm,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaAudioFormat::Wav => "wav",
            MediaAudioFormat::Mp3 => "mp3",
            MediaAudioFormat::Flac => "flac",
            MediaAudioFormat::Aac => "aac",
            MediaAudioFormat::Opus => "opus",
            MediaAudioFormat::Pcm => "pcm",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAudioAccountRequest {
    pub id: Id,
    pub connection: String,
    pub revision: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeakersRequestSpeakers {
    pub id: SpeakerId,
    pub voice: VoiceId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeakersRequestSegments {
    pub speaker: SpeakerId,
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeakersRequest {
    pub id: Id,
    pub connection: String,
    pub revision: i64,
    pub speakers: Vec<MediaSpeakersRequestSpeakers>,
    pub segments: Vec<MediaSpeakersRequestSegments>,
    pub format: MediaAudioFormat,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaVoiceDesignRequest {
    pub id: Id,
    pub connection: String,
    pub revision: i64,
    pub text: String,
    pub instruction: String,
    pub format: MediaAudioFormat,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaCloneRequest {
    pub id: Id,
    pub connection: String,
    pub revision: i64,
    pub input: String,
    pub name: Option<String>,
    pub consent: LitTrue,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaTranscriptionRequest {
    pub id: Id,
    pub connection: String,
    pub revision: i64,
    pub input: String,
    pub allow_upload: LitTrue,
    pub diarize: Option<bool>,
    pub keyterms: Option<Vec<String>>,
    pub streaming: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum MediaAudioRequest {
    #[serde(rename = "speakers", rename_all = "camelCase")]
    Speakers {
        id: Id,
        connection: String,
        revision: i64,
        speakers: Vec<MediaSpeakersRequestSpeakers>,
        segments: Vec<MediaSpeakersRequestSegments>,
        format: MediaAudioFormat,
    },
    #[serde(rename = "voiceDesign", rename_all = "camelCase")]
    VoiceDesign {
        id: Id,
        connection: String,
        revision: i64,
        text: String,
        instruction: String,
        format: MediaAudioFormat,
    },
    #[serde(rename = "clone", rename_all = "camelCase")]
    Clone {
        id: Id,
        connection: String,
        revision: i64,
        input: String,
        name: Option<String>,
        consent: LitTrue,
    },
    #[serde(rename = "transcription", rename_all = "camelCase")]
    Transcription {
        id: Id,
        connection: String,
        revision: i64,
        input: String,
        allow_upload: LitTrue,
        diarize: Option<bool>,
        keyterms: Option<Vec<String>>,
        streaming: Option<bool>,
    },
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAudioVoice {
    pub id: String,
    pub name: String,
    pub created_at_seconds: JsNumber,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAudioSegment {
    pub speaker: String,
    pub text: String,
    pub start: JsNumber,
    pub end: JsNumber,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum MediaAudioResult {
    #[serde(rename = "clone", rename_all = "camelCase")]
    Clone { voice: MediaAudioVoice },
    #[serde(rename = "transcription", rename_all = "camelCase")]
    Transcription { text: String, segments: Vec<MediaAudioSegment> },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum MediaSource {
    #[serde(rename = "user")]
    User {},
    #[serde(rename = "orchestrator", rename_all = "camelCase")]
    Orchestrator { agent: String, channel: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaPhase {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "generating")]
    Generating,
    #[serde(rename = "downloading")]
    Downloading,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "canceled")]
    Canceled,
    #[serde(rename = "download_failed")]
    DownloadFailed,
}

impl MediaPhase {
    pub const ALL: [MediaPhase; 8] = [
        MediaPhase::Queued,
        MediaPhase::Generating,
        MediaPhase::Downloading,
        MediaPhase::Ready,
        MediaPhase::Failed,
        MediaPhase::Unknown,
        MediaPhase::Canceled,
        MediaPhase::DownloadFailed,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaPhase::Queued => "queued",
            MediaPhase::Generating => "generating",
            MediaPhase::Downloading => "downloading",
            MediaPhase::Ready => "ready",
            MediaPhase::Failed => "failed",
            MediaPhase::Unknown => "unknown",
            MediaPhase::Canceled => "canceled",
            MediaPhase::DownloadFailed => "download_failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaAudioMetadataSource {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "provider")]
    Provider,
}

impl MediaAudioMetadataSource {
    pub const ALL: [MediaAudioMetadataSource; 2] = [MediaAudioMetadataSource::File, MediaAudioMetadataSource::Provider];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaAudioMetadataSource::File => "file",
            MediaAudioMetadataSource::Provider => "provider",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAudioMetadata {
    pub source: MediaAudioMetadataSource,
    pub sample_rate: Option<JsNumber>,
    pub duration: Option<JsNumber>,
    pub channels: Option<i64>,
    pub bit_depth: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAudioUsage {
    pub input_characters: Option<i64>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub input_audio_seconds: Option<JsNumber>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaInputKind {
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "video")]
    Video,
    #[serde(rename = "audio")]
    Audio,
}

impl MediaInputKind {
    pub const ALL: [MediaInputKind; 3] = [MediaInputKind::Image, MediaInputKind::Video, MediaInputKind::Audio];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaInputKind::Image => "image",
            MediaInputKind::Video => "video",
            MediaInputKind::Audio => "audio",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaInputReference {
    pub id: String,
    pub kind: MediaInputKind,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub hash: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum MediaAudioJob {
    #[serde(rename = "speakers", rename_all = "camelCase")]
    Speakers {
        id: String,
        prompt: String,
        model: String,
        connection: String,
        revision: i64,
        source: MediaSource,
        phase: MediaPhase,
        phase_text: String,
        problem: String,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        format: Option<MediaAudioFormat>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        content_type: Option<String>,
        metadata: Option<MediaAudioMetadata>,
        usage: Option<MediaAudioUsage>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        input: Option<MediaInputReference>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result_input: Option<MediaInputReference>,
        attachment: Option<Attachment>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        preview_input: Option<String>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result: Option<MediaAudioResult>,
        can_cancel: bool,
        can_retry_download: bool,
        can_resume: bool,
        can_cleanup: bool,
        can_release: bool,
        created_at: i64,
        updated_at: i64,
        request: MediaSpeakersRequest,
    },
    #[serde(rename = "voiceDesign", rename_all = "camelCase")]
    VoiceDesign {
        id: String,
        prompt: String,
        model: String,
        connection: String,
        revision: i64,
        source: MediaSource,
        phase: MediaPhase,
        phase_text: String,
        problem: String,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        format: Option<MediaAudioFormat>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        content_type: Option<String>,
        metadata: Option<MediaAudioMetadata>,
        usage: Option<MediaAudioUsage>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        input: Option<MediaInputReference>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result_input: Option<MediaInputReference>,
        attachment: Option<Attachment>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        preview_input: Option<String>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result: Option<MediaAudioResult>,
        can_cancel: bool,
        can_retry_download: bool,
        can_resume: bool,
        can_cleanup: bool,
        can_release: bool,
        created_at: i64,
        updated_at: i64,
        request: MediaVoiceDesignRequest,
    },
    #[serde(rename = "clone", rename_all = "camelCase")]
    Clone {
        id: String,
        prompt: String,
        model: String,
        connection: String,
        revision: i64,
        source: MediaSource,
        phase: MediaPhase,
        phase_text: String,
        problem: String,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        format: Option<MediaAudioFormat>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        content_type: Option<String>,
        metadata: Option<MediaAudioMetadata>,
        usage: Option<MediaAudioUsage>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        input: Option<MediaInputReference>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result_input: Option<MediaInputReference>,
        attachment: Option<Attachment>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        preview_input: Option<String>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result: Option<MediaAudioResult>,
        can_cancel: bool,
        can_retry_download: bool,
        can_resume: bool,
        can_cleanup: bool,
        can_release: bool,
        created_at: i64,
        updated_at: i64,
        request: MediaCloneRequest,
    },
    #[serde(rename = "transcription", rename_all = "camelCase")]
    Transcription {
        id: String,
        prompt: String,
        model: String,
        connection: String,
        revision: i64,
        source: MediaSource,
        phase: MediaPhase,
        phase_text: String,
        problem: String,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        format: Option<MediaAudioFormat>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        content_type: Option<String>,
        metadata: Option<MediaAudioMetadata>,
        usage: Option<MediaAudioUsage>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        input: Option<MediaInputReference>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result_input: Option<MediaInputReference>,
        attachment: Option<Attachment>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        preview_input: Option<String>,
        #[serialize_always]
        #[cfg_attr(feature = "ts-gen", ts(optional = false))]
        result: Option<MediaAudioResult>,
        can_cancel: bool,
        can_retry_download: bool,
        can_resume: bool,
        can_cleanup: bool,
        can_release: bool,
        created_at: i64,
        updated_at: i64,
        request: MediaTranscriptionRequest,
    },
}

pub type InputName = String;

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaInputRequest {
    pub kind: MediaInputKind,
    pub name: InputName,
    pub mime: String,
    pub size: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaInputPhase {
    #[serde(rename = "reserved")]
    Reserved,
    #[serde(rename = "uploading")]
    Uploading,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "deleting")]
    Deleting,
}

impl MediaInputPhase {
    pub const ALL: [MediaInputPhase; 5] = [
        MediaInputPhase::Reserved,
        MediaInputPhase::Uploading,
        MediaInputPhase::Ready,
        MediaInputPhase::Failed,
        MediaInputPhase::Deleting,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaInputPhase::Reserved => "reserved",
            MediaInputPhase::Uploading => "uploading",
            MediaInputPhase::Ready => "ready",
            MediaInputPhase::Failed => "failed",
            MediaInputPhase::Deleting => "deleting",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaInput {
    pub id: String,
    pub kind: MediaInputKind,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub phase: MediaInputPhase,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub hash: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaImageFormat {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "layout")]
    Layout,
}

impl MediaImageFormat {
    pub const ALL: [MediaImageFormat; 2] = [MediaImageFormat::Text, MediaImageFormat::Layout];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaImageFormat::Text => "text",
            MediaImageFormat::Layout => "layout",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaImageRequest {
    pub id: String,
    pub prompt: String,
    pub format: MediaImageFormat,
    pub width: i64,
    pub height: i64,
    pub seed: Option<i64>,
    pub steps: Option<i64>,
    pub guidance: Option<JsNumber>,
    pub negative_prompt: Option<String>,
    pub enhance: bool,
    pub watermark: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaImageUsage {
    pub images: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaImageJobKind {
    #[serde(rename = "image")]
    Image,
}

impl MediaImageJobKind {
    pub const ALL: [MediaImageJobKind; 1] = [MediaImageJobKind::Image];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaImageJobKind::Image => "image",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaImageJob {
    pub kind: MediaImageJobKind,
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub connection: String,
    pub revision: i64,
    pub source: MediaSource,
    pub usage: Option<MediaImageUsage>,
    pub phase: MediaPhase,
    pub phase_text: String,
    pub problem: String,
    pub attachment: Option<Attachment>,
    pub can_cancel: bool,
    pub can_retry_download: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaUnderstandingRequest {
    pub id: String,
    pub prompt: String,
    pub inputs: Vec<String>,
    pub connection: String,
    pub revision: i64,
    pub allow_upload: LitTrue,
    pub max_output_tokens: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaUnderstandingAuthorizationRequest {
    pub id: String,
    pub prompt: String,
    pub inputs: Vec<String>,
    pub connection: String,
    pub revision: i64,
    pub allow_upload: LitTrue,
    pub max_output_tokens: i64,
    pub channel: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaUnderstandingAuthorization {
    pub channel: String,
    pub expires_at: i64,
}

pub type Tokens = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaUnderstandingStatus {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "incomplete")]
    Incomplete,
}

impl MediaUnderstandingStatus {
    pub const ALL: [MediaUnderstandingStatus; 2] = [MediaUnderstandingStatus::Completed, MediaUnderstandingStatus::Incomplete];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaUnderstandingStatus::Completed => "completed",
            MediaUnderstandingStatus::Incomplete => "incomplete",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaUnderstandingResultIncompleteReason {
    #[serde(rename = "max_output_tokens")]
    MaxOutputTokens,
}

impl MediaUnderstandingResultIncompleteReason {
    pub const ALL: [MediaUnderstandingResultIncompleteReason; 1] = [MediaUnderstandingResultIncompleteReason::MaxOutputTokens];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaUnderstandingResultIncompleteReason::MaxOutputTokens => "max_output_tokens",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaUnderstandingResultUsage {
    pub input_tokens: Tokens,
    pub output_tokens: Tokens,
    pub total_tokens: Tokens,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaUnderstandingResult {
    pub model: String,
    pub text: String,
    pub status: MediaUnderstandingStatus,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub incomplete_reason: Option<MediaUnderstandingResultIncompleteReason>,
    pub usage: MediaUnderstandingResultUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaUnderstandingJobKind {
    #[serde(rename = "understanding")]
    Understanding,
}

impl MediaUnderstandingJobKind {
    pub const ALL: [MediaUnderstandingJobKind; 1] = [MediaUnderstandingJobKind::Understanding];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaUnderstandingJobKind::Understanding => "understanding",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaUnderstandingPhase {
    #[serde(rename = "authorized")]
    Authorized,
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "uploading")]
    Uploading,
    #[serde(rename = "generating")]
    Generating,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "incomplete")]
    Incomplete,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "canceled")]
    Canceled,
}

impl MediaUnderstandingPhase {
    pub const ALL: [MediaUnderstandingPhase; 9] = [
        MediaUnderstandingPhase::Authorized,
        MediaUnderstandingPhase::Queued,
        MediaUnderstandingPhase::Uploading,
        MediaUnderstandingPhase::Generating,
        MediaUnderstandingPhase::Ready,
        MediaUnderstandingPhase::Incomplete,
        MediaUnderstandingPhase::Failed,
        MediaUnderstandingPhase::Unknown,
        MediaUnderstandingPhase::Canceled,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaUnderstandingPhase::Authorized => "authorized",
            MediaUnderstandingPhase::Queued => "queued",
            MediaUnderstandingPhase::Uploading => "uploading",
            MediaUnderstandingPhase::Generating => "generating",
            MediaUnderstandingPhase::Ready => "ready",
            MediaUnderstandingPhase::Incomplete => "incomplete",
            MediaUnderstandingPhase::Failed => "failed",
            MediaUnderstandingPhase::Unknown => "unknown",
            MediaUnderstandingPhase::Canceled => "canceled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaCleanup {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "unknown")]
    Unknown,
}

impl MediaCleanup {
    pub const ALL: [MediaCleanup; 5] = [
        MediaCleanup::Pending,
        MediaCleanup::Running,
        MediaCleanup::Done,
        MediaCleanup::Blocked,
        MediaCleanup::Unknown,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaCleanup::Pending => "pending",
            MediaCleanup::Running => "running",
            MediaCleanup::Done => "done",
            MediaCleanup::Blocked => "blocked",
            MediaCleanup::Unknown => "unknown",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaUnderstandingJob {
    pub kind: MediaUnderstandingJobKind,
    pub id: String,
    pub prompt: String,
    pub inputs: Vec<MediaInputReference>,
    pub model: String,
    pub connection: String,
    pub revision: i64,
    pub source: MediaSource,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub authorization: Option<MediaUnderstandingAuthorization>,
    pub phase: MediaUnderstandingPhase,
    pub phase_text: String,
    pub problem: String,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub result: Option<MediaUnderstandingResult>,
    pub cleanup: MediaCleanup,
    pub cleanup_text: String,
    pub can_cancel: bool,
    pub can_cleanup: bool,
    pub can_retry_download: LitFalse,
    pub created_at: i64,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "type")]
pub enum MediaSpeechEvent {
    #[serde(rename = "format", rename_all = "camelCase")]
    Format {
        sample_rate: i64,
        channels: i64,
        /// Always 16.
        #[cfg_attr(feature = "ts-gen", ts(type = "16"))]
        bit_depth: i64,
    },
    #[serde(rename = "audio", rename_all = "camelCase")]
    Audio { sequence: i64, audio: String },
    #[serde(rename = "done")]
    Done {},
    #[serde(rename = "failed")]
    Failed {},
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeechRequest {
    pub id: String,
    pub text: String,
    pub voice: String,
    pub format: MediaAudioFormat,
    pub asynchronous: Option<bool>,
    pub streaming: Option<bool>,
    pub connection: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaSpeechJobKind {
    #[serde(rename = "speech")]
    Speech,
}

impl MediaSpeechJobKind {
    pub const ALL: [MediaSpeechJobKind; 1] = [MediaSpeechJobKind::Speech];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaSpeechJobKind::Speech => "speech",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeechJob {
    pub kind: MediaSpeechJobKind,
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub connection: String,
    pub revision: i64,
    pub source: MediaSource,
    pub voice: String,
    pub format: MediaAudioFormat,
    pub content_type: Option<String>,
    pub metadata: Option<MediaAudioMetadata>,
    pub usage: Option<MediaAudioUsage>,
    pub can_resume: Option<bool>,
    pub can_release: bool,
    pub phase: MediaPhase,
    pub phase_text: String,
    pub problem: String,
    pub attachment: Option<Attachment>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub result_input: Option<MediaInputReference>,
    pub can_cancel: bool,
    pub can_retry_download: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(untagged)]
pub enum MediaJob {
    MediaImageJob(MediaImageJob),
    MediaUnderstandingJob(MediaUnderstandingJob),
    MediaSpeechJob(MediaSpeechJob),
    MediaAudioJob(MediaAudioJob),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaJobRequest {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactMediaChanged {
    pub at: i64,
    pub jobs: Vec<MediaJob>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum JobKind {
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
    #[serde(rename = "clone")]
    Clone,
    #[serde(rename = "transcription")]
    Transcription,
}

impl JobKind {
    pub const ALL: [JobKind; 7] = [
        JobKind::Image,
        JobKind::Understanding,
        JobKind::Speech,
        JobKind::Speakers,
        JobKind::VoiceDesign,
        JobKind::Clone,
        JobKind::Transcription,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::Image => "image",
            JobKind::Understanding => "understanding",
            JobKind::Speech => "speech",
            JobKind::Speakers => "speakers",
            JobKind::VoiceDesign => "voiceDesign",
            JobKind::Clone => "clone",
            JobKind::Transcription => "transcription",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(untagged)]
pub enum LibraryOriginFetchedFrom {
    Url { url: String },
    Path { path: String },
}

/// Duplicate bytes only advance lastAt without overwriting origin.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum LibraryOrigin {
    #[serde(rename = "generated", rename_all = "camelCase")]
    Generated { job: String, job_kind: JobKind },
    #[serde(rename = "uploaded", rename_all = "camelCase")]
    Uploaded {
        channel: Option<String>,
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::MessageId>"))]
        message: Option<MessageId>,
    },
    #[serde(rename = "fetched", rename_all = "camelCase")]
    Fetched {
        agent: String,
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SessionId>"))]
        session: Option<SessionId>,
        from: LibraryOriginFetchedFrom,
    },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub attachment: Attachment,
    pub origin: LibraryOrigin,
    pub added_at: i64,
    pub last_at: i64,
}

pub type LibraryItems = Vec<LibraryItem>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum LibraryOriginKind {
    #[serde(rename = "generated")]
    Generated,
    #[serde(rename = "uploaded")]
    Uploaded,
    #[serde(rename = "fetched")]
    Fetched,
}

impl LibraryOriginKind {
    pub const ALL: [LibraryOriginKind; 3] = [LibraryOriginKind::Generated, LibraryOriginKind::Uploaded, LibraryOriginKind::Fetched];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            LibraryOriginKind::Generated => "generated",
            LibraryOriginKind::Uploaded => "uploaded",
            LibraryOriginKind::Fetched => "fetched",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum LibraryFileKind {
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "video")]
    Video,
    #[serde(rename = "other")]
    Other,
}

impl LibraryFileKind {
    pub const ALL: [LibraryFileKind; 4] = [LibraryFileKind::Image, LibraryFileKind::Audio, LibraryFileKind::Video, LibraryFileKind::Other];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            LibraryFileKind::Image => "image",
            LibraryFileKind::Audio => "audio",
            LibraryFileKind::Video => "video",
            LibraryFileKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum LibrarySort {
    #[serde(rename = "recent")]
    Recent,
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "size")]
    Size,
}

impl LibrarySort {
    pub const ALL: [LibrarySort; 3] = [LibrarySort::Recent, LibrarySort::Name, LibrarySort::Size];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            LibrarySort::Recent => "recent",
            LibrarySort::Name => "name",
            LibrarySort::Size => "size",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LibraryListRequest {
    pub origin: Option<LibraryOriginKind>,
    pub r#type: Option<LibraryFileKind>,
    pub text: Option<String>,
    pub sort: Option<LibrarySort>,
}

/// Exactly one of attachment, url, or path must be set.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LibraryAddRequest {
    pub attachment: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub name: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaInputAdoptInput {
    pub attachment: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemDeleteInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaSummary {
    pub active_count: i64,
    pub active_ids: Vec<String>,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "media";
    types: [MediaAudioFormat,
    MediaSummary,
    MediaAudioAccountRequest,
    MediaSpeakersRequestSpeakers,
    MediaSpeakersRequestSegments,
    MediaSpeakersRequest,
    MediaVoiceDesignRequest,
    MediaCloneRequest,
    MediaTranscriptionRequest,
    MediaAudioRequest,
    MediaAudioVoice,
    MediaAudioSegment,
    MediaAudioResult,
    MediaSource,
    MediaPhase,
    MediaAudioMetadataSource,
    MediaAudioMetadata,
    MediaAudioUsage,
    MediaInputKind,
    MediaInputReference,
    MediaAudioJob,
    MediaInputRequest,
    MediaInputPhase,
    MediaInput,
    MediaImageFormat,
    MediaImageRequest,
    MediaImageUsage,
    MediaImageJobKind,
    MediaImageJob,
    MediaUnderstandingRequest,
    MediaUnderstandingAuthorizationRequest,
    MediaUnderstandingAuthorization,
    MediaUnderstandingStatus,
    MediaUnderstandingResultIncompleteReason,
    MediaUnderstandingResultUsage,
    MediaUnderstandingResult,
    MediaUnderstandingJobKind,
    MediaUnderstandingPhase,
    MediaCleanup,
    MediaUnderstandingJob,
    MediaSpeechEvent,
    MediaSpeechRequest,
    MediaSpeechJobKind,
    MediaSpeechJob,
    MediaJob,
    MediaJobRequest,
    FactMediaChanged,
    JobKind,
    LibraryOriginFetchedFrom,
    LibraryOrigin,
    LibraryItem,
    LibraryOriginKind,
    LibraryFileKind,
    LibrarySort,
    LibraryListRequest,
    LibraryAddRequest,
    MediaInputAdoptInput,
    LibraryItemDeleteInput];
    aliases: [Id,
    VoiceId,
    SpeakerId,
    InputName,
    Tokens,
    LibraryItems];
}
