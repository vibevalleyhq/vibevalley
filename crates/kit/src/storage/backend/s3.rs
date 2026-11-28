//! S3-compatible object [`StorageBackend`] supporting AWS S3, Cloudflare R2,
//! MinIO, RustFS, and LocalStack using pure AWS SigV4 (HMAC-SHA256 over `sha2`)
//! and `reqwest`.

use std::collections::HashSet;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use reqwest::{Method, StatusCode};
use sha2::Sha256;
use url::Url;

use super::config::S3Config;
use super::{BoxFuture, ObjectMeta, StorageBackend, StorageError, StorageKind};
use crate::core::secret::sha256_hex;
use crate::core::time::{SharedClock, system_clock};
use crate::core::{RetryPolicy, Secret};
use crate::storage::guard::{normalize_key, normalize_prefix};

const AWS_ALGORITHM: &str = "AWS4-HMAC-SHA256";
const AWS_SERVICE: &str = "s3";
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_PRESIGN_EXPIRES_SECS: u64 = 7 * 24 * 60 * 60;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_MAX_RETRIES: usize = 3;
const DEFAULT_RETRY_MIN_DELAY: Duration = Duration::from_millis(100);
const DEFAULT_RETRY_MAX_DELAY: Duration = Duration::from_secs(2);
const MAX_LIST_PAGES: usize = 10_000;

const S3_ENCODE_SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
const S3_PATH_ENCODE_SET: &percent_encoding::AsciiSet = &S3_ENCODE_SET.remove(b'/');

/// Computes RFC 2104 HMAC-SHA256 using `hmac::Hmac<Sha256>`.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// RFC 3986 percent-encoding following AWS SigV4 rules (uppercase hex).
pub fn uri_encode(input: &str, encode_slash: bool) -> String {
    let set = if encode_slash { S3_ENCODE_SET } else { S3_PATH_ENCODE_SET };
    percent_encoding::utf8_percent_encode(input, set).to_string()
}

fn format_amz_timestamps(ts: Timestamp) -> (String, String) {
    let utc = ts.to_zoned_datetime(TimeZone::UTC);
    let amz_date = utc.strftime("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = utc.strftime("%Y%m%d").to_string();
    (amz_date, date_stamp)
}

fn canonical_query_string(params: &[(String, String)]) -> String {
    let mut encoded: Vec<(String, String)> = params.iter().map(|(k, v)| (uri_encode(k, true), uri_encode(v, true))).collect();
    encoded.sort();
    encoded.into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
}

fn derive_signing_key(secret: &Secret, date_stamp: &str, region: &str) -> [u8; 32] {
    let mut initial = Vec::with_capacity(4 + secret.expose().len());
    initial.extend_from_slice(b"AWS4");
    initial.extend_from_slice(secret.expose().as_bytes());
    let k_date = hmac_sha256(&initial, date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, AWS_SERVICE.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

/// Output of [`sign_v4_request`]: ready-to-attach SigV4 HTTP headers plus canonical parts for auditing/tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigV4Headers {
    pub authorization: String,
    pub x_amz_date: String,
    pub x_amz_content_sha256: String,
    pub canonical_request: String,
    pub string_to_sign: String,
    pub signature: String,
}

/// Signs an S3 HTTP request using AWS Signature Version 4 (header authentication).
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
    let (amz_date, date_stamp) = format_amz_timestamps(timestamp);
    let canonical_query = canonical_query_string(query_params);

    let mut headers: Vec<(String, String)> = Vec::with_capacity(3 + extra_headers.len());
    headers.push(("host".to_owned(), host.trim().to_owned()));
    headers.push(("x-amz-content-sha256".to_owned(), payload_sha256.to_owned()));
    headers.push(("x-amz-date".to_owned(), amz_date.clone()));
    for &(name, value) in extra_headers {
        let lower = name.trim().to_ascii_lowercase();
        if !matches!(lower.as_str(), "host" | "x-amz-content-sha256" | "x-amz-date") {
            headers.push((lower, value.trim().to_owned()));
        }
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let mut canonical_headers = String::new();
    let mut signed_header_names = Vec::with_capacity(headers.len());
    for (k, v) in &headers {
        canonical_headers.push_str(k);
        canonical_headers.push(':');
        canonical_headers.push_str(v);
        canonical_headers.push('\n');
        signed_header_names.push(k.as_str());
    }
    let signed_headers = signed_header_names.join(";");

    let canonical_request = format!("{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_sha256}");
    let scope = format!("{date_stamp}/{region}/{AWS_SERVICE}/aws4_request");
    let string_to_sign = format!("{AWS_ALGORITHM}\n{amz_date}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));

    let signing_key = derive_signing_key(secret_access_key, &date_stamp, region);
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    let authorization = format!("{AWS_ALGORITHM} Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}");

    SigV4Headers {
        authorization,
        x_amz_date: amz_date,
        x_amz_content_sha256: payload_sha256.to_owned(),
        canonical_request,
        string_to_sign,
        signature,
    }
}

/// Generates an AWS SigV4 presigned `GET` URL using query-string authentication.
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
    let expires = expires_secs.clamp(1, MAX_PRESIGN_EXPIRES_SECS);
    let (amz_date, date_stamp) = format_amz_timestamps(timestamp);
    let scope = format!("{date_stamp}/{region}/{AWS_SERVICE}/aws4_request");
    let credential = format!("{access_key_id}/{scope}");

    let query_params = vec![
        ("X-Amz-Algorithm".to_owned(), AWS_ALGORITHM.to_owned()),
        ("X-Amz-Credential".to_owned(), credential),
        ("X-Amz-Date".to_owned(), amz_date.clone()),
        ("X-Amz-Expires".to_owned(), expires.to_string()),
        ("X-Amz-SignedHeaders".to_owned(), "host".to_owned()),
    ];
    let canonical_query = canonical_query_string(&query_params);
    let canonical_headers = format!("host:{host}\n");
    let canonical_request = format!("GET\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\nhost\n{UNSIGNED_PAYLOAD}");
    let string_to_sign = format!("{AWS_ALGORITHM}\n{amz_date}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));

    let signing_key = derive_signing_key(secret_access_key, &date_stamp, region);
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    format!("{scheme}://{host}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}")
}

#[derive(Debug, Clone)]
struct EndpointSpec {
    scheme: String,
    host: String,
    base_path: String,
}

impl EndpointSpec {
    fn from_config(cfg: &S3Config) -> Result<Self, StorageError> {
        if let Some(ep) = &cfg.endpoint {
            let parsed = Url::parse(ep).map_err(|e| StorageError::Config(format!("invalid S3 endpoint `{ep}`: {e}")))?;
            let scheme = parsed.scheme().to_owned();
            if !matches!(scheme.as_str(), "http" | "https") {
                return Err(StorageError::Config(format!("S3 endpoint must use http or https: `{ep}`")));
            }
            let raw_host = parsed
                .host_str()
                .ok_or_else(|| StorageError::Config(format!("S3 endpoint missing host: `{ep}`")))?;
            let base_host = if cfg.path_style {
                raw_host.to_owned()
            } else {
                format!("{}.{raw_host}", cfg.bucket)
            };
            let host = match parsed.port() {
                Some(port) => format!("{base_host}:{port}"),
                None => base_host,
            };
            let base_path = parsed.path().trim_end_matches('/').to_owned();
            Ok(Self { scheme, host, base_path })
        } else {
            let host = if cfg.path_style {
                format!("s3.{}.amazonaws.com", cfg.region)
            } else {
                format!("{}.s3.{}.amazonaws.com", cfg.bucket, cfg.region)
            };
            Ok(Self {
                scheme: "https".to_owned(),
                host,
                base_path: String::new(),
            })
        }
    }

    fn object_uri(&self, cfg: &S3Config, full_key: &str) -> String {
        let enc_key = uri_encode(full_key, false);
        if cfg.path_style {
            let enc_bucket = uri_encode(&cfg.bucket, true);
            format!("{}/{enc_bucket}/{enc_key}", self.base_path)
        } else {
            format!("{}/{enc_key}", self.base_path)
        }
    }

    fn bucket_uri(&self, cfg: &S3Config) -> String {
        if cfg.path_style {
            let enc_bucket = uri_encode(&cfg.bucket, true);
            format!("{}/{enc_bucket}", self.base_path)
        } else if self.base_path.is_empty() {
            "/".to_owned()
        } else {
            format!("{}/", self.base_path)
        }
    }

    fn full_url(&self, canonical_uri: &str, query_params: &[(String, String)]) -> String {
        let base = format!("{}://{}{}", self.scheme, self.host, canonical_uri);
        if query_params.is_empty() {
            base
        } else {
            format!("{base}?{}", canonical_query_string(query_params))
        }
    }
}

/// S3-compatible [`StorageBackend`] (AWS S3, Cloudflare R2, MinIO, RustFS, LocalStack).
pub struct S3Storage {
    config: S3Config,
    endpoint: EndpointSpec,
    client: reqwest::Client,
    clock: SharedClock,
    retry_policy: RetryPolicy,
    max_list_pages: usize,
}

impl fmt::Debug for S3Storage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Storage")
            .field("config", &self.config)
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl S3Storage {
    pub fn new(config: S3Config) -> Result<Self, StorageError> {
        if config.bucket.trim().is_empty() {
            return Err(StorageError::Config("S3 bucket must not be empty".into()));
        }
        if config.region.trim().is_empty() {
            return Err(StorageError::Config("S3 region must not be empty".into()));
        }
        if config.access_key_id.trim().is_empty() || config.secret_access_key.is_empty() {
            return Err(StorageError::Config("S3 credentials must not be empty".into()));
        }
        let endpoint = EndpointSpec::from_config(&config)?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| StorageError::Transport(format!("failed to build S3 HTTP client: {e}")))?;
        Ok(Self {
            config,
            endpoint,
            client,
            clock: system_clock(),
            retry_policy: RetryPolicy::new(DEFAULT_MAX_RETRIES, DEFAULT_RETRY_MIN_DELAY, DEFAULT_RETRY_MAX_DELAY),
            max_list_pages: MAX_LIST_PAGES,
        })
    }

    pub fn with_retry_and_page_limits(mut self, retry_min_delay: Duration, retry_max_delay: Duration, max_retries: usize, max_list_pages: usize) -> Self {
        self.retry_policy = RetryPolicy::new(max_retries, retry_min_delay, retry_max_delay);
        self.max_list_pages = max_list_pages;
        self
    }

    pub fn config(&self) -> &S3Config {
        &self.config
    }

    fn prefixed_key(&self, normalized_key: &str) -> String {
        match &self.config.prefix {
            Some(prefix) if !prefix.is_empty() => format!("{prefix}/{normalized_key}"),
            _ => normalized_key.to_owned(),
        }
    }

    fn prefixed_list_prefix(&self, normalized_prefix: &str) -> String {
        match &self.config.prefix {
            Some(prefix) if !prefix.is_empty() => {
                if normalized_prefix.is_empty() {
                    format!("{prefix}/")
                } else {
                    format!("{prefix}/{normalized_prefix}")
                }
            }
            _ => normalized_prefix.to_owned(),
        }
    }

    async fn send_signed(
        &self,
        method: Method,
        canonical_uri: &str,
        query_params: &[(String, String)],
        extra_headers: &[(&str, &str)],
        body: Vec<u8>,
    ) -> Result<reqwest::Response, StorageError> {
        let payload_hash = if body.is_empty() { EMPTY_SHA256.to_owned() } else { sha256_hex(&body) };
        let url = self.endpoint.full_url(canonical_uri, query_params);
        let mut backoff = self.retry_policy.backoff();

        loop {
            let signed = sign_v4_request(
                method.as_str(),
                canonical_uri,
                query_params,
                &self.endpoint.host,
                extra_headers,
                &payload_hash,
                &self.config.access_key_id,
                &self.config.secret_access_key,
                &self.config.region,
                Timestamp::now(),
            );
            let mut req = self
                .client
                .request(method.clone(), &url)
                .header("host", &self.endpoint.host)
                .header("x-amz-date", &signed.x_amz_date)
                .header("x-amz-content-sha256", &signed.x_amz_content_sha256)
                .header("authorization", &signed.authorization);
            for &(name, value) in extra_headers {
                req = req.header(name, value);
            }
            if !body.is_empty() {
                req = req.body(body.clone());
            }

            match req.send().await {
                Ok(resp) if is_transient_status(resp.status()) => {
                    let Some(delay) = backoff.next() else {
                        return Ok(resp);
                    };
                    tokio::time::sleep(delay).await;
                }
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    let Some(delay) = backoff.next() else {
                        return Err(StorageError::Transport(err.to_string()));
                    };
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
}

fn is_transient_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

fn clean_etag(raw: &str) -> String {
    raw.trim().trim_matches('"').to_owned()
}

fn header_str(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.trim().to_owned())
}

async fn http_error(resp: reqwest::Response) -> StorageError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let summary = extract_xml_tag(&body, "Message")
        .or_else(|| extract_xml_tag(&body, "Code"))
        .unwrap_or_else(|| body.chars().take(240).collect());
    StorageError::Http { status, message: summary }
}

impl StorageBackend for S3Storage {
    fn kind(&self) -> StorageKind {
        StorageKind::S3
    }

    fn put<'a>(&'a self, key: &'a str, bytes: Vec<u8>, content_type: Option<&'a str>) -> BoxFuture<'a, Result<ObjectMeta, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            let full_key = self.prefixed_key(&norm);
            let uri = self.endpoint.object_uri(&self.config, &full_key);
            let size = bytes.len() as u64;
            let ct = content_type.unwrap_or("application/octet-stream");
            let fallback_etag = sha256_hex(&bytes);
            let resp = self.send_signed(Method::PUT, &uri, &[], &[("content-type", ct)], bytes).await?;
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }
            let etag = header_str(resp.headers(), "etag")
                .map(|e| clean_etag(&e))
                .filter(|e| !e.is_empty())
                .unwrap_or(fallback_etag);
            Ok(ObjectMeta {
                key: norm,
                size,
                content_type: Some(ct.to_owned()),
                etag: Some(etag),
                last_modified_ms: Some(self.clock.now_ms()),
            })
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<Vec<u8>>, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            let full_key = self.prefixed_key(&norm);
            let uri = self.endpoint.object_uri(&self.config, &full_key);
            let resp = self.send_signed(Method::GET, &uri, &[], &[], Vec::new()).await?;
            if resp.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }
            let bytes = resp.bytes().await.map_err(|e| StorageError::Transport(e.to_string()))?;
            Ok(Some(bytes.to_vec()))
        })
    }

    fn head<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<ObjectMeta>, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            let full_key = self.prefixed_key(&norm);
            let uri = self.endpoint.object_uri(&self.config, &full_key);
            let resp = self.send_signed(Method::HEAD, &uri, &[], &[], Vec::new()).await?;
            if resp.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }
            let headers = resp.headers();
            let size = header_str(headers, "content-length").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let content_type = header_str(headers, "content-type");
            let etag = header_str(headers, "etag").map(|e| clean_etag(&e)).filter(|e| !e.is_empty());
            let last_modified_ms = header_str(headers, "last-modified").and_then(|s| parse_http_or_iso_timestamp(&s));
            Ok(Some(ObjectMeta {
                key: norm,
                size,
                content_type,
                etag,
                last_modified_ms,
            }))
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, StorageError>> {
        Box::pin(async move {
            let norm = normalize_key(key)?;
            let full_key = self.prefixed_key(&norm);
            let uri = self.endpoint.object_uri(&self.config, &full_key);
            let resp = self.send_signed(Method::DELETE, &uri, &[], &[], Vec::new()).await?;
            if resp.status() == StatusCode::NOT_FOUND {
                return Ok(false);
            }
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }
            Ok(true)
        })
    }

    fn list<'a>(&'a self, prefix: &'a str) -> BoxFuture<'a, Result<Vec<ObjectMeta>, StorageError>> {
        Box::pin(async move {
            let norm_prefix = normalize_prefix(prefix)?;
            let full_prefix = self.prefixed_list_prefix(&norm_prefix);
            let strip_prefix = self.config.prefix.as_deref().map(|p| format!("{p}/"));
            let uri = self.endpoint.bucket_uri(&self.config);

            let mut out = Vec::new();
            let mut continuation_token: Option<String> = None;
            let mut seen_tokens = HashSet::new();
            let mut pages = 0usize;

            loop {
                pages += 1;
                if pages > self.max_list_pages {
                    return Err(StorageError::Protocol(format!(
                        "S3 ListObjectsV2 exceeded maximum page limit ({})",
                        self.max_list_pages
                    )));
                }
                let mut params = vec![("list-type".to_owned(), "2".to_owned())];
                if !full_prefix.is_empty() {
                    params.push(("prefix".to_owned(), full_prefix.clone()));
                }
                if let Some(token) = &continuation_token {
                    params.push(("continuation-token".to_owned(), token.clone()));
                }
                let resp = self.send_signed(Method::GET, &uri, &params, &[], Vec::new()).await?;
                if !resp.status().is_success() {
                    return Err(http_error(resp).await);
                }
                let xml = resp.text().await.map_err(|e| StorageError::Transport(e.to_string()))?;
                let page = parse_list_objects_v2_xml(&xml, strip_prefix.as_deref())?;
                out.extend(page.objects);
                if page.is_truncated {
                    match page.next_continuation_token {
                        Some(next) if !next.is_empty() => {
                            if !seen_tokens.insert(next.clone()) {
                                return Err(StorageError::Protocol(format!("S3 ListObjectsV2 repeated continuation token `{next}`")));
                            }
                            continuation_token = Some(next);
                        }
                        _ => break,
                    }
                } else {
                    break;
                }
            }
            out.sort_by(|a, b| a.key.cmp(&b.key));
            Ok(out)
        })
    }

    fn local_path(&self, _key: &str) -> Option<PathBuf> {
        None
    }

    fn signed_url(&self, key: &str, expires_secs: u64) -> Option<String> {
        let norm = normalize_key(key).ok()?;
        let full_key = self.prefixed_key(&norm);
        let uri = self.endpoint.object_uri(&self.config, &full_key);
        Some(presign_v4_get(
            &self.endpoint.scheme,
            &self.endpoint.host,
            &uri,
            &self.config.access_key_id,
            &self.config.secret_access_key,
            &self.config.region,
            Timestamp::now(),
            expires_secs,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListObjectsV2Page {
    pub objects: Vec<ObjectMeta>,
    pub is_truncated: bool,
    pub next_continuation_token: Option<String>,
}

fn xml_node_text(node: roxmltree::Node<'_, '_>) -> String {
    node.descendants().filter(|n| n.is_text()).filter_map(|n| n.text()).collect()
}

fn find_xml_tag_text(root: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    root.descendants().find(|n| n.is_element() && n.tag_name().name() == tag).map(xml_node_text)
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    find_xml_tag_text(doc.root(), tag)
}

fn parse_http_or_iso_timestamp(raw: &str) -> Option<i64> {
    if let Ok(ts) = raw.trim().parse::<Timestamp>() {
        return Some(ts.as_millisecond());
    }
    jiff::fmt::rfc2822::parse(raw.trim()).ok().map(|zdt| zdt.timestamp().as_millisecond())
}

pub fn parse_list_objects_v2_xml(xml: &str, strip_prefix: Option<&str>) -> Result<ListObjectsV2Page, StorageError> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| StorageError::Protocol(format!("invalid S3 XML response: {e}")))?;
    let root = doc.root();
    let is_truncated = find_xml_tag_text(root, "IsTruncated").is_some_and(|s| s.eq_ignore_ascii_case("true"));
    let next_continuation_token = find_xml_tag_text(root, "NextContinuationToken").filter(|s| !s.is_empty());

    let mut objects = Vec::new();
    for block in root.descendants().filter(|n| n.is_element() && n.tag_name().name() == "Contents") {
        let Some(raw_key) = find_xml_tag_text(block, "Key") else {
            continue;
        };
        let logical_key = match strip_prefix {
            Some(prefix) => match raw_key.strip_prefix(prefix) {
                Some(rest) if !rest.is_empty() => rest.to_owned(),
                _ => continue,
            },
            None => raw_key,
        };
        let size = find_xml_tag_text(block, "Size").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let etag = find_xml_tag_text(block, "ETag").map(|e| clean_etag(&e)).filter(|e| !e.is_empty());
        let last_modified_ms = find_xml_tag_text(block, "LastModified").and_then(|s| parse_http_or_iso_timestamp(&s));

        objects.push(ObjectMeta {
            key: logical_key,
            size,
            content_type: None,
            etag,
            last_modified_ms,
        });
    }

    Ok(ListObjectsV2Page {
        objects,
        is_truncated,
        next_continuation_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_matches_rfc4231_test_vector_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(hex::encode(mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn sigv4_get_object_matches_official_aws_test_vector() {
        let ts: Timestamp = "2013-05-24T00:00:00Z".parse().unwrap();
        let secret = Secret::new("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
        let signed = sign_v4_request(
            "GET",
            "/test.txt",
            &[],
            "examplebucket.s3.amazonaws.com",
            &[("range", "bytes=0-9")],
            EMPTY_SHA256,
            "AKIAIOSFODNN7EXAMPLE",
            &secret,
            "us-east-1",
            ts,
        );
        assert_eq!(signed.x_amz_date, "20130524T000000Z");
        assert_eq!(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[test]
    fn sigv4_presigned_get_matches_official_aws_test_vector() {
        let ts: Timestamp = "2013-05-24T00:00:00Z".parse().unwrap();
        let secret = Secret::new("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
        let url = presign_v4_get(
            "https",
            "examplebucket.s3.amazonaws.com",
            "/test.txt",
            "AKIAIOSFODNN7EXAMPLE",
            &secret,
            "us-east-1",
            ts,
            86400,
        );
        assert_eq!(
            url,
            "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        );
    }

    #[test]
    fn list_objects_v2_xml_parses_entities_and_pagination() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok-2</NextContinuationToken>
  <Contents>
    <Key>prod/attachments/a&amp;b</Key>
    <LastModified>2026-11-26T12:00:00.000Z</LastModified>
    <ETag>&quot;deadbeef&quot;</ETag>
    <Size>128</Size>
  </Contents>
</ListBucketResult>"#;

        let page = parse_list_objects_v2_xml(xml, Some("prod/")).unwrap();
        assert!(page.is_truncated);
        assert_eq!(page.next_continuation_token.as_deref(), Some("tok-2"));
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].key, "attachments/a&b");
        assert_eq!(page.objects[0].etag.as_deref(), Some("deadbeef"));
    }
}
