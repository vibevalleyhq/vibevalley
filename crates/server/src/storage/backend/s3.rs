//! Thin S3-compatible [`StorageBackend`] adapter delegating SigV4 signing, XML parsing,
//! retries, and HTTP I/O to `vibevalley_kit::storage::S3Storage`.

use std::path::PathBuf;

use jiff::Timestamp;
pub use vibevalley_kit::storage::SigV4Headers;
use vibevalley_kit::storage::backend::s3 as kit_s3;

use super::config::S3Config;
use super::{ObjectMeta, StorageBackend, StorageError, StorageKind};
use crate::BoxFuture;
use crate::setting::Secret;

/// Signs an S3 HTTP request using AWS Signature Version 4 (delegates to `vibevalley_kit::storage`).
#[allow(clippy::too_many_arguments)]
pub fn sign_v4_request(
    method: &str,
    canonical_uri: &str,
    query_params: &[(String, String)],
    host: &str,
    extra_headers: &[(&str, &str)],
    payload_sha256: &str,
    access_key_id: &str,
    secret_access_key: &Secret,
    region: &str,
    timestamp: Timestamp,
) -> SigV4Headers {
    let kit_secret = vibevalley_kit::core::Secret::new(secret_access_key.expose());
    kit_s3::sign_v4_request(
        method,
        canonical_uri,
        query_params,
        host,
        extra_headers,
        payload_sha256,
        access_key_id,
        &kit_secret,
        region,
        timestamp,
    )
}

/// Generates an AWS SigV4 presigned `GET` URL (delegates to `vibevalley_kit::storage`).
#[allow(clippy::too_many_arguments)]
pub fn presign_v4_get(
    scheme: &str,
    host: &str,
    canonical_uri: &str,
    access_key_id: &str,
    secret_access_key: &Secret,
    region: &str,
    timestamp: Timestamp,
    expires_secs: u64,
) -> String {
    let kit_secret = vibevalley_kit::core::Secret::new(secret_access_key.expose());
    kit_s3::presign_v4_get(scheme, host, canonical_uri, access_key_id, &kit_secret, region, timestamp, expires_secs)
}

/// S3-compatible [`StorageBackend`] delegating directly to [`kit_s3::S3Storage`].
#[derive(Debug)]
pub struct S3Backend {
    inner: kit_s3::S3Storage,
}

impl S3Backend {
    pub fn new(config: S3Config) -> Result<Self, StorageError> {
        Ok(Self {
            inner: kit_s3::S3Storage::new(config.to_kit())?,
        })
    }
}

impl StorageBackend for S3Backend {
    fn kind(&self) -> StorageKind {
        self.inner.kind()
    }

    fn put<'a>(&'a self, key: &'a str, bytes: Vec<u8>, content_type: Option<&'a str>) -> BoxFuture<'a, Result<ObjectMeta, StorageError>> {
        self.inner.put(key, bytes, content_type)
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>, StorageError>> {
        self.inner.get(key)
    }

    fn head<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<ObjectMeta>, StorageError>> {
        self.inner.head(key)
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>> {
        self.inner.delete(key)
    }

    fn list<'a>(&'a self, prefix: &'a str) -> BoxFuture<'a, Result<Vec<ObjectMeta>, StorageError>> {
        self.inner.list(prefix)
    }

    fn exists<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>> {
        self.inner.exists(key)
    }

    fn local_path(&self, key: &str) -> Option<PathBuf> {
        self.inner.local_path(key)
    }

    fn signed_url(&self, key: &str, expires_secs: u64) -> Option<String> {
        self.inner.signed_url(key, expires_secs)
    }
}
