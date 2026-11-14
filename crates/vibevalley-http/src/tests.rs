use std::io::{BufRead, BufReader};
use std::sync::Arc;

use serde_json::{Value, json};
use vibevalley_bridge::fake::FakeServer;

use super::*;

fn start() -> (Arc<FakeServer>, Listener) {
    let fake = Arc::new(FakeServer::new());
    let listener = serve(fake.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    (fake, listener)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).build().into()
}

fn post(url: &str, body: Value) -> (u16, Value) {
    let mut res = agent().post(url).send_json(body).unwrap();
    let status = res.status().as_u16();
    (status, serde_json::from_str(&res.body_mut().read_to_string().unwrap()).unwrap())
}

#[test]
fn commands_reach_the_server_by_op_name_with_vibevalleys_envelope() {
    let (fake, l) = start();
    fake.respond("issue.list", json!([{ "id": "i1" }]));
    let (status, body) = post(&format!("{}/api/v1/issue/list", l.url()), json!({ "closed": true }));
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "bizCode": 0, "message": "ok", "data": [{ "id": "i1" }] }));
    assert_eq!(fake.calls().last().unwrap(), &("issue.list".to_string(), json!({ "closed": true })));
}

#[test]
fn refusals_carry_their_http_status_and_bad_bodies_are_invalid_input() {
    let (_fake, l) = start();
    let mut res = agent()
        .post(&format!("{}/api/v1/issue/list", l.url()))
        .header("content-type", "application/json")
        .send("{not json")
        .unwrap();
    assert_eq!(res.status().as_u16(), 400);
    let body: Value = serde_json::from_str(&res.body_mut().read_to_string().unwrap()).unwrap();
    assert_eq!(body["bizCode"], 100001);
    let res = agent().get(&format!("{}/api/v1/issue/list", l.url())).call().unwrap();
    assert_eq!(res.status().as_u16(), 405);
    let res = agent().get(&format!("{}/nowhere", l.url())).call().unwrap();
    assert_eq!(res.status().as_u16(), 404);
}

#[test]
fn another_sites_page_is_refused() {
    let (_fake, l) = start();
    let res = agent()
        .post(&format!("{}/api/v1/issue/list", l.url()))
        .header("origin", "http://evil.example")
        .send_json(json!({}))
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let res = agent()
        .post(&format!("{}/api/v1/issue/list", l.url()))
        .header("sec-fetch-site", "cross-site")
        .send_json(json!({}))
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let mut headers = HeaderMap::new();
    headers.insert("host", "192.168.1.5:8787".parse().unwrap());
    assert!(!from_the_farm(&headers));
    headers.insert("host", "localhost:8787".parse().unwrap());
    assert!(from_the_farm(&headers));
    assert!(serve(Arc::new(FakeServer::new()), "0.0.0.0:0".parse().unwrap()).is_err());
}

/// The first `data:` line of an SSE response.
fn first_event(url: &str) -> Value {
    let res = agent().get(url).call().unwrap();
    assert_eq!(res.headers().get("content-type").unwrap().to_str().unwrap(), "text/event-stream");
    let mut reader = BufReader::new(res.into_body().into_reader());
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if let Some(data) = line.strip_prefix("data: ") {
            return serde_json::from_str(data.trim()).unwrap();
        }
    }
}

#[test]
fn state_streams_frames_and_subscriptions_stream_events() {
    let (fake, l) = start();
    let frame = first_event(&format!("{}/api/v1/state", l.url()));
    assert!(frame.is_object(), "{frame}");

    let url = format!("{}/api/v1/subscribe/channel.follow?payload=%7B%22id%22%3A%22c1%22%7D", l.url());
    let reader = std::thread::spawn(move || first_event(&url));
    // Wait for the subscription to be open, then emit into it.
    for _ in 0..200 {
        if fake.subscriber_count() > 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    fake.emit("channel.follow", json!({ "kind": "message", "text": "你好" }));
    assert_eq!(reader.join().unwrap(), json!({ "kind": "message", "text": "你好" }));
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
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    fake.emit("issue.watch", json!({ "_tag": "state" }));
    assert_eq!(reader.join().unwrap(), json!({ "_tag": "state" }));

    struct Refuses;
    impl Server for Refuses {
        fn call(&self, _: &str, _: Value) -> Envelope {
            Envelope::void()
        }
        fn state(&self) -> flume::Receiver<Value> {
            flume::unbounded().1
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
    let mut res = agent().get(&format!("{}/api/v1/issue/watch/nope", l.url())).call().unwrap();
    assert_eq!(res.status().as_u16(), 404);
    assert_eq!(res.body_mut().read_to_string().unwrap(), "");
}

#[test]
fn attachments_are_served_from_the_path_the_server_gives() {
    let (fake, l) = start();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("abc");
    std::fs::write(&file, b"\x89PNG fake").unwrap();
    fake.respond("attachment.file", json!({ "path": file, "type": "image/png", "name": "shot \"1\".png" }));
    let mut res = agent().get(&format!("{}/api/v1/attachment/a1", l.url())).call().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.headers().get("content-type").unwrap(), "image/png");
    assert_eq!(res.headers().get("content-disposition").unwrap(), "inline; filename=\"shot _1_.png\"");
    assert_eq!(res.body_mut().read_to_vec().unwrap(), b"\x89PNG fake");
    assert_eq!(fake.calls().last().unwrap(), &("attachment.file".to_string(), json!({ "id": "a1" })));

    fake.respond("attachment.file", json!({ "path": dir.path().join("gone"), "type": "image/png" }));
    let res = agent().get(&format!("{}/api/v1/attachment/a2", l.url())).call().unwrap();
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
    let mut res = agent().get(&format!("{}/api/v1/artifact/{id}/2?shell=1&theme=dark", l.url())).call().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.headers().get("content-type").unwrap(), "text/html; charset=utf-8");
    assert_eq!(res.headers().get("content-security-policy").unwrap(), "sandbox allow-scripts");
    assert_eq!(res.body_mut().read_to_string().unwrap(), "<h1>hi</h1>");
    assert_eq!(
        fake.calls().last().unwrap(),
        &("artifact.page".to_string(), json!({ "id": id, "version": 2, "shell": true, "theme": "dark" }))
    );

    let calls = fake.calls().len();
    for bad in ["not-an-id/1", &format!("{id}/0"), &format!("{id}/01"), &format!("{id}/x")] {
        let res = agent().get(&format!("{}/api/v1/artifact/{bad}", l.url())).call().unwrap();
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
        ("state", "state"),
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
