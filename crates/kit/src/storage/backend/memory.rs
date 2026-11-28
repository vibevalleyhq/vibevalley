//! Deterministic in-memory [`StorageBackend`] twin backed by a `BTreeMap` and [`SharedClock`].

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use parking_lot::RwLock;

use super::{BoxFuture, ObjectMeta, StorageBackend, StorageError, StorageKind};
use crate::core::secret::sha256_hex;
use crate::core::time::{SharedClock, system_clock};
use crate::storage::guard::{normalize_key, normalize_prefix};

#[derive(Debug, Clone)]
struct StoredObject {
    bytes: Vec<u8>,
    content_type: Option<String>,
    etag: String,
    last_modified_ms: i64,
}

/// In-memory object storage backend (`memory://`).
///
/// Returns `None` from [`StorageBackend::local_path`] so tests using `MemoryStorage`
/// exercise the exact same local read-through cache path as remote S3 backends.
pub struct MemoryStorage {
    objects: RwLock<BTreeMap<String, StoredObject>>,
    clock: SharedClock,
}

impl fmt::Debug for MemoryStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryStorage").field("len", &self.len()).finish_non_exhaustive()
    }
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    pub fn with_clock(clock: SharedClock) -> Self {
        Self {
            objects: RwLock::new(BTreeMap::new()),
            clock,
        }
    }

    pub fn len(&self) -> usize {
        self.objects.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.read().is_empty()
    }
}

impl StorageBackend for MemoryStorage {
    fn kind(&self) -> StorageKind {
        StorageKind::Memory
    }

    fn put<'a>(&'a self, key: &'a str, bytes: Vec<u8>, content_type: Option<&'a str>) -> BoxFuture<'a, Result<ObjectMeta, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            let etag = sha256_hex(&bytes);
            let size = bytes.len() as u64;
            let last_modified_ms = self.clock.now_ms();
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
