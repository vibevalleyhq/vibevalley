//! Pure, lightweight preview extraction from a note's `structure/` and `asset/` files
//! for all 4 [`NoteType`] primitives (`doc`, `base`, `canvas`, `media`).

use std::collections::BTreeMap;

use serde_json::Value;
use vibevalley_protocol::{BlockKind, DocBlock, JsNumber, NotePreview, NotePreviewMinimapShape, NotePreviewOutlineItem, NoteType};

use crate::note::base::{cell_as_text, evaluate_row_formulas, parse_base_document};
use crate::note::doc::parse_doc_document;
use crate::note::path::{infer_mime, validate_note_path};

const DOC_EXCERPT_MAX_CHARS: usize = 220;
const OUTLINE_MAX_ITEMS: usize = 5;
const BASE_MAX_COLS: usize = 4;
const BASE_MAX_ROWS: usize = 3;
const CANVAS_MAX_SHAPES: usize = 24;

/// Extracts a compact, typed [`NotePreview`] from a note's relative file map (`path -> bytes`).
///
/// Server storage may subsequently populate `frame_path` on `Media` once `frame_asset`
/// is resolved against the local note directory on disk.
pub fn extract_note_preview(note_type: NoteType, files: &BTreeMap<String, Vec<u8>>) -> NotePreview {
    match note_type {
        NoteType::Doc => extract_doc(files),
        NoteType::Base => extract_base(files),
        NoteType::Canvas => extract_canvas(files),
        NoteType::Media => extract_media(files),
    }
}

/// Returns the relative `asset/...` path referenced by `preview`, if any.
pub fn preview_frame_asset(preview: &NotePreview) -> Option<&str> {
    match preview {
        NotePreview::Media { frame_asset, .. } => frame_asset.as_deref(),
        NotePreview::Doc { .. } | NotePreview::Base { .. } | NotePreview::Canvas { .. } => None,
    }
}

/// Attaches a resolved absolute local `frame_path` onto visual preview variants.
pub fn set_preview_frame_path(preview: &mut NotePreview, path: Option<String>) {
    match preview {
        NotePreview::Media { frame_path, .. } => *frame_path = path,
        NotePreview::Doc { .. } | NotePreview::Base { .. } | NotePreview::Canvas { .. } => {}
    }
}

fn read_text<'a>(files: &'a BTreeMap<String, Vec<u8>>, path: &str) -> Option<&'a str> {
    files.get(path).and_then(|b| std::str::from_utf8(b).ok())
}

fn parse_json(files: &BTreeMap<String, Vec<u8>>, path: &str) -> Option<Value> {
    let raw = read_text(files, path)?;
    serde_json::from_str(raw).ok()
}

fn truncate_chars(raw: &str, max_chars: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_owned();
    }
    let keep = max_chars.saturating_sub(1);
    let mut out: String = trimmed.chars().take(keep).collect();
    if let Some(last_space) = out.rfind(' ')
        && last_space > keep / 2
    {
        out.truncate(last_space);
    }
    let out = out.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':' | '-'));
    format!("{out}…")
}

fn collapse_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_opt(raw: Option<&str>, max_chars: usize) -> Option<String> {
    let s = collapse_whitespace(raw?);
    if s.is_empty() { None } else { Some(truncate_chars(&s, max_chars)) }
}

fn is_raster_image_asset(path: &str) -> bool {
    if validate_note_path(path).ok() != Some(crate::note::NotePathZone::Asset) {
        return false;
    }
    matches!(infer_mime(path), "image/png" | "image/jpeg" | "image/webp" | "image/gif")
}

fn first_image_asset(files: &BTreeMap<String, Vec<u8>>, preferred_prefixes: &[&str]) -> Option<String> {
    for prefix in preferred_prefixes {
        for path in files.keys() {
            if path.starts_with(prefix) && is_raster_image_asset(path) {
                return Some(path.clone());
            }
        }
    }
    for path in files.keys() {
        if is_raster_image_asset(path) {
            return Some(path.clone());
        }
    }
    None
}

fn valid_referenced_image(files: &BTreeMap<String, Vec<u8>>, candidate: &str) -> Option<String> {
    let trimmed = candidate.trim().trim_start_matches("./");
    if is_raster_image_asset(trimmed) && files.contains_key(trimmed) {
        Some(trimmed.to_owned())
    } else {
        None
    }
}

fn round3(v: f64) -> JsNumber {
    JsNumber(((v * 1000.0).round()) / 1000.0)
}

fn collect_doc_summary(
    blocks: &[DocBlock],
    heading: &mut Option<String>,
    excerpt_parts: &mut Vec<String>,
    outline: &mut Vec<NotePreviewOutlineItem>,
    block_count: &mut u32,
    slide_count: &mut u32,
) {
    for block in blocks {
        *block_count += 1;
        match &block.kind {
            BlockKind::Heading { level, text } => {
                let clean = collapse_whitespace(text);
                if heading.is_none() && !clean.is_empty() {
                    *heading = Some(truncate_chars(&clean, 80));
                }
                if outline.len() < OUTLINE_MAX_ITEMS && !clean.is_empty() {
                    outline.push(NotePreviewOutlineItem {
                        depth: u32::from(*level),
                        text: truncate_chars(&clean, 80),
                        kind: "heading".to_owned(),
                        checked: None,
                    });
                }
            }
            BlockKind::Prose { text } | BlockKind::Callout { text, .. } | BlockKind::Quote { text, .. } => {
                let clean = collapse_whitespace(text);
                if !clean.is_empty() && excerpt_parts.len() < 4 {
                    excerpt_parts.push(clean);
                }
            }
            BlockKind::Toggle { title, text } => {
                let clean = collapse_whitespace(if title.trim().is_empty() { text } else { title });
                if !clean.is_empty() && excerpt_parts.len() < 4 {
                    excerpt_parts.push(clean);
                }
            }
            BlockKind::List { items, .. } => {
                for item in items.iter().take(2) {
                    let clean = collapse_whitespace(item);
                    if !clean.is_empty() && excerpt_parts.len() < 4 {
                        excerpt_parts.push(clean);
                    }
                }
            }
            BlockKind::Todo { checked, text } => {
                let clean = collapse_whitespace(text);
                if outline.len() < OUTLINE_MAX_ITEMS && !clean.is_empty() {
                    outline.push(NotePreviewOutlineItem {
                        depth: 1,
                        text: truncate_chars(&clean, 80),
                        kind: "todo".to_owned(),
                        checked: Some(*checked),
                    });
                }
                if !clean.is_empty() && excerpt_parts.len() < 4 {
                    excerpt_parts.push(clean);
                }
            }
            BlockKind::PageBreak { .. } => {
                *slide_count += 1;
            }
            BlockKind::Columns { columns } => {
                for col in columns {
                    collect_doc_summary(&col.blocks, heading, excerpt_parts, outline, block_count, slide_count);
                }
            }
            BlockKind::Code { .. }
            | BlockKind::Kpi { .. }
            | BlockKind::Chart { .. }
            | BlockKind::Diagram { .. }
            | BlockKind::Compare { .. }
            | BlockKind::Media { .. }
            | BlockKind::Preview { .. }
            | BlockKind::BaseEmbed { .. }
            | BlockKind::IssueCard { .. }
            | BlockKind::IssueList { .. }
            | BlockKind::Table { .. }
            | BlockKind::Bookmark { .. }
            | BlockKind::Toc { .. }
            | BlockKind::Math { .. }
            | BlockKind::Divider => {}
        }
        if let Some(children) = &block.children {
            collect_doc_summary(children, heading, excerpt_parts, outline, block_count, slide_count);
        }
    }
}

fn extract_doc(files: &BTreeMap<String, Vec<u8>>) -> NotePreview {
    let blocks = if let Some(raw_json) = read_text(files, "structure/doc.json")
        && let Ok(doc) = parse_doc_document(raw_json)
    {
        doc.blocks
    } else {
        Vec::new()
    };

    let mut heading = None;
    let mut excerpt_parts = Vec::new();
    let mut outline = Vec::new();
    let mut block_count = 0u32;
    let mut slide_count = 1u32;
    collect_doc_summary(&blocks, &mut heading, &mut excerpt_parts, &mut outline, &mut block_count, &mut slide_count);
    let excerpt = truncate_chars(&excerpt_parts.join(" "), DOC_EXCERPT_MAX_CHARS);

    NotePreview::Doc {
        heading,
        excerpt,
        block_count,
        slide_count,
        outline,
    }
}

fn extract_base(files: &BTreeMap<String, Vec<u8>>) -> NotePreview {
    let Some(raw) = read_text(files, "structure/base.json") else {
        return NotePreview::Base {
            sheet_name: None,
            columns: Vec::new(),
            rows: Vec::new(),
            total_rows: 0,
            total_cols: 0,
        };
    };
    let Ok(doc) = parse_base_document(raw) else {
        return NotePreview::Base {
            sheet_name: None,
            columns: Vec::new(),
            rows: Vec::new(),
            total_rows: 0,
            total_cols: 0,
        };
    };
    let Some(sheet) = doc.sheets.first() else {
        return NotePreview::Base {
            sheet_name: None,
            columns: Vec::new(),
            rows: Vec::new(),
            total_rows: 0,
            total_cols: 0,
        };
    };

    let col_ids: Vec<&str> = sheet.columns.iter().take(BASE_MAX_COLS).map(|c| c.id.as_str()).collect();
    let columns: Vec<String> = sheet.columns.iter().take(BASE_MAX_COLS).map(|c| c.name.clone()).collect();
    let rows: Vec<Vec<String>> = sheet
        .rows
        .iter()
        .take(BASE_MAX_ROWS)
        .map(|row| {
            let evaluated = evaluate_row_formulas(&sheet.columns, row);
            col_ids
                .iter()
                .map(|cid| evaluated.cells.get(*cid).map(cell_as_text).unwrap_or_default())
                .collect()
        })
        .collect();

    NotePreview::Base {
        sheet_name: clean_opt(Some(&sheet.name), 64),
        columns,
        rows,
        total_rows: sheet.rows.len() as u32,
        total_cols: sheet.columns.len() as u32,
    }
}

fn extract_canvas(files: &BTreeMap<String, Vec<u8>>) -> NotePreview {
    let Some(board) = parse_json(files, "structure/board.json") else {
        return NotePreview::Canvas {
            shapes: Vec::new(),
            node_count: 0,
            theme: None,
        };
    };
    let theme = clean_opt(board.get("theme").and_then(Value::as_str), 32);
    let mut shapes = Vec::new();
    let mut node_count = 0u32;

    if let Some(elements) = board.get("elements").and_then(Value::as_object) {
        node_count = elements.len() as u32;
        for el in elements.values() {
            if shapes.len() >= CANVAS_MAX_SHAPES {
                break;
            }
            let x = el.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = el.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            let w = el.get("w").and_then(Value::as_f64).unwrap_or(40.0).max(1.0);
            let h = el.get("h").and_then(Value::as_f64).unwrap_or(24.0).max(1.0);
            let kind = el.get("type").and_then(Value::as_str).unwrap_or("rect").to_owned();
            let label = clean_opt(el.get("label").and_then(Value::as_str), 40);
            shapes.push(NotePreviewMinimapShape {
                x: round3(x),
                y: round3(y),
                w: round3(w),
                h: round3(h),
                kind,
                label,
            });
        }
    }

    NotePreview::Canvas { shapes, node_count, theme }
}

fn extract_media(files: &BTreeMap<String, Vec<u8>>) -> NotePreview {
    let meta = parse_json(files, "structure/media.json");
    let media_kind = meta
        .as_ref()
        .and_then(|v| v.get("mediaKind"))
        .and_then(Value::as_str)
        .unwrap_or("audio")
        .to_owned();
    let caption = meta.as_ref().and_then(|v| clean_opt(v.get("caption").and_then(Value::as_str), 160));
    let duration_sec = meta.as_ref().and_then(|v| v.get("durationSec")).and_then(Value::as_f64).map(round3);
    let frame_asset = meta
        .as_ref()
        .and_then(|v| v.get("posterAsset").and_then(Value::as_str))
        .and_then(|p| valid_referenced_image(files, p))
        .or_else(|| first_image_asset(files, &["asset/image/", "asset/frames/"]));

    NotePreview::Media {
        media_kind,
        caption,
        duration_sec,
        frame_asset,
        frame_path: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note::starter_directory;

    fn files_from_starter(ty: NoteType, title: &str) -> BTreeMap<String, Vec<u8>> {
        let dir = starter_directory("n_test", ty, title);
        dir.files.into_iter().map(|f| (f.path, f.content.into_bytes())).collect()
    }

    #[test]
    fn extracts_previews_from_all_four_note_starters() {
        for ty in NoteType::ALL {
            let files = files_from_starter(ty, "Launch Plan");
            let preview = extract_note_preview(ty, &files);
            match (ty, preview) {
                (
                    NoteType::Doc,
                    NotePreview::Doc {
                        heading, outline, slide_count, ..
                    },
                ) => {
                    assert_eq!(heading.as_deref(), Some("Launch Plan"));
                    assert_eq!(outline.len(), 1);
                    assert_eq!(slide_count, 1);
                }
                (
                    NoteType::Base,
                    NotePreview::Base {
                        sheet_name,
                        columns,
                        total_cols,
                        total_rows,
                        ..
                    },
                ) => {
                    assert_eq!(sheet_name.as_deref(), Some("Launch Plan"));
                    assert_eq!(total_cols, 3);
                    assert_eq!(total_rows, 1);
                    assert_eq!(columns.len(), 3);
                }
                (NoteType::Canvas, NotePreview::Canvas { shapes, node_count, theme }) => {
                    assert_eq!(node_count, 1);
                    assert_eq!(shapes.len(), 1);
                    assert_eq!(theme.as_deref(), Some("warm"));
                }
                (NoteType::Media, NotePreview::Media { media_kind, .. }) => {
                    assert_eq!(media_kind, "audio");
                }
                other => panic!("unexpected preview variant for {ty:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn media_preview_resolves_poster_or_first_asset_and_frame_path_setter() {
        let mut files = files_from_starter(NoteType::Media, "Clip");
        files.insert("asset/image/poster.png".to_owned(), vec![1, 2, 3, 4]);
        let mut preview = extract_note_preview(NoteType::Media, &files);
        assert_eq!(preview_frame_asset(&preview), Some("asset/image/poster.png"));
        set_preview_frame_path(&mut preview, Some("/tmp/note/n1/asset/image/poster.png".to_owned()));
        let NotePreview::Media { frame_path, .. } = preview else {
            panic!("expected Media preview");
        };
        assert_eq!(frame_path.as_deref(), Some("/tmp/note/n1/asset/image/poster.png"));
    }
}
