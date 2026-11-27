//! Media job engine (`Media`): admits up to eight active jobs across all
//! kinds, runs each kind's waiting jobs oldest-first under per-kind concurrency
//! gates, and handles cancel, download retry, resume, release, and restart recovery.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::{Mutex, MutexGuard};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, broadcast};
use tokio_util::sync::CancellationToken;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Attachment, BizCode, Caller, JsNumber, MediaAudioFormat, MediaAudioJob, MediaAudioMetadata, MediaAudioMetadataSource, MediaAudioResult,
    MediaAudioUsage, MediaCleanup, MediaCloneRequest, MediaImageJob, MediaImageJobKind, MediaImageRequest, MediaImageUsage, MediaInputKind,
    MediaInputReference, MediaInputRequest, MediaJob, MediaPhase, MediaSource, MediaSpeakersRequest, MediaSpeechJob, MediaSpeechJobKind, MediaSpeechRequest,
    MediaTranscriptionRequest, MediaUnderstandingJob, MediaUnderstandingPhase, MediaUnderstandingRequest, MediaUnderstandingResult, MediaVoiceDesignRequest,
    Millis, Preview,
};

use super::Stop;
use super::remote::{RemoteFile, RemoteState};
use super::understanding::Authorization;
use super::vendor::{self, Account, Moss, MossBody, Outcome, Task, TaskKind};
use crate::context::http::{Fetch, Request, public_https};
use crate::context::port::ChannelAnnounce;
use crate::context::{Context, Ticker};
use crate::log::spawn_blocking_traced;
use crate::service::Tx;
use crate::service::note::MediaJobRow;
use crate::setting::{IMAGE_MODELS, Setting, Use};
use crate::storage::{ATTACHMENT_MAX, Storage};

const ADMITTED: i64 = 8;
const RESULT_MAX: usize = 512_000_000;
const STREAM_MAX: usize = 128 * 1024 * 1024 - 44;
const POLL: Duration = Duration::from_secs(3);
const POLLS: usize = 600;
const DOWNLOAD_TIME: Duration = Duration::from_secs(300);

const ACTIVE_PHASES: &[&str] = &["queued", "generating", "downloading", "authorized", "uploading"];
const WAITING_PHASES: &[&str] = &["queued", "generating", "downloading"];

pub(super) fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}

fn storage_err(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("media job storage: {e}"))
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

    fn as_str(self) -> &'static str {
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
    rejected: &'static str,
    unknown: &'static str,
    paused: &'static str,
    no_resume: &'static str,
    account_changed: &'static str,
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

    fn kind(&self) -> &'static str {
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

    fn task(&self) -> Option<TaskKind> {
        match self {
            Ask::Speech(_) | Ask::Speakers(_) => Some(TaskKind::Speech),
            Ask::VoiceDesign(_) => Some(TaskKind::VoiceGeneration),
            Ask::Transcription(_) => Some(TaskKind::Transcription),
            Ask::Image(_) | Ask::Clone(_) | Ask::Understanding(_) => None,
        }
    }

    fn audio(&self) -> Option<MediaAudioFormat> {
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

    fn words(&self) -> Words {
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
    fn as_image(&self) -> Option<MediaImageUsage> {
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

    fn releasable(&self) -> bool {
        !matches!(self.ask, Ask::Image(_) | Ask::Understanding(_))
    }

    pub(super) fn can_release(&self) -> bool {
        self.releasable() && !active(self.phase) && !self.released
    }

    pub(super) fn phase_text(&self) -> String {
        t(&format!("server.media.phase.{}", self.phase.shown().as_str()), &[])
    }

    fn view(&self) -> MediaJob {
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

    fn to_row(&self) -> Result<MediaJobRow, ApiError> {
        Ok(MediaJobRow {
            id: self.id().to_string(),
            kind: self.ask.kind().to_string(),
            phase: self.phase.as_str().to_string(),
            data: serde_json::to_string(self).map_err(storage_err)?,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

type Kept = (Option<Attachment>, Option<MediaInputReference>, Option<MediaAudioMetadata>);

struct Stream {
    tx: tokio::sync::mpsc::Sender<Value>,
    rx: Option<tokio::sync::mpsc::Receiver<Value>>,
}

struct KindSemaphores {
    image: Arc<Semaphore>,
    speech: Arc<Semaphore>,
    speakers: Arc<Semaphore>,
    voice_design: Arc<Semaphore>,
    clone: Arc<Semaphore>,
    transcription: Arc<Semaphore>,
    understanding: Arc<Semaphore>,
}

impl KindSemaphores {
    fn new() -> Self {
        Self {
            image: Arc::new(Semaphore::new(1)),
            speech: Arc::new(Semaphore::new(8)),
            speakers: Arc::new(Semaphore::new(8)),
            voice_design: Arc::new(Semaphore::new(8)),
            clone: Arc::new(Semaphore::new(8)),
            transcription: Arc::new(Semaphore::new(8)),
            understanding: Arc::new(Semaphore::new(8)),
        }
    }

    fn for_ask(&self, ask: &Ask) -> Arc<Semaphore> {
        match ask {
            Ask::Image(_) => self.image.clone(),
            Ask::Speech(_) => self.speech.clone(),
            Ask::Speakers(_) => self.speakers.clone(),
            Ask::VoiceDesign(_) => self.voice_design.clone(),
            Ask::Clone(_) => self.clone.clone(),
            Ask::Transcription(_) => self.transcription.clone(),
            Ask::Understanding(_) => self.understanding.clone(),
        }
    }
}

struct Running {
    stop: Stop,
    _permit: OwnedSemaphorePermit,
}

/// Manages media generation, transcription, and understanding jobs.
pub struct Media {
    pub(super) ctx: Arc<Context>,
    held: Mutex<HashMap<String, Held>>,
    runs: Mutex<HashMap<String, Running>>,
    semaphores: KindSemaphores,
    scheduling: AsyncMutex<()>,
    pub(super) cleaning: AsyncMutex<()>,
    pub(super) moss: Moss,
    download: Arc<dyn Fetch>,
    setting: Arc<Setting>,
    pub(super) storage: Arc<Storage>,
    pub(super) channel: Arc<dyn ChannelAnnounce>,
    job_updates: broadcast::Sender<Vec<MediaJob>>,
    closed: AtomicBool,
    me: OnceLock<Weak<Media>>,
    streams: Mutex<HashMap<String, Stream>>,
    cancel: CancellationToken,
    sweeper: Mutex<Option<Ticker>>,
}

impl Media {
    pub async fn open_async(
        ctx: Arc<Context>,
        setting: Arc<Setting>,
        storage: Arc<Storage>,
        channel: Arc<dyn ChannelAnnounce>,
    ) -> Result<Arc<Media>, ApiError> {
        let cancel = ctx.task.child_token();
        let (job_updates, _) = broadcast::channel(64);
        let jobs = Arc::new(Media {
            moss: Moss { fetch: ctx.http.clone() },
            download: ctx.download.clone(),
            ctx: ctx.clone(),
            held: Mutex::default(),
            runs: Mutex::default(),
            semaphores: KindSemaphores::new(),
            scheduling: AsyncMutex::new(()),
            cleaning: AsyncMutex::new(()),
            setting,
            storage,
            channel,
            job_updates,
            closed: AtomicBool::new(false),
            me: OnceLock::new(),
            streams: Mutex::default(),
            cancel,
            sweeper: Mutex::new(None),
        });
        let _ = jobs.me.set(Arc::downgrade(&jobs));
        jobs.pick_up_async().await?;
        let recent = jobs.recent_async().await?;
        jobs.publish_async().await;
        jobs.schedule_async().await;
        for r in recent {
            jobs.post_back_async(&r).await;
        }
        jobs.sweep_each_minute();
        Ok(jobs)
    }

    pub fn subscribe_job_updates(&self) -> broadcast::Receiver<Vec<MediaJob>> {
        self.job_updates.subscribe()
    }

    fn sweep_each_minute(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        let ticker = self.ctx.every("media.approval.expire", Duration::from_secs(60), move || {
            let me = me.clone();
            async move {
                let Some(jobs) = me.upgrade() else { return false };
                jobs.expire_approvals_async().await;
                true
            }
        });
        *self.sweeper.lock() = Some(ticker);
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<String, Running>> {
        self.runs.lock()
    }

    fn decode_row(row: MediaJobRow) -> Result<Record, ApiError> {
        serde_json::from_str(&row.data).map_err(storage_err)
    }

    fn decode_rows(rows: Vec<MediaJobRow>) -> Result<Vec<Record>, ApiError> {
        rows.into_iter().map(Self::decode_row).collect()
    }

    async fn read_job(&self, id: &str) -> Result<Option<Record>, ApiError> {
        self.ctx
            .service
            .note
            .find_media_job(id)
            .await
            .map_err(storage_err)?
            .map(Self::decode_row)
            .transpose()
    }

    async fn read_job_in_tx(&self, tx: &Tx, id: &str) -> Result<Option<Record>, ApiError> {
        self.ctx
            .service
            .note
            .find_media_job_in_tx(tx, id)
            .await
            .map_err(storage_err)?
            .map(Self::decode_row)
            .transpose()
    }

    pub(super) async fn found_async(&self, id: &str) -> Result<Record, ApiError> {
        self.read_job(id).await?.ok_or_else(|| refused("missing"))
    }

    async fn recent_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = self.ctx.service.note.list_recent_media_jobs(100).await.map_err(storage_err)?;
        Self::decode_rows(rows)
    }

    async fn waiting_jobs_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = self
            .ctx
            .service
            .note
            .list_media_jobs_by_phases(WAITING_PHASES, true)
            .await
            .map_err(storage_err)?;
        Self::decode_rows(rows)
    }

    async fn active_jobs_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = self
            .ctx
            .service
            .note
            .list_media_jobs_by_phases(ACTIVE_PHASES, false)
            .await
            .map_err(storage_err)?;
        Self::decode_rows(rows)
    }

    pub(super) async fn authorized_jobs_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = self
            .ctx
            .service
            .note
            .list_media_jobs_by_phases(&["authorized"], false)
            .await
            .map_err(storage_err)?;
        Self::decode_rows(rows)
    }

    pub(super) fn now_ms(&self) -> Millis {
        self.ctx.now()
    }

    async fn save_job_in_tx(&self, tx: &Tx, r: &mut Record, at: Millis) -> Result<(), ApiError> {
        r.updated_at = at;
        let row = r.to_row()?;
        self.ctx.service.note.save_media_job_in_tx(tx, &row).await.map_err(storage_err)
    }

    async fn require_capacity_in_tx(&self, tx: &Tx) -> Result<(), ApiError> {
        let count = self
            .ctx
            .service
            .note
            .count_media_jobs_in_phases_in_tx(tx, ACTIVE_PHASES)
            .await
            .map_err(storage_err)?;
        if count as i64 >= ADMITTED {
            return Err(refused("busy"));
        }
        Ok(())
    }

    async fn publish_async(&self) {
        match self.recent_async().await {
            Ok(jobs) => {
                let views: Vec<MediaJob> = jobs.iter().map(Record::view).collect();
                let _ = self.job_updates.send(views);
                self.ctx.mark_dirty(SliceMask::OPS);
            }
            Err(e) => eprintln!("media: {}", e.message),
        }
    }

    pub(super) async fn change_async(&self, id: &str, before: &[Phase], patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let tx = self.ctx.service.begin_tx().await.map_err(storage_err)?;
        let outcome: Result<bool, ApiError> = async {
            let Some(mut r) = self.read_job_in_tx(&tx, id).await? else { return Ok(false) };
            if !before.contains(&r.phase) {
                return Ok(false);
            }
            let was_active = active(r.phase);
            patch(&mut r);
            if !was_active && active(r.phase) {
                self.require_capacity_in_tx(&tx).await?;
            }
            self.save_job_in_tx(&tx, &mut r, self.now_ms()).await?;
            Ok(true)
        }
        .await;
        let changed = match outcome {
            Ok(changed) => {
                self.ctx.service.commit_tx(tx).await.map_err(storage_err)?;
                changed
            }
            Err(err) => {
                let _ = self.ctx.service.rollback_tx(tx).await;
                return Err(err);
            }
        };
        if changed {
            self.publish_async().await;
        }
        Ok(changed)
    }

    pub(super) async fn note_async(&self, id: &str, patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
        self.change_async(id, &Phase::ALL, patch).await
    }

    pub(super) fn open_for_work(&self) -> Result<(), ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        Ok(())
    }

    pub(super) async fn known_async(&self, ask: &Ask, alike: impl FnOnce(&Record) -> bool) -> Result<Option<Record>, ApiError> {
        match self.read_job(ask.id()).await? {
            Some(old) if old.ask != *ask || !alike(&old) => Err(refused("reusedId")),
            old => Ok(old),
        }
    }

    pub(super) async fn admit_async(&self, mut r: Record, held: Option<Held>) -> Result<Record, ApiError> {
        self.open_for_work()?;
        let (record, admitted) = {
            let _schedule = self.scheduling.lock().await;
            let tx = self.ctx.service.begin_tx().await.map_err(storage_err)?;
            let outcome: Result<(Record, bool), ApiError> = async {
                if let Some(old) = self.read_job_in_tx(&tx, r.id()).await? {
                    if old.ask != r.ask
                        || old.source != r.source
                        || old.authorization.as_ref().map(|a| &a.channel) != r.authorization.as_ref().map(|a| &a.channel)
                    {
                        return Err(refused("reusedId"));
                    }
                    return Ok((old, false));
                }
                self.require_capacity_in_tx(&tx).await?;
                let ids: Vec<_> = r.input.iter().chain(&r.inputs).map(|input| input.id.clone()).collect();
                if !ids.is_empty() {
                    self.storage.pin_inputs_in_tx(&tx, &ids, r.id()).await?;
                }
                self.save_job_in_tx(&tx, &mut r, self.now_ms()).await?;
                Ok((r, true))
            }
            .await;
            let (record, admitted) = match outcome {
                Ok(res) => {
                    self.ctx.service.commit_tx(tx).await.map_err(storage_err)?;
                    res
                }
                Err(err) => {
                    let _ = self.ctx.service.rollback_tx(tx).await;
                    return Err(err);
                }
            };
            if admitted && let Some(held) = held {
                self.hold(record.id(), held);
            }
            (record, admitted)
        };
        if !admitted {
            return Ok(record);
        }
        self.publish_async().await;
        self.schedule_async().await;
        Ok(record)
    }

    pub(super) fn hold(&self, id: &str, held: Held) {
        self.held.lock().insert(id.to_string(), held);
    }

    pub async fn image_async(&self, request: MediaImageRequest, source: MediaSource) -> Result<MediaImageJob, ApiError> {
        Moss::validate_image_request(&request).map_err(|_| refused("invalid"))?;
        if let MediaSource::Orchestrator { agent, channel } = &source
            && (agent.is_empty() || channel.is_empty())
        {
            return Err(refused("invalid"));
        }
        self.open_for_work()?;
        let ask = Ask::Image(request);
        if let Some(old) = self.known_async(&ask, |old| old.source == source).await? {
            return Ok(image_view(&old));
        }
        let Ask::Image(request) = &ask else { unreachable!() };
        let account = self.bound(Use::Image)?;
        if !IMAGE_MODELS.contains(&account.model.as_str()) {
            return Err(ApiError::new(BizCode::ProviderRefused, t("server.provider.imageModel", &[])));
        }
        let body = Moss::prepare_image(&account.model, request).map_err(|_| refused("invalid"))?;
        let r = Record::new(
            ask,
            source,
            account.connection.clone(),
            account.revision,
            account.model.clone(),
            account.fingerprint.clone(),
            self.now_ms(),
        );
        self.admit_async(r, Some(Held::Image { account, body })).await.map(|r| image_view(&r))
    }

    pub(super) fn bound(&self, u: Use) -> Result<Account, ApiError> {
        let unbound = || {
            let words = match u {
                Use::Image => t("server.provider.imageUnbound", &[]),
                Use::Speech => t("server.provider.speechUnbound", &[]),
                Use::Understanding => t("server.provider.understandingUnbound", &[]),
                _ => {
                    let capability = t(&format!("server.provider.use.{}", u.name()), &[]);
                    t("server.provider.capabilityUnbound", &[("capability", capability.into())])
                }
            };
            ApiError::new(BizCode::ProviderRefused, words)
        };
        self.setting.providers().account(u).map(keyed).ok_or_else(unbound)
    }

    pub(super) fn on_connection(&self, connection: &str) -> Option<Account> {
        self.setting.providers().account_on(connection, "").map(keyed)
    }

    pub(super) fn account_of(&self, r: &Record) -> Result<Account, ApiError> {
        self.setting
            .providers()
            .account_on(&r.connection, &r.model)
            .map(keyed)
            .filter(|a| a.fingerprint == r.fingerprint)
            .map(|a| Account { revision: r.revision, ..a })
            .ok_or_else(|| refused(r.ask.words().account_changed))
    }

    pub async fn speech_async(&self, request: MediaSpeechRequest, source: MediaSource) -> Result<MediaSpeechJob, ApiError> {
        self.open_for_work()?;
        let streaming = request.streaming == Some(true);
        if streaming && (!matches!(source, MediaSource::User {}) || request.asynchronous == Some(true) || request.format != MediaAudioFormat::Pcm) {
            return Err(refused("speechInvalid"));
        }
        if streaming && self.streams.lock().len() >= 8 {
            return Err(refused("speechInvalid"));
        }
        let ask = Ask::Speech(request.clone());
        if let Some(old) = self.known_async(&ask, |old| old.source == source).await? {
            return Ok(speech_view(&old));
        }
        let account = self.bound(Use::Speech)?;
        if request.connection != account.connection || request.revision != account.revision {
            return Err(refused("speechChanged"));
        }
        let body = Moss::prepare_speech(&account.model, &request.text, &request.voice, request.format.as_str()).map_err(|_| refused("speechInvalid"))?;
        if streaming {
            let (tx, rx) = tokio::sync::mpsc::channel(16);
            self.streams.lock().insert(request.id.clone(), Stream { tx, rx: Some(rx) });
        }
        let r = Record::new(
            ask,
            source,
            account.connection.clone(),
            account.revision,
            account.model.clone(),
            account.fingerprint.clone(),
            self.now_ms(),
        );
        self.admit_async(r, Some(Held::Speech { account, body })).await.map(|r| speech_view(&r))
    }

    pub(super) fn schedule_async(&self) -> crate::BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.closed.load(Ordering::SeqCst) {
                return;
            }
            let Some(me) = self.me.get().and_then(Weak::upgrade) else { return };
            let _one = self.scheduling.lock().await;
            let waiting = match self.waiting_jobs_async().await {
                Ok(w) => w,
                Err(e) => return eprintln!("media: {}", e.message),
            };
            for r in waiting {
                let ready = match r.phase {
                    Phase::Queued | Phase::Downloading => true,
                    Phase::Generating => r.remote_task.is_some(),
                    _ => false,
                };
                if !ready {
                    continue;
                }
                let stop = {
                    let mut runs = self.runs();
                    if runs.contains_key(r.id()) {
                        continue;
                    }
                    let Ok(permit) = self.semaphores.for_ask(&r.ask).try_acquire_owned() else {
                        continue;
                    };
                    let stop = Stop::default();
                    runs.insert(
                        r.id().to_string(),
                        Running {
                            stop: stop.clone(),
                            _permit: permit,
                        },
                    );
                    stop
                };
                let id = r.id().to_string();
                let work = me.clone();
                self.ctx.spawn("media.job.run", async move {
                    work.work_async(&id, &stop).await;
                    {
                        let mut runs = work.runs();
                        if runs.get(&id).is_some_and(|x| x.stop.same_as(&stop)) {
                            runs.remove(&id);
                        }
                    }
                    work.schedule_async().await;
                });
            }
        })
    }

    async fn work_async(self: &Arc<Self>, id: &str, stop: &Stop) {
        let Ok(r) = self.found_async(id).await else { return };
        match r.phase {
            Phase::Queued => self.generate_async(r, stop).await,
            Phase::Downloading => self.download_async(id, stop).await,
            Phase::Generating if r.remote_task.is_some() => self.poll_async(id, stop).await,
            _ => {}
        }
        self.settle_async(id).await;
    }

    async fn settle_async(&self, id: &str) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if self.found_async(id).await.is_ok_and(|r| r.ask.is_audio()) {
            self.tidy_audio_async(id).await;
        }
    }

    async fn generate_async(self: &Arc<Self>, r: Record, stop: &Stop) {
        let id = r.id().to_string();
        let held = self.held.lock().remove(&id);
        let first = if matches!(r.ask, Ask::Understanding(_)) {
            Phase::Uploading
        } else {
            Phase::Generating
        };
        if !matches!(self.change_async(&id, &[Phase::Queued], |r| r.phase = first).await, Ok(true)) {
            return;
        }
        match (held, &r.ask) {
            (Some(Held::Account(account)), Ask::Understanding(request)) => self.understand_async(&r, request, &account, stop).await,
            (Some(Held::Account(account)), ask) if ask.is_audio() => self.generate_audio_async(&r, &account, stop).await,
            (Some(Held::Image { account, body }), Ask::Image(request)) => {
                self.generate_image_async(&id, request.width, request.height, &account, &body, stop).await;
            }
            (Some(Held::Speech { account, body }), Ask::Speech(request)) => {
                if request.streaming == Some(true) {
                    self.receive_async(&id, &account, &body, stop).await;
                } else if request.asynchronous == Some(true) {
                    match self.moss.speech_task(&account.key, &body, stop).await {
                        Ok(task) => {
                            let _ = self
                                .change_async(&id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| r.remote_task = Some(task))
                                .await;
                            self.poll_async(&id, stop).await;
                        }
                        Err(e) if !stop.aborted() => self.failed_async(&id, e.outcome).await,
                        Err(_) => {}
                    }
                } else {
                    match self.moss.speech_generate(&account.key, &body, stop).await {
                        Ok(g) if !stop.aborted() => {
                            if self.made_async(&id, g).await {
                                self.download_async(&id, stop).await;
                            }
                        }
                        Ok(_) => {}
                        Err(e) if !stop.aborted() => self.failed_async(&id, e.outcome).await,
                        Err(_) => {}
                    }
                }
            }
            _ => self.failed_async(&id, Outcome::Unknown).await,
        }
    }

    async fn generate_image_async(self: &Arc<Self>, id: &str, width: i64, height: i64, account: &Account, body: &MossBody, stop: &Stop) {
        let result = self.moss.image(&account.key, body, width, height, stop).await;
        if stop.aborted() {
            return;
        }
        let moved = match result {
            Ok((url, usage)) => {
                self.change_async(id, &[Phase::Generating], |r| {
                    r.url = Some(url);
                    r.usage = Some(RecordUsage::Image(usage));
                    r.phase = Phase::Downloading;
                })
                .await
            }
            Err(e) => {
                self.failed_async(id, e.outcome).await;
                return;
            }
        };
        if matches!(moved, Ok(true)) {
            self.download_async(id, stop).await;
        }
    }

    pub(super) async fn failed_async(&self, id: &str, outcome: Outcome) {
        let Ok(r) = self.found_async(id).await else { return };
        let words = r.ask.words();
        let (phase, key) = match outcome {
            Outcome::Rejected | Outcome::NotSubmitted => (Phase::Failed, words.rejected),
            Outcome::Unknown => (Phase::Unknown, words.unknown),
        };
        let _ = self
            .change_async(id, &[Phase::Generating], |r| {
                r.phase = phase;
                r.problem = t(&format!("server.media.{key}"), &[]);
            })
            .await;
    }

    pub(super) async fn follow_async(self: &Arc<Self>, id: &str, key: &str, path: &str, body: &MossBody, stop: &Stop) {
        match self.moss.submit(key, path, body, stop).await {
            Ok(task) => {
                let _ = self
                    .change_async(id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| r.remote_task = Some(task))
                    .await;
                self.poll_async(id, stop).await;
            }
            Err(e) if !stop.aborted() => self.failed_async(id, e.outcome).await,
            Err(_) => {}
        }
    }

    async fn made_async(&self, id: &str, g: vendor::Generated) -> bool {
        matches!(
            self.change_async(id, &[Phase::Generating], |r| {
                r.url = Some(g.url);
                r.result_format = MediaAudioFormat::ALL.into_iter().find(|f| f.as_str() == g.format);
                r.content_type = Some(g.content_type);
                r.usage = g.usage.map(RecordUsage::Audio);
                r.phase = Phase::Downloading;
                r.problem.clear();
            })
            .await,
            Ok(true)
        )
    }

    async fn poll_async(self: &Arc<Self>, id: &str, stop: &Stop) {
        for _ in 0..POLLS {
            if stop.aborted() {
                return;
            }
            let Ok(r) = self.found_async(id).await else { return };
            let (Some(task), Phase::Generating) = (r.remote_task.clone(), r.phase) else {
                return;
            };
            let Ok(account) = self.account_of(&r) else { break };
            match self.moss.task(&account.key, &task, stop).await {
                Ok(Task::Waiting) => {}
                Ok(Task::Failed) => return self.failed_async(id, Outcome::Rejected).await,
                Ok(Task::Audio(kind, g)) if r.ask.task() == Some(kind) => {
                    if self.made_async(id, g).await {
                        self.download_async(id, stop).await;
                    }
                    return;
                }
                Ok(Task::Transcription { text, segments, usage }) if r.ask.task() == Some(TaskKind::Transcription) => {
                    let _ = self
                        .change_async(id, &[Phase::Generating], |r| {
                            r.made = Some(MediaAudioResult::Transcription { text, segments });
                            r.usage = usage.map(RecordUsage::Audio);
                            r.phase = Phase::Ready;
                            r.problem.clear();
                        })
                        .await;
                    return;
                }
                Ok(_) => return self.failed_async(id, Outcome::Unknown).await,
                Err(e) if e.retryable() => {}
                Err(_) => break,
            }
            if stop.wait_timeout_async(POLL).await {
                return;
            }
        }
        let _ = self
            .change_async(id, &[Phase::Generating], |r| {
                r.phase = Phase::Unknown;
                r.problem = t(&format!("server.media.{}", r.ask.words().paused), &[]);
            })
            .await;
    }

    async fn download_async(self: &Arc<Self>, id: &str, stop: &Stop) {
        let Ok(r) = self.found_async(id).await else { return };
        let (Some(url), Phase::Downloading) = (r.url.clone(), r.phase) else {
            return;
        };
        let (kept, failed_key) = match &r.ask {
            Ask::Image(request) => (self.fetch_image_async(&url, request.width, request.height, id, stop).await, "downloadFailed"),
            ask => match ask.audio() {
                Some(asked) => (
                    self.fetch_audio_async(&url, r.result_format.unwrap_or(asked), id, stop).await,
                    "speechDownloadFailed",
                ),
                None => return,
            },
        };
        if stop.aborted() {
            return;
        }
        let preview = match (&r.ask, &kept) {
            (Ask::VoiceDesign(_), Ok((Some(attachment), _, Some(metadata)))) => self.preview_async(&r, attachment, metadata).await,
            _ => None,
        };
        let moved = match kept {
            Ok((attachment, input, metadata)) => {
                self.change_async(id, &[Phase::Downloading], |r| {
                    if metadata.is_some() {
                        r.metadata = metadata;
                    }
                    r.attachment = attachment;
                    r.result_input = input;
                    r.preview_input = preview;
                    r.url = None;
                    r.phase = Phase::Ready;
                    r.problem.clear();
                })
                .await
            }
            Err(why) => {
                eprintln!("media {id}: {why}");
                self.change_async(id, &[Phase::Downloading], |r| {
                    r.phase = Phase::DownloadFailed;
                    r.problem = t(&format!("server.media.{failed_key}"), &[]);
                })
                .await
            }
        };
        if let Err(e) = moved {
            eprintln!("media {id}: {}", e.message);
        }
        if let Ok(r) = self.found_async(id).await {
            self.post_back_async(&r).await;
        }
    }

    async fn fetch_image_async(&self, url: &str, width: i64, height: i64, id: &str, stop: &Stop) -> Result<Kept, String> {
        let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
        if !public_https(&parsed) {
            return Err("not a public https address".into());
        }
        let mut response = self
            .download
            .clone()
            .fetch_async(
                Request {
                    method: "GET",
                    url: url.into(),
                    headers: vec![("accept".into(), "image/png".into())],
                    body: None,
                    timeout: Duration::from_secs(60),
                },
                stop.token(),
            )
            .await
            .map_err(|e| format!("{e:?}"))?;
        let kind = response.media_type();
        if response.status != 200 || kind != "image/png" {
            return Err(format!("{} {kind}", response.status));
        }
        let stop_read = stop.clone();
        let bytes = spawn_blocking_traced(move || {
            let bytes = vendor::read_max(&mut response.body, ATTACHMENT_MAX, Some(&stop_read)).map_err(|e| format!("{e:?}"))?;
            if !super::png::valid(&bytes, width, height) {
                return Err("not the image asked for".to_string());
            }
            Ok(bytes)
        })
        .await
        .map_err(|e| e.to_string())??;
        self.storage
            .keep_async(bytes, format!("moss-{id}.png"), "image/png".to_string())
            .await
            .map(|a| (Some(a), None, None))
            .map_err(|e| e.message)
    }

    async fn fetch_audio_async(&self, url: &str, format: MediaAudioFormat, id: &str, stop: &Stop) -> Result<Kept, String> {
        let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
        if !public_https(&parsed) {
            return Err("not a public https address".into());
        }
        let types = vendor::audio_mimes(format.as_str());
        let mut response = self
            .download
            .clone()
            .fetch_async(
                Request {
                    method: "GET",
                    url: url.into(),
                    headers: vec![("accept".into(), types.join(", "))],
                    body: None,
                    timeout: DOWNLOAD_TIME,
                },
                stop.token(),
            )
            .await
            .map_err(|e| format!("{e:?}"))?;
        let kind = response.media_type();
        if response.status != 200 || !types.contains(&kind.as_str()) {
            return Err(format!("{} {kind}", response.status));
        }
        let declared: Option<usize> = response.header("content-length").and_then(|l| l.parse().ok());
        if declared.is_some_and(|n| n == 0 || n > RESULT_MAX) {
            return Err("declared size".into());
        }
        let stop_read = stop.clone();
        let kind_check = kind.clone();
        let (bytes, facts) = spawn_blocking_traced(move || -> Result<(Vec<u8>, super::validate::AudioFacts), String> {
            let bytes = vendor::read_max(&mut response.body, RESULT_MAX, Some(&stop_read)).map_err(|e| format!("{e:?}"))?;
            if declared.is_some_and(|n| n != bytes.len()) || bytes.is_empty() {
                return Err("size".into());
            }
            let facts = super::validate::audio_facts(bytes.clone(), &kind_check).map_err(|e| e.message)?;
            Ok((bytes, facts))
        })
        .await
        .map_err(|e| e.to_string())??;
        let name = format!("moss-{id}.{}", format.as_str());
        let metadata = MediaAudioMetadata {
            source: MediaAudioMetadataSource::File,
            sample_rate: Some(JsNumber(facts.sample_rate.into())),
            duration: Some(JsNumber(facts.seconds)),
            channels: Some(facts.channels as i64),
            bit_depth: facts.bits.map(i64::from),
        };
        let (attachment, input) = self.keep_bytes_async(id, bytes, &name, &kind).await?;
        Ok((attachment, input, Some(metadata)))
    }

    async fn preview_async(&self, r: &Record, attachment: &Attachment, metadata: &MediaAudioMetadata) -> Option<String> {
        let short = metadata.duration.is_some_and(|d| d.0 <= 30.0) && attachment.size <= 10_000_000;
        let cloneable = matches!(r.result_format, Some(MediaAudioFormat::Wav | MediaAudioFormat::Mp3 | MediaAudioFormat::Flac));
        if !short || !cloneable {
            return None;
        }
        let input = self.storage.adopt_input_async(&attachment.id).await.ok()?;
        self.storage.pin_inputs_async(std::slice::from_ref(&input.id), r.id()).await.ok()?;
        Some(input.id)
    }

    async fn keep_bytes_async(&self, id: &str, bytes: Vec<u8>, name: &str, kind: &str) -> Result<(Option<Attachment>, Option<MediaInputReference>), String> {
        if bytes.len() <= ATTACHMENT_MAX {
            let a = self
                .storage
                .keep_async(bytes, name.to_string(), kind.to_string())
                .await
                .map_err(|e| e.message)?;
            return Ok((Some(a), None));
        }
        let input = self
            .storage
            .create_input_async(&MediaInputRequest {
                kind: MediaInputKind::Audio,
                name: name.to_string(),
                mime: kind.to_string(),
                size: bytes.len() as i64,
            })
            .await
            .map_err(|e| e.message)?;
        let input = self
            .storage
            .upload_input_async(&input.id, Box::new(std::io::Cursor::new(bytes)))
            .await
            .map_err(|e| e.message)?;
        self.storage
            .pin_inputs_async(std::slice::from_ref(&input.id), id)
            .await
            .map_err(|e| e.message)?;
        Ok((
            None,
            Some(MediaInputReference {
                id: input.id,
                kind: input.kind,
                name: input.name,
                mime: input.mime,
                size: input.size,
                hash: input.hash.unwrap_or_default(),
            }),
        ))
    }

    async fn emit_async(&self, id: &str, event: Value, stop: &Stop) -> bool {
        let Some(tx) = self.streams.lock().get(id).map(|s| s.tx.clone()) else {
            return false;
        };
        if stop.aborted() {
            return false;
        }
        let token = stop.token();
        tokio::select! {
            biased;
            _ = token.cancelled() => false,
            res = tx.send(event) => res.is_ok(),
        }
    }

    async fn receive_async(self: &Arc<Self>, id: &str, account: &Account, body: &MossBody, stop: &Stop) {
        let mut pcm: Vec<u8> = Vec::new();
        let mut pending: Vec<u8> = Vec::new();
        let mut sequence = 0i64;
        let mut format: Option<(i64, i64)> = None;
        let mut usage: Option<vibevalley_protocol::MediaAudioUsage> = None;
        let mut duration: Option<f64> = None;
        let mut complete = false;
        let (tx, mut rx) = tokio::sync::mpsc::channel::<vendor::SpeechEvent>(32);
        let moss = self.moss.clone();
        let key = account.key.clone();
        let body = body.clone();
        let stop_stream = stop.clone();
        let stream_task = self
            .ctx
            .spawn("media.speech.stream", async move { moss.speech_stream(&key, &body, &stop_stream, tx).await });
        let mut mine_error = false;
        while let Some(event) = rx.recv().await {
            match event {
                vendor::SpeechEvent::TaskCreated(task) => {
                    let _ = self
                        .change_async(id, &[Phase::Generating, Phase::Canceled], |r| r.remote_task = Some(task))
                        .await;
                }
                vendor::SpeechEvent::Created {
                    sample_rate,
                    channels,
                    bit_depth,
                } => {
                    if bit_depth != 16 {
                        mine_error = true;
                        break;
                    }
                    format = Some((sample_rate, channels));
                    self.emit_async(
                        id,
                        json!({ "type": "format", "sampleRate": sample_rate, "channels": channels, "bitDepth": 16 }),
                        stop,
                    )
                    .await;
                }
                vendor::SpeechEvent::Delta(audio) => {
                    let Some((_, channels)) = format else {
                        mine_error = true;
                        break;
                    };
                    if pcm.len() + audio.len() > STREAM_MAX {
                        mine_error = true;
                        break;
                    }
                    let block = channels as usize * 2;
                    pcm.extend_from_slice(&audio);
                    pending.extend_from_slice(&audio);
                    let available = pending.len() - pending.len() % block;
                    let step = 32768 / block * block;
                    for part in pending[..available].chunks(step) {
                        let audio = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, part);
                        self.emit_async(id, json!({ "type": "audio", "sequence": sequence, "audio": audio }), stop)
                            .await;
                        sequence += 1;
                    }
                    pending.drain(..available);
                }
                vendor::SpeechEvent::Done { usage: u, duration: d } => {
                    if pcm.is_empty() || !pending.is_empty() {
                        mine_error = true;
                        break;
                    }
                    usage = u;
                    duration = d;
                    complete = true;
                }
            }
        }
        drop(rx);
        let streamed = match stream_task.await {
            Ok(res) if !mine_error => res,
            Ok(_) => Err(vendor::StreamError::Mine("stream error".into())),
            Err(_) => Err(vendor::StreamError::Mine("join error".into())),
        };
        let saved = match format {
            Some((rate, channels)) => Some(self.keep_stream_async(id, &pcm, rate, channels, complete, duration).await),
            None => None,
        };
        match (streamed, saved) {
            (_, Some(Ok(()))) if !stop.aborted() || complete => {
                if complete {
                    let _ = self.change_async(id, &[Phase::Ready], |r| r.usage = usage.take().map(RecordUsage::Audio)).await;
                    self.emit_async(id, json!({ "type": "done" }), stop).await;
                } else {
                    self.emit_async(id, json!({ "type": "failed" }), stop).await;
                }
            }
            (Err(_), _) | (_, Some(Err(_))) | (_, None) => {
                let _ = self
                    .change_async(id, &[Phase::Generating], |r| {
                        r.phase = Phase::Unknown;
                        r.problem = t("server.media.speechUnknown", &[]);
                    })
                    .await;
                self.emit_async(id, json!({ "type": "failed" }), stop).await;
            }
            _ => {}
        }
        let me = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        let job = id.to_string();
        self.ctx.spawn("media.speech.stream_cleanup", async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
            if let Some(me) = me.upgrade() {
                me.streams.lock().remove(&job);
            }
        });
    }

    async fn keep_stream_async(&self, id: &str, pcm: &[u8], rate: i64, channels: i64, complete: bool, duration: Option<f64>) -> Result<(), String> {
        let block = channels as usize * 2;
        let length = pcm.len() - pcm.len() % block;
        if length == 0 {
            return Err("nothing came".into());
        }
        let mut wav = Vec::with_capacity(44 + length);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + length) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&(channels as u16).to_le_bytes());
        wav.extend_from_slice(&(rate as u32).to_le_bytes());
        wav.extend_from_slice(&((rate as usize * block) as u32).to_le_bytes());
        wav.extend_from_slice(&(block as u16).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(length as u32).to_le_bytes());
        wav.extend_from_slice(&pcm[..length]);
        let name = format!("moss-{id}{}.wav", if complete { "" } else { "-partial" });
        let (attachment, input) = self.keep_bytes_async(id, wav, &name, "audio/wav").await?;
        let seconds = match (complete, duration) {
            (true, Some(d)) => d,
            _ => length as f64 / (rate as f64 * block as f64),
        };
        let metadata = MediaAudioMetadata {
            source: if complete && duration.is_some() {
                MediaAudioMetadataSource::Provider
            } else {
                MediaAudioMetadataSource::File
            },
            sample_rate: Some(JsNumber(rate as f64)),
            duration: Some(JsNumber(seconds)),
            channels: Some(channels),
            bit_depth: Some(16),
        };
        let patch = |r: &mut Record| {
            r.attachment = attachment.clone();
            r.result_input = input.clone();
            r.result_format = Some(MediaAudioFormat::Wav);
            r.content_type = Some("audio/wav".into());
            r.metadata = Some(metadata.clone());
        };
        let moved = self
            .change_async(id, &[Phase::Generating], |r| {
                patch(r);
                if complete {
                    r.phase = Phase::Ready;
                    r.problem.clear();
                } else {
                    r.phase = Phase::Unknown;
                    r.problem = t("server.media.speechPartial", &[]);
                }
            })
            .await
            .map_err(|e| e.message)?;
        if !moved {
            self.change_async(id, &[Phase::Canceled], patch).await.map_err(|e| e.message)?;
        }
        Ok(())
    }

    async fn post_back_async(&self, r: &Record) {
        let (Ask::Image(request), Phase::Ready, MediaSource::Orchestrator { agent, channel }, Some(attachment)) = (&r.ask, r.phase, &r.source, &r.attachment)
        else {
            return;
        };
        let text = t(
            "server.media.imageMade",
            &[("prompt", request.prompt.chars().take(80).collect::<String>().into())],
        );
        if let Err(e) = self
            .channel
            .post_attachments_async(agent, channel, &text, vec![attachment.id.clone()], format!("media:{}", r.id()))
            .await
        {
            eprintln!("media image post: {}", e.message);
        }
    }

    async fn pick_up_async(&self) -> Result<(), ApiError> {
        for r in self.active_jobs_async().await? {
            let id = r.id();
            self.note_async(id, |r| {
                for file in r.remote.iter_mut().filter(|f| f.state == RemoteState::Uploading) {
                    file.state = RemoteState::Unknown;
                }
            })
            .await?;
            match (r.phase, &r.remote_task) {
                (Phase::Downloading, _) => {}
                (Phase::Generating, Some(_)) if !r.ask.streamed() => {}
                (phase, _) => {
                    let unsent = matches!(phase, Phase::Queued | Phase::Authorized);
                    self.change_async(id, &[phase], |r| {
                        r.phase = if unsent { Phase::Canceled } else { Phase::Unknown };
                        r.problem = t("server.media.restarted", &[]);
                        if unsent && r.cleanup.is_some() {
                            r.cleanup = Some(MediaCleanup::Done);
                        }
                    })
                    .await?;
                    if unsent {
                        self.storage.release_input_pins_async(id).await?;
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn list_async(&self) -> Result<Vec<MediaJob>, ApiError> {
        Ok(self.recent_async().await?.iter().map(Record::view).collect())
    }

    pub async fn get_async(&self, id: &str) -> Result<MediaJob, ApiError> {
        Ok(self.found_async(id).await?.view())
    }

    fn stop_run(&self, id: &str) {
        if let Some(run) = self.runs().remove(id) {
            run.stop.abort();
        }
    }

    pub async fn cancel_async(&self, id: &str) -> Result<MediaJob, ApiError> {
        let r = self.found_async(id).await?;
        if active(r.phase) {
            let unsent = matches!(r.ask, Ask::Understanding(_)) && matches!(r.phase, Phase::Authorized | Phase::Queued);
            let moved = self
                .change_async(id, &[r.phase], |r| {
                    r.phase = Phase::Canceled;
                    r.problem = t("server.media.canceled", &[]);
                    if unsent {
                        r.cleanup = Some(MediaCleanup::Done);
                    }
                })
                .await?;
            if moved && unsent {
                self.storage.release_input_pins_async(id).await?;
            }
            self.held.lock().remove(id);
            self.stop_run(id);
            self.schedule_async().await;
            self.settle_async(id).await;
        }
        self.get_async(id).await
    }

    pub async fn retry_download_async(&self, id: &str) -> Result<MediaJob, ApiError> {
        self.open_for_work()?;
        let r = self.found_async(id).await?;
        if matches!(r.phase, Phase::Ready | Phase::Downloading) {
            return Ok(r.view());
        }
        if !r.can_retry_download() {
            return Err(refused("noDownload"));
        }
        self.change_async(id, &[r.phase], |r| {
            r.phase = Phase::Downloading;
            r.problem.clear();
        })
        .await?;
        self.schedule_async().await;
        self.get_async(id).await
    }

    pub(super) async fn resumed_async(&self, r: Record) -> Result<Record, ApiError> {
        if r.phase == Phase::Ready || active(r.phase) {
            return Ok(r);
        }
        if !r.can_resume() {
            return Err(refused(r.ask.words().no_resume));
        }
        self.account_of(&r)?;
        let updated = {
            let _schedule = self.scheduling.lock().await;
            self.change_async(r.id(), &[r.phase], |r| {
                r.phase = Phase::Generating;
                r.problem.clear();
            })
            .await?;
            self.found_async(r.id()).await?
        };
        self.schedule_async().await;
        Ok(updated)
    }

    pub async fn resume_async(&self, id: &str) -> Result<MediaSpeechJob, ApiError> {
        let r = self.found_async(id).await?;
        if !matches!(r.ask, Ask::Speech(_)) {
            return Err(refused("missing"));
        }
        Ok(speech_view(&self.resumed_async(r).await?))
    }

    pub async fn preview_release_async(&self, id: &str) -> Result<Preview, ApiError> {
        let r = self.found_async(id).await?;
        if active(r.phase) || !r.releasable() {
            return Err(refused("releaseUnavailable"));
        }
        let does = if r.can_release() {
            vec![
                t("server.media.releasePreview", &[]),
                t("server.media.releasePreserves", &[]),
                t("server.media.releaseAbandons", &[]),
            ]
        } else {
            vec![]
        };
        Ok(Preview { does })
    }

    pub async fn release_async(&self, id: &str) -> Result<MediaJob, ApiError> {
        let r = self.found_async(id).await?;
        if active(r.phase) || !r.releasable() {
            return Err(refused("releaseUnavailable"));
        }
        if !r.released {
            self.storage.release_input_pins_async(id).await?;
            for input in r.result_input.iter().map(|i| &i.id).chain(&r.preview_input) {
                let _ = self.storage.delete_input_async(input).await;
            }
            self.change_async(id, &[r.phase], |r| {
                r.released = true;
                r.attachment = None;
                r.result_input = None;
                r.preview_input = None;
                r.url = None;
            })
            .await?;
        }
        self.get_async(id).await
    }

    pub fn close(&self) {
        self.cancel.cancel();
        if let Some(ticker) = self.sweeper.lock().take() {
            ticker.cancel();
        }
        self.closed.store(true, Ordering::SeqCst);
        for run in self.runs().values() {
            run.stop.abort();
        }
        self.runs().clear();
    }

    pub(crate) async fn create_image_for_caller_async(&self, caller: Caller, request: MediaImageRequest) -> Result<MediaImageJob, ApiError> {
        if caller != Caller::User {
            return Err(refused("userRequired"));
        }
        self.image_async(request, MediaSource::User {}).await
    }

    pub(crate) async fn create_speech_for_caller_async(&self, caller: Caller, request: MediaSpeechRequest) -> Result<MediaSpeechJob, ApiError> {
        if caller != Caller::User {
            return Err(refused("userRequired"));
        }
        self.speech_async(request, MediaSource::User {}).await
    }

    pub(crate) async fn create_speakers_for_caller_async(&self, caller: Caller, request: MediaSpeakersRequest) -> Result<MediaAudioJob, ApiError> {
        if caller != Caller::User {
            return Err(refused("userRequired"));
        }
        self.speakers_async(request, MediaSource::User {}).await
    }

    pub(crate) async fn create_voice_design_for_caller_async(&self, caller: Caller, request: MediaVoiceDesignRequest) -> Result<MediaAudioJob, ApiError> {
        if caller != Caller::User {
            return Err(refused("userRequired"));
        }
        self.voice_design_async(request, MediaSource::User {}).await
    }

    pub(crate) async fn start_understanding_for_caller_async(&self, caller: Caller, id: &str) -> Result<MediaUnderstandingJob, ApiError> {
        if caller != Caller::Orchestrator {
            return Err(refused("authorizationRequired"));
        }
        self.start_understanding_by_id_async(id).await
    }
}

fn keyed(a: crate::setting::Account) -> Account {
    Account {
        fingerprint: vendor::fingerprint(a.key.expose()),
        key: a.key.expose().to_string(),
        connection: a.connection,
        revision: a.revision,
        model: a.model,
    }
}

fn image_view(r: &Record) -> MediaImageJob {
    match r.view() {
        MediaJob::MediaImageJob(j) => j,
        _ => unreachable!("an image's view"),
    }
}

fn speech_view(r: &Record) -> MediaSpeechJob {
    match r.view() {
        MediaJob::MediaSpeechJob(j) => j,
        _ => unreachable!("a speech's view"),
    }
}

impl crate::context::api::media::SpeechStreams for Media {
    fn claim(&self, id: &str) -> Result<crate::context::api::media::SpeechClaim, ApiError> {
        let events = {
            let mut streams = self.streams.lock();
            let Some(rx) = streams.get_mut(id).and_then(|s| s.rx.take()) else {
                return Err(refused("speechStreamUnavailable"));
            };
            rx
        };
        let me = self.me.get().cloned().unwrap_or_default();
        let job = id.to_string();
        Ok(crate::context::api::media::SpeechClaim {
            events,
            // Runs asynchronously so `Drop` never blocks a Tokio worker.
            gone: Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                me.streams.lock().remove(&job);
                let ctx = me.ctx.clone();
                ctx.spawn("media.speech.cancel_on_drop", async move {
                    let _ = me
                        .change_async(&job, &[Phase::Queued, Phase::Generating], |r| {
                            r.phase = Phase::Canceled;
                            r.problem = t("server.media.canceled", &[]);
                        })
                        .await;
                    me.stop_run(&job);
                });
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::{ChatMessage, NoteCard};

    use super::*;
    use crate::context::api::media::SpeechStreams;
    use crate::context::{LiveState, Outbox, StateFeed, TaskGroup};
    use crate::service::Service;
    use crate::setting::SettingConfig;

    struct DummyAnnounce;

    impl ChannelAnnounce for DummyAnnounce {
        fn place_exists(&self, _: &str) -> bool {
            true
        }

        fn orchestrator_in(&self, _: &str) -> String {
            "orchestrator".into()
        }

        fn place_of_async<'a>(&'a self, _: &'a str, target: &'a str) -> crate::BoxFuture<'a, Result<String, ApiError>> {
            let out = target.to_string();
            Box::pin(async move { Ok(out) })
        }

        fn post_card_async<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
            _: NoteCard,
            _: Option<String>,
            _: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            unimplemented!()
        }

        fn post_attachments_async<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
            _: Vec<String>,
            _: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn regression_speech_claim_gone_does_not_block_tokio_worker_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let (vendor, download) = crate::fake::moss::network();
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service)),
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            vendor,
            download,
        ));
        let setting = Setting::open_async(SettingConfig {
            home: dir.path().to_path_buf(),
            work_root: dir.path().to_path_buf(),
            version: "0.1.0-test".into(),
            deepseek_api_key: String::new(),
            ..Default::default()
        })
        .await;
        let storage = Storage::open_async(dir.path(), ctx.clone()).await.unwrap();
        let jobs = Media::open_async(ctx.clone(), setting, storage.clone(), Arc::new(DummyAnnounce)).await.unwrap();

        let job_id = "speech-drop-1";
        let req = MediaSpeechRequest {
            id: job_id.into(),
            text: "hello".into(),
            voice: "alloy".into(),
            format: MediaAudioFormat::Pcm,
            connection: "moss".into(),
            revision: 1,
            streaming: Some(true),
            asynchronous: None,
        };
        let mut rec = Record::new(
            Ask::Speech(req),
            MediaSource::User {},
            "moss".into(),
            1,
            "moss-tts-1.0-pro".into(),
            "fp".into(),
            1_700_000_000_000,
        );
        rec.phase = Phase::Generating;
        let row = rec.to_row().unwrap();
        ctx.service.note.save_media_job(&row).await.unwrap();
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        jobs.streams.lock().insert(job_id.into(), Stream { tx, rx: Some(rx) });

        let claim = jobs.claim(job_id).unwrap();

        let jobs_async = jobs.clone();
        let ctx_async = ctx.clone();
        tokio::spawn(async move {
            let held_write = ctx_async.service.begin_tx().await.unwrap();
            (claim.gone)();
            assert!(!jobs_async.streams.lock().contains_key(job_id));
            ctx_async.service.rollback_tx(held_write).await.unwrap();

            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            loop {
                if jobs_async.found_async(job_id).await.unwrap().phase == Phase::Canceled {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline, "SpeechClaim::gone must cancel the job asynchronously");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        jobs.close();
        storage.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }
}
