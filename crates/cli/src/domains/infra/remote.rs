//! `remote status|enable|disable|code|revoke`: manage the server's remote access listener, pairing codes, and paired devices.

use clap::{Args, Subcommand};
use serde_json::json;
use vibevalley_protocol::{RemoteDeviceRevokeRequest, RemoteDeviceSummary, RemoteEnableRequest, RemotePairCode, RemoteStatus, ops};

use crate::client::{Client, Done, Failure, decode_failure, no_dry_run};
use crate::output::{line, minute_of};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct RemoteCmd {
    #[command(subcommand)]
    pub action: RemoteAction,
}

#[derive(Debug, Subcommand)]
pub enum RemoteAction {
    /// Show remote listener status, Tailscale address, and paired devices
    #[command(after_help = "Examples:\n  vibevalley remote status\n  vibevalley remote status --json")]
    Status,
    /// Enable and start the authenticated remote HTTP listener
    #[command(after_help = "Examples:\n  vibevalley remote enable\n  vibevalley remote enable --bind 127.0.0.1 --port 8890")]
    Enable {
        /// Optional bind IP address (defaults to Tailscale IPv4 or 127.0.0.1)
        #[arg(long)]
        bind: Option<String>,
        /// Optional listening port
        #[arg(long)]
        port: Option<u16>,
    },
    /// Disable and stop the remote HTTP listener
    #[command(after_help = "Examples:\n  vibevalley remote disable")]
    Disable,
    /// Mint a one-time 6-character pairing code and deep-link pair URL
    #[command(after_help = "Examples:\n  vibevalley remote code\n  vibevalley remote code --scope remote:runtime --json")]
    Code {
        /// Optional requested Bearer token scope (e.g. remote:default or remote:runtime)
        #[arg(long)]
        scope: Option<String>,
    },
    /// Revoke a paired remote device by id
    #[command(after_help = "Examples:\n  vibevalley remote revoke dev_01abc...")]
    Revoke {
        /// Paired device id to revoke
        device_id: String,
    },
}

fn device_line(dev: &RemoteDeviceSummary) -> String {
    let state = if dev.revoked_at.is_some() { "revoked" } else { "active" };
    line(&[&dev.id, &dev.name, dev.platform.as_str(), &dev.scope, state])
}

fn status_text(status: &RemoteStatus) -> String {
    let mut lines = vec![line(&[
        "remote",
        if status.enabled { "enabled" } else { "disabled" },
        if status.listening { "listening" } else { "stopped" },
        status.url.as_deref().unwrap_or(""),
    ])];
    if let Some(addr) = &status.bind_addr {
        lines.push(line(&["bind", &format!("{addr}:{}", status.port)]));
    }
    if status.tailscale_online {
        lines.push(line(&[
            "tailscale",
            "online",
            status.tailscale_ip.as_deref().unwrap_or(""),
            status.tailscale_host.as_deref().unwrap_or(""),
        ]));
    } else {
        lines.push(line(&["tailscale", "offline"]));
    }
    for dev in &status.devices {
        lines.push(format!("  {}", device_line(dev)));
    }
    lines.join("\n")
}

fn pair_code_text(code: &RemotePairCode) -> String {
    let expires = minute_of(code.expires_at);
    let mut lines = vec![
        line(&["code", &code.code]),
        line(&["expires", if expires.is_empty() { "" } else { &expires }]),
        line(&["url", &code.url]),
        line(&["pair-url", &code.pair_url]),
    ];
    if let Some(scope) = &code.scope {
        lines.push(line(&["scope", scope]));
    }
    lines.join("\n")
}

pub fn run(client: &Client, cmd: RemoteCmd) -> Done {
    match cmd.action {
        RemoteAction::Status => {
            let status = client.ask::<ops::RemoteStatus>(&())?;
            client.output.show(&status, status_text);
            Ok(())
        }
        RemoteAction::Enable { bind, port } => {
            let req = RemoteEnableRequest { bind_addr: bind, port };
            client.mutate::<ops::RemoteEnable>("remote enable", &req, status_text)
        }
        RemoteAction::Disable => client.mutate::<ops::RemoteDisable>("remote disable", &(), status_text),
        RemoteAction::Code { scope } => {
            if client.dry_run {
                return Err(no_dry_run("remote code"));
            }
            let code: RemotePairCode = match scope {
                Some(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        return Err(Failure::usage("InvalidValue", "--scope must not be empty"));
                    }
                    let raw_val = client.ask_raw("remote.pair.create", &json!({ "scope": trimmed }))?;
                    serde_json::from_value(raw_val).map_err(decode_failure)?
                }
                None => client.ask::<ops::RemotePairCreate>(&())?,
            };
            client.output.show(&code, pair_code_text);
            Ok(())
        }
        RemoteAction::Revoke { device_id } => {
            let id = device_id.trim().to_string();
            if id.is_empty() {
                return Err(Failure::usage("InvalidValue", "DEVICE_ID must not be empty"));
            }
            let label = id.clone();
            client.mutate::<ops::RemoteDeviceRevoke>("remote revoke", &RemoteDeviceRevokeRequest { id }, |_| format!("revoked {label}"))
        }
    }
}
