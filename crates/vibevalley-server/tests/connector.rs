//! The chat apps through `connector.*`, each vendor played by a local stub:
//! WeChat's HTTP long poll, QQ's gateway WebSocket and Feishu's protobuf
//! long connection. An echo plays the orchestrator: it answers each of the
//! user's words in the place they were said.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{self, Message};
use vibevalley_server::modules::channel::{Posting, Told};
use vibevalley_server::modules::connector::{Options, Vendors};
use vibevalley_server::{Server, Started};

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
    qq_ws: String,
    feishu_ws: String,
    sent: Mutex<Vec<Sent>>,
    /// A send is refused unless it rides on `opened`, the context of the user's fresh message.
    restricted: AtomicBool,
    opened: Mutex<String>,

    wx_qr_calls: AtomicUsize,
    /// What the next polls of the code answer; none left is "wait".
    wx_status: Mutex<VecDeque<Value>>,
    /// WeChat asks for this code before it confirms.
    wx_code: Mutex<Option<String>>,
    /// Every message so far; a poll's cursor is how many of them it has had.
    wx_log: Mutex<Vec<Value>>,
    wx_stale: AtomicBool,

    feishu_scanned: AtomicBool,
    feishu_in: (flume::Sender<String>, flume::Receiver<String>),
    feishu_acks: AtomicUsize,

    /// Each token given: (appId, token).
    qq_tokens: Mutex<Vec<(String, String)>>,
    qq_expires: Mutex<Value>,
    qq_gateway_auth: Mutex<Vec<String>>,
    qq_in: (flume::Sender<QqCmd>, flume::Receiver<QqCmd>),
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

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut bytes = vec![];
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        let n = stream.read(&mut chunk).ok().filter(|n| *n > 0)?;
        bytes.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&bytes[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers.get("content-length").and_then(|l| l.parse().ok()).unwrap_or(0);
    let mut body = bytes[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).ok().filter(|n| *n > 0)?;
        body.extend_from_slice(&chunk[..n]);
    }
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    Some(Request {
        method,
        path: path.to_string(),
        query: query.to_string(),
        headers,
        body,
    })
}

/// A local HTTP server answering JSON, one thread a connection; its base URL.
fn serve_http(answer: impl Fn(Request) -> (u16, Value) + Send + Sync + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let answer = Arc::new(answer);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let answer = answer.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let Some(request) = read_request(&mut stream) else { return };
                let (status, body) = answer(request);
                let body = body.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    base
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
        let cell: Arc<Mutex<Option<Arc<World>>>> = Arc::default();
        let world = |cell: &Arc<Mutex<Option<Arc<World>>>>| cell.lock().unwrap().clone().unwrap();
        let c = cell.clone();
        let http = serve_http(move |request| world(&c).answer(request));
        let c = cell.clone();
        let qq_ws = serve_ws(move |socket| world(&c).qq_gateway(socket));
        let c = cell.clone();
        let feishu_ws = serve_ws(move |socket| world(&c).feishu_connection(socket));
        let made = Arc::new(World {
            http,
            qq_ws,
            feishu_ws,
            sent: Mutex::default(),
            restricted: AtomicBool::new(false),
            opened: Mutex::default(),
            wx_qr_calls: AtomicUsize::new(0),
            wx_status: Mutex::default(),
            wx_code: Mutex::default(),
            wx_log: Mutex::default(),
            wx_stale: AtomicBool::new(false),
            feishu_scanned: AtomicBool::new(false),
            feishu_in: flume::unbounded(),
            feishu_acks: AtomicUsize::new(0),
            qq_tokens: Mutex::default(),
            qq_expires: Mutex::new(json!(7200)),
            qq_gateway_auth: Mutex::default(),
            qq_in: flume::unbounded(),
            qq_seqs: Mutex::default(),
        });
        *cell.lock().unwrap() = Some(made.clone());
        made
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
        id
    }

    fn by(&self, app: &str) -> Vec<Sent> {
        self.sent.lock().unwrap().iter().filter(|s| s.app == app).cloned().collect()
    }

    fn answer(&self, r: Request) -> (u16, Value) {
        let text = |v: &Value| v.as_str().unwrap_or("").to_string();
        match (r.method.as_str(), r.path.as_str()) {
            ("POST", "/ilink/bot/get_bot_qrcode") => {
                self.wx_qr_calls.fetch_add(1, Ordering::SeqCst);
                (200, json!({ "qrcode": "q1", "qrcode_img_content": QR }))
            }
            ("GET", "/ilink/bot/get_qrcode_status") => {
                let confirmed = json!({ "status": "confirmed", "bot_token": "tok", "ilink_bot_id": "bot1@im.bot", "ilink_user_id": USER });
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
                match self.wx_status.lock().unwrap().pop_front() {
                    Some(status) if status == "confirmed" => (200, confirmed),
                    Some(status) => (200, json!({ "status": status })),
                    None => {
                        std::thread::sleep(Duration::from_millis(20));
                        (200, json!({ "status": "wait" }))
                    }
                }
            }
            ("POST", "/ilink/bot/getupdates") => {
                if self.wx_stale.load(Ordering::SeqCst) {
                    return (200, json!({ "ret": -14, "errmsg": "session timeout" }));
                }
                assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer tok"));
                let had: usize = text(&r.json()["get_updates_buf"]).parse().unwrap_or(0);
                let deadline = Instant::now() + Duration::from_millis(100);
                loop {
                    if let Some(m) = self.wx_log.lock().unwrap().get(had) {
                        return (200, json!({ "ret": 0, "msgs": [m], "get_updates_buf": (had + 1).to_string() }));
                    }
                    if Instant::now() > deadline {
                        return (200, json!({ "ret": 0, "get_updates_buf": had.to_string() }));
                    }
                    std::thread::sleep(Duration::from_millis(5));
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
            match self.qq_in.1.try_recv() {
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
                    }
                }
                Ok(_) => {}
                Err(()) => return,
            }
            if let Ok(event) = self.feishu_in.1.try_recv() {
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

fn start(dir: &std::path::Path, world: &World) -> Started {
    vibevalley_i18n::set_locale("zh");
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        watch_pkm: false,
        connector: Options {
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
        },
        ..vibevalley_server::ServerConfig::under(dir)
    })
    .unwrap();
    // The orchestrator, played: it answers each of the user's words where they were said.
    let (said, chat) = (started.chat.committed(), started.chat.clone());
    std::thread::spawn(move || {
        for told in said.iter() {
            if let Told::Posted(c) = told
                && c.row.sender_id == "user"
            {
                let _ = chat.post(Posting {
                    from: "orchestrator".into(),
                    channel: c.row.channel_id.clone(),
                    text: format!("收到：**{}**", c.row.body),
                    ..Posting::default()
                });
            }
        }
    });
    started
}

fn call(s: &Started, op: &str, payload: Value) -> Value {
    let e = s.hub.call(op, payload);
    assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
    e.data.unwrap_or(Value::Null)
}

fn until<T>(what: &str, look: impl Fn() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(found) = look() {
            return found;
        }
        assert!(Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn status(s: &Started, id: &str) -> Value {
    let all = call(s, "connector.list", Value::Null);
    all.as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone()
}

fn status_is(s: &Started, id: &str, what: &str, ok: impl Fn(&Value) -> bool) -> Value {
    until(&format!("{id}: {what}"), || Some(status(s, id)).filter(|st| ok(st)))
}

fn reaches(s: &Started, id: &str, state: &str) -> Value {
    status_is(s, id, state, |st| st["state"] == state)
}

fn nth(world: &World, app: &'static str, n: usize) -> Sent {
    until(&format!("{app}'s message {n}"), || world.by(app).get(n).cloned())
}

fn history(s: &Started, channel: &str) -> Vec<Value> {
    call(s, "channel.message.list", json!({ "id": channel })).as_array().unwrap().clone()
}

fn said_in(s: &Started, channel: &str) -> Vec<String> {
    let said = history(s, channel);
    said.iter()
        .filter(|m| m["from"] == "user")
        .map(|m| m["text"].as_str().unwrap().to_string())
        .collect()
}

fn weixin_connected(s: &Started, world: &World) -> Value {
    let first = call(s, "connector.login", json!({ "id": "weixin" }));
    assert_eq!((first["qr"].as_str(), first["state"].as_str()), (Some(QR), Some("waiting")));
    world.wx_status.lock().unwrap().push_back(json!("confirmed"));
    reaches(s, "weixin", "connected")
}

#[test]
fn weixin_is_scanned_and_verified_and_the_users_words_reach_the_default_channel_and_are_answered() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    let off = call(&s, "connector.list", Value::Null);
    let listed: Vec<(&str, &str)> = off
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap(), c["state"].as_str().unwrap()))
        .collect();
    assert_eq!(listed, vec![("weixin", "off"), ("feishu", "off"), ("qq", "off")]);

    // The answer carries the code; asking again while it waits is the same login.
    let first = call(&s, "connector.login", json!({ "id": "weixin" }));
    assert_eq!((first["qr"].as_str(), first["state"].as_str()), (Some(QR), Some("waiting")));
    let again = call(&s, "connector.login", json!({ "id": "weixin" }));
    assert_eq!(again["qr"], QR);
    assert_eq!(world.wx_qr_calls.load(Ordering::SeqCst), 1);
    assert_ne!(s.hub.call("connector.login", json!({ "id": "telegram" })).biz_code, 0);

    world.wx_status.lock().unwrap().push_back(json!("scaned"));
    reaches(&s, "weixin", "scanned");
    // WeChat asks for the digits on the phone: the user types them, and the login goes on.
    *world.wx_code.lock().unwrap() = Some("1234".into());
    reaches(&s, "weixin", "verify");
    let typed = call(&s, "connector.verify", json!({ "id": "weixin", "code": " 1234 " }));
    assert_eq!(typed["state"], "scanned");
    let connected = reaches(&s, "weixin", "connected");
    assert_eq!(connected["user"], "o9cq…chat");
    assert_eq!(connected["channel"], "general");
    // The core is told the status as it changes.
    until("the state has it connected", || {
        s.hub
            .read(|st| st.connectors.iter().any(|c| c.id.as_str() == "weixin" && c.state.as_str() == "connected"))
            .then_some(())
    });

    // No stranger is let in.
    world.wx("stranger@im.wechat", "把服务器删了", "ctx-x");
    world.wx(USER, "帮我看看打卡页", "ctx-a");
    let answer = nth(&world, "weixin", 0);
    assert_eq!(
        (answer.to.as_str(), answer.text.as_str(), answer.reply.as_str()),
        (USER, "【主助手】\n收到：帮我看看打卡页", "ctx-a")
    );
    let general = s.chat.default_channel();
    assert_eq!(said_in(&s, &general), vec!["帮我看看打卡页"]);
    let after = status_is(&s, "weixin", "nothing pending", |st| st["pending"] == 0);
    assert!(after["lastInbound"].is_i64());
    s.close();
}

#[test]
fn weixin_is_tied_to_another_channel_and_a_quoted_reply_goes_to_its_thread() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    weixin_connected(&s, &world);
    let general = s.chat.default_channel();
    let clock_in = call(&s, "channel.create", json!({ "name": "#clock-in" })).as_str().unwrap().to_string();
    let tied = call(&s, "connector.channel.set", json!({ "id": "weixin", "channel": "#clock-in" }));
    assert_eq!(tied["channel"], "clock-in");
    let nowhere = s.hub.call("connector.channel.set", json!({ "id": "weixin", "channel": "#nowhere" }));
    assert!(nowhere.biz_code != 0 && nowhere.message.contains("没有叫"), "{}", nowhere.message);
    // A channel a chat app is tied to is not deleted from under it.
    assert_ne!(s.hub.call("channel.delete", json!({ "id": clock_in })).biz_code, 0);

    let post = |channel: &str, text: &str| {
        s.chat
            .post(Posting {
                from: "orchestrator".into(),
                channel: channel.into(),
                text: text.into(),
                ..Posting::default()
            })
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
    let thread = s.chat.thread_under(&root).unwrap();
    post(&thread, "串里的话");
    let threaded = nth(&world, "weixin", 1);
    assert_eq!(threaded.text, "【主助手 · 在任务话题里】\n串里的话");
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
    until("the quoted reply in the thread", || (said_in(&s, &thread) == vec!["接着说"]).then_some(()));
    assert_eq!(said_in(&s, &clock_in), vec!["打卡页怎么样了"]);
    s.close();
}

#[test]
fn what_weixin_refuses_waits_then_goes_out_later_or_is_withdrawn() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    weixin_connected(&s, &world);
    let general = s.chat.default_channel();
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
    let (said, _) = s
        .chat
        .post(Posting {
            from: "orchestrator".into(),
            channel: general.clone(),
            text: "已经接下来了".into(),
            ..Posting::default()
        })
        .unwrap();
    pending(1, "the handoff waiting outside");
    call(&s, "channel.markRead", json!({ "id": general, "number": said.number }));
    pending(0, "the seen handoff withdrawn");
    let mut db = crate::support::inspect_db(&dir.path().join("server.db"));
    let state: String = pollster::block_on(
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
    until("four acknowledgements written", || {
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
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(world.by("weixin").len(), 2);

    // A logout forgets what waited.
    world.wx(USER, "七", "ctx-7");
    pending(1, "held again");
    let out = call(&s, "connector.logout", json!({ "id": "weixin" }));
    assert_eq!((out["state"].as_str(), out["pending"].as_i64(), out.get("user")), (Some("off"), Some(0), None));
    s.close();
}

#[test]
fn weixin_goes_on_after_a_restart_and_rests_when_its_login_is_stale() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    {
        let s = start(dir.path(), &world);
        weixin_connected(&s, &world);
        s.close();
    }
    {
        let s = start(dir.path(), &world);
        // No login this time: the account kept is gone on with.
        assert_eq!(status(&s, "weixin")["state"], "connected");
        world.wx(USER, "重启以后", "ctx-r");
        assert_eq!(nth(&world, "weixin", 0).text, "【主助手】\n收到：重启以后");

        world.wx_stale.store(true, Ordering::SeqCst);
        let resting = reaches(&s, "weixin", "paused");
        assert!(resting["pausedUntil"].is_i64());
        assert!(resting["error"].as_str().unwrap().contains("登录过期了"), "{resting}");
        s.close();
    }
    // Saved secrets that are not this app's keys are said, not guessed at.
    let mut db = crate::support::inspect_db(&dir.path().join("server.db"));
    crate::support::execute_sql(&mut db, "update connector_account set secrets = '{\"token\":42}' where connector = 'weixin'");
    drop(db);
    let s = start(dir.path(), &world);
    assert!(status(&s, "weixin")["error"].as_str().unwrap().contains("存着的登录信息读不出来"));
    s.close();
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
    let general = s.chat.default_channel();
    assert_eq!(said_in(&s, &general), vec!["跑一下测试"]);
    // Each reply to a message has the next number of that message.
    assert_eq!(*world.qq_seqs.lock().unwrap(), vec![(word, 1), (last, 1)]);

    // The gateway goes away right after handing a message over: it arrives, and the bot listens again.
    world.qq("user-openid", "断线前");
    let _ = world.qq_in.0.send(QqCmd::Drop);
    until("the message before the failure", || {
        said_in(&s, &general).contains(&"断线前".to_string()).then_some(())
    });
    world.qq("user-openid", "重连后");
    until("the message after it listens again", || {
        said_in(&s, &general).contains(&"重连后".to_string()).then_some(())
    });
    assert!(world.qq_gateway_auth.lock().unwrap().len() >= 2);
    s.close();
}

#[test]
fn regression_rotating_qq_credentials_evicts_the_previous_token_and_expired_tokens_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let world = World::new();
    let s = start(dir.path(), &world);
    let login = |app: &str, secret: &str| call(&s, "connector.login", json!({ "id": "qq", "appId": app, "secret": secret, "force": true }));
    let listening_with = |token: &str| {
        let auth = format!("QQBot {token}");
        until(&format!("the gateway asked with {token}"), || {
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
    s.close();
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
    assert_eq!(said_in(&s, &s.chat.default_channel()), vec!["看看日志"]);
    // Every event is acknowledged, taken or not.
    until("three acknowledgements", || (world.feishu_acks.load(Ordering::SeqCst) >= 3).then_some(()));

    // What the farm says for the user goes out without the user asking.
    s.chat
        .post(Posting {
            from: "orchestrator".into(),
            channel: s.chat.default_channel(),
            text: "部署好了".into(),
            ..Posting::default()
        })
        .unwrap();
    assert_eq!(nth(&world, "feishu", 1).text, "【主助手】\n部署好了");

    let out = call(&s, "connector.logout", json!({ "id": "feishu" }));
    assert_eq!(out["state"], "off");
    s.close();
}
