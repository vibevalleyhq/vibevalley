//! `cron.*` and the ticker over the whole server (VibeValley
//! `cron.test.ts`, the parts that are not `vibevalley-cron`'s rules).

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use vibevalley_core::{Clock, ManualClock, SharedClock};
use vibevalley_protocol::{BizCode, Caller};
use vibevalley_server::{App, Config, create_app_blocking};

fn server(dir: &std::path::Path, clock: SharedClock) -> App {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        clock,
        ..Config::under(dir)
    })
    .unwrap()
}

#[test]
fn crons_are_kept_refused_and_run_when_due() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let app = server(dir.path(), clock.clone());
    let crons = app.test_internals().cron;
    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);
    let mut helper = app.test_internals().agent.profile.store.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    helper.name = "lab".into();
    let helper = app.test_internals().agent.profile.store.save(helper).unwrap();
    call("repo.create", json!({ "name": "farm" })).data.unwrap();

    let past = call("cron.create", json!({ "name": "x", "text": "y", "when": { "kind": "once", "at": 1 } }));
    assert_eq!(past.biz_code, BizCode::CronRefused.code());
    let nobody = call(
        "cron.create",
        json!({ "name": "x", "text": "y", "agent": "ghost", "when": { "kind": "daily", "time": "09:00" } }),
    );
    assert_eq!(nobody.biz_code, BizCode::CronRefused.code());
    let no_repo = call(
        "cron.create",
        json!({ "name": "x", "text": "y", "agent": "lab", "when": { "kind": "daily", "time": "09:00" } }),
    );
    assert_eq!(no_repo.biz_code, BizCode::CronRefused.code(), "{}", no_repo.message);

    let daily = call(
        "cron.create",
        json!({ "name": "早报", "text": "写早报", "when": { "kind": "daily", "time": "09:00" }, "tz": "Asia/Shanghai" }),
    );
    let daily = daily.data.unwrap_or_else(|| panic!("{}", daily.message));
    let general = app.test_internals().channel.default_channel();
    assert_eq!(
        (daily["enabled"].as_bool(), daily["pending"].as_bool(), daily["channel"].as_str()),
        (Some(true), Some(false), Some(general.as_str()))
    );
    let nowhere = call(
        "cron.create",
        json!({ "name": "x", "text": "y", "channel": "#nowhere", "when": { "kind": "daily", "time": "09:00" } }),
    );
    assert_eq!(nowhere.biz_code, BizCode::ChannelNotFound.code(), "{}", nowhere.message);
    let id = daily["id"].as_str().unwrap().to_string();
    call("cron.update", json!({ "id": id, "enabled": false })).data.unwrap_or_default();
    assert!(!crons.list()[0].enabled);
    let preview = call("cron.previewDelete", json!({ "id": id })).data.unwrap();
    assert!(preview["does"][0].as_str().unwrap().contains("早报"));
    assert_eq!(call("cron.delete", json!({ "id": "nope" })).biz_code, BizCode::CronNotFound.code());

    let at = clock.now_ms() + 60_000;
    let once = call(
        "cron.create",
        json!({ "name": "say hi", "text": "say hi in notes", "agent": "lab", "repo": "farm", "when": { "kind": "once", "at": at } }),
    );
    let once = once.data.unwrap_or_else(|| panic!("{}", once.message));
    assert_eq!(once["agent"], helper.id.as_str());
    vibevalley_runtime::rt::block_on(crons.tick_async());
    assert_eq!(
        crate::support::board_issues(app.test_internals().board)
            .iter()
            .filter(|i| i.cron.is_some())
            .count(),
        0
    );
    clock.advance(Duration::from_secs(60));
    vibevalley_runtime::rt::block_on(crons.tick_async());
    let made = crate::support::board_issues(app.test_internals().board)
        .into_iter()
        .find(|i| i.cron.as_deref() == once["id"].as_str())
        .unwrap();
    assert_eq!(made.title, "say hi");
    assert!(made.was_sent() || made.status == vibevalley_protocol::IssueStatus::Todo, "{:?}", made.status);
    let after = crons.list().into_iter().find(|c| c.id == once["id"].as_str().unwrap()).unwrap();
    assert!(!after.enabled && after.last_run == Some(at));
    // Run once: the next tick makes nothing new.
    clock.advance(Duration::from_secs(60));
    vibevalley_runtime::rt::block_on(crons.tick_async());
    assert_eq!(
        crate::support::board_issues(app.test_internals().board)
            .iter()
            .filter(|i| i.cron.is_some())
            .count(),
        1
    );
    assert!(!dir.path().join("crons.json").exists(), "crons must live in server.db, not crons.json");

    // Updating the issue preserves cron.issue_id (PutIssue ON CONFLICT DO UPDATE, not INSERT OR REPLACE).
    vibevalley_runtime::rt::block_on(app.test_internals().board.edit_async(
        &made.id,
        &vibevalley_protocol::IssueUpdate {
            title: Some("say hi updated".into()),
            ..Default::default()
        },
    ))
    .unwrap();
    assert_eq!(crons.issue_of(once["id"].as_str().unwrap()).as_deref(), Some(made.id.as_str()));

    call("cron.delete", json!({ "id": id })).data.unwrap_or_default();
    app.close_blocking();
    drop(app);

    // Kept through a restart, including Issue.cron projected from cron.issue_id.
    let again = server(dir.path(), clock);
    let reloaded_crons = again.test_internals().cron.list();
    assert_eq!(reloaded_crons.len(), 1);
    assert_eq!(reloaded_crons[0].name, "say hi");
    let reloaded = crate::support::board_issue(again.test_internals().board, &made.id).unwrap();
    assert_eq!(reloaded.cron.as_deref(), once["id"].as_str());
    // Deleting the cron clears Issue.cron on the linked issue.
    vibevalley_runtime::rt::block_on(again.test_internals().cron.remove_async(once["id"].as_str().unwrap())).unwrap();
    assert_eq!(crate::support::board_issue(again.test_internals().board, &made.id).unwrap().cron, None);
    again.close_blocking();
}
