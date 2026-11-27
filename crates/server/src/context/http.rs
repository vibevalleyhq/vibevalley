//! Shared HTTP fetch abstraction, process TLS initialization, pooled/no-redirect
//! clients, and bound-DNS public HTTPS downloads.

use std::future::Future;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::TryStreamExt;
use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::io::{StreamReader, SyncIoBridge};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

/// Installs the process-wide `ring` TLS provider once (`reqwest` and `tokio-tungstenite`).
pub fn install_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

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

/// Async outbound HTTP fetcher abstraction (real network or offline test fixture).
pub trait Fetch: Send + Sync + 'static {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> crate::BoxFuture<'static, Result<Response, FetchError>>;
}

impl<F: Fn(Request) -> Result<Response, FetchError> + Send + Sync + 'static> Fetch for F {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> crate::BoxFuture<'static, Result<Response, FetchError>> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(FetchError::Network("cancelled".into()));
            }
            crate::log::spawn_blocking_traced(move || (self)(request))
                .await
                .map_err(|e| FetchError::Network(e.to_string()))?
        })
    }
}

/// `reqwest`, no redirects, HTTP statuses returned directly rather than treated as errors.
pub struct Http;

impl Http {
    async fn fetch_async(r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
        let client = no_redirect_client().map_err(FetchError::Network)?.clone();
        execute_request_async(client, r, cancel).await
    }
}

impl Fetch for Http {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> crate::BoxFuture<'static, Result<Response, FetchError>> {
        Box::pin(Self::fetch_async(request, Some(cancel)))
    }
}

/// Bound-DNS public HTTPS fetcher: resolves the host to public IPv4 addresses
/// once and pins `reqwest` to those exact addresses with redirects and proxies disabled.
pub struct PublicDownload;

pub struct PublicBytes {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub url: url::Url,
}

#[derive(Debug)]
pub enum PublicDownloadError {
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
    install_tls();
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
    pub async fn get_bytes_async(address: &str, timeout: Duration, max_bytes: usize) -> Result<PublicBytes, PublicDownloadError> {
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

    async fn fetch_async(r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
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
}

impl Fetch for PublicDownload {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> crate::BoxFuture<'static, Result<Response, FetchError>> {
        Box::pin(Self::fetch_async(request, Some(cancel)))
    }
}

/// Executes `r` asynchronously on `client`, awaiting response headers directly
/// and bridging body chunks into [`Response::body`] via `SyncIoBridge(StreamReader)`.
async fn execute_request_async(client: reqwest::Client, r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
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
        let (body_tx, body_rx) = tokio::sync::mpsc::channel::<std::io::Result<Vec<u8>>>(8);
        crate::log::spawn_blocking_traced(move || {
            let mut buf = [0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if body_tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = body_tx.blocking_send(Err(e));
                        break;
                    }
                }
            }
        });
        req = req.body(reqwest::Body::wrap_stream(futures_util::stream::unfold(body_rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        })));
    }
    let send_res = match &cancel {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => return Err(FetchError::Network("cancelled".into())),
            res = req.send() => res,
        },
        None => req.send().await,
    };
    let response = send_res.map_err(|e| {
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
    let stream = response.bytes_stream().map_err(|e| {
        if e.is_timeout() {
            std::io::Error::new(std::io::ErrorKind::TimedOut, e.to_string())
        } else {
            std::io::Error::other(e)
        }
    });
    let reader = StreamReader::new(stream);
    let body: Box<dyn Read + Send> = match cancel {
        Some(token) => Box::new(SyncIoBridge::new(CancelRead::new(Box::pin(reader), token))),
        None => Box::new(SyncIoBridge::new(Box::pin(reader))),
    };
    Ok(Response { status, headers, body })
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
pub fn pooled_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            install_tls();
            reqwest::Client::builder().build().map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Shared no-redirect `reqwest::Client` so outbound calls never leak credentials across redirects.
pub fn no_redirect_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            install_tls();
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Cancels an underlying [`AsyncRead`] immediately when its [`CancellationToken`] fires.
struct CancelRead<R> {
    inner: R,
    cancelled: Option<Pin<Box<WaitForCancellationFutureOwned>>>,
}

impl<R> CancelRead<R> {
    fn new(inner: R, cancel: CancellationToken) -> Self {
        Self {
            inner,
            cancelled: (!cancel.is_cancelled()).then(|| Box::pin(cancel.cancelled_owned())),
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for CancelRead<R> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let Some(cancelled) = self.cancelled.as_mut() else {
            return Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")));
        };
        if cancelled.as_mut().poll(cx).is_ready() {
            self.cancelled = None;
            return Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

/// Returns `true` when `ip` is globally routable (not loopback, private, link-local, CGNAT, or reserved).
fn public_v4(ip: Ipv4Addr) -> bool {
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

/// Returns `true` for HTTPS on port 443 without credentials or fragment and with a domain or public IPv4 host.
pub fn public_https(url: &url::Url) -> bool {
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
    use std::convert::Infallible;
    use std::io::{Cursor, Read};
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::routing::{get, post};
    use tokio::net::TcpListener;
    use tokio_util::sync::DropGuard;

    use super::*;

    async fn spawn_mock_async(router: Router) -> (SocketAddr, DropGuard) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
        });
        (addr, guard)
    }

    #[tokio::test]
    async fn download_addresses_cannot_reach_private_networks_or_carry_credentials() {
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
                    PublicDownload::get_bytes_async(address, Duration::from_secs(1), 1024).await,
                    Err(PublicDownloadError::BadUrl)
                ),
                "PublicDownload::get_bytes_async must reject {address}"
            );
            assert!(
                PublicDownload::fetch_async(
                    Request {
                        method: "GET",
                        url: address.into(),
                        headers: vec![],
                        body: None,
                        timeout: Duration::from_secs(1),
                    },
                    None,
                )
                .await
                .is_err(),
                "PublicDownload::fetch_async must reject {address}"
            );
        }
        for address in ["https://example.com/image?signed=x", "https://8.8.8.8/image"] {
            assert!(public_https(&url::Url::parse(address).unwrap()));
        }
    }

    #[tokio::test]
    async fn http_fetch_streams_post_body_and_never_follows_redirects() {
        let seen = Arc::new(Mutex::new(None::<(Option<String>, Vec<u8>)>));
        let seen_for_route = seen.clone();
        let app = Router::new()
            .route(
                "/upload",
                post(move |headers: HeaderMap, body: Bytes| {
                    let x_test = headers.get("x-test").and_then(|v| v.to_str().ok()).map(ToString::to_string);
                    *seen_for_route.lock().unwrap() = Some((x_test, body.to_vec()));
                    async move { (StatusCode::CREATED, [(header::CONTENT_TYPE, "application/json")], r#"{"ok":true}"#) }
                }),
            )
            .route(
                "/redir",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "http://127.0.0.1:1/other")]) }),
            );
        let (addr, _guard) = spawn_mock_async(app).await;

        let mut res = Http::fetch_async(
            Request {
                method: "POST",
                url: format!("http://{addr}/upload"),
                headers: vec![("x-test".into(), "ok".into())],
                body: Some(("text/plain".into(), Box::new(Cursor::new(b"payload".to_vec())))),
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.status, 201);
        assert_eq!(res.media_type(), "application/json");
        let body = tokio::task::spawn_blocking(move || {
            let mut body = String::new();
            res.body.read_to_string(&mut body).unwrap();
            body
        })
        .await
        .unwrap();
        assert_eq!(body, "{\"ok\":true}");
        assert_eq!(seen.lock().unwrap().as_ref(), Some(&(Some("ok".to_string()), b"payload".to_vec())));

        let redirect = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/redir"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(redirect.status, 302);
        assert_eq!(redirect.header("location"), Some("http://127.0.0.1:1/other"));
    }

    #[tokio::test]
    async fn async_fetch_and_public_download_reject_bad_urls_and_stream_without_block_on() {
        let app = Router::new().route("/ping", get(|| async { ([(header::CONTENT_TYPE, "text/plain")], "hello") }));
        let (addr, _guard) = spawn_mock_async(app).await;

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
    }

    #[tokio::test]
    async fn http_fetch_streams_chunks_enforces_read_max_and_aborts_on_cancel() {
        let stream_cancel = CancellationToken::new();
        let stream_cancel_for_route = stream_cancel.clone();
        let app = Router::new()
            .route(
                "/chunks",
                get(|| async {
                    let stream = futures_util::stream::iter([Ok::<_, Infallible>(Bytes::from_static(b"hello")), Ok(Bytes::from_static(b"world"))]);
                    ([(header::CONTENT_TYPE, "application/octet-stream")], Body::from_stream(stream))
                }),
            )
            .route(
                "/stalled",
                get(move || {
                    let cancel = stream_cancel_for_route.clone();
                    let stream = futures_util::stream::unfold((true, cancel), |(first, cancel)| async move {
                        if first {
                            Some((Ok::<_, Infallible>(Bytes::from_static(b"first")), (false, cancel)))
                        } else {
                            cancel.cancelled().await;
                            None
                        }
                    });
                    async move { ([(header::CONTENT_TYPE, "text/plain")], Body::from_stream(stream)) }
                }),
            );
        let (addr, _guard) = spawn_mock_async(app).await;
        let _stream_guard = stream_cancel.drop_guard();

        let mut res = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/chunks"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        let read_res = tokio::task::spawn_blocking(move || read_max(&mut res.body, 8)).await.unwrap();
        assert_eq!(read_res, Err(ReadError::TooLarge));

        let cancel = CancellationToken::new();
        let mut res = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/stalled"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(30),
            },
            Some(cancel.clone()),
        )
        .await
        .unwrap();
        let res = tokio::task::spawn_blocking(move || {
            let mut first = [0u8; 5];
            res.body.read_exact(&mut first).unwrap();
            assert_eq!(&first, b"first");
            res
        })
        .await
        .unwrap();

        let cancel_trigger = cancel.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel_trigger.cancel();
        });
        let started = std::time::Instant::now();
        tokio::task::spawn_blocking(move || {
            let mut res = res;
            let mut rest = [0u8; 16];
            let err = res.body.read(&mut rest).expect_err("cancelled read must fail");
            assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);
            assert!(started.elapsed() < Duration::from_secs(2), "cancel must abort promptly");
            assert_eq!(res.body.read(&mut rest).unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        })
        .await
        .unwrap();

        canceller.await.unwrap();
    }
}
