//! Three-state serialized idempotent teardown gate delegating to [`vibevalley_kit::sync`].

pub(crate) use vibevalley_kit::sync::AsyncTeardownGate;
#[cfg(all(test, feature = "loom"))]
pub(crate) use vibevalley_kit::sync::TeardownGate;

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
