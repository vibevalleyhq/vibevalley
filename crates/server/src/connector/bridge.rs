//! One chat app's account on the farm: its login, and while it is connected
//! a Tokio task that receives and a Tokio task that works through what came in
//! and what goes out, both cancelled and awaited before the account is replaced.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use vibevalley_core::SliceMask;
use vibevalley_core::channel::for_user;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, ChatMessage, ConnectorID, ConnectorLogin, ConnectorState, ConnectorStatus, Issue, IssueStageKind, SessionPermissionDecision,
    SessionRespondPermissionInput, StuckReason,
};

use super::adapter::{App, AppFailed, FailedKind, Inbound, LoginIo, Progress, Receiving};
use super::digest::{
    DIGEST_OVER, IssueReplyAction, PermissionReplyAction, PushTarget, ReplyParseError, digest, is_pairing, issue_target_label, parse_issue_reply,
    parse_permission_reply, parse_push_issue_message_id, parse_push_message_id, parse_push_perm_message_id, short_id, split_text, user_line,
};
use crate::channel::{Chat, Saying};
use crate::context::port::ConnectorIssuePort;
use crate::context::text::clip_plain;
use crate::context::{Context, now};
use crate::runtime::Runtime;
use crate::service::connector::{ConnectorAccountRow, ConnectorInboundRow};
use crate::service::{DbError, internal_db};
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
    pub chat: Arc<Chat>,
    pub issue: OnceLock<Arc<dyn ConnectorIssuePort>>,
    pub runtime: OnceLock<Arc<Runtime>>,
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

fn issue_matches_category(issue: &Issue, category: &str) -> bool {
    if issue.status.is_closed() {
        return false;
    }
    match category {
        "asking" => issue.stage.state == IssueStageKind::Asking,
        "reviewing" => issue.stage.state == IssueStageKind::Reviewing,
        "conflict" => issue.stage.state == IssueStageKind::Stuck && issue.stage.stuck == Some(StuckReason::Conflict),
        "interrupted" => issue.stage.state == IssueStageKind::Stuck && issue.stage.stuck == Some(StuckReason::Interrupted),
        "failed" => issue.stage.state == IssueStageKind::Stuck && issue.stage.stuck == Some(StuckReason::Failed),
        _ => true,
    }
}

async fn outgoing_handoff_async(ctx: &Context, chat: &Chat, runtime: Option<&Runtime>, message: &str) -> Result<Handoff, ApiError> {
    if message.starts_with("digest:") {
        return Ok(Handoff::Unseen);
    }
    if let Some((issue_id, category)) = parse_push_issue_message_id(message) {
        let Some(raw_issue) = ctx.service.issue.get(issue_id).await.map_err(internal_db)? else {
            return Ok(Handoff::Settled);
        };
        let sessions = ctx.service.session.all().await.map_err(internal_db)?;
        let derived = vibevalley_core::derive_issues(&[raw_issue], &sessions);
        let Some(issue) = derived.into_iter().next() else {
            return Ok(Handoff::Settled);
        };
        return Ok(if issue_matches_category(&issue, category) {
            Handoff::Unseen
        } else {
            Handoff::Settled
        });
    }
    if let Some((session_id, request_id)) = parse_push_perm_message_id(message) {
        let still_pending = runtime.is_some_and(|rt| rt.has_pending_permission(session_id, request_id));
        return Ok(if still_pending { Handoff::Unseen } else { Handoff::Settled });
    }
    if message.starts_with("push:") {
        return Ok(Handoff::Unseen);
    }
    handoff_async(chat, message).await
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
        match self.env.ctx.service.connector.add_outgoing(self.id(), &m.id, &pieces, now()).await {
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

    /// Withdraws any pending issue push rows when the issue has already been handled in the workbench.
    pub async fn withdraw_issue_pushes_async(self: &Arc<Self>, issue_id: &str) {
        let connectors = &self.env.ctx.service.connector;
        let Ok(listed) = connectors.pending_outgoing(self.id()).await else {
            return;
        };
        let mut withdrew = false;
        for row in listed {
            if parse_push_issue_message_id(&row.message).is_some_and(|(iid, _)| iid == issue_id) && connectors.withdraw(&row.message).await.is_ok() {
                withdrew = true;
            }
        }
        if withdrew {
            self.tell_async().await;
        }
    }

    /// Withdraws a pending permission push row when resolved in the workbench or mobile app.
    pub async fn withdraw_perm_push_async(self: &Arc<Self>, session_id: &str, request_id: &str) {
        let msg_id = format!("push:perm:{session_id}:{request_id}");
        if self.env.ctx.service.connector.withdraw(&msg_id).await.is_ok() {
            self.tell_async().await;
        }
    }

    /// Withdraws all pending permission push rows for `session_id` when its turn ends or closes.
    pub async fn withdraw_session_perm_pushes_async(self: &Arc<Self>, session_id: &str) {
        let connectors = &self.env.ctx.service.connector;
        let Ok(listed) = connectors.pending_outgoing(self.id()).await else {
            return;
        };
        let mut withdrew = false;
        for row in listed {
            if parse_push_perm_message_id(&row.message).is_some_and(|(sid, _)| sid == session_id) && connectors.withdraw(&row.message).await.is_ok() {
                withdrew = true;
            }
        }
        if withdrew {
            self.tell_async().await;
        }
    }

    /// Effective top-level channel id bound to this connector account.
    pub fn status_channel_id(&self, chat: &Chat) -> String {
        self.snapshot().and_then(|a| a.channel).unwrap_or_else(|| chat.default_channel())
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
            match outgoing_handoff_async(&self.env.ctx, &self.env.chat, self.env.runtime.get().map(Arc::as_ref), &row.message).await {
                Ok(Handoff::Unseen) => unseen.push(row.message.clone()),
                Ok(Handoff::Settled) => {
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
        let mut batches: Vec<(Vec<i64>, String)> = Vec::new();
        if late && regular.len() > DIGEST_OVER {
            let lines: Vec<String> = regular.iter().map(|r| r.body.clone()).collect();
            batches.push((regular.iter().map(|r| r.seq).collect(), digest(&lines)));
        } else {
            batches.extend(regular.into_iter().map(|r| (vec![r.seq], r.body.clone())));
        }
        batches.extend(digests.into_iter().map(|r| (vec![r.seq], r.body.clone())));
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
        for (rows, text) in batches {
            if cancel.is_cancelled() {
                return false;
            }
            let sent = self.app.send(&a.keys, &a.user, &text, &a.reply_context).await;
            let ok = match sent {
                Ok(ext) => match connectors.sent(&rows, now(), &ext).await {
                    Ok(()) => {
                        self.clear_transient_err_async().await;
                        self.tell_async().await;
                        true
                    }
                    Err(e) => {
                        self.set_err_async(e.to_string()).await;
                        false
                    }
                },
                Err(refused) => {
                    if let Err(e) = connectors.not_sent(&rows, &refused.message).await {
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
                    false
                }
            };
            if !ok {
                return false;
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

    fn issue_parse_error_receipt(err: ReplyParseError, target: &str) -> String {
        let key = match err {
            ReplyParseError::EmptyAnswer => "server.connector.reply.emptyAnswer",
            ReplyParseError::ReviewUnrecognized => "server.connector.reply.reviewHint",
            ReplyParseError::RejectNeedsReason => "server.connector.reply.rejectNeedsReason",
            ReplyParseError::StuckUnrecognized => "server.connector.reply.stuckHint",
            ReplyParseError::ConflictNeedsWorkbench => "server.connector.reply.conflictHint",
            ReplyParseError::PermissionUnrecognized | ReplyParseError::UnsupportedCategory => {
                return t("server.connector.reply.alreadyHandled", &[("target", target.into())]);
            }
        };
        t(key, &[("target", target.into())])
    }

    async fn handle_issue_quote_reply_async(
        self: &Arc<Self>,
        m: &Inbound,
        push_msg_id: &str,
        issue_id: &str,
        category: &str,
        cancel: &CancellationToken,
    ) -> Result<(), Held> {
        let connectors = &self.env.ctx.service.connector;
        let Some(issue_port) = self.env.issue.get() else {
            return self
                .send_reply_receipt_async(&m.id, &t("server.connector.reply.noActionPort", &[]), cancel)
                .await;
        };
        let issue = match issue_port.get_issue_async(issue_id).await {
            Ok(Some(issue)) => issue,
            Ok(None) => {
                let _ = connectors.withdraw(push_msg_id).await;
                self.withdraw_issue_pushes_async(issue_id).await;
                let target = short_id(issue_id);
                return self
                    .send_reply_receipt_async(&m.id, &t("server.connector.reply.alreadyHandled", &[("target", target.into())]), cancel)
                    .await;
            }
            Err(e) => {
                let target = short_id(issue_id);
                let msg = t("server.connector.reply.actionFailed", &[("target", target.into()), ("why", e.message.into())]);
                return self.send_reply_receipt_async(&m.id, &msg, cancel).await;
            }
        };
        let target = issue_target_label(Some(issue.number), Some(&issue.title));
        if !issue_matches_category(&issue, category) {
            let _ = connectors.withdraw(push_msg_id).await;
            self.withdraw_issue_pushes_async(&issue.id).await;
            return self
                .send_reply_receipt_async(&m.id, &t("server.connector.reply.alreadyHandled", &[("target", target.into())]), cancel)
                .await;
        }
        let action = match parse_issue_reply(category, &m.text) {
            Ok(action) => action,
            Err(err) => {
                let receipt = Self::issue_parse_error_receipt(err, &target);
                return self.send_reply_receipt_async(&m.id, &receipt, cancel).await;
            }
        };
        let outcome = match &action {
            IssueReplyAction::Answer { text } => issue_port
                .answer_asking_async(&issue.id, text)
                .await
                .map(|_| t("server.connector.reply.answered", &[("target", target.clone().into())])),
            IssueReplyAction::Accept => issue_port
                .accept_review_async(&issue.id)
                .await
                .map(|_| t("server.connector.reply.accepted", &[("target", target.clone().into())])),
            IssueReplyAction::Reject { reason } => issue_port.reject_review_async(&issue.id, reason).await.map(|_| {
                t(
                    "server.connector.reply.rejected",
                    &[("target", target.clone().into()), ("reason", clip_plain(reason, 120).into())],
                )
            }),
            IssueReplyAction::Retry { words } => issue_port
                .retry_issue_async(&issue.id, words.as_deref())
                .await
                .map(|_| t("server.connector.reply.retried", &[("target", target.clone().into())])),
        };
        let receipt = match outcome {
            Ok(ok_receipt) => {
                let _ = connectors.withdraw(push_msg_id).await;
                self.withdraw_issue_pushes_async(&issue.id).await;
                ok_receipt
            }
            Err(e) => t("server.connector.reply.actionFailed", &[("target", target.into()), ("why", e.message.into())]),
        };
        self.send_reply_receipt_async(&m.id, &receipt, cancel).await
    }

    async fn handle_perm_quote_reply_async(
        self: &Arc<Self>,
        m: &Inbound,
        push_msg_id: &str,
        session_id: &str,
        request_id: &str,
        cancel: &CancellationToken,
    ) -> Result<(), Held> {
        let connectors = &self.env.ctx.service.connector;
        let Some(runtime) = self.env.runtime.get() else {
            return self
                .send_reply_receipt_async(&m.id, &t("server.connector.reply.noActionPort", &[]), cancel)
                .await;
        };
        let session_label = runtime
            .session_async(session_id)
            .await
            .map(|s| clip_plain(&s.name, 40))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| short_id(session_id));
        if !runtime.has_pending_permission(session_id, request_id) {
            let _ = connectors.withdraw(push_msg_id).await;
            return self
                .send_reply_receipt_async(
                    &m.id,
                    &t("server.connector.reply.permAlreadyHandled", &[("session", session_label.into())]),
                    cancel,
                )
                .await;
        }
        let action = match parse_permission_reply(&m.text) {
            Ok(action) => action,
            Err(_) => {
                return self
                    .send_reply_receipt_async(&m.id, &t("server.connector.reply.permHint", &[("session", session_label.into())]), cancel)
                    .await;
            }
        };
        let (decision, message, receipt_key) = match action {
            PermissionReplyAction::AllowOnce => (SessionPermissionDecision::AllowOnce, None, "server.connector.reply.permAllowed"),
            PermissionReplyAction::AllowAlways => (SessionPermissionDecision::AllowAlways, None, "server.connector.reply.permAllowedAlways"),
            PermissionReplyAction::Deny { reason } => (SessionPermissionDecision::Deny, reason, "server.connector.reply.permDenied"),
        };
        let receipt = match runtime
            .respond_permission_endpoint_async(SessionRespondPermissionInput {
                id: session_id.to_owned(),
                request_id: request_id.to_owned(),
                decision,
                message,
            })
            .await
        {
            Ok(()) => {
                let _ = connectors.withdraw(push_msg_id).await;
                self.tell_async().await;
                t(receipt_key, &[("session", session_label.into())])
            }
            Err(e) => {
                if !runtime.has_pending_permission(session_id, request_id) {
                    let _ = connectors.withdraw(push_msg_id).await;
                    t("server.connector.reply.permAlreadyHandled", &[("session", session_label.into())])
                } else {
                    t(
                        "server.connector.reply.permFailed",
                        &[("session", session_label.into()), ("why", e.message.into())],
                    )
                }
            }
        };
        self.send_reply_receipt_async(&m.id, &receipt, cancel).await
    }

    /// One message of the app's: the pairing word, an actionable push quote-reply, or the user's words into the farm.
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
                if let Some(ref push_msg_id) = quoted_message_id
                    && let Some(target) = parse_push_message_id(push_msg_id)
                {
                    match target {
                        PushTarget::Issue { issue_id, category } => {
                            self.handle_issue_quote_reply_async(m, push_msg_id, issue_id, category, cancel).await?;
                        }
                        PushTarget::Permission { session_id, request_id } => {
                            self.handle_perm_quote_reply_async(m, push_msg_id, session_id, request_id, cancel).await?;
                        }
                    }
                    return Ok(None);
                }
                let said = if key.is_empty() {
                    None
                } else {
                    let channel = match quoted_message_id {
                        Some(msg) => self.env.chat.message_location_async(&msg).await?.map(|(place, _)| place.id),
                        None => None,
                    }
                    .or_else(|| self.snapshot().and_then(|a| a.channel));
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
            let (tell_tx, mut tell_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
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
                let _ = tell_tx.send(());
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
                            while tell_rx.try_recv().is_ok() {}
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
    use vibevalley_protocol::{ApiError, BizCode, ConnectorID, ConnectorLogin, Issue, IssueStage, IssueStageKind, IssueStatus, StuckReason};

    use super::*;
    use crate::channel::Chat;
    use crate::connector::adapter::{Adapter, AppFailed, Inbound, Linked, LoginIo, Receiving};
    use crate::context::port::ConnectorIssuePort;
    use crate::context::{BoxFuture, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::service::Service;
    use crate::setting::{Setting, SettingConfig};
    use crate::storage::Storage;

    struct FakeApp {
        sent: Mutex<Vec<(String, String, String)>>,
    }

    impl FakeApp {
        fn new() -> Arc<Self> {
            Arc::new(Self { sent: Mutex::new(Vec::new()) })
        }

        fn sent(&self) -> Vec<(String, String, String)> {
            self.sent.lock().clone()
        }
    }

    impl Adapter for FakeApp {
        type Keys = serde_json::Value;
        const ID: ConnectorID = ConnectorID::Weixin;
        const MAX_CHARS: usize = 4000;

        async fn login(&self, _: &ConnectorLogin, _: &LoginIo<'_>) -> Result<Linked<Self::Keys>, AppFailed> {
            unreachable!()
        }

        async fn receive(&self, _: &Self::Keys, _: &Receiving<'_>) -> AppFailed {
            unreachable!()
        }

        async fn send(&self, _: &Self::Keys, to: &str, text: &str, reply: &str) -> Result<String, AppFailed> {
            let mut sent = self.sent.lock();
            let id = format!("ext-out-{}", sent.len() + 1);
            sent.push((to.to_owned(), text.to_owned(), reply.to_owned()));
            Ok(id)
        }
    }

    #[derive(Default)]
    struct FakeIssuePort {
        issues: Mutex<std::collections::HashMap<String, Issue>>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeIssuePort {
        fn insert(&self, issue: Issue) {
            self.issues.lock().insert(issue.id.clone(), issue);
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().clone()
        }
    }

    impl ConnectorIssuePort for FakeIssuePort {
        fn get_issue_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Issue>, ApiError>> {
            Box::pin(async move { Ok(self.issues.lock().get(id).cloned()) })
        }

        fn answer_asking_async<'a>(&'a self, id: &'a str, text: &'a str) -> BoxFuture<'a, Result<Issue, ApiError>> {
            Box::pin(async move {
                self.calls.lock().push(format!("answer:{id}:{text}"));
                let mut map = self.issues.lock();
                let issue = map.get_mut(id).ok_or_else(|| ApiError::new(BizCode::IssueNotFound, "missing"))?;
                if issue.stage.state != IssueStageKind::Asking {
                    return Err(ApiError::new(BizCode::IssueRefused, "not asking"));
                }
                issue.stage.state = IssueStageKind::Working;
                issue.questions.clear();
                Ok(issue.clone())
            })
        }

        fn accept_review_async<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Issue, ApiError>> {
            Box::pin(async move {
                self.calls.lock().push(format!("accept:{id}"));
                let mut map = self.issues.lock();
                let issue = map.get_mut(id).ok_or_else(|| ApiError::new(BizCode::IssueNotFound, "missing"))?;
                if issue.stage.state != IssueStageKind::Reviewing {
                    return Err(ApiError::new(BizCode::IssueRefused, "not reviewing"));
                }
                issue.status = IssueStatus::Done;
                issue.stage.state = IssueStageKind::Done;
                Ok(issue.clone())
            })
        }

        fn reject_review_async<'a>(&'a self, id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<Issue, ApiError>> {
            Box::pin(async move {
                self.calls.lock().push(format!("reject:{id}:{reason}"));
                let mut map = self.issues.lock();
                let issue = map.get_mut(id).ok_or_else(|| ApiError::new(BizCode::IssueNotFound, "missing"))?;
                if issue.stage.state != IssueStageKind::Reviewing {
                    return Err(ApiError::new(BizCode::IssueRefused, "not reviewing"));
                }
                issue.stage.state = IssueStageKind::Working;
                Ok(issue.clone())
            })
        }

        fn retry_issue_async<'a>(&'a self, id: &'a str, words: Option<&'a str>) -> BoxFuture<'a, Result<Issue, ApiError>> {
            Box::pin(async move {
                self.calls.lock().push(format!("retry:{id}:{}", words.unwrap_or("")));
                let mut map = self.issues.lock();
                let issue = map.get_mut(id).ok_or_else(|| ApiError::new(BizCode::IssueNotFound, "missing"))?;
                let stuck_retryable =
                    issue.stage.state == IssueStageKind::Stuck && matches!(issue.stage.stuck, Some(StuckReason::Failed | StuckReason::Interrupted));
                if !stuck_retryable {
                    return Err(ApiError::new(BizCode::IssueRefused, "not stuck"));
                }
                issue.stage.state = IssueStageKind::Working;
                issue.stage.stuck = None;
                Ok(issue.clone())
            })
        }
    }

    async fn setup_bridge(locale: &str) -> (tempfile::TempDir, Arc<Context>, Arc<FakeApp>, Arc<FakeIssuePort>, Arc<Bridge>) {
        vibevalley_i18n::set_locale(locale);
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
            clock.clone(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let setting = Setting::open_async(SettingConfig {
            home: home.clone(),
            work_root: work,
            version: "0.1.0".into(),
            deepseek_api_key: String::new(),
            storage_backend: None,
        })
        .await;
        let storage = Storage::open_async(&home, ctx.clone()).await.unwrap();
        let chat = Chat::open_async(ctx.clone(), storage, false).await.unwrap();
        let issue_port = Arc::new(FakeIssuePort::default());
        let env = Arc::new(Env {
            ctx: ctx.clone(),
            setting,
            chat,
            issue: OnceLock::from(issue_port.clone() as Arc<dyn ConnectorIssuePort>),
            runtime: OnceLock::new(),
            retry_first: Duration::from_millis(50),
            retry_most: Duration::from_millis(200),
            reconnect: Duration::from_millis(50),
            moment: Duration::from_millis(50),
            closing: AtomicBool::new(false),
        });
        let app = FakeApp::new();
        let bridge = Bridge::new(app.clone(), env);

        service
            .connector
            .connect(ConnectorID::Weixin, "{}", "wx-user-1", None, 1_000, "retired")
            .await
            .unwrap();
        bridge.load_async().await;
        (dir, ctx, app, issue_port, bridge)
    }

    async fn seed_sent_push(ctx: &Context, bridge: &Arc<Bridge>, msg_id: &str, body: &str, ext_id: &str) {
        let conn = &ctx.service.connector;
        conn.add_outgoing_once(ConnectorID::Weixin, msg_id, &[body.to_owned()], 2_000).await.unwrap();
        let rows = conn.pending_outgoing(ConnectorID::Weixin).await.unwrap();
        let seqs: Vec<i64> = rows.into_iter().filter(|r| r.message == msg_id).map(|r| r.seq).collect();
        conn.sent(&seqs, 2_000, ext_id).await.unwrap();
        bridge.tell_async().await;
    }

    #[tokio::test]
    async fn quote_replies_execute_actions_enforce_idempotency_and_send_localized_receipts() {
        let (_dir, ctx, app, issue_port, bridge) = setup_bridge("zh").await;
        let cancel = CancellationToken::new();

        // 1. Asking -> answer directly -> confirmation receipt; second quote-reply is idempotent & refused.
        let mut ask_issue = Issue::new("iss-1", 10, "配置推送", 1_000);
        ask_issue.status = IssueStatus::InReview;
        ask_issue.stage = IssueStage {
            state: IssueStageKind::Asking,
            since: Some(2_000),
            stuck: None,
            lead: None,
            acts: vec![],
        };
        issue_port.insert(ask_issue);
        seed_sent_push(&ctx, &bridge, "push:issue:iss-1:asking:h1", "问题", "ext-ask-1").await;

        // Empty answer is refused without executing action.
        bridge
            .got(
                &Inbound {
                    id: "in-ask-empty".into(),
                    from: "wx-user-1".into(),
                    text: "   ".into(),
                    reply: "ctx-1".into(),
                    quoted: "ext-ask-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert!(issue_port.calls().is_empty());
        assert!(app.sent().last().unwrap().1.contains("【无法回复 · #10 配置推送】"));

        // Valid answer executes and confirms.
        bridge
            .got(
                &Inbound {
                    id: "in-ask-ok".into(),
                    from: "wx-user-1".into(),
                    text: "开启安静时段".into(),
                    reply: "ctx-2".into(),
                    quoted: "ext-ask-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(issue_port.calls(), vec!["answer:iss-1:开启安静时段".to_string()]);
        assert!(app.sent().last().unwrap().1.contains("【已回复 · #10 配置推送】"));

        // Re-quoting the same asking push after stage moved is idempotent (no second call + alreadyHandled receipt).
        bridge
            .got(
                &Inbound {
                    id: "in-ask-dup".into(),
                    from: "wx-user-1".into(),
                    text: "再答一次".into(),
                    reply: "ctx-3".into(),
                    quoted: "ext-ask-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(issue_port.calls().len(), 1);
        assert!(app.sent().last().unwrap().1.contains("【无需重复处理 · #10 配置推送】"));

        // 2. Reviewing -> invalid command & missing reject reason -> reject -> accept.
        let mut rev_issue = Issue::new("iss-2", 11, "验收测试", 1_000);
        rev_issue.status = IssueStatus::InReview;
        rev_issue.stage.state = IssueStageKind::Reviewing;
        issue_port.insert(rev_issue.clone());
        seed_sent_push(&ctx, &bridge, "push:issue:iss-2:reviewing:h2", "待验收", "ext-rev-1").await;

        bridge
            .got(
                &Inbound {
                    id: "in-rev-bad".into(),
                    from: "wx-user-1".into(),
                    text: "reject".into(),
                    reply: "ctx-4".into(),
                    quoted: "ext-rev-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert!(app.sent().last().unwrap().1.contains("【缺少打回原因 · #11 验收测试】"));

        bridge
            .got(
                &Inbound {
                    id: "in-rev-rej".into(),
                    from: "wx-user-1".into(),
                    text: "reject 补全边界用例".into(),
                    reply: "ctx-5".into(),
                    quoted: "ext-rev-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(issue_port.calls().last().unwrap(), "reject:iss-2:补全边界用例");
        assert!(app.sent().last().unwrap().1.contains("【已打回 · #11 验收测试】"));

        // Move issue back to Reviewing for another round and accept in English locale.
        vibevalley_i18n::set_locale("en");
        rev_issue.stage.state = IssueStageKind::Reviewing;
        issue_port.insert(rev_issue);
        seed_sent_push(&ctx, &bridge, "push:issue:iss-2:reviewing:h3", "review", "ext-rev-2").await;

        bridge
            .got(
                &Inbound {
                    id: "in-rev-acc".into(),
                    from: "wx-user-1".into(),
                    text: "ok".into(),
                    reply: "ctx-6".into(),
                    quoted: "ext-rev-2".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(issue_port.calls().last().unwrap(), "accept:iss-2");
        assert!(app.sent().last().unwrap().1.contains("[Completed · #11 验收测试]"));

        // 3. Interrupted / Failed -> retry/resume + pending outbox withdrawal when expired.
        let mut stuck_issue = Issue::new("iss-3", 12, "中断恢复", 1_000);
        stuck_issue.status = IssueStatus::InReview;
        stuck_issue.stage.state = IssueStageKind::Stuck;
        stuck_issue.stage.stuck = Some(StuckReason::Interrupted);
        issue_port.insert(stuck_issue);
        seed_sent_push(&ctx, &bridge, "push:issue:iss-3:interrupted:h4", "interrupted", "ext-int-1").await;

        bridge
            .got(
                &Inbound {
                    id: "in-int-bad".into(),
                    from: "wx-user-1".into(),
                    text: "accept".into(),
                    reply: "ctx-7".into(),
                    quoted: "ext-int-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert!(app.sent().last().unwrap().1.contains("[Invalid Command · #12 中断恢复]"));

        bridge
            .got(
                &Inbound {
                    id: "in-int-ok".into(),
                    from: "wx-user-1".into(),
                    text: "resume".into(),
                    reply: "ctx-8".into(),
                    quoted: "ext-int-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(issue_port.calls().last().unwrap(), "retry:iss-3:");
        assert!(app.sent().last().unwrap().1.contains("[Retried · #12 中断恢复]"));

        // Pending expired outbox row is withdrawn cleanly when a stale quote-reply arrives.
        ctx.service
            .connector
            .add_outgoing_once(ConnectorID::Weixin, "push:issue:iss-3:interrupted:h5", &["pending".into()], 3_000)
            .await
            .unwrap();
        assert_eq!(ctx.service.connector.count_pending(ConnectorID::Weixin).await.unwrap(), 1);
        bridge
            .got(
                &Inbound {
                    id: "in-int-stale".into(),
                    from: "wx-user-1".into(),
                    text: "retry".into(),
                    reply: "ctx-9".into(),
                    quoted: "ext-int-1".into(),
                },
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(ctx.service.connector.count_pending(ConnectorID::Weixin).await.unwrap(), 0);
        assert!(app.sent().last().unwrap().1.contains("[Already Handled · #12 中断恢复]"));

        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        ctx.service.close().await;
    }
}
