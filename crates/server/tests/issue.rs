//! The issue endpoints over the hub, the board's facts in the hub's state:
//! VibeValley's payloads in, its envelopes and frames out.

use std::sync::Arc;

use crate::support::*;
use serde_json::{Value, json};
use vibevalley_core::empty_space_state;
use vibevalley_server::work::issue::Board;
use vibevalley_server::{Hub, Server};

fn call(hub: &Hub, op: &str, payload: Value) -> Value {
    serde_json::to_value(hub.call(op, payload)).unwrap()
}

fn served(w: &World) -> Arc<Hub> {
    let hub = Hub::new(empty_space_state());
    vibevalley_server::infra::install_health(&hub);
    let board = block_on(Board::open_on_async(&w.store, w.registry.clone(), config(w.dir.path()), hub.clone())).unwrap();
    vibevalley_server::work::issue::install(&hub, board);
    hub
}

#[test]
fn an_issue_goes_through_the_endpoints_from_create_to_done() {
    // The board of `world` is let go: the hub opens its own on the same store.
    let w = world(
        vec![HookRuntime::new("t", quick(), |turn| {
            turn.commit("feature.txt", "made\n");
            turn.done("Added feature.txt");
        })],
        |_| {},
    );
    w.board.close();
    let main = repo(w.dir.path(), "app");
    let hub = served(&w);

    let made = call(
        &hub,
        "issue.create",
        json!({ "title": "Add the feature", "repo": main, "agent": "t", "requestKey": "k1" }),
    );
    assert_eq!(made["bizCode"], 0, "{made}");
    assert_eq!(made["data"]["number"], 1);
    assert_eq!(made["data"]["status"], "backlog");
    assert!(made["data"]["seq"].as_i64().unwrap() >= 1);
    let again = call(
        &hub,
        "issue.create",
        json!({ "title": "Add the feature", "repo": main, "agent": "t", "requestKey": "k1" }),
    );
    assert_eq!(again["data"]["id"], made["data"]["id"], "the same request key is the same issue");
    let id = made["data"]["id"].as_str().unwrap().to_string();

    let list = call(&hub, "issue.list", json!({}));
    assert_eq!(list["data"].as_array().unwrap().len(), 1);
    assert_eq!(hub.state_now().issues.len(), 1, "the board's facts are the hub's state");
    assert_eq!(call(&hub, "issue.get", json!({ "id": "#1" }))["data"]["id"], id);
    let missing = call(&hub, "issue.get", json!({ "id": "#9" }));
    assert_eq!(missing["bizCode"], 300001);
    assert_eq!(missing["error"]["next"][0]["run"], json!(["issue", "list"]));

    let refused = call(&hub, "issue.status.update", json!({ "id": id, "status": "done" }));
    assert_eq!(refused["bizCode"], 300002, "{refused}");
    assert!(refused["error"]["next"].as_array().is_some_and(|n| !n.is_empty()), "{refused}");
    let preview = call(&hub, "issue.status.previewUpdate", json!({ "id": id, "status": "todo" }));
    assert_eq!(preview["bizCode"], 0, "{preview}");
    assert!(preview["data"]["does"][0].as_str().unwrap().contains("#1"), "{preview}");

    let sent = call(&hub, "issue.status.update", json!({ "id": id, "status": "todo" }));
    assert_eq!(sent["bizCode"], 0, "{sent}");
    let board_issue = || hub.state_now().issues.into_iter().find(|i| i.id == id).unwrap();
    wait_until_transition(&hub, std::time::Duration::from_secs(15), "issue InReview", || {
        let issue = board_issue();
        (issue.status == vibevalley_protocol::IssueStatus::InReview).then_some(issue)
    });

    let diff = call(&hub, "issue.diff.get", json!({ "id": id }));
    assert_eq!(diff["bizCode"], 0, "{diff}");
    assert_eq!(diff["data"]["files"][0]["path"], "feature.txt");
    assert_eq!(diff["data"]["files"][0]["status"], "A");
    assert!(diff["data"]["files"][0]["patch"].as_str().unwrap().contains("+made"));
    let runs = call(&hub, "issue.run.list", json!({ "id": id }));
    assert_eq!(runs["data"][0]["triggeredBy"]["kind"], "issue");
    let timeline = call(&hub, "issue.timeline.get", json!({ "id": id }));
    assert_eq!(timeline["data"]["milestones"][0]["kind"], "reported", "{timeline}");

    let done = call(&hub, "issue.status.update", json!({ "id": id, "status": "done" }));
    assert_eq!(done["bizCode"], 0, "{done}");
    assert_eq!(done["data"]["status"], "done");
    assert_eq!(done["data"]["delivered"], "merged");
    let history = call(&hub, "issue.history.list", Value::Null);
    // A session that left is kept as it was: the history still has it.
    assert_eq!(history["data"][0]["missingSessions"].as_array().unwrap().len(), 0, "{history}");
    assert_eq!(history["data"][0]["sessions"][0]["id"], "w1", "{history}");
    let closed = call(&hub, "issue.comment.create", json!({ "id": id, "text": "more" }));
    assert_eq!(closed["bizCode"], 300002);
}

#[test]
fn an_unsent_issue_is_updated_and_deleted() {
    let w = world(vec![HookRuntime::new("t", quick(), |turn| turn.done("ok"))], |_| {});
    w.board.close();
    let hub = served(&w);
    let made = call(&hub, "issue.create", json!({ "title": "An answer" }));
    let id = made["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(made["data"]["deliver"], "change", "a change unless it is the orchestrator's, repo or none");
    let updated = call(&hub, "issue.update", json!({ "id": id, "title": "A better question", "criteria": ["x"] }));
    assert_eq!(updated["data"]["title"], "A better question", "{updated}");
    let no_title = call(&hub, "issue.update", json!({ "id": id, "title": "  " }));
    assert_eq!(no_title["bizCode"], 300002);
    let preview = call(&hub, "issue.previewDelete", json!({ "id": id }));
    assert!(preview["data"]["does"][0].as_str().unwrap().contains("A better question"), "{preview}");
    assert_eq!(call(&hub, "issue.delete", json!({ "id": id })), json!({ "bizCode": 0, "message": "ok" }));
    assert!(hub.state_now().issues.is_empty());
    assert_eq!(call(&hub, "issue.conversation.get", json!({ "id": id }))["bizCode"], 300001);
}
