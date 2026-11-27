use std::sync::Arc;

use serde_json::Value;

use super::media;
use crate::context::api::*;
use crate::log::SharedInvokeObserver;

/// In-process JSON-RPC bridge dispatch operations implemented by `gateway::bridge::Bridge`.
pub trait BridgeRpc: Send + Sync + 'static {
    fn call_with(&self, ctx: CallerContext, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static);
    fn call(&self, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static);
}

/// Per-view JSON-RPC & subscription dispatch implemented by `gateway::bridge::Client`.
pub trait ClientRpc: Send + Sync {
    fn call(&self, id: &str, op: String, payload: Value);
    fn subscribe(&self, id: &str, name: &str, payload: Value);
}

/// What the server provides to views and transports (async-first).
pub trait Server: Send + Sync + 'static {
    /// Asynchronous endpoint invocation carrying caller identity, principal, and trace id.
    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope>;
    /// Cached pre-encoded UTF-8 JSON snapshot for one domain slice (O(1) non-blocking read).
    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str>;
    /// Asynchronous pre-encoded UTF-8 JSON snapshot for one domain slice.
    fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> {
        Box::pin(async move { self.slice_snapshot_json(slice) })
    }
    /// Optional asynchronous readiness hook for proxies that finish startup
    /// off-thread (such as desktop `LateServer`). Returning `None` indicates
    /// the server is immediately ready for [`Self::subscribe_slice`] and
    /// [`Self::subscribe_live`].
    fn ready_async(&self) -> Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> {
        None
    }
    /// Direct `tokio::sync::watch` subscription for a domain slice when backed
    /// by [`crate::context::SliceFeed`], avoiding blocking threads on SSE and bridge pumps.
    fn subscribe_slice(&self, _slice: SliceKind) -> Option<crate::context::SliceSubscription> {
        None
    }
    /// Asynchronous `tokio::sync::watch` subscription for a domain slice.
    fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<crate::context::SliceSubscription>> {
        Box::pin(async move { self.subscribe_slice(slice) })
    }
    /// Current fault-injection gate, if attached.
    fn fault_gate(&self) -> Option<SharedFaultGate> {
        None
    }
    /// `LiveEvent`s from now on; a new bounded receiver per call.
    fn live(&self) -> tokio::sync::mpsc::Receiver<LiveEvent>;
    /// Broadcast subscription for `LiveEvent`s when backed by a broadcast ring
    /// buffer, allowing SSE and bridge consumers to stream directly.
    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<LiveEvent>> {
        None
    }
    /// Asynchronous subscription invocation carrying caller identity and principal for `can` RBAC enforcement.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>>;
    fn unsubscribe(&self, id: u64);
    /// Non-RPC stream and protocol ports (`mcp`, `remote`, `machine`, `media_input`, `voice`, `speech`).
    fn ports(&self) -> GatewayPorts {
        GatewayPorts::default()
    }
    /// Optional host shell debug bridge attached by the desktop app.
    fn host_debug(&self) -> Option<SharedHostDebug> {
        None
    }
    /// Convenience accessor delegating to [`Self::ports`].
    fn media_inputs(&self) -> Option<media::SharedMediaInputs> {
        self.ports().media_input
    }
    /// Convenience accessor delegating to [`Self::ports`].
    fn speech_streams(&self) -> Option<media::SharedSpeechStreams> {
        self.ports().speech
    }
    /// Convenience accessor delegating to [`Self::ports`].
    fn mcp(&self) -> Option<SharedMcp> {
        self.ports().mcp
    }
    /// Convenience accessor delegating to [`Self::ports`].
    fn voice(&self) -> Option<SharedLiveVoice> {
        self.ports().voice
    }
    /// Convenience accessor delegating to [`Self::ports`].
    fn remote_auth(&self) -> Option<SharedRemoteAuth> {
        self.ports().remote
    }
    /// Convenience accessor delegating to [`Self::ports`].
    fn machine_bus(&self) -> Option<SharedMachineBus> {
        self.ports().machine
    }
}

pub(crate) fn check_can(ctx: &CallerContext, op: &str, spec: &vibevalley_protocol::Endpoint) -> Option<Envelope> {
    (ctx.caller != vibevalley_protocol::Caller::User && !spec.can.contains(&ctx.caller))
        .then(|| refusal(BizCode::Forbidden, format!("{op} is not for the {:?}", ctx.caller)))
}

pub(crate) fn normalize_payload(spec: &vibevalley_protocol::Endpoint, payload: Value) -> Value {
    match (spec.input, payload) {
        (None, _) => Value::Null,
        (Some(_), Value::Null) => Value::Object(Default::default()),
        (Some(_), p) => p,
    }
}

pub(crate) fn finish_outcome(spec: &vibevalley_protocol::Endpoint, outcome: Result<Value, ApiError>) -> Envelope {
    match outcome {
        Ok(_) if spec.result.is_none() => Envelope::void(),
        Ok(data) => Envelope::ok(data),
        Err(err) => Envelope::failure(&err),
    }
}

pub(crate) fn ok_json<T: serde::Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

pub(crate) fn decode<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_path_to_error::deserialize(payload).map_err(|e| {
        let path = e.path().to_string();
        let problem = e.into_inner().to_string();
        let message = if path == "." || path.is_empty() {
            problem
        } else {
            format!("{path}: {problem}")
        };
        ApiError::new(BizCode::InvalidInput, message)
    })
}

pub(crate) fn begin_observed(observer: Option<&SharedInvokeObserver>, ctx: &CallerContext, op: &str, payload: &Value) -> Option<std::time::Instant> {
    let is_debug = op.starts_with("debug.");
    let observer = (!is_debug).then_some(observer).flatten();
    if let Some(obs) = observer {
        obs.on_call_start(ctx, op, payload);
        Some(std::time::Instant::now())
    } else {
        tracing::enabled!(tracing::Level::DEBUG).then(std::time::Instant::now)
    }
}

pub(crate) async fn run_observed_async<F>(
    observer: Option<&SharedInvokeObserver>,
    fault_gate: Option<&SharedFaultGate>,
    ctx: &CallerContext,
    op: &str,
    started: Option<std::time::Instant>,
    call: F,
) -> Envelope
where
    F: std::future::Future<Output = Envelope>,
{
    use tracing::Instrument as _;
    let is_debug = op.starts_with("debug.");
    let observer = (!is_debug).then_some(observer).flatten();
    let envelope = async {
        if !is_debug && let Some(gate) = fault_gate {
            let delay = gate.delay_ms(op);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
        call.await
    }
    .instrument(crate::log::request_span(op, ctx.trace_id))
    .await;
    let duration_us = started.map_or(0, |t0| t0.elapsed().as_micros() as u64);
    if let Some(obs) = observer {
        obs.on_call_end(ctx, op, envelope.biz_code, duration_us);
    }
    crate::log::record_call(op, ctx.trace_id, envelope.biz_code, duration_us);
    envelope
}

fn decode_native_input(id: vibevalley_protocol::NativeEndpointId, p: Value) -> Result<NativeEndpointInput, ApiError> {
    use vibevalley_protocol::{NativeEndpointId, Op, native_ops};
    Ok(match id {
        NativeEndpointId::AttachmentFile => {
            let r: <native_ops::AttachmentFile as Op>::Input = decode(p)?;
            NativeEndpointInput::Attachment(r.id)
        }
        NativeEndpointId::MediaInputFile => {
            let r: <native_ops::MediaInputFile as Op>::Input = decode(p)?;
            NativeEndpointInput::MediaInput(r.id)
        }
        NativeEndpointId::MediaInputUploadFile => {
            let r: <native_ops::MediaInputUploadFile as Op>::Input = decode(p)?;
            NativeEndpointInput::MediaInputUpload(r.id, std::path::PathBuf::from(r.path))
        }
    })
}

#[allow(clippy::result_large_err)]
pub(crate) async fn open_subscription_channel<F, Fut>(
    gw: &GatewayMeta,
    ctx: &CallerContext,
    name: &str,
    payload: Value,
    open_domain: F,
) -> Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>
where
    F: FnOnce(DomainSubscription, crate::context::Sink) -> Fut,
    Fut: std::future::Future<Output = Result<(), ApiError>>,
{
    use std::sync::atomic::Ordering;
    use vibevalley_protocol::Subscription;
    let Some(spec) = vibevalley_protocol::SUBSCRIPTIONS.iter().find(|s| s.name == name) else {
        return Err(refusal(BizCode::RouteNotFound, format!("no subscription {name}")));
    };
    if ctx.caller != Caller::User && !spec.can.contains(&ctx.caller) {
        return Err(refusal(BizCode::Forbidden, format!("{name} is not for the {:?}", ctx.caller)));
    }
    let p = if payload.is_null() { Value::Object(Default::default()) } else { payload };
    macro_rules! sub {
        ($s:ident) => {{ DomainSubscription::$s(decode::<<vibevalley_protocol::subscriptions::$s as Subscription>::Payload>(p).map_err(|e| Envelope::failure(&e))?) }};
    }
    let domain_sub = match spec.name {
        "channel.follow" => sub!(ChannelFollow),
        "channel.reports" => sub!(ChannelReports),
        "note.follow" => sub!(NoteFollow),
        "note.suggestion.follow" => sub!(NoteSuggestionFollow),
        "note.presence.follow" => sub!(NotePresenceFollow),
        "session.watch" => sub!(SessionWatch),
        "issue.watch" => sub!(IssueWatch),
        other => return Err(refusal(BizCode::RouteNotFound, format!("no subscription {other}"))),
    };
    let stop = tokio_util::sync::CancellationToken::new();
    let id = gw.subs.next_id.fetch_add(1, Ordering::Relaxed);
    let (sink, rx) = crate::context::Sink::with_default_capacity(stop.clone());
    if let Err(err) = open_domain(domain_sub, sink).await {
        return Err(Envelope::failure(&err));
    }
    let mut active = gw.subs.active.lock();
    active.insert(id, stop);
    gw.subs.count.store(active.len(), Ordering::Release);
    Ok((id, rx))
}

pub(crate) async fn flush_and_snapshot_json(ctx: Arc<crate::context::Context>, slice: SliceKind) -> Arc<str> {
    if ctx.feed.feed(slice).seq() < ctx.feed.dirty_seq(slice) {
        ctx.feed.flush().await;
    }
    ctx.feed.snapshot_json(slice)
}

pub(crate) async fn flush_and_subscribe_slice(ctx: Arc<crate::context::Context>, slice: SliceKind) -> Option<crate::context::SliceSubscription> {
    if ctx.feed.feed(slice).seq() < ctx.feed.dirty_seq(slice) {
        ctx.feed.flush().await;
    }
    Some(ctx.feed.subscribe(slice))
}

#[derive(Default)]
pub(crate) struct SubscriptionRegistry {
    pub(crate) active: parking_lot::Mutex<std::collections::HashMap<u64, tokio_util::sync::CancellationToken>>,
    pub(crate) next_id: std::sync::atomic::AtomicU64,
    pub(crate) count: Arc<std::sync::atomic::AtomicUsize>,
}

impl SubscriptionRegistry {
    pub(crate) fn with_counter(count: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        Self {
            active: parking_lot::Mutex::new(std::collections::HashMap::new()),
            next_id: std::sync::atomic::AtomicU64::new(1),
            count,
        }
    }
    pub(crate) fn len(&self) -> u32 {
        self.active.lock().len() as u32
    }
    pub(crate) fn close_all(&self) {
        let a = std::mem::take(&mut *self.active.lock());
        self.count.store(0, std::sync::atomic::Ordering::Release);
        for token in a.into_values() {
            token.cancel();
        }
    }
    pub(crate) fn remove(&self, id: u64) {
        let mut a = self.active.lock();
        let removed = a.remove(&id);
        self.count.store(a.len(), std::sync::atomic::Ordering::Release);
        drop(a);
        if let Some(token) = removed {
            token.cancel();
        }
    }
}

pub(crate) struct GatewayMeta {
    pub(crate) ports: GatewayPorts,
    pub(crate) observer: Option<SharedInvokeObserver>,
    pub(crate) fault_gate: Option<SharedFaultGate>,
    pub(crate) host_debug: Option<SharedHostDebug>,
    pub(crate) subs: SubscriptionRegistry,
    pub(crate) next_trace_id: std::sync::atomic::AtomicU64,
}

impl GatewayMeta {
    pub(crate) fn new(
        ports: GatewayPorts,
        observer: Option<SharedInvokeObserver>,
        fault_gate: Option<SharedFaultGate>,
        host_debug: Option<SharedHostDebug>,
        active_subscriptions: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        Self {
            ports,
            observer,
            fault_gate,
            host_debug,
            subs: SubscriptionRegistry::with_counter(active_subscriptions),
            next_trace_id: std::sync::atomic::AtomicU64::new(1),
        }
    }
}

pub(crate) async fn dispatch_boundary_async<T: ?Sized, F, FN>(
    target: &T,
    gw: &GatewayMeta,
    mut ctx: CallerContext,
    op: &str,
    payload: Value,
    dispatch_ep: F,
    dispatch_native: FN,
) -> Envelope
where
    F: for<'a> FnOnce(&'a T, &'a CallerContext, vibevalley_protocol::EndpointId, Value) -> BoxFuture<'a, Result<Value, ApiError>>,
    FN: for<'a> FnOnce(&'a T, NativeEndpointInput) -> BoxFuture<'a, Result<NativeEndpointOutput, ApiError>>,
{
    if ctx.trace_id == 0 {
        ctx.trace_id = gw.next_trace_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let started = begin_observed(gw.observer.as_ref(), &ctx, op, &payload);
    run_observed_async(gw.observer.as_ref(), gw.fault_gate.as_ref(), &ctx, op, started, async {
        if let Some(id) = vibevalley_protocol::EndpointId::from_op(op) {
            let s = id.spec();
            if let Some(d) = check_can(&ctx, op, s) {
                return d;
            }
            finish_outcome(s, dispatch_ep(target, &ctx, id, normalize_payload(s, payload)).await)
        } else if let Some(id) = vibevalley_protocol::NativeEndpointId::from_op(op) {
            let s = id.spec();
            if let Some(d) = check_can(&ctx, op, s) {
                return d;
            }
            let outcome = match decode_native_input(id, normalize_payload(s, payload)) {
                Ok(input) => dispatch_native(target, input).await.and_then(ok_json),
                Err(e) => Err(e),
            };
            finish_outcome(s, outcome)
        } else {
            refusal(BizCode::RouteNotFound, format!("no endpoint {op}"))
        }
    })
    .await
}
