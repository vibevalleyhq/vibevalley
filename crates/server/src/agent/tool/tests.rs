use serde::Deserialize;
use serde_json::json;

use super::dispatch::parse_args;
use super::{helper, orchestrator, unrun};

#[test]
fn every_listed_tool_runs() {
    assert!(unrun().is_empty(), "{:?}", unrun());
}

#[test]
fn artifact_directory_tools_are_listed_with_expected_replay_safety() {
    for tools in [orchestrator(), helper()] {
        for (op, expected_safe) in [
            ("issue.list", true),
            ("issue.get", true),
            ("artifact.type.list", true),
            ("artifact.type.read", true),
            ("artifact.file.list", true),
            ("artifact.file.get", true),
            ("artifact.file.write", false),
            ("artifact.file.delete", false),
            ("artifact.suggestion.list", true),
            ("artifact.suggestion.create", false),
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
    let a: A = parse_args(&schema, &json!({ "n": "3", "on": "true", "text": null, "extra": 1 }).to_string()).unwrap();
    assert_eq!((a.n, a.on, a.text), (3, true, None));
    let refused = parse_args::<A>(&schema, &json!({ "n": "three", "on": true }).to_string());
    assert!(refused.unwrap_err().starts_with("参数不对"));
}
