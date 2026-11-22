//! Direct workspace chat sessions: `session.openWorkspace`, `session.send`,
//! `session.respondPermission`, `session.respondInteraction`,
//! `session.setConfig`, `session.stop`, and `session.watch` end-to-end.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};
use vibevalley_protocol::{BizCode, Caller};
use vibevalley_runtime::oar::{
    Capabilities, ContentBlock, ControlAction, ControlOutcome, ControlStatus, Event, EventKind, Installation, InteractionDecision, InteractionOption,
    ModelInfo, PermissionDecision, PermissionMode, Registry, Runtime, Session, SessionOptions, SessionStatus, StopReason, Usage, voyage,
};
use vibevalley_server::{Server, ServerConfig, Started};

use super::until;

#[derive(Debug, Clone)]
enum MockTurn {
    EchoUsage(Usage),
    NeedPermission { request_id: String },
    BypassPermAndInteraction { perm_id: String, interaction_id: String },
    HoldUntilAbort,
}

#[derive(Default)]
struct MockLog {
    opened: Vec<SessionOptions>,
    prompts: Vec<Vec<ContentBlock>>,
    steers: Vec<Vec<ContentBlock>>,
    permissions: Vec<(String, PermissionDecision)>,
    interactions: Vec<(String, InteractionDecision)>,
    configs: Vec<(Option<String>, Option<String>, Option<PermissionMode>)>,
    aborts: usize,
}

struct MockRuntime {
    id: String,
    turns: Arc<Mutex<VecDeque<MockTurn>>>,
    log: Arc<Mutex<MockLog>>,
}

impl MockRuntime {
    fn new(id: &str, turns: Vec<MockTurn>) -> (Arc<Self>, Arc<Mutex<MockLog>>) {
        let log = Arc::new(Mutex::new(MockLog::default()));
        let rt = Arc::new(Self {
            id: id.into(),
            turns: Arc::new(Mutex::new(turns.into())),
            log: log.clone(),
        });
        (rt, log)
    }
}

impl Runtime for MockRuntime {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        "Antigravity"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
            config_options: true,
        }
    }

    fn installation(&self) -> Installation {
        Installation::Available {
            version: Some("1.5.14".into()),
            path: "/usr/local/bin/agy".into(),
        }
    }

    fn list_models(&self) -> vibevalley_runtime::oar::Result<Vec<ModelInfo>> {
        Ok(vec![ModelInfo {
            id: "gemini-4-neon".into(),
            display_name: "Gemini 4 Neon".into(),
            effort_levels: vec!["low".into(), "medium".into(), "high".into()],
            default_effort: Some("high".into()),
            is_default: true,
        }])
    }

    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::oar::Result<Arc<dyn Session>> {
        self.log.lock().unwrap().opened.push(opts.clone());
        let vendor_id = opts.resume.clone().unwrap_or_else(|| "agy-vendor-1".into());
        let sess = Arc::new(MockSession {
            id: vendor_id.clone(),
            runtime_id: self.id.clone(),
            seq: AtomicU64::new(0),
            history: Mutex::new(vec![]),
            subs: Mutex::new(vec![]),
            turns: self.turns.clone(),
            log: self.log.clone(),
            perm_waiter: Mutex::new(None),
            inter_waiter: Mutex::new(None),
            abort_waiter: Mutex::new(None),
            disposed: AtomicBool::new(false),
        });
        sess.emit(EventKind::SessionStarted {
            session_id: vendor_id,
            model: opts.model,
        });
        Ok(sess)
    }
}

struct MockSession {
    id: String,
    runtime_id: String,
    seq: AtomicU64,
    history: Mutex<Vec<Event>>,
    subs: Mutex<Vec<flume::Sender<Event>>>,
    turns: Arc<Mutex<VecDeque<MockTurn>>>,
    log: Arc<Mutex<MockLog>>,
    perm_waiter: Mutex<Option<(String, flume::Sender<PermissionDecision>)>>,
    inter_waiter: Mutex<Option<(String, flume::Sender<InteractionDecision>)>>,
    abort_waiter: Mutex<Option<flume::Sender<()>>>,
    disposed: AtomicBool,
}

impl MockSession {
    fn emit(&self, kind: EventKind) {
        let ev = Event {
            seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1,
            agent_path: vec![],
            at_ms: 1_700_000_000_000,
            kind,
        };
        self.history.lock().unwrap().push(ev.clone());
        self.subs.lock().unwrap().retain(|tx| tx.send(ev.clone()).is_ok());
    }
}

impl Session for MockSession {
    fn id(&self) -> String {
        self.id.clone()
    }

    fn control(&self, action: ControlAction, _arg: &str, input_id: &str, span_id: &str) -> vibevalley_runtime::oar::Result<ControlOutcome> {
        Ok(ControlOutcome {
            action,
            status: ControlStatus::Unsupported,
            code: String::new(),
            reason: String::new(),
            span_id: span_id.into(),
            input_id: input_id.into(),
        })
    }

    fn records(&self) -> Vec<voyage::Record> {
        vec![]
    }

    fn subscribe_records(&self, _after: Option<u64>) -> flume::Receiver<voyage::Record> {
        let (_, rx) = flume::bounded(1);
        rx
    }

    fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    fn status(&self) -> SessionStatus {
        if self.disposed.load(Ordering::Relaxed) {
            SessionStatus::Ended
        } else {
            SessionStatus::Idle
        }
    }

    fn events(&self) -> flume::Receiver<Event> {
        let (tx, rx) = flume::unbounded();
        self.subs.lock().unwrap().push(tx);
        rx
    }

    fn events_with_history(&self) -> flume::Receiver<Event> {
        let (tx, rx) = flume::unbounded();
        for ev in self.history.lock().unwrap().iter() {
            let _ = tx.send(ev.clone());
        }
        self.subs.lock().unwrap().push(tx);
        rx
    }

    fn prompt(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
        let text = content
            .iter()
            .find_map(|b| match b {
                ContentBlock::Text(t) => Some(t.clone()),
                _ => None,
            })
            .unwrap_or_default();
        self.log.lock().unwrap().prompts.push(content);
        let turn = self.turns.lock().unwrap().pop_front().unwrap_or(MockTurn::EchoUsage(Usage::default()));
        // Spawn a background turn thread mirroring real async OAR sessions.
        let this_history = self.history.lock().unwrap().len();
        let _ = this_history;
        self.emit(EventKind::TurnStarted { prompt: text.clone() });
        match turn {
            MockTurn::EchoUsage(usage) => {
                self.emit(EventKind::ThinkingDelta {
                    text: format!("checking {text}"),
                });
                self.emit(EventKind::ToolCallStarted {
                    id: "c1".into(),
                    name: "read_file".into(),
                    input: json!({ "path": "README.md", "kind": "read" }),
                });
                self.emit(EventKind::ToolCallFinished {
                    id: "c1".into(),
                    ok: true,
                    output: "readme body".into(),
                });
                self.emit(EventKind::TextDelta { text: format!("echo: {text}") });
                self.emit(EventKind::TurnFinished {
                    reason: StopReason::Completed,
                    usage,
                });
            }
            MockTurn::NeedPermission { request_id } => {
                let (tx, rx) = flume::bounded(1);
                *self.perm_waiter.lock().unwrap() = Some((request_id.clone(), tx));
                self.emit(EventKind::PermissionRequested {
                    request_id: request_id.clone(),
                    tool: "Bash".into(),
                    input: json!({ "command": "ls -la" }),
                    summary: "Run ls -la".into(),
                });
                let subs = self.subs.lock().unwrap().clone();
                std::thread::spawn(move || {
                    if let Ok(decision) = rx.recv_timeout(Duration::from_secs(10)) {
                        for (idx, kind) in [
                            EventKind::PermissionResolved { request_id, decision },
                            EventKind::TextDelta { text: "perm ok".into() },
                            EventKind::TurnFinished {
                                reason: StopReason::Completed,
                                usage: Usage::default(),
                            },
                        ]
                        .into_iter()
                        .enumerate()
                        {
                            let ev = Event {
                                seq: 100 + idx as u64,
                                agent_path: vec![],
                                at_ms: 1_700_000_000_000,
                                kind,
                            };
                            for s in &subs {
                                let _ = s.send(ev.clone());
                            }
                        }
                    }
                });
            }
            MockTurn::BypassPermAndInteraction { perm_id, interaction_id } => {
                let (ptx, prx) = flume::bounded(1);
                let (itx, irx) = flume::bounded(1);
                *self.perm_waiter.lock().unwrap() = Some((perm_id.clone(), ptx));
                *self.inter_waiter.lock().unwrap() = Some((interaction_id.clone(), itx));
                let subs = self.subs.lock().unwrap().clone();
                self.emit(EventKind::PermissionRequested {
                    request_id: perm_id.clone(),
                    tool: "Bash".into(),
                    input: json!({ "command": "echo hi" }),
                    summary: "Run echo".into(),
                });
                std::thread::spawn(move || {
                    let send = |seq: u64, kind: EventKind| {
                        let ev = Event {
                            seq,
                            agent_path: vec![],
                            at_ms: 1_700_000_000_000,
                            kind,
                        };
                        for s in &subs {
                            let _ = s.send(ev.clone());
                        }
                    };
                    if let Ok(p_dec) = prx.recv_timeout(Duration::from_secs(10)) {
                        send(
                            200,
                            EventKind::PermissionResolved {
                                request_id: perm_id,
                                decision: p_dec,
                            },
                        );
                        send(
                            201,
                            EventKind::InteractionRequested {
                                request_id: interaction_id.clone(),
                                question: "Choose deploy target?".into(),
                                options: vec![
                                    InteractionOption {
                                        id: "prod".into(),
                                        label: "Production".into(),
                                        description: Some("Live users".into()),
                                        kind: None,
                                        warning: Some("Touches production cluster".into()),
                                    },
                                    InteractionOption {
                                        id: "staging".into(),
                                        label: "Staging".into(),
                                        description: None,
                                        kind: None,
                                        warning: None,
                                    },
                                ],
                                allow_custom: true,
                            },
                        );
                        if let Ok(i_dec) = irx.recv_timeout(Duration::from_secs(10)) {
                            send(
                                202,
                                EventKind::InteractionResolved {
                                    request_id: interaction_id,
                                    decision: i_dec,
                                },
                            );
                            send(203, EventKind::TextDelta { text: "deployed".into() });
                            send(
                                204,
                                EventKind::TurnFinished {
                                    reason: StopReason::Completed,
                                    usage: Usage::default(),
                                },
                            );
                        }
                    }
                });
            }
            MockTurn::HoldUntilAbort => {
                let (atx, arx) = flume::bounded(1);
                *self.abort_waiter.lock().unwrap() = Some(atx);
                let subs = self.subs.lock().unwrap().clone();
                std::thread::spawn(move || {
                    if arx.recv_timeout(Duration::from_secs(10)).is_ok() {
                        let ev = Event {
                            seq: 300,
                            agent_path: vec![],
                            at_ms: 1_700_000_000_000,
                            kind: EventKind::TurnFinished {
                                reason: StopReason::Aborted,
                                usage: Usage::default(),
                            },
                        };
                        for s in &subs {
                            let _ = s.send(ev.clone());
                        }
                    }
                });
            }
        }
        Ok(())
    }

    fn steer(&self, content: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
        self.log.lock().unwrap().steers.push(content);
        Ok(())
    }

    fn queue(&self, _content: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
        Ok(())
    }

    fn abort(&self) -> vibevalley_runtime::oar::Result<()> {
        self.log.lock().unwrap().aborts += 1;
        if let Some(tx) = self.abort_waiter.lock().unwrap().take() {
            let _ = tx.send(());
        }
        Ok(())
    }

    fn respond_permission(&self, request_id: &str, decision: PermissionDecision) -> vibevalley_runtime::oar::Result<()> {
        self.log.lock().unwrap().permissions.push((request_id.into(), decision.clone()));
        if let Some((expected, tx)) = self.perm_waiter.lock().unwrap().take()
            && expected == request_id
        {
            let _ = tx.send(decision);
        }
        Ok(())
    }

    fn respond_interaction(&self, request_id: &str, decision: InteractionDecision) -> vibevalley_runtime::oar::Result<()> {
        self.log.lock().unwrap().interactions.push((request_id.into(), decision.clone()));
        if let Some((expected, tx)) = self.inter_waiter.lock().unwrap().take()
            && expected == request_id
        {
            let _ = tx.send(decision);
        }
        Ok(())
    }

    fn set_config(&self, model: Option<&str>, effort: Option<&str>, permission_mode: Option<PermissionMode>) -> vibevalley_runtime::oar::Result<()> {
        self.log
            .lock()
            .unwrap()
            .configs
            .push((model.map(String::from), effort.map(String::from), permission_mode));
        Ok(())
    }

    fn dispose(&self) {
        self.disposed.store(true, Ordering::Relaxed);
        self.emit(EventKind::SessionEnded);
    }
}

fn start_with(home: &Path, runtime: Arc<MockRuntime>) -> Started {
    let mut registry = Registry::new();
    registry.register(runtime);
    vibevalley_server::start(ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        watch_pkm: false,
        orchestrator_listens: false,
        ..ServerConfig::under(home)
    })
    .unwrap()
}

fn recv_until(rx: &flume::Receiver<Value>, what: &str, mut pred: impl FnMut(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "timed out waiting for {what}; seen: {seen:?}");
        if let Ok(val) = rx.recv_timeout(left.min(Duration::from_millis(200))) {
            if pred(&val) {
                return val;
            }
            seen.push(val);
        }
    }
}

#[test]
fn workspace_session_full_lifecycle_permissions_interactions_config_steer_stop_and_resume() {
    vibevalley_i18n::set_locale("zh");
    let home = tempfile::tempdir().unwrap();
    let repo_dir = home.path().join("my-repo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    let cwd = repo_dir.to_string_lossy().into_owned();

    let (rt, log) = MockRuntime::new(
        "antigravity",
        vec![
            MockTurn::EchoUsage(Usage {
                input_tokens: Some(8813),
                output_tokens: Some(84),
                cost_usd: Some(0.01),
                cache_read_tokens: Some(6000),
                cache_write_tokens: Some(400),
                reasoning_tokens: Some(41),
                context_used_tokens: Some(8856),
                context_window_tokens: Some(1_048_576),
            }),
            MockTurn::NeedPermission { request_id: "perm-1".into() },
            MockTurn::BypassPermAndInteraction {
                perm_id: "perm-auto".into(),
                interaction_id: "interaction_1".into(),
            },
            MockTurn::HoldUntilAbort,
        ],
    );
    let server = start_with(home.path(), rt);
    let call = |op: &str, p: Value| server.hub.call_as(Caller::User, op, p);

    // 1. Invalid cwd is refused cleanly.
    let bad = call(
        "session.openWorkspace",
        json!({ "runtime": "antigravity", "cwd": "/nonexistent/vibevalley/path" }),
    );
    assert_eq!(bad.biz_code, BizCode::InvalidInput.code());

    // 2. Open fresh workspace session in `ask` mode.
    let opened = call(
        "session.openWorkspace",
        json!({
            "runtime": "antigravity",
            "cwd": cwd,
            "repo": "my-repo",
            "model": "gemini-4-neon",
            "effort": "medium",
            "permissionMode": "ask",
            "title": "Direct Chat"
        }),
    );
    assert_eq!(opened.biz_code, 0, "{}", opened.message);
    let ws = opened.data.unwrap();
    let sid = ws["id"].as_str().unwrap().to_string();
    assert_eq!(ws["permissionMode"], "ask");
    assert_eq!(ws["model"], "gemini-4-neon");
    assert_eq!(ws["effort"], "medium");
    assert_eq!(ws["session"]["runtime"], "antigravity");
    assert_eq!(ws["session"]["phase"]["_tag"], "resting");

    // Watch must NOT spam the default channel with dispatch messages for workspace sessions.
    let general = server.chat.default_channel();
    let msgs = call("channel.message.list", json!({ "id": general })).data.unwrap();
    assert!(
        msgs.as_array().unwrap().iter().all(|m| m["kind"] != "dispatch"),
        "workspace session must not create channel dispatch threads: {msgs}"
    );

    // 3. Subscribe via `session.watch`.
    let (sub, rx) = server.hub.subscribe("session.watch", json!({ "id": sid })).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(first["kind"], "history");
    let second = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(second["kind"], "state");
    assert_eq!(second["permissionMode"], "ask");

    // 4. Upload an image attachment and send message with contextFiles + attachments.
    let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfake");
    let att = call("attachment.create", json!({ "name": "shot.png", "type": "image/png", "data": png }))
        .data
        .unwrap();
    let att_id = att["id"].as_str().unwrap().to_string();
    let sent = call(
        "session.send",
        json!({
            "id": sid,
            "text": "Inspect README",
            "attachments": [att_id],
            "contextFiles": [{ "path": "README.md", "startLine": 1, "endLine": 20 }]
        }),
    );
    assert_eq!(sent.biz_code, 0, "{}", sent.message);

    // Wait for `llm/usage` event and updated `state` with extended tokens.
    let usage_ev = recv_until(&rx, "llm/usage event", |v| v["kind"] == "event" && v["event"]["type"] == "llm/usage");
    assert_eq!(usage_ev["event"]["tokens"]["input"], 8813);
    assert_eq!(usage_ev["event"]["tokens"]["cacheRead"], 6000);
    assert_eq!(usage_ev["event"]["tokens"]["cacheWrite"], 400);
    assert_eq!(usage_ev["event"]["tokens"]["output"], 84);
    assert_eq!(usage_ev["event"]["tokens"]["reasoning"], 41);
    assert_eq!(usage_ev["event"]["tokens"]["contextUsed"], 8856);
    assert_eq!(usage_ev["event"]["tokens"]["contextWindow"], 1_048_576);

    let done_state = recv_until(&rx, "completed state with tokens", |v| {
        v["kind"] == "state" && v["session"]["runs"] == 1 && v["tokens"].is_object()
    });
    assert_eq!(done_state["tokens"]["reasoning"], 41);

    // Verify `ContentBlock::File` & `ContentBlock::Image` reached the OAR session.
    {
        let l = log.lock().unwrap();
        assert_eq!(l.prompts.len(), 1);
        assert!(matches!(l.prompts[0][0], ContentBlock::Text(_)));
        assert!(matches!(l.prompts[0][1], ContentBlock::File { lines: Some((1, 20)), .. }));
        assert!(matches!(l.prompts[0][2], ContentBlock::Image { .. }));
    }

    // Verify `afterSeq` filtering on a second `session.watch` subscription.
    server.trajectories.flush(true);
    let all_events = call("session.event.list", json!({ "id": sid })).data.unwrap();
    let all_arr = all_events.as_array().unwrap();
    assert!(all_arr.len() >= 3, "{all_events}");
    let cutoff = all_arr[1]["seq"].as_i64().unwrap();
    let (sub2, rx2) = server.hub.subscribe("session.watch", json!({ "id": sid, "afterSeq": cutoff })).unwrap();
    let filtered = rx2.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(filtered["kind"], "history");
    let evs = filtered["events"].as_array().unwrap();
    assert!(!evs.is_empty());
    assert!(evs.iter().all(|e| e["seq"].as_i64().unwrap() > cutoff), "{evs:?}");
    server.hub.unsubscribe(sub2);

    // 5. Permission flow in `ask` mode: waits until `session.respondPermission`.
    let sent2 = call("session.send", json!({ "id": sid, "text": "run ls" }));
    assert_eq!(sent2.biz_code, 0, "{}", sent2.message);
    let perm_state = recv_until(&rx, "pending permission in state", |v| {
        v["kind"] == "state" && v["pendingPermissions"].as_array().is_some_and(|a| a.iter().any(|p| p["requestId"] == "perm-1"))
    });
    assert_eq!(perm_state["pendingPermissions"][0]["tool"], "Bash");
    let perm_reply = call(
        "session.respondPermission",
        json!({ "id": sid, "requestId": "perm-1", "decision": "allowOnce" }),
    );
    assert_eq!(perm_reply.biz_code, 0, "{}", perm_reply.message);
    recv_until(&rx, "turn 2 completed", |v| v["kind"] == "state" && v["session"]["runs"] == 2);

    // 6. Live `session.setConfig` switching to `bypass` mode + `high` effort.
    let cfg = call(
        "session.setConfig",
        json!({ "id": sid, "model": "gemini-4-neon", "effort": "high", "permissionMode": "bypass" }),
    );
    assert_eq!(cfg.biz_code, 0, "{}", cfg.message);
    assert_eq!(cfg.data.unwrap()["permissionMode"], "bypass");
    recv_until(&rx, "state reflects bypass + high", |v| {
        v["kind"] == "state" && v["permissionMode"] == "bypass" && v["effort"] == "high"
    });
    assert_eq!(
        log.lock().unwrap().configs.last(),
        Some(&(Some("gemini-4-neon".into()), Some("high".into()), Some(PermissionMode::Bypass)))
    );

    // 7. In `bypass` mode: `perm-auto` auto-approves, but `interaction_1` MUST STILL WAIT!
    let sent3 = call("session.send", json!({ "id": sid, "text": "deploy" }));
    assert_eq!(sent3.biz_code, 0, "{}", sent3.message);
    let inter_state = recv_until(&rx, "pending interaction even in bypass mode", |v| {
        v["kind"] == "state"
            && v["pendingInteractions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|i| i["requestId"] == "interaction_1"))
    });
    let inter = &inter_state["pendingInteractions"][0];
    assert_eq!(inter["question"], "Choose deploy target?");
    assert_eq!(inter["options"][0]["warning"], "Touches production cluster");
    assert_eq!(inter["allowCustom"], true);

    // Empty interaction response is refused cleanly.
    let bad_inter = call("session.respondInteraction", json!({ "id": sid, "requestId": "interaction_1" }));
    assert_eq!(bad_inter.biz_code, BizCode::InvalidInput.code());

    // Answer the interactive question; turn completes.
    let ok_inter = call(
        "session.respondInteraction",
        json!({ "id": sid, "requestId": "interaction_1", "optionId": "staging" }),
    );
    assert_eq!(ok_inter.biz_code, 0, "{}", ok_inter.message);
    recv_until(&rx, "turn 3 completed", |v| v["kind"] == "state" && v["session"]["runs"] == 3);
    assert!(
        log.lock()
            .unwrap()
            .permissions
            .iter()
            .any(|(id, d)| id == "perm-auto" && *d == PermissionDecision::AllowOnce)
    );
    assert_eq!(
        log.lock().unwrap().interactions.last(),
        Some(&("interaction_1".into(), InteractionDecision::Select { option_id: "staging".into() }))
    );

    // 8. In-turn `steer` when working, followed by `session.stop`.
    let sent4 = call("session.send", json!({ "id": sid, "text": "long task" }));
    assert_eq!(sent4.biz_code, 0, "{}", sent4.message);
    until("workspace session working", || server.board.session(&sid).filter(|s| s.phase.is_working()));
    let steered = call("session.send", json!({ "id": sid, "text": "focus on tests" }));
    assert_eq!(steered.biz_code, 0, "{}", steered.message);
    assert_eq!(log.lock().unwrap().steers.len(), 1);
    let stopped = call("session.stop", json!({ "id": sid }));
    assert_eq!(stopped.biz_code, 0, "{}", stopped.message);
    recv_until(&rx, "turn 4 aborted", |v| {
        v["kind"] == "state" && v["session"]["runs"] == 4 && v["session"]["phase"]["_tag"] == "resting"
    });
    assert_eq!(log.lock().unwrap().aborts, 1);
    server.hub.unsubscribe(sub);

    // 9. Restart server and verify persisted config + history + lazy resume on `session.send`!
    server.close();
    drop(server);

    let (rt2, log2) = MockRuntime::new(
        "antigravity",
        vec![MockTurn::EchoUsage(Usage {
            input_tokens: Some(100),
            output_tokens: Some(20),
            ..Default::default()
        })],
    );
    let reopened = start_with(home.path(), rt2);
    let (sub3, rx3) = reopened.hub.subscribe("session.watch", json!({ "id": sid })).unwrap();
    let hist3 = rx3.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(hist3["kind"], "history");
    assert!(!hist3["events"].as_array().unwrap().is_empty(), "history survives restart");
    let state3 = rx3.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(state3["kind"], "state");
    assert_eq!(state3["permissionMode"], "bypass");
    assert_eq!(state3["effort"], "high");
    assert_eq!(state3["model"], "gemini-4-neon");

    // Sending a message lazily reopens with `resume == Some("agy-vendor-1")`.
    let resumed = reopened
        .hub
        .call_as(Caller::User, "session.send", json!({ "id": sid, "text": "after restart" }));
    assert_eq!(resumed.biz_code, 0, "{}", resumed.message);
    recv_until(&rx3, "resumed turn completes", |v| v["kind"] == "state" && v["session"]["runs"] == 5);
    assert_eq!(log2.lock().unwrap().opened.len(), 1);
    assert_eq!(log2.lock().unwrap().opened[0].resume.as_deref(), Some("agy-vendor-1"));
    assert_eq!(log2.lock().unwrap().opened[0].permission_mode, PermissionMode::Bypass);
    reopened.hub.unsubscribe(sub3);
    reopened.close();
}

#[test]
fn workspace_session_missing_reconnect_custom_cancel_and_board_room_isolation() {
    vibevalley_i18n::set_locale("zh");
    let home = tempfile::tempdir().unwrap();
    let repo_dir = home.path().join("demo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    let cwd = repo_dir.to_string_lossy().into_owned();

    let (rt, log) = MockRuntime::new(
        "antigravity",
        vec![
            MockTurn::BypassPermAndInteraction {
                perm_id: "p-custom".into(),
                interaction_id: "i-custom".into(),
            },
            MockTurn::BypassPermAndInteraction {
                perm_id: "p-cancel".into(),
                interaction_id: "i-cancel".into(),
            },
            MockTurn::HoldUntilAbort,
        ],
    );
    let mut registry = Registry::new();
    registry.register(rt);
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let server = vibevalley_server::start(ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        watch_pkm: false,
        orchestrator_listens: false,
        ..ServerConfig::under(home.path())
    })
    .unwrap();
    let call = |op: &str, p: Value| server.hub.call_as(Caller::User, op, p);

    // Unknown session watch is refused cleanly.
    let missing_watch = server.hub.subscribe("session.watch", json!({ "id": "w999" }));
    assert_eq!(missing_watch.err().unwrap().biz_code, BizCode::SessionNotFound.code());

    // Open in bypass mode and test custom + cancel interaction decisions.
    let opened = call(
        "session.openWorkspace",
        json!({ "runtime": "antigravity", "cwd": cwd, "permissionMode": "bypass" }),
    )
    .data
    .unwrap();
    let sid = opened["id"].as_str().unwrap().to_string();
    let (sub, rx) = server.hub.subscribe("session.watch", json!({ "id": sid })).unwrap();
    let _ = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let _ = rx.recv_timeout(Duration::from_secs(2)).unwrap();

    // Reconnect via `session.openWorkspace` with `sessionId` + config patch.
    let reconnected = call(
        "session.openWorkspace",
        json!({ "sessionId": sid, "runtime": "antigravity", "cwd": cwd, "effort": "low" }),
    );
    assert_eq!(reconnected.biz_code, 0, "{}", reconnected.message);
    assert_eq!(reconnected.data.unwrap()["effort"], "low");

    // Turn 1: custom text reply to `interaction_*`.
    assert_eq!(call("session.send", json!({ "id": sid, "text": "go 1" })).biz_code, 0);
    recv_until(&rx, "i-custom pending", |v| {
        v["kind"] == "state"
            && v["pendingInteractions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|i| i["requestId"] == "i-custom"))
    });
    assert_eq!(
        call(
            "session.respondInteraction",
            json!({ "id": sid, "requestId": "i-custom", "text": "canary region" })
        )
        .biz_code,
        0
    );
    recv_until(&rx, "turn 1 done", |v| v["kind"] == "state" && v["session"]["runs"] == 1);
    assert_eq!(
        log.lock().unwrap().interactions.last(),
        Some(&("i-custom".into(), InteractionDecision::Custom { text: "canary region".into() }))
    );

    // Turn 2: cancel reply to `interaction_*`.
    assert_eq!(call("session.send", json!({ "id": sid, "text": "go 2" })).biz_code, 0);
    recv_until(&rx, "i-cancel pending", |v| {
        v["kind"] == "state"
            && v["pendingInteractions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|i| i["requestId"] == "i-cancel"))
    });
    assert_eq!(
        call("session.respondInteraction", json!({ "id": sid, "requestId": "i-cancel", "cancelled": true })).biz_code,
        0
    );
    recv_until(&rx, "turn 2 done", |v| v["kind"] == "state" && v["session"]["runs"] == 2);
    assert_eq!(log.lock().unwrap().interactions.last(), Some(&("i-cancel".into(), InteractionDecision::Cancel)));

    // Turn 3: hold working while an issue dispatches in the same farm without being blocked.
    assert_eq!(call("session.send", json!({ "id": sid, "text": "hold" })).biz_code, 0);
    until("workspace working", || server.board.session(&sid).filter(|s| s.phase.is_working()));

    let mut helper = server.agents.profiles.install_template("reviewer").unwrap();
    helper.runtime = "scripted".into();
    let helper = server.agents.profiles.save(helper).unwrap();
    assert_eq!(call("repo.create", json!({ "name": "farm" })).biz_code, 0);
    let issue = call("issue.create", json!({ "title": "parallel work", "repo": "farm", "agent": helper.id }))
        .data
        .unwrap();
    let issue_id = issue["id"].as_str().unwrap().to_string();
    assert_eq!(call("issue.status.update", json!({ "id": issue_id, "status": "todo" })).biz_code, 0);
    let worker_sess = until("issue session starts alongside workspace session", || {
        server
            .board
            .read(|s| s.sessions.iter().find(|x| x.issue.as_deref() == Some(issue_id.as_str())).cloned())
    });

    // Opening an issue session as a workspace chat is refused cleanly.
    let wrong = call(
        "session.openWorkspace",
        json!({ "sessionId": worker_sess.id, "runtime": "scripted", "cwd": cwd }),
    );
    assert_eq!(wrong.biz_code, BizCode::SessionRefused.code());

    // Dismissing the workspace session emits `missing` to `session.watch`.
    server
        .board
        .sessions()
        .dismiss(&sid, vibevalley_server::modules::work::workplace::Leave::Keep)
        .unwrap();
    let miss = recv_until(&rx, "missing event after dismiss", |v| v["kind"] == "missing" && v["session"] == sid.as_str());
    assert_eq!(miss["session"], sid.as_str());

    server.hub.unsubscribe(sub);
    server.close();
}
