//! Shared refusals (`base/errors.ts`) and idempotent request keys.

use std::collections::HashMap;
use std::future::Future;

use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, Next};

/// `lookIn`: a hint listing the ones there are, and the code a miss gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookIn {
    Issue,
    Session,
    Repo,
    Runtime,
    Agent,
    Skill,
    Template,
    Cron,
    Channel,
    Artifact,
    Library,
}

impl LookIn {
    fn parts(self) -> (&'static str, BizCode, Option<[&'static str; 2]>) {
        match self {
            LookIn::Issue => ("issue", BizCode::IssueNotFound, Some(["issue", "list"])),
            LookIn::Session => ("session", BizCode::SessionNotFound, Some(["session", "list"])),
            LookIn::Repo => ("repo", BizCode::RepoNotFound, Some(["repo", "list"])),
            LookIn::Runtime => ("runtime", BizCode::RuntimeNotFound, Some(["runtime", "list"])),
            LookIn::Agent => ("agent", BizCode::AgentNotFound, Some(["agent", "list"])),
            LookIn::Skill => ("skill", BizCode::AgentNotFound, None),
            LookIn::Template => ("template", BizCode::AgentNotFound, None),
            LookIn::Cron => ("cron", BizCode::CronNotFound, Some(["cron", "list"])),
            LookIn::Channel => ("channel", BizCode::ChannelNotFound, Some(["channel", "list"])),
            LookIn::Artifact => ("artifact", BizCode::ArtifactNotFound, Some(["artifact", "list"])),
            LookIn::Library => ("library", BizCode::LibraryNotFound, None),
        }
    }

    pub fn next(self) -> Next {
        let (key, _, run) = self.parts();
        let run = match self {
            LookIn::Library => Some(vec!["library".into(), "item".into(), "list".into()]),
            _ => run.map(|r| r.iter().map(|s| s.to_string()).collect()),
        };
        Next {
            say: t(&format!("server.lookIn.{key}"), &[]),
            run,
        }
    }
}

/// `missing(what, [lookIn.x])`.
pub fn missing(what: impl Into<String>, look: LookIn) -> ApiError {
    ApiError::new(look.parts().1, what.into()).with_next(vec![look.next()])
}

pub fn refused(code: BizCode, text: impl Into<String>) -> ApiError {
    ApiError::new(code, text.into())
}

pub fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(BizCode::InternalError, e.to_string())
}

const REQUEST_KEY_MAX: usize = 64;
const REQUEST_KEYS_KEPT: usize = 500;
const REQUEST_KEY_TTL_MS: i64 = 5 * 60_000;

/// `requestKeys`: a retry with the same key gets the first answer for five
/// minutes; a failure is forgotten.
pub struct RequestKeys<T> {
    seen: Mutex<Answered<T>>,
}

/// Async idempotency gate matching [`RequestKeys`] without holding a sync mutex across `.await`.
pub struct AsyncRequestKeys<T> {
    seen: AsyncMutex<Answered<T>>,
}

/// The keys oldest first, and each key's expiry and answer.
type Answered<T> = (Vec<String>, HashMap<String, (i64, T)>);

impl<T> Default for RequestKeys<T> {
    fn default() -> Self {
        RequestKeys { seen: Mutex::default() }
    }
}

impl<T> Default for AsyncRequestKeys<T> {
    fn default() -> Self {
        AsyncRequestKeys { seen: AsyncMutex::default() }
    }
}

fn validate_key(key: &str) -> Result<(), ApiError> {
    if key.chars().count() > REQUEST_KEY_MAX {
        return Err(ApiError::new(
            BizCode::RequestKeyTooLong,
            t("server.base.requestKeyLong", &[("max", REQUEST_KEY_MAX.into())]),
        ));
    }
    Ok(())
}

fn cached_answer<T: Clone>(seen: &Answered<T>, key: &str) -> Option<T> {
    seen.1.get(key).filter(|(expires, _)| *expires > crate::now()).map(|(_, done)| done.clone())
}

fn record_answer<T: Clone>(seen: &mut Answered<T>, key: &str, done: &T) {
    seen.0.retain(|k| k != key);
    seen.0.push(key.to_string());
    seen.1.insert(key.to_string(), (crate::now() + REQUEST_KEY_TTL_MS, done.clone()));
    while seen.0.len() > REQUEST_KEYS_KEPT {
        let old = seen.0.remove(0);
        seen.1.remove(&old);
    }
}

impl<T: Clone> RequestKeys<T> {
    pub fn once(&self, key: Option<&str>, work: impl FnOnce() -> Result<T, ApiError>) -> Result<T, ApiError> {
        let Some(key) = key.filter(|k| !k.is_empty()) else { return work() };
        validate_key(key)?;
        // Held while working: a duplicate waits for the first answer.
        let mut seen = self.seen.lock();
        if let Some(done) = cached_answer(&seen, key) {
            return Ok(done);
        }
        let done = work()?;
        record_answer(&mut seen, key, &done);
        Ok(done)
    }
}

impl<T: Clone + Send> AsyncRequestKeys<T> {
    pub fn once<'a>(
        &'a self,
        key: Option<&str>,
        work: impl Future<Output = Result<T, ApiError>> + Send + 'a,
    ) -> impl Future<Output = Result<T, ApiError>> + Send + 'a {
        let key = key.filter(|k| !k.is_empty()).map(str::to_owned);
        async move {
            let Some(key) = key else { return work.await };
            validate_key(&key)?;
            // Held while working: a duplicate waits for the first answer.
            let mut seen = self.seen.lock().await;
            if let Some(done) = cached_answer(&seen, &key) {
                return Ok(done);
            }
            let done = work.await?;
            record_answer(&mut seen, &key, &done);
            Ok(done)
        }
    }
}
