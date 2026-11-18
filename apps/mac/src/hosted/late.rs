//! The real server, started off the UI thread: the bridge needs a server at
//! launch, and `vibevalley_server::start` blocks (files, runtime probes). Until it
//! is up, calls and subscriptions wait on the bridge's worker threads, and
//! `state`/`live` receivers are fed once it arrives.

use std::sync::{Arc, OnceLock};

use serde_json::Value;
use vibevalley_bridge::{Envelope, LiveEvent, Server};

#[derive(Clone, Default)]
pub struct LateServer {
    cell: Arc<OnceLock<Arc<dyn Server>>>,
}

impl LateServer {
    /// Starts `make` on a thread of its own; the server it returns serves
    /// from then on.
    pub fn spawn(make: impl FnOnce() -> Arc<dyn Server> + Send + 'static) -> LateServer {
        let late = LateServer::default();
        let cell = late.cell.clone();
        let _ = std::thread::Builder::new().name("vibevalley-server-start".into()).spawn(move || {
            let _ = cell.set(make());
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
    fn resolve_approval(&self, input: Value) -> Envelope {
        self.server().resolve_approval(input)
    }
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
