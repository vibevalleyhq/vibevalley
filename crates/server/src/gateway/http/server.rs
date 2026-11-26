use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::handler::Handler as _;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
use vibevalley_protocol::{BizCode, Envelope, SliceKind};

use super::auth::{Authenticated, AuthenticatedQuery, LocalOnly, bearer_token};
use super::machine_ws;
use super::media;
use super::shared::{FileRangeSpec, FileServeError, HttpState, Shared, refuse, reply, serve_file_range};
use crate::gateway::api::{CallerContext, GatewayPorts};

const HEARTBEAT: Duration = Duration::from_secs(20);
const MAX_JSON_BODY_BYTES: usize = 16 * 1024 * 1024;

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
/// cancels the server task and ends active SSE streams; call [`Self::shutdown`]
/// to await graceful drain.
pub struct Listener {
    pub addr: SocketAddr,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl Listener {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Gracefully stops the listener task and ends active SSE streams asynchronously.
    pub async fn shutdown(mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

/// Serves `server` on `addr` (use port 0 for any free port) as a task on the
/// shared `vibevalley-io` runtime. Only loopback addresses are accepted: this
/// is not a network service.
pub fn serve(server: Shared, addr: SocketAddr) -> std::io::Result<Listener> {
    if !addr.ip().is_loopback() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "loopback addresses only"));
    }
    bind_and_serve(server, None, addr, false)
}

/// Like [`serve`], explicitly supplying non-RPC [`GatewayPorts`] so `Router`
/// does not need to carry them.
pub fn serve_with_ports(server: Shared, ports: GatewayPorts, addr: SocketAddr) -> std::io::Result<Listener> {
    if !addr.ip().is_loopback() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "loopback addresses only"));
    }
    bind_and_serve(server, Some(ports), addr, false)
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
    bind_and_serve(server, None, addr, true)
}

/// Like [`serve_remote`], explicitly supplying non-RPC [`GatewayPorts`].
pub fn serve_remote_with_ports(server: Shared, ports: GatewayPorts, addr: SocketAddr) -> std::io::Result<Listener> {
    if !is_allowed_remote_ip(addr.ip()) && !is_remote_allow_all() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "remote listener allows loopback, Tailscale, or private LAN addresses only",
        ));
    }
    bind_and_serve(server, Some(ports), addr, true)
}

fn bind_and_serve(server: Shared, ports: Option<GatewayPorts>, addr: SocketAddr, is_remote: bool) -> std::io::Result<Listener> {
    let std_listener = std::net::TcpListener::bind(addr)?;
    std_listener.set_nonblocking(true)?;
    let addr = std_listener.local_addr()?;
    let handle = vibevalley_runtime::rt::current_or_global_handle();
    let listener = {
        let _guard = handle.enter();
        tokio::net::TcpListener::from_std(std_listener)?
    };
    let shutdown = CancellationToken::new();
    let app = router_with_shutdown(server, ports, shutdown.clone(), is_remote);
    let token = shutdown.clone();
    let task = handle.spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(token.cancelled_owned()).await;
    });
    Ok(Listener {
        addr,
        shutdown,
        task: Some(task),
    })
}

pub fn router(server: Shared) -> Router {
    router_with_shutdown(server, None, CancellationToken::new(), false)
}

pub fn router_with_ports(server: Shared, ports: GatewayPorts) -> Router {
    router_with_shutdown(server, Some(ports), CancellationToken::new(), false)
}

fn authenticated_api_routes() -> Router<HttpState> {
    // Each GET path also matches ops of the same shape (POST
    // attachment/create, artifact/block/list): those go to `command`.
    Router::new()
        .route("/api/v1/slice/{name}", get(slice).post(command))
        .route("/api/v1/live", get(live).post(command))
        .route("/api/v1/events", get(live).post(command))
        .route("/api/v1/subscribe/{name}", get(subscribe).post(command))
        .route("/api/v1/issue/watch/{id}", get(issue_watch).post(command))
        .route("/api/v1/attachment/{id}", get(attachment).post(command))
        .route("/api/v1/{*path}", post(command).get(not_allowed))
}

fn machine_routes() -> Router<HttpState> {
    Router::new().route("/api/v1/machine/ws", get(machine_ws::upgrade).post(command))
}

fn local_only_routes() -> Router<HttpState> {
    Router::new()
        .route(
            "/api/v1/media/input/{id}/content",
            get(media::content)
                // Streaming uploads enforce their own 512 MB cap in `media::upload`.
                .put(media::upload.layer(DefaultBodyLimit::disable()))
                .post(command),
        )
        .route("/api/v1/media/speech/{id}/stream", get(media::speech).post(command))
        .route("/mcp", post(mcp).get(not_allowed))
}

async fn trace_request(req: Request, next: Next) -> Response {
    let span = tracing::debug_span!("http.request", method = %req.method(), path = %req.uri().path());
    next.run(req).instrument(span).await
}

fn router_with_shutdown(server: Shared, ports: Option<GatewayPorts>, shutdown: CancellationToken, is_remote: bool) -> Router {
    let state = HttpState {
        server,
        ports,
        shutdown,
        is_remote,
    };
    Router::new()
        .merge(authenticated_api_routes())
        .merge(machine_routes())
        .merge(local_only_routes())
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .layer(middleware::from_fn(trace_request))
        .with_state(state)
}

async fn not_found() -> Response {
    refuse(BizCode::RouteNotFound, "no such route")
}

async fn not_allowed() -> Response {
    refuse(BizCode::MethodNotAllowed, "use POST")
}

/// A helper's MCP messages (streamable HTTP, answered as plain JSON): one
/// message or a batch. Notifications alone are answered 202.
async fn mcp(State(state): State<HttpState>, _local: LocalOnly, headers: HeaderMap, body: Bytes) -> Response {
    let token = bearer_token(&headers).unwrap_or("").to_string();
    if token.starts_with("vv_dev_") {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let Some(door) = state.ports().mcp else {
        return refuse(BizCode::ServiceUnavailable, "no MCP here");
    };
    let Ok(message_json) = std::str::from_utf8(&body) else {
        let error = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
        return (StatusCode::BAD_REQUEST, axum::Json(error)).into_response();
    };
    match crate::gateway::api::dispatch_mcp_message_async(door, token, message_json.to_string()).await {
        Ok(Some(answer_json)) => (StatusCode::OK, [("content-type", "application/json")], answer_json).into_response(),
        Ok(None) => StatusCode::ACCEPTED.into_response(),
        Err(_) => {
            let error = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
            (StatusCode::BAD_REQUEST, axum::Json(error)).into_response()
        }
    }
}

/// The op is read from the URL, not a route parameter: the GET routes
/// hand their POSTs here too.
async fn command(State(state): State<HttpState>, Authenticated(ctx): Authenticated, uri: axum::http::Uri, body: Bytes) -> Response {
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

/// Wraps an SSE event stream with cooperative shutdown cancellation and heartbeat pings.
fn sse_with_shutdown<S>(stream: S, shutdown: CancellationToken) -> Response
where
    S: Stream<Item = Event> + Send + 'static,
{
    let guarded = stream.take_until(shutdown.cancelled_owned()).map(Ok::<Event, Infallible>);
    Sse::new(guarded).keep_alive(KeepAlive::new().interval(HEARTBEAT).text("ping")).into_response()
}

/// `GET /api/v1/slice/{name}`: JSON snapshot when `Accept` contains
/// `application/json` or `?once=1`; otherwise SSE (`id: <seq>\ndata: <json>\n\n`)
/// honoring `Last-Event-ID` or `?after=<seq>` over `WatchStream` with zero
/// blocking OS threads per client.
async fn slice(
    State(state): State<HttpState>,
    _auth: Authenticated,
    Path(name): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let Some(kind) = SliceKind::from_str(&name) else {
        return refuse(BizCode::RouteNotFound, format!("unknown slice {name}"));
    };
    let wants_json = query.get("once").map(String::as_str) == Some("1")
        || headers
            .get("accept")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|accept| accept.contains("application/json"));
    if wants_json {
        let json = state.server.slice_snapshot_json_async(kind).await;
        return (StatusCode::OK, [("content-type", "application/json; charset=utf-8")], json.as_bytes().to_vec()).into_response();
    }
    let after_seq = query.get("after").and_then(|v| v.trim().parse::<i64>().ok()).or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<i64>().ok())
    });

    if let Some(sub) = state.server.clone().subscribe_slice_async(kind).await {
        let topic = sub.topic();
        let watch_stream = sub.into_json_watch_stream(after_seq);
        let server = state.server;
        let stream = watch_stream
            .then(move |(seq, json_str)| {
                let server = server.clone();
                async move {
                    if let Some(gate) = server.fault_gate() {
                        if gate.should_disconnect(topic) {
                            return None;
                        }
                        let delay = gate.delay_ms(topic);
                        if delay > 0 {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                    }
                    Some(Event::default().id(seq.to_string()).data(&*json_str))
                }
            })
            .take_while(|ev| std::future::ready(ev.is_some()))
            .filter_map(std::future::ready);
        return sse_with_shutdown(stream, state.shutdown);
    }

    refuse(BizCode::ServiceUnavailable, format!("slice stream unavailable for {name}"))
}

async fn live(State(state): State<HttpState>, _auth: Authenticated) -> Response {
    if let Some(rx) = state.server.subscribe_live() {
        let stream = BroadcastStream::new(rx).filter_map(|next| {
            let event = match next {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_else(|_| "null".into());
                    Some(Event::default().data(data))
                }
                Err(BroadcastStreamRecvError::Lagged(_)) => None,
            };
            std::future::ready(event)
        });
        return sse_with_shutdown(stream, state.shutdown);
    }
    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(state.server.live()).map(|item| {
        let data = serde_json::to_string(&item).unwrap_or_else(|_| "null".into());
        Event::default().data(data)
    });
    sse_with_shutdown(stream, state.shutdown)
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
    Authenticated(ctx): Authenticated,
    Path(name): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let payload = match serde_json::from_str::<Value>(query.get("payload").map(String::as_str).unwrap_or("{}")) {
        Ok(v) => v,
        Err(e) => return refuse(BizCode::InvalidInput, e.to_string()),
    };
    match open(state.server, state.shutdown, ctx, name, payload).await {
        Ok(stream) => stream,
        Err(envelope) => reply(envelope),
    }
}

fn default_attachment_mime() -> String {
    "application/octet-stream".into()
}

#[derive(serde::Deserialize)]
struct AttachmentFileReply {
    path: String,
    #[serde(rename = "type", default = "default_attachment_mime")]
    r#type: String,
    #[serde(default)]
    name: String,
}

async fn attachment(State(state): State<HttpState>, AuthenticatedQuery(ctx): AuthenticatedQuery, Path(id): Path<String>, headers: HeaderMap) -> Response {
    let server = state.server;
    let envelope = server.call_with_async(ctx, "attachment.file".into(), serde_json::json!({ "id": id })).await;
    if envelope.biz_code != 0 {
        return reply(envelope);
    }
    let Some(file_info) = envelope.data.and_then(|d| serde_json::from_value::<AttachmentFileReply>(d).ok()) else {
        return refuse(BizCode::InternalError, "attachment.file answered no path");
    };
    let spec = FileRangeSpec {
        path: std::path::Path::new(&file_info.path),
        content_type: &file_info.r#type,
        filename: &file_info.name,
        cache_control: "private, max-age=31536000, immutable",
        truncated_msg: "attachment truncated",
    };
    match serve_file_range(&headers, spec).await {
        Ok(response) => response,
        Err(FileServeError::Open(e)) => refuse(BizCode::NotFound, e.to_string()),
        Err(FileServeError::Seek(e)) => refuse(BizCode::InternalError, e.to_string()),
    }
}

async fn issue_watch(State(state): State<HttpState>, Authenticated(ctx): Authenticated, Path(id): Path<String>) -> Response {
    match open(state.server, state.shutdown, ctx, "issue.watch".into(), serde_json::json!({ "id": id })).await {
        Ok(stream) => stream,
        Err(envelope) if envelope.biz_code == BizCode::Forbidden.code() || envelope.biz_code == BizCode::Unauthorized.code() => reply(envelope),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Opens `name` asynchronously with `ctx`; `Ok` is the event stream, which
/// unsubscribes when the client goes away or the listener shuts down.
#[allow(clippy::result_large_err, reason = "Server::subscribe's contract returns the refusal envelope itself")]
async fn open(server: Shared, shutdown: CancellationToken, ctx: CallerContext, name: String, payload: Value) -> Result<Response, Envelope> {
    let (id, rx) = server.clone().subscribe_with_async(ctx, name, payload).await?;
    let guard = Subscription { server, id };
    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(move |item| {
        let _keep = &guard;
        let data = serde_json::to_string(&item).unwrap_or_else(|_| "null".into());
        Event::default().data(data)
    });
    Ok(sse_with_shutdown(stream, shutdown))
}
