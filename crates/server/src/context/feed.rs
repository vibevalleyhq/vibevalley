//! Single-flight dirty slice coalescing (`StateFeed`) and pre-encoded
//! `tokio::sync::watch<Arc<str>>` slice feeds (`SliceFeed`) for `board`, `session`,
//! `collab`, `inbox`, `ops`, and `farm`, built on [`vibevalley_kit::net::gateway::feed::FeedHub`].

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use tokio_stream::Stream;
use vibevalley_core::SliceMask;
use vibevalley_kit::net::gateway::feed::{FeedChannel, FeedFrame, FeedHub, FeedKey, FeedSubscription};
use vibevalley_protocol::{
    ApiError, BizCode, BoardSlice, CollabSlice, FarmFrame, FarmLevel, FarmView, InboxSlice, OpsSlice, STATE_EVERY_MS, SessionsSlice, SliceKind,
};

use super::task::TaskGroup;

const SLICE_COUNT: usize = 6;
#[cfg(all(test, feature = "loom"))]
type SliceWakeGate = vibevalley_kit::sync::WakeGate<SLICE_COUNT>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SliceKey(SliceKind);

const ALL_SLICE_KEYS: [SliceKey; SLICE_COUNT] = [
    SliceKey(SliceKind::Board),
    SliceKey(SliceKind::Sessions),
    SliceKey(SliceKind::Collab),
    SliceKey(SliceKind::Inbox),
    SliceKey(SliceKind::Ops),
    SliceKey(SliceKind::Farm),
];

const fn slice_topic(kind: SliceKind) -> &'static str {
    match kind {
        SliceKind::Board => "slice:board",
        SliceKind::Sessions => "slice:sessions",
        SliceKind::Collab => "slice:collab",
        SliceKind::Inbox => "slice:inbox",
        SliceKind::Ops => "slice:ops",
        SliceKind::Farm => "slice:farm",
    }
}

impl FeedKey for SliceKey {
    const COUNT: usize = SLICE_COUNT;

    fn all() -> &'static [Self] {
        &ALL_SLICE_KEYS
    }

    fn index(self) -> usize {
        match self.0 {
            SliceKind::Board => 0,
            SliceKind::Sessions => 1,
            SliceKind::Collab => 2,
            SliceKind::Inbox => 3,
            SliceKind::Ops => 4,
            SliceKind::Farm => 5,
        }
    }

    fn topic(self) -> &'static str {
        slice_topic(self.0)
    }

    fn name(self) -> &'static str {
        self.0.as_str()
    }

    fn coalesce_leading(self) -> bool {
        // Farm coalesces transient `GameEffect` bursts across the `STATE_EVERY_MS` window
        // instead of draining the first effect on the leading edge.
        self.0 == SliceKind::Farm
    }

    fn allow_same_seq_publish(self) -> bool {
        self.0 == SliceKind::Farm
    }
}

/// Serializes a projected slice payload into pre-encoded `Arc<str>` JSON.
pub fn encode_slice<T: Serialize>(value: &T) -> Result<Arc<str>, ApiError> {
    serde_json::to_string(value)
        .map(Arc::<str>::from)
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

/// Pre-encoded slice snapshot published through [`SliceFeed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliceFrame {
    pub seq: i64,
    pub generation: u64,
    pub json: Arc<str>,
}

impl From<FeedFrame> for SliceFrame {
    fn from(frame: FeedFrame) -> Self {
        Self {
            seq: frame.seq,
            generation: frame.generation,
            json: frame.payload,
        }
    }
}

/// Pre-encoded `tokio::sync::watch<Arc<str>>` feed for a single state slice.
pub struct SliceFeed {
    channel: Arc<FeedChannel>,
    strip_initial_effects: bool,
}

impl SliceFeed {
    fn from_channel(channel: Arc<FeedChannel>, kind: SliceKind) -> Self {
        Self {
            channel,
            strip_initial_effects: kind == SliceKind::Farm,
        }
    }

    fn new(kind: SliceKind, initial_seq: i64, initial_json: impl Into<Arc<str>>) -> Self {
        Self::from_channel(Arc::new(FeedChannel::new(slice_topic(kind), initial_seq, initial_json)), kind)
    }

    /// Creates a [`SliceFeed`] serialized from an initial typed slice value.
    pub fn from_value<T: Serialize>(kind: SliceKind, initial_seq: i64, value: &T) -> Self {
        let json = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
        Self::new(kind, initial_seq, json)
    }

    pub fn seq(&self) -> i64 {
        self.channel.seq()
    }

    pub fn snapshot_json(&self) -> Arc<str> {
        self.channel.snapshot()
    }

    pub fn has_watchers(&self) -> bool {
        self.channel.has_watchers()
    }

    pub fn watcher_count(&self) -> usize {
        self.channel.watcher_count()
    }

    #[cfg(all(test, not(feature = "loom")))]
    fn publish_if_newer(&self, seq: i64, json: impl Into<Arc<str>>) -> bool {
        self.channel.publish_if_newer(seq, json)
    }

    /// Unconditionally publishes a new frame (e.g. burst `FarmEffect` or locale refresh),
    /// clamping `seq` to at least the previous sequence so `seq` never regresses.
    pub fn publish(&self, seq: i64, json: impl Into<Arc<str>>) {
        self.channel.publish(seq, json);
    }

    /// Serializes `value` and publishes it at `seq`.
    pub fn publish_value<T: Serialize>(&self, seq: i64, value: &T) {
        if let Ok(json) = serde_json::to_string(value) {
            self.publish(seq, json);
        }
    }

    /// Subscribes with `(seq, generation, json)` metadata for SSE `Last-Event-ID` streaming.
    pub fn subscribe(&self) -> SliceSubscription {
        SliceSubscription {
            inner: self.channel.subscribe(),
            strip_initial_effects: self.strip_initial_effects,
        }
    }
}

/// Subscription handle for a single [`SliceFeed`] preserving `seq` and SSE `Last-Event-ID` semantics.
pub struct SliceSubscription {
    inner: FeedSubscription,
    strip_initial_effects: bool,
}

impl SliceSubscription {
    pub fn topic(&self) -> &'static str {
        self.inner.topic()
    }

    /// Reads the current snapshot, marks it seen, and strips initial burst effects on `farm` when `is_initial`.
    pub fn borrow_and_update(&mut self, is_initial: bool) -> SliceFrame {
        let mut frame = SliceFrame::from(self.inner.borrow_and_update());
        if is_initial && self.strip_initial_effects {
            frame.json = strip_farm_effects(&frame.json);
        }
        frame
    }

    /// Awaits the next published snapshot update; returns `false` when the feed drops.
    pub async fn changed(&mut self) -> bool {
        self.inner.changed().await
    }

    /// Converts this subscription into a `WatchStream`-backed stream of `(seq, json)`
    /// honoring `after_seq` (`Last-Event-ID` / `?after=<seq>`) without per-client serialization.
    pub fn into_json_watch_stream(self, after_seq: Option<i64>) -> Pin<Box<dyn Stream<Item = (i64, Arc<str>)> + Send>> {
        let strip = self.strip_initial_effects;
        self.inner
            .into_watch_stream(after_seq, move |json| if strip { strip_farm_effects(&json) } else { json })
    }
}

fn strip_farm_effects(json: &Arc<str>) -> Arc<str> {
    if json.contains("\"effects\":[]") {
        return json.clone();
    }
    let Ok(mut val) = serde_json::from_str::<Value>(json) else {
        return json.clone();
    };
    if let Some(arr) = val.get_mut("effects").and_then(Value::as_array_mut)
        && !arr.is_empty()
    {
        arr.clear();
        if let Ok(clean) = serde_json::to_string(&val) {
            return Arc::<str>::from(clean);
        }
    }
    json.clone()
}

fn empty_slice_json(kind: SliceKind) -> Arc<str> {
    let raw = match kind {
        SliceKind::Board => serde_json::to_string(&BoardSlice::default()).expect("BoardSlice serializes"),
        SliceKind::Sessions => serde_json::to_string(&SessionsSlice::default()).expect("SessionsSlice serializes"),
        SliceKind::Collab => serde_json::to_string(&CollabSlice::default()).expect("CollabSlice serializes"),
        SliceKind::Inbox => serde_json::to_string(&InboxSlice {
            seq: 0,
            items: Vec::new(),
            call: vibevalley_protocol::CallState::Idle,
            call_reason: String::new(),
        })
        .expect("InboxSlice serializes"),
        SliceKind::Ops => serde_json::to_string(&OpsSlice::default()).expect("OpsSlice serializes"),
        SliceKind::Farm => serde_json::to_string(&FarmFrame {
            seq: 0,
            view: FarmView {
                level: FarmLevel::default(),
                plots: Default::default(),
                plays: Default::default(),
                decorations: Vec::new(),
            },
            progress: None,
            effects: Vec::new(),
        })
        .expect("FarmFrame serializes"),
    };
    Arc::<str>::from(raw)
}

/// Six pre-encoded slice feeds named in strict singular form, sharing the underlying [`FeedHub`] channels.
struct SliceFeedSet {
    pub board: SliceFeed,
    pub session: SliceFeed,
    pub collab: SliceFeed,
    pub inbox: SliceFeed,
    pub ops: SliceFeed,
    pub farm: SliceFeed,
}

impl SliceFeedSet {
    fn from_hub(hub: &FeedHub<SliceKey, SLICE_COUNT>) -> Self {
        Self {
            board: SliceFeed::from_channel(hub.channel_arc(SliceKey(SliceKind::Board)), SliceKind::Board),
            session: SliceFeed::from_channel(hub.channel_arc(SliceKey(SliceKind::Sessions)), SliceKind::Sessions),
            collab: SliceFeed::from_channel(hub.channel_arc(SliceKey(SliceKind::Collab)), SliceKind::Collab),
            inbox: SliceFeed::from_channel(hub.channel_arc(SliceKey(SliceKind::Inbox)), SliceKind::Inbox),
            ops: SliceFeed::from_channel(hub.channel_arc(SliceKey(SliceKind::Ops)), SliceKind::Ops),
            farm: SliceFeed::from_channel(hub.channel_arc(SliceKey(SliceKind::Farm)), SliceKind::Farm),
        }
    }

    fn get(&self, kind: SliceKind) -> &SliceFeed {
        match kind {
            SliceKind::Board => &self.board,
            SliceKind::Sessions => &self.session,
            SliceKind::Collab => &self.collab,
            SliceKind::Inbox => &self.inbox,
            SliceKind::Ops => &self.ops,
            SliceKind::Farm => &self.farm,
        }
    }
}

/// Single-flight dirty `SliceMask` coalescer and monotonic sequence projector.
pub struct StateFeed {
    hub: Arc<FeedHub<SliceKey, SLICE_COUNT>>,
    feeds: SliceFeedSet,
}

impl StateFeed {
    /// Creates a [`StateFeed`] with the protocol `STATE_EVERY_MS` coalescing window.
    pub fn new() -> Self {
        Self::with_throttle(Duration::from_millis(STATE_EVERY_MS))
    }

    /// Creates a [`StateFeed`] with an explicit leading/trailing throttle duration.
    /// Passing `Duration::ZERO` projects every coalesced single-flight batch immediately.
    fn with_throttle(throttle: Duration) -> Self {
        let hub = Arc::new(FeedHub::new(throttle, |key: SliceKey| (0, empty_slice_json(key.0))));
        let feeds = SliceFeedSet::from_hub(&hub);
        Self { hub, feeds }
    }

    /// Latest global monotonic sequence number.
    pub fn seq(&self) -> i64 {
        self.hub.seq()
    }

    /// Latest sequence number that dirtied `kind`.
    pub fn dirty_seq(&self, kind: SliceKind) -> i64 {
        self.hub.dirty_seq(SliceKey(kind))
    }

    /// Current per-slice published sequence numbers keyed by slice name.
    pub fn slice_seqs(&self) -> BTreeMap<String, i64> {
        self.hub.seqs()
    }

    /// Current watcher counts per slice feed keyed by slice name.
    pub fn watcher_counts(&self) -> BTreeMap<String, u32> {
        self.hub.watcher_counts()
    }

    /// Returns the feed for `kind`.
    pub fn feed(&self, kind: SliceKind) -> &SliceFeed {
        self.feeds.get(kind)
    }

    /// Returns all 6 pre-encoded feeds.
    #[cfg(all(test, not(feature = "loom")))]
    fn feeds(&self) -> &SliceFeedSet {
        &self.feeds
    }

    /// Returns the current pre-encoded JSON snapshot for `kind`.
    pub fn snapshot_json(&self, kind: SliceKind) -> Arc<str> {
        self.hub.snapshot(SliceKey(kind))
    }

    /// Subscribes to pre-encoded JSON updates on `kind` via `tokio::sync::watch<Arc<str>>`.
    /// If `kind` was dirtied while watcherless, immediately schedules an on-demand projection.
    pub fn subscribe_json(&self, kind: SliceKind) -> watch::Receiver<Arc<str>> {
        self.hub.subscribe_payload(SliceKey(kind))
    }

    /// Subscribes to `kind` preserving `seq` and SSE `Last-Event-ID` semantics.
    /// If `kind` was dirtied while watcherless, immediately schedules an on-demand projection.
    pub fn subscribe(&self, kind: SliceKind) -> SliceSubscription {
        SliceSubscription {
            inner: self.hub.subscribe(SliceKey(kind)),
            strip_initial_effects: kind == SliceKind::Farm,
        }
    }

    /// Returns `true` if any slice has an unprojected dirty watermark or lazy-deferred bit.
    pub fn has_unprojected_dirty(&self) -> bool {
        self.hub.has_unprojected_dirty()
    }

    /// Subscribes to `mark_dirty` sequence bumps (wakes even if `start` hasn't run).
    pub fn subscribe_dirty(&self) -> watch::Receiver<i64> {
        self.hub.subscribe_dirty()
    }

    /// Subscribes to projector cycle completions.
    pub fn subscribe_cycles(&self) -> watch::Receiver<u64> {
        self.hub.subscribe_cycles()
    }

    /// Marks the slices in `mask` dirty, advances the monotonic global `seq`,
    /// updates per-slice dirty watermarks, and wakes the single-flight projector loop.
    pub fn mark_dirty(&self, mask: SliceMask) -> i64 {
        self.hub.mark_dirty_bits(mask.bits())
    }

    /// Spawns the single-flight projector worker on `task` using single-slice `projector`.
    pub fn start<F, Fut, E>(self: &Arc<Self>, task: &TaskGroup, mut projector: F)
    where
        F: FnMut(SliceKind, i64) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Arc<str>, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        self.hub.start(task, "state.feed", move |key: SliceKey, seq| projector(key.0, seq));
    }

    /// Spawns the single-flight batch projector worker on `task`.
    ///
    /// Slices dirtied in the same flush cycle are delivered together to `projector` so
    /// shared snapshots (`issues`, `sessions`) are queried from the database once per batch.
    /// Slices with no active watcher are deferred lazily until `subscribe` or `flush`.
    pub fn start_batch<F, Fut, E>(self: &Arc<Self>, task: &TaskGroup, mut projector: F)
    where
        F: FnMut(Vec<(SliceKind, i64)>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Vec<(SliceKind, i64, Result<Arc<str>, E>)>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        self.hub.start_batch(task, "state.feed", move |batch: Vec<(SliceKey, i64)>| {
            let fut = projector(batch.into_iter().map(|(k, seq)| (k.0, seq)).collect());
            async move { fut.await.into_iter().map(|(k, seq, res)| (SliceKey(k), seq, res)).collect() }
        });
    }

    /// Wakes the projector immediately (bypassing throttle cooldown and watcherless deferral)
    /// and waits until all currently dirty slices are projected or the projector stops.
    pub async fn flush(&self) {
        self.hub.flush().await;
    }
}

impl Default for StateFeed {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(all(test, feature = "loom"))]
pub mod loom_models {
    use loom::sync::Arc;
    use loom::sync::Notify;
    use loom::sync::atomic::{AtomicU64, Ordering};
    use loom::thread;

    use super::SliceWakeGate;

    fn bounded_model(f: impl Fn() + Send + Sync + 'static) {
        let mut builder = loom::model::Builder::new();
        builder.max_branches = 100_000;
        builder.preemption_bound = Some(2);
        builder.check(f);
    }

    #[test]
    fn concurrent_commits_never_miss_wakeup_or_regress_dirty_seq() {
        bounded_model(|| {
            let gate = Arc::new(SliceWakeGate::new(0));
            let notify = Arc::new(Notify::new());

            let p1 = {
                let gate = gate.clone();
                let notify = notify.clone();
                thread::spawn(move || {
                    let (seq, should_wake) = gate.record_commit(1 << 0);
                    if should_wake {
                        notify.notify();
                    }
                    seq
                })
            };

            let p2 = {
                let gate = gate.clone();
                let notify = notify.clone();
                thread::spawn(move || {
                    let (seq, should_wake) = gate.record_commit(1 << 0);
                    if should_wake {
                        notify.notify();
                    }
                    seq
                })
            };

            let consumer = {
                let gate = gate.clone();
                let notify = notify.clone();
                thread::spawn(move || {
                    let mut published = 0i64;
                    while published < 2 {
                        let mask = gate.take_pending();
                        if mask == 0 {
                            notify.wait();
                            continue;
                        }
                        if (mask & (1 << 0)) != 0 {
                            let dirty = gate.dirty_seq(0);
                            assert!(dirty >= 1, "dirty_seq(0) must reflect at least the commit that set bit 0");
                            assert!(dirty >= published, "dirty_seq(0) must never regress");
                            published = dirty;
                        }
                    }
                    published
                })
            };

            let seq1 = p1.join().unwrap();
            let seq2 = p2.join().unwrap();
            let mut published = consumer.join().unwrap();

            if (gate.take_pending() & (1 << 0)) != 0 {
                let dirty = gate.dirty_seq(0);
                assert!(dirty >= published, "late pending bit must never regress dirty_seq");
                published = dirty;
            }

            assert_eq!(seq1.max(seq2), 2);
            assert_eq!(gate.seq(), 2);
            assert_eq!(gate.dirty_seq(0), 2);
            assert_eq!(published, 2);
            assert_eq!(gate.take_pending(), 0);
        });
    }

    #[test]
    fn acquire_release_edge_publishes_prior_writes_to_consumer() {
        bounded_model(|| {
            let gate = Arc::new(SliceWakeGate::new(0));
            let notify = Arc::new(Notify::new());
            let payload0 = Arc::new(AtomicU64::new(0));
            let payload1 = Arc::new(AtomicU64::new(0));

            let p1 = {
                let gate = gate.clone();
                let notify = notify.clone();
                let payload0 = payload0.clone();
                thread::spawn(move || {
                    payload0.store(0xA1, Ordering::Relaxed);
                    let (_seq, should_wake) = gate.record_commit(1 << 0);
                    if should_wake {
                        notify.notify();
                    }
                })
            };

            let p2 = {
                let gate = gate.clone();
                let notify = notify.clone();
                let payload1 = payload1.clone();
                thread::spawn(move || {
                    payload1.store(0xB2, Ordering::Relaxed);
                    let (_seq, should_wake) = gate.record_commit(1 << 2);
                    if should_wake {
                        notify.notify();
                    }
                })
            };

            let consumer = {
                let gate = gate.clone();
                let notify = notify.clone();
                thread::spawn(move || {
                    let mut seen = 0u8;
                    while seen != ((1 << 0) | (1 << 2)) {
                        let mask = gate.take_pending();
                        if mask == 0 {
                            notify.wait();
                            continue;
                        }
                        if (mask & (1 << 0)) != 0 {
                            assert_eq!(payload0.load(Ordering::Relaxed), 0xA1);
                            assert!(gate.dirty_seq(0) >= 1);
                            seen |= 1 << 0;
                        }
                        if (mask & (1 << 2)) != 0 {
                            assert_eq!(payload1.load(Ordering::Relaxed), 0xB2);
                            assert!(gate.dirty_seq(2) >= 1);
                            seen |= 1 << 2;
                        }
                    }
                })
            };

            p1.join().unwrap();
            p2.join().unwrap();
            consumer.join().unwrap();
            assert_eq!(gate.take_pending(), 0);
        });
    }

    #[test]
    fn lazy_deferral_and_concurrent_demand_never_miss_wakeup() {
        bounded_model(|| {
            let gate = Arc::new(SliceWakeGate::new(0));
            let notify = Arc::new(Notify::new());

            let (_seq, should_wake) = gate.record_commit(1 << 0);
            if should_wake {
                notify.notify();
            }

            let consumer = {
                let gate = gate.clone();
                let notify = notify.clone();
                thread::spawn(move || {
                    let mut projected = false;
                    for _ in 0..4 {
                        let pending = gate.take_pending();
                        let demanded = gate.take_demand();
                        let work = pending | demanded;
                        if work == 0 {
                            notify.wait();
                            continue;
                        }
                        if (demanded & (1 << 0)) != 0 {
                            assert!(gate.dirty_seq(0) >= 1);
                            projected = true;
                            break;
                        }
                        gate.mark_lazy_deferred(work);
                    }
                    projected
                })
            };

            let subscriber = {
                let gate = gate.clone();
                let notify = notify.clone();
                thread::spawn(move || {
                    let _ = gate.request_demand(1 << 0);
                    notify.notify();
                })
            };

            subscriber.join().unwrap();
            let projected = consumer.join().unwrap();
            assert!(
                projected || (gate.take_demand() & (1 << 0)) != 0 || (gate.take_pending() & (1 << 0)) != 0,
                "demanded lazy slice must either be projected or remain visibly pending"
            );
        });
    }
}

#[cfg(all(test, not(feature = "loom")))]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures_util::StreamExt;
    use parking_lot::Mutex;
    use serde_json::json;
    use tokio::sync::{Notify, oneshot};

    use super::*;

    #[tokio::test]
    async fn single_flight_coalesces_concurrent_dirty_marks_and_preserves_monotonic_seq() {
        let task = TaskGroup::new();
        let feed = Arc::new(StateFeed::with_throttle(Duration::ZERO));

        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(Mutex::new(Vec::<(SliceKind, i64)>::new()));
        let first_entered = Arc::new(Notify::new());
        let first_gate = Arc::new(Mutex::new(None::<oneshot::Receiver<()>>));
        let (release_tx, release_rx) = oneshot::channel();
        *first_gate.lock() = Some(release_rx);

        let in_flight_c = in_flight.clone();
        let max_concurrent_c = max_concurrent.clone();
        let calls_c = calls.clone();
        let first_entered_c = first_entered.clone();
        let first_gate_c = first_gate.clone();

        feed.start(&task, move |kind, seq| {
            let in_flight = in_flight_c.clone();
            let max_concurrent = max_concurrent_c.clone();
            let calls = calls_c.clone();
            let first_entered = first_entered_c.clone();
            let first_gate = first_gate_c.clone();
            Box::pin(async move {
                let active = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                max_concurrent.fetch_max(active, Ordering::SeqCst);
                calls.lock().push((kind, seq));
                let gate = first_gate.lock().take();
                if let Some(rx) = gate {
                    first_entered.notify_one();
                    let _ = rx.await;
                }
                in_flight.fetch_sub(1, Ordering::SeqCst);
                Ok::<_, String>(Arc::<str>::from(json!({ "slice": kind.as_str(), "seq": seq }).to_string()))
            })
        });

        let mut json_rx = feed.subscribe_json(SliceKind::Board);
        assert_eq!(feed.mark_dirty(SliceMask::NONE), 0);
        assert_eq!(feed.mark_dirty(SliceMask::BOARD), 1);

        first_entered.notified().await;
        assert_eq!(feed.mark_dirty(SliceMask::BOARD), 2);
        assert_eq!(feed.mark_dirty(SliceMask::BOARD), 3);
        assert_eq!(feed.mark_dirty(SliceMask::BOARD | SliceMask::INBOX), 4);
        release_tx.send(()).unwrap();

        feed.flush().await;

        assert_eq!(max_concurrent.load(Ordering::SeqCst), 1, "single-flight must never overlap projections");
        let recorded = calls.lock().clone();
        assert_eq!(recorded, vec![(SliceKind::Board, 1), (SliceKind::Board, 4), (SliceKind::Inbox, 4)]);
        assert_eq!(feed.feeds().board.seq(), 4);
        assert_eq!(feed.feeds().inbox.seq(), 4);
        assert_eq!(feed.feeds().session.seq(), 0);
        assert!(json_rx.borrow_and_update().contains("\"seq\":4"));

        assert!(task.shutdown(Duration::from_secs(1)).await);
    }

    #[tokio::test(start_paused = true)]
    async fn trailing_throttle_coalesces_burst_over_state_every_ms() {
        let task = TaskGroup::new();
        let feed = Arc::new(StateFeed::new());
        let calls = Arc::new(Mutex::new(Vec::<i64>::new()));
        let calls_c = calls.clone();

        feed.start(&task, move |kind, seq| {
            let calls = calls_c.clone();
            Box::pin(async move {
                if kind == SliceKind::Ops {
                    calls.lock().push(seq);
                }
                Ok::<_, String>(Arc::<str>::from(json!({ "seq": seq }).to_string()))
            })
        });

        let mut sub = feed.subscribe(SliceKind::Ops);
        assert_eq!(sub.borrow_and_update(true).seq, 0);

        assert_eq!(feed.mark_dirty(SliceMask::OPS), 1);
        assert!(sub.changed().await);
        assert_eq!(sub.borrow_and_update(false).seq, 1);

        assert_eq!(feed.mark_dirty(SliceMask::OPS), 2);
        assert_eq!(feed.mark_dirty(SliceMask::OPS), 3);
        assert_eq!(feed.mark_dirty(SliceMask::OPS), 4);
        tokio::time::advance(Duration::from_millis(STATE_EVERY_MS - 1)).await;
        tokio::task::yield_now().await;
        assert_eq!(feed.feeds().ops.seq(), 1, "burst must hold until STATE_EVERY_MS elapses");

        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(sub.changed().await);
        assert_eq!(sub.borrow_and_update(false).seq, 4);
        assert_eq!(*calls.lock(), vec![1, 4]);

        assert!(task.shutdown(Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn sse_last_event_id_and_farm_initial_effect_stripping() {
        let feed = Arc::new(StateFeed::new());
        let farm_feed = &feed.feeds().farm;

        let frame_with_effect = json!({
            "seq": 5,
            "view": { "level": {}, "plots": {}, "plays": {} },
            "progress": null,
            "effects": [{ "kind": "levelUp", "level": 2 }]
        })
        .to_string();
        farm_feed.publish_if_newer(5, frame_with_effect);

        let mut initial_stream = feed.subscribe(SliceKind::Farm).into_json_watch_stream(None);
        let (seq, json_str) = initial_stream.next().await.unwrap();
        assert_eq!(seq, 5);
        let parsed: Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["effects"], json!([]));

        let mut resume_stream = feed.subscribe(SliceKind::Farm).into_json_watch_stream(Some(5));
        assert!(
            tokio::time::timeout(Duration::from_millis(30), resume_stream.next()).await.is_err(),
            "matching Last-Event-ID must skip initial snapshot"
        );

        let next_frame = json!({
            "seq": 6,
            "view": { "level": {}, "plots": {}, "plays": {} },
            "progress": null,
            "effects": [{ "kind": "levelUp", "level": 3 }]
        })
        .to_string();
        farm_feed.publish_if_newer(6, next_frame);

        let (seq6, json6) = resume_stream.next().await.unwrap();
        assert_eq!(seq6, 6);
        let parsed6: Value = serde_json::from_str(&json6).unwrap();
        assert_eq!(parsed6["effects"], json!([{ "kind": "levelUp", "level": 3 }]));
    }

    #[tokio::test]
    async fn watcherless_slices_defer_lazily_until_subscribe_or_flush() {
        let task = TaskGroup::new();
        let feed = Arc::new(StateFeed::with_throttle(Duration::ZERO));
        let batches = Arc::new(Mutex::new(Vec::<Vec<(SliceKind, i64)>>::new()));
        let batches_c = batches.clone();

        feed.start_batch(&task, move |batch| {
            let batches = batches_c.clone();
            async move {
                batches.lock().push(batch.clone());
                batch
                    .into_iter()
                    .map(|(k, seq)| {
                        (
                            k,
                            seq,
                            Ok::<_, String>(Arc::<str>::from(json!({ "slice": k.as_str(), "seq": seq }).to_string())),
                        )
                    })
                    .collect()
            }
        });

        let mut board_sub = feed.subscribe(SliceKind::Board);
        assert_eq!(board_sub.borrow_and_update(true).seq, 0);

        let seq = feed.mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        assert_eq!(seq, 1);
        assert!(board_sub.changed().await);
        assert_eq!(board_sub.borrow_and_update(false).seq, 1);

        tokio::task::yield_now().await;
        assert_eq!(batches.lock().len(), 1);
        assert_eq!(batches.lock()[0], vec![(SliceKind::Board, 1)]);
        assert_eq!(feed.feeds().session.seq(), 0);
        assert_eq!(feed.feeds().inbox.seq(), 0);
        assert_eq!(feed.feeds().farm.seq(), 0);

        let mut inbox_sub = feed.subscribe(SliceKind::Inbox);
        assert!(inbox_sub.changed().await);
        assert_eq!(inbox_sub.borrow_and_update(false).seq, 1);
        assert_eq!(feed.feeds().session.seq(), 0);
        assert_eq!(feed.feeds().farm.seq(), 0);

        feed.flush().await;
        assert_eq!(feed.feeds().session.seq(), 1);
        assert_eq!(feed.feeds().farm.seq(), 1);
        let recorded = batches.lock().clone();
        assert_eq!(
            recorded.last().unwrap(),
            &vec![(SliceKind::Sessions, 1), (SliceKind::Farm, 1)],
            "flush must coalesce remaining dirty slices into a single shared batch"
        );

        assert!(task.shutdown(Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn watched_four_slice_dirty_mark_delivers_single_shared_batch() {
        let task = TaskGroup::new();
        let feed = Arc::new(StateFeed::with_throttle(Duration::ZERO));
        let batches = Arc::new(Mutex::new(Vec::<Vec<(SliceKind, i64)>>::new()));
        let batches_c = batches.clone();

        feed.start_batch(&task, move |batch| {
            let batches = batches_c.clone();
            async move {
                batches.lock().push(batch.clone());
                batch
                    .into_iter()
                    .map(|(k, seq)| (k, seq, Ok::<_, String>(Arc::<str>::from(json!({ "seq": seq }).to_string()))))
                    .collect()
            }
        });

        let _w_board = feed.subscribe(SliceKind::Board);
        let _w_sessions = feed.subscribe(SliceKind::Sessions);
        let _w_inbox = feed.subscribe(SliceKind::Inbox);
        let _w_farm = feed.subscribe(SliceKind::Farm);

        feed.mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        feed.flush().await;

        let recorded = batches.lock().clone();
        assert_eq!(recorded.len(), 1, "all 4 dirty watched slices must be delivered in 1 batch: {recorded:?}");
        assert_eq!(
            recorded[0],
            vec![(SliceKind::Board, 1), (SliceKind::Sessions, 1), (SliceKind::Inbox, 1), (SliceKind::Farm, 1),]
        );

        assert!(task.shutdown(Duration::from_secs(1)).await);
    }
}
