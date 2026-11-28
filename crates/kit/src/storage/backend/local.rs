//! Local filesystem [`StorageBackend`] with atomic temp-file writes and
//! direct OS path exposure (`local_path() == Some(...)`).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tokio::io::AsyncWriteExt;

use super::{BoxFuture, ObjectMeta, StorageBackend, StorageError, StorageKind};
use crate::core::secret::sha256_hex;
use crate::storage::guard::{normalize_key, normalize_prefix, safe_join};

const TEMP_PREFIX: &str = ".vv-put-";

/// Local filesystem object storage backend rooted at a directory.
#[derive(Debug, Clone)]
pub struct LocalFsStorage {
    root: PathBuf,
}

impl LocalFsStorage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve_key(&self, key: &str) -> Result<(String, PathBuf), StorageError> {
        safe_join(&self.root, key)
    }
}

fn system_time_to_ms(res: std::io::Result<SystemTime>) -> Option<i64> {
    res.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
}

impl StorageBackend for LocalFsStorage {
    fn kind(&self) -> StorageKind {
        StorageKind::LocalFs
    }

    fn put<'a>(&'a self, key: &'a str, bytes: Vec<u8>, content_type: Option<&'a str>) -> BoxFuture<'a, Result<ObjectMeta, StorageError>> {
        Box::pin(async move {
            let (norm, target) = self.resolve_key(key)?;
            let parent = target
                .parent()
                .ok_or_else(|| std::io::Error::other("storage target missing parent directory"))?;
            tokio::fs::create_dir_all(parent).await?;

            let tmp = parent.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
            let write_res = async {
                let mut f = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).await?;
                f.write_all(&bytes).await?;
                f.sync_all().await?;
                Ok::<(), std::io::Error>(())
            }
            .await;
            if let Err(err) = write_res {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(err.into());
            }
            if let Err(err) = tokio::fs::rename(&tmp, &target).await {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(err.into());
            }

            let meta = tokio::fs::metadata(&target).await.ok();
            Ok(ObjectMeta {
                key: norm,
                size: bytes.len() as u64,
                content_type: content_type.map(str::to_owned),
                etag: Some(sha256_hex(&bytes)),
                last_modified_ms: meta.and_then(|m| system_time_to_ms(m.modified())),
            })
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>, StorageError>> {
        Box::pin(async move {
            let (_norm, target) = self.resolve_key(key)?;
            match tokio::fs::read(&target).await {
                Ok(bytes) => Ok(Some(bytes)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
    }

    fn head<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<ObjectMeta>, StorageError>> {
        Box::pin(async move {
            let (norm, target) = self.resolve_key(key)?;
            match tokio::fs::metadata(&target).await {
                Ok(meta) if meta.is_file() => Ok(Some(ObjectMeta {
                    key: norm,
                    size: meta.len(),
                    content_type: None,
                    etag: None,
                    last_modified_ms: system_time_to_ms(meta.modified()),
                })),
                Ok(_) => Ok(None),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>> {
        Box::pin(async move {
            let (_norm, target) = self.resolve_key(key)?;
            match tokio::fs::remove_file(&target).await {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e.into()),
            }
        })
    }

    fn list<'a>(&'a self, prefix: &'a str) -> BoxFuture<'a, Result<Vec<ObjectMeta>, StorageError>> {
        Box::pin(async move {
            let norm_prefix = normalize_prefix(prefix)?;
            let start_dir = match norm_prefix.rfind('/') {
                Some(idx) => self.root.join(&norm_prefix[..idx]),
                None => self.root.clone(),
            };
            if !tokio::fs::try_exists(&start_dir).await? {
                return Ok(Vec::new());
            }

            let mut results = Vec::new();
            let mut stack = vec![start_dir];
            while let Some(dir) = stack.pop() {
                let mut rd = match tokio::fs::read_dir(&dir).await {
                    Ok(rd) => rd,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                while let Some(entry) = rd.next_entry().await? {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with(TEMP_PREFIX) {
                        continue;
                    }
                    let path = entry.path();
                    let ft = entry.file_type().await?;
                    if ft.is_dir() {
                        stack.push(path);
                    } else if ft.is_file() {
                        let rel = path
                            .strip_prefix(&self.root)
                            .map_err(std::io::Error::other)?
                            .to_string_lossy()
                            .replace('\\', "/");
                        if rel.starts_with(&norm_prefix) {
                            let meta = entry.metadata().await?;
                            results.push(ObjectMeta {
                                key: rel,
                                size: meta.len(),
                                content_type: None,
                                etag: None,
                                last_modified_ms: system_time_to_ms(meta.modified()),
                            });
                        }
                    }
                }
            }
            results.sort_by(|a, b| a.key.cmp(&b.key));
            Ok(results)
        })
    }

    fn local_path(&self, key: &str) -> Option<PathBuf> {
        let norm = normalize_key(key).ok()?;
        Some(self.root.join(norm))
    }
}
