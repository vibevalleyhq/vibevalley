//! Unified Loro collaborative engine, live presence, suggestions, and time-travel history
//! for directory-backed artifacts across all 12 `ArtifactType` variants.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use vibevalley_core::artifact::{apply_json_merge_patch, infer_mime, is_text_mime, parse_manifest, serialize_manifest, validate_artifact_path};
use vibevalley_core::collab::{
    CollabDoc, CommitMeta, DocSnapshot, HistoryEntry, PresenceHub, PresenceKind, PresencePayload, PresenceViewport, TextRangeAnchor, decode_frontiers,
    encode_frontiers,
};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Artifact as Wire, ArtifactEvent, ArtifactFileContent, ArtifactFileEncoding, ArtifactFileMeta, ArtifactHistoryCompactRequest,
    ArtifactHistoryEntry, ArtifactHistoryForkRequest, ArtifactHistoryListRequest, ArtifactHistoryPreviewRequest, ArtifactHistoryPreviewResult,
    ArtifactHistoryRestoreRequest, ArtifactHistoryUndoOriginRequest, ArtifactPresence, ArtifactPresenceEvent, ArtifactPresenceKind,
    ArtifactPresenceUpdateRequest, ArtifactSuggestionAcceptInput, ArtifactSuggestionCreateInput, ArtifactType, BizCode, JsNumber, Suggestion, SuggestionEvent,
    SuggestionEventKind, SuggestionStatus, USER_ID, ViewportRect,
};

use super::{Maker, Manager, artifact_type_of, encode_manifest_title_if_needed, new_id, q, refused};
use crate::context::Sink;
use crate::db::DbError;
use crate::service::artifact::{ArtifactRow, NewArtifact, NewVersion, StoredSuggestion};

const DEFAULT_PRESENCE_COLORS: [&str; 6] = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
const PRESENCE_EVICT_INTERVAL: Duration = Duration::from_secs(2);
const ASSET_SENTINEL_PREFIX: &str = "__vvAssetSha256:";
const CHANGE_EVENT_HISTORY_LIMIT: i64 = 256;
const SUGGESTIONS_LIMIT: i64 = 1000;

type PresenceExtraMap = HashMap<String, (Option<String>, Option<String>)>;

#[derive(Default)]
pub(super) struct PresenceRoom {
    pub(super) hub: PresenceHub,
    pub(super) meta: parking_lot::Mutex<PresenceExtraMap>,
}

pub(super) fn commit_meta_for_actor(actor: &str, summary: Option<String>, at: i64) -> CommitMeta {
    if actor == USER_ID {
        CommitMeta::user(USER_ID, summary, at)
    } else {
        CommitMeta {
            author: actor.to_string(),
            agent: Some(actor.to_string()),
            session_id: None,
            turn: None,
            origin: format!("agent:{actor}"),
            summary,
            at,
        }
    }
}

pub(super) fn commit_meta_for_maker(maker: &Maker, summary: Option<String>, at: i64) -> CommitMeta {
    if maker.by == USER_ID {
        CommitMeta::user(USER_ID, summary, at)
    } else if maker.from != maker.by && !maker.from.is_empty() {
        CommitMeta::session(&maker.by, &maker.by, &maker.from, 1, summary, at)
    } else {
        commit_meta_for_actor(&maker.by, summary, at)
    }
}

fn default_color_for(id: &str) -> String {
    let hash = id.bytes().fold(0usize, |acc, b| acc.wrapping_mul(31).wrapping_add(b as usize));
    DEFAULT_PRESENCE_COLORS[hash % DEFAULT_PRESENCE_COLORS.len()].to_string()
}

fn presence_kind_to_core(kind: ArtifactPresenceKind) -> PresenceKind {
    match kind {
        ArtifactPresenceKind::Cursor => PresenceKind::Cursor,
        ArtifactPresenceKind::Selection => PresenceKind::Selection,
        ArtifactPresenceKind::Highlight => PresenceKind::Highlight,
        ArtifactPresenceKind::Viewport => PresenceKind::Viewport,
    }
}

fn presence_kind_from_core(kind: PresenceKind) -> ArtifactPresenceKind {
    match kind {
        PresenceKind::Cursor | PresenceKind::BlockCursor => ArtifactPresenceKind::Cursor,
        PresenceKind::Selection => ArtifactPresenceKind::Selection,
        PresenceKind::Highlight => ArtifactPresenceKind::Highlight,
        PresenceKind::Viewport => ArtifactPresenceKind::Viewport,
    }
}

fn presence_to_payload(p: &ArtifactPresence) -> PresencePayload {
    PresencePayload {
        id: p.id.clone(),
        name: p.name.clone(),
        color: p.color.clone().unwrap_or_else(|| default_color_for(&p.id)),
        kind: presence_kind_to_core(p.kind),
        x: p.x.map(JsNumber::get),
        y: p.y.map(JsNumber::get),
        w: p.w.map(JsNumber::get),
        h: p.h.map(JsNumber::get),
        status: p.status.clone(),
        block_id: p.node_id.clone(),
        offset: p.offset,
        end_offset: p.end_offset,
        selector: p.selector.clone(),
        viewport: p.viewport.as_ref().map(|v| PresenceViewport {
            x: v.x.get(),
            y: v.y.get(),
            w: v.w.get(),
            h: v.h.get(),
            zoom: v.zoom.map(JsNumber::get),
        }),
        updated_at: p.updated_at,
    }
}

fn payload_to_presence(p: &PresencePayload, extra: Option<(Option<String>, Option<String>)>) -> ArtifactPresence {
    let (path, session_id) = extra.unwrap_or((None, None));
    ArtifactPresence {
        id: p.id.clone(),
        name: p.name.clone(),
        color: Some(p.color.clone()),
        kind: presence_kind_from_core(p.kind),
        x: p.x.map(JsNumber),
        y: p.y.map(JsNumber),
        w: p.w.map(JsNumber),
        h: p.h.map(JsNumber),
        status: p.status.clone(),
        node_id: p.block_id.clone(),
        offset: p.offset,
        end_offset: p.end_offset,
        selector: p.selector.clone(),
        path,
        viewport: p.viewport.as_ref().map(|v| ViewportRect {
            x: JsNumber(v.x),
            y: JsNumber(v.y),
            w: JsNumber(v.w),
            h: JsNumber(v.h),
            zoom: v.zoom.map(JsNumber),
        }),
        session_id,
        updated_at: p.updated_at,
    }
}

fn history_entry_to_wire(e: &HistoryEntry) -> ArtifactHistoryEntry {
    let meta = e.meta.as_ref();
    ArtifactHistoryEntry {
        frontiers: encode_frontiers(&e.after_frontiers),
        author: meta.map_or_else(String::new, |m| m.author.clone()),
        agent: meta.and_then(|m| m.agent.clone()),
        session_id: meta.and_then(|m| m.session_id.clone()),
        turn: meta.and_then(|m| m.turn.map(i64::from)),
        origin: meta.map_or_else(String::new, |m| m.origin.clone()),
        summary: meta.and_then(|m| m.summary.clone()),
        at: meta.map_or(e.timestamp * 1000, |m| m.at),
    }
}

pub(super) fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub(super) fn guess_mime(path: &str, bytes: &[u8]) -> String {
    let inferred = infer_mime(path);
    if inferred != "application/octet-stream" {
        return inferred.to_string();
    }
    if std::str::from_utf8(bytes).is_ok() {
        "text/plain; charset=utf-8".to_string()
    } else {
        inferred.to_string()
    }
}

pub(super) fn ingest_files_into_doc(doc: &CollabDoc, files: &BTreeMap<String, Vec<u8>>, existing_paths: &HashSet<String>) -> Result<(), ApiError> {
    for deleted_path in existing_paths {
        if !files.contains_key(deleted_path) {
            let _ = doc.entry_delete(deleted_path);
        }
    }
    for (path, bytes) in files {
        upsert_single_file_in_doc(doc, path, &guess_mime(path, bytes), bytes)?;
    }
    Ok(())
}

pub(super) fn upsert_file_for_write(doc: &CollabDoc, path: &str, mime: &str, bytes: &[u8]) -> Result<(), ApiError> {
    upsert_single_file_in_doc(doc, path, mime, bytes)
}

fn upsert_single_file_in_doc(doc: &CollabDoc, path: &str, mime: &str, bytes: &[u8]) -> Result<(), ApiError> {
    if (is_text_mime(mime) || !path.starts_with("asset/"))
        && let Ok(text) = std::str::from_utf8(bytes)
    {
        doc.text_update_diff(path, text)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab text `{path}`: {e}")))?;
        doc.entry_put_text(path, mime, text)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab entry `{path}`: {e}")))?;
    } else {
        let sentinel = format!("{ASSET_SENTINEL_PREFIX}{}", sha256_hex_bytes(bytes));
        doc.entry_put_text(path, mime, &sentinel)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab asset `{path}`: {e}")))?;
    }
    Ok(())
}

pub(super) fn export_doc_snapshot(doc: &CollabDoc) -> Result<Vec<u8>, ApiError> {
    doc.export_snapshot()
        .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab export: {e}")))
}

fn snapshot_to_raw_files(snap: &DocSnapshot, disk_fallback: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    for entry in &snap.store_entries {
        if entry.content.starts_with(ASSET_SENTINEL_PREFIX) {
            if let Some(bytes) = disk_fallback.get(&entry.path) {
                out.insert(entry.path.clone(), bytes.clone());
            }
            continue;
        }
        let content = snap.texts.get(&entry.path).map(String::as_str).unwrap_or(entry.content.as_str());
        out.insert(entry.path.clone(), content.as_bytes().to_vec());
    }
    out
}

fn snapshot_to_file_contents(artifact_id: &str, snap: &DocSnapshot, disk_fallback: &BTreeMap<String, Vec<u8>>, updated_at: i64) -> Vec<ArtifactFileContent> {
    let mut out = Vec::new();
    for entry in &snap.store_entries {
        if entry.content.starts_with(ASSET_SENTINEL_PREFIX) {
            if let Some(bytes) = disk_fallback.get(&entry.path) {
                out.push(ArtifactFileContent {
                    artifact_id: artifact_id.to_string(),
                    path: entry.path.clone(),
                    mime: entry.mime.clone(),
                    encoding: ArtifactFileEncoding::Base64,
                    content: BASE64.encode(bytes),
                    size: bytes.len() as i64,
                    hash: sha256_hex_bytes(bytes),
                    updated_at,
                });
            }
            continue;
        }
        let text = snap.texts.get(&entry.path).cloned().unwrap_or_else(|| entry.content.clone());
        let bytes = text.as_bytes();
        out.push(ArtifactFileContent {
            artifact_id: artifact_id.to_string(),
            path: entry.path.clone(),
            mime: entry.mime.clone(),
            encoding: ArtifactFileEncoding::Utf8,
            size: bytes.len() as i64,
            hash: sha256_hex_bytes(bytes),
            content: text,
            updated_at,
        });
    }
    out
}

impl Manager {
    pub(super) async fn load_or_bootstrap_doc_async(&self, row: &ArtifactRow, disk_files: &BTreeMap<String, Vec<u8>>) -> Result<(CollabDoc, bool), ApiError> {
        if let Some(bytes) = self.ctx.service.artifact.collab_snapshot(&row.id).await.map_err(q)? {
            let doc = CollabDoc::from_snapshot(&bytes).map_err(|e| ApiError::new(BizCode::InternalError, format!("collab load: {e}")))?;
            return Ok((doc, false));
        }
        let doc = CollabDoc::new();
        ingest_files_into_doc(&doc, disk_files, &HashSet::new())?;
        let meta = commit_meta_for_actor(&row.by_id, Some(row.title.clone()), row.created_at);
        doc.commit(&meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab init commit: {e}")))?;
        Ok((doc, true))
    }

    pub(super) fn presence_room(&self, artifact_id: &str) -> Arc<PresenceRoom> {
        let mut rooms = self.presence_rooms.lock();
        rooms
            .entry(artifact_id.to_string())
            .or_insert_with(|| Arc::new(PresenceRoom::default()))
            .clone()
    }

    pub(super) fn emit_change(&self, artifact_id: &str, event: ArtifactEvent) {
        let _ = self.changes.send((artifact_id.to_string(), event));
    }

    pub(super) fn emit_suggestions(&self, artifact_id: &str, suggestions: Vec<Suggestion>) {
        let _ = self.suggestion_events.send((
            artifact_id.to_string(),
            SuggestionEvent {
                tag: SuggestionEventKind::Suggestions,
                suggestions,
            },
        ));
    }

    pub(super) fn emit_presence(&self, artifact_id: &str, event: ArtifactPresenceEvent) {
        let _ = self.presence_events.send((artifact_id.to_string(), event));
    }

    pub(super) async fn human_touched_paths_async(&self, artifact_id: &str) -> Result<HashSet<String>, ApiError> {
        let changes = self
            .ctx
            .service
            .artifact
            .file_changes_after(artifact_id, 0, SUGGESTIONS_LIMIT)
            .await
            .map_err(q)?;
        let mut touched = HashSet::new();
        for c in changes {
            if c.actor == USER_ID {
                for p in c.paths {
                    if p != "manifest.json" {
                        touched.insert(p);
                    }
                }
            }
        }
        Ok(touched)
    }

    pub async fn suggestions_async(&self, id: &str) -> Result<Vec<Suggestion>, ApiError> {
        let _ = self.row_async(id).await?;
        let stored = self.ctx.service.artifact.stored_suggestions(id, SUGGESTIONS_LIMIT).await.map_err(q)?;
        Ok(stored.into_iter().map(|s| s.wire).collect())
    }

    pub async fn create_suggestion_async(&self, actor: &str, req: &ArtifactSuggestionCreateInput) -> Result<Suggestion, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        validate_artifact_path(&req.path).map_err(refused)?;
        let path = req.path.trim().to_string();
        let change = &req.change;
        let has_content = change.content.is_some();
        let has_patch = change.patch.is_some();
        let is_delete = change.delete == Some(true);
        if !has_content && !has_patch && !is_delete {
            return Err(refused(t("server.artifact.suggestion.empty", &[])));
        }
        if is_delete && (req.start_offset.is_some() || req.end_offset.is_some() || req.cursor_start.is_some() || req.cursor_end.is_some()) {
            return Err(refused(t("server.artifact.suggestion.deleteConflict", &[])));
        }
        if req.base_rev > row.seq {
            return Err(refused(t(
                "server.artifact.suggestion.beyond",
                &[("rev", req.base_rev.into()), ("now", row.seq.into())],
            )));
        }

        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let current_bytes = disk_files.get(&path);
        let base_hash = req.base_hash.clone().or_else(|| current_bytes.map(|b| sha256_hex_bytes(b)));

        let (cursor_start, cursor_end) = if let (Some(start), Some(end)) = (req.start_offset, req.end_offset) {
            let Some(bytes) = current_bytes else {
                return Err(refused(t(
                    "server.artifact.file.missing",
                    &[("title", row.title.as_str().into()), ("path", path.as_str().into())],
                )));
            };
            if std::str::from_utf8(bytes).is_err() {
                return Err(refused("Range suggestions require a UTF-8 text file"));
            }
            let (doc, bootstrapped) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
            let anchor = doc
                .anchor_text_range(&path, start as usize, end.max(start) as usize)
                .map_err(|e| refused(format!("cannot anchor text range: {e}")))?;
            if bootstrapped {
                let doc_bytes = export_doc_snapshot(&doc)?;
                let now = self.ctx.now();
                let svc = self.ctx.service.clone();
                let svc_tx = svc.clone();
                let id = row.id.clone();
                svc.transaction::<_, DbError>(move |tx| Box::pin(async move { svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &id, &doc_bytes, now).await }))
                    .await
                    .map_err(q)?;
            }
            (Some(anchor.start_cursor), Some(anchor.end_cursor))
        } else {
            (req.cursor_start.clone(), req.cursor_end.clone())
        };

        let at = self.ctx.now();
        let suggestion = Suggestion {
            id: new_id("sug"),
            artifact_id: row.id.clone(),
            path: path.clone(),
            author: actor.to_string(),
            base_rev: req.base_rev,
            base_hash,
            change: req.change.clone(),
            status: SuggestionStatus::Open,
            created_at: at,
            resolved_at: None,
            resolved_by: None,
            cursor_start,
            cursor_end,
            start_offset: req.start_offset,
            end_offset: req.end_offset,
        };
        self.ctx
            .service
            .artifact
            .add_suggestion(&StoredSuggestion {
                wire: suggestion.clone(),
                origin: Some(commit_meta_for_actor(actor, req.change.summary.clone(), at).origin),
            })
            .await
            .map_err(q)?;

        let all = self
            .ctx
            .service
            .artifact
            .stored_suggestions(&row.id, SUGGESTIONS_LIMIT)
            .await
            .map_err(q)?
            .into_iter()
            .map(|s| s.wire)
            .collect();
        self.emit_suggestions(&row.id, all);
        Ok(suggestion)
    }

    pub async fn accept_suggestion_async(&self, resolver: &str, req: &ArtifactSuggestionAcceptInput) -> Result<Suggestion, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        let stored = self
            .ctx
            .service
            .artifact
            .stored_suggestion(&req.suggestion)
            .await
            .map_err(q)?
            .filter(|s| s.wire.artifact_id == req.id)
            .ok_or_else(|| refused(t("server.artifact.suggestion.missing", &[("id", req.suggestion.as_str().into())])))?;

        if stored.wire.status != SuggestionStatus::Open {
            return Err(refused("Suggestion is already resolved"));
        }

        let sug = &stored.wire;
        validate_artifact_path(&sug.path).map_err(refused)?;
        let path = sug.path.trim().to_string();
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let at = self.ctx.now();
        let meta = commit_meta_for_actor(
            resolver,
            sug.change.summary.clone().or_else(|| Some(format!("Accept suggestion {}", sug.id))),
            at,
        );

        let mut changed_files_meta = Vec::new();
        let mut deleted_paths = Vec::new();

        if sug.change.delete == Some(true) {
            if let (Some(expected), Some(actual_bytes)) = (sug.base_hash.as_deref(), disk_files.get(&path)) {
                let actual = sha256_hex_bytes(actual_bytes);
                if actual != expected {
                    return Err(ApiError::new(
                        BizCode::ArtifactRefused,
                        t(
                            "server.artifact.suggestion.staleFile",
                            &[("path", path.as_str().into()), ("hash", expected.into())],
                        ),
                    ));
                }
            }
            self.storage.artifact.delete_file_async(&row.id, ty, &row.title, &path).await?;
            let _ = doc.entry_delete(&path);
            deleted_paths.push(path.clone());
        } else if let (Some(cs), Some(ce), Some(content)) = (sug.cursor_start.as_deref(), sug.cursor_end.as_deref(), sug.change.content.as_deref()) {
            let anchor = TextRangeAnchor {
                text_key: path.clone(),
                start_cursor: cs.to_string(),
                end_cursor: ce.to_string(),
            };
            doc.apply_anchored_replacement(&anchor, content)
                .map_err(|e| ApiError::new(BizCode::ArtifactRefused, format!("apply anchored suggestion: {e}")))?;
            let updated_text = doc.text_get(&path).unwrap_or_default();
            let mime = guess_mime(&path, updated_text.as_bytes());
            doc.entry_put_text(&path, &mime, &updated_text)
                .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab entry `{path}`: {e}")))?;
            let written = self
                .storage
                .artifact
                .write_files_async(
                    &row.id,
                    ty,
                    &row.title,
                    &[vibevalley_protocol::ArtifactFileWriteItem {
                        path: path.clone(),
                        content: updated_text,
                        encoding: Some(ArtifactFileEncoding::Utf8),
                        mime: Some(mime),
                        expected_hash: None,
                    }],
                )
                .await?;
            changed_files_meta.extend(written);
        } else {
            if let (Some(expected), Some(actual_bytes)) = (sug.base_hash.as_deref(), disk_files.get(&path)) {
                let actual = sha256_hex_bytes(actual_bytes);
                if actual != expected {
                    return Err(ApiError::new(
                        BizCode::ArtifactRefused,
                        t(
                            "server.artifact.suggestion.staleFile",
                            &[("path", path.as_str().into()), ("hash", expected.into())],
                        ),
                    ));
                }
            }
            let new_content = if let Some(patch_raw) = sug.change.patch.as_deref() {
                let current_raw = disk_files.get(&path).and_then(|bytes| std::str::from_utf8(bytes).ok());
                apply_json_merge_patch(current_raw, patch_raw).map_err(refused)?
            } else {
                sug.change.content.clone().unwrap_or_default()
            };
            let mime = guess_mime(&path, new_content.as_bytes());
            let written = self
                .storage
                .artifact
                .write_files_async(
                    &row.id,
                    ty,
                    &row.title,
                    &[vibevalley_protocol::ArtifactFileWriteItem {
                        path: path.clone(),
                        content: new_content.clone(),
                        encoding: Some(ArtifactFileEncoding::Utf8),
                        mime: Some(mime.clone()),
                        expected_hash: None,
                    }],
                )
                .await?;
            upsert_single_file_in_doc(&doc, &path, &mime, new_content.as_bytes())?;
            changed_files_meta.extend(written);
        }

        let frontiers = doc
            .commit(&meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab commit: {e}")))?;
        let frontiers_b64 = encode_frontiers(&frontiers);
        let doc_bytes = export_doc_snapshot(&doc)?;
        let new_seq = row.seq + 1;
        let paths_list: Vec<String> = changed_files_meta.iter().map(|m| m.path.clone()).collect();

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let art_id = row.id.clone();
        let sug_id = req.suggestion.clone();
        let resolver_owned = resolver.to_string();
        let frontiers_b64_tx = frontiers_b64.clone();
        let meta_author = meta.author.clone();
        let paths_list_tx = paths_list.clone();
        let deleted_paths_tx = deleted_paths.clone();
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &art_id, &doc_bytes, at).await?;
                svc_tx.artifact.set_seq_in_tx(tx, &art_id, new_seq, at).await?;
                svc_tx
                    .artifact
                    .add_file_change_in_tx(
                        tx,
                        &art_id,
                        new_seq,
                        &meta_author,
                        Some(&frontiers_b64_tx),
                        &paths_list_tx,
                        &deleted_paths_tx,
                        at,
                    )
                    .await?;
                svc_tx.artifact.resolve_suggestion_in_tx(tx, &sug_id, "accepted", at, &resolver_owned).await
            })
        })
        .await
        .map_err(q)?;

        self.emit_change(
            &row.id,
            ArtifactEvent::Files {
                seq: new_seq,
                files: changed_files_meta,
                deleted: deleted_paths,
                origin: Some(meta.origin),
                frontiers: Some(frontiers_b64),
            },
        );
        let all = self
            .ctx
            .service
            .artifact
            .stored_suggestions(&row.id, SUGGESTIONS_LIMIT)
            .await
            .map_err(q)?
            .into_iter()
            .map(|s| s.wire)
            .collect();
        self.emit_suggestions(&row.id, all);

        self.ctx
            .service
            .artifact
            .stored_suggestion(&req.suggestion)
            .await
            .map_err(q)?
            .map(|s| s.wire)
            .ok_or_else(|| refused(t("server.artifact.suggestion.missing", &[("id", req.suggestion.as_str().into())])))
    }

    pub async fn reject_suggestion_async(&self, resolver: &str, id: &str, suggestion_id: &str) -> Result<Suggestion, ApiError> {
        let _ = self.row_async(id).await?;
        let stored = self
            .ctx
            .service
            .artifact
            .stored_suggestion(suggestion_id)
            .await
            .map_err(q)?
            .filter(|s| s.wire.artifact_id == id)
            .ok_or_else(|| refused(t("server.artifact.suggestion.missing", &[("id", suggestion_id.into())])))?;
        if stored.wire.status != SuggestionStatus::Open {
            return Err(refused("Suggestion is already resolved"));
        }
        let at = self.ctx.now();
        self.ctx
            .service
            .artifact
            .resolve_suggestion(suggestion_id, "rejected", at, resolver)
            .await
            .map_err(q)?;

        let all = self
            .ctx
            .service
            .artifact
            .stored_suggestions(id, SUGGESTIONS_LIMIT)
            .await
            .map_err(q)?
            .into_iter()
            .map(|s| s.wire)
            .collect();
        self.emit_suggestions(id, all);

        self.ctx
            .service
            .artifact
            .stored_suggestion(suggestion_id)
            .await
            .map_err(q)?
            .map(|s| s.wire)
            .ok_or_else(|| refused(t("server.artifact.suggestion.missing", &[("id", suggestion_id.into())])))
    }

    pub async fn update_presence_async(&self, req: &ArtifactPresenceUpdateRequest) -> Result<Vec<ArtifactPresence>, ApiError> {
        let _ = self.row_async(&req.id).await?;
        let room = self.presence_room(&req.id);
        let mut evicted_ids = room.hub.evict_stale(self.ctx.now());
        if !evicted_ids.is_empty() {
            let mut meta = room.meta.lock();
            for id in &evicted_ids {
                meta.remove(id);
            }
        }
        for id in evicted_ids.drain(..) {
            self.emit_presence(&req.id, ArtifactPresenceEvent::Remove { peer_id: id });
        }

        if let Some(mut presence) = req.presence.clone() {
            if presence.updated_at <= 0 {
                presence.updated_at = self.ctx.now();
            }
            if presence.color.is_none() {
                presence.color = Some(default_color_for(&presence.id));
            }
            let extra = (presence.path.clone(), presence.session_id.clone());
            room.meta.lock().insert(presence.id.clone(), extra);
            room.hub
                .upsert(presence_to_payload(&presence))
                .map_err(|e| ApiError::new(BizCode::InternalError, format!("presence upsert: {e}")))?;
            self.emit_presence(&req.id, ArtifactPresenceEvent::Upsert { peer: presence });
        } else if let Some(peer_id) = req.peer_id.as_deref() {
            room.hub.remove(peer_id);
            room.meta.lock().remove(peer_id);
            self.emit_presence(&req.id, ArtifactPresenceEvent::Remove { peer_id: peer_id.to_string() });
        }

        Ok(self.presence_snapshot_of(&room))
    }

    fn presence_snapshot_of(&self, room: &PresenceRoom) -> Vec<ArtifactPresence> {
        let meta = room.meta.lock();
        room.hub
            .snapshot()
            .into_iter()
            .map(|p| {
                let extra = meta.get(&p.id).cloned();
                payload_to_presence(&p, extra)
            })
            .collect()
    }

    pub async fn history_list_async(&self, req: &ArtifactHistoryListRequest) -> Result<Vec<ArtifactHistoryEntry>, ApiError> {
        let row = self.row_async(&req.id).await?;
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let mut entries: Vec<ArtifactHistoryEntry> = doc
            .history()
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab history: {e}")))?
            .iter()
            .rev()
            .map(history_entry_to_wire)
            .collect();
        let limit = req.limit.unwrap_or(50).clamp(1, 500) as usize;
        entries.truncate(limit);
        Ok(entries)
    }

    pub async fn history_preview_async(&self, req: &ArtifactHistoryPreviewRequest) -> Result<ArtifactHistoryPreviewResult, ApiError> {
        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let frontiers = decode_frontiers(&req.frontiers).map_err(|e| refused(format!("invalid frontiers: {e}")))?;
        let snap = doc
            .checkout_snapshot(&frontiers)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab preview: {e}")))?;
        let entry = doc
            .history()
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab history: {e}")))?
            .into_iter()
            .find(|h| encode_frontiers(&h.after_frontiers) == req.frontiers)
            .map(|h| history_entry_to_wire(&h));
        let files = snapshot_to_file_contents(&row.id, &snap, &disk_files, row.updated_at);
        Ok(ArtifactHistoryPreviewResult {
            artifact_id: row.id,
            artifact_type: ty,
            frontiers: req.frontiers.clone(),
            entry,
            files,
        })
    }

    pub async fn history_restore_async(&self, maker: &Maker, req: &ArtifactHistoryRestoreRequest) -> Result<Wire, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let target = decode_frontiers(&req.frontiers).map_err(|e| refused(format!("invalid frontiers: {e}")))?;
        let at = self.ctx.now();
        let meta = commit_meta_for_maker(maker, req.note.clone().or_else(|| Some("Restore snapshot".into())), at);

        let new_frontiers = doc
            .restore_to(&target, &meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab restore: {e}")))?;
        let snap = doc.project_snapshot();
        let mut restored_files = snapshot_to_raw_files(&snap, &disk_files);

        let mut new_title = row.title.clone();
        if let Some(manifest_bytes) = restored_files.get("manifest.json")
            && let Ok(manifest_raw) = std::str::from_utf8(manifest_bytes)
            && let Ok(manifest) = parse_manifest(manifest_raw)
        {
            new_title = manifest.title;
        }
        encode_manifest_title_if_needed(&mut restored_files, ty, &new_title)?;
        upsert_single_file_in_doc(
            &doc,
            "manifest.json",
            "application/json",
            restored_files.get("manifest.json").map(Vec::as_slice).unwrap_or_default(),
        )?;

        let (files_meta, deleted_paths) = self
            .storage
            .artifact
            .materialize_directory_async(&row.id, ty, &new_title, &restored_files)
            .await?;
        let frontiers_b64 = encode_frontiers(&new_frontiers);
        let doc_bytes = export_doc_snapshot(&doc)?;
        let new_seq = row.seq + 1;
        let paths_list: Vec<String> = files_meta.iter().map(|m| m.path.clone()).collect();

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let id_tx = row.id.clone();
        let frontiers_b64_tx = frontiers_b64.clone();
        let meta_author = meta.author.clone();
        let paths_list_tx = paths_list.clone();
        let deleted_paths_tx = deleted_paths.clone();
        let new_title_tx = new_title.clone();
        let old_title = row.title.clone();
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &id_tx, &doc_bytes, at).await?;
                if new_title_tx != old_title {
                    svc_tx.artifact.rename_in_tx(tx, &id_tx, &new_title_tx, at).await?;
                }
                svc_tx.artifact.set_seq_in_tx(tx, &id_tx, new_seq, at).await?;
                svc_tx
                    .artifact
                    .add_file_change_in_tx(
                        tx,
                        &id_tx,
                        new_seq,
                        &meta_author,
                        Some(&frontiers_b64_tx),
                        &paths_list_tx,
                        &deleted_paths_tx,
                        at,
                    )
                    .await
            })
        })
        .await
        .map_err(q)?;

        self.emit_change(
            &row.id,
            ArtifactEvent::Files {
                seq: new_seq,
                files: files_meta,
                deleted: deleted_paths,
                origin: Some(meta.origin),
                frontiers: Some(frontiers_b64),
            },
        );
        self.get_async(&row.id).await
    }

    pub async fn history_fork_async(&self, maker: &Maker, req: &ArtifactHistoryForkRequest) -> Result<Wire, ApiError> {
        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let target = decode_frontiers(&req.frontiers).map_err(|e| refused(format!("invalid frontiers: {e}")))?;
        let forked = doc
            .fork_at(&target)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab fork: {e}")))?;

        let snap = forked.project_snapshot();
        let mut forked_files = snapshot_to_raw_files(&snap, &disk_files);
        let new_id = new_id("art");
        let new_title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} (fork)", row.title));
        encode_manifest_title_if_needed(&mut forked_files, ty, &new_title)?;
        if let Some(manifest_bytes) = forked_files.get("manifest.json")
            && let Ok(manifest_text) = std::str::from_utf8(manifest_bytes)
        {
            upsert_single_file_in_doc(&forked, "manifest.json", "application/json", manifest_text.as_bytes())?;
        }
        let at = self.ctx.now();
        let meta = commit_meta_for_maker(maker, Some(format!("Fork from {}", row.id)), at);
        let frontiers = forked
            .commit(&meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab fork commit: {e}")))?;
        let frontiers_b64 = encode_frontiers(&frontiers);
        let forked_bytes = export_doc_snapshot(&forked)?;

        let (files_meta, _) = self
            .storage
            .artifact
            .materialize_directory_async(&new_id, ty, &new_title, &forked_files)
            .await?;
        let (storage_id, size) = self.storage.artifact.snapshot_version_async(&new_id).await?;

        let channel_id = match req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(ch) => Some(self.resolve_channel_async(&maker.from, ch).await?),
            None => row.channel_id.clone(),
        };
        let by_name = self.actor_name(&maker.by);
        let paths_list: Vec<String> = files_meta.iter().map(|m| m.path.clone()).collect();
        let new_row = NewArtifact {
            id: new_id.clone(),
            title: new_title.clone(),
            artifact_type: ty.as_str().to_string(),
            is_default: false,
            channel_id,
            issue: row.issue.clone(),
            by_id: maker.by.clone(),
            by_name: by_name.clone(),
            version: 1,
            created_at: at,
        };
        let ver = NewVersion {
            artifact_id: new_id.clone(),
            version: 1,
            storage_id,
            size,
            note: Some(format!("Forked from {}", row.title)),
            by_id: maker.by.clone(),
            by_name,
            created_at: at,
        };

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let meta_author = meta.author.clone();
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                let art_id = new_row.id.clone();
                svc_tx.artifact.add_in_tx(tx, new_row).await?;
                svc_tx.artifact.add_version_in_tx(tx, ver).await?;
                svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &art_id, &forked_bytes, at).await?;
                svc_tx.artifact.set_seq_in_tx(tx, &art_id, 1, at).await?;
                svc_tx
                    .artifact
                    .add_file_change_in_tx(tx, &art_id, 1, &meta_author, Some(&frontiers_b64), &paths_list, &[], at)
                    .await
            })
        })
        .await
        .map_err(q)?;

        self.get_async(&new_id).await
    }

    pub async fn history_undo_origin_async(&self, maker: &Maker, req: &ArtifactHistoryUndoOriginRequest) -> Result<Wire, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        let ty = artifact_type_of(&row.artifact_type)?;
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let at = self.ctx.now();
        let undo_meta = CommitMeta::undo(&maker.by, &req.origin, Some(format!("Undo {}", req.origin)), at);

        let reverted = doc
            .selective_undo_origin(&req.origin, &undo_meta)
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab undo origin: {e}")))?;
        if reverted == 0 {
            return self.get_async(&row.id).await;
        }

        let snap = doc.project_snapshot();
        let mut updated_files = snapshot_to_raw_files(&snap, &disk_files);
        encode_manifest_title_if_needed(&mut updated_files, ty, &row.title)?;
        let (files_meta, deleted_paths) = self
            .storage
            .artifact
            .materialize_directory_async(&row.id, ty, &row.title, &updated_files)
            .await?;
        let frontiers_b64 = encode_frontiers(&doc.frontiers());
        let doc_bytes = export_doc_snapshot(&doc)?;
        let new_seq = row.seq + 1;
        let paths_list: Vec<String> = files_meta.iter().map(|m| m.path.clone()).collect();

        let svc = self.ctx.service.clone();
        let svc_tx = svc.clone();
        let id_tx = row.id.clone();
        let frontiers_b64_tx = frontiers_b64.clone();
        let undo_author = undo_meta.author.clone();
        let paths_list_tx = paths_list.clone();
        let deleted_paths_tx = deleted_paths.clone();
        svc.transaction::<_, DbError>(move |tx| {
            Box::pin(async move {
                svc_tx.artifact.upsert_collab_snapshot_in_tx(tx, &id_tx, &doc_bytes, at).await?;
                svc_tx.artifact.set_seq_in_tx(tx, &id_tx, new_seq, at).await?;
                svc_tx
                    .artifact
                    .add_file_change_in_tx(
                        tx,
                        &id_tx,
                        new_seq,
                        &undo_author,
                        Some(&frontiers_b64_tx),
                        &paths_list_tx,
                        &deleted_paths_tx,
                        at,
                    )
                    .await
            })
        })
        .await
        .map_err(q)?;

        self.emit_change(
            &row.id,
            ArtifactEvent::Files {
                seq: new_seq,
                files: files_meta,
                deleted: deleted_paths,
                origin: Some(undo_meta.origin),
                frontiers: Some(frontiers_b64),
            },
        );
        self.get_async(&row.id).await
    }

    pub async fn history_compact_async(&self, req: &ArtifactHistoryCompactRequest) -> Result<Wire, ApiError> {
        let lock = self.artifact_lock(&req.id);
        let _guard = lock.lock().await;

        let row = self.row_async(&req.id).await?;
        let disk_files = self.storage.artifact.read_all_raw_async(&row.id, None).await?;
        let (doc, _) = self.load_or_bootstrap_doc_async(&row, &disk_files).await?;
        let compacted = doc
            .compact_shallow_snapshot()
            .map_err(|e| ApiError::new(BizCode::InternalError, format!("collab compact: {e}")))?;
        let at = self.ctx.now();
        self.ctx.service.artifact.upsert_collab_snapshot(&row.id, &compacted, at).await.map_err(q)?;
        self.get_async(&row.id).await
    }

    pub async fn follow_files_async(self: &Arc<Self>, id: &str, after: i64, sink: Sink) -> Result<(), ApiError> {
        let row = self.row_async(id).await?;
        let mut rx = self.changes.subscribe();

        let mut last_seq = after;
        if row.seq > after {
            let changes = self
                .ctx
                .service
                .artifact
                .file_changes_after(&row.id, after, CHANGE_EVENT_HISTORY_LIMIT + 1)
                .await
                .map_err(q)?;
            if changes.len() > CHANGE_EVENT_HISTORY_LIMIT as usize {
                let _ = sink.send(&ArtifactEvent::Reset {});
                last_seq = row.seq;
            } else {
                let current_metas: HashMap<String, ArtifactFileMeta> = self
                    .storage
                    .artifact
                    .list_files_async(&row.id, None)
                    .await?
                    .into_iter()
                    .map(|m| (m.path.clone(), m))
                    .collect();
                for change in changes {
                    let files = change.paths.iter().filter_map(|p| current_metas.get(p).cloned()).collect();
                    let _ = sink.send(&ArtifactEvent::Files {
                        seq: change.seq,
                        files,
                        deleted: change.deleted,
                        origin: Some(change.actor),
                        frontiers: change.frontiers,
                    });
                    last_seq = last_seq.max(change.seq);
                }
            }
        }

        let artifact_id = row.id;
        let sink_task = self.ctx.clone();
        sink_task.spawn("artifact.follow", async move {
            loop {
                tokio::select! {
                    biased;
                    _ = sink.stop.cancelled() => return,
                    msg = rx.recv() => match msg {
                        Ok((id, ev)) => {
                            if id == artifact_id {
                                if let ArtifactEvent::Files { seq, .. } = &ev {
                                    if *seq <= last_seq {
                                        continue;
                                    }
                                    last_seq = *seq;
                                }
                                if !sink.send(&ev) {
                                    return;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            if !sink.send(&ArtifactEvent::Reset {}) {
                                return;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });
        Ok(())
    }

    pub async fn follow_suggestions_async(self: &Arc<Self>, id: &str, sink: Sink) -> Result<(), ApiError> {
        let initial = self.suggestions_async(id).await?;
        let _ = sink.send(&SuggestionEvent {
            tag: SuggestionEventKind::Suggestions,
            suggestions: initial,
        });
        let mut rx = self.suggestion_events.subscribe();
        let artifact_id = id.to_string();
        self.ctx.spawn("artifact.suggestion.follow", async move {
            loop {
                tokio::select! {
                    biased;
                    _ = sink.stop.cancelled() => return,
                    msg = rx.recv() => match msg {
                        Ok((id, ev)) => {
                            if id == artifact_id && !sink.send(&ev) {
                                return;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });
        Ok(())
    }

    pub async fn follow_presence_async(self: &Arc<Self>, id: &str, sink: Sink) -> Result<(), ApiError> {
        let _ = self.row_async(id).await?;
        let room = self.presence_room(id);
        let initial = self.presence_snapshot_of(&room);
        let _ = sink.send(&ArtifactPresenceEvent::Snapshot { peers: initial });
        let mut rx = self.presence_events.subscribe();
        let artifact_id = id.to_string();
        let this = self.clone();
        self.ctx.spawn("artifact.presence.follow", async move {
            let mut ticker = tokio::time::interval(PRESENCE_EVICT_INTERVAL);
            loop {
                tokio::select! {
                    biased;
                    _ = sink.stop.cancelled() => return,
                    _ = ticker.tick() => {
                        let evicted = room.hub.evict_stale(this.ctx.now());
                        if !evicted.is_empty() {
                            room.meta.lock().retain(|k, _| !evicted.contains(k));
                            for peer_id in evicted {
                                if !sink.send(&ArtifactPresenceEvent::Remove { peer_id }) {
                                    return;
                                }
                            }
                        }
                    }
                    msg = rx.recv() => match msg {
                        Ok((id, ev)) => {
                            if id == artifact_id && !sink.send(&ev) {
                                return;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let peers = this.presence_snapshot_of(&room);
                            if !sink.send(&ArtifactPresenceEvent::Snapshot { peers }) {
                                return;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });
        Ok(())
    }
}

pub(super) fn sync_manifest_title_raw(manifest_bytes: &[u8], _ty: ArtifactType, title: &str) -> Result<Vec<u8>, ApiError> {
    let raw = std::str::from_utf8(manifest_bytes).map_err(|e| refused(format!("invalid UTF-8 manifest.json: {e}")))?;
    let mut manifest = parse_manifest(raw).map_err(refused)?;
    manifest.title = title.to_string();
    Ok(serialize_manifest(&manifest).map_err(refused)?.into_bytes())
}
