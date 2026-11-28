//! The server as the bridge and HTTP door see it: envelopes, per-domain slice
//! feeds, ordered farm effects, live events, subscriptions, and Spine hooks.

use crate::support::{RouterTestExt as _, ServerTestExt as _};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_core::SliceMask;
use vibevalley_protocol::{Caller, CommitCount, GameEffect, GameEffectReward, NoticeLevel, SliceKind};
use vibevalley_server::context::LiveState;
use vibevalley_server::gateway::api::{CallerContext, CallerPrincipal, ClientIdentity, ClientKind, HostDebugBridge, InvokeObserver, Server};
use vibevalley_server::gateway::bridge::Outlet;
use vibevalley_server::{App, Config, create_app_blocking};

fn app(dir: &std::path::Path) -> App {
    create_app_blocking(Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..Config::under(dir)
    })
    .unwrap()
}

#[test]
fn envelopes_are_vibevalleys() {
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    let router = started.router();
    let health = serde_json::to_value(router.call("server.health.get", Value::Null)).unwrap();
    assert_eq!(health["bizCode"], 0);
    assert_eq!(health["message"], "ok");
    assert_eq!(health["data"]["ok"], true);
    assert_eq!(serde_json::to_value(router.call("no.such.op", json!({}))).unwrap()["bizCode"], 100005);
    assert_eq!(serde_json::to_value(router.call("issue.list", json!({}))).unwrap()["bizCode"], 0);
    started.close_blocking();
}

#[test]
fn input_is_decoded_by_the_endpoints_type() {
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    let router = started.router();
    let missing = serde_json::to_value(router.call("issue.get", json!({}))).unwrap();
    assert_eq!(missing["bizCode"], 100001);
    assert!(missing["message"].as_str().unwrap().contains("id"), "{missing}");
    let wrong = serde_json::to_value(router.call("issue.get", json!({ "id": 3 }))).unwrap();
    assert_eq!(wrong["bizCode"], 100001);
    assert_eq!(wrong["message"].as_str().unwrap().split(':').next(), Some("id"));
    let refused = serde_json::to_value(router.call("issue.get", json!({ "id": "i9" }))).unwrap();
    assert_eq!(refused["bizCode"], 300001);
    assert!(!refused["message"].as_str().unwrap().is_empty());
    started.close_blocking();
}

#[test]
fn an_endpoint_without_a_result_answers_the_void_envelope_and_null_data_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    let router = started.router();
    let created = router.call("issue.create", json!({ "title": "Void envelope check" }));
    assert_eq!(created.biz_code, 0, "{}", created.message);
    let id = created.data.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(
        serde_json::to_value(router.call("issue.conversation.get", json!({ "id": id }))).unwrap(),
        json!({ "bizCode": 0, "message": "ok", "data": null })
    );
    assert_eq!(
        serde_json::to_value(router.call("issue.delete", json!({ "id": id }))).unwrap(),
        json!({ "bizCode": 0, "message": "ok" })
    );
    started.close_blocking();
}

#[test]
fn callers_are_held_to_can() {
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    // server.health.get is for the user and remote callers only.
    let env = serde_json::to_value(started.router().call_as(Caller::Session, "server.health.get", Value::Null)).unwrap();
    assert_eq!(env["bizCode"], 200002);
    started.close_blocking();
}

#[test]
fn a_new_slice_watcher_gets_current_snapshot_then_coalesced_updates_only_when_dirty() {
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    let stop = tokio_util::sync::CancellationToken::new();
    let stopped = stop.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let server = started.server();
    let watch = std::thread::spawn(move || {
        server.watch_slice(SliceKind::Board, None, &stopped, &mut |_seq, val| {
            let _ = tx.send(val.clone());
        });
    });
    let initial = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let base_seq = initial["seq"].as_i64().unwrap();
    assert!(base_seq >= 1);

    vibevalley_runtime::rt::block_on(async {
        let issues: Vec<_> = (1..=5).map(|n| vibevalley_protocol::Issue::new(format!("i{n}"), n, "t", n)).collect();
        started.test_internals().service.seed_for_test(&issues, &[]).await.unwrap();
    });
    started.ctx().mark_dirty(SliceMask::BOARD);

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut last = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    while last["issues"].as_array().map_or(0, Vec::len) < 5 && Instant::now() < deadline {
        if let Ok(next) = rx.recv_timeout(Duration::from_millis(300)) {
            last = next;
        }
    }
    assert!(last["seq"].as_i64().unwrap() > base_seq);
    assert_eq!(last["issues"].as_array().unwrap().len(), 5);
    assert!(rx.recv_timeout(Duration::from_millis(350)).is_err(), "no extra frame after burst");

    // Marking an unrelated slice dirty makes no extra Board frame.
    started.ctx().mark_dirty(SliceMask::OPS);
    assert!(rx.recv_timeout(Duration::from_millis(350)).is_err());

    stop.cancel();
    watch.join().unwrap();
    started.close_blocking();
}

#[test]
fn live_events_reach_every_receiver() {
    let live = LiveState::new();
    let (mut a, mut b) = (live.subscribe_live(), live.subscribe_live());
    live.publish_notice(0, NoticeLevel::Info, "hello");
    for rx in [&mut a, &mut b] {
        let ev = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap() });
        let e = serde_json::to_value(ev).unwrap();
        assert_eq!((e["type"].as_str(), e["text"].as_str()), (Some("notice"), Some("hello")));
    }
}

#[test]
fn subscriptions_send_until_stopped_and_refuse_before_the_first_event() {
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    let router = started.router();
    let general = started.test_internals().channel.default_channel();

    let refused = router.subscribe("channel.follow", json!({ "id": "nope", "after": 0 })).unwrap_err();
    assert_eq!(serde_json::to_value(refused).unwrap()["bizCode"], 500001);
    let bad = router.subscribe("channel.follow", json!({ "id": "c1" })).unwrap_err();
    assert_eq!(serde_json::to_value(bad).unwrap()["bizCode"], 100001);
    let (id, mut rx) = router.subscribe("channel.follow", json!({ "id": general, "after": 0 })).unwrap();
    let sent = router.call_as(Caller::User, "channel.message.send", json!({ "id": general, "text": "hi" }));
    assert_eq!(sent.biz_code, 0, "{}", sent.message);
    let first = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(2), rx.recv()).await })
        .unwrap()
        .unwrap();
    assert_eq!(first["_tag"], "Message");
    router.unsubscribe(id);
    let ended = vibevalley_runtime::rt::block_on(async { tokio::time::timeout(Duration::from_secs(2), async { while rx.recv().await.is_some() {} }).await });
    assert!(ended.is_ok());
    assert!(rx.is_closed());
    started.close_blocking();
}

#[test]
fn regression_slow_workbench_skips_revisions_and_farm_slice_and_http_receive_ordered_effects() {
    use std::io::{BufRead, BufReader};

    struct Window(std::sync::mpsc::Sender<Value>);
    impl Outlet for Window {
        fn send(&self, name: &str, frame: Value) {
            assert_eq!(name, "frame:slice:board");
            let _ = self.0.send(frame);
        }
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let started = app(dir.path());
    let listener = vibevalley_server::gateway::http::serve(started.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let mut wire = BufReader::new(client.get(format!("{}/api/v1/slice/farm", listener.url())).send().unwrap());
    let mut public_farm = || loop {
        let mut line = String::new();
        assert_ne!(wire.read_line(&mut line).unwrap(), 0);
        if let Some(data) = line.strip_prefix("data:") {
            break serde_json::from_str::<Value>(data.trim()).unwrap();
        }
    };

    let farm_stop = tokio_util::sync::CancellationToken::new();
    let farm_stopped = farm_stop.clone();
    let (farm_tx, farm_rx) = std::sync::mpsc::channel();
    let farm_server = started.server();
    let farm_thread = std::thread::spawn(move || {
        farm_server.watch_slice(SliceKind::Farm, None, &farm_stopped, &mut |_seq, val| {
            let _ = farm_tx.send(val.clone());
        });
    });
    let initial_farm = farm_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(public_farm(), initial_farm);

    let bridge = vibevalley_server::gateway::bridge::Bridge::new(started.server(), 1);
    let window = |id: &str| {
        let (tx, rx) = std::sync::mpsc::channel();
        let identity = ClientIdentity {
            id: id.into(),
            kind: ClientKind::GpuiWorkbench,
            label: id.into(),
        };
        let client = bridge.attach(identity, Arc::new(Window(tx)));
        client.watch("slice:board").unwrap();
        (client, move || rx.recv_timeout(Duration::from_secs(2)).unwrap())
    };
    let (fast, next_fast) = window("fast");
    let (slow, next_slow) = window("slow");
    let first_fast = next_fast();
    let first_slow = next_slow();
    fast.applied_slice("slice:board", first_fast["rev"].as_u64().unwrap());

    let push_update = |n: i64| {
        let eff = GameEffect::Reward(GameEffectReward {
            session_id: None,
            coins: n,
            streak: 1,
        });
        started.ctx().live.push_farm_effect(eff.clone());
        started.ctx().live.set_commits(Some(CommitCount { total: n, repos: vec![] }));
        started.ctx().mark_dirty(SliceMask::BOARD | SliceMask::FARM);
        eff
    };
    let begin = Instant::now();
    let mut effects = vec![serde_json::to_value(push_update(20)).unwrap()];
    let leading = next_fast();
    assert_eq!(leading["data"]["commits"]["total"], 20);
    assert!(farm_rx.try_recv().is_err(), "farm coalesces effects across the 200ms window");
    fast.applied_slice("slice:board", leading["rev"].as_u64().unwrap());
    effects.push(serde_json::to_value(push_update(55)).unwrap());
    effects.push(serde_json::to_value(push_update(110)).unwrap());
    let final_fast = next_fast();
    let final_farm = farm_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(begin.elapsed() >= Duration::from_millis(vibevalley_protocol::STATE_EVERY_MS));
    assert_eq!(final_farm["effects"], Value::Array(effects));
    assert_eq!(public_farm(), final_farm);
    assert_eq!(final_fast["data"]["commits"]["total"], 110);
    assert!(final_fast["data"].get("effects").is_none(), "board slice carries no game effects");

    slow.applied_slice("slice:board", first_slow["rev"].as_u64().unwrap());
    let final_slow = next_slow();
    assert_eq!(final_slow["data"]["seq"], final_fast["data"]["seq"]);
    assert_eq!(final_slow["rev"], 2, "only initial and newest snapshots reach the slow window");

    slow.unwatch("slice:board");
    slow.watch("slice:board").unwrap();
    let reopened = next_slow();
    assert!(reopened["rev"].as_u64() > final_slow["rev"].as_u64());
    slow.applied_slice("slice:board", final_slow["rev"].as_u64().unwrap());
    drop(slow);
    fast.applied_slice("slice:board", final_fast["rev"].as_u64().unwrap());
    push_update(125);
    let updated_fast = next_fast();
    assert_eq!(updated_fast["data"]["commits"]["total"], 125);

    farm_stop.cancel();
    farm_thread.join().unwrap();
    drop(listener);
    started.close_blocking();
}

#[test]
fn spine_observer_fault_gate_and_host_debug_bridge_work() {
    #[derive(Default)]
    struct TestObserver {
        starts: Mutex<Vec<(String, Option<ClientKind>, u64)>>,
        ends: Mutex<Vec<(String, u32)>>,
    }
    impl InvokeObserver for TestObserver {
        fn on_call_start(&self, ctx: &CallerContext, op: &str, _payload: &Value) {
            self.starts
                .lock()
                .unwrap()
                .push((op.to_string(), ctx.client.as_ref().map(|c| c.kind), ctx.trace_id));
        }
        fn on_call_end(&self, _ctx: &CallerContext, op: &str, biz_code: u32, _duration_us: u64) {
            self.ends.lock().unwrap().push((op.to_string(), biz_code));
        }
        fn on_apply(&self, _seq: i64, _dirty: vibevalley_core::SliceMask, _transitions: &[vibevalley_core::Transition], _duration_us: u64) {}
    }

    struct TestHostDebug;
    impl HostDebugBridge for TestHostDebug {
        fn snapshot_json(&self) -> String {
            json!({ "shell": "ready" }).to_string()
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let obs = Arc::new(TestObserver::default());
    let started = create_app_blocking(Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        debug_enabled: true,
        host_debug: Some(Arc::new(TestHostDebug)),
        invoke_observer: Some(obs.clone()),
        ..Config::under(dir.path())
    })
    .unwrap();
    let router = started.router();
    assert_eq!(
        serde_json::from_str::<Value>(&router.host_debug().unwrap().snapshot_json()).unwrap(),
        json!({ "shell": "ready" })
    );

    let set_override = router.call_as(Caller::User, "debug.override.set", json!({ "rpcDelayMs": 15, "sliceDelayMs": 0 }));
    assert_eq!(set_override.biz_code, 0, "{}", set_override.message);

    let ctx = CallerContext {
        caller: Caller::User,
        principal: CallerPrincipal::LocalOwner,
        client: Some(ClientIdentity {
            id: "dev-1".into(),
            kind: ClientKind::DevTools,
            label: "DevTools".into(),
        }),
        trace_id: 99,
    };
    let t0 = Instant::now();
    let env = router.call_with(&ctx, "server.health.get", Value::Null);
    assert_eq!(env.biz_code, 0);
    assert!(t0.elapsed() >= Duration::from_millis(12));

    let starts = obs.starts.lock().unwrap();
    let ends = obs.ends.lock().unwrap();
    assert!(starts.contains(&("server.health.get".into(), Some(ClientKind::DevTools), 99)));
    assert!(ends.contains(&("server.health.get".into(), 0)));
    started.close_blocking();
}
