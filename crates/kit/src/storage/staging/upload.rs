//! Bounded streaming upload staging: writes incoming streams to `.tmp` files while
//! computing SHA-256 on the fly, rejects oversized/empty/invalid streams cleanly,
//! and removes leftover `.tmp` files on startup.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const DEFAULT_TEMP_PREFIX: &str = ".tmp-";
const DEFAULT_CHUNK_BYTES: usize = 64 * 1024;

/// Size and timeout bounds enforced during streaming staging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageLimits {
    /// Maximum allowed byte length.
    pub max_bytes: u64,
    /// Optional exact expected byte length.
    pub exact_size: Option<u64>,
    /// Reject zero-byte streams when `true`.
    pub reject_empty: bool,
    /// Optional wall-clock timeout for blocking reader transfers.
    pub timeout: Option<Duration>,
}

impl StageLimits {
    pub const fn max_only(max_bytes: u64) -> Self {
        Self {
            max_bytes,
            exact_size: None,
            reject_empty: true,
            timeout: None,
        }
    }

    pub const fn exact(size: u64) -> Self {
        Self {
            max_bytes: size,
            exact_size: Some(size),
            reject_empty: true,
            timeout: None,
        }
    }

    pub const fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

/// Completed temporary staged file with its verified size and lowercase hex SHA-256 digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedFile {
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

impl StagedFile {
    /// Atomically renames this staged file to `target` (creating parent directories as needed).
    /// Removes the temp file if rename fails.
    pub async fn promote_to_path(self, target: &Path) -> Result<(), std::io::Error> {
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Err(err) = tokio::fs::rename(&self.path, target).await {
            let _ = tokio::fs::remove_file(&self.path).await;
            return Err(err);
        }
        Ok(())
    }

    /// Discards the temporary staged file (best effort).
    pub async fn discard(self) {
        let _ = tokio::fs::remove_file(&self.path).await;
    }
}

/// Errors returned while staging an upload into a [`StagingArea`].
#[derive(Debug, thiserror::Error)]
pub enum StageError {
    #[error("staged stream is empty")]
    Empty,

    #[error("staged stream exceeded maximum size ({max_bytes} bytes)")]
    TooLarge { max_bytes: u64 },

    #[error("staged stream size mismatch (expected {expected}, got {actual})")]
    SizeMismatch { expected: u64, actual: u64 },

    #[error("staged stream timed out")]
    Timeout,

    #[error("staged stream read error: {0}")]
    Read(std::io::Error),

    #[error("staged stream validation rejected: {0}")]
    Rejected(String),

    #[error("staging storage I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Directory-scoped bounded staging area creating `.tmp-*` files and sweeping stale leftovers.
#[derive(Debug, Clone)]
pub struct StagingArea {
    root: PathBuf,
    temp_prefix: String,
}

impl StagingArea {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            temp_prefix: DEFAULT_TEMP_PREFIX.to_owned(),
        }
    }

    pub fn with_prefix(root: impl Into<PathBuf>, prefix: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            temp_prefix: prefix.into(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn next_temp_path(&self) -> PathBuf {
        self.root.join(format!("{}{}", self.temp_prefix, uuid::Uuid::new_v4()))
    }

    /// Streams an async reader into a new `.tmp` file under `self.root` while enforcing `limits`
    /// and computing SHA-256 on the fly. Automatically deletes the `.tmp` file on any error.
    pub async fn stage_async_read<R>(&self, mut reader: R, limits: StageLimits) -> Result<StagedFile, StageError>
    where
        R: AsyncRead + Unpin,
    {
        tokio::fs::create_dir_all(&self.root).await?;
        let tmp = self.next_temp_path();
        let res = async {
            let mut opts = tokio::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                opts.mode(0o600);
            }
            let mut dest = opts.open(&tmp).await?;
            let mut hasher = Sha256::new();
            let mut buf = [0u8; DEFAULT_CHUNK_BYTES];
            let mut total: u64 = 0;
            loop {
                let n = reader.read(&mut buf).await.map_err(StageError::Read)?;
                if n == 0 {
                    break;
                }
                total = total.saturating_add(n as u64);
                if total > limits.max_bytes {
                    return Err(StageError::TooLarge { max_bytes: limits.max_bytes });
                }
                hasher.update(&buf[..n]);
                dest.write_all(&buf[..n]).await?;
            }
            if limits.reject_empty && total == 0 {
                return Err(StageError::Empty);
            }
            if let Some(expected) = limits.exact_size
                && total != expected
            {
                return Err(StageError::SizeMismatch { expected, actual: total });
            }
            dest.sync_all().await?;
            let sha256 = hex::encode(hasher.finalize());
            Ok(StagedFile {
                path: tmp.clone(),
                size: total,
                sha256,
            })
        }
        .await;
        if res.is_err() {
            let _ = tokio::fs::remove_file(&tmp).await;
        }
        res
    }

    /// Streams a blocking [`Read`] into a private `.tmp` file while validating an optional leading
    /// prefix slice (up to `prefix_len` bytes) via `validate_prefix` and computing SHA-256 on the fly.
    pub fn stage_reader_blocking<R, V>(&self, mut reader: R, limits: StageLimits, prefix_len: usize, mut validate_prefix: V) -> Result<StagedFile, StageError>
    where
        R: Read,
        V: FnMut(&[u8]) -> Result<(), String>,
    {
        std::fs::create_dir_all(&self.root)?;
        let tmp = self.next_temp_path();
        let res = (|| -> Result<StagedFile, StageError> {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                opts.mode(0o600);
            }
            let mut dest = opts.open(&tmp)?;
            let mut hasher = Sha256::new();
            let mut buf = [0u8; DEFAULT_CHUNK_BYTES];
            let mut total: u64 = 0;
            let mut prefix = Vec::with_capacity(prefix_len);
            let mut prefix_checked = false;
            let started = Instant::now();

            loop {
                if let Some(timeout) = limits.timeout
                    && started.elapsed() > timeout
                {
                    return Err(StageError::Timeout);
                }
                let n = reader.read(&mut buf).map_err(|err| {
                    if err.kind() == std::io::ErrorKind::TimedOut {
                        StageError::Timeout
                    } else {
                        StageError::Read(err)
                    }
                })?;
                if n == 0 {
                    break;
                }
                total = total.saturating_add(n as u64);
                if total > limits.max_bytes {
                    return Err(StageError::TooLarge { max_bytes: limits.max_bytes });
                }
                if prefix.len() < prefix_len {
                    let take = n.min(prefix_len - prefix.len());
                    prefix.extend_from_slice(&buf[..take]);
                    if prefix.len() == prefix_len && !prefix_checked {
                        validate_prefix(&prefix).map_err(StageError::Rejected)?;
                        prefix_checked = true;
                    }
                }
                hasher.update(&buf[..n]);
                dest.write_all(&buf[..n])?;
            }

            if limits.reject_empty && total == 0 {
                return Err(StageError::Empty);
            }
            if let Some(expected) = limits.exact_size
                && total != expected
            {
                return Err(StageError::SizeMismatch { expected, actual: total });
            }
            if !prefix_checked {
                validate_prefix(&prefix).map_err(StageError::Rejected)?;
            }
            dest.sync_all()?;
            drop(dest);
            Ok(StagedFile {
                path: tmp.clone(),
                size: total,
                sha256: hex::encode(hasher.finalize()),
            })
        })();
        if res.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        res
    }

    /// Removes all matching `.tmp*` files directly inside `self.root` (e.g. on process startup).
    /// Returns the number of files deleted.
    pub async fn cleanup_stale_async(&self) -> Result<u64, std::io::Error> {
        self.cleanup_stale_older_than_async(None).await
    }

    /// Removes matching `.tmp*` files directly inside `self.root` whose mtime is older than
    /// `max_age` (or all matching `.tmp*` files when `max_age` is `None`).
    pub async fn cleanup_stale_older_than_async(&self, max_age: Option<Duration>) -> Result<u64, std::io::Error> {
        let mut rd = match tokio::fs::read_dir(&self.root).await {
            Ok(rd) => rd,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(err) => return Err(err),
        };
        let now = SystemTime::now();
        let mut removed = 0u64;
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.starts_with(&self.temp_prefix) {
                continue;
            }
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            if !ft.is_file() {
                continue;
            }
            if let Some(age) = max_age {
                let Ok(meta) = entry.metadata().await else {
                    continue;
                };
                let Ok(modified) = meta.modified() else {
                    continue;
                };
                if now.duration_since(modified).is_ok_and(|elapsed| elapsed < age) {
                    continue;
                }
            }
            if tokio::fs::remove_file(entry.path()).await.is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::core::secret::sha256_hex;

    #[tokio::test]
    async fn stage_async_read_streams_hashes_enforces_limits_and_cleans_up_stale_tmps() {
        let dir = tempfile::tempdir().unwrap();
        let area = StagingArea::new(dir.path());

        let payload = b"hello bounded staging area";
        let staged = area.stage_async_read(&payload[..], StageLimits::max_only(1024)).await.unwrap();
        assert_eq!(staged.size, payload.len() as u64);
        assert_eq!(staged.sha256, sha256_hex(payload));
        assert!(staged.path.is_file());

        let final_path = dir.path().join("promoted/blob.bin");
        staged.promote_to_path(&final_path).await.unwrap();
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), payload);

        // Oversized stream rejected and leaves no `.tmp-*` file behind.
        let oversized = [b'x'; 200];
        let err = area.stage_async_read(&oversized[..], StageLimits::max_only(64)).await.unwrap_err();
        assert!(matches!(err, StageError::TooLarge { max_bytes: 64 }));
        assert_eq!(area.cleanup_stale_async().await.unwrap(), 0);

        // Empty stream rejected.
        let empty: &[u8] = b"";
        assert!(matches!(area.stage_async_read(empty, StageLimits::max_only(64)).await, Err(StageError::Empty)));

        // Seed stale temp files + non-temp file; cleanup removes only temp files.
        tokio::fs::write(dir.path().join(".tmp-leftover-1"), b"a").await.unwrap();
        tokio::fs::write(dir.path().join(".tmp-leftover-2"), b"b").await.unwrap();
        tokio::fs::write(dir.path().join("keep.dat"), b"keep").await.unwrap();
        assert_eq!(area.cleanup_stale_async().await.unwrap(), 2);
        assert!(dir.path().join("keep.dat").is_file());
    }

    #[test]
    fn stage_reader_blocking_validates_prefix_and_exact_size() {
        let dir = tempfile::tempdir().unwrap();
        let area = StagingArea::new(dir.path());

        let ok_bytes = b"\x89PNG\r\n\x1a\n12345678".to_vec();
        let staged = area
            .stage_reader_blocking(Cursor::new(ok_bytes.clone()), StageLimits::exact(ok_bytes.len() as u64), 8, |p| {
                if p.starts_with(b"\x89PNG\r\n\x1a\n") {
                    Ok(())
                } else {
                    Err("bad magic".into())
                }
            })
            .unwrap();
        assert_eq!(staged.sha256, sha256_hex(&ok_bytes));
        assert!(staged.path.is_file());

        let bad_bytes = b"NOTAPNG!12345678".to_vec();
        let err = area
            .stage_reader_blocking(Cursor::new(bad_bytes.clone()), StageLimits::exact(bad_bytes.len() as u64), 8, |p| {
                if p.starts_with(b"\x89PNG\r\n\x1a\n") {
                    Ok(())
                } else {
                    Err("bad magic".into())
                }
            })
            .unwrap_err();
        assert!(matches!(err, StageError::Rejected(_)));
    }
}
