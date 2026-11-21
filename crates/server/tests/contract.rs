//! The server as the bridge sees it: envelopes, frames within the 200 ms
//! window, live events and subscriptions.

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_core::empty_space_state;
use vibevalley_protocol::{Caller, Fact, Issue, NoticeLevel, ops, subscriptions};
use vibevalley_server::{Hub, Server, Sink, modules};

fn hub() -> std::sync::Arc<Hub> {
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
fn a_new_state_receiver_gets_the_frame_now_then_one_per_burst() {
    let hub = hub();
    let rx = hub.state();
    assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap()["seq"], 0);
    let start = Instant::now();
    for n in 1..=5 {
        hub.apply(vec![Fact::issue_changed(n, Issue::new(format!("i{n}"), n, "t", n))]);
    }
    let frame = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(start.elapsed() >= Duration::from_millis(190), "a burst waits the window");
    assert_eq!(frame["seq"], 5);
    assert_eq!(frame["state"]["issues"].as_array().unwrap().len(), 5);
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "one frame for the burst");
    // A fact that changes nothing makes no frame.
    hub.apply(vec![Fact::issue_changed(
        1,
        hub.read(|s| s.issues.iter().find(|i| i.id == "i1").unwrap().clone()),
    )]);
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
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
    hub.on_subscription::<subscriptions::ChannelFollow>(|_, payload, sink: Sink| {
        if payload.id == "nope" {
            return Err(vibevalley_protocol::ApiError::new(vibevalley_protocol::BizCode::ChannelNotFound, "no channel"));
        }
        std::thread::spawn(move || {
            let mut n = 0;
            while sink.send(&json!({ "_tag": "Reset", "n": n })) {
                n += 1;
                std::thread::sleep(Duration::from_millis(10));
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
    // The producer stops and drops its sender: the stream ends.
    let deadline = Instant::now() + Duration::from_secs(2);
    while rx.recv_deadline(deadline).is_ok() {}
    assert!(rx.is_disconnected());
}

#[test]
fn regression_slow_workbench_skips_revisions_and_the_farm_and_http_receive_the_ordered_effects() {
    use std::io::{BufRead, BufReader};
    use std::sync::Arc;
    use vibevalley_protocol::{CommitCount, FactProgressChanged};
    use vibevalley_server::transport::bridge::Outlet;

    struct Window(flume::Sender<Value>);
    impl Outlet for Window {
        fn send(&self, name: &str, frame: Value) {
            assert_eq!(name, "frame:state");
            let _ = self.0.send(frame);
        }
    }

    let hub = hub();
    let listener = vibevalley_server::transport::http::serve(hub.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let mut wire = BufReader::new(ureq::get(format!("{}/api/v1/state", listener.url())).call().unwrap().into_body().into_reader());
    let mut public_frame = || loop {
        let mut line = String::new();
        assert_ne!(wire.read_line(&mut line).unwrap(), 0);
        if let Some(data) = line.strip_prefix("data:") {
            break serde_json::from_str::<Value>(data.trim()).unwrap();
        }
    };
    let farm = hub.state();
    assert_eq!(public_frame(), farm.recv().unwrap());
    let bridge = vibevalley_server::transport::bridge::Hub::new(hub.clone(), 1);
    let window = || {
        let (tx, rx) = flume::unbounded();
        let client = bridge.attach(Arc::new(Window(tx)));
        client.watch("state").unwrap();
        (client, move || rx.recv_timeout(Duration::from_secs(2)).unwrap())
    };
    let (fast, next_fast) = window();
    let (slow, next_slow) = window();
    let first_fast = next_fast();
    let first_slow = next_slow();
    fast.applied_workbench(first_fast["rev"].as_u64().unwrap());
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
    assert!(farm.try_recv().is_err());
    fast.applied_workbench(leading["rev"].as_u64().unwrap());
    effects.extend(apply(55).effects);
    effects.extend(apply(110).effects);
    let final_fast = next_fast();
    let final_farm = farm.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(begin.elapsed() >= Duration::from_millis(vibevalley_protocol::STATE_EVERY_MS));
    assert!(!effects.is_empty());
    assert_eq!(final_farm["effects"], serde_json::to_value(effects).unwrap());
    assert_eq!(public_frame(), final_farm);
    assert_eq!(final_fast["data"]["state"], final_farm["state"]);
    assert_eq!(final_fast["data"]["effects"], json!([]));
    slow.applied_workbench(first_slow["rev"].as_u64().unwrap());
    let final_slow = next_slow();
    assert_eq!(final_slow["data"]["seq"], final_fast["data"]["seq"]);
    assert_eq!(final_slow["rev"], 2, "only initial and newest snapshots reach the slow window");
    slow.unwatch("state");
    slow.watch("state").unwrap();
    let reopened = next_slow();
    assert!(reopened["rev"].as_u64() > final_slow["rev"].as_u64());
    slow.applied_workbench(final_slow["rev"].as_u64().unwrap());
    drop(slow);
    fast.applied_workbench(final_fast["rev"].as_u64().unwrap());
    apply(125);
    assert_eq!(next_fast()["data"]["seq"], hub.seq());
}
