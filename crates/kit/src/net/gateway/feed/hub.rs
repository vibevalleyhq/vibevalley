use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

use super::channel::{FeedChannel, FeedSubscription};
use crate::sync::WakeGate;
use crate::task::TaskGroup;

/// Fixed-cardinality (`N <= 8`) feed channel descriptor implemented by host domains.
pub trait FeedKey: Copy + Eq + Send + Sync + 'static {
    const COUNT: usize;
    fn all() -> &'static [Self];
    fn index(self) -> usize;
    fn topic(self) -> &'static str;
    fn name(self) -> &'static str;

    /// When `true`, leading-edge publications are deferred so rapid bursts coalesce
    /// across the configured throttle window.
    fn coalesce_leading(self) -> bool {
        false
    }

    /// When `true`, [`FeedHub`] publishes even if `seq` did not strictly increase.
    fn allow_same_seq_publish(self) -> bool {
        false
    }
}

const fn mask_all(count: usize) -> u8 {
    if count >= 8 { u8::MAX } else { (1u8 << count) - 1 }
}

/// Generic single-flight dirty-mask coalescer, watcherless lazy-deferral gate,
/// and multi-channel subscriber fan-out hub.
pub struct FeedHub<K: FeedKey, const N: usize> {
    channels: [Arc<FeedChannel>; N],
    gate: WakeGate<N>,
    notify: Notify,
    flush_notify: Notify,
    throttle: Duration,
    last_published: Mutex<[Option<Instant>; N]>,
    running: AtomicBool,
    cycle_tx: watch::Sender<u64>,
    dirty_tx: watch::Sender<i64>,
    _marker: std::marker::PhantomData<K>,
}

impl<K: FeedKey, const N: usize> FeedHub<K, N> {
    pub fn new(throttle: Duration, mut init: impl FnMut(K) -> (i64, Arc<str>)) -> Self {
        assert_eq!(K::COUNT, N, "FeedHub const N must equal K::COUNT");
        assert!(N <= 8, "FeedHub supports at most 8 channels");
        let all = K::all();
        assert_eq!(all.len(), N, "FeedKey::all() length must equal N");
        let channels = std::array::from_fn(|idx| {
            let key = all[idx];
            assert_eq!(key.index(), idx, "FeedKey::all() must be ordered by index()");
            let (seq, payload) = init(key);
            Arc::new(FeedChannel::new(key.topic(), seq, payload))
        });
        let (cycle_tx, _) = watch::channel(0u64);
        let (dirty_tx, _) = watch::channel(0i64);
        Self {
            channels,
            gate: WakeGate::new(0),
            notify: Notify::new(),
            flush_notify: Notify::new(),
            throttle,
            last_published: Mutex::new([None; N]),
            running: AtomicBool::new(false),
            cycle_tx,
            dirty_tx,
            _marker: std::marker::PhantomData,
        }
    }

    pub fn seq(&self) -> i64 {
        self.gate.seq()
    }

    pub fn dirty_seq(&self, key: K) -> i64 {
        self.gate.dirty_seq(key.index())
    }

    pub fn channel(&self, key: K) -> &FeedChannel {
        &self.channels[key.index()]
    }

    pub fn channel_arc(&self, key: K) -> Arc<FeedChannel> {
        Arc::clone(&self.channels[key.index()])
    }

    pub fn snapshot(&self, key: K) -> Arc<str> {
        self.channel(key).snapshot()
    }

    pub fn seqs(&self) -> BTreeMap<String, i64> {
        K::all().iter().map(|&k| (k.name().to_string(), self.channel(k).seq())).collect()
    }

    pub fn watcher_counts(&self) -> BTreeMap<String, u32> {
        K::all()
            .iter()
            .map(|&k| (k.name().to_string(), self.channel(k).watcher_count() as u32))
            .collect()
    }

    pub fn has_unprojected_dirty(&self) -> bool {
        self.gate.pending_bits() != 0
            || self.gate.deferred_lazy_bits() != 0
            || self.gate.demand_bits() != 0
            || K::all().iter().any(|&k| self.channel(k).seq() < self.dirty_seq(k))
    }

    pub fn subscribe_payload(&self, key: K) -> watch::Receiver<Arc<str>> {
        let rx = self.channel(key).subscribe_payload();
        self.wake_if_stale(key);
        rx
    }

    pub fn subscribe(&self, key: K) -> FeedSubscription {
        let sub = self.channel(key).subscribe();
        self.wake_if_stale(key);
        sub
    }

    pub fn subscribe_dirty(&self) -> watch::Receiver<i64> {
        self.dirty_tx.subscribe()
    }

    pub fn subscribe_cycles(&self) -> watch::Receiver<u64> {
        self.cycle_tx.subscribe()
    }

    /// Marks the bitmask `mask_bits` dirty, advances the monotonic global `seq`,
    /// updates per-channel dirty watermarks, and wakes the projector loop.
    pub fn mark_dirty_bits(&self, mask_bits: u8) -> i64 {
        let (seq, should_wake) = self.gate.record_commit(mask_bits);
        let _ = self.dirty_tx.send_replace(seq);
        if should_wake || (mask_bits & mask_all(N)) != 0 {
            self.notify.notify_one();
        }
        seq
    }

    /// Marks all `keys` dirty in a single atomic commit.
    pub fn mark_dirty(&self, keys: impl IntoIterator<Item = K>) -> i64 {
        let mut bits = 0u8;
        for key in keys {
            bits |= 1u8 << key.index();
        }
        self.mark_dirty_bits(bits)
    }

    fn wake_if_stale(&self, key: K) {
        let bit = 1u8 << key.index();
        let deferred = (self.gate.deferred_lazy_bits() & bit) != 0;
        if deferred || self.channel(key).seq() < self.dirty_seq(key) {
            self.gate.request_demand(bit);
            self.notify.notify_one();
        }
    }

    /// Spawns a single-flight per-key projector worker on `task`.
    pub fn start<F, Fut, E>(self: &Arc<Self>, task: &TaskGroup, worker_name: &'static str, projector: F)
    where
        F: FnMut(K, i64) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Arc<str>, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        let projector = Arc::new(tokio::sync::Mutex::new(projector));
        self.start_batch(task, worker_name, move |batch| {
            let projector = Arc::clone(&projector);
            async move {
                let mut out = Vec::with_capacity(batch.len());
                let mut f = projector.lock().await;
                for (key, seq) in batch {
                    out.push((key, seq, f(key, seq).await));
                }
                out
            }
        });
    }

    /// Spawns a single-flight batch projector worker on `task`.
    pub fn start_batch<F, Fut, E>(self: &Arc<Self>, task: &TaskGroup, worker_name: &'static str, mut projector: F)
    where
        F: FnMut(Vec<(K, i64)>) -> Fut + Send + 'static,
        Fut: Future<Output = Vec<(K, i64, Result<Arc<str>, E>)>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        self.running.store(true, Ordering::Release);
        let this = Arc::clone(self);
        let cancel = task.token();
        task.spawn_named(worker_name, async move {
            struct RunningGuard<K: FeedKey, const N: usize>(Arc<FeedHub<K, N>>);
            impl<K: FeedKey, const N: usize> Drop for RunningGuard<K, N> {
                fn drop(&mut self) {
                    self.0.running.store(false, Ordering::Release);
                    self.0.cycle_tx.send_modify(|c| *c += 1);
                }
            }
            let _guard = RunningGuard(Arc::clone(&this));

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

                let mut ready: Vec<(K, i64)> = Vec::new();
                let mut ready_record_throttle = 0u8;
                let mut deferred_throttle = 0u8;
                let mut lazy_skip = 0u8;

                for &key in K::all() {
                    let bit = 1u8 << key.index();
                    if (work & bit) == 0 {
                        continue;
                    }
                    let is_demanded = (demanded & bit) != 0;
                    if !is_demanded && !this.channel(key).has_watchers() {
                        lazy_skip |= bit;
                        continue;
                    }
                    let target_seq = this.dirty_seq(key);
                    if this.channel(key).seq() >= target_seq {
                        continue;
                    }
                    if is_demanded || this.can_publish_leading(key) {
                        ready.push((key, target_seq));
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
                    let mut trailing_ready: Vec<(K, i64)> = Vec::new();
                    let mut trailing_record_throttle = 0u8;
                    let mut trailing_lazy = 0u8;
                    for &key in K::all() {
                        let bit = 1u8 << key.index();
                        if (trailing & bit) == 0 {
                            continue;
                        }
                        let is_demanded = (trailing_demanded & bit) != 0 || (deferred_throttle & bit) != 0;
                        if !is_demanded && !this.channel(key).has_watchers() {
                            trailing_lazy |= bit;
                            continue;
                        }
                        let target_seq = this.dirty_seq(key);
                        if this.channel(key).seq() >= target_seq {
                            continue;
                        }
                        trailing_ready.push((key, target_seq));
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
    /// and waits until all currently dirty channels are projected or the worker stops.
    pub async fn flush(&self) {
        if !self.running.load(Ordering::Acquire) {
            return;
        }
        let mut cycle_rx = self.cycle_tx.subscribe();
        let _ = *cycle_rx.borrow_and_update();

        let mut need_mask = self.gate.pending_bits() | self.gate.deferred_lazy_bits();
        for &key in K::all() {
            if self.channel(key).seq() < self.dirty_seq(key) {
                need_mask |= 1u8 << key.index();
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
            let all_synced = K::all().iter().all(|&k| self.channel(k).seq() >= self.dirty_seq(k));
            if pending == 0 && demanded == 0 && all_synced {
                break;
            }
            if cycle_rx.changed().await.is_err() {
                break;
            }
            let mut late_mask = self.gate.deferred_lazy_bits();
            for &key in K::all() {
                if self.channel(key).seq() < self.dirty_seq(key) {
                    late_mask |= 1u8 << key.index();
                }
            }
            if late_mask != 0 {
                self.gate.request_demand(late_mask);
                self.flush_notify.notify_one();
                self.notify.notify_one();
            }
        }
    }

    fn can_publish_leading(&self, key: K) -> bool {
        if self.throttle.is_zero() {
            return true;
        }
        if key.coalesce_leading() {
            return false;
        }
        let last = self.last_published.lock()[key.index()];
        match last {
            None => true,
            Some(at) => Instant::now().duration_since(at) >= self.throttle,
        }
    }

    async fn project_batch<F, Fut, E>(&self, projector: &mut F, batch: Vec<(K, i64)>, record_throttle_mask: u8)
    where
        F: FnMut(Vec<(K, i64)>) -> Fut + Send + 'static,
        Fut: Future<Output = Vec<(K, i64, Result<Arc<str>, E>)>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        let results = projector(batch).await;
        let now = Instant::now();
        for (key, target_seq, outcome) in results {
            let channel = self.channel(key);
            match outcome {
                Ok(payload) => {
                    if key.allow_same_seq_publish() {
                        channel.publish(target_seq, payload);
                    } else {
                        channel.publish_if_newer(target_seq, payload);
                    }
                    if (record_throttle_mask & (1u8 << key.index())) != 0 {
                        self.last_published.lock()[key.index()] = Some(now);
                    }
                }
                Err(err) => {
                    tracing::warn!(channel = key.name(), seq = target_seq, error = %err, "feed.project failed");
                }
            }
        }
    }
}

#[cfg(all(test, not(feature = "loom")))]
mod tests {
    use futures_util::StreamExt;

    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TestTopic {
        Alpha,
        Beta,
    }

    impl FeedKey for TestTopic {
        const COUNT: usize = 2;

        fn all() -> &'static [Self] {
            &[Self::Alpha, Self::Beta]
        }

        fn index(self) -> usize {
            match self {
                Self::Alpha => 0,
                Self::Beta => 1,
            }
        }

        fn topic(self) -> &'static str {
            match self {
                Self::Alpha => "topic:alpha",
                Self::Beta => "topic:beta",
            }
        }

        fn name(self) -> &'static str {
            match self {
                Self::Alpha => "alpha",
                Self::Beta => "beta",
            }
        }
    }

    #[tokio::test]
    async fn feed_hub_coalesces_dirty_marks_defers_watcherless_and_flushes() {
        let task = TaskGroup::new();
        let hub = Arc::new(FeedHub::<TestTopic, 2>::new(Duration::ZERO, |_| (0, Arc::<str>::from("{}"))));
        let seen = Arc::new(Mutex::new(Vec::<Vec<(TestTopic, i64)>>::new()));
        let seen_c = Arc::clone(&seen);

        hub.start_batch(&task, "test.feed", move |batch| {
            let seen = Arc::clone(&seen_c);
            async move {
                seen.lock().push(batch.clone());
                batch
                    .into_iter()
                    .map(|(k, seq)| (k, seq, Ok::<_, String>(Arc::<str>::from(format!("{{\"seq\":{seq}}}")))))
                    .collect()
            }
        });

        let mut alpha_sub = hub.subscribe(TestTopic::Alpha);
        assert_eq!(alpha_sub.borrow_and_update().seq, 0);

        assert_eq!(hub.mark_dirty([TestTopic::Alpha, TestTopic::Beta]), 1);
        assert!(alpha_sub.changed().await);
        assert_eq!(alpha_sub.borrow_and_update().seq, 1);

        tokio::task::yield_now().await;
        assert_eq!(hub.channel(TestTopic::Beta).seq(), 0);

        hub.flush().await;
        assert_eq!(hub.channel(TestTopic::Beta).seq(), 1);

        let mut stream = hub.subscribe(TestTopic::Alpha).into_watch_stream(None, |s| Arc::from(format!("init:{s}")));
        let (seq, first) = stream.next().await.unwrap();
        assert_eq!(seq, 1);
        assert_eq!(&*first, "init:{\"seq\":1}");

        assert!(task.shutdown(Duration::from_secs(1)).await);
    }
}
