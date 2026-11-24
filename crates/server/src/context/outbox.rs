//! Transactional outbox dispatcher: atomic enqueue inside [`crate::db::Tx`]
//! transactions via [`crate::service::Service`], typed [`OutboxEvent`] payloads,
//! exponential-backoff retries, and [`TaskGroup`]-bound dispatch.

use std::collections::HashMap;
use std::fmt::Display;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use vibevalley_protocol::{ApiError, BizCode, Millis, Outcome, Spent};

use super::api::BoxFuture;
use super::task::TaskGroup;
use crate::db::Tx;
use crate::service::Service;
use crate::service::outbox::OutboxItem;

const DEFAULT_BATCH_SIZE: u64 = 32;
const DEFAULT_MAX_ATTEMPTS: i64 = 8;
const DEFAULT_BASE_BACKOFF: Duration = Duration::from_millis(500);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(60);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);

pub const OUTBOX_SESSION_REPORTED: &str = "work.session.reported";
pub const OUTBOX_SESSION_REMEMBER: &str = "memory.session_remember";

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

/// Closed typed event catalog carried by the durable [`Outbox`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "topic", content = "payload")]
pub enum OutboxEvent {
    #[serde(rename = "work.session.reported")]
    SessionReported(OutboxSessionReported),
    #[serde(rename = "memory.session_remember")]
    SessionRemember { agent: String, text: String, repo: Option<String> },
}

impl OutboxEvent {
    pub const fn topic(&self) -> &'static str {
        match self {
            Self::SessionReported(_) => OUTBOX_SESSION_REPORTED,
            Self::SessionRemember { .. } => OUTBOX_SESSION_REMEMBER,
        }
    }

    pub fn serialize_payload_json(&self) -> Result<String, ApiError> {
        let res = match self {
            Self::SessionReported(report) => serde_json::to_string(report),
            Self::SessionRemember { agent, text, repo } => serde_json::to_string(&RememberPayload { agent, text, repo }),
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

/// Configuration governing outbox batch size, retry budget, and backoff timings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxConfig {
    pub batch_size: u64,
    pub max_attempts: i64,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
    pub poll_interval: Duration,
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
            _ => Err(serde::de::Error::custom(format!("unknown outbox topic `{}`", self.topic))),
        }
    }
}

type OutboxHandler = Arc<dyn Fn(OutboxDelivery) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// Transactional outbox dispatcher backed by [`Service::outbox`] and driven by [`TaskGroup`].
pub struct Outbox {
    service: Arc<Service>,
    config: OutboxConfig,
    handlers: RwLock<HashMap<String, OutboxHandler>>,
    notify: Notify,
}

impl Outbox {
    /// Creates an [`Outbox`] dispatcher with default retry and poll configuration.
    pub fn new(service: Arc<Service>) -> Self {
        Self::with_config(service, OutboxConfig::default())
    }

    /// Creates an [`Outbox`] dispatcher with explicit retry and poll configuration.
    pub fn with_config(service: Arc<Service>, config: OutboxConfig) -> Self {
        Self {
            service,
            config,
            handlers: RwLock::new(HashMap::new()),
            notify: Notify::new(),
        }
    }

    /// Enqueues a typed [`OutboxEvent`] standalone on the write pool using the current wall clock.
    pub async fn enqueue_event(&self, event: &OutboxEvent) -> Result<i64, ApiError> {
        let payload_json = event.serialize_payload_json()?;
        self.service.outbox.enqueue(event.topic(), &payload_json, super::now()).await
    }

    /// Enqueues a typed [`OutboxEvent`] inside an open write transaction using the current wall clock.
    pub async fn enqueue_event_in_tx(&self, tx: &Tx, event: &OutboxEvent) -> Result<i64, ApiError> {
        self.enqueue_event_in_tx_at(tx, event, super::now()).await
    }

    /// Enqueues a typed [`OutboxEvent`] inside an open write transaction with an explicit timestamp (ms).
    pub async fn enqueue_event_in_tx_at(&self, tx: &Tx, event: &OutboxEvent, now_ms: i64) -> Result<i64, ApiError> {
        let payload_json = event.serialize_payload_json()?;
        self.service.outbox.enqueue_in_tx(tx, event.topic(), &payload_json, now_ms).await
    }

    /// Enqueues a raw JSON payload inside an open write transaction using the current wall clock.
    pub async fn enqueue_in_tx(&self, tx: &Tx, topic: &str, payload_json: &str) -> Result<i64, ApiError> {
        self.enqueue_in_tx_at(tx, topic, payload_json, super::now()).await
    }

    /// Enqueues a raw JSON payload inside an open write transaction with an explicit timestamp (ms).
    pub async fn enqueue_in_tx_at(&self, tx: &Tx, topic: &str, payload_json: &str, now_ms: i64) -> Result<i64, ApiError> {
        self.service.outbox.enqueue_in_tx(tx, topic, payload_json, now_ms).await
    }

    /// Registers an async handler for `topic`.
    pub fn register<F, Fut, E>(&self, topic: impl Into<String>, handler: F)
    where
        F: Fn(OutboxDelivery) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), E>> + Send + 'static,
        E: Display + 'static,
    {
        let wrapped: OutboxHandler = Arc::new(move |delivery| {
            let fut = handler(delivery);
            Box::pin(async move { fut.await.map_err(|err| err.to_string()) })
        });
        self.handlers.write().insert(topic.into(), wrapped);
    }

    /// Wakes the background outbox dispatcher (call after committing a transaction that enqueued items).
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// Computes exponential backoff delay for the given attempt count (`attempts >= 1`).
    pub fn backoff_delay(&self, attempts: i64) -> Duration {
        let shift = attempts.saturating_sub(1).clamp(0, 20) as u32;
        let factor = 1u32.checked_shl(shift).unwrap_or(u32::MAX);
        self.config.base_backoff.saturating_mul(factor).min(self.config.max_backoff)
    }

    /// Starts the background outbox dispatcher bound to `task`'s lifecycle.
    pub fn start(self: &Arc<Self>, task: &TaskGroup) {
        let outbox = self.clone();
        let cancel = task.token();
        task.spawn_named("outbox.dispatch", async move {
            if let Err(err) = outbox.service.outbox.recover_processing(super::now()).await {
                tracing::warn!(error = %err.message, "outbox.recover_processing failed");
            }

            loop {
                if cancel.is_cancelled() {
                    return;
                }

                let drained = match outbox.drain_once(super::now()).await {
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

                let wait = match outbox.next_wait_duration(super::now()).await {
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
    pub async fn drain_once(&self, current_ms: i64) -> Result<usize, ApiError> {
        let rows = self.service.outbox.claim_pending(current_ms, self.config.batch_size).await?;
        let count = rows.len();
        for row in rows {
            self.dispatch_row(row, current_ms).await?;
        }
        Ok(count)
    }

    async fn dispatch_row(&self, row: OutboxItem, current_ms: i64) -> Result<(), ApiError> {
        if let Err(err) = serde_json::from_str::<serde_json::Value>(&row.payload_json) {
            let msg = format!("invalid outbox payload json: {err}");
            self.service.outbox.fail(row.id, &msg).await?;
            return Ok(());
        }

        let handler = self.handlers.read().get(&row.topic).cloned();
        let Some(handler) = handler else {
            let msg = format!("no outbox handler registered for topic `{}`", row.topic);
            self.handle_failure(row.id, row.attempts, current_ms, &msg).await?;
            return Ok(());
        };

        let delivery = OutboxDelivery {
            id: row.id,
            topic: row.topic,
            payload_json: row.payload_json,
            attempts: row.attempts,
            created_at: row.created_at,
        };
        match handler(delivery).await {
            Ok(()) => self.service.outbox.complete(row.id).await,
            Err(err) => self.handle_failure(row.id, row.attempts, current_ms, &err).await,
        }
    }

    async fn handle_failure(&self, id: i64, attempts: i64, current_ms: i64, err: &str) -> Result<(), ApiError> {
        if attempts >= self.config.max_attempts {
            self.service.outbox.fail(id, err).await
        } else {
            let delay_ms = self.backoff_delay(attempts).as_millis().min(i64::MAX as u128) as i64;
            let next_at = current_ms.saturating_add(delay_ms);
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
}
