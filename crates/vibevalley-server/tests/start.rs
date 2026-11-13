//! The whole server from `start`: repos by name, and an issue on one.

use std::sync::Arc;

use serde_json::json;
use vibevalley_protocol::Caller;

#[test]
fn a_repo_is_made_by_name_and_an_issue_names_it() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .unwrap();
    let hub = started.hub;
    let call = |op: &str, p| hub.call_as(Caller::User, op, p);

    assert!(
        !call("repo.validate", json!({ "name": "bad name" })).data.unwrap()["problem"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    let made = call("repo.create", json!({ "name": "farm" }));
    let summary = made.data.expect("repo.create answers");
    assert_eq!((summary["name"].as_str(), summary["git"].as_bool()), (Some("farm"), Some(true)));
    let again = call("repo.create", json!({ "name": "farm" }));
    assert_eq!(again.biz_code, vibevalley_protocol::BizCode::RepoRefused.code());
    let list = call("repo.list", json!(null)).data.unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    let activity = call("repo.activity.get", json!({ "id": "farm" })).data.unwrap();
    assert_eq!(activity["total"], 1);
    assert_eq!(
        call("repo.activity.get", json!({ "id": "nope" })).biz_code,
        vibevalley_protocol::BizCode::RepoNotFound.code()
    );

    let issue = call("issue.create", json!({ "title": "say hello", "repo": "farm" }));
    let issue = issue.data.unwrap_or_else(|| panic!("{}", issue.message));
    assert_eq!(issue["repo"], "farm");

    // An issue's agent is a profile: a name becomes its id, and the session
    // runs on the profile's runtime.
    let unassigned = issue["id"].as_str().unwrap().to_string();
    let refused = call("issue.status.previewUpdate", json!({ "id": unassigned, "status": "todo" }));
    assert_eq!(refused.biz_code, vibevalley_protocol::BizCode::IssueRefused.code(), "{}", refused.message);
    let mut helper = started.agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    helper.name = "小帮手".into();
    let helper = started.agents.profiles.save(helper).unwrap();
    let assigned = call("issue.create", json!({ "title": "say hi", "repo": "farm", "agent": "小帮手" }));
    let assigned = assigned.data.unwrap_or_else(|| panic!("{}", assigned.message));
    assert_eq!(assigned["assignments"][0]["agent"], helper.id.as_str());
    let id = assigned["id"].as_str().unwrap().to_string();
    let preview = call("issue.status.previewUpdate", json!({ "id": id, "status": "todo" }));
    let does = preview.data.unwrap_or_else(|| panic!("{}", preview.message));
    assert!(does["does"][0].as_str().unwrap().contains("小帮手"), "{does}");
    let sent = call("issue.status.update", json!({ "id": id, "status": "todo" }));
    assert!(sent.data.is_some(), "{}", sent.message);
    let session = started
        .board
        .read(|s| s.sessions.iter().find(|s| s.issue.as_deref() == Some(id.as_str())).cloned())
        .unwrap();
    assert_eq!((session.agent.as_str(), session.runtime.as_str()), (helper.id.as_str(), "scripted"));
    assert!(session.name.starts_with("小帮手"), "{}", session.name);
    // The user looking at a live session's changes is a `reviewed` entry, once per session.
    let mut diff = call("issue.diff.get", json!({ "id": id }));
    for _ in 0..50 {
        if diff.data.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        diff = call("issue.diff.get", json!({ "id": id }));
    }
    assert!(diff.data.is_some(), "{}", diff.message);
    let ledger = std::fs::read_to_string(dir.path().join("ledger.jsonl")).unwrap_or_default();
    let reviewed = ledger.lines().find(|l| l.contains("\"reviewed\"")).unwrap_or_else(|| panic!("{ledger}"));
    assert!(reviewed.contains(session.id.as_str()), "{reviewed}");
    std::fs::write(dir.path().join("repos/farm/Cargo.toml"), "[package]\nname = \"farm\"\n").unwrap();
    let templates = call("repo.template.list", json!({ "id": "farm" }));
    let templates = templates.data.unwrap_or_else(|| panic!("{}", templates.message));
    assert_eq!(templates["stack"]["test"], "cargo test");
    assert_eq!(templates["recent"], json!(["say hi"]));
    let kinds = templates["kinds"].as_array().unwrap();
    assert!(!kinds.is_empty());
    let texts: Vec<&str> = kinds
        .iter()
        .flat_map(|k| k["templates"].as_array().unwrap())
        .map(|t| t["done"].as_str().unwrap())
        .collect();
    assert!(texts.iter().any(|d| d.contains("`cargo test`")), "{texts:?}");
    assert!(texts.iter().all(|d| !d.contains("{test}")));
    assert_eq!(
        call("repo.template.list", json!({ "id": "nope" })).biz_code,
        vibevalley_protocol::BizCode::RepoNotFound.code()
    );
    started.board.close();
}

#[test]
fn a_closed_farm_opens_again_in_the_same_process() {
    let dir = tempfile::tempdir().unwrap();
    let config = || {
        let mut registry = vibevalley_oar::Registry::new();
        registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
        vibevalley_server::ServerConfig {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            orchestrator_listens: false,
            link_previews: false,
            ..vibevalley_server::ServerConfig::under(dir.path())
        }
    };
    let first = vibevalley_server::start(config()).unwrap();
    let made = first.hub.call_as(Caller::User, "issue.create", json!({ "title": "kept across a reopen" }));
    assert_eq!(made.biz_code, 0, "{}", made.message);
    first.close();
    let second = vibevalley_server::start(config()).expect("the board's lock was let go");
    let list = second.hub.call_as(Caller::User, "issue.list", json!({})).data.unwrap();
    assert!(list.to_string().contains("kept across a reopen"), "{list}");
    second.close();
}
