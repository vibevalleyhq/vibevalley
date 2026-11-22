//! `runtime list|refresh`.

use clap::{Args, Subcommand};
use vibevalley_protocol::{Installation, RuntimeInfo, RuntimeRefreshInput, ops};

use crate::client::{Client, Done};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct RuntimeCmd {
    #[command(subcommand)]
    pub action: RuntimeAction,
}

#[derive(Debug, Subcommand)]
pub enum RuntimeAction {
    /// List available coding runtimes and installation status
    #[command(after_help = "Examples:\n  vibevalley runtime list")]
    List,
    /// Re-probe a runtime's installation and capabilities
    #[command(after_help = "Examples:\n  vibevalley runtime refresh claude")]
    Refresh {
        /// Runtime id
        runtime: String,
    },
}

fn runtime_line(runtime: &RuntimeInfo) -> String {
    let state = match &runtime.installation {
        Installation::Available(a) => format!("{} {}", a.version.clone().unwrap_or_default(), a.command).trim().to_string(),
        Installation::Unsupported(failure) if failure.sign_in_command.is_some() => "login_required".into(),
        Installation::NotFound(_) => "not_found".into(),
        Installation::Checking(_) => "checking".into(),
        Installation::Unsupported(_) => "unsupported".into(),
    };
    format!("{}  {state}", runtime.id)
}

pub fn run(client: &Client, cmd: RuntimeCmd) -> Done {
    match cmd.action {
        RuntimeAction::List => {
            let runtimes = client.ask::<ops::RuntimeList>(&())?;
            client.output.show(&runtimes, |rs| rs.iter().map(runtime_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        RuntimeAction::Refresh { runtime } => client.mutate::<ops::RuntimeRefresh>("runtime refresh", &RuntimeRefreshInput { id: runtime }, runtime_line),
    }
}
