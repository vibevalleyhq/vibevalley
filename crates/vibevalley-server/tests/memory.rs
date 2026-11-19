//! VibeValley `modules/memory`: the user's notes through `memory.*`, a
//! finished round kept as its profile's issue memory, and what a profile
//! remembers set before the next round's words.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller};

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
fn notes_are_kept_searched_recalled_and_forgotten() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
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
    let call = |op: &str, p: Value| hub.call_as(Caller::User, op, p);
    let ok = |op: &str, p: Value| {
        let e = call(op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };
    let mut helper = started.agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    let helper = started.agents.profiles.save(helper).unwrap();
    let a = helper.id.as_str();

    let empty = call("memory.create", json!({ "agent": a, "text": "   " }));
    assert_eq!(empty.biz_code, BizCode::MemoryRefused.code());
    let kept = ok(
        "memory.create",
        json!({ "agent": a, "text": "farm 仓库的测试用 cargo test 跑", "repo": "farm", "requestKey": "m1" }),
    );
    let again = ok(
        "memory.create",
        json!({ "agent": a, "text": "farm 仓库的测试用 cargo test 跑", "repo": "farm", "requestKey": "m1" }),
    );
    assert_eq!(kept["id"], again["id"]);
    assert_eq!((kept["author"].as_str(), kept["kind"].as_str()), (Some("user"), Some("note")));

    let listed = ok("memory.list", json!({ "agent": a }));
    assert_eq!(listed["memories"].as_array().unwrap().len(), 1);
    assert_eq!(listed["sources"][0]["name"], "local");
    let found = ok("memory.search", json!({ "text": "cargo test" }));
    assert_eq!(found["found"][0]["id"], kept["id"]);
    assert_eq!(found["found"][0]["scope"], json!({ "kind": "repo", "repo": "farm" }));
    let recall = ok("memory.recall", json!({ "agent": a, "repo": "farm", "text": "跑一下测试" }));
    assert_eq!(recall["lines"][0], "- （这个仓库）farm 仓库的测试用 cargo test 跑");

    // A round on the profile is told what it remembers, and what it did is kept.
    ok("repo.create", json!({ "name": "farm" }));
    let issue = ok("issue.create", json!({ "title": "say hello", "repo": "farm", "agent": a }));
    let id = issue["id"].as_str().unwrap().to_string();
    ok("issue.status.update", json!({ "id": id, "status": "todo" }));
    let session = until("the session", || {
        started
            .board
            .read(|s| s.sessions.iter().find(|x| x.issue.as_deref() == Some(id.as_str())).cloned())
    });
    let asked = until("the first words", || {
        let events = ok("session.event.list", json!({ "id": session.id }));
        let text = events.to_string();
        text.contains("say hello").then_some(text)
    });
    assert!(asked.contains("【你记得的】") && asked.contains("cargo test"), "{asked}");
    until("the issue memory", || {
        let listed = ok("memory.list", json!({ "agent": a }));
        listed["memories"].as_array()?.iter().find(|m| m["kind"] == "issue").cloned()
    });

    let mid = kept["id"].as_str().unwrap();
    let preview = ok("memory.previewDelete", json!({ "agent": a, "memory": mid }));
    assert!(preview["does"][0].as_str().unwrap().contains("cargo test"), "{preview}");
    ok("memory.delete", json!({ "agent": a, "memory": mid }));
    let gone = call("memory.delete", json!({ "agent": a, "memory": mid }));
    assert_eq!(gone.biz_code, BizCode::MemoryNotFound.code());
    started.board.close();
}

#[test]
fn regression_replacing_an_agents_notes_rolls_back_the_entire_set() {
    use vibevalley_server::modules::memory::{By, Note};
    let home = tempfile::tempdir().unwrap();
    let server = vibevalley_server::start(vibevalley_server::ServerConfig {
        probe_runtimes: false,
        tick_crons: false,
        watch_pkm: false,
        link_previews: false,
        ..vibevalley_server::ServerConfig::under(home.path())
    })
    .unwrap();
    let notes = &server.memories;
    for (text, by) in [("Keep my preference", By::User), ("Previous note", By::Orchestrator)] {
        notes
            .write(&Note {
                agent: "helper".into(),
                text: text.into(),
                repo: String::new(),
                by,
            })
            .unwrap();
    }
    let before = notes.list("helper").unwrap();
    let bad = notes.rewrite("helper", &["Partial note".into(), "  ".into()], By::Orchestrator).unwrap_err();
    assert_eq!(bad.biz_code, BizCode::MemoryRefused);
    assert_eq!(notes.list("helper").unwrap(), before);
    notes.rewrite("helper", &["Replacement".into()], By::Orchestrator).unwrap();
    let after: Vec<_> = notes.list("helper").unwrap().into_iter().map(|note| note.text).collect();
    assert_eq!(after, ["Replacement", "Keep my preference"]);
    server.close();
}
