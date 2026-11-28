//! Deterministic in-memory [`OutboxStore`] twin for fast unit tests without SQLite/PostgreSQL.

use std::collections::BTreeMap;

use parking_lot::Mutex;

use super::{BoxFuture, OUTBOX_STATUS_DONE, OUTBOX_STATUS_FAILED, OUTBOX_STATUS_PENDING, OUTBOX_STATUS_PROCESSING, OutboxError, OutboxItem, OutboxStore};

#[derive(Debug, Default)]
struct Inner {
    next_id: i64,
    rows: BTreeMap<i64, OutboxItem>,
}

/// In-memory transactional outbox store implementing [`OutboxStore`] with exact SQL semantic parity.
#[derive(Debug, Default)]
pub struct MemoryOutbox {
    inner: Mutex<Inner>,
}

impl MemoryOutbox {
    pub fn new() -> Self {
        Self::default()
    }
}

impl OutboxStore for MemoryOutbox {
    fn enqueue_at<'a>(&'a self, topic: &'a str, payload_json: &'a str, created_at: i64, available_at: i64) -> BoxFuture<'a, Result<i64, OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            inner.next_id += 1;
            let id = inner.next_id;
            inner.rows.insert(
                id,
                OutboxItem {
                    id,
                    topic: topic.to_owned(),
                    payload_json: payload_json.to_owned(),
                    status: OUTBOX_STATUS_PENDING.to_owned(),
                    attempts: 0,
                    available_at,
                    created_at,
                    last_error: None,
                    locked_until: None,
                },
            );
            Ok(id)
        })
    }

    fn claim_with_lease<'a>(&'a self, now_ms: i64, limit: u64, lease_ms: Option<i64>) -> BoxFuture<'a, Result<Vec<OutboxItem>, OutboxError>> {
        Box::pin(async move {
            if limit == 0 {
                return Ok(Vec::new());
            }
            let mut inner = self.inner.lock();
            let mut due_ids: Vec<(i64, i64)> = inner
                .rows
                .values()
                .filter(|r| r.status == OUTBOX_STATUS_PENDING && r.available_at <= now_ms)
                .map(|r| (r.available_at, r.id))
                .collect();
            due_ids.sort();
            due_ids.truncate(limit as usize);

            let lease_deadline = lease_ms.map(|ms| now_ms.saturating_add(ms.max(0)));
            let mut claimed = Vec::with_capacity(due_ids.len());
            for (_, id) in due_ids {
                if let Some(row) = inner.rows.get_mut(&id) {
                    row.status = OUTBOX_STATUS_PROCESSING.to_owned();
                    row.attempts += 1;
                    row.locked_until = lease_deadline;
                    claimed.push(row.clone());
                }
            }
            Ok(claimed)
        })
    }

    fn recover_processing<'a>(&'a self, now_ms: i64) -> BoxFuture<'a, Result<u64, OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            let mut recovered = 0u64;
            for row in inner.rows.values_mut() {
                if row.status == OUTBOX_STATUS_PROCESSING {
                    row.status = OUTBOX_STATUS_PENDING.to_owned();
                    row.available_at = now_ms;
                    row.locked_until = None;
                    recovered += 1;
                }
            }
            Ok(recovered)
        })
    }

    fn reclaim_expired_leases<'a>(&'a self, now_ms: i64) -> BoxFuture<'a, Result<u64, OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            let mut reclaimed = 0u64;
            for row in inner.rows.values_mut() {
                if row.status == OUTBOX_STATUS_PROCESSING && row.locked_until.is_some_and(|until| until <= now_ms) {
                    row.status = OUTBOX_STATUS_PENDING.to_owned();
                    row.available_at = now_ms;
                    row.locked_until = None;
                    reclaimed += 1;
                }
            }
            Ok(reclaimed)
        })
    }

    fn next_pending_at(&self) -> BoxFuture<'_, Result<Option<i64>, OutboxError>> {
        Box::pin(async move {
            let inner = self.inner.lock();
            let earliest = inner.rows.values().filter(|r| r.status == OUTBOX_STATUS_PENDING).map(|r| r.available_at).min();
            Ok(earliest)
        })
    }

    fn complete(&self, id: i64) -> BoxFuture<'_, Result<(), OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            if let Some(row) = inner.rows.get_mut(&id) {
                row.status = OUTBOX_STATUS_DONE.to_owned();
                row.last_error = None;
                row.locked_until = None;
            }
            Ok(())
        })
    }

    fn reschedule<'a>(&'a self, id: i64, available_at: i64, error: &'a str) -> BoxFuture<'a, Result<(), OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            if let Some(row) = inner.rows.get_mut(&id) {
                row.status = OUTBOX_STATUS_PENDING.to_owned();
                row.available_at = available_at;
                row.last_error = Some(error.to_owned());
                row.locked_until = None;
            }
            Ok(())
        })
    }

    fn fail<'a>(&'a self, id: i64, error: &'a str) -> BoxFuture<'a, Result<(), OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            if let Some(row) = inner.rows.get_mut(&id) {
                row.status = OUTBOX_STATUS_FAILED.to_owned();
                row.last_error = Some(error.to_owned());
                row.locked_until = None;
            }
            Ok(())
        })
    }

    fn list_failed(&self, limit: u64) -> BoxFuture<'_, Result<Vec<OutboxItem>, OutboxError>> {
        Box::pin(async move {
            if limit == 0 {
                return Ok(Vec::new());
            }
            let inner = self.inner.lock();
            let rows = inner
                .rows
                .values()
                .rev()
                .filter(|r| r.status == OUTBOX_STATUS_FAILED)
                .take(limit as usize)
                .cloned()
                .collect();
            Ok(rows)
        })
    }

    fn count_failed(&self) -> BoxFuture<'_, Result<u64, OutboxError>> {
        Box::pin(async move {
            let inner = self.inner.lock();
            let count = inner.rows.values().filter(|r| r.status == OUTBOX_STATUS_FAILED).count() as u64;
            Ok(count)
        })
    }

    fn replay_failed(&self, id: i64, now_ms: i64) -> BoxFuture<'_, Result<bool, OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            if let Some(row) = inner.rows.get_mut(&id)
                && row.status == OUTBOX_STATUS_FAILED
            {
                row.status = OUTBOX_STATUS_PENDING.to_owned();
                row.attempts = 0;
                row.available_at = now_ms;
                row.last_error = None;
                row.locked_until = None;
                return Ok(true);
            }
            Ok(false)
        })
    }

    fn replay_all_failed(&self, now_ms: i64) -> BoxFuture<'_, Result<u64, OutboxError>> {
        Box::pin(async move {
            let mut inner = self.inner.lock();
            let mut replayed = 0u64;
            for row in inner.rows.values_mut() {
                if row.status == OUTBOX_STATUS_FAILED {
                    row.status = OUTBOX_STATUS_PENDING.to_owned();
                    row.attempts = 0;
                    row.available_at = now_ms;
                    row.last_error = None;
                    row.locked_until = None;
                    replayed += 1;
                }
            }
            Ok(replayed)
        })
    }

    fn prune_done_batch(&self, before_ms: i64, limit: u64) -> BoxFuture<'_, Result<u64, OutboxError>> {
        Box::pin(async move {
            if limit == 0 {
                return Ok(0);
            }
            let mut inner = self.inner.lock();
            let to_delete: Vec<i64> = inner
                .rows
                .values()
                .filter(|r| r.status == OUTBOX_STATUS_DONE && r.created_at < before_ms)
                .take(limit as usize)
                .map(|r| r.id)
                .collect();
            let count = to_delete.len() as u64;
            for id in to_delete {
                inner.rows.remove(&id);
            }
            Ok(count)
        })
    }

    fn list_all(&self) -> BoxFuture<'_, Result<Vec<OutboxItem>, OutboxError>> {
        Box::pin(async move {
            let inner = self.inner.lock();
            Ok(inner.rows.values().cloned().collect())
        })
    }
}
