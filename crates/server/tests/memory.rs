//! VibeValley `modules/memory`: the user's notes through `memory.*`, a
//! finished round kept as its profile's issue memory, and what a profile
//! remembers set before the next round's words.

use crate::support::RouterTestExt as _;
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
    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    let helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();
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

#[test]
fn farm_profiles_issue_episode_compaction_episode_and_superseding_integration() {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use vibevalley_runtime::agent::{BrainError, ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, Usage};

    struct CompactionModel {
        responses: Mutex<VecDeque<Result<Completion, BrainError>>>,
    }

    impl ModelClient for CompactionModel {
        fn complete<'a>(
            &'a self,
            _request: &'a ChatRequest,
            on: &'a mut (dyn FnMut(Delta) + Send),
        ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::agent::Result<Completion>> {
            let next = self.responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                Ok(Completion {
                    message: Message {
                        role: Role::Assistant,
                        content: Some("好的，已处理。".into()),
                        reasoning: None,
                        tool_calls: vec![],
                        tool_call_id: None,
                    },
                    finish: FinishReason::Stop,
                    usage: Usage::default(),
                })
            });
            if let Ok(ref c) = next
                && let Some(t) = &c.message.content
            {
                on(Delta::Text(t.clone()));
            }
            Box::pin(async move { next })
        }
    }

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let model = Arc::new(CompactionModel {
        responses: Mutex::new(VecDeque::from([
            // First orchestrator generation hits overflow, triggers compaction + summary, then replies.
            Err(BrainError::ContextOverflow("context full".into())),
            Ok(Completion {
                message: Message {
                    role: Role::Assistant,
                    content: Some("压缩总结：确认 farm 仓库采用 SeaORM 双库架构并完成校验。".into()),
                    reasoning: None,
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                finish: FinishReason::Stop,
                usage: Usage::default(),
            }),
            Ok(Completion {
                message: Message {
                    role: Role::Assistant,
                    content: Some("继续处理。".into()),
                    reasoning: None,
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                finish: FinishReason::Stop,
                usage: Usage::default(),
            }),
        ])),
    });
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        model_client: Some(model),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        orchestrator_listens: true,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();

    let call = |op: &str, p: Value| app.router().call_as(Caller::User, op, p);
    let ok = |op: &str, p: Value| {
        let e = call(op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };

    let mut helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    let helper = vibevalley_runtime::rt::block_on(app.test_internals().agent.profile.store.save_async(helper)).unwrap();
    let a = helper.id.as_str();

    // 1. Farm-wide profile memories ordered by importance + transactional superseding.
    let low = ok(
        "memory.create",
        json!({ "agent": "", "kind": "profile", "scope": "farm", "title": "风格", "text": "注释用英文写", "importance": 10 }),
    );
    let high_v1 = ok(
        "memory.create",
        json!({ "agent": "", "kind": "profile", "scope": "farm", "title": "安全准则", "text": "禁止绕过权限检查与静态边界", "importance": 100 }),
    );
    let high_v2 = ok(
        "memory.create",
        json!({ "agent": "", "kind": "profile", "scope": "farm", "title": "安全准则", "text": "禁止绕过权限检查或静态边界", "importance": 100 }),
    );
    let old_row = crate::support::block_on(app.test_internals().agent.memory.get_async(high_v1["id"].as_str().unwrap()))
        .unwrap()
        .expect("superseded profile stays in DB");
    assert_eq!(old_row.replaced_by.as_deref(), high_v2["id"].as_str());

    let orch_prompt = crate::support::block_on(app.test_internals().agent.orchestrator.system_prompt_snapshot_async("orchestrator"));
    let p_high = orch_prompt
        .find("禁止绕过权限检查或静态边界")
        .expect("active farm profile in orchestrator prompt");
    let p_low = orch_prompt.find("注释用英文写").expect("low profile in orchestrator prompt");
    assert!(p_high < p_low, "farm profiles must be ordered by descending importance: {orch_prompt}");
    assert!(!orch_prompt.contains("禁止绕过权限检查与静态边界"), "superseded profile must not be injected");
    assert_ne!(low["id"], high_v2["id"]);

    // 2. Issue completion records an episode memory (retrieval-only via gse search, never auto-injected).
    ok("repo.create", json!({ "name": "farm" }));
    let issue = ok(
        "issue.create",
        json!({
            "title": "验证记忆里程碑回写",
            "description": "完成数据库迁移与检索回写验证",
            "repo": "farm",
            "agent": a,
            "deliver": "answer"
        }),
    );
    let issue_id = issue["id"].as_str().unwrap().to_string();
    ok("issue.status.update", json!({ "id": issue_id, "status": "done" }));

    let issue_ep = crate::support::wait_until_settled(Some(app.ctx()), Duration::from_secs(10), "issue completion episode", || {
        let found = ok("memory.search", json!({ "text": "记忆里程碑回写" }));
        found["found"]
            .as_array()?
            .iter()
            .find(|m| m["kind"] == "episode" && m["text"].as_str().is_some_and(|t| t.contains("验证记忆里程碑回写")))
            .cloned()
    });
    assert_eq!(issue_ep["kind"], "episode");
    let recall = ok("memory.recall", json!({ "agent": a, "repo": "farm", "text": "记忆里程碑回写" }));
    assert!(
        recall["lines"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| !l.as_str().unwrap_or_default().contains("验证记忆里程碑回写")),
        "episode memory must never be auto-injected into recall: {recall}"
    );

    // 3. AgentEvent::Compacted records an episode memory (retrieval-only via gse search, never auto-injected).
    let general = app.test_internals().channel.default_channel();
    ok(
        "channel.message.send",
        json!({ "id": general, "text": "@主助手 看一下情况", "sendKey": "compact-ep-1" }),
    );
    let compact_ep = crate::support::wait_until_settled(Some(app.ctx()), Duration::from_secs(10), "compaction episode", || {
        let found = ok("memory.search", json!({ "text": "双库架构" }));
        found["found"]
            .as_array()?
            .iter()
            .find(|m| m["kind"] == "episode" && m["text"].as_str().is_some_and(|t| t.contains("双库架构")))
            .cloned()
    });
    assert_eq!(compact_ep["kind"], "episode");
    let orch_prompt_after = crate::support::block_on(app.test_internals().agent.orchestrator.system_prompt_snapshot_async("orchestrator"));
    assert!(
        !orch_prompt_after.contains("双库架构"),
        "compaction episode must never be auto-injected into orchestrator prompt"
    );

    app.close_blocking();
}
