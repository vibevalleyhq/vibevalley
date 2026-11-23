//! The HTTP API (`/api/v1`) over the in-process server, so the clients
//! work against it unchanged: its CLI (`VIBEVALLEY_SERVER=…
//! vibevalley issue list`), scripts, and later the LAN and phone paths.
//!
//! Wire:
//! - `POST /api/v1/<op with . as />` with a JSON body → the envelope, HTTP
//!   status from the business code's `bizCodeMeta`;
//! - `GET /api/v1/slice/<name>`: JSON snapshot when `Accept` contains
//!   `application/json` or `?once=1`, otherwise SSE (`id: <seq>\ndata: <json>\n\n`,
//!   `: ping` every 20 s) honoring `Last-Event-ID` or `?after=<seq>`;
//! - `GET /api/v1/live` (`/api/v1/events`) as server-sent events;
//! - `GET /api/v1/subscribe/<name>?payload=<JSON>`: a refusal before the
//!   first event is a plain JSON error, then events;
//! - `GET /api/v1/issue/watch/<id>`: the `issue.watch` subscription; an
//!   empty 404 when it is refused;
//! - `GET /api/v1/attachment/<id>`: the stored file (`attachment.file`);
//! - `GET /api/v1/artifact/<id>/view?theme=…&path=…&elementId=…&print=1`:
//!   store artifact's rendered viewer with CSP headers (`artifact.view`);
//! - `GET /api/v1/artifact/<id>/<version>?shell=1&theme=…&print=1`:
//!   HTML artifact's page with the server's headers (`artifact.page`);
//! - only the machine's own pages: a loopback `Host`, and an `Origin` (when
//!   sent) equal to it, `Sec-Fetch-Site` same-origin or none (`from_the_farm`).

use std::convert::Infallible;
use std::io::{self, SeekFrom};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{FromRef, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::task::JoinHandle;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{ApiError, BizCode, Caller, Envelope, SliceKind};

use crate::transport::api::{CallerContext, CallerPrincipal, ClientIdentity, ClientKind, Server};

mod machine_ws;
mod media;

const HEARTBEAT: Duration = Duration::from_secs(20);

type Shared = Arc<dyn Server>;

#[derive(Clone)]
pub(super) struct HttpState {
    pub(super) server: Shared,
    pub(super) shutdown: CancellationToken,
    pub(super) is_remote: bool,
}

impl FromRef<HttpState> for Shared {
    fn from_ref(state: &HttpState) -> Self {
        state.server.clone()
    }
}

/// True when explicit `VIBEVALLEY_REMOTE_ALLOW_ALL=1` permits binding any IP
/// (e.g., `0.0.0.0` behind an explicit reverse proxy or LAN deployment).
pub fn is_remote_allow_all() -> bool {
    std::env::var("VIBEVALLEY_REMOTE_ALLOW_ALL").ok().as_deref() == Some("1")
}

/// True for addresses the remote listener is allowed to bind:
/// loopback (`127.0.0.1` / `::1`), Tailscale CGNAT (`100.64.0.0/10`),
/// private RFC1918 LAN IPv4, or IPv6 ULA (`fc00::/7`).
/// Refuses unspecified (`0.0.0.0`, `::`) and public internet addresses unless
/// `VIBEVALLEY_REMOTE_ALLOW_ALL=1` is set explicitly.
pub fn is_allowed_remote_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || (v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 64),
        std::net::IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// A running listener on the shared `vibevalley-io` runtime. Dropping it
/// gracefully stops the server task and ends active SSE streams.
pub struct Listener {
    pub addr: SocketAddr,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl Listener {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.take() {
            let _ = vibevalley_runtime::rt::block_on(task);
        }
    }
}

/// Serves `server` on `addr` (use port 0 for any free port) as a task on the
/// shared `vibevalley-io` runtime. Only loopback addresses are accepted: this
/// is not a network service.
pub fn serve(server: Shared, addr: SocketAddr) -> std::io::Result<Listener> {
    if !addr.ip().is_loopback() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "loopback addresses only"));
    }
    bind_and_serve(server, addr, false)
}

/// Serves `server` for remote clients on `addr` (Tailscale CGNAT, loopback,
/// or private LAN / ULA by default; any address when `VIBEVALLEY_REMOTE_ALLOW_ALL=1`).
/// Every request requires a valid paired-device Bearer token except `POST /api/v1/remote/pair/exchange`.
pub fn serve_remote(server: Shared, addr: SocketAddr) -> std::io::Result<Listener> {
    if !is_allowed_remote_ip(addr.ip()) && !is_remote_allow_all() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "remote listener allows loopback, Tailscale, or private LAN addresses only",
        ));
    }
    bind_and_serve(server, addr, true)
}

fn bind_and_serve(server: Shared, addr: SocketAddr, is_remote: bool) -> std::io::Result<Listener> {
    let std_listener = std::net::TcpListener::bind(addr)?;
    std_listener.set_nonblocking(true)?;
    let addr = std_listener.local_addr()?;
    let listener = {
        let _guard = vibevalley_runtime::rt::handle().enter();
        tokio::net::TcpListener::from_std(std_listener)?
    };
    let shutdown = CancellationToken::new();
    let app = router_with_shutdown(server, shutdown.clone(), is_remote);
    let token = shutdown.clone();
    let task = vibevalley_runtime::rt::handle().spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(token.cancelled_owned()).await;
    });
    Ok(Listener {
        addr,
        shutdown,
        task: Some(task),
    })
}

pub fn router(server: Shared) -> Router {
    router_with_shutdown(server, CancellationToken::new(), false)
}

fn router_with_shutdown(server: Shared, shutdown: CancellationToken, is_remote: bool) -> Router {
    let state = HttpState { server, shutdown, is_remote };
    Router::new()
        // Each GET path also matches ops of the same shape (POST
        // attachment/create, artifact/block/list): those go to `command`.
        .route("/api/v1/slice/{name}", get(slice).post(command))
        .route("/api/v1/machine/ws", get(machine_ws::upgrade).post(command))
        .route("/api/v1/live", get(live).post(command))
        .route("/api/v1/events", get(live).post(command))
        .route("/api/v1/subscribe/{name}", get(subscribe).post(command))
        .route("/api/v1/issue/watch/{id}", get(issue_watch).post(command))
        .route("/api/v1/attachment/{id}", get(attachment).post(command))
        .route("/api/v1/artifact/{id}/view", get(artifact_view).post(command))
        .route("/api/v1/artifact/{id}/{version}", get(artifact_page).post(command))
        .route("/api/v1/media/input/{id}/content", get(media::content).put(media::upload).post(command))
        .route("/api/v1/media/speech/{id}/stream", get(media::speech).post(command))
        .route("/api/v1/{*path}", post(command).get(not_allowed))
        .route("/mcp", post(mcp).get(not_allowed))
        .fallback(not_found)
        .with_state(state)
}

fn is_loopback(host: &str) -> bool {
    let Some(rest) = host
        .strip_prefix("127.0.0.1")
        .or_else(|| host.strip_prefix("localhost"))
        .or_else(|| host.strip_prefix("[::1]"))
    else {
        return false;
    };
    match rest.strip_prefix(':') {
        None => rest.is_empty(),
        Some(port) => !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// Only this machine's own pages and tools.
pub fn from_the_farm(headers: &HeaderMap) -> bool {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let host = header("host").unwrap_or("");
    let origin_ok = header("origin").is_none_or(|o| o == format!("http://{host}"));
    let site_ok = header("sec-fetch-site").is_none_or(|s| s == "same-origin" || s == "none");
    is_loopback(host) && origin_ok && site_ok
}

fn http_caller_context(headers: &HeaderMap) -> CallerContext {
    let is_cli = headers
        .get("x-vibevalley-client")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("cli"));
    let (id, kind, label) = if is_cli {
        ("cli", ClientKind::Cli, "CLI")
    } else {
        ("http-loopback", ClientKind::HttpLoopback, "HTTP loopback")
    };
    CallerContext {
        caller: Caller::User,
        principal: CallerPrincipal::LocalOwner,
        client: Some(ClientIdentity {
            id: id.into(),
            kind,
            label: label.into(),
        }),
        trace_id: 0,
    }
}

/// The envelope as VibeValley sends it, with the HTTP status its code has.
fn reply(envelope: Envelope) -> Response {
    let status = if envelope.biz_code == 0 {
        StatusCode::OK
    } else {
        BizCode::from_code(envelope.biz_code)
            .and_then(|c| StatusCode::from_u16(c.meta().status).ok())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
    };
    let body = serde_json::to_vec(&envelope).unwrap_or_default();
    (status, [("content-type", "application/json; charset=utf-8")], body).into_response()
}

fn refuse(code: BizCode, message: impl Into<String>) -> Response {
    reply(Envelope::failure(&ApiError::new(code, message)))
}

async fn not_found() -> Response {
    refuse(BizCode::RouteNotFound, "no such route")
}

async fn not_allowed() -> Response {
    refuse(BizCode::MethodNotAllowed, "use POST")
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get("authorization")?.to_str().ok()?.trim();
    if raw.eq_ignore_ascii_case("bearer") {
        return Some("");
    }
    let (scheme, token) = raw.split_once(char::is_whitespace)?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

async fn authenticate(state: &HttpState, headers: &HeaderMap, path: &str) -> Result<CallerContext, ApiError> {
    authenticate_with_token(state, headers, None, path).await
}

async fn authenticate_with_token(state: &HttpState, headers: &HeaderMap, query_token: Option<&str>, path: &str) -> Result<CallerContext, ApiError> {
    let token = bearer_token(headers).or_else(|| query_token.map(str::trim).filter(|t| !t.is_empty()));
    if let Some(token) = token {
        let Some(auth) = state.server.remote_auth() else {
            return Err(ApiError::new(BizCode::Unauthorized, vibevalley_i18n::t("server.remote.unauthorized", &[])));
        };
        let identity = auth.verify_bearer_async(token.to_string()).await?;
        return Ok(CallerContext {
            caller: Caller::Remote,
            principal: CallerPrincipal::RemoteDevice {
                device_id: identity.device_id.clone(),
                scope: identity.scope,
            },
            client: Some(ClientIdentity {
                id: identity.device_id,
                kind: ClientKind::RemoteDevice,
                label: identity.name,
            }),
            trace_id: 0,
        });
    }
    if path.trim_end_matches('/') == "/api/v1/remote/pair/exchange" && state.server.remote_auth().is_some_and(|a| a.is_enabled()) {
        return Ok(CallerContext {
            caller: Caller::Remote,
            principal: CallerPrincipal::RemoteDevice {
                device_id: String::new(),
                scope: String::new(),
            },
            client: Some(ClientIdentity {
                id: "remote-pairing".into(),
                kind: ClientKind::RemoteDevice,
                label: "Remote pairing".into(),
            }),
            trace_id: 0,
        });
    }
    if !state.is_remote && from_the_farm(headers) {
        return Ok(http_caller_context(headers));
    }
    Err(ApiError::new(BizCode::Forbidden, "forbidden"))
}

/// A helper's MCP messages (streamable HTTP, answered as plain JSON): one
/// message or a batch. Notifications alone are answered 202.
async fn mcp(State(state): State<HttpState>, headers: HeaderMap, body: Bytes) -> Response {
    let token = bearer_token(&headers).unwrap_or("").to_string();
    if state.is_remote || !from_the_farm(&headers) || token.starts_with("vv_dev_") {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let Some(door) = state.server.mcp() else {
        return refuse(BizCode::ServiceUnavailable, "no MCP here");
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        let error = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
        return (StatusCode::BAD_REQUEST, axum::Json(error)).into_response();
    };
    let answered = tokio::task::spawn_blocking(move || match message {
        Value::Array(batch) => {
            let answers: Vec<Value> = batch.into_iter().filter_map(|m| door.message(&token, m)).collect();
            if answers.is_empty() { None } else { Some(Value::Array(answers)) }
        }
        one => door.message(&token, one),
    })
    .await
    .unwrap_or(None);
    match answered {
        Some(answer) => (StatusCode::OK, axum::Json(answer)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// The op is read from the URL, not a route parameter: the GET routes
/// hand their POSTs here too.
async fn command(State(state): State<HttpState>, uri: axum::http::Uri, headers: HeaderMap, body: Bytes) -> Response {
    let ctx = match authenticate(&state, &headers, uri.path()).await {
        Ok(ctx) => ctx,
        Err(err) => return reply(Envelope::failure(&err)),
    };
    let path = uri.path().strip_prefix("/api/v1/").unwrap_or_default();
    let op = path.trim_matches('/').replace('/', ".");
    if vibevalley_protocol::NATIVE_ENDPOINTS.iter().any(|endpoint| endpoint.op == op) {
        return refuse(BizCode::RouteNotFound, "this operation is only available in the native app");
    }
    let payload = if body.is_empty() {
        Value::Object(Default::default())
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return refuse(BizCode::InvalidInput, e.to_string()),
        }
    };
    reply(state.server.call_with_async(ctx, op, payload).await)
}

/// A flume receiver as an SSE stream of `data:` lines, ending on `shutdown`.
fn events<T: serde::Serialize + Send + 'static>(rx: flume::Receiver<T>, shutdown: CancellationToken) -> impl Stream<Item = Result<Event, Infallible>> {
    futures_util::stream::unfold((rx, shutdown), |(rx, shutdown)| async move {
        let item = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return None,
            res = rx.recv_async() => res.ok()?,
        };
        let data = serde_json::to_string(&item).unwrap_or_else(|_| "null".into());
        Some((Ok(Event::default().data(data)), (rx, shutdown)))
    })
}

fn sse<S: Stream<Item = Result<Event, Infallible>> + Send + 'static>(stream: S) -> Response {
    Sse::new(stream).keep_alive(KeepAlive::new().interval(HEARTBEAT).text("ping")).into_response()
}

/// `GET /api/v1/slice/{name}`: JSON snapshot when `Accept` contains
/// `application/json` or `?once=1`; otherwise SSE (`id: <seq>\ndata: <json>\n\n`)
/// honoring `Last-Event-ID` or `?after=<seq>` over `WatchStream` with zero
/// blocking OS threads per client.
async fn slice(
    State(state): State<HttpState>,
    uri: axum::http::Uri,
    Path(name): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = authenticate(&state, &headers, uri.path()).await {
        return reply(Envelope::failure(&err));
    }
    let Some(kind) = SliceKind::from_str(&name) else {
        return refuse(BizCode::RouteNotFound, format!("unknown slice {name}"));
    };
    let wants_json = query.get("once").map(String::as_str) == Some("1")
        || headers
            .get("accept")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|accept| accept.contains("application/json"));
    if wants_json {
        let server = state.server.clone();
        let json = match tokio::task::spawn_blocking(move || server.slice_snapshot_json(kind)).await {
            Ok(v) => v,
            Err(e) => return refuse(BizCode::InternalError, e.to_string()),
        };
        return (StatusCode::OK, [("content-type", "application/json; charset=utf-8")], json.as_bytes().to_vec()).into_response();
    }
    let after_seq = query.get("after").and_then(|v| v.trim().parse::<i64>().ok()).or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<i64>().ok())
    });

    let server = state.server.clone();
    let subscribed = match tokio::task::spawn_blocking(move || server.subscribe_slice(kind)).await {
        Ok(sub) => sub,
        Err(e) => return refuse(BizCode::InternalError, e.to_string()),
    };
    if let Some(sub) = subscribed {
        let topic = sub.topic();
        let watch_stream = sub.into_json_watch_stream(after_seq);
        let server = state.server;
        let shutdown = state.shutdown;
        let stream = futures_util::stream::unfold((watch_stream, server, shutdown), move |(mut watch_stream, server, shutdown)| async move {
            let (seq, json_str) = tokio::select! {
                biased;
                _ = shutdown.cancelled() => return None,
                item = watch_stream.next() => item?,
            };
            if let Some(gate) = server.fault_gate() {
                if gate.should_disconnect(topic) {
                    return None;
                }
                let delay = gate.delay_ms(topic);
                if delay > 0 {
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => return None,
                        _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                    }
                }
            }
            let event = Event::default().id(seq.to_string()).data(&*json_str);
            Some((Ok::<_, Infallible>(event), (watch_stream, server, shutdown)))
        });
        return sse(stream);
    }

    // Fallback for custom `Server` implementations without a `SliceFeed` (e.g. test doubles).
    let (stop_tx, stop_rx) = flume::bounded::<()>(0);
    let (tx, rx) = flume::bounded::<(i64, String)>(1);
    let watch_server = state.server;
    tokio::task::spawn_blocking(move || {
        watch_server.watch_slice(kind, after_seq, &stop_rx, &mut |seq, value| {
            let data = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
            flume::Selector::new().send(&tx, (seq, data), |_| ()).recv(&stop_rx, |_| ()).wait();
        });
    });
    let shutdown = state.shutdown;
    let stream = futures_util::stream::unfold((rx, stop_tx, shutdown), |(rx, stop_tx, shutdown)| async move {
        let (seq, data) = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return None,
            res = rx.recv_async() => res.ok()?,
        };
        let event = Event::default().id(seq.to_string()).data(data);
        Some((Ok::<_, Infallible>(event), (rx, stop_tx, shutdown)))
    });
    sse(stream)
}

async fn live(State(state): State<HttpState>, uri: axum::http::Uri, headers: HeaderMap) -> Response {
    if let Err(err) = authenticate(&state, &headers, uri.path()).await {
        return reply(Envelope::failure(&err));
    }
    if let Some(rx) = state.server.subscribe_live() {
        let bstream = BroadcastStream::new(rx);
        let shutdown = state.shutdown;
        let stream = futures_util::stream::unfold((bstream, shutdown), |(mut bstream, shutdown)| async move {
            loop {
                let next = tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => return None,
                    item = bstream.next() => item?,
                };
                match next {
                    Ok(ev) => {
                        let data = serde_json::to_string(&ev).unwrap_or_else(|_| "null".into());
                        return Some((Ok::<_, Infallible>(Event::default().data(data)), (bstream, shutdown)));
                    }
                    Err(BroadcastStreamRecvError::Lagged(_)) => continue,
                }
            }
        });
        return sse(stream);
    }
    sse(events(state.server.live(), state.shutdown))
}

/// Unsubscribes when the client goes away (the stream is dropped).
struct Subscription {
    server: Shared,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.server.unsubscribe(self.id);
    }
}

#[allow(clippy::result_large_err, reason = "Server::subscribe's contract returns the refusal envelope itself")]
async fn subscribe(
    State(state): State<HttpState>,
    uri: axum::http::Uri,
    Path(name): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match authenticate(&state, &headers, uri.path()).await {
        Ok(ctx) => ctx,
        Err(err) => return reply(Envelope::failure(&err)),
    };
    let payload = match serde_json::from_str::<Value>(query.get("payload").map(String::as_str).unwrap_or("{}")) {
        Ok(v) => v,
        Err(e) => return refuse(BizCode::InvalidInput, e.to_string()),
    };
    match open(state.server, state.shutdown, ctx, name, payload).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(envelope)) => reply(envelope),
        Err(e) => refuse(BizCode::InternalError, e.to_string()),
    }
}

fn is_artifact_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

fn is_artifact_version(version: &str) -> bool {
    let mut bytes = version.bytes();
    matches!(bytes.next(), Some(b'1'..=b'9')) && bytes.all(|b| b.is_ascii_digit())
}

/// VibeValley's `artifact/:id/view`: what a structured store artifact's `<iframe src>` loads.
async fn artifact_view(
    State(state): State<HttpState>,
    uri: axum::http::Uri,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match authenticate(&state, &headers, uri.path()).await {
        Ok(ctx) => ctx,
        Err(err) => return reply(Envelope::failure(&err)),
    };
    let server = state.server;
    if !is_artifact_id(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut payload = serde_json::json!({ "id": id });
    if let Some(theme) = query.get("theme") {
        payload["theme"] = theme.clone().into();
    }
    if let Some(path) = query.get("path") {
        payload["path"] = path.clone().into();
    }
    if let Some(element_id) = query.get("elementId") {
        payload["elementId"] = element_id.clone().into();
    }
    if query.get("print").map(String::as_str) == Some("1") {
        payload["print"] = true.into();
    }
    if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok())
        && !host.is_empty()
    {
        payload["origin"] = format!("http://{host}").into();
    }
    let envelope = server.call_with_async(ctx, "artifact.view".into(), payload).await;
    if envelope.biz_code == BizCode::ArtifactNotFound.code() || envelope.biz_code == BizCode::ArtifactRefused.code() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if envelope.biz_code != 0 {
        return reply(envelope);
    }
    let data = envelope.data.unwrap_or_default();
    let mut response = data["content"].as_str().unwrap_or_default().to_string().into_response();
    if let Some(map) = data["headers"].as_object() {
        for (name, value) in map {
            if let (Ok(name), Some(Ok(value))) = (
                axum::http::HeaderName::try_from(name.as_str()),
                value.as_str().map(axum::http::HeaderValue::try_from),
            ) {
                response.headers_mut().insert(name, value);
            }
        }
    }
    response
}

/// VibeValley's `artifactContent`: what an `<iframe src>` loads.
async fn artifact_page(
    State(state): State<HttpState>,
    uri: axum::http::Uri,
    Path((id, version)): Path<(String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match authenticate(&state, &headers, uri.path()).await {
        Ok(ctx) => ctx,
        Err(err) => return reply(Envelope::failure(&err)),
    };
    let server = state.server;
    let Some(version) = is_artifact_version(&version).then(|| version.parse::<u64>().ok()).flatten() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !is_artifact_id(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut payload = serde_json::json!({ "id": id, "version": version });
    if query.get("shell").map(String::as_str) == Some("1") {
        payload["shell"] = true.into();
    }
    if let Some(theme) = query.get("theme") {
        payload["theme"] = theme.clone().into();
    }
    if query.get("print").map(String::as_str) == Some("1") {
        payload["print"] = true.into();
    }
    let envelope = server.call_with_async(ctx, "artifact.page".into(), payload).await;
    if envelope.biz_code == BizCode::ArtifactNotFound.code() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if envelope.biz_code != 0 {
        return reply(envelope);
    }
    let data = envelope.data.unwrap_or_default();
    let mut response = data["content"].as_str().unwrap_or_default().to_string().into_response();
    if let Some(map) = data["headers"].as_object() {
        for (name, value) in map {
            if let (Ok(name), Some(Ok(value))) = (
                axum::http::HeaderName::try_from(name.as_str()),
                value.as_str().map(axum::http::HeaderValue::try_from),
            ) {
                response.headers_mut().insert(name, value);
            }
        }
    }
    response
}

fn parse_byte_range(text: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let (a, b) = text.trim().strip_prefix("bytes=")?.split_once('-')?;
    let parse_u64 = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse::<u64>().ok()
        } else {
            None
        }
    };
    let (start, end) = if a.is_empty() {
        let suffix = parse_u64(b)?;
        if suffix == 0 {
            return None;
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = parse_u64(a)?;
        let end = if b.is_empty() { size - 1 } else { parse_u64(b)?.min(size - 1) };
        (start, end)
    };
    (start <= end && start < size).then_some((start, end))
}

async fn attachment(
    State(state): State<HttpState>,
    uri: axum::http::Uri,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match authenticate_with_token(&state, &headers, query.get("token").map(String::as_str), uri.path()).await {
        Ok(ctx) => ctx,
        Err(err) => return reply(Envelope::failure(&err)),
    };
    let server = state.server;
    let envelope = server.call_with_async(ctx, "attachment.file".into(), serde_json::json!({ "id": id })).await;
    if envelope.biz_code != 0 {
        return reply(envelope);
    }
    let data = envelope.data.unwrap_or_default();
    let (Some(path), kind) = (data["path"].as_str(), data["type"].as_str().unwrap_or("application/octet-stream")) else {
        return refuse(BizCode::InternalError, "attachment.file answered no path");
    };
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) => return refuse(BizCode::NotFound, e.to_string()),
    };
    let size = match file.metadata().await {
        Ok(meta) => meta.len(),
        Err(e) => return refuse(BizCode::NotFound, e.to_string()),
    };
    let name = data["name"].as_str().unwrap_or_default().replace(['"', '\\', '\r', '\n'], "_");
    let range_header = headers.get("range");
    if size == 0 {
        if range_header.is_some() {
            return (StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", "bytes */0")]).into_response();
        }
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", kind)
            .header("content-length", 0)
            .header("accept-ranges", "bytes")
            .header("content-disposition", format!("inline; filename=\"{name}\""))
            .header("cache-control", "private, max-age=31536000, immutable")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let (status, start, end) = match range_header {
        Some(value) => {
            let Some((start, end)) = value.to_str().ok().and_then(|s| parse_byte_range(s, size)) else {
                return (StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", format!("bytes */{size}"))]).into_response();
            };
            (StatusCode::PARTIAL_CONTENT, start, end)
        }
        None => (StatusCode::OK, 0, size - 1),
    };
    if start > 0
        && let Err(e) = file.seek(SeekFrom::Start(start)).await
    {
        return refuse(BizCode::InternalError, e.to_string());
    }
    let length = end - start + 1;
    let stream = futures_util::stream::try_unfold((file, length), |(mut file, left)| async move {
        if left == 0 {
            return Ok::<_, io::Error>(None);
        }
        let mut buf = vec![0u8; left.min(64 * 1024) as usize];
        let n = file.read(&mut buf).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "attachment truncated"));
        }
        buf.truncate(n);
        Ok(Some((Bytes::from(buf), (file, left - n as u64))))
    });
    let mut response = Response::builder()
        .status(status)
        .header("content-type", kind)
        .header("content-length", length)
        .header("accept-ranges", "bytes")
        .header("content-disposition", format!("inline; filename=\"{name}\""))
        .header("cache-control", "private, max-age=31536000, immutable");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header("content-range", format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn issue_watch(State(state): State<HttpState>, uri: axum::http::Uri, Path(id): Path<String>, headers: HeaderMap) -> Response {
    let ctx = match authenticate(&state, &headers, uri.path()).await {
        Ok(ctx) => ctx,
        Err(err) => return reply(Envelope::failure(&err)),
    };
    match open(state.server, state.shutdown, ctx, "issue.watch".into(), serde_json::json!({ "id": id })).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(envelope)) if envelope.biz_code == BizCode::Forbidden.code() || envelope.biz_code == BizCode::Unauthorized.code() => reply(envelope),
        Ok(Err(_)) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => refuse(BizCode::InternalError, e.to_string()),
    }
}

/// Opens `name` off the async runtime with `ctx`; `Ok(Ok)` is the event stream,
/// which unsubscribes when the client goes away.
#[allow(clippy::result_large_err, reason = "Server::subscribe's contract returns the refusal envelope itself")]
async fn open(
    server: Shared,
    shutdown: CancellationToken,
    ctx: CallerContext,
    name: String,
    payload: Value,
) -> Result<Result<Response, Envelope>, tokio::task::JoinError> {
    let opened = {
        let server = server.clone();
        tokio::task::spawn_blocking(move || server.subscribe_with(&ctx, &name, payload)).await?
    };
    Ok(match opened {
        Ok((id, rx)) => {
            let guard = Subscription { server, id };
            let stream = futures_util::stream::unfold((rx, guard, shutdown), |(rx, guard, shutdown)| async move {
                let item = tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => return None,
                    res = rx.recv_async() => res.ok()?,
                };
                let data = serde_json::to_string(&item).unwrap_or_else(|_| "null".into());
                Some((Ok::<_, Infallible>(Event::default().data(data)), (rx, guard, shutdown)))
            });
            Ok(sse(stream))
        }
        Err(envelope) => Err(envelope),
    })
}

#[cfg(test)]
mod tests;
