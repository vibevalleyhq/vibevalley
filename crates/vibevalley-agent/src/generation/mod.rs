//! Durable model generation, keyed by a submission and advanced one persisted phase at a time.
pub mod governance;
mod grading;
pub use grading::{OutcomeReview, ReviewRequest, Rubric, RubricVerdict};
#[cfg(test)]
mod tests;
pub mod transcript;
pub mod workers;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use vibevalley_durable::{Error, Result, Scheduler, Store, Submission, SubmissionStatus, Task, TaskContext, TaskStatus, Transition, Tx};

use crate::{Brain, BrainError, BrainEvent, ChatRequest, Delta, ToolCall, ToolOutput};
use governance::{Classifier, Decision, DefaultClassifier, Permissions, UsageTotals, Verdict};
use transcript::{Compactor, Level, Transcript};

pub const KIND: &str = "pi.generation";
const GENERATE: &str = "generate";
const TOOL_TURN: &str = "tool_turn";
const YIELD_CHECK: &str = "yield_check";

pub trait Environment: Send + Sync {
    fn brain(&self, conversation: &str, provider: &str) -> Result<Arc<Brain>>;
    fn observe(&self, _conversation: &str, _task: &str, _event: BrainEvent) {}
    fn review(&self, request: ReviewRequest<'_>) -> Result<Option<OutcomeReview>> {
        Ok(request.explicit())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Checkpoint {
    prompt: String,
    submission: String,
    last_output: String,
    calls: Vec<ToolCall>,
    index: usize,
    step: usize,
    usage: crate::Usage,
    iteration: u32,
    rubric: Option<Rubric>,
    parked: Option<String>,
    approved: Option<String>,
    started: Option<String>,
    next_phase: Option<String>,
}

#[derive(Clone)]
pub struct Generation {
    pub store: Store,
    pub compactor: Compactor,
    pub permissions: Permissions,
    pub classifier: Arc<dyn Classifier>,
    env: Arc<dyn Environment>,
    pub workers: workers::Workers,
}

#[derive(Clone, Default)]
pub struct Request<'a> {
    pub conversation: &'a str,
    pub provider: &'a str,
    pub request_id: &'a str,
    pub prompt: &'a str,
    pub source: &'a str,
    pub system: &'a str,
    pub trusted_intent: Option<&'a str>,
    pub rubric: Option<Rubric>,
    pub notify_task: Option<&'a str>,
}

impl Generation {
    pub fn new(store: Store, env: Arc<dyn Environment>) -> Self {
        Self {
            compactor: Compactor::new(store.clone()),
            store,
            env,
            workers: Default::default(),
            permissions: Permissions::default(),
            classifier: Arc::new(DefaultClassifier),
        }
    }
    fn brain(&self, conv: &str, provider: &str) -> Result<Arc<Brain>> {
        if conv.starts_with("worker:") {
            return self.workers.brain(conv).ok_or_else(|| Error::Invalid("worker runtime is detached".into()));
        }
        self.env.brain(conv, provider)
    }

    fn observe(&self, conv: &str, task: &str, event: BrainEvent) {
        if conv.starts_with("worker:") {
            self.workers.observe(conv, event)
        } else {
            self.env.observe(conv, task, event)
        }
    }

    fn code_tool(&self, tc: &TaskContext, name: &str, args: Value) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let call = &tc.task.id;
        let cp = &tc.task.checkpoint;
        let park = |signal: &str| Transition::Sleep {
            phase: vibevalley_durable_codemode::RUN.into(),
            checkpoint: None,
            until_ms: None,
            signal: Some(signal.into()),
        };
        if conv.starts_with("worker:") && self.workers.brain(conv).is_none() {
            return Ok(park(workers::ATTACHED));
        }
        let tr = Transcript::load(&self.store, conv)?;
        let brain = self.brain(conv, &tr.provider_affinity)?;
        let tool = brain
            .tools
            .iter()
            .find(|t| t.spec().name == name)
            .ok_or_else(|| Error::Invalid(format!("unknown tool: {name}")))?;
        if let Some(out) = tc.task.memo.get("toolOutput") {
            return if let Some(error) = out["error"].as_str() {
                Err(Error::Invalid(error.into()))
            } else {
                Ok(Transition::Complete(out["value"].clone()))
            };
        }
        if tc.task.memo["toolStarted"] == true && !tool.replay_safe() {
            return Err(Error::Invalid("tool execution interrupted; inspect the worktree before retrying".into()));
        }
        if cp["parked"] == true {
            if tc.task.memo["toolStarted"] != true {
                let Some(signal) = &tc.signal else {
                    return Ok(park(governance::PERMISSION_SIGNAL));
                };
                let decision: Decision = serde_json::from_value(signal.payload.clone())?;
                if decision.tool_call_id != *call {
                    return Ok(park(governance::PERMISSION_SIGNAL));
                }
                if !decision.approved {
                    return Err(Error::Invalid(if decision.reason.is_empty() {
                        "permission denied".into()
                    } else {
                        decision.reason
                    }));
                }
            }
        } else if tc.task.memo["toolStarted"] != true {
            let eval = governance::evaluate(&self.permissions, &*self.classifier, &tr.entries, name, &args, tool.is_mcp());
            self.store.write(|tx| {
                let mut t = running(tc, tx)?;
                governance::record_evaluation(tx, conv, &tc.task.id, call, &args, &eval)?;
                if eval.verdict == Verdict::Ask {
                    t.checkpoint["parked"] = json!(true);
                    tx.update_task(&t)?;
                }
                Ok(())
            })?;
            match eval.verdict {
                Verdict::Deny => return Err(Error::Invalid(eval.reason)),
                Verdict::Ask => return Ok(park(governance::PERMISSION_SIGNAL)),
                Verdict::Allow => (),
            }
        }
        tc.memo("toolStarted", || Ok(json!(true)))?;
        let out = tool.execute_cancellable(&args, &tc.cancellation());
        let decoded = serde_json::from_str(&out.text).unwrap_or_else(|_| Value::String(out.text.clone()));
        tc.memo("toolOutput", || {
            Ok(if out.is_error { json!({"error":out.text}) } else { json!({"value":decoded}) })
        })?;
        if out.is_error {
            Err(Error::Invalid(out.text))
        } else {
            Ok(Transition::Complete(decoded))
        }
    }

    pub fn register(&self, s: &Scheduler) {
        let code = self.clone();
        vibevalley_durable_codemode::register_with(s, move |tc, name, args| code.code_tool(tc, name, args));
        for (name, fun) in [
            (GENERATE, Self::generate as fn(&Self, &TaskContext, &mut Checkpoint) -> Result<Transition>),
            (TOOL_TURN, Self::tool_turn),
            (YIELD_CHECK, Self::yield_check),
        ] {
            let engine = self.clone();
            s.register(KIND, name, move |tc| {
                let mut cp: Checkpoint = serde_json::from_value(tc.task.checkpoint.clone())?;
                // A journal transaction can commit before the scheduler records the phase transition.
                if let Some(phase) = cp.next_phase.take() {
                    return Ok(Transition::Next {
                        phase,
                        checkpoint: Some(json!(cp)),
                    });
                }
                if tc.task.conversation_id.starts_with("worker:") && engine.workers.brain(&tc.task.conversation_id).is_none() {
                    return Ok(sleep(name, &cp, workers::ATTACHED));
                }
                match fun(&engine, tc, &mut cp) {
                    Err(e) if !tc.is_cancelled() => {
                        engine.store.write(|tx| {
                            tx.settle(&cp.submission, SubmissionStatus::Unanswered, &json!({"error":e.to_string()}))?;
                            Ok(())
                        })?;
                        Ok(Transition::Fail(e.to_string()))
                    }
                    result => result,
                }
            });
        }
    }

    pub fn submit(&self, r: Request<'_>) -> Result<(Submission, Task, bool)> {
        self.submit_with(r, |_, _| Ok(()))
    }

    pub fn submit_with(&self, r: Request<'_>, placed: impl FnOnce(&mut Tx<'_>, &Task) -> Result<()>) -> Result<(Submission, Task, bool)> {
        self.store.write(|tx| {
            match tx.conversation(r.conversation) {
                Err(Error::Missing(_)) => {
                    tx.create_conversation(r.conversation, r.provider)?;
                }
                Ok(_) => (),
                Err(e) => return Err(e),
            }
            let (sub, duplicate) = tx.submit(
                r.conversation,
                r.request_id,
                "prompt",
                &json!({"text":r.prompt,"source":r.source,"trustedIntent":r.trusted_intent}),
                r.notify_task,
            )?;
            let id = format!("gen-{}", sub.id);
            if duplicate {
                return Ok((sub, tx.task(&id)?, true));
            }
            if tx
                .tasks_by_conversation(r.conversation)?
                .iter()
                .any(|t| t.kind == KIND && t.status != TaskStatus::Terminal)
            {
                return Err(Error::Invalid("conversation already has an active generation".into()));
            }
            let mut t = Task::new(KIND, GENERATE);
            t.id = id;
            t.is_model_task = true;
            t.conversation_id = r.conversation.into();
            t.checkpoint = json!(Checkpoint {
                prompt: r.prompt.into(),
                submission: sub.id.clone(),
                rubric: r.rubric,
                ..Default::default()
            });
            if !r.system.is_empty() {
                let prior = tx.entries(r.conversation, 1)?.into_iter().rev().find(|e| e.kind == "pi.system");
                if !prior.as_ref().is_some_and(|e| e.payload["text"] == r.system) {
                    tx.append_entry(r.conversation, "pi.system", &json!({"text":r.system,"delta":prior.is_some()}))?;
                }
            }
            tx.append_entry(r.conversation, "pi.user", &sub.payload)?;
            let (task, _) = tx.create_task(t)?;
            placed(tx, &task)?;
            Ok((sub, task, false))
        })
    }

    fn generate(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let b = self.store.write(|tx| governance::check_budget(tx, conv, &tc.task.id))?;
        if b.reached {
            return Ok(sleep(GENERATE, cp, governance::BUDGET_SIGNAL));
        }
        self.compactor.before_request(conv)?;
        let tr = Transcript::load(&self.store, conv)?;
        let brain = self.brain(conv, &tr.provider_affinity)?;
        if cp.step >= brain.max_steps {
            return Err(Error::Invalid("model step limit reached".into()));
        }
        let mut req = ChatRequest {
            model: brain.model.clone(),
            messages: tr.messages(),
            tools: brain.tools.iter().map(|t| t.spec()).collect(),
            effort: brain.effort.clone(),
        };
        let mut live = String::new();
        let stream = |delta, live: &mut String| match delta {
            Delta::Text(text) => {
                live.push_str(&text);
                let _ = self.store.put_deferred("conversation", conv, "pi.live", json!({"text":live}));
                self.observe(conv, &tc.task.id, BrainEvent::Text(text));
            }
            Delta::Reasoning(r) => self.observe(conv, &tc.task.id, BrainEvent::Reasoning(r)),
        };
        let resp = match brain.client.complete(&req, &mut |d| stream(d, &mut live)) {
            Err(BrainError::ContextOverflow(_)) => {
                self.compactor.compact(conv, Level::Overflow, None)?;
                req.messages = Transcript::load(&self.store, conv)?.messages();
                live.clear();
                brain.client.complete(&req, &mut |d| stream(d, &mut live))
            }
            other => other,
        }
        .map_err(|e| Error::Invalid(e.to_string()))?;
        let cost = crate::price::deepseek_price(&brain.model).map(|p| (crate::price::charge_usd(p, resp.usage) * 1_000_000.).round() as i64);
        let usage = UsageTotals {
            input_tokens: resp.usage.input as i64,
            output_tokens: resp.usage.output as i64,
            cache_read_tokens: resp.usage.cache_read as i64,
            cost_micros: cost,
            ..Default::default()
        };
        let mut payload = transcript::model_payload(&resp.message);
        payload["generationTask"] = json!(tc.task.id);
        cp.step += 1;
        cp.usage.add(resp.usage);
        cp.last_output = resp.message.content.unwrap_or_default();
        cp.calls = resp.message.tool_calls;
        cp.index = 0;
        let next = if cp.calls.is_empty() { YIELD_CHECK } else { TOOL_TURN };
        self.store.write(|tx| {
            let mut task = running(tc, tx)?;
            tx.append_entry(conv, "pi.assistant", &payload)?;
            usage.record(tx, conv)?;
            checkpoint_transition(&mut task, tx, cp, next)
        })?;
        Ok(next_phase(cp, next))
    }

    fn tool_turn(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let tr = Transcript::load(&self.store, conv)?;
        let brain = self.brain(conv, &tr.provider_affinity)?;
        while let Some(call) = cp.calls.get(cp.index).cloned() {
            if tc.is_cancelled() {
                return Err(Error::Invalid("generation cancelled".into()));
            }
            let tool = brain.tools.iter().find(|t| t.spec().name == call.name);
            let mut output = None;
            if let Some(parked) = &cp.parked {
                match &tc.signal {
                    Some(signal) if signal.signal_name == governance::PERMISSION_SIGNAL => {
                        let decision: Decision = serde_json::from_value(signal.payload.clone())?;
                        if decision.tool_call_id != *parked {
                            return Ok(sleep(TOOL_TURN, cp, governance::PERMISSION_SIGNAL));
                        }
                        if decision.approved {
                            cp.approved = Some(parked.clone())
                        } else {
                            output = Some(ToolOutput::error(if decision.reason.is_empty() {
                                "permission denied by user".into()
                            } else {
                                decision.reason
                            }));
                        }
                        cp.parked = None;
                    }
                    _ => return Ok(sleep(TOOL_TURN, cp, governance::PERMISSION_SIGNAL)),
                }
            }
            let args = if call.arguments.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str::<Value>(&call.arguments)
            };
            let args = match args {
                Ok(args) => args,
                Err(e) => {
                    output = Some(ToolOutput::error(format!("invalid arguments: {e}")));
                    Value::Null
                }
            };
            let mut overridable = true;
            if cp.started.as_deref() == Some(&call.id) && !tool.is_some_and(|t| t.replay_safe()) {
                output = Some(ToolOutput::error("interrupted: check what the tool did before retrying"));
            }
            if output.is_none() && cp.approved.as_deref() != Some(&call.id) && cp.started.as_deref() != Some(&call.id) {
                let ev = governance::evaluate(
                    &self.permissions,
                    &*self.classifier,
                    &tr.entries,
                    &call.name,
                    &args,
                    tool.is_some_and(|t| t.is_mcp()),
                );
                match ev.verdict {
                    Verdict::Ask => cp.parked = Some(call.id.clone()),
                    Verdict::Deny => {
                        overridable = ev.client_overridable;
                        output = Some(ToolOutput::error(ev.reason.clone()))
                    }
                    Verdict::Allow => (),
                };
                self.store.write(|tx| {
                    let mut task = running(tc, tx)?;
                    governance::record_evaluation(tx, conv, &task.id, &call.id, &args, &ev)?;
                    if ev.verdict == Verdict::Ask {
                        task.checkpoint = json!(cp);
                        tx.update_task(&task)?;
                    }
                    Ok(())
                })?;
                if ev.verdict == Verdict::Ask {
                    return Ok(sleep(TOOL_TURN, cp, governance::PERMISSION_SIGNAL));
                }
            }
            let output = match output {
                Some(out) => out,
                None => {
                    cp.started = Some(call.id.clone());
                    tc.checkpoint(&json!(cp))?;
                    self.observe(
                        conv,
                        &tc.task.id,
                        BrainEvent::ToolStarted {
                            id: call.id.clone(),
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                        },
                    );
                    match tool {
                        Some(t) => t.execute_cancellable(&args, &tc.cancellation()),
                        None => ToolOutput::error(format!("unknown tool: {}", call.name)),
                    }
                }
            };
            cp.index += 1;
            cp.started = None;
            cp.approved = None;
            let mut payload = json!({"toolCallId":call.id,"toolName":call.name,"ok":!output.is_error});
            if output.is_error {
                payload["clientOverridable"] = json!(overridable);
                payload["error"] = json!(output.text);
            } else {
                payload["output"] = json!(output.text);
            }
            self.store.write(|tx| {
                let mut task = running(tc, tx)?;
                tx.append_entry(conv, "pi.tool_result", &payload)?;
                task.checkpoint = json!(cp);
                tx.update_task(&task)?;
                Ok(())
            })?;
            self.observe(conv, &tc.task.id, BrainEvent::ToolFinished { id: call.id, output });
        }
        cp.calls.clear();
        cp.index = 0;
        Ok(next_phase(cp, GENERATE))
    }
}

fn running(tc: &TaskContext, tx: &Tx<'_>) -> Result<Task> {
    let task = tx.task(&tc.task.id)?;
    if task.status != TaskStatus::Running || tc.is_cancelled() {
        return Err(Error::Invalid("phase no longer owns generation".into()));
    }
    Ok(task)
}
fn checkpoint_transition(task: &mut Task, tx: &mut Tx<'_>, cp: &Checkpoint, next: &str) -> Result<()> {
    let mut saved = cp.clone();
    saved.next_phase = Some(next.into());
    task.checkpoint = json!(saved);
    task.restart_count = 0;
    tx.update_task(task)?;
    Ok(())
}
fn next_phase(cp: &Checkpoint, phase: &str) -> Transition {
    Transition::Next {
        phase: phase.into(),
        checkpoint: Some(json!(cp)),
    }
}
fn sleep(phase: &str, cp: &Checkpoint, signal: &str) -> Transition {
    Transition::Sleep {
        phase: phase.into(),
        checkpoint: Some(json!(cp)),
        until_ms: None,
        signal: Some(signal.into()),
    }
}
