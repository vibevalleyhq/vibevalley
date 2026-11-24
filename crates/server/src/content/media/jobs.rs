//! Media jobs, every kind on one machine. The machine keeps the jobs (one
//! `media_job` row each), admits at most eight active at once, runs each
//! kind's waiting jobs oldest first while the kind has a free slot (images
//! one at a time), and does cancel, download again, release and picking up
//! after a restart once for all kinds. A kind says only how its job is made
//! (`generate`), fetched (`download`) and shown (`Record::view`); the audio
//! kinds are in `audio.rs`, understanding in `understanding.rs`, and what a
//! job uploads to the vendor in `remote.rs`.
//!
//! Credentials stay in memory (`Held`) until the job runs; they never reach
//! the job database. Each run executes as a tracked blocking task bounded by
//! per-kind semaphores; vendor calls block.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::{Mutex, MutexGuard};
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use vibevalley_core::{SharedClock, system_clock};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Attachment, BizCode, Caller, Fact, JsNumber, MediaAudioFormat, MediaAudioMetadata, MediaAudioMetadataSource, MediaAudioResult, MediaCleanup,
    MediaCloneRequest, MediaImageJob, MediaImageJobKind, MediaImageRequest, MediaInputKind, MediaInputReference, MediaInputRequest, MediaJob, MediaPhase,
    MediaSource, MediaSpeakersRequest, MediaSpeechJob, MediaSpeechJobKind, MediaSpeechRequest, MediaTranscriptionRequest, MediaUnderstandingPhase,
    MediaUnderstandingRequest, MediaUnderstandingResult, MediaVoiceDesignRequest, Millis, Preview, ops,
};

use super::Stop;
use super::remote::{RemoteFile, RemoteState};
use super::understanding::Authorization;
use super::vendor::{self, Account, Moss, Outcome, Task, TaskKind};
use crate::Hub;
use crate::app::hub::ports::ChannelAnnouncePort;
use crate::content::attachment::{ATTACHMENT_MAX, Attachments};
use crate::content::media::inputs::Inputs;
use crate::db::ServerDb;
use crate::db::begin_write_tx;
use crate::db::entities::content_media::media_job;
use crate::infra::http::{Fetch, Request, public_https};
use crate::infra::provider::{IMAGE_MODELS, Use};
use crate::infra::setting::Setting;

/// Jobs active at once, every kind together.
const ADMITTED: i64 = 8;
/// The largest audio result kept (`audioResultMax`).
const RESULT_MAX: usize = 512_000_000;
/// The largest streamed speech kept (`128 MiB` of PCM).
const STREAM_MAX: usize = 128 * 1024 * 1024 - 44;
const POLL: Duration = Duration::from_secs(3);
const POLLS: usize = 600;
const DOWNLOAD_TIME: Duration = Duration::from_secs(300);

pub(super) fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}

fn storage(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("media job storage: {e}"))
}

/// A request id: 1 to 80 letters, digits, `_` or `-`.
pub(super) fn id_ok(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Where a job is. The kinds share these; each shows the ones it reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    /// Waiting for the orchestrator the user allowed to start it.
    Authorized,
    Queued,
    Uploading,
    Generating,
    Downloading,
    Ready,
    /// Answered, but cut at the output limit.
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
    /// No work is left in these.
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

    /// As the kinds that generate and download say it.
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

    /// As understanding says it.
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

/// What a kind says when its job goes wrong: keys under `server.media`.
pub(super) struct Words {
    rejected: &'static str,
    unknown: &'static str,
    paused: &'static str,
    no_resume: &'static str,
    account_changed: &'static str,
}

/// What a job was asked to make.
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

    /// The vendor answers it as a stream, which is never asked for twice.
    pub(super) fn streamed(&self) -> bool {
        match self {
            Ask::Speech(r) => r.streaming == Some(true),
            Ask::Transcription(r) => r.streaming == Some(true),
            _ => false,
        }
    }

    /// What its vendor task makes, when it is followed as one.
    fn task(&self) -> Option<TaskKind> {
        match self {
            Ask::Speech(_) | Ask::Speakers(_) => Some(TaskKind::Speech),
            Ask::VoiceDesign(_) => Some(TaskKind::VoiceGeneration),
            Ask::Transcription(_) => Some(TaskKind::Transcription),
            Ask::Image(_) | Ask::Clone(_) | Ask::Understanding(_) => None,
        }
    }

    /// The audio format asked for, when the result is audio to download.
    fn audio(&self) -> Option<MediaAudioFormat> {
        match self {
            Ask::Speech(r) => Some(r.format),
            Ask::Speakers(r) => Some(r.format),
            Ask::VoiceDesign(r) => Some(r.format),
            Ask::Image(_) | Ask::Clone(_) | Ask::Transcription(_) | Ask::Understanding(_) => None,
        }
    }

    /// Several voices, a designed or cloned voice, a transcript: the kinds shown as `MediaAudioJob`.
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

/// What a waiting job runs with, in memory only.
pub(super) enum Held {
    Image {
        account: Account,
        body: Value,
    },
    Speech {
        account: Account,
        body: Value,
    },
    /// The kinds that build their request when they run.
    Account(Account),
}

/// A job as it is kept.
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
    /// Where the result waits at the vendor.
    pub(super) url: Option<String>,
    pub(super) usage: Option<Value>,
    pub(super) metadata: Option<MediaAudioMetadata>,
    pub(super) result_format: Option<MediaAudioFormat>,
    pub(super) content_type: Option<String>,
    pub(super) attachment: Option<Attachment>,
    pub(super) result_input: Option<MediaInputReference>,
    #[serde(default)]
    pub(super) released: bool,
    /// The audio a clone or a transcript reads.
    #[serde(default)]
    pub(super) input: Option<MediaInputReference>,
    /// The images or the video understanding reads.
    #[serde(default)]
    pub(super) inputs: Vec<MediaInputReference>,
    /// A short designed voice kept as an input too, to clone from.
    #[serde(default)]
    pub(super) preview_input: Option<String>,
    /// The cloned voice or the transcript.
    #[serde(default)]
    pub(super) made: Option<MediaAudioResult>,
    #[serde(default)]
    pub(super) understood: Option<MediaUnderstandingResult>,
    /// The user's leave for an orchestrator to start it.
    #[serde(default)]
    pub(super) authorization: Option<Authorization>,
    /// What the job sent to the vendor.
    #[serde(default)]
    pub(super) remote: Vec<RemoteFile>,
    /// Whether understanding's uploads and inputs were let go.
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

    /// A known vendor task can be asked again: never a stream, and nothing came of it yet.
    pub(super) fn can_resume(&self) -> bool {
        self.ask.task().is_some()
            && !self.released
            && !self.ask.streamed()
            && self.remote_task.is_some()
            && matches!(self.phase, Phase::Unknown | Phase::Canceled)
            && self.url.is_none()
            && self.made.is_none()
    }

    /// Audio kept here can be let go; an image is a library item, understanding keeps nothing.
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
                usage: self.usage.clone().and_then(|u| serde_json::from_value(u).ok()),
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
                usage: self.usage.clone().and_then(|u| serde_json::from_value(u).ok()),
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

/// A result kept: as an attachment or a pinned input, and what the file said of itself.
type Kept = (Option<Attachment>, Option<MediaInputReference>, Option<MediaAudioMetadata>);

/// Where generated audio is fetched from: the vendor's public address, never with credentials.
pub type Download = Arc<dyn Fetch>;

/// One streamed job's events: at most 16 waiting, the vendor read no faster than the page takes them.
struct Stream {
    tx: flume::Sender<Value>,
    rx: flume::Receiver<Value>,
    claimed: bool,
}

/// Per-kind concurrency gates: images run one at a time, other kinds up to 8.
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

/// A job running now; dropping it releases its per-kind semaphore slot.
struct Running {
    stop: Stop,
    _permit: OwnedSemaphorePermit,
}

/// What the machine reaches.
pub struct Parts {
    pub db: Arc<ServerDb>,
    pub hub: Weak<Hub>,
    pub setting: Arc<Setting>,
    pub files: Arc<Attachments>,
    pub inputs: Arc<Inputs>,
    pub channel: Arc<dyn ChannelAnnouncePort>,
    pub vendor: Arc<dyn Fetch>,
    pub download: Download,
}

pub struct Jobs {
    db: Arc<ServerDb>,
    held: Mutex<HashMap<String, Held>>,
    runs: Mutex<HashMap<String, Running>>,
    semaphores: KindSemaphores,
    /// One schedule at a time, so a waiting job starts once.
    scheduling: AsyncMutex<()>,
    /// One cleanup at the vendor at a time.
    pub(super) cleaning: AsyncMutex<()>,
    pub(super) moss: Moss,
    download: Download,
    setting: Arc<Setting>,
    files: Arc<Attachments>,
    pub(super) inputs: Arc<Inputs>,
    pub(super) channel: Arc<dyn ChannelAnnouncePort>,
    hub: Weak<Hub>,
    clock: SharedClock,
    closed: AtomicBool,
    me: OnceLock<Weak<Jobs>>,
    streams: Mutex<HashMap<String, Stream>>,
    /// Cancelled at close, which ends the minute's sweep and delayed stream cleanup.
    cancel: CancellationToken,
}

impl Jobs {
    pub fn open(p: Parts) -> Result<Arc<Jobs>, ApiError> {
        Self::open_with_clock(p, system_clock())
    }

    /// Same as [`Jobs::open`], injecting an explicit wall [`Clock`](vibevalley_core::Clock).
    pub fn open_with_clock(p: Parts, clock: SharedClock) -> Result<Arc<Jobs>, ApiError> {
        let cancel = p.hub.upgrade().map(|h| h.child_token()).unwrap_or_default();
        let jobs = Arc::new(Jobs {
            db: p.db,
            held: Mutex::default(),
            runs: Mutex::default(),
            semaphores: KindSemaphores::new(),
            scheduling: AsyncMutex::new(()),
            cleaning: AsyncMutex::new(()),
            moss: Moss { fetch: p.vendor },
            download: p.download,
            setting: p.setting,
            files: p.files,
            inputs: p.inputs,
            channel: p.channel,
            hub: p.hub,
            clock,
            closed: AtomicBool::new(false),
            me: OnceLock::new(),
            streams: Mutex::default(),
            cancel,
        });
        let _ = jobs.me.set(Arc::downgrade(&jobs));
        vibevalley_runtime::rt::block_on(async {
            jobs.pick_up_async().await?;
            let recent = jobs.recent_async().await?;
            jobs.publish_async().await;
            jobs.schedule_async().await;
            for r in recent {
                jobs.post_back_async(&r).await;
            }
            Ok::<_, ApiError>(())
        })?;
        jobs.sweep_each_minute();
        Ok(jobs)
    }

    /// Approvals no orchestrator used in time are ended every minute, until close.
    fn sweep_each_minute(self: &Arc<Self>) {
        let cancel = self.cancel.clone();
        let me = Arc::downgrade(self);
        let fut = async move {
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                }
                let Some(jobs) = me.upgrade() else { break };
                jobs.expire_approvals_async().await;
            }
        };
        if let Some(hub) = self.hub.upgrade() {
            hub.spawn_task(fut);
        } else {
            vibevalley_runtime::rt::current_or_global_handle().spawn(fut);
        }
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<String, Running>> {
        self.runs.lock()
    }

    async fn read_db<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Record>, ApiError> {
        match media_job::Entity::find_by_id(id.to_owned()).one(db).await.map_err(storage)? {
            Some(row) => serde_json::from_str(&row.data).map(Some).map_err(storage),
            None => Ok(None),
        }
    }

    pub(super) async fn found_async(&self, id: &str) -> Result<Record, ApiError> {
        Self::read_db(self.db.read_conn(), id).await?.ok_or_else(|| refused("missing"))
    }

    fn decode_rows(rows: Vec<media_job::Model>) -> Result<Vec<Record>, ApiError> {
        rows.into_iter().map(|row| serde_json::from_str(&row.data).map_err(storage)).collect()
    }

    async fn recent_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = media_job::Entity::find()
            .order_by_desc(media_job::Column::CreatedAt)
            .order_by_asc(media_job::Column::Id)
            .limit(100)
            .all(self.db.read_conn())
            .await
            .map_err(storage)?;
        Self::decode_rows(rows)
    }

    async fn waiting_jobs_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = media_job::Entity::find()
            .filter(media_job::Column::Phase.is_in(["queued", "generating", "downloading"]))
            .order_by_asc(media_job::Column::CreatedAt)
            .order_by_asc(media_job::Column::Id)
            .all(self.db.read_conn())
            .await
            .map_err(storage)?;
        Self::decode_rows(rows)
    }

    async fn active_jobs_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = media_job::Entity::find()
            .filter(media_job::Column::Phase.is_in(["queued", "generating", "downloading", "authorized", "uploading"]))
            .all(self.db.read_conn())
            .await
            .map_err(storage)?;
        Self::decode_rows(rows)
    }

    pub(super) async fn authorized_jobs_async(&self) -> Result<Vec<Record>, ApiError> {
        let rows = media_job::Entity::find()
            .filter(media_job::Column::Phase.eq("authorized"))
            .all(self.db.read_conn())
            .await
            .map_err(storage)?;
        Self::decode_rows(rows)
    }

    pub(super) fn now_ms(&self) -> Millis {
        self.clock.now_ms()
    }

    async fn save_db<C: ConnectionTrait>(db: &C, r: &mut Record, at: Millis) -> Result<(), ApiError> {
        r.updated_at = at;
        let model = media_job::ActiveModel {
            id: Set(r.id().into()),
            kind: Set(r.ask.kind().into()),
            phase: Set(r.phase.as_str().into()),
            data: Set(serde_json::to_string(r).map_err(storage)?),
            created_at: Set(r.created_at),
            updated_at: Set(r.updated_at),
        };
        media_job::Entity::insert(model)
            .on_conflict(
                OnConflict::column(media_job::Column::Id)
                    .update_columns([media_job::Column::Phase, media_job::Column::Data, media_job::Column::UpdatedAt])
                    .to_owned(),
            )
            .exec(db)
            .await
            .map_err(storage)?;
        Ok(())
    }

    async fn require_capacity_db<C: ConnectionTrait>(db: &C) -> Result<(), ApiError> {
        let count = media_job::Entity::find()
            .filter(media_job::Column::Phase.is_in(["queued", "generating", "downloading", "authorized", "uploading"]))
            .count(db)
            .await
            .map_err(storage)?;
        if count as i64 >= ADMITTED {
            return Err(refused("busy"));
        }
        Ok(())
    }

    /// Tells the state of every job now (`mediaChanged`).
    async fn publish_async(&self) {
        match self.recent_async().await {
            Ok(jobs) => {
                if let Some(hub) = self.hub.upgrade() {
                    let jobs = jobs.iter().map(Record::view).collect();
                    hub.apply(vec![Fact::MediaChanged(vibevalley_protocol::FactMediaChanged { at: self.now_ms(), jobs })]);
                }
            }
            Err(e) => eprintln!("media: {}", e.message),
        }
    }

    /// The job moves only from one of `before`, and not once the machine closed; false when it had moved on.
    pub(super) async fn change_async(&self, id: &str, before: &[Phase], patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let tx = begin_write_tx(self.db.write_conn()).await.map_err(storage)?;
        let outcome: Result<bool, ApiError> = async {
            let Some(mut r) = Self::read_db(&tx, id).await? else { return Ok(false) };
            if !before.contains(&r.phase) {
                return Ok(false);
            }
            let was_active = active(r.phase);
            patch(&mut r);
            if !was_active && active(r.phase) {
                Self::require_capacity_db(&tx).await?;
            }
            Self::save_db(&tx, &mut r, self.now_ms()).await?;
            Ok(true)
        }
        .await;
        let changed = match outcome {
            Ok(changed) => {
                tx.commit().await.map_err(storage)?;
                changed
            }
            Err(err) => {
                let _ = tx.rollback().await;
                return Err(err);
            }
        };
        if changed {
            self.publish_async().await;
        }
        Ok(changed)
    }

    /// Something about the job written down, wherever it is.
    pub(super) async fn note_async(&self, id: &str, patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
        self.change_async(id, &Phase::ALL, patch).await
    }

    pub(super) fn open_for_work(&self) -> Result<(), ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        Ok(())
    }

    /// The job already under this ask's id, refused when it was asked otherwise.
    pub(super) async fn known_async(&self, ask: &Ask, alike: impl FnOnce(&Record) -> bool) -> Result<Option<Record>, ApiError> {
        match Self::read_db(self.db.read_conn(), ask.id()).await? {
            Some(old) if old.ask != *ask || !alike(&old) => Err(refused("reusedId")),
            old => Ok(old),
        }
    }

    /// A new job admitted under its id once: the same ask again is the job it made.
    pub(super) async fn admit_async(&self, mut r: Record, held: Option<Held>) -> Result<Record, ApiError> {
        self.open_for_work()?;
        let (record, admitted) = {
            // Another worker may scan queued jobs as soon as the transaction commits.
            let _schedule = self.scheduling.lock().await;
            let tx = begin_write_tx(self.db.write_conn()).await.map_err(storage)?;
            let outcome: Result<(Record, bool), ApiError> = async {
                if let Some(old) = Self::read_db(&tx, r.id()).await? {
                    if old.ask != r.ask
                        || old.source != r.source
                        || old.authorization.as_ref().map(|a| &a.channel) != r.authorization.as_ref().map(|a| &a.channel)
                    {
                        return Err(refused("reusedId"));
                    }
                    return Ok((old, false));
                }
                Self::require_capacity_db(&tx).await?;
                let ids: Vec<_> = r.input.iter().chain(&r.inputs).map(|input| input.id.clone()).collect();
                if !ids.is_empty() {
                    self.inputs.pin_in_async(&tx, &ids, r.id()).await?;
                }
                Self::save_db(&tx, &mut r, self.now_ms()).await?;
                Ok((r, true))
            }
            .await;
            let (record, admitted) = match outcome {
                Ok(res) => {
                    tx.commit().await.map_err(storage)?;
                    res
                }
                Err(err) => {
                    let _ = tx.rollback().await;
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

    /// An image; orchestrators must have the user's word first (their tool checks it).
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

    pub fn image(&self, request: MediaImageRequest, source: MediaSource) -> Result<MediaImageJob, ApiError> {
        vibevalley_runtime::rt::block_on(self.image_async(request, source))
    }

    /// The account `u` is bound to in the settings now.
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

    /// A connection's account whatever it is bound to (a clone asks no model).
    pub(super) fn on_connection(&self, connection: &str) -> Option<Account> {
        self.setting.providers().account_on(connection, "").map(keyed)
    }

    /// The account a job was asked with: its own connection, refused when the key changed since.
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
            let (tx, rx) = flume::bounded(16);
            self.streams.lock().insert(request.id.clone(), Stream { tx, rx, claimed: false });
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

    pub fn speech(&self, request: MediaSpeechRequest, source: MediaSource) -> Result<MediaSpeechJob, ApiError> {
        vibevalley_runtime::rt::block_on(self.speech_async(request, source))
    }

    /// Starts what can run now: each kind's oldest waiting job while the kind has a free slot.
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
                let fut = async move {
                    work.work_async(&id, &stop).await;
                    {
                        let mut runs = work.runs();
                        if runs.get(&id).is_some_and(|x| x.stop.same_as(&stop)) {
                            runs.remove(&id);
                        }
                    }
                    work.schedule_async().await;
                };
                if let Some(hub) = self.hub.upgrade() {
                    hub.spawn_task(fut);
                } else {
                    vibevalley_runtime::rt::current_or_global_handle().spawn(fut);
                }
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

    /// After a run or a cancel, an audio job lets go of what it sent to the vendor.
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
                    let fetch = self.moss.fetch.clone();
                    let key = account.key.clone();
                    let body = body.clone();
                    let stop_req = stop.clone();
                    let task = crate::spawn_blocking_traced(move || Moss { fetch }.speech_task(&key, &body, &stop_req)).await;
                    match task {
                        Ok(Ok(task)) => {
                            let _ = self
                                .change_async(&id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| r.remote_task = Some(task))
                                .await;
                            self.poll_async(&id, stop).await;
                        }
                        Ok(Err(e)) if !stop.aborted() => self.failed_async(&id, e.outcome).await,
                        Ok(Err(_)) => {}
                        Err(_) if !stop.aborted() => self.failed_async(&id, Outcome::Unknown).await,
                        Err(_) => {}
                    }
                } else {
                    let fetch = self.moss.fetch.clone();
                    let key = account.key.clone();
                    let body = body.clone();
                    let stop_req = stop.clone();
                    let generated = crate::spawn_blocking_traced(move || Moss { fetch }.speech_generate(&key, &body, &stop_req)).await;
                    match generated {
                        Ok(Ok(g)) if !stop.aborted() => {
                            if self.made_async(&id, g).await {
                                self.download_async(&id, stop).await;
                            }
                        }
                        Ok(Ok(_)) => {}
                        Ok(Err(e)) if !stop.aborted() => self.failed_async(&id, e.outcome).await,
                        Ok(Err(_)) => {}
                        Err(_) if !stop.aborted() => self.failed_async(&id, Outcome::Unknown).await,
                        Err(_) => {}
                    }
                }
            }
            _ => self.failed_async(&id, Outcome::Unknown).await,
        }
    }

    async fn generate_image_async(self: &Arc<Self>, id: &str, width: i64, height: i64, account: &Account, body: &Value, stop: &Stop) {
        let fetch = self.moss.fetch.clone();
        let key = account.key.clone();
        let body = body.clone();
        let stop_req = stop.clone();
        let result = crate::spawn_blocking_traced(move || Moss { fetch }.image(&key, &body, width, height, &stop_req)).await;
        if stop.aborted() {
            return;
        }
        let moved = match result {
            Ok(Ok((url, usage))) => {
                self.change_async(id, &[Phase::Generating], |r| {
                    r.url = Some(url);
                    r.usage = serde_json::to_value(usage).ok();
                    r.phase = Phase::Downloading;
                })
                .await
            }
            Ok(Err(e)) => {
                self.failed_async(id, e.outcome).await;
                return;
            }
            Err(_) => {
                self.failed_async(id, Outcome::Unknown).await;
                return;
            }
        };
        if matches!(moved, Ok(true)) {
            self.download_async(id, stop).await;
        }
    }

    /// The vendor refused it, or nothing says what came of it; what was never sent counts as refused.
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

    /// A vendor task asked for and followed; its id is kept even when the job was stopped meanwhile.
    pub(super) async fn follow_async(self: &Arc<Self>, id: &str, key: &str, path: &str, body: &Value, stop: &Stop) {
        let fetch = self.moss.fetch.clone();
        let key = key.to_string();
        let path = path.to_string();
        let body = body.clone();
        let stop_req = stop.clone();
        let submitted = crate::spawn_blocking_traced(move || Moss { fetch }.submit(&key, &path, &body, &stop_req)).await;
        match submitted {
            Ok(Ok(task)) => {
                let _ = self
                    .change_async(id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| r.remote_task = Some(task))
                    .await;
                self.poll_async(id, stop).await;
            }
            Ok(Err(e)) if !stop.aborted() => self.failed_async(id, e.outcome).await,
            Ok(Err(_)) => {}
            Err(_) if !stop.aborted() => self.failed_async(id, Outcome::Unknown).await,
            Err(_) => {}
        }
    }

    /// The vendor made it: where to fetch it, then fetching.
    async fn made_async(&self, id: &str, g: vendor::Generated) -> bool {
        matches!(
            self.change_async(id, &[Phase::Generating], |r| {
                r.url = Some(g.url);
                r.result_format = MediaAudioFormat::ALL.into_iter().find(|f| f.as_str() == g.format);
                r.content_type = Some(g.content_type);
                r.usage = g.usage;
                r.phase = Phase::Downloading;
                r.problem.clear();
            })
            .await,
            Ok(true)
        )
    }

    /// `poll`: the vendor's task asked every 3 s until it answers, at most 600 times.
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
            let fetch = self.moss.fetch.clone();
            let key = account.key.clone();
            let stop_req = stop.clone();
            let polled = crate::spawn_blocking_traced(move || Moss { fetch }.task(&key, &task, &stop_req)).await;
            match polled {
                Ok(Ok(Task::Waiting)) => {}
                Ok(Ok(Task::Failed)) => return self.failed_async(id, Outcome::Rejected).await,
                Ok(Ok(Task::Audio(kind, g))) if r.ask.task() == Some(kind) => {
                    if self.made_async(id, g).await {
                        self.download_async(id, stop).await;
                    }
                    return;
                }
                Ok(Ok(Task::Transcription { text, segments, usage })) if r.ask.task() == Some(TaskKind::Transcription) => {
                    let _ = self
                        .change_async(id, &[Phase::Generating], |r| {
                            r.made = Some(MediaAudioResult::Transcription { text, segments });
                            r.usage = usage;
                            r.phase = Phase::Ready;
                            r.problem.clear();
                        })
                        .await;
                    return;
                }
                Ok(Ok(_)) => return self.failed_async(id, Outcome::Unknown).await,
                Ok(Err(e)) if e.retryable() => {}
                Ok(Err(_)) | Err(_) => break,
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

    /// The result fetched, checked and kept; anything off is a failed download.
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
        let bytes = crate::spawn_blocking_traced(move || {
            let bytes = vendor::read_max(&mut response.body, ATTACHMENT_MAX, Some(&stop_read)).map_err(|e| format!("{e:?}"))?;
            if !super::png::valid(&bytes, width, height) {
                return Err("not the image asked for".to_string());
            }
            Ok(bytes)
        })
        .await
        .map_err(|e| e.to_string())??;
        self.files
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
        let (bytes, facts) = crate::spawn_blocking_traced(move || -> Result<(Vec<u8>, super::validate::AudioFacts), String> {
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

    /// A short designed voice kept as an input of the job too, to clone from or hear again.
    async fn preview_async(&self, r: &Record, attachment: &Attachment, metadata: &MediaAudioMetadata) -> Option<String> {
        let short = metadata.duration.is_some_and(|d| d.0 <= 30.0) && attachment.size <= 10_000_000;
        let cloneable = matches!(r.result_format, Some(MediaAudioFormat::Wav | MediaAudioFormat::Mp3 | MediaAudioFormat::Flac));
        if !short || !cloneable {
            return None;
        }
        let input = self.inputs.adopt_async(&attachment.id).await.ok()?;
        self.inputs.pin_async(std::slice::from_ref(&input.id), r.id()).await.ok()?;
        Some(input.id)
    }

    /// Bytes kept for a job: an attachment, or past an attachment's size a pinned input released with the job.
    async fn keep_bytes_async(&self, id: &str, bytes: Vec<u8>, name: &str, kind: &str) -> Result<(Option<Attachment>, Option<MediaInputReference>), String> {
        if bytes.len() <= ATTACHMENT_MAX {
            let a = self.files.keep_async(bytes, name.to_string(), kind.to_string()).await.map_err(|e| e.message)?;
            return Ok((Some(a), None));
        }
        let input = self
            .inputs
            .create_async(&MediaInputRequest {
                kind: MediaInputKind::Audio,
                name: serde_json::from_value(Value::String(name.to_string())).map_err(|e| e.to_string())?,
                mime: kind.to_string(),
                size: bytes.len() as i64,
            })
            .await
            .map_err(|e| e.message)?;
        let input = self
            .inputs
            .upload_async(&input.id, Box::new(std::io::Cursor::new(bytes)))
            .await
            .map_err(|e| e.message)?;
        self.inputs.pin_async(std::slice::from_ref(&input.id), id).await.map_err(|e| e.message)?;
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

    /// One event to the job's page, waiting while it is behind; false once the page or the job is gone.
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
            res = tx.send_async(event) => res.is_ok(),
        }
    }

    /// `receiveSpeechStream`: the vendor's PCM relayed to the page as it comes and kept whole (or as much as came) as a WAV.
    async fn receive_async(self: &Arc<Self>, id: &str, account: &Account, body: &Value, stop: &Stop) {
        let mut pcm: Vec<u8> = Vec::new();
        let mut pending: Vec<u8> = Vec::new();
        let mut sequence = 0i64;
        let mut format: Option<(i64, i64)> = None;
        let mut usage: Option<Value> = None;
        let mut duration: Option<f64> = None;
        let mut complete = false;
        let (tx, mut rx) = tokio::sync::mpsc::channel::<vendor::SpeechEvent>(32);
        let fetch = self.moss.fetch.clone();
        let key = account.key.clone();
        let body = body.clone();
        let stop_stream = stop.clone();
        let stream_task = crate::spawn_blocking_traced(move || {
            Moss { fetch }.speech_stream(&key, &body, &stop_stream, &mut |event| {
                tx.blocking_send(event).map_err(|_| "stopped".to_string())?;
                Ok(())
            })
        });
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
                    let _ = self.change_async(id, &[Phase::Ready], |r| r.usage = usage.take()).await;
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
        // A finished stream's events stay a minute for a page that comes late.
        let me = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        let job = id.to_string();
        let cleanup = async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
            if let Some(me) = me.upgrade() {
                me.streams.lock().remove(&job);
            }
        };
        if let Some(hub) = self.hub.upgrade() {
            hub.spawn_task(cleanup);
        } else {
            vibevalley_runtime::rt::current_or_global_handle().spawn(cleanup);
        }
    }

    /// What came of a stream, kept as a WAV: ready when complete, else unknown with what came.
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

    /// A ready image the orchestrator asked for, posted once to its channel.
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

    /// Jobs a restart left: a known vendor task is asked again (never a stream), a download fetched again, the rest
    /// given up. What never started lets go of its inputs; an upload cut short may or may not be at the vendor.
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
                        self.inputs.release_async(id).await?;
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
            // Understanding that sent nothing has nothing to clean and no use for its inputs.
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
                self.inputs.release_async(id).await?;
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

    /// `resume`: only the known vendor task is asked again, never a new one.
    pub(super) async fn resumed_async(&self, r: Record) -> Result<Record, ApiError> {
        if r.phase == Phase::Ready || active(r.phase) {
            return Ok(r);
        }
        if !r.can_resume() {
            return Err(refused(r.ask.words().no_resume));
        }
        self.account_of(&r)?;
        // Hold `scheduling` across the transition and snapshot so a finishing worker cannot
        // pick up the resumed job before the caller observes `Generating`.
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

    /// The job's kept result let go; the job itself stays.
    pub async fn release_async(&self, id: &str) -> Result<MediaJob, ApiError> {
        let r = self.found_async(id).await?;
        if active(r.phase) || !r.releasable() {
            return Err(refused("releaseUnavailable"));
        }
        if !r.released {
            self.inputs.release_async(id).await?;
            // The inputs the job made for itself go; the one the user gave stays theirs.
            for input in r.result_input.iter().map(|i| &i.id).chain(&r.preview_input) {
                let _ = self.inputs.delete_async(input).await;
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

    /// Stops every run; what was running is picked up at the next start.
    pub fn close(&self) {
        self.cancel.cancel();
        self.closed.store(true, Ordering::SeqCst);
        for run in self.runs().values() {
            run.stop.abort();
        }
        self.runs().clear();
    }
}

/// A settings account with its key out and fingerprinted, as the vendor calls take it.
fn keyed(a: crate::infra::provider::Account) -> Account {
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

pub fn install(hub: &Hub, jobs: Arc<Jobs>) {
    let user_only = |caller: Caller| if caller == Caller::User { Ok(()) } else { Err(refused("userRequired")) };
    let j = jobs.clone();
    hub.on_async::<ops::MediaImageCreate, _, _>(move |ctx, r| {
        let j = j.clone();
        async move {
            user_only(ctx.caller)?;
            j.image_async(r, MediaSource::User {}).await
        }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaSpeechCreate, _, _>(move |ctx, r| {
        let j = j.clone();
        async move {
            user_only(ctx.caller)?;
            j.speech_async(r, MediaSource::User {}).await
        }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaSpeechResume, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.resume_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaDialogueCreate, _, _>(move |ctx, r| {
        let j = j.clone();
        async move {
            user_only(ctx.caller)?;
            j.speakers_async(r, MediaSource::User {}).await
        }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaVoiceDesignCreate, _, _>(move |ctx, r| {
        let j = j.clone();
        async move {
            user_only(ctx.caller)?;
            j.voice_design_async(r, MediaSource::User {}).await
        }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaCloneCreate, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.clone_voice_async(r).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaTranscriptionCreate, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.transcription_async(r).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaAudioResume, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.audio_resume_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaAudioPreviewCleanup, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.preview_audio_cleanup_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaAudioCleanup, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.audio_cleanup_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaUnderstandingCreate, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.understanding_async(r).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaUnderstandingAuthorize, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.authorize_understanding_async(r).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaUnderstandingStart, _, _>(move |ctx, r| {
        let j = j.clone();
        async move {
            if ctx.caller != Caller::Orchestrator {
                return Err(refused("authorizationRequired"));
            }
            j.start_understanding_by_id_async(&r.id).await
        }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaUnderstandingPreviewCleanup, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.preview_understanding_cleanup_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaUnderstandingCleanup, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.understanding_cleanup_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaJobList, _, _>(move |_, _| {
        let j = j.clone();
        async move { j.list_async().await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaJobGet, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.get_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaJobCancel, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.cancel_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaJobDownload, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.retry_download_async(&r.id).await }
    });
    let j = jobs.clone();
    hub.on_async::<ops::MediaJobPreviewRelease, _, _>(move |_, r| {
        let j = j.clone();
        async move { j.preview_release_async(&r.id).await }
    });
    hub.on_async::<ops::MediaJobRelease, _, _>(move |_, r| {
        let jobs = jobs.clone();
        async move { jobs.release_async(&r.id).await }
    });
}

impl crate::transport::api::media::SpeechStreams for Jobs {
    fn claim(&self, id: &str) -> Result<crate::transport::api::media::SpeechClaim, ApiError> {
        let events = {
            let mut streams = self.streams.lock();
            let Some(s) = streams.get_mut(id).filter(|s| !s.claimed) else {
                return Err(refused("speechStreamUnavailable"));
            };
            s.claimed = true;
            s.rx.clone()
        };
        let me = self.me.get().cloned().unwrap_or_default();
        let job = id.to_string();
        Ok(crate::transport::api::media::SpeechClaim {
            events,
            // The page gone: its job is canceled and its work stopped (a finished one is left as it is).
            // Runs asynchronously so `Drop` never calls `rt::block_on` on a Tokio I/O worker.
            gone: Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                me.streams.lock().remove(&job);
                let hub = me.hub.upgrade();
                let fut = async move {
                    let _ = me
                        .change_async(&job, &[Phase::Queued, Phase::Generating], |r| {
                            r.phase = Phase::Canceled;
                            r.problem = t("server.media.canceled", &[]);
                        })
                        .await;
                    me.stop_run(&job);
                };
                if let Some(hub) = hub {
                    hub.spawn_task(fut);
                } else {
                    vibevalley_runtime::rt::current_or_global_handle().spawn(fut);
                }
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::channel::Chat;
    use crate::infra::setting::SettingConfig;
    use crate::transport::api::media::SpeechStreams;

    #[test]
    fn regression_speech_claim_gone_does_not_block_tokio_worker_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let setting = Setting::open(SettingConfig {
            home: dir.path().to_path_buf(),
            work_root: dir.path().to_path_buf(),
            version: "0.1.0-test".into(),
            deepseek_api_key: String::new(),
        });
        let files = Attachments::open(dir.path(), db.clone());
        let chat = Chat::open(db.clone(), &hub, files.clone(), None, false).unwrap();
        let inputs = Inputs::open(dir.path(), db.clone(), files.clone()).unwrap();
        let (vendor, download) = crate::app::fakes::moss::network();
        let jobs = Jobs::open(Parts {
            db: db.clone(),
            hub: Arc::downgrade(&hub),
            setting,
            files,
            inputs: inputs.clone(),
            channel: chat,
            vendor,
            download,
        })
        .unwrap();

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
        vibevalley_runtime::rt::block_on(async {
            Jobs::save_db(db.write_conn(), &mut rec, 1_700_000_000_000).await.unwrap();
        });
        let (tx, rx) = flume::bounded(16);
        jobs.streams.lock().insert(job_id.into(), Stream { tx, rx, claimed: false });

        let claim = jobs.claim(job_id).unwrap();

        // Hold the sole write connection on the Tokio worker while invoking `gone`:
        // if `gone` still called `rt::block_on(change_async)`, this would deadlock before returning.
        let jobs_async = jobs.clone();
        let db_async = db.clone();
        let hub_async = hub.clone();
        vibevalley_runtime::rt::block_on(async move {
            vibevalley_runtime::rt::spawn(async move {
                use sea_orm::TransactionTrait;
                let held_write = db_async.write_conn().begin().await.unwrap();
                (claim.gone)();
                assert!(!jobs_async.streams.lock().contains_key(job_id));
                drop(held_write);

                let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
                loop {
                    if jobs_async.found_async(job_id).await.unwrap().phase == Phase::Canceled {
                        break;
                    }
                    assert!(tokio::time::Instant::now() < deadline, "SpeechClaim::gone must cancel the job asynchronously");
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                jobs_async.close();
                hub_async.close_async().await;
            })
            .await
            .unwrap();
        });

        inputs.close();
        db.close();
    }
}
