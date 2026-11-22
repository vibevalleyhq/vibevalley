//! `vibevalley-server`: the farm's server on its own. `--ready-json`
//! prints `{"url","pid"}` once it listens. The environment configures the
//! rest via [`vibevalley_server::ServerConfig::from_env`]: `VIBEVALLEY_HOME`,
//! `VIBEVALLEY_WORK_ROOT`, `VIBEVALLEY_PORT` (0: any), `DEEPSEEK_API_KEY`,
//! `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `VIBEVALLEY_VOICE_ID`,
//! `VIBEVALLEY_GIT_EMAILS`, `VIBEVALLEY_PKM_ROOT`, `VIBEVALLEY_AGENT_STARTERS`,
//! `VIBEVALLEY_VOICE_LINE_URL`, and `VIBEVALLEY_TEST_RUNTIMES=1`.

struct Flags {
    ready_json: bool,
}

fn flags() -> Result<Flags, String> {
    let mut f = Flags { ready_json: false };
    for a in std::env::args().skip(1) {
        match a.as_str() {
            "--ready-json" => f.ready_json = true,
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(f)
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn main() {
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
    let config = vibevalley_server::ServerConfig::from_env(home.clone(), env!("CARGO_PKG_VERSION"));
    let started = vibevalley_server::start(config).map_err(|e| e.to_string())?;
    let addr = format!("127.0.0.1:{port}").parse().map_err(|e| format!("{e}"))?;
    let listener = vibevalley_server::transport::http::serve(started.hub.clone(), addr).map_err(|e| format!("listening on {addr}: {e}"))?;
    let url = listener.url();
    started.board.sessions().set_mcp_url(format!("{url}/mcp"));
    let announced = vibevalley_server::home::announce(&home, &url).map_err(|e| format!("server.json: {e}"))?;
    eprintln!("vibevalley: listening on {url}");
    if flags.ready_json {
        println!("{}", serde_json::json!({ "url": url, "pid": std::process::id() }));
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async {
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
