//! Unified 12-type directory-backed artifacts, real-time collaborative editing,
//! suggestions, live presence, and time-travel history tests.

use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use vibevalley_core::artifact::type_spec;
use vibevalley_core::collab::CommitMeta;
use vibevalley_protocol::{ArtifactType, BizCode, Caller, Envelope};
use vibevalley_server::artifact::Maker;
use vibevalley_server::gateway::api::Server;

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

fn page(words: &str) -> String {
    format!("<!doctype html><title>{words}</title><p>{words}</p>")
}

fn last_message(call: &dyn Fn(&str, Value) -> Envelope, channel: &str) -> Value {
    let list = ok(call("channel.message.list", json!({ "id": channel })));
    list.as_array().unwrap().last().unwrap().clone()
}

#[test]
fn directory_artifacts_all_12_types_guides_versions_and_refusals() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let general = started.test_internals().channel.default_channel();

    // Verify all 12 ArtifactType guides & starter directories work cleanly.
    let listed_types = ok(call("artifact.type.list", json!({})));
    assert_eq!(listed_types.as_array().unwrap().len(), 12);

    // Default design-system can be created and marked standing default; non-design-system is refused.
    let ds = ok(call(
        "artifact.create",
        json!({ "title": "Farm Tokens", "artifactType": "design-system", "isDefault": true, "announce": false }),
    ));
    assert_eq!(ds["isDefault"], true);
    assert_eq!(
        code(call(
            "artifact.create",
            json!({ "title": "Not DS", "artifactType": "slides", "isDefault": true })
        )),
        BizCode::ArtifactRefused.code()
    );

    for ty in ArtifactType::ALL {
        let slug = ty.as_str();
        let guide = ok(call("artifact.type.read", json!({ "type": slug })));
        assert!(!guide["content"].as_str().unwrap().trim().is_empty(), "empty guide for {slug}");
        assert_eq!(guide["defaultArtifactId"], ds["id"]);

        let created = ok(call(
            "artifact.create",
            json!({ "title": format!("Test {slug}"), "artifactType": slug, "announce": false }),
        ));
        let art_id = created["id"].as_str().unwrap();
        assert_eq!(created["artifactType"], slug);
        assert_eq!(created["version"], 1);
        assert_eq!(created["seq"], 1);

        let art_dir = dir.path().join("artifact").join(art_id);
        assert!(art_dir.join("manifest.json").exists(), "manifest missing for {slug}");
        assert!(art_dir.join(type_spec(ty).entry_path).exists(), "entry missing for {slug}");
        assert!(art_dir.join("asset").is_dir(), "asset dir missing for {slug}");
    }

    // Channel announcement card + immutable version snapshots on disk.
    let proto = ok(call(
        "artifact.create",
        json!({
            "title": "详情：抽屉还是整页",
            "artifactType": "prototype",
            "channel": general,
            "content": page("抽屉"),
            "note": "第一版"
        }),
    ));
    let id = proto["id"].as_str().unwrap().to_string();
    assert_eq!((proto["channel"].as_str(), proto["version"].as_i64()), (Some(general.as_str()), Some(1)));
    let said = last_message(&call, &general);
    assert_eq!(
        said["artifact"],
        json!({ "id": id, "title": "详情：抽屉还是整页", "artifactType": "prototype", "version": 1, "note": "第一版" })
    );

    let v2 = ok(call("artifact.version.create", json!({ "id": id, "content": page("整页"), "note": "第二版" })));
    assert_eq!(v2["version"], 2);
    assert_eq!(v2["versions"].as_array().unwrap().len(), 2);
    assert_eq!(ok(call("artifact.content.get", json!({ "id": id })))["content"], page("整页"));
    assert_eq!(ok(call("artifact.content.get", json!({ "id": id, "version": 1 })))["content"], page("抽屉"));
    assert_eq!(
        code(call("artifact.content.get", json!({ "id": id, "version": 9 }))),
        BizCode::ArtifactNotFound.code()
    );

    // Rename syncs manifest.json on disk as well as DB.
    let renamed = ok(call("artifact.update", json!({ "id": id, "title": "新版方案" })));
    assert_eq!(renamed["title"], "新版方案");
    let manifest = ok(call("artifact.file.get", json!({ "id": id, "path": "manifest.json" })));
    let manifest_json: Value = serde_json::from_str(manifest["content"].as_str().unwrap()).unwrap();
    assert_eq!(manifest_json["title"], "新版方案");

    // Refusals & delete cleanup.
    assert_eq!(
        code(call("artifact.create", json!({ "title": "   ", "artifactType": "docs" }))),
        BizCode::ArtifactRefused.code()
    );
    assert_eq!(
        code(call("artifact.file.delete", json!({ "id": id, "path": "manifest.json" }))),
        BizCode::ArtifactRefused.code()
    );
    assert_eq!(
        code(call(
            "artifact.file.write",
            json!({ "id": id, "files": [{ "path": "../escape.txt", "content": "x" }] })
        )),
        BizCode::ArtifactRefused.code()
    );

    let preview = ok(call("artifact.previewDelete", json!({ "id": id })));
    assert_eq!(preview["does"].as_array().unwrap().len(), 2);
    ok(call("artifact.delete", json!({ "id": id })));
    assert_eq!(code(call("artifact.get", json!({ "id": id }))), BizCode::ArtifactNotFound.code());
    assert!(!dir.path().join("artifact").join(&id).exists());

    started.close_blocking();
}

#[test]
fn regression_a_failed_artifact_version_never_publishes_its_channel_card() {
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    let dir = tempfile::tempdir().unwrap();
    let server = start(dir.path());
    let call = |op: &str, p: Value| server.router().call_as(Caller::User, op, p);
    let channel = server.test_internals().channel.default_channel();
    let created = ok(call(
        "artifact.create",
        json!({"title":"Proposal","artifactType":"prototype","channel":channel,"content":page("v1")}),
    ));
    let before = ok(call("channel.message.list", json!({"id":channel})));
    let first_card = last_message(&call, &channel);
    let mut events = server.test_internals().channel.subscribe_events();
    let opts = SqliteConnectOptions::new().filename(dir.path().join("server.db"));
    let mut inspect = vibevalley_runtime::rt::block_on(SqliteConnection::connect_with(&opts)).unwrap();
    vibevalley_runtime::rt::block_on(
        sqlx::raw_sql(
            "CREATE TRIGGER reject_version BEFORE INSERT ON artifact_version WHEN NEW.version = 2 BEGIN SELECT raise(ABORT, 'blocked version'); END;",
        )
        .execute(&mut inspect),
    )
    .unwrap();

    let version = || call("artifact.version.create", json!({"id":created["id"],"content":page("v2")}));
    let failed = version();
    assert_ne!(failed.biz_code, 0);
    assert!(failed.message.contains("blocked version"), "{}", failed.message);
    assert_eq!(ok(call("artifact.get", json!({"id":created["id"]})))["version"], 1);
    assert_eq!(ok(call("channel.message.list", json!({"id":channel}))), before);
    assert!(events.try_recv().is_err());

    vibevalley_runtime::rt::block_on(sqlx::raw_sql("DROP TRIGGER reject_version").execute(&mut inspect)).unwrap();
    vibevalley_runtime::rt::block_on(
        sqlx::raw_sql(
            "CREATE TABLE proof_parent (id integer primary key);
         CREATE TABLE proof_child (parent integer references proof_parent(id) deferrable initially deferred);
         CREATE TRIGGER reject_commit AFTER INSERT ON artifact_version WHEN NEW.version = 2 BEGIN INSERT INTO proof_child VALUES (1); END;",
        )
        .execute(&mut inspect),
    )
    .unwrap();
    let failed = version();
    assert_ne!(failed.biz_code, 0);
    assert!(failed.message.contains("FOREIGN KEY"), "{}", failed.message);
    assert_eq!(ok(call("artifact.get", json!({"id":created["id"]})))["version"], 1);
    assert_eq!(ok(call("channel.message.list", json!({"id":channel}))), before);
    assert!(events.try_recv().is_err());
    vibevalley_runtime::rt::block_on(sqlx::raw_sql("DROP TRIGGER reject_commit").execute(&mut inspect)).unwrap();
    let published = ok(version());
    let card = last_message(&call, &channel);
    assert_eq!(published["version"], 2);
    assert_eq!(card["number"].as_i64(), first_card["number"].as_i64().map(|n| n + 1));
    assert_eq!(card["artifact"]["version"], 2);
    let second = published["versions"].as_array().unwrap().iter().find(|v| v["version"] == 2).unwrap();
    assert_eq!(second["number"], card["number"]);
    assert!(events.try_recv().is_ok());
    assert!(events.try_recv().is_err());
    server.close_blocking();
}

#[test]
fn artifact_file_ops_optimistic_hash_guard_and_follow_stream() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let board = ok(call(
        "artifact.create",
        json!({ "title": "系统白板", "artifactType": "whiteboard", "announce": false }),
    ));
    let id = board["id"].as_str().unwrap().to_string();
    assert_eq!(board["seq"], 1);

    let (sub_id, mut rx) = hub.subscribe("artifact.follow", json!({ "id": id, "after": 0 })).unwrap();
    let recv = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>| {
        vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(3), rx.recv()).await })
            .unwrap()
            .unwrap()
    };
    let replay = recv(&mut rx);
    assert_eq!(replay["_tag"], "Files");
    assert_eq!(replay["seq"], 1);

    let binary_png = vec![0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let write1 = ok(call(
        "artifact.file.write",
        json!({
            "id": id,
            "summary": "add notes and png",
            "files": [
                { "path": "structure/notes.md", "content": "# Board Notes\n", "expectedHash": "" },
                { "path": "asset/logo.png", "content": BASE64.encode(&binary_png), "encoding": "base64", "expectedHash": "" }
            ]
        }),
    ));
    assert_eq!(write1["seq"], 2);
    let ev2 = recv(&mut rx);
    assert_eq!(ev2["_tag"], "Files");
    assert_eq!(ev2["seq"], 2);
    assert_eq!(ev2["files"].as_array().unwrap().len(), 2);

    let got_notes = ok(call("artifact.file.get", json!({ "id": id, "path": "structure/notes.md" })));
    let notes_hash = got_notes["hash"].as_str().unwrap().to_string();
    let got_png = ok(call("artifact.file.get", json!({ "id": id, "path": "asset/logo.png" })));
    assert_eq!(got_png["encoding"], "base64");
    assert_eq!(BASE64.decode(got_png["content"].as_str().unwrap()).unwrap(), binary_png);

    // Wrong expectedHash must be refused cleanly.
    assert_eq!(
        code(call(
            "artifact.file.write",
            json!({
                "id": id,
                "files": [{ "path": "structure/notes.md", "content": "conflict", "expectedHash": "deadbeef" }]
            })
        )),
        BizCode::ArtifactRefused.code()
    );

    // Matching expectedHash succeeds.
    let write2 = ok(call(
        "artifact.file.write",
        json!({
            "id": id,
            "files": [{ "path": "structure/notes.md", "content": "# Board Notes v2\n", "expectedHash": notes_hash }]
        }),
    ));
    assert_eq!(write2["seq"], 3);
    let ev3 = recv(&mut rx);
    assert_eq!(ev3["seq"], 3);

    // Delete asset/logo.png streams deletion.
    let del = ok(call("artifact.file.delete", json!({ "id": id, "path": "asset/logo.png" })));
    assert_eq!(del["seq"], 4);
    let ev4 = recv(&mut rx);
    assert_eq!(ev4["seq"], 4);
    assert_eq!(ev4["deleted"], json!(["asset/logo.png"]));

    hub.unsubscribe(sub_id);
    started.close_blocking();
}

#[test]
fn artifact_issue_fk_sets_null_on_issue_delete() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let issue_id = ok(call("issue.create", json!({ "title": "临时工单" })))["id"].as_str().unwrap().to_string();
    let made = ok(call(
        "artifact.create",
        json!({
            "title": "工单产物",
            "artifactType": "whiteboard",
            "issue": issue_id,
            "announce": false
        }),
    ));
    let artifact_id = made["id"].as_str().unwrap().to_string();
    assert_eq!(made["issue"], issue_id);

    ok(call("issue.delete", json!({ "id": issue_id })));
    let after = ok(call("artifact.get", json!({ "id": artifact_id })));
    assert_eq!(after["id"], artifact_id);
    assert!(after.get("issue").is_none());
    started.close_blocking();
}

#[test]
fn presence_update_follow_never_writes_sqlite() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let board = ok(call(
        "artifact.create",
        json!({
            "title": "协作白板",
            "artifactType": "whiteboard",
            "announce": false
        }),
    ));
    let id = board["id"].as_str().unwrap().to_string();
    assert_eq!(board["seq"], 1);

    let (sub_id, mut rx) = hub.subscribe("artifact.presence.follow", json!({ "id": id })).unwrap();
    let recv = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>| {
        vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(3), rx.recv()).await })
            .unwrap()
            .unwrap()
    };
    let snap = recv(&mut rx);
    assert_eq!(snap["_tag"], "Snapshot");
    assert_eq!(snap["peers"], json!([]));

    ok(call(
        "artifact.presence.update",
        json!({
            "id": id,
            "presence": {
                "id": "user",
                "name": "Alice",
                "color": "#3b82f6",
                "kind": "cursor",
                "x": 120,
                "y": 240,
                "path": "structure/board.json",
                "nodeId": "node-1",
                "status": "构图中",
                "viewport": { "x": 0, "y": 0, "w": 1280, "h": 720, "zoom": 1.25 },
                "updatedAt": 0
            }
        }),
    ));
    let up = recv(&mut rx);
    assert_eq!(up["_tag"], "Upsert");
    assert_eq!(up["peer"]["id"], "user");
    assert_eq!(up["peer"]["path"], "structure/board.json");
    assert_eq!(up["peer"]["nodeId"], "node-1");
    assert_eq!(up["peer"]["viewport"]["zoom"], 1.25);

    ok(call(
        "artifact.presence.update",
        json!({
            "id": id,
            "presence": {
                "id": "session-w1",
                "name": "Planner",
                "color": "#22c55e",
                "kind": "highlight",
                "x": 300,
                "y": 400,
                "selector": "#hero",
                "sessionId": "session-w1",
                "status": "排版中",
                "updatedAt": 0
            }
        }),
    ));
    let up2 = recv(&mut rx);
    assert_eq!(up2["_tag"], "Upsert");
    assert_eq!(up2["peer"]["id"], "session-w1");
    assert_eq!(up2["peer"]["sessionId"], "session-w1");

    // Verify `artifact.seq` stayed at 1 across pure-memory presence updates.
    assert_eq!(ok(call("artifact.get", json!({ "id": id })))["seq"], 1);

    ok(call("artifact.presence.update", json!({ "id": id, "peerId": "session-w1" })));
    let rm1 = recv(&mut rx);
    assert_eq!((rm1["_tag"].as_str(), rm1["peerId"].as_str()), (Some("Remove"), Some("session-w1")));

    ok(call("artifact.presence.update", json!({ "id": id, "peerId": "user" })));
    let rm2 = recv(&mut rx);
    assert_eq!((rm2["_tag"].as_str(), rm2["peerId"].as_str()), (Some("Remove"), Some("user")));

    hub.unsubscribe(sub_id);
    started.close_blocking();
}

#[test]
fn persistent_cursor_suggestion_survives_upstream_edit_and_diverts_human_files() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let manager = started.test_internals().artifact.clone();

    let created = ok(call(
        "artifact.create",
        json!({
            "title": "Anchored PRD",
            "artifactType": "docs",
            "content": "Hello world, ship v1 today.",
            "announce": false
        }),
    ));
    let id = created["id"].as_str().unwrap().to_string();

    // Agent proposes an anchored range replacement covering "ship v1" ([13..20]).
    let sug = ok(call(
        "artifact.suggestion.create",
        json!({
            "id": id,
            "path": "structure/index.md",
            "baseRev": 1,
            "startOffset": 13,
            "endOffset": 20,
            "change": { "content": "launch v2", "summary": "Bump target version" }
        }),
    ));
    let sug_id = sug["id"].as_str().unwrap().to_string();
    assert!(sug["cursorStart"].as_str().is_some());
    assert!(sug["cursorEnd"].as_str().is_some());

    // Human inserts prefix text before offset 13; Loro cursors shift cleanly with upstream edits.
    ok(call(
        "artifact.file.write",
        json!({
            "id": id,
            "files": [{ "path": "structure/index.md", "content": "[Urgent] Hello world, ship v1 today." }]
        }),
    ));

    let accepted = ok(call("artifact.suggestion.accept", json!({ "id": id, "suggestion": sug_id })));
    assert_eq!(accepted["status"], "accepted");
    let after = ok(call("artifact.file.get", json!({ "id": id, "path": "structure/index.md" })));
    assert_eq!(after["content"], "[Urgent] Hello world, launch v2 today.");

    // Agent write to human-touched `structure/index.md` automatically diverts into a review suggestion.
    let agent_maker = Maker {
        from: "agent-reviewer".into(),
        by: "agent-reviewer".into(),
        run: None,
    };
    let meta = CommitMeta::session("Reviewer", "reviewer", "sess-1", 1, Some("Polish copy".into()), 1_700_000_001);
    let diverted = vibevalley_runtime::rt::block_on(
        manager.write_files_with_meta_async(
            &agent_maker,
            &serde_json::from_value(json!({
                "id": id,
                "files": [{ "path": "structure/index.md", "content": "Completely replaced text" }],
                "summary": "Polish copy"
            }))
            .unwrap(),
            &meta,
        ),
    )
    .unwrap();
    let diverted_list = diverted.suggestions.unwrap();
    assert_eq!(diverted_list.len(), 1);
    let diverted_id = diverted_list[0].id.clone();

    // Human content remained untouched; rejecting closes the suggestion.
    assert_eq!(
        ok(call("artifact.file.get", json!({ "id": id, "path": "structure/index.md" })))["content"],
        "[Urgent] Hello world, launch v2 today."
    );
    let rejected = ok(call("artifact.suggestion.reject", json!({ "id": id, "suggestion": diverted_id })));
    assert_eq!(rejected["status"], "rejected");

    started.close_blocking();
}

#[test]
fn time_travel_preview_restore_fork_compaction_and_selective_origin_undo() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let manager = started.test_internals().artifact.clone();

    let created = ok(call(
        "artifact.create",
        json!({
            "title": "Design Spec",
            "artifactType": "docs",
            "content": "Initial draft.\n",
            "announce": false
        }),
    ));
    let id = created["id"].as_str().unwrap().to_string();

    let alice = Maker {
        from: "session-a".into(),
        by: "writer".into(),
        run: None,
    };
    let meta_a = CommitMeta::session("Writer", "writer", "session-a", 1, Some("Agent A chapter".into()), 1_700_000_001);
    vibevalley_runtime::rt::block_on(
        manager.write_files_with_meta_async(
            &alice,
            &serde_json::from_value(json!({
                "id": id,
                "files": [{ "path": "structure/chapter-a.md", "content": "# Section A\nAuthored by session-a.\n" }]
            }))
            .unwrap(),
            &meta_a,
        ),
    )
    .unwrap();

    // Human writes structure/human.md concurrently.
    ok(call(
        "artifact.file.write",
        json!({
            "id": id,
            "summary": "Human section",
            "files": [{ "path": "structure/human.md", "content": "Human core insight.\n" }]
        }),
    ));

    let hist = ok(call("artifact.history.list", json!({ "id": id })));
    let entries = hist.as_array().unwrap();
    assert!(entries.len() >= 3, "{hist}");
    let after_a_frontier = entries.iter().find(|e| e["origin"] == "session:session-a:turn:1").unwrap()["frontiers"]
        .as_str()
        .unwrap()
        .to_string();

    // Preview at historical frontier shows chapter-a.md before human.md existed.
    let preview = ok(call("artifact.history.preview", json!({ "id": id, "frontiers": after_a_frontier })));
    let p_files = preview["files"].as_array().unwrap();
    assert!(p_files.iter().any(|f| f["path"] == "structure/chapter-a.md"));
    assert!(!p_files.iter().any(|f| f["path"] == "structure/human.md"));

    // Selective undo of session:session-a:turn:1 removes chapter-a.md edits while preserving human.md!
    ok(call("artifact.history.undoOrigin", json!({ "id": id, "origin": "session:session-a:turn:1" })));
    assert_eq!(
        ok(call("artifact.file.get", json!({ "id": id, "path": "structure/human.md" })))["content"],
        "Human core insight.\n"
    );
    assert_eq!(
        code(call("artifact.file.get", json!({ "id": id, "path": "structure/chapter-a.md" }))),
        BizCode::ArtifactNotFound.code()
    );

    // Fork at historical frontier into an independent artifact.
    let forked = ok(call(
        "artifact.history.fork",
        json!({ "id": id, "frontiers": after_a_frontier, "title": "Forked Spec" }),
    ));
    let forked_id = forked["id"].as_str().unwrap().to_string();
    assert_ne!(forked_id, id);
    assert_eq!(
        ok(call("artifact.file.get", json!({ "id": forked_id, "path": "structure/chapter-a.md" })))["content"],
        "# Section A\nAuthored by session-a.\n"
    );

    // Restore original artifact back to `after_a_frontier`.
    ok(call(
        "artifact.history.restore",
        json!({ "id": id, "frontiers": after_a_frontier, "note": "restore to A" }),
    ));
    assert_eq!(
        ok(call("artifact.file.get", json!({ "id": id, "path": "structure/chapter-a.md" })))["content"],
        "# Section A\nAuthored by session-a.\n"
    );

    // Shallow compaction preserves latest state on disk and DB.
    ok(call("artifact.history.compact", json!({ "id": id })));
    assert_eq!(
        ok(call("artifact.file.get", json!({ "id": id, "path": "structure/chapter-a.md" })))["content"],
        "# Section A\nAuthored by session-a.\n"
    );

    started.close_blocking();
}

fn minimal_png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    out.extend_from_slice(&13u32.to_be_bytes());
    out.extend_from_slice(b"IHDR");
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    out
}

#[test]
fn artifact_preview_and_derived_cover_without_crdt_or_version_pollution() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    // 1. Storyboard with frame asset resolves `frameAsset` and absolute `framePath` on preview.
    let png = minimal_png_bytes(320, 200);
    let png_b64 = BASE64.encode(&png);
    let sb = ok(call(
        "artifact.create",
        json!({
            "title": "Launch Film",
            "artifactType": "storyboard",
            "announce": false,
            "files": [
                {
                    "path": "structure/shots.json",
                    "content": serde_json::to_string(&json!({
                        "title": "Launch Film",
                        "shots": [
                            { "id": "sh01", "scene": "Opening", "durationSec": 4.0, "visual": "Warm desk overview", "frameAsset": "asset/frames/sh01.png" },
                            { "id": "sh02", "scene": "Close", "durationSec": 2.5, "visual": "Logo lockup" }
                        ]
                    })).unwrap()
                },
                {
                    "path": "asset/frames/sh01.png",
                    "encoding": "base64",
                    "content": png_b64
                }
            ]
        }),
    ));
    let sb_id = sb["id"].as_str().unwrap();
    assert_eq!(sb["preview"]["_tag"], "storyboard");
    assert_eq!(sb["preview"]["shotCount"], 2);
    assert_eq!(sb["preview"]["firstShot"], "Warm desk overview");
    assert_eq!(sb["preview"]["frameAsset"], "asset/frames/sh01.png");
    let frame_path = sb["preview"]["framePath"].as_str().expect("framePath resolved");
    assert!(std::path::Path::new(frame_path).is_file());

    // 2. Prototype preview + derived auto-cover lifecycle.
    let proto = ok(call(
        "artifact.create",
        json!({
            "title": "Checkout Flow",
            "artifactType": "prototype",
            "announce": false,
            "content": "<!doctype html><html><head><title>Checkout</title></head><body><h1>Checkout Flow</h1><p>One-click cart preview</p></body></html>"
        }),
    ));
    let id = proto["id"].as_str().unwrap().to_string();
    assert_eq!(proto["preview"]["_tag"], "prototype");
    assert_eq!(proto["preview"]["heading"], "Checkout Flow");
    assert_eq!(proto["preview"]["subtitle"], "One-click cart preview");
    assert!(proto.get("cover").is_none());

    // Derived cache file `.preview.json` must never appear in file list or manifest.
    let files_before = ok(call("artifact.file.list", json!({ "id": id })));
    let file_paths_before: Vec<&str> = files_before["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(!file_paths_before.iter().any(|p| p.contains(".preview") || p.contains(".cover")));

    // Invalid MIME / mismatched magic bytes / oversized covers are refused.
    assert_eq!(
        code(call(
            "artifact.cover.set",
            json!({ "id": id, "seq": 1, "mime": "image/svg+xml", "data": BASE64.encode(b"<svg/>") })
        )),
        BizCode::ArtifactRefused.code()
    );
    assert_eq!(
        code(call(
            "artifact.cover.set",
            json!({ "id": id, "seq": 1, "mime": "image/png", "data": BASE64.encode(b"not-a-png") })
        )),
        BizCode::ArtifactRefused.code()
    );
    let oversized = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        .into_iter()
        .chain(std::iter::repeat_n(0u8, 2 * 1024 * 1024 + 16))
        .collect::<Vec<_>>();
    assert_eq!(
        code(call(
            "artifact.cover.set",
            json!({ "id": id, "seq": 1, "mime": "image/png", "data": BASE64.encode(&oversized) })
        )),
        BizCode::ArtifactRefused.code()
    );

    // Valid cover save sets metadata, infers PNG dimensions, and does NOT touch seq/version/CRDT/files.
    let history_before = ok(call("artifact.history.list", json!({ "id": id }))).as_array().unwrap().len();
    let cover1 = ok(call("artifact.cover.set", json!({ "id": id, "seq": 1, "mime": "image/png", "data": png_b64 })));
    assert_eq!(cover1["seq"], 1);
    assert_eq!(cover1["mime"], "image/png");
    assert_eq!(cover1["width"], 320);
    assert_eq!(cover1["height"], 200);
    assert_eq!(cover1["url"], format!("/api/v1/artifact/{id}/cover?seq=1"));
    let cover1_path = cover1["path"].as_str().unwrap().to_string();
    assert!(std::path::Path::new(&cover1_path).is_file());

    let after_cover = ok(call("artifact.get", json!({ "id": id })));
    assert_eq!(after_cover["seq"], 1);
    assert_eq!(after_cover["version"], 1);
    assert_eq!(after_cover["cover"]["path"], cover1_path);
    assert_eq!(ok(call("artifact.history.list", json!({ "id": id }))).as_array().unwrap().len(), history_before);
    let files_after = ok(call("artifact.file.list", json!({ "id": id })));
    assert_eq!(files_after["files"], files_before["files"]);

    // Version snapshot must NOT copy `.cover*` or `.preview.json`.
    let v2 = ok(call("artifact.version.create", json!({ "id": id, "note": "v2" })));
    assert_eq!(v2["version"], 2);
    let snap_parent = dir.path().join("artifact_snapshot").join(&id);
    for entry in std::fs::read_dir(&snap_parent).unwrap() {
        let snap_dir = entry.unwrap().path();
        for f in std::fs::read_dir(&snap_dir).unwrap() {
            let name = f.unwrap().file_name().to_string_lossy().to_string();
            assert!(!name.starts_with('.'), "derived hidden file leaked into snapshot: {name}");
        }
    }

    // Editing content advances `seq` and refreshes cached preview.
    ok(call(
        "artifact.file.write",
        json!({
            "id": id,
            "files": [{ "path": "structure/index.html", "content": "<!doctype html><h1>Checkout v2</h1><p>Updated copy</p>" }]
        }),
    ));
    let updated = ok(call("artifact.get", json!({ "id": id })));
    assert_eq!(updated["seq"], 2);
    assert_eq!(updated["preview"]["heading"], "Checkout v2");
    assert_eq!(updated["preview"]["subtitle"], "Updated copy");

    // Re-capturing cover at seq 2 replaces the old cover file path (busting GPUI file:// cache)
    // and rejects/ignores a stale seq 1 overwrite.
    let cover2 = ok(call(
        "artifact.cover.set",
        json!({ "id": id, "seq": 2, "mime": "image/png", "data": BASE64.encode(minimal_png_bytes(640, 400)), "width": 640, "height": 400 }),
    ));
    let cover2_path = cover2["path"].as_str().unwrap().to_string();
    assert_ne!(cover2_path, cover1_path);
    assert!(std::path::Path::new(&cover2_path).is_file());
    assert!(!std::path::Path::new(&cover1_path).exists());

    let stale = ok(call("artifact.cover.set", json!({ "id": id, "seq": 1, "mime": "image/png", "data": png_b64 })));
    assert_eq!(stale["seq"], 2);
    assert_eq!(stale["path"], cover2_path);

    // List endpoint includes previews and covers for all artifacts.
    let listed = ok(call("artifact.list", json!({})));
    let items = listed.as_array().unwrap();
    let proto_item = items.iter().find(|a| a["id"] == id).unwrap();
    assert_eq!(proto_item["preview"]["heading"], "Checkout v2");
    assert_eq!(proto_item["cover"]["path"], cover2_path);

    // HTTP GET /api/v1/artifact/{id}/cover serves stored bytes and 404s when absent.
    let listener = vibevalley_server::gateway::http::serve(hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let base = listener.url();
    let client = reqwest::blocking::Client::new();
    let resp = client.get(format!("{base}/api/v1/artifact/{id}/cover?seq=2")).send().unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    assert_eq!(resp.headers().get("content-type").unwrap().to_str().unwrap(), "image/png");
    assert_eq!(resp.bytes().unwrap().as_ref(), minimal_png_bytes(640, 400).as_slice());

    let missing_cover = client.get(format!("{base}/api/v1/artifact/{sb_id}/cover")).send().unwrap();
    assert_eq!(missing_cover.status(), reqwest::StatusCode::NOT_FOUND);

    drop(listener);
    started.close_blocking();
}

#[cfg(unix)]
#[test]
fn regression_symlinked_home_canonicalizes_cover_and_frame_paths() {
    let real_parent = tempfile::tempdir().unwrap();
    let real_home = real_parent.path().join("real-home");
    let link_home = real_parent.path().join("link-home");
    std::fs::create_dir_all(&real_home).unwrap();
    std::os::unix::fs::symlink(&real_home, &link_home).unwrap();

    let canonical_home = std::fs::canonicalize(&real_home).unwrap();
    let png_b64 = BASE64.encode(minimal_png_bytes(640, 400));

    let started = start(&link_home);
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let sb = ok(call(
        "artifact.create",
        json!({
            "title": "Symlink Storyboard",
            "artifactType": "storyboard",
            "announce": false,
            "files": [
                {
                    "path": "structure/shots.json",
                    "content": serde_json::to_string(&json!({
                        "title": "Symlink Storyboard",
                        "shots": [{ "id": "sh01", "scene": "Open", "durationSec": 2.0, "frameAsset": "asset/frames/sh01.png" }]
                    })).unwrap()
                },
                { "path": "asset/frames/sh01.png", "encoding": "base64", "content": png_b64 }
            ]
        }),
    ));
    let frame_path = sb["preview"]["framePath"].as_str().expect("framePath");
    assert!(
        std::path::Path::new(frame_path).starts_with(&canonical_home),
        "expected canonical framePath under {}, got {frame_path}",
        canonical_home.display()
    );

    let proto = ok(call(
        "artifact.create",
        json!({ "title": "Symlink Prototype", "artifactType": "prototype", "announce": false }),
    ));
    let proto_id = proto["id"].as_str().unwrap().to_string();
    let cover = ok(call(
        "artifact.cover.set",
        json!({ "id": proto_id, "seq": 1, "mime": "image/png", "data": png_b64, "width": 640, "height": 400 }),
    ));
    let cover_path = cover["path"].as_str().expect("cover.path");
    assert!(
        std::path::Path::new(cover_path).starts_with(&canonical_home),
        "expected canonical cover.path under {}, got {cover_path}",
        canonical_home.display()
    );

    // Reload from disk in a fresh server instance to verify `read_cover_from_disk_async` and `.preview.json` cache path too.
    started.close_blocking();
    let restarted = start(&link_home);
    let hub2 = restarted.router().clone();
    let reloaded_proto = ok(hub2.call_as(Caller::User, "artifact.get", json!({ "id": proto_id })));
    let reloaded_cover_path = reloaded_proto["cover"]["path"].as_str().expect("reloaded cover.path");
    assert!(
        std::path::Path::new(reloaded_cover_path).starts_with(&canonical_home),
        "expected canonical reloaded cover.path under {}, got {reloaded_cover_path}",
        canonical_home.display()
    );
    let reloaded_sb = ok(hub2.call_as(Caller::User, "artifact.get", json!({ "id": sb["id"].as_str().unwrap() })));
    let reloaded_frame_path = reloaded_sb["preview"]["framePath"].as_str().expect("reloaded framePath");
    assert!(
        std::path::Path::new(reloaded_frame_path).starts_with(&canonical_home),
        "expected canonical reloaded framePath under {}, got {reloaded_frame_path}",
        canonical_home.display()
    );

    restarted.close_blocking();
}

#[test]
fn artifact_issue_link_and_unlink_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.router().clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let issue_one = ok(call("issue.create", json!({ "title": "First linked issue" })));
    let issue_two = ok(call("issue.create", json!({ "title": "Second linked issue" })));
    let issue_one_id = issue_one["id"].as_str().unwrap().to_string();
    let issue_two_id = issue_two["id"].as_str().unwrap().to_string();
    let issue_two_num = issue_two["number"].as_i64().unwrap();

    let created = ok(call(
        "artifact.create",
        json!({ "title": "Spec Draft", "artifactType": "docs", "announce": false }),
    ));
    let art_id = created["id"].as_str().unwrap().to_string();
    assert!(created.get("issue").is_none());

    // Link by issue id.
    let linked_one = ok(call("artifact.update", json!({ "id": art_id, "issue": issue_one_id })));
    assert_eq!(linked_one["issue"].as_str(), Some(issue_one_id.as_str()));
    let listed_one = ok(call("artifact.list", json!({ "issue": issue_one_id })));
    assert_eq!(listed_one.as_array().unwrap().len(), 1);
    assert_eq!(listed_one[0]["id"], art_id);

    // Re-link by `#number` reference.
    let linked_two = ok(call("artifact.update", json!({ "id": art_id, "issue": format!("#{issue_two_num}") })));
    assert_eq!(linked_two["issue"].as_str(), Some(issue_two_id.as_str()));
    assert!(ok(call("artifact.list", json!({ "issue": issue_one_id }))).as_array().unwrap().is_empty());
    let listed_two = ok(call("artifact.list", json!({ "issue": issue_two_id })));
    assert_eq!(listed_two.as_array().unwrap().len(), 1);
    assert_eq!(listed_two[0]["id"], art_id);

    // Unknown issue reference must be refused and leave the existing link intact.
    assert_eq!(
        code(call("artifact.update", json!({ "id": art_id, "issue": "i-does-not-exist" }))),
        BizCode::IssueNotFound.code()
    );
    assert_eq!(ok(call("artifact.get", json!({ "id": art_id })))["issue"].as_str(), Some(issue_two_id.as_str()));

    // Clear link with empty string.
    let unlinked = ok(call("artifact.update", json!({ "id": art_id, "issue": "" })));
    assert!(unlinked.get("issue").is_none());
    assert!(ok(call("artifact.get", json!({ "id": art_id }))).get("issue").is_none());
    assert!(ok(call("artifact.list", json!({ "issue": issue_two_id }))).as_array().unwrap().is_empty());

    started.close_blocking();
}
