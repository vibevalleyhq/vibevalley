//! Shared HTTP fetch abstraction, pooled/no-redirect clients, and bound-DNS public HTTPS downloads.

use std::future::Future;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::OnceLock;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// Its content type and bytes.
    pub body: Option<(String, Box<dyn Read + Send>)>,
    pub timeout: Duration,
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn Read + Send>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// The media type without parameters, lower-cased.
    pub fn media_type(&self) -> String {
        self.header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase()
    }
}

#[derive(Debug)]
pub enum FetchError {
    Timeout,
    Network(String),
}

/// How a request reaches the network (VibeValley's `fetch` / `publicFetch`).
pub trait Fetch: Send + Sync {
    fn fetch(&self, request: Request) -> Result<Response, FetchError>;

    /// Like [`Fetch::fetch`], aborting early when `cancel` fires.
    fn fetch_with_cancel(&self, request: Request, cancel: CancellationToken) -> Result<Response, FetchError> {
        if cancel.is_cancelled() {
            return Err(FetchError::Network("cancelled".into()));
        }
        self.fetch(request)
    }
}

impl<F: Fn(Request) -> Result<Response, FetchError> + Send + Sync> Fetch for F {
    fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        self(request)
    }
}

/// `reqwest`, no redirects, statuses answered rather than failed.
pub struct Http;

impl Http {
    #[allow(dead_code)]
    pub(crate) async fn fetch_async(r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
        let client = no_redirect_client().map_err(FetchError::Network)?.clone();
        execute_request_async(client, r, cancel).await
    }
}

impl Fetch for Http {
    fn fetch(&self, r: Request) -> Result<Response, FetchError> {
        let client = no_redirect_client().map_err(FetchError::Network)?.clone();
        execute_request(client, r, None)
    }

    fn fetch_with_cancel(&self, r: Request, cancel: CancellationToken) -> Result<Response, FetchError> {
        let client = no_redirect_client().map_err(FetchError::Network)?.clone();
        execute_request(client, r, Some(cancel))
    }
}

/// Bound-DNS public HTTPS fetcher: resolves the host to public IPv4 addresses
/// once and pins `reqwest` to those exact addresses with redirects and proxies disabled.
pub struct PublicDownload;

pub(crate) struct PublicBytes {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub url: url::Url,
}

#[derive(Debug)]
pub(crate) enum PublicDownloadError {
    BadUrl,
    Dns(String),
    Timeout,
    HttpStatus(u16),
    TooLarge,
    Network(String),
}

async fn resolve_public_v4(host: &str) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "Public IPv4 resolution required".to_string())?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| !matches!(a.ip(), IpAddr::V4(ip) if public_v4(ip))) {
        return Err("Public IPv4 resolution required".to_string());
    }
    Ok(addrs)
}

fn pinned_public_client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    crate::install_tls();
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|e| e.to_string())
}

impl PublicDownload {
    /// Downloads a public HTTPS resource asynchronously with bound-DNS pinning,
    /// enforcing `timeout`, HTTP 200, and `max_bytes`.
    pub(crate) async fn get_bytes_async(address: &str, timeout: Duration, max_bytes: usize) -> Result<PublicBytes, PublicDownloadError> {
        let url = url::Url::parse(address).map_err(|_| PublicDownloadError::BadUrl)?;
        if !public_https(&url) {
            return Err(PublicDownloadError::BadUrl);
        }
        let host = url.host_str().ok_or(PublicDownloadError::BadUrl)?.to_string();
        let addrs = tokio::time::timeout(timeout, resolve_public_v4(&host))
            .await
            .map_err(|_| PublicDownloadError::Timeout)?
            .map_err(PublicDownloadError::Dns)?;
        let client = pinned_public_client(&host, &addrs).map_err(PublicDownloadError::Network)?;
        let mut response = client.get(url.clone()).timeout(timeout).send().await.map_err(|e| {
            if e.is_timeout() {
                PublicDownloadError::Timeout
            } else {
                PublicDownloadError::Network(e.to_string())
            }
        })?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(PublicDownloadError::HttpStatus(status));
        }
        let media_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
            .unwrap_or_default();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            if e.is_timeout() {
                PublicDownloadError::Timeout
            } else {
                PublicDownloadError::Network(e.to_string())
            }
        })? {
            if bytes.len() + chunk.len() > max_bytes {
                return Err(PublicDownloadError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(PublicBytes { bytes, media_type, url })
    }

    /// Downloads a public HTTPS resource with bound-DNS pinning, enforcing `timeout`,
    /// HTTP 200, and `max_bytes`.
    pub(crate) fn get_bytes(address: &str, timeout: Duration, max_bytes: usize) -> Result<PublicBytes, PublicDownloadError> {
        let address = address.to_string();
        run_http(async move { Self::get_bytes_async(&address, timeout, max_bytes).await })
    }

    pub(crate) async fn fetch_async(r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
        if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(FetchError::Network("cancelled".into()));
        }
        let parsed = url::Url::parse(&r.url).map_err(|e| FetchError::Network(e.to_string()))?;
        if !public_https(&parsed) {
            return Err(FetchError::Network("not a public https address".into()));
        }
        let host = parsed.host_str().ok_or_else(|| FetchError::Network("missing host".into()))?.to_string();
        let timeout = r.timeout;
        let resolve = async {
            tokio::time::timeout(timeout, resolve_public_v4(&host))
                .await
                .map_err(|_| FetchError::Timeout)?
                .map_err(FetchError::Network)
        };
        let addrs = match &cancel {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => return Err(FetchError::Network("cancelled".into())),
                res = resolve => res?,
            },
            None => resolve.await?,
        };
        let client = pinned_public_client(&host, &addrs).map_err(FetchError::Network)?;
        execute_request_async(client, r, cancel).await
    }

    fn fetch_inner(&self, r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
        run_http(Self::fetch_async(r, cancel))
    }
}

impl Fetch for PublicDownload {
    fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        self.fetch_inner(request, None)
    }

    fn fetch_with_cancel(&self, request: Request, cancel: CancellationToken) -> Result<Response, FetchError> {
        self.fetch_inner(request, Some(cancel))
    }
}

/// Executes `r` asynchronously on `client`, awaiting response headers directly
/// and streaming body chunks into [`Response::body`] on the shared Tokio runtime.
pub(crate) async fn execute_request_async(client: reqwest::Client, r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
    if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
        return Err(FetchError::Network("cancelled".into()));
    }
    let method = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|e| FetchError::Network(e.to_string()))?;
    let mut req = client.request(method, &r.url).timeout(r.timeout);
    for (k, v) in &r.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some((kind, mut reader)) = r.body {
        req = req.header("content-type", kind);
        let (body_tx, body_rx) = flume::bounded::<std::io::Result<Vec<u8>>>(8);
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if body_tx.send(Ok(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = body_tx.send(Err(e));
                        break;
                    }
                }
            }
        });
        let stream = futures_util::stream::unfold(body_rx, |rx| async move { rx.recv_async().await.ok().map(|chunk| (chunk, rx)) });
        req = req.body(reqwest::Body::wrap_stream(stream));
    }
    let send_res = match &cancel {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => return Err(FetchError::Network("cancelled".into())),
            res = req.send() => res,
        },
        None => req.send().await,
    };
    let mut response = send_res.map_err(|e| {
        if e.is_timeout() {
            FetchError::Timeout
        } else {
            FetchError::Network(e.to_string())
        }
    })?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let (res_tx, res_rx) = flume::bounded::<std::io::Result<Vec<u8>>>(16);
    vibevalley_runtime::rt::handle().spawn(async move {
        loop {
            let chunk_res = match &cancel {
                Some(token) => tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        let _ = res_tx.send_async(Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"))).await;
                        break;
                    }
                    c = response.chunk() => c,
                },
                None => response.chunk().await,
            };
            match chunk_res {
                Ok(Some(bytes)) => {
                    if res_tx.send_async(Ok(bytes.to_vec())).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let io_err = if e.is_timeout() {
                        std::io::Error::new(std::io::ErrorKind::TimedOut, e.to_string())
                    } else {
                        std::io::Error::other(e.to_string())
                    };
                    let _ = res_tx.send_async(Err(io_err)).await;
                    break;
                }
            }
        }
    });
    Ok(Response {
        status,
        headers,
        body: Box::new(ChannelReader::new(res_rx)),
    })
}

fn execute_request(client: reqwest::Client, r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
    run_http(execute_request_async(client, r, cancel))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    Aborted,
    Io,
    TooLarge,
}

/// Reads at most `max` bytes from `body`, stopping early when `aborted` returns true.
pub fn read_max_until(body: &mut dyn Read, max: usize, aborted: impl Fn() -> bool) -> Result<Vec<u8>, ReadError> {
    let mut out = vec![];
    let mut buf = [0u8; 65536];
    loop {
        if aborted() {
            return Err(ReadError::Aborted);
        }
        let n = body.read(&mut buf).map_err(|_| ReadError::Io)?;
        if n == 0 {
            return Ok(out);
        }
        if out.len() + n > max {
            return Err(ReadError::TooLarge);
        }
        out.extend_from_slice(&buf[..n]);
    }
}

pub fn read_max(body: &mut dyn Read, max: usize) -> Result<Vec<u8>, ReadError> {
    read_max_until(body, max, || false)
}

/// Shared pooled `reqwest::Client` reused across connector calls on the shared Tokio runtime.
pub(crate) fn pooled_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            crate::install_tls();
            reqwest::Client::builder().build().map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Shared no-redirect `reqwest::Client` so outbound calls never leak credentials across redirects.
pub(crate) fn no_redirect_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            crate::install_tls();
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn run_http<T: Send + 'static>(work: impl Future<Output = T> + Send + 'static) -> T {
    vibevalley_runtime::rt::block_on(work)
}

/// Adapts a chunk channel from an async `reqwest::Response` into a synchronous [`Read`].
pub(crate) struct ChannelReader {
    rx: flume::Receiver<std::io::Result<Vec<u8>>>,
    buf: Vec<u8>,
    pos: usize,
}

impl ChannelReader {
    pub(crate) fn new(rx: flume::Receiver<std::io::Result<Vec<u8>>>) -> Self {
        Self { rx, buf: Vec::new(), pos: 0 }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(Ok(chunk)) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    self.buf = chunk;
                    self.pos = 0;
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => return Ok(0),
            }
        }
        let n = (self.buf.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// `publicIpv4`.
pub(crate) fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}

/// `publicHttps`: https on 443, no credentials, no fragment, a name or a
/// public IPv4 address.
pub(crate) fn public_https(url: &url::Url) -> bool {
    let host_ok = match url.host() {
        Some(url::Host::Domain(_)) => true,
        Some(url::Host::Ipv4(ip)) => public_v4(ip),
        _ => false,
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port().is_none_or(|p| p == 443)
        && host_ok
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read, Write};
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn download_addresses_cannot_reach_private_networks_or_carry_credentials() {
        for address in [
            "https://127.0.0.1/image",
            "https://[::ffff:7f00:1]/image",
            "https://10.0.0.2/image",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/",
            "https://192.168.0.1/",
            "file:///etc/passwd",
            "http://example.com/image",
            "https://user:secret@example.com/a",
            "https://example.com:8443/a",
            "https://example.com/a#fragment",
        ] {
            assert!(!public_https(&url::Url::parse(address).unwrap()), "{address}");
            assert!(
                matches!(
                    PublicDownload::get_bytes(address, Duration::from_secs(1), 1024),
                    Err(PublicDownloadError::BadUrl)
                ),
                "PublicDownload::get_bytes must reject {address}"
            );
            assert!(
                PublicDownload
                    .fetch(Request {
                        method: "GET",
                        url: address.into(),
                        headers: vec![],
                        body: None,
                        timeout: Duration::from_secs(1),
                    })
                    .is_err(),
                "PublicDownload::fetch must reject {address}"
            );
        }
        for address in ["https://example.com/image?signed=x", "https://8.8.8.8/image"] {
            assert!(public_https(&url::Url::parse(address).unwrap()));
        }
    }

    #[test]
    fn http_fetch_streams_post_body_and_never_follows_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut req = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = stream.read(&mut chunk).unwrap();
                req.extend_from_slice(&chunk[..n]);
                if req.windows(7).any(|w| w == b"payload") {
                    break;
                }
            }
            let raw = String::from_utf8_lossy(&req);
            assert!(raw.starts_with("POST /upload HTTP/1.1"), "{raw}");
            assert!(raw.to_ascii_lowercase().contains("x-test: ok"), "{raw}");
            stream
                .write_all(b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}")
                .unwrap();

            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut chunk);
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });

        let mut res = Http
            .fetch(Request {
                method: "POST",
                url: format!("http://{addr}/upload"),
                headers: vec![("x-test".into(), "ok".into())],
                body: Some(("text/plain".into(), Box::new(Cursor::new(b"payload".to_vec())))),
                timeout: Duration::from_secs(5),
            })
            .unwrap();
        assert_eq!(res.status, 201);
        assert_eq!(res.media_type(), "application/json");
        let mut body = String::new();
        res.body.read_to_string(&mut body).unwrap();
        assert_eq!(body, "{\"ok\":true}");

        let redirect = Http
            .fetch(Request {
                method: "GET",
                url: format!("http://{addr}/redir"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(5),
            })
            .unwrap();
        assert_eq!(redirect.status, 302);
        assert_eq!(redirect.header("location"), Some("http://127.0.0.1:1/other"));

        handle.join().unwrap();
    }

    #[test]
    fn async_fetch_and_public_download_reject_bad_urls_and_stream_without_block_on() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut chunk = [0u8; 512];
            let _ = stream.read(&mut chunk);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
                .unwrap();
        });

        vibevalley_runtime::rt::block_on(async move {
            assert!(matches!(
                PublicDownload::get_bytes_async("https://127.0.0.1/private", Duration::from_secs(1), 1024).await,
                Err(PublicDownloadError::BadUrl)
            ));
            let mut res = Http::fetch_async(
                Request {
                    method: "GET",
                    url: format!("http://{addr}/ping"),
                    headers: vec![],
                    body: None,
                    timeout: Duration::from_secs(5),
                },
                None,
            )
            .await
            .unwrap();
            assert_eq!(res.status, 200);
            let body = tokio::task::spawn_blocking(move || {
                let mut text = String::new();
                res.body.read_to_string(&mut text).unwrap();
                text
            })
            .await
            .unwrap();
            assert_eq!(body, "hello");
        });

        handle.join().unwrap();
    }
}
