//! Strongly-typed [`StorageConfig`] parsed once at startup from
//! `VIBEVALLEY_STORAGE_URL` / `--storage-url` (or defaulting to local `<home>`).

use std::path::{Path, PathBuf};

use url::Url;

use super::{StorageError, StorageKind, normalize_key};
use crate::setting::Secret;

/// Environment variable selecting a pluggable storage backend.
pub const ENV_STORAGE_URL: &str = "VIBEVALLEY_STORAGE_URL";
/// S3 access key ID environment variable (falls back to `AWS_ACCESS_KEY_ID`).
pub const ENV_S3_ACCESS_KEY_ID: &str = "VIBEVALLEY_S3_ACCESS_KEY_ID";
/// S3 secret access key environment variable (falls back to `AWS_SECRET_ACCESS_KEY`).
pub const ENV_S3_SECRET_ACCESS_KEY: &str = "VIBEVALLEY_S3_SECRET_ACCESS_KEY";
/// Optional S3 region override (falls back to `AWS_REGION` / `AWS_DEFAULT_REGION` / `us-east-1`).
pub const ENV_S3_REGION: &str = "VIBEVALLEY_S3_REGION";
/// Optional S3 custom endpoint URL override (e.g. Cloudflare R2, MinIO, RustFS, LocalStack).
pub const ENV_S3_ENDPOINT: &str = "VIBEVALLEY_S3_ENDPOINT";

/// S3-compatible object storage configuration.
///
/// `secret_access_key` is wrapped in [`Secret`] so derived [`std::fmt::Debug`]
/// never exposes the raw credential in logs or panic messages.
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

    /// Reads [`ENV_STORAGE_URL`] and related `VIBEVALLEY_S3_*` variables, defaulting
    /// to `LocalFs { root: home }` when `VIBEVALLEY_STORAGE_URL` is unset or empty.
    pub fn from_env(home: &Path) -> Result<Self, StorageError> {
        Self::from_url_override(None, home)
    }

    /// Parses an explicit CLI/config URL override if provided, otherwise falls back to
    /// [`ENV_STORAGE_URL`], and finally defaults to `LocalFs { root: home }`.
    pub fn from_url_override(url_override: Option<&str>, home: &Path) -> Result<Self, StorageError> {
        let env_lookup = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let raw = url_override
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .or_else(|| env_lookup(ENV_STORAGE_URL));
        match raw {
            Some(url) => Self::parse_url(&url, env_lookup),
            None => Ok(Self::LocalFs { root: home.to_path_buf() }),
        }
    }

    /// Pure parser for a storage URL (`file:///...`, `s3://...`, `memory://`) with an injected
    /// environment lookup so tests can verify every combination without mutating process env.
    pub fn parse_url<F>(raw: &str, env: F) -> Result<Self, StorageError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(StorageError::Config("storage URL must not be empty".into()));
        }
        let parsed = Url::parse(trimmed).map_err(|e| StorageError::Config(format!("invalid storage URL `{trimmed}`: {e}")))?;
        match parsed.scheme() {
            "file" => {
                let root = parsed
                    .to_file_path()
                    .map_err(|()| StorageError::Config(format!("file:// storage URL must be an absolute local path: `{trimmed}`")))?;
                Ok(Self::LocalFs { root })
            }
            "memory" => Ok(Self::Memory),
            "s3" => parse_s3_url(trimmed, &parsed, env).map(Self::S3),
            other => Err(StorageError::Config(format!(
                "unsupported storage URL scheme `{other}` (expected `file://`, `s3://`, or `memory://`)"
            ))),
        }
    }
}

fn parse_bool_param(name: &str, value: &str) -> Result<bool, StorageError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        other => Err(StorageError::Config(format!("invalid boolean for `{name}`: `{other}`"))),
    }
}

fn parse_s3_url<F>(raw: &str, url: &Url, env: F) -> Result<S3Config, StorageError>
where
    F: Fn(&str) -> Option<String>,
{
    if url.password().is_some() || !url.username().is_empty() {
        return Err(StorageError::Config(format!(
            "do not embed S3 credentials in the URL; set `{ENV_S3_ACCESS_KEY_ID}` and `{ENV_S3_SECRET_ACCESS_KEY}` instead"
        )));
    }
    // Check raw path before WHATWG URL normalization collapses dot segments like `..`.
    let raw_without_scheme = raw.split_once("://").map_or("", |(_, rest)| rest);
    let raw_before_query = raw_without_scheme.split(['?', '#']).next().unwrap_or("");
    if let Some((_, raw_path)) = raw_before_query.split_once('/') {
        let trimmed_raw = raw_path.trim_matches('/');
        if !trimmed_raw.is_empty() {
            normalize_key(trimmed_raw).map_err(|e| StorageError::Config(format!("invalid s3 prefix `{trimmed_raw}`: {e}")))?;
        }
    }
    let bucket = url
        .host_str()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .ok_or_else(|| StorageError::Config("s3:// URL must specify a bucket name (e.g. `s3://my-bucket`)".into()))?
        .to_owned();

    let raw_prefix = url.path().trim_matches('/');
    let prefix = if raw_prefix.is_empty() {
        None
    } else {
        Some(normalize_key(raw_prefix).map_err(|e| StorageError::Config(format!("invalid s3 prefix `{raw_prefix}`: {e}")))?)
    };

    let mut endpoint: Option<String> = None;
    let mut region: Option<String> = None;
    let mut path_style: Option<bool> = None;

    for (k, v) in url.query_pairs() {
        let key = k.as_ref();
        let val = v.trim();
        match key {
            "endpoint" => {
                if !val.is_empty() {
                    endpoint = Some(val.to_owned());
                }
            }
            "region" => {
                if !val.is_empty() {
                    region = Some(val.to_owned());
                }
            }
            "path_style" | "pathStyle" => {
                path_style = Some(parse_bool_param(key, val)?);
            }
            other => {
                return Err(StorageError::Config(format!("unknown s3:// query parameter `{other}`")));
            }
        }
    }

    let endpoint = endpoint.or_else(|| env(ENV_S3_ENDPOINT));
    if let Some(ep) = &endpoint {
        let ep_url = Url::parse(ep).map_err(|e| StorageError::Config(format!("invalid S3 endpoint URL `{ep}`: {e}")))?;
        if !matches!(ep_url.scheme(), "http" | "https") || ep_url.host_str().is_none() {
            return Err(StorageError::Config(format!("S3 endpoint must be an http:// or https:// URL: `{ep}`")));
        }
    }

    let region = region
        .or_else(|| env(ENV_S3_REGION))
        .or_else(|| env("AWS_REGION"))
        .or_else(|| env("AWS_DEFAULT_REGION"))
        .unwrap_or_else(|| "us-east-1".to_owned());

    let access_key_id = env(ENV_S3_ACCESS_KEY_ID)
        .or_else(|| env("AWS_ACCESS_KEY_ID"))
        .ok_or_else(|| StorageError::Config(format!("missing S3 access key ID (set `{ENV_S3_ACCESS_KEY_ID}` or `AWS_ACCESS_KEY_ID`)")))?;
    let secret_raw = env(ENV_S3_SECRET_ACCESS_KEY).or_else(|| env("AWS_SECRET_ACCESS_KEY")).ok_or_else(|| {
        StorageError::Config(format!(
            "missing S3 secret access key (set `{ENV_S3_SECRET_ACCESS_KEY}` or `AWS_SECRET_ACCESS_KEY`)"
        ))
    })?;

    // Custom endpoints (MinIO / R2 / RustFS / LocalStack) default to path-style unless overridden.
    let path_style = path_style.unwrap_or(endpoint.is_some());

    Ok(S3Config {
        bucket,
        region,
        endpoint,
        prefix,
        path_style,
        access_key_id,
        secret_access_key: Secret::new(secret_raw),
    })
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
    fn parses_file_and_memory_urls() {
        let local = StorageConfig::parse_url("file:///tmp/vv-store", |_| None).unwrap();
        assert_eq!(
            local,
            StorageConfig::LocalFs {
                root: PathBuf::from("/tmp/vv-store")
            }
        );
        assert_eq!(local.kind(), StorageKind::LocalFs);

        let mem = StorageConfig::parse_url("memory://", |_| None).unwrap();
        assert_eq!(mem, StorageConfig::Memory);
        assert_eq!(mem.kind(), StorageKind::Memory);
    }

    #[test]
    fn parses_s3_url_with_custom_endpoint_prefix_and_redacts_secret_in_debug() {
        let env = map_env(&[(ENV_S3_ACCESS_KEY_ID, "AKIA_TEST_KEY"), (ENV_S3_SECRET_ACCESS_KEY, "super-secret-value-9999")]);
        let cfg = StorageConfig::parse_url(
            "s3://farm-assets/prod/v1?endpoint=https%3A%2F%2Fr2.example.com&region=auto&path_style=true",
            env,
        )
        .unwrap();

        let StorageConfig::S3(s3) = &cfg else {
            panic!("expected S3 config");
        };
        assert_eq!(s3.bucket, "farm-assets");
        assert_eq!(s3.prefix.as_deref(), Some("prod/v1"));
        assert_eq!(s3.endpoint.as_deref(), Some("https://r2.example.com"));
        assert_eq!(s3.region, "auto");
        assert!(s3.path_style);
        assert_eq!(s3.access_key_id, "AKIA_TEST_KEY");
        assert_eq!(s3.secret_access_key.expose(), "super-secret-value-9999");

        let debug = format!("{cfg:?}");
        assert!(!debug.contains("super-secret-value-9999"), "Debug leaked secret: {debug}");
        assert!(debug.contains("Secret(…9999)"), "Debug should show redacted hint: {debug}");
    }

    #[test]
    fn s3_url_defaults_region_and_path_style_and_rejects_bad_inputs() {
        let env = map_env(&[("AWS_ACCESS_KEY_ID", "ak"), ("AWS_SECRET_ACCESS_KEY", "sk")]);
        let cfg = StorageConfig::parse_url("s3://my-bucket", env).unwrap();
        let StorageConfig::S3(s3) = cfg else { panic!("expected S3") };
        assert_eq!(s3.region, "us-east-1");
        assert!(!s3.path_style);
        assert!(s3.endpoint.is_none());
        assert!(s3.prefix.is_none());

        // Missing credentials fail fast.
        assert!(StorageConfig::parse_url("s3://my-bucket", |_| None).is_err());
        // Embedded credentials in URL are rejected.
        assert!(StorageConfig::parse_url("s3://ak:sk@my-bucket", |_| None).is_err());
        // Unknown scheme rejected.
        assert!(StorageConfig::parse_url("gcs://my-bucket", |_| None).is_err());
        // Unknown query parameter rejected.
        let env2 = map_env(&[("AWS_ACCESS_KEY_ID", "ak"), ("AWS_SECRET_ACCESS_KEY", "sk")]);
        assert!(StorageConfig::parse_url("s3://my-bucket?bogus=1", env2).is_err());
        // Traversal in prefix rejected.
        let env3 = map_env(&[("AWS_ACCESS_KEY_ID", "ak"), ("AWS_SECRET_ACCESS_KEY", "sk")]);
        assert!(StorageConfig::parse_url("s3://my-bucket/a/../b", env3).is_err());
    }
}
