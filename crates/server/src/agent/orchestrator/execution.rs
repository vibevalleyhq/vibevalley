use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock, Weak};

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{ApiError, BizCode, SessionApproval, SessionApprovalResolveInput};
use vibevalley_runtime::BoxFuture;
use vibevalley_runtime::agent::core::engine::{BrainProvider, Request};
use vibevalley_runtime::agent::core::pipeline::Transcript;
use vibevalley_runtime::agent::durable::{Error, Result, Scheduler, Store, SubmissionStatus, Task, TaskStatus};
use vibevalley_runtime::agent::extensions::budget::BudgetExtension;
use vibevalley_runtime::agent::extensions::codemode::CodeModeExtension;
use vibevalley_runtime::agent::extensions::governance::{self, GovernanceExtension, Permissions};
use vibevalley_runtime::agent::extensions::grader::{GraderExtension, OutcomeReview, ReviewProvider, ReviewRequest, Rubric};
use vibevalley_runtime::agent::extensions::subagent::SubagentExtension;
use vibevalley_runtime::agent::extensions::todo::TodoExtension;
use vibevalley_runtime::agent::harness::{Harness, SharedExecution, generation_kind};
use vibevalley_runtime::agent::{AgentEvent, Brain, BrainError, Message, TurnOutcome};

use super::state::Orchestrator;
use super::types::Input;
use crate::agent::tool::Route;
use crate::channel::{Chat, Posting};

const EVENT_CHANNEL_CAPACITY: usize = 256;

pub(super) trait RunSink: Send + Sync {
    fn me_id(&self) -> &str;
    fn route(&self) -> &Route;
    fn run_id(&self) -> &str;
    fn has_ports(&self) -> bool;
    fn is_closed(&self) -> bool;
    fn chat(&self) -> &Chat;
    fn set_durable(&mut self);
    fn on_async<'a>(&'a mut self, e: AgentEvent) -> BoxFuture<'a, ()>;
}

pub(super) enum EvalEntry {
    TurnStarted { input: String },
    Message(Message),
    Compacted { summary: String },
}

struct Bound {
    orchestrator: OnceLock<Weak<Orchestrator>>,
    store: Store,
    listeners: Mutex<HashMap<String, mpsc::Sender<AgentEvent>>>,
}

impl BrainProvider for Bound {
    fn resolve_brain<'a>(&'a self, conv: &'a str, provider: &'a str) -> BoxFuture<'a, Result<Option<Arc<Brain>>>> {
        Box::pin(async move {
            let o = self.orchestrator.get().and_then(Weak::upgrade).ok_or(Error::Closed)?;
            let route = self
                .store
                .read_with_async(conv.to_owned(), |tx, conv| {
                    Box::pin(async move { Ok(tx.document_async("conversation", conv, "pi.route").await?.map(|d| d.state)) })
                })
                .await?;
            let route: Route = route.map(serde_json::from_value).transpose()?.unwrap_or_else(|| Route {
                agent: conv.into(),
                channel: o.chat.default_channel(),
                ..Default::default()
            });
            Ok(Some(Arc::new(o.brain_at_async(conv, &Arc::new(ArcSwap::from_pointee(route)), provider).await)))
        })
    }

    fn observe(&self, conv: &str, _task: &str, event: AgentEvent) {
        if let Some(session_id) = conv.strip_prefix("worker:")
            && let AgentEvent::Compacted { level, summary } = &event
            && let Some(o) = self.orchestrator.get().and_then(Weak::upgrade)
        {
            o.record_worker_compaction_episode(session_id, level, summary);
        }
        if let Some(s) = self.listeners.lock().get(conv)
            && let Err(err) = s.try_send(event)
        {
            tracing::warn!(conversation = conv, error = %err, "daemon session event channel full or closed");
        }
    }
}

#[derive(Serialize)]
struct ReviewChanges {
    files: Vec<vibevalley_protocol::ChangedFile>,
    uncommitted: Vec<vibevalley_protocol::UncommittedItem>,
    revision: Option<vibevalley_protocol::ReviewRevision>,
}

#[derive(Serialize)]
struct ReviewDeliverables {
    report: crate::runtime::Report,
    changes: Option<ReviewChanges>,
    notes: Vec<vibevalley_protocol::Note>,
}

#[derive(Serialize)]
struct StoppedPayload {
    error: &'static str,
}

#[derive(Serialize)]
struct TurnErrorPayload<'a> {
    error: &'a str,
    reason: &'a str,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AssistantEntryPayload {
    generation_task: String,
    text: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct UserEntryPayload {
    text: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CompactionEntryPayload {
    summary: String,
}

impl ReviewProvider for Bound {
    fn review<'a>(&'a self, request: ReviewRequest<'a>) -> BoxFuture<'a, Result<Option<OutcomeReview>>> {
        Box::pin(async move {
            let (Some(vendor), Some(run)) = (request.conversation.strip_prefix("worker:"), request.request_id.strip_prefix("work:")) else {
                return Ok(request.explicit());
            };
            let o = self.orchestrator.get().and_then(Weak::upgrade).ok_or(Error::Closed)?;
            let Some((issue, report)) = o
                .issue
                .review_work_async(vendor, run, request.candidate)
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?
            else {
                return Ok(None);
            };
            let changes = if issue.repo.is_some() {
                let diff = o.issue.diff_async(&issue.id, None).await.map_err(|e| Error::Invalid(e.message))?;
                Some(ReviewChanges {
                    files: diff.files,
                    uncommitted: diff.uncommitted,
                    revision: diff.revision,
                })
            } else {
                None
            };
            let notes = o
                .note
                .list_async(&vibevalley_protocol::NoteListRequest {
                    channel: None,
                    issue: Some(issue.id.clone()),
                    note_type: None,
                    parent_id: None,
                })
                .await
                .map_err(|e| Error::Invalid(e.message))?;
            let deliverables = serde_json::to_string(&ReviewDeliverables { report, changes, notes })?;
            const EVIDENCE_CHARS: usize = 16_000;
            Ok(Some(OutcomeReview {
                task_prompt: format!("{}\n{}", issue.title, issue.description),
                rubric: Rubric {
                    markdown: issue
                        .criteria
                        .iter()
                        .filter(|v| !v.trim().is_empty())
                        .map(|v| format!("- {v}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    max_iterations: 0,
                },
                deliverables: vibevalley_core::text::clip(&deliverables, EVIDENCE_CHARS),
                evidence_truncated: deliverables.chars().nth(EVIDENCE_CHARS).is_some(),
            }))
        })
    }
}

pub struct PendingExecution {
    harness: Harness,
    bound: Arc<Bound>,
    shared: SharedExecution,
}

impl PendingExecution {
    pub fn prepare(store: Store, permissions: Permissions) -> Self {
        let bound = Arc::new(Bound {
            orchestrator: OnceLock::new(),
            store: store.clone(),
            listeners: Default::default(),
        });
        let harness = Harness::from_store(store, bound.clone());
        harness.register_extension(Arc::new(GovernanceExtension::new(permissions)));
        harness.register_extension(Arc::new(BudgetExtension));
        harness.register_extension(Arc::new(GraderExtension::new(bound.clone())));
        harness.register_extension(Arc::new(TodoExtension::default().without_global_tools()));
        harness.register_extension(Arc::new(SubagentExtension::new("VibeValley").without_global_tools()));
        harness.register_extension(Arc::new(CodeModeExtension::new()));
        let shared = SharedExecution::new(harness.clone());
        Self { harness, bound, shared }
    }

    pub fn shared(&self) -> SharedExecution {
        self.shared.clone()
    }

    pub(super) fn attach(self, o: Weak<Orchestrator>) -> Execution {
        let _ = self.bound.orchestrator.set(o);
        let scheduler = self.harness.scheduler().clone();
        Execution {
            scheduler,
            harness: self.harness,
            bound: self.bound,
            shutdown: CancellationToken::new(),
        }
    }
}

pub struct Execution {
    pub scheduler: Scheduler,
    pub harness: Harness,
    bound: Arc<Bound>,
    shutdown: CancellationToken,
}

pub(super) struct TurnInput<'a> {
    pub requests: &'a [String],
    pub batch: &'a [Input],
    pub text: &'a str,
    pub model: &'a str,
}

impl Execution {
    pub(super) fn new(store: Store, o: Weak<Orchestrator>, permissions: Permissions) -> Self {
        PendingExecution::prepare(store, permissions).attach(o)
    }

    pub(super) async fn close_async(&self) {
        self.shutdown.cancel();
        self.harness.close().await;
    }

    pub fn store(&self) -> &Store {
        self.harness.store()
    }

    pub(super) async fn approvals_async(&self, conversation: Option<&str>) -> std::result::Result<Vec<SessionApproval>, ApiError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PendingApproval {
            tool_call_id: String,
            #[serde(default)]
            args_json: Value,
            evaluation: governance::Evaluation,
            requested_at_ms: i64,
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Governance {
            #[serde(default)]
            pending_permissions: BTreeMap<String, PendingApproval>,
        }

        if conversation.is_some_and(|id| id.trim().is_empty()) {
            return Err(ApiError::new(BizCode::InvalidInput, "id must be nonempty"));
        }
        let conv = conversation.map(str::to_owned);
        self.store()
            .read_with_async(conv, |tx, conv| {
                Box::pin(async move {
                    let documents = match conv {
                        Some(id) => tx.document_async(governance::SCOPE, id, governance::GOVERNANCE).await?.into_iter().collect(),
                        None => tx.documents_by_kind_async(governance::SCOPE, governance::GOVERNANCE).await?,
                    };
                    let mut approvals = vec![];
                    for document in documents {
                        let pending: Governance = serde_json::from_value(document.state)?;
                        for (task_id, approval) in pending.pending_permissions {
                            let task = tx.task_async(&task_id).await?;
                            if !matches!(task.status, TaskStatus::Sleeping | TaskStatus::Waiting) || task.conversation_id != document.scope_id {
                                continue;
                            }
                            approvals.push(SessionApproval {
                                id: task.conversation_id,
                                task_id,
                                tool_call_id: approval.tool_call_id,
                                tool_name: approval.evaluation.tool_name,
                                arguments_json: approval.args_json.to_string(),
                                reason: approval.evaluation.reason,
                                requested_at_ms: approval.requested_at_ms,
                            });
                        }
                    }
                    approvals.sort_by_key(|approval| approval.requested_at_ms);
                    Ok(approvals)
                })
            })
            .await
            .map_err(approval_error)
    }

    pub(super) async fn resolve_approval_async(&self, input: SessionApprovalResolveInput) -> std::result::Result<(), ApiError> {
        if [&input.id, &input.task_id, &input.tool_call_id].iter().any(|id| id.trim().is_empty()) {
            return Err(ApiError::new(BizCode::InvalidInput, "id, taskId and toolCallId must be nonempty"));
        }
        governance::resolve(
            self.store(),
            &self.scheduler,
            &input.id,
            &input.task_id,
            governance::Decision {
                tool_call_id: input.tool_call_id,
                approved: input.approved,
                reason: input.reason.unwrap_or_default(),
            },
        )
        .await
        .map_err(approval_error)
    }

    pub(super) async fn enqueue_async(&self, profile: &str, input: &Input) -> Result<()> {
        let request = input
            .messages
            .last()
            .map(|m| format!("chat:{m}"))
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let inbox = format!("inbox:{profile}");
        let payload = serde_json::to_value(input)?;
        self.store()
            .write_with_async((inbox, request, payload), |tx, (inbox, request, payload)| {
                Box::pin(async move {
                    match tx.conversation_async(inbox).await {
                        Err(Error::Missing(_)) => {
                            tx.create_conversation_async(inbox, "").await?;
                        }
                        Err(e) => return Err(e),
                        Ok(_) => (),
                    }
                    tx.submit_async(inbox, request, "input", payload, None).await?;
                    Ok(())
                })
            })
            .await
    }

    pub(super) async fn has_inputs_async(&self, id: &str) -> Result<bool> {
        let inbox = format!("inbox:{id}");
        self.store()
            .read_with_async(inbox, |tx, inbox| {
                Box::pin(async move {
                    Ok(tx
                        .submissions_async(inbox)
                        .await?
                        .iter()
                        .any(|s| matches!(s.status, SubmissionStatus::Queued | SubmissionStatus::Placed)))
                })
            })
            .await
    }

    pub(super) async fn batch_async(&self, profile: &str) -> Result<Vec<(String, Input)>> {
        let inbox = format!("inbox:{profile}");
        self.store()
            .read_with_async(inbox, |tx, inbox| {
                Box::pin(async move {
                    let subs = tx.submissions_async(inbox).await?;
                    // A batch that already owns a task must be delivered before newer inputs.
                    let status = if subs.iter().any(|s| s.status == SubmissionStatus::Placed) {
                        SubmissionStatus::Placed
                    } else {
                        SubmissionStatus::Queued
                    };
                    subs.into_iter()
                        .filter(|s| s.status == status)
                        .map(|s| Ok((s.id, serde_json::from_value(s.payload)?)))
                        .collect()
                })
            })
            .await
    }

    pub(super) async fn stop_async(&self, profile: &str) -> Result<()> {
        let conv = profile.to_owned();
        let tasks = self
            .store()
            .read_with_async(conv, |tx, conv| Box::pin(tx.tasks_by_conversation_async(conv)))
            .await?;
        for t in tasks.into_iter().filter(|t| t.kind == generation_kind() && t.status != TaskStatus::Terminal) {
            self.scheduler.abort(&t.id).await?;
        }
        let inbox = format!("inbox:{profile}");
        let ids = self
            .store()
            .read_with_async(inbox, |tx, inbox| {
                Box::pin(async move {
                    Ok(tx
                        .submissions_async(inbox)
                        .await?
                        .into_iter()
                        .filter(|s| s.status == SubmissionStatus::Queued)
                        .map(|s| s.id)
                        .collect::<Vec<_>>())
                })
            })
            .await?;
        let stopped = serde_json::to_value(StoppedPayload { error: "stopped" })?;
        self.finish_inputs_async(&ids, false, &stopped).await
    }

    pub(super) async fn finish_inputs_async(&self, ids: &[String], ok: bool, result: &Value) -> Result<()> {
        let ids = ids.to_vec();
        let result = result.clone();
        self.store()
            .write_with_async((ids, result), |tx, (ids, result)| {
                Box::pin(async move {
                    for id in ids {
                        tx.settle_async(id, if ok { SubmissionStatus::Done } else { SubmissionStatus::Unanswered }, result)
                            .await?;
                    }
                    Ok(())
                })
            })
            .await
    }

    pub(super) async fn run_async(&self, run: &mut dyn RunSink, input: TurnInput<'_>) -> vibevalley_runtime::agent::Result<TurnOutcome> {
        let id = run.me_id().to_owned();
        let (send, mut events) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        self.bound.listeners.lock().insert(id.clone(), send);
        let result = self.dispatch_async(run, &input, &mut events).await;
        self.bound.listeners.lock().remove(&id);
        result.map_err(|e| BrainError::Store(e.to_string()))
    }

    async fn dispatch_async(&self, run: &mut dyn RunSink, input: &TurnInput<'_>, events: &mut mpsc::Receiver<AgentEvent>) -> Result<TurnOutcome> {
        let conv = run.me_id().to_owned();
        let turn = format!("turn:{}", input.requests[0]);
        let brain = self
            .bound
            .resolve_brain(&conv, input.model)
            .await?
            .ok_or_else(|| Error::Invalid("orchestrator brain unavailable".into()))?;
        let trusted = input.batch.iter().filter(|i| i.user).map(|i| i.line.as_str()).collect::<Vec<_>>().join("\n");
        let mut changes = self.store().subscribe_tasks()?;
        let requests: Vec<String> = input.requests.to_vec();
        let conv_owned = conv.clone();
        let route_val = serde_json::to_value(run.route())?;
        let (sub, task, _) = self
            .harness
            .submit_with(
                Request {
                    conversation: &conv,
                    provider: input.model,
                    request_id: &turn,
                    prompt: input.text,
                    system: &brain.system,
                    source: if trusted.is_empty() { "agent" } else { "user" },
                    trusted_intent: Some(&trusted),
                    ..Default::default()
                },
                move |tx, _| {
                    Box::pin(async move {
                        for id in &requests {
                            tx.set_submission_status_async(id, SubmissionStatus::Placed).await?;
                        }
                        tx.put_document_async("conversation", &conv_owned, "pi.route", &route_val).await?;
                        Ok(())
                    })
                },
            )
            .await?;
        run.set_durable();
        let task = loop {
            if run.is_closed() {
                return Err(Error::Closed);
            }
            while let Ok(e) = events.try_recv() {
                run.on_async(e).await;
            }
            let tid = task.id.clone();
            let current = self.store().read_with_async(tid, |tx, tid| Box::pin(tx.task_async(tid))).await?;
            if current.status == TaskStatus::Terminal {
                break current;
            }
            let ev = tokio::select! {
                biased;
                _ = self.shutdown.cancelled() => None,
                ev = events.recv() => ev,
                _ = changes.recv() => None,
            };
            if let Some(e) = ev {
                run.on_async(e).await;
            }
        };
        while let Ok(e) = events.try_recv() {
            run.on_async(e).await;
        }
        let ok = task.terminal_reason == "completed";
        let payload = if ok {
            task.result.clone()
        } else {
            serde_json::to_value(TurnErrorPayload {
                error: &task.error_text,
                reason: &task.terminal_reason,
            })?
        };
        if !ok {
            let sub_id = sub.id.clone();
            let p = payload.clone();
            self.store()
                .write_with_async((sub_id, p), |tx, (sub_id, p)| {
                    Box::pin(tx.settle_async(sub_id, SubmissionStatus::Unanswered, p))
                })
                .await?;
        }
        self.publish_async(run, &task).await?;
        self.finish_inputs_async(input.requests, ok, &payload).await?;
        if ok {
            Ok(TurnOutcome::Completed)
        } else if task.terminal_reason == "aborted" {
            Ok(TurnOutcome::Aborted)
        } else {
            Err(Error::Invalid(task.error_text))
        }
    }

    async fn publish_async(&self, run: &dyn RunSink, task: &Task) -> Result<()> {
        let conv = task.conversation_id.clone();
        let task_id = task.id.clone();
        let replies = self
            .store()
            .read_with_async((conv, task_id), |tx, (conv, task_id)| {
                Box::pin(async move {
                    let mut matched = Vec::new();
                    for e in tx.entries_async(conv, 1).await? {
                        if e.kind != "pi.assistant" {
                            continue;
                        }
                        let Ok(payload) = serde_json::from_value::<AssistantEntryPayload>(e.payload) else {
                            continue;
                        };
                        if payload.generation_task == *task_id && !payload.text.trim().is_empty() {
                            matched.push((e.seq, payload.text));
                        }
                    }
                    Ok(matched)
                })
            })
            .await?;
        for (seq, text) in replies {
            run.chat()
                .post_async(Posting {
                    from: run.me_id().to_owned(),
                    channel: run.route().channel.clone(),
                    text,
                    run: Some(run.run_id().to_owned()),
                    send_key: format!("{}:{seq}", task.id),
                    made: None,
                    spoken: run.has_ports(),
                })
                .await
                .map_err(|e| Error::Invalid(e.message))?;
        }
        Ok(())
    }

    pub(super) async fn entries_async(&self, profile: &str) -> Result<Vec<EvalEntry>> {
        let conv = profile.to_owned();
        self.store()
            .read_with_async(conv, |tx, conv| {
                Box::pin(async move {
                    let mut out = vec![];
                    for e in tx.entries_async(conv, 1).await? {
                        match e.kind.as_str() {
                            "pi.user" => {
                                let payload = serde_json::from_value::<UserEntryPayload>(e.payload).unwrap_or_default();
                                out.push(EvalEntry::TurnStarted { input: payload.text });
                            }
                            "pi.assistant" | "pi.tool_result" => {
                                let tr = Transcript {
                                    conversation_id: conv.into(),
                                    provider_affinity: String::new(),
                                    entries: vec![e],
                                    prefix_hash: String::new(),
                                };
                                out.extend(tr.messages().into_iter().map(EvalEntry::Message));
                            }
                            "pi.compaction" => {
                                let payload = serde_json::from_value::<CompactionEntryPayload>(e.payload).unwrap_or_default();
                                out.push(EvalEntry::Compacted { summary: payload.summary });
                            }
                            _ => (),
                        }
                    }
                    Ok(out)
                })
            })
            .await
    }

    pub(super) async fn latest_compaction_async(&self, conv: &str) -> Result<Option<(i64, String)>> {
        let conv = conv.to_owned();
        self.store()
            .read_with_async(conv, |tx, conv| {
                Box::pin(async move {
                    let found = tx.visible_entries_async(conv).await?.into_iter().rev().find(|e| e.kind == "pi.compaction");
                    Ok(found.map(|e| {
                        let payload = serde_json::from_value::<CompactionEntryPayload>(e.payload).unwrap_or_default();
                        (e.seq, payload.summary)
                    }))
                })
            })
            .await
    }
}

fn approval_error(error: Error) -> ApiError {
    let code = match error {
        Error::Missing(_) => BizCode::OrchestratorNotFound,
        Error::Invalid(_) => BizCode::OrchestratorRefused,
        Error::Closed | Error::Timeout => BizCode::ServiceUnavailable,
        Error::Commit(_) | Error::Db(_) | Error::Sql(_) | Error::Json(_) => BizCode::InternalError,
    };
    ApiError::new(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_and_entry_payloads_default_missing_fields() {
        let route: Route = serde_json::from_value(serde_json::json!({ "agent": "orch" })).unwrap();
        assert_eq!(route.agent, "orch");
        assert_eq!(route.channel, "");
        assert!(!route.user);

        let assistant: AssistantEntryPayload = serde_json::from_value(serde_json::json!({ "generationTask": "t1" })).unwrap();
        assert_eq!(assistant.generation_task, "t1");
        assert_eq!(assistant.text, "");

        let user: UserEntryPayload = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(user.text, "");

        let compaction: CompactionEntryPayload = serde_json::from_value(serde_json::json!({ "summary": "done" })).unwrap();
        assert_eq!(compaction.summary, "done");
    }
}
