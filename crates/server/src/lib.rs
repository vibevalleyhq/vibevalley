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

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use arc_swap::ArcSwapOption;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use vibevalley_core::{Applied, Core, SliceMask, Transition};
use vibevalley_protocol::{
    ApiError, BizCode, BoardSlice, Caller, CollabSlice, Envelope, Fact, FarmFrame, GameEffect, InboxSlice, LiveEvent, LiveEventNotice, LiveEventRuntime,
    LiveEventSession, Millis, NoticeLevel, Op, OpsSlice, RuntimeInfo, STATE_EVERY_MS, SessionEvent, SessionsSlice, SliceBundle, SliceKind, SpaceState,
    Subscription, endpoint,
};

pub mod transport;
pub use crate::transport::api::{
    CallerContext, CallerPrincipal, ClientIdentity, ClientKind, FaultGate, HostDebugBridge, InvokeObserver, LiveVoiceLine, LiveVoicePort, RemoteAuth,
    RemoteDeviceIdentity, Server, SharedFaultGate, SharedHostDebug, SharedInvokeObserver, SharedLiveVoice, SharedRemoteAuth, refusal,
};

pub mod base;
pub(crate) mod db;
pub mod event_bus;
pub use vibevalley_protocol::home;
pub mod modules;
pub mod offline;
pub mod ports;
mod runtime_inbox;
pub mod slice_feed;
mod start;
pub mod testing;

pub use start::{ServerConfig, StartError, Started, start};

const LIVE_CAPACITY: usize = 512;
const HUB_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

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
type TypedHandler<O> = Arc<dyn Fn(&Ctx, <O as Op>::Input) -> Result<<O as Op>::Result, ApiError> + Send + Sync>;

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

struct InvokeObserverSlot(SharedInvokeObserver);
struct FaultGateSlot(SharedFaultGate);
struct HostDebugSlot(SharedHostDebug);
struct McpSlot(crate::transport::api::SharedMcp);
struct RemoteAuthSlot(SharedRemoteAuth);
struct SpeechStreamsSlot(crate::transport::api::media::SharedSpeechStreams);
struct MediaInputsSlot(crate::transport::api::media::SharedMediaInputs);

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
    pub(crate) runtime_inbox: runtime_inbox::RuntimeInboxObserver,
    feeds: SliceFeeds,
    bus: event_bus::EventBus,
    shutdown: CancellationToken,
    tasks: TaskTracker,
    handlers: RwLock<HashMap<&'static str, Handler>>,
    typed_handlers: RwLock<HashMap<&'static str, Arc<dyn Any + Send + Sync>>>,
    openers: RwLock<HashMap<&'static str, (&'static [Caller], Opener)>>,
    live: broadcast::Sender<LiveEvent>,
    subscriptions: Mutex<HashMap<u64, flume::Sender<()>>>,
    next_id: AtomicU64,
    next_trace_id: AtomicU64,
    observer: ArcSwapOption<InvokeObserverSlot>,
    fault_gate: ArcSwapOption<FaultGateSlot>,
    host_debug: ArcSwapOption<HostDebugSlot>,
    voice: OnceLock<SharedLiveVoice>,
    media_inputs: ArcSwapOption<MediaInputsSlot>,
    mcp: ArcSwapOption<McpSlot>,
    remote_auth: ArcSwapOption<RemoteAuthSlot>,
    speech: ArcSwapOption<SpeechStreamsSlot>,
    /// Each fold's dirty slice mask and farm effects, for the feed pump task.
    kicks: flume::Sender<Kick>,
}

impl Drop for Hub {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

impl Hub {
    /// Root shutdown token for this hub.
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// Child shutdown token cancelled automatically when the hub closes or drops.
    pub fn child_token(&self) -> CancellationToken {
        self.shutdown.child_token()
    }

    /// Spawns a tracked background task on the shared `vibevalley-io` Tokio runtime.
    pub fn spawn_task<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.tasks.spawn_on(future, vibevalley_runtime::rt::handle())
    }

    /// Spawns a tracked blocking task on the shared `vibevalley-io` Tokio runtime.
    pub fn spawn_blocking_task<F, R>(&self, func: F) -> tokio::task::JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        self.tasks.spawn_blocking_on(func, vibevalley_runtime::rt::handle())
    }

    /// Cancels the hub's shutdown token, stops the event bus, and waits up to
    /// [`HUB_SHUTDOWN_GRACE`] for all tracked background tasks to finish.
    pub fn close(&self) {
        self.shutdown.cancel();
        self.bus.close();
        self.tasks.close();
        if vibevalley_runtime::rt::block_on(async { tokio::time::timeout(HUB_SHUTDOWN_GRACE, self.tasks.wait()).await }).is_err() {
            tracing::warn!(
                remaining = self.tasks.len(),
                timeout_secs = HUB_SHUTDOWN_GRACE.as_secs(),
                "hub.close timed out waiting for tracked background tasks"
            );
        }
    }

    /// Streamed speech (`modules::content::media::jobs::Jobs`).
    pub fn attach_speech_streams(&self, streams: crate::transport::api::media::SharedSpeechStreams) {
        self.speech.store(Some(Arc::new(SpeechStreamsSlot(streams))));
    }

    /// The helpers' MCP door (`modules::team::mcp::Door`).
    pub fn attach_mcp(&self, door: crate::transport::api::SharedMcp) {
        self.mcp.store(Some(Arc::new(McpSlot(door))));
    }

    pub fn attach_media_inputs(&self, inputs: crate::transport::api::media::SharedMediaInputs) {
        self.media_inputs.store(Some(Arc::new(MediaInputsSlot(inputs))));
    }

    /// Attaches or clears the zero-overhead RPC / `Core::apply` observer.
    pub fn attach_observer(&self, observer: Option<SharedInvokeObserver>) {
        self.observer.store(observer.map(|o| Arc::new(InvokeObserverSlot(o))));
    }

    /// Attaches or clears the fault-injection gate for DevTools Lab & Overrides.
    pub fn attach_fault_gate(&self, gate: Option<SharedFaultGate>) {
        self.fault_gate.store(gate.map(|g| Arc::new(FaultGateSlot(g))));
    }

    /// Attaches or clears the desktop host shell debug bridge.
    pub fn attach_host_debug(&self, bridge: Option<SharedHostDebug>) {
        self.host_debug.store(bridge.map(|b| Arc::new(HostDebugSlot(b))));
    }

    /// Attaches the started voice controller port so desktop callers read it from [`Server::voice`].
    pub fn attach_voice(&self, voice: SharedLiveVoice) {
        let _ = self.voice.set(voice);
    }

    /// Attaches or clears the remote mobile device authenticator.
    pub fn attach_remote_auth(&self, auth: Option<SharedRemoteAuth>) {
        self.remote_auth.store(auth.map(|a| Arc::new(RemoteAuthSlot(a))));
    }

    /// A server holding `state`, with no endpoint answered yet. Its feed
    /// pump ends when [`Hub::close`] is called or the last `Arc<Hub>` is dropped.
    pub fn new(state: SpaceState) -> Arc<Hub> {
        let (kicks, kicked) = flume::unbounded();
        let (live, _live_rx) = broadcast::channel(LIVE_CAPACITY);
        let core = Core::new(state);
        let seq = core.seq();
        let feeds = SliceFeeds {
            board: slice_feed::SliceFeed::new("slice:board", core.board_slice()),
            sessions: slice_feed::SliceFeed::new("slice:sessions", core.sessions_slice()),
            collab: slice_feed::SliceFeed::new("slice:collab", core.collab_slice()),
            inbox: slice_feed::SliceFeed::new("slice:inbox", core.inbox_slice()),
            ops: slice_feed::SliceFeed::new("slice:ops", core.ops_slice()),
            farm: slice_feed::SliceFeed::new("slice:farm", core.farm_frame(vec![])),
        };
        let shutdown = CancellationToken::new();
        let bus = event_bus::EventBus::new(shutdown.child_token());
        let hub = Arc::new(Hub {
            core: Mutex::new(core),
            seq: AtomicI64::new(seq),
            dirty_seqs: std::array::from_fn(|_| AtomicI64::new(seq)),
            runtime_inbox: runtime_inbox::RuntimeInboxObserver::new(),
            feeds,
            bus,
            shutdown,
            tasks: TaskTracker::new(),
            handlers: RwLock::default(),
            typed_handlers: RwLock::default(),
            openers: RwLock::default(),
            live,
            subscriptions: Mutex::default(),
            next_id: AtomicU64::new(1),
            next_trace_id: AtomicU64::new(1),
            observer: ArcSwapOption::empty(),
            fault_gate: ArcSwapOption::empty(),
            host_debug: ArcSwapOption::empty(),
            voice: OnceLock::new(),
            media_inputs: ArcSwapOption::empty(),
            mcp: ArcSwapOption::empty(),
            remote_auth: ArcSwapOption::empty(),
            speech: ArcSwapOption::empty(),
            kicks,
        });
        hub.bus.attach_hub(Arc::downgrade(&hub));
        let weak = Arc::downgrade(&hub);
        let cancel = hub.child_token();
        hub.spawn_task(pump_slices(weak, kicked, cancel));
        hub
    }

    fn current_observer(&self) -> Option<SharedInvokeObserver> {
        self.observer.load().as_ref().map(|slot| slot.0.clone())
    }

    fn current_fault_gate(&self) -> Option<SharedFaultGate> {
        self.fault_gate.load().as_ref().map(|slot| slot.0.clone())
    }

    /// Whether an RPC / `Core::apply` observer is currently attached.
    pub fn has_observer(&self) -> bool {
        self.observer.load().is_some()
    }

    /// Whether a fault-injection gate is currently attached.
    pub fn has_fault_gate(&self) -> bool {
        self.fault_gate.load().is_some()
    }

    /// Current dirty sequence number for each of the six domain slices.
    pub fn slice_seqs(&self) -> BTreeMap<String, i64> {
        SliceKind::ALL
            .into_iter()
            .map(|kind| (kind.as_str().to_string(), self.dirty_seq(kind)))
            .collect()
    }

    /// Current active watcher count for each of the six domain slices.
    pub fn slice_watcher_counts(&self) -> BTreeMap<String, u32> {
        SliceKind::ALL
            .into_iter()
            .map(|kind| {
                let count = match kind {
                    SliceKind::Board => self.feeds.board.watcher_count(),
                    SliceKind::Sessions => self.feeds.sessions.watcher_count(),
                    SliceKind::Collab => self.feeds.collab.watcher_count(),
                    SliceKind::Inbox => self.feeds.inbox.watcher_count(),
                    SliceKind::Ops => self.feeds.ops.watcher_count(),
                    SliceKind::Farm => self.feeds.farm.watcher_count(),
                };
                (kind.as_str().to_string(), count as u32)
            })
            .collect()
    }

    /// Number of currently open server subscriptions.
    pub fn active_subscription_count(&self) -> u32 {
        self.subscriptions.lock().len() as u32
    }

    /// The state now.
    pub fn state_now(&self) -> SpaceState {
        self.core.lock().state().clone()
    }

    /// Reads the state without copying it.
    pub fn read<R>(&self, f: impl FnOnce(&SpaceState) -> R) -> R {
        f(self.core.lock().state())
    }

    pub fn seq(&self) -> i64 {
        self.seq.load(Ordering::Acquire)
    }

    fn dirty_seq(&self, kind: SliceKind) -> i64 {
        self.dirty_seqs[slice_index(kind)].load(Ordering::Acquire)
    }

    pub fn board_slice(&self) -> BoardSlice {
        let core = self.core.lock();
        vibevalley_core::board_slice(core.state(), self.dirty_seq(SliceKind::Board))
    }

    pub fn sessions_slice(&self) -> SessionsSlice {
        let core = self.core.lock();
        vibevalley_core::sessions_slice(core.state(), self.dirty_seq(SliceKind::Sessions))
    }

    pub fn collab_slice(&self) -> CollabSlice {
        let core = self.core.lock();
        vibevalley_core::collab_slice(core.state(), self.dirty_seq(SliceKind::Collab))
    }

    pub fn inbox_slice(&self) -> InboxSlice {
        let core = self.core.lock();
        vibevalley_core::inbox_slice(core.state(), self.dirty_seq(SliceKind::Inbox))
    }

    pub fn ops_slice(&self) -> OpsSlice {
        let core = self.core.lock();
        vibevalley_core::ops_slice(core.state(), self.dirty_seq(SliceKind::Ops))
    }

    pub fn farm_frame(&self) -> FarmFrame {
        let core = self.core.lock();
        vibevalley_core::farm_frame(core.state(), vec![], self.dirty_seq(SliceKind::Farm))
    }

    pub fn slice_bundle(&self) -> SliceBundle {
        let core = self.core.lock();
        let state = core.state();
        let seq = self.seq.load(Ordering::Acquire);
        SliceBundle {
            seq,
            board: vibevalley_core::board_slice(state, self.dirty_seq(SliceKind::Board)),
            sessions: vibevalley_core::sessions_slice(state, self.dirty_seq(SliceKind::Sessions)),
            collab: vibevalley_core::collab_slice(state, self.dirty_seq(SliceKind::Collab)),
            inbox: vibevalley_core::inbox_slice(state, self.dirty_seq(SliceKind::Inbox)),
            ops: vibevalley_core::ops_slice(state, self.dirty_seq(SliceKind::Ops)),
            farm: vibevalley_core::farm_frame(state, vec![], self.dirty_seq(SliceKind::Farm)),
        }
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
                let core = self.core.lock();
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
                let core = self.core.lock();
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
                let core = self.core.lock();
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
                let core = self.core.lock();
                let target = self.dirty_seq(SliceKind::Inbox);
                let snap = self.feeds.inbox.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.inbox.replace_if_newer(vibevalley_core::inbox_slice(core.state(), target));
                }
            }
            SliceKind::Ops => {
                let snap = self.feeds.ops.snapshot();
                if snap.seq >= target && snap.locale == locale {
                    return;
                }
                let core = self.core.lock();
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
                let core = self.core.lock();
                let target = self.dirty_seq(SliceKind::Farm);
                let snap = self.feeds.farm.snapshot();
                if snap.seq < target || snap.locale != locale {
                    self.feeds.farm.replace_if_newer(vibevalley_core::farm_frame(core.state(), vec![], target));
                }
            }
        }
    }

    fn sync_farm_with_effects(&self, effects: Vec<GameEffect>) {
        let core = self.core.lock();
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

    /// Direct `watch::Receiver` subscription for one domain slice.
    pub fn subscribe_slice_feed(&self, slice: SliceKind) -> slice_feed::SliceSubscription {
        self.sync_slice(slice);
        match slice {
            SliceKind::Board => slice_feed::SliceSubscription::Board(self.feeds.board.subscribe()),
            SliceKind::Sessions => slice_feed::SliceSubscription::Sessions(self.feeds.sessions.subscribe()),
            SliceKind::Collab => slice_feed::SliceSubscription::Collab(self.feeds.collab.subscribe()),
            SliceKind::Inbox => slice_feed::SliceSubscription::Inbox(self.feeds.inbox.subscribe()),
            SliceKind::Ops => slice_feed::SliceSubscription::Ops(self.feeds.ops.subscribe()),
            SliceKind::Farm => slice_feed::SliceSubscription::Farm {
                rx: self.feeds.farm.subscribe(),
                strip_initial_effects: true,
            },
        }
    }

    /// Broadcast receiver for [`LiveEvent`]s (bounded ring buffer, automatic disconnect cleanup).
    pub fn subscribe_live(&self) -> broadcast::Receiver<LiveEvent> {
        self.live.subscribe()
    }

    /// Folds `facts` in as one commit (`Core.apply`): publishes transitions
    /// asynchronously on the event bus and kicks ONLY dirty slice feeds
    /// (routing `applied.effects` only to `farm`).
    pub fn apply(&self, facts: Vec<Fact>) -> Applied {
        let observer = self.current_observer();
        let trace_debug = tracing::enabled!(tracing::Level::DEBUG);
        let started = (observer.is_some() || trace_debug).then(Instant::now);
        let (applied, seq) = {
            let mut core = self.core.lock();
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
        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_apply(seq, applied.dirty, &applied.transitions, us);
        }
        if trace_debug {
            tracing::debug!(
                seq,
                transitions = applied.transitions.len(),
                dirty = applied.dirty.bits(),
                duration_us = duration_us.unwrap_or(0),
                "hub.apply"
            );
        }
        self.bus.publish(&applied.transitions);
        let _ = self.kicks.send(Kick {
            dirty: applied.dirty,
            effects: applied.effects.clone(),
        });
        applied
    }

    /// Subscribes to folded transitions on a dedicated bounded async worker
    /// task (`EventBus`).
    pub fn subscribe_transitions(
        &self,
        name: &'static str,
        handler: impl Fn(&Arc<Hub>, &Transition) + Send + Sync + 'static,
    ) -> crate::event_bus::Subscription {
        self.bus.subscribe(name, handler)
    }

    /// Cooperatively signals and awaits all registered event bus subscribers.
    pub fn close_bus(&self) {
        self.bus.close();
    }

    fn publish_live(&self, event: LiveEvent) {
        let _ = self.live.send(event);
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
    pub fn on<O: Op>(&self, handler: impl Fn(&Ctx, O::Input) -> Result<O::Result, ApiError> + Send + Sync + 'static)
    where
        O::Input: 'static,
        O::Result: 'static,
    {
        let typed: TypedHandler<O> = Arc::new(handler);
        let json_typed = typed.clone();
        let h: Handler = Arc::new(move |ctx, payload| {
            let input: O::Input = decode(payload)?;
            let out = json_typed(ctx, input)?;
            serde_json::to_value(out).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
        });
        self.typed_handlers.write().insert(O::NAME, Arc::new(typed));
        self.handlers.write().insert(O::NAME, h);
    }

    /// Invokes endpoint `O` directly in-process with zero JSON round-trip while
    /// enforcing `endpoint(O::NAME).can`, [`InvokeObserver`], and [`FaultGate`].
    pub fn invoke<O: Op>(&self, caller_ctx: &CallerContext, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Input: 'static,
        O::Result: 'static,
    {
        let op = O::NAME;
        let is_debug_op = op.starts_with("debug.");
        let observer = if is_debug_op { None } else { self.current_observer() };
        let trace_debug = tracing::enabled!(tracing::Level::DEBUG);
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
            let payload = serde_json::to_value(&input).unwrap_or(Value::Null);
            obs.on_call_start(&effective_ctx_owned, op, &payload);
            started = Some(Instant::now());
            &effective_ctx_owned
        } else {
            started = trace_debug.then(Instant::now);
            caller_ctx
        };

        if !is_debug_op && let Some(gate) = self.current_fault_gate() {
            let delay = gate.delay_ms(op);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }

        let result = self.dispatch_typed::<O>(effective_ctx, input);
        let biz_code = match &result {
            Ok(_) => 0,
            Err(err) => err.biz_code.code(),
        };
        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_call_end(effective_ctx, op, biz_code, us);
        }
        if trace_debug {
            tracing::debug!(
                op,
                biz_code,
                trace_id = effective_ctx.trace_id,
                duration_us = duration_us.unwrap_or(0),
                "hub.invoke"
            );
        }
        result
    }

    /// Convenience typed invocation as `caller`.
    pub fn invoke_as<O: Op>(&self, caller: Caller, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Input: 'static,
        O::Result: 'static,
    {
        self.invoke::<O>(&CallerContext::from_caller(caller), input)
    }

    fn dispatch_typed<O: Op>(&self, caller_ctx: &CallerContext, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Input: 'static,
        O::Result: 'static,
    {
        let op = O::NAME;
        let Some(e) = endpoint(op) else {
            return Err(ApiError::new(BizCode::RouteNotFound, format!("no endpoint {op}")));
        };
        if caller_ctx.caller != Caller::User && !e.can.contains(&caller_ctx.caller) {
            return Err(ApiError::new(BizCode::Forbidden, format!("{op} is not for the {:?}", caller_ctx.caller)));
        }
        let handler = self
            .typed_handlers
            .read()
            .get(op)
            .and_then(|any| any.downcast_ref::<TypedHandler<O>>().cloned());
        let Some(handler) = handler else {
            return Err(ApiError::new(BizCode::ServiceUnavailable, format!("{op} is not served by VibeValley yet")));
        };
        let ctx = Ctx {
            caller: caller_ctx.caller,
            principal: caller_ctx.principal.clone(),
            client: caller_ctx.client.clone(),
            trace_id: caller_ctx.trace_id,
            hub: self,
        };
        handler(&ctx, input)
    }

    /// Whether some module answers `op`.
    pub fn answers(&self, op: &str) -> bool {
        self.handlers.read().contains_key(op)
    }

    /// Whether some module opens subscription `name`.
    pub fn answers_subscription(&self, name: &str) -> bool {
        self.openers.read().contains_key(name)
    }

    /// Invokes one endpoint with caller identity, principal, and optional trace id.
    pub fn call_with(&self, caller_ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        let is_debug_op = op.starts_with("debug.");
        let observer = if is_debug_op { None } else { self.current_observer() };
        let trace_debug = tracing::enabled!(tracing::Level::DEBUG);
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
            started = trace_debug.then(Instant::now);
            caller_ctx
        };

        if !is_debug_op && let Some(gate) = self.current_fault_gate() {
            let delay = gate.delay_ms(op);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }

        let envelope = self.dispatch_call(effective_ctx, op, payload);
        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_call_end(effective_ctx, op, envelope.biz_code, us);
        }
        if trace_debug {
            tracing::debug!(
                op,
                biz_code = envelope.biz_code,
                trace_id = effective_ctx.trace_id,
                duration_us = duration_us.unwrap_or(0),
                "hub.call"
            );
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
        let handler = self.handlers.read().get(op).cloned();
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
        self.openers.write().insert(S::NAME, (S::CAN, o));
    }

    #[allow(clippy::result_large_err, reason = "the contract's refusal is an envelope")]
    fn open_subscription(&self, caller_ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        let Some((can, open)) = self.openers.read().get(name).cloned() else {
            return Err(refusal(BizCode::RouteNotFound, format!("no subscription {name}")));
        };
        if caller_ctx.caller != Caller::User && !can.contains(&caller_ctx.caller) {
            return Err(refusal(BizCode::Forbidden, format!("{name} is not for the {:?}", caller_ctx.caller)));
        }
        let (events, rx) = flume::unbounded();
        let (stop_tx, stop) = flume::bounded(1);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = if payload.is_null() { Value::Object(Default::default()) } else { payload };
        open(self, payload, Sink { events, stop }).map_err(|e| Envelope::failure(&e))?;
        self.subscriptions.lock().insert(id, stop_tx);
        Ok((id, rx))
    }
}

/// Bridges a `broadcast::Receiver<LiveEvent>` into a `flume::Receiver<LiveEvent>`
/// for legacy sync callers (`Server::live`).
pub(crate) fn bridge_live_receiver(mut rx: broadcast::Receiver<LiveEvent>, shutdown: CancellationToken) -> flume::Receiver<LiveEvent> {
    let (tx, out) = flume::unbounded();
    vibevalley_runtime::rt::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                res = rx.recv() => match res {
                    Ok(event) => {
                        if tx.send(event).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    if tx.is_disconnected() {
                        break;
                    }
                }
            }
        }
    });
    out
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
async fn pump_slices(hub: std::sync::Weak<Hub>, kicked: flume::Receiver<Kick>, cancel: CancellationToken) {
    loop {
        let first = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            res = kicked.recv_async() => match res {
                Ok(kick) => kick,
                Err(_) => return,
            },
        };
        let mut dirty = first.dirty;
        let mut effects = first.effects;
        if !effects.is_empty() {
            dirty |= SliceMask::FARM;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(STATE_EVERY_MS);
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
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep_until(deadline) => {}
        }
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
impl ports::Facts for Hub {
    fn apply(&self, facts: Vec<Fact>) -> Applied {
        Hub::apply(self, facts)
    }

    fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
        f(self.core.lock().state())
    }

    fn bundle(&self) -> SliceBundle {
        Hub::slice_bundle(self)
    }
}

impl ports::Facts for std::sync::Weak<Hub> {
    fn apply(&self, facts: Vec<Fact>) -> Applied {
        match self.upgrade() {
            Some(hub) => Hub::apply(&hub, facts),
            None => Core::default().apply(facts),
        }
    }

    fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
        match self.upgrade() {
            Some(hub) => f(hub.core.lock().state()),
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
    fn speech_streams(&self) -> Option<crate::transport::api::media::SharedSpeechStreams> {
        self.speech.load().as_ref().map(|slot| slot.0.clone())
    }

    fn mcp(&self) -> Option<crate::transport::api::SharedMcp> {
        self.mcp.load().as_ref().map(|slot| slot.0.clone())
    }

    fn media_inputs(&self) -> Option<crate::transport::api::media::SharedMediaInputs> {
        self.media_inputs.load().as_ref().map(|slot| slot.0.clone())
    }

    fn host_debug(&self) -> Option<SharedHostDebug> {
        self.host_debug.load().as_ref().map(|slot| slot.0.clone())
    }

    fn voice(&self) -> Option<SharedLiveVoice> {
        self.voice.get().cloned()
    }

    fn remote_auth(&self) -> Option<SharedRemoteAuth> {
        self.remote_auth.load().as_ref().map(|slot| slot.0.clone())
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

    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        if slice == SliceKind::Farm {
            return Arc::<str>::from(serde_json::to_string(&self.farm_frame()).expect("farm frame serializes"));
        }
        self.sync_slice(slice);
        match slice {
            SliceKind::Board => self.feeds.board.snapshot().json(),
            SliceKind::Sessions => self.feeds.sessions.snapshot().json(),
            SliceKind::Collab => self.feeds.collab.snapshot().json(),
            SliceKind::Inbox => self.feeds.inbox.snapshot().json(),
            SliceKind::Ops => self.feeds.ops.snapshot().json(),
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

    fn subscribe_slice(&self, slice: SliceKind) -> Option<slice_feed::SliceSubscription> {
        Some(self.subscribe_slice_feed(slice))
    }

    fn fault_gate(&self) -> Option<SharedFaultGate> {
        self.current_fault_gate()
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        bridge_live_receiver(self.live.subscribe(), self.shutdown.clone())
    }

    fn subscribe_live(&self) -> Option<broadcast::Receiver<LiveEvent>> {
        Some(self.live.subscribe())
    }

    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        self.open_subscription(&CallerContext::local(), name, payload)
    }

    fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        self.open_subscription(ctx, name, payload)
    }

    fn unsubscribe(&self, id: u64) {
        self.subscriptions.lock().remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::Hub;

    #[test]
    fn close_drains_tracked_async_and_blocking_tasks_before_returning() {
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let async_done = Arc::new(AtomicBool::new(false));
        let blocking_done = Arc::new(AtomicBool::new(false));

        let cancel = hub.child_token();
        let flag = async_done.clone();
        hub.spawn_task(async move {
            cancel.cancelled().await;
            tokio::time::sleep(Duration::from_millis(20)).await;
            flag.store(true, Ordering::Release);
        });

        let flag = blocking_done.clone();
        let (entered_tx, entered_rx) = flume::bounded::<()>(1);
        let cancel = hub.child_token();
        hub.spawn_blocking_task(move || {
            let _ = entered_tx.send(());
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            std::thread::sleep(Duration::from_millis(20));
            flag.store(true, Ordering::Release);
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("blocking task entered");

        hub.close();
        assert!(async_done.load(Ordering::Acquire), "Hub::close must drain tracked async tasks");
        assert!(blocking_done.load(Ordering::Acquire), "Hub::close must drain tracked blocking tasks");
    }
}
