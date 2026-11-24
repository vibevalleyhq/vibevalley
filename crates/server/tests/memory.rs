//! VibeValley `modules/memory`: the user's notes through `memory.*`, a
//! finished round kept as its profile's issue memory, and what a profile
//! remembers set before the next round's words.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller};

#[test]
fn notes_are_kept_searched_recalled_and_forgotten() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let call = |op: &str, p: Value| app.router().call_as(Caller::User, op, p);
    let ok = |op: &str, p: Value| {
        let e = call(op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };
    let mut helper = app.test_internals().agent.profile.store.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    let helper = app.test_internals().agent.profile.store.save(helper).unwrap();
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
    let session = crate::support::wait_until_transition(app.ctx(), Duration::from_secs(30), "the session", || {
        crate::support::board_sessions(app.test_internals().board)
            .into_iter()
            .find(|x| x.issue_id() == Some(id.as_str()))
    });
    let asked = crate::support::wait_until_live(app.ctx(), Duration::from_secs(30), "the first words", || {
        let events = ok("session.event.list", json!({ "id": session.id }));
        let text = events.to_string();
        text.contains("say hello").then_some(text)
    });
    assert!(asked.contains("【你记得的】") && asked.contains("cargo test"), "{asked}");
    crate::support::wait_until_settled(Some(app.ctx()), Duration::from_secs(30), "the issue memory", || {
        let listed = ok("memory.list", json!({ "agent": a }));
        listed["memories"].as_array()?.iter().find(|m| m["kind"] == "issue").cloned()
    });

    let mid = kept["id"].as_str().unwrap();
    let preview = ok("memory.previewDelete", json!({ "agent": a, "memory": mid }));
    assert!(preview["does"][0].as_str().unwrap().contains("cargo test"), "{preview}");
    ok("memory.delete", json!({ "agent": a, "memory": mid }));
    let gone = call("memory.delete", json!({ "agent": a, "memory": mid }));
    assert_eq!(gone.biz_code, BizCode::MemoryNotFound.code());
    app.close_blocking();
}

#[test]
fn regression_replacing_an_agents_notes_rolls_back_the_entire_set() {
    use vibevalley_server::agent::memory::{By, Note};
    let home = tempfile::tempdir().unwrap();
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        ..vibevalley_server::Config::under(home.path())
    })
    .unwrap();
    let notes = &app.test_internals().agent.memory;
    crate::support::block_on(async {
        for (text, by) in [("Keep my preference", By::User), ("Previous note", By::Orchestrator)] {
            notes
                .write_async(&Note {
                    agent: "helper".into(),
                    text: text.into(),
                    repo: String::new(),
                    by,
                })
                .await
                .unwrap();
        }
        let before = notes.list_async("helper").await.unwrap();
        let bad = notes
            .rewrite_async("helper", &["Partial note".into(), "  ".into()], By::Orchestrator)
            .await
            .unwrap_err();
        assert_eq!(bad.biz_code, BizCode::MemoryRefused);
        assert_eq!(notes.list_async("helper").await.unwrap(), before);
        notes.rewrite_async("helper", &["Replacement".into()], By::Orchestrator).await.unwrap();
        let after: Vec<_> = notes.list_async("helper").await.unwrap().into_iter().map(|note| note.text).collect();
        assert_eq!(after, ["Replacement", "Keep my preference"]);
    });
    app.close_blocking();
}
