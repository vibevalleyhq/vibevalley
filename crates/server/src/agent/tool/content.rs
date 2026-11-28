//! Resources, notes, the library and media: direct typed calls into domain
//! services and [`crate::agent::mcp::Resource`] (`vv://`), keeping actor-scoped
//! note/media/library writes strongly typed with zero `block_on`.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use vibevalley_core::collab::CommitMeta;
use vibevalley_protocol::{
    BaseRunAgentColumnRequest, BaseUpsertRowRequest, BaseViewRequest, LibraryAddRequest, LibraryListRequest, MediaImageRequest, MediaSource,
    MediaSpeakersRequest, MediaSpeechRequest, MediaVoiceDesignRequest, NoteCard, NoteDocAppendBlockRequest, NoteFileDeleteRequest, NoteFileGetRequest,
    NoteFileListRequest, NoteFileWriteRequest, NoteFileWriteResult, NoteLinkListRequest, NoteListRequest, NoteRequest, NoteSuggestionCreateInput,
    NoteTreeMoveRequest, NoteType, NoteTypeReadRequest, NoteVersionRequest, Session,
};

use super::registry::{ToolRegistry, Who, given};
use crate::agent::mcp::ResourceReadArgs as McpResourceReadArgs;
use crate::issue::NewIssue;
use crate::note::base::ExecutedAgentCellOutcome;
use crate::note::{AddedBy, Maker, Manager as NoteManager};

fn text<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct IdArgs {
    #[serde(default)]
    id: String,
}

#[derive(Deserialize)]
pub struct EmptyArgs {}

#[derive(Deserialize)]
pub struct ResourceReadArgs {
    pub uri: String,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn resource_read(f: &ToolRegistry, who: &Who, a: ResourceReadArgs) -> Result<String, String> {
    let reader = match who {
        Who::Helper(me) => Some((**me).clone()),
        Who::Orchestrator(_) => None,
    };
    let args = McpResourceReadArgs {
        uri: a.uri,
        offset: a.offset,
        limit: a.limit,
    };
    f.resource.read_async(reader.as_ref(), &args).await
}

/// Where the orchestrator makes media from: only with the user's word in this batch.
fn mandate(who: &Who) -> Result<MediaSource, String> {
    match who {
        Who::Orchestrator(here) if here.user => Ok(MediaSource::Orchestrator {
            agent: here.agent.clone(),
            channel: here.channel.clone(),
        }),
        _ => Err(vibevalley_i18n::t("server.media.userRequired", &[])),
    }
}

/// An image only when the user asked for it in this batch.
pub async fn image(f: &ToolRegistry, who: &Who, req: MediaImageRequest) -> Result<String, String> {
    let Who::Orchestrator(here) = who else {
        return Err("帮工不能出图".into());
    };
    if !here.user {
        return Err(vibevalley_i18n::t("server.media.userRequired", &[]));
    }
    let source = MediaSource::Orchestrator {
        agent: here.agent.clone(),
        channel: here.channel.clone(),
    };
    text(&f.note.media.image_async(req, source).await.map_err(|e| e.message)?)
}

pub async fn speech(f: &ToolRegistry, who: &Who, req: MediaSpeechRequest) -> Result<String, String> {
    text(&f.note.media.speech_async(req, mandate(who)?).await.map_err(|e| e.message)?)
}

pub async fn dialogue(f: &ToolRegistry, who: &Who, req: MediaSpeakersRequest) -> Result<String, String> {
    text(&f.note.media.speakers_async(req, mandate(who)?).await.map_err(|e| e.message)?)
}

pub async fn voice_design(f: &ToolRegistry, who: &Who, req: MediaVoiceDesignRequest) -> Result<String, String> {
    text(&f.note.media.voice_design_async(req, mandate(who)?).await.map_err(|e| e.message)?)
}

/// Understanding the user approved for this channel, started for them.
pub async fn understand(f: &ToolRegistry, who: &Who, a: IdArgs) -> Result<String, String> {
    let MediaSource::Orchestrator { agent, channel } = mandate(who)? else {
        return Err(vibevalley_i18n::t("server.media.userRequired", &[]));
    };
    text(&f.note.media.start_understanding_async(&a.id, &agent, &channel).await.map_err(|e| e.message)?)
}

pub async fn job_get(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.note.media.get_async(&a.id).await.map_err(|e| e.message)?)
}

pub async fn job_list(f: &ToolRegistry, _who: &Who, _: EmptyArgs) -> Result<String, String> {
    text(&f.note.media.list_async().await.map_err(|e| e.message)?)
}

pub async fn job_cancel(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.note.media.cancel_async(&a.id).await.map_err(|e| e.message)?)
}

pub async fn job_download(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.note.media.retry_download_async(&a.id).await.map_err(|e| e.message)?)
}

pub async fn library_list(f: &ToolRegistry, _who: &Who, req: LibraryListRequest) -> Result<String, String> {
    let items = f.note.library.list_async(&req).await.map_err(|e| e.message)?;
    if items.is_empty() {
        return Ok("素材库里没有这样的文件。".into());
    }
    text(&items)
}

pub async fn library_add(f: &ToolRegistry, who: &Who, req: LibraryAddRequest) -> Result<String, String> {
    let by = match who {
        Who::Orchestrator(here) => AddedBy::Agent {
            agent: here.agent.clone(),
            session: None,
            dir: None,
        },
        Who::Helper(me) => AddedBy::Agent {
            agent: me.profile.clone().unwrap_or_default(),
            session: Some(me.id.clone()),
            dir: me.cwd.as_deref().map(PathBuf::from),
        },
    };
    let item = f.note.library.add_async(&req, &by).await.map_err(|e| format!("没成：{}", e.message))?;
    Ok(format!("放进素材库了：「{}」，id={}。", item.attachment.name, item.attachment.id))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListArgs {
    channel: Option<String>,
    issue: Option<String>,
    note_type: Option<NoteType>,
    parent_id: Option<String>,
}

pub async fn note_list(f: &ToolRegistry, who: &Who, a: NoteListArgs) -> Result<String, String> {
    let channel = match given(&a.channel) {
        Some(ch) => Some(f.chat.place_of_async(&crate::channel::local_user_id(), ch).await.map_err(|e| e.message)?),
        None => None,
    };
    let mut issue = match given(&a.issue) {
        Some(r) => Some(f.issue_async(r).await?.id),
        None => None,
    };
    if let (Who::Helper(me), None) = (who, &channel) {
        issue = me.issue_id().map(String::from);
    }
    text(
        &f.note
            .list_async(&NoteListRequest {
                channel,
                issue,
                note_type: a.note_type,
                parent_id: given(&a.parent_id).map(String::from),
            })
            .await
            .map_err(|e| e.message)?,
    )
}

pub async fn note_get(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.note.get_async(&a.id).await.map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct NoteContentArgs {
    #[serde(default)]
    id: String,
    version: Option<i64>,
}

pub async fn note_content(f: &ToolRegistry, _who: &Who, a: NoteContentArgs) -> Result<String, String> {
    let content = f.note.content_async(&a.id, a.version).await.map_err(|e| e.message)?;
    text(&content)
}

fn maker_of(who: &Who) -> Maker {
    match who {
        Who::Helper(me) => Maker {
            from: me.id.clone(),
            by: me.profile.clone().unwrap_or_default(),
            run: None,
        },
        Who::Orchestrator(here) => Maker {
            from: here.agent.clone(),
            by: here.agent.clone(),
            run: None,
        },
    }
}

fn actor_of(who: &Who) -> &str {
    match who {
        Who::Helper(me) => me.profile.as_deref().unwrap_or(""),
        Who::Orchestrator(here) => here.agent.as_str(),
    }
}

#[derive(Deserialize)]
pub struct NoteCreateArgs {
    #[serde(flatten)]
    req: NoteRequest,
    file: Option<String>,
}

pub async fn note_create(f: &ToolRegistry, who: &Who, mut a: NoteCreateArgs) -> Result<String, String> {
    let file = given(&a.file).map(str::to_string);
    if a.req.content.is_some() && file.is_some() {
        return Err("content 和 file 只能填一个".into());
    }
    match who {
        Who::Orchestrator(here) => {
            if file.is_some() {
                return Err("主助手不能用 file，请直接传 content 或 files".into());
            }
            if given(&a.req.channel).is_none() && !here.channel.is_empty() {
                a.req.channel = Some(here.channel.clone());
            }
            a.req.issue = match given(&a.req.issue) {
                Some(r) => Some(f.issue_async(r).await?.id),
                None => None,
            };
        }
        Who::Helper(me) => {
            if let Some(content) = read_helper_file(f, me, &a.file).await? {
                a.req.content = Some(content);
            }
            if given(&a.req.issue).is_none() {
                a.req.issue = me.issue_id().map(String::from);
            }
        }
    }
    let maker = maker_of(who);
    if let Some(ch) = given(&a.req.channel) {
        let resolved = f.chat.place_of_async(&maker.from, ch).await.map_err(|e| e.message)?;
        a.req.channel = Some(resolved);
    }
    let created = f.note.create_async(&maker, &a.req).await.map_err(|e| e.message)?;
    let mut out = created;
    if a.req.announce != Some(false)
        && let Some(ch) = out.channel.as_deref()
    {
        let say = NoteManager::say_for_note_event("server.note.created", &out.title, a.req.note.as_deref().unwrap_or(""));
        let card = NoteCard {
            id: out.id.clone(),
            title: out.title.clone(),
            note_type: out.note_type,
            version: 1,
            note: a.req.note.clone().unwrap_or_default(),
        };
        if let Ok(msg) = f
            .chat
            .post_card_async(&maker.from, ch, &say, card, maker.run.clone(), format!("note:{}:v1", out.id))
            .await
        {
            f.note.record_announced_message_async(&out.id, Some(1), &msg.number.to_string()).await;
            if let Ok(refreshed) = f.note.get_async(&out.id).await {
                out = refreshed;
            }
        }
    }
    text(&out)
}

#[derive(Deserialize)]
pub struct NoteVersionArgs {
    #[serde(flatten)]
    req: NoteVersionRequest,
    file: Option<String>,
}

fn commit_meta_for_who(f: &ToolRegistry, who: &Who, summary: Option<String>) -> CommitMeta {
    let at = f.ctx.now();
    match who {
        Who::Helper(me) => CommitMeta::session(&me.name, me.profile.as_deref().unwrap_or(""), &me.id, me.runs.max(1) as u32, summary, at),
        Who::Orchestrator(here) => CommitMeta {
            author: here.agent.clone(),
            agent: Some(here.agent.clone()),
            session_id: None,
            turn: None,
            origin: format!("orchestrator:{}", here.agent),
            summary,
            at,
        },
    }
}

pub async fn note_version(f: &ToolRegistry, who: &Who, mut a: NoteVersionArgs) -> Result<String, String> {
    if let Who::Helper(me) = who
        && let Some(content) = read_helper_file(f, me, &a.file).await?
    {
        a.req.content = Some(content);
    }
    let maker = maker_of(who);
    let meta = commit_meta_for_who(f, who, a.req.note.clone());
    let mut out = f.note.version_with_meta_async(&maker, &a.req, &meta).await.map_err(|e| e.message)?;
    if let Some(ch) = out.channel.as_deref() {
        let say = NoteManager::say_for_note_event("server.note.revised", &out.title, a.req.note.as_deref().unwrap_or(""));
        let card = NoteCard {
            id: out.id.clone(),
            title: out.title.clone(),
            note_type: out.note_type,
            version: out.version,
            note: a.req.note.clone().unwrap_or_default(),
        };
        if let Ok(msg) = f
            .chat
            .post_card_async(&maker.from, ch, &say, card, maker.run.clone(), format!("note:{}:v{}", out.id, out.version))
            .await
        {
            f.note.record_announced_message_async(&out.id, Some(out.version), &msg.number.to_string()).await;
            if let Ok(refreshed) = f.note.get_async(&out.id).await {
                out = refreshed;
            }
        }
    }
    text(&out)
}

pub async fn note_tree_move(f: &ToolRegistry, _who: &Who, req: NoteTreeMoveRequest) -> Result<String, String> {
    text(&f.note.move_tree_async(&req).await.map_err(|e| e.message)?)
}

pub async fn note_link_list(f: &ToolRegistry, _who: &Who, req: NoteLinkListRequest) -> Result<String, String> {
    text(&f.note.list_links_async(&req).await.map_err(|e| e.message)?)
}

pub async fn note_doc_view(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.note.doc_view_async(a.id.trim()).await.map_err(|e| e.message)?)
}

pub async fn note_doc_append_block(f: &ToolRegistry, who: &Who, req: NoteDocAppendBlockRequest) -> Result<String, String> {
    text(&f.note.doc_append_block_async(&maker_of(who), &req).await.map_err(|e| e.message)?)
}

pub async fn note_base_view(f: &ToolRegistry, _who: &Who, req: BaseViewRequest) -> Result<String, String> {
    text(&f.note.base_view_async(&req).await.map_err(|e| e.message)?)
}

pub async fn note_base_upsert_row(f: &ToolRegistry, who: &Who, req: BaseUpsertRowRequest) -> Result<String, String> {
    text(&f.note.base_upsert_row_async(&maker_of(who), &req).await.map_err(|e| e.message)?)
}

pub async fn note_base_run_agent_column(f: &ToolRegistry, who: &Who, req: BaseRunAgentColumnRequest) -> Result<String, String> {
    let plan = f.note.prepare_base_agent_column_async(&req).await.map_err(|e| e.message)?;
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
            match f
                .issue
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
    text(
        &f.note
            .apply_base_agent_column_outcomes_async(&maker_of(who), &plan, &outcomes)
            .await
            .map_err(|e| e.message)?,
    )
}

pub async fn note_type_list(f: &ToolRegistry, _who: &Who, _: EmptyArgs) -> Result<String, String> {
    text(&f.note.list_types_async().await.map_err(|e| e.message)?)
}

pub async fn note_type_read(f: &ToolRegistry, _who: &Who, req: NoteTypeReadRequest) -> Result<String, String> {
    text(&f.note.read_type_async(&req).await.map_err(|e| e.message)?)
}

pub async fn note_file_list(f: &ToolRegistry, _who: &Who, mut req: NoteFileListRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.note.list_files_async(&req).await.map_err(|e| e.message)?)
}

pub async fn note_file_get(f: &ToolRegistry, _who: &Who, mut req: NoteFileGetRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.note.get_file_async(&req).await.map_err(|e| e.message)?)
}

pub async fn note_file_write(f: &ToolRegistry, who: &Who, mut req: NoteFileWriteRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    let maker = maker_of(who);
    let meta = commit_meta_for_who(f, who, req.summary.clone());
    let res: NoteFileWriteResult = f.note.write_files_with_meta_async(&maker, &req, &meta).await.map_err(|e| e.message)?;
    if req.announce == Some(true)
        && let Ok(note) = f.note.get_async(&req.id).await
        && let Some(ch) = note.channel.as_deref()
    {
        let say = NoteManager::say_for_note_event("server.note.revised", &note.title, req.summary.as_deref().unwrap_or(""));
        let card = NoteCard {
            id: note.id.clone(),
            title: note.title.clone(),
            note_type: note.note_type,
            version: note.version,
            note: req.summary.clone().unwrap_or_default(),
        };
        let _ = f
            .chat
            .post_card_async(&maker.from, ch, &say, card, maker.run.clone(), format!("note:{}:seq{}", note.id, res.seq))
            .await;
    }
    text(&res)
}

pub async fn note_file_delete(f: &ToolRegistry, who: &Who, mut req: NoteFileDeleteRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    let meta = commit_meta_for_who(f, who, req.summary.clone());
    text(&f.note.delete_file_with_meta_async(&maker_of(who), &req, &meta).await.map_err(|e| e.message)?)
}

pub async fn note_suggestion_list(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.note.suggestions_async(a.id.trim()).await.map_err(|e| e.message)?)
}

pub async fn note_suggestion_create(f: &ToolRegistry, who: &Who, mut req: NoteSuggestionCreateInput) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.note.create_suggestion_async(actor_of(who), &req).await.map_err(|e| e.message)?)
}

/// `file`: a file in the helper's own folder becomes the content.
async fn read_helper_file(f: &ToolRegistry, me: &Session, file: &Option<String>) -> Result<Option<String>, String> {
    let Some(file) = given(file).map(str::to_string) else {
        return Ok(None);
    };
    let dir = me.cwd.as_deref().ok_or("你没有工作目录，不能用 file")?.to_string();
    let file_for_err = file.clone();
    let path = f
        .ctx
        .task
        .spawn_blocking(move || inside(Path::new(&dir), &file))
        .await
        .map_err(|e| format!("读不了 {file_for_err}：{e}"))??;
    tokio::fs::read_to_string(&path)
        .await
        .map(Some)
        .map_err(|e| format!("读不了 {file_for_err}：{e}"))
}

/// `name` inside `dir`, refused when it leaves it.
fn inside(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(name).canonicalize().map_err(|e| format!("读不了 {name}：{e}"))?;
    if path.starts_with(&root) {
        Ok(path)
    } else {
        Err(format!("{name} 不在你的工作目录里"))
    }
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::{NoteRequest, NoteType};

    #[test]
    fn a_file_outside_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(super::inside(dir.path(), "a.md").is_ok());
        assert!(super::inside(dir.path(), "../a.md").is_err());
    }

    #[test]
    fn note_request_accepts_all_4_types() {
        for ty in NoteType::ALL {
            let req = NoteRequest {
                title: "Spec".into(),
                note_type: ty,
                parent_id: None,
                sort_order: None,
                content: Some("body".into()),
                files: None,
                announce: None,
                note: None,
                channel: None,
                issue: None,
            };
            assert_eq!(req.note_type, ty);
        }
    }
}
