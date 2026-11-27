//! Unified 3+1 primitive directory-backed notes (`doc`, `base`, `canvas`, `media`),
//! hierarchical page tree, bidirectional links, Block Doc projection, Multi-Dimensional Base
//! with Agent Action columns, real-time Loro collaboration, suggestions, and presence tests.

use crate::support::{RouterTestExt as _, ServerTestExt as _};
use std::sync::Arc;

use serde_json::{Value, json};
use vibevalley_core::note::type_spec;
use vibevalley_protocol::{BizCode, Caller, Envelope, NoteType};
use vibevalley_server::Server as _;

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

fn code(e: Envelope) -> u32 {
    e.biz_code
}

fn last_message(call: &dyn Fn(&str, Value) -> Envelope, channel: &str) -> Value {
    let list = ok(call("channel.message.list", json!({ "id": channel })));
    list.as_array().unwrap().last().unwrap().clone()
}

#[test]
fn directory_notes_all_4_types_guides_versions_and_refusals() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let general = started.test_internals().channel.default_channel();

    let listed_types = ok(call("note.type.list", json!({})));
    assert_eq!(listed_types.as_array().unwrap().len(), 4);

    for ty in NoteType::ALL {
        let slug = ty.as_str();
        let guide = ok(call("note.type.read", json!({ "type": slug })));
        assert!(!guide["content"].as_str().unwrap().trim().is_empty(), "empty guide for {slug}");

        let created = ok(call(
            "note.create",
            json!({ "title": format!("Test {slug}"), "noteType": slug, "announce": false }),
        ));
        let note_id = created["id"].as_str().unwrap();
        assert_eq!(created["noteType"], slug);
        assert_eq!(created["version"], 1);
        assert_eq!(created["seq"], 1);

        let note_dir = dir.path().join("note").join(note_id);
        assert!(note_dir.join("manifest.json").exists(), "manifest missing for {slug}");
        assert!(note_dir.join(type_spec(ty).entry_path).exists(), "entry missing for {slug}");
        assert!(note_dir.join("asset").is_dir(), "asset dir missing for {slug}");
    }

    // Channel announcement card + immutable version snapshots on disk.
    let doc = ok(call(
        "note.create",
        json!({
            "title": "Architecture Spec",
            "noteType": "doc",
            "channel": general,
            "content": "{\"version\":1,\"blocks\":[{\"id\":\"b1\",\"type\":\"paragraph\",\"text\":\"Draft 1\"}]}",
            "note": "First draft"
        }),
    ));
    let id = doc["id"].as_str().unwrap().to_string();
    assert_eq!((doc["channel"].as_str(), doc["version"].as_i64()), (Some(general.as_str()), Some(1)));
    let said = last_message(&call, &general);
    assert_eq!(
        said["note"],
        json!({ "id": id, "title": "Architecture Spec", "noteType": "doc", "version": 1, "note": "First draft" })
    );

    let v2 = ok(call(
        "note.version.create",
        json!({
            "id": id,
            "content": "{\"version\":1,\"blocks\":[{\"id\":\"b1\",\"type\":\"paragraph\",\"text\":\"Draft 2\"}]}",
            "note": "Second draft"
        }),
    ));
    assert_eq!(v2["version"], 2);
    assert_eq!(v2["versions"].as_array().unwrap().len(), 2);
    assert!(
        ok(call("note.content.get", json!({ "id": id })))["content"]
            .as_str()
            .unwrap()
            .contains("Draft 2")
    );
    assert!(
        ok(call("note.content.get", json!({ "id": id, "version": 1 })))["content"]
            .as_str()
            .unwrap()
            .contains("Draft 1")
    );
    assert_eq!(code(call("note.content.get", json!({ "id": id, "version": 9 }))), BizCode::NoteNotFound.code());

    // Rename syncs manifest.json on disk as well as DB.
    let renamed = ok(call("note.update", json!({ "id": id, "title": "Renamed Spec" })));
    assert_eq!(renamed["title"], "Renamed Spec");
    let manifest = ok(call("note.file.get", json!({ "id": id, "path": "manifest.json" })));
    let manifest_json: Value = serde_json::from_str(manifest["content"].as_str().unwrap()).unwrap();
    assert_eq!(manifest_json["title"], "Renamed Spec");

    // Refusals & delete cleanup.
    assert_eq!(
        code(call("note.create", json!({ "title": "   ", "noteType": "doc" }))),
        BizCode::NoteRefused.code()
    );
    assert_eq!(
        code(call("note.file.delete", json!({ "id": id, "path": "manifest.json" }))),
        BizCode::NoteRefused.code()
    );
    assert_eq!(
        code(call(
            "note.file.write",
            json!({ "id": id, "files": [{ "path": "../escape.txt", "content": "x" }] })
        )),
        BizCode::NoteRefused.code()
    );

    let preview = ok(call("note.previewDelete", json!({ "id": id })));
    assert_eq!(preview["does"].as_array().unwrap().len(), 2);
    ok(call("note.delete", json!({ "id": id })));
    assert_eq!(code(call("note.get", json!({ "id": id }))), BizCode::NoteNotFound.code());
    assert!(!dir.path().join("note").join(&id).exists());

    started.close_blocking();
}

#[test]
fn note_tree_move_links_doc_blocks_and_base_agent_column_work_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    // 1. Page tree hierarchy & cycle protection.
    let parent = ok(call("note.create", json!({ "title": "Workspace Home", "noteType": "doc", "announce": false })));
    let parent_id = parent["id"].as_str().unwrap().to_string();

    let child = ok(call(
        "note.create",
        json!({ "title": "Child Spec", "noteType": "doc", "parentId": parent_id, "sortOrder": 10, "announce": false }),
    ));
    let child_id = child["id"].as_str().unwrap().to_string();
    assert_eq!(child["parentId"], parent_id);
    assert_eq!(child["sortOrder"], 10);

    // Setting parent's parent to child creates a cycle and must be refused.
    assert_eq!(
        code(call("note.tree.move", json!({ "id": parent_id, "parentId": child_id, "sortOrder": 0 }))),
        BizCode::NoteRefused.code()
    );

    // Reparenting child back to root clears parentId.
    let moved = ok(call("note.tree.move", json!({ "id": child_id, "parentId": Value::Null, "sortOrder": 5 })));
    assert_eq!(moved["parentId"], Value::Null);
    assert_eq!(moved["sortOrder"], 5);

    // 2. Issue + Block Doc bidirectional links.
    let issue = ok(call(
        "issue.create",
        json!({ "title": "Implement Notes", "description": format!("Spec in [[note:{parent_id}]]") }),
    ));
    let issue_id = issue["id"].as_str().unwrap().to_string();

    let doc_view = ok(call(
        "note.doc.appendBlock",
        json!({
            "id": child_id,
            "block": {
                "id": "blk-heading",
                "type": "heading",
                "level": 1,
                "text": format!("Linked to [[note:{parent_id}]] and [[issue:{issue_id}]]")
            }
        }),
    ));
    assert_eq!(doc_view["noteId"], child_id);
    assert!(doc_view["blocks"].as_array().unwrap().iter().any(|b| b["id"] == "blk-heading"));
    assert!(doc_view["extractedLinks"].as_array().unwrap().len() >= 2);

    let parent_links = ok(call("note.link.list", json!({ "entityKind": "note", "entityId": parent_id })));
    let backlinks = parent_links["backlinks"].as_array().unwrap();
    assert!(backlinks.iter().any(|l| l["sourceId"] == child_id), "{backlinks:?}");
    assert!(backlinks.iter().any(|l| l["sourceId"] == issue_id), "{backlinks:?}");

    let fetched_doc = ok(call("note.doc.view", json!({ "id": child_id })));
    assert_eq!(fetched_doc["noteId"], child_id);

    // 3. Base database + Agent Action column spawning an Issue + Formula/NoteRef/pageNoteId.
    ok(call("repo.create", json!({ "name": "demo" })));
    let base_json = serde_json::to_string(&json!({
        "version": 1,
        "sheets": [{
            "id": "s1",
            "name": "Tasks",
            "columns": [
                { "id": "c_title", "name": "Task", "kind": "text" },
                { "id": "c_points", "name": "Points", "kind": "number" },
                { "id": "c_ref", "name": "Doc", "kind": "noteRef" },
                { "id": "c_calc", "name": "Summary", "kind": "formula", "formula": "concat({Task}, \": \", {Points} * 2)" },
                {
                    "id": "c_agent",
                    "name": "Dispatch",
                    "kind": "agentAction",
                    "agentConfig": {
                        "promptTemplate": "Investigate {{Task}}",
                        "spawnIssueRepo": "demo",
                        "targetColumnId": "c_title"
                    }
                }
            ],
            "rows": [{
                "id": "r1",
                "pageNoteId": child_id,
                "cells": {
                    "c_title": { "_tag": "text", "value": "Audit storage backend" },
                    "c_points": { "_tag": "number", "value": 3 },
                    "c_ref": { "_tag": "noteRef", "noteId": parent_id }
                },
                "createdAt": 1,
                "updatedAt": 1
            }],
            "views": [{ "id": "v1", "name": "Table", "kind": "table" }]
        }]
    }))
    .unwrap();
    let base_note = ok(call(
        "note.create",
        json!({ "title": "Feature Matrix", "noteType": "base", "content": base_json, "announce": false }),
    ));
    let base_id = base_note["id"].as_str().unwrap().to_string();

    let base_links = ok(call("note.link.list", json!({ "entityKind": "note", "entityId": base_id })));
    let outgoing = base_links["outgoing"].as_array().unwrap();
    assert!(outgoing.iter().any(|l| l["targetId"] == child_id), "{outgoing:?}");
    assert!(outgoing.iter().any(|l| l["targetId"] == parent_id), "{outgoing:?}");

    let upserted = ok(call(
        "note.base.upsertRow",
        json!({
            "id": base_id,
            "sheetId": "s1",
            "cells": { "c_title": { "_tag": "text", "value": "Verify note backlinks" } }
        }),
    ));
    assert_eq!(upserted["totalRows"], 2);

    let run_res = ok(call(
        "note.base.runAgentColumn",
        json!({ "id": base_id, "sheetId": "s1", "columnId": "c_agent", "rowIds": ["r1"] }),
    ));
    assert_eq!(run_res["executed"], 1);
    assert_eq!(run_res["spawnedIssueIds"].as_array().unwrap().len(), 1);

    let viewed_base = ok(call("note.base.view", json!({ "id": base_id })));
    let row1 = viewed_base["rows"].as_array().unwrap().iter().find(|r| r["id"] == "r1").unwrap();
    assert_eq!(row1["pageNoteId"], child_id);
    assert_eq!(row1["cells"]["c_ref"]["_tag"], "noteRef");
    assert_eq!(row1["cells"]["c_calc"]["_tag"], "text");
    assert_eq!(row1["cells"]["c_calc"]["value"], "Spawned issue #2: 6");
    assert_eq!(row1["cells"]["c_agent"]["_tag"], "agentRun");
    assert_eq!(row1["cells"]["c_agent"]["status"], "spawned");

    started.close_blocking();
}

#[test]
fn collab_suggestions_presence_and_history_work_for_notes() {
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let doc = ok(call("note.create", json!({ "title": "Collab Note", "noteType": "doc", "announce": false })));
    let id = doc["id"].as_str().unwrap().to_string();

    let exp = ok(call("note.collab.export", json!({ "id": id })));
    assert_eq!(exp["noteId"], id);
    assert_eq!(exp["snapshot"], true);

    let imp = ok(call(
        "note.collab.import",
        json!({ "id": id, "update": exp["update"], "origin": "user", "summary": "noop sync" }),
    ));
    assert_eq!(imp["noteId"], id);

    let sug = ok(call(
        "note.suggestion.create",
        json!({
            "id": id,
            "path": "structure/doc.json",
            "baseRev": 1,
            "change": { "summary": "Refine doc", "content": "{\"version\":1,\"blocks\":[]}" }
        }),
    ));
    let sug_id = sug["id"].as_str().unwrap().to_string();
    let accepted = ok(call("note.suggestion.accept", json!({ "id": id, "suggestion": sug_id })));
    assert_eq!(accepted["status"], "accepted");

    let hist = ok(call("note.history.list", json!({ "id": id })));
    assert!(!hist.as_array().unwrap().is_empty());

    let (sub_id, mut rx) = hub.subscribe("note.presence.follow", json!({ "id": id })).unwrap();
    let recv = |rx: &mut tokio::sync::mpsc::Receiver<Value>| {
        vibevalley_runtime::rt::block_on(async { tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv()).await })
            .unwrap()
            .unwrap()
    };
    let snap = recv(&mut rx);
    assert_eq!(snap["_tag"], "Snapshot");

    ok(call(
        "note.presence.update",
        json!({
            "id": id,
            "presence": {
                "id": "p1",
                "name": "Alice",
                "color": "#3b82f6",
                "kind": "cursor",
                "path": "structure/doc.json",
                "updatedAt": 0
            }
        }),
    ));
    let up = recv(&mut rx);
    assert_eq!(up["_tag"], "Upsert");
    assert_eq!(up["peer"]["id"], "p1");
    hub.unsubscribe(sub_id);

    started.close_blocking();
}
