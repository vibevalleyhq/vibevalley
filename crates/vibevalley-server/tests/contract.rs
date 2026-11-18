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
