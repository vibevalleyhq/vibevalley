//! The real server over the HTTP API, for running the CLI against it:
//! `cargo run -p vibevalley-server --example serve <data dir>`, then e.g.
//! `VIBEVALLEY_SERVER=<printed url> vibevalley issue list`. Every built-in
//! runtime is registered, `scripted` among them (no quota).
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("a data dir"));
    let config = vibevalley_server::ServerConfig {
        deepseek_api_key: std::env::var("DEEPSEEK_API_KEY").unwrap_or_default(),
        ..vibevalley_server::ServerConfig::under(dir)
    };
    let started = vibevalley_server::start(config).expect("the server");
    let listener = vibevalley_http::serve(started.hub, "127.0.0.1:0".parse().unwrap()).expect("listen");
    println!("{}", listener.url());
    std::thread::park();
}
