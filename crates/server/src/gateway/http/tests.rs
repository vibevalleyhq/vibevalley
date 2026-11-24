use std::io::{BufRead, BufReader, Read};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::io::{StreamReader, SyncIoBridge};
use vibevalley_protocol::{Issue, SCOPE_REMOTE_CLIENT, SCOPE_REMOTE_MACHINE, SliceKind};

use crate::context::SliceSubscription;
use crate::gateway::api::{BoxFuture, ClientKind, GatewayPorts, RemoteAuth, RemoteDeviceIdentity};
use crate::gateway::bridge::fake::{FakeServer, empty_bundle};

use super::auth::is_loopback;
use super::*;

fn start() -> (Arc<FakeServer>, Listener) {
    let fake = Arc::new(FakeServer::new());
    let listener = serve(fake.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    (fake, listener)
}

fn agent() -> reqwest::blocking::Client {
    crate::context::install_tls();
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

struct SignaledFake {
    inner: Arc<FakeServer>,
    on_watch: tokio::sync::Notify,
    on_subscribe: tokio::sync::Notify,
}

impl SignaledFake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(FakeServer::new()),
            on_watch: tokio::sync::Notify::new(),
            on_subscribe: tokio::sync::Notify::new(),
        })
    }

    fn wait_slice_watcher(&self, slice: SliceKind) {
        vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let notified = self.on_watch.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if self.inner.slice_watchers(slice) > 0 {
                        return;
                    }
                    notified.await;
                }
            })
            .await
        })
        .expect("slice watcher attached");
    }

    fn wait_subscriber(&self) {
        vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let notified = self.on_subscribe.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if self.inner.subscriber_count() > 0 {
                        return;
                    }
                    notified.await;
                }
            })
            .await
        })
        .expect("subscriber attached");
    }
}

impl Server for SignaledFake {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.inner.call(op, payload)
    }
    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        self.inner.call_with(ctx, op, payload)
    }
    fn slice_snapshot(&self, slice: SliceKind) -> Value {
        self.inner.slice_snapshot(slice)
    }
    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &tokio_util::sync::CancellationToken, receive: &mut dyn FnMut(i64, &Value)) {
        self.on_watch.notify_waiters();
        self.inner.watch_slice(slice, after_seq, stop, receive)
    }
    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        let sub = self.inner.subscribe_slice(slice);
        self.on_watch.notify_waiters();
        sub
    }
    fn live(&self) -> tokio::sync::mpsc::UnboundedReceiver<vibevalley_protocol::LiveEvent> {
        self.inner.live()
    }
    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<vibevalley_protocol::LiveEvent>> {
        self.inner.subscribe_live()
    }
    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
        let res = self.inner.subscribe(name, payload);
        self.on_subscribe.notify_waiters();
        res
    }
    fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
        let res = self.inner.subscribe_with(ctx, name, payload);
        self.on_subscribe.notify_waiters();
        res
    }
    fn unsubscribe(&self, id: u64) {
        self.inner.unsubscribe(id)
    }
}

fn start_signaled() -> (Arc<SignaledFake>, Listener) {
    let fake = SignaledFake::new();
    let listener = serve(fake.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    (fake, listener)
}

#[test]
fn slice_endpoint_serves_json_snapshots_sse_with_ids_and_resume() {
    let (fake, l) = start_signaled();
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
    fake.wait_slice_watcher(SliceKind::Board);
    let mut next = empty_bundle(3);
    next.board.issues.push(Issue::new("i3", 3, "Resumed", 3));
    fake.inner.swap_bundle(next);
    let (resumed_id, resumed) = reader.join().unwrap();
    assert_eq!(resumed_id.as_deref(), Some("3"));
    assert_eq!(resumed["seq"], 3);
    assert_eq!(resumed["issues"][0]["id"], "i3");

    // 6. Subscriptions still stream events
    let sub_url = format!("{}/api/v1/subscribe/channel.follow?payload=%7B%22id%22%3A%22c1%22%7D", l.url());
    let sub_reader = std::thread::spawn(move || first_event(&sub_url));
    fake.wait_subscriber();
    fake.inner.emit("channel.follow", json!({ "kind": "message", "text": "你好" }));
    assert_eq!(sub_reader.join().unwrap(), json!({ "kind": "message", "text": "你好" }));
}

#[test]
fn issue_watch_streams_the_subscription_and_refusals_are_an_empty_404() {
    let (fake, l) = start_signaled();
    let url = format!("{}/api/v1/issue/watch/i7", l.url());
    let reader = std::thread::spawn(move || first_event(&url));
    fake.wait_subscriber();
    fake.inner.emit("issue.watch", json!({ "_tag": "state" }));
    assert_eq!(reader.join().unwrap(), json!({ "_tag": "state" }));

    struct Refuses;
    impl Server for Refuses {
        fn call(&self, _: &str, _: Value) -> Envelope {
            Envelope::void()
        }
        fn slice_snapshot(&self, _: SliceKind) -> Value {
            json!({ "seq": 0 })
        }
        fn watch_slice(&self, _: SliceKind, _: Option<i64>, stop: &tokio_util::sync::CancellationToken, _: &mut dyn FnMut(i64, &Value)) {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let stop = stop.clone();
            vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
                stop.cancelled().await;
                drop(tx);
            });
            let _ = rx.recv();
        }
        fn live(&self) -> tokio::sync::mpsc::UnboundedReceiver<vibevalley_protocol::LiveEvent> {
            tokio::sync::mpsc::unbounded_channel().1
        }
        fn subscribe(&self, _: &str, _: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
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
fn ops_shaped_like_get_routes_still_reach_the_server() {
    let (fake, l) = start();
    for (path, op) in [
        ("attachment/create", "attachment.create"),
        ("artifact/file/list", "artifact.file.list"),
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
    struct LiveOnly(parking_lot::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<vibevalley_protocol::LiveEvent>>>);
    impl Server for LiveOnly {
        fn call(&self, _: &str, _: Value) -> Envelope {
            Envelope::void()
        }
        fn slice_snapshot(&self, _: SliceKind) -> Value {
            json!({ "seq": 0 })
        }
        fn watch_slice(&self, _: SliceKind, _: Option<i64>, stop: &tokio_util::sync::CancellationToken, _: &mut dyn FnMut(i64, &Value)) {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let stop = stop.clone();
            vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
                stop.cancelled().await;
                drop(tx);
            });
            let _ = rx.recv();
        }
        fn live(&self) -> tokio::sync::mpsc::UnboundedReceiver<vibevalley_protocol::LiveEvent> {
            self.0.lock().take().unwrap_or_else(|| tokio::sync::mpsc::unbounded_channel().1)
        }
        fn subscribe(&self, _: &str, _: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
            Err(Envelope::failure(&ApiError::new(BizCode::RouteNotFound, "no subscription")))
        }
        fn unsubscribe(&self, _: u64) {}
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let listener = serve(Arc::new(LiveOnly(parking_lot::Mutex::new(Some(rx)))), "127.0.0.1:0".parse().unwrap()).unwrap();
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
}

struct StaticRemoteAuth {
    enabled: bool,
    valid_token: &'static str,
    scope: &'static str,
}

impl RemoteAuth for StaticRemoteAuth {
    fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn verify_bearer_async(self: Arc<Self>, token: String) -> BoxFuture<'static, Result<RemoteDeviceIdentity, ApiError>> {
        Box::pin(async move {
            if token == self.valid_token {
                Ok(RemoteDeviceIdentity {
                    device_id: "dev_1".into(),
                    name: "Test Phone".into(),
                    scope: self.scope.into(),
                })
            } else {
                Err(ApiError::new(BizCode::Unauthorized, "invalid bearer"))
            }
        })
    }
}

struct WithRemoteAuth {
    inner: Arc<FakeServer>,
    auth: Arc<dyn RemoteAuth>,
}

impl Server for WithRemoteAuth {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.inner.call(op, payload)
    }
    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        self.inner.call_with(ctx, op, payload)
    }
    fn slice_snapshot(&self, kind: SliceKind) -> Value {
        self.inner.slice_snapshot(kind)
    }
    fn watch_slice(&self, kind: SliceKind, after_seq: Option<i64>, stop: &tokio_util::sync::CancellationToken, emit: &mut dyn FnMut(i64, &Value)) {
        self.inner.watch_slice(kind, after_seq, stop, emit)
    }
    fn live(&self) -> tokio::sync::mpsc::UnboundedReceiver<vibevalley_protocol::LiveEvent> {
        self.inner.live()
    }
    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, tokio::sync::mpsc::UnboundedReceiver<Value>), Envelope> {
        self.inner.subscribe(name, payload)
    }
    fn unsubscribe(&self, id: u64) {
        self.inner.unsubscribe(id)
    }
    fn ports(&self) -> GatewayPorts {
        GatewayPorts {
            remote: Some(self.auth.clone()),
            ..Default::default()
        }
    }
}

#[test]
fn auth_extractors_enforce_authenticated_query_local_only_and_local_only_status() {
    let fake = Arc::new(FakeServer::new());
    let dir = tempfile::tempdir().unwrap();
    let att_file = dir.path().join("hello.txt");
    std::fs::write(&att_file, b"hello attachment").unwrap();
    fake.respond("attachment.file", json!({ "path": att_file, "type": "text/plain", "name": "hello.txt" }));
    fake.respond("issue.list", json!([]));
    fake.respond("remote.pair.exchange", json!({ "paired": true }));

    let remote_server: Shared = Arc::new(WithRemoteAuth {
        inner: fake.clone(),
        auth: Arc::new(StaticRemoteAuth {
            enabled: true,
            valid_token: "vv_dev_good",
            scope: SCOPE_REMOTE_CLIENT,
        }),
    });
    let remote = serve_remote(remote_server.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let local = serve(remote_server, "127.0.0.1:0".parse().unwrap()).unwrap();

    // Authenticated: remote listener rejects missing token (403), rejects bad token (401), allows valid Bearer (200) and pairing exchange (200).
    let (st, body) = post(&format!("{}/api/v1/issue/list", remote.url()), json!({}));
    assert_eq!(st, 403);
    assert_eq!(body["bizCode"], BizCode::Forbidden.code());

    let res = agent()
        .post(format!("{}/api/v1/issue/list", remote.url()))
        .header("authorization", "Bearer vv_dev_bad")
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 401);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Unauthorized.code());

    let res = agent()
        .post(format!("{}/api/v1/issue/list", remote.url()))
        .header("authorization", "Bearer vv_dev_good")
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(fake.last_client().map(|c| c.kind), Some(ClientKind::RemoteDevice));

    let (st, body) = post(&format!("{}/api/v1/remote/pair/exchange", remote.url()), json!({}));
    assert_eq!(st, 200);
    assert_eq!(body["data"]["paired"], true);

    // AuthenticatedQuery: /api/v1/attachment/{id} accepts ?token= on remote listener and rejects missing/bad tokens.
    let res = agent().get(format!("{}/api/v1/attachment/a1", remote.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let res = agent().get(format!("{}/api/v1/attachment/a1?token=vv_dev_bad", remote.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 401);
    let res = agent().get(format!("{}/api/v1/attachment/a1?token=vv_dev_good", remote.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.text().unwrap(), "hello attachment");

    // LocalOnly: /mcp, media::upload, media::speech reject on remote listener with JSON BizCode::Forbidden envelope.
    let media_id = "0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3f";
    for res in [
        agent()
            .post(format!("{}/mcp", remote.url()))
            .header("authorization", "Bearer vv_dev_good")
            .json(&json!({}))
            .send()
            .unwrap(),
        agent()
            .put(format!("{}/api/v1/media/input/{media_id}/content", remote.url()))
            .header("authorization", "Bearer vv_dev_good")
            .header("content-type", "application/octet-stream")
            .body(vec![1, 2, 3])
            .send()
            .unwrap(),
        agent()
            .get(format!("{}/api/v1/media/speech/{media_id}/stream", remote.url()))
            .header("authorization", "Bearer vv_dev_good")
            .send()
            .unwrap(),
    ] {
        assert_eq!(res.status().as_u16(), 403);
        assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());
    }

    // LocalOnly on /mcp still rejects vv_dev_ bearer tokens on loopback.
    let res = agent()
        .post(format!("{}/mcp", local.url()))
        .header("authorization", "Bearer vv_dev_good")
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());

    // LocalOnlyStatus: GET media::content rejects on remote listener and cross-origin loopback with plain 403 and empty body.
    for res in [
        agent()
            .get(format!("{}/api/v1/media/input/{media_id}/content", remote.url()))
            .header("authorization", "Bearer vv_dev_good")
            .send()
            .unwrap(),
        agent()
            .get(format!("{}/api/v1/media/input/{media_id}/content", local.url()))
            .header("origin", "http://evil.example")
            .send()
            .unwrap(),
    ] {
        assert_eq!(res.status().as_u16(), 403);
        assert_eq!(res.text().unwrap(), "");
    }

    // MachineAuth: wrong scope rejected with 403 envelope even on plain GET before WS upgrade.
    let res = agent()
        .get(format!("{}/api/v1/machine/ws", local.url()))
        .header("authorization", "Bearer vv_dev_good")
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());

    let machine_server: Shared = Arc::new(WithRemoteAuth {
        inner: fake,
        auth: Arc::new(StaticRemoteAuth {
            enabled: true,
            valid_token: "vv_dev_machine",
            scope: SCOPE_REMOTE_MACHINE,
        }),
    });
    let machine_local = serve(machine_server, "127.0.0.1:0".parse().unwrap()).unwrap();
    let res = agent()
        .get(format!("{}/api/v1/machine/ws?token=vv_dev_machine", machine_local.url()))
        .send()
        .unwrap();
    // MachineAuth succeeded, then machine_bus() is None -> 503 ServiceUnavailable.
    assert_eq!(res.status().as_u16(), 503);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::ServiceUnavailable.code());
}

#[test]
fn tokio_util_streaming_upload_and_ranged_download_enforce_bounds_timeout_and_truncation() {
    // 1. StreamReader + SyncIoBridge multi-chunk upload.
    vibevalley_runtime::rt::block_on(async {
        let chunks = futures_util::stream::iter([
            Ok::<_, io::Error>(Bytes::from_static(b"hello ")),
            Ok(Bytes::from_static(b"tokio-")),
            Ok(Bytes::from_static(b"util!")),
        ]);
        let stream = Box::pin(media::bounded_upload_stream(Body::from_stream(chunks), 64, Duration::from_secs(5)));
        let mut reader = SyncIoBridge::new(StreamReader::new(stream));
        let collected = tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            reader.read_to_end(&mut out).map(|_| out)
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(collected, b"hello tokio-util!");

        // 2. Max-size cap returns InvalidData.
        let oversized = futures_util::stream::iter([Ok::<_, io::Error>(Bytes::from(vec![b'a'; 10])), Ok(Bytes::from(vec![b'b'; 10]))]);
        let stream = Box::pin(media::bounded_upload_stream(Body::from_stream(oversized), 15, Duration::from_secs(5)));
        let mut reader = SyncIoBridge::new(StreamReader::new(stream));
        let err = tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            reader.read_to_end(&mut out)
        })
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);

        // 3. Stalled body stream returns TimedOut when deadline elapses.
        let stalled = futures_util::stream::pending::<Result<Bytes, io::Error>>();
        let stream = Box::pin(media::bounded_upload_stream(Body::from_stream(stalled), 64, Duration::from_millis(25)));
        let mut reader = SyncIoBridge::new(StreamReader::new(stream));
        let err = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 16];
            reader.read(&mut buf)
        })
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);

        // 4. ReaderStream file_range_stream flags truncated files with UnexpectedEof.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("short.bin");
        std::fs::write(&path, b"short").unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let mut stream = file_range_stream(file, 32, "truncated");
        let mut seen = Vec::new();
        let mut got_eof = false;
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => seen.extend_from_slice(&bytes),
                Err(err) => {
                    assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
                    got_eof = true;
                    break;
                }
            }
        }
        assert_eq!(seen, b"short");
        assert!(got_eof, "truncated stream must surface UnexpectedEof");
    });

    // 5. Real HTTP attachment ranged streaming across multiple 64 KiB ReaderStream chunks.
    let (fake, l) = start();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.bin");
    let payload: Vec<u8> = (0..(150 * 1024)).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &payload).unwrap();
    fake.respond(
        "attachment.file",
        json!({ "path": path, "type": "application/octet-stream", "name": "big.bin" }),
    );

    let full = agent().get(format!("{}/api/v1/attachment/big", l.url())).send().unwrap();
    assert_eq!(full.status().as_u16(), 200);
    assert_eq!(full.headers()["content-length"], payload.len().to_string());
    assert_eq!(full.bytes().unwrap().as_ref(), payload.as_slice());

    let partial = agent()
        .get(format!("{}/api/v1/attachment/big", l.url()))
        .header("range", "bytes=65530-131080")
        .send()
        .unwrap();
    assert_eq!(partial.status().as_u16(), 206);
    assert_eq!(partial.headers()["content-range"], format!("bytes 65530-131080/{}", payload.len()));
    assert_eq!(partial.headers()["content-length"], (131080 - 65530 + 1).to_string());
    assert_eq!(partial.bytes().unwrap().as_ref(), &payload[65530..=131080]);
}

#[tokio::test]
async fn listener_shutdown_ends_active_sse_stream_without_blocking() {
    let (_fake, listener) = start();
    let url = format!("{}/api/v1/live", listener.url());

    crate::context::install_tls();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut res = client.get(&url).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Shutdown completes asynchronously and closes the open SSE response body.
    listener.shutdown().await;
    while let Some(chunk) = res.chunk().await.unwrap() {
        let _ = chunk;
    }
}
