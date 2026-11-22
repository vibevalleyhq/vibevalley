//! VibeValley's server, in process: the one state (`vibevalley-core`'s `Core`),
//! the endpoint table by op name (`vibevalley-protocol`'s `ENDPOINTS`) with the
//! same payloads and envelopes, per-domain slice feeds (`board`, `sessions`,
//! `collab`, `inbox`, `ops`, `farm`), live events and subscriptions. It
//! implements [`crate::transport::api::Server`] for the bridge and HTTP
//! adapters.
//!
//! Modules register their handlers with [`Hub::on`] (typed by
//! `vibevalley_protocol::ops`) and their subscriptions with
//! [`Hub::on_subscription`]; they change the state only through
//! [`Hub::apply`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use vibevalley_core::{Applied, Core, SliceMask, Transition};
use vibevalley_protocol::{
    ApiError, BizCode, BoardSlice, Caller, CollabSlice, Envelope, Fact, FarmFrame, GameEffect, InboxItem, InboxSlice, LiveEvent, LiveEventNotice,
    LiveEventRuntime, LiveEventSession, Millis, NoticeLevel, Op, OpsSlice, RuntimeInfo, STATE_EVERY_MS, SessionEvent, SessionsSlice, SliceBundle, SliceKind,
    SpaceState, Subscription, endpoint,
};

pub mod transport;
pub use crate::transport::api::{
    CallerContext, CallerPrincipal, ClientIdentity, ClientKind, FaultGate, HostDebugBridge, InvokeObserver, Server, SharedFaultGate, SharedHostDebug,
    SharedInvokeObserver, refusal,
};

pub mod base;
pub(crate) mod db;
pub mod event_bus;
pub use vibevalley_protocol::home;
pub mod modules;
pub mod offline;
mod runtime_inbox;
pub mod slice_feed;
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

/// What a handler is called with: caller role, principal, optional client identity, trace id, and the hub.
pub struct Ctx<'a> {
    pub caller: Caller,
    pub principal: CallerPrincipal,
    pub client: Option<ClientIdentity>,
    pub trace_id: u64,
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

#[derive(Default)]
struct Streams {
    live: Vec<flume::Sender<LiveEvent>>,
}

struct Kick {
    dirty: SliceMask,
    effects: Vec<GameEffect>,
}

struct SliceFeeds {
    board: slice_feed::SliceFeed<BoardSlice>,
    sessions: slice_feed::SliceFeed<SessionsSlice>,
    collab: slice_feed::SliceFeed<CollabSlice>,
    inbox: slice_feed::SliceFeed<InboxSlice>,
    ops: slice_feed::SliceFeed<OpsSlice>,
    farm: slice_feed::SliceFeed<FarmFrame>,
}

const WORKBENCH_SLICES: [SliceKind; 5] = [SliceKind::Board, SliceKind::Sessions, SliceKind::Collab, SliceKind::Inbox, SliceKind::Ops];

const fn slice_index(kind: SliceKind) -> usize {
    match kind {
        SliceKind::Board => 0,
        SliceKind::Sessions => 1,
        SliceKind::Collab => 2,
        SliceKind::Inbox => 3,
        SliceKind::Ops => 4,
        SliceKind::Farm => 5,
    }
}

/// The server: the state, the endpoints and the slice feeds. Cheap to share
/// (`Arc<Hub>`).
pub struct Hub {
    core: Mutex<Core>,
    seq: AtomicI64,
    dirty_seqs: [AtomicI64; 6],
    runtime_inbox_items: RwLock<Vec<InboxItem>>,
    pub(crate) runtime_inbox: runtime_inbox::RuntimeInboxObserver,
    feeds: SliceFeeds,
    bus: event_bus::EventBus,
    execution: std::sync::OnceLock<std::sync::Weak<modules::team::orchestrator::Orchestrator>>,
    handlers: RwLock<HashMap<&'static str, Handler>>,
    openers: RwLock<HashMap<&'static str, Opener>>,
    streams: Mutex<Streams>,
    subscriptions: Mutex<HashMap<u64, flume::Sender<()>>>,
    next_id: AtomicU64,
    next_trace_id: AtomicU64,
    has_observer: AtomicBool,
    observer: RwLock<Option<SharedInvokeObserver>>,
    has_fault_gate: AtomicBool,
    fault_gate: RwLock<Option<SharedFaultGate>>,
    host_debug: RwLock<Option<SharedHostDebug>>,
    voice: RwLock<Option<Arc<modules::collab::voice::Voice>>>,
    media_inputs: RwLock<Option<crate::transport::api::media::SharedMediaInputs>>,
    mcp: RwLock<Option<crate::transport::api::SharedMcp>>,
    speech: RwLock<Option<crate::transport::api::media::SharedSpeechStreams>>,
    /// Each fold's dirty slice mask and farm effects, for the feed thread.
    kicks: flume::Sender<Kick>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hub {
    /// Streamed speech (`modules::content::media::jobs::Jobs`).
    pub fn attach_speech_streams(&self, streams: crate::transport::api::media::SharedSpeechStreams) {
        *self.speech.write().unwrap_or_else(|e| e.into_inner()) = Some(streams);
    }

    /// The helpers' MCP door (`modules::team::mcp::Door`).
    pub fn attach_mcp(&self, door: crate::transport::api::SharedMcp) {
        *self.mcp.write().unwrap_or_else(|e| e.into_inner()) = Some(door);
    }

    pub fn attach_media_inputs(&self, inputs: crate::transport::api::media::SharedMediaInputs) {
        *self.media_inputs.write().unwrap_or_else(|e| e.into_inner()) = Some(inputs);
    }

    /// Attaches or clears the zero-overhead RPC / `Core::apply` observer.
    pub fn attach_observer(&self, observer: Option<SharedInvokeObserver>) {
        let enabled = observer.is_some();
        let previous = {
            let mut slot = self.observer.write().unwrap_or_else(|e| e.into_inner());
            let prev = std::mem::replace(&mut *slot, observer);
            self.has_observer.store(enabled, Ordering::Release);
            prev
        };
        drop(previous);
    }

    /// Attaches or clears the fault-injection gate for DevTools Lab & Overrides.
    pub fn attach_fault_gate(&self, gate: Option<SharedFaultGate>) {
        let enabled = gate.is_some();
        let previous = {
            let mut slot = self.fault_gate.write().unwrap_or_else(|e| e.into_inner());
            let prev = std::mem::replace(&mut *slot, gate);
            self.has_fault_gate.store(enabled, Ordering::Release);
            prev
        };
        drop(previous);
    }

    /// Attaches or clears the desktop host shell debug bridge.
    pub fn attach_host_debug(&self, bridge: Option<SharedHostDebug>) {
        let previous = {
            let mut slot = self.host_debug.write().unwrap_or_else(|e| e.into_inner());
            std::mem::replace(&mut *slot, bridge)
        };
        drop(previous);
    }

    /// Attaches the started voice controller so desktop callers read it from [`Server::voice`].
    pub fn attach_voice(&self, voice: Arc<modules::collab::voice::Voice>) {
        *self.voice.write().unwrap_or_else(|e| e.into_inner()) = Some(voice);
    }

    /// A server holding `state`, with no endpoint answered yet. Its feed
    /// thread ends when the last `Arc<Hub>` is dropped.
    pub fn new(state: SpaceState) -> Arc<Hub> {
        let (kicks, kicked) = flume::unbounded();
        let core = Core::new(state);
        let seq = core.seq();
        let feeds = SliceFeeds {
            board: slice_feed::SliceFeed::new("slice:board", core.board_slice()),
            sessions: slice_feed::SliceFeed::new("slice:sessions", core.sessions_slice()),
            collab: slice_feed::SliceFeed::new("slice:collab", core.collab_slice()),
            inbox: slice_feed::SliceFeed::new("slice:inbox", core.inbox_slice(&[])),
            ops: slice_feed::SliceFeed::new("slice:ops", core.ops_slice()),
            farm: slice_feed::SliceFeed::new("slice:farm", core.farm_frame(vec![])),
        };
        let hub = Arc::new(Hub {
            core: Mutex::new(core),
            seq: AtomicI64::new(seq),
            dirty_seqs: std::array::from_fn(|_| AtomicI64::new(seq)),
            runtime_inbox_items: RwLock::new(vec![]),
            runtime_inbox: runtime_inbox::RuntimeInboxObserver::new(),
            feeds,
            bus: event_bus::EventBus::new(),
            execution: std::sync::OnceLock::new(),
            handlers: RwLock::default(),
            openers: RwLock::default(),
            streams: Mutex::default(),
            subscriptions: Mutex::default(),
            next_id: AtomicU64::new(1),
            next_trace_id: AtomicU64::new(1),
            has_observer: AtomicBool::new(false),
            observer: RwLock::new(None),
            has_fault_gate: AtomicBool::new(false),
            fault_gate: RwLock::new(None),
            host_debug: RwLock::new(None),
            voice: RwLock::new(None),
            media_inputs: RwLock::new(None),
            mcp: RwLock::new(None),
            speech: RwLock::new(None),
            kicks,
        });
        hub.bus.attach_hub(Arc::downgrade(&hub));
        let weak = Arc::downgrade(&hub);
        std::thread::Builder::new()
            .name("vibevalley-server-slices".into())
            .spawn(move || pump_slices(weak, kicked))
            .expect("a thread for the slice feeds");
        hub
    }

    fn current_observer(&self) -> Option<SharedInvokeObserver> {
        if !self.has_observer.load(Ordering::Relaxed) {
            return None;
        }
        self.observer.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn current_fault_gate(&self) -> Option<SharedFaultGate> {
        if !self.has_fault_gate.load(Ordering::Relaxed) {
            return None;
        }
        self.fault_gate.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The state now.
    pub fn state_now(&self) -> SpaceState {
        lock(&self.core).state().clone()
    }

    /// Reads the state without copying it.
    pub fn read<R>(&self, f: impl FnOnce(&SpaceState) -> R) -> R {
        f(lock(&self.core).state())
    }

    pub fn seq(&self) -> i64 {
        self.seq.load(Ordering::Acquire)
    }

    fn dirty_seq(&self, kind: SliceKind) -> i64 {
        self.dirty_seqs[slice_index(kind)].load(Ordering::Acquire)
    }

    pub fn board_slice(&self) -> BoardSlice {
        let core = lock(&self.core);
        vibevalley_core::board_slice(core.state(), self.dirty_seq(SliceKind::Board))
    }

    pub fn sessions_slice(&self) -> SessionsSlice {
        let core = lock(&self.core);
        vibevalley_core::sessions_slice(core.state(), self.dirty_seq(SliceKind::Sessions))
    }

    pub fn collab_slice(&self) -> CollabSlice {
        let core = lock(&self.core);
        vibevalley_core::collab_slice(core.state(), self.dirty_seq(SliceKind::Collab))
    }

    pub fn inbox_slice(&self) -> InboxSlice {
        let core = lock(&self.core);
        let extra = self.runtime_inbox_items.read().unwrap_or_else(|e| e.into_inner());
        vibevalley_core::inbox_slice(core.state(), self.dirty_seq(SliceKind::Inbox), &extra)
    }

    pub fn ops_slice(&self) -> OpsSlice {
        let core = lock(&self.core);
        vibevalley_core::ops_slice(core.state(), self.dirty_seq(SliceKind::Ops))
    }

    pub fn farm_frame(&self) -> FarmFrame {
        let core = lock(&self.core);
        vibevalley_core::farm_frame(core.state(), vec![], self.dirty_seq(SliceKind::Farm))
    }

    pub fn slice_bundle(&self) -> SliceBundle {
        let core = lock(&self.core);
        let extra = self.runtime_inbox_items.read().unwrap_or_else(|e| e.into_inner());
        let state = core.state();
        let seq = self.seq.load(Ordering::Acquire);
        SliceBundle {
            seq,
            board: vibevalley_core::board_slice(state, self.dirty_seq(SliceKind::Board)),
            sessions: vibevalley_core::sessions_slice(state, self.dirty_seq(SliceKind::Sessions)),
            collab: vibevalley_core::collab_slice(state, self.dirty_seq(SliceKind::Collab)),
            inbox: vibevalley_core::inbox_slice(state, self.dirty_seq(SliceKind::Inbox), &extra),
            ops: vibevalley_core::ops_slice(state, self.dirty_seq(SliceKind::Ops)),
            farm: vibevalley_core::farm_frame(state, vec![], self.dirty_seq(SliceKind::Farm)),
        }
    }

    /// Replaces runtime-projected durable inbox items and kicks `SliceMask::INBOX` immediately if changed.
    pub(crate) fn set_runtime_inbox(&self, items: Vec<InboxItem>) {
        let changed = {
            let mut slot = self.runtime_inbox_items.write().unwrap_or_else(|e| e.into_inner());
            if *slot == items {
                false
            } else {
                *slot = items;
                true
            }
        };
        if !changed {
            return;
        }
        let seq = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
        self.dirty_seqs[slice_index(SliceKind::Inbox)].store(seq, Ordering::Release);
        let _ = self.kicks.send(Kick {
            dirty: SliceMask::INBOX,
            effects: vec![],
        });
    }

    fn sync_slice(&self, kind: SliceKind) {
        let target = self.dirty_seq(kind);
        let locale = vibevalley_i18n::locale();
        match kind {
            SliceKind::Board => {
                let snap = self.feeds.board.snapshot();
                if snap.seq >= target && snap.locale == locale {
                    return;
                }
                let core = lock(&self.core);
                let target = self.dirty_seq(SliceKind::Board);
                let snap = self.feeds.board.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.board.replace_if_newer(vibevalley_core::board_slice(core.state(), target));
                }
            }
            SliceKind::Sessions => {
                let snap = self.feeds.sessions.snapshot();
                if snap.seq >= target && snap.locale == locale {
                    return;
                }
                let core = lock(&self.core);
                let target = self.dirty_seq(SliceKind::Sessions);
                let snap = self.feeds.sessions.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.sessions.replace_if_newer(vibevalley_core::sessions_slice(core.state(), target));
                }
            }
            SliceKind::Collab => {
                let snap = self.feeds.collab.snapshot();
                if snap.seq >= target && snap.locale == locale {
                    return;
                }
                let core = lock(&self.core);
                let target = self.dirty_seq(SliceKind::Collab);
                let snap = self.feeds.collab.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.collab.replace_if_newer(vibevalley_core::collab_slice(core.state(), target));
                }
            }
            SliceKind::Inbox => {
                let snap = self.feeds.inbox.snapshot();
                if snap.seq >= target && snap.locale == locale {
                    return;
                }
                let core = lock(&self.core);
                let extra = self.runtime_inbox_items.read().unwrap_or_else(|e| e.into_inner());
                let target = self.dirty_seq(SliceKind::Inbox);
                let snap = self.feeds.inbox.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.inbox.replace_if_newer(vibevalley_core::inbox_slice(core.state(), target, &extra));
                }
            }
            SliceKind::Ops => {
                let snap = self.feeds.ops.snapshot();
                if snap.seq >= target && snap.locale == locale {
                    return;
                }
                let core = lock(&self.core);
                let target = self.dirty_seq(SliceKind::Ops);
                let snap = self.feeds.ops.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.ops.replace_if_newer(vibevalley_core::ops_slice(core.state(), target));
                }
            }
            SliceKind::Farm => {
                let snap = self.feeds.farm.snapshot();
                if snap.seq >= target && snap.locale == locale {
                    return;
                }
                let core = lock(&self.core);
                let target = self.dirty_seq(SliceKind::Farm);
                let snap = self.feeds.farm.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.farm.replace_if_newer(vibevalley_core::farm_frame(core.state(), vec![], target));
                }
            }
        }
    }

    fn sync_farm_with_effects(&self, effects: Vec<GameEffect>) {
        let core = lock(&self.core);
        let target = self.dirty_seq(SliceKind::Farm);
        let frame = vibevalley_core::farm_frame(core.state(), effects, target);
        if frame.effects.is_empty() {
            self.feeds.farm.replace_if_newer(frame);
        } else {
            self.feeds.farm.replace(frame);
        }
    }

    fn should_publish_slice(&self, kind: SliceKind, target_seq: i64, leading: bool) -> bool {
        match kind {
            SliceKind::Board => self.feeds.board.should_publish(target_seq, leading),
            SliceKind::Sessions => self.feeds.sessions.should_publish(target_seq, leading),
            SliceKind::Collab => self.feeds.collab.should_publish(target_seq, leading),
            SliceKind::Inbox => self.feeds.inbox.should_publish(target_seq, leading),
            SliceKind::Ops => self.feeds.ops.should_publish(target_seq, leading),
            SliceKind::Farm => self.feeds.farm.should_publish(target_seq, leading),
        }
    }

    fn slice_has_watchers(&self, kind: SliceKind) -> bool {
        match kind {
            SliceKind::Board => self.feeds.board.has_watchers(),
            SliceKind::Sessions => self.feeds.sessions.has_watchers(),
            SliceKind::Collab => self.feeds.collab.has_watchers(),
            SliceKind::Inbox => self.feeds.inbox.has_watchers(),
            SliceKind::Ops => self.feeds.ops.has_watchers(),
            SliceKind::Farm => self.feeds.farm.has_watchers(),
        }
    }

    fn publish_slice(&self, kind: SliceKind, leading: bool) {
        match kind {
            SliceKind::Board => self.feeds.board.publish(leading),
            SliceKind::Sessions => self.feeds.sessions.publish(leading),
            SliceKind::Collab => self.feeds.collab.publish(leading),
            SliceKind::Inbox => self.feeds.inbox.publish(leading),
            SliceKind::Ops => self.feeds.ops.publish(leading),
            SliceKind::Farm => self.feeds.farm.publish(leading),
        }
    }

    /// Registers a bounded-1 wakeup receiver on one slice feed for internal observers (`watch_session`, `watch_issue`).
    pub fn watch_slice_signal(&self, slice: SliceKind, initial: bool) -> flume::Receiver<()> {
        match slice {
            SliceKind::Board => self.feeds.board.subscribe_signal(initial),
            SliceKind::Sessions => self.feeds.sessions.subscribe_signal(initial),
            SliceKind::Collab => self.feeds.collab.subscribe_signal(initial),
            SliceKind::Inbox => self.feeds.inbox.subscribe_signal(initial),
            SliceKind::Ops => self.feeds.ops.subscribe_signal(initial),
            SliceKind::Farm => self.feeds.farm.subscribe_signal(initial),
        }
    }

    /// Folds `facts` in as one commit (`Core.apply`): publishes transitions
    /// asynchronously on the event bus and kicks ONLY dirty slice feeds
    /// (routing `applied.effects` only to `farm`).
    pub fn apply(&self, facts: Vec<Fact>) -> Applied {
        let observer = self.current_observer();
        let started = observer.as_ref().map(|_| Instant::now());
        let (applied, seq) = {
            let mut core = lock(&self.core);
            let changes = core.apply(facts);
            let seq = if !changes.transitions.is_empty() {
                let seq = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
                let mut dirty = changes.dirty;
                if !changes.effects.is_empty() {
                    dirty |= SliceMask::FARM;
                }
                for kind in dirty.kinds() {
                    self.dirty_seqs[slice_index(kind)].store(seq, Ordering::Release);
                }
                seq
            } else {
                self.seq.load(Ordering::Acquire)
            };
            (changes, seq)
        };
        if applied.transitions.is_empty() {
            return applied;
        }
        if let (Some(obs), Some(t0)) = (observer, started) {
            obs.on_apply(seq, applied.dirty, &applied.transitions, t0.elapsed().as_micros() as u64);
        }
        self.bus.publish(&applied.transitions);
        let _ = self.kicks.send(Kick {
            dirty: applied.dirty,
            effects: applied.effects.clone(),
        });
        applied
    }

    /// Subscribes to folded transitions on a dedicated bounded async worker
    /// thread (`vibevalley-bus-{name}`).
    pub fn subscribe_transitions(
        &self,
        name: &'static str,
        handler: impl Fn(&Arc<Hub>, &Transition) + Send + Sync + 'static,
    ) -> crate::event_bus::Subscription {
        self.bus.subscribe(name, handler)
    }

    /// Cooperatively signals and joins all registered event bus subscribers.
    pub fn close_bus(&self) {
        self.bus.close();
    }

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

    /// Invokes one endpoint with caller identity, principal, and optional trace id.
    pub fn call_with(&self, caller_ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        let observer = self.current_observer();
        let (started, effective_ctx_owned);
        let effective_ctx = if let Some(obs) = &observer {
            let trace_id = if caller_ctx.trace_id != 0 {
                caller_ctx.trace_id
            } else {
                self.next_trace_id.fetch_add(1, Ordering::Relaxed)
            };
            effective_ctx_owned = CallerContext {
                caller: caller_ctx.caller,
                principal: caller_ctx.principal.clone(),
                client: caller_ctx.client.clone(),
                trace_id,
            };
            obs.on_call_start(&effective_ctx_owned, op, &payload);
            started = Some(Instant::now());
            &effective_ctx_owned
        } else {
            started = None;
            caller_ctx
        };

        if let Some(gate) = self.current_fault_gate() {
            let delay = gate.delay_ms(op);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }

        let envelope = self.dispatch_call(effective_ctx, op, payload);
        if let (Some(obs), Some(t0)) = (observer, started) {
            obs.on_call_end(effective_ctx, op, envelope.biz_code, t0.elapsed().as_micros() as u64);
        }
        envelope
    }

    fn dispatch_call(&self, caller_ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        let Some(e) = endpoint(op) else {
            return refusal(BizCode::RouteNotFound, format!("no endpoint {op}"));
        };
        if caller_ctx.caller != Caller::User && !e.can.contains(&caller_ctx.caller) {
            return refusal(BizCode::Forbidden, format!("{op} is not for the {:?}", caller_ctx.caller));
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
        let ctx = Ctx {
            caller: caller_ctx.caller,
            principal: caller_ctx.principal.clone(),
            client: caller_ctx.client.clone(),
            trace_id: caller_ctx.trace_id,
            hub: self,
        };
        match handler(&ctx, payload) {
            Ok(data) if e.result.is_none() => {
                let _ = data;
                Envelope::void()
            }
            Ok(data) => Envelope::ok(data),
            Err(err) => Envelope::failure(&err),
        }
    }

    /// One endpoint as `caller`.
    pub fn call_as(&self, caller: Caller, op: &str, payload: Value) -> Envelope {
        self.call_with(&CallerContext::from_caller(caller), op, payload)
    }

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

/// The slice feed pump: leading-edge delivery for workbench slices when idle,
/// and coalesced trailing-edge delivery after `STATE_EVERY_MS` for dirty slices
/// plus accumulated farm effects on `SliceKind::Farm`.
fn pump_slices(hub: std::sync::Weak<Hub>, kicked: flume::Receiver<Kick>) {
    while let Ok(first) = kicked.recv() {
        let mut dirty = first.dirty;
        let mut effects = first.effects;
        if !effects.is_empty() {
            dirty |= SliceMask::FARM;
        }
        let deadline = Instant::now() + Duration::from_millis(STATE_EVERY_MS);
        let Some(leading) = hub.upgrade() else { return };
        for kind in WORKBENCH_SLICES {
            if dirty.contains(SliceMask::from_kind(kind)) {
                let target = leading.dirty_seq(kind);
                if leading.should_publish_slice(kind, target, true) {
                    leading.sync_slice(kind);
                    leading.publish_slice(kind, true);
                }
            }
        }
        drop(leading);
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
        for more in kicked.drain() {
            dirty |= more.dirty;
            effects.extend(more.effects);
        }
        if !effects.is_empty() {
            dirty |= SliceMask::FARM;
        }
        let Some(hub) = hub.upgrade() else { return };
        for kind in WORKBENCH_SLICES {
            if dirty.contains(SliceMask::from_kind(kind)) && hub.slice_has_watchers(kind) {
                hub.sync_slice(kind);
                hub.publish_slice(kind, false);
            }
        }
        if dirty.contains(SliceMask::FARM) && hub.slice_has_watchers(SliceKind::Farm) {
            hub.sync_farm_with_effects(effects);
            hub.publish_slice(SliceKind::Farm, false);
        }
    }
}

/// The board's facts go into the server's one state.
impl modules::work::ledger::Facts for Hub {
    fn apply(&self, facts: Vec<Fact>) -> Applied {
        Hub::apply(self, facts)
    }

    fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
        f(lock(&self.core).state())
    }

    fn bundle(&self) -> SliceBundle {
        Hub::slice_bundle(self)
    }
}

impl modules::work::ledger::Facts for std::sync::Weak<Hub> {
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

    fn bundle(&self) -> SliceBundle {
        match self.upgrade() {
            Some(hub) => Hub::slice_bundle(&hub),
            None => Core::default().slice_bundle(vec![]),
        }
    }
}

impl Server for Hub {
    fn raise_budget(&self, input: Value) -> Envelope {
        self.execution.get().and_then(std::sync::Weak::upgrade).map_or_else(
            || crate::transport::api::refusal(BizCode::Refused, "durable execution unavailable"),
            |o| o.execution.raise_budget(input),
        )
    }

    fn speech_streams(&self) -> Option<crate::transport::api::media::SharedSpeechStreams> {
        self.speech.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn mcp(&self) -> Option<crate::transport::api::SharedMcp> {
        self.mcp.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn media_inputs(&self) -> Option<crate::transport::api::media::SharedMediaInputs> {
        self.media_inputs.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn host_debug(&self) -> Option<SharedHostDebug> {
        self.host_debug.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn voice(&self) -> Option<Arc<modules::collab::voice::Voice>> {
        self.voice.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.call_with(&CallerContext::local(), op, payload)
    }

    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        Hub::call_with(self, ctx, op, payload)
    }

    fn slice_snapshot(&self, slice: SliceKind) -> Value {
        if slice == SliceKind::Farm {
            return serde_json::to_value(self.farm_frame()).expect("farm frame serializes");
        }
        self.sync_slice(slice);
        match slice {
            SliceKind::Board => self.feeds.board.snapshot().wire().clone(),
            SliceKind::Sessions => self.feeds.sessions.snapshot().wire().clone(),
            SliceKind::Collab => self.feeds.collab.snapshot().wire().clone(),
            SliceKind::Inbox => self.feeds.inbox.snapshot().wire().clone(),
            SliceKind::Ops => self.feeds.ops.snapshot().wire().clone(),
            SliceKind::Farm => unreachable!(),
        }
    }

    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        self.sync_slice(slice);
        let gate = self.current_fault_gate();
        match slice {
            SliceKind::Board => self.feeds.board.watch_since(after_seq, gate.as_ref(), stop, receive),
            SliceKind::Sessions => self.feeds.sessions.watch_since(after_seq, gate.as_ref(), stop, receive),
            SliceKind::Collab => self.feeds.collab.watch_since(after_seq, gate.as_ref(), stop, receive),
            SliceKind::Inbox => self.feeds.inbox.watch_since(after_seq, gate.as_ref(), stop, receive),
            SliceKind::Ops => self.feeds.ops.watch_since(after_seq, gate.as_ref(), stop, receive),
            SliceKind::Farm => {
                // Fresh watchers receive the current farm state with no stale one-shot effects;
                // subsequent live updates carry that burst's ordered effects.
                let mut initial = after_seq.is_none();
                self.feeds.farm.watch_since(after_seq, gate.as_ref(), stop, &mut |seq, val| {
                    if initial {
                        initial = false;
                        if val.get("effects").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
                            let mut clean = val.clone();
                            clean["effects"] = Value::Array(vec![]);
                            receive(seq, &clean);
                            return;
                        }
                    }
                    receive(seq, val);
                });
            }
        }
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
