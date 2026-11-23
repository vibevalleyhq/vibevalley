//! The Rust <-> TSX protocol, free of GPUI so it can be tested.
//!
//! Rust pushes one state frame per topic as the event `frame:<topic>` with
//! `{ "rev": n, "data": ... }` (`ui/bridge.ts` keeps the latest per topic).
//! Views send intent back with `host.post("action", { "type": ..., ... })`,
//! parsed here into [`Action`].

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};

use serde::Deserialize;
use serde_json::{Value, json};
pub use vibevalley_protocol::{HostAction as Action, HostPanel as Panel};

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
    fn actions_parse_and_round_trip() {
        let cases = vec![
            (json!({"type": "activate_project", "id": 3}), Action::ActivateProject { id: 3 }),
            (
                json!({"type": "activate_path", "path": "/tmp/repo"}),
                Action::ActivatePath { path: "/tmp/repo".into() },
            ),
            (
                json!({"type": "stage", "paths": ["a.rs", "b/c.rs"]}),
                Action::Stage {
                    paths: vec!["a.rs".into(), "b/c.rs".into()],
                },
            ),
            (
                json!({"type": "search", "query": "fn"}),
                Action::Search {
                    query: "fn".into(),
                    regex: false,
                    case_sensitive: false,
                },
            ),
            (
                json!({"type": "applied", "topic": "slice:board", "rev": 4}),
                Action::Applied {
                    topic: "slice:board".into(),
                    rev: 4,
                },
            ),
            (json!({"type": "show_panel", "panel": "git"}), Action::ShowPanel { panel: Panel::Git }),
            (
                json!({"type": "new_chat_at", "path": "/tmp/repo", "runtime": "antigravity"}),
                Action::NewChatAt {
                    path: "/tmp/repo".into(),
                    runtime: Some("antigravity".into()),
                },
            ),
            (
                json!({"type": "open_file_adjacent", "path": "src/lib.rs", "line": 42}),
                Action::OpenFileAdjacent {
                    path: "src/lib.rs".into(),
                    line: Some(42),
                },
            ),
            (
                json!({"type": "open_diff_adjacent", "path": "src/lib.rs", "staged": true}),
                Action::OpenDiffAdjacent {
                    path: Some("src/lib.rs".into()),
                    staged: true,
                },
            ),
            (
                json!({"type": "bind_chat_session", "tab_id": 7, "session_id": "s1", "runtime": "claude"}),
                Action::BindChatSession {
                    tab_id: 7,
                    session_id: "s1".into(),
                    runtime: Some("claude".into()),
                },
            ),
            (
                json!({"type": "openFarm", "repo": "vibevalley"}),
                Action::OpenFarm { repo: "vibevalley".into() },
            ),
            (json!({"type": "openRepoMap"}), Action::OpenRepoMap),
            (json!({"type": "openTree"}), Action::OpenTree),
        ];
        for (raw, expected) in cases {
            let parsed = parse_action(&raw).unwrap();
            assert_eq!(parsed, expected);
            let encoded = serde_json::to_value(&parsed).unwrap();
            assert_eq!(parse_action(&encoded).unwrap(), expected);
        }
        assert!(parse_action(&json!({"type": "show_panel", "panel": "unknown"})).is_err());
    }

    #[test]
    fn bad_actions_are_errors() {
        assert!(parse_action(&json!({"type": "nope"})).is_err());
        assert!(parse_action(&json!({"type": "activate_project"})).is_err());
        assert!(parse_action(&json!("activate_project")).is_err());
    }
}
