//! `mcp`: standard stdio MCP (Model Context Protocol) JSON-RPC 2.0 server exposing
//! VibeValley Issues, collaborative Notes (+ SEP-2640 `skill://note/*` guides),
//! and live VDP debugging tools to external coding and ACP agents.
//!
//! Stdout is reserved strictly for newline-delimited JSON-RPC 2.0 responses;
//! all diagnostics go to stderr.

mod issue;
mod note;
mod note_defs;
mod server;
mod vdp;

use std::path::PathBuf;

use clap::{Args, ValueEnum};
use vibevalley_mcp::serve_stdio;
use vibevalley_protocol::home::ReleaseChannel;

use self::server::McpServer;
use self::server::{format_failure, non_empty_trimmed, redact_result, tool_def};
use crate::client::{Client, Done, Failure, exit};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ChannelArg {
    Dev,
    Alpha,
    Beta,
    Release,
}

impl From<ChannelArg> for ReleaseChannel {
    fn from(arg: ChannelArg) -> Self {
        match arg {
            ChannelArg::Dev => ReleaseChannel::Dev,
            ChannelArg::Alpha => ReleaseChannel::Alpha,
            ChannelArg::Beta => ReleaseChannel::Beta,
            ChannelArg::Release => ReleaseChannel::Release,
        }
    }
}

#[derive(Debug, Clone, Default, Args)]
#[command(
    after_help = "Examples:\n  vibevalley mcp\n  vibevalley mcp --channel alpha\n  vibevalley mcp --home ~/.vibevalley-alpha --vdp-port 9223\n  vibevalley mcp --vdp-url ws://127.0.0.1:9223/devtools"
)]
pub struct McpCmd {
    /// Target release channel (resolves to that channel's canonical home and default port)
    #[arg(long, value_enum, conflicts_with = "home")]
    pub channel: Option<ChannelArg>,

    /// Default VibeValley home directory containing server.json and debug.json
    #[arg(long, value_name = "DIR", conflicts_with = "channel")]
    pub home: Option<PathBuf>,

    /// Default loopback VDP port
    #[arg(long, value_name = "PORT")]
    pub vdp_port: Option<u16>,

    /// Default explicit VDP WebSocket or HTTP URL (e.g. ws://127.0.0.1:9222/devtools)
    #[arg(long, value_name = "URL")]
    pub vdp_url: Option<String>,
}

pub async fn run(client: &Client, cmd: McpCmd) -> Done {
    let server = McpServer::new(client, cmd);
    serve_stdio(&server)
        .await
        .map_err(|err| Failure::new(exit::OTHER, "Io", format!("MCP stdio error: {err}")))
}
