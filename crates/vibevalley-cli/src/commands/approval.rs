use clap::{ArgMatches, Command};
use vibevalley_i18n::t;
use vibevalley_protocol::{OrchestratorApprovalListInput, OrchestratorApprovalResolveInput, ops};

use crate::farm::{Ctx, Done};
use crate::tree::{arg, cmd, get, group, pos, pos_choice, text};

pub fn command() -> Command {
    group(
        "approval",
        "cli.approval.about",
        vec![
            cmd("list", "cli.approval.list", &[("vibevalley approval list --format json", "cli.approval.list")])
                .arg(text("conversation", "cli.approval.conversation")),
            cmd(
                "resolve",
                "cli.approval.resolve",
                &[("vibevalley approval resolve orchestrator task-1 call-1 approve", "cli.approval.resolve")],
            )
            .args([
                pos("conversation", "cli.approval.conversation"),
                pos("task", "cli.approval.task"),
                pos("tool-call", "cli.approval.toolCall"),
                pos_choice("decision", ["approve", "deny"], "cli.approval.decision"),
                text("reason", "cli.approval.reason"),
            ]),
        ],
    )
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", sub)) => {
            let approvals = ctx.ask::<ops::OrchestratorApprovalList>(&OrchestratorApprovalListInput {
                conversation_id: get(sub, "conversation"),
            })?;
            ctx.show(&approvals, |approvals| {
                approvals
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
        Some(("resolve", sub)) => ctx.change::<ops::OrchestratorApprovalResolve>(
            "approval resolve",
            None,
            &OrchestratorApprovalResolveInput {
                conversation_id: arg(sub, "conversation"),
                task_id: arg(sub, "task"),
                tool_call_id: arg(sub, "tool-call"),
                approved: arg(sub, "decision") == "approve",
                reason: get(sub, "reason"),
            },
            |_| t("cli.approval.saved", &[]),
        ),
        _ => Ok(()),
    }
}
