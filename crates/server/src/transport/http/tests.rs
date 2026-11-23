use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::time::Duration;

use crate::transport::bridge::fake::{FakeServer, empty_bundle};
use serde_json::{Value, json};
use vibevalley_protocol::{Issue, SliceKind};

use super::*;

fn start() -> (Arc<FakeServer>, Listener) {
    let fake = Arc::new(FakeServer::new());
    let listener = serve(fake.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    (fake, listener)
}

fn agent() -> reqwest::blocking::Client {
    crate::install_tls();
    reqwest::blocking::Client::builder().no_proxy().build().unwrap()
}

fn post(url: &str, body: Value) -> (u16, Value) {
    let res = agent().post(url).json(&body).send().unwrap();
    let status = res.status().as_u16();
    (status, serde_json::from_str(&res.text().unwrap()).unwrap())
}

#[test]
fn commands_reach_the_server_by_op_name_with_vibevalleys_envelope() {
    let (fake, l) = start();
    fake.respond("issue.list", json!([{ "id": "i1" }]));
    let (status, body) = post(&format!("{}/api/v1/issue/list", l.url()), json!({ "closed": true }));
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "bizCode": 0, "message": "ok", "data": [{ "id": "i1" }] }));
    assert_eq!(fake.calls().last().unwrap(), &("issue.list".to_string(), json!({ "closed": true })));
    assert_eq!(fake.last_client().map(|c| c.kind), Some(ClientKind::HttpLoopback));
}

#[test]
fn refusals_carry_their_http_status_and_bad_bodies_are_invalid_input() {
    let (_fake, l) = start();
    let res = agent()
        .post(format!("{}/api/v1/issue/list", l.url()))
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 400);
    let body: Value = serde_json::from_str(&res.text().unwrap()).unwrap();
    assert_eq!(body["bizCode"], 100001);
    let res = agent().get(format!("{}/api/v1/issue/list", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 405);
    let res = agent().get(format!("{}/api/v1/state", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 405, "/api/v1/state GET must be removed");
    let res = agent().get(format!("{}/chord/ws", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 404, "/chord/ws must be removed");
    let res = agent().get(format!("{}/nowhere", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 404);
}

#[test]
fn another_sites_page_is_refused() {
    let (_fake, l) = start();
    let res = agent()
        .post(format!("{}/api/v1/issue/list", l.url()))
        .header("origin", "http://evil.example")
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let res = agent()
        .post(format!("{}/api/v1/issue/list", l.url()))
        .header("sec-fetch-site", "cross-site")
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let mut headers = HeaderMap::new();
    headers.insert("host", "192.168.1.5:8787".parse().unwrap());
    assert!(!from_the_farm(&headers));
    headers.insert("host", "localhost:8787".parse().unwrap());
    assert!(from_the_farm(&headers));
    assert!(serve(Arc::new(FakeServer::new()), "0.0.0.0:0".parse().unwrap()).is_err());
}

/// The first SSE event `(id, data)`.
fn first_event_with_id(url: &str, extra_header: Option<(&str, &str)>) -> (Option<String>, Value) {
    let mut req = agent().get(url);
    if let Some((k, v)) = extra_header {
        req = req.header(k, v);
    }
    let res = req.send().unwrap();
    assert_eq!(res.headers().get("content-type").unwrap().to_str().unwrap(), "text/event-stream");
    let mut reader = BufReader::new(res);
    let mut line = String::new();
    let mut id = None;
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if let Some(raw_id) = line.strip_prefix("id:") {
            id = Some(raw_id.trim().to_string());
        } else if let Some(data) = line.strip_prefix("data:") {
            return (id, serde_json::from_str(data.trim()).unwrap());
        }
    }
}

fn first_event(url: &str) -> Value {
    first_event_with_id(url, None).1
}

#[test]
fn slice_endpoint_serves_json_snapshots_sse_with_ids_and_resume() {
    let (fake, l) = start();
    // 1. Unknown slice -> 404
    let res = agent().get(format!("{}/api/v1/slice/unknown?once=1", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 404);

    // 2. ?once=1 returns JSON snapshot directly
    let res = agent().get(format!("{}/api/v1/slice/board?once=1", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert!(res.headers().get("content-type").unwrap().to_str().unwrap().contains("application/json"));
    let snap: Value = serde_json::from_str(&res.text().unwrap()).unwrap();
    assert_eq!(snap["seq"], 0);
    assert!(snap["issues"].is_array());

    // 3. Accept: application/json returns JSON snapshot directly
    let res = agent()
        .get(format!("{}/api/v1/slice/inbox", l.url()))
        .header("accept", "application/json")
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let inbox_snap: Value = serde_json::from_str(&res.text().unwrap()).unwrap();
    assert_eq!(inbox_snap["seq"], 0);
    assert!(inbox_snap["items"].is_array());

    // 4. Default GET streams SSE with `id: <seq>` and `data: <json>`
    let (id, frame) = first_event_with_id(&format!("{}/api/v1/slice/board", l.url()), None);
    assert_eq!(id.as_deref(), Some("0"));
    assert_eq!(frame["seq"], 0);

    // 5. Last-Event-ID / ?after= skips matching initial seq and delivers the next update
    let url = format!("{}/api/v1/slice/board", l.url());
    let reader = std::thread::spawn(move || first_event_with_id(&url, Some(("Last-Event-ID", "0"))));
    for _ in 0..200 {
        if fake.slice_watchers(SliceKind::Board) > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut next = empty_bundle(3);
    next.board.issues.push(Issue::new("i3", 3, "Resumed", 3));
    fake.swap_bundle(next);
    let (resumed_id, resumed) = reader.join().unwrap();
    assert_eq!(resumed_id.as_deref(), Some("3"));
    assert_eq!(resumed["seq"], 3);
    assert_eq!(resumed["issues"][0]["id"], "i3");

    // 6. Subscriptions still stream events
    let sub_url = format!("{}/api/v1/subscribe/channel.follow?payload=%7B%22id%22%3A%22c1%22%7D", l.url());
    let sub_reader = std::thread::spawn(move || first_event(&sub_url));
    for _ in 0..200 {
        if fake.subscriber_count() > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    fake.emit("channel.follow", json!({ "kind": "message", "text": "你好" }));
    assert_eq!(sub_reader.join().unwrap(), json!({ "kind": "message", "text": "你好" }));
}

#[test]
fn issue_watch_streams_the_subscription_and_refusals_are_an_empty_404() {
    let (fake, l) = start();
    let url = format!("{}/api/v1/issue/watch/i7", l.url());
    let reader = std::thread::spawn(move || first_event(&url));
    for _ in 0..200 {
        if fake.subscriber_count() > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    fake.emit("issue.watch", json!({ "_tag": "state" }));
    assert_eq!(reader.join().unwrap(), json!({ "_tag": "state" }));

    struct Refuses;
    impl Server for Refuses {
        fn call(&self, _: &str, _: Value) -> Envelope {
            Envelope::void()
        }
        fn slice_snapshot(&self, _: SliceKind) -> Value {
            json!({ "seq": 0 })
        }
        fn watch_slice(&self, _: SliceKind, _: Option<i64>, stop: &flume::Receiver<()>, _: &mut dyn FnMut(i64, &Value)) {
            let _ = stop.recv();
        }
        fn live(&self) -> flume::Receiver<vibevalley_protocol::LiveEvent> {
            flume::unbounded().1
        }
        fn subscribe(&self, _: &str, _: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
            Err(Envelope::failure(&ApiError::new(BizCode::IssueNotFound, "no such issue")))
        }
        fn unsubscribe(&self, _: u64) {}
    }
    let l = serve(Arc::new(Refuses), "127.0.0.1:0".parse().unwrap()).unwrap();
    let res = agent().get(format!("{}/api/v1/issue/watch/nope", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 404);
    assert_eq!(res.text().unwrap(), "");
}

#[test]
fn attachments_are_served_from_the_path_the_server_gives() {
    let (fake, l) = start();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("abc");
    std::fs::write(&file, b"\x89PNG fake").unwrap();
    fake.respond("attachment.file", json!({ "path": file, "type": "image/png", "name": "shot \"1\".png" }));
    let res = agent().get(format!("{}/api/v1/attachment/a1", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.headers().get("content-type").unwrap(), "image/png");
    assert_eq!(res.headers().get("content-disposition").unwrap(), "inline; filename=\"shot _1_.png\"");
    assert_eq!(res.bytes().unwrap().as_ref(), b"\x89PNG fake");
    assert_eq!(fake.calls().last().unwrap(), &("attachment.file".to_string(), json!({ "id": "a1" })));

    fake.respond("attachment.file", json!({ "path": dir.path().join("gone"), "type": "image/png" }));
    let res = agent().get(format!("{}/api/v1/attachment/a2", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 404);
}

#[test]
fn artifact_pages_carry_the_servers_headers_and_bad_ids_are_404() {
    let (fake, l) = start();
    let id = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
    fake.respond(
        "artifact.page",
        json!({ "content": "<h1>hi</h1>", "headers": { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox allow-scripts" } }),
    );
    let res = agent().get(format!("{}/api/v1/artifact/{id}/2?shell=1&theme=dark", l.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.headers().get("content-type").unwrap(), "text/html; charset=utf-8");
    assert_eq!(res.headers().get("content-security-policy").unwrap(), "sandbox allow-scripts");
    assert_eq!(res.text().unwrap(), "<h1>hi</h1>");
    assert_eq!(
        fake.calls().last().unwrap(),
        &("artifact.page".to_string(), json!({ "id": id, "version": 2, "shell": true, "theme": "dark" }))
    );

    let calls = fake.calls().len();
    for bad in ["not-an-id/1", &format!("{id}/0"), &format!("{id}/01"), &format!("{id}/x")] {
        let res = agent().get(format!("{}/api/v1/artifact/{bad}", l.url())).send().unwrap();
        assert_eq!(res.status().as_u16(), 404, "{bad}");
    }
    assert_eq!(fake.calls().len(), calls, "a bad id never reaches the server");
}

#[test]
fn ops_shaped_like_get_routes_still_reach_the_server() {
    let (fake, l) = start();
    for (path, op) in [
        ("attachment/create", "attachment.create"),
        ("artifact/block/list", "artifact.block.list"),
        ("artifact/suggestion/accept", "artifact.suggestion.accept"),
        ("issue/watch/x", "issue.watch.x"),
        ("subscribe/thing", "subscribe.thing"),
        ("slice/board", "slice.board"),
        ("events", "events"),
    ] {
        fake.respond(op, json!({ "ok": op }));
        let (status, body) = post(&format!("{}/api/v1/{path}", l.url()), json!({ "a": 1 }));
        assert_eq!(status, 200, "{path}");
        assert_eq!(body["data"], json!({ "ok": op }), "{path}");
        assert_eq!(fake.calls().last().unwrap(), &(op.to_string(), json!({ "a": 1 })), "{path}");
    }
}

#[test]
fn regression_native_file_operations_never_reach_the_server_over_http() {
    let (fake, listener) = start();
    for endpoint in vibevalley_protocol::NATIVE_ENDPOINTS {
        let path = endpoint.op.replace('.', "/");
        let (status, _) = post(&format!("{}/api/v1/{path}", listener.url()), json!({"id":"input","path":"/tmp/private"}));
        assert_eq!(status, 404, "{}", endpoint.op);
    }
    assert!(fake.calls().is_empty());
}

#[test]
fn events_aliases_live_sse_stream() {
    struct LiveOnly(flume::Receiver<vibevalley_protocol::LiveEvent>);
    impl Server for LiveOnly {
        fn call(&self, _: &str, _: Value) -> Envelope {
            Envelope::void()
        }
        fn slice_snapshot(&self, _: SliceKind) -> Value {
            json!({ "seq": 0 })
        }
        fn watch_slice(&self, _: SliceKind, _: Option<i64>, stop: &flume::Receiver<()>, _: &mut dyn FnMut(i64, &Value)) {
            let _ = stop.recv();
        }
        fn live(&self) -> flume::Receiver<vibevalley_protocol::LiveEvent> {
            self.0.clone()
        }
        fn subscribe(&self, _: &str, _: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
            Err(Envelope::failure(&ApiError::new(BizCode::RouteNotFound, "no subscription")))
        }
        fn unsubscribe(&self, _: u64) {}
    }
    let (tx, rx) = flume::unbounded();
    let listener = serve(Arc::new(LiveOnly(rx)), "127.0.0.1:0".parse().unwrap()).unwrap();
    tx.send(vibevalley_protocol::LiveEvent::Notice(vibevalley_protocol::LiveEventNotice {
        level: vibevalley_protocol::NoticeLevel::Info,
        text: "ready".into(),
        at: 1,
    }))
    .unwrap();
    let event = first_event(&format!("{}/api/v1/events", listener.url()));
    assert_eq!(event["text"], "ready");
}

#[test]
fn loopback_and_artifact_route_validators_match_exact_ascii_rules() {
    for good in ["127.0.0.1", "127.0.0.1:8787", "localhost", "localhost:3000", "[::1]", "[::1]:8787"] {
        assert!(is_loopback(good), "{good}");
    }
    for bad in [
        "",
        "127.0.0.1:",
        "127.0.0.1:abc",
        "127.0.0.1.evil.com",
        "localhost.evil",
        "[::1]:",
        "0.0.0.0:8787",
    ] {
        assert!(!is_loopback(bad), "{bad}");
    }

    assert!(is_artifact_id("0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3f"));
    assert!(!is_artifact_id("0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3"));
    assert!(!is_artifact_id("0196F8E2-7c0a-7f10-8b2d-9e5a4c1d2e3f"));
    assert!(!is_artifact_id("0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3g"));

    for good in ["1", "2", "10", "987654321"] {
        assert!(is_artifact_version(good), "{good}");
    }
    for bad in ["", "0", "01", "-1", "1a", "+1"] {
        assert!(!is_artifact_version(bad), "{bad}");
    }
}
