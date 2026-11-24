//! Transactional outbox spine: atomic enqueue inside `ServerDb` write transactions,
//! topic handler registry, exponential-backoff retries, and `Runtime`-bound dispatch.

// Staged spine module wired into `App` during direct cutover.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt::Display;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use sea_orm::{DatabaseTransaction, DbErr};
use serde_json::Value;
use tokio::sync::Notify;

use crate::app::runtime::Runtime;
use crate::db::{OutboxItemRow, ServerDb};
use crate::transport::api::BoxFuture;

const DEFAULT_BATCH_SIZE: u64 = 32;
const DEFAULT_MAX_ATTEMPTS: i64 = 8;
const DEFAULT_BASE_BACKOFF: Duration = Duration::from_millis(500);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(60);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Configuration governing outbox batch size, retry budget, and backoff timings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutboxConfig {
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
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OutboxDelivery {
    pub id: i64,
    pub topic: String,
    pub payload: Value,
    pub attempts: i64,
    pub created_at: i64,
}

type OutboxHandler = Arc<dyn Fn(OutboxDelivery) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// Transactional outbox dispatcher backed by `outbox_item` in [`ServerDb`] and
/// driven by [`Runtime`].
pub(crate) struct Outbox {
    db: Arc<ServerDb>,
    config: OutboxConfig,
    handlers: RwLock<HashMap<String, OutboxHandler>>,
    notify: Notify,
}

impl Outbox {
    /// Creates an [`Outbox`] dispatcher with default retry and poll configuration.
    pub(crate) fn new(db: Arc<ServerDb>) -> Self {
        Self::with_config(db, OutboxConfig::default())
    }

    /// Creates an [`Outbox`] dispatcher with explicit retry and poll configuration.
    pub(crate) fn with_config(db: Arc<ServerDb>, config: OutboxConfig) -> Self {
        Self {
            db,
            config,
            handlers: RwLock::new(HashMap::new()),
            notify: Notify::new(),
        }
    }

    /// Enqueues an outbox item inside an open SeaORM transaction using the current wall clock.
    pub(crate) async fn enqueue_in_tx(tx: &DatabaseTransaction, topic: &str, payload: &Value) -> Result<i64, DbErr> {
        Self::enqueue_in_tx_at(tx, topic, payload, now_ms()).await
    }

    /// Enqueues an outbox item inside an open SeaORM transaction with an explicit timestamp (ms).
    pub(crate) async fn enqueue_in_tx_at(tx: &DatabaseTransaction, topic: &str, payload: &Value, now_ms: i64) -> Result<i64, DbErr> {
        let payload_json = serde_json::to_string(payload).map_err(|e| DbErr::Custom(format!("outbox payload serialize failed: {e}")))?;
        ServerDb::insert_outbox_item_in_tx(tx, topic, &payload_json, now_ms).await
    }

    /// Registers an async handler for `topic`.
    pub(crate) fn register<F, Fut, E>(&self, topic: impl Into<String>, handler: F)
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
    pub(crate) fn wake(&self) {
        self.notify.notify_one();
    }

    /// Computes exponential backoff delay for the given attempt count (`attempts >= 1`).
    pub(crate) fn backoff_delay(&self, attempts: i64) -> Duration {
        let shift = attempts.saturating_sub(1).clamp(0, 20) as u32;
        let factor = 1u32.checked_shl(shift).unwrap_or(u32::MAX);
        self.config.base_backoff.saturating_mul(factor).min(self.config.max_backoff)
    }

    /// Starts the background outbox dispatcher bound to `runtime`'s lifecycle.
    pub(crate) fn start(self: &Arc<Self>, runtime: &Runtime) {
        let outbox = self.clone();
        let cancel = runtime.token();
        runtime.spawn(async move {
            if let Err(err) = outbox.db.recover_processing_outbox(now_ms()).await {
                tracing::warn!(error = %err, "outbox.recover_processing failed");
            }

            loop {
                if cancel.is_cancelled() {
                    return;
                }

                let drained = match outbox.drain_once(now_ms()).await {
                    Ok(count) => count,
                    Err(err) => {
                        tracing::warn!(error = %err, "outbox.drain_once failed");
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

                let wait = match outbox.next_wait_duration(now_ms()).await {
                    Ok(d) => d,
                    Err(err) => {
                        tracing::warn!(error = %err, "outbox.next_pending_outbox_at failed");
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

    async fn next_wait_duration(&self, current_ms: i64) -> Result<Duration, DbErr> {
        let next = self.db.next_pending_outbox_at().await?;
        let wait = match next {
            Some(available_at) if available_at <= current_ms => Duration::ZERO,
            Some(available_at) => Duration::from_millis((available_at - current_ms) as u64).min(self.config.poll_interval),
            None => self.config.poll_interval,
        };
        Ok(wait)
    }

    /// Claims and dispatches up to `config.batch_size` due rows at `current_ms`.
    pub(crate) async fn drain_once(&self, current_ms: i64) -> Result<usize, DbErr> {
        let rows = self.db.claim_pending_outbox(current_ms, self.config.batch_size).await?;
        let count = rows.len();
        for row in rows {
            self.dispatch_row(row, current_ms).await?;
        }
        Ok(count)
    }

    async fn dispatch_row(&self, row: OutboxItemRow, current_ms: i64) -> Result<(), DbErr> {
        let payload: Value = match serde_json::from_str(&row.payload_json) {
            Ok(v) => v,
            Err(err) => {
                let msg = format!("invalid outbox payload json: {err}");
                self.db.fail_outbox_item(row.id, &msg).await?;
                return Ok(());
            }
        };

        let handler = self.handlers.read().get(&row.topic).cloned();
        let Some(handler) = handler else {
            let msg = format!("no outbox handler registered for topic `{}`", row.topic);
            self.handle_failure(row.id, row.attempts, current_ms, &msg).await?;
            return Ok(());
        };

        let delivery = OutboxDelivery {
            id: row.id,
            topic: row.topic,
            payload,
            attempts: row.attempts,
            created_at: row.created_at,
        };
        match handler(delivery).await {
            Ok(()) => self.db.complete_outbox_item(row.id).await,
            Err(err) => self.handle_failure(row.id, row.attempts, current_ms, &err).await,
        }
    }

    async fn handle_failure(&self, id: i64, attempts: i64, current_ms: i64, err: &str) -> Result<(), DbErr> {
        if attempts >= self.config.max_attempts {
            self.db.fail_outbox_item(id, err).await
        } else {
            let delay_ms = self.backoff_delay(attempts).as_millis().min(i64::MAX as u128) as i64;
            let next_at = current_ms.saturating_add(delay_ms);
            self.db.reschedule_outbox_item(id, next_at, err).await
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;
    use tokio::sync::Notify;
    use vibevalley_core::SliceMask;

    use super::*;
    use crate::db::{OUTBOX_STATUS_DONE, OUTBOX_STATUS_FAILED, OUTBOX_STATUS_PENDING};

    fn test_db() -> (tempfile::TempDir, Arc<ServerDb>) {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn transactional_enqueue_commits_and_rolls_back_atomically_with_write_dirty() {
        let (_dir, db) = test_db();

        // Rolled-back transaction must NOT persist the outbox item.
        let aborted: Result<((), SliceMask), DbErr> = db
            .write_dirty(|tx| {
                Box::pin(async move {
                    Outbox::enqueue_in_tx_at(tx, "channel.deliver", &json!({"id": "never"}), 1_000).await?;
                    Err(DbErr::Custom("abort tx".into()))
                })
            })
            .await;
        assert!(aborted.is_err());
        assert!(db.list_outbox_items().await.unwrap().is_empty());

        // Committed transaction persists the outbox item and returns the dirty mask.
        let (item_id, dirty): (i64, SliceMask) = db
            .write_dirty(|tx| {
                Box::pin(async move {
                    let id = Outbox::enqueue_in_tx_at(tx, "channel.deliver", &json!({"id": "ok"}), 1_000).await?;
                    Ok::<_, DbErr>((id, SliceMask::COLLAB))
                })
            })
            .await
            .unwrap();
        assert_eq!(dirty, SliceMask::COLLAB);

        let rows = db.list_outbox_items().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, item_id);
        assert_eq!(rows[0].topic, "channel.deliver");
        assert_eq!(rows[0].status, OUTBOX_STATUS_PENDING);
        assert_eq!(rows[0].attempts, 0);

        db.close_async().await;
    }

    #[tokio::test]
    async fn handler_failure_retries_with_exponential_backoff_and_succeeds_or_fails() {
        let (_dir, db) = test_db();
        let outbox = Outbox::with_config(
            db.clone(),
            OutboxConfig {
                batch_size: 10,
                max_attempts: 3,
                base_backoff: Duration::from_millis(100),
                max_backoff: Duration::from_millis(250),
                poll_interval: Duration::from_secs(1),
            },
        );

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

        let (ok_id, fail_id) = db
            .write_dirty(|tx| {
                Box::pin(async move {
                    let a = Outbox::enqueue_in_tx_at(tx, "retry.then.ok", &json!({"n": 1}), 1_000).await?;
                    let b = Outbox::enqueue_in_tx_at(tx, "always.fail", &json!({"n": 2}), 1_000).await?;
                    Ok::<_, DbErr>(((a, b), SliceMask::NONE))
                })
            })
            .await
            .unwrap()
            .0;

        // Attempt 1 at t=1_000 -> both fail -> backoff = 100ms -> available_at = 1_100.
        assert_eq!(outbox.drain_once(1_000).await.unwrap(), 2);
        let rows = db.list_outbox_items().await.unwrap();
        assert_eq!(rows[0].id, ok_id);
        assert_eq!(rows[0].status, OUTBOX_STATUS_PENDING);
        assert_eq!(rows[0].attempts, 1);
        assert_eq!(rows[0].available_at, 1_100);
        assert!(rows[0].last_error.as_deref().unwrap().contains("transient failure #1"));

        // Before t=1_100 nothing is claimable.
        assert_eq!(outbox.drain_once(1_099).await.unwrap(), 0);

        // Attempt 2 at t=1_100 -> backoff = 200ms -> available_at = 1_300.
        assert_eq!(outbox.drain_once(1_100).await.unwrap(), 2);
        let rows = db.list_outbox_items().await.unwrap();
        assert_eq!(rows[0].attempts, 2);
        assert_eq!(rows[0].available_at, 1_300);

        // Attempt 3 at t=1_300 -> ok_id succeeds (done), fail_id hits max_attempts=3 (failed).
        assert_eq!(outbox.drain_once(1_300).await.unwrap(), 2);
        let rows = db.list_outbox_items().await.unwrap();
        assert_eq!(rows[0].id, ok_id);
        assert_eq!(rows[0].status, OUTBOX_STATUS_DONE);
        assert_eq!(rows[0].last_error, None);
        assert_eq!(rows[1].id, fail_id);
        assert_eq!(rows[1].status, OUTBOX_STATUS_FAILED);
        assert_eq!(rows[1].attempts, 3);
        assert_eq!(rows[1].last_error.as_deref(), Some("permanent boom"));

        db.close_async().await;
    }

    #[tokio::test]
    async fn runtime_bound_worker_recovers_processing_rows_dispatches_and_shuts_down() {
        let (_dir, db) = test_db();

        // Enqueue and simulate a crash mid-processing.
        let (id, _) = db
            .write_dirty(|tx| {
                Box::pin(async move {
                    let id = Outbox::enqueue_in_tx_at(tx, "job.run", &json!({"hello": "world"}), 500).await?;
                    Ok::<_, DbErr>((id, SliceMask::OPS))
                })
            })
            .await
            .unwrap();
        let claimed = db.claim_pending_outbox(500, 10).await.unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, id);

        let runtime = Runtime::new();
        let outbox = Arc::new(Outbox::with_config(
            db.clone(),
            OutboxConfig {
                poll_interval: Duration::from_secs(30),
                ..Default::default()
            },
        ));
        let done_notify = Arc::new(Notify::new());
        let done_tx = done_notify.clone();
        outbox.register("job.run", move |delivery| {
            let done_tx = done_tx.clone();
            async move {
                assert_eq!(delivery.payload, json!({"hello": "world"}));
                done_tx.notify_one();
                Ok::<_, String>(())
            }
        });

        outbox.start(&runtime);
        tokio::time::timeout(Duration::from_secs(2), done_notify.notified()).await.unwrap();

        // Also enqueue another item after start and wake immediately.
        let delivered2 = Arc::new(Notify::new());
        let delivered2_tx = delivered2.clone();
        outbox.register("job.two", move |_| {
            let delivered2_tx = delivered2_tx.clone();
            async move {
                delivered2_tx.notify_one();
                Ok::<_, String>(())
            }
        });
        db.write_dirty(|tx| {
            Box::pin(async move {
                Outbox::enqueue_in_tx(tx, "job.two", &json!({"two": true})).await?;
                Ok::<_, DbErr>(((), SliceMask::NONE))
            })
        })
        .await
        .unwrap();
        outbox.wake();
        tokio::time::timeout(Duration::from_secs(2), delivered2.notified()).await.unwrap();

        assert!(runtime.shutdown(Duration::from_secs(2)).await);
        let rows = db.list_outbox_items().await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.status == OUTBOX_STATUS_DONE));

        db.close_async().await;
    }
}
