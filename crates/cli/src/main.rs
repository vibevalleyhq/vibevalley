//! `vibevalley`, the pure HTTP CLI for the VibeValley local server.
//!
//! Results print to stdout (compact lines, or raw protocol JSON with `--json`);
//! failures print one JSON line to stderr and exit with a typed status code (`client::exit`).

mod client;
mod domains;
mod output;

use clap::Parser;
use clap::error::ErrorKind;

use crate::client::{Client, Failure, exit};

fn main() {
    std::process::exit(run(std::env::args_os()));
}

fn parse_failure(err: &clap::Error) -> Failure {
    let tag = match err.kind() {
        ErrorKind::MissingRequiredArgument | ErrorKind::TooFewValues => "MissingArgument",
        ErrorKind::UnknownArgument => "UnrecognizedOption",
        ErrorKind::InvalidSubcommand => "UnknownSubcommand",
        ErrorKind::MissingSubcommand => "MissingSubcommand",
        ErrorKind::ArgumentConflict => "ConflictingOption",
        _ => "InvalidValue",
    };
    let text = err.to_string();
    let first = text.lines().next().unwrap_or("").trim_start_matches("error: ").to_string();
    Failure::usage(tag, first)
}

fn run(args: impl IntoIterator<Item = std::ffi::OsString>) -> i32 {
    let cli = match domains::Cli::try_parse_from(args) {
        Ok(parsed) => parsed,
        Err(err) => {
            return match err.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
                    print!("{}", err.render());
                    exit::OK
                }
                _ => {
                    parse_failure(&err).print();
                    exit::USAGE
                }
            };
        }
    };
    let client = Client::new(cli.server, cli.dry_run, cli.json);
    match domains::run(&client, cli.command) {
        Ok(()) => exit::OK,
        Err(failure) => {
            failure.print();
            failure.code
        }
    }
}
