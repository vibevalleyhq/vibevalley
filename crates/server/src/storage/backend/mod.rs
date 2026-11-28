//! Pluggable object storage backend delegating core mechanics (`StorageBackend`,
//! `LocalFsStorage`, `MemoryStorage`, `S3Storage`, path guards) to `vibevalley_kit::storage`.

pub mod config;
pub mod local;
pub mod memory;
pub mod s3;

use std::sync::Arc;

pub use config::{S3Config, StorageConfig};
pub use local::LocalFsBackend;
pub use memory::MemoryBackend;
pub use s3::{S3Backend, SigV4Headers, presign_v4_get, sign_v4_request};
pub use vibevalley_kit::storage::{ObjectMeta, StorageBackend, StorageError, StorageKind, normalize_key, normalize_prefix};

/// Constructs a concrete [`StorageBackend`] from a validated [`StorageConfig`].
pub fn build_backend(config: &StorageConfig) -> Result<Arc<dyn StorageBackend>, StorageError> {
    vibevalley_kit::storage::build_backend(&config.to_kit())
}
