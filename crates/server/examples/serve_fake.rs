//! Serves the bridge's fake server over the HTTP API, for trying the
//! CLI against fixtures: `cargo run -p vibevalley-server --example serve_fake
//! --example serve_fake [fixtures dir]`, then e.g.
//! `VIBEVALLEY_SERVER=<printed url> vibevalley issue list`.
use std::sync::Arc;

use vibevalley_server::transport::bridge::fake::FakeServer;

fn main() {
    let fake = match std::env::args().nth(1) {
        Some(dir) => FakeServer::from_dir(std::path::Path::new(&dir)).expect("fixtures"),
        None => FakeServer::new(),
    };
    fake.respond("issue.list", serde_json::json!([]));
    let listener = vibevalley_server::transport::http::serve(Arc::new(fake), "127.0.0.1:0".parse().unwrap()).expect("listen");
    println!("{}", listener.url());
    std::thread::park();
}
