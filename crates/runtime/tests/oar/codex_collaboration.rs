use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use vibevalley_runtime::oar::{ContentBlock, EventKind, SessionOptions, StopReason, SubagentStatus, ToolAction, tool_action};

#[test]
fn regression_codex_collaboration_survives_process_and_record_replay() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("session.jsonl");
    let session = open_replay(
        dir.path(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex-collaboration.json"),
    );
    let rx = session.events();
    session.prompt(vec![ContentBlock::Text("Review and test".into())]).unwrap();
    let mut events = vec![];
    loop {
        let e = rx.recv_timeout(Duration::from_secs(8)).unwrap();
        let done = e.agent_path.is_empty()
            && matches!(
                e.kind,
                EventKind::TurnFinished {
                    reason: StopReason::Completed,
                    ..
                }
            );
        events.push(e);
        if done {
            break;
        }
    }
    session.dispose();
    let (_, history) = vibevalley_runtime::oar::read_record_with_header(&record).unwrap();
    assert!(history.windows(events.len()).any(|window| window == events.as_slice()));
    let created: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::SubagentSpawned {
                parent_thread_id,
                thread_id,
                task,
                ..
            } => Some((parent_thread_id.as_str(), thread_id.as_str(), task.as_deref())),
            _ => None,
        })
        .collect();
    assert_eq!(
        created,
        [
            ("vendor-root", "review", Some("Review the change")),
            ("vendor-root", "tests", Some("Run the tests"))
        ]
    );
    let wait: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::SubagentWait {
                thread_id,
                call_id,
                targets,
                waiting,
            } => Some((thread_id.as_str(), call_id.as_str(), targets.as_slice(), *waiting)),
            _ => None,
        })
        .collect();
    assert_eq!(wait.len(), 2);
    for (i, (id, call, targets, waiting)) in wait.into_iter().enumerate() {
        assert_eq!((id, call, waiting), ("review", "wait-tests", i == 0));
        assert_eq!(targets, ["tests"]);
    }
    let states: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::SubagentStatusChanged {
                thread_id, turn_id, status, ..
            } if thread_id == "tests" => Some((turn_id.as_deref(), *status)),
            _ => None,
        })
        .collect();
    assert_eq!(
        states,
        [
            (None, SubagentStatus::PendingInit),
            (Some("attempt-1"), SubagentStatus::Running),
            (Some("attempt-1"), SubagentStatus::Errored),
            (Some("attempt-2"), SubagentStatus::Running),
            (Some("attempt-2"), SubagentStatus::Completed)
        ]
    );
    assert!(events.iter().any(|e| e.agent_path == ["tests"]
        && matches!(&e.kind,EventKind::ToolCallStarted{name,input,..} if name=="commandExecution" && tool_action(name,input)==ToolAction::RunCommand)));
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.kind,EventKind::SubagentPlanUpdated{thread_id,turn_id,steps} if thread_id=="tests" && turn_id=="attempt-2" && steps.len()==1))
    );
}

fn open_replay(dir: &Path, spec: &Path) -> std::sync::Arc<dyn vibevalley_runtime::oar::Session> {
    vibevalley_runtime::oar::default_runtimes()
        .require("codex")
        .unwrap()
        .open(SessionOptions {
            cwd: dir.into(),
            bin_path: Some(PathBuf::from(env!("CARGO_BIN_EXE_vv_test_fixture"))),
            env: vec![
                ("VV_FIXTURE".into(), "cli_replay".into()),
                ("OAR_REPLAY_FILE".into(), spec.display().to_string()),
            ],
            record_to: Some(dir.join("session.jsonl")),
            ..Default::default()
        })
        .unwrap()
}

#[test]
fn regression_installed_codex_v2_keeps_agent_paths_and_mailbox_waits_and_reads_only_the_requested_turn() {
    use serde_json::{Value, json};
    let trace: Value = serde_json::from_str(include_str!("../fixtures/codex-0.170.0-collaboration.json")).unwrap();
    let mut calls: Value = serde_json::from_str(include_str!("../fixtures/go-codex.json")).unwrap();
    calls["thread/start"][0]["result"]["thread"]["id"] = json!("root-thread");
    let mut messages = vec![json!({"jsonrpc":"2.0","id":9412,"result":{"turn":{"id":"root-turn"}}})];
    messages.extend(trace["notifications"].as_array().unwrap().iter().cloned());
    calls["turn/start"] = Value::Array(messages);
    let verify = trace["reads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["thread"]["id"] == "verify-thread")
        .unwrap();
    calls["thread/read"] = json!([{"jsonrpc":"2.0","id":9412,"result":verify}]);
    let dir = tempfile::tempdir().unwrap();
    let spec = dir.path().join("responses.json");
    fs::write(&spec, calls.to_string()).unwrap();
    let session = open_replay(dir.path(), &spec);
    let rx = session.events();
    session.prompt(vec![ContentBlock::Text("delegate".into())]).unwrap();
    let mut spawned = vec![];
    let mut waits = vec![];
    let mut ended = vec![];
    let mut messages = vec![];
    loop {
        let e = rx.recv_timeout(Duration::from_secs(8)).unwrap();
        match e.kind {
            EventKind::SubagentSpawned {
                parent_thread_id,
                thread_id,
                task,
                agent_name,
            } => {
                assert_eq!(parent_thread_id, "root-thread");
                assert_eq!(task, None);
                spawned.push((thread_id, agent_name.unwrap()));
            }
            EventKind::SubagentMessage { thread_id, turn_id, text } => messages.push((thread_id, turn_id, text)),
            EventKind::SubagentWait { waiting, targets, .. } => {
                assert!(targets.is_empty());
                waits.push(waiting);
            }
            EventKind::SubagentStatusChanged { thread_id, status, .. } if status != SubagentStatus::Running => ended.push((thread_id, status)),
            EventKind::TurnFinished { reason, .. } if e.agent_path.is_empty() => {
                assert_eq!(reason, StopReason::Completed);
                break;
            }
            _ => {}
        }
    }
    spawned.sort();
    ended.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        spawned,
        [("audit-thread".into(), "/root/audit".into()), ("verify-thread".into(), "/root/verify".into())]
    );
    assert_eq!(
        ended,
        [
            ("audit-thread".into(), SubagentStatus::Completed),
            ("verify-thread".into(), SubagentStatus::Errored)
        ]
    );
    assert_eq!(waits, [true, false]);
    assert_eq!(messages, [("audit-thread".into(), "audit-turn".into(), "Done.".into())]);
    assert!(
        session
            .records()
            .iter()
            .flat_map(|r| &r.events)
            .any(|e| e["kind"] == "subagent_status_changed" && e["threadId"] == "verify-thread" && e["status"] == "errored")
    );
    let failed = session.read_subagent("verify-thread", Some("verify-turn")).unwrap();
    assert_eq!(failed.status, Some(SubagentStatus::Errored));
    assert_eq!(failed.agent_name.as_deref(), Some("/root/verify"));
    assert_eq!(failed.parent_thread_id.as_deref(), Some("root-thread"));
    assert_eq!(failed.message.as_deref(), Some("Fixture failure"));
    assert_eq!(session.read_subagent("verify-thread", Some("other-turn")).unwrap().status, None);
    assert_eq!(session.read_subagent("verify-thread", None).unwrap().status, None);
    assert!(session.read_subagent("different-thread", Some("verify-turn")).is_err());
    session.dispose();
}
