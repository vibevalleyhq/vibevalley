//! The watch over a scripted session: the issue's thread opens with the
//! dispatch, a comment goes through the thread to the session (👀), a
//! mention in #general wakes it, words around wait and show in previews,
//! and the report lands in the thread.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::Caller;

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
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
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

    // A comment is said in the thread and told to the session: a new round, 👀 on it.
    call("issue.comment.create", json!({ "id": id, "text": "再说一遍" }));
    let rows = chat.issue_messages(&id).unwrap();
    let mine = rows.iter().rev().find(|m| m.text == "再说一遍").unwrap_or_else(|| panic!("{rows:?}"));
    let seen = call("channel.message.list", json!({ "id": thread }));
    let mine_now = seen.as_array().unwrap().iter().find(|m| m["id"] == mine.id.as_str()).unwrap().clone();
    assert!(mine_now["reactions"].to_string().contains(&session.id), "{mine_now}");
    until("the second run to end", || (runs(&session.id) >= 2).then_some(()));

    // Words around in #general wait for the session's next wake.
    call("channel.message.send", json!({ "id": general, "text": "大家好", "sendKey": "around" }));
    let listed = call("channel.message.list", json!({ "id": general }));
    let around_id = listed.as_array().unwrap().iter().find(|m| m["text"] == "大家好").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let preview = call("channel.message.previewDelete", json!({ "id": around_id }));
    assert!(preview["does"].to_string().contains("1 份不再送"), "{preview}");

    // A mention wakes it, with the words that waited.
    call(
        "channel.message.send",
        json!({ "id": general, "text": format!("@{} 看一下", session.id), "sendKey": "named" }),
    );
    until("the third run to end", || (runs(&session.id) >= 3).then_some(()));
    let events = call("session.event.list", json!({ "id": session.id }));
    let asked = events.to_string();
    assert!(asked.contains("[输入] 有 2 条给你的新消息"), "{asked}");
    let preview = call("channel.message.previewDelete", json!({ "id": around_id }));
    assert_eq!(preview["does"].as_array().unwrap().len(), 1, "{preview}");
    started.board.close();
}
