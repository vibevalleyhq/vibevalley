use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::Result as AiResult;
use crate::ai::ModelClient;
use crate::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, ToolSpec, Usage};
use crate::core::engine::Request;
use crate::core::events::{AgentEvent, Brain};
use crate::core::extension::Extension;
use crate::core::inbox::WhenBusy;
use crate::core::pipeline::PromptSection;
use crate::core::tool::{Tool, ToolOutput};
use crate::durable::Store;
use crate::harness::{Harness, StandIn, WorkersOnly, worker_conversation};

struct MockClient {
    replies: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl MockClient {
    fn with(replies: Vec<Completion>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::new(Vec::new()),
        }
    }
}

impl ModelClient for MockClient {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
        self.seen.lock().unwrap().push(request.clone());
        let next = self.replies.lock().unwrap().pop_front().expect("unexpected model call");
        if let Some(text) = &next.message.content {
            on(Delta::Text(text.clone()));
        }
        Ok(next)
    }
}

struct ExtPingTool;

impl Tool for ExtPingTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "ext_ping".into(),
            description: "extension ping".into(),
            parameters: json!({"type": "object"}),
        }
    }

    fn execute(&self, _args: &Value) -> ToolOutput {
        ToolOutput::ok("pong")
    }
}

struct SampleExtension;

impl Extension for SampleExtension {
    fn name(&self) -> &str {
        "sample-ext"
    }

    fn tools(&self) -> Vec<Box<dyn Tool>> {
        vec![Box::new(ExtPingTool)]
    }

    fn sections(&self) -> Vec<PromptSection> {
        vec![PromptSection::new("ExtSection", "remember extension convention")]
    }
}

#[test]
fn harness_worker_prompt_fork_and_standin_recovery() -> crate::durable::Result<()> {
    let store = Store::memory()?;
    let harness = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
    harness.register_extension(Arc::new(SampleExtension));
    harness.recover()?;

    let client = Arc::new(MockClient::with(vec![Completion {
        message: Message::assistant("hello worker"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    }]));
    let brain = Arc::new(Brain::new(client.clone(), "deepseek-chat", "base system"));
    let conv = worker_conversation("s1");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    harness.attach_worker(&conv, brain, Arc::new(move |ev| sink.lock().unwrap().push(ev)))?;

    let handle = harness.conversation(&conv);
    let (_, task, _) = handle.prompt("mock", "req-1", "hi", "base system")?;
    let done = harness.scheduler().wait(&task.id, Duration::from_secs(3))?;
    assert_eq!(done.terminal_reason, "completed");
    {
        let recorded = events.lock().unwrap();
        assert!(recorded.iter().any(|e| matches!(e, AgentEvent::AgentStart)));
        assert!(recorded.iter().any(|e| matches!(e, AgentEvent::TextDelta { delta } if delta == "hello worker")));
        assert!(recorded.iter().any(|e| matches!(e, AgentEvent::AgentEnd { .. })));
    }

    let entries = handle.entries()?;
    assert!(
        entries
            .iter()
            .any(|e| e.kind == "pi.system" && e.payload["text"].as_str().unwrap().contains("remember extension convention"))
    );

    let forked = handle.fork("worker:s1-fork", entries.last().unwrap().seq, "mock")?;
    assert_eq!(forked.entries()?.len(), entries.len());
    drop(forked);
    drop(handle);
    harness.close();
    drop(harness);

    // Reopen a fresh Harness on the SAME store WITHOUT SampleExtension registered:
    // StandIn recovers missing section & preserves ext_ping tool spec in ChatRequest!
    let client2 = Arc::new(MockClient::with(vec![Completion {
        message: Message::assistant("resumed without ext"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    }]));
    let harness2 = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
    harness2.recover()?;
    harness2.attach_worker(&conv, Arc::new(Brain::new(client2.clone(), "deepseek-chat", "base system")), Arc::new(|_| {}))?;
    let missing = harness2.reconcile_sections(&conv)?;
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].key, "ExtSection");

    let (_, t2, _) = harness2.submit(Request {
        conversation: &conv,
        provider: "mock",
        request_id: "req-2",
        prompt: "follow up",
        source: "user",
        system: "base system",
        when_busy: WhenBusy::Reject,
        ..Default::default()
    })?;
    let d2 = harness2.scheduler().wait(&t2.id, Duration::from_secs(3))?;
    assert_eq!(d2.result["output"], "resumed without ext");
    let seen = client2.seen.lock().unwrap();
    assert!(seen[0].tools.iter().any(|t| t.name == "ext_ping"));

    let stub_recovery = store.read(|r| StandIn::reconcile(r, &conv, &[], &[]))?;
    assert_eq!(stub_recovery.stub_tools.len(), 1);
    let stub_out = stub_recovery.stub_tools[0].execute(&json!({}));
    assert!(stub_out.is_error);
    assert!(stub_out.text.contains("ext_ping"));
    Ok(())
}

#[test]
fn harness_abort_cancels_active_generation_and_settles_unanswered() -> crate::durable::Result<()> {
    let store = Store::memory()?;
    let harness = Harness::workers_only(store.clone());
    harness.recover()?;

    struct SlowClient(flume::Sender<()>, flume::Receiver<()>);
    impl ModelClient for SlowClient {
        fn complete(&self, _req: &ChatRequest, _on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
            let _ = self.0.send(());
            let _ = self.1.recv_timeout(Duration::from_secs(5));
            Ok(Completion {
                message: Message::assistant("never"),
                finish: FinishReason::Stop,
                usage: Usage::default(),
            })
        }

        fn complete_cancellable(&self, _req: &ChatRequest, cancel: &crate::ai::CancelToken, _on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
            let _ = self.0.send(());
            if let Some(rx) = cancel.receiver() {
                let _ = flume::Selector::new()
                    .recv(rx, |_| ())
                    .recv(&self.1, |_| ())
                    .wait_timeout(Duration::from_secs(5));
            }
            if cancel.is_cancelled() {
                return Err(crate::BrainError::Cancelled);
            }
            Ok(Completion {
                message: Message::assistant("never"),
                finish: FinishReason::Stop,
                usage: Usage::default(),
            })
        }
    }

    let (started_tx, started_rx) = flume::bounded(1);
    let (_hold_tx, hold_rx) = flume::bounded(1);
    let conv = worker_conversation("abortable");
    harness.attach_worker(
        &conv,
        Arc::new(Brain::new(Arc::new(SlowClient(started_tx, hold_rx)), "deepseek-chat", "sys")),
        Arc::new(|_| {}),
    )?;

    let handle = harness.conversation(&conv);
    let (sub, task, _) = handle.prompt("mock", "req-abort", "hang", "sys")?;
    started_rx.recv_timeout(Duration::from_secs(2)).expect("model started");

    let aborted = handle.abort()?;
    assert_eq!(aborted, vec![task.id.clone()]);
    let terminal = harness.scheduler().wait(&task.id, Duration::from_secs(2))?;
    assert_eq!(terminal.terminal_reason, "aborted");
    assert_eq!(store.read(|r| r.submission(&sub.id))?.status, crate::durable::SubmissionStatus::Unanswered);
    Ok(())
}
