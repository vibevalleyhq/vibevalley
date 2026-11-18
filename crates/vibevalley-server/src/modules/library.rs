//! The library (VibeValley `modules/media/library.ts`): kept attachments as
//! material, what media made, what the user said with a file and what a
//! helper brought in, one item per file in `server.db`'s
//! `media_library_item` (joined with the attachments' table).
//!
//! What the farm hears is recorded on a thread of its own: a hub watcher
//! may run while the chat holds its write transaction.

use std::io::Read;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Row, params};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, ApiError, Attachment, BizCode, Fact, JobKind, LibraryAddRequest, LibraryItem, LibraryListRequest, LibraryOrigin, LibraryOriginFetchedFrom,
    MediaAudioJob, MediaJob, MediaPhase, MessageKind, Preview, ops,
};

use crate::base::{LookIn, missing, open_db};
use crate::modules::attachment::{ATTACHMENT_MAX, Attachments};
use crate::public_http::{public_https, public_v4};
use crate::{Hub, lock, now};

const LIST_MAX: i64 = 500;
const DOWNLOAD: Duration = Duration::from_secs(60);

const SCHEMA: &str = "
create table if not exists media_library_item (
  attachment_id text primary key,
  kind          text not null check (kind in ('generated', 'uploaded', 'fetched')),
  origin        text not null,
  added_at      integer not null,
  last_at       integer not null
);
create table if not exists media_library_job (job_id text primary key);
create index if not exists media_library_item_recent on media_library_item (last_at desc, attachment_id);
";

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::LibraryRefused, text.into())
}

fn db_failed(e: rusqlite::Error) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("library: {e}"))
}

/// Who puts a file in: the user (uploads only), or a helper or assistant
/// (by url, or by a path in `dir`, its working directory).
#[derive(Debug, Clone)]
pub enum AddedBy {
    User,
    Agent {
        agent: String,
        session: Option<String>,
        dir: Option<PathBuf>,
    },
}

fn type_of_name(name: &str) -> &'static str {
    let ext = if name.contains('.') {
        name.rsplit('.').next().unwrap_or("").to_lowercase()
    } else {
        String::new()
    };
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" => "text/html",
        _ => "application/octet-stream",
    }
}

fn given(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|t| !t.trim().is_empty())
}

/// Every address the name resolves to is a public IPv4 one (VibeValley's
/// `publicFetch` also dials exactly those).
fn resolves_public(host: &str) -> bool {
    match (host, 443).to_socket_addrs() {
        Ok(addrs) => {
            let all: Vec<_> = addrs.collect();
            !all.is_empty() && all.iter().all(|a| matches!(a.ip(), IpAddr::V4(v4) if public_v4(v4)))
        }
        Err(_) => false,
    }
}

fn origin_kind(o: &LibraryOrigin) -> &'static str {
    match o {
        LibraryOrigin::Generated { .. } => "generated",
        LibraryOrigin::Uploaded { .. } => "uploaded",
        LibraryOrigin::Fetched { .. } => "fetched",
    }
}

const ITEM: &str = "select i.attachment_id, i.origin, i.added_at, i.last_at, a.name, a.type, a.size
     from media_library_item i join attachment a on a.id = i.attachment_id";

fn item_of(r: &Row) -> rusqlite::Result<LibraryItem> {
    let origin: String = r.get(1)?;
    Ok(LibraryItem {
        attachment: Attachment {
            id: r.get(0)?,
            name: r.get(4)?,
            r#type: r.get(5)?,
            size: r.get(6)?,
        },
        origin: serde_json::from_str(&origin).unwrap_or(LibraryOrigin::Uploaded { channel: None, message: None }),
        added_at: r.get(2)?,
        last_at: r.get(3)?,
    })
}

pub struct Library {
    db: Mutex<Connection>,
    files: Arc<Attachments>,
    stop: Mutex<Option<flume::Sender<()>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Library {
    pub fn open(home: &Path, files: Arc<Attachments>) -> Result<Arc<Library>, ApiError> {
        let conn = open_db(home).map_err(db_failed)?;
        conn.execute_batch(SCHEMA).map_err(db_failed)?;
        Ok(Arc::new(Library {
            db: Mutex::new(conn),
            files,
            stop: Mutex::new(None),
            thread: Mutex::new(None),
        }))
    }

    pub fn close(&self) {
        let _ = lock(&self.stop).take();
        if let Some(handle) = lock(&self.thread).take()
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn found(&self, id: &str) -> Result<LibraryItem, ApiError> {
        self.db()
            .query_row(&format!("{ITEM} where i.attachment_id = ?1"), [id], item_of)
            .optional()
            .map_err(db_failed)?
            .ok_or_else(|| missing(t("server.library.noItem", &[("id", id.into())]), LookIn::Library))
    }

    /// A later arrival only moves `last_at`.
    fn keep(&self, id: &str, origin: &LibraryOrigin, at: i64) -> Result<(), ApiError> {
        self.db()
            .execute(
                "insert into media_library_item (attachment_id, kind, origin, added_at, last_at) values (?1, ?2, ?3, ?4, ?4)
                 on conflict (attachment_id) do update set last_at = max(media_library_item.last_at, excluded.last_at)",
                params![id, origin_kind(origin), serde_json::to_string(origin).expect("JSON"), at],
            )
            .map_err(db_failed)?;
        Ok(())
    }

    /// What a ready media job made, once per job.
    fn record_made(&self, jobs: &[MediaJob]) -> Result<(), ApiError> {
        for job in jobs {
            let Some((id, job_kind, attachment, updated_at)) = ready_made(job) else {
                continue;
            };
            let origin = LibraryOrigin::Generated { job: id.into(), job_kind };
            let mut db = self.db();
            let seen: bool = db
                .query_row("select exists(select 1 from media_library_job where job_id=?1)", [id], |r| r.get(0))
                .map_err(db_failed)?;
            if seen {
                continue;
            }
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(db_failed)?;
            let inserted = tx
                .execute("insert or ignore into media_library_job(job_id) values (?1)", [id])
                .map_err(db_failed)?;
            if inserted != 0 {
                tx.execute(
                    "insert into media_library_item (attachment_id,kind,origin,added_at,last_at) values (?1,?2,?3,?4,?4) on conflict(attachment_id) do nothing",
                    params![attachment, origin_kind(&origin), serde_json::to_string(&origin).expect("JSON"), updated_at],
                )
                .map_err(db_failed)?;
            }
            tx.commit().map_err(db_failed)?;
        }
        Ok(())
    }

    fn record_said(&self, message: &vibevalley_protocol::ChatMessage) -> Result<(), ApiError> {
        if !matches!(message.actor, Actor::User { .. }) || message.kind != MessageKind::Chat {
            return Ok(());
        }
        for a in &message.attachments {
            let origin = LibraryOrigin::Uploaded {
                channel: Some(message.channel.clone()),
                message: Some(message.id.clone()),
            };
            self.keep(&a.id, &origin, message.at)?;
        }
        Ok(())
    }

    pub fn list(&self, req: &LibraryListRequest) -> Result<Vec<LibraryItem>, ApiError> {
        let kind = req.origin.map(|o| o.as_str()).unwrap_or("");
        let top = req.r#type.map(|t| t.as_str()).unwrap_or("");
        let text = req.text.as_deref().unwrap_or("").trim().to_lowercase();
        let sort = req.sort.map(|s| s.as_str()).unwrap_or("recent");
        let db = self.db();
        let mut stmt = db
            .prepare(&format!(
                "{ITEM}
                 where (?1 = '' or i.kind = ?1)
                   and (?2 = ''
                     or (?2 = 'other' and substr(a.type, 1, instr(a.type || '/', '/') - 1) not in ('image', 'audio', 'video'))
                     or substr(a.type, 1, instr(a.type || '/', '/') - 1) = ?2)
                   and (?3 = '' or instr(lower(a.name), ?3) > 0)
                 order by
                   case when ?4 = 'name' then lower(a.name) end,
                   case when ?4 = 'size' then a.size end desc,
                   i.last_at desc, i.attachment_id
                 limit ?5"
            ))
            .map_err(db_failed)?;
        let rows = stmt.query_map(params![kind, top, text, sort, LIST_MAX], item_of).map_err(db_failed)?;
        rows.collect::<Result<_, _>>().map_err(db_failed)
    }

    pub fn add(&self, req: &LibraryAddRequest, by: &AddedBy) -> Result<LibraryItem, ApiError> {
        let sources = [given(&req.attachment), given(&req.url), given(&req.path)]
            .iter()
            .filter(|s| s.is_some())
            .count();
        if sources != 1 {
            return Err(refused(t("server.library.oneSource", &[])));
        }
        let at = now();
        let name = given(&req.name).map(|n| n.trim().to_string()).unwrap_or_default();
        if let Some(id) = given(&req.attachment) {
            if !matches!(by, AddedBy::User) {
                return Err(refused(t("server.library.agentAttachment", &[])));
            }
            self.files.of(&[id.to_string()])?;
            self.keep(id, &LibraryOrigin::Uploaded { channel: None, message: None }, at)?;
            return self.found(id);
        }
        let AddedBy::Agent { agent, session, dir } = by else {
            return Err(refused(t("server.library.userFetch", &[])));
        };
        let url = given(&req.url).map(|u| u.trim().to_string());
        let path = req.path.clone().unwrap_or_default();
        let (bytes, found_name, kind) = match &url {
            Some(u) => download(u)?,
            None => {
                let (bytes, name) = work_file(dir.as_deref(), &path)?;
                (bytes, name, String::new())
            }
        };
        let name = if name.is_empty() { found_name } else { name };
        let kind = if kind.is_empty() { type_of_name(&name).to_string() } else { kind };
        let attachment = self.files.keep(&bytes, &name, &kind)?;
        let from = match url {
            Some(url) => LibraryOriginFetchedFrom::Url { url },
            None => LibraryOriginFetchedFrom::Path { path },
        };
        self.keep(
            &attachment.id,
            &LibraryOrigin::Fetched {
                agent: agent.clone(),
                session: session.clone(),
                from,
            },
            at,
        )?;
        self.found(&attachment.id)
    }

    pub fn remove(&self, id: &str) -> Result<(), ApiError> {
        self.found(id)?;
        self.db()
            .execute("delete from media_library_item where attachment_id = ?1", [id])
            .map_err(db_failed)?;
        Ok(())
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let item = self.found(id)?;
        Ok(Preview {
            does: vec![t("server.library.preview.remove", &[("name", item.attachment.name.into())])],
        })
    }
}

fn too_big() -> ApiError {
    refused(t("server.library.tooBig", &[("mb", (ATTACHMENT_MAX / 1024 / 1024).into())]))
}

/// A file from a public https address: its bytes, its name (the last path
/// segment, else the host) and the type the server said.
fn download(address: &str) -> Result<(Vec<u8>, String, String), ApiError> {
    let bad = || refused(t("server.library.badUrl", &[("url", address.into())]));
    let url = url::Url::parse(address).map_err(|_| bad())?;
    if !public_https(&url) {
        return Err(bad());
    }
    let host = url.host_str().unwrap_or("").to_string();
    if !resolves_public(&host) {
        return Err(refused(t(
            "server.library.notFetched",
            &[("url", address.into()), ("why", "Public IPv4 resolution required".into())],
        )));
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent.get(address).call().map_err(|e| match e {
        ureq::Error::Timeout(_) => refused(t("server.library.slow", &[])),
        e => refused(t("server.library.notFetched", &[("url", "".into()), ("why", e.to_string().into())])),
    })?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(refused(t(
            "server.library.notFetched",
            &[("url", address.into()), ("why", status.to_string().into())],
        )));
    }
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();
    let mut bytes = vec![];
    response
        .body_mut()
        .as_reader()
        .take(ATTACHMENT_MAX as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| refused(t("server.library.notFetched", &[("url", "".into()), ("why", e.to_string().into())])))?;
    if bytes.len() > ATTACHMENT_MAX {
        return Err(too_big());
    }
    let segment = url.path().rsplit('/').next().unwrap_or("");
    let named = percent_decoded(segment).unwrap_or_else(|| segment.to_string());
    Ok((bytes, if named.is_empty() { host } else { named }, kind))
}

fn percent_decoded(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `workFile`: a file inside the working directory (after symlinks and
/// `..`), at most the attachment limit.
fn work_file(dir: Option<&Path>, path: &str) -> Result<(Vec<u8>, String), ApiError> {
    let Some(dir) = dir else {
        return Err(refused(t("server.library.noPlace", &[])));
    };
    let unreadable = |e: std::io::Error| refused(t("server.library.unreadable", &[("path", path.into()), ("why", e.to_string().into())]));
    let root = std::fs::canonicalize(dir).map_err(unreadable)?;
    let full = std::fs::canonicalize(root.join(path)).map_err(|_| refused(t("server.library.notFile", &[("path", path.into())])))?;
    if !full.starts_with(&root) {
        return Err(refused(t("server.library.outside", &[("path", path.into())])));
    }
    let info = std::fs::metadata(&full).map_err(unreadable)?;
    if !info.is_file() {
        return Err(refused(t("server.library.notFile", &[("path", path.into())])));
    }
    if info.len() > ATTACHMENT_MAX as u64 {
        return Err(too_big());
    }
    let bytes = std::fs::read(&full).map_err(unreadable)?;
    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((bytes, name))
}

fn ready_made(job: &MediaJob) -> Option<(&str, JobKind, &str, i64)> {
    match job {
        MediaJob::MediaImageJob(j) if j.phase == MediaPhase::Ready => Some((&j.id, JobKind::Image, &j.attachment.as_ref()?.id, j.updated_at)),
        MediaJob::MediaSpeechJob(j) if j.phase == MediaPhase::Ready => Some((&j.id, JobKind::Speech, &j.attachment.as_ref()?.id, j.updated_at)),
        MediaJob::MediaAudioJob(MediaAudioJob::Speakers {
            id,
            phase: MediaPhase::Ready,
            attachment: Some(a),
            updated_at,
            ..
        }) => Some((id, JobKind::Speakers, &a.id, *updated_at)),
        MediaJob::MediaAudioJob(MediaAudioJob::VoiceDesign {
            id,
            phase: MediaPhase::Ready,
            attachment: Some(a),
            updated_at,
            ..
        }) => Some((id, JobKind::VoiceDesign, &a.id, *updated_at)),
        MediaJob::MediaAudioJob(MediaAudioJob::Clone {
            id,
            phase: MediaPhase::Ready,
            attachment: Some(a),
            updated_at,
            ..
        }) => Some((id, JobKind::Clone, &a.id, *updated_at)),
        MediaJob::MediaAudioJob(MediaAudioJob::Transcription {
            id,
            phase: MediaPhase::Ready,
            attachment: Some(a),
            updated_at,
            ..
        }) => Some((id, JobKind::Transcription, &a.id, *updated_at)),
        MediaJob::MediaImageJob(_) | MediaJob::MediaUnderstandingJob(_) | MediaJob::MediaSpeechJob(_) | MediaJob::MediaAudioJob(_) => None,
    }
}

enum Heard {
    Made(Vec<MediaJob>),
    Said(Box<vibevalley_protocol::ChatMessage>),
}

/// The `library.item.*` endpoints (the user's), and the recording of what
/// the farm hears.
pub fn install(hub: &Hub, library: Arc<Library>) {
    let l = library.clone();
    hub.on::<ops::LibraryItemList>(move |_, r| l.list(&r));
    let l = library.clone();
    hub.on::<ops::LibraryItemAdd>(move |_, r| l.add(&r, &AddedBy::User));
    let l = library.clone();
    hub.on::<ops::LibraryItemDelete>(move |_, r| l.remove(&r.id));
    let l = library.clone();
    hub.on::<ops::LibraryItemPreviewDelete>(move |_, r| l.preview_remove(&r.id));

    let (tx, rx) = flume::unbounded::<Heard>();
    let (stop_tx, stop_rx) = flume::bounded::<()>(0);
    *lock(&library.stop) = Some(stop_tx);
    hub.watch(Arc::new(move |_, tr| {
        let heard = match &tr.fact {
            Fact::MediaChanged(m) => Heard::Made(m.jobs.clone()),
            Fact::MessageChanged(m) => Heard::Said(Box::new(m.message.clone())),
            _ => return,
        };
        let _ = tx.send(heard);
    }));
    let weak = Arc::downgrade(&library);
    if let Ok(handle) = std::thread::Builder::new().name("vibevalley-library".into()).spawn(move || {
        loop {
            let heard = flume::Selector::new().recv(&rx, |r| r.ok()).recv(&stop_rx, |_| None).wait();
            let Some(heard) = heard else { return };
            let Some(l) = weak.upgrade() else { return };
            let done = match heard {
                Heard::Made(jobs) => l.record_made(&jobs),
                Heard::Said(message) => l.record_said(&message),
            };
            if let Err(e) = done {
                eprintln!("vibevalley-server: library: recording: {}", e.message);
            }
        }
    }) {
        *lock(&library.thread) = Some(handle);
    }
}
