use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;
use vibevalley_runtime::agent::core::engine::Request;
use vibevalley_runtime::agent::core::events::AgentEvent;
use vibevalley_runtime::agent::durable::Store;
use vibevalley_runtime::agent::experiments::ExperimentFlags;
use vibevalley_runtime::agent::extensions::{GovernanceExtension, OAR_TASK_KIND, OarExtension, OarPolicy, Permissions, Policy, tree_spend};
use vibevalley_runtime::agent::harness::{Harness, WorkersOnly, worker_conversation};
use vibevalley_runtime::agent::runtime::{VibeValleyRuntime, default_registry};
use vibevalley_runtime::agent::tools::{Workspace, coding_tools};
use vibevalley_runtime::agent::{Brain, ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Result as AiResult, Role, ToolCall, Usage};
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step, TurnAsk};
use vibevalley_runtime::oar::{ContentBlock, EventKind, PermissionDecision, PermissionMode, Registry, Runtime, SessionOptions, StopReason};

const WAIT: Duration = Duration::from_secs(10);

struct QueueClient {
    replies: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
}

impl QueueClient {
    fn new(replies: Vec<Completion>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::new(Vec::new()),
        })
    }
}

impl ModelClient for QueueClient {
    fn complete(&self, req: &ChatRequest, on: &mut dyn FnMut(Delta)) -> AiResult<Completion> {
        self.seen.lock().unwrap().push(req.clone());
        let reply = self.replies.lock().unwrap().pop_front().expect("unexpected model call");
        if let Some(t) = &reply.message.content {
            on(Delta::Text(t.clone()));
        }
        Ok(reply)
    }
}

fn say(text: &str) -> Completion {
    Completion {
        message: Message::assistant(text),
        finish: FinishReason::Stop,
        usage: Usage {
            input: 100,
            output: 12,
            cache_read: 0,
        },
    }
}

fn call_tool(id: &str, name: &str, args: Value) -> Completion {
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
            input: 80,
            output: 10,
            cache_read: 0,
        },
    }
}

#[test]
fn path1_human_to_oar_drives_scripted_and_vibevalley_symmetrically() {
    // 1. Default registry includes scripted & vibevalley with expected capabilities.
    let reg = default_registry();
    let vv = reg.require("vibevalley").unwrap();
    let caps = vv.capabilities();
    assert!(caps.steer && caps.permission_requests && caps.subagents && caps.resume && caps.queue);

    // 2. Drive scripted demo through default_registry().
    let scripted_work = TempDir::new().unwrap();
    let scripted_rt = reg.require("scripted").unwrap();
    let s_sess = scripted_rt
        .open(SessionOptions {
            cwd: scripted_work.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
    let rx = s_sess.events();
    s_sess.prompt(vec![ContentBlock::Text("write note".into())]).unwrap();
    let mut saw_perm = false;
    let mut finished = None;
    while let Ok(ev) = rx.recv_timeout(WAIT) {
        match ev.kind {
            EventKind::PermissionRequested { request_id, .. } => {
                saw_perm = true;
                s_sess.respond_permission(&request_id, PermissionDecision::AllowOnce).unwrap();
            }
            EventKind::TurnFinished { reason, usage } => {
                finished = Some((reason, usage));
                break;
            }
            _ => {}
        }
    }
    assert!(saw_perm);
    let (reason, usage) = finished.unwrap();
    assert_eq!(reason, StopReason::Completed);
    assert_eq!(usage.cost_usd, Some(0.0042));

    // 3. Drive offline VibeValleyRuntime directly over OAR for permission + subagent + steer.
    let dir = TempDir::new().unwrap();
    let work = TempDir::new().unwrap();
    let rt = VibeValleyRuntime::new(Arc::new(|| None), dir.path().to_path_buf()).with_client(QueueClient::new(vec![
        call_tool("w1", "write", json!({"path": "ok.txt", "content": "1"})),
        call_tool("s1", "spawn_agent", json!({"brief": "check", "label": "helper"})),
        say("subagent ok"),
        say("all set"),
    ]));
    let sess = rt
        .open(SessionOptions {
            cwd: work.path().to_path_buf(),
            permission_mode: PermissionMode::Ask,
            ..Default::default()
        })
        .unwrap();
    let evs = sess.events();
    sess.prompt(vec![ContentBlock::Text("work".into())]).unwrap();
    let mut saw_subagent = false;
    let mut done = false;
    while let Ok(ev) = evs.recv_timeout(WAIT) {
        match ev.kind {
            EventKind::PermissionRequested { request_id, .. } => {
                sess.respond_permission(&request_id, PermissionDecision::AllowOnce).unwrap();
            }
            EventKind::SubagentSpawned { .. } => saw_subagent = true,
            EventKind::TurnFinished { reason, .. } => {
                assert_eq!(reason, StopReason::Completed);
                done = true;
                break;
            }
            _ => {}
        }
    }
    assert!(done && saw_subagent);
    assert_eq!(std::fs::read_to_string(work.path().join("ok.txt")).unwrap(), "1");
}

#[test]
fn path2_builtin_agent_to_oar_enforces_limits_records_cost_and_cascades_abort() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let disallowed_dir = TempDir::new().unwrap();

    let (block_enter_tx, block_enter_rx) = flume::bounded(1);
    let (block_rel_tx, block_rel_rx) = flume::bounded(1);
    let (aborted_tx, aborted_rx) = flume::bounded(1);

    let mut reg = Registry::new();
    reg.register(Arc::new(ScriptedRuntime::demo()));
    reg.register(Arc::new(ScriptedRuntime::new(
        "slow",
        Script::computed(Arc::new(move |_: &TurnAsk| {
            let _ = block_enter_tx.send(());
            let _ = block_rel_rx.recv_timeout(WAIT);
            Ok(vec![Step::Sleep(Duration::from_millis(50)), Step::finish(StopReason::Completed)])
        })),
    )));
    reg.register(Arc::new(ScriptedRuntime::new("forbidden", Script::echo())));

    let reg = Arc::new(reg);
    let policy = OarPolicy {
        allowed_runtimes: Some(vec!["scripted".into(), "slow".into()]),
        max_concurrent: 1,
        max_depth: 1,
        default_permission_mode: PermissionMode::Plan,
        allowed_workdirs: vec![dir_a.path().to_path_buf(), dir_b.path().to_path_buf()],
    };

    let store = Store::memory().unwrap();
    let oar_ext = Arc::new(OarExtension::new(reg, policy));
    let harness = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
    harness.register_extension(Arc::new(GovernanceExtension::new(Permissions {
        builtin_default: Policy::AlwaysAllow,
        mcp_default: Policy::AlwaysAllow,
        overrides: BTreeMap::new(),
    })));
    harness.register_extension(oar_ext.clone());
    harness.recover().unwrap();

    // A: Enforce allowed_runtimes, allowed_workdirs, oar_list filtering, and external cost attribution.
    let c1 = QueueClient::new(vec![
        call_tool("l1", "oar_list", json!({})),
        call_tool("o_bad_rt", "oar_run", json!({"runtime": "forbidden", "cwd": dir_a.path(), "prompt": "hi"})),
        call_tool(
            "o_bad_dir",
            "oar_run",
            json!({"runtime": "scripted", "cwd": disallowed_dir.path(), "prompt": "hi"}),
        ),
        call_tool(
            "o_ok",
            "oar_run",
            json!({"runtime": "scripted", "cwd": dir_a.path(), "prompt": "hi", "permissionMode": "bypass"}),
        ),
        say("delegated ok"),
    ]);
    let conv1 = worker_conversation("p2-a");
    harness
        .attach_worker(&conv1, Arc::new(Brain::new(c1, "deepseek-flash", "sys")), Arc::new(|_| {}))
        .unwrap();
    let (_, t1, _) = harness
        .submit(Request {
            conversation: &conv1,
            provider: "deepseek-flash",
            request_id: "r1",
            prompt: "delegate",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .unwrap();
    let d1 = harness.scheduler().wait(&t1.id, WAIT).unwrap();
    assert_eq!(d1.terminal_reason, "completed");

    let entries = harness.entries(&conv1).unwrap();
    let results: Vec<_> = entries.iter().filter(|e| e.kind == "pi.tool_result").collect();
    assert!(results[0].payload["output"].as_str().unwrap().contains("\"scripted\""));
    assert!(!results[0].payload["output"].as_str().unwrap().contains("\"forbidden\""));
    assert_eq!(results[1].payload["ok"], false);
    assert_eq!(results[2].payload["ok"], false);
    assert_eq!(results[3].payload["ok"], true);
    let spent = store.read(|tx| tree_spend(tx, &conv1)).unwrap();
    assert!(spent >= 4200, "expected >= 4200 micros from scripted demo usage, got {spent}");

    // B: Depth guard via SQL owner chain (`pi.oar.run` ancestor) rejects nested `oar_run` at max_depth = 1.
    let store_deep = Store::memory().unwrap();
    let conv_deep = "nested-from-oar";
    store_deep
        .write(|tx| {
            tx.create_conversation(conv1.as_str(), "deepseek-flash")?;
            let mut parent_oar = vibevalley_runtime::agent::durable::Task::new(OAR_TASK_KIND, "run");
            parent_oar.id = "ancestor-oar".into();
            parent_oar.conversation_id = conv1.clone();
            tx.create_task(parent_oar)?;
            tx.create_owned_conversation(conv_deep, "deepseek-flash", "ancestor-oar")?;
            Ok(())
        })
        .unwrap();
    let c_deep = QueueClient::new(vec![
        call_tool("d1", "oar_run", json!({"runtime": "scripted", "cwd": dir_a.path(), "prompt": "nested"})),
        say("blocked depth"),
    ]);
    struct DeepBrain(Arc<Brain>);
    impl vibevalley_runtime::agent::core::engine::BrainProvider for DeepBrain {
        fn resolve_brain(&self, _: &str, _: &str) -> vibevalley_runtime::agent::durable::Result<Option<Arc<Brain>>> {
            Ok(Some(self.0.clone()))
        }
    }
    let h_deep = Harness::from_store(store_deep.clone(), Arc::new(DeepBrain(Arc::new(Brain::new(c_deep, "deepseek-flash", "sys")))));
    h_deep.register_extension(oar_ext.clone());
    h_deep.recover().unwrap();
    let (_, t_deep, _) = h_deep
        .submit(Request {
            conversation: conv_deep,
            provider: "deepseek-flash",
            request_id: "r-deep",
            prompt: "try nest",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .unwrap();
    let dd = h_deep.scheduler().wait(&t_deep.id, WAIT).unwrap();
    assert_eq!(dd.terminal_reason, "completed");
    let e_deep = h_deep.entries(conv_deep).unwrap();
    let err_deep = e_deep.iter().find(|e| e.kind == "pi.tool_result").unwrap().payload["error"].as_str().unwrap();
    assert!(err_deep.contains("max_depth"), "{err_deep}");
    h_deep.close();

    // C: max_concurrent = 1 blocks concurrent session even on DIFFERENT dir_b, then parent abort cascades cleanly.
    let c_slow = QueueClient::new(vec![call_tool(
        "s_slow",
        "oar_run",
        json!({"runtime": "slow", "cwd": dir_a.path(), "prompt": "hang", "permissionMode": "plan"}),
    )]);
    let conv_slow = worker_conversation("p2-slow");
    harness
        .attach_worker(
            &conv_slow,
            Arc::new(Brain::new(c_slow, "deepseek-flash", "sys")),
            Arc::new(move |e| {
                if matches!(e, AgentEvent::SubagentStatusChanged { status, .. } if status == "aborted") {
                    let _ = aborted_tx.send(());
                }
            }),
        )
        .unwrap();
    let handle_slow = harness.conversation(&conv_slow);
    let (_, t_slow, _) = handle_slow.prompt("deepseek-flash", "r-slow", "run slow", "sys").unwrap();
    block_enter_rx.recv_timeout(WAIT).unwrap();

    // Concurrent second OAR request fails cleanly with max_concurrent (1) on different workdir dir_b.
    let c_conc = QueueClient::new(vec![
        call_tool(
            "o_conc",
            "oar_run",
            json!({"runtime": "scripted", "cwd": dir_b.path(), "prompt": "second", "permissionMode": "plan"}),
        ),
        say("hit limit"),
    ]);
    let conv_conc = worker_conversation("p2-conc");
    harness
        .attach_worker(&conv_conc, Arc::new(Brain::new(c_conc, "deepseek-flash", "sys")), Arc::new(|_| {}))
        .unwrap();
    let (_, t_conc, _) = harness.conversation(&conv_conc).prompt("deepseek-flash", "r-conc", "second", "sys").unwrap();
    let d_conc = harness.scheduler().wait(&t_conc.id, WAIT).unwrap();
    assert_eq!(d_conc.terminal_reason, "completed");
    let e_conc = harness.entries(&conv_conc).unwrap();
    let err_conc = e_conc.iter().find(|e| e.kind == "pi.tool_result").unwrap().payload["error"].as_str().unwrap();
    assert!(err_conc.contains("max concurrent OAR sessions"), "{err_conc}");

    // Parent abort cancels active slow OAR session & cascades.
    handle_slow.abort().unwrap();
    let _ = block_rel_tx.send(());
    let d_slow = harness.scheduler().wait(&t_slow.id, WAIT).unwrap();
    assert_eq!(d_slow.terminal_reason, "aborted");
    aborted_rx.recv_timeout(WAIT).expect("oar SubagentStatusChanged aborted");
    harness.close();
    assert!(oar_ext.active_sessions().is_empty());

    // D: Same-cwd concurrent write guard (`Plan` & separate workdir allowed; concurrent mutating on same cwd rejected).
    let (cw_enter_tx, cw_enter_rx) = flume::bounded(1);
    let (cw_rel_tx, cw_rel_rx) = flume::bounded(1);
    let mut reg_d = Registry::new();
    reg_d.register(Arc::new(ScriptedRuntime::demo()));
    reg_d.register(Arc::new(ScriptedRuntime::new(
        "slow",
        Script::computed(Arc::new(move |_: &TurnAsk| {
            let _ = cw_enter_tx.send(());
            let _ = cw_rel_rx.recv_timeout(WAIT);
            Ok(vec![Step::text("slow done"), Step::finish(StopReason::Completed)])
        })),
    )));
    let oar_d = Arc::new(OarExtension::new(
        Arc::new(reg_d),
        OarPolicy {
            allowed_runtimes: Some(vec!["scripted".into(), "slow".into()]),
            max_concurrent: 4,
            max_depth: 1,
            default_permission_mode: PermissionMode::Plan,
            allowed_workdirs: vec![dir_a.path().to_path_buf(), dir_b.path().to_path_buf()],
        },
    ));
    let h_d = Harness::from_store(Store::memory().unwrap(), Arc::new(WorkersOnly));
    h_d.register_extension(Arc::new(GovernanceExtension::new(Permissions {
        builtin_default: Policy::AlwaysAllow,
        mcp_default: Policy::AlwaysAllow,
        overrides: BTreeMap::new(),
    })));
    h_d.register_extension(oar_d);
    h_d.recover().unwrap();

    let conv_hold = worker_conversation("p2-hold");
    h_d.attach_worker(
        &conv_hold,
        Arc::new(Brain::new(
            QueueClient::new(vec![
                call_tool(
                    "hold",
                    "oar_run",
                    json!({"runtime": "slow", "cwd": dir_a.path(), "prompt": "write a", "permissionMode": "bypass"}),
                ),
                say("held ok"),
            ]),
            "deepseek-flash",
            "sys",
        )),
        Arc::new(|_| {}),
    )
    .unwrap();
    let (_, t_hold, _) = h_d.conversation(&conv_hold).prompt("deepseek-flash", "rh", "hold", "sys").unwrap();
    cw_enter_rx.recv_timeout(WAIT).unwrap();

    // Parallel Plan on SAME dir_a and parallel Bypass on DIFFERENT dir_b succeed; concurrent Bypass on SAME dir_a is rejected.
    let conv_probe = worker_conversation("p2-probe");
    h_d.attach_worker(
        &conv_probe,
        Arc::new(Brain::new(
            QueueClient::new(vec![
                call_tool(
                    "plan_same",
                    "oar_run",
                    json!({"runtime": "scripted", "cwd": dir_a.path(), "prompt": "read", "permissionMode": "plan"}),
                ),
                call_tool(
                    "mut_other",
                    "oar_run",
                    json!({"runtime": "scripted", "cwd": dir_b.path(), "prompt": "write b", "permissionMode": "bypass"}),
                ),
                call_tool(
                    "mut_same",
                    "oar_run",
                    json!({"runtime": "scripted", "cwd": dir_a.path(), "prompt": "write a2", "permissionMode": "bypass"}),
                ),
                say("probed"),
            ]),
            "deepseek-flash",
            "sys",
        )),
        Arc::new(|_| {}),
    )
    .unwrap();
    let (_, t_probe, _) = h_d.conversation(&conv_probe).prompt("deepseek-flash", "rp", "probe", "sys").unwrap();
    let d_probe = h_d.scheduler().wait(&t_probe.id, WAIT).unwrap();
    assert_eq!(d_probe.terminal_reason, "completed");
    let e_probe = h_d.entries(&conv_probe).unwrap();
    let r_probe: Vec<_> = e_probe.iter().filter(|e| e.kind == "pi.tool_result").collect();
    assert_eq!(r_probe[0].payload["ok"], true, "plan on same cwd must be allowed");
    assert_eq!(r_probe[1].payload["ok"], true, "mutating on isolated dir_b must be allowed");
    assert_eq!(r_probe[2].payload["ok"], false, "concurrent mutating on same dir_a must be rejected");
    assert!(r_probe[2].payload["error"].as_str().unwrap().contains("concurrent mutating"));

    cw_rel_tx.send(()).unwrap();
    let d_hold = h_d.scheduler().wait(&t_hold.id, WAIT).unwrap();
    assert_eq!(d_hold.terminal_reason, "completed");
    h_d.close();
}

#[test]
fn path3_codemode_combines_local_grep_and_oar_run_and_default_experiments_mount_nothing() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("notes.rs"), "pub fn needle_finder() -> i32 { 42 }\n").unwrap();

    // 1. Default ExperimentFlags mounts nothing.
    let store_def = Store::memory().unwrap();
    let h_def = Harness::workers_only(store_def);
    let mut empty_reg = Registry::new();
    empty_reg.register(Arc::new(ScriptedRuntime::new("echo", Script::echo())));
    let empty_reg = Arc::new(empty_reg);
    h_def.with_experiments(&ExperimentFlags::default(), Some((empty_reg.clone(), OarPolicy::default())));
    assert!(h_def.extension_names().is_empty());
    h_def.close();

    // 2. Enabled flags mount codemode + oar + tree_branch and let run_code compose grep + oar_run.
    let mut reg = Registry::new();
    reg.register(Arc::new(ScriptedRuntime::new(
        "scripted",
        Script::computed(Arc::new(|ask: &TurnAsk| {
            Ok(vec![Step::text(format!("oar saw: {}", ask.prompt)), Step::finish(StopReason::Completed)])
        })),
    )));

    let store = Store::memory().unwrap();
    let harness = Harness::from_store(store, Arc::new(WorkersOnly));
    harness.register_extension(Arc::new(GovernanceExtension::new(Permissions {
        builtin_default: Policy::AlwaysAllow,
        mcp_default: Policy::AlwaysAllow,
        overrides: BTreeMap::new(),
    })));
    harness.with_experiments(
        &ExperimentFlags {
            codemode: true,
            tree_branch: true,
            oar_delegate: true,
        },
        Some((Arc::new(reg), OarPolicy::default())),
    );
    harness.recover().unwrap();
    assert_eq!(harness.extension_names(), vec!["governance", "codemode", "oar", "tree_branch"]);

    let script = format!(
        r#"
        const hits = call("grep", {{ pattern: "needle_finder" }});
        const summary = call("oar_run", {{
            runtime: "scripted",
            cwd: {},
            prompt: "summarize: " + hits,
            permissionMode: "plan"
        }});
        return {{ hits, summaryOutput: summary.output }};
        "#,
        json!(dir.path())
    );
    let client = QueueClient::new(vec![call_tool("cm-combo", "run_code", json!({"script": script})), say("combined done")]);
    let mut brain = Brain::new(client.clone(), "deepseek-flash", "sys");
    brain.tools = coding_tools(&Workspace::new(dir.path()));

    let conv = worker_conversation("p3-combo");
    harness.attach_worker(&conv, Arc::new(brain), Arc::new(|_| {})).unwrap();
    let (_, task, _) = harness
        .submit(Request {
            conversation: &conv,
            provider: "deepseek-flash",
            request_id: "r-combo",
            prompt: "compose grep and oar",
            source: "user",
            system: "sys",
            ..Default::default()
        })
        .unwrap();
    let done = harness.scheduler().wait(&task.id, WAIT).unwrap();
    assert_eq!(done.terminal_reason, "completed");
    assert_eq!(done.result["output"], "combined done");

    let seen = client.seen.lock().unwrap();
    assert!(seen[0].tools.iter().any(|t| t.name == "run_code"));
    assert!(seen[0].tools.iter().any(|t| t.name == "oar_run"));
    let tool_out = seen[1].messages.last().unwrap().content.as_deref().unwrap();
    let parsed: Value = serde_json::from_str(tool_out).unwrap();
    assert!(parsed["value"]["hits"].as_str().unwrap().contains("needle_finder"));
    assert!(parsed["value"]["summaryOutput"].as_str().unwrap().contains("oar saw: summarize:"));
    assert!(parsed["value"]["summaryOutput"].as_str().unwrap().contains("needle_finder"));
    harness.close();
}
