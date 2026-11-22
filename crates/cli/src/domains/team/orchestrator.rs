//! `orchestrator open|stop` and `orchestrator approval list|resolve`.

use clap::{Args, Subcommand, ValueEnum};
use vibevalley_protocol::{OrchestratorApprovalListInput, OrchestratorApprovalResolveInput, OrchestratorStopInput, ops};

use crate::client::{Client, Done};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct OrchestratorCmd {
    #[command(subcommand)]
    pub action: OrchestratorAction,
}

#[derive(Debug, Subcommand)]
pub enum OrchestratorAction {
    /// Start or wake the server orchestrator
    #[command(after_help = "Examples:\n  vibevalley orchestrator open")]
    Open,
    /// Stop the active orchestrator run
    #[command(after_help = "Examples:\n  vibevalley orchestrator stop\n  vibevalley orchestrator stop --agent main")]
    Stop {
        /// Optional orchestrator profile id
        #[arg(long)]
        agent: Option<String>,
    },
    /// Inspect and resolve pending tool approvals
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
    /// List pending orchestrator tool approvals
    #[command(after_help = "Examples:\n  vibevalley orchestrator approval list --json")]
    List {
        /// Optional conversation id filter
        #[arg(long)]
        conversation: Option<String>,
    },
    /// Approve or deny a pending orchestrator tool call
    #[command(after_help = "Examples:\n  vibevalley orchestrator approval resolve orchestrator task-1 call-1 approve")]
    Resolve {
        /// Conversation id
        conversation: String,
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

pub fn run(client: &Client, cmd: OrchestratorCmd) -> Done {
    match cmd.action {
        OrchestratorAction::Open => client.mutate::<ops::OrchestratorOpen>("orchestrator open", &(), |_| "orchestrator open".into()),
        OrchestratorAction::Stop { agent } => {
            client.mutate::<ops::OrchestratorStop>("orchestrator stop", &OrchestratorStopInput { agent }, |_| "orchestrator stopped".into())
        }
        OrchestratorAction::Approval(approval) => match approval.action {
            ApprovalAction::List { conversation } => {
                let approvals = client.ask::<ops::OrchestratorApprovalList>(&OrchestratorApprovalListInput { conversation_id: conversation })?;
                client.output.show(&approvals, |items| {
                    items
                        .iter()
                        .map(|item| {
                            format!(
                                "{}  {}  {}  {}  {}  {}",
                                item.conversation_id, item.task_id, item.tool_call_id, item.tool_name, item.arguments_json, item.reason
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ApprovalAction::Resolve {
                conversation,
                task,
                tool_call,
                decision,
                reason,
            } => client.mutate::<ops::OrchestratorApprovalResolve>(
                "orchestrator approval resolve",
                &OrchestratorApprovalResolveInput {
                    conversation_id: conversation,
                    task_id: task,
                    tool_call_id: tool_call,
                    approved: matches!(decision, ApprovalDecision::Approve),
                    reason,
                },
                |_| "saved".into(),
            ),
        },
    }
}
