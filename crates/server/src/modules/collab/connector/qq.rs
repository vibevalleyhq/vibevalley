//! QQ's bot API: the user gives the bot's AppID and secret, pairs by a
//! message, and the bot hears direct (C2C) messages over the gateway's
//! WebSocket; replies are passive, each to a message of the user's.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use vibevalley_i18n::t;
use vibevalley_protocol::{ConnectorID, ConnectorLogin};

use super::adapter::{Adapter, AppFailed, FailedKind, Inbound, Linked, LoginIo, Receiving, client, timed};
use crate::modules::infra::setting::Secret;
use crate::now;

pub const API: &str = "https://api.sgroup.qq.com";
pub const TOKEN_URL: &str = "https://bots.qq.com/app/getAppAccessToken";
const INTENTS: u32 = 1 << 25;
/// QQ takes passive replies to a message for minutes only: the counts of the latest messages answered are enough.
const REPLIES_KEPT: usize = 256;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keys {
    app_id: String,
    secret: Secret,
}

/// A number QQ sends as a number or as text.
#[derive(Deserialize)]
#[serde(untagged)]
enum Seconds {
    Number(f64),
    Text(String),
}

// A refused AppID or secret answers without a token, with QQ's reason in message: that reason is what the user sees.
#[derive(Deserialize)]
struct TokenAnswer {
    access_token: Option<String>,
    expires_in: Option<Seconds>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct GatewayAnswer {
    url: String,
}

#[derive(Deserialize)]
struct SendAnswer {
    id: Option<String>,
    message: Option<String>,
    code: Option<i64>,
}

#[derive(Deserialize)]
struct Frame {
    op: i64,
    // Frames that are not dispatches may carry s and t as null.
    s: Option<i64>,
    t: Option<String>,
    #[serde(default)]
    d: serde_json::Value,
}

#[derive(Deserialize)]
struct Hello {
    heartbeat_interval: Option<u64>,
}

#[derive(Deserialize)]
struct Author {
    user_openid: Option<String>,
}

/// A C2C message as the gateway dispatches it; fields it leaves out read as none.
#[derive(Deserialize)]
struct C2c {
    id: Option<String>,
    content: Option<String>,
    author: Option<Author>,
    #[serde(default)]
    attachments: Vec<serde::de::IgnoredAny>,
}

#[derive(Debug, PartialEq)]
enum Event {
    Hello { heartbeat: Duration },
    Message(Inbound),
    Reconnect,
    Invalid,
    Other,
}

/// One gateway frame: its sequence number and what it asks of the listener. None when it is not the gateway's JSON.
fn decode(raw: &str) -> Option<(Option<i64>, Event)> {
    let frame: Frame = serde_json::from_str(raw).ok()?;
    let event = match frame.op {
        10 => {
            let asked = serde_json::from_value::<Hello>(frame.d)
                .ok()
                .and_then(|h| h.heartbeat_interval)
                .filter(|ms| *ms > 0);
            Event::Hello {
                heartbeat: Duration::from_millis(asked.unwrap_or(30_000)),
            }
        }
        0 if frame.t.as_deref() == Some("C2C_MESSAGE_CREATE") => match serde_json::from_value::<C2c>(frame.d).ok().and_then(message_of) {
            Some(m) => Event::Message(m),
            None => Event::Other,
        },
        7 => Event::Reconnect,
        9 => Event::Invalid,
        _ => Event::Other,
    };
    Some((frame.s, event))
}

fn message_of(m: C2c) -> Option<Inbound> {
    let id = m.id.filter(|x| !x.is_empty())?;
    let from = m.author?.user_openid.filter(|x| !x.is_empty())?;
    let content = m.content.unwrap_or_default();
    let attached = if m.attachments.is_empty() {
        String::new()
    } else {
        t("server.connector.media.attachment", &[])
    };
    let parts: Vec<&str> = [content.trim(), attached.as_str()].into_iter().filter(|p| !p.is_empty()).collect();
    Some(Inbound {
        text: parts.join("\n"),
        reply: id.clone(),
        id,
        from,
        quoted: String::new(),
    })
}

/// The next msg_seq for a reply to `msg`: QQ refuses the same (msg_id, msg_seq) twice. Newest last: a message
/// answered again moves to the end, and the oldest goes past the cap.
fn next_reply_seq(seqs: &mut Vec<(String, u32)>, msg: &str) -> u32 {
    let next = match seqs.iter().position(|(id, _)| id == msg) {
        Some(at) => seqs.remove(at).1 + 1,
        None => 1,
    };
    seqs.push((msg.to_string(), next));
    if seqs.len() > REPLIES_KEPT {
        seqs.remove(0);
    }
    next
}

struct Token {
    of: String,
    token: String,
    until: i64,
}

pub struct Qq {
    api: String,
    token_at: String,
    /// One active QQ account; changing its credentials evicts the previous token.
    token: Mutex<Option<Token>>,
    reply_seq: Mutex<Vec<(String, u32)>>,
}

impl Qq {
    pub fn new(api: String, token_at: String) -> Qq {
        Qq {
            api,
            token_at,
            token: Mutex::new(None),
            reply_seq: Mutex::new(vec![]),
        }
    }

    async fn token(&self, keys: &Keys) -> Result<String, AppFailed> {
        let of = format!("{}\u{0}{}", keys.app_id, keys.secret.expose());
        let at = now();
        if let Some(cached) = self.token.lock().as_ref().filter(|c| c.of == of && c.until > at) {
            return Ok(cached.token.clone());
        }
        let auth = |why: String| AppFailed::failed(t("server.connector.qq.auth", &[("why", why.into())]));
        let body: TokenAnswer = timed(
            Duration::from_secs(20),
            || AppFailed::failed(t("server.connector.qq.authTimeout", &[])),
            async {
                let answer = client()?
                    .post(&self.token_at)
                    .json(&json!({ "appId": keys.app_id, "clientSecret": keys.secret.expose() }))
                    .send()
                    .await
                    .map_err(|e| auth(e.to_string()))?;
                answer.json().await.map_err(|e| auth(e.to_string()))
            },
        )
        .await?;
        let Some(token) = body.access_token.filter(|x| !x.is_empty()) else {
            return Err(auth(
                body.message.filter(|m| !m.is_empty()).unwrap_or_else(|| t("server.connector.qq.badKeys", &[])),
            ));
        };
        let seconds = match body.expires_in {
            Some(Seconds::Number(n)) => n as i64,
            Some(Seconds::Text(s)) => s.trim().parse().unwrap_or(7200),
            None => 7200,
        };
        *self.token.lock() = Some(Token {
            of,
            token: token.clone(),
            until: at + (seconds - 60) * 1000,
        });
        Ok(token)
    }

    fn authorized(&self, call: reqwest::RequestBuilder, keys: &Keys, token: &str) -> reqwest::RequestBuilder {
        call.header("Authorization", format!("QQBot {token}")).header("X-Union-Appid", &keys.app_id)
    }

    /// Until the gateway closes or fails, taking each message before the next is read.
    async fn listen(&self, keys: &Keys, io: &Receiving<'_>) -> Result<std::convert::Infallible, AppFailed> {
        let token = self.token(keys).await?;
        let gateway_failed = |why: String| AppFailed::failed(t("server.connector.qq.gateway", &[("why", why.into())]));
        let answer = self
            .authorized(client()?.get(format!("{}/gateway", self.api)), keys, &token)
            .send()
            .await
            .map_err(|e| gateway_failed(e.to_string()))?;
        let gateway: GatewayAnswer = answer.json().await.map_err(|e| gateway_failed(e.to_string()))?;
        if gateway.url.is_empty() {
            return Err(AppFailed::failed(t("server.connector.qq.noGateway", &[])));
        }
        let broken = || AppFailed::failed(t("server.connector.qq.gatewayError", &[]));
        let (mut ws, _) = tokio_tungstenite::connect_async(gateway.url.as_str()).await.map_err(|_| broken())?;
        let mut seq: Option<i64> = None;
        let mut beat: Option<tokio::time::Interval> = None;
        loop {
            let frame = tokio::select! {
                frame = ws.next() => frame,
                _ = async { match beat.as_mut() { Some(b) => { b.tick().await; } None => std::future::pending().await } } => {
                    ws.send(WsMessage::text(json!({ "op": 1, "d": seq }).to_string())).await.map_err(|_| broken())?;
                    continue;
                }
            };
            let raw = match frame {
                Some(Ok(WsMessage::Text(raw))) => raw,
                Some(Ok(WsMessage::Close(close))) => {
                    let code = close.map_or(1005, |c| u16::from(c.code));
                    return Err(AppFailed::failed(t("server.connector.qq.closed", &[("code", i64::from(code).into())])));
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return Err(broken()),
            };
            let (s, event) = decode(raw.as_str()).ok_or_else(broken)?;
            seq = s.or(seq);
            match event {
                Event::Hello { heartbeat } => {
                    let identify = json!({ "op": 2, "d": { "token": format!("QQBot {token}"), "intents": INTENTS, "shard": [0, 1], "properties": {} } });
                    ws.send(WsMessage::text(identify.to_string())).await.map_err(|_| broken())?;
                    if beat.is_none() {
                        beat = Some(tokio::time::interval_at(tokio::time::Instant::now() + heartbeat, heartbeat));
                    }
                }
                Event::Message(m) => (io.accept)(vec![m], "")?,
                Event::Reconnect => return Err(AppFailed::failed(t("server.connector.qq.reconnect", &[]))),
                Event::Invalid => return Err(AppFailed::failed(t("server.connector.qq.invalid", &[]))),
                Event::Other => {}
            }
        }
    }
}

/// A refused send, by its status: a bad login is stale; a passive reply refused (too late, too many) waits for the
/// user's next message.
fn send_failure(status: u16, message: String) -> AppFailed {
    let kind = match status {
        401 => FailedKind::Stale,
        400..=499 => FailedKind::Restricted,
        _ => FailedKind::Failed,
    };
    AppFailed::new(kind, message)
}

impl Adapter for Qq {
    type Keys = Keys;
    const ID: ConnectorID = ConnectorID::Qq;
    const MAX_CHARS: usize = 2000;

    async fn login(&self, input: &ConnectorLogin, _io: &LoginIo<'_>) -> Result<Linked<Keys>, AppFailed> {
        let given = |x: &Option<String>| x.as_deref().unwrap_or("").trim().to_string();
        let keys = Keys {
            app_id: given(&input.app_id),
            secret: Secret::new(given(&input.secret)),
        };
        if keys.app_id.is_empty() || keys.secret.is_empty() {
            return Err(AppFailed::failed(t("server.connector.qqKeys", &[])));
        }
        self.token(&keys).await?;
        Ok(Linked { keys, user: String::new() })
    }

    async fn receive(&self, keys: &Keys, io: &Receiving<'_>) -> AppFailed {
        match self.listen(keys, io).await {
            Err(e) => e,
            Ok(never) => match never {},
        }
    }

    async fn send(&self, keys: &Keys, to: &str, text: &str, reply: &str) -> Result<String, AppFailed> {
        let token = self.token(keys).await.map_err(|e| send_failure(401, e.message))?;
        let mut payload = json!({ "content": text, "msg_type": 0 });
        if !reply.is_empty() {
            payload["msg_id"] = json!(reply);
            payload["msg_seq"] = json!(next_reply_seq(&mut self.reply_seq.lock(), reply));
        }
        let failed = |why: String| AppFailed::failed(t("server.connector.qq.send", &[("why", why.into())]));
        let mut url = url::Url::parse(&self.api).map_err(|e| failed(e.to_string()))?;
        url.path_segments_mut()
            .map_err(|()| failed("no path".into()))?
            .pop_if_empty()
            .extend(["v2", "users", to, "messages"]);
        let (status, bytes) = timed(Duration::from_secs(25), || failed("timed out".into()), async {
            let answer = self
                .authorized(client()?.post(url), keys, &token)
                .json(&payload)
                .send()
                .await
                .map_err(|e| failed(e.to_string()))?;
            let status = answer.status();
            Ok((status, answer.bytes().await.map_err(|e| failed(e.to_string()))?))
        })
        .await?;
        let read = serde_json::from_slice::<SendAnswer>(&bytes);
        if !status.is_success() {
            let code = read.as_ref().ok().and_then(|r| r.code).unwrap_or(i64::from(status.as_u16()));
            let message = read.ok().and_then(|r| r.message).unwrap_or_default();
            return Err(send_failure(status.as_u16(), failed(format!("{code} {message}").trim().to_string()).message));
        }
        let read = read.map_err(|e| AppFailed::failed(t("server.connector.qq.unread", &[("why", e.to_string().into())])))?;
        match read.id.filter(|id| !id.is_empty()) {
            Some(id) if read.code.unwrap_or(0) == 0 => Ok(id),
            _ => Err(AppFailed::failed(t(
                "server.connector.qq.noId",
                &[("why", read.message.unwrap_or_default().into())],
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_event_is_decoded_and_wrong_field_types_are_refused() {
        vibevalley_i18n::set_locale("zh");
        let dispatch = r#"{"op":0,"s":7,"t":"C2C_MESSAGE_CREATE","d":{"id":"m1","content":" 你好 ","author":{"user_openid":"u1"},"attachments":[{}]}}"#;
        assert_eq!(
            decode(dispatch),
            Some((
                Some(7),
                Event::Message(Inbound {
                    id: "m1".into(),
                    from: "u1".into(),
                    text: "你好\n[附件]".into(),
                    reply: "m1".into(),
                    quoted: String::new(),
                })
            ))
        );
        assert_eq!(decode("null"), None);
        assert_eq!(decode(r#"{"op":"0"}"#), None);
        assert_eq!(decode(r#"{"op":0,"s":"7"}"#), None);
        assert_eq!(
            decode(r#"{"op":0,"s":1,"t":"C2C_MESSAGE_CREATE","d":{"id":"m2"}}"#),
            Some((Some(1), Event::Other))
        );
    }

    #[test]
    fn a_frame_that_is_not_a_dispatch_may_carry_s_and_t_as_null() {
        assert_eq!(
            decode(r#"{"op":10,"s":null,"t":null,"d":{"heartbeat_interval":41250}}"#),
            Some((
                None,
                Event::Hello {
                    heartbeat: Duration::from_millis(41_250)
                }
            ))
        );
        assert_eq!(decode(r#"{"op":11,"s":null,"t":null}"#), Some((None, Event::Other)));
        assert_eq!(decode(r#"{"op":7}"#), Some((None, Event::Reconnect)));
        assert_eq!(decode(r#"{"op":9,"d":false}"#), Some((None, Event::Invalid)));
    }

    #[test]
    fn reply_numbers_count_each_message_and_keep_only_the_latest_messages() {
        let mut seqs = vec![];
        assert_eq!(next_reply_seq(&mut seqs, "a"), 1);
        assert_eq!(next_reply_seq(&mut seqs, "a"), 2);
        assert_eq!(next_reply_seq(&mut seqs, "b"), 1);
        for i in 0..REPLIES_KEPT {
            next_reply_seq(&mut seqs, &format!("m{i}"));
        }
        assert_eq!(seqs.len(), REPLIES_KEPT);
        // "a" and "b" went past the cap: answered again, they count from one.
        assert_eq!(next_reply_seq(&mut seqs, "a"), 1);
        assert_eq!(next_reply_seq(&mut seqs, "m255"), 2);
    }
}
