//! Remote Control Plane `Server` adapter: implements `vibevalley_server::transport::api::Server`
//! over authenticated HTTP + SSE (`POST /api/v1/{op}`, `GET /api/v1/slice/{name}`,
//! `GET /api/v1/live`, `GET /api/v1/subscribe/{name}`) so the desktop GUI mounts directly onto
//! `BridgeHub` without starting a local embedded server.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{Stream, StreamExt, TryStreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::{broadcast, watch};
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};
use tokio_util::io::StreamReader;
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_protocol::{BizCode, BoardSlice, CollabSlice, Envelope, FarmFrame, InboxSlice, LiveEvent, OpsSlice, SessionsSlice, SliceKind};
use vibevalley_server::slice_feed::{Sequenced, SliceFeed, SliceSnapshot, SliceSubscription};
use vibevalley_server::transport::api::{BoxFuture, CallerContext, Server, refusal};
use vibevalley_server::transport::bridge::fake::empty_bundle;

use crate::hosted::connection::{Secret, is_loopback_url, normalize_url};

const REMOTE_CLIENT_HEADER: &str = "remote";
const BACKOFF_MS: &[u64] = &[500, 1_000, 2_000, 4_000, 8_000];
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const LIVE_BROADCAST_CAP: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SseMessage {
    id: Option<String>,
    data: String,
}

/// Line-based Server-Sent Events accumulator matching W3C EventSource field framing.
#[derive(Default)]
struct SseEventAccumulator {
    last_event_id: Option<String>,
    data_lines: Vec<String>,
}

impl SseEventAccumulator {
    fn push_line(&mut self, line: &str) -> Option<SseMessage> {
        if line.is_empty() {
            if self.data_lines.is_empty() {
                return None;
            }
            let data = self.data_lines.join("\n");
            self.data_lines.clear();
            return Some(SseMessage {
                id: self.last_event_id.clone(),
                data,
            });
        }
        if line.starts_with(':') {
            return None;
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
        None
    }
}

/// Decodes a streaming HTTP response body into UTF-8 lines across arbitrary TCP chunk boundaries.
fn sse_lines(response: reqwest::Response) -> impl Stream<Item = Result<String, LinesCodecError>> + Send {
    FramedRead::new(StreamReader::new(response.bytes_stream().map_err(io::Error::other)), LinesCodec::new())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SseStep {
    Continue,
    ContinueWithSeq(i64),
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SseStop {
    StreamEnded,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoopExit {
    Cancelled,
    AuthRefused,
    Closed,
}

async fn drain_sse_response<F, Fut>(
    response: reqwest::Response,
    cancel: &CancellationToken,
    last_seq: &mut Option<i64>,
    is_closed: &mut impl FnMut() -> bool,
    on_message: &mut F,
) -> SseStop
where
    F: FnMut(SseMessage) -> Fut,
    Fut: Future<Output = SseStep>,
{
    let lines = sse_lines(response);
    tokio::pin!(lines);
    let mut acc = SseEventAccumulator::default();

    loop {
        if is_closed() {
            return SseStop::Stopped;
        }
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return SseStop::Stopped,
            item = lines.next() => item,
        };
        let Some(Ok(line)) = next else {
            return SseStop::StreamEnded;
        };
        if is_closed() {
            return SseStop::Stopped;
        }
        if let Some(msg) = acc.push_line(&line) {
            match on_message(msg).await {
                SseStep::Continue => {}
                SseStep::ContinueWithSeq(seq) => *last_seq = Some(seq),
                SseStep::Stop => return SseStop::Stopped,
            }
        }
        if cancel.is_cancelled() {
            return SseStop::Stopped;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_sse_loop<F, Fut>(
    client: reqwest::Client,
    token: Secret,
    url: String,
    cancel: CancellationToken,
    last_seq: &mut Option<i64>,
    mut is_closed: impl FnMut() -> bool,
    mut on_auth_refused: impl FnMut(reqwest::StatusCode),
    mut on_message: F,
) -> LoopExit
where
    F: FnMut(SseMessage) -> Fut,
    Fut: Future<Output = SseStep>,
{
    let mut attempt = 0usize;
    while !cancel.is_cancelled() && !is_closed() {
        let mut req = attach_headers(client.get(&url).header("accept", "text/event-stream"), &token);
        if let Some(seq) = *last_seq {
            req = req.header("last-event-id", seq.to_string());
        }
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return LoopExit::Cancelled,
            res = req.send() => res,
        };
        match response {
            Ok(res) if matches!(res.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) => {
                on_auth_refused(res.status());
                return LoopExit::AuthRefused;
            }
            Ok(res) if res.status().is_success() => {
                attempt = 0;
                if drain_sse_response(res, &cancel, last_seq, &mut is_closed, &mut on_message).await == SseStop::Stopped {
                    return if cancel.is_cancelled() { LoopExit::Cancelled } else { LoopExit::Closed };
                }
            }
            Ok(_) | Err(_) => {}
        }

        if cancel.is_cancelled() {
            return LoopExit::Cancelled;
        }
        if is_closed() {
            return LoopExit::Closed;
        }
        let delay = backoff_delay(attempt);
        attempt = attempt.saturating_add(1);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return LoopExit::Cancelled,
            _ = tokio::time::sleep(delay) => {}
        }
    }

    if cancel.is_cancelled() { LoopExit::Cancelled } else { LoopExit::Closed }
}

fn parse_sse_seq(msg: &SseMessage, fallback_seq: i64) -> i64 {
    msg.id.as_deref().and_then(|id| id.trim().parse::<i64>().ok()).unwrap_or(fallback_seq)
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

fn slice_topic(kind: SliceKind) -> &'static str {
    match kind {
        SliceKind::Board => "slice:board",
        SliceKind::Sessions => "slice:sessions",
        SliceKind::Collab => "slice:collab",
        SliceKind::Inbox => "slice:inbox",
        SliceKind::Ops => "slice:ops",
        SliceKind::Farm => "slice:farm",
    }
}

struct RemoteSlice<T> {
    kind: SliceKind,
    feed: Arc<SliceFeed<T>>,
    pump: Arc<Mutex<Option<CancellationToken>>>,
}

impl<T> RemoteSlice<T>
where
    T: Sequenced + Serialize + DeserializeOwned + Send + Sync + 'static,
{
    fn new(kind: SliceKind, initial: T) -> Self {
        Self {
            kind,
            feed: Arc::new(SliceFeed::new(slice_topic(kind), initial)),
            pump: Arc::new(Mutex::new(None)),
        }
    }

    fn subscribe(&self, server: &RemoteServer) -> watch::Receiver<Arc<SliceSnapshot<T>>> {
        let rx = self.feed.subscribe();
        let mut guard = self.pump.lock();
        if guard.as_ref().is_none_or(CancellationToken::is_cancelled) {
            let cancel = server.shutdown.child_token();
            *guard = Some(cancel.clone());
            let feed = self.feed.clone();
            let pump = self.pump.clone();
            let client = server.client.clone();
            let token = server.token.clone();
            let kind = self.kind;
            let url = format!("{}/api/v1/slice/{}", server.base_url, kind.as_str());

            vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
                let mut last_seq: Option<i64> = None;
                loop {
                    let exit = run_sse_loop(
                        client.clone(),
                        token.clone(),
                        url.clone(),
                        cancel.clone(),
                        &mut last_seq,
                        || !feed.has_watchers(),
                        |status| {
                            tracing::warn!("remote slice stream {} refused with HTTP {}", kind.as_str(), status.as_u16());
                        },
                        |msg| {
                            let feed = &feed;
                            async move {
                                if !feed.has_watchers() {
                                    return SseStep::Stop;
                                }
                                match serde_json::from_str::<T>(&msg.data) {
                                    Ok(slice) => {
                                        let seq = parse_sse_seq(&msg, slice.seq());
                                        feed.replace(slice);
                                        feed.publish_forced();
                                        if feed.has_watchers() { SseStep::ContinueWithSeq(seq) } else { SseStep::Stop }
                                    }
                                    Err(err) => {
                                        tracing::warn!("remote slice {} decode failed: {err}", kind.as_str());
                                        if feed.has_watchers() { SseStep::Continue } else { SseStep::Stop }
                                    }
                                }
                            }
                        },
                    )
                    .await;

                    let mut guard = pump.lock();
                    if exit == LoopExit::Closed && feed.has_watchers() && !cancel.is_cancelled() {
                        // A new subscriber attached right as the loop observed zero watchers.
                        continue;
                    }
                    cancel.cancel();
                    if guard.as_ref().is_some_and(CancellationToken::is_cancelled) {
                        *guard = None;
                    }
                    break;
                }
            });
        }
        rx
    }
}

struct RemoteSlices {
    board: RemoteSlice<BoardSlice>,
    sessions: RemoteSlice<SessionsSlice>,
    collab: RemoteSlice<CollabSlice>,
    inbox: RemoteSlice<InboxSlice>,
    ops: RemoteSlice<OpsSlice>,
    farm: RemoteSlice<FarmFrame>,
}

impl RemoteSlices {
    fn new() -> Self {
        let bundle = empty_bundle(0);
        Self {
            board: RemoteSlice::new(SliceKind::Board, bundle.board),
            sessions: RemoteSlice::new(SliceKind::Sessions, bundle.sessions),
            collab: RemoteSlice::new(SliceKind::Collab, bundle.collab),
            inbox: RemoteSlice::new(SliceKind::Inbox, bundle.inbox),
            ops: RemoteSlice::new(SliceKind::Ops, bundle.ops),
            farm: RemoteSlice::new(SliceKind::Farm, bundle.farm),
        }
    }
}

struct LivePump {
    tx: broadcast::Sender<LiveEvent>,
    cancel: CancellationToken,
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
    _shutdown_guard: DropGuard,
    slices: RemoteSlices,
    live_bus: Arc<Mutex<Option<LivePump>>>,
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
        let shutdown = CancellationToken::new();
        let _shutdown_guard = shutdown.clone().drop_guard();
        Ok(Self {
            base_url,
            token,
            label,
            client,
            subs: Arc::new(Mutex::new(HashMap::new())),
            next_sub_id: AtomicU64::new(1),
            shutdown,
            _shutdown_guard,
            slices: RemoteSlices::new(),
            live_bus: Arc::new(Mutex::new(None)),
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
    async fn slice_snapshot_json_http(&self, slice: SliceKind) -> Arc<str> {
        let url = format!("{}/api/v1/slice/{}?once=1", self.base_url, slice.as_str());
        let req = attach_headers(
            self.client.get(&url).header("accept", "application/json").timeout(SNAPSHOT_TIMEOUT),
            &self.token,
        );
        let Ok(response) = req.send().await else {
            return Arc::<str>::from("null");
        };
        if !response.status().is_success() {
            return Arc::<str>::from("null");
        }
        let Ok(text) = response.text().await else {
            return Arc::<str>::from("null");
        };
        if serde_json::from_str::<serde::de::IgnoredAny>(&text).is_ok() {
            Arc::<str>::from(text)
        } else {
            Arc::<str>::from("null")
        }
    }

    #[allow(clippy::result_large_err, reason = "Server::subscribe's contract returns the refusal envelope itself")]
    async fn subscribe_http(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let payload_json = serde_json::to_string(&if payload.is_null() { Value::Object(Default::default()) } else { payload }).unwrap_or_else(|_| "{}".into());

        let mut url = url::Url::parse(&format!("{}/api/v1/subscribe/{}", self.base_url, name))
            .map_err(|e| refusal(BizCode::InvalidInput, format!("invalid subscription URL: {e}")))?;
        url.query_pairs_mut().append_pair("payload", &payload_json);

        let req = attach_headers(self.client.get(url).header("accept", "text/event-stream"), &self.token);
        let response = req
            .send()
            .await
            .map_err(|e| refusal(BizCode::ServiceUnavailable, format!("remote subscription unreachable: {e}")))?;
        let status = response.status();
        let is_json = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.contains("application/json"));
        if !status.is_success() || is_json {
            let text = response.text().await.unwrap_or_default();
            return Err(parse_envelope_or_fallback(status, &text));
        }

        let sub_id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        let cancel = self.shutdown.child_token();
        let (tx, rx) = flume::unbounded::<Value>();
        self.subs.lock().insert(sub_id, cancel.clone());
        let subs = self.subs.clone();

        vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
            let mut last_seq = None;
            let mut is_closed = || tx.is_disconnected();
            let mut on_message = |msg: SseMessage| {
                let tx = &tx;
                async move {
                    if let Ok(val) = serde_json::from_str::<Value>(&msg.data) {
                        return if tx.send(val).is_ok() { SseStep::Continue } else { SseStep::Stop };
                    }
                    if tx.is_disconnected() { SseStep::Stop } else { SseStep::Continue }
                }
            };
            let _ = drain_sse_response(response, &cancel, &mut last_seq, &mut is_closed, &mut on_message).await;
            subs.lock().remove(&sub_id);
        });

        Ok((sub_id, rx))
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
        let json = vibevalley_runtime::rt::block_on(self.slice_snapshot_json_http(slice));
        serde_json::from_str(&json).unwrap_or(Value::Null)
    }

    fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> {
        Box::pin(async move { self.slice_snapshot_json_http(slice).await })
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

        vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
            let mut last_seq = after_seq;
            let _ = run_sse_loop(
                client,
                token,
                url,
                task_cancel.clone(),
                &mut last_seq,
                || tx.is_disconnected(),
                |status| {
                    tracing::warn!("remote slice stream {} refused with HTTP {}", slice.as_str(), status.as_u16());
                },
                |msg| {
                    let tx = &tx;
                    let cancel = &task_cancel;
                    async move {
                        let Ok(val) = serde_json::from_str::<Value>(&msg.data) else {
                            return SseStep::Continue;
                        };
                        let seq = parse_sse_seq(&msg, val.get("seq").and_then(Value::as_i64).unwrap_or(0));
                        let sent = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => false,
                            res = tx.send_async((seq, val)) => res.is_ok(),
                        };
                        if sent { SseStep::ContinueWithSeq(seq) } else { SseStep::Stop }
                    }
                },
            )
            .await;
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

    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        Some(match slice {
            SliceKind::Board => SliceSubscription::Board(self.slices.board.subscribe(self)),
            SliceKind::Sessions => SliceSubscription::Sessions(self.slices.sessions.subscribe(self)),
            SliceKind::Collab => SliceSubscription::Collab(self.slices.collab.subscribe(self)),
            SliceKind::Inbox => SliceSubscription::Inbox(self.slices.inbox.subscribe(self)),
            SliceKind::Ops => SliceSubscription::Ops(self.slices.ops.subscribe(self)),
            SliceKind::Farm => SliceSubscription::Farm {
                rx: self.slices.farm.subscribe(self),
                strip_initial_effects: false,
            },
        })
    }

    fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<SliceSubscription>> {
        Box::pin(async move { self.subscribe_slice(slice) })
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        let (tx, rx) = flume::unbounded::<LiveEvent>();
        if let Some(mut live_rx) = self.subscribe_live() {
            let cancel = self.shutdown.child_token();
            vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
                loop {
                    let event = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        res = live_rx.recv() => match res {
                            Ok(ev) => ev,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        },
                    };
                    if tx.send(event).is_err() {
                        break;
                    }
                }
            });
        }
        rx
    }

    fn subscribe_live(&self) -> Option<broadcast::Receiver<LiveEvent>> {
        let mut guard = self.live_bus.lock();
        if let Some(pump) = guard.as_ref()
            && !pump.cancel.is_cancelled()
        {
            return Some(pump.tx.subscribe());
        }
        if let Some(old) = guard.take() {
            old.cancel.cancel();
        }
        let (tx, rx) = broadcast::channel(LIVE_BROADCAST_CAP);
        let cancel = self.shutdown.child_token();
        *guard = Some(LivePump {
            tx: tx.clone(),
            cancel: cancel.clone(),
        });
        drop(guard);

        let live_bus = self.live_bus.clone();
        let client = self.client.clone();
        let token = self.token.clone();
        let url = format!("{}/api/v1/live", self.base_url);

        vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
            let mut last_seq = None;
            loop {
                let exit = run_sse_loop(
                    client.clone(),
                    token.clone(),
                    url.clone(),
                    cancel.clone(),
                    &mut last_seq,
                    || tx.receiver_count() == 0,
                    |_| {},
                    |msg| {
                        let tx = &tx;
                        async move {
                            if tx.receiver_count() == 0 {
                                return SseStep::Stop;
                            }
                            if let Ok(event) = serde_json::from_str::<LiveEvent>(&msg.data) {
                                return if tx.send(event).is_ok() { SseStep::Continue } else { SseStep::Stop };
                            }
                            if tx.receiver_count() > 0 { SseStep::Continue } else { SseStep::Stop }
                        }
                    },
                )
                .await;

                let mut guard = live_bus.lock();
                if exit == LoopExit::Closed && tx.receiver_count() > 0 && !cancel.is_cancelled() {
                    continue;
                }
                cancel.cancel();
                if guard.as_ref().is_some_and(|p| p.cancel.is_cancelled()) {
                    *guard = None;
                }
                break;
            }
        });

        Some(rx)
    }

    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        vibevalley_runtime::rt::block_on(self.subscribe_http(name, payload))
    }

    fn subscribe_with_async(
        self: Arc<Self>,
        _ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, flume::Receiver<Value>), Envelope>> {
        Box::pin(async move { self.subscribe_http(&name, payload).await })
    }

    fn unsubscribe(&self, id: u64) {
        if let Some(token) = self.subs.lock().remove(&id) {
            token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::Duration;

    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
    use axum::routing::get;
    use parking_lot::Mutex;
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio::sync::Notify;
    use vibevalley_protocol::{ApiError, BizCode, Issue, LiveEvent, NoticeLevel, RemoteDeviceSummary, RemotePlatform};
    use vibevalley_server::transport::api::{RemoteAuth, RemoteDeviceIdentity};
    use vibevalley_server::transport::bridge::fake::{FakeServer, empty_bundle};
    use vibevalley_server::transport::bridge::{ClientIdentity, ClientKind, Hub as BridgeHub, Outlet};
    use vibevalley_server::transport::http;

    use super::*;
    use crate::hosted::connection::{ConnectionSaveRequest, configure_remote, exchange_pair_code};

    fn spawn_mock(router: Router) -> (SocketAddr, DropGuard) {
        vibevalley_runtime::rt::block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let cancel = CancellationToken::new();
            let guard = cancel.clone().drop_guard();
            tokio::spawn(async move {
                let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
            });
            (addr, guard)
        })
    }

    struct StaticRemoteAuth {
        expected_token: String,
    }

    impl RemoteAuth for StaticRemoteAuth {
        fn is_enabled(&self) -> bool {
            true
        }

        fn verify_bearer_async(
            self: Arc<Self>,
            token: String,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<RemoteDeviceIdentity, ApiError>> + Send + 'static>> {
            Box::pin(async move {
                if token == self.expected_token {
                    Ok(RemoteDeviceIdentity {
                        device_id: "dev-mac".into(),
                        name: "Mac Client".into(),
                        scope: vibevalley_protocol::SCOPE_REMOTE_CLIENT.into(),
                    })
                } else {
                    Err(ApiError::new(BizCode::Unauthorized, "invalid bearer token"))
                }
            })
        }
    }

    struct AuthedFake {
        inner: Arc<FakeServer>,
        auth: Arc<dyn RemoteAuth>,
        on_live: Notify,
    }

    impl AuthedFake {
        fn wait_live_watchers(&self, what: &str, min: usize) {
            vibevalley_runtime::rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        let notified = self.on_live.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if self.inner.live_watchers() >= min {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
        }
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
            let rx = self.inner.live();
            self.on_live.notify_waiters();
            rx
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

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<(String, Value)>>,
        notify: Notify,
    }

    impl Outlet for Recorder {
        fn send(&self, event: &str, data: Value) {
            self.events.lock().push((event.to_string(), data));
            self.notify.notify_waiters();
        }
    }

    impl Recorder {
        fn named(&self, name: &str) -> Vec<Value> {
            self.events.lock().iter().filter(|(n, _)| n == name).map(|(_, d)| d.clone()).collect()
        }

        fn wait_for(&self, what: &str, mut f: impl FnMut(&Self) -> bool) {
            vibevalley_runtime::rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        let notified = self.notify.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if f(self) {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
        }
    }

    #[test]
    fn sse_codec_and_accumulator_handle_chunk_boundaries_crlf_comments_and_multiline_data() {
        vibevalley_runtime::rt::block_on(async {
            let chunks = vec![
                Ok::<_, io::Error>(b": ping\r\nid: 7\r\ndata: {\"a\":\r".to_vec()),
                Ok(b"\ndata: 1}\r\n\r\ndata: second\n\n".to_vec()),
            ];
            let stream = futures_util::stream::iter(chunks.into_iter().map(|r| r.map(io::Cursor::new)));
            let mut lines = FramedRead::new(StreamReader::new(stream), LinesCodec::new());
            let mut acc = SseEventAccumulator::default();
            let mut messages = Vec::new();
            while let Some(line) = lines.next().await {
                if let Some(msg) = acc.push_line(&line.unwrap()) {
                    messages.push(msg);
                }
            }
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0].id.as_deref(), Some("7"));
            assert_eq!(messages[0].data, "{\"a\":\n1}");
            assert_eq!(messages[1].id.as_deref(), Some("7"));
            assert_eq!(messages[1].data, "second");
        });
    }

    #[test]
    fn regression_sse_preserves_multibyte_utf8_split_across_http_chunks() {
        let chinese_text = "你好世界：远程控制面中文事件流分片测试";
        let notice = LiveEvent::Notice(vibevalley_protocol::LiveEventNotice {
            at: 99,
            level: NoticeLevel::Info,
            text: chinese_text.into(),
        });
        let payload = format!("data: {}\n\n", serde_json::to_string(&notice).unwrap());
        let raw_bytes = payload.as_bytes().to_vec();
        // Split strictly inside the first 3-byte Chinese UTF-8 codepoint (`你` = E4 BD A0).
        let first_non_ascii = raw_bytes.iter().position(|&b| b >= 0x80).expect("multi-byte UTF-8");
        let split_at = first_non_ascii + 1;
        assert!(std::str::from_utf8(&raw_bytes[..split_at]).is_err(), "split must fall mid-codepoint");
        let part1 = raw_bytes[..split_at].to_vec();
        let part2 = raw_bytes[split_at..].to_vec();

        let app = Router::new().route(
            "/api/v1/live",
            get(move || {
                let part1 = part1.clone();
                let part2 = part2.clone();
                async move {
                    let (tx, rx) = flume::bounded::<Result<Bytes, Infallible>>(2);
                    tokio::spawn(async move {
                        let _ = tx.send_async(Ok(Bytes::from(part1))).await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        let _ = tx.send_async(Ok(Bytes::from(part2))).await;
                    });
                    (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        Body::from_stream(rx.into_stream()),
                    )
                }
            }),
        );
        let (addr, _guard) = spawn_mock(app);

        let remote = RemoteServer::new(format!("http://{addr}"), Secret::new("vv_dev_utf8_test"), None).unwrap();
        let live_rx = remote.live();
        let received = live_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        match received {
            LiveEvent::Notice(got) => {
                assert!(!got.text.contains('\u{FFFD}'), "unexpected U+FFFD replacement char: {}", got.text);
                assert_eq!(got.text, chinese_text);
            }
            other => panic!("expected Notice, got {other:?}"),
        }
    }

    #[test]
    fn remote_server_sends_bearer_and_client_headers_over_http() {
        let seen_requests = Arc::new(Mutex::new(Vec::<(String, String, Option<String>, Option<String>)>::new()));
        let seen_for_task = seen_requests.clone();
        let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
            let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(ToString::to_string);
            let client = headers.get("x-vibevalley-client").and_then(|v| v.to_str().ok()).map(ToString::to_string);
            seen_for_task.lock().push((method.to_string(), uri.path().to_string(), auth, client));
            async move {
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json")],
                    r#"{"bizCode":0,"message":"ok","data":{"ok":true,"version":"1.2.3"}}"#,
                )
            }
        });
        let (addr, _guard) = spawn_mock(app);

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

        let (method, path, auth, client) = seen_requests.lock()[0].clone();
        assert_eq!((method.as_str(), path.as_str()), ("POST", "/api/v1/health"));
        assert_eq!(auth.as_deref(), Some("Bearer vv_dev_header_check_token_42"));
        assert_eq!(client.as_deref(), Some("remote"));
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
            on_live: Notify::new(),
        });
        let listener = http::serve_remote(authed.clone(), ([127, 0, 0, 1], 0).into()).unwrap();
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
        let (seen_tx, seen_rx) = flume::unbounded::<(i64, Value)>();
        let watcher_remote = RemoteServer::new(remote.base_url.clone(), Secret::new(token), None).unwrap();
        let handle = std::thread::spawn(move || {
            watcher_remote.watch_slice(SliceKind::Board, None, &stop_rx, &mut |seq, val| {
                let _ = seen_tx.send((seq, val.clone()));
            });
        });

        let (initial_seq, _) = seen_rx.recv_timeout(Duration::from_secs(5)).expect("timed out waiting for initial SSE slice");
        assert_eq!(initial_seq, 1);

        let mut next = empty_bundle(2);
        next.board.issues.push(Issue::new("i-remote", 1, "Remote Issue", 2));
        fake.swap_bundle(next);

        let (updated_seq, updated_val) = seen_rx.recv_timeout(Duration::from_secs(5)).expect("timed out waiting for updated SSE slice");
        assert_eq!(updated_seq, 2);
        assert_eq!(updated_val["issues"][0]["id"], "i-remote");
        drop(stop_tx);
        handle.join().unwrap();

        // 5. subscribe_slice + subscribe_live drive BridgeHub via zero-thread async fast paths.
        let hub = BridgeHub::new(remote.clone(), 2);
        let rec = Arc::new(Recorder::default());
        let client = hub.attach(
            ClientIdentity {
                id: "remote-bridge".into(),
                kind: ClientKind::GpuiWorkbench,
                label: "remote-bridge".into(),
            },
            rec.clone(),
        );
        client.watch("slice:board").unwrap();
        client.watch("live").unwrap();

        rec.wait_for("BridgeHub remote board slice", |r| {
            let frames = r.named("frame:slice:board");
            if let Some(last) = frames.last() {
                if let Some(rev) = last["rev"].as_u64() {
                    client.applied_slice("slice:board", rev);
                }
                if last["data"]["seq"] == 2 {
                    assert_eq!(last["data"]["issues"][0]["id"], "i-remote");
                    return true;
                }
            }
            false
        });

        authed.wait_live_watchers("subscribe_live SSE attach", 1);
        let bridge_notice = LiveEvent::Notice(vibevalley_protocol::LiveEventNotice {
            at: 43,
            level: NoticeLevel::Info,
            text: "hello bridge live".into(),
        });
        fake.push_live(bridge_notice);
        rec.wait_for("BridgeHub remote live event", |r| !r.named("frame:live").is_empty());
        assert_eq!(rec.named("frame:live")[0]["data"]["text"], "hello bridge live");
        drop(client);

        // 6. live SSE receives LiveEvent.
        let live_rx = remote.live();
        authed.wait_live_watchers("live SSE attach", 1);
        let expected_notice = LiveEvent::Notice(vibevalley_protocol::LiveEventNotice {
            at: 42,
            level: NoticeLevel::Info,
            text: "hello remote".into(),
        });
        fake.push_live(expected_notice.clone());
        let ev = live_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(ev, expected_notice);
        drop(live_rx);

        // 7. subscribe SSE streams events, handles refusal, and unsubscribes cleanly.
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
