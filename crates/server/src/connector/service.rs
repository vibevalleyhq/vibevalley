use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::channel::for_user;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, BoardSlice, ConnectorID, ConnectorLogin, ConnectorStatus, Issue, Millis, Notify, Op, Outcome, Session, SliceKind, ops,
};

use super::adapter::App;
use super::bridge::{self, Bridge, Env, Handoff};
use super::digest::{DigestTargets, PersonalEvent, personal_event_for_issue, personal_event_for_run};
use super::notify::{NotifyDecision, NotifyOptions, NotifyRouter};
use super::{feishu, qq, weixin};
use crate::channel::{ChannelEvent, Chat, to_message};
use crate::context::{Context, OUTBOX_CONNECTOR_NOTIFY, OutboxConnectorNotify, OutboxEvent, OutboxSessionReported, now};
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
    /// Personal push & scheduled digest routing rules.
    pub notify: NotifyOptions,
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
            notify: NotifyOptions::default(),
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
    notify: Arc<NotifyRouter>,
    /// Cancelled and awaited on close to end background feed/board tasks.
    feed: Mutex<Option<(CancellationToken, Vec<JoinHandle<()>>)>>,
}

impl Connector {
    pub async fn open_async(ctx: Arc<Context>, setting: Arc<Setting>, chat: Arc<Chat>, options: Options) -> Result<Arc<Connector>, ApiError> {
        let notify = Arc::new(NotifyRouter::new(options.notify.clone()));
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
        for b in &bridges {
            b.load_async().await;
        }
        if let (Ok(raw_issues), Ok(sessions)) = (ctx.service.issue.all().await, ctx.service.session.all().await) {
            let derived = vibevalley_core::derive_issues(&raw_issues, &sessions);
            notify.seed_issues(&derived, &sessions, ctx.now());
        }
        {
            let outbox_bridges = bridges.clone();
            let outbox_env = env.clone();
            let push_targets = options.notify.push_targets.clone();
            ctx.outbox.register(OUTBOX_CONNECTOR_NOTIFY, move |delivery| {
                let bridges = outbox_bridges.clone();
                let env = outbox_env.clone();
                let push_targets = push_targets.clone();
                async move {
                    let payload: OutboxConnectorNotify = delivery.decode().map_err(|e| format!("invalid {OUTBOX_CONNECTOR_NOTIFY} payload: {e}"))?;
                    let at = env.ctx.now();
                    for b in &bridges {
                        let targeted = match payload.connector {
                            Some(id) => b.id() == id,
                            None => push_targets.contains(&b.id()),
                        };
                        if targeted && b.is_paired() {
                            b.offer_notification_async(&payload.message_id, &payload.body, at).await;
                        }
                    }
                    Ok::<(), String>(())
                }
            });
        }
        let cancel = ctx.task.child_token();
        let feed_cancel = cancel.clone();
        let events = chat.subscribe_events();
        let (feed_bridges, feed_env) = (bridges.clone(), env.clone());
        let feed_handle = ctx.spawn("connector.feed", feed(feed_env, feed_bridges, events, feed_cancel));
        let board_rx = ctx.feed.subscribe_json(SliceKind::Board);
        let board_handle = ctx.spawn(
            "connector.board_events",
            watch_board_events(env.clone(), bridges.clone(), notify.clone(), board_rx, cancel.clone()),
        );
        for b in &bridges {
            if b.has_account() {
                b.resume();
            }
        }
        Ok(Arc::new(Connector {
            env,
            bridges,
            notify,
            feed: Mutex::new(Some((cancel, vec![feed_handle, board_handle]))),
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
        if let Some((cancel, handles)) = feed {
            cancel.cancel();
            for handle in handles {
                let _ = handle.await;
            }
        }
    }

    fn has_paired_target(&self, target: Option<ConnectorID>) -> bool {
        match target {
            Some(id) => self.bridge(id).is_paired(),
            None => self.notify.options().push_targets.iter().any(|id| self.bridge(*id).is_paired()),
        }
    }

    /// Evaluates quiet/dedupe/rate-limit policy and durably enqueues a personal notification
    /// if at least one targeted connector account is paired.
    pub async fn push_personal_event_async(&self, event: PersonalEvent) -> Result<Option<NotifyDecision>, ApiError> {
        if self.env.closing.load(Ordering::SeqCst) || !self.has_paired_target(None) {
            return Ok(None);
        }
        let channel_notify = event.channel_id.as_deref().map(|cid| self.env.chat.notify_of(cid)).unwrap_or(Notify::All);
        let decision = self.notify.submit_event_async(&self.env.ctx, None, &event, channel_notify).await?;
        Ok(Some(decision))
    }

    /// Handles a durable [`OutboxSessionReported`] event from [`Outbox`], routing actionable
    /// issue/run notifications through [`NotifyRouter`] without blocking the caller transaction.
    pub async fn on_session_reported_async(&self, report: &OutboxSessionReported) {
        if self.env.closing.load(Ordering::SeqCst) || !self.has_paired_target(None) {
            return;
        }
        let session = match self.env.ctx.service.session.get(&report.id).await {
            Ok(Some(s)) => s,
            Ok(None) => match self.env.ctx.service.session.past(&report.id).await {
                Ok(Some(s)) => s,
                _ => return,
            },
            Err(_) => return,
        };
        let event = if let Some(issue_id) = session.issue_id() {
            let Ok(Some(raw_issue)) = self.env.ctx.service.issue.get(issue_id).await else {
                return;
            };
            let Ok(sessions) = self.env.ctx.service.session.all().await else {
                return;
            };
            let derived = vibevalley_core::derive_issues(&[raw_issue], &sessions);
            let Some(issue) = derived.into_iter().next() else {
                return;
            };
            let channel_id = issue_top_channel(&self.env.chat, &issue, &sessions);
            let session_summary = (!report.summary.trim().is_empty())
                .then_some(report.summary.as_str())
                .or_else(|| session.last_run.as_ref().map(|r| r.summary.as_str()));
            personal_event_for_issue(&issue, session_summary, report.at, channel_id)
        } else {
            let already_forwarded_in_bound_channel = session.is_direct_talker()
                && report.outcome == Outcome::Completed
                && session.channel_id().is_some_and(|cid| {
                    let top = self.env.chat.top_of(cid).id;
                    let bound = self
                        .notify
                        .options()
                        .push_targets
                        .iter()
                        .any(|id| self.bridge(*id).status_channel_id(&self.env.chat) == top);
                    bound && self.env.chat.notify_of(cid) != Notify::None
                });
            if already_forwarded_in_bound_channel {
                None
            } else {
                personal_event_for_run(
                    &session,
                    report.run.as_deref(),
                    report.outcome,
                    &report.summary,
                    report.spent.as_ref(),
                    report.at,
                )
            }
        };
        if let Some(ev) = event {
            let _ = self.push_personal_event_async(ev).await;
        }
    }

    /// Enqueues a scheduled progress digest to configured / requested connector targets via Outbox.
    pub async fn deliver_digest_async(&self, cron_id: &str, at: Millis, targets: DigestTargets, text: &str) -> Result<usize, ApiError> {
        if self.env.closing.load(Ordering::SeqCst) || text.trim().is_empty() {
            return Ok(0);
        }
        let target_ids: Vec<ConnectorID> = match targets {
            DigestTargets::Default => self.notify.options().digest_targets,
            DigestTargets::Connectors(ids) => ids,
            DigestTargets::AllConnected => self.bridges.iter().filter(|b| b.is_paired()).map(|b| b.id()).collect(),
        };
        let mut delivered = 0usize;
        let now_ms = self.env.ctx.now();
        for id in target_ids {
            if !self.bridge(id).is_paired() {
                continue;
            }
            let payload = OutboxEvent::ConnectorNotify(OutboxConnectorNotify {
                connector: Some(id),
                dedupe_key: format!("digest:{cron_id}:{at}:{}", id.as_str()),
                message_id: format!("digest:{cron_id}:{at}"),
                issue_id: None,
                channel_id: None,
                body: text.to_string(),
                created_at: now_ms,
                urgent: true,
            });
            self.env.ctx.outbox.enqueue_event(&payload).await?;
            delivered += 1;
        }
        if delivered > 0 {
            self.env.ctx.outbox.wake();
        }
        Ok(delivered)
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

fn issue_top_channel(chat: &Chat, issue: &Issue, sessions: &[Session]) -> Option<String> {
    let sid = issue.latest_session_id()?;
    let ch = sessions.iter().find(|s| &s.id == sid).and_then(|s| s.channel_id())?;
    Some(chat.top_of(ch).id)
}

async fn watch_board_events(
    env: Arc<Env>,
    bridges: Vec<Arc<Bridge>>,
    notify: Arc<NotifyRouter>,
    mut board_rx: watch::Receiver<Arc<str>>,
    cancel: CancellationToken,
) {
    let _ = board_rx.borrow_and_update();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            changed = board_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
        if env.closing.load(Ordering::SeqCst) {
            return;
        }
        let json = board_rx.borrow_and_update().clone();
        let Ok(board) = serde_json::from_str::<BoardSlice>(&json) else {
            continue;
        };
        let sessions = env.ctx.service.session.all().await.unwrap_or_default();
        let now_ms = env.ctx.now();
        let (events, settled) = notify.diff_board_issues(&board.issues, &sessions, now_ms, |issue| issue_top_channel(&env.chat, issue, &sessions));
        for issue_id in settled {
            for b in &bridges {
                if b.is_paired() {
                    b.withdraw_issue_pushes_async(&issue_id).await;
                }
            }
        }
        let has_paired = notify
            .options()
            .push_targets
            .iter()
            .any(|id| bridges.iter().any(|b| b.id() == *id && b.is_paired()));
        if !has_paired {
            continue;
        }
        for event in events {
            let channel_notify = event.channel_id.as_deref().map(|cid| env.chat.notify_of(cid)).unwrap_or(Notify::All);
            let _ = notify.submit_event_async(&env.ctx, None, &event, channel_notify).await;
        }
    }
}

pub fn app_of(id: &str) -> Result<ConnectorID, ApiError> {
    ConnectorID::ALL
        .into_iter()
        .find(|c| c.as_str() == id)
        .ok_or_else(|| refused(t("server.connector.noConnector", &[("id", id.into())])))
}
