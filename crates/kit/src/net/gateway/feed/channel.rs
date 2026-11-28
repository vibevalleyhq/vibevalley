use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::watch;
use tokio_stream::Stream;
use tokio_stream::wrappers::WatchStream;

/// Pre-encoded snapshot published through [`FeedChannel`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedFrame {
    pub seq: i64,
    pub generation: u64,
    pub payload: Arc<str>,
}

/// Pre-encoded `tokio::sync::watch<Arc<str>>` channel for a single topic.
pub struct FeedChannel {
    topic: &'static str,
    payload_tx: watch::Sender<Arc<str>>,
    frame_tx: watch::Sender<FeedFrame>,
    latest: Mutex<FeedFrame>,
}

impl FeedChannel {
    pub fn new(topic: &'static str, initial_seq: i64, initial_payload: impl Into<Arc<str>>) -> Self {
        let payload: Arc<str> = initial_payload.into();
        let initial = FeedFrame {
            seq: initial_seq,
            generation: 0,
            payload: payload.clone(),
        };
        let (payload_tx, _) = watch::channel(payload);
        let (frame_tx, _) = watch::channel(initial.clone());
        Self {
            topic,
            payload_tx,
            frame_tx,
            latest: Mutex::new(initial),
        }
    }

    pub fn topic(&self) -> &'static str {
        self.topic
    }

    pub fn seq(&self) -> i64 {
        self.latest.lock().seq
    }

    pub fn snapshot(&self) -> Arc<str> {
        self.latest.lock().payload.clone()
    }

    pub fn has_watchers(&self) -> bool {
        self.payload_tx.receiver_count() > 0 || self.frame_tx.receiver_count() > 0
    }

    pub fn watcher_count(&self) -> usize {
        self.payload_tx.receiver_count() + self.frame_tx.receiver_count()
    }

    /// Publishes `(seq, payload)` if `seq` is strictly greater than the current sequence.
    /// Returns `true` when published.
    pub fn publish_if_newer(&self, seq: i64, payload: impl Into<Arc<str>>) -> bool {
        let payload: Arc<str> = payload.into();
        let frame = {
            let mut latest = self.latest.lock();
            if seq <= latest.seq {
                return false;
            }
            let frame = FeedFrame {
                seq,
                generation: latest.generation + 1,
                payload: payload.clone(),
            };
            *latest = frame.clone();
            frame
        };
        self.payload_tx.send_replace(payload);
        self.frame_tx.send_replace(frame);
        true
    }

    /// Unconditionally publishes a new frame, clamping `seq` to never regress.
    pub fn publish(&self, seq: i64, payload: impl Into<Arc<str>>) {
        let payload: Arc<str> = payload.into();
        let frame = {
            let mut latest = self.latest.lock();
            let frame = FeedFrame {
                seq: seq.max(latest.seq),
                generation: latest.generation + 1,
                payload: payload.clone(),
            };
            *latest = frame.clone();
            frame
        };
        self.payload_tx.send_replace(payload);
        self.frame_tx.send_replace(frame);
    }

    pub fn subscribe_payload(&self) -> watch::Receiver<Arc<str>> {
        self.payload_tx.subscribe()
    }

    pub fn subscribe(&self) -> FeedSubscription {
        FeedSubscription {
            topic: self.topic,
            rx: self.frame_tx.subscribe(),
        }
    }
}

/// Subscription handle for a single [`FeedChannel`] preserving `seq` and resume semantics.
pub struct FeedSubscription {
    topic: &'static str,
    rx: watch::Receiver<FeedFrame>,
}

impl FeedSubscription {
    pub fn topic(&self) -> &'static str {
        self.topic
    }

    pub fn borrow_and_update(&mut self) -> FeedFrame {
        self.rx.borrow_and_update().clone()
    }

    pub async fn changed(&mut self) -> bool {
        self.rx.changed().await.is_ok()
    }

    /// Converts this subscription into a `WatchStream`-backed stream of `(seq, payload)`
    /// honoring `after_seq` (`Last-Event-ID` / `?after=<seq>`).
    ///
    /// `transform_initial` is invoked only on the first emitted frame when `after_seq` is `None`.
    pub fn into_watch_stream<F>(self, after_seq: Option<i64>, mut transform_initial: F) -> Pin<Box<dyn Stream<Item = (i64, Arc<str>)> + Send>>
    where
        F: FnMut(Arc<str>) -> Arc<str> + Send + 'static,
    {
        use futures_util::StreamExt;

        let (initial_seq, initial_gen) = {
            let initial = self.rx.borrow();
            (initial.seq, initial.generation)
        };
        let skip_initial = after_seq == Some(initial_seq);
        let stream = if skip_initial {
            WatchStream::from_changes(self.rx)
        } else {
            WatchStream::new(self.rx)
        };
        let mut seen_gen = skip_initial.then_some(initial_gen);
        let mut is_initial = !skip_initial && after_seq.is_none();

        Box::pin(stream.filter_map(move |frame| {
            let out = if seen_gen == Some(frame.generation) {
                None
            } else {
                seen_gen = Some(frame.generation);
                let payload = if is_initial {
                    is_initial = false;
                    transform_initial(frame.payload)
                } else {
                    is_initial = false;
                    frame.payload
                };
                Some((frame.seq, payload))
            };
            std::future::ready(out)
        }))
    }
}
