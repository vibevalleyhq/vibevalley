//! The command tree and where each command runs.

mod approval;
mod chat;
mod doctor;
mod eval;
mod farm;
mod issue;
mod pkm;
mod setting;

use clap::{ArgMatches, Command};
use vibevalley_i18n::t;

use crate::farm::{Ctx, Done, FALLBACK_SERVER};
use crate::tree::{choice, flag, text};

pub fn tree() -> Command {
    Command::new("vibevalley")
        .version(env!("CARGO_PKG_VERSION"))
        .about(t("cli.about", &[]))
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand_help_heading("SUBCOMMANDS")
        .args([
            text("server", "cli.flag.server")
                .help(t("cli.flag.server", &[("fallback", FALLBACK_SERVER.into())]))
                .global(true),
            flag("dry-run", "cli.flag.dryRun").global(true),
            choice("format", ["text", "json"], "cli.flag.format").global(true),
        ])
        .subcommands([
            issue::command(),
            farm::channel(),
            farm::repo(),
            farm::agent(),
            farm::session(),
            farm::runtime(),
            farm::memory(),
            farm::cron(),
            farm::artifact(),
            pkm::command(),
            setting::command(),
            chat::command(),
            eval::command(),
            approval::command(),
            doctor::command(),
        ])
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    let Some((group, sub)) = m.subcommand() else { return Ok(()) };
    match group {
        "issue" => issue::run(ctx, sub),
        "channel" => farm::run_channel(ctx, sub),
        "repo" => farm::run_repo(ctx, sub),
        "agent" => farm::run_agent(ctx, sub),
        "session" => farm::run_session(ctx, sub),
        "runtime" => farm::run_runtime(ctx, sub),
        "memory" => farm::run_memory(ctx, sub),
        "cron" => farm::run_cron(ctx, sub),
        "artifact" => farm::run_artifact(ctx, sub),
        "pkm" => pkm::run(ctx, sub),
        "setting" => setting::run(ctx, sub),
        "chat" => chat::run(ctx, sub),
        "eval" => eval::run(ctx, sub),
        "approval" => approval::run(ctx, sub),
        "doctor" => doctor::run(ctx),
        _ => Ok(()),
    }
}
