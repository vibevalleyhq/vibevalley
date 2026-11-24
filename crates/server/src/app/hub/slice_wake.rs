//! Lock-free dirty-slice sequence tracker and coalescing wakeup gate for [`crate::Hub`].
//!
//! Replaces per-commit heap allocations on `flume::Sender<Kick>` with an atomic bitmask
//! (`pending_mask`) and per-slice monotonic sequence watermarks (`dirty_seqs`) paired with
//! a binary wake notification (`tokio::sync::Notify` in production, `loom::sync::Notify`
//! under model checking).

use crate::app::hub::loom_sync::{AtomicI64, AtomicU8, Ordering};

/// Number of domain slices tracked by [`SliceWakeGate`] (`board`, `sessions`,
/// `collab`, `inbox`, `ops`, `farm`).
pub(crate) const SLICE_COUNT: usize = 6;

/// Bitmask covering all [`SLICE_COUNT`] domain slices.
pub(crate) const SLICE_MASK_ALL: u8 = (1 << SLICE_COUNT) - 1;

/// Tracks the Hub's global commit sequence, per-slice dirty sequence watermarks,
/// and coalesced wakeup bitmask without heap allocation.
pub(crate) struct SliceWakeGate {
    seq: AtomicI64,
    dirty_seqs: [AtomicI64; SLICE_COUNT],
    pending_mask: AtomicU8,
}

impl SliceWakeGate {
    /// Creates a gate initialized at `initial_seq` with no pending slices.
    pub(crate) fn new(initial_seq: i64) -> Self {
        Self {
            seq: AtomicI64::new(initial_seq),
            dirty_seqs: std::array::from_fn(|_| AtomicI64::new(initial_seq)),
            pending_mask: AtomicU8::new(0),
        }
    }

    /// Latest committed global sequence number.
    pub(crate) fn seq(&self) -> i64 {
        self.seq.load(Ordering::Acquire)
    }

    /// Latest committed sequence number that dirtied slice `idx`.
    pub(crate) fn dirty_seq(&self, idx: usize) -> i64 {
        self.dirty_seqs[idx].load(Ordering::Acquire)
    }

    /// Records a state commit affecting the slices in `mask`.
    ///
    /// Returns `(seq, should_wake)`, where `should_wake` is `true` iff `pending_mask`
    /// transitioned from `0` to non-zero and the caller must signal the paired notifier.
    pub(crate) fn record_commit(&self, mask: u8) -> (i64, bool) {
        let mask = mask & SLICE_MASK_ALL;
        let seq = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
        if mask == 0 {
            return (seq, false);
        }
        for (idx, slot) in self.dirty_seqs.iter().enumerate() {
            if (mask & (1u8 << idx)) != 0 {
                store_max(slot, seq);
            }
        }
        let prev = self.pending_mask.fetch_or(mask, Ordering::AcqRel);
        (seq, prev == 0)
    }

    /// Atomically drains and clears all currently pending slice bits.
    pub(crate) fn take_pending(&self) -> u8 {
        self.pending_mask.swap(0, Ordering::AcqRel)
    }
}

/// Monotonically advances `slot` to at least `val` so concurrent producers can never
/// regress a slice's dirty watermark even without an external lock.
fn store_max(slot: &AtomicI64, val: i64) {
    let mut cur = slot.load(Ordering::Acquire);
    while val > cur {
        match slot.compare_exchange(cur, val, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => break,
            Err(actual) => cur = actual,
        }
    }
}

#[cfg(all(test, not(feature = "loom")))]
mod tests {
    use super::{SLICE_COUNT, SliceWakeGate};

    #[test]
    fn record_commit_coalesces_wake_and_tracks_dirty_seqs() {
        let gate = SliceWakeGate::new(0);
        assert_eq!(gate.seq(), 0);
        assert_eq!(gate.take_pending(), 0);

        let (seq1, wake1) = gate.record_commit(1 << 0);
        assert_eq!(seq1, 1);
        assert!(wake1, "0 -> non-zero transition must wake pump");

        let (seq2, wake2) = gate.record_commit((1 << 0) | (1 << 3));
        assert_eq!(seq2, 2);
        assert!(!wake2, "non-zero -> non-zero coalesces wakeup");

        let (seq3, wake3) = gate.record_commit(0);
        assert_eq!(seq3, 3);
        assert!(!wake3, "empty mask never wakes pump");

        assert_eq!(gate.take_pending(), (1 << 0) | (1 << 3));
        assert_eq!(gate.dirty_seq(0), 2);
        assert_eq!(gate.dirty_seq(3), 2);
        for idx in [1, 2, 4, 5] {
            assert!(idx < SLICE_COUNT);
            assert_eq!(gate.dirty_seq(idx), 0);
        }

        let (seq4, wake4) = gate.record_commit(1 << 5);
        assert_eq!(seq4, 4);
        assert!(wake4, "commit after drain must wake pump again");
        assert_eq!(gate.take_pending(), 1 << 5);
        assert_eq!(gate.dirty_seq(5), 4);
    }
}

#[cfg(all(test, feature = "loom"))]
mod loom_models {
    use loom::model::Builder;
    use loom::sync::Notify;
    use loom::sync::atomic::{AtomicU64, Ordering};
    use loom::thread;

    use super::{SLICE_COUNT, SliceWakeGate};
    use crate::app::hub::loom_sync::Arc;

    fn bounded_model(f: impl Fn() + Sync + Send + 'static) {
        let mut builder = Builder::new();
        builder.preemption_bound = Some(2);
        builder.check(f);
    }

    #[test]
    fn no_lost_wakeup_disjoint_slices_two_producers_one_consumer() {
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
                    let (seq, should_wake) = gate.record_commit(1 << 1);
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
                    let mut published = [0i64; SLICE_COUNT];
                    while published[0] == 0 || published[1] == 0 {
                        let mask = gate.take_pending();
                        if mask == 0 {
                            notify.wait();
                            continue;
                        }
                        for (idx, pub_seq) in published.iter_mut().enumerate() {
                            if (mask & (1u8 << idx)) != 0 {
                                let dirty = gate.dirty_seq(idx);
                                assert!(dirty > 0, "dirty_seq({idx}) must reflect commit before bit was published");
                                assert!(dirty >= *pub_seq, "dirty_seq({idx}) must be monotonic");
                                *pub_seq = dirty;
                            }
                        }
                    }
                    published
                })
            };

            let seq1 = p1.join().unwrap();
            let seq2 = p2.join().unwrap();
            let published = consumer.join().unwrap();

            assert_eq!(gate.seq(), 2);
            assert_eq!(gate.take_pending(), 0);
            assert!(published[0] >= seq1 && published[0] >= gate.dirty_seq(0));
            assert!(published[1] >= seq2 && published[1] >= gate.dirty_seq(1));
        });
    }

    #[test]
    fn no_lost_wakeup_overlapping_slice_monotonic_visibility() {
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

            // A producer with an older seq may finish its `fetch_or` after the consumer
            // already observed the newer seq=2 and exited; draining that harmless extra bit
            // must leave `dirty_seq(0)` monotonic at 2 and `pending_mask == 0`.
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
}
