//! VibeValley's server, in process: the one state (`vibevalley-core`'s `Core`),
//! the endpoint table by op name (`vibevalley-protocol`'s `ENDPOINTS`) with the
//! same payloads and envelopes, state frames at most every 200 ms, live
//! events and `rpc.ts`'s subscriptions. It implements
//! [`vibevalley_server_api::Server`] for the bridge and the HTTP adapter.
//!
//! Modules register their handlers with [`Hub::on`] (typed by
//! `vibevalley_protocol::ops`) and their subscriptions with
//! [`Hub::on_subscription`]; they change the state only through
//! [`Hub::apply`]. Source: VibeValley `apps/server/src/core/core.ts`,
//! `gateway/http/api.ts` and `rpc.ts`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use serde_json::Value;
use vibevalley_core::{Applied, Core, Transition};
use vibevalley_protocol::{
    ApiError, BizCode, Caller, Envelope, Fact, GameEffect, LiveEvent, LiveEventNotice, LiveEventRuntime, LiveEventSession, Millis, NoticeLevel, Op,
    RuntimeInfo, STATE_EVERY_MS, SessionEvent, SpaceState, StateFrame, Subscription, endpoint,
};

pub use vibevalley_server_api::{Server, refusal};

pub mod base;
mod chord_space;
mod workbench_frames;
pub use vibevalley_home as home;
pub mod modules;
pub mod offline;
mod public_http;
mod start;
pub mod testing;

pub use start::{ServerConfig, StartError, Started, start};

/// Installs the process-wide `ring` TLS provider once (`reqwest` and `tokio-tungstenite`).
pub fn install_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Unix milliseconds now.
pub fn now() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

/// What a handler is called with: who calls, and the hub.
pub struct Ctx<'a> {
    pub caller: Caller,
    pub hub: &'a Hub,
}

type Handler = Arc<dyn Fn(&Ctx, Value) -> Result<Value, ApiError> + Send + Sync>;

/// Where a subscription's events go; it ends when the subscriber stops
/// (`stopped`) or the opener drops it.
pub struct Sink {
    pub events: flume::Sender<Value>,
    /// Disconnected once the subscriber has stopped.
    pub stop: flume::Receiver<()>,
}

impl Sink {
    pub fn stopped(&self) -> bool {
        matches!(self.stop.try_recv(), Err(flume::TryRecvError::Disconnected))
    }

    /// Sends one event; false once nobody listens.
    pub fn send<T: serde::Serialize>(&self, event: &T) -> bool {
        !self.stopped() && serde_json::to_value(event).is_ok_and(|v| self.events.send(v).is_ok())
    }
}

type Opener = Arc<dyn Fn(&Hub, Value, Sink) -> Result<(), ApiError> + Send + Sync>;

/// A reader of every transition (`Core.transitions` in VibeValley): told
/// each fact with the state before and after, in order, after it is folded.
pub type Watcher = Arc<dyn Fn(&Hub, &Transition) + Send + Sync>;

#[derive(Default)]
struct Streams {
    states: Vec<flume::Sender<Value>>,
    frames: Vec<flume::Sender<Arc<StateFrame>>>,
    live: Vec<flume::Sender<LiveEvent>>,
}

/// The server: the state, the endpoints and the streams. Cheap to share
/// (`Arc<Hub>`).
pub struct Hub {
    core: Mutex<Core>,
    space: chord_space::Space,
    workbench: workbench_frames::WorkbenchFrames,
    execution: std::sync::OnceLock<std::sync::Weak<modules::orchestrator::Orchestrator>>,
    chat: std::sync::OnceLock<std::sync::Weak<modules::channel::Chat>>,
    handlers: RwLock<HashMap<&'static str, Handler>>,
    openers: RwLock<HashMap<&'static str, Opener>>,
    watchers: RwLock<Vec<Watcher>>,
    streams: Mutex<Streams>,
    subscriptions: Mutex<HashMap<u64, flume::Sender<()>>>,
    next_id: AtomicU64,
    media_inputs: RwLock<Option<vibevalley_server_api::media::SharedMediaInputs>>,
    mcp: RwLock<Option<vibevalley_server_api::SharedMcp>>,
    speech: RwLock<Option<vibevalley_server_api::media::SharedSpeechStreams>>,
    /// Each fold's effects, for the frame thread.
    kicks: flume::Sender<Vec<GameEffect>>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hub {
    /// Streamed speech (`modules::media::jobs::Jobs`).
    pub fn attach_speech_streams(&self, streams: vibevalley_server_api::media::SharedSpeechStreams) {
        *self.speech.write().unwrap_or_else(|e| e.into_inner()) = Some(streams);
    }

    /// The helpers' MCP door (`modules::mcp::Door`).
    pub fn attach_mcp(&self, door: vibevalley_server_api::SharedMcp) {
        *self.mcp.write().unwrap_or_else(|e| e.into_inner()) = Some(door);
    }

    pub fn attach_media_inputs(&self, inputs: vibevalley_server_api::media::SharedMediaInputs) {
        *self.media_inputs.write().unwrap_or_else(|e| e.into_inner()) = Some(inputs);
    }

    /// A server holding `state`, with no endpoint answered yet. Its frame
    /// thread ends when the last `Arc<Hub>` is dropped.
    pub fn new(state: SpaceState) -> Arc<Hub> {
        let (kicks, kicked) = flume::unbounded();
        let core = Core::new(state);
        let first = core.frame(vec![]);
        let space = chord_space::Space::new(&first);
        let hub = Arc::new(Hub {
            core: Mutex::new(core),
            space,
            workbench: workbench_frames::WorkbenchFrames::new(first),
            execution: std::sync::OnceLock::new(),
            chat: std::sync::OnceLock::new(),
            handlers: RwLock::default(),
            openers: RwLock::default(),
            watchers: RwLock::default(),
            streams: Mutex::default(),
            subscriptions: Mutex::default(),
            next_id: AtomicU64::new(1),
            media_inputs: RwLock::new(None),
            mcp: RwLock::new(None),
            speech: RwLock::new(None),
            kicks,
        });
        let weak = Arc::downgrade(&hub);
        std::thread::Builder::new()
            .name("vibevalley-server-frames".into())
            .spawn(move || frames(weak, kicked))
            .expect("a thread for the frames");
        hub
    }

    // ----- the state -----

    /// The state now.
    pub fn state_now(&self) -> SpaceState {
        lock(&self.core).state().clone()
    }

    /// Reads the state without copying it.
    pub fn read<R>(&self, f: impl FnOnce(&SpaceState) -> R) -> R {
        f(lock(&self.core).state())
    }

    pub fn seq(&self) -> i64 {
        lock(&self.core).seq()
    }

    fn refresh_frame_words(&self) {
        if self.workbench.snapshot().locale != vibevalley_i18n::locale() {
            let core = lock(&self.core);
            self.workbench.replace(core.frame(vec![]));
        }
    }

    /// The frame now, with no effects.
    pub fn frame(&self) -> StateFrame {
        lock(&self.core).frame(vec![])
    }

    /// Folds `facts` in as one commit (`Core.apply`): the watchers hear each
    /// transition, the frame thread the effects. Owners store first, then
    /// apply.
    pub fn apply(&self, facts: Vec<Fact>) -> Applied {
        let applied = {
            let mut core = lock(&self.core);
            let changes = core.apply(facts);
            if !changes.transitions.is_empty() {
                let frame = core.frame(vec![]);
                self.space.update(&frame, &changes.transitions);
                self.workbench.replace(frame);
            }
            changes
        };
        if applied.transitions.is_empty() {
            return applied;
        }
        let watchers = self.watchers.read().unwrap_or_else(|e| e.into_inner()).clone();
        for t in &applied.transitions {
            for w in &watchers {
                w(self, t);
            }
        }
        let _ = self.kicks.send(applied.effects.clone());
        applied
    }

    /// Hears every transition from now on.
    pub fn watch(&self, watcher: Watcher) {
        self.watchers.write().unwrap_or_else(|e| e.into_inner()).push(watcher);
    }

    // ----- live events (core.ts sessionEvent, notice, runtime) -----

    fn publish_live(&self, event: LiveEvent) {
        lock(&self.streams).live.retain(|tx| tx.send(event.clone()).is_ok());
    }

    pub fn session_event(&self, id: &str, activity: SessionEvent) {
        self.publish_live(LiveEvent::Event(LiveEventSession {
            at: now(),
            id: id.to_string(),
            activity,
        }));
    }

    pub fn notice(&self, level: NoticeLevel, text: impl Into<String>) {
        self.publish_live(LiveEvent::Notice(LiveEventNotice {
            at: now(),
            level,
            text: text.into(),
        }));
    }

    pub fn runtime(&self, info: RuntimeInfo) {
        self.publish_live(LiveEvent::Runtime(LiveEventRuntime { at: now(), info }));
    }

    // ----- endpoints -----

    /// Answers `O` with `handler`, replacing any earlier one.
    pub fn on<O: Op>(&self, handler: impl Fn(&Ctx, O::Input) -> Result<O::Result, ApiError> + Send + Sync + 'static) {
        let h: Handler = Arc::new(move |ctx, payload| {
            let input: O::Input = decode(payload)?;
            let out = handler(ctx, input)?;
            serde_json::to_value(out).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
        });
        self.handlers.write().unwrap_or_else(|e| e.into_inner()).insert(O::NAME, h);
    }

    /// Whether some module answers `op`.
    pub fn answers(&self, op: &str) -> bool {
        self.handlers.read().unwrap_or_else(|e| e.into_inner()).contains_key(op)
    }

    /// Whether some module opens subscription `name`.
    pub fn answers_subscription(&self, name: &str) -> bool {
        self.openers.read().unwrap_or_else(|e| e.into_inner()).contains_key(name)
    }

    /// Typed frames as they are folded, with the current frame first.
    pub fn state_frames(&self) -> flume::Receiver<Arc<StateFrame>> {
        let (tx, rx) = flume::unbounded();
        let mut streams = lock(&self.streams);
        let _ = tx.send(Arc::new(self.frame()));
        streams.frames.push(tx);
        rx
    }

    /// One endpoint as `caller` (`serve` in `gateway/http/api.ts`): the
    /// input decoded by the endpoint's type (`InvalidInput` when it does not
    /// fit), the void envelope for an endpoint with no result, else `data`
    /// (even `null`).
    pub fn call_as(&self, caller: Caller, op: &str, payload: Value) -> Envelope {
        let Some(e) = endpoint(op) else {
            return refusal(BizCode::RouteNotFound, format!("no endpoint {op}"));
        };
        if caller != Caller::User && !e.can.contains(&caller) {
            return refusal(BizCode::Forbidden, format!("{op} is not for the {caller:?}"));
        }
        let handler = self.handlers.read().unwrap_or_else(|e| e.into_inner()).get(op).cloned();
        let Some(handler) = handler else {
            return refusal(BizCode::ServiceUnavailable, format!("{op} is not served by VibeValley yet"));
        };
        // A body that is empty is `{}`; an endpoint that takes nothing reads nothing.
        let payload = match (e.input, payload) {
            (None, _) => Value::Null,
            (Some(_), Value::Null) => Value::Object(Default::default()),
            (Some(_), p) => p,
        };
        let ctx = Ctx { caller, hub: self };
        match handler(&ctx, payload) {
            Ok(data) if e.result.is_none() => {
                let _ = data;
                Envelope::void()
            }
            Ok(data) => Envelope::ok(data),
            Err(err) => Envelope::failure(&err),
        }
    }

    // ----- subscriptions (rpc.ts) -----

    /// Serves subscription `S` with `open`: it decodes nothing itself, gets
    /// the payload typed, and sends events into the sink from any thread
    /// until the subscriber stops. An `Err` is a refusal before the first
    /// event.
    pub fn on_subscription<S: Subscription>(&self, open: impl Fn(&Hub, S::Payload, Sink) -> Result<(), ApiError> + Send + Sync + 'static) {
        let o: Opener = Arc::new(move |hub, payload, sink| open(hub, decode(payload)?, sink));
        self.openers.write().unwrap_or_else(|e| e.into_inner()).insert(S::NAME, o);
    }

    #[allow(clippy::result_large_err, reason = "the contract's refusal is an envelope")]
    fn open_subscription(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let Some(open) = self.openers.read().unwrap_or_else(|e| e.into_inner()).get(name).cloned() else {
            return Err(refusal(BizCode::RouteNotFound, format!("no subscription {name}")));
        };
        let (events, rx) = flume::unbounded();
        let (stop_tx, stop) = flume::bounded(1);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = if payload.is_null() { Value::Object(Default::default()) } else { payload };
        open(self, payload, Sink { events, stop }).map_err(|e| Envelope::failure(&e))?;
        lock(&self.subscriptions).insert(id, stop_tx);
        Ok((id, rx))
    }
}

/// Reads `payload` as `T`; where it does not fit is said as zod's
/// `problemOf` says it: `path: problem`.
pub fn decode<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
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

/// The frame thread (`states` in `core.ts`): a burst of folds within
/// `STATE_EVERY_MS` is one frame, with all their effects.
fn frames(hub: std::sync::Weak<Hub>, kicked: flume::Receiver<Vec<GameEffect>>) {
    while let Ok(mut effects) = kicked.recv() {
        let deadline = std::time::Instant::now() + Duration::from_millis(STATE_EVERY_MS);
        let Some(leading) = hub.upgrade() else { return };
        leading.refresh_frame_words();
        leading.workbench.publish(true);
        drop(leading);
        std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()));
        effects.extend(kicked.drain().flatten());
        let Some(hub) = hub.upgrade() else { return };
        hub.refresh_frame_words();
        hub.workbench.publish(false);
        let snapshot = hub.workbench.snapshot();
        let mut streams = lock(&hub.streams);
        if !streams.frames.is_empty() {
            let frame = if effects.is_empty() {
                snapshot.frame.clone()
            } else {
                Arc::new(StateFrame {
                    effects: effects.clone(),
                    ..snapshot.frame.as_ref().clone()
                })
            };
            streams.frames.retain(|tx| tx.send(frame.clone()).is_ok());
        }
        if !streams.states.is_empty() {
            let mut frame = snapshot.wire().clone();
            if !effects.is_empty() {
                frame["effects"] = serde_json::to_value(effects).expect("game effects serialize");
            }
            streams.states.retain(|tx| tx.send(frame.clone()).is_ok());
        }
    }
}

/// The board's facts go into the server's one state.
impl modules::ledger::Facts for Hub {
    fn apply(&self, facts: Vec<Fact>) -> Applied {
        Hub::apply(self, facts)
    }

    fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
        f(lock(&self.core).state())
    }

    fn frame(&self) -> StateFrame {
        Hub::frame(self)
    }
}

impl modules::ledger::Facts for std::sync::Weak<Hub> {
    fn apply(&self, facts: Vec<Fact>) -> Applied {
        match self.upgrade() {
            Some(hub) => Hub::apply(&hub, facts),
            None => Core::default().apply(facts),
        }
    }

    fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
        match self.upgrade() {
            Some(hub) => f(lock(&hub.core).state()),
            None => f(&vibevalley_core::empty_space_state()),
        }
    }

    fn frame(&self) -> StateFrame {
        match self.upgrade() {
            Some(hub) => Hub::frame(&hub),
            None => Core::default().frame(vec![]),
        }
    }
}

impl Server for Hub {
    fn channel_messages_after(&self, channel: &str, after: i64, limit: i64) -> Result<Vec<vibevalley_protocol::ChatMessage>, ApiError> {
        self.chat
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| ApiError::new(BizCode::ServiceUnavailable, "channel history unavailable"))?
            .messages_after(channel, after, limit)
    }

    fn resolve_approval(&self, input: Value) -> Envelope {
        self.execution.get().and_then(std::sync::Weak::upgrade).map_or_else(
            || vibevalley_server_api::refusal(BizCode::Refused, "durable execution unavailable"),
            |o| o.execution.resolve_approval(input),
        )
    }
    fn raise_budget(&self, input: Value) -> Envelope {
        self.execution.get().and_then(std::sync::Weak::upgrade).map_or_else(
            || vibevalley_server_api::refusal(BizCode::Refused, "durable execution unavailable"),
            |o| o.execution.raise_budget(input),
        )
    }
    fn space_document(&self) -> Option<vibevalley_server_api::Document> {
        Some(self.space.document())
    }

    fn speech_streams(&self) -> Option<vibevalley_server_api::media::SharedSpeechStreams> {
        self.speech.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn mcp(&self) -> Option<vibevalley_server_api::SharedMcp> {
        self.mcp.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn media_inputs(&self) -> Option<vibevalley_server_api::media::SharedMediaInputs> {
        self.media_inputs.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.call_as(Caller::User, op, payload)
    }

    fn state(&self) -> flume::Receiver<Value> {
        self.refresh_frame_words();
        let (tx, rx) = flume::unbounded();
        let mut streams = lock(&self.streams);
        let _ = tx.send(self.workbench.snapshot().wire().clone());
        streams.states.push(tx);
        rx
    }

    fn watch_workbench(&self, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(&Value)) {
        self.refresh_frame_words();
        self.workbench.watch(stop, receive);
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        let (tx, rx) = flume::unbounded();
        lock(&self.streams).live.push(tx);
        rx
    }

    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        self.open_subscription(name, payload)
    }

    fn unsubscribe(&self, id: u64) {
        lock(&self.subscriptions).remove(&id);
    }
}
