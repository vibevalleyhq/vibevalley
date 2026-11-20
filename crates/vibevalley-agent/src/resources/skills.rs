use std::collections::HashMap;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ToolSpec;
use crate::ai::CancelToken;
use crate::tools::{ReplayPolicy, Tool, ToolContext, ToolOutput, TypedTool, TypedToolOutput, typed_execute, typed_spec};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

pub fn default_skill_dirs(cwd: &Path) -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    vec![home.join(".agents/skills"), home.join(".claude/skills"), cwd.join(".agents/skills")]
}

/// YAML's simple `key: value` lines only (quotes and folded `>`/`|`).
pub fn front_matter(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return out;
    };
    let Some(end) = rest.find("\n---") else { return out };
    let lines: Vec<&str> = rest[..end].lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        if key.is_empty() || line.starts_with(char::is_whitespace) {
            continue;
        }
        let mut value = value.trim().to_string();
        if matches!(value.as_str(), ">" | "|" | ">-" | "|-") {
            let folded = value.starts_with('>');
            let mut block = vec![];
            while i < lines.len() && lines[i].starts_with(char::is_whitespace) && !lines[i].trim().is_empty() {
                block.push(lines[i].trim());
                i += 1;
            }
            value = block.join(if folded { " " } else { "\n" });
        }
        for q in ['"', '\''] {
            if value.len() >= 2 && value.starts_with(q) && value.ends_with(q) {
                value = value[1..value.len() - 1].to_string();
            }
        }
        out.insert(key.to_string(), value);
    }
    out
}

pub fn skill_body(text: &str) -> String {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return text.trim().into();
    };
    match rest.find("\n---") {
        Some(end) => rest[end + 4..].trim_start_matches(['\r', '\n']).trim().to_string(),
        None => text.trim().to_string(),
    }
}

/// The first of a name wins; unreadable folders and files are skipped.
pub fn scan_skills(dirs: &[PathBuf]) -> Vec<SkillInfo> {
    let mut found: Vec<SkillInfo> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut names: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        names.sort();
        for sub in names {
            let path = sub.join("SKILL.md");
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let fm = front_matter(&text);
            let folder = sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let name = fm.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or(folder);
            if found.iter().any(|s| s.name == name) {
                continue;
            }
            found.push(SkillInfo {
                name,
                description: fm.get("description").cloned().unwrap_or_default(),
                path,
            });
        }
    }
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    found
}

/// The "技能" section of a system prompt.
pub fn skill_index(skills: &[SkillInfo], max: usize) -> String {
    skills
        .iter()
        .map(|s| {
            let chars: Vec<char> = s.description.chars().collect();
            let d = if chars.len() > max {
                chars[..max].iter().collect::<String>() + "…"
            } else {
                s.description.clone()
            };
            format!("- {}：{d}", s.name)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn read_skill(skills: &[SkillInfo], name: &str) -> Result<String, String> {
    let Some(s) = skills.iter().find(|s| s.name == name) else {
        let known: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        let list = if known.is_empty() { "（没有）".to_string() } else { known.join("、") };
        return Err(format!("没有叫 {name} 的技能。有：{list}"));
    };
    let text = std::fs::read_to_string(&s.path).map_err(|_| format!("读不到 {}", s.path.display()))?;
    Ok(format!("# {}\n（来自 {}）\n\n{}", s.name, s.path.display(), skill_body(&text)))
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LoadSkillArgs {
    /// Name of the skill to load.
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadSkillDetails {
    pub name: String,
    pub path: String,
}

pub struct LoadSkill {
    pub skills: Box<dyn Fn() -> Vec<SkillInfo> + Send + Sync>,
}

impl TypedTool for LoadSkill {
    type Args = LoadSkillArgs;
    type Details = LoadSkillDetails;

    fn name(&self) -> &'static str {
        "load_skill"
    }

    fn description(&self) -> &'static str {
        "读一个技能的全文（系统提示里「技能」列着有哪些）。要用某个技能之前先读它，再照着做。"
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        if ctx.cancel.is_cancelled() {
            return Err("aborted by the user".into());
        }
        let skills = (self.skills)();
        let text = read_skill(&skills, &args.name)?;
        let path = skills
            .iter()
            .find(|s| s.name == args.name)
            .map(|s| s.path.display().to_string())
            .unwrap_or_default();
        Ok(TypedToolOutput::ok_with(text, LoadSkillDetails { name: args.name, path }))
    }
}

impl Tool for LoadSkill {
    fn spec(&self) -> ToolSpec {
        typed_spec(self)
    }

    fn replay_safe(&self) -> bool {
        <Self as TypedTool>::replay(self) == ReplayPolicy::Safe
    }

    fn execute(&self, args: &serde_json::Value) -> ToolOutput {
        self.execute_with_context(args, &ToolContext::background())
    }

    fn execute_cancellable(&self, args: &serde_json::Value, cancelled: &flume::Receiver<()>) -> ToolOutput {
        let ctx = ToolContext::with_cancel(CancelToken::from_receiver(cancelled.clone()));
        self.execute_with_context(args, &ctx)
    }

    fn execute_with_context(&self, args: &serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        typed_execute(self, args, ctx)
    }
}
