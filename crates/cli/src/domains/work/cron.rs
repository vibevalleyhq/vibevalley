//! `cron list|create|edit|delete`.

use clap::{ArgAction, ArgGroup, Args, Subcommand};
use vibevalley_protocol::{Cron, CronDeleteInput, CronRequest, CronUpdateInput, CronWhen, CronWhenDaily, CronWhenEvery, CronWhenExpr, CronWhenOnce, ops};

use crate::client::{Client, Done, Failure};
use crate::output::{line, one_line};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct CronCmd {
    #[command(subcommand)]
    pub action: CronAction,
}

#[derive(Debug, Subcommand)]
pub enum CronAction {
    /// List scheduled jobs
    #[command(after_help = "Examples:\n  vibevalley cron list")]
    List,
    /// Create a scheduled job
    #[command(
        group = ArgGroup::new("schedule").required(true).multiple(false),
        after_help = "Examples:\n  vibevalley cron create morning 'check yesterday changes' --daily 09:00\n  vibevalley cron create once-check 'run audit' --at 2099-11-05T09:00"
    )]
    Create {
        /// Job name
        name: String,
        /// Prompt text delivered when the job fires
        #[arg(required = true, num_args = 1..)]
        words: Vec<String>,
        /// Run every N minutes
        #[arg(long, group = "schedule")]
        every: Option<i64>,
        /// Run daily at HH:MM
        #[arg(long, group = "schedule")]
        daily: Option<String>,
        /// Standard 5-field cron expression
        #[arg(long, group = "schedule")]
        cron: Option<String>,
        /// Run once at an ISO-8601 timestamp or local YYYY-MM-DDTHH:MM
        #[arg(long, group = "schedule")]
        at: Option<String>,
        /// Target channel id
        #[arg(long)]
        channel: Option<String>,
        /// Target agent profile id
        #[arg(long)]
        agent: Option<String>,
        /// Target repository name
        #[arg(long)]
        repo: Option<String>,
    },
    /// Enable or disable a scheduled job
    #[command(after_help = "Examples:\n  vibevalley cron edit c1 --enabled false")]
    Edit {
        /// Cron job id
        cron: String,
        /// Whether the job is enabled (true or false)
        #[arg(long, action = ArgAction::Set)]
        enabled: bool,
    },
    /// Delete a scheduled job
    #[command(after_help = "Examples:\n  vibevalley cron delete c1 --dry-run")]
    Delete {
        /// Cron job id
        cron: String,
    },
}

fn when_text(when: &CronWhen) -> String {
    match when {
        CronWhen::Once(o) => format!("once {}", jiff::Timestamp::from_millisecond(o.at).map(|t| t.to_string()).unwrap_or_default()),
        CronWhen::Every(e) => format!("every {}m", e.minutes),
        CronWhen::Daily(d) => format!("daily {}", d.time),
        CronWhen::Weekly(w) => format!("weekly {} {}", w.days.iter().map(i64::to_string).collect::<Vec<_>>().join(","), w.time),
        CronWhen::Cron(c) => format!("cron {}", c.expr),
    }
}

fn cron_line(cron: &Cron) -> String {
    line(&[
        &cron.id,
        &cron.name,
        &when_text(&cron.when),
        if cron.enabled { "" } else { "off" },
        &one_line(&cron.text),
    ])
}

fn parse_at(raw: &str) -> Result<i64, Failure> {
    if let Ok(ts) = raw.parse::<jiff::Timestamp>() {
        return Ok(ts.as_millisecond());
    }
    if let Ok(zoned) = raw.parse::<jiff::ZonedDateTime>() {
        return Ok(zoned.timestamp().as_millisecond());
    }
    if let Ok(dt) = raw.parse::<jiff::civil::DateTime>()
        && let Ok(zoned) = dt.to_zoned_datetime(jiff::tz::TimeZone::system())
    {
        return Ok(zoned.timestamp().as_millisecond());
    }
    Err(Failure::usage("InvalidValue", format!("invalid timestamp {raw:?}")))
}

pub async fn run(client: &Client, cmd: CronCmd) -> Done {
    match cmd.action {
        CronAction::List => {
            let crons = client.ask::<ops::CronList>(&()).await?;
            client.output.show(&crons, |cs| cs.iter().map(cron_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        CronAction::Create {
            name,
            words,
            every,
            daily,
            cron,
            at,
            channel,
            agent,
            repo,
        } => {
            let when = if let Some(minutes) = every {
                CronWhen::Every(CronWhenEvery { minutes })
            } else if let Some(time) = daily {
                CronWhen::Daily(CronWhenDaily { time })
            } else if let Some(expr) = cron {
                CronWhen::Cron(CronWhenExpr { expr })
            } else {
                CronWhen::Once(CronWhenOnce {
                    at: parse_at(&at.unwrap_or_default())?,
                })
            };
            let request = CronRequest {
                name,
                text: words.join(" "),
                when,
                channel,
                agent,
                repo,
                tz: None,
            };
            client.mutate::<ops::CronCreate>("cron create", &request, cron_line).await
        }
        CronAction::Edit { cron, enabled } => {
            let id = cron.clone();
            let request = CronUpdateInput {
                id: cron,
                enabled: Some(enabled),
            };
            client.mutate::<ops::CronUpdate>("cron edit", &request, |_| format!("updated {id}")).await
        }
        CronAction::Delete { cron } => {
            let id = cron.clone();
            client
                .mutate::<ops::CronDelete>("cron delete", &CronDeleteInput { id: cron }, |_| format!("deleted {id}"))
                .await
        }
    }
}
