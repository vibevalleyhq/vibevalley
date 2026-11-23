//! Shared pub/sub and commit stats hub for non-SQLite backends.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use crate::agent::durable::{CommitStats, DocumentEvent, Error, Result};

pub(crate) type DocKey = (String, String, String);

#[derive(Default)]
pub(crate) struct LiveInner {
    pub(crate) docs: Vec<flume::Sender<DocumentEvent>>,
    pub(crate) tasks: Vec<flume::Sender<()>>,
    pub(crate) stats: CommitStats,
}

/// Coordinates document/task wake channels and commit stats for non-SQLite backends.
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
            inner.docs.retain(|tx| tx.send(event.clone()).is_ok());
        }
        if tasks_changed {
            inner.tasks.retain(|tx| !matches!(tx.try_send(()), Err(flume::TrySendError::Disconnected(_))));
        }
    }

    pub fn stats(&self) -> CommitStats {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).stats
    }
}
