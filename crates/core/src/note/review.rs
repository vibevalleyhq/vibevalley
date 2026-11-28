//! Built-in UI/Product Review Checklist `Base` template and pure bidirectional
//! reconciliation between `DocDocument` (`MediaAnnotation`) and `BaseDocument` (`BaseRow`) (`#145`).

use std::collections::BTreeMap;

use vibevalley_protocol::{
    BaseAgentColumnConfig, BaseAnnotationRef, BaseCellValue, BaseColumn, BaseColumnKind, BaseRow, BaseSelectOption, BaseSheet, BaseSummaryConfig,
    BaseSummaryOp, BaseViewConfig, BaseViewKind, MediaAnnotation, MediaAnnotationSeverity, MediaAnnotationStatus, ReviewSyncDirection,
};

use crate::note::annotation::{collect_doc_annotations, mutate_doc_annotation_by_id};
use crate::note::base::{BaseDocument, cell_as_text, text_cell};
use crate::note::doc::DocDocument;

/// Canonical column IDs for the built-in UI/Product Review Checklist `Base` template.
pub const REVIEW_COL_TITLE: &str = "c_title";
pub const REVIEW_COL_SEVERITY: &str = "c_severity";
pub const REVIEW_COL_STATUS: &str = "c_status";
pub const REVIEW_COL_MODULE: &str = "c_module";
pub const REVIEW_COL_SCREENSHOT: &str = "c_screenshot";
pub const REVIEW_COL_ISSUE: &str = "c_issue";
pub const REVIEW_COL_AGENT: &str = "c_agent";

/// Outcome of a pure bidirectional reconciliation between a `Doc` and a `Base` review checklist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewReconcileOutcome {
    pub sheet_id: String,
    pub linked_count: u32,
    pub updated_annotations: u32,
    pub updated_rows: u32,
    pub doc_changed: bool,
    pub base_changed: bool,
}

/// Extracted field patch derived from a `BaseRow` to propagate back onto a linked `MediaAnnotation`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BaseRowAnnotationPatch {
    pub title: Option<String>,
    pub severity: Option<MediaAnnotationSeverity>,
    pub status: Option<MediaAnnotationStatus>,
    pub issue_id: Option<Option<String>>,
}

/// Builds the canonical UI/Product Review Checklist [`BaseDocument`] template
/// (`标题` / `严重度` / `状态` / `模块` / `截图` / `关联工单` / `Agent 转工单与诊断` + `Table`/`Board`/`Gallery` views).
pub fn review_checklist_base_document(title: &str, spawn_issue_repo: Option<&str>) -> BaseDocument {
    let sheet_name = {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            "UI Review Checklist".to_owned()
        } else {
            trimmed.to_owned()
        }
    };

    BaseDocument {
        version: 1,
        sheets: vec![BaseSheet {
            id: "sheet1".to_owned(),
            name: sheet_name,
            columns: vec![
                BaseColumn {
                    id: REVIEW_COL_TITLE.to_owned(),
                    name: "标题".to_owned(),
                    kind: BaseColumnKind::Text,
                    options: None,
                    agent_config: None,
                    formula: None,
                    width: Some(260),
                },
                BaseColumn {
                    id: REVIEW_COL_SEVERITY.to_owned(),
                    name: "严重度".to_owned(),
                    kind: BaseColumnKind::Select,
                    options: Some(vec![
                        BaseSelectOption {
                            value: "p0".to_owned(),
                            label: Some("P0".to_owned()),
                            color: Some("berry".to_owned()),
                        },
                        BaseSelectOption {
                            value: "p1".to_owned(),
                            label: Some("P1".to_owned()),
                            color: Some("amber".to_owned()),
                        },
                        BaseSelectOption {
                            value: "p2".to_owned(),
                            label: Some("P2".to_owned()),
                            color: Some("water".to_owned()),
                        },
                        BaseSelectOption {
                            value: "ux".to_owned(),
                            label: Some("UX".to_owned()),
                            color: Some("stone".to_owned()),
                        },
                    ]),
                    agent_config: None,
                    formula: None,
                    width: Some(110),
                },
                BaseColumn {
                    id: REVIEW_COL_STATUS.to_owned(),
                    name: "状态".to_owned(),
                    kind: BaseColumnKind::Select,
                    options: Some(vec![
                        BaseSelectOption {
                            value: "open".to_owned(),
                            label: Some("Open".to_owned()),
                            color: Some("amber".to_owned()),
                        },
                        BaseSelectOption {
                            value: "in_progress".to_owned(),
                            label: Some("In Progress".to_owned()),
                            color: Some("water".to_owned()),
                        },
                        BaseSelectOption {
                            value: "resolved".to_owned(),
                            label: Some("Resolved".to_owned()),
                            color: Some("green".to_owned()),
                        },
                    ]),
                    agent_config: None,
                    formula: None,
                    width: Some(120),
                },
                BaseColumn {
                    id: REVIEW_COL_MODULE.to_owned(),
                    name: "模块".to_owned(),
                    kind: BaseColumnKind::Text,
                    options: None,
                    agent_config: None,
                    formula: None,
                    width: Some(140),
                },
                BaseColumn {
                    id: REVIEW_COL_SCREENSHOT.to_owned(),
                    name: "截图".to_owned(),
                    kind: BaseColumnKind::Media,
                    options: None,
                    agent_config: None,
                    formula: None,
                    width: Some(140),
                },
                BaseColumn {
                    id: REVIEW_COL_ISSUE.to_owned(),
                    name: "关联工单".to_owned(),
                    kind: BaseColumnKind::IssueRef,
                    options: None,
                    agent_config: None,
                    formula: None,
                    width: Some(140),
                },
                BaseColumn {
                    id: REVIEW_COL_AGENT.to_owned(),
                    name: "Agent 转工单与诊断".to_owned(),
                    kind: BaseColumnKind::AgentAction,
                    options: None,
                    agent_config: Some(BaseAgentColumnConfig {
                        agent_id: None,
                        prompt_template: "Diagnose and fix review finding ({{row_id}}): {{标题}} [{{严重度}} / {{状态}}] in {{模块}}".to_owned(),
                        target_column_id: None,
                        spawn_issue_repo: spawn_issue_repo.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned),
                    }),
                    formula: None,
                    width: Some(180),
                },
            ],
            rows: Vec::new(),
            views: vec![
                BaseViewConfig {
                    id: "v_table".to_owned(),
                    name: "Table".to_owned(),
                    kind: BaseViewKind::Table,
                    group_by: None,
                    hidden_columns: None,
                    filters: None,
                    sorts: None,
                    summaries: Some(vec![BaseSummaryConfig {
                        column_id: REVIEW_COL_TITLE.to_owned(),
                        op: BaseSummaryOp::Count,
                    }]),
                },
                BaseViewConfig {
                    id: "v_board".to_owned(),
                    name: "Board".to_owned(),
                    kind: BaseViewKind::Board,
                    group_by: Some(REVIEW_COL_STATUS.to_owned()),
                    hidden_columns: None,
                    filters: None,
                    sorts: None,
                    summaries: None,
                },
                BaseViewConfig {
                    id: "v_gallery".to_owned(),
                    name: "Gallery".to_owned(),
                    kind: BaseViewKind::Gallery,
                    group_by: None,
                    hidden_columns: None,
                    filters: None,
                    sorts: None,
                    summaries: None,
                },
            ],
        }],
    }
}

fn find_col_id(sheet: &BaseSheet, canonical: &str, kind: BaseColumnKind, aliases: &[&str]) -> Option<String> {
    if let Some(c) = sheet.columns.iter().find(|c| c.id == canonical) {
        return Some(c.id.clone());
    }
    if let Some(c) = sheet
        .columns
        .iter()
        .find(|c| c.kind == kind && aliases.iter().any(|a| c.name.eq_ignore_ascii_case(a)))
    {
        return Some(c.id.clone());
    }
    sheet.columns.iter().find(|c| c.kind == kind).map(|c| c.id.clone())
}

fn find_named_col_id(sheet: &BaseSheet, canonical: &str, aliases: &[&str]) -> Option<String> {
    if let Some(c) = sheet.columns.iter().find(|c| c.id == canonical) {
        return Some(c.id.clone());
    }
    sheet
        .columns
        .iter()
        .find(|c| aliases.iter().any(|a| c.name.eq_ignore_ascii_case(a) || c.id.eq_ignore_ascii_case(a)))
        .map(|c| c.id.clone())
}

/// Applies a [`MediaAnnotation`]'s fields onto a matching (or newly created) [`BaseRow`] in `sheet`.
/// Returns `(row_id, changed)`.
pub fn apply_annotation_to_base_row(
    sheet: &mut BaseSheet,
    doc_note_id: &str,
    block_id: &str,
    asset_src: Option<&str>,
    ann: &MediaAnnotation,
    now: i64,
    generated_row_id: &str,
) -> (String, bool) {
    let title_col = find_col_id(sheet, REVIEW_COL_TITLE, BaseColumnKind::Text, &["title", "标题", "name"]);
    let severity_col = find_named_col_id(sheet, REVIEW_COL_SEVERITY, &["severity", "严重度", "priority"]);
    let status_col = find_named_col_id(sheet, REVIEW_COL_STATUS, &["status", "状态"]);
    let screenshot_col = find_col_id(sheet, REVIEW_COL_SCREENSHOT, BaseColumnKind::Media, &["screenshot", "截图", "media"]);
    let issue_col = find_col_id(sheet, REVIEW_COL_ISSUE, BaseColumnKind::IssueRef, &["issue", "关联工单"]);

    let target_ref = BaseAnnotationRef {
        note_id: doc_note_id.to_owned(),
        block_id: block_id.to_owned(),
        annotation_id: ann.id.clone(),
        number: Some(ann.number),
    };

    let existing_idx = ann
        .base_row_id
        .as_deref()
        .and_then(|rid| sheet.rows.iter().position(|r| r.id == rid))
        .or_else(|| {
            sheet.rows.iter().position(|r| {
                r.annotation_ref
                    .as_ref()
                    .is_some_and(|aref| aref.note_id == doc_note_id && aref.block_id == block_id && aref.annotation_id == ann.id)
            })
        });

    let mut changed = false;
    let row = if let Some(idx) = existing_idx {
        &mut sheet.rows[idx]
    } else {
        let row_id = ann
            .base_row_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(generated_row_id)
            .to_owned();
        sheet.rows.push(BaseRow {
            id: row_id,
            cells: BTreeMap::new(),
            page_note_id: None,
            annotation_ref: Some(target_ref.clone()),
            created_at: now,
            updated_at: now,
        });
        changed = true;
        sheet.rows.last_mut().expect("just pushed row")
    };

    if row.annotation_ref.as_ref() != Some(&target_ref) {
        row.annotation_ref = Some(target_ref);
        changed = true;
    }

    if let Some(col_id) = title_col {
        let next = text_cell(&ann.title);
        if row.cells.get(&col_id) != Some(&next) {
            row.cells.insert(col_id, next);
            changed = true;
        }
    }
    if let Some(col_id) = severity_col {
        let next = text_cell(ann.severity.as_str());
        if row.cells.get(&col_id) != Some(&next) {
            row.cells.insert(col_id, next);
            changed = true;
        }
    }
    if let Some(col_id) = status_col {
        let next = text_cell(ann.status.as_str());
        if row.cells.get(&col_id) != Some(&next) {
            row.cells.insert(col_id, next);
            changed = true;
        }
    }
    if let Some(col_id) = screenshot_col
        && let Some(src) = asset_src.map(str::trim).filter(|s| !s.is_empty())
    {
        let next = text_cell(src);
        if row.cells.get(&col_id) != Some(&next) {
            row.cells.insert(col_id, next);
            changed = true;
        }
    }
    if let Some(col_id) = issue_col {
        match ann.issue_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(iid) => {
                let next = BaseCellValue::IssueRef { issue_id: iid.to_owned() };
                if row.cells.get(&col_id) != Some(&next) {
                    row.cells.insert(col_id, next);
                    changed = true;
                }
            }
            None => {
                if row.cells.remove(&col_id).is_some() {
                    changed = true;
                }
            }
        }
    }

    if changed {
        row.updated_at = now;
    }
    (row.id.clone(), changed)
}

/// Clears `annotation_ref` on any row in `sheet` referencing `(doc_note_id, block_id, annotation_id)`.
pub fn clear_annotation_ref_on_base_sheet(sheet: &mut BaseSheet, doc_note_id: &str, block_id: &str, annotation_id: &str, now: i64) -> Option<String> {
    for row in &mut sheet.rows {
        if row
            .annotation_ref
            .as_ref()
            .is_some_and(|aref| aref.note_id == doc_note_id && aref.block_id == block_id && aref.annotation_id == annotation_id)
        {
            row.annotation_ref = None;
            row.updated_at = now;
            return Some(row.id.clone());
        }
    }
    None
}

/// Extracts review fields from a [`BaseRow`] so edits on the Base checklist can sync back to a linked [`MediaAnnotation`].
pub fn extract_annotation_patch_from_base_row(sheet: &BaseSheet, row: &BaseRow) -> BaseRowAnnotationPatch {
    let mut patch = BaseRowAnnotationPatch::default();
    if let Some(col_id) = find_col_id(sheet, REVIEW_COL_TITLE, BaseColumnKind::Text, &["title", "标题", "name"])
        && let Some(cell) = row.cells.get(&col_id)
    {
        let title = cell_as_text(cell).trim().to_owned();
        if !title.is_empty() {
            patch.title = Some(title);
        }
    }
    if let Some(col_id) = find_named_col_id(sheet, REVIEW_COL_SEVERITY, &["severity", "严重度", "priority"])
        && let Some(cell) = row.cells.get(&col_id)
    {
        patch.severity = MediaAnnotationSeverity::parse(&cell_as_text(cell));
    }
    if let Some(col_id) = find_named_col_id(sheet, REVIEW_COL_STATUS, &["status", "状态"])
        && let Some(cell) = row.cells.get(&col_id)
    {
        patch.status = MediaAnnotationStatus::parse(&cell_as_text(cell));
    }
    if let Some(col_id) = find_col_id(sheet, REVIEW_COL_ISSUE, BaseColumnKind::IssueRef, &["issue", "关联工单"]) {
        patch.issue_id = Some(match row.cells.get(&col_id) {
            Some(BaseCellValue::IssueRef { issue_id }) if !issue_id.trim().is_empty() => Some(issue_id.trim().to_owned()),
            Some(BaseCellValue::AgentRun {
                spawned_issue_id: Some(issue_id),
                ..
            }) if !issue_id.trim().is_empty() => Some(issue_id.trim().to_owned()),
            _ => None,
        });
    }
    patch
}

/// Applies a [`BaseRowAnnotationPatch`] onto a [`MediaAnnotation`]; returns `true` if any field changed.
pub fn apply_base_row_patch_to_annotation(ann: &mut MediaAnnotation, patch: &BaseRowAnnotationPatch, now: i64) -> bool {
    let mut changed = false;
    if let Some(ref title) = patch.title
        && ann.title != *title
    {
        ann.title = title.clone();
        changed = true;
    }
    if let Some(sev) = patch.severity
        && ann.severity != sev
    {
        ann.severity = sev;
        changed = true;
    }
    if let Some(status) = patch.status
        && ann.status != status
    {
        ann.status = status;
        changed = true;
    }
    if let Some(ref issue_opt) = patch.issue_id
        && ann.issue_id != *issue_opt
    {
        ann.issue_id = issue_opt.clone();
        changed = true;
    }
    if changed {
        ann.updated_at = Some(now);
    }
    changed
}

/// Bidirectionally reconciles all `Media` / `Compare` annotations in `doc` with the target sheet of `base_doc`.
pub fn reconcile_review_checklist(
    doc_note_id: &str,
    doc: &mut DocDocument,
    base_doc: &mut BaseDocument,
    sheet_id: Option<&str>,
    direction: ReviewSyncDirection,
    now: i64,
    mut make_row_id: impl FnMut() -> String,
) -> Result<ReviewReconcileOutcome, String> {
    let sheet = match sheet_id {
        Some(sid) => base_doc
            .sheets
            .iter_mut()
            .find(|s| s.id == sid)
            .ok_or_else(|| format!("sheet {sid} not found"))?,
        None => base_doc.sheets.first_mut().ok_or_else(|| "base has no sheets".to_owned())?,
    };
    let effective_sheet_id = sheet.id.clone();
    let entries = collect_doc_annotations(&doc.blocks);

    let mut linked_count = 0u32;
    let mut updated_annotations = 0u32;
    let mut updated_rows = 0u32;
    let mut doc_changed = false;
    let mut base_changed = false;

    for entry in &entries {
        match direction {
            ReviewSyncDirection::DocToBase => {
                let gen_id = make_row_id();
                let (row_id, row_changed) =
                    apply_annotation_to_base_row(sheet, doc_note_id, &entry.block_id, Some(&entry.asset_src), &entry.annotation, now, &gen_id);
                if row_changed {
                    updated_rows += 1;
                    base_changed = true;
                }
                if entry.annotation.base_row_id.as_deref() != Some(row_id.as_str()) {
                    let updated = mutate_doc_annotation_by_id(&mut doc.blocks, &entry.block_id, &entry.annotation.id, |ann| {
                        ann.base_row_id = Some(row_id.clone());
                        ann.updated_at = Some(now);
                        true
                    });
                    if updated {
                        updated_annotations += 1;
                        doc_changed = true;
                    }
                }
                linked_count += 1;
            }
            ReviewSyncDirection::BaseToDoc => {
                let matched_row = entry
                    .annotation
                    .base_row_id
                    .as_deref()
                    .and_then(|rid| sheet.rows.iter().find(|r| r.id == rid))
                    .or_else(|| {
                        sheet.rows.iter().find(|r| {
                            r.annotation_ref
                                .as_ref()
                                .is_some_and(|aref| aref.note_id == doc_note_id && aref.block_id == entry.block_id && aref.annotation_id == entry.annotation.id)
                        })
                    })
                    .cloned();

                if let Some(row) = matched_row {
                    let patch = extract_annotation_patch_from_base_row(sheet, &row);
                    let row_id = row.id.clone();
                    let changed = mutate_doc_annotation_by_id(&mut doc.blocks, &entry.block_id, &entry.annotation.id, |ann| {
                        let mut c = apply_base_row_patch_to_annotation(ann, &patch, now);
                        if ann.base_row_id.as_deref() != Some(row_id.as_str()) {
                            ann.base_row_id = Some(row_id.clone());
                            c = true;
                        }
                        c
                    });
                    if changed {
                        updated_annotations += 1;
                        doc_changed = true;
                    }
                    if let Some(row_mut) = sheet.rows.iter_mut().find(|r| r.id == row_id) {
                        let want_ref = BaseAnnotationRef {
                            note_id: doc_note_id.to_owned(),
                            block_id: entry.block_id.clone(),
                            annotation_id: entry.annotation.id.clone(),
                            number: Some(entry.annotation.number),
                        };
                        if row_mut.annotation_ref.as_ref() != Some(&want_ref) {
                            row_mut.annotation_ref = Some(want_ref);
                            row_mut.updated_at = now;
                            updated_rows += 1;
                            base_changed = true;
                        }
                    }
                    linked_count += 1;
                } else {
                    let gen_id = make_row_id();
                    let (row_id, row_changed) =
                        apply_annotation_to_base_row(sheet, doc_note_id, &entry.block_id, Some(&entry.asset_src), &entry.annotation, now, &gen_id);
                    if row_changed {
                        updated_rows += 1;
                        base_changed = true;
                    }
                    let updated = mutate_doc_annotation_by_id(&mut doc.blocks, &entry.block_id, &entry.annotation.id, |ann| {
                        if ann.base_row_id.as_deref() != Some(row_id.as_str()) {
                            ann.base_row_id = Some(row_id.clone());
                            ann.updated_at = Some(now);
                            true
                        } else {
                            false
                        }
                    });
                    if updated {
                        updated_annotations += 1;
                        doc_changed = true;
                    }
                    linked_count += 1;
                }
            }
        }
    }

    Ok(ReviewReconcileOutcome {
        sheet_id: effective_sheet_id,
        linked_count,
        updated_annotations,
        updated_rows,
        doc_changed,
        base_changed,
    })
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::{BlockKind, DocBlock, JsNumber, MediaAnnotationKind, MediaAnnotationRect};

    use super::*;

    #[test]
    fn template_and_bidirectional_reconcile_sync_doc_and_base() {
        let mut base_doc = review_checklist_base_document("VDP Audit", Some("vibevalley"));
        assert_eq!(base_doc.sheets[0].columns.len(), 7);
        assert_eq!(base_doc.sheets[0].views.len(), 3);

        let mut doc = DocDocument {
            version: 1,
            blocks: vec![DocBlock {
                id: "b_media".to_owned(),
                kind: BlockKind::Media {
                    media_kind: "image".to_owned(),
                    src: "asset/light.png".to_owned(),
                    caption: Some("Light mode".to_owned()),
                    annotations: Some(vec![MediaAnnotation {
                        id: "ann-1".to_owned(),
                        number: 1,
                        kind: Some(MediaAnnotationKind::Rect),
                        rect: MediaAnnotationRect {
                            x: JsNumber(0.1),
                            y: JsNumber(0.2),
                            w: JsNumber(0.3),
                            h: JsNumber(0.15),
                        },
                        to: None,
                        side: None,
                        severity: MediaAnnotationSeverity::P0,
                        title: "Broken header alignment".to_owned(),
                        body: None,
                        status: MediaAnnotationStatus::Open,
                        issue_id: None,
                        base_row_id: None,
                        author: Some("user".to_owned()),
                        created_at: Some(10),
                        updated_at: Some(10),
                    }]),
                },
                collapsed: None,
                children: None,
            }],
        };

        let mut seq = 0u32;
        let out = reconcile_review_checklist("n_doc", &mut doc, &mut base_doc, None, ReviewSyncDirection::DocToBase, 100, || {
            seq += 1;
            format!("row-{seq}")
        })
        .unwrap();
        assert_eq!(out.linked_count, 1);
        assert_eq!(out.updated_rows, 1);
        assert_eq!(out.updated_annotations, 1);
        assert_eq!(base_doc.sheets[0].rows.len(), 1);
        let row = &mut base_doc.sheets[0].rows[0];
        assert_eq!(row.id, "row-1");
        assert_eq!(
            row.annotation_ref
                .as_ref()
                .map(|r| (r.note_id.as_str(), r.block_id.as_str(), r.annotation_id.as_str())),
            Some(("n_doc", "b_media", "ann-1"))
        );
        assert_eq!(cell_as_text(&row.cells[REVIEW_COL_SCREENSHOT]), "asset/light.png");

        // Now edit the Base row status -> resolved and link an issue, then reconcile BaseToDoc.
        row.cells.insert(REVIEW_COL_STATUS.to_owned(), text_cell("resolved"));
        row.cells.insert(REVIEW_COL_SEVERITY.to_owned(), text_cell("p2"));
        row.cells
            .insert(REVIEW_COL_ISSUE.to_owned(), BaseCellValue::IssueRef { issue_id: "i145".to_owned() });

        let out2 = reconcile_review_checklist("n_doc", &mut doc, &mut base_doc, None, ReviewSyncDirection::BaseToDoc, 200, || {
            "unused".to_owned()
        })
        .unwrap();
        assert_eq!(out2.updated_annotations, 1);
        assert!(out2.doc_changed);
        let entries = collect_doc_annotations(&doc.blocks);
        assert_eq!(entries[0].annotation.status, MediaAnnotationStatus::Resolved);
        assert_eq!(entries[0].annotation.severity, MediaAnnotationSeverity::P2);
        assert_eq!(entries[0].annotation.issue_id.as_deref(), Some("i145"));
        assert_eq!(entries[0].annotation.base_row_id.as_deref(), Some("row-1"));
    }
}
