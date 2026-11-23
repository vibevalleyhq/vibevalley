//! Shared CLI entry, exit codes, output formatting, structured error helpers,
//! and the outbound machine execution daemon (`machine_agent`).

pub mod machine_agent;

use std::ffi::OsString;
use std::io::Write;

use clap::Parser;
use clap::error::ErrorKind;
use serde::Serialize;
use serde_json::json;
use vibevalley_protocol::Next;

/// Process exit codes scripts can branch on.
pub mod exit {
    pub const OK: i32 = 0;
    pub const OTHER: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const REFUSED: i32 = 3;
    pub const MISSING: i32 = 4;
    pub const UNREACHABLE: i32 = 5;
}

/// Structured command failure printed as one JSON line on stderr.
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: i32,
    pub tag: String,
    pub text: String,
    pub biz_code: Option<u32>,
    pub status: Option<u16>,
    pub next: Vec<Next>,
}

impl Failure {
    pub fn new(code: i32, tag: &str, text: impl Into<String>) -> Self {
        Self {
            code,
            tag: tag.into(),
            text: text.into(),
            biz_code: None,
            status: None,
            next: vec![],
        }
    }

    pub fn usage(tag: &str, text: impl Into<String>) -> Self {
        Self::new(exit::USAGE, tag, text)
    }

    pub fn print(&self) {
        let mut error = json!({ "tag": self.tag, "message": self.text });
        if let Some(code) = self.biz_code {
            error["bizCode"] = json!(code);
        }
        if let Some(status) = self.status {
            error["status"] = json!(status);
        }
        if !self.next.is_empty() {
            error["next"] = json!(self.next);
        }
        eprintln!("{}", json!({ "error": error }));
    }
}

pub type Done = Result<(), Failure>;

pub fn no_dry_run(command: &str) -> Failure {
    Failure::usage("NoDryRun", format!("{command} does not support --dry-run"))
}

/// Controls whether stdout prints raw protocol JSON or compact human lines.
#[derive(Debug, Clone, Copy)]
pub struct Output {
    pub json: bool,
}

impl Output {
    pub fn show<T: Serialize>(&self, value: &T, format: impl FnOnce(&T) -> String) {
        if self.json {
            out(&serde_json::to_string(value).unwrap_or_else(|_| "null".into()));
        } else {
            let text = format(value);
            if !text.is_empty() {
                out(&text);
            }
        }
    }
}

/// Writes one line directly to stdout.
pub fn out(text: &str) {
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{text}");
}

/// Translates a `clap` argument error into a typed usage [`Failure`].
pub fn parse_failure(err: &clap::Error) -> Failure {
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

/// Parses `args` into `C`, prints help/version cleanly, runs `execute`, and returns the process exit code.
pub fn run_cli<C: Parser>(args: impl IntoIterator<Item = OsString>, execute: impl FnOnce(C) -> Done) -> i32 {
    let cli = match C::try_parse_from(args) {
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
    match execute(cli) {
        Ok(()) => exit::OK,
        Err(failure) => {
            failure.print();
            failure.code
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::Subcommand;

    use super::*;

    #[derive(Debug, Parser)]
    #[command(name = "sample", arg_required_else_help = true, subcommand_required = true)]
    struct SampleCli {
        #[arg(long, global = true)]
        json: bool,
        #[command(subcommand)]
        command: SampleCommand,
    }

    #[derive(Debug, Subcommand)]
    enum SampleCommand {
        Ping {
            #[arg(long)]
            target: String,
        },
    }

    fn os_args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn parse_failure_maps_clap_error_kinds_to_typed_tags() {
        let missing_sub = SampleCli::try_parse_from(["sample", "--json"]).unwrap_err();
        assert_eq!(parse_failure(&missing_sub).tag, "MissingSubcommand");

        let unknown_sub = SampleCli::try_parse_from(["sample", "bogus"]).unwrap_err();
        assert_eq!(parse_failure(&unknown_sub).tag, "UnknownSubcommand");

        let missing_arg = SampleCli::try_parse_from(["sample", "ping"]).unwrap_err();
        assert_eq!(parse_failure(&missing_arg).tag, "MissingArgument");

        let unknown_opt = SampleCli::try_parse_from(["sample", "ping", "--nope"]).unwrap_err();
        assert_eq!(parse_failure(&unknown_opt).tag, "UnrecognizedOption");
    }

    #[test]
    fn run_cli_returns_typed_exit_codes() {
        assert_eq!(run_cli::<SampleCli>(os_args(&["sample"]), |_| Ok(())), exit::OK);
        assert_eq!(run_cli::<SampleCli>(os_args(&["sample", "--help"]), |_| Ok(())), exit::OK);
        assert_eq!(run_cli::<SampleCli>(os_args(&["sample", "bogus"]), |_| Ok(())), exit::USAGE);
        assert_eq!(
            run_cli::<SampleCli>(os_args(&["sample", "--json", "ping", "--target", "ok"]), |cli| {
                assert!(cli.json);
                let SampleCommand::Ping { target } = cli.command;
                assert_eq!(target, "ok");
                Ok(())
            }),
            exit::OK
        );
        assert_eq!(
            run_cli::<SampleCli>(os_args(&["sample", "ping", "--target", "nope"]), |_| {
                Err(Failure::new(exit::REFUSED, "Refused", "denied"))
            }),
            exit::REFUSED
        );
    }
}
