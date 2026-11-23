//! Artifacts through their endpoints and as an agent writes them: ports of
//! VibeValley's `artifact.test.ts` and `blocks.test.ts`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, BlockCreate, BlockDelete, BlockUpdate, Caller, Envelope, SuggestionChange, SuggestionCreate, TextSpan};
use vibevalley_server::Server;
use vibevalley_server::modules::content::artifact::{Artifacts, Maker};

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
    let linked_issue = ok(call("issue.create", json!({ "title": "关联工单" })))["id"].as_str().unwrap().to_string();
    let notes = started
        .artifacts
        .create(
            &Maker {
                from: "user".into(),
                by: "lab".into(),
                run: None,
            },
            &serde_json::from_value(json!({ "title": "调研", "kind": "markdown", "content": "# 结论\n\n用**抽屉**。", "note": "初稿", "issue": linked_issue }))
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
    assert_eq!(ids(json!({ "issue": linked_issue })), vec![notes.id.clone()]);
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
    vibevalley_core::artifact::plain(&b.text)
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
        assert_eq!(b.rev, vibevalley_core::artifact::html::DEMO_PIECES as i64 + 1);
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

#[test]
fn regression_a_failed_artifact_version_never_publishes_its_channel_card() {
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    let dir = tempfile::tempdir().unwrap();
    let server = start(dir.path());
    let call = |op: &str, p: Value| server.hub.call_as(Caller::User, op, p);
    let channel = server.chat.default_channel();
    let created = ok(call("artifact.create", json!({"title":"Proposal","kind":"html","content":page("v1")})));
    let before = ok(call("channel.message.list", json!({"id":channel})));
    let first_card = last_message(&call, &channel);
    let mut events = server.chat.subscribe_events();
    let opts = SqliteConnectOptions::new().filename(dir.path().join("server.db"));
    let mut inspect = pollster::block_on(SqliteConnection::connect_with(&opts)).unwrap();
    pollster::block_on(
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

    pollster::block_on(sqlx::raw_sql("DROP TRIGGER reject_version").execute(&mut inspect)).unwrap();
    pollster::block_on(
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
    pollster::block_on(sqlx::raw_sql("DROP TRIGGER reject_commit").execute(&mut inspect)).unwrap();
    let published = ok(version());
    let card = last_message(&call, &channel);
    assert_eq!(published["version"], 2);
    assert_eq!(card["number"].as_i64(), first_card["number"].as_i64().map(|n| n + 1));
    assert_eq!(card["artifact"]["version"], 2);
    let second = published["versions"].as_array().unwrap().iter().find(|v| v["version"] == 2).unwrap();
    assert_eq!(second["number"], card["number"]);
    assert!(events.try_recv().is_ok());
    assert!(events.try_recv().is_err());
    server.close();
}

#[test]
fn structured_artifact_types_guides_and_starters() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    // Lists all 8 artifact types and serves bilingual progressive-disclosure guides.
    let listed = ok(call("artifact.type.list", json!({})));
    let types: Vec<&str> = listed.as_array().unwrap().iter().map(|t| t["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        vec!["docs", "outline", "slides", "dashboard", "motion", "whiteboard", "design", "design-system"]
    );
    let slides_info = listed.as_array().unwrap().iter().find(|t| t["type"] == "slides").unwrap();
    assert_eq!(slides_info["references"], json!(["craft", "format", "layout"]));

    for ty in &types {
        let guide = ok(call("artifact.type.read", json!({ "type": ty })));
        assert_eq!(guide["type"], *ty);
        assert!(guide["content"].as_str().unwrap().len() > 80);
        assert!(guide["reference"].is_null());
    }
    let craft = ok(call("artifact.type.read", json!({ "type": "slides", "reference": "craft" })));
    assert_eq!(craft["reference"], "craft");
    assert!(craft["content"].as_str().unwrap().contains("tabular-nums"));

    vibevalley_i18n::set_locale("en");
    let wb_en = ok(call("artifact.type.read", json!({ "type": "whiteboard" })));
    assert!(wb_en["content"].as_str().unwrap().contains("elements/"));
    vibevalley_i18n::set_locale("zh");

    assert_eq!(
        code(call("artifact.type.read", json!({ "type": "slides", "reference": "nonexistent" }))),
        BizCode::ArtifactRefused.code()
    );

    // Creates all 7 types with starters, filters by artifactType, and summarizes store entries.
    let docs = ok(call(
        "artifact.create",
        json!({ "title": "架构纪要", "artifactType": "docs", "content": "# 目标\n\n保持清晰。" }),
    ));
    assert_eq!((docs["body"].as_str(), docs["artifactType"].as_str()), (Some("blocks"), Some("docs")));

    for ty in [
        vibevalley_protocol::ArtifactType::Slides,
        vibevalley_protocol::ArtifactType::Dashboard,
        vibevalley_protocol::ArtifactType::Motion,
        vibevalley_protocol::ArtifactType::Whiteboard,
        vibevalley_protocol::ArtifactType::Design,
        vibevalley_protocol::ArtifactType::DesignSystem,
    ] {
        let title = format!("样例-{}", ty.as_str());
        let starters = vibevalley_core::artifact::starter_entries_for_type(ty, &title);
        let made = ok(call(
            "artifact.create",
            json!({ "title": title, "artifactType": ty.as_str(), "entries": starters }),
        ));
        assert_eq!(
            (made["body"].as_str(), made["artifactType"].as_str(), made["seq"].as_i64()),
            (Some("store"), Some(ty.as_str()), Some(1))
        );
        let summary = ok(call("artifact.content.get", json!({ "id": made["id"] })));
        assert_eq!(summary["version"], 1);
        assert!(summary["content"].as_str().unwrap().contains(&format!("type: {}", ty.as_str())));
    }

    let dashboards = ok(call("artifact.list", json!({ "artifactType": "dashboard" })));
    assert_eq!(dashboards.as_array().unwrap().len(), 1);
    assert_eq!(dashboards[0]["artifactType"], "dashboard");

    // Compound filename suffix inference on HTML hand-in.
    let inferred = ok(call("artifact.create", json!({ "title": "Q3.slides.html", "content": page("Q3") })));
    assert_eq!(
        (inferred["title"].as_str(), inferred["body"].as_str(), inferred["display"].as_str()),
        (Some("Q3"), Some("html"), Some("slides"))
    );
    started.close();
}

#[test]
fn store_entry_batch_ops_optimistic_concurrency_and_sanitization() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let png = started.attachments.keep(&[0x89, 0x50, 0x4e, 0x47], "logo.png", "image/png").unwrap();
    let board = ok(call(
        "artifact.create",
        json!({
            "title": "系统拓扑",
            "artifactType": "whiteboard",
            "entries": [
                { "op": "set", "path": "board/meta", "kind": "json", "value": serde_json::to_string(&json!({ "title": "系统拓扑" })).unwrap() },
                { "op": "set", "path": "elements/api", "kind": "json", "value": serde_json::to_string(&json!({ "id": "api", "type": "shape", "x": 100, "label": "Gateway" })).unwrap() }
            ]
        }),
    ));
    let id = board["id"].as_str().unwrap().to_string();
    assert_eq!(board["seq"], 1);

    // Atomic patch (RFC 7396), copy, asset link, and SVG sanitization.
    let batch2 = ok(call(
        "artifact.entry.batch",
        json!({
            "id": id,
            "writes": [
                { "op": "patch", "path": "elements/api", "ifRev": 1, "value": serde_json::to_string(&json!({ "x": 240, "label": null, "note": "Moved" })).unwrap() },
                { "op": "copy", "from": "elements/api", "path": "elements/api-copy" },
                { "op": "set", "path": "assets/logo.png", "kind": "asset", "value": png.id },
                {
                    "op": "set",
                    "path": "elements/diagram",
                    "kind": "json",
                    "value": serde_json::to_string(&json!({
                        "id": "diagram",
                        "type": "svg",
                        "svg": "<svg viewBox=\"0 0 100 100\" onload=\"evil()\"><script>alert(1)</script><rect width=\"80\" height=\"40\"/></svg>"
                    })).unwrap()
                }
            ]
        }),
    ));
    assert_eq!((batch2["applied"].as_bool(), batch2["seq"].as_i64()), (Some(true), Some(2)));

    let api_entry = ok(call("artifact.entry.get", json!({ "id": id, "path": "elements/api" })));
    assert_eq!(api_entry["rev"], 2);
    let api_val: Value = serde_json::from_str(api_entry["value"].as_str().unwrap()).unwrap();
    assert_eq!(
        (api_val["x"].as_i64(), api_val["note"].as_str(), api_val.get("label")),
        (Some(240), Some("Moved"), None)
    );

    let copied = ok(call("artifact.entry.get", json!({ "id": id, "path": "elements/api-copy" })));
    assert_eq!(copied["rev"], 1);
    let asset = ok(call("artifact.entry.get", json!({ "id": id, "path": "assets/logo.png" })));
    assert_eq!((asset["kind"].as_str(), asset["attachmentId"].as_str()), (Some("asset"), Some(png.id.as_str())));

    let diagram = ok(call("artifact.entry.get", json!({ "id": id, "path": "elements/diagram" })));
    let diagram_val: Value = serde_json::from_str(diagram["value"].as_str().unwrap()).unwrap();
    let svg = diagram_val["svg"].as_str().unwrap();
    assert!(!svg.contains("<script"));
    assert!(!svg.contains("onload"));
    assert!(svg.contains("<rect"));

    // Optimistic concurrency conflict leaves store unchanged and returns current entry.
    let conflict = ok(call(
        "artifact.entry.batch",
        json!({
            "id": id,
            "writes": [
                { "op": "patch", "path": "elements/api", "ifRev": 1, "value": "{\"x\":999}" },
                { "op": "delete", "path": "elements/api-copy" }
            ]
        }),
    ));
    assert_eq!((conflict["applied"].as_bool(), conflict["seq"].as_i64()), (Some(false), Some(2)));
    assert_eq!(conflict["conflicts"].as_array().unwrap().len(), 1);
    assert_eq!(
        (
            conflict["conflicts"][0]["path"].as_str(),
            conflict["conflicts"][0]["expectedRev"].as_i64(),
            conflict["conflicts"][0]["actualRev"].as_i64(),
            conflict["conflicts"][0]["current"]["rev"].as_i64(),
        ),
        (Some("elements/api"), Some(1), Some(2), Some(2))
    );
    // Delete was not applied due to atomic conflict rollback.
    assert_eq!(ok(call("artifact.entry.get", json!({ "id": id, "path": "elements/api-copy" })))["rev"], 1);

    // Delete works when preconditions pass.
    let deleted = ok(call(
        "artifact.entry.batch",
        json!({ "id": id, "writes": [{ "op": "delete", "path": "elements/api-copy", "ifRev": 1 }] }),
    ));
    assert_eq!((deleted["applied"].as_bool(), deleted["seq"].as_i64()), (Some(true), Some(3)));
    assert_eq!(
        code(call("artifact.entry.get", json!({ "id": id, "path": "elements/api-copy" }))),
        BizCode::ArtifactNotFound.code()
    );
    started.close();
}

#[test]
fn store_view_csp_headers_default_design_system_tokens_and_http_route() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    // Create standing default design-system artifact.
    let ds_tokens = json!({
        "themes": ["light", "dark"],
        "defaultTheme": "light",
        "color": [
            { "id": "brand-primary", "group": "brand", "value": { "light": "#123456", "dark": "#654321" } }
        ]
    });
    let ds = ok(call(
        "artifact.create",
        json!({
            "title": "品牌设计系统",
            "artifactType": "design-system",
            "isDefault": true,
            "entries": [
                { "op": "set", "path": "project/tokens.json", "kind": "json", "value": serde_json::to_string(&ds_tokens).unwrap() }
            ]
        }),
    ));
    assert_eq!(ds["isDefault"], true);

    // Only design-system can be default.
    let slides = ok(call(
        "artifact.create",
        json!({
            "title": "演示文稿",
            "artifactType": "slides",
            "entries": vibevalley_core::artifact::starter_entries_for_type(vibevalley_protocol::ArtifactType::Slides, "演示文稿")
        }),
    ));
    let slides_id = slides["id"].as_str().unwrap().to_string();
    assert_eq!(
        code(call("artifact.update", json!({ "id": slides_id, "isDefault": true }))),
        BizCode::ArtifactRefused.code()
    );

    // Type registry reports the default design-system id & title.
    let guide = ok(call("artifact.type.read", json!({ "type": "slides" })));
    assert_eq!(guide["defaultArtifactId"], ds["id"]);
    assert_eq!(guide["defaultArtifactTitle"], "品牌设计系统");

    // In-process native `artifact.view` injects standing design-system tokens + CSP headers.
    let view = ok(call(
        "artifact.view",
        json!({ "id": slides_id, "theme": "dark", "origin": "http://127.0.0.1:8787" }),
    ));
    let html = view["content"].as_str().unwrap();
    assert!(html.contains("#123456") || html.contains("#654321"));
    let csp = view["headers"]["content-security-policy"].as_str().unwrap();
    assert!(csp.starts_with("sandbox "));
    assert!(csp.contains("http://127.0.0.1:8787/api/v1/attachment/"));

    // HTTP route `GET /api/v1/artifact/:id/view` serves the rendered HTML with CSP headers.
    let http = vibevalley_server::transport::http::serve(hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let res = ureq::get(&format!("{}/api/v1/artifact/{slides_id}/view?theme=light", http.url()))
        .call()
        .unwrap();
    assert_eq!(res.status(), 200);
    let http_csp = res.headers().get("content-security-policy").unwrap().to_str().unwrap().to_string();
    assert!(http_csp.starts_with("sandbox "));
    assert!(http_csp.contains(&format!("{}/api/v1/attachment/", http.url())));
    let body = res.into_body().read_to_string().unwrap();
    assert!(body.contains("#123456"));
    drop(http);
    started.close();
}

#[test]
fn store_entry_follow_replays_and_streams_live_updates() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let made = ok(call(
        "artifact.create",
        json!({
            "title": "实时看板",
            "artifactType": "dashboard",
            "entries": [{ "op": "set", "path": "dash/params", "kind": "json", "value": "{\"region\":\"east\"}" }]
        }),
    ));
    let id = made["id"].as_str().unwrap().to_string();

    let (sub_id, rx) = hub.subscribe("artifact.entry.follow", json!({ "id": id, "after": 0 })).unwrap();
    let replayed = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!((replayed["_tag"].as_str(), replayed["seq"].as_i64()), (Some("Entries"), Some(1)));
    assert_eq!(replayed["entries"][0]["path"], "dash/params");

    ok(call(
        "artifact.entry.batch",
        json!({
            "id": id,
            "writes": [{ "op": "patch", "path": "dash/params", "value": "{\"region\":\"west\"}" }]
        }),
    ));
    let live = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!((live["_tag"].as_str(), live["seq"].as_i64()), (Some("Entries"), Some(2)));
    assert!(live["entries"][0]["value"].as_str().unwrap().contains("west"));

    hub.unsubscribe(sub_id);
    started.close();
}

#[test]
fn artifact_issue_fk_sets_null_on_issue_delete() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let issue_id = ok(call("issue.create", json!({ "title": "临时工单" })))["id"].as_str().unwrap().to_string();
    let made = ok(call(
        "artifact.create",
        json!({
            "title": "工单产物",
            "artifactType": "whiteboard",
            "issue": issue_id
        }),
    ));
    let artifact_id = made["id"].as_str().unwrap().to_string();
    assert_eq!(made["issue"], issue_id);

    ok(call("issue.delete", json!({ "id": issue_id })));
    let after = ok(call("artifact.get", json!({ "id": artifact_id })));
    assert_eq!(after["id"], artifact_id);
    assert!(after.get("issue").is_none());
    started.close();
}

#[test]
fn outline_artifact_create_read_edit_type_read_card_and_issue_link() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let general = started.chat.default_channel();

    // Bilingual guide for `outline`.
    let guide_zh = ok(call("artifact.type.read", json!({ "type": "outline" })));
    assert_eq!(guide_zh["type"], "outline");
    assert!(guide_zh["content"].as_str().unwrap().contains("outline"));
    vibevalley_i18n::set_locale("en");
    let guide_en = ok(call("artifact.type.read", json!({ "type": "outline" })));
    assert!(guide_en["content"].as_str().unwrap().contains("Tree Outline"));
    vibevalley_i18n::set_locale("zh");

    let issue_id = ok(call("issue.create", json!({ "title": "大纲关联任务" })))["id"].as_str().unwrap().to_string();
    let made = ok(call(
        "artifact.create",
        json!({
            "title": "发布检查清单",
            "artifactType": "outline",
            "content": "- 准备\n  - 核对契约\n- [ ] 上线验证",
            "channel": general,
            "issue": issue_id,
            "note": "初版大纲"
        }),
    ));
    assert_eq!(
        (made["body"].as_str(), made["artifactType"].as_str(), made["issue"].as_str()),
        (Some("blocks"), Some("outline"), Some(issue_id.as_str()))
    );
    let id = made["id"].as_str().unwrap().to_string();
    let card = last_message(&call, &general);
    assert_eq!(card["artifact"]["artifactType"], "outline");
    assert_eq!(card["artifact"]["body"], "blocks");

    let snap = ok(call("artifact.block.list", json!({ "id": id })));
    assert_eq!(snap["blocks"].as_array().unwrap().len(), 3);
    let root_id = snap["blocks"][0]["id"].as_str().unwrap().to_string();
    ok(call(
        "artifact.block.create",
        json!({ "id": id, "parentId": root_id, "type": "todo", "checked": true, "text": "补齐单测" }),
    ));
    let md = ok(call("artifact.markdown.get", json!({ "id": id })))["markdown"].as_str().unwrap().to_string();
    assert!(md.contains("补齐单测"));

    // `.outline.md` filename suffix inference.
    let inferred = ok(call("artifact.create", json!({ "title": "周会纪要.outline.md", "content": "- 议题一" })));
    assert_eq!(
        (inferred["title"].as_str(), inferred["body"].as_str(), inferred["artifactType"].as_str()),
        (Some("周会纪要"), Some("blocks"), Some("outline"))
    );

    let outlines = ok(call("artifact.list", json!({ "artifactType": "outline" })));
    assert_eq!(outlines.as_array().unwrap().len(), 2);
    started.close();
}

#[test]
fn presence_update_follow_and_legacy_presence_entries_never_write_sqlite() {
    use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let board = ok(call(
        "artifact.create",
        json!({
            "title": "协作白板",
            "artifactType": "whiteboard",
            "entries": [
                { "op": "set", "path": "board/meta", "kind": "json", "value": "{\"title\":\"协作白板\"}" }
            ]
        }),
    ));
    let id = board["id"].as_str().unwrap().to_string();
    assert_eq!(board["seq"], 1);

    let (sub_id, rx) = hub.subscribe("artifact.presence.follow", json!({ "id": id })).unwrap();
    let snap = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(snap["_tag"], "Snapshot");
    assert_eq!(snap["peers"], json!([]));

    // 1. Direct `artifact.presence.update` streams `Upsert` without bumping `seq` or writing SQLite.
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
                "status": "构图中",
                "viewport": { "x": 0, "y": 0, "w": 1280, "h": 720, "zoom": 1.25 },
                "updatedAt": 0
            }
        }),
    ));
    let up = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(up["_tag"], "Upsert");
    assert_eq!(up["peer"]["id"], "user");
    assert_eq!(up["peer"]["status"], "构图中");
    assert_eq!(up["peer"]["viewport"]["zoom"], 1.25);

    // 2. Legacy `presence/*` entry batch is intercepted into in-memory `PresenceHub` — zero DB rows, `seq` untouched.
    let legacy = ok(call(
        "artifact.entry.batch",
        json!({
            "id": id,
            "writes": [{
                "op": "set",
                "path": "presence/session-w1",
                "kind": "json",
                "value": serde_json::to_string(&json!({
                    "id": "session-w1",
                    "name": "Planner",
                    "x": 300,
                    "y": 400,
                    "selector": "#hero",
                    "status": "排版中"
                })).unwrap()
            }]
        }),
    ));
    assert_eq!((legacy["applied"].as_bool(), legacy["seq"].as_i64()), (Some(true), Some(1)));
    let up2 = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(up2["_tag"], "Upsert");
    assert_eq!(up2["peer"]["id"], "session-w1");
    assert_eq!(up2["peer"]["selector"], "#hero");

    // Verify zero `presence/*` rows in SQLite and `artifact.seq` stayed at 1.
    assert_eq!(ok(call("artifact.get", json!({ "id": id })))["seq"], 1);
    let opts = SqliteConnectOptions::new().filename(dir.path().join("server.db"));
    let mut inspect = pollster::block_on(SqliteConnection::connect_with(&opts)).unwrap();
    let count: i64 = pollster::block_on(
        sqlx::query("SELECT count(*) AS n FROM artifact_entry WHERE artifact_id = ?1 AND path LIKE 'presence/%'")
            .bind(&id)
            .fetch_one(&mut inspect),
    )
    .unwrap()
    .get("n");
    assert_eq!(count, 0);

    // 3. Sandbox viewer (`artifact.view`) embeds strict-CSP-safe presence highlight listener & active highlights.
    let view = ok(call("artifact.view", json!({ "id": id, "theme": "light" })));
    let view_html = view["content"].as_str().unwrap();
    assert!(view_html.contains("presence-highlight"));
    assert!(view_html.contains("#hero"));
    assert!(view["headers"]["content-security-policy"].as_str().unwrap().starts_with("sandbox "));

    // 4. Clearing presence via legacy delete & `presence.update` emits `Remove`.
    ok(call(
        "artifact.entry.batch",
        json!({ "id": id, "writes": [{ "op": "delete", "path": "presence/session-w1" }] }),
    ));
    let rm1 = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!((rm1["_tag"].as_str(), rm1["peerId"].as_str()), (Some("Remove"), Some("session-w1")));

    ok(call("artifact.presence.update", json!({ "id": id, "peerId": "user" })));
    let rm2 = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!((rm2["_tag"].as_str(), rm2["peerId"].as_str()), (Some("Remove"), Some("user")));

    hub.unsubscribe(sub_id);
    started.close();
}

#[test]
fn persistent_cursor_suggestion_survives_upstream_edit_and_coalesces_same_origin() {
    use vibevalley_core::collab::CommitMeta;

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let a = started.artifacts.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    let doc = ok(call("artifact.create", json!({ "title": "共编文档", "artifactType": "docs" })));
    let id = doc["id"].as_str().unwrap().to_string();
    let b = ok(call("artifact.block.create", json!({ "id": id, "text": "Hello world, ship v1 today." })));
    let block_id = b["blockId"].as_str().unwrap().to_string();

    // Helper edits user-authored block twice in the same turn/origin -> coalesces into one persistent-cursor suggestion.
    let meta_turn1 = CommitMeta::session("Backend", "backend", "w1", 1, Some("bump version".into()), 1_700_000_000_000);
    let r1 = a
        .update_block_with_meta(
            &id,
            "backend",
            &BlockUpdate {
                block: block_id.clone(),
                base_rev: 1,
                text: Some("Hello world, ship v2 today.".into()),
                r#type: None,
                level: None,
                checked: None,
                language: None,
            },
            &meta_turn1,
        )
        .unwrap();
    assert!(r1.suggestion.is_some());
    let s1_id = r1.suggestion.unwrap();

    let r2 = a
        .update_block_with_meta(
            &id,
            "backend",
            &BlockUpdate {
                block: block_id.clone(),
                base_rev: 1,
                text: Some("Hello world, ship v2.5 today.".into()),
                r#type: None,
                level: None,
                checked: None,
                language: None,
            },
            &meta_turn1,
        )
        .unwrap();
    assert_eq!(r2.suggestion.as_deref(), Some(s1_id.as_str()));

    let before_drift = ok(call("artifact.suggestion.list", json!({ "id": id })));
    assert_eq!(before_drift.as_array().unwrap().len(), 1);
    assert!(before_drift[0]["cursorStart"].is_string());
    assert!(before_drift[0]["cursorEnd"].is_string());
    assert_eq!(before_drift[0]["startOffset"], 19);
    assert_eq!(before_drift[0]["endOffset"], 20);

    // User inserts upstream prefix ("NOTE: ") — rev moves 1 -> 2.
    ok(call(
        "artifact.block.update",
        json!({ "id": id, "block": block_id, "baseRev": 1, "text": "NOTE: Hello world, ship v1 today." }),
    ));

    // Suggestion offsets drift forward by 6 Unicode chars ("NOTE: ").
    let after_drift = ok(call("artifact.suggestion.list", json!({ "id": id })));
    assert_eq!(after_drift[0]["startOffset"], 25);
    assert_eq!(after_drift[0]["endOffset"], 26);

    // Accepting the suggestion merges cleanly at the drifted cursor range without clobbering the user's prefix!
    let accepted = ok(call("artifact.suggestion.accept", json!({ "id": id, "suggestion": s1_id })));
    assert_eq!(accepted["status"], "accepted");
    let snap = ok(call("artifact.block.list", json!({ "id": id })));
    assert_eq!(texts(&snap["blocks"]), "NOTE: Hello world, ship v2.5 today.");
    started.close();
}

#[test]
fn time_travel_preview_restore_fork_compaction_and_selective_origin_undo() {
    use vibevalley_core::collab::CommitMeta;

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let started = start(dir.path());
    let hub = started.hub.clone();
    let a = started.artifacts.clone();
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);

    // 1. Interleaved block history: user + session A + session B.
    let outline = ok(call("artifact.create", json!({ "title": "迭代大纲", "artifactType": "outline" })));
    let id = outline["id"].as_str().unwrap().to_string();

    let b1 = a
        .insert_block_with_meta(
            &id,
            "backend",
            &BlockCreate {
                r#type: Some("bulleted".into()),
                text: "Spec: base".into(),
                ..Default::default()
            },
            &CommitMeta::user("user", Some("initial outline".into()), 1_700_000_001_000),
        )
        .unwrap();
    let b1_id = b1.block_id.clone();

    let meta_a = CommitMeta::session("AgentA", "backend", "sA", 1, Some("add A1".into()), 1_700_000_002_000);
    a.update_block_with_meta(
        &id,
        "backend",
        &BlockUpdate {
            block: b1_id.clone(),
            base_rev: 1,
            text: Some("Spec: base [A1]".into()),
            r#type: None,
            level: None,
            checked: None,
            language: None,
        },
        &meta_a,
    )
    .unwrap();
    a.insert_block_with_meta(
        &id,
        "backend",
        &BlockCreate {
            r#type: Some("bulleted".into()),
            text: "A1 detail".into(),
            ..Default::default()
        },
        &meta_a,
    )
    .unwrap();

    let meta_b = CommitMeta::session("AgentB", "frontend", "sB", 1, Some("add B1".into()), 1_700_000_003_000);
    a.update_block_with_meta(
        &id,
        "frontend",
        &BlockUpdate {
            block: b1_id.clone(),
            base_rev: 2,
            text: Some("Spec: base [A1] [B1]".into()),
            r#type: None,
            level: None,
            checked: None,
            language: None,
        },
        &meta_b,
    )
    .unwrap();
    a.insert_block_with_meta(
        &id,
        "frontend",
        &BlockCreate {
            r#type: Some("bulleted".into()),
            text: "B1 detail".into(),
            ..Default::default()
        },
        &meta_b,
    )
    .unwrap();

    // History timeline lists newest first with persisted `CommitMeta`.
    let history = ok(call("artifact.history.list", json!({ "id": id })));
    let entries = history.as_array().unwrap();
    assert_eq!(entries.len(), 5);
    assert_eq!(entries[0]["origin"], "session:sB:turn:1");
    assert_eq!(entries[4]["origin"], "user");
    let first_frontiers = entries[4]["frontiers"].as_str().unwrap().to_string();
    let after_a1_frontiers = entries[2]["frontiers"].as_str().unwrap().to_string();

    // Time-travel read-only preview at initial commit.
    let preview = ok(call("artifact.history.preview", json!({ "id": id, "frontiers": first_frontiers })));
    assert_eq!(preview["body"], "blocks");
    assert_eq!(preview["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(texts(&preview["blocks"]), "Spec: base");
    assert!(preview["markdown"].as_str().unwrap().contains("Spec: base"));

    // Fork at `after_a1_frontiers` creates an independent outline without B1.
    let forked = ok(call(
        "artifact.history.fork",
        json!({ "id": id, "frontiers": after_a1_frontiers, "title": "大纲分叉" }),
    ));
    assert_eq!((forked["title"].as_str(), forked["artifactType"].as_str()), (Some("大纲分叉"), Some("outline")));
    let forked_snap = ok(call("artifact.block.list", json!({ "id": forked["id"] })));
    assert_eq!(texts(&forked_snap["blocks"]), "Spec: base [A1]|A1 detail");

    // Selective per-origin undo removes ONLY `session:sA:turn:1`, keeping user + `session:sB:turn:1`!
    ok(call("artifact.history.undoOrigin", json!({ "id": id, "origin": "session:sA:turn:1" })));
    let after_undo = ok(call("artifact.block.list", json!({ "id": id })));
    assert_eq!(texts(&after_undo["blocks"]), "Spec: base [B1]|B1 detail");

    // Restore back to `first_frontiers` as a new forward commit.
    ok(call(
        "artifact.history.restore",
        json!({ "id": id, "frontiers": first_frontiers, "note": "回到初版" }),
    ));
    let after_restore = ok(call("artifact.block.list", json!({ "id": id })));
    assert_eq!(texts(&after_restore["blocks"]), "Spec: base");

    // Shallow snapshot compaction preserves exact current state.
    ok(call("artifact.history.compact", json!({ "id": id })));
    assert_eq!(
        ok(call("artifact.markdown.get", json!({ "id": id })))["markdown"].as_str().unwrap().trim(),
        "- Spec: base"
    );

    // 2. Store (whiteboard) selective per-origin undo preserves concurrent property edits on the same element.
    let board = ok(call(
        "artifact.create",
        json!({
            "title": "白板历史",
            "artifactType": "whiteboard",
            "entries": [
                { "op": "set", "path": "elements/box1", "kind": "json", "value": "{\"id\":\"box1\",\"x\":100,\"color\":\"blue\"}" }
            ]
        }),
    ));
    let bid = board["id"].as_str().unwrap().to_string();
    let maker_a = Maker {
        from: "sA".into(),
        by: "backend".into(),
        run: None,
    };
    let maker_b = Maker {
        from: "sB".into(),
        by: "frontend".into(),
        run: None,
    };
    a.batch_entries_with_meta(
        &maker_a,
        &vibevalley_protocol::ArtifactEntryBatchRequest {
            id: bid.clone(),
            writes: vec![vibevalley_protocol::ArtifactEntryWriteInput {
                op: vibevalley_protocol::ArtifactEntryOp::Patch,
                path: "elements/box1".into(),
                kind: None,
                value: Some("{\"color\":\"red\"}".into()),
                from: None,
                mime: None,
                if_rev: None,
            }],
            note: Some("recolor".into()),
            announce: Some(false),
        },
        &CommitMeta::session("AgentA", "backend", "sA", 1, Some("recolor".into()), 1_700_000_010_000),
    )
    .unwrap();
    a.batch_entries_with_meta(
        &maker_b,
        &vibevalley_protocol::ArtifactEntryBatchRequest {
            id: bid.clone(),
            writes: vec![vibevalley_protocol::ArtifactEntryWriteInput {
                op: vibevalley_protocol::ArtifactEntryOp::Patch,
                path: "elements/box1".into(),
                kind: None,
                value: Some("{\"x\":500}".into()),
                from: None,
                mime: None,
                if_rev: None,
            }],
            note: Some("move".into()),
            announce: Some(false),
        },
        &CommitMeta::session("AgentB", "frontend", "sB", 1, Some("move".into()), 1_700_000_011_000),
    )
    .unwrap();

    ok(call("artifact.history.undoOrigin", json!({ "id": bid, "origin": "session:sA:turn:1" })));
    let box1 = ok(call("artifact.entry.get", json!({ "id": bid, "path": "elements/box1" })));
    let box1_val: Value = serde_json::from_str(box1["value"].as_str().unwrap()).unwrap();
    assert_eq!(box1_val["color"], "blue");
    assert_eq!(box1_val["x"], 500);
    started.close();
}
