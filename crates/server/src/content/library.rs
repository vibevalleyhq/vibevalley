//! The library (VibeValley `modules/media/library.ts`): kept attachments as
//! material, what media made, what the user said with a file and what a
//! helper brought in, one item per file in `server.db`'s
//! `media_library_item` (joined with the attachments' table).
//!
//! What the farm hears is recorded on its own async worker tasks so
//! recording never runs inside a chat write transaction.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sea_orm::sea_query::{Alias, Condition, Expr, Func, LikeExpr, OnConflict, Order, Query};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, ExprTrait, FromQueryResult, QueryFilter, Update};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, ApiError, Attachment, BizCode, Fact, JobKind, LibraryAddRequest, LibraryFileKind, LibraryItem, LibraryListRequest, LibraryOrigin,
    LibraryOriginFetchedFrom, LibrarySort, MediaAudioJob, MediaJob, MediaPhase, MessageKind, Preview, ops,
};

use crate::app::hub::refusal::{LookIn, missing};
use crate::content::attachment::{ATTACHMENT_MAX, AttachmentStore};
use crate::db::ServerDb;
use crate::db::entities::{content_attachment::attachment, content_library::media_library_item};
use crate::db::write_tx;
use crate::infra::http::{PublicDownload, PublicDownloadError};
use crate::{Hub, now};

const LIST_MAX: u64 = 500;
const DOWNLOAD: Duration = Duration::from_secs(60);

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::LibraryRefused, text.into())
}

fn db_failed(e: DbErr) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("library: {e}"))
}

#[derive(Debug, FromQueryResult)]
struct LibraryRow {
    attachment_id: String,
    origin: String,
    added_at: i64,
    last_at: i64,
    name: String,
    content_type: String,
    size: i64,
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

fn origin_kind(o: &LibraryOrigin) -> &'static str {
    match o {
        LibraryOrigin::Generated { .. } => "generated",
        LibraryOrigin::Uploaded { .. } => "uploaded",
        LibraryOrigin::Fetched { .. } => "fetched",
    }
}

fn item_of(row: LibraryRow) -> LibraryItem {
    LibraryItem {
        attachment: Attachment {
            id: row.attachment_id,
            name: row.name,
            r#type: row.content_type,
            size: row.size,
        },
        origin: serde_json::from_str(&row.origin).unwrap_or(LibraryOrigin::Uploaded { channel: None, message: None }),
        added_at: row.added_at,
        last_at: row.last_at,
    }
}

fn item_select() -> sea_orm::sea_query::SelectStatement {
    Query::select()
        .column((media_library_item::Entity, media_library_item::Column::AttachmentId))
        .column((media_library_item::Entity, media_library_item::Column::Origin))
        .column((media_library_item::Entity, media_library_item::Column::AddedAt))
        .column((media_library_item::Entity, media_library_item::Column::LastAt))
        .column((attachment::Entity, attachment::Column::Name))
        .expr_as(Expr::col((attachment::Entity, attachment::Column::ContentType)), "content_type")
        .column((attachment::Entity, attachment::Column::Size))
        .from(media_library_item::Entity)
        .inner_join(
            attachment::Entity,
            Expr::col((attachment::Entity, attachment::Column::Id)).equals((media_library_item::Entity, media_library_item::Column::AttachmentId)),
        )
        .and_where(Expr::col((media_library_item::Entity, media_library_item::Column::RemovedAt)).is_null())
        .to_owned()
}

fn media_type_condition(media_type: &str) -> sea_orm::sea_query::SimpleExpr {
    let lower_type = Func::lower(Expr::col((attachment::Entity, attachment::Column::ContentType)));
    Condition::any()
        .add(Expr::expr(lower_type.clone()).eq(media_type))
        .add(Expr::expr(lower_type).like(format!("{media_type}/%")))
        .into()
}

fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

pub struct Library {
    db: Arc<ServerDb>,
    files: Arc<AttachmentStore>,
    sub: Mutex<Option<crate::app::hub::event_bus::Subscription>>,
    fact_task: Mutex<Option<(tokio_util::sync::CancellationToken, tokio::task::JoinHandle<()>)>>,
    edit_task: Mutex<Option<(tokio_util::sync::CancellationToken, tokio::task::JoinHandle<()>)>>,
}

impl Library {
    pub fn open(db: Arc<ServerDb>, files: Arc<AttachmentStore>) -> Arc<Library> {
        Arc::new(Library {
            db,
            files,
            sub: Mutex::new(None),
            fact_task: Mutex::new(None),
            edit_task: Mutex::new(None),
        })
    }

    pub async fn close_async(&self) {
        let prev = self.sub.lock().take();
        drop(prev);
        let fact_task = self.fact_task.lock().take();
        if let Some((cancel, handle)) = fact_task {
            cancel.cancel();
            let _ = handle.await;
        }
        let edit_task = self.edit_task.lock().take();
        if let Some((cancel, handle)) = edit_task {
            cancel.cancel();
            let _ = handle.await;
        }
    }

    async fn found_async(&self, id: &str) -> Result<LibraryItem, ApiError> {
        let mut query = item_select();
        query.and_where(Expr::col((media_library_item::Entity, media_library_item::Column::AttachmentId)).eq(id));
        let conn = self.db.read_conn();
        let row = LibraryRow::find_by_statement(conn.get_database_backend().build(&query))
            .one(conn)
            .await
            .map_err(db_failed)?;
        row.map(item_of)
            .ok_or_else(|| missing(t("server.library.noItem", &[("id", id.into())]), LookIn::Library))
    }

    /// A later arrival only moves `last_at`.
    async fn keep_async(&self, id: &str, origin: &LibraryOrigin, at: i64) -> Result<(), ApiError> {
        let model = media_library_item::ActiveModel {
            attachment_id: Set(id.into()),
            kind: Set(origin_kind(origin).into()),
            origin: Set(serde_json::to_string(origin).expect("JSON")),
            added_at: Set(at),
            last_at: Set(at),
            source_job_id: Set(None),
            removed_at: Set(None),
        };
        let excluded = Alias::new("excluded");
        let was_removed = Expr::col((media_library_item::Entity, media_library_item::Column::RemovedAt)).is_not_null();
        let existing_kind = Expr::col((media_library_item::Entity, media_library_item::Column::Kind));
        let excluded_kind = Expr::col((excluded.clone(), media_library_item::Column::Kind));
        let existing_origin = Expr::col((media_library_item::Entity, media_library_item::Column::Origin));
        let excluded_origin = Expr::col((excluded.clone(), media_library_item::Column::Origin));
        let existing_last = Expr::col((media_library_item::Entity, media_library_item::Column::LastAt));
        let excluded_last = Expr::col((excluded, media_library_item::Column::LastAt));
        let on_conflict = OnConflict::column(media_library_item::Column::AttachmentId)
            .value(
                media_library_item::Column::Kind,
                Expr::case(was_removed.clone(), excluded_kind).finally(existing_kind),
            )
            .value(
                media_library_item::Column::Origin,
                Expr::case(was_removed, excluded_origin).finally(existing_origin),
            )
            .value(
                media_library_item::Column::LastAt,
                Expr::case(existing_last.clone().gte(excluded_last.clone()), existing_last).finally(excluded_last),
            )
            .value(media_library_item::Column::RemovedAt, Expr::val(Option::<i64>::None))
            .to_owned();
        media_library_item::Entity::insert(model)
            .on_conflict(on_conflict)
            .exec(self.db.write_conn())
            .await
            .map_err(db_failed)?;
        Ok(())
    }

    /// What a ready media job made, once per job.
    pub(crate) async fn record_made_async(&self, jobs: &[MediaJob]) -> Result<(), ApiError> {
        for job in jobs {
            let Some((id, job_kind, attachment, updated_at)) = ready_made(job) else {
                continue;
            };
            let origin = LibraryOrigin::Generated { job: id.into(), job_kind };
            let model = media_library_item::ActiveModel {
                attachment_id: Set(attachment.into()),
                kind: Set(origin_kind(&origin).into()),
                origin: Set(serde_json::to_string(&origin).expect("JSON")),
                added_at: Set(updated_at),
                last_at: Set(updated_at),
                source_job_id: Set(Some(id.into())),
                removed_at: Set(None),
            };
            media_library_item::Entity::insert(model)
                .on_conflict_do_nothing()
                .exec(self.db.write_conn())
                .await
                .map_err(db_failed)?;
        }
        Ok(())
    }

    pub(crate) async fn record_said_async(&self, message: &vibevalley_protocol::ChatMessage) -> Result<(), ApiError> {
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
        let mut query = item_select();
        if let Some(kind) = req.origin {
            query.and_where(Expr::col((media_library_item::Entity, media_library_item::Column::Kind)).eq(kind.as_str()));
        }
        if let Some(media_type) = req.r#type {
            match media_type {
                LibraryFileKind::Other => {
                    let known = Condition::any()
                        .add(media_type_condition("image"))
                        .add(media_type_condition("audio"))
                        .add(media_type_condition("video"));
                    query.and_where(known.not().into());
                }
                LibraryFileKind::Image | LibraryFileKind::Audio | LibraryFileKind::Video => {
                    query.and_where(media_type_condition(media_type.as_str()));
                }
            }
        }
        let text = req.text.as_deref().unwrap_or("").trim().to_lowercase();
        if !text.is_empty() {
            let pattern = format!("%{}%", escape_like(&text));
            query.and_where(Expr::expr(Func::lower(Expr::col((attachment::Entity, attachment::Column::Name)))).like(LikeExpr::new(pattern).escape('\\')));
        }
        match req.sort.unwrap_or(LibrarySort::Recent) {
            LibrarySort::Name => {
                query.order_by_expr(Func::lower(Expr::col((attachment::Entity, attachment::Column::Name))).into(), Order::Asc);
            }
            LibrarySort::Size => {
                query.order_by((attachment::Entity, attachment::Column::Size), Order::Desc);
            }
            LibrarySort::Recent => {}
        }
        query
            .order_by((media_library_item::Entity, media_library_item::Column::LastAt), Order::Desc)
            .order_by((media_library_item::Entity, media_library_item::Column::AttachmentId), Order::Asc)
            .limit(LIST_MAX);

        let conn = self.db.read_conn();
        let rows = LibraryRow::find_by_statement(conn.get_database_backend().build(&query))
            .all(conn)
            .await
            .map_err(db_failed)?;
        Ok(rows.into_iter().map(item_of).collect())
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
            let at = now();
            self.files.of_async(std::slice::from_ref(&id)).await?;
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
                let dir = dir.clone();
                let path = path.clone();
                let (bytes, name) = crate::spawn_blocking_traced(move || work_file(dir.as_deref(), &path))
                    .await
                    .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))??;
                (bytes, name, String::new())
            }
        };
        let at = now();
        let name = if name.is_empty() { found_name } else { name };
        let kind = if kind.is_empty() { type_of_name(&name).to_string() } else { kind };
        let attachment = self.files.keep_async(bytes, name, kind).await?;
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
        let at = now();
        let id = id.to_owned();
        write_tx(self.db.write_conn(), db_failed, |tx| {
            Box::pin(async move {
                Update::many(media_library_item::Entity)
                    .col_expr(media_library_item::Column::RemovedAt, Expr::value(Some(at)))
                    .filter(media_library_item::Column::AttachmentId.eq(&id))
                    .filter(media_library_item::Column::SourceJobId.is_not_null())
                    .exec(tx)
                    .await
                    .map_err(db_failed)?;
                media_library_item::Entity::delete_many()
                    .filter(media_library_item::Column::AttachmentId.eq(&id))
                    .filter(media_library_item::Column::SourceJobId.is_null())
                    .exec(tx)
                    .await
                    .map_err(db_failed)?;
                Ok(())
            })
        })
        .await
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

fn downloaded_tuple(fetched: crate::infra::http::PublicBytes) -> (Vec<u8>, String, String) {
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
/// the farm hears (media jobs and posted/edited chat attachments via [`EventBus`]).
pub fn install(hub: &Hub, library: Arc<Library>, channel_events: Option<Arc<dyn crate::app::hub::ports::ChannelMessageEventsPort>>) {
    let l = library.clone();
    hub.on_async::<ops::LibraryItemList, _, _>(move |_, r| {
        let l = l.clone();
        async move { l.list_async(&r).await }
    });
    let l = library.clone();
    hub.on_async::<ops::LibraryItemAdd, _, _>(move |ctx, r| {
        let l = l.clone();
        let by = match ctx.caller {
            vibevalley_protocol::Caller::User | vibevalley_protocol::Caller::Remote => AddedBy::User,
            vibevalley_protocol::Caller::Orchestrator => AddedBy::Agent {
                agent: ctx.client.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                session: None,
                dir: None,
            },
            vibevalley_protocol::Caller::Session => {
                let sid = ctx.client.as_ref().map(|c| c.id.clone()).unwrap_or_default();
                let (agent, dir) = ctx
                    .hub
                    .read(|s| {
                        s.sessions
                            .iter()
                            .find(|h| h.id == sid)
                            .map(|h| (h.profile.clone().unwrap_or_default(), h.cwd.as_ref().map(PathBuf::from)))
                    })
                    .unwrap_or_default();
                AddedBy::Agent {
                    agent,
                    session: (!sid.is_empty()).then_some(sid),
                    dir,
                }
            }
        };
        async move { l.add_async(&r, &by).await }
    });
    let l = library.clone();
    hub.on_async::<ops::LibraryItemDelete, _, _>(move |_, r| {
        let l = l.clone();
        async move { l.remove_async(&r.id).await }
    });
    let l = library.clone();
    hub.on_async::<ops::LibraryItemPreviewDelete, _, _>(move |_, r| {
        let l = l.clone();
        async move { l.preview_remove_async(&r.id).await }
    });

    let (fact_tx, mut fact_rx) = tokio::sync::mpsc::unbounded_channel::<Fact>();
    let sub = hub.subscribe_transitions("library", move |_, tr| {
        if matches!(tr.fact, Fact::MediaChanged(_) | Fact::MessageChanged(_)) {
            let _ = fact_tx.send(tr.fact.clone());
        }
    });
    let prev = library.sub.lock().replace(sub);
    drop(prev);

    let weak = Arc::downgrade(&library);
    let cancel = hub.child_token();
    let task_cancel = cancel.clone();
    let handle = hub.spawn_task(async move {
        while let Some(fact) = tokio::select! {
            biased;
            _ = task_cancel.cancelled() => None,
            msg = fact_rx.recv() => msg,
        } {
            let Some(l) = weak.upgrade() else { return };
            match fact {
                Fact::MediaChanged(m) => {
                    if let Err(e) = l.record_made_async(&m.jobs).await {
                        eprintln!("vibevalley-server: library: recording: {}", e.message);
                    }
                }
                Fact::MessageChanged(m) => {
                    if let Err(e) = l.record_said_async(&m.message).await {
                        eprintln!("vibevalley-server: library: recording: {}", e.message);
                    }
                }
                _ => {}
            }
        }
    });
    if let Some((old_cancel, old_handle)) = library.fact_task.lock().replace((cancel, handle)) {
        old_cancel.cancel();
        hub.spawn_task(async move {
            let _ = old_handle.await;
        });
    }

    if let Some(port) = channel_events {
        let mut rx = port.subscribe_edited_messages();
        let weak = Arc::downgrade(&library);
        let cancel = hub.child_token();
        let task_cancel = cancel.clone();
        let handle = hub.spawn_task(async move {
            loop {
                let message = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = rx.recv() => match res {
                        Ok(m) => m,
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
        if let Some((old_cancel, old_handle)) = library.edit_task.lock().replace((cancel, handle)) {
            old_cancel.cancel();
            hub.spawn_task(async move {
                let _ = old_handle.await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::ConnectionTrait;

    use super::*;

    #[test]
    fn regression_failed_generated_item_is_retryable_after_reopen() {
        let home = tempfile::tempdir().unwrap();
        let db = ServerDb::open(home.path()).unwrap();
        let files = AttachmentStore::open(home.path(), db.clone());
        let attachment = vibevalley_runtime::rt::block_on(files.keep_async(b"image".to_vec(), "image.png".to_string(), "image/png".to_string())).unwrap();
        let job: MediaJob = serde_json::from_value(serde_json::json!({
            "kind":"image","id":"job","prompt":"p","model":"m","connection":"c","revision":1,
            "source":{"kind":"user"},"phase":"ready","phaseText":"","problem":"","canCancel":false,
            "canRetryDownload":false,"createdAt":1,"updatedAt":2,"attachment":attachment
        }))
        .unwrap();
        let library = Library::open(db.clone(), files.clone());
        let admin = |sql: &'static str| {
            vibevalley_runtime::rt::block_on(db.write_conn().execute_unprepared(sql)).unwrap();
        };
        admin("CREATE TRIGGER refuse_media_item BEFORE INSERT ON media_library_item BEGIN SELECT RAISE(ABORT, 'item failed'); END;");
        assert!(vibevalley_runtime::rt::block_on(library.record_made_async(std::slice::from_ref(&job))).is_err());
        drop(library);
        let library = Library::open(db.clone(), files.clone());
        admin("DROP TRIGGER refuse_media_item;");
        vibevalley_runtime::rt::block_on(library.record_made_async(std::slice::from_ref(&job))).unwrap();
        let stored = vibevalley_runtime::rt::block_on(library.found_async(&attachment.id)).unwrap();
        assert_eq!(stored.attachment, attachment);
        assert!(matches!(stored.origin,LibraryOrigin::Generated{ref job,..} if job=="job"));
        vibevalley_runtime::rt::block_on(library.remove_async(&attachment.id)).unwrap();
        vibevalley_runtime::rt::block_on(library.record_made_async(&[job])).unwrap();
        assert_eq!(
            vibevalley_runtime::rt::block_on(library.found_async(&attachment.id)).unwrap_err().biz_code,
            BizCode::LibraryNotFound
        );
        assert_eq!(
            std::fs::read(vibevalley_runtime::rt::block_on(files.file_async(&attachment.id)).unwrap().path).unwrap(),
            b"image"
        );
        db.close();
    }
}
