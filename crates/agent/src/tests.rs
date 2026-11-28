use parking_lot::Mutex;
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::ai::models::{charge_usd, deepseek_price};
use crate::ai::providers::deepseek::request_body;
use crate::ai::stream::{CancelToken, fold_stream};
use crate::ai::types::ResponseFormat;
use crate::core::doc::{CONVERSATION_SCOPE, GovernanceDoc, OarSessionDoc, OarSessionState, TodoDoc, read_doc, write_doc};
use crate::core::engine::{KIND as GENERATION_KIND, Request, TOOL_RUN};
use crate::core::inbox::WhenBusy;
use crate::core::pipeline::PromptSection;
use crate::durable::{Store, Submission, SubmissionStatus, Task, TaskStatus};
use crate::extensions::governance::{self, Decision, GovernanceExtension, Permissions};
use crate::extensions::grader::{ExplicitReviewProvider, GraderExtension, Rubric};
use crate::extensions::memory::MemoryExtension;
use crate::extensions::subagent::SubagentExtension;
use crate::extensions::todo::{TodoExtension, todo_tools};
use crate::harness::{Harness, StandIn, worker_conversation};
use crate::tools::{Bash, EditFile, TypedToolAdapter};
use crate::*;

/// Answers with the completions it was given, in order, and records the
/// requests it saw.
struct Scripted {
    answers: Mutex<VecDeque<Result<Completion>>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl Scripted {
    fn new(answers: Vec<Completion>) -> Arc<Scripted> {
        Arc::new(Scripted {
            answers: Mutex::new(answers.into_iter().map(Ok).collect()),
            seen: Mutex::new(vec![]),
        })
    }
}

impl ModelClient for Scripted {
    fn complete<'a>(&'a self, request: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> vibevalley_oar::BoxFuture<'a, Result<Completion>> {
        Box::pin(async move {
            self.seen.lock().push(request.clone());
            let answer = self.answers.lock().pop_front().expect("an answer left")?;
            if let Some(t) = &answer.message.content {
                on(Delta::Text(t.clone()));
            }
            Ok(answer)
        })
    }
}

fn say(text: &str) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: Some(text.into()),
            reasoning: None,
            tool_calls: vec![],
            tool_call_id: None,
        },
        finish: FinishReason::Stop,
        usage: Usage {
            input: 100,
            output: 10,
            cache_read: 0,
        },
    }
}

fn call(id: &str, name: &str, args: Value) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: None,
            reasoning: Some("I should use a tool".into()),
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
            output: 5,
            cache_read: 50,
        },
    }
}

/// Counts its runs; replay-safe or not as told.
struct Counter {
    runs: Arc<Mutex<u32>>,
    safe: bool,
}

impl Tool for Counter {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "count".into(),
            description: "counts".into(),
            parameters: json!({"type": "object"}),
        }
    }
    fn replay_safe(&self) -> bool {
        self.safe
    }
    fn execute<'a>(&'a self, _: &'a Value) -> vibevalley_oar::BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            *self.runs.lock() += 1;
            ToolOutput::ok("counted")
        })
    }
}

fn brain(client: Arc<Scripted>, tools: Vec<Box<dyn Tool>>) -> Arc<Brain> {
    let mut b = Brain::new(client, "deepseek-flash", "You are a test.");
    b.tools = tools;
    Arc::new(b)
}

async fn worker_harness(store: Store) -> Harness {
    let harness = Harness::workers_only(store);
    harness.register_extension(Arc::new(GovernanceExtension::default()));
    harness.register_extension(Arc::new(TodoExtension::default().without_global_tools()));
    harness.register_extension(Arc::new(SubagentExtension::new("VibeValley").without_global_tools()));
    harness.recover().await.unwrap();
    harness
}

async fn submit_prompt(
    harness: &Harness,
    conv: &str,
    provider: &str,
    request_id: &str,
    prompt: &str,
    system: &str,
) -> crate::durable::Result<(Submission, Task, bool)> {
    harness
        .submit(Request {
            conversation: conv,
            provider,
            request_id,
            prompt,
            source: "user",
            system,
            ..Default::default()
        })
        .await
}

async fn run_worker_turn(harness: &Harness, conv: &str, b: Arc<Brain>, prompt: &str) -> (Vec<AgentEvent>, Task) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev_sink = events.clone();
    harness.attach_worker(conv, b, Arc::new(move |e| ev_sink.lock().push(e))).await.unwrap();
    let (_, task, _) = submit_prompt(harness, conv, "deepseek-flash", "req-1", prompt, "You are a test.")
        .await
        .unwrap();
    let done = harness.scheduler().wait(&task.id, Duration::from_secs(10)).await.unwrap();
    let captured = events.lock().clone();
    harness.workers().detach(conv);
    (captured, done)
}

#[tokio::test]
async fn a_turn_with_a_tool_call_runs_the_tool_and_answers() {
    let store = Store::memory().unwrap();
    let harness = worker_harness(store).await;
    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![call("c1", "count", json!({})), say("done")]);
    let conv = worker_conversation("t1");
    let (events, task) = run_worker_turn(
        &harness,
        &conv,
        brain(
            client.clone(),
            vec![Box::new(Counter {
                runs: runs.clone(),
                safe: false,
            })],
        ),
        "please count",
    )
    .await;
    assert_eq!(task.terminal_reason, "completed");
    assert_eq!(*runs.lock(), 1);
    {
        let seen = client.seen.lock();
        let second: Vec<Value> = seen[1].messages.iter().map(Message::to_wire).collect();
        assert_eq!(second[0]["role"], "system");
        assert_eq!(second[1]["content"], "please count");
        assert_eq!(second[2]["content"], Value::Null);
        assert_eq!(second[2]["reasoning_content"], "I should use a tool");
        assert_eq!(second[2]["tool_calls"][0]["function"]["name"], "count");
        assert_eq!(second[3]["role"], "tool");
        assert_eq!(second[3]["tool_call_id"], "c1");
    }
    match events.last().unwrap() {
        AgentEvent::AgentEnd { outcome, usage, text } => {
            assert_eq!(*outcome, TurnOutcome::Completed);
            assert_eq!(text, "done");
            assert_eq!(usage.input, 200);
            assert_eq!(usage.cache_read, 50);
        }
        e => panic!("{e:?}"),
    }
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolStart { name, .. } if name == "count")));
    harness.close().await;
}

#[tokio::test]
async fn the_transcript_survives_a_reopen_and_feeds_the_next_turn() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("execution.db");
    let conv = worker_conversation("reopen");
    let client = Scripted::new(vec![say("first answer"), say("second answer")]);
    {
        let h1 = worker_harness(Store::open(&db).await.unwrap()).await;
        h1.attach_worker(&conv, brain(client.clone(), vec![]), Arc::new(|_| {})).await.unwrap();
        let (_, t1, _) = submit_prompt(&h1, &conv, "deepseek-flash", "r1", "one", "You are a test.").await.unwrap();
        h1.scheduler().wait(&t1.id, Duration::from_secs(10)).await.unwrap();
        h1.close().await;
    }
    {
        let h2 = worker_harness(Store::open(&db).await.unwrap()).await;
        h2.attach_worker(&conv, brain(client.clone(), vec![]), Arc::new(|_| {})).await.unwrap();
        let (_, t2, _) = submit_prompt(&h2, &conv, "deepseek-flash", "r2", "two", "You are a test.").await.unwrap();
        h2.scheduler().wait(&t2.id, Duration::from_secs(10)).await.unwrap();
        h2.close().await;
    }
    let seen = client.seen.lock();
    let texts: Vec<Option<String>> = seen[1].messages.iter().map(|m| m.content.clone()).collect();
    assert_eq!(
        texts,
        vec![
            Some("You are a test.".into()),
            Some("one".into()),
            Some("first answer".into()),
            Some("two".into())
        ]
    );
}

async fn seed_crashed_mid_tool(db: &std::path::Path, conv: &str) -> String {
    let store = Store::open(db).await.unwrap();
    let conv = conv.to_owned();
    let gen_id = store
        .write_async(move |tx| {
            Box::pin(async move {
                tx.create_conversation_async(&conv, "deepseek-flash").await?;
                tx.append_entry_async(&conv, "pi.system", &json!({ "text": "You are a test.", "delta": false }))
                    .await?;
                tx.append_entry_async(&conv, "pi.user", &json!({ "text": "count it", "source": "user" }))
                    .await?;
                let call_msg = call("c1", "count", json!({})).message;
                let (sub, _) = tx.submit_async(&conv, "r1", "prompt", &json!({ "text": "count it" }), None).await?;
                let sub = tx.set_submission_status_async(&sub.id, SubmissionStatus::Placed).await?;

                let mut gen_task = Task::new(GENERATION_KIND, crate::core::engine::PHASE_TOOL_JOIN);
                gen_task.id = format!("gen-{}", sub.id);
                gen_task.conversation_id = conv.clone();

                let mut child = Task::new(crate::core::engine::TOOL_KIND, TOOL_RUN);
                child.owner_task_id = gen_task.id.clone();
                child.conversation_id = conv.clone();
                child.dedup_key = format!("{}:s1:cc1", gen_task.id);
                child.memo = json!({ "started": true });
                child.checkpoint = json!({
                    "parentTaskId": gen_task.id,
                    "step": 1,
                    "call": { "id": "c1", "name": "count", "arguments": "{}" },
                    "args": {},
                    "prompt": "count it",
                    "submissionId": sub.id,
                    "requestId": "r1",
                    "iteration": 0,
                });
                let (child, _) = tx.create_task_async(child).await?;

                gen_task.status = TaskStatus::Waiting;
                gen_task.wait_mode = Some(crate::durable::WaitMode::AllSettled);
                gen_task.wait_task_ids = vec![child.id.clone()];
                gen_task.checkpoint = json!({
                    "prompt": "count it",
                    "submission": sub.id,
                    "requestId": "r1",
                    "step": 1,
                    "calls": [{ "id": "c1", "name": "count", "arguments": "{}" }],
                    "index": 0,
                    "batchCalls": [child.id],
                });
                tx.create_task_async(gen_task.clone()).await?;
                tx.append_entry_async(
                    &conv,
                    "pi.assistant",
                    &json!({
                        "text": call_msg.content,
                        "reasoning": call_msg.reasoning,
                        "toolCalls": [{ "id": "c1", "toolName": "count", "argsJson": {}, "rawArguments": "{}" }],
                        "generationTask": gen_task.id,
                    }),
                )
                .await?;
                Ok(gen_task.id)
            })
        })
        .await
        .unwrap();
    store.close().await.unwrap();
    gen_id
}

#[tokio::test]
async fn an_unfinished_turn_resumes_and_does_not_rerun_a_tool_that_changes_things() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("execution.db");
    let conv = worker_conversation("crash-unsafe");
    let gen_id = seed_crashed_mid_tool(&db, &conv).await;

    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![say("I checked; carrying on")]);
    let harness = worker_harness(Store::open(&db).await.unwrap()).await;
    harness
        .attach_worker(
            &conv,
            brain(
                client.clone(),
                vec![Box::new(Counter {
                    runs: runs.clone(),
                    safe: false,
                })],
            ),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let done = harness.scheduler().wait(&gen_id, Duration::from_secs(10)).await.unwrap();
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(*runs.lock(), 0, "unsafe tool must not be replayed");
    {
        let seen = client.seen.lock();
        let last = seen[0].messages.last().unwrap();
        assert_eq!(last.role, Role::Tool);
        assert!(last.content.as_ref().unwrap().contains("interrupted"));
    }
    harness.close().await;
}

#[tokio::test]
async fn a_read_only_tool_cut_off_mid_run_is_run_again() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("execution.db");
    let conv = worker_conversation("crash-safe");
    let gen_id = seed_crashed_mid_tool(&db, &conv).await;

    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![say("ok")]);
    let harness = worker_harness(Store::open(&db).await.unwrap()).await;
    harness
        .attach_worker(
            &conv,
            brain(
                client,
                vec![Box::new(Counter {
                    runs: runs.clone(),
                    safe: true,
                })],
            ),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let done = harness.scheduler().wait(&gen_id, Duration::from_secs(10)).await.unwrap();
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(*runs.lock(), 1);
    harness.close().await;
}

#[tokio::test]
async fn abort_stops_before_the_next_step() {
    let store = Store::memory().unwrap();
    let harness = worker_harness(store).await;
    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![call("c1", "count", json!({})), say("never")]);
    let conv = worker_conversation("abort");
    let harness_abort = harness.clone();
    let conv_abort = conv.clone();
    harness
        .attach_worker(
            &conv,
            brain(
                client.clone(),
                vec![Box::new(Counter {
                    runs: runs.clone(),
                    safe: false,
                })],
            ),
            Arc::new(move |e| {
                if matches!(e, AgentEvent::ToolEnd { .. }) {
                    let h = harness_abort.clone();
                    let c = conv_abort.clone();
                    tokio::spawn(async move {
                        let _ = h.abort_conversation(&c).await;
                    });
                }
            }),
        )
        .await
        .unwrap();
    let (_, task, _) = submit_prompt(&harness, &conv, "deepseek-flash", "r1", "go", "You are a test.").await.unwrap();
    let done = harness.scheduler().wait(&task.id, Duration::from_secs(10)).await.unwrap();
    assert_eq!(done.terminal_reason, "aborted");
    assert_eq!(client.seen.lock().len(), 1);
    harness.close().await;
}

#[tokio::test]
async fn governance_extension_allows_readonly_tools_and_parks_on_unsafe_tool() {
    let store = Store::memory().unwrap();
    let conv = worker_conversation("gov");
    let conv_seed = conv.clone();
    store
        .write_async(move |tx| {
            Box::pin(async move {
                tx.create_conversation_async(&conv_seed, "deepseek-flash").await?;
                write_doc::<OarSessionDoc>(
                    tx,
                    CONVERSATION_SCOPE,
                    &conv_seed,
                    &OarSessionState {
                        runtime_id: "vibevalley".into(),
                        vendor_session_id: "gov".into(),
                        cwd: ".".into(),
                        permission_mode: "ask".into(),
                        status: "open".into(),
                    },
                )
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();

    struct ReadMock;
    impl Tool for ReadMock {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "read".into(),
                description: "mock read".into(),
                parameters: json!({"type": "object"}),
            }
        }
        fn replay_safe(&self) -> bool {
            true
        }
        fn execute<'a>(&'a self, _: &'a Value) -> vibevalley_oar::BoxFuture<'a, ToolOutput> {
            Box::pin(std::future::ready(ToolOutput::ok("contents")))
        }
    }

    let (perm_tx, mut perm_rx) = tokio::sync::mpsc::unbounded_channel();
    let harness = Harness::workers_only(store.clone());
    harness.register_extension(Arc::new(GovernanceExtension::new(Permissions::default())));
    harness.recover().await.unwrap();

    let runs = Arc::new(Mutex::new(0));
    let client = Scripted::new(vec![call("r1", "read", json!({"path": "a.txt"})), call("c1", "count", json!({})), say("done")]);
    harness
        .attach_worker(
            &conv,
            brain(
                client,
                vec![
                    Box::new(ReadMock),
                    Box::new(Counter {
                        runs: runs.clone(),
                        safe: false,
                    }),
                ],
            ),
            Arc::new(move |e| {
                if let AgentEvent::PermissionRequested {
                    task_id,
                    tool_call_id,
                    tool_name,
                    ..
                } = e
                {
                    let _ = perm_tx.send((task_id, tool_call_id, tool_name));
                }
            }),
        )
        .await
        .unwrap();

    let (_, task, _) = submit_prompt(&harness, &conv, "deepseek-flash", "req", "read then count", "sys").await.unwrap();

    // `read` is allowlisted in DefaultClassifier so it runs without parking; `count` parks.
    let (parked_task, call_id, tool_name) = tokio::time::timeout(Duration::from_secs(10), perm_rx.recv()).await.unwrap().unwrap();
    assert_eq!(call_id, "c1");
    assert_eq!(tool_name, "count");
    assert_eq!(*runs.lock(), 0);

    let conv_read = conv.clone();
    let gov = store
        .read_async(move |tx| Box::pin(async move { read_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &conv_read).await }))
        .await
        .unwrap();
    assert!(gov.pending_permissions.contains_key(&parked_task));

    governance::resolve(
        &store,
        harness.scheduler(),
        &conv,
        &parked_task,
        Decision {
            tool_call_id: "c1".into(),
            approved: true,
            reason: String::new(),
        },
    )
    .await
    .unwrap();

    let done = harness.scheduler().wait(&task.id, Duration::from_secs(10)).await.unwrap();
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(*runs.lock(), 1);
    harness.close().await;
}

#[tokio::test]
async fn grader_extension_uses_json_object_and_strips_fenced_verdict() {
    struct FixedBrain(Arc<Brain>);
    impl crate::core::engine::BrainProvider for FixedBrain {
        fn resolve_brain<'a>(&'a self, _: &'a str, _: &'a str) -> vibevalley_oar::BoxFuture<'a, crate::durable::Result<Option<Arc<Brain>>>> {
            Box::pin(std::future::ready(Ok(Some(self.0.clone()))))
        }
    }

    let store = Store::memory().unwrap();
    let client = Scripted::new(vec![
        say("draft 1"),
        say("```json\n{\"satisfied\":false,\"summary\":\"missing tests\",\"unmetItems\":[\"add test\"]}\n```"),
        say("draft 2"),
        say("{\"satisfied\":true,\"summary\":\"all good\",\"unmetItems\":[]}"),
    ]);
    let conv = "assistant-graded";
    let b = brain(client.clone(), vec![]);
    let harness = Harness::from_store(store.clone(), Arc::new(FixedBrain(b)));
    harness.register_extension(Arc::new(GraderExtension::new(Arc::new(ExplicitReviewProvider))));
    harness.recover().await.unwrap();

    let (_, task, _) = harness
        .submit(Request {
            conversation: conv,
            provider: "deepseek-flash",
            request_id: "req-grade",
            prompt: "ship feature",
            source: "user",
            system: "sys",
            rubric: Some(Rubric {
                markdown: "- must pass tests".into(),
                max_iterations: 3,
            }),
            ..Default::default()
        })
        .await
        .unwrap();

    let done = harness.scheduler().wait(&task.id, Duration::from_secs(10)).await.unwrap();
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(done.result["rubricVerdict"]["satisfied"], true);
    assert_eq!(done.result["rubricVerdict"]["iteration"], 2);

    {
        let seen = client.seen.lock();
        // Request 1 and Request 3 are grader calls.
        assert_eq!(seen[1].response_format, Some(ResponseFormat::JsonObject));
        assert_eq!(seen[3].response_format, Some(ResponseFormat::JsonObject));
    }

    let gov = store
        .read_async(move |tx| Box::pin(async move { read_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, conv).await }))
        .await
        .unwrap();
    assert_eq!(gov.rubric_history.len(), 2);
    assert!(gov.last_rubric_verdict.unwrap().satisfied);
    harness.close().await;
}

#[tokio::test]
async fn subagent_extension_spawns_once_and_does_not_duplicate_on_replay() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("execution.db");
    let store = Store::open(&db).await.unwrap();
    let harness = Harness::workers_only(store.clone());
    harness.register_extension(Arc::new(SubagentExtension::new("阿狐").without_global_tools()));
    harness.recover().await.unwrap();

    let client = Scripted::new(vec![
        call("s1", "spawn_agent", json!({"brief": "find the clock code", "label": "scout"})),
        say("Found it in main.rs:12."),
        say("Parent done."),
    ]);
    let conv = worker_conversation("parent");
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev_sink = events.clone();
    harness
        .attach_worker(&conv, brain(client.clone(), vec![]), Arc::new(move |e| ev_sink.lock().push(e)))
        .await
        .unwrap();
    let (_, task, _) = submit_prompt(&harness, &conv, "deepseek-flash", "r1", "find clock", "You are parent.")
        .await
        .unwrap();
    let done = harness.scheduler().wait(&task.id, Duration::from_secs(10)).await.unwrap();
    assert_eq!(done.terminal_reason, "completed");

    let captured = events.lock().clone();
    assert!(
        captured
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentSpawned { label, brief, .. } if label == "scout" && brief == "find the clock code"))
    );
    assert!(
        captured
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentStatusChanged { status, .. } if status == "running"))
    );
    assert!(
        captured
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentStatusChanged { status, .. } if status == "completed"))
    );

    {
        let seen = client.seen.lock();
        assert_eq!(seen.len(), 3);
        // Child helper received the helper system prompt with "阿狐".
        assert!(seen[1].messages[0].content.as_ref().unwrap().contains("「阿狐」派出去的帮手"));
    }
    harness.close().await;
}

#[tokio::test]
async fn todo_extension_persists_graph_to_todo_doc_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("execution.db");
    let conv = worker_conversation("todo-persist");
    let client = Scripted::new(vec![
        call("t1", "todo_add", json!({"tasks": [{"id": "step1", "brief": "read code"}]})),
        say("added"),
        call("t2", "todo_list", json!({})),
        say("listed"),
    ]);
    {
        let h1 = worker_harness(Store::open(&db).await.unwrap()).await;
        h1.attach_worker(&conv, brain(client.clone(), todo_tools(Default::default())), Arc::new(|_| {}))
            .await
            .unwrap();
        let (_, t1, _) = submit_prompt(&h1, &conv, "deepseek-flash", "r1", "add step", "sys").await.unwrap();
        h1.scheduler().wait(&t1.id, Duration::from_secs(10)).await.unwrap();
        let conv_read = conv.clone();
        let doc = h1
            .store()
            .read_async(move |tx| Box::pin(async move { read_doc::<TodoDoc>(tx, CONVERSATION_SCOPE, &conv_read).await }))
            .await
            .unwrap();
        assert_eq!(doc.items.len(), 1);
        assert_eq!(doc.items[0].id, "step1");
        h1.close().await;
    }
    {
        let h2 = worker_harness(Store::open(&db).await.unwrap()).await;
        h2.attach_worker(&conv, brain(client.clone(), todo_tools(Default::default())), Arc::new(|_| {}))
            .await
            .unwrap();
        let (_, t2, _) = submit_prompt(&h2, &conv, "deepseek-flash", "r2", "list", "sys").await.unwrap();
        h2.scheduler().wait(&t2.id, Duration::from_secs(10)).await.unwrap();
        h2.close().await;
    }
    let seen = client.seen.lock();
    let listed_msg = seen[3].messages.last().unwrap().content.as_ref().unwrap();
    assert!(listed_msg.contains("step1"), "{listed_msg}");
}

#[tokio::test]
async fn standin_and_durable_follow_up_work_through_harness() {
    let store = Store::memory().unwrap();
    let harness = worker_harness(store.clone()).await;
    let conv = worker_conversation("standin-fu");
    let client = Scripted::new(vec![say("first"), say("followed up")]);
    harness.attach_worker(&conv, brain(client.clone(), vec![]), Arc::new(|_| {})).await.unwrap();
    let (_, task, _) = harness
        .submit(Request {
            conversation: &conv,
            provider: "deepseek-flash",
            request_id: "r1",
            prompt: "start",
            source: "user",
            system: "sys",
            when_busy: WhenBusy::Queue,
            ..Default::default()
        })
        .await
        .unwrap();
    let conv_fu = conv.clone();
    store
        .write_async(move |tx| Box::pin(async move { crate::core::inbox::submit_follow_up(tx, &conv_fu, "fu-1", "next thing", None).await }))
        .await
        .unwrap();
    let done = harness.scheduler().wait(&task.id, Duration::from_secs(10)).await.unwrap();
    assert_eq!(done.terminal_reason, "completed");

    let sections = vec![PromptSection::new("extra", "remember this")];
    let conv_save = conv.clone();
    let sections_save = sections.clone();
    store
        .write_async(move |tx| Box::pin(async move { StandIn::save(tx, &conv_save, &sections_save, &[]).await }))
        .await
        .unwrap();
    assert_eq!(harness.reconcile_sections(&conv).await.unwrap(), sections);
    harness.close().await;
}

#[test]
fn a_deepseek_stream_folds_into_text_reasoning_tool_calls_and_usage() {
    let stream = [
        r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Let me "}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"look."}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"content":"Checking "}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{\"pa"}}]}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"arguments":"th\":\"a.txt\"}"}}]}}]}"#,
        r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls","usage":{"prompt_tokens":1200,"completion_tokens":40,"prompt_cache_hit_tokens":1000}}]}"#,
        "data: [DONE]",
    ]
    .join("\n\n");
    let mut deltas = vec![];
    let c = fold_stream(Cursor::new(stream), &CancelToken::never(), &mut |d| deltas.push(d)).unwrap();
    assert_eq!(c.finish, FinishReason::ToolCalls);
    assert_eq!(c.message.reasoning.as_deref(), Some("Let me look."));
    assert_eq!(c.message.content.as_deref(), Some("Checking "));
    assert_eq!(
        c.message.tool_calls,
        vec![ToolCall {
            id: "call_late".into(),
            name: "read".into(),
            arguments: "{\"path\":\"a.txt\"}".into()
        }]
    );
    assert_eq!(
        c.usage,
        Usage {
            input: 1200,
            output: 40,
            cache_read: 1000
        }
    );
    assert_eq!(deltas.len(), 3);
    let err = fold_stream(
        Cursor::new(r#"data: {"error":{"message":"Insufficient Balance"}}"#),
        &CancelToken::never(),
        &mut |_| {},
    );
    assert!(matches!(err, Err(BrainError::Model(m)) if m == "Insufficient Balance"));
}

#[test]
fn the_request_body_turns_thinking_on_only_with_an_effort() {
    let mut r = ChatRequest {
        model: "deepseek-flash".into(),
        messages: vec![Message::user("hi")],
        ..Default::default()
    };
    assert_eq!(request_body(&r)["thinking"]["type"], "disabled");
    assert!(request_body(&r).get("tools").is_none());
    r.effort = Some("high".into());
    let body = request_body(&r);
    assert_eq!(
        (body["thinking"]["type"].as_str(), body["reasoning_effort"].as_str()),
        (Some("enabled"), Some("high"))
    );
    assert_eq!(body["stream"], true);
}

#[test]
fn prices_follow_vibevalleys_table() {
    let p = deepseek_price("deepseek-flash").unwrap();
    let usd = charge_usd(
        p,
        Usage {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 500_000,
        },
    );
    assert!((usd - (0.5 * 0.14 + 0.28 + 0.5 * 0.028)).abs() < 1e-9);
    assert_eq!(deepseek_price("deepseek-official/deepseek-v4-pro"), deepseek_price("deepseek-v4-pro"));
    assert!(deepseek_price("gpt-x").is_none());
}

#[tokio::test]
async fn edit_needs_exactly_one_match_and_bash_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace {
        bash_timeout: Duration::from_millis(300),
        ..Workspace::new(dir.path())
    };
    std::fs::write(dir.path().join("f.txt"), "a b a").unwrap();
    let edit = TypedToolAdapter(EditFile(ws.clone()));
    assert!(edit.execute(&json!({"path": "f.txt", "old_text": "a", "new_text": "x"})).await.is_error);
    assert!(!edit.execute(&json!({"path": "f.txt", "old_text": "b", "new_text": "y"})).await.is_error);
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "a y a");
    let bash = TypedToolAdapter(Bash(ws));
    let ok = bash.execute(&json!({"command": "echo hi; echo err >&2"})).await;
    assert_eq!((ok.is_error, ok.text.as_str()), (false, "hi\nerr\n"));
    let slow = bash.execute(&json!({"command": "sleep 5"})).await;
    assert!(slow.is_error && slow.text.contains("timed out"), "{slow:?}");
    assert!(bash.execute(&json!({"command": "exit 3"})).await.text.contains("exit status 3"));
}

#[tokio::test]
#[ignore = "calls DeepSeek; needs DEEPSEEK_API_KEY"]
async fn deepseek_live_tool_turn() {
    let Ok(key) = std::env::var("DEEPSEEK_API_KEY") else { return };
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("secret.txt"), "the answer is 42\n").unwrap();
    let client = Arc::new(OpenAiClient::deepseek(move || Some(key.clone())));
    let mut b = Brain::new(client, "deepseek-flash", "You are a careful assistant. Use tools to look at files.");
    b.tools = coding_tools(&Workspace::new(dir.path()));
    let store = Store::memory().unwrap();
    let harness = worker_harness(store).await;
    let conv = worker_conversation("live");
    let (events, _) = run_worker_turn(&harness, &conv, Arc::new(b), "What number is in secret.txt? Reply with the number only.").await;
    let Some(AgentEvent::AgentEnd { text, usage, .. }) = events.last() else {
        panic!("missing AgentEnd: {events:?}");
    };
    println!("usage {usage:?}");
    assert!(text.contains("42"), "{text}");
    harness.close().await;
}

mod kit_tests {
    use parking_lot::Mutex;
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::extensions::memory::{MemoryPort, Remember, RewriteMemory};
    use crate::resources::skills::{front_matter, read_skill, scan_skills, skill_body, skill_index};

    #[derive(Default)]
    struct InMemoryPort(Mutex<String>);

    impl MemoryPort for InMemoryPort {
        fn prompt(&self) -> String {
            self.0.lock().trim().to_owned()
        }

        fn remember<'a>(&'a self, note: &'a str) -> vibevalley_oar::BoxFuture<'a, std::result::Result<(), String>> {
            Box::pin(async move {
                let line = format!("- {}", note.split_whitespace().collect::<Vec<_>>().join(" "));
                let mut body = self.0.lock();
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(&line);
                Ok(())
            })
        }

        fn rewrite<'a>(&'a self, content: &'a str) -> vibevalley_oar::BoxFuture<'a, std::result::Result<usize, String>> {
            Box::pin(async move {
                let trimmed = content.trim();
                *self.0.lock() = trimmed.to_owned();
                Ok(trimmed.lines().filter(|l| !l.trim().is_empty()).count())
            })
        }
    }

    #[test]
    fn front_matter_and_skills_scan_first_name_wins() {
        let fm = front_matter("---\nname: deploy\ndescription: >\n  Ships the app\n  to prod\nquoted: \"x y\"\n---\nbody");
        assert_eq!(fm["name"], "deploy");
        assert_eq!(fm["description"], "Ships the app to prod");
        assert_eq!(fm["quoted"], "x y");
        assert_eq!(skill_body("---\nname: a\n---\n\nThe body.\n"), "The body.");

        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for (dir, folder, text) in [
            (a.path(), "deploy", "---\nname: deploy\ndescription: from a\n---\nA"),
            (b.path(), "deploy2", "---\nname: deploy\ndescription: from b\n---\nB"),
            (b.path(), "Lint", "---\ndescription: checks\n---\nL"),
        ] {
            std::fs::create_dir_all(dir.join(folder)).unwrap();
            std::fs::write(dir.join(folder).join("SKILL.md"), text).unwrap();
        }
        let skills = scan_skills(&[a.path().into(), b.path().into(), "/no/such".into()]);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["deploy", "Lint"]);
        assert_eq!(skills[0].description, "from a");
        assert_eq!(skill_index(&skills, 160), "- deploy：from a\n- Lint：checks");
        assert!(read_skill(&skills, "deploy").unwrap().ends_with("\n\nA"));
        assert!(read_skill(&skills, "nope").unwrap_err().contains("有：deploy、Lint"));
    }

    #[tokio::test]
    async fn memory_remembers_lines_and_rewrites_and_builds_extension_section() {
        let mem: Arc<dyn MemoryPort> = Arc::new(InMemoryPort::default());
        assert_eq!(mem.prompt(), "");
        let remember = TypedToolAdapter(Remember(mem.clone()));
        assert!(remember.execute(&json!({"note": "  "})).await.is_error);
        assert_eq!(remember.execute(&json!({"note": "用户喜欢\n简短回答"})).await.text, "记下了。");
        let prompt = mem.prompt();
        assert_eq!(prompt, "- 用户喜欢 简短回答");
        let ext = MemoryExtension::new(mem.clone());
        let sections = ext.sections();
        assert_eq!(sections.len(), 1);
        assert!(sections[0].content.starts_with("## 记性\n"));
        assert_eq!(
            TypedToolAdapter(RewriteMemory(mem.clone())).execute(&json!({"content": "- a\n- b"})).await.text,
            "重写好了，现在 2 行。"
        );
        assert_eq!(mem.prompt(), "- a\n- b");
    }

    #[tokio::test]
    async fn todo_graph_adds_all_or_none_and_settles() {
        let g = Arc::new(Mutex::new(vec![]));
        let tools = todo_tools(g.clone());
        let add = &tools[0];
        let bad = add
            .execute(&json!({"tasks": [
                {"id": "a", "brief": "x", "after": ["b"]}, {"id": "b", "brief": "y", "after": ["a"]}
            ]}))
            .await;
        assert!(bad.is_error && bad.text.contains("成了一个圈"), "{}", bad.text);
        assert!(g.lock().is_empty());
        let ok = add
            .execute(&json!({"tasks": [
                {"id": "read", "brief": "read the code"}, {"id": "fix", "brief": "fix it", "after": ["read"]}
            ]}))
            .await;
        assert!(ok.text.starts_with("任务（2 件，1 件可以做）"), "{}", ok.text);
        assert!(ok.text.contains("[等着] fix fix it（等 read）"));
        let update = &tools[1];
        update.execute(&json!({"id": "read", "state": "done", "result": "it is in main.rs"})).await;
        let back = update.execute(&json!({"id": "read", "state": "failed"})).await;
        assert!(back.is_error && back.text.contains("做完了，不能改成没做成"), "{}", back.text);
        let done = update.execute(&json!({"id": "fix", "state": "done"})).await;
        assert!(done.text.ends_with("都做完了，这张图收起来了。"));
        assert!(g.lock().is_empty());
        assert_eq!(tools[2].execute(&json!({})).await.text, "现在没有任务。");
        assert!(add.execute(&json!({"tasks": [{"id": "坏", "brief": "x"}]})).await.text.contains("不能当 id"));
    }

    #[test]
    fn builtin_runtime_specs_match_default_registry_and_exclude_dsh() {
        assert!(vibevalley_oar::runtime_spec("dsh").is_none());
        let registry = crate::runtime::default_registry();
        for spec in vibevalley_oar::BUILTIN_RUNTIME_SPECS {
            let rt = registry.get(spec.id).unwrap_or_else(|| panic!("missing runtime {}", spec.id));
            assert_eq!(rt.id(), spec.id);
            assert_eq!(rt.display_name(), spec.display_name);
            assert_eq!(rt.capabilities(), spec.capabilities, "capabilities drift for {}", spec.id);
            assert_eq!(
                vibevalley_oar::runtime_refused_options(spec.id),
                spec.refused_options,
                "refused_options drift for {}",
                spec.id
            );
        }
        for rt in registry.list() {
            if rt.id() == "scripted" {
                continue;
            }
            assert!(
                vibevalley_oar::runtime_spec(rt.id()).is_some(),
                "runtime {} missing from BUILTIN_RUNTIME_SPECS",
                rt.id()
            );
        }
    }
}
