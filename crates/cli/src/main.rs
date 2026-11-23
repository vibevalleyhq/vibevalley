//! `vibevalley`, the pure HTTP CLI for the VibeValley local server.
//!
//! Results print to stdout (compact lines, or raw protocol JSON with `--json`);
//! failures print one JSON line to stderr and exit with a typed status code (`vibevalley_cli::exit`).

mod auth;
mod client;
mod domains;
mod output;

use crate::client::Client;

fn main() {
    std::process::exit(vibevalley_cli::run_cli(std::env::args_os(), |cli: domains::Cli| {
        let client = Client::new(cli.server, cli.token, cli.dry_run, cli.json);
        domains::run(&client, cli.command)
    }));
}
