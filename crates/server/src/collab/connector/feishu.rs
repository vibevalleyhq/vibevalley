//! Feishu (and Lark): a scan registers a personal bot app, whose long
//! connection hands over the user's direct messages; the farm's words go
//! out through the open API as the bot.
//!
//! The long connection is Feishu's own framing: protobuf frames over a
//! WebSocket (`pbbp2.Frame` in its SDKs), a ping every interval the
//! endpoint asks for, and each event acknowledged by its frame sent back
//! with `{"code":200}`.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use vibevalley_i18n::t;
use vibevalley_protocol::{ConnectorID, ConnectorLogin, ConnectorState};

use super::adapter::{Adapter, AppFailed, Inbound, Linked, LoginIo, Progress, Receiving, TokenCache, client, timed};
use crate::infra::setting::Secret;
use crate::now;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Domain {
    Feishu,
    Lark,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keys {
    app_id: String,
    app_secret: Secret,
    domain: Domain,
}

/// Where each domain's two services are reached.
pub struct Hosts {
    pub feishu_accounts: String,
    pub lark_accounts: String,
    pub feishu_open: String,
    pub lark_open: String,
}

// What the registration endpoint answers; it answers JSON even with an error status (a pending poll is a 400).
#[derive(Deserialize)]
struct RegistrationInit {
    #[serde(default)]
    supported_auth_methods: Vec<String>,
}

#[derive(Deserialize)]
struct RegistrationBegin {
    device_code: Option<String>,
    verification_uri_complete: Option<String>,
    interval: Option<f64>,
    expires_in: Option<f64>,
    expire_in: Option<f64>,
}

#[derive(Deserialize)]
struct UserInfo {
    tenant_brand: Option<String>,
    open_id: Option<String>,
}

#[derive(Deserialize)]
struct RegistrationPoll {
    client_id: Option<String>,
    client_secret: Option<String>,
    error: Option<String>,
    user_info: Option<UserInfo>,
}

enum Polled {
    Succeeded(Linked<Keys>),
    Failed(String),
    Pending(Domain),
}

#[derive(Deserialize)]
struct TenantToken {
    code: Option<i64>,
    msg: Option<String>,
    tenant_access_token: Option<String>,
    expire: Option<i64>,
}

#[derive(Deserialize)]
struct SentData {
    message_id: Option<String>,
}

#[derive(Deserialize)]
struct SendAnswer {
    code: Option<i64>,
    msg: Option<String>,
    data: Option<SentData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ClientConfig {
    ping_interval: Option<u64>,
}

#[derive(Deserialize)]
struct EndpointData {
    #[serde(rename = "URL")]
    url: Option<String>,
    #[serde(rename = "ClientConfig")]
    client_config: Option<ClientConfig>,
}

#[derive(Deserialize)]
struct EndpointAnswer {
    code: Option<i64>,
    msg: Option<String>,
    data: Option<EndpointData>,
}

#[derive(Deserialize)]
struct EventHeader {
    event_type: Option<String>,
}

#[derive(Deserialize)]
struct EventHead {
    header: Option<EventHeader>,
}

#[derive(Deserialize)]
struct SenderId {
    open_id: Option<String>,
}

#[derive(Deserialize)]
struct Sender {
    sender_id: Option<SenderId>,
    sender_type: Option<String>,
}

#[derive(Deserialize)]
struct Said {
    message_id: String,
    /// p2p for a direct chat; the farm takes only those.
    chat_type: Option<String>,
    message_type: Option<String>,
    /// JSON, as Feishu sends it.
    content: Option<String>,
    parent_id: Option<String>,
}

#[derive(Deserialize)]
struct Receive {
    sender: Sender,
    message: Said,
}

#[derive(Deserialize)]
struct Received {
    event: Receive,
}

/// A text message's content: {"text": …}.
#[derive(Deserialize)]
struct TextContent {
    text: Option<String>,
}

/// The user's direct message in an event's JSON; none for any other event.
fn inbound_of(payload: &[u8]) -> Option<Inbound> {
    let head: EventHead = serde_json::from_slice(payload).ok()?;
    if head.header?.event_type.as_deref() != Some("im.message.receive_v1") {
        return None;
    }
    let Receive { sender, message } = serde_json::from_slice::<Received>(payload).ok()?.event;
    let from = sender.sender_id?.open_id.filter(|id| !id.is_empty())?;
    if sender.sender_type.as_deref() != Some("user") || message.chat_type.as_deref() != Some("p2p") {
        return None;
    }
    let text = match message.message_type.as_deref() {
        Some("text") => serde_json::from_str::<TextContent>(message.content.as_deref().unwrap_or(""))
            .ok()
            .and_then(|c| c.text)
            .unwrap_or_default()
            .trim()
            .to_string(),
        Some("image") => t("server.connector.media.image", &[]),
        Some("file") => t("server.connector.media.file", &[]),
        Some("audio") => t("server.connector.media.audio", &[]),
        Some("media") => t("server.connector.media.video", &[]),
        Some("sticker") => t("server.connector.media.sticker", &[]),
        _ => t("server.connector.media.message", &[]),
    };
    Some(Inbound {
        id: message.message_id,
        from,
        text,
        reply: String::new(),
        quoted: message.parent_id.unwrap_or_default(),
    })
}

/// One frame of the long connection (`pbbp2.Frame`).
#[derive(Debug, Clone, Default, PartialEq)]
struct Frame {
    seq_id: u64,
    log_id: u64,
    service: i32,
    /// 0 is control (ping, pong), 1 is data (an event).
    method: i32,
    headers: Vec<(String, String)>,
    payload_encoding: Option<String>,
    payload_type: Option<String>,
    payload: Option<Vec<u8>>,
    log_id_new: Option<String>,
}

const CONTROL: i32 = 0;
const DATA: i32 = 1;

fn put_varint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

fn put_bytes(out: &mut Vec<u8>, field: u64, bytes: &[u8]) {
    put_varint(out, field << 3 | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn put_number(out: &mut Vec<u8>, field: u64, n: u64) {
    put_varint(out, field << 3);
    put_varint(out, n);
}

fn take_varint(bytes: &mut &[u8]) -> Option<u64> {
    let mut n = 0u64;
    for shift in (0..64).step_by(7) {
        let (first, rest) = bytes.split_first()?;
        *bytes = rest;
        n |= u64::from(first & 0x7f) << shift;
        if first & 0x80 == 0 {
            return Some(n);
        }
    }
    None
}

fn take_bytes<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = usize::try_from(take_varint(bytes)?).ok()?;
    let (taken, rest) = bytes.split_at_checked(len)?;
    *bytes = rest;
    Some(taken)
}

/// Each field of a protobuf message: its number, and its varint or its bytes.
fn fields(mut bytes: &[u8], mut each: impl FnMut(u64, Result<u64, &[u8]>) -> Option<()>) -> Option<()> {
    while !bytes.is_empty() {
        let tag = take_varint(&mut bytes)?;
        match tag & 7 {
            0 => each(tag >> 3, Ok(take_varint(&mut bytes)?))?,
            2 => each(tag >> 3, Err(take_bytes(&mut bytes)?))?,
            1 => bytes = bytes.split_at_checked(8)?.1,
            5 => bytes = bytes.split_at_checked(4)?.1,
            _ => return None,
        }
    }
    Some(())
}

fn text(bytes: &[u8]) -> Option<String> {
    String::from_utf8(bytes.to_vec()).ok()
}

impl Frame {
    fn decode(bytes: &[u8]) -> Option<Frame> {
        let mut frame = Frame::default();
        fields(bytes, |field, value| {
            match (field, value) {
                (1, Ok(n)) => frame.seq_id = n,
                (2, Ok(n)) => frame.log_id = n,
                (3, Ok(n)) => frame.service = n as i32,
                (4, Ok(n)) => frame.method = n as i32,
                (5, Err(header)) => {
                    let (mut key, mut value) = (String::new(), String::new());
                    fields(header, |field, part| {
                        match (field, part) {
                            (1, Err(k)) => key = text(k)?,
                            (2, Err(v)) => value = text(v)?,
                            _ => {}
                        }
                        Some(())
                    })?;
                    frame.headers.push((key, value));
                }
                (6, Err(b)) => frame.payload_encoding = Some(text(b)?),
                (7, Err(b)) => frame.payload_type = Some(text(b)?),
                (8, Err(b)) => frame.payload = Some(b.to_vec()),
                (9, Err(b)) => frame.log_id_new = Some(text(b)?),
                _ => {}
            }
            Some(())
        })?;
        Some(frame)
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = vec![];
        put_number(&mut out, 1, self.seq_id);
        put_number(&mut out, 2, self.log_id);
        put_number(&mut out, 3, self.service as i64 as u64);
        put_number(&mut out, 4, self.method as i64 as u64);
        for (key, value) in &self.headers {
            let mut header = vec![];
            put_bytes(&mut header, 1, key.as_bytes());
            put_bytes(&mut header, 2, value.as_bytes());
            put_bytes(&mut out, 5, &header);
        }
        if let Some(x) = &self.payload_encoding {
            put_bytes(&mut out, 6, x.as_bytes());
        }
        if let Some(x) = &self.payload_type {
            put_bytes(&mut out, 7, x.as_bytes());
        }
        if let Some(x) = &self.payload {
            put_bytes(&mut out, 8, x);
        }
        if let Some(x) = &self.log_id_new {
            put_bytes(&mut out, 9, x.as_bytes());
        }
        out
    }

    fn header(&self, key: &str) -> &str {
        self.headers.iter().find(|(k, _)| k == key).map_or("", |(_, v)| v.as_str())
    }

    fn ping(service: i32) -> Frame {
        Frame {
            service,
            method: CONTROL,
            headers: vec![("type".into(), "ping".into())],
            ..Frame::default()
        }
    }

    /// The acknowledgement of a data frame: itself, with the answer as its payload.
    fn acknowledged(mut self) -> Frame {
        self.headers.push(("biz_rt".into(), "0".into()));
        self.payload = Some(br#"{"code":200}"#.to_vec());
        self
    }
}

/// An event's whole payload once every part of it came; a long event comes in `sum` frames.
fn whole(parts: &mut HashMap<String, Vec<Option<Vec<u8>>>>, frame: &Frame) -> Option<Vec<u8>> {
    let payload = frame.payload.clone().unwrap_or_default();
    let sum: usize = frame.header("sum").parse().unwrap_or(1);
    if sum <= 1 {
        return Some(payload);
    }
    let id = frame.header("message_id").to_string();
    let at: usize = frame.header("seq").parse().ok().filter(|at| *at < sum)?;
    let slots = parts.entry(id.clone()).or_insert_with(|| vec![None; sum]);
    if slots.len() != sum {
        *slots = vec![None; sum];
    }
    slots[at] = Some(payload);
    if slots.iter().any(Option::is_none) {
        return None;
    }
    Some(parts.remove(&id)?.into_iter().flatten().flatten().collect())
}

pub struct Feishu {
    hosts: Hosts,
    /// A registration is asked about no more often than this.
    poll_floor: Duration,
    token: TokenCache,
}

impl Feishu {
    pub fn new(hosts: Hosts, poll_floor: Duration) -> Feishu {
        Feishu {
            hosts,
            poll_floor,
            token: TokenCache::default(),
        }
    }

    fn accounts(&self, domain: Domain) -> &str {
        match domain {
            Domain::Feishu => &self.hosts.feishu_accounts,
            Domain::Lark => &self.hosts.lark_accounts,
        }
    }

    fn open(&self, domain: Domain) -> &str {
        match domain {
            Domain::Feishu => &self.hosts.feishu_open,
            Domain::Lark => &self.hosts.lark_open,
        }
    }

    async fn form<T: DeserializeOwned>(&self, domain: Domain, fields: &[(&str, &str)]) -> Result<T, AppFailed> {
        let why = |e: String| AppFailed::failed(t("server.connector.feishu.register", &[("why", e.into())]));
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish();
        timed(
            Duration::from_secs(10),
            || AppFailed::failed(t("server.connector.feishu.registerTimeout", &[])),
            async {
                let answer = client()?
                    .post(format!("{}/oauth/v1/app/registration", self.accounts(domain)))
                    .header("content-type", "application/x-www-form-urlencoded")
                    .body(body)
                    .send()
                    .await
                    .map_err(|e| why(e.to_string()))?;
                answer.json().await.map_err(|e| why(e.to_string()))
            },
        )
        .await
    }

    /// One poll; one that does not answer reads as still pending.
    async fn poll(&self, device_code: &str, domain: Domain) -> Polled {
        let Ok(answer) = self
            .form::<RegistrationPoll>(domain, &[("action", "poll"), ("device_code", device_code), ("tp", "ob_app")])
            .await
        else {
            return Polled::Pending(domain);
        };
        let lark = answer.user_info.as_ref().and_then(|u| u.tenant_brand.as_deref()) == Some("lark");
        let domain = if lark { Domain::Lark } else { domain };
        if let (Some(app_id), Some(app_secret)) = (answer.client_id, answer.client_secret) {
            return Polled::Succeeded(Linked {
                keys: Keys {
                    app_id,
                    app_secret: Secret::new(app_secret),
                    domain,
                },
                user: answer.user_info.and_then(|u| u.open_id).unwrap_or_default(),
            });
        }
        match answer.error.as_deref() {
            Some("access_denied") => Polled::Failed(t("server.connector.feishu.denied", &[])),
            Some("expired_token") => Polled::Failed(t("server.connector.feishu.qrExpired", &[])),
            _ => Polled::Pending(domain),
        }
    }

    async fn tenant_token(&self, keys: &Keys) -> Result<String, AppFailed> {
        let of = format!("{}\u{0}{}", keys.app_id, keys.app_secret.expose());
        let at = now();
        if let Some(cached) = self.token.get(&of, at) {
            return Ok(cached);
        }
        let why = |e: String| AppFailed::failed(t("server.connector.feishu.send", &[("why", e.into())]));
        let answer = client()?
            .post(format!("{}/open-apis/auth/v3/tenant_access_token/internal", self.open(keys.domain)))
            .json(&json!({ "app_id": keys.app_id, "app_secret": keys.app_secret.expose() }))
            .send()
            .await
            .map_err(|e| why(e.to_string()))?;
        let body: TenantToken = answer.json().await.map_err(|e| why(e.to_string()))?;
        let Some(token) = body.tenant_access_token.filter(|x| !x.is_empty() && body.code.unwrap_or(0) == 0) else {
            return Err(why(format!("{} {}", body.code.unwrap_or(0), body.msg.unwrap_or_default())));
        };
        self.token.put(of, token.clone(), at, body.expire.unwrap_or(7200));
        Ok(token)
    }

    /// Until the long connection fails; an event is acknowledged once what it carries is kept.
    async fn listen(&self, keys: &Keys, io: &Receiving<'_>) -> Result<std::convert::Infallible, AppFailed> {
        let lost = |why: String| AppFailed::failed(t("server.connector.feishu.disconnected", &[("why", why.into())]));
        let answer = client()?
            .post(format!("{}/callback/ws/endpoint", self.open(keys.domain)))
            .header("locale", "zh")
            .json(&json!({ "AppID": keys.app_id, "AppSecret": keys.app_secret.expose() }))
            .send()
            .await
            .map_err(|e| lost(e.to_string()))?;
        let endpoint: EndpointAnswer = answer.json().await.map_err(|e| lost(e.to_string()))?;
        let data = endpoint.data.filter(|_| endpoint.code.unwrap_or(0) == 0);
        let Some((address, config)) = data.and_then(|d| Some((d.url.filter(|u| !u.is_empty())?, d.client_config))) else {
            return Err(lost(format!("{} {}", endpoint.code.unwrap_or(0), endpoint.msg.unwrap_or_default())));
        };
        let service: i32 = url::Url::parse(&address)
            .ok()
            .and_then(|u| u.query_pairs().find(|(k, _)| k == "service_id").and_then(|(_, v)| v.parse().ok()))
            .unwrap_or(0);
        let every = Duration::from_secs(config.and_then(|c| c.ping_interval).filter(|s| *s > 0).unwrap_or(120));
        let (mut ws, _) = tokio_tungstenite::connect_async(address.as_str()).await.map_err(|e| lost(e.to_string()))?;
        let mut ping = tokio::time::interval(every);
        let mut parts = HashMap::new();
        loop {
            let message = tokio::select! {
                message = ws.next() => message,
                _ = ping.tick() => {
                    ws.send(WsMessage::binary(Frame::ping(service).encode())).await.map_err(|e| lost(e.to_string()))?;
                    continue;
                }
            };
            let bytes = match message {
                Some(Ok(WsMessage::Binary(bytes))) => bytes,
                Some(Ok(WsMessage::Close(_))) | None => return Err(lost("closed".into())),
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(lost(e.to_string())),
            };
            let Some(frame) = Frame::decode(&bytes) else { continue };
            if frame.method != DATA {
                continue;
            }
            if frame.header("type") == "event" {
                let Some(payload) = whole(&mut parts, &frame) else { continue };
                if let Some(m) = inbound_of(&payload) {
                    (io.accept)(vec![m], "")?;
                }
            }
            ws.send(WsMessage::binary(frame.acknowledged().encode()))
                .await
                .map_err(|e| lost(e.to_string()))?;
        }
    }
}

/// Personal-agent codes land on /page/cli; the query stays as it is.
fn scan_link(link: String) -> String {
    match url::Url::parse(&link) {
        Ok(mut parsed) if matches!(parsed.host_str(), Some("open.feishu.cn" | "open.larksuite.com")) && parsed.path() == "/page/launcher" => {
            parsed.set_path("/page/cli");
            parsed.to_string()
        }
        _ => link,
    }
}

impl Adapter for Feishu {
    type Keys = Keys;
    const ID: ConnectorID = ConnectorID::Feishu;
    const MAX_CHARS: usize = 4000;

    async fn login(&self, _input: &ConnectorLogin, io: &LoginIo<'_>) -> Result<Linked<Keys>, AppFailed> {
        let init: RegistrationInit = self.form(Domain::Feishu, &[("action", "init")]).await?;
        if !init.supported_auth_methods.iter().any(|m| m == "client_secret") {
            return Err(AppFailed::failed(t("server.connector.feishu.noQr", &[])));
        }
        let begin: RegistrationBegin = self
            .form(
                Domain::Feishu,
                &[
                    ("action", "begin"),
                    ("archetype", "PersonalAgent"),
                    ("auth_method", "client_secret"),
                    ("request_user_info", "open_id"),
                ],
            )
            .await?;
        let given = |x: Option<String>| x.filter(|v| !v.is_empty());
        let (Some(device_code), Some(link)) = (given(begin.device_code), given(begin.verification_uri_complete)) else {
            return Err(AppFailed::failed(t("server.connector.feishu.noLink", &[])));
        };
        let every = Duration::from_secs_f64(begin.interval.unwrap_or(5.0).max(0.0)).max(self.poll_floor);
        let expires = Duration::from_secs_f64(begin.expires_in.or(begin.expire_in).unwrap_or(600.0).max(1.0));
        (io.progress)(Progress {
            state: ConnectorState::Waiting,
            qr: scan_link(link),
        });
        // Asked every interval, on the domain the last answer named, until it is done one way or the other.
        timed(expires, || AppFailed::failed(t("server.connector.feishu.tooLong", &[])), async {
            let mut domain = Domain::Feishu;
            loop {
                tokio::time::sleep(every).await;
                match self.poll(&device_code, domain).await {
                    Polled::Succeeded(linked) => {
                        if linked.keys.app_id.trim().is_empty() || linked.keys.app_secret.expose().trim().is_empty() {
                            return Err(AppFailed::failed(t("server.connector.feishu.incomplete", &[])));
                        }
                        return Ok(linked);
                    }
                    Polled::Failed(reason) => return Err(AppFailed::failed(reason)),
                    Polled::Pending(next) => domain = next,
                }
            }
        })
        .await
    }

    async fn receive(&self, keys: &Keys, io: &Receiving<'_>) -> AppFailed {
        match self.listen(keys, io).await {
            Err(e) => e,
            Ok(never) => match never {},
        }
    }

    async fn send(&self, keys: &Keys, to: &str, text: &str, _reply: &str) -> Result<String, AppFailed> {
        let why = |e: String| AppFailed::failed(t("server.connector.feishu.send", &[("why", e.into())]));
        timed(Duration::from_secs(25), || why("timed out".into()), async {
            let token = self.tenant_token(keys).await?;
            let answer = client()?
                .post(format!("{}/open-apis/im/v1/messages?receive_id_type=open_id", self.open(keys.domain)))
                .bearer_auth(token)
                .json(&json!({ "receive_id": to, "msg_type": "text", "content": json!({ "text": text }).to_string() }))
                .send()
                .await
                .map_err(|e| why(e.to_string()))?;
            let body: SendAnswer = answer.json().await.map_err(|e| why(e.to_string()))?;
            if let Some(code) = body.code.filter(|c| *c != 0) {
                return Err(why(format!("{code} {}", body.msg.unwrap_or_default())));
            }
            body.data
                .and_then(|d| d.message_id)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| AppFailed::failed(t("server.connector.feishu.noId", &[])))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_survives_the_wire_and_unknown_fields_are_skipped() {
        let frame = Frame {
            seq_id: 300,
            log_id: u64::MAX,
            service: 7,
            method: DATA,
            headers: vec![("type".into(), "event".into()), ("message_id".into(), "m-1".into())],
            payload_encoding: None,
            payload_type: Some("json".into()),
            payload: Some("{\"你\":1}".as_bytes().to_vec()),
            log_id_new: Some("log".into()),
        };
        let mut bytes = frame.encode();
        // A field this side does not know: number 15, a varint.
        bytes.extend_from_slice(&[15 << 3, 1]);
        assert_eq!(Frame::decode(&bytes), Some(frame));
        // Field 1 = 300 is the bytes protobuf writes for it.
        assert_eq!(
            &Frame {
                seq_id: 300,
                ..Frame::default()
            }
            .encode()[..3],
            &[0x08, 0xac, 0x02]
        );
        assert_eq!(Frame::decode(&[0x0a, 0x05, 1]), None);
    }

    #[test]
    fn a_long_event_is_whole_once_every_part_came() {
        let part = |seq: &str, payload: &str| Frame {
            method: DATA,
            headers: vec![("message_id".into(), "m".into()), ("sum".into(), "2".into()), ("seq".into(), seq.into())],
            payload: Some(payload.as_bytes().to_vec()),
            ..Frame::default()
        };
        let mut parts = HashMap::new();
        assert_eq!(whole(&mut parts, &part("1", "world")), None);
        assert_eq!(whole(&mut parts, &part("0", "hello ")), Some(b"hello world".to_vec()));
        assert!(parts.is_empty());
    }

    #[test]
    fn only_the_users_direct_words_are_taken() {
        vibevalley_i18n::set_locale("zh");
        let event = |chat: &str, sender: &str, kind: &str| {
            json!({
                "schema": "2.0",
                "header": { "event_type": "im.message.receive_v1" },
                "event": {
                    "sender": { "sender_id": { "open_id": "ou_1" }, "sender_type": sender },
                    "message": { "message_id": "om_1", "chat_type": chat, "message_type": kind, "content": "{\"text\":\" 你好 \"}", "parent_id": "om_0" },
                },
            })
            .to_string()
        };
        assert_eq!(
            inbound_of(event("p2p", "user", "text").as_bytes()),
            Some(Inbound {
                id: "om_1".into(),
                from: "ou_1".into(),
                text: "你好".into(),
                reply: String::new(),
                quoted: "om_0".into(),
            })
        );
        assert_eq!(inbound_of(event("p2p", "user", "image").as_bytes()).map(|m| m.text), Some("[图片]".into()));
        assert_eq!(inbound_of(event("group", "user", "text").as_bytes()), None);
        assert_eq!(inbound_of(event("p2p", "app", "text").as_bytes()), None);
        assert_eq!(inbound_of(br#"{"header":{"event_type":"im.chat.updated_v1"},"event":{}}"#), None);
    }

    #[test]
    fn a_launcher_link_becomes_the_cli_page() {
        assert_eq!(
            scan_link("https://open.feishu.cn/page/launcher?user_code=AB".into()),
            "https://open.feishu.cn/page/cli?user_code=AB"
        );
        assert_eq!(
            scan_link("https://example.com/page/launcher?x=1".into()),
            "https://example.com/page/launcher?x=1"
        );
    }
}
