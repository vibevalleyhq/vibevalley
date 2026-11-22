//! Read-only SQLite sidecar inspection for `agy >= 1.5.0` conversation DBs.
//!
//! `agy` frequently completes turns with `stopReason: "end_turn"` while writing
//! upstream 429 / 5xx / `QUOTA_EXHAUSTED` / `INVALID_THINKING_SIGNATURE`
//! failures only into `conversations/<sessionId>.db` as `step_type = 17`
//! (`CORTEX_STEP_TYPE_ERROR_MESSAGE`). This module opens that DB read-only
//! with symlink and inode verification and fails closed (`None`) on any schema,
//! lock, or I/O discrepancy.

use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use pollster::block_on;
use regex::Regex;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Row, SqliteConnection};

pub(crate) const STEP_TYPE_ERROR_MESSAGE: i64 = 17;
const PAYLOAD_SCAN_LIMIT: usize = 16 * 1024;
const BUSY_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SilentError {
    pub message: String,
    pub status_code: Option<u16>,
    pub quota_exhausted: bool,
    pub retry_hint: Option<String>,
    pub invalid_thinking_signature: bool,
}

/// Resolves `<gemini_dir>/<app_data_dir>/conversations/<session_id>.db`,
/// rejecting path traversal or control characters in `session_id` / `app_data_dir`.
pub(crate) fn conversation_db_path(session_id: &str, gemini_dir: &Path, app_data_dir: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains('\0')
        || session_id.contains("..")
        || app_data_dir.is_empty()
        || app_data_dir.contains('\0')
    {
        return None;
    }
    let app_path = Path::new(app_data_dir);
    if app_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let base = if app_path.is_absolute() {
        app_path.to_path_buf()
    } else {
        gemini_dir.join(app_path)
    };
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

fn open_readonly(path: &Path) -> Option<(SqliteConnection, (u64, u64))> {
    let before = safe_db_identity(path)?;
    let options = SqliteConnectOptions::new().filename(path).read_only(true).busy_timeout(BUSY_TIMEOUT);
    let conn = block_on(options.connect()).ok()?;
    let after = safe_db_identity(path)?;
    if before != after {
        return None;
    }
    Some((conn, before))
}

pub(crate) fn latest_step_index(path: &Path) -> Option<i64> {
    let (mut conn, identity) = open_readonly(path)?;
    let idx = block_on(sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(idx), -1) FROM steps").fetch_one(&mut conn)).ok()?;
    (safe_db_identity(path) == Some(identity)).then_some(idx)
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
    let (mut conn, identity) = open_readonly(path)?;
    let row = block_on(
        sqlx::query("SELECT step_type, step_payload, error_details FROM steps WHERE idx > ?1 ORDER BY idx DESC LIMIT 1")
            .bind(after_idx)
            .fetch_optional(&mut conn),
    )
    .ok()??;
    if safe_db_identity(path) != Some(identity) {
        return None;
    }
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
    }
}
