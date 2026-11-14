//! Notes, artifacts, the library and media. The orchestrator reaches them
//! as the hub serves it; a helper as itself, so what it makes is its own and
//! a `file` it names is read from its own folder.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use vibevalley_protocol::{
    ArtifactListRequest, ArtifactRequest, ArtifactVersionRequest, BlockCreate, BlockDelete, BlockUpdate, Caller, LibraryAddRequest, LibraryListRequest,
    MediaSource, PkmSearchRequest, Session,
};

use super::{Farm, Who, Words, args};
use crate::modules::artifact::Maker;
use crate::modules::library::AddedBy;

fn text<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

fn read<T: DeserializeOwned>(w: &Words, raw: &Value) -> Result<T, String> {
    args(&w.parameters, raw)
}

fn id_of(raw: &Value) -> &str {
    raw["id"].as_str().unwrap_or("")
}

pub fn pkm(f: &Farm, who: &Who, w: &Words, raw: &Value) -> Result<String, String> {
    let Who::Helper(me) = who else {
        return f.endpoint(Caller::Orchestrator, &w.op, raw.clone());
    };
    match w.op.as_str() {
        "pkm.search" => text(&f.pkm.search(&read::<PkmSearchRequest>(w, raw)?).map_err(|e| e.message)?),
        "pkm.page.get" => text(&f.pkm.page(raw["page"].as_str().unwrap_or("")).map_err(|e| e.message)?),
        "pkm.capture" => text(&f.pkm.capture(raw["text"].as_str().unwrap_or(""), Some(&me.id), None).map_err(|e| e.message)?),
        op => f.endpoint(Caller::Session, op, raw.clone()),
    }
}

/// An image only when the user asked for it in this batch.
pub fn image(f: &Farm, who: &Who, w: &Words, raw: &Value) -> Result<String, String> {
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
    text(&f.media.image(read(w, raw)?, source).map_err(|e| e.message)?)
}

pub fn jobs(f: &Farm, _: &Who, w: &Words, raw: &Value) -> Result<String, String> {
    f.endpoint(Caller::Orchestrator, &w.op, raw.clone())
}

#[derive(Deserialize)]
pub struct LibraryList {
    #[serde(flatten)]
    req: LibraryListRequest,
}

pub fn library_list(f: &Farm, _: &Who, a: LibraryList) -> Result<String, String> {
    let items = f.library.list(&a.req).map_err(|e| e.message)?;
    if items.is_empty() {
        return Ok("素材库里没有这样的文件。".into());
    }
    text(&items)
}

#[derive(Deserialize)]
pub struct LibraryAdd {
    #[serde(flatten)]
    req: LibraryAddRequest,
}

pub fn library_add(f: &Farm, who: &Who, a: LibraryAdd) -> Result<String, String> {
    let Who::Helper(me) = who else {
        return f.endpoint(
            Caller::Orchestrator,
            "library.item.add",
            serde_json::to_value(&a.req).map_err(|e| e.to_string())?,
        );
    };
    let by = AddedBy::Agent {
        agent: me.agent.clone(),
        session: Some(me.id.clone()),
        dir: me.worktree.as_ref().map(PathBuf::from),
    };
    let item = f.library.add(&a.req, &by).map_err(|e| format!("没成：{}", e.message))?;
    Ok(format!("放进素材库了：「{}」，id={}。", item.attachment.name, item.attachment.id))
}

#[derive(Deserialize)]
pub struct ArtifactList {
    channel: Option<String>,
    issue: Option<String>,
}

pub fn artifact_list(f: &Farm, who: &Who, a: ArtifactList) -> Result<String, String> {
    let mut req = ArtifactListRequest {
        channel: a.channel,
        issue: a.issue,
    };
    if let (Who::Helper(me), None) = (who, &req.channel) {
        req.issue = me.issue.clone();
    }
    text(&f.artifacts.list(&req).map_err(|e| e.message)?)
}

pub fn artifact_read(f: &Farm, _: &Who, w: &Words, raw: &Value) -> Result<String, String> {
    if w.op == "artifact.get" {
        return text(&f.artifacts.get(id_of(raw)).map_err(|e| e.message)?);
    }
    let (content, _) = f.artifacts.content(id_of(raw), raw["version"].as_i64()).map_err(|e| e.message)?;
    text(&content)
}

pub fn artifact_write(f: &Farm, who: &Who, w: &Words, raw: &Value) -> Result<String, String> {
    let mut payload = super::coerce(&w.parameters, raw);
    match who {
        Who::Orchestrator(here) => {
            if w.op == "artifact.create" && payload["channel"].is_null() && !here.channel.is_empty() {
                payload["channel"] = json!(here.channel);
            }
            f.endpoint(Caller::Orchestrator, &w.op, payload)
        }
        Who::Helper(me) => {
            read_file_into(me, &mut payload)?;
            let maker = Maker {
                from: me.id.clone(),
                by: me.agent.clone(),
                run: None,
            };
            if w.op == "artifact.create" {
                if me.issue.is_some() && payload["issue"].is_null() {
                    payload["issue"] = json!(me.issue);
                }
                let req: ArtifactRequest = serde_json::from_value(payload).map_err(|e| format!("参数不对：{e}"))?;
                return text(&f.artifacts.create(&maker, &req).map_err(|e| e.message)?);
            }
            let req: ArtifactVersionRequest = serde_json::from_value(payload).map_err(|e| format!("参数不对：{e}"))?;
            text(&f.artifacts.version(&maker, &req).map_err(|e| e.message)?)
        }
    }
}

pub fn block(f: &Farm, who: &Who, w: &Words, raw: &Value) -> Result<String, String> {
    let actor = match who {
        Who::Helper(me) => me.agent.clone(),
        Who::Orchestrator(_) => return f.endpoint(Caller::Orchestrator, &w.op, super::coerce(&w.parameters, raw)),
    };
    let id = id_of(raw);
    let done = match w.op.as_str() {
        "artifact.block.create" => f.artifacts.insert_block(id, &actor, &read::<BlockCreate>(w, raw)?),
        "artifact.block.update" => f.artifacts.update_block(id, &actor, &read::<BlockUpdate>(w, raw)?),
        _ => f.artifacts.delete_block(id, &actor, &read::<BlockDelete>(w, raw)?),
    };
    text(&done.map_err(|e| e.message)?)
}

/// `file`: a file in the helper's own folder becomes the content.
fn read_file_into(me: &Session, payload: &mut Value) -> Result<(), String> {
    let Some(file) = payload["file"].as_str().filter(|f| !f.trim().is_empty()).map(String::from) else {
        return Ok(());
    };
    let dir = me.worktree.as_deref().ok_or("你没有工作目录，不能用 file")?;
    let path = inside(Path::new(dir), &file)?;
    payload["content"] = json!(std::fs::read_to_string(&path).map_err(|e| format!("读不了 {file}：{e}"))?);
    if let Some(o) = payload.as_object_mut() {
        o.remove("file");
    }
    Ok(())
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
    #[test]
    fn a_file_outside_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(super::inside(dir.path(), "a.md").is_ok());
        assert!(super::inside(dir.path(), "../a.md").is_err());
    }
}
