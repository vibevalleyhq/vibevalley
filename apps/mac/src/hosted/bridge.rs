//! The Rust <-> TSX protocol, free of GPUI so it can be tested.
//!
//! Rust pushes one state frame per topic as the event `frame:<topic>` with
//! `{ "rev": n, "data": ... }` (`ui/bridge.ts` keeps the latest per topic).
//! Views send intent back with `host.post("action", { "type": ..., ... })`,
//! parsed here into [`Action`].

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Value, json};
pub use vibevalley_protocol::{HostAction as Action, HostPanel as Panel};

/// Frames already sent, per topic: a frame equal to the last one is not sent
/// again, so callers may push on every change without diffing themselves.
#[derive(Debug, Default)]
pub struct Outbox {
    last: HashMap<String, (u64, Value)>,
}

impl Outbox {
    /// The envelope to send for `data` on `topic`, or `None` when the view
    /// already has an identical `Value` (avoiding re-serialization and bridge sends).
    pub fn envelope(&mut self, topic: &str, data: Value) -> Option<(String, Value)> {
        let entry = self.last.entry(topic.to_string()).or_insert((0, Value::Null));
        if entry.0 > 0 && entry.1 == data {
            return None;
        }
        entry.0 += 1;
        entry.1 = data.clone();
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
            (json!({"type": "toggle_devtools"}), Action::ToggleDevtools),
            (json!({"type": "detach_devtools"}), Action::DetachDevtools),
            (json!({"type": "close_devtools"}), Action::CloseDevtools),
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
    fn host_op_from_wire_round_trips_representative_ops_and_errors() {
        use vibevalley_protocol::{
            HostCaptureWebViewPayload, HostFontPayload, HostMotionChoice, HostOp, HostOpeningPayload, HostOpeningPhase, HostPlaySoundPayload, HostQrPayload,
            HostSoundName, HostThemeChoice, Locale,
        };
        use vibevalley_server::gateway::bridge::BizCode;

        let cases = vec![
            ("host.info", json!(null), HostOp::Info),
            ("host.updateState", json!({}), HostOp::UpdateState),
            ("host.updateCheck", json!(null), HostOp::UpdateCheck),
            ("host.updateInstall", json!({}), HostOp::UpdateInstall),
            ("host.assetsDir", json!({}), HostOp::AssetsDir),
            ("host.locale", json!("en"), HostOp::Locale(Locale::En)),
            ("host.theme", json!("dark"), HostOp::Theme(HostThemeChoice::Dark)),
            ("host.motion", json!("off"), HostOp::Motion(HostMotionChoice::Off)),
            (
                "host.font",
                json!({ "monoFont": "Menlo", "uiFontSize": 14.0 }),
                HostOp::Font(HostFontPayload {
                    mono_font: Some("Menlo".into()),
                    terminal_font_size: None,
                    ui_font_size: Some(14.0),
                }),
            ),
            (
                "host.opening",
                json!({ "phase": "ready", "progress": 100.0 }),
                HostOp::Opening(HostOpeningPayload {
                    phase: HostOpeningPhase::Ready,
                    progress: 100.0,
                }),
            ),
            (
                "host.playSound",
                json!({ "name": "tap" }),
                HostOp::PlaySound(HostPlaySoundPayload { name: HostSoundName::Tap }),
            ),
            (
                "host.qr",
                json!({ "text": "https://vibevalley.dev", "border": 2 }),
                HostOp::Qr(HostQrPayload {
                    text: "https://vibevalley.dev".into(),
                    border: Some(2),
                }),
            ),
            (
                "host.captureWebView",
                json!({ "width": 640, "height": 400 }),
                HostOp::CaptureWebView(HostCaptureWebViewPayload {
                    width: Some(640),
                    height: Some(400),
                }),
            ),
        ];

        for (wire_op, payload, expected) in cases {
            let decoded = crate::host::decode_host_op(wire_op, payload).unwrap_or_else(|e| panic!("{wire_op}: {}", e.message));
            assert_eq!(decoded, expected);
            assert_eq!(decoded.op_name(), wire_op);
            let encoded = serde_json::to_value(&decoded).unwrap();
            assert_eq!(encoded["op"], wire_op);
        }

        let unknown = crate::host::decode_host_op("host.unknownOp", json!({})).unwrap_err();
        assert_eq!(unknown.biz_code, BizCode::RouteNotFound.code());
        let bad_payload = crate::host::decode_host_op("host.theme", json!("neon")).unwrap_err();
        assert_eq!(bad_payload.biz_code, BizCode::InvalidInput.code());
    }

    #[test]
    fn bad_actions_are_errors() {
        assert!(parse_action(&json!({"type": "nope"})).is_err());
        assert!(parse_action(&json!({"type": "activate_project"})).is_err());
        assert!(parse_action(&json!("activate_project")).is_err());
    }

    #[test]
    fn outbox_dedup_skips_identical_payloads_forwards_changes_and_replays_on_ready() {
        let mut out = Outbox::default();
        let rail_v1 = json!({
            "projects": [{ "id": 1, "name": "vibevalley", "active": true, "tabs": [{ "id": 10, "title": "Chat" }] }],
            "panel": "files",
            "inspectorOpen": true
        });
        let files_v1 = json!({ "root": "/repo", "items": [{ "id": "src", "tone": "clean" }] });
        let git_v1 = json!({ "repo": true, "branch": "main", "changes": [] });
        let palette_v1 = json!({ "mode": "commands", "query": "", "items": ["a", "b"] });

        // First push for each topic emits rev 1.
        for (topic, payload) in [
            ("rail", rail_v1.clone()),
            ("files", files_v1.clone()),
            ("git", git_v1.clone()),
            ("palette", palette_v1.clone()),
        ] {
            let (event, env) = out.envelope(topic, payload.clone()).expect("initial frame must send");
            assert_eq!(event, format!("frame:{topic}"));
            assert_eq!(env["rev"], 1);
            assert_eq!(env["data"], payload);
            assert!(out.envelope(topic, payload).is_none(), "identical consecutive {topic} payload must be skipped");
        }

        // Changed payload emits rev 2; reverting back to v1 emits rev 3.
        let rail_v2 = json!({
            "projects": [{ "id": 1, "name": "vibevalley", "active": true, "tabs": [{ "id": 10, "title": "Updated" }] }],
            "panel": "git",
            "inspectorOpen": true
        });
        let (_, env2) = out.envelope("rail", rail_v2.clone()).expect("changed rail must send");
        assert_eq!(env2["rev"], 2);
        assert!(out.envelope("rail", rail_v2).is_none());
        let (_, env3) = out.envelope("rail", rail_v1.clone()).expect("reverted rail must send");
        assert_eq!(env3["rev"], 3);

        // Ready reload clears outbox so replayed frames send cleanly from rev 1.
        out.reset();
        assert_eq!(out.rev("rail"), 0);
        let (_, replayed) = out.envelope("rail", rail_v1).expect("replay after Ready must send");
        assert_eq!(replayed["rev"], 1);
    }
}
