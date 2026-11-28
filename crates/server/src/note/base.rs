//! Multi-Dimensional Database Base view projection, row upsert, and Agent column execution (#32, #38, #40).

use vibevalley_core::note::base::{
    BaseDocument, cell_as_text, format_agent_prompt, parse_base_document, project_base_view, serialize_base_document, text_cell, upsert_row,
};
use vibevalley_protocol::{
    ApiError, BaseCellValue, BaseColumnKind, BaseRunAgentColumnRequest, BaseRunAgentColumnResult, BaseUpsertRowRequest, BaseViewRequest, BaseViewSnapshot,
    NoteFileEncoding, NoteFileWriteItem, NoteFileWriteRequest, NoteType,
};

use super::{Maker, Manager, NOTE_USER_ORIGIN, new_id, note_type_of, refused};

/// Prepared Agent Action target item passed to the issue/agent execution coordinator in `router/glue.rs`.
#[derive(Debug, Clone)]
pub(crate) struct PreparedAgentCellTask {
    pub row_id: String,
    pub row_title: String,
    pub rendered_prompt: String,
    pub agent_id: Option<String>,
    pub target_column_id: Option<String>,
    pub spawn_issue_repo: Option<String>,
}

/// Prepared plan for `note.base.runAgentColumn`.
#[derive(Debug, Clone)]
pub(crate) struct PreparedAgentColumnRun {
    pub note_id: String,
    pub sheet_id: String,
    pub column_id: String,
    pub origin: Option<String>,
    pub tasks: Vec<PreparedAgentCellTask>,
}

/// Outcome recorded back into `structure/base.json` after executing each row task.
#[derive(Debug, Clone)]
pub(crate) struct ExecutedAgentCellOutcome {
    pub row_id: String,
    pub column_id: String,
    pub target_column_id: Option<String>,
    pub status: String,
    pub summary: String,
    pub session_id: Option<String>,
    pub spawned_issue_id: Option<String>,
}

impl Manager {
    pub(super) async fn load_base_doc_async(&self, id: &str) -> Result<BaseDocument, ApiError> {
        let row = self.row_async(id).await?;
        let ty = note_type_of(&row.note_type)?;
        if ty != NoteType::Base {
            return Err(refused(format!("note `{}` is `{}`, expected `base`", row.id, ty.as_str())));
        }
        let raw_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
        let bytes = raw_files.get("structure/base.json").ok_or_else(|| refused("missing structure/base.json"))?;
        let raw = std::str::from_utf8(bytes).map_err(|e| refused(format!("base.json UTF-8 error: {e}")))?;
        parse_base_document(raw).map_err(refused)
    }

    /// Projects `structure/base.json` into a filtered, sorted, grouped, summarized [`BaseViewSnapshot`].
    pub async fn base_view_async(&self, req: &BaseViewRequest) -> Result<BaseViewSnapshot, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        if ty != NoteType::Base {
            return Err(refused(format!("note `{}` is `{}`, expected `base`", row.id, ty.as_str())));
        }
        let raw_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
        project_base_view(&row.id, &raw_files, req).map_err(refused)
    }

    /// Inserts or updates a row in `structure/base.json` and returns the updated [`BaseViewSnapshot`].
    pub async fn base_upsert_row_async(&self, maker: &Maker, req: &BaseUpsertRowRequest) -> Result<BaseViewSnapshot, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let mut doc = self.load_base_doc_async(&req.id).await?;
        let now = self.ctx.now();
        let gen_id = new_id("row");
        let (sheet_id, row_id) = upsert_row(&mut doc, req, now, &gen_id).map_err(refused)?;
        let encoded = serialize_base_document(&doc).map_err(refused)?;
        let meta = super::collab::commit_meta_for_maker(maker, Some("Update base row".to_owned()), now);
        self.write_files_with_meta_async(
            maker,
            &NoteFileWriteRequest {
                id: req.id.clone(),
                files: vec![NoteFileWriteItem {
                    path: "structure/base.json".to_owned(),
                    content: encoded,
                    encoding: Some(NoteFileEncoding::Utf8),
                    mime: Some("application/json".to_owned()),
                    expected_hash: None,
                }],
                origin: req.origin.clone().or_else(|| Some(NOTE_USER_ORIGIN.to_owned())),
                summary: Some("Upsert base row".to_owned()),
                announce: Some(false),
            },
            &meta,
        )
        .await?;

        self.sync_base_row_to_doc_annotation_async(maker, &doc, &sheet_id, &row_id, req.origin.as_deref())
            .await;

        self.base_view_async(&BaseViewRequest {
            id: req.id.clone(),
            sheet_id: Some(sheet_id),
            view_id: None,
        })
        .await
    }

    /// Validates target sheet & `AgentAction` column and prepares rendered prompts per target row.
    pub(crate) async fn prepare_base_agent_column_async(&self, req: &BaseRunAgentColumnRequest) -> Result<PreparedAgentColumnRun, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let doc = self.load_base_doc_async(&req.id).await?;
        let sheet = match req.sheet_id.as_deref() {
            Some(sid) => doc
                .sheets
                .iter()
                .find(|s| s.id == sid)
                .ok_or_else(|| refused(format!("sheet {sid} not found")))?,
            None => doc.sheets.first().ok_or_else(|| refused("base has no sheets"))?,
        };
        let col = sheet
            .columns
            .iter()
            .find(|c| c.id == req.column_id)
            .ok_or_else(|| refused(format!("column `{}` not found", req.column_id)))?;
        if col.kind != BaseColumnKind::AgentAction {
            return Err(refused(format!("column `{}` is not an agentAction column", col.name)));
        }
        let cfg = col
            .agent_config
            .as_ref()
            .ok_or_else(|| refused(format!("column `{}` has no agentConfig", col.name)))?;

        let filter_ids = req.row_ids.as_ref();
        let mut tasks = Vec::new();
        for r in &sheet.rows {
            if let Some(wanted) = filter_ids
                && !wanted.iter().any(|id| id == &r.id)
            {
                continue;
            }
            let rendered_prompt = format_agent_prompt(&cfg.prompt_template, sheet, r);
            let row_title = sheet
                .columns
                .first()
                .and_then(|c0| r.cells.get(&c0.id))
                .map(cell_as_text)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("Base Row {}", r.id));
            tasks.push(PreparedAgentCellTask {
                row_id: r.id.clone(),
                row_title,
                rendered_prompt,
                agent_id: cfg.agent_id.clone(),
                target_column_id: cfg.target_column_id.clone(),
                spawn_issue_repo: cfg.spawn_issue_repo.clone(),
            });
        }

        Ok(PreparedAgentColumnRun {
            note_id: req.id.clone(),
            sheet_id: sheet.id.clone(),
            column_id: col.id.clone(),
            origin: req.origin.clone(),
            tasks,
        })
    }

    /// Commits [`ExecutedAgentCellOutcome`]s into `structure/base.json` and returns [`BaseRunAgentColumnResult`].
    pub(crate) async fn apply_base_agent_column_outcomes_async(
        &self,
        maker: &Maker,
        plan: &PreparedAgentColumnRun,
        outcomes: &[ExecutedAgentCellOutcome],
    ) -> Result<BaseRunAgentColumnResult, ApiError> {
        let mut doc = self.load_base_doc_async(&plan.note_id).await?;
        let now = self.ctx.now();
        let sheet = doc
            .sheets
            .iter_mut()
            .find(|s| s.id == plan.sheet_id)
            .ok_or_else(|| refused("target base sheet vanished"))?;

        let mut updated_row_ids = Vec::new();
        let mut spawned_issue_ids = Vec::new();

        for out in outcomes {
            if let Some(row) = sheet.rows.iter_mut().find(|r| r.id == out.row_id) {
                row.cells.insert(
                    out.column_id.clone(),
                    BaseCellValue::AgentRun {
                        status: out.status.clone(),
                        summary: Some(out.summary.clone()),
                        session_id: out.session_id.clone(),
                        spawned_issue_id: out.spawned_issue_id.clone(),
                        updated_at: now,
                    },
                );
                if let Some(target_col) = &out.target_column_id {
                    row.cells.insert(target_col.clone(), text_cell(&out.summary));
                }
                row.updated_at = now;
                updated_row_ids.push(out.row_id.clone());
                if let Some(iss_id) = &out.spawned_issue_id {
                    spawned_issue_ids.push(iss_id.clone());
                }
            }
        }

        if !updated_row_ids.is_empty() {
            let encoded = serialize_base_document(&doc).map_err(refused)?;
            let meta = super::collab::commit_meta_for_maker(maker, Some("Run Base Agent Column".to_owned()), now);
            self.write_files_with_meta_async(
                maker,
                &NoteFileWriteRequest {
                    id: plan.note_id.clone(),
                    files: vec![NoteFileWriteItem {
                        path: "structure/base.json".to_owned(),
                        content: encoded,
                        encoding: Some(NoteFileEncoding::Utf8),
                        mime: Some("application/json".to_owned()),
                        expected_hash: None,
                    }],
                    origin: plan.origin.clone().or_else(|| Some("agent:base".to_owned())),
                    summary: Some(format!("Executed agent column {} on {} rows", plan.column_id, updated_row_ids.len())),
                    announce: Some(false),
                },
                &meta,
            )
            .await?;
        }

        Ok(BaseRunAgentColumnResult {
            note_id: plan.note_id.clone(),
            sheet_id: plan.sheet_id.clone(),
            column_id: plan.column_id.clone(),
            executed: updated_row_ids.len() as u32,
            updated_row_ids,
            spawned_issue_ids,
        })
    }
}
