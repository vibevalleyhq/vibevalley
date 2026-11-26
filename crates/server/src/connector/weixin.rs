//! WeChat through its iLink bot API: a QR login, a long poll for what the
//! user says, and replies that ride on the context of the user's latest
//! message.

use std::time::Duration;

use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use vibevalley_i18n::t;
use vibevalley_protocol::{ConnectorID, ConnectorLogin, ConnectorState};

use super::adapter::{Adapter, AppFailed, FailedKind, Inbound, Linked, LoginIo, Progress, Receiving, VendorId, client, timed};
use crate::setting::Secret;

/// A confirmed login may name another host for its account.
pub const BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const VERSION: (u32, u32, u32) = (2, 4, 10);
const STALE_TOKEN: i64 = -14;
const RESTRICTED: i64 = -2;
/// The long poll's own length until WeChat says another.
const POLL: Duration = Duration::from_secs(35);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keys {
    token: Secret,
    bot_id: String,
    base_url: String,
}

#[derive(Deserialize)]
struct TextItem {
    text: Option<String>,
}

#[derive(Deserialize)]
struct FileItem {
    file_name: Option<String>,
}

#[derive(Deserialize)]
struct Quoted {
    svr_id: Option<VendorId>,
}

#[derive(Deserialize)]
struct Item {
    r#type: Option<i64>,
    text_item: Option<TextItem>,
    voice_item: Option<TextItem>,
    file_item: Option<FileItem>,
    ref_msg: Option<Quoted>,
}

#[derive(Deserialize)]
struct Message {
    message_id: Option<VendorId>,
    from_user_id: Option<String>,
    message_type: Option<i64>,
    context_token: Option<String>,
    group_id: Option<String>,
    #[serde(default)]
    item_list: Vec<Item>,
}

#[derive(Deserialize, Default)]
struct Updates {
    ret: Option<i64>,
    errcode: Option<i64>,
    errmsg: Option<String>,
    #[serde(default)]
    msgs: Vec<Message>,
    get_updates_buf: Option<String>,
    longpolling_timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct QrCode {
    qrcode: Option<String>,
    qrcode_img_content: Option<String>,
}

#[derive(Deserialize, Default)]
struct QrStatus {
    status: Option<String>,
    bot_token: Option<String>,
    ilink_bot_id: Option<String>,
    baseurl: Option<String>,
    ilink_user_id: Option<String>,
    redirect_host: Option<String>,
}

#[derive(Deserialize)]
struct SendAnswer {
    ret: Option<i64>,
    errcode: Option<i64>,
    errmsg: Option<String>,
    message_id: Option<VendorId>,
}

#[derive(Deserialize)]
struct ErrorAnswer {
    ret: Option<i64>,
    errcode: Option<i64>,
    errmsg: Option<String>,
}

/// WeChat's code of a refusal, when the answer carries one.
fn refusal(ret: Option<i64>, errcode: Option<i64>) -> Option<i64> {
    ret.filter(|r| *r != 0).or(errcode.filter(|e| *e != 0))
}

fn failure_of(label: &str, code: i64, errmsg: Option<String>) -> AppFailed {
    let kind = match code {
        STALE_TOKEN => FailedKind::Stale,
        RESTRICTED => FailedKind::Restricted,
        _ => FailedKind::Failed,
    };
    let why = errmsg.filter(|m| !m.is_empty()).unwrap_or_else(|| code.to_string());
    if kind == FailedKind::Stale {
        AppFailed::new(kind, t("server.connector.staleLogin", &[]))
    } else {
        AppFailed::new(kind, format!("{label}: {why}"))
    }
}

fn http_failure(label: &str, status: u16, bytes: &[u8]) -> AppFailed {
    if let Ok(err) = serde_json::from_slice::<ErrorAnswer>(bytes)
        && let Some(code) = refusal(err.ret, err.errcode)
    {
        return failure_of(label, code, err.errmsg);
    }
    match status {
        401 => AppFailed::new(FailedKind::Stale, t("server.connector.staleLogin", &[])),
        429 => AppFailed::new(FailedKind::Restricted, format!("{label}: 429")),
        _ => AppFailed::failed(format!("{label}: {status}")),
    }
}

fn text_of(m: &Message) -> String {
    let mut parts = vec![];
    for item in &m.item_list {
        let part = match item.r#type {
            Some(1) => item.text_item.as_ref().and_then(|x| x.text.clone()).unwrap_or_default(),
            Some(2) => t("server.connector.media.image", &[]),
            Some(3) => item
                .voice_item
                .as_ref()
                .and_then(|x| x.text.clone())
                .filter(|x| !x.is_empty())
                .unwrap_or_else(|| t("server.connector.media.audio", &[])),
            Some(4) => match item.file_item.as_ref().and_then(|f| f.file_name.as_deref()).filter(|n| !n.is_empty()) {
                Some(name) => t("server.connector.namedFile", &[("name", name.into())]),
                None => t("server.connector.media.file", &[]),
            },
            Some(5) => t("server.connector.media.video", &[]),
            _ => String::new(),
        };
        if !part.is_empty() {
            parts.push(part);
        }
    }
    parts.join("\n").trim().to_string()
}

fn quoted_of(m: &Message) -> String {
    m.item_list
        .iter()
        .filter_map(|i| i.ref_msg.as_ref()?.svr_id.as_ref())
        .map(|id| id.0.clone())
        .find(|id| !id.is_empty())
        .unwrap_or_default()
}

/// What the farm takes of a page of updates: its own messages echo back, and groups are not for it.
fn inbound_of(updates: &Updates) -> Vec<Inbound> {
    updates
        .msgs
        .iter()
        .filter(|m| m.message_type != Some(2) && m.group_id.as_deref().unwrap_or("").is_empty())
        .filter_map(|m| {
            let from = m.from_user_id.clone().filter(|f| !f.is_empty())?;
            Some(Inbound {
                id: m.message_id.clone().unwrap_or_default().0,
                from,
                text: text_of(m),
                reply: m.context_token.clone().unwrap_or_default(),
                quoted: quoted_of(m),
            })
        })
        .collect()
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{path}", base.trim_end_matches('/'))
}

fn base_info() -> serde_json::Value {
    json!({ "channel_version": format!("{}.{}.{}", VERSION.0, VERSION.1, VERSION.2), "bot_agent": "vibevalley/0.1.0" })
}

pub struct Weixin {
    base: String,
}

impl Weixin {
    pub fn new(base: String) -> Weixin {
        Weixin { base }
    }

    async fn request<T: DeserializeOwned>(&self, label: &str, url: String, body: Option<serde_json::Value>, token: &str) -> Result<T, AppFailed> {
        let why = |e: &dyn std::fmt::Display| AppFailed::failed(format!("{label}: {e}"));
        let client_version = (VERSION.0 & 0xff) << 16 | (VERSION.1 & 0xff) << 8 | (VERSION.2 & 0xff);
        let http = client()?;
        let mut call = match &body {
            Some(_) => http.post(url),
            None => http.get(url),
        }
        .header("iLink-App-Id", "bot")
        .header("iLink-App-ClientVersion", client_version.to_string());
        if let Some(body) = &body {
            // A random number per request, as the official client sends it.
            let uin = (uuid::Uuid::new_v4().as_u128() as u32).to_string();
            call = call
                .header("AuthorizationType", "ilink_bot_token")
                .header("X-WECHAT-UIN", base64::engine::general_purpose::STANDARD.encode(uin))
                .json(body);
            if !token.is_empty() {
                call = call.bearer_auth(token);
            }
        }
        let answer = call.send().await.map_err(|e| why(&e))?;
        let status = answer.status();
        let bytes = answer.bytes().await.map_err(|e| why(&e))?;
        if !status.is_success() {
            return Err(http_failure(label, status.as_u16(), &bytes));
        }
        serde_json::from_slice(&bytes).map_err(|e| why(&e))
    }

    /// The code to poll, and what to show for scanning.
    async fn qr_code(&self) -> Result<(String, String), AppFailed> {
        let asked = timed(Duration::from_secs(15), || AppFailed::failed("get_bot_qrcode: timed out"), async {
            let body: QrCode = self
                .request(
                    "get_bot_qrcode",
                    endpoint(&self.base, "ilink/bot/get_bot_qrcode?bot_type=3"),
                    Some(json!({ "local_token_list": [] })),
                    "",
                )
                .await?;
            match (body.qrcode.filter(|c| !c.is_empty()), body.qrcode_img_content.filter(|c| !c.is_empty())) {
                (Some(code), Some(show)) => Ok((code, show)),
                _ => Err(AppFailed::failed("get_bot_qrcode: no code in the answer")),
            }
        })
        .await;
        asked.map_err(|e| AppFailed::failed(t("server.connector.weixin.noQr", &[("why", e.message.into())])))
    }

    /// WeChat's long poll on the code; a poll that fails reads as still waiting, after a breath so it does not spin.
    async fn qr_status(&self, base: &str, code: &str, verify: &str) -> QrStatus {
        let query = {
            let mut q = url::form_urlencoded::Serializer::new(String::new());
            q.append_pair("qrcode", code);
            if !verify.is_empty() {
                q.append_pair("verify_code", verify);
            }
            q.finish()
        };
        let url = endpoint(base, &format!("ilink/bot/get_qrcode_status?{query}"));
        let polled = timed(
            Duration::from_secs(35),
            || AppFailed::failed("get_qrcode_status: timed out"),
            self.request::<QrStatus>("get_qrcode_status", url, None, ""),
        )
        .await;
        match polled {
            Ok(status) => status,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                QrStatus::default()
            }
        }
    }

    async fn sign_in(&self, io: &LoginIo<'_>) -> Result<Linked<Keys>, AppFailed> {
        let waiting = |show: &str| {
            (io.progress)(Progress {
                state: ConnectorState::Waiting,
                qr: show.to_string(),
            })
        };
        let (mut code, mut show) = self.qr_code().await?;
        waiting(&show);
        let mut base = self.base.clone();
        let mut refreshes = 0;
        loop {
            let status = self.qr_status(&base, &code, &(io.code)()).await;
            let state = status.status.as_deref().unwrap_or("wait");
            match state {
                "scaned" => (io.progress)(Progress {
                    state: ConnectorState::Scanned,
                    qr: show.clone(),
                }),
                "need_verifycode" => {
                    (io.progress)(Progress {
                        state: ConnectorState::Verify,
                        qr: show.clone(),
                    });
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                "scaned_but_redirect" => {
                    if let Some(host) = status.redirect_host.filter(|h| !h.is_empty()) {
                        base = format!("https://{host}");
                    }
                }
                "expired" | "verify_code_blocked" => {
                    refreshes += 1;
                    if refreshes >= 3 {
                        let key = if state == "expired" { "qrExpiredTimes" } else { "codeWrongTimes" };
                        return Err(AppFailed::failed(t(&format!("server.connector.weixin.{key}"), &[])));
                    }
                    (code, show) = self.qr_code().await?;
                    waiting(&show);
                }
                "binded_redirect" => return Err(AppFailed::failed(t("server.connector.weixin.taken", &[]))),
                "confirmed" => {
                    let given = |x: Option<String>| x.filter(|v| !v.is_empty());
                    let (Some(token), Some(bot_id), Some(user)) = (given(status.bot_token), given(status.ilink_bot_id), given(status.ilink_user_id)) else {
                        return Err(AppFailed::failed(t("server.connector.weixin.incomplete", &[])));
                    };
                    return Ok(Linked {
                        keys: Keys {
                            token: Secret::new(token),
                            bot_id,
                            base_url: given(status.baseurl).unwrap_or(base),
                        },
                        user,
                    });
                }
                _ => {}
            }
        }
    }

    /// Nothing within `within` reads as an empty answer.
    async fn updates(&self, keys: &Keys, buf: &str, within: Duration) -> Result<Updates, AppFailed> {
        let polled = tokio::time::timeout(
            within,
            self.request::<Updates>(
                "getupdates",
                endpoint(&keys.base_url, "ilink/bot/getupdates"),
                Some(json!({ "get_updates_buf": buf, "base_info": base_info() })),
                keys.token.expose(),
            ),
        )
        .await;
        polled.unwrap_or_else(|_| {
            Ok(Updates {
                ret: Some(0),
                get_updates_buf: Some(buf.to_string()),
                ..Updates::default()
            })
        })
    }
}

impl Adapter for Weixin {
    type Keys = Keys;
    const ID: ConnectorID = ConnectorID::Weixin;
    const MAX_CHARS: usize = 1800;

    async fn login(&self, _input: &ConnectorLogin, io: &LoginIo<'_>) -> Result<Linked<Keys>, AppFailed> {
        timed(
            Duration::from_secs(8 * 60),
            || AppFailed::failed(t("server.connector.weixin.tooLong", &[])),
            self.sign_in(io),
        )
        .await
    }

    async fn receive(&self, keys: &Keys, io: &Receiving<'_>) -> AppFailed {
        let mut buf = io.cursor.clone();
        let mut within = POLL;
        loop {
            let updates = match self.updates(keys, &buf, within).await {
                Ok(u) => u,
                Err(e) => return e,
            };
            match refusal(updates.ret, updates.errcode) {
                Some(STALE_TOKEN) => return AppFailed::new(FailedKind::Stale, t("server.connector.staleLogin", &[])),
                Some(code) => {
                    let why = updates.errmsg.filter(|m| !m.is_empty()).unwrap_or_else(|| code.to_string());
                    return AppFailed::failed(format!("getupdates: {why}"));
                }
                None => {}
            }
            if let Some(ms) = updates.longpolling_timeout_ms.filter(|ms| *ms > 0) {
                within = Duration::from_millis(ms);
            }
            let next = updates.get_updates_buf.clone().unwrap_or_default();
            if let Err(e) = (io.accept)(inbound_of(&updates), next.clone()).await {
                return e;
            }
            if !next.is_empty() {
                buf = next;
            }
        }
    }

    async fn send(&self, keys: &Keys, to: &str, text: &str, reply: &str) -> Result<String, AppFailed> {
        let mut msg = json!({
            "from_user_id": "",
            "to_user_id": to,
            "client_id": format!("vibevalley-{}", uuid::Uuid::new_v4()),
            "message_type": 2,
            "message_state": 2,
            "item_list": [{ "type": 1, "text_item": { "text": text } }],
        });
        if !reply.is_empty() {
            msg["context_token"] = json!(reply);
        }
        let body: SendAnswer = timed(
            Duration::from_secs(15),
            || AppFailed::failed("sendmessage: timed out"),
            self.request(
                "sendmessage",
                endpoint(&keys.base_url, "ilink/bot/sendmessage"),
                Some(json!({ "msg": msg, "base_info": base_info() })),
                keys.token.expose(),
            ),
        )
        .await?;
        if let Some(code) = refusal(body.ret, body.errcode) {
            return Err(failure_of("sendmessage", code, body.errmsg));
        }
        Ok(body.message_id.unwrap_or_default().0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_decode_nested_messages_and_keep_64_bit_ids() {
        let page = r#"{"ret":0,"get_updates_buf":"b2","msgs":[
          {"message_id":7445566778899001122,"from_user_id":"u@im.wechat","message_type":1,"context_token":"ctx",
           "item_list":[{"type":1,"text_item":{"text":" 看看 "}},{"type":4,"file_item":{"file_name":"a.pdf"}},
                        {"type":1,"ref_msg":{"svr_id":7445566778899001100,"message_item":{"type":1}}}]},
          {"message_id":"2","from_user_id":"bot","message_type":2,"item_list":[]},
          {"message_id":"3","from_user_id":"u@im.wechat","group_id":"g1","item_list":[]}]}"#;
        vibevalley_i18n::set_locale("zh");
        let updates: Updates = serde_json::from_str(page).unwrap();
        let inbound = inbound_of(&updates);
        assert_eq!(
            inbound,
            vec![Inbound {
                id: "7445566778899001122".into(),
                from: "u@im.wechat".into(),
                text: "看看 \n[文件：a.pdf]".into(),
                reply: "ctx".into(),
                quoted: "7445566778899001100".into(),
            }]
        );
    }

    #[test]
    fn a_wrong_messages_shape_is_not_an_answer() {
        assert!(serde_json::from_str::<Updates>(r#"{"ret":0,"msgs":{"message_id":"1"}}"#).is_err());
        assert!(serde_json::from_str::<Updates>(r#"{"ret":"0"}"#).is_err());
        assert!(serde_json::from_str::<QrCode>(r#"{"qrcode":7}"#).is_err());
        assert!(serde_json::from_str::<SendAnswer>(r#"{"ret":0,"message_id":{"id":1}}"#).is_err());
        let sent: SendAnswer = serde_json::from_str(r#"{"ret":0,"message_id":7445566778899001122}"#).unwrap();
        assert_eq!(sent.message_id.unwrap().0, "7445566778899001122");
    }

    #[test]
    fn http_and_ilink_failures_classify_stale_and_restricted_without_leaking_secrets() {
        vibevalley_i18n::set_locale("zh");
        let stale_http = http_failure("sendmessage", 401, b"");
        assert_eq!(stale_http.kind, FailedKind::Stale);

        let rate_limited_http = http_failure("sendmessage", 429, b"");
        assert_eq!(rate_limited_http.kind, FailedKind::Restricted);

        let json_restricted = http_failure("sendmessage", 400, br#"{"ret":-2,"errmsg":"reply window closed"}"#);
        assert_eq!(json_restricted.kind, FailedKind::Restricted);
        assert!(json_restricted.message.contains("reply window closed"));

        let json_stale = http_failure("getupdates", 403, br#"{"errcode":-14,"errmsg":"session expired"}"#);
        assert_eq!(json_stale.kind, FailedKind::Stale);

        let keys = Keys {
            token: Secret::new("super-secret-bot-token-xyz"),
            bot_id: "bot@im.bot".into(),
            base_url: "http://127.0.0.1:9".into(),
        };
        let serialized = serde_json::to_string(&keys).unwrap();
        assert!(serialized.contains("super-secret-bot-token-xyz"));
        assert!(!format!("{:?}", keys.token).contains("super-secret-bot-token-xyz"));
    }

    #[tokio::test]
    async fn send_over_mock_http_handles_context_token_restricted_stale_and_64bit_id() {
        use std::sync::{Arc, Mutex};

        use axum::Router;
        use axum::body::Bytes;
        use axum::http::{HeaderMap, StatusCode};
        use serde_json::Value;
        use tokio_util::sync::CancellationToken;

        #[derive(Default)]
        struct StubState {
            mode: &'static str,
            captured: Vec<(Option<String>, Value)>,
        }
        let state = Arc::new(Mutex::new(StubState {
            mode: "ok",
            captured: Vec::new(),
        }));
        let st = state.clone();
        let app = Router::new().route(
            "/ilink/bot/sendmessage",
            axum::routing::post(move |headers: HeaderMap, body: Bytes| {
                let st = st.clone();
                async move {
                    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_owned);
                    let json: Value = serde_json::from_slice(&body).unwrap();
                    let mut guard = st.lock().unwrap();
                    guard.captured.push((auth, json));
                    match guard.mode {
                        "restricted" => (StatusCode::TOO_MANY_REQUESTS, json!({ "ret": -2, "errmsg": "window closed" }).to_string()),
                        "stale" => (StatusCode::OK, json!({ "ret": -14, "errmsg": "expired" }).to_string()),
                        _ => (StatusCode::OK, json!({ "ret": 0, "message_id": 7445566778899001234u64 }).to_string()),
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
        });

        let wx = Weixin::new(base.clone());
        let keys = Keys {
            token: Secret::new("wx-secret-token"),
            bot_id: "bot@im.bot".into(),
            base_url: base,
        };

        // Proactive push without context_token omits context_token and returns 64-bit id.
        let id = wx.send(&keys, "u@im.wechat", "【需要回复】请确认", "").await.unwrap();
        assert_eq!(id, "7445566778899001234");
        {
            let guard = state.lock().unwrap();
            assert_eq!(guard.captured[0].0.as_deref(), Some("Bearer wx-secret-token"));
            assert!(guard.captured[0].1["msg"].get("context_token").is_none());
            assert_eq!(guard.captured[0].1["msg"]["to_user_id"], "u@im.wechat");
        }

        // With reply context_token, context_token is sent.
        wx.send(&keys, "u@im.wechat", "带上下文", "ctx-99").await.unwrap();
        assert_eq!(state.lock().unwrap().captured[1].1["msg"]["context_token"], "ctx-99");

        // HTTP 429 / ret -2 maps to Restricted; ret -14 maps to Stale without leaking token.
        state.lock().unwrap().mode = "restricted";
        let err = wx.send(&keys, "u@im.wechat", "hello", "").await.unwrap_err();
        assert_eq!(err.kind, FailedKind::Restricted);

        state.lock().unwrap().mode = "stale";
        let err = wx.send(&keys, "u@im.wechat", "hello", "").await.unwrap_err();
        assert_eq!(err.kind, FailedKind::Stale);
        assert!(!err.message.contains("wx-secret-token"));

        drop(guard);
    }
}
