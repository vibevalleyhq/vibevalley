use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;
use vibevalley_protocol::{
    ActorKind, Agent, AgentRole, Build, ContextRef, CronRequest, CronWhen, CronWhenEvery, CronWhenOnce, ExecutionPolicy, Head, Look, MandateStrength,
    PersonaMode, Session, SessionController, Toolset,
};
use vibevalley_runtime::oar::Registry;
use vibevalley_runtime::oar::scripted::ScriptedRuntime;

use super::dispatch::parse_args;
use super::toolset::{Role, allows, can_role, toolset_of};
use super::{Route, RouteSource, Who, helper, orchestrator, unrun};
use crate::{Config, create_app};

#[test]
fn every_listed_tool_runs() {
    assert!(unrun().is_empty(), "{:?}", unrun());
}

#[test]
fn note_directory_tools_are_listed_with_expected_replay_safety() {
    for tools in [orchestrator(), helper()] {
        for (op, expected_safe) in [
            ("issue.list", true),
            ("issue.get", true),
            ("note.type.list", true),
            ("note.type.read", true),
            ("note.link.list", true),
            ("note.doc.view", true),
            ("note.base.view", true),
            ("note.tree.move", false),
            ("note.doc.appendBlock", false),
            ("note.base.upsertRow", false),
            ("note.file.list", true),
            ("note.file.get", true),
            ("note.file.write", false),
            ("note.file.delete", false),
            ("note.suggestion.list", true),
            ("note.suggestion.create", false),
        ] {
            let t = tools.iter().find(|t| t.words.op == op).unwrap_or_else(|| panic!("missing {op}"));
            assert_eq!(t.replay_safe(), expected_safe, "replay_safe mismatch for {op}");
        }
    }
    let run_col = orchestrator()
        .into_iter()
        .find(|t| t.words.op == "note.base.runAgentColumn")
        .expect("missing note.base.runAgentColumn");
    assert!(!run_col.replay_safe());
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
        code: "W-01".into(),
        name: "w".into(),
        role: AgentRole::Worker,
        mode: vibevalley_protocol::AgentExecutionMode::Managed,
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
        voice: None,
        from: None,
    };

    assert!(allows(Some(&profile), "issue.list", "issue_list", Role::Helper));
    assert!(!allows(Some(&profile), "issue.report", "issue_report", Role::Helper));
    assert!(!allows(Some(&profile), "memory.search", "memory_search", Role::Helper));
    assert!(!allows(Some(&profile), "issue.create", "issue_create", Role::Helper));
}

#[tokio::test]
async fn four_tier_issue_authorization_hard_gates_enforce_user_patrol_and_cron_rules() {
    let dir = tempfile::tempdir().unwrap();
    let repo_dir = dir.path().join("repos").join("demo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    std::process::Command::new("git").args(["init"]).current_dir(&repo_dir).output().unwrap();
    std::process::Command::new("git")
        .args(["config", "user.email", "t@e.st"])
        .current_dir(&repo_dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.name", "t"])
        .current_dir(&repo_dir)
        .output()
        .unwrap();
    std::fs::write(repo_dir.join("README.md"), "hi\n").unwrap();
    std::process::Command::new("git")
        .args(["add", "README.md"])
        .current_dir(&repo_dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(&repo_dir)
        .output()
        .unwrap();

    let mut reg = Registry::new();
    reg.register(Arc::new(ScriptedRuntime::demo()));
    let app = create_app(Config {
        registry: Some(Arc::new(reg)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..Config::under(dir.path())
    })
    .await
    .unwrap();
    let tools = app.test_internals().agent.tool.clone();
    let crons = app.test_internals().cron.clone();
    let channel = app.test_internals().channel.default_channel();

    let run_orch = |name: &str, route: Route, args: serde_json::Value| {
        let tools = tools.clone();
        let tool = orchestrator().into_iter().find(|t| t.words.name == name).unwrap();
        async move { tool.run_async(&tools, &Who::Orchestrator(route), &args.to_string()).await }
    };

    let patrol_route = Route {
        agent: "orchestrator".into(),
        channel: channel.clone(),
        user: false,
        source: Some(RouteSource::Patrol),
        ..Default::default()
    };
    let user_route = Route {
        agent: "orchestrator".into(),
        channel: channel.clone(),
        user: true,
        source: Some(RouteSource::User),
        ..Default::default()
    };

    // Tier 1: Patrol cannot issue_create(start=true) or draft=true.
    let err = run_orch(
        "issue_create",
        patrol_route.clone(),
        json!({ "title": "Patrol start", "repo": "demo", "start": true }),
    )
    .await
    .unwrap_err();
    assert!(err.contains("缺少授权"), "{err}");

    // Patrol CAN create a backlog note (start=false), recorded with Inferred mandate.
    let noted = run_orch("issue_create", patrol_route.clone(), json!({ "title": "Patrol backlog note", "repo": "demo" }))
        .await
        .unwrap();
    assert!(noted.contains("在备选里"), "{noted}");
    let inferred_issue = app
        .test_internals()
        .board
        .issues_async()
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.title == "Patrol backlog note")
        .unwrap();
    assert_eq!(inferred_issue.mandate.strength, MandateStrength::Inferred);

    // Tier 3: Patrol cannot update or move issue status.
    assert!(
        run_orch("issue_update", patrol_route.clone(), json!({ "id": inferred_issue.id, "priority": "high" }))
            .await
            .is_err()
    );
    assert!(
        run_orch(
            "issue_status_update",
            patrol_route.clone(),
            json!({ "id": inferred_issue.id, "status": "todo" })
        )
        .await
        .is_err()
    );

    // Tier 4: Patrol cannot mark done.
    assert!(
        run_orch(
            "issue_status_update",
            patrol_route.clone(),
            json!({ "id": inferred_issue.id, "status": "done" })
        )
        .await
        .is_err()
    );

    // Tier 2: Helper on an Inferred mandate issue cannot issue_split.
    let mut inferred_helper = Session::new("w-inf", SessionController::IssueBoard, "h", "scripted", ExecutionPolicy::SandboxDir, 1);
    inferred_helper.attach_binding(ContextRef::Issue {
        id: inferred_issue.id.clone(),
        refining: None,
    });
    let split_tool = helper().into_iter().find(|t| t.words.name == "issue_split").unwrap();
    let split_err = split_tool
        .run_async(
            &tools,
            &Who::Helper(Box::new(inferred_helper)),
            &json!({ "tasks": [{ "id": "a", "title": "A", "brief": "do a" }] }).to_string(),
        )
        .await
        .unwrap_err();
    assert!(split_err.contains("Inferred Mandate"), "{split_err}");

    // Unapproved agent-created Once lookback cron MUST be denied for start/update/done.
    let lookback_cron = crons
        .add_resolved_async(
            CronRequest {
                name: "lookback".into(),
                text: "check".into(),
                channel: None,
                agent: None,
                repo: None,
                when: CronWhen::Once(CronWhenOnce { at: app.ctx().now() + 60_000 }),
                tz: None,
            },
            ActorKind::Agent,
            channel.clone(),
            String::new(),
            String::new(),
            None,
        )
        .await
        .unwrap();
    let lookback_route = Route {
        agent: "orchestrator".into(),
        channel: channel.clone(),
        user: false,
        source: Some(RouteSource::Cron),
        cron_id: Some(lookback_cron.id.clone()),
        ..Default::default()
    };
    assert!(
        run_orch(
            "issue_create",
            lookback_route.clone(),
            json!({ "title": "Sneaky cron", "repo": "demo", "start": true })
        )
        .await
        .is_err()
    );
    assert!(
        run_orch("issue_update", lookback_route, json!({ "id": inferred_issue.id, "priority": "low" }))
            .await
            .is_err()
    );

    // User-approved recurring cron permits Tier 1 (create+start) & Tier 3 (update), but still denies Tier 4 (done)!
    let pending_cron = crons
        .add_resolved_async(
            CronRequest {
                name: "recurring".into(),
                text: "nightly check".into(),
                channel: None,
                agent: None,
                repo: None,
                when: CronWhen::Every(CronWhenEvery { minutes: 30 }),
                tz: None,
            },
            ActorKind::Agent,
            channel.clone(),
            String::new(),
            String::new(),
            None,
        )
        .await
        .unwrap();
    assert!(pending_cron.pending);
    let pending_route = Route {
        agent: "orchestrator".into(),
        channel: channel.clone(),
        user: false,
        source: Some(RouteSource::Cron),
        cron_id: Some(pending_cron.id.clone()),
        ..Default::default()
    };
    // Before approval -> denied.
    assert!(
        run_orch("issue_update", pending_route.clone(), json!({ "id": inferred_issue.id, "priority": "high" }))
            .await
            .is_err()
    );
    // Approve via user `cron.update`.
    crons.update_endpoint_async(&pending_cron.id, Some(true)).await.unwrap();

    // Now approved cron permits Tier 3 update and Tier 1 create(start=true).
    let updated = run_orch("issue_update", pending_route.clone(), json!({ "id": inferred_issue.id, "priority": "high" }))
        .await
        .unwrap();
    assert!(updated.contains("改好了"), "{updated}");

    // Tier 4 (`done`) STILL rejected on approved cron!
    let done_err = run_orch("issue_status_update", pending_route, json!({ "id": inferred_issue.id, "status": "done" }))
        .await
        .unwrap_err();
    assert!(done_err.contains("定时回合一律拦截"), "{done_err}");

    // User route succeeds on Tier 4 (`done`) too (for an answer/unstarted issue).
    let ans_res = run_orch("issue_create", user_route.clone(), json!({ "title": "User answer", "deliver": "answer" }))
        .await
        .unwrap();
    assert!(ans_res.contains("记下了"), "{ans_res}");
    let ans_issue = app
        .test_internals()
        .board
        .issues_async()
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.title == "User answer")
        .unwrap();
    // Helper on ReadOnlyAnswer cannot issue_split even with Explicit mandate.
    let mut ro_helper = Session::new("w-ro", SessionController::IssueBoard, "h", "scripted", ExecutionPolicy::SandboxDir, 2);
    ro_helper.attach_binding(ContextRef::Issue {
        id: ans_issue.id.clone(),
        refining: None,
    });
    assert!(
        tools
            .call_helper_async(
                ro_helper,
                "issue_split",
                &json!({ "tasks": [{ "id": "x", "title": "X", "brief": "x" }] }).to_string(),
            )
            .await
            .is_err()
    );
    // User can complete (`done`).
    let done_ok = run_orch("issue_status_update", user_route, json!({ "id": ans_issue.id, "status": "done" }))
        .await
        .unwrap();
    assert!(done_ok.contains('#'), "{done_ok}");

    app.close().await;
}
