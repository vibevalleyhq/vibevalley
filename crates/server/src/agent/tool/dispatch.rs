use std::sync::{Arc, LazyLock};

use arc_swap::ArcSwap;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use vibevalley_protocol::{Agent, Session};

use super::registry::{Route, ToolRegistry, Who, Words};
use super::{chat, content, issue, memory, plan, toolset};
use crate::BoxFuture;
use crate::agent::mcp::{
    HelperRunMode, McpResourceContentWire, McpResourceTemplateWire, McpResourceWire, ResourceReader, ToolDispatchPort, ToolSpecWire, tool_allowed_in_mode,
};

fn words_of(json: &str) -> Vec<Words> {
    serde_json::from_str(json).expect("tool words")
}

static ORCHESTRATOR: LazyLock<Vec<Words>> = LazyLock::new(|| words_of(include_str!("../../../assets/tools/orchestrator.json")));
static HELPER: LazyLock<Vec<Words>> = LazyLock::new(|| words_of(include_str!("../../../assets/tools/helper.json")));

impl ToolRegistry {
    pub fn helper_tools_wire(&self) -> Vec<ToolSpecWire> {
        self.helper_tools_for(None)
    }

    /// Returns helper tool definitions filtered by the session's agent profile toolsets and `can` narrowing.
    pub fn helper_tools_for(&self, session: Option<&Session>) -> Vec<ToolSpecWire> {
        let profile = session.and_then(|s| s.profile.as_deref()).and_then(|id| self.profile.agent(id));
        helper()
            .into_iter()
            .filter(|t| toolset::allows(profile.as_ref(), &t.words.op, &t.words.name, toolset::Role::Helper))
            .map(|t| ToolSpecWire {
                name: t.words.name,
                description: t.words.description,
                parameters_json: t.words.parameters.to_string(),
            })
            .collect()
    }

    /// Returns helper tool definitions for `mode`, exposing readonly review/diff tools from orchestrator specs when appropriate.
    pub fn helper_tools_for_mode(&self, session: Option<&Session>, mode: HelperRunMode) -> Vec<ToolSpecWire> {
        let profile = session.and_then(|s| s.profile.as_deref()).and_then(|id| self.profile.agent(id));
        let extras: Vec<Tool> = if matches!(mode, HelperRunMode::ReadOnlyReview | HelperRunMode::ReadOnlyCollaborator) {
            orchestrator()
                .into_iter()
                .filter(|t| matches!(t.words.name.as_str(), "issue_diff_get" | "issue_review"))
                .collect()
        } else {
            Vec::new()
        };
        helper()
            .into_iter()
            .chain(extras)
            .filter(|t| toolset::allows(profile.as_ref(), &t.words.op, &t.words.name, toolset::Role::Helper))
            .filter(|t| tool_allowed_in_mode(&t.words.name, mode))
            .map(|t| ToolSpecWire {
                name: t.words.name,
                description: t.words.description,
                parameters_json: t.words.parameters.to_string(),
            })
            .collect()
    }

    pub async fn session_mode_async(&self, session: &Session) -> HelperRunMode {
        let item = match session.issue_id() {
            Some(issue_id) => self.ctx.service.issue.get(issue_id).await.ok().flatten(),
            None => None,
        };
        match self.runtime.session_engine().helper_mode_async(session, item.as_ref()).await {
            crate::runtime::RunMode::Execution => HelperRunMode::Execution,
            crate::runtime::RunMode::Drafting => HelperRunMode::Drafting,
            crate::runtime::RunMode::ReadOnlyAnswer => HelperRunMode::ReadOnlyAnswer,
            crate::runtime::RunMode::ReadOnlyReview => HelperRunMode::ReadOnlyReview,
            crate::runtime::RunMode::ReadOnlyCollaborator => HelperRunMode::ReadOnlyCollaborator,
        }
    }

    pub async fn call_helper_async(&self, session: Session, name: &str, args_json: &str) -> Result<String, String> {
        let mode = self.session_mode_async(&session).await;
        if !tool_allowed_in_mode(name, mode) {
            return Err(format!("没成：当前{}模式只读，不能调用 {name}", mode.label_zh()));
        }
        let tools = helper().into_iter().chain(
            orchestrator()
                .into_iter()
                .filter(|t| matches!(t.words.name.as_str(), "issue_diff_get" | "issue_review")),
        );
        match tools.into_iter().find(|t| t.words.name == name) {
            Some(t) => t.run_async(self, &Who::Helper(Box::new(session)), args_json).await,
            None => Err(format!("没成：没有 {name} 这个工具")),
        }
    }

    pub async fn call_readonly_issue_tool_async(&self, name: &str, args_json: &str) -> Result<String, String> {
        if !matches!(name, "issue_list" | "issue_get") {
            return Err("没认出你是谁：这些工具只给执行会话用".into());
        }
        let tools = helper();
        match tools.into_iter().find(|t| t.words.name == name) {
            Some(t) => t.run_async(self, &Who::Orchestrator(Route::default()), args_json).await,
            None => Err(format!("没成：没有 {name} 这个工具")),
        }
    }
}

impl ToolDispatchPort for ToolRegistry {
    fn helper_tools(&self) -> Vec<ToolSpecWire> {
        self.helper_tools_wire()
    }

    fn helper_tools_for(&self, session: Option<&Session>) -> Vec<ToolSpecWire> {
        ToolRegistry::helper_tools_for(self, session)
    }

    fn helper_tools_for_mode(&self, session: Option<&Session>, mode: HelperRunMode) -> Vec<ToolSpecWire> {
        ToolRegistry::helper_tools_for_mode(self, session, mode)
    }

    fn session_for_token<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Option<Session>> {
        Box::pin(self.session_for_token_async(token))
    }

    fn session_mode_async<'a>(&'a self, session: &'a Session) -> BoxFuture<'a, HelperRunMode> {
        Box::pin(ToolRegistry::session_mode_async(self, session))
    }

    fn call_helper_async<'a>(&'a self, session: Session, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(ToolRegistry::call_helper_async(self, session, name, args_json))
    }

    fn call_readonly_issue_tool_async<'a>(&'a self, name: &'a str, args_json: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(ToolRegistry::call_readonly_issue_tool_async(self, name, args_json))
    }

    fn list_resources_async<'a>(&'a self) -> BoxFuture<'a, Vec<McpResourceWire>> {
        Box::pin(self.resource.list_mcp_resources_async())
    }

    fn list_resource_templates(&self) -> Vec<McpResourceTemplateWire> {
        self.resource.list_mcp_resource_templates()
    }

    fn read_resource_async<'a>(&'a self, session: Option<Session>, uri: &'a str) -> BoxFuture<'a, Result<McpResourceContentWire, String>> {
        Box::pin(async move {
            let reader = match session.as_ref() {
                Some(s) if s.is_orchestrator() => ResourceReader::Orchestrator,
                Some(s) => ResourceReader::Helper(s),
                None => ResourceReader::LocalReadOnly,
            };
            self.resource.read_mcp_async(reader, uri, Some(&self.storage)).await
        })
    }
}

/// A tool's arguments read from what the model wrote: numbers, booleans and
/// integers given as strings are taken as such, `null` is no value, and
/// fields the schema does not name are dropped; what still does not read is
/// refused in words the model can act on.
pub(super) fn parse_args<T: DeserializeOwned>(schema: &Value, raw_json: &str) -> Result<T, String> {
    let raw: Value = serde_json::from_str(raw_json).unwrap_or_else(|_| json!({}));
    let lenient = coerce(schema, &raw);
    serde_json::from_value(lenient).map_err(|e| format!("参数不对：{e}"))
}

fn coerce(schema: &Value, v: &Value) -> Value {
    let kind = schema["type"].as_str().unwrap_or("");
    match (kind, v) {
        ("object", Value::Object(o)) => {
            let props = schema["properties"].as_object();
            let mut out = serde_json::Map::new();
            for (k, x) in o {
                if x.is_null() {
                    continue;
                }
                match props.and_then(|p| p.get(k)) {
                    Some(s) => {
                        out.insert(k.clone(), coerce(s, x));
                    }
                    None if props.is_none() => {
                        out.insert(k.clone(), x.clone());
                    }
                    None => {}
                }
            }
            Value::Object(out)
        }
        ("array", Value::Array(a)) => Value::Array(a.iter().map(|x| coerce(&schema["items"], x)).collect()),
        ("integer", Value::String(s)) => s.trim().parse::<i64>().map(Value::from).unwrap_or_else(|_| v.clone()),
        ("integer", Value::Number(n)) if n.as_i64().is_none() => n.as_f64().map(|f| json!(f.trunc() as i64)).unwrap_or_else(|| v.clone()),
        ("number", Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .and_then(|f| serde_json::Number::from_f64(f).map(Value::Number))
            .unwrap_or_else(|| v.clone()),
        ("boolean", Value::String(s)) => match s.trim() {
            "true" => json!(true),
            "false" => json!(false),
            _ => v.clone(),
        },
        ("string", Value::Number(n)) => json!(n.to_string()),
        _ => v.clone(),
    }
}

/// What a tool does with typed arguments.
type Run = for<'a> fn(&'a ToolRegistry, &'a Who, &'a Words, &'a str) -> BoxFuture<'a, Result<String, String>>;

/// A tool as one caller holds it.
#[derive(Clone)]
pub struct Tool {
    pub words: Words,
    run: Run,
}

/// `run` for a tool whose arguments read as `A`.
macro_rules! typed {
    ($f:path) => {
        |tools: &ToolRegistry, who: &Who, words: &Words, raw_json: &str| {
            Box::pin(async move {
                let parsed = parse_args(&words.parameters, raw_json)?;
                $f(tools, who, parsed).await
            })
        }
    };
}

fn handler(op: &str) -> Option<Run> {
    Some(match op {
        "issue.list" => typed!(issue::list),
        "issue.get" => typed!(issue::get),
        "issue.create" => typed!(issue::create),
        "issue.update" => typed!(issue::update),
        "issue.status.update" => typed!(issue::status),
        "issue.comment.create" => typed!(issue::comment),
        "issue.review" => typed!(issue::review),
        "issue.diff.get" => typed!(issue::diff),
        "issue.digest.get" => typed!(issue::digest_get),
        "issue.triage.suggest" => typed!(issue::triage_suggest),
        "issue.split" => typed!(issue::split),
        "issue.report" => typed!(issue::report),
        "issue.pr.submit" => typed!(issue::pr_submit),
        "session.list" => typed!(issue::sessions),
        "session.stop" => typed!(issue::stop),
        "channel.message.list" => typed!(chat::read),
        "channel.message.send" => typed!(chat::send),
        "channel.unread.list" => typed!(chat::unread),
        "channel.list" => typed!(chat::channels),
        "channel.create" => typed!(chat::open),
        "channel.update" => typed!(chat::update),
        "repo.list" => typed!(plan::repos),
        "cron.create" => typed!(plan::cron_create),
        "cron.list" => typed!(plan::cron_list),
        "cron.delete" => typed!(plan::cron_delete),
        "resource.read" => typed!(content::resource_read),
        "memory.search" => typed!(memory::search),
        "memory.create" => typed!(memory::create),
        "media.image.create" => typed!(content::image),
        "media.speech.create" => typed!(content::speech),
        "media.dialogue.create" => typed!(content::dialogue),
        "media.voiceDesign.create" => typed!(content::voice_design),
        "media.understanding.start" => typed!(content::understand),
        "media.job.get" => typed!(content::job_get),
        "media.job.list" => typed!(content::job_list),
        "media.job.cancel" => typed!(content::job_cancel),
        "media.job.download" => typed!(content::job_download),
        "library.item.list" => typed!(content::library_list),
        "library.item.add" => typed!(content::library_add),
        "note.list" => typed!(content::note_list),
        "note.get" => typed!(content::note_get),
        "note.content.get" => typed!(content::note_content),
        "note.create" => typed!(content::note_create),
        "note.version.create" => typed!(content::note_version),
        "note.tree.move" => typed!(content::note_tree_move),
        "note.link.list" => typed!(content::note_link_list),
        "note.doc.view" => typed!(content::note_doc_view),
        "note.doc.appendBlock" => typed!(content::note_doc_append_block),
        "note.base.view" => typed!(content::note_base_view),
        "note.base.upsertRow" => typed!(content::note_base_upsert_row),
        "note.base.runAgentColumn" => typed!(content::note_base_run_agent_column),
        "note.file.list" => typed!(content::note_file_list),
        "note.file.get" => typed!(content::note_file_get),
        "note.file.write" => typed!(content::note_file_write),
        "note.file.delete" => typed!(content::note_file_delete),
        "note.suggestion.list" => typed!(content::note_suggestion_list),
        "note.suggestion.create" => typed!(content::note_suggestion_create),
        "note.type.list" => typed!(content::note_type_list),
        "note.type.read" => typed!(content::note_type_read),
        _ => return None,
    })
}

fn tools_of(words: &[Words]) -> Vec<Tool> {
    words
        .iter()
        .filter_map(|w| {
            let run = handler(&w.op)?;
            Some(Tool { words: w.clone(), run })
        })
        .collect()
}

/// The orchestrator's tools, in the order its prompt has always listed them.
pub fn orchestrator() -> Vec<Tool> {
    tools_of(&ORCHESTRATOR)
}

/// A helper's tools, as `/mcp` serves them.
pub fn helper() -> Vec<Tool> {
    tools_of(&HELPER)
}

/// Every word file names only tools this module runs.
pub fn unrun() -> Vec<String> {
    ORCHESTRATOR
        .iter()
        .chain(HELPER.iter())
        .filter(|w| handler(&w.op).is_none())
        .map(|w| w.name.clone())
        .collect()
}

impl Tool {
    /// The tool run as `who`: its answer, or its refusal in words for the model.
    pub async fn run_async(&self, tools: &ToolRegistry, who: &Who, raw_json: &str) -> Result<String, String> {
        let profile = match who {
            Who::Orchestrator(route) if !route.agent.is_empty() => tools.profile.agent(&route.agent),
            Who::Orchestrator(_) => None,
            Who::Helper(session) => session.profile.as_deref().and_then(|id| tools.profile.agent(id)),
        };
        let role = toolset::Role::from_who(who);
        if !toolset::allows(profile.as_ref(), &self.words.op, &self.words.name, role) {
            return Err(toolset::denied_message(profile.as_ref(), &self.words.op, &self.words.name, role));
        }
        (self.run)(tools, who, &self.words, raw_json).await
    }

    /// Reads only: safe to run again if the process died while it ran.
    pub fn replay_safe(&self) -> bool {
        let op = self.words.op.as_str();
        op.ends_with(".list") || op.ends_with(".get") || op.ends_with(".read") || op.ends_with(".view") || op == "memory.search"
    }
}

/// The orchestrator's tool in its loop: run as it is answering now.
pub struct Held {
    pub tool: Tool,
    pub tools: Arc<ToolRegistry>,
    pub route: Arc<ArcSwap<Route>>,
}

impl vibevalley_runtime::agent::Tool for Held {
    fn spec(&self) -> vibevalley_runtime::agent::ToolSpec {
        vibevalley_runtime::agent::ToolSpec {
            name: self.tool.words.name.clone(),
            description: self.tool.words.description.clone(),
            parameters: self.tool.words.parameters.clone(),
        }
    }

    fn replay_safe(&self) -> bool {
        self.tool.replay_safe()
    }

    fn execute<'a>(&'a self, args: &'a Value) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::agent::ToolOutput> {
        let tool = self.tool.clone();
        let tools = self.tools.clone();
        let route = (**self.route.load()).clone();
        let raw_json = args.to_string();
        Box::pin(async move {
            match tool.run_async(&tools, &Who::Orchestrator(route), &raw_json).await {
                Ok(text) => vibevalley_runtime::agent::ToolOutput::ok(text),
                Err(why) => vibevalley_runtime::agent::ToolOutput::error(why),
            }
        })
    }
}

/// The orchestrator's tools for its loop.
pub fn held(tools: &Arc<ToolRegistry>, route: &Arc<ArcSwap<Route>>) -> Vec<Box<dyn vibevalley_runtime::agent::Tool>> {
    held_for(tools, route, None)
}

/// The orchestrator's tools filtered by `agent`'s enabled toolsets and `can` narrowing.
pub fn held_for(tools: &Arc<ToolRegistry>, route: &Arc<ArcSwap<Route>>, agent: Option<&Agent>) -> Vec<Box<dyn vibevalley_runtime::agent::Tool>> {
    orchestrator()
        .into_iter()
        .filter(|t| toolset::allows(agent, &t.words.op, &t.words.name, toolset::Role::Orchestrator))
        .map(|tool| {
            Box::new(Held {
                tool,
                tools: tools.clone(),
                route: route.clone(),
            }) as Box<dyn vibevalley_runtime::agent::Tool>
        })
        .collect()
}
