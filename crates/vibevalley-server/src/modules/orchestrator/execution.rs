use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, Weak, atomic::Ordering};

use serde_json::{Value, json};
use vibevalley_agent::{
    Brain, BrainError, BrainEvent, Entry, Message, TurnOutcome,
    generation::{Environment, Generation, OutcomeReview, Request, ReviewRequest, Rubric, governance, transcript::Transcript},
};
use vibevalley_durable::{Error, Result, Scheduler, Store, SubmissionStatus, Task, TaskStatus};

use vibevalley_protocol::{ApiError, BizCode, OrchestratorApproval, OrchestratorApprovalResolveInput};

use super::{Input, Orchestrator, Run};
use crate::lock;
use crate::modules::{channel::Posting, tool::Route};

struct Bound {
    orchestrator: Weak<Orchestrator>,
    store: Store,
    listeners: Mutex<HashMap<String, flume::Sender<BrainEvent>>>,
}
impl Environment for Bound {
    fn brain(&self, conv: &str, provider: &str) -> Result<Arc<Brain>> {
        let o = self.orchestrator.upgrade().ok_or(Error::Closed)?;
        let route = self.store.read(|tx| Ok(tx.document("conversation", conv, "pi.route")?.map(|d| d.state)))?;
        let route: Route = route.map(serde_json::from_value).transpose()?.unwrap_or_else(|| Route {
            agent: conv.into(),
            channel: o.farm.chat.default_channel(),
            ..Default::default()
        });
        Ok(Arc::new(o.brain_at(conv, &Arc::new(Mutex::new(route)), provider)))
    }
    fn observe(&self, conv: &str, _task: &str, event: BrainEvent) {
        if let Some(s) = lock(&self.listeners).get(conv) {
            let _ = s.send(event);
        }
    }
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
            let diff = crate::modules::issue::changes_of(&o.farm.board, &issue, None).map_err(|e| Error::Invalid(e.message))?;
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
    pub generation: Generation,
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
    pub(super) fn new(store: Store, o: Weak<Orchestrator>, permissions: vibevalley_agent::generation::governance::Permissions) -> Self {
        let scheduler = Scheduler::new(store.clone(), 32);
        let bound = Arc::new(Bound {
            orchestrator: o,
            store: store.clone(),
            listeners: Default::default(),
        });
        let mut generation = Generation::new(store, bound.clone());
        generation.permissions = permissions;
        generation.register(&scheduler);
        let (shutdown, stopped) = flume::bounded(0);
        Self {
            scheduler,
            generation,
            bound,
            shutdown: Mutex::new(Some(shutdown)),
            stopped,
        }
    }
    pub(super) fn close(&self) {
        lock(&self.shutdown).take();
        self.scheduler.close();
        self.generation.compactor.wait();
    }
    pub fn store(&self) -> &Store {
        &self.generation.store
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

    pub(crate) fn raise_budget(&self, input: Value) -> vibevalley_protocol::Envelope {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raise {
            #[serde(default)]
            conversation_id: String,
            #[serde(default)]
            task_id: String,
            new_max_cost_micros: i64,
        }
        let result = (|| -> Result<Value> {
            let p: Raise = serde_json::from_value(input)?;
            let (conv, task) = self.store().read(|tx| {
                let conv = if p.conversation_id.is_empty() {
                    tx.task(&p.task_id)?.conversation_id
                } else {
                    p.conversation_id
                };
                let task = if !p.task_id.is_empty() {
                    Some(p.task_id)
                } else {
                    tx.tasks_by_conversation(&conv)?
                        .into_iter()
                        .find(|t| t.status == TaskStatus::Sleeping && t.wait_signal_name == "budget.updated")
                        .map(|t| t.id)
                };
                Ok((conv, task))
            })?;
            Ok(json!(vibevalley_agent::generation::governance::set_budget(
                self.store(),
                &self.scheduler,
                &conv,
                task.as_deref(),
                p.new_max_cost_micros
            )?))
        })();
        envelope(result)
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
        for t in tasks
            .into_iter()
            .filter(|t| t.kind == vibevalley_agent::generation::KIND && t.status != TaskStatus::Terminal)
        {
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

    pub(super) fn run(&self, run: &mut Run<'_>, input: TurnInput<'_>) -> vibevalley_agent::Result<TurnOutcome> {
        let id = run.me.id.clone();
        let (send, events) = flume::unbounded();
        lock(&self.bound.listeners).insert(id.clone(), send);
        let result = self.dispatch(run, &input, &events);
        lock(&self.bound.listeners).remove(&id);
        result.map_err(|e| BrainError::Store(e.to_string()))
    }

    fn dispatch(&self, run: &mut Run<'_>, input: &TurnInput<'_>, events: &flume::Receiver<BrainEvent>) -> Result<TurnOutcome> {
        let conv = &run.me.id;
        let turn = format!("turn:{}", input.requests[0]);
        let brain = self.bound.brain(conv, input.model)?;
        let trusted = input.batch.iter().filter(|i| i.user).map(|i| i.line.as_str()).collect::<Vec<_>>().join("\n");
        let changes = self.store().subscribe_tasks()?;
        let (sub, task, _) = self.generation.submit_with(
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

    pub(super) fn entries(&self, profile: &str) -> Result<Vec<Entry>> {
        self.store().read(|tx| {
            let mut out = vec![];
            for e in tx.entries(profile, 1)? {
                match e.kind.as_str() {
                    "pi.user" => out.push(Entry::TurnStarted {
                        input: e.payload["text"].as_str().unwrap_or_default().into(),
                    }),
                    "pi.assistant" | "pi.tool_result" => {
                        let tr = Transcript {
                            conversation_id: profile.into(),
                            provider_affinity: String::new(),
                            entries: vec![e],
                            prefix_hash: String::new(),
                        };
                        out.extend(tr.messages().into_iter().map(|message: Message| Entry::Message { message, usage: None }));
                    }
                    "pi.compaction" => out.push(Entry::Compacted {
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

fn envelope(result: Result<Value>) -> vibevalley_protocol::Envelope {
    match result {
        Ok(v) => vibevalley_protocol::Envelope::ok(v),
        Err(e) => vibevalley_server_api::refusal(vibevalley_protocol::BizCode::Refused, e.to_string()),
    }
}
