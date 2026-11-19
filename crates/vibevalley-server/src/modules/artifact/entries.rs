//! Structured artifact entry store (`entries.ts`): optimistic concurrency
//! batches (`set`/`patch`/`delete`/`copy`), attachment links, SVG/HTML
//! sanitization, SSE replay/broadcast (`artifact.entry.follow`), and sandboxed
//! HTML viewer rendering (`artifact.view`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use vibevalley_artifact::{
    ENTRY_MAX_BYTES, ENTRY_MAX_COUNT, INLINE_EVENT_MAX_BYTES, RenderStoreOptions, apply_json_merge_patch, canonical_json, entry_path_problem,
    format_store_summary, infer_entry_kind, infer_entry_mime, render_store_artifact_html, sanitize_whiteboard_svg, shell_theme_of, store_html_problem,
    store_view_headers,
};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, ArtifactBody, ArtifactCard, ArtifactEntry, ArtifactEntryBatchRequest, ArtifactEntryBatchResult, ArtifactEntryConflict, ArtifactEntryEvent,
    ArtifactEntryGetRequest, ArtifactEntryKind, ArtifactEntryListRequest, ArtifactEntryOp, ArtifactEntrySnapshot, ArtifactPage, ArtifactType,
    ArtifactViewInput, Attachment,
};

use super::blocks::relay;
use super::{Artifacts, Maker, artifact_type_of, db, q, refused};
use crate::base::{LookIn, missing};
use crate::modules::channel::{Made, Posting};
use crate::{Sink, lock, now};

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
    if elem_type == Some("svg")
        && let Some(svg) = map.get("svg").and_then(Value::as_str)
    {
        let clean = sanitize_whiteboard_svg(svg);
        map.insert("svg".into(), Value::String(clean));
        return serde_json::to_string(&parsed).map_err(crate::base::internal);
    }
    if elem_type == Some("html")
        && let Some(html) = map.get("html").and_then(Value::as_str)
    {
        let hp = store_html_problem(html);
        if !hp.is_empty() {
            return Err(refused(hp));
        }
    }
    Ok(canonical_text.to_string())
}

impl Artifacts {
    fn entry_lock(&self, id: &str) -> Arc<Mutex<()>> {
        let mut map = lock(&self.entry_locks);
        map.entry(id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    fn found_store(&self, db: &mut SqliteConnection, id: &str) -> Result<db::ArtifactRow, ApiError> {
        let row = self.found(db, id)?;
        if row.body != "store" {
            return Err(refused(t("server.artifact.notStore", &[("title", row.title.as_str().into())])));
        }
        Ok(row)
    }

    pub(super) fn entry_count(&self, id: &str) -> Result<i64, ApiError> {
        db::entry_count(&mut self.db(), id).map_err(q)
    }

    pub(super) fn store_summary(&self, row: &db::ArtifactRow) -> Result<String, ApiError> {
        let rows = db::entries(&mut self.db(), &row.id).map_err(q)?;
        let entries: Vec<ArtifactEntry> = rows.iter().map(|r| entry_of(r, true)).collect();
        let artifact_type = row.artifact_type.as_deref().and_then(artifact_type_of);
        Ok(format_store_summary(&row.title, artifact_type, row.seq, &entries))
    }

    pub fn list_entries(&self, req: &ArtifactEntryListRequest) -> Result<ArtifactEntrySnapshot, ApiError> {
        let mut db = self.db();
        let row = self.found_store(&mut db, &req.id)?;
        let prefix = req.prefix.as_deref().map(str::trim).unwrap_or("");
        let include_values = req.include_values == Some(true);
        let rows = if prefix.is_empty() {
            db::entries(&mut db, &req.id).map_err(q)?
        } else {
            db::entries_by_prefix(&mut db, &req.id, prefix).map_err(q)?
        };
        let seq = row.seq;
        let artifact = self.assemble(&mut db, row)?;
        Ok(ArtifactEntrySnapshot {
            artifact,
            seq,
            entries: rows.iter().map(|r| entry_of(r, include_values)).collect(),
        })
    }

    pub fn get_entry(&self, req: &ArtifactEntryGetRequest) -> Result<ArtifactEntry, ApiError> {
        let mut db = self.db();
        let row = self.found_store(&mut db, &req.id)?;
        check_path(&req.path)?;
        let entry = db::entry(&mut db, &req.id, &req.path).map_err(q)?.ok_or_else(|| {
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

    pub fn batch_entries(&self, maker: &Maker, req: &ArtifactEntryBatchRequest) -> Result<ArtifactEntryBatchResult, ApiError> {
        let write_lock = self.entry_lock(&req.id);
        let _guard = lock(&write_lock);

        let (row, current_rows) = {
            let mut db = self.db();
            let row = self.found_store(&mut db, &req.id)?;
            if req.writes.is_empty() {
                return Ok(ArtifactEntryBatchResult {
                    applied: true,
                    seq: row.seq,
                    entries: vec![],
                    conflicts: vec![],
                });
            }
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
            let rows = db::entries(&mut db, &req.id).map_err(q)?;
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
            let found = self.files.of(std::slice::from_ref(&att_id)).ok().and_then(|mut list| list.pop());
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
            let mut db = self.db();
            let mut tx = pollster::block_on(db.begin()).map_err(q)?;

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
                pollster::block_on(tx.rollback()).map_err(q)?;
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
                pollster::block_on(tx.rollback()).map_err(q)?;
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
                db::delete_entry(&mut tx, &req.id, p).map_err(q)?;
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
                    .map_err(q)?;
                }
            }

            let seq = row.seq + 1;
            db::add_entry_change(&mut tx, &req.id, seq, &maker.by, &changed_paths, &removed_paths, at).map_err(q)?;
            db::artifact_accepted(&mut tx, &req.id, seq, at).map_err(q)?;
            pollster::block_on(tx.commit()).map_err(q)?;

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
        lock(&self.entry_changes).retain(|tx| tx.send(change.clone()).is_ok());
        if req.announce == Some(true) {
            let channel = self.chat.place_of(&maker.from, row.channel_id.as_deref().unwrap_or(""))?;
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
            let (said, _) = self.chat.post(Posting {
                from: maker.from.clone(),
                channel,
                text: Self::words(
                    t("server.artifact.entry.updated", &[("title", row.title.as_str().into()), ("seq", seq.into())]),
                    note,
                ),
                made: Some(Made::Card(card)),
                run: maker.run.clone(),
                ..Posting::default()
            })?;
            if row.message_id.is_none() {
                db::artifact_said(&mut self.db(), &row.id, &said.id).map_err(q)?;
            }
        }

        Ok(result)
    }

    pub fn follow_entries(&self, id: &str, after: i64, sink: Sink) -> Result<(), ApiError> {
        let (rx, missed, current) = {
            let mut db = self.db();
            self.found_store(&mut db, id)?;
            // Subscribe before reading catch-up; live events are deduplicated by seq.
            let (tx, rx) = flume::unbounded();
            lock(&self.entry_changes).push(tx);
            let missed = db::entry_changes_after(&mut db, id, after, CATCH_UP_MAX as i64 + 1).map_err(q)?;
            let current: HashMap<String, db::EntryRow> = db::entries(&mut db, id).map_err(q)?.into_iter().map(|r| (r.path.clone(), r)).collect();
            (rx, missed, current)
        };
        let id = id.to_string();
        std::thread::Builder::new()
            .name("vibevalley-artifact-entry-follow".into())
            .spawn(move || {
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
                relay(&rx, &sink, |c: EntryChange| {
                    (c.artifact == id && c.seq > upto).then_some(ArtifactEntryEvent::Entries {
                        seq: c.seq,
                        entries: c.entries,
                        deleted: c.deleted,
                    })
                });
            })
            .map_err(crate::base::internal)?;
        Ok(())
    }

    /// Renders a store artifact's sandboxed HTML viewer document and CSP headers
    /// (`artifact.view` native op & `GET /api/v1/artifact/:id/view`).
    pub fn view(&self, req: &ArtifactViewInput) -> Result<ArtifactPage, ApiError> {
        let (row, rows, default_tokens_json) = {
            let mut db = self.db();
            let row = self.found_store(&mut db, &req.id)?;
            let rows = db::entries(&mut db, &req.id).map_err(q)?;
            let default_tokens_json = match db::default_design_system_artifact(&mut db).map_err(q)? {
                Some(ds) if ds.id != req.id => db::entry(&mut db, &ds.id, "project/tokens.json").map_err(q)?.and_then(|e| e.value),
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
        let content = render_store_artifact_html(artifact_type, &entries, &options);
        let headers = store_view_headers(req.origin.as_deref(), req.print == Some(true))
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        Ok(ArtifactPage { content, headers })
    }
}
