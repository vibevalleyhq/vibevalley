use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::process::Command;
use tokio::sync::Barrier;

use super::doc::{
    AgentDoc, BudgetConfig, BudgetSnapshot, CONVERSATION_SCOPE, DocSpec, FileOpsDoc, GovernanceDoc, InboxDoc, OarSessionDoc, PendingApproval,
    PermissionEvaluation, StandInDoc, TodoDoc, TodoItem, TodoState, UsageDoc, UsageTotals, read_doc, update_doc, write_doc,
};
use super::engine::{BrainProvider, Engine, Request, TOOL_KIND, TOOL_RUN};
use super::events::{AgentEvent, AgentMessage, Brain};
use super::extension::{Extension, ExtensionRunner, HookOutcome, Rubric, RubricVerdict, RunEndCtx, ToolCallHookCtx};
use super::inbox;
use super::pipeline::{PromptSection, Transcript, convert_to_llm};
use super::tool::{Tool, ToolOutput};
use crate::BoxFuture;
use crate::agent::ai::ModelClient;
use crate::agent::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, Role, ToolCall, ToolSpec, Usage};
use crate::agent::codemode::CodeModeSpec;
use crate::agent::compaction::Compactor;
use crate::agent::durable::{Scheduler, Store, SubmissionStatus, Task};
use crate::agent::{BrainError, Result as AiResult};

type ScriptedStep = Box<dyn FnOnce(&ChatRequest, &mut (dyn FnMut(Delta) + Send)) -> AiResult<Completion> + Send>;

struct ScriptedClient {
    responses: Mutex<VecDeque<ScriptedStep>>,
    requests: Mutex<Vec<ChatRequest>>,
}

impl ScriptedClient {
    fn new() -> Self {
        Self {
            responses: Mutex::new(VecDeque::new()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn push_fn<F>(&self, f: F)
    where
        F: FnOnce(&ChatRequest, &mut (dyn FnMut(Delta) + Send)) -> AiResult<Completion> + Send + 'static,
    {
        self.responses.lock().unwrap().push_back(Box::new(f));
    }

    fn push_ok(&self, completion: Completion) {
        self.push_fn(move |_, _| Ok(completion));
    }

    fn captured_requests(&self) -> Vec<ChatRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl ModelClient for ScriptedClient {
    fn complete<'a>(&'a self, request: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> BoxFuture<'a, AiResult<Completion>> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request.clone());
            let next = self.responses.lock().unwrap().pop_front().expect("unexpected model call");
            next(request, on)
        })
    }
}

struct BarrierSafeTool {
    name: String,
    barrier: Arc<Barrier>,
    calls: Arc<AtomicUsize>,
}

impl Tool for BarrierSafeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.clone(),
            description: "safe parallel test tool".into(),
            parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        }
    }

    fn replay_safe(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, args: &'a Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.barrier.wait().await;
            ToolOutput::ok(format!("ran {}:{}", self.name, args["path"].as_str().unwrap_or("")))
        })
    }
}

struct UnsafeCounterTool {
    name: String,
    calls: Arc<AtomicUsize>,
    started_tx: Option<tokio::sync::mpsc::UnboundedSender<()>>,
    release_rx: Option<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<()>>>,
}

impl Tool for UnsafeCounterTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.clone(),
            description: "unsafe test tool".into(),
            parameters: json!({"type": "object"}),
        }
    }

    fn replay_safe(&self) -> bool {
        false
    }

    fn execute<'a>(&'a self, _args: &'a Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = &self.started_tx {
                let _ = tx.send(());
            }
            if let Some(rx) = &self.release_rx {
                let mut rx = rx.lock().await;
                let _ = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
            }
            ToolOutput::ok("executed")
        })
    }
}

struct FixedBrainProvider {
    brain: Arc<Brain>,
    events: Mutex<Vec<AgentEvent>>,
}

impl FixedBrainProvider {
    fn new(brain: Arc<Brain>) -> Self {
        Self {
            brain,
            events: Mutex::new(Vec::new()),
        }
    }

    fn events(&self) -> Vec<AgentEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl BrainProvider for FixedBrainProvider {
    fn resolve_brain<'a>(&'a self, _conv: &'a str, _provider: &'a str) -> BoxFuture<'a, crate::agent::durable::Result<Option<Arc<Brain>>>> {
        Box::pin(std::future::ready(Ok(Some(self.brain.clone()))))
    }

    fn observe(&self, _conv: &str, _task: &str, event: AgentEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[tokio::test]
async fn doc_specs_roundtrip_and_inbox_compat() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("c1", "mock").await?;
                write_doc::<AgentDoc>(
                    tx,
                    CONVERSATION_SCOPE,
                    "c1",
                    &super::doc::AgentState {
                        role: "worker".into(),
                        model: "deepseek-chat".into(),
                        read_only: false,
                        tools: vec!["read".into()],
                        max_iterations: Some(3),
                    },
                )
                .await?;
                write_doc::<InboxDoc>(
                    tx,
                    CONVERSATION_SCOPE,
                    "c1",
                    &super::doc::InboxState {
                        items: vec![json!({"kind": "alert", "title": "hi"})],
                    },
                )
                .await?;
                update_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, "c1", |ops| {
                    ops.read.insert("src/lib.rs".into());
                    Ok(())
                })
                .await?;
                UsageTotals {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_read_tokens: 10,
                    cost_micros: Some(500),
                    ..Default::default()
                }
                .record(tx, "c1")
                .await?;
                UsageTotals {
                    input_tokens: 5,
                    cost_micros: Some(10),
                    ..Default::default()
                }
                .record_task(tx, "t1")
                .await?;
                update_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, "c1", |g| {
                    g.status = "active".into();
                    g.budget = Some(BudgetConfig { max_cost_micros: 1_000 });
                    g.budget_snapshot = Some(BudgetSnapshot {
                        spent_micros: 500,
                        max_cost_micros: 1_000,
                        reached: false,
                    });
                    g.pending_permissions.insert(
                        "t1".into(),
                        PendingApproval {
                            task_id: "t1".into(),
                            tool_call_id: "call-1".into(),
                            tool_name: "bash".into(),
                            args_json: json!({"cmd": "ls"}),
                            evaluation: PermissionEvaluation {
                                tool_name: "bash".into(),
                                policy: "auto".into(),
                                verdict: "ask".into(),
                                reason: "needs approval".into(),
                                client_overridable: true,
                            },
                            requested_at_ms: 123,
                        },
                    );
                    Ok(())
                })
                .await?;
                update_doc::<TodoDoc>(tx, CONVERSATION_SCOPE, "c1", |t| {
                    t.items.push(TodoItem {
                        id: "1".into(),
                        title: "first".into(),
                        brief: "do".into(),
                        after: vec![],
                        state: TodoState::Working,
                        result: None,
                        tries: 1,
                    });
                    Ok(())
                })
                .await?;
                write_doc::<OarSessionDoc>(
                    tx,
                    CONVERSATION_SCOPE,
                    "c1",
                    &super::doc::OarSessionState {
                        runtime_id: "vibevalley".into(),
                        vendor_session_id: "vs1".into(),
                        cwd: "/tmp".into(),
                        permission_mode: "ask".into(),
                        status: "running".into(),
                    },
                )
                .await?;
                write_doc::<StandInDoc>(
                    tx,
                    CONVERSATION_SCOPE,
                    "c1",
                    &super::doc::StandInState {
                        sections: vec![PromptSection::new("k", "v")],
                        tool_specs: vec![],
                    },
                )
                .await?;
                Ok(())
            })
        })
        .await?;

    store
        .read_async(|tx| {
            Box::pin(async move {
                assert_eq!(read_doc::<AgentDoc>(tx, CONVERSATION_SCOPE, "c1").await?.role, "worker");
                assert_eq!(read_doc::<InboxDoc>(tx, CONVERSATION_SCOPE, "c1").await?.items.len(), 1);
                assert!(read_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, "c1").await?.read.contains("src/lib.rs"));
                assert_eq!(read_doc::<UsageDoc>(tx, CONVERSATION_SCOPE, "c1").await?.cost_micros, Some(500));
                assert_eq!(read_doc::<UsageDoc>(tx, "task", "t1").await?.input_tokens, 5);
                let gov_raw = tx.document_async(CONVERSATION_SCOPE, "c1", GovernanceDoc::KIND).await?.unwrap().state;
                assert_eq!(gov_raw["budgetSnapshot"]["spentMicros"], 500);
                assert_eq!(gov_raw["pendingPermissions"]["t1"]["toolCallId"], "call-1");
                assert_eq!(read_doc::<TodoDoc>(tx, CONVERSATION_SCOPE, "c1").await?.items[0].state, TodoState::Working);
                assert_eq!(read_doc::<OarSessionDoc>(tx, CONVERSATION_SCOPE, "c1").await?.runtime_id, "vibevalley");
                assert_eq!(read_doc::<StandInDoc>(tx, CONVERSATION_SCOPE, "c1").await?.sections.len(), 1);
                Ok(())
            })
        })
        .await?;
    Ok(())
}

#[test]
fn pipeline_convert_to_llm_preserves_cache_reasoning_and_tool_pairing() {
    let msgs = vec![
        AgentMessage::system("base system"),
        AgentMessage::user("hello"),
        AgentMessage::system_delta("later tail delta"),
        AgentMessage::assistant(Message {
            role: Role::Assistant,
            content: Some(String::new()),
            reasoning: Some("chain of thought".into()),
            tool_calls: vec![
                ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    arguments: "{}".into(),
                },
                ToolCall {
                    id: "c2".into(),
                    name: "grep".into(),
                    arguments: "{}".into(),
                },
            ],
            tool_call_id: None,
        }),
        AgentMessage::tool_result("c1", "ok-1"),
        AgentMessage::tool_result("orphan", "should drop"),
        // c2 missing -> repaired before next user turn!
        AgentMessage::user("next turn"),
    ];

    let converted = convert_to_llm(msgs);
    assert_eq!(converted[0], Message::system("base system"));
    assert_eq!(converted[1], Message::user("hello"));
    assert_eq!(converted[2], Message::system("later tail delta"));
    assert_eq!(converted[3].role, Role::Assistant);
    assert_eq!(converted[3].content, None);
    assert_eq!(converted[3].reasoning.as_deref(), Some("chain of thought"));
    assert_eq!(converted[4], Message::tool("c1", "ok-1"));
    assert_eq!(converted[5], Message::tool("c2", "ERROR: missing tool result"));
    assert_eq!(converted[6], Message::user("next turn"));
    assert_eq!(converted.len(), 7);
}

#[tokio::test]
async fn engine_runs_parallel_safe_tools_in_one_batch() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 8);
    let client = Arc::new(ScriptedClient::new());
    client.push_ok(Completion {
        message: Message {
            role: Role::Assistant,
            content: Some(String::new()),
            reasoning: Some("think".into()),
            tool_calls: vec![
                ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    arguments: r#"{"path":"a.rs"}"#.into(),
                },
                ToolCall {
                    id: "c2".into(),
                    name: "grep".into(),
                    arguments: r#"{"path":"b.rs"}"#.into(),
                },
            ],
            tool_call_id: None,
        },
        finish: FinishReason::ToolCalls,
        usage: Usage {
            input: 10,
            output: 5,
            cache_read: 0,
        },
    });
    client.push_ok(Completion {
        message: Message::assistant("all read"),
        finish: FinishReason::Stop,
        usage: Usage {
            input: 20,
            output: 4,
            cache_read: 0,
        },
    });

    let barrier = Arc::new(Barrier::new(2));
    let calls = Arc::new(AtomicUsize::new(0));
    let mut brain = Brain::new(client.clone(), "deepseek-chat", "sys");
    brain.tools.push(Box::new(BarrierSafeTool {
        name: "read".into(),
        barrier: barrier.clone(),
        calls: calls.clone(),
    }));
    brain.tools.push(Box::new(BarrierSafeTool {
        name: "grep".into(),
        barrier,
        calls: calls.clone(),
    }));

    let provider = Arc::new(FixedBrainProvider::new(Arc::new(brain)));
    let engine = Engine::new(store.clone(), provider.clone()).with_compactor(Compactor::deterministic(store.clone()));
    engine.register(&scheduler);
    scheduler.recover().await?;

    let (_, task, _) = engine
        .submit(Request {
            conversation: "conv-par",
            provider: "mock",
            request_id: "r1",
            prompt: "read two files",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .await?;
    let done = scheduler.wait(&task.id, Duration::from_secs(4)).await?;
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(done.result["output"], "all read");
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let tr = Transcript::load(&store, "conv-par").await?;
    let results: Vec<_> = tr.entries.iter().filter(|e| e.kind == "pi.tool_result").collect();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].payload["toolCallId"], "c1");
    assert_eq!(results[1].payload["toolCallId"], "c2");

    let ops = store
        .read_async(|tx| Box::pin(async move { read_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, "conv-par").await }))
        .await?;
    assert!(ops.read.contains("a.rs"));
    assert!(ops.read.contains("b.rs"));
    Ok(())
}

#[tokio::test]
async fn engine_unsafe_effect_sandwich_blocks_reexecution_with_git_status() -> crate::agent::durable::Result<()> {
    let dir = TempDir::new().unwrap();
    Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status().await.unwrap();
    std::fs::write(dir.path().join("dirty.txt"), "uncommitted\n").unwrap();

    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 4);
    let client = Arc::new(ScriptedClient::new());
    let exec_count = Arc::new(AtomicUsize::new(0));
    let mut brain = Brain::new(client, "deepseek-chat", "sys");
    brain.cwd = Some(dir.path().to_path_buf());
    brain.tools.push(Box::new(UnsafeCounterTool {
        name: "edit".into(),
        calls: exec_count.clone(),
        started_tx: None,
        release_rx: None,
    }));

    let provider = Arc::new(FixedBrainProvider::new(Arc::new(brain)));
    let engine = Engine::new(store.clone(), provider).with_compactor(Compactor::deterministic(store.clone()));
    engine.register(&scheduler);

    let mut crashed_tool = Task::new(TOOL_KIND, TOOL_RUN);
    crashed_tool.id = "crashed-tool".into();
    crashed_tool.conversation_id = "conv-git".into();
    crashed_tool.checkpoint = json!({
        "parentTaskId": "p1",
        "step": 1,
        "call": { "id": "call-unsafe", "name": "edit", "arguments": "{}" },
        "args": {},
        "prompt": "edit",
        "submissionId": "s1",
        "requestId": "req1",
        "iteration": 0
    });
    crashed_tool.memo = json!({ "started": true });

    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("conv-git", "mock").await?;
                Ok(())
            })
        })
        .await?;
    scheduler.start(crashed_tool).await?;
    let done = scheduler.wait("crashed-tool", Duration::from_secs(3)).await?;
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(exec_count.load(Ordering::SeqCst), 0);
    assert_eq!(done.result["isError"], true);
    let err_text = done.result["text"].as_str().unwrap();
    assert!(err_text.contains("interrupted:"), "got: {err_text}");
    assert!(err_text.contains("dirty.txt"), "expected git status in: {err_text}");
    Ok(())
}

#[tokio::test]
async fn engine_tool_join_steering_skips_remaining_calls_and_pairs_ids() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 4);
    let client = Arc::new(ScriptedClient::new());
    client.push_ok(Completion {
        message: Message {
            role: Role::Assistant,
            content: Some(String::new()),
            reasoning: None,
            tool_calls: vec![
                ToolCall {
                    id: "c1".into(),
                    name: "write_first".into(),
                    arguments: "{}".into(),
                },
                ToolCall {
                    id: "c2".into(),
                    name: "write_second".into(),
                    arguments: "{}".into(),
                },
            ],
            tool_call_id: None,
        },
        finish: FinishReason::ToolCalls,
        usage: Usage::default(),
    });
    client.push_ok(Completion {
        message: Message::assistant("steered reply"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    });

    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (release_tx, release_rx) = tokio::sync::mpsc::unbounded_channel();
    let first_calls = Arc::new(AtomicUsize::new(0));
    let second_calls = Arc::new(AtomicUsize::new(0));

    let mut brain = Brain::new(client.clone(), "deepseek-chat", "sys");
    brain.tools.push(Box::new(UnsafeCounterTool {
        name: "write_first".into(),
        calls: first_calls.clone(),
        started_tx: Some(started_tx),
        release_rx: Some(tokio::sync::Mutex::new(release_rx)),
    }));
    brain.tools.push(Box::new(UnsafeCounterTool {
        name: "write_second".into(),
        calls: second_calls.clone(),
        started_tx: None,
        release_rx: None,
    }));

    let engine = Engine::new(store.clone(), Arc::new(FixedBrainProvider::new(Arc::new(brain)))).with_compactor(Compactor::deterministic(store.clone()));
    engine.register(&scheduler);
    scheduler.recover().await?;

    let (_, task, _) = engine
        .submit(Request {
            conversation: "conv-steer",
            provider: "mock",
            request_id: "r1",
            prompt: "start",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .await?;

    tokio::time::timeout(Duration::from_secs(2), started_rx.recv())
        .await
        .expect("c1 started")
        .expect("sender open");
    let (steer_sub, _) = store
        .write_async(|tx| Box::pin(async move { inbox::submit_steer(tx, "conv-steer", "steer-1", "pivot now").await }))
        .await?;
    let _ = release_tx.send(());

    let done = scheduler.wait(&task.id, Duration::from_secs(3)).await?;
    assert_eq!(done.result["output"], "steered reply");
    assert_eq!(first_calls.load(Ordering::SeqCst), 1);
    assert_eq!(second_calls.load(Ordering::SeqCst), 0);

    let steer_id = steer_sub.id.clone();
    let updated_steer = store.read_async(move |r| Box::pin(async move { r.submission_async(&steer_id).await })).await?;
    assert_eq!(updated_steer.status, SubmissionStatus::Done);

    let reqs = client.captured_requests();
    assert_eq!(reqs.len(), 2);
    let second_msgs = &reqs[1].messages;
    assert!(
        second_msgs
            .iter()
            .any(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some("c2") && m.content.as_deref().unwrap().contains("skipped due to user steering"))
    );
    assert_eq!(second_msgs.last().unwrap().content.as_deref(), Some("pivot now"));
    Ok(())
}

struct RetryOnceExtension {
    retried: AtomicBool,
}

impl Extension for RetryOnceExtension {
    fn name(&self) -> &str {
        "retry-once"
    }

    fn on_after_run<'a>(&'a self, ctx: &'a mut RunEndCtx<'_>) -> BoxFuture<'a, crate::agent::durable::Result<HookOutcome>> {
        Box::pin(async move {
            if !self.retried.swap(true, Ordering::SeqCst) {
                return Ok(HookOutcome::Retry {
                    feedback_entry: json!({"text": "please refine", "source": "grader"}),
                });
            }
            *ctx.verdict = Some(RubricVerdict {
                satisfied: true,
                summary: "looks good".into(),
                unmet_items: vec![],
                iteration: ctx.iteration + 1,
            });
            Ok(HookOutcome::Continue)
        })
    }
}

#[tokio::test]
async fn engine_yield_retry_and_follow_up_settle_together() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 4);
    let client = Arc::new(ScriptedClient::new());
    client.push_ok(Completion {
        message: Message::assistant("draft 1"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    });
    client.push_ok(Completion {
        message: Message::assistant("draft 2"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    });
    client.push_ok(Completion {
        message: Message::assistant("follow up final"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    });

    let brain = Arc::new(Brain::new(client, "deepseek-chat", "sys"));
    let engine = Engine::new(store.clone(), Arc::new(FixedBrainProvider::new(brain)))
        .with_compactor(Compactor::deterministic(store.clone()))
        .with_extensions(ExtensionRunner::new(vec![Arc::new(RetryOnceExtension {
            retried: AtomicBool::new(false),
        })]));
    engine.register(&scheduler);
    scheduler.recover().await?;

    let (prompt_sub, task, _) = engine
        .submit(Request {
            conversation: "conv-fu",
            provider: "mock",
            request_id: "r-main",
            prompt: "go",
            source: "user",
            system: "sys",
            rubric: Some(Rubric {
                markdown: "check".into(),
                max_iterations: 3,
            }),
            ..Default::default()
        })
        .await?;
    let (fu_sub, _) = store
        .write_async(|tx| Box::pin(async move { inbox::submit_follow_up(tx, "conv-fu", "r-fu", "also do X", None).await }))
        .await?;

    let done = scheduler.wait(&task.id, Duration::from_secs(3)).await?;
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(done.result["output"], "follow up final");
    assert_eq!(done.result["rubricVerdict"]["satisfied"], true);

    let pid = prompt_sub.id.clone();
    let fid = fu_sub.id.clone();
    assert_eq!(
        store.read_async(move |r| Box::pin(async move { r.submission_async(&pid).await })).await?.status,
        SubmissionStatus::Done
    );
    assert_eq!(
        store.read_async(move |r| Box::pin(async move { r.submission_async(&fid).await })).await?.status,
        SubmissionStatus::Done
    );
    Ok(())
}

#[tokio::test]
async fn engine_context_overflow_retries_after_compaction() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 4);
    let client = Arc::new(ScriptedClient::new());
    client.push_fn(|_, _| Err(BrainError::ContextOverflow("too long".into())));
    client.push_ok(Completion {
        message: Message::assistant("recovered after compact"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    });

    let brain = Arc::new(Brain::new(client, "deepseek-chat", "sys"));
    let provider = Arc::new(FixedBrainProvider::new(brain));
    let mut compactor = Compactor::deterministic(store.clone());
    compactor.keep_recent = 1;
    let engine = Engine::new(store.clone(), provider.clone()).with_compactor(compactor);
    engine.register(&scheduler);
    scheduler.recover().await?;

    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("conv-ov", "mock").await?;
                tx.append_entry_async("conv-ov", "pi.user", &json!({"text": "old 1"})).await?;
                tx.append_entry_async("conv-ov", "pi.assistant", &json!({"text": "old 2"})).await?;
                Ok(())
            })
        })
        .await?;

    let (_, task, _) = engine
        .submit(Request {
            conversation: "conv-ov",
            provider: "mock",
            request_id: "r-ov",
            prompt: "new question",
            source: "user",
            system: "",
            ..Default::default()
        })
        .await?;
    let done = scheduler.wait(&task.id, Duration::from_secs(3)).await?;
    assert_eq!(done.result["output"], "recovered after compact");
    assert!(
        provider
            .events()
            .iter()
            .any(|e| matches!(e, AgentEvent::Compacted { level, .. } if level == "overflow"))
    );
    Ok(())
}

struct DenyWriteToolExtension;

impl Extension for DenyWriteToolExtension {
    fn name(&self) -> &str {
        "deny-write"
    }

    fn on_before_tool<'a>(&'a self, ctx: &'a ToolCallHookCtx<'_>) -> BoxFuture<'a, crate::agent::durable::Result<HookOutcome>> {
        Box::pin(async move {
            if ctx.tool_name == "danger" {
                return Ok(HookOutcome::Deny {
                    reason: "blocked by policy".into(),
                    overridable: false,
                });
            }
            Ok(HookOutcome::Continue)
        })
    }
}

#[tokio::test]
async fn engine_run_codemode_tool_shares_before_tool_hooks() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 4);
    let exec_calls = Arc::new(AtomicUsize::new(0));
    let mut brain = Brain::new(Arc::new(ScriptedClient::new()), "deepseek-chat", "sys");
    brain.tools.push(Box::new(UnsafeCounterTool {
        name: "danger".into(),
        calls: exec_calls.clone(),
        started_tx: None,
        release_rx: None,
    }));

    let engine = Engine::new(store.clone(), Arc::new(FixedBrainProvider::new(Arc::new(brain))))
        .with_extensions(ExtensionRunner::new(vec![Arc::new(DenyWriteToolExtension)]));
    engine.register(&scheduler);

    let mut cm = Task::new(crate::agent::codemode::KIND, crate::agent::codemode::EXEC);
    cm.id = "cm-1".into();
    cm.conversation_id = "conv-cm".into();
    cm.checkpoint = serde_json::to_value(CodeModeSpec {
        script: r#"try { vibe.call("danger", {}); return "unexpected"; } catch (e) { return String(e); }"#.into(),
        max_steps: 1000,
        max_vars: 64,
        max_output_bytes: 8192,
        max_memory_bytes: 4_000_000,
        max_string_bytes: 4096,
        timeout_ms: 2000,
        ..Default::default()
    })?;
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("conv-cm", "mock").await?;
                Ok(())
            })
        })
        .await?;
    scheduler.start(cm).await?;
    let done = scheduler.wait("cm-1", Duration::from_secs(3)).await?;
    assert_eq!(done.terminal_reason, "completed", "{}", done.error_text);
    assert_eq!(exec_calls.load(Ordering::SeqCst), 0);
    assert!(done.result["value"].as_str().unwrap_or_default().contains("blocked by policy"));
    Ok(())
}

#[tokio::test]
async fn unset_budget_and_allowed_governance_do_not_open_write_transactions() -> crate::agent::durable::Result<()> {
    use crate::agent::extensions::budget::{BudgetExtension, check_budget_if_configured};
    use crate::agent::extensions::governance::GovernanceExtension;

    let store = Store::memory()?;
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("c-clean", "mock").await?;
                Ok(())
            })
        })
        .await?;
    let stats_before = store.stats();
    let snap = check_budget_if_configured(&store, "c-clean", "t-1").await?;
    assert!(!snap.reached);
    assert_eq!(store.stats().requests, stats_before.requests, "unset budget must not open a write tx");
    assert_eq!(store.stats().committed_ops, stats_before.committed_ops);

    let scheduler = Scheduler::new(store.clone(), 2);
    let client = Arc::new(ScriptedClient::new());
    client.push_ok(Completion {
        message: Message {
            role: Role::Assistant,
            content: None,
            reasoning: None,
            tool_calls: vec![ToolCall {
                id: "tc-1".into(),
                name: "read".into(),
                arguments: json!({ "path": "Cargo.toml" }).to_string(),
            }],
            tool_call_id: None,
        },
        finish: FinishReason::ToolCalls,
        usage: Usage::default(),
    });
    client.push_ok(Completion {
        message: Message::assistant("done"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    });
    let mut brain = Brain::new(client, "deepseek-chat", "sys");
    brain.tools.push(Box::new(UnsafeCounterTool {
        name: "read".into(),
        calls: Arc::new(AtomicUsize::new(0)),
        started_tx: None,
        release_rx: None,
    }));
    let engine = Engine::new(store.clone(), Arc::new(FixedBrainProvider::new(Arc::new(brain))))
        .with_extensions(ExtensionRunner::new(vec![Arc::new(BudgetExtension), Arc::new(GovernanceExtension::default())]));
    engine.register(&scheduler);
    scheduler.recover().await?;

    let (_, task, _) = engine
        .submit(Request {
            conversation: "c-clean",
            provider: "mock",
            request_id: "r-clean",
            prompt: "read file",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .await?;
    let done = scheduler.wait(&task.id, Duration::from_secs(3)).await?;
    assert_eq!(done.terminal_reason, "completed");
    assert!(
        store
            .read_async(|tx| Box::pin(async move { tx.document_async(CONVERSATION_SCOPE, "c-clean", GovernanceDoc::KIND).await }))
            .await?
            .is_none(),
        "unset budget and allowed tool calls must not create pi.governance"
    );
    scheduler.close().await;
    Ok(())
}
