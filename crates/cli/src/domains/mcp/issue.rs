//! `vv_issue_*` and `vv_attachment_upload` MCP tools.

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use vibevalley_mcp::{ToolCallResult, ToolDef};
use vibevalley_protocol::{
    ActorRef, AppliedIssue, AttachmentUpload, Issue, IssueCommentCreateInput, IssueConversationGetInput, IssueFilter, IssueGetInput, IssueRequest, IssueStatus,
    IssueStatusUpdateInput, IssueUpdate, IssueUpdateInput, JsNumber, Priority, SayRequest, ops,
};

use super::{McpServer, format_failure, non_empty_trimmed, redact_result, tool_def};
use crate::output::{guess_mime, issue_ref};

/// Accepts an issue reference as either a JSON string (`"12"`, `"#12"`, `"iss_..."`) or integer (`12`).
fn deserialize_issue_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrInt {
        Str(String),
        Int(i64),
        Uint(u64),
    }

    match StringOrInt::deserialize(deserializer)? {
        StringOrInt::Str(s) => Ok(s),
        StringOrInt::Int(n) => Ok(n.to_string()),
        StringOrInt::Uint(n) => Ok(n.to_string()),
    }
}

/// Accepts an optional issue reference as a JSON string (`"12"`, `"#12"`, `"iss_..."`, `""`), integer (`12`), or null.
fn deserialize_optional_issue_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OptStringOrInt {
        Str(String),
        Int(i64),
        Uint(u64),
    }

    match Option::<OptStringOrInt>::deserialize(deserializer)? {
        None => Ok(None),
        Some(OptStringOrInt::Str(s)) => Ok(Some(s)),
        Some(OptStringOrInt::Int(n)) => Ok(Some(n.to_string())),
        Some(OptStringOrInt::Uint(n)) => Ok(Some(n.to_string())),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueListArgs {
    #[serde(default)]
    status: Option<IssueStatus>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    closed: Option<bool>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueGetArgs {
    #[serde(deserialize_with = "deserialize_issue_id")]
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueCreateArgs {
    pub(super) title: String,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(default)]
    pub(super) priority: Option<Priority>,
    #[serde(default)]
    pub(super) status: Option<IssueStatus>,
    #[serde(default)]
    pub(super) repo: Option<String>,
    #[serde(default)]
    pub(super) agent: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_issue_id")]
    pub(super) parent: Option<String>,
    #[serde(default)]
    pub(super) tags: Option<Vec<String>>,
    #[serde(default)]
    pub(super) start_at: Option<JsNumber>,
    #[serde(default)]
    pub(super) due_at: Option<JsNumber>,
    #[serde(default)]
    pub(super) criteria: Option<Vec<String>>,
    #[serde(default)]
    pub(super) attachments: Option<Vec<String>>,
    #[serde(default)]
    pub(super) owner: Option<ActorRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueUpdateArgs {
    #[serde(deserialize_with = "deserialize_issue_id")]
    pub(super) id: String,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(default)]
    pub(super) status: Option<IssueStatus>,
    #[serde(default)]
    pub(super) priority: Option<Priority>,
    #[serde(default)]
    pub(super) repo: Option<String>,
    #[serde(default)]
    pub(super) agent: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_issue_id")]
    pub(super) parent: Option<String>,
    #[serde(default)]
    pub(super) tags: Option<Vec<String>>,
    #[serde(default)]
    pub(super) start_at: Option<JsNumber>,
    #[serde(default)]
    pub(super) due_at: Option<JsNumber>,
    #[serde(default)]
    pub(super) criteria: Option<Vec<String>>,
    #[serde(default)]
    pub(super) attachments: Option<Vec<String>>,
    #[serde(default)]
    pub(super) owner: Option<ActorRef>,
    #[serde(default)]
    pub(super) comment: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueCommentArgs {
    #[serde(alias = "id", deserialize_with = "deserialize_issue_id")]
    issue_id: String,
    text: String,
    #[serde(default)]
    attachments: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadArgs {
    path: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    mime: Option<String>,
}

pub(super) fn tool_definitions() -> Vec<ToolDef> {
    vec![
        tool_def(
            "vv_issue_list",
            "List issues on the target VibeValley board with optional status, repo, or assigned agent filters.",
            json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "in_review", "done", "canceled"], "description": "Filter by issue status." },
                    "repo": { "type": "string", "description": "Filter by repository name." },
                    "agent": { "type": "string", "description": "Filter by assigned agent profile id or name." },
                    "text": { "type": "string", "description": "Optional title/description substring filter." },
                    "closed": { "type": "boolean", "description": "Include closed (done/canceled) issues." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Maximum number of issues to return (default 50)." }
                }
            }),
        ),
        tool_def(
            "vv_issue_get",
            "Read full details of a VibeValley issue, including description, acceptance criteria, questions, findings, and stage.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Issue number (e.g. '12' or '#12') or issue id." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_issue_create",
            "Create a new issue directly on the VibeValley board.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Concise issue title." },
                    "description": { "type": "string", "description": "Detailed description, repro steps, or visual findings." },
                    "priority": { "type": "string", "enum": ["urgent", "high", "medium", "low"], "description": "Issue priority level." },
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "in_review", "done", "canceled"], "description": "Optional target status after creation (server defaults to backlog)." },
                    "repo": { "type": "string", "description": "Optional repository name." },
                    "agent": { "type": "string", "description": "Optional assigned agent profile id." },
                    "parent": { "type": "string", "description": "Optional parent issue number (e.g. '10' or '#10') or issue id." },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional issue tags (e.g. ['UX', 'MCP'])." },
                    "startAt": { "type": "number", "description": "Optional planned start timestamp in Unix milliseconds." },
                    "dueAt": { "type": "number", "description": "Optional target due timestamp in Unix milliseconds." },
                    "criteria": { "type": "array", "items": { "type": "string" }, "description": "Optional acceptance criteria list." },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Optional uploaded attachment ids." },
                    "owner": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["user", "agent"] },
                            "id": { "type": "string" }
                        },
                        "required": ["kind", "id"],
                        "additionalProperties": false,
                        "description": "Optional final owner reference ({ kind: 'user' | 'agent', id }); defaults to local user 'self'."
                    }
                },
                "required": ["title"]
            }),
        ),
        tool_def(
            "vv_issue_update",
            "Update an existing VibeValley issue's title, description, priority, repo, agent, owner, parent, tags, startAt, dueAt, criteria, attachments, or transition its status.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Issue number (e.g. '12' or '#12') or issue id." },
                    "title": { "type": "string", "description": "Updated title." },
                    "description": { "type": "string", "description": "Updated description." },
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "in_review", "done", "canceled"], "description": "Optional target status transition." },
                    "priority": { "type": "string", "enum": ["urgent", "high", "medium", "low"], "description": "Updated priority." },
                    "repo": { "type": "string", "description": "Updated repository name." },
                    "agent": { "type": "string", "description": "Updated assigned agent profile id." },
                    "owner": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["user", "agent"] },
                            "id": { "type": "string" }
                        },
                        "required": ["kind", "id"],
                        "additionalProperties": false,
                        "description": "Updated final owner reference ({ kind: 'user' | 'agent', id }), or empty id '' to clear owner."
                    },
                    "parent": { "type": "string", "description": "Updated parent issue number/id, or empty string '' to clear parent." },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Replacement issue tags list." },
                    "startAt": { "type": "number", "description": "Updated planned start timestamp in Unix milliseconds (0 clears it)." },
                    "dueAt": { "type": "number", "description": "Updated target due timestamp in Unix milliseconds (0 clears it)." },
                    "criteria": { "type": "array", "items": { "type": "string" }, "description": "Replacement acceptance criteria list." },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Replacement uploaded attachment ids." },
                    "comment": { "type": "string", "description": "Optional comment attached to a status transition." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_issue_comment",
            "Post a comment (optionally with uploaded attachment ids or ```compare markdown blocks) to a VibeValley issue thread.",
            json!({
                "type": "object",
                "properties": {
                    "issueId": { "type": "string", "description": "Issue number (e.g. '12' or '#12') or issue id (alias: 'id')." },
                    "text": { "type": "string", "description": "Comment body text (Markdown, including ```compare blocks)." },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Optional uploaded attachment ids to attach to the comment." }
                },
                "required": ["issueId", "text"]
            }),
        ),
        tool_def(
            "vv_attachment_upload",
            "Read a local file (e.g. before/after PNG screenshot) from disk and upload it via attachment.create, returning { id, name, type, size }.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Local file path to read and upload." },
                    "name": { "type": "string", "description": "Optional display filename override." },
                    "mime": { "type": "string", "description": "Optional MIME type override (inferred from extension when omitted)." }
                },
                "required": ["path"]
            }),
        ),
    ]
}

fn matches_agent(issue: &Issue, agent_filter: &str) -> bool {
    issue
        .assignments
        .iter()
        .rev()
        .find(|a| a.ended_at.is_none())
        .or_else(|| issue.assignments.last())
        .is_some_and(|a| a.agent.eq_ignore_ascii_case(agent_filter))
}

impl McpServer {
    pub(super) async fn tool_issue_list(&self, raw_args: Value) -> ToolCallResult {
        let args: IssueListArgs = match Self::decode_args("vv_issue_list", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        self.refresh_client().await;
        let limit = args.limit.unwrap_or(50).clamp(1, 200);
        let agent_filter = non_empty_trimmed(args.agent);
        let filter = IssueFilter {
            status: args.status,
            repo: non_empty_trimmed(args.repo),
            text: non_empty_trimmed(args.text),
            closed: args.closed,
            // Fetch extra rows before client-side agent filtering so matches are not cut off early.
            limit: Some(if agent_filter.is_some() { 200 } else { limit }),
            wants_user: None,
        };

        let client = self.client.read().await;
        let result = match client.ask::<ops::IssueList>(&filter).await {
            Ok(mut issues) => {
                if let Some(agent) = agent_filter.as_deref() {
                    issues.retain(|issue| matches_agent(issue, agent));
                }
                issues.truncate(limit as usize);
                ToolCallResult::json(&json!({
                    "count": issues.len(),
                    "issues": issues,
                }))
            }
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_issue_get(&self, raw_args: Value) -> ToolCallResult {
        let args: IssueGetArgs = match Self::decode_args("vv_issue_get", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = issue_ref(args.id.trim());
        if id.is_empty() {
            return ToolCallResult::error("vv_issue_get requires a non-empty id");
        }
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::IssueGet>(&IssueGetInput { id }).await {
            Ok(issue) => ToolCallResult::json(&issue),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_issue_create(&self, raw_args: Value) -> ToolCallResult {
        let args: IssueCreateArgs = match Self::decode_args("vv_issue_create", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let title = args.title.trim().to_string();
        if title.is_empty() {
            return ToolCallResult::error("vv_issue_create requires a non-empty title");
        }
        self.refresh_client().await;
        let request = IssueRequest {
            title,
            description: non_empty_trimmed(args.description),
            repo: non_empty_trimmed(args.repo),
            agent: non_empty_trimmed(args.agent),
            parent: non_empty_trimmed(args.parent).map(|p| issue_ref(&p)),
            tags: args.tags.filter(|t| !t.is_empty()),
            start_at: args.start_at,
            due_at: args.due_at,
            priority: args.priority,
            criteria: args.criteria.filter(|c| !c.is_empty()),
            attachments: args.attachments.filter(|a| !a.is_empty()),
            owner: args.owner,
            ..Default::default()
        };

        let client = self.client.read().await;
        let created: AppliedIssue = match client.ask::<ops::IssueCreate>(&request).await {
            Ok(issue) => issue,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
        };

        let final_issue = if let Some(target_status) = args.status
            && target_status != created.status
        {
            let status_req = IssueStatusUpdateInput {
                revision: None,
                id: created.id.clone(),
                status: target_status,
                text: None,
                agent: None,
                edit: None,
                request_key: None,
            };
            match client.ask::<ops::IssueStatusUpdate>(&status_req).await {
                Ok(updated) => updated,
                Err(failure) => {
                    return redact_result(
                        ToolCallResult::error(format!(
                            "created issue #{} ({}), but failed to set status to {}: {}",
                            created.number,
                            created.id,
                            target_status.as_str(),
                            format_failure(&failure)
                        )),
                        &Self::known_secrets(&client, None),
                    );
                }
            }
        } else {
            created
        };

        redact_result(ToolCallResult::json(&final_issue), &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_issue_update(&self, raw_args: Value) -> ToolCallResult {
        let args: IssueUpdateArgs = match Self::decode_args("vv_issue_update", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = issue_ref(args.id.trim());
        if id.is_empty() {
            return ToolCallResult::error("vv_issue_update requires a non-empty id");
        }
        let title = non_empty_trimmed(args.title);
        let description = args.description;
        let repo = non_empty_trimmed(args.repo);
        let agent = non_empty_trimmed(args.agent);
        let parent = args.parent.map(|p| {
            let trimmed = p.trim();
            if trimmed.is_empty() { String::new() } else { issue_ref(trimmed) }
        });
        let tags = args.tags;
        let start_at = args.start_at;
        let due_at = args.due_at;
        let priority = args.priority;
        let criteria = args.criteria;
        let attachments = args.attachments;
        let owner = args.owner;
        let comment = non_empty_trimmed(args.comment);

        let has_field_edits = title.is_some()
            || description.is_some()
            || repo.is_some()
            || agent.is_some()
            || owner.is_some()
            || parent.is_some()
            || tags.is_some()
            || start_at.is_some()
            || due_at.is_some()
            || priority.is_some()
            || criteria.is_some()
            || attachments.is_some();

        self.refresh_client().await;
        let client = self.client.read().await;
        let result = if let Some(target_status) = args.status {
            let edit = has_field_edits.then(|| IssueUpdate {
                title,
                description,
                repo,
                agent,
                owner,
                parent,
                tags,
                start_at,
                due_at,
                priority,
                criteria,
                attachments,
                ..Default::default()
            });
            let req = IssueStatusUpdateInput {
                revision: None,
                id,
                status: target_status,
                text: comment,
                agent: None,
                edit,
                request_key: None,
            };
            match client.ask::<ops::IssueStatusUpdate>(&req).await {
                Ok(updated) => ToolCallResult::json(&updated),
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            }
        } else {
            if !has_field_edits {
                return ToolCallResult::error(
                    "vv_issue_update requires at least one field to update (title, description, status, priority, repo, agent, owner, parent, tags, startAt, dueAt, criteria, or attachments)",
                );
            }
            let req = IssueUpdateInput {
                id,
                title,
                description,
                repo,
                agent,
                owner,
                parent,
                tags,
                start_at,
                due_at,
                priority,
                criteria,
                attachments,
                ..Default::default()
            };
            match client.ask::<ops::IssueUpdate>(&req).await {
                Ok(updated) => ToolCallResult::json(&updated),
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            }
        };

        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_issue_comment(&self, raw_args: Value) -> ToolCallResult {
        let args: IssueCommentArgs = match Self::decode_args("vv_issue_comment", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = issue_ref(args.issue_id.trim());
        let text = args.text.trim().to_string();
        if id.is_empty() || text.is_empty() {
            return ToolCallResult::error("vv_issue_comment requires non-empty issueId and text");
        }
        let attachments: Vec<String> = args.attachments.into_iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();

        self.refresh_client().await;
        let client = self.client.read().await;
        let result = if attachments.is_empty() {
            let req = IssueCommentCreateInput {
                id: id.clone(),
                text,
                ..Default::default()
            };
            match client.ask::<ops::IssueCommentCreate>(&req).await {
                Ok(applied) => ToolCallResult::json(&json!({
                    "ok": true,
                    "issueId": id,
                    "seq": applied.seq,
                })),
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            }
        } else {
            match client.ask::<ops::IssueConversationGet>(&IssueConversationGetInput { id: id.clone() }).await {
                Ok(Some(channel_id)) => {
                    let say = SayRequest {
                        id: channel_id.clone(),
                        text,
                        attachments: Some(attachments.clone()),
                        ..Default::default()
                    };
                    match client.ask::<ops::ChannelMessageSend>(&say).await {
                        Ok(()) => ToolCallResult::json(&json!({
                            "ok": true,
                            "issueId": id,
                            "channelId": channel_id,
                            "attachments": attachments,
                        })),
                        Err(failure) => ToolCallResult::error(format_failure(&failure)),
                    }
                }
                Ok(None) => {
                    // Thread does not exist yet: post via `issue.comment.create` (which opens the thread)
                    // and also link the uploaded attachment ids onto the issue itself.
                    let req = IssueCommentCreateInput {
                        id: id.clone(),
                        text,
                        ..Default::default()
                    };
                    match client.ask::<ops::IssueCommentCreate>(&req).await {
                        Ok(applied) => {
                            if let Ok(issue) = client.ask::<ops::IssueGet>(&IssueGetInput { id: id.clone() }).await {
                                let mut merged: Vec<String> = issue.attachments.into_iter().map(|a| a.id).collect();
                                for att_id in &attachments {
                                    if !merged.contains(att_id) {
                                        merged.push(att_id.clone());
                                    }
                                }
                                let _ = client
                                    .ask::<ops::IssueUpdate>(&IssueUpdateInput {
                                        id: issue.id,
                                        attachments: Some(merged),
                                        ..Default::default()
                                    })
                                    .await;
                            }
                            ToolCallResult::json(&json!({
                                "ok": true,
                                "issueId": id,
                                "seq": applied.seq,
                                "attachments": attachments,
                            }))
                        }
                        Err(failure) => ToolCallResult::error(format_failure(&failure)),
                    }
                }
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            }
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_attachment_upload(&self, raw_args: Value) -> ToolCallResult {
        let args: AttachmentUploadArgs = match Self::decode_args("vv_attachment_upload", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let path_str = args.path.trim();
        if path_str.is_empty() {
            return ToolCallResult::error("vv_attachment_upload requires a non-empty path");
        }
        let file = PathBuf::from(path_str);
        let bytes = match std::fs::read(&file) {
            Ok(b) => b,
            Err(err) => return ToolCallResult::error(format!("File: failed to read {}: {err}", file.display())),
        };
        let name = non_empty_trimmed(args.name)
            .or_else(|| file.file_name().and_then(|n| n.to_str()).map(ToString::to_string))
            .unwrap_or_else(|| "attachment".into());
        let mime = non_empty_trimmed(args.mime).unwrap_or_else(|| guess_mime(&file).to_string());
        let request = AttachmentUpload {
            name,
            r#type: mime,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::AttachmentCreate>(&request).await {
            Ok(att) => ToolCallResult::json(&att),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }
}
