use std::sync::Arc;

use serde_json::Value;

use crate::agent::ai::CancelToken;
use crate::agent::ai::types::ToolSpec;
use crate::agent::durable::{Scheduler, Store};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayPolicy {
    Safe,
    Unsafe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolUpdate {
    pub text: String,
}

#[derive(Clone)]
pub struct ToolContext {
    pub cancel: CancelToken,
    pub on_update: Option<Arc<dyn Fn(ToolUpdate) + Send + Sync>>,
    pub conversation_id: String,
    pub task_id: String,
    pub store: Option<Store>,
    pub scheduler: Option<Scheduler>,
}

impl std::fmt::Debug for ToolContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolContext")
            .field("cancel", &self.cancel.is_cancelled())
            .field("has_on_update", &self.on_update.is_some())
            .field("conversation_id", &self.conversation_id)
            .field("task_id", &self.task_id)
            .field("has_store", &self.store.is_some())
            .field("has_scheduler", &self.scheduler.is_some())
            .finish()
    }
}

impl Default for ToolContext {
    fn default() -> Self {
        Self::background()
    }
}

impl ToolContext {
    pub fn background() -> Self {
        Self {
            cancel: CancelToken::never(),
            on_update: None,
            conversation_id: String::new(),
            task_id: String::new(),
            store: None,
            scheduler: None,
        }
    }

    pub fn with_cancel(cancel: CancelToken) -> Self {
        Self { cancel, ..Self::background() }
    }

    pub fn emit_update(&self, text: impl Into<String>) {
        if let Some(cb) = &self.on_update {
            cb(ToolUpdate { text: text.into() });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedToolOutput<D = Value> {
    pub text: String,
    pub details: Option<D>,
    pub is_error: bool,
}

impl<D> TypedToolOutput<D> {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            details: None,
            is_error: false,
        }
    }

    pub fn ok_with(text: impl Into<String>, details: D) -> Self {
        Self {
            text: text.into(),
            details: Some(details),
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            details: None,
            is_error: true,
        }
    }
}

pub trait TypedTool: Send + Sync {
    type Args: serde::de::DeserializeOwned + schemars::JsonSchema;
    type Details: serde::Serialize;

    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }
    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String>;
}

pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn is_mcp(&self) -> bool {
        false
    }
    /// Safe to run again if the process died while it ran (reads only).
    fn replay_safe(&self) -> bool {
        false
    }
    fn execute(&self, args: &Value) -> ToolOutput;
    fn execute_cancellable(&self, args: &Value, cancelled: &flume::Receiver<()>) -> ToolOutput {
        if cancelled.is_disconnected() {
            ToolOutput::error("aborted by the user")
        } else {
            self.execute(args)
        }
    }
    fn execute_with_context(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        if ctx.cancel.is_cancelled() {
            return ToolOutput::error("aborted by the user");
        }
        match ctx.cancel.receiver() {
            Some(rx) => self.execute_cancellable(args, rx),
            None => self.execute(args),
        }
    }
}

pub struct TypedToolAdapter<T>(pub T);

pub fn typed_spec<T: TypedTool>(tool: &T) -> ToolSpec {
    ToolSpec {
        name: tool.name().to_string(),
        description: tool.description().to_string(),
        parameters: schemars::schema_for!(T::Args).to_value(),
    }
}

pub fn typed_execute<T: TypedTool>(tool: &T, args: &Value, ctx: &ToolContext) -> ToolOutput {
    if ctx.cancel.is_cancelled() {
        return ToolOutput::error("aborted by the user");
    }
    let parsed: T::Args = match serde_json::from_value(args.clone()) {
        Ok(parsed) => parsed,
        Err(err) => {
            return ToolOutput::error(format!("invalid arguments for `{}`: {err}", tool.name()));
        }
    };
    match tool.execute(parsed, ctx) {
        Ok(out) => ToolOutput {
            text: out.text,
            is_error: out.is_error,
        },
        Err(err) => ToolOutput::error(err),
    }
}

impl<T: TypedTool> Tool for TypedToolAdapter<T> {
    fn spec(&self) -> ToolSpec {
        typed_spec(&self.0)
    }

    fn replay_safe(&self) -> bool {
        self.0.replay() == ReplayPolicy::Safe
    }

    fn execute(&self, args: &Value) -> ToolOutput {
        self.execute_with_context(args, &ToolContext::background())
    }

    fn execute_cancellable(&self, args: &Value, cancelled: &flume::Receiver<()>) -> ToolOutput {
        let ctx = ToolContext::with_cancel(CancelToken::from_receiver(cancelled.clone()));
        self.execute_with_context(args, &ctx)
    }

    fn execute_with_context(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        typed_execute(&self.0, args, ctx)
    }
}
