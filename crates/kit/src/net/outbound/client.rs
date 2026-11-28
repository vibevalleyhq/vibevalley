//! Outbound HTTP fetch port, `reqwest` client pools, streaming body caps,
//! cancellation-aware response reads, and [`MemoryFetch`] test twin.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::io::{Cursor, Read};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::TryStreamExt;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::io::{StreamReader, SyncIoBridge};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

/// Heap-allocated `Send` future returned by async outbound fetch implementations.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Installs the process-wide `ring` TLS crypto provider once (idempotent).
pub fn install_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// Content-Type header and streaming request body bytes.
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

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => f.write_str("request timed out"),
            Self::Network(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for FetchError {}

/// Async outbound HTTP fetcher abstraction (real network or offline test fixture).
pub trait Fetch: Send + Sync + 'static {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> BoxFuture<'static, Result<Response, FetchError>>;
}

impl<F: Fn(Request) -> Result<Response, FetchError> + Send + Sync + 'static> Fetch for F {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> BoxFuture<'static, Result<Response, FetchError>> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(FetchError::Network("cancelled".into()));
            }
            crate::trace::spawn_blocking_traced(move || (self)(request))
                .await
                .map_err(|e| FetchError::Network(e.to_string()))?
        })
    }
}

/// `reqwest`, no redirects, HTTP statuses returned directly rather than treated as errors.
pub struct Http;

impl Http {
    pub async fn fetch_async(r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
        let client = no_redirect_client().map_err(FetchError::Network)?.clone();
        execute_request_async(client, r, cancel).await
    }
}

impl Fetch for Http {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> BoxFuture<'static, Result<Response, FetchError>> {
        Box::pin(Self::fetch_async(request, Some(cancel)))
    }
}

/// Executes `r` asynchronously on `client`, awaiting response headers directly
/// and bridging body chunks into [`Response::body`] via `SyncIoBridge(StreamReader)`.
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
        let (body_tx, body_rx) = tokio::sync::mpsc::channel::<std::io::Result<Vec<u8>>>(8);
        crate::trace::spawn_blocking_traced(move || {
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

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Aborted => f.write_str("read aborted"),
            Self::Io => f.write_str("i/o error while reading body"),
            Self::TooLarge => f.write_str("response body exceeds maximum allowed size"),
        }
    }
}

impl std::error::Error for ReadError {}

/// Reads at most `max` bytes from `body`, stopping early when `aborted` returns true.
pub fn read_max_until(body: &mut dyn Read, max: usize, aborted: impl Fn() -> bool) -> Result<Vec<u8>, ReadError> {
    let mut out = Vec::new();
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

/// Captured HTTP request recorded by [`MemoryFetch`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<(String, Vec<u8>)>,
    pub timeout: Duration,
}

/// Scripted HTTP response served by [`MemoryFetch`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl MemoryResponse {
    pub fn ok_text(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "text/plain; charset=utf-8".into())],
            body: body.into(),
        }
    }

    pub fn ok_json(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.into(),
        }
    }

    pub fn redirect(status: u16, location: impl Into<String>) -> Self {
        Self {
            status,
            headers: vec![("location".into(), location.into())],
            body: Vec::new(),
        }
    }

    pub fn into_response(self) -> Response {
        Response {
            status: self.status,
            headers: self.headers,
            body: Box::new(Cursor::new(self.body)),
        }
    }
}

#[derive(Default)]
struct MemoryFetchState {
    queued: VecDeque<Result<MemoryResponse, FetchError>>,
    recorded: Vec<RecordedRequest>,
}

/// In-memory [`Fetch`] test twin that records requests and serves scripted responses.
#[derive(Default)]
pub struct MemoryFetch {
    state: Mutex<MemoryFetchState>,
}

impl MemoryFetch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enqueue(&self, response: Result<MemoryResponse, FetchError>) {
        self.state.lock().queued.push_back(response);
    }

    pub fn enqueue_ok(&self, response: MemoryResponse) {
        self.enqueue(Ok(response));
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.state.lock().recorded.clone()
    }
}

impl Fetch for MemoryFetch {
    fn fetch_async(self: Arc<Self>, request: Request, cancel: CancellationToken) -> BoxFuture<'static, Result<Response, FetchError>> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(FetchError::Network("cancelled".into()));
            }
            let body = match request.body {
                Some((ct, mut reader)) => {
                    let mut bytes = Vec::new();
                    reader.read_to_end(&mut bytes).map_err(|e| FetchError::Network(e.to_string()))?;
                    Some((ct, bytes))
                }
                None => None,
            };
            let next = {
                let mut state = self.state.lock();
                state.recorded.push(RecordedRequest {
                    method: request.method,
                    url: request.url,
                    headers: request.headers,
                    body,
                    timeout: request.timeout,
                });
                state.queued.pop_front()
            };
            match next {
                Some(Ok(resp)) => Ok(resp.into_response()),
                Some(Err(err)) => Err(err),
                None => Err(FetchError::Network("MemoryFetch queue exhausted".into())),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn read_max_and_read_max_until_enforce_bounds_and_abort() {
        let mut exact = Cursor::new(b"12345".to_vec());
        assert_eq!(read_max(&mut exact, 5), Ok(b"12345".to_vec()));

        let mut oversized = Cursor::new(b"123456".to_vec());
        assert_eq!(read_max(&mut oversized, 5), Err(ReadError::TooLarge));

        let aborted = AtomicBool::new(true);
        let mut cursor = Cursor::new(b"hello".to_vec());
        assert_eq!(read_max_until(&mut cursor, 16, || aborted.load(Ordering::Relaxed)), Err(ReadError::Aborted));
    }

    #[tokio::test]
    async fn memory_fetch_records_requests_and_respects_cancellation() {
        let fake = Arc::new(MemoryFetch::new());
        fake.enqueue_ok(MemoryResponse::ok_json(br#"{"ok":true}"#.to_vec()));

        let res = fake
            .clone()
            .fetch_async(
                Request {
                    method: "POST",
                    url: "https://example.com/v1/items".into(),
                    headers: vec![("x-trace".into(), "42".into())],
                    body: Some(("application/json".into(), Box::new(Cursor::new(b"{\"a\":1}".to_vec())))),
                    timeout: Duration::from_secs(5),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.media_type(), "application/json");
        let mut body = res.body;
        assert_eq!(read_max(&mut *body, 1024).unwrap(), br#"{"ok":true}"#);

        let recorded = fake.requests();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "POST");
        assert_eq!(recorded[0].url, "https://example.com/v1/items");
        assert_eq!(recorded[0].body, Some(("application/json".into(), b"{\"a\":1}".to_vec())));

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let err = fake
            .fetch_async(
                Request {
                    method: "GET",
                    url: "https://example.com/cancelled".into(),
                    headers: vec![],
                    body: None,
                    timeout: Duration::from_secs(1),
                },
                cancelled,
            )
            .await;
        assert!(matches!(err, Err(FetchError::Network(msg)) if msg == "cancelled"));
    }

    #[tokio::test]
    async fn http_client_never_follows_redirects_and_caps_streaming_reads() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut req_buf = [0u8; 1024];
                let n = stream.read(&mut req_buf).await.unwrap();
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                if req_str.starts_with("GET /redir ") {
                    let resp = "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(resp.as_bytes()).await;
                } else {
                    let payload = b"0123456789abcdef";
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(payload).await;
                }
                let _ = stream.shutdown().await;
            }
        });

        let redir = Http::fetch_async(
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
        assert_eq!(redir.status, 302);
        assert_eq!(redir.header("location"), Some("http://127.0.0.1:1/secret"));

        let mut resp = Http::fetch_async(
            Request {
                method: "GET",
                url: format!("http://{addr}/bytes"),
                headers: vec![],
                body: None,
                timeout: Duration::from_secs(5),
            },
            None,
        )
        .await
        .unwrap();
        let too_large = tokio::task::spawn_blocking(move || read_max(&mut resp.body, 8)).await.unwrap();
        assert_eq!(too_large, Err(ReadError::TooLarge));

        server.await.unwrap();
    }
}
