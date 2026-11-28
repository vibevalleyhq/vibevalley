//! Server storage configuration adapter delegating URL parsing & validation to
//! `vibevalley_kit::storage::StorageConfig` while preserving `crate::setting::Secret`.

use std::path::{Path, PathBuf};

use vibevalley_kit::storage::backend as kit_backend;

use super::{StorageError, StorageKind};
use crate::setting::Secret;

pub use kit_backend::{ENV_S3_ACCESS_KEY_ID, ENV_S3_ENDPOINT, ENV_S3_REGION, ENV_S3_SECRET_ACCESS_KEY, ENV_STORAGE_URL};

/// S3-compatible object storage configuration using server's redacted [`Secret`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S3Config {
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub prefix: Option<String>,
    pub path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: Secret,
}

impl S3Config {
    pub(crate) fn to_kit(&self) -> kit_backend::S3Config {
        kit_backend::S3Config {
            bucket: self.bucket.clone(),
            region: self.region.clone(),
            endpoint: self.endpoint.clone(),
            prefix: self.prefix.clone(),
            path_style: self.path_style,
            access_key_id: self.access_key_id.clone(),
            secret_access_key: vibevalley_kit::core::Secret::new(self.secret_access_key.expose()),
        }
    }

    fn from_kit(cfg: kit_backend::S3Config) -> Self {
        Self {
            bucket: cfg.bucket,
            region: cfg.region,
            endpoint: cfg.endpoint,
            prefix: cfg.prefix,
            path_style: cfg.path_style,
            access_key_id: cfg.access_key_id,
            secret_access_key: Secret::new(cfg.secret_access_key.expose()),
        }
    }
}

/// Top-level pluggable storage backend configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageConfig {
    LocalFs { root: PathBuf },
    S3(S3Config),
    Memory,
}

impl StorageConfig {
    pub fn kind(&self) -> StorageKind {
        match self {
            Self::LocalFs { .. } => StorageKind::LocalFs,
            Self::S3(_) => StorageKind::S3,
            Self::Memory => StorageKind::Memory,
        }
    }

    pub(crate) fn to_kit(&self) -> kit_backend::StorageConfig {
        match self {
            Self::LocalFs { root } => kit_backend::StorageConfig::LocalFs { root: root.clone() },
            Self::S3(s3) => kit_backend::StorageConfig::S3(s3.to_kit()),
            Self::Memory => kit_backend::StorageConfig::Memory,
        }
    }

    fn from_kit(cfg: kit_backend::StorageConfig) -> Self {
        match cfg {
            kit_backend::StorageConfig::LocalFs { root } => Self::LocalFs { root },
            kit_backend::StorageConfig::S3(s3) => Self::S3(S3Config::from_kit(s3)),
            kit_backend::StorageConfig::Memory => Self::Memory,
        }
    }

    pub fn from_env(home: &Path) -> Result<Self, StorageError> {
        kit_backend::StorageConfig::from_env(home).map(Self::from_kit)
    }

    pub fn from_url_override(url_override: Option<&str>, home: &Path) -> Result<Self, StorageError> {
        kit_backend::StorageConfig::from_url_override(url_override, home).map(Self::from_kit)
    }

    pub fn parse_url<F>(raw: &str, env: F) -> Result<Self, StorageError>
    where
        F: Fn(&str) -> Option<String>,
    {
        kit_backend::StorageConfig::parse_url(raw, env).map(Self::from_kit)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn map_env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn parses_file_memory_and_s3_urls_via_kit_config() {
        let local = StorageConfig::parse_url("file:///tmp/vv-store", |_| None).unwrap();
        assert_eq!(local.kind(), StorageKind::LocalFs);
        let mem = StorageConfig::parse_url("memory://", |_| None).unwrap();
        assert_eq!(mem, StorageConfig::Memory);

        let env = map_env(&[(ENV_S3_ACCESS_KEY_ID, "AKIA_TEST"), (ENV_S3_SECRET_ACCESS_KEY, "super-secret-value-9999")]);
        let cfg = StorageConfig::parse_url("s3://farm-assets/prod/v1?endpoint=https%3A%2F%2Fr2.example.com&region=auto", env).unwrap();
        let dbg = format!("{cfg:?}");
        assert!(!dbg.contains("super-secret-value-9999"));
        assert!(dbg.contains("Secret(…9999)"));
    }
}
