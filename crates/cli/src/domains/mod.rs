//! Top-level CLI parser and exhaustive domain dispatcher.

pub mod collab;
pub mod content;
pub mod infra;
pub mod team;
pub mod work;

use clap::{Parser, Subcommand};

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
    /// Server base URL (defaults to VIBEVALLEY_SERVER, <home>/server.json, or the channel port)
    #[arg(long, global = true, value_name = "URL")]
    pub server: Option<String>,

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
    /// Control the orchestrator and tool approvals
    Orchestrator(team::orchestrator::OrchestratorCmd),
    /// Inspect and refresh coding runtimes
    Runtime(team::runtime::RuntimeCmd),
    /// Manage agent memories
    Memory(team::memory::MemoryCmd),

    /// List, create, pin, and message channels
    Channel(collab::channel::ChannelCmd),
    /// Talk to the server orchestrator in a channel
    Chat(collab::chat::ChatCmd),

    /// Manage artifacts and structured store entries
    Artifact(content::artifact::ArtifactCmd),
    /// Capture, search, and manage outline notes
    Pkm(content::pkm::PkmCmd),
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
    /// Verify home, server, SSE slice stream, runtimes, and model key
    Doctor(infra::doctor::DoctorCmd),
}

pub fn run(client: &Client, command: Command) -> Done {
    match command {
        Command::Issue(cmd) => work::issue::run(client, cmd),
        Command::Session(cmd) => work::session::run(client, cmd),
        Command::Repo(cmd) => work::repo::run(client, cmd),
        Command::Cron(cmd) => work::cron::run(client, cmd),

        Command::Agent(cmd) => team::agent::run(client, cmd),
        Command::Orchestrator(cmd) => team::orchestrator::run(client, cmd),
        Command::Runtime(cmd) => team::runtime::run(client, cmd),
        Command::Memory(cmd) => team::memory::run(client, cmd),

        Command::Channel(cmd) => collab::channel::run(client, cmd),
        Command::Chat(cmd) => collab::chat::run(client, cmd),

        Command::Artifact(cmd) => content::artifact::run(client, cmd),
        Command::Pkm(cmd) => content::pkm::run(client, cmd),
        Command::Library(cmd) => content::library::run(client, cmd),
        Command::Media(cmd) => content::media::run(client, cmd),
        Command::Attachment(cmd) => content::attachment::run(client, cmd),

        Command::State(cmd) => infra::state::run(client, cmd),
        Command::Setting(cmd) => infra::setting::run(client, cmd),
        Command::Doctor(cmd) => infra::doctor::run(client, cmd),
    }
}
