//! Pluggable domain-agnostic object storage, path/CAS guards, bounded streaming staging,
//! and orphan-key garbage collection.

pub mod backend;
pub mod gc;
pub mod guard;
#[cfg(feature = "storage-fs")]
pub mod staging;

#[cfg(feature = "storage-fs")]
pub use backend::LocalFsStorage;
pub use backend::{MemoryStorage, ObjectMeta, S3Config, StorageBackend, StorageConfig, StorageError, StorageKind, build_backend};
#[cfg(feature = "storage-s3")]
pub use backend::{S3Storage, SigV4Headers, presign_v4_get, sign_v4_request};
pub use gc::{OrphanCandidate, OrphanSweepReport, OrphanSweeper};
pub use guard::{CasError, extract_sha256_tokens, is_sha256_hex, normalize_key, normalize_prefix, safe_join, verify_expected_hash, verify_file_cas_async};
#[cfg(feature = "storage-fs")]
pub use staging::{StageError, StageLimits, StagedFile, StagingArea};
