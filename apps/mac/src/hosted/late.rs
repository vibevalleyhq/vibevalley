//! The real server, started off the UI thread: the bridge needs a server at
//! launch, and `vibevalley_server::start` blocks (files, runtime probes). Until it
//! is up, calls and subscriptions wait on the bridge's worker threads, and
//! `state`/`live` receivers are fed once it arrives.

use std::sync::{Arc, OnceLock};

use serde_json::Value;
use vibevalley_bridge::{Envelope, LiveEvent, Server};

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
    fn space_document(&self) -> Option<vibevalley_server_api::Document> {
        self.server().space_document()
    }
    fn call(&self, op: &str, payload: Value) -> Envelope {
        self.server().call(op, payload)
    }

    fn state(&self) -> flume::Receiver<Value> {
        self.forward(|s| s.state())
    }

    fn watch_workbench(&self, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(&Value)) {
        if !self.ready.is_disconnected() {
            flume::Selector::new().recv(stop, |_| ()).recv(&self.ready, |_| ()).wait();
        }
        if !stop.is_disconnected()
            && let Some(server) = self.cell.get()
        {
            server.watch_workbench(stop, receive);
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vibevalley_bridge::fake::FakeServer;

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
            late.watch_workbench(&stopped, &mut |_| panic!("closed view received a snapshot"));
            done.send(()).unwrap();
        });
        drop(stop);
        finished.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        release.send(()).unwrap();
    }

    #[test]
    fn waits_for_the_server_then_serves_and_forwards_frames() {
        let (go_tx, go_rx) = flume::bounded::<()>(0);
        let fake = Arc::new(FakeServer::new());
        fake.respond("issue.list", json!([]));
        let inner = fake.clone();
        let late = LateServer::spawn(move || {
            let _ = go_rx.recv();
            inner
        });
        let frames = late.state();
        assert!(frames.try_recv().is_err(), "no frame before the server is up");
        go_tx.send(()).unwrap();
        assert_eq!(late.call("issue.list", json!({})).data, Some(json!([])));
        assert!(frames.recv_timeout(std::time::Duration::from_secs(5)).is_ok());
    }
}
