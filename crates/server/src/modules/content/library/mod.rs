//! The library (VibeValley `modules/media/library.ts`): kept attachments as
//! material, what media made, what the user said with a file and what a
//! helper brought in, one item per file in `server.db`'s
//! `media_library_item` (joined with the attachments' table).
//!
//! What the farm hears is recorded on its own event bus worker thread so
//! recording never runs inside a chat write transaction.

use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, ApiError, Attachment, BizCode, Fact, JobKind, LibraryAddRequest, LibraryItem, LibraryListRequest, LibraryOrigin, LibraryOriginFetchedFrom,
    MediaAudioJob, MediaJob, MediaPhase, MessageKind, Preview, ops,
};

use crate::db::generated::content_library as q;

use crate::base::{LookIn, ModuleDb, missing};
use crate::modules::collab::channel::{ChannelEvent, Chat, to_message};
use crate::modules::content::attachment::{ATTACHMENT_MAX, Attachments};
use crate::modules::infra::http::{no_redirect_client, public_https, public_v4, run_http};
use crate::{Hub, now};

const LIST_MAX: i64 = 500;
const DOWNLOAD: Duration = Duration::from_secs(60);

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::LibraryRefused, text.into())
}

fn db_failed(e: sqlx::Error) -> ApiError {
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

fn item_of(row: q::GetItemRow) -> LibraryItem {
    LibraryItem {
        attachment: Attachment {
            id: row.attachment_id,
            name: row.name,
            r#type: row.r#type,
            size: row.size,
        },
        origin: serde_json::from_str(&row.origin).unwrap_or(LibraryOrigin::Uploaded { channel: None, message: None }),
        added_at: row.added_at,
        last_at: row.last_at,
    }
}

pub struct Library {
    db: ModuleDb,
    files: Arc<Attachments>,
    sub: Mutex<Option<crate::event_bus::Subscription>>,
    chat_observer: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}

impl Library {
    pub fn open(home: &Path, files: Arc<Attachments>) -> Result<Arc<Library>, ApiError> {
        Ok(Arc::new(Library {
            db: ModuleDb::open(home, crate::db::schema::CONTENT_LIBRARY).map_err(db_failed)?,
            files,
            sub: Mutex::new(None),
            chat_observer: Mutex::new(None),
        }))
    }

    pub fn close(&self) {
        let prev = self.sub.lock().take();
        drop(prev);
        if let Some((cancel, handle)) = self.chat_observer.lock().take() {
            cancel.cancel();
            let _ = vibevalley_runtime::rt::block_on(handle);
        }
    }

    fn found(&self, id: &str) -> Result<LibraryItem, ApiError> {
        match self.db.run(async |db| q::get_item(db, q::GetItemParams { attachment_id: id.into() }).await) {
            Ok(row) => Ok(item_of(row)),
            Err(sqlx::Error::RowNotFound) => Err(missing(t("server.library.noItem", &[("id", id.into())]), LookIn::Library)),
            Err(error) => Err(db_failed(error)),
        }
    }

    /// A later arrival only moves `last_at`.
    fn keep(&self, id: &str, origin: &LibraryOrigin, at: i64) -> Result<(), ApiError> {
        self.db
            .run(async |db| {
                q::keep_item(
                    db,
                    q::KeepItemParams {
                        attachment_id: id.into(),
                        kind: origin_kind(origin).into(),
                        origin: serde_json::to_string(origin).expect("JSON"),
                        added_at: at,
                    },
                )
                .await
            })
            .map_err(db_failed)
    }

    /// What a ready media job made, once per job.
    fn record_made(&self, jobs: &[MediaJob]) -> Result<(), ApiError> {
        for job in jobs {
            let Some((id, job_kind, attachment, updated_at)) = ready_made(job) else {
                continue;
            };
            let origin = LibraryOrigin::Generated { job: id.into(), job_kind };
            self.db
                .run(async |db| {
                    q::keep_generated(
                        db,
                        q::KeepGeneratedParams {
                            attachment_id: attachment.into(),
                            kind: origin_kind(&origin).into(),
                            origin: serde_json::to_string(&origin).expect("JSON"),
                            added_at: updated_at,
                            source_job_id: Some(id.into()),
                        },
                    )
                    .await
                })
                .map_err(db_failed)?;
        }
        Ok(())
    }

    fn record_said(&self, message: &vibevalley_protocol::ChatMessage) -> Result<(), ApiError> {
        if !matches!(message.actor, Actor::User { .. }) || message.kind != MessageKind::Chat {
            return Ok(());
        }
        let at = message.edited.unwrap_or(message.at);
        for a in &message.attachments {
            let origin = LibraryOrigin::Uploaded {
                channel: Some(message.channel.clone()),
                message: Some(message.id.clone()),
            };
            self.keep(&a.id, &origin, at)?;
        }
        Ok(())
    }

    pub fn list(&self, req: &LibraryListRequest) -> Result<Vec<LibraryItem>, ApiError> {
        let kind = req.origin.map(|o| o.as_str()).unwrap_or("");
        let top = req.r#type.map(|t| t.as_str()).unwrap_or("");
        let text = req.text.as_deref().unwrap_or("").trim().to_lowercase();
        let sort = req.sort.map(|s| s.as_str()).unwrap_or("recent");
        let rows = self
            .db
            .run(async |db| {
                q::list_items(
                    db,
                    q::ListItemsParams {
                        kind: kind.into(),
                        media_type: top.into(),
                        search: text,
                        sort: sort.into(),
                        item_limit: LIST_MAX,
                    },
                )
                .await
            })
            .map_err(db_failed)?;
        Ok(rows.into_iter().map(item_of).collect())
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
        let at = now();
        self.db
            .run(async |db| {
                q::soft_remove_generated_item(
                    &mut *db,
                    q::SoftRemoveGeneratedItemParams {
                        attachment_id: id.into(),
                        removed_at: Some(at),
                    },
                )
                .await?;
                q::delete_non_generated_item(db, q::DeleteNonGeneratedItemParams { attachment_id: id.into() }).await
            })
            .map_err(db_failed)
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
    let client = no_redirect_client()
        .map_err(|e| refused(t("server.library.notFetched", &[("url", "".into()), ("why", e.into())])))?
        .clone();
    let target = address.to_string();
    let (bytes, kind) = run_http(async move {
        let mut response = client.get(&target).timeout(DOWNLOAD).send().await.map_err(|e| {
            if e.is_timeout() {
                refused(t("server.library.slow", &[]))
            } else {
                refused(t("server.library.notFetched", &[("url", "".into()), ("why", e.to_string().into())]))
            }
        })?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(refused(t(
                "server.library.notFetched",
                &[("url", target.into()), ("why", status.to_string().into())],
            )));
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
            .unwrap_or_default();
        let mut bytes = vec![];
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            if e.is_timeout() {
                refused(t("server.library.slow", &[]))
            } else {
                refused(t("server.library.notFetched", &[("url", "".into()), ("why", e.to_string().into())]))
            }
        })? {
            if bytes.len() + chunk.len() > ATTACHMENT_MAX {
                return Err(too_big());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((bytes, kind))
    })?;
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

/// The `library.item.*` endpoints (the user's), and the recording of what
/// the farm hears (media jobs via [`EventBus`] and posted/edited chat
/// attachments via [`Chat::subscribe_events`]).
pub fn install(hub: &Hub, library: Arc<Library>, chat: &Chat) {
    let l = library.clone();
    hub.on::<ops::LibraryItemList>(move |_, r| l.list(&r));
    let l = library.clone();
    hub.on::<ops::LibraryItemAdd>(move |_, r| l.add(&r, &AddedBy::User));
    let l = library.clone();
    hub.on::<ops::LibraryItemDelete>(move |_, r| l.remove(&r.id));
    let l = library.clone();
    hub.on::<ops::LibraryItemPreviewDelete>(move |_, r| l.preview_remove(&r.id));

    let weak = Arc::downgrade(&library);
    let sub = hub.subscribe_transitions("library", move |_, tr| {
        let Some(l) = weak.upgrade() else { return };
        let Fact::MediaChanged(m) = &tr.fact else { return };
        if let Err(e) = l.record_made(&m.jobs) {
            eprintln!("vibevalley-server: library: recording: {}", e.message);
        }
    });
    let prev = library.sub.lock().replace(sub);
    drop(prev);

    let weak = Arc::downgrade(&library);
    let mut events = chat.subscribe_events();
    let cancel = hub.child_token();
    let task_cancel = cancel.clone();
    let handle = hub.spawn_task(async move {
        loop {
            let event = tokio::select! {
                biased;
                _ = task_cancel.cancelled() => return,
                res = events.recv() => match res {
                    Ok(ev) => ev,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            };
            let msg = match event {
                ChannelEvent::Posted(c) => to_message(&c.row),
                ChannelEvent::Edited(msg) => msg,
                ChannelEvent::Removed { .. } | ChannelEvent::Reacted(_) | ChannelEvent::Pinned(_) | ChannelEvent::UserRead { .. } => continue,
            };
            let Some(l) = weak.upgrade() else { return };
            let _ = tokio::task::spawn_blocking(move || {
                if let Err(e) = l.record_said(&msg) {
                    eprintln!("vibevalley-server: library: recording: {}", e.message);
                }
            })
            .await;
        }
    });
    if let Some((old_cancel, old_handle)) = library.chat_observer.lock().replace((cancel, handle)) {
        old_cancel.cancel();
        let _ = vibevalley_runtime::rt::block_on(old_handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_failed_generated_item_is_retryable_after_reopen() {
        let home = tempfile::tempdir().unwrap();
        let files = Attachments::open(home.path()).unwrap();
        let attachment = files.keep(b"image", "image.png", "image/png").unwrap();
        let job: MediaJob = serde_json::from_value(serde_json::json!({
            "kind":"image","id":"job","prompt":"p","model":"m","connection":"c","revision":1,
            "source":{"kind":"user"},"phase":"ready","phaseText":"","problem":"","canCancel":false,
            "canRetryDownload":false,"createdAt":1,"updatedAt":2,"attachment":attachment
        }))
        .unwrap();
        let library = Library::open(home.path(), files.clone()).unwrap();
        let admin = |sql: &'static str| {
            pollster::block_on(async {
                let mut conn = crate::base::open_sqlx_db(home.path()).await?;
                sqlx::raw_sql(sql).execute(&mut conn).await
            })
            .unwrap()
        };
        admin("CREATE TRIGGER refuse_media_item BEFORE INSERT ON media_library_item BEGIN SELECT RAISE(ABORT, 'item failed'); END;");
        assert!(library.record_made(std::slice::from_ref(&job)).is_err());
        drop(library);
        let library = Library::open(home.path(), files.clone()).unwrap();
        admin("DROP TRIGGER refuse_media_item;");
        library.record_made(std::slice::from_ref(&job)).unwrap();
        let stored = library.found(&attachment.id).unwrap();
        assert_eq!(stored.attachment, attachment);
        assert!(matches!(stored.origin,LibraryOrigin::Generated{ref job,..} if job=="job"));
        library.remove(&attachment.id).unwrap();
        library.record_made(&[job]).unwrap();
        assert_eq!(library.found(&attachment.id).unwrap_err().biz_code, BizCode::LibraryNotFound);
        assert_eq!(std::fs::read(files.file(&attachment.id).unwrap().path).unwrap(), b"image");
    }
}
