//! Pluggable object storage backend trait ([`StorageBackend`]), configuration
//! ([`StorageConfig`]), built-in implementations ([`MemoryStorage`], [`LocalFsStorage`],
//! [`S3Storage`]), and a shared conformance test suite.

pub mod config;
#[cfg(feature = "storage-fs")]
pub mod local;
pub mod memory;
#[cfg(feature = "storage-s3")]
pub mod s3;

use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub use config::{ENV_S3_ACCESS_KEY_ID, ENV_S3_ENDPOINT, ENV_S3_REGION, ENV_S3_SECRET_ACCESS_KEY, ENV_STORAGE_URL, S3Config, StorageConfig};
#[cfg(feature = "storage-fs")]
pub use local::LocalFsStorage;
pub use memory::MemoryStorage;
#[cfg(feature = "storage-s3")]
pub use s3::{S3Storage, SigV4Headers, presign_v4_get, sign_v4_request};

/// Boxed `Send` future returned by [`StorageBackend`] trait methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

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
/// Every implementation MUST validate keys through `guard::normalize_key` and prefixes
/// through `guard::normalize_prefix` so path-traversal guarantees stay identical across
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
    /// (`LocalFsStorage`), or `None` for remote/in-memory backends so callers can transparently
    /// read-through to a local cache when a native OS path is required.
    fn local_path(&self, key: &str) -> Option<PathBuf>;

    /// Time-limited presigned GET URL for `key` when supported (e.g. `S3Storage`).
    fn signed_url(&self, key: &str, expires_secs: u64) -> Option<String> {
        let _ = (key, expires_secs);
        None
    }
}

/// Constructs a concrete [`StorageBackend`] from a validated [`StorageConfig`].
pub fn build_backend(config: &StorageConfig) -> Result<Arc<dyn StorageBackend>, StorageError> {
    match config {
        StorageConfig::LocalFs { root } => {
            #[cfg(feature = "storage-fs")]
            {
                Ok(Arc::new(LocalFsStorage::new(root)))
            }
            #[cfg(not(feature = "storage-fs"))]
            {
                let _ = root;
                Err(StorageError::Config("`storage-fs` feature is not enabled".into()))
            }
        }
        StorageConfig::S3(s3) => {
            #[cfg(feature = "storage-s3")]
            {
                Ok(Arc::new(S3Storage::new(s3.clone())?))
            }
            #[cfg(not(feature = "storage-s3"))]
            {
                let _ = s3;
                Err(StorageError::Config("`storage-s3` feature is not enabled".into()))
            }
        }
        StorageConfig::Memory => Ok(Arc::new(MemoryStorage::new())),
    }
}

/// Shared contract assertions proving semantic parity across [`StorageBackend`] implementations.
pub async fn assert_storage_conformance(backend: &dyn StorageBackend) {
    assert!(backend.get("blobs/missing").await.unwrap().is_none());
    assert!(backend.head("blobs/missing").await.unwrap().is_none());
    assert!(!backend.exists("blobs/missing").await.unwrap());
    assert!(!backend.delete("blobs/missing").await.unwrap());

    let m2 = backend.put("blobs/k2", b"second".to_vec(), Some("text/plain")).await.unwrap();
    assert_eq!(m2.key, "blobs/k2");
    assert_eq!(m2.size, 6);
    assert!(m2.etag.is_some());

    backend.put("blobs/k1", b"first".to_vec(), Some("text/plain")).await.unwrap();
    backend.put("blobs/k3", b"third!".to_vec(), Some("application/octet-stream")).await.unwrap();
    backend.put("other/x", b"outside".to_vec(), None).await.unwrap();

    assert_eq!(backend.get("blobs/k1").await.unwrap(), Some(b"first".to_vec()));
    assert!(backend.exists("blobs/k1").await.unwrap());
    let head = backend.head("blobs/k3").await.unwrap().expect("head present");
    assert_eq!(head.key, "blobs/k3");
    assert_eq!(head.size, 6);

    // Overwrite updates bytes and size.
    backend.put("blobs/k2", b"second-updated".to_vec(), Some("text/plain")).await.unwrap();
    assert_eq!(backend.get("blobs/k2").await.unwrap(), Some(b"second-updated".to_vec()));

    // Prefix listing returns sorted keys scoped to prefix.
    let listed = backend.list("blobs/").await.unwrap();
    let keys: Vec<&str> = listed.iter().map(|m| m.key.as_str()).collect();
    assert_eq!(keys, vec!["blobs/k1", "blobs/k2", "blobs/k3"]);

    let all = backend.list("").await.unwrap();
    let all_keys: Vec<&str> = all.iter().map(|m| m.key.as_str()).collect();
    assert_eq!(all_keys, vec!["blobs/k1", "blobs/k2", "blobs/k3", "other/x"]);

    // Delete removes the object cleanly and is idempotent.
    assert!(backend.delete("blobs/k1").await.unwrap());
    assert!(!backend.delete("blobs/k1").await.unwrap());
    assert!(backend.get("blobs/k1").await.unwrap().is_none());
    assert!(!backend.exists("blobs/k1").await.unwrap());

    // Path traversal is rejected identically across every backend.
    for bad in ["", "../escape", "/abs/path", "a\\b", "a//b", "a/b\0c", "a/b\nc"] {
        assert!(
            matches!(backend.put(bad, b"x".to_vec(), None).await, Err(StorageError::InvalidKey { .. })),
            "put must reject `{bad}`"
        );
        assert!(
            matches!(backend.get(bad).await, Err(StorageError::InvalidKey { .. })),
            "get must reject `{bad}`"
        );
        assert!(
            matches!(backend.head(bad).await, Err(StorageError::InvalidKey { .. })),
            "head must reject `{bad}`"
        );
        assert!(
            matches!(backend.delete(bad).await, Err(StorageError::InvalidKey { .. })),
            "delete must reject `{bad}`"
        );
    }
    for bad_prefix in ["/", "/abs", "a/../b", "a\\b", "a//b"] {
        assert!(
            matches!(backend.list(bad_prefix).await, Err(StorageError::InvalidKey { .. })),
            "list must reject `{bad_prefix}`"
        );
    }
}

#[cfg(test)]
mod conformance_tests {
    use super::*;

    #[tokio::test]
    async fn memory_storage_satisfies_conformance_contract() {
        let mem = MemoryStorage::new();
        assert_eq!(mem.kind(), StorageKind::Memory);
        assert_storage_conformance(&mem).await;
    }

    #[cfg(feature = "storage-fs")]
    #[tokio::test]
    async fn local_fs_storage_satisfies_conformance_contract() {
        let dir = tempfile::tempdir().unwrap();
        let fs = LocalFsStorage::new(dir.path());
        assert_eq!(fs.kind(), StorageKind::LocalFs);
        assert_storage_conformance(&fs).await;
    }
}
