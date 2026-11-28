//! The chat through its endpoints: places, messages, threads, reactions,
//! pins, search, reads, the follow stream, attachments and a restart.

use crate::support::{RouterTestExt as _, ServerTestExt as _};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller, CollabSlice, DEFAULT_ORCHESTRATOR, Envelope, InboxSlice, ParticipantId, SliceKind};
use vibevalley_server::channel::Posting;
use vibevalley_server::{App, Config, Server, create_app_blocking};

fn start(dir: &std::path::Path) -> App {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..Config::under(dir)
    })
    .unwrap()
}

fn collab_slice(app: &App) -> CollabSlice {
    crate::support::block_on(app.ctx().feed.flush());
    serde_json::from_str(&app.ctx().feed.snapshot_json(SliceKind::Collab)).unwrap()
}

fn inbox_slice(app: &App) -> InboxSlice {
    crate::support::block_on(app.ctx().feed.flush());
    serde_json::from_str(&app.ctx().feed.snapshot_json(SliceKind::Inbox)).unwrap()
}

fn ok(e: Envelope) -> Value {
    assert_eq!(e.biz_code, 0, "{}", e.message);
    e.data.unwrap_or(Value::Null)
}

#[test]
fn the_chat_through_its_endpoints() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let app = start(dir.path());
    let router = app.router();
    let call = |op: &str, p: Value| router.call_as(Caller::User, op, p);

    // A new farm: #general, the default, with the orchestrator in it, and its direct channel.
    let channels = ok(call("channel.list", json!(null)));
    let general = channels[0].clone();
    assert_eq!((general["name"].as_str(), general["default"].as_bool()), (Some("general"), Some(true)));
    assert_eq!(general["members"], json!(["orchestrator"]));
    assert!(
        channels
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["type"] == "direct" && c["peer"] == "orchestrator")
    );
    let gid = general["id"].as_str().unwrap().to_string();

    let mut follow = router.subscribe("channel.follow", json!({ "id": gid, "after": 0 })).unwrap();

    // Said by name; a retry with the same key is the same message.
    ok(call(
        "channel.message.send",
        json!({ "id": "#general", "text": "  hello @助手 ", "sendKey": "k1" }),
    ));
    ok(call("channel.message.send", json!({ "id": gid, "text": "hello @助手", "sendKey": "k1" })));
    let said = ok(call("channel.message.list", json!({ "id": gid })));
    assert_eq!(said.as_array().unwrap().len(), 1);
    let first = &said[0];
    assert_eq!((first["number"].as_i64(), first["text"].as_str()), (Some(1), Some("hello @助手")));
    assert_eq!((first["mentions"].clone(), first["sendKey"].clone()), (json!(["orchestrator"]), json!("k1")));
    assert_eq!(first["actor"], json!({ "kind": "user", "id": "user:self", "name": "用户" }));
    let first_id = first["id"].as_str().unwrap().to_string();

    let event: Value = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(2), follow.1.recv()).await })
        .unwrap()
        .unwrap();
    assert_eq!((event["_tag"].as_str(), event["message"]["number"].as_i64()), (Some("Message"), Some(1)));

    // The state keeps the chat.
    let kept = crate::support::wait_until_transition(app.ctx(), Duration::from_secs(5), "chat channel state updated", || {
        let chat = collab_slice(&app).chat?;
        chat.channels.into_iter().find(|c| c.id == gid && c.last_number == Some(1) && c.read == Some(1))
    });
    assert_eq!((kept.last_number, kept.read), (Some(1), Some(1)));
    assert_eq!(app.ctx().live.call_snapshot().0, vibevalley_protocol::CallState::Live);

    // Channels: made, refused by name, renamed, placed.
    let dev = ok(call("channel.create", json!({ "name": "#dev", "description": "代码" })));
    let dev = dev.as_str().unwrap().to_string();
    assert_eq!(call("channel.create", json!({ "name": "dev" })).biz_code, BizCode::ChannelRefused.code());
    assert_eq!(call("channel.create", json!({ "name": "has space" })).biz_code, BizCode::ChannelRefused.code());
    ok(call("channel.update", json!({ "id": dev, "name": "devs", "category": "工作" })));
    let listed = ok(call("channel.list", json!(null)));
    let devs = listed.as_array().unwrap().iter().find(|c| c["id"] == dev.as_str()).unwrap();
    assert_eq!(
        (devs["name"].as_str(), devs["category"].as_str(), devs["description"].as_str()),
        (Some("devs"), Some("工作"), Some("代码"))
    );
    assert_eq!(
        call("channel.update", json!({ "id": dev, "members": ["nobody"] })).biz_code,
        BizCode::ChannelRefused.code()
    );

    // A thread under a message: once per message (and per request key).
    let thread = ok(call("channel.thread.create", json!({ "id": first_id, "requestKey": "t1" })));
    let again = ok(call("channel.thread.create", json!({ "id": first_id })));
    assert_eq!(thread, again);
    let thread = thread.as_str().unwrap().to_string();
    ok(call("channel.message.send", json!({ "id": thread, "text": "in the thread" })));
    ok(call("channel.message.send", json!({ "id": "#general:1", "text": "by address" })));
    let in_thread = ok(call("channel.message.list", json!({ "id": thread })));
    assert_eq!(in_thread.as_array().unwrap().len(), 2);
    let listed = ok(call("channel.list", json!(null)));
    assert!(listed.as_array().unwrap().iter().all(|c| c["type"] != "thread"), "threads are not listed");
    let chat = collab_slice(&app).chat.unwrap();
    let t = chat.channels.iter().find(|c| c.id == thread).unwrap();
    assert_eq!((t.replies, t.title.as_str(), t.root_number), (2, "hello @助手", Some(1)));

    // Reactions, pins, edits, search, deletion.
    let m = ok(call("channel.reaction.set", json!({ "id": first_id, "emoji": "👍", "on": true })));
    assert_eq!(m["reactions"], json!([{ "emoji": "👍", "by": ["user:self"] }]));
    assert_eq!(
        call("channel.reaction.set", json!({ "id": first_id, "emoji": "a b", "on": true })).biz_code,
        BizCode::ChannelRefused.code()
    );
    let m = ok(call("channel.pin.set", json!({ "id": first_id, "on": true })));
    assert!(m["pinned"].is_i64());
    assert_eq!(ok(call("channel.pin.list", json!({ "id": gid }))).as_array().unwrap().len(), 1);
    let edited = ok(call("channel.message.update", json!({ "id": first_id, "text": "hello there" })));
    assert_eq!((edited["text"].as_str(), edited["edited"].is_i64()), (Some("hello there"), true));
    let hits = ok(call("channel.message.search", json!({ "text": "THERE" })));
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["address"], "#general");
    let hits = ok(call("channel.message.search", json!({ "text": "thread in:general" })));
    assert_eq!(hits[0]["address"], "#general:1");
    let preview = ok(call("channel.message.previewDelete", json!({ "id": first_id })));
    assert!(preview["does"][0].as_str().unwrap().contains("#general"), "{preview}");
    ok(call("channel.message.delete", json!({ "id": first_id })));
    let gone = &ok(call("channel.message.list", json!({ "id": gid })))[0];
    assert_eq!(
        (gone["text"].as_str(), gone["deleted"].is_i64(), gone["number"].as_i64()),
        (Some(""), true, Some(1))
    );
    assert_eq!(
        call("channel.message.delete", json!({ "id": first_id })).biz_code,
        BizCode::ChannelRefused.code()
    );

    // The follower saw every change, in revision order.
    let mut revisions = Vec::new();
    while let Ok(e) = follow.1.try_recv() {
        revisions.push(e["message"]["revision"].as_i64().unwrap());
    }
    assert!(revisions.windows(2).all(|w| w[0] < w[1]) && revisions.len() >= 4, "{revisions:?}");
    router.unsubscribe(follow.0);

    // Reads: what the orchestrator says is unread until read.
    crate::support::block_on(app.test_internals().channel.post_async(Posting {
        from: "orchestrator".into(),
        channel: gid.clone(),
        text: "收到 @用户".into(),
        ..Default::default()
    }))
    .unwrap();
    let unread = |id: &str| {
        let list = ok(call("channel.list", json!(null)));
        list.as_array().unwrap().iter().find(|c| c["id"] == id).unwrap()["unread"].as_i64()
    };
    assert_eq!(unread(&gid), Some(1));
    crate::support::wait_until_transition(app.ctx(), Duration::from_secs(5), "user mention in state", || {
        (collab_slice(&app).chat.is_some_and(|c| c.user_mentions.len() == 1)).then_some(())
    });
    assert_eq!(collab_slice(&app).chat.unwrap().user_mentions.len(), 1);
    ok(call("channel.markRead", json!({ "id": gid, "number": 2 })));
    assert_eq!(unread(&gid), None);
    assert!(collab_slice(&app).chat.unwrap().user_mentions.is_empty());
    ok(call("channel.markUnread", json!({ "id": gid, "number": 2 })));
    assert_eq!(unread(&gid), Some(1));
    assert_eq!(
        call("channel.markRead", json!({ "id": "nope", "number": 1 })).biz_code,
        BizCode::ChannelNotFound.code()
    );

    // A file kept once by its bytes, said with words, and found on disk.
    let a = ok(call("attachment.create", json!({ "name": "a.txt", "type": "text/plain", "data": "aGVsbG8=" })));
    let b = ok(call("attachment.create", json!({ "name": "b.txt", "type": "text/plain", "data": "aGVsbG8=" })));
    assert_eq!(a["id"], b["id"]);
    assert_eq!(a["size"], 5);
    let file = ok(call("attachment.file", json!({ "id": a["id"] })));
    assert_eq!(std::fs::read_to_string(file["path"].as_str().unwrap()).unwrap(), "hello");
    assert_eq!(file["type"], "text/plain");
    assert_eq!(call("attachment.file", json!({ "id": "nope" })).biz_code, BizCode::NotFound.code());
    ok(call("channel.message.send", json!({ "id": dev, "text": "", "attachments": [a["id"]] })));
    let with_file = ok(call("channel.message.list", json!({ "id": dev })));
    assert_eq!(with_file[0]["attachments"][0]["name"], "a.txt");
    assert_eq!(
        call("channel.message.send", json!({ "id": dev, "text": "" })).biz_code,
        BizCode::ChannelRefused.code()
    );

    // Default and removal.
    assert_eq!(call("channel.delete", json!({ "id": gid })).biz_code, BizCode::ChannelRefused.code());
    vibevalley_runtime::rt::block_on(app.test_internals().channel.make_default_async(&dev)).unwrap();
    let preview = ok(call("channel.previewDelete", json!({ "id": gid })));
    assert!(preview["does"][0].as_str().unwrap().contains("#general"), "{preview}");
    ok(call("channel.delete", json!({ "id": gid })));
    crate::support::wait_until_transition(app.ctx(), Duration::from_secs(5), "deleted channel removed from state", || {
        collab_slice(&app)
            .chat
            .is_some_and(|chat| chat.channels.iter().all(|c| c.id != gid && c.id != thread))
            .then_some(())
    });
    let chat = collab_slice(&app).chat.unwrap();
    assert!(chat.channels.iter().all(|c| c.id != gid && c.id != thread));

    // A direct channel with a helper profile.
    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.name = "小帮手".into();
    let helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();
    let direct = ok(call("channel.direct.create", json!({ "agent": "小帮手" })));
    let listed = ok(call("channel.list", json!(null)));
    let d = listed.as_array().unwrap().iter().find(|c| c["id"] == direct).unwrap();
    assert_eq!(
        (d["peer"].as_str(), d["title"].as_str()),
        (Some(format!("agent:{}", helper.id).as_str()), Some("小帮手"))
    );
    app.close_blocking();

    // Everything is there when the chat opens again.
    let app2 = start(dir.path());
    let chat = app2.test_internals().channel;
    let list = vibevalley_runtime::rt::block_on(chat.list_async()).unwrap();
    assert_eq!(list[0].id, dev);
    assert_eq!(vibevalley_runtime::rt::block_on(chat.history_async(&dev, None, None)).unwrap().len(), 1);
    assert!(collab_slice(&app2).chat.unwrap().channels.iter().any(|c| c.id == dev));
    assert_eq!(
        vibevalley_runtime::rt::block_on(chat.events_async(0, 1000))
            .unwrap()
            .iter()
            .filter(|e| e.kind == "removed")
            .count(),
        1
    );
    app2.close_blocking();
}

#[cfg(unix)]
#[test]
fn regression_send_key_thread_pages_and_observer_cursor_survive_sigkill() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::Command;

    const CHANNEL_CRASH_HOME: &str = "VV_TEST_CHANNEL_CRASH_HOME";
    let name = "channel::regression_send_key_thread_pages_and_observer_cursor_survive_sigkill";
    if let Some(home) = std::env::var_os(CHANNEL_CRASH_HOME) {
        let home = std::path::Path::new(&home);
        let server = start(home);
        let call = |op, params| ok(server.router().call_as(Caller::User, op, params));
        let channel = server.test_internals().channel.default_channel();
        for text in ["one", "two", "three"] {
            call("channel.message.send", json!({"id":channel,"text":text,"sendKey":text}));
        }
        let root = vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(&channel, None, None)).unwrap()[0]
            .id
            .clone();
        let thread = call("channel.thread.create", json!({"id":root}));
        call("channel.message.send", json!({"id":thread,"text":"first reply","sendKey":"thread-first"}));
        let checkpoint = vibevalley_runtime::rt::block_on(server.test_internals().channel.events_async(0, 100))
            .unwrap()
            .last()
            .unwrap()
            .seq;
        std::fs::write(home.join("checkpoint"), checkpoint.to_string()).unwrap();
        call(
            "channel.message.send",
            json!({"id":thread,"text":"second reply @助手","sendKey":"thread-second"}),
        );
        Command::new("kill").args(["-KILL", &std::process::id().to_string()]).status().unwrap();
        unreachable!("SIGKILL immediately after message and pending delivery commit");
    }

    let dir = tempfile::tempdir().unwrap();
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name])
        .env(CHANNEL_CRASH_HOME, dir.path())
        .status()
        .unwrap();
    assert_eq!(result.signal(), Some(9));
    let checkpoint: i64 = std::fs::read_to_string(dir.path().join("checkpoint")).unwrap().trim().parse().unwrap();
    let server = start(dir.path());
    let call = |op, params| ok(server.router().call_as(Caller::User, op, params));
    let channel = server.test_internals().channel.default_channel();
    let last_two = vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(&channel, None, Some(2))).unwrap();
    assert_eq!(last_two.iter().map(|m| m.number).collect::<Vec<_>>(), [2, 3]);
    let first = vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(&channel, Some(2), Some(2))).unwrap();
    assert_eq!(first.len(), 1);
    let thread = call("channel.thread.create", json!({"id":first[0].id})).as_str().unwrap().to_owned();
    let replies = vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(&thread, None, Some(2))).unwrap();
    assert_eq!(
        replies.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["first reply", "second reply @助手"]
    );
    let unseen = vibevalley_runtime::rt::block_on(server.test_internals().channel.events_async(checkpoint, 10)).unwrap();
    assert_eq!(unseen.len(), 1);
    assert_eq!(unseen[0].message_id, replies[1].id);
    let orch_pid = ParticipantId::agent(DEFAULT_ORCHESTRATOR);
    let pending: Vec<_> = vibevalley_runtime::rt::block_on(server.test_internals().channel.pending_deliveries_all_async())
        .unwrap()
        .into_iter()
        .filter(|d| d.recipient == orch_pid && d.message_id == replies[1].id)
        .collect();
    assert_eq!(pending.len(), 1, "durable pending delivery must survive SIGKILL");
    call(
        "channel.message.send",
        json!({"id":thread,"text":"second reply @助手","sendKey":"thread-second"}),
    );
    assert_eq!(
        vibevalley_runtime::rt::block_on(server.test_internals().channel.events_async(checkpoint, 10)).unwrap(),
        unseen
    );
    assert_eq!(
        vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(&thread, None, Some(5)))
            .unwrap()
            .len(),
        2
    );
    let pending_after_retry: Vec<_> = vibevalley_runtime::rt::block_on(server.test_internals().channel.pending_deliveries_all_async())
        .unwrap()
        .into_iter()
        .filter(|d| d.recipient == orch_pid && d.message_id == replies[1].id)
        .collect();
    assert_eq!(pending_after_retry.len(), 1, "sendKey retry must not duplicate deliveries");
    vibevalley_runtime::rt::block_on(server.test_internals().channel.settle_delivery_async(pending[0].id, true)).unwrap();
    assert!(
        vibevalley_runtime::rt::block_on(server.test_internals().channel.pending_deliveries_all_async())
            .unwrap()
            .iter()
            .all(|d| d.recipient != orch_pid || d.message_id != replies[1].id)
    );
    server.close_blocking();
}

#[test]
fn regression_deleted_unread_user_mention_clears_inbox_slice() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let app = start(dir.path());
    let gid = app.test_internals().channel.default_channel();

    let (msg, _) = crate::support::block_on(app.test_internals().channel.post_async(Posting {
        from: "orchestrator".into(),
        channel: gid,
        text: "请看一下 @用户".into(),
        ..Default::default()
    }))
    .unwrap();
    assert!(
        inbox_slice(&app).items.iter().any(|item| item.kind == vibevalley_protocol::InboxKind::Mention),
        "unread @user mention must appear in InboxSlice"
    );

    ok(app.router().call_as(Caller::User, "channel.message.delete", json!({ "id": msg.id })));
    assert!(
        inbox_slice(&app).items.iter().all(|item| item.kind != vibevalley_protocol::InboxKind::Mention),
        "deleting unread @user mention must immediately clear InboxSlice: {:?}",
        inbox_slice(&app).items
    );
    app.close_blocking();
}
