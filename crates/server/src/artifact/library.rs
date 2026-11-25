//! Media library: indexes kept attachments as reusable material from generated
//! media jobs, user chat uploads, and agent-fetched URLs or workspace files.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, ApiError, BizCode, ChatMessage, JobKind, LibraryAddRequest, LibraryItem, LibraryListRequest, LibraryOrigin, LibraryOriginFetchedFrom, MediaAudioJob,
    MediaJob, MediaPhase, MessageKind, Preview,
};

use crate::context::http::{PublicBytes, PublicDownload, PublicDownloadError};
use crate::context::{Context, LookIn, missing};
use crate::service::DbError;
use crate::storage::{ATTACHMENT_MAX, Storage};

const LIST_MAX: u64 = 500;
const DOWNLOAD: Duration = Duration::from_secs(60);

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::LibraryRefused, text.into())
}

fn db_failed(e: DbError) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("library: {e}"))
}

/// Who puts a file into the library: the user (existing attachment upload only)
/// or an agent (URL download or path inside its working directory).
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

/// Media library service indexing attachments from chat, media jobs, and agent imports.
pub struct Library {
    ctx: Arc<Context>,
    storage: Arc<Storage>,
    cancel: CancellationToken,
}

impl Library {
    pub fn open(
        ctx: Arc<Context>,
        storage: Arc<Storage>,
        channel_messages: Option<broadcast::Receiver<ChatMessage>>,
        media_jobs: Option<broadcast::Receiver<Vec<MediaJob>>>,
    ) -> Arc<Self> {
        let cancel = ctx.task.child_token();
        let store = Arc::new(Self {
            ctx: ctx.clone(),
            storage,
            cancel: cancel.clone(),
        });

        if let Some(rx) = channel_messages {
            store.spawn_message_listener(rx);
        }

        if let Some(mut rx) = media_jobs {
            let weak = Arc::downgrade(&store);
            let task_cancel = cancel;
            ctx.spawn("library.media_jobs", async move {
                loop {
                    let jobs = tokio::select! {
                        biased;
                        _ = task_cancel.cancelled() => return,
                        res = rx.recv() => match res {
                            Ok(j) => j,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                        },
                    };
                    let Some(l) = weak.upgrade() else { return };
                    if let Err(e) = l.record_made_async(&jobs).await {
                        eprintln!("vibevalley-server: library: recording: {}", e.message);
                    }
                }
            });
        }

        store
    }

    /// Attaches a chat message stream so user-uploaded attachments are indexed asynchronously.
    pub fn spawn_message_listener(self: &Arc<Self>, mut rx: broadcast::Receiver<ChatMessage>) {
        let weak = Arc::downgrade(self);
        let task_cancel = self.cancel.clone();
        self.ctx.spawn("library.channel_messages", async move {
            loop {
                let message = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = rx.recv() => match res {
                        Ok(msg) => msg,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    },
                };
                let Some(l) = weak.upgrade() else { return };
                if let Err(e) = l.record_said_async(&message).await {
                    eprintln!("vibevalley-server: library: recording: {}", e.message);
                }
            }
        });
    }

    pub fn close(&self) {
        self.cancel.cancel();
    }

    async fn found_async(&self, id: &str) -> Result<LibraryItem, ApiError> {
        self.ctx
            .service
            .artifact
            .find_library_item(id)
            .await
            .map_err(db_failed)?
            .ok_or_else(|| missing(t("server.library.noItem", &[("id", id.into())]), LookIn::Library))
    }

    async fn keep_async(&self, id: &str, origin: &LibraryOrigin, at: i64) -> Result<(), ApiError> {
        self.ctx.service.artifact.keep_library_item(id, origin, at).await.map_err(db_failed)
    }

    /// Records ready media job outputs once per `(attachment_id, source_job_id)`.
    pub async fn record_made_async(&self, jobs: &[MediaJob]) -> Result<(), ApiError> {
        for job in jobs {
            let Some((id, job_kind, attachment, updated_at)) = ready_made(job) else {
                continue;
            };
            let origin = LibraryOrigin::Generated { job: id.into(), job_kind };
            self.ctx
                .service
                .artifact
                .record_generated_library_item(attachment, id, &origin, updated_at)
                .await
                .map_err(db_failed)?;
        }
        Ok(())
    }

    /// Indexes attachments from a user chat message.
    pub async fn record_said_async(&self, message: &ChatMessage) -> Result<(), ApiError> {
        if !matches!(message.actor, Actor::User { .. }) || message.kind != MessageKind::Chat {
            return Ok(());
        }
        let at = message.edited.unwrap_or(message.at);
        for a in &message.attachments {
            let origin = LibraryOrigin::Uploaded {
                channel: Some(message.channel.clone()),
                message: Some(message.id.clone()),
            };
            self.keep_async(&a.id, &origin, at).await?;
        }
        Ok(())
    }

    pub async fn list_async(&self, req: &LibraryListRequest) -> Result<Vec<LibraryItem>, ApiError> {
        self.ctx.service.artifact.list_library_items(req, LIST_MAX).await.map_err(db_failed)
    }

    pub async fn add_async(&self, req: &LibraryAddRequest, by: &AddedBy) -> Result<LibraryItem, ApiError> {
        let sources = [given(&req.attachment), given(&req.url), given(&req.path)]
            .iter()
            .filter(|s| s.is_some())
            .count();
        if sources != 1 {
            return Err(refused(t("server.library.oneSource", &[])));
        }
        let name = given(&req.name).map(|n| n.trim().to_string()).unwrap_or_default();
        if let Some(id) = given(&req.attachment) {
            if !matches!(by, AddedBy::User) {
                return Err(refused(t("server.library.agentAttachment", &[])));
            }
            let id = id.to_string();
            let at = self.ctx.now();
            self.storage.of_async(std::slice::from_ref(&id)).await?;
            self.keep_async(&id, &LibraryOrigin::Uploaded { channel: None, message: None }, at).await?;
            return self.found_async(&id).await;
        }
        let AddedBy::Agent { agent, session, dir } = by else {
            return Err(refused(t("server.library.userFetch", &[])));
        };
        let url = given(&req.url).map(|u| u.trim().to_string());
        let path = req.path.clone().unwrap_or_default();
        let (bytes, found_name, kind) = match &url {
            Some(u) => download_async(u).await?,
            None => {
                let (bytes, name) = work_file_async(dir.as_deref(), &path).await?;
                (bytes, name, String::new())
            }
        };
        let at = self.ctx.now();
        let name = if name.is_empty() { found_name } else { name };
        let kind = if kind.is_empty() { type_of_name(&name).to_string() } else { kind };
        let attachment = self.storage.keep_async(bytes, name, kind).await?;
        let from = match url {
            Some(url) => LibraryOriginFetchedFrom::Url { url },
            None => LibraryOriginFetchedFrom::Path { path },
        };
        self.keep_async(
            &attachment.id,
            &LibraryOrigin::Fetched {
                agent: agent.clone(),
                session: session.clone(),
                from,
            },
            at,
        )
        .await?;
        self.found_async(&attachment.id).await
    }

    pub async fn remove_async(&self, id: &str) -> Result<(), ApiError> {
        self.found_async(id).await?;
        self.ctx.service.artifact.remove_library_item(id, self.ctx.now()).await.map_err(db_failed)
    }

    pub async fn preview_remove_async(&self, id: &str) -> Result<Preview, ApiError> {
        let item = self.found_async(id).await?;
        Ok(Preview {
            does: vec![t("server.library.preview.remove", &[("name", item.attachment.name.into())])],
        })
    }
}

fn too_big() -> ApiError {
    refused(t("server.library.tooBig", &[("mb", (ATTACHMENT_MAX / 1024 / 1024).into())]))
}

fn map_download_err(address: &str, err: PublicDownloadError) -> ApiError {
    match err {
        PublicDownloadError::BadUrl => refused(t("server.library.badUrl", &[("url", address.into())])),
        PublicDownloadError::Dns(why) => refused(t("server.library.notFetched", &[("url", address.into()), ("why", why.into())])),
        PublicDownloadError::Timeout => refused(t("server.library.slow", &[])),
        PublicDownloadError::HttpStatus(status) => refused(t("server.library.notFetched", &[("url", address.into()), ("why", status.to_string().into())])),
        PublicDownloadError::TooLarge => too_big(),
        PublicDownloadError::Network(why) => refused(t("server.library.notFetched", &[("url", "".into()), ("why", why.into())])),
    }
}

fn downloaded_tuple(fetched: PublicBytes) -> (Vec<u8>, String, String) {
    let host = fetched.url.host_str().unwrap_or("").to_string();
    let segment = fetched.url.path().rsplit('/').next().unwrap_or("");
    let named = percent_decoded(segment).unwrap_or_else(|| segment.to_string());
    (fetched.bytes, if named.is_empty() { host } else { named }, fetched.media_type)
}

async fn download_async(address: &str) -> Result<(Vec<u8>, String, String), ApiError> {
    let fetched = PublicDownload::get_bytes_async(address, DOWNLOAD, ATTACHMENT_MAX)
        .await
        .map_err(|e| map_download_err(address, e))?;
    Ok(downloaded_tuple(fetched))
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

/// Reads a regular file inside `dir` (after symlink/path canonicalization), up to `ATTACHMENT_MAX`.
async fn work_file_async(dir: Option<&Path>, path: &str) -> Result<(Vec<u8>, String), ApiError> {
    let Some(dir) = dir else {
        return Err(refused(t("server.library.noPlace", &[])));
    };
    let unreadable = |e: std::io::Error| refused(t("server.library.unreadable", &[("path", path.into()), ("why", e.to_string().into())]));
    let root = tokio::fs::canonicalize(dir).await.map_err(unreadable)?;
    let full = tokio::fs::canonicalize(root.join(path))
        .await
        .map_err(|_| refused(t("server.library.notFile", &[("path", path.into())])))?;
    if !full.starts_with(&root) {
        return Err(refused(t("server.library.outside", &[("path", path.into())])));
    }
    let info = tokio::fs::metadata(&full).await.map_err(unreadable)?;
    if !info.is_file() {
        return Err(refused(t("server.library.notFile", &[("path", path.into())])));
    }
    if info.len() > ATTACHMENT_MAX as u64 {
        return Err(too_big());
    }
    let bytes = tokio::fs::read(&full).await.map_err(unreadable)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::service::Service;

    #[tokio::test]
    async fn generated_item_records_idempotently_and_stays_removed_after_reopen() {
        let home = tempfile::tempdir().unwrap();
        let service = Service::open(home.path()).await.unwrap();
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service)),
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let storage = Storage::open_async(home.path(), ctx.clone()).await.unwrap();
        let attachment = storage
            .keep_async(b"image".to_vec(), "image.png".to_string(), "image/png".to_string())
            .await
            .unwrap();
        let job: MediaJob = serde_json::from_value(serde_json::json!({
            "kind":"image","id":"job","prompt":"p","model":"m","connection":"c","revision":1,
            "source":{"kind":"user"},"phase":"ready","phaseText":"","problem":"","canCancel":false,
            "canRetryDownload":false,"createdAt":1,"updatedAt":2,"attachment":attachment
        }))
        .unwrap();

        let library = Library::open(ctx.clone(), storage.clone(), None, None);
        library.record_made_async(std::slice::from_ref(&job)).await.unwrap();
        library.record_made_async(std::slice::from_ref(&job)).await.unwrap();
        let stored = library.found_async(&attachment.id).await.unwrap();
        assert_eq!(stored.attachment, attachment);
        assert!(matches!(stored.origin, LibraryOrigin::Generated { ref job, .. } if job == "job"));

        library.remove_async(&attachment.id).await.unwrap();
        library.close();
        drop(library);

        let library = Library::open(ctx.clone(), storage.clone(), None, None);
        library.record_made_async(&[job]).await.unwrap();
        assert_eq!(library.found_async(&attachment.id).await.unwrap_err().biz_code, BizCode::LibraryNotFound);
        assert_eq!(std::fs::read(storage.file_async(&attachment.id).await.unwrap().path).unwrap(), b"image");

        library.close();
        storage.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }
}
