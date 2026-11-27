//! End-to-end server integration tests for Issue #53:
//! 1. 4-tier hard authorization gate across user, patrol, and cron triggers.
//! 2. Mode-scoped Chinese prompt assembly and MCP write-tool narrowing across
//!    Execution, Drafting, and ReadOnlyAnswer run modes.
//! 3. Persistent human pause across server restarts and explicit user resume.
//! 4. Retaining both `issue_report` summary and disconnect error facts.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_core::{Clock, ManualClock};
use vibevalley_protocol::{Caller, Issue, IssueStageKind as StageKind, IssueStatus, Outcome, StuckReason};
use vibevalley_runtime::agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, ToolCall, Usage};
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};
use vibevalley_runtime::oar::{
    Capabilities, EventKind, Installation, McpServer, ModelInfo, PermissionMode, Registry, Runtime, Session, SessionOptions, StopReason,
};
use vibevalley_server::agent::profile::text::ANSWER_ONLY;

use crate::support::{HookRuntime, block_on, board_issue, git, repo, slow_first, wait_stage};

struct ScriptedModel {
    answers: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
    cond: Condvar,
}

impl ScriptedModel {
    fn new(answers: impl Into<VecDeque<Completion>>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            seen: Mutex::new(Vec::new()),
            cond: Condvar::new(),
        })
    }

    fn wait_seen(&self, what: &str, mut pred: impl FnMut(&[ChatRequest]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut guard = self.seen.lock().unwrap();
        loop {
            if pred(&guard) {
                return;
            }
            let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
                panic!("timed out waiting for {what}: seen={}", guard.len());
            };
            let (next, res) = self.cond.wait_timeout(guard, rem).unwrap();
            guard = next;
            if res.timed_out() && !pred(&guard) {
                panic!("timed out waiting for {what}: seen={}", guard.len());
            }
        }
    }
}

impl ModelClient for ScriptedModel {
    fn complete<'a>(
        &'a self,
        request: &'a ChatRequest,
        on: &'a mut (dyn FnMut(Delta) + Send),
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::agent::Result<Completion>> {
        {
            self.seen.lock().unwrap().push(request.clone());
            self.cond.notify_all();
        }
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| say("好的。"));
        if let Some(t) = &answer.message.content {
            on(Delta::Text(t.clone()));
        }
        Box::pin(async move { Ok(answer) })
    }
}

fn say(text: &str) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: Some(text.into()),
            reasoning: None,
            tool_calls: vec![],
            tool_call_id: None,
        },
        finish: FinishReason::Stop,
        usage: Usage {
            input: 10,
            output: 5,
            cache_read: 0,
        },
    }
}

fn call(id: &str, name: &str, args: Value) -> Completion {
    Completion {
        message: Message {
            role: Role::Assistant,
            content: None,
            reasoning: None,
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: args.to_string(),
            }],
            tool_call_id: None,
        },
        finish: FinishReason::ToolCalls,
        usage: Usage {
            input: 10,
            output: 5,
            cache_read: 0,
        },
    }
}

struct RecordingRuntime {
    inner: ScriptedRuntime,
    opened: std::sync::mpsc::Sender<SessionOptions>,
    caps: Capabilities,
}

impl Runtime for RecordingRuntime {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn capabilities(&self) -> Capabilities {
        self.caps
    }
    fn installation(&self) -> vibevalley_runtime::oar::BoxFuture<'_, Installation> {
        self.inner.installation()
    }
    fn list_models(&self) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
        self.inner.list_models()
    }
    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn Session>>> {
        let _ = self.opened.send(opts.clone());
        self.inner.open(opts)
    }
}

fn mcp_rpc(url: &str, token: &str, id: i64, method: &str, params: Value) -> Value {
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

fn mcp_token_from(servers: &[McpServer]) -> String {
    servers
        .iter()
        .find_map(|s| match s {
            McpServer::Http { name, headers, .. } if name == "vibevalley" => headers
                .iter()
                .find(|(k, _)| k == "authorization")
                .map(|(_, v)| v.trim_start_matches("Bearer ").to_string()),
            _ => None,
        })
        .expect("vibevalley mcp server token")
}

fn install_worker(app: &vibevalley_server::App) -> vibevalley_protocol::Agent {
    let mut worker = block_on(app.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    worker.runtime = "scripted".into();
    worker.name = "Worker".into();
    block_on(app.test_internals().agent.profile.store.save_async(worker)).unwrap()
}

#[test]
fn patrol_and_cron_turns_obey_four_tier_issue_authorization_hard_gates() {
    let dir = tempfile::tempdir().unwrap();
    let repo_dir = dir.path().join("repos").join("farm");
    std::fs::create_dir_all(&repo_dir).unwrap();
    git(&repo_dir, &["init"]);
    git(&repo_dir, &["config", "user.email", "t@e.st"]);
    git(&repo_dir, &["config", "user.name", "t"]);
    std::fs::write(repo_dir.join("README.md"), "farm\n").unwrap();
    git(&repo_dir, &["add", "README.md"]);
    git(&repo_dir, &["commit", "-qm", "init"]);

    // Seed an initial issue #1 (deliver: answer) via User API.
    let model = ScriptedModel::new([
        // Turn 1 (Patrol): attempts start=true, update, done -> all 3 rejected by Rust gate!
        call(
            "p1",
            "issue_create",
            json!({ "title": "Unauthorized patrol start", "repo": "farm", "start": true }),
        ),
        call("p2", "issue_update", json!({ "id": "1", "priority": "urgent" })),
        call("p3", "issue_status_update", json!({ "id": "1", "status": "done" })),
        say("巡查发现问题，已先汇报。"),
        // Turn 2 (Approved Cron): creates+starts #2 (or updates #1), still blocked on `done`.
        call("c1", "issue_update", json!({ "id": "1", "priority": "high" })),
        call("c2", "issue_status_update", json!({ "id": "1", "status": "done" })),
        say("定时检查已更新优先级。"),
    ]);

    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let mut reg = Registry::new();
    reg.register(Arc::new(ScriptedRuntime::demo()));
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(reg)),
        model_client: Some(model.clone()),
        clock: clock.clone(),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();

    let created = app
        .router()
        .call_as(Caller::User, "issue.create", json!({ "title": "Seed issue", "deliver": "answer" }));
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let seed_id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    let default_channel = app.test_internals().channel.default_channel();

    // 1. Trigger a Patrol turn without user words.
    assert!(block_on(
        app.test_internals().agent.orchestrator.hear_patrol_async(&default_channel, "发现工单无人处理")
    ));
    model.wait_seen("patrol turn completed", |seen| {
        seen.iter().any(|r| {
            r.messages
                .iter()
                .filter(|m| m.role == Role::Tool)
                .filter_map(|m| m.content.as_deref())
                .any(|c| c.contains("定时回合一律拦截") || c.contains("缺少授权"))
        })
    });
    // Wait until patrol turn settles.
    crate::support::wait_until_channel_event(app.test_internals().channel, Duration::from_secs(10), "patrol reply", || {
        let msgs = app
            .router()
            .call_as(Caller::User, "channel.message.list", json!({ "id": default_channel }))
            .data?;
        msgs.as_array()?.iter().any(|m| m["text"] == "巡查发现问题，已先汇报。").then_some(())
    });

    // Verify patrol created NO started issue and did NOT mutate #1.
    let issues: Vec<Issue> = serde_json::from_value(app.router().call_as(Caller::User, "issue.list", json!({})).data.unwrap()).unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].id, seed_id);
    assert_eq!(issues[0].status, IssueStatus::Backlog);
    assert_eq!(issues[0].priority, vibevalley_protocol::Priority::Medium);

    // 2. Schedule an approved user cron firing into the orchestrator.
    let cron_res = app.router().call_as(
        Caller::User,
        "cron.create",
        json!({
            "name": "早班巡检",
            "text": "调整优先级并收口",
            "when": { "kind": "once", "at": clock.now_ms() + 1_000 }
        }),
    );
    assert_eq!(cron_res.biz_code, 0, "{}", cron_res.message);
    clock.advance(Duration::from_millis(1_500));
    block_on(app.test_internals().cron.tick_async());

    crate::support::wait_until_channel_event(app.test_internals().channel, Duration::from_secs(10), "cron reply", || {
        let msgs = app
            .router()
            .call_as(Caller::User, "channel.message.list", json!({ "id": default_channel }))
            .data?;
        msgs.as_array()?.iter().any(|m| m["text"] == "定时检查已更新优先级。").then_some(())
    });

    // Approved cron updated priority (`Tier 3`), while `done` (`Tier 4`) was STILL hard-rejected!
    let updated_seed: Issue = serde_json::from_value(app.router().call_as(Caller::User, "issue.get", json!({ "id": seed_id })).data.unwrap()).unwrap();
    assert_eq!(updated_seed.priority, vibevalley_protocol::Priority::High);
    assert_eq!(updated_seed.status, IssueStatus::Backlog);

    app.close_blocking();
}

#[test]
fn three_run_modes_narrow_prompts_in_chinese_and_mcp_write_tools() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let main = repo(dir.path(), "farm");

    let (opened_tx, opened_rx) = std::sync::mpsc::channel();
    let caps = ScriptedRuntime::demo().capabilities();
    let mut reg = Registry::new();
    reg.register(Arc::new(RecordingRuntime {
        inner: ScriptedRuntime::new("scripted", Script::new().turn(vec![Step::sleep_ms(30_000)])),
        opened: opened_tx,
        caps,
    }));

    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(reg)),
        probe_runtimes: false,
        tick_crons: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let door = format!("{}/mcp", listener.url());
    app.set_mcp_url(door.clone());

    let profile = install_worker(&app);
    assert!(main.exists());

    // Mode 1: Drafting (`起草`)
    let draft_issue: Value = app
        .router()
        .call_as(
            Caller::User,
            "issue.create",
            json!({ "title": "Draft mode check", "repo": "farm", "agent": profile.id }),
        )
        .data
        .unwrap();
    let draft_id = draft_issue["id"].as_str().unwrap().to_string();
    let refine = app
        .router()
        .call_as(Caller::User, "issue.refine", json!({ "id": draft_id, "text": "查清楚需求" }));
    assert_eq!(refine.biz_code, 0, "{}", refine.message);

    let draft_opts = opened_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let draft_rules = draft_opts.append_system_prompt.clone().unwrap_or_default();
    assert!(draft_rules.contains("起草") && !draft_rules.contains("You are drafting"), "{draft_rules}");
    assert_eq!(draft_opts.permission_mode, PermissionMode::Plan);
    assert!(draft_opts.disallowed_tools.iter().any(|t| t == "write" || t == "Write"));

    let draft_token = mcp_token_from(&draft_opts.mcp_servers);
    let draft_tools = mcp_rpc(&door, &draft_token, 1, "tools/list", json!({}));
    let draft_names: Vec<&str> = draft_tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(draft_names.contains(&"issue_list") && draft_names.contains(&"issue_get"));
    for forbidden in [
        "issue_report",
        "issue_split",
        "issue_pr_submit",
        "note_file_write",
        "note_doc_append_block",
        "note_base_upsert_row",
        "note_base_run_agent_column",
        "memory_create",
        "channel_message_send",
    ] {
        assert!(!draft_names.contains(&forbidden), "drafting exposed {forbidden}: {draft_names:?}");
    }
    let blocked_write = mcp_rpc(
        &door,
        &draft_token,
        2,
        "tools/call",
        json!({ "name": "issue_report", "arguments": { "summary": "should fail" } }),
    );
    assert_eq!(blocked_write["result"]["isError"], true, "{blocked_write}");

    // Mode 2: ReadOnlyAnswer (`只读问答`)
    let ans_issue: Value = app
        .router()
        .call_as(
            Caller::User,
            "issue.create",
            json!({ "title": "Readonly Q&A", "repo": "farm", "deliver": "answer", "agent": profile.id }),
        )
        .data
        .unwrap();
    let ans_id = ans_issue["id"].as_str().unwrap().to_string();
    let ans_start = app
        .router()
        .call_as(Caller::User, "issue.status.update", json!({ "id": ans_id, "status": "todo" }));
    assert_eq!(ans_start.biz_code, 0, "{}", ans_start.message);

    let ans_opts = opened_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let ans_rules = ans_opts.append_system_prompt.clone().unwrap_or_default();
    assert!(ans_rules.contains(ANSWER_ONLY) && ans_rules.contains("只读问答"), "{ans_rules}");
    assert!(
        !ans_rules.contains("This issue asks for an answer") && !ans_rules.contains("git add"),
        "{ans_rules}"
    );
    assert_eq!(ans_opts.permission_mode, PermissionMode::Plan);

    let ans_token = mcp_token_from(&ans_opts.mcp_servers);
    let ans_tools = mcp_rpc(&door, &ans_token, 3, "tools/list", json!({}));
    let ans_names: Vec<&str> = ans_tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(ans_names.contains(&"issue_report") && ans_names.contains(&"issue_list"));
    for forbidden in [
        "issue_split",
        "issue_pr_submit",
        "note_file_write",
        "note_create",
        "note_doc_append_block",
        "note_base_upsert_row",
        "note_base_run_agent_column",
        "memory_create",
        "channel_message_send",
    ] {
        assert!(!ans_names.contains(&forbidden), "readonly answer exposed {forbidden}: {ans_names:?}");
    }
    let blocked_split = mcp_rpc(
        &door,
        &ans_token,
        4,
        "tools/call",
        json!({ "name": "issue_split", "arguments": { "tasks": [{ "id": "a", "title": "A", "brief": "a" }] } }),
    );
    assert_eq!(blocked_split["result"]["isError"], true, "{blocked_split}");
    let blocked_pr = mcp_rpc(
        &door,
        &ans_token,
        5,
        "tools/call",
        json!({ "name": "issue_report", "arguments": { "summary": "ok", "prSubmit": true } }),
    );
    assert_eq!(blocked_pr["result"]["isError"], true, "{blocked_pr}");

    // Mode 3: Execution (`执行`)
    let exec_issue: Value = app
        .router()
        .call_as(
            Caller::User,
            "issue.create",
            json!({ "title": "Exec work", "repo": "farm", "deliver": "change", "agent": profile.id }),
        )
        .data
        .unwrap();
    let exec_id = exec_issue["id"].as_str().unwrap().to_string();
    let exec_start = app
        .router()
        .call_as(Caller::User, "issue.status.update", json!({ "id": exec_id, "status": "todo" }));
    assert_eq!(exec_start.biz_code, 0, "{}", exec_start.message);

    let exec_opts = opened_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let exec_rules = exec_opts.append_system_prompt.clone().unwrap_or_default();
    assert!(
        exec_rules.contains("## 在 VibeValley 工作的规矩") && exec_rules.contains("issue_split"),
        "{exec_rules}"
    );
    assert_eq!(exec_opts.permission_mode, PermissionMode::Bypass);

    let exec_token = mcp_token_from(&exec_opts.mcp_servers);
    let exec_tools = mcp_rpc(&door, &exec_token, 6, "tools/list", json!({}));
    let exec_names: Vec<&str> = exec_tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(exec_names.len(), vibevalley_server::agent::tool::helper().len(), "{exec_names:?}");

    drop(listener);
    app.close_blocking();
}

#[test]
fn human_pause_persists_across_restart_blocks_auto_wake_and_clears_on_user_resume() {
    let dir = tempfile::tempdir().unwrap();
    let main = repo(dir.path(), "app");
    assert!(main.exists());

    let mut reg1 = Registry::new();
    reg1.register(HookRuntime::new("scripted", slow_first(30_000), |turn| {
        turn.commit("step.txt", "work\n");
        turn.done("resumed and finished");
    }));

    let app1 = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(reg1)),
        probe_runtimes: false,
        tick_crons: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let profile = install_worker(&app1);
    let created = app1.router().call_as(
        Caller::User,
        "issue.create",
        json!({ "title": "Pausable job", "repo": "app", "agent": profile.id }),
    );
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    let started = app1
        .router()
        .call_as(Caller::User, "issue.status.update", json!({ "id": issue_id, "status": "todo" }));
    assert_eq!(started.biz_code, 0, "{}", started.message);

    let working = wait_stage(app1.test_internals().board, &issue_id, StageKind::Working);
    let sid = working.latest_session_id().unwrap().clone();

    // Pause via `session.stop` (Caller::User).
    let stopped = app1.router().call_as(Caller::User, "session.stop", json!({ "id": sid }));
    assert_eq!(stopped.biz_code, 0, "{}", stopped.message);
    let paused = wait_stage(app1.test_internals().board, &issue_id, StageKind::Stuck);
    assert_eq!(paused.stage.stuck, Some(StuckReason::Interrupted));
    let pause = paused.mandate.pause.expect("human pause persisted");
    assert_eq!(pause.source, vibevalley_protocol::HumanPauseSource::UserStop);
    assert_eq!(pause.clear_condition, vibevalley_protocol::ResumeCondition::ExplicitUserResume);

    app1.close_blocking();

    // Reopen server on the same DB -> pause MUST still be persisted and block non-user wakeup.
    let mut reg2 = Registry::new();
    reg2.register(HookRuntime::new("scripted", Script::echo(), |turn| {
        turn.commit("resumed.txt", "after pause\n");
        turn.done("resumed and completed");
    }));
    let app2 = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(reg2)),
        probe_runtimes: false,
        tick_crons: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();

    let reloaded = board_issue(app2.test_internals().board, &issue_id).unwrap();
    let reloaded_pause = reloaded.mandate.pause.expect("human pause survived server restart");
    assert_eq!(reloaded_pause.source, vibevalley_protocol::HumanPauseSource::UserStop);

    // Non-user message & queue refresh MUST NOT resume the paused issue.
    let non_user_res = block_on(app2.test_internals().board.tell_message_from_async(&issue_id, "auto ping", "non-user-1", false));
    assert!(non_user_res.is_err());
    block_on(app2.test_internals().board.refresh_queue_async()).unwrap();
    assert!(board_issue(app2.test_internals().board, &issue_id).unwrap().mandate.is_paused());

    // Explicit user resume via `issue.status.update` clears `mandate.pause` and runs to review.
    let resumed = app2
        .router()
        .call_as(Caller::User, "issue.status.update", json!({ "id": issue_id, "status": "todo" }));
    assert_eq!(resumed.biz_code, 0, "{}", resumed.message);
    let reviewing = wait_stage(app2.test_internals().board, &issue_id, StageKind::Reviewing);
    assert!(reviewing.mandate.pause.is_none());

    app2.close_blocking();
}

#[test]
fn worker_report_followed_by_error_disconnect_retains_both_summary_and_disconnect_fact() {
    let dir = tempfile::tempdir().unwrap();
    let main = repo(dir.path(), "app");
    assert!(main.exists());

    let mut reg = Registry::new();
    let script = Script::computed(Arc::new(|ask| {
        let door_token = mcp_token_from(&ask.mcp_servers);
        let door_url = ask
            .mcp_servers
            .iter()
            .find_map(|s| match s {
                McpServer::Http { name, url, .. } if name == "vibevalley" => Some(url.clone()),
                _ => None,
            })
            .unwrap();
        let res = mcp_rpc(
            &door_url,
            &door_token,
            99,
            "tools/call",
            json!({ "name": "issue_report", "arguments": { "summary": "已完成补丁 commit 987654" } }),
        );
        assert_eq!(res["result"]["isError"], false, "{res}");
        Ok(vec![
            Step::Emit(EventKind::Error {
                message: "peer reset connection".into(),
            }),
            Step::finish(StopReason::Error),
        ])
    }));
    reg.register(Arc::new(ScriptedRuntime::new("scripted", script)));
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(reg)),
        probe_runtimes: false,
        tick_crons: false,
        orchestrator_listens: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let door = format!("{}/mcp", listener.url());
    app.set_mcp_url(door);

    let profile = install_worker(&app);
    let created = app.router().call_as(
        Caller::User,
        "issue.create",
        json!({ "title": "Report then disconnect", "repo": "app", "agent": profile.id }),
    );
    let issue_id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    let started = app
        .router()
        .call_as(Caller::User, "issue.status.update", json!({ "id": issue_id, "status": "todo" }));
    assert_eq!(started.biz_code, 0, "{}", started.message);

    let stuck = wait_stage(app.test_internals().board, &issue_id, StageKind::Stuck);
    assert_eq!(stuck.stage.stuck, Some(StuckReason::Failed));
    let runs = block_on(app.test_internals().board.runs_async(&issue_id)).unwrap();
    let last_run = runs.last().unwrap();
    assert_eq!(last_run.outcome, Some(Outcome::Failed));
    assert!(last_run.summary.contains("已完成补丁 commit 987654"), "{}", last_run.summary);
    assert!(last_run.summary.contains("peer reset connection"), "{}", last_run.summary);

    drop(listener);
    app.close_blocking();
}
