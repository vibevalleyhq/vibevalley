//! Multi-helper collaboration tests (Issue #50):
//! 1. Auto-dispatch readonly reviewer on `in_review`, bounded by `mandate.max_bot_review_rounds`.
//! 2. Thread `@<agent>` readonly collaborators without clobbering the primary worker.
//! 3. Single write-lock handoff ("Hoe Handoff") committing or stashing uncommitted worktree edits.

use crate::support::RouterTestExt as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use vibevalley_protocol::{
    Agent, AgentRole, Build, Caller, ExecutionPolicy, Head, IssueMandate, IssueStageKind as StageKind, IssueStatus, Look, PersonaMode, SessionPermissionMode,
    Toolset,
};
use vibevalley_runtime::oar::scripted::Script;
use vibevalley_runtime::oar::{Capabilities, ContentBlock, Installation, McpServer, ModelInfo, PermissionMode, Registry, Runtime, Session, SessionOptions};
use vibevalley_server::runtime::{HandoffCleanup, WorktreeKey, WriteLease};

use crate::support::{self, HookRuntime, TurnGate, block_on, git, quick, wait_until_transition};

fn default_look() -> Look {
    Look {
        species: None,
        outfit: None,
        orchestrator: None,
        build: Build::Biped,
        head: Head::Rounded,
        body: "#2a2e33".into(),
        trim: "#3b82f6".into(),
        hat: "#5b4636".into(),
        eye: "#ff9de2".into(),
        avatar: None,
    }
}

fn worker_profile(id: &str, name: &str, runtime: &str) -> Agent {
    Agent {
        id: id.into(),
        code: String::new(),
        name: name.into(),
        role: AgentRole::Worker,
        mode: vibevalley_protocol::AgentExecutionMode::Managed,
        duty: format!("{name} worker"),
        enabled: true,
        runtime: runtime.into(),
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
        worktree: true,
        tags: vec![],
        look: default_look(),
        from: None,
        voice: None,
    }
}

fn rpc(url: &str, token: &str, id: i64, method: &str, params: Value) -> Value {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    client
        .post(url)
        .header("authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .expect("POST /mcp")
        .json()
        .expect("JSON-RPC response")
}

fn mcp_token_from(opts: &SessionOptions) -> (String, String) {
    for server in &opts.mcp_servers {
        if let McpServer::Http { url, headers, .. } = server
            && url.ends_with("/mcp")
            && let Some((_, auth)) = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        {
            return (url.clone(), auth.strip_prefix("Bearer ").unwrap_or(auth).to_string());
        }
    }
    panic!("missing vibevalley MCP door in SessionOptions: {:?}", opts.mcp_servers);
}

#[derive(Clone, Debug)]
struct RecordedOpen {
    permission_mode: PermissionMode,
    disallowed_tools: Vec<String>,
    append_system_prompt: Option<String>,
}

type ReviewAction = Arc<dyn Fn(&SessionOptions, &PathBuf, &PathBuf, &str, usize) + Send + Sync>;

struct InteractiveRuntime {
    id: String,
    opens: Arc<Mutex<Vec<RecordedOpen>>>,
    turns: Arc<AtomicUsize>,
    action: ReviewAction,
}

impl InteractiveRuntime {
    fn new(id: &str, action: impl Fn(&SessionOptions, &PathBuf, &PathBuf, &str, usize) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            id: id.into(),
            opens: Arc::default(),
            turns: Arc::new(AtomicUsize::new(0)),
            action: Arc::new(action),
        })
    }
}

impl Runtime for InteractiveRuntime {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        "InteractiveTest"
    }
    fn capabilities(&self) -> Capabilities {
        vibevalley_runtime::oar::scripted::ScriptedRuntime::new(&self.id, Script::new()).capabilities()
    }
    fn installation(&self) -> vibevalley_runtime::BoxFuture<'_, Installation> {
        Box::pin(async {
            Installation::Available {
                version: None,
                path: PathBuf::from("(test)"),
            }
        })
    }
    fn list_models(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn Session>>> {
        let opens = self.opens.clone();
        let turns = self.turns.clone();
        let action = self.action.clone();
        let id = self.id.clone();
        Box::pin(async move {
            opens.lock().unwrap().push(RecordedOpen {
                permission_mode: opts.permission_mode,
                disallowed_tools: opts.disallowed_tools.clone(),
                append_system_prompt: opts.append_system_prompt.clone(),
            });
            let record = opts.record_to.clone().expect("record_to");
            let report = record
                .parent()
                .and_then(|d| d.parent())
                .unwrap()
                .join("reports")
                .join(record.with_extension("json").file_name().unwrap());
            let inner = vibevalley_runtime::oar::scripted::ScriptedRuntime::new(&id, quick()).open(opts.clone()).await?;
            Ok(Arc::new(InteractiveSession {
                inner,
                opts,
                report,
                turns,
                action,
            }) as Arc<dyn Session>)
        })
    }
}

struct InteractiveSession {
    inner: Arc<dyn Session>,
    opts: SessionOptions,
    report: PathBuf,
    turns: Arc<AtomicUsize>,
    action: ReviewAction,
}

impl Session for InteractiveSession {
    fn records(&self) -> Vec<vibevalley_runtime::oar::voyage::Record> {
        self.inner.records()
    }
    fn subscribe_records(&self, after: Option<u64>) -> tokio::sync::mpsc::Receiver<vibevalley_runtime::oar::voyage::Record> {
        self.inner.subscribe_records(after)
    }
    fn control<'a>(
        &'a self,
        action: vibevalley_runtime::oar::ControlAction,
        arg: &'a str,
        input_id: &'a str,
        span_id: &'a str,
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<vibevalley_runtime::oar::ControlOutcome>> {
        self.inner.control(action, arg, input_id, span_id)
    }
    fn control_with<'a>(
        &'a self,
        action: vibevalley_runtime::oar::ControlAction,
        arg: &'a str,
        input_id: &'a str,
        span_id: &'a str,
        opts: vibevalley_runtime::oar::TurnOptions,
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<vibevalley_runtime::oar::ControlOutcome>> {
        self.inner.control_with(action, arg, input_id, span_id, opts)
    }
    fn id(&self) -> String {
        self.inner.id()
    }
    fn runtime_id(&self) -> &str {
        self.inner.runtime_id()
    }
    fn status(&self) -> vibevalley_runtime::oar::SessionStatus {
        self.inner.status()
    }
    fn events(&self) -> tokio::sync::mpsc::Receiver<vibevalley_runtime::oar::Event> {
        self.inner.events()
    }
    fn prompt(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.prompt_with(content, vibevalley_runtime::oar::TurnOptions::default())
    }
    fn prompt_with(
        &self,
        content: Vec<ContentBlock>,
        turn_opts: vibevalley_runtime::oar::TurnOptions,
    ) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        let prompt = content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let idx = self.turns.fetch_add(1, Ordering::SeqCst);
        let opts = self.opts.clone();
        let cwd = opts.cwd.clone();
        let report = self.report.clone();
        let action = self.action.clone();
        let inner = self.inner.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || action(&opts, &cwd, &report, &prompt, idx)).await.unwrap();
            inner.prompt_with(content, turn_opts).await
        })
    }
    fn steer(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.inner.steer(content)
    }
    fn queue(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.inner.queue(content)
    }
    fn queue_with(
        &self,
        content: Vec<ContentBlock>,
        opts: vibevalley_runtime::oar::TurnOptions,
    ) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.inner.queue_with(content, opts)
    }
    fn respond_permission<'a>(
        &'a self,
        request_id: &'a str,
        decision: vibevalley_runtime::oar::PermissionDecision,
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::oar::Result<()>> {
        self.inner.respond_permission(request_id, decision)
    }
    fn abort(&self) -> vibevalley_runtime::BoxFuture<'_, vibevalley_runtime::oar::Result<()>> {
        self.inner.abort()
    }
    fn resume_id(&self) -> Option<String> {
        self.inner.resume_id()
    }
    fn dispose(&self) -> vibevalley_runtime::BoxFuture<'_, ()> {
        self.inner.dispose()
    }
    fn signal_dispose(&self) {
        self.inner.signal_dispose();
    }
}

#[test]
fn auto_reviewer_dispatches_on_in_review_rejects_and_passes_within_max_bot_rounds() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();

    let coder_rt = HookRuntime::new("coder-rt", quick(), |turn| {
        if turn.index == 0 {
            turn.commit("impl.rs", "pub fn broken() {}\n");
            turn.done("Initial implementation ready");
        } else {
            turn.commit("impl.rs", "pub fn fixed() -> bool { true }\n");
            turn.done("Fixed finding and added implementation");
        }
    });

    let rev_checks = Arc::new(Mutex::new(Vec::<(String, bool)>::new()));
    let rev_checks_clone = rev_checks.clone();
    let rev_rt = InteractiveRuntime::new("reviewer-rt", move |opts, _cwd, report, prompt, idx| {
        assert!(prompt.contains("Automated review round"), "{prompt}");
        let (door, token) = mcp_token_from(opts);
        let listed = rpc(&door, &token, 1, "tools/list", json!({}));
        let tool_names: Vec<String> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(tool_names.iter().any(|n| n == "issue_diff_get"), "{tool_names:?}");
        assert!(tool_names.iter().any(|n| n == "issue_review"), "{tool_names:?}");
        assert!(!tool_names.iter().any(|n| n == "issue_update"), "{tool_names:?}");
        assert!(!tool_names.iter().any(|n| n == "note_file_write"), "{tool_names:?}");

        let denied = rpc(
            &door,
            &token,
            2,
            "tools/call",
            json!({ "name": "issue_update", "arguments": { "id": "#1", "title": "hijack" } }),
        );
        assert_eq!(denied["result"]["isError"], true, "{denied}");

        let diff = rpc(&door, &token, 3, "tools/call", json!({ "name": "issue_diff_get", "arguments": { "id": "#1" } }));
        assert_eq!(diff["result"]["isError"], false, "{diff}");
        let diff_text = diff["result"]["content"][0]["text"].as_str().unwrap().to_string();
        assert!(diff_text.contains("impl.rs"), "{diff_text}");

        rev_checks_clone.lock().unwrap().push((diff_text.clone(), idx > 0));
        std::fs::write(report, r#"{"status":"done","summary":"Review submitted"}"#).unwrap();

        let verdict = if idx == 0 {
            rpc(
                &door,
                &token,
                4,
                "tools/call",
                json!({
                    "name": "issue_review",
                    "arguments": {
                        "id": "#1",
                        "pass": false,
                        "findings": ["broken() should return bool"],
                        "text": "Fix broken() return value"
                    }
                }),
            )
        } else {
            rpc(
                &door,
                &token,
                4,
                "tools/call",
                json!({
                    "name": "issue_review",
                    "arguments": {
                        "id": "#1",
                        "pass": true,
                        "text": "Verified fix against criteria"
                    }
                }),
            )
        };
        assert_eq!(verdict["result"]["isError"], false, "{verdict}");
    });

    let mut registry = Registry::new();
    registry.register(coder_rt.clone());
    registry.register(rev_rt.clone());
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    app.set_mcp_url(format!("{}/mcp", listener.url()));
    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);

    assert_eq!(call("repo.create", json!({ "name": "rev-repo" })).biz_code, 0);
    block_on(
        app.test_internals()
            .agent
            .profile
            .store
            .save_async(worker_profile("coder", "Coder", "coder-rt")),
    )
    .unwrap();
    let mut reviewer = block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    reviewer.runtime = "reviewer-rt".into();
    block_on(app.test_internals().agent.profile.store.save_async(reviewer)).unwrap();

    let created = call(
        "issue.create",
        json!({
            "title": "Implement bool check",
            "criteria": ["fixed() returns true"],
            "repo": "rev-repo",
            "agent": "coder"
        }),
    );
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(call("issue.status.update", json!({ "id": issue_id, "status": "todo" })).biz_code, 0);

    let accepted = wait_until_transition(app.ctx(), Duration::from_secs(15), "issue reviewed by auto-reviewer", || {
        support::board_issue(app.test_internals().board, &issue_id).filter(|i| i.reviewed_at.is_some() && i.stage.state == StageKind::Reviewing)
    });
    assert!(accepted.reviewed_at.is_some());
    assert_eq!(
        accepted.assignments.len(),
        1,
        "readonly reviewer must not hijack assignments: {:?}",
        accepted.assignments
    );
    assert_eq!(accepted.assignments[0].agent, "coder");
    assert_eq!(coder_rt.prompts.lock().unwrap().len(), 2, "primary worker ran initial + reject-fix round");
    assert_eq!(rev_checks.lock().unwrap().len(), 2, "auto-reviewer ran reject round + pass round");

    let opens = rev_rt.opens.lock().unwrap().clone();
    assert_eq!(opens.len(), 2);
    for open in &opens {
        assert_eq!(open.permission_mode, PermissionMode::Plan);
        assert!(open.append_system_prompt.as_deref().unwrap_or("").contains("只读审查"));
        assert!(open.disallowed_tools.iter().any(|t| t == "write" || t == "Write"));
        assert!(open.disallowed_tools.iter().any(|t| t == "bash" || t == "Bash"));
    }

    let sessions = block_on(app.test_internals().board.sessions_async()).unwrap();
    let rev_sessions: Vec<_> = sessions.iter().filter(|s| s.profile_id() == Some("reviewer")).collect();
    assert_eq!(rev_sessions.len(), 2);
    for s in rev_sessions {
        assert!(s.is_readonly_issue_helper());
        assert!(!s.is_board_worker());
        assert!(matches!(
            s.policy,
            ExecutionPolicy::DirectCwd {
                permission_mode: SessionPermissionMode::ReadOnly,
                ..
            }
        ));
    }

    drop(listener);
    app.close_blocking();
}

#[test]
fn auto_reviewer_stops_at_max_bot_review_rounds_and_respects_disabled_profile() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();

    let coder_rt = HookRuntime::new("coder-rt", quick(), |turn| {
        turn.commit(&format!("round_{}.txt", turn.index), "work\n");
        turn.done("Done round");
    });

    let rev_rt = InteractiveRuntime::new("reviewer-rt", |opts, _cwd, report, _prompt, _idx| {
        let (door, token) = mcp_token_from(opts);
        let verdict = rpc(
            &door,
            &token,
            1,
            "tools/call",
            json!({
                "name": "issue_review",
                "arguments": {
                    "id": "#1",
                    "pass": false,
                    "findings": ["still needs polish"]
                }
            }),
        );
        assert_eq!(verdict["result"]["isError"], false, "{verdict}");
        std::fs::write(report, r#"{"status":"done","summary":"Rejected once"}"#).unwrap();
    });

    let mut registry = Registry::new();
    registry.register(coder_rt.clone());
    registry.register(rev_rt.clone());
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    app.set_mcp_url(format!("{}/mcp", listener.url()));
    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);

    assert_eq!(call("repo.create", json!({ "name": "bound-repo" })).biz_code, 0);
    block_on(
        app.test_internals()
            .agent
            .profile
            .store
            .save_async(worker_profile("coder", "Coder", "coder-rt")),
    )
    .unwrap();
    let mut reviewer = block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    reviewer.runtime = "reviewer-rt".into();
    block_on(app.test_internals().agent.profile.store.save_async(reviewer.clone())).unwrap();

    let created = call(
        "issue.create",
        json!({
            "title": "Bounded review rounds",
            "repo": "bound-repo",
            "agent": "coder"
        }),
    );
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    let mut mandate = IssueMandate::explicit("test", false);
    mandate.max_bot_review_rounds = 1;
    block_on(app.test_internals().board.set_mandate_async(&issue_id, mandate)).unwrap();
    assert_eq!(call("issue.status.update", json!({ "id": issue_id, "status": "todo" })).biz_code, 0);

    // Coder runs 2 rounds (initial + 1 rejection); after round 2, max_bot_review_rounds=1 blocks a 2nd auto-review.
    let final_issue = wait_until_transition(
        app.ctx(),
        Duration::from_secs(15),
        "coder completes second round without second bot review",
        || {
            let issue = support::board_issue(app.test_internals().board, &issue_id)?;
            let prompts = coder_rt.prompts.lock().unwrap().len();
            (prompts == 2 && issue.status == IssueStatus::InReview && issue.reviewed_at.is_none()).then_some(issue)
        },
    );
    assert_eq!(final_issue.status, IssueStatus::InReview);
    assert_eq!(rev_rt.turns.load(Ordering::SeqCst), 1, "must stay bounded to 1 bot review round");

    // Disabled reviewer profile must not dispatch auto-reviewer on a new issue.
    reviewer.enabled = false;
    block_on(app.test_internals().agent.profile.store.save_async(reviewer)).unwrap();
    let second = call(
        "issue.create",
        json!({
            "title": "Disabled reviewer skips",
            "repo": "bound-repo",
            "agent": "coder"
        }),
    );
    let second_id = second.data.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(call("issue.status.update", json!({ "id": second_id, "status": "todo" })).biz_code, 0);
    wait_until_transition(app.ctx(), Duration::from_secs(10), "second issue finishes without reviewer", || {
        support::board_issue(app.test_internals().board, &second_id).filter(|i| i.status == IssueStatus::InReview)
    });
    assert_eq!(rev_rt.turns.load(Ordering::SeqCst), 1);

    drop(listener);
    app.close_blocking();
}

#[test]
fn thread_agent_mentions_dispatch_readonly_collaborators_without_clobbering_primary_worker() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();

    let coder_rt = HookRuntime::new("coder-rt", quick(), |turn| {
        turn.commit("module.rs", "pub fn module_ok() -> i32 { 42 }\n");
        turn.done("Implemented module.rs");
    });

    let (collab_done_tx, collab_done_rx) = mpsc::channel::<(String, usize)>();
    let collab_rt = InteractiveRuntime::new("collab-rt", move |opts, _cwd, report, prompt, idx| {
        assert!(prompt.contains("You were @mentioned"), "{prompt}");
        let (door, token) = mcp_token_from(opts);
        let listed = rpc(&door, &token, 1, "tools/list", json!({}));
        let names: Vec<String> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "issue_diff_get"), "{names:?}");
        assert!(names.iter().any(|n| n == "channel_message_send"), "{names:?}");
        assert!(names.iter().any(|n| n == "issue_report"), "{names:?}");
        assert!(!names.iter().any(|n| n == "issue_review"), "{names:?}");
        assert!(!names.iter().any(|n| n == "note_file_write"), "{names:?}");

        let denied = rpc(
            &door,
            &token,
            2,
            "tools/call",
            json!({ "name": "issue_review", "arguments": { "id": "#1", "pass": true } }),
        );
        assert_eq!(denied["result"]["isError"], true, "{denied}");

        let diff = rpc(&door, &token, 3, "tools/call", json!({ "name": "issue_diff_get", "arguments": { "id": "#1" } }));
        assert_eq!(diff["result"]["isError"], false, "{diff}");
        let diff_text = diff["result"]["content"][0]["text"].as_str().unwrap().to_string();
        assert!(diff_text.contains("module.rs"), "{diff_text}");

        std::fs::write(
            report,
            format!(r#"{{"status":"done","summary":"Collaborator audit round {idx}: module.rs is clean"}}"#),
        )
        .unwrap();
        let _ = collab_done_tx.send((diff_text, idx));
    });

    let mut registry = Registry::new();
    registry.register(coder_rt.clone());
    registry.register(collab_rt.clone());
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    app.set_mcp_url(format!("{}/mcp", listener.url()));
    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);

    assert_eq!(call("repo.create", json!({ "name": "collab-repo" })).biz_code, 0);
    block_on(
        app.test_internals()
            .agent
            .profile
            .store
            .save_async(worker_profile("coder", "Coder", "coder-rt")),
    )
    .unwrap();
    block_on(
        app.test_internals()
            .agent
            .profile
            .store
            .save_async(worker_profile("security", "Security Auditor", "collab-rt")),
    )
    .unwrap();

    let created = call("issue.create", json!({ "title": "Build module", "repo": "collab-repo", "agent": "coder" }));
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(call("issue.status.update", json!({ "id": issue_id, "status": "todo" })).biz_code, 0);

    let in_review = wait_until_transition(app.ctx(), Duration::from_secs(10), "primary worker reaches in_review", || {
        support::board_issue(app.test_internals().board, &issue_id).filter(|i| i.status == IssueStatus::InReview)
    });
    let primary_sid = in_review.latest_session_id().unwrap().to_string();

    // Mention `@security` in an issue comment; primary worker must NOT be woken or clobbered.
    let comment = call(
        "issue.comment.create",
        json!({ "id": issue_id, "text": "@security please inspect module.rs for safety (ignore email foo@security.com and `@security`)" }),
    );
    assert_eq!(comment.biz_code, 0, "{}", comment.message);

    let (_diff, idx) = collab_done_rx.recv_timeout(Duration::from_secs(10)).expect("collaborator ran");
    assert_eq!(idx, 0);

    let thread_id = block_on(app.test_internals().channel.issue_thread_async(&issue_id, "Build module", None)).unwrap();
    let posted = wait_until_transition(app.ctx(), Duration::from_secs(10), "collaborator report posted to thread", || {
        let list = call("channel.message.list", json!({ "id": thread_id, "limit": 20 })).data?;
        let msgs = list.as_array()?.clone();
        msgs.into_iter()
            .find(|m| m["text"].as_str().is_some_and(|t| t.contains("Collaborator audit round 0")))
    });
    assert!(posted["text"].as_str().unwrap().contains("module.rs is clean"));

    let issue_after = support::board_issue(app.test_internals().board, &issue_id).unwrap();
    assert_eq!(issue_after.latest_session_id().map(String::as_str), Some(primary_sid.as_str()));
    assert_eq!(issue_after.assignments.len(), 1);
    assert_eq!(
        coder_rt.prompts.lock().unwrap().len(),
        1,
        "primary worker must not be woken by @collaborator mention"
    );

    // Re-mentioning `@security` reuses the existing readonly collaborator session.
    let followup = call("issue.comment.create", json!({ "id": issue_id, "text": "@security check error paths too" }));
    assert_eq!(followup.biz_code, 0, "{}", followup.message);
    let (_diff2, idx2) = collab_done_rx.recv_timeout(Duration::from_secs(10)).expect("collaborator ran round 2");
    assert_eq!(idx2, 1);

    let sessions = block_on(app.test_internals().board.sessions_async()).unwrap();
    let collab_sessions: Vec<_> = sessions.iter().filter(|s| s.profile_id() == Some("security")).collect();
    assert_eq!(collab_sessions.len(), 1, "should reuse existing collaborator session: {collab_sessions:?}");
    assert_eq!(coder_rt.prompts.lock().unwrap().len(), 1);

    drop(listener);
    app.close_blocking();
}

#[test]
fn hoe_handoff_prevents_concurrent_writes_and_commits_or_stashes_dirty_worktree_before_transfer() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();

    let (entered_tx, entered_rx) = mpsc::channel::<PathBuf>();
    let gate = TurnGate::new();

    let gated_rt = HookRuntime::new("gated-rt", gate.script("Alpha finished"), move |turn| {
        if turn.index == 0 {
            turn.commit("base_work.txt", "committed base\n");
            // Leave dirty tracked + untracked edits in the worktree while paused.
            turn.write("base_work.txt", "uncommitted dirty edit from alpha\n");
            turn.write("alpha_wip.txt", "untracked wip from alpha\n");
            turn.done("Alpha finished");
            let _ = entered_tx.send(turn.cwd.clone());
        }
    });

    let successor_rt = HookRuntime::new("successor-rt", quick(), |turn| {
        let dirty = git(&turn.cwd, &["status", "--porcelain"]);
        assert!(dirty.is_empty(), "successor must receive clean worktree after handoff, got: {dirty}");
        if turn.prompt.contains("Commit handoff") {
            let content = std::fs::read_to_string(turn.cwd.join("alpha_wip.txt")).unwrap();
            assert_eq!(content, "untracked wip from alpha\n");
            turn.write("beta_dirty.txt", "beta uncommitted wip\n");
        }
        turn.done("Successor finished");
    });

    let mut registry = Registry::new();
    registry.register(gated_rt);
    registry.register(successor_rt);
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let call = |op: &str, p| app.router().call_as(Caller::User, op, p);

    assert_eq!(call("repo.create", json!({ "name": "hoe-repo" })).biz_code, 0);
    block_on(
        app.test_internals()
            .agent
            .profile
            .store
            .save_async(worker_profile("alpha", "Alpha", "gated-rt")),
    )
    .unwrap();
    block_on(
        app.test_internals()
            .agent
            .profile
            .store
            .save_async(worker_profile("beta", "Beta", "successor-rt")),
    )
    .unwrap();
    block_on(
        app.test_internals()
            .agent
            .profile
            .store
            .save_async(worker_profile("gamma", "Gamma", "successor-rt")),
    )
    .unwrap();

    let created = call("issue.create", json!({ "title": "Hoe handoff test", "repo": "hoe-repo", "agent": "alpha" }));
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(call("issue.status.update", json!({ "id": issue_id, "status": "todo" })).biz_code, 0);

    let wt_path = entered_rx.recv_timeout(Duration::from_secs(10)).expect("alpha entered worktree");
    let wt_key = block_on(WorktreeKey::local_async(&wt_path));
    let engine = app.test_internals().board.session_engine().clone();

    // While alpha holds the write lease mid-turn, a competing writer cannot acquire the same worktree lock.
    let alpha_sid = support::board_issue(app.test_internals().board, &issue_id)
        .unwrap()
        .latest_session_id()
        .unwrap()
        .to_string();
    assert_eq!(engine.worktree().hoe().owner(&wt_key).unwrap().session_id, alpha_sid);
    let competing = block_on(
        engine
            .worktree()
            .hoe()
            .acquire_async(&wt_key, WriteLease::new("w-rival", Some("beta".into()), None, None)),
    );
    assert!(competing.is_err(), "concurrent writer on same worktree must be refused");

    // Release alpha gate and finish turn 1, then handoff via Commit while leaving dirty files on disk.
    gate.release();
    wait_until_transition(app.ctx(), Duration::from_secs(10), "alpha in_review", || {
        support::board_issue(app.test_internals().board, &issue_id).filter(|i| i.status == IssueStatus::InReview)
    });

    // Ensure uncommitted files still exist right before commit-handoff (dismiss KeepBranch hasn't run yet).
    std::fs::write(wt_path.join("alpha_wip.txt"), "untracked wip from alpha\n").unwrap();
    let rec1 = block_on(app.test_internals().board.handoff_async(
        &issue_id,
        "beta",
        "Commit handoff: finish remaining work",
        HandoffCleanup::Commit {
            message: "alpha: commit wip before hoe handoff".into(),
        },
    ))
    .unwrap();
    assert!(rec1.cleanup_commit.is_some());
    assert!(rec1.cleanup_stash.is_none());
    assert_eq!(rec1.previous_owner.unwrap().session_id, alpha_sid);

    let after_beta = wait_until_transition(app.ctx(), Duration::from_secs(10), "beta in_review", || {
        support::board_issue(app.test_internals().board, &issue_id).filter(|i| i.status == IssueStatus::InReview && i.assigned_agent() == Some("beta"))
    });
    let beta_sid = after_beta.latest_session_id().unwrap().to_string();
    assert!(wt_path.join("beta_dirty.txt").exists(), "beta left uncommitted scratch file");

    // Handoff to gamma using HandoffCleanup::Stash.
    let rec2 = block_on(app.test_internals().board.handoff_async(
        &issue_id,
        "gamma",
        "Stash handoff: take clean branch",
        HandoffCleanup::Stash {
            message: "beta: stash scratch before hoe handoff".into(),
        },
    ))
    .unwrap();
    assert!(rec2.cleanup_commit.is_none());
    assert!(rec2.cleanup_stash.is_some());
    assert_eq!(rec2.previous_owner.unwrap().session_id, beta_sid);
    assert!(!wt_path.join("beta_dirty.txt").exists(), "stash cleanup removes uncommitted scratch file");

    wait_until_transition(app.ctx(), Duration::from_secs(10), "gamma in_review", || {
        support::board_issue(app.test_internals().board, &issue_id).filter(|i| i.status == IssueStatus::InReview && i.assigned_agent() == Some("gamma"))
    });

    app.close_blocking();
}
