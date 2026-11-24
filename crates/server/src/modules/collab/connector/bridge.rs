//! One chat app's account on the farm: its login, and while it is connected
//! a Tokio task that receives and a Tokio task that works through what came in
//! and what goes out, both cancelled and awaited before the account is replaced.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;
use vibevalley_core::channel::for_user;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ChatMessage, ConnectorID, ConnectorLogin, ConnectorState, ConnectorStatus, Fact, FactConnectorChanged};

use super::adapter::{App, AppFailed, FailedKind, Inbound, LoginIo, Progress, Receiving};
use super::digest::{DIGEST_OVER, digest, is_pairing, short_id, split_text, user_line};
use super::store::{Account, Store, StoreFailed};
use crate::modules::collab::channel::{Chat, Saying};
use crate::{Hub, now};

/// WeChat's official client rests this long too.
const STALE_PAUSE_MS: i64 = 60 * 60_000;
/// The worker looks again this often when nothing wakes it.
const IDLE: Duration = Duration::from_secs(60);

/// What every bridge works with.
pub struct Env {
    pub store: Store,
    pub chat: Arc<Chat>,
    pub hub: Weak<Hub>,
    /// What is held is tried again after this long, then twice as long after each try that fails, up to `retry_most`.
    pub retry_first: Duration,
    pub retry_most: Duration,
    /// A connection that ended is opened again after this long.
    pub reconnect: Duration,
    /// A login's answer waits this long for the code to show.
    pub moment: Duration,
    pub closing: AtomicBool,
}

impl Env {
    fn retry_backoff(&self) -> ExponentialBackoff {
        ExponentialBuilder::new()
            .with_factor(2.0)
            .with_min_delay(self.retry_first.min(self.retry_most))
            .with_max_delay(self.retry_most)
            .without_max_times()
            .build()
    }
}

/// Why a step did not go through: the database's or the farm's words.
struct Held(String);

impl From<StoreFailed> for Held {
    fn from(e: StoreFailed) -> Held {
        Held(e.0)
    }
}

impl From<ApiError> for Held {
    fn from(e: ApiError) -> Held {
        Held(e.message)
    }
}

/// Whether the user still has to hear a farm message off the farm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handoff {
    Unseen,
    /// Read in the farm, answered since, or gone.
    Settled,
}

pub async fn handoff_async(chat: &Chat, message: &str) -> Result<Handoff, ApiError> {
    let Some((m, read_at, superseded)) = chat.user_receipt_async(message).await? else {
        return Ok(Handoff::Settled);
    };
    if superseded || read_at.is_some() || !for_user(&m, chat.notify_of(&m.channel)) {
        return Ok(Handoff::Settled);
    }
    Ok(Handoff::Unseen)
}

struct SigningIn {
    progress: Progress,
    code: String,
}

#[derive(Default)]
struct Shown {
    account: Option<Account>,
    signing_in: Option<SigningIn>,
    error: String,
    /// A login stopped by a newer one leaves the newer one's progress alone.
    login_try: u64,
}

/// Prepared outgoing work for [`Bridge::drain`].
struct DrainPlan {
    account: Account,
    batches: Vec<(Vec<i64>, String)>,
}

/// The account's work now: a login task, or receiving and worker tasks.
struct Generation {
    cancel: CancellationToken,
    tasks: Vec<JoinHandle<()>>,
}

pub struct Bridge {
    app: Arc<dyn App>,
    env: Arc<Env>,
    shown: Mutex<Shown>,
    progressed: Notify,
    /// One command at a time; only its holder replaces the generation.
    commands: AsyncMutex<Option<Generation>>,
    wake: Notify,
    told: Mutex<Option<ConnectorStatus>>,
}

fn paused(a: &Account, at: i64) -> bool {
    a.paused_until != 0 && a.paused_until > at
}

async fn sleep_or_cancel(cancel: &CancellationToken, d: Duration) -> bool {
    if cancel.is_cancelled() {
        return true;
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => true,
        _ = tokio::time::sleep(d) => false,
    }
}

fn pair_code() -> String {
    let random = uuid::Uuid::new_v4().as_u128() % 900_000;
    (100_000 + random).to_string()
}

impl Bridge {
    pub fn new(app: Arc<dyn App>, env: Arc<Env>) -> Arc<Bridge> {
        Arc::new(Bridge {
            app,
            env,
            shown: Mutex::default(),
            progressed: Notify::new(),
            commands: AsyncMutex::new(None),
            wake: Notify::new(),
            told: Mutex::new(None),
        })
    }

    pub fn id(&self) -> ConnectorID {
        self.app.id()
    }

    fn snapshot(&self) -> Option<Account> {
        self.shown.lock().account.clone()
    }

    fn closing(&self) -> bool {
        self.env.closing.load(Ordering::SeqCst)
    }

    fn status_core(&self, pending: i64) -> ConnectorStatus {
        let (account, progress, error) = {
            let s = self.shown.lock();
            (s.account.clone(), s.signing_in.as_ref().map(|x| x.progress.clone()), s.error.clone())
        };
        let mut status = ConnectorStatus {
            id: self.id(),
            state: ConnectorState::Off,
            qr: String::new(),
            pair_code: String::new(),
            channel: None,
            user: None,
            since: None,
            last_inbound: None,
            paused_until: None,
            pending,
            error,
        };
        if let Some(a) = &account {
            let channels = self.env.chat.channels();
            let bound = channels.iter().find(|c| match &a.channel {
                Some(id) => &c.id == id,
                None => c.default,
            });
            status.channel = bound.map(|c| c.name.clone()).filter(|n| !n.is_empty());
        }
        if let Some(p) = progress {
            status.state = p.state;
            status.qr = p.qr;
            return status;
        }
        let Some(a) = account else { return status };
        status.since = Some(a.connected_at);
        if a.user.is_empty() {
            status.state = ConnectorState::Pairing;
            status.pair_code = a.pair_code;
            return status;
        }
        let resting = paused(&a, now());
        status.state = if resting { ConnectorState::Paused } else { ConnectorState::Connected };
        status.paused_until = resting.then_some(a.paused_until);
        status.user = Some(short_id(&a.user));
        status.last_inbound = (a.last_inbound != 0).then_some(a.last_inbound);
        status
    }

    pub fn status(&self) -> ConnectorStatus {
        let pending = self.env.store.count_pending(self.id()).unwrap_or(0);
        self.status_core(pending)
    }

    pub async fn status_async(&self) -> ConnectorStatus {
        let pending = self.env.store.count_pending_async(self.id()).await.unwrap_or(0);
        self.status_core(pending)
    }

    fn publish_status(&self, status: ConnectorStatus) {
        let Some(hub) = self.env.hub.upgrade() else { return };
        let mut told = self.told.lock();
        if told.as_ref() == Some(&status) {
            return;
        }
        *told = Some(status.clone());
        drop(told);
        hub.apply(vec![Fact::ConnectorChanged(FactConnectorChanged { at: now(), status })]);
    }

    /// Says the status to the core when a part of it changed.
    fn tell(&self) {
        if self.env.hub.upgrade().is_none() {
            return;
        }
        self.publish_status(self.status());
    }

    async fn tell_async(&self) {
        if self.env.hub.upgrade().is_none() {
            return;
        }
        let status = self.status_async().await;
        self.publish_status(status);
    }

    fn record_err(&self, e: impl Into<String>) -> bool {
        let e = e.into();
        let mut s = self.shown.lock();
        if s.error == e {
            return false;
        }
        s.error = e;
        true
    }

    fn set_err(&self, e: impl Into<String>) {
        if self.record_err(e) {
            self.tell();
        }
    }

    async fn set_err_async(&self, e: impl Into<String>) {
        if self.record_err(e) {
            self.tell_async().await;
        }
    }

    fn record_loaded(&self, account: Option<Account>, err: Option<String>) {
        let unread = account.as_ref().is_some_and(|a| !self.app.reads(&a.keys));
        {
            let mut s = self.shown.lock();
            s.account = account;
            if unread {
                s.error = t("server.connector.unreadSecrets", &[]);
            } else if let Some(err) = err {
                s.error = err;
            }
        }
        if unread {
            eprintln!("vibevalley-server: connector: {}: the saved secrets cannot be read", self.id().as_str());
        }
    }

    fn apply_loaded(&self, account: Option<Account>, err: Option<String>) {
        self.record_loaded(account, err);
        self.tell();
    }

    async fn apply_loaded_async(&self, account: Option<Account>, err: Option<String>) {
        self.record_loaded(account, err);
        self.tell_async().await;
    }

    fn reload(&self) -> Result<(), StoreFailed> {
        self.reload_with_err(None)
    }

    /// Updates account and error under one lock so observers never see a torn status (e.g. `paused` with empty `error`).
    fn reload_with_err(&self, err: Option<String>) -> Result<(), StoreFailed> {
        let account = self.env.store.account(self.id())?;
        self.apply_loaded(account, err);
        Ok(())
    }

    async fn reload_async(&self) -> Result<(), StoreFailed> {
        self.reload_with_err_async(None).await
    }

    async fn reload_with_err_async(&self, err: Option<String>) -> Result<(), StoreFailed> {
        let account = self.env.store.account_async(self.id()).await?;
        self.apply_loaded_async(account, err).await;
        Ok(())
    }

    /// Whether the pause was kept.
    async fn pause_async(&self) -> bool {
        match self.env.store.pause_async(self.id(), Some(now() + STALE_PAUSE_MS)).await {
            Ok(()) => match self.reload_with_err_async(Some(t("server.connector.expired", &[]))).await {
                Ok(()) => true,
                Err(e) => {
                    self.set_err_async(e.0).await;
                    false
                }
            },
            Err(e) => {
                self.set_err_async(e.0).await;
                false
            }
        }
    }

    fn wake(&self) {
        self.wake.notify_waiters();
    }

    /// Something that decides what still goes out changed (a read, newer words): the worker looks again.
    pub async fn changed_async(&self) {
        self.wake();
        self.tell_async().await;
    }

    /// A farm message for the user: kept to go out when it was said in the account's channel.
    pub async fn offer_async(self: &Arc<Self>, m: &ChatMessage) {
        let Some(a) = self.snapshot().filter(|a| !a.user.is_empty()) else { return };
        let location = match self.env.chat.message_location_async(&m.id).await {
            Ok(Some(loc)) => loc,
            Ok(None) => return,
            Err(e) => {
                self.set_err_async(e.message).await;
                return;
            }
        };
        let (place, top) = location;
        if top != a.channel.clone().unwrap_or_else(|| self.env.chat.default_channel()) {
            return;
        }
        let pieces = split_text(&user_line(m, &place), self.app.max_chars());
        match self.env.store.add_outgoing_async(self.id(), &m.id, &pieces, now()).await {
            Ok(()) if !pieces.is_empty() => self.changed_async().await,
            Ok(()) => {}
            Err(e) => self.set_err_async(e.0).await,
        }
    }

    /// Prepares pending outgoing batches asynchronously.
    async fn prepare_drain_async(self: &Arc<Self>, late: bool) -> Result<Option<DrainPlan>, ()> {
        let Some(a) = self.snapshot().filter(|a| !a.user.is_empty()) else {
            return Ok(None);
        };
        let id = self.id();
        let listed = match self.env.store.pending_outgoing_async(id).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("vibevalley-server: connector: {}: the outbox could not be read: {}", id.as_str(), e.0);
                return Err(());
            }
        };
        let mut settled: Vec<String> = vec![];
        let mut unseen: Vec<String> = vec![];
        for row in &listed {
            if settled.iter().any(|s| s == &row.message) || unseen.iter().any(|s| s == &row.message) {
                continue;
            }
            match handoff_async(&self.env.chat, &row.message).await {
                Ok(Handoff::Unseen) => unseen.push(row.message.clone()),
                Ok(Handoff::Settled) => {
                    if let Err(e) = self.env.store.withdraw_async(&row.message).await {
                        self.set_err_async(e.0).await;
                        return Err(());
                    }
                    settled.push(row.message.clone());
                }
                Err(e) => {
                    self.set_err_async(e.message).await;
                    return Err(());
                }
            }
        }
        let pending: Vec<_> = listed.iter().filter(|r| unseen.iter().any(|u| u == &r.message)).collect();
        if !settled.is_empty() {
            self.tell_async().await;
        }
        if paused(&a, now()) || pending.is_empty() {
            return Ok(None);
        }
        let batches: Vec<(Vec<i64>, String)> = if late && pending.len() > DIGEST_OVER {
            let lines: Vec<String> = pending.iter().map(|r| r.body.clone()).collect();
            vec![(pending.iter().map(|r| r.seq).collect(), digest(&lines))]
        } else {
            pending.iter().map(|r| (vec![r.seq], r.body.clone())).collect()
        };
        Ok(Some(DrainPlan { account: a, batches }))
    }

    /// Sends what waits, in order; false when some of it is held. Only the worker calls it, so a message sent is
    /// marked before the next is looked at.
    async fn drain(self: &Arc<Self>, late: bool, cancel: &CancellationToken) -> bool {
        let DrainPlan { account: a, batches } = match self.prepare_drain_async(late).await {
            Ok(Some(plan)) => plan,
            Ok(None) => return true,
            Err(()) => return false,
        };
        let id = self.id();
        for (rows, text) in batches {
            if cancel.is_cancelled() {
                return false;
            }
            let sent = self.app.send(&a.keys, &a.user, &text, &a.reply_context).await;
            let ok = match sent {
                Ok(ext) => match self.env.store.sent_async(&rows, now(), &ext).await {
                    Ok(()) => {
                        self.set_err_async("").await;
                        self.tell_async().await;
                        true
                    }
                    Err(e) => {
                        self.set_err_async(e.0).await;
                        false
                    }
                },
                Err(refused) => {
                    if let Err(e) = self.env.store.not_sent_async(&rows, &refused.message).await {
                        eprintln!("vibevalley-server: connector: {}: {}", id.as_str(), e.0);
                    }
                    match refused.kind {
                        FailedKind::Stale => {
                            self.pause_async().await;
                        }
                        // Tried again later, and with the user's next message.
                        FailedKind::Restricted => self.set_err_async("").await,
                        FailedKind::Failed => self.set_err_async(refused.message).await,
                    }
                    false
                }
            };
            if !ok {
                return false;
            }
        }
        true
    }

    async fn quoted_channel_async(self: &Arc<Self>, ext: &str) -> Result<Option<String>, Held> {
        if ext.is_empty() {
            return Ok(None);
        }
        let Some(message) = self.env.store.message_of_ext_async(self.id(), ext).await? else {
            return Ok(None);
        };
        Ok(self.env.chat.message_location_async(&message).await?.map(|(place, _)| place.id))
    }

    /// One message of the app's: the pairing word, or the user's words into the farm. The farm's id of what was said.
    async fn got(self: &Arc<Self>, m: &Inbound, cancel: &CancellationToken) -> Result<Option<String>, Held> {
        enum Step {
            Ignore,
            Paired(Account),
            Speak { key: String },
        }
        let step = {
            let Some(a) = self.snapshot() else { return Ok(None) };
            let id = self.id();
            if a.user.is_empty() {
                if a.pair_code.is_empty() || !is_pairing(&m.text, &a.pair_code) {
                    Step::Ignore
                } else {
                    self.env.store.paired_async(id, m, now()).await?;
                    self.shown.lock().account = self.env.store.account_async(id).await?;
                    Step::Paired(a)
                }
            } else if m.from != a.user {
                Step::Ignore
            } else {
                self.env.store.replied_async(id, &m.reply, now()).await?;
                self.reload_async().await?;
                let key = if m.text.is_empty() {
                    String::new()
                } else {
                    // Keyed by the app's message: one said but not yet settled when the farm stopped is said once, not twice.
                    Sha256::digest(format!("{}:{}", id.as_str(), m.id))
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                };
                Step::Speak { key }
            }
        };
        match step {
            Step::Ignore => Ok(None),
            Step::Paired(a) => {
                // Told once the user has the word: the status is not paired before the app's confirmation went out.
                if let Err(e) = self.app.send(&a.keys, &m.from, &t("server.connector.paired", &[]), &m.reply).await {
                    eprintln!(
                        "vibevalley-server: connector: {}: the pairing confirmation was not sent: {}",
                        self.id().as_str(),
                        e.message
                    );
                }
                self.tell_async().await;
                Ok(None)
            }
            Step::Speak { key } => {
                let said = if key.is_empty() {
                    None
                } else {
                    let channel = match self.quoted_channel_async(&m.quoted).await? {
                        Some(c) => Some(c),
                        None => self.snapshot().and_then(|a| a.channel),
                    };
                    let (message, _) = self
                        .env
                        .chat
                        .say_async(Saying {
                            text: m.text.clone(),
                            channel,
                            send_key: key,
                            source: Some("connector".into()),
                            ..Saying::default()
                        })
                        .await?;
                    Some(message.id)
                };
                // The user's words withdraw what they answer, before the fresh reply opens the app's delivery window.
                self.drain(true, cancel).await;
                Ok(said)
            }
        }
    }

    async fn drain_inbox(self: &Arc<Self>, cancel: &CancellationToken) -> Result<(), Held> {
        let id = self.id();
        let pending = self.env.store.pending_inbound_async(id).await?;
        for m in pending {
            if cancel.is_cancelled() {
                break;
            }
            let said = self.got(&m, cancel).await?;
            self.env.store.delivered_async(id, &m.id, said.as_deref()).await?;
        }
        Ok(())
    }

    /// The worker: what came in goes to the farm in order, then what waits goes out; what is held is tried again.
    async fn work(self: Arc<Self>, cancel: CancellationToken) {
        let span = tracing::debug_span!("connector.bridge", account_id = self.id().as_str(), role = "work");
        async move {
            let mut backoff = self.env.retry_backoff();
            let mut current_delay: Option<Duration> = None;
            while !cancel.is_cancelled() {
                let notified = self.wake.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let taken = match self.drain_inbox(&cancel).await {
                    Ok(()) => true,
                    Err(e) => {
                        self.set_err_async(e.0).await;
                        false
                    }
                };
                let held = !self.drain(false, &cancel).await || !taken;
                if !held {
                    backoff = self.env.retry_backoff();
                    current_delay = None;
                }
                let wait_for = if held {
                    *current_delay.get_or_insert_with(|| backoff.next().unwrap_or(self.env.retry_most))
                } else {
                    IDLE
                };
                enum Step {
                    Stopped,
                    Woke,
                    TimedOut,
                }
                let step = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Step::Stopped,
                    _ = notified => Step::Woke,
                    _ = tokio::time::sleep(wait_for) => Step::TimedOut,
                };
                match step {
                    Step::Stopped => break,
                    Step::Woke => {}
                    Step::TimedOut if held => {
                        current_delay = Some(backoff.next().unwrap_or(self.env.retry_most));
                    }
                    Step::TimedOut => {}
                }
            }
        }
        .instrument(span)
        .await
    }

    fn accept(&self, messages: Vec<Inbound>, cursor: &str) -> Result<(), AppFailed> {
        let named: Vec<Inbound> = messages
            .into_iter()
            .map(|m| {
                if m.id.is_empty() {
                    Inbound {
                        id: uuid::Uuid::now_v7().to_string(),
                        ..m
                    }
                } else {
                    m
                }
            })
            .collect();
        match self.env.store.accept(self.id(), &named, cursor, now()) {
            Ok(true) => {
                self.wake();
                Ok(())
            }
            Ok(false) => Err(AppFailed::failed(t("server.connector.stopped", &[]))),
            Err(e) => {
                if !self.closing() {
                    self.set_err(e.0.clone());
                }
                Err(AppFailed::failed(e.0))
            }
        }
    }

    /// Receives until stopped: a connection that ends is opened again, a stale login rests.
    async fn receiving(self: Arc<Self>, cancel: CancellationToken) {
        let id = self.id();
        let span = tracing::debug_span!("connector.bridge", account_id = id.as_str(), role = "receiving");
        async move {
            let mut failures = 0;
            loop {
                let Some(a) = self.snapshot() else { return };
                if paused(&a, now()) {
                    if sleep_or_cancel(&cancel, Duration::from_millis((a.paused_until - now()).max(0) as u64)).await {
                        return;
                    }
                    if let Err(e) = self.env.store.pause_async(id, None).await {
                        self.set_err_async(e.0).await;
                        if sleep_or_cancel(&cancel, self.env.reconnect).await {
                            return;
                        }
                    } else if let Err(e) = self.reload_async().await {
                        self.set_err_async(e.0).await;
                        if sleep_or_cancel(&cancel, self.env.reconnect).await {
                            return;
                        }
                    }
                    continue;
                }
                let cursor = match self.env.store.account_async(id).await {
                    Ok(row) => row.map(|r| r.cursor).unwrap_or_default(),
                    Err(e) => {
                        self.set_err_async(e.0).await;
                        if sleep_or_cancel(&cancel, self.env.reconnect).await {
                            return;
                        }
                        continue;
                    }
                };
                let accept = |messages: Vec<Inbound>, cursor: &str| self.accept(messages, cursor);
                let io = Receiving { cursor, accept: &accept };
                let ended = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    ended = self.app.receive(&a.keys, &io) => ended,
                };
                if ended.kind == FailedKind::Stale {
                    let paused_ok = self.pause_async().await;
                    if !paused_ok && sleep_or_cancel(&cancel, self.env.reconnect).await {
                        return;
                    }
                    continue;
                }
                self.set_err_async(ended.message).await;
                failures += 1;
                let mut wait = self.env.reconnect;
                if failures >= 3 {
                    wait *= 15;
                    failures = 0;
                }
                if sleep_or_cancel(&cancel, wait).await {
                    return;
                }
            }
        }
        .instrument(span)
        .await
    }

    fn child_cancel(&self) -> CancellationToken {
        self.env.hub.upgrade().map(|h| h.child_token()).unwrap_or_default()
    }

    fn spawn_task(&self, fut: impl Future<Output = ()> + Send + 'static) -> JoinHandle<()> {
        if let Some(hub) = self.env.hub.upgrade() {
            hub.spawn_task(fut)
        } else {
            vibevalley_runtime::rt::current_or_global_handle().spawn(fut.in_current_span().with_current_subscriber())
        }
    }

    async fn stop_generation(current: &mut Option<Generation>) {
        let Some(g) = current.take() else { return };
        g.cancel.cancel();
        for task in g.tasks {
            let _ = task.await;
        }
    }

    fn connected(self: &Arc<Self>) -> Option<Generation> {
        if self.closing() || self.snapshot().is_none() {
            return None;
        }
        let cancel = self.child_cancel();
        let receiving = self.spawn_task(self.clone().receiving(cancel.clone()));
        let worker = self.spawn_task(self.clone().work(cancel.clone()));
        Some(Generation {
            cancel,
            tasks: vec![receiving, worker],
        })
    }

    fn logging_in(self: &Arc<Self>, input: ConnectorLogin, attempt: u64) -> Generation {
        let cancel = self.child_cancel();
        let (b, c) = (self.clone(), cancel.clone());
        let login = self.spawn_task(async move {
            let progress = |p: Progress| {
                {
                    let mut shown = b.shown.lock();
                    if shown.login_try != attempt {
                        return;
                    }
                    let code = shown.signing_in.take().map(|x| x.code).unwrap_or_default();
                    shown.signing_in = Some(SigningIn { progress: p, code });
                }
                b.progressed.notify_waiters();
                b.tell();
            };
            let code = || b.shown.lock().signing_in.as_ref().map(|x| x.code.clone()).unwrap_or_default();
            let io = LoginIo {
                progress: &progress,
                code: &code,
            };
            if let Some(result) = b.app.login(&input, &io, &c).await {
                b.logged_in(&c, result).await;
            }
        });
        Generation { cancel, tasks: vec![login] }
    }

    /// The login's answer, taken as a command by the login's own task: a newer command that stops it first wins.
    async fn logged_in(
        self: &Arc<Self>,
        cancel: &CancellationToken,
        result: Result<super::adapter::Linked<crate::modules::infra::setting::Secret>, AppFailed>,
    ) {
        let Some(mut current) = (tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            guard = self.commands.lock() => Some(guard),
        }) else {
            return;
        };
        if cancel.is_cancelled() {
            return;
        }
        // This task is the generation: it ends by returning.
        *current = None;
        let failure = match result {
            Err(e) => Some(e.message),
            Ok(_) if self.closing() => None,
            Ok(linked) => {
                let pair = linked.user.is_empty().then(pair_code);
                let kept = self
                    .env
                    .store
                    .connect_async(
                        self.id(),
                        &linked.keys,
                        &linked.user,
                        pair.as_deref(),
                        now(),
                        &t("server.connector.switched", &[]),
                    )
                    .await;
                match kept {
                    Ok(()) => match self.reload_async().await {
                        Ok(()) => None,
                        Err(e) => Some(e.0),
                    },
                    Err(e) => Some(e.0),
                }
            }
        };
        {
            let mut shown = self.shown.lock();
            shown.error = failure.unwrap_or_default();
            shown.signing_in = None;
        }
        self.progressed.notify_waiters();
        *current = self.connected();
        drop(current);
        self.tell_async().await;
    }

    pub fn load(&self) {
        if let Err(e) = self.reload() {
            eprintln!("vibevalley-server: connector: {}: {}", self.id().as_str(), e.0);
        }
    }

    /// Goes on with the account there is.
    pub fn resume(self: &Arc<Self>) {
        if let Ok(mut current) = self.commands.try_lock()
            && current.is_none()
        {
            *current = self.connected();
        }
    }

    pub async fn login_async(self: &Arc<Self>, input: ConnectorLogin) -> ConnectorStatus {
        let started = {
            let mut current = self.commands.lock().await;
            let going = self.shown.lock().signing_in.is_some();
            if going && input.force != Some(true) {
                self.shown.lock().login_try
            } else {
                Self::stop_generation(&mut current).await;
                let attempt = {
                    let mut shown = self.shown.lock();
                    shown.login_try += 1;
                    shown.error.clear();
                    shown.signing_in = Some(SigningIn {
                        progress: Progress {
                            state: ConnectorState::Waiting,
                            qr: String::new(),
                        },
                        code: String::new(),
                    });
                    shown.login_try
                };
                *current = Some(self.logging_in(input, attempt));
                attempt
            }
        };
        self.tell_async().await;
        // The answer carries the code when it shows within a moment.
        let deadline = tokio::time::Instant::now() + self.env.moment;
        loop {
            let notified = self.progressed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let there = {
                let shown = self.shown.lock();
                shown.login_try != started || shown.signing_in.as_ref().is_none_or(|x| !x.progress.qr.is_empty())
            };
            if there {
                break;
            }
            let now_inst = tokio::time::Instant::now();
            let Some(left) = deadline.checked_duration_since(now_inst) else {
                break;
            };
            if tokio::time::timeout(left, notified).await.is_err() {
                break;
            }
        }
        self.status_async().await
    }

    /// The code the user typed for the login going on; with none going on it is for none.
    pub async fn verify_async(&self, code: &str) -> ConnectorStatus {
        if let Some(signing) = self.shown.lock().signing_in.as_mut() {
            if signing.progress.state == ConnectorState::Verify {
                signing.progress.state = ConnectorState::Scanned;
            }
            signing.code = code.trim().to_string();
        }
        self.tell_async().await;
        self.status_async().await
    }

    pub async fn logout_async(self: &Arc<Self>) -> ConnectorStatus {
        {
            let mut current = self.commands.lock().await;
            Self::stop_generation(&mut current).await;
            let gone = self.env.store.disconnect_async(self.id(), &t("server.connector.disconnected", &[])).await;
            {
                let mut shown = self.shown.lock();
                shown.signing_in = None;
                shown.login_try += 1;
                match &gone {
                    Ok(()) => {
                        shown.account = None;
                        shown.error.clear();
                    }
                    Err(e) => shown.error = e.0.clone(),
                }
            }
            self.progressed.notify_waiters();
            if gone.is_err() {
                *current = self.connected();
            }
        }
        self.tell_async().await;
        self.status_async().await
    }

    pub async fn set_channel_async(&self, channel: Option<&str>) -> Result<ConnectorStatus, StoreFailed> {
        self.env.store.set_channel_async(self.id(), channel).await?;
        self.reload_async().await?;
        Ok(self.status_async().await)
    }

    pub fn has_account(&self) -> bool {
        self.snapshot().is_some()
    }

    pub async fn stop_async(&self) {
        let mut current = self.commands.lock().await;
        Self::stop_generation(&mut current).await;
    }
}
