use std::ops::Deref;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::BoxFuture;
use crate::agent::ai::CancelToken;
use crate::agent::ai::types::{ToolCall, Usage};
use crate::agent::compaction::Level;
use crate::agent::core::doc::{CONVERSATION_SCOPE, DocSpec, read_doc, update_doc};
use crate::agent::core::engine::Engine;
use crate::agent::core::events::{AgentEvent, AgentMessage, Brain};
use crate::agent::core::pipeline::PromptSection;
use crate::agent::core::tool::{Tool, ToolOutput};
use crate::agent::durable::{self, Document, Entry, Scheduler, Store, TaskContext, Transition};

#[derive(Debug, Clone, PartialEq)]
pub enum HookOutcome {
    Continue,
    Park { signal: String, until_ms: Option<i64> },
    Deny { reason: String, overridable: bool },
    Retry { feedback_entry: Value },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rubric {
    pub markdown: String,
    pub max_iterations: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RubricVerdict {
    pub satisfied: bool,
    pub summary: String,
    pub unmet_items: Vec<String>,
    pub iteration: u32,
}

#[derive(Debug, Clone)]
pub struct ReviewRequest<'a> {
    pub conversation: &'a str,
    pub request_id: &'a str,
    pub prompt: &'a str,
    pub candidate: &'a str,
    pub rubric: Option<&'a Rubric>,
}

#[derive(Debug, Clone)]
pub struct OutcomeReview {
    pub task_prompt: String,
    pub rubric: Rubric,
    pub deliverables: String,
    pub evidence_truncated: bool,
}

impl ReviewRequest<'_> {
    pub fn explicit(&self) -> Option<OutcomeReview> {
        self.rubric.filter(|r| !r.markdown.trim().is_empty()).map(|rubric| OutcomeReview {
            task_prompt: self.prompt.to_owned(),
            rubric: rubric.clone(),
            deliverables: String::new(),
            evidence_truncated: false,
        })
    }
}

pub struct DurableHookCtx<'a> {
    pub store: &'a Store,
    pub scheduler: Option<&'a Scheduler>,
    pub tc: &'a TaskContext,
    pub brain: Option<&'a Brain>,
    pub conversation_id: &'a str,
    pub task_id: &'a str,
    pub step: usize,
    pub iteration: u32,
    pub prompt: &'a str,
    pub last_output: &'a str,
    pub submission_id: &'a str,
    pub request_id: &'a str,
    pub cancel: CancelToken,
    pub rubric: Option<&'a Rubric>,
    pub(crate) observer: &'a (dyn Fn(AgentEvent) + Send + Sync),
}

impl<'a> DurableHookCtx<'a> {
    pub fn emit(&self, event: AgentEvent) {
        (self.observer)(event);
    }

    pub async fn read_doc<D: DocSpec>(&self) -> durable::Result<D::State> {
        self.read_doc_on::<D>(CONVERSATION_SCOPE, self.conversation_id).await
    }

    pub async fn read_doc_on<D: DocSpec>(&self, scope: &str, scope_id: &str) -> durable::Result<D::State> {
        let scope = scope.to_owned();
        let scope_id = scope_id.to_owned();
        self.store
            .read_async(move |tx| Box::pin(async move { read_doc::<D>(tx, &scope, &scope_id).await }))
            .await
    }

    pub async fn write_doc<D: DocSpec>(&self, state: &D::State) -> durable::Result<Document> {
        let conv = self.conversation_id.to_owned();
        let value = serde_json::to_value(state)?;
        self.store
            .write_async(move |tx| Box::pin(async move { tx.put_document_async(CONVERSATION_SCOPE, &conv, D::KIND, &value).await }))
            .await
    }

    pub async fn update_doc<D: DocSpec>(&self, f: impl FnOnce(&mut D::State) -> durable::Result<()> + Send + 'static) -> durable::Result<D::State> {
        let conv = self.conversation_id.to_owned();
        self.store
            .write_async(move |tx| Box::pin(async move { update_doc::<D>(tx, CONVERSATION_SCOPE, &conv, f).await }))
            .await
    }
}

pub struct ToolCallHookCtx<'a> {
    pub hook: DurableHookCtx<'a>,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub args: &'a Value,
    pub is_mcp: bool,
    pub entries: &'a [Entry],
    pub output: Option<&'a ToolOutput>,
}

impl<'a> Deref for ToolCallHookCtx<'a> {
    type Target = DurableHookCtx<'a>;

    fn deref(&self) -> &Self::Target {
        &self.hook
    }
}

pub struct CompactCtx<'a> {
    pub store: &'a Store,
    pub conversation_id: &'a str,
    pub level: Level,
    pub estimated_tokens: usize,
}

pub struct RunEndCtx<'a> {
    pub hook: DurableHookCtx<'a>,
    pub usage: Usage,
    pub verdict: &'a mut Option<RubricVerdict>,
    pub max_iterations_reached: &'a mut bool,
}

impl<'a> Deref for RunEndCtx<'a> {
    type Target = DurableHookCtx<'a>;

    fn deref(&self) -> &Self::Target {
        &self.hook
    }
}

pub trait Extension: Send + Sync {
    fn name(&self) -> &str;

    fn tools(&self) -> Vec<Box<dyn Tool>> {
        Vec::new()
    }

    fn sections(&self) -> Vec<PromptSection> {
        Vec::new()
    }

    fn register_phases(&self, _scheduler: &Scheduler, _engine: &Engine) {}

    fn dispatch_tool<'a>(&'a self, _call: &'a ToolCall, _tc: &'a TaskContext, _engine: &'a Engine) -> BoxFuture<'a, Option<durable::Result<Transition>>> {
        Box::pin(std::future::ready(None))
    }

    fn on_before_turn<'a>(&'a self, _ctx: &'a DurableHookCtx<'_>) -> BoxFuture<'a, durable::Result<HookOutcome>> {
        Box::pin(std::future::ready(Ok(HookOutcome::Continue)))
    }

    fn on_context<'a>(&'a self, _ctx: &'a DurableHookCtx<'_>, _messages: &'a mut Vec<AgentMessage>) -> BoxFuture<'a, durable::Result<()>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn on_before_tool<'a>(&'a self, _ctx: &'a ToolCallHookCtx<'_>) -> BoxFuture<'a, durable::Result<HookOutcome>> {
        Box::pin(std::future::ready(Ok(HookOutcome::Continue)))
    }

    fn on_after_tool<'a>(&'a self, _ctx: &'a ToolCallHookCtx<'_>) -> BoxFuture<'a, durable::Result<HookOutcome>> {
        Box::pin(std::future::ready(Ok(HookOutcome::Continue)))
    }

    fn on_before_compact<'a>(&'a self, _ctx: &'a CompactCtx<'_>) -> BoxFuture<'a, durable::Result<HookOutcome>> {
        Box::pin(std::future::ready(Ok(HookOutcome::Continue)))
    }

    fn on_after_run<'a>(&'a self, _ctx: &'a mut RunEndCtx<'_>) -> BoxFuture<'a, durable::Result<HookOutcome>> {
        Box::pin(std::future::ready(Ok(HookOutcome::Continue)))
    }

    fn on_task_aborted(&self, _task_ids: &[String]) {}
}

#[derive(Clone, Default)]
pub struct ExtensionRunner {
    extensions: Vec<Arc<dyn Extension>>,
}

impl ExtensionRunner {
    pub fn new(extensions: Vec<Arc<dyn Extension>>) -> Self {
        Self { extensions }
    }

    pub fn push(&mut self, ext: Arc<dyn Extension>) {
        self.extensions.push(ext);
    }

    pub fn extensions(&self) -> &[Arc<dyn Extension>] {
        &self.extensions
    }

    pub fn tools(&self) -> Vec<Box<dyn Tool>> {
        let mut out = Vec::new();
        for ext in &self.extensions {
            out.extend(ext.tools());
        }
        out
    }

    pub fn sections(&self) -> Vec<PromptSection> {
        let mut out = Vec::new();
        for ext in &self.extensions {
            out.extend(ext.sections());
        }
        out
    }

    pub fn register_phases(&self, scheduler: &Scheduler, engine: &Engine) {
        for ext in &self.extensions {
            ext.register_phases(scheduler, engine);
        }
    }

    pub fn notify_task_aborted(&self, task_ids: &[String]) {
        if task_ids.is_empty() {
            return;
        }
        for ext in &self.extensions {
            ext.on_task_aborted(task_ids);
        }
    }

    pub async fn dispatch_tool(&self, call: &ToolCall, tc: &TaskContext, engine: &Engine) -> Option<durable::Result<Transition>> {
        for ext in &self.extensions {
            if let Some(res) = ext.dispatch_tool(call, tc, engine).await {
                return Some(res);
            }
        }
        None
    }

    pub async fn run_before_turn(&self, ctx: &DurableHookCtx<'_>) -> durable::Result<HookOutcome> {
        for ext in &self.extensions {
            let outcome = ext.on_before_turn(ctx).await?;
            if outcome != HookOutcome::Continue {
                return Ok(outcome);
            }
        }
        Ok(HookOutcome::Continue)
    }

    pub async fn run_context(&self, ctx: &DurableHookCtx<'_>, messages: &mut Vec<AgentMessage>) -> durable::Result<()> {
        for ext in &self.extensions {
            ext.on_context(ctx, messages).await?;
        }
        Ok(())
    }

    pub async fn run_before_tool(&self, ctx: &ToolCallHookCtx<'_>) -> durable::Result<HookOutcome> {
        for ext in &self.extensions {
            let outcome = ext.on_before_tool(ctx).await?;
            if outcome != HookOutcome::Continue {
                return Ok(outcome);
            }
        }
        Ok(HookOutcome::Continue)
    }

    pub async fn run_after_tool(&self, ctx: &ToolCallHookCtx<'_>) -> durable::Result<HookOutcome> {
        for ext in &self.extensions {
            let outcome = ext.on_after_tool(ctx).await?;
            if outcome != HookOutcome::Continue {
                return Ok(outcome);
            }
        }
        Ok(HookOutcome::Continue)
    }

    pub async fn run_before_compact(&self, ctx: &CompactCtx<'_>) -> durable::Result<HookOutcome> {
        for ext in &self.extensions {
            let outcome = ext.on_before_compact(ctx).await?;
            if outcome != HookOutcome::Continue {
                return Ok(outcome);
            }
        }
        Ok(HookOutcome::Continue)
    }

    pub async fn run_after_run(&self, ctx: &mut RunEndCtx<'_>) -> durable::Result<HookOutcome> {
        for ext in &self.extensions {
            let outcome = ext.on_after_run(ctx).await?;
            if outcome != HookOutcome::Continue {
                return Ok(outcome);
            }
        }
        Ok(HookOutcome::Continue)
    }
}
