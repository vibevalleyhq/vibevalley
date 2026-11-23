//! Structured artifact entry store (`entries.ts`): optimistic concurrency
//! batches (`set`/`patch`/`delete`/`copy`), attachment links, SVG/HTML
//! sanitization, SSE replay/broadcast (`artifact.entry.follow`), and sandboxed
//! HTML viewer rendering (`artifact.view`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_core::artifact::{
    ENTRY_MAX_BYTES, ENTRY_MAX_COUNT, INLINE_EVENT_MAX_BYTES, RenderStoreOptions, apply_json_merge_patch, canonical_json, contrast_ratio, entry_path_problem,
    format_store_summary, infer_entry_kind, infer_entry_mime, parse_tokens_spec, render_store_artifact_html, sanitize_whiteboard_svg, shell_theme_of,
    store_html_problem, store_view_headers, write_props_into_dc_html,
};
use vibevalley_core::collab::CommitMeta;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, ArtifactBody, ArtifactCard, ArtifactEntry, ArtifactEntryBatchRequest, ArtifactEntryBatchResult, ArtifactEntryConflict, ArtifactEntryEvent,
    ArtifactEntryGetRequest, ArtifactEntryKind, ArtifactEntryListRequest, ArtifactEntryOp, ArtifactEntrySnapshot, ArtifactEntryWriteInput,
    ArtifactEntryWritePropsInput, ArtifactPage, ArtifactTokensInspectInput, ArtifactType, ArtifactViewInput, Attachment, DesignPropValue, InspectedColorSwatch,
    InspectedTokenValue, InspectedTokensSpec, InspectedTypeFamily, InspectedTypeStyle,
};

use super::blocks::relay_with_reset;
use super::collab::commit_meta_for_maker;
use super::{Artifacts, Maker, artifact_type_of, db, q, refused};
use crate::base::{LookIn, missing};
use crate::{Hub, Sink, now};

const CATCH_UP_MAX: usize = 200;

#[derive(Debug, Clone)]
pub(super) struct EntryChange {
    pub artifact: String,
    pub seq: i64,
    pub entries: Vec<ArtifactEntry>,
    pub deleted: Vec<String>,
}

fn entry_kind_of(s: &str) -> ArtifactEntryKind {
    match s {
        "json" => ArtifactEntryKind::Json,
        "asset" => ArtifactEntryKind::Asset,
        _ => ArtifactEntryKind::Text,
    }
}

fn entry_of(r: &db::EntryRow, include_value: bool) -> ArtifactEntry {
    ArtifactEntry {
        artifact_id: r.artifact_id.clone(),
        path: r.path.clone(),
        kind: entry_kind_of(&r.kind),
        mime: r.mime.clone(),
        size: r.size,
        rev: r.rev,
        updated_by: r.updated_by.clone(),
        updated: r.updated_at,
        value: if include_value { r.value.clone() } else { None },
        attachment_id: r.attachment_id.clone(),
    }
}

fn check_path(path: &str) -> Result<(), ApiError> {
    if let Some(why) = entry_path_problem(path) {
        return Err(refused(t("server.artifact.entry.badPath", &[("path", path.into()), ("why", why.into())])));
    }
    Ok(())
}

fn sanitize_whiteboard_element_json(artifact_type: Option<ArtifactType>, path: &str, canonical_text: &str) -> Result<String, ApiError> {
    if artifact_type != Some(ArtifactType::Whiteboard) || !path.starts_with("elements/") {
        return Ok(canonical_text.to_string());
    }
    let Ok(mut parsed) = serde_json::from_str::<Value>(canonical_text) else {
        return Ok(canonical_text.to_string());
    };
    let Some(map) = parsed.as_object_mut() else {
        return Ok(canonical_text.to_string());
    };
    let elem_type = map.get("type").and_then(Value::as_str);
    let is_svg_like = matches!(elem_type, Some("svg" | "sticker"));
    let is_html = elem_type == Some("html");
    let mut dirty = false;
    if is_svg_like && let Some(svg) = map.get("svg").and_then(Value::as_str) {
        let clean = sanitize_whiteboard_svg(svg);
        map.insert("svg".into(), Value::String(clean));
        dirty = true;
    }
    if let Some(sticker_svg) = map.get("stickerSvg").and_then(Value::as_str) {
        let clean = sanitize_whiteboard_svg(sticker_svg);
        map.insert("stickerSvg".into(), Value::String(clean));
        dirty = true;
    }
    if is_html && let Some(html) = map.get("html").and_then(Value::as_str) {
        let hp = store_html_problem(html);
        if !hp.is_empty() {
            return Err(refused(hp));
        }
    }
    if dirty {
        return serde_json::to_string(&parsed).map_err(crate::base::internal);
    }
    Ok(canonical_text.to_string())
}

impl Artifacts {
    pub(super) fn entry_lock(&self, id: &str) -> Arc<AsyncMutex<()>> {
        let mut map = self.entry_locks.lock();
        map.entry(id.to_string()).or_insert_with(|| Arc::new(AsyncMutex::new(()))).clone()
    }

    async fn found_store_async(&self, db: &mut SqliteConnection, id: &str) -> Result<db::ArtifactRow, ApiError> {
        let row = self.found(db, id).await?;
        if row.body != "store" {
            return Err(refused(t("server.artifact.notStore", &[("title", row.title.as_str().into())])));
        }
        Ok(row)
    }

    pub(super) async fn entry_count_async(&self, id: &str) -> Result<i64, ApiError> {
        let mut db = self.db.read_pool().acquire().await.map_err(q)?;
        db::entry_count(&mut db, id).await.map_err(q)
    }

    pub(super) async fn store_summary_async(&self, row: &db::ArtifactRow) -> Result<String, ApiError> {
        let mut db = self.db.read_pool().acquire().await.map_err(q)?;
        let rows = db::entries(&mut db, &row.id).await.map_err(q)?;
        let entries: Vec<ArtifactEntry> = rows.iter().map(|r| entry_of(r, true)).collect();
        let artifact_type = row.artifact_type.as_deref().and_then(artifact_type_of);
        Ok(format_store_summary(&row.title, artifact_type, row.seq, &entries))
    }

    pub async fn list_entries_async(&self, req: &ArtifactEntryListRequest) -> Result<ArtifactEntrySnapshot, ApiError> {
        let mut db = self.db.read_pool().acquire().await.map_err(q)?;
        let row = self.found_store_async(&mut db, &req.id).await?;
        let prefix = req.prefix.as_deref().map(str::trim).unwrap_or("");
        let include_values = req.include_values == Some(true);
        let rows = if prefix.is_empty() {
            db::entries(&mut db, &req.id).await.map_err(q)?
        } else {
            db::entries_by_prefix(&mut db, &req.id, prefix).await.map_err(q)?
        };
        let seq = row.seq;
        let artifact = self.assemble(&mut db, row).await?;
        let entries = rows.iter().map(|r| entry_of(r, include_values)).collect();
        Ok(ArtifactEntrySnapshot { artifact, seq, entries })
    }

    pub async fn get_entry_async(&self, req: &ArtifactEntryGetRequest) -> Result<ArtifactEntry, ApiError> {
        let mut db = self.db.read_pool().acquire().await.map_err(q)?;
        let row = self.found_store_async(&mut db, &req.id).await?;
        check_path(&req.path)?;
        let entry = db::entry(&mut db, &req.id, &req.path).await.map_err(q)?.ok_or_else(|| {
            missing(
                t(
                    "server.artifact.entry.missing",
                    &[("title", row.title.as_str().into()), ("path", req.path.as_str().into())],
                ),
                LookIn::Artifact,
            )
        })?;
        Ok(entry_of(&entry, true))
    }

    pub async fn batch_entries_async(&self, maker: &Maker, req: &ArtifactEntryBatchRequest) -> Result<ArtifactEntryBatchResult, ApiError> {
        self.batch_entries_inner_async(maker, req, None).await
    }

    pub async fn batch_entries_with_meta_async(
        &self,
        maker: &Maker,
        req: &ArtifactEntryBatchRequest,
        meta: &CommitMeta,
    ) -> Result<ArtifactEntryBatchResult, ApiError> {
        self.batch_entries_inner_async(maker, req, Some(meta)).await
    }

    pub fn batch_entries_with_meta(&self, maker: &Maker, req: &ArtifactEntryBatchRequest, meta: &CommitMeta) -> Result<ArtifactEntryBatchResult, ApiError> {
        vibevalley_runtime::rt::block_on(self.batch_entries_with_meta_async(maker, req, meta))
    }

    async fn batch_entries_inner_async(
        &self,
        maker: &Maker,
        req: &ArtifactEntryBatchRequest,
        explicit_meta: Option<&CommitMeta>,
    ) -> Result<ArtifactEntryBatchResult, ApiError> {
        let write_lock = self.entry_lock(&req.id);
        let _guard = write_lock.lock().await;

        let (row, current_rows) = {
            let mut db = self.db.read_pool().acquire().await.map_err(q)?;
            let row = self.found_store_async(&mut db, &req.id).await?;
            for w in &req.writes {
                check_path(&w.path)?;
                if w.op == ArtifactEntryOp::Copy {
                    let from = w.from.as_deref().unwrap_or("").trim();
                    if from.is_empty() {
                        return Err(refused(t("server.artifact.entry.noFrom", &[("path", w.path.as_str().into())])));
                    }
                    check_path(from)?;
                }
            }
            if req.writes.is_empty() {
                return Ok(ArtifactEntryBatchResult {
                    applied: true,
                    seq: row.seq,
                    entries: vec![],
                    conflicts: vec![],
                });
            }
            let rows = db::entries(&mut db, &req.id).await.map_err(q)?;
            (row, rows)
        };

        // Resolve referenced attachments outside the DB lock to avoid nesting locks across modules.
        let existing_kinds: HashMap<String, ArtifactEntryKind> = current_rows.iter().map(|r| (r.path.clone(), entry_kind_of(&r.kind))).collect();
        let mut resolved_assets: HashMap<String, Attachment> = HashMap::new();
        for w in &req.writes {
            if w.op != ArtifactEntryOp::Set {
                continue;
            }
            let candidate_kind = w
                .kind
                .or_else(|| existing_kinds.get(&w.path).copied())
                .unwrap_or_else(|| infer_entry_kind(&w.path));
            if candidate_kind != ArtifactEntryKind::Asset {
                continue;
            }
            let value = w
                .value
                .as_deref()
                .ok_or_else(|| refused(t("server.artifact.entry.noValue", &[("path", w.path.as_str().into())])))?;
            let att_id = value.trim().to_string();
            if resolved_assets.contains_key(&att_id) {
                continue;
            }
            let found = self.files.of_async(std::slice::from_ref(&att_id)).await.ok().and_then(|mut list| list.pop());
            let Some(att) = found else {
                return Err(refused(t(
                    "server.artifact.entry.noAttachment",
                    &[("id", att_id.as_str().into()), ("path", w.path.as_str().into())],
                )));
            };
            resolved_assets.insert(att_id, att);
        }

        let artifact_type = row.artifact_type.as_deref().and_then(artifact_type_of);

        let (result, change) = {
            let mut db = self.db.write_pool().acquire().await.map_err(q)?;
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await.map_err(q)?;

            let collab_doc = self.load_or_bootstrap_store_doc_async(&mut tx, &row, &current_rows).await?;
            let mut working: BTreeMap<String, db::EntryRow> = current_rows.into_iter().map(|r| (r.path.clone(), r)).collect();

            // Check optimistic concurrency preconditions before mutating any entry.
            let mut seen_paths: BTreeSet<String> = BTreeSet::new();
            let mut conflicts: Vec<ArtifactEntryConflict> = vec![];
            for w in &req.writes {
                let Some(expected_rev) = w.if_rev else { continue };
                if !seen_paths.insert(w.path.clone()) {
                    continue;
                }
                let existing = working.get(&w.path);
                let actual_rev = existing.map_or(0, |r| r.rev);
                if expected_rev != actual_rev {
                    conflicts.push(ArtifactEntryConflict {
                        path: w.path.clone(),
                        expected_rev,
                        actual_rev,
                        current: existing.map(|r| entry_of(r, true)),
                    });
                }
            }
            if !conflicts.is_empty() {
                tx.rollback().await.map_err(q)?;
                return Ok(ArtifactEntryBatchResult {
                    applied: false,
                    seq: row.seq,
                    entries: vec![],
                    conflicts,
                });
            }

            let at = now();
            let mut upserted_paths: BTreeSet<String> = BTreeSet::new();
            let mut deleted_paths: BTreeSet<String> = BTreeSet::new();
            let max_kb = (ENTRY_MAX_BYTES / 1024) as i64;

            for w in &req.writes {
                match w.op {
                    ArtifactEntryOp::Delete => {
                        if working.remove(&w.path).is_some() {
                            upserted_paths.remove(&w.path);
                            deleted_paths.insert(w.path.clone());
                        }
                    }
                    ArtifactEntryOp::Copy => {
                        let from_path = w.from.as_deref().unwrap_or("");
                        let (src_kind, src_mime, src_value, src_attachment_id, src_size) = working
                            .get(from_path)
                            .map(|s| (s.kind.clone(), s.mime.clone(), s.value.clone(), s.attachment_id.clone(), s.size))
                            .ok_or_else(|| {
                                missing(
                                    t(
                                        "server.artifact.entry.missing",
                                        &[("title", row.title.as_str().into()), ("path", from_path.into())],
                                    ),
                                    LookIn::Artifact,
                                )
                            })?;
                        let prev_rev = working.get(&w.path).map_or(0, |r| r.rev);
                        let next_kind = w.kind.unwrap_or_else(|| entry_kind_of(&src_kind));
                        let next_mime = w
                            .mime
                            .as_deref()
                            .map(str::trim)
                            .filter(|m| !m.is_empty())
                            .map(str::to_string)
                            .or_else(|| (!src_mime.is_empty()).then_some(src_mime))
                            .unwrap_or_else(|| infer_entry_mime(&w.path, next_kind).to_string());
                        working.insert(
                            w.path.clone(),
                            db::EntryRow {
                                artifact_id: req.id.clone(),
                                path: w.path.clone(),
                                kind: next_kind.as_str().to_string(),
                                mime: next_mime,
                                value: src_value,
                                attachment_id: src_attachment_id,
                                size: src_size,
                                rev: prev_rev + 1,
                                updated_by: maker.by.clone(),
                                updated_at: at,
                            },
                        );
                        deleted_paths.remove(&w.path);
                        upserted_paths.insert(w.path.clone());
                    }
                    ArtifactEntryOp::Set => {
                        let value = w
                            .value
                            .as_deref()
                            .ok_or_else(|| refused(t("server.artifact.entry.noValue", &[("path", w.path.as_str().into())])))?;
                        let prev = working.get(&w.path);
                        let prev_rev = prev.map_or(0, |r| r.rev);
                        let kind = w
                            .kind
                            .or_else(|| prev.map(|r| entry_kind_of(&r.kind)))
                            .unwrap_or_else(|| infer_entry_kind(&w.path));
                        let mime = w
                            .mime
                            .as_deref()
                            .map(str::trim)
                            .filter(|m| !m.is_empty())
                            .map(str::to_string)
                            .unwrap_or_else(|| infer_entry_mime(&w.path, kind).to_string());
                        match kind {
                            ArtifactEntryKind::Asset => {
                                let att_id = value.trim();
                                let att = resolved_assets.get(att_id).ok_or_else(|| {
                                    refused(t(
                                        "server.artifact.entry.noAttachment",
                                        &[("id", att_id.into()), ("path", w.path.as_str().into())],
                                    ))
                                })?;
                                let asset_mime = w
                                    .mime
                                    .as_deref()
                                    .map(str::trim)
                                    .filter(|m| !m.is_empty())
                                    .map(str::to_string)
                                    .or_else(|| (!att.r#type.is_empty()).then(|| att.r#type.clone()))
                                    .unwrap_or(mime);
                                working.insert(
                                    w.path.clone(),
                                    db::EntryRow {
                                        artifact_id: req.id.clone(),
                                        path: w.path.clone(),
                                        kind: "asset".into(),
                                        mime: asset_mime,
                                        value: None,
                                        attachment_id: Some(att.id.clone()),
                                        size: att.size,
                                        rev: prev_rev + 1,
                                        updated_by: maker.by.clone(),
                                        updated_at: at,
                                    },
                                );
                            }
                            ArtifactEntryKind::Json => {
                                let canon = canonical_json(value)
                                    .map_err(|why| refused(t("server.artifact.entry.badJson", &[("path", w.path.as_str().into()), ("why", why.into())])))?;
                                let checked_json = sanitize_whiteboard_element_json(artifact_type, &w.path, &canon)?;
                                let size = checked_json.len();
                                if size > ENTRY_MAX_BYTES {
                                    return Err(refused(t(
                                        "server.artifact.entry.tooBig",
                                        &[("path", w.path.as_str().into()), ("kb", max_kb.into())],
                                    )));
                                }
                                working.insert(
                                    w.path.clone(),
                                    db::EntryRow {
                                        artifact_id: req.id.clone(),
                                        path: w.path.clone(),
                                        kind: "json".into(),
                                        mime,
                                        value: Some(checked_json),
                                        attachment_id: None,
                                        size: size as i64,
                                        rev: prev_rev + 1,
                                        updated_by: maker.by.clone(),
                                        updated_at: at,
                                    },
                                );
                            }
                            ArtifactEntryKind::Text => {
                                let text_val = if mime == "image/svg+xml" || w.path.ends_with(".svg") {
                                    sanitize_whiteboard_svg(value)
                                } else {
                                    value.to_string()
                                };
                                let size = text_val.len();
                                if size > ENTRY_MAX_BYTES {
                                    return Err(refused(t(
                                        "server.artifact.entry.tooBig",
                                        &[("path", w.path.as_str().into()), ("kb", max_kb.into())],
                                    )));
                                }
                                if mime == "text/html" || w.path.ends_with(".html") {
                                    let hp = store_html_problem(&text_val);
                                    if !hp.is_empty() {
                                        return Err(refused(hp));
                                    }
                                }
                                working.insert(
                                    w.path.clone(),
                                    db::EntryRow {
                                        artifact_id: req.id.clone(),
                                        path: w.path.clone(),
                                        kind: "text".into(),
                                        mime,
                                        value: Some(text_val),
                                        attachment_id: None,
                                        size: size as i64,
                                        rev: prev_rev + 1,
                                        updated_by: maker.by.clone(),
                                        updated_at: at,
                                    },
                                );
                            }
                        }
                        deleted_paths.remove(&w.path);
                        upserted_paths.insert(w.path.clone());
                    }
                    ArtifactEntryOp::Patch => {
                        let value = w
                            .value
                            .as_deref()
                            .ok_or_else(|| refused(t("server.artifact.entry.noValue", &[("path", w.path.as_str().into())])))?;
                        let prev = working.get(&w.path);
                        let prev_rev = prev.map_or(0, |r| r.rev);
                        let kind = prev.map(|r| entry_kind_of(&r.kind)).or(w.kind).unwrap_or_else(|| infer_entry_kind(&w.path));
                        if kind != ArtifactEntryKind::Json {
                            return Err(refused(t(
                                "server.artifact.entry.notJson",
                                &[("path", w.path.as_str().into()), ("kind", kind.as_str().into())],
                            )));
                        }
                        let merged = apply_json_merge_patch(prev.and_then(|r| r.value.as_deref()), value)
                            .map_err(|why| refused(t("server.artifact.entry.badJson", &[("path", w.path.as_str().into()), ("why", why.into())])))?;
                        let checked_json = sanitize_whiteboard_element_json(artifact_type, &w.path, &merged)?;
                        let size = checked_json.len();
                        if size > ENTRY_MAX_BYTES {
                            return Err(refused(t(
                                "server.artifact.entry.tooBig",
                                &[("path", w.path.as_str().into()), ("kb", max_kb.into())],
                            )));
                        }
                        let mime = w
                            .mime
                            .as_deref()
                            .map(str::trim)
                            .filter(|m| !m.is_empty())
                            .map(str::to_string)
                            .or_else(|| prev.map(|r| r.mime.clone()))
                            .unwrap_or_else(|| "application/json".into());
                        working.insert(
                            w.path.clone(),
                            db::EntryRow {
                                artifact_id: req.id.clone(),
                                path: w.path.clone(),
                                kind: "json".into(),
                                mime,
                                value: Some(checked_json),
                                attachment_id: None,
                                size: size as i64,
                                rev: prev_rev + 1,
                                updated_by: maker.by.clone(),
                                updated_at: at,
                            },
                        );
                        deleted_paths.remove(&w.path);
                        upserted_paths.insert(w.path.clone());
                    }
                }
            }

            if working.len() > ENTRY_MAX_COUNT {
                return Err(refused(t("server.artifact.entry.tooMany", &[("max", (ENTRY_MAX_COUNT as i64).into())])));
            }
            if upserted_paths.is_empty() && deleted_paths.is_empty() {
                tx.rollback().await.map_err(q)?;
                return Ok(ArtifactEntryBatchResult {
                    applied: true,
                    seq: row.seq,
                    entries: vec![],
                    conflicts: vec![],
                });
            }

            let removed_paths: Vec<String> = deleted_paths.into_iter().collect();
            let changed_paths: Vec<String> = upserted_paths.into_iter().collect();

            for p in &removed_paths {
                db::delete_entry(&mut tx, &req.id, p).await.map_err(q)?;
            }
            for p in &changed_paths {
                if let Some(next) = working.get(p) {
                    db::upsert_entry(
                        &mut tx,
                        db::UpsertEntry {
                            artifact_id: next.artifact_id.clone(),
                            path: next.path.clone(),
                            kind: next.kind.clone(),
                            mime: next.mime.clone(),
                            value: next.value.clone(),
                            attachment_id: next.attachment_id.clone(),
                            size: next.size,
                            rev: next.rev,
                            updated_by: next.updated_by.clone(),
                            updated_at: next.updated_at,
                        },
                    )
                    .await
                    .map_err(q)?;
                }
            }

            let seq = row.seq + 1;
            db::add_entry_change(&mut tx, &req.id, seq, &maker.by, &changed_paths, &removed_paths, at)
                .await
                .map_err(q)?;
            db::artifact_accepted(&mut tx, &req.id, seq, at).await.map_err(q)?;
            let meta = explicit_meta.cloned().unwrap_or_else(|| commit_meta_for_maker(maker, req.note.clone(), at));
            Self::sync_store_to_collab_async(&mut tx, &row.id, &collab_doc, &working, &changed_paths, &removed_paths, &meta).await?;
            tx.commit().await.map_err(q)?;

            let full_entries: Vec<ArtifactEntry> = changed_paths.iter().filter_map(|p| working.get(p).map(|r| entry_of(r, true))).collect();
            let event_entries: Vec<ArtifactEntry> = changed_paths
                .iter()
                .filter_map(|p| working.get(p).map(|r| entry_of(r, r.size <= INLINE_EVENT_MAX_BYTES as i64)))
                .collect();
            let change = EntryChange {
                artifact: req.id.clone(),
                seq,
                entries: event_entries,
                deleted: removed_paths,
            };
            (
                ArtifactEntryBatchResult {
                    applied: true,
                    seq,
                    entries: full_entries,
                    conflicts: vec![],
                },
                change,
            )
        };

        let seq = change.seq;
        let _ = self.entry_changes.send(change);
        if req.announce == Some(true) {
            let channel = self.channel.place_of(&maker.from, row.channel_id.as_deref().unwrap_or(""))?;
            let note = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
            let card = ArtifactCard {
                id: row.id.clone(),
                title: row.title.clone(),
                body: ArtifactBody::Store,
                version: seq,
                note: note.unwrap_or("").into(),
                display: None,
                artifact_type,
            };
            let text = Self::words(
                t("server.artifact.entry.updated", &[("title", row.title.as_str().into()), ("seq", seq.into())]),
                note,
            );
            let said = self.channel.post_card(&maker.from, &channel, &text, card, maker.run.clone(), String::new())?;
            if row.message_id.is_none() {
                let mut db = self.db.write_pool().acquire().await.map_err(q)?;
                db::artifact_said(&mut db, &row.id, &said.id).await.map_err(q)?;
            }
        }

        Ok(result)
    }

    pub fn follow_entries(&self, hub: &Hub, id: &str, after: i64, sink: Sink) -> Result<(), ApiError> {
        let (rx, missed, current) = vibevalley_runtime::rt::block_on(async {
            let mut db = self.db.read_pool().acquire().await.map_err(q)?;
            self.found_store_async(&mut db, id).await?;
            // Subscribe before reading catch-up; live events are deduplicated by seq.
            let rx = self.entry_changes.subscribe();
            let missed = db::entry_changes_after(&mut db, id, after, CATCH_UP_MAX as i64 + 1).await.map_err(q)?;
            let current: HashMap<String, db::EntryRow> = db::entries(&mut db, id).await.map_err(q)?.into_iter().map(|r| (r.path.clone(), r)).collect();
            Ok::<_, ApiError>((rx, missed, current))
        })?;
        let id = id.to_string();
        let hub_cancel = hub.child_token();
        let closed = self.cancel.clone();
        hub.spawn_task(async move {
            if missed.len() > CATCH_UP_MAX {
                sink.send(&ArtifactEntryEvent::Reset {});
                return;
            }
            let upto = missed.last().map_or(after, |c| c.seq);
            for c in &missed {
                let entries: Vec<ArtifactEntry> = c
                    .paths
                    .iter()
                    .filter_map(|p| current.get(p).map(|r| entry_of(r, r.size <= INLINE_EVENT_MAX_BYTES as i64)))
                    .collect();
                if !sink.send(&ArtifactEntryEvent::Entries {
                    seq: c.seq,
                    entries,
                    deleted: c.deleted.clone(),
                }) {
                    return;
                }
            }
            relay_with_reset(rx, hub_cancel, closed, &sink, ArtifactEntryEvent::Reset {}, |c: EntryChange| {
                (c.artifact == id && c.seq > upto).then_some(ArtifactEntryEvent::Entries {
                    seq: c.seq,
                    entries: c.entries,
                    deleted: c.deleted,
                })
            })
            .await;
        });
        Ok(())
    }

    /// Renders a store artifact's sandboxed HTML viewer document and CSP headers
    /// (`artifact.view` native op & `GET /api/v1/artifact/:id/view`).
    pub async fn view_async(&self, req: &ArtifactViewInput) -> Result<ArtifactPage, ApiError> {
        let (row, rows, default_tokens_json) = {
            let mut db = self.db.read_pool().acquire().await.map_err(q)?;
            let row = self.found_store_async(&mut db, &req.id).await?;
            let rows = db::entries(&mut db, &req.id).await.map_err(q)?;
            let default_tokens_json = match db::default_design_system_artifact(&mut db).await.map_err(q)? {
                Some(ds) if ds.id != req.id => db::entry(&mut db, &ds.id, "project/tokens.json").await.map_err(q)?.and_then(|e| e.value),
                _ => None,
            };
            (row, rows, default_tokens_json)
        };
        let entries: Vec<ArtifactEntry> = rows.iter().map(|r| entry_of(r, true)).collect();
        let artifact_type = row.artifact_type.as_deref().and_then(artifact_type_of);
        let options = RenderStoreOptions {
            theme: shell_theme_of(req.theme.as_deref()).to_string(),
            path: req.path.clone(),
            element_id: req.element_id.clone(),
            default_tokens_json,
        };
        let rendered = render_store_artifact_html(artifact_type, &entries, &options);
        let content = self.inject_presence_highlights(&req.id, rendered, true);
        let headers = store_view_headers(req.origin.as_deref(), req.print == Some(true))
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        Ok(ArtifactPage { content, headers })
    }

    /// Rewrites declared `data-props` defaults in a `.dc.html` store entry and commits the update.
    pub async fn write_entry_props_async(&self, maker: &Maker, req: &ArtifactEntryWritePropsInput) -> Result<ArtifactEntryBatchResult, ApiError> {
        let entry = self
            .get_entry_async(&ArtifactEntryGetRequest {
                id: req.id.clone(),
                path: req.path.clone(),
            })
            .await?;
        let source = entry.value.as_deref().unwrap_or("");
        let values: BTreeMap<String, Value> = req
            .values
            .iter()
            .map(|(k, v)| {
                let json_val = match v {
                    DesignPropValue::Bool(b) => Value::Bool(*b),
                    DesignPropValue::Number(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
                    DesignPropValue::String(s) => Value::String(s.clone()),
                };
                (k.clone(), json_val)
            })
            .collect();
        let updated = write_props_into_dc_html(source, &values);
        self.batch_entries_async(
            maker,
            &ArtifactEntryBatchRequest {
                id: req.id.clone(),
                writes: vec![ArtifactEntryWriteInput {
                    op: ArtifactEntryOp::Set,
                    path: req.path.clone(),
                    kind: Some(ArtifactEntryKind::Text),
                    value: Some(updated),
                    from: None,
                    mime: Some(entry.mime),
                    if_rev: Some(entry.rev),
                }],
                note: None,
                announce: Some(false),
            },
        )
        .await
    }

    /// Parses a design-system `tokens.json` payload, computes WCAG contrast against the surface swatch, and compiles CSS.
    pub fn inspect_tokens(req: &ArtifactTokensInspectInput) -> InspectedTokensSpec {
        let parsed = parse_tokens_spec(&req.raw);
        let surface_light = parsed.colors.iter().find(|c| c.id == "surface" || c.id == "page").map(|c| c.light.as_str());
        let surface_dark = parsed.colors.iter().find(|c| c.id == "surface" || c.id == "page").map(|c| c.dark.as_str());
        let colors = parsed
            .colors
            .iter()
            .map(|c| {
                let is_surface = c.id == "surface" || c.id == "page";
                InspectedColorSwatch {
                    id: c.id.clone(),
                    group: c.group.clone(),
                    light: c.light.clone(),
                    dark: c.dark.clone(),
                    note: c.note.clone(),
                    contrast_light: if is_surface {
                        None
                    } else {
                        surface_light.and_then(|bg| contrast_ratio(&c.light, bg))
                    },
                    contrast_dark: if is_surface {
                        None
                    } else {
                        surface_dark.and_then(|bg| contrast_ratio(&c.dark, bg))
                    },
                }
            })
            .collect();
        InspectedTokensSpec {
            themes: parsed.themes,
            default_theme: parsed.default_theme,
            colors,
            families: parsed
                .families
                .into_iter()
                .map(|f| InspectedTypeFamily {
                    id: f.id,
                    value: f.value,
                    note: f.note,
                })
                .collect(),
            scale: parsed.scale.into_iter().map(|s| InspectedTokenValue { id: s.id, value: s.value }).collect(),
            styles: parsed
                .styles
                .into_iter()
                .map(|st| InspectedTypeStyle {
                    id: st.id,
                    family: st.family,
                    size: st.size,
                    weight: st.weight,
                    line_height: st.line_height,
                    letter_spacing: st.letter_spacing,
                    sample: st.sample,
                })
                .collect(),
            space: parsed.space.into_iter().map(|s| InspectedTokenValue { id: s.id, value: s.value }).collect(),
            radius: parsed.radius.into_iter().map(|r| InspectedTokenValue { id: r.id, value: r.value }).collect(),
            css: parsed.css,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::collab::channel::Chat;
    use crate::modules::content::attachment::Attachments;
    use vibevalley_protocol::{ArtifactHtmlEdit, ArtifactKind, ArtifactRequest, HtmlAnchor, HtmlAnchorKind};

    fn test_artifacts() -> (tempfile::TempDir, Arc<Artifacts>) {
        vibevalley_i18n::set_locale("zh");
        let dir = tempfile::tempdir().unwrap();
        let db = crate::base::ServerDb::open(dir.path()).unwrap();
        let hub = crate::Hub::new(vibevalley_core::empty_space_state());
        let files = Attachments::open(dir.path(), db.clone());
        let chat = Chat::open(db.clone(), &hub, files.clone(), None, false).unwrap();
        let artifacts = Artifacts::open(db, files, chat);
        (dir, artifacts)
    }

    #[test]
    fn inspect_tokens_computes_swatches_contrast_and_css() {
        let starters = vibevalley_core::artifact::starter_entries_for_type(ArtifactType::DesignSystem, "Brand");
        let raw = starters
            .iter()
            .find(|e| e.path == "project/tokens.json")
            .and_then(|e| e.value.as_deref())
            .unwrap();
        let inspected = Artifacts::inspect_tokens(&ArtifactTokensInspectInput { raw: raw.to_string() });
        assert!(inspected.colors.len() >= 4);
        assert!(inspected.css.contains("[data-theme=\"light\"]"));
        assert!(inspected.css.contains("[data-theme=\"dark\"]"));
        let non_surface = inspected.colors.iter().find(|c| c.id != "surface" && c.id != "page").unwrap();
        assert!(non_surface.contrast_light.is_some());
        assert!(non_surface.contrast_dark.is_some());
    }

    #[test]
    fn store_create_seeds_starters_and_supports_html_edit_and_write_props() {
        let (_dir, artifacts) = test_artifacts();
        let maker = Maker::user();

        vibevalley_runtime::rt::block_on(async {
            // 1. Omitting `entries` on a typed store seeds starters server-side.
            let slides = artifacts
                .create_async(
                    &maker,
                    &ArtifactRequest {
                        title: "Q4 Deck".into(),
                        kind: Some(ArtifactKind::Store),
                        artifact_type: Some(ArtifactType::Slides),
                        display: None,
                        content: None,
                        entries: None,
                        is_default: None,
                        announce: None,
                        note: None,
                        channel: None,
                        issue: None,
                    },
                )
                .await
                .unwrap();
            assert_eq!(slides.seq, 1);
            let snap = artifacts
                .list_entries_async(&ArtifactEntryListRequest {
                    id: slides.id.clone(),
                    prefix: None,
                    include_values: Some(true),
                })
                .await
                .unwrap();
            let slide = snap
                .entries
                .iter()
                .find(|e| e.path.starts_with("project/slides/") && e.path.ends_with(".html"))
                .unwrap();
            assert!(slide.value.as_deref().unwrap().contains("Q4 Deck"));

            // 2. `html_edit` with `path` edits the slide entry via Rust `html_edit`.
            let edited_art = artifacts
                .html_edit_async(
                    &maker,
                    &ArtifactHtmlEdit {
                        id: slides.id.clone(),
                        version: slides.seq,
                        path: Some(slide.path.clone()),
                        anchor: HtmlAnchor {
                            kind: HtmlAnchorKind::Text,
                            exact: "Q4 Deck".into(),
                            prefix: String::new(),
                            suffix: String::new(),
                        },
                        text: "Q1 Roadmap".into(),
                    },
                )
                .await
                .unwrap();
            assert_eq!(edited_art.seq, 2);
            let updated_slide = artifacts
                .get_entry_async(&ArtifactEntryGetRequest {
                    id: slides.id.clone(),
                    path: slide.path.clone(),
                })
                .await
                .unwrap();
            assert!(updated_slide.value.as_deref().unwrap().contains("Q1 Roadmap"));

            // 3. `write_entry_props` updates `data-props` defaults in a `.dc.html` entry.
            let design = artifacts
                .create_async(
                    &maker,
                    &ArtifactRequest {
                        title: "Hero".into(),
                        kind: Some(ArtifactKind::Store),
                        artifact_type: Some(ArtifactType::Design),
                        display: None,
                        content: None,
                        entries: Some(vec![ArtifactEntryWriteInput {
                            op: ArtifactEntryOp::Set,
                            path: "project/main.dc.html".into(),
                            kind: Some(ArtifactEntryKind::Text),
                            value: Some(
                                r#"<x-dc data-props='[{"name":"density","type":"select","options":["comfortable","compact"],"value":"comfortable"}]'><div>Body</div></x-dc>"#
                                    .into(),
                            ),
                            from: None,
                            mime: None,
                            if_rev: None,
                        }]),
                        is_default: None,
                        announce: None,
                        note: None,
                        channel: None,
                        issue: None,
                    },
                )
                .await
                .unwrap();
            let res = artifacts
                .write_entry_props_async(
                    &maker,
                    &ArtifactEntryWritePropsInput {
                        id: design.id.clone(),
                        path: "project/main.dc.html".into(),
                        values: BTreeMap::from([("density".into(), DesignPropValue::String("compact".into()))]),
                    },
                )
                .await
                .unwrap();
            assert!(res.applied);
            let dc = artifacts
                .get_entry_async(&ArtifactEntryGetRequest {
                    id: design.id,
                    path: "project/main.dc.html".into(),
                })
                .await
                .unwrap();
            assert!(dc.value.as_deref().unwrap().contains(r#""value":"compact""#));
        });
        artifacts.close();
    }

    #[test]
    fn sanitize_whiteboard_element_strips_unsafe_sticker_and_svg_markup() {
        let dirty_card = r#"{"id":"c1","type":"shape","shape":"card","title":"Demo","stickerSvg":"<svg viewBox='0 0 64 64' onload='alert(1)'><script>bad()</script><rect x='4' y='4' width='56' height='56' onclick='x()'/><path d='M8 8L56 56'/><circle cx='32' cy='32' r='8'/><a href='https://evil.example'><text>Hi</text></a></svg>"}"#;
        let clean_card = sanitize_whiteboard_element_json(Some(ArtifactType::Whiteboard), "elements/c1", dirty_card).unwrap();
        assert!(!clean_card.contains("<script"));
        assert!(!clean_card.contains("onload"));
        assert!(!clean_card.contains("onclick"));
        assert!(!clean_card.contains("evil.example"));
        assert!(clean_card.contains("<rect"));
        assert!(clean_card.contains("<path"));
        assert!(clean_card.contains("<circle"));

        let dirty_sticker = r#"{"id":"st1","type":"sticker","x":10,"y":20,"w":80,"h":80,"svg":"<svg viewBox='0 0 64 64' onload='evil()'><script>x</script><circle cx='32' cy='32' r='20'/></svg>"}"#;
        let clean_sticker = sanitize_whiteboard_element_json(Some(ArtifactType::Whiteboard), "elements/st1", dirty_sticker).unwrap();
        assert!(!clean_sticker.contains("<script"));
        assert!(!clean_sticker.contains("onload"));
        assert!(clean_sticker.contains("<circle"));
    }
}
