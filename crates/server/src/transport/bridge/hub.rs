use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore, broadcast};
use tokio_util::sync::{CancellationToken, DropGuard};

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

    /// Runs `op` on the shared runtime with explicit caller context and hands its envelope to `reply`.
    pub fn call_with(&self, ctx: CallerContext, op: String, payload: Value, reply: impl FnOnce(Envelope) + Send + 'static) {
        let server = self.server.clone();
        let permits = self.permits.clone();
        vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
            let Ok(_permit) = permits.acquire_owned().await else { return };
            let envelope = server.call_with_async(ctx, op, payload).await;
            reply(envelope);
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
    _cancel_guard: DropGuard,
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

/// Forwards every item from `rx` until `cancel` fires or the source closes.
async fn pump_flume_async<T: Send + 'static>(
    rx: flume::Receiver<T>,
    cancel: CancellationToken,
    mut each: impl FnMut(T) + Send + 'static,
    ended: impl FnOnce(bool) + Send + 'static,
) {
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
}

/// Runs `start` immediately when `server` is ready, or awaits `ready_async()`
/// first on the Tokio runtime (stopping early if `cancel` fires).
fn spawn_when_ready<F, Fut>(server: Arc<dyn Server>, cancel: CancellationToken, start: F)
where
    F: FnOnce(Arc<dyn Server>, CancellationToken) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let handle = vibevalley_runtime::rt::current_or_global_handle();
    if let Some(ready) = server.ready_async() {
        handle.spawn(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                _ = ready => {}
            }
            if cancel.is_cancelled() {
                return;
            }
            start(server, cancel).await;
        });
    } else {
        handle.spawn(start(server, cancel));
    }
}

async fn pump_slice_subscription(
    server: Arc<dyn Server>,
    mut sub: crate::slice_feed::SliceSubscription,
    receipt: Arc<SliceReceipt>,
    revisions: Arc<AtomicU64>,
    outlet: Arc<dyn Outlet>,
    event_name: String,
    task_cancel: CancellationToken,
) {
    let slice_topic = sub.topic();
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
}

/// Fallback for `Server` implementations without `SliceFeed` (e.g. custom test doubles).
fn spawn_slice_blocking_fallback(
    server: Arc<dyn Server>,
    slice_kind: SliceKind,
    receipt: Arc<SliceReceipt>,
    revisions: Arc<AtomicU64>,
    outlet: Arc<dyn Outlet>,
    event_name: String,
    task_cancel: CancellationToken,
) {
    let handle = vibevalley_runtime::rt::current_or_global_handle();
    let (stop_tx, stop_rx) = flume::bounded::<()>(0);
    let stop_cancel = task_cancel.clone();
    handle.spawn(async move {
        stop_cancel.cancelled().await;
        drop(stop_tx);
    });
    handle.spawn_blocking(move || {
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

async fn pump_live_broadcast(mut rx: broadcast::Receiver<crate::transport::bridge::LiveEvent>, outlet: Arc<dyn Outlet>, task_cancel: CancellationToken) {
    let mut rev = 0u64;
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
            spawn_when_ready(server, cancel.clone(), move |server, task_cancel| async move {
                if let Some(sub) = server.subscribe_slice(slice_kind) {
                    pump_slice_subscription(server, sub, receipt, revisions, outlet, event_name, task_cancel).await;
                } else {
                    spawn_slice_blocking_fallback(server, slice_kind, receipt, revisions, outlet, event_name, task_cancel);
                }
            });
        } else if topic == "live" {
            let server = self.hub.server.clone();
            spawn_when_ready(server, cancel.clone(), move |server, task_cancel| async move {
                if let Some(rx) = server.subscribe_live() {
                    pump_live_broadcast(rx, outlet, task_cancel).await;
                } else {
                    let mut rev = 0u64;
                    pump_flume_async(
                        server.live(),
                        task_cancel,
                        move |event| {
                            rev += 1;
                            let data = serde_json::to_value(event).unwrap_or(Value::Null);
                            outlet.send("frame:live", json!({ "rev": rev, "data": data }));
                        },
                        |_| {},
                    )
                    .await;
                }
            });
        } else {
            return Err(format!("no topic {topic}"));
        }
        inner.watches.insert(
            topic.to_string(),
            Pump {
                _cancel_guard: cancel.drop_guard(),
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
    /// for a refusal. Dispatches asynchronously on the Tokio runtime so the
    /// caller thread (e.g. the nsh JS engine) never blocks.
    pub fn subscribe(&self, id: &str, name: &str, payload: Value) {
        let event_name = format!("sub:{id}");
        let cancel = {
            let mut inner = self.inner.lock();
            if inner.subs.contains_key(id) {
                drop(inner);
                let e = refusal(BizCode::InvalidInput, format!("subscription {id} already exists"));
                self.outlet.send(&event_name, json!({ "end": e }));
                return;
            }
            let cancel = self.cancel.child_token();
            let pump = Pump {
                _cancel_guard: cancel.clone().drop_guard(),
                server_sub: None,
            };
            inner.subs.insert(id.to_string(), (name.to_string(), pump));
            cancel
        };
        let ctx = CallerContext {
            caller: Caller::User,
            principal: CallerPrincipal::LocalOwner,
            client: Some(self.identity.clone()),
            trace_id: 0,
        };
        let server = self.hub.server.clone();
        let outlet = self.outlet.clone();
        let inner = Arc::downgrade(&self.inner);
        let key = id.to_string();
        let sub_name = name.to_string();
        vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
            if cancel.is_cancelled() {
                return;
            }
            // Await `subscribe_with_async` to completion rather than cancelling it via `select!`:
            // dropping the future mid-call would leak the server-side subscription handle.
            let opened = server.clone().subscribe_with_async(ctx, sub_name, payload).await;
            match opened {
                Ok((server_id, rx)) => {
                    let registered = if let Some(inner_arc) = inner.upgrade() {
                        let mut guard = inner_arc.lock();
                        if cancel.is_cancelled() {
                            false
                        } else if let Some((_, pump)) = guard.subs.get_mut(&key) {
                            pump.server_sub = Some(server_id);
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if !registered {
                        server.unsubscribe(server_id);
                        return;
                    }
                    let each_outlet = outlet.clone();
                    let each_name = event_name.clone();
                    pump_flume_async(
                        rx,
                        cancel,
                        move |event| each_outlet.send(&each_name, json!({ "event": event })),
                        move |_| {
                            // Only a subscription still registered ended on the
                            // server's side; one the view stopped says nothing.
                            let Some(inner) = inner.upgrade() else { return };
                            let Some((_, mut pump)) = inner.lock().subs.remove(&key) else { return };
                            pump.server_sub = None;
                            outlet.send(&event_name, json!({ "end": null }));
                        },
                    )
                    .await;
                }
                Err(envelope) => {
                    if let Some(inner) = inner.upgrade() {
                        let removed = inner.lock().subs.remove(&key);
                        if removed.is_some() && !cancel.is_cancelled() {
                            outlet.send(&event_name, json!({ "end": envelope }));
                        }
                    }
                }
            }
        });
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::transport::bridge::ClientKind;
    use crate::transport::bridge::fake::{FakeServer, empty_bundle};
    use vibevalley_protocol::{Issue, LiveEvent};

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<(String, Value)>>,
        notify: Notify,
    }

    impl Outlet for Recorder {
        fn send(&self, event: &str, data: Value) {
            self.events.lock().push((event.to_string(), data));
            self.notify.notify_waiters();
        }
    }

    impl Recorder {
        fn named(&self, name: &str) -> Vec<Value> {
            self.events.lock().iter().filter(|(n, _)| n == name).map(|(_, d)| d.clone()).collect()
        }

        fn wait_for(&self, what: &str, mut f: impl FnMut(&Self) -> bool) {
            vibevalley_runtime::rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let notified = self.notify.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if f(self) {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
        }
    }

    struct SignaledFake {
        inner: Arc<FakeServer>,
        on_subscribe: Notify,
        on_live: Notify,
    }

    impl SignaledFake {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                inner: Arc::new(FakeServer::new()),
                on_subscribe: Notify::new(),
                on_live: Notify::new(),
            })
        }

        fn wait_subscribers(&self, what: &str, expected: usize) {
            vibevalley_runtime::rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let notified = self.on_subscribe.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if self.inner.subscriber_count() == expected {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
        }

        fn wait_live_watcher(&self, what: &str) {
            vibevalley_runtime::rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let notified = self.on_live.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if self.inner.live_watchers() == 1 {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
        }
    }

    impl Server for SignaledFake {
        fn call(&self, op: &str, payload: Value) -> Envelope {
            self.inner.call(op, payload)
        }
        fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
            self.inner.call_with(ctx, op, payload)
        }
        fn slice_snapshot(&self, slice: SliceKind) -> Value {
            self.inner.slice_snapshot(slice)
        }
        fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
            self.inner.watch_slice(slice, after_seq, stop, receive)
        }
        fn subscribe_slice(&self, slice: SliceKind) -> Option<crate::slice_feed::SliceSubscription> {
            self.inner.subscribe_slice(slice)
        }
        fn live(&self) -> flume::Receiver<vibevalley_protocol::LiveEvent> {
            let rx = self.inner.live();
            self.on_live.notify_waiters();
            rx
        }
        fn subscribe_live(&self) -> Option<broadcast::Receiver<vibevalley_protocol::LiveEvent>> {
            let rx = self.inner.subscribe_live();
            self.on_live.notify_waiters();
            rx
        }
        fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
            let res = self.inner.subscribe(name, payload);
            self.on_subscribe.notify_waiters();
            res
        }
        fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
            let res = self.inner.subscribe_with(ctx, name, payload);
            self.on_subscribe.notify_waiters();
            res
        }
        fn unsubscribe(&self, id: u64) {
            self.inner.unsubscribe(id);
            self.on_subscribe.notify_waiters();
        }
    }

    fn wait_task_cleanup(what: &str, mut f: impl FnMut() -> bool) {
        vibevalley_runtime::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut yields = 0usize;
                while !f() {
                    if yields < 64 {
                        yields += 1;
                        tokio::task::yield_now().await;
                    } else {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
            })
            .await
        })
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
    }

    fn test_identity(id: &str) -> ClientIdentity {
        ClientIdentity {
            id: id.into(),
            kind: ClientKind::GpuiWorkbench,
            label: format!("test-{id}"),
        }
    }

    fn setup() -> (Arc<SignaledFake>, Hub, Arc<Recorder>, Client) {
        let fake = SignaledFake::new();
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
        rec.wait_for("replies", |r| r.named("reply:1").len() == 1 && r.named("reply:2").len() == 1);
        assert_eq!(rec.named("reply:1")[0]["bizCode"], 0);
        assert_eq!(rec.named("reply:2")[0]["bizCode"], 100005);
        assert_eq!(fake.inner.calls().len(), 2);
        assert_eq!(fake.inner.last_client().as_ref().map(|c| c.id.as_str()), Some("c1"));
    }

    #[test]
    fn slices_start_with_current_snapshot_follow_ack_and_reject_legacy_state_topic() {
        let (fake, hub, rec, client) = setup();
        assert!(client.watch("state").is_err(), "legacy state topic must be rejected");
        client.watch("slice:board").unwrap();
        client.watch("slice:board").unwrap();
        rec.wait_for("first board slice", |r| r.named("frame:slice:board").len() == 1);
        let snap = hub.clients_snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].identity.id, "c1");
        assert_eq!(snap[0].watches, vec!["slice:board"]);

        client.applied_slice("slice:board", 1);
        let mut next = empty_bundle(1);
        next.board.issues.push(Issue::new("i1", 1, "Added", 1));
        fake.inner.swap_bundle(next);
        rec.wait_for("second board slice", |r| r.named("frame:slice:board").len() >= 2);
        let frames = rec.named("frame:slice:board");
        assert_eq!(frames.last().unwrap()["data"]["issues"][0]["id"], "i1");
        assert_eq!(frames.last().unwrap()["data"]["seq"], 1);
        client.unwatch("slice:board");
        wait_task_cleanup("watcher gone", || fake.inner.slice_watchers(SliceKind::Board) == 0);
    }

    #[test]
    fn live_events_each_arrive() {
        let (fake, _hub, rec, client) = setup();
        client.watch("live").unwrap();
        fake.wait_live_watcher("live watcher");
        for text in ["a", "b"] {
            let event: LiveEvent = serde_json::from_value(json!({ "type": "notice", "at": 1, "level": "info", "text": text })).unwrap();
            fake.inner.push_live(event);
        }
        rec.wait_for("two events", |r| r.named("frame:live").len() == 2);
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
        fake.wait_subscribers("subscribers registered", 2);
        fake.inner.emit("channel.follow", json!({ "n": 1 }));
        rec.wait_for("events", |r| r.named("sub:s1").len() == 1 && r.named("sub:s2").len() == 1);
        assert_eq!(rec.named("sub:s1")[0], json!({ "event": { "n": 1 } }));
        client.unsubscribe("s2");
        fake.wait_subscribers("unsubscribed s2", 1);
        fake.inner.emit("channel.follow", json!({ "n": 2 }));
        fake.inner.end("channel.follow");
        rec.wait_for("end", |r| r.named("sub:s1").last() == Some(&json!({ "end": null })));
        assert_eq!(rec.named("sub:s1").len(), 3);
        assert_eq!(rec.named("sub:s2").len(), 1, "no end event after unsubscribe");
        wait_task_cleanup("bookkeeping", || client.subscription_count() == 0);
        client.subscribe("s3", "fake.refuse", json!({}));
        rec.wait_for("refusal", |r| r.named("sub:s3").len() == 1);
        assert_eq!(rec.named("sub:s3")[0]["end"]["bizCode"], 500001);
        wait_task_cleanup("refusal cleanup", || client.subscription_count() == 0);
    }

    #[test]
    fn dropping_the_client_unsubscribes_and_removes_from_snapshot() {
        let (fake, hub, _rec, client) = setup();
        client.subscribe("s", "x", json!({}));
        fake.wait_subscribers("subscriber registered", 1);
        assert_eq!(hub.clients_snapshot().len(), 1);
        drop(client);
        fake.wait_subscribers("unsubscribed on drop", 0);
        assert!(hub.clients_snapshot().is_empty());
    }
}
