//! End-to-end regression suite for Issue #118:
//! - Unified `ParticipantId` (`user:<id>` · `agent:<profile>` · `session:<id>`)
//!   multi-human & multi-agent `@mention` and human-to-human / human-to-agent DM
//! - `HOP_LIMIT` applies ONLY to Agent -> Agent wakes (never human messages or Agent -> Human)
//! - Unified `AgentSession` (`SessionController::Daemon`, `cwd: None`), durable `wakes: false`
//!   `MailboxSource::PassiveContext` drained on next wake across restart, and zero leftover
//!   `orchestrator.*` streaming endpoints.

#![allow(clippy::disallowed_types, reason = "synchronous test barrier for scripted model calls")]

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::{Caller, DEFAULT_ORCHESTRATOR, ORCHESTRATOR_RUNTIME, ParticipantId, SessionController};
use vibevalley_runtime::agent::{ChatRequest, Completion, Delta, FinishReason, Message, ModelClient, Role, Usage};
use vibevalley_server::channel::{Posting, Saying, Seat};
use vibevalley_server::runtime::MailboxSource;

use crate::support::RouterTestExt as _;

struct RecordingModel {
    answers: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<ChatRequest>>,
    changed: Condvar,
}

impl RecordingModel {
    fn new(answers: impl Into<VecDeque<Completion>>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            seen: Mutex::new(vec![]),
            changed: Condvar::new(),
        })
    }

    fn seen_len(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    fn wait_seen(&self, what: &str, mut pred: impl FnMut(&[ChatRequest]) -> bool) -> Vec<ChatRequest> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut guard = self.seen.lock().unwrap();
        loop {
            if pred(&guard) {
                return guard.clone();
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                panic!("waited for {what}; seen={}", guard.len());
            };
            let (next, res) = self.changed.wait_timeout(guard, remaining).unwrap();
            guard = next;
            if res.timed_out() && !pred(&guard) {
                panic!("waited for {what}; seen={}", guard.len());
            }
        }
    }
}

impl ModelClient for RecordingModel {
    fn complete<'a>(
        &'a self,
        request: &'a ChatRequest,
        on: &'a mut (dyn FnMut(Delta) + Send),
    ) -> vibevalley_runtime::BoxFuture<'a, vibevalley_runtime::agent::Result<Completion>> {
        {
            self.seen.lock().unwrap().push(request.clone());
            self.changed.notify_all();
        }
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| say("收到。"));
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
        usage: Usage::default(),
        finish: FinishReason::Stop,
    }
}

fn ok(env: vibevalley_protocol::Envelope) -> Value {
    assert_eq!(env.biz_code, 0, "expected ok, got {} ({})", env.biz_code, env.message);
    env.data.unwrap_or(Value::Null)
}

#[test]
fn multi_human_and_multi_agent_mentions_and_human_dm() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let chat = app.test_internals().channel;
    let call = |op, p| ok(app.router().call_as(Caller::User, op, p));

    let alice = ParticipantId::user("alice");
    let bob = ParticipantId::user("bob");
    vibevalley_runtime::rt::block_on(async {
        chat.ensure_human_async(&alice, "Alice").await.unwrap();
        chat.ensure_human_async(&bob, "Bob").await.unwrap();
    });

    // Public channel: Alice mentions Bob and the daemon orchestrator.
    let room_id = call("channel.create", json!({ "name": "multi-human", "purpose": "test" }))
        .as_str()
        .unwrap()
        .to_owned();
    call(
        "channel.message.send",
        json!({
            "id": room_id,
            "from": alice.to_string(),
            "fromName": "Alice",
            "text": "请 @Bob 和 @助手 看一下",
            "sendKey": "mh-1"
        }),
    );

    let bob_mentions = vibevalley_runtime::rt::block_on(chat.user_mentions_for_async(&bob)).unwrap();
    assert_eq!(bob_mentions.len(), 1, "Bob must receive @mention notification");
    assert_eq!(bob_mentions[0].message.from, alice.to_string());
    let alice_mentions = vibevalley_runtime::rt::block_on(chat.user_mentions_for_async(&alice)).unwrap();
    assert!(alice_mentions.is_empty(), "sender Alice must not be notified for own message");

    // Human-to-human DM via `channel.direct.create` with canonical ParticipantId.
    let dm_id = call("channel.direct.create", json!({ "agent": bob.to_string(), "from": alice.to_string() }))
        .as_str()
        .unwrap()
        .to_owned();
    let dm_again = call("channel.direct.create", json!({ "agent": alice.to_string(), "from": bob.to_string() }))
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(dm_id, dm_again, "human-to-human DM must be canonical and order-independent");

    let mut rx = chat.subscribe_dispatches();
    let (dm_msg, _) = vibevalley_runtime::rt::block_on(chat.say_async(Saying {
        channel: Some(dm_id.clone()),
        from: Some(alice.clone()),
        from_name: Some("Alice".into()),
        text: "私聊同步一下".into(),
        send_key: "dm-h2h-1".into(),
        ..Default::default()
    }))
    .unwrap();
    let dispatched = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap() });
    assert_eq!(dispatched.committed.row.id, dm_msg.id);
    assert!(
        dispatched.deliveries.iter().any(|d| d.recipient == bob && d.wakes),
        "human-to-human DM must plan a waking delivery for Bob: {:?}",
        dispatched.deliveries
    );
    assert!(
        dispatched.deliveries.iter().all(|d| d.recipient != alice),
        "sender must not receive own DM delivery"
    );

    app.close_blocking();
}

#[test]
fn hop_limit_applies_only_to_agent_to_agent_and_never_human() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let app = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let chat = app.test_internals().channel;
    let alice = ParticipantId::user("alice");
    let orch = ParticipantId::agent(DEFAULT_ORCHESTRATOR);
    vibevalley_runtime::rt::block_on(chat.ensure_human_async(&alice, "Alice")).unwrap();

    let room_id = ok(app
        .router()
        .call_as(Caller::User, "channel.create", json!({ "name": "hop-room", "purpose": "hop test" })))
    .as_str()
    .unwrap()
    .to_owned();

    // Seed two worker seats in the channel so Agent -> Agent mentions hit real recipients.
    vibevalley_runtime::rt::block_on(async {
        chat.seat_async(&Seat {
            id: "w1".into(),
            name: "WorkerOne".into(),
            agent: Some("backend".into()),
            home: None,
        })
        .await
        .unwrap();
        chat.seat_async(&Seat {
            id: "w2".into(),
            name: "WorkerTwo".into(),
            agent: Some("reviewer".into()),
            home: None,
        })
        .await
        .unwrap();
    });

    let mut rx = chat.subscribe_dispatches();
    let next_for = |rx: &mut tokio::sync::broadcast::Receiver<vibevalley_server::channel::ChannelDispatched>, msg_id: &str| {
        vibevalley_runtime::rt::block_on(async {
            loop {
                let d = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
                if d.committed.row.id == msg_id {
                    return d.deliveries;
                }
            }
        })
    };

    // 4 consecutive Agent -> Agent mentions wake; the 5th hits HOP_LIMIT (wakes == false).
    for hop in 1..=5 {
        let (from, mention) = if hop % 2 == 1 { ("w1", "@助手") } else { ("w2", "@助手") };
        let (msg, _) = vibevalley_runtime::rt::block_on(chat.post_async(Posting {
            from: from.into(),
            channel: room_id.clone(),
            text: format!("agent hop #{hop} {mention}"),
            ..Default::default()
        }))
        .unwrap();
        let deliveries = next_for(&mut rx, &msg.id);
        let orch_d = deliveries.iter().find(|d| d.recipient == orch).expect("orchestrator delivery planned");
        if hop <= 4 {
            assert!(orch_d.wakes, "hop {hop} within HOP_LIMIT must wake");
        } else {
            assert!(!orch_d.wakes, "hop {hop} past HOP_LIMIT must be held (wakes=false)");
        }
    }

    // Even right after HOP_LIMIT is hit, Agent -> Human @mention must NEVER be blocked!
    let (to_human_msg, _) = vibevalley_runtime::rt::block_on(chat.post_async(Posting {
        from: "w1".into(),
        channel: room_id.clone(),
        text: "请人类介入 @Alice".into(),
        ..Default::default()
    }))
    .unwrap();
    let to_human = next_for(&mut rx, &to_human_msg.id);
    let alice_d = to_human.iter().find(|d| d.recipient == alice).expect("human delivery planned");
    assert!(alice_d.wakes, "Agent -> Human mention must never be blocked by HOP_LIMIT");

    // A Human message ALWAYS wakes Agent AND resets the channel's hop counter!
    let (human_msg, _) = vibevalley_runtime::rt::block_on(chat.say_async(Saying {
        channel: Some(room_id.clone()),
        from: Some(alice.clone()),
        from_name: Some("Alice".into()),
        text: "继续 @助手".into(),
        send_key: "human-reset-1".into(),
        ..Default::default()
    }))
    .unwrap();
    let human_say = next_for(&mut rx, &human_msg.id);
    assert!(
        human_say.iter().any(|d| d.recipient == orch && d.wakes),
        "Human -> Agent message must never be blocked by HOP_LIMIT"
    );

    let (after_reset_msg, _) = vibevalley_runtime::rt::block_on(chat.post_async(Posting {
        from: "w1".into(),
        channel: room_id.clone(),
        text: "reset 后第一跳 @助手".into(),
        ..Default::default()
    }))
    .unwrap();
    let after_reset = next_for(&mut rx, &after_reset_msg.id);
    assert!(
        after_reset.iter().any(|d| d.recipient == orch && d.wakes),
        "Human speech must reset Agent -> Agent hop counter"
    );

    app.close_blocking();
}

#[test]
fn daemon_session_passive_context_mailbox_and_restart_recovery() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let model = RecordingModel::new([say("了解，已结合旁听上下文回复。")]);
    let cfg = vibevalley_server::Config {
        model_client: Some(model.clone()),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: true,
        ..vibevalley_server::Config::under(dir.path())
    };
    let app = vibevalley_server::create_app_blocking(cfg.clone()).unwrap();

    // 1. Verify unified Daemon AgentSession (cwd: None, controller: Daemon) and ZERO removed orchestrator.* endpoints.
    for removed in [
        "orchestrator.open",
        "orchestrator.stop",
        "orchestrator.eval.create",
        "orchestrator.approval.list",
        "orchestrator.approval.resolve",
    ] {
        assert!(!app.router().answers(removed), "removed endpoint {removed} must not be registered");
    }
    let daemon =
        vibevalley_runtime::rt::block_on(app.test_internals().runtime.session_async(DEFAULT_ORCHESTRATOR)).expect("daemon AgentSession must exist on boot");
    assert_eq!(daemon.controller, SessionController::Daemon);
    assert_eq!(daemon.runtime, ORCHESTRATOR_RUNTIME);
    assert!(daemon.cwd.is_none(), "daemon AgentSession must run directoryless (cwd: None)");

    // Unified session.approval.list and session.stop work directly on the daemon session.
    let approvals = ok(app
        .router()
        .call_as(Caller::User, "session.approval.list", json!({ "id": DEFAULT_ORCHESTRATOR })));
    assert_eq!(approvals, json!([]));
    ok(app.router().call_as(Caller::User, "session.stop", json!({ "id": DEFAULT_ORCHESTRATOR })));

    // 2. Send a message addressed to a worker seat (not the orchestrator) in #general where the
    //    orchestrator is a member -> orchestrator receives `wakes: false` durable PassiveContext!
    let gid = app.test_internals().channel.default_channel();
    vibevalley_runtime::rt::block_on(app.test_internals().channel.seat_async(&Seat {
        id: "w9".into(),
        name: "小蓝".into(),
        agent: Some("backend".into()),
        home: None,
    }))
    .unwrap();
    ok(app.router().call_as(
        Caller::User,
        "channel.message.send",
        json!({ "id": gid, "text": "背景信息：预算上限是 4200 元 @w9", "sendKey": "passive-1" }),
    ));

    // Wait until DeliveryRouter settles the `wakes: false` delivery into durable PassiveContext mailbox.
    crate::support::wait_until_settled(Some(app.ctx()), Duration::from_secs(10), "passive context mailbox entry", || {
        let entries = vibevalley_runtime::rt::block_on(app.test_internals().runtime.mailbox_entries_async(DEFAULT_ORCHESTRATOR)).ok()?;
        entries
            .into_iter()
            .find(|e| e.source == MailboxSource::PassiveContext && e.payload.contains("预算上限是 4200 元"))
    });
    assert_eq!(model.seen_len(), 0, "wakes: false passive context must NOT wake the daemon model");

    // 3. Restart the server to verify durable PassiveContext survives crash/restart and is drained
    //    on the very next `wakes: true` turn!
    app.close_blocking();
    let reopened = vibevalley_server::create_app_blocking(cfg).unwrap();
    ok(reopened.router().call_as(
        Caller::User,
        "channel.message.send",
        json!({ "id": gid, "text": "刚才提到的预算上限是多少？", "sendKey": "wake-after-restart-1" }),
    ));
    let seen = model.wait_seen("daemon wakes after restart with drained passive context", |reqs| !reqs.is_empty());
    let prompt_joined: String = seen[0].messages.iter().filter_map(|m| m.content.as_deref()).collect::<Vec<_>>().join("\n");
    assert!(
        prompt_joined.contains("预算上限是 4200 元"),
        "durable wakes: false PassiveContext must be drained into next turn after restart; prompt:\n{prompt_joined}"
    );
    assert!(
        prompt_joined.contains("刚才提到的预算上限是多少？"),
        "waking user message must be present in daemon turn prompt"
    );

    reopened.close_blocking();
}
