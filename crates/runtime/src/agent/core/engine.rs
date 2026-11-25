use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::BoxFuture;
use crate::agent::BrainError;
use crate::agent::ai::CancelToken;
use crate::agent::ai::types::{ChatRequest, Delta, ToolCall, ToolSpec, Usage};
use crate::agent::compaction::{Compactor, FileOps, Level};
use crate::agent::core::doc::{CONVERSATION_SCOPE, FileOpsDoc, StandInDoc, UsageTotals, read_doc, update_doc};
use crate::agent::core::events::{AgentEvent, Brain, TurnOutcome};
use crate::agent::core::extension::{CompactCtx, DurableHookCtx, ExtensionRunner, Rubric, RubricVerdict, RunEndCtx, ToolCallHookCtx};
use crate::agent::core::inbox::{self, WhenBusy};
use crate::agent::core::pipeline::{Transcript, convert_to_llm, model_payload, transform_context};
use crate::agent::core::tool::{Tool, ToolContext, ToolOutput};
use crate::agent::durable::{self, Error, Result, Scheduler, Store, Submission, SubmissionStatus, Task, TaskContext, TaskStatus, Transition, Tx, WaitMode};

pub const KIND: &str = "pi.generation";
pub const TOOL_KIND: &str = "pi.tool";
pub const TOOL_RUN: &str = "run";

pub const PHASE_PREPARE: &str = "prepare";
pub const PHASE_GENERATE: &str = "generate";
pub const PHASE_TOOL_DISPATCH: &str = "tool_dispatch";
pub const PHASE_TOOL_JOIN: &str = "tool_join";
pub const PHASE_YIELD_CHECK: &str = "yield_check";
pub const PHASE_FOLLOW_UP_CHECK: &str = "follow_up_check";

pub const ATTACHED_SIGNAL: &str = "runtime.attached";
const PERMISSION_SIGNAL: &str = "permission.decision";

/// Resolves the model client/tool configuration for a conversation and receives live events.
pub trait BrainProvider: Send + Sync {
    /// Returns `Ok(None)` if the target runtime is temporarily detached and should sleep on `ATTACHED_SIGNAL`.
    fn resolve_brain<'a>(&'a self, conversation: &'a str, provider: &'a str) -> BoxFuture<'a, Result<Option<Arc<Brain>>>>;
    fn observe(&self, _conversation: &str, _task: &str, _event: AgentEvent) {}
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
    pub owner_task: Option<&'a str>,
    pub when_busy: WhenBusy,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Checkpoint {
    prompt: String,
    submission: String,
    request_id: String,
    last_output: String,
    calls: Vec<ToolCall>,
    index: usize,
    batch_calls: Vec<String>,
    step: usize,
    usage: Usage,
    iteration: u32,
    rubric: Option<Rubric>,
    parked: Option<String>,
    park_signal: Option<String>,
    approved: Option<String>,
    pre_denied: BTreeMap<String, PreDenied>,
    follow_up_submissions: Vec<String>,
    final_result: Option<Value>,
    next_phase: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreDenied {
    reason: String,
    overridable: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolTaskCheckpoint {
    parent_task_id: String,
    step: usize,
    call: ToolCall,
    args: Value,
    prompt: String,
    submission_id: String,
    request_id: String,
    iteration: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolOutputRecord {
    call_id: String,
    tool_name: String,
    text: String,
    is_error: bool,
    overridable: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionDecisionPayload {
    tool_call_id: String,
    approved: bool,
    #[serde(default)]
    reason: String,
}

struct StandInStubTool(ToolSpec);

impl Tool for StandInStubTool {
    fn spec(&self) -> ToolSpec {
        self.0.clone()
    }

    fn execute<'a>(&'a self, _args: &'a Value) -> BoxFuture<'a, ToolOutput> {
        let name = self.0.name.clone();
        Box::pin(std::future::ready(ToolOutput::error(format!(
            "extension tool `{name}` is currently unavailable after restart; reattach its extension before calling it"
        ))))
    }
}

#[derive(Clone, Copy)]
enum GenPhase {
    Prepare,
    Generate,
    ToolDispatch,
    ToolJoin,
    YieldCheck,
    FollowUpCheck,
}

#[derive(Clone)]
pub struct Engine {
    store: Store,
    provider: Arc<dyn BrainProvider>,
    compactor: Arc<Mutex<Option<Compactor>>>,
    extensions: Arc<RwLock<ExtensionRunner>>,
    scheduler: Arc<Mutex<Option<Scheduler>>>,
}

impl Engine {
    pub fn new(store: Store, provider: Arc<dyn BrainProvider>) -> Self {
        Self {
            store,
            provider,
            compactor: Arc::new(Mutex::new(None)),
            extensions: Arc::new(RwLock::new(ExtensionRunner::default())),
            scheduler: Arc::new(Mutex::new(None)),
        }
    }

    pub fn with_compactor(self, compactor: Compactor) -> Self {
        *self.compactor.lock().unwrap() = Some(compactor);
        self
    }

    pub fn with_extensions(self, extensions: ExtensionRunner) -> Self {
        *self.extensions.write().unwrap() = extensions;
        self
    }

    pub fn set_compactor(&self, compactor: Compactor) {
        *self.compactor.lock().unwrap() = Some(compactor);
    }

    pub fn set_extensions(&self, extensions: ExtensionRunner) {
        *self.extensions.write().unwrap() = extensions;
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn scheduler(&self) -> Option<Scheduler> {
        self.scheduler.lock().unwrap().clone()
    }

    pub fn extensions_snapshot(&self) -> ExtensionRunner {
        self.extensions.read().unwrap().clone()
    }

    pub fn emit(&self, conversation: &str, task_id: &str, event: AgentEvent) {
        self.provider.observe(conversation, task_id, event);
    }

    async fn clear_attached_signals(&self, task_id: &str) -> Result<()> {
        let tid = task_id.to_owned();
        let has_pending = self
            .store
            .read_async(move |tx| Box::pin(async move { Ok(tx.signals_async(&tid, false).await?.iter().any(|s| s.signal_name == ATTACHED_SIGNAL)) }))
            .await?;
        if has_pending {
            let tid = task_id.to_owned();
            self.store
                .write_async(move |tx| {
                    Box::pin(async move {
                        while tx.consume_first_signal_async(&tid, ATTACHED_SIGNAL).await?.is_some() {}
                        Ok(())
                    })
                })
                .await?;
        }
        Ok(())
    }

    pub fn register(&self, s: &Scheduler) {
        *self.scheduler.lock().unwrap() = Some(s.clone());
        let code = self.clone();
        crate::agent::codemode::register_with(s, move |tc, name, args| {
            let code = code.clone();
            async move { code.run_codemode_tool(&tc, &name, args).await }
        });

        for (phase, kind) in [
            (PHASE_PREPARE, GenPhase::Prepare),
            (PHASE_GENERATE, GenPhase::Generate),
            (PHASE_TOOL_DISPATCH, GenPhase::ToolDispatch),
            (PHASE_TOOL_JOIN, GenPhase::ToolJoin),
            (PHASE_YIELD_CHECK, GenPhase::YieldCheck),
            (PHASE_FOLLOW_UP_CHECK, GenPhase::FollowUpCheck),
        ] {
            let engine = self.clone();
            s.register(KIND, phase, move |tc| {
                let engine = engine.clone();
                async move {
                    let mut cp: Checkpoint = serde_json::from_value(tc.task.checkpoint.clone())?;
                    // A journal transaction can commit before the scheduler records the phase transition.
                    if let Some(next) = cp.next_phase.take() {
                        return Ok(next_phase(&cp, &next));
                    }
                    let conv = tc.task.conversation_id.clone();
                    let conv_read = conv.clone();
                    let provider = engine
                        .store
                        .read_async(move |tx| Box::pin(async move { Ok(tx.conversation_async(&conv_read).await?.provider_affinity) }))
                        .await?;
                    if engine.provider.resolve_brain(&conv, &provider).await?.is_none() {
                        return Ok(sleep(phase, &cp, ATTACHED_SIGNAL, None));
                    }
                    if conv.starts_with("worker:") {
                        engine.clear_attached_signals(&tc.task.id).await?;
                    }
                    let result = match kind {
                        GenPhase::Prepare => engine.phase_prepare(&tc, &mut cp).await,
                        GenPhase::Generate => engine.phase_generate(&tc, &mut cp).await,
                        GenPhase::ToolDispatch => engine.phase_tool_dispatch(&tc, &mut cp).await,
                        GenPhase::ToolJoin => engine.phase_tool_join(&tc, &mut cp).await,
                        GenPhase::YieldCheck => engine.phase_yield_check(&tc, &mut cp).await,
                        GenPhase::FollowUpCheck => engine.phase_follow_up_check(&tc, &mut cp).await,
                    };
                    match result {
                        Err(e) if !tc.is_cancelled() => {
                            engine.settle_failed(&tc, &cp, &e).await;
                            Ok(Transition::Fail(e.to_string()))
                        }
                        other => other,
                    }
                }
            });
        }

        let tool_engine = self.clone();
        s.register(TOOL_KIND, TOOL_RUN, move |tc| {
            let tool_engine = tool_engine.clone();
            async move { tool_engine.phase_tool_run(&tc).await }
        });

        self.extensions_snapshot().register_phases(s, self);
    }

    pub async fn submit(&self, r: Request<'_>) -> Result<(Submission, Task, bool)> {
        self.submit_with(r, |_, _| Box::pin(std::future::ready(Ok(())))).await
    }

    pub async fn submit_with<F>(&self, r: Request<'_>, placed: F) -> Result<(Submission, Task, bool)>
    where
        F: for<'a, 'b> FnOnce(&'a mut Tx<'b>, &'a Task) -> BoxFuture<'a, Result<()>> + Send + 'static,
    {
        let started_ms = self.store.now_ms();
        let conversation = r.conversation.to_owned();
        let provider = r.provider.to_owned();
        let request_id = r.request_id.to_owned();
        let prompt = r.prompt.to_owned();
        let source = r.source.to_owned();
        let system = r.system.to_owned();
        let trusted_intent = r.trusted_intent.map(str::to_owned);
        let rubric = r.rubric;
        let notify_task = r.notify_task.map(str::to_owned);
        let owner_task = r.owner_task.map(str::to_owned);
        let when_busy = r.when_busy;

        let conv_write = conversation.clone();
        let req_write = request_id.clone();
        let out = self
            .store
            .write_async(move |tx| {
                Box::pin(async move {
                    match tx.conversation_async(&conv_write).await {
                        Err(Error::Missing(_)) => {
                            tx.create_owned_conversation_async(&conv_write, &provider, owner_task.as_deref().unwrap_or_default())
                                .await?;
                        }
                        Ok(_) => (),
                        Err(e) => return Err(e),
                    }
                    if let Some(existing) = tx.submission_by_request_async(&conv_write, &req_write).await? {
                        let task = find_generation_task_for_submission(tx, &conv_write, &existing).await?;
                        return Ok((existing, task, true));
                    }
                    let active = tx
                        .tasks_by_conversation_async(&conv_write)
                        .await?
                        .into_iter()
                        .find(|t| t.kind == KIND && t.status != TaskStatus::Terminal);
                    if let Some(active_task) = active {
                        let sub = match when_busy {
                            WhenBusy::Reject => {
                                return Err(Error::Invalid("conversation already has an active generation".into()));
                            }
                            WhenBusy::Steer => inbox::submit_steer(tx, &conv_write, &req_write, &prompt).await?.0,
                            WhenBusy::Queue => inbox::submit_follow_up(tx, &conv_write, &req_write, &prompt, notify_task.as_deref()).await?.0,
                        };
                        return Ok((sub, active_task, false));
                    }

                    let payload = json!({
                        "text": prompt,
                        "source": source,
                        "trustedIntent": trusted_intent,
                    });
                    let (sub, _) = inbox::submit_prompt(tx, &conv_write, &req_write, &payload, notify_task.as_deref()).await?;
                    let sub = tx.set_submission_status_async(&sub.id, SubmissionStatus::Placed).await?;

                    let mut t = Task::new(KIND, PHASE_PREPARE);
                    t.id = format!("gen-{}", sub.id);
                    t.is_model_task = true;
                    t.conversation_id = conv_write.clone();
                    t.owner_task_id = owner_task.unwrap_or_default();
                    t.checkpoint = json!(Checkpoint {
                        prompt,
                        submission: sub.id.clone(),
                        request_id: req_write,
                        rubric,
                        ..Default::default()
                    });

                    if !system.is_empty() {
                        let prior = tx.entries_async(&conv_write, 1).await?.into_iter().rev().find(|e| e.kind == "pi.system");
                        if !prior.as_ref().is_some_and(|e| e.payload["text"] == system) {
                            tx.append_entry_async(&conv_write, "pi.system", &json!({"text": system, "delta": prior.is_some()}))
                                .await?;
                        }
                    }
                    tx.append_entry_async(&conv_write, "pi.user", &sub.payload).await?;
                    let (task, _) = tx.create_task_async(t).await?;
                    placed(tx, &task).await?;
                    Ok((sub, task, false))
                })
            })
            .await?;

        let at_ms = self.store.now_ms();
        self.store.emit_telemetry(durable::TelemetryEvent::Submit {
            conversation_id: conversation.clone(),
            request_id,
            submission_id: out.0.id.clone(),
            status: out.0.status.as_str().into(),
            deduplicated: out.2,
            duration_ms: (at_ms - started_ms).max(0),
            at_ms,
        });
        if !out.2 && out.1.status != TaskStatus::Terminal && out.0.kind == inbox::KIND_PROMPT {
            self.emit(&conversation, &out.1.id, AgentEvent::AgentStart);
        }
        Ok(out)
    }

    async fn settle_failed(&self, tc: &TaskContext, cp: &Checkpoint, err: &Error) {
        let payload = json!({ "error": err.to_string() });
        let submission = cp.submission.clone();
        let follow_ups = cp.follow_up_submissions.clone();
        let _ = self
            .store
            .write_async(move |tx| {
                Box::pin(async move {
                    tx.settle_async(&submission, SubmissionStatus::Unanswered, &payload).await?;
                    for fid in &follow_ups {
                        tx.settle_async(fid, SubmissionStatus::Unanswered, &payload).await?;
                    }
                    Ok(())
                })
            })
            .await;
        let outcome = if err.to_string().contains("model step limit reached") {
            TurnOutcome::TooLong
        } else {
            TurnOutcome::Failed
        };
        self.emit(&tc.task.conversation_id, &tc.task.id, AgentEvent::Error { message: err.to_string() });
        self.emit(
            &tc.task.conversation_id,
            &tc.task.id,
            AgentEvent::AgentEnd {
                outcome,
                usage: cp.usage,
                text: cp.last_output.clone(),
            },
        );
    }

    async fn resolve_brain_required(&self, conv: &str, provider: &str) -> Result<Arc<Brain>> {
        self.provider
            .resolve_brain(conv, provider)
            .await?
            .ok_or_else(|| Error::Invalid("worker runtime is detached".into()))
    }

    fn make_hook_ctx<'a>(
        &'a self,
        tc: &'a TaskContext,
        cp: &'a Checkpoint,
        brain: Option<&'a Brain>,
        obs: &'a (dyn Fn(AgentEvent) + Send + Sync),
    ) -> DurableHookCtx<'a> {
        DurableHookCtx {
            store: &self.store,
            scheduler: None,
            tc,
            brain,
            conversation_id: &tc.task.conversation_id,
            task_id: &tc.task.id,
            step: cp.step,
            iteration: cp.iteration,
            prompt: &cp.prompt,
            last_output: &cp.last_output,
            submission_id: &cp.submission,
            request_id: &cp.request_id,
            cancel: CancelToken::from_tokio(tc.cancel_token()),
            rubric: cp.rubric.as_ref(),
            observer: obs,
        }
    }

    fn effective_compactor(&self, brain: &Brain) -> Compactor {
        if let Some(custom) = self.compactor.lock().unwrap().clone() {
            return custom;
        }
        Compactor::with_llm(self.store.clone(), brain.client.clone(), &brain.model)
    }

    async fn phase_prepare(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let conv_read = conv.clone();
        let provider = self
            .store
            .read_async(move |tx| Box::pin(async move { Ok(tx.conversation_async(&conv_read).await?.provider_affinity) }))
            .await?;
        let brain = self.resolve_brain_required(conv, &provider).await?;
        let runner = self.extensions_snapshot();
        let sched = self.scheduler();
        let obs = |ev: AgentEvent| self.emit(conv, &tc.task.id, ev);
        let mut ctx = self.make_hook_ctx(tc, cp, Some(&brain), &obs);
        ctx.scheduler = sched.as_ref();

        match runner.run_before_turn(&ctx).await? {
            crate::agent::core::extension::HookOutcome::Continue => {}
            crate::agent::core::extension::HookOutcome::Park { signal, until_ms } => {
                return Ok(sleep(PHASE_PREPARE, cp, &signal, until_ms));
            }
            crate::agent::core::extension::HookOutcome::Deny { reason, .. } => {
                return Err(Error::Invalid(reason));
            }
            crate::agent::core::extension::HookOutcome::Retry { .. } => {}
        }

        let compactor = self.effective_compactor(&brain);
        let conv_read = conv.clone();
        let (est_tokens, prev_compaction_seq) = self
            .store
            .read_async(move |tx| {
                Box::pin(async move {
                    let entries = tx.visible_entries_async(&conv_read).await?;
                    let last_seq = entries.iter().rev().find(|e| e.kind == "pi.compaction").map(|e| e.seq);
                    Ok((crate::agent::compaction::estimate_tokens(&entries), last_seq))
                })
            })
            .await?;

        let level = if est_tokens >= compactor.hard_tokens { Level::Hard } else { Level::Soft };
        let compact_ctx = CompactCtx {
            store: &self.store,
            conversation_id: conv,
            level,
            estimated_tokens: est_tokens,
        };
        match runner.run_before_compact(&compact_ctx).await? {
            crate::agent::core::extension::HookOutcome::Continue => {
                compactor.before_request(conv).await?;
                let conv_read = conv.clone();
                if let Some(entry) = self
                    .store
                    .read_async(move |tx| {
                        Box::pin(async move {
                            Ok(tx
                                .visible_entries_async(&conv_read)
                                .await?
                                .into_iter()
                                .rev()
                                .find(|e| e.kind == "pi.compaction" && Some(e.seq) != prev_compaction_seq))
                        })
                    })
                    .await?
                {
                    let lvl = entry.payload["level"].as_str().unwrap_or("soft").to_owned();
                    let summary = entry.payload["summary"].as_str().unwrap_or_default().to_owned();
                    self.emit(conv, &tc.task.id, AgentEvent::Compacted { level: lvl, summary });
                }
            }
            crate::agent::core::extension::HookOutcome::Park { signal, until_ms } => {
                return Ok(sleep(PHASE_PREPARE, cp, &signal, until_ms));
            }
            crate::agent::core::extension::HookOutcome::Deny { .. } => {}
            crate::agent::core::extension::HookOutcome::Retry { .. } => {}
        }

        Ok(next_phase(cp, PHASE_GENERATE))
    }

    async fn phase_generate(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let tr = Transcript::load(&self.store, conv).await?;
        let brain = self.resolve_brain_required(conv, &tr.provider_affinity).await?;
        if cp.step >= brain.max_steps {
            return Err(Error::Invalid("model step limit reached".into()));
        }

        self.emit(conv, &tc.task.id, AgentEvent::TurnStart { step: cp.step + 1 });

        let runner = self.extensions_snapshot();
        let sched = self.scheduler();
        let obs = |ev: AgentEvent| self.emit(conv, &tc.task.id, ev);
        let mut hook_ctx = self.make_hook_ctx(tc, cp, Some(&brain), &obs);
        hook_ctx.scheduler = sched.as_ref();

        let messages = convert_to_llm(transform_context(tr.agent_messages(), &runner, &hook_ctx).await?);
        let tools = self.collect_tool_specs(conv, &brain, &runner).await?;

        let mut req = ChatRequest {
            model: brain.model.clone(),
            messages,
            tools,
            effort: brain.effort.clone(),
            ..Default::default()
        };

        let cancel = CancelToken::from_tokio(tc.cancel_token());
        let mut stream_delta = |delta: Delta| match delta {
            Delta::Text(text) => self.emit(conv, &tc.task.id, AgentEvent::TextDelta { delta: text }),
            Delta::Reasoning(r) => self.emit(conv, &tc.task.id, AgentEvent::ReasoningDelta { delta: r }),
        };

        let resp = match brain.client.complete_cancellable(&req, &cancel, &mut stream_delta).await {
            Err(BrainError::ContextOverflow(_)) => {
                let compactor = self.effective_compactor(&brain);
                if let Some(entry) = compactor.compact(conv, Level::Overflow, None).await? {
                    let summary = entry.payload["summary"].as_str().unwrap_or_default().to_owned();
                    self.emit(
                        conv,
                        &tc.task.id,
                        AgentEvent::Compacted {
                            level: "overflow".into(),
                            summary,
                        },
                    );
                }
                let tr2 = Transcript::load(&self.store, conv).await?;
                req.messages = convert_to_llm(transform_context(tr2.agent_messages(), &runner, &hook_ctx).await?);
                brain.client.complete_cancellable(&req, &cancel, &mut stream_delta).await
            }
            other => other,
        }
        .map_err(|e| Error::Invalid(e.to_string()))?;

        let usage_totals = UsageTotals::from_usage(&brain.model, resp.usage);
        let mut payload = model_payload(&resp.message);
        payload["generationTask"] = json!(tc.task.id);

        cp.step += 1;
        cp.usage.add(resp.usage);
        cp.last_output = resp.message.content.clone().unwrap_or_default();
        cp.calls = resp.message.tool_calls;
        cp.index = 0;
        cp.batch_calls.clear();
        cp.parked = None;
        cp.park_signal = None;
        cp.approved = None;
        cp.pre_denied.clear();

        let next = if cp.calls.is_empty() { PHASE_YIELD_CHECK } else { PHASE_TOOL_DISPATCH };
        let tc_write = tc.clone();
        let conv_write = conv.clone();
        let cp_write = cp.clone();
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut task = running(&tc_write, tx).await?;
                    tx.append_entry_async(&conv_write, "pi.assistant", &payload).await?;
                    usage_totals.record(tx, &conv_write).await?;
                    checkpoint_transition(&mut task, tx, &cp_write, next).await
                })
            })
            .await?;
        self.emit(
            conv,
            &tc.task.id,
            AgentEvent::TurnEnd {
                step: cp.step,
                usage: resp.usage,
            },
        );
        Ok(next_phase(cp, next))
    }

    async fn collect_tool_specs(&self, conv: &str, brain: &Brain, runner: &ExtensionRunner) -> Result<Vec<ToolSpec>> {
        let mut specs = Vec::new();
        let mut seen = HashSet::new();
        for t in &brain.tools {
            let spec = t.spec();
            if seen.insert(spec.name.clone()) {
                specs.push(spec);
            }
        }
        for t in runner.tools() {
            let spec = t.spec();
            if seen.insert(spec.name.clone()) {
                specs.push(spec);
            }
        }
        let conv_read = conv.to_owned();
        let standin = self
            .store
            .read_async(move |tx| Box::pin(async move { read_doc::<StandInDoc>(tx, CONVERSATION_SCOPE, &conv_read).await }))
            .await?;
        for spec in standin.tool_specs {
            if seen.insert(spec.name.clone()) {
                specs.push(spec);
            }
        }
        Ok(specs)
    }

    async fn resolve_tool<'a>(&self, conv: &str, brain: &'a Brain, ext_tools: &'a [Box<dyn Tool>], name: &str) -> Result<Option<ResolvedTool<'a>>> {
        if let Some(t) = brain.tools.iter().find(|t| t.spec().name == name) {
            return Ok(Some(ResolvedTool::Borrowed(t.as_ref())));
        }
        if let Some(t) = ext_tools.iter().find(|t| t.spec().name == name) {
            return Ok(Some(ResolvedTool::Borrowed(t.as_ref())));
        }
        let conv_read = conv.to_owned();
        let standin = self
            .store
            .read_async(move |tx| Box::pin(async move { read_doc::<StandInDoc>(tx, CONVERSATION_SCOPE, &conv_read).await }))
            .await?;
        if let Some(spec) = standin.tool_specs.into_iter().find(|s| s.name == name) {
            return Ok(Some(ResolvedTool::Owned(Box::new(StandInStubTool(spec)))));
        }
        Ok(None)
    }

    async fn phase_tool_dispatch(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let tr = Transcript::load(&self.store, conv).await?;
        let brain = self.resolve_brain_required(conv, &tr.provider_affinity).await?;
        let runner = self.extensions_snapshot();
        let ext_tools = runner.tools();
        let sched = self.scheduler();
        let obs = |ev: AgentEvent| self.emit(conv, &tc.task.id, ev);

        while let Some(call) = cp.calls.get(cp.index).cloned() {
            if tc.is_cancelled() {
                return Err(Error::Invalid("generation cancelled".into()));
            }

            if let Some(denied) = cp.pre_denied.remove(&call.id) {
                self.record_denied_tool(tc, cp, &call, &denied.reason, denied.overridable).await?;
                continue;
            }

            if let Some(parked_id) = cp.parked.clone() {
                let signal_name = cp.park_signal.clone().unwrap_or_else(|| PERMISSION_SIGNAL.into());
                match &tc.signal {
                    Some(sig) if sig.signal_name == PERMISSION_SIGNAL => {
                        let decision: PermissionDecisionPayload = serde_json::from_value(sig.payload.clone())?;
                        if decision.tool_call_id != parked_id {
                            return Ok(sleep(PHASE_TOOL_DISPATCH, cp, &signal_name, None));
                        }
                        cp.parked = None;
                        cp.park_signal = None;
                        if decision.approved {
                            cp.approved = Some(parked_id);
                        } else {
                            let reason = if decision.reason.is_empty() {
                                "permission denied by user".to_owned()
                            } else {
                                decision.reason
                            };
                            self.record_denied_tool(tc, cp, &call, &reason, true).await?;
                            continue;
                        }
                    }
                    Some(sig) if sig.signal_name == signal_name => {
                        cp.parked = None;
                        cp.park_signal = None;
                    }
                    _ => return Ok(sleep(PHASE_TOOL_DISPATCH, cp, &signal_name, None)),
                }
            }

            let args = match parse_call_args(&call.arguments) {
                Ok(v) => v,
                Err(e) => {
                    self.record_denied_tool(tc, cp, &call, &format!("invalid arguments: {e}"), false).await?;
                    continue;
                }
            };

            let resolved = self.resolve_tool(conv, &brain, &ext_tools, &call.name).await?;
            let is_mcp = resolved.as_ref().is_some_and(|t| t.as_tool().is_mcp());

            if cp.approved.as_deref() != Some(&call.id) {
                let mut hook_ctx = self.make_hook_ctx(tc, cp, Some(&brain), &obs);
                hook_ctx.scheduler = sched.as_ref();
                let tool_ctx = ToolCallHookCtx {
                    hook: hook_ctx,
                    tool_call_id: &call.id,
                    tool_name: &call.name,
                    args: &args,
                    is_mcp,
                    entries: &tr.entries,
                    output: None,
                };
                match runner.run_before_tool(&tool_ctx).await? {
                    crate::agent::core::extension::HookOutcome::Continue => {}
                    crate::agent::core::extension::HookOutcome::Park { signal, until_ms } => {
                        cp.parked = Some(call.id.clone());
                        cp.park_signal = Some(signal.clone());
                        tc.checkpoint(&json!(cp)).await?;
                        return Ok(sleep(PHASE_TOOL_DISPATCH, cp, &signal, until_ms));
                    }
                    crate::agent::core::extension::HookOutcome::Deny { reason, overridable } => {
                        self.record_denied_tool(tc, cp, &call, &reason, overridable).await?;
                        continue;
                    }
                    crate::agent::core::extension::HookOutcome::Retry { .. } => {}
                }
            }
            cp.approved = None;

            let mut batch: Vec<(ToolCall, Value)> = vec![(call.clone(), args)];
            let first_safe = resolved.as_ref().is_some_and(|t| t.as_tool().replay_safe());
            if first_safe {
                for next_call in cp.calls.iter().skip(cp.index + 1) {
                    let next_tool = self.resolve_tool(conv, &brain, &ext_tools, &next_call.name).await?;
                    if !next_tool.as_ref().is_some_and(|t| t.as_tool().replay_safe()) {
                        break;
                    }
                    let Ok(next_args) = parse_call_args(&next_call.arguments) else {
                        break;
                    };
                    let mut next_hook_ctx = self.make_hook_ctx(tc, cp, Some(&brain), &obs);
                    next_hook_ctx.scheduler = sched.as_ref();
                    let next_tool_ctx = ToolCallHookCtx {
                        hook: next_hook_ctx,
                        tool_call_id: &next_call.id,
                        tool_name: &next_call.name,
                        args: &next_args,
                        is_mcp: next_tool.as_ref().is_some_and(|t| t.as_tool().is_mcp()),
                        entries: &tr.entries,
                        output: None,
                    };
                    match runner.run_before_tool(&next_tool_ctx).await? {
                        crate::agent::core::extension::HookOutcome::Continue => {
                            batch.push((next_call.clone(), next_args));
                        }
                        crate::agent::core::extension::HookOutcome::Park { signal, .. } => {
                            // Wait for already-approved prefix batch; resume directly into Park without re-evaluating.
                            cp.parked = Some(next_call.id.clone());
                            cp.park_signal = Some(signal);
                            break;
                        }
                        crate::agent::core::extension::HookOutcome::Deny { reason, overridable } => {
                            cp.pre_denied.insert(next_call.id.clone(), PreDenied { reason, overridable });
                            break;
                        }
                        crate::agent::core::extension::HookOutcome::Retry { .. } => break,
                    }
                }
            }

            let mut child_ids = Vec::with_capacity(batch.len());
            for (c, a) in batch {
                let dedup = format!("{}:s{}:c{}", tc.task.id, cp.step, c.id);
                let mut child = Task::new(TOOL_KIND, TOOL_RUN);
                child.dedup_key = dedup;
                child.checkpoint = json!(ToolTaskCheckpoint {
                    parent_task_id: tc.task.id.clone(),
                    step: cp.step,
                    call: c,
                    args: a,
                    prompt: cp.prompt.clone(),
                    submission_id: cp.submission.clone(),
                    request_id: cp.request_id.clone(),
                    iteration: cp.iteration,
                });
                let (spawned, _) = tc.spawn_child(child).await?;
                child_ids.push(spawned.id);
            }
            cp.batch_calls = child_ids.clone();
            return Ok(Transition::Wait {
                phase: PHASE_TOOL_JOIN.into(),
                checkpoint: Some(json!(cp)),
                mode: WaitMode::AllSettled,
                children: child_ids,
            });
        }

        cp.calls.clear();
        cp.index = 0;
        cp.batch_calls.clear();
        Ok(next_phase(cp, PHASE_PREPARE))
    }

    async fn record_denied_tool(&self, tc: &TaskContext, cp: &mut Checkpoint, call: &ToolCall, reason: &str, overridable: bool) -> Result<()> {
        let conv = &tc.task.conversation_id;
        cp.index += 1;
        let payload = json!({
            "toolCallId": call.id,
            "toolName": call.name,
            "ok": false,
            "clientOverridable": overridable,
            "error": reason,
        });
        let tc_write = tc.clone();
        let conv_write = conv.clone();
        let cp_json = json!(cp);
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut task = running(&tc_write, tx).await?;
                    tx.append_entry_async(&conv_write, "pi.tool_result", &payload).await?;
                    task.checkpoint = cp_json;
                    tx.update_task_async(&task).await?;
                    Ok(())
                })
            })
            .await?;
        self.emit(
            conv,
            &tc.task.id,
            AgentEvent::ToolEnd {
                id: call.id.clone(),
                name: call.name.clone(),
                output: ToolOutput::error(reason),
            },
        );
        Ok(())
    }

    async fn phase_tool_run(&self, tc: &TaskContext) -> Result<Transition> {
        let t_cp: ToolTaskCheckpoint = serde_json::from_value(tc.task.checkpoint.clone())?;
        let conv = &tc.task.conversation_id;
        let conv_read = conv.clone();
        let provider = self
            .store
            .read_async(move |tx| Box::pin(async move { Ok(tx.conversation_async(&conv_read).await?.provider_affinity) }))
            .await?;
        let Some(brain) = self.provider.resolve_brain(conv, &provider).await? else {
            return Ok(Transition::Sleep {
                phase: TOOL_RUN.into(),
                checkpoint: None,
                until_ms: None,
                signal: Some(ATTACHED_SIGNAL.into()),
            });
        };
        if conv.starts_with("worker:") {
            self.clear_attached_signals(&tc.task.id).await?;
        }

        if let Some(saved) = tc.task.memo.get("output") {
            return Ok(Transition::Complete(saved.clone()));
        }

        let runner = self.extensions_snapshot();
        if let Some(res) = runner.dispatch_tool(&t_cp.call, tc, self).await {
            return res;
        }

        let ext_tools = runner.tools();
        let resolved = self.resolve_tool(conv, &brain, &ext_tools, &t_cp.call.name).await?;
        let replay_safe = resolved.as_ref().is_some_and(|t| t.as_tool().replay_safe());

        if tc.task.memo.get("started").and_then(Value::as_bool) == Some(true) && !replay_safe {
            let mut msg = "interrupted: tool execution started before crash; inspect workspace before retrying".to_owned();
            if let Some(status) = git_status_summary(brain.cwd.as_deref()).await {
                msg.push_str("\nworkspace git status:\n");
                msg.push_str(&status);
            }
            let record = ToolOutputRecord {
                call_id: t_cp.call.id.clone(),
                tool_name: t_cp.call.name.clone(),
                text: msg,
                is_error: true,
                overridable: false,
            };
            let val = json!(record);
            let val_memo = val.clone();
            tc.memo("output", || async move { Ok(val_memo) }).await?;
            return Ok(Transition::Complete(val));
        }

        tc.memo("started", || async { Ok(json!(true)) }).await?;
        self.emit(
            conv,
            &tc.task.id,
            AgentEvent::ToolStart {
                id: t_cp.call.id.clone(),
                name: t_cp.call.name.clone(),
                arguments: t_cp.call.arguments.clone(),
            },
        );

        let engine_ref = self.clone();
        let conv_owned = conv.clone();
        let parent_task = t_cp.parent_task_id.clone();
        let call_id = t_cp.call.id.clone();
        let call_name = t_cp.call.name.clone();
        let on_update = Arc::new(move |upd: crate::agent::core::tool::ToolUpdate| {
            engine_ref.emit(
                &conv_owned,
                &parent_task,
                AgentEvent::ToolUpdate {
                    id: call_id.clone(),
                    name: call_name.clone(),
                    text: upd.text,
                },
            );
        });

        let tool_ctx = ToolContext {
            cancel: CancelToken::from_tokio(tc.cancel_token()),
            on_update: Some(on_update),
            conversation_id: conv.clone(),
            task_id: tc.task.id.clone(),
            store: Some(self.store.clone()),
            scheduler: self.scheduler(),
        };

        let out = match resolved {
            Some(t) => t.as_tool().execute_with_context(&t_cp.args, &tool_ctx).await,
            None => ToolOutput::error(format!("unknown tool: {}", t_cp.call.name)),
        };

        let record = ToolOutputRecord {
            call_id: t_cp.call.id,
            tool_name: t_cp.call.name,
            text: out.text,
            is_error: out.is_error,
            overridable: true,
        };
        let val = json!(record);
        let val_memo = val.clone();
        tc.memo("output", || async move { Ok(val_memo) }).await?;
        Ok(Transition::Complete(val))
    }

    async fn phase_tool_join(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let tr = Transcript::load(&self.store, conv).await?;
        let brain = self.resolve_brain_required(conv, &tr.provider_affinity).await?;
        let runner = self.extensions_snapshot();
        let ext_tools = runner.tools();
        let sched = self.scheduler();
        let obs = |ev: AgentEvent| self.emit(conv, &tc.task.id, ev);

        let batch_len = cp.batch_calls.len();
        let mut records: Vec<(ToolCall, Value, ToolOutputRecord)> = Vec::with_capacity(batch_len);

        for (offset, child_id) in cp.batch_calls.iter().enumerate() {
            let call = cp
                .calls
                .get(cp.index + offset)
                .cloned()
                .ok_or_else(|| Error::Invalid("tool_join batch index out of bounds".into()))?;
            let args = parse_call_args(&call.arguments).unwrap_or(Value::Null);
            let child = if let Some(c) = tc.children.iter().find(|c| c.id == *child_id) {
                c.clone()
            } else {
                let cid = child_id.clone();
                self.store.read_async(move |r| Box::pin(async move { r.task_async(&cid).await })).await?
            };

            let rec = if child.terminal_reason == "completed" {
                if let Ok(parsed) = serde_json::from_value::<ToolOutputRecord>(child.result.clone()) {
                    parsed
                } else {
                    ToolOutputRecord {
                        call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        text: child.result.as_str().map(str::to_owned).unwrap_or_else(|| child.result.to_string()),
                        is_error: false,
                        overridable: true,
                    }
                }
            } else {
                let err = if child.error_text.is_empty() {
                    format!("tool task failed ({})", child.terminal_reason)
                } else {
                    child.error_text.clone()
                };
                ToolOutputRecord {
                    call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    text: err,
                    is_error: true,
                    overridable: false,
                }
            };

            let out = ToolOutput {
                text: rec.text.clone(),
                is_error: rec.is_error,
            };
            let is_mcp = self
                .resolve_tool(conv, &brain, &ext_tools, &call.name)
                .await?
                .is_some_and(|t| t.as_tool().is_mcp());
            let mut hook_ctx = self.make_hook_ctx(tc, cp, Some(&brain), &obs);
            hook_ctx.scheduler = sched.as_ref();
            let after_ctx = ToolCallHookCtx {
                hook: hook_ctx,
                tool_call_id: &call.id,
                tool_name: &call.name,
                args: &args,
                is_mcp,
                entries: &tr.entries,
                output: Some(&out),
            };
            let _ = runner.run_after_tool(&after_ctx).await?;
            self.emit(
                conv,
                &tc.task.id,
                AgentEvent::ToolEnd {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    output: out,
                },
            );
            records.push((call, args, rec));
        }

        let tc_write = tc.clone();
        let conv_write = conv.clone();
        let mut cp_write = cp.clone();
        let (next, updated_cp) = self
            .store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut task = running(&tc_write, tx).await?;
                    for (call, args, rec) in &records {
                        let mut payload = json!({
                            "toolCallId": rec.call_id,
                            "toolName": rec.tool_name,
                            "ok": !rec.is_error,
                        });
                        if rec.is_error {
                            payload["clientOverridable"] = json!(rec.overridable);
                            payload["error"] = json!(rec.text);
                        } else {
                            payload["output"] = json!(rec.text);
                        }
                        tx.append_entry_async(&conv_write, "pi.tool_result", &payload).await?;
                        if !rec.is_error {
                            update_doc::<FileOpsDoc>(tx, CONVERSATION_SCOPE, &conv_write, |ops| {
                                record_tool_file_op(ops, &call.name, args);
                                Ok(())
                            })
                            .await?;
                        }
                    }

                    cp_write.index += batch_len;
                    cp_write.batch_calls.clear();

                    let steers = inbox::take_pending_steers(tx, &conv_write).await?;
                    let next_p = if !steers.is_empty() {
                        for skipped in cp_write.calls.iter().skip(cp_write.index) {
                            tx.append_entry_async(
                                &conv_write,
                                "pi.tool_result",
                                &json!({
                                    "toolCallId": skipped.id,
                                    "toolName": skipped.name,
                                    "ok": false,
                                    "error": "skipped due to user steering",
                                }),
                            )
                            .await?;
                        }
                        for steer in steers {
                            tx.append_entry_async(&conv_write, "pi.user", &steer.payload).await?;
                            tx.settle_async(&steer.id, SubmissionStatus::Done, &json!({ "steered": true })).await?;
                        }
                        cp_write.calls.clear();
                        cp_write.index = 0;
                        cp_write.parked = None;
                        cp_write.park_signal = None;
                        cp_write.approved = None;
                        cp_write.pre_denied.clear();
                        PHASE_PREPARE
                    } else if cp_write.index < cp_write.calls.len() {
                        PHASE_TOOL_DISPATCH
                    } else {
                        cp_write.calls.clear();
                        cp_write.index = 0;
                        PHASE_PREPARE
                    };

                    checkpoint_transition(&mut task, tx, &cp_write, next_p).await?;
                    Ok((next_p, cp_write))
                })
            })
            .await?;
        *cp = updated_cp;

        Ok(next_phase(cp, next))
    }

    async fn phase_yield_check(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        if let Some(done) = tc.task.memo.get("yielded") {
            return Ok(Transition::Complete(done.clone()));
        }
        let conv_read = conv.clone();
        let provider = self
            .store
            .read_async(move |tx| Box::pin(async move { Ok(tx.conversation_async(&conv_read).await?.provider_affinity) }))
            .await?;
        let brain = self.resolve_brain_required(conv, &provider).await?;
        let runner = self.extensions_snapshot();
        let sched = self.scheduler();
        let obs = |ev: AgentEvent| self.emit(conv, &tc.task.id, ev);
        let mut hook_ctx = self.make_hook_ctx(tc, cp, Some(&brain), &obs);
        hook_ctx.scheduler = sched.as_ref();

        let mut verdict: Option<RubricVerdict> = None;
        let mut max_iterations_reached = false;
        let mut run_end_ctx = RunEndCtx {
            hook: hook_ctx,
            usage: cp.usage,
            verdict: &mut verdict,
            max_iterations_reached: &mut max_iterations_reached,
        };

        match runner.run_after_run(&mut run_end_ctx).await? {
            crate::agent::core::extension::HookOutcome::Park { signal, until_ms } => {
                return Ok(sleep(PHASE_YIELD_CHECK, cp, &signal, until_ms));
            }
            crate::agent::core::extension::HookOutcome::Retry { feedback_entry } => {
                cp.iteration += 1;
                let tc_write = tc.clone();
                let conv_write = conv.clone();
                let cp_write = cp.clone();
                self.store
                    .write_async(move |tx| {
                        Box::pin(async move {
                            let mut task = running(&tc_write, tx).await?;
                            tx.append_entry_async(&conv_write, "pi.user", &feedback_entry).await?;
                            checkpoint_transition(&mut task, tx, &cp_write, PHASE_PREPARE).await
                        })
                    })
                    .await?;
                return Ok(next_phase(cp, PHASE_PREPARE));
            }
            crate::agent::core::extension::HookOutcome::Deny { reason, .. } => {
                return Err(Error::Invalid(reason));
            }
            crate::agent::core::extension::HookOutcome::Continue => {}
        }

        if verdict.is_some() {
            cp.iteration += 1;
        }
        let mut result = json!({
            "output": cp.last_output,
            "iterations": cp.iteration,
            "usage": cp.usage,
        });
        if let Some(v) = verdict {
            result["rubricVerdict"] = json!(v);
            result["maxIterationsReached"] = json!(max_iterations_reached);
        }
        cp.final_result = Some(result);
        let tc_write = tc.clone();
        let cp_write = cp.clone();
        self.store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut task = running(&tc_write, tx).await?;
                    checkpoint_transition(&mut task, tx, &cp_write, PHASE_FOLLOW_UP_CHECK).await
                })
            })
            .await?;
        Ok(next_phase(cp, PHASE_FOLLOW_UP_CHECK))
    }

    async fn phase_follow_up_check(&self, tc: &TaskContext, cp: &mut Checkpoint) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        if let Some(done) = tc.task.memo.get("yielded") {
            return Ok(Transition::Complete(done.clone()));
        }
        let result = cp.final_result.clone().unwrap_or_else(|| {
            json!({
                "output": cp.last_output,
                "iterations": cp.iteration,
                "usage": cp.usage,
            })
        });

        let tc_write = tc.clone();
        let conv_write = conv.clone();
        let mut cp_write = cp.clone();
        let res_write = result.clone();
        let (follow_up_next, updated_cp) = self
            .store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut task = running(&tc_write, tx).await?;
                    let follow_ups = inbox::take_pending_follow_ups(tx, &conv_write).await?;
                    if !follow_ups.is_empty() {
                        for fu in follow_ups {
                            tx.append_entry_async(&conv_write, "pi.user", &fu.payload).await?;
                            cp_write.follow_up_submissions.push(fu.id);
                        }
                        cp_write.final_result = None;
                        checkpoint_transition(&mut task, tx, &cp_write, PHASE_PREPARE).await?;
                        return Ok((true, cp_write));
                    }
                    tx.settle_async(&cp_write.submission, SubmissionStatus::Done, &res_write).await?;
                    for fid in &cp_write.follow_up_submissions {
                        tx.settle_async(fid, SubmissionStatus::Done, &res_write).await?;
                    }
                    task.memo["yielded"] = res_write;
                    tx.update_task_async(&task).await?;
                    Ok((false, cp_write))
                })
            })
            .await?;
        *cp = updated_cp;

        if follow_up_next {
            return Ok(next_phase(cp, PHASE_PREPARE));
        }

        self.emit(
            conv,
            &tc.task.id,
            AgentEvent::AgentEnd {
                outcome: TurnOutcome::Completed,
                usage: cp.usage,
                text: cp.last_output.clone(),
            },
        );
        Ok(Transition::Complete(result))
    }

    pub fn check_dispatched_memo(&self, tc: &TaskContext) -> Option<Result<Transition>> {
        if tc.task.phase_name == crate::agent::codemode::RUN {
            if let Some(out) = tc.task.memo.get("toolOutput") {
                return Some(if let Some(error) = out["error"].as_str() {
                    Err(Error::Invalid(error.into()))
                } else {
                    Ok(Transition::Complete(out["value"].clone()))
                });
            }
            return None;
        }
        tc.task.memo.get("output").cloned().map(|saved| Ok(Transition::Complete(saved)))
    }

    pub async fn complete_dispatched_tool(&self, tc: &TaskContext, call: &ToolCall, text: String, is_error: bool) -> Result<Transition> {
        if tc.task.phase_name == crate::agent::codemode::RUN {
            let decoded = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));
            let cache = if is_error { json!({ "error": text }) } else { json!({ "value": decoded }) };
            tc.memo("toolOutput", || async move { Ok(cache) }).await?;
            return if is_error {
                Err(Error::Invalid(text))
            } else {
                Ok(Transition::Complete(decoded))
            };
        }
        let record = json!({
            "callId": call.id,
            "toolName": call.name,
            "text": text,
            "isError": is_error,
            "overridable": false,
        });
        let record_memo = record.clone();
        tc.memo("output", || async move { Ok(record_memo) }).await?;
        Ok(Transition::Complete(record))
    }

    /// Executes one JS-originated `call(name, args)` inside `pi.codemode.tool`
    /// through the shared governance, budget, extension dispatch, and Effect Sandwich pipeline.
    pub async fn run_codemode_tool(&self, tc: &TaskContext, name: &str, args: Value) -> Result<Transition> {
        let conv = &tc.task.conversation_id;
        let park = |signal: &str, until_ms: Option<i64>| Transition::Sleep {
            phase: crate::agent::codemode::RUN.into(),
            checkpoint: None,
            until_ms,
            signal: Some(signal.into()),
        };

        let conv_read = conv.clone();
        let provider = self
            .store
            .read_async(move |tx| Box::pin(async move { Ok(tx.conversation_async(&conv_read).await?.provider_affinity) }))
            .await?;
        let Some(brain) = self.provider.resolve_brain(conv, &provider).await? else {
            return Ok(park(ATTACHED_SIGNAL, None));
        };
        if conv.starts_with("worker:") {
            self.clear_attached_signals(&tc.task.id).await?;
        }

        if let Some(res) = self.check_dispatched_memo(tc) {
            return res;
        }

        let synthetic_call = ToolCall {
            id: tc.task.id.clone(),
            name: name.to_owned(),
            arguments: args.to_string(),
        };
        let runner = self.extensions_snapshot();
        let ext_tools = runner.tools();
        let tool = self.resolve_tool(conv, &brain, &ext_tools, name).await?;

        let cp = Checkpoint::default();
        let sched = self.scheduler();
        let obs = |ev: AgentEvent| self.emit(conv, &tc.task.id, ev);

        if tc.task.memo["approved"] != true && tc.task.memo["toolStarted"] != true {
            let mut turn_ctx = self.make_hook_ctx(tc, &cp, Some(&brain), &obs);
            turn_ctx.scheduler = sched.as_ref();
            match runner.run_before_turn(&turn_ctx).await? {
                crate::agent::core::extension::HookOutcome::Continue => {}
                crate::agent::core::extension::HookOutcome::Park { signal, until_ms } => {
                    return Ok(park(&signal, until_ms));
                }
                crate::agent::core::extension::HookOutcome::Deny { reason, .. } => {
                    return Err(Error::Invalid(reason));
                }
                crate::agent::core::extension::HookOutcome::Retry { .. } => {}
            }

            if tc.task.checkpoint["parked"] == true {
                if let Some(signal) = &tc.signal
                    && signal.signal_name == PERMISSION_SIGNAL
                {
                    let decision: PermissionDecisionPayload = serde_json::from_value(signal.payload.clone())?;
                    if decision.tool_call_id != tc.task.id {
                        return Ok(park(PERMISSION_SIGNAL, None));
                    }
                    if !decision.approved {
                        return Err(Error::Invalid(if decision.reason.is_empty() {
                            "permission denied".into()
                        } else {
                            decision.reason
                        }));
                    }
                    tc.memo("approved", || async { Ok(json!(true)) }).await?;
                } else {
                    return Ok(park(PERMISSION_SIGNAL, None));
                }
            } else {
                let tr = Transcript::load(&self.store, conv).await?;
                let mut hook_ctx = self.make_hook_ctx(tc, &cp, Some(&brain), &obs);
                hook_ctx.scheduler = sched.as_ref();
                let call_ctx = ToolCallHookCtx {
                    hook: hook_ctx,
                    tool_call_id: &tc.task.id,
                    tool_name: name,
                    args: &args,
                    is_mcp: tool.as_ref().is_some_and(|t| t.as_tool().is_mcp()),
                    entries: &tr.entries,
                    output: None,
                };
                match runner.run_before_tool(&call_ctx).await? {
                    crate::agent::core::extension::HookOutcome::Continue => {
                        tc.memo("approved", || async { Ok(json!(true)) }).await?;
                    }
                    crate::agent::core::extension::HookOutcome::Deny { reason, .. } => return Err(Error::Invalid(reason)),
                    crate::agent::core::extension::HookOutcome::Park { signal, until_ms } => {
                        let tc_write = tc.clone();
                        self.store
                            .write_async(move |tx| {
                                Box::pin(async move {
                                    let mut t = running(&tc_write, tx).await?;
                                    t.checkpoint["parked"] = json!(true);
                                    tx.update_task_async(&t).await?;
                                    Ok(())
                                })
                            })
                            .await?;
                        return Ok(park(&signal, until_ms));
                    }
                    crate::agent::core::extension::HookOutcome::Retry { .. } => {}
                }
            }
        }

        if let Some(res) = runner.dispatch_tool(&synthetic_call, tc, self).await {
            return res;
        }

        let tool = tool.ok_or_else(|| Error::Invalid(format!("unknown tool: {name}")))?;

        if tc.task.memo["toolStarted"] == true && !tool.as_tool().replay_safe() {
            let mut msg = "tool execution interrupted; inspect workspace before retrying".to_owned();
            if let Some(status) = git_status_summary(brain.cwd.as_deref()).await {
                msg.push_str("\nworkspace git status:\n");
                msg.push_str(&status);
            }
            return Err(Error::Invalid(msg));
        }

        tc.memo("toolStarted", || async { Ok(json!(true)) }).await?;
        let conv_owned = conv.clone();
        let task_owned = tc.task.id.clone();
        let name_owned = name.to_owned();
        let engine_ref = self.clone();
        let tool_ctx = ToolContext {
            cancel: CancelToken::from_tokio(tc.cancel_token()),
            on_update: Some(Arc::new(move |upd: crate::agent::core::tool::ToolUpdate| {
                engine_ref.emit(
                    &conv_owned,
                    &task_owned,
                    AgentEvent::ToolUpdate {
                        id: task_owned.clone(),
                        name: name_owned.clone(),
                        text: upd.text,
                    },
                );
            })),
            conversation_id: conv.clone(),
            task_id: tc.task.id.clone(),
            store: Some(self.store.clone()),
            scheduler: self.scheduler(),
        };

        let out = tool.as_tool().execute_with_context(&args, &tool_ctx).await;
        let decoded = serde_json::from_str(&out.text).unwrap_or_else(|_| Value::String(out.text.clone()));
        let memo_val = if out.is_error {
            json!({ "error": out.text })
        } else {
            json!({ "value": decoded })
        };
        tc.memo("toolOutput", || async move { Ok(memo_val) }).await?;
        if out.is_error {
            Err(Error::Invalid(out.text))
        } else {
            Ok(Transition::Complete(decoded))
        }
    }
}

async fn find_generation_task_for_submission(tx: &durable::Read<'_>, conv: &str, sub: &Submission) -> Result<Task> {
    let direct_id = format!("gen-{}", sub.id);
    if let Ok(task) = tx.task_async(&direct_id).await {
        return Ok(task);
    }
    tx.tasks_by_conversation_async(conv)
        .await?
        .into_iter()
        .filter(|t| t.kind == KIND)
        .max_by_key(|t| t.created_at_ms)
        .ok_or_else(|| Error::Missing(direct_id))
}

enum ResolvedTool<'a> {
    Borrowed(&'a dyn Tool),
    Owned(Box<dyn Tool>),
}

impl<'a> ResolvedTool<'a> {
    fn as_tool(&self) -> &dyn Tool {
        match self {
            Self::Borrowed(t) => *t,
            Self::Owned(t) => t.as_ref(),
        }
    }
}

fn parse_call_args(raw: &str) -> std::result::Result<Value, serde_json::Error> {
    if raw.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str(raw) }
}

fn record_tool_file_op(ops: &mut FileOps, tool_name: &str, args: &Value) {
    let Some(path) = args.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()) else {
        return;
    };
    match tool_name {
        "read" | "grep" | "find" => {
            ops.read.insert(path.to_owned());
        }
        "write" | "edit" => {
            ops.modified.insert(path.to_owned());
        }
        _ => {}
    }
}

pub async fn git_status_summary(cwd: Option<&Path>) -> Option<String> {
    let dir = cwd?;
    let repo = vibevalley_git::Repo::discover_async(dir).await.ok().flatten()?;
    let output = repo.run_async(&["status", "--short"]).await.ok()?;
    if !output.ok() {
        return None;
    }
    let raw = output.text();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lines: Vec<&str> = trimmed.lines().take(20).collect();
    let total = trimmed.lines().count();
    let mut out = lines.join("\n");
    if total > 20 {
        out.push_str(&format!("\n... ({} more entries)", total - 20));
    }
    Some(out)
}

async fn running(tc: &TaskContext, tx: &Tx<'_>) -> Result<Task> {
    let task = tx.task_async(&tc.task.id).await?;
    if task.status != TaskStatus::Running || tc.is_cancelled() {
        return Err(Error::Invalid("phase no longer owns generation".into()));
    }
    Ok(task)
}

async fn checkpoint_transition(task: &mut Task, tx: &mut Tx<'_>, cp: &Checkpoint, next: &str) -> Result<()> {
    let mut saved = cp.clone();
    saved.next_phase = Some(next.into());
    task.checkpoint = json!(saved);
    task.restart_count = 0;
    let task_id = task.id.clone();
    let phase = task.phase_name.clone();
    let at_ms = tx.now_ms;
    tx.update_task_async(task).await?;
    tx.record_telemetry(durable::TelemetryEvent::Checkpoint { task_id, phase, at_ms });
    Ok(())
}

fn next_phase(cp: &Checkpoint, phase: &str) -> Transition {
    Transition::Next {
        phase: phase.into(),
        checkpoint: Some(json!(cp)),
    }
}

fn sleep(phase: &str, cp: &Checkpoint, signal: &str, until_ms: Option<i64>) -> Transition {
    Transition::Sleep {
        phase: phase.into(),
        checkpoint: Some(json!(cp)),
        until_ms,
        signal: Some(signal.into()),
    }
}
