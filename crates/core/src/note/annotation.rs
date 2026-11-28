//! Non-destructive interactive image annotation helpers (`#144`, `#145`):
//! - Normalized `0..=1` geometry clamping and auto-numbering
//! - Summary rollups and `note_link` extraction from `MediaAnnotation`s
//! - Pure CRDT-friendly upsert/delete over `DocDocument` (`Media` / `Compare` blocks)
//!   and `structure/media.json` without ever touching image asset bytes.

use serde_json::Value;
use vibevalley_protocol::{
    BlockKind, DocBlock, JsNumber, LinkEntityKind, LinkRelation, MediaAnnotation, MediaAnnotationKind, MediaAnnotationPoint, MediaAnnotationRect,
    MediaAnnotationSeverity, MediaAnnotationStatus, MediaAnnotationSummary, NoteLinkRef,
};

use crate::note::links::{dedup_links, extract_markdown_links};

/// Flattened reference to a [`MediaAnnotation`] inside a `DocDocument`.
#[derive(Debug, Clone, PartialEq)]
pub struct DocAnnotationEntry {
    pub block_id: String,
    pub asset_src: String,
    pub annotation: MediaAnnotation,
}

fn clamp01(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    let clamped = v.clamp(0.0, 1.0);
    (clamped * 10_000.0).round() / 10_000.0
}

/// Clamps a normalized rectangle into `[0, 1]` with `x + w <= 1` and `y + h <= 1`.
pub fn normalize_rect(rect: MediaAnnotationRect) -> MediaAnnotationRect {
    let x = clamp01(rect.x.0);
    let y = clamp01(rect.y.0);
    let w = clamp01(rect.w.0.min(1.0 - x));
    let h = clamp01(rect.h.0.min(1.0 - y));
    MediaAnnotationRect {
        x: JsNumber(x),
        y: JsNumber(y),
        w: JsNumber(w),
        h: JsNumber(h),
    }
}

/// Clamps a normalized point into `[0, 1]`.
pub fn normalize_point(point: MediaAnnotationPoint) -> MediaAnnotationPoint {
    MediaAnnotationPoint {
        x: JsNumber(clamp01(point.x.0)),
        y: JsNumber(clamp01(point.y.0)),
    }
}

fn clean_opt(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Validates, normalizes coordinates, and assigns stable `id` / `number` / timestamps.
pub fn normalize_annotation(input: &MediaAnnotation, existing: &[MediaAnnotation], generated_id: &str, now: i64) -> Result<MediaAnnotation, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("annotation title cannot be empty".to_owned());
    }

    let id = clean_opt(Some(&input.id)).unwrap_or_else(|| generated_id.to_owned());
    let prior = existing.iter().find(|a| a.id == id);

    let number = if input.number > 0 {
        input.number
    } else if let Some(prev) = prior {
        prev.number
    } else {
        existing.iter().map(|a| a.number).max().unwrap_or(0).saturating_add(1)
    };

    let rect = normalize_rect(input.rect);
    let to = input.to.map(normalize_point);
    let kind = input.kind.or_else(|| {
        if to.is_some() {
            Some(MediaAnnotationKind::Arrow)
        } else if rect.w.0 > 0.0 || rect.h.0 > 0.0 {
            Some(MediaAnnotationKind::Rect)
        } else {
            Some(MediaAnnotationKind::Pin)
        }
    });

    Ok(MediaAnnotation {
        id,
        number,
        kind,
        rect,
        to,
        side: input.side,
        severity: input.severity,
        title: title.to_owned(),
        body: clean_opt(input.body.as_deref()),
        status: input.status,
        issue_id: clean_opt(input.issue_id.as_deref()),
        base_row_id: clean_opt(input.base_row_id.as_deref()),
        author: clean_opt(input.author.as_deref()).or_else(|| prior.and_then(|p| p.author.clone())),
        created_at: prior.and_then(|p| p.created_at).or(input.created_at).or(Some(now)),
        updated_at: Some(now),
    })
}

/// Computes an aggregate [`MediaAnnotationSummary`] over any iterator of annotations.
pub fn summarize_annotations<'a>(anns: impl IntoIterator<Item = &'a MediaAnnotation>) -> MediaAnnotationSummary {
    let mut s = MediaAnnotationSummary::default();
    for ann in anns {
        s.total += 1;
        match ann.status {
            MediaAnnotationStatus::Open => s.open += 1,
            MediaAnnotationStatus::Resolved => s.resolved += 1,
        }
        match ann.severity {
            MediaAnnotationSeverity::P0 => s.p0 += 1,
            MediaAnnotationSeverity::P1 => s.p1 += 1,
            MediaAnnotationSeverity::P2 => s.p2 += 1,
            MediaAnnotationSeverity::Ux => s.ux += 1,
        }
        if ann.base_row_id.as_deref().is_some_and(|r| !r.trim().is_empty()) {
            s.linked_rows += 1;
        }
        if ann.issue_id.as_deref().is_some_and(|i| !i.trim().is_empty()) {
            s.linked_issues += 1;
        }
    }
    s
}

/// Extracts outgoing `issue` and wikilink references from a slice of [`MediaAnnotation`]s.
pub fn extract_annotation_links(anns: &[MediaAnnotation]) -> Vec<NoteLinkRef> {
    let mut out = Vec::new();
    for ann in anns {
        if let Some(issue_id) = ann.issue_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            out.push(NoteLinkRef {
                kind: LinkEntityKind::Issue,
                id: issue_id.to_owned(),
                relation: LinkRelation::Link,
                title: (!ann.title.trim().is_empty()).then(|| ann.title.trim().to_owned()),
            });
        }
        out.extend(extract_markdown_links(&ann.title));
        if let Some(body) = &ann.body {
            out.extend(extract_markdown_links(body));
        }
    }
    dedup_links(out)
}

/// Upserts one normalized annotation into a list, sorting stably by `(number, id)`.
pub fn upsert_annotation_in_list(list: &mut Vec<MediaAnnotation>, input: &MediaAnnotation, generated_id: &str, now: i64) -> Result<MediaAnnotation, String> {
    let normalized = normalize_annotation(input, list, generated_id, now)?;
    if let Some(slot) = list.iter_mut().find(|a| a.id == normalized.id) {
        *slot = normalized.clone();
    } else {
        list.push(normalized.clone());
    }
    list.sort_by(|a, b| a.number.cmp(&b.number).then_with(|| a.id.cmp(&b.id)));
    Ok(normalized)
}

/// Removes an annotation by `annotation_id` from `list`, returning the removed entry if found.
pub fn delete_annotation_in_list(list: &mut Vec<MediaAnnotation>, annotation_id: &str) -> Option<MediaAnnotation> {
    let idx = list.iter().position(|a| a.id == annotation_id)?;
    Some(list.remove(idx))
}

fn collect_doc_annotations_rec(blocks: &[DocBlock], out: &mut Vec<DocAnnotationEntry>) {
    for block in blocks {
        match &block.kind {
            BlockKind::Media {
                src, annotations: Some(anns), ..
            } => {
                for ann in anns {
                    out.push(DocAnnotationEntry {
                        block_id: block.id.clone(),
                        asset_src: src.clone(),
                        annotation: ann.clone(),
                    });
                }
            }
            BlockKind::Compare {
                before_asset,
                after_asset,
                annotations: Some(anns),
                ..
            } => {
                for ann in anns {
                    let asset_src = match ann.side {
                        Some(vibevalley_protocol::MediaAnnotationSide::Before) => before_asset.clone(),
                        Some(vibevalley_protocol::MediaAnnotationSide::After) | None => after_asset.clone(),
                    };
                    out.push(DocAnnotationEntry {
                        block_id: block.id.clone(),
                        asset_src,
                        annotation: ann.clone(),
                    });
                }
            }
            BlockKind::Columns { columns } => {
                for col in columns {
                    collect_doc_annotations_rec(&col.blocks, out);
                }
            }
            _ => {}
        }
        if let Some(children) = &block.children {
            collect_doc_annotations_rec(children, out);
        }
    }
}

/// Collects every [`MediaAnnotation`] across all `Media` and `Compare` blocks in a document.
pub fn collect_doc_annotations(blocks: &[DocBlock]) -> Vec<DocAnnotationEntry> {
    let mut out = Vec::new();
    collect_doc_annotations_rec(blocks, &mut out);
    out
}

/// Computes the aggregate [`MediaAnnotationSummary`] for a document, or `None` when no annotations exist.
pub fn doc_annotation_summary(blocks: &[DocBlock]) -> Option<MediaAnnotationSummary> {
    let entries = collect_doc_annotations(blocks);
    if entries.is_empty() {
        None
    } else {
        Some(summarize_annotations(entries.iter().map(|e| &e.annotation)))
    }
}

/// Finds the first `BlockKind::BaseEmbed` in a block tree, returning `(note_id, sheet_id)`.
pub fn find_first_base_embed(blocks: &[DocBlock]) -> Option<(String, Option<String>)> {
    for block in blocks {
        match &block.kind {
            BlockKind::BaseEmbed { note_id, sheet_id, .. } if !note_id.trim().is_empty() => {
                return Some((note_id.clone(), sheet_id.clone()));
            }
            BlockKind::Columns { columns } => {
                for col in columns {
                    if let Some(found) = find_first_base_embed(&col.blocks) {
                        return Some(found);
                    }
                }
            }
            _ => {}
        }
        if let Some(children) = &block.children
            && let Some(found) = find_first_base_embed(children)
        {
            return Some(found);
        }
    }
    None
}

fn find_block_annotations_mut<'a>(blocks: &'a mut [DocBlock], block_id: &str) -> Option<&'a mut Option<Vec<MediaAnnotation>>> {
    for block in blocks {
        if block.id == block_id {
            return match &mut block.kind {
                BlockKind::Media { annotations, .. } | BlockKind::Compare { annotations, .. } => Some(annotations),
                _ => None,
            };
        }
        if let BlockKind::Columns { columns } = &mut block.kind {
            for col in columns {
                if let Some(found) = find_block_annotations_mut(&mut col.blocks, block_id) {
                    return Some(found);
                }
            }
        }
        if let Some(children) = &mut block.children
            && let Some(found) = find_block_annotations_mut(children, block_id)
        {
            return Some(found);
        }
    }
    None
}

/// Upserts a normalized [`MediaAnnotation`] onto a `Media` or `Compare` block in `blocks`.
pub fn upsert_doc_block_annotation(
    blocks: &mut [DocBlock],
    block_id: &str,
    input: &MediaAnnotation,
    generated_id: &str,
    now: i64,
) -> Result<(MediaAnnotation, Vec<MediaAnnotation>), String> {
    let slot = find_block_annotations_mut(blocks, block_id).ok_or_else(|| format!("media or compare block `{block_id}` not found"))?;
    let list = slot.get_or_insert_with(Vec::new);
    let saved = upsert_annotation_in_list(list, input, generated_id, now)?;
    Ok((saved, list.clone()))
}

/// Deletes a [`MediaAnnotation`] from a `Media` or `Compare` block in `blocks`.
pub fn delete_doc_block_annotation(
    blocks: &mut [DocBlock],
    block_id: &str,
    annotation_id: &str,
) -> Result<(Option<MediaAnnotation>, Vec<MediaAnnotation>), String> {
    let slot = find_block_annotations_mut(blocks, block_id).ok_or_else(|| format!("media or compare block `{block_id}` not found"))?;
    let removed = slot.as_mut().and_then(|list| delete_annotation_in_list(list, annotation_id));
    let remaining = slot.clone().unwrap_or_default();
    if remaining.is_empty() {
        *slot = None;
    }
    Ok((removed, remaining))
}

/// Mutates a specific annotation inside `block_id` in place; returns `true` when found and modified.
pub fn mutate_doc_annotation_by_id(blocks: &mut [DocBlock], block_id: &str, annotation_id: &str, mutate: impl FnOnce(&mut MediaAnnotation) -> bool) -> bool {
    let Some(slot) = find_block_annotations_mut(blocks, block_id) else {
        return false;
    };
    let Some(list) = slot.as_mut() else {
        return false;
    };
    let Some(ann) = list.iter_mut().find(|a| a.id == annotation_id) else {
        return false;
    };
    mutate(ann)
}

/// Extracts all valid [`MediaAnnotation`] entries from `structure/media.json` (top-level + per-item).
pub fn extract_media_doc_annotations(raw: &str) -> Vec<MediaAnnotation> {
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(arr) = root.get("annotations")
        && let Ok(parsed) = serde_json::from_value::<Vec<MediaAnnotation>>(arr.clone())
    {
        out.extend(parsed);
    }
    if let Some(items) = root.get("items").and_then(Value::as_array) {
        for item in items {
            if let Some(arr) = item.get("annotations")
                && let Ok(parsed) = serde_json::from_value::<Vec<MediaAnnotation>>(arr.clone())
            {
                out.extend(parsed);
            }
        }
    }
    out
}

fn target_media_annotations_mut<'a>(root: &'a mut Value, item_id: Option<&str>) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    let Some(obj) = root.as_object_mut() else {
        return Err("media.json root must be a JSON object".to_owned());
    };
    let Some(target_id) = item_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(obj);
    };
    let items = obj
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("media item `{target_id}` not found"))?;
    for item in items {
        if item.get("id").and_then(Value::as_str) == Some(target_id)
            && let Some(map) = item.as_object_mut()
        {
            return Ok(map);
        }
    }
    Err(format!("media item `{target_id}` not found"))
}

/// Upserts a normalized [`MediaAnnotation`] in `structure/media.json` (root or matching item id).
pub fn upsert_media_doc_annotation(
    raw: &str,
    item_id: Option<&str>,
    input: &MediaAnnotation,
    generated_id: &str,
    now: i64,
) -> Result<(String, MediaAnnotation, Vec<MediaAnnotation>), String> {
    let mut root: Value = serde_json::from_str(raw).map_err(|e| format!("invalid media.json: {e}"))?;
    let target = target_media_annotations_mut(&mut root, item_id)?;
    let mut list: Vec<MediaAnnotation> = target
        .get("annotations")
        .and_then(|v| serde_json::from_value::<Vec<MediaAnnotation>>(v.clone()).ok())
        .unwrap_or_default();
    let saved = upsert_annotation_in_list(&mut list, input, generated_id, now)?;
    target.insert("annotations".to_owned(), serde_json::to_value(&list).map_err(|e| e.to_string())?);
    let mut encoded = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    encoded.push('\n');
    Ok((encoded, saved, list))
}

/// Deletes a [`MediaAnnotation`] from `structure/media.json` (root or matching item id).
pub fn delete_media_doc_annotation(
    raw: &str,
    item_id: Option<&str>,
    annotation_id: &str,
) -> Result<(String, Option<MediaAnnotation>, Vec<MediaAnnotation>), String> {
    let mut root: Value = serde_json::from_str(raw).map_err(|e| format!("invalid media.json: {e}"))?;
    let target = target_media_annotations_mut(&mut root, item_id)?;
    let mut list: Vec<MediaAnnotation> = target
        .get("annotations")
        .and_then(|v| serde_json::from_value::<Vec<MediaAnnotation>>(v.clone()).ok())
        .unwrap_or_default();
    let removed = delete_annotation_in_list(&mut list, annotation_id);
    if list.is_empty() {
        target.remove("annotations");
    } else {
        target.insert("annotations".to_owned(), serde_json::to_value(&list).map_err(|e| e.to_string())?);
    }
    let mut encoded = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    encoded.push('\n');
    Ok((encoded, removed, list))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ann(id: &str, number: u32, severity: MediaAnnotationSeverity, status: MediaAnnotationStatus) -> MediaAnnotation {
        MediaAnnotation {
            id: id.to_owned(),
            number,
            kind: None,
            rect: MediaAnnotationRect {
                x: JsNumber(0.8),
                y: JsNumber(0.9),
                w: JsNumber(0.5),
                h: JsNumber(0.3),
            },
            to: None,
            side: None,
            severity,
            title: "  Contrast issue  ".to_owned(),
            body: Some("See #144".to_owned()),
            status,
            issue_id: Some("i144".to_owned()),
            base_row_id: Some("r1".to_owned()),
            author: Some("user".to_owned()),
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn normalizes_clamped_coords_auto_numbers_and_summarizes() {
        let mut list = Vec::new();
        let a1 = upsert_annotation_in_list(
            &mut list,
            &sample_ann("", 0, MediaAnnotationSeverity::P0, MediaAnnotationStatus::Open),
            "ann-gen-1",
            1000,
        )
        .unwrap();
        assert_eq!(a1.id, "ann-gen-1");
        assert_eq!(a1.number, 1);
        assert_eq!(a1.kind, Some(MediaAnnotationKind::Rect));
        assert_eq!(a1.rect.x, JsNumber(0.8));
        assert_eq!(a1.rect.w, JsNumber(0.2));
        assert_eq!(a1.rect.h, JsNumber(0.1));
        assert_eq!(a1.title, "Contrast issue");
        assert_eq!(a1.created_at, Some(1000));

        let mut pin = sample_ann("ann-2", 0, MediaAnnotationSeverity::Ux, MediaAnnotationStatus::Resolved);
        pin.rect = MediaAnnotationRect {
            x: JsNumber(-0.5),
            y: JsNumber(1.4),
            w: JsNumber(0.0),
            h: JsNumber(0.0),
        };
        pin.issue_id = None;
        pin.base_row_id = None;
        let a2 = upsert_annotation_in_list(&mut list, &pin, "ignored", 2000).unwrap();
        assert_eq!(a2.number, 2);
        assert_eq!(a2.kind, Some(MediaAnnotationKind::Pin));
        assert_eq!(a2.rect.x, JsNumber(0.0));
        assert_eq!(a2.rect.y, JsNumber(1.0));

        let summary = summarize_annotations(&list);
        assert_eq!(summary.total, 2);
        assert_eq!(summary.open, 1);
        assert_eq!(summary.resolved, 1);
        assert_eq!(summary.p0, 1);
        assert_eq!(summary.ux, 1);
        assert_eq!(summary.linked_rows, 1);
        assert_eq!(summary.linked_issues, 1);

        let links = extract_annotation_links(&list);
        assert!(links.iter().any(|l| l.kind == LinkEntityKind::Issue && l.id == "i144"));
        assert!(links.iter().any(|l| l.kind == LinkEntityKind::Issue && l.id == "144"));
    }

    #[test]
    fn media_json_annotation_upsert_and_delete_preserves_other_fields() {
        let raw = r#"{"version":1,"title":"Audit","mediaKind":"image","items":[{"id":"shot-1","src":"asset/image/s1.png"}]}"#;
        let ann = sample_ann("a1", 1, MediaAnnotationSeverity::P1, MediaAnnotationStatus::Open);
        let (encoded, saved, list) = upsert_media_doc_annotation(raw, Some("shot-1"), &ann, "g1", 500).unwrap();
        assert_eq!(saved.id, "a1");
        assert_eq!(list.len(), 1);
        assert_eq!(extract_media_doc_annotations(&encoded).len(), 1);

        let (encoded2, removed, remaining) = delete_media_doc_annotation(&encoded, Some("shot-1"), "a1").unwrap();
        assert!(removed.is_some());
        assert!(remaining.is_empty());
        assert!(extract_media_doc_annotations(&encoded2).is_empty());
    }
}
