//! The chat apps through `connector.*`, each vendor played by a local stub:
//! WeChat's HTTP long poll, QQ's gateway WebSocket and Feishu's protobuf
//! long connection. An echo plays the orchestrator: it answers each of the
//! user's words in the place they were said.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_server::channel::{ChannelEvent, Posting};
use vibevalley_server::connector::{Options, Vendors};
use vibevalley_server::gateway::api::Server;
use vibevalley_server::{App, Config};

const USER: &str = "o9cq80wkM5NnUserOfThisFarm@im.wechat";
const QR: &str = "https://liteapp.weixin.qq.com/q/q1";

#[derive(Debug, Clone, PartialEq)]
struct Sent {
    app: &'static str,
    to: String,
    text: String,
    reply: String,
    /// The id the app gave what it took.
    id: String,
}

enum QqCmd {
    Push(Value),
    /// The gateway's socket goes away without a close.
    Drop,
}

/// The three apps, played: what they are sent is kept.
struct World {
    http: String,
    _http_guard: DropGuard,
    qq_ws: String,
    feishu_ws: String,
    sent: Mutex<Vec<Sent>>,
    sent_notify: Notify,
    /// A send is refused unless it rides on `opened`, the context of the user's fresh message.
    restricted: AtomicBool,
    opened: Mutex<String>,

    wx_qr_calls: AtomicUsize,
    /// What the next polls of the code answer; none left is "wait".
    wx_status: Mutex<VecDeque<Value>>,
    /// WeChat asks for this code before it confirms.
    wx_code: Mutex<Option<String>>,
    wx_status_notify: Notify,
    /// Every message so far; a poll's cursor is how many of them it has had.
    wx_log: Mutex<Vec<Value>>,
    wx_stale: AtomicBool,
    wx_log_notify: Notify,

    feishu_scanned: AtomicBool,
    feishu_in: (std::sync::mpsc::Sender<String>, Mutex<std::sync::mpsc::Receiver<String>>),
    feishu_acks: AtomicUsize,
    feishu_acks_notify: Notify,

    /// Each token given: (appId, token).
    qq_tokens: Mutex<Vec<(String, String)>>,
    qq_expires: Mutex<Value>,
    qq_gateway_auth: Mutex<Vec<String>>,
    qq_gateway_notify: Notify,
    qq_in: (std::sync::mpsc::Sender<QqCmd>, Mutex<std::sync::mpsc::Receiver<QqCmd>>),
    /// Each reply's (msg_id, msg_seq).
    qq_seqs: Mutex<Vec<(String, u64)>>,
}

struct Request {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Request {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn form(&self, key: &str) -> String {
        url::form_urlencoded::parse(&self.body)
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.to_string())
            .unwrap_or_default()
    }

    fn asked(&self, key: &str) -> String {
        url::form_urlencoded::parse(self.query.as_bytes())
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.to_string())
            .unwrap_or_default()
    }
}

/// A local HTTP server answering JSON over `axum`; its base URL and shutdown guard.
fn serve_http<Fut>(answer: impl Fn(Request) -> Fut + Send + Sync + 'static) -> (String, DropGuard)
where
    Fut: Future<Output = (u16, Value)> + Send + 'static,
{
    let answer = Arc::new(answer);
    let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
        let answer = answer.clone();
        async move {
            let req = Request {
                method: method.to_string(),
                path: uri.path().to_string(),
                query: uri.query().unwrap_or("").to_string(),
                headers: headers
                    .iter()
                    .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
                    .collect(),
                body: body.to_vec(),
            };
            let (status, payload) = answer(req).await;
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (code, [(header::CONTENT_TYPE, "application/json")], payload.to_string())
        }
    });
    vibevalley_runtime::rt::block_on(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
        });
        (base, guard)
    })
}

type Socket = tungstenite::WebSocket<TcpStream>;

/// A local WebSocket server, one thread a connection; its URL.
fn serve_ws(each: impl Fn(Socket) + Send + Sync + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let each = Arc::new(each);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let each = each.clone();
            std::thread::spawn(move || {
                let Ok(socket) = tungstenite::accept(stream) else { return };
                let _ = socket.get_ref().set_read_timeout(Some(Duration::from_millis(10)));
                each(socket);
            });
        }
    });
    url
}

/// The next frame, none when nothing came within the socket's timeout; an error once the socket is gone.
fn next_frame(socket: &mut Socket) -> Result<Option<Message>, ()> {
    match socket.read() {
        Ok(m) => Ok(Some(m)),
        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(None),
        Err(_) => Err(()),
    }
}

fn put_varint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push((n & 0x7f) as u8 | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

fn put_field(out: &mut Vec<u8>, field: u64, bytes: &[u8]) {
    put_varint(out, field << 3 | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn feishu_frame(method: u64, headers: &[(&str, &str)], payload: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    for (field, n) in [(1u64, 1u64), (2, 1), (3, 7), (4, method)] {
        put_varint(&mut out, field << 3);
        put_varint(&mut out, n);
    }
    for (key, value) in headers {
        let mut header = vec![];
        put_field(&mut header, 1, key.as_bytes());
        put_field(&mut header, 2, value.as_bytes());
        put_field(&mut out, 5, &header);
    }
    put_field(&mut out, 8, payload);
    out
}

fn take_varint(bytes: &[u8], at: &mut usize) -> u64 {
    let (mut n, mut shift) = (0u64, 0);
    loop {
        let b = bytes[*at];
        *at += 1;
        n |= u64::from(b & 0x7f) << shift;
        shift += 7;
        if b & 0x80 == 0 {
            return n;
        }
    }
}

/// A frame's method and payload.
fn read_feishu_frame(bytes: &[u8]) -> (u64, Vec<u8>) {
    let (mut at, mut method, mut payload) = (0, 0, vec![]);
    while at < bytes.len() {
        let tag = take_varint(bytes, &mut at);
        if tag & 7 == 0 {
            let n = take_varint(bytes, &mut at);
            if tag >> 3 == 4 {
                method = n;
            }
        } else {
            let len = take_varint(bytes, &mut at) as usize;
            if tag >> 3 == 8 {
                payload = bytes[at..at + len].to_vec();
            }
            at += len;
        }
    }
    (method, payload)
}

impl World {
    fn new() -> Arc<World> {
        Arc::new_cyclic(|weak: &std::sync::Weak<World>| {
            let http_world = weak.clone();
            let (http, _http_guard) = serve_http(move |request| {
                let world = http_world.clone();
                async move {
                    let Some(world) = world.upgrade() else {
                        return (503, json!({ "error": "shutting down" }));
                    };
                    world.answer(request).await
                }
            });
            let qq_world = weak.clone();
            let qq_ws = serve_ws(move |socket| {
                if let Some(world) = qq_world.upgrade() {
                    world.qq_gateway(socket);
                }
            });
            let feishu_world = weak.clone();
            let feishu_ws = serve_ws(move |socket| {
                if let Some(world) = feishu_world.upgrade() {
                    world.feishu_connection(socket);
                }
            });
            World {
                http,
                _http_guard,
                qq_ws,
                feishu_ws,
                sent: Mutex::default(),
                sent_notify: Notify::new(),
                restricted: AtomicBool::new(false),
                opened: Mutex::default(),
                wx_qr_calls: AtomicUsize::new(0),
                wx_status: Mutex::default(),
                wx_code: Mutex::default(),
                wx_status_notify: Notify::new(),
                wx_log: Mutex::default(),
                wx_stale: AtomicBool::new(false),
                wx_log_notify: Notify::new(),
                feishu_scanned: AtomicBool::new(false),
                feishu_in: {
                    let (tx, rx) = std::sync::mpsc::channel();
                    (tx, Mutex::new(rx))
                },
                feishu_acks: AtomicUsize::new(0),
                feishu_acks_notify: Notify::new(),
                qq_tokens: Mutex::default(),
                qq_expires: Mutex::new(json!(7200)),
                qq_gateway_auth: Mutex::default(),
                qq_gateway_notify: Notify::new(),
                qq_in: {
                    let (tx, rx) = std::sync::mpsc::channel();
                    (tx, Mutex::new(rx))
                },
                qq_seqs: Mutex::default(),
            }
        })
    }

    fn refuses(&self, reply: &str) -> bool {
        self.restricted.load(Ordering::SeqCst) && reply != *self.opened.lock().unwrap()
    }

    fn record(&self, app: &'static str, to: &str, text: &str, reply: &str, id: impl Fn(usize) -> String) -> String {
        let mut sent = self.sent.lock().unwrap();
        let id = id(sent.len() + 1);
        sent.push(Sent {
            app,
            to: to.into(),
            text: text.into(),
            reply: reply.into(),
            id: id.clone(),
        });
        drop(sent);
        self.sent_notify.notify_waiters();
        id
    }

    fn by(&self, app: &str) -> Vec<Sent> {
        self.sent.lock().unwrap().iter().filter(|s| s.app == app).cloned().collect()
    }

    async fn answer(&self, r: Request) -> (u16, Value) {
        let text = |v: &Value| v.as_str().unwrap_or("").to_string();
        match (r.method.as_str(), r.path.as_str()) {
            ("POST", "/ilink/bot/get_bot_qrcode") => {
                self.wx_qr_calls.fetch_add(1, Ordering::SeqCst);
                (200, json!({ "qrcode": "q1", "qrcode_img_content": QR }))
            }
            ("GET", "/ilink/bot/get_qrcode_status") => {
                let confirmed = json!({ "status": "confirmed", "bot_token": "tok", "ilink_bot_id": "bot1@im.bot", "ilink_user_id": USER });
                let deadline = tokio::time::Instant::now() + Duration::from_millis(20);
                loop {
                    let notified = self.wx_status_notify.notified();
                    if let Some(code) = self.wx_code.lock().unwrap().clone() {
                        return (
                            200,
                            if r.asked("verify_code") == code {
                                confirmed
                            } else {
                                json!({ "status": "need_verifycode" })
                            },
                        );
                    }
                    let next = self.wx_status.lock().unwrap().pop_front();
                    match next {
                        Some(status) if status == "confirmed" => return (200, confirmed),
                        Some(status) => return (200, json!({ "status": status })),
                        None => {
                            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                                return (200, json!({ "status": "wait" }));
                            }
                        }
                    }
                }
            }
            ("POST", "/ilink/bot/getupdates") => {
                if self.wx_stale.load(Ordering::SeqCst) {
                    return (200, json!({ "ret": -14, "errmsg": "session timeout" }));
                }
                assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer tok"));
                let had: usize = text(&r.json()["get_updates_buf"]).parse().unwrap_or(0);
                let deadline = tokio::time::Instant::now() + Duration::from_millis(100);
                loop {
                    let notified = self.wx_log_notify.notified();
                    if self.wx_stale.load(Ordering::SeqCst) {
                        return (200, json!({ "ret": -14, "errmsg": "session timeout" }));
                    }
                    let next = self.wx_log.lock().unwrap().get(had).cloned();
                    if let Some(m) = next {
                        return (200, json!({ "ret": 0, "msgs": [m], "get_updates_buf": (had + 1).to_string() }));
                    }
                    if tokio::time::timeout_at(deadline, notified).await.is_err() {
                        return (200, json!({ "ret": 0, "get_updates_buf": had.to_string() }));
                    }
                }
            }
            ("POST", "/ilink/bot/sendmessage") => {
                let msg = r.json()["msg"].clone();
                let context = text(&msg["context_token"]);
                if self.refuses(&context) {
                    return (200, json!({ "ret": -2, "errmsg": "reply window closed" }));
                }
                let id = self.record(
                    "weixin",
                    &text(&msg["to_user_id"]),
                    &text(&msg["item_list"][0]["text_item"]["text"]),
                    &context,
                    |n| (7_445_566_778_899_000_000u64 + n as u64).to_string(),
                );
                // A 64-bit number, as WeChat sends it.
                (200, json!({ "ret": 0, "message_id": id.parse::<u64>().unwrap() }))
            }
            ("POST", "/oauth/v1/app/registration") => match r.form("action").as_str() {
                "init" => (200, json!({ "supported_auth_methods": ["client_secret"] })),
                "begin" => (
                    200,
                    json!({ "device_code": "dc", "verification_uri_complete": "https://open.feishu.cn/page/launcher?user_code=AB", "interval": 0, "expires_in": 600 }),
                ),
                _ if self.feishu_scanned.load(Ordering::SeqCst) => (
                    200,
                    json!({ "client_id": "cli_1", "client_secret": "s3cret", "user_info": { "open_id": "ou_user", "tenant_brand": "feishu" } }),
                ),
                // A pending poll is a 400 that still answers JSON.
                _ => (400, json!({ "error": "authorization_pending" })),
            },
            ("POST", "/callback/ws/endpoint") => {
                assert_eq!(r.json(), json!({ "AppID": "cli_1", "AppSecret": "s3cret" }));
                let url = format!("{}/?device_id=d1&service_id=7", self.feishu_ws);
                (200, json!({ "code": 0, "data": { "URL": url, "ClientConfig": { "PingInterval": 1 } } }))
            }
            ("POST", "/open-apis/auth/v3/tenant_access_token/internal") => (200, json!({ "code": 0, "tenant_access_token": "t-1", "expire": 7200 })),
            ("POST", "/open-apis/im/v1/messages") => {
                assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer t-1"));
                assert_eq!(r.asked("receive_id_type"), "open_id");
                let body = r.json();
                let content: Value = serde_json::from_str(body["content"].as_str().unwrap()).unwrap();
                let id = self.record("feishu", &text(&body["receive_id"]), &text(&content["text"]), "", |n| format!("om_out_{n}"));
                (200, json!({ "code": 0, "data": { "message_id": id } }))
            }
            ("POST", "/app/getAppAccessToken") => {
                let body = r.json();
                match body["clientSecret"].as_str().unwrap_or("") {
                    secret if secret.starts_with("right") => {
                        let mut tokens = self.qq_tokens.lock().unwrap();
                        let token = format!("tok-{}", tokens.len() + 1);
                        tokens.push((text(&body["appId"]), token.clone()));
                        (200, json!({ "access_token": token, "expires_in": self.qq_expires.lock().unwrap().clone() }))
                    }
                    "banned" => (200, json!({ "code": 100016, "message": "invalid appid or secret" })),
                    _ => (200, json!({ "code": 100016 })),
                }
            }
            ("GET", "/gateway") => {
                self.qq_gateway_auth
                    .lock()
                    .unwrap()
                    .push(r.headers.get("authorization").cloned().unwrap_or_default());
                self.qq_gateway_notify.notify_waiters();
                (200, json!({ "url": self.qq_ws }))
            }
            ("POST", path) if path.starts_with("/v2/users/") => {
                let to = path.trim_start_matches("/v2/users/").trim_end_matches("/messages");
                let body = r.json();
                let msg = text(&body["msg_id"]);
                if self.refuses(&msg) {
                    return (400, json!({ "code": 304027, "message": "the reply window closed" }));
                }
                self.qq_seqs.lock().unwrap().push((msg.clone(), body["msg_seq"].as_u64().unwrap_or(0)));
                let id = self.record("qq", to, &text(&body["content"]), &msg, |n| format!("qq-out-{n}"));
                (200, json!({ "id": id }))
            }
            (method, path) => panic!("the stub has no {method} {path}"),
        }
    }

    /// QQ's gateway: hello, then each dispatch the test pushes.
    fn qq_gateway(&self, mut socket: Socket) {
        let hello = json!({ "op": 10, "s": null, "t": null, "d": { "heartbeat_interval": 50 } });
        if socket.send(Message::text(hello.to_string())).is_err() {
            return;
        }
        let mut identified = false;
        loop {
            match next_frame(&mut socket) {
                Ok(Some(Message::Text(raw))) => {
                    let frame: Value = serde_json::from_str(raw.as_str()).unwrap();
                    if frame["op"] == 2 {
                        assert!(frame["d"]["token"].as_str().unwrap().starts_with("QQBot tok-"));
                        identified = true;
                    }
                }
                Ok(_) => {}
                Err(()) => return,
            }
            if !identified {
                continue;
            }
            match self.qq_in.1.lock().unwrap().try_recv() {
                Ok(QqCmd::Push(dispatch)) => {
                    if socket.send(Message::text(dispatch.to_string())).is_err() {
                        return;
                    }
                }
                Ok(QqCmd::Drop) => return,
                Err(_) => {}
            }
        }
    }

    /// Feishu's long connection: each event the test pushes, and the acknowledgements counted.
    fn feishu_connection(&self, mut socket: Socket) {
        loop {
            match next_frame(&mut socket) {
                Ok(Some(Message::Binary(bytes))) => {
                    let (method, payload) = read_feishu_frame(&bytes);
                    if method == 1 && serde_json::from_slice::<Value>(&payload).is_ok_and(|p| p["code"] == 200) {
                        self.feishu_acks.fetch_add(1, Ordering::SeqCst);
                        self.feishu_acks_notify.notify_waiters();
                    }
                }
                Ok(_) => {}
                Err(()) => return,
            }
            if let Ok(event) = self.feishu_in.1.lock().unwrap().try_recv() {
                let id = uuid::Uuid::new_v4().to_string();
                let frame = feishu_frame(
                    1,
                    &[("type", "event"), ("message_id", &id), ("sum", "1"), ("seq", "0"), ("trace_id", "t")],
                    event.as_bytes(),
                );
                if socket.send(Message::binary(frame)).is_err() {
                    return;
                }
            }
        }
    }

    fn wx(&self, from: &str, text: &str, context: &str) {
        static IDS: AtomicUsize = AtomicUsize::new(100);
        let id = 7_000_000_000_000_000_000u64 + IDS.fetch_add(1, Ordering::SeqCst) as u64;
        self.wx_log.lock().unwrap().push(json!({
            "message_id": id,
            "from_user_id": from,
            "message_type": 1,
            "context_token": context,
            "item_list": [{ "type": 1, "text_item": { "text": text } }],
        }));
        self.wx_log_notify.notify_waiters();
    }

    /// A direct QQ message; its id.
    fn qq(&self, from: &str, content: &str) -> String {
        static IDS: AtomicUsize = AtomicUsize::new(100);
        let id = format!("qm{}", IDS.fetch_add(1, Ordering::SeqCst));
        let dispatch = json!({ "op": 0, "s": 1, "t": "C2C_MESSAGE_CREATE", "d": { "id": id, "content": content, "author": { "user_openid": from } } });
        let _ = self.qq_in.0.send(QqCmd::Push(dispatch));
        id
    }

    fn feishu(&self, from: &str, text: &str, chat_type: &str) {
        static IDS: AtomicUsize = AtomicUsize::new(100);
        let event = json!({
            "schema": "2.0",
            "header": { "event_id": "e", "event_type": "im.message.receive_v1" },
            "event": {
                "sender": { "sender_id": { "open_id": from }, "sender_type": "user" },
                "message": {
                    "message_id": format!("om{}", IDS.fetch_add(1, Ordering::SeqCst)),
                    "chat_type": chat_type,
                    "message_type": "text",
                    "content": json!({ "text": text }).to_string(),
                },
            },
        });
        let _ = self.feishu_in.0.send(event.to_string());
    }
}

fn start(dir: &std::path::Path, world: &World) -> App {
    vibevalley_i18n::set_locale("zh");
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let started = vibevalley_server::app::create_app_with_overrides_blocking(
        Config {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            tick_crons: false,
            link_previews: false,
            orchestrator_listens: false,
            ..Config::under(dir)
        },
        vibevalley_server::app::Overrides {
            connector: Some(Options {
                vendors: Vendors {
                    weixin: world.http.clone(),
                    qq_api: world.http.clone(),
                    qq_token: format!("{}/app/getAppAccessToken", world.http),
                    feishu_accounts: world.http.clone(),
                    lark_accounts: world.http.clone(),
                    feishu_open: world.http.clone(),
                    lark_open: world.http.clone(),
                },
                retry_first: Duration::from_millis(150),
                retry_most: Duration::from_millis(400),
                reconnect: Duration::from_millis(50),
                moment: Duration::from_millis(1500),
                poll_floor: Duration::from_millis(30),
                ..Options::default()
            }),
            ..Default::default()
        },
    )
    .unwrap();
    // The orchestrator, played: it answers each of the user's words where they were said.
    let (mut events, chat, cancel) = (
        started.test_internals().channel.subscribe_events(),
        started.test_internals().channel.clone(),
        started.ctx().token().child_token(),
    );
    started.ctx().spawn("connector-test-echo", async move {
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => return,
                res = events.recv() => match res {
                    Ok(ev) => ev,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                },
            };
            if let ChannelEvent::Posted(c) = event
                && c.row.sender_id == "user"
            {
                let _ = chat
                    .post_async(Posting {
                        from: "orchestrator".into(),
                        channel: c.row.channel_id.clone(),
                        text: format!("收到：**{}**", c.row.body),
                        ..Posting::default()
                    })
                    .await;
            }
        }
    });
    started
}

fn call(s: &App, op: &str, payload: Value) -> Value {
    let e = s.router().call(op, payload);
    assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
    e.data.unwrap_or(Value::Null)
}

fn wait_notify<T>(notify: &Notify, what: &str, mut look: impl FnMut() -> Option<T>) -> T {
    vibevalley_runtime::rt::block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(found) = look() {
                return found;
            }
            assert!(tokio::time::timeout_at(deadline, notified).await.is_ok(), "never: {what}");
        }
    })
}

fn connectors_snapshot(s: &App) -> Vec<Value> {
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());
    let collab: Value = serde_json::from_str(&s.ctx().feed.snapshot_json(vibevalley_protocol::SliceKind::Collab)).unwrap();
    collab["connectors"].as_array().unwrap().clone()
}

fn status(s: &App, id: &str) -> Value {
    connectors_snapshot(s).into_iter().find(|c| c["id"] == id).unwrap()
}

fn status_is(s: &App, id: &str, what: &str, ok: impl Fn(&Value) -> bool) -> Value {
    crate::support::wait_until_settled(Some(s.ctx()), Duration::from_secs(15), &format!("{id}: {what}"), || {
        Some(status(s, id)).filter(|st| ok(st))
    })
}

fn reaches(s: &App, id: &str, state: &str) -> Value {
    status_is(s, id, state, |st| st["state"] == state)
}

fn nth(world: &World, app: &'static str, n: usize) -> Sent {
    wait_notify(&world.sent_notify, &format!("{app}'s message {n}"), || world.by(app).get(n).cloned())
}

fn history(s: &App, channel: &str) -> Vec<Value> {
    call(s, "channel.message.list", json!({ "id": channel })).as_array().unwrap().clone()
}

fn said_in(s: &App, channel: &str) -> Vec<String> {
    let said = history(s, channel);
    said.iter()
        .filter(|m| m["from"] == "user")
        .map(|m| m["text"].as_str().unwrap().to_string())
        .collect()
}

fn weixin_connected(s: &App, world: &World) -> Value {
    let first = call(s, "connector.login", json!({ "id": "weixin" }));
    assert_eq!((first["qr"].as_str(), first["state"].as_str()), (Some(QR), Some("waiting")));
    world.wx_status.lock().unwrap().push_back(json!("confirmed"));
    world.wx_status_notify.notify_waiters();
    reaches(s, "weixin", "connected")
}

#[test]
fn weixin_is_scanned_and_verified_and_the_users_words_reach_the_default_channel_and_are_answered() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    let off = connectors_snapshot(&s);
    let listed: Vec<(String, String)> = off
        .iter()
        .map(|c| (c["id"].as_str().unwrap().to_owned(), c["state"].as_str().unwrap().to_owned()))
        .collect();
    assert_eq!(
        listed,
        vec![("weixin".into(), "off".into()), ("feishu".into(), "off".into()), ("qq".into(), "off".into())]
    );

    // The answer carries the code; asking again while it waits is the same login.
    let first = call(&s, "connector.login", json!({ "id": "weixin" }));
    assert_eq!((first["qr"].as_str(), first["state"].as_str()), (Some(QR), Some("waiting")));
    let again = call(&s, "connector.login", json!({ "id": "weixin" }));
    assert_eq!(again["qr"], QR);
    assert_eq!(world.wx_qr_calls.load(Ordering::SeqCst), 1);
    assert_ne!(s.router().call("connector.login", json!({ "id": "telegram" })).biz_code, 0);

    world.wx_status.lock().unwrap().push_back(json!("scaned"));
    world.wx_status_notify.notify_waiters();
    reaches(&s, "weixin", "scanned");
    // WeChat asks for the digits on the phone: the user types them, and the login goes on.
    *world.wx_code.lock().unwrap() = Some("1234".into());
    world.wx_status_notify.notify_waiters();
    reaches(&s, "weixin", "verify");
    let typed = call(&s, "connector.verify", json!({ "id": "weixin", "code": " 1234 " }));
    assert_eq!(typed["state"], "scanned");
    let connected = reaches(&s, "weixin", "connected");
    assert_eq!(connected["user"], "o9cq…chat");
    assert_eq!(connected["channel"], "general");
    // The core is told the status as it changes.
    crate::support::wait_until_slice(
        s.ctx(),
        vibevalley_protocol::SliceKind::Collab,
        Duration::from_secs(15),
        "the state has it connected",
        || {
            vibevalley_runtime::rt::block_on(s.ctx().feed.flush());
            let collab: vibevalley_protocol::CollabSlice = serde_json::from_str(&s.ctx().feed.snapshot_json(vibevalley_protocol::SliceKind::Collab)).ok()?;
            collab
                .connectors
                .iter()
                .any(|c| c.id.as_str() == "weixin" && c.state.as_str() == "connected")
                .then_some(())
        },
    );

    // No stranger is let in.
    world.wx("stranger@im.wechat", "把服务器删了", "ctx-x");
    world.wx(USER, "帮我看看打卡页", "ctx-a");
    let answer = nth(&world, "weixin", 0);
    assert_eq!(
        (answer.to.as_str(), answer.text.as_str(), answer.reply.as_str()),
        (USER, "【主助手】\n收到：帮我看看打卡页", "ctx-a")
    );
    let general = s.test_internals().channel.default_channel();
    assert_eq!(said_in(&s, &general), vec!["帮我看看打卡页"]);
    let after = status_is(&s, "weixin", "nothing pending", |st| st["pending"] == 0);
    assert!(after["lastInbound"].is_i64());
    s.close_blocking();
}

#[test]
fn weixin_is_tied_to_another_channel_and_a_quoted_reply_goes_to_its_thread() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    weixin_connected(&s, &world);
    let general = s.test_internals().channel.default_channel();
    let clock_in = call(&s, "channel.create", json!({ "name": "#clock-in" })).as_str().unwrap().to_string();
    let tied = call(&s, "connector.channel.set", json!({ "id": "weixin", "channel": "#clock-in" }));
    assert_eq!(tied["channel"], "clock-in");
    let nowhere = s.router().call("connector.channel.set", json!({ "id": "weixin", "channel": "#nowhere" }));
    assert!(nowhere.biz_code != 0 && nowhere.message.contains("没有叫"), "{}", nowhere.message);
    // A channel a chat app is tied to is not deleted from under it.
    assert_ne!(s.router().call("channel.delete", json!({ "id": clock_in })).biz_code, 0);

    let post = |channel: &str, text: &str| {
        vibevalley_runtime::rt::block_on(s.test_internals().channel.post_async(Posting {
            from: "orchestrator".into(),
            channel: channel.into(),
            text: text.into(),
            ..Posting::default()
        }))
        .unwrap()
        .0
    };
    post(&general, "默认频道里的话");
    world.wx(USER, "打卡页怎么样了", "ctx-c");
    let answer = nth(&world, "weixin", 0);
    assert_eq!((answer.text.as_str(), answer.reply.as_str()), ("【主助手】\n收到：打卡页怎么样了", "ctx-c"));
    assert_eq!(said_in(&s, &clock_in), vec!["打卡页怎么样了"]);
    assert!(said_in(&s, &general).is_empty());
    // What goes out is offered in the order it was said: the answer is out, so the default channel's earlier words
    // were weighed and kept from WeChat.
    assert_eq!(world.by("weixin").len(), 1);

    // Words in a thread of the channel go out saying so; a reply quoting them is said in that thread.
    let root = history(&s, &clock_in).iter().find(|m| m["from"] == "orchestrator").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let thread = vibevalley_runtime::rt::block_on(s.test_internals().channel.thread_under_async(&root)).unwrap();
    post(&thread, "串里的话");
    let threaded = nth(&world, "weixin", 1);
    assert_eq!(threaded.text, "【主助手 · 在工单话题里】\n串里的话");
    world.wx_log.lock().unwrap().push(json!({
        "message_id": 7_000_000_000_000_009_999u64,
        "from_user_id": USER,
        "message_type": 1,
        "context_token": "ctx-q",
        "item_list": [
            { "type": 1, "text_item": { "text": "接着说" } },
            { "type": 1, "ref_msg": { "svr_id": threaded.id.parse::<u64>().unwrap() } },
        ],
    }));
    world.wx_log_notify.notify_waiters();
    crate::support::wait_until_channel_event(s.test_internals().channel, Duration::from_secs(15), "the quoted reply in the thread", || {
        (said_in(&s, &thread) == vec!["接着说"]).then_some(())
    });
    assert_eq!(said_in(&s, &clock_in), vec!["打卡页怎么样了"]);
    s.close_blocking();
}

#[test]
fn what_weixin_refuses_waits_then_goes_out_later_or_is_withdrawn() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    weixin_connected(&s, &world);
    let general = s.test_internals().channel.default_channel();
    let pending = |n: i64, what: &str| status_is(&s, "weixin", what, |st| st["pending"] == n);

    // Held, it is sent by itself later.
    world.restricted.store(true, Ordering::SeqCst);
    world.wx(USER, "一", "ctx-1");
    pending(1, "held");
    assert!(world.by("weixin").is_empty());
    world.restricted.store(false, Ordering::SeqCst);
    let held = nth(&world, "weixin", 0);
    assert_eq!((held.text.as_str(), held.reply.as_str()), ("【主助手】\n收到：一", "ctx-1"));
    pending(0, "sent");

    // A read in the workbench withdraws what has not gone out.
    world.restricted.store(true, Ordering::SeqCst);
    let (said, _) = vibevalley_runtime::rt::block_on(s.test_internals().channel.post_async(Posting {
        from: "orchestrator".into(),
        channel: general.clone(),
        text: "已经接下来了".into(),
        ..Posting::default()
    }))
    .unwrap();
    pending(1, "the handoff waiting outside");
    call(&s, "channel.markRead", json!({ "id": general, "number": said.number }));
    pending(0, "the seen handoff withdrawn");
    let mut db = crate::support::inspect_db(&dir.path().join("server.db"));
    let state: String = vibevalley_runtime::rt::block_on(
        sqlx::query_scalar("select state from connector_outbox where message_id = ?1")
            .bind(&said.id)
            .fetch_one(&mut db),
    )
    .unwrap();
    assert_eq!(state, "dropped");
    assert_eq!(world.by("weixin").len(), 1);

    // The user's next words open the window again: the stale acknowledgements are withdrawn, the fresh one goes.
    for word in ["二", "三", "四", "五"] {
        world.wx(USER, word, &format!("ctx-{word}"));
    }
    crate::support::wait_until_channel_event(s.test_internals().channel, Duration::from_secs(15), "four acknowledgements written", || {
        (history(&s, &general)
            .iter()
            .filter(|m| m["from"] == "orchestrator" && m["text"].as_str().unwrap().starts_with("收到"))
            .count()
            >= 5)
            .then_some(())
    });
    *world.opened.lock().unwrap() = "ctx-fresh".into();
    world.wx(USER, "六", "ctx-fresh");
    let fresh = nth(&world, "weixin", 1);
    assert_eq!((fresh.text.as_str(), fresh.reply.as_str()), ("【主助手】\n收到：六", "ctx-fresh"));
    pending(0, "nothing pending");
    let (pending_rows, sent_rows): (i64, i64) = vibevalley_runtime::rt::block_on(
        sqlx::query_as("select sum(case when state = 'pending' then 1 else 0 end), sum(case when state = 'sent' then 1 else 0 end) from connector_outbox where connector = 'weixin'")
            .fetch_one(&mut db),
    )
    .unwrap();
    assert_eq!((pending_rows, sent_rows), (0, 2));
    vibevalley_runtime::rt::block_on(async {
        let notified = world.sent_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        assert_eq!(world.by("weixin").len(), 2);
        let _ = tokio::time::timeout(Duration::from_millis(400), notified).await;
    });
    assert_eq!(world.by("weixin").len(), 2);

    // A logout forgets what waited.
    world.wx(USER, "七", "ctx-7");
    pending(1, "held again");
    let out = call(&s, "connector.logout", json!({ "id": "weixin" }));
    assert_eq!((out["state"].as_str(), out["pending"].as_i64(), out.get("user")), (Some("off"), Some(0), None));
    s.close_blocking();
}

#[test]
fn weixin_goes_on_after_a_restart_and_rests_when_its_login_is_stale() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    {
        let s = start(dir.path(), &world);
        weixin_connected(&s, &world);
        s.close_blocking();
    }
    {
        let s = start(dir.path(), &world);
        // No login this time: the account kept is gone on with.
        assert_eq!(status(&s, "weixin")["state"], "connected");
        world.wx(USER, "重启以后", "ctx-r");
        assert_eq!(nth(&world, "weixin", 0).text, "【主助手】\n收到：重启以后");

        world.wx_stale.store(true, Ordering::SeqCst);
        world.wx_log_notify.notify_waiters();
        let resting = reaches(&s, "weixin", "paused");
        assert!(resting["pausedUntil"].is_i64());
        assert!(resting["error"].as_str().unwrap().contains("登录过期了"), "{resting}");
        s.close_blocking();
    }
    // Saved secrets that are not this app's keys are said, not guessed at.
    let mut db = crate::support::inspect_db(&dir.path().join("server.db"));
    crate::support::execute_sql(&mut db, "update connector_account set secrets = '{\"token\":42}' where connector = 'weixin'");
    drop(db);
    let s = start(dir.path(), &world);
    assert!(status(&s, "weixin")["error"].as_str().unwrap().contains("存着的登录信息读不出来"));
    s.close_blocking();
}

#[test]
fn qq_pairs_by_its_code_takes_only_the_users_words_and_listens_again_after_the_gateway_fails() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    let login = |secret: &str| call(&s, "connector.login", json!({ "id": "qq", "appId": "102", "secret": secret, "force": true }));
    let missing = call(&s, "connector.login", json!({ "id": "qq" }));
    assert!(
        status_is(&s, "qq", "keys asked for", |st| st["state"] == "off" && st["error"] != "")["error"]
            .as_str()
            .unwrap()
            .contains("AppID")
    );
    assert_eq!(missing["id"], "qq");
    login("wrong");
    let refused = status_is(&s, "qq", "refused", |st| st["state"] == "off" && st["error"].as_str().unwrap().contains("不对"));
    assert!(refused["error"].as_str().unwrap().starts_with("QQ 鉴权"));
    // A refusal that carries QQ's own reason says it.
    login("banned");
    status_is(&s, "qq", "QQ's reason", |st| st["error"].as_str().unwrap().contains("invalid appid or secret"));

    login("right");
    let pairing = reaches(&s, "qq", "pairing");
    let code = pairing["pairCode"].as_str().unwrap().to_string();
    assert!(code.len() == 6 && code.chars().all(|c| c.is_ascii_digit()), "{code}");
    world.qq("someone", "你好");
    let word = world.qq("user-openid", &format!("配对 {code}"));
    let paired = reaches(&s, "qq", "connected");
    assert_eq!(paired["user"], "user…enid");
    let welcome = nth(&world, "qq", 0);
    assert!(welcome.text.starts_with("配对好了"), "{}", welcome.text);
    assert_eq!((welcome.to.as_str(), welcome.reply.as_str()), ("user-openid", word.as_str()));

    world.qq("someone", "我也想派活");
    let last = world.qq("user-openid", "跑一下测试");
    let answer = nth(&world, "qq", 1);
    assert_eq!(
        (answer.to.as_str(), answer.text.as_str(), answer.reply.as_str()),
        ("user-openid", "【主助手】\n收到：跑一下测试", last.as_str())
    );
    let general = s.test_internals().channel.default_channel();
    assert_eq!(said_in(&s, &general), vec!["跑一下测试"]);
    // Each reply to a message has the next number of that message.
    assert_eq!(*world.qq_seqs.lock().unwrap(), vec![(word, 1), (last, 1)]);

    // The gateway goes away right after handing a message over: it arrives, and the bot listens again.
    world.qq("user-openid", "断线前");
    let _ = world.qq_in.0.send(QqCmd::Drop);
    crate::support::wait_until_channel_event(s.test_internals().channel, Duration::from_secs(15), "the message before the failure", || {
        said_in(&s, &general).contains(&"断线前".to_string()).then_some(())
    });
    world.qq("user-openid", "重连后");
    crate::support::wait_until_channel_event(
        s.test_internals().channel,
        Duration::from_secs(15),
        "the message after it listens again",
        || said_in(&s, &general).contains(&"重连后".to_string()).then_some(()),
    );
    assert!(world.qq_gateway_auth.lock().unwrap().len() >= 2);
    s.close_blocking();
}

#[test]
fn regression_rotating_qq_credentials_evicts_the_previous_token_and_expired_tokens_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    let login = |app: &str, secret: &str| call(&s, "connector.login", json!({ "id": "qq", "appId": app, "secret": secret, "force": true }));
    let listening_with = |token: &str| {
        let auth = format!("QQBot {token}");
        wait_notify(&world.qq_gateway_notify, &format!("the gateway asked with {token}"), || {
            world.qq_gateway_auth.lock().unwrap().contains(&auth).then_some(())
        });
    };
    // QQ may say the lifetime as text.
    *world.qq_expires.lock().unwrap() = json!("7200");
    login("102", "right-a");
    reaches(&s, "qq", "pairing");
    listening_with("tok-1");
    assert_eq!(world.qq_tokens.lock().unwrap().len(), 1);

    login("103", "right-b");
    listening_with("tok-2");
    assert_eq!(
        *world.qq_tokens.lock().unwrap(),
        vec![("102".to_string(), "tok-1".to_string()), ("103".to_string(), "tok-2".to_string())]
    );

    // A token about to expire is not used again.
    *world.qq_expires.lock().unwrap() = json!(60);
    login("104", "right-c");
    listening_with("tok-4");
    let tokens = world.qq_tokens.lock().unwrap().clone();
    assert_eq!((tokens[2].0.as_str(), tokens[3].0.as_str()), ("104", "104"));
    s.close_blocking();
}

#[test]
fn the_feishu_bot_is_made_by_a_scan_and_takes_only_the_users_direct_words() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    let first = call(&s, "connector.login", json!({ "id": "feishu" }));
    // The launcher link is shown as the page that makes a personal bot.
    assert_eq!(
        (first["qr"].as_str(), first["state"].as_str()),
        (Some("https://open.feishu.cn/page/cli?user_code=AB"), Some("waiting"))
    );
    world.feishu_scanned.store(true, Ordering::SeqCst);
    let connected = reaches(&s, "feishu", "connected");
    assert_eq!(connected["user"], "ou_user");

    world.feishu("ou_user", "群里的话", "group");
    world.feishu("ou_other", "别人的话", "p2p");
    world.feishu("ou_user", "看看日志", "p2p");
    let answer = nth(&world, "feishu", 0);
    assert_eq!(
        (answer.to.as_str(), answer.text.as_str(), answer.reply.as_str()),
        ("ou_user", "【主助手】\n收到：看看日志", "")
    );
    assert_eq!(said_in(&s, &s.test_internals().channel.default_channel()), vec!["看看日志"]);
    // Every event is acknowledged, taken or not.
    wait_notify(&world.feishu_acks_notify, "three acknowledgements", || {
        (world.feishu_acks.load(Ordering::SeqCst) >= 3).then_some(())
    });

    // What the farm says for the user goes out without the user asking.
    vibevalley_runtime::rt::block_on(s.test_internals().channel.post_async(Posting {
        from: "orchestrator".into(),
        channel: s.test_internals().channel.default_channel(),
        text: "部署好了".into(),
        ..Posting::default()
    }))
    .unwrap();
    assert_eq!(nth(&world, "feishu", 1).text, "【主助手】\n部署好了");

    let out = call(&s, "connector.logout", json!({ "id": "feishu" }));
    assert_eq!(out["state"], "off");
    s.close_blocking();
}

fn start_with_clock_and_notify(
    dir: &std::path::Path,
    world: &World,
    clock: vibevalley_core::SharedClock,
    notify: vibevalley_server::connector::NotifyOptions,
) -> App {
    use crate::support::{HookRuntime, quick};
    use vibevalley_runtime::oar::StopReason;
    use vibevalley_runtime::oar::scripted::{Script, Step};

    vibevalley_i18n::set_locale("zh");
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    registry.register(HookRuntime::new("ask", quick(), |turn| {
        if turn.index == 0 {
            turn.report(r#"{"status":"blocked","summary":"need answer","questions":[{"question":"是否启用安静时段？","options":[]}]}"#);
        } else {
            turn.done("已实现初版");
        }
    }));
    registry.register(HookRuntime::new(
        "fail",
        Script::new().turn(vec![Step::text("oops"), Step::finish(StopReason::Error)]),
        |_| {},
    ));
    registry.register(HookRuntime::new("done", quick(), |turn| {
        turn.commit("fix.txt", "ok\n");
        turn.done("all checks green");
    }));
    vibevalley_server::app::create_app_with_overrides_blocking(
        Config {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            tick_crons: false,
            link_previews: false,
            orchestrator_listens: false,
            clock,
            ..Config::under(dir)
        },
        vibevalley_server::app::Overrides {
            connector: Some(Options {
                vendors: Vendors {
                    weixin: world.http.clone(),
                    qq_api: world.http.clone(),
                    qq_token: format!("{}/app/getAppAccessToken", world.http),
                    feishu_accounts: world.http.clone(),
                    lark_accounts: world.http.clone(),
                    feishu_open: world.http.clone(),
                    lark_open: world.http.clone(),
                },
                retry_first: Duration::from_millis(80),
                retry_most: Duration::from_millis(200),
                reconnect: Duration::from_millis(50),
                moment: Duration::from_millis(1500),
                poll_floor: Duration::from_millis(30),
                notify,
            }),
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn weixin_personal_event_pushes_cover_stages_dedupe_withdrawal_and_secret_hygiene() {
    use crate::support::{inspect_db, repo, wait_stage};
    use vibevalley_core::{Clock, ManualClock, SystemClock};
    use vibevalley_protocol::{Conflict, ExecutionPolicy, IssueStageKind as StageKind, IssueStatus, Outcome, Session, SessionController};
    use vibevalley_server::connector::NotifyOptions;
    use vibevalley_server::context::{OUTBOX_SESSION_REPORTED, OutboxEvent, OutboxSessionReported};
    use vibevalley_server::issue::NewIssue;
    use vibevalley_server::runtime::IssueChange;

    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let main_repo = repo(dir.path(), "app");
    let clock = Arc::new(ManualClock::new(SystemClock.now_ms()));
    let s = start_with_clock_and_notify(
        dir.path(),
        &world,
        clock.clone(),
        NotifyOptions {
            issue_cooldown: Duration::ZERO,
            rate_limit_max: 20,
            ..Default::default()
        },
    );
    weixin_connected(&s, &world);
    call(&s, "channel.create", json!({ "name": "#ops-bridge" }));
    call(&s, "connector.channel.set", json!({ "id": "weixin", "channel": "#ops-bridge" }));

    let board = s.test_internals().board.clone();
    let issue = vibevalley_runtime::rt::block_on(board.create_async(NewIssue {
        title: "微信个人推送".into(),
        description: "测试各阶段通知".into(),
        repo: Some(main_repo.clone()),
        agent: "ask".into(),
        ..Default::default()
    }))
    .unwrap();

    // 1. Asking pushes immediately and deduplicates identical board refreshes.
    vibevalley_runtime::rt::block_on(board.move_to_async(&issue.id, IssueStatus::Todo, None)).unwrap();
    wait_stage(&board, &issue.id, StageKind::Asking);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());

    let ask_msg = nth(&world, "weixin", 0);
    assert!(ask_msg.text.contains("【需要回复 · #1 微信个人推送】"), "{}", ask_msg.text);
    assert!(ask_msg.text.contains("是否启用安静时段？"), "{}", ask_msg.text);

    // Re-marking BOARD dirty without changing stage must not push a duplicate.
    s.ctx().mark_dirty(vibevalley_core::SliceMask::BOARD);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());

    // 2. Answering moves the round to Reviewing -> pushes review notification.
    vibevalley_runtime::rt::block_on(board.tell_async(&issue.id, "启用安静时段")).unwrap();
    wait_stage(&board, &issue.id, StageKind::Reviewing);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());
    let review_msg = nth(&world, "weixin", 1);
    assert!(review_msg.text.contains("【待你验收 · #1 微信个人推送】"), "{}", review_msg.text);
    assert!(review_msg.text.contains("已实现初版"), "{}", review_msg.text);

    // 3. Conflict transitions to Stuck(Conflict) -> pushes conflict notification.
    vibevalley_runtime::rt::block_on(async {
        board
            .state()
            .change_async(
                &issue.id,
                IssueChange::Conflicted(Conflict {
                    base: "main".into(),
                    files: vec!["src/weixin.rs".into()],
                }),
            )
            .await
            .unwrap();
        s.ctx().feed.flush().await;
    });
    wait_stage(&board, &issue.id, StageKind::Stuck);
    let conflict_msg = nth(&world, "weixin", 2);
    assert!(conflict_msg.text.contains("【合并冲突 · #1 微信个人推送】"), "{}", conflict_msg.text);
    assert!(conflict_msg.text.contains("src/weixin.rs"), "{}", conflict_msg.text);

    // 4. Restricted delivery holds a push in connector_outbox, and closing the issue in workbench withdraws it!
    *world.opened.lock().unwrap() = "ctx-open".into();
    world.restricted.store(true, Ordering::SeqCst);
    let i2 = vibevalley_runtime::rt::block_on(board.create_async(NewIssue {
        title: "待撤回推送".into(),
        description: "在工作台先解决".into(),
        repo: Some(main_repo.clone()),
        agent: "fail".into(),
        ..Default::default()
    }))
    .unwrap();
    vibevalley_runtime::rt::block_on(board.move_to_async(&i2.id, IssueStatus::Todo, None)).unwrap();
    wait_stage(&board, &i2.id, StageKind::Stuck);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());
    status_is(&s, "weixin", "restricted push pending in connector_outbox", |st| {
        st["pending"].as_i64().unwrap_or(0) >= 1
    });
    assert_eq!(world.by("weixin").len(), 3);

    // Close i2 in workbench -> pending push for i2 is withdrawn cleanly!
    vibevalley_runtime::rt::block_on(board.move_to_async(&i2.id, IssueStatus::Canceled, None)).unwrap();
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());
    status_is(&s, "weixin", "withdrawn after workbench close", |st| st["pending"] == 0);
    world.restricted.store(false, Ordering::SeqCst);

    // 5. Outbox SessionReported for standalone workspace session pushes RunFailed cleanly.
    let ws = Session::new(
        "s-ws-1",
        SessionController::User,
        "主工作区会话",
        "scripted",
        ExecutionPolicy::SandboxDir,
        clock.now_ms(),
    );
    vibevalley_runtime::rt::block_on(async {
        s.test_internals().runtime.upsert_orchestrator_async(&ws).await.unwrap();
        let report = OutboxSessionReported {
            id: "s-ws-1".into(),
            at: clock.now_ms() + 1_000,
            outcome: Outcome::Failed,
            summary: "编译失败：missing symbol".into(),
            spent: None,
            run: Some("run-ws-1".into()),
        };
        s.ctx().outbox.enqueue_event(&OutboxEvent::SessionReported(report)).await.unwrap();
        s.ctx().outbox.wake();
    });
    let ws_msg = nth(&world, "weixin", 3);
    assert!(ws_msg.text.contains("【一轮失败 · 主工作区会话】"), "{}", ws_msg.text);
    assert!(ws_msg.text.contains("编译失败：missing symbol"), "{}", ws_msg.text);

    // 6. Secret hygiene: bot_token ("tok") never leaks into DB outbox tables or ConnectorStatus.
    let mut db = inspect_db(&dir.path().join("server.db"));
    let leaked_outbox: i64 = vibevalley_runtime::rt::block_on(
        sqlx::query_scalar("select count(*) from connector_outbox where body like '%tok%' or coalesce(error, '') like '%tok%'").fetch_one(&mut db),
    )
    .unwrap();
    let leaked_ctx_outbox: i64 = vibevalley_runtime::rt::block_on(
        sqlx::query_scalar("select count(*) from outbox_item where topic = ? and payload_json like '%bot_token%'")
            .bind(OUTBOX_SESSION_REPORTED)
            .fetch_one(&mut db),
    )
    .unwrap();
    assert_eq!((leaked_outbox, leaked_ctx_outbox), (0, 0));
    assert!(!status(&s, "weixin").to_string().contains("\"tok\""));

    s.close_blocking();
}

#[test]
fn scheduled_cron_digest_summarizes_issues_and_runs_over_weixin_and_survives_restart() {
    use crate::support::{repo, wait_stage};
    use vibevalley_core::{Clock, ManualClock, SystemClock};
    use vibevalley_protocol::{ActorKind, ConnectorID, CronWhen, CronWhenEvery, IssueStageKind as StageKind, IssueStatus};
    use vibevalley_server::connector::NotifyOptions;
    use vibevalley_server::context::port::DigestTargets;
    use vibevalley_server::cron::DigestCronRequest;
    use vibevalley_server::cron::digest::DigestSpec;
    use vibevalley_server::issue::NewIssue;

    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let main_repo = repo(dir.path(), "app");
    let clock = Arc::new(ManualClock::new(SystemClock.now_ms()));

    let digest_notify = || NotifyOptions {
        push_targets: vec![],
        ..Default::default()
    };

    {
        let s = start_with_clock_and_notify(dir.path(), &world, clock.clone(), digest_notify());
        weixin_connected(&s, &world);
        call(&s, "channel.create", json!({ "name": "#digest-bridge" }));
        call(&s, "connector.channel.set", json!({ "id": "weixin", "channel": "#digest-bridge" }));
        let board = s.test_internals().board.clone();

        // Run a real issue through completion to produce both a Done issue and a Completed Run.
        let done_issue = vibevalley_runtime::rt::block_on(board.create_async(NewIssue {
            title: "完成夜间编译修复".into(),
            description: "修好 clippy".into(),
            repo: Some(main_repo.clone()),
            agent: "done".into(),
            ..Default::default()
        }))
        .unwrap();
        vibevalley_runtime::rt::block_on(board.move_to_async(&done_issue.id, IssueStatus::Todo, None)).unwrap();
        wait_stage(&board, &done_issue.id, StageKind::Reviewing);
        vibevalley_runtime::rt::block_on(board.move_to_async(&done_issue.id, IssueStatus::Done, None)).unwrap();

        vibevalley_runtime::rt::block_on(async {
            // Schedule a 15-minute digest targeting WeChat.
            s.test_internals()
                .cron
                .add_digest_async(
                    DigestCronRequest {
                        name: "研发日报".into(),
                        note: "自动汇报".into(),
                        channel: None,
                        when: CronWhen::Every(CronWhenEvery { minutes: 15 }),
                        tz: Some("UTC".into()),
                        spec: DigestSpec {
                            targets: DigestTargets::Connectors(vec![ConnectorID::Weixin]),
                            skip_if_empty: false,
                        },
                    },
                    ActorKind::User,
                )
                .await
                .unwrap();
        });

        // Before 15 minutes pass, ticking does not push a digest.
        vibevalley_runtime::rt::block_on(s.test_internals().cron.tick_async());
        assert!(world.by("weixin").is_empty());

        // Advance ManualClock past 15m -> digest pushes to WeChat!
        clock.advance(Duration::from_secs(15 * 60));
        vibevalley_runtime::rt::block_on(s.test_internals().cron.tick_async());
        let first_digest = nth(&world, "weixin", 0);
        assert!(first_digest.text.contains("【进展简报 · 研发日报】"), "{}", first_digest.text);
        assert!(first_digest.text.contains("近期完成 1"), "{}", first_digest.text);
        assert!(first_digest.text.contains("#1 完成夜间编译修复"), "{}", first_digest.text);
        assert!(first_digest.text.contains("完成 1"), "{}", first_digest.text);

        s.close_blocking();
    }

    // Reopen server on same DB & clock -> scheduled digest cron persists and fires on next interval!
    {
        let clock2 = Arc::new(ManualClock::new(clock.now_ms()));
        let s = start_with_clock_and_notify(dir.path(), &world, clock2.clone(), digest_notify());
        reaches(&s, "weixin", "connected");
        // Schedule via `cron.create` RPC using `[简报:weixin]` directive as well.
        let created = call(
            &s,
            "cron.create",
            json!({
                "name": "小时简报",
                "text": "[简报:weixin] 检查进度",
                "when": { "kind": "every", "minutes": 5 },
                "tz": "UTC"
            }),
        );
        assert_eq!(created["enabled"], true);

        clock2.advance(Duration::from_secs(5 * 60));
        vibevalley_runtime::rt::block_on(s.test_internals().cron.tick_async());
        let second_digest = nth(&world, "weixin", 1);
        assert!(second_digest.text.contains("【进展简报 · 小时简报】"), "{}", second_digest.text);
        s.close_blocking();
    }
}

#[test]
fn weixin_quote_replies_drive_asking_reviewing_stuck_and_permission_requests() {
    use crate::support::{HookRuntime, quick, repo, wait_stage};
    use vibevalley_core::{Clock, ManualClock, SystemClock};
    use vibevalley_protocol::{IssueStageKind as StageKind, IssueStatus, SessionPermissionMode};
    use vibevalley_runtime::oar::StopReason;
    use vibevalley_runtime::oar::scripted::{Script, Step};
    use vibevalley_server::connector::NotifyOptions;
    use vibevalley_server::issue::NewIssue;

    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let main_repo = repo(dir.path(), "app");
    let clock = Arc::new(ManualClock::new(SystemClock.now_ms()));

    vibevalley_i18n::set_locale("zh");
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    registry.register(HookRuntime::new("qa_flow", quick(), |turn| {
        if turn.index == 0 {
            turn.report(r#"{"status":"blocked","summary":"need choice","questions":[{"question":"确认部署端口吗？","options":[]}]}"#);
        } else if turn.index == 1 {
            turn.commit("port.txt", "8790\n");
            turn.done("已写入端口配置");
        } else {
            turn.commit("port.txt", "8791\n");
            turn.done("已按反馈更新端口");
        }
    }));
    registry.register(HookRuntime::new(
        "fail_then_fix",
        Script::new()
            .turn(vec![Step::text("boom"), Step::finish(StopReason::Error)])
            .turn(vec![Step::text("Working on it.\n\nDone, committed.")]),
        |turn| {
            if turn.index > 0 {
                turn.commit("recovered.txt", "ok\n");
                turn.done("重试修复完成");
            }
        },
    ));
    registry.register(HookRuntime::new(
        "perm_worker",
        Script::new().turn(vec![
            Step::Permission {
                request_id: "perm-wx-1".into(),
                tool: "shell".into(),
                input: serde_json::json!({"cmd": "cargo check"}),
                summary: "Run cargo check".into(),
                denied: vec![Step::text("denied"), Step::finish(StopReason::Completed)],
            },
            Step::text("allowed and finished"),
            Step::finish(StopReason::Completed),
        ]),
        |_| {},
    ));

    let s = vibevalley_server::app::create_app_with_overrides_blocking(
        Config {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            tick_crons: false,
            link_previews: false,
            orchestrator_listens: false,
            clock,
            ..Config::under(dir.path())
        },
        vibevalley_server::app::Overrides {
            connector: Some(Options {
                vendors: Vendors {
                    weixin: world.http.clone(),
                    qq_api: world.http.clone(),
                    qq_token: format!("{}/app/getAppAccessToken", world.http),
                    feishu_accounts: world.http.clone(),
                    lark_accounts: world.http.clone(),
                    feishu_open: world.http.clone(),
                    lark_open: world.http.clone(),
                },
                retry_first: Duration::from_millis(60),
                retry_most: Duration::from_millis(160),
                reconnect: Duration::from_millis(40),
                moment: Duration::from_millis(1500),
                poll_floor: Duration::from_millis(30),
                notify: NotifyOptions {
                    issue_cooldown: Duration::ZERO,
                    rate_limit_max: 50,
                    ..Default::default()
                },
            }),
            ..Default::default()
        },
    )
    .unwrap();

    weixin_connected(&s, &world);
    call(&s, "channel.create", json!({ "name": "#act-bridge" }));
    call(&s, "connector.channel.set", json!({ "id": "weixin", "channel": "#act-bridge" }));

    let quote_wx = |ext_id: &str, text: &str, ctx_tok: &str| {
        static IDS: AtomicUsize = AtomicUsize::new(900);
        let id = 7_000_000_000_000_010_000u64 + IDS.fetch_add(1, Ordering::SeqCst) as u64;
        world.wx_log.lock().unwrap().push(json!({
            "message_id": id,
            "from_user_id": USER,
            "message_type": 1,
            "context_token": ctx_tok,
            "item_list": [
                { "type": 1, "text_item": { "text": text } },
                { "type": 1, "ref_msg": { "svr_id": ext_id.parse::<u64>().unwrap() } },
            ],
        }));
        world.wx_log_notify.notify_waiters();
    };

    let board = s.test_internals().board.clone();

    // 1. Issue Asking -> quote-reply answers directly -> Reviewing -> quote-reply `reject <reason>` -> Reviewing -> `accept`.
    let i1 = vibevalley_runtime::rt::block_on(board.create_async(NewIssue {
        title: "微信闭环操作".into(),
        description: "验证问答和验收".into(),
        repo: Some(main_repo.clone()),
        agent: "qa_flow".into(),
        ..Default::default()
    }))
    .unwrap();
    vibevalley_runtime::rt::block_on(board.move_to_async(&i1.id, IssueStatus::Todo, None)).unwrap();
    wait_stage(&board, &i1.id, StageKind::Asking);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());

    let ask_push = nth(&world, "weixin", 0);
    assert!(ask_push.text.contains("【需要回复 · #1 微信闭环操作】"), "{}", ask_push.text);

    quote_wx(&ask_push.id, "使用 8790 端口", "ctx-ask-reply");
    let ask_receipt = nth(&world, "weixin", 1);
    assert!(ask_receipt.text.contains("【已回复 · #1 微信闭环操作】"), "{}", ask_receipt.text);
    wait_stage(&board, &i1.id, StageKind::Reviewing);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());

    let review_push_1 = nth(&world, "weixin", 2);
    assert!(review_push_1.text.contains("【待你验收 · #1 微信闭环操作】"), "{}", review_push_1.text);

    // Reject without reason -> localized refusal receipt.
    quote_wx(&review_push_1.id, "reject", "ctx-rej-empty");
    let rej_refusal = nth(&world, "weixin", 3);
    assert!(rej_refusal.text.contains("【缺少打回原因 · #1 微信闭环操作】"), "{}", rej_refusal.text);

    // Reject with reason -> triggers rework round -> second Reviewing push.
    quote_wx(&review_push_1.id, "reject 请改成 8791 端口", "ctx-rej-ok");
    let rej_receipt = nth(&world, "weixin", 4);
    assert!(rej_receipt.text.contains("【已打回 · #1 微信闭环操作】"), "{}", rej_receipt.text);
    wait_stage(&board, &i1.id, StageKind::Reviewing);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());

    let review_push_2 = nth(&world, "weixin", 5);
    assert!(review_push_2.text.contains("已按反馈更新端口"), "{}", review_push_2.text);

    // Accept -> completes issue & lands branch!
    quote_wx(&review_push_2.id, "accept", "ctx-acc-ok");
    let acc_receipt = nth(&world, "weixin", 6);
    assert!(acc_receipt.text.contains("【已完成 · #1 微信闭环操作】"), "{}", acc_receipt.text);
    crate::support::wait_until_settled(Some(s.ctx()), Duration::from_secs(15), "issue done", || {
        vibevalley_runtime::rt::block_on(board.issue_async(&i1.id))
            .ok()
            .flatten()
            .filter(|i| i.status == IssueStatus::Done)
    });

    // Idempotency: quoting the already-completed review push again does not error/rerun and sends alreadyHandled receipt.
    quote_wx(&review_push_2.id, "ok", "ctx-acc-dup");
    let dup_receipt = nth(&world, "weixin", 7);
    assert!(dup_receipt.text.contains("【无需重复处理 · #1 微信闭环操作】"), "{}", dup_receipt.text);

    // 2. Failed issue -> quote-reply `retry` -> restarts and completes to Reviewing.
    let i2 = vibevalley_runtime::rt::block_on(board.create_async(NewIssue {
        title: "失败重试工单".into(),
        description: "测试 retry".into(),
        repo: Some(main_repo.clone()),
        agent: "fail_then_fix".into(),
        ..Default::default()
    }))
    .unwrap();
    vibevalley_runtime::rt::block_on(board.move_to_async(&i2.id, IssueStatus::Todo, None)).unwrap();
    wait_stage(&board, &i2.id, StageKind::Stuck);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());

    let fail_push = nth(&world, "weixin", 8);
    assert!(fail_push.text.contains("【执行失败 · #2 失败重试工单】"), "{}", fail_push.text);

    quote_wx(&fail_push.id, "retry", "ctx-retry-ok");
    let retry_receipt = nth(&world, "weixin", 9);
    assert!(retry_receipt.text.contains("【已重试 · #2 失败重试工单】"), "{}", retry_receipt.text);
    wait_stage(&board, &i2.id, StageKind::Reviewing);
    vibevalley_runtime::rt::block_on(s.ctx().feed.flush());
    let i2_rev = nth(&world, "weixin", 10);
    assert!(i2_rev.text.contains("【待你验收 · #2 失败重试工单】"), "{}", i2_rev.text);

    // 3. Workspace PermissionRequest -> pushes `push:perm:<session_id>:<request_id>` -> quote-reply `allow` resolves it!
    let ws = call(
        &s,
        "session.openWorkspace",
        json!({
            "runtime": "perm_worker",
            "cwd": main_repo.to_string_lossy(),
            "title": "权限会话",
            "permissionMode": SessionPermissionMode::Ask,
        }),
    );
    let ws_id = ws["id"].as_str().unwrap().to_owned();
    call(&s, "session.send", json!({ "id": ws_id, "text": "run check" }));

    let perm_push = nth(&world, "weixin", 11);
    assert!(perm_push.text.contains("【请求授权 ·"), "{}", perm_push.text);
    assert!(perm_push.text.contains("Run cargo check"), "{}", perm_push.text);

    quote_wx(&perm_push.id, "allow", "ctx-perm-allow");
    let perm_receipt = wait_notify(&world.sent_notify, "weixin perm allow receipt", || {
        world.by("weixin").into_iter().find(|m| m.text.contains("【已授权 · 权限会话】"))
    });
    assert!(perm_receipt.text.contains("【已授权 ·"), "{}", perm_receipt.text);
    assert!(!s.test_internals().runtime.has_pending_permission(&ws_id, "perm-wx-1"));

    // Repeating quote-reply after permission resolved is idempotent.
    quote_wx(&perm_push.id, "deny", "ctx-perm-dup");
    let perm_dup_receipt = wait_notify(&world.sent_notify, "weixin perm dup receipt", || {
        world.by("weixin").into_iter().find(|m| m.text.contains("【无需重复处理 · 权限会话】"))
    });
    assert!(perm_dup_receipt.text.contains("【无需重复处理 ·"), "{}", perm_dup_receipt.text);

    s.close_blocking();
}
