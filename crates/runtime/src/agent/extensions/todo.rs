use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::BoxFuture;
use crate::agent::core::doc::{CONVERSATION_SCOPE, TodoDoc, read_doc, write_doc};
use crate::agent::core::extension::Extension;
use crate::agent::core::tool::{ReplayPolicy, Tool, ToolContext, TypedTool, TypedToolAdapter, TypedToolOutput};

pub use crate::agent::core::doc::{TodoItem as Todo, TodoState};

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

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TodoUpdateState {
    Done,
    Failed,
    Skipped,
    Waiting,
}

impl From<TodoUpdateState> for TodoState {
    fn from(value: TodoUpdateState) -> Self {
        match value {
            TodoUpdateState::Done => TodoState::Done,
            TodoUpdateState::Failed => TodoState::Failed,
            TodoUpdateState::Skipped => TodoState::Skipped,
            TodoUpdateState::Waiting => TodoState::Waiting,
        }
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TodoAddArgs {
    pub tasks: Vec<NewTodo>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TodoUpdateArgs {
    pub id: String,
    #[serde(default)]
    pub state: Option<TodoUpdateState>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub brief: Option<String>,
    #[serde(default)]
    pub after: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct TodoListArgs {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoDetails {
    pub count: usize,
}

async fn read_todos(fallback: &Mutex<Vec<Todo>>, ctx: &ToolContext) -> Result<Vec<Todo>, String> {
    if let Some(store) = &ctx.store
        && !ctx.conversation_id.is_empty()
    {
        let conv = ctx.conversation_id.clone();
        return store
            .read_async(move |tx| Box::pin(async move { read_doc::<TodoDoc>(tx, CONVERSATION_SCOPE, &conv).await }))
            .await
            .map(|doc| doc.items)
            .map_err(|e| e.to_string());
    }
    Ok(fallback.lock().unwrap_or_else(|p| p.into_inner()).clone())
}

async fn mutate_todos<R: Send + 'static>(
    fallback: &Mutex<Vec<Todo>>,
    ctx: &ToolContext,
    f: impl FnOnce(&mut Vec<Todo>) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    if let Some(store) = &ctx.store
        && !ctx.conversation_id.is_empty()
    {
        let conv = ctx.conversation_id.clone();
        return store
            .write_async(move |tx| {
                Box::pin(async move {
                    let mut doc = read_doc::<TodoDoc>(tx, CONVERSATION_SCOPE, &conv).await?;
                    let res = f(&mut doc.items).map_err(crate::agent::durable::Error::Invalid)?;
                    write_doc::<TodoDoc>(tx, CONVERSATION_SCOPE, &conv, &doc).await?;
                    Ok(res)
                })
            })
            .await
            .map_err(|e| e.to_string());
    }
    let mut g = fallback.lock().unwrap_or_else(|p| p.into_inner());
    f(&mut g)
}

pub struct TodoAdd(pub Arc<Mutex<Vec<Todo>>>);
pub struct TodoUpdate(pub Arc<Mutex<Vec<Todo>>>);
pub struct TodoList(pub Arc<Mutex<Vec<Todo>>>);

impl TypedTool for TodoAdd {
    type Args = TodoAddArgs;
    type Details = TodoDetails;

    fn name(&self) -> &'static str {
        "todo_add"
    }

    fn description(&self) -> &'static str {
        "把一件要分几步、有先后的活写成任务：每件一个简短的英文 id、要做什么（brief：在哪、做到什么程度算完、交回什么）、要等哪几件做完（after）。可以一次写一张图，也可以往已有的图里加；有一件不对（id 重复、等的不存在、互相等成了圈）整批都不收，回答里说哪条错。做完一件用 todo_update 标上。"
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            mutate_todos(&self.0, ctx, move |g| {
                let (next, problems) = todo_add(g, &args.tasks);
                *g = next;
                if problems.is_empty() {
                    Ok(TypedToolOutput::ok_with(todo_text(g), TodoDetails { count: g.len() }))
                } else {
                    Err(format!("没收：{}\n\n{}", problems.join("；"), todo_text(g)))
                }
            })
            .await
        })
    }
}

impl TypedTool for TodoUpdate {
    type Args = TodoUpdateArgs;
    type Details = TodoDetails;

    fn name(&self) -> &'static str {
        "todo_update"
    }

    fn description(&self) -> &'static str {
        "改一件任务：做完了 state 写 done、result 写结果（改了什么、结论、关键的数字）；做不成写 failed 和原因；不用做了写 skipped。没做的可以改 brief 和 after；没做成的改了 brief 再把 state 写回 waiting 重来。全部做完，这张图就收起来了。"
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            let change = TodoChange {
                state: args.state.map(Into::into),
                result: args.result,
                brief: args.brief,
                after: args.after,
            };
            mutate_todos(&self.0, ctx, move |g| {
                let next = todo_update(g, &args.id, &change)?;
                let finished = !next.is_empty() && next.iter().all(|t| t.state.settled());
                let text = todo_text(&next);
                *g = if finished { vec![] } else { next };
                let out = if finished {
                    text + "\n\n都做完了，这张图收起来了。"
                } else {
                    text
                };
                Ok(TypedToolOutput::ok_with(out, TodoDetails { count: g.len() }))
            })
            .await
        })
    }
}

impl TypedTool for TodoList {
    type Args = TodoListArgs;
    type Details = TodoDetails;

    fn name(&self) -> &'static str {
        "todo_list"
    }

    fn description(&self) -> &'static str {
        "看现在的任务：每件在等、可以做、做完还是没做成，要等谁，结果的开头。"
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute<'a>(&'a self, _args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            let g = read_todos(&self.0, ctx).await?;
            Ok(TypedToolOutput::ok_with(todo_text(&g), TodoDetails { count: g.len() }))
        })
    }
}

/// todo_add, todo_update and todo_list over one shared graph / durable store.
pub fn todo_tools(graph: Arc<Mutex<Vec<Todo>>>) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(TypedToolAdapter(TodoAdd(graph.clone()))),
        Box::new(TypedToolAdapter(TodoUpdate(graph.clone()))),
        Box::new(TypedToolAdapter(TodoList(graph))),
    ]
}

#[derive(Clone)]
pub struct TodoExtension {
    fallback: Arc<Mutex<Vec<Todo>>>,
    expose_tools: bool,
}

impl Default for TodoExtension {
    fn default() -> Self {
        Self {
            fallback: Default::default(),
            expose_tools: true,
        }
    }
}

impl TodoExtension {
    pub fn without_global_tools(mut self) -> Self {
        self.expose_tools = false;
        self
    }
}

impl Extension for TodoExtension {
    fn name(&self) -> &str {
        "todo"
    }

    fn tools(&self) -> Vec<Box<dyn Tool>> {
        if self.expose_tools { todo_tools(self.fallback.clone()) } else { vec![] }
    }
}
