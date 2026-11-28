//! One chat app's account on the farm: its login, and while it is connected
//! a Tokio task that receives and a Tokio task that works through what came in
//! and what goes out, both cancelled and awaited before the account is replaced.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ConnectorID, ConnectorLogin, ConnectorState, ConnectorStatus};

use super::adapter::{App, AppFailed, ConnectorHost, FailedKind, Inbound, InboundDispatch, LoginIo, Progress, Receiving};
use super::render::{DIGEST_OVER, DigestEntry, adapt_notification, is_pairing, parse_digest_entry, render_digest, short_id, split_text};
use crate::context::{Context, now};
use crate::service::DbError;
use crate::service::connector::{ConnectorAccountRow, ConnectorInboundRow, ConnectorOutgoingRow};
use crate::setting::{Secret, Setting};

/// WeChat's official client rests this long too.
const STALE_PAUSE_MS: i64 = 60 * 60_000;
/// The worker looks again this often when nothing wakes it.
const IDLE: Duration = Duration::from_secs(60);

/// Account row hydrated with its credentials sealed inside [`Secret`].
#[derive(Clone)]
pub(super) struct Account {
    pub keys: Secret,
    /// `""` until the user pairs by a message.
    pub user: String,
    pub pair_code: String,
    pub reply_context: String,
    pub last_inbound: i64,
    pub paused_until: i64,
    pub connected_at: i64,
    pub channel: Option<String>,
}

impl From<ConnectorAccountRow> for Account {
    fn from(r: ConnectorAccountRow) -> Self {
        Self {
            keys: Secret::new(r.secrets),
            user: r.user,
            pair_code: r.pair_code,
            reply_context: r.reply_context,
            last_inbound: r.last_inbound,
            paused_until: r.paused_until,
            connected_at: r.connected_at,
            channel: r.channel,
        }
    }
}

fn inbound_to_row(m: &Inbound) -> ConnectorInboundRow {
    ConnectorInboundRow {
        id: m.id.clone(),
        from: m.from.clone(),
        text: m.text.clone(),
        reply: m.reply.clone(),
        quoted: m.quoted.clone(),
    }
}

fn inbound_from_row(r: ConnectorInboundRow) -> Inbound {
    Inbound {
        id: r.id,
        from: r.from,
        text: r.text,
        reply: r.reply,
        quoted: r.quoted,
    }
}

/// What every bridge works with.
pub struct Env {
    pub ctx: Arc<Context>,
    pub setting: Arc<Setting>,
    pub host: Arc<dyn ConnectorHost>,
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
#[derive(Debug)]
struct Held(String);

impl From<DbError> for Held {
    fn from(e: DbError) -> Held {
        Held(e.to_string())
    }
}

impl From<ApiError> for Held {
    fn from(e: ApiError) -> Held {
        Held(e.message)
    }
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

/// One logical outgoing delivery batch, possibly split across channel-sized pieces.
struct DrainBatch {
    seqs: Vec<i64>,
    pieces: Vec<String>,
}

/// Prepared outgoing work for [`Bridge::drain`].
struct DrainPlan {
    account: Account,
    batches: Vec<DrainBatch>,
}

fn coalesce_outgoing(rows: &[&ConnectorOutgoingRow]) -> Vec<(String, String)> {
    let mut grouped: Vec<(String, String)> = Vec::new();
    for row in rows {
        if let Some((_, existing_body)) = grouped.iter_mut().find(|(msg, _)| msg == &row.message) {
            if !existing_body.is_empty() && !row.body.is_empty() {
                existing_body.push('\n');
            }
            existing_body.push_str(&row.body);
        } else {
            grouped.push((row.message.clone(), row.body.clone()));
        }
    }
    grouped
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
            status.channel = self.env.host.channel_name(a.channel.as_deref()).filter(|n| !n.is_empty());
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

    pub async fn status_async(&self) -> ConnectorStatus {
        let pending = self.env.ctx.service.connector.count_pending(self.id()).await.unwrap_or(0);
        self.status_core(pending)
    }

    fn publish_status(&self, status: ConnectorStatus) {
        if self.closing() {
            return;
        }
        let mut told = self.told.lock();
        if told.as_ref() == Some(&status) {
            return;
        }
        *told = Some(status.clone());
        drop(told);
        if self.env.ctx.live.upsert_connector(status) {
            self.env.ctx.mark_dirty(SliceMask::COLLAB);
        }
    }

    async fn tell_async(&self) {
        if self.closing() {
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

    async fn set_err_async(&self, e: impl Into<String>) {
        if self.record_err(e) {
            self.tell_async().await;
        }
    }

    async fn clear_transient_err_async(&self) {
        let changed = {
            let mut s = self.shown.lock();
            if s.account.as_ref().is_some_and(|a| paused(a, now())) || s.error.is_empty() {
                false
            } else {
                s.error.clear();
                true
            }
        };
        if changed {
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

    async fn apply_loaded_async(&self, account: Option<Account>, err: Option<String>) {
        self.record_loaded(account, err);
        self.tell_async().await;
    }

    async fn reload_async(&self) -> Result<(), DbError> {
        self.reload_with_err_async(None).await
    }

    /// Updates account and error under one lock so observers never see a torn status (e.g. `paused` with empty `error`).
    async fn reload_with_err_async(&self, err: Option<String>) -> Result<(), DbError> {
        let account = self.env.ctx.service.connector.account(self.id()).await?.map(Account::from);
        self.apply_loaded_async(account, err).await;
        Ok(())
    }

    /// Whether the pause was kept.
    async fn pause_async(&self) -> bool {
        match self.env.ctx.service.connector.pause(self.id(), Some(now() + STALE_PAUSE_MS)).await {
            Ok(()) => match self.reload_with_err_async(Some(t("server.connector.expired", &[]))).await {
                Ok(()) => true,
                Err(e) => {
                    self.set_err_async(e.to_string()).await;
                    false
                }
            },
            Err(e) => {
                self.set_err_async(e.to_string()).await;
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

    /// Queues a pre-formatted channel message to go out to the paired peer.
    pub async fn offer_text_async(self: &Arc<Self>, message_id: &str, text: &str) {
        if self.snapshot().filter(|a| !a.user.is_empty()).is_none() {
            return;
        }
        let pieces = split_text(text, self.app.max_chars());
        match self.env.ctx.service.connector.add_outgoing(self.id(), message_id, &pieces, now()).await {
            Ok(()) if !pieces.is_empty() => self.changed_async().await,
            Ok(()) => {}
            Err(e) => self.set_err_async(e.to_string()).await,
        }
    }

    /// A personal notification or scheduled digest pushed directly to the linked peer.
    pub async fn offer_notification_async(self: &Arc<Self>, message_id: &str, body: &str, at: i64) {
        if self.snapshot().filter(|a| !a.user.is_empty()).is_none() {
            return;
        }
        let pieces = split_text(body, self.app.max_chars());
        match self.env.ctx.service.connector.add_outgoing_once(self.id(), message_id, &pieces, at).await {
            Ok(true) => self.changed_async().await,
            Ok(false) => {}
            Err(e) => self.set_err_async(e.to_string()).await,
        }
    }

    /// Withdraws one specific pending push message by exact `message_id`.
    pub async fn withdraw_push_message_async(self: &Arc<Self>, message_id: &str) {
        if self.env.ctx.service.connector.withdraw(message_id).await.is_ok() {
            self.tell_async().await;
        }
    }

    /// Withdraws all pending outgoing rows whose `message_id` starts with `prefix`.
    pub async fn withdraw_prefix_async(self: &Arc<Self>, prefix: &str) {
        let connectors = &self.env.ctx.service.connector;
        let Ok(listed) = connectors.pending_outgoing(self.id()).await else {
            return;
        };
        let mut withdrew = false;
        for row in listed {
            if row.message.starts_with(prefix) && connectors.withdraw(&row.message).await.is_ok() {
                withdrew = true;
            }
        }
        if withdrew {
            self.tell_async().await;
        }
    }

    /// Explicitly bound channel id (`None` means default channel).
    pub fn bound_channel_id(&self) -> Option<String> {
        self.snapshot().and_then(|a| a.channel)
    }

    /// Prepares pending outgoing batches asynchronously.
    async fn prepare_drain_async(self: &Arc<Self>, late: bool) -> Result<Option<DrainPlan>, ()> {
        let Some(a) = self.snapshot().filter(|a| !a.user.is_empty()) else {
            return Ok(None);
        };
        let id = self.id();
        let connectors = &self.env.ctx.service.connector;
        let listed = match connectors.pending_outgoing(id).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("vibevalley-server: connector: {}: the outbox could not be read: {e}", id.as_str());
                return Err(());
            }
        };
        let mut settled: Vec<String> = vec![];
        let mut unseen: Vec<String> = vec![];
        for row in &listed {
            if settled.iter().any(|s| s == &row.message) || unseen.iter().any(|s| s == &row.message) {
                continue;
            }
            match self.env.host.is_outgoing_unseen(&row.message).await {
                Ok(true) => unseen.push(row.message.clone()),
                Ok(false) => {
                    if let Err(e) = connectors.withdraw(&row.message).await {
                        self.set_err_async(e.to_string()).await;
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
        let (digests, regular): (Vec<_>, Vec<_>) = pending.into_iter().partition(|r| r.message.starts_with("digest:"));
        let mut batches: Vec<DrainBatch> = Vec::new();
        let coalesced = coalesce_outgoing(&regular);
        if late && coalesced.len() > DIGEST_OVER {
            let entries: Vec<DigestEntry> = coalesced.into_iter().map(|(message_id, body)| parse_digest_entry(&message_id, &body)).collect();
            let rendered = render_digest(id, &entries);
            let pieces = split_text(&rendered, self.app.max_chars());
            batches.push(DrainBatch {
                seqs: regular.iter().map(|r| r.seq).collect(),
                pieces,
            });
        } else {
            for r in regular {
                let text = if r.message.starts_with("push:") {
                    adapt_notification(id, &r.body)
                } else {
                    r.body.clone()
                };
                let pieces = split_text(&text, self.app.max_chars());
                batches.push(DrainBatch { seqs: vec![r.seq], pieces });
            }
        }
        for r in digests {
            let pieces = split_text(&r.body, self.app.max_chars());
            batches.push(DrainBatch { seqs: vec![r.seq], pieces });
        }
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
        let connectors = &self.env.ctx.service.connector;
        for batch in batches {
            let mut last_ext = String::new();
            for piece in batch.pieces {
                if cancel.is_cancelled() {
                    return false;
                }
                match self.app.send(&a.keys, &a.user, &piece, &a.reply_context).await {
                    Ok(ext) => last_ext = ext,
                    Err(refused) => {
                        if let Err(e) = connectors.not_sent(&batch.seqs, &refused.message).await {
                            eprintln!("vibevalley-server: connector: {}: {e}", id.as_str());
                        }
                        match refused.kind {
                            FailedKind::Stale => {
                                self.pause_async().await;
                            }
                            // Tried again later, and with the user's next message.
                            FailedKind::Restricted => self.clear_transient_err_async().await,
                            FailedKind::Failed => self.set_err_async(refused.message).await,
                        }
                        return false;
                    }
                }
            }
            match connectors.sent(&batch.seqs, now(), &last_ext).await {
                Ok(()) => {
                    self.clear_transient_err_async().await;
                    self.tell_async().await;
                }
                Err(e) => {
                    self.set_err_async(e.to_string()).await;
                    return false;
                }
            }
        }
        true
    }

    async fn quoted_message_id_async(&self, ext: &str) -> Result<Option<String>, Held> {
        if ext.is_empty() {
            return Ok(None);
        }
        Ok(self.env.ctx.service.connector.message_of_ext(self.id(), ext).await?)
    }

    async fn send_reply_receipt_async(self: &Arc<Self>, inbound_id: &str, receipt: &str, cancel: &CancellationToken) -> Result<(), Held> {
        let pieces = split_text(receipt, self.app.max_chars());
        let receipt_msg_id = format!("push:receipt:{inbound_id}");
        if self
            .env
            .ctx
            .service
            .connector
            .add_outgoing_once(self.id(), &receipt_msg_id, &pieces, now())
            .await?
        {
            self.tell_async().await;
        }
        self.drain(false, cancel).await;
        Ok(())
    }

    /// One message of the app's: the pairing word, or delegated to [`ConnectorHost::handle_inbound`].
    async fn got(self: &Arc<Self>, m: &Inbound, cancel: &CancellationToken) -> Result<Option<String>, Held> {
        enum Step {
            Ignore,
            Paired(Account),
            Speak { key: String },
        }
        let step = {
            let Some(a) = self.snapshot() else { return Ok(None) };
            let id = self.id();
            let connectors = &self.env.ctx.service.connector;
            if a.user.is_empty() {
                if a.pair_code.is_empty() || !is_pairing(&m.text, &a.pair_code) {
                    Step::Ignore
                } else {
                    connectors.paired(id, &m.from, &m.id, &m.reply, now()).await?;
                    self.shown.lock().account = connectors.account(id).await?.map(Account::from);
                    Step::Paired(a)
                }
            } else if m.from != a.user {
                Step::Ignore
            } else {
                connectors.replied(id, &m.reply, now()).await?;
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
                let quoted_message_id = self.quoted_message_id_async(&m.quoted).await?;
                let bound_channel_id = self.snapshot().and_then(|a| a.channel);
                let handled = self
                    .env
                    .host
                    .handle_inbound(InboundDispatch {
                        connector: self.id(),
                        inbound_id: m.id.clone(),
                        text: m.text.clone(),
                        send_key: key,
                        quoted_message_id,
                        bound_channel_id,
                    })
                    .await?;
                for msg_id in &handled.withdraw_messages {
                    self.withdraw_push_message_async(msg_id).await;
                }
                for prefix in &handled.withdraw_prefixes {
                    self.withdraw_prefix_async(prefix).await;
                }
                if let Some(reply) = handled.reply_text {
                    self.send_reply_receipt_async(&m.id, &reply, cancel).await?;
                    return Ok(handled.delivered_id);
                }
                // The user's words withdraw what they answer, before the fresh reply opens the app's delivery window.
                self.drain(true, cancel).await;
                Ok(handled.delivered_id)
            }
        }
    }

    async fn drain_inbox(self: &Arc<Self>, cancel: &CancellationToken) -> Result<(), Held> {
        let id = self.id();
        let connectors = &self.env.ctx.service.connector;
        let pending: Vec<Inbound> = connectors.pending_inbound(id).await?.into_iter().map(inbound_from_row).collect();
        for m in pending {
            if cancel.is_cancelled() {
                break;
            }
            let said = self.got(&m, cancel).await?;
            connectors.delivered(id, &m.id, said.as_deref()).await?;
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

    async fn accept_async(&self, messages: Vec<Inbound>, cursor: String) -> Result<(), AppFailed> {
        let named: Vec<ConnectorInboundRow> = messages
            .into_iter()
            .map(|m| {
                let m = if m.id.is_empty() {
                    Inbound {
                        id: uuid::Uuid::now_v7().to_string(),
                        ..m
                    }
                } else {
                    m
                };
                inbound_to_row(&m)
            })
            .collect();
        match self.env.ctx.service.connector.accept(self.id(), &named, &cursor, now()).await {
            Ok(true) => {
                self.wake();
                Ok(())
            }
            Ok(false) => Err(AppFailed::failed(t("server.connector.stopped", &[]))),
            Err(e) => {
                let msg = e.to_string();
                if !self.closing() {
                    self.set_err_async(msg.clone()).await;
                }
                Err(AppFailed::failed(msg))
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
                    if let Err(e) = self.env.ctx.service.connector.pause(id, None).await {
                        self.set_err_async(e.to_string()).await;
                        if sleep_or_cancel(&cancel, self.env.reconnect).await {
                            return;
                        }
                    } else if let Err(e) = self.reload_async().await {
                        self.set_err_async(e.to_string()).await;
                        if sleep_or_cancel(&cancel, self.env.reconnect).await {
                            return;
                        }
                    }
                    continue;
                }
                let cursor = match self.env.ctx.service.connector.account(id).await {
                    Ok(row) => row.map(|r| r.cursor).unwrap_or_default(),
                    Err(e) => {
                        self.set_err_async(e.to_string()).await;
                        if sleep_or_cancel(&cancel, self.env.reconnect).await {
                            return;
                        }
                        continue;
                    }
                };
                let accept = |messages: Vec<Inbound>, cursor: String| -> super::adapter::BoxFuture<'_, Result<(), AppFailed>> {
                    Box::pin(self.accept_async(messages, cursor))
                };
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
        self.env.ctx.task.child_token()
    }

    fn spawn_task(&self, fut: impl Future<Output = ()> + Send + 'static) -> JoinHandle<()> {
        self.env.ctx.task.spawn(fut)
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
            let (tell_tx, mut tell_rx) = vibevalley_kit::queue::bounded_stream::<()>(
                std::num::NonZeroUsize::new(1).expect("non-zero"),
                vibevalley_kit::queue::OverflowPolicy::DropNewest,
            );
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
                let _ = tell_tx.try_send(());
            };
            let code = || b.shown.lock().signing_in.as_ref().map(|x| x.code.clone()).unwrap_or_default();
            let io = LoginIo {
                progress: &progress,
                code: &code,
            };
            let result = {
                let login_fut = b.app.login(&input, &io, &c);
                tokio::pin!(login_fut);
                loop {
                    tokio::select! {
                        res = &mut login_fut => break res,
                        Some(()) = tell_rx.recv() => {
                            while tell_rx.try_recv().is_some() {}
                            b.tell_async().await;
                        }
                    }
                }
            };
            if let Some(result) = result {
                b.logged_in(&c, result).await;
            }
        });
        Generation { cancel, tasks: vec![login] }
    }

    /// The login's answer, taken as a command by the login's own task: a newer command that stops it first wins.
    async fn logged_in(self: &Arc<Self>, cancel: &CancellationToken, result: Result<super::adapter::Linked<Secret>, AppFailed>) {
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
                    .ctx
                    .service
                    .connector
                    .connect(
                        self.id(),
                        linked.keys.expose(),
                        &linked.user,
                        pair.as_deref(),
                        now(),
                        &t("server.connector.switched", &[]),
                    )
                    .await;
                match kept {
                    Ok(()) => match self.reload_async().await {
                        Ok(()) => None,
                        Err(e) => Some(e.to_string()),
                    },
                    Err(e) => Some(e.to_string()),
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

    pub async fn load_async(&self) {
        if let Err(e) = self.reload_async().await {
            eprintln!("vibevalley-server: connector: {}: {e}", self.id().as_str());
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
            let gone = self
                .env
                .ctx
                .service
                .connector
                .disconnect(self.id(), &t("server.connector.disconnected", &[]))
                .await;
            {
                let mut shown = self.shown.lock();
                shown.signing_in = None;
                shown.login_try += 1;
                match &gone {
                    Ok(()) => {
                        shown.account = None;
                        shown.error.clear();
                    }
                    Err(e) => shown.error = e.to_string(),
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

    pub async fn set_channel_async(&self, channel: Option<&str>) -> Result<ConnectorStatus, DbError> {
        self.env.ctx.service.connector.set_channel(self.id(), channel).await?;
        self.reload_async().await?;
        Ok(self.status_async().await)
    }

    pub fn has_account(&self) -> bool {
        self.snapshot().is_some()
    }

    pub fn is_paired(&self) -> bool {
        self.snapshot().is_some_and(|a| !a.user.is_empty())
    }

    pub async fn stop_async(&self) {
        let mut current = self.commands.lock().await;
        Self::stop_generation(&mut current).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    use parking_lot::Mutex;
    use tokio_util::sync::CancellationToken;
    use vibevalley_core::ManualClock;
    use vibevalley_protocol::{ApiError, ConnectorID, ConnectorLogin};

    use super::*;
    use crate::connector::adapter::{AppFailed, BoxFuture, ConnectorHost, InboundDispatch, InboundHandled, Linked, LoginIo, Receiving};
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::service::Service;
    use crate::setting::{Setting, SettingConfig};

    struct AlwaysUnseenHost;

    impl ConnectorHost for AlwaysUnseenHost {
        fn channel_name(&self, _channel_id: Option<&str>) -> Option<String> {
            Some("general".into())
        }

        fn is_outgoing_unseen<'a>(&'a self, _message_id: &'a str) -> BoxFuture<'a, Result<bool, ApiError>> {
            Box::pin(async { Ok(true) })
        }

        fn handle_inbound<'a>(&'a self, _req: InboundDispatch) -> BoxFuture<'a, Result<InboundHandled, ApiError>> {
            Box::pin(async { Ok(InboundHandled::default()) })
        }
    }

    static LOCALE_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn late_drain_routes_nineteen_review_notifications_through_channel_renderer() {
        let _locale = LOCALE_GUARD.lock().await;
        struct ChannelStubApp {
            id: ConnectorID,
            max_chars: usize,
            sent: Mutex<Vec<String>>,
        }

        impl App for ChannelStubApp {
            fn id(&self) -> ConnectorID {
                self.id
            }

            fn max_chars(&self) -> usize {
                self.max_chars
            }

            fn reads(&self, _: &Secret) -> bool {
                true
            }

            fn login<'a>(
                &'a self,
                _: &'a ConnectorLogin,
                _: &'a LoginIo<'a>,
                _: &'a CancellationToken,
            ) -> super::super::adapter::BoxFuture<'a, Option<Result<Linked<Secret>, AppFailed>>> {
                unreachable!()
            }

            fn receive<'a>(&'a self, _: &'a Secret, _: &'a Receiving<'a>) -> super::super::adapter::BoxFuture<'a, AppFailed> {
                unreachable!()
            }

            fn send<'a>(&'a self, _: &'a Secret, _: &'a str, text: &'a str, _: &'a str) -> super::super::adapter::BoxFuture<'a, Result<String, AppFailed>> {
                let mut sent = self.sent.lock();
                sent.push(text.to_owned());
                let ext = format!("ext-{}", sent.len());
                Box::pin(async move { Ok(ext) })
            }
        }

        for (channel, max_chars) in [(ConnectorID::Weixin, 1800), (ConnectorID::Feishu, 4000), (ConnectorID::Qq, 2000)] {
            vibevalley_i18n::set_locale("zh");
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path().join("home");
            let work = dir.path().join("work");
            tokio::fs::create_dir_all(&home).await.unwrap();
            tokio::fs::create_dir_all(&work).await.unwrap();

            let service = Service::open(&home).await.unwrap();
            let clock = Arc::new(ManualClock::new(1_700_000_000_000));
            let outbox = Arc::new(Outbox::new(service.clone()).with_clock(clock.clone()));
            let ctx = Arc::new(Context::new(
                service.clone(),
                TaskGroup::new(),
                Arc::new(LiveState::new()),
                outbox,
                Arc::new(StateFeed::new()),
                clock,
                Arc::new(Http),
                Arc::new(PublicDownload),
            ));
            let setting = Setting::open_async(SettingConfig {
                home: home.clone(),
                work_root: work,
                version: "0.1.0".into(),
                deepseek_api_key: String::new(),
                github_token: None,
                storage_backend: None,
            })
            .await;
            let env = Arc::new(Env {
                ctx: ctx.clone(),
                setting,
                host: Arc::new(AlwaysUnseenHost),
                retry_first: Duration::from_millis(50),
                retry_most: Duration::from_millis(200),
                reconnect: Duration::from_millis(50),
                moment: Duration::from_millis(50),
                closing: AtomicBool::new(false),
            });
            let app = Arc::new(ChannelStubApp {
                id: channel,
                max_chars,
                sent: Mutex::new(Vec::new()),
            });
            let bridge = Bridge::new(app.clone(), env);
            service.connector.connect(channel, "{}", "peer-1", None, 1_000, "retired").await.unwrap();
            bridge.load_async().await;

            // Queue 19 pending review notifications (simulating legacy repeated-title bodies + deduplicated bodies).
            for n in 83..102 {
                let body = format!("【待你验收 · #{n} [UX/工作区] 工单标题 {n}】\n[UX/工作区] 工单标题 {n}\n\n请在工作台验收或回复意见。");
                ctx.service
                    .connector
                    .add_outgoing_once(channel, &format!("push:run:reviewing:r-{n}"), &[body], 2_000 + n)
                    .await
                    .unwrap();
            }
            assert_eq!(ctx.service.connector.count_pending(channel).await.unwrap(), 19);

            let cancel = CancellationToken::new();
            assert!(bridge.drain(true, &cancel).await);
            assert_eq!(ctx.service.connector.count_pending(channel).await.unwrap(), 0);

            let sent = app.sent.lock().clone();
            assert_eq!(sent.len(), 1, "{channel:?} should coalesce 19 items into 1 digest message");
            let text = &sent[0];
            assert!(text.contains("1. #83 [UX/工作区] 工单标题 83"), "{channel:?}: {text}");
            assert!(text.contains("19. #101 [UX/工作区] 工单标题 101"), "{channel:?}: {text}");
            assert_eq!(text.matches("[UX/工作区] 工单标题 83").count(), 1, "{channel:?}: title duplicated: {text}");
            match channel {
                ConnectorID::Weixin | ConnectorID::Qq => {
                    assert!(text.contains("【待你验收 (19)】\n1. "), "{channel:?}: {text}");
                    assert!(!text.contains("**") && !text.contains("###"));
                }
                ConnectorID::Feishu => {
                    assert!(text.contains("**你不在的时候有 19 条消息**"), "{text}");
                    assert!(text.contains("### 【待你验收 (19)】\n1. "), "{text}");
                    assert!(text.contains("\n\n---\n完整的在默认频道里。"), "{text}");
                }
            }

            let _ = ctx.shutdown(Duration::from_secs(1)).await;
            ctx.service.close().await;
        }
    }
}
