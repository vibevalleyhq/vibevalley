//! Unified directory-backed artifact [`Manager`] and [`Maker`] identity.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use vibevalley_core::artifact::{type_spec, validate_artifact_path, validate_deletable_path};
use vibevalley_core::collab::{CommitMeta, encode_frontiers};
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    ApiError, Artifact as Wire, ArtifactCard, ArtifactContent, ArtifactCover, ArtifactCoverSetRequest, ArtifactEvent, ArtifactFileContent,
    ArtifactFileDeleteRequest, ArtifactFileDeleteResult, ArtifactFileEncoding, ArtifactFileGetRequest, ArtifactFileListRequest, ArtifactFileListResult,
    ArtifactFileWriteItem, ArtifactFileWriteRequest, ArtifactFileWriteResult, ArtifactListRequest, ArtifactPresenceEvent, ArtifactRequest, ArtifactSaid,
    ArtifactType, ArtifactUpdateRequest, ArtifactVersion, ArtifactVersionRequest, BizCode, Caller, ChatMessage, Preview, Suggestion, SuggestionChange,
    SuggestionEvent, USER_ID,
};

use super::collab::{
    PresenceRoom, commit_meta_for_maker, export_doc_snapshot, guess_mime, ingest_files_into_doc, sha256_hex_bytes, sync_manifest_title_raw,
    upsert_file_for_write,
};
use super::library::{AddedBy, Library};
use super::media::Media;
use crate::context::api::{CallerContext, media::SharedSpeechStreams};
use crate::context::port::ChannelAnnounce;
use crate::context::{Context, LookIn, missing};
use crate::service::DbError;
use crate::service::artifact::{ArtifactRow, NewArtifact, NewVersion, StoredSuggestion, VersionRow};
use crate::setting::Setting;
use crate::storage::Storage;

const TITLE_MAX: usize = 200;
const LIST_LIMIT: i64 = 500;

pub(super) fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::ArtifactRefused, text.into())
}

pub(super) fn q(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("artifact: {e}"))
}

pub(super) fn artifact_type_of(raw: &str) -> Result<ArtifactType, ApiError> {
    ArtifactType::parse(raw).ok_or_else(|| {
        let allowed_vec: Vec<String> = ArtifactType::ALL.into_iter().map(|t| t.as_str().to_string()).collect();
        let allowed = list(&allowed_vec);
        refused(t("server.artifact.badKind", &[("kind", raw.into()), ("kinds", allowed.into())]))
    })
}

pub(super) fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::now_v7().simple())
}

pub(super) fn encode_manifest_title_if_needed(files: &mut BTreeMap<String, Vec<u8>>, ty: ArtifactType, title: &str) -> Result<(), ApiError> {
    if let Some(existing) = files.get("manifest.json") {
        let updated = sync_manifest_title_raw(existing, ty, title)?;
        files.insert("manifest.json".to_string(), updated);
    }
    Ok(())
}

/// Identity of an artifact creator or editor.
#[derive(Clone, Debug)]
pub struct Maker {
    /// Channel, agent, or source identifier that initiated the write.
    pub from: String,
    /// Stable actor/author identifier (e.g. `"user"` or agent profile id).
    pub by: String,
    pub run: Option<String>,
}

/// Owns directory-backed artifacts, collaborative editing state, media library, and media jobs.
pub struct Manager {
    pub(crate) ctx: Arc<Context>,
    pub(crate) storage: Arc<Storage>,
    pub library: Arc<Library>,
    pub media: Arc<Media>,
    announce: Arc<dyn ChannelAnnounce>,
    pub(super) changes: broadcast::Sender<(String, ArtifactEvent)>,
    pub(super) suggestion_events: broadcast::Sender<(String, SuggestionEvent)>,
    pub(super) presence_events: broadcast::Sender<(String, ArtifactPresenceEvent)>,
    pub(super) presence_rooms: Mutex<HashMap<String, Arc<PresenceRoom>>>,
    doc_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Manager {
    pub async fn open_async(
        ctx: Arc<Context>,
        setting: Arc<Setting>,
        storage: Arc<Storage>,
        announce: Arc<dyn ChannelAnnounce>,
        chat_messages: Option<broadcast::Receiver<ChatMessage>>,
    ) -> Result<Arc<Self>, ApiError> {
        let media = Media::open_async(ctx.clone(), setting, storage.clone(), announce.clone()).await?;
        let library = Library::open(ctx.clone(), storage.clone(), chat_messages, Some(media.subscribe_job_updates()));
        let (changes, _) = broadcast::channel(512);
        let (suggestion_events, _) = broadcast::channel(512);
        let (presence_events, _) = broadcast::channel(512);
        Ok(Arc::new(Self {
            ctx,
            storage,
            library,
            media,
            announce,
            changes,
            suggestion_events,
            presence_events,
            presence_rooms: Mutex::new(HashMap::new()),
            doc_locks: Mutex::new(HashMap::new()),
        }))
    }

    pub fn close(&self) {
        self.library.close();
        self.media.close();
    }

    pub fn speech_streams(&self) -> SharedSpeechStreams {
        self.media.clone()
    }

    pub(super) fn artifact_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.doc_locks.lock();
        map.entry(id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    pub(super) async fn row_async(&self, id: &str) -> Result<ArtifactRow, ApiError> {
        self.ctx
            .service
            .artifact
            .get(id)
            .await
            .map_err(q)?
            .ok_or_else(|| missing(t("server.artifact.missing", &[("id", id.into())]), LookIn::Artifact))
    }

    pub(super) fn actor_name(&self, by_id: &str) -> String {
        if by_id == USER_ID {
            return t("server.channel.name.user", &[]);
        }
        by_id.to_string()
    }

    pub(super) async fn resolve_channel_async(&self, who: &str, name: &str) -> Result<String, ApiError> {
        self.announce.place_of_async(who, name.trim()).await
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
            return Err(refused(t("server.artifact.noTitle", &[])));
        }
        if t_str.chars().count() > TITLE_MAX {
            return Err(refused(t("server.artifact.longTitle", &[("max", (TITLE_MAX as i64).into())])));
        }
        Ok(t_str.to_string())
    }

    async fn wire_of_async(&self, row: ArtifactRow, versions: Vec<VersionRow>) -> Result<Wire, ApiError> {
        let ty = artifact_type_of(&row.artifact_type)?;
        let preview = self.storage.artifact.preview_async(&row.id, ty, row.seq).await;
        let cover = self.storage.artifact.cover_async(&row.id).await;
        let msg_num = row.message_id.as_deref().and_then(|s| s.parse::<i64>().ok());
        let said = msg_num.and_then(|num| {
            row.channel_id.as_ref().map(|ch| ArtifactSaid {
                channel: ch.clone(),
                number: num,
            })
        });
        let channel = row.channel_id;
        let wire_versions = versions
            .into_iter()
            .map(|v| ArtifactVersion {
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
            artifact_type: ty,
            is_default: row.is_default,
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

    /// Saves a derived auto-captured cover image outside the artifact directory and CRDT
    /// without bumping `version` or `seq`.
    pub async fn set_cover_async(&self, req: &ArtifactCoverSetRequest) -> Result<ArtifactCover, ApiError> {
        let row = self.row_async(&req.id).await?;
        self.storage.artifact.write_cover_async(&row.id, req).await
    }

    async fn announce_card_async(&self, channel_id: Option<&str>, maker: &Maker, say: String, card: ArtifactCard, send_key: String) -> Option<ArtifactSaid> {
        let ch = channel_id?;
        let msg = self
            .announce
            .post_card_async(&maker.from, ch, &say, card, maker.run.clone(), send_key)
            .await
            .ok()?;
        Some(ArtifactSaid {
            channel: msg.channel,
            number: msg.number,
        })
    }

    pub async fn list_async(&self, req: &ArtifactListRequest) -> Result<Vec<Wire>, ApiError> {
        let rows = if let Some(ch) = req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let channel_id = self.resolve_channel_async(USER_ID, ch).await?;
            self.ctx.service.artifact.list_in_channel(&channel_id).await.map_err(q)?
        } else if let Some(iss) = req.issue.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let issue_id = self.issue_id_for_ref_async(iss).await?;
            self.ctx.service.artifact.list_for_issue(&issue_id).await.map_err(q)?
        } else {
            self.ctx.service.artifact.list(LIST_LIMIT).await.map_err(q)?
        };
        let type_filter = req.artifact_type.map(|t| t.as_str());
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            if let Some(expected) = type_filter
                && row.artifact_type != expected
            {
                continue;
            }
            let versions = self.ctx.service.artifact.versions(&row.id).await.map_err(q)?;
            out.push(self.wire_of_async(row, versions).await?);
        }
        Ok(out)
    }

    pub async fn get_async(&self, id: &str) -> Result<Wire, ApiError> {
        let row = self.row_async(id).await?;
        let versions = self.ctx.service.artifact.versions(&row.id).await.map_err(q)?;
        self.wire_of_async(row, versions).await
    }

    pub async fn content_async(&self, id: &str, version: Option<i64>) -> Result<ArtifactContent, ApiError> {
        let row = self.row_async(id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        let spec = type_spec(ty);
        let (target_version, storage_id) = match version {
            Some(ver) => {
                let v = self.ctx.service.artifact.version(&row.id, ver).await.map_err(q)?.ok_or_else(|| {
                    ApiError::new(
                        BizCode::ArtifactNotFound,
                        t(
                            "server.artifact.noVersion",
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
            .artifact
            .read_file_async(&row.id, &row.title, spec.entry_path, storage_id.as_deref())
            .await?;
        Ok(ArtifactContent {
            version: target_version,
            content: file.content,
        })
    }

    pub async fn create_async(&self, maker: &Maker, req: &ArtifactRequest) -> Result<Wire, ApiError> {
        let title = self.check_title(&req.title)?;
        let ty = req.artifact_type;
        let is_default = req.is_default.unwrap_or(false);
        if is_default && ty != ArtifactType::DesignSystem {
            return Err(refused(t("server.artifact.defaultDesignSystemOnly", &[])));
        }

        let mut initial_files = req.files.clone().unwrap_or_default();
        if let Some(content) = &req.content {
            let entry = type_spec(ty).entry_path;
            if !initial_files.iter().any(|f| f.path == entry) {
                initial_files.push(ArtifactFileWriteItem {
                    path: entry.to_string(),
                    content: content.clone(),
                    encoding: Some(ArtifactFileEncoding::Utf8),
                    mime: Some(guess_mime(entry, content.as_bytes())),
                    expected_hash: None,
                });
            }
        }

        let default_ds = if ty != ArtifactType::DesignSystem {
            self.ctx.service.artifact.default_design_system().await.map_err(q)?.map(|r| r.id)
        } else {
            None
        };
        let channel_id = match req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(ch) => Some(self.resolve_channel_async(&maker.from, ch).await?),
            None => None,
        };
        let issue = match req.issue.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(iss) => Some(self.issue_id_for_ref_async(iss).await?),
            None => None,
        };

        let id = new_id("art");
        let (metas, raw_files) = self
            .storage
            .artifact
            .init_directory_async(&id, ty, &title, None, &initial_files, default_ds.as_deref())
            .await?;
        let (storage_id, size) = self.storage.artifact.snapshot_version_async(&id).await?;

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
        let note = req.note.clone().unwrap_or_default();
        let paths_list: Vec<String> = metas.iter().map(|m| m.path.clone()).collect();
        let new_row = NewArtifact {
            id: id.clone(),
            title: title.clone(),
            artifact_type: ty.as_str().to_string(),
            is_default,
            channel_id: channel_id.clone(),
            issue,
            by_id: maker.by.clone(),
            by_name: by_name.clone(),
            version: 1,
            created_at: at,
        };
        let new_ver = NewVersion {
            artifact_id: id.clone(),
            version: 1,
            storage_id,
            size,
            note: Some(note.clone()).filter(|s| !s.is_empty()),
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
                    let art_id = new_row.id.clone();
                    if new_row.is_default {
                        svc_tx.artifact.clear_default_design_system_in_tx(tx, at).await?;
                    }
                    svc_tx.artifact.add_in_tx(tx, new_row).await?;
                    svc_tx.artifact.add_version_in_tx(tx, new_ver).await?;
                    svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &art_id, &doc_bytes, at).await?;
                    svc_tx.artifact.set_seq_in_tx(tx, &art_id, 1, at).await?;
                    svc_tx
                        .artifact
                        .add_file_change_in_tx(tx, &art_id, 1, &meta_author, Some(&frontiers_b64_tx), &paths_list_tx, &[], at)
                        .await
                })
            })
            .await
            .map_err(q)
        {
            let _ = self.storage.artifact.delete_directory_async(&id).await;
            return Err(err);
        }

        if req.announce.unwrap_or(true)
            && let Some(said) = self
                .announce_card_async(
                    channel_id.as_deref(),
                    maker,
                    say_of("server.artifact.made", &title, &note),
                    ArtifactCard {
                        id: id.clone(),
                        title: title.clone(),
                        artifact_type: ty,
                        version: 1,
                        note,
                    },
                    format!("art:{id}:v1"),
                )
                .await
        {
            let num_str = said.number.to_string();
            if let Err(err) = self.ctx.service.artifact.set_message_id(&id, &num_str).await {
                tracing::warn!(artifact_id = %id, message_id = %num_str, error = %err, "artifact.set_message_id backlink failed");
            }
            if let Err(err) = self.ctx.service.artifact.set_version_message_id(&id, 1, &num_str).await {
                tracing::warn!(artifact_id = %id, version = 1, message_id = %num_str, error = %err, "artifact.set_version_message_id backlink failed");
            }
        }

        self.get_async(&id).await
    }

    pub async fn version_async(&self, maker: &Maker, req: &ArtifactVersionRequest) -> Result<Wire, ApiError> {
        let meta = commit_meta_for_maker(maker, req.note.clone(), self.ctx.now());
        self.version_with_meta_async(maker, req, &meta).await
    }

    pub async fn version_with_meta_async(&self, maker: &Maker, req: &ArtifactVersionRequest, meta: &CommitMeta) -> Result<Wire, ApiError> {
        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        if let Some(content) = &req.content {
            let entry = type_spec(ty).entry_path;
            let write_req = ArtifactFileWriteRequest {
                id: row.id.clone(),
                files: vec![ArtifactFileWriteItem {
                    path: entry.to_string(),
                    content: content.clone(),
                    encoding: Some(ArtifactFileEncoding::Utf8),
                    mime: Some(guess_mime(entry, content.as_bytes())),
                    expected_hash: None,
                }],
                origin: Some(meta.origin.clone()),
                summary: req.note.clone(),
                announce: Some(false),
            };
            self.write_files_with_meta_async(maker, &write_req, meta).await?;
        }

        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;
        let fresh = self.row_async(&req.id).await?;
        let next_ver = fresh.version + 1;
        let (storage_id, size) = self.storage.artifact.snapshot_version_async(&fresh.id).await?;
        let at = self.ctx.now();
        let by_name = self.actor_name(&maker.by);
        let note = req.note.clone().unwrap_or_default();
        let ver = NewVersion {
            artifact_id: fresh.id.clone(),
            version: next_ver,
            storage_id,
            size,
            note: Some(note.clone()).filter(|s| !s.is_empty()),
            by_id: maker.by.clone(),
            by_name,
            created_at: at,
        };
        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                let art_id = ver.artifact_id.clone();
                svc_tx.artifact.add_version_in_tx(tx, ver).await?;
                svc_tx.artifact.set_version_in_tx(tx, &art_id, next_ver, at).await
            })
        })
        .await
        .map_err(q)?;

        if let Some(said) = self
            .announce_card_async(
                fresh.channel_id.as_deref(),
                maker,
                say_of("server.artifact.versioned", &fresh.title, &note),
                ArtifactCard {
                    id: fresh.id.clone(),
                    title: fresh.title.clone(),
                    artifact_type: ty,
                    version: next_ver,
                    note,
                },
                format!("art:{}:v{next_ver}", fresh.id),
            )
            .await
        {
            let num_str = said.number.to_string();
            if let Err(err) = self.ctx.service.artifact.set_version_message_id(&fresh.id, next_ver, &num_str).await {
                tracing::warn!(
                    artifact_id = %fresh.id,
                    version = next_ver,
                    message_id = %num_str,
                    error = %err,
                    "artifact.set_version_message_id backlink failed"
                );
            }
        }
        self.get_async(&fresh.id).await
    }

    pub async fn update_async(&self, req: &ArtifactUpdateRequest) -> Result<Wire, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        let at = self.ctx.now();

        let new_title = match &req.title {
            Some(t) => Some(self.check_title(t)?),
            None => None,
        };
        if let Some(true) = req.is_default
            && ty != ArtifactType::DesignSystem
        {
            return Err(refused(t("server.artifact.defaultDesignSystemOnly", &[])));
        }
        let new_issue = match req.issue.as_deref().map(str::trim) {
            Some("") => Some(None),
            Some(iss) => Some(Some(self.issue_id_for_ref_async(iss).await?)),
            None => None,
        };
        let target_title = new_title.as_deref().unwrap_or(&row.title);
        if new_title.is_some() {
            self.storage.artifact.sync_manifest_title_async(&row.id, ty, target_title).await?;
        }

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let id_tx = row.id.clone();
        let new_title_tx = new_title.clone();
        let new_issue_tx = new_issue;
        let is_default = req.is_default;
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                if let Some(t) = new_title_tx {
                    svc_tx.artifact.rename_in_tx(tx, &id_tx, &t, at).await?;
                }
                if let Some(flag) = is_default {
                    if flag {
                        svc_tx.artifact.clear_default_design_system_in_tx(tx, at).await?;
                    }
                    svc_tx.artifact.set_default_in_tx(tx, &id_tx, flag, at).await?;
                }
                if let Some(issue_opt) = new_issue_tx {
                    svc_tx.artifact.set_issue_in_tx(tx, &id_tx, issue_opt.as_deref(), at).await?;
                }
                Ok(())
            })
        })
        .await
        .map_err(q)?;

        if new_title.is_some() {
            let meta = self.storage.artifact.list_files_async(&row.id, Some("manifest.json")).await?;
            let seq = self.row_async(&row.id).await?.seq;
            self.emit_change(
                &row.id,
                ArtifactEvent::Files {
                    seq,
                    files: meta,
                    deleted: vec![],
                    origin: Some(USER_ID.into()),
                    frontiers: None,
                },
            );
        }
        self.get_async(&row.id).await
    }

    pub async fn remove_async(&self, id: &str) -> Result<(), ApiError> {
        let lock = self.artifact_lock(id);
        let _guard = lock.lock().await;
        let _ = self.row_async(id).await?;
        self.ctx.service.artifact.delete(id).await.map_err(q)?;
        self.storage.artifact.delete_directory_async(id).await?;
        self.presence_rooms.lock().remove(id);
        Ok(())
    }

    pub async fn preview_remove_async(&self, id: &str) -> Result<Preview, ApiError> {
        let row = self.row_async(id).await?;
        let versions = self.ctx.service.artifact.versions(&row.id).await.map_err(q)?;
        let n = versions.len();
        let mut does = vec![t("server.artifact.preview.remove", &[("title", row.title.as_str().into()), ("n", n.into())])];
        if row.message_id.is_some() {
            does.push(t("server.artifact.preview.cards", &[]));
        }
        Ok(Preview { does })
    }

    pub async fn list_files_async(&self, req: &ArtifactFileListRequest) -> Result<ArtifactFileListResult, ApiError> {
        let row = self.row_async(&req.id).await?;
        let files = self.storage.artifact.list_files_async(&row.id, req.prefix.as_deref()).await?;
        Ok(ArtifactFileListResult {
            artifact_id: row.id,
            seq: row.seq,
            files,
        })
    }

    pub async fn get_file_async(&self, req: &ArtifactFileGetRequest) -> Result<ArtifactFileContent, ApiError> {
        let row = self.row_async(&req.id).await?;
        let storage_id = match req.version {
            Some(ver) => {
                let v = self.ctx.service.artifact.version(&row.id, ver).await.map_err(q)?.ok_or_else(|| {
                    ApiError::new(
                        BizCode::ArtifactNotFound,
                        t(
                            "server.artifact.noVersion",
                            &[("title", row.title.as_str().into()), ("version", ver.into()), ("latest", row.version.into())],
                        ),
                    )
                })?;
                Some(v.storage_id)
            }
            None => None,
        };
        self.storage
            .artifact
            .read_file_async(&row.id, &row.title, &req.path, storage_id.as_deref())
            .await
    }

    pub async fn write_files_with_meta_async(
        &self,
        maker: &Maker,
        req: &ArtifactFileWriteRequest,
        meta: &CommitMeta,
    ) -> Result<ArtifactFileWriteResult, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        if req.files.is_empty() {
            return Err(refused("No files supplied"));
        }

        let mut normalized_items = Vec::with_capacity(req.files.len());
        for item in &req.files {
            validate_artifact_path(&item.path).map_err(refused)?;
            let mut normalized = item.clone();
            normalized.path = item.path.trim().to_string();
            normalized_items.push(normalized);
        }

        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let human_touched = self.human_touched_paths_async(&row.id).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let at = self.ctx.now();

        let is_agent = maker.by != USER_ID && req.origin.as_deref() != Some(USER_ID);
        let mut direct_items = Vec::new();
        let mut diverted_suggestions = Vec::new();

        for item in normalized_items {
            if is_agent && human_touched.contains(&item.path) && item.encoding != Some(ArtifactFileEncoding::Base64) {
                let current_hash = disk_files.get(&item.path).map(|b| sha256_hex_bytes(b));
                let sug = Suggestion {
                    id: new_id("sug"),
                    artifact_id: row.id.clone(),
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
                    .artifact
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
                .artifact
                .stored_suggestions(&row.id, 1000)
                .await
                .map_err(q)?
                .into_iter()
                .map(|s| s.wire)
                .collect();
            self.emit_suggestions(&row.id, all);
        }

        if direct_items.is_empty() {
            return Ok(ArtifactFileWriteResult {
                artifact_id: row.id,
                seq: row.seq,
                files: vec![],
                frontiers: None,
                suggestions: if diverted_suggestions.is_empty() { None } else { Some(diverted_suggestions) },
            });
        }

        let written_metas = self.storage.artifact.write_files_async(&row.id, ty, &row.title, &direct_items).await?;

        let fresh_disk = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        for m in &written_metas {
            if let Some(bytes) = fresh_disk.get(&m.path) {
                upsert_file_for_write(&doc, &m.path, &m.mime, bytes)?;
            }
        }

        let mut effective_meta = meta.clone();
        if let Some(origin) = req.origin.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            effective_meta.origin = origin.to_string();
        }
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
            && let Ok(manifest) = vibevalley_core::artifact::parse_manifest(m_str)
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
                svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &id_tx, &doc_bytes, at).await?;
                if updated_title_tx != old_title {
                    svc_tx.artifact.rename_in_tx(tx, &id_tx, &updated_title_tx, at).await?;
                }
                svc_tx.artifact.set_seq_in_tx(tx, &id_tx, new_seq, at).await?;
                svc_tx
                    .artifact
                    .add_file_change_in_tx(tx, &id_tx, new_seq, &actor, Some(&frontiers_b64_tx), &written_paths_tx, &[], at)
                    .await
            })
        })
        .await
        .map_err(q)?;

        self.emit_change(
            &row.id,
            ArtifactEvent::Files {
                seq: new_seq,
                files: written_metas.clone(),
                deleted: vec![],
                origin: Some(effective_meta.origin),
                frontiers: Some(frontiers_b64.clone()),
            },
        );

        if req.announce.unwrap_or(false) {
            let note = req.summary.clone().unwrap_or_default();
            let _ = self
                .announce_card_async(
                    row.channel_id.as_deref(),
                    maker,
                    say_of("server.artifact.versioned", &updated_title, &note),
                    ArtifactCard {
                        id: row.id.clone(),
                        title: updated_title,
                        artifact_type: ty,
                        version: row.version,
                        note,
                    },
                    format!("art:{}:seq{new_seq}", row.id),
                )
                .await;
        }

        Ok(ArtifactFileWriteResult {
            artifact_id: row.id,
            seq: new_seq,
            files: written_metas,
            frontiers: Some(frontiers_b64),
            suggestions: if diverted_suggestions.is_empty() { None } else { Some(diverted_suggestions) },
        })
    }

    pub async fn delete_file_with_meta_async(
        &self,
        _maker: &Maker,
        req: &ArtifactFileDeleteRequest,
        meta: &CommitMeta,
    ) -> Result<ArtifactFileDeleteResult, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        validate_deletable_path(&req.path).map_err(refused)?;
        let path = req.path.trim().to_string();
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;

        self.storage.artifact.delete_file_async(&row.id, ty, &row.title, &path).await?;
        let _ = doc.entry_delete(&path);
        let mut effective_meta = meta.clone();
        if let Some(origin) = req.origin.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            effective_meta.origin = origin.to_string();
        }
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
                svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &id_tx, &doc_bytes, at).await?;
                svc_tx.artifact.set_seq_in_tx(tx, &id_tx, new_seq, at).await?;
                svc_tx
                    .artifact
                    .add_file_change_in_tx(tx, &id_tx, new_seq, &actor, Some(&frontiers_b64_tx), &[], &deleted, at)
                    .await
            })
        })
        .await
        .map_err(q)?;

        self.emit_change(
            &row.id,
            ArtifactEvent::Files {
                seq: new_seq,
                files: vec![],
                deleted: vec![path.clone()],
                origin: Some(effective_meta.origin),
                frontiers: Some(frontiers_b64.clone()),
            },
        );

        Ok(ArtifactFileDeleteResult {
            artifact_id: row.id,
            seq: new_seq,
            path,
            frontiers: Some(frontiers_b64),
        })
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
                from: USER_ID.into(),
                by: USER_ID.into(),
                run: None,
            },
            USER_ID.into(),
            None,
        ),
    }
}

fn say_of(key: &str, title: &str, note: &str) -> String {
    let base = t(key, &[("title", title.into())]);
    let trimmed = note.trim();
    if trimmed.is_empty() {
        base
    } else {
        t("server.artifact.withNote", &[("said", base.into()), ("note", trimmed.into())])
    }
}
