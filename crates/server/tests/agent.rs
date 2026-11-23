//! VibeValley `modules/agent/agent.test.ts` (profiles, templates, skills)
//! and the runtime endpoints over the scripted runtime.

use std::path::Path;
use std::sync::Arc;

use serde_json::json;
use vibevalley_protocol::{Agent, AgentRole, BizCode, Build, DEFAULT_ORCHESTRATOR, Head, Look, ORCHESTRATOR_RUNTIME, PersonaMode, Skill, Species};
use vibevalley_server::Hub;
use vibevalley_server::modules::team::agent::{Agents, Profiles, profile};

fn starters() -> Vec<String> {
    profile::built_in_templates()
        .into_iter()
        .map(|t| t.id)
        .filter(|id| id != DEFAULT_ORCHESTRATOR)
        .collect()
}

fn open(home: &Path) -> Arc<Profiles> {
    vibevalley_i18n::set_locale("zh");
    Profiles::open(home, &starters()).unwrap()
}

fn draft() -> Agent {
    Agent {
        id: String::new(),
        name: "同名".into(),
        role: AgentRole::Worker,
        duty: String::new(),
        enabled: true,
        runtime: "pi".into(),
        machine_id: None,
        model: String::new(),
        effort: String::new(),
        persona: String::new(),
        persona_mode: PersonaMode::Append,
        skills: vec![],
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
    let profile;
    {
        let s = open(home.path());
        let k = s.create_skill(skill("Transient Skill", "old")).unwrap();
        assert_eq!(k.id, "transient-skill");
        profile = s
            .create(Agent {
                skills: vec![k.id.clone(), "other".into()],
                ..draft()
            })
            .unwrap()
            .id;
        let orch = s.agent(DEFAULT_ORCHESTRATOR).unwrap();
        s.save(Agent {
            skills: vec![k.id.clone()],
            ..orch
        })
        .unwrap();
        s.remove_skill(&k.id).unwrap();
        assert_eq!(s.agent(&profile).unwrap().skills, vec!["other"]);
        assert!(s.agent(DEFAULT_ORCHESTRATOR).unwrap().skills.is_empty());
        let again = s.create_skill(skill("Transient Skill", "new")).unwrap();
        assert_eq!(again.id, k.id);
        assert!(!s.agent(&profile).unwrap().skills.contains(&again.id));
    }
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
    assert_eq!(s.remove(DEFAULT_ORCHESTRATOR).unwrap_err().biz_code, BizCode::AgentRefused);
    assert_eq!(
        s.save(Agent {
            runtime: "claude".into(),
            ..orch.clone()
        })
        .unwrap_err()
        .biz_code,
        BizCode::AgentRefused
    );
    s.save(Agent {
        model: "deepseek-pro".into(),
        ..orch
    })
    .unwrap();
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
    assert_eq!(s.create(outside).unwrap_err().biz_code, BizCode::AgentRefused);
    let lead = s
        .create(Agent {
            name: "前端组长".into(),
            role: AgentRole::Orchestrator,
            runtime: ORCHESTRATOR_RUNTIME.into(),
            ..draft()
        })
        .unwrap();
    let ids: Vec<String> = s.orchestrators().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, vec![DEFAULT_ORCHESTRATOR.to_string(), lead.id.clone()]);
    assert!(s.is_orchestrator(&lead.id) && !s.is_orchestrator("backend"));
    let orch = s.agent(DEFAULT_ORCHESTRATOR).unwrap();
    assert_eq!(
        s.save(Agent {
            role: AgentRole::Worker,
            ..orch
        })
        .unwrap_err()
        .biz_code,
        BizCode::AgentRefused
    );
    s.save(Agent {
        role: AgentRole::Worker,
        ..lead.clone()
    })
    .unwrap();
    assert!(s.agents().iter().any(|a| a.id == lead.id));
}

#[test]
fn a_new_farm_has_the_orchestrator_and_the_starters() {
    let home = tempfile::tempdir().unwrap();
    let s = Profiles::open(home.path(), &[]).unwrap();
    let all: Vec<(String, Option<String>)> = s.all().into_iter().map(|a| (a.id, a.from.map(|f| f.template))).collect();
    assert_eq!(all, vec![(DEFAULT_ORCHESTRATOR.into(), Some(DEFAULT_ORCHESTRATOR.into()))]);
    let home = tempfile::tempdir().unwrap();
    let named = Profiles::open(home.path(), &["docs".into(), "nobody".into(), "architect".into()]).unwrap();
    let ids: Vec<String> = named.all().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, vec![DEFAULT_ORCHESTRATOR, "docs", "architect"]);
}

#[test]
fn templates_install_and_update_when_asked() {
    let home = tempfile::tempdir().unwrap();
    let s = open(home.path());
    let second = s.install_template("backend").unwrap();
    assert_eq!((second.id.as_str(), second.name.as_str()), ("backend-2", "后端工程师 2"));
    let from = second.from.clone().unwrap();
    assert_eq!((from.template.as_str(), from.version), ("backend", 2));
    let backend = s.templates().into_iter().find(|t| t.id == "backend").unwrap();
    assert_eq!(backend.installed, vec!["backend", "backend-2"]);
    assert_eq!(backend.look.avatar.as_deref(), Some("avatar-backend"));
    assert!(backend.style.as_deref().is_some_and(|st| !st.is_empty()));
    assert_eq!(backend.category, Some(vibevalley_protocol::TemplateCategory::Engineering));
    assert_eq!(s.install_template("nobody").unwrap_err().biz_code, BizCode::AgentNotFound);
    let mut env = std::collections::BTreeMap::new();
    env.insert("CI".to_string(), "1".to_string());
    s.save(Agent {
        name: "后端二号".into(),
        persona: "我自己写的".into(),
        env: env.clone(),
        from: Some(vibevalley_protocol::AgentFrom {
            template: "backend".into(),
            version: 1,
        }),
        ..second
    })
    .unwrap();
    let again = s.update_from_template("backend-2").unwrap();
    assert_eq!(again.name, "后端二号");
    assert_eq!(again.persona, backend.persona);
    assert_eq!(again.env, env);
    assert_eq!(again.from.unwrap().version, 2);
    let hand = s
        .create(Agent {
            name: "手捏的".into(),
            ..draft()
        })
        .unwrap();
    assert_eq!(s.update_from_template(&hand.id).unwrap_err().biz_code, BizCode::AgentRefused);
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
    let e = s.add_template(&broken.to_string_lossy()).unwrap_err();
    assert_eq!(e.biz_code, BizCode::AgentRefused);
    assert!(e.message.contains("Bad Id"), "{}", e.message);
    let nowhere = home.path().join("nowhere");
    assert_eq!(s.add_template(&nowhere.to_string_lossy()).unwrap_err().biz_code, BizCode::AgentRefused);
    let added = s.add_template(&folder.to_string_lossy()).unwrap();
    assert_eq!(added.runtime, ORCHESTRATOR_RUNTIME);
    assert_eq!(added.persona, "你专管前端的工单。");
    let mut files: Vec<String> = std::fs::read_dir(home.path().join("agent-templates/lead"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files, vec!["agent.json", "persona.md"]);
    assert_eq!(s.add_template(&folder.to_string_lossy()).unwrap_err().biz_code, BizCode::AgentRefused);
    let lead = s.install_template("lead").unwrap();
    assert!(lead.role == AgentRole::Orchestrator && s.is_orchestrator(&lead.id));
    assert!(s.preview_remove_template("lead").unwrap().does[0].contains("1 份角色留着"));
    assert_eq!(s.remove_template("backend").unwrap_err().biz_code, BizCode::AgentRefused);
    s.remove_template("lead").unwrap();
    assert!(!s.templates().iter().any(|t| t.id == "lead"));
    assert_eq!(s.agent(&lead.id).unwrap().from.unwrap().version, 2);
}

#[test]
fn creation_gives_distinct_ids() {
    let home = tempfile::tempdir().unwrap();
    let s = open(home.path());
    let mut ids = std::collections::BTreeSet::new();
    let mut skills = vec![];
    for _ in 0..12 {
        ids.insert(s.create(draft()).unwrap().id);
        skills.push(s.create_skill(skill("Same Skill", "")).unwrap().id);
    }
    assert_eq!(ids.len(), 12);
    assert_eq!(skills[..3], ["same-skill", "same-skill-2", "same-skill-3"]);
    assert_eq!(s.create(Agent { id: "mine".into(), ..draft() }).unwrap_err().biz_code, BizCode::AgentRefused);
    let saved = s
        .save(Agent {
            id: "agent-7".into(),
            ..draft()
        })
        .unwrap();
    assert_eq!(saved.look.species, Some(Species::Fox));
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
    assert_eq!(s.save_skill(changed).unwrap_err().biz_code, BizCode::AgentRefused);
    assert_eq!(s.remove_skill("reviewer").unwrap_err().biz_code, BizCode::AgentRefused);
    assert_eq!(s.preview_remove_skill("reviewer").unwrap_err().biz_code, BizCode::AgentRefused);
    let mine = s
        .create_skill(Skill {
            built_in: Some(true),
            ..skill("reviewer", "我的")
        })
        .unwrap();
    assert_eq!((mine.id.as_str(), mine.built_in), ("reviewer-2", None));
    for (id, expected_skills) in [
        ("slides", vec!["slides"]),
        ("collector", vec!["collector"]),
        ("pages", vec!["pages", "artifacts"]),
        ("reviewer", vec!["reviewer"]),
    ] {
        let t = s.templates().into_iter().find(|t| t.id == id).unwrap();
        assert_eq!(
            (t.role, t.skills.clone()),
            (AgentRole::Worker, expected_skills.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        );
        assert_eq!(s.install_template(id).unwrap().skills, expected_skills);
    }
}

#[test]
fn runtimes_over_the_hub() {
    vibevalley_i18n::set_locale("zh");
    let home = tempfile::tempdir().unwrap();
    let hub = Hub::new(vibevalley_core::empty_space_state());
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let agents = Agents::open(&hub, home.path(), &starters(), Arc::new(registry), false).unwrap();
    vibevalley_server::modules::team::agent::install(&hub, agents);
    let live = vibevalley_server::Server::live(&*hub);

    let list = hub.call_as(vibevalley_protocol::Caller::User, "runtime.list", json!(null));
    let list = list.data.unwrap();
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids.first(), Some(&"claude"));
    assert_eq!(ids.last(), Some(&"scripted"));
    assert!(list.as_array().unwrap().iter().all(|r| r["installation"]["status"] == "checking"));

    let got = hub.call_as(vibevalley_protocol::Caller::User, "runtime.refresh", json!({ "id": "scripted" }));
    let info = got.data.unwrap();
    assert_eq!(info["installation"]["status"], "available");
    assert_eq!(info["installation"]["via"], "bundled");
    assert!(live.recv_timeout(std::time::Duration::from_secs(2)).is_ok());

    // Once available and enabled, scripted sorts ahead of unprobed/unavailable runtimes.
    let sorted = hub.call_as(vibevalley_protocol::Caller::User, "runtime.list", json!(null)).data.unwrap();
    assert_eq!(sorted.as_array().unwrap()[0]["id"], "scripted");

    let missing = hub.call_as(vibevalley_protocol::Caller::User, "runtime.refresh", json!({ "id": "nobody" }));
    assert_eq!(missing.biz_code, BizCode::RuntimeNotFound.code());

    let updated = hub.call_as(
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
    let v = hub.call_as(vibevalley_protocol::Caller::User, "agent.validate", json!({ "agents": [a] }));
    let problems = &v.data.unwrap()[0]["problems"];
    assert_eq!(problems[0]["field"], "runtime");

    let listed = hub.call_as(vibevalley_protocol::Caller::User, "agent.list", json!(null));
    assert_eq!(listed.data.unwrap()[0]["id"], DEFAULT_ORCHESTRATOR);

    // Re-enable scripted so installing a template through the hub automatically picks it instead of unavailable claude.
    hub.call_as(
        vibevalley_protocol::Caller::User,
        "runtime.setting.update",
        json!({ "id": "scripted", "enabled": true, "binPath": "", "defaultModel": "", "defaultEffort": "", "env": {} }),
    );
    let installed_auto = hub.call_as(vibevalley_protocol::Caller::User, "agent.template.install", json!({ "id": "fullstack" }));
    let made: Agent = serde_json::from_value(installed_auto.data.unwrap()).unwrap();
    assert_eq!(made.runtime, "scripted");
    assert_eq!(made.look.avatar.as_deref(), Some("avatar-fullstack"));
    let installed_codex = hub.call_as(
        vibevalley_protocol::Caller::User,
        "agent.template.install",
        json!({ "id": "frontend", "runtime": "codex" }),
    );
    let frontend: Agent = serde_json::from_value(installed_codex.data.unwrap()).unwrap();
    assert_eq!(frontend.runtime, "codex");
    assert_eq!(frontend.persona_mode, PersonaMode::Append);

    let installed_explicit = hub.call_as(
        vibevalley_protocol::Caller::User,
        "agent.template.install",
        json!({ "id": "designer", "runtime": "kimi" }),
    );
    let designed: Agent = serde_json::from_value(installed_explicit.data.unwrap()).unwrap();
    assert_eq!(designed.runtime, "kimi");
    assert_eq!(designed.persona_mode, PersonaMode::Prompt);
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
    fn installation(&self) -> vibevalley_runtime::oar::Installation {
        self.inner.installation()
    }
    fn list_models(&self) -> vibevalley_runtime::oar::Result<Vec<vibevalley_runtime::oar::ModelInfo>> {
        self.inner.list_models()
    }
    fn open(&self, opts: vibevalley_runtime::oar::SessionOptions) -> vibevalley_runtime::oar::Result<Arc<dyn vibevalley_runtime::oar::Session>> {
        self.inner.open(opts)
    }
    fn account_usage(&self) -> vibevalley_runtime::oar::Result<vibevalley_runtime::oar::AccountUsage> {
        Ok(vibevalley_runtime::oar::AccountUsage::Available {
            plan: Some("max".into()),
            email: None,
            rate_limited: false,
            windows: vec![vibevalley_runtime::oar::UsageWindow {
                label: "5h".into(),
                used_ratio: *self.used.lock().unwrap(),
                resets_at: None,
                id: None,
                duration_ms: None,
            }],
        })
    }
}

#[test]
fn usage_is_read_again_and_told() {
    let home = tempfile::tempdir().unwrap();
    let hub = Hub::new(vibevalley_core::empty_space_state());
    let metered = Arc::new(Metered {
        inner: vibevalley_runtime::oar::scripted::ScriptedRuntime::demo(),
        used: 0.25.into(),
    });
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(metered.clone());
    let agents = Agents::open(&hub, home.path(), &starters(), Arc::new(registry), false).unwrap();
    let fleet = agents.fleet.clone();
    let probed = fleet.refresh("scripted").unwrap();
    assert_eq!(serde_json::to_value(&probed.usage).unwrap()["windows"][0]["usedPercent"], 25);

    let live = vibevalley_server::Server::live(&*hub);
    *metered.used.lock().unwrap() = 0.5;
    fleet.refresh_usage("scripted");
    let told = live.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    assert!(serde_json::to_string(&told).unwrap().contains("\"usedPercent\":50"));
    assert_eq!(
        serde_json::to_value(&fleet.info("scripted").unwrap().usage).unwrap()["windows"][0]["usedPercent"],
        50
    );

    // Nothing changed: nothing is told.
    fleet.refresh_usage("scripted");
    assert!(live.recv_timeout(std::time::Duration::from_millis(200)).is_err());
}
