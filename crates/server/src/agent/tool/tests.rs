use serde::Deserialize;
use serde_json::json;
use vibevalley_protocol::{Agent, AgentRole, Build, Head, Look, PersonaMode, Toolset};

use super::dispatch::parse_args;
use super::toolset::{Role, allows, can_role, toolset_of};
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

#[test]
fn every_tool_maps_to_a_toolset_and_respects_role_can_narrowing() {
    for t in orchestrator() {
        assert!(toolset_of(&t.words.op).is_some(), "unmapped orchestrator op: {}", t.words.op);
        assert!(can_role(&t.words.op, Role::Orchestrator), "orchestrator denied {}", t.words.op);
    }
    for t in helper() {
        assert!(toolset_of(&t.words.op).is_some(), "unmapped helper op: {}", t.words.op);
        assert!(can_role(&t.words.op, Role::Helper), "helper denied {}", t.words.op);
    }

    let profile = Agent {
        id: "w".into(),
        name: "w".into(),
        role: AgentRole::Worker,
        duty: String::new(),
        enabled: true,
        runtime: "scripted".into(),
        machine_id: None,
        model: String::new(),
        effort: String::new(),
        persona: String::new(),
        persona_mode: PersonaMode::Append,
        skills: vec![],
        toolsets: vec![Toolset::Issue],
        mcp_servers: vec![],
        disallowed_tools: vec!["issue_report".into()],
        env: Default::default(),
        workdir: String::new(),
        worktree: false,
        tags: vec![],
        look: Look {
            species: None,
            outfit: None,
            orchestrator: None,
            build: Build::Biped,
            head: Head::Rounded,
            body: String::new(),
            trim: String::new(),
            hat: String::new(),
            eye: String::new(),
            avatar: None,
        },
        from: None,
    };

    assert!(allows(Some(&profile), "issue.list", "issue_list", Role::Helper));
    assert!(!allows(Some(&profile), "issue.report", "issue_report", Role::Helper));
    assert!(!allows(Some(&profile), "memory.search", "memory_search", Role::Helper));
    assert!(!allows(Some(&profile), "issue.create", "issue_create", Role::Helper));
}
