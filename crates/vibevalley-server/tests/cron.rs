//! `cron.*` and the ticker over the whole server (VibeValley
//! `cron.test.ts`, the parts that are not `vibevalley-cron`'s rules).

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use vibevalley_protocol::{BizCode, Caller};

fn server(dir: &std::path::Path) -> vibevalley_server::Started {
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
    vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        ..vibevalley_server::ServerConfig::under(dir)
    })
    .unwrap()
}

#[test]
fn crons_are_kept_refused_and_run_when_due() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = server(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p| hub.call_as(Caller::User, op, p);
    let mut helper = started.agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    helper.name = "lab".into();
    let helper = started.agents.profiles.save(helper).unwrap();
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
    let general = started.chat.default_channel();
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
    assert!(!hub.read(|s| s.crons[0].enabled));
    let preview = call("cron.previewDelete", json!({ "id": id })).data.unwrap();
    assert!(preview["does"][0].as_str().unwrap().contains("早报"));
    assert_eq!(call("cron.delete", json!({ "id": "nope" })).biz_code, BizCode::CronNotFound.code());

    let at = vibevalley_server::now() + 300;
    let once = call(
        "cron.create",
        json!({ "name": "say hi", "text": "say hi in notes", "agent": "lab", "repo": "farm", "when": { "kind": "once", "at": at } }),
    );
    let once = once.data.unwrap_or_else(|| panic!("{}", once.message));
    assert_eq!(once["agent"], helper.id.as_str());
    std::thread::sleep(Duration::from_millis(400));
    started.crons.tick();
    let made = started
        .board
        .read(|s| s.issues.iter().find(|i| i.cron.as_deref() == once["id"].as_str()).cloned())
        .unwrap();
    assert_eq!(made.title, "say hi");
    assert!(made.was_sent() || made.status == vibevalley_protocol::IssueStatus::Todo, "{:?}", made.status);
    let after = hub.read(|s| s.crons.iter().find(|c| c.id == once["id"].as_str().unwrap()).cloned()).unwrap();
    assert!(!after.enabled && after.last_run.is_some());
    // Run once: the next tick makes nothing new.
    started.crons.tick();
    assert_eq!(started.board.read(|s| s.issues.iter().filter(|i| i.cron.is_some()).count()), 1);
    assert!(!dir.path().join("crons.json").exists(), "crons must live in server.db, not crons.json");

    // Updating the issue preserves cron.issue_id (PutIssue ON CONFLICT DO UPDATE, not INSERT OR REPLACE).
    started
        .board
        .edit(
            &made.id,
            &vibevalley_protocol::IssueUpdate {
                title: Some("say hi updated".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(started.crons.issue_of(once["id"].as_str().unwrap()).as_deref(), Some(made.id.as_str()));

    call("cron.delete", json!({ "id": id })).data.unwrap_or_default();
    started.board.close();
    drop(started);

    // Kept through a restart, including Issue.cron projected from cron.issue_id.
    let again = server(dir.path());
    let crons = again.hub.read(|s| s.crons.clone());
    assert_eq!(crons.len(), 1);
    assert_eq!(crons[0].name, "say hi");
    let reloaded = again.board.issue(&made.id).unwrap();
    assert_eq!(reloaded.cron.as_deref(), once["id"].as_str());
    // Deleting the cron clears Issue.cron on the linked issue.
    again.crons.remove(once["id"].as_str().unwrap()).unwrap();
    assert_eq!(again.board.issue(&made.id).unwrap().cron, None);
    again.board.close();
}
