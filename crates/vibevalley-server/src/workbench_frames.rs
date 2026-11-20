use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use vibevalley_protocol::{STATE_EVERY_MS, StateFrame};

use crate::lock;

pub(super) struct Snapshot {
    pub frame: Arc<StateFrame>,
    pub locale: String,
    wire: OnceLock<Value>,
}

impl Snapshot {
    fn new(frame: StateFrame) -> Self {
        Self {
            frame: Arc::new(frame),
            locale: vibevalley_i18n::locale(),
            wire: OnceLock::new(),
        }
    }

    pub fn wire(&self) -> &Value {
        self.wire
            .get_or_init(|| serde_json::to_value(self.frame.as_ref()).expect("state frame serializes"))
    }
}

pub(super) struct WorkbenchFrames(Mutex<Published>);

struct Published {
    latest: Arc<Snapshot>,
    watchers: Vec<flume::Sender<()>>,
    last: Option<(i64, Instant)>,
}

impl WorkbenchFrames {
    pub fn new(frame: StateFrame) -> Self {
        Self(Mutex::new(Published {
            latest: Arc::new(Snapshot::new(frame)),
            watchers: vec![],
            last: None,
        }))
    }

    pub fn has_watchers(&self) -> bool {
        !lock(&self.0).watchers.is_empty()
    }

    pub fn should_publish(&self, seq: i64, leading: bool) -> bool {
        let current = lock(&self.0);
        let now = Instant::now();
        !current.watchers.is_empty()
            && !current
                .last
                .is_some_and(|(sent, time)| sent == seq || (leading && now.duration_since(time) < Duration::from_millis(STATE_EVERY_MS)))
    }

    pub fn replace_if_newer(&self, frame: StateFrame) {
        let locale = vibevalley_i18n::locale();
        let mut current = lock(&self.0);
        if current.latest.frame.seq < frame.seq || (current.latest.frame.seq == frame.seq && current.latest.locale != locale) {
            current.latest = Arc::new(Snapshot::new(frame));
        }
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        lock(&self.0).latest.clone()
    }

    pub fn publish(&self, leading: bool) {
        let mut current = lock(&self.0);
        let now = Instant::now();
        let seq = current.latest.frame.seq;
        if current.watchers.is_empty()
            || current
                .last
                .is_some_and(|(sent, time)| sent == seq || (leading && now.duration_since(time) < Duration::from_millis(STATE_EVERY_MS)))
        {
            return;
        }
        current.last = Some((seq, now));
        current
            .watchers
            .retain(|tx| !matches!(tx.try_send(()), Err(flume::TrySendError::Disconnected(_))));
    }

    pub fn watch(&self, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(&Value)) {
        let (tx, rx) = flume::bounded(1);
        let first = {
            let mut current = lock(&self.0);
            current.watchers.push(tx.clone());
            current.latest.clone()
        };
        let mut seen = first.frame.seq;
        receive(first.wire());
        drop(first);
        while !stop.is_disconnected() && flume::Selector::new().recv(stop, |_| false).recv(&rx, |r| r.is_ok()).wait() {
            let latest = self.snapshot();
            if latest.frame.seq > seen {
                seen = latest.frame.seq;
                receive(latest.wire());
            }
        }
        lock(&self.0).watchers.retain(|w| !w.same_channel(&tx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_core::{Core, empty_space_state};

    #[test]
    fn regression_a_stalled_workbench_holds_one_wakeup_and_drops_its_subscription() {
        let frame = Core::new(empty_space_state()).frame(vec![]);
        let feed = Arc::new(WorkbenchFrames::new(frame.clone()));
        let (stop, stopped) = flume::bounded(0);
        let (seen, received) = flume::bounded(1);
        let (release, blocked) = flume::bounded(0);
        let worker = feed.clone();
        let watch = std::thread::spawn(move || {
            worker.watch(&stopped, &mut |snapshot| {
                seen.send(snapshot["seq"].as_i64().unwrap()).unwrap();
                if snapshot["seq"] == 0 {
                    blocked.recv().unwrap();
                }
            });
        });
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), 0);
        for seq in 1..=512 {
            feed.replace_if_newer(StateFrame { seq, ..frame.clone() });
            feed.publish(false);
        }
        {
            let state = lock(&feed.0);
            assert_eq!(state.watchers[0].capacity(), Some(1));
            assert_eq!(state.watchers[0].len(), 1);
        }
        release.send(()).unwrap();
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), 512);
        drop(stop);
        watch.join().unwrap();
        assert!(lock(&feed.0).watchers.is_empty());
    }

    #[test]
    fn lazy_workbench_sync_builds_frame_on_demand_and_delivers_burst_final_seq() {
        use std::sync::mpsc;
        use vibevalley_protocol::{CallState, Fact, FactCallChanged};

        let hub = crate::Hub::new(empty_space_state());
        for n in 1..=10 {
            let fact = Fact::CallChanged(FactCallChanged {
                at: n,
                state: CallState::Idle,
                reason: format!("r{n}"),
            });
            hub.apply(vec![fact]);
        }
        assert_eq!(hub.frame().seq, 10);

        let rx = crate::Server::state(&*hub);
        let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first["seq"], 10);

        let (stop, stopped) = flume::bounded(0);
        let (tx, got) = mpsc::channel();
        let h = hub.clone();
        let t = std::thread::spawn(move || {
            crate::Server::watch_workbench(&*h, &stopped, &mut |val| {
                let _ = tx.send(val["seq"].as_i64().unwrap());
            });
        });
        assert_eq!(got.recv_timeout(Duration::from_secs(2)).unwrap(), 10);

        for n in 11..=20 {
            let fact = Fact::CallChanged(FactCallChanged {
                at: n,
                state: CallState::Idle,
                reason: format!("r{n}"),
            });
            hub.apply(vec![fact]);
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut last_seq = 10;
        while last_seq < 20 && Instant::now() < deadline {
            if let Ok(seq) = got.recv_timeout(Duration::from_millis(200)) {
                last_seq = seq;
            }
        }
        assert_eq!(last_seq, 20);
        drop(stop);
        t.join().unwrap();
    }
}
