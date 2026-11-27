use std::path::PathBuf;

use vibevalley_protocol::{ApiError, BaseRunAgentColumnRequest, BaseRunAgentColumnResult};

use super::glue::AppCore;
use crate::context::api::CallerContext;
use crate::issue::NewIssue;
use crate::note::base::ExecutedAgentCellOutcome;

pub(crate) async fn base_run_agent_column(c: &AppCore, ctx: &CallerContext, r: &BaseRunAgentColumnRequest) -> Result<BaseRunAgentColumnResult, ApiError> {
    let plan = c.note.prepare_base_agent_column_async(r).await?;
    let mut outcomes = Vec::with_capacity(plan.tasks.len());
    for task in &plan.tasks {
        let mut outcome = ExecutedAgentCellOutcome {
            row_id: task.row_id.clone(),
            column_id: plan.column_id.clone(),
            target_column_id: task.target_column_id.clone(),
            status: "done".to_owned(),
            summary: format!("Prepared task: {}", task.row_title),
            session_id: None,
            spawned_issue_id: None,
        };
        if let Some(repo) = &task.spawn_issue_repo {
            match c
                .board
                .create_async(NewIssue {
                    title: task.row_title.clone(),
                    description: task.rendered_prompt.clone(),
                    repo: Some(PathBuf::from(repo)),
                    agent: task.agent_id.clone().unwrap_or_default(),
                    ..Default::default()
                })
                .await
            {
                Ok(issue) => {
                    outcome.status = "spawned".to_owned();
                    outcome.summary = format!("Spawned issue #{}", issue.number);
                    outcome.spawned_issue_id = Some(issue.id);
                }
                Err(err) => {
                    outcome.status = "error".to_owned();
                    outcome.summary = err.to_string();
                }
            }
        }
        outcomes.push(outcome);
    }
    let (maker, _, _) = c.note.caller_meta(ctx);
    c.note.apply_base_agent_column_outcomes_async(&maker, &plan, &outcomes).await
}
