//! Deterministic in-memory [`StorageBackend`] backed by a `BTreeMap` for fast unit and integration tests.

use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::RwLock;

use super::{ObjectMeta, StorageBackend, StorageError, StorageKind, normalize_key, normalize_prefix, sha256_hex};
use crate::BoxFuture;

#[derive(Debug, Clone)]
struct StoredObject {
    bytes: Vec<u8>,
    content_type: Option<String>,
    etag: String,
    last_modified_ms: i64,
}

/// In-memory object storage backend (`memory://`).
///
/// Returns `None` from [`StorageBackend::local_path`] so tests using `MemoryBackend`
/// exercise the exact same local read-through cache path as remote S3 backends.
#[derive(Debug, Default)]
pub struct MemoryBackend {
    objects: RwLock<BTreeMap<String, StoredObject>>,
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.objects.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.read().is_empty()
    }
}

impl StorageBackend for MemoryBackend {
    fn kind(&self) -> StorageKind {
        StorageKind::Memory
    }

    fn put<'a>(&'a self, key: &'a str, bytes: Vec<u8>, content_type: Option<&'a str>) -> BoxFuture<'a, Result<ObjectMeta, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            let etag = sha256_hex(&bytes);
            let size = bytes.len() as u64;
            let last_modified_ms = crate::context::now();
            let content_type = content_type.map(str::to_owned);
            self.objects.write().insert(
                norm.clone(),
                StoredObject {
                    bytes,
                    content_type: content_type.clone(),
                    etag: etag.clone(),
                    last_modified_ms,
                },
            );
            Ok(ObjectMeta {
                key: norm,
                size,
                content_type,
                etag: Some(etag),
                last_modified_ms: Some(last_modified_ms),
            })
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            Ok(self.objects.read().get(&norm).map(|o| o.bytes.clone()))
        })
    }

    fn head<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<ObjectMeta>, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            Ok(self.objects.read().get(&norm).map(|o| ObjectMeta {
                key: norm,
                size: o.bytes.len() as u64,
                content_type: o.content_type.clone(),
                etag: Some(o.etag.clone()),
                last_modified_ms: Some(o.last_modified_ms),
            }))
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            Ok(self.objects.write().remove(&norm).is_some())
        })
    }

    fn list<'a>(&'a self, prefix: &'a str) -> BoxFuture<'a, Result<Vec<ObjectMeta>, StorageError>> {
        Box::pin(async move {
            let norm_prefix = normalize_prefix(prefix)?;
            let guard = self.objects.read();
            let out = guard
                .range(norm_prefix.clone()..)
                .take_while(|(k, _)| k.starts_with(&norm_prefix))
                .map(|(k, o)| ObjectMeta {
                    key: k.clone(),
                    size: o.bytes.len() as u64,
                    content_type: o.content_type.clone(),
                    etag: Some(o.etag.clone()),
                    last_modified_ms: Some(o.last_modified_ms),
                })
                .collect();
            Ok(out)
        })
    }

    fn exists<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            Ok(self.objects.read().contains_key(&norm))
        })
    }

    fn local_path(&self, _key: &str) -> Option<PathBuf> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_backend_crud_prefix_listing_and_validation() {
        let mem = MemoryBackend::new();
        assert_eq!(mem.kind(), StorageKind::Memory);
        assert!(mem.is_empty());

        let m1 = mem.put("attachments/b", b"two".to_vec(), Some("text/plain")).await.unwrap();
        assert_eq!(m1.size, 3);
        mem.put("attachments/a", b"one".to_vec(), Some("text/plain")).await.unwrap();
        mem.put("attachments2/c", b"three".to_vec(), None).await.unwrap();

        assert_eq!(mem.len(), 3);
        assert_eq!(mem.get("attachments/a").await.unwrap(), Some(b"one".to_vec()));
        assert!(mem.local_path("attachments/a").is_none());
        assert!(mem.signed_url("attachments/a", 300).is_none());

        let keys: Vec<String> = mem.list("attachments/").await.unwrap().into_iter().map(|m| m.key).collect();
        assert_eq!(keys, vec!["attachments/a", "attachments/b"]);

        assert!(mem.delete("attachments/a").await.unwrap());
        assert!(!mem.delete("attachments/a").await.unwrap());
        assert!(!mem.exists("attachments/a").await.unwrap());

        assert!(mem.put("/abs/key", b"x".to_vec(), None).await.is_err());
        assert!(mem.list("../bad").await.is_err());
    }
}
