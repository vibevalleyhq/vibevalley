//! `machine list|up`: inspect online execution machines and run the outbound WebSocket execution daemon.

use std::path::PathBuf;

use clap::{Args, Subcommand};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use vibevalley_cli::machine_agent::{
    MachineAgent, MachineAgentConfig, MachineAuthConfig, Secret as MachineSecret, build_runtime_registry, load_machine_auth, save_machine_auth,
};
use vibevalley_protocol::{MachineInfo, RemotePairExchangeRequest, RemotePlatform, SCOPE_REMOTE_MACHINE, ops};

use crate::auth::{default_device_name, normalize_server_url, same_server};
use crate::client::{Client, Done, Failure, no_dry_run};
use crate::output::{line, non_empty_opt};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct MachineCmd {
    #[command(subcommand)]
    pub action: MachineAction,
}

#[derive(Debug, Subcommand)]
pub enum MachineAction {
    /// List registered execution machines and their available OAR runtimes
    #[command(after_help = "Examples:\n  vibevalley machine list\n  vibevalley machine list --json")]
    List,
    /// Connect this host to a VibeValley control plane as a remote or ephemeral execution machine
    #[command(
        after_help = "Examples:\n  vibevalley machine up --server http://100.64.0.5:8890 --code ABC234 --name gpu-box\n  vibevalley machine up --server http://127.0.0.1:8790 --token vv_dev_... --scripted --once\n  vibevalley machine up --server https://hub.ts.net --ephemeral --workdir /tmp/work"
    )]
    Up(MachineUpArgs),
}

#[derive(Debug, Args)]
pub struct MachineUpArgs {
    /// One-time 6-character pairing code from `vibevalley remote code --scope remote:runtime`
    #[arg(long)]
    pub code: Option<String>,
    /// Human-readable display name for this execution machine
    #[arg(long)]
    pub name: Option<String>,
    /// Stable machine identifier (defaults to paired device id or a generated id)
    #[arg(long)]
    pub machine_id: Option<String>,
    /// Run as an ephemeral sandbox machine (does not persist machine-auth.json; cleans up worktrees on exit)
    #[arg(long)]
    pub ephemeral: bool,
    /// Base directory for isolated git worktrees and session workspaces
    #[arg(long, value_name = "DIR")]
    pub workdir: Option<PathBuf>,
    /// Restrict advertised local OAR runtimes to these ids (repeatable)
    #[arg(long, value_name = "ID")]
    pub runtime: Vec<String>,
    /// Advertise the deterministic offline scripted OAR runtime for testing and acceptance
    #[arg(long)]
    pub scripted: bool,
    /// Connect once without reconnecting after the WebSocket closes
    #[arg(long)]
    pub once: bool,
}

fn default_machine_id(ephemeral: bool) -> String {
    let prefix = if ephemeral { "sbx" } else { "machine" };
    let short = &Uuid::new_v4().simple().to_string()[..12];
    format!("{prefix}-{short}")
}

fn machine_line(machine: &MachineInfo) -> String {
    let kind = if machine.here {
        "local"
    } else if machine.ephemeral {
        "sandbox"
    } else {
        "remote"
    };
    let runtimes = machine
        .runtimes
        .iter()
        .filter(|r| r.available)
        .map(|r| r.id.as_str())
        .collect::<Vec<_>>()
        .join(",");
    line(&[&machine.id, &machine.name, machine.platform.as_str(), machine.status.as_str(), kind, &runtimes])
}

fn resolve_machine_up(client: &Client, args: &MachineUpArgs) -> Result<MachineAgentConfig, Failure> {
    if client.dry_run {
        return Err(no_dry_run("machine up"));
    }
    if client.flag_token().is_some() && args.code.is_some() {
        return Err(Failure::usage("ConflictingOption", "use either --token or --code, not both"));
    }

    let requested_name = non_empty_opt(args.name.clone(), "--name")?;
    let requested_machine_id = non_empty_opt(args.machine_id.clone(), "--machine-id")?;
    let saved_auth = if args.ephemeral { None } else { load_machine_auth(&client.home)? };

    let raw_server = client
        .explicit_server()
        .map(ToString::to_string)
        .or_else(|| saved_auth.as_ref().map(|cfg| cfg.server.clone()))
        .ok_or_else(|| Failure::usage("MissingArgument", "provide --server <URL> (or set VIBEVALLEY_SERVER)"))?;
    let server_url = normalize_server_url(&raw_server)?;

    let saved_for_server = saved_auth.as_ref().filter(|cfg| same_server(&server_url, &cfg.server));

    let (token, machine_id, machine_name) = if let Some(raw_code) = &args.code {
        let code = raw_code.trim();
        if code.is_empty() {
            return Err(Failure::usage("InvalidValue", "--code must not be empty"));
        }
        let device_name = requested_name.unwrap_or_else(default_device_name);
        let platform = if args.ephemeral { RemotePlatform::Sandbox } else { RemotePlatform::Machine };
        let target = client.for_target(server_url.clone(), None);
        let exchanged = target.ask::<ops::RemotePairExchange>(&RemotePairExchangeRequest {
            code: code.to_string(),
            device_name: device_name.clone(),
            platform,
            scope: Some(SCOPE_REMOTE_MACHINE.to_string()),
        })?;

        let token = MachineSecret::new(exchanged.token);
        let machine_id = requested_machine_id.unwrap_or_else(|| {
            if exchanged.device.id.trim().is_empty() {
                default_machine_id(args.ephemeral)
            } else {
                exchanged.device.id.clone()
            }
        });
        let resolved_name = if exchanged.device.name.trim().is_empty() {
            device_name
        } else {
            exchanged.device.name.clone()
        };

        if !args.ephemeral {
            let stored = MachineAuthConfig {
                server: server_url.clone(),
                token: token.clone(),
                machine_id: machine_id.clone(),
                machine_name: resolved_name.clone(),
                device_id: exchanged.device.id,
                server_name: (!exchanged.server_name.trim().is_empty()).then_some(exchanged.server_name),
                scope: (!exchanged.device.scope.trim().is_empty()).then_some(exchanged.device.scope),
            };
            save_machine_auth(&client.home, &stored)?;
        }

        (token, machine_id, resolved_name)
    } else {
        let env_machine_token = std::env::var("VIBEVALLEY_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(MachineSecret::new);
        let token = client
            .flag_token()
            .map(|s| MachineSecret::new(s.expose()))
            .or(env_machine_token)
            .or_else(|| client.env_token().map(|s| MachineSecret::new(s.expose())))
            .or_else(|| saved_for_server.map(|cfg| cfg.token.clone()))
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                Failure::usage(
                    "MissingArgument",
                    "provide --code <CODE>, --token <TOKEN>, VIBEVALLEY_TOKEN, or pair once to save machine-auth.json",
                )
            })?;

        let machine_id = requested_machine_id
            .or_else(|| saved_for_server.map(|cfg| cfg.machine_id.clone()))
            .unwrap_or_else(|| default_machine_id(args.ephemeral));
        let machine_name = requested_name
            .or_else(|| saved_for_server.map(|cfg| cfg.machine_name.clone()))
            .unwrap_or_else(default_device_name);

        (token, machine_id, machine_name)
    };

    let workdir = args
        .workdir
        .clone()
        .or_else(|| std::env::var_os("VIBEVALLEY_WORK_ROOT").filter(|s| !s.is_empty()).map(PathBuf::from))
        .unwrap_or_else(|| client.home.join("machine-work"));

    let mut cfg = MachineAgentConfig::new(server_url, token, machine_id, machine_name, workdir);
    cfg.ephemeral = args.ephemeral;
    cfg.once = args.once;
    Ok(cfg)
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(ref mut term) = sigterm {
                    term.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn run_up(client: &Client, args: MachineUpArgs) -> Done {
    let config = resolve_machine_up(client, &args)?;
    let registry = build_runtime_registry(&args.runtime, args.scripted);
    let cancel = CancellationToken::new();
    let agent = MachineAgent::new(config, registry, cancel.clone());

    vibevalley_runtime::rt::block_on(async move {
        let sig_cancel = cancel.clone();
        let sig_task = tokio::spawn(async move {
            wait_for_shutdown_signal().await;
            sig_cancel.cancel();
        });
        let result = agent.run().await;
        sig_task.abort();
        let _ = sig_task.await;
        result
    })
}

pub fn run(client: &Client, cmd: MachineCmd) -> Done {
    match cmd.action {
        MachineAction::List => {
            let machines = client.ask::<ops::MachineList>(&())?;
            client.output.show(&machines, |ms| ms.iter().map(machine_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        MachineAction::Up(args) => run_up(client, args),
    }
}
