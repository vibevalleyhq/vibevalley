//! Local filesystem [`StorageBackend`] with atomic temp-file writes and
//! direct OS path exposure (`local_path() == Some(...)`).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tokio::io::AsyncWriteExt;

use super::{ObjectMeta, StorageBackend, StorageError, StorageKind, normalize_key, normalize_prefix, sha256_hex};
use crate::BoxFuture;

const TEMP_PREFIX: &str = ".vv-put-";

/// Default local filesystem backend rooted at a directory (typically `<home>`).
#[derive(Debug, Clone)]
pub struct LocalFsBackend {
    root: PathBuf,
}

impl LocalFsBackend {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve_key(&self, key: &str) -> Result<(String, PathBuf), StorageError> {
        let norm = normalize_key(key)?;
        let path = self.root.join(&norm);
        Ok((norm, path))
    }
}

fn system_time_to_ms(res: std::io::Result<SystemTime>) -> Option<i64> {
    res.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
}

impl StorageBackend for LocalFsBackend {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_fs_backend_roundtrip_list_delete_and_traversal_rejection() {
        let dir = tempfile::tempdir().unwrap();
        let backend = LocalFsBackend::new(dir.path());
        assert_eq!(backend.kind(), StorageKind::LocalFs);

        assert!(backend.get("attachments/missing").await.unwrap().is_none());
        assert!(backend.head("attachments/missing").await.unwrap().is_none());
        assert!(!backend.exists("attachments/missing").await.unwrap());
        assert!(!backend.delete("attachments/missing").await.unwrap());

        let meta = backend.put("attachments/a1", b"hello".to_vec(), Some("text/plain")).await.unwrap();
        assert_eq!(meta.key, "attachments/a1");
        assert_eq!(meta.size, 5);
        assert_eq!(meta.content_type.as_deref(), Some("text/plain"));
        assert!(meta.etag.is_some());

        backend.put("attachments/a2", b"world!".to_vec(), None).await.unwrap();
        backend.put("artifact/x/manifest.json", b"{}".to_vec(), Some("application/json")).await.unwrap();

        assert_eq!(backend.get("attachments/a1").await.unwrap(), Some(b"hello".to_vec()));
        assert!(backend.exists("attachments/a1").await.unwrap());
        assert_eq!(backend.local_path("attachments/a1"), Some(dir.path().join("attachments/a1")));
        assert!(backend.signed_url("attachments/a1", 60).is_none());

        let att_list = backend.list("attachments/").await.unwrap();
        let att_keys: Vec<&str> = att_list.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(att_keys, vec!["attachments/a1", "attachments/a2"]);

        let all = backend.list("").await.unwrap();
        let all_keys: Vec<&str> = all.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(all_keys, vec!["artifact/x/manifest.json", "attachments/a1", "attachments/a2"]);

        assert!(backend.delete("attachments/a1").await.unwrap());
        assert!(!backend.delete("attachments/a1").await.unwrap());
        assert!(backend.get("attachments/a1").await.unwrap().is_none());

        // Path traversal rejected across all operations.
        assert!(backend.put("../escape", b"x".to_vec(), None).await.is_err());
        assert!(backend.get("../escape").await.is_err());
        assert!(backend.local_path("../escape").is_none());
    }
}
