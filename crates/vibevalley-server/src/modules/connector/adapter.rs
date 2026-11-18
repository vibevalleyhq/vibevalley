//! What a chat app is to the bridge: it signs an account in, hands over what
//! the user says there, and takes the farm's words out. Each app keeps its
//! own typed keys; the bridge holds them sealed, as one `Secret`.

use std::future::Future;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use vibevalley_i18n::t;
use vibevalley_protocol::{ConnectorID, ConnectorLogin, ConnectorState};

use crate::modules::setting::Secret;

/// One message of the outside chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inbound {
    /// Each is taken once; "" when the app names none.
    pub id: String,
    pub from: String,
    pub text: String,
    /// WeChat's context token, QQ's message id; "" for none.
    pub reply: String,
    /// The app's id of the message this one quotes; "" for none.
    pub quoted: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailedKind {
    /// The app would not take it now (a closed reply window): tried again later.
    Restricted,
    /// The login is no longer good: the account rests.
    Stale,
    Failed,
}

/// Why an app did not do what it was asked. The message is what the user sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppFailed {
    pub kind: FailedKind,
    pub message: String,
}

impl AppFailed {
    pub fn new(kind: FailedKind, message: impl Into<String>) -> AppFailed {
        AppFailed { kind, message: message.into() }
    }

    pub fn failed(message: impl Into<String>) -> AppFailed {
        AppFailed::new(FailedKind::Failed, message)
    }
}

pub struct Linked<K> {
    pub keys: K,
    /// The user's id in the app; "" until the user pairs by a message.
    pub user: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub state: ConnectorState,
    /// The code to scan; "" while there is none.
    pub qr: String,
}

pub struct LoginIo<'a> {
    pub progress: &'a (dyn Fn(Progress) + Sync),
    /// The verification code the user typed for this login; "" for none.
    pub code: &'a (dyn Fn() -> String + Sync),
}

/// Takes what the app hands over, and how far it read (a cursor; "" for none).
pub type Accept<'a> = dyn Fn(Vec<Inbound>, &str) -> Result<(), AppFailed> + Sync + 'a;

pub struct Receiving<'a> {
    pub cursor: String,
    /// Kept durably before it returns: only then may the app consider them taken.
    pub accept: &'a Accept<'a>,
}

/// Ends an account's work: waits wake at once, vendor calls are dropped.
#[derive(Default)]
pub struct Stop {
    set: Mutex<bool>,
    changed: Condvar,
}

impl Stop {
    pub fn set(&self) {
        *self.set.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.changed.notify_all();
    }

    pub fn is_set(&self) -> bool {
        *self.set.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether it was stopped before `d` went by.
    pub fn sleep(&self, d: Duration) -> bool {
        let set = self.set.lock().unwrap_or_else(|e| e.into_inner());
        *self.changed.wait_timeout_while(set, d, |s| !*s).unwrap_or_else(|e| e.into_inner()).0
    }

    async fn stopped(&self) {
        while !self.is_set() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// One chat app, with its own keys.
pub trait Adapter: Send + Sync + 'static {
    type Keys: Serialize + DeserializeOwned;
    const ID: ConnectorID;
    /// In UTF-16 units; longer messages are cut.
    const MAX_CHARS: usize;

    async fn login(&self, input: &ConnectorLogin, io: &LoginIo<'_>) -> Result<Linked<Self::Keys>, AppFailed>;
    /// Until the connection ends: why it did.
    async fn receive(&self, keys: &Self::Keys, io: &Receiving<'_>) -> AppFailed;
    /// The app's id of what was sent; "" when it names none.
    async fn send(&self, keys: &Self::Keys, to: &str, text: &str, reply: &str) -> Result<String, AppFailed>;
}

/// An adapter as the bridge holds it: blocking, its keys sealed. `None` is a
/// call given up because the account's work was stopped.
pub trait App: Send + Sync {
    fn id(&self) -> ConnectorID;
    fn max_chars(&self) -> usize;
    fn reads(&self, keys: &Secret) -> bool;
    fn login(&self, input: &ConnectorLogin, io: &LoginIo<'_>, stop: &Stop) -> Option<Result<Linked<Secret>, AppFailed>>;
    fn receive(&self, keys: &Secret, io: &Receiving<'_>, stop: &Stop) -> Option<AppFailed>;
    fn send(&self, keys: &Secret, to: &str, text: &str, reply: &str) -> Result<String, AppFailed>;
}

fn runtime() -> tokio::runtime::Runtime {
    crate::install_tls();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime for a chat app's call")
}

fn until_stopped<T>(stop: &Stop, work: impl Future<Output = T>) -> Option<T> {
    runtime().block_on(async {
        tokio::select! {
            done = work => Some(done),
            _ = stop.stopped() => None,
        }
    })
}

fn unsealed<K: DeserializeOwned>(keys: &Secret) -> Result<K, AppFailed> {
    serde_json::from_str(keys.expose()).map_err(|_| AppFailed::failed(t("server.connector.unreadSecrets", &[])))
}

impl<A: Adapter> App for A {
    fn id(&self) -> ConnectorID {
        A::ID
    }

    fn max_chars(&self) -> usize {
        A::MAX_CHARS
    }

    fn reads(&self, keys: &Secret) -> bool {
        unsealed::<A::Keys>(keys).is_ok()
    }

    fn login(&self, input: &ConnectorLogin, io: &LoginIo<'_>, stop: &Stop) -> Option<Result<Linked<Secret>, AppFailed>> {
        let linked = until_stopped(stop, Adapter::login(self, input, io))?;
        Some(linked.and_then(|l| {
            let sealed = serde_json::to_string(&l.keys).map_err(|e| AppFailed::failed(e.to_string()))?;
            Ok(Linked {
                keys: Secret::new(sealed),
                user: l.user,
            })
        }))
    }

    fn receive(&self, keys: &Secret, io: &Receiving<'_>, stop: &Stop) -> Option<AppFailed> {
        let keys = match unsealed::<A::Keys>(keys) {
            Ok(k) => k,
            Err(e) => return Some(e),
        };
        until_stopped(stop, Adapter::receive(self, &keys, io))
    }

    fn send(&self, keys: &Secret, to: &str, text: &str, reply: &str) -> Result<String, AppFailed> {
        let keys = unsealed::<A::Keys>(keys)?;
        runtime().block_on(Adapter::send(self, &keys, to, text, reply))
    }
}

/// A client for one call: each call runs on a runtime of its own, so no
/// connection is kept for the next.
pub fn client() -> Result<reqwest::Client, AppFailed> {
    reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| AppFailed::failed(e.to_string()))
}

/// `work` with a deadline; past it, what `late` says.
pub async fn timed<T>(within: Duration, late: impl FnOnce() -> AppFailed, work: impl Future<Output = Result<T, AppFailed>>) -> Result<T, AppFailed> {
    match tokio::time::timeout(within, work).await {
        Ok(done) => done,
        Err(_) => Err(late()),
    }
}

/// A vendor's id that may come as a 64-bit number or as text: kept as text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VendorId(pub String);

impl<'de> serde::Deserialize<'de> for VendorId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<VendorId, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Text(String),
            Unsigned(u64),
            Signed(i64),
        }
        Ok(VendorId(match Raw::deserialize(d)? {
            Raw::Text(s) => s,
            Raw::Unsigned(n) => n.to_string(),
            Raw::Signed(n) => n.to_string(),
        }))
    }
}
