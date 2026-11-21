//! Shared HTTP fetch abstraction, no-redirect client, and public HTTPS policy.

use std::future::Future;
use std::io::Read;
use std::net::Ipv4Addr;
use std::sync::OnceLock;
use std::time::Duration;

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
}

impl<F: Fn(Request) -> Result<Response, FetchError> + Send + Sync> Fetch for F {
    fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        self(request)
    }
}

/// `reqwest`, no redirects, statuses answered rather than failed.
pub struct Http;

impl Fetch for Http {
    fn fetch(&self, r: Request) -> Result<Response, FetchError> {
        let client = no_redirect_client().map_err(FetchError::Network)?.clone();
        let method = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|e| FetchError::Network(e.to_string()))?;
        let (head_tx, head_rx) = flume::bounded::<Result<Response, FetchError>>(1);
        http_runtime().spawn(async move {
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
            let mut response = match req.send().await {
                Ok(res) => res,
                Err(e) => {
                    let err = if e.is_timeout() {
                        FetchError::Timeout
                    } else {
                        FetchError::Network(e.to_string())
                    };
                    let _ = head_tx.send(Err(err));
                    return;
                }
            };
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
                .collect();
            let (res_tx, res_rx) = flume::bounded::<std::io::Result<Vec<u8>>>(16);
            if head_tx
                .send(Ok(Response {
                    status,
                    headers,
                    body: Box::new(ChannelReader::new(res_rx)),
                }))
                .is_err()
            {
                return;
            }
            loop {
                match response.chunk().await {
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
        head_rx.recv().map_err(|_| FetchError::Network("http task stopped".into()))?
    }
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

/// Shared tokio runtime for outbound `reqwest` calls from synchronous handlers and workers.
pub(crate) fn http_runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        crate::install_tls();
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("vibevalley-http-client")
            .enable_all()
            .build()
            .expect("http client runtime")
    })
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
    let (tx, rx) = flume::bounded(1);
    http_runtime().spawn(async move {
        let _ = tx.send(work.await);
    });
    rx.recv().expect("http client task completed")
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
}
