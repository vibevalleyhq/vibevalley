//! One chat app's account on the farm: its login, and while it is connected
//! a thread that receives and a thread that works through what came in and
//! what goes out, both ended before the account is replaced.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use vibevalley_core::channel::for_user;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ChatMessage, ConnectorID, ConnectorLogin, ConnectorState, ConnectorStatus, Fact, FactConnectorChanged};

use super::adapter::{App, AppFailed, FailedKind, Inbound, LoginIo, Progress, Receiving, Stop};
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

pub fn handoff(chat: &Chat, message: &str) -> Result<Handoff, ApiError> {
    let Some((m, read_at, superseded)) = chat.user_receipt(message)? else {
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

/// The account's work now: a login, or receiving and the worker.
struct Generation {
    stop: Arc<Stop>,
    threads: Vec<JoinHandle<()>>,
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

fn spawn(name: String, work: impl FnOnce() + Send + 'static) -> JoinHandle<()> {
    std::thread::Builder::new().name(name).spawn(work).expect("a connector's thread")
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

    pub fn status(&self) -> ConnectorStatus {
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
            pending: self.env.store.count_pending(self.id()).unwrap_or(0),
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

    /// Says the status to the core when a part of it changed.
    fn tell(&self) {
        let Some(hub) = self.env.hub.upgrade() else { return };
        let mut told = self.told.lock();
        let status = self.status();
        if told.as_ref() == Some(&status) {
            return;
        }
        *told = Some(status.clone());
        hub.apply(vec![Fact::ConnectorChanged(FactConnectorChanged { at: now(), status })]);
    }

    fn set_err(&self, e: impl Into<String>) {
        let e = e.into();
        {
            let mut s = self.shown.lock();
            if s.error == e {
                return;
            }
            s.error = e;
        }
        self.tell();
    }

    fn reload(&self) -> Result<(), StoreFailed> {
        self.reload_with_err(None)
    }

    /// Updates account and error under one lock so observers never see a torn status (e.g. `paused` with empty `error`).
    fn reload_with_err(&self, err: Option<String>) -> Result<(), StoreFailed> {
        let account = self.env.store.account(self.id())?;
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
        self.tell();
        Ok(())
    }

    /// Whether the pause was kept.
    fn pause(&self) -> bool {
        match self
            .env
            .store
            .pause(self.id(), Some(now() + STALE_PAUSE_MS))
            .and_then(|()| self.reload_with_err(Some(t("server.connector.expired", &[]))))
        {
            Ok(()) => true,
            Err(e) => {
                self.set_err(e.0);
                false
            }
        }
    }

    fn wake(&self) {
        self.wake.notify_waiters();
    }

    /// Something that decides what still goes out changed (a read, newer words): the worker looks again.
    pub fn changed(&self) {
        self.wake();
        self.tell();
    }

    /// A farm message for the user: kept to go out when it was said in the account's channel.
    pub fn offer(&self, m: &ChatMessage) {
        let Some(a) = self.snapshot().filter(|a| !a.user.is_empty()) else { return };
        let kept = || -> Result<bool, Held> {
            let Some((place, top)) = self.env.chat.message_location(&m.id)? else {
                return Ok(false);
            };
            if top != a.channel.clone().unwrap_or_else(|| self.env.chat.default_channel()) {
                return Ok(false);
            }
            let pieces = split_text(&user_line(m, &place), self.app.max_chars());
            self.env.store.add_outgoing(self.id(), &m.id, &pieces, now())?;
            Ok(!pieces.is_empty())
        };
        match kept() {
            Ok(true) => self.changed(),
            Ok(false) => {}
            Err(e) => self.set_err(e.0),
        }
    }

    /// Sends what waits, in order; false when some of it is held. Only the worker calls it, so a message sent is
    /// marked before the next is looked at.
    fn drain(&self, late: bool) -> bool {
        let Some(a) = self.snapshot().filter(|a| !a.user.is_empty()) else {
            return true;
        };
        let id = self.id();
        let store = &self.env.store;
        let listed = match store.pending_outgoing(id) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("vibevalley-server: connector: {}: the outbox could not be read: {}", id.as_str(), e.0);
                return false;
            }
        };
        let mut settled: Vec<&str> = vec![];
        let mut unseen: Vec<&str> = vec![];
        for row in &listed {
            if settled.contains(&row.message.as_str()) || unseen.contains(&row.message.as_str()) {
                continue;
            }
            match handoff(&self.env.chat, &row.message) {
                Ok(Handoff::Unseen) => unseen.push(&row.message),
                Ok(Handoff::Settled) => {
                    if let Err(e) = store.withdraw(&row.message) {
                        self.set_err(e.0);
                        return false;
                    }
                    settled.push(&row.message);
                }
                Err(e) => {
                    self.set_err(e.message);
                    return false;
                }
            }
        }
        let pending: Vec<_> = listed.iter().filter(|r| unseen.contains(&r.message.as_str())).collect();
        if !settled.is_empty() {
            self.tell();
        }
        if paused(&a, now()) || pending.is_empty() {
            return true;
        }
        let batches: Vec<(Vec<i64>, String)> = if late && pending.len() > DIGEST_OVER {
            let lines: Vec<String> = pending.iter().map(|r| r.body.clone()).collect();
            vec![(pending.iter().map(|r| r.seq).collect(), digest(&lines))]
        } else {
            pending.iter().map(|r| (vec![r.seq], r.body.clone())).collect()
        };
        for (rows, text) in batches {
            let ext = match self.app.send(&a.keys, &a.user, &text, &a.reply_context) {
                Ok(ext) => ext,
                Err(refused) => {
                    if let Err(e) = store.not_sent(&rows, &refused.message) {
                        eprintln!("vibevalley-server: connector: {}: {}", id.as_str(), e.0);
                    }
                    match refused.kind {
                        FailedKind::Stale => {
                            self.pause();
                        }
                        // Tried again later, and with the user's next message.
                        FailedKind::Restricted => self.set_err(""),
                        FailedKind::Failed => self.set_err(refused.message),
                    }
                    return false;
                }
            };
            if let Err(e) = store.sent(&rows, now(), &ext) {
                self.set_err(e.0);
                return false;
            }
            self.set_err("");
            self.tell();
        }
        true
    }

    fn quoted_channel(&self, ext: &str) -> Result<Option<String>, Held> {
        if ext.is_empty() {
            return Ok(None);
        }
        let Some(message) = self.env.store.message_of_ext(self.id(), ext)? else {
            return Ok(None);
        };
        Ok(self.env.chat.message_location(&message)?.map(|(place, _)| place.id))
    }

    /// One message of the app's: the pairing word, or the user's words into the farm. The farm's id of what was said.
    fn got(&self, m: &Inbound) -> Result<Option<String>, Held> {
        let Some(a) = self.snapshot() else { return Ok(None) };
        let id = self.id();
        if a.user.is_empty() {
            if a.pair_code.is_empty() || !is_pairing(&m.text, &a.pair_code) {
                return Ok(None);
            }
            self.env.store.paired(id, m, now())?;
            self.shown.lock().account = self.env.store.account(id)?;
            // Told once the user has the word: the status is not paired before the app's confirmation went out.
            if let Err(e) = self.app.send(&a.keys, &m.from, &t("server.connector.paired", &[]), &m.reply) {
                eprintln!(
                    "vibevalley-server: connector: {}: the pairing confirmation was not sent: {}",
                    id.as_str(),
                    e.message
                );
            }
            self.tell();
            return Ok(None);
        }
        if m.from != a.user {
            return Ok(None);
        }
        self.env.store.replied(id, &m.reply, now())?;
        self.reload()?;
        let channel = match self.quoted_channel(&m.quoted)? {
            Some(c) => Some(c),
            None => self.snapshot().and_then(|a| a.channel),
        };
        let mut said = None;
        if !m.text.is_empty() {
            // Keyed by the app's message: one said but not yet settled when the farm stopped is said once, not twice.
            let key = Sha256::digest(format!("{}:{}", id.as_str(), m.id))
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let (message, _) = self.env.chat.say(Saying {
                text: m.text.clone(),
                channel,
                send_key: key,
                source: Some("connector".into()),
                ..Saying::default()
            })?;
            said = Some(message.id);
        }
        // The user's words withdraw what they answer, before the fresh reply opens the app's delivery window.
        self.drain(true);
        Ok(said)
    }

    fn drain_inbox(&self, stop: &Stop) -> Result<(), Held> {
        let id = self.id();
        for m in self.env.store.pending_inbound(id)? {
            if stop.is_set() {
                break;
            }
            let said = self.got(&m)?;
            self.env.store.delivered(id, &m.id, said.as_deref())?;
        }
        Ok(())
    }

    /// The worker: what came in goes to the farm in order, then what waits goes out; what is held is tried again.
    fn work(&self, stop: &Stop) {
        let mut backoff = self.env.retry_backoff();
        let mut current_delay: Option<Duration> = None;
        while !stop.is_set() {
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let taken = match self.drain_inbox(stop) {
                Ok(()) => true,
                Err(e) => {
                    self.set_err(e.0);
                    false
                }
            };
            let held = !self.drain(false) || !taken;
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
            let step = vibevalley_runtime::rt::block_on(async {
                tokio::select! {
                    biased;
                    _ = stop.stopped() => Step::Stopped,
                    _ = notified => Step::Woke,
                    _ = tokio::time::sleep(wait_for) => Step::TimedOut,
                }
            });
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
    fn receiving(&self, stop: &Stop) {
        let id = self.id();
        let mut failures = 0;
        loop {
            let Some(a) = self.snapshot() else { return };
            if paused(&a, now()) {
                if stop.sleep(Duration::from_millis((a.paused_until - now()).max(0) as u64)) {
                    return;
                }
                if let Err(e) = self.env.store.pause(id, None).and_then(|()| self.reload()) {
                    self.set_err(e.0);
                    if stop.sleep(self.env.reconnect) {
                        return;
                    }
                }
                continue;
            }
            let cursor = match self.env.store.account(id) {
                Ok(row) => row.map(|r| r.cursor).unwrap_or_default(),
                Err(e) => {
                    self.set_err(e.0);
                    if stop.sleep(self.env.reconnect) {
                        return;
                    }
                    continue;
                }
            };
            let io = Receiving {
                cursor,
                accept: &|messages, cursor| self.accept(messages, cursor),
            };
            let Some(ended) = self.app.receive(&a.keys, &io, stop) else { return };
            if ended.kind == FailedKind::Stale {
                if !self.pause() && stop.sleep(self.env.reconnect) {
                    return;
                }
                continue;
            }
            self.set_err(ended.message);
            failures += 1;
            let mut wait = self.env.reconnect;
            if failures >= 3 {
                wait *= 15;
                failures = 0;
            }
            if stop.sleep(wait) {
                return;
            }
        }
    }

    fn stop_generation(&self, current: &mut Option<Generation>) {
        let Some(g) = current.take() else { return };
        g.stop.set();
        for thread in g.threads {
            let _ = thread.join();
        }
    }

    fn connected(self: &Arc<Self>) -> Option<Generation> {
        if self.closing() || self.snapshot().is_none() {
            return None;
        }
        let stop = Arc::new(Stop::default());
        let name = self.id().as_str();
        let (b, s) = (self.clone(), stop.clone());
        let receiving = spawn(format!("vibevalley-connector-{name}-in"), move || b.receiving(&s));
        let (b, s) = (self.clone(), stop.clone());
        let worker = spawn(format!("vibevalley-connector-{name}"), move || b.work(&s));
        Some(Generation {
            stop,
            threads: vec![receiving, worker],
        })
    }

    fn logging_in(self: &Arc<Self>, input: ConnectorLogin, attempt: u64) -> Generation {
        let stop = Arc::new(Stop::default());
        let (b, s) = (self.clone(), stop.clone());
        let login = spawn(format!("vibevalley-connector-{}-login", self.id().as_str()), move || {
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
            if let Some(result) = b.app.login(&input, &io, &s) {
                b.logged_in(&s, result);
            }
        });
        Generation { stop, threads: vec![login] }
    }

    /// The login's answer, taken as a command by the login's own thread: a newer command that stops it first wins.
    fn logged_in(self: &Arc<Self>, stop: &Stop, result: Result<super::adapter::Linked<crate::modules::infra::setting::Secret>, AppFailed>) {
        let Some(mut current) = vibevalley_runtime::rt::block_on(async {
            tokio::select! {
                biased;
                _ = stop.stopped() => None,
                guard = self.commands.lock() => Some(guard),
            }
        }) else {
            return;
        };
        if stop.is_set() {
            return;
        }
        // This thread is the generation: it ends by returning.
        *current = None;
        let failure = match result {
            Err(e) => Some(e.message),
            Ok(_) if self.closing() => None,
            Ok(linked) => {
                let pair = linked.user.is_empty().then(pair_code);
                let kept = self
                    .env
                    .store
                    .connect(
                        self.id(),
                        &linked.keys,
                        &linked.user,
                        pair.as_deref(),
                        now(),
                        &t("server.connector.switched", &[]),
                    )
                    .and_then(|()| self.reload());
                kept.err().map(|e| e.0)
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
        self.tell();
    }

    pub fn load(&self) {
        if let Err(e) = self.reload() {
            eprintln!("vibevalley-server: connector: {}: {}", self.id().as_str(), e.0);
        }
    }

    /// Goes on with the account there is.
    pub fn resume(self: &Arc<Self>) {
        let mut current = vibevalley_runtime::rt::block_on(self.commands.lock());
        if current.is_none() {
            *current = self.connected();
        }
    }

    pub fn login(self: &Arc<Self>, input: ConnectorLogin) -> ConnectorStatus {
        let started = {
            let mut current = vibevalley_runtime::rt::block_on(self.commands.lock());
            let going = self.shown.lock().signing_in.is_some();
            if going && input.force != Some(true) {
                self.shown.lock().login_try
            } else {
                self.stop_generation(&mut current);
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
        self.tell();
        // The answer carries the code when it shows within a moment.
        let deadline = Instant::now() + self.env.moment;
        loop {
            let notified = self.progressed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let there = {
                let shown = self.shown.lock();
                shown.login_try != started || shown.signing_in.as_ref().is_none_or(|x| !x.progress.qr.is_empty())
            };
            let Some(left) = deadline.checked_duration_since(Instant::now()).filter(|_| !there) else {
                break;
            };
            vibevalley_runtime::rt::block_on(async {
                let _ = tokio::time::timeout(left, notified).await;
            });
        }
        self.status()
    }

    /// The code the user typed for the login going on; with none going on it is for none.
    pub fn verify(&self, code: &str) -> ConnectorStatus {
        if let Some(signing) = self.shown.lock().signing_in.as_mut() {
            if signing.progress.state == ConnectorState::Verify {
                signing.progress.state = ConnectorState::Scanned;
            }
            signing.code = code.trim().to_string();
        }
        self.tell();
        self.status()
    }

    pub fn logout(self: &Arc<Self>) -> ConnectorStatus {
        {
            let mut current = vibevalley_runtime::rt::block_on(self.commands.lock());
            self.stop_generation(&mut current);
            let gone = self.env.store.disconnect(self.id(), &t("server.connector.disconnected", &[]));
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
        self.tell();
        self.status()
    }

    pub fn set_channel(&self, channel: Option<&str>) -> Result<ConnectorStatus, StoreFailed> {
        self.env.store.set_channel(self.id(), channel)?;
        self.reload()?;
        Ok(self.status())
    }

    pub fn has_account(&self) -> bool {
        self.snapshot().is_some()
    }

    pub fn stop(&self) {
        let mut current = vibevalley_runtime::rt::block_on(self.commands.lock());
        self.stop_generation(&mut current);
    }
}
