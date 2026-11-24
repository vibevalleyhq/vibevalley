//! Hub spine: core state (`vibevalley-core`'s `Core`), typed endpoint dispatch,
//! per-domain slice feeds (`board`, `sessions`, `collab`, `inbox`, `ops`, `farm`),
//! live events, and subscriptions.

pub mod event_bus;
pub(crate) mod loom_sync;
pub mod ports;
pub mod refusal;
mod runtime_inbox;
pub mod slice_feed;
mod slice_wake;
pub(crate) mod ticker;

use std::any::Any;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use arc_swap::ArcSwapOption;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tokio::sync::{Notify, broadcast, watch};
use tokio_util::sync::{CancellationToken, DropGuard};
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;
use vibevalley_core::{Applied, Core, SliceMask, Transition};
use vibevalley_protocol::{
    ApiError, BizCode, BoardSlice, Caller, CollabSlice, Envelope, Fact, FarmFrame, GameEffect, InboxSlice, LiveEvent, LiveEventNotice, LiveEventRuntime,
    LiveEventSession, Millis, NoticeLevel, Op, OpsSlice, RuntimeInfo, STATE_EVERY_MS, SessionEvent, SessionsSlice, SliceBundle, SliceKind, SpaceState,
    Subscription, endpoint,
};

use crate::transport::api::{
    BoxFuture, CallerContext, CallerPrincipal, ClientIdentity, FaultGate, HostDebugBridge, InvokeObserver, MachineBus, RemoteAuth, Server, SharedFaultGate,
    SharedHostDebug, SharedInvokeObserver, SharedLiveVoice, SharedMachineBus, SharedRemoteAuth, refusal,
};

const LIVE_CAPACITY: usize = 512;
const HUB_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Installs the process-wide `ring` TLS provider once (`reqwest` and `tokio-tungstenite`).
pub fn install_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Spawns a blocking closure on the ambient Tokio runtime (falling back to
/// `vibevalley-io` outside Tokio) while preserving [`tracing::Span::current`].
pub fn spawn_blocking_traced<F, R>(f: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let dispatch = tracing::dispatcher::get_default(|d| d.clone());
    let span = tracing::Span::current();
    vibevalley_runtime::rt::current_or_global_handle().spawn_blocking(move || tracing::dispatcher::with_default(&dispatch, || span.in_scope(f)))
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

/// Owned invocation context passed to async handlers registered via [`Hub::on_async`].
#[derive(Clone)]
pub struct AsyncCtx {
    pub caller: Caller,
    pub principal: CallerPrincipal,
    pub client: Option<ClientIdentity>,
    pub trace_id: u64,
    pub hub: Arc<Hub>,
}

impl AsyncCtx {
    /// Reconstructs a [`CallerContext`] preserving caller role, principal, client identity, and trace id.
    pub fn caller_ctx(&self) -> CallerContext {
        CallerContext {
            caller: self.caller,
            principal: self.principal.clone(),
            client: self.client.clone(),
            trace_id: self.trace_id,
        }
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }
}

type SyncHandler = Arc<dyn Fn(&Ctx, Value) -> Result<Value, ApiError> + Send + Sync>;
type AsyncHandler = Arc<dyn Fn(AsyncCtx, Value) -> BoxFuture<'static, Result<Value, ApiError>> + Send + Sync>;

#[derive(Clone)]
enum RouteHandler {
    Sync(SyncHandler),
    Async(AsyncHandler),
}

type TypedSyncHandler<I, R> = Arc<dyn Fn(&Ctx, I) -> Result<R, ApiError> + Send + Sync>;
type TypedAsyncHandler<I, R> = Arc<dyn Fn(AsyncCtx, I) -> BoxFuture<'static, Result<R, ApiError>> + Send + Sync>;

enum TypedEntry<I, R> {
    Sync(TypedSyncHandler<I, R>),
    Async(TypedAsyncHandler<I, R>),
}

impl<I, R> Clone for TypedEntry<I, R> {
    fn clone(&self) -> Self {
        match self {
            Self::Sync(h) => Self::Sync(h.clone()),
            Self::Async(h) => Self::Async(h.clone()),
        }
    }
}

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

type SyncOpener = Arc<dyn Fn(&Hub, Value, Sink) -> Result<(), ApiError> + Send + Sync>;
type AsyncOpener = Arc<dyn Fn(Arc<Hub>, Value, Sink) -> BoxFuture<'static, Result<(), ApiError>> + Send + Sync>;

#[derive(Clone)]
enum SubscriptionOpener {
    Sync(SyncOpener),
    Async(AsyncOpener),
}

struct Slot<T: ?Sized>(ArcSwapOption<Arc<T>>);

impl<T: ?Sized> Slot<T> {
    fn empty() -> Self {
        Self(ArcSwapOption::empty())
    }

    fn set(&self, val: Option<Arc<T>>) {
        self.0.store(val.map(Arc::new));
    }

    fn set_some(&self, val: Arc<T>) {
        self.0.store(Some(Arc::new(val)));
    }

    fn get(&self) -> Option<Arc<T>> {
        self.0.load().as_ref().map(|slot| (**slot).clone())
    }

    fn is_some(&self) -> bool {
        self.0.load().is_some()
    }
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
    self_weak: OnceLock<Weak<Hub>>,
    core: Mutex<Core>,
    slice_gate: slice_wake::SliceWakeGate,
    pub(crate) runtime_inbox: runtime_inbox::RuntimeInboxObserver,
    feeds: SliceFeeds,
    shutdown: CancellationToken,
    // Dropped before `bus` and `slice_notify` so child tokens cancel before subscriber shutdown.
    _shutdown_guard: DropGuard,
    bus: event_bus::EventBus,
    tasks: TaskTracker,
    handlers: RwLock<HashMap<&'static str, RouteHandler>>,
    typed_handlers: RwLock<HashMap<&'static str, Arc<dyn Any + Send + Sync>>>,
    openers: RwLock<HashMap<&'static str, (&'static [Caller], SubscriptionOpener)>>,
    live: broadcast::Sender<LiveEvent>,
    subscriptions: Mutex<HashMap<u64, flume::Sender<()>>>,
    next_id: AtomicU64,
    next_trace_id: AtomicU64,
    observer: Slot<dyn InvokeObserver>,
    fault_gate: Slot<dyn FaultGate>,
    host_debug: Slot<dyn HostDebugBridge>,
    voice: OnceLock<SharedLiveVoice>,
    media_inputs: Slot<dyn crate::transport::api::media::MediaInputs>,
    mcp: Slot<dyn crate::transport::api::Mcp>,
    remote_auth: Slot<dyn RemoteAuth>,
    machine_bus: Slot<dyn MachineBus>,
    speech: Slot<dyn crate::transport::api::media::SpeechStreams>,
    wake: watch::Sender<u64>,
    /// Farm effects accumulated between pump ticks.
    pending_effects: Mutex<Vec<GameEffect>>,
    /// Coalesced wakeup notifier for the slice feed pump task.
    slice_notify: Arc<Notify>,
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

    /// Spawns a tracked background task on the ambient Tokio runtime (falling
    /// back to `vibevalley-io` outside Tokio), preserving the current tracing span.
    pub fn spawn_task<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        self.tasks.spawn_on(future.in_current_span().with_current_subscriber(), &handle)
    }

    /// Spawns a tracked blocking task on the ambient Tokio runtime (falling
    /// back to `vibevalley-io` outside Tokio), preserving the current tracing span.
    pub fn spawn_blocking_task<F, R>(&self, func: F) -> tokio::task::JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        let handle = vibevalley_runtime::rt::current_or_global_handle();
        let dispatch = tracing::dispatcher::get_default(|d| d.clone());
        let span = tracing::Span::current();
        self.tasks
            .spawn_blocking_on(move || tracing::dispatcher::with_default(&dispatch, || span.in_scope(func)), &handle)
    }

    /// Asynchronously cancels the hub's shutdown token, stops the event bus,
    /// and awaits up to [`HUB_SHUTDOWN_GRACE`] for all tracked background tasks
    /// to finish without calling `rt::block_on`.
    pub async fn close_async(&self) {
        self.shutdown.cancel();
        self.bus.close_async().await;
        self.tasks.close();
        if tokio::time::timeout(HUB_SHUTDOWN_GRACE, self.tasks.wait()).await.is_err() {
            tracing::warn!(
                remaining = self.tasks.len(),
                timeout_secs = HUB_SHUTDOWN_GRACE.as_secs(),
                "hub.close timed out waiting for tracked background tasks"
            );
        }
    }

    /// Cancels the hub's shutdown token, stops the event bus, and waits up to
    /// [`HUB_SHUTDOWN_GRACE`] for all tracked background tasks to finish.
    pub fn close(&self) {
        vibevalley_runtime::rt::block_on(self.close_async());
    }

    /// Streamed speech (`content::media::jobs::Jobs`).
    pub fn attach_speech_streams(&self, streams: crate::transport::api::media::SharedSpeechStreams) {
        self.speech.set_some(streams);
    }

    /// The helpers' MCP door (`team::mcp::Door`).
    pub fn attach_mcp(&self, door: crate::transport::api::SharedMcp) {
        self.mcp.set_some(door);
    }

    pub fn attach_media_inputs(&self, inputs: crate::transport::api::media::SharedMediaInputs) {
        self.media_inputs.set_some(inputs);
    }

    /// Attaches or clears the zero-overhead RPC / `Core::apply` observer.
    pub fn attach_observer(&self, observer: Option<SharedInvokeObserver>) {
        self.observer.set(observer);
    }

    /// Attaches or clears the fault-injection gate for DevTools Lab & Overrides.
    pub fn attach_fault_gate(&self, gate: Option<SharedFaultGate>) {
        self.fault_gate.set(gate);
    }

    /// Attaches or clears the desktop host shell debug bridge.
    pub fn attach_host_debug(&self, bridge: Option<SharedHostDebug>) {
        self.host_debug.set(bridge);
    }

    /// Attaches the started voice controller port so desktop callers read it from [`Server::voice`].
    pub fn attach_voice(&self, voice: SharedLiveVoice) {
        let _ = self.voice.set(voice);
    }

    /// Attaches or clears the remote mobile device authenticator.
    pub fn attach_remote_auth(&self, auth: Option<SharedRemoteAuth>) {
        self.remote_auth.set(auth);
    }

    /// Attaches or clears the execution-layer machine WS bus.
    pub fn attach_machine_bus(&self, bus: Option<SharedMachineBus>) {
        self.machine_bus.set(bus);
    }

    /// Notifies subscribed subsystems (connectors, machine heartbeats, runtime probes)
    /// that the host system woke from sleep so they can re-probe / reconnect immediately.
    pub fn on_system_wake(&self) {
        let mut next = 0;
        self.wake.send_modify(|count| {
            *count = count.wrapping_add(1);
            next = *count;
        });
        tracing::info!(wake_seq = next, "hub.system_wake");
    }

    /// Subscribes to host system wake notifications (`watch::Receiver<u64>` carrying
    /// the monotonic wake sequence number).
    pub fn subscribe_wake(&self) -> watch::Receiver<u64> {
        self.wake.subscribe()
    }

    /// Current monotonic count of host system wake events observed by this hub.
    pub fn wake_count(&self) -> u64 {
        *self.wake.borrow()
    }

    /// A server holding `state`, with no endpoint answered yet. Its feed
    /// pump ends when [`Hub::close`] is called or the last `Arc<Hub>` is dropped.
    pub fn new(state: SpaceState) -> Arc<Hub> {
        let slice_notify = Arc::new(Notify::new());
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
        let _shutdown_guard = shutdown.clone().drop_guard();
        let bus = event_bus::EventBus::new(shutdown.child_token());
        let (wake, _) = watch::channel(0u64);
        let hub = Arc::new(Hub {
            self_weak: OnceLock::new(),
            core: Mutex::new(core),
            slice_gate: slice_wake::SliceWakeGate::new(seq),
            runtime_inbox: runtime_inbox::RuntimeInboxObserver::new(),
            feeds,
            shutdown,
            _shutdown_guard,
            bus,
            tasks: TaskTracker::new(),
            handlers: RwLock::default(),
            typed_handlers: RwLock::default(),
            openers: RwLock::default(),
            live,
            subscriptions: Mutex::default(),
            next_id: AtomicU64::new(1),
            next_trace_id: AtomicU64::new(1),
            observer: Slot::empty(),
            fault_gate: Slot::empty(),
            host_debug: Slot::empty(),
            voice: OnceLock::new(),
            media_inputs: Slot::empty(),
            mcp: Slot::empty(),
            remote_auth: Slot::empty(),
            machine_bus: Slot::empty(),
            speech: Slot::empty(),
            wake,
            pending_effects: Mutex::new(Vec::new()),
            slice_notify: slice_notify.clone(),
        });
        let _ = hub.self_weak.set(Arc::downgrade(&hub));
        hub.bus.attach_hub(Arc::downgrade(&hub));
        let weak = Arc::downgrade(&hub);
        let cancel = hub.child_token();
        hub.spawn_task(pump_slices(weak, slice_notify, cancel));
        hub
    }

    /// Returns an owned `Arc<Hub>` handle to this hub.
    pub fn self_arc(&self) -> Arc<Hub> {
        self.self_weak
            .get()
            .and_then(Weak::upgrade)
            .expect("Hub is always constructed inside Arc<Hub> via Hub::new")
    }

    fn current_observer(&self) -> Option<SharedInvokeObserver> {
        self.observer.get()
    }

    fn current_fault_gate(&self) -> Option<SharedFaultGate> {
        self.fault_gate.get()
    }

    /// Whether an RPC / `Core::apply` observer is currently attached.
    pub fn has_observer(&self) -> bool {
        self.observer.is_some()
    }

    /// Whether a fault-injection gate is currently attached.
    pub fn has_fault_gate(&self) -> bool {
        self.fault_gate.is_some()
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
        self.slice_gate.seq()
    }

    fn dirty_seq(&self, kind: SliceKind) -> i64 {
        self.slice_gate.dirty_seq(slice_index(kind))
    }

    fn take_pending_effects(&self) -> Vec<GameEffect> {
        std::mem::take(&mut *self.pending_effects.lock())
    }

    pub fn board_slice(&self) -> BoardSlice {
        let core = self.core.lock();
        vibevalley_core::board_slice(core.state(), self.dirty_seq(SliceKind::Board))
    }

    pub fn sessions_slice(&self) -> SessionsSlice {
        let core = self.core.lock();
        vibevalley_core::sessions_slice(core.state(), self.dirty_seq(SliceKind::Sessions))
    }

    pub fn inbox_slice(&self) -> InboxSlice {
        let core = self.core.lock();
        vibevalley_core::inbox_slice(core.state(), self.dirty_seq(SliceKind::Inbox))
    }

    pub fn farm_frame(&self) -> FarmFrame {
        let core = self.core.lock();
        vibevalley_core::farm_frame(core.state(), vec![], self.dirty_seq(SliceKind::Farm))
    }

    pub fn slice_bundle(&self) -> SliceBundle {
        let core = self.core.lock();
        let state = core.state();
        let seq = self.slice_gate.seq();
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

    fn sync_feed<T>(&self, kind: SliceKind, feed: &slice_feed::SliceFeed<T>, build: impl FnOnce(&SpaceState, i64) -> T)
    where
        T: slice_feed::Sequenced + serde::Serialize + Send + Sync + 'static,
    {
        let target = self.dirty_seq(kind);
        let locale = vibevalley_i18n::locale();
        let snap = feed.snapshot();
        if snap.seq >= target && snap.locale == locale {
            return;
        }
        let core = self.core.lock();
        let target = self.dirty_seq(kind);
        let snap = feed.snapshot();
        if snap.seq < target || snap.locale != locale {
            feed.replace_if_newer(build(core.state(), target));
        }
    }

    fn sync_slice(&self, kind: SliceKind) {
        match kind {
            SliceKind::Board => self.sync_feed(kind, &self.feeds.board, vibevalley_core::board_slice),
            SliceKind::Sessions => self.sync_feed(kind, &self.feeds.sessions, vibevalley_core::sessions_slice),
            SliceKind::Collab => self.sync_feed(kind, &self.feeds.collab, vibevalley_core::collab_slice),
            SliceKind::Inbox => self.sync_feed(kind, &self.feeds.inbox, vibevalley_core::inbox_slice),
            SliceKind::Ops => self.sync_feed(kind, &self.feeds.ops, vibevalley_core::ops_slice),
            SliceKind::Farm => self.sync_feed(kind, &self.feeds.farm, |state, seq| vibevalley_core::farm_frame(state, vec![], seq)),
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
        let (applied, seq, should_wake) = {
            let mut core = self.core.lock();
            let changes = core.apply(facts);
            if !changes.transitions.is_empty() {
                let mut dirty = changes.dirty;
                if !changes.effects.is_empty() {
                    dirty |= SliceMask::FARM;
                    self.pending_effects.lock().extend(changes.effects.iter().cloned());
                }
                let (seq, should_wake) = self.slice_gate.record_commit(dirty.bits());
                (changes, seq, should_wake)
            } else {
                let seq = self.slice_gate.seq();
                (changes, seq, false)
            }
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
        if should_wake {
            self.slice_notify.notify_one();
        }
        applied
    }

    /// Subscribes to folded transitions on a dedicated bounded async worker
    /// task (`EventBus`).
    pub fn subscribe_transitions(&self, name: &'static str, handler: impl Fn(&Arc<Hub>, &Transition) + Send + Sync + 'static) -> event_bus::Subscription {
        self.bus.subscribe(name, handler)
    }

    /// Cooperatively signals and awaits all registered event bus subscribers.
    pub fn close_bus(&self) {
        self.bus.close();
    }

    /// Asynchronously signals and awaits all registered event bus subscribers.
    pub async fn close_bus_async(&self) {
        self.bus.close_async().await;
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
        let typed: TypedSyncHandler<O::Input, O::Result> = Arc::new(handler);
        let json_typed = typed.clone();
        let h: SyncHandler = Arc::new(move |ctx, payload| {
            let input: O::Input = decode(payload)?;
            let out = json_typed(ctx, input)?;
            serde_json::to_value(out).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
        });
        self.typed_handlers.write().insert(O::NAME, Arc::new(TypedEntry::Sync(typed)));
        self.handlers.write().insert(O::NAME, RouteHandler::Sync(h));
    }

    /// Answers `O` asynchronously on the Tokio runtime, replacing any earlier handler.
    pub fn on_async<O, F, Fut>(&self, handler: F)
    where
        O: Op,
        O::Input: Send + 'static,
        O::Result: Send + 'static,
        F: Fn(AsyncCtx, O::Input) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O::Result, ApiError>> + Send + 'static,
    {
        let typed: TypedAsyncHandler<O::Input, O::Result> = Arc::new(move |ctx, input| Box::pin(handler(ctx, input)));
        let json_typed = typed.clone();
        let h: AsyncHandler = Arc::new(move |ctx, payload| {
            let json_typed = json_typed.clone();
            Box::pin(async move {
                let input: O::Input = decode(payload)?;
                let out = json_typed(ctx, input).await?;
                serde_json::to_value(out).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
            })
        });
        self.typed_handlers.write().insert(O::NAME, Arc::new(TypedEntry::Async(typed)));
        self.handlers.write().insert(O::NAME, RouteHandler::Async(h));
    }

    fn ensure_trace_id<'a>(&self, caller_ctx: &'a CallerContext) -> Cow<'a, CallerContext> {
        if caller_ctx.trace_id != 0 {
            Cow::Borrowed(caller_ctx)
        } else {
            Cow::Owned(CallerContext {
                caller: caller_ctx.caller,
                principal: caller_ctx.principal.clone(),
                client: caller_ctx.client.clone(),
                trace_id: self.next_trace_id.fetch_add(1, Ordering::Relaxed),
            })
        }
    }

    fn ensure_trace_id_owned(&self, mut caller_ctx: CallerContext) -> CallerContext {
        if caller_ctx.trace_id == 0 {
            caller_ctx.trace_id = self.next_trace_id.fetch_add(1, Ordering::Relaxed);
        }
        caller_ctx
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
        let effective_ctx = self.ensure_trace_id(caller_ctx);
        let started = if let Some(obs) = &observer {
            let payload = serde_json::to_value(&input).unwrap_or(Value::Null);
            obs.on_call_start(&effective_ctx, op, &payload);
            Some(Instant::now())
        } else {
            trace_debug.then(Instant::now)
        };

        if !is_debug_op && let Some(gate) = self.current_fault_gate() {
            let delay = gate.delay_ms(op);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }

        let span = tracing::debug_span!("hub.op", op, trace_id = effective_ctx.trace_id);
        let result = {
            let _entered = span.enter();
            self.dispatch_typed::<O>(&effective_ctx, input)
        };
        let biz_code = match &result {
            Ok(_) => 0,
            Err(err) => err.biz_code.code(),
        };
        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_call_end(&effective_ctx, op, biz_code, us);
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

    /// Asynchronously invokes endpoint `O` directly in-process with zero JSON round-trip while
    /// enforcing `endpoint(O::NAME).can`, [`InvokeObserver`], and non-blocking [`FaultGate`].
    pub async fn invoke_async<O: Op>(&self, caller_ctx: &CallerContext, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Input: Send + 'static,
        O::Result: Send + 'static,
    {
        let op = O::NAME;
        let is_debug_op = op.starts_with("debug.");
        let observer = if is_debug_op { None } else { self.current_observer() };
        let trace_debug = tracing::enabled!(tracing::Level::DEBUG);
        let effective_ctx = self.ensure_trace_id(caller_ctx);
        let started = if let Some(obs) = &observer {
            let payload = serde_json::to_value(&input).unwrap_or(Value::Null);
            obs.on_call_start(&effective_ctx, op, &payload);
            Some(Instant::now())
        } else {
            trace_debug.then(Instant::now)
        };

        let span = tracing::debug_span!("hub.op", op, trace_id = effective_ctx.trace_id);
        let result = async {
            let delay = if !is_debug_op {
                self.current_fault_gate().map(|gate| gate.delay_ms(op)).unwrap_or(0)
            } else {
                0
            };
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            self.dispatch_typed_async::<O>(&effective_ctx, input).await
        }
        .instrument(span)
        .await;

        let biz_code = match &result {
            Ok(_) => 0,
            Err(err) => err.biz_code.code(),
        };
        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_call_end(&effective_ctx, op, biz_code, us);
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

    /// Convenience async typed invocation as `caller`.
    pub async fn invoke_as_async<O: Op>(&self, caller: Caller, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Input: Send + 'static,
        O::Result: Send + 'static,
    {
        self.invoke_async::<O>(&CallerContext::from_caller(caller), input).await
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
            .and_then(|any| any.downcast_ref::<TypedEntry<O::Input, O::Result>>().cloned());
        let Some(handler) = handler else {
            return Err(ApiError::new(BizCode::ServiceUnavailable, format!("{op} is not served by VibeValley yet")));
        };
        match handler {
            TypedEntry::Sync(handler) => {
                let ctx = Ctx {
                    caller: caller_ctx.caller,
                    principal: caller_ctx.principal.clone(),
                    client: caller_ctx.client.clone(),
                    trace_id: caller_ctx.trace_id,
                    hub: self,
                };
                handler(&ctx, input)
            }
            TypedEntry::Async(handler) => {
                let ctx = AsyncCtx {
                    caller: caller_ctx.caller,
                    principal: caller_ctx.principal.clone(),
                    client: caller_ctx.client.clone(),
                    trace_id: caller_ctx.trace_id,
                    hub: self.self_arc(),
                };
                vibevalley_runtime::rt::block_on(handler(ctx, input).in_current_span())
            }
        }
    }

    async fn dispatch_typed_async<O: Op>(&self, caller_ctx: &CallerContext, input: O::Input) -> Result<O::Result, ApiError>
    where
        O::Input: Send + 'static,
        O::Result: Send + 'static,
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
            .and_then(|any| any.downcast_ref::<TypedEntry<O::Input, O::Result>>().cloned());
        let Some(handler) = handler else {
            return Err(ApiError::new(BizCode::ServiceUnavailable, format!("{op} is not served by VibeValley yet")));
        };
        match handler {
            TypedEntry::Async(handler) => {
                let ctx = AsyncCtx {
                    caller: caller_ctx.caller,
                    principal: caller_ctx.principal.clone(),
                    client: caller_ctx.client.clone(),
                    trace_id: caller_ctx.trace_id,
                    hub: self.self_arc(),
                };
                handler(ctx, input).await
            }
            TypedEntry::Sync(handler) => {
                let hub = self.self_arc();
                let ctx_owned = caller_ctx.clone();
                spawn_blocking_traced(move || {
                    let ctx = Ctx {
                        caller: ctx_owned.caller,
                        principal: ctx_owned.principal,
                        client: ctx_owned.client,
                        trace_id: ctx_owned.trace_id,
                        hub: &hub,
                    };
                    handler(&ctx, input)
                })
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
            }
        }
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
        let effective_ctx = self.ensure_trace_id(caller_ctx);
        let started = if let Some(obs) = &observer {
            obs.on_call_start(&effective_ctx, op, &payload);
            Some(Instant::now())
        } else {
            trace_debug.then(Instant::now)
        };

        if !is_debug_op && let Some(gate) = self.current_fault_gate() {
            let delay = gate.delay_ms(op);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }

        let span = tracing::debug_span!("hub.op", op, trace_id = effective_ctx.trace_id);
        let envelope = {
            let _entered = span.enter();
            self.dispatch_call(&effective_ctx, op, payload)
        };
        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_call_end(&effective_ctx, op, envelope.biz_code, us);
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
        let outcome = match handler {
            RouteHandler::Sync(handler) => {
                let ctx = Ctx {
                    caller: caller_ctx.caller,
                    principal: caller_ctx.principal.clone(),
                    client: caller_ctx.client.clone(),
                    trace_id: caller_ctx.trace_id,
                    hub: self,
                };
                handler(&ctx, payload)
            }
            RouteHandler::Async(handler) => {
                let ctx = AsyncCtx {
                    caller: caller_ctx.caller,
                    principal: caller_ctx.principal.clone(),
                    client: caller_ctx.client.clone(),
                    trace_id: caller_ctx.trace_id,
                    hub: self.self_arc(),
                };
                vibevalley_runtime::rt::block_on(handler(ctx, payload).in_current_span())
            }
        };
        match outcome {
            Ok(data) if e.result.is_none() => {
                let _ = data;
                Envelope::void()
            }
            Ok(data) => Envelope::ok(data),
            Err(err) => Envelope::failure(&err),
        }
    }

    /// Asynchronously invokes one endpoint with caller identity, principal, and optional trace id.
    pub async fn call_with_async(&self, caller_ctx: CallerContext, op: String, payload: Value) -> Envelope {
        let is_debug_op = op.starts_with("debug.");
        let observer = if is_debug_op { None } else { self.current_observer() };
        let trace_debug = tracing::enabled!(tracing::Level::DEBUG);
        let effective_ctx = self.ensure_trace_id_owned(caller_ctx);
        let started = if let Some(obs) = &observer {
            obs.on_call_start(&effective_ctx, &op, &payload);
            Some(Instant::now())
        } else {
            trace_debug.then(Instant::now)
        };

        let span = tracing::debug_span!("hub.op", op = op.as_str(), trace_id = effective_ctx.trace_id);
        let envelope = async {
            let delay = if !is_debug_op {
                self.current_fault_gate().map(|gate| gate.delay_ms(&op)).unwrap_or(0)
            } else {
                0
            };
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            self.dispatch_call_async(&effective_ctx, &op, payload).await
        }
        .instrument(span)
        .await;

        let duration_us = started.map(|t0| t0.elapsed().as_micros() as u64);
        if let (Some(obs), Some(us)) = (observer, duration_us) {
            obs.on_call_end(&effective_ctx, &op, envelope.biz_code, us);
        }
        if trace_debug {
            tracing::debug!(
                op = %op,
                biz_code = envelope.biz_code,
                trace_id = effective_ctx.trace_id,
                duration_us = duration_us.unwrap_or(0),
                "hub.call"
            );
        }
        envelope
    }

    async fn dispatch_call_async(&self, caller_ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
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
        let outcome = match handler {
            RouteHandler::Async(handler) => {
                let ctx = AsyncCtx {
                    caller: caller_ctx.caller,
                    principal: caller_ctx.principal.clone(),
                    client: caller_ctx.client.clone(),
                    trace_id: caller_ctx.trace_id,
                    hub: self.self_arc(),
                };
                handler(ctx, payload).await
            }
            RouteHandler::Sync(handler) => {
                let hub = self.self_arc();
                let ctx_owned = caller_ctx.clone();
                match spawn_blocking_traced(move || {
                    let ctx = Ctx {
                        caller: ctx_owned.caller,
                        principal: ctx_owned.principal,
                        client: ctx_owned.client,
                        trace_id: ctx_owned.trace_id,
                        hub: &hub,
                    };
                    handler(&ctx, payload)
                })
                .await
                {
                    Ok(res) => res,
                    Err(e) => Err(ApiError::new(BizCode::InternalError, e.to_string())),
                }
            }
        };
        match outcome {
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
        let o: SyncOpener = Arc::new(move |hub, payload, sink| open(hub, decode(payload)?, sink));
        self.openers.write().insert(S::NAME, (S::CAN, SubscriptionOpener::Sync(o)));
    }

    /// Serves subscription `S` asynchronously on the Tokio runtime without
    /// blocking an OS thread during catch-up queries or validation.
    pub fn on_subscription_async<S, F, Fut>(&self, open: F)
    where
        S: Subscription,
        S::Payload: Send + 'static,
        F: Fn(Arc<Hub>, S::Payload, Sink) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), ApiError>> + Send + 'static,
    {
        let open = Arc::new(open);
        let o: AsyncOpener = Arc::new(move |hub, payload, sink| {
            let open = open.clone();
            Box::pin(async move {
                let decoded = decode(payload)?;
                open(hub, decoded, sink).await
            })
        });
        self.openers.write().insert(S::NAME, (S::CAN, SubscriptionOpener::Async(o)));
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
        match open {
            SubscriptionOpener::Sync(open) => open(self, payload, Sink { events, stop }),
            SubscriptionOpener::Async(open) => vibevalley_runtime::rt::block_on(open(self.self_arc(), payload, Sink { events, stop }).in_current_span()),
        }
        .map_err(|e| Envelope::failure(&e))?;
        self.subscriptions.lock().insert(id, stop_tx);
        Ok((id, rx))
    }

    /// Opens subscription `name` asynchronously, executing `on_subscription_async`
    /// openers inline on the caller Tokio task without `spawn_blocking`.
    #[allow(clippy::result_large_err, reason = "the contract's refusal is an envelope")]
    pub async fn subscribe_with_async(&self, caller_ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
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
        match open {
            SubscriptionOpener::Async(open) => open(self.self_arc(), payload, Sink { events, stop }).await.map_err(|e| Envelope::failure(&e))?,
            SubscriptionOpener::Sync(open) => {
                let hub = self.self_arc();
                match spawn_blocking_traced(move || open(&hub, payload, Sink { events, stop })).await {
                    Ok(res) => res.map_err(|e| Envelope::failure(&e))?,
                    Err(e) => return Err(refusal(BizCode::InternalError, e.to_string())),
                }
            }
        }
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
async fn pump_slices(hub: std::sync::Weak<Hub>, notify: Arc<Notify>, cancel: CancellationToken) {
    loop {
        let first_bits = {
            let Some(h) = hub.upgrade() else { return };
            h.slice_gate.take_pending()
        };
        if first_bits == 0 {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                _ = notify.notified() => continue,
            }
        }
        let mut dirty_bits = first_bits;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(STATE_EVERY_MS);
        let Some(leading) = hub.upgrade() else { return };
        for kind in WORKBENCH_SLICES {
            if (dirty_bits & SliceMask::from_kind(kind).bits()) != 0 {
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
        let Some(hub) = hub.upgrade() else { return };
        dirty_bits |= hub.slice_gate.take_pending();
        for kind in WORKBENCH_SLICES {
            if (dirty_bits & SliceMask::from_kind(kind).bits()) != 0 && hub.slice_has_watchers(kind) {
                hub.sync_slice(kind);
                hub.publish_slice(kind, false);
            }
        }
        if (dirty_bits & SliceMask::FARM.bits()) != 0 {
            let effects = hub.take_pending_effects();
            if hub.slice_has_watchers(SliceKind::Farm) {
                hub.sync_farm_with_effects(effects);
                hub.publish_slice(SliceKind::Farm, false);
            }
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
        self.speech.get()
    }

    fn mcp(&self) -> Option<crate::transport::api::SharedMcp> {
        self.mcp.get()
    }

    fn media_inputs(&self) -> Option<crate::transport::api::media::SharedMediaInputs> {
        self.media_inputs.get()
    }

    fn host_debug(&self) -> Option<SharedHostDebug> {
        self.host_debug.get()
    }

    fn voice(&self) -> Option<SharedLiveVoice> {
        self.voice.get().cloned()
    }

    fn remote_auth(&self) -> Option<SharedRemoteAuth> {
        self.remote_auth.get()
    }

    fn machine_bus(&self) -> Option<SharedMachineBus> {
        self.machine_bus.get()
    }

    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.call_with(&CallerContext::local(), op, payload)
    }

    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        Hub::call_with(self, ctx, op, payload)
    }

    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        Box::pin(async move { Hub::call_with_async(&self, ctx, op, payload).await })
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

    fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> {
        Box::pin(async move { self.slice_snapshot_json(slice) })
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

    fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<slice_feed::SliceSubscription>> {
        Box::pin(async move { Some(self.subscribe_slice_feed(slice)) })
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

    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, flume::Receiver<Value>), Envelope>> {
        Box::pin(async move { Hub::subscribe_with_async(&self, &ctx, &name, payload).await })
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

        let (async_entered_tx, async_entered_rx) = flume::bounded::<()>(1);
        let async_release = Arc::new(tokio::sync::Notify::new());
        let async_release_task = async_release.clone();
        let cancel = hub.child_token();
        let flag = async_done.clone();
        hub.spawn_task(async move {
            let _ = async_entered_tx.send(());
            cancel.cancelled().await;
            async_release_task.notified().await;
            flag.store(true, Ordering::Release);
        });

        let flag = blocking_done.clone();
        let (entered_tx, entered_rx) = flume::bounded::<()>(1);
        let (blocking_release_tx, blocking_release_rx) = flume::bounded::<()>(1);
        let cancel = hub.child_token();
        hub.spawn_blocking_task(move || {
            let _ = entered_tx.send(());
            let _ = blocking_release_rx.recv_timeout(Duration::from_secs(2));
            assert!(cancel.is_cancelled(), "blocking task must observe shutdown cancellation");
            flag.store(true, Ordering::Release);
        });

        async_entered_rx.recv_timeout(Duration::from_secs(2)).expect("async task entered");
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("blocking task entered");

        let (cancelled_tx, cancelled_rx) = flume::bounded::<()>(1);
        let cancel_watch = hub.child_token();
        vibevalley_runtime::rt::spawn(async move {
            cancel_watch.cancelled().await;
            let _ = cancelled_tx.send(());
        });

        let hub_close = hub.clone();
        let closer = std::thread::spawn(move || hub_close.close());
        cancelled_rx.recv_timeout(Duration::from_secs(2)).expect("Hub::close cancelled shutdown token");

        async_release.notify_one();
        drop(blocking_release_tx);
        closer.join().unwrap();

        assert!(async_done.load(Ordering::Acquire), "Hub::close must drain tracked async tasks");
        assert!(blocking_done.load(Ordering::Acquire), "Hub::close must drain tracked blocking tasks");
    }

    #[test]
    fn on_async_runs_directly_on_io_worker_without_spawn_blocking() {
        use parking_lot::Mutex;
        use serde_json::Value;
        use vibevalley_protocol::{Health, ops};

        use super::{CallerContext, Server};

        let hub = Hub::new(vibevalley_core::empty_space_state());
        let recorded = Arc::new(Mutex::new(Vec::<(String, Option<tokio::task::Id>)>::new()));
        let rec_async = recorded.clone();
        hub.on_async::<ops::ServerHealthGet, _, _>(move |ctx, ()| {
            let rec = rec_async.clone();
            async move {
                let name = std::thread::current().name().unwrap_or_default().to_string();
                let task_id = tokio::task::try_id();
                rec.lock().push((name, task_id));
                let _ = ctx.hub().seq();
                Ok(Health {
                    ok: true,
                    version: format!("async-{}", ctx.caller_ctx().trace_id),
                })
            }
        });

        let (caller_task_id, call_env, invoke_res) = vibevalley_runtime::rt::block_on(async move {
            vibevalley_runtime::rt::spawn(async move {
                let caller_task_id = tokio::task::try_id();
                let server: Arc<dyn Server> = hub.clone();
                let call_env = server.call_with_async(CallerContext::local(), "server.health.get".into(), Value::Null).await;
                let invoke_res = hub.invoke_async::<ops::ServerHealthGet>(&CallerContext::local(), ()).await.unwrap();
                hub.close();
                (caller_task_id, call_env, invoke_res)
            })
            .await
            .unwrap()
        });

        assert_eq!(call_env.biz_code, 0);
        assert_eq!(call_env.data.unwrap()["version"], "async-1");
        assert!(invoke_res.ok);
        assert_eq!(invoke_res.version, "async-2");

        let entries = recorded.lock();
        assert_eq!(entries.len(), 2);
        for (thread_name, task_id) in entries.iter() {
            assert!(
                thread_name.starts_with("vibevalley-io-"),
                "expected vibevalley-io worker thread, got {thread_name}"
            );
            assert_eq!(
                *task_id, caller_task_id,
                "on_async handler must run inline on caller Tokio task without spawn_blocking"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unconditional_trace_id_and_hub_op_span_propagate_across_awaits() {
        use std::io;

        use parking_lot::Mutex;
        use serde_json::Value;
        use tracing::instrument::WithSubscriber as _;
        use vibevalley_protocol::{Caller, Health, ops};

        use super::{CallerContext, CallerPrincipal};

        #[derive(Clone, Default)]
        struct SharedBuf(Arc<Mutex<Vec<u8>>>);

        struct BufWriter(Arc<Mutex<Vec<u8>>>);

        impl io::Write for BufWriter {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().extend_from_slice(buf);
                Ok(buf.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedBuf {
            type Writer = BufWriter;

            fn make_writer(&'a self) -> Self::Writer {
                BufWriter(self.0.clone())
            }
        }

        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_ansi(false)
            .with_writer(buf.clone())
            .finish();

        async {
            let hub = Hub::new(vibevalley_core::empty_space_state());
            assert!(!hub.has_observer(), "test must run without InvokeObserver attached");

            let observed = Arc::new(Mutex::new(Vec::<(u64, Option<&'static str>, Option<&'static str>, bool)>::new()));
            let observed_async = observed.clone();
            hub.on_async::<ops::ServerHealthGet, _, _>(move |ctx, ()| {
                let observed = observed_async.clone();
                async move {
                    let before = tracing::Span::current();
                    let before_name = before.metadata().map(|m| m.name());
                    let before_id = before.id();

                    tokio::task::yield_now().await;
                    tokio::time::sleep(Duration::from_millis(500)).await;

                    let after = tracing::Span::current();
                    let after_name = after.metadata().map(|m| m.name());
                    let after_id = after.id();
                    tracing::debug!(handler_trace_id = ctx.trace_id, "inside_async_handler");

                    observed
                        .lock()
                        .push((ctx.trace_id, before_name, after_name, before_id.is_some() && before_id == after_id));
                    Ok(Health {
                        ok: true,
                        version: format!("trace-{}", ctx.trace_id),
                    })
                }
            });

            let sync_trace_ids = Arc::new(Mutex::new(Vec::<(u64, Option<&'static str>)>::new()));
            let sync_trace_ids_h = sync_trace_ids.clone();
            hub.on::<ops::OrchestratorOpen>(move |ctx, ()| {
                let span_name = tracing::Span::current().metadata().map(|m| m.name());
                sync_trace_ids_h.lock().push((ctx.trace_id, span_name));
                Ok(())
            });

            // (a) Unconditional non-zero trace_id minted with NO observer attached.
            let minted_invoke = hub.invoke_async::<ops::ServerHealthGet>(&CallerContext::local(), ()).await.unwrap();
            assert_eq!(minted_invoke.version, "trace-1");

            let minted_call = hub.call_with_async(CallerContext::local(), "server.health.get".into(), Value::Null).await;
            assert_eq!(minted_call.biz_code, 0);
            assert_eq!(minted_call.data.unwrap()["version"], "trace-2");

            // (b) Caller-supplied non-zero trace_id (42) is preserved verbatim.
            let custom_ctx = CallerContext {
                caller: Caller::User,
                principal: CallerPrincipal::LocalOwner,
                client: None,
                trace_id: 42,
            };
            let custom_invoke = hub.invoke_async::<ops::ServerHealthGet>(&custom_ctx, ()).await.unwrap();
            assert_eq!(custom_invoke.version, "trace-42");

            let custom_call = hub.call_with_async(custom_ctx.clone(), "server.health.get".into(), Value::Null).await;
            assert_eq!(custom_call.biz_code, 0);
            assert_eq!(custom_call.data.unwrap()["version"], "trace-42");

            // Sync paths also mint non-zero trace_id and preserve custom trace_id inside `hub.op`.
            hub.invoke::<ops::OrchestratorOpen>(&CallerContext::local(), ()).unwrap();
            hub.invoke::<ops::OrchestratorOpen>(&custom_ctx, ()).unwrap();
            assert_eq!(hub.call_with(&CallerContext::local(), "orchestrator.open", Value::Null).biz_code, 0);
            assert_eq!(hub.call_with(&custom_ctx, "orchestrator.open", Value::Null).biz_code, 0);

            // (c) `tracing::Span::current()` stayed in `hub.op` across `.await` yields on all async calls.
            let rows = observed.lock().clone();
            assert_eq!(rows.len(), 4);
            assert_eq!(rows[0], (1, Some("hub.op"), Some("hub.op"), true));
            assert_eq!(rows[1], (2, Some("hub.op"), Some("hub.op"), true));
            assert_eq!(rows[2], (42, Some("hub.op"), Some("hub.op"), true));
            assert_eq!(rows[3], (42, Some("hub.op"), Some("hub.op"), true));

            let sync_rows = sync_trace_ids.lock().clone();
            assert_eq!(
                sync_rows,
                vec![(3, Some("hub.op")), (42, Some("hub.op")), (4, Some("hub.op")), (42, Some("hub.op")),]
            );

            let logs = String::from_utf8(buf.0.lock().clone()).unwrap();
            assert!(
                logs.contains("hub.op{op=\"server.health.get\" trace_id=1}"),
                "missing minted span in logs:\n{logs}"
            );
            assert!(
                logs.contains("hub.op{op=\"server.health.get\" trace_id=42}"),
                "missing custom span in logs:\n{logs}"
            );

            hub.close_async().await;
        }
        .with_subscriber(subscriber)
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn async_fault_gate_delay_uses_virtual_clock_deterministically() {
        use serde_json::Value;
        use vibevalley_protocol::{Caller, Health, ops};

        use super::{CallerContext, FaultGate};

        struct DelayFaultGate {
            target: &'static str,
            delay_ms: u64,
        }

        impl FaultGate for DelayFaultGate {
            fn delay_ms(&self, target: &str) -> u64 {
                if target == self.target { self.delay_ms } else { 0 }
            }

            fn should_disconnect(&self, _topic: &str) -> bool {
                false
            }
        }

        let hub = Hub::new(vibevalley_core::empty_space_state());
        hub.attach_fault_gate(Some(Arc::new(DelayFaultGate {
            target: "server.health.get",
            delay_ms: 5_000,
        })));
        hub.on_async::<ops::ServerHealthGet, _, _>(move |ctx, ()| async move {
            Ok(Health {
                ok: true,
                version: format!("v-{}", ctx.trace_id),
            })
        });

        let wall_start = std::time::Instant::now();

        // `call_with_async`: stays pending at 4999ms and completes at exactly 5000ms virtual time.
        let t0 = tokio::time::Instant::now();
        let delayed_call = tokio::spawn({
            let hub = hub.clone();
            async move { hub.call_with_async(CallerContext::local(), "server.health.get".into(), Value::Null).await }
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(4_999)).await;
        tokio::task::yield_now().await;
        assert!(!delayed_call.is_finished(), "call_with_async FaultGate must hold until full delay elapses");
        tokio::time::advance(Duration::from_millis(1)).await;
        let env = delayed_call.await.unwrap();
        assert_eq!(env.biz_code, 0);
        assert_eq!(env.data.unwrap()["version"], "v-1");
        assert_eq!(t0.elapsed(), Duration::from_millis(5_000));

        // `invoke_as_async`: stays pending at 4999ms and completes at exactly 5000ms virtual time.
        let t1 = tokio::time::Instant::now();
        let delayed_invoke = tokio::spawn({
            let hub = hub.clone();
            async move { hub.invoke_as_async::<ops::ServerHealthGet>(Caller::Remote, ()).await }
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(4_999)).await;
        tokio::task::yield_now().await;
        assert!(!delayed_invoke.is_finished(), "invoke_async FaultGate must hold until full delay elapses");
        tokio::time::advance(Duration::from_millis(1)).await;
        let health = delayed_invoke.await.unwrap().unwrap();
        assert_eq!(health.version, "v-2");
        assert_eq!(t1.elapsed(), Duration::from_millis(5_000));

        assert!(
            wall_start.elapsed() < Duration::from_secs(1),
            "10s of virtual FaultGate delays must finish instantaneously, took {:?}",
            wall_start.elapsed()
        );

        hub.close_async().await;
    }

    #[test]
    fn dual_track_four_way_cross_dispatch_enforces_can_and_observer() {
        use std::sync::atomic::AtomicUsize;

        use parking_lot::Mutex;
        use serde_json::Value;
        use vibevalley_protocol::{BizCode, Caller, Health, ops};

        use super::{CallerContext, InvokeObserver};

        #[derive(Default)]
        struct RecordingObserver {
            starts: Mutex<Vec<(String, u64)>>,
            ends: Mutex<Vec<(String, u32, u64)>>,
        }

        impl InvokeObserver for RecordingObserver {
            fn on_call_start(&self, ctx: &CallerContext, op: &str, _payload: &Value) {
                self.starts.lock().push((op.to_string(), ctx.trace_id));
            }

            fn on_call_end(&self, ctx: &CallerContext, op: &str, biz_code: u32, _duration_us: u64) {
                self.ends.lock().push((op.to_string(), biz_code, ctx.trace_id));
            }

            fn on_apply(&self, _seq: i64, _dirty: vibevalley_core::SliceMask, _transitions: &[vibevalley_core::Transition], _duration_us: u64) {}
        }

        let hub = Hub::new(vibevalley_core::empty_space_state());
        let observer = Arc::new(RecordingObserver::default());
        hub.attach_observer(Some(observer.clone()));

        let sync_hits = Arc::new(AtomicUsize::new(0));
        let sync_hits_h = sync_hits.clone();
        let sync_task_ids = Arc::new(Mutex::new(Vec::<Option<tokio::task::Id>>::new()));
        let sync_task_ids_h = sync_task_ids.clone();
        hub.on::<ops::OrchestratorOpen>(move |_ctx, ()| {
            sync_hits_h.fetch_add(1, Ordering::SeqCst);
            sync_task_ids_h.lock().push(tokio::task::try_id());
            Ok(())
        });

        let async_hits = Arc::new(AtomicUsize::new(0));
        let async_hits_h = async_hits.clone();
        hub.on_async::<ops::ServerHealthGet, _, _>(move |_ctx, ()| {
            let hits = async_hits_h.clone();
            async move {
                tokio::task::yield_now().await;
                let n = hits.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(Health {
                    ok: true,
                    version: format!("v{n}"),
                })
            }
        });

        // 1. sync -> sync (`call_with` & `invoke`)
        assert_eq!(hub.call_with(&CallerContext::local(), "orchestrator.open", Value::Null).biz_code, 0);
        hub.invoke::<ops::OrchestratorOpen>(&CallerContext::local(), ()).unwrap();

        // 2. sync -> async (`call_with` & `invoke`)
        let sync_to_async_env = hub.call_with(&CallerContext::local(), "server.health.get", Value::Null);
        assert_eq!(sync_to_async_env.biz_code, 0);
        assert_eq!(sync_to_async_env.data.unwrap()["version"], "v1");
        let sync_to_async_typed = hub.invoke::<ops::ServerHealthGet>(&CallerContext::local(), ()).unwrap();
        assert_eq!(sync_to_async_typed.version, "v2");

        // 3 & 4. async -> async + async -> sync + `can` RBAC enforcement.
        let hub_async = hub.clone();
        let caller_task_id = vibevalley_runtime::rt::block_on(async move {
            vibevalley_runtime::rt::spawn(async move {
                let caller_task_id = tokio::task::try_id();

                let async_env = hub_async.call_with_async(CallerContext::local(), "server.health.get".into(), Value::Null).await;
                assert_eq!(async_env.biz_code, 0);
                assert_eq!(async_env.data.unwrap()["version"], "v3");

                let async_typed = hub_async.invoke_as_async::<ops::ServerHealthGet>(Caller::Remote, ()).await.unwrap();
                assert_eq!(async_typed.version, "v4");

                // async -> sync (offloaded to spawn_blocking, never runs on caller Tokio task)
                let async_to_sync_env = hub_async.call_with_async(CallerContext::local(), "orchestrator.open".into(), Value::Null).await;
                assert_eq!(async_to_sync_env.biz_code, 0);
                hub_async.invoke_as_async::<ops::OrchestratorOpen>(Caller::Remote, ()).await.unwrap();

                // RBAC `can` check: `Caller::Session` is forbidden on `server.health.get`
                let forbidden_call = hub_async
                    .call_with_async(CallerContext::from_caller(Caller::Session), "server.health.get".into(), Value::Null)
                    .await;
                assert_eq!(forbidden_call.biz_code, BizCode::Forbidden.code());
                let forbidden_invoke = hub_async.invoke_as_async::<ops::ServerHealthGet>(Caller::Session, ()).await.unwrap_err();
                assert_eq!(forbidden_invoke.biz_code, BizCode::Forbidden);

                caller_task_id
            })
            .await
            .unwrap()
        });

        assert_eq!(sync_hits.load(Ordering::SeqCst), 4);
        assert_eq!(async_hits.load(Ordering::SeqCst), 4);

        // Last two sync handler calls came from async callers -> ran via spawn_blocking (distinct from caller task).
        let ids = sync_task_ids.lock();
        assert_eq!(ids.len(), 4);
        assert!(caller_task_id.is_some());
        assert_ne!(ids[2], caller_task_id);
        assert_ne!(ids[3], caller_task_id);

        // Observer saw all 10 calls (8 succeeded + 2 forbidden) with assigned non-zero trace IDs.
        let starts = observer.starts.lock();
        let ends = observer.ends.lock();
        assert_eq!(starts.len(), 10);
        assert_eq!(ends.len(), 10);
        assert!(starts.iter().all(|(_, trace_id)| *trace_id > 0));
        assert_eq!(ends.iter().filter(|(_, code, _)| *code == BizCode::Forbidden.code()).count(), 2);

        hub.close();
    }

    #[tokio::test(start_paused = true)]
    async fn hub_spawn_task_and_blocking_preserve_span_and_drain_via_close_async() {
        use std::io;

        use parking_lot::Mutex;
        use tracing::instrument::WithSubscriber as _;
        use vibevalley_protocol::{Health, ops};

        use super::CallerContext;

        #[derive(Clone, Default)]
        struct SharedBuf(Arc<Mutex<Vec<u8>>>);

        struct BufWriter(Arc<Mutex<Vec<u8>>>);

        impl io::Write for BufWriter {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().extend_from_slice(buf);
                Ok(buf.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedBuf {
            type Writer = BufWriter;

            fn make_writer(&'a self) -> Self::Writer {
                BufWriter(self.0.clone())
            }
        }

        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_ansi(false)
            .with_writer(buf.clone())
            .finish();

        async {
            let wall_start = std::time::Instant::now();
            let hub = Hub::new(vibevalley_core::empty_space_state());
            let drained = Arc::new(AtomicBool::new(false));
            let drained_bg = drained.clone();
            let bg_cancel = hub.child_token();
            hub.spawn_task(async move {
                bg_cancel.cancelled().await;
                drained_bg.store(true, Ordering::Release);
            });

            let seen_async = Arc::new(Mutex::new(None::<(Option<&'static str>, Option<tracing::span::Id>)>));
            let seen_blocking = Arc::new(Mutex::new(None::<(Option<&'static str>, Option<tracing::span::Id>)>));
            let parent_span_id = Arc::new(Mutex::new(None::<tracing::span::Id>));
            let async_done = Arc::new(tokio::sync::Notify::new());
            let blocking_done = Arc::new(tokio::sync::Notify::new());

            let seen_async_h = seen_async.clone();
            let seen_blocking_h = seen_blocking.clone();
            let parent_span_id_h = parent_span_id.clone();
            let async_done_h = async_done.clone();
            let blocking_done_h = blocking_done.clone();

            hub.on_async::<ops::ServerHealthGet, _, _>(move |ctx, ()| {
                let seen_async = seen_async_h.clone();
                let seen_blocking = seen_blocking_h.clone();
                let parent_span_id = parent_span_id_h.clone();
                let async_done = async_done_h.clone();
                let blocking_done = blocking_done_h.clone();
                async move {
                    *parent_span_id.lock() = tracing::Span::current().id();
                    ctx.hub.spawn_task(async move {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        let current = tracing::Span::current();
                        tracing::debug!("inside_hub_spawn_task");
                        *seen_async.lock() = Some((current.metadata().map(|m| m.name()), current.id()));
                        async_done.notify_one();
                    });
                    ctx.hub.spawn_blocking_task(move || {
                        let current = tracing::Span::current();
                        tracing::debug!("inside_hub_spawn_blocking_task");
                        *seen_blocking.lock() = Some((current.metadata().map(|m| m.name()), current.id()));
                        blocking_done.notify_one();
                    });
                    Ok(Health {
                        ok: true,
                        version: format!("ok-{}", ctx.trace_id),
                    })
                }
            });

            let health = hub.invoke_async::<ops::ServerHealthGet>(&CallerContext::local(), ()).await.unwrap();
            assert_eq!(health.version, "ok-1");

            blocking_done.notified().await;
            tokio::time::advance(Duration::from_secs(60)).await;
            async_done.notified().await;

            let expected_id = parent_span_id.lock().clone();
            assert!(expected_id.is_some());
            assert_eq!(*seen_async.lock(), Some((Some("hub.op"), expected_id.clone())));
            assert_eq!(*seen_blocking.lock(), Some((Some("hub.op"), expected_id)));

            hub.close_async().await;
            assert!(drained.load(Ordering::Acquire), "close_async must cancel and drain tracked tasks");

            let logs = String::from_utf8(buf.0.lock().clone()).unwrap();
            assert!(
                logs.contains("hub.op{op=\"server.health.get\" trace_id=1}") && logs.contains("inside_hub_spawn_task"),
                "missing spawn_task log in hub.op span:\n{logs}"
            );
            assert!(
                logs.contains("hub.op{op=\"server.health.get\" trace_id=1}") && logs.contains("inside_hub_spawn_blocking_task"),
                "missing spawn_blocking_task log in hub.op span:\n{logs}"
            );
            assert!(
                wall_start.elapsed() < Duration::from_secs(1),
                "virtual-clock Hub spawn & close_async must finish instantaneously, took {:?}",
                wall_start.elapsed()
            );
        }
        .with_subscriber(subscriber)
        .await;
    }

    #[test]
    fn on_subscription_async_runs_inline_without_spawn_blocking() {
        use parking_lot::Mutex;
        use serde_json::json;
        use vibevalley_protocol::subscriptions;

        use super::{CallerContext, Server};

        let hub = Hub::new(vibevalley_core::empty_space_state());
        let recorded = Arc::new(Mutex::new(None::<(String, Option<tokio::task::Id>)>));
        let rec = recorded.clone();
        hub.on_subscription_async::<subscriptions::ChannelFollow, _, _>(move |_hub, payload, sink| {
            let rec = rec.clone();
            async move {
                tokio::task::yield_now().await;
                let thread = std::thread::current().name().unwrap_or_default().to_string();
                *rec.lock() = Some((thread, tokio::task::try_id()));
                let _ = sink.send(&json!({ "channel": payload.id, "after": payload.after }));
                Ok(())
            }
        });

        let (caller_task_id, first) = vibevalley_runtime::rt::block_on(async move {
            vibevalley_runtime::rt::spawn(async move {
                let caller_task_id = tokio::task::try_id();
                let server: Arc<dyn Server> = hub.clone();
                let (id, rx) = server
                    .clone()
                    .subscribe_with_async(CallerContext::local(), "channel.follow".into(), json!({ "id": "c1", "after": 5 }))
                    .await
                    .unwrap();
                let first = rx.recv_async().await.unwrap();
                server.unsubscribe(id);
                hub.close_async().await;
                (caller_task_id, first)
            })
            .await
            .unwrap()
        });

        assert_eq!(first, json!({ "channel": "c1", "after": 5 }));
        let (thread_name, task_id) = recorded.lock().clone().expect("opener ran");
        assert!(
            thread_name.starts_with("vibevalley-io-"),
            "expected vibevalley-io worker thread, got {thread_name}"
        );
        assert_eq!(
            task_id, caller_task_id,
            "on_subscription_async opener must run inline on caller Tokio task without spawn_blocking"
        );
    }
}
