//! Three-state serialized idempotent teardown gate (`ARMED -> TERMINATING -> TERMINATED`).

#[cfg(feature = "loom")]
use std::fmt;

#[cfg(feature = "loom")]
use crate::sync::loom::{AtomicU8, Condvar, Mutex, Ordering};

const ARMED: u8 = 0;
const TERMINATING: u8 = 1;
const TERMINATED: u8 = 2;

/// Serializes idempotent teardown with rollback on failure or unwind (sync / loom kernel).
#[cfg(feature = "loom")]
pub struct TeardownGate {
    state: AtomicU8,
    mu: Mutex<u8>,
    cv: Condvar,
}

#[cfg(feature = "loom")]
impl TeardownGate {
    pub fn new() -> Self {
        Self {
            state: AtomicU8::new(ARMED),
            mu: Mutex::new(ARMED),
            cv: Condvar::new(),
        }
    }

    pub fn is_terminated(&self) -> bool {
        self.state.load(Ordering::Acquire) == TERMINATED
    }

    pub fn teardown_once<E>(&self, f: impl FnOnce() -> Result<(), E>) -> Result<(), E> {
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
                drop(rollback);
                Err(err)
            }
        }
    }
}

#[cfg(feature = "loom")]
impl Default for TeardownGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "loom")]
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

#[cfg(feature = "loom")]
struct RollbackGuard<'a> {
    gate: &'a TeardownGate,
    committed: bool,
}

#[cfg(feature = "loom")]
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

/// Async three-state serialized idempotent teardown gate (`ARMED -> TERMINATING -> TERMINATED`).
pub struct AsyncTeardownGate {
    state: std::sync::atomic::AtomicU8,
    mu: parking_lot::Mutex<u8>,
    notify: tokio::sync::Notify,
}

impl AsyncTeardownGate {
    pub fn new() -> Self {
        Self {
            state: std::sync::atomic::AtomicU8::new(ARMED),
            mu: parking_lot::Mutex::new(ARMED),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub fn is_terminated(&self) -> bool {
        self.state.load(std::sync::atomic::Ordering::Acquire) == TERMINATED
    }

    pub async fn teardown_once<E, Fut>(&self, f: impl FnOnce() -> Fut) -> Result<(), E>
    where
        Fut: std::future::Future<Output = Result<(), E>>,
    {
        if self.state.load(std::sync::atomic::Ordering::Acquire) == TERMINATED {
            return Ok(());
        }

        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut guard = self.mu.lock();
                match *guard {
                    TERMINATED => return Ok(()),
                    TERMINATING => {}
                    ARMED => {
                        *guard = TERMINATING;
                        self.state.store(TERMINATING, std::sync::atomic::Ordering::Release);
                        break;
                    }
                    _ => unreachable!("invalid AsyncTeardownGate state"),
                }
            }
            notified.await;
        }

        struct AsyncRollbackGuard<'a> {
            gate: &'a AsyncTeardownGate,
            committed: bool,
        }

        impl Drop for AsyncRollbackGuard<'_> {
            fn drop(&mut self) {
                if self.committed {
                    return;
                }
                let mut guard = self.gate.mu.lock();
                *guard = ARMED;
                self.gate.state.store(ARMED, std::sync::atomic::Ordering::Release);
                drop(guard);
                self.gate.notify.notify_waiters();
            }
        }

        let mut rollback = AsyncRollbackGuard { gate: self, committed: false };
        match f().await {
            Ok(()) => {
                let mut guard = self.mu.lock();
                *guard = TERMINATED;
                self.state.store(TERMINATED, std::sync::atomic::Ordering::Release);
                rollback.committed = true;
                drop(guard);
                self.notify.notify_waiters();
                Ok(())
            }
            Err(err) => {
                drop(rollback);
                Err(err)
            }
        }
    }
}

impl Default for AsyncTeardownGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(all(test, not(feature = "loom")))]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::AsyncTeardownGate;

    #[tokio::test]
    async fn async_teardown_gate_rolls_back_on_error_and_seals_on_success() {
        let gate = Arc::new(AsyncTeardownGate::new());
        let calls = Arc::new(AtomicUsize::new(0));

        let err: Result<(), &'static str> = gate
            .teardown_once(|| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err("transient")
            })
            .await;
        assert_eq!(err, Err("transient"));
        assert!(!gate.is_terminated());

        let ok: Result<(), &'static str> = gate
            .teardown_once(|| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert_eq!(ok, Ok(()));
        assert!(gate.is_terminated());

        let noop: Result<(), &'static str> = gate
            .teardown_once(|| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert_eq!(noop, Ok(()));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
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
                        assert_eq!(active.fetch_add(1, Ordering::AcqRel), 0);
                        calls.fetch_add(1, Ordering::AcqRel);
                        succeeded.store(true, Ordering::Release);
                        assert_eq!(active.fetch_sub(1, Ordering::AcqRel), 1);
                        Ok(())
                    });
                    assert!(res.is_ok());
                    assert!(succeeded.load(Ordering::Acquire));
                })
            };

            let t1 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            let t2 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            t1.join().unwrap();
            t2.join().unwrap();

            assert_eq!(calls.load(Ordering::Acquire), 1);
            assert!(gate.is_terminated());
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
                        assert_eq!(active.fetch_add(1, Ordering::AcqRel), 0);
                        let n = calls.fetch_add(1, Ordering::AcqRel);
                        let out = if n == 0 {
                            Err("transient")
                        } else {
                            succeeded.store(true, Ordering::Release);
                            Ok(())
                        };
                        assert_eq!(active.fetch_sub(1, Ordering::AcqRel), 1);
                        out
                    });
                    if res.is_ok() {
                        assert!(succeeded.load(Ordering::Acquire));
                    }
                    res.is_ok()
                })
            };

            let t1 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            let t2 = run(Arc::clone(&gate), Arc::clone(&active), Arc::clone(&calls), Arc::clone(&succeeded));
            let ok1 = t1.join().unwrap();
            let ok2 = t2.join().unwrap();

            assert_eq!(calls.load(Ordering::Acquire), 2);
            assert_eq!(usize::from(ok1) + usize::from(ok2), 1);
            assert!(gate.is_terminated());
        });
    }
}
