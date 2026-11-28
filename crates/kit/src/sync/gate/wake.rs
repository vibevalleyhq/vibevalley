use crate::sync::loom::{AtomicI64, AtomicU8, Ordering};

const fn mask_all(count: usize) -> u8 {
    if count >= 8 { u8::MAX } else { (1u8 << count) - 1 }
}

fn store_max(target: &AtomicI64, candidate: i64) {
    let mut current = target.load(Ordering::Acquire);
    while candidate > current {
        match target.compare_exchange_weak(current, candidate, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => break,
            Err(observed) => current = observed,
        }
    }
}

/// Lock-free dirty-bit sequence tracker, watcherless lazy-deferral mask,
/// and coalescing wakeup gate for up to 8 indexed channels (`N <= 8`).
pub struct WakeGate<const N: usize> {
    seq: AtomicI64,
    dirty_seqs: [AtomicI64; N],
    pending_mask: AtomicU8,
    deferred_lazy_mask: AtomicU8,
    demand_mask: AtomicU8,
}

impl<const N: usize> WakeGate<N> {
    pub fn new(initial_seq: i64) -> Self {
        assert!(N <= 8, "WakeGate supports at most 8 bit slots");
        Self {
            seq: AtomicI64::new(initial_seq),
            dirty_seqs: std::array::from_fn(|_| AtomicI64::new(initial_seq)),
            pending_mask: AtomicU8::new(0),
            deferred_lazy_mask: AtomicU8::new(0),
            demand_mask: AtomicU8::new(0),
        }
    }

    pub fn seq(&self) -> i64 {
        self.seq.load(Ordering::Acquire)
    }

    pub fn dirty_seq(&self, idx: usize) -> i64 {
        self.dirty_seqs[idx].load(Ordering::Acquire)
    }

    /// Records a state commit affecting `mask` and returns `(new_seq, should_wake)`.
    pub fn record_commit(&self, mask: u8) -> (i64, bool) {
        let mask = mask & mask_all(N);
        if mask == 0 {
            return (self.seq(), false);
        }
        let seq = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
        for (idx, slot) in self.dirty_seqs.iter().enumerate() {
            if (mask & (1u8 << idx)) != 0 {
                store_max(slot, seq);
            }
        }
        let prev = self.pending_mask.fetch_or(mask, Ordering::AcqRel);
        (seq, prev == 0)
    }

    pub fn mark_lazy_deferred(&self, mask: u8) {
        let mask = mask & mask_all(N);
        if mask != 0 {
            self.deferred_lazy_mask.fetch_or(mask, Ordering::AcqRel);
        }
    }

    pub fn request_demand(&self, mask: u8) -> bool {
        let mask = mask & mask_all(N);
        if mask == 0 {
            return false;
        }
        self.deferred_lazy_mask.fetch_and(!mask, Ordering::AcqRel);
        self.demand_mask.fetch_or(mask, Ordering::AcqRel);
        let prev = self.pending_mask.fetch_or(mask, Ordering::AcqRel);
        prev == 0
    }

    pub fn take_pending(&self) -> u8 {
        self.pending_mask.swap(0, Ordering::AcqRel)
    }

    pub fn take_demand(&self) -> u8 {
        self.demand_mask.swap(0, Ordering::AcqRel)
    }

    pub fn pending_bits(&self) -> u8 {
        self.pending_mask.load(Ordering::Acquire)
    }

    pub fn deferred_lazy_bits(&self) -> u8 {
        self.deferred_lazy_mask.load(Ordering::Acquire)
    }

    pub fn demand_bits(&self) -> u8 {
        self.demand_mask.load(Ordering::Acquire)
    }
}

#[cfg(all(test, feature = "loom"))]
mod loom_models {
    use loom::sync::atomic::{AtomicU64, Ordering};
    use loom::sync::{Arc, Notify};
    use loom::thread;

    use super::WakeGate;

    fn bounded_model(f: impl Fn() + Send + Sync + 'static) {
        let mut builder = loom::model::Builder::new();
        builder.max_branches = 100_000;
        builder.preemption_bound = Some(2);
        builder.check(f);
    }

    #[test]
    fn wake_gate_concurrent_commits_never_miss_wakeup() {
        bounded_model(|| {
            let gate = Arc::new(WakeGate::<6>::new(0));
            let notify = Arc::new(Notify::new());
            let payload = Arc::new(AtomicU64::new(0));

            let p1 = {
                let gate = Arc::clone(&gate);
                let notify = Arc::clone(&notify);
                let payload = Arc::clone(&payload);
                thread::spawn(move || {
                    payload.store(0xA1, Ordering::Relaxed);
                    let (seq, wake) = gate.record_commit(1 << 0);
                    if wake {
                        notify.notify();
                    }
                    seq
                })
            };

            let p2 = {
                let gate = Arc::clone(&gate);
                let notify = Arc::clone(&notify);
                thread::spawn(move || {
                    let (seq, wake) = gate.record_commit(1 << 0);
                    if wake {
                        notify.notify();
                    }
                    seq
                })
            };

            let consumer = {
                let gate = Arc::clone(&gate);
                let notify = Arc::clone(&notify);
                let payload = Arc::clone(&payload);
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
                            assert!(dirty >= published);
                            published = dirty;
                        }
                    }
                    assert_eq!(payload.load(Ordering::Relaxed), 0xA1);
                    published
                })
            };

            let s1 = p1.join().unwrap();
            let s2 = p2.join().unwrap();
            let published = consumer.join().unwrap();
            assert_eq!(s1.max(s2), 2);
            assert_eq!(published, 2);
            assert_eq!(gate.dirty_seq(0), 2);
        });
    }
}
