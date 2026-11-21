//! The command tree on clap, its words in the farm's language: every
//! command has a description and examples (`EXAMPLES`), every argument
//! its help; and reading back what was given.

use clap::builder::PossibleValuesParser;
use clap::{Arg, ArgAction, ArgMatches, Command};
use vibevalley_i18n::t;

/// A key's words, or the text itself when it is not a key.
fn word(s: &str) -> String {
    if s.starts_with("cli.") { t(s, &[]) } else { s.to_string() }
}

pub fn group(name: &'static str, about: &str, subs: Vec<Command>) -> Command {
    Command::new(name)
        .about(word(about))
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand_help_heading("SUBCOMMANDS")
        .subcommands(subs)
}

/// A command, with its examples as (command, what it does).
pub fn cmd(name: &'static str, about: &str, examples: &[(&str, &str)]) -> Command {
    let mut text = String::from("EXAMPLES:\n");
    for (run, what) in examples {
        text += &format!("  $ {}\n    {}\n", word(run), word(what));
    }
    Command::new(name).about(word(about)).after_help(text)
}

pub fn pos(name: &'static str, help: &str) -> Arg {
    Arg::new(name).required(true).help(word(help))
}

/// One or more words, joined by a space.
pub fn words(name: &'static str, help: &str) -> Arg {
    Arg::new(name).required(true).num_args(1..).help(word(help))
}

pub fn maybe_words(name: &'static str, help: &str) -> Arg {
    Arg::new(name).num_args(0..).help(word(help))
}

pub fn flag(long: &'static str, help: &str) -> Arg {
    Arg::new(long).long(long).action(ArgAction::SetTrue).help(word(help))
}

pub fn text(long: &'static str, help: &str) -> Arg {
    Arg::new(long).long(long).num_args(1).help(word(help))
}

pub fn int(long: &'static str, help: &str) -> Arg {
    text(long, help).value_parser(clap::value_parser!(i64))
}

pub fn choice(long: &'static str, values: impl IntoIterator<Item = &'static str>, help: &str) -> Arg {
    text(long, help).value_parser(PossibleValuesParser::new(values))
}

pub fn pos_choice(name: &'static str, values: impl IntoIterator<Item = &'static str>, help: &str) -> Arg {
    pos(name, help).value_parser(PossibleValuesParser::new(values))
}

pub fn many(long: &'static str, help: &str) -> Arg {
    text(long, help).action(ArgAction::Append)
}

pub fn get(m: &ArgMatches, name: &str) -> Option<String> {
    m.get_one::<String>(name).cloned()
}

/// A given argument, or "" (a required one is always given).
pub fn arg(m: &ArgMatches, name: &str) -> String {
    get(m, name).unwrap_or_default()
}

pub fn all(m: &ArgMatches, name: &str) -> Vec<String> {
    m.get_many::<String>(name).map(|v| v.cloned().collect()).unwrap_or_default()
}

pub fn joined(m: &ArgMatches, name: &str) -> String {
    all(m, name).join(" ")
}

pub fn on(m: &ArgMatches, name: &str) -> bool {
    m.get_flag(name)
}

pub fn number(m: &ArgMatches, name: &str) -> Option<i64> {
    m.get_one::<i64>(name).copied()
}
