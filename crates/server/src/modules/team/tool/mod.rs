//! The farm's tools, one set for the orchestrator and the helpers: each
//! tool takes its arguments as a typed struct, read leniently from what a
//! model wrote, and answers in words for the model. What the model sees of a
//! tool (name, description, JSON Schema) is in `assets/tools/`, which this
//! crate owns; who may call which is the file the tool is listed in.

mod chat;
mod issue;
mod memory;
mod notes;
mod plan;

use std::sync::{Arc, LazyLock, Mutex};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use vibevalley_protocol::{Issue, Session};

use crate::modules::collab::channel::Chat;
use crate::modules::team::agent::Agents;
use crate::modules::team::orchestrator::words;
use crate::modules::work::cron::Crons;
use crate::modules::work::issue::Board;
use crate::modules::work::pull::Pulls;
use crate::modules::work::repo::Repos;

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

/// What the tools reach.
pub struct Farm {
    pub board: Board,
    pub chat: Arc<Chat>,
    pub agents: Arc<Agents>,
    pub repos: Arc<Repos>,
    pub pulls: Arc<Pulls>,
    pub crons: Arc<Crons>,
    pub memories: Arc<crate::modules::team::memory::Memories>,
    pub media: Arc<crate::modules::content::media::jobs::Jobs>,
    pub pkm: Arc<crate::modules::content::pkm::Pkm>,
    pub artifacts: Arc<crate::modules::content::artifact::Artifacts>,
    pub library: Arc<crate::modules::content::library::Library>,
    pub resources: Arc<crate::modules::team::mcp::Resources>,
}

impl Farm {
    /// An issue by id, `#n`, number, or the id or name of a helper on it.
    fn issue(&self, key: &str) -> Result<Issue, String> {
        let key = key.trim();
        let k = key.trim_start_matches('#');
        let found = self.board.read(|s| {
            s.issues.iter().find(|i| i.id == key || i.number.to_string() == k).cloned().or_else(|| {
                let on = s.sessions.iter().filter(|h| h.id == k || h.name == k).max_by_key(|h| h.hired_at)?;
                s.issues.iter().find(|i| Some(&i.id) == on.issue.as_ref()).cloned()
            })
        });
        found.ok_or_else(|| words::no_issue(key))
    }

    fn worker_of(&self, issue: &Issue) -> Option<Session> {
        let last = issue.latest_session_id()?;
        self.board.read(|s| s.sessions.iter().find(|h| &h.id == last).cloned())
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
        let issue = session.issue.as_ref()?;
        self.board.read(|s| s.issues.iter().find(|i| &i.id == issue).map(|i| i.number))
    }

    /// Every helper on the farm.
    pub fn roster(&self) -> Vec<Session> {
        self.board.read(|s| {
            s.sessions
                .iter()
                .filter(|h| h.role == vibevalley_protocol::AgentRole::Worker)
                .cloned()
                .collect()
        })
    }

    pub fn session_line(&self, h: &Session) -> String {
        words::session_line(h, crate::now(), self.number_of(h))
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
type Run = fn(&Farm, &Who, &Words, &Value) -> Result<String, String>;

/// A tool as one caller holds it.
#[derive(Clone)]
pub struct Tool {
    pub words: Words,
    run: Run,
}

/// `run` for a tool whose arguments read as `A`.
macro_rules! typed {
    ($f:path) => {
        |farm: &Farm, who: &Who, words: &Words, raw: &Value| $f(farm, who, $crate::modules::team::tool::args(&words.parameters, raw)?)
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
        "resource.read" => typed!(notes::resource_read),
        "memory.search" => typed!(memory::search),
        "memory.create" => typed!(memory::create),
        "pkm.search" => typed!(notes::pkm_search),
        "pkm.page.get" => typed!(notes::pkm_page),
        "pkm.capture" => typed!(notes::pkm_capture),
        "pkm.comment.suggest" => typed!(notes::pkm_suggest),
        "media.image.create" => typed!(notes::image),
        "media.speech.create" => typed!(notes::speech),
        "media.dialogue.create" => typed!(notes::dialogue),
        "media.voiceDesign.create" => typed!(notes::voice_design),
        "media.understanding.start" => typed!(notes::understand),
        "media.job.get" => typed!(notes::job_get),
        "media.job.list" => typed!(notes::job_list),
        "media.job.cancel" => typed!(notes::job_cancel),
        "media.job.download" => typed!(notes::job_download),
        "library.item.list" => typed!(notes::library_list),
        "library.item.add" => typed!(notes::library_add),
        "artifact.list" => typed!(notes::artifact_list),
        "artifact.get" => typed!(notes::artifact_get),
        "artifact.content.get" => typed!(notes::artifact_content),
        "artifact.create" => typed!(notes::artifact_create),
        "artifact.version.create" => typed!(notes::artifact_version),
        "artifact.block.create" => typed!(notes::block_create),
        "artifact.block.update" => typed!(notes::block_update),
        "artifact.block.delete" => typed!(notes::block_delete),
        "artifact.type.list" => typed!(notes::artifact_type_list),
        "artifact.type.read" => typed!(notes::artifact_type_read),
        "artifact.entry.list" => typed!(notes::artifact_entry_list),
        "artifact.entry.get" => typed!(notes::artifact_entry_get),
        "artifact.entry.batch" => typed!(notes::artifact_entry_batch),
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
    pub fn run(&self, farm: &Farm, who: &Who, raw: &Value) -> Result<String, String> {
        (self.run)(farm, who, &self.words, raw)
    }

    /// Reads only: safe to run again if the process died while it ran.
    pub fn replay_safe(&self) -> bool {
        let op = self.words.op.as_str();
        op.ends_with(".list") || op.ends_with(".get") || op.ends_with(".read") || op == "memory.search" || op == "pkm.search"
    }
}

/// The orchestrator's tool in its loop: run as it is answering now.
pub struct Held {
    pub tool: Tool,
    pub farm: Arc<Farm>,
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
        let route = self.route.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match self.tool.run(&self.farm, &Who::Orchestrator(route), args) {
            Ok(text) => vibevalley_runtime::agent::ToolOutput::ok(text),
            Err(why) => vibevalley_runtime::agent::ToolOutput::error(why),
        }
    }
}

/// The orchestrator's tools for its loop.
pub fn held(farm: &Arc<Farm>, route: &Arc<Mutex<Route>>) -> Vec<Box<dyn vibevalley_runtime::agent::Tool>> {
    orchestrator()
        .into_iter()
        .map(|tool| {
            Box::new(Held {
                tool,
                farm: farm.clone(),
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
    fn artifact_store_tools_are_listed_with_expected_replay_safety() {
        for tools in [orchestrator(), helper()] {
            for (op, expected_safe) in [
                ("artifact.type.list", true),
                ("artifact.type.read", true),
                ("artifact.entry.list", true),
                ("artifact.entry.get", true),
                ("artifact.entry.batch", false),
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
