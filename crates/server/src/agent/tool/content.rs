//! Resources, artifacts, the library and media: direct typed calls into domain
//! services and [`crate::agent::mcp::Resource`] (`vv://`), keeping actor-scoped
//! artifact/media/library writes strongly typed with zero `block_on`.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use vibevalley_core::collab::CommitMeta;
use vibevalley_protocol::{
    ArtifactFileDeleteRequest, ArtifactFileGetRequest, ArtifactFileListRequest, ArtifactFileWriteRequest, ArtifactListRequest, ArtifactRequest,
    ArtifactSuggestionCreateInput, ArtifactType, ArtifactTypeReadRequest, ArtifactVersionRequest, LibraryAddRequest, LibraryListRequest, MediaImageRequest,
    MediaSource, MediaSpeakersRequest, MediaSpeechRequest, MediaVoiceDesignRequest, Session,
};

use super::registry::{ToolRegistry, Who, given};
use crate::agent::mcp::ResourceReadArgs as McpResourceReadArgs;
use crate::artifact::{AddedBy, Maker};

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
    text(&f.artifact.media.image_async(req, source).await.map_err(|e| e.message)?)
}

pub async fn speech(f: &ToolRegistry, who: &Who, req: MediaSpeechRequest) -> Result<String, String> {
    text(&f.artifact.media.speech_async(req, mandate(who)?).await.map_err(|e| e.message)?)
}

pub async fn dialogue(f: &ToolRegistry, who: &Who, req: MediaSpeakersRequest) -> Result<String, String> {
    text(&f.artifact.media.speakers_async(req, mandate(who)?).await.map_err(|e| e.message)?)
}

pub async fn voice_design(f: &ToolRegistry, who: &Who, req: MediaVoiceDesignRequest) -> Result<String, String> {
    text(&f.artifact.media.voice_design_async(req, mandate(who)?).await.map_err(|e| e.message)?)
}

/// Understanding the user approved for this channel, started for them.
pub async fn understand(f: &ToolRegistry, who: &Who, a: IdArgs) -> Result<String, String> {
    let MediaSource::Orchestrator { agent, channel } = mandate(who)? else {
        return Err(vibevalley_i18n::t("server.media.userRequired", &[]));
    };
    text(
        &f.artifact
            .media
            .start_understanding_async(&a.id, &agent, &channel)
            .await
            .map_err(|e| e.message)?,
    )
}

pub async fn job_get(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.artifact.media.get_async(&a.id).await.map_err(|e| e.message)?)
}

pub async fn job_list(f: &ToolRegistry, _who: &Who, _: EmptyArgs) -> Result<String, String> {
    text(&f.artifact.media.list_async().await.map_err(|e| e.message)?)
}

pub async fn job_cancel(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.artifact.media.cancel_async(&a.id).await.map_err(|e| e.message)?)
}

pub async fn job_download(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.artifact.media.retry_download_async(&a.id).await.map_err(|e| e.message)?)
}

pub async fn library_list(f: &ToolRegistry, _who: &Who, req: LibraryListRequest) -> Result<String, String> {
    let items = f.artifact.library.list_async(&req).await.map_err(|e| e.message)?;
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
    let item = f.artifact.library.add_async(&req, &by).await.map_err(|e| format!("没成：{}", e.message))?;
    Ok(format!("放进素材库了：「{}」，id={}。", item.attachment.name, item.attachment.id))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListArgs {
    channel: Option<String>,
    issue: Option<String>,
    artifact_type: Option<ArtifactType>,
}

pub async fn artifact_list(f: &ToolRegistry, who: &Who, a: ArtifactListArgs) -> Result<String, String> {
    let channel = given(&a.channel).map(String::from);
    let mut issue = match given(&a.issue) {
        Some(r) => Some(f.issue_async(r).await?.id),
        None => None,
    };
    if let (Who::Helper(me), None) = (who, &channel) {
        issue = me.issue_id().map(String::from);
    }
    text(
        &f.artifact
            .list_async(&ArtifactListRequest {
                channel,
                issue,
                artifact_type: a.artifact_type,
            })
            .await
            .map_err(|e| e.message)?,
    )
}

pub async fn artifact_get(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.artifact.get_async(&a.id).await.map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct ArtifactContentArgs {
    #[serde(default)]
    id: String,
    version: Option<i64>,
}

pub async fn artifact_content(f: &ToolRegistry, _who: &Who, a: ArtifactContentArgs) -> Result<String, String> {
    let content = f.artifact.content_async(&a.id, a.version).await.map_err(|e| e.message)?;
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
pub struct ArtifactCreateArgs {
    #[serde(flatten)]
    req: ArtifactRequest,
    file: Option<String>,
}

pub async fn artifact_create(f: &ToolRegistry, who: &Who, mut a: ArtifactCreateArgs) -> Result<String, String> {
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
    text(&f.artifact.create_async(&maker_of(who), &a.req).await.map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct ArtifactVersionArgs {
    #[serde(flatten)]
    req: ArtifactVersionRequest,
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

pub async fn artifact_version(f: &ToolRegistry, who: &Who, mut a: ArtifactVersionArgs) -> Result<String, String> {
    if let Who::Helper(me) = who
        && let Some(content) = read_helper_file(f, me, &a.file).await?
    {
        a.req.content = Some(content);
    }
    let meta = commit_meta_for_who(f, who, a.req.note.clone());
    text(&f.artifact.version_with_meta_async(&maker_of(who), &a.req, &meta).await.map_err(|e| e.message)?)
}

pub async fn artifact_type_list(f: &ToolRegistry, _who: &Who, _: EmptyArgs) -> Result<String, String> {
    text(&f.artifact.list_types_async().await.map_err(|e| e.message)?)
}

pub async fn artifact_type_read(f: &ToolRegistry, _who: &Who, req: ArtifactTypeReadRequest) -> Result<String, String> {
    text(&f.artifact.read_type_async(&req).await.map_err(|e| e.message)?)
}

pub async fn artifact_file_list(f: &ToolRegistry, _who: &Who, mut req: ArtifactFileListRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.artifact.list_files_async(&req).await.map_err(|e| e.message)?)
}

pub async fn artifact_file_get(f: &ToolRegistry, _who: &Who, mut req: ArtifactFileGetRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.artifact.get_file_async(&req).await.map_err(|e| e.message)?)
}

pub async fn artifact_file_write(f: &ToolRegistry, who: &Who, mut req: ArtifactFileWriteRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    let meta = commit_meta_for_who(f, who, req.summary.clone());
    text(
        &f.artifact
            .write_files_with_meta_async(&maker_of(who), &req, &meta)
            .await
            .map_err(|e| e.message)?,
    )
}

pub async fn artifact_file_delete(f: &ToolRegistry, who: &Who, mut req: ArtifactFileDeleteRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    let meta = commit_meta_for_who(f, who, req.summary.clone());
    text(
        &f.artifact
            .delete_file_with_meta_async(&maker_of(who), &req, &meta)
            .await
            .map_err(|e| e.message)?,
    )
}

pub async fn artifact_suggestion_list(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.artifact.suggestions_async(a.id.trim()).await.map_err(|e| e.message)?)
}

pub async fn artifact_suggestion_create(f: &ToolRegistry, who: &Who, mut req: ArtifactSuggestionCreateInput) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.artifact.create_suggestion_async(actor_of(who), &req).await.map_err(|e| e.message)?)
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
    use vibevalley_protocol::{ArtifactRequest, ArtifactType};

    #[test]
    fn a_file_outside_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(super::inside(dir.path(), "a.md").is_ok());
        assert!(super::inside(dir.path(), "../a.md").is_err());
    }

    #[test]
    fn artifact_request_accepts_all_12_types() {
        for ty in ArtifactType::ALL {
            let req = ArtifactRequest {
                title: "Spec".into(),
                artifact_type: ty,
                content: Some("body".into()),
                files: None,
                is_default: None,
                announce: None,
                note: None,
                channel: None,
                issue: None,
            };
            assert_eq!(req.artifact_type, ty);
        }
    }
}
