//! Reusable conformance suite verifying `StorageBackend` implementations
//! against VibeValley's durable semantics (ACID rollback, ordering, signals,
//! scheduler wakeups, and reopen recovery).

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::FutureExt as _;
use serde_json::{Value, json};
use tokio::sync::{Barrier, mpsc};
use tokio::task::JoinSet;

use super::{Compaction, Error, Result, Scheduler, Store, SubmissionStatus, Task, TaskStatus, Transition, WaitMode};

const WAIT: Duration = Duration::from_secs(5);

pub async fn run_storage_conformance<F, Fut>(mut make: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Store>>,
{
    test_conversations_forks_compaction_and_reset(&make().await?).await?;
    test_documents_revs_ordering_and_alert(&make().await?).await?;
    test_atomic_rollback_and_concurrency(&make().await?).await?;
    test_submissions_and_settle_wakeup(&make().await?).await?;
    test_tasks_signals_and_scheduler(&make().await?).await?;
    Ok(())
}

pub async fn run_reopen_conformance<F, Fut>(mut open: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Store>>,
{
    let store = open().await?;
    let sub_id = store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("root", "deepseek-flash").await?;
                for n in 1..=5 {
                    tx.append_entry_async("root", "pi.user", &json!({"n": n})).await?;
                }
                tx.fork_conversation_async("root", "branch", "", "", 3).await?;
                tx.append_entry_async("branch", "pi.user", &json!({"branch": true})).await?;
                tx.put_document_async("conversation", "root", "pi.agent", &json!({"model": "deepseek-flash"}))
                    .await?;
                tx.compact_async(
                    "root",
                    Compaction {
                        level: "hard",
                        base_head: 1,
                        from: 1,
                        cut: 3,
                        summary: "sum 1..3",
                        token_count: 50,
                    },
                )
                .await?;
                let (sub, _) = tx
                    .submit_async("root", "req-reopen", "prompt", &json!({"text": "hi"}), Some("parked-task"))
                    .await?;
                let mut t = Task::new("reopen", "park");
                t.id = "parked-task".into();
                t.conversation_id = "root".into();
                t.status = TaskStatus::Sleeping;
                t.wait_signal_name = "wake".into();
                tx.create_task_async(t).await?;
                Ok(sub.id)
            })
        })
        .await?;
    store.close().await?;
    drop(store);

    let reopened = open().await?;
    reopened
        .read_async(move |r| {
            Box::pin(async move {
                let root_vis = r.visible_entries_async("root").await?;
                assert_eq!(root_vis.iter().map(|e| e.seq).collect::<Vec<_>>(), [6, 4, 5]);
                let branch_vis = r.visible_entries_async("branch").await?;
                assert_eq!(branch_vis.len(), 4);
                assert_eq!(branch_vis[3].payload, json!({"branch": true}));
                assert_eq!(
                    r.document_async("conversation", "root", "pi.agent").await?.unwrap().state,
                    json!({"model": "deepseek-flash"})
                );
                assert_eq!(r.submission_async(&sub_id).await?.request_id, "req-reopen");
                Ok(())
            })
        })
        .await?;

    let sched = Scheduler::new(reopened.clone(), 1);
    sched.register("reopen", "park", |tc| async move {
        let sig = tc.signal.as_ref().expect("wake signal").payload.clone();
        Ok(Transition::Complete(sig))
    });
    sched.recover().await?;
    sched.send_signal("parked-task", "wake", Some("k1"), &json!({"ok": true})).await?;
    let done = sched.wait("parked-task", WAIT).await?;
    assert_eq!(done.result, json!({"ok": true}));
    sched.close().await;
    reopened.close().await?;
    Ok(())
}

async fn test_conversations_forks_compaction_and_reset(store: &Store) -> Result<()> {
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("root", "deepseek-flash").await?;
                assert!(tx.create_conversation_async("root", "deepseek-flash").await.is_err());
                for n in 1..=7 {
                    assert_eq!(tx.append_entry_async("root", "pi.user", &json!(n)).await?.seq, n);
                }
                let child = tx.fork_conversation_async("root", "child", "t-owner", "", 3).await?;
                assert_eq!(child.next_seq, 4);
                assert_eq!(child.provider_affinity, "deepseek-flash");
                tx.append_entry_async("child", "pi.user", &json!("branch")).await?;
                tx.fork_conversation_async("child", "zero", "", "", 0).await?;

                assert_eq!(
                    tx.conversations_by_owner_task_async("t-owner")
                        .await?
                        .into_iter()
                        .map(|c| c.id)
                        .collect::<Vec<_>>(),
                    vec!["child"]
                );

                assert!(
                    tx.compact_async(
                        "root",
                        Compaction {
                            level: "hard",
                            base_head: 1,
                            from: 1,
                            cut: 5,
                            summary: "summary",
                            token_count: 100,
                        }
                    )
                    .await?
                    .is_some()
                );
                assert!(
                    tx.compact_async(
                        "root",
                        Compaction {
                            level: "soft",
                            base_head: 1,
                            from: 1,
                            cut: 4,
                            summary: "stale",
                            token_count: 30,
                        }
                    )
                    .await?
                    .is_none()
                );
                assert_eq!(
                    tx.visible_entries_async("root").await?.into_iter().map(|e| e.seq).collect::<Vec<_>>(),
                    vec![8, 6, 7]
                );
                tx.reset_async("root", &Value::Null).await?;
                assert!(tx.visible_entries_async("root").await?.is_empty());
                Ok(())
            })
        })
        .await?;

    store
        .read_async(|r| {
            Box::pin(async move {
                let convs = r.conversations_async().await?;
                let mut ids: Vec<_> = convs.iter().map(|c| c.id.as_str()).collect();
                ids.sort();
                assert_eq!(ids, vec!["child", "root", "zero"]);
                assert!(convs.windows(2).all(|w| (w[0].created_at_ms, &w[0].id) <= (w[1].created_at_ms, &w[1].id)));
                assert!(r.visible_entries_async("zero").await?.is_empty());
                assert_eq!(
                    r.visible_entries_async("child").await?.into_iter().map(|e| e.payload).collect::<Vec<_>>(),
                    vec![json!(1), json!(2), json!(3), json!("branch")]
                );
                Ok(())
            })
        })
        .await?;
    store.close().await
}

async fn test_documents_revs_ordering_and_alert(store: &Store) -> Result<()> {
    let mut rx = store.subscribe_documents()?;
    store
        .write_async(|tx| {
            Box::pin(async move {
                let d1 = tx.put_document_async("conversation", "b-conv", "z-doc", &json!({"v": 1})).await?;
                assert_eq!(d1.rev, 1);
                let d2 = tx.put_document_async("conversation", "b-conv", "z-doc", &json!({"v": 2})).await?;
                assert_eq!(d2.rev, 2);
                tx.put_document_async("conversation", "a-conv", "z-doc", &json!({"v": 1})).await?;
                tx.put_document_async("conversation", "b-conv", "a-doc", &json!({"v": 1})).await?;
                tx.alert_async(Some("b-conv"), &json!({"kind": "budget_reached"})).await?;

                let by_kind = tx.documents_by_kind_async("conversation", "z-doc").await?;
                assert_eq!(by_kind.iter().map(|d| d.scope_id.as_str()).collect::<Vec<_>>(), ["a-conv", "b-conv"]);
                let by_scope = tx.documents_by_scope_async("conversation", "b-conv").await?;
                assert_eq!(by_scope.iter().map(|d| d.doc_kind.as_str()).collect::<Vec<_>>(), ["a-doc", "pi.inbox", "z-doc"]);

                tx.delete_document_async("conversation", "b-conv", "a-doc").await?;
                assert!(tx.document_async("conversation", "b-conv", "a-doc").await?.is_none());
                Ok(())
            })
        })
        .await?;

    let mut events = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        events.push(ev);
    }
    assert!(events.iter().any(|e| e.retired && e.document.doc_kind == "a-doc"));
    store.close().await
}

async fn test_atomic_rollback_and_concurrency(store: &Store) -> Result<()> {
    let mut rx = store.subscribe_documents()?;
    store
        .write_async(|tx| Box::pin(async move { tx.create_conversation_async("atomic", "deepseek-flash").await }))
        .await?;

    let err_res = store
        .write_async(|tx| {
            Box::pin(async move {
                tx.put_document_async("conversation", "atomic", "pi.test", &json!({"rolledBack": true})).await?;
                tx.append_entry_async("atomic", "pi.user", &json!({"text": "should vanish"})).await?;
                let mut t = Task::new("ephemeral", "run");
                t.id = "rolled-back-task".into();
                tx.create_task_async(t).await?;
                Err::<(), _>(Error::Invalid("intentional abort".into()))
            })
        })
        .await;
    assert!(err_res.is_err());
    assert!(rx.try_recv().is_err());
    store
        .read_async(|r| {
            Box::pin(async move {
                assert!(r.document_async("conversation", "atomic", "pi.test").await?.is_none());
                assert!(r.entries_async("atomic", 1).await?.is_empty());
                assert!(r.task_async("rolled-back-task").await.is_err());
                Ok(())
            })
        })
        .await?;

    let panic_res = std::panic::AssertUnwindSafe(store.write_async::<(), _>(|tx| {
        Box::pin(async move {
            tx.put_document_async("conversation", "atomic", "pi.panic", &json!(1)).await?;
            panic!("simulated panic in tx");
        })
    }))
    .catch_unwind()
    .await;
    assert!(panic_res.is_err());
    assert!(rx.try_recv().is_err());
    assert!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("conversation", "atomic", "pi.panic").await }))
            .await?
            .is_none()
    );

    // Concurrent writers: failing transactions must not publish events or advance rev.
    let barrier = Arc::new(Barrier::new(16));
    let committed_ok = Arc::new(AtomicUsize::new(0));
    let mut tasks = JoinSet::new();
    for i in 0..16usize {
        let s = store.clone();
        let b = barrier.clone();
        let ok_count = committed_ok.clone();
        tasks.spawn(async move {
            b.wait().await;
            let res = s
                .write_async(move |tx| {
                    Box::pin(async move {
                        tx.put_document_async("conversation", "concurrent", "pi.usage", &json!({"ok": i % 4 != 0}))
                            .await?;
                        if i % 4 == 0 {
                            return Err(Error::Invalid("reject".into()));
                        }
                        Ok(())
                    })
                })
                .await;
            if res.is_ok() {
                ok_count.fetch_add(1, Ordering::Relaxed);
            }
        });
    }
    while let Some(res) = tasks.join_next().await {
        res.expect("concurrent writer task panicked");
    }
    assert_eq!(committed_ok.load(Ordering::Relaxed), 12);
    let mut revs = Vec::new();
    while let Ok(e) = rx.try_recv() {
        assert_eq!(e.document.state, json!({"ok": true}));
        assert!(e.durable);
        revs.push(e.document.rev);
    }
    assert_eq!(revs, (1..=12).collect::<Vec<_>>());
    store.close().await
}

async fn test_submissions_and_settle_wakeup(store: &Store) -> Result<()> {
    store
        .write_async(|tx| Box::pin(async move { tx.create_conversation_async("sub-conv", "deepseek-flash").await }))
        .await?;
    let (sub, dup) = store
        .write_async(|tx| Box::pin(async move { tx.submit_async("sub-conv", "req-1", "prompt", &json!("first"), Some("parent-task")).await }))
        .await?;
    assert!(!dup);
    let (again, dup2) = store
        .write_async(|tx| Box::pin(async move { tx.submit_async("sub-conv", "req-1", "prompt", &json!("second"), Some("parent-task")).await }))
        .await?;
    assert!(dup2);
    assert_eq!(again.id, sub.id);
    assert_eq!(again.payload, json!("first"));

    let sub_id = sub.id.clone();
    store
        .write_async(move |tx| Box::pin(async move { tx.set_submission_status_async(&sub_id, SubmissionStatus::Placed).await }))
        .await?;
    let sub_id = sub.id.clone();
    assert_eq!(
        store
            .read_async(move |r| Box::pin(async move { r.submission_async(&sub_id).await }))
            .await?
            .status,
        SubmissionStatus::Placed
    );

    let sched = Scheduler::new(store.clone(), 1);
    let mut parent = Task::new("waiter", "wait");
    parent.id = "parent-task".into();
    parent.status = TaskStatus::Sleeping;
    parent.wait_signal_name = "pi.submission_settled".into();
    sched.register("waiter", "wait", |tc| async move {
        Ok(Transition::Complete(tc.signal.as_ref().expect("settlement signal").payload.clone()))
    });
    sched.start(parent).await?;
    assert_eq!(
        store.read_async(|r| Box::pin(async move { r.task_async("parent-task").await })).await?.status,
        TaskStatus::Sleeping
    );

    let sub_id = sub.id.clone();
    store
        .write_async(move |tx| {
            Box::pin(async move {
                tx.settle_async(&sub_id, SubmissionStatus::Done, &json!({"answer": 42})).await?;
                tx.settle_async(&sub_id, SubmissionStatus::Done, &json!({"answer": 99})).await?;
                Ok(())
            })
        })
        .await?;

    let done = sched.wait("parent-task", WAIT).await?;
    assert_eq!(done.result["status"], json!("done"));
    assert_eq!(done.result["result"], json!({"answer": 42}));
    assert_eq!(
        store
            .read_async(|r| Box::pin(async move { r.signals_async("parent-task", true).await }))
            .await?
            .len(),
        1
    );
    sched.close().await;
    store.close().await
}

async fn test_tasks_signals_and_scheduler(store: &Store) -> Result<()> {
    // Dedup & FIFO signal ordering
    let sched = Scheduler::new(store.clone(), 2);
    let t = Task::new("sig", "wait");
    let tid = t.id.clone();
    sched.register("sig", "wait", |tc| async move {
        Ok(Transition::Complete(tc.signal.as_ref().map_or(Value::Null, |s| s.payload.clone())))
    });
    let tid_write = tid.clone();
    store
        .write_async(move |tx| {
            Box::pin(async move {
                let mut dup1 = Task::new("kind", "phase");
                dup1.dedup_key = "same".into();
                let (first, was_dup1) = tx.create_task_async(dup1.clone()).await?;
                assert!(!was_dup1);
                let (second, was_dup2) = tx.create_task_async(dup1).await?;
                assert!(was_dup2);
                assert_eq!(first.id, second.id);

                // Empty dedup_key must NOT dedup
                let (a, dup_a) = tx.create_task_async(Task::new("kind", "phase")).await?;
                let (b, dup_b) = tx.create_task_async(Task::new("kind", "phase")).await?;
                assert!(!dup_a && !dup_b && a.id != b.id);

                tx.send_signal_async(&tid_write, "ev", Some("k1"), &json!(1)).await?;
                assert!(tx.send_signal_async(&tid_write, "ev", Some("k1"), &json!(99)).await?.1);
                tx.send_signal_async(&tid_write, "ev", Some("k2"), &json!(2)).await?;
                Ok(())
            })
        })
        .await?;

    let mut waiter = t;
    waiter.status = TaskStatus::Sleeping;
    waiter.wait_signal_name = "ev".into();
    sched.start(waiter).await?;
    assert_eq!(sched.wait(&tid, WAIT).await?.result, json!(1));
    let tid_read = tid.clone();
    assert_eq!(
        store
            .read_async(move |r| Box::pin(async move { r.signals_async(&tid_read, false).await }))
            .await?
            .len(),
        1
    );

    // Child wait modes: Any, AllSettled, FailFast
    for mode in [WaitMode::Any, WaitMode::AllSettled, WaitMode::FailFast] {
        let (sent, mut seen) = mpsc::unbounded_channel();
        let parent_kind = format!("fam-{mode:?}");
        sched.register(&parent_kind, "spawn", move |tc| {
            let sent = sent.clone();
            async move {
                let mut kids = Vec::new();
                for phase in ["fast", "park"] {
                    let mut child = Task::new("kid", phase);
                    child.dedup_key = phase.into();
                    let (t, _) = tc.spawn_child(child).await?;
                    kids.push(t.id);
                }
                sent.send(kids[1].clone()).unwrap();
                Ok(Transition::Wait {
                    phase: "join".into(),
                    checkpoint: None,
                    mode,
                    children: kids,
                })
            }
        });
        sched.register(&parent_kind, "join", |tc| async move {
            Ok(Transition::Complete(json!(
                tc.children.iter().filter(|c| c.status == TaskStatus::Terminal).count()
            )))
        });
        sched.register("kid", "fast", move |_| async move {
            if mode == WaitMode::FailFast {
                Ok(Transition::Fail("boom".into()))
            } else {
                Ok(Transition::Complete(Value::Null))
            }
        });
        sched.register("kid", "park", |_| async move {
            Ok(Transition::Sleep {
                phase: "done".into(),
                checkpoint: None,
                signal: Some("go".into()),
                until_ms: None,
            })
        });
        sched.register("kid", "done", |_| async move { Ok(Transition::Complete(Value::Null)) });

        let (p, _) = sched.start(Task::new(&parent_kind, "spawn")).await?;
        let parked_id = tokio::time::timeout(WAIT, seen.recv())
            .await
            .expect("parked id timeout")
            .expect("parked id channel");
        if mode == WaitMode::AllSettled {
            sched.send_signal(&parked_id, "go", None, &Value::Null).await?;
        }
        let done = sched.wait(&p.id, WAIT).await?;
        assert_eq!(done.result, json!(if mode == WaitMode::AllSettled { 2 } else { 1 }));
    }

    // Abort tree children-first & circuit breaker on recover
    store
        .write_async(|tx| {
            Box::pin(async move {
                for (id, owner) in [("p", ""), ("c", "p"), ("g", "c")] {
                    let mut t = Task::new("breaker", "run");
                    t.id = id.into();
                    t.owner_task_id = owner.into();
                    t.restart_count = 4;
                    t.status = if owner.is_empty() { TaskStatus::Running } else { TaskStatus::Sleeping };
                    tx.create_task_async(t).await?;
                }
                Ok(())
            })
        })
        .await?;
    sched.register("breaker", "run", |_| async move { Ok(Transition::Complete(Value::Null)) });
    sched.recover().await?;
    let tripped = sched.wait("p", WAIT).await?;
    assert_eq!(tripped.terminal_reason, "restart_limit");
    store
        .read_async(|r| {
            Box::pin(async move {
                assert_eq!(r.task_async("g").await?.status, TaskStatus::Terminal);
                assert_eq!(r.task_async("g").await?.terminal_reason, "aborted");
                assert_eq!(r.task_async("c").await?.status, TaskStatus::Terminal);
                assert_eq!(r.task_async("c").await?.terminal_reason, "aborted");
                assert_eq!(r.task_async("p").await?.status, TaskStatus::Terminal);
                Ok(())
            })
        })
        .await?;

    sched.close().await;
    store.close().await
}
