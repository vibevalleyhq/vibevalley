//! `vibevalley-server`: the farm's server on its own. `--ready-json`
//! prints `{"url","pid"}` once it listens, and `--database-url <URL>`
//! overrides the database URL. The environment configures the rest via
//! [`vibevalley_server::ServerConfig::from_env`]: `VIBEVALLEY_HOME`,
//! `VIBEVALLEY_WORK_ROOT`, `VIBEVALLEY_PORT` (0: any),
//! `VIBEVALLEY_DATABASE_URL`, `DEEPSEEK_API_KEY`, `VIBEVALLEY_GIT_EMAILS`,
//! `VIBEVALLEY_AGENT_STARTERS`, and `VIBEVALLEY_TEST_RUNTIMES=1`.

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

fn init_tracing() {
    let default_level = if env("VIBEVALLEY_DEBUG").as_deref() == Some("1") { "info" } else { "warn" };
    let spec = env("VIBEVALLEY_LOG").or_else(|| env("RUST_LOG")).unwrap_or_else(|| default_level.to_string());
    let filter = tracing_subscriber::EnvFilter::try_new(&spec).unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_level));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
}

fn main() {
    init_tracing();
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
    let mut config = vibevalley_server::ServerConfig::from_env(home.clone(), env!("CARGO_PKG_VERSION"));
    if let Some(database_url) = flags.database_url {
        config.database_url = Some(database_url);
    }
    let started = vibevalley_server::start(config).map_err(|e| e.to_string())?;
    let addr = format!("127.0.0.1:{port}").parse().map_err(|e| format!("{e}"))?;
    let listener = vibevalley_server::transport::http::serve(started.door.clone(), addr).map_err(|e| format!("listening on {addr}: {e}"))?;
    let url = listener.url();
    started.set_mcp_url(format!("{url}/mcp"));
    let announced = vibevalley_server::home::announce(&home, &url).map_err(|e| format!("server.json: {e}"))?;
    eprintln!("vibevalley: listening on {url}");
    if flags.ready_json {
        println!("{}", serde_json::json!({ "url": url, "pid": std::process::id() }));
    }
    vibevalley_runtime::rt::block_on(async {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
            return std::future::pending::<()>().await;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    });
    drop(listener);
    started.close();
    drop(announced);
    Ok(())
}
