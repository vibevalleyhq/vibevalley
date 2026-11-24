//! The real server over the HTTP API, for running the CLI against it:
//! `cargo run -p vibevalley-server --example serve <data dir>`, then e.g.
//! `VIBEVALLEY_SERVER=<printed url> vibevalley issue list`. Every built-in
//! runtime is registered, `scripted` among them (no quota).
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("a data dir"));
    let config = vibevalley_server::Config {
        deepseek_api_key: std::env::var("DEEPSEEK_API_KEY").unwrap_or_default(),
        ..vibevalley_server::Config::under(dir)
    };
    let home = config.home.clone();
    let app = vibevalley_server::create_app_blocking(config).expect("the server");
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).expect("listen");
    app.set_mcp_url(format!("{}/mcp", listener.url()));
    let _announced = vibevalley_server::home::announce(&home, &listener.url()).expect("server.json");
    println!("{}", listener.url());
    std::thread::park();
}
