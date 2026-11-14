//! `vibevalley`, the command line: for the agents on this machine first and
//! for people too. One command is one operation of the server's,
//! `<resource> [<sub-resource>] <verb>`; it asks the server over HTTP with
//! the protocol's types and works out nothing the server decides.
//!
//! A result goes to stdout (words, or the protocol's shape with
//! `--format json`); a failure is one JSON line on stderr and an exit code
//! by kind (`farm::exit`).

mod commands;
mod farm;
mod tree;

use clap::error::ErrorKind;
use farm::{Ctx, Failure, Format, exit};

fn main() {
    vibevalley_i18n::set_locale(vibevalley_home::saved_locale(&vibevalley_home::home()));
    std::process::exit(run(std::env::args_os()));
}

/// The parser's mistakes as the failures a script reads.
fn parse_failure(e: &clap::Error) -> Failure {
    let tag = match e.kind() {
        ErrorKind::MissingRequiredArgument | ErrorKind::TooFewValues => "MissingArgument",
        ErrorKind::UnknownArgument => "UnrecognizedOption",
        ErrorKind::InvalidSubcommand => "UnknownSubcommand",
        ErrorKind::MissingSubcommand => "MissingSubcommand",
        ErrorKind::ArgumentConflict => "ConflictingOption",
        _ => "InvalidValue",
    };
    let text = e.to_string();
    let first = text.lines().next().unwrap_or("").trim_start_matches("error: ").to_string();
    Failure::usage(tag, first)
}

fn run(args: impl IntoIterator<Item = std::ffi::OsString>) -> i32 {
    let matches = match commands::tree().try_get_matches_from(args) {
        Ok(m) => m,
        Err(e) => {
            return match e.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
                    print!("{}", e.render());
                    exit::OK
                }
                _ => {
                    parse_failure(&e).print();
                    exit::USAGE
                }
            };
        }
    };
    let ctx = Ctx {
        server: tree::get(&matches, "server")
            .or_else(|| std::env::var("VIBEVALLEY_SERVER").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(farm::default_server),
        dry_run: tree::on(&matches, "dry-run"),
        format: if tree::get(&matches, "format").as_deref() == Some("json") {
            Format::Json
        } else {
            Format::Text
        },
        worker_access_file: tree::get(&matches, "worker-access-file")
            .or_else(|| std::env::var("VIBEVALLEY_WORKER_ACCESS_FILE").ok())
            .unwrap_or_default(),
    };
    match commands::run(&ctx, &matches) {
        Ok(()) => exit::OK,
        Err(f) => {
            f.print();
            f.code
        }
    }
}
