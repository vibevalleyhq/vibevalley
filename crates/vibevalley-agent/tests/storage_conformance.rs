//! Cross-backend storage conformance tests for `SqliteStorage`, `MemoryStorage`,
//! `JsonlStorage` (including crash repair, torn lines, read-only snapshots,
//! and full agent harness workflows), and custom external backends.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::tempdir;
use vibevalley_agent::core::engine::{BrainProvider, KIND as GENERATION_KIND};
use vibevalley_agent::core::tool::{Tool, ToolOutput};
use vibevalley_agent::durable::conformance::{run_clocked_live_conformance, run_reopen_conformance, run_storage_conformance};
use vibevalley_agent::durable::{
    CommitStats, Document, DocumentEvent, JsonlOptions, MemoryStorage, Result as DurableResult, SqliteStorage, StorageBackend, StorageRead, Store, TaskStatus,
    WriteCallback,
};
use vibevalley_agent::experiments::ExperimentFlags;
use vibevalley_agent::extensions::OarPolicy;
use vibevalley_agent::harness::Harness;
use vibevalley_agent::tools::{Workspace, coding_tools};
use vibevalley_agent::{Brain, ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Result as AiResult, Role, ToolCall, ToolSpec, Usage};
use vibevalley_oar::Registry;
use vibevalley_oar::scripted::{Script, ScriptedRuntime, Step};

const WAIT: Duration = Duration::from_secs(10);

#[test]
fn sqlite_storage_passes_conformance() -> DurableResult<()> {
    run_storage_conformance(|| Ok(Store::from_backend(Arc::new(SqliteStorage::memory()?))))?;
    run_clocked_live_conformance(|clock| Ok(Store::from_backend(Arc::new(SqliteStorage::open_with_clock(None, move || clock())?))))?;
    let dir = tempdir().unwrap();
    let db = dir.path().join("server.db");
    run_reopen_conformance(|| Store::open(&db))?;
    Ok(())
}

#[test]
fn memory_storage_passes_conformance() -> DurableResult<()> {
    run_storage_conformance(|| Ok(Store::from_backend(Arc::new(MemoryStorage::new()))))?;
    run_clocked_live_conformance(|clock| Ok(Store::from_backend(Arc::new(MemoryStorage::with_clock(move || clock())))))?;
    Ok(())
}

#[test]
fn jsonl_storage_passes_conformance() -> DurableResult<()> {
    let root = tempdir().unwrap();
    let mut seq = 0usize;
    run_storage_conformance(|| {
        seq += 1;
        Store::jsonl_with_options(
            &root.path().join(format!("conf-{seq}")),
            JsonlOptions {
                fsync: false,
                read_only: false,
            },
        )
    })?;

    let live_root = tempdir().unwrap();
    let live_dir = live_root.path().join("live");
    run_clocked_live_conformance(|clock| {
        Store::jsonl_with_clock(
            &live_dir,
            JsonlOptions {
                fsync: false,
                read_only: false,
            },
            move || clock(),
        )
    })?;

    let reopen_root = tempdir().unwrap();
    let reopen_dir = reopen_root.path().join("reopen");
    run_reopen_conformance(|| Store::jsonl(&reopen_dir))?;
    Ok(())
}

#[test]
fn jsonl_crash_repair_truncates_torn_lines_and_discards_uncommitted_sidecars() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let store = Store::jsonl(dir.path())?;
    store.write(|tx| {
        tx.create_conversation("worker:vv-1", "deepseek-flash")?;
        tx.append_entry("worker:vv-1", "pi.user", &json!({"text": "committed"}))?;
        tx.put_document("conversation", "worker:vv-1", "pi.state", &json!({"ok": true}))?;
        Ok(())
    })?;
    store.close()?;
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
    recovered.read(|r| {
        assert_eq!(r.entries("worker:vv-1", 1)?.len(), 1);
        assert_eq!(r.document("conversation", "worker:vv-1", "pi.state")?.unwrap().state, json!({"ok": true}));
        assert!(r.document("conversation", "worker:vv-1", "pi.uncommitted")?.is_none());
        Ok(())
    })?;

    // Writing a new transaction after repair works and preserves special conversation IDs.
    recovered.write(|tx| {
        tx.create_conversation("subagent:gen-1/step:2", "deepseek-flash")?;
        let e = tx.append_entry("worker:vv-1", "pi.assistant", &json!({"text": "resumed"}))?;
        assert_eq!(e.seq, 2);
        Ok(())
    })?;
    recovered.read(|r| {
        assert_eq!(r.entries("worker:vv-1", 1)?.len(), 2);
        assert_eq!(r.conversation("subagent:gen-1/step:2")?.provider_affinity, "deepseek-flash");
        Ok(())
    })?;

    // Verify repaired files no longer contain partial/uncommitted tx 999 lines.
    assert!(!fs::read_to_string(dir.path().join("docs.jsonl")).unwrap().contains("\"tx\":999"));
    assert!(!fs::read_to_string(dir.path().join("commits.jsonl")).unwrap().contains("\"tx\":999"));
    recovered.close()?;
    Ok(())
}

#[test]
fn jsonl_read_only_tracks_committed_snapshots_without_mutating_files_and_lock_prevents_double_writer() -> DurableResult<()> {
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

    writer.write(|tx| {
        tx.create_conversation("c1", "deepseek-flash")?;
        tx.append_entry("c1", "pi.user", &json!({"text": "one"}))?;
        Ok(())
    })?;

    // Concurrent read-only reader sees committed state.
    let reader = Store::jsonl_read_only(dir.path())?;
    assert!(reader.is_read_only());
    assert_eq!(reader.read(|r| r.entries("c1", 1))?.len(), 1);
    assert!(reader.write(|tx| tx.put_document("global", "g", "pi.x", &json!(1))).is_err());
    assert!(reader.put_deferred("conversation", "c1", "pi.live", json!("no")).is_err());

    // Writer commits another transaction; read-only viewer picks it up on next read.
    writer.write(|tx| {
        tx.append_entry("c1", "pi.assistant", &json!({"text": "two"}))?;
        Ok(())
    })?;
    assert_eq!(reader.read(|r| r.entries("c1", 1))?.len(), 2);

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
    reader.read(|r| {
        assert!(r.document("global", "g", "pi.ghost")?.is_none());
        assert_eq!(r.entries("c1", 1)?.len(), 2);
        Ok(())
    })?;
    assert_eq!(fs::read(dir.path().join("commits.jsonl")).unwrap(), raw_commits_before);

    reader.close()?;
    writer.close()?;

    // Once writer closes and releases `.lock`, a new writer can open cleanly.
    let writer2 = Store::jsonl(dir.path())?;
    assert_eq!(writer2.read(|r| r.entries("c1", 1))?.len(), 2);
    writer2.close()?;
    Ok(())
}

struct StubClient(Mutex<VecDeque<Completion>>);

impl StubClient {
    fn new(replies: Vec<Completion>) -> Arc<Self> {
        Arc::new(Self(Mutex::new(replies.into())))
    }
}

impl ModelClient for StubClient {
    fn complete(&self, _: &ChatRequest, on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
        let c = self.0.lock().unwrap().pop_front().expect("stub reply");
        if let Some(t) = &c.message.content {
            on(Delta::Text(t.clone()));
        }
        Ok(c)
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

    fn execute(&self, _: &Value) -> ToolOutput {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        ToolOutput::ok("touched")
    }
}

struct StaticBrain {
    client: Arc<dyn ModelClient>,
    cwd: Option<std::path::PathBuf>,
    tools_fn: Arc<dyn Fn() -> Vec<Box<dyn Tool>> + Send + Sync>,
}

impl BrainProvider for StaticBrain {
    fn resolve_brain(&self, _: &str, provider: &str) -> DurableResult<Option<Arc<Brain>>> {
        let mut b = Brain::new(self.client.clone(), provider, "Test system");
        b.cwd = self.cwd.clone();
        b.tools = (self.tools_fn)();
        Ok(Some(Arc::new(b)))
    }
}

#[test]
fn full_agent_harness_runs_end_to_end_on_memory_and_jsonl_with_crash_recovery() -> DurableResult<()> {
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
    mem_harness.recover()?;
    let (_, task, _) = mem_harness.conversation("mem-conv").prompt("deepseek-flash", "r1", "run script", "sys")?;
    let done = mem_harness.scheduler().wait(&task.id, WAIT)?;
    assert_eq!(done.result["output"], "mem done");
    mem_harness.close();
    mem_harness.store().close()?;

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
    let gen_id = h1.store().write(|tx| {
        tx.create_conversation("jsonl-conv", "deepseek-flash")?;
        tx.append_entry("jsonl-conv", "pi.user", &json!({"text": "run unsafe"}))?;
        tx.append_entry(
            "jsonl-conv",
            "pi.assistant",
            &json!({
                "text": null,
                "toolCalls": [{"id": "call-unsafe", "toolName": "touch_file", "argsJson": {}}]
            }),
        )?;
        let (sub, _) = tx.submit("jsonl-conv", "req-crash", "prompt", &json!({"text": "run unsafe"}), None)?;

        let mut child = vibevalley_agent::durable::Task::new("pi.tool", "run");
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
        tx.create_task(child)?;

        let mut parent = vibevalley_agent::durable::Task::new(GENERATION_KIND, "tool_join");
        parent.id = "gen-crashed".into();
        parent.conversation_id = "jsonl-conv".into();
        parent.is_model_task = true;
        parent.status = TaskStatus::Waiting;
        parent.wait_mode = Some(vibevalley_agent::durable::WaitMode::AllSettled);
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
        let (p, _) = tx.create_task(parent)?;
        Ok(p.id)
    })?;
    h1.close();
    h1.store().close()?;
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
    h2.recover()?;
    let done = h2.scheduler().wait(&gen_id, WAIT)?;
    assert_eq!(done.result["output"], "inspected interruption");
    assert_eq!(
        runs.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "unsafe tool must not replay on JSONL recovery"
    );
    let entries = h2.entries("jsonl-conv")?;
    assert!(
        entries
            .iter()
            .any(|e| e.kind == "pi.tool_result" && e.payload["ok"] == false && e.payload["error"].as_str().unwrap_or_default().contains("interrupted"))
    );
    h2.close();
    h2.store().close()?;
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
    fn read_dyn(&self, f: &mut dyn FnMut(&dyn StorageRead) -> DurableResult<()>) -> DurableResult<()> {
        self.0.read_dyn(f)
    }
    fn write_dyn(&self, f: &mut WriteCallback<'_>) -> DurableResult<()> {
        self.0.write_dyn(f)
    }
    fn stats(&self) -> CommitStats {
        self.0.stats()
    }
    fn subscribe_documents(&self) -> DurableResult<flume::Receiver<DocumentEvent>> {
        self.0.subscribe_documents()
    }
    fn subscribe_tasks(&self) -> DurableResult<flume::Receiver<()>> {
        self.0.subscribe_tasks()
    }
    fn put_deferred(&self, scope: &str, id: &str, kind: &str, state: Value) -> DurableResult<()> {
        self.0.put_deferred(scope, id, kind, state)
    }
    fn flush_due(&self) -> DurableResult<()> {
        self.0.flush_due()
    }
    fn flush_deferred(&self) -> DurableResult<()> {
        self.0.flush_deferred()
    }
    fn live_document(&self, scope: &str, id: &str) -> DurableResult<Option<Document>> {
        self.0.live_document(scope, id)
    }
    fn close(&self) -> DurableResult<()> {
        self.0.close()
    }
}

#[test]
fn custom_third_party_storage_backend_passes_conformance() -> DurableResult<()> {
    run_storage_conformance(|| {
        let store = Store::from_backend(Arc::new(CustomMemoryWrapper(MemoryStorage::new())));
        assert_eq!(store.backend_kind(), "custom-test");
        Ok(store)
    })
}
