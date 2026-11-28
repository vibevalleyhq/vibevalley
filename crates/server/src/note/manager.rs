//! Unified directory-backed note [`Manager`] and [`Maker`] identity.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use vibevalley_core::SliceMask;
use vibevalley_core::collab::{CommitMeta, encode_frontiers};
use vibevalley_core::note::annotation::{extract_annotation_links, extract_media_doc_annotations};
use vibevalley_core::note::base::extract_base_links;
use vibevalley_core::note::doc::{blocks_to_markdown, parse_doc_document, project_doc_view};
use vibevalley_core::note::links::{dedup_links, extract_markdown_links};
use vibevalley_core::note::{type_spec, validate_deletable_path, validate_note_path};
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    ApiError, BizCode, Caller, LinkEntityKind, Note as Wire, NoteCollabImportRequest, NoteCollabImportResult, NoteContent, NoteCover, NoteCoverSetRequest,
    NoteDocAppendBlockRequest, NoteEvent, NoteFileContent, NoteFileDeleteRequest, NoteFileDeleteResult, NoteFileEncoding, NoteFileGetRequest,
    NoteFileListRequest, NoteFileListResult, NoteFileWriteItem, NoteFileWriteRequest, NoteFileWriteResult, NoteHistoryForkRequest, NoteHistoryRestoreRequest,
    NoteHistoryUndoOriginRequest, NoteLinkListRequest, NoteLinkListResult, NoteLinkRef, NoteListRequest, NotePresenceEvent, NoteRequest, NoteSaid,
    NoteSuggestionAcceptInput, NoteSuggestionCreateInput, NoteTreeMoveRequest, NoteType, NoteUpdateRequest, NoteVersion, NoteVersionRequest, Preview,
    Suggestion, SuggestionChange, SuggestionEvent,
};

use super::collab::{
    BatchKey, OriginWriteBatcher, PresenceRoom, commit_meta_for_maker, export_doc_snapshot, guess_mime, ingest_files_into_doc, sha256_hex_bytes,
    sync_manifest_title_raw, upsert_file_for_write,
};
use super::library::{AddedBy, Library};
use super::media::{Media, MediaAnnouncement};
use super::{NOTE_USER_ORIGIN, is_user_actor};
use crate::context::api::{CallerContext, media::SharedSpeechStreams};
use crate::context::{Context, LookIn, missing};
use crate::service::DbError;
use crate::service::note::{NewNote, NewVersion, NoteRow, StoredSuggestion, VersionRow};
use crate::setting::Setting;
use crate::storage::Storage;

const TITLE_MAX: usize = 200;
const LIST_LIMIT: i64 = 500;

pub(super) fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::NoteRefused, text.into())
}

pub(super) fn q(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("note: {e}"))
}

pub(super) fn note_type_of(raw: &str) -> Result<NoteType, ApiError> {
    NoteType::parse(raw).ok_or_else(|| {
        let allowed_vec: Vec<String> = NoteType::ALL.into_iter().map(|t| t.as_str().to_string()).collect();
        let allowed = list(&allowed_vec);
        refused(t("server.note.badKind", &[("kind", raw.into()), ("kinds", allowed.into())]))
    })
}

pub(super) fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::now_v7().simple())
}

pub(super) fn encode_manifest_title_if_needed(files: &mut BTreeMap<String, Vec<u8>>, ty: NoteType, title: &str) -> Result<(), ApiError> {
    if let Some(existing) = files.get("manifest.json") {
        let updated = sync_manifest_title_raw(existing, ty, title)?;
        files.insert("manifest.json".to_string(), updated);
    }
    Ok(())
}

/// Identity of a note creator or editor.
#[derive(Clone, Debug)]
pub struct Maker {
    /// Channel, agent, or source identifier that initiated the write.
    pub from: String,
    /// Stable actor/author identifier (e.g. `"user"` or agent profile id).
    pub by: String,
    pub run: Option<String>,
}

/// Owns directory-backed notes, collaborative editing state, media library, and media jobs.
pub struct Manager {
    me: Weak<Self>,
    pub(crate) ctx: Arc<Context>,
    pub(crate) storage: Arc<Storage>,
    pub library: Arc<Library>,
    pub media: Arc<Media>,
    pub(super) changes: broadcast::Sender<(String, NoteEvent)>,
    pub(super) suggestion_events: broadcast::Sender<(String, SuggestionEvent)>,
    pub(super) presence_events: broadcast::Sender<(String, NotePresenceEvent)>,
    pub(super) presence_rooms: Mutex<HashMap<String, Arc<PresenceRoom>>>,
    pub(super) write_batcher: OriginWriteBatcher,
    doc_locks: vibevalley_kit::sync::KeyLock<String>,
}

impl Manager {
    pub async fn open_async(ctx: Arc<Context>, setting: Arc<Setting>, storage: Arc<Storage>) -> Result<Arc<Self>, ApiError> {
        let media = Media::open_async(ctx.clone(), setting, storage.clone()).await?;
        let library = Library::open(ctx.clone(), storage.clone(), Some(media.subscribe_job_updates()));
        let (changes, _) = broadcast::channel(512);
        let (suggestion_events, _) = broadcast::channel(512);
        let (presence_events, _) = broadcast::channel(512);
        Ok(Arc::new_cyclic(|me| Self {
            me: me.clone(),
            ctx,
            storage,
            library,
            media,
            changes,
            suggestion_events,
            presence_events,
            presence_rooms: Mutex::new(HashMap::new()),
            write_batcher: OriginWriteBatcher::default(),
            doc_locks: vibevalley_kit::sync::KeyLock::new(),
        }))
    }

    pub fn set_stream_batch_window(&self, window: Duration) {
        self.write_batcher.set_window(window);
    }

    pub fn close(&self) {
        self.library.close();
        self.media.close();
    }

    pub fn speech_streams(&self) -> SharedSpeechStreams {
        self.media.clone()
    }

    pub fn subscribe_media_announcements(&self) -> broadcast::Receiver<MediaAnnouncement> {
        self.media.subscribe_announcements()
    }

    pub async fn record_announced_message_async(&self, note_id: &str, version: Option<i64>, message_number: &str) {
        if version == Some(1)
            && let Err(err) = self.ctx.service.note.set_message_id(note_id, message_number).await
        {
            tracing::warn!(note_id = %note_id, message_id = %message_number, error = %err, "note.set_message_id backlink failed");
        }
        if let Some(v) = version
            && let Err(err) = self.ctx.service.note.set_version_message_id(note_id, v, message_number).await
        {
            tracing::warn!(
                note_id = %note_id,
                version = v,
                message_id = %message_number,
                error = %err,
                "note.set_version_message_id backlink failed"
            );
        }
    }

    pub fn say_for_note_event(key: &str, title: &str, note: &str) -> String {
        let base = t(key, &[("title", title.into())]);
        let trimmed = note.trim();
        if trimmed.is_empty() {
            base
        } else {
            t("server.note.withNote", &[("said", base.into()), ("note", trimmed.into())])
        }
    }

    pub(super) async fn note_lock(&self, id: &str) -> vibevalley_kit::sync::KeyLockGuard<'_, String> {
        self.doc_locks.lock(id.to_string()).await
    }

    pub(super) async fn row_async(&self, id: &str) -> Result<NoteRow, ApiError> {
        self.ctx
            .service
            .note
            .get(id)
            .await
            .map_err(q)?
            .ok_or_else(|| missing(t("server.note.missing", &[("id", id.into())]), LookIn::Note))
    }

    pub(super) fn actor_name(&self, by_id: &str) -> String {
        if is_user_actor(by_id) {
            return t("server.channel.name.user", &[]);
        }
        by_id.to_string()
    }

    async fn issue_id_for_ref_async(&self, issue_ref: &str) -> Result<String, ApiError> {
        let trimmed = issue_ref.trim();
        let num_str = trimmed.trim_start_matches('#');
        let issues = self.ctx.service.issue.all().await.map_err(q)?;
        if let Some(found) = issues.into_iter().find(|i| i.id == trimmed || i.number.to_string() == num_str) {
            return Ok(found.id);
        }
        Err(missing(t("server.issue.notFound", &[("id", trimmed.into())]), LookIn::Issue))
    }

    fn check_title(&self, title: &str) -> Result<String, ApiError> {
        let t_str = title.trim();
        if t_str.is_empty() {
            return Err(refused(t("server.note.noTitle", &[])));
        }
        if t_str.chars().count() > TITLE_MAX {
            return Err(refused(t("server.note.longTitle", &[("max", (TITLE_MAX as i64).into())])));
        }
        Ok(t_str.to_string())
    }

    pub(super) async fn sync_note_links_async(&self, note_id: &str, title: &str, ty: NoteType, files: &BTreeMap<String, Vec<u8>>, at: i64) {
        let links: Vec<NoteLinkRef> = match ty {
            NoteType::Doc => project_doc_view(note_id, title, files).extracted_links,
            NoteType::Base => {
                let mut acc = extract_base_links(files);
                for (path, bytes) in files {
                    if path != "structure/base.json"
                        && path.starts_with("structure/")
                        && (path.ends_with(".md") || path.ends_with(".txt") || path.ends_with(".json"))
                        && let Ok(text) = std::str::from_utf8(bytes)
                    {
                        acc.extend(extract_markdown_links(text));
                    }
                }
                dedup_links(acc)
            }
            NoteType::Canvas | NoteType::Media => {
                let mut acc = Vec::new();
                if ty == NoteType::Media
                    && let Some(bytes) = files.get("structure/media.json")
                    && let Ok(text) = std::str::from_utf8(bytes)
                {
                    let anns = extract_media_doc_annotations(text);
                    acc.extend(extract_annotation_links(&anns));
                }
                for (path, bytes) in files {
                    if path.starts_with("structure/")
                        && (path.ends_with(".md") || path.ends_with(".txt") || path.ends_with(".json"))
                        && let Ok(text) = std::str::from_utf8(bytes)
                    {
                        acc.extend(extract_markdown_links(text));
                    }
                }
                dedup_links(acc)
            }
        };
        if let Err(err) = self.ctx.service.note.replace_links_for_source(LinkEntityKind::Note, note_id, &links, at).await {
            tracing::warn!(note_id = %note_id, error = %err, "note.replace_links_for_source failed");
        }
        if ty == NoteType::Doc {
            self.sync_issue_body_description_async(note_id, files).await;
        }
    }

    async fn sync_issue_body_description_async(&self, note_id: &str, files: &BTreeMap<String, Vec<u8>>) {
        let Ok(Some(mut issue)) = self.ctx.service.issue.find_by_body_note_id(note_id).await else {
            return;
        };
        let Some(bytes) = files.get("structure/doc.json") else {
            return;
        };
        let Ok(raw) = std::str::from_utf8(bytes) else {
            return;
        };
        let Ok(doc) = parse_doc_document(raw) else {
            return;
        };
        let markdown = blocks_to_markdown(&doc.blocks);
        if issue.description == markdown {
            return;
        }
        issue.description = markdown;
        if let Err(err) = self.ctx.service.issue.put(&issue).await {
            tracing::warn!(issue_id = %issue.id, note_id = %note_id, error = %err, "sync_issue_body_description_async failed");
            return;
        }
        self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX);
    }

    async fn wire_of_async(&self, row: NoteRow, versions: Vec<VersionRow>) -> Result<Wire, ApiError> {
        let ty = note_type_of(&row.note_type)?;
        let preview = self.storage.note.preview_async(&row.id, ty, row.seq).await;
        let cover = self.storage.note.cover_async(&row.id).await;
        let msg_num = row.message_id.as_deref().and_then(|s| s.parse::<i64>().ok());
        let said = msg_num.and_then(|num| {
            row.channel_id.as_ref().map(|ch| NoteSaid {
                channel: ch.clone(),
                number: num,
            })
        });
        let channel = row.channel_id;
        let wire_versions = versions
            .into_iter()
            .map(|v| NoteVersion {
                version: v.version,
                size: v.size,
                note: v.note.unwrap_or_default(),
                by: v.by_id,
                by_name: v.by_name,
                at: v.created_at,
                channel: channel.clone().unwrap_or_default(),
                number: v.message_id.as_deref().and_then(|s| s.parse::<i64>().ok()),
            })
            .collect();
        Ok(Wire {
            id: row.id,
            title: row.title,
            note_type: ty,
            parent_id: row.parent_id,
            sort_order: row.sort_order,
            channel,
            said,
            issue: row.issue,
            by: row.by_id,
            by_name: row.by_name,
            version: row.version,
            seq: row.seq,
            versions: wire_versions,
            at: row.created_at,
            updated: row.updated_at,
            preview: Some(Box::new(preview)),
            cover: cover.map(Box::new),
        })
    }

    /// Saves a derived auto-captured cover image outside the note directory and CRDT
    /// without bumping `version` or `seq`.
    pub async fn set_cover_async(&self, req: &NoteCoverSetRequest) -> Result<NoteCover, ApiError> {
        let row = self.row_async(&req.id).await?;
        self.storage.note.write_cover_async(&row.id, req).await
    }

    pub async fn list_async(&self, req: &NoteListRequest) -> Result<Vec<Wire>, ApiError> {
        let rows = if let Some(ch) = req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            self.ctx.service.note.list_in_channel(ch).await.map_err(q)?
        } else if let Some(iss) = req.issue.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let issue_id = self.issue_id_for_ref_async(iss).await?;
            self.ctx.service.note.list_for_issue(&issue_id).await.map_err(q)?
        } else if let Some(pid) = req.parent_id.as_deref().map(str::trim) {
            self.ctx.service.note.list_children((!pid.is_empty()).then_some(pid)).await.map_err(q)?
        } else {
            self.ctx.service.note.list(LIST_LIMIT).await.map_err(q)?
        };
        let type_filter = req.note_type.map(|t| t.as_str());
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            if let Some(expected) = type_filter
                && row.note_type != expected
            {
                continue;
            }
            let versions = self.ctx.service.note.versions(&row.id).await.map_err(q)?;
            out.push(self.wire_of_async(row, versions).await?);
        }
        Ok(out)
    }

    pub async fn get_async(&self, id: &str) -> Result<Wire, ApiError> {
        let row = self.row_async(id).await?;
        let versions = self.ctx.service.note.versions(&row.id).await.map_err(q)?;
        self.wire_of_async(row, versions).await
    }

    pub async fn content_async(&self, id: &str, version: Option<i64>) -> Result<NoteContent, ApiError> {
        if version.is_none() {
            self.flush_pending_writes_async(id).await;
        }
        let row = self.row_async(id).await?;
        let ty = note_type_of(&row.note_type)?;
        let spec = type_spec(ty);
        let (target_version, storage_id) = match version {
            Some(ver) => {
                let v = self.ctx.service.note.version(&row.id, ver).await.map_err(q)?.ok_or_else(|| {
                    ApiError::new(
                        BizCode::NoteNotFound,
                        t(
                            "server.note.noVersion",
                            &[("title", row.title.as_str().into()), ("version", ver.into()), ("latest", row.version.into())],
                        ),
                    )
                })?;
                (v.version, Some(v.storage_id))
            }
            None => (row.version, None),
        };
        let file = self
            .storage
            .note
            .read_file_async(&row.id, &row.title, spec.entry_path, storage_id.as_deref())
            .await?;
        Ok(NoteContent {
            version: target_version,
            content: file.content,
        })
    }

    pub async fn create_async(&self, maker: &Maker, req: &NoteRequest) -> Result<Wire, ApiError> {
        let title = self.check_title(&req.title)?;
        let ty = req.note_type;

        let parent_id = match req.parent_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(pid) => {
                let _ = self.row_async(pid).await?;
                Some(pid.to_owned())
            }
            None => None,
        };
        let sort_order = req.sort_order.unwrap_or(0);

        let mut initial_files = req.files.clone().unwrap_or_default();
        if let Some(content) = &req.content {
            let entry = type_spec(ty).entry_path;
            if !initial_files.iter().any(|f| f.path == entry) {
                initial_files.push(NoteFileWriteItem {
                    path: entry.to_string(),
                    content: content.clone(),
                    encoding: Some(NoteFileEncoding::Utf8),
                    mime: Some(guess_mime(entry, content.as_bytes())),
                    expected_hash: None,
                });
            }
        }

        let channel_id = req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let issue = match req.issue.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(iss) => Some(self.issue_id_for_ref_async(iss).await?),
            None => None,
        };

        let id = new_id("note");
        let (metas, raw_files) = self.storage.note.init_directory_async(&id, ty, &title, None, &initial_files).await?;
        let (storage_id, size) = self.storage.note.snapshot_version_async(&id).await?;

        let at = self.ctx.now();
        let meta = commit_meta_for_maker(maker, req.note.clone().or_else(|| Some(format!("Create {title}"))), at);
        let doc = vibevalley_core::collab::CollabDoc::new();
        ingest_files_into_doc(&doc, &raw_files, &HashSet::new())?;
        let frontiers = doc
            .commit(&meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab commit: {e}")))?;
        let frontiers_b64 = encode_frontiers(&frontiers);
        let doc_bytes = export_doc_snapshot(&doc)?;

        let by_name = self.actor_name(&maker.by);
        let note = req.note.clone().filter(|s| !s.is_empty());
        let paths_list: Vec<String> = metas.iter().map(|m| m.path.clone()).collect();
        let new_row = NewNote {
            id: id.clone(),
            title: title.clone(),
            note_type: ty.as_str().to_string(),
            parent_id,
            sort_order,
            channel_id,
            issue,
            by_id: maker.by.clone(),
            by_name: by_name.clone(),
            version: 1,
            created_at: at,
        };
        let new_ver = NewVersion {
            note_id: id.clone(),
            version: 1,
            storage_id,
            size,
            note,
            by_id: maker.by.clone(),
            by_name,
            created_at: at,
        };

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let frontiers_b64_tx = frontiers_b64.clone();
        let paths_list_tx = paths_list.clone();
        let meta_author = meta.author.clone();
        if let Err(err) = svc
            .transaction::<_, DbError>(move |tx| {
                Box::pin(async move {
                    let note_id = new_row.id.clone();
                    svc_tx.note.add_in_tx(tx, new_row).await?;
                    svc_tx.note.add_version_in_tx(tx, new_ver).await?;
                    svc_tx.note.upsert_collab_snapshot_in_tx(tx, &note_id, &doc_bytes, at).await?;
                    svc_tx.note.set_seq_in_tx(tx, &note_id, 1, at).await?;
                    svc_tx
                        .note
                        .add_file_change_in_tx(tx, &note_id, 1, &meta_author, Some(&frontiers_b64_tx), &paths_list_tx, &[], at)
                        .await
                })
            })
            .await
            .map_err(q)
        {
            let _ = self.storage.note.delete_directory_async(&id).await;
            return Err(err);
        }

        self.sync_note_links_async(&id, &title, ty, &raw_files, at).await;

        self.get_async(&id).await
    }

    pub async fn version_async(&self, maker: &Maker, req: &NoteVersionRequest) -> Result<Wire, ApiError> {
        let meta = commit_meta_for_maker(maker, req.note.clone(), self.ctx.now());
        self.version_with_meta_async(maker, req, &meta).await
    }

    pub async fn version_with_meta_async(&self, maker: &Maker, req: &NoteVersionRequest, meta: &CommitMeta) -> Result<Wire, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        if let Some(content) = &req.content {
            let entry = type_spec(ty).entry_path;
            let write_req = NoteFileWriteRequest {
                id: row.id.clone(),
                files: vec![NoteFileWriteItem {
                    path: entry.to_string(),
                    content: content.clone(),
                    encoding: Some(NoteFileEncoding::Utf8),
                    mime: Some(guess_mime(entry, content.as_bytes())),
                    expected_hash: None,
                }],
                origin: Some(meta.origin.clone()),
                summary: req.note.clone(),
                announce: Some(false),
            };
            self.write_files_with_meta_async(maker, &write_req, meta).await?;
        }

        let _guard = self.note_lock(&req.id).await;
        let fresh = self.row_async(&req.id).await?;
        let next_ver = fresh.version + 1;
        let (storage_id, size) = self.storage.note.snapshot_version_async(&fresh.id).await?;
        let at = self.ctx.now();
        let by_name = self.actor_name(&maker.by);
        let note = req.note.clone().filter(|s| !s.is_empty());
        let ver = NewVersion {
            note_id: fresh.id.clone(),
            version: next_ver,
            storage_id,
            size,
            note,
            by_id: maker.by.clone(),
            by_name,
            created_at: at,
        };
        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                let note_id = ver.note_id.clone();
                svc_tx.note.add_version_in_tx(tx, ver).await?;
                svc_tx.note.set_version_in_tx(tx, &note_id, next_ver, at).await
            })
        })
        .await
        .map_err(q)?;

        self.get_async(&fresh.id).await
    }

    pub async fn update_async(&self, req: &NoteUpdateRequest) -> Result<Wire, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let _guard = self.note_lock(&req.id).await;

        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        let at = self.ctx.now();

        let new_title = match &req.title {
            Some(t) => Some(self.check_title(t)?),
            None => None,
        };
        let new_issue = match req.issue.as_deref().map(str::trim) {
            Some("") => Some(None),
            Some(iss) => Some(Some(self.issue_id_for_ref_async(iss).await?)),
            None => None,
        };
        let touch_tree = req.parent_id.is_some() || req.sort_order.is_some();
        let next_parent: Option<String> = match req.parent_id.as_deref().map(str::trim) {
            Some("") => None,
            Some(pid) => Some(pid.to_owned()),
            None => row.parent_id.clone(),
        };
        let next_sort = req.sort_order.unwrap_or(row.sort_order);

        let target_title = new_title.as_deref().unwrap_or(&row.title);
        if new_title.is_some() {
            self.storage.note.sync_manifest_title_async(&row.id, ty, target_title).await?;
        }

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let id_tx = row.id.clone();
        let new_title_tx = new_title.clone();
        let new_issue_tx = new_issue;
        svc.transaction::<_, ApiError>(move |tx| {
            Box::pin(async move {
                if let Some(t) = new_title_tx {
                    svc_tx.note.rename_in_tx(tx, &id_tx, &t, at).await?;
                }
                if touch_tree && let Err(msg) = svc_tx.note.set_parent_order_in_tx(tx, &id_tx, next_parent.as_deref(), next_sort, at).await? {
                    return Err(refused(msg));
                }
                if let Some(issue_opt) = new_issue_tx {
                    svc_tx.note.set_issue_in_tx(tx, &id_tx, issue_opt.as_deref(), at).await?;
                }
                Ok(())
            })
        })
        .await?;

        if new_title.is_some() {
            let meta = self.storage.note.list_files_async(&row.id, Some("manifest.json")).await?;
            let seq = self.row_async(&row.id).await?.seq;
            self.emit_change(
                &row.id,
                NoteEvent::Files {
                    seq,
                    files: meta,
                    deleted: vec![],
                    origin: Some(NOTE_USER_ORIGIN.into()),
                    frontiers: None,
                },
            );
        }
        self.get_async(&row.id).await
    }

    pub async fn move_tree_async(&self, req: &NoteTreeMoveRequest) -> Result<Wire, ApiError> {
        let row = self.row_async(&req.id).await?;
        let at = self.ctx.now();
        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let id = row.id.clone();
        let parent_id = req.parent_id.clone().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        let sort_order = req.sort_order;
        svc.transaction::<_, ApiError>(move |tx| {
            Box::pin(async move {
                match svc_tx.note.set_parent_order_in_tx(tx, &id, parent_id.as_deref(), sort_order, at).await? {
                    Ok(()) => Ok(()),
                    Err(msg) => Err(refused(msg)),
                }
            })
        })
        .await?;
        self.get_async(&req.id).await
    }

    pub async fn list_links_async(&self, req: &NoteLinkListRequest) -> Result<NoteLinkListResult, ApiError> {
        self.ctx
            .service
            .note
            .list_links_for_entity(req.entity_kind, req.entity_id.trim())
            .await
            .map_err(q)
    }

    pub async fn remove_async(&self, id: &str) -> Result<(), ApiError> {
        self.flush_pending_writes_async(id).await;
        let _guard = self.note_lock(id).await;
        let _ = self.row_async(id).await?;
        self.ctx.service.note.delete(id).await.map_err(q)?;
        self.storage.note.delete_directory_async(id).await?;
        self.presence_rooms.lock().remove(id);
        Ok(())
    }

    pub async fn preview_remove_async(&self, id: &str) -> Result<Preview, ApiError> {
        let row = self.row_async(id).await?;
        let versions = self.ctx.service.note.versions(&row.id).await.map_err(q)?;
        let n = versions.len();
        let mut does = vec![t("server.note.preview.remove", &[("title", row.title.as_str().into()), ("n", n.into())])];
        if row.message_id.is_some() {
            does.push(t("server.note.preview.cards", &[]));
        }
        Ok(Preview { does })
    }

    pub async fn list_files_async(&self, req: &NoteFileListRequest) -> Result<NoteFileListResult, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let row = self.row_async(&req.id).await?;
        let files = self.storage.note.list_files_async(&row.id, req.prefix.as_deref()).await?;
        Ok(NoteFileListResult {
            note_id: row.id,
            seq: row.seq,
            files,
        })
    }

    pub async fn get_file_async(&self, req: &NoteFileGetRequest) -> Result<NoteFileContent, ApiError> {
        if req.version.is_none() {
            self.flush_pending_writes_async(&req.id).await;
        }
        let row = self.row_async(&req.id).await?;
        let storage_id = match req.version {
            Some(ver) => {
                let v = self.ctx.service.note.version(&row.id, ver).await.map_err(q)?.ok_or_else(|| {
                    ApiError::new(
                        BizCode::NoteNotFound,
                        t(
                            "server.note.noVersion",
                            &[("title", row.title.as_str().into()), ("version", ver.into()), ("latest", row.version.into())],
                        ),
                    )
                })?;
                Some(v.storage_id)
            }
            None => None,
        };
        self.storage.note.read_file_async(&row.id, &row.title, &req.path, storage_id.as_deref()).await
    }

    pub async fn write_files_with_meta_async(&self, maker: &Maker, req: &NoteFileWriteRequest, meta: &CommitMeta) -> Result<NoteFileWriteResult, ApiError> {
        if req.files.is_empty() {
            return Err(refused("No files supplied"));
        }

        let mut normalized_items = Vec::with_capacity(req.files.len());
        for item in &req.files {
            validate_note_path(&item.path).map_err(refused)?;
            let mut normalized = item.clone();
            normalized.path = item.path.trim().to_string();
            normalized_items.push(normalized);
        }

        let mut effective_meta = meta.clone();
        apply_origin_override(&mut effective_meta, req.origin.as_deref());
        if req.summary.is_some() {
            effective_meta.summary = req.summary.clone();
        }

        let batchable = req.files.iter().all(|f| f.expected_hash.is_none()) && !req.announce.unwrap_or(false);
        let window = self.write_batcher.window();
        let key = BatchKey {
            note_id: req.id.clone(),
            origin: effective_meta.origin.clone(),
        };

        if batchable
            && !window.is_zero()
            && let Some(this) = self.me.upgrade()
        {
            let (rx, is_new, hit_cap) = self.write_batcher.enqueue(key.clone(), maker.clone(), effective_meta, normalized_items);
            if hit_cap {
                this.flush_batch_bucket_async(&key).await;
            } else if is_new {
                this.spawn_batch_flush_timer(key, window);
            }
            return rx
                .await
                .unwrap_or_else(|_| Err(ApiError::new(BizCode::ServiceUnavailable, "note batch cancelled")));
        }

        self.flush_batch_bucket_async(&key).await;
        let normalized_req = NoteFileWriteRequest {
            id: req.id.clone(),
            files: normalized_items,
            origin: Some(effective_meta.origin.clone()),
            summary: effective_meta.summary.clone(),
            announce: req.announce,
        };
        self.execute_write_files_now_async(maker, &normalized_req, &effective_meta).await
    }

    pub(super) async fn execute_write_files_now_async(
        &self,
        maker: &Maker,
        req: &NoteFileWriteRequest,
        meta: &CommitMeta,
    ) -> Result<NoteFileWriteResult, ApiError> {
        let _guard = self.note_lock(&req.id).await;

        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        if req.files.is_empty() {
            return Err(refused("No files supplied"));
        }

        let mut normalized_items = Vec::with_capacity(req.files.len());
        for item in &req.files {
            validate_note_path(&item.path).map_err(refused)?;
            let mut normalized = item.clone();
            normalized.path = item.path.trim().to_string();
            normalized_items.push(normalized);
        }

        let disk_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
        let human_touched = self.human_touched_paths_async(&row.id).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let at = self.ctx.now();

        let is_agent = !is_user_actor(&maker.by) && !req.origin.as_deref().is_some_and(is_user_actor);
        let mut direct_items = Vec::new();
        let mut diverted_suggestions = Vec::new();

        for item in normalized_items {
            if is_agent && human_touched.contains(&item.path) && item.encoding != Some(NoteFileEncoding::Base64) {
                let current_hash = disk_files.get(&item.path).map(|b| sha256_hex_bytes(b));
                let sug = Suggestion {
                    id: new_id("sug"),
                    note_id: row.id.clone(),
                    path: item.path.clone(),
                    author: maker.by.clone(),
                    base_rev: row.seq,
                    base_hash: current_hash,
                    change: SuggestionChange {
                        content: Some(item.content.clone()),
                        patch: None,
                        target: None,
                        delete: None,
                        summary: req.summary.clone().or_else(|| meta.summary.clone()),
                    },
                    status: vibevalley_protocol::SuggestionStatus::Open,
                    created_at: at,
                    resolved_at: None,
                    resolved_by: None,
                    cursor_start: None,
                    cursor_end: None,
                    start_offset: None,
                    end_offset: None,
                };
                self.ctx
                    .service
                    .note
                    .add_suggestion(&StoredSuggestion {
                        wire: sug.clone(),
                        origin: Some(meta.origin.clone()),
                    })
                    .await
                    .map_err(q)?;
                diverted_suggestions.push(sug);
            } else {
                direct_items.push(item);
            }
        }

        if !diverted_suggestions.is_empty() {
            let all = self
                .ctx
                .service
                .note
                .stored_suggestions(&row.id, 1000)
                .await
                .map_err(q)?
                .into_iter()
                .map(|s| s.wire)
                .collect();
            self.emit_suggestions(&row.id, all);
        }

        if direct_items.is_empty() {
            return Ok(NoteFileWriteResult {
                note_id: row.id,
                seq: row.seq,
                files: vec![],
                frontiers: None,
                suggestions: if diverted_suggestions.is_empty() { None } else { Some(diverted_suggestions) },
            });
        }

        let written_metas = self.storage.note.write_files_async(&row.id, ty, &row.title, &direct_items).await?;

        let fresh_disk = self.storage.note.read_all_raw_async(&row.id, None).await?;
        for m in &written_metas {
            if let Some(bytes) = fresh_disk.get(&m.path) {
                upsert_file_for_write(&doc, &m.path, &m.mime, bytes)?;
            }
        }

        let mut effective_meta = meta.clone();
        apply_origin_override(&mut effective_meta, req.origin.as_deref());
        if req.summary.is_some() {
            effective_meta.summary = req.summary.clone();
        }
        let frontiers = doc
            .commit(&effective_meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab commit: {e}")))?;
        let frontiers_b64 = encode_frontiers(&frontiers);
        let doc_bytes = export_doc_snapshot(&doc)?;
        let new_seq = row.seq + 1;
        let written_paths: Vec<String> = written_metas.iter().map(|m| m.path.clone()).collect();

        let mut updated_title = row.title.clone();
        if written_paths.iter().any(|p| p == "manifest.json")
            && let Some(m_bytes) = fresh_disk.get("manifest.json")
            && let Ok(m_str) = std::str::from_utf8(m_bytes)
            && let Ok(manifest) = vibevalley_core::note::parse_manifest(m_str)
            && !manifest.title.trim().is_empty()
        {
            updated_title = manifest.title.trim().to_string();
        }

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let id_tx = row.id.clone();
        let frontiers_b64_tx = frontiers_b64.clone();
        let written_paths_tx = written_paths.clone();
        let actor = effective_meta.author.clone();
        let updated_title_tx = updated_title.clone();
        let old_title = row.title.clone();
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                svc_tx.note.upsert_collab_snapshot_in_tx(tx, &id_tx, &doc_bytes, at).await?;
                if updated_title_tx != old_title {
                    svc_tx.note.rename_in_tx(tx, &id_tx, &updated_title_tx, at).await?;
                }
                svc_tx.note.set_seq_in_tx(tx, &id_tx, new_seq, at).await?;
                svc_tx
                    .note
                    .add_file_change_in_tx(tx, &id_tx, new_seq, &actor, Some(&frontiers_b64_tx), &written_paths_tx, &[], at)
                    .await
            })
        })
        .await
        .map_err(q)?;

        self.sync_note_links_async(&row.id, &updated_title, ty, &fresh_disk, at).await;

        self.emit_change(
            &row.id,
            NoteEvent::Files {
                seq: new_seq,
                files: written_metas.clone(),
                deleted: vec![],
                origin: Some(effective_meta.origin),
                frontiers: Some(frontiers_b64.clone()),
            },
        );

        Ok(NoteFileWriteResult {
            note_id: row.id,
            seq: new_seq,
            files: written_metas,
            frontiers: Some(frontiers_b64),
            suggestions: if diverted_suggestions.is_empty() { None } else { Some(diverted_suggestions) },
        })
    }

    pub async fn delete_file_with_meta_async(&self, _maker: &Maker, req: &NoteFileDeleteRequest, meta: &CommitMeta) -> Result<NoteFileDeleteResult, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let _guard = self.note_lock(&req.id).await;

        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        validate_deletable_path(&req.path).map_err(refused)?;
        let path = req.path.trim().to_string();
        let disk_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;

        self.storage.note.delete_file_async(&row.id, ty, &row.title, &path).await?;
        let _ = doc.entry_delete(&path);
        let mut effective_meta = meta.clone();
        apply_origin_override(&mut effective_meta, req.origin.as_deref());
        if req.summary.is_some() {
            effective_meta.summary = req.summary.clone();
        }
        let frontiers = doc
            .commit(&effective_meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab commit: {e}")))?;
        let frontiers_b64 = encode_frontiers(&frontiers);
        let doc_bytes = export_doc_snapshot(&doc)?;
        let new_seq = row.seq + 1;
        let at = self.ctx.now();

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let id_tx = row.id.clone();
        let frontiers_b64_tx = frontiers_b64.clone();
        let actor = effective_meta.author.clone();
        let deleted = vec![path.clone()];
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                svc_tx.note.upsert_collab_snapshot_in_tx(tx, &id_tx, &doc_bytes, at).await?;
                svc_tx.note.set_seq_in_tx(tx, &id_tx, new_seq, at).await?;
                svc_tx
                    .note
                    .add_file_change_in_tx(tx, &id_tx, new_seq, &actor, Some(&frontiers_b64_tx), &[], &deleted, at)
                    .await
            })
        })
        .await
        .map_err(q)?;

        let fresh_disk = self.storage.note.read_all_raw_async(&row.id, None).await?;
        self.sync_note_links_async(&row.id, &row.title, ty, &fresh_disk, at).await;

        self.emit_change(
            &row.id,
            NoteEvent::Files {
                seq: new_seq,
                files: vec![],
                deleted: vec![path.clone()],
                origin: Some(effective_meta.origin),
                frontiers: Some(frontiers_b64.clone()),
            },
        );

        Ok(NoteFileDeleteResult {
            note_id: row.id,
            seq: new_seq,
            path,
            frontiers: Some(frontiers_b64),
        })
    }

    // --- Thin caller-context entrypoints keeping router.rs & glue.rs compact ---

    pub(crate) async fn create_for_caller_async(&self, ctx: &CallerContext, req: &NoteRequest) -> Result<Wire, ApiError> {
        self.create_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn version_for_caller_async(&self, ctx: &CallerContext, req: &NoteVersionRequest) -> Result<Wire, ApiError> {
        let (m, _, t) = self.caller_meta(ctx);
        self.version_with_meta_async(&m, req, &t).await
    }

    pub(crate) async fn write_for_caller_async(&self, ctx: &CallerContext, req: &NoteFileWriteRequest) -> Result<NoteFileWriteResult, ApiError> {
        let (m, _, t) = self.caller_meta(ctx);
        self.write_files_with_meta_async(&m, req, &t).await
    }

    pub(crate) async fn delete_file_for_caller_async(&self, ctx: &CallerContext, req: &NoteFileDeleteRequest) -> Result<NoteFileDeleteResult, ApiError> {
        let (m, _, t) = self.caller_meta(ctx);
        self.delete_file_with_meta_async(&m, req, &t).await
    }

    pub(crate) async fn create_suggestion_for_caller_async(&self, ctx: &CallerContext, req: &NoteSuggestionCreateInput) -> Result<Suggestion, ApiError> {
        self.create_suggestion_async(&self.caller_meta(ctx).1, req).await
    }

    pub(crate) async fn accept_suggestion_for_caller_async(&self, ctx: &CallerContext, req: &NoteSuggestionAcceptInput) -> Result<Suggestion, ApiError> {
        self.accept_suggestion_async(&self.caller_meta(ctx).1, req).await
    }

    pub(crate) async fn reject_suggestion_for_caller_async(&self, ctx: &CallerContext, req: &NoteSuggestionAcceptInput) -> Result<Suggestion, ApiError> {
        self.reject_suggestion_async(&self.caller_meta(ctx).1, &req.id, &req.suggestion).await
    }

    pub(crate) async fn history_restore_for_caller_async(&self, ctx: &CallerContext, req: &NoteHistoryRestoreRequest) -> Result<Wire, ApiError> {
        self.history_restore_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn history_fork_for_caller_async(&self, ctx: &CallerContext, req: &NoteHistoryForkRequest) -> Result<Wire, ApiError> {
        self.history_fork_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn history_undo_origin_for_caller_async(&self, ctx: &CallerContext, req: &NoteHistoryUndoOriginRequest) -> Result<Wire, ApiError> {
        self.history_undo_origin_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn collab_import_for_caller_async(&self, ctx: &CallerContext, req: &NoteCollabImportRequest) -> Result<NoteCollabImportResult, ApiError> {
        self.collab_import_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn doc_append_block_for_caller_async(
        &self,
        ctx: &CallerContext,
        req: &NoteDocAppendBlockRequest,
    ) -> Result<vibevalley_protocol::DocView, ApiError> {
        self.doc_append_block_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn base_upsert_row_for_caller_async(
        &self,
        ctx: &CallerContext,
        req: &vibevalley_protocol::BaseUpsertRowRequest,
    ) -> Result<vibevalley_protocol::BaseViewSnapshot, ApiError> {
        self.base_upsert_row_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn annotation_upsert_for_caller_async(
        &self,
        ctx: &CallerContext,
        req: &vibevalley_protocol::NoteAnnotationUpsertRequest,
    ) -> Result<vibevalley_protocol::NoteAnnotationMutationResult, ApiError> {
        self.annotation_upsert_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn annotation_delete_for_caller_async(
        &self,
        ctx: &CallerContext,
        req: &vibevalley_protocol::NoteAnnotationDeleteRequest,
    ) -> Result<vibevalley_protocol::NoteAnnotationMutationResult, ApiError> {
        self.annotation_delete_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn base_sync_review_for_caller_async(
        &self,
        ctx: &CallerContext,
        req: &vibevalley_protocol::NoteReviewSyncRequest,
    ) -> Result<vibevalley_protocol::NoteReviewSyncResult, ApiError> {
        self.base_sync_review_async(&self.caller_meta(ctx).0, req).await
    }

    pub(crate) async fn added_by_for_caller_async(&self, caller: &CallerContext) -> AddedBy {
        match caller.caller {
            Caller::User | Caller::Remote => AddedBy::User,
            Caller::Orchestrator => AddedBy::Agent {
                agent: caller.client.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                session: None,
                dir: None,
            },
            Caller::Session => {
                let sid = caller.client.as_ref().map(|c| c.id.clone()).unwrap_or_default();
                let (agent, dir) = self
                    .ctx
                    .service
                    .session
                    .get(&sid)
                    .await
                    .ok()
                    .flatten()
                    .map(|h| (h.profile.unwrap_or_default(), h.cwd.map(PathBuf::from)))
                    .unwrap_or_default();
                AddedBy::Agent {
                    agent,
                    session: (!sid.is_empty()).then_some(sid),
                    dir,
                }
            }
        }
    }

    pub(crate) fn caller_meta(&self, caller: &CallerContext) -> (Maker, String, CommitMeta) {
        let (maker, actor, meta_summary) = caller_identity(caller);
        let at = self.ctx.now();
        let mut commit_meta = commit_meta_for_maker(&maker, meta_summary, at);
        if matches!(caller.caller, Caller::Session)
            && let Some(client) = caller.client.as_ref()
        {
            commit_meta = CommitMeta::session(&actor, &actor, &client.id, 1, None, at);
        }
        (maker, actor, commit_meta)
    }
}

fn apply_origin_override(meta: &mut CommitMeta, raw_origin: Option<&str>) {
    let Some(origin) = raw_origin.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    meta.origin = origin.to_string();
    if let Some(actor) = origin.strip_prefix("agent:").map(str::trim).filter(|s| !s.is_empty()) {
        meta.author = actor.to_string();
        meta.agent = Some(actor.to_string());
    } else if is_user_actor(origin) {
        meta.author = NOTE_USER_ORIGIN.to_string();
        meta.agent = None;
    }
}

fn caller_identity(caller: &CallerContext) -> (Maker, String, Option<String>) {
    match caller.caller {
        Caller::Session => {
            let sid = caller
                .client
                .as_ref()
                .map(|c| c.id.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "session".to_string());
            (
                Maker {
                    from: sid.clone(),
                    by: sid.clone(),
                    run: None,
                },
                sid,
                None,
            )
        }
        Caller::Orchestrator => {
            let aid = caller
                .client
                .as_ref()
                .map(|c| c.id.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "orchestrator".to_string());
            (
                Maker {
                    from: aid.clone(),
                    by: aid.clone(),
                    run: None,
                },
                aid,
                None,
            )
        }
        Caller::User | Caller::Remote => (
            Maker {
                from: NOTE_USER_ORIGIN.into(),
                by: NOTE_USER_ORIGIN.into(),
                run: None,
            },
            NOTE_USER_ORIGIN.into(),
            None,
        ),
    }
}
