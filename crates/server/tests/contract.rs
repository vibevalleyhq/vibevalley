//! The server as the bridge and HTTP door see it: envelopes, per-domain slice
//! feeds, ordered farm effects, live events, subscriptions, and Spine Slots #1/#2/#4.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_core::{SliceMask, Transition, empty_space_state};
use vibevalley_protocol::{Caller, CommitCount, Fact, FactProgressChanged, Issue, NoticeLevel, SliceKind, ops, subscriptions};
use vibevalley_server::transport::api::{CallerContext, CallerPrincipal, ClientIdentity, ClientKind, FaultGate, HostDebugBridge, InvokeObserver};
use vibevalley_server::transport::bridge::Outlet;
use vibevalley_server::{Hub, Server, Sink, modules};

fn hub() -> Arc<Hub> {
    let hub = Hub::new(empty_space_state());
    modules::install(&hub);
    hub
}

#[test]
fn envelopes_are_vibevalleys() {
    let hub = hub();
    let health = serde_json::to_value(hub.call("server.health.get", Value::Null)).unwrap();
    assert_eq!(health["bizCode"], 0);
    assert_eq!(health["message"], "ok");
    assert_eq!(health["data"]["ok"], true);
    assert_eq!(serde_json::to_value(hub.call("no.such.op", json!({}))).unwrap()["bizCode"], 100005);
    // Known to the table, answered by no module yet.
    assert_eq!(serde_json::to_value(hub.call("issue.list", json!({}))).unwrap()["bizCode"], 100009);
}

#[test]
fn input_is_decoded_by_the_endpoints_type() {
    let hub = hub();
    hub.on::<ops::IssueGet>(|_, input| Err(vibevalley_protocol::ApiError::new(vibevalley_protocol::BizCode::IssueNotFound, input.id)));
    let missing = serde_json::to_value(hub.call("issue.get", json!({}))).unwrap();
    assert_eq!(missing["bizCode"], 100001);
    assert!(missing["message"].as_str().unwrap().contains("id"), "{missing}");
    let wrong = serde_json::to_value(hub.call("issue.get", json!({ "id": 3 }))).unwrap();
    assert_eq!(wrong["bizCode"], 100001);
    assert_eq!(wrong["message"].as_str().unwrap().split(':').next(), Some("id"));
    let refused = serde_json::to_value(hub.call("issue.get", json!({ "id": "i9" }))).unwrap();
    assert_eq!(refused, json!({ "bizCode": 300001, "message": "i9" }));
}

#[test]
fn an_endpoint_without_a_result_answers_the_void_envelope_and_null_data_is_kept() {
    let hub = hub();
    hub.on::<ops::IssueDelete>(|_, _| Ok(()));
    hub.on::<ops::IssueConversationGet>(|_, _| Ok(None));
    assert_eq!(
        serde_json::to_value(hub.call("issue.delete", json!({ "id": "i1" }))).unwrap(),
        json!({ "bizCode": 0, "message": "ok" })
    );
    assert_eq!(
        serde_json::to_value(hub.call("issue.conversation.get", json!({ "id": "i1" }))).unwrap(),
        json!({ "bizCode": 0, "message": "ok", "data": null })
    );
}

#[test]
fn callers_are_held_to_can() {
    let hub = hub();
    // server.health.get is for the user and remote callers only.
    let env = serde_json::to_value(hub.call_as(Caller::Session, "server.health.get", Value::Null)).unwrap();
    assert_eq!(env["bizCode"], 200002);
}

#[test]
fn a_new_slice_watcher_gets_current_snapshot_then_coalesced_updates_only_when_dirty() {
    let hub = hub();
    let (stop, stopped) = flume::bounded(0);
    let (tx, rx) = flume::unbounded();
    let h = hub.clone();
    let watch = std::thread::spawn(move || {
        h.watch_slice(SliceKind::Board, None, &stopped, &mut |_seq, val| {
            let _ = tx.send(val.clone());
        });
    });
    assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap()["seq"], 0);
    for n in 1..=5 {
        hub.apply(vec![Fact::issue_changed(n, Issue::new(format!("i{n}"), n, "t", n))]);
    }
    // Wait until seq 5 lands (leading edge may deliver seq 1, trailing edge delivers seq 5).
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut last = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    while last["seq"].as_i64().unwrap_or(0) < 5 && Instant::now() < deadline {
        if let Ok(next) = rx.recv_timeout(Duration::from_millis(300)) {
            last = next;
        }
    }
    assert_eq!(last["seq"], 5);
    assert_eq!(last["issues"].as_array().unwrap().len(), 5);
    assert!(rx.recv_timeout(Duration::from_millis(350)).is_err(), "no extra frame after burst");

    // A fact that changes nothing makes no frame.
    hub.apply(vec![Fact::issue_changed(
        1,
        hub.read(|s| s.issues.iter().find(|i| i.id == "i1").unwrap().clone()),
    )]);
    assert!(rx.recv_timeout(Duration::from_millis(350)).is_err());

    drop(stop);
    watch.join().unwrap();
}

#[test]
fn live_events_reach_every_receiver() {
    let hub = hub();
    let (a, b) = (hub.live(), hub.live());
    hub.notice(NoticeLevel::Info, "hello");
    for rx in [a, b] {
        let e = serde_json::to_value(rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        assert_eq!((e["type"].as_str(), e["text"].as_str()), (Some("notice"), Some("hello")));
    }
}

#[test]
fn subscriptions_send_until_stopped_and_refuse_before_the_first_event() {
    let hub = hub();
    let (step_tx, step_rx) = flume::unbounded::<()>();
    hub.on_subscription::<subscriptions::ChannelFollow>(move |_, payload, sink: Sink| {
        if payload.id == "nope" {
            return Err(vibevalley_protocol::ApiError::new(vibevalley_protocol::BizCode::ChannelNotFound, "no channel"));
        }
        let step_rx = step_rx.clone();
        std::thread::spawn(move || {
            let mut n = 0;
            while sink.send(&json!({ "_tag": "Reset", "n": n })) {
                n += 1;
                if step_rx.recv().is_err() {
                    break;
                }
            }
        });
        Ok(())
    });
    let refused = hub.subscribe("channel.follow", json!({ "id": "nope", "after": 0 })).unwrap_err();
    assert_eq!(serde_json::to_value(refused).unwrap()["bizCode"], 500001);
    let bad = hub.subscribe("channel.follow", json!({ "id": "c1" })).unwrap_err();
    assert_eq!(serde_json::to_value(bad).unwrap()["bizCode"], 100001);
    let (id, rx) = hub.subscribe("channel.follow", json!({ "id": "c1", "after": 0 })).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap()["n"], 0);
    hub.unsubscribe(id);
    let _ = step_tx.send(());
    drop(step_tx);
    let deadline = Instant::now() + Duration::from_secs(2);
    while rx.recv_deadline(deadline).is_ok() {}
    assert!(rx.is_disconnected());
}

#[test]
fn regression_slow_workbench_skips_revisions_and_farm_slice_and_http_receive_ordered_effects() {
    use std::io::{BufRead, BufReader};

    struct Window(flume::Sender<Value>);
    impl Outlet for Window {
        fn send(&self, name: &str, frame: Value) {
            assert_eq!(name, "frame:slice:board");
            let _ = self.0.send(frame);
        }
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let hub = hub();
    let listener = vibevalley_server::transport::http::serve(hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let mut wire = BufReader::new(client.get(format!("{}/api/v1/slice/farm", listener.url())).send().unwrap());
    let mut public_farm = || loop {
        let mut line = String::new();
        assert_ne!(wire.read_line(&mut line).unwrap(), 0);
        if let Some(data) = line.strip_prefix("data:") {
            break serde_json::from_str::<Value>(data.trim()).unwrap();
        }
    };

    let (farm_stop, farm_stopped) = flume::bounded(0);
    let (farm_tx, farm_rx) = flume::unbounded();
    let farm_hub = hub.clone();
    let farm_thread = std::thread::spawn(move || {
        farm_hub.watch_slice(SliceKind::Farm, None, &farm_stopped, &mut |_seq, val| {
            let _ = farm_tx.send(val.clone());
        });
    });
    let initial_farm = farm_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(public_farm(), initial_farm);

    let bridge = vibevalley_server::transport::bridge::Hub::new(hub.clone(), 1);
    let window = |id: &str| {
        let (tx, rx) = flume::unbounded();
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

    let apply = |n| {
        hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
            at: n + 1,
            commits: Some(CommitCount { total: n, repos: vec![] }),
            ..Default::default()
        })])
    };
    let begin = Instant::now();
    let mut effects = apply(20).effects;
    let leading = next_fast();
    assert_eq!(leading["data"]["seq"], hub.seq());
    assert!(farm_rx.try_recv().is_err(), "farm coalesces effects across the 200ms window");
    fast.applied_slice("slice:board", leading["rev"].as_u64().unwrap());
    effects.extend(apply(55).effects);
    effects.extend(apply(110).effects);
    let final_fast = next_fast();
    let final_farm = farm_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(begin.elapsed() >= Duration::from_millis(vibevalley_protocol::STATE_EVERY_MS));
    assert!(!effects.is_empty());
    assert_eq!(final_farm["effects"], serde_json::to_value(&effects).unwrap());
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
    apply(125);
    assert_eq!(next_fast()["data"]["seq"], hub.seq());

    drop(farm_stop);
    farm_thread.join().unwrap();
}

#[test]
fn spine_observer_fault_gate_and_host_debug_bridge_work() {
    #[derive(Default)]
    struct TestObserver {
        starts: Mutex<Vec<(String, Option<ClientKind>, u64)>>,
        ends: Mutex<Vec<(String, u32)>>,
        applies: Mutex<Vec<(i64, SliceMask, usize)>>,
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
        fn on_apply(&self, seq: i64, dirty: SliceMask, transitions: &[Transition], _duration_us: u64) {
            self.applies.lock().unwrap().push((seq, dirty, transitions.len()));
        }
    }

    struct TestFault {
        delay: AtomicU64,
        disconnect: AtomicBool,
        hits: AtomicUsize,
    }
    impl FaultGate for TestFault {
        fn delay_ms(&self, _target: &str) -> u64 {
            self.hits.fetch_add(1, Ordering::Relaxed);
            self.delay.load(Ordering::Relaxed)
        }
        fn should_disconnect(&self, _topic: &str) -> bool {
            self.disconnect.load(Ordering::Relaxed)
        }
    }

    struct TestHostDebug;
    impl HostDebugBridge for TestHostDebug {
        fn snapshot(&self) -> Value {
            json!({ "shell": "ready" })
        }
    }

    let hub = hub();
    assert!(hub.host_debug().is_none());
    hub.attach_host_debug(Some(Arc::new(TestHostDebug)));
    assert_eq!(hub.host_debug().unwrap().snapshot(), json!({ "shell": "ready" }));

    let obs = Arc::new(TestObserver::default());
    hub.attach_observer(Some(obs.clone()));
    let fault = Arc::new(TestFault {
        delay: AtomicU64::new(15),
        disconnect: AtomicBool::new(false),
        hits: AtomicUsize::new(0),
    });
    hub.attach_fault_gate(Some(fault.clone()));

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
    let env = hub.call_with(&ctx, "server.health.get", Value::Null);
    assert_eq!(env.biz_code, 0);
    assert!(t0.elapsed() >= Duration::from_millis(12));
    assert_eq!(fault.hits.load(Ordering::Relaxed), 1);

    hub.apply(vec![Fact::issue_changed(1, Issue::new("i1", 1, "Obs", 1))]);

    assert_eq!(*obs.starts.lock().unwrap(), vec![("server.health.get".into(), Some(ClientKind::DevTools), 99)]);
    assert_eq!(*obs.ends.lock().unwrap(), vec![("server.health.get".into(), 0)]);
    let applies = obs.applies.lock().unwrap();
    assert_eq!(applies.len(), 1);
    assert_eq!(applies[0].0, 1);
    assert!(applies[0].1.contains(SliceMask::BOARD));
    assert_eq!(applies[0].2, 1);

    // Clearing observer & fault gate returns to zero-overhead path.
    hub.attach_observer(None);
    hub.attach_fault_gate(None);
    assert_eq!(hub.call("server.health.get", Value::Null).biz_code, 0);
    assert_eq!(obs.starts.lock().unwrap().len(), 1);
    assert_eq!(fault.hits.load(Ordering::Relaxed), 1);
}
