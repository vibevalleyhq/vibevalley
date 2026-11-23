//! Sessions' work logs (VibeValley `journal.test.ts`), `session.*` and the
//! `issue.watch` stream over a scripted session.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use vibevalley_core::empty_space_state;
use vibevalley_protocol::{Caller, SessionEvent, ToolAction};
use vibevalley_server::modules::work::session::{Journal, Trajectories};
use vibevalley_server::{Hub, Server};

fn line(e: &SessionEvent) -> String {
    let t = serde_json::to_value(e.r#type).unwrap();
    format!(
        "{} {} {} {} {} {}",
        e.seq,
        t.as_str().unwrap(),
        e.text,
        e.output.clone().unwrap_or_default(),
        e.under.map(|u| u.to_string()).unwrap_or("-".into()),
        e.call.map(|u| u.to_string()).unwrap_or("-".into())
    )
}

fn bash(j: &mut Journal, call: &str, text: &str, input: Option<&str>, from: &[String]) {
    j.tool_started(call, text.into(), ToolAction::RunCommand, "bash", input.map(String::from), from);
}

#[test]
fn a_streaming_step_grows_in_place_with_its_revision() {
    let mut j = Journal::new(vec![]);
    j.said("测试", &[]);
    assert_eq!((j.events()[0].seq, j.events()[0].revision), (0, 0));
    j.said("通过", &[]);
    assert_eq!((j.events()[0].revision, j.events()[0].text.as_str()), (1, "测试通过"));
}

#[test]
fn reasoning_runs_on() {
    let mut j = Journal::new(vec![]);
    j.thought("先看", &[]);
    j.thought("路由", &[]);
    j.said("好", &[]);
    j.thought("再想想", &[]);
    bash(&mut j, "c1", "ls", Some("{}"), &[]);
    j.thought("看完了", &[]);
    let got: Vec<String> = j
        .events()
        .iter()
        .map(|s| format!("{}:{}", serde_json::to_value(s.r#type).unwrap().as_str().unwrap(), s.text))
        .collect();
    assert_eq!(
        got,
        [
            "assistant/thinking:先看路由",
            "assistant/message:好",
            "assistant/thinking:再想想",
            "tool/call:ls",
            "assistant/thinking:看完了"
        ]
    );
}

#[test]
fn a_sub_agents_steps_go_under_their_call() {
    let task = vec!["task-1".to_string()];
    let ghost = vec!["ghost".to_string()];
    let mut j = Journal::new(vec![]);
    j.tool_started("task-1", "派个帮手".into(), ToolAction::Other, "Task", Some("{}".into()), &[]);
    j.said("帮手先看看", &task);
    bash(&mut j, "c1", "ls", Some("{}"), &task);
    bash(&mut j, "c1", "pwd", Some("{}"), &[]);
    j.tool_ended("c1", "a.ts", true, &task);
    j.said("帮手看完了", &task);
    j.tool_ended("c1", "/work", true, &[]);
    j.tool_ended("task-1", "看完了", true, &[]);
    j.said("好", &[]);
    j.said("，就这样", &ghost);
    let got: Vec<String> = j.events().iter().map(line).collect();
    assert_eq!(
        got,
        [
            "0 tool/call 派个帮手  - -",
            "1 assistant/message 帮手先看看  0 -",
            "2 tool/call ls  0 -",
            "3 tool/call pwd  - -",
            "4 tool/result  a.ts 0 2",
            "5 assistant/message 帮手看完了  0 -",
            "6 tool/result  /work - 3",
            "7 tool/result  看完了 - 0",
            "8 assistant/message 好  - -",
            "9 assistant/message ，就这样  -1 -",
        ]
    );
}

#[test]
fn a_log_is_kept_read_back_and_only_grows() {
    vibevalley_i18n::set_locale("zh");
    let home = tempfile::tempdir().unwrap();
    let hub = Hub::new(empty_space_state());
    let db = vibevalley_server::base::ServerDb::open(home.path()).unwrap();
    let tr = Trajectories::open(db, &hub);
    tr.with_log("w1", |j| {
        j.run_started("r7");
        j.asked("加分页", &[]);
        bash(j, "c1", "ls", Some("{}"), &[]);
        j.tool_ended("c1", "a\nb", true, &[]);
        j.run_ended("r7", vibevalley_protocol::Outcome::Completed);
    });
    tr.finish("w1");
    let kept = tr.events("w1", None).unwrap();
    let types: Vec<String> = kept
        .iter()
        .map(|s| {
            format!(
                "{}:{}",
                serde_json::to_value(s.r#type).unwrap().as_str().unwrap(),
                s.output.clone().unwrap_or_default()
            )
        })
        .collect();
    assert_eq!(types, ["run/start:", "user/message:", "tool/call:", "tool/result:a\nb", "run/end:"]);
    assert_eq!(kept[2].action_text.as_deref(), Some("跑命令"));
    assert_eq!(tr.events("w1", Some("r7")).unwrap().len(), 5);
    assert_eq!(tr.events("w1", Some("r8")).unwrap().len(), 0);
    assert!(tr.events("../w1", None).is_none());
    tr.with_log("w1", |j| {
        j.said("还没说完", &[]);
        j.note(vibevalley_protocol::SessionEventType::RunError, "停了", &[]);
    });
    tr.finish("w1");
    let after = tr.events("w1", None).unwrap();
    assert_eq!(&after[..5], &kept[..]);
    assert_eq!(after.len(), 7);

    tr.forget("w1");
    assert!(tr.events("w1", None).is_none());
}

#[test]
fn a_grown_step_is_pushed_once() {
    let home = tempfile::tempdir().unwrap();
    let hub = Hub::new(empty_space_state());
    let live = hub.live();
    let db = vibevalley_server::base::ServerDb::open(home.path()).unwrap();
    let tr = Trajectories::open(db, &hub);
    tr.with_log("w9", |j| {
        j.said("好", &[]);
        j.said("的", &[]);
    });
    let got = live.recv_timeout(Duration::from_secs(2)).unwrap();
    let vibevalley_protocol::LiveEvent::Event(e) = got else { panic!("{got:?}") };
    assert_eq!((e.id.as_str(), e.activity.text.as_str()), ("w9", "好的"));
    assert!(live.recv_timeout(Duration::from_millis(500)).is_err());
}

fn until<T>(what: &str, f: impl FnMut() -> Option<T>) -> T {
    crate::support::wait_until_settled(None, Duration::from_secs(20), what, f)
}

#[test]
fn a_sent_issue_is_logged_listed_and_watched() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .unwrap();
    let hub = started.hub.clone();
    let call = |op: &str, p| hub.call_as(Caller::User, op, p);
    let mut helper = started.test_internals().agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    let helper = started.test_internals().agents.profiles.save(helper).unwrap();
    call("repo.create", json!({ "name": "farm" })).data.unwrap();
    let issue = call("issue.create", json!({ "title": "say hello", "repo": "farm", "agent": helper.id }))
        .data
        .unwrap();
    let id = issue["id"].as_str().unwrap().to_string();

    let (sub, rows) = hub.subscribe("issue.watch", json!({ "id": id })).unwrap();
    let first: serde_json::Value = rows.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(first["kind"], "state");
    assert_eq!(first["sessionIds"], json!([]));

    call("issue.status.update", json!({ "id": id, "status": "todo" })).data.unwrap();
    let session = crate::support::wait_until_live(&hub, Duration::from_secs(20), "the session to rest with its run ended", || {
        let s = started
            .test_internals()
            .board
            .read(|s| s.sessions.iter().find(|x| x.issue_id() == Some(id.as_str())).cloned())?;
        let page = call("session.event.list", json!({ "id": s.id })).data?;
        page["events"].as_array()?.iter().any(|e| e["type"] == "run/end").then_some(s)
    });
    let page = call("session.event.list", json!({ "id": session.id })).data.unwrap();
    let events = page["events"].as_array().unwrap();
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types.first(), Some(&"run/start"));
    assert_eq!(types.get(1), Some(&"user/message"));
    assert!(types.contains(&"assistant/message"), "{types:?}");
    let run = events[0]["run"].as_str().unwrap();
    assert!(events.iter().all(|e| e["run"] == run));

    let listed = call("session.list", json!({ "profile": helper.id })).data.unwrap();
    assert_eq!(listed[0]["id"], session.id.as_str());
    assert_eq!(call("session.get", json!({ "id": session.id })).data.unwrap()["profile"], helper.id.as_str());
    let gone = call("session.get", json!({ "id": "w404" }));
    assert_eq!(gone.biz_code, vibevalley_protocol::BizCode::SessionNotFound.code());

    // The watch saw the session's log and its state.
    let mut kinds = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !(kinds.iter().any(|k| k == "history") && kinds.iter().any(|k| k == "state")) {
        let row = rows.recv_deadline(deadline).expect("the watch to show the session");
        kinds.push(row["kind"].as_str().unwrap_or("").to_string());
    }
    assert!(kinds.contains(&"state".to_string()), "{kinds:?}");
    hub.unsubscribe(sub);
    let missing = hub.subscribe("issue.watch", json!({ "id": "i999" }));
    assert_eq!(missing.err().unwrap().biz_code, vibevalley_protocol::BizCode::IssueNotFound.code());
    started.test_internals().board.close();
}

#[path = "session/subagent_progress.rs"]
mod subagent_progress;

#[path = "session/workspace.rs"]
mod workspace;
