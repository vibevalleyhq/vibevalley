//! The farm's tools, one set for the orchestrator and the helpers: each
//! tool takes its arguments as a typed struct, read leniently from what a
//! model wrote, and answers in words for the model. What the model sees of a
//! tool (name, description, JSON Schema) is in `assets/tools/`, which this
//! crate owns; who may call which is the file the tool is listed in.

mod chat;
mod content;
mod issue;
mod memory;
mod plan;

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Weak};

use parking_lot::Mutex;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use vibevalley_protocol::{Caller, Issue, Session};

use crate::modules::collab::channel::Chat;
use crate::modules::content::artifact::Artifacts;
use crate::modules::content::media::jobs::Jobs as MediaJobs;
use crate::modules::infra::text;
use crate::modules::team::agent::Agents;
use crate::modules::work::issue::Board;
use crate::modules::work::pull::Pulls;
use crate::ports::{ResourcePort, ToolDispatchPort, ToolSpecWire};
use crate::{CallerContext, CallerPrincipal, ClientIdentity, ClientKind, Hub};

/// A tool as the model sees it.
#[derive(Deserialize, Clone)]
pub struct Words {
    pub op: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

fn words_of(json: &str) -> Vec<Words> {
    serde_json::from_str(json).expect("tool words")
}

static ORCHESTRATOR: LazyLock<Vec<Words>> = LazyLock::new(|| words_of(include_str!("../../../../assets/tools/orchestrator.json")));
static HELPER: LazyLock<Vec<Words>> = LazyLock::new(|| words_of(include_str!("../../../../assets/tools/helper.json")));

/// Where the orchestrator is answering now (`HostContext`).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Route {
    pub agent: String,
    pub channel: String,
    pub envelope: String,
    /// The helper the user picked in the composer.
    pub picked: String,
    /// User-authored words are in the batch.
    pub user: bool,
}

/// Who calls a tool.
#[derive(Clone)]
pub enum Who {
    Orchestrator(Route),
    Helper(Box<Session>),
}

/// Dissolved tool dispatcher: routes cross-domain RPCs through `Hub::invoke`,
/// reads `vv://` resources through `ResourcePort`, and keeps only the narrow
/// L1/L2 handles needed for non-RPC actor-scoped operations (zero L3 imports).
pub struct ToolBox {
    pub hub: Weak<Hub>,
    pub resources: Arc<dyn ResourcePort>,
    pub agents: Arc<Agents>,
    pub board: Board,
    pub chat: Arc<Chat>,
    pub pulls: Arc<Pulls>,
    pub media: Arc<MediaJobs>,
    pub artifacts: Arc<Artifacts>,
    pub repos_root: PathBuf,
}

impl ToolBox {
    pub(crate) fn hub(&self) -> Result<Arc<Hub>, String> {
        self.hub.upgrade().ok_or_else(|| "server closed".to_string())
    }
    /// Builds the authenticated internal `CallerContext` for a tool invocation.
    pub(crate) fn ctx(&self, who: &Who) -> CallerContext {
        match who {
            Who::Orchestrator(r) => CallerContext {
                caller: Caller::Orchestrator,
                principal: CallerPrincipal::LocalOwner,
                client: Some(ClientIdentity {
                    id: r.agent.clone(),
                    kind: ClientKind::Internal,
                    label: r.channel.clone(),
                }),
                trace_id: 0,
            },
            Who::Helper(h) => CallerContext {
                caller: Caller::Session,
                principal: CallerPrincipal::LocalOwner,
                client: Some(ClientIdentity {
                    id: h.id.clone(),
                    kind: ClientKind::Internal,
                    label: h.name.clone(),
                }),
                trace_id: 0,
            },
        }
    }

    /// An issue by id, `#n`, number, or the id or name of a helper on it.
    fn issue(&self, key: &str) -> Result<Issue, String> {
        let key = key.trim();
        let k = key.trim_start_matches('#');
        let found = self.hub()?.read(|s| {
            s.issues.iter().find(|i| i.id == key || i.number.to_string() == k).cloned().or_else(|| {
                let on = s.sessions.iter().filter(|h| h.id == k || h.name == k).max_by_key(|h| h.hired_at)?;
                s.issues.iter().find(|i| Some(i.id.as_str()) == on.issue_id()).cloned()
            })
        });
        found.ok_or_else(|| text::no_issue(key))
    }

    fn worker_of(&self, issue: &Issue) -> Option<Session> {
        let last = issue.latest_session_id()?;
        self.hub.upgrade()?.read(|s| s.sessions.iter().find(|h| &h.id == last).cloned())
    }

    fn who_of(&self, issue: &Issue) -> String {
        if let Some(w) = self.worker_of(issue) {
            return w.name;
        }
        match issue.assigned_agent() {
            Some(vibevalley_protocol::DEFAULT_ORCHESTRATOR) => "助手".into(),
            Some(a) => self.agents.profiles.agent(a).map(|p| p.name).unwrap_or_default(),
            None => String::new(),
        }
    }

    fn number_of(&self, session: &Session) -> Option<i64> {
        let issue = session.issue_id()?;
        self.hub.upgrade()?.read(|s| s.issues.iter().find(|i| i.id == issue).map(|i| i.number))
    }

    /// Every helper on the farm.
    pub fn roster(&self) -> Vec<Session> {
        let Some(hub) = self.hub.upgrade() else { return vec![] };
        hub.read(|s| s.sessions.iter().filter(|h| vibevalley_core::status::is_farm_worker(h)).cloned().collect())
    }

    pub fn session_line(&self, h: &Session) -> String {
        text::session_line(h, crate::now(), self.number_of(h))
    }
}

impl ToolDispatchPort for ToolBox {
    fn helper_tools(&self) -> Vec<ToolSpecWire> {
        helper()
            .into_iter()
            .map(|t| ToolSpecWire {
                name: t.words.name,
                description: t.words.description,
                parameters: t.words.parameters,
            })
            .collect()
    }

    fn session_for_token(&self, token: &str) -> Option<Session> {
        let id = self.board.sessions().who(token)?;
        self.board.session(&id)
    }

    fn call_helper(&self, session: Session, name: &str, args: &Value) -> Result<String, String> {
        let tools = helper();
        match tools.iter().find(|t| t.words.name == name) {
            Some(t) => t.run(self, &Who::Helper(Box::new(session)), args),
            None => Err(format!("没成：没有 {name} 这个工具")),
        }
    }
}

/// A tool's arguments read from what the model wrote: numbers, booleans and
/// integers given as strings are taken as such, `null` is no value, and
/// fields the schema does not name are dropped; what still does not read is
/// refused in words the model can act on.
pub fn args<T: DeserializeOwned>(schema: &Value, raw: &Value) -> Result<T, String> {
    let lenient = coerce(schema, raw);
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
type Run = fn(&ToolBox, &Who, &Words, &Value) -> Result<String, String>;

/// A tool as one caller holds it.
#[derive(Clone)]
pub struct Tool {
    pub words: Words,
    run: Run,
}

/// `run` for a tool whose arguments read as `A`.
macro_rules! typed {
    ($f:path) => {
        |tools: &ToolBox, who: &Who, words: &Words, raw: &Value| $f(tools, who, $crate::modules::team::tool::args(&words.parameters, raw)?)
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
        "artifact.list" => typed!(content::artifact_list),
        "artifact.get" => typed!(content::artifact_get),
        "artifact.content.get" => typed!(content::artifact_content),
        "artifact.create" => typed!(content::artifact_create),
        "artifact.outline.import" => typed!(content::artifact_outline_import),
        "artifact.version.create" => typed!(content::artifact_version),
        "artifact.block.list" => typed!(content::block_list),
        "artifact.block.create" => typed!(content::block_create),
        "artifact.block.update" => typed!(content::block_update),
        "artifact.block.delete" => typed!(content::block_delete),
        "artifact.block.batch" => typed!(content::block_batch),
        "artifact.type.list" => typed!(content::artifact_type_list),
        "artifact.type.read" => typed!(content::artifact_type_read),
        "artifact.entry.list" => typed!(content::artifact_entry_list),
        "artifact.entry.get" => typed!(content::artifact_entry_get),
        "artifact.entry.batch" => typed!(content::artifact_entry_batch),
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
    pub fn run(&self, tools: &ToolBox, who: &Who, raw: &Value) -> Result<String, String> {
        (self.run)(tools, who, &self.words, raw)
    }

    /// Reads only: safe to run again if the process died while it ran.
    pub fn replay_safe(&self) -> bool {
        let op = self.words.op.as_str();
        op.ends_with(".list") || op.ends_with(".get") || op.ends_with(".read") || op == "memory.search"
    }
}

/// The orchestrator's tool in its loop: run as it is answering now.
pub struct Held {
    pub tool: Tool,
    pub tools: Arc<ToolBox>,
    pub route: Arc<Mutex<Route>>,
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

    fn execute(&self, args: &Value) -> vibevalley_runtime::agent::ToolOutput {
        let route = self.route.lock().clone();
        match self.tool.run(&self.tools, &Who::Orchestrator(route), args) {
            Ok(text) => vibevalley_runtime::agent::ToolOutput::ok(text),
            Err(why) => vibevalley_runtime::agent::ToolOutput::error(why),
        }
    }
}

/// The orchestrator's tools for its loop.
pub fn held(tools: &Arc<ToolBox>, route: &Arc<Mutex<Route>>) -> Vec<Box<dyn vibevalley_runtime::agent::Tool>> {
    orchestrator()
        .into_iter()
        .map(|tool| {
            Box::new(Held {
                tool,
                tools: tools.clone(),
                route: route.clone(),
            }) as Box<dyn vibevalley_runtime::agent::Tool>
        })
        .collect()
}

/// A string argument given and not blank.
fn given(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_tool_runs() {
        assert!(unrun().is_empty(), "{:?}", unrun());
    }

    #[test]
    fn artifact_store_and_block_tools_are_listed_with_expected_replay_safety() {
        for tools in [orchestrator(), helper()] {
            for (op, expected_safe) in [
                ("artifact.type.list", true),
                ("artifact.type.read", true),
                ("artifact.entry.list", true),
                ("artifact.entry.get", true),
                ("artifact.entry.batch", false),
                ("artifact.block.list", true),
                ("artifact.block.batch", false),
                ("artifact.outline.import", false),
            ] {
                let t = tools.iter().find(|t| t.words.op == op).unwrap_or_else(|| panic!("missing {op}"));
                assert_eq!(t.replay_safe(), expected_safe, "replay_safe mismatch for {op}");
            }
        }
    }

    #[test]
    fn a_models_loose_arguments_read() {
        #[derive(Deserialize, Debug)]
        struct A {
            n: i64,
            on: bool,
            text: Option<String>,
        }
        let schema = json!({ "type": "object", "properties": { "n": { "type": "integer" }, "on": { "type": "boolean" }, "text": { "type": "string" } } });
        let a: A = args(&schema, &json!({ "n": "3", "on": "true", "text": null, "extra": 1 })).unwrap();
        assert_eq!((a.n, a.on, a.text), (3, true, None));
        let refused = args::<A>(&schema, &json!({ "n": "three", "on": true }));
        assert!(refused.unwrap_err().starts_with("参数不对"));
    }
}
