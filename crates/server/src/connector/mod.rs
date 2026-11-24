//! The chat apps (WeChat, Feishu, QQ): each ties one account of the user's
//! to a channel. What the user says to the bot there is said in the channel
//! as the user's own words; what the farm says for the user there goes out
//! to the app while the user has not read it in the farm.
//!
//! `Connector` is the door. Behind it each app is an `Adapter` (its login,
//! its connection, its sends) under a `Bridge` (the account, the durable
//! inbox and outbox persisted via `ctx.service.connector`, and status updates
//! published via `ctx.live` + `ctx.mark_dirty`).

pub mod adapter;
mod bridge;
mod digest;
mod feishu;
mod qq;
mod weixin;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::channel::for_user;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, ConnectorID, ConnectorLogin, ConnectorStatus, Op, ops};

use self::adapter::App;
use self::bridge::{Bridge, Env, Handoff};
use crate::channel::{ChannelEvent, Chat, to_message};
use crate::context::{Context, now};
use crate::setting::Setting;

/// How long a message in or out is kept after it went through, for a reply to point at.
const KEPT_MS: i64 = 30 * 24 * 60 * 60_000;
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

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

pub struct Connector {
    env: Arc<Env>,
    bridges: Vec<Arc<Bridge>>,
    /// Cancelled and awaited on close to end the feed task.
    feed: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}

impl Connector {
    pub async fn open_async(ctx: Arc<Context>, setting: Arc<Setting>, chat: Arc<Chat>, options: Options) -> Result<Arc<Connector>, ApiError> {
        let env = Arc::new(Env {
            ctx: ctx.clone(),
            setting,
            chat: chat.clone(),
            retry_first: options.retry_first,
            retry_most: options.retry_most,
            reconnect: options.reconnect,
            moment: options.moment,
            closing: AtomicBool::new(false),
        });
        let bridges: Vec<Arc<Bridge>> = apps(&options).into_iter().map(|app| Bridge::new(app, env.clone())).collect();
        {
            let env = env.clone();
            chat.guard_removal(move |id| {
                let env = env.clone();
                Box::pin(async move {
                    match env.ctx.service.connector.accounts_in(&id).await {
                        Ok(0) => vec![],
                        _ => vec![t("server.channel.connectorsThere", &[])],
                    }
                })
            });
        }
        for b in &bridges {
            b.load_async().await;
        }
        let cancel = ctx.task.child_token();
        let feed_cancel = cancel.clone();
        let events = chat.subscribe_events();
        let (feed_bridges, feed_env) = (bridges.clone(), env.clone());
        let handle = ctx.spawn("connector.feed", feed(feed_env, feed_bridges, events, feed_cancel));
        for b in &bridges {
            if b.has_account() {
                b.resume();
            }
        }
        Ok(Arc::new(Connector {
            env,
            bridges,
            feed: Mutex::new(Some((cancel, handle))),
        }))
    }

    pub fn setting(&self) -> &Arc<Setting> {
        &self.env.setting
    }

    fn bridge(&self, id: ConnectorID) -> &Arc<Bridge> {
        self.bridges.iter().find(|b| b.id() == id).expect("every chat app has its bridge")
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

    /// Ties the app to the channel called `name`.
    pub async fn set_channel_async(&self, id: ConnectorID, name: &str) -> Result<ConnectorStatus, ApiError> {
        let chat = &self.env.chat;
        let channel = chat
            .channel_by_name(name)
            .ok_or_else(|| refused(t("server.connector.noChannel", &[("name", name.into())])))?;
        let bound = (!channel.default).then_some(channel.id.as_str());
        self.bridge(id).set_channel_async(bound).await.map_err(|e| refused(e.to_string()))
    }

    /// Every account's work stopped, and waited for.
    pub async fn close_async(&self) {
        self.env.closing.store(true, Ordering::SeqCst);
        for b in &self.bridges {
            b.stop_async().await;
        }
        let feed = self.feed.lock().take();
        if let Some((cancel, handle)) = feed {
            cancel.cancel();
            let _ = handle.await;
        }
    }

    pub(crate) async fn handle_list(&self) -> Vec<ConnectorStatus> {
        self.list_async().await
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

    pub(crate) async fn handle_channel_set(&self, req: <ops::ConnectorChannelSet as Op>::Input) -> Result<ConnectorStatus, ApiError> {
        let id = app_of(&req.id)?;
        self.set_channel_async(id, &req.channel).await
    }
}

/// What the farm says for the user goes to every app (each checks it is its channel's); a read or newer words
/// make them look again at what waits; what went through long ago is dropped, at start and daily.
async fn feed(env: Arc<Env>, bridges: Vec<Arc<Bridge>>, mut events: broadcast::Receiver<ChannelEvent>, cancel: CancellationToken) {
    loop {
        if let Err(e) = env.ctx.service.connector.prune(now() - KEPT_MS).await {
            eprintln!("vibevalley-server: connector: history was not pruned: {e}");
        }
        let day = tokio::time::sleep(DAY);
        tokio::pin!(day);
        loop {
            enum Fed {
                Event(Box<ChannelEvent>),
                Lagged,
                Day,
                Over,
            }
            let fed = tokio::select! {
                biased;
                _ = cancel.cancelled() => Fed::Over,
                res = events.recv() => match res {
                    Ok(ev) => Fed::Event(Box::new(ev)),
                    Err(broadcast::error::RecvError::Lagged(_)) => Fed::Lagged,
                    Err(broadcast::error::RecvError::Closed) => Fed::Over,
                },
                _ = &mut day => Fed::Day,
            };
            match fed {
                Fed::Event(event) => {
                    let wake = match *event {
                        ChannelEvent::Posted(c) => {
                            let m = to_message(&c.row);
                            if for_user(&m, env.chat.notify_of(&m.channel)) && matches!(bridge::handoff_async(&env.chat, &m.id).await, Ok(Handoff::Unseen)) {
                                for b in &bridges {
                                    b.offer_async(&m).await;
                                }
                            }
                            true
                        }
                        ChannelEvent::Removed { .. } | ChannelEvent::UserRead { .. } => true,
                        ChannelEvent::Edited(_) | ChannelEvent::Reacted(_) | ChannelEvent::Pinned(_) => false,
                    };
                    if wake {
                        for b in &bridges {
                            if b.has_account() {
                                b.changed_async().await;
                            }
                        }
                    }
                }
                Fed::Lagged => {
                    for b in &bridges {
                        if b.has_account() {
                            b.changed_async().await;
                        }
                    }
                }
                Fed::Day => break,
                Fed::Over => return,
            }
        }
    }
}

pub fn app_of(id: &str) -> Result<ConnectorID, ApiError> {
    ConnectorID::ALL
        .into_iter()
        .find(|c| c.as_str() == id)
        .ok_or_else(|| refused(t("server.connector.noConnector", &[("id", id.into())])))
}
