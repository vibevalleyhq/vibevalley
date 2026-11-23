//! Bounded-1 coalescing feed for a single state slice (`board`, `sessions`,
//! `collab`, `inbox`, `ops`, `farm`).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use vibevalley_protocol::{BoardSlice, CollabSlice, FarmFrame, InboxSlice, OpsSlice, STATE_EVERY_MS, SessionsSlice};

use crate::lock;
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
}

impl<T: Serialize> SliceSnapshot<T> {
    fn new(seq: i64, generation: u64, slice: T) -> Self {
        Self {
            seq,
            generation,
            slice: Arc::new(slice),
            locale: vibevalley_i18n::locale(),
            wire: OnceLock::new(),
        }
    }

    pub fn wire(&self) -> &Value {
        self.wire.get_or_init(|| serde_json::to_value(self.slice.as_ref()).expect("slice serializes"))
    }
}

pub struct SliceFeed<T> {
    topic: &'static str,
    inner: Mutex<Published<T>>,
}

struct Published<T> {
    latest: Arc<SliceSnapshot<T>>,
    generation: u64,
    watchers: Vec<flume::Sender<()>>,
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
        Self {
            topic,
            inner: Mutex::new(Published {
                latest: Arc::new(SliceSnapshot::new(seq, 0, initial)),
                generation: 0,
                watchers: vec![],
                last: None,
            }),
        }
    }

    pub fn topic(&self) -> &'static str {
        self.topic
    }

    pub fn has_watchers(&self) -> bool {
        let mut current = lock(&self.inner);
        current.watchers.retain(|tx| !tx.is_disconnected());
        !current.watchers.is_empty()
    }

    pub fn watcher_count(&self) -> usize {
        let mut current = lock(&self.inner);
        current.watchers.retain(|tx| !tx.is_disconnected());
        current.watchers.len()
    }

    pub fn should_publish(&self, target_seq: i64, leading: bool) -> bool {
        let current = lock(&self.inner);
        if current.watchers.is_empty() {
            return false;
        }
        let now = Instant::now();
        let locale = vibevalley_i18n::locale();
        let stale_locale = current.latest.locale != locale;
        let already_latest = current.latest.seq >= target_seq && !stale_locale;
        let recently_sent = current.last.is_some_and(|(sent, time)| {
            (already_latest && sent == current.generation) || (leading && now.duration_since(time) < Duration::from_millis(STATE_EVERY_MS))
        });
        !recently_sent
    }

    pub fn replace_if_newer(&self, slice: T) {
        let seq = slice.seq();
        let locale = vibevalley_i18n::locale();
        let mut current = lock(&self.inner);
        if current.latest.seq < seq || (current.latest.seq == seq && current.latest.locale != locale) {
            current.generation += 1;
            let rev = current.generation;
            current.latest = Arc::new(SliceSnapshot::new(seq, rev, slice));
        }
    }

    /// Unconditionally replaces the cached snapshot (used for live effects and fixture swaps).
    pub fn replace(&self, slice: T) {
        let seq = slice.seq();
        let mut current = lock(&self.inner);
        current.generation += 1;
        let rev = current.generation;
        current.latest = Arc::new(SliceSnapshot::new(seq, rev, slice));
    }

    pub fn snapshot(&self) -> Arc<SliceSnapshot<T>> {
        lock(&self.inner).latest.clone()
    }

    pub fn publish(&self, leading: bool) {
        let mut current = lock(&self.inner);
        let now = Instant::now();
        let rev = current.generation;
        if current.watchers.is_empty()
            || current
                .last
                .is_some_and(|(sent, time)| sent == rev || (leading && now.duration_since(time) < Duration::from_millis(STATE_EVERY_MS)))
        {
            return;
        }
        current.last = Some((rev, now));
        current
            .watchers
            .retain(|tx| !matches!(tx.try_send(()), Err(flume::TrySendError::Disconnected(_))));
    }

    /// Wakes every watcher immediately without rate-limiting (used by fixture swaps).
    pub fn publish_forced(&self) -> usize {
        let mut current = lock(&self.inner);
        current.last = Some((current.generation, Instant::now()));
        current
            .watchers
            .retain(|tx| !matches!(tx.try_send(()), Err(flume::TrySendError::Disconnected(_))));
        current.watchers.len()
    }

    /// Registers a bounded-1 wakeup signal channel for internal observers.
    pub fn subscribe_signal(&self, initial: bool) -> flume::Receiver<()> {
        let (tx, rx) = flume::bounded(1);
        if initial {
            let _ = tx.try_send(());
        }
        lock(&self.inner).watchers.push(tx);
        rx
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
        let (tx, rx) = flume::bounded(1);
        let first = {
            let mut current = lock(&self.inner);
            current.watchers.push(tx.clone());
            current.latest.clone()
        };
        let mut seen_gen = first.generation;
        if after_seq != Some(first.seq) {
            if !apply_fault_gate(fault_gate, self.topic, stop) {
                lock(&self.inner).watchers.retain(|w| !w.same_channel(&tx));
                return;
            }
            receive(first.seq, first.wire());
        }
        drop(first);
        while !stop.is_disconnected() && flume::Selector::new().recv(stop, |_| false).recv(&rx, |r| r.is_ok()).wait() {
            if stop.is_disconnected() {
                break;
            }
            let latest = self.snapshot();
            if latest.generation != seen_gen {
                if !apply_fault_gate(fault_gate, self.topic, stop) {
                    break;
                }
                seen_gen = latest.generation;
                receive(latest.seq, latest.wire());
            }
        }
        lock(&self.inner).watchers.retain(|w| !w.same_channel(&tx));
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
        {
            let state = lock(&feed.inner);
            assert_eq!(state.watchers[0].capacity(), Some(1));
            assert_eq!(state.watchers[0].len(), 1);
        }
        release.send(()).unwrap();
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), 512);
        drop(stop);
        watch.join().unwrap();
        assert!(lock(&feed.inner).watchers.is_empty());
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
