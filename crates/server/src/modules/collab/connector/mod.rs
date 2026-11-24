//! The chat apps (WeChat, Feishu, QQ): each ties one account of the user's
//! to a channel. What the user says to the bot there is said in the channel
//! as the user's own words; what the farm says for the user there goes out
//! to the app while the user has not read it in the farm.
//!
//! `Connectors` is the door. Behind it each app is an `Adapter` (its login,
//! its connection, its sends) under a `Bridge` (the account, the durable
//! inbox and outbox in `connector_*` of server.db, the status said to the
//! core).

pub(in crate::modules::collab) mod adapter;
mod bridge;
mod digest;
mod feishu;
mod qq;
pub(in crate::modules::collab) mod store;
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
use vibevalley_protocol::{ApiError, BizCode, ConnectorID, ConnectorLogin, ConnectorStatus, ops};

use self::adapter::App;
use self::bridge::{Bridge, Env, Handoff};
use self::store::Store;
use crate::base::ServerDb;
use crate::modules::collab::channel::{ChannelEvent, Chat, to_message};
use crate::{Hub, now};

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

pub struct Connectors {
    env: Arc<Env>,
    bridges: Vec<Arc<Bridge>>,
    /// Cancelled and awaited on close to end the feed task.
    feed: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}

impl Connectors {
    /// Opens the accounts and goes on with those that are connected.
    pub fn open(db: Arc<ServerDb>, hub: &Arc<Hub>, chat: Arc<Chat>, options: Options) -> Result<Arc<Connectors>, ApiError> {
        let store = Store::open(db);
        let env = Arc::new(Env {
            store,
            chat: chat.clone(),
            hub: Arc::downgrade(hub),
            retry_first: options.retry_first,
            retry_most: options.retry_most,
            reconnect: options.reconnect,
            moment: options.moment,
            closing: AtomicBool::new(false),
        });
        let bridges: Vec<Arc<Bridge>> = apps(&options).into_iter().map(|app| Bridge::new(app, env.clone())).collect();
        {
            let env = env.clone();
            chat.guard_removal(move |id| match env.store.accounts_in(id) {
                Ok(0) => vec![],
                _ => vec![t("server.channel.connectorsThere", &[])],
            });
        }
        for b in &bridges {
            b.load();
        }
        let cancel = hub.child_token();
        let feed_cancel = cancel.clone();
        let events = chat.subscribe_events();
        let (feed_bridges, feed_env) = (bridges.clone(), env.clone());
        let handle = hub.spawn_task(feed(feed_env, feed_bridges, events, feed_cancel));
        for b in &bridges {
            if b.has_account() {
                b.resume();
            }
        }
        Ok(Arc::new(Connectors {
            env,
            bridges,
            feed: Mutex::new(Some((cancel, handle))),
        }))
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
        self.bridge(id).set_channel_async(bound).await.map_err(|e| refused(e.0))
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

    /// Every account's work stopped, and waited for.
    pub fn close(&self) {
        vibevalley_runtime::rt::block_on(self.close_async());
    }
}

/// What the farm says for the user goes to every app (each checks it is its channel's); a read or newer words
/// make them look again at what waits; what went through long ago is dropped, at start and daily.
async fn feed(env: Arc<Env>, bridges: Vec<Arc<Bridge>>, mut events: broadcast::Receiver<ChannelEvent>, cancel: CancellationToken) {
    loop {
        if let Err(e) = env.store.prune_async(now() - KEPT_MS).await {
            eprintln!("vibevalley-server: connector: history was not pruned: {}", e.0);
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

fn app_of(id: &str) -> Result<ConnectorID, ApiError> {
    ConnectorID::ALL
        .into_iter()
        .find(|c| c.as_str() == id)
        .ok_or_else(|| refused(t("server.connector.noConnector", &[("id", id.into())])))
}

pub fn install(hub: &Hub, connectors: Arc<Connectors>) {
    let c = connectors.clone();
    hub.on_async::<ops::ConnectorList, _, _>(move |_, _| {
        let c = c.clone();
        async move { Ok(c.list_async().await) }
    });
    let c = connectors.clone();
    hub.on_async::<ops::ConnectorLogin, _, _>(move |_, input| {
        let c = c.clone();
        async move {
            let id = app_of(&input.id)?;
            let login = ConnectorLogin {
                force: input.force,
                app_id: input.app_id,
                secret: input.secret,
            };
            Ok(c.login_async(id, login).await)
        }
    });
    let c = connectors.clone();
    hub.on_async::<ops::ConnectorVerify, _, _>(move |_, input| {
        let c = c.clone();
        async move {
            let id = app_of(&input.id)?;
            Ok(c.verify_async(id, &input.code).await)
        }
    });
    let c = connectors.clone();
    hub.on_async::<ops::ConnectorLogout, _, _>(move |_, input| {
        let c = c.clone();
        async move {
            let id = app_of(&input.id)?;
            Ok(c.logout_async(id).await)
        }
    });
    let c = connectors;
    hub.on_async::<ops::ConnectorChannelSet, _, _>(move |_, input| {
        let c = c.clone();
        async move {
            let id = app_of(&input.id)?;
            c.set_channel_async(id, &input.channel).await
        }
    });
}
