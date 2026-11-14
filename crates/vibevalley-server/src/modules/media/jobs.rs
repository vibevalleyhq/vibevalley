//! Media jobs, every kind on one machine. The machine keeps the jobs (one
//! `media_job` row each), admits at most eight active at once, runs each
//! kind's waiting jobs oldest first while the kind has a free slot (images
//! one at a time), and does cancel, download again, release and picking up
//! after a restart once for all kinds. A kind says only how its job is made
//! (`generate`), fetched (`download`) and shown (`Record::view`).
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
    ApiError, Attachment, BizCode, Caller, Fact, MediaAudioFormat, MediaImageJob, MediaImageJobKind, MediaImageRequest, MediaInputKind, MediaInputReference,
    MediaInputRequest, MediaJob, MediaPhase, MediaSource, MediaSpeechJob, MediaSpeechJobKind, MediaSpeechRequest, Preview, ops,
};

use super::Stop;
use super::image_provider::{Failure, ImageBackend, Prepared, Work};
use super::vendor::{self, Account, Fetch, Moss, Outcome, Request, Task};
use crate::Hub;
use crate::modules::attachment::{ATTACHMENT_MAX, Attachments, open_db};
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

fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}

fn storage(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("media job storage: {e}"))
}

fn active(p: MediaPhase) -> bool {
    matches!(p, MediaPhase::Queued | MediaPhase::Generating | MediaPhase::Downloading)
}

/// What a job was asked to make.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "request", rename_all = "camelCase")]
enum Ask {
    Image(MediaImageRequest),
    Speech(MediaSpeechRequest),
}

impl Ask {
    fn id(&self) -> &str {
        match self {
            Ask::Image(r) => &r.id,
            Ask::Speech(r) => &r.id,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Ask::Image(_) => "image",
            Ask::Speech(_) => "speech",
        }
    }

    /// How many of this kind run at once.
    fn slots(&self) -> usize {
        match self {
            Ask::Image(_) => 1,
            Ask::Speech(_) => 8,
        }
    }
}

/// What a waiting job runs with, in memory only.
enum Held {
    Image(Prepared),
    Speech { account: Account, body: Value },
}

/// A job as it is kept.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    ask: Ask,
    source: MediaSource,
    model: String,
    connection: String,
    revision: i64,
    #[serde(default)]
    fingerprint: String,
    phase: MediaPhase,
    #[serde(default)]
    problem: String,
    remote_task: Option<String>,
    /// Where the result waits at the vendor.
    url: Option<String>,
    usage: Option<Value>,
    metadata: Option<Value>,
    result_format: Option<MediaAudioFormat>,
    content_type: Option<String>,
    attachment: Option<Attachment>,
    result_input: Option<MediaInputReference>,
    #[serde(default)]
    released: bool,
    created_at: i64,
    updated_at: i64,
}

impl Record {
    fn new(ask: Ask, source: MediaSource, connection: String, revision: i64, model: String, fingerprint: String) -> Record {
        let at = now();
        Record {
            ask,
            source,
            model,
            connection,
            revision,
            fingerprint,
            phase: MediaPhase::Queued,
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
            created_at: at,
            updated_at: at,
        }
    }

    fn id(&self) -> &str {
        self.ask.id()
    }

    fn can_retry_download(&self) -> bool {
        !self.released && self.url.is_some() && matches!(self.phase, MediaPhase::DownloadFailed | MediaPhase::Canceled)
    }

    fn can_resume(&self) -> bool {
        let Ask::Speech(r) = &self.ask else { return false };
        !self.released
            && r.streaming != Some(true)
            && self.remote_task.is_some()
            && matches!(self.phase, MediaPhase::Unknown | MediaPhase::Canceled)
            && self.url.is_none()
    }

    fn can_release(&self) -> bool {
        matches!(self.ask, Ask::Speech(_)) && !active(self.phase) && !self.released
    }

    fn view(&self) -> MediaJob {
        let phase_text = t(&format!("server.media.phase.{}", self.phase.as_str()), &[]);
        match &self.ask {
            Ask::Image(r) => MediaJob::MediaImageJob(MediaImageJob {
                kind: MediaImageJobKind::Image,
                id: r.id.clone(),
                prompt: r.prompt.clone(),
                model: self.model.clone(),
                connection: self.connection.clone(),
                revision: self.revision,
                source: self.source.clone(),
                usage: self.usage.clone().and_then(|u| serde_json::from_value(u).ok()),
                phase: self.phase,
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
                metadata: self.metadata.clone().and_then(|m| serde_json::from_value(m).ok()),
                usage: self.usage.clone().and_then(|u| serde_json::from_value(u).ok()),
                can_resume: Some(self.can_resume()),
                can_release: self.can_release(),
                phase: self.phase,
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
type Kept = (Option<Attachment>, Option<MediaInputReference>, Option<Value>);

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
    images: Arc<dyn ImageBackend>,
    moss: Moss,
    download: Download,
    setting: Arc<Setting>,
    files: Arc<Attachments>,
    inputs: Arc<Inputs>,
    chat: Arc<Chat>,
    hub: Weak<Hub>,
    closed: AtomicBool,
    me: OnceLock<Weak<Jobs>>,
    streams: Mutex<HashMap<String, Stream>>,
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
        });
        let _ = jobs.me.set(Arc::downgrade(&jobs));
        jobs.pick_up()?;
        for r in jobs.recent()? {
            jobs.post_back(&r);
        }
        jobs.publish();
        jobs.schedule();
        Ok(jobs)
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

    fn found(&self, id: &str) -> Result<Record, ApiError> {
        Self::read(&self.db(), id)?.ok_or_else(|| refused("missing"))
    }

    fn rows(&self, sql: &str) -> Result<Vec<Record>, ApiError> {
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
    fn change(&self, id: &str, before: &[MediaPhase], patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
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

    fn open_for_work(&self) -> Result<(), ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        Ok(())
    }

    /// A new job admitted under its id once: the same ask again is the job it made.
    fn admit(&self, mut r: Record, held: Held) -> Result<Record, ApiError> {
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
        self.held.lock().unwrap_or_else(|e| e.into_inner()).insert(r.id().to_string(), held);
        self.publish();
        self.schedule();
        Ok(r)
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
        self.admit(r, Held::Image(prepared)).map(|r| image_view(&r))
    }

    /// The speech account as the settings bind it now.
    fn account(&self) -> Result<Account, ApiError> {
        let a = self
            .setting
            .providers()
            .account(Use::Speech)
            .ok_or_else(|| ApiError::new(BizCode::ProviderRefused, t("server.provider.speechUnbound", &[])))?;
        Ok(Account {
            fingerprint: vendor::fingerprint(a.key.expose()),
            key: a.key.expose().to_string(),
            connection: a.connection,
            revision: a.revision,
            model: a.model,
        })
    }

    /// The account a job was asked with, refused when its key changed since.
    fn account_of(&self, r: &Record) -> Result<Account, ApiError> {
        let a = self.account()?;
        if a.connection != r.connection || a.fingerprint != r.fingerprint {
            return Err(refused("remoteAccountChanged"));
        }
        Ok(a)
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
        let account = self.account()?;
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
        self.admit(r, Held::Speech { account, body }).map(|r| speech_view(&r))
    }

    /// Starts what can run now: each kind's oldest waiting job while the kind has a free slot.
    fn schedule(&self) {
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
                MediaPhase::Queued | MediaPhase::Downloading => true,
                MediaPhase::Generating => r.remote_task.is_some(),
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
            MediaPhase::Queued => self.generate(r, stop),
            MediaPhase::Downloading => self.download(id, stop),
            MediaPhase::Generating if r.remote_task.is_some() => self.poll(id, stop),
            _ => {}
        }
    }

    fn generate(self: &Arc<Self>, r: Record, stop: &Stop) {
        let id = r.id().to_string();
        let held = self.held.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        if !matches!(self.change(&id, &[MediaPhase::Queued], |r| r.phase = MediaPhase::Generating), Ok(true)) {
            return;
        }
        match (held, &r.ask) {
            (Some(Held::Image(prepared)), Ask::Image(_)) => self.generate_image(&id, prepared, stop),
            (Some(Held::Speech { account, body }), Ask::Speech(request)) => {
                if request.streaming == Some(true) {
                    self.receive(&id, &account, &body, stop);
                } else if request.asynchronous == Some(true) {
                    match self.moss.speech_task(&account.key, &body) {
                        Ok(task) => {
                            let _ = self.change(&id, &[MediaPhase::Generating, MediaPhase::Canceled, MediaPhase::Unknown], |r| {
                                r.remote_task = Some(task)
                            });
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
            Ok(g) => self.change(id, &[MediaPhase::Generating], |r| {
                r.url = Some(g.url);
                r.usage = serde_json::to_value(g.usage).ok();
                r.phase = MediaPhase::Downloading;
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

    fn failed(&self, id: &str, outcome: Outcome) {
        let Ok(r) = self.found(id) else { return };
        let speech = matches!(r.ask, Ask::Speech(_));
        let (phase, key) = match (outcome == Outcome::Rejected, speech) {
            (true, true) => (MediaPhase::Failed, "speechRejected"),
            (false, true) => (MediaPhase::Unknown, "speechUnknown"),
            (true, false) => (MediaPhase::Failed, "rejected"),
            (false, false) => (MediaPhase::Unknown, "unknown"),
        };
        let _ = self.change(id, &[MediaPhase::Generating], |r| {
            r.phase = phase;
            r.problem = t(&format!("server.media.{key}"), &[]);
        });
    }

    /// The vendor made it: where to fetch it, then fetching.
    fn made(&self, id: &str, g: vendor::Generated) -> bool {
        matches!(
            self.change(id, &[MediaPhase::Generating], |r| {
                r.url = Some(g.url);
                r.result_format = serde_json::from_value(Value::String(g.format)).ok();
                r.content_type = Some(g.content_type);
                r.usage = g.usage;
                r.phase = MediaPhase::Downloading;
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
            let (Some(task), MediaPhase::Generating) = (r.remote_task.clone(), r.phase) else {
                return;
            };
            let Ok(account) = self.account_of(&r) else { break };
            match self.moss.task(&account.key, &task) {
                Ok(Task::Waiting(_)) => {}
                Ok(Task::Failed(_)) => return self.failed(id, Outcome::Rejected),
                Ok(Task::Audio("speech", g)) => {
                    if self.made(id, g) {
                        self.download(id, stop);
                    }
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
        let _ = self.change(id, &[MediaPhase::Generating], |r| {
            r.phase = MediaPhase::Unknown;
            r.problem = t("server.media.speechPollPaused", &[]);
        });
    }

    /// The result fetched, checked and kept; anything off is a failed download.
    fn download(self: &Arc<Self>, id: &str, stop: &Stop) {
        let Ok(r) = self.found(id) else { return };
        let (Some(url), MediaPhase::Downloading) = (r.url.clone(), r.phase) else {
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
            Ask::Speech(request) => (
                self.fetch_audio(&url, r.result_format.unwrap_or(request.format), id, stop),
                "speechDownloadFailed",
            ),
        };
        if stop.aborted() {
            return;
        }
        let moved = match kept {
            Ok((attachment, input, metadata)) => self.change(id, &[MediaPhase::Downloading], |r| {
                if metadata.is_some() {
                    r.metadata = metadata;
                }
                r.attachment = attachment;
                r.result_input = input;
                r.url = None;
                r.phase = MediaPhase::Ready;
                r.problem.clear();
            }),
            Err(why) => {
                eprintln!("media {id}: {why}");
                self.change(id, &[MediaPhase::Downloading], |r| {
                    r.phase = MediaPhase::DownloadFailed;
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
        let metadata = json!({
            "source": "file",
            "sampleRate": facts.sample_rate,
            "duration": facts.seconds,
            "channels": facts.channels,
            "bitDepth": facts.bits,
        });
        let (attachment, input) = self.keep_bytes(id, bytes, &name, &kind)?;
        Ok((attachment, input, Some(metadata)))
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
                    let _ = self.change(id, &[MediaPhase::Generating, MediaPhase::Canceled], |r| r.remote_task = Some(task));
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
                    let _ = self.change(id, &[MediaPhase::Ready], |r| r.usage = usage.take());
                    self.emit(id, json!({ "type": "done" }), stop);
                } else {
                    self.emit(id, json!({ "type": "failed" }), stop);
                }
            }
            (Err(_), _) | (_, Some(Err(_))) | (_, None) => {
                let _ = self.change(id, &[MediaPhase::Generating], |r| {
                    r.phase = MediaPhase::Unknown;
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
        let metadata = json!({
            "source": if complete && duration.is_some() { "provider" } else { "file" },
            "sampleRate": rate, "channels": channels, "bitDepth": 16, "duration": seconds,
        });
        let patch = |r: &mut Record| {
            r.attachment = attachment.clone();
            r.result_input = input.clone();
            r.result_format = Some(MediaAudioFormat::Wav);
            r.content_type = Some("audio/wav".into());
            r.metadata = Some(metadata.clone());
        };
        let moved = self
            .change(id, &[MediaPhase::Generating], |r| {
                patch(r);
                if complete {
                    r.phase = MediaPhase::Ready;
                    r.problem.clear();
                } else {
                    r.phase = MediaPhase::Unknown;
                    r.problem = t("server.media.speechPartial", &[]);
                }
            })
            .map_err(|e| e.message)?;
        if !moved {
            self.change(id, &[MediaPhase::Canceled], patch).map_err(|e| e.message)?;
        }
        Ok(())
    }

    /// A ready image the orchestrator asked for, posted once to its channel.
    fn post_back(&self, r: &Record) {
        let (Ask::Image(request), MediaPhase::Ready, MediaSource::Orchestrator { agent, channel }, Some(attachment)) =
            (&r.ask, r.phase, &r.source, &r.attachment)
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

    /// Jobs a restart left: a known vendor task is asked again, a download fetched again, the rest given up.
    fn pick_up(&self) -> Result<(), ApiError> {
        for r in self.rows(&format!("select data from media_job where phase in {ACTIVE}"))? {
            match (r.phase, &r.remote_task) {
                (MediaPhase::Downloading, _) | (MediaPhase::Generating, Some(_)) => {}
                (phase, _) => {
                    self.change(r.id(), &[phase], |r| {
                        r.phase = if phase == MediaPhase::Queued {
                            MediaPhase::Canceled
                        } else {
                            MediaPhase::Unknown
                        };
                        r.problem = t("server.media.restarted", &[]);
                    })?;
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
            self.change(id, &[r.phase], |r| {
                r.phase = MediaPhase::Canceled;
                r.problem = t("server.media.canceled", &[]);
            })?;
            self.held.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
            self.stop_run(id);
            self.schedule();
        }
        self.get(id)
    }

    pub fn retry_download(&self, id: &str) -> Result<MediaJob, ApiError> {
        self.open_for_work()?;
        let r = self.found(id)?;
        if matches!(r.phase, MediaPhase::Ready | MediaPhase::Downloading) {
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
            r.phase = MediaPhase::Downloading;
            r.problem.clear();
        })?;
        self.schedule();
        self.get(id)
    }

    /// `resume`: only the known vendor task is asked again, never a new one.
    pub fn resume(&self, id: &str) -> Result<MediaSpeechJob, ApiError> {
        let r = self.found(id)?;
        if r.phase == MediaPhase::Ready || active(r.phase) {
            return Ok(speech_view(&r));
        }
        if !r.can_resume() {
            return Err(refused("speechNoResume"));
        }
        self.account_of(&r)?;
        self.change(id, &[r.phase], |r| {
            r.phase = MediaPhase::Generating;
            r.problem.clear();
        })?;
        self.schedule();
        Ok(speech_view(&self.found(id)?))
    }

    pub fn preview_release(&self, id: &str) -> Result<Preview, ApiError> {
        let r = self.found(id)?;
        if active(r.phase) || matches!(r.ask, Ask::Image(_)) {
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
        if active(r.phase) || matches!(r.ask, Ask::Image(_)) {
            return Err(refused("releaseUnavailable"));
        }
        if !r.released {
            self.inputs.release(id)?;
            if let Some(input) = &r.result_input {
                let _ = self.inputs.delete(&input.id);
            }
            self.change(id, &[r.phase], |r| {
                r.released = true;
                r.attachment = None;
                r.result_input = None;
                r.url = None;
            })?;
        }
        self.get(id)
    }

    /// Stops every run; what was running is picked up at the next start.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for run in self.runs().values() {
            run.stop.abort();
        }
        self.runs().clear();
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
                let _ = me.change(&job, &[MediaPhase::Queued, MediaPhase::Generating], |r| {
                    r.phase = MediaPhase::Canceled;
                    r.problem = t("server.media.canceled", &[]);
                });
                me.stop_run(&job);
            }),
        })
    }
}
