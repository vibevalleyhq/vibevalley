//! Channel routing over a scripted session: the issue's thread opens with the
//! dispatch, a comment goes through the thread to the session (👀), a mention
//! in #general wakes it, words around wait in durable `channel_delivery` and
//! show in previews, the report lands in the thread, and a slow session wakeup
//! never blocks `Chat::say` in other channels.

use crate::support::RouterTestExt as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::{Caller, DEFAULT_ORCHESTRATOR, ParticipantId};
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime};
use vibevalley_runtime::oar::{Capabilities, Installation, ModelInfo, Runtime, Session, SessionOptions};

#[test]
fn the_watch_routes_the_chat_to_a_session() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(ScriptedRuntime::demo()));
    let started = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let hub = started.router().clone();
    let chat = started.test_internals().channel.clone();
    let call = |op: &str, p: Value| {
        let e = hub.call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };
    let mut helper = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    let helper = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(helper)).unwrap();
    call("repo.create", json!({ "name": "farm" }));
    let issue = call("issue.create", json!({ "title": "say hello", "repo": "farm", "agent": helper.id }));
    let id = issue["id"].as_str().unwrap().to_string();
    call("issue.status.update", json!({ "id": id, "status": "todo" }));
    let session = crate::support::wait_until_transition(started.ctx(), Duration::from_secs(30), "the session", || {
        crate::support::board_sessions(started.test_internals().board)
            .into_iter()
            .find(|x| x.issue_id() == Some(id.as_str()))
    });
    let runs = |sid: &str| -> usize {
        let events = hub
            .call_as(Caller::User, "session.event.list", json!({ "id": sid }))
            .data
            .unwrap_or(Value::Null);
        events["events"]
            .as_array()
            .map(|a| a.iter().filter(|e| e["type"] == "run/end").count())
            .unwrap_or(0)
    };
    crate::support::wait_until_live(started.ctx(), Duration::from_secs(30), "the first run to end", || {
        (runs(&session.id) >= 1).then_some(())
    });

    // The thread hangs under the dispatch in #general; the session is seated there.
    let thread = crate::support::wait_until_channel_event(&chat, Duration::from_secs(30), "the issue's thread", || chat.issue_thread_id(&id));
    assert_eq!(chat.home_of(&session.id).as_deref(), Some(thread.as_str()));
    let general = chat.default_channel();
    let said = call("channel.message.list", json!({ "id": general }));
    let dispatch = said
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "dispatch")
        .unwrap_or_else(|| panic!("{said}"));
    assert!(dispatch["text"].as_str().unwrap().contains(&format!("@{}", session.id)), "{dispatch}");
    let thread_id = Some(thread.clone());
    assert_eq!(call("issue.conversation.get", json!({ "id": id })).as_str(), thread_id.as_deref());

    // The report lands in the thread from the session.
    crate::support::wait_until_channel_event(&chat, Duration::from_secs(30), "the report", || {
        let rows = vibevalley_runtime::rt::block_on(chat.issue_messages_async(&id)).ok()?;
        rows.iter().any(|m| m.from == session.id).then_some(())
    });

    // A comment is said in the thread and delivered asynchronously to the session: a new round, 👀 on it.
    call("issue.comment.create", json!({ "id": id, "text": "再说一遍" }));
    let rows = vibevalley_runtime::rt::block_on(chat.issue_messages_async(&id)).unwrap();
    let mine = rows.iter().rev().find(|m| m.text == "再说一遍").unwrap_or_else(|| panic!("{rows:?}"));
    crate::support::wait_until_channel_event(&chat, Duration::from_secs(30), "👀 on the comment", || {
        let seen = call("channel.message.list", json!({ "id": thread }));
        let mine_now = seen.as_array()?.iter().find(|m| m["id"] == mine.id.as_str())?;
        mine_now["reactions"].to_string().contains(&session.id).then_some(())
    });
    crate::support::wait_until_live(started.ctx(), Duration::from_secs(30), "the second run to end", || {
        (runs(&session.id) >= 2).then_some(())
    });

    // Words around in #general wait in SQLite `channel_delivery` for the session's next wake.
    call("channel.message.send", json!({ "id": general, "text": "大家好", "sendKey": "around" }));
    let listed = call("channel.message.list", json!({ "id": general }));
    let around_id = listed.as_array().unwrap().iter().find(|m| m["text"] == "大家好").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Wait until the orchestrator settles its own delivery so only the session's passive delivery stays pending.
    crate::support::wait_until_settled(Some(started.ctx()), Duration::from_secs(30), "1 pending delivery on ambient message", || {
        let preview = call("channel.message.previewDelete", json!({ "id": around_id }));
        preview["does"].to_string().contains("1 份不再送").then_some(())
    });

    // A mention wakes it, with the words that waited.
    call(
        "channel.message.send",
        json!({ "id": general, "text": format!("@{} 看一下", session.id), "sendKey": "named" }),
    );
    crate::support::wait_until_live(started.ctx(), Duration::from_secs(30), "the third run to end", || {
        (runs(&session.id) >= 3).then_some(())
    });
    let events = call("session.event.list", json!({ "id": session.id }));
    let asked = events.to_string();
    assert!(asked.contains("[输入] 有 2 条给你的新消息"), "{asked}");
    crate::support::wait_until_settled(Some(started.ctx()), Duration::from_secs(30), "ambient delivery settled", || {
        let preview = call("channel.message.previewDelete", json!({ "id": around_id }));
        (preview["does"].as_array()?.len() == 1).then_some(())
    });
    started.close_blocking();
}

struct BlockingRuntime {
    id: String,
    entered: tokio::sync::mpsc::Sender<()>,
    release: Arc<tokio::sync::Mutex<tokio::sync::mpsc::Receiver<()>>>,
}

impl Runtime for BlockingRuntime {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        "Blocking Test"
    }

    fn capabilities(&self) -> Capabilities {
        ScriptedRuntime::new(&self.id, Script::new()).capabilities()
    }

    fn installation(&self) -> vibevalley_runtime::oar::BoxFuture<'_, Installation> {
        Box::pin(async {
            Installation::Available {
                version: None,
                path: PathBuf::from("(blocking-test)"),
            }
        })
    }

    fn list_models(&self) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
        Box::pin(async { Ok(vec![]) })
    }

    fn open(&self, opts: SessionOptions) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn Session>>> {
        Box::pin(async move {
            let _ = self.entered.send(()).await;
            let mut rx = self.release.lock().await;
            let _ = tokio::time::timeout(Duration::from_secs(15), rx.recv()).await;
            drop(rx);
            ScriptedRuntime::demo().open(opts).await
        })
    }
}

#[test]
fn regression_slow_session_wakeup_does_not_block_chat_say_in_other_channels() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel::<()>(4);
    let (release_tx, release_rx) = tokio::sync::mpsc::channel::<()>(4);
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(BlockingRuntime {
        id: "blocking".into(),
        entered: entered_tx,
        release: Arc::new(tokio::sync::Mutex::new(release_rx)),
    }));
    let started = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let hub = started.router().clone();
    let call = |op: &str, p: Value| {
        let e = hub.call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };

    let mut helper = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "blocking".into();
    helper.name = "慢速帮手".into();
    vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(helper)).unwrap();
    let direct = call("channel.direct.create", json!({ "agent": "慢速帮手" })).as_str().unwrap().to_string();
    let other = call("channel.create", json!({ "name": "other" })).as_str().unwrap().to_string();

    // Sending to the slow direct channel must return immediately without waiting for `runtime.open`.
    let started_at = Instant::now();
    call("channel.message.send", json!({ "id": direct, "text": "开始干活", "sendKey": "slow-1" }));
    assert!(
        started_at.elapsed() < Duration::from_secs(1),
        "Chat::say blocked on slow direct wakeup: {:?}",
        started_at.elapsed()
    );
    vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(5), entered_rx.recv()).await })
        .ok()
        .flatten()
        .expect("direct talk lane entered BlockingRuntime::open");

    // While `BlockingRuntime::open` is actively blocked, writing in `#other` returns immediately.
    let other_at = Instant::now();
    call("channel.message.send", json!({ "id": other, "text": "另一个频道不阻塞", "sendKey": "fast-1" }));
    assert!(
        other_at.elapsed() < Duration::from_secs(1),
        "Chat::say in another channel was blocked by slow runtime.open: {:?}",
        other_at.elapsed()
    );
    let msgs = call("channel.message.list", json!({ "id": other }));
    let fast_msg = msgs.as_array().unwrap().iter().find(|m| m["text"] == "另一个频道不阻塞").unwrap();
    let fast_id = fast_msg["id"].as_str().unwrap().to_string();

    // Deleting a message withdraws its pending deliveries immediately.
    let orch_pid = ParticipantId::agent(DEFAULT_ORCHESTRATOR);
    assert!(
        vibevalley_runtime::rt::block_on(started.test_internals().channel.pending_deliveries_all_async())
            .unwrap()
            .iter()
            .any(|d| d.recipient == orch_pid && d.message_id == fast_id)
    );
    call("channel.message.delete", json!({ "id": fast_id }));
    assert!(
        !vibevalley_runtime::rt::block_on(started.test_internals().channel.pending_deliveries_all_async())
            .unwrap()
            .iter()
            .any(|d| d.recipient == orch_pid && d.message_id == fast_id)
    );

    // Unblock `runtime.open` and verify the direct-channel talk settles and reports cleanly.
    let _ = release_tx.try_send(());
    crate::support::wait_until_channel_event(started.test_internals().channel, Duration::from_secs(30), "direct talk report landed", || {
        let rows = call("channel.message.list", json!({ "id": direct }));
        rows.as_array()?.iter().any(|m| m["kind"] == "report").then_some(())
    });
    assert!(
        vibevalley_runtime::rt::block_on(started.test_internals().channel.pending_deliveries_all_async())
            .unwrap()
            .iter()
            .all(|d| d.channel_id != direct)
    );
    started.close_blocking();
}

struct ResumableTalkRuntime {
    id: String,
    inner: ScriptedRuntime,
    resumes: Arc<std::sync::Mutex<Vec<Option<String>>>>,
}

impl Runtime for ResumableTalkRuntime {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        "Resumable Talk Test"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            resume: true,
            ..self.inner.capabilities()
        }
    }

    fn installation(&self) -> vibevalley_runtime::oar::BoxFuture<'_, Installation> {
        self.inner.installation()
    }

    fn list_models(&self) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Vec<ModelInfo>>> {
        self.inner.list_models()
    }

    fn open(&self, mut opts: SessionOptions) -> vibevalley_runtime::oar::BoxFuture<'_, vibevalley_runtime::oar::Result<Arc<dyn Session>>> {
        self.resumes.lock().unwrap().push(opts.resume.clone());
        opts.resume = None;
        self.inner.open(opts)
    }
}

#[test]
fn pr2_direct_talk_reopen_passes_resume() {
    use vibevalley_runtime::oar::scripted::Step as ScriptStep;

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let resumes = Arc::new(std::sync::Mutex::new(Vec::new()));

    let open_server = |resumes: Arc<std::sync::Mutex<Vec<Option<String>>>>, reply: &str| {
        let mut registry = vibevalley_runtime::oar::Registry::new();
        registry.register(Arc::new(ResumableTalkRuntime {
            id: "resumable".into(),
            inner: ScriptedRuntime::new("resumable", Script::new().turn(vec![ScriptStep::text(reply)])),
            resumes,
        }));
        vibevalley_server::create_app_blocking(vibevalley_server::Config {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            link_previews: false,
            tick_crons: false,
            orchestrator_listens: false,
            ..vibevalley_server::Config::under(dir.path())
        })
        .unwrap()
    };

    let s1 = open_server(resumes.clone(), "round-1");
    let mut helper = vibevalley_runtime::rt::block_on(s1.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "resumable".into();
    helper.name = "接续帮手".into();
    let helper = vibevalley_runtime::rt::block_on(s1.test_internals().agent.profile.store.save_async(helper)).unwrap();
    let direct = s1
        .router()
        .call_as(Caller::User, "channel.direct.create", json!({ "agent": "接续帮手" }))
        .data
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();

    s1.router()
        .call_as(Caller::User, "channel.message.send", json!({ "id": direct, "text": "第一轮", "sendKey": "t1" }));
    crate::support::wait_until_channel_event(s1.test_internals().channel, Duration::from_secs(30), "first direct talk report", || {
        let rows = s1.router().call_as(Caller::User, "channel.message.list", json!({ "id": direct })).data?;
        rows.as_array()?.iter().any(|m| m["kind"] == "report" && m["text"] == "round-1").then_some(())
    });
    let session = vibevalley_runtime::rt::block_on(s1.test_internals().runtime.session_engine().talker_async(&helper.id, &direct)).expect("talker session");
    assert_eq!(resumes.lock().unwrap().as_slice(), &[None]);
    s1.close_blocking();
    drop(s1);

    // Reopen server so live process map is empty and `talk` must call `open_talk` with `resume`.
    let s2 = open_server(resumes.clone(), "round-2");
    s2.router()
        .call_as(Caller::User, "channel.message.send", json!({ "id": direct, "text": "第二轮", "sendKey": "t2" }));
    crate::support::wait_until_channel_event(s2.test_internals().channel, Duration::from_secs(30), "second direct talk report", || {
        let rows = s2.router().call_as(Caller::User, "channel.message.list", json!({ "id": direct })).data?;
        rows.as_array()?.iter().any(|m| m["kind"] == "report" && m["text"] == "round-2").then_some(())
    });
    let recorded = resumes.lock().unwrap();
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0], None);
    assert!(
        recorded[1].as_deref().is_some_and(|v| v.starts_with("scripted-")),
        "expected non-empty resume id for {}, got {:?}",
        session.id,
        *recorded
    );
    s2.close_blocking();
}

#[test]
fn pr2_deleted_channel_message_withdraws_pending_mailbox_before_claim() {
    use vibevalley_server::runtime::MailboxStatus;

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel::<()>(4);
    let (release_tx, release_rx) = tokio::sync::mpsc::channel::<()>(4);
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(BlockingRuntime {
        id: "blocking".into(),
        entered: entered_tx,
        release: Arc::new(tokio::sync::Mutex::new(release_rx)),
    }));
    let started = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let call = |op: &str, p: Value| {
        let e = started.router().call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };

    let mut helper = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "blocking".into();
    helper.name = "信箱帮手".into();
    let helper = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(helper)).unwrap();
    let direct = call("channel.direct.create", json!({ "agent": "信箱帮手" })).as_str().unwrap().to_string();

    // First message enters BlockingRuntime::open so the lane thread is busy before second is claimed.
    call("channel.message.send", json!({ "id": direct, "text": "第一条", "sendKey": "mb-1" }));
    vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(5), entered_rx.recv()).await })
        .ok()
        .flatten()
        .unwrap();

    call("channel.message.send", json!({ "id": direct, "text": "撤回这条", "sendKey": "mb-2" }));
    let msgs = call("channel.message.list", json!({ "id": direct }));
    let msg2_id = msgs.as_array().unwrap().iter().find(|m| m["text"] == "撤回这条").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let owner = format!("agent:{}", helper.id);
    crate::support::wait_until_settled(Some(started.ctx()), Duration::from_secs(30), "second message queued in mailbox", || {
        let entries = vibevalley_runtime::rt::block_on(started.test_internals().runtime.mailbox_entries_async(&owner)).ok()?;
        entries.into_iter().find(|e| e.payload == "撤回这条" && e.status == MailboxStatus::Pending)
    });

    call("channel.message.delete", json!({ "id": msg2_id }));
    crate::support::wait_until_settled(
        Some(started.ctx()),
        Duration::from_secs(30),
        "deleted channel message withdraws pending mailbox entry",
        || {
            let entries = vibevalley_runtime::rt::block_on(started.test_internals().runtime.mailbox_entries_async(&owner)).ok()?;
            entries.into_iter().find(|e| e.payload == "撤回这条" && e.status == MailboxStatus::Withdrawn)
        },
    );

    // Release BlockingRuntime so the first delivery finishes and the withdrawn second message is skipped.
    let _ = release_tx.try_send(());
    let _ = release_tx.try_send(());
    crate::support::wait_until_settled(
        Some(started.ctx()),
        Duration::from_secs(30),
        "first direct talk report landed and all deliveries cleared",
        || {
            let rows = call("channel.message.list", json!({ "id": direct }));
            let reports = rows.as_array()?.iter().filter(|m| m["kind"] == "report").count();
            let pending = vibevalley_runtime::rt::block_on(started.test_internals().channel.pending_deliveries_all_async()).ok()?;
            (reports == 1 && pending.iter().all(|d| d.channel_id != direct)).then_some(())
        },
    );
    let entries = vibevalley_runtime::rt::block_on(started.test_internals().runtime.mailbox_entries_async(&owner)).unwrap();
    assert_eq!(entries.iter().find(|e| e.payload == "撤回这条").unwrap().status, MailboxStatus::Withdrawn);
    started.close_blocking();
}

#[test]
fn regression_channel_delete_withdraws_pending_mailbox_by_source_message_across_direct_issue_and_orchestrator() {
    use vibevalley_server::runtime::{MailboxSource, MailboxStatus};

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(ScriptedRuntime::demo()));
    let started = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let call = |op: &str, p: Value| {
        let e = started.router().call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };

    let general = started.test_internals().channel.default_channel();
    call(
        "channel.message.send",
        json!({ "id": general, "text": "待撤回消息", "sendKey": "multi-withdraw" }),
    );
    let msgs = call("channel.message.list", json!({ "id": general }));
    let msg_id = msgs.as_array().unwrap().iter().find(|m| m["text"] == "待撤回消息").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let runtime = started.test_internals().runtime;
    vibevalley_runtime::rt::block_on(runtime.enqueue_mailbox_async(
        "agent:direct-1",
        "direct:direct-1:msg",
        MailboxSource::ChannelDirect,
        Some(&msg_id),
        "待撤回消息",
    ))
    .unwrap();
    vibevalley_runtime::rt::block_on(runtime.enqueue_mailbox_async("issue:42", "issue:42:msg", MailboxSource::IssueComment, Some(&msg_id), "待撤回消息"))
        .unwrap();
    vibevalley_runtime::rt::block_on(runtime.enqueue_mailbox_async(
        "orchestrator",
        "orchestrator:orchestrator:msg",
        MailboxSource::ChannelOrchestrator,
        Some(&msg_id),
        "待撤回消息",
    ))
    .unwrap();

    call("channel.message.delete", json!({ "id": msg_id }));
    crate::support::wait_until_settled(
        Some(started.ctx()),
        Duration::from_secs(30),
        "all three pending mailbox rows withdrawn by source_message_id",
        || {
            let direct_w = vibevalley_runtime::rt::block_on(runtime.mailbox_entries_async("agent:direct-1"))
                .ok()?
                .iter()
                .any(|e| e.status == MailboxStatus::Withdrawn);
            let issue_w = vibevalley_runtime::rt::block_on(runtime.mailbox_entries_async("issue:42"))
                .ok()?
                .iter()
                .any(|e| e.status == MailboxStatus::Withdrawn);
            let orch_w = vibevalley_runtime::rt::block_on(runtime.mailbox_entries_async("orchestrator"))
                .ok()?
                .iter()
                .any(|e| e.status == MailboxStatus::Withdrawn);
            (direct_w && issue_w && orch_w).then_some(())
        },
    );
    started.close_blocking();
}

#[test]
fn regression_issue_comment_clears_asking_in_board_slice_before_returning() {
    use vibevalley_protocol::{BoardSlice, InboxKind, InboxSlice, IssueStageKind, IssueStatus, SliceKind};
    use vibevalley_runtime::oar::scripted::Step as ScriptStep;

    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let script = Script::new()
        .turn(vec![ScriptStep::text("Ask the user: Which port? (options: 8797 | 8080)\n")])
        .turn(vec![ScriptStep::text("Configured port 8797.")]);
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(ScriptedRuntime::new("scripted", script)));
    let started = vibevalley_server::create_app_blocking(vibevalley_server::Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        link_previews: false,
        tick_crons: false,
        orchestrator_listens: false,
        ..vibevalley_server::Config::under(dir.path())
    })
    .unwrap();
    let hub = started.router().clone();
    let call = |op: &str, p: Value| {
        let e = hub.call_as(Caller::User, op, p);
        assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
        e.data.unwrap_or(Value::Null)
    };
    let board_slice = || -> BoardSlice {
        vibevalley_runtime::rt::block_on(started.ctx().feed.flush());
        serde_json::from_str(&started.ctx().feed.snapshot_json(SliceKind::Board)).unwrap()
    };
    let inbox_slice = || -> InboxSlice {
        vibevalley_runtime::rt::block_on(started.ctx().feed.flush());
        serde_json::from_str(&started.ctx().feed.snapshot_json(SliceKind::Inbox)).unwrap()
    };

    let mut helper = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
    helper.runtime = "scripted".into();
    let helper = vibevalley_runtime::rt::block_on(started.test_internals().agent.profile.store.save_async(helper)).unwrap();
    call("repo.create", json!({ "name": "clock" }));
    let issue = call("issue.create", json!({ "title": "Pick port", "repo": "clock", "agent": helper.id }));
    let id = issue["id"].as_str().unwrap().to_string();
    call("issue.status.update", json!({ "id": id, "status": "todo" }));

    crate::support::wait_until_transition(started.ctx(), Duration::from_secs(30), "issue reaches asking stage", || {
        let board = board_slice();
        let item = board.issues.iter().find(|i| i.id == id)?;
        (item.status == IssueStatus::InProgress && item.stage.state == IssueStageKind::Asking).then_some(())
    });
    assert!(inbox_slice().items.iter().any(|item| item.kind == InboxKind::Ask));

    // Record every post-Asking board state transition while answering so we
    // verify there is no spurious intermediate `InReview` flicker.
    let states = Arc::new(std::sync::Mutex::new(Vec::<(IssueStatus, IssueStageKind)>::new()));
    let states_sub = states.clone();
    let id_sub = id.clone();
    let mut board_sub = started.ctx().feed.subscribe(SliceKind::Board);
    let mut prev: Option<(IssueStatus, IssueStageKind)> = {
        let frame = board_sub.borrow_and_update(false);
        serde_json::from_str::<BoardSlice>(&frame.json)
            .ok()
            .and_then(|b| b.issues.into_iter().find(|i| i.id == id_sub).map(|i| (i.status, i.stage.state)))
    };
    started.ctx().spawn("test-asking-transition", async move {
        while board_sub.changed().await {
            let frame = board_sub.borrow_and_update(false);
            if let Ok(b) = serde_json::from_str::<BoardSlice>(&frame.json)
                && let Some(item) = b.issues.into_iter().find(|i| i.id == id_sub)
            {
                let next = (item.status, item.stage.state);
                if prev != Some(next) {
                    prev = Some(next);
                    states_sub.lock().unwrap().push(next);
                }
            }
        }
    });

    call("issue.comment.create", json!({ "id": id, "text": "用 8797" }));

    // Immediately on return (no polling): BoardSlice must no longer be `Asking`
    // and InboxSlice must have dropped the `Ask` item.
    let board_now = board_slice();
    let item_now = board_now.issues.iter().find(|i| i.id == id).expect("issue present");
    assert!(item_now.questions.is_empty(), "questions still present: {:?}", item_now.questions);
    assert_ne!(item_now.stage.state, IssueStageKind::Asking, "still Asking immediately after comment");
    assert!(!inbox_slice().items.iter().any(|item| item.kind == InboxKind::Ask));

    crate::support::wait_until_transition(started.ctx(), Duration::from_secs(30), "second round settles in_review", || {
        let board = board_slice();
        let item = board.issues.iter().find(|i| i.id == id)?;
        (item.status == IssueStatus::InReview && item.stage.state == IssueStageKind::Reviewing).then_some(())
    });

    // The very first transition after answering must enter `Working`, never `InReview`.
    let seen = states.lock().unwrap();
    assert!(
        seen.first().is_some_and(|&(s, k)| s == IssueStatus::InProgress && k == IssueStageKind::Working),
        "expected first transition after comment to be (InProgress, Working), saw: {:?}",
        *seen
    );
    started.close_blocking();
}
