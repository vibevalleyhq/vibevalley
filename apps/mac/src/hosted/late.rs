//! The real server, started off the UI thread: the bridge needs a server at
//! launch, and `vibevalley_server::start` blocks (files, runtime probes). Until it
//! is up, calls and subscriptions wait on the bridge's worker threads, and
//! slice watchers / `live` receivers are fed once it arrives.

use std::sync::{Arc, OnceLock};

use serde_json::Value;
use vibevalley_server::transport::bridge::{CallerContext, Envelope, LiveEvent, Server, SliceKind};

#[derive(Clone)]
pub struct LateServer {
    cell: Arc<OnceLock<Arc<dyn Server>>>,
    ready: flume::Receiver<()>,
}

impl LateServer {
    /// Starts `make` on a thread of its own; the server it returns serves
    /// from then on.
    pub fn spawn(make: impl FnOnce() -> Arc<dyn Server> + Send + 'static) -> LateServer {
        let (starting, ready) = flume::bounded(0);
        let late = LateServer {
            cell: Default::default(),
            ready,
        };
        let cell = late.cell.clone();
        let _ = std::thread::Builder::new().name("vibevalley-server-start".into()).spawn(move || {
            let _ = cell.set(make());
            drop(starting);
        });
        late
    }

    fn server(&self) -> &Arc<dyn Server> {
        self.cell.wait()
    }

    /// A receiver now, fed from `open(server)` once the server is up.
    fn forward<T: Send + 'static>(&self, open: fn(&dyn Server) -> flume::Receiver<T>) -> flume::Receiver<T> {
        let (tx, rx) = flume::unbounded();
        let cell = self.cell.clone();
        let _ = std::thread::Builder::new().name("vibevalley-server-forward".into()).spawn(move || {
            let from = open(cell.wait().as_ref());
            for item in from.iter() {
                if tx.send(item).is_err() {
                    break;
                }
            }
        });
        rx
    }
}

impl Server for LateServer {
    fn raise_budget(&self, input: Value) -> Envelope {
        self.server().raise_budget(input)
    }

    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.server().call(op, payload)
    }

    fn call_with(&self, ctx: &CallerContext, op: &str, payload: Value) -> Envelope {
        self.server().call_with(ctx, op, payload)
    }

    fn slice_snapshot(&self, slice: SliceKind) -> Value {
        self.server().slice_snapshot(slice)
    }

    fn watch_slice(&self, slice: SliceKind, after_seq: Option<i64>, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(i64, &Value)) {
        if !self.ready.is_disconnected() {
            flume::Selector::new().recv(stop, |_| ()).recv(&self.ready, |_| ()).wait();
        }
        if !stop.is_disconnected()
            && let Some(server) = self.cell.get()
        {
            server.watch_slice(slice, after_seq, stop, receive);
        }
    }

    fn live(&self) -> flume::Receiver<LiveEvent> {
        self.forward(|s| s.live())
    }

    fn subscribe(&self, name: &str, payload: Value) -> Result<(u64, flume::Receiver<Value>), Envelope> {
        self.server().subscribe(name, payload)
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

    fn voice(&self) -> Option<Arc<vibevalley_server::modules::collab::voice::Voice>> {
        self.cell.get().and_then(|s| s.voice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vibevalley_server::transport::bridge::fake::{FakeServer, empty_bundle};

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
        finished.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
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
        let (seq, val) = seen_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(seq, 4);
        assert_eq!(val["seq"], 4);
        drop(stop);
        handle.join().unwrap();
    }
}
