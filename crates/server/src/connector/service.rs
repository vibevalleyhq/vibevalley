use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, ConnectorID, ConnectorLogin, ConnectorStatus, Op, ops};

use super::adapter::{App, ConnectorHost};
use super::bridge::{Bridge, Env};
use super::{feishu, qq, weixin};
use crate::context::{Context, now};
use crate::setting::Setting;

/// How long a message in or out is kept after it went through, for a reply to point at.
const KEPT_MS: i64 = 30 * 24 * 60 * 60_000;

/// Where each app is reached.
#[derive(Debug, Clone)]
pub struct Vendors {
    pub weixin: String,
    pub qq_api: String,
    pub qq_token: String,
    pub feishu_accounts: String,
    pub lark_accounts: String,
    pub feishu_open: String,
    pub lark_open: String,
}

impl Default for Vendors {
    fn default() -> Vendors {
        Vendors {
            weixin: weixin::BASE_URL.into(),
            qq_api: qq::API.into(),
            qq_token: qq::TOKEN_URL.into(),
            feishu_accounts: "https://accounts.feishu.cn".into(),
            lark_accounts: "https://accounts.larksuite.com".into(),
            feishu_open: "https://open.feishu.cn".into(),
            lark_open: "https://open.larksuite.com".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    pub vendors: Vendors,
    /// Held messages are tried again after this long, then twice as long after each try that fails, up to `retry_most`.
    pub retry_first: Duration,
    pub retry_most: Duration,
    /// A connection that ended is opened again after this long.
    pub reconnect: Duration,
    /// A login's answer waits this long for the code to show.
    pub moment: Duration,
    /// Feishu's registration is asked about no more often than this.
    pub poll_floor: Duration,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            vendors: Vendors::default(),
            retry_first: Duration::from_secs(30),
            retry_most: Duration::from_secs(30 * 60),
            reconnect: Duration::from_secs(2),
            moment: Duration::from_millis(1500),
            poll_floor: Duration::from_secs(2),
        }
    }
}

/// Every chat app there is, in the order they are listed.
fn apps(options: &Options) -> Vec<Arc<dyn App>> {
    let v = options.vendors.clone();
    vec![
        Arc::new(weixin::Weixin::new(v.weixin)),
        Arc::new(feishu::Feishu::new(
            feishu::Hosts {
                feishu_accounts: v.feishu_accounts,
                lark_accounts: v.lark_accounts,
                feishu_open: v.feishu_open,
                lark_open: v.lark_open,
            },
            options.poll_floor,
        )),
        Arc::new(qq::Qq::new(v.qq_api, v.qq_token)),
    ]
}

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::ConnectorRefused, text)
}

/// Pure external IM protocol coordinator owning WeChat, Feishu, and QQ bridges.
pub struct Connector {
    env: Arc<Env>,
    bridges: Vec<Arc<Bridge>>,
}

impl Connector {
    pub async fn open_async(ctx: Arc<Context>, setting: Arc<Setting>, options: Options, host: Arc<dyn ConnectorHost>) -> Result<Arc<Connector>, ApiError> {
        let env = Arc::new(Env {
            ctx: ctx.clone(),
            setting,
            host,
            retry_first: options.retry_first,
            retry_most: options.retry_most,
            reconnect: options.reconnect,
            moment: options.moment,
            closing: AtomicBool::new(false),
        });
        let bridges: Vec<Arc<Bridge>> = apps(&options).into_iter().map(|app| Bridge::new(app, env.clone())).collect();
        for b in &bridges {
            b.load_async().await;
        }
        for b in &bridges {
            if b.has_account() {
                b.resume();
            }
        }
        Ok(Arc::new(Connector { env, bridges }))
    }

    pub fn is_closing(&self) -> bool {
        self.env.closing.load(Ordering::SeqCst)
    }

    pub fn setting(&self) -> &Arc<Setting> {
        &self.env.setting
    }

    pub(crate) fn bridge(&self, id: ConnectorID) -> &Arc<Bridge> {
        self.bridges.iter().find(|b| b.id() == id).expect("every chat app has its bridge")
    }

    pub fn is_paired(&self, id: ConnectorID) -> bool {
        self.bridge(id).is_paired()
    }

    pub fn has_account(&self, id: ConnectorID) -> bool {
        self.bridge(id).has_account()
    }

    pub fn paired_ids(&self) -> Vec<ConnectorID> {
        self.bridges.iter().filter(|b| b.is_paired()).map(|b| b.id()).collect()
    }

    pub fn bound_channel_id(&self, id: ConnectorID) -> Option<String> {
        self.bridge(id).bound_channel_id()
    }

    pub async fn list_async(&self) -> Vec<ConnectorStatus> {
        let mut out = Vec::with_capacity(self.bridges.len());
        for b in &self.bridges {
            out.push(b.status_async().await);
        }
        out
    }

    /// Starts a login (or says how far the one going on is); `force` starts over.
    pub async fn login_async(&self, id: ConnectorID, input: ConnectorLogin) -> ConnectorStatus {
        self.bridge(id).login_async(input).await
    }

    /// The code the app asked the user for during a login.
    pub async fn verify_async(&self, id: ConnectorID, code: &str) -> ConnectorStatus {
        self.bridge(id).verify_async(code).await
    }

    pub async fn logout_async(&self, id: ConnectorID) -> ConnectorStatus {
        self.bridge(id).logout_async().await
    }

    /// Persists the bound channel id (`None` means default channel) for `id`.
    pub async fn set_channel_id_async(&self, id: ConnectorID, bound: Option<&str>) -> Result<ConnectorStatus, ApiError> {
        self.bridge(id).set_channel_async(bound).await.map_err(|e| refused(e.to_string()))
    }

    /// Offers a pre-formatted channel message to any paired bridge bound to `top_channel_id`.
    pub async fn offer_channel_text_async(&self, message_id: &str, top_channel_id: &str, default_channel_id: &str, text: &str) {
        for b in &self.bridges {
            if !b.is_paired() {
                continue;
            }
            let target = b.bound_channel_id();
            let effective = target.as_deref().unwrap_or(default_channel_id);
            if effective == top_channel_id {
                b.offer_text_async(message_id, text).await;
            }
        }
    }

    /// Offers a notification/digest body to a specific paired connector.
    pub async fn offer_notification_async(&self, id: ConnectorID, message_id: &str, body: &str, at: i64) {
        let b = self.bridge(id);
        if b.is_paired() {
            b.offer_notification_async(message_id, body, at).await;
        }
    }

    /// Wakes every connected bridge to re-evaluate pending outgoing messages.
    pub async fn notify_changed_all_async(&self) {
        for b in &self.bridges {
            if b.has_account() {
                b.changed_async().await;
            }
        }
    }

    /// Withdraws one exact push message id from every paired bridge.
    pub async fn withdraw_push_message_all_async(&self, message_id: &str) {
        for b in &self.bridges {
            if b.is_paired() {
                b.withdraw_push_message_async(message_id).await;
            }
        }
    }

    /// Withdraws all pending outgoing rows whose message id starts with `prefix` from every paired bridge.
    pub async fn withdraw_prefix_all_async(&self, prefix: &str) {
        for b in &self.bridges {
            if b.is_paired() {
                b.withdraw_prefix_async(prefix).await;
            }
        }
    }

    /// Prunes delivered connector history older than the retention window.
    pub async fn prune_history_async(&self) {
        if let Err(e) = self.env.ctx.service.connector.prune(now() - KEPT_MS).await {
            eprintln!("vibevalley-server: connector: history was not pruned: {e}");
        }
    }

    /// Every account's work stopped, and waited for.
    pub async fn close_async(&self) {
        self.env.closing.store(true, Ordering::SeqCst);
        for b in &self.bridges {
            b.stop_async().await;
        }
    }

    pub(crate) async fn handle_login(&self, req: <ops::ConnectorLogin as Op>::Input) -> Result<ConnectorStatus, ApiError> {
        let id = app_of(&req.id)?;
        Ok(self
            .login_async(
                id,
                ConnectorLogin {
                    force: req.force,
                    app_id: req.app_id,
                    secret: req.secret,
                },
            )
            .await)
    }

    pub(crate) async fn handle_verify(&self, req: <ops::ConnectorVerify as Op>::Input) -> Result<ConnectorStatus, ApiError> {
        let id = app_of(&req.id)?;
        Ok(self.verify_async(id, &req.code).await)
    }

    pub(crate) async fn handle_logout(&self, req: <ops::ConnectorLogout as Op>::Input) -> Result<ConnectorStatus, ApiError> {
        let id = app_of(&req.id)?;
        Ok(self.logout_async(id).await)
    }
}

pub fn app_of(id: &str) -> Result<ConnectorID, ApiError> {
    ConnectorID::ALL
        .into_iter()
        .find(|c| c.as_str() == id)
        .ok_or_else(|| refused(t("server.connector.noConnector", &[("id", id.into())])))
}
