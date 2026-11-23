//! Bounded-1 coalescing feed for a single state slice (`board`, `sessions`,
//! `collab`, `inbox`, `ops`, `farm`), backed by `tokio::sync::watch`.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use tokio_stream::Stream;
use tokio_stream::wrappers::WatchStream;
use vibevalley_protocol::{BoardSlice, CollabSlice, FarmFrame, InboxSlice, OpsSlice, STATE_EVERY_MS, SessionsSlice};

use crate::transport::api::FaultGate;

pub trait Sequenced {
    fn seq(&self) -> i64;
}

impl Sequenced for BoardSlice {
    fn seq(&self) -> i64 {
        self.seq
    }
}

impl Sequenced for SessionsSlice {
    fn seq(&self) -> i64 {
        self.seq
    }
}

impl Sequenced for CollabSlice {
    fn seq(&self) -> i64 {
        self.seq
    }
}

impl Sequenced for InboxSlice {
    fn seq(&self) -> i64 {
        self.seq
    }
}

impl Sequenced for OpsSlice {
    fn seq(&self) -> i64 {
        self.seq
    }
}

impl Sequenced for FarmFrame {
    fn seq(&self) -> i64 {
        self.seq
    }
}

pub struct SliceSnapshot<T> {
    pub seq: i64,
    generation: u64,
    pub slice: Arc<T>,
    pub locale: String,
    wire: OnceLock<Value>,
    json: OnceLock<Arc<str>>,
}

impl<T: Serialize> SliceSnapshot<T> {
    fn new(seq: i64, generation: u64, slice: T) -> Self {
        Self {
            seq,
            generation,
            slice: Arc::new(slice),
            locale: vibevalley_i18n::locale(),
            wire: OnceLock::new(),
            json: OnceLock::new(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn wire(&self) -> &Value {
        self.wire.get_or_init(|| serde_json::to_value(self.slice.as_ref()).expect("slice serializes"))
    }

    /// Cached UTF-8 JSON representation shared across all SSE and snapshot readers.
    pub fn json(&self) -> Arc<str> {
        self.json
            .get_or_init(|| Arc::<str>::from(serde_json::to_string(self.slice.as_ref()).expect("slice serializes")))
            .clone()
    }
}

/// Typed `watch::Receiver` handle for any one of the six domain slices.
pub enum SliceSubscription {
    Board(watch::Receiver<Arc<SliceSnapshot<BoardSlice>>>),
    Sessions(watch::Receiver<Arc<SliceSnapshot<SessionsSlice>>>),
    Collab(watch::Receiver<Arc<SliceSnapshot<CollabSlice>>>),
    Inbox(watch::Receiver<Arc<SliceSnapshot<InboxSlice>>>),
    Ops(watch::Receiver<Arc<SliceSnapshot<OpsSlice>>>),
    Farm {
        rx: watch::Receiver<Arc<SliceSnapshot<FarmFrame>>>,
        strip_initial_effects: bool,
    },
}

fn wire_of<T: Serialize>(snap: &SliceSnapshot<T>, strip_effects: bool) -> (i64, Value) {
    let val = snap.wire();
    if strip_effects && val.get("effects").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
        let mut clean = val.clone();
        clean["effects"] = Value::Array(vec![]);
        return (snap.seq, clean);
    }
    (snap.seq, val.clone())
}

impl SliceSubscription {
    pub fn topic(&self) -> &'static str {
        match self {
            SliceSubscription::Board(_) => "slice:board",
            SliceSubscription::Sessions(_) => "slice:sessions",
            SliceSubscription::Collab(_) => "slice:collab",
            SliceSubscription::Inbox(_) => "slice:inbox",
            SliceSubscription::Ops(_) => "slice:ops",
            SliceSubscription::Farm { .. } => "slice:farm",
        }
    }

    /// Reads the current snapshot, marks it seen, and returns `(seq, generation, wire)`.
    pub fn borrow_and_update(&mut self, is_initial: bool) -> (i64, u64, Value) {
        match self {
            SliceSubscription::Board(rx) => {
                let snap = rx.borrow_and_update().clone();
                let (seq, val) = wire_of(&snap, false);
                (seq, snap.generation, val)
            }
            SliceSubscription::Sessions(rx) => {
                let snap = rx.borrow_and_update().clone();
                let (seq, val) = wire_of(&snap, false);
                (seq, snap.generation, val)
            }
            SliceSubscription::Collab(rx) => {
                let snap = rx.borrow_and_update().clone();
                let (seq, val) = wire_of(&snap, false);
                (seq, snap.generation, val)
            }
            SliceSubscription::Inbox(rx) => {
                let snap = rx.borrow_and_update().clone();
                let (seq, val) = wire_of(&snap, false);
                (seq, snap.generation, val)
            }
            SliceSubscription::Ops(rx) => {
                let snap = rx.borrow_and_update().clone();
                let (seq, val) = wire_of(&snap, false);
                (seq, snap.generation, val)
            }
            SliceSubscription::Farm { rx, strip_initial_effects } => {
                let snap = rx.borrow_and_update().clone();
                let (seq, val) = wire_of(&snap, is_initial && *strip_initial_effects);
                (seq, snap.generation, val)
            }
        }
    }

    /// Awaits the next published snapshot update; returns `false` when the feed drops.
    pub async fn changed(&mut self) -> bool {
        match self {
            SliceSubscription::Board(rx) => rx.changed().await.is_ok(),
            SliceSubscription::Sessions(rx) => rx.changed().await.is_ok(),
            SliceSubscription::Collab(rx) => rx.changed().await.is_ok(),
            SliceSubscription::Inbox(rx) => rx.changed().await.is_ok(),
            SliceSubscription::Ops(rx) => rx.changed().await.is_ok(),
            SliceSubscription::Farm { rx, .. } => rx.changed().await.is_ok(),
        }
    }

    /// Converts this subscription into a `WatchStream`-backed stream of `(seq, json_value)` frames.
    pub fn into_watch_stream(self, after_seq: Option<i64>) -> std::pin::Pin<Box<dyn Stream<Item = (i64, Value)> + Send>> {
        fn wrap<T: Sequenced + Serialize + Send + Sync + 'static>(
            rx: watch::Receiver<Arc<SliceSnapshot<T>>>,
            after_seq: Option<i64>,
            strip_initial_effects: bool,
        ) -> std::pin::Pin<Box<dyn Stream<Item = (i64, Value)> + Send>> {
            use futures_util::StreamExt;
            let (initial_seq, initial_gen) = {
                let initial = rx.borrow();
                (initial.seq, initial.generation)
            };
            let skip_initial = after_seq == Some(initial_seq);
            let stream = if skip_initial { WatchStream::from_changes(rx) } else { WatchStream::new(rx) };
            let mut seen_gen = skip_initial.then_some(initial_gen);
            let mut initial = !skip_initial && after_seq.is_none();
            Box::pin(stream.filter_map(move |snap| {
                let out = if seen_gen == Some(snap.generation) {
                    None
                } else {
                    seen_gen = Some(snap.generation);
                    let strip = initial && strip_initial_effects;
                    initial = false;
                    Some(wire_of(&snap, strip))
                };
                std::future::ready(out)
            }))
        }
        match self {
            SliceSubscription::Board(rx) => wrap(rx, after_seq, false),
            SliceSubscription::Sessions(rx) => wrap(rx, after_seq, false),
            SliceSubscription::Collab(rx) => wrap(rx, after_seq, false),
            SliceSubscription::Inbox(rx) => wrap(rx, after_seq, false),
            SliceSubscription::Ops(rx) => wrap(rx, after_seq, false),
            SliceSubscription::Farm { rx, strip_initial_effects } => wrap(rx, after_seq, strip_initial_effects),
        }
    }

    /// Converts this subscription into a `WatchStream`-backed stream of `(seq, json_str)`
    /// frames reusing each snapshot's cached `Arc<str>` without per-client serialization.
    pub fn into_json_watch_stream(self, after_seq: Option<i64>) -> std::pin::Pin<Box<dyn Stream<Item = (i64, Arc<str>)> + Send>> {
        fn wrap_json<T: Sequenced + Serialize + Send + Sync + 'static>(
            rx: watch::Receiver<Arc<SliceSnapshot<T>>>,
            after_seq: Option<i64>,
        ) -> std::pin::Pin<Box<dyn Stream<Item = (i64, Arc<str>)> + Send>> {
            use futures_util::StreamExt;
            let (initial_seq, initial_gen) = {
                let initial = rx.borrow();
                (initial.seq, initial.generation)
            };
            let skip_initial = after_seq == Some(initial_seq);
            let stream = if skip_initial { WatchStream::from_changes(rx) } else { WatchStream::new(rx) };
            let mut seen_gen = skip_initial.then_some(initial_gen);
            Box::pin(stream.filter_map(move |snap| {
                let out = if seen_gen == Some(snap.generation) {
                    None
                } else {
                    seen_gen = Some(snap.generation);
                    Some((snap.seq, snap.json()))
                };
                std::future::ready(out)
            }))
        }

        fn wrap_farm_json(
            rx: watch::Receiver<Arc<SliceSnapshot<FarmFrame>>>,
            after_seq: Option<i64>,
            strip_initial_effects: bool,
        ) -> std::pin::Pin<Box<dyn Stream<Item = (i64, Arc<str>)> + Send>> {
            use futures_util::StreamExt;
            let (initial_seq, initial_gen) = {
                let initial = rx.borrow();
                (initial.seq, initial.generation)
            };
            let skip_initial = after_seq == Some(initial_seq);
            let stream = if skip_initial { WatchStream::from_changes(rx) } else { WatchStream::new(rx) };
            let mut seen_gen = skip_initial.then_some(initial_gen);
            let mut initial = !skip_initial && after_seq.is_none();
            Box::pin(stream.filter_map(move |snap| {
                let out = if seen_gen == Some(snap.generation) {
                    None
                } else {
                    seen_gen = Some(snap.generation);
                    let strip = initial && strip_initial_effects;
                    initial = false;
                    let json = if strip && !snap.slice.effects.is_empty() {
                        let mut clean = snap.slice.as_ref().clone();
                        clean.effects.clear();
                        Arc::<str>::from(serde_json::to_string(&clean).expect("farm frame serializes"))
                    } else {
                        snap.json()
                    };
                    Some((snap.seq, json))
                };
                std::future::ready(out)
            }))
        }

        match self {
            SliceSubscription::Board(rx) => wrap_json(rx, after_seq),
            SliceSubscription::Sessions(rx) => wrap_json(rx, after_seq),
            SliceSubscription::Collab(rx) => wrap_json(rx, after_seq),
            SliceSubscription::Inbox(rx) => wrap_json(rx, after_seq),
            SliceSubscription::Ops(rx) => wrap_json(rx, after_seq),
            SliceSubscription::Farm { rx, strip_initial_effects } => wrap_farm_json(rx, after_seq, strip_initial_effects),
        }
    }
}

pub struct SliceFeed<T> {
    topic: &'static str,
    tx: watch::Sender<Arc<SliceSnapshot<T>>>,
    meta: Mutex<FeedMeta<T>>,
}

struct FeedMeta<T> {
    latest: Arc<SliceSnapshot<T>>,
    generation: u64,
    last: Option<(u64, Instant)>,
}

fn apply_fault_gate(fault_gate: Option<&Arc<dyn FaultGate>>, topic: &str, stop: &flume::Receiver<()>) -> bool {
    let Some(gate) = fault_gate else {
        return true;
    };
    if gate.should_disconnect(topic) {
        return false;
    }
    let delay = gate.delay_ms(topic);
    if delay > 0 && !matches!(stop.recv_timeout(Duration::from_millis(delay)), Err(flume::RecvTimeoutError::Timeout)) {
        return false;
    }
    !stop.is_disconnected()
}

impl<T: Sequenced + Serialize + Send + Sync + 'static> SliceFeed<T> {
    pub fn new(topic: &'static str, initial: T) -> Self {
        let seq = initial.seq();
        let initial = Arc::new(SliceSnapshot::new(seq, 0, initial));
        let (tx, _rx) = watch::channel(initial.clone());
        Self {
            topic,
            tx,
            meta: Mutex::new(FeedMeta {
                latest: initial,
                generation: 0,
                last: None,
            }),
        }
    }

    pub fn topic(&self) -> &'static str {
        self.topic
    }

    pub fn has_watchers(&self) -> bool {
        self.tx.receiver_count() > 0
    }

    pub fn watcher_count(&self) -> usize {
        self.tx.receiver_count()
    }

    pub fn should_publish(&self, target_seq: i64, leading: bool) -> bool {
        if self.tx.receiver_count() == 0 {
            return false;
        }
        let meta = self.meta.lock();
        let now = Instant::now();
        let locale = vibevalley_i18n::locale();
        let stale_locale = meta.latest.locale != locale;
        let already_latest = meta.latest.seq >= target_seq && !stale_locale;
        let recently_sent = meta.last.is_some_and(|(sent, time)| {
            (already_latest && sent == meta.generation) || (leading && now.duration_since(time) < Duration::from_millis(STATE_EVERY_MS))
        });
        !recently_sent
    }

    pub fn replace_if_newer(&self, slice: T) {
        let seq = slice.seq();
        let locale = vibevalley_i18n::locale();
        let mut meta = self.meta.lock();
        if meta.latest.seq < seq || (meta.latest.seq == seq && meta.latest.locale != locale) {
            meta.generation += 1;
            let rev = meta.generation;
            let snap = Arc::new(SliceSnapshot::new(seq, rev, slice));
            meta.latest = snap.clone();
            if self.tx.receiver_count() == 0 {
                self.tx.send_replace(snap);
            }
        }
    }

    /// Unconditionally replaces the cached snapshot (used for live effects and fixture swaps).
    pub fn replace(&self, slice: T) {
        let seq = slice.seq();
        let mut meta = self.meta.lock();
        meta.generation += 1;
        let rev = meta.generation;
        let snap = Arc::new(SliceSnapshot::new(seq, rev, slice));
        meta.latest = snap.clone();
        if self.tx.receiver_count() == 0 {
            self.tx.send_replace(snap);
        }
    }

    pub fn snapshot(&self) -> Arc<SliceSnapshot<T>> {
        self.meta.lock().latest.clone()
    }

    pub fn publish(&self, leading: bool) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        let snap = {
            let mut meta = self.meta.lock();
            let now = Instant::now();
            let rev = meta.generation;
            if meta
                .last
                .is_some_and(|(sent, time)| sent == rev || (leading && now.duration_since(time) < Duration::from_millis(STATE_EVERY_MS)))
            {
                return;
            }
            meta.last = Some((rev, now));
            meta.latest.clone()
        };
        self.tx.send_replace(snap);
    }

    /// Wakes every watcher immediately without rate-limiting (used by fixture swaps).
    pub fn publish_forced(&self) -> usize {
        let snap = {
            let mut meta = self.meta.lock();
            meta.last = Some((meta.generation, Instant::now()));
            meta.latest.clone()
        };
        self.tx.send_replace(snap);
        self.tx.receiver_count()
    }

    /// Direct `watch::Receiver` subscription with built-in Bounded-1 coalescing
    /// and automatic disconnect cleanup on drop.
    pub fn subscribe(&self) -> watch::Receiver<Arc<SliceSnapshot<T>>> {
        self.tx.subscribe()
    }

    /// Blocks until `stop` disconnects (or `fault_gate` disconnects).
    /// If `after_seq == Some(latest_seq)` skips the initial send; otherwise delivers latest immediately.
    pub fn watch_since(
        &self,
        after_seq: Option<i64>,
        fault_gate: Option<&Arc<dyn FaultGate>>,
        stop: &flume::Receiver<()>,
        receive: &mut dyn FnMut(i64, &Value),
    ) {
        let mut rx = self.subscribe();
        let first = rx.borrow_and_update().clone();
        let mut seen_gen = first.generation;
        if after_seq != Some(first.seq) {
            if !apply_fault_gate(fault_gate, self.topic, stop) {
                return;
            }
            receive(first.seq, first.wire());
        }
        drop(first);
        while !stop.is_disconnected() {
            let changed = vibevalley_runtime::rt::block_on(async {
                tokio::select! {
                    biased;
                    _ = stop.recv_async() => false,
                    res = rx.changed() => res.is_ok(),
                }
            });
            if !changed || stop.is_disconnected() {
                break;
            }
            let latest = rx.borrow_and_update().clone();
            if latest.generation != seen_gen {
                if !apply_fault_gate(fault_gate, self.topic, stop) {
                    break;
                }
                seen_gen = latest.generation;
                receive(latest.seq, latest.wire());
            }
        }
    }

    pub fn watch(&self, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        self.watch_since(None, None, stop, receive);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc;

    use vibevalley_core::{Core, empty_space_state};
    use vibevalley_protocol::{CallState, Fact, FactCallChanged, SliceKind};

    use super::*;

    #[test]
    fn regression_a_stalled_slice_watcher_holds_one_wakeup_and_drops_its_subscription() {
        let slice = Core::new(empty_space_state()).board_slice();
        let feed = Arc::new(SliceFeed::new("slice:board", slice.clone()));
        let (stop, stopped) = flume::bounded(0);
        let (seen, received) = flume::bounded(1);
        let (release, blocked) = flume::bounded(0);
        let worker = feed.clone();
        let watch = std::thread::spawn(move || {
            worker.watch(&stopped, &mut |seq, snapshot| {
                assert_eq!(snapshot["seq"].as_i64(), Some(seq));
                seen.send(seq).unwrap();
                if seq == 0 {
                    blocked.recv().unwrap();
                }
            });
        });
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), 0);
        for seq in 1..=512 {
            feed.replace_if_newer(BoardSlice { seq, ..slice.clone() });
            feed.publish(false);
        }
        assert_eq!(feed.watcher_count(), 1);
        release.send(()).unwrap();
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), 512);
        drop(stop);
        watch.join().unwrap();
        assert_eq!(feed.watcher_count(), 0);
    }

    #[test]
    fn watch_since_skips_initial_when_after_seq_matches_and_honors_fault_gate() {
        struct Gate {
            delay: AtomicU64,
            disconnect: AtomicBool,
        }
        impl FaultGate for Gate {
            fn delay_ms(&self, _target: &str) -> u64 {
                self.delay.load(Ordering::Relaxed)
            }
            fn should_disconnect(&self, _topic: &str) -> bool {
                self.disconnect.load(Ordering::Relaxed)
            }
        }

        let base = Core::new(empty_space_state()).board_slice();
        let feed = Arc::new(SliceFeed::new("slice:board", BoardSlice { seq: 5, ..base.clone() }));
        let gate = Arc::new(Gate {
            delay: AtomicU64::new(0),
            disconnect: AtomicBool::new(false),
        });
        let fault: Arc<dyn FaultGate> = gate.clone();

        let (stop, stopped) = flume::bounded(0);
        let (tx, rx) = mpsc::channel();
        let worker = feed.clone();
        let fg = fault.clone();
        let handle = std::thread::spawn(move || {
            worker.watch_since(Some(5), Some(&fg), &stopped, &mut |seq, _| {
                let _ = tx.send(seq);
            });
        });
        assert!(rx.recv_timeout(Duration::from_millis(80)).is_err(), "matching after_seq skips initial send");

        feed.replace_if_newer(BoardSlice { seq: 6, ..base.clone() });
        feed.publish(false);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 6);

        gate.disconnect.store(true, Ordering::Relaxed);
        feed.replace_if_newer(BoardSlice { seq: 7, ..base });
        feed.publish(false);
        handle.join().unwrap();
        assert!(rx.try_recv().is_err(), "disconnected gate stops delivery");
        drop(stop);
    }

    #[test]
    fn lazy_slice_sync_builds_only_dirty_slices_and_delivers_burst_final_seq() {
        let hub = crate::Hub::new(empty_space_state());
        for n in 1..=10 {
            let fact = Fact::CallChanged(FactCallChanged {
                at: n,
                state: CallState::Idle,
                reason: format!("r{n}"),
            });
            hub.apply(vec![fact]);
        }
        assert_eq!(hub.inbox_slice().seq, 10);
        assert_eq!(crate::Server::slice_snapshot(&*hub, SliceKind::Inbox)["seq"], 10);
        assert_eq!(crate::Server::slice_snapshot(&*hub, SliceKind::Board)["seq"], 0);

        let (stop, stopped) = flume::bounded(0);
        let (tx, got) = mpsc::channel();
        let (board_tx, board_got) = mpsc::channel();
        let h1 = hub.clone();
        let h2 = hub.clone();
        let stopped1 = stopped.clone();
        let t1 = std::thread::spawn(move || {
            crate::Server::watch_slice(&*h1, SliceKind::Inbox, None, &stopped1, &mut |seq, _| {
                let _ = tx.send(seq);
            });
        });
        let t2 = std::thread::spawn(move || {
            crate::Server::watch_slice(&*h2, SliceKind::Board, None, &stopped, &mut |seq, _| {
                let _ = board_tx.send(seq);
            });
        });
        assert_eq!(got.recv_timeout(Duration::from_secs(2)).unwrap(), 10);
        assert_eq!(board_got.recv_timeout(Duration::from_secs(2)).unwrap(), 0);

        for n in 11..=20 {
            let fact = Fact::CallChanged(FactCallChanged {
                at: n,
                state: CallState::Idle,
                reason: format!("r{n}"),
            });
            hub.apply(vec![fact]);
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut last_seq = 10;
        while last_seq < 20 && Instant::now() < deadline {
            if let Ok(seq) = got.recv_timeout(Duration::from_millis(200)) {
                last_seq = seq;
            }
        }
        assert_eq!(last_seq, 20);
        assert!(board_got.try_recv().is_err(), "unrelated board slice was not kicked by CallChanged");
        drop(stop);
        t1.join().unwrap();
        t2.join().unwrap();
    }
}
