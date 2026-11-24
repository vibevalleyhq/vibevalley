use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tempfile::tempdir;
use vibevalley_runtime::agent::Result as AiResult;
use vibevalley_runtime::agent::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, ToolCall, Usage};
use vibevalley_runtime::agent::core::doc::{
    CONVERSATION_SCOPE, GovernanceDoc, GovernanceState, PendingApproval, PermissionEvaluation, UsageTotals, read_doc, write_doc,
};
use vibevalley_runtime::agent::core::engine::{BrainProvider, Request};
use vibevalley_runtime::agent::core::events::Brain;
use vibevalley_runtime::agent::core::extension::RubricVerdict;
use vibevalley_runtime::agent::durable::{
    Compaction, ExportOptions, JsonlTelemetrySink, MemoryTelemetrySink, Result as DurableResult, Store, SubmissionStatus, Task, TaskStatus,
    read_telemetry_jsonl,
};
use vibevalley_runtime::agent::eval::{
    EvalProfile, EvalRunner, EvalSuite, EvalTask, GraderSpec, ReplaySpec, WorkspaceFixture, analyze_path, export_html, pass_at_k, pass_pow_k, render_timeline,
    run_replay,
};
use vibevalley_runtime::agent::extensions::subagent::SubagentExtension;
use vibevalley_runtime::agent::harness::Harness;
use vibevalley_runtime::agent::tools::{Workspace, coding_tools};

const WAIT: Duration = Duration::from_secs(5);

struct ScriptedClient {
    replies: Mutex<VecDeque<Completion>>,
}

impl ScriptedClient {
    fn new(replies: Vec<Completion>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
        })
    }
}

impl ModelClient for ScriptedClient {
    fn complete<'a>(&'a self, _req: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> vibevalley_runtime::BoxFuture<'a, AiResult<Completion>> {
        Box::pin(async move {
            let next = self.replies.lock().unwrap().pop_front().expect("scripted completion");
            if let Some(text) = &next.message.content {
                on(Delta::Text(text.clone()));
            }
            Ok(next)
        })
    }
}

struct OpenBrain {
    client: Arc<dyn ModelClient>,
    cwd: Option<std::path::PathBuf>,
    tools_fn: Arc<dyn Fn() -> Vec<Box<dyn vibevalley_runtime::agent::Tool>> + Send + Sync>,
}

impl BrainProvider for OpenBrain {
    fn resolve_brain<'a>(&'a self, _conv: &'a str, provider: &'a str) -> vibevalley_runtime::BoxFuture<'a, DurableResult<Option<Arc<Brain>>>> {
        Box::pin(async move {
            let mut b = Brain::new(self.client.clone(), if provider.is_empty() { "deepseek-flash" } else { provider }, "System");
            b.cwd = self.cwd.clone();
            b.tools = (self.tools_fn)();
            Ok(Some(Arc::new(b)))
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
            input: 120,
            output: 30,
            cache_read: 0,
        },
    }
}

#[tokio::test]
async fn telemetry_emits_pi_durable_schema_without_raw_payloads_and_skips_rolled_back_tx() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let work = tempdir().unwrap();
    fs::write(work.path().join("note.txt"), "SECRET_FILE_BODY").unwrap();
    let telemetry_path = dir.path().join("telemetry.jsonl");

    let mem_sink = Arc::new(MemoryTelemetrySink::new());
    let file_sink = Arc::new(JsonlTelemetrySink::open(&telemetry_path)?);
    let fanout = {
        struct Both(Arc<MemoryTelemetrySink>, Arc<JsonlTelemetrySink>);
        impl vibevalley_runtime::agent::durable::TelemetrySink for Both {
            fn record(&self, event: &vibevalley_runtime::agent::durable::TelemetryEvent) {
                self.0.record(event);
                self.1.record(event);
            }
        }
        Arc::new(Both(mem_sink.clone(), file_sink))
    };

    let client = ScriptedClient::new(vec![
        msg(
            None,
            vec![ToolCall {
                id: "tc1".into(),
                name: "read".into(),
                arguments: json!({ "path": "note.txt", "tag": "SECRET_ARG_MARKER" }).to_string(),
            }],
        ),
        msg(Some("SECRET_OUTPUT_MARKER"), vec![]),
    ]);

    let work_dir = work.path().to_path_buf();
    let store = Store::memory()?;
    let harness = Harness::from_store(
        store.clone(),
        Arc::new(OpenBrain {
            client,
            cwd: Some(work_dir.clone()),
            tools_fn: Arc::new(move || coding_tools(&Workspace::new(&work_dir))),
        }),
    )
    .with_telemetry(fanout);
    harness.recover().await?;

    let conv = "tel-conv-1";
    let (_, task, _) = harness
        .submit(Request {
            conversation: conv,
            provider: "deepseek-flash",
            request_id: "req-tel-1",
            prompt: "SECRET_PROMPT_MARKER",
            source: "user",
            system: "SECRET_SYSTEM_MARKER",
            ..Default::default()
        })
        .await?;
    let done = harness.scheduler().wait(&task.id, WAIT).await?;
    assert_eq!(done.terminal_reason, "completed");
    harness.close().await;

    let count_before_rollback = mem_sink.events().len();
    let err = store
        .write_async(|tx| {
            Box::pin(async move {
                tx.append_entry_async(conv, "pi.user", &json!({ "text": "rolled back" })).await?;
                Err::<(), _>(vibevalley_runtime::agent::durable::Error::Invalid("boom".into()))
            })
        })
        .await;
    assert!(err.is_err());
    assert_eq!(mem_sink.events().len(), count_before_rollback);

    let events = mem_sink.events();
    let names: Vec<_> = events.iter().map(|e| e.event_name()).collect();
    assert!(names.contains(&"pi.durable.submit"));
    assert!(names.contains(&"pi.durable.submission"));
    assert!(names.contains(&"pi.durable.entry"));
    assert!(names.contains(&"pi.durable.checkpoint"));
    assert!(names.contains(&"pi.durable.phase"));

    let serialized = serde_json::to_string(&events)?;
    for secret in [
        "SECRET_PROMPT_MARKER",
        "SECRET_SYSTEM_MARKER",
        "SECRET_ARG_MARKER",
        "SECRET_OUTPUT_MARKER",
        "SECRET_FILE_BODY",
    ] {
        assert!(!serialized.contains(secret), "telemetry must never leak `{secret}`: {serialized}");
    }

    // Torn trailing line in telemetry.jsonl must be ignored cleanly on read.
    let mut raw = fs::read_to_string(&telemetry_path).unwrap();
    raw.push_str("{\"event\":\"pi.durable.phase\",\"torn\":");
    fs::write(&telemetry_path, raw).unwrap();
    let parsed = read_telemetry_jsonl(&telemetry_path)?;
    assert_eq!(parsed.len(), events.len());

    store.close().await?;
    Ok(())
}

#[tokio::test]
async fn task_graph_captures_parent_child_and_owned_subagent_conversations() -> DurableResult<()> {
    let work = tempdir().unwrap();
    let client = ScriptedClient::new(vec![
        msg(
            None,
            vec![ToolCall {
                id: "call-spawn".into(),
                name: "spawn_agent".into(),
                arguments: json!({ "brief": "do sub work", "label": "helper" }).to_string(),
            }],
        ),
        msg(Some("child finished"), vec![]),
        msg(Some("parent finished"), vec![]),
    ]);

    let work_dir = work.path().to_path_buf();
    let harness = Harness::from_store(
        Store::memory()?,
        Arc::new(OpenBrain {
            client,
            cwd: Some(work_dir.clone()),
            tools_fn: Arc::new(move || coding_tools(&Workspace::new(&work_dir))),
        }),
    );
    harness.register_extension(Arc::new(SubagentExtension::default()));
    harness.recover().await?;

    let conv = "conv-graph-root";
    let (_, task, _) = harness
        .submit(Request {
            conversation: conv,
            provider: "deepseek-flash",
            request_id: "req-graph",
            prompt: "delegate work",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .await?;
    let done = harness.scheduler().wait(&task.id, WAIT).await?;
    assert_eq!(done.terminal_reason, "completed");

    let graph = harness.task_graph(Some(conv)).await?;
    assert!(graph.nodes.len() >= 3, "expected parent + tool + child generation: {:?}", graph.nodes);
    let root_node = graph.nodes.iter().find(|n| n.id == task.id).unwrap();
    assert!(!root_node.background);
    assert!(!root_node.children.is_empty());

    let tool_node = graph.nodes.iter().find(|n| n.kind == "pi.tool").unwrap();
    assert!(tool_node.background);
    assert_eq!(tool_node.owned_conversations.len(), 1);
    let sub_conv = &tool_node.owned_conversations[0];
    assert!(sub_conv.starts_with("subagent:"));

    let child_gen = graph.nodes.iter().find(|n| n.conversation_id == *sub_conv).unwrap();
    assert_eq!(child_gen.kind, "pi.generation");
    assert_eq!(child_gen.owner_task_id, tool_node.id);

    harness.close().await;
    harness.store().close().await?;
    Ok(())
}

#[tokio::test]
async fn sqlite_to_jsonl_export_preserves_full_closure_and_at_seq_slice() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("execution.db");
    let full_dir = dir.path().join("full-jsonl");
    let slice_dir = dir.path().join("slice-jsonl");

    let writer = Store::open(&db_path).await?;
    // Open read-only against active WAL writer cleanly.
    let reader = Store::open_read_only(&db_path).await?;
    assert!(reader.is_read_only());
    assert!(
        reader
            .write_async(|tx| Box::pin(async move { tx.create_conversation_async("nope", "m").await }))
            .await
            .is_err()
    );

    writer
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("anc", "deepseek-flash").await?;
                tx.append_entry_async("anc", "pi.user", &json!({ "text": "ancestor turn" })).await?;
                tx.append_entry_async("anc", "pi.assistant", &json!({ "text": "ancestor reply" })).await?;
                tx.fork_conversation_async("anc", "leaf", "", "deepseek-flash", 2).await?;
                tx.append_entry_async("leaf", "pi.user", &json!({ "text": "leaf ask" })).await?;
                tx.append_entry_async("leaf", "pi.assistant", &json!({ "text": "leaf answer" })).await?;
                tx.compact_async(
                    "leaf",
                    Compaction {
                        level: "hard",
                        base_head: 1,
                        from: 1,
                        cut: 3,
                        summary: "sum 1..3",
                        token_count: 42,
                    },
                )
                .await?;
                tx.put_document_async(CONVERSATION_SCOPE, "leaf", "pi.verdict", &json!({ "satisfied": true }))
                    .await?;
                let mut gov = GovernanceState::default();
                gov.pending_permissions.insert(
                    "call-1".into(),
                    PendingApproval {
                        task_id: "t-root".into(),
                        tool_call_id: "call-1".into(),
                        tool_name: "bash".into(),
                        args_json: json!({}),
                        evaluation: PermissionEvaluation::default(),
                        requested_at_ms: 1,
                    },
                );
                gov.last_rubric_verdict = Some(RubricVerdict {
                    satisfied: true,
                    summary: "ok".into(),
                    unmet_items: vec![],
                    iteration: 1,
                });
                write_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, "leaf", &gov).await?;

                let (sub, _) = tx.submit_async("leaf", "req-export", "prompt", &json!({ "text": "leaf ask" }), None).await?;
                tx.settle_async(&sub.id, SubmissionStatus::Done, &json!({ "output": "leaf answer" })).await?;

                let mut root_task = Task::new("pi.generation", "follow_up_check");
                root_task.id = "t-root".into();
                root_task.conversation_id = "leaf".into();
                root_task.status = TaskStatus::Terminal;
                root_task.terminal_reason = "completed".into();
                tx.create_task_async(root_task).await?;

                let (sig1, _) = tx.send_signal_async("t-root", "wake", Some("k1"), &json!(1)).await?;
                let _ = tx.consume_first_signal_async("t-root", "wake").await?;
                let (sig2, _) = tx.send_signal_async("t-root", "wake", Some("k2"), &json!(2)).await?;
                let _ = (sig1, sig2);

                tx.create_owned_conversation_async("subagent:child-1", "deepseek-flash", "t-root").await?;
                tx.append_entry_async("subagent:child-1", "pi.assistant", &json!({ "text": "child hi" }))
                    .await?;
                Ok(())
            })
        })
        .await?;

    let expected_visible: Vec<_> = reader.read_async(|r| Box::pin(async move { r.visible_entries_async("leaf").await })).await?;

    // Full closure export from read-only SQLite -> JSONL.
    let manifest = reader.export_conversation_jsonl("leaf", &full_dir, ExportOptions::default()).await?;
    assert_eq!(manifest.root_conversation_id, "leaf");
    assert_eq!(manifest.conversations_exported, 3);

    let full_store = Store::jsonl_read_only(&full_dir)?;
    let actual_visible = full_store
        .read_async(|r| Box::pin(async move { r.visible_entries_async("leaf").await }))
        .await?;
    assert_eq!(
        actual_visible.iter().map(|e| (&e.conversation_id, e.seq, &e.kind)).collect::<Vec<_>>(),
        expected_visible.iter().map(|e| (&e.conversation_id, e.seq, &e.kind)).collect::<Vec<_>>()
    );
    full_store
        .read_async(|r| {
            Box::pin(async move {
                let subs = r.submissions_async("leaf").await?;
                assert_eq!(subs.len(), 1);
                assert_eq!(subs[0].status, SubmissionStatus::Done);
                assert_eq!(subs[0].result, json!({ "output": "leaf answer" }));

                let all_sigs = r.signals_async("t-root", true).await?;
                assert_eq!(all_sigs.len(), 2);
                assert!(all_sigs[0].consumed);
                assert!(!all_sigs[1].consumed);
                assert_eq!(r.entries_async("subagent:child-1", 1).await?.len(), 1);
                Ok(())
            })
        })
        .await?;
    full_store.close().await?;

    // Sliced export at seq 3 (`head_seq = 1 < 3`, includes ancestor + leaf seq 3, strips live/governance runtime locks & tasks).
    let slice_manifest = reader
        .export_conversation_jsonl(
            "leaf",
            &slice_dir,
            ExportOptions {
                at_seq: Some(3),
                include_children: false,
                fsync: true,
            },
        )
        .await?;
    assert_eq!(slice_manifest.tasks_exported, 0);
    assert_eq!(slice_manifest.submissions_exported, 0);

    let slice_store = Store::jsonl_read_only(&slice_dir)?;
    slice_store
        .read_async(|r| {
            Box::pin(async move {
                let leaf = r.conversation_async("leaf").await?;
                assert_eq!(leaf.next_seq, 4);
                assert!(r.entries_async("leaf", 1).await?.iter().all(|e| e.seq <= 3));
                assert!(r.document_async(CONVERSATION_SCOPE, "leaf", "pi.verdict").await?.is_none());
                let gov: GovernanceState = read_doc::<GovernanceDoc>(r, CONVERSATION_SCOPE, "leaf").await?;
                assert!(gov.pending_permissions.is_empty());
                assert!(gov.last_rubric_verdict.is_none());
                assert!(r.tasks_by_conversation_async("leaf").await?.is_empty());
                assert!(r.conversation_async("subagent:child-1").await.is_err());
                Ok(())
            })
        })
        .await?;

    slice_store.close().await?;
    reader.close().await?;
    writer.close().await?;
    Ok(())
}

#[tokio::test]
async fn trace_metrics_detects_tool_errors_repeated_loops_compactions_and_renders_html() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let store = Store::jsonl(dir.path())?;
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("trace-conv", "deepseek-flash").await?;
                tx.append_entry_async("trace-conv", "pi.user", &json!({ "text": "inspect <script>alert(1)</script>" }))
                    .await?;
                tx.append_entry_async(
                    "trace-conv",
                    "pi.assistant",
                    &json!({
                        "text": "",
                        "toolCalls": [{ "id": "c1", "toolName": "read", "argsJson": { "b": 2, "a": 1 } }]
                    }),
                )
                .await?;
                tx.append_entry_async(
                    "trace-conv",
                    "pi.tool_result",
                    &json!({ "toolCallId": "c1", "toolName": "read", "ok": true, "output": "ok" }),
                )
                .await?;
                tx.append_entry_async(
                    "trace-conv",
                    "pi.assistant",
                    &json!({
                        "text": "",
                        "toolCalls": [{ "id": "c2", "toolName": "read", "argsJson": { "a": 1, "b": 2 } }]
                    }),
                )
                .await?;
                tx.append_entry_async(
                    "trace-conv",
                    "pi.tool_result",
                    &json!({ "toolCallId": "c2", "toolName": "read", "ok": false, "error": "missing" }),
                )
                .await?;
                tx.compact_async(
                    "trace-conv",
                    Compaction {
                        level: "soft",
                        base_head: 1,
                        from: 1,
                        cut: 3,
                        summary: "short summary",
                        token_count: 55,
                    },
                )
                .await?;
                tx.append_entry_async("trace-conv", "pi.assistant", &json!({ "text": "done" })).await?;

                UsageTotals {
                    input_tokens: 1000,
                    output_tokens: 200,
                    cost_micros: Some(1500),
                    ..Default::default()
                }
                .record(tx, "trace-conv")
                .await?;

                let mut gov = GovernanceState::default();
                let verdict = RubricVerdict {
                    satisfied: true,
                    summary: "verified".into(),
                    unmet_items: vec![],
                    iteration: 1,
                };
                gov.last_rubric_verdict = Some(verdict.clone());
                gov.rubric_history.push(verdict);
                write_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, "trace-conv", &gov).await?;
                Ok(())
            })
        })
        .await?;
    let tl = render_timeline(&store, "trace-conv").await?;
    let html = export_html(&store, "trace-conv", &[]).await?;
    store.close().await?;

    let metrics = analyze_path(dir.path(), None).await?;
    assert_eq!(metrics.conversation_id, "trace-conv");
    assert_eq!(metrics.turns, 3);
    assert_eq!(metrics.compactions, 1);
    assert_eq!(metrics.tool_calls_total, 2);
    assert_eq!(metrics.tool_errors_total, 1);
    assert_eq!(metrics.repeated_tool_loops, 1);
    assert!((metrics.cost_usd - 0.0015).abs() < 1e-9);
    assert_eq!(metrics.final_rubric_satisfied, Some(true));

    assert!(tl.contains("Conversation: trace-conv"));
    assert!(tl.contains("[tool:ERR] read"));
    assert!(!html.contains("<script>alert(1)</script>"));
    assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert!(!html.contains("http://") && !html.contains("https://"));
    Ok(())
}

#[tokio::test]
async fn l2_jsonl_slice_replay_branches_without_mutating_source_fixture() -> DurableResult<()> {
    let dir = tempdir().unwrap();
    let src_store_dir = dir.path().join("src-store");
    let src_ws_dir = dir.path().join("src-ws");
    let out_dir = dir.path().join("replay-out");
    fs::create_dir_all(&src_ws_dir).unwrap();
    fs::write(src_ws_dir.join("seed.txt"), "initial\n").unwrap();

    let src = Store::jsonl(&src_store_dir)?;
    src.write_async(|tx| {
        Box::pin(async move {
            tx.create_conversation_async("replay-conv", "deepseek-flash").await?;
            tx.append_entry_async("replay-conv", "pi.system", &json!({ "text": "sys" })).await?;
            tx.append_entry_async("replay-conv", "pi.user", &json!({ "text": "step 1" })).await?;
            tx.append_entry_async("replay-conv", "pi.assistant", &json!({ "text": "bad draft before slice" }))
                .await?;
            tx.append_entry_async("replay-conv", "pi.user", &json!({ "text": "stale follow-up" })).await?;
            Ok(())
        })
    })
    .await?;
    src.close().await?;

    let client = ScriptedClient::new(vec![
        msg(
            None,
            vec![ToolCall {
                id: "w1".into(),
                name: "write".into(),
                arguments: json!({ "path": "seed.txt", "content": "replayed!\n" }).to_string(),
            }],
        ),
        msg(Some("replayed clean answer"), vec![]),
    ]);

    let outcome = run_replay(
        &ReplaySpec {
            source_path: src_store_dir.clone(),
            conversation_id: None,
            at_seq: 2,
            prompt: "try again properly".into(),
            workspace: Some(src_ws_dir.clone()),
            profile: EvalProfile::vanilla(),
            graders: vec![
                GraderSpec::FileContains {
                    path: "seed.txt".into(),
                    needle: "replayed!".into(),
                },
                GraderSpec::OutputContains {
                    needle: "replayed clean".into(),
                },
            ],
            timeout_secs: 15,
        },
        &out_dir,
        client,
    )
    .await?;

    assert!(outcome.passed, "{:?}", outcome.grader_results);
    assert_eq!(fs::read_to_string(src_ws_dir.join("seed.txt")).unwrap(), "initial\n");
    let src_ro = Store::jsonl_read_only(&src_store_dir)?;
    src_ro
        .read_async(|r| {
            Box::pin(async move {
                assert_eq!(r.entries_async("replay-conv", 1).await?.len(), 4);
                assert_eq!(r.conversation_async("replay-conv").await?.next_seq, 5);
                Ok(())
            })
        })
        .await?;
    src_ro.close().await?;

    assert!(out_dir.join("replay_result.json").is_file());
    assert!(out_dir.join("transcript.html").is_file());
    assert!(out_dir.join("store").join("telemetry.jsonl").is_file());
    Ok(())
}

#[tokio::test]
async fn l3_eval_suite_runs_balanced_vanilla_vs_codemode_ab_with_isolated_workspaces_and_stats() -> DurableResult<()> {
    assert!((pass_at_k(4, 2, 2) - (5.0 / 6.0)).abs() < 1e-9);
    assert!((pass_pow_k(4, 2, 2) - 0.25).abs() < 1e-9);

    let out = tempdir().unwrap();
    let execution_order: Arc<Mutex<Vec<(String, usize, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let order_ref = execution_order.clone();

    let suite = EvalSuite {
        name: "vanilla-vs-codemode".into(),
        trials: 2,
        balanced_order: true,
        profiles: vec![EvalProfile::vanilla(), EvalProfile::codemode()],
        tasks: vec![
            EvalTask {
                id: "t1".into(),
                prompt: "Write target.txt".into(),
                workspace: WorkspaceFixture::InlineFiles {
                    files: BTreeMap::from([("seed.txt".into(), "hello\n".into())]),
                    init_git: true,
                },
                graders: vec![
                    GraderSpec::FileContains {
                        path: "target.txt".into(),
                        needle: "solved".into(),
                    },
                    GraderSpec::Shell {
                        command: "test -d .git && grep -q solved target.txt".into(),
                        timeout_secs: 15,
                    },
                    GraderSpec::TrajectoryBounds {
                        max_turns: Some(3),
                        max_tool_errors: Some(0),
                        max_repeated_loops: Some(0),
                        max_cost_usd: Some(0.1),
                        max_duration_ms: Some(15_000),
                    },
                ],
                timeout_secs: 30,
            },
            EvalTask {
                id: "t2".into(),
                prompt: "Deliver out.txt".into(),
                workspace: WorkspaceFixture::Empty { init_git: false },
                graders: vec![GraderSpec::FileContains {
                    path: "out.txt".into(),
                    needle: "pass".into(),
                }],
                timeout_secs: 30,
            },
        ],
    };

    let report = EvalRunner.run(&suite, out.path(), move |profile, task, trial| {
        order_ref.lock().unwrap().push((task.id.clone(), trial, profile.name.clone()));
        match (task.id.as_str(), profile.name.as_str(), trial) {
            ("t1", "vanilla", _) => ScriptedClient::new(vec![
                msg(
                    None,
                    vec![ToolCall {
                        id: "c1".into(),
                        name: "read".into(),
                        arguments: json!({ "path": "seed.txt" }).to_string(),
                    }],
                ),
                msg(
                    None,
                    vec![ToolCall {
                        id: "c2".into(),
                        name: "write".into(),
                        arguments: json!({ "path": "target.txt", "content": "solved\n" }).to_string(),
                    }],
                ),
                msg(Some("vanilla t1 done"), vec![]),
            ]),
            ("t1", "codemode", _) => ScriptedClient::new(vec![
                msg(
                    None,
                    vec![ToolCall {
                        id: "cm1".into(),
                        name: "run_code".into(),
                        arguments: json!({
                            "script": "const s = call('read', { path: 'seed.txt' }); call('write', { path: 'target.txt', content: 'solved:' + s }); return 'ok';"
                        })
                        .to_string(),
                    }],
                ),
                msg(Some("codemode t1 done"), vec![]),
            ]),
            // Make vanilla fail t2 trial 1 so pass@2 (1.0) != pass^2 (0.25) while codemode passes both.
            ("t2", "vanilla", 0) => ScriptedClient::new(vec![
                msg(
                    None,
                    vec![ToolCall {
                        id: "w1".into(),
                        name: "write".into(),
                        arguments: json!({ "path": "out.txt", "content": "pass" }).to_string(),
                    }],
                ),
                msg(Some("vanilla t2 ok"), vec![]),
            ]),
            ("t2", "vanilla", _) => ScriptedClient::new(vec![msg(Some("forgot to write file"), vec![])]),
            ("t2", "codemode", _) => ScriptedClient::new(vec![
                msg(
                    None,
                    vec![ToolCall {
                        id: "cm2".into(),
                        name: "run_code".into(),
                        arguments: json!({ "script": "call('write', { path: 'out.txt', content: 'pass' });" }).to_string(),
                    }],
                ),
                msg(Some("codemode t2 ok"), vec![]),
            ]),
            _ => unreachable!(),
        }
    })
    .await?;

    let order = execution_order.lock().unwrap();
    // Task 0 trial 0 -> [vanilla, codemode], Task 0 trial 1 -> [codemode, vanilla]
    assert_eq!(
        &order[0..4],
        &[
            ("t1".into(), 0, "vanilla".into()),
            ("t1".into(), 0, "codemode".into()),
            ("t1".into(), 1, "codemode".into()),
            ("t1".into(), 1, "vanilla".into()),
        ]
    );

    assert_eq!(report.trials.len(), 8);
    let vanilla = report.profiles.iter().find(|p| p.profile == "vanilla").unwrap();
    let codemode = report.profiles.iter().find(|p| p.profile == "codemode").unwrap();
    assert_eq!(vanilla.passed, 3);
    assert_eq!(codemode.passed, 4);
    assert!((vanilla.pass_at_k - 1.0).abs() < 1e-9);
    assert!((vanilla.pass_pow_k - 0.625).abs() < 1e-9);
    assert!((codemode.pass_pow_k - 1.0).abs() < 1e-9);

    assert_eq!(report.pairwise.len(), 1);
    let cmp = &report.pairwise[0];
    assert_eq!(cmp.wins_b, 1);
    assert_eq!(cmp.ties, 1);
    assert!(cmp.mean_pass_rate_delta > 0.0);
    assert!(cmp.mean_turns_delta < 0.0);

    let results_lines = fs::read_to_string(out.path().join("results.jsonl")).unwrap();
    assert_eq!(results_lines.lines().count(), 8);
    assert!(out.path().join("report.json").is_file());
    assert!(out.path().join("report.md").is_file());
    for t in &report.trials {
        assert!(t.store_dir.join("commits.jsonl").is_file());
        assert!(t.store_dir.join("telemetry.jsonl").is_file());
    }
    Ok(())
}
