use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore, broadcast};
use tokio_util::sync::CancellationToken;

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

struct ClientRecord {
    identity: ClientIdentity,
    inner: Weak<Mutex<Inner>>,
}

/// Serves one server to any number of views.
#[derive(Clone)]
pub struct Hub {
    server: Arc<dyn Server>,
    permits: Arc<Semaphore>,
    clients: Arc<Mutex<HashMap<u64, ClientRecord>>>,
    next_client: Arc<AtomicU64>,
}

impl Hub {
    /// Limits concurrent blocking calls to `workers` on the shared `vibevalley-io` runtime.
    pub fn new(server: Arc<dyn Server>, workers: usize) -> Hub {
        Hub {
            server,
            permits: Arc::new(Semaphore::new(workers.max(1))),
            clients: Arc::new(Mutex::new(HashMap::new())),
            next_client: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn server(&self) -> &Arc<dyn Server> {
        &self.server
    }

    /// Runs `op` on the shared runtime blocking pool with explicit caller context and hands its envelope to `reply`.
    pub fn call_with(&self, ctx: CallerContext, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static) {
        let server = self.server.clone();
        let permits = self.permits.clone();
        vibevalley_runtime::rt::handle().spawn(async move {
            let Ok(_permit) = permits.acquire_owned().await else { return };
            let _ = tokio::task::spawn_blocking(move || reply(server.call_with(&ctx, &op, payload))).await;
        });
    }

    /// Runs `op` on a worker and hands its envelope to `reply` there.
    pub fn call(&self, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static) {
        self.call_with(CallerContext::local(), op, payload, reply);
    }

    /// Attaches one view with an explicit [`ClientIdentity`] and returns its stream handle.
    pub fn attach(&self, identity: ClientIdentity, outlet: Arc<dyn Outlet>) -> Client {
        let client_key = self.next_client.fetch_add(1, Ordering::Relaxed) + 1;
        let inner = Arc::new(Mutex::new(Inner::default()));
        self.clients.lock().insert(
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
            cancel: CancellationToken::new(),
            revisions: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Snapshot of all connected clients and their active watches and subscriptions.
    pub fn clients_snapshot(&self) -> Vec<ClientSnapshot> {
        let active: Vec<(ClientIdentity, Arc<Mutex<Inner>>)> = {
            let mut clients = self.clients.lock();
            clients.retain(|_, rec| rec.inner.strong_count() > 0);
            clients
                .values()
                .filter_map(|rec| rec.inner.upgrade().map(|inner| (rec.identity.clone(), inner)))
                .collect()
        };
        let mut out = Vec::with_capacity(active.len());
        for (identity, inner) in active {
            let guard = inner.lock();
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

/// Cancels a forwarding task when dropped.
struct Pump {
    cancel: Option<CancellationToken>,
    server_sub: Option<u64>,
}

struct SliceReceipt {
    pending: AtomicU64,
    ack: Notify,
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
    cancel: CancellationToken,
    revisions: Arc<AtomicU64>,
}

fn parse_slice_topic(topic: &str) -> Option<SliceKind> {
    topic.strip_prefix("slice:").and_then(SliceKind::from_str)
}

/// Forwards every item from `rx` on the shared Tokio runtime until `cancel`
/// fires or the source closes.
fn pump_flume<T: Send + 'static>(
    rx: flume::Receiver<T>,
    cancel: CancellationToken,
    mut each: impl FnMut(T) + Send + 'static,
    ended: impl FnOnce(bool) + Send + 'static,
) {
    vibevalley_runtime::rt::handle().spawn(async move {
        let stopped = loop {
            let item = tokio::select! {
                biased;
                _ = cancel.cancelled() => break true,
                res = rx.recv_async() => match res {
                    Ok(item) => item,
                    Err(_) => break false,
                },
            };
            each(item);
        };
        ended(stopped);
    });
}

impl Client {
    pub fn identity(&self) -> &ClientIdentity {
        &self.identity
    }

    /// Starts `frame:<topic>` events for `"slice:board"`, `"slice:sessions"`,
    /// `"slice:collab"`, `"slice:inbox"`, `"slice:ops"`, `"slice:farm"`, or `"live"`.
    /// A topic watched twice keeps one stream.
    pub fn watch(&self, topic: &str) -> Result<(), String> {
        let mut inner = self.inner.lock();
        if inner.watches.contains_key(topic) {
            return Ok(());
        }
        let outlet = self.outlet.clone();
        let cancel = self.cancel.child_token();
        if let Some(slice_kind) = parse_slice_topic(topic) {
            let receipt = Arc::new(SliceReceipt {
                pending: AtomicU64::new(0),
                ack: Notify::new(),
            });
            inner.slice_receipts.insert(topic.to_string(), receipt.clone());
            let revisions = self.revisions.clone();
            let server = self.hub.server.clone();
            let event_name = format!("frame:{topic}");
            let task_cancel = cancel.clone();
            if let Some(mut sub) = server.subscribe_slice(slice_kind) {
                let slice_topic = sub.topic();
                vibevalley_runtime::rt::handle().spawn(async move {
                    let mut is_initial = true;
                    let mut seen_gen = None;
                    loop {
                        let (_seq, generation, frame) = sub.borrow_and_update(is_initial);
                        if !is_initial && seen_gen == Some(generation) {
                            let changed = tokio::select! {
                                biased;
                                _ = task_cancel.cancelled() => break,
                                ok = sub.changed() => ok,
                            };
                            if !changed {
                                break;
                            }
                            continue;
                        }
                        if let Some(gate) = server.fault_gate() {
                            if gate.should_disconnect(slice_topic) {
                                break;
                            }
                            let delay = gate.delay_ms(slice_topic);
                            if delay > 0 {
                                tokio::select! {
                                    biased;
                                    _ = task_cancel.cancelled() => break,
                                    _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                                }
                            }
                        }
                        if task_cancel.is_cancelled() {
                            break;
                        }
                        seen_gen = Some(generation);
                        is_initial = false;
                        let notified = receipt.ack.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        let rev = revisions.fetch_add(1, Ordering::Relaxed) + 1;
                        receipt.pending.store(rev, Ordering::Release);
                        outlet.send(&event_name, json!({ "rev": rev, "data": frame }));
                        tokio::select! {
                            biased;
                            _ = task_cancel.cancelled() => break,
                            _ = notified => {}
                        }
                        let changed = tokio::select! {
                            biased;
                            _ = task_cancel.cancelled() => break,
                            ok = sub.changed() => ok,
                        };
                        if !changed {
                            break;
                        }
                    }
                });
            } else {
                // Fallback for `Server` implementations without `SliceFeed` (e.g. `LateServer`).
                let (stop_tx, stop_rx) = flume::bounded::<()>(0);
                let stop_cancel = task_cancel.clone();
                vibevalley_runtime::rt::handle().spawn(async move {
                    stop_cancel.cancelled().await;
                    drop(stop_tx);
                });
                vibevalley_runtime::rt::handle().spawn_blocking(move || {
                    server.watch_slice(slice_kind, None, &stop_rx, &mut |_seq, frame| {
                        if task_cancel.is_cancelled() || stop_rx.is_disconnected() {
                            return;
                        }
                        vibevalley_runtime::rt::block_on(async {
                            let notified = receipt.ack.notified();
                            tokio::pin!(notified);
                            notified.as_mut().enable();
                            let rev = revisions.fetch_add(1, Ordering::Relaxed) + 1;
                            receipt.pending.store(rev, Ordering::Release);
                            outlet.send(&event_name, json!({ "rev": rev, "data": frame }));
                            tokio::select! {
                                biased;
                                _ = task_cancel.cancelled() => {}
                                _ = notified => {}
                            }
                        });
                    });
                });
            }
        } else if topic == "live" {
            let mut rev = 0u64;
            let task_cancel = cancel.clone();
            if let Some(mut rx) = self.hub.server.subscribe_live() {
                vibevalley_runtime::rt::handle().spawn(async move {
                    loop {
                        let event = tokio::select! {
                            biased;
                            _ = task_cancel.cancelled() => break,
                            res = rx.recv() => match res {
                                Ok(ev) => ev,
                                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(broadcast::error::RecvError::Closed) => break,
                            },
                        };
                        rev += 1;
                        let data = serde_json::to_value(event).unwrap_or(Value::Null);
                        outlet.send("frame:live", json!({ "rev": rev, "data": data }));
                    }
                });
            } else {
                pump_flume(
                    self.hub.server.live(),
                    task_cancel,
                    move |event| {
                        rev += 1;
                        let data = serde_json::to_value(event).unwrap_or(Value::Null);
                        outlet.send("frame:live", json!({ "rev": rev, "data": data }));
                    },
                    |_| {},
                );
            }
        } else {
            return Err(format!("no topic {topic}"));
        }
        inner.watches.insert(
            topic.to_string(),
            Pump {
                cancel: Some(cancel),
                server_sub: None,
            },
        );
        Ok(())
    }

    /// Acknowledges that the view applied revision `rev` for `topic` (`"slice:<kind>"`),
    /// releasing Bounded-1 backpressure for that slice stream.
    pub fn applied_slice(&self, topic: &str, rev: u64) {
        let inner = self.inner.lock();
        if rev != 0
            && let Some(receipt) = inner.slice_receipts.get(topic)
            && receipt.pending.compare_exchange(rev, 0, Ordering::AcqRel, Ordering::Acquire).is_ok()
        {
            receipt.ack.notify_one();
        }
    }

    pub fn unwatch(&self, topic: &str) {
        let mut inner = self.inner.lock();
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
        if self.inner.lock().subs.contains_key(id) {
            let e = refusal(BizCode::InvalidInput, format!("subscription {id} already exists"));
            self.outlet.send(&event_name, json!({ "end": e }));
            return;
        }
        let ctx = CallerContext {
            caller: Caller::User,
            principal: CallerPrincipal::LocalOwner,
            client: Some(self.identity.clone()),
            trace_id: 0,
        };
        match self.hub.server.subscribe_with(&ctx, name, payload) {
            Ok((server_id, rx)) => {
                let outlet = self.outlet.clone();
                let each_name = event_name.clone();
                let end_outlet = self.outlet.clone();
                let inner = Arc::downgrade(&self.inner);
                let key = id.to_string();
                let cancel = self.cancel.child_token();
                pump_flume(
                    rx,
                    cancel.clone(),
                    move |event| outlet.send(&each_name, json!({ "event": event })),
                    move |_| {
                        // Only a subscription still registered ended on the
                        // server's side; one the view stopped says nothing.
                        let Some(inner) = inner.upgrade() else { return };
                        let Some((_, mut pump)) = inner.lock().subs.remove(&key) else { return };
                        pump.server_sub = None;
                        pump.cancel = None;
                        end_outlet.send(&event_name, json!({ "end": null }));
                    },
                );
                let pump = Pump {
                    cancel: Some(cancel),
                    server_sub: Some(server_id),
                };
                self.inner.lock().subs.insert(id.to_string(), (name.to_string(), pump));
            }
            Err(envelope) => self.outlet.send(&event_name, json!({ "end": envelope })),
        }
    }

    pub fn unsubscribe(&self, id: &str) {
        let entry = self.inner.lock().subs.remove(id);
        if let Some((_, mut pump)) = entry {
            if let Some(server_id) = pump.server_sub.take() {
                self.hub.server.unsubscribe(server_id);
            }
            drop(pump);
        }
    }

    pub fn subscription_count(&self) -> usize {
        self.inner.lock().subs.len()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.hub.clients.lock().remove(&self.client_key);
        let inner = std::mem::take(&mut *self.inner.lock());
        for (_, (_, mut pump)) in inner.subs {
            if let Some(id) = pump.server_sub.take() {
                self.hub.server.unsubscribe(id);
            }
        }
    }
}

impl Drop for Pump {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
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
            self.0.lock().push((event.to_string(), data));
        }
    }

    impl Recorder {
        fn named(&self, name: &str) -> Vec<Value> {
            self.0.lock().iter().filter(|(n, _)| n == name).map(|(_, d)| d.clone()).collect()
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
