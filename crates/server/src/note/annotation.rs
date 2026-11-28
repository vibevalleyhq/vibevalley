//! Non-destructive image annotation mutations (`#144`) and bidirectional
//! `BaseEmbed × MediaAnnotation` review checklist sync (`#145`).

use vibevalley_core::note::annotation::{
    collect_doc_annotations, delete_doc_block_annotation, delete_media_doc_annotation, doc_annotation_summary, find_first_base_embed,
    mutate_doc_annotation_by_id, summarize_annotations, upsert_doc_block_annotation, upsert_media_doc_annotation,
};
use vibevalley_core::note::base::{BaseDocument, serialize_base_document};
use vibevalley_core::note::doc::{DocDocument, append_block, parse_doc_document, serialize_doc_document};
use vibevalley_core::note::review::{
    apply_annotation_to_base_row, apply_base_row_patch_to_annotation, clear_annotation_ref_on_base_sheet, extract_annotation_patch_from_base_row,
    reconcile_review_checklist, review_checklist_base_document,
};
use vibevalley_protocol::{
    ApiError, BaseViewRequest, BlockKind, DocBlock, MediaAnnotation, NoteAnnotationDeleteRequest, NoteAnnotationMutationResult, NoteAnnotationUpsertRequest,
    NoteFileEncoding, NoteFileWriteItem, NoteFileWriteRequest, NoteRequest, NoteReviewSyncRequest, NoteReviewSyncResult, NoteType, ReviewSyncDirection,
};

use super::{Maker, Manager, NOTE_USER_ORIGIN, new_id, note_type_of, refused};

struct AnnotationBaseSyncTarget<'a> {
    doc_note_id: &'a str,
    block_id: &'a str,
    asset_src: Option<&'a str>,
    annotation: &'a MediaAnnotation,
    base_note_id: &'a str,
    base_sheet_id: Option<&'a str>,
    origin: Option<String>,
}

impl Manager {
    async fn load_doc_for_note_async(&self, id: &str) -> Result<DocDocument, ApiError> {
        let raw_files = self.storage.note.read_all_raw_async(id, None).await?;
        if let Some(bytes) = raw_files.get("structure/doc.json")
            && let Ok(text) = std::str::from_utf8(bytes)
        {
            parse_doc_document(text).map_err(refused)
        } else {
            Ok(DocDocument::default())
        }
    }

    async fn write_structure_json_async(
        &self,
        maker: &Maker,
        note_id: &str,
        path: &str,
        encoded: String,
        origin: Option<String>,
        summary: &str,
    ) -> Result<(), ApiError> {
        let now = self.ctx.now();
        let meta = super::collab::commit_meta_for_maker(maker, Some(summary.to_owned()), now);
        self.write_files_with_meta_async(
            maker,
            &NoteFileWriteRequest {
                id: note_id.to_owned(),
                files: vec![NoteFileWriteItem {
                    path: path.to_owned(),
                    content: encoded,
                    encoding: Some(NoteFileEncoding::Utf8),
                    mime: Some("application/json".to_owned()),
                    expected_hash: None,
                }],
                origin: origin.or_else(|| Some(NOTE_USER_ORIGIN.to_owned())),
                summary: Some(summary.to_owned()),
                announce: Some(false),
            },
            &meta,
        )
        .await?;
        Ok(())
    }

    async fn sync_single_annotation_to_base_async(&self, maker: &Maker, target: AnnotationBaseSyncTarget<'_>) -> Result<Option<String>, ApiError> {
        self.flush_pending_writes_async(target.base_note_id).await;
        let mut base_doc = self.load_base_doc_async(target.base_note_id).await?;
        let sheet = match target.base_sheet_id {
            Some(sid) => base_doc
                .sheets
                .iter_mut()
                .find(|s| s.id == sid)
                .ok_or_else(|| refused(format!("sheet {sid} not found")))?,
            None => base_doc.sheets.first_mut().ok_or_else(|| refused("base has no sheets"))?,
        };
        let now = self.ctx.now();
        let gen_row_id = new_id("row");
        let (row_id, changed) = apply_annotation_to_base_row(
            sheet,
            target.doc_note_id,
            target.block_id,
            target.asset_src,
            target.annotation,
            now,
            &gen_row_id,
        );
        if changed {
            let encoded = serialize_base_document(&base_doc).map_err(refused)?;
            self.write_structure_json_async(
                maker,
                target.base_note_id,
                "structure/base.json",
                encoded,
                target.origin,
                "Sync annotation to base row",
            )
            .await?;
        }
        Ok(Some(row_id))
    }

    /// Upserts a non-destructive [`MediaAnnotation`] onto a `doc` media/compare block or `media` note
    /// without mutating image bytes, and optionally syncs its linked `base` checklist row.
    pub async fn annotation_upsert_async(&self, maker: &Maker, req: &NoteAnnotationUpsertRequest) -> Result<NoteAnnotationMutationResult, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        let now = self.ctx.now();
        let gen_id = new_id("ann");

        match ty {
            NoteType::Doc => {
                let block_id = req
                    .block_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| refused("blockId is required for doc note annotations"))?
                    .to_owned();

                let mut doc = self.load_doc_for_note_async(&row.id).await?;
                let (saved, mut list) = upsert_doc_block_annotation(&mut doc.blocks, &block_id, &req.annotation, &gen_id, now).map_err(refused)?;

                let asset_src = collect_doc_annotations(&doc.blocks)
                    .into_iter()
                    .find(|e| e.block_id == block_id && e.annotation.id == saved.id)
                    .map(|e| e.asset_src);

                let embed_target = find_first_base_embed(&doc.blocks);
                let resolved_base = req
                    .base_note_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|nid| (nid.to_owned(), req.base_sheet_id.clone()))
                    .or_else(|| if saved.base_row_id.is_some() { embed_target } else { None });

                let mut synced_base_note_id = None;
                let mut synced_base_row_id = None;
                if let Some((base_id, base_sheet)) = resolved_base
                    && let Ok(Some(row_id)) = self
                        .sync_single_annotation_to_base_async(
                            maker,
                            AnnotationBaseSyncTarget {
                                doc_note_id: &row.id,
                                block_id: &block_id,
                                asset_src: asset_src.as_deref(),
                                annotation: &saved,
                                base_note_id: &base_id,
                                base_sheet_id: base_sheet.as_deref(),
                                origin: req.origin.clone(),
                            },
                        )
                        .await
                {
                    if saved.base_row_id.as_deref() != Some(row_id.as_str()) {
                        let _ = mutate_doc_annotation_by_id(&mut doc.blocks, &block_id, &saved.id, |ann| {
                            ann.base_row_id = Some(row_id.clone());
                            true
                        });
                        if let Some(slot) = list.iter_mut().find(|a| a.id == saved.id) {
                            slot.base_row_id = Some(row_id.clone());
                        }
                    }
                    synced_base_note_id = Some(base_id);
                    synced_base_row_id = Some(row_id);
                }

                let encoded = serialize_doc_document(&doc).map_err(refused)?;
                self.write_structure_json_async(maker, &row.id, "structure/doc.json", encoded, req.origin.clone(), "Upsert media annotation")
                    .await?;

                let summary = summarize_annotations(&list);
                Ok(NoteAnnotationMutationResult {
                    note_id: row.id,
                    block_id: Some(block_id),
                    annotations: list,
                    summary,
                    synced_base_note_id,
                    synced_base_row_id,
                })
            }
            NoteType::Media => {
                let raw_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
                let raw = raw_files
                    .get("structure/media.json")
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .ok_or_else(|| refused("missing structure/media.json"))?;
                let item_id = req.block_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
                let (mut encoded, saved, mut list) = upsert_media_doc_annotation(raw, item_id, &req.annotation, &gen_id, now).map_err(refused)?;

                let mut synced_base_note_id = None;
                let mut synced_base_row_id = None;
                if let Some(base_id) = req.base_note_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
                    && let Ok(Some(row_id)) = self
                        .sync_single_annotation_to_base_async(
                            maker,
                            AnnotationBaseSyncTarget {
                                doc_note_id: &row.id,
                                block_id: item_id.unwrap_or("media"),
                                asset_src: None,
                                annotation: &saved,
                                base_note_id: base_id,
                                base_sheet_id: req.base_sheet_id.as_deref(),
                                origin: req.origin.clone(),
                            },
                        )
                        .await
                {
                    if saved.base_row_id.as_deref() != Some(row_id.as_str()) {
                        let mut linked = saved.clone();
                        linked.base_row_id = Some(row_id.clone());
                        if let Ok((re_encoded, _, re_list)) = upsert_media_doc_annotation(&encoded, item_id, &linked, &gen_id, now) {
                            encoded = re_encoded;
                            list = re_list;
                        }
                    }
                    synced_base_note_id = Some(base_id.to_owned());
                    synced_base_row_id = Some(row_id);
                }

                self.write_structure_json_async(maker, &row.id, "structure/media.json", encoded, req.origin.clone(), "Upsert media annotation")
                    .await?;

                let summary = summarize_annotations(&list);
                Ok(NoteAnnotationMutationResult {
                    note_id: row.id,
                    block_id: item_id.map(str::to_owned),
                    annotations: list,
                    summary,
                    synced_base_note_id,
                    synced_base_row_id,
                })
            }
            NoteType::Base | NoteType::Canvas => Err(refused(format!("note `{}` is `{}`, expected `doc` or `media`", row.id, ty.as_str()))),
        }
    }

    /// Deletes a [`MediaAnnotation`] from a `doc` media/compare block or `media` note and clears any linked `BaseRow.annotationRef`.
    pub async fn annotation_delete_async(&self, maker: &Maker, req: &NoteAnnotationDeleteRequest) -> Result<NoteAnnotationMutationResult, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        let now = self.ctx.now();

        match ty {
            NoteType::Doc => {
                let block_id = req
                    .block_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| refused("blockId is required for doc note annotations"))?
                    .to_owned();
                let mut doc = self.load_doc_for_note_async(&row.id).await?;
                let (removed, remaining) = delete_doc_block_annotation(&mut doc.blocks, &block_id, &req.annotation_id).map_err(refused)?;

                let mut synced_base_note_id = None;
                let mut synced_base_row_id = None;
                if removed.is_some() {
                    let encoded = serialize_doc_document(&doc).map_err(refused)?;
                    self.write_structure_json_async(maker, &row.id, "structure/doc.json", encoded, req.origin.clone(), "Delete media annotation")
                        .await?;

                    let target_base = req
                        .base_note_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|nid| (nid.to_owned(), req.base_sheet_id.clone()))
                        .or_else(|| find_first_base_embed(&doc.blocks));

                    if let Some((base_id, base_sheet)) = target_base
                        && let Ok(mut base_doc) = self.load_base_doc_async(&base_id).await
                    {
                        let sheet = match base_sheet.as_deref() {
                            Some(sid) => base_doc.sheets.iter_mut().find(|s| s.id == sid),
                            None => base_doc.sheets.first_mut(),
                        };
                        if let Some(sheet) = sheet
                            && let Some(cleared_row_id) = clear_annotation_ref_on_base_sheet(sheet, &row.id, &block_id, &req.annotation_id, now)
                        {
                            let base_encoded = serialize_base_document(&base_doc).map_err(refused)?;
                            let _ = self
                                .write_structure_json_async(
                                    maker,
                                    &base_id,
                                    "structure/base.json",
                                    base_encoded,
                                    req.origin.clone(),
                                    "Unlink deleted media annotation",
                                )
                                .await;
                            synced_base_note_id = Some(base_id);
                            synced_base_row_id = Some(cleared_row_id);
                        }
                    }
                }

                let summary = summarize_annotations(&remaining);
                Ok(NoteAnnotationMutationResult {
                    note_id: row.id,
                    block_id: Some(block_id),
                    annotations: remaining,
                    summary,
                    synced_base_note_id,
                    synced_base_row_id,
                })
            }
            NoteType::Media => {
                let raw_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
                let raw = raw_files
                    .get("structure/media.json")
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .ok_or_else(|| refused("missing structure/media.json"))?;
                let item_id = req.block_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
                let (encoded, removed, remaining) = delete_media_doc_annotation(raw, item_id, &req.annotation_id).map_err(refused)?;

                if removed.is_some() {
                    self.write_structure_json_async(maker, &row.id, "structure/media.json", encoded, req.origin.clone(), "Delete media annotation")
                        .await?;
                }
                let summary = summarize_annotations(&remaining);
                Ok(NoteAnnotationMutationResult {
                    note_id: row.id,
                    block_id: item_id.map(str::to_owned),
                    annotations: remaining,
                    summary,
                    synced_base_note_id: None,
                    synced_base_row_id: None,
                })
            }
            NoteType::Base | NoteType::Canvas => Err(refused(format!("note `{}` is `{}`, expected `doc` or `media`", row.id, ty.as_str()))),
        }
    }

    /// Bidirectionally reconciles all `MediaAnnotation`s in a `doc` note with an embedded `base`
    /// review checklist, creating the built-in Review Checklist `base` + `baseEmbed` block if absent.
    pub async fn base_sync_review_async(&self, maker: &Maker, req: &NoteReviewSyncRequest) -> Result<NoteReviewSyncResult, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let doc_row = self.row_async(&req.id).await?;
        let ty = note_type_of(&doc_row.note_type)?;
        if ty != NoteType::Doc {
            return Err(refused(format!("note `{}` is `{}`, expected `doc`", doc_row.id, ty.as_str())));
        }

        let mut doc = self.load_doc_for_note_async(&doc_row.id).await?;
        let embed_target = find_first_base_embed(&doc.blocks);

        let mut created_base = false;
        let (base_note_id, target_sheet_id) = if let Some(explicit) = req.base_note_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            (explicit.to_owned(), req.sheet_id.clone())
        } else if let Some((embed_id, embed_sheet)) = embed_target {
            (embed_id, req.sheet_id.clone().or(embed_sheet))
        } else {
            let checklist_title = format!("{} · Review Checklist", doc_row.title);
            let template_doc = review_checklist_base_document(&checklist_title, req.spawn_issue_repo.as_deref());
            let template_json = serialize_base_document(&template_doc).map_err(refused)?;
            let created = self
                .create_async(
                    maker,
                    &NoteRequest {
                        title: checklist_title,
                        note_type: NoteType::Base,
                        parent_id: Some(doc_row.id.clone()),
                        sort_order: None,
                        content: Some(template_json),
                        files: None,
                        announce: Some(false),
                        note: None,
                        channel: None,
                        issue: doc_row.issue.clone(),
                    },
                )
                .await?;
            append_block(
                &mut doc,
                DocBlock {
                    id: new_id("blk"),
                    kind: BlockKind::BaseEmbed {
                        note_id: created.id.clone(),
                        sheet_id: Some("sheet1".to_owned()),
                        view_id: Some("v_table".to_owned()),
                    },
                    collapsed: None,
                    children: None,
                },
                None,
            );
            created_base = true;
            (created.id, Some("sheet1".to_owned()))
        };

        self.flush_pending_writes_async(&base_note_id).await;
        let mut base_doc = self.load_base_doc_async(&base_note_id).await?;
        let now = self.ctx.now();
        let direction = req.direction.unwrap_or(ReviewSyncDirection::DocToBase);

        let outcome = reconcile_review_checklist(&doc_row.id, &mut doc, &mut base_doc, target_sheet_id.as_deref(), direction, now, || {
            new_id("row")
        })
        .map_err(refused)?;

        if outcome.base_changed {
            let encoded = serialize_base_document(&base_doc).map_err(refused)?;
            self.write_structure_json_async(
                maker,
                &base_note_id,
                "structure/base.json",
                encoded,
                req.origin.clone(),
                "Sync review checklist base",
            )
            .await?;
        }
        if outcome.doc_changed || created_base {
            let encoded = serialize_doc_document(&doc).map_err(refused)?;
            self.write_structure_json_async(
                maker,
                &doc_row.id,
                "structure/doc.json",
                encoded,
                req.origin.clone(),
                "Sync review checklist doc",
            )
            .await?;
        }

        let base_snapshot = self
            .base_view_async(&BaseViewRequest {
                id: base_note_id.clone(),
                sheet_id: Some(outcome.sheet_id.clone()),
                view_id: None,
            })
            .await?;
        let summary = doc_annotation_summary(&doc.blocks).unwrap_or_default();

        Ok(NoteReviewSyncResult {
            doc_note_id: doc_row.id,
            base_note_id,
            sheet_id: outcome.sheet_id,
            created_base,
            linked_count: outcome.linked_count,
            updated_annotations: outcome.updated_annotations,
            updated_rows: outcome.updated_rows,
            summary,
            base_snapshot,
        })
    }

    /// Best-effort propagation when a `BaseRow` carrying `annotation_ref` is edited via `note.base.upsertRow`.
    pub(super) async fn sync_base_row_to_doc_annotation_async(
        &self,
        maker: &Maker,
        base_doc: &BaseDocument,
        sheet_id: &str,
        row_id: &str,
        origin: Option<&str>,
    ) {
        let Some(sheet) = base_doc.sheets.iter().find(|s| s.id == sheet_id) else {
            return;
        };
        let Some(row) = sheet.rows.iter().find(|r| r.id == row_id) else {
            return;
        };
        let Some(aref) = row.annotation_ref.as_ref() else {
            return;
        };
        let Ok(doc_row) = self.row_async(&aref.note_id).await else {
            return;
        };
        if note_type_of(&doc_row.note_type).ok() != Some(NoteType::Doc) {
            return;
        }
        let Ok(mut doc) = self.load_doc_for_note_async(&aref.note_id).await else {
            return;
        };
        let patch = extract_annotation_patch_from_base_row(sheet, row);
        let now = self.ctx.now();
        let changed = mutate_doc_annotation_by_id(&mut doc.blocks, &aref.block_id, &aref.annotation_id, |ann| {
            apply_base_row_patch_to_annotation(ann, &patch, now)
        });
        if !changed {
            return;
        }
        if let Ok(encoded) = serialize_doc_document(&doc) {
            let _ = self
                .write_structure_json_async(
                    maker,
                    &aref.note_id,
                    "structure/doc.json",
                    encoded,
                    origin.map(str::to_owned),
                    "Sync base row update to media annotation",
                )
                .await;
        }
    }
}
