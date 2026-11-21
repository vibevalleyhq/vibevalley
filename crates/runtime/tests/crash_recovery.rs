use std::collections::{BTreeMap, VecDeque};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;
use vibevalley_runtime::agent::ai::CancelToken;
use vibevalley_runtime::agent::compaction::{Compactor, FileOps, Level};
use vibevalley_runtime::agent::core::doc::{
    AgentDoc, AgentState, CONVERSATION_SCOPE, FileOpsDoc, GovernanceDoc, InboxDoc, OarSessionDoc, OarSessionState, StandInDoc, TASK_SCOPE, read_doc, write_doc,
};
use vibevalley_runtime::agent::core::engine::{KIND as GENERATION_KIND, PHASE_GENERATE, PHASE_TOOL_JOIN, PHASE_YIELD_CHECK, TOOL_KIND, TOOL_RUN};
use vibevalley_runtime::agent::core::events::AgentEvent;
use vibevalley_runtime::agent::core::pipeline::PromptSection;
use vibevalley_runtime::agent::core::tool::{Tool, ToolContext, ToolOutput};
use vibevalley_runtime::agent::durable::{Store, SubmissionStatus, Task, TaskStatus, WaitMode};
use vibevalley_runtime::agent::extensions::{
    CodeModeExtension, ExplicitReviewProvider, GovernanceExtension, GraderExtension, OAR_PHASE_OPEN, OAR_TASK_KIND, OarExtension, OarPolicy, Permissions,
    Policy, SubagentExtension, tree_spend,
};
use vibevalley_runtime::agent::harness::{Harness, StandIn, worker_conversation};
use vibevalley_runtime::agent::tools::{Workspace, coding_tools};
use vibevalley_runtime::agent::{
    Brain, BrainError, ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Result as AiResult, Role, ToolCall, ToolSpec, Usage,
};
use vibevalley_runtime::oar::Registry;
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step, TurnAsk};

const WAIT: Duration = Duration::from_secs(10);

#[derive(Clone)]
enum MockReply {
    Immediate(Completion),
    BlockUntilCancel,
}

struct MockModel {
    replies: Mutex<VecDeque<MockReply>>,
    seen: Mutex<Vec<ChatRequest>>,
    entered: Option<flume::Sender<()>>,
}

impl MockModel {
    fn new(replies: Vec<Completion>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into_iter().map(MockReply::Immediate).collect()),
            seen: Mutex::new(Vec::new()),
            entered: None,
        })
    }

    fn with_barrier(replies: Vec<MockReply>, entered: flume::Sender<()>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::new(Vec::new()),
            entered: Some(entered),
        })
    }
}

impl ModelClient for MockModel {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
        self.complete_cancellable(request, &CancelToken::never(), on)
    }

    fn complete_cancellable(&self, request: &ChatRequest, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
        self.seen.lock().unwrap().push(request.clone());
        let reply = self.replies.lock().unwrap().pop_front().expect("unexpected model call");
        match reply {
            MockReply::Immediate(comp) => {
                if let Some(t) = &comp.message.content {
                    on(Delta::Text(t.clone()));
                }
                Ok(comp)
            }
            MockReply::BlockUntilCancel => {
                if let Some(tx) = &self.entered {
                    let _ = tx.send(());
                }
                if let Some(rx) = cancel.receiver() {
                    let _ = rx.recv_timeout(WAIT);
                }
                Err(BrainError::Cancelled)
            }
        }
    }
}

fn say(text: &str) -> Completion {
    Completion {
        message: Message::assistant(text),
        finish: FinishReason::Stop,
        usage: Usage {
            input: 120,
            output: 20,
            cache_read: 40,
        },
    }
}

fn call_tool(id: &str, name: &str, args: Value) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: None,
            reasoning: None,
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: args.to_string(),
            }],
            tool_call_id: None,
        },
        finish: FinishReason::ToolCalls,
        usage: Usage {
            input: 100,
            output: 15,
            cache_read: 0,
        },
    }
}

struct BlockingCounterTool {
    name: &'static str,
    safe: bool,
    runs: Arc<AtomicUsize>,
    entered: Option<flume::Sender<()>>,
    block: bool,
    output: String,
}

impl Tool for BlockingCounterTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.into(),
            description: "blocking counter test tool".into(),
            parameters: json!({"type": "object"}),
        }
    }

    fn replay_safe(&self) -> bool {
        self.safe
    }

    fn execute(&self, _args: &Value) -> ToolOutput {
        self.execute_with_context(&json!({}), &ToolContext::background())
    }

    fn execute_with_context(&self, _args: &Value, ctx: &ToolContext) -> ToolOutput {
        self.runs.fetch_add(1, Ordering::SeqCst);
        if self.block {
            if let Some(tx) = &self.entered {
                let _ = tx.send(());
            }
            if let Some(rx) = ctx.cancel.receiver() {
                let _ = rx.recv_timeout(WAIT);
            }
            return ToolOutput::error("cancelled");
        }
        ToolOutput::ok(self.output.clone())
    }
}

fn build_harness(store: Store, extra_ext: Option<Arc<dyn vibevalley_runtime::agent::Extension>>) -> Harness {
    let harness = Harness::workers_only(store);
    harness.register_extension(Arc::new(GovernanceExtension::new(Permissions {
        builtin_default: Policy::AlwaysAllow,
        mcp_default: Policy::AlwaysAllow,
        overrides: BTreeMap::new(),
    })));
    harness.register_extension(Arc::new(SubagentExtension::new("VibeValley").without_global_tools()));
    harness.register_extension(Arc::new(CodeModeExtension::default()));
    if let Some(ext) = extra_ext {
        harness.register_extension(ext);
    }
    harness.recover().unwrap();
    harness
}

#[test]
fn row1_generate_crash_before_commit_retries_and_crash_after_next_phase_skips_model() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("r1a.db");
    let conv = worker_conversation("r1a");

    // Part A: crash mid-generate before pi.assistant commits -> recover() retries once and completes.
    let (entered_tx, entered_rx) = flume::bounded(1);
    let task_id = {
        let store = Store::open(&db).unwrap();
        let harness = build_harness(store.clone(), None);
        let c1 = MockModel::with_barrier(vec![MockReply::BlockUntilCancel], entered_tx);
        harness
            .attach_worker(&conv, Arc::new(Brain::new(c1, "deepseek-flash", "sys")), Arc::new(|_| {}))
            .unwrap();
        let (_, task, _) = harness.conversation(&conv).prompt("deepseek-flash", "req-1", "hi", "sys").unwrap();
        entered_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };
    {
        let store = Store::open(&db).unwrap();
        let entries_mid = store.read(|r| r.visible_entries(&conv)).unwrap();
        assert!(!entries_mid.iter().any(|e| e.kind == "pi.assistant"));

        let harness = build_harness(store.clone(), None);
        let c2 = MockModel::new(vec![say("recovered answer")]);
        harness
            .attach_worker(&conv, Arc::new(Brain::new(c2.clone(), "deepseek-flash", "sys")), Arc::new(|_| {}))
            .unwrap();
        let done = harness.scheduler().wait(&task_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "recovered answer");
        assert_eq!(c2.seen.lock().unwrap().len(), 1);
        harness.close();
        store.close().unwrap();
    }

    // Part B: crash after pi.assistant + next_phase = "yield_check" committed -> recover() advances without a second model call.
    let db2 = dir.path().join("r1b.db");
    let conv2 = worker_conversation("r1b");
    let gen_id = {
        let store = Store::open(&db2).unwrap();
        let tid = store
            .write(|tx| {
                tx.create_conversation(&conv2, "deepseek-flash")?;
                tx.append_entry(&conv2, "pi.system", &json!({"text": "sys", "delta": false}))?;
                tx.append_entry(&conv2, "pi.user", &json!({"text": "hi", "source": "user"}))?;
                tx.append_entry(
                    &conv2,
                    "pi.assistant",
                    &json!({"text": "committed reply", "toolCalls": [], "generationTask": "gen-committed"}),
                )?;
                let (sub, _) = tx.submit(&conv2, "req-2", "prompt", &json!({"text": "hi"}), None)?;
                let sub = tx.set_submission_status(&sub.id, SubmissionStatus::Placed)?;
                let mut t = Task::new(GENERATION_KIND, PHASE_GENERATE);
                t.id = format!("gen-{}", sub.id);
                t.is_model_task = true;
                t.conversation_id = conv2.clone();
                t.checkpoint = json!({
                    "prompt": "hi",
                    "submission": sub.id,
                    "requestId": "req-2",
                    "lastOutput": "committed reply",
                    "step": 1,
                    "nextPhase": PHASE_YIELD_CHECK,
                });
                tx.create_task(t.clone())?;
                Ok(t.id)
            })
            .unwrap();
        store.close().unwrap();
        tid
    };
    {
        let store = Store::open(&db2).unwrap();
        let harness = build_harness(store.clone(), None);
        let c3 = MockModel::new(vec![]);
        harness
            .attach_worker(&conv2, Arc::new(Brain::new(c3.clone(), "deepseek-flash", "sys")), Arc::new(|_| {}))
            .unwrap();
        let done = harness.scheduler().wait(&gen_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "committed reply");
        assert_eq!(c3.seen.lock().unwrap().len(), 0);
        harness.close();
        store.close().unwrap();
    }
}

#[test]
fn row2_safe_tool_reruns_trips_restart_limit_and_uses_memo_when_saved() {
    let dir = TempDir::new().unwrap();

    // Part A: crash mid-safe-tool (started == true, no output) -> re-runs and completes cleanly.
    let db_a = dir.path().join("r2a.db");
    let conv_a = worker_conversation("r2a");
    let runs_before = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered_rx) = flume::bounded(1);
    let task_id = {
        let store = Store::open(&db_a).unwrap();
        let harness = build_harness(store.clone(), None);
        let mut b = Brain::new(MockModel::new(vec![call_tool("c1", "safe_op", json!({}))]), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "safe_op",
            safe: true,
            runs: runs_before.clone(),
            entered: Some(entered_tx),
            block: true,
            output: String::new(),
        }));
        harness.attach_worker(&conv_a, Arc::new(b), Arc::new(|_| {})).unwrap();
        let (_, task, _) = harness.conversation(&conv_a).prompt("deepseek-flash", "req-a", "run safe", "sys").unwrap();
        entered_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };
    assert_eq!(runs_before.load(Ordering::SeqCst), 1);

    let runs_after = Arc::new(AtomicUsize::new(0));
    {
        let store = Store::open(&db_a).unwrap();
        let harness = build_harness(store.clone(), None);
        let mut b = Brain::new(MockModel::new(vec![say("safe ok")]), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "safe_op",
            safe: true,
            runs: runs_after.clone(),
            entered: None,
            block: false,
            output: "fresh-safe".into(),
        }));
        harness.attach_worker(&conv_a, Arc::new(b), Arc::new(|_| {})).unwrap();
        let done = harness.scheduler().wait(&task_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "safe ok");
        assert_eq!(runs_after.load(Ordering::SeqCst), 1);
        harness.close();
        store.close().unwrap();
    }

    // Part B: repeated crashes trip restart_limit (default 5) circuit breaker and emit restart_limit alert.
    let db_b = dir.path().join("r2b.db");
    let conv_b = worker_conversation("r2b");
    let limit_runs = Arc::new(AtomicUsize::new(0));
    let (enter_b_tx, enter_b_rx) = flume::unbounded();
    let root_id = {
        let store = Store::open(&db_b).unwrap();
        let harness = build_harness(store.clone(), None);
        let mut b = Brain::new(MockModel::new(vec![call_tool("c1", "flaky_safe", json!({}))]), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "flaky_safe",
            safe: true,
            runs: limit_runs.clone(),
            entered: Some(enter_b_tx.clone()),
            block: true,
            output: String::new(),
        }));
        harness.attach_worker(&conv_b, Arc::new(b), Arc::new(|_| {})).unwrap();
        let (_, task, _) = harness.conversation(&conv_b).prompt("deepseek-flash", "req-b", "loop crash", "sys").unwrap();
        enter_b_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };
    for _ in 0..4 {
        let store = Store::open(&db_b).unwrap();
        let harness = build_harness(store.clone(), None);
        let mut b = Brain::new(MockModel::new(vec![]), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "flaky_safe",
            safe: true,
            runs: limit_runs.clone(),
            entered: Some(enter_b_tx.clone()),
            block: true,
            output: String::new(),
        }));
        harness.attach_worker(&conv_b, Arc::new(b), Arc::new(|_| {})).unwrap();
        enter_b_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
    }
    {
        let store = Store::open(&db_b).unwrap();
        let harness = build_harness(store.clone(), None);
        let mut b = Brain::new(MockModel::new(vec![say("saw restart limit")]), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "flaky_safe",
            safe: true,
            runs: limit_runs.clone(),
            entered: None,
            block: false,
            output: "never".into(),
        }));
        harness.attach_worker(&conv_b, Arc::new(b), Arc::new(|_| {})).unwrap();
        let done = harness.scheduler().wait(&root_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        let children = store.read(|tx| tx.children(&root_id)).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].terminal_reason, "restart_limit");
        let inbox = store.read(|tx| read_doc::<InboxDoc>(tx, CONVERSATION_SCOPE, &conv_b)).unwrap();
        assert!(inbox.items.iter().any(|item| item["kind"] == "restart_limit"), "{inbox:?}");
        harness.close();
        store.close().unwrap();
    }

    // Part C: crash after memo["output"] stored -> recover() uses memoized result without re-running.
    let db_c = dir.path().join("r2c.db");
    let conv_c = worker_conversation("r2c");
    let gen_c = {
        let store = Store::open(&db_c).unwrap();
        let gid = store
            .write(|tx| {
                tx.create_conversation(&conv_c, "deepseek-flash")?;
                tx.append_entry(&conv_c, "pi.system", &json!({"text": "sys", "delta": false}))?;
                tx.append_entry(&conv_c, "pi.user", &json!({"text": "memo", "source": "user"}))?;
                let (sub, _) = tx.submit(&conv_c, "req-c", "prompt", &json!({"text": "memo"}), None)?;
                let sub = tx.set_submission_status(&sub.id, SubmissionStatus::Placed)?;
                let mut gen_task = Task::new(GENERATION_KIND, PHASE_TOOL_JOIN);
                gen_task.id = format!("gen-{}", sub.id);
                gen_task.is_model_task = true;
                gen_task.conversation_id = conv_c.clone();

                let mut child = Task::new(TOOL_KIND, TOOL_RUN);
                child.owner_task_id = gen_task.id.clone();
                child.conversation_id = conv_c.clone();
                child.dedup_key = format!("{}:s1:cc1", gen_task.id);
                child.status = TaskStatus::Running;
                child.memo = json!({
                    "started": true,
                    "output": {
                        "callId": "c1",
                        "toolName": "safe_op",
                        "text": "memoized-42",
                        "isError": false,
                        "overridable": true,
                    }
                });
                child.checkpoint = json!({
                    "parentTaskId": gen_task.id,
                    "step": 1,
                    "call": { "id": "c1", "name": "safe_op", "arguments": "{}" },
                    "args": {},
                    "prompt": "memo",
                    "submissionId": sub.id,
                    "requestId": "req-c",
                    "iteration": 0,
                });
                let (child, _) = tx.create_task(child)?;

                gen_task.status = TaskStatus::Waiting;
                gen_task.wait_mode = Some(WaitMode::AllSettled);
                gen_task.wait_task_ids = vec![child.id.clone()];
                gen_task.checkpoint = json!({
                    "prompt": "memo",
                    "submission": sub.id,
                    "requestId": "req-c",
                    "step": 1,
                    "calls": [{ "id": "c1", "name": "safe_op", "arguments": "{}" }],
                    "index": 0,
                    "batchCalls": [child.id],
                });
                tx.create_task(gen_task.clone())?;
                tx.append_entry(
                    &conv_c,
                    "pi.assistant",
                    &json!({
                        "text": Value::Null,
                        "toolCalls": [{ "id": "c1", "toolName": "safe_op", "argsJson": {}, "rawArguments": "{}" }],
                        "generationTask": gen_task.id,
                    }),
                )?;
                Ok(gen_task.id)
            })
            .unwrap();
        store.close().unwrap();
        gid
    };
    let memo_runs = Arc::new(AtomicUsize::new(0));
    {
        let store = Store::open(&db_c).unwrap();
        let harness = build_harness(store.clone(), None);
        let c_model = MockModel::new(vec![say("saw memo")]);
        let mut b = Brain::new(c_model.clone(), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "safe_op",
            safe: true,
            runs: memo_runs.clone(),
            entered: None,
            block: false,
            output: "should-not-run".into(),
        }));
        harness.attach_worker(&conv_c, Arc::new(b), Arc::new(|_| {})).unwrap();
        let done = harness.scheduler().wait(&gen_c, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(memo_runs.load(Ordering::SeqCst), 0);
        let seen = c_model.seen.lock().unwrap();
        assert_eq!(seen[0].messages.last().unwrap().content.as_deref(), Some("memoized-42"));
        harness.close();
        store.close().unwrap();
    }
}

#[test]
fn row3_unsafe_tool_crash_blocks_replay_and_reports_git_status() {
    let dir = TempDir::new().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap().success());
    std::fs::write(repo.join("dirty_tool.txt"), "half-written\n").unwrap();

    let db = dir.path().join("r3.db");
    let conv = worker_conversation("r3");
    let runs_before = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered_rx) = flume::bounded(1);
    let task_id = {
        let store = Store::open(&db).unwrap();
        let harness = build_harness(store.clone(), None);
        let mut b = Brain::new(MockModel::new(vec![call_tool("u1", "unsafe_op", json!({}))]), "deepseek-flash", "sys");
        b.cwd = Some(repo.clone());
        b.tools.push(Box::new(BlockingCounterTool {
            name: "unsafe_op",
            safe: false,
            runs: runs_before.clone(),
            entered: Some(entered_tx),
            block: true,
            output: String::new(),
        }));
        harness.attach_worker(&conv, Arc::new(b), Arc::new(|_| {})).unwrap();
        let (_, task, _) = harness.conversation(&conv).prompt("deepseek-flash", "req-3", "write file", "sys").unwrap();
        entered_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };
    assert_eq!(runs_before.load(Ordering::SeqCst), 1);

    let runs_after = Arc::new(AtomicUsize::new(0));
    {
        let store = Store::open(&db).unwrap();
        let harness = build_harness(store.clone(), None);
        let model = MockModel::new(vec![say("inspected git status")]);
        let mut b = Brain::new(model.clone(), "deepseek-flash", "sys");
        b.cwd = Some(repo);
        b.tools.push(Box::new(BlockingCounterTool {
            name: "unsafe_op",
            safe: false,
            runs: runs_after.clone(),
            entered: None,
            block: false,
            output: "never".into(),
        }));
        harness.attach_worker(&conv, Arc::new(b), Arc::new(|_| {})).unwrap();
        let done = harness.scheduler().wait(&task_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(runs_after.load(Ordering::SeqCst), 0);
        let seen = model.seen.lock().unwrap();
        let tool_msg = seen[0].messages.last().unwrap().content.as_deref().unwrap();
        assert!(tool_msg.contains("interrupted"), "{tool_msg}");
        assert!(tool_msg.contains("dirty_tool.txt"), "{tool_msg}");
        harness.close();
        store.close().unwrap();
    }
}

#[test]
fn row4_steer_survives_restart_with_paired_tool_results_and_follow_up_defers_primary_settlement() {
    let dir = TempDir::new().unwrap();

    // Part A: durable steer queued mid-batch across restart skips remaining unstarted calls and preserves tool_call_id pairing.
    let db_a = dir.path().join("r4a.db");
    let conv_a = worker_conversation("r4a");
    let c1_runs = Arc::new(AtomicUsize::new(0));
    let c2_runs = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered_rx) = flume::bounded(1);
    let task_id = {
        let store = Store::open(&db_a).unwrap();
        let harness = build_harness(store.clone(), None);
        let batch_call = Completion {
            message: Message {
                role: Role::Assistant,
                content: None,
                reasoning: None,
                tool_calls: vec![
                    ToolCall {
                        id: "c1".into(),
                        name: "step_one".into(),
                        arguments: "{}".into(),
                    },
                    ToolCall {
                        id: "c2".into(),
                        name: "step_two".into(),
                        arguments: "{}".into(),
                    },
                ],
                tool_call_id: None,
            },
            finish: FinishReason::ToolCalls,
            usage: Usage::default(),
        };
        let mut b = Brain::new(MockModel::new(vec![batch_call]), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "step_one",
            safe: true,
            runs: c1_runs.clone(),
            entered: Some(entered_tx),
            block: true,
            output: String::new(),
        }));
        b.tools.push(Box::new(BlockingCounterTool {
            name: "step_two",
            safe: false,
            runs: c2_runs.clone(),
            entered: None,
            block: false,
            output: "two".into(),
        }));
        harness.attach_worker(&conv_a, Arc::new(b), Arc::new(|_| {})).unwrap();
        let handle = harness.conversation(&conv_a);
        let (_, task, _) = handle.prompt("deepseek-flash", "req-s", "run two", "sys").unwrap();
        entered_rx.recv_timeout(WAIT).unwrap();
        handle.steer("steer-1", "pivot immediately").unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };
    {
        let store = Store::open(&db_a).unwrap();
        let harness = build_harness(store.clone(), None);
        let model2 = MockModel::new(vec![say("steered cleanly")]);
        let mut b = Brain::new(model2.clone(), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "step_one",
            safe: true,
            runs: c1_runs,
            entered: None,
            block: false,
            output: "one-ok".into(),
        }));
        b.tools.push(Box::new(BlockingCounterTool {
            name: "step_two",
            safe: false,
            runs: c2_runs.clone(),
            entered: None,
            block: false,
            output: "two".into(),
        }));
        harness.attach_worker(&conv_a, Arc::new(b), Arc::new(|_| {})).unwrap();
        let done = harness.scheduler().wait(&task_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "steered cleanly");
        assert_eq!(c2_runs.load(Ordering::SeqCst), 0);
        let seen = model2.seen.lock().unwrap();
        let msgs = &seen[0].messages;
        assert!(msgs.iter().any(|m| m.role == Role::Tool
            && m.tool_call_id.as_deref() == Some("c2")
            && m.content.as_deref().is_some_and(|t| t.contains("skipped due to user steering"))));
        assert_eq!(msgs.last().unwrap().content.as_deref(), Some("pivot immediately"));
        harness.close();
        store.close().unwrap();
    }

    // Part B: follow_up submitted during active turn runs in next round before primary submission settles.
    let store_b = Store::memory().unwrap();
    let harness_b = build_harness(store_b.clone(), None);
    let conv_b = worker_conversation("r4b");
    let (gate_tx, gate_rx) = flume::bounded(1);
    let (in_tx, in_rx) = flume::bounded(1);
    struct GateTool(flume::Sender<()>, flume::Receiver<()>);
    impl Tool for GateTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "gate".into(),
                description: "gate".into(),
                parameters: json!({"type": "object"}),
            }
        }
        fn execute(&self, _: &Value) -> ToolOutput {
            let _ = self.0.send(());
            let _ = self.1.recv_timeout(WAIT);
            ToolOutput::ok("released")
        }
    }
    let mut b = Brain::new(
        MockModel::new(vec![call_tool("g1", "gate", json!({})), say("round 1"), say("round 2")]),
        "deepseek-flash",
        "sys",
    );
    b.tools.push(Box::new(GateTool(in_tx, gate_rx)));
    harness_b.attach_worker(&conv_b, Arc::new(b), Arc::new(|_| {})).unwrap();
    let handle_b = harness_b.conversation(&conv_b);
    let (primary_sub, task_b, _) = handle_b.prompt("deepseek-flash", "req-fu", "first", "sys").unwrap();
    in_rx.recv_timeout(WAIT).unwrap();
    let (fu_sub, _) = handle_b.follow_up("fu-1", "second").unwrap();
    assert_eq!(store_b.read(|r| r.submission(&primary_sub.id)).unwrap().status, SubmissionStatus::Placed);
    gate_tx.send(()).unwrap();
    let done_b = harness_b.scheduler().wait(&task_b.id, WAIT).unwrap();
    assert_eq!(done_b.result["output"], "round 2");
    assert_eq!(store_b.read(|r| r.submission(&primary_sub.id)).unwrap().status, SubmissionStatus::Done);
    assert_eq!(store_b.read(|r| r.submission(&fu_sub.id)).unwrap().status, SubmissionStatus::Done);
    harness_b.close();
}

#[test]
fn row5_subagent_crash_resumes_same_child_tracks_tree_spend_and_cascades_abort() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("r5.db");
    let conv = worker_conversation("r5-parent");
    let (entered_tx, entered_rx) = flume::bounded(1);
    let child_runs_p1 = Arc::new(AtomicUsize::new(0));

    let parent_task_id = {
        let store = Store::open(&db).unwrap();
        let harness = build_harness(store.clone(), None);
        let model = MockModel::new(vec![
            call_tool("sp1", "spawn_agent", json!({"brief": "inspect helper", "label": "scout"})),
            call_tool("ch1", "helper_wait", json!({})),
        ]);
        let mut b = Brain::new(model, "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "helper_wait",
            safe: true,
            runs: child_runs_p1.clone(),
            entered: Some(entered_tx),
            block: true,
            output: String::new(),
        }));
        harness.attach_worker(&conv, Arc::new(b), Arc::new(|_| {})).unwrap();
        let (_, task, _) = harness.conversation(&conv).prompt("deepseek-flash", "req-5", "delegate", "sys").unwrap();
        entered_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };

    let child_runs_p2 = Arc::new(AtomicUsize::new(0));
    {
        let store = Store::open(&db).unwrap();
        let child_convs_before = store
            .read(|tx| {
                let tools = tx.children(&parent_task_id)?;
                assert_eq!(tools.len(), 1);
                tx.conversations_by_owner_task(&tools[0].id)
            })
            .unwrap();
        assert_eq!(child_convs_before.len(), 1);
        let child_conv_id = child_convs_before[0].id.clone();

        let harness = build_harness(store.clone(), None);
        let model2 = MockModel::new(vec![say("child done"), say("parent finished")]);
        let mut b = Brain::new(model2, "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "helper_wait",
            safe: true,
            runs: child_runs_p2.clone(),
            entered: None,
            block: false,
            output: "child-ok".into(),
        }));
        harness.attach_worker(&conv, Arc::new(b), Arc::new(|_| {})).unwrap();
        let done = harness.scheduler().wait(&parent_task_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "parent finished");
        assert_eq!(child_runs_p2.load(Ordering::SeqCst), 1);

        let spent = store.read(|tx| tree_spend(tx, &conv)).unwrap();
        assert!(spent > 0, "expected tree_spend to include parent & child spend, got {spent}");

        let child_convs_after = store
            .read(|tx| {
                let tools = tx.children(&parent_task_id)?;
                tx.conversations_by_owner_task(&tools[0].id)
            })
            .unwrap();
        assert_eq!(child_convs_after.len(), 1);
        assert_eq!(child_convs_after[0].id, child_conv_id);
        harness.close();
        store.close().unwrap();
    }

    // Cascade abort checks children-first abort_tree on live subagent.
    let store_abort = Store::memory().unwrap();
    let harness_abort = build_harness(store_abort.clone(), None);
    let conv_abort = worker_conversation("r5-abort");
    let (enter_ab_tx, enter_ab_rx) = flume::bounded(1);
    let mut b_abort = Brain::new(
        MockModel::new(vec![
            call_tool("sp1", "spawn_agent", json!({"brief": "hang in child"})),
            call_tool("ch1", "helper_wait", json!({})),
        ]),
        "deepseek-flash",
        "sys",
    );
    b_abort.tools.push(Box::new(BlockingCounterTool {
        name: "helper_wait",
        safe: false,
        runs: Arc::new(AtomicUsize::new(0)),
        entered: Some(enter_ab_tx),
        block: true,
        output: String::new(),
    }));
    harness_abort.attach_worker(&conv_abort, Arc::new(b_abort), Arc::new(|_| {})).unwrap();
    let handle_abort = harness_abort.conversation(&conv_abort);
    let (_, task_abort, _) = handle_abort.prompt("deepseek-flash", "req-ab", "abort me", "sys").unwrap();
    enter_ab_rx.recv_timeout(WAIT).unwrap();
    handle_abort.abort().unwrap();
    let done_abort = harness_abort.scheduler().wait(&task_abort.id, WAIT).unwrap();
    assert_eq!(done_abort.terminal_reason, "aborted");
    let trace = harness_abort.scheduler().abort_trace();
    assert!(trace.len() >= 3, "expected cascade abort of child generation -> tool -> parent: {trace:?}");
    harness_abort.close();
}

#[test]
fn row6_oar_run_crash_before_turn_resumes_and_crash_after_turn_started_returns_interrupted() {
    let dir = TempDir::new().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap().success());
    std::fs::write(repo.join("dirty_oar.txt"), "wip\n").unwrap();

    // Part A: crash after OarSessionDoc persisted in `open` phase before turnStarted -> recovers cleanly.
    let db_a = dir.path().join("r6a.db");
    let conv_a = worker_conversation("r6a");
    let runs_a = Arc::new(AtomicUsize::new(0));
    let runs_a_ref = runs_a.clone();
    let mut reg_a = Registry::new();
    reg_a.register(Arc::new(ScriptedRuntime::new(
        "scripted",
        Script::computed(Arc::new(move |_: &TurnAsk| {
            runs_a_ref.fetch_add(1, Ordering::SeqCst);
            Ok(vec![
                Step::text("resumed from open"),
                Step::finish(vibevalley_runtime::oar::StopReason::Completed),
            ])
        })),
    )));
    let store_a = Store::open(&db_a).unwrap();
    let gen_a = store_a
        .write(|tx| {
            tx.create_conversation(&conv_a, "deepseek-flash")?;
            tx.append_entry(&conv_a, "pi.system", &json!({"text": "sys", "delta": false}))?;
            tx.append_entry(&conv_a, "pi.user", &json!({"text": "run oar", "source": "user"}))?;
            let (sub, _) = tx.submit(&conv_a, "req-6a", "prompt", &json!({"text": "run oar"}), None)?;
            let sub = tx.set_submission_status(&sub.id, SubmissionStatus::Placed)?;

            let mut gen_task = Task::new(GENERATION_KIND, PHASE_TOOL_JOIN);
            gen_task.id = format!("gen-{}", sub.id);
            gen_task.is_model_task = true;
            gen_task.conversation_id = conv_a.clone();

            let mut tool_task = Task::new(TOOL_KIND, TOOL_RUN);
            tool_task.owner_task_id = gen_task.id.clone();
            tool_task.conversation_id = conv_a.clone();
            tool_task.dedup_key = format!("{}:s1:co1", gen_task.id);
            tool_task.checkpoint = json!({
                "parentTaskId": gen_task.id,
                "step": 1,
                "call": { "id": "o1", "name": "oar_run", "arguments": json!({"runtime": "scripted", "cwd": repo, "prompt": "do"}).to_string() },
                "args": { "runtime": "scripted", "cwd": repo, "prompt": "do" },
                "prompt": "run oar",
                "submissionId": sub.id,
                "requestId": "req-6a",
                "iteration": 0,
            });
            let (tool_task, _) = tx.create_task(tool_task)?;

            let mut oar_task = Task::new(OAR_TASK_KIND, OAR_PHASE_OPEN);
            oar_task.owner_task_id = tool_task.id.clone();
            oar_task.conversation_id = conv_a.clone();
            oar_task.dedup_key = format!("oar:{}", tool_task.id);
            oar_task.checkpoint = json!({
                "parentToolTaskId": tool_task.id,
                "parentConvId": conv_a,
                "callId": "o1",
                "runtime": "scripted",
                "cwd": repo.to_string_lossy(),
                "canonicalCwd": std::fs::canonicalize(&repo).unwrap().to_string_lossy(),
                "prompt": "do",
                "permissionMode": "Plan",
                "depth": 0,
            });
            let (oar_task, _) = tx.create_task(oar_task)?;
            write_doc::<OarSessionDoc>(
                tx,
                TASK_SCOPE,
                &oar_task.id,
                &OarSessionState {
                    runtime_id: "scripted".into(),
                    vendor_session_id: "v-open-1".into(),
                    cwd: repo.to_string_lossy().into_owned(),
                    permission_mode: "plan".into(),
                    status: "opened".into(),
                },
            )?;

            let mut tool_task = tx.task(&tool_task.id)?;
            tool_task.status = TaskStatus::Waiting;
            tool_task.wait_mode = Some(WaitMode::AllSettled);
            tool_task.wait_task_ids = vec![oar_task.id];
            tx.update_task(&tool_task)?;

            gen_task.status = TaskStatus::Waiting;
            gen_task.wait_mode = Some(WaitMode::AllSettled);
            gen_task.wait_task_ids = vec![tool_task.id.clone()];
            gen_task.checkpoint = json!({
                "prompt": "run oar",
                "submission": sub.id,
                "requestId": "req-6a",
                "step": 1,
                "calls": [{ "id": "o1", "name": "oar_run", "arguments": json!({"runtime": "scripted", "cwd": repo, "prompt": "do"}).to_string() }],
                "index": 0,
                "batchCalls": [tool_task.id],
            });
            tx.create_task(gen_task.clone())?;
            tx.append_entry(
                &conv_a,
                "pi.assistant",
                &json!({
                    "text": Value::Null,
                    "toolCalls": [{ "id": "o1", "toolName": "oar_run", "argsJson": {"runtime": "scripted"}, "rawArguments": "{}" }],
                    "generationTask": gen_task.id,
                }),
            )?;
            Ok(gen_task.id)
        })
        .unwrap();
    store_a.close().unwrap();

    {
        let store = Store::open(&db_a).unwrap();
        let oar_ext = Arc::new(OarExtension::new(Arc::new(reg_a), OarPolicy::default()));
        let harness = build_harness(store.clone(), Some(oar_ext));
        let model = MockModel::new(vec![say("open crash recovered")]);
        harness
            .attach_worker(&conv_a, Arc::new(Brain::new(model.clone(), "deepseek-flash", "sys")), Arc::new(|_| {}))
            .unwrap();
        let done = harness.scheduler().wait(&gen_a, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(runs_a.load(Ordering::SeqCst), 1);
        let seen = model.seen.lock().unwrap();
        assert!(seen[0].messages.last().unwrap().content.as_deref().unwrap().contains("resumed from open"));
        harness.close();
        store.close().unwrap();
    }

    // Part B: live crash AFTER memo["turnStarted"] = true -> recover() returns interrupted + gitStatus with 0 reprompts.
    let db_b = dir.path().join("r6b.db");
    let conv_b = worker_conversation("r6b");
    let (enter_b_tx, enter_b_rx) = flume::bounded(1);
    let p1_prompts = Arc::new(AtomicUsize::new(0));
    let p1_ref = p1_prompts.clone();
    let gen_b = {
        let mut reg = Registry::new();
        reg.register(Arc::new(ScriptedRuntime::new(
            "scripted",
            Script::computed(Arc::new(move |_: &TurnAsk| {
                p1_ref.fetch_add(1, Ordering::SeqCst);
                let _ = enter_b_tx.send(());
                Ok(vec![Step::Sleep(WAIT)])
            })),
        )));
        let store = Store::open(&db_b).unwrap();
        let harness = build_harness(store.clone(), Some(Arc::new(OarExtension::new(Arc::new(reg), OarPolicy::default()))));
        let model = MockModel::new(vec![call_tool(
            "o2",
            "oar_run",
            json!({"runtime": "scripted", "cwd": repo, "prompt": "edit repo", "permissionMode": "bypass"}),
        )]);
        harness
            .attach_worker(&conv_b, Arc::new(Brain::new(model, "deepseek-flash", "sys")), Arc::new(|_| {}))
            .unwrap();
        let (_, task, _) = harness.conversation(&conv_b).prompt("deepseek-flash", "req-6b", "delegate", "sys").unwrap();
        enter_b_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };
    assert_eq!(p1_prompts.load(Ordering::SeqCst), 1);

    let p2_prompts = Arc::new(AtomicUsize::new(0));
    let p2_ref = p2_prompts.clone();
    {
        let mut reg2 = Registry::new();
        reg2.register(Arc::new(ScriptedRuntime::new(
            "scripted",
            Script::computed(Arc::new(move |_: &TurnAsk| {
                p2_ref.fetch_add(1, Ordering::SeqCst);
                Ok(vec![Step::text("should not run")])
            })),
        )));
        let store = Store::open(&db_b).unwrap();
        let harness = build_harness(store.clone(), Some(Arc::new(OarExtension::new(Arc::new(reg2), OarPolicy::default()))));
        let model2 = MockModel::new(vec![say("saw interrupted oar")]);
        harness
            .attach_worker(&conv_b, Arc::new(Brain::new(model2.clone(), "deepseek-flash", "sys")), Arc::new(|_| {}))
            .unwrap();
        let done = harness.scheduler().wait(&gen_b, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "saw interrupted oar");
        assert_eq!(p2_prompts.load(Ordering::SeqCst), 0);
        let seen = model2.seen.lock().unwrap();
        let tool_json: Value = serde_json::from_str(seen[0].messages.last().unwrap().content.as_deref().unwrap()).unwrap();
        assert_eq!(tool_json["interrupted"], true);
        assert_eq!(tool_json["runtimeId"], "scripted");
        assert!(tool_json["gitStatus"].as_str().unwrap().contains("dirty_oar.txt"));
        harness.close();
        store.close().unwrap();
    }
}

#[test]
fn row7_codemode_crash_after_call1_replays_without_reexecuting_call1() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("r7.db");
    let conv = worker_conversation("r7");
    let c1_p1 = Arc::new(AtomicUsize::new(0));
    let c2_p1 = Arc::new(AtomicUsize::new(0));
    let (enter_tx, enter_rx) = flume::bounded(1);

    let task_id = {
        let store = Store::open(&db).unwrap();
        let harness = build_harness(store.clone(), None);
        let script = r#"
            const first = call("c1", { n: 1 });
            const second = call("c2", { prev: first });
            return { first, second };
        "#;
        let mut b = Brain::new(
            MockModel::new(vec![call_tool("cm1", "run_code", json!({"script": script, "seed": 7}))]),
            "deepseek-flash",
            "sys",
        );
        b.tools.push(Box::new(BlockingCounterTool {
            name: "c1",
            safe: true,
            runs: c1_p1.clone(),
            entered: None,
            block: false,
            output: json!({"step": 1}).to_string(),
        }));
        b.tools.push(Box::new(BlockingCounterTool {
            name: "c2",
            safe: true,
            runs: c2_p1.clone(),
            entered: Some(enter_tx),
            block: true,
            output: String::new(),
        }));
        harness.attach_worker(&conv, Arc::new(b), Arc::new(|_| {})).unwrap();
        let (_, task, _) = harness.conversation(&conv).prompt("deepseek-flash", "req-7", "run js", "sys").unwrap();
        enter_rx.recv_timeout(WAIT).unwrap();
        harness.close();
        drop(harness);
        store.close().unwrap();
        task.id
    };
    assert_eq!(c1_p1.load(Ordering::SeqCst), 1);

    let c1_p2 = Arc::new(AtomicUsize::new(0));
    let c2_p2 = Arc::new(AtomicUsize::new(0));
    {
        let store = Store::open(&db).unwrap();
        let harness = build_harness(store.clone(), None);
        let model2 = MockModel::new(vec![say("codemode recovered")]);
        let mut b = Brain::new(model2.clone(), "deepseek-flash", "sys");
        b.tools.push(Box::new(BlockingCounterTool {
            name: "c1",
            safe: true,
            runs: c1_p2.clone(),
            entered: None,
            block: false,
            output: json!({"step": 999}).to_string(),
        }));
        b.tools.push(Box::new(BlockingCounterTool {
            name: "c2",
            safe: true,
            runs: c2_p2.clone(),
            entered: None,
            block: false,
            output: json!({"step": 2}).to_string(),
        }));
        harness.attach_worker(&conv, Arc::new(b), Arc::new(|_| {})).unwrap();
        let done = harness.scheduler().wait(&task_id, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "codemode recovered");
        assert_eq!(c1_p2.load(Ordering::SeqCst), 0, "memoized call 1 must not re-run");
        assert_eq!(c2_p2.load(Ordering::SeqCst), 1, "interrupted call 2 runs once on recovery");
        let seen = model2.seen.lock().unwrap();
        let res_json: Value = serde_json::from_str(seen[0].messages.last().unwrap().content.as_deref().unwrap()).unwrap();
        assert_eq!(res_json["value"], json!({"first": {"step": 1}, "second": {"step": 2}}));
        harness.close();
        store.close().unwrap();
    }
}

#[test]
fn row8_llm_compaction_tracks_file_ops_and_rejects_stale_base_head() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("alpha.txt"), "hello world\n").unwrap();
    let store = Store::memory().unwrap();
    let mut harness = build_harness(store.clone(), None);
    let llm_summary = "Goal: inspect alpha and write beta\nProgress: done";
    let summarizer_client = MockModel::new(vec![say(llm_summary)]);
    let mut compactor = Compactor::with_llm(store.clone(), summarizer_client, "deepseek-flash");
    compactor.keep_recent = 1;
    compactor.hard_tokens = 200;
    harness = harness.with_compactor(compactor.clone());

    let conv = worker_conversation("r8");
    let client = MockModel::new(vec![
        call_tool("rd1", "read", json!({"path": "alpha.txt"})),
        call_tool("wr1", "write", json!({"path": "beta.txt", "content": "updated"})),
        say("finished edits"),
        say("after compaction"),
    ]);
    let mut b = Brain::new(client.clone(), "deepseek-flash", "sys");
    b.tools = coding_tools(&Workspace::new(dir.path()));
    let compacted_events = Arc::new(AtomicBool::new(false));
    let ce = compacted_events.clone();
    harness
        .attach_worker(
            &conv,
            Arc::new(b),
            Arc::new(move |e| {
                if matches!(e, AgentEvent::Compacted { level, .. } if level == "hard") {
                    ce.store(true, Ordering::SeqCst);
                }
            }),
        )
        .unwrap();

    let (_, t1, _) = harness
        .conversation(&conv)
        .prompt("deepseek-flash", "r8-1", "read alpha write beta", "sys")
        .unwrap();
    harness.scheduler().wait(&t1.id, WAIT).unwrap();

    // Second turn triggers hard compaction via LlmSummarizer.
    let (_, t2, _) = harness.conversation(&conv).prompt("deepseek-flash", "r8-2", "follow up", "sys").unwrap();
    let d2 = harness.scheduler().wait(&t2.id, WAIT).unwrap();
    assert_eq!(d2.terminal_reason, "completed");
    assert!(compacted_events.load(Ordering::SeqCst));

    let ops: FileOps = store.read(|tx| read_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, &conv)).unwrap();
    assert!(ops.read.contains("alpha.txt"), "{ops:?}");
    assert!(ops.modified.contains("beta.txt"), "{ops:?}");

    // Stale base_head compaction is safely ignored without corrupting newer entries.
    let before_entries = harness.entries(&conv).unwrap();
    let head = store.read(|tx| Ok(tx.conversation(&conv)?.head_seq)).unwrap();
    let stale = store
        .write(|tx| {
            tx.compact(
                &conv,
                vibevalley_runtime::agent::durable::Compaction {
                    level: Level::Soft.name(),
                    base_head: (head - 1).max(1),
                    from: 1,
                    cut: head,
                    summary: "stale summary",
                    token_count: 10,
                },
            )
        })
        .unwrap();
    assert!(stale.is_none());
    assert_eq!(harness.entries(&conv).unwrap().len(), before_entries.len());
    harness.close();
}

#[test]
fn row9_grader_reuses_persisted_verdict_and_standin_recovers_missing_extension() {
    let dir = TempDir::new().unwrap();

    // Part A: crash after pi.verdict persisted on grader conv -> recover() reuses verdict without re-calling grader LLM.
    let db_a = dir.path().join("r9a.db");
    let conv_a = worker_conversation("r9a");
    let gen_a = {
        let store = Store::open(&db_a).unwrap();
        let gid = store
            .write(|tx| {
                tx.create_conversation(&conv_a, "deepseek-flash")?;
                tx.append_entry(&conv_a, "pi.system", &json!({"text": "sys", "delta": false}))?;
                tx.append_entry(&conv_a, "pi.user", &json!({"text": "deliver", "source": "user"}))?;
                tx.append_entry(&conv_a, "pi.assistant", &json!({"text": "done", "toolCalls": []}))?;
                let (sub, _) = tx.submit(&conv_a, "req-9a", "prompt", &json!({"text": "deliver"}), None)?;
                let sub = tx.set_submission_status(&sub.id, SubmissionStatus::Placed)?;
                let mut t = Task::new(GENERATION_KIND, PHASE_YIELD_CHECK);
                t.id = format!("gen-{}", sub.id);
                t.is_model_task = true;
                t.conversation_id = conv_a.clone();
                t.checkpoint = json!({
                    "prompt": "deliver",
                    "submission": sub.id,
                    "requestId": "req-9a",
                    "lastOutput": "done",
                    "rubric": { "markdown": "- test passes", "maxIterations": 3 },
                });
                tx.create_task(t.clone())?;

                let reference = format!("{}:grader:1", t.id);
                tx.create_owned_conversation(&reference, "deepseek-flash", &t.id)?;
                tx.append_entry(&reference, "pi.system", &json!({"text": "grader"}))?;
                tx.append_entry(&reference, "pi.user", &json!({"candidateOutput": "done"}))?;
                write_doc::<AgentDoc>(
                    tx,
                    CONVERSATION_SCOPE,
                    &reference,
                    &AgentState {
                        role: "outcome_grader".into(),
                        model: String::new(),
                        read_only: true,
                        tools: vec![],
                        max_iterations: Some(3),
                    },
                )?;
                tx.put_document(
                    CONVERSATION_SCOPE,
                    &reference,
                    "pi.verdict",
                    &json!({"satisfied": true, "summary": "cached verdict", "unmetItems": [], "iteration": 1}),
                )?;
                Ok(t.id)
            })
            .unwrap();
        store.close().unwrap();
        gid
    };
    {
        let store = Store::open(&db_a).unwrap();
        let harness = build_harness(store.clone(), Some(Arc::new(GraderExtension::new(Arc::new(ExplicitReviewProvider)))));
        let grader_model = MockModel::new(vec![]);
        harness
            .attach_worker(&conv_a, Arc::new(Brain::new(grader_model.clone(), "deepseek-flash", "sys")), Arc::new(|_| {}))
            .unwrap();
        let done = harness.scheduler().wait(&gen_a, WAIT).unwrap();
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["rubricVerdict"]["summary"], "cached verdict");
        assert_eq!(grader_model.seen.lock().unwrap().len(), 0);
        let gov = store.read(|tx| read_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &conv_a)).unwrap();
        assert_eq!(gov.last_rubric_verdict.unwrap().summary, "cached verdict");
        harness.close();
        store.close().unwrap();
    }

    // Part B: StandIn persists sections & tool specs across restart when dynamic extension is absent.
    let db_b = dir.path().join("r9b.db");
    let conv_b = worker_conversation("r9b");
    {
        struct DynExt;
        struct DynTool;
        impl Tool for DynTool {
            fn spec(&self) -> ToolSpec {
                ToolSpec {
                    name: "dyn_probe".into(),
                    description: "dynamic tool".into(),
                    parameters: json!({"type": "object"}),
                }
            }
            fn execute(&self, _: &Value) -> ToolOutput {
                ToolOutput::ok("live")
            }
        }
        impl vibevalley_runtime::agent::Extension for DynExt {
            fn name(&self) -> &str {
                "dyn-ext"
            }
            fn tools(&self) -> Vec<Box<dyn Tool>> {
                vec![Box::new(DynTool)]
            }
            fn sections(&self) -> Vec<PromptSection> {
                vec![PromptSection::new("DynRules", "keep dynamic prefix stable")]
            }
        }

        let store = Store::open(&db_b).unwrap();
        let harness = build_harness(store.clone(), Some(Arc::new(DynExt)));
        harness
            .attach_worker(
                &conv_b,
                Arc::new(Brain::new(MockModel::new(vec![say("turn1")]), "deepseek-flash", "base")),
                Arc::new(|_| {}),
            )
            .unwrap();
        let (_, t1, _) = harness.conversation(&conv_b).prompt("deepseek-flash", "r9-1", "hi", "base").unwrap();
        harness.scheduler().wait(&t1.id, WAIT).unwrap();
        let doc = store.read(|r| read_doc::<StandInDoc>(r, CONVERSATION_SCOPE, &conv_b)).unwrap();
        assert_eq!(doc.sections.len(), 1);
        assert!(doc.tool_specs.iter().any(|t| t.name == "dyn_probe"));
        harness.close();
        store.close().unwrap();
    }
    {
        let store = Store::open(&db_b).unwrap();
        let harness2 = Harness::workers_only(store.clone());
        harness2.recover().unwrap();
        assert_eq!(harness2.reconcile_sections(&conv_b).unwrap()[0].key, "DynRules");
        let rec = store.read(|r| StandIn::reconcile(r, &conv_b, &[], &[])).unwrap();
        let stub = rec.stub_tools.iter().find(|t| t.spec().name == "dyn_probe").expect("dyn_probe stub");
        let stub_err = stub.execute(&json!({}));
        assert!(stub_err.is_error);
        assert!(stub_err.text.contains("dyn_probe"));

        let model2 = MockModel::new(vec![call_tool("d1", "dyn_probe", json!({})), say("stub handled")]);
        harness2
            .attach_worker(&conv_b, Arc::new(Brain::new(model2.clone(), "deepseek-flash", "base")), Arc::new(|_| {}))
            .unwrap();
        let (_, t2, _) = harness2.conversation(&conv_b).prompt("deepseek-flash", "r9-2", "again", "base").unwrap();
        let d2 = harness2.scheduler().wait(&t2.id, WAIT).unwrap();
        assert_eq!(d2.terminal_reason, "completed");
        assert_eq!(d2.result["output"], "stub handled");
        let seen = model2.seen.lock().unwrap();
        assert!(seen[0].tools.iter().any(|t| t.name == "dyn_probe"));
        assert!(seen[1].messages.last().unwrap().content.as_deref().unwrap().contains("dyn_probe"));
        harness2.close();
        store.close().unwrap();
    }
}
