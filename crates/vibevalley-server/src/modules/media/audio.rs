//! Speech jobs (`modules/media/speech.ts`, `audioResult.ts`): asked at once
//! or as a vendor task followed until done, then the result downloaded and
//! kept: an attachment when it is small enough, else a pinned input. Each
//! job's work runs on a thread of its own; vendor calls block.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Attachment, BizCode, MediaAudioFormat, MediaInputKind, MediaInputReference, MediaInputRequest, MediaJob, MediaPhase, MediaSource, MediaSpeechJob,
    MediaSpeechJobKind, MediaSpeechRequest, Preview,
};

use super::Stop;
use super::machine::{Machine, OtherJobs};
use super::vendor::{self, Account, Fetch, Moss, Outcome, Request, Task};
use crate::modules::attachment::{ATTACHMENT_MAX, Attachments, open_db};
use crate::modules::media::inputs::Inputs;
use crate::modules::setting::Setting;
use crate::now;

/// The largest audio result kept (`audioResultMax`).
const RESULT_MAX: usize = 512_000_000;
const POLL: Duration = Duration::from_secs(3);
const POLLS: usize = 600;
const DOWNLOAD_TIME: Duration = Duration::from_secs(300);

fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}

fn storage(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("speech job storage: {e}"))
}

fn active(p: MediaPhase) -> bool {
    matches!(p, MediaPhase::Queued | MediaPhase::Generating | MediaPhase::Downloading)
}

/// A speech job as it is kept (a `media_job` row's data, kind `speech`).
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    request: MediaSpeechRequest,
    source: MediaSource,
    model: String,
    connection: String,
    revision: i64,
    fingerprint: String,
    phase: MediaPhase,
    problem: String,
    remote_task: Option<String>,
    url: Option<String>,
    result_format: Option<MediaAudioFormat>,
    content_type: Option<String>,
    usage: Option<Value>,
    metadata: Option<Value>,
    attachment: Option<Attachment>,
    result_input: Option<MediaInputReference>,
    released: bool,
    created_at: i64,
    updated_at: i64,
}

impl Record {
    fn view(&self) -> MediaSpeechJob {
        let r = &self.request;
        MediaSpeechJob {
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
            can_resume: Some(
                !self.released
                    && r.streaming != Some(true)
                    && self.remote_task.is_some()
                    && matches!(self.phase, MediaPhase::Unknown | MediaPhase::Canceled)
                    && self.url.is_none(),
            ),
            can_release: !active(self.phase) && !self.released,
            phase: self.phase,
            phase_text: t(&format!("server.media.phase.{}", self.phase.as_str()), &[]),
            problem: self.problem.clone(),
            attachment: self.attachment.clone(),
            result_input: self.result_input.clone(),
            can_cancel: active(self.phase),
            can_retry_download: !self.released && self.url.is_some() && matches!(self.phase, MediaPhase::DownloadFailed | MediaPhase::Canceled),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// A result kept: as an attachment or a pinned input, and what the file said of itself.
type Kept = (Option<Attachment>, Option<MediaInputReference>, Option<Value>);

/// Where generated audio is fetched from: the vendor's public address, never
/// with credentials.
pub type Download = Arc<dyn Fetch>;

pub struct Audio {
    db: Mutex<Connection>,
    moss: Moss,
    download: Download,
    setting: Arc<Setting>,
    files: Arc<Attachments>,
    inputs: Arc<Inputs>,
    machine: Weak<Machine>,
    runs: Mutex<HashMap<String, Stop>>,
    closed: AtomicBool,
    /// Itself, for the work a hub call starts.
    me: std::sync::OnceLock<Weak<Audio>>,
}

impl Audio {
    pub fn open(
        home: &Path,
        setting: Arc<Setting>,
        files: Arc<Attachments>,
        inputs: Arc<Inputs>,
        machine: &Arc<Machine>,
        fetch: Arc<dyn Fetch>,
        download: Download,
    ) -> Result<Arc<Audio>, ApiError> {
        let db = open_db(home).map_err(storage)?;
        let audio = Arc::new(Audio {
            db: Mutex::new(db),
            moss: Moss { fetch },
            download,
            setting,
            files,
            inputs,
            machine: Arc::downgrade(machine),
            runs: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            me: std::sync::OnceLock::new(),
        });
        let _ = audio.me.set(Arc::downgrade(&audio));
        machine.attach_others(audio.clone());
        audio.pick_up()?;
        Ok(audio)
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read(db: &Connection, id: &str) -> Result<Option<Record>, ApiError> {
        let data: Option<String> = db
            .query_row("select data from media_job where id=?1 and kind='speech'", [id], |r| r.get(0))
            .optional()
            .map_err(storage)?;
        data.map(|s| serde_json::from_str(&s).map_err(|_| refused("corrupt"))).transpose()
    }

    fn found(&self, id: &str) -> Result<Record, ApiError> {
        Self::read(&self.db(), id)?.ok_or_else(|| refused("missing"))
    }

    fn save(&self, db: &Connection, r: &mut Record) -> Result<(), ApiError> {
        r.updated_at = now();
        db.execute(
            "insert into media_job(id,kind,phase,data,created_at,updated_at) values (?1,'speech',?2,?3,?4,?5)
             on conflict(id) do update set phase=excluded.phase,data=excluded.data,updated_at=excluded.updated_at",
            params![
                r.request.id,
                r.phase.as_str(),
                serde_json::to_string(r).map_err(storage)?,
                r.created_at,
                r.updated_at
            ],
        )
        .map_err(storage)?;
        Ok(())
    }

    fn publish(&self) {
        if let Some(m) = self.machine.upgrade()
            && let Err(e) = m.publish_all()
        {
            eprintln!("media: {}", e.message);
        }
    }

    /// `change`: the job moves only from one of `before`; false when it had moved on.
    fn change(&self, id: &str, before: &[MediaPhase], patch: impl FnOnce(&mut Record)) -> Result<bool, ApiError> {
        let changed = {
            let db = self.db();
            let Some(mut r) = Self::read(&db, id)? else { return Ok(false) };
            if !before.contains(&r.phase) {
                return Ok(false);
            }
            patch(&mut r);
            self.save(&db, &mut r)?;
            true
        };
        self.publish();
        Ok(changed)
    }

    /// The speech account as the settings bind it now.
    fn account(&self) -> Result<Account, ApiError> {
        let p = self.setting.providers();
        let binding = &p["speech"];
        let id = binding["connection"].as_str().unwrap_or("");
        let model = binding["model"].as_str().unwrap_or("");
        let c = p["connections"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|c| c["id"] == id && c["enabled"] == true && !c["key"].as_str().unwrap_or("").is_empty())
            })
            .ok_or_else(|| ApiError::new(BizCode::ProviderRefused, t("server.provider.speechUnbound", &[])))?;
        let key = c["key"].as_str().unwrap_or("").to_string();
        Ok(Account {
            connection: id.into(),
            revision: p["revision"].as_i64().unwrap_or(0),
            model: model.into(),
            fingerprint: vendor::fingerprint(&key),
            key,
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

    /// `create`: admitted under one id once; the same request again is the job it made.
    pub fn create(self: &Arc<Self>, request: MediaSpeechRequest, source: MediaSource) -> Result<MediaSpeechJob, ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        if request.streaming == Some(true) {
            return Err(refused("speechInvalid"));
        }
        let db = self.db();
        if let Some(r) = Self::read(&db, &request.id)? {
            if r.request != request || r.source != source {
                return Err(refused("reusedId"));
            }
            return Ok(r.view());
        }
        let busy: i64 = db
            .query_row(
                "select count(*) from media_job where phase in ('queued','generating','downloading','authorized','uploading')",
                [],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if busy >= 8 {
            return Err(refused("busy"));
        }
        let account = self.account()?;
        if request.connection != account.connection || request.revision != account.revision {
            return Err(refused("speechChanged"));
        }
        let body = Moss::prepare_speech(&account.model, &request.text, &request.voice, request.format.as_str()).map_err(|_| refused("speechInvalid"))?;
        let at = now();
        let mut r = Record {
            request: request.clone(),
            source,
            model: account.model.clone(),
            connection: account.connection.clone(),
            revision: account.revision,
            fingerprint: account.fingerprint.clone(),
            phase: MediaPhase::Queued,
            problem: String::new(),
            remote_task: None,
            url: None,
            result_format: None,
            content_type: None,
            usage: None,
            metadata: None,
            attachment: None,
            result_input: None,
            released: false,
            created_at: at,
            updated_at: at,
        };
        self.save(&db, &mut r)?;
        drop(db);
        self.publish();
        let me = self.clone();
        let job = request.id.clone();
        self.run(&request.id, move |stop| me.generate(&job, account, body, &stop));
        Ok(r.view())
    }

    /// One job's work on a thread of its own; a newer run of the job stops the one before it.
    fn run(self: &Arc<Self>, id: &str, work: impl FnOnce(Stop) + Send + 'static) {
        let stop = Stop::default();
        if let Some(old) = self.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), stop.clone()) {
            old.abort();
        }
        let me = self.clone();
        let id = id.to_string();
        let mine = stop.clone();
        let spawned = std::thread::Builder::new().name(format!("speech-{id}")).spawn(move || {
            work(mine.clone());
            let mut runs = me.runs.lock().unwrap_or_else(|e| e.into_inner());
            if runs.get(&id).is_some_and(|s| Arc::ptr_eq(&s.0, &mine.0)) {
                runs.remove(&id);
            }
        });
        if let Err(e) = spawned {
            eprintln!("speech: {e}");
        }
    }

    fn generate(self: &Arc<Self>, id: &str, account: Account, body: Value, stop: &Stop) {
        if !matches!(self.change(id, &[MediaPhase::Queued], |r| r.phase = MediaPhase::Generating), Ok(true)) {
            return;
        }
        let asynchronous = self.found(id).map(|r| r.request.asynchronous == Some(true)).unwrap_or(false);
        if asynchronous {
            match self.moss.speech_task(&account.key, &body) {
                Ok(task) => {
                    let _ = self.change(id, &[MediaPhase::Generating, MediaPhase::Canceled, MediaPhase::Unknown], |r| {
                        r.remote_task = Some(task)
                    });
                    self.poll(id, stop);
                }
                Err(e) => self.failed(id, e.outcome),
            }
            return;
        }
        match self.moss.speech_generate(&account.key, &body) {
            Ok(g) if !stop.aborted() => {
                if self.made(id, g) {
                    self.download_result(id, stop);
                }
            }
            Ok(_) => {}
            Err(e) => self.failed(id, e.outcome),
        }
    }

    fn failed(&self, id: &str, outcome: Outcome) {
        let (phase, key) = if outcome == Outcome::Rejected {
            (MediaPhase::Failed, "speechRejected")
        } else {
            (MediaPhase::Unknown, "speechUnknown")
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
            let account = match self.account_of(&r) {
                Ok(a) => a,
                Err(_) => break,
            };
            match self.moss.task(&account.key, &task) {
                Ok(Task::Waiting(_)) => {}
                Ok(Task::Failed(_)) => return self.failed(id, Outcome::Rejected),
                Ok(Task::Audio("speech", g)) => {
                    if self.made(id, g) {
                        self.download_result(id, stop);
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

    /// `saveAudioResult`: fetched, checked and kept; anything off is a failed download.
    fn download_result(self: &Arc<Self>, id: &str, stop: &Stop) {
        let Ok(r) = self.found(id) else { return };
        let (Some(url), MediaPhase::Downloading) = (r.url.clone(), r.phase) else {
            return;
        };
        let format = r.result_format.unwrap_or(r.request.format);
        let kept = self.fetch_result(&url, format, id, stop);
        if stop.aborted() {
            return;
        }
        let ok = match kept {
            Ok((attachment, input, metadata)) => self.change(id, &[MediaPhase::Downloading], |r| {
                r.metadata = metadata;
                r.attachment = attachment;
                r.result_input = input;
                r.url = None;
                r.phase = MediaPhase::Ready;
                r.problem.clear();
            }),
            Err(why) => {
                eprintln!("speech {id}: {why}");
                self.change(id, &[MediaPhase::Downloading], |r| {
                    r.phase = MediaPhase::DownloadFailed;
                    r.problem = t("server.media.speechDownloadFailed", &[]);
                })
            }
        };
        if let Err(e) = ok {
            eprintln!("speech {id}: {}", e.message);
        }
    }

    fn fetch_result(&self, url: &str, format: MediaAudioFormat, id: &str, stop: &Stop) -> Result<Kept, String> {
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
        // What the file says of itself, as `stageResult` reads it; a container that does not read is a failed download.
        let facts = super::validate::audio_facts(bytes.clone(), &kind).map_err(|e| e.message)?;
        let metadata = Some(serde_json::json!({
            "source": "file",
            "sampleRate": facts.sample_rate,
            "duration": facts.seconds,
            "channels": facts.channels,
            "bitDepth": facts.bits,
        }));
        if bytes.len() <= ATTACHMENT_MAX {
            let a = self.files.keep(&bytes, &name, &kind).map_err(|e| e.message)?;
            return Ok((Some(a), None, metadata));
        }
        // Past an attachment's size: a pinned input, released with the job.
        let input = self
            .inputs
            .create(&MediaInputRequest {
                kind: MediaInputKind::Audio,
                name: serde_json::from_value(Value::String(name)).map_err(|e| e.to_string())?,
                mime: kind,
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
            metadata,
        ))
    }

    /// `resume`: only the known vendor task is asked again, never a new one.
    pub fn resume(self: &Arc<Self>, id: &str) -> Result<MediaSpeechJob, ApiError> {
        let r = self.found(id)?;
        if r.phase == MediaPhase::Ready || active(r.phase) {
            return Ok(r.view());
        }
        if r.view().can_resume != Some(true) {
            return Err(refused("speechNoResume"));
        }
        self.account_of(&r)?;
        self.change(id, &[r.phase], |r| {
            r.phase = MediaPhase::Generating;
            r.problem.clear();
        })?;
        let me = self.clone();
        let job = id.to_string();
        self.run(id, move |stop| me.poll(&job, &stop));
        Ok(self.found(id)?.view())
    }

    /// Jobs a restart left running: a known task is asked again, a download fetched again, the rest unknown.
    fn pick_up(self: &Arc<Self>) -> Result<(), ApiError> {
        let rows: Vec<String> = {
            let db = self.db();
            let mut q = db
                .prepare("select data from media_job where kind='speech' and phase in ('queued','generating','downloading')")
                .map_err(storage)?;
            q.query_map([], |r| r.get::<_, String>(0)).map_err(storage)?.filter_map(Result::ok).collect()
        };
        for data in rows {
            let Ok(r) = serde_json::from_str::<Record>(&data) else { continue };
            let id = r.request.id.clone();
            match (r.phase, &r.remote_task) {
                (MediaPhase::Downloading, _) => {
                    let me = self.clone();
                    let job = id.clone();
                    self.run(&id, move |stop| me.download_result(&job, &stop));
                }
                (MediaPhase::Generating, Some(_)) => {
                    let me = self.clone();
                    let job = id.clone();
                    self.run(&id, move |stop| me.poll(&job, &stop));
                }
                _ => {
                    self.change(&id, &[r.phase], |r| {
                        r.phase = if r.phase == MediaPhase::Queued {
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

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for stop in self.runs.lock().unwrap_or_else(|e| e.into_inner()).values() {
            stop.abort();
        }
    }

    fn list_views(&self) -> Result<Vec<MediaJob>, ApiError> {
        let db = self.db();
        let mut q = db
            .prepare("select data from media_job where kind='speech' order by created_at desc,id limit 100")
            .map_err(storage)?;
        let rows: Vec<String> = q.query_map([], |r| r.get::<_, String>(0)).map_err(storage)?.filter_map(Result::ok).collect();
        Ok(rows
            .into_iter()
            .filter_map(|d| serde_json::from_str::<Record>(&d).ok())
            .map(|r| MediaJob::MediaSpeechJob(r.view()))
            .collect())
    }

    fn is_mine(&self, id: &str) -> bool {
        Self::read(&self.db(), id).ok().flatten().is_some()
    }
}

impl OtherJobs for Audio {
    fn list(&self) -> Result<Vec<MediaJob>, ApiError> {
        self.list_views()
    }

    fn get(&self, id: &str) -> Option<Result<MediaJob, ApiError>> {
        self.is_mine(id).then(|| self.found(id).map(|r| MediaJob::MediaSpeechJob(r.view())))
    }

    fn cancel(&self, id: &str) -> Option<Result<MediaJob, ApiError>> {
        if !self.is_mine(id) {
            return None;
        }
        Some((|| {
            let r = self.found(id)?;
            if active(r.phase) {
                self.change(id, &[r.phase], |r| {
                    r.phase = MediaPhase::Canceled;
                    r.problem = t("server.media.canceled", &[]);
                })?;
                if let Some(stop) = self.runs.lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
                    stop.abort();
                }
            }
            Ok(MediaJob::MediaSpeechJob(self.found(id)?.view()))
        })())
    }

    fn retry_download(&self, id: &str) -> Option<Result<MediaJob, ApiError>> {
        if !self.is_mine(id) {
            return None;
        }
        Some((|| {
            let r = self.found(id)?;
            if matches!(r.phase, MediaPhase::Ready | MediaPhase::Downloading) {
                return Ok(MediaJob::MediaSpeechJob(r.view()));
            }
            if r.released || r.url.is_none() || !matches!(r.phase, MediaPhase::DownloadFailed | MediaPhase::Canceled) {
                return Err(refused("noDownload"));
            }
            self.change(id, &[r.phase], |r| {
                r.phase = MediaPhase::Downloading;
                r.problem.clear();
            })?;
            if let Some(me) = self.me.get().and_then(Weak::upgrade) {
                let work = me.clone();
                let job = id.to_string();
                me.run(id, move |stop| work.download_result(&job, &stop));
            }
            Ok(MediaJob::MediaSpeechJob(self.found(id)?.view()))
        })())
    }

    fn preview_release(&self, id: &str) -> Option<Result<Preview, ApiError>> {
        if !self.is_mine(id) {
            return None;
        }
        Some(self.found(id).and_then(|r| {
            if active(r.phase) {
                return Err(refused("releaseUnavailable"));
            }
            Ok(Preview {
                does: if r.view().can_release {
                    vec![
                        t("server.media.releasePreview", &[]),
                        t("server.media.releasePreserves", &[]),
                        t("server.media.releaseAbandons", &[]),
                    ]
                } else {
                    vec![]
                },
            })
        }))
    }

    fn release(&self, id: &str) -> Option<Result<MediaJob, ApiError>> {
        if !self.is_mine(id) {
            return None;
        }
        Some((|| {
            let r = self.found(id)?;
            if active(r.phase) {
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
            Ok(MediaJob::MediaSpeechJob(self.found(id)?.view()))
        })())
    }
}

/// `media.speech.create` and `media.speech.resume`.
pub fn install(hub: &crate::Hub, audio: Arc<Audio>) {
    use vibevalley_protocol::ops;
    hub.on::<ops::MediaSpeechCreate>({
        let a = audio.clone();
        move |ctx, r| {
            if ctx.caller != vibevalley_protocol::Caller::User {
                return Err(ApiError::new(BizCode::MediaRefused, t("server.media.userRequired", &[])));
            }
            a.create(r, MediaSource::User {})
        }
    });
    hub.on::<ops::MediaSpeechResume>({
        let a = audio.clone();
        move |_, r| a.resume(&r.id)
    });
}
