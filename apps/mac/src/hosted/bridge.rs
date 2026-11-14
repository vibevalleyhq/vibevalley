//! The Rust <-> TSX protocol, free of GPUI so it can be tested.
//!
//! Rust pushes one state frame per topic as the event `frame:<topic>` with
//! `{ "rev": n, "data": ... }` (`ui/bridge.ts` keeps the latest per topic).
//! Views send intent back with `host.post("action", { "type": ..., ... })`,
//! parsed here into [`Action`].

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};

/// Frames already sent, per topic: a frame equal to the last one is not sent
/// again, so callers may push on every change without diffing themselves.
#[derive(Debug, Default)]
pub struct Outbox {
    last: HashMap<String, (u64, u64)>,
}

impl Outbox {
    /// The envelope to send for `data` on `topic`, or `None` when the view
    /// already has exactly this frame.
    pub fn envelope(&mut self, topic: &str, data: Value) -> Option<(String, Value)> {
        let hash = {
            let mut h = DefaultHasher::new();
            data.to_string().hash(&mut h);
            h.finish()
        };
        let entry = self.last.entry(topic.to_string()).or_insert((0, 0));
        if entry.0 > 0 && entry.1 == hash {
            return None;
        }
        entry.0 += 1;
        entry.1 = hash;
        Some((format!("frame:{topic}"), json!({ "rev": entry.0, "data": data })))
    }

    /// Forget what was sent (the view reloaded and starts empty).
    pub fn reset(&mut self) {
        self.last.clear();
    }

    pub fn rev(&self, topic: &str) -> u64 {
        self.last.get(topic).map_or(0, |e| e.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Choice {
    Primary,
    Secondary,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// The single application router selects a native content surface.
    GlobalRoute {
        path: String,
    },
    GlobalRail {
        rail_width: f32,
    },
    /// The view applied frame `rev` of `topic` (debug bookkeeping).
    Applied {
        topic: String,
        rev: u64,
    },
    /// The view's script started and listens.
    Ready,
    /// A bridge call the shell answers (`host.*` ops; the rest go to the server).
    Call {
        id: String,
        op: String,
        #[serde(default)]
        payload: Value,
    },
    /// The bridge self-test's results (`ui/surfaces/BridgeProbe.tsx`).
    Probe {
        results: Value,
    },
    /// VibeValley's /farm and /farm/<repo>: the farm pane, "" for the whole farm.
    #[serde(rename = "openFarm")]
    OpenFarm {
        #[serde(default)]
        repo: String,
    },
    /// VibeValley's /tree: the memory tree pane.
    #[serde(rename = "openTree")]
    OpenTree,
    /// A terminal pane at `cwd` (any worktree, repo, session or issue).
    OpenTerminal {
        cwd: PathBuf,
        title: Option<String>,
        command: Option<String>,
    },

    ActivateProject {
        id: i64,
    },
    ActivatePath {
        path: PathBuf,
    },
    ActivateTab {
        path: PathBuf,
        tab_id: u64,
    },
    CloseTabAt {
        path: PathBuf,
        tab_id: u64,
    },
    NewTerminalAt {
        path: PathBuf,
    },
    AddProject,
    CloseProject {
        id: i64,
    },
    ShowPanel {
        panel: String,
    },

    ExpandDir {
        path: PathBuf,
    },
    CollapseDir {
        path: PathBuf,
    },
    OpenFile {
        path: PathBuf,
    },
    RevealInTerminal {
        path: PathBuf,
    },

    OpenDiff {
        path: Option<PathBuf>,
        staged: bool,
    },
    Stage {
        paths: Vec<PathBuf>,
    },
    Unstage {
        paths: Vec<PathBuf>,
    },
    Discard {
        paths: Vec<PathBuf>,
    },
    Commit {
        message: String,
    },
    Checkout {
        branch: String,
    },
    OpenCommit {
        id: String,
    },
    RefreshGit,

    PaletteQuery {
        query: String,
    },
    PaletteSelect {
        id: String,
    },
    PaletteClose,

    Search {
        query: String,
        #[serde(default)]
        regex: bool,
        #[serde(default)]
        case_sensitive: bool,
    },
    OpenHit {
        path: PathBuf,
        line: u32,
    },

    Decide {
        id: String,
        choice: Choice,
    },
    CreateTask {
        prompt: String,
        runtime: Option<String>,
    },
    SelectTask {
        id: String,
    },
    PromptTask {
        id: String,
        text: String,
    },
    AbortTask {
        id: String,
    },
}

pub fn parse_action(value: &Value) -> Result<Action, String> {
    Action::deserialize(value).map_err(|e| format!("bad action {value}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_frame_is_sent_once() {
        let mut out = Outbox::default();
        let (name, env) = out.envelope("rail", json!({"a": 1})).unwrap();
        assert_eq!(name, "frame:rail");
        assert_eq!(env["rev"], 1);
        assert_eq!(env["data"]["a"], 1);
        assert!(out.envelope("rail", json!({"a": 1})).is_none());
        let (_, env) = out.envelope("rail", json!({"a": 2})).unwrap();
        assert_eq!(env["rev"], 2);
        assert_eq!(out.rev("rail"), 2);
    }

    #[test]
    fn topics_are_independent_and_reset_resends() {
        let mut out = Outbox::default();
        assert!(out.envelope("a", json!(1)).is_some());
        assert!(out.envelope("b", json!(1)).is_some());
        assert!(out.envelope("a", json!(1)).is_none());
        out.reset();
        assert_eq!(out.envelope("a", json!(1)).unwrap().1["rev"], 1);
    }

    #[test]
    fn empty_frame_is_still_sent_first() {
        let mut out = Outbox::default();
        assert!(out.envelope("t", Value::Null).is_some());
        assert!(out.envelope("t", Value::Null).is_none());
    }

    #[test]
    fn actions_parse() {
        assert_eq!(
            parse_action(&json!({"type": "activate_project", "id": 3})).unwrap(),
            Action::ActivateProject { id: 3 }
        );
        assert_eq!(
            parse_action(&json!({"type": "activate_path", "path": "/tmp/repo"})).unwrap(),
            Action::ActivatePath { path: "/tmp/repo".into() }
        );
        assert_eq!(
            parse_action(&json!({"type": "stage", "paths": ["a.rs", "b/c.rs"]})).unwrap(),
            Action::Stage {
                paths: vec!["a.rs".into(), "b/c.rs".into()]
            }
        );
        assert_eq!(
            parse_action(&json!({"type": "decide", "id": "x", "choice": "secondary"})).unwrap(),
            Action::Decide {
                id: "x".into(),
                choice: Choice::Secondary
            }
        );
        assert_eq!(
            parse_action(&json!({"type": "search", "query": "fn"})).unwrap(),
            Action::Search {
                query: "fn".into(),
                regex: false,
                case_sensitive: false
            }
        );
        assert_eq!(
            parse_action(&json!({"type": "applied", "topic": "rail", "rev": 4})).unwrap(),
            Action::Applied { topic: "rail".into(), rev: 4 }
        );
    }

    #[test]
    fn bad_actions_are_errors() {
        assert!(parse_action(&json!({"type": "nope"})).is_err());
        assert!(parse_action(&json!({"type": "activate_project"})).is_err());
        assert!(parse_action(&json!("activate_project")).is_err());
    }
}
