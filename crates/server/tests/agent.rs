//! VibeValley `modules/agent/agent.test.ts` (profiles, templates, skills)
//! and the runtime endpoints over the scripted runtime.

use std::path::Path;
use std::sync::Arc;

use serde_json::json;
use vibevalley_protocol::{
    ActorRef, Agent, AgentExecutionMode, AgentRegisterInput, AgentRole, BizCode, Build, Caller, DEFAULT_ORCHESTRATOR, Head, IssueRequest, IssueStatus,
    IssueStatusUpdateInput, Look, NoteFileWriteItem, NoteFileWriteRequest, NoteHistoryListRequest, NoteRequest, NoteType, ORCHESTRATOR_RUNTIME, PersonaMode,
    Skill, Species, Toolset,
};
use vibevalley_server::agent::profile::{Profile, ProfileStore, profile};
use vibevalley_server::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use vibevalley_server::service::Service;
use vibevalley_server::{Config, create_app_blocking};

fn starters() -> Vec<String> {
    profile::built_in_templates()
        .into_iter()
        .map(|t| t.id)
        .filter(|id| id != DEFAULT_ORCHESTRATOR)
        .collect()
}

fn open(home: &Path) -> Arc<ProfileStore> {
    vibevalley_i18n::set_locale("zh");
    vibevalley_runtime::rt::block_on(ProfileStore::open_async(home, &starters())).unwrap()
}

fn draft() -> Agent {
    Agent {
        id: String::new(),
        code: String::new(),
        name: "同名".into(),
        role: AgentRole::Worker,
        mode: AgentExecutionMode::Managed,
        duty: String::new(),
        enabled: true,
        runtime: "pi".into(),
        machine_id: None,
        model: String::new(),
        effort: String::new(),
        persona: String::new(),
        persona_mode: PersonaMode::Append,
        skills: vec![],
        toolsets: Toolset::defaults_for(AgentRole::Worker),
        mcp_servers: vec![],
        disallowed_tools: vec![],
        env: Default::default(),
        workdir: String::new(),
        worktree: false,
        tags: vec![],
        look: Look {
            species: None,
            outfit: None,
            orchestrator: None,
            build: Build::Biped,
            head: Head::Rounded,
            body: String::new(),
            trim: String::new(),
            hat: String::new(),
            eye: String::new(),
            avatar: None,
        },
        voice: None,
        from: None,
    }
}

fn skill(name: &str, body: &str) -> Skill {
    Skill {
        id: String::new(),
        name: name.into(),
        description: String::new(),
        body: body.into(),
        built_in: None,
    }
}

fn aside(home: &Path) -> Vec<String> {
    std::fs::read_dir(home)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|f| f.starts_with("config.json.unreadable-"))
        .collect()
}

#[test]
fn deleting_a_skill_removes_profile_references() {
    let home = tempfile::tempdir().unwrap();
    let profile = vibevalley_runtime::rt::block_on(async {
        let s = open(home.path());
        let k = s.create_skill_async(skill("Transient Skill", "old")).await.unwrap();
        assert_eq!(k.id, "transient-skill");
        let profile = s
            .create_async(Agent {
                skills: vec![k.id.clone(), "other".into()],
                ..draft()
            })
            .await
            .unwrap()
            .id;
        let orch = s.agent(DEFAULT_ORCHESTRATOR).unwrap();
        s.save_async(Agent {
            skills: vec![k.id.clone()],
            ..orch
        })
        .await
        .unwrap();
        s.remove_skill_async(&k.id).await.unwrap();
        assert_eq!(s.agent(&profile).unwrap().skills, vec!["other"]);
        assert!(s.agent(DEFAULT_ORCHESTRATOR).unwrap().skills.is_empty());
        let again = s.create_skill_async(skill("Transient Skill", "new")).await.unwrap();
        assert_eq!(again.id, k.id);
        assert!(!s.agent(&profile).unwrap().skills.contains(&again.id));
        profile
    });
    let s = open(home.path());
    assert_eq!(s.agent(&profile).unwrap().skills, vec!["other"]);
}

#[test]
fn an_unreadable_config_is_kept_aside() {
    for raw in ["{not json", r#"{"agents":{},"skills":[],"settings":{}}"#] {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("config.json"), raw).unwrap();
        assert!(!open(home.path()).agents().is_empty());
        let kept = aside(home.path());
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read_to_string(home.path().join(&kept[0])).unwrap(), raw);
    }
}

#[test]
fn a_look_without_build_and_head_is_filled_in() {
    let home = tempfile::tempdir().unwrap();
    let mut mine = serde_json::to_value(Agent {
        id: "mine".into(),
        name: "我的".into(),
        ..draft()
    })
    .unwrap();
    mine["look"].as_object_mut().unwrap().remove("build");
    mine["look"].as_object_mut().unwrap().remove("head");
    let raw = json!({
        "agents": [mine],
        "skills": [{ "id": "s1", "name": "tidy", "description": "整理", "body": "整理代码" }],
        "settings": { "pi": { "enabled": true, "binPath": "", "defaultModel": "deepseek-chat", "defaultEffort": "", "env": {} } },
    });
    std::fs::write(home.path().join("config.json"), raw.to_string()).unwrap();
    let s = open(home.path());
    let look = s.agent("mine").unwrap().look;
    assert_eq!((look.build, look.head), (Build::Biped, Head::Rounded));
    let own: Vec<String> = s.skills().into_iter().filter(|k| k.built_in != Some(true)).map(|k| k.id).collect();
    assert_eq!(own, vec!["s1"]);
    assert_eq!(s.settings("pi").default_model, "deepseek-chat");
    assert!(aside(home.path()).is_empty());
}

#[test]
fn a_profile_without_an_animal_gets_the_one_the_client_showed() {
    for (id, want) in [("backend", Species::Cat), ("agent-7", Species::Fox), ("老周", Species::Hedgehog)] {
        let got = profile::with_cast(Agent { id: id.into(), ..draft() });
        assert_eq!(
            (got.look.species, got.look.outfit),
            (Some(want), Some(vibevalley_protocol::Outfit::Farmer)),
            "{id}"
        );
    }
}

#[test]
fn the_orchestrator_is_built_in() {
    let home = tempfile::tempdir().unwrap();
    let s = open(home.path());
    let orch = s.agent(DEFAULT_ORCHESTRATOR).unwrap();
    assert_eq!((orch.runtime.as_str(), orch.enabled), (ORCHESTRATOR_RUNTIME, true));
    assert!(!s.agents().iter().any(|a| a.id == DEFAULT_ORCHESTRATOR));
    vibevalley_runtime::rt::block_on(async {
        assert_eq!(s.remove_async(DEFAULT_ORCHESTRATOR).await.unwrap_err().biz_code, BizCode::AgentRefused);
        assert_eq!(
            s.save_async(Agent {
                runtime: "claude".into(),
                ..orch.clone()
            })
            .await
            .unwrap_err()
            .biz_code,
            BizCode::AgentRefused
        );
        s.save_async(Agent {
            model: "deepseek-pro".into(),
            ..orch
        })
        .await
        .unwrap();
    });
    assert_eq!(open(home.path()).agent(DEFAULT_ORCHESTRATOR).unwrap().model, "deepseek-pro");
}

#[test]
fn roles() {
    let home = tempfile::tempdir().unwrap();
    let s = open(home.path());
    let outside = Agent {
        name: "外头的助手".into(),
        role: AgentRole::Orchestrator,
        runtime: "claude".into(),
        ..draft()
    };
    vibevalley_runtime::rt::block_on(async {
        assert_eq!(s.create_async(outside).await.unwrap_err().biz_code, BizCode::AgentRefused);
        let lead = s
            .create_async(Agent {
                name: "前端组长".into(),
                role: AgentRole::Orchestrator,
                runtime: ORCHESTRATOR_RUNTIME.into(),
                ..draft()
            })
            .await
            .unwrap();
        let ids: Vec<String> = s.orchestrators().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, vec![DEFAULT_ORCHESTRATOR.to_string(), lead.id.clone()]);
        assert!(s.is_orchestrator(&lead.id) && !s.is_orchestrator("backend"));
        let orch = s.agent(DEFAULT_ORCHESTRATOR).unwrap();
        assert_eq!(
            s.save_async(Agent {
                role: AgentRole::Worker,
                ..orch
            })
            .await
            .unwrap_err()
            .biz_code,
            BizCode::AgentRefused
        );
        s.save_async(Agent {
            role: AgentRole::Worker,
            ..lead.clone()
        })
        .await
        .unwrap();
        assert!(s.agents().iter().any(|a| a.id == lead.id));
    });
}

#[test]
fn a_new_farm_has_the_orchestrator_and_the_starters() {
    let home = tempfile::tempdir().unwrap();
    let s = vibevalley_runtime::rt::block_on(ProfileStore::open_async(home.path(), &[])).unwrap();
    let all: Vec<(String, Option<String>)> = s.all().into_iter().map(|a| (a.id, a.from.map(|f| f.template))).collect();
    assert_eq!(all, vec![(DEFAULT_ORCHESTRATOR.into(), Some(DEFAULT_ORCHESTRATOR.into()))]);
    let home = tempfile::tempdir().unwrap();
    let named = vibevalley_runtime::rt::block_on(ProfileStore::open_async(home.path(), &["docs".into(), "nobody".into(), "architect".into()])).unwrap();
    let ids: Vec<String> = named.all().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, vec![DEFAULT_ORCHESTRATOR, "docs", "architect"]);
}

#[test]
fn templates_install_and_update_when_asked() {
    let home = tempfile::tempdir().unwrap();
    let s = open(home.path());
    vibevalley_runtime::rt::block_on(async {
        let second = s.install_template_async("backend").await.unwrap();
        assert_eq!((second.id.as_str(), second.name.as_str()), ("backend-2", "后端工程师 2"));
        let from = second.from.clone().unwrap();
        assert_eq!((from.template.as_str(), from.version), ("backend", 2));
        let backend = s.templates_async().await.into_iter().find(|t| t.id == "backend").unwrap();
        assert_eq!(backend.installed, vec!["backend", "backend-2"]);
        assert_eq!(backend.look.avatar.as_deref(), Some("avatar-backend"));
        assert!(backend.style.as_deref().is_some_and(|st| !st.is_empty()));
        assert_eq!(backend.category, Some(vibevalley_protocol::TemplateCategory::Engineering));
        assert_eq!(s.install_template_async("nobody").await.unwrap_err().biz_code, BizCode::AgentNotFound);
        let mut env = std::collections::BTreeMap::new();
        env.insert("CI".to_string(), "1".to_string());
        s.save_async(Agent {
            name: "后端二号".into(),
            persona: "我自己写的".into(),
            env: env.clone(),
            from: Some(vibevalley_protocol::AgentFrom {
                template: "backend".into(),
                version: 1,
            }),
            ..second
        })
        .await
        .unwrap();
        let again = s.update_from_template_async("backend-2").await.unwrap();
        assert_eq!(again.name, "后端二号");
        assert_eq!(again.persona, backend.persona);
        assert_eq!(again.env, env);
        assert_eq!(again.from.unwrap().version, 2);
        let hand = s
            .create_async(Agent {
                name: "手捏的".into(),
                ..draft()
            })
            .await
            .unwrap();
        assert_eq!(s.update_from_template_async(&hand.id).await.unwrap_err().biz_code, BizCode::AgentRefused);
    });
}

#[test]
fn an_added_template_is_installed_and_deleted() {
    let home = tempfile::tempdir().unwrap();
    let folder = home.path().join("lead-template");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(
        folder.join("agent.json"),
        json!({ "id": "lead", "version": 2, "role": "orchestrator", "name": "组长", "duty": "专管前端" }).to_string(),
    )
    .unwrap();
    std::fs::write(folder.join("persona.md"), "你专管前端的工单。\n").unwrap();
    std::fs::write(folder.join("notes.txt"), "not a template's").unwrap();
    let broken = home.path().join("broken-template");
    std::fs::create_dir(&broken).unwrap();
    std::fs::write(
        broken.join("agent.json"),
        json!({ "id": "Bad Id", "version": 1, "role": "worker", "name": "坏的", "runtime": "pi" }).to_string(),
    )
    .unwrap();
    let s = open(home.path());
    vibevalley_runtime::rt::block_on(async {
        let e = s.add_template_async(&broken.to_string_lossy()).await.unwrap_err();
        assert_eq!(e.biz_code, BizCode::AgentRefused);
        assert!(e.message.contains("Bad Id"), "{}", e.message);
        let nowhere = home.path().join("nowhere");
        assert_eq!(
            s.add_template_async(&nowhere.to_string_lossy()).await.unwrap_err().biz_code,
            BizCode::AgentRefused
        );
        let added = s.add_template_async(&folder.to_string_lossy()).await.unwrap();
        assert_eq!(added.runtime, ORCHESTRATOR_RUNTIME);
        assert_eq!(added.persona, "你专管前端的工单。");
        let mut files: Vec<String> = std::fs::read_dir(home.path().join("agent-templates/lead"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        assert_eq!(files, vec!["agent.json", "persona.md"]);
        assert_eq!(
            s.add_template_async(&folder.to_string_lossy()).await.unwrap_err().biz_code,
            BizCode::AgentRefused
        );
        let lead = s.install_template_async("lead").await.unwrap();
        assert!(lead.role == AgentRole::Orchestrator && s.is_orchestrator(&lead.id));
        assert!(s.preview_remove_template_async("lead").await.unwrap().does[0].contains("1 份角色留着"));
        assert_eq!(s.remove_template_async("backend").await.unwrap_err().biz_code, BizCode::AgentRefused);
        s.remove_template_async("lead").await.unwrap();
        assert!(!s.templates_async().await.iter().any(|t| t.id == "lead"));
        assert_eq!(s.agent(&lead.id).unwrap().from.unwrap().version, 2);
    });
}

#[test]
fn creation_gives_distinct_ids() {
    let home = tempfile::tempdir().unwrap();
    let s = open(home.path());
    let mut ids = std::collections::BTreeSet::new();
    let mut skills = vec![];
    vibevalley_runtime::rt::block_on(async {
        for _ in 0..12 {
            ids.insert(s.create_async(draft()).await.unwrap().id);
            skills.push(s.create_skill_async(skill("Same Skill", "")).await.unwrap().id);
        }
        assert_eq!(ids.len(), 12);
        assert_eq!(skills[..3], ["same-skill", "same-skill-2", "same-skill-3"]);
        assert_eq!(
            s.create_async(Agent { id: "mine".into(), ..draft() }).await.unwrap_err().biz_code,
            BizCode::AgentRefused
        );
        let saved = s
            .save_async(Agent {
                id: "agent-7".into(),
                ..draft()
            })
            .await
            .unwrap();
        assert_eq!(saved.look.species, Some(Species::Fox));
    });
}

#[test]
fn built_in_skills_are_read_only_and_listed_first() {
    let home = tempfile::tempdir().unwrap();
    let s = open(home.path());
    let all = s.skills();
    let reviewer = all.iter().find(|k| k.id == "reviewer").unwrap().clone();
    assert_eq!(all[0].built_in, Some(true));
    assert!(reviewer.name != reviewer.id && !reviewer.body.is_empty());
    let changed = Skill {
        body: "改掉".into(),
        ..reviewer.clone()
    };
    vibevalley_runtime::rt::block_on(async {
        assert_eq!(s.save_skill_async(changed).await.unwrap_err().biz_code, BizCode::AgentRefused);
        assert_eq!(s.remove_skill_async("reviewer").await.unwrap_err().biz_code, BizCode::AgentRefused);
        assert_eq!(s.preview_remove_skill("reviewer").unwrap_err().biz_code, BizCode::AgentRefused);
        let mine = s
            .create_skill_async(Skill {
                built_in: Some(true),
                ..skill("reviewer", "我的")
            })
            .await
            .unwrap();
        assert_eq!((mine.id.as_str(), mine.built_in), ("reviewer-2", None));
        for (id, expected_skills) in [
            ("slides", vec!["slides"]),
            ("collector", vec!["collector"]),
            ("pages", vec!["pages", "notes"]),
            ("reviewer", vec!["reviewer"]),
        ] {
            let t = s.templates_async().await.into_iter().find(|t| t.id == id).unwrap();
            assert_eq!(
                (t.role, t.skills.clone()),
                (AgentRole::Worker, expected_skills.iter().map(|s| s.to_string()).collect::<Vec<_>>())
            );
            assert_eq!(s.install_template_async(id).await.unwrap().skills, expected_skills);
        }
    });
}

#[test]
fn runtimes_over_the_hub() {
    vibevalley_i18n::set_locale("zh");
    let home = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let app = create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        starters: starters(),
        ..Config::under(home.path())
    })
    .unwrap();
    let router = app.router();
    let mut live = app.ctx().live.subscribe_live();

    let list = router.call_as(vibevalley_protocol::Caller::User, "runtime.list", json!(null));
    let list = list.data.unwrap();
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids.first(), Some(&"claude"));
    assert_eq!(ids.last(), Some(&"scripted"));
    assert!(list.as_array().unwrap().iter().all(|r| r["installation"]["status"] == "checking"));

    let got = router.call_as(vibevalley_protocol::Caller::User, "runtime.refresh", json!({ "id": "scripted" }));
    let info = got.data.unwrap();
    assert_eq!(info["installation"]["status"], "available");
    assert_eq!(info["installation"]["via"], "bundled");
    assert!(vibevalley_runtime::rt::block_on(async { tokio::time::timeout(std::time::Duration::from_secs(2), live.recv()).await }).is_ok());

    // Once available and enabled, scripted sorts ahead of unprobed/unavailable runtimes.
    let sorted = router.call_as(vibevalley_protocol::Caller::User, "runtime.list", json!(null)).data.unwrap();
    assert_eq!(sorted.as_array().unwrap()[0]["id"], "scripted");

    let missing = router.call_as(vibevalley_protocol::Caller::User, "runtime.refresh", json!({ "id": "nobody" }));
    assert_eq!(missing.biz_code, BizCode::RuntimeNotFound.code());

    let updated = router.call_as(
        vibevalley_protocol::Caller::User,
        "runtime.setting.update",
        json!({ "id": "scripted", "enabled": false, "binPath": "", "defaultModel": "", "defaultEffort": "", "env": {} }),
    );
    assert_eq!(updated.data.unwrap()["settings"]["enabled"], false);

    // A profile on a runtime that is turned off is not usable.
    let mut a = serde_json::to_value(Agent {
        runtime: "scripted".into(),
        ..draft()
    })
    .unwrap();
    a["id"] = "x".into();
    let v = router.call_as(vibevalley_protocol::Caller::User, "agent.validate", json!({ "agents": [a] }));
    let problems = &v.data.unwrap()[0]["problems"];
    assert_eq!(problems[0]["field"], "runtime");

    let listed = router.call_as(vibevalley_protocol::Caller::User, "agent.list", json!(null));
    assert_eq!(listed.data.unwrap()[0]["id"], DEFAULT_ORCHESTRATOR);

    // Re-enable scripted so installing a template through the router automatically picks it instead of unavailable claude.
    router.call_as(
        vibevalley_protocol::Caller::User,
        "runtime.setting.update",
        json!({ "id": "scripted", "enabled": true, "binPath": "", "defaultModel": "", "defaultEffort": "", "env": {} }),
    );
    let installed_auto = router.call_as(vibevalley_protocol::Caller::User, "agent.template.install", json!({ "id": "fullstack" }));
    let made: Agent = serde_json::from_value(installed_auto.data.unwrap()).unwrap();
    assert_eq!(made.runtime, "scripted");
    assert_eq!(made.look.avatar.as_deref(), Some("avatar-fullstack"));
    let installed_codex = router.call_as(
        vibevalley_protocol::Caller::User,
        "agent.template.install",
        json!({ "id": "frontend", "runtime": "codex" }),
    );
    let frontend: Agent = serde_json::from_value(installed_codex.data.unwrap()).unwrap();
    assert_eq!(frontend.runtime, "codex");
    assert_eq!(frontend.persona_mode, PersonaMode::Append);

    let installed_explicit = router.call_as(
        vibevalley_protocol::Caller::User,
        "agent.template.install",
        json!({ "id": "designer", "runtime": "kimi" }),
    );
    let designed: Agent = serde_json::from_value(installed_explicit.data.unwrap()).unwrap();
    assert_eq!(designed.runtime, "kimi");
    assert_eq!(designed.persona_mode, PersonaMode::Prompt);
    app.close_blocking();
}

/// The scripted runtime with an account whose usage the test sets.
struct Metered {
    inner: vibevalley_runtime::oar::scripted::ScriptedRuntime,
    used: std::sync::Mutex<f64>,
}

impl vibevalley_runtime::oar::Runtime for Metered {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn capabilities(&self) -> vibevalley_runtime::oar::Capabilities {
        self.inner.capabilities()
    }
    fn installation(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Installation> {
        self.inner.installation()
    }
    fn list_models(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<vibevalley_runtime::oar::ModelInfo>>> {
        self.inner.list_models()
    }
    fn open(
        &self,
        opts: vibevalley_runtime::oar::SessionOptions,
    ) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn vibevalley_runtime::oar::Session>>> {
        self.inner.open(opts)
    }
    fn account_usage(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<vibevalley_runtime::oar::AccountUsage>> {
        let used = *self.used.lock().unwrap();
        Box::pin(async move {
            Ok(vibevalley_runtime::oar::AccountUsage::Available {
                plan: Some("max".into()),
                email: None,
                rate_limited: false,
                windows: vec![vibevalley_runtime::oar::UsageWindow {
                    label: "5h".into(),
                    used_ratio: used,
                    resets_at: None,
                    id: None,
                    duration_ms: None,
                }],
            })
        })
    }
}

#[test]
fn usage_is_read_again_and_told() {
    let home = tempfile::tempdir().unwrap();
    let metered = Arc::new(Metered {
        inner: vibevalley_runtime::oar::scripted::ScriptedRuntime::demo(),
        used: 0.25.into(),
    });
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(metered.clone());
    vibevalley_runtime::rt::block_on(async {
        let service = Service::open(home.path()).await.unwrap();
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service.clone())),
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let profile = Profile::open_async(ctx.clone(), home.path(), &starters(), Arc::new(registry), false)
            .await
            .unwrap();
        let fleet = profile.fleet.clone();
        let probed = fleet.refresh_async("scripted").await.unwrap();
        assert_eq!(serde_json::to_value(&probed.usage).unwrap()["windows"][0]["usedPercent"], 25);

        let mut live = ctx.live.subscribe_live();
        *metered.used.lock().unwrap() = 0.5;
        fleet.refresh_usage_async("scripted").await;
        let told = tokio::time::timeout(std::time::Duration::from_secs(2), live.recv()).await.unwrap().unwrap();
        assert!(serde_json::to_string(&told).unwrap().contains("\"usedPercent\":50"));
        assert_eq!(
            serde_json::to_value(&fleet.info_async("scripted").await.unwrap().usage).unwrap()["windows"][0]["usedPercent"],
            50
        );

        // Nothing changed: nothing is told.
        fleet.refresh_usage_async("scripted").await;
        assert!(tokio::time::timeout(std::time::Duration::from_millis(200), live.recv()).await.is_err());
        let _ = ctx.shutdown(std::time::Duration::from_secs(1)).await;
        service.close().await;
    });
}

#[test]
fn user_skills_migrate_to_skills_directory_and_roundtrip_on_disk() {
    let home = tempfile::tempdir().unwrap();
    let legacy_agent = json!({
        "id": "legacy-worker",
        "name": "旧帮工",
        "role": "worker",
        "duty": "",
        "enabled": true,
        "runtime": "pi",
        "model": "",
        "effort": "",
        "persona": "",
        "personaMode": "append",
        "skills": ["migrated-skill"],
        "mcpServers": [],
        "disallowedTools": [],
        "env": {},
        "workdir": "",
        "worktree": false,
        "tags": [],
        "look": { "species": "cat", "outfit": "farmer", "orchestrator": null, "body": "", "trim": "", "hat": "", "eye": "" }
    });
    let raw = json!({
        "agents": [legacy_agent],
        "skills": [{ "id": "migrated-skill", "name": "Migrated Skill", "description": "from config", "body": "Follow the migrated checklist." }],
        "settings": {}
    });
    std::fs::write(home.path().join("config.json"), raw.to_string()).unwrap();

    let s = open(home.path());
    let skill_md = home.path().join("skills").join("migrated-skill").join("SKILL.md");
    assert!(skill_md.is_file(), "expected migrated SKILL.md at {}", skill_md.display());
    let disk_content = std::fs::read_to_string(&skill_md).unwrap();
    assert!(
        disk_content.contains("Migrated Skill") && disk_content.contains("Follow the migrated checklist."),
        "{disk_content}"
    );

    let cfg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.path().join("config.json")).unwrap()).unwrap();
    assert!(cfg.get("skills").is_none(), "config.json should no longer persist skills: {cfg}");
    assert_eq!(s.agent("legacy-worker").unwrap().toolsets, Toolset::defaults_for(AgentRole::Worker));

    vibevalley_runtime::rt::block_on(async {
        let created = s
            .create_skill_async(Skill {
                id: String::new(),
                name: "Lint Check".into(),
                description: "Run checks".into(),
                body: "Run cargo clippy".into(),
                built_in: None,
            })
            .await
            .unwrap();
        assert_eq!(created.id, "lint-check");
        assert!(home.path().join("skills/lint-check/SKILL.md").is_file());

        s.remove_skill_async("migrated-skill").await.unwrap();
        assert!(!skill_md.exists());
    });
}

#[test]
fn agent_optional_voice_persists_through_config_without_migration() {
    let home = tempfile::tempdir().unwrap();
    vibevalley_runtime::rt::block_on(async {
        let s = open(home.path());
        let created = s
            .create_async(Agent {
                name: "VoiceWorker".into(),
                voice: Some("voice-one".into()),
                ..draft()
            })
            .await
            .unwrap();
        assert_eq!(created.voice.as_deref(), Some("voice-one"));
        let reopened = open(home.path());
        assert_eq!(reopened.agent(&created.id).unwrap().voice.as_deref(), Some("voice-one"));
    });
}

#[test]
fn teammate_codes_external_registration_and_non_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let app = create_app_blocking(Config {
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let rt_app = app.test_internals();
    let router = app.router();

    let agents = rt_app.agent.profile.all();
    let orch = agents.iter().find(|a| a.id == DEFAULT_ORCHESTRATOR).expect("default orchestrator");
    assert_eq!(orch.code, "O-01");
    assert_eq!(orch.mode, AgentExecutionMode::Managed);
    for worker in agents.iter().filter(|a| a.role == AgentRole::Worker) {
        assert!(worker.code.starts_with("W-"), "expected W-XX code for {}", worker.id);
    }

    // Register an external coding agent idempotently via router.
    let first = router.call_as(
        Caller::User,
        "agent.register",
        serde_json::to_value(AgentRegisterInput {
            id: Some("antigravity-ide".into()),
            name: "Antigravity".into(),
            runtime: Some("antigravity".into()),
            duty: Some("IDE teammate".into()),
            avatar: None,
            code: None,
            tags: Some(vec!["ide".into()]),
        })
        .unwrap(),
    );
    let registered: Agent = serde_json::from_value(first.data.expect("register ok")).unwrap();
    assert_eq!(registered.id, "antigravity-ide");
    assert!(registered.code.starts_with("W-"));
    assert_eq!(registered.mode, AgentExecutionMode::External);
    assert_eq!(registered.runtime, "antigravity");
    let first_avatar = registered.look.avatar.clone().expect("deterministic avatar");

    let second = router.call_as(
        Caller::User,
        "agent.register",
        serde_json::to_value(AgentRegisterInput {
            id: Some("antigravity-ide".into()),
            name: "Antigravity Updated".into(),
            runtime: Some("antigravity".into()),
            duty: None,
            avatar: None,
            code: None,
            tags: None,
        })
        .unwrap(),
    );
    let updated: Agent = serde_json::from_value(second.data.expect("idempotent re-register ok")).unwrap();
    assert_eq!(updated.code, registered.code);
    assert_eq!(updated.look.avatar.as_deref(), Some(first_avatar.as_str()));
    assert_eq!(updated.name, "Antigravity Updated");

    // External workers are excluded from OAR dispatch candidates and refused if targeted for execution.
    vibevalley_runtime::rt::block_on(async {
        let candidates = rt_app.agent.profile.fleet.candidates_from_cache_async().await;
        assert!(!candidates.iter().any(|c| c.agent.id == "antigravity-ide"));
    });
    let dispatch_err = router.call_as(
        Caller::User,
        "issue.create",
        serde_json::to_value(IssueRequest {
            title: "Cannot auto-dispatch external".into(),
            agent: Some("antigravity-ide".into()),
            ..Default::default()
        })
        .unwrap(),
    );
    assert_eq!(dispatch_err.biz_code, BizCode::IssueRefused.code());

    // External teammate works as issue owner and note collaborator origin.
    let owned = router.call_as(
        Caller::User,
        "issue.create",
        serde_json::to_value(IssueRequest {
            title: "External owned issue".into(),
            owner: Some(ActorRef::Agent { id: "antigravity-ide".into() }),
            ..Default::default()
        })
        .unwrap(),
    );
    let owned_issue: vibevalley_protocol::Issue = serde_json::from_value(owned.data.expect("owner issue ok")).unwrap();
    assert_eq!(owned_issue.owner, Some(ActorRef::Agent { id: "antigravity-ide".into() }));
    let move_err = router.call_as(
        Caller::User,
        "issue.status.update",
        serde_json::to_value(IssueStatusUpdateInput {
            revision: None,
            id: owned_issue.id.clone(),
            status: IssueStatus::Todo,
            text: None,
            agent: None,
            edit: None,
            request_key: None,
        })
        .unwrap(),
    );
    assert_eq!(move_err.biz_code, BizCode::IssueRefused.code());

    let created_note = router.call_as(
        Caller::User,
        "note.create",
        serde_json::to_value(NoteRequest {
            title: "Collab note".into(),
            note_type: NoteType::Doc,
            parent_id: None,
            sort_order: None,
            content: None,
            files: None,
            announce: None,
            note: None,
            channel: None,
            issue: None,
        })
        .unwrap(),
    );
    let note_id = created_note.data.expect("note create")["id"].as_str().unwrap().to_string();
    let written = router.call_as(
        Caller::User,
        "note.file.write",
        serde_json::to_value(NoteFileWriteRequest {
            id: note_id.clone(),
            files: vec![NoteFileWriteItem {
                path: "structure/main.md".into(),
                content: "# Hello\n".into(),
                encoding: None,
                mime: None,
                expected_hash: None,
            }],
            origin: Some("agent:antigravity-ide".into()),
            summary: Some("External update".into()),
            announce: None,
        })
        .unwrap(),
    );
    assert_eq!(written.biz_code, 0);
    let history = router.call_as(
        Caller::User,
        "note.history.list",
        serde_json::to_value(NoteHistoryListRequest { id: note_id, limit: Some(10) }).unwrap(),
    );
    let entries: Vec<vibevalley_protocol::NoteHistoryEntry> = serde_json::from_value(history.data.expect("history")).unwrap();
    assert_eq!(entries[0].origin, "agent:antigravity-ide");
    assert_eq!(entries[0].agent.as_deref(), Some("antigravity-ide"));
}
