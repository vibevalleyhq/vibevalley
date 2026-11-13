//! Durable image jobs. One execution slot, eight active admissions; queued
//! requests capture credentials in memory, never in the job database.
use super::{
    image_provider::{Failure, ImageBackend, Prepared},
    inputs::refused,
};
use crate::{
    Hub,
    modules::{
        attachment::{Attachments, open_db},
        channel::{Chat, Made, Posting},
    },
    now,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::watch;
use vibevalley_protocol::{ApiError, BizCode, Fact, MediaImageJob, MediaImageJobKind, MediaImageRequest, MediaJob, MediaPhase, MediaSource, ops};
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    request: MediaImageRequest,
    job: MediaImageJob,
    url: Option<String>,
}
/// Jobs of the kinds the image machine does not run (speech, audio,
/// understanding): it lists them with its own and hands their calls over.
pub trait OtherJobs: Send + Sync {
    /// Their views, newest first.
    fn list(&self) -> Result<Vec<MediaJob>, ApiError>;
    /// `None`: not one of theirs.
    fn get(&self, id: &str) -> Option<Result<MediaJob, ApiError>>;
    fn cancel(&self, id: &str) -> Option<Result<MediaJob, ApiError>>;
    fn retry_download(&self, id: &str) -> Option<Result<MediaJob, ApiError>>;
    fn preview_release(&self, id: &str) -> Option<Result<vibevalley_protocol::Preview, ApiError>>;
    fn release(&self, id: &str) -> Option<Result<MediaJob, ApiError>>;
}

struct Run {
    prepared: Option<Prepared>,
    stop: watch::Sender<bool>,
}
struct Inner {
    db: Connection,
    runs: HashMap<String, Run>,
}
pub struct Machine {
    inner: Mutex<Inner>,
    backend: Arc<dyn ImageBackend>,
    files: Arc<Attachments>,
    chat: Arc<Chat>,
    hub: Weak<Hub>,
    wake: flume::Sender<()>,
    closed: AtomicBool,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    others: std::sync::RwLock<Option<Arc<dyn OtherJobs>>>,
}
fn failed(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("media job storage: {e}"))
}
fn active(p: MediaPhase) -> bool {
    matches!(p, MediaPhase::Queued | MediaPhase::Generating | MediaPhase::Downloading)
}
fn read(db: &Connection, id: &str) -> Result<Option<Record>, ApiError> {
    let data: Option<String> = db
        .query_row("select data from media_job where id=?1 and kind='image'", [id], |r| r.get(0))
        .optional()
        .map_err(failed)?;
    data.map(|s| serde_json::from_str(&s).map_err(|_| refused("corrupt"))).transpose()
}
fn found(db: &Connection, id: &str) -> Result<Record, ApiError> {
    read(db, id)?.ok_or_else(|| refused("missing"))
}
fn recent(db: &Connection) -> Result<Vec<Record>, ApiError> {
    let mut q = db
        .prepare("select data from media_job where kind='image' order by created_at desc,id limit 100")
        .map_err(failed)?;
    q.query_map([], |r| r.get::<_, String>(0))
        .map_err(failed)?
        .map(|r| serde_json::from_str(&r.map_err(failed)?).map_err(|_| refused("corrupt")))
        .collect()
}
fn shown(mut r: Record) -> MediaImageJob {
    r.job.can_cancel = active(r.job.phase);
    r.job.can_retry_download = r.url.is_some() && matches!(r.job.phase, MediaPhase::DownloadFailed | MediaPhase::Canceled);
    r.job.phase_text = vibevalley_i18n::t(&format!("server.media.phase.{}", r.job.phase.as_str()), &[]);
    r.job
}
impl Machine {
    pub fn open(home: &Path, hub: &Arc<Hub>, files: Arc<Attachments>, chat: Arc<Chat>, backend: Arc<dyn ImageBackend>) -> Result<Arc<Self>, ApiError> {
        let db = open_db(home).map_err(failed)?;
        db.execute_batch("create table if not exists media_job(id text primary key,kind text not null,phase text not null,data text not null,created_at integer not null,updated_at integer not null);create index if not exists media_job_recent on media_job(created_at desc,id);").map_err(failed)?;
        let (wake, woken) = flume::bounded(1);
        let machine = Arc::new(Self {
            inner: Mutex::new(Inner { db, runs: HashMap::new() }),
            backend,
            files,
            chat,
            hub: Arc::downgrade(hub),
            wake,
            closed: AtomicBool::new(false),
            worker: Mutex::new(None),
            others: std::sync::RwLock::new(None),
        });
        {
            let mut inner = machine.inner();
            let ids = inner
                .db
                .prepare("select id from media_job where kind='image' and phase in ('queued','generating','downloading')")
                .map_err(failed)?
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(failed)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(failed)?;
            for id in ids {
                let mut r = found(&inner.db, &id)?;
                match r.job.phase {
                    MediaPhase::Queued => {
                        r.job.phase = MediaPhase::Canceled;
                        r.job.problem = vibevalley_i18n::t("server.media.restarted", &[]);
                    }
                    MediaPhase::Generating => {
                        r.job.phase = MediaPhase::Unknown;
                        r.job.problem = vibevalley_i18n::t("server.media.restarted", &[]);
                    }
                    MediaPhase::Downloading => {
                        let (stop, _) = watch::channel(false);
                        inner.runs.insert(id, Run { prepared: None, stop });
                    }
                    _ => {}
                }
                machine.save(&inner, &mut r)?;
            }
            machine.publish(&inner)?;
        }
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(failed)?;
        let weak = Arc::downgrade(&machine);
        let worker = std::thread::Builder::new()
            .name("media-jobs".into())
            .spawn(move || {
                while woken.recv().is_ok() {
                    let Some(m) = weak.upgrade() else {
                        break;
                    };
                    if m.closed.load(Ordering::SeqCst) {
                        break;
                    }
                    loop {
                        match runtime.block_on(m.next()) {
                            Ok(true) => {}
                            Ok(false) => break,
                            Err(error) => {
                                eprintln!("media job: {}", error.message);
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(failed)?;
        *machine.worker.lock().unwrap_or_else(|e| e.into_inner()) = Some(worker);
        for r in recent(&machine.inner().db)? {
            machine.post_back(&r);
        }
        machine.wake();
        Ok(machine)
    }
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn wake(&self) {
        let _ = self.wake.try_send(());
    }
    fn save(&self, inner: &Inner, r: &mut Record) -> Result<(), ApiError> {
        r.job.updated_at = now();
        inner.db.execute("insert into media_job(id,kind,phase,data,created_at,updated_at) values (?1,'image',?2,?3,?4,?5) on conflict(id) do update set phase=excluded.phase,data=excluded.data,updated_at=excluded.updated_at",params![r.job.id,r.job.phase.as_str(),serde_json::to_string(r).map_err(failed)?,r.job.created_at,r.job.updated_at]).map_err(failed)?;
        self.publish(inner)
    }
    /// The kinds this machine does not run.
    pub fn attach_others(&self, others: Arc<dyn OtherJobs>) {
        *self.others.write().unwrap_or_else(|e| e.into_inner()) = Some(others);
    }

    fn others(&self) -> Option<Arc<dyn OtherJobs>> {
        self.others.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Every kind's jobs, newest first, at most 100 (`mediaChanged`).
    fn all(&self, images: Vec<Record>) -> Result<Vec<MediaJob>, ApiError> {
        let mut jobs: Vec<MediaJob> = images.into_iter().map(|r| MediaJob::MediaImageJob(shown(r))).collect();
        if let Some(o) = self.others() {
            jobs.extend(o.list()?);
        }
        let created = |j: &MediaJob| match j {
            MediaJob::MediaImageJob(j) => (j.created_at, j.id.clone()),
            MediaJob::MediaSpeechJob(j) => (j.created_at, j.id.clone()),
            MediaJob::MediaUnderstandingJob(j) => (j.created_at, j.id.clone()),
            MediaJob::MediaAudioJob(j) => (serde_json::to_value(j).ok().and_then(|v| v["createdAt"].as_i64()).unwrap_or(0), String::new()),
        };
        jobs.sort_by_key(|j| std::cmp::Reverse(created(j)));
        jobs.truncate(100);
        Ok(jobs)
    }

    /// Tells the state of every kind's jobs now.
    pub fn publish_all(&self) -> Result<(), ApiError> {
        let inner = self.inner();
        self.publish(&inner)
    }

    fn publish(&self, inner: &Inner) -> Result<(), ApiError> {
        let jobs = self.all(recent(&inner.db)?)?;
        if let Some(hub) = self.hub.upgrade() {
            hub.apply(vec![Fact::MediaChanged(vibevalley_protocol::FactMediaChanged { at: now(), jobs })]);
        }
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<MediaJob>, ApiError> {
        let images = recent(&self.inner().db)?;
        self.all(images)
    }
    pub fn get(&self, id: &str) -> Result<MediaJob, ApiError> {
        if let Some(r) = self.others().and_then(|o| o.get(id)) {
            return r;
        }
        Ok(MediaJob::MediaImageJob(shown(found(&self.inner().db, id)?)))
    }
    fn capacity(inner: &Inner) -> Result<(), ApiError> {
        let n: i64 = inner
            .db
            .query_row("select count(*) from media_job where phase in ('queued','generating','downloading')", [], |r| {
                r.get(0)
            })
            .map_err(failed)?;
        if n >= 8 { Err(refused("busy")) } else { Ok(()) }
    }
    /// The caller supplies an authenticated source; orchestrators must obtain
    /// user intent before calling this method (their tools own that check).
    pub fn create(&self, request: MediaImageRequest, source: MediaSource) -> Result<MediaImageJob, ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        super::image_provider::body(&request, "")?;
        if let MediaSource::Orchestrator { agent, channel } = &source
            && (agent.is_empty() || channel.is_empty())
        {
            return Err(refused("invalid"));
        }
        let mut inner = self.inner();
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        if let Some(r) = read(&inner.db, &request.id)? {
            if r.request != request || r.job.source != source {
                return Err(refused("reusedId"));
            }
            return Ok(shown(r));
        }
        Self::capacity(&inner)?;
        let prepared = self.backend.prepare(&request)?;
        let time = now();
        let mut record = Record {
            job: MediaImageJob {
                kind: MediaImageJobKind::Image,
                id: request.id.clone(),
                prompt: request.prompt.clone(),
                model: prepared.model.clone(),
                connection: prepared.connection.clone(),
                revision: prepared.revision,
                source,
                usage: None,
                phase: MediaPhase::Queued,
                phase_text: String::new(),
                problem: String::new(),
                attachment: None,
                can_cancel: true,
                can_retry_download: false,
                created_at: time,
                updated_at: time,
            },
            request,
            url: None,
        };
        self.save(&inner, &mut record)?;
        let (stop, _) = watch::channel(false);
        inner.runs.insert(
            record.job.id.clone(),
            Run {
                prepared: Some(prepared),
                stop,
            },
        );
        drop(inner);
        self.wake();
        Ok(shown(record))
    }
    pub fn cancel(&self, id: &str) -> Result<MediaJob, ApiError> {
        if let Some(r) = self.others().and_then(|o| o.cancel(id)) {
            return r;
        }
        let mut inner = self.inner();
        let mut r = found(&inner.db, id)?;
        if active(r.job.phase) {
            r.job.phase = MediaPhase::Canceled;
            r.job.problem = vibevalley_i18n::t("server.media.canceled", &[]);
            self.save(&inner, &mut r)?;
            if let Some(run) = inner.runs.remove(id) {
                run.stop.send_replace(true);
            }
        }
        Ok(MediaJob::MediaImageJob(shown(r)))
    }
    pub fn retry_download(&self, id: &str) -> Result<MediaJob, ApiError> {
        if let Some(r) = self.others().and_then(|o| o.retry_download(id)) {
            return r;
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(BizCode::ServiceUnavailable, "media closed"));
        }
        let mut inner = self.inner();
        let mut r = found(&inner.db, id)?;
        if matches!(r.job.phase, MediaPhase::Ready | MediaPhase::Downloading) {
            return Ok(MediaJob::MediaImageJob(shown(r)));
        }
        if r.url.is_none() || !matches!(r.job.phase, MediaPhase::Canceled | MediaPhase::DownloadFailed) {
            return Err(refused("noDownload"));
        }
        Self::capacity(&inner)?;
        r.job.phase = MediaPhase::Downloading;
        r.job.problem.clear();
        self.save(&inner, &mut r)?;
        let (stop, _) = watch::channel(false);
        inner.runs.insert(id.into(), Run { prepared: None, stop });
        drop(inner);
        self.wake();
        Ok(MediaJob::MediaImageJob(shown(r)))
    }
    async fn next(&self) -> Result<bool, ApiError> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let next = {
            let mut inner = self.inner();
            let id: Option<String> = inner
                .db
                .query_row(
                    "select id from media_job where kind='image' and phase in ('queued','downloading') order by created_at,id limit 1",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(failed)?;
            let Some(id) = id else {
                return Ok(false);
            };
            let mut r = found(&inner.db, &id)?;
            let run = inner.runs.get_mut(&id).ok_or_else(|| refused("corrupt"))?;
            let stop = run.stop.subscribe();
            let prepared = run.prepared.take();
            if r.job.phase == MediaPhase::Queued {
                r.job.phase = MediaPhase::Generating;
                self.save(&inner, &mut r)?;
            }
            (r, stop, prepared)
        };
        let (mut r, mut stop, prepared) = next;
        if let Some(prepared) = prepared {
            let result = tokio::select! {_ = stop.changed()=>None,r=self.backend.generate(prepared)=>Some(r)};
            let mut inner = self.inner();
            if *stop.borrow() {
                return Ok(true);
            }
            r = found(&inner.db, &r.job.id)?;
            match result {
                Some(Ok(g)) => {
                    r.url = Some(g.url);
                    r.job.usage = Some(g.usage);
                    r.job.phase = MediaPhase::Downloading;
                }
                Some(Err(e)) => {
                    r.job.phase = match e {
                        Failure::Rejected => MediaPhase::Failed,
                        Failure::Unknown => MediaPhase::Unknown,
                    };
                    r.job.problem = vibevalley_i18n::t(
                        if matches!(e, Failure::Rejected) {
                            "server.media.rejected"
                        } else {
                            "server.media.unknown"
                        },
                        &[],
                    );
                }
                None => return Ok(true),
            }
            self.save(&inner, &mut r)?;
            if r.job.phase != MediaPhase::Downloading {
                inner.runs.remove(&r.job.id);
                return Ok(true);
            }
        }
        let url = r.url.as_deref().ok_or_else(|| refused("corrupt"))?;
        let bytes = tokio::select! {_ = stop.changed()=>None,b=self.backend.download(url,r.request.width,r.request.height)=>Some(b)};
        // Keep may block on disk. Cancellation is rechecked before publishing;
        // retained bytes are content-addressed and safe if the result was lost.
        if *stop.borrow() {
            return Ok(true);
        }
        let attachment = match bytes {
            Some(Ok(bytes)) if super::png::valid(&bytes, r.request.width, r.request.height) => {
                self.files.keep(&bytes, &format!("moss-{}.png", r.job.id), "image/png").ok()
            }
            _ => None,
        };
        {
            let mut inner = self.inner();
            if *stop.borrow() {
                return Ok(true);
            }
            r = found(&inner.db, &r.job.id)?;
            if let Some(a) = attachment {
                r.job.attachment = Some(a);
                r.job.phase = MediaPhase::Ready;
                r.url = None;
                r.job.problem.clear();
            } else {
                r.job.phase = MediaPhase::DownloadFailed;
                r.job.problem = vibevalley_i18n::t("server.media.downloadFailed", &[]);
            }
            self.save(&inner, &mut r)?;
            inner.runs.remove(&r.job.id);
        }
        self.post_back(&r);
        Ok(true)
    }
    fn post_back(&self, r: &Record) {
        if r.job.phase != MediaPhase::Ready {
            return;
        }
        let MediaSource::Orchestrator { agent, channel } = &r.job.source else {
            return;
        };
        let Some(attachment) = &r.job.attachment else {
            return;
        };
        if let Err(e) = self.chat.post(Posting {
            from: agent.clone(),
            channel: channel.clone(),
            text: vibevalley_i18n::t(
                "server.media.imageMade",
                &[("prompt", r.request.prompt.chars().take(80).collect::<String>().into())],
            ),
            send_key: format!("media:{}", r.job.id),
            made: Some(Made::Attachments(vec![attachment.id.clone()])),
            ..Posting::default()
        }) {
            eprintln!("media image post: {}", e.message);
        }
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        {
            let mut inner = self.inner();
            for run in inner.runs.values() {
                run.stop.send_replace(true);
            }
            let ids: Vec<_> = inner.runs.keys().cloned().collect();
            for id in ids {
                if let Ok(mut r) = found(&inner.db, &id)
                    && r.job.phase == MediaPhase::Generating
                {
                    r.job.phase = MediaPhase::Unknown;
                    r.job.problem = vibevalley_i18n::t("server.media.unknown", &[]);
                    if let Err(e) = self.save(&inner, &mut r) {
                        eprintln!("media close: {}", e.message);
                    }
                }
            }
            inner.runs.clear();
        }
        self.wake();
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}
pub fn install(hub: &Hub, m: Arc<Machine>) {
    hub.on::<ops::MediaImageCreate>({
        let m = m.clone();
        move |ctx, r| {
            if ctx.caller != vibevalley_protocol::Caller::User {
                return Err(refused("userRequired"));
            }
            m.create(r, MediaSource::User {})
        }
    });
    hub.on::<ops::MediaJobList>({
        let m = m.clone();
        move |_, _| m.list()
    });
    hub.on::<ops::MediaJobGet>({
        let m = m.clone();
        move |_, r| m.get(&r.id)
    });
    hub.on::<ops::MediaJobCancel>({
        let m = m.clone();
        move |_, r| m.cancel(&r.id)
    });
    hub.on::<ops::MediaJobDownload>({
        let m = m.clone();
        move |_, r| m.retry_download(&r.id)
    });
    hub.on::<ops::MediaJobPreviewRelease>({
        let m = m.clone();
        move |_, r| {
            if let Some(r) = m.others().and_then(|o| o.preview_release(&r.id)) {
                return r;
            }
            m.get(&r.id)?;
            Err(refused("releaseUnavailable"))
        }
    });
    hub.on::<ops::MediaJobRelease>(move |_, r| {
        if let Some(r) = m.others().and_then(|o| o.release(&r.id)) {
            return r;
        }
        m.get(&r.id)?;
        Err(refused("releaseUnavailable"))
    });
}
