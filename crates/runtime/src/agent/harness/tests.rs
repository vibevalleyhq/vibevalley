use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::Mutex;
use std::time::Duration;

use serde_json::{Value, json};

use crate::agent::Result as AiResult;
use crate::agent::ai::ModelClient;
use crate::agent::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, ToolSpec, Usage};
use crate::agent::core::engine::Request;
use crate::agent::core::events::{AgentEvent, Brain};
use crate::agent::core::extension::Extension;
use crate::agent::core::inbox::WhenBusy;
use crate::agent::core::pipeline::PromptSection;
use crate::agent::core::tool::{Tool, ToolOutput};
use crate::agent::durable::Store;
use crate::agent::harness::{Harness, StandIn, WorkersOnly, worker_conversation};

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
    fn complete<'a>(&'a self, request: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> crate::BoxFuture<'a, AiResult<Completion>> {
        Box::pin(async move {
            self.seen.lock().push(request.clone());
            let next = self.replies.lock().pop_front().expect("unexpected model call");
            if let Some(text) = &next.message.content {
                on(Delta::Text(text.clone()));
            }
            Ok(next)
        })
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

    fn execute<'a>(&'a self, _args: &'a Value) -> crate::BoxFuture<'a, ToolOutput> {
        Box::pin(std::future::ready(ToolOutput::ok("pong")))
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

#[tokio::test]
async fn harness_worker_prompt_fork_and_standin_recovery() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    let harness = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
    harness.register_extension(Arc::new(SampleExtension));
    harness.recover().await?;

    let client = Arc::new(MockClient::with(vec![Completion {
        message: Message::assistant("hello worker"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    }]));
    let brain = Arc::new(Brain::new(client.clone(), "deepseek-chat", "base system"));
    let conv = worker_conversation("s1");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    harness.attach_worker(&conv, brain, Arc::new(move |ev| sink.lock().push(ev))).await?;

    let (_, task, _) = harness
        .submit(Request {
            conversation: &conv,
            provider: "mock",
            request_id: "req-1",
            prompt: "hi",
            source: "user",
            system: "base system",
            ..Default::default()
        })
        .await?;
    let done = harness.scheduler().wait(&task.id, Duration::from_secs(3)).await?;
    assert_eq!(done.terminal_reason, "completed");
    {
        let recorded = events.lock();
        assert!(recorded.iter().any(|e| matches!(e, AgentEvent::AgentStart)));
        assert!(recorded.iter().any(|e| matches!(e, AgentEvent::TextDelta { delta } if delta == "hello worker")));
        assert!(recorded.iter().any(|e| matches!(e, AgentEvent::AgentEnd { .. })));
    }

    let entries = harness.entries(&conv).await?;
    assert!(
        entries
            .iter()
            .any(|e| e.kind == "pi.system" && e.payload["text"].as_str().unwrap().contains("remember extension convention"))
    );

    let fork_seq = entries.last().unwrap().seq;
    let conv_clone = conv.clone();
    store
        .write_async(move |tx| Box::pin(async move { tx.fork_conversation_async(&conv_clone, "worker:s1-fork", "mock", "", fork_seq).await }))
        .await?;
    assert_eq!(harness.entries("worker:s1-fork").await?.len(), entries.len());
    harness.close().await;
    drop(harness);

    // Reopen a fresh Harness on the SAME store WITHOUT SampleExtension registered:
    // StandIn recovers missing section & preserves ext_ping tool spec in ChatRequest!
    let client2 = Arc::new(MockClient::with(vec![Completion {
        message: Message::assistant("resumed without ext"),
        finish: FinishReason::Stop,
        usage: Usage::default(),
    }]));
    let harness2 = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
    harness2.recover().await?;
    harness2
        .attach_worker(&conv, Arc::new(Brain::new(client2.clone(), "deepseek-chat", "base system")), Arc::new(|_| {}))
        .await?;
    let missing = harness2.reconcile_sections(&conv).await?;
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].key, "ExtSection");

    let (_, t2, _) = harness2
        .submit(Request {
            conversation: &conv,
            provider: "mock",
            request_id: "req-2",
            prompt: "follow up",
            source: "user",
            system: "base system",
            when_busy: WhenBusy::Reject,
            ..Default::default()
        })
        .await?;
    let d2 = harness2.scheduler().wait(&t2.id, Duration::from_secs(3)).await?;
    assert_eq!(d2.result["output"], "resumed without ext");
    {
        let seen = client2.seen.lock();
        assert!(seen[0].tools.iter().any(|t| t.name == "ext_ping"));
    }

    let conv_clone2 = conv.clone();
    let stub_recovery = store
        .read_async(move |r| Box::pin(async move { StandIn::reconcile(r, &conv_clone2, &[], &[]).await }))
        .await?;
    assert_eq!(stub_recovery.stub_tools.len(), 1);
    let stub_out = stub_recovery.stub_tools[0].execute(&json!({})).await;
    assert!(stub_out.is_error);
    assert!(stub_out.text.contains("ext_ping"));
    Ok(())
}

#[tokio::test]
async fn harness_abort_cancels_active_generation_and_settles_unanswered() -> crate::agent::durable::Result<()> {
    let store = Store::memory()?;
    let harness = Harness::workers_only(store.clone());
    harness.recover().await?;

    struct SlowClient(
        tokio::sync::mpsc::UnboundedSender<()>,
        tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<()>>,
    );
    impl ModelClient for SlowClient {
        fn complete<'a>(&'a self, _req: &'a ChatRequest, _on: &'a mut (dyn FnMut(Delta) + Send)) -> crate::BoxFuture<'a, AiResult<Completion>> {
            Box::pin(async move {
                let _ = self.0.send(());
                let mut rx = self.1.lock().await;
                let _ = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
                Ok(Completion {
                    message: Message::assistant("never"),
                    finish: FinishReason::Stop,
                    usage: Usage::default(),
                })
            })
        }

        fn complete_cancellable<'a>(
            &'a self,
            _req: &'a ChatRequest,
            cancel: &'a crate::agent::ai::CancelToken,
            _on: &'a mut (dyn FnMut(Delta) + Send),
        ) -> crate::BoxFuture<'a, AiResult<Completion>> {
            Box::pin(async move {
                let _ = self.0.send(());
                let mut rx = self.1.lock().await;
                tokio::select! {
                    _ = cancel.cancelled() => {}
                    _ = tokio::time::timeout(Duration::from_secs(5), rx.recv()) => {}
                }
                if cancel.is_cancelled() {
                    return Err(crate::agent::BrainError::Cancelled);
                }
                Ok(Completion {
                    message: Message::assistant("never"),
                    finish: FinishReason::Stop,
                    usage: Usage::default(),
                })
            })
        }
    }

    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_hold_tx, hold_rx) = tokio::sync::mpsc::unbounded_channel();
    let conv = worker_conversation("abortable");
    harness
        .attach_worker(
            &conv,
            Arc::new(Brain::new(
                Arc::new(SlowClient(started_tx, tokio::sync::Mutex::new(hold_rx))),
                "deepseek-chat",
                "sys",
            )),
            Arc::new(|_| {}),
        )
        .await?;

    let (sub, task, _) = harness
        .submit(Request {
            conversation: &conv,
            provider: "mock",
            request_id: "req-abort",
            prompt: "hang",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .await?;
    tokio::time::timeout(Duration::from_secs(2), started_rx.recv())
        .await
        .expect("model started")
        .expect("sender alive");

    let aborted = harness.abort_conversation(&conv).await?;
    assert_eq!(aborted, vec![task.id.clone()]);
    let terminal = harness.scheduler().wait(&task.id, Duration::from_secs(2)).await?;
    assert_eq!(terminal.terminal_reason, "aborted");
    let sub_id = sub.id.clone();
    assert_eq!(
        store
            .read_async(move |r| Box::pin(async move { r.submission_async(&sub_id).await }))
            .await?
            .status,
        crate::agent::durable::SubmissionStatus::Unanswered
    );
    Ok(())
}
