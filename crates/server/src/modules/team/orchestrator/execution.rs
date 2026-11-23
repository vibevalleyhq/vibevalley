use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Weak, atomic::Ordering};

use parking_lot::Mutex;
use serde_json::{Value, json};
use vibevalley_runtime::agent::core::engine::{BrainProvider, Request};
use vibevalley_runtime::agent::core::pipeline::Transcript;
use vibevalley_runtime::agent::durable::{Error, Result, Scheduler, Store, SubmissionStatus, Task, TaskStatus};
use vibevalley_runtime::agent::extensions::budget::BudgetExtension;
use vibevalley_runtime::agent::extensions::governance::{self, GovernanceExtension, Permissions};
use vibevalley_runtime::agent::extensions::grader::{GraderExtension, OutcomeReview, ReviewProvider, ReviewRequest, Rubric};
use vibevalley_runtime::agent::extensions::subagent::SubagentExtension;
use vibevalley_runtime::agent::extensions::todo::TodoExtension;
use vibevalley_runtime::agent::harness::{Harness, generation_kind};
use vibevalley_runtime::agent::{AgentEvent, Brain, BrainError, Message, TurnOutcome};

use vibevalley_protocol::{ApiError, BizCode, OrchestratorApproval, OrchestratorApprovalResolveInput};

use super::{Input, Orchestrator, Run};
use crate::modules::collab::channel::Posting;
use crate::modules::team::tool::Route;

pub(super) enum EvalEntry {
    TurnStarted { input: String },
    Message(Message),
    Compacted { summary: String },
}

struct Bound {
    orchestrator: Weak<Orchestrator>,
    store: Store,
    listeners: Mutex<HashMap<String, flume::Sender<AgentEvent>>>,
}

impl BrainProvider for Bound {
    fn resolve_brain(&self, conv: &str, provider: &str) -> Result<Option<Arc<Brain>>> {
        let o = self.orchestrator.upgrade().ok_or(Error::Closed)?;
        let route = self.store.read(|tx| Ok(tx.document("conversation", conv, "pi.route")?.map(|d| d.state)))?;
        let route: Route = route.map(serde_json::from_value).transpose()?.unwrap_or_else(|| Route {
            agent: conv.into(),
            channel: o.farm.chat.default_channel(),
            ..Default::default()
        });
        Ok(Some(Arc::new(o.brain_at(conv, &Arc::new(Mutex::new(route)), provider))))
    }

    fn observe(&self, conv: &str, _task: &str, event: AgentEvent) {
        if let Some(s) = self.listeners.lock().get(conv) {
            let _ = s.send(event);
        }
    }
}

impl ReviewProvider for Bound {
    fn review(&self, request: ReviewRequest<'_>) -> Result<Option<OutcomeReview>> {
        let (Some(vendor), Some(run)) = (request.conversation.strip_prefix("worker:"), request.request_id.strip_prefix("work:")) else {
            return Ok(request.explicit());
        };
        let o = self.orchestrator.upgrade().ok_or(Error::Closed)?;
        let Some((issue, report)) = o
            .farm
            .board
            .sessions()
            .review_work(vendor, run, request.candidate)
            .map_err(|e| Error::Invalid(e.to_string()))?
        else {
            return Ok(None);
        };
        let changes = if issue.repo.is_some() {
            let diff = crate::modules::work::issue::changes_of(&o.farm.board, &issue, None).map_err(|e| Error::Invalid(e.message))?;
            Some(json!({"files":diff.files,"uncommitted":diff.uncommitted,"revision":diff.revision}))
        } else {
            None
        };
        let artifacts = o
            .farm
            .artifacts
            .list(&vibevalley_protocol::ArtifactListRequest {
                channel: None,
                issue: Some(issue.id.clone()),
                artifact_type: None,
            })
            .map_err(|e| Error::Invalid(e.message))?;
        let deliverables = json!({"report":report, "changes":changes, "artifacts":artifacts}).to_string();
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
    }
}

pub struct Execution {
    pub scheduler: Scheduler,
    pub harness: Harness,
    bound: Arc<Bound>,
    shutdown: Mutex<Option<flume::Sender<()>>>,
    stopped: flume::Receiver<()>,
}

pub(super) struct TurnInput<'a> {
    pub requests: &'a [String],
    pub batch: &'a [Input],
    pub text: &'a str,
    pub model: &'a str,
}

impl Execution {
    pub(super) fn new(store: Store, o: Weak<Orchestrator>, permissions: Permissions) -> Self {
        let bound = Arc::new(Bound {
            orchestrator: o,
            store: store.clone(),
            listeners: Default::default(),
        });
        let harness = Harness::from_store(store, bound.clone());
        let scheduler = harness.scheduler().clone();
        harness.register_extension(Arc::new(GovernanceExtension::new(permissions)));
        harness.register_extension(Arc::new(BudgetExtension));
        harness.register_extension(Arc::new(GraderExtension::new(bound.clone())));
        harness.register_extension(Arc::new(TodoExtension::default().without_global_tools()));
        harness.register_extension(Arc::new(SubagentExtension::new("VibeValley").without_global_tools()));
        let (shutdown, stopped) = flume::bounded(0);
        Self {
            scheduler,
            harness,
            bound,
            shutdown: Mutex::new(Some(shutdown)),
            stopped,
        }
    }

    pub(super) fn close(&self) {
        self.shutdown.lock().take();
        self.harness.close();
    }

    pub fn store(&self) -> &Store {
        self.harness.store()
    }

    pub(super) fn approvals(&self, conversation: Option<&str>) -> std::result::Result<Vec<OrchestratorApproval>, ApiError> {
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
            return Err(ApiError::new(BizCode::InvalidInput, "conversationId must be nonempty"));
        }
        self.store()
            .read(|tx| {
                let documents = match conversation {
                    Some(id) => tx.document(governance::SCOPE, id, governance::GOVERNANCE)?.into_iter().collect(),
                    None => tx.documents_by_kind(governance::SCOPE, governance::GOVERNANCE)?,
                };
                let mut approvals = vec![];
                for document in documents {
                    let pending: Governance = serde_json::from_value(document.state)?;
                    for (task_id, approval) in pending.pending_permissions {
                        let task = tx.task(&task_id)?;
                        if task.status == TaskStatus::Terminal || task.conversation_id != document.scope_id {
                            continue;
                        }
                        approvals.push(OrchestratorApproval {
                            conversation_id: task.conversation_id,
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
            .map_err(approval_error)
    }

    pub(super) fn resolve_approval(&self, input: OrchestratorApprovalResolveInput) -> std::result::Result<(), ApiError> {
        if [&input.conversation_id, &input.task_id, &input.tool_call_id]
            .iter()
            .any(|id| id.trim().is_empty())
        {
            return Err(ApiError::new(BizCode::InvalidInput, "conversationId, taskId and toolCallId must be nonempty"));
        }
        governance::resolve(
            self.store(),
            &self.scheduler,
            &input.conversation_id,
            &input.task_id,
            governance::Decision {
                tool_call_id: input.tool_call_id,
                approved: input.approved,
                reason: input.reason.unwrap_or_default(),
            },
        )
        .map_err(approval_error)
    }

    pub(super) fn enqueue(&self, profile: &str, input: &Input) -> Result<()> {
        let request = input
            .messages
            .last()
            .map(|m| format!("chat:{m}"))
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let inbox = format!("inbox:{profile}");
        self.store().write(|tx| {
            match tx.conversation(&inbox) {
                Err(Error::Missing(_)) => {
                    tx.create_conversation(&inbox, "")?;
                }
                Err(e) => return Err(e),
                Ok(_) => (),
            }
            tx.submit(&inbox, &request, "input", &serde_json::to_value(input)?, None)?;
            Ok(())
        })
    }

    pub(super) fn has_inputs(&self, id: &str) -> Result<bool> {
        self.store().read(|tx| {
            Ok(tx
                .submissions(&format!("inbox:{id}"))?
                .iter()
                .any(|s| matches!(s.status, SubmissionStatus::Queued | SubmissionStatus::Placed)))
        })
    }

    pub(super) fn batch(&self, profile: &str) -> Result<Vec<(String, Input)>> {
        self.store().read(|tx| {
            let subs = tx.submissions(&format!("inbox:{profile}"))?;
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
    }

    pub(super) fn stop(&self, profile: &str) -> Result<()> {
        let tasks = self.store().read(|tx| tx.tasks_by_conversation(profile))?;
        for t in tasks.into_iter().filter(|t| t.kind == generation_kind() && t.status != TaskStatus::Terminal) {
            self.scheduler.abort(&t.id)?;
        }
        let ids = self.store().read(|tx| {
            Ok(tx
                .submissions(&format!("inbox:{profile}"))?
                .into_iter()
                .filter(|s| s.status == SubmissionStatus::Queued)
                .map(|s| s.id)
                .collect::<Vec<_>>())
        })?;
        self.finish_inputs(&ids, false, &json!({"error":"stopped"}))
    }

    pub(super) fn finish_inputs(&self, ids: &[String], ok: bool, result: &Value) -> Result<()> {
        self.store().write(|tx| {
            for id in ids {
                tx.settle(id, if ok { SubmissionStatus::Done } else { SubmissionStatus::Unanswered }, result)?;
            }
            Ok(())
        })
    }

    pub(super) fn run(&self, run: &mut Run<'_>, input: TurnInput<'_>) -> vibevalley_runtime::agent::Result<TurnOutcome> {
        let id = run.me.id.clone();
        let (send, events) = flume::unbounded();
        self.bound.listeners.lock().insert(id.clone(), send);
        let result = self.dispatch(run, &input, &events);
        self.bound.listeners.lock().remove(&id);
        result.map_err(|e| BrainError::Store(e.to_string()))
    }

    fn dispatch(&self, run: &mut Run<'_>, input: &TurnInput<'_>, events: &flume::Receiver<AgentEvent>) -> Result<TurnOutcome> {
        let conv = &run.me.id;
        let turn = format!("turn:{}", input.requests[0]);
        let brain = self
            .bound
            .resolve_brain(conv, input.model)?
            .ok_or_else(|| Error::Invalid("orchestrator brain unavailable".into()))?;
        let trusted = input.batch.iter().filter(|i| i.user).map(|i| i.line.as_str()).collect::<Vec<_>>().join("\n");
        let changes = self.store().subscribe_tasks()?;
        let (sub, task, _) = self.harness.submit_with(
            Request {
                conversation: conv,
                provider: input.model,
                request_id: &turn,
                prompt: input.text,
                system: &brain.system,
                source: if trusted.is_empty() { "agent" } else { "user" },
                trusted_intent: Some(&trusted),
                ..Default::default()
            },
            |tx, _| {
                for id in input.requests {
                    tx.set_submission_status(id, SubmissionStatus::Placed)?;
                }
                tx.put_document("conversation", conv, "pi.route", &serde_json::to_value(run.route)?)?;
                Ok(())
            },
        )?;
        run.durable = true;
        let task = loop {
            if run.o.closed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            while let Ok(e) = events.try_recv() {
                run.on(e);
            }
            let current = self.store().read(|tx| tx.task(&task.id))?;
            if current.status == TaskStatus::Terminal {
                break current;
            }
            flume::Selector::new()
                .recv(events, |e| e.ok())
                .recv(&changes, |_| None)
                .recv(&self.stopped, |_| None)
                .wait()
                .into_iter()
                .for_each(|e| run.on(e));
        };
        while let Ok(e) = events.try_recv() {
            run.on(e);
        }
        let ok = task.terminal_reason == "completed";
        let payload = if ok {
            task.result.clone()
        } else {
            json!({"error":task.error_text,"reason":task.terminal_reason})
        };
        if !ok {
            self.store().write(|tx| {
                tx.settle(&sub.id, SubmissionStatus::Unanswered, &payload)?;
                Ok(())
            })?;
        }
        self.publish(run, &task)?;
        self.finish_inputs(input.requests, ok, &payload)?;
        if ok {
            Ok(TurnOutcome::Completed)
        } else if task.terminal_reason == "aborted" {
            Ok(TurnOutcome::Aborted)
        } else {
            Err(Error::Invalid(task.error_text))
        }
    }

    fn publish(&self, run: &Run<'_>, task: &Task) -> Result<()> {
        let replies = self.store().read(|tx| {
            Ok(tx
                .entries(&task.conversation_id, 1)?
                .into_iter()
                .filter(|e| e.kind == "pi.assistant" && e.payload["generationTask"] == task.id)
                .collect::<Vec<_>>())
        })?;
        for e in replies {
            let Some(text) = e.payload["text"].as_str().filter(|s| !s.trim().is_empty()) else {
                continue;
            };
            run.o
                .farm
                .chat
                .post(Posting {
                    from: run.me.id.clone(),
                    channel: run.route.channel.clone(),
                    text: text.into(),
                    run: Some(run.run.clone()),
                    send_key: format!("{}:{}", task.id, e.seq),
                    made: None,
                    spoken: !run.ports.is_empty(),
                })
                .map_err(|e| Error::Invalid(e.message))?;
        }
        Ok(())
    }

    pub(super) fn entries(&self, profile: &str) -> Result<Vec<EvalEntry>> {
        self.store().read(|tx| {
            let mut out = vec![];
            for e in tx.entries(profile, 1)? {
                match e.kind.as_str() {
                    "pi.user" => out.push(EvalEntry::TurnStarted {
                        input: e.payload["text"].as_str().unwrap_or_default().into(),
                    }),
                    "pi.assistant" | "pi.tool_result" => {
                        let tr = Transcript {
                            conversation_id: profile.into(),
                            provider_affinity: String::new(),
                            entries: vec![e],
                            prefix_hash: String::new(),
                        };
                        out.extend(tr.messages().into_iter().map(EvalEntry::Message));
                    }
                    "pi.compaction" => out.push(EvalEntry::Compacted {
                        summary: e.payload["summary"].as_str().unwrap_or_default().into(),
                    }),
                    _ => (),
                }
            }
            Ok(out)
        })
    }
}

fn approval_error(error: Error) -> ApiError {
    let code = match error {
        Error::Missing(_) => BizCode::OrchestratorNotFound,
        Error::Invalid(_) => BizCode::OrchestratorRefused,
        Error::Closed | Error::Timeout => BizCode::ServiceUnavailable,
        Error::Commit(_) | Error::Sql(_) | Error::Json(_) => BizCode::InternalError,
    };
    ApiError::new(code, error.to_string())
}
