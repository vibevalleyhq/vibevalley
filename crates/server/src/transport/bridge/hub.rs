use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::lock;
use crate::transport::bridge::{BizCode, Caller, CallerContext, CallerPrincipal, ClientIdentity, Envelope, Server, SliceKind, refusal};

/// Where a view's events go (the app wires it to nsh's `HostChannel::send`).
pub trait Outlet: Send + Sync + 'static {
    fn send(&self, event: &str, data: Value);
}

/// Read-only view of one attached bridge client for DevTools Graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSnapshot {
    pub identity: ClientIdentity,
    pub watches: Vec<String>,
    pub subscriptions: Vec<String>,
}

type Job = Box<dyn FnOnce() + Send>;

struct ClientRecord {
    identity: ClientIdentity,
    inner: Weak<Mutex<Inner>>,
}

/// Serves one server to any number of views.
#[derive(Clone)]
pub struct Hub {
    server: Arc<dyn Server>,
    jobs: flume::Sender<Job>,
    clients: Arc<Mutex<HashMap<u64, ClientRecord>>>,
    next_client: Arc<AtomicU64>,
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
        Hub {
            server,
            jobs,
            clients: Arc::new(Mutex::new(HashMap::new())),
            next_client: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn server(&self) -> &Arc<dyn Server> {
        &self.server
    }

    /// Runs `op` on a worker with explicit caller context and hands its envelope to `reply` there.
    pub fn call_with(&self, ctx: CallerContext, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static) {
        let server = self.server.clone();
        let _ = self.jobs.send(Box::new(move || reply(server.call_with(&ctx, &op, payload))));
    }

    /// Runs `op` on a worker and hands its envelope to `reply` there.
    pub fn call(&self, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static) {
        self.call_with(CallerContext::local(), op, payload, reply);
    }

    /// Attaches one view with an explicit [`ClientIdentity`] and returns its stream handle.
    pub fn attach(&self, identity: ClientIdentity, outlet: Arc<dyn Outlet>) -> Client {
        let client_key = self.next_client.fetch_add(1, Ordering::Relaxed) + 1;
        let inner = Arc::new(Mutex::new(Inner::default()));
        lock(&self.clients).insert(
            client_key,
            ClientRecord {
                identity: identity.clone(),
                inner: Arc::downgrade(&inner),
            },
        );
        Client {
            hub: self.clone(),
            client_key,
            identity,
            outlet,
            inner,
            revisions: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Snapshot of all connected clients and their active watches and subscriptions.
    pub fn clients_snapshot(&self) -> Vec<ClientSnapshot> {
        let active: Vec<(ClientIdentity, Arc<Mutex<Inner>>)> = {
            let mut clients = lock(&self.clients);
            clients.retain(|_, rec| rec.inner.strong_count() > 0);
            clients
                .values()
                .filter_map(|rec| rec.inner.upgrade().map(|inner| (rec.identity.clone(), inner)))
                .collect()
        };
        let mut out = Vec::with_capacity(active.len());
        for (identity, inner) in active {
            let guard = lock(&inner);
            let mut watches: Vec<String> = guard.watches.keys().cloned().collect();
            watches.sort();
            let mut subscriptions: Vec<String> = guard.subs.values().map(|(name, _)| name.clone()).collect();
            subscriptions.sort();
            out.push(ClientSnapshot {
                identity,
                watches,
                subscriptions,
            });
        }
        out.sort_by(|a, b| a.identity.id.cmp(&b.identity.id));
        out
    }
}

/// Stops a forwarding thread when dropped.
struct Pump {
    stop: Option<flume::Sender<()>>,
    server_sub: Option<u64>,
}

struct SliceReceipt {
    pending: AtomicU64,
    received: flume::Sender<()>,
}

#[derive(Default)]
struct Inner {
    slice_receipts: HashMap<String, Arc<SliceReceipt>>,
    watches: HashMap<String, Pump>,
    subs: HashMap<String, (String, Pump)>,
}

/// One view's watches and subscriptions; dropping it stops them all.
pub struct Client {
    hub: Hub,
    client_key: u64,
    identity: ClientIdentity,
    outlet: Arc<dyn Outlet>,
    inner: Arc<Mutex<Inner>>,
    revisions: Arc<AtomicU64>,
}

fn parse_slice_topic(topic: &str) -> Option<SliceKind> {
    topic.strip_prefix("slice:").and_then(SliceKind::from_str)
}

/// Forwards every event until the subscriber stops or the source closes.
fn pump<T: Send + 'static>(rx: flume::Receiver<T>, mut each: impl FnMut(T) + Send + 'static, ended: impl FnOnce(bool) + Send + 'static) -> flume::Sender<()> {
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
            let item = match step {
                Step::Item(item) => item,
                Step::Ended => break false,
                Step::Stopped => break true,
            };
            each(item);
        };
        ended(stopped);
    });
    stop_tx
}

impl Client {
    pub fn identity(&self) -> &ClientIdentity {
        &self.identity
    }

    /// Starts `frame:<topic>` events for `"slice:board"`, `"slice:sessions"`,
    /// `"slice:collab"`, `"slice:inbox"`, `"slice:ops"`, `"slice:farm"`, or `"live"`.
    /// A topic watched twice keeps one stream.
    pub fn watch(&self, topic: &str) -> Result<(), String> {
        let mut inner = lock(&self.inner);
        if inner.watches.contains_key(topic) {
            return Ok(());
        }
        let outlet = self.outlet.clone();
        let stop = if let Some(slice_kind) = parse_slice_topic(topic) {
            let (stop, stopped) = flume::bounded(0);
            let (received, ack) = flume::bounded(1);
            let receipt = Arc::new(SliceReceipt {
                pending: AtomicU64::new(0),
                received,
            });
            inner.slice_receipts.insert(topic.to_string(), receipt.clone());
            let revisions = self.revisions.clone();
            let server = self.hub.server.clone();
            let event_name = format!("frame:{topic}");
            std::thread::spawn(move || {
                server.watch_slice(slice_kind, None, &stopped, &mut |_seq, frame| {
                    if stopped.is_disconnected() {
                        return;
                    }
                    let rev = revisions.fetch_add(1, Ordering::Relaxed) + 1;
                    receipt.pending.store(rev, Ordering::Release);
                    outlet.send(&event_name, json!({ "rev": rev, "data": frame }));
                    flume::Selector::new().recv(&stopped, |_| ()).recv(&ack, |_| ()).wait();
                });
            });
            stop
        } else if topic == "live" {
            let mut rev = 0u64;
            pump(
                self.hub.server.live(),
                move |event| {
                    rev += 1;
                    let data = serde_json::to_value(event).unwrap_or(Value::Null);
                    outlet.send("frame:live", json!({ "rev": rev, "data": data }));
                },
                |_| {},
            )
        } else {
            return Err(format!("no topic {topic}"));
        };
        inner.watches.insert(
            topic.to_string(),
            Pump {
                stop: Some(stop),
                server_sub: None,
            },
        );
        Ok(())
    }

    /// Acknowledges that the view applied revision `rev` for `topic` (`"slice:<kind>"`),
    /// releasing Bounded-1 backpressure for that slice stream.
    pub fn applied_slice(&self, topic: &str, rev: u64) {
        let inner = lock(&self.inner);
        if rev != 0
            && let Some(receipt) = inner.slice_receipts.get(topic)
            && receipt.pending.compare_exchange(rev, 0, Ordering::AcqRel, Ordering::Acquire).is_ok()
        {
            let _ = receipt.received.try_send(());
        }
    }

    pub fn unwatch(&self, topic: &str) {
        let mut inner = lock(&self.inner);
        inner.watches.remove(topic);
        inner.slice_receipts.remove(topic);
    }

    /// Runs a call for this view with its [`ClientIdentity`]: the envelope comes back as `reply:<id>`.
    pub fn call(&self, id: &str, op: String, payload: Value) {
        let outlet = self.outlet.clone();
        let event = format!("reply:{id}");
        let ctx = CallerContext {
            caller: Caller::User,
            principal: CallerPrincipal::LocalOwner,
            client: Some(self.identity.clone()),
            trace_id: 0,
        };
        self.hub.call_with(ctx, op, payload, move |envelope| {
            outlet.send(&event, serde_json::to_value(envelope).unwrap_or(Value::Null));
        });
    }

    /// Starts subscription `id` (the view's own id): events `sub:<id>`
    /// carrying `{ event }`, then once `{ end: null }`, or `{ end: <envelope> }`
    /// for a refusal.
    pub fn subscribe(&self, id: &str, name: &str, payload: Value) {
        let event_name = format!("sub:{id}");
        if lock(&self.inner).subs.contains_key(id) {
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
                    move |event| outlet.send(&each_name, json!({ "event": event })),
                    move |_| {
                        // Only a subscription still registered ended on the
                        // server's side; one the view stopped says nothing.
                        let Some(inner) = inner.upgrade() else { return };
                        let Some((_, mut pump)) = lock(&inner).subs.remove(&key) else { return };
                        pump.server_sub = None;
                        pump.stop = None;
                        end_outlet.send(&event_name, json!({ "end": null }));
                    },
                );
                let pump = Pump {
                    stop: Some(stop),
                    server_sub: Some(server_id),
                };
                lock(&self.inner).subs.insert(id.to_string(), (name.to_string(), pump));
            }
            Err(envelope) => self.outlet.send(&event_name, json!({ "end": envelope })),
        }
    }

    pub fn unsubscribe(&self, id: &str) {
        let entry = lock(&self.inner).subs.remove(id);
        if let Some((_, mut pump)) = entry {
            if let Some(server_id) = pump.server_sub.take() {
                self.hub.server.unsubscribe(server_id);
            }
            drop(pump);
        }
    }

    pub fn subscription_count(&self) -> usize {
        lock(&self.inner).subs.len()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        lock(&self.hub.clients).remove(&self.client_key);
        let inner = std::mem::take(&mut *lock(&self.inner));
        for (_, (_, mut pump)) in inner.subs {
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
    use crate::transport::bridge::ClientKind;
    use crate::transport::bridge::fake::{FakeServer, empty_bundle};
    use vibevalley_protocol::{Issue, LiveEvent};

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

    fn test_identity(id: &str) -> ClientIdentity {
        ClientIdentity {
            id: id.into(),
            kind: ClientKind::GpuiWorkbench,
            label: format!("test-{id}"),
        }
    }

    fn setup() -> (Arc<FakeServer>, Hub, Arc<Recorder>, Client) {
        let fake = Arc::new(FakeServer::new());
        let hub = Hub::new(fake.clone(), 2);
        let rec = Arc::new(Recorder::default());
        let client = hub.attach(test_identity("c1"), rec.clone());
        (fake, hub, rec, client)
    }

    #[test]
    fn calls_reply_by_id_and_forward_client_identity() {
        let (fake, _hub, rec, client) = setup();
        client.call("1", "health".into(), Value::Null);
        client.call("2", "no.such.op".into(), json!({}));
        wait_for("replies", || rec.named("reply:1").len() == 1 && rec.named("reply:2").len() == 1);
        assert_eq!(rec.named("reply:1")[0]["bizCode"], 0);
        assert_eq!(rec.named("reply:2")[0]["bizCode"], 100005);
        assert_eq!(fake.calls().len(), 2);
        assert_eq!(fake.last_client().as_ref().map(|c| c.id.as_str()), Some("c1"));
    }

    #[test]
    fn slices_start_with_current_snapshot_follow_ack_and_reject_legacy_state_topic() {
        let (fake, hub, rec, client) = setup();
        assert!(client.watch("state").is_err(), "legacy state topic must be rejected");
        client.watch("slice:board").unwrap();
        client.watch("slice:board").unwrap();
        wait_for("first board slice", || rec.named("frame:slice:board").len() == 1);
        let snap = hub.clients_snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].identity.id, "c1");
        assert_eq!(snap[0].watches, vec!["slice:board"]);

        client.applied_slice("slice:board", 1);
        let mut next = empty_bundle(1);
        next.board.issues.push(Issue::new("i1", 1, "Added", 1));
        fake.swap_bundle(next);
        wait_for("second board slice", || rec.named("frame:slice:board").len() >= 2);
        let frames = rec.named("frame:slice:board");
        assert_eq!(frames.last().unwrap()["data"]["issues"][0]["id"], "i1");
        assert_eq!(frames.last().unwrap()["data"]["seq"], 1);
        client.unwatch("slice:board");
        wait_for("watcher gone", || fake.slice_watchers(SliceKind::Board) == 0);
    }

    #[test]
    fn live_events_each_arrive() {
        let (fake, _hub, rec, client) = setup();
        client.watch("live").unwrap();
        wait_for("live watcher", || fake.live_watchers() == 1);
        for text in ["a", "b"] {
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
        let (fake, hub, rec, client) = setup();
        client.subscribe("s1", "channel.follow", json!({ "id": "c", "after": 0 }));
        client.subscribe("s2", "channel.follow", json!({ "id": "c", "after": 0 }));
        assert_eq!(client.subscription_count(), 2);
        assert_eq!(hub.clients_snapshot()[0].subscriptions, vec!["channel.follow", "channel.follow"]);
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
    fn dropping_the_client_unsubscribes_and_removes_from_snapshot() {
        let (fake, hub, _rec, client) = setup();
        client.subscribe("s", "x", json!({}));
        assert_eq!(fake.subscriber_count(), 1);
        assert_eq!(hub.clients_snapshot().len(), 1);
        drop(client);
        assert_eq!(fake.subscriber_count(), 0);
        assert!(hub.clients_snapshot().is_empty());
    }
}
