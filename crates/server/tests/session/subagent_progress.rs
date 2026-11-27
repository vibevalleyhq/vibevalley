use super::until;
use crate::support::RouterTestExt as _;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
use vibevalley_protocol::Caller;
use vibevalley_runtime::oar::{
    EventKind, Registry, SubagentPlanStatus, SubagentPlanStep, SubagentStatus,
    scripted::{Script, ScriptedRuntime, Step},
};
use vibevalley_server::{App, Config, create_app_blocking};

fn open(home: &Path) -> App {
    let mut steps = vec![
        Step::Emit(EventKind::SubagentSpawned {
            parent_thread_id: "parent".into(),
            thread_id: "tester".into(),
            agent_name: Some("/root/tester".into()),
            task: Some("Check the project".into()),
        }),
        Step::Emit(EventKind::SubagentStatusChanged {
            thread_id: "tester".into(),
            status: SubagentStatus::Running,
            turn_id: Some("t1".into()),
            message: None,
        }),
        Step::Emit(EventKind::SubagentPlanUpdated {
            thread_id: "tester".into(),
            turn_id: "t1".into(),
            steps: vec![SubagentPlanStep {
                step: "Tests".into(),
                status: SubagentPlanStatus::InProgress,
            }],
        }),
    ];
    // Alternating sources produce separate journal steps even when both are streaming text.
    for n in 0..242 {
        steps.push(Step::EmitFrom(vec![format!("other-{}", n % 2)], EventKind::TextDelta { text: "output".into() }));
    }
    steps.extend([
        Step::EmitFrom(
            vec!["tester".into()],
            EventKind::ToolCallStarted {
                id: "call".into(),
                name: "commandExecution".into(),
                input: json!({"command":"cargo test"}),
            },
        ),
        Step::EmitFrom(
            vec!["tester".into()],
            EventKind::ToolCallFinished {
                id: "call".into(),
                ok: true,
                output: "ok".into(),
            },
        ),
        Step::Emit(EventKind::SubagentStatusChanged {
            thread_id: "tester".into(),
            turn_id: Some("t1".into()),
            status: SubagentStatus::Completed,
            message: Some("Tests passed".into()),
        }),
        Step::text("done"),
    ]);
    let mut registry = Registry::new();
    registry.register(Arc::new(ScriptedRuntime::new(
        "scripted",
        Script::new().turn(steps).turn(vec![Step::text("next")]),
    )));
    create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        ..Config::under(home)
    })
    .unwrap()
}

fn call(server: &App, op: &str, body: Value) -> Value {
    let response = server.router().call_as(Caller::User, op, body);
    response.data.unwrap_or_else(|| panic!("{op}: {}", response.message))
}

#[test]
fn regression_child_progress_outlives_log_retention_and_reopen() {
    let home = tempfile::tempdir().unwrap();
    let server = open(home.path());
    let mut worker = vibevalley_runtime::rt::block_on(server.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    worker.runtime = "scripted".into();
    let worker = vibevalley_runtime::rt::block_on(server.test_internals().agent.profile.store.save_async(worker)).unwrap();
    call(&server, "repo.create", json!({"name":"progress"}));
    let issue = call(&server, "issue.create", json!({"repo":"progress","agent":worker.id,"title":"Run checks"}));
    let id = issue["id"].as_str().unwrap();
    call(&server, "issue.status.update", json!({"id":id,"status":"todo"}));

    let session = until("completed business round", || {
        crate::support::board_sessions(server.test_internals().board)
            .into_iter()
            .find(|s| s.issue_id() == Some(id) && s.last_run.is_some())
    });
    let session_id = session.id.as_str();
    let summary = call(&server, "session.get", json!({"id":session_id}))["subagents"].clone();
    assert_eq!(summary["threads"][0]["status"], "completed");
    assert_eq!(summary["threads"][0]["parentThreadId"], "parent");
    assert_eq!(summary["threads"][0]["lastActivity"], "Tests passed");
    assert_eq!(summary["threads"][0]["steps"][0]["step"], "Tests");
    let page = call(&server, "session.event.list", json!({"id":session_id,"limit":1000}));
    let log = page["events"].as_array().unwrap();
    assert!(log.len() > 240, "expected >240 SQLite-persisted events, got {}", log.len());
    assert!(!page["hasMore"].as_bool().unwrap());
    assert!(log.iter().any(|e| e["type"] == "run/start"));
    let tool = log.iter().find(|e| e["tool"] == "commandExecution").expect("retained child command");
    assert_eq!(tool["threadId"], "tester");
    assert_eq!(tool["action"], "run_command");
    assert_eq!(tool["run"], summary["run"]);
    let tail_page = call(&server, "session.event.list", json!({"id":session_id,"limit":50}));
    assert_eq!(tail_page["events"].as_array().unwrap().len(), 50);
    assert_eq!(tail_page["hasMore"], true);
    let head_page = call(
        &server,
        "session.event.list",
        json!({"id":session_id,"beforeSeq":tail_page["oldestSeq"],"limit":1000}),
    );
    assert_eq!(head_page["hasMore"], false);
    assert_eq!(
        head_page["events"].as_array().unwrap().len() + 50,
        log.len(),
        "cursor pagination must reconstruct full SQLite log without gaps"
    );
    server.close_blocking();
    drop(server);
    let reopened = open(home.path());
    assert_eq!(call(&reopened, "session.get", json!({"id":session_id}))["subagents"], summary);
    let reopened_page = call(&reopened, "session.event.list", json!({"id":session_id,"limit":1000}));
    assert_eq!(reopened_page["events"].as_array().unwrap().len(), log.len());
    let runs = call(&reopened, "issue.run.list", json!({"id":id}));
    assert_eq!(runs[0]["subagents"], summary);
    reopened.close_blocking();
}
