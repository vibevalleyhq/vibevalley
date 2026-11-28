//! Note, media, library, and issue-body orchestration (`orchestration::note`):
//! connects pure [`NoteManager`] with [`Chat`] announcements/channel lookup and
//! [`Board`] issue-body / base-agent-column workflows.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::broadcast;
use vibevalley_core::note::doc::{DocDocument, markdown_to_blocks, serialize_doc_document};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, AppliedIssue, BaseRunAgentColumnRequest, BaseRunAgentColumnResult, BizCode, Caller, Issue, IssueBodyEnsureInput, IssueBodyEnsureResult,
    IssueUpdateInput, MediaUnderstandingAuthorizationRequest, MediaUnderstandingJob, Note, NoteCard, NoteFileEncoding, NoteFileWriteItem, NoteFileWriteRequest,
    NoteFileWriteResult, NoteListRequest, NoteRequest, NoteSuggestionCreateInput, NoteType, NoteUpdateRequest, NoteVersionRequest, SuggestionChange,
};

use crate::channel::{ChannelMessageEvent, Chat};
use crate::context::Context;
use crate::context::api::CallerContext;
use crate::issue::{Board, NewIssue};
use crate::note::Manager as NoteManager;
use crate::note::base::ExecutedAgentCellOutcome;

fn channel_sender(from: &str) -> String {
    if from == "user" { crate::channel::local_user_id() } else { from.to_owned() }
}

fn serialize_markdown_doc(markdown: &str) -> Result<String, ApiError> {
    let doc = DocDocument {
        version: 1,
        blocks: markdown_to_blocks(markdown),
    };
    serialize_doc_document(&doc).map_err(|e| ApiError::new(BizCode::NoteRefused, e))
}

/// Application-layer workflow coordinating `note`, `media`, `library`, `channel`, and `issue`.
pub struct NoteWorkflow {
    ctx: Arc<Context>,
    note: Arc<NoteManager>,
    channel: Arc<Chat>,
    board: Arc<Board>,
}

impl NoteWorkflow {
    pub fn start(ctx: Arc<Context>, note: Arc<NoteManager>, channel: Arc<Chat>, board: Arc<Board>) -> Arc<Self> {
        let wf = Arc::new(Self {
            ctx: ctx.clone(),
            note: note.clone(),
            channel: channel.clone(),
            board,
        });
        Self::spawn_bridges(&ctx, &note, &channel);
        wf
    }

    fn spawn_bridges(ctx: &Context, note: &Arc<NoteManager>, channel: &Arc<Chat>) {
        // 1. Media job completion/failure announcements -> Chat attachments.
        let mut media_rx = note.subscribe_media_announcements();
        let ch = Arc::downgrade(channel);
        let cancel = ctx.task.child_token();
        ctx.spawn("note.media_announcements", async move {
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    res = media_rx.recv() => match res {
                        Ok(ann) => {
                            let Some(chat) = ch.upgrade() else { return };
                            if let Err(err) = chat
                                .post_attachments_async(&ann.from, &ann.channel, &ann.text, ann.attachments, ann.send_key)
                                .await
                            {
                                tracing::warn!(channel = %ann.channel, error = %err, "media announcement post failed");
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "note.media_announcements broadcast lagged");
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });

        // 2. Chat messages with attachments -> Library catalog indexing.
        let mut msg_rx = channel.subscribe_message_events();
        let lib = Arc::downgrade(&note.library);
        let cancel = ctx.task.child_token();
        ctx.spawn("note.chat_library", async move {
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    res = msg_rx.recv() => match res {
                        Ok(ChannelMessageEvent::Posted { message, .. } | ChannelMessageEvent::Edited(message)) => {
                            let Some(library) = lib.upgrade() else { return };
                            let _ = library.record_said_async(&message).await;
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "note.chat_library message stream lagged");
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });
    }

    pub async fn list_notes_async(&self, req: &NoteListRequest) -> Result<Vec<Note>, ApiError> {
        let mut resolved = req.clone();
        if let Some(ch) = req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            resolved.channel = Some(self.channel.place_of_async(&crate::channel::local_user_id(), ch).await?);
        }
        self.note.list_async(&resolved).await
    }

    pub async fn create_for_caller_async(&self, ctx: &CallerContext, req: &NoteRequest) -> Result<Note, ApiError> {
        let (maker, _, _) = self.note.caller_meta(ctx);
        let sender = channel_sender(&maker.from);
        let mut resolved = req.clone();
        if let Some(ch) = req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            resolved.channel = Some(self.channel.place_of_async(&sender, ch).await?);
        }
        let mut created = self.note.create_for_caller_async(ctx, &resolved).await?;
        if req.announce != Some(false)
            && let Some(ch) = created.channel.as_deref()
        {
            let say = NoteManager::say_for_note_event("server.note.made", &created.title, req.note.as_deref().unwrap_or(""));
            let card = NoteCard {
                id: created.id.clone(),
                title: created.title.clone(),
                note_type: created.note_type,
                version: 1,
                note: req.note.clone().unwrap_or_default(),
            };
            if let Ok(msg) = self
                .channel
                .post_card_async(&sender, ch, &say, card, maker.run.clone(), format!("note:{}:v1", created.id))
                .await
            {
                self.note.record_announced_message_async(&created.id, Some(1), &msg.number.to_string()).await;
                if let Ok(refreshed) = self.note.get_async(&created.id).await {
                    created = refreshed;
                }
            }
        }
        Ok(created)
    }

    pub async fn version_for_caller_async(&self, ctx: &CallerContext, req: &NoteVersionRequest) -> Result<Note, ApiError> {
        let (maker, _, _) = self.note.caller_meta(ctx);
        let sender = channel_sender(&maker.from);
        let mut updated = self.note.version_for_caller_async(ctx, req).await?;
        if let Some(ch) = updated.channel.as_deref() {
            let say = NoteManager::say_for_note_event("server.note.versioned", &updated.title, req.note.as_deref().unwrap_or(""));
            let card = NoteCard {
                id: updated.id.clone(),
                title: updated.title.clone(),
                note_type: updated.note_type,
                version: updated.version,
                note: req.note.clone().unwrap_or_default(),
            };
            if let Ok(msg) = self
                .channel
                .post_card_async(&sender, ch, &say, card, maker.run.clone(), format!("note:{}:v{}", updated.id, updated.version))
                .await
            {
                self.note
                    .record_announced_message_async(&updated.id, Some(updated.version), &msg.number.to_string())
                    .await;
                if let Ok(refreshed) = self.note.get_async(&updated.id).await {
                    updated = refreshed;
                }
            }
        }
        Ok(updated)
    }

    pub async fn write_for_caller_async(&self, ctx: &CallerContext, req: &NoteFileWriteRequest) -> Result<NoteFileWriteResult, ApiError> {
        let (maker, _, _) = self.note.caller_meta(ctx);
        let sender = channel_sender(&maker.from);
        let res = self.note.write_for_caller_async(ctx, req).await?;
        if req.announce == Some(true)
            && let Ok(note) = self.note.get_async(&req.id).await
            && let Some(ch) = note.channel.as_deref()
        {
            let say = NoteManager::say_for_note_event("server.note.versioned", &note.title, req.summary.as_deref().unwrap_or(""));
            let card = NoteCard {
                id: note.id.clone(),
                title: note.title.clone(),
                note_type: note.note_type,
                version: note.version,
                note: req.summary.clone().unwrap_or_default(),
            };
            let _ = self
                .channel
                .post_card_async(&sender, ch, &say, card, maker.run.clone(), format!("note:{}:seq{}", note.id, res.seq))
                .await;
        }
        Ok(res)
    }

    pub async fn authorize_understanding_async(&self, req: MediaUnderstandingAuthorizationRequest) -> Result<MediaUnderstandingJob, ApiError> {
        if !self.channel.place_exists(&req.channel) {
            return Err(ApiError::new(BizCode::MediaRefused, t("server.media.inputInvalid", &[])));
        }
        self.note.media.authorize_understanding_async(req).await
    }

    pub async fn start_understanding_for_caller_async(&self, caller: Caller, id: &str) -> Result<MediaUnderstandingJob, ApiError> {
        let ch = self.channel.clone();
        self.note
            .media
            .start_understanding_for_caller_with_agent_async(caller, id, move |channel| ch.orchestrator_in(channel))
            .await
    }

    async fn ensure_body_note_for_issue(&self, ctx: &CallerContext, issue: &Issue) -> Result<IssueBodyEnsureResult, ApiError> {
        if let Some(nid) = issue.body_note_id.as_deref()
            && let Ok(existing) = self.note.get_async(nid).await
        {
            let doc_view = self.note.doc_view_async(nid).await?;
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
        let created = self.note.create_for_caller_async(ctx, &req).await?;
        let updated = self.board.set_body_note_id_async(&issue.id, created.id.clone()).await?;
        let doc_view = self.note.doc_view_async(&created.id).await?;
        Ok(IssueBodyEnsureResult {
            issue: updated,
            note: created,
            doc_view,
        })
    }

    pub async fn issue_body_ensure_async(&self, ctx: &CallerContext, r: &IssueBodyEnsureInput) -> Result<IssueBodyEnsureResult, ApiError> {
        let issue = self.board.get_async(&r.id).await?;
        self.ensure_body_note_for_issue(ctx, &issue).await
    }

    pub async fn issue_update_async(&self, ctx: &CallerContext, mut r: IssueUpdateInput) -> Result<AppliedIssue, ApiError> {
        let current = self.board.get_async(&r.id).await?;
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
            let existing_note = self.note.get_async(&nid).await?;
            let proposed_json = serialize_markdown_doc(&proposed_md)?;
            let _ = self
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
        let applied = self.board.issue_update_endpoint_async(r).await?;

        if sync_user_desc && let Some(nid) = applied.body_note_id.as_deref() {
            let doc_json = serialize_markdown_doc(&applied.description)?;
            let _ = self
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
            let _ = self
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
    pub async fn backfill_issue_bodies_async(&self) {
        let Ok(issues) = self.board.issues_without_body_note_async().await else {
            return;
        };
        let local = CallerContext::local();
        let mut migrated = 0usize;
        for issue in issues {
            if issue.description.trim().is_empty() {
                continue;
            }
            match self.ensure_body_note_for_issue(&local, &issue).await {
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

    pub async fn base_run_agent_column_async(&self, ctx: &CallerContext, r: &BaseRunAgentColumnRequest) -> Result<BaseRunAgentColumnResult, ApiError> {
        let plan = self.note.prepare_base_agent_column_async(r).await?;
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
                match self
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
        let (maker, _, _) = self.note.caller_meta(ctx);
        self.note.apply_base_agent_column_outcomes_async(&maker, &plan, &outcomes).await
    }

    pub fn ctx(&self) -> &Arc<Context> {
        &self.ctx
    }
}
