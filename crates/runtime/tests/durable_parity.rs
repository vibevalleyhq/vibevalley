use sqlx::ConnectOptions;
use sqlx::sqlite::SqliteConnectOptions;
fn execute(path: &Path, sql: &'static str) -> sqlx::Result<()> {
    pollster::block_on(async {
        let mut db = SqliteConnectOptions::new().filename(path).create_if_missing(true).connect().await?;
        sqlx::raw_sql(sql).execute(&mut db).await?;
        Ok(())
    })
}
use serde_json::{Value, json};
use std::{
    env,
    path::Path,
    process::Command,
    sync::{
        Arc, Barrier,
        atomic::{AtomicI64, Ordering},
    },
    thread,
    time::Duration,
};
use tempfile::tempdir;
use vibevalley_runtime::agent::durable::*;

const MAX: Duration = Duration::from_secs(5);

#[test]
fn forks_see_historical_prefix_after_parent_compaction_and_reset() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let st = Store::open(&path)?;
    st.write(|tx| {
        tx.create_conversation("root", "deepseek:model")?;
        for n in 1..=7 {
            assert_eq!(tx.append_entry("root", "pi.user", &json!(n))?.seq, n);
        }
        let child = tx.fork_conversation("root", "child", "task", "", 3)?;
        assert_eq!(child.next_seq, 4);
        assert_eq!(child.provider_affinity, "deepseek:model");
        tx.append_entry("child", "pi.user", &json!("branch"))?;
        tx.fork_conversation("child", "zero", "", "", 0)?;
        assert!(
            tx.compact(
                "root",
                Compaction {
                    level: "hard",
                    base_head: 1,
                    from: 1,
                    cut: 5,
                    summary: "summary",
                    token_count: 100
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
                    summary: "late",
                    token_count: 30
                }
            )?
            .is_none()
        );
        let vis = tx.visible_entries("root")?;
        assert_eq!(vis.iter().map(|e| e.seq).collect::<Vec<_>>(), [8, 6, 7]);
        assert_eq!(tx.entries("root", 1)?.len(), 8);
        tx.reset("root", &Value::Null)?;
        assert!(tx.visible_entries("root")?.is_empty());
        Ok(())
    })?;
    st.close()?;
    Store::open(&path)?.read(|r| {
        assert!(r.visible_entries("zero")?.is_empty());
        assert_eq!(
            r.visible_entries("child")?.iter().map(|e| e.payload.clone()).collect::<Vec<_>>(),
            [json!(1), json!(2), json!(3), json!("branch")]
        );
        Ok(())
    })
}

#[test]
fn independent_savepoints_only_publish_committed_documents() -> Result<()> {
    let st = Store::memory()?;
    let rx = st.subscribe_documents()?;
    let start = Arc::new(Barrier::new(20));
    thread::scope(|scope| {
        for i in 0..20 {
            let s = st.clone();
            let b = start.clone();
            scope.spawn(move || {
                b.wait();
                let result = s.write(|tx| {
                    tx.put_document("conversation", "c", "pi.usage", &json!({"ok":i%5!=0}))?;
                    if i % 5 == 0 {
                        return Err(Error::Invalid("refused".into()));
                    }
                    Ok(())
                });
                assert_eq!(result.is_ok(), i % 5 != 0);
            });
        }
    });
    assert_eq!(
        rx.try_iter()
            .map(|e| {
                assert_eq!(e.document.state, json!({"ok":true}));
                assert!(e.durable);
                e.document.rev
            })
            .collect::<Vec<_>>(),
        (1..=16).collect::<Vec<_>>()
    );
    let dir = tempdir().unwrap();
    let path = dir.path().join("failed.db");
    let file = Store::open(&path)?;
    let rx = file.subscribe_documents()?;
    execute(
        &path,
        "CREATE TABLE allowed(kind TEXT PRIMARY KEY); CREATE TABLE check_commit(kind TEXT REFERENCES allowed(kind) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER check_doc AFTER INSERT ON durable_document BEGIN INSERT INTO check_commit VALUES(NEW.doc_kind); END;",
    )?;
    let result = file.write(|tx| tx.put_document("conversation", "c", "denied", &Value::Null));
    assert!(result.is_err());
    assert!(rx.try_recv().is_err());
    assert!(file.read(|r| r.document("conversation", "c", "denied"))?.is_none());
    Ok(())
}

#[test]
fn repeated_requests_and_settlements_survive_reopen_without_reposting() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let s = Store::open(&path)?;
    let (first, dedup) = s.write(|tx| tx.submit("c", "key", "prompt", &json!("original"), Some("parent")))?;
    assert!(!dedup);
    s.close()?;
    let s = Store::open(&path)?;
    let (again, dedup) = s.write(|tx| tx.submit("c", "key", "prompt", &json!("retry"), Some("parent")))?;
    assert!(dedup);
    assert_eq!(again.id, first.id);
    assert_eq!(again.payload, json!("original"));
    s.write(|tx| {
        tx.settle(&first.id, SubmissionStatus::Done, &json!(1))?;
        tx.settle(&first.id, SubmissionStatus::Done, &json!(1))?;
        Ok(())
    })?;
    s.read(|r| {
        let signals = r.signals("parent", true)?;
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].payload["submissionId"], first.id);
        assert_eq!(signals[0].signal_name, "pi.submission_settled");
        Ok(())
    })
}

#[test]
fn live_stream_has_separate_memory_and_durable_deadlines() -> Result<()> {
    let clock = Arc::new(AtomicI64::new(1000));
    let now = clock.clone();
    let s = Store::open_with_clock(None, move || now.load(Ordering::Relaxed))?;
    let rx = s.subscribe_documents()?;
    assert!(s.put_deferred("conversation", "c", "pi.usage", Value::Null).is_err());
    s.write(|tx| tx.put_document("conversation", "c", "pi.live", &json!("seed")))?;
    rx.recv().unwrap();
    for i in 1..=10 {
        s.put_deferred("conversation", "c", "pi.live", json!(i))?;
        clock.fetch_add(5, Ordering::Relaxed);
    }
    assert!(rx.try_recv().is_err());
    clock.store(1110, Ordering::Relaxed);
    s.flush_due()?;
    assert!(!rx.recv_timeout(MAX).unwrap().durable);
    assert_eq!(s.live_document("conversation", "c")?.unwrap().state, json!(10));
    assert_eq!(s.read(|r| r.document("conversation", "c", "pi.live"))?.unwrap().state, json!("seed"));
    clock.store(2000, Ordering::Relaxed);
    s.flush_due()?;
    assert!(rx.recv_timeout(MAX).unwrap().durable);
    assert_eq!(s.read(|r| r.document("conversation", "c", "pi.live"))?.unwrap().state, json!(10));
    Ok(())
}

#[test]
fn early_and_late_signals_are_ordered_and_deduplicated() -> Result<()> {
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 1);
    scheduler.register("talk", "wait", |_| {
        Ok(Transition::Sleep {
            phase: "continue".into(),
            checkpoint: Some(json!({"read":true})),
            signal: Some("answer".into()),
            until_ms: None,
        })
    });
    scheduler.register("talk", "continue", |tc| Ok(Transition::Complete(tc.signal.as_ref().unwrap().payload.clone())));
    let t = Task::new("talk", "wait");
    let id = t.id.clone();
    scheduler.send_signal(&id, "answer", Some("a"), &json!(1))?;
    assert!(scheduler.send_signal(&id, "answer", Some("a"), &json!(3))?.1);
    scheduler.send_signal(&id, "answer", Some("b"), &json!(2))?;
    scheduler.start(t)?;
    let done = scheduler.wait(&id, MAX)?;
    assert_eq!(done.result, json!(1));
    assert_eq!(store.read(|r| r.signals(&id, false))?.len(), 1);
    let t = Task::new("talk", "wait");
    let id = t.id.clone();
    scheduler.start(t)?;
    // Waiting for this second task proves the single worker can be reused while the first is parked.
    scheduler.register("check", "run", |_| Ok(Transition::Complete(Value::Null)));
    let (p, _) = scheduler.start(Task::new("check", "run"))?;
    scheduler.wait(&p.id, MAX)?;
    assert_eq!(store.read(|r| r.task(&id))?.status, TaskStatus::Sleeping);
    scheduler.send_signal(&id, "answer", None, &json!(4))?;
    assert_eq!(scheduler.wait(&id, MAX)?.result, json!(4));
    Ok(())
}

#[test]
fn all_wait_modes_use_persisted_child_results() -> Result<()> {
    for mode in [WaitMode::Any, WaitMode::AllSettled, WaitMode::FailFast] {
        let store = Store::memory()?;
        let sched = Scheduler::new(store.clone(), 2);
        let (sent, seen) = flume::bounded(1);
        sched.register("family", "spawn", move |ctx| {
            let mut kids = vec![];
            for phase in ["first", "park"] {
                let mut child = Task::new("child", phase);
                child.dedup_key = phase.into();
                let (t, dup) = ctx.spawn_child(child)?;
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
        });
        sched.register("family", "done", |ctx| {
            Ok(Transition::Complete(json!(
                ctx.children.iter().filter(|t| t.status == TaskStatus::Terminal).count()
            )))
        });
        sched.register("child", "first", move |_| {
            Ok(if mode == WaitMode::FailFast {
                Transition::Fail("rejected".into())
            } else {
                Transition::Complete(Value::Null)
            })
        });
        sched.register("child", "park", |_| {
            Ok(Transition::Sleep {
                phase: "finish".into(),
                checkpoint: None,
                signal: Some("go".into()),
                until_ms: None,
            })
        });
        sched.register("child", "finish", |_| Ok(Transition::Complete(Value::Null)));
        let (parent, _) = sched.start(Task::new("family", "spawn"))?;
        let parked = seen.recv_timeout(MAX).unwrap();
        if mode == WaitMode::AllSettled {
            sched.send_signal(&parked, "go", None, &Value::Null)?;
        }
        let done = sched.wait(&parent.id, MAX)?;
        assert_eq!(done.result, json!(if mode == WaitMode::AllSettled { 2 } else { 1 }));
    }
    Ok(())
}

#[test]
fn process_exit_boundary() {
    let Ok(path) = env::var("VV_DURABLE_CRASH_DB") else { return };
    let store = Store::open(Path::new(&path)).unwrap();
    let scheduler = Scheduler::new(store.clone(), 1);
    scheduler.register("work", "run", |tc| {
        tc.checkpoint(&json!({"survived":true}))?;
        tc.store.write(|tx| tx.put_document("conversation", "c", "pi.live", &json!("durable")))?;
        tc.store.put_deferred("conversation", "c", "pi.live", json!("volatile"))?;
        std::process::exit(73)
    });
    let mut t = Task::new("work", "run");
    t.id = "crash-task".into();
    scheduler.start(t).unwrap();
    scheduler.wait("crash-task", MAX).unwrap();
}

#[test]
fn killed_running_phase_reopens_from_checkpoint_without_deferred_tail() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let out = Command::new(env::current_exe().unwrap())
        .args(["--exact", "process_exit_boundary"])
        .env("VV_DURABLE_CRASH_DB", &path)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(73));
    let store = Store::open(&path)?;
    let scheduler = Scheduler::new(store.clone(), 1);
    let interrupted = store.read(|r| r.task("crash-task"))?;
    assert_eq!(interrupted.status, TaskStatus::Running);
    assert_eq!(store.read(|r| r.document("conversation", "c", "pi.live"))?.unwrap().state, json!("durable"));
    scheduler.register("work", "run", |tc| {
        assert_eq!(tc.task.restart_count, 1);
        Ok(Transition::Complete(tc.task.checkpoint.clone()))
    });
    scheduler.recover()?;
    assert_eq!(scheduler.wait("crash-task", MAX)?.result, json!({"survived":true}));
    Ok(())
}

#[test]
fn circuit_breaker_settles_children_before_parent_and_emits_one_alert() -> Result<()> {
    let store = Store::memory()?;
    for (task, owner) in [("root", ""), ("child", "root"), ("grandchild", "child"), ("model", "")] {
        let mut t = Task::new("work", "run");
        t.id = task.into();
        t.owner_task_id = owner.into();
        t.is_model_task = task == "model";
        t.restart_count = 4;
        t.status = if owner.is_empty() { TaskStatus::Running } else { TaskStatus::Sleeping };
        store.write(|tx| tx.create_task(t))?;
    }
    let scheduler = Scheduler::new(store.clone(), 2);
    scheduler.register("work", "run", |_| Ok(Transition::Complete(json!("resumed"))));
    scheduler.recover()?;
    let t = scheduler.wait("root", MAX)?;
    assert_eq!(t.terminal_reason, "restart_limit");
    assert_eq!(scheduler.abort_trace(), ["grandchild", "child", "root"]);
    assert_eq!(scheduler.wait("model", MAX)?.result, json!("resumed"));
    assert_eq!(
        store.read(|r| r.document("global", "inbox", "pi.inbox"))?.unwrap().state["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    Ok(())
}

#[test]
fn rust_resumes_go_records_and_appends_to_the_same_ledger() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("go.db");
    let store = Store::open(&path)?;
    execute(&path, include_str!("fixtures/go-store.sql"))?;
    store.read(|r| {
        assert_eq!(r.visible_entries("branch")?.len(), 2);
        let root = r.visible_entries("from-go")?;
        assert_eq!(root.iter().map(|e| e.seq).collect::<Vec<_>>(), [7, 4, 5, 6]);
        assert_eq!(root[0].payload["summary"], "three earlier turns");
        assert_eq!(r.document("global", "x", "pi.governance")?.unwrap().state["budget"], 42);
        Ok(())
    })?;
    let sched = Scheduler::new(store.clone(), 1);
    sched.register("answer", "resumed", |ctx| {
        let s = ctx.signal.as_ref().unwrap();
        assert_eq!(s.signal_key, "question");
        assert_eq!(s.payload["result"]["ok"], true);
        ctx.store.write(|tx| tx.append_entry("from-go", "pi.assistant", &json!("reply")))?;
        Ok(Transition::Complete(json!("answer")))
    });
    sched.recover()?;
    assert_eq!(sched.wait("p", MAX)?.result, json!("answer"));
    store.read(|r| {
        assert_eq!(r.entries("from-go", 8)?[0].payload, json!("reply"));
        let signals = r.signals("p", true)?;
        assert_eq!(signals.len(), 1);
        assert!(signals[0].consumed);
        assert_eq!(r.submission_by_request("from-go", "request")?.unwrap().id, "question");
        Ok(())
    })
}

#[test]
fn cancellation_wakes_blocked_phase_and_ignores_late_completion() -> Result<()> {
    let s = Store::memory()?;
    let scheduler = Scheduler::new(s.clone(), 1);
    let (started, seen) = flume::bounded(1);
    scheduler.register("io", "run", move |ctx| {
        started.send(()).unwrap();
        ctx.cancellation().recv_timeout(MAX).unwrap_err();
        assert!(ctx.is_cancelled());
        Ok(Transition::Complete(json!("late")))
    });
    let (task, _) = scheduler.start(Task::new("io", "run"))?;
    seen.recv_timeout(MAX).unwrap();
    scheduler.abort(&task.id)?;
    scheduler.close();
    let final_task = s.read(|r| r.task(&task.id))?;
    assert_eq!(final_task.terminal_reason, "aborted");
    assert_ne!(final_task.result, json!("late"));
    Ok(())
}

#[test]
fn advancing_clock_wakes_sleepers_and_leaves_the_pool_free() -> Result<()> {
    let clock = Arc::new(AtomicI64::new(10));
    let now = clock.clone();
    let s = Store::open_with_clock(None, move || now.load(Ordering::Relaxed))?;
    let scheduler = Scheduler::new(s.clone(), 1);
    let (entered, rx) = flume::unbounded();
    scheduler.register("park", "wait", |_| {
        Ok(Transition::Sleep {
            phase: "done".into(),
            checkpoint: None,
            until_ms: Some(120000),
            signal: None,
        })
    });
    scheduler.register("park", "done", |_| Ok(Transition::Complete(json!("awoke"))));
    scheduler.register("barrier", "done", move |_| {
        entered.send(()).unwrap();
        Ok(Transition::Complete(Value::Null))
    });
    let tasks = (0..30)
        .map(|_| scheduler.start(Task::new("park", "wait")).map(|(t, _)| t.id))
        .collect::<Result<Vec<_>>>()?;
    let (last, _) = scheduler.start(Task::new("barrier", "done"))?;
    rx.recv_timeout(MAX).unwrap();
    scheduler.wait(&last.id, MAX)?;
    assert_eq!(s.read(|r| r.tasks_by_status(TaskStatus::Sleeping))?.len(), 30);
    clock.store(120001, Ordering::Relaxed);
    scheduler.wake();
    for t in tasks {
        assert_eq!(scheduler.wait(&t, MAX)?.result, json!("awoke"));
    }
    Ok(())
}

#[test]
fn wal_read_keeps_the_last_committed_snapshot_during_a_paired_write() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let store = Store::open(&path)?;
    store.write(|tx| tx.put_document("global", "desk", "pi.agent", &json!("old")))?;
    let (held, started) = flume::bounded(0);
    let (allow, await_commit) = flume::bounded(0);
    thread::scope(|scope| -> Result<()> {
        let writer = store.clone();
        let writing = scope.spawn(move || {
            writer.write(|tx| {
                tx.put_document("global", "desk", "pi.agent", &json!("new"))?;
                held.send(()).unwrap();
                await_commit.recv_timeout(MAX).unwrap();
                Ok(())
            })
        });
        started.recv_timeout(MAX).unwrap();
        assert_eq!(store.read(|r| r.document("global", "desk", "pi.agent"))?.unwrap().state, json!("old"));
        allow.send(()).unwrap();
        writing.join().unwrap()?;
        Ok(())
    })?;
    assert_eq!(store.read(|r| r.document("global", "desk", "pi.agent"))?.unwrap().state, json!("new"));
    Ok(())
}

#[test]
fn regression_domain_write_and_settlement_share_the_outer_commit() -> Result<()> {
    let dir = tempdir().unwrap();
    let file = dir.path().join("server.db");
    let store = Store::open(&file)?;
    execute(
        &file,
        "CREATE TABLE expected_result (id TEXT PRIMARY KEY);
        CREATE TABLE domain_result (id TEXT PRIMARY KEY REFERENCES expected_result(id) DEFERRABLE INITIALLY DEFERRED);",
    )?;
    let (submission, _) = store.write(|tx| tx.submit("issue-followup", "reply", "prompt", &json!({}), None))?;
    let events = store.subscribe_documents()?;
    let settle = || {
        store.write(|tx| {
            tx.connection()
                .query(async |db| sqlx::query("INSERT INTO domain_result VALUES ('run')").execute(db).await.map(|_| ()))?;
            tx.settle(&submission.id, SubmissionStatus::Done, &json!("delivered"))?;
            tx.put_document("run", "run", "issue.report", &json!("report"))?;
            Ok(())
        })
    };
    assert!(settle().is_err());
    assert!(events.try_recv().is_err());
    assert_eq!(store.read(|r| r.submission(&submission.id))?.status, SubmissionStatus::Queued);
    assert!(store.read(|r| r.document("run", "run", "issue.report"))?.is_none());

    execute(&file, "INSERT INTO expected_result VALUES ('run')")?;
    settle()?;
    assert_eq!(events.try_recv().unwrap().document.state, json!("report"));
    assert!(events.try_recv().is_err());
    store.close()?;
    let reopened = Store::open(&file)?;
    assert_eq!(reopened.read(|r| r.submission(&submission.id))?.result, json!("delivered"));
    assert_eq!(reopened.read(|r| r.document("run", "run", "issue.report"))?.unwrap().state, json!("report"));
    let domain_rows: i64 = pollster::block_on(async {
        let mut db = SqliteConnectOptions::new().filename(&file).read_only(true).connect().await?;
        sqlx::query_scalar("SELECT COUNT(*) FROM domain_result").fetch_one(&mut db).await
    })?;
    assert_eq!(domain_rows, 1);
    Ok(())
}
