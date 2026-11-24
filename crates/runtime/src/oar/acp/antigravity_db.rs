//! Read-only SQLite sidecar inspection for `agy >= 1.5.0` conversation DBs.
//!
//! `agy` frequently completes turns with `stopReason: "end_turn"` while writing
//! upstream 429 / 5xx / `QUOTA_EXHAUSTED` / `INVALID_THINKING_SIGNATURE`
//! failures only into `conversations/<sessionId>.db` as `step_type = 17`
//! (`CORTEX_STEP_TYPE_ERROR_MESSAGE`). This module opens that DB read-only
//! with symlink and inode verification and fails closed (`None`) on any schema,
//! lock, or I/O discrepancy.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use regex::Regex;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Row, SqliteConnection};

use crate::rt::block_on;

pub(crate) const STEP_TYPE_ERROR_MESSAGE: i64 = 17;
pub(crate) const STEP_TYPE_INVOKE_SUBAGENT: i64 = 127;
pub(crate) const MAX_CHILDREN: usize = 16;
const MAX_CACHED_CONNS: usize = 16;
const PAYLOAD_SCAN_LIMIT: usize = 16 * 1024;
const SUBAGENT_PAYLOAD_LIMIT: usize = 32 * 1024;
const SUBAGENT_TEXT_CAP: usize = 4_000;
const BUSY_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SilentError {
    pub message: String,
    pub status_code: Option<u16>,
    pub quota_exhausted: bool,
    pub retry_hint: Option<String>,
    pub invalid_thinking_signature: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InvokedSubagent {
    pub step_idx: i64,
    pub status: i64,
    pub role: Option<String>,
    pub prompt: Option<String>,
    pub conversation_id: Option<String>,
    pub log_uri: Option<String>,
}

pub(crate) fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty() && segment != "." && !segment.contains('/') && !segment.contains('\\') && !segment.contains('\0') && !segment.contains("..")
}

pub(crate) fn base_data_dir(gemini_dir: &Path, app_data_dir: &str) -> Option<PathBuf> {
    if app_data_dir.is_empty() || app_data_dir.contains('\0') {
        return None;
    }
    let app_path = Path::new(app_data_dir);
    if app_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    Some(if app_path.is_absolute() {
        app_path.to_path_buf()
    } else {
        gemini_dir.join(app_path)
    })
}

/// Walks every path segment under `base`, verifying each segment is traversal-safe
/// and is a real non-symlink filesystem entry via `symlink_metadata`.
pub(crate) fn check_non_symlink_chain(base: &Path, segments: &[&str], expect_file: bool) -> Option<PathBuf> {
    let mut current = base.to_path_buf();
    for (idx, seg) in segments.iter().enumerate() {
        if !is_safe_segment(seg) {
            return None;
        }
        current.push(seg);
        let meta = std::fs::symlink_metadata(&current).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        let is_last = idx + 1 == segments.len();
        if is_last && expect_file {
            if !meta.is_file() {
                return None;
            }
        } else if !meta.is_dir() {
            return None;
        }
    }
    Some(current)
}

/// Resolves `<gemini_dir>/<app_data_dir>/conversations/<session_id>.db`,
/// rejecting path traversal or control characters in `session_id` / `app_data_dir`.
pub(crate) fn conversation_db_path(session_id: &str, gemini_dir: &Path, app_data_dir: &str) -> Option<PathBuf> {
    if !is_safe_segment(session_id) {
        return None;
    }
    let base = base_data_dir(gemini_dir, app_data_dir)?;
    Some(base.join("conversations").join(format!("{session_id}.db")))
}

/// Returns `(dev, ino)` only when the DB file and its `conversations` parent
/// are real non-symlink filesystem entries.
fn safe_db_identity(path: &Path) -> Option<(u64, u64)> {
    let parent = path.parent()?;
    let parent_meta = std::fs::symlink_metadata(parent).ok()?;
    if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
        return None;
    }
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    Some((meta.dev(), meta.ino()))
}

struct CachedConn {
    identity: (u64, u64),
    conn: SqliteConnection,
    last_used: u64,
}

#[derive(Default)]
struct ConnCache {
    entries: HashMap<PathBuf, CachedConn>,
    clock: u64,
}

impl ConnCache {
    fn take(&mut self, path: &Path, identity: (u64, u64)) -> Option<SqliteConnection> {
        let entry = self.entries.remove(path)?;
        (entry.identity == identity).then_some(entry.conn)
    }

    fn put(&mut self, path: PathBuf, identity: (u64, u64), conn: SqliteConnection) {
        self.clock = self.clock.wrapping_add(1);
        let stamp = self.clock;
        if !self.entries.contains_key(&path)
            && self.entries.len() >= MAX_CACHED_CONNS
            && let Some(oldest_key) = self.entries.iter().min_by_key(|(_, v)| v.last_used).map(|(k, _)| k.clone())
        {
            self.entries.remove(&oldest_key);
        }
        self.entries.insert(
            path,
            CachedConn {
                identity,
                conn,
                last_used: stamp,
            },
        );
    }
}

fn conn_cache() -> &'static Mutex<ConnCache> {
    static CACHE: OnceLock<Mutex<ConnCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ConnCache::default()))
}

#[cfg(test)]
fn readonly_open_counts() -> &'static Mutex<HashMap<PathBuf, usize>> {
    static COUNTS: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    COUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn readonly_open_count(path: &Path) -> usize {
    readonly_open_counts().lock().get(path).copied().unwrap_or(0)
}

fn open_readonly(path: &Path) -> Option<(SqliteConnection, (u64, u64))> {
    let before = safe_db_identity(path)?;
    #[cfg(test)]
    {
        *readonly_open_counts().lock().entry(path.to_path_buf()).or_insert(0) += 1;
    }
    let options = SqliteConnectOptions::new().filename(path).read_only(true).busy_timeout(BUSY_TIMEOUT);
    let conn = block_on(options.connect()).ok()?;
    let after = safe_db_identity(path)?;
    if before != after {
        return None;
    }
    Some((conn, before))
}

fn with_readonly_conn<T>(path: &Path, mut query: impl FnMut(&mut SqliteConnection) -> Result<T, sqlx::Error>) -> Option<T> {
    let identity = safe_db_identity(path)?;
    let (mut conn, identity, from_cache) = match conn_cache().lock().take(path, identity) {
        Some(conn) => (conn, identity, true),
        None => {
            let (conn, opened_id) = open_readonly(path)?;
            (conn, opened_id, false)
        }
    };

    match query(&mut conn) {
        Ok(value) => {
            if safe_db_identity(path) != Some(identity) {
                return None;
            }
            conn_cache().lock().put(path.to_path_buf(), identity, conn);
            Some(value)
        }
        Err(_) => {
            drop(conn);
            if !from_cache {
                return None;
            }
            let (mut fresh, fresh_id) = open_readonly(path)?;
            let value = query(&mut fresh).ok()?;
            if safe_db_identity(path) != Some(fresh_id) {
                return None;
            }
            conn_cache().lock().put(path.to_path_buf(), fresh_id, fresh);
            Some(value)
        }
    }
}

pub(crate) fn latest_step_index(path: &Path) -> Option<i64> {
    with_readonly_conn(path, |conn| {
        block_on(sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(idx), -1) FROM steps").fetch_one(conn))
    })
}

fn read_blob_or_text(row: &sqlx::sqlite::SqliteRow, column: &str) -> Option<Vec<u8>> {
    if let Ok(Some(bytes)) = row.try_get::<Option<Vec<u8>>, _>(column) {
        return Some(bytes);
    }
    if let Ok(Some(text)) = row.try_get::<Option<String>, _>(column) {
        return Some(text.into_bytes());
    }
    None
}

pub(crate) fn detect_silent_error(path: &Path, after_idx: i64) -> Option<SilentError> {
    let row = with_readonly_conn(path, |conn| {
        block_on(
            sqlx::query("SELECT step_type, step_payload, error_details FROM steps WHERE idx > ?1 ORDER BY idx DESC LIMIT 1")
                .bind(after_idx)
                .fetch_optional(conn),
        )
    })??;
    let step_type: i64 = row.try_get("step_type").ok()?;
    if step_type != STEP_TYPE_ERROR_MESSAGE {
        return None;
    }
    let mut combined = Vec::new();
    for col in ["error_details", "step_payload"] {
        if combined.len() >= PAYLOAD_SCAN_LIMIT {
            break;
        }
        if let Some(bytes) = read_blob_or_text(&row, col) {
            let take = (PAYLOAD_SCAN_LIMIT - combined.len()).min(bytes.len());
            if !combined.is_empty() && take > 0 {
                combined.push(b'\n');
            }
            combined.extend_from_slice(&bytes[..take]);
        }
    }
    Some(parse_error_payload(&combined))
}

fn sanitize_payload(bytes: &[u8]) -> String {
    let slice = &bytes[..bytes.len().min(PAYLOAD_SCAN_LIMIT)];
    let raw = String::from_utf8_lossy(slice);
    let mut out = String::with_capacity(raw.len());
    let mut last_space = false;
    for ch in raw.chars() {
        if ch == '\n' || ch == '\r' {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            last_space = false;
        } else if ch == '\t' || ch == ' ' || ch.is_control() || ch == '\u{FFFD}' {
            if !last_space && !out.ends_with('\n') {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out
}

fn regex_error_tuple() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Error\s+(\d{3})\s*,\s*Message:\s*([^\n]+?)(?:,\s*Status:\s*([A-Z0-9_]+))?(?:\n|$)").expect("valid regex"))
}

fn regex_status_code() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"STATUS\s*\(\s*code\s+(\d{3})\s*\)\s*:\s*([^\n]+)").expect("valid regex"))
}

fn regex_retry_hint() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?:quotaResetTimeStamp|quotaResetDelay|retryDelay)["':=\s]+([0-9A-Za-z:\-\.+]+)"#).expect("valid regex"))
}

pub(crate) fn parse_error_payload(bytes: &[u8]) -> SilentError {
    let text = sanitize_payload(bytes);
    let mut status_code: Option<u16> = None;
    let mut extracted_msg: Option<String> = None;
    let mut extracted_status: Option<String> = None;

    if let Some(caps) = regex_error_tuple().captures(&text) {
        status_code = caps.get(1).and_then(|m| m.as_str().parse::<u16>().ok());
        extracted_msg = caps.get(2).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty());
        extracted_status = caps.get(3).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty());
    } else if let Some(caps) = regex_status_code().captures(&text) {
        status_code = caps.get(1).and_then(|m| m.as_str().parse::<u16>().ok());
        extracted_msg = caps.get(2).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty());
    }

    let quota_exhausted = text.contains("QUOTA_EXHAUSTED") || text.contains("reason:QUOTA_EXHAUSTED");
    let invalid_thinking_signature = text.contains("INVALID_THINKING_SIGNATURE") || text.to_ascii_lowercase().contains("invalid thinking signature");
    let retry_hint = regex_retry_hint()
        .captures(&text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty());

    let mut message = extracted_msg.unwrap_or_else(|| {
        if invalid_thinking_signature {
            "INVALID_THINKING_SIGNATURE: upstream rejected thinking signature".to_string()
        } else if quota_exhausted {
            "QUOTA_EXHAUSTED: model quota exhausted".to_string()
        } else {
            text.lines()
                .map(str::trim)
                .find(|line| line.len() >= 8)
                .map(|line| line.chars().take(240).collect::<String>())
                .unwrap_or_else(|| "Antigravity reported an upstream error".to_string())
        }
    });

    if let Some(code) = status_code
        && !message.contains(&code.to_string())
    {
        message = format!("HTTP {code}: {message}");
    }
    if let Some(status) = extracted_status
        && !message.contains(&status)
    {
        message.push_str(&format!(" ({status})"));
    }
    if quota_exhausted && !message.contains("QUOTA_EXHAUSTED") {
        message.push_str(" [QUOTA_EXHAUSTED]");
    }
    if invalid_thinking_signature && !message.contains("INVALID_THINKING_SIGNATURE") {
        message.push_str(" [INVALID_THINKING_SIGNATURE]");
    }
    if let Some(hint) = &retry_hint
        && !message.contains(hint)
    {
        message.push_str(&format!(" (retry: {hint})"));
    }

    SilentError {
        message,
        status_code,
        quota_exhausted,
        retry_hint,
        invalid_thinking_signature,
    }
}

// ---- `step_type = 127` (`INVOKE_SUBAGENT`) sidecar inspection ---------------

fn decode_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut out = 0u64;
    let mut shift = 0u32;
    while *pos < data.len() && shift < 64 {
        let byte = data[*pos];
        *pos += 1;
        out |= u64::from(byte & 0x7f) << shift;
        if (byte & 0x80) == 0 {
            return Some(out);
        }
        shift += 7;
    }
    None
}

fn parse_wire_fields(data: &[u8]) -> Option<Vec<(u32, &[u8])>> {
    let mut pos = 0usize;
    let mut len_fields = Vec::new();
    while pos < data.len() {
        let tag = decode_varint(data, &mut pos)?;
        let field_number = u32::try_from(tag >> 3).ok()?;
        let wire_type = (tag & 0x07) as u8;
        if field_number == 0 {
            return None;
        }
        match wire_type {
            0 => {
                decode_varint(data, &mut pos)?;
            }
            1 => {
                if pos.checked_add(8)? > data.len() {
                    return None;
                }
                pos += 8;
            }
            2 => {
                let len = usize::try_from(decode_varint(data, &mut pos)?).ok()?;
                let end = pos.checked_add(len)?;
                if end > data.len() {
                    return None;
                }
                len_fields.push((field_number, &data[pos..end]));
                pos = end;
            }
            5 => {
                if pos.checked_add(4)? > data.len() {
                    return None;
                }
                pos += 4;
            }
            _ => return None,
        }
    }
    Some(len_fields)
}

fn is_printable_utf8(bytes: &[u8]) -> Option<&str> {
    if bytes.is_empty() {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    if text.chars().all(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t')) {
        Some(text)
    } else {
        None
    }
}

fn collect_proto_strings(data: &[u8], depth: usize, out: &mut Vec<(u32, String)>, nodes: &mut usize) -> bool {
    if depth > 4 || *nodes >= 256 {
        return false;
    }
    let Some(fields) = parse_wire_fields(data) else {
        return false;
    };
    let start_len = out.len();
    for (field_number, slice) in fields {
        if *nodes >= 256 {
            break;
        }
        *nodes += 1;
        if slice.is_empty() {
            continue;
        }
        // Nested protobuf submessages often begin with tag 0x0a (`\n`) or contain
        // non-printable length varints; recurse before treating bytes as plain text.
        if depth < 4 && (slice[0] == 0x0a || is_printable_utf8(slice).is_none()) {
            let before = out.len();
            if collect_proto_strings(slice, depth + 1, out, nodes) && out.len() > before {
                continue;
            }
            out.truncate(before);
        }
        if let Some(text) = is_printable_utf8(slice) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                out.push((field_number, trimmed.to_string()));
            }
        }
    }
    out.len() > start_len
}

fn looks_like_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if matches!(i, 8 | 13 | 18 | 23) {
            if b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn looks_like_log_uri(s: &str) -> bool {
    s.contains("/.system_generated/logs/") || s.ends_with("/transcript.jsonl") || s.ends_with("transcript.jsonl")
}

fn conversation_id_from_log_uri(uri: &str) -> Option<String> {
    let cleaned = uri.strip_prefix("file://").unwrap_or(uri);
    let after_brain = cleaned.split("/brain/").nth(1)?;
    let id = after_brain.split('/').next()?;
    is_safe_segment(id).then(|| id.to_string())
}

fn clamp_chars(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() { format!("{head}…") } else { head }
}

pub(crate) fn parse_subagent_payload(step_idx: i64, status: i64, payload: &[u8]) -> Option<InvokedSubagent> {
    let slice = &payload[..payload.len().min(SUBAGENT_PAYLOAD_LIMIT)];
    if slice.is_empty() {
        return None;
    }
    // JSON fallback in case a payload is stored in JSON format.
    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(slice)
        && json.is_object()
    {
        let pick = |keys: &[&str]| -> Option<String> {
            keys.iter()
                .find_map(|k| json.get(*k).and_then(serde_json::Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let log_uri = pick(&["logUri", "log_uri", "transcriptPath", "transcript_path"]);
        let conversation_id = pick(&["conversationId", "conversation_id", "sessionId", "session_id"])
            .filter(|id| is_safe_segment(id))
            .or_else(|| log_uri.as_deref().and_then(conversation_id_from_log_uri));
        let role = pick(&["role", "agentType", "agent_type", "name", "subagentType"]);
        let prompt = pick(&["prompt", "task", "instructions", "description"]).map(|s| clamp_chars(&s, SUBAGENT_TEXT_CAP));
        if role.is_none() && prompt.is_none() && conversation_id.is_none() && log_uri.is_none() {
            return None;
        }
        return Some(InvokedSubagent {
            step_idx,
            status,
            role,
            prompt,
            conversation_id,
            log_uri,
        });
    }

    let mut strings = Vec::new();
    let mut nodes = 0usize;
    if !collect_proto_strings(slice, 0, &mut strings, &mut nodes) {
        return None;
    }

    let mut log_uri: Option<String> = None;
    let mut conversation_id: Option<String> = None;
    let mut candidates: Vec<(u32, String)> = Vec::new();

    for (field_no, text) in strings {
        if log_uri.is_none() && looks_like_log_uri(&text) {
            log_uri = Some(text);
        } else if conversation_id.is_none() && looks_like_uuid(&text) {
            conversation_id = Some(text);
        } else if !text.starts_with("file://") && !text.starts_with('/') {
            candidates.push((field_no, text));
        }
    }
    if conversation_id.is_none()
        && let Some(uri) = log_uri.as_deref()
    {
        conversation_id = conversation_id_from_log_uri(uri);
    }

    let mut role: Option<String> = None;
    let mut prompt: Option<String> = None;
    if candidates.len() >= 2 {
        // Prefer a short single-line identifier as role and the longest distinct text as prompt.
        let role_idx = candidates
            .iter()
            .enumerate()
            .filter(|(_, (_, s))| !s.contains('\n') && s.chars().count() <= 80)
            .min_by_key(|(_, (_, s))| s.chars().count())
            .map(|(i, _)| i);
        if let Some(idx) = role_idx {
            role = Some(candidates[idx].1.clone());
        }
        let prompt_idx = candidates
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != role_idx)
            .max_by_key(|(_, (_, s))| s.chars().count())
            .map(|(i, _)| i);
        if let Some(idx) = prompt_idx {
            prompt = Some(clamp_chars(&candidates[idx].1, SUBAGENT_TEXT_CAP));
        }
    } else if let Some((_, single)) = candidates.into_iter().next() {
        if !single.contains('\n') && !single.contains(' ') && single.chars().count() <= 64 {
            role = Some(single);
        } else {
            prompt = Some(clamp_chars(&single, SUBAGENT_TEXT_CAP));
        }
    }

    if role.is_none() && prompt.is_none() && conversation_id.is_none() && log_uri.is_none() {
        return None;
    }
    Some(InvokedSubagent {
        step_idx,
        status,
        role,
        prompt,
        conversation_id,
        log_uri,
    })
}

/// Reads recent `step_type = 127` (`INVOKE_SUBAGENT`) entries from a conversation
/// DB read-only. Silently returns an empty list on missing DB, symlink, lock,
/// or schema drift.
pub(crate) fn list_invoked_subagents(path: &Path, limit: usize) -> Vec<InvokedSubagent> {
    let cap = if limit == 0 { MAX_CHILDREN } else { limit.min(MAX_CHILDREN) } as i64;
    let Some(rows) = with_readonly_conn(path, |conn| {
        block_on(
            sqlx::query("SELECT idx, status, step_payload FROM steps WHERE step_type = ?1 ORDER BY idx DESC LIMIT ?2")
                .bind(STEP_TYPE_INVOKE_SUBAGENT)
                .bind(cap)
                .fetch_all(conn),
        )
    }) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        let Ok(idx) = row.try_get::<i64, _>("idx") else { continue };
        let status = row.try_get::<i64, _>("status").unwrap_or(0);
        let Some(payload) = read_blob_or_text(&row, "step_payload") else { continue };
        if let Some(entry) = parse_subagent_payload(idx, status, &payload) {
            out.push(entry);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;

    fn create_steps_db(path: &Path) {
        let options = SqliteConnectOptions::new().filename(path).create_if_missing(true);
        let mut conn = block_on(options.connect()).expect("create sqlite db");
        block_on(conn.execute(
            "CREATE TABLE steps (
                idx integer PRIMARY KEY,
                step_type integer NOT NULL DEFAULT 0,
                status integer NOT NULL DEFAULT 0,
                has_subtrajectory numeric NOT NULL DEFAULT false,
                metadata blob,
                error_details blob,
                permissions blob,
                task_details blob,
                render_info blob,
                step_payload blob,
                step_format integer NOT NULL DEFAULT 0
            );",
        ))
        .expect("create steps table");
    }

    fn insert_step(path: &Path, idx: i64, step_type: i64, payload: Option<&[u8]>, error_details: Option<&[u8]>) {
        let options = SqliteConnectOptions::new().filename(path);
        let mut conn = block_on(options.connect()).expect("open sqlite db");
        block_on(
            sqlx::query("INSERT INTO steps (idx, step_type, step_payload, error_details) VALUES (?1, ?2, ?3, ?4)")
                .bind(idx)
                .bind(step_type)
                .bind(payload)
                .bind(error_details)
                .execute(&mut conn),
        )
        .expect("insert step");
    }

    #[test]
    fn conversation_db_path_rejects_traversal() {
        let gemini = Path::new("/tmp/gemini");
        assert_eq!(
            conversation_db_path("abc-123", gemini, "antigravity-cli"),
            Some(PathBuf::from("/tmp/gemini/antigravity-cli/conversations/abc-123.db"))
        );
        assert_eq!(conversation_db_path("../escape", gemini, "antigravity-cli"), None);
        assert_eq!(conversation_db_path("a/b", gemini, "antigravity-cli"), None);
        assert_eq!(conversation_db_path("", gemini, "antigravity-cli"), None);
        assert_eq!(conversation_db_path("abc", gemini, "../bad"), None);
    }

    #[test]
    fn detects_429_quota_exhausted_with_retry_hint() {
        let dir = tempfile::tempdir().unwrap();
        let conv = dir.path().join("conversations");
        std::fs::create_dir_all(&conv).unwrap();
        let db = conv.join("sess-1.db");
        create_steps_db(&db);
        insert_step(&db, 0, 5, Some(b"normal assistant turn"), None);
        assert_eq!(latest_step_index(&db), Some(0));
        assert_eq!(detect_silent_error(&db, -1), None);

        let proto = b"\x08\x11\x12\x80Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED\nreason:QUOTA_EXHAUSTED quotaResetDelay:\"42s\"\x00\x01";
        insert_step(&db, 1, STEP_TYPE_ERROR_MESSAGE, Some(proto), None);
        let err = detect_silent_error(&db, 0).expect("detects error");
        assert_eq!(err.status_code, Some(429));
        assert!(err.quota_exhausted);
        assert_eq!(err.retry_hint.as_deref(), Some("42s"));
        assert!(!err.invalid_thinking_signature);
        assert!(err.message.contains("429"), "{}", err.message);
        assert!(err.message.contains("QUOTA_EXHAUSTED"), "{}", err.message);
        assert!(err.message.contains("42s"), "{}", err.message);
    }

    #[test]
    fn detects_503_status_code_error_and_ignores_normal_step() {
        let dir = tempfile::tempdir().unwrap();
        let conv = dir.path().join("conversations");
        std::fs::create_dir_all(&conv).unwrap();
        let db = conv.join("sess-2.db");
        create_steps_db(&db);
        insert_step(&db, 2, STEP_TYPE_ERROR_MESSAGE, None, Some(b"STATUS (code 503): Service Unavailable"));
        let err = detect_silent_error(&db, 1).expect("detects 503");
        assert_eq!(err.status_code, Some(503));
        assert!(err.message.contains("Service Unavailable"));
        assert!(!err.quota_exhausted);

        // Subsequent normal reply step supersedes earlier step_type=17.
        insert_step(&db, 3, 6, Some(b"recovered"), None);
        assert_eq!(detect_silent_error(&db, 1), None);
    }

    #[test]
    fn detects_invalid_thinking_signature() {
        let dir = tempfile::tempdir().unwrap();
        let conv = dir.path().join("conversations");
        std::fs::create_dir_all(&conv).unwrap();
        let db = conv.join("sess-3.db");
        create_steps_db(&db);
        insert_step(
            &db,
            4,
            STEP_TYPE_ERROR_MESSAGE,
            Some(b"\x00Error 400, Message: Invalid thinking signature, Status: INVALID_THINKING_SIGNATURE"),
            None,
        );
        let err = detect_silent_error(&db, 3).expect("detects thinking signature error");
        assert_eq!(err.status_code, Some(400));
        assert!(err.invalid_thinking_signature);
    }

    #[test]
    fn rejects_symlinked_db_and_missing_files_silently() {
        let dir = tempfile::tempdir().unwrap();
        let conv = dir.path().join("conversations");
        std::fs::create_dir_all(&conv).unwrap();
        let real_db = dir.path().join("real.db");
        create_steps_db(&real_db);
        insert_step(&real_db, 1, STEP_TYPE_ERROR_MESSAGE, Some(b"STATUS (code 500): boom"), None);

        let link_db = conv.join("linked.db");
        std::os::unix::fs::symlink(&real_db, &link_db).unwrap();
        assert_eq!(latest_step_index(&link_db), None);
        assert_eq!(detect_silent_error(&link_db, 0), None);
        assert_eq!(detect_silent_error(&conv.join("missing.db"), 0), None);
        assert!(list_invoked_subagents(&link_db, 16).is_empty());
    }

    fn encode_varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let mut b = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                b |= 0x80;
            }
            out.push(b);
            if v == 0 {
                break;
            }
        }
    }

    fn encode_len_field(field_no: u32, payload: &[u8], out: &mut Vec<u8>) {
        encode_varint((u64::from(field_no) << 3) | 2, out);
        encode_varint(payload.len() as u64, out);
        out.extend_from_slice(payload);
    }

    #[test]
    fn lists_invoked_subagents_from_protobuf_payload_and_tolerates_schema_drift() {
        let dir = tempfile::tempdir().unwrap();
        let conv = dir.path().join("conversations");
        std::fs::create_dir_all(&conv).unwrap();
        let db = conv.join("sess-sub.db");
        create_steps_db(&db);

        // Nested CortexStep(field 127) -> InvokeSubagent(role, prompt, conv_id, log_uri).
        let mut inner = Vec::new();
        encode_len_field(1, b"explore", &mut inner);
        encode_len_field(2, b"Find all OAR session adapters in crates/runtime", &mut inner);
        encode_len_field(3, b"5d4f594b-ca4a-4e3c-a081-171ddb1d2d1d", &mut inner);
        encode_len_field(
            4,
            b"file:///Users/test/.gemini/antigravity-cli/brain/5d4f594b-ca4a-4e3c-a081-171ddb1d2d1d/.system_generated/logs/transcript.jsonl",
            &mut inner,
        );
        let mut wrapper = Vec::new();
        encode_len_field(127, &inner, &mut wrapper);

        insert_step(&db, 10, STEP_TYPE_INVOKE_SUBAGENT, Some(&wrapper), None);
        // Corrupted / unknown binary bytes on another step should fail silently without breaking valid rows.
        insert_step(&db, 11, STEP_TYPE_INVOKE_SUBAGENT, Some(b"\xff\xff\xff\x07\x04"), None);
        // Second valid subagent whose conversation_id is only in log_uri.
        let mut inner2 = Vec::new();
        encode_len_field(1, b"verifier", &mut inner2);
        encode_len_field(2, b"Run cargo test across the runtime crate", &mut inner2);
        encode_len_field(4, b"/tmp/base/brain/worker-conv-99/.system_generated/logs/transcript.jsonl", &mut inner2);
        insert_step(&db, 12, STEP_TYPE_INVOKE_SUBAGENT, Some(&inner2), None);

        let found = list_invoked_subagents(&db, 16);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].step_idx, 12);
        assert_eq!(found[0].role.as_deref(), Some("verifier"));
        assert_eq!(found[0].prompt.as_deref(), Some("Run cargo test across the runtime crate"));
        assert_eq!(found[0].conversation_id.as_deref(), Some("worker-conv-99"));

        assert_eq!(found[1].step_idx, 10);
        assert_eq!(found[1].role.as_deref(), Some("explore"));
        assert_eq!(found[1].prompt.as_deref(), Some("Find all OAR session adapters in crates/runtime"));
        assert_eq!(found[1].conversation_id.as_deref(), Some("5d4f594b-ca4a-4e3c-a081-171ddb1d2d1d"));

        // Schema drift: DB without `steps` table returns empty silently.
        let drift_db = conv.join("drift.db");
        let options = SqliteConnectOptions::new().filename(&drift_db).create_if_missing(true);
        let mut conn = block_on(options.connect()).unwrap();
        block_on(conn.execute("CREATE TABLE other_table (id integer PRIMARY KEY);")).unwrap();
        assert!(list_invoked_subagents(&drift_db, 16).is_empty());
    }

    #[test]
    fn reuses_cached_readonly_connection_and_invalidates_on_inode_change() {
        let dir = tempfile::tempdir().unwrap();
        let conv = dir.path().join("conversations");
        std::fs::create_dir_all(&conv).unwrap();
        let db = conv.join("sess-cached.db");
        create_steps_db(&db);
        insert_step(&db, 1, 5, Some(b"first"), None);

        // Prime cache with the first read.
        assert_eq!(latest_step_index(&db), Some(1));
        let opens_after_first = readonly_open_count(&db);

        // Subsequent reads against the same inode hit the cached connection without reopening.
        insert_step(&db, 2, 5, Some(b"second"), None);
        assert_eq!(latest_step_index(&db), Some(2));
        assert_eq!(detect_silent_error(&db, 0), None);
        assert!(list_invoked_subagents(&db, 4).is_empty());
        assert_eq!(
            readonly_open_count(&db),
            opens_after_first,
            "repeated polls on unchanged inode should reuse cached sqlite connection"
        );

        // Replacing the file with a new inode invalidates the cached handle and reads fresh state.
        let replacement = conv.join("sess-replacement.db");
        create_steps_db(&replacement);
        insert_step(&replacement, 99, 5, Some(b"replaced"), None);
        std::fs::rename(&replacement, &db).unwrap();
        assert_eq!(latest_step_index(&db), Some(99));
        assert!(
            readonly_open_count(&db) > opens_after_first,
            "inode change must invalidate cached handle and reopen"
        );
    }
}
