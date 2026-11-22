//! Channel routing over a scripted session: the issue's thread opens with the
//! dispatch, a comment goes through the thread to the session (👀), a mention
//! in #general wakes it, words around wait in durable `channel_delivery` and
//! show in previews, the report lands in the thread, and a slow session wakeup
//! never blocks `Chat::say` in other channels.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::Caller;
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime};
use vibevalley_runtime::oar::{Capabilities, Installation, ModelInfo, Runtime, Session, SessionOptions};
use vibevalley_server::modules::collab::channel::DeliveryTargetKind;

fn until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < deadline, "waited for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_watch_routes_the_chat_to_a_session() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(ScriptedRuntime::demo()));
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .unwrap();
    let hub = started.hub.clone();
    let chat = started.chat.clone();
    let call = |op: &str, p: Value| {
        let e = hub.call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };
    let mut helper = started.agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    let helper = started.agents.profiles.save(helper).unwrap();
    call("repo.create", json!({ "name": "farm" }));
    let issue = call("issue.create", json!({ "title": "say hello", "repo": "farm", "agent": helper.id }));
    let id = issue["id"].as_str().unwrap().to_string();
    call("issue.status.update", json!({ "id": id, "status": "todo" }));
    let session = until("the session", || {
        started
            .board
            .read(|s| s.sessions.iter().find(|x| x.issue.as_deref() == Some(id.as_str())).cloned())
    });
    let runs = |sid: &str| -> usize {
        let events = hub
            .call_as(Caller::User, "session.event.list", json!({ "id": sid }))
            .data
            .unwrap_or(Value::Null);
        events.as_array().map(|a| a.iter().filter(|e| e["type"] == "run/end").count()).unwrap_or(0)
    };
    until("the first run to end", || (runs(&session.id) >= 1).then_some(()));

    // The thread hangs under the dispatch in #general; the session is seated there.
    let thread = until("the issue's thread", || chat.issue_thread_id(&id));
    assert_eq!(chat.home_of(&session.id).as_deref(), Some(thread.as_str()));
    let general = chat.default_channel();
    let said = call("channel.message.list", json!({ "id": general }));
    let dispatch = said
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "dispatch")
        .unwrap_or_else(|| panic!("{said}"));
    assert!(dispatch["text"].as_str().unwrap().contains(&format!("@{}", session.id)), "{dispatch}");
    let thread_id = Some(thread.clone());
    assert_eq!(call("issue.conversation.get", json!({ "id": id })).as_str(), thread_id.as_deref());

    // The report lands in the thread from the session.
    until("the report", || {
        let rows = chat.issue_messages(&id).ok()?;
        rows.iter().any(|m| m.from == session.id).then_some(())
    });

    // A comment is said in the thread and delivered asynchronously to the session: a new round, 👀 on it.
    call("issue.comment.create", json!({ "id": id, "text": "再说一遍" }));
    let rows = chat.issue_messages(&id).unwrap();
    let mine = rows.iter().rev().find(|m| m.text == "再说一遍").unwrap_or_else(|| panic!("{rows:?}"));
    until("👀 on the comment", || {
        let seen = call("channel.message.list", json!({ "id": thread }));
        let mine_now = seen.as_array()?.iter().find(|m| m["id"] == mine.id.as_str())?;
        mine_now["reactions"].to_string().contains(&session.id).then_some(())
    });
    until("the second run to end", || (runs(&session.id) >= 2).then_some(()));

    // Words around in #general wait in SQLite `channel_delivery` for the session's next wake.
    call("channel.message.send", json!({ "id": general, "text": "大家好", "sendKey": "around" }));
    let listed = call("channel.message.list", json!({ "id": general }));
    let around_id = listed.as_array().unwrap().iter().find(|m| m["text"] == "大家好").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Wait until the orchestrator settles its own delivery so only the session's passive delivery stays pending.
    until("1 pending delivery on ambient message", || {
        let preview = call("channel.message.previewDelete", json!({ "id": around_id }));
        preview["does"].to_string().contains("1 份不再送").then_some(())
    });

    // A mention wakes it, with the words that waited.
    call(
        "channel.message.send",
        json!({ "id": general, "text": format!("@{} 看一下", session.id), "sendKey": "named" }),
    );
    until("the third run to end", || (runs(&session.id) >= 3).then_some(()));
    let events = call("session.event.list", json!({ "id": session.id }));
    let asked = events.to_string();
    assert!(asked.contains("[输入] 有 2 条给你的新消息"), "{asked}");
    until("ambient delivery settled", || {
        let preview = call("channel.message.previewDelete", json!({ "id": around_id }));
        (preview["does"].as_array()?.len() == 1).then_some(())
    });
    started.close();
}

struct BlockingRuntime {
    id: String,
    entered: flume::Sender<()>,
    release: flume::Receiver<()>,
}

impl Runtime for BlockingRuntime {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        "Blocking Test"
    }

    fn capabilities(&self) -> Capabilities {
        ScriptedRuntime::new(&self.id, Script::new()).capabilities()
    }

    fn installation(&self) -> Installation {
        Installation::Available {
            version: None,
            path: PathBuf::from("(blocking-test)"),
        }
    }

    fn list_models(&self) -> vibevalley_runtime::oar::Result<Vec<ModelInfo>> {
        Ok(vec![])
    }

    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::oar::Result<Arc<dyn Session>> {
        let _ = self.entered.send(());
        let _ = self.release.recv_timeout(Duration::from_secs(15));
        ScriptedRuntime::demo().open(opts)
    }
}

#[test]
fn regression_slow_session_wakeup_does_not_block_chat_say_in_other_channels() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let (entered_tx, entered_rx) = flume::bounded::<()>(4);
    let (release_tx, release_rx) = flume::bounded::<()>(4);
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(BlockingRuntime {
        id: "blocking".into(),
        entered: entered_tx,
        release: release_rx,
    }));
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        orchestrator_listens: false,
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .unwrap();
    let hub = started.hub.clone();
    let call = |op: &str, p: Value| {
        let e = hub.call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };

    let mut helper = started.agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "blocking".into();
    helper.name = "慢速帮手".into();
    started.agents.profiles.save(helper).unwrap();
    let direct = call("channel.direct.create", json!({ "agent": "慢速帮手" })).as_str().unwrap().to_string();
    let other = call("channel.create", json!({ "name": "other" })).as_str().unwrap().to_string();

    // Sending to the slow direct channel must return immediately without waiting for `runtime.open`.
    let started_at = Instant::now();
    call("channel.message.send", json!({ "id": direct, "text": "开始干活", "sendKey": "slow-1" }));
    assert!(
        started_at.elapsed() < Duration::from_secs(1),
        "Chat::say blocked on slow direct wakeup: {:?}",
        started_at.elapsed()
    );
    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("direct talk lane entered BlockingRuntime::open");

    // While `BlockingRuntime::open` is actively blocked, writing in `#other` returns immediately.
    let other_at = Instant::now();
    call("channel.message.send", json!({ "id": other, "text": "另一个频道不阻塞", "sendKey": "fast-1" }));
    assert!(
        other_at.elapsed() < Duration::from_secs(1),
        "Chat::say in another channel was blocked by slow runtime.open: {:?}",
        other_at.elapsed()
    );
    let msgs = call("channel.message.list", json!({ "id": other }));
    let fast_msg = msgs.as_array().unwrap().iter().find(|m| m["text"] == "另一个频道不阻塞").unwrap();
    let fast_id = fast_msg["id"].as_str().unwrap().to_string();

    // Deleting a message withdraws its pending deliveries immediately.
    assert!(
        started
            .chat
            .pending_deliveries(DeliveryTargetKind::Orchestrator)
            .unwrap()
            .iter()
            .any(|d| d.message_id == fast_id)
    );
    call("channel.message.delete", json!({ "id": fast_id }));
    assert!(
        !started
            .chat
            .pending_deliveries(DeliveryTargetKind::Orchestrator)
            .unwrap()
            .iter()
            .any(|d| d.message_id == fast_id)
    );

    // Unblock `runtime.open` and verify the direct-channel talk settles and reports cleanly.
    let _ = release_tx.send(());
    until("direct talk report landed", || {
        let rows = call("channel.message.list", json!({ "id": direct }));
        rows.as_array()?.iter().any(|m| m["kind"] == "report").then_some(())
    });
    assert!(started.chat.pending_deliveries(DeliveryTargetKind::Direct).unwrap().is_empty());
    started.close();
}
