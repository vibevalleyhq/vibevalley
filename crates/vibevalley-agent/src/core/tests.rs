use std::collections::VecDeque;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;

use super::doc::{
    AgentDoc, BudgetConfig, BudgetSnapshot, CONVERSATION_SCOPE, DocSpec, FileOpsDoc, GovernanceDoc, InboxDoc, LiveDoc, OarSessionDoc, PendingApproval,
    PermissionEvaluation, StandInDoc, TodoDoc, TodoItem, TodoState, UsageDoc, UsageTotals, read_doc, update_doc, write_doc,
};
use super::engine::{BrainProvider, Engine, Request, TOOL_KIND, TOOL_RUN};
use super::events::{AgentEvent, AgentMessage, Brain};
use super::extension::{Extension, ExtensionRunner, HookOutcome, Rubric, RubricVerdict, RunEndCtx, ToolCallHookCtx};
use super::inbox;
use super::pipeline::{PromptSection, Transcript, convert_to_llm};
use super::tool::{Tool, ToolOutput};
use crate::ai::ModelClient;
use crate::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, Role, ToolCall, ToolSpec, Usage};
use crate::codemode::CodeModeSpec;
use crate::compaction::Compactor;
use crate::durable::{Scheduler, Store, SubmissionStatus, Task};
use crate::{BrainError, Result as AiResult};

type ScriptedStep = Box<dyn FnOnce(&ChatRequest, &mut dyn FnMut(Delta)) -> AiResult<Completion> + Send>;

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
        F: FnOnce(&ChatRequest, &mut dyn FnMut(Delta)) -> AiResult<Completion> + Send + 'static,
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
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
        self.requests.lock().unwrap().push(request.clone());
        let next = self.responses.lock().unwrap().pop_front().expect("unexpected model call");
        next(request, on)
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

    fn execute(&self, args: &Value) -> ToolOutput {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.barrier.wait();
        ToolOutput::ok(format!("ran {}:{}", self.name, args["path"].as_str().unwrap_or("")))
    }
}

struct UnsafeCounterTool {
    name: String,
    calls: Arc<AtomicUsize>,
    started_tx: Option<flume::Sender<()>>,
    release_rx: Option<flume::Receiver<()>>,
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

    fn execute(&self, _args: &Value) -> ToolOutput {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = &self.started_tx {
            let _ = tx.send(());
        }
        if let Some(rx) = &self.release_rx {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
        ToolOutput::ok("executed")
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
    fn resolve_brain(&self, _conv: &str, _provider: &str) -> crate::durable::Result<Option<Arc<Brain>>> {
        Ok(Some(self.brain.clone()))
    }

    fn observe(&self, _conv: &str, _task: &str, event: AgentEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[test]
fn doc_specs_roundtrip_and_inbox_compat() -> crate::durable::Result<()> {
    let store = Store::memory()?;
    store.write(|tx| {
        tx.create_conversation("c1", "mock")?;
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
        )?;
        write_doc::<InboxDoc>(
            tx,
            CONVERSATION_SCOPE,
            "c1",
            &super::doc::InboxState {
                items: vec![json!({"kind": "alert", "title": "hi"})],
            },
        )?;
        write_doc::<LiveDoc>(
            tx,
            CONVERSATION_SCOPE,
            "c1",
            &super::doc::LiveState {
                text: "partial".into(),
                reasoning: "thinking".into(),
            },
        )?;
        update_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, "c1", |ops| {
            ops.read.insert("src/lib.rs".into());
            Ok(())
        })?;
        UsageTotals {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 10,
            cost_micros: Some(500),
            ..Default::default()
        }
        .record(tx, "c1")?;
        UsageTotals {
            input_tokens: 5,
            cost_micros: Some(10),
            ..Default::default()
        }
        .record_task(tx, "t1")?;
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
        })?;
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
        })?;
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
        )?;
        write_doc::<StandInDoc>(
            tx,
            CONVERSATION_SCOPE,
            "c1",
            &super::doc::StandInState {
                sections: vec![PromptSection::new("k", "v")],
                tool_specs: vec![],
            },
        )?;
        Ok(())
    })?;

    store.read(|tx| {
        assert_eq!(read_doc::<AgentDoc>(tx, CONVERSATION_SCOPE, "c1")?.role, "worker");
        assert_eq!(read_doc::<InboxDoc>(tx, CONVERSATION_SCOPE, "c1")?.items.len(), 1);
        assert_eq!(read_doc::<LiveDoc>(tx, CONVERSATION_SCOPE, "c1")?.reasoning, "thinking");
        assert!(read_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, "c1")?.read.contains("src/lib.rs"));
        assert_eq!(read_doc::<UsageDoc>(tx, CONVERSATION_SCOPE, "c1")?.cost_micros, Some(500));
        assert_eq!(read_doc::<UsageDoc>(tx, "task", "t1")?.input_tokens, 5);
        let gov_raw = tx.document(CONVERSATION_SCOPE, "c1", GovernanceDoc::KIND)?.unwrap().state;
        assert_eq!(gov_raw["budgetSnapshot"]["spentMicros"], 500);
        assert_eq!(gov_raw["pendingPermissions"]["t1"]["toolCallId"], "call-1");
        assert_eq!(read_doc::<TodoDoc>(tx, CONVERSATION_SCOPE, "c1")?.items[0].state, TodoState::Working);
        assert_eq!(read_doc::<OarSessionDoc>(tx, CONVERSATION_SCOPE, "c1")?.runtime_id, "vibevalley");
        assert_eq!(read_doc::<StandInDoc>(tx, CONVERSATION_SCOPE, "c1")?.sections.len(), 1);
        Ok(())
    })?;
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

#[test]
fn engine_runs_parallel_safe_tools_in_one_batch() -> crate::durable::Result<()> {
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
    scheduler.recover()?;

    let (_, task, _) = engine.submit(Request {
        conversation: "conv-par",
        provider: "mock",
        request_id: "r1",
        prompt: "read two files",
        source: "user",
        system: "sys",
        ..Default::default()
    })?;
    let done = scheduler.wait(&task.id, Duration::from_secs(4))?;
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(done.result["output"], "all read");
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let tr = Transcript::load(&store, "conv-par")?;
    let results: Vec<_> = tr.entries.iter().filter(|e| e.kind == "pi.tool_result").collect();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].payload["toolCallId"], "c1");
    assert_eq!(results[1].payload["toolCallId"], "c2");

    let ops = store.read(|tx| read_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, "conv-par"))?;
    assert!(ops.read.contains("a.rs"));
    assert!(ops.read.contains("b.rs"));
    Ok(())
}

#[test]
fn engine_unsafe_effect_sandwich_blocks_reexecution_with_git_status() -> crate::durable::Result<()> {
    let dir = TempDir::new().unwrap();
    Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status().unwrap();
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

    store.write(|tx| {
        tx.create_conversation("conv-git", "mock")?;
        Ok(())
    })?;
    scheduler.start(crashed_tool)?;
    let done = scheduler.wait("crashed-tool", Duration::from_secs(3))?;
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(exec_count.load(Ordering::SeqCst), 0);
    assert_eq!(done.result["isError"], true);
    let err_text = done.result["text"].as_str().unwrap();
    assert!(err_text.contains("interrupted:"), "got: {err_text}");
    assert!(err_text.contains("dirty.txt"), "expected git status in: {err_text}");
    Ok(())
}

#[test]
fn engine_tool_join_steering_skips_remaining_calls_and_pairs_ids() -> crate::durable::Result<()> {
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

    let (started_tx, started_rx) = flume::bounded(1);
    let (release_tx, release_rx) = flume::bounded(1);
    let first_calls = Arc::new(AtomicUsize::new(0));
    let second_calls = Arc::new(AtomicUsize::new(0));

    let mut brain = Brain::new(client.clone(), "deepseek-chat", "sys");
    brain.tools.push(Box::new(UnsafeCounterTool {
        name: "write_first".into(),
        calls: first_calls.clone(),
        started_tx: Some(started_tx),
        release_rx: Some(release_rx),
    }));
    brain.tools.push(Box::new(UnsafeCounterTool {
        name: "write_second".into(),
        calls: second_calls.clone(),
        started_tx: None,
        release_rx: None,
    }));

    let engine = Engine::new(store.clone(), Arc::new(FixedBrainProvider::new(Arc::new(brain)))).with_compactor(Compactor::deterministic(store.clone()));
    engine.register(&scheduler);
    scheduler.recover()?;

    let (_, task, _) = engine.submit(Request {
        conversation: "conv-steer",
        provider: "mock",
        request_id: "r1",
        prompt: "start",
        source: "user",
        system: "sys",
        ..Default::default()
    })?;

    started_rx.recv_timeout(Duration::from_secs(2)).expect("c1 started");
    let (steer_sub, _) = store.write(|tx| inbox::submit_steer(tx, "conv-steer", "steer-1", "pivot now"))?;
    let _ = release_tx.send(());

    let done = scheduler.wait(&task.id, Duration::from_secs(3))?;
    assert_eq!(done.result["output"], "steered reply");
    assert_eq!(first_calls.load(Ordering::SeqCst), 1);
    assert_eq!(second_calls.load(Ordering::SeqCst), 0);

    let updated_steer = store.read(|r| r.submission(&steer_sub.id))?;
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

    fn on_after_run(&self, ctx: &mut RunEndCtx<'_>) -> crate::durable::Result<HookOutcome> {
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
    }
}

#[test]
fn engine_yield_retry_and_follow_up_settle_together() -> crate::durable::Result<()> {
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
    scheduler.recover()?;

    let (prompt_sub, task, _) = engine.submit(Request {
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
    })?;
    let (fu_sub, _) = store.write(|tx| inbox::submit_follow_up(tx, "conv-fu", "r-fu", "also do X", None))?;

    let done = scheduler.wait(&task.id, Duration::from_secs(3))?;
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(done.result["output"], "follow up final");
    assert_eq!(done.result["rubricVerdict"]["satisfied"], true);

    assert_eq!(store.read(|r| r.submission(&prompt_sub.id))?.status, SubmissionStatus::Done);
    assert_eq!(store.read(|r| r.submission(&fu_sub.id))?.status, SubmissionStatus::Done);
    Ok(())
}

#[test]
fn engine_context_overflow_retries_after_compaction() -> crate::durable::Result<()> {
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
    scheduler.recover()?;

    store.write(|tx| {
        tx.create_conversation("conv-ov", "mock")?;
        tx.append_entry("conv-ov", "pi.user", &json!({"text": "old 1"}))?;
        tx.append_entry("conv-ov", "pi.assistant", &json!({"text": "old 2"}))?;
        Ok(())
    })?;

    let (_, task, _) = engine.submit(Request {
        conversation: "conv-ov",
        provider: "mock",
        request_id: "r-ov",
        prompt: "new question",
        source: "user",
        system: "",
        ..Default::default()
    })?;
    let done = scheduler.wait(&task.id, Duration::from_secs(3))?;
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

    fn on_before_tool(&self, ctx: &ToolCallHookCtx<'_>) -> crate::durable::Result<HookOutcome> {
        if ctx.tool_name == "danger" {
            return Ok(HookOutcome::Deny {
                reason: "blocked by policy".into(),
                overridable: false,
            });
        }
        Ok(HookOutcome::Continue)
    }
}

#[test]
fn engine_run_codemode_tool_shares_before_tool_hooks() -> crate::durable::Result<()> {
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

    let mut cm = Task::new(crate::codemode::KIND, crate::codemode::EXEC);
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
    store.write(|tx| {
        tx.create_conversation("conv-cm", "mock")?;
        Ok(())
    })?;
    scheduler.start(cm)?;
    let done = scheduler.wait("cm-1", Duration::from_secs(3))?;
    assert_eq!(done.terminal_reason, "completed", "{}", done.error_text);
    assert_eq!(exec_calls.load(Ordering::SeqCst), 0);
    assert!(done.result["value"].as_str().unwrap_or_default().contains("blocked by policy"));
    Ok(())
}
