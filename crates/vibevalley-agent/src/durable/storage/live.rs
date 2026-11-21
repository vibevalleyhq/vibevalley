//! Shared pub/sub and coalesced `pi.live` preview hub for non-SQLite backends.

use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use serde_json::Value;

use super::StorageRead;
use crate::durable::{CommitStats, Document, DocumentEvent, Error, Result};

pub(crate) type DocKey = (String, String, String);

struct Deferred {
    state: Value,
    mem_pending: bool,
    updated_at_ms: i64,
}

#[derive(Default)]
pub(crate) struct LiveInner {
    pub(crate) docs: Vec<flume::Sender<DocumentEvent>>,
    pub(crate) tasks: Vec<flume::Sender<()>>,
    live: HashMap<DocKey, Deferred>,
    published: HashMap<DocKey, Document>,
    mem_at: Option<i64>,
    disk_at: Option<i64>,
    timer_active: bool,
    pub(crate) stats: CommitStats,
}

/// Coordinates deferred `pi.live` memory previews (100ms) and durable flushes (1000ms),
/// plus document and task wake channels.
///
/// Lock ordering rule: whenever backend storage lock and `LiveHub` lock are both acquired,
/// the backend storage lock MUST always be acquired BEFORE `LiveHub`.
pub struct LiveHub {
    pub(crate) inner: Mutex<LiveInner>,
    closed: AtomicBool,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl LiveHub {
    pub fn new(clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            inner: Mutex::new(LiveInner::default()),
            closed: AtomicBool::new(false),
            clock,
        }
    }

    pub fn now_ms(&self) -> i64 {
        (self.clock)()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.docs.clear();
        inner.tasks.clear();
    }

    pub fn subscribe_documents(&self) -> Result<flume::Receiver<DocumentEvent>> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_closed() {
            return Err(Error::Closed);
        }
        let (tx, rx) = flume::unbounded();
        inner.docs.push(tx);
        Ok(rx)
    }

    pub fn subscribe_tasks(&self) -> Result<flume::Receiver<()>> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_closed() {
            return Err(Error::Closed);
        }
        let (tx, rx) = flume::bounded(1);
        inner.tasks.push(tx);
        Ok(rx)
    }

    pub fn record_request(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.stats.requests += 1;
    }

    pub fn record_failure(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.stats.failed_ops += 1;
    }

    pub fn record_commit_and_publish(&self, events: Vec<DocumentEvent>, tasks_changed: bool) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.stats.batches += 1;
        inner.stats.committed_ops += 1;
        for event in events {
            if event.document.doc_kind == "pi.live" {
                let key = (
                    event.document.scope_kind.clone(),
                    event.document.scope_id.clone(),
                    event.document.doc_kind.clone(),
                );
                inner.live.remove(&key);
                inner.published.remove(&key);
            }
            publish(&mut inner.docs, event);
        }
        if tasks_changed {
            inner.tasks.retain(|tx| !matches!(tx.try_send(()), Err(flume::TrySendError::Disconnected(_))));
        }
    }

    pub fn stats(&self) -> CommitStats {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).stats
    }

    pub fn queue_deferred(&self, scope: &str, id: &str, kind: &str, state: Value, spawn_timer: impl FnOnce()) -> Result<()> {
        if scope.is_empty() || id.is_empty() || kind != "pi.live" {
            return Err(Error::Invalid("only a scoped pi.live document can be deferred".into()));
        }
        let now = self.now_ms();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_closed() {
            return Err(Error::Closed);
        }
        inner.live.insert(
            (scope.into(), id.into(), kind.into()),
            Deferred {
                state,
                mem_pending: true,
                updated_at_ms: now,
            },
        );
        inner.mem_at.get_or_insert(now + 100);
        inner.disk_at.get_or_insert(now + 1000);
        let should_spawn = !inner.timer_active;
        if should_spawn {
            inner.timer_active = true;
        }
        drop(inner);
        if should_spawn {
            spawn_timer();
        }
        Ok(())
    }

    /// Returns `(pending_keys_to_publish_from_read, pending_disk_writes)`.
    /// Caller invokes durable read for keys without a cached rev, then `publish_mem`,
    /// and commits any disk writes outside `LiveHub`'s lock.
    pub fn drain_due(
        &self,
        now: i64,
        force: bool,
        read_rev: impl Fn(&[(String, String, String)]) -> Result<HashMap<DocKey, i64>>,
    ) -> Result<Vec<(DocKey, Value)>> {
        let need_mem_keys: Vec<DocKey> = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if force || inner.mem_at.is_some_and(|v| v <= now) {
                inner
                    .live
                    .iter()
                    .filter(|(k, d)| d.mem_pending && !inner.published.contains_key(*k))
                    .map(|(k, _)| k.clone())
                    .collect()
            } else {
                Vec::new()
            }
        };
        let revs = if need_mem_keys.is_empty() {
            HashMap::new()
        } else {
            read_rev(&need_mem_keys)?
        };

        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if force || inner.mem_at.is_some_and(|v| v <= now) {
            inner.mem_at = None;
            let LiveInner {
                live, published, docs, stats, ..
            } = &mut *inner;
            let mut mem_events = Vec::new();
            let mut next_published = Vec::new();
            for (key, item) in live.iter_mut() {
                if !item.mem_pending {
                    continue;
                }
                let base_rev = published.get(key).map(|d| d.rev).unwrap_or_else(|| revs.get(key).copied().unwrap_or(0));
                let doc = Document {
                    scope_kind: key.0.clone(),
                    scope_id: key.1.clone(),
                    doc_kind: key.2.clone(),
                    state: item.state.clone(),
                    updated_at_ms: item.updated_at_ms,
                    rev: base_rev + 1,
                };
                next_published.push((key.clone(), doc.clone()));
                item.mem_pending = false;
                mem_events.push(DocumentEvent {
                    document: doc,
                    durable: false,
                    retired: false,
                });
            }
            for (k, doc) in next_published {
                published.insert(k, doc);
            }
            stats.coalesced_live_memory += mem_events.len() as u64;
            for event in mem_events {
                publish(docs, event);
            }
        }

        if force || inner.disk_at.is_some_and(|v| v <= now) {
            let disk_batch: Vec<(DocKey, Value)> = inner.live.iter().map(|(k, d)| (k.clone(), d.state.clone())).collect();
            return Ok(disk_batch);
        }
        Ok(Vec::new())
    }

    pub fn complete_disk_flush(&self, committed: &[DocKey], disk_events: Vec<DocumentEvent>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.stats.coalesced_live_disk += disk_events.len() as u64;
        inner.disk_at = None;
        for key in committed {
            if let Some(d) = inner.live.get(key)
                && !d.mem_pending
            {
                inner.live.remove(key);
                inner.published.remove(key);
            }
        }
        if inner.live.is_empty() {
            inner.published.clear();
        }
        for event in disk_events {
            publish(&mut inner.docs, event);
        }
    }

    pub fn reschedule_disk_on_error(&self, now: i64) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.disk_at = Some(now + 1000);
    }

    pub fn next_timer_wait(&self, now: i64) -> Option<Duration> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let until = inner.mem_at.into_iter().chain(inner.disk_at).min();
        match until {
            Some(ts) => Some(Duration::from_millis((ts - now).clamp(1, 100) as u64)),
            None => {
                inner.timer_active = false;
                None
            }
        }
    }

    pub fn live_document(&self, scope: &str, id: &str, read: &dyn StorageRead) -> Result<Option<Document>> {
        let key = (scope.to_owned(), id.to_owned(), "pi.live".to_owned());
        {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(doc) = inner.published.get(&key) {
                return Ok(Some(doc.clone()));
            }
        }
        read.document(scope, id, "pi.live")
    }
}

fn publish(docs: &mut Vec<flume::Sender<DocumentEvent>>, event: DocumentEvent) {
    docs.retain(|tx| tx.send(event.clone()).is_ok());
}
