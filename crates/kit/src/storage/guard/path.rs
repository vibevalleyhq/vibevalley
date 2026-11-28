//! Relative object-key and prefix validation preventing path traversal across
//! local filesystem, S3-compatible, and in-memory storage backends.

use std::path::{Path, PathBuf};

use crate::storage::backend::StorageError;

fn invalid_key(key: &str, reason: impl Into<String>) -> StorageError {
    StorageError::InvalidKey {
        key: key.to_owned(),
        reason: reason.into(),
    }
}

/// Validates and normalizes an object key.
///
/// Rejects empty keys, leading/trailing `/`, empty segments (`//`), `.` / `..`
/// traversal segments, backslashes, NUL bytes, and ASCII control characters.
pub fn normalize_key(key: &str) -> Result<String, StorageError> {
    if key.is_empty() {
        return Err(invalid_key(key, "key must not be empty"));
    }
    if key.contains('\0') {
        return Err(invalid_key(key, "key must not contain NUL bytes"));
    }
    if key.contains('\\') {
        return Err(invalid_key(key, "key must not contain backslashes"));
    }
    if key.starts_with('/') {
        return Err(invalid_key(key, "key must be relative, not absolute"));
    }
    if key.ends_with('/') {
        return Err(invalid_key(key, "key must not end with '/'"));
    }
    if key.chars().any(char::is_control) {
        return Err(invalid_key(key, "key must not contain control characters"));
    }
    let mut parts = Vec::new();
    for seg in key.split('/') {
        if seg.is_empty() {
            return Err(invalid_key(key, "key must not contain empty path segments"));
        }
        if seg == "." || seg == ".." {
            return Err(invalid_key(key, "key must not contain '.' or '..' traversal segments"));
        }
        parts.push(seg);
    }
    Ok(parts.join("/"))
}

/// Validates and normalizes a listing prefix.
///
/// Empty string `""` is allowed (lists all objects). A single trailing `'/'` is
/// preserved so directory-scoped prefixes like `"attachments/"` match S3 semantics.
pub fn normalize_prefix(prefix: &str) -> Result<String, StorageError> {
    if prefix.is_empty() {
        return Ok(String::new());
    }
    if prefix.contains('\0') {
        return Err(invalid_key(prefix, "prefix must not contain NUL bytes"));
    }
    if prefix.contains('\\') {
        return Err(invalid_key(prefix, "prefix must not contain backslashes"));
    }
    if prefix.starts_with('/') {
        return Err(invalid_key(prefix, "prefix must be relative, not absolute"));
    }
    if prefix.chars().any(char::is_control) {
        return Err(invalid_key(prefix, "prefix must not contain control characters"));
    }
    let (body, had_slash) = match prefix.strip_suffix('/') {
        Some(rest) => (rest, true),
        None => (prefix, false),
    };
    if body.is_empty() {
        return Err(invalid_key(prefix, "prefix must not be bare '/'"));
    }
    for seg in body.split('/') {
        if seg.is_empty() {
            return Err(invalid_key(prefix, "prefix must not contain empty path segments"));
        }
        if seg == "." || seg == ".." {
            return Err(invalid_key(prefix, "prefix must not contain '.' or '..' traversal segments"));
        }
    }
    if had_slash { Ok(format!("{body}/")) } else { Ok(body.to_owned()) }
}

/// Validates `key` via [`normalize_key`] and joins it beneath `root`, guaranteeing the
/// resolved path cannot escape `root`.
pub fn safe_join(root: &Path, key: &str) -> Result<(String, PathBuf), StorageError> {
    let norm = normalize_key(key)?;
    let path = root.join(&norm);
    Ok((norm, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_key_accepts_valid_relative_keys() {
        assert_eq!(normalize_key("attachments/abc123").unwrap(), "attachments/abc123");
        assert_eq!(normalize_key("note/id1/structure/main.md").unwrap(), "note/id1/structure/main.md");
        assert_eq!(normalize_key("note/id1/.cover.json").unwrap(), "note/id1/.cover.json");
        assert_eq!(normalize_key("single-file").unwrap(), "single-file");
    }

    #[test]
    fn normalize_key_rejects_traversal_and_malformed_inputs() {
        for bad in [
            "",
            "/",
            "/etc/passwd",
            "attachments/",
            "attachments//abc",
            "../secret",
            "a/../b",
            "a/..",
            "./a",
            "a/./b",
            "a\\b",
            "a/b\0c",
            "a/b\nc",
        ] {
            let err = normalize_key(bad).expect_err(&format!("expected `{bad}` to be rejected"));
            assert!(matches!(err, StorageError::InvalidKey { .. }), "unexpected error for `{bad}`: {err:?}");
        }
    }

    #[test]
    fn normalize_prefix_allows_empty_and_trailing_slash_but_rejects_traversal() {
        assert_eq!(normalize_prefix("").unwrap(), "");
        assert_eq!(normalize_prefix("attachments").unwrap(), "attachments");
        assert_eq!(normalize_prefix("attachments/").unwrap(), "attachments/");
        assert_eq!(normalize_prefix("note/a1/structure/").unwrap(), "note/a1/structure/");

        for bad in ["/", "/abs", "a//b", "a/../b", "..", ".", "a\\b", "a\0b", "a\tb", "a//"] {
            assert!(normalize_prefix(bad).is_err(), "expected prefix `{bad}` to be rejected");
        }
    }

    #[test]
    fn safe_join_joins_normalized_key_under_root() {
        let root = Path::new("/tmp/vv-root");
        let (norm, joined) = safe_join(root, "a/b.txt").unwrap();
        assert_eq!(norm, "a/b.txt");
        assert_eq!(joined, root.join("a/b.txt"));
        assert!(safe_join(root, "../escape").is_err());
    }
}
