//! The real server, started off the UI thread: the bridge needs a server at
//! launch, and `vibevalley_server::create_app` boots off the UI thread (files,
//! runtime probes). Until it is up, async slice and live subscribers await
//! [`Server::ready_async`] on the shared Tokio runtime before entering the
//! zero-thread `WatchStream` / `broadcast::Receiver` fast paths.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{broadcast, watch};
use vibevalley_server::SliceSubscription;
use vibevalley_server::gateway::api::{BoxFuture, GatewayPorts, refusal};
use vibevalley_server::gateway::bridge::{BizCode, CallerContext, Envelope, LiveEvent, Server, SliceKind};

type ReadyNotifier = Arc<Mutex<Option<watch::Sender<bool>>>>;

#[derive(Clone)]
pub struct LateServer {
    cell: Arc<OnceLock<Arc<dyn Server>>>,
    ready_tx: ReadyNotifier,
    ready: watch::Receiver<bool>,
}

impl Default for LateServer {
    fn default() -> Self {
        Self::new()
    }
}

impl LateServer {
    /// Creates an unattached proxy whose async subscribers wait until [`Self::attach`] runs.
    pub fn new() -> LateServer {
        let (tx, ready) = watch::channel(false);
        LateServer {
            cell: Arc::new(OnceLock::new()),
            ready_tx: Arc::new(Mutex::new(Some(tx))),
            ready,
        }
    }

    /// Installs the underlying server once and wakes all waiting callers and stream subscribers.
    pub fn attach(&self, server: Arc<dyn Server>) {
        if self.cell.set(server).is_ok()
            && let Some(tx) = self.ready_tx.lock().take()
        {
            let _ = tx.send(true);
        }
    }

    /// Starts `make` on a thread of its own; the server it returns serves
    /// from then on.
    pub fn spawn(make: impl FnOnce() -> Arc<dyn Server> + Send + 'static) -> LateServer {
        let late = LateServer::new();
        let handle = late.clone();
        if let Err(err) = std::thread::Builder::new().name("vibevalley-server-start".into()).spawn(move || {
            // Drop `ready_tx` even if `make` unwinds so async waiters never hang.
            struct CloseOnDrop(LateServer);
            impl Drop for CloseOnDrop {
                fn drop(&mut self) {
                    let _ = self.0.ready_tx.lock().take();
                }
            }
            let guard = CloseOnDrop(handle.clone());
            handle.attach(make());
            drop(guard);
        }) {
            tracing::error!(target: "vibevalley::hosted", error = %err, "failed to spawn embedded server startup thread");
            let _ = late.ready_tx.lock().take();
        }
        late
    }
}

impl Server for LateServer {
    fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
        if let Some(inner) = self.cell.get() {
            return Arc::clone(inner).call_with_async(ctx, op, payload);
        }
        Box::pin(async move {
            let mut ready = self.ready.clone();
            let _ = ready.wait_for(|is_ready| *is_ready).await;
            match self.cell.get() {
                Some(inner) => Arc::clone(inner).call_with_async(ctx, op, payload).await,
                None => refusal(BizCode::ServiceUnavailable, "server unavailable before startup completed"),
            }
        })
    }

    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        self.cell.get().map_or_else(|| Arc::<str>::from("null"), |s| s.slice_snapshot_json(slice))
    }

    fn slice_snapshot_json_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Arc<str>> {
        if let Some(inner) = self.cell.get() {
            return Arc::clone(inner).slice_snapshot_json_async(slice);
        }
        Box::pin(async move {
            let mut ready = self.ready.clone();
            let _ = ready.wait_for(|is_ready| *is_ready).await;
            match self.cell.get() {
                Some(inner) => Arc::clone(inner).slice_snapshot_json_async(slice).await,
                None => Arc::<str>::from("null"),
            }
        })
    }

    fn ready_async(&self) -> Option<Pin<Box<dyn Future<Output = ()> + Send>>> {
        if self.cell.get().is_some() {
            return None;
        }
        let mut ready = self.ready.clone();
        Some(Box::pin(async move {
            let _ = ready.wait_for(|is_ready| *is_ready).await;
        }))
    }

    fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
        self.cell.get().and_then(|s| s.subscribe_slice(slice))
    }

    fn subscribe_slice_async(self: Arc<Self>, slice: SliceKind) -> BoxFuture<'static, Option<SliceSubscription>> {
        if let Some(inner) = self.cell.get() {
            return Arc::clone(inner).subscribe_slice_async(slice);
        }
        Box::pin(async move {
            let mut ready = self.ready.clone();
            let _ = ready.wait_for(|is_ready| *is_ready).await;
            match self.cell.get() {
                Some(inner) => Arc::clone(inner).subscribe_slice_async(slice).await,
                None => None,
            }
        })
    }

    fn live(&self) -> tokio::sync::mpsc::Receiver<LiveEvent> {
        if let Some(server) = self.cell.get() {
            return server.live();
        }
        let (tx, rx) = tokio::sync::mpsc::channel(512);
        let cell = self.cell.clone();
        let mut ready = self.ready.clone();
        vibevalley_rt::current_or_global_handle().spawn(async move {
            tokio::select! {
                biased;
                _ = tx.closed() => return,
                res = ready.wait_for(|is_ready| *is_ready) => {
                    if res.is_err() {
                        return;
                    }
                }
            }
            if tx.is_closed() {
                return;
            }
            let Some(server) = cell.get() else { return };
            if let Some(mut live_rx) = server.subscribe_live() {
                loop {
                    tokio::select! {
                        biased;
                        _ = tx.closed() => break,
                        res = live_rx.recv() => match res {
                            Ok(ev) => {
                                match tx.try_send(ev) {
                                    Ok(()) => {}
                                    Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                        tracing::warn!("late_server.live buffer full; disconnecting slow consumer");
                                        break;
                                    }
                                    Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                tracing::warn!(skipped, "late_server.live broadcast lagged; skipped live events");
                                continue;
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        },
                    }
                }
            } else {
                let mut from = server.live();
                loop {
                    tokio::select! {
                        biased;
                        _ = tx.closed() => break,
                        item = from.recv() => match item {
                            Some(item) => {
                                if tx.send(item).await.is_err() {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
        });
        rx
    }

    fn subscribe_live(&self) -> Option<broadcast::Receiver<LiveEvent>> {
        self.cell.get().and_then(|s| s.subscribe_live())
    }

    fn subscribe_with_async(
        self: Arc<Self>,
        ctx: CallerContext,
        name: String,
        payload: Value,
    ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
        if let Some(inner) = self.cell.get() {
            return Arc::clone(inner).subscribe_with_async(ctx, name, payload);
        }
        Box::pin(async move {
            let mut ready = self.ready.clone();
            let _ = ready.wait_for(|is_ready| *is_ready).await;
            match self.cell.get() {
                Some(inner) => Arc::clone(inner).subscribe_with_async(ctx, name, payload).await,
                None => Err(refusal(BizCode::ServiceUnavailable, "server unavailable before startup completed")),
            }
        })
    }

    fn unsubscribe(&self, id: u64) {
        if let Some(server) = self.cell.get() {
            server.unsubscribe(id);
        }
    }

    fn ports(&self) -> GatewayPorts {
        self.cell.get().map(|s| s.ports()).unwrap_or_default()
    }

    fn host_debug(&self) -> Option<vibevalley_server::SharedHostDebug> {
        self.cell.get().and_then(|s| s.host_debug())
    }

    fn fault_gate(&self) -> Option<vibevalley_server::SharedFaultGate> {
        self.cell.get().and_then(|s| s.fault_gate())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use serde_json::json;
    use tokio::sync::Notify;
    use vibevalley_protocol::Issue;
    use vibevalley_server::gateway::bridge::fake::{FakeServer, empty_bundle};
    use vibevalley_server::gateway::bridge::{Bridge as BridgeHub, ClientIdentity, ClientKind, ClientRpc, Outlet};

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
            vibevalley_rt::block_on(async {
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

    /// Panics if any bridge consumer falls back to blocking `watch_slice` or `live`.
    struct FastPathOnlyServer {
        inner: Arc<FakeServer>,
        on_live: Notify,
        on_subscribe: Notify,
    }

    impl FastPathOnlyServer {
        fn new(inner: Arc<FakeServer>) -> Arc<Self> {
            Arc::new(Self {
                inner,
                on_live: Notify::new(),
                on_subscribe: Notify::new(),
            })
        }

        fn wait_live_watchers(&self, what: &str, expected: usize) {
            vibevalley_rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let notified = self.on_live.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if self.inner.live_watchers() == expected {
                            return;
                        }
                        notified.await;
                    }
                })
                .await
            })
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
        }

        fn wait_subscribers(&self, what: &str, expected: usize) {
            vibevalley_rt::block_on(async {
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
    }

    impl Server for FastPathOnlyServer {
        fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
            Arc::clone(&self.inner).call_with_async(ctx, op, payload)
        }

        fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
            self.inner.slice_snapshot_json(slice)
        }

        fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
            self.inner.subscribe_slice(slice)
        }

        fn live(&self) -> tokio::sync::mpsc::Receiver<LiveEvent> {
            panic!("blocking live fallback must not be used when subscribe_live is available");
        }

        fn subscribe_live(&self) -> Option<broadcast::Receiver<LiveEvent>> {
            let rx = self.inner.subscribe_live();
            self.on_live.notify_waiters();
            rx
        }

        fn subscribe_with_async(
            self: Arc<Self>,
            ctx: CallerContext,
            name: String,
            payload: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            Box::pin(async move {
                let res = Arc::clone(&self.inner).subscribe_with_async(ctx, name, payload).await;
                self.on_subscribe.notify_waiters();
                res
            })
        }

        fn unsubscribe(&self, id: u64) {
            self.inner.unsubscribe(id);
            self.on_subscribe.notify_waiters();
        }
    }

    fn test_identity(id: &str) -> ClientIdentity {
        ClientIdentity {
            id: id.into(),
            kind: ClientKind::GpuiWorkbench,
            label: format!("test-{id}"),
        }
    }

    #[test]
    fn regression_a_closed_workbench_does_not_wait_for_server_startup() {
        let (release, starting) = std::sync::mpsc::sync_channel::<()>(0);
        let late = Arc::new(LateServer::spawn(move || {
            starting.recv().unwrap();
            Arc::new(FakeServer::new())
        }));
        let stop = tokio_util::sync::CancellationToken::new();
        let stopped = stop.clone();
        let late_wait = Arc::clone(&late);
        let finished = vibevalley_rt::block_on(async move {
            let task = tokio::spawn(async move {
                tokio::select! {
                    biased;
                    _ = stopped.cancelled() => true,
                    _ = late_wait.subscribe_slice_async(SliceKind::Board) => false,
                }
            });
            stop.cancel();
            tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap()
        });
        assert!(finished);
        release.send(()).unwrap();
    }

    #[test]
    fn waits_for_the_server_then_serves_and_forwards_slices() {
        let (go_tx, go_rx) = std::sync::mpsc::sync_channel::<()>(0);
        let fake = Arc::new(FakeServer::from_bundle(empty_bundle(4)));
        fake.respond("issue.list", json!([]));
        let inner = fake.clone();
        let late = Arc::new(LateServer::spawn(move || {
            let _ = go_rx.recv();
            inner
        }));
        vibevalley_rt::block_on(async {
            let late_sub = Arc::clone(&late);
            let sub_task = tokio::spawn(async move { late_sub.subscribe_slice_async(SliceKind::Board).await });
            tokio::time::sleep(Duration::from_millis(15)).await;
            assert!(!sub_task.is_finished(), "no frame before the server is up");
            go_tx.send(()).unwrap();
            let env = Arc::clone(&late).call_with_async(CallerContext::local(), "issue.list".into(), json!({})).await;
            assert_eq!(env.data, Some(json!([])));
            let mut sub = tokio::time::timeout(Duration::from_secs(5), sub_task).await.unwrap().unwrap().unwrap();
            let frame = sub.borrow_and_update(true);
            assert_eq!(frame.seq, 4);
            let val: Value = serde_json::from_str(&frame.json).unwrap();
            assert_eq!(val["seq"], 4);
        });
    }

    #[test]
    fn delivers_slices_and_live_via_async_fast_path_pre_and_post_attach() {
        let late = Arc::new(LateServer::new());
        assert!(late.ready_async().is_some());
        assert!(late.subscribe_slice(SliceKind::Board).is_none());
        assert!(late.subscribe_live().is_none());

        let hub = BridgeHub::new(late.clone(), 2);
        let pre_rec = Arc::new(Recorder::default());
        let pre_client = hub.attach(test_identity("pre"), pre_rec.clone());
        pre_client.watch("slice:board").unwrap();
        pre_client.watch("live").unwrap();

        // A cancelled pre-attach watcher must never subscribe once the server attaches.
        let cancelled_rec = Arc::new(Recorder::default());
        let cancelled_client = hub.attach(test_identity("cancelled"), cancelled_rec.clone());
        cancelled_client.watch("slice:board").unwrap();
        cancelled_client.watch("live").unwrap();
        drop(cancelled_client);

        let fake = Arc::new(FakeServer::from_bundle(empty_bundle(7)));
        let fast = FastPathOnlyServer::new(fake.clone());
        late.attach(fast.clone());

        assert!(late.ready_async().is_none());
        assert!(late.subscribe_slice(SliceKind::Board).is_some());
        assert!(late.subscribe_live().is_some());
        assert!(late.slice_snapshot_json(SliceKind::Board).contains("\"seq\":7"));

        pre_rec.wait_for("pre-attach initial board slice", |r| r.named("frame:slice:board").len() == 1);
        assert_eq!(pre_rec.named("frame:slice:board")[0]["data"]["seq"], 7);
        fast.wait_live_watchers("pre-attach live subscriber", 1);
        assert_eq!(fake.slice_watchers(SliceKind::Board), 1);

        pre_client.applied_slice("slice:board", 1);
        let mut next = empty_bundle(8);
        next.board.issues.push(Issue::new("i1", 1, "Added", 1));
        fake.swap_bundle(next);
        pre_rec.wait_for("pre-attach updated board slice", |r| r.named("frame:slice:board").len() == 2);
        assert_eq!(pre_rec.named("frame:slice:board")[1]["data"]["seq"], 8);

        let notice: LiveEvent = serde_json::from_value(json!({ "type": "notice", "at": 1, "level": "info", "text": "hello" })).unwrap();
        fake.push_live(notice);
        pre_rec.wait_for("pre-attach live event", |r| r.named("frame:live").len() == 1);
        assert_eq!(pre_rec.named("frame:live")[0]["data"]["text"], "hello");

        // Post-attach clients enter subscribe_slice / subscribe_live immediately.
        let post_rec = Arc::new(Recorder::default());
        let post_client = hub.attach(test_identity("post"), post_rec.clone());
        post_client.watch("slice:board").unwrap();
        post_client.watch("live").unwrap();
        post_rec.wait_for("post-attach initial board slice", |r| r.named("frame:slice:board").len() == 1);
        assert_eq!(post_rec.named("frame:slice:board")[0]["data"]["seq"], 8);
        fast.wait_live_watchers("post-attach live subscriber", 2);

        let notice2: LiveEvent = serde_json::from_value(json!({ "type": "notice", "at": 2, "level": "info", "text": "world" })).unwrap();
        fake.push_live(notice2);
        post_rec.wait_for("post-attach live event", |r| r.named("frame:live").len() == 1);
        assert_eq!(post_rec.named("frame:live")[0]["data"]["text"], "world");

        assert!(cancelled_rec.named("frame:slice:board").is_empty());
        assert!(cancelled_rec.named("frame:live").is_empty());
    }

    struct AsyncCallOnlyServer(Arc<FakeServer>);

    impl Server for AsyncCallOnlyServer {
        fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
            Arc::clone(&self.0).call_with_async(ctx, op, payload)
        }

        fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
            self.0.slice_snapshot_json(slice)
        }

        fn live(&self) -> tokio::sync::mpsc::Receiver<LiveEvent> {
            self.0.live()
        }

        fn subscribe_with_async(
            self: Arc<Self>,
            ctx: CallerContext,
            name: String,
            payload: Value,
        ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
            Arc::clone(&self.0).subscribe_with_async(ctx, name, payload)
        }

        fn unsubscribe(&self, id: u64) {
            self.0.unsubscribe(id);
        }
    }

    #[test]
    fn call_with_async_waits_pre_attach_and_delegates_directly_post_attach() {
        vibevalley_rt::block_on(async {
            let late = Arc::new(LateServer::new());
            let fake = Arc::new(FakeServer::new());
            fake.respond("issue.list", json!([{ "id": "i1" }]));

            let pre_late = late.clone();
            let pre_task = tokio::spawn(async move {
                let mut ctx = CallerContext::local();
                ctx.client = Some(test_identity("pre-async"));
                pre_late.call_with_async(ctx, "issue.list".into(), json!({})).await
            });

            // Yield briefly to confirm pre-attach call stays pending until attach().
            tokio::time::sleep(Duration::from_millis(15)).await;
            assert!(!pre_task.is_finished(), "pre-attach call_with_async should await readiness");

            late.attach(Arc::new(AsyncCallOnlyServer(fake.clone())));
            let pre_env = pre_task.await.unwrap();
            assert_eq!(pre_env.biz_code, 0);
            assert_eq!(pre_env.data, Some(json!([{ "id": "i1" }])));
            assert_eq!(fake.last_client().as_ref().map(|c| c.id.as_str()), Some("pre-async"));

            // Post-attach call_with_async delegates immediately without hitting sync call_with.
            let mut post_ctx = CallerContext::local();
            post_ctx.client = Some(test_identity("post-async"));
            let post_env = late.call_with_async(post_ctx, "issue.list".into(), json!({})).await;
            assert_eq!(post_env.biz_code, 0);
            assert_eq!(post_env.data, Some(json!([{ "id": "i1" }])));
            assert_eq!(fake.last_client().as_ref().map(|c| c.id.as_str()), Some("post-async"));

            // If startup fails and drops ready_tx before attach, call_with_async refuses cleanly.
            let unattached = Arc::new(LateServer::new());
            unattached.ready_tx.lock().take();
            let failed_env = unattached.call_with_async(CallerContext::local(), "issue.list".into(), json!({})).await;
            assert_eq!(failed_env.biz_code, BizCode::ServiceUnavailable.code());
        });
    }

    #[test]
    fn machine_bus_forwards_after_attach() {
        struct DummyMachineBus;
        impl vibevalley_server::gateway::api::MachineBus for DummyMachineBus {
            fn accept_connection(&self, _conn: vibevalley_server::gateway::api::MachineConnection) {}
        }

        struct MachineBusServer {
            inner: Arc<FakeServer>,
            bus: vibevalley_server::gateway::api::SharedMachineBus,
        }

        impl Server for MachineBusServer {
            fn call_with_async(self: Arc<Self>, ctx: CallerContext, op: String, payload: Value) -> BoxFuture<'static, Envelope> {
                Arc::clone(&self.inner).call_with_async(ctx, op, payload)
            }

            fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
                self.inner.slice_snapshot_json(slice)
            }

            fn live(&self) -> tokio::sync::mpsc::Receiver<LiveEvent> {
                self.inner.live()
            }

            fn subscribe_with_async(
                self: Arc<Self>,
                ctx: CallerContext,
                name: String,
                payload: Value,
            ) -> BoxFuture<'static, Result<(u64, tokio::sync::mpsc::Receiver<Value>), Envelope>> {
                Arc::clone(&self.inner).subscribe_with_async(ctx, name, payload)
            }

            fn unsubscribe(&self, id: u64) {
                self.inner.unsubscribe(id);
            }

            fn ports(&self) -> GatewayPorts {
                GatewayPorts {
                    machine: Some(self.bus.clone()),
                    ..Default::default()
                }
            }
        }

        let late = LateServer::new();
        assert!(late.machine_bus().is_none());
        let bus: vibevalley_server::gateway::api::SharedMachineBus = Arc::new(DummyMachineBus);
        late.attach(Arc::new(MachineBusServer {
            inner: Arc::new(FakeServer::new()),
            bus: bus.clone(),
        }));
        let forwarded = late.machine_bus().expect("machine_bus forwarded after attach");
        assert!(Arc::ptr_eq(&forwarded, &bus));
    }

    #[test]
    fn regression_bridge_subscribe_is_non_blocking_on_unattached_late_server() {
        let late = Arc::new(LateServer::new());
        let hub = BridgeHub::new(late.clone(), 2);

        let pre_rec = Arc::new(Recorder::default());
        let pre_client = hub.attach(test_identity("pre-sub"), pre_rec.clone());
        let cancelled_rec = Arc::new(Recorder::default());
        let cancelled_client = hub.attach(test_identity("cancel-sub"), cancelled_rec.clone());

        let t0 = Instant::now();
        pre_client.subscribe("s1", "channel.follow", json!({ "id": "c1", "after": 0 }));
        cancelled_client.subscribe("s2", "channel.follow", json!({ "id": "c1", "after": 0 }));
        assert!(
            t0.elapsed() < Duration::from_millis(200),
            "Client::subscribe must return immediately without blocking on LateServer startup"
        );
        assert_eq!(pre_client.subscription_count(), 1);
        assert_eq!(cancelled_client.subscription_count(), 1);

        // Unsubscribing before startup finishes must never register on the attached server.
        cancelled_client.unsubscribe("s2");
        assert_eq!(cancelled_client.subscription_count(), 0);

        let fake = Arc::new(FakeServer::from_bundle(empty_bundle(11)));
        let fast = FastPathOnlyServer::new(fake.clone());
        late.attach(fast.clone());

        fast.wait_subscribers("pre-attach subscription registered", 1);
        fake.emit("channel.follow", json!({ "text": "hello-after-attach" }));
        pre_rec.wait_for("pre-attach subscription event", |r| r.named("sub:s1").len() == 1);
        assert_eq!(pre_rec.named("sub:s1")[0], json!({ "event": { "text": "hello-after-attach" } }));
        assert!(cancelled_rec.named("sub:s2").is_empty());

        vibevalley_rt::block_on(async {
            let snap = late.clone().slice_snapshot_json_async(SliceKind::Board).await;
            assert!(snap.contains("\"seq\":11"));
            assert!(late.clone().subscribe_slice_async(SliceKind::Board).await.is_some());
        });
    }
}
