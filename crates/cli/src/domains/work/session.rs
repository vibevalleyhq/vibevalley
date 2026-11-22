//! `session list|show|events|stop`.

use clap::{Args, Subcommand};
use vibevalley_protocol::{Phase, Session, SessionEvent, SessionEventListInput, SessionGetInput, SessionListInput, SessionStopInput, ops};

use crate::client::{Client, Done};
use crate::output::{line, one_line};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct SessionCmd {
    #[command(subcommand)]
    pub action: SessionAction,
}

#[derive(Debug, Subcommand)]
pub enum SessionAction {
    /// List worker and orchestrator sessions
    #[command(after_help = "Examples:\n  vibevalley session list\n  vibevalley session list --agent docs")]
    List {
        /// Filter by agent profile id
        #[arg(long)]
        agent: Option<String>,
    },
    /// Show details for a single session
    #[command(after_help = "Examples:\n  vibevalley session show w3")]
    Show {
        /// Session id
        session: String,
    },
    /// List trajectory events for a session
    #[command(after_help = "Examples:\n  vibevalley session events w3\n  vibevalley session events w3 --limit 20")]
    Events {
        /// Session id
        session: String,
        /// Filter to a specific run id
        #[arg(long)]
        run: Option<String>,
        /// Show only the last N events
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Stop an active session
    #[command(after_help = "Examples:\n  vibevalley session stop w3")]
    Stop {
        /// Session id
        session: String,
    },
}

fn phase_tag(phase: &Phase) -> &'static str {
    match phase {
        Phase::Working(_) => "working",
        Phase::Done(_) => "done",
        Phase::Failed(_) => "failed",
        Phase::Resting(_) => "resting",
        Phase::Closed(_) => "closed",
    }
}

fn session_line(session: &Session) -> String {
    let issue = session.issue.as_ref().map(|i| format!("issue {i}")).unwrap_or_default();
    let repo = session.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
    line(&[
        &session.id,
        &session.name,
        &format!("@{}", session.agent),
        phase_tag(&session.phase),
        &issue,
        &repo,
    ])
}

fn event_line(event: &SessionEvent) -> String {
    let tool = event.tool.as_deref().or_else(|| event.action.map(|a| a.as_str())).unwrap_or("");
    let detail = [&event.text, event.input.as_deref().unwrap_or(""), event.output.as_deref().unwrap_or("")]
        .into_iter()
        .map(one_line)
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let ok = match event.ok {
        Some(true) => "ok",
        Some(false) => "fail",
        None => "",
    };
    line(&[&event.seq.to_string(), event.r#type.as_str(), tool, &detail, ok])
}

pub fn run(client: &Client, cmd: SessionCmd) -> Done {
    match cmd.action {
        SessionAction::List { agent } => {
            let sessions = client.ask::<ops::SessionList>(&SessionListInput { agent })?;
            client.output.show(&sessions, |ss| ss.iter().map(session_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        SessionAction::Show { session } => {
            let found = client.ask::<ops::SessionGet>(&SessionGetInput { id: session })?;
            client.output.show(&found, |s| {
                [
                    session_line(s),
                    s.brief.lines().next().unwrap_or("").to_string(),
                    s.worktree.clone().unwrap_or_default(),
                ]
                .into_iter()
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
            });
            Ok(())
        }
        SessionAction::Events { session, run, limit } => {
            let mut events = client.ask::<ops::SessionEventList>(&SessionEventListInput { id: session, run })?;
            if let Some(max) = limit.map(|n| n.max(0) as usize)
                && events.len() > max
            {
                let start = events.len() - max;
                events.drain(..start);
            }
            client.output.show(&events, |es| es.iter().map(event_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        SessionAction::Stop { session } => {
            let id = session.clone();
            client.mutate::<ops::SessionStop>("session stop", &SessionStopInput { id: session }, |_| format!("stopped {id}"))
        }
    }
}
