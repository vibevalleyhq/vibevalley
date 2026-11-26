use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;
use sha2::Digest as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use super::releases::{self, Build};

const MAX_TEXT_BYTES: usize = 1_048_576;
const MAX_ETAG_ENTRIES: usize = 32;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const TEXT_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);
const MAX_HTTPS_REDIRECTS: usize = 10;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const SPEED_MIN_ELAPSED: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FailureKind {
    Network,
    RateLimit,
    Integrity,
    Signature,
    Permission,
    Install,
    Unknown,
}

impl FailureKind {
    pub(super) fn name(self) -> &'static str {
        match self {
            FailureKind::Network => "network",
            FailureKind::RateLimit => "rateLimit",
            FailureKind::Integrity => "integrity",
            FailureKind::Signature => "signature",
            FailureKind::Permission => "permission",
            FailureKind::Install => "install",
            FailureKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UpdateError {
    pub(super) kind: FailureKind,
    pub(super) why: String,
    pub(super) page: Option<String>,
}

impl UpdateError {
    pub(super) fn new(kind: FailureKind, why: impl Into<String>) -> Self {
        Self {
            kind,
            why: why.into(),
            page: None,
        }
    }

    pub(super) fn network(why: impl Into<String>) -> Self {
        Self::new(FailureKind::Network, why)
    }

    pub(super) fn rate_limit(why: impl Into<String>) -> Self {
        Self::new(FailureKind::RateLimit, why)
    }

    pub(super) fn integrity(why: impl Into<String>) -> Self {
        Self::new(FailureKind::Integrity, why)
    }

    pub(super) fn signature(why: impl Into<String>) -> Self {
        Self::new(FailureKind::Signature, why)
    }

    pub(super) fn permission(why: impl Into<String>) -> Self {
        Self::new(FailureKind::Permission, why)
    }

    pub(super) fn from_io(context: impl std::fmt::Display, error: &std::io::Error) -> Self {
        let kind = match error.kind() {
            std::io::ErrorKind::PermissionDenied => FailureKind::Permission,
            _ => FailureKind::Unknown,
        };
        Self::new(kind, format!("{context}: {error}"))
    }

    pub(super) fn with_page(mut self, page: &str) -> Self {
        if self.page.is_none() && !page.is_empty() {
            self.page = Some(page.to_string());
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DownloadProgress {
    pub(super) percent: u8,
    pub(super) downloaded_bytes: u64,
    pub(super) total_bytes: u64,
    pub(super) speed_bps: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TextResponse {
    pub(super) status: u16,
    pub(super) body: String,
    pub(super) from_cache: bool,
}

#[derive(Debug, Clone)]
struct CachedText {
    etag: String,
    body: String,
}

#[derive(Debug, Default)]
pub(super) struct EtagCache {
    entries: Mutex<HashMap<String, CachedText>>,
}

impl EtagCache {
    fn get(&self, url: &str) -> Option<CachedText> {
        self.entries.lock().get(url).cloned()
    }

    fn insert(&self, url: &str, etag: String, body: String) {
        let mut map = self.entries.lock();
        if map.len() >= MAX_ETAG_ENTRIES && !map.contains_key(url) {
            map.clear();
        }
        map.insert(url.to_string(), CachedText { etag, body });
    }
}

enum FetchTarget {
    Https,
    LoopbackHttp,
    LocalFile(PathBuf),
}

enum DownloadOutcome {
    Complete,
    Retry(UpdateError),
    RestartFromZero,
}

fn is_loopback_http(url: &str) -> bool {
    url.strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.parse::<std::net::SocketAddr>().ok())
        .is_some_and(|address| address.ip().is_loopback())
}

fn local_file_path(url: &str) -> Result<PathBuf, UpdateError> {
    let rest = url
        .strip_prefix("file://")
        .ok_or_else(|| UpdateError::network("local file URL must start with file:///"))?;
    if !rest.starts_with('/') {
        return Err(UpdateError::network("local file URL must use an absolute path"));
    }
    if rest.contains(['?', '#']) {
        return Err(UpdateError::network("local file URL must not contain query or fragment"));
    }
    // Check raw segments before `url::Url::parse` normalizes dot segments away.
    for segment in rest.split('/') {
        let decoded = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| UpdateError::network("local file URL contains invalid UTF-8"))?;
        if decoded == ".." || decoded.contains('/') || decoded.contains('\\') || decoded.contains('\0') {
            return Err(UpdateError::network("local file URL must not contain '..' path traversal"));
        }
    }
    let parsed = url::Url::parse(url).map_err(|e| UpdateError::network(format!("invalid file URL: {e}")))?;
    if parsed.scheme() != "file" || parsed.host().is_some() {
        return Err(UpdateError::network("local file URL must reference a local absolute path"));
    }
    let path = parsed
        .to_file_path()
        .map_err(|()| UpdateError::network("local file URL cannot be converted to a path"))?;
    if !path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err(UpdateError::network("local file URL must be an absolute path without '..'"));
    }
    Ok(path)
}

fn validate_url(url: &str) -> Result<FetchTarget, UpdateError> {
    if url.starts_with("https://") {
        return Ok(FetchTarget::Https);
    }
    if is_loopback_http(url) {
        return Ok(FetchTarget::LoopbackHttp);
    }
    if url.starts_with("file://") {
        return local_file_path(url).map(FetchTarget::LocalFile);
    }
    Err(UpdateError::network("only https URLs, loopback http feeds, or local file URLs are allowed"))
}

fn build_client(local_http: bool, total_timeout: Duration) -> Result<reqwest::Client, UpdateError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if local_http {
            return attempt.error("redirects are disabled for local loopback feeds");
        }
        if attempt.previous().len() >= MAX_HTTPS_REDIRECTS {
            return attempt.error("too many redirects");
        }
        if attempt.url().scheme() != "https" {
            return attempt.error("redirect to non-https URL refused");
        }
        attempt.follow()
    });
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(total_timeout)
        .redirect(redirect_policy)
        .user_agent(concat!("VibeValley/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| UpdateError::network(format!("http client: {e}")))
}

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

fn is_retryable_reqwest(error: &reqwest::Error) -> bool {
    !error.is_redirect() && !error.is_builder()
}

fn part_path_for(to: &Path) -> PathBuf {
    let mut os = to.as_os_str().to_os_string();
    os.push(".part");
    PathBuf::from(os)
}

fn parse_content_range(header: &str) -> Option<(u64, Option<u64>)> {
    let rest = header.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start_str, _end_str) = range.split_once('-')?;
    let start = start_str.trim().parse::<u64>().ok()?;
    let total = match total.trim() {
        "*" => None,
        s => Some(s.parse::<u64>().ok()?),
    };
    Some((start, total))
}

fn percent_of(downloaded: u64, total: u64) -> u8 {
    (downloaded.saturating_mul(100) / total.max(1)).min(100) as u8
}

fn compute_speed_bps(session_bytes: u64, elapsed: Duration) -> Option<u64> {
    if session_bytes == 0 || elapsed < SPEED_MIN_ELAPSED {
        return None;
    }
    let secs = elapsed.as_secs_f64();
    if secs <= 0.0 {
        return None;
    }
    Some((session_bytes as f64 / secs).round() as u64)
}

async fn text_once_async(client: &reqwest::Client, url: &str, cache: Option<&EtagCache>) -> Result<TextResponse, (UpdateError, bool)> {
    let cached = cache.and_then(|c| c.get(url));
    let mut req = client.get(url).header(reqwest::header::ACCEPT, "application/json, application/vnd.github+json");
    if let Some(entry) = &cached {
        req = req.header(reqwest::header::IF_NONE_MATCH, &entry.etag);
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| (UpdateError::network(format!("http: {e}")), is_retryable_reqwest(&e)))?;
    let status = resp.status().as_u16();
    if status == 304 {
        if let Some(entry) = cached {
            return Ok(TextResponse {
                status: 200,
                body: entry.body,
                from_cache: true,
            });
        }
        return Err((UpdateError::network("http: unexpected 304 without cached response"), false));
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(len) = resp.content_length()
        && len > MAX_TEXT_BYTES as u64
    {
        return Err((UpdateError::integrity(format!("response exceeds {MAX_TEXT_BYTES} byte limit")), false));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| (UpdateError::network(format!("http: {e}")), is_retryable_reqwest(&e)))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_TEXT_BYTES {
            return Err((UpdateError::integrity(format!("response exceeds {MAX_TEXT_BYTES} byte limit")), false));
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if status == 200
        && let (Some(cache), Some(etag)) = (cache, etag)
    {
        cache.insert(url, etag, text.clone());
    }
    Ok(TextResponse {
        status,
        body: text,
        from_cache: false,
    })
}

pub(super) async fn text_cached(url: &str, cache: Option<&EtagCache>) -> Result<TextResponse, UpdateError> {
    use backon::BackoffBuilder as _;
    text_with_backoff(
        url,
        cache,
        backon::ExponentialBuilder::new()
            .with_min_delay(Duration::from_millis(250))
            .with_max_delay(Duration::from_secs(2))
            .with_max_times(2)
            .build(),
    )
    .await
}

async fn read_local_text(path: &Path) -> Result<TextResponse, UpdateError> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TextResponse {
                status: 404,
                body: String::new(),
                from_cache: false,
            });
        }
        Err(e) => return Err(UpdateError::from_io(path.display(), &e)),
    };
    let meta = file.metadata().await.map_err(|e| UpdateError::from_io(path.display(), &e))?;
    if !meta.is_file() {
        return Err(UpdateError::integrity(format!("{}: not a regular file", path.display())));
    }
    if meta.len() > MAX_TEXT_BYTES as u64 {
        return Err(UpdateError::integrity(format!("response exceeds {MAX_TEXT_BYTES} byte limit")));
    }
    let mut limited = file.take((MAX_TEXT_BYTES + 1) as u64);
    let mut body = Vec::new();
    limited.read_to_end(&mut body).await.map_err(|e| UpdateError::from_io(path.display(), &e))?;
    if body.len() > MAX_TEXT_BYTES {
        return Err(UpdateError::integrity(format!("response exceeds {MAX_TEXT_BYTES} byte limit")));
    }
    Ok(TextResponse {
        status: 200,
        body: String::from_utf8_lossy(&body).into_owned(),
        from_cache: false,
    })
}

async fn copy_local_file(from: &Path, to: &Path, size: u64, mut on_progress: impl FnMut(DownloadProgress)) -> Result<(), UpdateError> {
    let mut reader = tokio::fs::File::open(from).await.map_err(|e| UpdateError::from_io(from.display(), &e))?;
    let meta = reader.metadata().await.map_err(|e| UpdateError::from_io(from.display(), &e))?;
    if !meta.is_file() {
        return Err(UpdateError::integrity(format!("{}: not a regular file", from.display())));
    }
    if meta.len() > size {
        return Err(UpdateError::integrity(format!("download exceeds expected {size} bytes")));
    }
    let part = part_path_for(to);
    let file = tokio::fs::File::create(&part).await.map_err(|e| UpdateError::from_io(part.display(), &e))?;
    let mut writer = tokio::io::BufWriter::new(file);
    let mut buffer = vec![0u8; 1 << 16];
    let mut got = 0u64;
    let mut last_pct = Some(0u8);
    let started = tokio::time::Instant::now();
    let mut last_emit = started;
    on_progress(DownloadProgress {
        percent: 0,
        downloaded_bytes: 0,
        total_bytes: size,
        speed_bps: None,
    });
    loop {
        let n = reader.read(&mut buffer).await.map_err(|e| UpdateError::from_io(from.display(), &e))?;
        if n == 0 {
            break;
        }
        got = got.saturating_add(n as u64);
        if got > size {
            drop(writer);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(UpdateError::integrity(format!("download exceeded expected {size} bytes")));
        }
        writer.write_all(&buffer[..n]).await.map_err(|e| UpdateError::from_io(part.display(), &e))?;
        let pct = percent_of(got, size);
        if last_pct != Some(pct) || last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_pct = Some(pct);
            last_emit = tokio::time::Instant::now();
            on_progress(DownloadProgress {
                percent: pct,
                downloaded_bytes: got,
                total_bytes: size,
                speed_bps: compute_speed_bps(got, started.elapsed()),
            });
        }
    }
    writer.flush().await.map_err(|e| UpdateError::from_io(part.display(), &e))?;
    drop(writer);
    if last_pct != Some(100) || got != size {
        on_progress(DownloadProgress {
            percent: percent_of(got, size),
            downloaded_bytes: got,
            total_bytes: size,
            speed_bps: compute_speed_bps(got, started.elapsed()),
        });
    }
    tokio::fs::rename(&part, to).await.map_err(|e| UpdateError::from_io(to.display(), &e))?;
    Ok(())
}

async fn text_with_backoff(url: &str, cache: Option<&EtagCache>, mut backoff: impl Iterator<Item = Duration>) -> Result<TextResponse, UpdateError> {
    let local = match validate_url(url)? {
        FetchTarget::Https => false,
        FetchTarget::LoopbackHttp => true,
        FetchTarget::LocalFile(path) => return read_local_text(&path).await,
    };
    let client = build_client(local, TEXT_TIMEOUT)?;
    loop {
        match text_once_async(&client, url, cache).await {
            Ok(resp) => {
                if is_retryable_status(resp.status)
                    && let Some(delay) = backoff.next()
                {
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Ok(resp);
            }
            Err((err, true)) => {
                if let Some(delay) = backoff.next() {
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Err(err);
            }
            Err((err, false)) => return Err(err),
        }
    }
}

async fn download_http_attempt(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    to: &Path,
    size: u64,
    on_progress: &mut impl FnMut(DownloadProgress),
) -> Result<DownloadOutcome, UpdateError> {
    let mut resume_from = match tokio::fs::metadata(part).await {
        Ok(meta) if meta.is_file() => {
            let len = meta.len();
            if len == size && size > 0 {
                on_progress(DownloadProgress {
                    percent: 100,
                    downloaded_bytes: size,
                    total_bytes: size,
                    speed_bps: None,
                });
                tokio::fs::rename(part, to).await.map_err(|e| UpdateError::from_io(to.display(), &e))?;
                return Ok(DownloadOutcome::Complete);
            }
            if len > size {
                let _ = tokio::fs::remove_file(part).await;
                0
            } else {
                len
            }
        }
        Ok(_) => {
            let _ = tokio::fs::remove_file(part).await;
            0
        }
        Err(_) => 0,
    };

    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let mut resp = match req.send().await {
        Ok(resp) => resp,
        Err(e) if is_retryable_reqwest(&e) => return Ok(DownloadOutcome::Retry(UpdateError::network(format!("http: {e}")))),
        Err(e) => return Err(UpdateError::network(format!("http: {e}"))),
    };

    let status = resp.status().as_u16();
    if status == 416 {
        let _ = tokio::fs::remove_file(part).await;
        if resume_from > 0 {
            return Ok(DownloadOutcome::RestartFromZero);
        }
        return Err(UpdateError::integrity("http status 416 range not satisfiable"));
    }
    if status == 429 {
        return Ok(DownloadOutcome::Retry(UpdateError::rate_limit("http status 429")));
    }
    if status == 403 {
        return Err(UpdateError::rate_limit("http status 403"));
    }
    if is_retryable_status(status) {
        return Ok(DownloadOutcome::Retry(UpdateError::network(format!("http status {status}"))));
    }

    let file = match status {
        206 if resume_from > 0 => {
            let range_header = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_content_range);
            match range_header {
                Some((start, total)) if start == resume_from => {
                    if total.is_some_and(|t| t > size) {
                        let _ = tokio::fs::remove_file(part).await;
                        return Err(UpdateError::integrity(format!("download exceeds expected {size} bytes")));
                    }
                    if let Some(len) = resp.content_length()
                        && resume_from.saturating_add(len) > size
                    {
                        let _ = tokio::fs::remove_file(part).await;
                        return Err(UpdateError::integrity(format!("download exceeds expected {size} bytes")));
                    }
                    tokio::fs::OpenOptions::new()
                        .write(true)
                        .append(true)
                        .open(part)
                        .await
                        .map_err(|e| UpdateError::from_io(part.display(), &e))?
                }
                _ => {
                    let _ = tokio::fs::remove_file(part).await;
                    return Ok(DownloadOutcome::RestartFromZero);
                }
            }
        }
        200 => {
            if let Some(len) = resp.content_length()
                && len > size
            {
                let _ = tokio::fs::remove_file(part).await;
                return Err(UpdateError::integrity(format!("download exceeds expected {size} bytes")));
            }
            resume_from = 0;
            tokio::fs::File::create(part).await.map_err(|e| UpdateError::from_io(part.display(), &e))?
        }
        _ => return Err(UpdateError::network(format!("http status {status}"))),
    };

    let mut writer = tokio::io::BufWriter::new(file);
    let mut got = resume_from;
    let mut session_bytes = 0u64;
    let started = tokio::time::Instant::now();
    let mut last_emit = started;
    let initial_pct = percent_of(got, size);
    let mut last_pct = Some(initial_pct);
    on_progress(DownloadProgress {
        percent: initial_pct,
        downloaded_bytes: got,
        total_bytes: size,
        speed_bps: None,
    });

    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                let _ = writer.flush().await;
                return Ok(DownloadOutcome::Retry(UpdateError::network(format!("http: {e}"))));
            }
        };
        got = got.saturating_add(chunk.len() as u64);
        session_bytes = session_bytes.saturating_add(chunk.len() as u64);
        if got > size {
            drop(writer);
            let _ = tokio::fs::remove_file(part).await;
            return Err(UpdateError::integrity(format!("download exceeded expected {size} bytes")));
        }
        writer.write_all(&chunk).await.map_err(|e| UpdateError::from_io(part.display(), &e))?;
        let pct = percent_of(got, size);
        if last_pct != Some(pct) || last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_pct = Some(pct);
            last_emit = tokio::time::Instant::now();
            on_progress(DownloadProgress {
                percent: pct,
                downloaded_bytes: got,
                total_bytes: size,
                speed_bps: compute_speed_bps(session_bytes, started.elapsed()),
            });
        }
    }

    writer.flush().await.map_err(|e| UpdateError::from_io(part.display(), &e))?;
    drop(writer);

    if got < size {
        return Ok(DownloadOutcome::Retry(UpdateError::network(format!(
            "download ended early ({got}/{size} bytes)"
        ))));
    }

    on_progress(DownloadProgress {
        percent: 100,
        downloaded_bytes: got,
        total_bytes: size,
        speed_bps: compute_speed_bps(session_bytes, started.elapsed()),
    });
    tokio::fs::rename(part, to).await.map_err(|e| UpdateError::from_io(to.display(), &e))?;
    Ok(DownloadOutcome::Complete)
}

async fn download_with_backoff(
    url: &str,
    to: &Path,
    size: u64,
    mut backoff: impl Iterator<Item = Duration>,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<(), UpdateError> {
    let local = match validate_url(url)? {
        FetchTarget::Https => false,
        FetchTarget::LoopbackHttp => true,
        FetchTarget::LocalFile(path) => return copy_local_file(&path, to, size, on_progress).await,
    };
    let client = build_client(local, DOWNLOAD_TIMEOUT)?;
    let part = part_path_for(to);
    let mut restarted_from_zero = false;
    loop {
        match download_http_attempt(&client, url, &part, to, size, &mut on_progress).await? {
            DownloadOutcome::Complete => return Ok(()),
            DownloadOutcome::RestartFromZero => {
                if restarted_from_zero {
                    return Err(UpdateError::integrity("server rejected resumable range after reset"));
                }
                restarted_from_zero = true;
            }
            DownloadOutcome::Retry(err) => {
                if let Some(delay) = backoff.next() {
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Err(err);
            }
        }
    }
}

async fn download(url: &str, to: &Path, size: u64, on_progress: impl FnMut(DownloadProgress)) -> Result<(), UpdateError> {
    use backon::BackoffBuilder as _;
    download_with_backoff(
        url,
        to,
        size,
        backon::ExponentialBuilder::new()
            .with_min_delay(Duration::from_millis(400))
            .with_max_delay(Duration::from_secs(4))
            .with_max_times(3)
            .build(),
        on_progress,
    )
    .await
}

pub fn measure(path: &Path) -> std::io::Result<(u64, String)> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = sha2::Sha512::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size += n as u64;
    }
    let hex = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((size, hex))
}

/// Validates every zip entry path and rejects symbolic links directly in Rust without
/// spawning `/usr/bin/zipinfo`.
fn inspect_archive(zip_path: &Path) -> Result<(), UpdateError> {
    let file = std::fs::File::open(zip_path).map_err(|e| UpdateError::integrity(format!("zip: {e}")))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| UpdateError::integrity(format!("zip: {e}")))?;
    let mut names = String::new();
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| UpdateError::integrity(format!("zip: {e}")))?;
        let name = entry.name().map_err(|e| UpdateError::integrity(format!("archive paths: {e}")))?;
        if entry.is_symlink() || entry.unix_mode().is_some_and(|mode| (mode & 0o170000) == 0o120000) {
            return Err(UpdateError::integrity("the update archive contains symbolic links"));
        }
        names.push_str(&name);
        names.push('\n');
    }
    if !releases::safe_archive(&names) {
        return Err(UpdateError::integrity("the update archive contains paths outside its app"));
    }
    Ok(())
}

async fn signature(app: &Path) -> Result<String, UpdateError> {
    let verified = tokio::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| UpdateError::signature(format!("codesign: {e}")))?;
    if !verified.status.success() {
        return Err(UpdateError::signature(String::from_utf8_lossy(&verified.stderr).trim().to_string()));
    }
    let said = tokio::process::Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=2"])
        .arg(app)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| UpdateError::signature(format!("codesign: {e}")))?;
    Ok(String::from_utf8_lossy(&said.stderr).into_owned())
}

fn unpacked_app(folder: &Path, bundle: &Path) -> Result<PathBuf, UpdateError> {
    let expected = folder.join(bundle.file_name().ok_or_else(|| UpdateError::integrity("the app has no name"))?);
    if expected.is_dir() {
        return Ok(expected);
    }
    releases::CHANNEL_BUNDLE_NAMES
        .iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_dir())
        .ok_or_else(|| UpdateError::integrity("the update archive contains no VibeValley app bundle"))
}

fn validate_bundle_id(running_bundle_id: Option<&str>, next_plist: &str, file: &str) -> Result<(), UpdateError> {
    let next_id = releases::plist_bundle_id(next_plist);
    if !releases::valid_update_bundle_id(running_bundle_id, next_id) {
        return Err(UpdateError::signature(match (running_bundle_id, next_id) {
            (Some(running), Some(next)) if releases::is_channel_bundle_id(next) => {
                format!("{file}: bundle identifier {next} does not match running app {running}")
            }
            _ => format!("{file}: not a VibeValley app"),
        }));
    }
    Ok(())
}

fn verify_downloaded_archive(zip_path: &Path, expected_size: u64, expected_sha512: &str, file_name: &str) -> Result<(), UpdateError> {
    let (size, sha512) = measure(zip_path).map_err(|e| UpdateError::integrity(e.to_string()))?;
    if size != expected_size || !sha512.eq_ignore_ascii_case(expected_sha512) {
        return Err(UpdateError::integrity(format!("{file_name}: not the file the release lists")));
    }
    inspect_archive(zip_path)
}

async fn clear_unpacked_apps(folder: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(folder).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".app") || name == "__MACOSX" {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

pub(super) async fn staged_app(
    url: &str,
    build: &Build,
    version: &str,
    bundle: &Path,
    folder: &Path,
    on_progress: impl FnMut(DownloadProgress),
    on_verifying: impl FnOnce(),
) -> Result<PathBuf, UpdateError> {
    let running = signature(bundle)
        .await
        .map_err(|err| UpdateError::signature(format!("running app signature: {}", err.why)))?;
    let running_plist = tokio::fs::read_to_string(bundle.join("Contents/Info.plist")).await.unwrap_or_default();
    let running_bundle_id = releases::plist_bundle_id(&running_plist);

    tokio::fs::create_dir_all(folder)
        .await
        .map_err(|e| UpdateError::from_io(folder.display(), &e))?;
    let zip = folder.join("update.zip");
    let part = part_path_for(&zip);

    let need_download = match tokio::fs::metadata(&zip).await {
        Ok(meta) if meta.is_file() && meta.len() == build.size => {
            let zip_check = zip.clone();
            let expected_size = build.size;
            let expected_sha512 = build.sha512.clone();
            let file_name = build.file.clone();
            let valid = tokio::task::spawn_blocking(move || verify_downloaded_archive(&zip_check, expected_size, &expected_sha512, &file_name))
                .await
                .ok()
                .is_some_and(|r| r.is_ok());
            if !valid {
                let _ = tokio::fs::remove_file(&zip).await;
            }
            !valid
        }
        Ok(_) => {
            let _ = tokio::fs::remove_file(&zip).await;
            true
        }
        Err(_) => true,
    };

    if need_download {
        download(url, &zip, build.size, on_progress).await?;
    }

    on_verifying();

    let zip_for_verify = zip.clone();
    let expected_size = build.size;
    let expected_sha512 = build.sha512.clone();
    let file_name = build.file.clone();
    let verified = tokio::task::spawn_blocking(move || verify_downloaded_archive(&zip_for_verify, expected_size, &expected_sha512, &file_name))
        .await
        .map_err(|e| UpdateError::integrity(format!("verify archive task failed: {e}")))?;
    if let Err(err) = verified {
        let _ = tokio::fs::remove_file(&zip).await;
        let _ = tokio::fs::remove_file(&part).await;
        return Err(err);
    }

    clear_unpacked_apps(folder).await;

    // ditto keeps what a .app holds that unzip would lose (symlinks, extended attributes).
    let unpacked = tokio::process::Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(&zip)
        .arg(folder)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| UpdateError::permission(format!("ditto: {e}")))?;
    if !unpacked.status.success() {
        return Err(UpdateError::permission(format!(
            "{}: {}",
            build.file,
            String::from_utf8_lossy(&unpacked.stderr).trim()
        )));
    }
    let _ = tokio::fs::remove_file(&zip).await;
    let app = unpacked_app(folder, bundle)?;
    let plist = tokio::fs::read_to_string(app.join("Contents/Info.plist")).await.unwrap_or_default();
    if releases::plist_version(&plist) != Some(version) {
        return Err(UpdateError::integrity(format!("{}: no VibeValley {version} in it", build.file)));
    }
    validate_bundle_id(running_bundle_id, &plist, &build.file)?;
    let said = signature(&app)
        .await
        .map_err(|err| UpdateError::signature(format!("{}: its signature does not hold: {}", build.file, err.why)))?;
    if !releases::same_signer(releases::team_of(&running), releases::team_of(&said)) {
        return Err(UpdateError::signature(format!("{}: not signed by the team that signed this app", build.file)));
    }
    Ok(app)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Body;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::Response;
    use axum::routing::get;
    use tokio::net::TcpListener;
    use tokio_util::sync::{CancellationToken, DropGuard};

    use super::*;

    async fn spawn_mock(router: Router) -> (SocketAddr, DropGuard) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
        });
        (addr, guard)
    }

    fn fast_backoff(max_times: usize) -> impl Iterator<Item = Duration> {
        use backon::BackoffBuilder as _;
        backon::ExponentialBuilder::new()
            .with_min_delay(Duration::from_millis(1))
            .with_max_delay(Duration::from_millis(5))
            .with_max_times(max_times)
            .build()
    }

    #[tokio::test]
    async fn regression_plain_http_is_only_allowed_for_a_loopback_feed_without_redirects() {
        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = hits.clone();
        let app = Router::new().route(
            "/release.json",
            get(move || {
                server_hits.fetch_add(1, Ordering::SeqCst);
                async { (StatusCode::FOUND, [(header::LOCATION, "http://example.invalid/release.json")]) }
            }),
        );
        let (address, _guard) = spawn_mock(app).await;
        assert!(text_cached(&format!("http://{address}/release.json"), None).await.is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(text_cached("http://example.invalid/release.json", None).await.is_err());
    }

    #[test]
    fn a_files_size_and_sha512_are_measured() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a");
        std::fs::write(&file, b"abc").unwrap();
        let (size, hex) = measure(&file).unwrap();
        assert_eq!(size, 3);
        assert_eq!(
            hex,
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
    }

    #[tokio::test]
    async fn text_retries_transient_server_errors_with_backon() {
        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = hits.clone();
        let app = Router::new().route(
            "/release.json",
            get(move || {
                let n = server_hits.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        (StatusCode::SERVICE_UNAVAILABLE, "busy")
                    } else {
                        (StatusCode::OK, "{}")
                    }
                }
            }),
        );
        let (address, _guard) = spawn_mock(app).await;
        let resp = text_with_backoff(&format!("http://{address}/release.json"), None, fast_backoff(2))
            .await
            .unwrap();
        assert_eq!((resp.status, resp.body.as_str(), resp.from_cache), (200, "{}", false));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn text_caches_etag_and_reuses_body_on_304() {
        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = hits.clone();
        let app = Router::new().route(
            "/release.json",
            get(move |headers: HeaderMap| {
                server_hits.fetch_add(1, Ordering::SeqCst);
                async move {
                    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some("\"v1\"") {
                        Response::builder().status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap()
                    } else {
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::ETAG, "\"v1\"")
                            .body(Body::from(r#"{"version":"0.2.0"}"#))
                            .unwrap()
                    }
                }
            }),
        );
        let (address, _guard) = spawn_mock(app).await;
        let url = format!("http://{address}/release.json");
        let cache = EtagCache::default();

        let first = text_with_backoff(&url, Some(&cache), fast_backoff(1)).await.unwrap();
        assert_eq!((first.status, first.from_cache), (200, false));
        assert_eq!(first.body, r#"{"version":"0.2.0"}"#);

        let second = text_with_backoff(&url, Some(&cache), fast_backoff(1)).await.unwrap();
        assert_eq!((second.status, second.from_cache), (200, true));
        assert_eq!(second.body, r#"{"version":"0.2.0"}"#);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn download_streams_with_progress_and_enforces_max_size() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("payload.bin");
        let payload: &'static [u8] = b"vibevalley-update-bytes";

        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = hits.clone();
        let app = Router::new().route(
            "/app.zip",
            get(move || {
                server_hits.fetch_add(1, Ordering::SeqCst);
                async move { (StatusCode::OK, payload) }
            }),
        );
        let (address, _guard) = spawn_mock(app).await;

        let mut progress = Vec::new();
        download_with_backoff(&format!("http://{address}/app.zip"), &target, payload.len() as u64, fast_backoff(2), |p| {
            progress.push(p)
        })
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(&target).await.unwrap(), payload);
        assert!(!part_path_for(&target).exists());
        let last = progress.last().copied().unwrap();
        assert_eq!(last.percent, 100);
        assert_eq!(last.downloaded_bytes, payload.len() as u64);
        assert_eq!(last.total_bytes, payload.len() as u64);

        // Exceeding declared max size is rejected with FailureKind::Integrity.
        let oversized = dir.path().join("oversized.bin");
        let err = download_with_backoff(&format!("http://{address}/app.zip"), &oversized, 4, fast_backoff(2), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind, FailureKind::Integrity);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn download_resumes_via_206_after_mid_stream_cut() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("update.zip");
        let payload: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
        let payload_arc = Arc::new(payload.clone());
        let cut_at = 1500usize;

        let hits = Arc::new(AtomicUsize::new(0));
        let seen_range = Arc::new(Mutex::new(None::<String>));
        let server_hits = hits.clone();
        let server_range = seen_range.clone();
        let server_payload = payload_arc.clone();

        let app = Router::new().route(
            "/app.zip",
            get(move |headers: HeaderMap| {
                let attempt = server_hits.fetch_add(1, Ordering::SeqCst);
                let range_val = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
                if let Some(r) = &range_val {
                    *server_range.lock() = Some(r.clone());
                }
                let data = server_payload.clone();
                async move {
                    if attempt == 0 {
                        // Send the first prefix, pause briefly so TCP flushes it to the client, then reset mid-stream.
                        let chunk = data[..cut_at].to_vec();
                        let stream = futures_util::stream::unfold(Some(chunk), |state| async move {
                            match state {
                                Some(bytes) if !bytes.is_empty() => Some((Ok::<Vec<u8>, std::io::Error>(bytes), Some(Vec::new()))),
                                Some(_) => {
                                    tokio::time::sleep(Duration::from_millis(20)).await;
                                    Some((Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset")), None))
                                }
                                None => None,
                            }
                        });
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_LENGTH, data.len().to_string())
                            .body(Body::from_stream(stream))
                            .unwrap()
                    } else if let Some(start) = range_val
                        .as_deref()
                        .and_then(|r| r.strip_prefix("bytes="))
                        .and_then(|r| r.strip_suffix('-'))
                        .and_then(|s| s.parse::<usize>().ok())
                    {
                        let slice = data[start..].to_vec();
                        let end = data.len() - 1;
                        Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{}", data.len()))
                            .header(header::CONTENT_LENGTH, slice.len().to_string())
                            .body(Body::from(slice))
                            .unwrap()
                    } else {
                        Response::builder().status(StatusCode::OK).body(Body::from((*data).clone())).unwrap()
                    }
                }
            }),
        );
        let (address, _guard) = spawn_mock(app).await;

        let mut progress = Vec::new();
        download_with_backoff(&format!("http://{address}/app.zip"), &target, payload.len() as u64, fast_backoff(3), |p| {
            progress.push(p)
        })
        .await
        .unwrap();

        assert_eq!(hits.load(Ordering::SeqCst), 2);
        assert_eq!(seen_range.lock().as_deref(), Some("bytes=1500-"));
        assert_eq!(tokio::fs::read(&target).await.unwrap(), payload);
        assert!(!part_path_for(&target).exists());
        assert_eq!(progress.last().map(|p| p.percent), Some(100));
    }

    #[tokio::test]
    async fn download_falls_back_cleanly_when_server_ignores_range_with_200() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("update.zip");
        let part = part_path_for(&target);
        // Seed an existing partial file so client sends Range.
        tokio::fs::write(&part, b"stale-prefix").await.unwrap();
        let payload: &'static [u8] = b"full-fresh-payload-bytes";

        let seen_range = Arc::new(Mutex::new(None::<String>));
        let server_range = seen_range.clone();
        let app = Router::new().route(
            "/app.zip",
            get(move |headers: HeaderMap| {
                *server_range.lock() = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
                async move { (StatusCode::OK, payload) }
            }),
        );
        let (address, _guard) = spawn_mock(app).await;

        download_with_backoff(&format!("http://{address}/app.zip"), &target, payload.len() as u64, fast_backoff(2), |_| {})
            .await
            .unwrap();

        assert_eq!(seen_range.lock().as_deref(), Some("bytes=12-"));
        assert_eq!(tokio::fs::read(&target).await.unwrap(), payload);
        assert!(!part.exists());
    }

    #[tokio::test]
    async fn download_recovers_from_416_by_removing_part_and_restarting_from_zero() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("update.zip");
        let part = part_path_for(&target);
        tokio::fs::write(&part, b"corrupt-part").await.unwrap();
        let payload: &'static [u8] = b"fresh-after-416-response";

        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = hits.clone();
        let app = Router::new().route(
            "/app.zip",
            get(move |headers: HeaderMap| {
                server_hits.fetch_add(1, Ordering::SeqCst);
                let has_range = headers.contains_key(header::RANGE);
                async move {
                    if has_range {
                        Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).body(Body::empty()).unwrap()
                    } else {
                        Response::builder().status(StatusCode::OK).body(Body::from(payload)).unwrap()
                    }
                }
            }),
        );
        let (address, _guard) = spawn_mock(app).await;

        download_with_backoff(&format!("http://{address}/app.zip"), &target, payload.len() as u64, fast_backoff(2), |_| {})
            .await
            .unwrap();

        assert_eq!(hits.load(Ordering::SeqCst), 2);
        assert_eq!(tokio::fs::read(&target).await.unwrap(), payload);
    }

    #[tokio::test]
    async fn download_classifies_rate_limit_errors() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("update.zip");
        let app = Router::new()
            .route("/429", get(|| async { (StatusCode::TOO_MANY_REQUESTS, "slow down") }))
            .route("/403", get(|| async { (StatusCode::FORBIDDEN, "rate limited") }));
        let (address, _guard) = spawn_mock(app).await;

        let err_429 = download_with_backoff(&format!("http://{address}/429"), &target, 16, fast_backoff(1), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err_429.kind, FailureKind::RateLimit);

        let err_403 = download_with_backoff(&format!("http://{address}/403"), &target, 16, fast_backoff(1), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err_403.kind, FailureKind::RateLimit);
    }

    #[test]
    fn inspect_archive_validates_paths_and_rejects_symlinks() {
        use zip::write::SimpleFileOptions;

        let dir = tempfile::tempdir().unwrap();

        let make_zip = |name: &str, entries: &[(&str, u32, &[u8])]| -> PathBuf {
            let path = dir.path().join(name);
            let file = std::fs::File::create(&path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            for (entry_name, mode, data) in entries {
                let opts = SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored)
                    .unix_permissions(*mode);
                writer.start_file(*entry_name, opts).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
            path
        };

        let safe = make_zip("safe.zip", &[("VibeValley.app/Contents/Info.plist", 0o100644, b"<plist/>")]);
        assert!(inspect_archive(&safe).is_ok());

        let alpha = make_zip("alpha.zip", &[("VibeValley-Alpha.app/Contents/Info.plist", 0o100644, b"<plist/>")]);
        assert!(inspect_archive(&alpha).is_ok());

        let traversal = make_zip("traversal.zip", &[("VibeValley.app/../../evil", 0o100644, b"x")]);
        let err = inspect_archive(&traversal).unwrap_err();
        assert_eq!(err.kind, FailureKind::Integrity);
        assert!(err.why.contains("outside its app"));

        let symlink = dir.path().join("symlink.zip");
        {
            let file = std::fs::File::create(&symlink).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            writer.add_symlink("VibeValley.app/Contents/MacOS/link", "/etc/passwd", opts).unwrap();
            writer.finish().unwrap();
        }
        let err = inspect_archive(&symlink).unwrap_err();
        assert_eq!(err.kind, FailureKind::Integrity);
        assert!(err.why.contains("symbolic links"));
    }

    #[test]
    fn validate_bundle_id_accepts_all_channels_and_rejects_mismatches() {
        let plist_for = |id: &str| format!("<dict><key>CFBundleIdentifier</key><string>{id}</string></dict>");

        for id in releases::CHANNEL_BUNDLE_IDS {
            assert!(validate_bundle_id(Some(id), &plist_for(id), "update.zip").is_ok());
            assert!(validate_bundle_id(None, &plist_for(id), "update.zip").is_ok());
        }

        let mismatch = validate_bundle_id(Some("dev.vibevalley.app.alpha"), &plist_for("dev.vibevalley.app"), "VibeValley-0.2.0.zip").unwrap_err();
        assert_eq!(mismatch.kind, FailureKind::Signature);
        assert!(mismatch.why.contains("does not match running app dev.vibevalley.app.alpha"), "{}", mismatch.why);

        let foreign = validate_bundle_id(None, &plist_for("com.evil.app"), "evil.zip").unwrap_err();
        assert_eq!(foreign.kind, FailureKind::Signature);
        assert!(foreign.why.contains("not a VibeValley app"), "{}", foreign.why);

        let missing = validate_bundle_id(Some("dev.vibevalley.app.alpha"), "<dict/>", "empty.zip").unwrap_err();
        assert_eq!(missing.kind, FailureKind::Signature);
        assert!(missing.why.contains("not a VibeValley app"), "{}", missing.why);
    }

    #[test]
    fn unpacked_app_resolves_channel_bundle_names() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = dir.path().join("VibeValley-Alpha.app");
        std::fs::create_dir(&alpha).unwrap();

        assert_eq!(unpacked_app(dir.path(), Path::new("/Applications/VibeValley-Alpha.app")).unwrap(), alpha);
        assert_eq!(unpacked_app(dir.path(), Path::new("/Applications/Renamed.app")).unwrap(), alpha);
    }

    #[tokio::test]
    async fn local_file_feed_reads_manifest_returns_404_when_missing_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let spaced = dir.path().join("alpha dist");
        std::fs::create_dir(&spaced).unwrap();
        let manifest = spaced.join("release.json");
        std::fs::write(&manifest, r#"{"version":"0.1.0-alpha.2","page":"","builds":[]}"#).unwrap();

        let manifest_url = url::Url::from_file_path(&manifest).unwrap().to_string();
        let resp = text_cached(&manifest_url, None).await.unwrap();
        assert_eq!(resp.status, 200);
        assert!(resp.body.contains("0.1.0-alpha.2"));

        let missing_url = url::Url::from_file_path(spaced.join("missing.json")).unwrap().to_string();
        let missing = text_cached(&missing_url, None).await.unwrap();
        assert_eq!((missing.status, missing.body), (404, String::new()));

        let oversized = spaced.join("huge.json");
        std::fs::write(&oversized, vec![b'a'; MAX_TEXT_BYTES + 1]).unwrap();
        let oversized_url = url::Url::from_file_path(&oversized).unwrap().to_string();
        let oversized_err = text_cached(&oversized_url, None).await.unwrap_err();
        assert_eq!(oversized_err.kind, FailureKind::Integrity);
        assert!(oversized_err.why.contains("byte limit"));

        for bad in [
            format!("file://{}/../release.json", spaced.display()),
            format!("file://{}/%2e%2e/release.json", spaced.display()),
            format!("file://{}/..%2frelease.json", spaced.display()),
            "file://evil.example/dist/release.json".into(),
            "file://relative/release.json".into(),
            format!("{manifest_url}?foo=1"),
        ] {
            assert!(text_cached(&bad, None).await.is_err(), "expected rejection for {bad}");
        }
    }

    #[tokio::test]
    async fn local_file_zip_streams_through_size_sha512_archive_and_bundle_id_checks() {
        use zip::write::SimpleFileOptions;

        let dir = tempfile::tempdir().unwrap();
        let dist = dir.path().join("dist");
        std::fs::create_dir(&dist).unwrap();
        let source_zip = dist.join("VibeValley-0.1.0-alpha.2-arm64.zip");
        let plist = "<dict><key>CFBundleIdentifier</key><string>dev.vibevalley.app.alpha</string></dict>";
        {
            let file = std::fs::File::create(&source_zip).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(0o100644);
            writer.start_file("VibeValley-Alpha.app/Contents/Info.plist", opts).unwrap();
            writer.write_all(plist.as_bytes()).unwrap();
            writer.finish().unwrap();
        }
        let (size, sha512) = measure(&source_zip).unwrap();
        let zip_url = url::Url::from_file_path(&source_zip).unwrap().to_string();

        let staged_zip = dir.path().join("staged.zip");
        let mut progress = Vec::new();
        download(&zip_url, &staged_zip, size, |p| progress.push(p)).await.unwrap();
        assert_eq!(progress.first().map(|p| p.percent), Some(0));
        assert_eq!(progress.last().map(|p| p.percent), Some(100));

        verify_downloaded_archive(&staged_zip, size, &sha512, "VibeValley-0.1.0-alpha.2-arm64.zip").unwrap();
        validate_bundle_id(Some("dev.vibevalley.app.alpha"), plist, "VibeValley-0.1.0-alpha.2-arm64.zip").unwrap();

        // Tampered SHA-512 must still fail for local file:// archives.
        let tampered = verify_downloaded_archive(&staged_zip, size, "00", "VibeValley-0.1.0-alpha.2-arm64.zip").unwrap_err();
        assert_eq!(tampered.kind, FailureKind::Integrity);

        // Oversized local zip and traversal URL must be rejected at download time.
        let rejected = dir.path().join("rejected.zip");
        assert!(download(&zip_url, &rejected, size - 1, |_| {}).await.is_err());
        assert!(
            download(
                &format!("file://{}/../VibeValley-0.1.0-alpha.2-arm64.zip", dist.display()),
                &rejected,
                size,
                |_| {}
            )
            .await
            .is_err()
        );
    }
}
