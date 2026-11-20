//! What every VibeValley agent carries on itself: skills, memory, and its own task graph.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::model::ToolSpec;
use crate::tool::{Tool, ToolOutput};

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

fn spec(name: &str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters,
    }
}

fn string_arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, ToolOutput> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolOutput::error(format!("缺少参数 {name}")))
}

pub struct LoadSkill {
    pub skills: Box<dyn Fn() -> Vec<SkillInfo> + Send + Sync>,
}

impl Tool for LoadSkill {
    fn spec(&self) -> ToolSpec {
        spec(
            "load_skill",
            "读一个技能的全文（系统提示里「技能」列着有哪些）。要用某个技能之前先读它，再照着做。",
            json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}),
        )
    }
    fn replay_safe(&self) -> bool {
        true
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let name = match string_arg(args, "name") {
            Ok(n) => n,
            Err(e) => return e,
        };
        match read_skill(&(self.skills)(), name) {
            Ok(text) => ToolOutput::ok(text),
            Err(e) => ToolOutput::error(e),
        }
    }
}

pub struct Remember(pub Arc<dyn MemoryPort>);
pub struct RewriteMemory(pub Arc<dyn MemoryPort>);

impl Tool for Remember {
    fn spec(&self) -> ToolSpec {
        spec(
            "remember",
            "记下一条以后的对话也要知道的事：用户的偏好、约定、仓库的关键事实。一句话，不记临时的事。记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里。",
            json!({"type": "object", "properties": {"note": {"type": "string"}}, "required": ["note"]}),
        )
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let note = match string_arg(args, "note") {
            Ok(n) => n,
            Err(e) => return e,
        };
        if note.trim().is_empty() {
            return ToolOutput::error("note 是空的。");
        }
        match self.0.remember(note) {
            Ok(()) => ToolOutput::ok("记下了。"),
            Err(e) => ToolOutput::error(e),
        }
    }
}

impl Tool for RewriteMemory {
    fn spec(&self) -> ToolSpec {
        spec(
            "rewrite_memory",
            "整理你自己记下的内容：合并重复的、删掉过时或错的。先看系统提示里的「记性」，再给出完整的新内容，不改写用户交代的条目。",
            json!({"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]}),
        )
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let content = match string_arg(args, "content") {
            Ok(c) => c,
            Err(e) => return e,
        };
        match self.0.rewrite(content) {
            Ok(n) => ToolOutput::ok(format!("重写好了，现在 {n} 行。")),
            Err(e) => ToolOutput::error(e),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoState {
    Waiting,
    Working,
    Done,
    Failed,
    Skipped,
}

impl TodoState {
    fn word(self) -> &'static str {
        match self {
            TodoState::Waiting => "还没做",
            TodoState::Working => "在做",
            TodoState::Done => "做完了",
            TodoState::Failed => "没做成",
            TodoState::Skipped => "跳过了",
        }
    }
    fn settled(self) -> bool {
        matches!(self, TodoState::Done | TodoState::Skipped)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub brief: String,
    pub after: Vec<String>,
    pub state: TodoState,
    pub result: Option<String>,
    pub tries: u32,
}

/// A graph past this is a repo, not one piece of work: it belongs in issues.
const MAX_TODOS: usize = 30;

fn id_valid(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && id.len() <= 32 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Duplicates, self-waits and missing ids first; a circle only when the
/// edges are otherwise sound.
fn edge_problems(g: &[Todo]) -> Vec<String> {
    let mut problems = vec![];
    let mut ids = HashSet::new();
    for t in g {
        if !ids.insert(t.id.as_str()) {
            problems.push(format!("id「{}」重复了", t.id));
        }
    }
    for t in g {
        for x in &t.after {
            if *x == t.id {
                problems.push(format!("「{}」不能等自己", t.id));
            } else if !ids.contains(x.as_str()) {
                problems.push(format!("「{}」要等的「{x}」不存在", t.id));
            }
        }
    }
    if !problems.is_empty() {
        return problems;
    }
    // Kahn: what never becomes free sits in a circle.
    let mut laid: HashSet<&str> = HashSet::new();
    loop {
        let before = laid.len();
        for t in g {
            if !laid.contains(t.id.as_str()) && t.after.iter().all(|x| laid.contains(x.as_str())) {
                laid.insert(t.id.as_str());
            }
        }
        if laid.len() == before {
            break;
        }
    }
    let circle: Vec<&str> = g.iter().map(|t| t.id.as_str()).filter(|id| !laid.contains(id)).collect();
    if !circle.is_empty() {
        problems.push(format!("这几件互相等，成了一个圈：{}", circle.join("、")));
    }
    problems
}

fn ready(g: &[Todo], t: &Todo) -> bool {
    t.state == TodoState::Waiting && t.after.iter().all(|x| g.iter().any(|d| d.id == *x && d.state.settled()))
}

pub fn todo_text(g: &[Todo]) -> String {
    if g.is_empty() {
        return "现在没有任务。".into();
    }
    let ready_count = g.iter().filter(|t| ready(g, t)).count();
    let mut lines = vec![format!("任务（{} 件，{ready_count} 件可以做）：", g.len())];
    for t in g {
        let mark = if t.state == TodoState::Waiting {
            if ready(g, t) { "可以做" } else { "等着" }
        } else {
            t.state.word()
        };
        let mut line = format!("- [{mark}] {} {}", t.id, t.title);
        if !t.after.is_empty() && !t.state.settled() {
            line.push_str(&format!("（等 {}）", t.after.join("、")));
        }
        if let Some(r) = &t.result {
            let flat: String = r.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
            line.push_str(&format!(" → {flat}"));
        }
        lines.push(line);
    }
    lines.join("\n")
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NewTodo {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub brief: String,
    #[serde(default)]
    pub after: Vec<String>,
}

/// Adds all or none; the problems say why.
pub fn todo_add(g: &[Todo], more: &[NewTodo]) -> (Vec<Todo>, Vec<String>) {
    let mut problems = vec![];
    if more.is_empty() {
        problems.push("一件任务都没有".to_string());
    }
    let mut next = g.to_vec();
    for t in more {
        let id = t.id.trim().to_string();
        let brief = t.brief.trim().to_string();
        if !id_valid(&id) {
            problems.push(format!("「{id}」不能当 id：用简短的英文，比如 read、fix-auth"));
        }
        if brief.is_empty() {
            problems.push(format!("「{id}」没有写要做什么（brief）"));
        }
        let title = if t.title.trim().is_empty() {
            brief.chars().take(20).collect()
        } else {
            t.title.trim().to_string()
        };
        next.push(Todo {
            id,
            title,
            brief,
            after: t.after.clone(),
            state: TodoState::Waiting,
            result: None,
            tries: 0,
        });
    }
    if next.len() > MAX_TODOS {
        problems.push(format!("最多 {MAX_TODOS} 件，这里有 {} 件：把小的合并，或者先做完一部分", next.len()));
    }
    let all = if problems.is_empty() { edge_problems(&next) } else { problems };
    if all.is_empty() { (next, vec![]) } else { (g.to_vec(), all) }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TodoChange {
    pub state: Option<TodoState>,
    pub result: Option<String>,
    pub brief: Option<String>,
    pub after: Option<Vec<String>>,
}

pub fn todo_update(g: &[Todo], id: &str, c: &TodoChange) -> Result<Vec<Todo>, String> {
    let i = g.iter().position(|t| t.id == id).ok_or_else(|| format!("没有「{id}」这件任务"))?;
    let mut t = g[i].clone();
    let open = matches!(t.state, TodoState::Waiting | TodoState::Failed);
    if (c.brief.is_some() || c.after.is_some()) && !open {
        return Err(format!("「{id}」已经{}，不能再改要做什么或等谁", t.state.word()));
    }
    if let Some(brief) = &c.brief {
        if brief.trim().is_empty() {
            return Err("brief 是空的".into());
        }
        t.brief = brief.trim().to_string();
    }
    if let Some(after) = &c.after {
        t.after = after.clone();
    }
    if let Some(result) = &c.result {
        t.result = Some(result.trim().to_string());
    }
    if let Some(to) = c.state
        && to != t.state
    {
        match (t.state, to) {
            (TodoState::Failed | TodoState::Skipped, TodoState::Waiting) => {
                t.tries += 1;
                t.state = TodoState::Waiting;
            }
            (TodoState::Waiting | TodoState::Working, TodoState::Done | TodoState::Failed | TodoState::Skipped) => t.state = to,
            (from, to) => return Err(format!("「{id}」{}，不能改成{}", from.word(), to.word())),
        }
    }
    let mut next = g.to_vec();
    next[i] = t;
    if c.after.is_some() {
        let problems = edge_problems(&next);
        if !problems.is_empty() {
            return Err(problems.join("；"));
        }
    }
    Ok(next)
}

/// todo_add, todo_update and todo_list over one shared graph.
pub fn todo_tools(graph: Arc<Mutex<Vec<Todo>>>) -> Vec<Box<dyn Tool>> {
    vec![Box::new(TodoAdd(graph.clone())), Box::new(TodoUpdate(graph.clone())), Box::new(TodoList(graph))]
}

struct TodoAdd(Arc<Mutex<Vec<Todo>>>);
struct TodoUpdate(Arc<Mutex<Vec<Todo>>>);
struct TodoList(Arc<Mutex<Vec<Todo>>>);

impl Tool for TodoAdd {
    fn spec(&self) -> ToolSpec {
        spec(
            "todo_add",
            "把一件要分几步、有先后的活写成任务：每件一个简短的英文 id、要做什么（brief：在哪、做到什么程度算完、交回什么）、要等哪几件做完（after）。可以一次写一张图，也可以往已有的图里加；有一件不对（id 重复、等的不存在、互相等成了圈）整批都不收，回答里说哪条错。做完一件用 todo_update 标上。",
            json!({"type": "object", "properties": {"tasks": {"type": "array", "items": {"type": "object", "properties": {
                "id": {"type": "string"}, "title": {"type": "string"}, "brief": {"type": "string"},
                "after": {"type": "array", "items": {"type": "string"}}
            }, "required": ["id", "brief"]}}}, "required": ["tasks"]}),
        )
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let tasks: Vec<NewTodo> = match serde_json::from_value(args["tasks"].clone()) {
            Ok(t) => t,
            Err(e) => return ToolOutput::error(e.to_string()),
        };
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let (next, problems) = todo_add(&g, &tasks);
        *g = next;
        if problems.is_empty() {
            ToolOutput::ok(todo_text(&g))
        } else {
            ToolOutput::error(format!("没收：{}\n\n{}", problems.join("；"), todo_text(&g)))
        }
    }
}

impl Tool for TodoUpdate {
    fn spec(&self) -> ToolSpec {
        spec(
            "todo_update",
            "改一件任务：做完了 state 写 done、result 写结果（改了什么、结论、关键的数字）；做不成写 failed 和原因；不用做了写 skipped。没做的可以改 brief 和 after；没做成的改了 brief 再把 state 写回 waiting 重来。全部做完，这张图就收起来了。",
            json!({"type": "object", "properties": {
                "id": {"type": "string"},
                "state": {"type": "string", "enum": ["done", "failed", "skipped", "waiting"]},
                "result": {"type": "string"}, "brief": {"type": "string"},
                "after": {"type": "array", "items": {"type": "string"}}
            }, "required": ["id"]}),
        )
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let id = match string_arg(args, "id") {
            Ok(i) => i.to_string(),
            Err(e) => return e,
        };
        let change: TodoChange = serde_json::from_value(args.clone()).unwrap_or_default();
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match todo_update(&g, &id, &change) {
            Ok(next) => {
                let finished = !next.is_empty() && next.iter().all(|t| t.state.settled());
                let text = todo_text(&next);
                *g = if finished { vec![] } else { next };
                ToolOutput::ok(if finished {
                    text + "\n\n都做完了，这张图收起来了。"
                } else {
                    text
                })
            }
            Err(e) => ToolOutput::error(e),
        }
    }
}

impl Tool for TodoList {
    fn spec(&self) -> ToolSpec {
        spec(
            "todo_list",
            "看现在的任务：每件在等、可以做、做完还是没做成，要等谁，结果的开头。",
            json!({"type": "object", "properties": {}}),
        )
    }
    fn replay_safe(&self) -> bool {
        true
    }
    fn execute(&self, _: &Value) -> ToolOutput {
        ToolOutput::ok(todo_text(&self.0.lock().unwrap_or_else(|p| p.into_inner())))
    }
}

/// Makes the tools a helper gets: the parent's, without `spawn_agent`
/// (helpers do not nest).
pub type ToolFactory = Arc<dyn Fn() -> Vec<Box<dyn Tool>> + Send + Sync>;

/// `spawn_agent`: runs a helper conversation on one independent job and
/// returns its last paragraph. Each call has its own transcript under
/// `dir`, named by a hash of the brief, so a call cut off by a crash picks
/// up the same helper conversation when replayed.
pub struct SpawnAgent {
    pub parent: String,
    pub client: Arc<dyn crate::ModelClient>,
    pub model: String,
    pub tools: ToolFactory,
    pub dir: PathBuf,
}

impl Tool for SpawnAgent {
    fn spec(&self) -> ToolSpec {
        spec(
            "spawn_agent",
            "派一个帮手去做一件独立的事（查资料、读一片代码、改一个模块、跑一组检查），它做完把结果汇报给你。它看不到你们的对话：brief 里写清楚要做什么、在哪、做到什么程度算完、汇报什么。几件互不相干的事可以在同一步里派几个，它们会同时做。",
            json!({"type": "object", "properties": {"brief": {"type": "string"}, "label": {"type": "string"}}, "required": ["brief"]}),
        )
    }

    /// The helper's own transcript makes a replay resume it, not start over.
    fn replay_safe(&self) -> bool {
        true
    }

    fn execute(&self, args: &Value) -> ToolOutput {
        let brief = match string_arg(args, "brief") {
            Ok(b) => b.trim().to_string(),
            Err(e) => return e,
        };
        if brief.is_empty() {
            return ToolOutput::error("brief 是空的。");
        }
        let system = format!(
            "你是「{}」派出去的帮手，只做下面交代的这一件事，做完就停。\n- 不能问问题：信息不够就按最合理的理解去做，在汇报里说明你的理解。\n- 最后用一段话汇报：做了什么、结果是什么（要点、改过的文件、关键的数字）、没做成的和原因。你的最后一段话就是交回去的全部内容。",
            self.parent
        );
        let mut brain = crate::Brain::new(self.client.clone(), &self.model, system);
        brain.tools = (self.tools)();
        let key = stable_hash(&brief);
        let path = self.dir.join(format!("helper-{key}.jsonl"));
        let mut conversation = match crate::Conversation::open(&path, brain) {
            Ok(c) => c,
            Err(e) => return ToolOutput::error(e.to_string()),
        };
        let mut last = String::new();
        let mut collect = |e: crate::BrainEvent| {
            if let crate::BrainEvent::TurnFinished { text, .. } = e {
                last = text;
            }
        };
        let outcome = match conversation.resume(&mut collect) {
            Some(r) => r,
            None if conversation.entries().is_empty() => conversation.send(&brief, &mut collect),
            // Already finished in an earlier run: hand back what it said.
            None => {
                last = last_answer(conversation.entries());
                Ok(crate::TurnOutcome::Completed)
            }
        };
        match outcome {
            Ok(crate::TurnOutcome::Completed) if !last.trim().is_empty() => ToolOutput::ok(last),
            Ok(other) => ToolOutput::error(format!("帮手没有做完（{other:?}）。{last}")),
            Err(e) => ToolOutput::error(format!("帮手出错：{e}")),
        }
    }
}

fn last_answer(entries: &[crate::Entry]) -> String {
    entries
        .iter()
        .rev()
        .find_map(|e| match e {
            crate::Entry::Message { message, .. } if message.role == crate::Role::Assistant => message.content.clone(),
            _ => None,
        })
        .unwrap_or_default()
}

/// FNV-1a, enough to name a file by its brief.
fn stable_hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}
