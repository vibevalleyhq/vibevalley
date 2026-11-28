use std::collections::VecDeque;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use tokio::sync::Notify;

/// Explicit overflow handling strategy required by [`BoundedSink`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverflowPolicy {
    /// Wait asynchronously until capacity frees up.
    Block,
    /// Drop the incoming item immediately when full.
    DropNewest,
    /// Evict the oldest buffered item to make room for the incoming item.
    DropOldest,
}

/// Lock-free snapshot of [`BoundedSink`] throughput and drop counters.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SinkStats {
    pub sent: u64,
    pub dropped: u64,
    pub buffered: usize,
    pub capacity: usize,
}

struct Inner<E> {
    capacity: usize,
    policy: OverflowPolicy,
    queue: Mutex<QueueState<E>>,
    item_ready: Notify,
    space_ready: Notify,
    sent: AtomicU64,
    dropped: AtomicU64,
}

struct QueueState<E> {
    buf: VecDeque<E>,
    closed: bool,
}

/// Producer handle for a bounded stream with explicit [`OverflowPolicy`].
pub struct BoundedSink<E> {
    inner: Arc<Inner<E>>,
}

impl<E> Clone for BoundedSink<E> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

/// Consumer handle paired with [`BoundedSink`].
pub struct BoundedStream<E> {
    inner: Arc<Inner<E>>,
}

/// Creates a bounded producer/consumer pair with explicit capacity and overflow strategy.
pub fn bounded_stream<E>(capacity: NonZeroUsize, policy: OverflowPolicy) -> (BoundedSink<E>, BoundedStream<E>) {
    let cap = capacity.get();
    let inner = Arc::new(Inner {
        capacity: cap,
        policy,
        queue: Mutex::new(QueueState {
            buf: VecDeque::with_capacity(cap.min(256)),
            closed: false,
        }),
        item_ready: Notify::new(),
        space_ready: Notify::new(),
        sent: AtomicU64::new(0),
        dropped: AtomicU64::new(0),
    });
    (BoundedSink { inner: Arc::clone(&inner) }, BoundedStream { inner })
}

impl<E> BoundedSink<E> {
    /// Attempts to send `item` synchronously under the configured [`OverflowPolicy`].
    /// Returns `true` if accepted into the buffer, `false` if dropped or closed.
    pub fn try_send(&self, item: E) -> bool {
        let mut st = self.inner.queue.lock();
        if st.closed {
            return false;
        }
        if st.buf.len() >= self.inner.capacity {
            match self.inner.policy {
                OverflowPolicy::Block | OverflowPolicy::DropNewest => {
                    self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
                OverflowPolicy::DropOldest => {
                    let _ = st.buf.pop_front();
                    self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        st.buf.push_back(item);
        self.inner.sent.fetch_add(1, Ordering::Relaxed);
        drop(st);
        self.inner.item_ready.notify_one();
        true
    }

    /// Sends `item`, awaiting space when `policy == OverflowPolicy::Block`.
    /// Returns `true` if enqueued, `false` if dropped or closed.
    pub async fn send(&self, item: E) -> bool {
        if self.inner.policy != OverflowPolicy::Block {
            return self.try_send(item);
        }
        let mut pending = Some(item);
        loop {
            let notified = self.inner.space_ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut st = self.inner.queue.lock();
                if st.closed {
                    return false;
                }
                if st.buf.len() < self.inner.capacity {
                    st.buf.push_back(pending.take().expect("pending item"));
                    self.inner.sent.fetch_add(1, Ordering::Relaxed);
                    drop(st);
                    self.inner.item_ready.notify_one();
                    return true;
                }
            }
            notified.await;
        }
    }

    pub fn close(&self) {
        let mut st = self.inner.queue.lock();
        st.closed = true;
        drop(st);
        self.inner.item_ready.notify_waiters();
        self.inner.space_ready.notify_waiters();
    }

    pub fn stats(&self) -> SinkStats {
        let buffered = self.inner.queue.lock().buf.len();
        SinkStats {
            sent: self.inner.sent.load(Ordering::Relaxed),
            dropped: self.inner.dropped.load(Ordering::Relaxed),
            buffered,
            capacity: self.inner.capacity,
        }
    }
}

impl<E> BoundedStream<E> {
    pub fn is_empty(&self) -> bool {
        self.inner.queue.lock().buf.is_empty()
    }

    pub fn try_recv(&mut self) -> Option<E> {
        let mut st = self.inner.queue.lock();
        let item = st.buf.pop_front();
        if item.is_some() {
            drop(st);
            self.inner.space_ready.notify_one();
        }
        item
    }

    pub async fn recv(&mut self) -> Option<E> {
        loop {
            let notified = self.inner.item_ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut st = self.inner.queue.lock();
                if let Some(item) = st.buf.pop_front() {
                    drop(st);
                    self.inner.space_ready.notify_one();
                    return Some(item);
                }
                if st.closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

impl<E> Drop for BoundedStream<E> {
    fn drop(&mut self) {
        let mut st = self.inner.queue.lock();
        st.closed = true;
        drop(st);
        self.inner.space_ready.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nz(n: usize) -> NonZeroUsize {
        NonZeroUsize::new(n).unwrap()
    }

    #[tokio::test]
    async fn bounded_stream_enforces_drop_newest_and_drop_oldest_policies() {
        let (sink, mut stream) = bounded_stream::<usize>(nz(2), OverflowPolicy::DropNewest);
        assert!(sink.try_send(1));
        assert!(sink.try_send(2));
        assert!(!sink.try_send(3));
        assert_eq!(sink.stats().dropped, 1);
        assert_eq!(stream.recv().await, Some(1));
        assert_eq!(stream.recv().await, Some(2));

        let (sink2, mut stream2) = bounded_stream::<usize>(nz(2), OverflowPolicy::DropOldest);
        assert!(sink2.try_send(10));
        assert!(sink2.try_send(20));
        assert!(sink2.try_send(30));
        assert_eq!(sink2.stats().dropped, 1);
        assert_eq!(stream2.recv().await, Some(20));
        assert_eq!(stream2.recv().await, Some(30));
    }

    #[tokio::test]
    async fn bounded_stream_block_policy_waits_for_consumer() {
        let (sink, mut stream) = bounded_stream::<usize>(nz(1), OverflowPolicy::Block);
        assert!(sink.send(1).await);
        let producer = {
            let sink = sink.clone();
            tokio::spawn(async move { sink.send(2).await })
        };
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());

        assert_eq!(stream.recv().await, Some(1));
        assert!(producer.await.unwrap());
        assert_eq!(stream.recv().await, Some(2));
    }
}
