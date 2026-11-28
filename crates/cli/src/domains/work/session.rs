//! `session list|show|events|stop|compact|run-code|approval`.

use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};
use vibevalley_protocol::{
    JsNumber, Phase, Session, SessionApprovalListInput, SessionApprovalResolveInput, SessionCompactInput, SessionCompactResult, SessionEvent,
    SessionEventListInput, SessionGetInput, SessionListInput, SessionRunCodeInput, SessionStopInput, ops,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

use crate::client::{Client, Done, Failure, exit};
use crate::output::{line, one_line};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct SessionCmd {
    #[command(subcommand)]
    pub action: SessionAction,
}

#[derive(Debug, Subcommand)]
pub enum SessionAction {
    /// List sessions
    #[command(after_help = "Examples:\n  vibevalley session list\n  vibevalley session list --profile docs")]
    List {
        /// Filter by agent profile id
        #[arg(long)]
        profile: Option<String>,
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
        /// Fetch events strictly before this sequence number
        #[arg(long)]
        before: Option<i64>,
        /// Fetch events strictly after this sequence number
        #[arg(long)]
        after: Option<i64>,
        /// Maximum number of events to return
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Stop an active session
    #[command(after_help = "Examples:\n  vibevalley session stop w3")]
    Stop {
        /// Session id
        session: String,
    },
    /// Manually compact conversation context for a session
    #[command(after_help = "Examples:\n  vibevalley session compact orchestrator\n  vibevalley session compact w3")]
    Compact {
        /// Session id
        session: String,
    },
    /// Run a durable CodeMode JavaScript task in a session's context
    #[command(
        after_help = "Examples:\n  vibevalley session run-code orchestrator 'return { ok: true };'\n  vibevalley session run-code orchestrator --file ./check.js"
    )]
    RunCode {
        /// Session id
        session: String,
        /// Inline JavaScript body (omit when passing --file)
        script: Option<String>,
        /// Read the JavaScript body from a local file
        #[arg(long)]
        file: Option<PathBuf>,
        /// Deterministic RNG seed override
        #[arg(long)]
        seed: Option<u64>,
        /// Execution timeout in milliseconds
        #[arg(long)]
        timeout_ms: Option<i64>,
        /// Maximum VM step budget
        #[arg(long)]
        max_steps: Option<i64>,
    },
    /// Inspect and resolve pending tool approvals on a session
    Approval(ApprovalCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ApprovalCmd {
    #[command(subcommand)]
    pub action: ApprovalAction,
}

#[derive(Debug, Subcommand)]
pub enum ApprovalAction {
    /// List pending session tool approvals
    #[command(after_help = "Examples:\n  vibevalley session approval list --json")]
    List {
        /// Optional session id filter
        #[arg(long)]
        session: Option<String>,
    },
    /// Approve or deny a pending session tool call
    #[command(after_help = "Examples:\n  vibevalley session approval resolve orchestrator task-1 call-1 approve")]
    Resolve {
        /// Session id
        session: String,
        /// Task id
        task: String,
        /// Tool call id
        tool_call: String,
        /// Decision
        #[arg(value_enum)]
        decision: ApprovalDecision,
        /// Optional explanation recorded with the decision
        #[arg(long)]
        reason: Option<String>,
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
    let issue = session.issue_id().map(|i| format!("issue {i}")).unwrap_or_default();
    let repo = session.repo_name().map(|r| format!("[{r}]")).unwrap_or_default();
    let who = session.profile_id().unwrap_or(&session.runtime);
    line(&[&session.id, &session.name, &format!("@{who}"), phase_tag(&session.phase), &issue, &repo])
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

pub async fn run(client: &Client, cmd: SessionCmd) -> Done {
    match cmd.action {
        SessionAction::List { profile } => {
            let sessions = client.ask::<ops::SessionList>(&SessionListInput { profile, controller: None }).await?;
            client.output.show(&sessions, |ss| ss.iter().map(session_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        SessionAction::Show { session } => {
            let found = client.ask::<ops::SessionGet>(&SessionGetInput { id: session }).await?;
            client.output.show(&found, |s| {
                [
                    session_line(s),
                    s.brief.lines().next().unwrap_or("").to_string(),
                    s.cwd.clone().unwrap_or_default(),
                ]
                .into_iter()
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
            });
            Ok(())
        }
        SessionAction::Events {
            session,
            run,
            before,
            after,
            limit,
        } => {
            let page = client
                .ask::<ops::SessionEventList>(&SessionEventListInput {
                    id: session,
                    run,
                    before_seq: before,
                    after_seq: after,
                    limit,
                })
                .await?;
            client.output.show(&page, |p| {
                let mut lines: Vec<String> = p.events.iter().map(event_line).collect();
                if p.has_more
                    && let Some(oldest) = p.oldest_seq
                {
                    lines.push(format!("more available: pass --before {oldest}"));
                }
                lines.join("\n")
            });
            Ok(())
        }
        SessionAction::Stop { session } => {
            let id = session.clone();
            client
                .mutate::<ops::SessionStop>("session stop", &SessionStopInput { id: session }, |_| format!("stopped {id}"))
                .await
        }
        SessionAction::Compact { session } => {
            client
                .mutate::<ops::SessionCompact>("session compact", &SessionCompactInput { id: session }, |r: &SessionCompactResult| {
                    if r.compacted {
                        match &r.summary {
                            Some(s) if !s.trim().is_empty() => format!("compacted {}\n{}", r.id, one_line(s)),
                            _ => format!("compacted {}", r.id),
                        }
                    } else {
                        format!("no compaction performed for {} ({})", r.id, r.reason.as_deref().unwrap_or("already compact"))
                    }
                })
                .await
        }
        SessionAction::RunCode {
            session,
            script,
            file,
            seed,
            timeout_ms,
            max_steps,
        } => {
            let body = match (script, file) {
                (Some(_), Some(_)) => {
                    return Err(Failure::new(exit::USAGE, "InvalidInput", "pass either inline script or --file, not both"));
                }
                (Some(s), None) => s,
                (None, Some(path)) => {
                    std::fs::read_to_string(&path).map_err(|e| Failure::new(exit::OTHER, "Io", format!("failed to read {}: {e}", path.display())))?
                }
                (None, None) => {
                    return Err(Failure::new(exit::USAGE, "MissingArgument", "provide inline script or --file"));
                }
            };
            client
                .mutate::<ops::SessionRunCode>(
                    "session run-code",
                    &SessionRunCodeInput {
                        id: session,
                        script: body,
                        seed: seed.map(|s| JsNumber(s as f64)),
                        timeout_ms,
                        max_steps,
                    },
                    |r| {
                        format!(
                            "{} ({} steps, {} calls, {} sleeps)\n{}",
                            r.task_id, r.executed_steps, r.replayed_calls, r.replayed_sleeps, r.output_json
                        )
                    },
                )
                .await
        }
        SessionAction::Approval(approval) => match approval.action {
            ApprovalAction::List { session } => {
                let approvals = client.ask::<ops::SessionApprovalList>(&SessionApprovalListInput { id: session }).await?;
                client.output.show(&approvals, |items| {
                    items
                        .iter()
                        .map(|item| {
                            format!(
                                "{}  {}  {}  {}  {}  {}",
                                item.id, item.task_id, item.tool_call_id, item.tool_name, item.arguments_json, item.reason
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ApprovalAction::Resolve {
                session,
                task,
                tool_call,
                decision,
                reason,
            } => {
                client
                    .mutate::<ops::SessionApprovalResolve>(
                        "session approval resolve",
                        &SessionApprovalResolveInput {
                            id: session,
                            task_id: task,
                            tool_call_id: tool_call,
                            approved: matches!(decision, ApprovalDecision::Approve),
                            reason,
                        },
                        |_| "saved".into(),
                    )
                    .await
            }
        },
    }
}
