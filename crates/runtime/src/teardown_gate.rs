//! Three-state serialized idempotent teardown gate (`ARMED -> TERMINATING -> TERMINATED`).
//!
//! Ensures concurrent callers never invoke the teardown closure simultaneously,
//! never observe a premature `Ok(())` while an in-flight teardown may still fail
//! and roll back, and never invoke the closure again once any attempt succeeds.

use std::fmt;

use crate::loom_sync::{AtomicU8, Condvar, Mutex, Ordering};

const ARMED: u8 = 0;
const TERMINATING: u8 = 1;
const TERMINATED: u8 = 2;

/// Serializes idempotent teardown with rollback on failure or unwind.
pub(crate) struct TeardownGate {
    /// Lock-free mirror of the current 3-state value for fast-path reads.
    state: AtomicU8,
    /// Coordinates state transitions and blocks concurrent callers while `TERMINATING`.
    mu: Mutex<u8>,
    cv: Condvar,
}

impl TeardownGate {
    pub(crate) fn new() -> Self {
        Self {
            state: AtomicU8::new(ARMED),
            mu: Mutex::new(ARMED),
            cv: Condvar::new(),
        }
    }

    pub(crate) fn is_terminated(&self) -> bool {
        self.state.load(Ordering::Acquire) == TERMINATED
    }

    /// Runs `f` at most once to completion.
    ///
    /// - If already `TERMINATED`, returns `Ok(())` immediately without running `f`.
    /// - If another caller is currently `TERMINATING`, waits until that attempt either
    ///   commits `TERMINATED` (returns `Ok(())`) or rolls back to `ARMED` (retries with `f`).
    /// - If `f` returns `Err` or unwinds, rolls the gate back to `ARMED` and wakes waiters.
    pub(crate) fn teardown_once<E>(&self, f: impl FnOnce() -> Result<(), E>) -> Result<(), E> {
        if self.state.load(Ordering::Acquire) == TERMINATED {
            return Ok(());
        }

        let mut guard = self.mu.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match *guard {
                TERMINATED => return Ok(()),
                TERMINATING => {
                    guard = self.cv.wait(guard).unwrap_or_else(|e| e.into_inner());
                }
                ARMED => {
                    *guard = TERMINATING;
                    self.state.store(TERMINATING, Ordering::Release);
                    break;
                }
                _ => unreachable!("invalid TeardownGate state"),
            }
        }
        drop(guard);

        let mut rollback = RollbackGuard { gate: self, committed: false };
        match f() {
            Ok(()) => {
                let mut guard = self.mu.lock().unwrap_or_else(|e| e.into_inner());
                *guard = TERMINATED;
                self.state.store(TERMINATED, Ordering::Release);
                rollback.committed = true;
                drop(guard);
                self.cv.notify_all();
                Ok(())
            }
            Err(err) => {
                // `RollbackGuard::drop` restores `ARMED` and wakes waiting callers.
                drop(rollback);
                Err(err)
            }
        }
    }
}

impl Default for TeardownGate {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for TeardownGate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self.state.load(Ordering::Acquire) {
            ARMED => "Armed",
            TERMINATING => "Terminating",
            TERMINATED => "Terminated",
            other => return f.debug_tuple("TeardownGate").field(&other).finish(),
        };
        f.debug_tuple("TeardownGate").field(&label).finish()
    }
}

struct RollbackGuard<'a> {
    gate: &'a TeardownGate,
    committed: bool,
}

impl Drop for RollbackGuard<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut guard = self.gate.mu.lock().unwrap_or_else(|e| e.into_inner());
        *guard = ARMED;
        self.gate.state.store(ARMED, Ordering::Release);
        drop(guard);
        self.gate.cv.notify_all();
    }
}

#[cfg(all(test, feature = "loom"))]
mod loom_models {
    use loom::sync::Arc;
    use loom::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use loom::thread;

    use super::TeardownGate;

    #[test]
    fn concurrent_teardown_both_succeed_runs_exactly_once() {
        loom::model(|| {
            let gate = Arc::new(TeardownGate::new());
            let active = Arc::new(AtomicUsize::new(0));
            let calls = Arc::new(AtomicUsize::new(0));
            let succeeded = Arc::new(AtomicBool::new(false));

            let run = |gate: Arc<TeardownGate>, active: Arc<AtomicUsize>, calls: Arc<AtomicUsize>, succeeded: Arc<AtomicBool>| {
                thread::spawn(move || {
                    let res: Result<(), ()> = gate.teardown_once(|| {
                        assert_eq!(active.fetch_add(1, Ordering::AcqRel), 0, "concurrent terminate invocation");
                        calls.fetch_add(1, Ordering::AcqRel);
                        succeeded.store(true, Ordering::Release);
                        assert_eq!(active.fetch_sub(1, Ordering::AcqRel), 1);
                        Ok(())
                    });
                    assert!(res.is_ok());
                    assert!(succeeded.load(Ordering::Acquire), "caller observed Ok before terminate succeeded");
                })
            };

            let t1 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            let t2 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            t1.join().unwrap();
            t2.join().unwrap();

            assert_eq!(calls.load(Ordering::Acquire), 1);
            assert!(gate.is_terminated());

            // Subsequent calls after TERMINATED must never execute the closure again.
            let extra: Result<(), ()> = gate.teardown_once(|| {
                calls.fetch_add(1, Ordering::AcqRel);
                Ok(())
            });
            assert!(extra.is_ok());
            assert_eq!(calls.load(Ordering::Acquire), 1);
        });
    }

    #[test]
    fn concurrent_teardown_first_fails_second_retries_and_succeeds() {
        loom::model(|| {
            let gate = Arc::new(TeardownGate::new());
            let active = Arc::new(AtomicUsize::new(0));
            let calls = Arc::new(AtomicUsize::new(0));
            let succeeded = Arc::new(AtomicBool::new(false));

            let run = |gate: Arc<TeardownGate>, active: Arc<AtomicUsize>, calls: Arc<AtomicUsize>, succeeded: Arc<AtomicBool>| {
                thread::spawn(move || {
                    let res: Result<(), &'static str> = gate.teardown_once(|| {
                        assert_eq!(active.fetch_add(1, Ordering::AcqRel), 0, "concurrent terminate invocation");
                        let n = calls.fetch_add(1, Ordering::AcqRel);
                        let out = if n == 0 {
                            Err("transient failure")
                        } else {
                            succeeded.store(true, Ordering::Release);
                            Ok(())
                        };
                        assert_eq!(active.fetch_sub(1, Ordering::AcqRel), 1);
                        out
                    });
                    if res.is_ok() {
                        assert!(succeeded.load(Ordering::Acquire), "caller observed Ok without a successful terminate");
                    }
                    res.is_ok()
                })
            };

            let t1 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            let t2 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            let ok1 = t1.join().unwrap();
            let ok2 = t2.join().unwrap();

            assert_eq!(calls.load(Ordering::Acquire), 2);
            assert_eq!(
                usize::from(ok1) + usize::from(ok2),
                1,
                "exactly one caller fails and the waiter succeeds on retry"
            );
            assert!(gate.is_terminated());
        });
    }

    #[test]
    fn concurrent_teardown_both_fail_never_returns_ok_and_stays_armed() {
        loom::model(|| {
            let gate = Arc::new(TeardownGate::new());
            let active = Arc::new(AtomicUsize::new(0));
            let calls = Arc::new(AtomicUsize::new(0));

            let run = |gate: Arc<TeardownGate>, active: Arc<AtomicUsize>, calls: Arc<AtomicUsize>| {
                thread::spawn(move || {
                    let res: Result<(), &'static str> = gate.teardown_once(|| {
                        assert_eq!(active.fetch_add(1, Ordering::AcqRel), 0, "concurrent terminate invocation");
                        calls.fetch_add(1, Ordering::AcqRel);
                        assert_eq!(active.fetch_sub(1, Ordering::AcqRel), 1);
                        Err("persistent failure")
                    });
                    assert!(res.is_err(), "no caller may observe Ok when every terminate call fails");
                })
            };

            let t1 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls));
            let t2 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls));
            t1.join().unwrap();
            t2.join().unwrap();

            assert_eq!(calls.load(Ordering::Acquire), 2);
            assert!(!gate.is_terminated());

            // Gate remains ARMED so a later retry can still succeed and seal it.
            let final_res: Result<(), &'static str> = gate.teardown_once(|| {
                calls.fetch_add(1, Ordering::AcqRel);
                Ok(())
            });
            assert!(final_res.is_ok());
            assert_eq!(calls.load(Ordering::Acquire), 3);
            assert!(gate.is_terminated());
        });
    }
}
