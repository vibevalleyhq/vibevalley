//! VibeValley `modules/media/library.test.ts`, through `start()`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller, Envelope, Fact, LibraryAddRequest};
use vibevalley_server::content::library::AddedBy;

fn start(dir: &std::path::Path) -> vibevalley_server::Started {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..vibevalley_server::ServerConfig::under(dir)
    })
    .unwrap()
}

fn ok(e: Envelope) -> Value {
    assert_eq!(e.biz_code, 0, "{}", e.message);
    e.data.unwrap_or(Value::Null)
}

fn wait_for(hub: &vibevalley_server::Hub, what: &str, f: impl FnMut() -> Option<Value>) -> Value {
    crate::support::wait_until_settled(Some(hub), Duration::from_secs(5), what, f)
}

fn file(name: &str, words: &str, kind: &str) -> Value {
    use base64::Engine;
    json!({ "name": name, "type": kind, "data": base64::engine::general_purpose::STANDARD.encode(words) })
}

fn image(id: &str, attachment: &Value, phase: &str) -> Fact {
    serde_json::from_value(json!({
        "type": "mediaChanged",
        "at": 2,
        "jobs": [{
            "kind": "image", "id": id, "prompt": "一只橘猫", "model": "m", "connection": "c", "revision": 1,
            "source": { "kind": "user" }, "phase": phase, "phaseText": "", "problem": "", "canCancel": false,
            "canRetryDownload": false, "createdAt": 1, "updatedAt": 2, "attachment": attachment
        }]
    }))
    .expect("a mediaChanged fact")
}

#[test]
fn keeps_what_the_user_says_with_a_file_and_what_a_ready_job_made_once_each() {
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let list = |p: Value| ok(call("library.item.list", p));
    let general = ok(call("channel.list", json!(null)))[0]["id"].as_str().unwrap().to_string();

    let said = ok(call("attachment.create", file("note.txt", "打卡规则", "text/plain")));
    ok(call(
        "channel.message.send",
        json!({ "id": general, "text": "看这个", "sendKey": "k1", "attachments": [said["id"]] }),
    ));
    let uploaded = wait_for(&hub, "the uploaded file", || {
        Some(list(json!({ "origin": "uploaded" }))).filter(|v| v.as_array().unwrap().len() == 1)
    });
    assert_eq!(uploaded[0]["attachment"], said);
    assert_eq!(uploaded[0]["origin"]["channel"], general.as_str());
    assert!(uploaded[0]["origin"]["message"].is_string());

    let made = ok(call("attachment.create", file("cat.png", "not really a png", "image/png")));
    hub.apply(vec![image("job-1", &made, "generating")]);
    hub.apply(vec![image("job-1", &made, "ready")]);
    hub.apply(vec![image("job-1", &made, "ready")]);
    let generated = wait_for(&hub, "the generated file", || {
        Some(list(json!({ "origin": "generated" }))).filter(|v| v.as_array().unwrap().len() == 1)
    });
    assert_eq!(generated[0]["attachment"], made);
    assert_eq!(generated[0]["origin"], json!({ "kind": "generated", "job": "job-1", "jobKind": "image" }));

    // Backdate existing library timestamps so re-referencing `made` guarantees `lastAt > addedAt` without sleeping.
    let mut db = crate::support::inspect_db(&dir.path().join("server.db"));
    crate::support::execute_sql(&mut db, "update media_library_item set added_at = added_at - 1000, last_at = last_at - 1000");
    drop(db);
    ok(call(
        "channel.message.send",
        json!({ "id": general, "text": "再看一次", "sendKey": "k2", "attachments": [made["id"]] }),
    ));
    let all = wait_for(&hub, "the item moved up", || {
        Some(list(json!({}))).filter(|v| v[0]["attachment"]["id"] == made["id"] && v[0]["lastAt"].as_i64() > v[0]["addedAt"].as_i64())
    });
    let got: Vec<(Value, Value)> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["attachment"]["id"].clone(), i["origin"]["kind"].clone()))
        .collect();
    assert_eq!(got, [(made["id"].clone(), json!("generated")), (said["id"].clone(), json!("uploaded"))]);
    let n = |p: Value| list(p).as_array().unwrap().len();
    assert_eq!((n(json!({ "type": "image" })), n(json!({ "type": "other" }))), (1, 1));
    let ids = |p: Value| list(p).as_array().unwrap().iter().map(|i| i["attachment"]["id"].clone()).collect::<Vec<_>>();
    assert_eq!(ids(json!({ "text": "CAT" })), [made["id"].clone()]);
    let names: Vec<Value> = list(json!({ "sort": "name" }))
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["attachment"]["name"].clone())
        .collect();
    assert_eq!(names, [json!("cat.png"), json!("note.txt")]);
    let by_size = if made["size"].as_i64() >= said["size"].as_i64() {
        [made["id"].clone(), said["id"].clone()]
    } else {
        [said["id"].clone(), made["id"].clone()]
    };
    assert_eq!(ids(json!({ "sort": "size" })), by_size);
}

#[test]
fn takes_an_item_out_but_keeps_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let call = |op: &str, p: Value| started.hub.call_as(Caller::User, op, p);
    let kept = ok(call("attachment.create", file("a.txt", "a", "text/plain")));
    let item = ok(call("library.item.add", json!({ "attachment": kept["id"] })));
    assert_eq!(item["origin"], json!({ "kind": "uploaded" }));
    assert_eq!(
        ok(call("library.item.previewDelete", json!({ "id": kept["id"] })))["does"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    ok(call("library.item.delete", json!({ "id": kept["id"] })));
    assert_eq!(ok(call("library.item.list", json!({}))), json!([]));
    ok(call("attachment.file", json!({ "id": kept["id"] })));
    assert_eq!(
        call("library.item.delete", json!({ "id": kept["id"] })).biz_code,
        BizCode::LibraryNotFound.code()
    );
}

#[test]
fn refuses_what_does_not_name_one_public_source_or_is_not_the_callers_to_give() {
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let library = &started.test_internals().library;
    let helper = AddedBy::Agent {
        agent: "lab".into(),
        session: Some("w1".into()),
        dir: None,
    };
    let req = |v: Value| -> LibraryAddRequest { serde_json::from_value(v).unwrap() };
    let mut asks = vec![
        (req(json!({})), helper.clone()),
        (req(json!({ "url": "https://example.com/a.png", "path": "a.png" })), helper.clone()),
        (req(json!({ "url": "https://example.com/a.png" })), AddedBy::User),
        (req(json!({ "attachment": "x" })), helper.clone()),
    ];
    for url in [
        "http://example.com/a.png",
        "https://127.0.0.1/a.png",
        "https://10.0.0.8/a.png",
        "https://[::1]/a.png",
        "file:///etc/passwd",
    ] {
        asks.push((req(json!({ "url": url })), helper.clone()));
    }
    asks.push((req(json!({ "path": "a.png" })), helper.clone()));
    for (r, by) in &asks {
        let e = library.add(r, by).expect_err("refused");
        assert_eq!(e.biz_code, BizCode::LibraryRefused, "{r:?}: {}", e.message);
    }

    // A path in the helper's working directory goes in; one outside it does not.
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("plan.md"), "# plan").unwrap();
    let inside = AddedBy::Agent {
        agent: "lab".into(),
        session: None,
        dir: Some(work.path().into()),
    };
    let item = library.add(&req(json!({ "path": "plan.md" })), &inside).unwrap();
    assert_eq!((item.attachment.name.as_str(), item.attachment.r#type.as_str()), ("plan.md", "text/markdown"));
    assert_eq!(
        serde_json::to_value(&item.origin).unwrap(),
        json!({ "kind": "fetched", "agent": "lab", "from": { "path": "plan.md" } })
    );
    let e = library.add(&req(json!({ "path": "../../etc/hosts" })), &inside).expect_err("outside");
    assert_eq!(e.biz_code, BizCode::LibraryRefused);
}

#[test]
fn regression_library_sort_filter_and_attachment_identity_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path());
    let mut ids = Vec::new();
    for (name, data, kind) in [
        ("zeta.png", "aaa", "image/png"),
        ("Alpha.txt", "a", "text/plain"),
        ("aUDIO.mp3", "aabbb", "audio/mpeg"),
        ("beta.md", "bbb", "text/markdown"),
    ] {
        let file = ok(s.hub.call_as(Caller::User, "attachment.create", file(name, data, kind)));
        let id = file["id"].as_str().unwrap().to_string();
        let added = ok(s.hub.call_as(Caller::User, "library.item.add", json!({"attachment": id})));
        assert_eq!(added["attachment"], file);
        ids.push(id);
    }
    s.close();
    let mut db = crate::support::inspect_db(&dir.path().join("server.db"));
    crate::support::execute_sql(&mut db, "update media_library_item set last_at = 10");
    drop(db);
    let s = start(dir.path());
    let list = |args: Value| {
        let items = ok(s.hub.call_as(Caller::User, "library.item.list", args));
        items
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["attachment"]["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let mut by_id = ids.clone();
    by_id.sort();
    assert_eq!(list(json!({})), by_id);
    assert_eq!(list(json!({"sort":"name"})), [&ids[1], &ids[2], &ids[3], &ids[0]].map(Clone::clone));
    let mut tied = [ids[0].clone(), ids[3].clone()];
    tied.sort();
    assert_eq!(list(json!({"sort":"size"})), [ids[2].clone(), tied[0].clone(), tied[1].clone(), ids[1].clone()]);
    assert_eq!(
        list(json!({"origin":"uploaded","type":"other","sort":"name"})),
        [ids[1].clone(), ids[3].clone()]
    );
    assert_eq!(list(json!({"text":"  ALP  "})), [ids[1].clone()]);
    assert!(list(json!({"origin":"generated"})).is_empty());
    ok(s.hub.call_as(Caller::User, "library.item.delete", json!({"id":ids[1]})));
    assert!(list(json!({"text":"Alpha"})).is_empty());
    assert_eq!(std::fs::read(s.test_internals().attachments.file(&ids[1]).unwrap().path).unwrap(), b"a");
    s.close();
}

#[test]
fn regression_library_observes_edited_message_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let call = |op: &str, p: Value| started.hub.call_as(Caller::User, op, p);
    let list = || ok(call("library.item.list", json!({})));
    let general = ok(call("channel.list", json!(null)))[0]["id"].as_str().unwrap().to_string();

    let attached = ok(call("attachment.create", file("draft.txt", "first version", "text/plain")));
    ok(call(
        "channel.message.send",
        json!({ "id": general, "text": "initial", "sendKey": "edit-k1", "attachments": [attached["id"]] }),
    ));
    let message_id = ok(call("channel.message.list", json!({ "id": general })))[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let first = wait_for(&started.hub, "initial attachment in library", || {
        Some(list()).filter(|v| v.as_array().is_some_and(|a| a.len() == 1))
    });
    let first_last_at = first[0]["lastAt"].as_i64().unwrap();

    // Remove the library entry so the subsequent edit proves `ChannelEvent::Edited`
    // re-records the attachment with its updated timestamp.
    ok(call("library.item.delete", json!({ "id": attached["id"] })));
    assert_eq!(list(), json!([]));

    ok(call(
        "channel.message.update",
        json!({ "id": message_id, "text": "edited with same attachment" }),
    ));
    let restored = wait_for(&started.hub, "edited message attachment in library", || {
        Some(list()).filter(|v| v.as_array().is_some_and(|a| a.len() == 1))
    });
    assert_eq!(restored[0]["attachment"], attached);
    assert_eq!(restored[0]["origin"]["channel"], general.as_str());
    assert_eq!(restored[0]["origin"]["message"], message_id.as_str());
    assert!(restored[0]["lastAt"].as_i64().unwrap() >= first_last_at);
    started.close();
}
