//! Artifacts through their endpoints and as an agent writes them: ports of
//! VibeValley's `artifact.test.ts` and `blocks.test.ts`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, BlockCreate, BlockDelete, BlockUpdate, Caller, Envelope, SuggestionChange, SuggestionCreate, TextSpan};
use vibevalley_server::Server;
use vibevalley_server::modules::artifact::{Artifacts, Maker};

fn start(dir: &std::path::Path) -> vibevalley_server::Started {
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
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

fn code(e: Envelope) -> u32 {
    e.biz_code
}

fn page(words: &str) -> String {
    format!("<!doctype html><title>{words}</title><p>{words}</p>")
}

fn span(t: &str) -> TextSpan {
    TextSpan {
        t: t.into(),
        marks: Default::default(),
    }
}

fn texts(blocks: &Value) -> String {
    blocks
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["text"].as_array().unwrap().iter().map(|s| s["t"].as_str().unwrap()).collect::<String>())
        .collect::<Vec<_>>()
        .join("|")
}

fn last_message(call: &dyn Fn(&str, Value) -> Envelope, channel: &str) -> Value {
    let list = ok(call("channel.message.list", json!({ "id": channel })));
    list.as_array().unwrap().last().unwrap().clone()
}

#[test]
fn html_and_markdown_hand_ins_their_versions_and_refusals() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let general = started.chat.default_channel();

    // Announced with its card where it belongs; a new version keeps the old ones readable.
    let made = ok(call(
        "artifact.create",
        json!({ "title": " 详情：抽屉还是整页 ", "kind": "html", "content": page("抽屉"), "note": "两种" }),
    ));
    assert_eq!(made["title"], "详情：抽屉还是整页");
    assert_eq!(
        (made["body"].as_str(), made["channel"].as_str(), made["version"].as_i64()),
        (Some("html"), Some(general.as_str()), Some(1))
    );
    assert_eq!(
        (made["versions"][0]["note"].as_str(), made["versions"][0]["channel"].as_str()),
        (Some("两种"), Some(general.as_str()))
    );
    let id = made["id"].as_str().unwrap().to_string();
    let said = last_message(&call, &general);
    assert_eq!(
        said["artifact"],
        json!({ "id": id, "title": "详情：抽屉还是整页", "body": "html", "version": 1, "note": "两种", "display": "page" })
    );
    assert_eq!(said["number"], made["versions"][0]["number"]);
    assert_eq!(made["said"]["number"], said["number"]);

    let next = ok(call(
        "artifact.version.create",
        json!({ "id": id, "content": page("整页"), "note": "加了整页" }),
    ));
    assert_eq!((next["version"].as_i64(), next["versions"].as_array().unwrap().len()), (Some(2), 2));
    assert_eq!(last_message(&call, &general)["artifact"]["version"], 2);
    assert_eq!(
        ok(call("artifact.content.get", json!({ "id": id }))),
        json!({ "version": 2, "content": page("整页") })
    );
    assert_eq!(ok(call("artifact.content.get", json!({ "id": id, "version": 1 })))["content"], page("抽屉"));
    assert_eq!(
        code(call("artifact.content.get", json!({ "id": id, "version": 3 }))),
        BizCode::ArtifactNotFound.code()
    );

    // Served as the iframe asks: plain, or in the shell.
    let plain = ok(call("artifact.page", json!({ "id": id, "version": 1 })));
    assert_eq!(plain["content"], page("抽屉"));
    assert!(plain["headers"]["content-security-policy"].as_str().unwrap().starts_with("sandbox "));
    let shown = ok(call("artifact.page", json!({ "id": id, "version": 2, "shell": true, "theme": "dark" })));
    assert!(shown["content"].as_str().unwrap().starts_with(&page("整页")));
    assert!(shown["content"].as_str().unwrap().contains("--vv-page:#151413"));
    assert_eq!(code(call("artifact.page", json!({ "id": id, "version": 9 }))), BizCode::ArtifactNotFound.code());

    // Markdown is read into blocks, as its maker; it takes no version.
    std::thread::sleep(Duration::from_millis(3));
    let notes = started
        .artifacts
        .create(
            &Maker {
                from: "user".into(),
                by: "lab".into(),
                run: None,
            },
            &serde_json::from_value(json!({ "title": "调研", "kind": "markdown", "content": "# 结论\n\n用**抽屉**。", "note": "初稿", "issue": "issue-1" }))
                .unwrap(),
        )
        .unwrap();
    assert_eq!((notes.version, notes.seq, notes.versions.len()), (0, 1, 0));
    assert_eq!(
        last_message(&call, &general)["artifact"],
        json!({ "id": notes.id, "title": "调研", "body": "blocks", "version": 0, "note": "初稿" })
    );
    let snap = ok(call("artifact.block.list", json!({ "id": notes.id })));
    assert_eq!(texts(&snap["blocks"]), "结论|用抽屉。");
    assert_eq!(
        (snap["blocks"][0]["type"].as_str(), snap["blocks"][1]["updatedBy"].as_str()),
        (Some("heading"), Some("lab"))
    );
    assert_eq!(
        ok(call("artifact.content.get", json!({ "id": notes.id }))),
        json!({ "version": 1, "content": "# 结论\n\n用**抽屉**。\n" })
    );
    assert_eq!(
        code(call("artifact.version.create", json!({ "id": notes.id, "content": "x" }))),
        BizCode::ArtifactRefused.code()
    );

    let ids = |q: Value| {
        ok(call("artifact.list", q))
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(json!({ "issue": "issue-1" })), vec![notes.id.clone()]);
    assert_eq!(ids(json!({ "channel": general })), vec![notes.id.clone(), id.clone()]);
    assert_eq!(ids(json!({})).len(), 2);

    // Started on the page: empty and announced nowhere; display is html's only.
    let before = ok(call("channel.message.list", json!({ "id": general }))).as_array().unwrap().len();
    let blank = ok(call("artifact.create", json!({ "title": "周报", "kind": "markdown" })));
    assert_eq!(
        (blank["body"].as_str(), blank["seq"].as_i64(), blank.get("channel")),
        (Some("blocks"), Some(0), None)
    );
    assert_eq!(ok(call("channel.message.list", json!({ "id": general }))).as_array().unwrap().len(), before);
    let bid = blank["id"].as_str().unwrap();
    assert_eq!(code(call("artifact.block.list", json!({ "id": id }))), BizCode::ArtifactRefused.code());
    assert_eq!(ok(call("artifact.update", json!({ "id": bid, "title": "  第 43 周  " })))["title"], "第 43 周");
    assert_eq!(
        code(call("artifact.update", json!({ "id": bid, "title": " " }))),
        BizCode::ArtifactRefused.code()
    );
    assert_eq!(
        code(call("artifact.update", json!({ "id": bid, "display": "slides" }))),
        BizCode::ArtifactRefused.code()
    );
    assert_eq!(ok(call("artifact.update", json!({ "id": id, "display": "slides" })))["display"], "slides");
    assert_eq!(
        code(call(
            "artifact.create",
            json!({ "title": "笔记", "kind": "markdown", "display": "slides", "content": "# 笔记" })
        )),
        BizCode::ArtifactRefused.code()
    );

    // Refusals.
    for (title, kind, content) in [
        ("", "html", page("a")),
        ("a", "html", String::new()),
        ("a", "html", "x".repeat(5 * 1024 * 1024 + 1)),
    ] {
        let e = call("artifact.create", json!({ "title": title, "kind": kind, "content": content }));
        assert_eq!(code(e), BizCode::ArtifactRefused.code(), "{title} {kind}");
    }
    assert_eq!(
        code(call("artifact.create", json!({ "title": "a", "kind": "pdf", "content": "x" }))),
        BizCode::InvalidInput.code()
    );
    assert_eq!(
        code(call("artifact.version.create", json!({ "id": "nope", "content": "x" }))),
        BizCode::ArtifactNotFound.code()
    );
    assert_eq!(
        code(call(
            "artifact.create",
            json!({ "title": "a", "kind": "html", "content": "x", "channel": "#nowhere" })
        )),
        BizCode::ChannelNotFound.code()
    );
}

#[test]
fn html_edits_and_removal_keep_the_pages_once() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let general = started.chat.default_channel();

    let source = "<h1>Launch</h1>\n<p>Ship on Friday.</p>\n<script>document.title = 'Friday'</script>";
    let made = ok(call("artifact.create", json!({ "title": "上线", "kind": "html", "content": source })));
    let id = made["id"].as_str().unwrap();
    let anchor = json!({ "kind": "text", "exact": "Friday", "prefix": "Ship on ", "suffix": "." });
    let next = ok(call(
        "artifact.html.edit",
        json!({ "id": id, "version": 1, "anchor": anchor, "text": "Monday" }),
    ));
    assert_eq!(next["version"], 2);
    assert_eq!(
        ok(call("artifact.content.get", json!({ "id": id })))["content"],
        source.replace("on Friday", "on Monday")
    );
    assert_eq!(ok(call("artifact.content.get", json!({ "id": id, "version": 1 })))["content"], source);
    assert!(last_message(&call, &general)["artifact"]["note"].as_str().unwrap().contains("Monday"));
    for v in [1, 2] {
        let e = call("artifact.html.edit", json!({ "id": id, "version": v, "anchor": anchor, "text": "Sunday" }));
        assert_eq!(code(e), BizCode::ArtifactRefused.code());
    }

    let attachments = dir.path().join("attachments");
    let pages = || {
        std::fs::read_dir(&attachments)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().len() == 64)
            .count()
    };
    let before = pages();
    let same = page("同一页");
    let one = ok(call("artifact.create", json!({ "title": "一", "kind": "html", "content": same })));
    let one = one["id"].as_str().unwrap();
    ok(call("artifact.version.create", json!({ "id": one, "content": page("一的第二版") })));
    let two = ok(call("artifact.create", json!({ "title": "二", "kind": "html", "content": same })));
    let two = two["id"].as_str().unwrap();
    assert_eq!(pages(), before + 2);
    assert_eq!(ok(call("artifact.previewDelete", json!({ "id": one })))["does"].as_array().unwrap().len(), 2);
    ok(call("artifact.delete", json!({ "id": one })));
    assert_eq!(code(call("artifact.get", json!({ "id": one }))), BizCode::ArtifactNotFound.code());
    assert_eq!(ok(call("artifact.content.get", json!({ "id": two })))["content"], same);
    ok(call("artifact.delete", json!({ "id": two })));
    assert_eq!(pages(), before + 2);
}

fn blocks_now(a: &Artifacts, id: &str) -> Vec<vibevalley_protocol::Block> {
    a.live_blocks(id).unwrap()
}

fn plain_of(b: &vibevalley_protocol::Block) -> String {
    vibevalley_artifact::plain(&b.text)
}

#[test]
fn blocks_are_written_together() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let a = started.artifacts.clone();
    let new = |title: &str| {
        ok(call("artifact.create", json!({ "title": title, "kind": "markdown" })))["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let insert = |id: &str, b: &str, key: &str, text: &str| {
        json!({ "id": id, "batchId": format!("ins-{b}"), "lastSeq": 0,
            "ops": [{ "op": "insert_block", "block": { "id": b, "orderKey": key, "type": "paragraph", "attrs": {}, "text": [{ "t": text, "marks": {} }] } }] })
    };

    // The same batch twice is taken once and answered the same.
    let d = new("");
    let first = ok(call("artifact.submit", insert(&d, "a", "V", "一")));
    let second = ok(call("artifact.submit", insert(&d, "a", "V", "一")));
    assert_eq!(
        (first["seq"].as_i64(), second["seq"].as_i64(), second["results"][0]["status"].as_str()),
        (Some(1), Some(1), Some("applied"))
    );
    assert_eq!(
        ok(call("artifact.get", json!({ "id": d })))["title"],
        vibevalley_i18n::t("server.artifact.untitled", &[])
    );
    let other = new("另一篇");
    let again = json!({ "id": other, "batchId": "ins-a", "lastSeq": 0, "ops": [] });
    assert_eq!(code(call("artifact.submit", again)), BizCode::ArtifactRefused.code());
    assert_eq!(
        code(call("artifact.submit", json!({ "id": "nope", "batchId": "x", "lastSeq": 0, "ops": [] }))),
        BizCode::ArtifactNotFound.code()
    );
    let mut dup = insert(&other, "a", "V", "撞了");
    dup["batchId"] = json!("dup");
    assert_eq!(ok(call("artifact.submit", dup))["results"][0]["status"], "rejected");

    // A stale update over someone else's change is a conflict; a tick since is not.
    let id = new("t");
    ok(call("artifact.submit", insert(&id, "x", "V", "原来")));
    let r = a.update_block(
        &id,
        "lab",
        &BlockUpdate {
            block: "x".into(),
            base_rev: 1,
            text: Some("帮工改的".into()),
            r#type: None,
            level: None,
            checked: None,
            language: None,
        },
    );
    assert_eq!(
        r.unwrap().status,
        vibevalley_protocol::BlockOpStatus::Rejected,
        "the user's block becomes a suggestion"
    );
    a.submit(
        &id,
        "lab",
        "lab-1",
        vec![serde_json::from_value(json!({ "op": "update_text", "blockId": "x", "baseRev": 1, "text": [{ "t": "帮工改的", "marks": {} }] })).unwrap()],
    )
    .unwrap();
    let mine = ok(call(
        "artifact.submit",
        json!({ "id": id, "batchId": "3", "lastSeq": 0, "ops": [{ "op": "update_text", "blockId": "x", "baseRev": 1, "text": [{ "t": "我改的", "marks": {} }] }] }),
    ));
    assert_eq!(
        (mine["results"][0]["status"].as_str(), mine["results"][0]["rev"].as_i64(), mine["seq"].as_i64()),
        (Some("conflict"), Some(2), Some(3))
    );
    assert_eq!(mine["results"][0]["yours"][0]["t"], "我改的");
    assert_eq!(plain_of(&blocks_now(&a, &id)[0]), "帮工改的");
    ok(call(
        "artifact.submit",
        json!({ "id": id, "batchId": "4", "lastSeq": 0, "ops": [{ "op": "set_attrs", "blockId": "x", "attrs": { "checked": true } }] }),
    ));
    let later = ok(call(
        "artifact.submit",
        json!({ "id": id, "batchId": "5", "lastSeq": 0, "ops": [{ "op": "update_text", "blockId": "x", "baseRev": 2, "text": [{ "t": "接着改", "marks": {} }] }] }),
    ));
    assert_eq!(later["results"][0]["status"], "applied");

    // Inserts where asked, changes type and attrs, deletes.
    let id = new("块");
    let ins = |text: &str, more: Value| {
        let mut p = json!({ "id": id, "text": text });
        p.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        ok(call("artifact.block.create", p))
    };
    let ba = ins("A", json!({}));
    let bc = ins("C", json!({}));
    let bb = ins("B", json!({ "afterBlock": ba["blockId"] }));
    ins("首", json!({ "afterBlock": "" }));
    let heading = ins("节", json!({ "type": "heading", "level": 1 }));
    let child = ins("子", json!({ "parentId": heading["blockId"] }));
    let snap = ok(call("artifact.block.list", json!({ "id": id })));
    assert_eq!(texts(&snap["blocks"]), "首|A|B|C|节|子");
    assert_eq!(snap["blocks"][5]["parentId"], heading["blockId"]);
    assert_eq!(snap["blocks"][5]["id"], child["blockId"]);
    assert_eq!(
        code(call("artifact.block.create", json!({ "id": id, "text": "x", "type": "divider" }))),
        BizCode::ArtifactRefused.code()
    );
    assert_eq!(
        code(call("artifact.block.create", json!({ "id": id, "text": "x", "level": 2 }))),
        BizCode::ArtifactRefused.code()
    );
    let changed = ok(call(
        "artifact.block.update",
        json!({ "id": id, "block": bb["blockId"], "baseRev": bb["rev"], "type": "todo", "checked": true, "text": "B2" }),
    ));
    assert_eq!(changed["status"], "applied");
    let todo = blocks_now(&a, &id).into_iter().find(|b| Some(b.id.as_str()) == bb["blockId"].as_str()).unwrap();
    assert_eq!(
        (serde_json::to_value(todo.r#type).unwrap(), todo.attrs.checked, plain_of(&todo)),
        (json!("todo"), Some(true), "B2".into())
    );
    assert_eq!(
        ok(call("artifact.block.previewDelete", json!({ "id": id, "block": heading["blockId"] })))["does"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        ok(call("artifact.block.delete", json!({ "id": id, "block": bc["blockId"] })))["status"],
        "applied"
    );
    assert_eq!(ok(call("artifact.block.delete", json!({ "id": id, "block": bc["blockId"] })))["status"], "noop");
    assert_eq!(
        ok(call("artifact.markdown.get", json!({ "id": id })))["markdown"],
        "首\n\nA\n\n- [x] B2\n\n# 节\n\n  子\n"
    );

    // Follows after a seq, then live.
    let id = new("跟进");
    ins_on(&call, &id, "一");
    ins_on(&call, &id, "二");
    let (sub, rx) = hub.subscribe("artifact.follow", json!({ "id": id, "after": 0 })).unwrap();
    let got: Vec<Value> = (0..2).map(|_| rx.recv_timeout(Duration::from_secs(2)).unwrap()).collect();
    assert_eq!(got.iter().map(|e| e["seq"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(got[1]["blocks"][0]["text"][0]["t"], "二");
    ins_on(&call, &id, "三");
    let live = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        (live["_tag"].as_str(), live["seq"].as_i64(), live["blocks"][0]["text"][0]["t"].as_str()),
        (Some("Blocks"), Some(3), Some("三"))
    );
    hub.unsubscribe(sub);

    // Suggestions wait for the user, apply once, go stale when the block moved.
    let id = new("建议");
    let sa = ins_on(&call, &id, "用户写的");
    let (_, srx) = hub.subscribe("artifact.suggestion.follow", json!({ "id": id })).unwrap();
    assert_eq!(srx.recv_timeout(Duration::from_secs(2)).unwrap()["suggestions"], json!([]));
    let made = a
        .suggest(
            &id,
            "lab",
            &SuggestionCreate {
                block: str_of(&sa["blockId"]),
                base_rev: 1,
                change: SuggestionChange {
                    text: Some(vec![span("帮工改的")]),
                    ..Default::default()
                },
            },
        )
        .unwrap();
    assert_eq!(srx.recv_timeout(Duration::from_secs(2)).unwrap()["suggestions"][0]["author"], "lab");
    let accepted = ok(call("artifact.suggestion.accept", json!({ "id": id, "suggestion": made.id })));
    assert_eq!(accepted["status"], "accepted");
    assert_eq!(plain_of(&blocks_now(&a, &id)[0]), "帮工改的");
    assert_eq!(
        ok(call("artifact.suggestion.accept", json!({ "id": id, "suggestion": made.id })))["status"],
        "accepted"
    );
    let sb = ins_on(&call, &id, "再写一块");
    let stale = a
        .suggest(
            &id,
            "lab",
            &SuggestionCreate {
                block: str_of(&sb["blockId"]),
                base_rev: 1,
                change: SuggestionChange {
                    text: Some(vec![span("晚到的")]),
                    ..Default::default()
                },
            },
        )
        .unwrap();
    ok(call(
        "artifact.block.update",
        json!({ "id": id, "block": sb["blockId"], "baseRev": 1, "text": "用户先改了" }),
    ));
    assert_eq!(
        code(call("artifact.suggestion.accept", json!({ "id": id, "suggestion": stale.id }))),
        BizCode::ArtifactRefused.code()
    );
    assert_eq!(
        ok(call("artifact.suggestion.reject", json!({ "id": id, "suggestion": stale.id })))["status"],
        "rejected"
    );
    assert_eq!(
        ok(call("artifact.suggestion.accept", json!({ "id": id, "suggestion": stale.id })))["status"],
        "rejected"
    );

    // An agent's change to the user's block, of any kind, is a suggestion; its own block it changes.
    let id = new("授权矩阵");
    let text = ins_on(&call, &id, "用户的字");
    let block = str_of(&text["blockId"]);
    let up = |more: BlockUpdate| a.update_block(&id, "lab", &more).unwrap();
    let base = BlockUpdate {
        block: block.clone(),
        base_rev: 1,
        text: None,
        r#type: None,
        level: None,
        checked: None,
        language: None,
    };
    let results = [
        up(BlockUpdate {
            text: Some("建议改字".into()),
            ..base.clone()
        }),
        up(BlockUpdate {
            r#type: Some("heading".into()),
            level: Some(2),
            ..base.clone()
        }),
        up(BlockUpdate {
            checked: Some(true),
            ..base.clone()
        }),
        a.delete_block(&id, "lab", &BlockDelete { block: block.clone() }).unwrap(),
    ];
    assert!(
        results
            .iter()
            .all(|r| r.status == vibevalley_protocol::BlockOpStatus::Rejected && r.suggestion.is_some())
    );
    let list = ok(call("artifact.suggestion.list", json!({ "id": id })));
    let shapes: Vec<Value> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            json!([
                s["change"]["text"].is_array(),
                s["change"]["type"],
                s["change"]["attrs"]["checked"],
                s["change"]["delete"]
            ])
        })
        .collect();
    assert_eq!(
        shapes,
        vec![
            json!([true, null, null, null]),
            json!([false, "heading", null, null]),
            json!([false, null, true, null]),
            json!([false, null, null, true])
        ]
    );
    let own = a
        .insert_block(
            &id,
            "lab",
            &BlockCreate {
                text: "帮工自己的".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let mine = a.update_block(
        &id,
        "lab",
        &BlockUpdate {
            block: own.block_id,
            base_rev: own.rev.unwrap(),
            text: Some("帮工改自己的".into()),
            ..base
        },
    );
    assert_eq!(mine.unwrap().status, vibevalley_protocol::BlockOpStatus::Applied);

    // What was written is there for a fresh reader of the same database.
    let reopened = Artifacts::open(dir.path(), started.attachments.clone(), started.chat.clone()).unwrap();
    assert_eq!(reopened.suggestions(&id).unwrap().len(), 4);
    assert_eq!(reopened.markdown(&id).unwrap(), "用户的字\n\n帮工改自己的\n");
}

fn str_of(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

fn ins_on(call: &dyn Fn(&str, Value) -> Envelope, id: &str, text: &str) -> Value {
    ok(call("artifact.block.create", json!({ "id": id, "text": text })))
}

#[test]
fn the_demo_writes_three_sections_and_a_message_quotes_blocks() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let a = started.artifacts.clone();
    a.set_demo_tick(2);
    let id = ok(call("artifact.create", json!({ "title": "演示", "kind": "markdown" })))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let first = ins_on(&call, &id, "用户先写的");

    let helpers: Vec<vibevalley_protocol::Agent> = ["off", "backend", "tester", "frontend", "docs"]
        .iter()
        .map(|name| {
            let mut x = started.agents.profiles.all()[0].clone();
            x.id = name.to_string();
            x.enabled = *name != "off";
            x
        })
        .collect();
    a.demo(&id, &helpers).unwrap();
    assert!(a.demo(&id, &helpers).unwrap_err().message.contains("演示正在写"));
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while a.demo_running() {
        assert!(std::time::Instant::now() < deadline, "the demo finished");
        std::thread::sleep(Duration::from_millis(20));
    }
    let blocks = blocks_now(&a, &id);
    assert_eq!(blocks[0].id, str_of(&first["blockId"]));
    let writers = ["backend", "tester", "frontend"];
    let mut section: i64 = -1;
    for b in &blocks[1..] {
        if b.r#type == vibevalley_protocol::BlockType::Heading {
            section += 1;
            assert!(plain_of(b).ends_with("· 演示"));
            assert_eq!(b.updated_by, writers[section as usize]);
            continue;
        }
        assert_eq!(b.updated_by, writers[section as usize]);
        let words: Vec<String> = (0..3)
            .map(|p| vibevalley_i18n::t(&format!("server.artifact.demo.{section}.paragraphs.{p}"), &[]))
            .collect();
        assert!(words.contains(&plain_of(b)), "{}", plain_of(b));
        assert_eq!(b.rev, vibevalley_artifact::html::DEMO_PIECES as i64 + 1);
    }
    assert_eq!((section, blocks.len()), (2, 1 + 3 * 4));
    let off: Vec<_> = helpers.into_iter().filter(|h| !h.enabled).collect();
    assert_eq!(a.demo(&id, &off).unwrap_err().biz_code, BizCode::ArtifactRefused);

    // A message quotes a block as it is when said.
    let general = started.chat.default_channel();
    let quoted = json!([{ "artifactId": id, "blockId": first["blockId"], "rev": 1 }, { "artifactId": id, "blockId": "gone", "rev": 1 }]);
    ok(call("channel.message.send", json!({ "id": general, "text": "看这段", "blocks": quoted })));
    ok(call(
        "artifact.block.update",
        json!({ "id": id, "block": first["blockId"], "baseRev": 1, "text": "改过了" }),
    ));
    let said = last_message(&call, &general);
    assert_eq!(
        said["blocks"],
        json!([
            { "artifactId": id, "blockId": first["blockId"], "rev": 1, "title": "演示", "type": "paragraph", "text": "用户先写的", "nowRev": 1 },
            { "artifactId": id, "blockId": "gone", "rev": 1, "title": "演示", "deleted": true }
        ])
    );
}
