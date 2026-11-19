//! Structured artifact entry store helpers (`store.ts`): path validation,
//! kind/mime inference, canonical JSON, RFC 7396 JSON merge patch, and summary
//! formatting.

use std::collections::BTreeSet;

use serde_json::Value;
pub use vibevalley_protocol::{ArtifactEntry, ArtifactEntryKind, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactType};

pub const ENTRY_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const ENTRY_MAX_COUNT: usize = 500;
pub const INLINE_EVENT_MAX_BYTES: usize = 256 * 1024;

const ENTRY_PATH_MAX: usize = 240;

fn has_control_char(s: &str) -> bool {
    s.chars().any(|c| {
        let code = c as u32;
        code <= 0x1f || code == 0x7f
    })
}

/// `entryPathProblem`: `None` when valid.
pub fn entry_path_problem(path: &str) -> Option<String> {
    if path.is_empty() {
        return Some("empty path".to_string());
    }
    if path.encode_utf16().count() > ENTRY_PATH_MAX {
        return Some(format!("exceeds {ENTRY_PATH_MAX} characters"));
    }
    if has_control_char(path) {
        return Some("contains control characters".to_string());
    }
    if path.contains('\\') {
        return Some("use forward slashes (/)".to_string());
    }
    if path.starts_with('/') || path.ends_with('/') {
        return Some("must be relative without leading or trailing /".to_string());
    }
    for part in path.split('/') {
        if part.is_empty() {
            return Some("contains empty path segment (//)".to_string());
        }
        if part == "." || part == ".." {
            return Some("dot path segments are not allowed".to_string());
        }
    }
    None
}

fn ext_of(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or("");
    match base.rfind('.') {
        Some(dot) => base[dot..].to_ascii_lowercase(),
        None => String::new(),
    }
}

fn asset_mime(ext: &str) -> Option<&'static str> {
    match ext {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        ".avif" => Some("image/avif"),
        ".ico" => Some("image/x-icon"),
        ".woff2" => Some("font/woff2"),
        ".woff" => Some("font/woff"),
        ".ttf" => Some("font/ttf"),
        ".otf" => Some("font/otf"),
        ".mp3" => Some("audio/mpeg"),
        ".wav" => Some("audio/wav"),
        ".ogg" => Some("audio/ogg"),
        ".mp4" => Some("video/mp4"),
        ".webm" => Some("video/webm"),
        _ => None,
    }
}

fn text_mime(ext: &str) -> Option<&'static str> {
    match ext {
        ".html" => Some("text/html"),
        ".css" => Some("text/css"),
        ".js" | ".mjs" => Some("text/javascript"),
        ".md" => Some("text/markdown"),
        ".svg" => Some("image/svg+xml"),
        ".csv" => Some("text/csv"),
        ".txt" => Some("text/plain"),
        ".json" => Some("application/json"),
        _ => None,
    }
}

pub fn infer_entry_kind(path: &str) -> ArtifactEntryKind {
    let ext = ext_of(path);
    if ext == ".json" {
        return ArtifactEntryKind::Json;
    }
    if asset_mime(&ext).is_some() {
        return ArtifactEntryKind::Asset;
    }
    if path.starts_with("datasets/") || path.starts_with("elements/") || path.starts_with("board/") || path.starts_with("dash/") || path == "film/meta" {
        return ArtifactEntryKind::Json;
    }
    ArtifactEntryKind::Text
}

pub fn infer_entry_mime(path: &str, kind: ArtifactEntryKind) -> &'static str {
    if kind == ArtifactEntryKind::Json {
        return "application/json";
    }
    let ext = ext_of(path);
    if kind == ArtifactEntryKind::Asset {
        return asset_mime(&ext).unwrap_or("application/octet-stream");
    }
    if path == "film/script" {
        return "text/javascript";
    }
    text_mime(&ext).unwrap_or("text/plain")
}

/// RFC 7396 JSON Merge Patch.
fn json_merge_patch(target: Value, patch: Value) -> Value {
    let Value::Object(patch_map) = patch else {
        return patch;
    };
    let mut base = match target {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    for (key, patch_val) in patch_map {
        if patch_val.is_null() {
            base.remove(&key);
        } else {
            let prev = base.remove(&key).unwrap_or(Value::Null);
            base.insert(key, json_merge_patch(prev, patch_val));
        }
    }
    Value::Object(base)
}

pub fn canonical_json(raw: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    serde_json::to_string(&parsed).map_err(|e| e.to_string())
}

pub fn apply_json_merge_patch(current_raw: Option<&str>, patch_raw: &str) -> Result<String, String> {
    let target = match current_raw {
        Some(raw) if !raw.is_empty() => serde_json::from_str::<Value>(raw).map_err(|e| e.to_string())?,
        _ => Value::Object(serde_json::Map::new()),
    };
    let patch: Value = serde_json::from_str(patch_raw).map_err(|e| e.to_string())?;
    let merged = json_merge_patch(target, patch);
    serde_json::to_string(&merged).map_err(|e| e.to_string())
}

pub fn format_store_summary(title: &str, artifact_type: Option<ArtifactType>, seq: i64, entries: &[ArtifactEntry]) -> String {
    let kind_label = artifact_type.map_or("store", ArtifactType::as_str);
    let header = format!("# {title}\n\ntype: {kind_label} · seq: {seq} · entries: {}", entries.len());
    if entries.is_empty() {
        return format!("{header}\n\n(empty store)");
    }
    let lines: Vec<String> = entries
        .iter()
        .map(|e| format!("- `{}` ({}, rev {}, {} B)", e.path, e.kind.as_str(), e.rev, e.size))
        .collect();
    let meta_paths: BTreeSet<&str> = [
        "project/deck.json",
        "project/canvas.json",
        "project/design-system.json",
        "board/meta",
        "film/meta",
        "dash/params",
        "project/README.md",
    ]
    .into_iter()
    .collect();
    let snippets: Vec<String> = entries
        .iter()
        .filter_map(|e| {
            let val = e.value.as_deref()?;
            if (meta_paths.contains(e.path.as_str()) || e.path.starts_with("datasets/")) && val.encode_utf16().count() <= 4000 {
                let lang = if e.kind == ArtifactEntryKind::Json { "json" } else { "markdown" };
                Some(format!("\n## {}\n\n```{lang}\n{val}\n```", e.path))
            } else {
                None
            }
        })
        .take(6)
        .collect();
    format!("{header}\n\n## Entries\n\n{}{}", lines.join("\n"), snippets.join(""))
}
