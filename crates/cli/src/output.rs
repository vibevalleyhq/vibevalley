//! Output formatting, text/JSON input loading, and URL/time helpers.

use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::client::{Failure, exit};

/// Controls whether stdout prints raw protocol JSON or compact human lines.
#[derive(Debug, Clone, Copy)]
pub struct Output {
    pub json: bool,
}

impl Output {
    pub fn show<T: Serialize>(&self, value: &T, format: impl FnOnce(&T) -> String) {
        if self.json {
            out(&serde_json::to_string(value).unwrap_or_else(|_| "null".into()));
        } else {
            let text = format(value);
            if !text.is_empty() {
                out(&text);
            }
        }
    }
}

/// Writes one line directly to stdout.
pub fn out(text: &str) {
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{text}");
}

/// Collapses all whitespace runs into single spaces.
pub fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Joins non-empty columns with two spaces.
pub fn line(parts: &[&str]) -> String {
    parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("  ")
}

/// Normalizes `#12` or `12` to the server's issue reference string.
pub fn issue_ref(raw: &str) -> String {
    raw.trim_start_matches('#').to_string()
}

/// Percent-encodes one URL path segment.
pub fn url_segment(raw: &str) -> String {
    let mut encoded = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Reads all of stdin as UTF-8, returning an empty string on error.
pub fn stdin_text() -> String {
    let mut buf = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf);
    buf
}

/// Loads inline text, stdin (`-`), or a UTF-8 file (`@path`).
pub fn read_text_input(raw: &str) -> Result<String, Failure> {
    if raw == "-" {
        return Ok(stdin_text());
    }
    if let Some(path) = raw.strip_prefix('@') {
        return std::fs::read_to_string(path).map_err(|e| Failure::new(exit::OTHER, "File", format!("failed to read {path}: {e}")));
    }
    Ok(raw.to_string())
}

/// Loads and deserializes JSON from inline text, stdin (`-`), or a file (`@path`).
pub fn read_json_input<T: DeserializeOwned>(raw: &str) -> Result<T, Failure> {
    let text = read_text_input(raw)?;
    serde_json::from_str(&text).map_err(|e| Failure::usage("InvalidValue", format!("invalid JSON: {e}")))
}

/// Formats epoch milliseconds as `YYYY-MM-DD HH:MM` in UTC.
pub fn minute_of(at: i64) -> String {
    jiff::Timestamp::from_millisecond(at)
        .map(|ts| ts.strftime("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Infers a MIME type from a file extension for upload convenience.
pub fn guess_mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("aac" | "m4a") => "audio/aac",
        Some("ogg" | "opus") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("html" | "htm") => "text/html",
        Some("md" | "markdown") => "text/markdown",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}
