//! The issue endpoints over the router and board:
//! VibeValley's payloads in, its envelopes and frames out.

use std::sync::Arc;

use crate::support::*;
use serde_json::{Value, json};
use vibevalley_protocol::{Caller, SliceKind};
use vibevalley_server::{App, Config, Router, create_app_blocking};

fn call(router: &Router, op: &str, payload: Value) -> Value {
    serde_json::to_value(router.call_as(Caller::User, op, payload)).unwrap()
}

fn app_with_registry(dir: &std::path::Path, registry: Arc<vibevalley_runtime::oar::Registry>) -> App {
    create_app_blocking(Config {
        registry: Some(registry),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(dir)
    })
    .unwrap()
}

#[test]
fn an_issue_goes_through_the_endpoints_from_create_to_done() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(HookRuntime::new("t", quick(), |turn| {
        turn.commit("feature.txt", "made\n");
        turn.done("Added feature.txt");
    }));
    let main = repo(dir.path(), "app");
    let app = app_with_registry(dir.path(), Arc::new(registry));
    let router = app.router();

    let made = call(
        router,
        "issue.create",
        json!({ "title": "Add the feature", "repo": main, "agent": "t", "requestKey": "k1" }),
    );
    assert_eq!(made["bizCode"], 0, "{made}");
    assert_eq!(made["data"]["number"], 1);
    assert_eq!(made["data"]["status"], "backlog");
    assert!(made["data"]["seq"].as_i64().unwrap() >= 1);
    let again = call(
        router,
        "issue.create",
        json!({ "title": "Add the feature", "repo": main, "agent": "t", "requestKey": "k1" }),
    );
    assert_eq!(again["data"]["id"], made["data"]["id"], "the same request key is the same issue");
    let id = made["data"]["id"].as_str().unwrap().to_string();

    let list = call(router, "issue.list", json!({}));
    assert_eq!(list["data"].as_array().unwrap().len(), 1);
    block_on(app.ctx().feed.flush());
    assert_eq!(
        serde_json::from_str::<Value>(&app.ctx().feed.snapshot_json(SliceKind::Board)).unwrap()["issues"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "the board's facts are projected into the board slice"
    );
    assert_eq!(call(router, "issue.get", json!({ "id": "#1" }))["data"]["id"], id);
    let missing = call(router, "issue.get", json!({ "id": "#9" }));
    assert_eq!(missing["bizCode"], 300001);
    assert_eq!(missing["error"]["next"][0]["run"], json!(["issue", "list"]));

    let refused = call(router, "issue.status.update", json!({ "id": id, "status": "done" }));
    assert_eq!(refused["bizCode"], 300002, "{refused}");
    assert!(refused["error"]["next"].as_array().is_some_and(|n| !n.is_empty()), "{refused}");
    let preview = call(router, "issue.status.previewUpdate", json!({ "id": id, "status": "todo" }));
    assert_eq!(preview["bizCode"], 0, "{preview}");
    assert!(preview["data"]["does"][0].as_str().unwrap().contains("#1"), "{preview}");

    let sent = call(router, "issue.status.update", json!({ "id": id, "status": "todo" }));
    assert_eq!(sent["bizCode"], 0, "{sent}");
    wait_until_transition(app.ctx(), std::time::Duration::from_secs(15), "issue InReview", || {
        board_issue(app.test_internals().board, &id).filter(|i| i.status == vibevalley_protocol::IssueStatus::InReview)
    });

    let diff = call(router, "issue.diff.get", json!({ "id": id }));
    assert_eq!(diff["bizCode"], 0, "{diff}");
    assert_eq!(diff["data"]["files"][0]["path"], "feature.txt");
    assert_eq!(diff["data"]["files"][0]["status"], "A");
    assert!(diff["data"]["files"][0]["patch"].as_str().unwrap().contains("+made"));
    let runs = call(router, "issue.run.list", json!({ "id": id }));
    assert_eq!(runs["data"][0]["triggeredBy"]["kind"], "issue");
    let timeline = call(router, "issue.timeline.get", json!({ "id": id }));
    assert_eq!(timeline["data"]["milestones"][0]["kind"], "reported", "{timeline}");

    let done = call(router, "issue.status.update", json!({ "id": id, "status": "done" }));
    assert_eq!(done["bizCode"], 0, "{done}");
    assert_eq!(done["data"]["status"], "done");
    assert_eq!(done["data"]["delivered"], "merged");
    let history = call(router, "issue.history.list", Value::Null);
    // A session that left is kept as it was: the history still has it.
    assert_eq!(history["data"][0]["missingSessions"].as_array().unwrap().len(), 0, "{history}");
    assert_eq!(history["data"][0]["sessions"][0]["id"], "w1", "{history}");
    let closed = call(router, "issue.comment.create", json!({ "id": id, "text": "more" }));
    assert_eq!(closed["bizCode"], 300002);
    app.close_blocking();
}

#[test]
fn an_unsent_issue_is_updated_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(HookRuntime::new("t", quick(), |turn| turn.done("ok")));
    let app = app_with_registry(dir.path(), Arc::new(registry));
    let router = app.router();
    let made = call(router, "issue.create", json!({ "title": "An answer" }));
    let id = made["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(made["data"]["deliver"], "change", "a change unless it is the orchestrator's, repo or none");
    let updated = call(router, "issue.update", json!({ "id": id, "title": "A better question", "criteria": ["x"] }));
    assert_eq!(updated["data"]["title"], "A better question", "{updated}");
    let no_title = call(router, "issue.update", json!({ "id": id, "title": "  " }));
    assert_eq!(no_title["bizCode"], 300002);
    let preview = call(router, "issue.previewDelete", json!({ "id": id }));
    assert!(preview["data"]["does"][0].as_str().unwrap().contains("A better question"), "{preview}");
    assert_eq!(call(router, "issue.delete", json!({ "id": id })), json!({ "bizCode": 0, "message": "ok" }));
    assert!(board_issues(app.test_internals().board).is_empty());
    assert_eq!(call(router, "issue.conversation.get", json!({ "id": id }))["bizCode"], 300001);
    app.close_blocking();
}
