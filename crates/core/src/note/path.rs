//! Safe relative path validation, MIME/encoding inference, and JSON merge helpers
//! for directory-backed notes (`<storage>/note/<id>/{manifest.json,structure/,asset/}`).

use serde_json::Value;
use vibevalley_protocol::NoteFileEncoding;

/// Canonical manifest filename at the root of a note directory.
pub const MANIFEST_FILE: &str = "manifest.json";
/// Subdirectory holding structured content files (Markdown, JSON, HTML, CSS, JS, Mermaid).
pub const STRUCTURE_DIR: &str = "structure";
/// Subdirectory holding media and binary/raw assets referenced via `asset/<name>`.
pub const ASSET_DIR: &str = "asset";

/// Maximum byte size for a single file inside `structure/`.
pub const STRUCTURE_FILE_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Maximum byte size for a single file inside `asset/`.
pub const ASSET_FILE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// Maximum file count within one note directory.
pub const FILE_MAX_COUNT: usize = 500;
/// Maximum UTF-16 code-unit length for a relative note path.
pub const PATH_MAX_LEN: usize = 240;

/// Logical zone inside `<storage>/note/<id>/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NotePathZone {
    Manifest,
    Structure,
    Asset,
}

impl NotePathZone {
    pub const fn as_str(self) -> &'static str {
        match self {
            NotePathZone::Manifest => "manifest",
            NotePathZone::Structure => "structure",
            NotePathZone::Asset => "asset",
        }
    }

    pub const fn max_bytes(self) -> usize {
        match self {
            NotePathZone::Manifest | NotePathZone::Structure => STRUCTURE_FILE_MAX_BYTES,
            NotePathZone::Asset => ASSET_FILE_MAX_BYTES,
        }
    }
}

fn has_control_char(s: &str) -> bool {
    s.chars().any(|c| {
        let code = c as u32;
        code <= 0x1f || code == 0x7f
    })
}

fn has_windows_drive(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn validate_relative_segments(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".to_owned());
    }
    if path.encode_utf16().count() > PATH_MAX_LEN {
        return Err(format!("path exceeds {PATH_MAX_LEN} characters"));
    }
    if has_control_char(path) {
        return Err("path contains control characters".to_owned());
    }
    if path.contains('\\') {
        return Err("use forward slashes (/)".to_owned());
    }
    if has_windows_drive(path) || path.starts_with('/') || path.ends_with('/') {
        return Err("path must be relative without leading or trailing /".to_owned());
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return Err("path contains empty segment (//)".to_owned());
        }
        if segment == "." || segment == ".." {
            return Err("dot path segments (. or ..) are not allowed".to_owned());
        }
    }
    Ok(())
}

/// Validates a relative file path inside `<storage>/note/<id>/`.
///
/// Only `manifest.json`, `structure/<rel>`, and `asset/<rel>` are permitted.
pub fn validate_note_path(path: &str) -> Result<NotePathZone, String> {
    validate_relative_segments(path)?;
    if path == MANIFEST_FILE {
        return Ok(NotePathZone::Manifest);
    }
    if let Some(rest) = path.strip_prefix("structure/")
        && !rest.is_empty()
    {
        return Ok(NotePathZone::Structure);
    }
    if let Some(rest) = path.strip_prefix("asset/")
        && !rest.is_empty()
    {
        return Ok(NotePathZone::Asset);
    }
    Err("path must be manifest.json or under structure/ or asset/".to_owned())
}

/// Validates a relative path that may be deleted (`structure/*` or `asset/*`; never `manifest.json`).
pub fn validate_deletable_path(path: &str) -> Result<NotePathZone, String> {
    let zone = validate_note_path(path)?;
    if zone == NotePathZone::Manifest {
        return Err("manifest.json cannot be deleted".to_owned());
    }
    Ok(zone)
}

/// Validates an optional directory prefix filter passed to `note.file.list`.
pub fn validate_prefix(prefix: &str) -> Result<(), String> {
    if prefix.is_empty() {
        return Ok(());
    }
    let trimmed = prefix.strip_suffix('/').unwrap_or(prefix);
    validate_relative_segments(trimmed)?;
    let top = trimmed.split('/').next().unwrap_or("");
    if matches!(top, MANIFEST_FILE | STRUCTURE_DIR | ASSET_DIR) {
        Ok(())
    } else {
        Err("prefix must start with manifest.json, structure/, or asset/".to_owned())
    }
}

fn ext_of(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    match base.rfind('.') {
        Some(dot) => base[dot..].to_ascii_lowercase(),
        None => String::new(),
    }
}

/// Infers a canonical MIME type from a file path extension.
pub fn infer_mime(path: &str) -> &'static str {
    match ext_of(path).as_str() {
        ".json" => "application/json",
        ".md" | ".markdown" => "text/markdown",
        ".mmd" => "text/vnd.mermaid",
        ".html" | ".htm" => "text/html",
        ".css" => "text/css",
        ".js" | ".mjs" => "text/javascript",
        ".svg" => "image/svg+xml",
        ".csv" => "text/csv",
        ".txt" | ".log" => "text/plain",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".avif" => "image/avif",
        ".heic" => "image/heic",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        ".woff" => "font/woff",
        ".ttf" => "font/ttf",
        ".otf" => "font/otf",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".flac" => "audio/flac",
        ".aac" => "audio/aac",
        ".wav" => "audio/wav",
        ".ogg" | ".opus" => "audio/ogg",
        ".mp4" | ".m4v" => "video/mp4",
        ".mov" => "video/quicktime",
        ".webm" => "video/webm",
        ".pdf" => "application/pdf",
        ".zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Returns true when `mime` is safe to read and write as UTF-8 text.
pub fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/") || matches!(mime, "application/json" | "image/svg+xml")
}

/// Infers whether a file should be transported as UTF-8 text or base64 bytes.
pub fn infer_encoding(path: &str) -> NoteFileEncoding {
    if is_text_mime(infer_mime(path)) {
        NoteFileEncoding::Utf8
    } else {
        NoteFileEncoding::Base64
    }
}

/// Parses and re-serializes JSON into compact canonical text.
pub fn canonical_json(raw: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    serde_json::to_string(&parsed).map_err(|e| e.to_string())
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

/// Applies an RFC 7396 JSON Merge Patch to an optional existing JSON string.
pub fn apply_json_merge_patch(current_raw: Option<&str>, patch_raw: &str) -> Result<String, String> {
    let target = match current_raw {
        Some(raw) if !raw.is_empty() => serde_json::from_str::<Value>(raw).map_err(|e| e.to_string())?,
        _ => Value::Object(serde_json::Map::new()),
    };
    let patch: Value = serde_json::from_str(patch_raw).map_err(|e| e.to_string())?;
    let merged = json_merge_patch(target, patch);
    serde_json::to_string(&merged).map_err(|e| e.to_string())
}
