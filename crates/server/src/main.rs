//! `vibevalley-server`: standalone binary entrypoint. `--ready-json` prints
//! `{"url","pid"}` once listening, and `--database-url <URL>` overrides the
//! database URL. Remaining configuration reads environment variables via
//! [`vibevalley_server::Config::from_env`].

struct Flags {
    ready_json: bool,
    database_url: Option<String>,
}

fn flags() -> Result<Flags, String> {
    let mut f = Flags {
        ready_json: false,
        database_url: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--ready-json" {
            f.ready_json = true;
        } else if a == "--database-url" {
            let url = args
                .next()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "--database-url requires a URL".to_string())?;
            f.database_url = Some(url);
        } else if let Some(url) = a.strip_prefix("--database-url=") {
            if url.is_empty() {
                return Err("--database-url requires a non-empty URL".to_string());
            }
            f.database_url = Some(url.to_string());
        } else {
            return Err(format!("unknown flag {a}"));
        }
    }
    Ok(f)
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn main() {
    let default_level = if env("VIBEVALLEY_DEBUG").as_deref() == Some("1") { "info" } else { "warn" };
    vibevalley_server::log::init(default_level);
    if let Err(why) = run() {
        eprintln!("vibevalley: {why}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let flags = flags()?;
    let home = vibevalley_server::home::home();
    let port: u16 = match env("VIBEVALLEY_PORT") {
        Some(p) => p.parse().map_err(|_| format!("VIBEVALLEY_PORT is not a port: {p}"))?,
        None => vibevalley_server::home::default_port(),
    };
    let mut config = vibevalley_server::Config::from_env(home.clone(), env!("CARGO_PKG_VERSION"));
    if let Some(database_url) = flags.database_url {
        config.database_url = Some(database_url);
    }

    vibevalley_runtime::rt::block_on(async {
        let app = vibevalley_server::create_app(config).await.map_err(|e| e.to_string())?;
        let addr = format!("127.0.0.1:{port}").parse().map_err(|e| format!("{e}"))?;
        let listener = vibevalley_server::gateway::serve(app.server(), addr).map_err(|e| format!("listening on {addr}: {e}"))?;
        let url = listener.url();
        app.set_mcp_url(format!("{url}/mcp"));
        let announced = vibevalley_server::home::announce(&home, &url).map_err(|e| format!("server.json: {e}"))?;
        eprintln!("vibevalley: listening on {url}");
        if flags.ready_json {
            println!("{}", serde_json::json!({ "url": url, "pid": std::process::id() }));
        }

        use tokio::signal::unix::{SignalKind, signal};
        match (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) {
            (Ok(mut term), Ok(mut int)) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = int.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }

        listener.shutdown().await;
        app.close().await;
        drop(announced);
        Ok(())
    })
}
