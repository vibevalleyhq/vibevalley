//! Notes, resources, artifacts, the library and media: every tool takes its
//! typed request directly and reaches the module in process without bouncing
//! back through the hub.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use vibevalley_core::collab::CommitMeta;
use vibevalley_protocol::{
    ArtifactBody, ArtifactEntryBatchRequest, ArtifactEntryGetRequest, ArtifactEntryListRequest, ArtifactKind, ArtifactListRequest, ArtifactRequest,
    ArtifactType, ArtifactTypeReadRequest, ArtifactVersionRequest, BlockCreate, BlockDelete, BlockUpdate, LibraryAddRequest, LibraryListRequest,
    MediaImageRequest, MediaSource, MediaSpeakersRequest, MediaSpeechRequest, MediaVoiceDesignRequest, PkmProposalRequest, PkmSearchRequest, Session,
};

use super::{Farm, Who, given};
use crate::modules::content::artifact::Maker;
use crate::modules::content::library::AddedBy;
use crate::modules::team::mcp::ResourceReadArgs;
use crate::now;

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

pub fn resource_read(f: &Farm, who: &Who, a: ResourceReadArgs) -> Result<String, String> {
    match who {
        Who::Helper(me) => f.resources.read(Some(me), &a),
        Who::Orchestrator(_) => f.resources.read(None, &a),
    }
}

pub fn pkm_search(f: &Farm, _: &Who, req: PkmSearchRequest) -> Result<String, String> {
    text(&f.pkm.search(&req).map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct PkmPageArgs {
    #[serde(default)]
    page: String,
}

pub fn pkm_page(f: &Farm, _: &Who, a: PkmPageArgs) -> Result<String, String> {
    text(&f.pkm.page(&a.page).map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct PkmCaptureArgs {
    #[serde(default)]
    text: String,
    page: Option<String>,
}

pub fn pkm_capture(f: &Farm, who: &Who, a: PkmCaptureArgs) -> Result<String, String> {
    let session = match who {
        Who::Helper(me) => Some(me.id.as_str()),
        Who::Orchestrator(_) => None,
    };
    text(&f.pkm.capture(&a.text, session, given(&a.page)).map_err(|e| e.message)?)
}

pub fn pkm_suggest(f: &Farm, who: &Who, req: PkmProposalRequest) -> Result<String, String> {
    let by = match who {
        Who::Helper(me) => me.agent.as_str(),
        Who::Orchestrator(here) => here.agent.as_str(),
    };
    text(&f.pkm.suggest(&req, by).map_err(|e| e.message)?)
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
pub fn image(f: &Farm, who: &Who, req: MediaImageRequest) -> Result<String, String> {
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
    text(&f.media.image(req, source).map_err(|e| e.message)?)
}

pub fn speech(f: &Farm, who: &Who, req: MediaSpeechRequest) -> Result<String, String> {
    text(&f.media.speech(req, mandate(who)?).map_err(|e| e.message)?)
}

pub fn dialogue(f: &Farm, who: &Who, req: MediaSpeakersRequest) -> Result<String, String> {
    text(&f.media.speakers(req, mandate(who)?).map_err(|e| e.message)?)
}

pub fn voice_design(f: &Farm, who: &Who, req: MediaVoiceDesignRequest) -> Result<String, String> {
    text(&f.media.voice_design(req, mandate(who)?).map_err(|e| e.message)?)
}

/// Understanding the user approved for this channel, started for them.
pub fn understand(f: &Farm, who: &Who, a: IdArgs) -> Result<String, String> {
    let MediaSource::Orchestrator { agent, channel } = mandate(who)? else {
        return Err(vibevalley_i18n::t("server.media.userRequired", &[]));
    };
    text(&f.media.start_understanding(&a.id, &agent, &channel).map_err(|e| e.message)?)
}

pub fn job_get(f: &Farm, _: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.media.get(&a.id).map_err(|e| e.message)?)
}

pub fn job_list(f: &Farm, _: &Who, _: EmptyArgs) -> Result<String, String> {
    text(&f.media.list().map_err(|e| e.message)?)
}

pub fn job_cancel(f: &Farm, _: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.media.cancel(&a.id).map_err(|e| e.message)?)
}

pub fn job_download(f: &Farm, _: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.media.retry_download(&a.id).map_err(|e| e.message)?)
}

pub fn library_list(f: &Farm, _: &Who, req: LibraryListRequest) -> Result<String, String> {
    let items = f.library.list(&req).map_err(|e| e.message)?;
    if items.is_empty() {
        return Ok("素材库里没有这样的文件。".into());
    }
    text(&items)
}

pub fn library_add(f: &Farm, who: &Who, req: LibraryAddRequest) -> Result<String, String> {
    let by = match who {
        Who::Helper(me) => AddedBy::Agent {
            agent: me.agent.clone(),
            session: Some(me.id.clone()),
            dir: me.worktree.as_ref().map(PathBuf::from),
        },
        Who::Orchestrator(here) => AddedBy::Agent {
            agent: here.agent.clone(),
            session: None,
            dir: None,
        },
    };
    let item = f.library.add(&req, &by).map_err(|e| format!("没成：{}", e.message))?;
    Ok(format!("放进素材库了：「{}」，id={}。", item.attachment.name, item.attachment.id))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListArgs {
    channel: Option<String>,
    issue: Option<String>,
    artifact_type: Option<ArtifactType>,
}

pub fn artifact_list(f: &Farm, who: &Who, a: ArtifactListArgs) -> Result<String, String> {
    let channel = given(&a.channel).map(String::from);
    let mut issue = match given(&a.issue) {
        Some(r) => Some(f.issue(r)?.id),
        None => None,
    };
    if let (Who::Helper(me), None) = (who, &channel) {
        issue = me.issue.clone();
    }
    text(
        &f.artifacts
            .list(&ArtifactListRequest {
                channel,
                issue,
                artifact_type: a.artifact_type,
            })
            .map_err(|e| e.message)?,
    )
}

pub fn artifact_get(f: &Farm, _: &Who, a: IdArgs) -> Result<String, String> {
    text(&f.artifacts.get(&a.id).map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct ArtifactContentArgs {
    #[serde(default)]
    id: String,
    version: Option<i64>,
}

pub fn artifact_content(f: &Farm, _: &Who, a: ArtifactContentArgs) -> Result<String, String> {
    let (content, _) = f.artifacts.content(&a.id, a.version).map_err(|e| e.message)?;
    text(&content)
}

fn maker_of(who: &Who) -> Maker {
    match who {
        Who::Helper(me) => Maker {
            from: me.id.clone(),
            by: me.agent.clone(),
            run: None,
        },
        Who::Orchestrator(here) => Maker {
            from: here.agent.clone(),
            by: here.agent.clone(),
            run: None,
        },
    }
}

#[derive(Deserialize)]
pub struct ArtifactCreateArgs {
    #[serde(flatten)]
    req: ArtifactRequest,
    file: Option<String>,
}

fn is_store_create(req: &ArtifactRequest, file: Option<&str>) -> bool {
    req.artifact_type.is_some_and(|t| t.body() == ArtifactBody::Store)
        || req.kind == Some(ArtifactKind::Store)
        || (req.entries.is_some() && req.content.is_none() && file.is_none())
}

fn prepare_artifact_create(req: &mut ArtifactRequest, file: Option<&str>) {
    if is_store_create(req, file) || (req.artifact_type.is_some_and(|t| t.body() == ArtifactBody::Blocks) && req.content.is_none() && file.is_none()) {
        return;
    }
    if req.kind.is_none() && req.content.is_some() {
        req.kind = Some(ArtifactKind::Markdown);
    }
    if req.kind == Some(ArtifactKind::Html) && req.display.is_none() {
        let name = file.unwrap_or(req.title.as_str());
        req.display = vibevalley_core::artifact::infer_artifact_from_name(name, req.content.as_deref()).display;
    }
}

pub fn artifact_create(f: &Farm, who: &Who, mut a: ArtifactCreateArgs) -> Result<String, String> {
    let file = given(&a.file).map(str::to_string);
    if a.req.content.is_some() && file.is_some() {
        return Err("content 和 file 只能填一个".into());
    }
    match who {
        Who::Orchestrator(here) => {
            if given(&a.req.channel).is_none() && !here.channel.is_empty() {
                a.req.channel = Some(here.channel.clone());
            }
            a.req.issue = match given(&a.req.issue) {
                Some(r) => Some(f.issue(r)?.id),
                None => None,
            };
        }
        Who::Helper(me) => {
            if let Some(content) = read_helper_file(me, &a.file)? {
                a.req.content = Some(content);
            }
            if given(&a.req.issue).is_none() {
                a.req.issue = me.issue.clone();
            }
        }
    }
    prepare_artifact_create(&mut a.req, file.as_deref());
    text(&f.artifacts.create(&maker_of(who), &a.req).map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct ArtifactVersionArgs {
    #[serde(flatten)]
    req: ArtifactVersionRequest,
    file: Option<String>,
}

fn commit_meta_for_who(who: &Who, summary: Option<String>) -> CommitMeta {
    let at = now();
    match who {
        Who::Helper(me) => CommitMeta::session(&me.name, &me.agent, &me.id, me.runs.max(1) as u32, summary, at),
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

pub fn artifact_version(f: &Farm, who: &Who, mut a: ArtifactVersionArgs) -> Result<String, String> {
    if let Who::Helper(me) = who
        && let Some(content) = read_helper_file(me, &a.file)?
    {
        a.req.content = content;
    }
    let meta = commit_meta_for_who(who, a.req.note.clone());
    text(&f.artifacts.version_with_meta(&maker_of(who), &a.req, &meta).map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct BlockCreateArgs {
    #[serde(default)]
    id: String,
    #[serde(flatten)]
    body: BlockCreate,
}

pub fn block_create(f: &Farm, who: &Who, a: BlockCreateArgs) -> Result<String, String> {
    let actor = match who {
        Who::Helper(me) => me.agent.as_str(),
        Who::Orchestrator(here) => here.agent.as_str(),
    };
    let meta = commit_meta_for_who(who, None);
    text(&f.artifacts.insert_block_with_meta(&a.id, actor, &a.body, &meta).map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct BlockUpdateArgs {
    #[serde(default)]
    id: String,
    #[serde(flatten)]
    body: BlockUpdate,
}

pub fn block_update(f: &Farm, who: &Who, a: BlockUpdateArgs) -> Result<String, String> {
    let actor = match who {
        Who::Helper(me) => me.agent.as_str(),
        Who::Orchestrator(here) => here.agent.as_str(),
    };
    let meta = commit_meta_for_who(who, None);
    text(&f.artifacts.update_block_with_meta(&a.id, actor, &a.body, &meta).map_err(|e| e.message)?)
}

#[derive(Deserialize)]
pub struct BlockDeleteArgs {
    #[serde(default)]
    id: String,
    #[serde(flatten)]
    body: BlockDelete,
}

pub fn block_delete(f: &Farm, who: &Who, a: BlockDeleteArgs) -> Result<String, String> {
    let actor = match who {
        Who::Helper(me) => me.agent.as_str(),
        Who::Orchestrator(here) => here.agent.as_str(),
    };
    let meta = commit_meta_for_who(who, None);
    text(&f.artifacts.delete_block_with_meta(&a.id, actor, &a.body, &meta).map_err(|e| e.message)?)
}

pub fn artifact_type_list(f: &Farm, _: &Who, _: EmptyArgs) -> Result<String, String> {
    text(&f.artifacts.list_types().map_err(|e| e.message)?)
}

pub fn artifact_type_read(f: &Farm, _: &Who, req: ArtifactTypeReadRequest) -> Result<String, String> {
    text(&f.artifacts.read_type(&req).map_err(|e| e.message)?)
}

pub fn artifact_entry_list(f: &Farm, _: &Who, mut req: ArtifactEntryListRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.artifacts.list_entries(&req).map_err(|e| e.message)?)
}

pub fn artifact_entry_get(f: &Farm, _: &Who, mut req: ArtifactEntryGetRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    text(&f.artifacts.get_entry(&req).map_err(|e| e.message)?)
}

pub fn artifact_entry_batch(f: &Farm, who: &Who, mut req: ArtifactEntryBatchRequest) -> Result<String, String> {
    req.id = req.id.trim().to_string();
    let meta = commit_meta_for_who(who, req.note.clone());
    text(&f.artifacts.batch_entries_with_meta(&maker_of(who), &req, &meta).map_err(|e| e.message)?)
}

/// `file`: a file in the helper's own folder becomes the content.
fn read_helper_file(me: &Session, file: &Option<String>) -> Result<Option<String>, String> {
    let Some(file) = given(file) else {
        return Ok(None);
    };
    let dir = me.worktree.as_deref().ok_or("你没有工作目录，不能用 file")?;
    let path = inside(Path::new(dir), file)?;
    std::fs::read_to_string(&path).map(Some).map_err(|e| format!("读不了 {file}：{e}"))
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
    use vibevalley_protocol::{ArtifactDisplay, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactKind, ArtifactRequest, ArtifactType};

    fn empty_req(title: &str) -> ArtifactRequest {
        ArtifactRequest {
            title: title.into(),
            kind: None,
            artifact_type: None,
            display: None,
            content: None,
            entries: None,
            is_default: None,
            announce: None,
            note: None,
            channel: None,
            issue: None,
        }
    }

    #[test]
    fn a_file_outside_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(super::inside(dir.path(), "a.md").is_ok());
        assert!(super::inside(dir.path(), "../a.md").is_err());
    }

    #[test]
    fn prepare_artifact_create_preserves_store_and_infers_html_display() {
        let mut store = empty_req("Q3 Deck");
        store.artifact_type = Some(ArtifactType::Slides);
        store.entries = Some(vec![ArtifactEntryWriteInput {
            op: ArtifactEntryOp::Set,
            path: "project/deck.json".into(),
            kind: None,
            value: Some("{}".into()),
            from: None,
            mime: None,
            if_rev: None,
        }]);
        super::prepare_artifact_create(&mut store, None);
        assert_eq!(store.kind, None);
        assert_eq!(store.display, None);

        let mut md = empty_req("Notes");
        md.content = Some("# Hello".into());
        super::prepare_artifact_create(&mut md, None);
        assert_eq!(md.kind, Some(ArtifactKind::Markdown));

        let mut slides_html = empty_req("Deck");
        slides_html.kind = Some(ArtifactKind::Html);
        slides_html.content = Some("<html><body></body></html>".into());
        super::prepare_artifact_create(&mut slides_html, Some("pitch.slide.html"));
        assert_eq!(slides_html.display, Some(ArtifactDisplay::Slides));
    }
}
