use sqlx::ConnectOptions;
use sqlx::sqlite::SqliteConnectOptions;
async fn execute(path: &Path, sql: &'static str) -> sqlx::Result<()> {
    let mut db = SqliteConnectOptions::new().filename(path).create_if_missing(true).connect().await?;
    sqlx::raw_sql(sql).execute(&mut db).await?;
    Ok(())
}
use serde_json::{Value, json};
use std::{
    env,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tempfile::tempdir;
use tokio::process::Command;
use tokio::sync::Barrier;
use vibevalley_runtime::agent::durable::*;

const MAX: Duration = Duration::from_secs(5);

#[tokio::test]
async fn forks_see_historical_prefix_after_parent_compaction_and_reset() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let st = Store::open(&path).await?;
    st.write_async(|tx| {
        Box::pin(async move {
            tx.create_conversation_async("root", "deepseek:model").await?;
            for n in 1..=7 {
                assert_eq!(tx.append_entry_async("root", "pi.user", &json!(n)).await?.seq, n);
            }
            let child = tx.fork_conversation_async("root", "child", "task", "", 3).await?;
            assert_eq!(child.next_seq, 4);
            assert_eq!(child.provider_affinity, "deepseek:model");
            tx.append_entry_async("child", "pi.user", &json!("branch")).await?;
            tx.fork_conversation_async("child", "zero", "", "", 0).await?;
            assert!(
                tx.compact_async(
                    "root",
                    Compaction {
                        level: "hard",
                        base_head: 1,
                        from: 1,
                        cut: 5,
                        summary: "summary",
                        token_count: 100
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
                        summary: "late",
                        token_count: 30
                    }
                )
                .await?
                .is_none()
            );
            let vis = tx.visible_entries_async("root").await?;
            assert_eq!(vis.iter().map(|e| e.seq).collect::<Vec<_>>(), [8, 6, 7]);
            assert_eq!(tx.entries_async("root", 1).await?.len(), 8);
            tx.reset_async("root", &Value::Null).await?;
            assert!(tx.visible_entries_async("root").await?.is_empty());
            Ok(())
        })
    })
    .await?;
    st.close().await?;
    Store::open(&path)
        .await?
        .read_async(|r| {
            Box::pin(async move {
                assert!(r.visible_entries_async("zero").await?.is_empty());
                assert_eq!(
                    r.visible_entries_async("child").await?.iter().map(|e| e.payload.clone()).collect::<Vec<_>>(),
                    [json!(1), json!(2), json!(3), json!("branch")]
                );
                Ok(())
            })
        })
        .await
}

#[tokio::test]
async fn independent_savepoints_only_publish_committed_documents() -> Result<()> {
    let st = Store::memory()?;
    let mut rx = st.subscribe_documents()?;
    let start = Arc::new(Barrier::new(20));
    let mut join = tokio::task::JoinSet::new();
    for i in 0..20 {
        let s = st.clone();
        let b = start.clone();
        join.spawn(async move {
            b.wait().await;
            let result = s
                .write_async(move |tx| {
                    Box::pin(async move {
                        tx.put_document_async("conversation", "c", "pi.usage", &json!({"ok":i%5!=0})).await?;
                        if i % 5 == 0 {
                            return Err(Error::Invalid("refused".into()));
                        }
                        Ok(())
                    })
                })
                .await;
            assert_eq!(result.is_ok(), i % 5 != 0);
        });
    }
    while let Some(res) = join.join_next().await {
        res.unwrap();
    }
    let mut revs = Vec::new();
    while let Ok(e) = rx.try_recv() {
        assert_eq!(e.document.state, json!({"ok":true}));
        assert!(e.durable);
        revs.push(e.document.rev);
    }
    assert_eq!(revs, (1..=16).collect::<Vec<_>>());
    let dir = tempdir().unwrap();
    let path = dir.path().join("failed.db");
    let file = Store::open(&path).await?;
    let mut rx = file.subscribe_documents()?;
    execute(
        &path,
        "CREATE TABLE allowed(kind TEXT PRIMARY KEY); CREATE TABLE check_commit(kind TEXT REFERENCES allowed(kind) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER check_doc AFTER INSERT ON durable_document BEGIN INSERT INTO check_commit VALUES(NEW.doc_kind); END;",
    )
    .await?;
    let result = file
        .write_async(|tx| Box::pin(async move { tx.put_document_async("conversation", "c", "denied", &Value::Null).await }))
        .await;
    assert!(result.is_err());
    assert!(rx.try_recv().is_err());
    assert!(
        file.read_async(|r| Box::pin(async move { r.document_async("conversation", "c", "denied").await }))
            .await?
            .is_none()
    );
    Ok(())
}

#[tokio::test]
async fn repeated_requests_and_settlements_survive_reopen_without_reposting() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let s = Store::open(&path).await?;
    let (first, dedup) = s
        .write_async(|tx| Box::pin(async move { tx.submit_async("c", "key", "prompt", &json!("original"), Some("parent")).await }))
        .await?;
    assert!(!dedup);
    s.close().await?;
    let s = Store::open(&path).await?;
    let (again, dedup) = s
        .write_async(|tx| Box::pin(async move { tx.submit_async("c", "key", "prompt", &json!("retry"), Some("parent")).await }))
        .await?;
    assert!(dedup);
    assert_eq!(again.id, first.id);
    assert_eq!(again.payload, json!("original"));
    let first_id = first.id.clone();
    s.write_async(move |tx| {
        Box::pin(async move {
            tx.settle_async(&first_id, SubmissionStatus::Done, &json!(1)).await?;
            tx.settle_async(&first_id, SubmissionStatus::Done, &json!(1)).await?;
            Ok(())
        })
    })
    .await?;
    let first_id = first.id.clone();
    s.read_async(move |r| {
        Box::pin(async move {
            let signals = r.signals_async("parent", true).await?;
            assert_eq!(signals.len(), 1);
            assert_eq!(signals[0].payload["submissionId"], first_id);
            assert_eq!(signals[0].signal_name, "pi.submission_settled");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn early_and_late_signals_are_ordered_and_deduplicated() -> Result<()> {
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 1);
    scheduler.register("talk", "wait", |_| async {
        Ok(Transition::Sleep {
            phase: "continue".into(),
            checkpoint: Some(json!({"read":true})),
            signal: Some("answer".into()),
            until_ms: None,
        })
    });
    scheduler.register("talk", "continue", |tc| async move {
        Ok(Transition::Complete(tc.signal.as_ref().unwrap().payload.clone()))
    });
    let t = Task::new("talk", "wait");
    let id = t.id.clone();
    scheduler.send_signal(&id, "answer", Some("a"), &json!(1)).await?;
    assert!(scheduler.send_signal(&id, "answer", Some("a"), &json!(3)).await?.1);
    scheduler.send_signal(&id, "answer", Some("b"), &json!(2)).await?;
    scheduler.start(t).await?;
    let done = scheduler.wait(&id, MAX).await?;
    assert_eq!(done.result, json!(1));
    let id_q = id.clone();
    assert_eq!(
        store
            .read_async(move |r| Box::pin(async move { r.signals_async(&id_q, false).await }))
            .await?
            .len(),
        1
    );
    let t = Task::new("talk", "wait");
    let id = t.id.clone();
    scheduler.start(t).await?;
    // Waiting for this second task proves the single worker can be reused while the first is parked.
    scheduler.register("check", "run", |_| async { Ok(Transition::Complete(Value::Null)) });
    let (p, _) = scheduler.start(Task::new("check", "run")).await?;
    scheduler.wait(&p.id, MAX).await?;
    let id_q2 = id.clone();
    assert_eq!(
        store.read_async(move |r| Box::pin(async move { r.task_async(&id_q2).await })).await?.status,
        TaskStatus::Sleeping
    );
    scheduler.send_signal(&id, "answer", None, &json!(4)).await?;
    assert_eq!(scheduler.wait(&id, MAX).await?.result, json!(4));
    Ok(())
}

#[tokio::test]
async fn all_wait_modes_use_persisted_child_results() -> Result<()> {
    for mode in [WaitMode::Any, WaitMode::AllSettled, WaitMode::FailFast] {
        let store = Store::memory()?;
        let sched = Scheduler::new(store.clone(), 2);
        let (sent, mut seen) = tokio::sync::mpsc::unbounded_channel();
        sched.register("family", "spawn", move |ctx| {
            let sent = sent.clone();
            async move {
                let mut kids = vec![];
                for phase in ["first", "park"] {
                    let mut child = Task::new("child", phase);
                    child.dedup_key = phase.into();
                    let (t, dup) = ctx.spawn_child(child).await?;
                    assert!(!dup);
                    kids.push(t.id);
                }
                sent.send(kids[1].clone()).unwrap();
                Ok(Transition::Wait {
                    phase: "done".into(),
                    checkpoint: None,
                    mode,
                    children: kids,
                })
            }
        });
        sched.register("family", "done", |ctx| async move {
            Ok(Transition::Complete(json!(
                ctx.children.iter().filter(|t| t.status == TaskStatus::Terminal).count()
            )))
        });
        sched.register("child", "first", move |_| async move {
            Ok(if mode == WaitMode::FailFast {
                Transition::Fail("rejected".into())
            } else {
                Transition::Complete(Value::Null)
            })
        });
        sched.register("child", "park", |_| async {
            Ok(Transition::Sleep {
                phase: "finish".into(),
                checkpoint: None,
                signal: Some("go".into()),
                until_ms: None,
            })
        });
        sched.register("child", "finish", |_| async { Ok(Transition::Complete(Value::Null)) });
        let (parent, _) = sched.start(Task::new("family", "spawn")).await?;
        let parked = tokio::time::timeout(MAX, seen.recv()).await.unwrap().unwrap();
        if mode == WaitMode::AllSettled {
            sched.send_signal(&parked, "go", None, &Value::Null).await?;
        }
        let done = sched.wait(&parent.id, MAX).await?;
        assert_eq!(done.result, json!(if mode == WaitMode::AllSettled { 2 } else { 1 }));
    }
    Ok(())
}

#[tokio::test]
async fn process_exit_boundary() {
    let Ok(path) = env::var("VV_DURABLE_CRASH_DB") else { return };
    let store = Store::open(Path::new(&path)).await.unwrap();
    let scheduler = Scheduler::new(store.clone(), 1);
    scheduler.register("work", "run", |tc| async move {
        tc.checkpoint(&json!({"survived":true})).await?;
        tc.store
            .write_async(|tx| Box::pin(async move { tx.put_document_async("conversation", "c", "pi.live", &json!("durable")).await }))
            .await?;
        std::process::exit(73)
    });
    let mut t = Task::new("work", "run");
    t.id = "crash-task".into();
    scheduler.start(t).await.unwrap();
    scheduler.wait("crash-task", MAX).await.unwrap();
}

#[tokio::test]
async fn killed_running_phase_reopens_from_checkpoint_without_deferred_tail() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let out = Command::new(env::current_exe().unwrap())
        .args(["--exact", "process_exit_boundary"])
        .env("VV_DURABLE_CRASH_DB", &path)
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(73));
    let store = Store::open(&path).await?;
    let scheduler = Scheduler::new(store.clone(), 1);
    let interrupted = store.read_async(|r| Box::pin(async move { r.task_async("crash-task").await })).await?;
    assert_eq!(interrupted.status, TaskStatus::Running);
    assert_eq!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("conversation", "c", "pi.live").await }))
            .await?
            .unwrap()
            .state,
        json!("durable")
    );
    scheduler.register("work", "run", |tc| async move {
        assert_eq!(tc.task.restart_count, 1);
        Ok(Transition::Complete(tc.task.checkpoint.clone()))
    });
    scheduler.recover().await?;
    assert_eq!(scheduler.wait("crash-task", MAX).await?.result, json!({"survived":true}));
    Ok(())
}

#[tokio::test]
async fn circuit_breaker_settles_children_before_parent_and_emits_one_alert() -> Result<()> {
    let store = Store::memory()?;
    for (task, owner) in [("root", ""), ("child", "root"), ("grandchild", "child"), ("model", "")] {
        let mut t = Task::new("work", "run");
        t.id = task.into();
        t.owner_task_id = owner.into();
        t.is_model_task = task == "model";
        t.restart_count = 4;
        t.status = if owner.is_empty() { TaskStatus::Running } else { TaskStatus::Sleeping };
        store.write_async(move |tx| Box::pin(async move { tx.create_task_async(t).await })).await?;
    }
    let scheduler = Scheduler::new(store.clone(), 2);
    scheduler.register("work", "run", |_| async { Ok(Transition::Complete(json!("resumed"))) });
    scheduler.recover().await?;
    let t = scheduler.wait("root", MAX).await?;
    assert_eq!(t.terminal_reason, "restart_limit");
    store
        .read_async(|r| {
            Box::pin(async move {
                assert_eq!(r.task_async("grandchild").await?.status, TaskStatus::Terminal);
                assert_eq!(r.task_async("grandchild").await?.terminal_reason, "aborted");
                assert_eq!(r.task_async("child").await?.status, TaskStatus::Terminal);
                assert_eq!(r.task_async("child").await?.terminal_reason, "aborted");
                Ok(())
            })
        })
        .await?;
    assert_eq!(scheduler.wait("model", MAX).await?.result, json!("resumed"));
    assert_eq!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("global", "inbox", "pi.inbox").await }))
            .await?
            .unwrap()
            .state["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn rust_resumes_go_records_and_appends_to_the_same_ledger() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("go.db");
    let store = Store::open(&path).await?;
    execute(&path, include_str!("fixtures/go-store.sql")).await?;
    store
        .read_async(|r| {
            Box::pin(async move {
                assert_eq!(r.visible_entries_async("branch").await?.len(), 2);
                let root = r.visible_entries_async("from-go").await?;
                assert_eq!(root.iter().map(|e| e.seq).collect::<Vec<_>>(), [7, 4, 5, 6]);
                assert_eq!(root[0].payload["summary"], "three earlier turns");
                assert_eq!(r.document_async("global", "x", "pi.governance").await?.unwrap().state["budget"], 42);
                Ok(())
            })
        })
        .await?;
    let sched = Scheduler::new(store.clone(), 1);
    sched.register("answer", "resumed", |ctx| async move {
        let s = ctx.signal.as_ref().unwrap();
        assert_eq!(s.signal_key, "question");
        assert_eq!(s.payload["result"]["ok"], true);
        ctx.store
            .write_async(|tx| Box::pin(async move { tx.append_entry_async("from-go", "pi.assistant", &json!("reply")).await }))
            .await?;
        Ok(Transition::Complete(json!("answer")))
    });
    sched.recover().await?;
    assert_eq!(sched.wait("p", MAX).await?.result, json!("answer"));
    store
        .read_async(|r| {
            Box::pin(async move {
                assert_eq!(r.entries_async("from-go", 8).await?[0].payload, json!("reply"));
                let signals = r.signals_async("p", true).await?;
                assert_eq!(signals.len(), 1);
                assert!(signals[0].consumed);
                assert_eq!(r.submission_by_request_async("from-go", "request").await?.unwrap().id, "question");
                Ok(())
            })
        })
        .await
}

#[tokio::test]
async fn cancellation_wakes_blocked_phase_and_ignores_late_completion() -> Result<()> {
    let s = Store::memory()?;
    let scheduler = Scheduler::new(s.clone(), 1);
    let (started, mut seen) = tokio::sync::mpsc::unbounded_channel();
    scheduler.register("io", "run", move |ctx| {
        let started = started.clone();
        async move {
            started.send(()).unwrap();
            tokio::time::timeout(MAX, ctx.cancel_token().cancelled()).await.unwrap();
            assert!(ctx.is_cancelled());
            Ok(Transition::Complete(json!("late")))
        }
    });
    let (task, _) = scheduler.start(Task::new("io", "run")).await?;
    tokio::time::timeout(MAX, seen.recv()).await.unwrap().unwrap();
    scheduler.abort(&task.id).await?;
    scheduler.close().await;
    let tid = task.id.clone();
    let final_task = s.read_async(move |r| Box::pin(async move { r.task_async(&tid).await })).await?;
    assert_eq!(final_task.terminal_reason, "aborted");
    assert_ne!(final_task.result, json!("late"));
    Ok(())
}

#[tokio::test]
async fn advancing_clock_wakes_sleepers_and_leaves_the_pool_free() -> Result<()> {
    let clock = Arc::new(AtomicI64::new(10));
    let now = clock.clone();
    let s = Store::open_with_clock(None, move || now.load(Ordering::Relaxed)).await?;
    let scheduler = Scheduler::new(s.clone(), 1);
    let (entered, mut rx) = tokio::sync::mpsc::unbounded_channel();
    scheduler.register("park", "wait", |_| async {
        Ok(Transition::Sleep {
            phase: "done".into(),
            checkpoint: None,
            until_ms: Some(120000),
            signal: None,
        })
    });
    scheduler.register("park", "done", |_| async { Ok(Transition::Complete(json!("awoke"))) });
    scheduler.register("barrier", "done", move |_| {
        let entered = entered.clone();
        async move {
            entered.send(()).unwrap();
            Ok(Transition::Complete(Value::Null))
        }
    });
    let mut tasks = Vec::new();
    for _ in 0..30 {
        let (t, _) = scheduler.start(Task::new("park", "wait")).await?;
        tasks.push(t.id);
    }
    let (last, _) = scheduler.start(Task::new("barrier", "done")).await?;
    tokio::time::timeout(MAX, rx.recv()).await.unwrap().unwrap();
    scheduler.wait(&last.id, MAX).await?;
    assert_eq!(
        s.read_async(|r| Box::pin(async move { r.tasks_by_status_async(TaskStatus::Sleeping).await }))
            .await?
            .len(),
        30
    );
    clock.store(120001, Ordering::Relaxed);
    scheduler.wake();
    for t in tasks {
        assert_eq!(scheduler.wait(&t, MAX).await?.result, json!("awoke"));
    }
    Ok(())
}

#[tokio::test]
async fn wal_read_keeps_the_last_committed_snapshot_during_a_paired_write() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let store = Store::open(&path).await?;
    store
        .write_async(|tx| Box::pin(async move { tx.put_document_async("global", "desk", "pi.agent", &json!("old")).await }))
        .await?;
    let (held, started) = tokio::sync::oneshot::channel();
    let (allow, await_commit) = tokio::sync::oneshot::channel();
    let writer = store.clone();
    let writing = tokio::spawn(async move {
        let mut held = Some(held);
        let mut await_commit = Some(await_commit);
        writer
            .write_async(move |tx| {
                let held = held.take();
                let await_commit = await_commit.take();
                Box::pin(async move {
                    tx.put_document_async("global", "desk", "pi.agent", &json!("new")).await?;
                    if let Some(held) = held {
                        held.send(()).unwrap();
                    }
                    if let Some(await_commit) = await_commit {
                        tokio::time::timeout(MAX, await_commit).await.unwrap().unwrap();
                    }
                    Ok(())
                })
            })
            .await
    });
    tokio::time::timeout(MAX, started).await.unwrap().unwrap();
    assert_eq!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("global", "desk", "pi.agent").await }))
            .await?
            .unwrap()
            .state,
        json!("old")
    );
    allow.send(()).unwrap();
    writing.await.unwrap()?;
    assert_eq!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("global", "desk", "pi.agent").await }))
            .await?
            .unwrap()
            .state,
        json!("new")
    );
    Ok(())
}

#[tokio::test]
async fn regression_domain_write_and_settlement_share_the_outer_commit() -> Result<()> {
    let dir = tempdir().unwrap();
    let file = dir.path().join("server.db");
    let store = Store::open(&file).await?;
    execute(
        &file,
        "CREATE TABLE expected_result (id TEXT PRIMARY KEY);
        CREATE TABLE domain_result (id TEXT PRIMARY KEY REFERENCES expected_result(id) DEFERRABLE INITIALLY DEFERRED);",
    )
    .await?;
    let (submission, _) = store
        .write_async(|tx| Box::pin(async move { tx.submit_async("issue-followup", "reply", "prompt", &json!({}), None).await }))
        .await?;
    let mut events = store.subscribe_documents()?;
    let settle = || {
        let sub_id = submission.id.clone();
        let store = store.clone();
        async move {
            store
                .write_async(move |tx| {
                    Box::pin(async move {
                        sea_orm::ConnectionTrait::execute_unprepared(tx.transaction(), "INSERT INTO domain_result VALUES ('run')").await?;
                        tx.settle_async(&sub_id, SubmissionStatus::Done, &json!("delivered")).await?;
                        tx.put_document_async("run", "run", "issue.report", &json!("report")).await?;
                        Ok(())
                    })
                })
                .await
        }
    };
    assert!(settle().await.is_err());
    assert!(events.try_recv().is_err());
    let sub_id = submission.id.clone();
    assert_eq!(
        store
            .read_async(move |r| Box::pin(async move { r.submission_async(&sub_id).await }))
            .await?
            .status,
        SubmissionStatus::Queued
    );
    assert!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("run", "run", "issue.report").await }))
            .await?
            .is_none()
    );

    execute(&file, "INSERT INTO expected_result VALUES ('run')").await?;
    settle().await?;
    assert_eq!(events.try_recv().unwrap().document.state, json!("report"));
    assert!(events.try_recv().is_err());
    store.close().await?;
    let reopened = Store::open(&file).await?;
    let sub_id = submission.id.clone();
    assert_eq!(
        reopened
            .read_async(move |r| Box::pin(async move { r.submission_async(&sub_id).await }))
            .await?
            .result,
        json!("delivered")
    );
    assert_eq!(
        reopened
            .read_async(|r| Box::pin(async move { r.document_async("run", "run", "issue.report").await }))
            .await?
            .unwrap()
            .state,
        json!("report")
    );
    let mut db = SqliteConnectOptions::new().filename(&file).read_only(true).connect().await?;
    let domain_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM domain_result").fetch_one(&mut db).await?;
    assert_eq!(domain_rows, 1);
    Ok(())
}

#[tokio::test]
async fn async_write_shares_outer_commit_and_flushes_telemetry_on_commit_only() -> Result<()> {
    #[derive(Default)]
    struct CaptureTelemetry(std::sync::Mutex<Vec<TelemetryEvent>>);
    impl TelemetrySink for CaptureTelemetry {
        fn record(&self, event: &TelemetryEvent) {
            self.0.lock().unwrap().push(event.clone());
        }
    }

    let dir = tempdir().unwrap();
    let file = dir.path().join("server.db");
    let store = Store::open(&file).await?;
    execute(
        &file,
        "CREATE TABLE expected_async (id TEXT PRIMARY KEY);
        CREATE TABLE domain_async (id TEXT PRIMARY KEY REFERENCES expected_async(id) DEFERRABLE INITIALLY DEFERRED);",
    )
    .await?;
    let sink = Arc::new(CaptureTelemetry::default());
    store.set_telemetry(sink.clone());

    let (submission, _) = store
        .write_async(|tx| Box::pin(async move { tx.submit_async("issue-async", "reply", "prompt", &json!({}), None).await }))
        .await?;
    assert_eq!(sink.0.lock().unwrap().len(), 1);

    let mut events = store.subscribe_documents()?;
    let settle_async = || {
        let sub_id = submission.id.as_str();
        store.write_with_async(sub_id, |tx, sub_id| {
            Box::pin(async move {
                sea_orm::ConnectionTrait::execute_unprepared(tx.transaction(), "INSERT INTO domain_async VALUES ('run')").await?;
                tx.settle_async(sub_id, SubmissionStatus::Done, &json!("delivered")).await?;
                tx.put_document_async("run", "run", "issue.report", &json!("report")).await?;
                Ok(())
            })
        })
    };

    assert!(settle_async().await.is_err());
    assert!(events.try_recv().is_err());
    assert_eq!(sink.0.lock().unwrap().len(), 1);

    execute(&file, "INSERT INTO expected_async VALUES ('run')").await?;
    settle_async().await?;
    assert_eq!(events.try_recv().unwrap().document.state, json!("report"));
    assert_eq!(sink.0.lock().unwrap().len(), 2);
    Ok(())
}
