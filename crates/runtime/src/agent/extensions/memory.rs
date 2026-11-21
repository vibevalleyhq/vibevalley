use std::path::PathBuf;
use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::core::extension::Extension;
use crate::agent::core::pipeline::PromptSection;
use crate::agent::core::tool::{ReplayPolicy, Tool, ToolContext, TypedTool, TypedToolAdapter, TypedToolOutput};

/// Cut from the top when the prompt carries it: the newest notes matter most.
const MEMORY_PROMPT_CHARS: usize = 8_000;

/// Where an agent's notes live. `read` never fails (an unreadable memory is
/// none); `remember` and `rewrite` report errors.
pub trait MemoryPort: Send + Sync {
    fn prompt(&self) -> String;
    fn remember(&self, note: &str) -> Result<(), String>;
    /// Returns the new line count.
    fn rewrite(&self, content: &str) -> Result<usize, String>;
}

/// `MEMORY.md` in a home directory: `- YYYY-MM-DD note` lines.
pub struct FileMemory {
    pub home: PathBuf,
}

impl FileMemory {
    fn file(&self) -> PathBuf {
        self.home.join("MEMORY.md")
    }
}

impl MemoryPort for FileMemory {
    fn prompt(&self) -> String {
        let text = std::fs::read_to_string(self.file()).unwrap_or_default();
        let text = text.trim();
        let chars: Vec<char> = text.chars().collect();
        if chars.len() <= MEMORY_PROMPT_CHARS {
            return text.to_string();
        }
        let tail: String = chars[chars.len() - MEMORY_PROMPT_CHARS..].iter().collect();
        format!("（更早的记录省略了，全文在 {}）\n{tail}", self.file().display())
    }

    fn remember(&self, note: &str) -> Result<(), String> {
        use std::io::Write;
        std::fs::create_dir_all(&self.home).map_err(|e| e.to_string())?;
        let cleaned = note.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file())
            .map_err(|e| e.to_string())?;
        writeln!(f, "- {} {cleaned}", local_date()).map_err(|e| e.to_string())
    }

    fn rewrite(&self, content: &str) -> Result<usize, String> {
        std::fs::create_dir_all(&self.home).map_err(|e| e.to_string())?;
        let body = if content.ends_with('\n') {
            content.to_string()
        } else {
            format!("{content}\n")
        };
        std::fs::write(self.file(), &body).map_err(|e| e.to_string())?;
        let trimmed = body.trim();
        Ok(if trimmed.is_empty() { 0 } else { trimmed.lines().count() })
    }
}

/// YYYY-MM-DD in this machine's time zone.
fn local_date() -> String {
    let out = std::process::Command::new("date").arg("+%Y-%m-%d").output();
    out.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| s.len() == 10)
        .unwrap_or_else(|| {
            let days = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() / 86_400)
                .unwrap_or(0) as i64;
            civil_date(days)
        })
}

/// Days since 1970-01-01 to YYYY-MM-DD (UTC fallback).
fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
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

    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        if ctx.cancel.is_cancelled() {
            return Err("aborted by the user".into());
        }
        if args.note.trim().is_empty() {
            return Err("note 是空的。".into());
        }
        self.0.remember(&args.note)?;
        Ok(TypedToolOutput::ok_with("记下了。", MemoryDetails { lines: None }))
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

    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        if ctx.cancel.is_cancelled() {
            return Err("aborted by the user".into());
        }
        let n = self.0.rewrite(&args.content)?;
        Ok(TypedToolOutput::ok_with(format!("重写好了，现在 {n} 行。"), MemoryDetails { lines: Some(n) }))
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
