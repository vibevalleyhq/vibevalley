use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::core::extension::Extension;
use crate::core::pipeline::PromptSection;
use crate::core::tool::{ReplayPolicy, Tool, ToolContext, TypedTool, TypedToolAdapter, TypedToolOutput};
use vibevalley_oar::BoxFuture;

/// Where an agent's notes live. `read` never fails (an unreadable memory is
/// none); `remember` and `rewrite` report errors.
pub trait MemoryPort: Send + Sync {
    fn prompt(&self) -> String;
    fn remember<'a>(&'a self, note: &'a str) -> BoxFuture<'a, Result<(), String>>;
    /// Returns the new line count.
    fn rewrite<'a>(&'a self, content: &'a str) -> BoxFuture<'a, Result<usize, String>>;
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RememberArgs {
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RewriteMemoryArgs {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDetails {
    pub lines: Option<usize>,
}

pub struct Remember(pub Arc<dyn MemoryPort>);
pub struct RewriteMemory(pub Arc<dyn MemoryPort>);

impl TypedTool for Remember {
    type Args = RememberArgs;
    type Details = MemoryDetails;

    fn name(&self) -> &'static str {
        "remember"
    }

    fn description(&self) -> &'static str {
        "记下一条以后的对话也要知道的事：用户的偏好、约定、仓库的关键事实。一句话，不记临时的事。记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里。"
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            if ctx.cancel.is_cancelled() {
                return Err("aborted by the user".into());
            }
            if args.note.trim().is_empty() {
                return Err("note 是空的。".into());
            }
            self.0.remember(&args.note).await?;
            Ok(TypedToolOutput::ok_with("记下了。", MemoryDetails { lines: None }))
        })
    }
}

impl TypedTool for RewriteMemory {
    type Args = RewriteMemoryArgs;
    type Details = MemoryDetails;

    fn name(&self) -> &'static str {
        "rewrite_memory"
    }

    fn description(&self) -> &'static str {
        "整理你自己记下的内容：合并重复的、删掉过时或错的。先看系统提示里的「记性」，再给出完整的新内容，不改写用户交代的条目。"
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            if ctx.cancel.is_cancelled() {
                return Err("aborted by the user".into());
            }
            let n = self.0.rewrite(&args.content).await?;
            Ok(TypedToolOutput::ok_with(format!("重写好了，现在 {n} 行。"), MemoryDetails { lines: Some(n) }))
        })
    }
}

pub struct MemoryExtension {
    port: Arc<dyn MemoryPort>,
}

impl MemoryExtension {
    pub fn new(port: Arc<dyn MemoryPort>) -> Self {
        Self { port }
    }
}

impl Extension for MemoryExtension {
    fn name(&self) -> &str {
        "memory"
    }

    fn tools(&self) -> Vec<Box<dyn Tool>> {
        vec![
            Box::new(TypedToolAdapter(Remember(self.port.clone()))),
            Box::new(TypedToolAdapter(RewriteMemory(self.port.clone()))),
        ]
    }

    fn sections(&self) -> Vec<PromptSection> {
        let body = self.port.prompt();
        if body.trim().is_empty() {
            vec![]
        } else {
            vec![PromptSection::new("memory", format!("## 记性\n{body}"))]
        }
    }
}
