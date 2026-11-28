use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum DirLeaseError {
    #[error("failed to create lock directory {path}: {source}")]
    CreateDir { path: PathBuf, source: std::io::Error },
    #[error("failed to open lock file {path}: {source}")]
    Open { path: PathBuf, source: std::io::Error },
    #[error("directory {dir} is already locked by another writer ({reason})")]
    AlreadyLocked { dir: PathBuf, reason: String },
}

/// Exclusive cross-process directory lock held until dropped or explicitly released.
pub struct DirLease {
    path: PathBuf,
    file: Option<File>,
}

impl DirLease {
    /// Creates `dir` if missing and acquires an exclusive non-blocking lock on `dir/<lock_file_name>`.
    pub fn acquire(dir: &Path, lock_file_name: &str) -> Result<Self, DirLeaseError> {
        std::fs::create_dir_all(dir).map_err(|source| DirLeaseError::CreateDir {
            path: dir.to_path_buf(),
            source,
        })?;
        let lock_path = dir.join(lock_file_name);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|source| DirLeaseError::Open {
                path: lock_path.clone(),
                source,
            })?;
        file.try_lock().map_err(|err| DirLeaseError::AlreadyLocked {
            dir: dir.to_path_buf(),
            reason: err.to_string(),
        })?;
        Ok(Self {
            path: lock_path,
            file: Some(file),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn release(&mut self) {
        self.file.take();
    }
}

impl Drop for DirLease {
    fn drop(&mut self) {
        self.file.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_lease_prevents_double_acquire_and_releases_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let lease = DirLease::acquire(dir.path(), ".lock").unwrap();
        let second = DirLease::acquire(dir.path(), ".lock");
        assert!(matches!(second, Err(DirLeaseError::AlreadyLocked { .. })));

        drop(lease);
        let third = DirLease::acquire(dir.path(), ".lock").unwrap();
        assert_eq!(third.path(), dir.path().join(".lock"));
    }
}
