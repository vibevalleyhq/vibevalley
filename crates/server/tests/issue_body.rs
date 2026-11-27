//! Issue = Note Body (`body_note_id` lazy materialization, startup migration backfill,
//! Doc -> `issue.description` Markdown sync, PKM list exclusion, and Agent `note_suggestion` diversion).

use crate::support::RouterTestExt as _;
use std::sync::Arc;

use serde_json::{Value, json};
use vibevalley_protocol::{Caller, Envelope};

fn start(dir: &std::path::Path) -> vibevalley_server::App {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir)
    })
    .unwrap()
}

fn ok(e: Envelope) -> Value {
    assert_eq!(e.biz_code, 0, "{}", e.message);
    e.data.unwrap_or(Value::Null)
}

#[test]
fn startup_backfill_migrates_non_empty_issue_descriptions_idempotently_and_excludes_from_note_list() {
    let dir = tempfile::tempdir().unwrap();
    let first = start(dir.path());
    let empty_issue = ok(first.router().call_as(Caller::User, "issue.create", json!({ "title": "Empty draft" })));
    let legacy_issue = ok(first.router().call_as(
        Caller::User,
        "issue.create",
        json!({
            "title": "Legacy issue with markdown",
            "description": "## Context\n\nExisting markdown paragraph.",
        }),
    ));
    let empty_id = empty_issue["id"].as_str().unwrap().to_string();
    let legacy_id = legacy_issue["id"].as_str().unwrap().to_string();
    assert!(empty_issue["bodyNoteId"].is_null());
    assert!(legacy_issue["bodyNoteId"].is_null());
    first.close_blocking();

    // Reboot: startup backfill converts non-empty issues without body_note_id into collaborative Doc notes.
    let second = start(dir.path());
    let empty_after = ok(second.router().call_as(Caller::User, "issue.get", json!({ "id": empty_id })));
    assert!(empty_after["bodyNoteId"].is_null(), "empty issues stay unmaterialized");

    let legacy_after = ok(second.router().call_as(Caller::User, "issue.get", json!({ "id": legacy_id })));
    let body_note_id = legacy_after["bodyNoteId"]
        .as_str()
        .expect("non-empty pre-existing issue should be backfilled")
        .to_string();

    let doc_view = ok(second.router().call_as(Caller::User, "note.doc.view", json!({ "id": body_note_id })));
    let blocks = doc_view["blocks"].as_array().unwrap();
    assert!(blocks.len() >= 2, "expected heading and paragraph blocks: {doc_view}");
    assert_eq!(blocks[0]["type"], "heading");
    assert_eq!(blocks[0]["text"], "Context");
    assert_eq!(blocks[1]["type"], "prose");
    assert_eq!(blocks[1]["text"], "Existing markdown paragraph.");

    // Issue-body Doc notes must stay excluded from top-level / hierarchical PKM lists.
    let listed = ok(second.router().call_as(Caller::User, "note.list", json!({})));
    assert!(
        listed.as_array().unwrap().iter().all(|n| n["id"].as_str() != Some(body_note_id.as_str())),
        "body note leaked into top-level note.list: {listed}"
    );
    second.close_blocking();

    // Third reboot: idempotent, preserves the exact same bodyNoteId.
    let third = start(dir.path());
    let legacy_third = ok(third.router().call_as(Caller::User, "issue.get", json!({ "id": legacy_id })));
    assert_eq!(legacy_third["bodyNoteId"].as_str(), Some(body_note_id.as_str()));
    third.close_blocking();
}

#[test]
fn issue_body_ensure_syncs_doc_to_description_and_diverts_agent_edits_to_suggestions() {
    let dir = tempfile::tempdir().unwrap();
    let app = start(dir.path());
    let hub = app.router().clone();
    let user = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let created = ok(user("issue.create", json!({ "title": "Co-edit body flow" })));
    let issue_id = created["id"].as_str().unwrap().to_string();
    assert!(created["bodyNoteId"].is_null());

    // Lazy materialization is idempotent across repeated calls.
    let ensured_one = ok(user("issue.body.ensure", json!({ "id": issue_id })));
    let ensured_two = ok(user("issue.body.ensure", json!({ "id": issue_id })));
    let note_id = ensured_one["note"]["id"].as_str().unwrap().to_string();
    assert_eq!(ensured_one["issue"]["bodyNoteId"].as_str(), Some(note_id.as_str()));
    assert_eq!(ensured_two["note"]["id"].as_str(), Some(note_id.as_str()));

    // Editing structure/doc.json commits back into issue.description Markdown cache.
    let doc_json = json!({
        "version": 1,
        "blocks": [
            { "id": "b1", "type": "heading", "level": 2, "text": "Updated Plan" },
            { "id": "b2", "type": "prose", "text": "Synced directly from Doc blocks." }
        ]
    })
    .to_string();
    ok(user(
        "note.file.write",
        json!({
            "id": note_id,
            "files": [{ "path": "structure/doc.json", "content": doc_json, "mime": "application/json" }],
            "summary": "Human doc edit"
        }),
    ));
    let fetched = ok(user("issue.get", json!({ "id": issue_id })));
    let desc = fetched["description"].as_str().unwrap();
    assert!(desc.contains("## Updated Plan"), "expected heading sync: {desc}");
    assert!(desc.contains("Synced directly from Doc blocks."), "expected paragraph sync: {desc}");

    // Non-user (agent/orchestrator) issue.update description creates a reviewable note_suggestion instead of overwriting user blocks.
    ok(hub.call_as(
        Caller::Orchestrator,
        "issue.update",
        json!({
            "id": issue_id,
            "description": "## Agent Proposal\n\nSuggested checklist."
        }),
    ));
    let after_agent = ok(user("issue.get", json!({ "id": issue_id })));
    assert_eq!(after_agent["description"].as_str(), Some(desc), "agent edit must not silently overwrite");

    let sugs = ok(user("note.suggestion.list", json!({ "id": note_id })));
    let open_sugs: Vec<&Value> = sugs.as_array().unwrap().iter().filter(|s| s["status"] == "open").collect();
    assert_eq!(open_sugs.len(), 1, "expected 1 open suggestion: {sugs}");
    let sug_id = open_sugs[0]["id"].as_str().unwrap().to_string();

    // Accepting the suggestion applies it to structure/doc.json AND updates issue.description.
    ok(user("note.suggestion.accept", json!({ "id": note_id, "suggestion": sug_id })));
    let after_accept = ok(user("issue.get", json!({ "id": issue_id })));
    let accepted_desc = after_accept["description"].as_str().unwrap();
    assert!(
        accepted_desc.contains("## Agent Proposal"),
        "expected accepted suggestion heading: {accepted_desc}"
    );
    assert!(
        accepted_desc.contains("Suggested checklist."),
        "expected accepted suggestion body: {accepted_desc}"
    );

    app.close_blocking();
}
