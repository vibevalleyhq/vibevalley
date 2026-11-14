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
//! the job database. Each run is a thread of its own; vendor calls block.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Attachment, BizCode, Caller, Fact, JsNumber, MediaAudioFormat, MediaAudioMetadata, MediaAudioMetadataSource, MediaAudioResult, MediaCleanup,
    MediaCloneRequest, MediaImageJob, MediaImageJobKind, MediaImageRequest, MediaInputKind, MediaInputReference, MediaInputRequest, MediaJob, MediaPhase,
    MediaSource, MediaSpeakersRequest, MediaSpeechJob, MediaSpeechJobKind, MediaSpeechRequest, MediaTranscriptionRequest, MediaUnderstandingPhase,
    MediaUnderstandingRequest, MediaUnderstandingResult, MediaVoiceDesignRequest, Preview, ops,
};

use super::Stop;
use super::image_provider::{Failure, ImageBackend, Prepared, Work};
use super::remote::{RemoteFile, RemoteState};
use super::understanding::Authorization;
use super::vendor::{self, Account, Fetch, Moss, Outcome, Request, Task, TaskKind};
use crate::Hub;
use crate::base::open_db;
use crate::modules::attachment::{ATTACHMENT_MAX, Attachments};
use crate::modules::channel::{Chat, Made, Posting};
use crate::modules::media::inputs::Inputs;
use crate::modules::provider::Use;
use crate::modules::setting::Setting;
use crate::now;

/// Jobs active at once, every kind together.
const ADMITTED: i64 = 8;
/// The largest audio result kept (`audioResultMax`).
const RESULT_MAX: usize = 512_000_000;
/// The largest streamed speech kept (`128 MiB` of PCM).
const STREAM_MAX: usize = 128 * 1024 * 1024 - 44;
const POLL: Duration = Duration::from_secs(3);
const POLLS: usize = 600;
const DOWNLOAD_TIME: Duration = Duration::from_secs(300);
const ACTIVE: &str = "('queued','generating','downloading','authorized','uploading')";

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

    /// How many of this kind run at once.
    fn slots(&self) -> usize {
        match self {
            Ask::Image(_) => 1,
            _ => 8,
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
    Image(Prepared),
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
    pub(super) fn new(ask: Ask, source: MediaSource, connection: String, revision: i64, model: String, fingerprint: String) -> Record {
        let at = now();
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

/// A job running now.
struct Running {
    kind: &'static str,
    stop: Stop,
}

/// What the machine reaches.
pub struct Parts {
    pub home: std::path::PathBuf,
    pub hub: Weak<Hub>,
    pub setting: Arc<Setting>,
    pub files: Arc<Attachments>,
    pub inputs: Arc<Inputs>,
    pub chat: Arc<Chat>,
    pub images: Arc<dyn ImageBackend>,
    pub vendor: Arc<dyn Fetch>,
    pub download: Download,
}

pub struct Jobs {
    db: Mutex<Connection>,
    held: Mutex<HashMap<String, Held>>,
    runs: Mutex<HashMap<String, Running>>,
    /// One schedule at a time, so a waiting job starts once.
    scheduling: Mutex<()>,
    /// One cleanup at the vendor at a time.
    pub(super) cleaning: Mutex<()>,
    images: Arc<dyn ImageBackend>,
    pub(super) moss: Moss,
    download: Download,
    setting: Arc<Setting>,
    files: Arc<Attachments>,
    pub(super) inputs: Arc<Inputs>,
    pub(super) chat: Arc<Chat>,
    hub: Weak<Hub>,
    closed: AtomicBool,
    me: OnceLock<Weak<Jobs>>,
    streams: Mutex<HashMap<String, Stream>>,
    /// Dropped at close, which ends the minute's sweep.
    sweeping: Mutex<Option<flume::Sender<()>>>,
}

impl Jobs {
    pub fn open(p: Parts) -> Result<Arc<Jobs>, ApiError> {
        let db = open_db(&p.home).map_err(storage)?;
        db.execute_batch(
            "create table if not exists media_job(id text primary key,kind text not null,phase text not null,data text not null,created_at integer not null,updated_at integer not null);
             create index if not exists media_job_recent on media_job(created_at desc,id);",
        )
        .map_err(storage)?;
        let jobs = Arc::new(Jobs {
            db: Mutex::new(db),
            held: Mutex::default(),
            runs: Mutex::default(),
            scheduling: Mutex::default(),
            cleaning: Mutex::default(),
            images: p.images,
            moss: Moss { fetch: p.vendor },
            download: p.download,
            setting: p.setting,
            files: p.files,
            inputs: p.inputs,
            chat: p.chat,
            hub: p.hub,
            closed: AtomicBool::new(false),
            me: OnceLock::new(),
            streams: Mutex::default(),
            sweeping: Mutex::default(),
        });
        let _ = jobs.me.set(Arc::downgrade(&jobs));
        jobs.pick_up()?;
        for r in jobs.recent()? {
            jobs.post_back(&r);
        }
        jobs.publish();
        jobs.schedule();
        jobs.sweep_each_minute()?;
        Ok(jobs)
    }

    /// Approvals no orchestrator used in time are ended every minute, until close.
    fn sweep_each_minute(self: &Arc<Self>) -> Result<(), ApiError> {
        let (stop, stopped) = flume::bounded::<()>(1);
        *self.sweeping.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop);
        let me = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("media-job-sweep".into())
            .spawn(move || {
                while matches!(stopped.recv_timeout(Duration::from_secs(60)), Err(flume::RecvTimeoutError::Timeout)) {
                    let Some(jobs) = me.upgrade() else { break };
                    jobs.expire_approvals();
                }
            })
            .map_err(storage)?;
        Ok(())
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<String, Running>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read(db: &Connection, id: &str) -> Result<Option<Record>, ApiError> {
        let data: Option<String> = db
            .query_row("select data from media_job where id=?1", [id], |r| r.get(0))
            .optional()
            .map_err(storage)?;
        Ok(data.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub(super) fn found(&self, id: &str) -> Result<Record, ApiError> {
        Self::read(&self.db(), id)?.ok_or_else(|| refused("missing"))
    }

    pub(super) fn rows(&self, sql: &str) -> Result<Vec<Record>, ApiError> {
        let db = self.db();
        let mut q = db.prepare(sql).map_err(storage)?;
        let rows: Vec<String> = q.query_map([], |r| r.get::<_, String>(0)).map_err(storage)?.filter_map(Result::ok).collect();
        Ok(rows.into_iter().filter_map(|d| serde_json::from_str(&d).ok()).collect())
    }

    fn recent(&self) -> Result<Vec<Record>, ApiError> {
        self.rows("select data from media_job order by created_at desc,id limit 100")
    }

    fn save(db: &Connection, r: &mut Record) -> Result<(), ApiError> {
        r.updated_at = now();
        db.execute(
            "insert into media_job(id,kind,phase,data,created_at,updated_at) values (?1,?2,?3,?4,?5,?6)
             on conflict(id) do update set phase=excluded.phase,data=excluded.data,updated_at=excluded.updated_at",
            params![
                r.id(),
                r.ask.kind(),
                r.phase.as_str(),
                serde_json::to_string(r).map_err(storage)?,
                r.created_at,
                r.updated_at
            ],
        )
        .map_err(storage)?;
        Ok(())
    }

    /// Tells the state of every job now (`mediaChanged`).
    fn publish(&self) {
        match self.recent() {
            Ok(jobs) => {
                if let Some(hub) = self.hub.upgrade() {
                    let jobs = jobs.iter().map(Record::view).collect();
                    hub.apply(vec![Fact::MediaChanged(vibevalley_protocol::FactMediaChanged { at: now(), jobs })]);
                }
            }
            Err(e) => eprintln!("media: {}", e.message),
        }
    }

    /// The job moves only from one of `before`, and not once the machine closed; false when it had moved on.
    pub(super) fn change(&self, id: &str, before: &[Phase], patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        {
            let db = self.db();
            let Some(mut r) = Self::read(&db, id)? else { return Ok(false) };
            if !before.contains(&r.phase) {
                return Ok(false);
            }
            patch(&mut r);
            Self::save(&db, &mut r)?;
        }
        self.publish();
        Ok(true)
    }

    /// Something about the job written down, wherever it is.
    pub(super) fn note(&self, id: &str, patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
        self.change(id, &Phase::ALL, patch)
    }

    pub(super) fn open_for_work(&self) -> Result<(), ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        Ok(())
    }

    /// The job already under this ask's id, refused when it was asked otherwise.
    pub(super) fn known(&self, ask: &Ask, alike: impl FnOnce(&Record) -> bool) -> Result<Option<Record>, ApiError> {
        match Self::read(&self.db(), ask.id())? {
            Some(old) if old.ask != *ask || !alike(&old) => Err(refused("reusedId")),
            old => Ok(old),
        }
    }

    /// A new job admitted under its id once: the same ask again is the job it made.
    pub(super) fn admit(&self, mut r: Record, held: Option<Held>) -> Result<Record, ApiError> {
        self.open_for_work()?;
        {
            let db = self.db();
            if let Some(old) = Self::read(&db, r.id())? {
                if old.ask != r.ask || old.source != r.source {
                    return Err(refused("reusedId"));
                }
                return Ok(old);
            }
            let busy: i64 = db
                .query_row(&format!("select count(*) from media_job where phase in {ACTIVE}"), [], |x| x.get(0))
                .map_err(storage)?;
            if busy >= ADMITTED {
                return Err(refused("busy"));
            }
            Self::save(&db, &mut r)?;
        }
        if let Some(held) = held {
            self.hold(r.id(), held);
        }
        self.publish();
        self.schedule();
        Ok(r)
    }

    pub(super) fn hold(&self, id: &str, held: Held) {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), held);
    }

    /// An image; orchestrators must have the user's word first (their tool checks it).
    pub fn image(&self, request: MediaImageRequest, source: MediaSource) -> Result<MediaImageJob, ApiError> {
        super::image_provider::body(&request, "")?;
        if let MediaSource::Orchestrator { agent, channel } = &source
            && (agent.is_empty() || channel.is_empty())
        {
            return Err(refused("invalid"));
        }
        self.open_for_work()?;
        let ask = Ask::Image(request);
        if let Some(old) = Self::read(&self.db(), ask.id())? {
            if old.ask != ask || old.source != source {
                return Err(refused("reusedId"));
            }
            return Ok(image_view(&old));
        }
        let Ask::Image(request) = &ask else { unreachable!() };
        let prepared = self.images.prepare(request)?;
        let r = Record::new(
            ask,
            source,
            prepared.connection.clone(),
            prepared.revision,
            prepared.model.clone(),
            String::new(),
        );
        self.admit(r, Some(Held::Image(prepared))).map(|r| image_view(&r))
    }

    /// The account `u` is bound to in the settings now.
    pub(super) fn bound(&self, u: Use) -> Result<Account, ApiError> {
        let unbound = || {
            let words = match u {
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

    pub fn speech(&self, request: MediaSpeechRequest, source: MediaSource) -> Result<MediaSpeechJob, ApiError> {
        self.open_for_work()?;
        let streaming = request.streaming == Some(true);
        if streaming && (!matches!(source, MediaSource::User {}) || request.asynchronous == Some(true) || request.format != MediaAudioFormat::Pcm) {
            return Err(refused("speechInvalid"));
        }
        if streaming && self.streams.lock().unwrap_or_else(|e| e.into_inner()).len() >= 8 {
            return Err(refused("speechInvalid"));
        }
        let ask = Ask::Speech(request.clone());
        if let Some(old) = Self::read(&self.db(), &request.id)? {
            if old.ask != ask || old.source != source {
                return Err(refused("reusedId"));
            }
            return Ok(speech_view(&old));
        }
        let account = self.bound(Use::Speech)?;
        if request.connection != account.connection || request.revision != account.revision {
            return Err(refused("speechChanged"));
        }
        let body = Moss::prepare_speech(&account.model, &request.text, &request.voice, request.format.as_str()).map_err(|_| refused("speechInvalid"))?;
        if streaming {
            let (tx, rx) = flume::bounded(16);
            self.streams
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(request.id.clone(), Stream { tx, rx, claimed: false });
        }
        let r = Record::new(
            ask,
            source,
            account.connection.clone(),
            account.revision,
            account.model.clone(),
            account.fingerprint.clone(),
        );
        self.admit(r, Some(Held::Speech { account, body })).map(|r| speech_view(&r))
    }

    /// Starts what can run now: each kind's oldest waiting job while the kind has a free slot.
    pub(super) fn schedule(&self) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let Some(me) = self.me.get().and_then(Weak::upgrade) else { return };
        let _one = self.scheduling.lock().unwrap_or_else(|e| e.into_inner());
        let waiting = match self.rows("select data from media_job where phase in ('queued','generating','downloading') order by created_at,id") {
            Ok(w) => w,
            Err(e) => return eprintln!("media: {}", e.message),
        };
        for r in waiting {
            let ready = match r.phase {
                Phase::Queued | Phase::Downloading => true,
                Phase::Generating => r.remote_task.is_some(),
                _ => false,
            };
            let mut runs = self.runs();
            let busy = runs.values().filter(|x| x.kind == r.ask.kind()).count();
            if !ready || runs.contains_key(r.id()) || busy >= r.ask.slots() {
                continue;
            }
            let stop = Stop::default();
            runs.insert(
                r.id().to_string(),
                Running {
                    kind: r.ask.kind(),
                    stop: stop.clone(),
                },
            );
            drop(runs);
            let id = r.id().to_string();
            let work = me.clone();
            let spawned = std::thread::Builder::new().name(format!("media-{id}")).spawn(move || {
                work.work(&id, &stop);
                {
                    let mut runs = work.runs();
                    if runs.get(&id).is_some_and(|x| Arc::ptr_eq(&x.stop.0, &stop.0)) {
                        runs.remove(&id);
                    }
                }
                work.schedule();
            });
            if let Err(e) = spawned {
                eprintln!("media: {e}");
            }
        }
    }

    fn work(self: &Arc<Self>, id: &str, stop: &Stop) {
        let Ok(r) = self.found(id) else { return };
        match r.phase {
            Phase::Queued => self.generate(r, stop),
            Phase::Downloading => self.download(id, stop),
            Phase::Generating if r.remote_task.is_some() => self.poll(id, stop),
            _ => {}
        }
        self.settle(id);
    }

    /// After a run or a cancel, an audio job lets go of what it sent to the vendor.
    fn settle(&self, id: &str) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if self.found(id).is_ok_and(|r| r.ask.is_audio()) {
            self.tidy_audio(id);
        }
    }

    fn generate(self: &Arc<Self>, r: Record, stop: &Stop) {
        let id = r.id().to_string();
        let held = self.held.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        let first = if matches!(r.ask, Ask::Understanding(_)) {
            Phase::Uploading
        } else {
            Phase::Generating
        };
        if !matches!(self.change(&id, &[Phase::Queued], |r| r.phase = first), Ok(true)) {
            return;
        }
        match (held, &r.ask) {
            (Some(Held::Account(account)), Ask::Understanding(request)) => self.understand(&r, request, &account, stop),
            (Some(Held::Account(account)), ask) if ask.is_audio() => self.generate_audio(&r, &account, stop),
            (Some(Held::Image(prepared)), Ask::Image(_)) => self.generate_image(&id, prepared, stop),
            (Some(Held::Speech { account, body }), Ask::Speech(request)) => {
                if request.streaming == Some(true) {
                    self.receive(&id, &account, &body, stop);
                } else if request.asynchronous == Some(true) {
                    match self.moss.speech_task(&account.key, &body) {
                        Ok(task) => {
                            let _ = self.change(&id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| r.remote_task = Some(task));
                            self.poll(&id, stop);
                        }
                        Err(e) => self.failed(&id, e.outcome),
                    }
                } else {
                    match self.moss.speech_generate(&account.key, &body) {
                        Ok(g) if !stop.aborted() => {
                            if self.made(&id, g) {
                                self.download(&id, stop);
                            }
                        }
                        Ok(_) => {}
                        Err(e) => self.failed(&id, e.outcome),
                    }
                }
            }
            _ => self.failed(&id, Outcome::Unknown),
        }
    }

    fn generate_image(self: &Arc<Self>, id: &str, prepared: Prepared, stop: &Stop) {
        let Some(result) = until_stopped(stop, self.images.generate(prepared)) else {
            return;
        };
        let moved = match result {
            Ok(g) => self.change(id, &[Phase::Generating], |r| {
                r.url = Some(g.url);
                r.usage = serde_json::to_value(g.usage).ok();
                r.phase = Phase::Downloading;
            }),
            Err(e) => {
                self.failed(
                    id,
                    if matches!(e, Failure::Rejected) {
                        Outcome::Rejected
                    } else {
                        Outcome::Unknown
                    },
                );
                return;
            }
        };
        if matches!(moved, Ok(true)) {
            self.download(id, stop);
        }
    }

    /// The vendor refused it, or nothing says what came of it; what was never sent counts as refused.
    pub(super) fn failed(&self, id: &str, outcome: Outcome) {
        let Ok(r) = self.found(id) else { return };
        let words = r.ask.words();
        let (phase, key) = match outcome {
            Outcome::Rejected | Outcome::NotSubmitted => (Phase::Failed, words.rejected),
            Outcome::Unknown => (Phase::Unknown, words.unknown),
        };
        let _ = self.change(id, &[Phase::Generating], |r| {
            r.phase = phase;
            r.problem = t(&format!("server.media.{key}"), &[]);
        });
    }

    /// A vendor task asked for and followed; its id is kept even when the job was stopped meanwhile.
    pub(super) fn follow(self: &Arc<Self>, id: &str, key: &str, path: &str, body: &Value, stop: &Stop) {
        match self.moss.submit(key, path, body) {
            Ok(task) => {
                let _ = self.change(id, &[Phase::Generating, Phase::Canceled, Phase::Unknown], |r| r.remote_task = Some(task));
                self.poll(id, stop);
            }
            Err(e) => self.failed(id, e.outcome),
        }
    }

    /// The vendor made it: where to fetch it, then fetching.
    fn made(&self, id: &str, g: vendor::Generated) -> bool {
        matches!(
            self.change(id, &[Phase::Generating], |r| {
                r.url = Some(g.url);
                r.result_format = MediaAudioFormat::ALL.into_iter().find(|f| f.as_str() == g.format);
                r.content_type = Some(g.content_type);
                r.usage = g.usage;
                r.phase = Phase::Downloading;
                r.problem.clear();
            }),
            Ok(true)
        )
    }

    /// `poll`: the vendor's task asked every 3 s until it answers, at most 600 times.
    fn poll(self: &Arc<Self>, id: &str, stop: &Stop) {
        for _ in 0..POLLS {
            if stop.aborted() {
                return;
            }
            let Ok(r) = self.found(id) else { return };
            let (Some(task), Phase::Generating) = (r.remote_task.clone(), r.phase) else {
                return;
            };
            let Ok(account) = self.account_of(&r) else { break };
            match self.moss.task(&account.key, &task) {
                Ok(Task::Waiting) => {}
                Ok(Task::Failed) => return self.failed(id, Outcome::Rejected),
                Ok(Task::Audio(kind, g)) if r.ask.task() == Some(kind) => {
                    if self.made(id, g) {
                        self.download(id, stop);
                    }
                    return;
                }
                Ok(Task::Transcription { text, segments, usage }) if r.ask.task() == Some(TaskKind::Transcription) => {
                    let _ = self.change(id, &[Phase::Generating], |r| {
                        r.made = Some(MediaAudioResult::Transcription { text, segments });
                        r.usage = usage;
                        r.phase = Phase::Ready;
                        r.problem.clear();
                    });
                    return;
                }
                Ok(_) => return self.failed(id, Outcome::Unknown),
                Err(e) if e.retryable() => {}
                Err(_) => break,
            }
            let until = std::time::Instant::now() + POLL;
            while std::time::Instant::now() < until {
                if stop.aborted() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = self.change(id, &[Phase::Generating], |r| {
            r.phase = Phase::Unknown;
            r.problem = t(&format!("server.media.{}", r.ask.words().paused), &[]);
        });
    }

    /// The result fetched, checked and kept; anything off is a failed download.
    fn download(self: &Arc<Self>, id: &str, stop: &Stop) {
        let Ok(r) = self.found(id) else { return };
        let (Some(url), Phase::Downloading) = (r.url.clone(), r.phase) else {
            return;
        };
        let (kept, failed_key) = match &r.ask {
            Ask::Image(request) => {
                let Some(bytes) = until_stopped(stop, self.images.download(&url, request.width, request.height)) else {
                    return;
                };
                let kept = match bytes {
                    Ok(bytes) if super::png::valid(&bytes, request.width, request.height) => self
                        .files
                        .keep(&bytes, &format!("moss-{id}.png"), "image/png")
                        .map(|a| (Some(a), None, None))
                        .map_err(|e| e.message),
                    _ => Err("not the image asked for".to_string()),
                };
                (kept, "downloadFailed")
            }
            ask => match ask.audio() {
                Some(asked) => (self.fetch_audio(&url, r.result_format.unwrap_or(asked), id, stop), "speechDownloadFailed"),
                None => return,
            },
        };
        if stop.aborted() {
            return;
        }
        let preview = match (&r.ask, &kept) {
            (Ask::VoiceDesign(_), Ok((Some(attachment), _, Some(metadata)))) => self.preview(&r, attachment, metadata),
            _ => None,
        };
        let moved = match kept {
            Ok((attachment, input, metadata)) => self.change(id, &[Phase::Downloading], |r| {
                if metadata.is_some() {
                    r.metadata = metadata;
                }
                r.attachment = attachment;
                r.result_input = input;
                r.preview_input = preview;
                r.url = None;
                r.phase = Phase::Ready;
                r.problem.clear();
            }),
            Err(why) => {
                eprintln!("media {id}: {why}");
                self.change(id, &[Phase::Downloading], |r| {
                    r.phase = Phase::DownloadFailed;
                    r.problem = t(&format!("server.media.{failed_key}"), &[]);
                })
            }
        };
        if let Err(e) = moved {
            eprintln!("media {id}: {}", e.message);
        }
        if let Ok(r) = self.found(id) {
            self.post_back(&r);
        }
    }

    fn fetch_audio(&self, url: &str, format: MediaAudioFormat, id: &str, stop: &Stop) -> Result<Kept, String> {
        let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
        if !crate::public_http::public_https(&parsed) {
            return Err("not a public https address".into());
        }
        let types = vendor::audio_mimes(format.as_str());
        let mut response = self
            .download
            .fetch(Request {
                method: "GET",
                url: url.into(),
                headers: vec![("accept".into(), types.join(", "))],
                body: None,
                timeout: DOWNLOAD_TIME,
            })
            .map_err(|e| format!("{e:?}"))?;
        let kind = response.media_type();
        if response.status != 200 || !types.contains(&kind.as_str()) {
            return Err(format!("{} {kind}", response.status));
        }
        let declared: Option<usize> = response.header("content-length").and_then(|l| l.parse().ok());
        if declared.is_some_and(|n| n == 0 || n > RESULT_MAX) {
            return Err("declared size".into());
        }
        let bytes = vendor::read_max(&mut response.body, RESULT_MAX, Some(stop)).map_err(|e| format!("{e:?}"))?;
        if declared.is_some_and(|n| n != bytes.len()) || bytes.is_empty() {
            return Err("size".into());
        }
        let name = format!("moss-{id}.{}", format.as_str());
        let facts = super::validate::audio_facts(bytes.clone(), &kind).map_err(|e| e.message)?;
        let metadata = MediaAudioMetadata {
            source: MediaAudioMetadataSource::File,
            sample_rate: Some(JsNumber(facts.sample_rate.into())),
            duration: Some(JsNumber(facts.seconds)),
            channels: Some(facts.channels as i64),
            bit_depth: facts.bits.map(i64::from),
        };
        let (attachment, input) = self.keep_bytes(id, bytes, &name, &kind)?;
        Ok((attachment, input, Some(metadata)))
    }

    /// A short designed voice kept as an input of the job too, to clone from or hear again.
    fn preview(&self, r: &Record, attachment: &Attachment, metadata: &MediaAudioMetadata) -> Option<String> {
        let short = metadata.duration.is_some_and(|d| d.0 <= 30.0) && attachment.size <= 10_000_000;
        let cloneable = matches!(r.result_format, Some(MediaAudioFormat::Wav | MediaAudioFormat::Mp3 | MediaAudioFormat::Flac));
        if !short || !cloneable {
            return None;
        }
        let input = self.inputs.adopt(&attachment.id).ok()?;
        self.inputs.pin(std::slice::from_ref(&input.id), r.id(), |_| Ok(())).ok()?;
        Some(input.id)
    }

    /// Bytes kept for a job: an attachment, or past an attachment's size a pinned input released with the job.
    fn keep_bytes(&self, id: &str, bytes: Vec<u8>, name: &str, kind: &str) -> Result<(Option<Attachment>, Option<MediaInputReference>), String> {
        if bytes.len() <= ATTACHMENT_MAX {
            let a = self.files.keep(&bytes, name, kind).map_err(|e| e.message)?;
            return Ok((Some(a), None));
        }
        let input = self
            .inputs
            .create(&MediaInputRequest {
                kind: MediaInputKind::Audio,
                name: serde_json::from_value(Value::String(name.to_string())).map_err(|e| e.to_string())?,
                mime: kind.to_string(),
                size: bytes.len() as i64,
            })
            .map_err(|e| e.message)?;
        let input = self.inputs.upload(&input.id, std::io::Cursor::new(bytes)).map_err(|e| e.message)?;
        self.inputs.pin(std::slice::from_ref(&input.id), id, |_| Ok(())).map_err(|e| e.message)?;
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
    fn emit(&self, id: &str, event: Value, stop: &Stop) -> bool {
        let Some(tx) = self.streams.lock().unwrap_or_else(|e| e.into_inner()).get(id).map(|s| s.tx.clone()) else {
            return false;
        };
        let mut event = Some(event);
        while let Some(e) = event.take() {
            if stop.aborted() {
                return false;
            }
            match tx.send_timeout(e, Duration::from_millis(100)) {
                Ok(()) => return true,
                Err(flume::SendTimeoutError::Timeout(e)) => event = Some(e),
                Err(flume::SendTimeoutError::Disconnected(_)) => return false,
            }
        }
        false
    }

    /// `receiveSpeechStream`: the vendor's PCM relayed to the page as it comes and kept whole (or as much as came) as a WAV.
    fn receive(self: &Arc<Self>, id: &str, account: &Account, body: &Value, stop: &Stop) {
        let mut pcm: Vec<u8> = Vec::new();
        let mut pending: Vec<u8> = Vec::new();
        let mut sequence = 0i64;
        let mut format: Option<(i64, i64)> = None;
        let mut usage: Option<Value> = None;
        let mut duration: Option<f64> = None;
        let mut complete = false;
        let streamed = self.moss.speech_stream(&account.key, body, stop, &mut |event| {
            match event {
                vendor::SpeechEvent::TaskCreated(task) => {
                    let _ = self.change(id, &[Phase::Generating, Phase::Canceled], |r| r.remote_task = Some(task));
                }
                vendor::SpeechEvent::Created {
                    sample_rate,
                    channels,
                    bit_depth,
                } => {
                    if bit_depth != 16 {
                        return Err("bit depth".into());
                    }
                    format = Some((sample_rate, channels));
                    self.emit(
                        id,
                        json!({ "type": "format", "sampleRate": sample_rate, "channels": channels, "bitDepth": 16 }),
                        stop,
                    );
                }
                vendor::SpeechEvent::Delta(audio) => {
                    let Some((_, channels)) = format else {
                        return Err("audio before its format".into());
                    };
                    if pcm.len() + audio.len() > STREAM_MAX {
                        return Err("too long".into());
                    }
                    let block = channels as usize * 2;
                    pcm.extend_from_slice(&audio);
                    pending.extend_from_slice(&audio);
                    let available = pending.len() - pending.len() % block;
                    let step = 32768 / block * block;
                    for part in pending[..available].chunks(step) {
                        let audio = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, part);
                        self.emit(id, json!({ "type": "audio", "sequence": sequence, "audio": audio }), stop);
                        sequence += 1;
                    }
                    pending.drain(..available);
                }
                vendor::SpeechEvent::Done { usage: u, duration: d } => {
                    if pcm.is_empty() || !pending.is_empty() {
                        return Err("an incomplete end".into());
                    }
                    usage = u;
                    duration = d;
                    complete = true;
                }
            }
            Ok(())
        });
        let saved = format.map(|(rate, channels)| self.keep_stream(id, &pcm, rate, channels, complete, duration));
        match (streamed, saved) {
            (_, Some(Ok(()))) if !stop.aborted() || complete => {
                if complete {
                    let _ = self.change(id, &[Phase::Ready], |r| r.usage = usage.take());
                    self.emit(id, json!({ "type": "done" }), stop);
                } else {
                    self.emit(id, json!({ "type": "failed" }), stop);
                }
            }
            (Err(_), _) | (_, Some(Err(_))) | (_, None) => {
                let _ = self.change(id, &[Phase::Generating], |r| {
                    r.phase = Phase::Unknown;
                    r.problem = t("server.media.speechUnknown", &[]);
                });
                self.emit(id, json!({ "type": "failed" }), stop);
            }
            _ => {}
        }
        // A finished stream's events stay a minute for a page that comes late.
        let me = self.clone();
        let job = id.to_string();
        let _ = std::thread::Builder::new().name(format!("speech-end-{id}")).spawn(move || {
            std::thread::sleep(Duration::from_secs(60));
            me.streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&job);
        });
    }

    /// What came of a stream, kept as a WAV: ready when complete, else unknown with what came.
    fn keep_stream(&self, id: &str, pcm: &[u8], rate: i64, channels: i64, complete: bool, duration: Option<f64>) -> Result<(), String> {
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
        let (attachment, input) = self.keep_bytes(id, wav, &name, "audio/wav")?;
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
            .change(id, &[Phase::Generating], |r| {
                patch(r);
                if complete {
                    r.phase = Phase::Ready;
                    r.problem.clear();
                } else {
                    r.phase = Phase::Unknown;
                    r.problem = t("server.media.speechPartial", &[]);
                }
            })
            .map_err(|e| e.message)?;
        if !moved {
            self.change(id, &[Phase::Canceled], patch).map_err(|e| e.message)?;
        }
        Ok(())
    }

    /// A ready image the orchestrator asked for, posted once to its channel.
    fn post_back(&self, r: &Record) {
        let (Ask::Image(request), Phase::Ready, MediaSource::Orchestrator { agent, channel }, Some(attachment)) = (&r.ask, r.phase, &r.source, &r.attachment)
        else {
            return;
        };
        if let Err(e) = self.chat.post(Posting {
            from: agent.clone(),
            channel: channel.clone(),
            text: t(
                "server.media.imageMade",
                &[("prompt", request.prompt.chars().take(80).collect::<String>().into())],
            ),
            send_key: format!("media:{}", r.id()),
            made: Some(Made::Attachments(vec![attachment.id.clone()])),
            ..Posting::default()
        }) {
            eprintln!("media image post: {}", e.message);
        }
    }

    /// Jobs a restart left: a known vendor task is asked again (never a stream), a download fetched again, the rest
    /// given up. What never started lets go of its inputs; an upload cut short may or may not be at the vendor.
    fn pick_up(&self) -> Result<(), ApiError> {
        for r in self.rows(&format!("select data from media_job where phase in {ACTIVE}"))? {
            let id = r.id();
            self.note(id, |r| {
                for file in r.remote.iter_mut().filter(|f| f.state == RemoteState::Uploading) {
                    file.state = RemoteState::Unknown;
                }
            })?;
            match (r.phase, &r.remote_task) {
                (Phase::Downloading, _) => {}
                (Phase::Generating, Some(_)) if !r.ask.streamed() => {}
                (phase, _) => {
                    let unsent = matches!(phase, Phase::Queued | Phase::Authorized);
                    self.change(id, &[phase], |r| {
                        r.phase = if unsent { Phase::Canceled } else { Phase::Unknown };
                        r.problem = t("server.media.restarted", &[]);
                        if unsent && r.cleanup.is_some() {
                            r.cleanup = Some(MediaCleanup::Done);
                        }
                    })?;
                    if unsent {
                        self.inputs.release(id)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<MediaJob>, ApiError> {
        Ok(self.recent()?.iter().map(Record::view).collect())
    }

    pub fn get(&self, id: &str) -> Result<MediaJob, ApiError> {
        Ok(self.found(id)?.view())
    }

    fn stop_run(&self, id: &str) {
        if let Some(run) = self.runs().remove(id) {
            run.stop.abort();
        }
    }

    pub fn cancel(&self, id: &str) -> Result<MediaJob, ApiError> {
        let r = self.found(id)?;
        if active(r.phase) {
            // Understanding that sent nothing has nothing to clean and no use for its inputs.
            let unsent = matches!(r.ask, Ask::Understanding(_)) && matches!(r.phase, Phase::Authorized | Phase::Queued);
            let moved = self.change(id, &[r.phase], |r| {
                r.phase = Phase::Canceled;
                r.problem = t("server.media.canceled", &[]);
                if unsent {
                    r.cleanup = Some(MediaCleanup::Done);
                }
            })?;
            if moved && unsent {
                self.inputs.release(id)?;
            }
            self.held.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
            self.stop_run(id);
            self.schedule();
            self.settle(id);
        }
        self.get(id)
    }

    pub fn retry_download(&self, id: &str) -> Result<MediaJob, ApiError> {
        self.open_for_work()?;
        let r = self.found(id)?;
        if matches!(r.phase, Phase::Ready | Phase::Downloading) {
            return Ok(r.view());
        }
        if !r.can_retry_download() {
            return Err(refused("noDownload"));
        }
        let busy: i64 = self
            .db()
            .query_row(&format!("select count(*) from media_job where phase in {ACTIVE}"), [], |x| x.get(0))
            .map_err(storage)?;
        if busy >= ADMITTED {
            return Err(refused("busy"));
        }
        self.change(id, &[r.phase], |r| {
            r.phase = Phase::Downloading;
            r.problem.clear();
        })?;
        self.schedule();
        self.get(id)
    }

    /// `resume`: only the known vendor task is asked again, never a new one.
    pub(super) fn resumed(&self, r: Record) -> Result<Record, ApiError> {
        if r.phase == Phase::Ready || active(r.phase) {
            return Ok(r);
        }
        if !r.can_resume() {
            return Err(refused(r.ask.words().no_resume));
        }
        self.account_of(&r)?;
        self.change(r.id(), &[r.phase], |r| {
            r.phase = Phase::Generating;
            r.problem.clear();
        })?;
        self.schedule();
        self.found(r.id())
    }

    pub fn resume(&self, id: &str) -> Result<MediaSpeechJob, ApiError> {
        let r = self.found(id)?;
        if !matches!(r.ask, Ask::Speech(_)) {
            return Err(refused("missing"));
        }
        Ok(speech_view(&self.resumed(r)?))
    }

    pub fn preview_release(&self, id: &str) -> Result<Preview, ApiError> {
        let r = self.found(id)?;
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
    pub fn release(&self, id: &str) -> Result<MediaJob, ApiError> {
        let r = self.found(id)?;
        if active(r.phase) || !r.releasable() {
            return Err(refused("releaseUnavailable"));
        }
        if !r.released {
            self.inputs.release(id)?;
            // The inputs the job made for itself go; the one the user gave stays theirs.
            for input in r.result_input.iter().map(|i| &i.id).chain(&r.preview_input) {
                let _ = self.inputs.delete(input);
            }
            self.change(id, &[r.phase], |r| {
                r.released = true;
                r.attachment = None;
                r.result_input = None;
                r.preview_input = None;
                r.url = None;
            })?;
        }
        self.get(id)
    }

    /// Stops every run; what was running is picked up at the next start.
    pub fn close(&self) {
        self.sweeping.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.closed.store(true, Ordering::SeqCst);
        for run in self.runs().values() {
            run.stop.abort();
        }
        self.runs().clear();
    }
}

/// A settings account with its key out and fingerprinted, as the vendor calls take it.
fn keyed(a: crate::modules::provider::Account) -> Account {
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

/// Async vendor work run on this thread, given up when `stop` is set.
fn until_stopped<T>(stop: &Stop, work: Work<'_, T>) -> Option<Result<T, Failure>> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
    let result = runtime.block_on(async {
        tokio::select! {
            r = work => Some(r),
            _ = async { while !stop.aborted() { tokio::time::sleep(Duration::from_millis(20)).await } } => None,
        }
    });
    if stop.aborted() { None } else { result }
}

pub fn install(hub: &Hub, jobs: Arc<Jobs>) {
    let user_only = |caller: Caller| if caller == Caller::User { Ok(()) } else { Err(refused("userRequired")) };
    let j = jobs.clone();
    hub.on::<ops::MediaImageCreate>(move |ctx, r| {
        user_only(ctx.caller)?;
        j.image(r, MediaSource::User {})
    });
    let j = jobs.clone();
    hub.on::<ops::MediaSpeechCreate>(move |ctx, r| {
        user_only(ctx.caller)?;
        j.speech(r, MediaSource::User {})
    });
    let j = jobs.clone();
    hub.on::<ops::MediaSpeechResume>(move |_, r| j.resume(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaDialogueCreate>(move |ctx, r| {
        user_only(ctx.caller)?;
        j.speakers(r, MediaSource::User {})
    });
    let j = jobs.clone();
    hub.on::<ops::MediaVoiceDesignCreate>(move |ctx, r| {
        user_only(ctx.caller)?;
        j.voice_design(r, MediaSource::User {})
    });
    let j = jobs.clone();
    hub.on::<ops::MediaCloneCreate>(move |_, r| j.clone_voice(r));
    let j = jobs.clone();
    hub.on::<ops::MediaTranscriptionCreate>(move |_, r| j.transcription(r));
    let j = jobs.clone();
    hub.on::<ops::MediaAudioResume>(move |_, r| j.audio_resume(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaAudioPreviewCleanup>(move |_, r| j.preview_audio_cleanup(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaAudioCleanup>(move |_, r| j.audio_cleanup(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaUnderstandingCreate>(move |_, r| j.understanding(r));
    let j = jobs.clone();
    hub.on::<ops::MediaUnderstandingAuthorize>(move |_, r| j.authorize_understanding(r));
    let j = jobs.clone();
    hub.on::<ops::MediaUnderstandingStart>(move |ctx, r| {
        if ctx.caller != Caller::Orchestrator {
            return Err(refused("authorizationRequired"));
        }
        j.start_understanding_by_id(&r.id)
    });
    let j = jobs.clone();
    hub.on::<ops::MediaUnderstandingPreviewCleanup>(move |_, r| j.preview_understanding_cleanup(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaUnderstandingCleanup>(move |_, r| j.understanding_cleanup(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaJobList>(move |_, _| j.list());
    let j = jobs.clone();
    hub.on::<ops::MediaJobGet>(move |_, r| j.get(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaJobCancel>(move |_, r| j.cancel(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaJobDownload>(move |_, r| j.retry_download(&r.id));
    let j = jobs.clone();
    hub.on::<ops::MediaJobPreviewRelease>(move |_, r| j.preview_release(&r.id));
    hub.on::<ops::MediaJobRelease>(move |_, r| jobs.release(&r.id));
}

impl vibevalley_server_api::media::SpeechStreams for Jobs {
    fn claim(&self, id: &str) -> Result<vibevalley_server_api::media::SpeechClaim, ApiError> {
        let events = {
            let mut streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
            let Some(s) = streams.get_mut(id).filter(|s| !s.claimed) else {
                return Err(refused("speechStreamUnavailable"));
            };
            s.claimed = true;
            s.rx.clone()
        };
        let me = self.me.get().cloned().unwrap_or_default();
        let job = id.to_string();
        Ok(vibevalley_server_api::media::SpeechClaim {
            events,
            // The page gone: its job is canceled and its work stopped (a finished one is left as it is).
            gone: Box::new(move || {
                let Some(me) = me.upgrade() else { return };
                me.streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&job);
                let _ = me.change(&job, &[Phase::Queued, Phase::Generating], |r| {
                    r.phase = Phase::Canceled;
                    r.problem = t("server.media.canceled", &[]);
                });
                me.stop_run(&job);
            }),
        })
    }
}
