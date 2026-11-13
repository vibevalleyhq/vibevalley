use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::{BizCode, Envelope, Server, refusal};

/// Where a view's events go (the app wires it to nsh's `HostChannel::send`).
pub trait Outlet: Send + Sync + 'static {
    fn send(&self, event: &str, data: Value);
}

type Job = Box<dyn FnOnce() + Send>;

/// Serves one server to any number of views.
#[derive(Clone)]
pub struct Hub {
    server: Arc<dyn Server>,
    jobs: flume::Sender<Job>,
}

impl Hub {
    /// `workers` threads run blocking calls.
    pub fn new(server: Arc<dyn Server>, workers: usize) -> Hub {
        let (jobs, rx) = flume::unbounded::<Job>();
        for i in 0..workers.max(1) {
            let rx = rx.clone();
            std::thread::Builder::new()
                .name(format!("bridge-{i}"))
                .spawn(move || {
                    while let Ok(job) = rx.recv() {
                        job();
                    }
                })
                .expect("bridge worker thread");
        }
        Hub { server, jobs }
    }

    pub fn server(&self) -> &Arc<dyn Server> {
        &self.server
    }

    /// Runs `op` on a worker and hands its envelope to `reply` there.
    pub fn call(&self, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static) {
        let server = self.server.clone();
        let _ = self.jobs.send(Box::new(move || reply(server.call(&op, payload))));
    }

    /// One view's streams.
    pub fn attach(&self, outlet: Arc<dyn Outlet>) -> Client {
        Client {
            hub: self.clone(),
            outlet,
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }
}

/// Stops a forwarding thread when dropped.
struct Pump {
    stop: Option<flume::Sender<()>>,
    server_sub: Option<u64>,
}

#[derive(Default)]
struct Inner {
    watches: HashMap<String, Pump>,
    subs: HashMap<String, Pump>,
}

/// One view's watches and subscriptions; dropping it stops them all.
pub struct Client {
    hub: Hub,
    outlet: Arc<dyn Outlet>,
    inner: Arc<Mutex<Inner>>,
}

/// Forwards `rx` until it disconnects or `stop` fires. `each` gets every
/// item; with `latest`, items already queued are skipped for the newest.
fn pump<T: Send + 'static>(
    rx: flume::Receiver<T>,
    latest: bool,
    mut each: impl FnMut(T) + Send + 'static,
    ended: impl FnOnce(bool) + Send + 'static,
) -> flume::Sender<()> {
    let (stop_tx, stop_rx) = flume::bounded::<()>(1);
    std::thread::spawn(move || {
        enum Step<T> {
            Item(T),
            Ended,
            Stopped,
        }
        let stopped = loop {
            let step = flume::Selector::new()
                .recv(&rx, |r| r.map_or(Step::Ended, Step::Item))
                .recv(&stop_rx, |_| Step::Stopped)
                .wait();
            let mut item = match step {
                Step::Item(item) => item,
                Step::Ended => break false,
                Step::Stopped => break true,
            };
            if latest {
                while let Ok(newer) = rx.try_recv() {
                    item = newer;
                }
            }
            each(item);
        };
        ended(stopped);
    });
    stop_tx
}

impl Client {
    /// Starts `frame:<topic>` events for `"state"` or `"live"`. A topic
    /// watched twice keeps one stream.
    pub fn watch(&self, topic: &str) -> Result<(), String> {
        if self.inner.lock().unwrap().watches.contains_key(topic) {
            return Ok(());
        }
        let outlet = self.outlet.clone();
        let mut rev = 0u64;
        let stop = match topic {
            "state" => pump(
                self.hub.server.state(),
                true,
                move |frame| {
                    rev += 1;
                    outlet.send("frame:state", json!({ "rev": rev, "data": frame }));
                },
                |_| {},
            ),
            "live" => pump(
                self.hub.server.live(),
                false,
                move |event| {
                    rev += 1;
                    let data = serde_json::to_value(event).unwrap_or(Value::Null);
                    outlet.send("frame:live", json!({ "rev": rev, "data": data }));
                },
                |_| {},
            ),
            other => return Err(format!("no topic {other}")),
        };
        self.inner.lock().unwrap().watches.insert(
            topic.to_string(),
            Pump {
                stop: Some(stop),
                server_sub: None,
            },
        );
        Ok(())
    }

    pub fn unwatch(&self, topic: &str) {
        let pump = self.inner.lock().unwrap().watches.remove(topic);
        drop(pump);
    }

    /// Runs a call for this view: the envelope comes back as `reply:<id>`.
    pub fn call(&self, id: &str, op: String, payload: Value) {
        let outlet = self.outlet.clone();
        let event = format!("reply:{id}");
        self.hub.call(op, payload, move |envelope| {
            outlet.send(&event, serde_json::to_value(envelope).unwrap_or(Value::Null));
        });
    }

    /// Starts subscription `id` (the view's own id): events `sub:<id>`
    /// carrying `{ event }`, then once `{ end: null }`, or `{ end: <envelope> }`
    /// for a refusal.
    pub fn subscribe(&self, id: &str, name: &str, payload: Value) {
        let event_name = format!("sub:{id}");
        if self.inner.lock().unwrap().subs.contains_key(id) {
            let e = refusal(BizCode::InvalidInput, format!("subscription {id} already exists"));
            self.outlet.send(&event_name, json!({ "end": e }));
            return;
        }
        match self.hub.server.subscribe(name, payload) {
            Ok((server_id, rx)) => {
                let outlet = self.outlet.clone();
                let each_name = event_name.clone();
                let end_outlet = self.outlet.clone();
                let inner = Arc::downgrade(&self.inner);
                let key = id.to_string();
                let stop = pump(
                    rx,
                    false,
                    move |event| outlet.send(&each_name, json!({ "event": event })),
                    move |_| {
                        // Only a subscription still registered ended on the
                        // server's side; one the view stopped says nothing.
                        let Some(inner) = inner.upgrade() else { return };
                        let Some(mut pump) = inner.lock().unwrap().subs.remove(&key) else { return };
                        pump.server_sub = None;
                        pump.stop = None;
                        end_outlet.send(&event_name, json!({ "end": null }));
                    },
                );
                let pump = Pump {
                    stop: Some(stop),
                    server_sub: Some(server_id),
                };
                self.inner.lock().unwrap().subs.insert(id.to_string(), pump);
            }
            Err(envelope) => self.outlet.send(&event_name, json!({ "end": envelope })),
        }
    }

    pub fn unsubscribe(&self, id: &str) {
        let pump = self.inner.lock().unwrap().subs.remove(id);
        if let Some(mut pump) = pump {
            if let Some(server_id) = pump.server_sub.take() {
                self.hub.server.unsubscribe(server_id);
            }
            drop(pump);
        }
    }

    pub fn subscription_count(&self) -> usize {
        self.inner.lock().unwrap().subs.len()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let inner = std::mem::take(&mut *self.inner.lock().unwrap());
        for (_, mut pump) in inner.subs {
            if let Some(id) = pump.server_sub.take() {
                self.hub.server.unsubscribe(id);
            }
        }
    }
}

impl Drop for Pump {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.try_send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::fake::FakeServer;
    use vibevalley_protocol::LiveEvent;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, Value)>>);

    impl Outlet for Recorder {
        fn send(&self, event: &str, data: Value) {
            self.0.lock().unwrap().push((event.to_string(), data));
        }
    }

    impl Recorder {
        fn named(&self, name: &str) -> Vec<Value> {
            self.0.lock().unwrap().iter().filter(|(n, _)| n == name).map(|(_, d)| d.clone()).collect()
        }
    }

    fn wait_for(what: &str, f: impl Fn() -> bool) {
        let start = Instant::now();
        while !f() {
            assert!(start.elapsed() < Duration::from_secs(3), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn setup() -> (Arc<FakeServer>, Arc<Recorder>, Client) {
        let fake = Arc::new(FakeServer::new());
        let hub = Hub::new(fake.clone(), 2);
        let rec = Arc::new(Recorder::default());
        let client = hub.attach(rec.clone());
        (fake, rec, client)
    }

    #[test]
    fn calls_reply_by_id() {
        let (fake, rec, client) = setup();
        client.call("1", "health".into(), Value::Null);
        client.call("2", "no.such.op".into(), json!({}));
        wait_for("replies", || rec.named("reply:1").len() == 1 && rec.named("reply:2").len() == 1);
        assert_eq!(rec.named("reply:1")[0]["bizCode"], 0);
        assert_eq!(rec.named("reply:2")[0]["bizCode"], 100005);
        assert_eq!(fake.calls().len(), 2);
    }

    #[test]
    fn state_starts_with_the_current_frame_and_follows() {
        let (fake, rec, client) = setup();
        client.watch("state").unwrap();
        client.watch("state").unwrap();
        wait_for("first frame", || rec.named("frame:state").len() == 1);
        fake.set_state(json!({ "issues": 1 }));
        wait_for("second frame", || rec.named("frame:state").len() >= 2);
        let frames = rec.named("frame:state");
        assert_eq!(frames.last().unwrap()["data"]["issues"], 1);
        assert_eq!(frames.last().unwrap()["data"]["seq"], 1);
        client.unwatch("state");
        wait_for("watcher gone", || fake.set_state(json!({})) == 0);
    }

    #[test]
    fn live_events_each_arrive() {
        let (fake, rec, client) = setup();
        client.watch("live").unwrap();
        wait_for("live watcher", || fake.live_watchers() == 1);
        for text in ["a", "b"] {
            // Built from the wire JSON so the test follows the generated types' layout.
            let event: LiveEvent = serde_json::from_value(json!({ "type": "notice", "at": 1, "level": "info", "text": text })).unwrap();
            fake.push_live(event);
        }
        wait_for("two events", || rec.named("frame:live").len() == 2);
        let live = rec.named("frame:live");
        assert_eq!(live[1]["data"]["text"], "b");
        assert_eq!(live[1]["data"]["type"], "notice");
        assert_eq!(live[1]["rev"], 2);
        assert!(client.watch("nope").is_err());
    }

    #[test]
    fn subscriptions_stream_end_and_stop() {
        let (fake, rec, client) = setup();
        client.subscribe("s1", "channel.follow", json!({ "id": "c", "after": 0 }));
        client.subscribe("s2", "channel.follow", json!({ "id": "c", "after": 0 }));
        assert_eq!(client.subscription_count(), 2);
        fake.emit("channel.follow", json!({ "n": 1 }));
        wait_for("events", || rec.named("sub:s1").len() == 1 && rec.named("sub:s2").len() == 1);
        assert_eq!(rec.named("sub:s1")[0], json!({ "event": { "n": 1 } }));
        client.unsubscribe("s2");
        assert_eq!(fake.subscriber_count(), 1);
        fake.emit("channel.follow", json!({ "n": 2 }));
        fake.end("channel.follow");
        wait_for("end", || rec.named("sub:s1").last() == Some(&json!({ "end": null })));
        assert_eq!(rec.named("sub:s1").len(), 3);
        assert_eq!(rec.named("sub:s2").len(), 1, "no end event after unsubscribe");
        wait_for("bookkeeping", || client.subscription_count() == 0);
        client.subscribe("s3", "fake.refuse", json!({}));
        assert_eq!(rec.named("sub:s3")[0]["end"]["bizCode"], 500001);
    }

    #[test]
    fn dropping_the_client_unsubscribes() {
        let (fake, _rec, client) = setup();
        client.subscribe("s", "x", json!({}));
        assert_eq!(fake.subscriber_count(), 1);
        drop(client);
        assert_eq!(fake.subscriber_count(), 0);
    }
}
