//! Cross-backend storage conformance tests for `SeaOrmStorage` (SQLite + PostgreSQL),
//! `MemoryStorage`, `JsonlStorage` (including crash repair, torn lines, read-only snapshots,
//! and full agent harness workflows), and custom external backends.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use tempfile::tempdir;
use vibevalley_runtime::agent::core::engine::{BrainProvider, KIND as GENERATION_KIND, Request};
use vibevalley_runtime::agent::core::tool::{Tool, ToolOutput};
use vibevalley_runtime::agent::durable::conformance::{run_reopen_conformance, run_storage_conformance};
use vibevalley_runtime::agent::durable::{
    BoxFuture, CommitStats, DocumentEvent, JsonlOptions, MemoryStorage, ReadAsyncOp, Result as DurableResult, StorageBackend, Store, TaskStatus,
    TelemetryEvent, TelemetrySink, WriteAsyncOp,
};
use vibevalley_runtime::agent::experiments::ExperimentFlags;
use vibevalley_runtime::agent::extensions::OarPolicy;
use vibevalley_runtime::agent::harness::Harness;
use vibevalley_runtime::agent::tools::{Workspace, coding_tools};
use vibevalley_runtime::agent::{
    Brain, ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Result as AiResult, Role, ToolCall, ToolSpec, Usage,
};
use vibevalley_runtime::oar::Registry;
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};

const WAIT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn sea_orm_sqlite_storage_passes_conformance() -> DurableResult<()> {
    run_storage_conformance(Store::sqlite_memory).await?;
    let dir = tempdir().unwrap();
    let db = dir.path().join("seaorm.db");
    run_reopen_conformance(|| Store::open(&db)).await?;

    // Verify Tx::transaction() / Tx::db_tx() runs in the same atomic transaction on SeaOrmStorage.
    let store = Store::open(&db).await?;
    let res: DurableResult<()> = store
        .write_async(|tx| {
            Box::pin(async move {
                let db_tx = tx.transaction();
                assert_eq!(db_tx.get_database_backend(), sea_orm::DbBackend::Sqlite);
                tx.put_document_async("global", "seaorm-tx", "pi.aborted", &json!({"ok": false})).await?;
                Err(vibevalley_runtime::agent::durable::Error::Invalid("rollback".into()))
            })
        })
        .await;
    assert!(res.is_err());
    assert!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("global", "seaorm-tx", "pi.aborted").await }))
            .await?
            .is_none()
    );
    store.close().await?;
    Ok(())
}

#[cfg(feature = "postgres")]
struct EphemeralPostgres {
    data_dir: std::path::PathBuf,
    pg_ctl: std::path::PathBuf,
    port: u16,
    _temp: tempfile::TempDir,
}

#[cfg(feature = "postgres")]
impl EphemeralPostgres {
    fn start() -> Option<Self> {
        let initdb = ["/opt/homebrew/bin/initdb", "/usr/local/bin/initdb"]
            .into_iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.is_file())?;
        let pg_ctl = ["/opt/homebrew/bin/pg_ctl", "/usr/local/bin/pg_ctl"]
            .into_iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.is_file())?;

        let temp = tempdir().ok()?;
        let data_dir = temp.path().join("pgdata");
        let sock_dir = temp.path().join("sock");
        fs::create_dir_all(&sock_dir).ok()?;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        drop(listener);

        let init = std::process::Command::new(&initdb)
            .arg("-D")
            .arg(&data_dir)
            .args(["--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-sync"])
            .output()
            .ok()?;
        assert!(init.status.success(), "initdb failed: {}", String::from_utf8_lossy(&init.stderr));

        let conf = format!(
            "\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = '{}'\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n",
            sock_dir.display()
        );
        OpenOptions::new()
            .append(true)
            .open(data_dir.join("postgresql.conf"))
            .unwrap()
            .write_all(conf.as_bytes())
            .unwrap();

        let log = temp.path().join("postgres.log");
        let start = std::process::Command::new(&pg_ctl)
            .arg("-D")
            .arg(&data_dir)
            .arg("-l")
            .arg(&log)
            .args(["-w", "start"])
            .output()
            .ok()?;
        assert!(
            start.status.success(),
            "pg_ctl start failed: {}\nlog:\n{}",
            String::from_utf8_lossy(&start.stderr),
            fs::read_to_string(&log).unwrap_or_default()
        );

        Some(Self {
            data_dir,
            pg_ctl,
            port,
            _temp: temp,
        })
    }

    fn admin_url(&self) -> String {
        format!("postgres://postgres@127.0.0.1:{}/postgres", self.port)
    }

    fn db_url(&self, db_name: &str) -> String {
        format!("postgres://postgres@127.0.0.1:{}/{}", self.port, db_name)
    }

    async fn create_database(&self, db_name: &str) {
        use sea_orm::{ConnectionTrait, Database};
        let db = Database::connect(&self.admin_url()).await.expect("connect postgres admin db");
        db.execute_unprepared(&format!("CREATE DATABASE \"{db_name}\""))
            .await
            .expect("create test database");
        db.close().await.expect("close admin db");
    }
}

#[cfg(feature = "postgres")]
impl Drop for EphemeralPostgres {
    fn drop(&mut self) {
        let _ = std::process::Command::new(&self.pg_ctl)
            .arg("-D")
            .arg(&self.data_dir)
            .args(["-m", "immediate", "-w", "stop"])
            .output();
    }
}

#[cfg(feature = "postgres")]
#[tokio::test]
async fn sea_orm_postgres_storage_passes_conformance() -> DurableResult<()> {
    let Some(pg) = EphemeralPostgres::start() else {
        eprintln!("skipping sea_orm_postgres_storage_passes_conformance: Homebrew initdb/pg_ctl not found");
        return Ok(());
    };

    let mut seq = 0usize;
    run_storage_conformance(|| {
        seq += 1;
        let db_name = format!("durable_conf_{seq}");
        let pg = &pg;
        async move {
            pg.create_database(&db_name).await;
            let store = Store::connect(&pg.db_url(&db_name)).await?;
            assert_eq!(store.backend_kind(), "postgres");
            Ok(store)
        }
    })
    .await?;

    pg.create_database("durable_reopen").await;
    let reopen_url = pg.db_url("durable_reopen");
    run_reopen_conformance(|| Store::connect(&reopen_url)).await?;

    // Verify Tx::transaction() executes inside the same PostgreSQL transaction as durable ops,
    // including native async `write_async` / `read_async` + savepoint recovery (`25P02`) + rollback.
    let store = Store::connect(&reopen_url).await?;
    let err: DurableResult<()> = store
        .write_async(|tx| {
            Box::pin(async move {
                let db_tx = tx.transaction();
                assert_eq!(db_tx.get_database_backend(), sea_orm::DbBackend::Postgres);
                tx.put_document_async("global", "pg-tx", "pi.aborted", &json!({"ok": false})).await?;
                Err(vibevalley_runtime::agent::durable::Error::Invalid("rollback".into()))
            })
        })
        .await;
    assert!(err.is_err());
    assert!(
        store
            .read_async(|r| Box::pin(async move { r.document_async("global", "pg-tx", "pi.aborted").await }))
            .await?
            .is_none()
    );

    verify_async_store_tx(&store, sea_orm::DbBackend::Postgres).await?;
    store.close().await?;
    Ok(())
}

async fn verify_async_store_tx(store: &Store, expected_backend: sea_orm::DbBackend) -> DurableResult<()> {
    let err: DurableResult<()> = store
        .write_async(|tx| {
            Box::pin(async move {
                let db_tx = tx.transaction();
                assert_eq!(db_tx.get_database_backend(), expected_backend);
                sea_orm::ConnectionTrait::execute_unprepared(db_tx, "SELECT 1").await?;
                tx.create_conversation_async("async-conv-aborted", "deepseek-flash").await?;
                tx.put_document_async("global", "async-tx", "pi.aborted", &json!({"ok": false})).await?;
                Err(vibevalley_runtime::agent::durable::Error::Invalid("async rollback".into()))
            })
        })
        .await;
    assert!(err.is_err());
    assert!(
        store
            .read_async(|r| Box::pin(r.document_async("global", "async-tx", "pi.aborted")))
            .await?
            .is_none()
    );

    // Trigger duplicate conversation constraint inside `write_async` and verify outer tx commits via savepoint (`25P02`).
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("async-conv-1", "deepseek-flash").await?;
                let dup = tx.create_conversation_async("async-conv-1", "deepseek-flash").await;
                assert!(dup.is_err());
                let entry = tx.append_entry_async("async-conv-1", "pi.user", &json!({"text": "after-savepoint"})).await?;
                assert_eq!(entry.seq, 1);
                tx.put_document_async("global", "async-tx", "pi.committed", &json!({"ok": true})).await?;
                Ok(())
            })
        })
        .await?;

    let saved = store
        .read_async(|r| {
            Box::pin(async move {
                let entries = r.entries_async("async-conv-1", 1).await?;
                let doc = r.document_async("global", "async-tx", "pi.committed").await?;
                Ok((entries, doc))
            })
        })
        .await?;
    assert_eq!(saved.0.len(), 1);
    assert_eq!(saved.1.unwrap().state, json!({"ok": true}));
    Ok(())
}

#[tokio::test]
async fn memory_storage_passes_conformance() -> DurableResult<()> {
    run_storage_conformance(|| std::future::ready(Ok(Store::from_backend(Arc::new(MemoryStorage::new()))))).await?;
    Ok(())
}

#[tokio::test]
async fn jsonl_storage_passes_conformance() -> DurableResult<()> {
    let root = tempdir().unwrap();
    let mut seq = 0usize;
    run_storage_conformance(|| {
        seq += 1;
        let p = root.path().join(format!("conf-{seq}"));
        std::future::ready(Store::jsonl_with_options(
            &p,
            JsonlOptions {
                fsync: false,
                read_only: false,
            },
        ))
    })
    .await?;

    let reopen_root = tempdir().unwrap();
    let reopen_dir = reopen_root.path().join("reopen");
    run_reopen_conformance(|| std::future::ready(Store::jsonl(&reopen_dir))).await?;
    Ok(())
}

#[tokio::test]
async fn jsonl_crash_repair_truncates_torn_lines_and_discards_uncommitted_sidecars() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let store = Store::jsonl(dir.path())?;
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("worker:vv-1", "deepseek-flash").await?;
                tx.append_entry_async("worker:vv-1", "pi.user", &json!({"text": "committed"})).await?;
                tx.put_document_async("conversation", "worker:vv-1", "pi.state", &json!({"ok": true})).await?;
                Ok(())
            })
        })
        .await?;
    store.close().await?;
    drop(store);

    // Simulate a process crash mid-commit:
    // 1) uncommitted op appended to docs.jsonl (`tx: 999`)
    // 2) torn partial line in conversations/worker%3Avv-1.jsonl
    // 3) torn trailing JSON line in commits.jsonl
    OpenOptions::new()
        .append(true)
        .open(dir.path().join("docs.jsonl"))
        .unwrap()
        .write_all(br#"{"tx":999,"opSeq":0,"op":"putDocument","scope_kind":"conversation","scope_id":"worker:vv-1","doc_kind":"pi.uncommitted","rev":1,"state":{"bad":1},"updated_at_ms":123}
"#)
        .unwrap();
    let conv_file = dir.path().join("conversations").join("worker%3Avv-1.jsonl");
    assert!(conv_file.is_file(), "percent-encoded conversation sidecar must exist");
    OpenOptions::new()
        .append(true)
        .open(&conv_file)
        .unwrap()
        .write_all(br#"{"tx":999,"opSeq":1,"op":"insertEntry","entry":{"conversationId":"worker:vv-1","seq":2,"kind":"pi.user","payload":{}"#)
        .unwrap();
    OpenOptions::new()
        .append(true)
        .open(dir.path().join("commits.jsonl"))
        .unwrap()
        .write_all(br#"{"tx":999,"atMs":123,"opCount":2"#)
        .unwrap();

    // Opening writable repairs torn lines and strips uncommitted records cleanly.
    let recovered = Store::jsonl(dir.path())?;
    recovered
        .read_async(|r| {
            Box::pin(async move {
                assert_eq!(r.entries_async("worker:vv-1", 1).await?.len(), 1);
                assert_eq!(
                    r.document_async("conversation", "worker:vv-1", "pi.state").await?.unwrap().state,
                    json!({"ok": true})
                );
                assert!(r.document_async("conversation", "worker:vv-1", "pi.uncommitted").await?.is_none());
                Ok(())
            })
        })
        .await?;

    // Writing a new transaction after repair works and preserves special conversation IDs.
    recovered
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("subagent:gen-1/step:2", "deepseek-flash").await?;
                let e = tx.append_entry_async("worker:vv-1", "pi.assistant", &json!({"text": "resumed"})).await?;
                assert_eq!(e.seq, 2);
                Ok(())
            })
        })
        .await?;
    recovered
        .read_async(|r| {
            Box::pin(async move {
                assert_eq!(r.entries_async("worker:vv-1", 1).await?.len(), 2);
                assert_eq!(r.conversation_async("subagent:gen-1/step:2").await?.provider_affinity, "deepseek-flash");
                Ok(())
            })
        })
        .await?;

    // Verify repaired files no longer contain partial/uncommitted tx 999 lines.
    assert!(!fs::read_to_string(dir.path().join("docs.jsonl")).unwrap().contains("\"tx\":999"));
    assert!(!fs::read_to_string(dir.path().join("commits.jsonl")).unwrap().contains("\"tx\":999"));
    recovered.close().await?;
    Ok(())
}

#[tokio::test]
async fn jsonl_read_only_tracks_committed_snapshots_without_mutating_files_and_lock_prevents_double_writer() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let writer = Store::jsonl_with_options(
        dir.path(),
        JsonlOptions {
            fsync: false,
            read_only: false,
        },
    )?;

    // Second writable open on the same directory must fail because `.lock` is held.
    assert!(Store::jsonl(dir.path()).is_err());

    writer
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("c1", "deepseek-flash").await?;
                tx.append_entry_async("c1", "pi.user", &json!({"text": "one"})).await?;
                Ok(())
            })
        })
        .await?;

    // Concurrent read-only reader sees committed state.
    let reader = Store::jsonl_read_only(dir.path())?;
    assert!(reader.is_read_only());
    assert_eq!(reader.read_async(|r| Box::pin(async move { r.entries_async("c1", 1).await })).await?.len(), 1);
    assert!(
        reader
            .write_async(|tx| Box::pin(async move { tx.put_document_async("global", "g", "pi.x", &json!(1)).await }))
            .await
            .is_err()
    );

    // Writer commits another transaction; read-only viewer picks it up on next read.
    writer
        .write_async(|tx| {
            Box::pin(async move {
                tx.append_entry_async("c1", "pi.assistant", &json!({"text": "two"})).await?;
                Ok(())
            })
        })
        .await?;
    assert_eq!(reader.read_async(|r| Box::pin(async move { r.entries_async("c1", 1).await })).await?.len(), 2);

    // Even if an uncommitted sidecar op or torn commit line appears on disk, read-only does NOT mutate disk and ignores uncommitted ops.
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.path().join("docs.jsonl"))
        .unwrap()
        .write_all(
            br#"{"tx":888,"opSeq":0,"op":"putDocument","scope_kind":"global","scope_id":"g","doc_kind":"pi.ghost","rev":1,"state":{},"updated_at_ms":1}
"#,
        )
        .unwrap();
    OpenOptions::new()
        .append(true)
        .open(dir.path().join("commits.jsonl"))
        .unwrap()
        .write_all(br#"{"tx":888"#)
        .unwrap();
    let raw_commits_before = fs::read(dir.path().join("commits.jsonl")).unwrap();
    reader
        .read_async(|r| {
            Box::pin(async move {
                assert!(r.document_async("global", "g", "pi.ghost").await?.is_none());
                assert_eq!(r.entries_async("c1", 1).await?.len(), 2);
                Ok(())
            })
        })
        .await?;
    assert_eq!(fs::read(dir.path().join("commits.jsonl")).unwrap(), raw_commits_before);

    reader.close().await?;
    writer.close().await?;

    // Once writer closes and releases `.lock`, a new writer can open cleanly.
    let writer2 = Store::jsonl(dir.path())?;
    assert_eq!(writer2.read_async(|r| Box::pin(async move { r.entries_async("c1", 1).await })).await?.len(), 2);
    writer2.close().await?;
    Ok(())
}

struct StubClient(Mutex<VecDeque<Completion>>);

impl StubClient {
    fn new(replies: Vec<Completion>) -> Arc<Self> {
        Arc::new(Self(Mutex::new(replies.into())))
    }
}

impl ModelClient for StubClient {
    fn complete<'a>(&'a self, _: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> BoxFuture<'a, AiResult<Completion>> {
        Box::pin(async move {
            let c = self.0.lock().unwrap().pop_front().expect("stub reply");
            if let Some(t) = &c.message.content {
                on(Delta::Text(t.clone()));
            }
            Ok(c)
        })
    }
}

fn msg(text: Option<&str>, calls: Vec<ToolCall>) -> Completion {
    Completion {
        finish: if calls.is_empty() { FinishReason::Stop } else { FinishReason::ToolCalls },
        message: Message {
            role: Role::Assistant,
            content: text.map(str::to_string),
            reasoning: None,
            tool_calls: calls,
            tool_call_id: None,
        },
        usage: Usage {
            input: 80,
            output: 12,
            cache_read: 0,
        },
    }
}

struct CountingMutTool(Arc<std::sync::atomic::AtomicUsize>);

impl Tool for CountingMutTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "touch_file".into(),
            description: "mutating tool".into(),
            parameters: json!({"type":"object"}),
        }
    }

    fn execute<'a>(&'a self, _: &'a Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            ToolOutput::ok("touched")
        })
    }
}

struct StaticBrain {
    client: Arc<dyn ModelClient>,
    cwd: Option<std::path::PathBuf>,
    tools_fn: Arc<dyn Fn() -> Vec<Box<dyn Tool>> + Send + Sync>,
}

impl BrainProvider for StaticBrain {
    fn resolve_brain<'a>(&'a self, _: &'a str, provider: &'a str) -> BoxFuture<'a, DurableResult<Option<Arc<Brain>>>> {
        Box::pin(async move {
            let mut b = Brain::new(self.client.clone(), provider, "Test system");
            b.cwd = self.cwd.clone();
            b.tools = (self.tools_fn)();
            Ok(Some(Arc::new(b)))
        })
    }
}

#[tokio::test]
async fn full_agent_harness_runs_end_to_end_on_memory_and_jsonl_with_crash_recovery() -> DurableResult<()> {
    // 1) Pure MemoryStorage runs full Harness + Code Mode + OAR workflow.
    let work = tempdir().unwrap();
    fs::write(work.path().join("alpha.txt"), "needle_token\n").unwrap();
    let mut registry = Registry::new();
    registry.register(Arc::new(ScriptedRuntime::new("scripted", Script::new().turn(vec![Step::text("oar checked")]))));
    let js = format!(
        "const g = call('grep', {{ pattern: 'needle_token', path: '.' }}); const o = call('oar_run', {{ runtime: 'scripted', cwd: '{}', prompt: 'hi' }}); g + ' :: ' + o;",
        work.path().display()
    );
    let mem_client = StubClient::new(vec![
        msg(
            None,
            vec![ToolCall {
                id: "c1".into(),
                name: "run_code".into(),
                arguments: json!({ "script": js }).to_string(),
            }],
        ),
        msg(Some("mem done"), vec![]),
    ]);
    let work_dir = work.path().to_path_buf();
    let mem_harness = Harness::from_store(
        Store::memory()?,
        Arc::new(StaticBrain {
            client: mem_client,
            cwd: Some(work_dir.clone()),
            tools_fn: Arc::new(move || coding_tools(&Workspace::new(&work_dir))),
        }),
    );
    mem_harness.with_experiments(
        &ExperimentFlags {
            codemode: true,
            tree_branch: false,
            oar_delegate: true,
        },
        Some((Arc::new(registry), OarPolicy::default())),
    );
    assert_eq!(mem_harness.store().backend_kind(), "memory");
    mem_harness.recover().await?;
    let (_, task, _) = mem_harness
        .submit(Request {
            conversation: "mem-conv",
            provider: "deepseek-flash",
            request_id: "r1",
            prompt: "run script",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .await?;
    let done = mem_harness.scheduler().wait(&task.id, WAIT).await?;
    assert_eq!(done.result["output"], "mem done");
    mem_harness.close().await;
    mem_harness.store().close().await?;

    // 2) JsonlStorage runs full Harness with simulated mid-tool crash and never replays unsafe tool!
    let jsonl_dir = tempdir().unwrap();
    let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let runs_a = runs.clone();
    let runs_b = runs.clone();
    let h1 = Harness::open_jsonl(
        jsonl_dir.path(),
        Arc::new(StaticBrain {
            client: StubClient::new(vec![]),
            cwd: Some(work.path().to_path_buf()),
            tools_fn: Arc::new(move || vec![Box::new(CountingMutTool(runs_a.clone()))]),
        }),
    )?;
    assert_eq!(h1.store().backend_kind(), "jsonl");
    let gen_id = h1
        .store()
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("jsonl-conv", "deepseek-flash").await?;
                tx.append_entry_async("jsonl-conv", "pi.user", &json!({"text": "run unsafe"})).await?;
                tx.append_entry_async(
                    "jsonl-conv",
                    "pi.assistant",
                    &json!({
                        "text": null,
                        "toolCalls": [{"id": "call-unsafe", "toolName": "touch_file", "argsJson": {}}]
                    }),
                )
                .await?;
                let (sub, _) = tx
                    .submit_async("jsonl-conv", "req-crash", "prompt", &json!({"text": "run unsafe"}), None)
                    .await?;

                let mut child = vibevalley_runtime::agent::durable::Task::new("pi.tool", "run");
                child.id = "tool-crashed".into();
                child.conversation_id = "jsonl-conv".into();
                child.owner_task_id = "gen-crashed".into();
                child.status = TaskStatus::Running;
                child.memo = json!({"started": true});
                child.checkpoint = json!({
                    "parentTaskId": "gen-crashed",
                    "step": 1,
                    "call": {"id": "call-unsafe", "name": "touch_file", "arguments": "{}"},
                    "args": {},
                    "prompt": "run unsafe",
                    "submissionId": sub.id,
                    "requestId": "req-crash",
                    "iteration": 0
                });
                tx.create_task_async(child).await?;

                let mut parent = vibevalley_runtime::agent::durable::Task::new(GENERATION_KIND, "tool_join");
                parent.id = "gen-crashed".into();
                parent.conversation_id = "jsonl-conv".into();
                parent.is_model_task = true;
                parent.status = TaskStatus::Waiting;
                parent.wait_mode = Some(vibevalley_runtime::agent::durable::WaitMode::AllSettled);
                parent.wait_task_ids = vec!["tool-crashed".into()];
                parent.checkpoint = json!({
                    "prompt": "run unsafe",
                    "submission": sub.id,
                    "requestId": "req-crash",
                    "calls": [{"id": "call-unsafe", "name": "touch_file", "arguments": "{}"}],
                    "index": 0,
                    "batchCalls": ["tool-crashed"],
                    "step": 1
                });
                let (p, _) = tx.create_task_async(parent).await?;
                Ok(p.id)
            })
        })
        .await?;
    h1.close().await;
    h1.store().close().await?;
    drop(h1);

    let client2 = StubClient::new(vec![msg(Some("inspected interruption"), vec![])]);
    let h2 = Harness::open_jsonl(
        jsonl_dir.path(),
        Arc::new(StaticBrain {
            client: client2,
            cwd: Some(work.path().to_path_buf()),
            tools_fn: Arc::new(move || vec![Box::new(CountingMutTool(runs_b.clone()))]),
        }),
    )?;
    h2.recover().await?;
    let done = h2.scheduler().wait(&gen_id, WAIT).await?;
    assert_eq!(done.result["output"], "inspected interruption");
    assert_eq!(
        runs.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "unsafe tool must not replay on JSONL recovery"
    );
    let entries = h2.entries("jsonl-conv").await?;
    assert!(
        entries
            .iter()
            .any(|e| e.kind == "pi.tool_result" && e.payload["ok"] == false && e.payload["error"].as_str().unwrap_or_default().contains("interrupted"))
    );
    h2.close().await;
    h2.store().close().await?;
    Ok(())
}

/// Custom user-supplied backend wrapper proving any external implementation of `StorageBackend` works seamlessly.
struct CustomMemoryWrapper(MemoryStorage);

impl StorageBackend for CustomMemoryWrapper {
    fn kind(&self) -> &'static str {
        "custom-test"
    }
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
    fn read_dyn_async<'a>(&'a self, op: &'a mut dyn ReadAsyncOp<'a>) -> BoxFuture<'a, DurableResult<()>> {
        self.0.read_dyn_async(op)
    }
    fn write_dyn_async<'a>(&'a self, op: &'a mut dyn WriteAsyncOp<'a>) -> BoxFuture<'a, DurableResult<()>> {
        self.0.write_dyn_async(op)
    }
    fn stats(&self) -> CommitStats {
        self.0.stats()
    }
    fn subscribe_documents(&self) -> DurableResult<tokio::sync::mpsc::UnboundedReceiver<DocumentEvent>> {
        self.0.subscribe_documents()
    }
    fn subscribe_tasks(&self) -> DurableResult<tokio::sync::mpsc::Receiver<()>> {
        self.0.subscribe_tasks()
    }
    fn close(&self) -> BoxFuture<'_, DurableResult<()>> {
        self.0.close()
    }
}

#[tokio::test]
async fn custom_third_party_storage_backend_passes_conformance() -> DurableResult<()> {
    run_storage_conformance(|| {
        let store = Store::from_backend(Arc::new(CustomMemoryWrapper(MemoryStorage::new())));
        assert_eq!(store.backend_kind(), "custom-test");
        std::future::ready(Ok(store))
    })
    .await
}

async fn seed_all_journal_ops(store: &Store) -> DurableResult<()> {
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("conv-1", "deepseek-flash").await?;
                tx.append_entry_async("conv-1", "pi.user", &json!({"text": "seed"})).await?;
                tx.put_document_async("conversation", "conv-1", "pi.state", &json!({"v": 1})).await?;
                tx.submit_async("conv-1", "req-seed", "prompt", &json!({"k": 1}), None).await?;
                let mut task = vibevalley_runtime::agent::durable::Task::new("seed", "init");
                task.id = "task-seed".into();
                task.conversation_id = "conv-1".into();
                task.dedup_key = "dk-seed".into();
                tx.create_task_async(task).await?;
                tx.send_signal_async("task-seed", "sig", Some("k1"), &json!({"n": 1})).await?;
                Ok(())
            })
        })
        .await
}

async fn assert_seed_state_intact(store: &Store, label: &str) -> DurableResult<()> {
    let label = label.to_owned();
    store
        .read_async(move |r| {
            Box::pin(async move {
                assert_eq!(r.conversation_async("conv-1").await?.provider_affinity, "deepseek-flash", "{label}");
                assert_eq!(r.entries_async("conv-1", 1).await?.len(), 1, "{label}");
                assert_eq!(
                    r.document_async("conversation", "conv-1", "pi.state").await?.unwrap().state,
                    json!({"v": 1}),
                    "{label}"
                );
                assert!(r.document_async("conversation", "conv-1", "pi.temp").await?.is_none(), "{label}");
                assert_eq!(r.submissions_async("conv-1").await?.len(), 1, "{label}");
                assert!(r.task_by_dedup_async("", "dk-seed").await?.is_some(), "{label}");
                assert!(r.task_by_dedup_async("", "dk-aborted").await?.is_none(), "{label}");
                assert!(r.conversation_async("conv-aborted").await.is_err(), "{label}");
                let pending = r.signals_async("task-seed", false).await?;
                assert_eq!(pending.len(), 1, "{label}");
                assert_eq!(pending[0].payload, json!({"n": 1}), "{label}");
                Ok(())
            })
        })
        .await
}

async fn apply_uncommitted_mutations(tx: &mut vibevalley_runtime::agent::durable::Tx<'_>) -> DurableResult<()> {
    tx.create_conversation_async("conv-aborted", "deepseek-pro").await?;
    tx.append_entry_async("conv-1", "pi.assistant", &json!({"text": "rolled back"})).await?;
    tx.put_document_async("conversation", "conv-1", "pi.state", &json!({"v": 99})).await?;
    tx.put_document_async("conversation", "conv-1", "pi.temp", &json!({"temp": true})).await?;
    tx.submit_async("conv-1", "req-aborted", "prompt", &json!({"k": 2}), None).await?;
    let mut task = vibevalley_runtime::agent::durable::Task::new("aborted", "init");
    task.id = "task-aborted".into();
    task.conversation_id = "conv-1".into();
    task.dedup_key = "dk-aborted".into();
    tx.create_task_async(task).await?;
    assert!(tx.consume_first_signal_async("task-seed", "sig").await?.is_some());
    tx.send_signal_async("task-seed", "sig", Some("k-aborted"), &json!({"n": 2})).await?;
    Ok(())
}

#[tokio::test]
async fn memory_and_jsonl_undo_rollback_preserves_state_and_indices_on_error_and_panic() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let stores: [(&str, Store); 2] = [
        ("memory", Store::from_backend(Arc::new(MemoryStorage::new()))),
        (
            "jsonl",
            Store::jsonl_with_options(
                dir.path(),
                JsonlOptions {
                    fsync: false,
                    read_only: false,
                },
            )?,
        ),
    ];

    for (label, store) in &stores {
        seed_all_journal_ops(store).await?;
        assert_seed_state_intact(store, label).await?;

        let err = store
            .write_async(|tx| {
                Box::pin(async move {
                    apply_uncommitted_mutations(tx).await?;
                    Err::<(), _>(vibevalley_runtime::agent::durable::Error::Invalid("intentional abort".into()))
                })
            })
            .await;
        assert!(err.is_err(), "{label}");
        assert_seed_state_intact(store, label).await?;

        let panicked = std::panic::AssertUnwindSafe(store.write_async::<(), _>(|tx| {
            Box::pin(async move {
                apply_uncommitted_mutations(tx).await?;
                panic!("boom");
            })
        }))
        .catch_unwind()
        .await;
        assert!(panicked.is_err(), "{label}");
        assert_seed_state_intact(store, label).await?;

        // Signals inserted and consumed after rollbacks still follow strict FIFO order.
        store
            .write_async(|tx| {
                Box::pin(async move {
                    for i in 0..200 {
                        tx.send_signal_async("task-seed", "fifo", None, &json!({ "i": i })).await?;
                    }
                    for i in 0..200 {
                        let sig = tx.consume_first_signal_async("task-seed", "fifo").await?.expect("pending fifo signal");
                        assert_eq!(sig.payload, json!({ "i": i }));
                    }
                    assert!(tx.consume_first_signal_async("task-seed", "fifo").await?.is_none());
                    Ok(())
                })
            })
            .await?;
    }
    Ok(())
}

#[tokio::test]
async fn sqlite_and_memory_and_jsonl_write_async_and_telemetry_flush_parity() -> DurableResult<()> {
    #[derive(Default)]
    struct CaptureTelemetry(Mutex<Vec<TelemetryEvent>>);
    impl TelemetrySink for CaptureTelemetry {
        fn record(&self, event: &TelemetryEvent) {
            self.0.lock().unwrap().push(event.clone());
        }
    }

    let dir = tempdir().unwrap();
    let sqlite_path = dir.path().join("async.db");
    let jsonl_dir = dir.path().join("jsonl");
    let stores: [(&str, Store); 3] = [
        ("sqlite", Store::open(&sqlite_path).await?),
        ("memory", Store::from_backend(Arc::new(MemoryStorage::new()))),
        (
            "jsonl",
            Store::jsonl_with_options(
                &jsonl_dir,
                JsonlOptions {
                    fsync: false,
                    read_only: false,
                },
            )?,
        ),
    ];

    for (label, store) in &stores {
        let sink = Arc::new(CaptureTelemetry::default());
        store.set_telemetry(sink.clone());

        let err: DurableResult<()> = store
            .write_async(|tx| {
                Box::pin(async move {
                    tx.create_conversation_async("c-async", "deepseek-flash").await?;
                    tx.append_entry_async("c-async", "pi.user", &json!({"text": "rolled-back"})).await?;
                    tx.submit_async("c-async", "req-abort", "prompt", &json!({}), None).await?;
                    Err(vibevalley_runtime::agent::durable::Error::Invalid("abort".into()))
                })
            })
            .await;
        assert!(err.is_err(), "{label}");
        assert!(sink.0.lock().unwrap().is_empty(), "{label} telemetry must not flush on rollback");

        store
            .write_async(|tx| {
                Box::pin(async move {
                    tx.create_conversation_async("c-async", "deepseek-flash").await?;
                    tx.append_entry_async("c-async", "pi.user", &json!({"text": "ok"})).await?;
                    let (sub, _) = tx.submit_async("c-async", "req-1", "prompt", &json!({}), None).await?;
                    tx.settle_async(&sub.id, vibevalley_runtime::agent::durable::SubmissionStatus::Done, &json!({"done": true}))
                        .await?;
                    Ok(())
                })
            })
            .await?;

        let entries = store.read_async(|r| Box::pin(r.entries_async("c-async", 1))).await?;
        assert_eq!(entries.len(), 1, "{label}");

        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 3, "{label} expected entry + submit + settle telemetry events");
    }

    verify_async_store_tx(&stores[0].1, sea_orm::DbBackend::Sqlite).await?;
    Ok(())
}
