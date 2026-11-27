//! Single-flight dirty slice coalescing (`StateFeed`) and pre-encoded
//! `tokio::sync::watch<Arc<str>>` slice feeds (`SliceFeed`) for `board`, `session`,
//! `collab`, `inbox`, `ops`, and `farm`, with `loom`-checked lock-free wake gating.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;
use tokio_stream::Stream;
use tokio_stream::wrappers::WatchStream;
use vibevalley_core::SliceMask;
use vibevalley_protocol::{
    ApiError, BizCode, BoardSlice, CollabSlice, FarmFrame, FarmLevel, FarmView, InboxSlice, OpsSlice, STATE_EVERY_MS, SessionsSlice, SliceKind,
};

use super::task::TaskGroup;

/// Conditional synchronization primitives switching to `loom::sync` under
/// `--features loom` so lock-free wake-gate protocols can be exhaustively explored.
mod loom_sync {
    #[cfg(feature = "loom")]
    pub use loom::sync::atomic::{AtomicI64, AtomicU8, Ordering};
    #[cfg(not(feature = "loom"))]
    pub use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
}

use loom_sync::{AtomicI64 as LoomAtomicI64, AtomicU8 as LoomAtomicU8, Ordering as LoomOrdering};

const SLICE_COUNT: usize = 6;
const SLICE_MASK_ALL: u8 = (1 << SLICE_COUNT) - 1;

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

/// Serializes a projected slice payload into pre-encoded `Arc<str>` JSON.
pub fn encode_slice<T: Serialize>(value: &T) -> Result<Arc<str>, ApiError> {
    serde_json::to_string(value)
        .map(Arc::<str>::from)
        .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

/// Lock-free dirty-slice sequence tracker, watcherless lazy-deferral mask, and coalescing wakeup gate.
struct SliceWakeGate {
    seq: LoomAtomicI64,
    dirty_seqs: [LoomAtomicI64; SLICE_COUNT],
    pending_mask: LoomAtomicU8,
    /// Slices whose `mark_dirty` fired while no watcher was subscribed; projected on first `subscribe`/`flush`.
    deferred_lazy_mask: LoomAtomicU8,
    /// Slices explicitly demanded via `subscribe` or `flush` (bypassing watcherless skip and throttle).
    demand_mask: LoomAtomicU8,
}

impl SliceWakeGate {
    fn new(initial_seq: i64) -> Self {
        Self {
            seq: LoomAtomicI64::new(initial_seq),
            dirty_seqs: std::array::from_fn(|_| LoomAtomicI64::new(initial_seq)),
            pending_mask: LoomAtomicU8::new(0),
            deferred_lazy_mask: LoomAtomicU8::new(0),
            demand_mask: LoomAtomicU8::new(0),
        }
    }

    fn seq(&self) -> i64 {
        self.seq.load(LoomOrdering::Acquire)
    }

    fn dirty_seq(&self, idx: usize) -> i64 {
        self.dirty_seqs[idx].load(LoomOrdering::Acquire)
    }

    fn record_commit(&self, mask: u8) -> (i64, bool) {
        let mask = mask & SLICE_MASK_ALL;
        if mask == 0 {
            return (self.seq(), false);
        }
        let seq = self.seq.fetch_add(1, LoomOrdering::AcqRel) + 1;
        for (idx, slot) in self.dirty_seqs.iter().enumerate() {
            if (mask & (1u8 << idx)) != 0 {
                store_max(slot, seq);
            }
        }
        let prev = self.pending_mask.fetch_or(mask, LoomOrdering::AcqRel);
        (seq, prev == 0)
    }

    fn mark_lazy_deferred(&self, mask: u8) {
        let mask = mask & SLICE_MASK_ALL;
        if mask != 0 {
            self.deferred_lazy_mask.fetch_or(mask, LoomOrdering::AcqRel);
        }
    }

    fn request_demand(&self, mask: u8) -> bool {
        let mask = mask & SLICE_MASK_ALL;
        if mask == 0 {
            return false;
        }
        self.deferred_lazy_mask.fetch_and(!mask, LoomOrdering::AcqRel);
        self.demand_mask.fetch_or(mask, LoomOrdering::AcqRel);
        let prev = self.pending_mask.fetch_or(mask, LoomOrdering::AcqRel);
        prev == 0
    }

    fn take_pending(&self) -> u8 {
        self.pending_mask.swap(0, LoomOrdering::AcqRel)
    }

    fn take_demand(&self) -> u8 {
        self.demand_mask.swap(0, LoomOrdering::AcqRel)
    }

    fn pending_bits(&self) -> u8 {
        self.pending_mask.load(LoomOrdering::Acquire)
    }

    fn deferred_lazy_bits(&self) -> u8 {
        self.deferred_lazy_mask.load(LoomOrdering::Acquire)
    }

    fn demand_bits(&self) -> u8 {
        self.demand_mask.load(LoomOrdering::Acquire)
    }
}

/// Pre-encoded slice snapshot published through [`SliceFeed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliceFrame {
    pub seq: i64,
    pub generation: u64,
    pub json: Arc<str>,
}

struct FeedState {
    latest: SliceFrame,
}

/// Pre-encoded `tokio::sync::watch<Arc<str>>` feed for a single state slice.
pub struct SliceFeed {
    topic: &'static str,
    json_tx: watch::Sender<Arc<str>>,
    frame_tx: watch::Sender<SliceFrame>,
    strip_initial_effects: bool,
    state: Mutex<FeedState>,
}

impl SliceFeed {
    /// Creates a [`SliceFeed`] initialized with `initial_seq` and pre-encoded `initial_json`.
    fn new(kind: SliceKind, initial_seq: i64, initial_json: impl Into<Arc<str>>) -> Self {
        let json: Arc<str> = initial_json.into();
        let initial = SliceFrame {
            seq: initial_seq,
            generation: 0,
            json: json.clone(),
        };
        let (json_tx, _) = watch::channel(json);
        let (frame_tx, _) = watch::channel(initial.clone());
        Self {
            topic: slice_topic(kind),
            json_tx,
            frame_tx,
            strip_initial_effects: kind == SliceKind::Farm,
            state: Mutex::new(FeedState { latest: initial }),
        }
    }

    /// Creates a [`SliceFeed`] serialized from an initial typed slice value.
    pub fn from_value<T: Serialize>(kind: SliceKind, initial_seq: i64, value: &T) -> Self {
        let json = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
        Self::new(kind, initial_seq, json)
    }

    pub fn seq(&self) -> i64 {
        self.state.lock().latest.seq
    }

    pub fn snapshot_json(&self) -> Arc<str> {
        self.state.lock().latest.json.clone()
    }

    pub fn has_watchers(&self) -> bool {
        self.json_tx.receiver_count() > 0 || self.frame_tx.receiver_count() > 0
    }

    pub fn watcher_count(&self) -> usize {
        self.json_tx.receiver_count() + self.frame_tx.receiver_count()
    }

    /// Publishes `(seq, json)` if `seq` is strictly greater than the current feed sequence.
    /// Returns `true` when published.
    fn publish_if_newer(&self, seq: i64, json: impl Into<Arc<str>>) -> bool {
        let json: Arc<str> = json.into();
        let frame = {
            let mut state = self.state.lock();
            if seq <= state.latest.seq {
                return false;
            }
            let generation = state.latest.generation + 1;
            let frame = SliceFrame {
                seq,
                generation,
                json: json.clone(),
            };
            state.latest = frame.clone();
            frame
        };
        self.json_tx.send_replace(json);
        self.frame_tx.send_replace(frame);
        true
    }

    /// Unconditionally publishes a new frame (e.g. burst `FarmEffect` or locale refresh),
    /// clamping `seq` to at least the previous sequence so `seq` never regresses.
    pub fn publish(&self, seq: i64, json: impl Into<Arc<str>>) {
        let json: Arc<str> = json.into();
        let frame = {
            let mut state = self.state.lock();
            let next_seq = seq.max(state.latest.seq);
            let generation = state.latest.generation + 1;
            let frame = SliceFrame {
                seq: next_seq,
                generation,
                json: json.clone(),
            };
            state.latest = frame.clone();
            frame
        };
        self.json_tx.send_replace(json);
        self.frame_tx.send_replace(frame);
    }

    /// Serializes `value` and publishes it at `seq`.
    pub fn publish_value<T: Serialize>(&self, seq: i64, value: &T) {
        if let Ok(json) = serde_json::to_string(value) {
            self.publish(seq, json);
        }
    }

    /// Direct `tokio::sync::watch::Receiver<Arc<str>>` subscription carrying pre-encoded JSON.
    fn subscribe_json(&self) -> watch::Receiver<Arc<str>> {
        self.json_tx.subscribe()
    }

    /// Subscribes with `(seq, generation, json)` metadata for SSE `Last-Event-ID` streaming.
    pub fn subscribe(&self) -> SliceSubscription {
        SliceSubscription {
            topic: self.topic,
            rx: self.frame_tx.subscribe(),
            strip_initial_effects: self.strip_initial_effects,
        }
    }
}

/// Subscription handle for a single [`SliceFeed`] preserving `seq` and SSE `Last-Event-ID` semantics.
pub struct SliceSubscription {
    topic: &'static str,
    rx: watch::Receiver<SliceFrame>,
    strip_initial_effects: bool,
}

impl SliceSubscription {
    pub fn topic(&self) -> &'static str {
        self.topic
    }

    /// Reads the current snapshot, marks it seen, and strips initial burst effects on `farm` when `is_initial`.
    pub fn borrow_and_update(&mut self, is_initial: bool) -> SliceFrame {
        let mut frame = self.rx.borrow_and_update().clone();
        if is_initial && self.strip_initial_effects {
            frame.json = strip_farm_effects(&frame.json);
        }
        frame
    }

    /// Awaits the next published snapshot update; returns `false` when the feed drops.
    pub async fn changed(&mut self) -> bool {
        self.rx.changed().await.is_ok()
    }

    /// Converts this subscription into a `WatchStream`-backed stream of `(seq, json)`
    /// honoring `after_seq` (`Last-Event-ID` / `?after=<seq>`) without per-client serialization.
    pub fn into_json_watch_stream(self, after_seq: Option<i64>) -> Pin<Box<dyn Stream<Item = (i64, Arc<str>)> + Send>> {
        use futures_util::StreamExt;

        let (initial_seq, initial_gen) = {
            let initial = self.rx.borrow();
            (initial.seq, initial.generation)
        };
        let skip_initial = after_seq == Some(initial_seq);
        let stream = if skip_initial {
            WatchStream::from_changes(self.rx)
        } else {
            WatchStream::new(self.rx)
        };
        let mut seen_gen = skip_initial.then_some(initial_gen);
        let mut initial = !skip_initial && after_seq.is_none();
        let strip_initial_effects = self.strip_initial_effects;

        Box::pin(stream.filter_map(move |frame| {
            let out = if seen_gen == Some(frame.generation) {
                None
            } else {
                seen_gen = Some(frame.generation);
                let strip = initial && strip_initial_effects;
                initial = false;
                let json = if strip { strip_farm_effects(&frame.json) } else { frame.json };
                Some((frame.seq, json))
            };
            std::future::ready(out)
        }))
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

/// Six pre-encoded slice feeds named in strict singular form.
struct SliceFeedSet {
    pub board: SliceFeed,
    pub session: SliceFeed,
    pub collab: SliceFeed,
    pub inbox: SliceFeed,
    pub ops: SliceFeed,
    pub farm: SliceFeed,
}

impl SliceFeedSet {
    fn new_empty() -> Self {
        let board_json = serde_json::to_string(&BoardSlice::default()).expect("BoardSlice serializes");
        let session_json = serde_json::to_string(&SessionsSlice::default()).expect("SessionsSlice serializes");
        let collab_json = serde_json::to_string(&CollabSlice::default()).expect("CollabSlice serializes");
        let inbox_json = serde_json::to_string(&InboxSlice {
            seq: 0,
            items: Vec::new(),
            call: vibevalley_protocol::CallState::Idle,
            call_reason: String::new(),
        })
        .expect("InboxSlice serializes");
        let ops_json = serde_json::to_string(&OpsSlice::default()).expect("OpsSlice serializes");
        let farm_json = serde_json::to_string(&FarmFrame {
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
        .expect("FarmFrame serializes");

        Self {
            board: SliceFeed::new(SliceKind::Board, 0, board_json),
            session: SliceFeed::new(SliceKind::Sessions, 0, session_json),
            collab: SliceFeed::new(SliceKind::Collab, 0, collab_json),
            inbox: SliceFeed::new(SliceKind::Inbox, 0, inbox_json),
            ops: SliceFeed::new(SliceKind::Ops, 0, ops_json),
            farm: SliceFeed::new(SliceKind::Farm, 0, farm_json),
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
    feeds: SliceFeedSet,
    gate: SliceWakeGate,
    notify: Notify,
    flush_notify: Notify,
    throttle: Duration,
    last_published: Mutex<[Option<Instant>; SLICE_COUNT]>,
    running: AtomicBool,
    cycle_tx: watch::Sender<u64>,
    dirty_tx: watch::Sender<i64>,
}

impl StateFeed {
    /// Creates a [`StateFeed`] with the protocol `STATE_EVERY_MS` coalescing window.
    pub fn new() -> Self {
        Self::with_throttle(Duration::from_millis(STATE_EVERY_MS))
    }

    /// Creates a [`StateFeed`] with an explicit leading/trailing throttle duration.
    /// Passing `Duration::ZERO` projects every coalesced single-flight batch immediately.
    fn with_throttle(throttle: Duration) -> Self {
        let (cycle_tx, _) = watch::channel(0u64);
        let (dirty_tx, _) = watch::channel(0i64);
        Self {
            feeds: SliceFeedSet::new_empty(),
            gate: SliceWakeGate::new(0),
            notify: Notify::new(),
            flush_notify: Notify::new(),
            throttle,
            last_published: Mutex::new([None; SLICE_COUNT]),
            running: AtomicBool::new(false),
            cycle_tx,
            dirty_tx,
        }
    }

    /// Latest global monotonic sequence number.
    pub fn seq(&self) -> i64 {
        self.gate.seq()
    }

    /// Latest sequence number that dirtied `kind`.
    pub fn dirty_seq(&self, kind: SliceKind) -> i64 {
        self.gate.dirty_seq(slice_index(kind))
    }

    /// Current per-slice published sequence numbers keyed by slice name.
    pub fn slice_seqs(&self) -> BTreeMap<String, i64> {
        SliceKind::ALL.into_iter().map(|k| (k.as_str().to_string(), self.feeds.get(k).seq())).collect()
    }

    /// Current watcher counts per slice feed keyed by slice name.
    pub fn watcher_counts(&self) -> BTreeMap<String, u32> {
        SliceKind::ALL
            .into_iter()
            .map(|k| (k.as_str().to_string(), self.feeds.get(k).watcher_count() as u32))
            .collect()
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
        self.feeds.get(kind).snapshot_json()
    }

    /// Subscribes to pre-encoded JSON updates on `kind` via `tokio::sync::watch<Arc<str>>`.
    /// If `kind` was dirtied while watcherless, immediately schedules an on-demand projection.
    pub fn subscribe_json(&self, kind: SliceKind) -> watch::Receiver<Arc<str>> {
        let rx = self.feeds.get(kind).subscribe_json();
        self.wake_if_stale(kind);
        rx
    }

    /// Subscribes to `kind` preserving `seq` and SSE `Last-Event-ID` semantics.
    /// If `kind` was dirtied while watcherless, immediately schedules an on-demand projection.
    pub fn subscribe(&self, kind: SliceKind) -> SliceSubscription {
        let sub = self.feeds.get(kind).subscribe();
        self.wake_if_stale(kind);
        sub
    }

    /// Returns `true` if any slice has an unprojected dirty watermark or lazy-deferred bit.
    pub fn has_unprojected_dirty(&self) -> bool {
        self.gate.pending_bits() != 0
            || self.gate.deferred_lazy_bits() != 0
            || self.gate.demand_bits() != 0
            || SliceKind::ALL.into_iter().any(|k| self.feed(k).seq() < self.dirty_seq(k))
    }

    fn wake_if_stale(&self, kind: SliceKind) {
        let bit = SliceMask::from_kind(kind).bits();
        let deferred = (self.gate.deferred_lazy_bits() & bit) != 0;
        if deferred || self.feed(kind).seq() < self.dirty_seq(kind) {
            self.gate.request_demand(bit);
            self.notify.notify_one();
        }
    }

    /// Subscribes to `mark_dirty` sequence bumps (wakes even if `start` hasn't run).
    pub fn subscribe_dirty(&self) -> watch::Receiver<i64> {
        self.dirty_tx.subscribe()
    }

    /// Subscribes to projector cycle completions.
    pub fn subscribe_cycles(&self) -> watch::Receiver<u64> {
        self.cycle_tx.subscribe()
    }

    /// Marks the slices in `mask` dirty, advances the monotonic global `seq`,
    /// updates per-slice dirty watermarks, and wakes the single-flight projector loop.
    pub fn mark_dirty(&self, mask: SliceMask) -> i64 {
        let (seq, should_wake) = self.gate.record_commit(mask.bits());
        let _ = self.dirty_tx.send_replace(seq);
        if should_wake || (mask.bits() & SLICE_MASK_ALL) != 0 {
            self.notify.notify_one();
        }
        seq
    }

    /// Spawns the single-flight projector worker on `task` using single-slice `projector`.
    pub fn start<F, Fut, E>(self: &Arc<Self>, task: &TaskGroup, projector: F)
    where
        F: FnMut(SliceKind, i64) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Arc<str>, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        let projector = Arc::new(tokio::sync::Mutex::new(projector));
        self.start_batch(task, move |batch| {
            let projector = projector.clone();
            async move {
                let mut out = Vec::with_capacity(batch.len());
                let mut f = projector.lock().await;
                for (kind, seq) in batch {
                    out.push((kind, seq, f(kind, seq).await));
                }
                out
            }
        });
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
        self.running.store(true, Ordering::Release);
        let this = self.clone();
        let cancel = task.token();
        task.spawn_named("state.feed", async move {
            struct RunningGuard(Arc<StateFeed>);
            impl Drop for RunningGuard {
                fn drop(&mut self) {
                    self.0.running.store(false, Ordering::Release);
                    self.0.cycle_tx.send_modify(|c| *c += 1);
                }
            }
            let _guard = RunningGuard(this.clone());

            loop {
                let pending = this.gate.take_pending();
                let demanded = this.gate.take_demand();
                let work = pending | demanded;
                if work == 0 {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return,
                        _ = this.notify.notified() => continue,
                    }
                }

                let mut ready: Vec<(SliceKind, i64)> = Vec::new();
                let mut ready_record_throttle = 0u8;
                let mut deferred_throttle = 0u8;
                let mut lazy_skip = 0u8;

                for kind in SliceKind::ALL {
                    let bit = SliceMask::from_kind(kind).bits();
                    if (work & bit) == 0 {
                        continue;
                    }
                    let is_demanded = (demanded & bit) != 0;
                    if !is_demanded && !this.feed(kind).has_watchers() {
                        lazy_skip |= bit;
                        continue;
                    }
                    let target_seq = this.dirty_seq(kind);
                    if this.feed(kind).seq() >= target_seq {
                        continue;
                    }
                    if is_demanded || this.can_publish_leading(kind) {
                        ready.push((kind, target_seq));
                        if !is_demanded {
                            ready_record_throttle |= bit;
                        }
                    } else {
                        deferred_throttle |= bit;
                    }
                }

                if lazy_skip != 0 {
                    this.gate.mark_lazy_deferred(lazy_skip);
                }

                if !ready.is_empty() {
                    this.project_batch(&mut projector, ready, ready_record_throttle).await;
                    if cancel.is_cancelled() {
                        return;
                    }
                }

                if deferred_throttle != 0 && !this.throttle.is_zero() {
                    let sleep = tokio::time::sleep(this.throttle);
                    tokio::pin!(sleep);
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return,
                        _ = &mut sleep => {}
                        _ = this.flush_notify.notified() => {}
                    }
                    if cancel.is_cancelled() {
                        return;
                    }
                    let trailing_pending = this.gate.take_pending();
                    let trailing_demanded = this.gate.take_demand();
                    let trailing = deferred_throttle | trailing_pending | trailing_demanded;
                    let mut trailing_ready: Vec<(SliceKind, i64)> = Vec::new();
                    let mut trailing_record_throttle = 0u8;
                    let mut trailing_lazy = 0u8;
                    for kind in SliceKind::ALL {
                        let bit = SliceMask::from_kind(kind).bits();
                        if (trailing & bit) == 0 {
                            continue;
                        }
                        let is_demanded = (trailing_demanded & bit) != 0 || (deferred_throttle & bit) != 0;
                        if !is_demanded && !this.feed(kind).has_watchers() {
                            trailing_lazy |= bit;
                            continue;
                        }
                        let target_seq = this.dirty_seq(kind);
                        if this.feed(kind).seq() >= target_seq {
                            continue;
                        }
                        trailing_ready.push((kind, target_seq));
                        if (trailing_demanded & bit) == 0 {
                            trailing_record_throttle |= bit;
                        }
                    }
                    if trailing_lazy != 0 {
                        this.gate.mark_lazy_deferred(trailing_lazy);
                    }
                    if !trailing_ready.is_empty() {
                        this.project_batch(&mut projector, trailing_ready, trailing_record_throttle).await;
                        if cancel.is_cancelled() {
                            return;
                        }
                    }
                }

                this.cycle_tx.send_modify(|c| *c += 1);
            }
        });
    }

    /// Wakes the projector immediately (bypassing throttle cooldown and watcherless deferral)
    /// and waits until all currently dirty slices are projected or the projector stops.
    pub async fn flush(&self) {
        if !self.running.load(Ordering::Acquire) {
            return;
        }
        let mut cycle_rx = self.cycle_tx.subscribe();
        let _ = *cycle_rx.borrow_and_update();

        let mut need_mask = self.gate.pending_bits() | self.gate.deferred_lazy_bits();
        for kind in SliceKind::ALL {
            if self.feed(kind).seq() < self.dirty_seq(kind) {
                need_mask |= SliceMask::from_kind(kind).bits();
            }
        }
        if need_mask != 0 {
            self.gate.request_demand(need_mask);
        }
        self.flush_notify.notify_one();
        self.notify.notify_one();

        while self.running.load(Ordering::Acquire) {
            let pending = self.gate.pending_bits();
            let demanded = self.gate.demand_bits();
            let all_synced = SliceKind::ALL.into_iter().all(|k| self.feed(k).seq() >= self.dirty_seq(k));
            if pending == 0 && demanded == 0 && all_synced {
                break;
            }
            if cycle_rx.changed().await.is_err() {
                break;
            }
            // Re-demand any slice dirtied or deferred while flush was waiting so `flush()` never stalls on watcherless slices.
            let mut late_mask = self.gate.deferred_lazy_bits();
            for kind in SliceKind::ALL {
                if self.feed(kind).seq() < self.dirty_seq(kind) {
                    late_mask |= SliceMask::from_kind(kind).bits();
                }
            }
            if late_mask != 0 {
                self.gate.request_demand(late_mask);
                self.flush_notify.notify_one();
                self.notify.notify_one();
            }
        }
    }

    fn can_publish_leading(&self, kind: SliceKind) -> bool {
        if self.throttle.is_zero() {
            return true;
        }
        // Farm coalesces transient `GameEffect` bursts across the `STATE_EVERY_MS` window
        // instead of draining the first effect on the leading edge.
        if kind == SliceKind::Farm {
            return false;
        }
        let last = self.last_published.lock()[slice_index(kind)];
        match last {
            None => true,
            Some(at) => Instant::now().duration_since(at) >= self.throttle,
        }
    }

    async fn project_batch<F, Fut, E>(&self, projector: &mut F, batch: Vec<(SliceKind, i64)>, record_throttle_mask: u8)
    where
        F: FnMut(Vec<(SliceKind, i64)>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Vec<(SliceKind, i64, Result<Arc<str>, E>)>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        let results = projector(batch).await;
        let now = Instant::now();
        for (kind, target_seq, outcome) in results {
            let feed = self.feed(kind);
            match outcome {
                Ok(json) => {
                    if kind == SliceKind::Farm {
                        feed.publish(target_seq, json);
                    } else {
                        feed.publish_if_newer(target_seq, json);
                    }
                    if (record_throttle_mask & SliceMask::from_kind(kind).bits()) != 0 {
                        self.last_published.lock()[slice_index(kind)] = Some(now);
                    }
                }
                Err(err) => {
                    tracing::warn!(slice = kind.as_str(), seq = target_seq, error = %err, "slice.project failed");
                }
            }
        }
    }
}

impl Default for StateFeed {
    fn default() -> Self {
        Self::new()
    }
}

fn store_max(slot: &LoomAtomicI64, val: i64) {
    let mut cur = slot.load(LoomOrdering::Acquire);
    while val > cur {
        match slot.compare_exchange(cur, val, LoomOrdering::AcqRel, LoomOrdering::Acquire) {
            Ok(_) => break,
            Err(actual) => cur = actual,
        }
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

            // Producer marks slice 0 dirty (no watcher yet).
            let (_seq, should_wake) = gate.record_commit(1 << 0);
            if should_wake {
                notify.notify();
            }

            // Consumer thread sees watcherless slice 0 and defers it lazily, then waits for demand.
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

            // Concurrent subscriber/flush thread demands slice 0.
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
    use std::sync::atomic::AtomicUsize;

    use futures_util::StreamExt;
    use serde_json::json;
    use tokio::sync::oneshot;

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

        // Watch only Board; Inbox, Sessions, and Farm have zero watchers.
        let mut board_sub = feed.subscribe(SliceKind::Board);
        assert_eq!(board_sub.borrow_and_update(true).seq, 0);

        let seq = feed.mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
        assert_eq!(seq, 1);
        assert!(board_sub.changed().await);
        assert_eq!(board_sub.borrow_and_update(false).seq, 1);

        // Give projector one yield to finish cycle; watcherless slices MUST NOT have projected.
        tokio::task::yield_now().await;
        assert_eq!(batches.lock().len(), 1);
        assert_eq!(batches.lock()[0], vec![(SliceKind::Board, 1)]);
        assert_eq!(feed.feeds().session.seq(), 0);
        assert_eq!(feed.feeds().inbox.seq(), 0);
        assert_eq!(feed.feeds().farm.seq(), 0);

        // Subscribing to Inbox triggers on-demand projection of Inbox only.
        let mut inbox_sub = feed.subscribe(SliceKind::Inbox);
        assert!(inbox_sub.changed().await);
        assert_eq!(inbox_sub.borrow_and_update(false).seq, 1);
        assert_eq!(feed.feeds().session.seq(), 0);
        assert_eq!(feed.feeds().farm.seq(), 0);

        // Explicit flush() projects the remaining dirty watcherless slices (Sessions + Farm) together in ONE batch!
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
