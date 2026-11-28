//! Transactional outbox dispatcher: atomic enqueue inside [`crate::service::Tx`]
//! transactions via [`crate::service::Service`], typed [`OutboxEvent`] payloads,
//! exponential-backoff retries, and [`TaskGroup`]-bound dispatch.

use std::collections::HashMap;
use std::fmt::Display;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::RwLock;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use vibevalley_core::{SharedClock, system_clock};
use vibevalley_protocol::{ApiError, BizCode, ConnectorID, Millis, Outcome, Spent};

use super::api::BoxFuture;
use super::task::TaskGroup;
use crate::service::outbox::OutboxItem;
use crate::service::{PostCommitHooks, Service, Tx};
pub use vibevalley_kit::queue::outbox::OutboxDeadLetter;
use vibevalley_kit::queue::outbox::OutboxRetryPolicy;

const DEFAULT_BATCH_SIZE: u64 = 32;
const DEFAULT_MAX_ATTEMPTS: i64 = 8;
const DEFAULT_BASE_BACKOFF: Duration = Duration::from_millis(500);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(60);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);

pub const OUTBOX_SESSION_REPORTED: &str = "work.session.reported";
pub const OUTBOX_SESSION_REMEMBER: &str = "memory.session_remember";
pub const OUTBOX_ISSUE_EPISODE: &str = "memory.issue_episode";
pub const OUTBOX_CONNECTOR_NOTIFY: &str = "connector.notify";

/// Durable report payload persisted via `Outbox` when a session round finishes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutboxSessionReported {
    pub id: String,
    pub at: Millis,
    pub outcome: Outcome,
    pub summary: String,
    pub spent: Option<Spent>,
    pub run: Option<String>,
}

/// Durable connector push/digest notification persisted via `Outbox`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxConnectorNotify {
    pub connector: Option<ConnectorID>,
    pub dedupe_key: String,
    pub message_id: String,
    pub issue_id: Option<String>,
    pub channel_id: Option<String>,
    pub body: String,
    pub created_at: Millis,
    pub urgent: bool,
}

/// Closed typed event catalog carried by the durable [`Outbox`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "topic", content = "payload")]
pub enum OutboxEvent {
    #[serde(rename = "work.session.reported")]
    SessionReported(OutboxSessionReported),
    #[serde(rename = "memory.session_remember")]
    SessionRemember { agent: String, text: String, repo: Option<String> },
    #[serde(rename = "memory.issue_episode")]
    IssueEpisode {
        agent: String,
        title: Option<String>,
        text: String,
        repo: Option<String>,
        session: Option<String>,
    },
    #[serde(rename = "connector.notify")]
    ConnectorNotify(OutboxConnectorNotify),
}

impl OutboxEvent {
    const fn topic(&self) -> &'static str {
        match self {
            Self::SessionReported(_) => OUTBOX_SESSION_REPORTED,
            Self::SessionRemember { .. } => OUTBOX_SESSION_REMEMBER,
            Self::IssueEpisode { .. } => OUTBOX_ISSUE_EPISODE,
            Self::ConnectorNotify(_) => OUTBOX_CONNECTOR_NOTIFY,
        }
    }

    fn serialize_payload_json(&self) -> Result<String, ApiError> {
        let res = match self {
            Self::SessionReported(report) => serde_json::to_string(report),
            Self::SessionRemember { agent, text, repo } => serde_json::to_string(&RememberPayload { agent, text, repo }),
            Self::IssueEpisode {
                agent,
                title,
                text,
                repo,
                session,
            } => serde_json::to_string(&IssueEpisodePayload {
                agent,
                title,
                text,
                repo,
                session,
            }),
            Self::ConnectorNotify(notify) => serde_json::to_string(notify),
        };
        res.map_err(|e| ApiError::new(BizCode::InternalError, format!("outbox payload serialize failed: {e}")))
    }
}

#[derive(Serialize)]
struct RememberPayload<'a> {
    agent: &'a str,
    text: &'a str,
    repo: &'a Option<String>,
}

#[derive(Serialize)]
struct IssueEpisodePayload<'a> {
    agent: &'a str,
    title: &'a Option<String>,
    text: &'a str,
    repo: &'a Option<String>,
    session: &'a Option<String>,
}

/// Configuration governing outbox batch size, retry budget, and backoff timings.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OutboxConfig {
    batch_size: u64,
    max_attempts: i64,
    base_backoff: Duration,
    max_backoff: Duration,
    poll_interval: Duration,
}

impl Default for OutboxConfig {
    fn default() -> Self {
        Self {
            batch_size: DEFAULT_BATCH_SIZE,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            base_backoff: DEFAULT_BASE_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
            poll_interval: DEFAULT_POLL_INTERVAL,
        }
    }
}

/// Claimed outbox item handed to a registered topic handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxDelivery {
    pub id: i64,
    pub topic: String,
    pub payload_json: String,
    pub attempts: i64,
    pub created_at: i64,
}

impl OutboxDelivery {
    /// Decodes the delivery payload JSON into `T`.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_str(&self.payload_json)
    }

    /// Decodes the delivery envelope as a typed [`OutboxEvent`].
    pub fn decode_event(&self) -> Result<OutboxEvent, serde_json::Error> {
        match self.topic.as_str() {
            OUTBOX_SESSION_REPORTED => Ok(OutboxEvent::SessionReported(serde_json::from_str(&self.payload_json)?)),
            OUTBOX_SESSION_REMEMBER => {
                #[derive(Deserialize)]
                struct OwnedRemember {
                    agent: String,
                    text: String,
                    repo: Option<String>,
                }
                let p: OwnedRemember = serde_json::from_str(&self.payload_json)?;
                Ok(OutboxEvent::SessionRemember {
                    agent: p.agent,
                    text: p.text,
                    repo: p.repo,
                })
            }
            OUTBOX_ISSUE_EPISODE => {
                #[derive(Deserialize)]
                struct OwnedEpisode {
                    agent: String,
                    title: Option<String>,
                    text: String,
                    repo: Option<String>,
                    session: Option<String>,
                }
                let p: OwnedEpisode = serde_json::from_str(&self.payload_json)?;
                Ok(OutboxEvent::IssueEpisode {
                    agent: p.agent,
                    title: p.title,
                    text: p.text,
                    repo: p.repo,
                    session: p.session,
                })
            }
            OUTBOX_CONNECTOR_NOTIFY => Ok(OutboxEvent::ConnectorNotify(serde_json::from_str(&self.payload_json)?)),
            _ => Err(serde::de::Error::custom(format!("unknown outbox topic `{}`", self.topic))),
        }
    }
}

type OutboxHandler = Arc<dyn Fn(OutboxDelivery) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// Transactional outbox dispatcher backed by [`Service::outbox`] and driven by [`TaskGroup`].
pub struct Outbox {
    service: Arc<Service>,
    config: OutboxConfig,
    clock: SharedClock,
    handlers: RwLock<HashMap<String, OutboxHandler>>,
    notify: Notify,
    failed_count: AtomicU64,
}

impl Outbox {
    /// Creates an [`Outbox`] dispatcher with default retry and poll configuration.
    pub fn new(service: Arc<Service>) -> Self {
        Self::with_config(service, OutboxConfig::default())
    }

    /// Creates an [`Outbox`] dispatcher with explicit retry and poll configuration.
    fn with_config(service: Arc<Service>, config: OutboxConfig) -> Self {
        Self {
            service,
            config,
            clock: system_clock(),
            handlers: RwLock::new(HashMap::new()),
            notify: Notify::new(),
            failed_count: AtomicU64::new(0),
        }
    }

    /// Returns the last observed dead-letter (`failed`) count without blocking on I/O.
    pub fn cached_failed_count(&self) -> u64 {
        self.failed_count.load(Ordering::Relaxed)
    }

    /// Queries the authoritative dead-letter (`failed`) count and refreshes the cached counter.
    pub async fn failed_count_async(&self) -> Result<u64, ApiError> {
        let count = self.service.outbox.count_failed().await?;
        self.failed_count.store(count, Ordering::Relaxed);
        Ok(count)
    }

    /// Lists up to `limit` dead-lettered (`failed`) outbox items newest-first.
    pub async fn list_failed_async(&self, limit: u64) -> Result<Vec<OutboxDeadLetter>, ApiError> {
        let rows = self.service.outbox.list_failed(limit).await?;
        Ok(rows.into_iter().map(OutboxDeadLetter::from).collect())
    }

    /// Replays a single dead-lettered (`failed`) item by ID, resetting its attempts and waking the dispatcher.
    pub async fn replay_failed_async(&self, id: i64) -> Result<bool, ApiError> {
        let replayed = self.service.outbox.replay_failed(id, self.clock.now_ms()).await?;
        if replayed {
            let _ = self.failed_count_async().await;
            tracing::info!(outbox_id = id, "outbox dead-letter item replayed");
            self.wake();
        }
        Ok(replayed)
    }

    /// Replays all dead-lettered (`failed`) items, resetting their attempts and waking the dispatcher.
    pub async fn replay_all_failed_async(&self) -> Result<u64, ApiError> {
        let replayed = self.service.outbox.replay_all_failed(self.clock.now_ms()).await?;
        if replayed > 0 {
            let _ = self.failed_count_async().await;
            tracing::info!(replayed, "outbox dead-letter items replayed");
            self.wake();
        }
        Ok(replayed)
    }

    /// Overrides the clock used for enqueue timestamps, recovery, and retry scheduling.
    pub fn with_clock(mut self, clock: SharedClock) -> Self {
        self.clock = clock;
        self
    }

    /// Enqueues a typed [`OutboxEvent`] standalone on the write pool using the configured clock.
    pub async fn enqueue_event(&self, event: &OutboxEvent) -> Result<i64, ApiError> {
        let payload_json = event.serialize_payload_json()?;
        self.service.outbox.enqueue(event.topic(), &payload_json, self.clock.now_ms()).await
    }

    /// Enqueues a typed [`OutboxEvent`] standalone scheduled for `available_at` (ms).
    pub async fn enqueue_event_at(&self, event: &OutboxEvent, available_at: i64) -> Result<i64, ApiError> {
        let payload_json = event.serialize_payload_json()?;
        self.service
            .outbox
            .enqueue_at(event.topic(), &payload_json, self.clock.now_ms(), available_at)
            .await
    }

    /// Enqueues a typed [`OutboxEvent`] inside an open write transaction using the configured clock.
    pub async fn enqueue_event_in_tx(&self, tx: &Tx, event: &OutboxEvent) -> Result<i64, ApiError> {
        self.enqueue_event_in_tx_at(tx, event, self.clock.now_ms()).await
    }

    /// Enqueues a typed [`OutboxEvent`] inside `tx` and registers a post-commit hook on `hooks`
    /// so [`Self::wake`] fires automatically ONLY after the transaction commits.
    pub async fn enqueue_event_in_tx_with_hooks(self: &Arc<Self>, tx: &Tx, hooks: &mut PostCommitHooks, event: &OutboxEvent) -> Result<i64, ApiError> {
        let id = self.enqueue_event_in_tx(tx, event).await?;
        let outbox = self.clone();
        hooks.on_commit(move || outbox.wake());
        Ok(id)
    }

    /// Enqueues a typed [`OutboxEvent`] inside an open write transaction with an explicit timestamp (ms).
    async fn enqueue_event_in_tx_at(&self, tx: &Tx, event: &OutboxEvent, now_ms: i64) -> Result<i64, ApiError> {
        let payload_json = event.serialize_payload_json()?;
        self.service.outbox.enqueue_in_tx(tx, event.topic(), &payload_json, now_ms).await
    }

    /// Enqueues a raw JSON payload inside an open write transaction using the configured clock.
    #[cfg(test)]
    async fn enqueue_in_tx(&self, tx: &Tx, topic: &str, payload_json: &str) -> Result<i64, ApiError> {
        self.enqueue_in_tx_at(tx, topic, payload_json, self.clock.now_ms()).await
    }

    /// Enqueues a raw JSON payload inside an open write transaction with an explicit timestamp (ms).
    #[cfg(test)]
    async fn enqueue_in_tx_at(&self, tx: &Tx, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        self.service.outbox.enqueue_in_tx(tx, topic, payload_json, now_ms).await
    }

    /// Registers the sole async handler for `topic`.
    ///
    /// Outbox topics are single-handler by design: calling `register` again for an
    /// already-registered topic replaces the previous handler rather than fanning
    /// out, so boot-level multiplexers (e.g. `OUTBOX_SESSION_REPORTED`) supersede
    /// standalone component handlers without double-delivery.
    pub fn register<F, Fut, E>(&self, topic: impl Into<String>, handler: F)
    where
        F: Fn(OutboxDelivery) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), E>> + Send + 'static,
        E: Display + 'static,
    {
        let topic = topic.into();
        let wrapped: OutboxHandler = Arc::new(move |delivery| {
            let fut = handler(delivery);
            Box::pin(async move { fut.await.map_err(|err| err.to_string()) })
        });
        if self.handlers.write().insert(topic.clone(), wrapped).is_some() {
            tracing::debug!(topic = %topic, "outbox.register replacing existing topic handler");
        }
    }

    /// Wakes the background outbox dispatcher (call after committing a transaction that enqueued items).
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// Starts the background outbox dispatcher bound to `task`'s lifecycle.
    pub fn start(self: &Arc<Self>, task: &TaskGroup) {
        let outbox = self.clone();
        let cancel = task.token();
        task.spawn_named("outbox.dispatch", async move {
            if let Err(err) = outbox.service.outbox.recover_processing(outbox.clock.now_ms()).await {
                tracing::warn!(error = %err.message, "outbox.recover_processing failed");
            }
            if let Ok(failed) = outbox.failed_count_async().await
                && failed > 0
            {
                tracing::warn!(failed_count = failed, "outbox started with existing dead-letter items");
            }

            loop {
                if cancel.is_cancelled() {
                    return;
                }

                let drained = match outbox.drain_once_inner(outbox.clock.now_ms()).await {
                    Ok(count) => count,
                    Err(err) => {
                        tracing::warn!(error = %err.message, "outbox.drain_once failed");
                        0
                    }
                };

                if cancel.is_cancelled() {
                    return;
                }

                if drained as u64 >= outbox.config.batch_size {
                    tokio::task::yield_now().await;
                    continue;
                }

                let wait = match outbox.next_wait_duration(outbox.clock.now_ms()).await {
                    Ok(d) => d,
                    Err(err) => {
                        tracing::warn!(error = %err.message, "outbox.next_pending_at failed");
                        outbox.config.poll_interval
                    }
                };

                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    _ = outbox.notify.notified() => {}
                    _ = tokio::time::sleep(wait) => {}
                }
            }
        });
    }

    async fn next_wait_duration(&self, current_ms: i64) -> Result<Duration, ApiError> {
        let next = self.service.outbox.next_pending_at().await?;
        let wait = match next {
            Some(available_at) if available_at <= current_ms => Duration::ZERO,
            Some(available_at) => Duration::from_millis((available_at - current_ms) as u64).min(self.config.poll_interval),
            None => self.config.poll_interval,
        };
        Ok(wait)
    }

    /// Claims and dispatches up to `config.batch_size` due rows at `current_ms`.
    async fn drain_once_inner(&self, current_ms: i64) -> Result<usize, ApiError> {
        let rows = self.service.outbox.claim_pending(current_ms, self.config.batch_size).await?;
        let count = rows.len();
        for row in rows {
            self.dispatch_row(row, current_ms).await?;
        }
        Ok(count)
    }

    #[cfg(test)]
    pub(crate) async fn drain_once(&self, current_ms: i64) -> Result<usize, ApiError> {
        self.drain_once_inner(current_ms).await
    }

    async fn dispatch_row(&self, row: OutboxItem, current_ms: i64) -> Result<(), ApiError> {
        if let Err(err) = serde_json::from_str::<serde_json::Value>(&row.payload_json) {
            let msg = format!("invalid outbox payload json: {err}");
            tracing::error!(
                outbox_id = row.id,
                topic = %row.topic,
                attempts = row.attempts,
                error = %msg,
                "outbox item dead-lettered due to invalid payload json"
            );
            self.service.outbox.fail(row.id, &msg).await?;
            self.failed_count.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }

        let handler = self.handlers.read().get(&row.topic).cloned();
        let Some(handler) = handler else {
            let msg = format!("no outbox handler registered for topic `{}`", row.topic);
            self.handle_failure(row.id, &row.topic, row.attempts, current_ms, &msg).await?;
            return Ok(());
        };

        let topic = row.topic.clone();
        let delivery = OutboxDelivery {
            id: row.id,
            topic: row.topic,
            payload_json: row.payload_json,
            attempts: row.attempts,
            created_at: row.created_at,
        };
        match handler(delivery).await {
            Ok(()) => self.service.outbox.complete(row.id).await,
            Err(err) => self.handle_failure(row.id, &topic, row.attempts, current_ms, &err).await,
        }
    }

    fn retry_policy(&self) -> OutboxRetryPolicy {
        OutboxRetryPolicy::new(self.config.max_attempts, self.config.base_backoff, self.config.max_backoff)
    }

    async fn handle_failure(&self, id: i64, topic: &str, attempts: i64, current_ms: i64, err: &str) -> Result<(), ApiError> {
        let policy = self.retry_policy();
        if policy.is_exhausted(attempts) {
            tracing::error!(
                outbox_id = id,
                topic = %topic,
                attempts,
                max_attempts = self.config.max_attempts,
                error = %err,
                "outbox item exhausted retries and entered dead-letter (failed) state"
            );
            self.service.outbox.fail(id, err).await?;
            self.failed_count.fetch_add(1, Ordering::Relaxed);
            Ok(())
        } else {
            let next_at = policy.next_available_at(current_ms, attempts);
            self.service.outbox.reschedule(id, next_at, err).await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::Notify;
    use vibevalley_core::SliceMask;

    use super::*;
    use crate::service::outbox::{OUTBOX_STATUS_DONE, OUTBOX_STATUS_FAILED, OUTBOX_STATUS_PENDING};

    async fn test_service() -> (tempfile::TempDir, Arc<Service>) {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        (dir, service)
    }

    #[tokio::test]
    async fn transactional_enqueue_commits_and_rolls_back_atomically_with_write_dirty() {
        let (_dir, service) = test_service().await;
        let outbox = Arc::new(Outbox::new(service.clone()));

        let outbox_c = outbox.clone();
        let aborted: Result<((), SliceMask), ApiError> = service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    outbox_c.enqueue_in_tx_at(tx, "channel.deliver", r#"{"id":"never"}"#, 1_000).await?;
                    Err(ApiError::new(BizCode::InternalError, "abort tx"))
                })
            })
            .await;
        assert!(aborted.is_err());
        assert!(service.outbox.list().await.unwrap().is_empty());

        let outbox_c = outbox.clone();
        let (item_id, dirty): (i64, SliceMask) = service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    let id = outbox_c.enqueue_in_tx_at(tx, "channel.deliver", r#"{"id":"ok"}"#, 1_000).await?;
                    Ok::<_, ApiError>((id, SliceMask::COLLAB))
                })
            })
            .await
            .unwrap();
        assert_eq!(dirty, SliceMask::COLLAB);

        let rows = service.outbox.list().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, item_id);
        assert_eq!(rows[0].topic, "channel.deliver");
        assert_eq!(rows[0].status, OUTBOX_STATUS_PENDING);
        assert_eq!(rows[0].attempts, 0);

        service.close().await;
    }

    #[tokio::test]
    async fn handler_failure_retries_with_exponential_backoff_and_succeeds_or_fails() {
        let (_dir, service) = test_service().await;
        let outbox = Arc::new(Outbox::with_config(
            service.clone(),
            OutboxConfig {
                batch_size: 10,
                max_attempts: 3,
                base_backoff: Duration::from_millis(100),
                max_backoff: Duration::from_millis(250),
                poll_interval: Duration::from_secs(1),
            },
        ));

        let seen_attempts = Arc::new(AtomicUsize::new(0));
        let counter = seen_attempts.clone();
        outbox.register("retry.then.ok", move |delivery| {
            let counter = counter.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
                if n < 3 {
                    Err(format!("transient failure #{n} (attempts={})", delivery.attempts))
                } else {
                    Ok(())
                }
            }
        });

        outbox.register("always.fail", |_delivery| async move { Err::<(), _>("permanent boom") });

        let outbox_c = outbox.clone();
        let (ok_id, fail_id) = service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    let a = outbox_c.enqueue_in_tx_at(tx, "retry.then.ok", r#"{"n":1}"#, 1_000).await?;
                    let b = outbox_c.enqueue_in_tx_at(tx, "always.fail", r#"{"n":2}"#, 1_000).await?;
                    Ok::<_, ApiError>(((a, b), SliceMask::NONE))
                })
            })
            .await
            .unwrap()
            .0;

        assert_eq!(outbox.drain_once(1_000).await.unwrap(), 2);
        let rows = service.outbox.list().await.unwrap();
        assert_eq!(rows[0].id, ok_id);
        assert_eq!(rows[0].status, OUTBOX_STATUS_PENDING);
        assert_eq!(rows[0].attempts, 1);
        assert_eq!(rows[0].available_at, 1_100);
        assert!(rows[0].last_error.as_deref().unwrap().contains("transient failure #1"));

        assert_eq!(outbox.drain_once(1_099).await.unwrap(), 0);

        assert_eq!(outbox.drain_once(1_100).await.unwrap(), 2);
        let rows = service.outbox.list().await.unwrap();
        assert_eq!(rows[0].attempts, 2);
        assert_eq!(rows[0].available_at, 1_300);

        assert_eq!(outbox.drain_once(1_300).await.unwrap(), 2);
        let rows = service.outbox.list().await.unwrap();
        assert_eq!(rows[0].id, ok_id);
        assert_eq!(rows[0].status, OUTBOX_STATUS_DONE);
        assert_eq!(rows[0].last_error, None);
        assert_eq!(rows[1].id, fail_id);
        assert_eq!(rows[1].status, OUTBOX_STATUS_FAILED);
        assert_eq!(rows[1].attempts, 3);
        assert_eq!(rows[1].last_error.as_deref(), Some("permanent boom"));

        service.close().await;
    }

    #[tokio::test]
    async fn task_group_bound_worker_recovers_processing_rows_dispatches_and_shuts_down() {
        let (_dir, service) = test_service().await;
        let outbox = Arc::new(Outbox::with_config(
            service.clone(),
            OutboxConfig {
                poll_interval: Duration::from_secs(30),
                ..Default::default()
            },
        ));

        let outbox_c = outbox.clone();
        let (id, _) = service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    let id = outbox_c.enqueue_in_tx_at(tx, "job.run", r#"{"hello":"world"}"#, 500).await?;
                    Ok::<_, ApiError>((id, SliceMask::OPS))
                })
            })
            .await
            .unwrap();
        let claimed = service.outbox.claim_pending(500, 10).await.unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, id);

        let task = TaskGroup::new();
        let done_notify = Arc::new(Notify::new());
        let done_tx = done_notify.clone();
        outbox.register("job.run", move |delivery| {
            let done_tx = done_tx.clone();
            async move {
                assert_eq!(delivery.payload_json, r#"{"hello":"world"}"#);
                done_tx.notify_one();
                Ok::<_, String>(())
            }
        });

        outbox.start(&task);
        tokio::time::timeout(Duration::from_secs(2), done_notify.notified()).await.unwrap();

        let delivered2 = Arc::new(Notify::new());
        let delivered2_tx = delivered2.clone();
        outbox.register("job.two", move |_| {
            let delivered2_tx = delivered2_tx.clone();
            async move {
                delivered2_tx.notify_one();
                Ok::<_, String>(())
            }
        });
        let outbox_c = outbox.clone();
        service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    outbox_c.enqueue_in_tx(tx, "job.two", r#"{"two":true}"#).await?;
                    Ok::<_, ApiError>(((), SliceMask::NONE))
                })
            })
            .await
            .unwrap();
        outbox.wake();
        tokio::time::timeout(Duration::from_secs(2), delivered2.notified()).await.unwrap();

        assert!(task.shutdown(Duration::from_secs(2)).await);
        let rows = service.outbox.list().await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.status == OUTBOX_STATUS_DONE));

        service.close().await;
    }

    #[tokio::test]
    async fn with_clock_timestamps_enqueues_and_register_replaces_existing_handler() {
        let (_dir, service) = test_service().await;
        let clock = Arc::new(vibevalley_core::ManualClock::new(42_000));
        let outbox = Arc::new(Outbox::new(service.clone()).with_clock(clock.clone()));

        let first_calls = Arc::new(AtomicUsize::new(0));
        let second_calls = Arc::new(AtomicUsize::new(0));

        let c1 = first_calls.clone();
        outbox.register("dup.topic", move |_| {
            let c1 = c1.clone();
            async move {
                c1.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(())
            }
        });
        let c2 = second_calls.clone();
        outbox.register("dup.topic", move |_| {
            let c2 = c2.clone();
            async move {
                c2.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(())
            }
        });

        let outbox_c = outbox.clone();
        service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    outbox_c.enqueue_in_tx(tx, "dup.topic", r#"{"ok":true}"#).await?;
                    Ok::<_, ApiError>(((), SliceMask::NONE))
                })
            })
            .await
            .unwrap();

        let rows = service.outbox.list().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].created_at, 42_000);
        assert_eq!(rows[0].available_at, 42_000);

        assert_eq!(outbox.drain_once(42_000).await.unwrap(), 1);
        assert_eq!(first_calls.load(Ordering::SeqCst), 0);
        assert_eq!(second_calls.load(Ordering::SeqCst), 1);

        service.close().await;
    }

    #[tokio::test]
    async fn dead_letter_observability_and_replay_recovers_failed_items() {
        use std::sync::atomic::AtomicBool;

        let (_dir, service) = test_service().await;
        let clock = Arc::new(vibevalley_core::ManualClock::new(10_000));
        let outbox = Arc::new(
            Outbox::with_config(
                service.clone(),
                OutboxConfig {
                    batch_size: 10,
                    max_attempts: 2,
                    base_backoff: Duration::from_millis(100),
                    max_backoff: Duration::from_millis(200),
                    poll_interval: Duration::from_secs(5),
                },
            )
            .with_clock(clock.clone()),
        );

        let should_fail = Arc::new(AtomicBool::new(true));
        let delivered = Arc::new(AtomicUsize::new(0));
        let fail_flag = should_fail.clone();
        let delivered_c = delivered.clone();
        outbox.register("dlq.topic", move |_delivery| {
            let fail_flag = fail_flag.clone();
            let delivered_c = delivered_c.clone();
            async move {
                if fail_flag.load(Ordering::SeqCst) {
                    Err("downstream 503".to_owned())
                } else {
                    delivered_c.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }
        });

        let outbox_c = outbox.clone();
        let (id1, id2) = service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    let a = outbox_c.enqueue_in_tx_at(tx, "dlq.topic", r#"{"n":1}"#, 10_000).await?;
                    let b = outbox_c.enqueue_in_tx_at(tx, "dlq.topic", r#"{"n":2}"#, 10_000).await?;
                    Ok::<_, ApiError>(((a, b), SliceMask::NONE))
                })
            })
            .await
            .unwrap()
            .0;

        assert_eq!(outbox.drain_once(10_000).await.unwrap(), 2);
        assert_eq!(outbox.failed_count_async().await.unwrap(), 0);

        // Second attempt exhausts `max_attempts = 2` -> both enter dead-letter (`failed`) state.
        assert_eq!(outbox.drain_once(10_100).await.unwrap(), 2);
        assert_eq!(outbox.cached_failed_count(), 2);
        assert_eq!(outbox.failed_count_async().await.unwrap(), 2);

        let failed_items = outbox.list_failed_async(10).await.unwrap();
        assert_eq!(failed_items.len(), 2);
        assert_eq!(failed_items[0].id, id2);
        assert_eq!(failed_items[1].id, id1);
        assert_eq!(failed_items[0].last_error.as_deref(), Some("downstream 503"));

        // Fix downstream handler and replay a single dead-letter item by ID.
        should_fail.store(false, Ordering::SeqCst);
        clock.set(20_000);
        assert!(outbox.replay_failed_async(id1).await.unwrap());
        assert!(!outbox.replay_failed_async(id1).await.unwrap(), "replaying non-failed row returns false");
        assert_eq!(outbox.cached_failed_count(), 1);
        assert_eq!(outbox.drain_once(20_000).await.unwrap(), 1);
        assert_eq!(delivered.load(Ordering::SeqCst), 1);

        // Replay remaining dead-letter items in bulk.
        assert_eq!(outbox.replay_all_failed_async().await.unwrap(), 1);
        assert_eq!(outbox.cached_failed_count(), 0);
        assert_eq!(outbox.drain_once(20_000).await.unwrap(), 1);
        assert_eq!(delivered.load(Ordering::SeqCst), 2);
        assert_eq!(outbox.failed_count_async().await.unwrap(), 0);

        service.close().await;
    }

    #[tokio::test]
    async fn post_commit_hooks_wakes_outbox_only_after_commit_and_suppresses_on_rollback() {
        let (_dir, service) = test_service().await;
        let outbox = Arc::new(Outbox::with_config(
            service.clone(),
            OutboxConfig {
                poll_interval: Duration::from_secs(60),
                ..Default::default()
            },
        ));
        let delivered = Arc::new(Notify::new());
        let delivered_c = delivered.clone();
        outbox.register(OUTBOX_SESSION_REMEMBER, move |_| {
            let delivered_c = delivered_c.clone();
            async move {
                delivered_c.notify_one();
                Ok::<_, String>(())
            }
        });

        let task = TaskGroup::new();
        outbox.start(&task);

        // Rolled-back transaction must NOT commit row or deliver event.
        let outbox_rb = outbox.clone();
        let rb: Result<((), vibevalley_kit::core::DirtyMask), ApiError> = service
            .write_with_hooks(move |tx, hooks| {
                Box::pin(async move {
                    let ev = OutboxEvent::SessionRemember {
                        agent: "a1".into(),
                        text: "rolled back".into(),
                        repo: None,
                    };
                    outbox_rb.enqueue_event_in_tx_with_hooks(tx, hooks, &ev).await?;
                    Err(ApiError::new(BizCode::InternalError, "rollback"))
                })
            })
            .await;
        assert!(rb.is_err());
        assert!(service.outbox.list().await.unwrap().is_empty());

        // Committed transaction enqueues row AND fires post-commit `outbox.wake()` immediately.
        let outbox_ok = outbox.clone();
        let (id, _) = service
            .write_with_hooks(move |tx, hooks| {
                Box::pin(async move {
                    let ev = OutboxEvent::SessionRemember {
                        agent: "a1".into(),
                        text: "committed".into(),
                        repo: None,
                    };
                    outbox_ok.enqueue_event_in_tx_with_hooks(tx, hooks, &ev).await
                })
            })
            .await
            .unwrap();
        assert!(id > 0);
        tokio::time::timeout(Duration::from_secs(2), delivered.notified()).await.unwrap();
        assert!(task.shutdown(Duration::from_secs(2)).await);
        service.close().await;
    }
}
