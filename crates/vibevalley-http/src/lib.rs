//! The HTTP API (`/api/v1`) over the in-process server, so the clients
//! work against it unchanged: its CLI (`VIBEVALLEY_SERVER=…
//! vibevalley issue list`), scripts, and later the LAN and phone paths.
//!
//! Same wire as VibeValley's `apps/server/src/gateway/http`:
//! - `POST /api/v1/<op with . as />` with a JSON body → the envelope, HTTP
//!   status from the business code's `bizCodeMeta`;
//! - `GET /api/v1/state` and `/api/v1/live` (`/api/v1/events`) as
//!   server-sent events, one `data:` line per frame or event, `: ping`
//!   every 20 s;
//! - `GET /api/v1/subscribe/<name>?payload=<JSON>`: a refusal before the
//!   first event is a plain JSON error, then events;
//! - `GET /api/v1/issue/watch/<id>`: the `issue.watch` subscription; an
//!   empty 404 when it is refused, as VibeValley answers;
//! - `GET /api/v1/attachment/<id>`: the stored file, by VibeValley's
//!   `attachment.file` op;
//! - `GET /api/v1/artifact/<id>/view?theme=…&path=…&elementId=…&print=1`: a
//!   store artifact's rendered viewer with CSP headers (`artifact.view`);
//! - `GET /api/v1/artifact/<id>/<version>?shell=1&theme=…&print=1`: an
//!   HTML artifact's page with the server's headers (`artifact.page`);
//! - only the machine's own pages: a loopback `Host`, and an `Origin` (when
//!   sent) equal to it, `Sec-Fetch-Site` same-origin or none (`fromTheFarm`).

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::Stream;
use serde_json::{Value, json};
use vibevalley_protocol::{ApiError, BizCode, Envelope};
use vibevalley_server_api::Server;

mod chord;
mod media;

const HEARTBEAT: Duration = Duration::from_secs(20);

type Shared = Arc<dyn Server>;

/// A running listener. Dropping it stops it.
pub struct Listener {
    pub addr: SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Listener {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Serves `server` on `addr` (use port 0 for any free port) on a thread of
/// its own. Only loopback addresses are accepted: this is not a network
/// service.
pub fn serve(server: Shared, addr: SocketAddr) -> std::io::Result<Listener> {
    if !addr.ip().is_loopback() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "loopback addresses only"));
    }
    let std_listener = std::net::TcpListener::bind(addr)?;
    std_listener.set_nonblocking(true)?;
    let addr = std_listener.local_addr()?;
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let thread = std::thread::Builder::new().name("vibevalley-http".into()).spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build();
        let Ok(runtime) = runtime else { return };
        runtime.block_on(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(std_listener) else {
                return;
            };
            let _ = axum::serve(listener, router(server))
                .with_graceful_shutdown(async {
                    let _ = stop_rx.await;
                })
                .await;
        });
    })?;
    Ok(Listener {
        addr,
        stop: Some(stop_tx),
        thread: Some(thread),
    })
}

pub fn router(server: Shared) -> Router {
    Router::new()
        // Each GET path also matches ops of the same shape (POST
        // attachment/create, artifact/block/list): those go to `command`.
        .route("/api/v1/state", get(state).post(command))
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
        .route("/chord/ws", get(chord::upgrade))
        .route("/mcp", post(mcp).get(not_allowed))
        .fallback(not_found)
        .with_state(server)
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

/// A helper's MCP messages (streamable HTTP, answered as plain JSON): one
/// message or a batch. Notifications alone are answered 202.
async fn mcp(State(server): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let Some(door) = server.mcp() else {
        return refuse(BizCode::ServiceUnavailable, "no MCP here");
    };
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_string();
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
async fn command(State(server): State<Shared>, uri: axum::http::Uri, headers: HeaderMap, body: Bytes) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
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
    match tokio::task::spawn_blocking(move || server.call(&op, payload)).await {
        Ok(envelope) => reply(envelope),
        Err(e) => refuse(BizCode::InternalError, e.to_string()),
    }
}

/// A flume receiver as an SSE stream of `data:` lines.
fn events<T: serde::Serialize + Send + 'static>(rx: flume::Receiver<T>) -> impl Stream<Item = Result<Event, Infallible>> {
    futures_util::stream::unfold(rx, |rx| async move {
        let item = rx.recv_async().await.ok()?;
        let data = serde_json::to_string(&item).unwrap_or_else(|_| "null".into());
        Some((Ok(Event::default().data(data)), rx))
    })
}

fn sse<S: Stream<Item = Result<Event, Infallible>> + Send + 'static>(stream: S) -> Response {
    Sse::new(stream).keep_alive(KeepAlive::new().interval(HEARTBEAT).text("ping")).into_response()
}

async fn state(State(server): State<Shared>, headers: HeaderMap) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    sse(events(server.state()))
}

async fn live(State(server): State<Shared>, headers: HeaderMap) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    sse(events(server.live()))
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
    State(server): State<Shared>,
    Path(name): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let payload = match serde_json::from_str::<Value>(query.get("payload").map(String::as_str).unwrap_or("{}")) {
        Ok(v) => v,
        Err(e) => return refuse(BizCode::InvalidInput, e.to_string()),
    };
    match open(server, name, payload).await {
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
    State(server): State<Shared>,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
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
    let envelope = match tokio::task::spawn_blocking(move || server.call("artifact.view", payload)).await {
        Ok(envelope) => envelope,
        Err(e) => return refuse(BizCode::InternalError, e.to_string()),
    };
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
    State(server): State<Shared>,
    Path((id, version)): Path<(String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
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
    let envelope = match tokio::task::spawn_blocking(move || server.call("artifact.page", payload)).await {
        Ok(envelope) => envelope,
        Err(e) => return refuse(BizCode::InternalError, e.to_string()),
    };
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

async fn attachment(State(server): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    let found = tokio::task::spawn_blocking(move || server.call("attachment.file", serde_json::json!({ "id": id }))).await;
    let envelope = match found {
        Ok(envelope) => envelope,
        Err(e) => return refuse(BizCode::InternalError, e.to_string()),
    };
    if envelope.biz_code != 0 {
        return reply(envelope);
    }
    let data = envelope.data.unwrap_or_default();
    let (Some(path), kind) = (data["path"].as_str(), data["type"].as_str().unwrap_or("application/octet-stream")) else {
        return refuse(BizCode::InternalError, "attachment.file answered no path");
    };
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let name = data["name"].as_str().unwrap_or_default().replace(['"', '\\', '\r', '\n'], "_");
            (
                StatusCode::OK,
                [
                    ("content-type", kind.to_string()),
                    ("content-disposition", format!("inline; filename=\"{name}\"")),
                    ("cache-control", "private, max-age=31536000, immutable".to_string()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(e) => refuse(BizCode::NotFound, e.to_string()),
    }
}

async fn issue_watch(State(server): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if !from_the_farm(&headers) {
        return refuse(BizCode::Forbidden, "forbidden");
    }
    match open(server, "issue.watch".into(), serde_json::json!({ "id": id })).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(_)) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => refuse(BizCode::InternalError, e.to_string()),
    }
}

/// Opens `name` off the async runtime; `Ok(Ok)` is the event stream, which
/// unsubscribes when the client goes away.
#[allow(clippy::result_large_err, reason = "Server::subscribe's contract returns the refusal envelope itself")]
async fn open(server: Shared, name: String, payload: Value) -> Result<Result<Response, Envelope>, tokio::task::JoinError> {
    let opened = {
        let server = server.clone();
        tokio::task::spawn_blocking(move || server.subscribe(&name, payload)).await?
    };
    Ok(match opened {
        Ok((id, rx)) => {
            let guard = Subscription { server, id };
            let stream = futures_util::stream::unfold((rx, guard), |(rx, guard)| async move {
                let item = rx.recv_async().await.ok()?;
                let data = serde_json::to_string(&item).unwrap_or_else(|_| "null".into());
                Some((Ok::<_, Infallible>(Event::default().data(data)), (rx, guard)))
            });
            Ok(sse(stream))
        }
        Err(envelope) => Err(envelope),
    })
}

#[cfg(test)]
mod tests;
