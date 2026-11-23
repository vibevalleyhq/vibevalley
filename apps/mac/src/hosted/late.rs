//! The real server, started off the UI thread: the bridge needs a server at
//! launch, and `vibevalley_server::start` blocks (files, runtime probes). Until it
//! is up, async slice and live subscribers await [`Server::ready_async`] on the
//! shared Tokio runtime before entering the zero-thread `WatchStream` /
//! `broadcast::Receiver` fast paths.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{broadcast, watch};
use vibevalley_server::slice_feed::SliceSubscription;
use vibevalley_server::transport::bridge::{CallerContext, Envelope, LiveEvent, Server, SliceKind};

#[derive(Clone)]
pub struct LateServer {
    cell: Arc<OnceLock<Arc<dyn Server>>>,
    ready_tx: Arc<Mutex<Option<watch::Sender<bool>>>>,
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
        let _ = std::thread::Builder::new().name("vibevalley-server-start".into()).spawn(move || {
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
        });
        late
    }

    fn server(&self) -> &Arc<dyn Server> {
        self.cell.wait()
    }
}

impl Server for LateServer {
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.server().call(op, payload)
    }

    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        self.server().call_with(ctx, op, payload)
    }

    fn slice_snapshot(&self, slice: SliceKind) -> Value {
        self.server().slice_snapshot(slice)
    }

    fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
        self.server().slice_snapshot_json(slice)
    }

    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        if self.cell.get().is_none() {
            let mut ready = self.ready.clone();
            vibevalley_runtime::rt::block_on(async {
                tokio::select! {
                    biased;
                    _ = stop.recv_async() => {}
                    _ = ready.wait_for(|is_ready| *is_ready) => {}
                }
            });
        }
        if !stop.is_disconnected()
            && let Some(server) = self.cell.get()
        {
            server.watch_slice(slice, after_seq, stop, receive);
        }
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

    fn live(&self) -> flume::Receiver<LiveEvent> {
        if let Some(server) = self.cell.get() {
            return server.live();
        }
        let (tx, rx) = flume::unbounded();
        let cell = self.cell.clone();
        let mut ready = self.ready.clone();
        vibevalley_runtime::rt::handle().spawn(async move {
            let _ = ready.wait_for(|is_ready| *is_ready).await;
            if tx.is_disconnected() {
                return;
            }
            let Some(server) = cell.get() else { return };
            if let Some(mut live_rx) = server.subscribe_live() {
                loop {
                    tokio::select! {
                        biased;
                        res = live_rx.recv() => match res {
                            Ok(ev) => {
                                if tx.send(ev).is_err() {
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        },
                        _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                            if tx.is_disconnected() {
                                break;
                            }
                        }
                    }
                }
            } else {
                let from = server.live();
                while let Ok(item) = from.recv_async().await {
                    if tx.send(item).is_err() {
                        break;
                    }
                }
            }
        });
        rx
    }

    fn subscribe_live(&self) -> Option<broadcast::Receiver<LiveEvent>> {
        self.cell.get().and_then(|s| s.subscribe_live())
    }

    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        self.server().subscribe(name, payload)
    }

    fn subscribe_with(&self, ctx: &CallerContext, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        self.server().subscribe_with(ctx, name, payload)
    }

    fn unsubscribe(&self, id: u64) {
        if let Some(server) = self.cell.get() {
            server.unsubscribe(id);
        }
    }

    fn media_inputs(&self) -> Option<vibevalley_server::transport::api::media::SharedMediaInputs> {
        self.cell.get().and_then(|s| s.media_inputs())
    }

    fn speech_streams(&self) -> Option<vibevalley_server::transport::api::media::SharedSpeechStreams> {
        self.cell.get().and_then(|s| s.speech_streams())
    }

    fn mcp(&self) -> Option<vibevalley_server::transport::api::SharedMcp> {
        self.cell.get().and_then(|s| s.mcp())
    }

    fn host_debug(&self) -> Option<vibevalley_server::SharedHostDebug> {
        self.cell.get().and_then(|s| s.host_debug())
    }

    fn fault_gate(&self) -> Option<vibevalley_server::SharedFaultGate> {
        self.cell.get().and_then(|s| s.fault_gate())
    }

    fn voice(&self) -> Option<vibevalley_server::transport::api::SharedLiveVoice> {
        self.cell.get().and_then(|s| s.voice())
    }

    fn remote_auth(&self) -> Option<vibevalley_server::transport::api::SharedRemoteAuth> {
        self.cell.get().and_then(|s| s.remote_auth())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use serde_json::json;
    use vibevalley_protocol::Issue;
    use vibevalley_server::transport::bridge::fake::{FakeServer, empty_bundle};
    use vibevalley_server::transport::bridge::{ClientIdentity, ClientKind, Hub as BridgeHub, Outlet};

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

    /// Panics if any bridge consumer falls back to blocking `watch_slice` or `live`.
    struct FastPathOnlyServer(Arc<FakeServer>);

    impl Server for FastPathOnlyServer {
        fn call(&self, op: &str, payload: Value) -> Envelope {
            self.0.call(op, payload)
        }

        fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
            self.0.call_with(ctx, op, payload)
        }

        fn slice_snapshot(&self, slice: SliceKind) -> Value {
            self.0.slice_snapshot(slice)
        }

        fn slice_snapshot_json(&self, slice: SliceKind) -> Arc<str> {
            self.0.slice_snapshot_json(slice)
        }

        fn watch_slice(&self, _slice: SliceKind, _after_seq: Option<i64>, _stop: &flume::Receiver<()>, _receive: &mut dyn FnMut(i64, &Value)) {
            panic!("blocking watch_slice fallback must not be used when subscribe_slice is available");
        }

        fn subscribe_slice(&self, slice: SliceKind) -> Option<SliceSubscription> {
            self.0.subscribe_slice(slice)
        }

        fn live(&self) -> flume::Receiver<LiveEvent> {
            panic!("blocking live fallback must not be used when subscribe_live is available");
        }

        fn subscribe_live(&self) -> Option<broadcast::Receiver<LiveEvent>> {
            self.0.subscribe_live()
        }

        fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
            self.0.subscribe(name, payload)
        }

        fn unsubscribe(&self, id: u64) {
            self.0.unsubscribe(id);
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

    #[test]
    fn regression_a_closed_workbench_does_not_wait_for_server_startup() {
        let (release, starting) = flume::bounded(0);
        let late = LateServer::spawn(move || {
            starting.recv().unwrap();
            Arc::new(FakeServer::new())
        });
        let (stop, stopped) = flume::bounded(0);
        let (done, finished) = flume::bounded(1);
        std::thread::spawn(move || {
            late.watch_slice(SliceKind::Board, None, &stopped, &mut |_, _| panic!("closed view received a snapshot"));
            done.send(()).unwrap();
        });
        drop(stop);
        finished.recv_timeout(Duration::from_secs(2)).unwrap();
        release.send(()).unwrap();
    }

    #[test]
    fn waits_for_the_server_then_serves_and_forwards_slices() {
        let (go_tx, go_rx) = flume::bounded::<()>(0);
        let fake = Arc::new(FakeServer::from_bundle(empty_bundle(4)));
        fake.respond("issue.list", json!([]));
        let inner = fake.clone();
        let late = LateServer::spawn(move || {
            let _ = go_rx.recv();
            inner
        });
        let (stop, stopped) = flume::bounded(0);
        let (seen_tx, seen_rx) = flume::bounded(1);
        let watcher = late.clone();
        let handle = std::thread::spawn(move || {
            watcher.watch_slice(SliceKind::Board, None, &stopped, &mut |seq, val| {
                let _ = seen_tx.send((seq, val.clone()));
            });
        });
        assert!(seen_rx.try_recv().is_err(), "no frame before the server is up");
        go_tx.send(()).unwrap();
        assert_eq!(late.call("issue.list", json!({})).data, Some(json!([])));
        let (seq, val) = seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(seq, 4);
        assert_eq!(val["seq"], 4);
        drop(stop);
        handle.join().unwrap();
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
        late.attach(Arc::new(FastPathOnlyServer(fake.clone())));

        assert!(late.ready_async().is_none());
        assert!(late.subscribe_slice(SliceKind::Board).is_some());
        assert!(late.subscribe_live().is_some());
        assert!(late.slice_snapshot_json(SliceKind::Board).contains("\"seq\":7"));

        wait_for("pre-attach initial board slice", || pre_rec.named("frame:slice:board").len() == 1);
        assert_eq!(pre_rec.named("frame:slice:board")[0]["data"]["seq"], 7);
        wait_for("pre-attach live subscriber", || fake.live_watchers() == 1);
        assert_eq!(fake.slice_watchers(SliceKind::Board), 1);

        pre_client.applied_slice("slice:board", 1);
        let mut next = empty_bundle(8);
        next.board.issues.push(Issue::new("i1", 1, "Added", 1));
        fake.swap_bundle(next);
        wait_for("pre-attach updated board slice", || pre_rec.named("frame:slice:board").len() == 2);
        assert_eq!(pre_rec.named("frame:slice:board")[1]["data"]["seq"], 8);

        let notice: LiveEvent = serde_json::from_value(json!({ "type": "notice", "at": 1, "level": "info", "text": "hello" })).unwrap();
        fake.push_live(notice);
        wait_for("pre-attach live event", || pre_rec.named("frame:live").len() == 1);
        assert_eq!(pre_rec.named("frame:live")[0]["data"]["text"], "hello");

        // Post-attach clients enter subscribe_slice / subscribe_live immediately.
        let post_rec = Arc::new(Recorder::default());
        let post_client = hub.attach(test_identity("post"), post_rec.clone());
        post_client.watch("slice:board").unwrap();
        post_client.watch("live").unwrap();
        wait_for("post-attach initial board slice", || post_rec.named("frame:slice:board").len() == 1);
        assert_eq!(post_rec.named("frame:slice:board")[0]["data"]["seq"], 8);
        wait_for("post-attach live subscriber", || fake.live_watchers() == 2);

        let notice2: LiveEvent = serde_json::from_value(json!({ "type": "notice", "at": 2, "level": "info", "text": "world" })).unwrap();
        fake.push_live(notice2);
        wait_for("post-attach live event", || post_rec.named("frame:live").len() == 1);
        assert_eq!(post_rec.named("frame:live")[0]["data"]["text"], "world");

        assert!(cancelled_rec.named("frame:slice:board").is_empty());
        assert!(cancelled_rec.named("frame:live").is_empty());
    }
}
