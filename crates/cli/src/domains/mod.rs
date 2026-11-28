//! Top-level CLI parser and exhaustive domain dispatcher.

pub mod collab;
pub mod content;
pub mod debug;
pub mod infra;
pub mod mcp;
pub mod team;
pub mod work;

use clap::{Parser, Subcommand};

use crate::auth::Secret;
use crate::client::{Client, Done};

/// Local CLI for the VibeValley workbench server.
#[derive(Debug, Parser)]
#[command(
    name = "vibevalley",
    version,
    arg_required_else_help = true,
    subcommand_required = true,
    propagate_version = false,
    disable_help_subcommand = true
)]
pub struct Cli {
    /// Server base URL (defaults to VIBEVALLEY_SERVER, <home>/auth.json, <home>/server.json, or the channel port)
    #[arg(long, global = true, value_name = "URL")]
    pub server: Option<String>,

    /// Bearer token for remote authentication (defaults to VIBEVALLEY_REMOTE_TOKEN or <home>/auth.json)
    #[arg(long, global = true, value_name = "TOKEN")]
    pub token: Option<Secret>,

    /// Preview what a mutating command would do without changing state
    #[arg(long, global = true)]
    pub dry_run: bool,

    /// Print raw protocol JSON instead of human-readable text
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Manage issues, transitions, reviews, diffs, and watches
    Issue(work::issue::IssueCmd),
    /// Inspect and stop worker execution sessions
    Session(work::session::SessionCmd),
    /// Manage repositories and submit pull requests
    Repo(work::repo::RepoCmd),
    /// Schedule recurring or one-shot jobs
    Cron(work::cron::CronCmd),

    /// Manage worker and orchestrator agent profiles
    Agent(team::agent::AgentCmd),
    /// Inspect and refresh coding runtimes
    Runtime(team::runtime::RuntimeCmd),
    /// Manage agent memories
    Memory(team::memory::MemoryCmd),

    /// List, create, pin, and message channels
    Channel(collab::channel::ChannelCmd),
    /// Talk to the server orchestrator in a channel
    Chat(collab::chat::ChatCmd),

    /// Manage notes, block docs, multi-dimensional bases, canvases, and media
    Note(content::note::NoteCmd),
    /// Manage media library items
    Library(content::library::LibraryCmd),
    /// Inspect media jobs and upload binary media inputs
    Media(content::media::MediaCmd),
    /// Upload and download raw attachments
    Attachment(content::attachment::AttachmentCmd),

    /// Snapshot or stream state slices from /api/v1/slice/<name>
    State(infra::state::StateCmd),
    /// Read, validate, and update server settings
    Setting(infra::setting::SettingCmd),
    /// Manage CLI authentication credentials and active server identity
    Auth(infra::auth::AuthCmd),
    /// Manage remote access listener, pairing codes, and paired devices
    Remote(infra::remote::RemoteCmd),
    /// List execution machines and run the outbound machine daemon
    Machine(infra::machine::MachineCmd),
    /// Verify home, server, SSE slice stream, runtimes, and model key
    Doctor(infra::doctor::DoctorCmd),
    /// Discover and live-debug running VibeValley instances over VDP
    Debug(debug::DebugCmd),
    /// Run a stdio MCP (Model Context Protocol) JSON-RPC 2.0 server for Issues and VDP
    Mcp(mcp::McpCmd),
}

pub async fn run(client: &Client, command: Command) -> Done {
    match command {
        Command::Issue(cmd) => work::issue::run(client, cmd).await,
        Command::Session(cmd) => work::session::run(client, cmd).await,
        Command::Repo(cmd) => work::repo::run(client, cmd).await,
        Command::Cron(cmd) => work::cron::run(client, cmd).await,

        Command::Agent(cmd) => team::agent::run(client, cmd).await,
        Command::Runtime(cmd) => team::runtime::run(client, cmd).await,
        Command::Memory(cmd) => team::memory::run(client, cmd).await,

        Command::Channel(cmd) => collab::channel::run(client, cmd).await,
        Command::Chat(cmd) => collab::chat::run(client, cmd).await,

        Command::Note(cmd) => content::note::run(client, cmd).await,
        Command::Library(cmd) => content::library::run(client, cmd).await,
        Command::Media(cmd) => content::media::run(client, cmd).await,
        Command::Attachment(cmd) => content::attachment::run(client, cmd).await,

        Command::State(cmd) => infra::state::run(client, cmd).await,
        Command::Setting(cmd) => infra::setting::run(client, cmd).await,
        Command::Auth(cmd) => infra::auth::run(client, cmd).await,
        Command::Remote(cmd) => infra::remote::run(client, cmd).await,
        Command::Machine(cmd) => infra::machine::run(client, cmd).await,
        Command::Doctor(cmd) => infra::doctor::run(client, cmd).await,
        Command::Debug(cmd) => debug::run(client, cmd).await,
        Command::Mcp(cmd) => mcp::run(client, cmd).await,
    }
}
