use std::path::PathBuf;

use vibevalley_core::note::doc::{DocDocument, markdown_to_blocks, serialize_doc_document};
use vibevalley_protocol::{
    ApiError, AppliedIssue, BaseRunAgentColumnRequest, BaseRunAgentColumnResult, BizCode, Caller, Issue, IssueBodyEnsureInput, IssueBodyEnsureResult,
    IssueUpdateInput, NoteFileEncoding, NoteFileWriteItem, NoteFileWriteRequest, NoteRequest, NoteSuggestionCreateInput, NoteType, NoteUpdateRequest,
    SuggestionChange,
};

use super::glue::AppCore;
use crate::context::api::CallerContext;
use crate::issue::NewIssue;
use crate::note::base::ExecutedAgentCellOutcome;

fn serialize_markdown_doc(markdown: &str) -> Result<String, ApiError> {
    let doc = DocDocument {
        version: 1,
        blocks: markdown_to_blocks(markdown),
    };
    serialize_doc_document(&doc).map_err(|e| ApiError::new(BizCode::NoteRefused, e))
}

async fn ensure_body_note_for_issue(c: &AppCore, ctx: &CallerContext, issue: &Issue) -> Result<IssueBodyEnsureResult, ApiError> {
    if let Some(nid) = issue.body_note_id.as_deref()
        && let Ok(existing) = c.note.get_async(nid).await
    {
        let doc_view = c.note.doc_view_async(nid).await?;
        return Ok(IssueBodyEnsureResult {
            issue: issue.clone(),
            note: existing,
            doc_view,
        });
    }
    let doc_json = serialize_markdown_doc(&issue.description)?;
    let req = NoteRequest {
        title: issue.title.clone(),
        note_type: NoteType::Doc,
        parent_id: None,
        sort_order: None,
        content: None,
        files: Some(vec![NoteFileWriteItem {
            path: "structure/doc.json".to_owned(),
            content: doc_json,
            encoding: Some(NoteFileEncoding::Utf8),
            mime: Some("application/json".to_owned()),
            expected_hash: None,
        }]),
        announce: Some(false),
        note: None,
        channel: None,
        issue: Some(issue.id.clone()),
    };
    let created = c.note.create_for_caller_async(ctx, &req).await?;
    let updated = c.board.set_body_note_id_async(&issue.id, created.id.clone()).await?;
    let doc_view = c.note.doc_view_async(&created.id).await?;
    Ok(IssueBodyEnsureResult {
        issue: updated,
        note: created,
        doc_view,
    })
}

pub(crate) async fn issue_body_ensure(c: &AppCore, ctx: &CallerContext, r: &IssueBodyEnsureInput) -> Result<IssueBodyEnsureResult, ApiError> {
    let issue = c.board.get_async(&r.id).await?;
    ensure_body_note_for_issue(c, ctx, &issue).await
}

pub(crate) async fn issue_update(c: &AppCore, ctx: &CallerContext, mut r: IssueUpdateInput) -> Result<AppliedIssue, ApiError> {
    let current = c.board.get_async(&r.id).await?;
    let mut divert_to_note: Option<(String, String)> = None;
    let mut sync_user_desc = false;

    if let Some(ref desc) = r.description
        && let Some(nid) = current.body_note_id.as_ref()
    {
        if !matches!(ctx.caller, Caller::User) {
            divert_to_note = Some((nid.clone(), desc.clone()));
            r.description = None;
        } else {
            sync_user_desc = true;
        }
    }

    if let Some((nid, proposed_md)) = divert_to_note {
        let existing_note = c.note.get_async(&nid).await?;
        let proposed_json = serialize_markdown_doc(&proposed_md)?;
        let _ = c
            .note
            .create_suggestion_for_caller_async(
                ctx,
                &NoteSuggestionCreateInput {
                    id: nid,
                    path: "structure/doc.json".to_owned(),
                    base_rev: existing_note.seq,
                    base_hash: None,
                    change: SuggestionChange {
                        content: Some(proposed_json),
                        patch: None,
                        target: None,
                        delete: None,
                        summary: Some("Proposed update to issue body".to_owned()),
                    },
                    cursor_start: None,
                    cursor_end: None,
                    start_offset: None,
                    end_offset: None,
                },
            )
            .await?;
    }

    let next_title = r.title.clone();
    let applied = c.board.issue_update_endpoint_async(r).await?;

    if sync_user_desc && let Some(nid) = applied.body_note_id.as_deref() {
        let doc_json = serialize_markdown_doc(&applied.description)?;
        let _ = c
            .note
            .write_for_caller_async(
                ctx,
                &NoteFileWriteRequest {
                    id: nid.to_owned(),
                    files: vec![NoteFileWriteItem {
                        path: "structure/doc.json".to_owned(),
                        content: doc_json,
                        encoding: Some(NoteFileEncoding::Utf8),
                        mime: Some("application/json".to_owned()),
                        expected_hash: None,
                    }],
                    origin: None,
                    summary: Some("Sync issue description".to_owned()),
                    announce: Some(false),
                },
            )
            .await;
    }

    if let Some(title) = next_title
        && !title.trim().is_empty()
        && let Some(nid) = applied.body_note_id.as_deref()
    {
        let _ = c
            .note
            .update_async(&NoteUpdateRequest {
                id: nid.to_owned(),
                title: Some(title),
                parent_id: None,
                sort_order: None,
                issue: None,
            })
            .await;
    }

    Ok(applied)
}

/// Idempotently converts existing issues that already carry non-empty Markdown
/// descriptions without a `body_note_id` into collaborative Doc notes on startup.
pub(crate) async fn backfill_issue_bodies_async(c: &AppCore) {
    let Ok(issues) = c.board.issues_without_body_note_async().await else {
        return;
    };
    let local = CallerContext::local();
    let mut migrated = 0usize;
    for issue in issues {
        if issue.description.trim().is_empty() {
            continue;
        }
        match ensure_body_note_for_issue(c, &local, &issue).await {
            Ok(_) => migrated += 1,
            Err(err) => {
                tracing::warn!(issue_id = %issue.id, error = %err, "issue body backfill skipped");
            }
        }
    }
    if migrated > 0 {
        tracing::info!(migrated, "backfilled existing issue bodies into doc notes");
    }
}

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
