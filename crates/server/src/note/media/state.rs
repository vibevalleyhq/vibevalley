//! Pure 11-state media job phase machine, request/record state types,
//! validation helpers, and protocol view projections.

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Attachment, BizCode, MediaAudioFormat, MediaAudioMetadata, MediaAudioResult, MediaAudioUsage, MediaCleanup, MediaCloneRequest, MediaImageJob,
    MediaImageJobKind, MediaImageRequest, MediaImageUsage, MediaInputReference, MediaJob, MediaPhase, MediaSource, MediaSpeakersRequest, MediaSpeechJob,
    MediaSpeechJobKind, MediaSpeechRequest, MediaTranscriptionRequest, MediaUnderstandingPhase, MediaUnderstandingRequest, MediaUnderstandingResult,
    MediaVoiceDesignRequest, Millis,
};

use super::remote::RemoteFile;
use super::understanding::Authorization;
use super::vendor::{Account, MossBody, TaskKind};

pub(super) const ACTIVE_PHASES: &[&str] = &["queued", "generating", "downloading", "authorized", "uploading"];
pub(super) const WAITING_PHASES: &[&str] = &["queued", "generating", "downloading"];

pub(super) fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}

pub(super) fn id_ok(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    Authorized,
    Queued,
    Uploading,
    Generating,
    Downloading,
    Ready,
    Incomplete,
    Failed,
    Unknown,
    Canceled,
    DownloadFailed,
}

impl Phase {
    pub(super) const ALL: [Phase; 11] = [
        Phase::Authorized,
        Phase::Queued,
        Phase::Uploading,
        Phase::Generating,
        Phase::Downloading,
        Phase::Ready,
        Phase::Incomplete,
        Phase::Failed,
        Phase::Unknown,
        Phase::Canceled,
        Phase::DownloadFailed,
    ];
    pub(super) const ENDED: [Phase; 6] = [
        Phase::Ready,
        Phase::Incomplete,
        Phase::Failed,
        Phase::Unknown,
        Phase::Canceled,
        Phase::DownloadFailed,
    ];

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Phase::Authorized => "authorized",
            Phase::Queued => "queued",
            Phase::Uploading => "uploading",
            Phase::Generating => "generating",
            Phase::Downloading => "downloading",
            Phase::Ready => "ready",
            Phase::Incomplete => "incomplete",
            Phase::Failed => "failed",
            Phase::Unknown => "unknown",
            Phase::Canceled => "canceled",
            Phase::DownloadFailed => "download_failed",
        }
    }

    pub(super) fn shown(self) -> MediaPhase {
        match self {
            Phase::Authorized | Phase::Queued => MediaPhase::Queued,
            Phase::Uploading | Phase::Generating => MediaPhase::Generating,
            Phase::Downloading => MediaPhase::Downloading,
            Phase::Ready | Phase::Incomplete => MediaPhase::Ready,
            Phase::Failed => MediaPhase::Failed,
            Phase::Unknown => MediaPhase::Unknown,
            Phase::Canceled => MediaPhase::Canceled,
            Phase::DownloadFailed => MediaPhase::DownloadFailed,
        }
    }

    pub(super) fn understanding(self) -> MediaUnderstandingPhase {
        match self {
            Phase::Authorized => MediaUnderstandingPhase::Authorized,
            Phase::Queued => MediaUnderstandingPhase::Queued,
            Phase::Uploading => MediaUnderstandingPhase::Uploading,
            Phase::Generating | Phase::Downloading => MediaUnderstandingPhase::Generating,
            Phase::Ready => MediaUnderstandingPhase::Ready,
            Phase::Incomplete => MediaUnderstandingPhase::Incomplete,
            Phase::Failed | Phase::DownloadFailed => MediaUnderstandingPhase::Failed,
            Phase::Unknown => MediaUnderstandingPhase::Unknown,
            Phase::Canceled => MediaUnderstandingPhase::Canceled,
        }
    }
}

pub(super) fn active(p: Phase) -> bool {
    matches!(p, Phase::Authorized | Phase::Queued | Phase::Uploading | Phase::Generating | Phase::Downloading)
}

pub(super) struct Words {
    pub(super) rejected: &'static str,
    pub(super) unknown: &'static str,
    pub(super) paused: &'static str,
    pub(super) no_resume: &'static str,
    pub(super) account_changed: &'static str,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "request", rename_all = "camelCase")]
pub(super) enum Ask {
    Image(MediaImageRequest),
    Speech(MediaSpeechRequest),
    Speakers(MediaSpeakersRequest),
    VoiceDesign(MediaVoiceDesignRequest),
    Clone(MediaCloneRequest),
    Transcription(MediaTranscriptionRequest),
    Understanding(MediaUnderstandingRequest),
}

impl Ask {
    pub(super) fn id(&self) -> &str {
        match self {
            Ask::Image(r) => &r.id,
            Ask::Speech(r) => &r.id,
            Ask::Speakers(r) => &r.id,
            Ask::VoiceDesign(r) => &r.id,
            Ask::Clone(r) => &r.id,
            Ask::Transcription(r) => &r.id,
            Ask::Understanding(r) => &r.id,
        }
    }

    pub(super) fn kind(&self) -> &'static str {
        match self {
            Ask::Image(_) => "image",
            Ask::Speech(_) => "speech",
            Ask::Speakers(_) => "speakers",
            Ask::VoiceDesign(_) => "voiceDesign",
            Ask::Clone(_) => "clone",
            Ask::Transcription(_) => "transcription",
            Ask::Understanding(_) => "understanding",
        }
    }

    pub(super) fn streamed(&self) -> bool {
        match self {
            Ask::Speech(r) => r.streaming == Some(true),
            Ask::Transcription(r) => r.streaming == Some(true),
            _ => false,
        }
    }

    pub(super) fn task(&self) -> Option<TaskKind> {
        match self {
            Ask::Speech(_) | Ask::Speakers(_) => Some(TaskKind::Speech),
            Ask::VoiceDesign(_) => Some(TaskKind::VoiceGeneration),
            Ask::Transcription(_) => Some(TaskKind::Transcription),
            Ask::Image(_) | Ask::Clone(_) | Ask::Understanding(_) => None,
        }
    }

    pub(super) fn audio(&self) -> Option<MediaAudioFormat> {
        match self {
            Ask::Speech(r) => Some(r.format),
            Ask::Speakers(r) => Some(r.format),
            Ask::VoiceDesign(r) => Some(r.format),
            Ask::Image(_) | Ask::Clone(_) | Ask::Transcription(_) | Ask::Understanding(_) => None,
        }
    }

    pub(super) fn is_audio(&self) -> bool {
        matches!(self, Ask::Speakers(_) | Ask::VoiceDesign(_) | Ask::Clone(_) | Ask::Transcription(_))
    }

    pub(super) fn words(&self) -> Words {
        match self {
            Ask::Image(_) => Words {
                rejected: "rejected",
                unknown: "unknown",
                paused: "unknown",
                no_resume: "noDownload",
                account_changed: "remoteAccountChanged",
            },
            Ask::Speech(_) => Words {
                rejected: "speechRejected",
                unknown: "speechUnknown",
                paused: "speechPollPaused",
                no_resume: "speechNoResume",
                account_changed: "remoteAccountChanged",
            },
            Ask::Speakers(_) | Ask::VoiceDesign(_) | Ask::Clone(_) | Ask::Transcription(_) => Words {
                rejected: "audioRejected",
                unknown: "audioUnknown",
                paused: "audioPollingPaused",
                no_resume: "audioPollingPaused",
                account_changed: "audioAccountChanged",
            },
            Ask::Understanding(_) => Words {
                rejected: "understandingRejected",
                unknown: "understandingUnknown",
                paused: "understandingUnknown",
                no_resume: "noDownload",
                account_changed: "consentChanged",
            },
        }
    }
}

pub(super) enum Held {
    Image { account: Account, body: MossBody },
    Speech { account: Account, body: MossBody },
    Account(Account),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum RecordUsage {
    Image(MediaImageUsage),
    Audio(MediaAudioUsage),
}

impl RecordUsage {
    pub(super) fn as_image(&self) -> Option<MediaImageUsage> {
        match self {
            RecordUsage::Image(u) => Some(u.clone()),
            RecordUsage::Audio(_) => None,
        }
    }

    pub(super) fn as_audio(&self) -> Option<MediaAudioUsage> {
        match self {
            RecordUsage::Audio(u) => Some(u.clone()),
            RecordUsage::Image(_) => None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Record {
    pub(super) ask: Ask,
    pub(super) source: MediaSource,
    pub(super) model: String,
    pub(super) connection: String,
    pub(super) revision: i64,
    #[serde(default)]
    pub(super) fingerprint: String,
    pub(super) phase: Phase,
    #[serde(default)]
    pub(super) problem: String,
    pub(super) remote_task: Option<String>,
    pub(super) url: Option<String>,
    pub(super) usage: Option<RecordUsage>,
    pub(super) metadata: Option<MediaAudioMetadata>,
    pub(super) result_format: Option<MediaAudioFormat>,
    pub(super) content_type: Option<String>,
    pub(super) attachment: Option<Attachment>,
    pub(super) result_input: Option<MediaInputReference>,
    #[serde(default)]
    pub(super) released: bool,
    #[serde(default)]
    pub(super) input: Option<MediaInputReference>,
    #[serde(default)]
    pub(super) inputs: Vec<MediaInputReference>,
    #[serde(default)]
    pub(super) preview_input: Option<String>,
    #[serde(default)]
    pub(super) made: Option<MediaAudioResult>,
    #[serde(default)]
    pub(super) understood: Option<MediaUnderstandingResult>,
    #[serde(default)]
    pub(super) authorization: Option<Authorization>,
    #[serde(default)]
    pub(super) remote: Vec<RemoteFile>,
    #[serde(default)]
    pub(super) cleanup: Option<MediaCleanup>,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
}

impl Record {
    pub(super) fn new(ask: Ask, source: MediaSource, connection: String, revision: i64, model: String, fingerprint: String, at: Millis) -> Record {
        Record {
            ask,
            source,
            model,
            connection,
            revision,
            fingerprint,
            phase: Phase::Queued,
            problem: String::new(),
            remote_task: None,
            url: None,
            usage: None,
            metadata: None,
            result_format: None,
            content_type: None,
            attachment: None,
            result_input: None,
            released: false,
            input: None,
            inputs: vec![],
            preview_input: None,
            made: None,
            understood: None,
            authorization: None,
            remote: vec![],
            cleanup: None,
            created_at: at,
            updated_at: at,
        }
    }

    pub(super) fn id(&self) -> &str {
        self.ask.id()
    }

    pub(super) fn is_schedulable(&self) -> bool {
        match self.phase {
            Phase::Queued | Phase::Downloading => true,
            Phase::Generating => self.remote_task.is_some(),
            _ => false,
        }
    }

    pub(super) fn initial_work_phase(&self) -> Phase {
        if matches!(self.ask, Ask::Understanding(_)) {
            Phase::Uploading
        } else {
            Phase::Generating
        }
    }

    pub(super) fn can_retry_download(&self) -> bool {
        !self.released && self.url.is_some() && matches!(self.phase, Phase::DownloadFailed | Phase::Canceled)
    }

    pub(super) fn can_resume(&self) -> bool {
        self.ask.task().is_some()
            && !self.released
            && !self.ask.streamed()
            && self.remote_task.is_some()
            && matches!(self.phase, Phase::Unknown | Phase::Canceled)
            && self.url.is_none()
            && self.made.is_none()
    }

    pub(super) fn releasable(&self) -> bool {
        !matches!(self.ask, Ask::Image(_) | Ask::Understanding(_))
    }

    pub(super) fn can_release(&self) -> bool {
        self.releasable() && !active(self.phase) && !self.released
    }

    pub(super) fn phase_text(&self) -> String {
        t(&format!("server.media.phase.{}", self.phase.shown().as_str()), &[])
    }

    pub(super) fn view(&self) -> MediaJob {
        let phase_text = self.phase_text();
        match &self.ask {
            Ask::Speakers(_) | Ask::VoiceDesign(_) | Ask::Clone(_) | Ask::Transcription(_) => match self.audio_view() {
                Some(job) => MediaJob::MediaAudioJob(job),
                None => unreachable!("an audio job's view"),
            },
            Ask::Understanding(request) => MediaJob::MediaUnderstandingJob(self.understanding_view(request)),
            Ask::Image(r) => MediaJob::MediaImageJob(MediaImageJob {
                kind: MediaImageJobKind::Image,
                id: r.id.clone(),
                prompt: r.prompt.clone(),
                model: self.model.clone(),
                connection: self.connection.clone(),
                revision: self.revision,
                source: self.source.clone(),
                usage: self.usage.as_ref().and_then(RecordUsage::as_image),
                phase: self.phase.shown(),
                phase_text,
                problem: self.problem.clone(),
                attachment: self.attachment.clone(),
                can_cancel: active(self.phase),
                can_retry_download: self.can_retry_download(),
                created_at: self.created_at,
                updated_at: self.updated_at,
            }),
            Ask::Speech(r) => MediaJob::MediaSpeechJob(MediaSpeechJob {
                kind: MediaSpeechJobKind::Speech,
                id: r.id.clone(),
                prompt: r.text.clone(),
                model: self.model.clone(),
                connection: self.connection.clone(),
                revision: self.revision,
                source: self.source.clone(),
                voice: r.voice.clone(),
                format: self.result_format.unwrap_or(r.format),
                content_type: self.content_type.clone(),
                metadata: self.metadata.clone(),
                usage: self.usage.as_ref().and_then(RecordUsage::as_audio),
                can_resume: Some(self.can_resume()),
                can_release: self.can_release(),
                phase: self.phase.shown(),
                phase_text,
                problem: self.problem.clone(),
                attachment: self.attachment.clone(),
                result_input: self.result_input.clone(),
                can_cancel: active(self.phase),
                can_retry_download: self.can_retry_download(),
                created_at: self.created_at,
                updated_at: self.updated_at,
            }),
        }
    }
}

pub(super) fn image_view(r: &Record) -> MediaImageJob {
    match r.view() {
        MediaJob::MediaImageJob(j) => j,
        _ => unreachable!("an image's view"),
    }
}

pub(super) fn speech_view(r: &Record) -> MediaSpeechJob {
    match r.view() {
        MediaJob::MediaSpeechJob(j) => j,
        _ => unreachable!("a speech's view"),
    }
}
