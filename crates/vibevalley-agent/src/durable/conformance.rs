//! Reusable conformance suite verifying `StorageBackend` implementations
//! against VibeValley's durable semantics (ACID rollback, ordering, signals,
//! scheduler wakeups, deferred live coalescing, and reopen recovery).

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use super::{Compaction, Error, Result, Scheduler, Store, SubmissionStatus, Task, TaskStatus, Transition, WaitMode};

const WAIT: Duration = Duration::from_secs(5);

pub fn run_storage_conformance(mut make: impl FnMut() -> Result<Store>) -> Result<()> {
    test_conversations_forks_compaction_and_reset(&make()?)?;
    test_documents_revs_ordering_and_alert(&make()?)?;
    test_atomic_rollback_and_concurrency(&make()?)?;
    test_submissions_and_settle_wakeup(&make()?)?;
    test_tasks_signals_and_scheduler(&make()?)?;
    Ok(())
}

pub fn run_clocked_live_conformance<F>(mut make_with_clock: F) -> Result<()>
where
    F: FnMut(Arc<dyn Fn() -> i64 + Send + Sync>) -> Result<Store>,
{
    let clock = Arc::new(AtomicI64::new(1_000));
    let reader_clock = clock.clone();
    let store = make_with_clock(Arc::new(move || reader_clock.load(Ordering::Relaxed)))?;
    let rx = store.subscribe_documents()?;

    assert!(store.put_deferred("conversation", "c", "pi.usage", Value::Null).is_err());
    store.write(|tx| tx.put_document("conversation", "c", "pi.live", &json!("seed")))?;
    let initial = rx.recv_timeout(WAIT).expect("seed doc event");
    assert!(initial.durable);

    for i in 1..=10 {
        store.put_deferred("conversation", "c", "pi.live", json!(i))?;
        clock.fetch_add(5, Ordering::Relaxed);
    }
    assert!(rx.try_recv().is_err());

    clock.store(1_110, Ordering::Relaxed);
    store.flush_due()?;
    let mem_ev = rx.recv_timeout(WAIT).expect("memory preview event");
    assert!(!mem_ev.durable);
    assert_eq!(store.live_document("conversation", "c")?.unwrap().state, json!(10));
    assert_eq!(store.read(|r| r.document("conversation", "c", "pi.live"))?.unwrap().state, json!("seed"));

    clock.store(2_150, Ordering::Relaxed);
    store.flush_due()?;
    let disk_ev = rx.recv_timeout(WAIT).expect("durable flush event");
    assert!(disk_ev.durable);
    assert_eq!(store.read(|r| r.document("conversation", "c", "pi.live"))?.unwrap().state, json!(10));

    // A durable write supersedes deferred state without stale re-publish.
    store.put_deferred("conversation", "c", "pi.live", json!("ephemeral"))?;
    store.write(|tx| tx.put_document("conversation", "c", "pi.live", &json!("committed")))?;
    let committed = rx.recv_timeout(WAIT).expect("committed pi.live");
    assert!(committed.durable);
    assert_eq!(committed.document.state, json!("committed"));
    store.flush_deferred()?;
    assert_eq!(store.read(|r| r.document("conversation", "c", "pi.live"))?.unwrap().state, json!("committed"));

    store.close()?;
    Ok(())
}

pub fn run_reopen_conformance(mut open: impl FnMut() -> Result<Store>) -> Result<()> {
    let store = open()?;
    let sub_id = store.write(|tx| {
        tx.create_conversation("root", "deepseek-flash")?;
        for n in 1..=5 {
            tx.append_entry("root", "pi.user", &json!({"n": n}))?;
        }
        tx.fork_conversation("root", "branch", "", "", 3)?;
        tx.append_entry("branch", "pi.user", &json!({"branch": true}))?;
        tx.put_document("conversation", "root", "pi.agent", &json!({"model": "deepseek-flash"}))?;
        tx.compact(
            "root",
            Compaction {
                level: "hard",
                base_head: 1,
                from: 1,
                cut: 3,
                summary: "sum 1..3",
                token_count: 50,
            },
        )?;
        let (sub, _) = tx.submit("root", "req-reopen", "prompt", &json!({"text": "hi"}), Some("parked-task"))?;
        let mut t = Task::new("reopen", "park");
        t.id = "parked-task".into();
        t.conversation_id = "root".into();
        t.status = TaskStatus::Sleeping;
        t.wait_signal_name = "wake".into();
        tx.create_task(t)?;
        Ok(sub.id)
    })?;
    store.close()?;
    drop(store);

    let reopened = open()?;
    reopened.read(|r| {
        let root_vis = r.visible_entries("root")?;
        assert_eq!(root_vis.iter().map(|e| e.seq).collect::<Vec<_>>(), [6, 4, 5]);
        let branch_vis = r.visible_entries("branch")?;
        assert_eq!(branch_vis.len(), 4);
        assert_eq!(branch_vis[3].payload, json!({"branch": true}));
        assert_eq!(
            r.document("conversation", "root", "pi.agent")?.unwrap().state,
            json!({"model": "deepseek-flash"})
        );
        assert_eq!(r.submission(&sub_id)?.request_id, "req-reopen");
        Ok(())
    })?;

    let sched = Scheduler::new(reopened.clone(), 1);
    sched.register("reopen", "park", |tc| {
        let sig = tc.signal.as_ref().expect("wake signal").payload.clone();
        Ok(Transition::Complete(sig))
    });
    sched.recover()?;
    sched.send_signal("parked-task", "wake", Some("k1"), &json!({"ok": true}))?;
    let done = sched.wait("parked-task", WAIT)?;
    assert_eq!(done.result, json!({"ok": true}));
    sched.close();
    reopened.close()?;
    Ok(())
}

fn test_conversations_forks_compaction_and_reset(store: &Store) -> Result<()> {
    store.write(|tx| {
        tx.create_conversation("root", "deepseek-flash")?;
        assert!(tx.create_conversation("root", "deepseek-flash").is_err());
        for n in 1..=7 {
            assert_eq!(tx.append_entry("root", "pi.user", &json!(n))?.seq, n);
        }
        let child = tx.fork_conversation("root", "child", "t-owner", "", 3)?;
        assert_eq!(child.next_seq, 4);
        assert_eq!(child.provider_affinity, "deepseek-flash");
        tx.append_entry("child", "pi.user", &json!("branch"))?;
        tx.fork_conversation("child", "zero", "", "", 0)?;

        assert_eq!(
            tx.conversations_by_owner_task("t-owner")?.into_iter().map(|c| c.id).collect::<Vec<_>>(),
            vec!["child"]
        );

        assert!(
            tx.compact(
                "root",
                Compaction {
                    level: "hard",
                    base_head: 1,
                    from: 1,
                    cut: 5,
                    summary: "summary",
                    token_count: 100,
                }
            )?
            .is_some()
        );
        assert!(
            tx.compact(
                "root",
                Compaction {
                    level: "soft",
                    base_head: 1,
                    from: 1,
                    cut: 4,
                    summary: "stale",
                    token_count: 30,
                }
            )?
            .is_none()
        );
        assert_eq!(tx.visible_entries("root")?.into_iter().map(|e| e.seq).collect::<Vec<_>>(), vec![8, 6, 7]);
        tx.reset("root", &Value::Null)?;
        assert!(tx.visible_entries("root")?.is_empty());
        Ok(())
    })?;

    store.read(|r| {
        let convs = r.conversations()?;
        let mut ids: Vec<_> = convs.iter().map(|c| c.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["child", "root", "zero"]);
        assert!(convs.windows(2).all(|w| (w[0].created_at_ms, &w[0].id) <= (w[1].created_at_ms, &w[1].id)));
        assert!(r.visible_entries("zero")?.is_empty());
        assert_eq!(
            r.visible_entries("child")?.into_iter().map(|e| e.payload).collect::<Vec<_>>(),
            vec![json!(1), json!(2), json!(3), json!("branch")]
        );
        Ok(())
    })?;
    store.close()
}

fn test_documents_revs_ordering_and_alert(store: &Store) -> Result<()> {
    let rx = store.subscribe_documents()?;
    store.write(|tx| {
        let d1 = tx.put_document("conversation", "b-conv", "z-doc", &json!({"v": 1}))?;
        assert_eq!(d1.rev, 1);
        let d2 = tx.put_document("conversation", "b-conv", "z-doc", &json!({"v": 2}))?;
        assert_eq!(d2.rev, 2);
        tx.put_document("conversation", "a-conv", "z-doc", &json!({"v": 1}))?;
        tx.put_document("conversation", "b-conv", "a-doc", &json!({"v": 1}))?;
        tx.alert(Some("b-conv"), &json!({"kind": "budget_reached"}))?;

        let by_kind = tx.documents_by_kind("conversation", "z-doc")?;
        assert_eq!(by_kind.iter().map(|d| d.scope_id.as_str()).collect::<Vec<_>>(), ["a-conv", "b-conv"]);
        let by_scope = tx.documents_by_scope("conversation", "b-conv")?;
        assert_eq!(by_scope.iter().map(|d| d.doc_kind.as_str()).collect::<Vec<_>>(), ["a-doc", "pi.inbox", "z-doc"]);

        tx.delete_document("conversation", "b-conv", "a-doc")?;
        assert!(tx.document("conversation", "b-conv", "a-doc")?.is_none());
        Ok(())
    })?;

    let mut events = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        events.push(ev);
    }
    assert!(events.iter().any(|e| e.retired && e.document.doc_kind == "a-doc"));
    store.close()
}

fn test_atomic_rollback_and_concurrency(store: &Store) -> Result<()> {
    let rx = store.subscribe_documents()?;
    store.write(|tx| tx.create_conversation("atomic", "deepseek-flash"))?;

    let err_res = store.write(|tx| {
        tx.put_document("conversation", "atomic", "pi.test", &json!({"rolledBack": true}))?;
        tx.append_entry("atomic", "pi.user", &json!({"text": "should vanish"}))?;
        let mut t = Task::new("ephemeral", "run");
        t.id = "rolled-back-task".into();
        tx.create_task(t)?;
        Err::<(), _>(Error::Invalid("intentional abort".into()))
    });
    assert!(err_res.is_err());
    assert!(rx.try_recv().is_err());
    store.read(|r| {
        assert!(r.document("conversation", "atomic", "pi.test")?.is_none());
        assert!(r.entries("atomic", 1)?.is_empty());
        assert!(r.task("rolled-back-task").is_err());
        Ok(())
    })?;

    let panic_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.write(|tx| -> Result<()> {
            tx.put_document("conversation", "atomic", "pi.panic", &json!(1))?;
            panic!("simulated panic in tx");
        });
    }));
    assert!(panic_res.is_err());
    assert!(rx.try_recv().is_err());
    assert!(store.read(|r| r.document("conversation", "atomic", "pi.panic"))?.is_none());

    // Concurrent writers: failing transactions must not publish events or advance rev.
    let barrier = Arc::new(Barrier::new(16));
    let committed_ok = Arc::new(AtomicUsize::new(0));
    thread::scope(|scope| {
        for i in 0..16usize {
            let s = store.clone();
            let b = barrier.clone();
            let ok_count = committed_ok.clone();
            scope.spawn(move || {
                b.wait();
                let res = s.write(|tx| {
                    tx.put_document("conversation", "concurrent", "pi.usage", &json!({"ok": i % 4 != 0}))?;
                    if i % 4 == 0 {
                        return Err(Error::Invalid("reject".into()));
                    }
                    Ok(())
                });
                if res.is_ok() {
                    ok_count.fetch_add(1, Ordering::Relaxed);
                }
            });
        }
    });
    assert_eq!(committed_ok.load(Ordering::Relaxed), 12);
    let revs: Vec<i64> = rx
        .try_iter()
        .map(|e| {
            assert_eq!(e.document.state, json!({"ok": true}));
            assert!(e.durable);
            e.document.rev
        })
        .collect();
    assert_eq!(revs, (1..=12).collect::<Vec<_>>());
    store.close()
}

fn test_submissions_and_settle_wakeup(store: &Store) -> Result<()> {
    store.write(|tx| tx.create_conversation("sub-conv", "deepseek-flash"))?;
    let (sub, dup) = store.write(|tx| tx.submit("sub-conv", "req-1", "prompt", &json!("first"), Some("parent-task")))?;
    assert!(!dup);
    let (again, dup2) = store.write(|tx| tx.submit("sub-conv", "req-1", "prompt", &json!("second"), Some("parent-task")))?;
    assert!(dup2);
    assert_eq!(again.id, sub.id);
    assert_eq!(again.payload, json!("first"));

    store.write(|tx| tx.set_submission_status(&sub.id, SubmissionStatus::Placed))?;
    assert_eq!(store.read(|r| r.submission(&sub.id))?.status, SubmissionStatus::Placed);

    let sched = Scheduler::new(store.clone(), 1);
    let mut parent = Task::new("waiter", "wait");
    parent.id = "parent-task".into();
    parent.status = TaskStatus::Sleeping;
    parent.wait_signal_name = "pi.submission_settled".into();
    sched.register("waiter", "wait", |tc| {
        Ok(Transition::Complete(tc.signal.as_ref().expect("settlement signal").payload.clone()))
    });
    sched.start(parent)?;
    thread::sleep(Duration::from_millis(20));

    store.write(|tx| {
        tx.settle(&sub.id, SubmissionStatus::Done, &json!({"answer": 42}))?;
        tx.settle(&sub.id, SubmissionStatus::Done, &json!({"answer": 99}))?;
        Ok(())
    })?;

    let done = sched.wait("parent-task", WAIT)?;
    assert_eq!(done.result["status"], json!("done"));
    assert_eq!(done.result["result"], json!({"answer": 42}));
    assert_eq!(store.read(|r| r.signals("parent-task", true))?.len(), 1);
    sched.close();
    store.close()
}

fn test_tasks_signals_and_scheduler(store: &Store) -> Result<()> {
    // Dedup & FIFO signal ordering
    let sched = Scheduler::new(store.clone(), 2);
    let t = Task::new("sig", "wait");
    let tid = t.id.clone();
    sched.register("sig", "wait", |tc| {
        Ok(Transition::Complete(tc.signal.as_ref().map_or(Value::Null, |s| s.payload.clone())))
    });
    store.write(|tx| {
        let mut dup1 = Task::new("kind", "phase");
        dup1.dedup_key = "same".into();
        let (first, was_dup1) = tx.create_task(dup1.clone())?;
        assert!(!was_dup1);
        let (second, was_dup2) = tx.create_task(dup1)?;
        assert!(was_dup2);
        assert_eq!(first.id, second.id);

        // Empty dedup_key must NOT dedup
        let (a, dup_a) = tx.create_task(Task::new("kind", "phase"))?;
        let (b, dup_b) = tx.create_task(Task::new("kind", "phase"))?;
        assert!(!dup_a && !dup_b && a.id != b.id);

        tx.send_signal(&tid, "ev", Some("k1"), &json!(1))?;
        assert!(tx.send_signal(&tid, "ev", Some("k1"), &json!(99))?.1);
        tx.send_signal(&tid, "ev", Some("k2"), &json!(2))?;
        Ok(())
    })?;

    let mut waiter = t;
    waiter.status = TaskStatus::Sleeping;
    waiter.wait_signal_name = "ev".into();
    sched.start(waiter)?;
    assert_eq!(sched.wait(&tid, WAIT)?.result, json!(1));
    assert_eq!(store.read(|r| r.signals(&tid, false))?.len(), 1);

    // Child wait modes: Any, AllSettled, FailFast
    for mode in [WaitMode::Any, WaitMode::AllSettled, WaitMode::FailFast] {
        let (sent, seen) = flume::bounded(1);
        let parent_kind = format!("fam-{mode:?}");
        sched.register(&parent_kind, "spawn", move |tc| {
            let mut kids = Vec::new();
            for phase in ["fast", "park"] {
                let mut child = Task::new("kid", phase);
                child.dedup_key = phase.into();
                let (t, _) = tc.spawn_child(child)?;
                kids.push(t.id);
            }
            sent.send(kids[1].clone()).unwrap();
            Ok(Transition::Wait {
                phase: "join".into(),
                checkpoint: None,
                mode,
                children: kids,
            })
        });
        sched.register(&parent_kind, "join", |tc| {
            Ok(Transition::Complete(json!(
                tc.children.iter().filter(|c| c.status == TaskStatus::Terminal).count()
            )))
        });
        sched.register("kid", "fast", move |_| {
            if mode == WaitMode::FailFast {
                Ok(Transition::Fail("boom".into()))
            } else {
                Ok(Transition::Complete(Value::Null))
            }
        });
        sched.register("kid", "park", |_| {
            Ok(Transition::Sleep {
                phase: "done".into(),
                checkpoint: None,
                signal: Some("go".into()),
                until_ms: None,
            })
        });
        sched.register("kid", "done", |_| Ok(Transition::Complete(Value::Null)));

        let (p, _) = sched.start(Task::new(&parent_kind, "spawn"))?;
        let parked_id = seen.recv_timeout(WAIT).unwrap();
        if mode == WaitMode::AllSettled {
            sched.send_signal(&parked_id, "go", None, &Value::Null)?;
        }
        let done = sched.wait(&p.id, WAIT)?;
        assert_eq!(done.result, json!(if mode == WaitMode::AllSettled { 2 } else { 1 }));
    }

    // Abort tree children-first & circuit breaker on recover
    store.write(|tx| {
        for (id, owner) in [("p", ""), ("c", "p"), ("g", "c")] {
            let mut t = Task::new("breaker", "run");
            t.id = id.into();
            t.owner_task_id = owner.into();
            t.restart_count = 4;
            t.status = if owner.is_empty() { TaskStatus::Running } else { TaskStatus::Sleeping };
            tx.create_task(t)?;
        }
        Ok(())
    })?;
    sched.register("breaker", "run", |_| Ok(Transition::Complete(Value::Null)));
    sched.recover()?;
    let tripped = sched.wait("p", WAIT)?;
    assert_eq!(tripped.terminal_reason, "restart_limit");
    let expected_trace: Vec<String> = vec!["g".into(), "c".into(), "p".into()];
    assert!(sched.abort_trace().ends_with(&expected_trace), "{:?}", sched.abort_trace());

    sched.close();
    store.close()
}
