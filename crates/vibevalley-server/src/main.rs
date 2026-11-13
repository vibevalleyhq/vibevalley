//! `vibevalley-server`: the farm's server on its own, as `apps/server`'s
//! main.ts ran it. `--web <dir>` serves the built page at `/`;
//! `--ready-json` prints `{"url","pid"}` once it listens. The environment
//! says the rest: `VIBEVALLEY_HOME`, `VIBEVALLEY_WORK_ROOT`,
//! `VIBEVALLEY_PORT` (0: any), `VIBEVALLEY_AGENT_STARTERS` (template ids),
//! and `VIBEVALLEY_TEST_RUNTIMES=1` for the page's tests' stand-in agent.

use std::path::PathBuf;
use std::sync::Arc;

struct Flags {
    web: Option<PathBuf>,
    ready_json: bool,
}

fn flags() -> Result<Flags, String> {
    let mut f = Flags { web: None, ready_json: false };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--ready-json" => f.ready_json = true,
            "--web" => f.web = Some(PathBuf::from(args.next().ok_or("--web needs a folder")?)).filter(|p| !p.as_os_str().is_empty()),
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
    let user = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    let work_root = env("VIBEVALLEY_WORK_ROOT").map(PathBuf::from).unwrap_or_else(|| user.join("vibevalley-dev"));
    let port: u16 = match env("VIBEVALLEY_PORT") {
        Some(p) => p.parse().map_err(|_| format!("VIBEVALLEY_PORT is not a port: {p}"))?,
        None => 8787,
    };
    let testing = env("VIBEVALLEY_TEST_RUNTIMES").as_deref() == Some("1");
    let mut config = vibevalley_server::ServerConfig {
        work_root,
        starters: env("VIBEVALLEY_AGENT_STARTERS")
            .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
            .unwrap_or_default(),
        ..vibevalley_server::ServerConfig::under(home.clone())
    };
    if testing {
        let mut registry = vibevalley_oar::Registry::new();
        registry.register(vibevalley_server::testing::helper());
        config.registry = Some(Arc::new(registry));
        config.probe_runtimes = false;
        config.link_previews = false;
    }
    for dir in [config.work_root.join("repos"), config.work_root.join("worktrees"), config.work_root.join("pkm")] {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let started = vibevalley_server::start(config).map_err(|e| e.to_string())?;
    let addr = format!("127.0.0.1:{port}").parse().map_err(|e| format!("{e}"))?;
    let listener = vibevalley_http::serve_with(started.hub.clone(), addr, flags.web).map_err(|e| format!("listening on {addr}: {e}"))?;
    let url = listener.url();
    started.board.set_mcp_url(format!("{url}/mcp"));
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
