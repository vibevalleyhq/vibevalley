//! Pure, lightweight preview extraction from an artifact's `structure/` and `asset/` files
//! for all 12 [`ArtifactType`] variants.

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;
use vibevalley_protocol::{
    ArtifactPreview, ArtifactPreviewKpi, ArtifactPreviewMinimapShape, ArtifactPreviewOutlineItem, ArtifactPreviewSwatch, ArtifactType, JsNumber,
};

use crate::artifact::path::{infer_mime, validate_artifact_path};

const DOCS_EXCERPT_MAX_CHARS: usize = 220;
const DOCS_MAX_LINES: usize = 4;
const OUTLINE_MAX_ITEMS: usize = 5;
const SWATCH_MAX_COUNT: usize = 6;
const FONT_MAX_COUNT: usize = 3;
const KPI_MAX_COUNT: usize = 3;
const SERIES_MAX_POINTS: usize = 12;
const SHEET_MAX_COLS: usize = 4;
const SHEET_MAX_ROWS: usize = 3;
const WHITEBOARD_MAX_SHAPES: usize = 24;
const DIAGRAM_MAX_NODES: usize = 6;
const DESIGN_MAX_NODES: usize = 5;

/// Extracts a compact, typed [`ArtifactPreview`] from an artifact's relative file map (`path -> bytes`).
///
/// Server storage may subsequently populate `frame_path` on visual variants (`Design`, `Storyboard`,
/// `Motion`) once `frame_asset` is resolved against the local artifact directory on disk.
pub fn extract_artifact_preview(artifact_type: ArtifactType, files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    match artifact_type {
        ArtifactType::Docs => extract_docs(files),
        ArtifactType::Outline => extract_outline(files),
        ArtifactType::DesignSystem => extract_design_system(files),
        ArtifactType::Dashboard => extract_dashboard(files),
        ArtifactType::Sheet => extract_sheet(files),
        ArtifactType::Slides => extract_slides(files),
        ArtifactType::Whiteboard => extract_whiteboard(files),
        ArtifactType::Diagram => extract_diagram(files),
        ArtifactType::Design => extract_design(files),
        ArtifactType::Storyboard => extract_storyboard(files),
        ArtifactType::Motion => extract_motion(files),
        ArtifactType::Prototype => extract_prototype(files),
    }
}

/// Returns the relative `asset/...` path referenced by `preview`, if any.
pub fn preview_frame_asset(preview: &ArtifactPreview) -> Option<&str> {
    match preview {
        ArtifactPreview::Design { frame_asset, .. } | ArtifactPreview::Storyboard { frame_asset, .. } | ArtifactPreview::Motion { frame_asset, .. } => {
            frame_asset.as_deref()
        }
        ArtifactPreview::Docs { .. }
        | ArtifactPreview::Outline { .. }
        | ArtifactPreview::DesignSystem { .. }
        | ArtifactPreview::Dashboard { .. }
        | ArtifactPreview::Sheet { .. }
        | ArtifactPreview::Slides { .. }
        | ArtifactPreview::Whiteboard { .. }
        | ArtifactPreview::Diagram { .. }
        | ArtifactPreview::Prototype { .. } => None,
    }
}

/// Attaches a resolved absolute local `frame_path` onto visual preview variants.
pub fn set_preview_frame_path(preview: &mut ArtifactPreview, path: Option<String>) {
    match preview {
        ArtifactPreview::Design { frame_path, .. } | ArtifactPreview::Storyboard { frame_path, .. } | ArtifactPreview::Motion { frame_path, .. } => {
            *frame_path = path;
        }
        ArtifactPreview::Docs { .. }
        | ArtifactPreview::Outline { .. }
        | ArtifactPreview::DesignSystem { .. }
        | ArtifactPreview::Dashboard { .. }
        | ArtifactPreview::Sheet { .. }
        | ArtifactPreview::Slides { .. }
        | ArtifactPreview::Whiteboard { .. }
        | ArtifactPreview::Diagram { .. }
        | ArtifactPreview::Prototype { .. } => {}
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
    if validate_artifact_path(path).ok() != Some(crate::artifact::ArtifactPathZone::Asset) {
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

fn strip_inline_markdown(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // Skip images ![alt](url) -> alt
        if chars[i] == '!'
            && i + 1 < chars.len()
            && chars[i + 1] == '['
            && let Some(close_bracket) = chars[i + 2..].iter().position(|&c| c == ']')
        {
            let bracket_end = i + 2 + close_bracket;
            if bracket_end + 1 < chars.len()
                && chars[bracket_end + 1] == '('
                && let Some(close_paren) = chars[bracket_end + 2..].iter().position(|&c| c == ')')
            {
                let alt: String = chars[i + 2..bracket_end].iter().collect();
                if !alt.trim().is_empty() {
                    out.push_str(alt.trim());
                }
                i = bracket_end + 2 + close_paren + 1;
                continue;
            }
        }
        // Links [text](url) -> text
        if chars[i] == '['
            && let Some(close_bracket) = chars[i + 1..].iter().position(|&c| c == ']')
        {
            let bracket_end = i + 1 + close_bracket;
            if bracket_end + 1 < chars.len()
                && chars[bracket_end + 1] == '('
                && let Some(close_paren) = chars[bracket_end + 2..].iter().position(|&c| c == ')')
            {
                for &c in &chars[i + 1..bracket_end] {
                    if !matches!(c, '*' | '_' | '`' | '~') {
                        out.push(c);
                    }
                }
                i = bracket_end + 2 + close_paren + 1;
                continue;
            }
        }
        // Strip simple inline HTML tags like <br>, <span>, </span>
        if chars[i] == '<'
            && let Some(close_gt) = chars[i + 1..].iter().position(|&c| c == '>')
            && close_gt > 0
            && close_gt <= 48
        {
            let tag_inner: String = chars[i + 1..i + 1 + close_gt].iter().collect();
            if tag_inner.starts_with('/') || tag_inner.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
                i += close_gt + 2;
                out.push(' ');
                continue;
            }
        }
        if !matches!(chars[i], '*' | '_' | '`' | '~') {
            out.push(chars[i]);
        }
        i += 1;
    }
    collapse_whitespace(&out)
}

fn strip_list_prefix(line: &str) -> &str {
    let s = line.trim_start();
    if let Some(rest) = s
        .strip_prefix("- [x] ")
        .or_else(|| s.strip_prefix("- [X] "))
        .or_else(|| s.strip_prefix("- [ ] "))
        .or_else(|| s.strip_prefix("- "))
        .or_else(|| s.strip_prefix("* "))
        .or_else(|| s.strip_prefix("+ "))
    {
        return rest;
    }
    let digits_end = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits_end > 0
        && let Some(after_digits) = s.get(digits_end..)
        && let Some(rest) = after_digits.strip_prefix(". ").or_else(|| after_digits.strip_prefix(") "))
    {
        return rest;
    }
    s
}

fn is_md_rule_or_table_sep(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    if t.len() >= 3 && t.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')) {
        return true;
    }
    if t.contains('|') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
        return true;
    }
    false
}

fn extract_docs(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let md = read_text(files, "structure/index.md").or_else(|| {
        files
            .iter()
            .find(|(k, _)| k.starts_with("structure/") && k.ends_with(".md"))
            .and_then(|(_, v)| std::str::from_utf8(v).ok())
    });
    let Some(raw) = md else {
        return ArtifactPreview::Docs {
            heading: None,
            excerpt: String::new(),
        };
    };

    let mut heading: Option<String> = None;
    let mut excerpt_lines: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut in_frontmatter = false;
    let mut line_idx = 0usize;

    for raw_line in raw.lines() {
        let trimmed = raw_line.trim();
        if line_idx == 0 && trimmed == "---" {
            in_frontmatter = true;
            line_idx += 1;
            continue;
        }
        line_idx += 1;
        if in_frontmatter {
            if trimmed == "---" || trimmed == "..." {
                in_frontmatter = false;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || is_md_rule_or_table_sep(trimmed) {
            continue;
        }
        if trimmed.starts_with('#') {
            let title_text = trimmed.trim_start_matches('#').trim();
            let cleaned = strip_inline_markdown(title_text);
            if heading.is_none() && !cleaned.is_empty() {
                heading = Some(truncate_chars(&cleaned, 80));
            } else if heading.is_some() && !cleaned.is_empty() && excerpt_lines.len() < DOCS_MAX_LINES {
                excerpt_lines.push(cleaned);
            }
            continue;
        }
        let without_quote = trimmed.trim_start_matches('>').trim_start();
        let without_list = strip_list_prefix(without_quote);
        let cleaned = strip_inline_markdown(without_list);
        if !cleaned.is_empty() {
            excerpt_lines.push(cleaned);
            if excerpt_lines.len() >= DOCS_MAX_LINES {
                break;
            }
        }
    }

    let joined = excerpt_lines.join("\n");
    let excerpt = truncate_chars(&joined, DOCS_EXCERPT_MAX_CHARS);
    ArtifactPreview::Docs { heading, excerpt }
}

fn extract_outline(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let Some(doc) = parse_json(files, "structure/outline.json") else {
        return ArtifactPreview::Outline {
            items: Vec::new(),
            todo_done: 0,
            todo_total: 0,
        };
    };
    let root_ids: Vec<&str> = doc
        .get("rootIds")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(nodes) = doc.get("nodes").and_then(Value::as_object) else {
        return ArtifactPreview::Outline {
            items: Vec::new(),
            todo_done: 0,
            todo_total: 0,
        };
    };

    let mut visited = HashSet::new();
    let mut items = Vec::new();
    let mut todo_done: u32 = 0;
    let mut todo_total: u32 = 0;

    fn walk<'a>(
        id: &'a str,
        depth: u32,
        nodes: &'a serde_json::Map<String, Value>,
        visited: &mut HashSet<&'a str>,
        items: &mut Vec<ArtifactPreviewOutlineItem>,
        todo_done: &mut u32,
        todo_total: &mut u32,
    ) {
        if !visited.insert(id) {
            return;
        }
        let Some(node) = nodes.get(id).and_then(Value::as_object) else {
            return;
        };
        let kind_raw = node.get("kind").and_then(Value::as_str).unwrap_or("bullet");
        let kind = match kind_raw {
            "heading" | "todo" => kind_raw,
            _ => "bullet",
        };
        let checked = node.get("checked").and_then(Value::as_bool);
        if kind == "todo" {
            *todo_total = todo_total.saturating_add(1);
            if checked == Some(true) {
                *todo_done = todo_done.saturating_add(1);
            }
        }
        if items.len() < OUTLINE_MAX_ITEMS
            && let Some(text) = clean_opt(node.get("text").and_then(Value::as_str), 80)
        {
            items.push(ArtifactPreviewOutlineItem {
                depth: depth.min(4),
                text,
                kind: kind.to_owned(),
                checked: if kind == "todo" { Some(checked.unwrap_or(false)) } else { None },
            });
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for child in children.iter().filter_map(Value::as_str) {
                walk(child, depth + 1, nodes, visited, items, todo_done, todo_total);
            }
        }
    }

    for id in root_ids {
        walk(id, 0, nodes, &mut visited, &mut items, &mut todo_done, &mut todo_total);
    }

    ArtifactPreview::Outline { items, todo_done, todo_total }
}

fn clean_font_name(raw: &str) -> Option<String> {
    let first = raw.split(',').next()?.trim().trim_matches(|c| matches!(c, '\'' | '"'));
    if first.is_empty() { None } else { Some(truncate_chars(first, 32)) }
}

fn extract_design_system(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let Some(doc) = parse_json(files, "structure/tokens.json") else {
        return ArtifactPreview::DesignSystem {
            swatches: Vec::new(),
            fonts: Vec::new(),
        };
    };

    let mut swatches = Vec::new();
    match doc.get("color") {
        Some(Value::Array(arr)) => {
            for item in arr {
                if swatches.len() >= SWATCH_MAX_COUNT {
                    break;
                }
                let Some(obj) = item.as_object() else { continue };
                let Some(name) = obj
                    .get("id")
                    .or_else(|| obj.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let (light, dark) = match obj.get("value") {
                    Some(Value::Object(v)) => (
                        v.get("light").and_then(Value::as_str).map(str::trim).unwrap_or(""),
                        v.get("dark").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()),
                    ),
                    Some(Value::String(s)) => (s.trim(), None),
                    _ => continue,
                };
                if !light.is_empty() {
                    swatches.push(ArtifactPreviewSwatch {
                        name: truncate_chars(name, 28),
                        light: light.to_owned(),
                        dark: dark.map(str::to_owned),
                    });
                }
            }
        }
        Some(Value::Object(map)) => {
            for (name, val) in map {
                if swatches.len() >= SWATCH_MAX_COUNT {
                    break;
                }
                let (light, dark) = match val {
                    Value::Object(v) => (
                        v.get("light").and_then(Value::as_str).map(str::trim).unwrap_or(""),
                        v.get("dark").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()),
                    ),
                    Value::String(s) => (s.trim(), None),
                    _ => continue,
                };
                if !light.is_empty() {
                    swatches.push(ArtifactPreviewSwatch {
                        name: truncate_chars(name, 28),
                        light: light.to_owned(),
                        dark: dark.map(str::to_owned),
                    });
                }
            }
        }
        _ => {}
    }

    let mut fonts = Vec::new();
    let mut seen_fonts = HashSet::new();
    let type_obj = doc.get("type").or_else(|| doc.get("typography")).and_then(Value::as_object);
    if let Some(to) = type_obj {
        let mut push_font = |val: &str| {
            if fonts.len() >= FONT_MAX_COUNT {
                return;
            }
            if let Some(f) = clean_font_name(val)
                && seen_fonts.insert(f.to_ascii_lowercase())
            {
                fonts.push(f);
            }
        };
        if let Some(Value::Array(arr)) = to.get("families") {
            for item in arr {
                if let Some(v) = item.get("value").and_then(Value::as_str) {
                    push_font(v);
                } else if let Some(v) = item.as_str() {
                    push_font(v);
                }
            }
        } else if let Some(Value::Object(fam_map)) = to.get("families") {
            for v in fam_map.values().filter_map(Value::as_str) {
                push_font(v);
            }
        } else {
            for (k, v) in to {
                if matches!(k.as_str(), "scale" | "styles") {
                    continue;
                }
                if let Some(s) = v.as_str() {
                    push_font(s);
                }
            }
        }
    }

    ArtifactPreview::DesignSystem { swatches, fonts }
}

fn read_numeric_value(val: &Value) -> Option<f64> {
    match val {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                t.parse::<f64>().ok().filter(|f| f.is_finite())
            }
        }
        _ => None,
    }
}

fn format_number_en(raw: f64) -> String {
    let rounded = (raw * 100.0).round() / 100.0;
    let is_neg = rounded.is_sign_negative() && rounded != 0.0;
    let abs = rounded.abs();
    let int_part = abs.trunc() as u64;
    let frac = ((abs - abs.trunc()) * 100.0).round() as u64;
    let int_digits = int_part.to_string();
    let mut grouped = String::with_capacity(int_digits.len() + int_digits.len() / 3);
    for (idx, ch) in int_digits.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let grouped: String = grouped.chars().rev().collect();
    let sign = if is_neg { "-" } else { "" };
    if frac == 0 {
        format!("{sign}{grouped}")
    } else if frac.is_multiple_of(10) {
        format!("{sign}{grouped}.{}", frac / 10)
    } else {
        format!("{sign}{grouped}.{frac:02}")
    }
}

fn format_kpi_value(raw: f64, format: &str) -> String {
    let num = format_number_en(raw);
    match format {
        "percent" => format!("{num}%"),
        "currency" => format!("${num}"),
        _ => num,
    }
}

fn extract_dashboard(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let Some(doc) = parse_json(files, "structure/dashboard.json") else {
        return ArtifactPreview::Dashboard {
            kpis: Vec::new(),
            series: Vec::new(),
        };
    };

    let mut datasets: BTreeMap<String, Value> = BTreeMap::new();
    for path in files.keys() {
        if path.starts_with("structure/data/")
            && path.ends_with(".json")
            && let Some(val) = parse_json(files, path)
        {
            datasets.insert(path.clone(), val);
        }
    }

    let mut kpis = Vec::new();
    if let Some(panels) = doc.get("panels").and_then(Value::as_array) {
        for panel in panels {
            if kpis.len() >= KPI_MAX_COUNT {
                break;
            }
            let Some(obj) = panel.as_object() else { continue };
            let label = clean_opt(
                obj.get("label").or_else(|| obj.get("title")).or_else(|| obj.get("id")).and_then(Value::as_str),
                32,
            );
            let Some(label) = label else { continue };
            let format = obj.get("format").and_then(Value::as_str).unwrap_or("number");

            // Static value fallback if provided directly on the panel.
            if let Some(static_val) = obj.get("value") {
                if let Some(n) = read_numeric_value(static_val) {
                    kpis.push(ArtifactPreviewKpi {
                        label,
                        value: format_kpi_value(n, format),
                    });
                    continue;
                } else if let Some(s) = clean_opt(static_val.as_str(), 24) {
                    kpis.push(ArtifactPreviewKpi { label, value: s });
                    continue;
                }
            }

            let Some(source) = obj.get("source").and_then(Value::as_object) else {
                continue;
            };
            let dataset_path = source.get("dataset").and_then(Value::as_str).unwrap_or("");
            let field = source.get("field").and_then(Value::as_str).unwrap_or("");
            let agg = source.get("agg").and_then(Value::as_str).unwrap_or("avg");
            let ds = if !dataset_path.is_empty() {
                datasets.get(dataset_path)
            } else {
                datasets.values().next()
            };
            let Some(rows) = ds.and_then(|d| d.get("rows")).and_then(Value::as_array) else {
                continue;
            };
            if agg == "count" {
                kpis.push(ArtifactPreviewKpi {
                    label,
                    value: format_number_en(rows.len() as f64),
                });
                continue;
            }
            if field.is_empty() {
                continue;
            }
            let nums: Vec<f64> = rows
                .iter()
                .filter_map(|r| r.as_object().and_then(|m| m.get(field)).and_then(read_numeric_value))
                .collect();
            if nums.is_empty() {
                continue;
            }
            let raw = match agg {
                "sum" => nums.iter().sum(),
                "min" => nums.iter().copied().fold(f64::INFINITY, f64::min),
                "max" => nums.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                "last" => *nums.last().unwrap_or(&0.0),
                _ => nums.iter().sum::<f64>() / (nums.len() as f64),
            };
            kpis.push(ArtifactPreviewKpi {
                label,
                value: format_kpi_value(raw, format),
            });
        }
    }

    // Extract normalized mini numeric series from the first dataset with >= 2 numeric rows.
    let mut series = Vec::new();
    'ds_loop: for ds in datasets.values() {
        let Some(rows) = ds.get("rows").and_then(Value::as_array) else {
            continue;
        };
        if rows.len() < 2 {
            continue;
        }
        let mut candidate_fields: Vec<String> = Vec::new();
        if let Some(schema) = ds.get("schema").and_then(Value::as_array) {
            for col in schema {
                if col.get("type").and_then(Value::as_str) == Some("number")
                    && let Some(name) = col.get("name").and_then(Value::as_str)
                {
                    candidate_fields.push(name.to_owned());
                }
            }
        }
        if candidate_fields.is_empty()
            && let Some(first_row) = rows.first().and_then(Value::as_object)
        {
            for (k, v) in first_row {
                if read_numeric_value(v).is_some() {
                    candidate_fields.push(k.clone());
                }
            }
        }
        for field in candidate_fields {
            let raw_nums: Vec<f64> = rows
                .iter()
                .take(SERIES_MAX_POINTS)
                .filter_map(|r| r.as_object().and_then(|m| m.get(&field)).and_then(read_numeric_value))
                .collect();
            if raw_nums.len() >= 2 {
                let min_v = raw_nums.iter().copied().fold(f64::INFINITY, f64::min);
                let max_v = raw_nums.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                for v in raw_nums {
                    let norm = if (max_v - min_v).abs() < f64::EPSILON {
                        if max_v > 0.0 { 0.6 } else { 0.2 }
                    } else if min_v >= 0.0 && max_v > 0.0 {
                        (v / max_v).clamp(0.05, 1.0)
                    } else {
                        ((v - min_v) / (max_v - min_v)).clamp(0.05, 1.0)
                    };
                    series.push(round3(norm));
                }
                break 'ds_loop;
            }
        }
    }

    ArtifactPreview::Dashboard { kpis, series }
}

fn format_cell(val: Option<&Value>) -> String {
    match val {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => truncate_chars(&collapse_whitespace(s), 28),
        Some(Value::Number(n)) => n.as_f64().map(format_number_en).unwrap_or_else(|| n.to_string()),
        Some(Value::Bool(b)) => if *b { "true" } else { "false" }.to_owned(),
        Some(other) => truncate_chars(&other.to_string(), 28),
    }
}

fn extract_sheet(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let workbook = parse_json(files, "structure/workbook.json");
    let first_sheet_ref = workbook
        .as_ref()
        .and_then(|wb| wb.get("sheets"))
        .and_then(Value::as_array)
        .and_then(|arr| arr.first());
    let first_sheet_path = first_sheet_ref
        .and_then(|s| s.get("file"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| files.keys().find(|k| k.starts_with("structure/sheets/") && k.ends_with(".json")).cloned());

    let sheet_doc = first_sheet_path.as_deref().and_then(|p| parse_json(files, p));
    let sheet_name = sheet_doc
        .as_ref()
        .and_then(|s| s.get("title"))
        .and_then(Value::as_str)
        .or_else(|| first_sheet_ref.and_then(|s| s.get("title")).and_then(Value::as_str))
        .and_then(|s| clean_opt(Some(s), 40));

    let Some(sheet) = sheet_doc else {
        return ArtifactPreview::Sheet {
            sheet_name,
            columns: Vec::new(),
            rows: Vec::new(),
            total_rows: 0,
            total_cols: 0,
        };
    };

    let raw_cols: Vec<(String, String)> = sheet
        .get("columns")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    if let Some(s) = c.as_str() {
                        let t = truncate_chars(s, 24);
                        return Some((t.clone(), t));
                    }
                    let obj = c.as_object()?;
                    let key = obj.get("key").or_else(|| obj.get("id")).and_then(Value::as_str).unwrap_or("");
                    let title = obj.get("title").or_else(|| obj.get("label")).and_then(Value::as_str).unwrap_or(key);
                    let display = clean_opt(Some(title), 24).unwrap_or_else(|| key.to_owned());
                    Some((key.to_owned(), display))
                })
                .collect()
        })
        .unwrap_or_default();

    let raw_rows = sheet.get("rows").and_then(Value::as_array);
    let total_rows = raw_rows.map_or(0, |r| r.len() as u32);
    let total_cols = if !raw_cols.is_empty() {
        raw_cols.len() as u32
    } else {
        raw_rows.and_then(|r| r.first()).map_or(0, |first| match first {
            Value::Object(m) => m.len() as u32,
            Value::Array(a) => a.len() as u32,
            _ => 0,
        })
    };

    let cols_meta: Vec<(String, String)> = if !raw_cols.is_empty() {
        raw_cols.into_iter().take(SHEET_MAX_COLS).collect()
    } else if let Some(Value::Object(m)) = raw_rows.and_then(|r| r.first()) {
        m.keys().take(SHEET_MAX_COLS).map(|k| (k.clone(), truncate_chars(k, 24))).collect()
    } else {
        Vec::new()
    };

    let columns: Vec<String> = cols_meta.iter().map(|(_, title)| title.clone()).collect();
    let mut rows = Vec::new();
    if let Some(arr) = raw_rows {
        for row_val in arr.iter().take(SHEET_MAX_ROWS) {
            match row_val {
                Value::Object(map) => {
                    let cells = cols_meta
                        .iter()
                        .map(|(key, title)| format_cell(map.get(key).or_else(|| map.get(title))))
                        .collect();
                    rows.push(cells);
                }
                Value::Array(arr_row) => {
                    let count = columns.len().max(arr_row.len().min(SHEET_MAX_COLS));
                    let cells = (0..count).map(|idx| format_cell(arr_row.get(idx))).collect();
                    rows.push(cells);
                }
                _ => {}
            }
        }
    }

    ArtifactPreview::Sheet {
        sheet_name,
        columns,
        rows,
        total_rows,
        total_cols,
    }
}

fn extract_slides(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let Some(deck) = parse_json(files, "structure/deck.json") else {
        return ArtifactPreview::Slides {
            first_title: None,
            first_subtitle: None,
            slide_count: 0,
        };
    };
    let slides_arr = deck.get("slides").and_then(Value::as_array);
    let slide_count = slides_arr.map_or(0, |s| s.len() as u32);
    let first_entry = slides_arr.and_then(|s| s.first());
    let first_file = first_entry.and_then(|s| s.get("file")).and_then(Value::as_str);
    let slide_doc = first_file.and_then(|p| parse_json(files, p));

    let first_title = slide_doc
        .as_ref()
        .and_then(|s| clean_opt(s.get("title").and_then(Value::as_str), 80))
        .or_else(|| first_entry.and_then(|s| clean_opt(s.get("title").and_then(Value::as_str), 80)))
        .or_else(|| clean_opt(deck.get("title").and_then(Value::as_str), 80));

    let first_subtitle = slide_doc
        .as_ref()
        .and_then(|s| clean_opt(s.get("subtitle").and_then(Value::as_str), 100))
        .or_else(|| {
            slide_doc.as_ref().and_then(|s| s.get("blocks")).and_then(Value::as_array).and_then(|blocks| {
                blocks.iter().find_map(|b| {
                    let obj = b.as_object()?;
                    clean_opt(
                        obj.get("text")
                            .or_else(|| obj.get("heading"))
                            .or_else(|| obj.get("body"))
                            .and_then(Value::as_str),
                        100,
                    )
                })
            })
        });

    ArtifactPreview::Slides {
        first_title,
        first_subtitle,
        slide_count,
    }
}

fn extract_whiteboard(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let Some(board) = parse_json(files, "structure/board.json") else {
        return ArtifactPreview::Whiteboard {
            shapes: Vec::new(),
            node_count: 0,
        };
    };

    let raw_elements: Vec<&serde_json::Map<String, Value>> = match board.get("elements") {
        Some(Value::Object(map)) => map.values().filter_map(Value::as_object).collect(),
        Some(Value::Array(arr)) => arr.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    };

    struct RawBox {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        kind: String,
        label: Option<String>,
    }

    let mut boxes = Vec::new();
    let mut node_count: u32 = 0;

    for el in raw_elements {
        let ty = el.get("type").and_then(Value::as_str).unwrap_or("shape");
        if matches!(ty, "arrow" | "edge" | "connector" | "line") {
            continue;
        }
        node_count = node_count.saturating_add(1);
        let Some(x) = el.get("x").and_then(read_numeric_value) else {
            continue;
        };
        let Some(y) = el.get("y").and_then(read_numeric_value) else {
            continue;
        };
        let w = el
            .get("w")
            .or_else(|| el.get("width"))
            .and_then(read_numeric_value)
            .filter(|&v| v > 0.0)
            .unwrap_or(160.0);
        let h = el
            .get("h")
            .or_else(|| el.get("height"))
            .and_then(read_numeric_value)
            .filter(|&v| v > 0.0)
            .unwrap_or(80.0);
        let kind = el.get("shape").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(ty).to_owned();
        let label = clean_opt(
            el.get("title").or_else(|| el.get("label")).or_else(|| el.get("text")).and_then(Value::as_str),
            28,
        );
        boxes.push(RawBox { x, y, w, h, kind, label });
    }

    if boxes.is_empty() {
        return ArtifactPreview::Whiteboard {
            shapes: Vec::new(),
            node_count,
        };
    }

    // Deterministic order: top-to-bottom, left-to-right so minimap is stable across runs.
    boxes.sort_by(|a, b| a.y.total_cmp(&b.y).then_with(|| a.x.total_cmp(&b.x)));

    let min_x = boxes.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
    let min_y = boxes.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
    let max_x = boxes.iter().map(|b| b.x + b.w).fold(f64::NEG_INFINITY, f64::max);
    let max_y = boxes.iter().map(|b| b.y + b.h).fold(f64::NEG_INFINITY, f64::max);

    let span_x = (max_x - min_x).max(1.0);
    let span_y = (max_y - min_y).max(1.0);
    // Add 6% breathing margin around the normalized minimap.
    let pad_x = span_x * 0.06;
    let pad_y = span_y * 0.06;
    let total_w = span_x + pad_x * 2.0;
    let total_h = span_y + pad_y * 2.0;

    let shapes = boxes
        .into_iter()
        .take(WHITEBOARD_MAX_SHAPES)
        .map(|b| {
            let nx = ((b.x - min_x + pad_x) / total_w).clamp(0.0, 0.98);
            let ny = ((b.y - min_y + pad_y) / total_h).clamp(0.0, 0.98);
            let nw = (b.w / total_w).clamp(0.03, 1.0 - nx);
            let nh = (b.h / total_h).clamp(0.03, 1.0 - ny);
            ArtifactPreviewMinimapShape {
                x: round3(nx),
                y: round3(ny),
                w: round3(nw),
                h: round3(nh),
                kind: b.kind,
                label: b.label,
            }
        })
        .collect();

    ArtifactPreview::Whiteboard { shapes, node_count }
}

fn extract_diagram(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    if let Some(doc) = parse_json(files, "structure/diagram.json") {
        let kind = clean_opt(doc.get("kind").and_then(Value::as_str), 32);
        let raw_nodes = doc.get("nodes").and_then(Value::as_array);
        let raw_edges = doc.get("edges").and_then(Value::as_array);
        let node_count = raw_nodes.map_or(0, |n| n.len() as u32);
        let edge_count = raw_edges.map_or(0, |e| e.len() as u32);
        let nodes: Vec<String> = raw_nodes
            .map(|arr| {
                arr.iter()
                    .filter_map(|n| {
                        let obj = n.as_object()?;
                        clean_opt(
                            obj.get("label").or_else(|| obj.get("name")).or_else(|| obj.get("id")).and_then(Value::as_str),
                            32,
                        )
                    })
                    .take(DIAGRAM_MAX_NODES)
                    .collect()
            })
            .unwrap_or_default();
        if !nodes.is_empty() || edge_count > 0 || files.get("structure/diagram.mmd").is_none() {
            return ArtifactPreview::Diagram {
                kind,
                nodes,
                node_count,
                edge_count,
            };
        }
    }

    // Fallback: lightweight scan of `structure/diagram.mmd` when JSON has no nodes.
    if let Some(mmd) = read_text(files, "structure/diagram.mmd") {
        let mut kind: Option<String> = None;
        let mut nodes = Vec::new();
        let mut seen = HashSet::new();
        let mut edge_count: u32 = 0;

        for line in mmd.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("%%")) {
            if kind.is_none() {
                if line.starts_with("sequenceDiagram") {
                    kind = Some("sequence".to_owned());
                    continue;
                } else if line.starts_with("stateDiagram") {
                    kind = Some("state-machine".to_owned());
                    continue;
                } else if line.starts_with("erDiagram") {
                    kind = Some("er".to_owned());
                    continue;
                } else if line.starts_with("flowchart") || line.starts_with("graph") {
                    kind = Some("flowchart".to_owned());
                    continue;
                }
            }
            if line.contains("-->") || line.contains("->>") || line.contains("->") || line.contains("---") || line.contains("==") {
                edge_count = edge_count.saturating_add(1);
            }
            if let Some(rest) = line.strip_prefix("participant ").or_else(|| line.strip_prefix("actor ")) {
                let label = rest.split(" as ").nth(1).unwrap_or(rest).trim();
                if let Some(c) = clean_opt(Some(label), 32)
                    && seen.insert(c.clone())
                {
                    nodes.push(c);
                }
            } else if let Some(start) = line.find("[\"")
                && let Some(end) = line[start + 2..].find("\"]")
            {
                let label = &line[start + 2..start + 2 + end];
                if let Some(c) = clean_opt(Some(label), 32)
                    && seen.insert(c.clone())
                {
                    nodes.push(c);
                }
            }
        }
        let node_count = nodes.len() as u32;
        nodes.truncate(DIAGRAM_MAX_NODES);
        return ArtifactPreview::Diagram {
            kind,
            nodes,
            node_count,
            edge_count,
        };
    }

    ArtifactPreview::Diagram {
        kind: None,
        nodes: Vec::new(),
        node_count: 0,
        edge_count: 0,
    }
}

fn collect_design_node_summaries(node: &Value, out: &mut Vec<String>, asset_out: &mut Option<String>, files: &BTreeMap<String, Vec<u8>>) {
    let Some(obj) = node.as_object() else { return };
    if asset_out.is_none()
        && let Some(src) = obj.get("src").and_then(Value::as_str)
    {
        *asset_out = valid_referenced_image(files, src);
    }
    if out.len() < DESIGN_MAX_NODES
        && let Some(label) = clean_opt(
            obj.get("text").or_else(|| obj.get("name")).or_else(|| obj.get("label")).and_then(Value::as_str),
            36,
        )
    {
        out.push(label);
    }
    if let Some(children) = obj.get("children").and_then(Value::as_array) {
        for child in children {
            if out.len() >= DESIGN_MAX_NODES && asset_out.is_some() {
                break;
            }
            collect_design_node_summaries(child, out, asset_out, files);
        }
    }
}

fn extract_design(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let frame_path = if files.contains_key("structure/frames/main.json") {
        Some("structure/frames/main.json")
    } else {
        files
            .keys()
            .find(|k| k.starts_with("structure/frames/") && k.ends_with(".json"))
            .map(String::as_str)
    };
    let doc = frame_path.and_then(|p| parse_json(files, p));
    let Some(obj) = doc.as_ref().and_then(Value::as_object) else {
        return ArtifactPreview::Design {
            artboard: None,
            width: None,
            height: None,
            theme: None,
            nodes: Vec::new(),
            frame_asset: first_image_asset(files, &["asset/"]),
            frame_path: None,
        };
    };

    let artboard = clean_opt(obj.get("name").or_else(|| obj.get("id")).and_then(Value::as_str), 48);
    let vp = obj.get("viewport").and_then(Value::as_object);
    let width = vp
        .and_then(|v| v.get("w"))
        .or_else(|| obj.get("width"))
        .and_then(read_numeric_value)
        .filter(|&n| n > 0.0)
        .map(|n| n.round() as u32);
    let height = vp
        .and_then(|v| v.get("h"))
        .or_else(|| obj.get("height"))
        .and_then(read_numeric_value)
        .filter(|&n| n > 0.0)
        .map(|n| n.round() as u32);
    let theme = match obj.get("theme").and_then(Value::as_str) {
        Some("dark") => Some("dark".to_owned()),
        Some("light") => Some("light".to_owned()),
        _ => None,
    };

    let mut nodes = Vec::new();
    let mut frame_asset = None;
    if let Some(root) = obj.get("root") {
        if let Some(children) = root.get("children").and_then(Value::as_array) {
            for child in children {
                collect_design_node_summaries(child, &mut nodes, &mut frame_asset, files);
            }
        } else {
            collect_design_node_summaries(root, &mut nodes, &mut frame_asset, files);
        }
    }
    if let Some(flat_nodes) = obj.get("nodes").and_then(Value::as_array) {
        for n in flat_nodes {
            collect_design_node_summaries(n, &mut nodes, &mut frame_asset, files);
        }
    }
    if frame_asset.is_none() {
        frame_asset = first_image_asset(files, &["asset/"]);
    }

    ArtifactPreview::Design {
        artboard,
        width,
        height,
        theme,
        nodes,
        frame_asset,
        frame_path: None,
    }
}

fn extract_storyboard(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let doc = parse_json(files, "structure/shots.json");
    let shots = doc.as_ref().and_then(|d| d.get("shots")).and_then(Value::as_array);
    let shot_count = shots.map_or(0, |s| s.len() as u32);

    let mut total_dur = 0.0;
    let mut has_dur = false;
    let mut first_shot = None;
    let mut frame_asset = None;

    if let Some(arr) = shots {
        for (idx, shot) in arr.iter().enumerate() {
            let Some(obj) = shot.as_object() else { continue };
            if let Some(d) = obj.get("durationSec").and_then(read_numeric_value)
                && d > 0.0
            {
                total_dur += d;
                has_dur = true;
            }
            if idx == 0 {
                first_shot = clean_opt(
                    obj.get("visual")
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| obj.get("scene").and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
                        .or_else(|| obj.get("dialogue").and_then(Value::as_str)),
                    120,
                );
            }
            if frame_asset.is_none()
                && let Some(fa) = obj.get("frameAsset").and_then(Value::as_str)
            {
                frame_asset = valid_referenced_image(files, fa);
            }
        }
    }

    if frame_asset.is_none()
        && let Some(refs) = doc
            .as_ref()
            .and_then(|d| d.get("styleGuide"))
            .and_then(|sg| sg.get("continuityRefs"))
            .and_then(Value::as_array)
    {
        for r in refs.iter().filter_map(Value::as_str) {
            if let Some(valid) = valid_referenced_image(files, r) {
                frame_asset = Some(valid);
                break;
            }
        }
    }
    if frame_asset.is_none() {
        frame_asset = first_image_asset(files, &["asset/frames/", "asset/refs/", "asset/"]);
    }

    ArtifactPreview::Storyboard {
        shot_count,
        first_shot,
        duration_sec: has_dur.then(|| round3(total_dur)),
        frame_asset,
        frame_path: None,
    }
}

fn extract_motion(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let doc = parse_json(files, "structure/timeline.json");
    let scenes = doc.as_ref().and_then(|d| d.get("scenes")).and_then(Value::as_array);
    let scene_count = scenes.map_or(0, |s| s.len() as u32);
    let duration_sec = doc
        .as_ref()
        .and_then(|d| d.get("duration"))
        .and_then(read_numeric_value)
        .filter(|&n| n > 0.0)
        .map(round3);

    let first_scene_entry = scenes.and_then(|s| s.first());
    let first_scene_file = first_scene_entry.and_then(|s| s.get("file")).and_then(Value::as_str);
    let first_scene_doc = first_scene_file.and_then(|p| parse_json(files, p));

    let mut frame_asset = None;
    let mut layer_text = None;
    if let Some(layers) = first_scene_doc.as_ref().and_then(|d| d.get("layers")).and_then(Value::as_array) {
        for layer in layers {
            let Some(obj) = layer.as_object() else { continue };
            if frame_asset.is_none()
                && let Some(src) = obj.get("src").and_then(Value::as_str)
            {
                frame_asset = valid_referenced_image(files, src);
            }
            if layer_text.is_none() {
                layer_text = clean_opt(obj.get("text").or_else(|| obj.get("label")).and_then(Value::as_str), 80);
            }
        }
    }
    if frame_asset.is_none() {
        frame_asset = first_image_asset(files, &["asset/image/", "asset/"]);
    }

    let first_scene = first_scene_doc
        .as_ref()
        .and_then(|d| clean_opt(d.get("title").and_then(Value::as_str), 80))
        .or(layer_text)
        .or_else(|| {
            doc.as_ref()
                .and_then(|d| d.get("chapters"))
                .and_then(Value::as_array)
                .and_then(|c| c.first())
                .and_then(|c| clean_opt(c.get("label").and_then(Value::as_str), 80))
        })
        .or_else(|| first_scene_entry.and_then(|s| clean_opt(s.get("id").and_then(Value::as_str), 80)));

    ArtifactPreview::Motion {
        scene_count,
        duration_sec,
        first_scene,
        frame_asset,
        frame_path: None,
    }
}

fn unescape_html_entities(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn strip_html_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        if ch == '<' {
            in_tag = true;
            out.push(' ');
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(ch);
        }
    }
    collapse_whitespace(&unescape_html_entities(&out))
}

fn find_html_tag_inner<'a>(html: &'a str, lower: &str, tag: &str) -> Option<&'a str> {
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}>");
    let mut search_from = 0;
    while let Some(rel_start) = lower[search_from..].find(&open_pat) {
        let start = search_from + rel_start;
        let after_tag = start + open_pat.len();
        let next_byte = lower.as_bytes().get(after_tag).copied();
        if !matches!(next_byte, Some(b'>' | b' ' | b'\t' | b'\r' | b'\n' | b'/')) {
            search_from = after_tag;
            continue;
        }
        let gt_rel = lower[after_tag..].find('>')?;
        let content_start = after_tag + gt_rel + 1;
        let close_rel = lower[content_start..].find(&close_pat)?;
        let content_end = content_start + close_rel;
        if html.is_char_boundary(content_start) && html.is_char_boundary(content_end) {
            return Some(&html[content_start..content_end]);
        }
        return None;
    }
    None
}

fn extract_prototype(files: &BTreeMap<String, Vec<u8>>) -> ArtifactPreview {
    let html = read_text(files, "structure/index.html").or_else(|| {
        files
            .iter()
            .find(|(k, _)| k.starts_with("structure/") && (k.ends_with(".html") || k.ends_with(".htm")))
            .and_then(|(_, v)| std::str::from_utf8(v).ok())
    });
    let Some(raw) = html else {
        return ArtifactPreview::Prototype { heading: None, subtitle: None };
    };
    // ASCII-only lowercasing keeps byte indices identical to `raw` for safe slicing.
    let lower = raw.to_ascii_lowercase();
    let heading = find_html_tag_inner(raw, &lower, "h1")
        .map(strip_html_tags)
        .filter(|s| !s.is_empty())
        .or_else(|| find_html_tag_inner(raw, &lower, "title").map(strip_html_tags).filter(|s| !s.is_empty()))
        .map(|s| truncate_chars(&s, 80));

    let subtitle = find_html_tag_inner(raw, &lower, "h2")
        .map(strip_html_tags)
        .filter(|s| !s.is_empty() && Some(s.as_str()) != heading.as_deref())
        .or_else(|| {
            find_html_tag_inner(raw, &lower, "p")
                .map(strip_html_tags)
                .filter(|s| !s.is_empty() && Some(s.as_str()) != heading.as_deref())
        })
        .map(|s| truncate_chars(&s, 120));

    ArtifactPreview::Prototype { heading, subtitle }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use vibevalley_protocol::{ArtifactPreview, ArtifactType};

    use super::*;
    use crate::artifact::starter_directory;

    fn files_from_starter(ty: ArtifactType, title: &str) -> BTreeMap<String, Vec<u8>> {
        starter_directory("art_test", ty, title)
            .files
            .into_iter()
            .map(|f| (f.path, f.content.into_bytes()))
            .collect()
    }

    #[test]
    fn extracts_preview_for_every_starter_type() {
        for ty in ArtifactType::ALL {
            let files = files_from_starter(ty, "Launch Plan");
            let preview = extract_artifact_preview(ty, &files);
            match (ty, &preview) {
                (ArtifactType::Docs, ArtifactPreview::Docs { heading, .. }) => assert_eq!(heading.as_deref(), Some("Launch Plan")),
                (ArtifactType::Outline, ArtifactPreview::Outline { items, .. }) => assert_eq!(items.len(), 1),
                (ArtifactType::DesignSystem, ArtifactPreview::DesignSystem { swatches, fonts }) => {
                    assert_eq!(swatches.len(), 3);
                    assert_eq!(fonts.len(), 2);
                }
                (ArtifactType::Dashboard, ArtifactPreview::Dashboard { kpis, .. }) => {
                    assert_eq!(kpis.len(), 1);
                    assert_eq!(kpis[0].value, "100");
                }
                (ArtifactType::Sheet, ArtifactPreview::Sheet { columns, total_cols, .. }) => {
                    assert_eq!(columns, &vec!["Item".to_string(), "Value".to_string()]);
                    assert_eq!(*total_cols, 2);
                }
                (ArtifactType::Slides, ArtifactPreview::Slides { first_title, slide_count, .. }) => {
                    assert_eq!(first_title.as_deref(), Some("Launch Plan"));
                    assert_eq!(*slide_count, 1);
                }
                (ArtifactType::Whiteboard, ArtifactPreview::Whiteboard { shapes, node_count }) => {
                    assert_eq!(*node_count, 1);
                    assert_eq!(shapes.len(), 1);
                }
                (ArtifactType::Diagram, ArtifactPreview::Diagram { kind, nodes, node_count, .. }) => {
                    assert_eq!(kind.as_deref(), Some("architecture"));
                    assert_eq!(*node_count, 1);
                    assert_eq!(nodes, &vec!["Launch Plan".to_string()]);
                }
                (ArtifactType::Design, ArtifactPreview::Design { artboard, width, height, .. }) => {
                    assert_eq!(artboard.as_deref(), Some("Launch Plan"));
                    assert_eq!((*width, *height), (Some(1280), Some(800)));
                }
                (ArtifactType::Storyboard, ArtifactPreview::Storyboard { shot_count, first_shot, .. }) => {
                    assert_eq!(*shot_count, 1);
                    assert_eq!(first_shot.as_deref(), Some("Opening"));
                }
                (ArtifactType::Motion, ArtifactPreview::Motion { scene_count, duration_sec, .. }) => {
                    assert_eq!(*scene_count, 1);
                    assert_eq!(*duration_sec, Some(JsNumber(6.0)));
                }
                (ArtifactType::Prototype, ArtifactPreview::Prototype { heading, .. }) => {
                    assert_eq!(heading.as_deref(), Some("Launch Plan"));
                }
                other => panic!("unexpected variant for {ty:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn docs_strips_markdown_frontmatter_and_fences() {
        let mut files = BTreeMap::new();
        files.insert(
            "structure/index.md".into(),
            "---\ntitle: ignored\n---\n# Architecture **Overview**\n\n- Build [clean](https://example.com) `modules`.\n- Keep *latency* low.\n```rust\nfn hidden() {}\n```\n> Final takeaway line.\n"
                .as_bytes()
                .to_vec(),
        );
        let preview = extract_artifact_preview(ArtifactType::Docs, &files);
        let ArtifactPreview::Docs { heading, excerpt } = preview else {
            panic!("expected Docs preview");
        };
        assert_eq!(heading.as_deref(), Some("Architecture Overview"));
        assert!(excerpt.contains("Build clean modules."));
        assert!(excerpt.contains("Keep latency low."));
        assert!(excerpt.contains("Final takeaway line."));
        assert!(!excerpt.contains("fn hidden"));
    }

    #[test]
    fn outline_counts_todos_and_preserves_depth() {
        let mut files = BTreeMap::new();
        files.insert(
            "structure/outline.json".into(),
            r#"{
              "version": 1,
              "rootIds": ["r1"],
              "nodes": {
                "r1": { "id": "r1", "text": "Q4 Goals", "kind": "heading", "children": ["t1", "t2"] },
                "t1": { "id": "t1", "text": "Ship cards", "kind": "todo", "checked": true, "children": [] },
                "t2": { "id": "t2", "text": "Verify covers", "kind": "todo", "checked": false, "children": [] }
              }
            }"#
            .as_bytes()
            .to_vec(),
        );
        let ArtifactPreview::Outline { items, todo_done, todo_total } = extract_artifact_preview(ArtifactType::Outline, &files) else {
            panic!("expected Outline");
        };
        assert_eq!((todo_done, todo_total), (1, 2));
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].depth, 0);
        assert_eq!(items[1].depth, 1);
        assert_eq!(items[1].checked, Some(true));
        assert_eq!(items[2].checked, Some(false));
    }

    #[test]
    fn dashboard_computes_kpis_and_normalized_series() {
        let mut files = BTreeMap::new();
        files.insert(
            "structure/dashboard.json".into(),
            r#"{
              "title": "Revenue",
              "panels": [
                { "id": "p1", "kind": "kpi", "label": "ARR", "format": "currency", "source": { "dataset": "structure/data/rev.json", "field": "mrr", "agg": "sum" } },
                { "id": "p2", "kind": "kpi", "label": "Conversion", "format": "percent", "source": { "dataset": "structure/data/rev.json", "field": "rate", "agg": "avg" } }
              ]
            }"#
            .as_bytes()
            .to_vec(),
        );
        files.insert(
            "structure/data/rev.json".into(),
            r#"{
              "schema": [
                { "name": "month", "type": "string" },
                { "name": "mrr", "type": "number" },
                { "name": "rate", "type": "number" }
              ],
              "rows": [
                { "month": "Jan", "mrr": 1000, "rate": 4.2 },
                { "month": "Feb", "mrr": 2000, "rate": 5.8 }
              ]
            }"#
            .as_bytes()
            .to_vec(),
        );
        let ArtifactPreview::Dashboard { kpis, series } = extract_artifact_preview(ArtifactType::Dashboard, &files) else {
            panic!("expected Dashboard");
        };
        assert_eq!(kpis.len(), 2);
        assert_eq!(kpis[0].value, "$3,000");
        assert_eq!(kpis[1].value, "5%");
        assert_eq!(series, vec![JsNumber(0.5), JsNumber(1.0)]);
    }

    #[test]
    fn whiteboard_normalizes_bounding_boxes_and_skips_arrows() {
        let mut files = BTreeMap::new();
        files.insert(
            "structure/board.json".into(),
            r#"{
              "version": 1,
              "elements": {
                "a": { "id": "a", "type": "shape", "shape": "card", "x": 100, "y": 100, "w": 200, "h": 100, "title": "Start" },
                "b": { "id": "b", "type": "shape", "shape": "sticky", "x": 500, "y": 300, "w": 200, "h": 100, "title": "End" },
                "e": { "id": "e", "type": "arrow", "from": { "id": "a" }, "to": { "id": "b" } }
              }
            }"#
            .as_bytes()
            .to_vec(),
        );
        let ArtifactPreview::Whiteboard { shapes, node_count } = extract_artifact_preview(ArtifactType::Whiteboard, &files) else {
            panic!("expected Whiteboard");
        };
        assert_eq!(node_count, 2);
        assert_eq!(shapes.len(), 2);
        for s in &shapes {
            assert!(s.x.0 >= 0.0 && s.x.0 <= 1.0);
            assert!(s.y.0 >= 0.0 && s.y.0 <= 1.0);
            assert!(s.w.0 > 0.0 && s.x.0 + s.w.0 <= 1.001);
            assert!(s.h.0 > 0.0 && s.y.0 + s.h.0 <= 1.001);
        }
        assert_eq!(shapes[0].kind, "card");
        assert_eq!(shapes[1].kind, "sticky");
    }

    #[test]
    fn storyboard_resolves_frame_asset_safely() {
        let mut files = BTreeMap::new();
        files.insert(
            "structure/shots.json".into(),
            r#"{
              "title": "Demo",
              "shots": [
                { "id": "sh01", "scene": "Intro", "durationSec": 4.5, "visual": "Desk closeup", "frameAsset": "asset/frames/sh01.png" },
                { "id": "sh02", "scene": "End", "durationSec": 2.5, "visual": "Logo" }
              ]
            }"#
            .as_bytes()
            .to_vec(),
        );
        files.insert("asset/frames/sh01.png".into(), vec![0x89, b'P', b'N', b'G']);
        let ArtifactPreview::Storyboard {
            shot_count,
            first_shot,
            duration_sec,
            frame_asset,
            ..
        } = extract_artifact_preview(ArtifactType::Storyboard, &files)
        else {
            panic!("expected Storyboard");
        };
        assert_eq!(shot_count, 2);
        assert_eq!(first_shot.as_deref(), Some("Desk closeup"));
        assert_eq!(duration_sec, Some(JsNumber(7.0)));
        assert_eq!(frame_asset.as_deref(), Some("asset/frames/sh01.png"));
    }

    #[test]
    fn prototype_extracts_cjk_heading_and_subtitle() {
        let mut files = BTreeMap::new();
        files.insert(
            "structure/index.html".into(),
            "<!doctype html><html><head><title>备选标题</title></head><body><h1>农场工作台 &amp; 看板</h1><p>实时查看任务进度</p></body></html>"
                .as_bytes()
                .to_vec(),
        );
        let ArtifactPreview::Prototype { heading, subtitle } = extract_artifact_preview(ArtifactType::Prototype, &files) else {
            panic!("expected Prototype");
        };
        assert_eq!(heading.as_deref(), Some("农场工作台 & 看板"));
        assert_eq!(subtitle.as_deref(), Some("实时查看任务进度"));
    }
}
