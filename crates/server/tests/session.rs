//! Sessions' work logs (VibeValley `journal.test.ts`), `session.*` and the
//! `issue.watch` stream over a scripted session.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use vibevalley_protocol::{Caller, EventTokens, SessionEvent, SessionEventType, ToolAction};
use vibevalley_server::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use vibevalley_server::gateway::api::Server;
use vibevalley_server::runtime::{Journal, Trajectory};
use vibevalley_server::service::Service;
use vibevalley_server::{App, Config, create_app_blocking};

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
    assert_eq!((j.entries()[0].seq, j.entries()[0].revision), (0, 0));
    j.said("通过", &[]);
    assert_eq!((j.entries()[0].revision, j.entries()[0].text.as_str()), (1, "测试通过"));
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
        .entries()
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
    let got: Vec<String> = j.entries().iter().map(line).collect();
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

fn test_ctx(home: &std::path::Path) -> Arc<Context> {
    vibevalley_runtime::rt::block_on(async {
        let service = Service::open(home).await.unwrap();
        Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service)),
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ))
    })
}

#[test]
fn a_log_is_kept_read_back_and_only_grows() {
    vibevalley_i18n::set_locale("zh");
    let home = tempfile::tempdir().unwrap();
    let ctx = test_ctx(home.path());
    let tr = Trajectory::open(ctx.clone());
    tr.with_log("w1", |j| {
        j.run_started("r7");
        j.asked("加分页", &[]);
        bash(j, "c1", "ls", Some("{}"), &[]);
        j.tool_ended("c1", "a\nb", true, &[]);
        j.run_ended("r7", vibevalley_protocol::Outcome::Completed);
    });
    vibevalley_runtime::rt::block_on(tr.finish_async("w1"));
    let kept = vibevalley_runtime::rt::block_on(tr.events_async("w1", None)).unwrap();
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
    assert_eq!(vibevalley_runtime::rt::block_on(tr.events_async("w1", Some("r7"))).unwrap().len(), 5);
    assert_eq!(vibevalley_runtime::rt::block_on(tr.events_async("w1", Some("r8"))).unwrap().len(), 0);
    assert!(vibevalley_runtime::rt::block_on(tr.events_async("../w1", None)).is_none());
    tr.with_log("w1", |j| {
        j.said("还没说完", &[]);
        j.note(vibevalley_protocol::SessionEventType::RunError, "停了", &[]);
    });
    vibevalley_runtime::rt::block_on(tr.finish_async("w1"));
    let after = vibevalley_runtime::rt::block_on(tr.events_async("w1", None)).unwrap();
    assert_eq!(&after[..5], &kept[..]);
    assert_eq!(after.len(), 7);

    vibevalley_runtime::rt::block_on(tr.forget_async("w1"));
    assert!(vibevalley_runtime::rt::block_on(tr.events_async("w1", None)).is_none());
    vibevalley_runtime::rt::block_on(tr.close_async());
}

#[test]
fn a_grown_step_is_pushed_once() {
    let home = tempfile::tempdir().unwrap();
    let ctx = test_ctx(home.path());
    let mut live = ctx.live.subscribe_live();
    let tr = Trajectory::open(ctx.clone());
    tr.with_log("w9", |j| {
        j.said("好", &[]);
        j.said("的", &[]);
    });
    let got = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(2), live.recv()).await.unwrap().unwrap() });
    let vibevalley_protocol::LiveEvent::Event(e) = got else { panic!("{got:?}") };
    assert_eq!((e.id.as_str(), e.activity.text.as_str()), ("w9", "好的"));
    let second = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_millis(500), live.recv()).await });
    assert!(second.is_err());
    vibevalley_runtime::rt::block_on(tr.close_async());
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
    let app: App = create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let router = app.router().clone();
    let call = |op: &str, p| router.call_as(Caller::User, op, p);
    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    let helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();
    call("repo.create", json!({ "name": "farm" })).data.unwrap();
    let issue = call("issue.create", json!({ "title": "say hello", "repo": "farm", "agent": helper.id }))
        .data
        .unwrap();
    let id = issue["id"].as_str().unwrap().to_string();

    let (sub, mut rows) = router.subscribe("issue.watch", json!({ "id": id })).unwrap();
    let first: serde_json::Value = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(2), rows.recv()).await })
        .unwrap()
        .unwrap();
    assert_eq!(first["kind"], "state");
    assert_eq!(first["sessionIds"], json!([]));

    call("issue.status.update", json!({ "id": id, "status": "todo" })).data.unwrap();
    let session = crate::support::wait_until_live(app.ctx(), Duration::from_secs(20), "the session to rest with its run ended", || {
        let s = crate::support::board_sessions(app.test_internals().board)
            .into_iter()
            .find(|x| x.issue_id() == Some(id.as_str()))?;
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
        let remaining = deadline.saturating_duration_since(Instant::now());
        let row = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(remaining, rows.recv()).await })
            .ok()
            .flatten()
            .expect("the watch to show the session");
        kinds.push(row["kind"].as_str().unwrap_or("").to_string());
    }
    assert!(kinds.contains(&"state".to_string()), "{kinds:?}");
    router.unsubscribe(sub);
    let missing = router.subscribe("issue.watch", json!({ "id": "i999" }));
    assert_eq!(missing.err().unwrap().biz_code, vibevalley_protocol::BizCode::IssueNotFound.code());
    app.close_blocking();
}

#[test]
fn session_telemetry_rolls_up_without_migrations() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let app: App = create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let router = app.router().clone();
    let call = |op: &str, p| router.call_as(Caller::User, op, p);
    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    let helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();
    call("repo.create", json!({ "name": "farm" })).data.unwrap();
    let issue = call("issue.create", json!({ "title": "collect telemetry", "repo": "farm", "agent": helper.id }))
        .data
        .unwrap();
    let id = issue["id"].as_str().unwrap().to_string();
    call("issue.status.update", json!({ "id": id, "status": "todo" })).data.unwrap();

    let session = crate::support::wait_until_live(app.ctx(), Duration::from_secs(20), "the session to rest with its run ended", || {
        let s = crate::support::board_sessions(app.test_internals().board)
            .into_iter()
            .find(|x| x.issue_id() == Some(id.as_str()))?;
        let page = call("session.event.list", json!({ "id": s.id })).data?;
        page["events"].as_array()?.iter().any(|e| e["type"] == "run/end").then_some(s)
    });

    // First verify live telemetry from ScriptedRuntime::demo() before restart.
    let live_listed = call("session.list", json!({ "profile": helper.id })).data.unwrap();
    assert_eq!(live_listed[0]["telemetry"]["inputTokens"], 1200);
    assert_eq!(live_listed[0]["telemetry"]["outputTokens"], 85);

    // Append additional LlmUsage + LlmRetry + RunError events, then restart App to verify DB rollup with zero migrations.
    let tr = Trajectory::open(app.ctx().clone());
    vibevalley_runtime::rt::block_on(async {
        tr.prepare_async(&session.id).await;
        tr.with_log(&session.id, |j| {
            j.usage(
                EventTokens {
                    input: 1200,
                    output: 300,
                    cache_read: 800,
                    cache_write: Some(200),
                    reasoning: Some(100),
                    context_used: Some(42_000),
                    context_window: Some(128_000),
                },
                &[],
            );
            j.note(SessionEventType::LlmRetry, "retrying 429", &[]);
            j.note(SessionEventType::RunError, "tool timeout", &[]);
        });
        tr.close_async().await;
    });
    app.close_blocking();

    let mut registry2 = vibevalley_runtime::oar::Registry::new();
    registry2.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let app2: App = create_app_blocking(Config {
        registry: Some(Arc::new(registry2)),
        probe_runtimes: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let router2 = app2.router().clone();
    let listed = router2.call_as(Caller::User, "session.list", json!({ "profile": helper.id })).data.unwrap();
    assert_eq!(listed[0]["telemetry"]["inputTokens"], 2400);
    assert_eq!(listed[0]["telemetry"]["cacheReadTokens"], 800);
    assert_eq!(listed[0]["telemetry"]["cacheWriteTokens"], 200);
    assert_eq!(listed[0]["telemetry"]["outputTokens"], 385);
    assert_eq!(listed[0]["telemetry"]["reasoningTokens"], 100);
    assert_eq!(listed[0]["telemetry"]["contextUsed"], 42_000);
    assert_eq!(listed[0]["telemetry"]["contextWindow"], 128_000);
    assert_eq!(listed[0]["telemetry"]["llmRetries"], 1);
    assert_eq!(listed[0]["telemetry"]["runErrors"], 1);

    let got = router2.call_as(Caller::User, "session.get", json!({ "id": session.id })).data.unwrap();
    assert_eq!(got["telemetry"], listed[0]["telemetry"]);
    app2.close_blocking();
}

#[test]
fn session_compact_and_run_code_respect_runtime_capabilities() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let app: App = create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let router = app.router().clone();
    let call = |op: &str, p| router.call_as(Caller::User, op, p);

    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    let helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();
    call("repo.create", json!({ "name": "farm" })).data.unwrap();
    let issue = call(
        "issue.create",
        json!({ "title": "check compact capability", "repo": "farm", "agent": helper.id }),
    )
    .data
    .unwrap();
    let id = issue["id"].as_str().unwrap().to_string();
    call("issue.status.update", json!({ "id": id, "status": "todo" })).data.unwrap();

    let session = crate::support::wait_until_live(app.ctx(), Duration::from_secs(20), "scripted helper to finish", || {
        let s = crate::support::board_sessions(app.test_internals().board)
            .into_iter()
            .find(|x| x.issue_id() == Some(id.as_str()))?;
        let page = call("session.event.list", json!({ "id": s.id })).data?;
        page["events"].as_array()?.iter().any(|e| e["type"] == "run/end").then_some(s)
    });

    // External non-compacting / non-durable OAR runtime (`scripted`) returns RuntimeRefused on both.
    let compact_refused = call("session.compact", json!({ "id": session.id }));
    assert_eq!(compact_refused.biz_code, vibevalley_protocol::BizCode::RuntimeRefused.code());
    let code_refused = call("session.runCode", json!({ "id": session.id, "script": "return 1;" }));
    assert_eq!(code_refused.biz_code, vibevalley_protocol::BizCode::RuntimeRefused.code());

    // Missing session returns SessionNotFound.
    let missing = call("session.compact", json!({ "id": "w404" }));
    assert_eq!(missing.biz_code, vibevalley_protocol::BizCode::SessionNotFound.code());

    app.close_blocking();
}

#[path = "session/subagent_progress.rs"]
mod subagent_progress;

#[path = "session/workspace.rs"]
mod workspace;
