//! Remote Control Plane `Server` adapter: implements `vibevalley_server::transport::api::Server`
//! over authenticated HTTP + SSE (`POST /api/v1/{op}`, `GET /api/v1/slice/{name}`,
//! `GET /api/v1/live`, `GET /api/v1/subscribe/{name}`) so the desktop GUI mounts directly onto
//! `BridgeHub` without starting a local embedded server.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{BizCode, Envelope, LiveEvent, SliceKind};
use vibevalley_server::transport::api::{BoxFuture, CallerContext, Server, refusal};

use crate::hosted::connection::{Secret, is_loopback_url, normalize_url};

const REMOTE_CLIENT_HEADER: &str = "remote";
const BACKOFF_MS: &[u64] = &[500, 1_000, 2_000, 4_000, 8_000];
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
struct SseMessage {
    id: Option<String>,
    data: String,
}

/// Incremental UTF-8 Server-Sent Events parser matching W3C EventSource framing.
#[derive(Default)]
struct SseParser {
    buffer: String,
    skip_leading_lf: bool,
    last_event_id: Option<String>,
    data_lines: Vec<String>,
}

impl SseParser {
    fn push(&mut self, chunk: &str, on_message: &mut impl FnMut(SseMessage)) {
        let mut text = chunk;
        if self.skip_leading_lf {
            if let Some(rest) = text.strip_prefix('\n') {
                text = rest;
            }
            if !chunk.is_empty() {
                self.skip_leading_lf = false;
            }
        }
        self.buffer.push_str(text);

        let buf = std::mem::take(&mut self.buffer);
        let bytes = buf.as_bytes();
        let mut start = 0usize;
        let mut i = 0usize;
        while i < bytes.len() {
            match bytes[i] {
                b'\n' => {
                    self.handle_line(&buf[start..i], on_message);
                    i += 1;
                    start = i;
                }
                b'\r' => {
                    self.handle_line(&buf[start..i], on_message);
                    if i + 1 < bytes.len() {
                        if bytes[i + 1] == b'\n' {
                            i += 2;
                        } else {
                            i += 1;
                        }
                        start = i;
                    } else {
                        self.skip_leading_lf = true;
                        i += 1;
                        start = i;
                    }
                }
                _ => i += 1,
            }
        }
        if start < buf.len() {
            self.buffer.push_str(&buf[start..]);
        }
    }

    fn handle_line(&mut self, line: &str, on_message: &mut impl FnMut(SseMessage)) {
        if line.is_empty() {
            if !self.data_lines.is_empty() {
                let data = self.data_lines.join("\n");
                self.data_lines.clear();
                on_message(SseMessage {
                    id: self.last_event_id.clone(),
                    data,
                });
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, raw_value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "data" => self.data_lines.push(raw_value.to_string()),
            "id" if !raw_value.contains('\0') => self.last_event_id = Some(raw_value.to_string()),
            _ => {}
        }
    }
}

fn fallback_biz_code(status: reqwest::StatusCode) -> BizCode {
    match status.as_u16() {
        400 => BizCode::InvalidInput,
        401 => BizCode::Unauthorized,
        403 => BizCode::Forbidden,
        404 => BizCode::RouteNotFound,
        405 => BizCode::MethodNotAllowed,
        503 => BizCode::ServiceUnavailable,
        _ => BizCode::InternalError,
    }
}

fn parse_envelope_or_fallback(status: reqwest::StatusCode, text: &str) -> Envelope {
    if let Ok(env) = serde_json::from_str::<Envelope>(text) {
        return env;
    }
    let msg = text.trim();
    let detail = if msg.is_empty() {
        format!("HTTP {}", status.as_u16())
    } else {
        msg.to_string()
    };
    refusal(fallback_biz_code(status), detail)
}

fn build_client(base_url: &str) -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if is_loopback_url(base_url) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| format!("failed to build remote HTTP client: {e}"))
}

fn attach_headers(req: reqwest::RequestBuilder, token: &Secret) -> reqwest::RequestBuilder {
    let req = req.header("x-vibevalley-client", REMOTE_CLIENT_HEADER);
    match token.trimmed() {
        Some(secret) => req.header("authorization", format!("Bearer {}", secret.expose())),
        None => req,
    }
}

fn op_url(base_url: &str, op: &str) -> String {
    let path = op.trim_matches('.').replace('.', "/");
    format!("{base_url}/api/v1/{path}")
}

fn backoff_delay(attempt: usize) -> Duration {
    let idx = attempt.min(BACKOFF_MS.len() - 1);
    Duration::from_millis(BACKOFF_MS[idx])
}

/// Remote Control Plane `Server` talking HTTP + SSE to a remote `vibevalley-server`.
pub struct RemoteServer {
    base_url: String,
    token: Secret,
    label: Option<String>,
    client: reqwest::Client,
    subs: Arc<Mutex<HashMap<u64, CancellationToken>>>,
    next_sub_id: AtomicU64,
    shutdown: CancellationToken,
}

impl fmt::Debug for RemoteServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteServer")
            .field("base_url", &self.base_url)
            .field("token", &self.token)
            .field("label", &self.label)
            .finish()
    }
}

impl RemoteServer {
    pub fn new(base_url: String, token: Secret, label: Option<String>) -> Result<Self, String> {
        let base_url = normalize_url(&base_url)?;
        let client = build_client(&base_url)?;
        Ok(Self {
            base_url,
            token,
            label,
            client,
            subs: Arc::new(Mutex::new(HashMap::new())),
            next_sub_id: AtomicU64::new(1),
            shutdown: CancellationToken::new(),
        })
    }

    async fn call_http(&self, op: &str, payload: Value) -> Envelope {
        let url = op_url(&self.base_url, op);
        let body = if payload.is_null() { Value::Object(Default::default()) } else { payload };
        let req = attach_headers(self.client.post(&url).timeout(CALL_TIMEOUT).json(&body), &self.token);
        let response = match req.send().await {
            Ok(res) => res,
            Err(err) => return refusal(BizCode::ServiceUnavailable, format!("remote control plane unreachable: {err}")),
        };
        let status = response.status();
        let text = match response.text().await {
            Ok(text) => text,
            Err(err) => return refusal(BizCode::ServiceUnavailable, format!("failed reading remote response: {err}")),
        };
        parse_envelope_or_fallback(status, &text)
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
        let tokens: Vec<CancellationToken> = self.subs.lock().drain().map(|(_, t)| t).collect();
        for token in tokens {
            token.cancel();
        }
    }
}

impl Server for RemoteServer {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        vibevalley_runtime::rt::block_on(self.call_http(op, payload))
    }

    fn call_with_async(self: Arc<Self>, _ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        Box::pin(async move { self.call_http(&op, payload).await })
    }

    fn slice_snapshot(&self, slice: SliceKind) -> Value {
        let url = format!("{}/api/v1/slice/{}?once=1", self.base_url, slice.as_str());
        let client = self.client.clone();
        let token = self.token.clone();

        vibevalley_runtime::rt::block_on(async move {
            let req = attach_headers(client.get(&url).header("accept", "application/json").timeout(SNAPSHOT_TIMEOUT), &token);
            let Ok(response) = req.send().await else {
                return Value::Null;
            };
            if !response.status().is_success() {
                return Value::Null;
            }
            response.json::<Value>().await.unwrap_or(Value::Null)
        })
    }

    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        // Pump SSE on the Tokio runtime and deliver via flume so `receive` executes outside `rt::block_on`
        // (BridgeHub's watch callback uses `rt::block_on` for Bounded-1 ack waiting).
        let (tx, rx) = flume::bounded::<(i64, Value)>(1);
        let cancel = self.shutdown.child_token();
        let task_cancel = cancel.clone();
        let client = self.client.clone();
        let token = self.token.clone();
        let url = format!("{}/api/v1/slice/{}", self.base_url, slice.as_str());

        vibevalley_runtime::rt::handle().spawn(async move {
            let mut last_seq = after_seq;
            let mut attempt = 0usize;

            while !task_cancel.is_cancelled() && !tx.is_disconnected() {
                let mut req = attach_headers(client.get(&url).header("accept", "text/event-stream"), &token);
                if let Some(seq) = last_seq {
                    req = req.header("last-event-id", seq.to_string());
                }
                let response = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => break,
                    res = req.send() => res,
                };
                match response {
                    Ok(res) if res.status() == reqwest::StatusCode::UNAUTHORIZED || res.status() == reqwest::StatusCode::FORBIDDEN => {
                        tracing::warn!("remote slice stream {} refused with HTTP {}", slice.as_str(), res.status().as_u16());
                        break;
                    }
                    Ok(res) if res.status().is_success() => {
                        attempt = 0;
                        let mut stream = res.bytes_stream();
                        let mut parser = SseParser::default();
                        let mut pending: Vec<SseMessage> = Vec::new();
                        let mut closed_by_receiver = false;

                        loop {
                            let next = tokio::select! {
                                biased;
                                _ = task_cancel.cancelled() => None,
                                item = stream.next() => item,
                            };
                            let Some(chunk_res) = next else {
                                break;
                            };
                            let Ok(bytes) = chunk_res else {
                                break;
                            };
                            let text = String::from_utf8_lossy(&bytes);
                            parser.push(&text, &mut |msg| pending.push(msg));
                            for msg in pending.drain(..) {
                                let Ok(val) = serde_json::from_str::<Value>(&msg.data) else {
                                    continue;
                                };
                                let seq = msg
                                    .id
                                    .as_deref()
                                    .and_then(|id| id.trim().parse::<i64>().ok())
                                    .or_else(|| val.get("seq").and_then(Value::as_i64))
                                    .unwrap_or(0);
                                last_seq = Some(seq);
                                let sent = tokio::select! {
                                    biased;
                                    _ = task_cancel.cancelled() => Err(()),
                                    res = tx.send_async((seq, val)) => res.map_err(|_| ()),
                                };
                                if sent.is_err() {
                                    closed_by_receiver = true;
                                    break;
                                }
                            }
                            if closed_by_receiver || task_cancel.is_cancelled() {
                                break;
                            }
                        }
                        if closed_by_receiver {
                            break;
                        }
                    }
                    Ok(_) | Err(_) => {}
                }

                if task_cancel.is_cancelled() || tx.is_disconnected() {
                    break;
                }
                let delay = backoff_delay(attempt);
                attempt = attempt.saturating_add(1);
                tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => break,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        });

        enum Step {
            Stop,
            Item(i64, Value),
            Closed,
        }

        loop {
            let step = flume::Selector::new()
                .recv(stop, |_| Step::Stop)
                .recv(&rx, |res| match res {
                    Ok((seq, val)) => Step::Item(seq, val),
                    Err(_) => Step::Closed,
                })
                .wait();
            match step {
                Step::Item(seq, val) => receive(seq, &val),
                Step::Stop | Step::Closed => {
                    cancel.cancel();
                    break;
                }
            }
        }
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        let (tx, rx) = flume::unbounded::<LiveEvent>();
        let client = self.client.clone();
        let token = self.token.clone();
        let cancel = self.shutdown.child_token();
        let url = format!("{}/api/v1/live", self.base_url);

        vibevalley_runtime::rt::handle().spawn(async move {
            let mut attempt = 0usize;
            while !cancel.is_cancelled() && !tx.is_disconnected() {
                let req = attach_headers(client.get(&url).header("accept", "text/event-stream"), &token);
                let response = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    res = req.send() => res,
                };
                match response {
                    Ok(res) if res.status() == reqwest::StatusCode::UNAUTHORIZED || res.status() == reqwest::StatusCode::FORBIDDEN => {
                        break;
                    }
                    Ok(res) if res.status().is_success() => {
                        attempt = 0;
                        let mut stream = res.bytes_stream();
                        let mut parser = SseParser::default();
                        let mut pending: Vec<SseMessage> = Vec::new();
                        let mut disconnected = false;

                        loop {
                            let next = tokio::select! {
                                biased;
                                _ = cancel.cancelled() => None,
                                item = stream.next() => item,
                            };
                            let Some(chunk_res) = next else {
                                break;
                            };
                            let Ok(bytes) = chunk_res else {
                                break;
                            };
                            if tx.is_disconnected() {
                                disconnected = true;
                                break;
                            }
                            let text = String::from_utf8_lossy(&bytes);
                            parser.push(&text, &mut |msg| pending.push(msg));
                            for msg in pending.drain(..) {
                                if let Ok(event) = serde_json::from_str::<LiveEvent>(&msg.data)
                                    && tx.send(event).is_err()
                                {
                                    disconnected = true;
                                    break;
                                }
                            }
                            if disconnected || cancel.is_cancelled() {
                                break;
                            }
                        }
                        if disconnected {
                            break;
                        }
                    }
                    Ok(_) | Err(_) => {}
                }

                if cancel.is_cancelled() || tx.is_disconnected() {
                    break;
                }
                let delay = backoff_delay(attempt);
                attempt = attempt.saturating_add(1);
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        });

        rx
    }

    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let payload_json = serde_json::to_string(&if payload.is_null() { Value::Object(Default::default()) } else { payload }).unwrap_or_else(|_| "{}".into());

        let mut url = url::Url::parse(&format!("{}/api/v1/subscribe/{}", self.base_url, name))
            .map_err(|e| refusal(BizCode::InvalidInput, format!("invalid subscription URL: {e}")))?;
        url.query_pairs_mut().append_pair("payload", &payload_json);

        let client = self.client.clone();
        let token = self.token.clone();

        let response = vibevalley_runtime::rt::block_on(async move {
            let req = attach_headers(client.get(url).header("accept", "text/event-stream"), &token);
            let res = req
                .send()
                .await
                .map_err(|e| refusal(BizCode::ServiceUnavailable, format!("remote subscription unreachable: {e}")))?;
            let status = res.status();
            let is_json = res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|ct| ct.contains("application/json"));
            if !status.is_success() || is_json {
                let text = res.text().await.unwrap_or_default();
                return Err(parse_envelope_or_fallback(status, &text));
            }
            Ok(res)
        })?;

        let sub_id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        let cancel = self.shutdown.child_token();
        let (tx, rx) = flume::unbounded::<Value>();
        self.subs.lock().insert(sub_id, cancel.clone());
        let subs = self.subs.clone();

        vibevalley_runtime::rt::handle().spawn(async move {
            let mut stream = response.bytes_stream();
            let mut parser = SseParser::default();
            let mut pending: Vec<SseMessage> = Vec::new();
            loop {
                let next = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => None,
                    item = stream.next() => item,
                };
                let Some(chunk_res) = next else {
                    break;
                };
                let Ok(bytes) = chunk_res else {
                    break;
                };
                let text = String::from_utf8_lossy(&bytes);
                parser.push(&text, &mut |msg| pending.push(msg));
                let mut closed = false;
                for msg in pending.drain(..) {
                    if let Ok(val) = serde_json::from_str::<Value>(&msg.data)
                        && tx.send(val).is_err()
                    {
                        closed = true;
                        break;
                    }
                }
                if closed || cancel.is_cancelled() {
                    break;
                }
            }
            subs.lock().remove(&sub_id);
        });

        Ok((sub_id, rx))
    }

    fn unsubscribe(&self, id: u64) {
        if let Some(token) = self.subs.lock().remove(&id) {
            token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use vibevalley_protocol::{ApiError, BizCode, Issue, LiveEvent, NoticeLevel, RemoteDeviceSummary, RemotePlatform};
    use vibevalley_server::transport::api::{RemoteAuth, RemoteDeviceIdentity};
    use vibevalley_server::transport::bridge::fake::{FakeServer, empty_bundle};
    use vibevalley_server::transport::http;

    use super::*;
    use crate::hosted::connection::{ConnectionSaveRequest, configure_remote, exchange_pair_code};

    struct StaticRemoteAuth {
        expected_token: String,
    }

    impl RemoteAuth for StaticRemoteAuth {
        fn is_enabled(&self) -> bool {
            true
        }

        fn verify_bearer(&self, token: &str) -> Result<RemoteDeviceIdentity, ApiError> {
            if token == self.expected_token {
                Ok(RemoteDeviceIdentity {
                    device_id: "dev-mac".into(),
                    name: "Mac Client".into(),
                    scope: vibevalley_protocol::SCOPE_REMOTE_CLIENT.into(),
                })
            } else {
                Err(ApiError::new(BizCode::Unauthorized, "invalid bearer token"))
            }
        }
    }

    struct AuthedFake {
        inner: Arc<FakeServer>,
        auth: Arc<dyn RemoteAuth>,
    }

    impl Server for AuthedFake {
        fn call(&self, op: &str, payload: Value) -> Envelope {
            self.inner.call(op, payload)
        }

        fn slice_snapshot(&self, slice: SliceKind) -> Value {
            self.inner.slice_snapshot(slice)
        }

        fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
            self.inner.watch_slice(slice, after_seq, stop, receive);
        }

        fn live(&self) -> flume::Receiver<LiveEvent> {
            self.inner.live()
        }

        fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
            self.inner.subscribe(name, payload)
        }

        fn unsubscribe(&self, id: u64) {
            self.inner.unsubscribe(id);
        }

        fn remote_auth(&self) -> Option<Arc<dyn RemoteAuth>> {
            Some(self.auth.clone())
        }
    }

    #[test]
    fn sse_parser_handles_chunk_boundaries_crlf_comments_and_multiline_data() {
        let mut parser = SseParser::default();
        let mut messages = Vec::new();
        parser.push(": ping\r\nid: 7\r\ndata: {\"a\":\r", &mut |m| messages.push(m));
        assert!(messages.is_empty());
        parser.push("\ndata: 1}\r\n\r\ndata: second\n\n", &mut |m| messages.push(m));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id.as_deref(), Some("7"));
        assert_eq!(messages[0].data, "{\"a\":\n1}");
        assert_eq!(messages[1].id.as_deref(), Some("7"));
        assert_eq!(messages[1].data, "second");
    }

    #[test]
    fn remote_server_sends_bearer_and_client_headers_over_http() {
        let seen_headers = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_for_task = seen_headers.clone();

        let addr = vibevalley_runtime::rt::block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let req_text = String::from_utf8_lossy(&buf[..n]).to_string();
                seen_for_task.lock().push(req_text);
                let body = r#"{"bizCode":0,"message":"ok","data":{"ok":true,"version":"1.2.3"}}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(resp.as_bytes()).await;
            });
            addr
        });

        let remote = RemoteServer::new(
            format!("http://{addr}"),
            Secret::new("vv_dev_header_check_token_42"),
            Some("Test Remote".into()),
        )
        .unwrap();
        let debug = format!("{remote:?}");
        assert!(!debug.contains("vv_dev_header_check_token_42"));
        assert_eq!(remote.label.as_deref(), Some("Test Remote"));

        let env = remote.call("health", Value::Null);
        assert_eq!(env.biz_code, 0);
        assert_eq!(env.data.unwrap()["version"], "1.2.3");

        let captured = seen_headers.lock()[0].to_lowercase();
        assert!(captured.starts_with("post /api/v1/health "));
        assert!(
            captured.contains("authorization: bearer vv_dev_header_check_token_42"),
            "missing bearer header: {captured}"
        );
        assert!(captured.contains("x-vibevalley-client: remote"), "missing remote client header: {captured}");
    }

    #[test]
    fn remote_server_call_slice_live_and_subscribe_round_trip_against_remote_http_gate() {
        let token = "vv_dev_roundtrip_token_9999";
        let fake = Arc::new(FakeServer::from_bundle(empty_bundle(1)));
        fake.respond("machine.list", json!([{ "id": "local", "name": "Studio" }]));
        fake.respond(
            "remote.pair.exchange",
            json!({
                "device": RemoteDeviceSummary {
                    id: "dev-1".into(),
                    name: "Laptop".into(),
                    platform: RemotePlatform::Other,
                    scope: vibevalley_protocol::SCOPE_REMOTE_CLIENT.into(),
                    created_at: 1000,
                    last_seen_at: None,
                    revoked_at: None,
                },
                "token": token,
                "serverName": "Studio Mac",
                "version": "0.1.0",
            }),
        );

        let authed = Arc::new(AuthedFake {
            inner: fake.clone(),
            auth: Arc::new(StaticRemoteAuth { expected_token: token.into() }),
        });
        let listener = http::serve_remote(authed, ([127, 0, 0, 1], 0).into()).unwrap();
        let base_url = listener.url();

        // 1. Pair code exchange and configure_remote persistence.
        let exchanged = exchange_pair_code(&base_url, "123456", "Laptop").unwrap();
        assert_eq!(exchanged.token, token);
        assert_eq!(exchanged.server_name, "Studio Mac");

        let tmp = tempfile::tempdir().unwrap();
        let saved = configure_remote(
            tmp.path(),
            ConnectionSaveRequest {
                url: base_url.clone(),
                token: None,
                pair_code: Some("123456".into()),
                device_name: Some("Laptop".into()),
                label: None,
            },
        )
        .unwrap();
        assert_eq!(saved.label(), Some("Studio Mac"));

        // 2. Unauthorized token returns BizCode::Unauthorized.
        let wrong = RemoteServer::new(base_url.clone(), Secret::new("vv_dev_wrong_token"), None).unwrap();
        assert_eq!(wrong.call("machine.list", json!({})).biz_code, BizCode::Unauthorized.code());

        // 3. Authorized RPC call (sync + async) & slice_snapshot round-trip.
        let remote = Arc::new(RemoteServer::new(base_url, Secret::new(token), Some("Studio Mac".into())).unwrap());
        let res = remote.call("machine.list", json!({}));
        assert_eq!(res.biz_code, 0);
        assert_eq!(res.data.unwrap()[0]["name"], "Studio");

        let async_remote = remote.clone();
        let async_res =
            vibevalley_runtime::rt::block_on(async move { async_remote.call_with_async(CallerContext::local(), "machine.list".into(), json!({})).await });
        assert_eq!(async_res.biz_code, 0);
        assert_eq!(async_res.data.unwrap()[0]["name"], "Studio");

        let snap = remote.slice_snapshot(SliceKind::Board);
        assert_eq!(snap["seq"], 1);

        // 4. watch_slice SSE receives initial snapshot + live update and stops cleanly.
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        let seen_slices = Arc::new(Mutex::new(Vec::<(i64, Value)>::new()));
        let seen_for_watch = seen_slices.clone();
        let watcher_remote = RemoteServer::new(remote.base_url.clone(), Secret::new(token), None).unwrap();
        let handle = std::thread::spawn(move || {
            watcher_remote.watch_slice(SliceKind::Board, None, &stop_rx, &mut |seq, val| {
                seen_for_watch.lock().push((seq, val.clone()));
            });
        });

        let start = Instant::now();
        while seen_slices.lock().is_empty() {
            assert!(start.elapsed() < Duration::from_secs(5), "timed out waiting for initial SSE slice");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(seen_slices.lock()[0].0, 1);

        let mut next = empty_bundle(2);
        next.board.issues.push(Issue::new("i-remote", 1, "Remote Issue", 2));
        fake.swap_bundle(next);

        let start = Instant::now();
        while seen_slices.lock().len() < 2 {
            assert!(start.elapsed() < Duration::from_secs(5), "timed out waiting for updated SSE slice");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(seen_slices.lock().last().unwrap().0, 2);
        assert_eq!(seen_slices.lock().last().unwrap().1["issues"][0]["id"], "i-remote");
        drop(stop_tx);
        handle.join().unwrap();

        // 5. live SSE receives LiveEvent.
        let live_rx = remote.live();
        let start = Instant::now();
        while fake.live_watchers() == 0 {
            assert!(start.elapsed() < Duration::from_secs(5), "timed out waiting for live SSE attach");
            std::thread::sleep(Duration::from_millis(10));
        }
        let expected_notice = LiveEvent::Notice(vibevalley_protocol::LiveEventNotice {
            at: 42,
            level: NoticeLevel::Info,
            text: "hello remote".into(),
        });
        fake.push_live(expected_notice.clone());
        let ev = live_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(ev, expected_notice);
        drop(live_rx);

        // 6. subscribe SSE streams events, handles refusal, and unsubscribes cleanly.
        let (sub_id, sub_rx) = remote.subscribe("channel.follow", json!({ "id": "general", "after": 0 })).unwrap();
        fake.emit("channel.follow", json!({ "seq": 10, "text": "ping" }));
        let sub_ev = sub_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(sub_ev["seq"], 10);
        remote.unsubscribe(sub_id);

        let refused = remote.subscribe("fake.refuse", json!({})).unwrap_err();
        assert_eq!(refused.biz_code, 500001);

        drop(listener);
    }
}
