//! Pluggable object storage backend trait ([`StorageBackend`]), key normalization,
//! configuration ([`StorageConfig`]), and built-in implementations
//! ([`LocalFsBackend`], [`S3Backend`], [`MemoryBackend`]).

pub mod config;
pub mod local;
pub mod memory;
pub mod s3;

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::BoxFuture;

pub use config::{S3Config, StorageConfig};
pub use local::LocalFsBackend;
pub use memory::MemoryBackend;
pub use s3::{S3Backend, SigV4Headers, presign_v4_get, sign_v4_request};

/// Concrete backend flavor selected by [`StorageConfig`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageKind {
    LocalFs,
    S3,
    Memory,
}

impl StorageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalFs => "local_fs",
            Self::S3 => "s3",
            Self::Memory => "memory",
        }
    }
}

impl fmt::Display for StorageKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Metadata returned by [`StorageBackend::put`], [`StorageBackend::head`], and [`StorageBackend::list`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMeta {
    pub key: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified_ms: Option<i64>,
}

/// Errors produced by storage backend configuration, key validation, or I/O.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("invalid storage key `{key}`: {reason}")]
    InvalidKey { key: String, reason: String },

    #[error("invalid storage configuration: {0}")]
    Config(String),

    #[error("storage I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("remote storage HTTP {status}: {message}")]
    Http { status: u16, message: String },

    #[error("remote storage transport error: {0}")]
    Transport(String),

    #[error("malformed remote storage response: {0}")]
    Protocol(String),
}

/// Narrow async object-storage port implemented by all pluggable backends.
///
/// Every implementation MUST validate keys through [`normalize_key`] and prefixes
/// through [`normalize_prefix`] so path-traversal guarantees stay identical across
/// local filesystem, S3-compatible, and in-memory backends.
pub trait StorageBackend: Send + Sync {
    fn kind(&self) -> StorageKind;

    /// Atomically writes or overwrites `key` with `bytes`.
    fn put<'a>(&'a self, key: &'a str, bytes: Vec<u8>, content_type: Option<&'a str>) -> BoxFuture<'a, Result<ObjectMeta, StorageError>>;

    /// Reads the complete bytes of `key`, or `Ok(None)` if the object does not exist.
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>, StorageError>>;

    /// Fetches metadata for `key`, or `Ok(None)` if the object does not exist.
    fn head<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<ObjectMeta>, StorageError>>;

    /// Deletes `key`.
    ///
    /// Returns `Ok(true)` when an object was removed (or on idempotent remote stores such as S3
    /// that return `204 No Content`), and `Ok(false)` when the backend confirmed `key` did not exist.
    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>>;

    /// Lists all objects whose normalized key starts with `prefix`, sorted lexicographically by key.
    fn list<'a>(&'a self, prefix: &'a str) -> BoxFuture<'a, Result<Vec<ObjectMeta>, StorageError>>;

    /// Returns whether an object exists at `key`.
    fn exists<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>> {
        Box::pin(async move { Ok(self.head(key).await?.is_some()) })
    }

    /// Direct local filesystem path for `key` if this backend stores objects natively on disk
    /// (`LocalFsBackend`), or `None` for remote/in-memory backends so callers can transparently
    /// read-through to a local cache when a native OS path is required.
    fn local_path(&self, key: &str) -> Option<PathBuf>;

    /// Time-limited presigned GET URL for `key` when supported (e.g. `S3Backend`).
    fn signed_url(&self, key: &str, expires_secs: u64) -> Option<String> {
        let _ = (key, expires_secs);
        None
    }
}

/// Constructs a concrete [`StorageBackend`] from a validated [`StorageConfig`].
pub fn build_backend(config: &StorageConfig) -> Result<Arc<dyn StorageBackend>, StorageError> {
    match config {
        StorageConfig::LocalFs { root } => Ok(Arc::new(LocalFsBackend::new(root))),
        StorageConfig::S3(s3) => Ok(Arc::new(S3Backend::new(s3.clone())?)),
        StorageConfig::Memory => Ok(Arc::new(MemoryBackend::new())),
    }
}

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

/// Encodes `bytes` as lowercase hexadecimal without extra crate dependencies.
pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(TABLE[(b >> 4) as usize] as char);
        out.push(TABLE[(b & 0x0f) as usize] as char);
    }
    out
}

/// Computes lowercase hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
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
}
