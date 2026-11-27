use std::io::{self, BufRead, BufReader, Read};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio_util::io::{StreamReader, SyncIoBridge};
use vibevalley_protocol::{ApiError, BizCode, Envelope, Issue, SCOPE_REMOTE_CLIENT, SCOPE_REMOTE_MACHINE, SliceKind};

use crate::context::SliceSubscription;
use crate::gateway::api::{BoxFuture, CallerContext, ClientKind, GatewayPorts, RemoteAuth, RemoteDeviceIdentity, Server};
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
    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        self.inner.clone().call_with_async(ctx, op, payload)
    }
    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        self.inner.slice_snapshot_json(slice)
    }
    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        let sub = self.inner.subscribe_slice(slice);
        self.on_watch.notify_waiters();
        sub
    }
    fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
        self.inner.live()
    }
    fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<vibevalley_protocol::LiveEvent>> {
        self.inner.subscribe_live()
    }
    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
        Box::pin(async move {
            let res = self.inner.clone().subscribe_with_async(ctx, name, payload).await;
            self.on_subscribe.notify_waiters();
            res
        })
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
        fn call_with_async(self: Arc<Self>, _: CallerContext, _: String, _: Value) -> BoxFuture<'static, Envelope> {
            Box::pin(async { Envelope::void() })
        }
        fn slice_snapshot_json(&self, _: SliceKind) -> Arc<str> {
            Arc::from(r#"{"seq":0}"#)
        }
        fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
            tokio::sync::mpsc::channel(1).1
        }
        fn subscribe_with_async(
            self: Arc<Self>,
            _: CallerContext,
            _: String,
            _: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            Box::pin(async { Err(Envelope::failure(&ApiError::new(BizCode::IssueNotFound, "no such issue"))) })
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
    assert_eq!(res.headers().get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(res.headers().get("content-security-policy").unwrap(), "sandbox");
    assert_eq!(res.headers().get("accept-ranges").unwrap(), "bytes");
    assert_eq!(res.headers().get("content-disposition").unwrap(), "inline; filename*=UTF-8''shot%20%221%22.png");
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
        ("note/file/list", "note.file.list"),
        ("note/suggestion/accept", "note.suggestion.accept"),
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
    struct LiveOnly(parking_lot::Mutex<Option<tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent>>>);
    impl Server for LiveOnly {
        fn call_with_async(self: Arc<Self>, _: CallerContext, _: String, _: Value) -> BoxFuture<'static, Envelope> {
            Box::pin(async { Envelope::void() })
        }
        fn slice_snapshot_json(&self, _: SliceKind) -> Arc<str> {
            Arc::from(r#"{"seq":0}"#)
        }
        fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
            self.0.lock().take().unwrap_or_else(|| tokio::sync::mpsc::channel(1).1)
        }
        fn subscribe_with_async(
            self: Arc<Self>,
            _: CallerContext,
            _: String,
            _: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            Box::pin(async { Err(Envelope::failure(&ApiError::new(BizCode::RouteNotFound, "no subscription"))) })
        }
        fn unsubscribe(&self, _: u64) {}
    }
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let listener = serve(Arc::new(LiveOnly(parking_lot::Mutex::new(Some(rx)))), "127.0.0.1:0".parse().unwrap()).unwrap();
    tx.try_send(vibevalley_protocol::LiveEvent::Notice(vibevalley_protocol::LiveEventNotice {
        level: vibevalley_protocol::NoticeLevel::Info,
        text: "ready".into(),
        at: 1,
    }))
    .unwrap();
    let event = first_event(&format!("{}/api/v1/events", listener.url()));
    assert_eq!(event["text"], "ready");
}

#[test]
fn loopback_and_note_route_validators_match_exact_ascii_rules() {
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

    assert!(is_media_input_uuid("0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3f"));
    assert!(!is_media_input_uuid("0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3"));
    assert!(!is_media_input_uuid("0196F8E2-7c0a-7f10-8b2d-9e5a4c1d2e3f"));
    assert!(!is_media_input_uuid("0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3g"));
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
    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        self.inner.clone().call_with_async(ctx, op, payload)
    }
    fn slice_snapshot_json(&self, kind: SliceKind) -> Arc<str> {
        self.inner.slice_snapshot_json(kind)
    }
    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        self.inner.subscribe_slice(slice)
    }
    fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
        self.inner.live()
    }
    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
        self.inner.clone().subscribe_with_async(ctx, name, payload)
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

    // LocalOnly: /mcp rejects on remote listener with JSON BizCode::Forbidden envelope.
    let media_id = "0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3f";
    let res = agent()
        .post(format!("{}/mcp", remote.url()))
        .header("authorization", "Bearer vv_dev_good")
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());

    // LocalOnly on /mcp still rejects vv_dev_ bearer tokens on loopback.
    let res = agent()
        .post(format!("{}/mcp", local.url()))
        .header("authorization", "Bearer vv_dev_good")
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());

    // Remote media routes require valid non-machine auth (403 missing, 401 bad token, cross-origin loopback 403)
    // and proceed past auth with valid remote client Bearer or ?token= (reaching media_input/speech port check).
    let res = agent().get(format!("{}/api/v1/media/input/{media_id}/content", remote.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let res = agent()
        .get(format!("{}/api/v1/media/input/{media_id}/content?token=vv_dev_bad", remote.url()))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 401);
    let res = agent()
        .get(format!("{}/api/v1/media/input/{media_id}/content", local.url()))
        .header("origin", "http://evil.example")
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    // Valid client token passes auth on content (no media_input port attached -> 404).
    let res = agent()
        .get(format!("{}/api/v1/media/input/{media_id}/content?token=vv_dev_good", remote.url()))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 404);
    // Valid client Bearer passes auth on upload (no media_input port attached -> 503).
    let res = agent()
        .put(format!("{}/api/v1/media/input/{media_id}/content", remote.url()))
        .header("authorization", "Bearer vv_dev_good")
        .header("content-type", "application/octet-stream")
        .body(vec![1, 2, 3])
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 503);
    // Valid client Bearer or ?token= passes auth on speech stream (no speech port attached -> 503).
    for url in [
        format!("{}/api/v1/media/speech/{media_id}/stream?token=vv_dev_good", remote.url()),
        format!("{}/api/v1/media/speech/{media_id}/stream", remote.url()),
    ] {
        let mut req = agent().get(&url);
        if !url.contains("token=") {
            req = req.header("authorization", "Bearer vv_dev_good");
        }
        let res = req.send().unwrap();
        assert_eq!(res.status().as_u16(), 503);
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

struct StaticMediaInputs {
    path: std::path::PathBuf,
    content_type: String,
    name: String,
}

impl crate::gateway::api::media::MediaInputs for StaticMediaInputs {
    fn upload_async(
        self: Arc<Self>,
        _id: String,
        _source: Box<dyn std::io::Read + Send>,
    ) -> BoxFuture<'static, Result<vibevalley_protocol::MediaInput, ApiError>> {
        Box::pin(async { Err(ApiError::new(BizCode::InvalidInput, "unused")) })
    }

    fn content_async(self: Arc<Self>, _id: String) -> BoxFuture<'static, Result<vibevalley_protocol::AttachmentFile, ApiError>> {
        let path = self.path.to_string_lossy().into_owned();
        let r#type = self.content_type.clone();
        let name = self.name.clone();
        Box::pin(async move { Ok(vibevalley_protocol::AttachmentFile { path, r#type, name }) })
    }
}

struct WithMediaInputs {
    inner: Arc<FakeServer>,
    inputs: Arc<dyn crate::gateway::api::media::MediaInputs>,
}

impl Server for WithMediaInputs {
    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        self.inner.clone().call_with_async(ctx, op, payload)
    }
    fn slice_snapshot_json(&self, kind: SliceKind) -> Arc<str> {
        self.inner.slice_snapshot_json(kind)
    }
    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        self.inner.subscribe_slice(slice)
    }
    fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
        self.inner.live()
    }
    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
        self.inner.clone().subscribe_with_async(ctx, name, payload)
    }
    fn unsubscribe(&self, id: u64) {
        self.inner.unsubscribe(id)
    }
    fn ports(&self) -> GatewayPorts {
        GatewayPorts {
            media_input: Some(self.inputs.clone()),
            ..Default::default()
        }
    }
}

#[test]
fn attachment_and_media_content_share_security_headers_rfc5987_ranges_and_zero_byte_policy() {
    let dir = tempfile::tempdir().unwrap();
    let non_empty_path = dir.path().join("payload.bin");
    let empty_path = dir.path().join("empty.bin");
    std::fs::write(&non_empty_path, b"0123456789").unwrap();
    std::fs::write(&empty_path, b"").unwrap();

    let raw_name = "报告 \"1\".png";
    let expected_disposition = "inline; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%221%22.png";
    let media_id = "0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3f";

    // 1. Non-empty file on both attachment and media::content: full 200, Range 206, OOB 416.
    let fake = Arc::new(FakeServer::new());
    fake.respond("attachment.file", json!({ "path": non_empty_path, "type": "image/png", "name": raw_name }));
    let media_server: Shared = Arc::new(WithMediaInputs {
        inner: fake.clone(),
        inputs: Arc::new(StaticMediaInputs {
            path: non_empty_path.clone(),
            content_type: "image/png".into(),
            name: raw_name.into(),
        }),
    });
    let l = serve(media_server, "127.0.0.1:0".parse().unwrap()).unwrap();

    for url in [
        format!("{}/api/v1/attachment/a-nonempty", l.url()),
        format!("{}/api/v1/media/input/{media_id}/content", l.url()),
    ] {
        let full = agent().get(&url).send().unwrap();
        assert_eq!(full.status().as_u16(), 200, "{url}");
        assert_eq!(full.headers()["x-content-type-options"], "nosniff", "{url}");
        assert_eq!(full.headers()["content-security-policy"], "sandbox", "{url}");
        assert_eq!(full.headers()["accept-ranges"], "bytes", "{url}");
        assert_eq!(full.headers()["content-disposition"], expected_disposition, "{url}");
        assert_eq!(full.headers()["content-length"], "10", "{url}");
        assert_eq!(full.bytes().unwrap().as_ref(), b"0123456789", "{url}");

        let partial = agent().get(&url).header("range", "bytes=2-5").send().unwrap();
        assert_eq!(partial.status().as_u16(), 206, "{url}");
        assert_eq!(partial.headers()["x-content-type-options"], "nosniff", "{url}");
        assert_eq!(partial.headers()["content-security-policy"], "sandbox", "{url}");
        assert_eq!(partial.headers()["accept-ranges"], "bytes", "{url}");
        assert_eq!(partial.headers()["content-disposition"], expected_disposition, "{url}");
        assert_eq!(partial.headers()["content-range"], "bytes 2-5/10", "{url}");
        assert_eq!(partial.headers()["content-length"], "4", "{url}");
        assert_eq!(partial.bytes().unwrap().as_ref(), b"2345", "{url}");

        let oob = agent().get(&url).header("range", "bytes=99-").send().unwrap();
        assert_eq!(oob.status().as_u16(), 416, "{url}");
        assert_eq!(oob.headers()["content-range"], "bytes */10", "{url}");
    }

    // 2. 0-byte file on both attachment and media::content: 200 (no Range) with headers, 416 (with Range).
    let empty_fake = Arc::new(FakeServer::new());
    empty_fake.respond("attachment.file", json!({ "path": empty_path, "type": "text/plain", "name": raw_name }));
    let empty_server: Shared = Arc::new(WithMediaInputs {
        inner: empty_fake,
        inputs: Arc::new(StaticMediaInputs {
            path: empty_path,
            content_type: "text/plain".into(),
            name: raw_name.into(),
        }),
    });
    let l_empty = serve(empty_server, "127.0.0.1:0".parse().unwrap()).unwrap();

    for url in [
        format!("{}/api/v1/attachment/a-empty", l_empty.url()),
        format!("{}/api/v1/media/input/{media_id}/content", l_empty.url()),
    ] {
        let full = agent().get(&url).send().unwrap();
        assert_eq!(full.status().as_u16(), 200, "{url}");
        assert_eq!(full.headers()["x-content-type-options"], "nosniff", "{url}");
        assert_eq!(full.headers()["content-security-policy"], "sandbox", "{url}");
        assert_eq!(full.headers()["accept-ranges"], "bytes", "{url}");
        assert_eq!(full.headers()["content-disposition"], expected_disposition, "{url}");
        assert_eq!(full.headers()["content-length"], "0", "{url}");
        assert_eq!(full.bytes().unwrap().as_ref(), b"", "{url}");

        let ranged = agent().get(&url).header("range", "bytes=0-0").send().unwrap();
        assert_eq!(ranged.status().as_u16(), 416, "{url}");
        assert_eq!(ranged.headers()["content-range"], "bytes */0", "{url}");
    }
}

#[test]
fn slice_returns_service_unavailable_when_server_has_no_async_subscription() {
    struct NoSliceFeed;
    impl Server for NoSliceFeed {
        fn call_with_async(self: Arc<Self>, _: CallerContext, _: String, _: Value) -> BoxFuture<'static, Envelope> {
            Box::pin(async { Envelope::void() })
        }
        fn slice_snapshot_json(&self, _: SliceKind) -> Arc<str> {
            Arc::from(r#"{"seq":0}"#)
        }
        fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
            tokio::sync::mpsc::channel(1).1
        }
        fn subscribe_with_async(
            self: Arc<Self>,
            _: CallerContext,
            _: String,
            _: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            Box::pin(async { Err(Envelope::failure(&ApiError::new(BizCode::RouteNotFound, "none"))) })
        }
        fn unsubscribe(&self, _: u64) {}
    }

    let listener = serve(Arc::new(NoSliceFeed), "127.0.0.1:0".parse().unwrap()).unwrap();
    let res = agent().get(format!("{}/api/v1/slice/board", listener.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 503);
    let body: Value = res.json().unwrap();
    assert_eq!(body["bizCode"], BizCode::ServiceUnavailable.code());
}

#[test]
fn gateway_mcp_route_serves_stateless_discover_skills_and_routable_headers() {
    use vibevalley_mcp::{
        EXT_SKILLS, HEADER_METHOD, HEADER_NAME, HEADER_PROTOCOL_VERSION, McpHandler, PROTOCOL_STATELESS, RequestContext, RpcError, ServerCapabilities,
        ServerInfo, SkillCatalog, ToolCallResult, ToolDef, builtin_note_skills, dispatch_json, error_code,
    };

    struct GatewayMcpDoor {
        skills: SkillCatalog,
    }

    impl McpHandler for GatewayMcpDoor {
        fn server_info(&self) -> ServerInfo {
            ServerInfo::new("vibevalley", "0.1.0-gateway-test")
        }

        fn capabilities(&self) -> ServerCapabilities {
            ServerCapabilities::default().with_tools().with_resources().with_skills_extension(true)
        }

        fn skills(&self) -> Option<&SkillCatalog> {
            Some(&self.skills)
        }

        fn list_tools<'a>(&'a self, _ctx: &'a RequestContext) -> vibevalley_mcp::BoxFuture<'a, Result<Vec<ToolDef>, RpcError>> {
            Box::pin(async {
                Ok(vec![ToolDef {
                    name: "vv_note_list".into(),
                    description: "List notes".into(),
                    input_schema: json!({ "type": "object", "properties": {} }),
                }])
            })
        }

        fn call_tool<'a>(
            &'a self,
            _ctx: &'a RequestContext,
            name: &'a str,
            arguments: Value,
        ) -> vibevalley_mcp::BoxFuture<'a, Result<ToolCallResult, RpcError>> {
            let name = name.to_owned();
            Box::pin(async move { Ok(ToolCallResult::json(&json!({ "tool": name, "arguments": arguments }))) })
        }
    }

    impl crate::context::api::Mcp for GatewayMcpDoor {
        fn message_json(&self, _token: &str, _message_json: &str) -> Option<String> {
            None
        }

        fn message_json_async(self: Arc<Self>, token: String, message_json: String) -> BoxFuture<'static, Option<String>> {
            Box::pin(async move {
                let ctx = RequestContext {
                    protocol_version: None,
                    meta: Default::default(),
                    bearer_token: (!token.is_empty()).then_some(token),
                };
                dispatch_json(self.as_ref(), &ctx, &message_json).await.ok().flatten()
            })
        }
    }

    struct WithMcpDoor {
        inner: Arc<FakeServer>,
        door: Arc<GatewayMcpDoor>,
    }

    impl Server for WithMcpDoor {
        fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
            self.inner.clone().call_with_async(ctx, op, payload)
        }
        fn slice_snapshot_json(&self, kind: SliceKind) -> Arc<str> {
            self.inner.slice_snapshot_json(kind)
        }
        fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
            self.inner.live()
        }
        fn subscribe_with_async(
            self: Arc<Self>,
            ctx: CallerContext,
            name: String,
            payload: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            self.inner.clone().subscribe_with_async(ctx, name, payload)
        }
        fn unsubscribe(&self, id: u64) {
            self.inner.unsubscribe(id)
        }
        fn ports(&self) -> GatewayPorts {
            GatewayPorts {
                mcp: Some(self.door.clone()),
                ..Default::default()
            }
        }
    }

    let door = Arc::new(GatewayMcpDoor { skills: builtin_note_skills() });
    let server: Shared = Arc::new(WithMcpDoor {
        inner: Arc::new(FakeServer::new()),
        door,
    });
    let listener = serve(server, "127.0.0.1:0".parse().unwrap()).unwrap();
    let mcp_url = format!("{}/mcp", listener.url());

    // 1. Stateless server/discover with SEP-2640 skills extension.
    let discover = agent()
        .post(&mcp_url)
        .header(HEADER_PROTOCOL_VERSION, PROTOCOL_STATELESS)
        .header(HEADER_METHOD, "server/discover")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {} }))
        .send()
        .unwrap();
    assert_eq!(discover.status().as_u16(), 200);
    assert_eq!(discover.headers()[HEADER_PROTOCOL_VERSION], PROTOCOL_STATELESS);
    let discover_body: Value = discover.json().unwrap();
    assert_eq!(discover_body["result"]["stateless"], true);
    assert_eq!(discover_body["result"]["capabilities"]["extensions"][EXT_SKILLS]["directoryRead"], true);

    // 2. SEP-2640 skills/list returns all 4 note type skills.
    let skills = agent()
        .post(&mcp_url)
        .json(&json!({ "jsonrpc": "2.0", "id": 2, "method": "skills/list", "params": {} }))
        .send()
        .unwrap();
    assert_eq!(skills.status().as_u16(), 200);
    let skills_body: Value = skills.json().unwrap();
    assert_eq!(skills_body["result"]["skills"].as_array().unwrap().len(), 4);

    // 3. SEP-2243 Mcp-Name mismatch returns HTTP 400 with -32020.
    let mismatch = agent()
        .post(&mcp_url)
        .header(HEADER_METHOD, "tools/call")
        .header(HEADER_NAME, "wrong_tool")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "vv_note_list", "arguments": {} }
        }))
        .send()
        .unwrap();
    assert_eq!(mismatch.status().as_u16(), 400);
    let mismatch_body: Value = mismatch.json().unwrap();
    assert_eq!(mismatch_body["error"]["code"], error_code::HEADER_MISMATCH);
}

#[test]
fn live_sse_emits_lagged_event_and_recovers_subsequent_events() {
    struct LaggedLiveServer(parking_lot::Mutex<Option<tokio::sync::broadcast::Receiver<vibevalley_protocol::LiveEvent>>>);
    impl Server for LaggedLiveServer {
        fn call_with_async(self: Arc<Self>, _: CallerContext, _: String, _: Value) -> BoxFuture<'static, Envelope> {
            Box::pin(async { Envelope::void() })
        }
        fn slice_snapshot_json(&self, _: SliceKind) -> Arc<str> {
            Arc::from(r#"{"seq":0}"#)
        }
        fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
            tokio::sync::mpsc::channel(1).1
        }
        fn subscribe_live(&self) -> Option<tokio::sync::broadcast::Receiver<vibevalley_protocol::LiveEvent>> {
            self.0.lock().take()
        }
        fn subscribe_with_async(
            self: Arc<Self>,
            _: CallerContext,
            _: String,
            _: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            Box::pin(async { Err(Envelope::failure(&ApiError::new(BizCode::RouteNotFound, "none"))) })
        }
        fn unsubscribe(&self, _: u64) {}
    }

    let (tx, rx) = tokio::sync::broadcast::channel(2);
    for (at, text) in [(1, "dropped"), (2, "surviving-1"), (3, "surviving-2")] {
        let _ = tx.send(vibevalley_protocol::LiveEvent::Notice(vibevalley_protocol::LiveEventNotice {
            level: vibevalley_protocol::NoticeLevel::Info,
            text: text.into(),
            at,
        }));
    }

    let listener = serve(Arc::new(LaggedLiveServer(parking_lot::Mutex::new(Some(rx)))), "127.0.0.1:0".parse().unwrap()).unwrap();
    let res = agent().get(format!("{}/api/v1/live", listener.url())).send().unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let mut reader = io::BufReader::new(res);
    let mut lines = Vec::new();
    let mut line = String::new();
    while lines.len() < 12 {
        line.clear();
        if reader.read_line(&mut line).unwrap() == 0 {
            break;
        }
        let trimmed = line.trim().to_string();
        if !trimmed.is_empty() {
            lines.push(trimmed);
            if lines.iter().any(|l| l.contains("surviving-2")) {
                break;
            }
        }
    }
    assert!(lines.iter().any(|l| l == "event: lagged"), "expected lagged SSE event in {lines:?}");
    assert!(lines.iter().any(|l| l.contains(r#""skipped":1"#)), "expected skipped count in {lines:?}");
    assert!(lines.iter().any(|l| l.contains("surviving-1")), "expected recovery of surviving-1 in {lines:?}");
    assert!(lines.iter().any(|l| l.contains("surviving-2")), "expected recovery of surviving-2 in {lines:?}");
}

#[test]
fn remote_media_routes_reject_machine_scope_and_support_range_playback_with_client_token() {
    struct StubMediaPort {
        file: std::path::PathBuf,
    }
    impl crate::gateway::api::media::MediaInputs for StubMediaPort {
        fn upload_async(
            self: Arc<Self>,
            _id: String,
            _source: Box<dyn io::Read + Send>,
        ) -> BoxFuture<'static, Result<vibevalley_protocol::MediaInput, ApiError>> {
            Box::pin(async { Err(ApiError::new(BizCode::InvalidInput, "unused")) })
        }
        fn content_async(self: Arc<Self>, _id: String) -> BoxFuture<'static, Result<vibevalley_protocol::AttachmentFile, ApiError>> {
            let path = self.file.to_string_lossy().into_owned();
            Box::pin(async move {
                Ok(vibevalley_protocol::AttachmentFile {
                    path,
                    r#type: "application/octet-stream".into(),
                    name: "sample.bin".into(),
                })
            })
        }
    }
    struct RemoteMediaServer {
        inner: Arc<FakeServer>,
        auth: Arc<dyn RemoteAuth>,
        media: crate::gateway::api::media::SharedMediaInputs,
    }
    impl Server for RemoteMediaServer {
        fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
            self.inner.clone().call_with_async(ctx, op, payload)
        }
        fn slice_snapshot_json(&self, kind: SliceKind) -> Arc<str> {
            self.inner.slice_snapshot_json(kind)
        }
        fn live(&self) -> tokio::sync::mpsc::Receiver<vibevalley_protocol::LiveEvent> {
            self.inner.live()
        }
        fn subscribe_with_async(
            self: Arc<Self>,
            ctx: CallerContext,
            name: String,
            payload: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            self.inner.clone().subscribe_with_async(ctx, name, payload)
        }
        fn unsubscribe(&self, id: u64) {
            self.inner.unsubscribe(id)
        }
        fn ports(&self) -> GatewayPorts {
            GatewayPorts {
                remote: Some(self.auth.clone()),
                media_input: Some(self.media.clone()),
                ..Default::default()
            }
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let media_file = dir.path().join("sample.bin");
    std::fs::write(&media_file, b"0123456789abcdef").unwrap();
    let media_id = "0196f8e2-7c0a-7f10-8b2d-9e5a4c1d2e3f";
    let port: crate::gateway::api::media::SharedMediaInputs = Arc::new(StubMediaPort { file: media_file });

    // Client scope gets 200 full body and 206 Range via both Bearer and ?token=.
    let client_server: Shared = Arc::new(RemoteMediaServer {
        inner: Arc::new(FakeServer::new()),
        auth: Arc::new(StaticRemoteAuth {
            enabled: true,
            valid_token: "vv_dev_good",
            scope: SCOPE_REMOTE_CLIENT,
        }),
        media: port.clone(),
    });
    let remote = serve_remote(client_server, "127.0.0.1:0".parse().unwrap()).unwrap();
    let full = agent()
        .get(format!("{}/api/v1/media/input/{media_id}/content?token=vv_dev_good", remote.url()))
        .send()
        .unwrap();
    assert_eq!(full.status().as_u16(), 200);
    assert_eq!(full.bytes().unwrap().as_ref(), b"0123456789abcdef");

    let partial = agent()
        .get(format!("{}/api/v1/media/input/{media_id}/content", remote.url()))
        .header("authorization", "Bearer vv_dev_good")
        .header("range", "bytes=4-9")
        .send()
        .unwrap();
    assert_eq!(partial.status().as_u16(), 206);
    assert_eq!(partial.headers()["content-range"], "bytes 4-9/16");
    assert_eq!(partial.bytes().unwrap().as_ref(), b"456789");

    // Machine scope is rejected with 403 across content, upload, and speech routes.
    let machine_server: Shared = Arc::new(RemoteMediaServer {
        inner: Arc::new(FakeServer::new()),
        auth: Arc::new(StaticRemoteAuth {
            enabled: true,
            valid_token: "vv_dev_machine",
            scope: SCOPE_REMOTE_MACHINE,
        }),
        media: port,
    });
    let machine_remote = serve_remote(machine_server, "127.0.0.1:0".parse().unwrap()).unwrap();
    let res = agent()
        .get(format!("{}/api/v1/media/input/{media_id}/content?token=vv_dev_machine", machine_remote.url()))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let res = agent()
        .put(format!("{}/api/v1/media/input/{media_id}/content", machine_remote.url()))
        .header("authorization", "Bearer vv_dev_machine")
        .header("content-type", "application/octet-stream")
        .body(vec![1, 2, 3])
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());
    let res = agent()
        .get(format!("{}/api/v1/media/speech/{media_id}/stream?token=vv_dev_machine", machine_remote.url()))
        .send()
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    assert_eq!(res.json::<Value>().unwrap()["bizCode"], BizCode::Forbidden.code());
}
