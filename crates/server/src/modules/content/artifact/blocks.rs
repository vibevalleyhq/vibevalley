//! A blocks artifact written together (VibeValley `modules/artifact/blocks.ts`):
//! batches of ops in one transaction each, one batch at a time; a batch
//! sent again gets its first answer; the text by rev that a stale update is
//! merged against; suggestions on a block the user wrote; followers of
//! the batches and of the suggestions.

use std::collections::{HashMap, HashSet};

use sqlx::SqliteConnection;
use vibevalley_core::artifact::{MdBlock, Page, blocks_of_markdown, inline_spans, markdown_of, ordered, plain, unmarked};
use vibevalley_core::collab::{CommitMeta, SuggestionSpan, coalesce_suggestions};
use vibevalley_core::rules::key_between;
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    ApiError, ArtifactEvent, Block, BlockAck, BlockAttrs, BlockCreate, BlockDelete, BlockInput, BlockOp, BlockOpDeleteBlock, BlockOpInsertBlock,
    BlockOpMoveBlock, BlockOpResult, BlockOpSetAttrs, BlockOpSetType, BlockOpStatus, BlockOpUpdateText, BlockType, BlockUpdate, Preview, Suggestion,
    SuggestionChange, SuggestionCreate, SuggestionEvent, SuggestionEventKind, SuggestionStatus, TextSpan, USER_ID,
};

use super::collab::commit_meta_for_actor;
use super::db::{self, ArtifactRow, ChangeRow, StoredSuggestion};
use super::{Artifacts, Change, new_id, q, refused};
use crate::{Sink, now};

/// How long a batch is kept to answer it again, and a block's text to
/// merge a stale update against.
pub const KEPT_DAYS: i64 = 30;
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const CATCH_UP_MAX: usize = 200;
const SUGGESTIONS_LISTED: i64 = 500;

const APPEND_TYPES: [BlockType; 7] = [
    BlockType::Paragraph,
    BlockType::Heading,
    BlockType::Bulleted,
    BlockType::Numbered,
    BlockType::Todo,
    BlockType::Quote,
    BlockType::Code,
];

fn type_name(t: BlockType) -> String {
    serde_json::to_value(t).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// `isAppendType`.
fn append_type(name: &str) -> Option<BlockType> {
    APPEND_TYPES.into_iter().find(|t| type_name(*t) == name)
}

fn bad_block_type() -> ApiError {
    let names: Vec<String> = APPEND_TYPES.iter().map(|t| type_name(*t)).collect();
    refused(t("server.artifact.badBlockType", &[("types", list(&names).into())]))
}

/// `spansOf`.
pub fn spans_of(kind: BlockType, text: &str) -> Vec<TextSpan> {
    if kind == BlockType::Code {
        unmarked(&[TextSpan {
            t: text.into(),
            marks: Default::default(),
        }])
    } else {
        inline_spans(text)
    }
}

fn key_or_refuse(a: &str, b: &str) -> Result<String, ApiError> {
    key_between(a, b).map_err(refused)
}

/// What a create or update says about a block's attributes.
struct Asked {
    level: Option<i64>,
    checked: Option<bool>,
    language: Option<String>,
}

impl From<&BlockCreate> for Asked {
    fn from(r: &BlockCreate) -> Asked {
        Asked {
            level: r.level,
            checked: r.checked,
            language: r.language.clone(),
        }
    }
}

impl From<&BlockUpdate> for Asked {
    fn from(r: &BlockUpdate) -> Asked {
        Asked {
            level: r.level,
            checked: r.checked,
            language: r.language.clone(),
        }
    }
}

fn attrs_for(kind: BlockType, req: &Asked) -> BlockAttrs {
    let mut a = BlockAttrs::default();
    match kind {
        BlockType::Heading => a.level = Some(req.level.filter(|l| (1..=3).contains(l)).unwrap_or(2)),
        BlockType::Todo => a.checked = Some(req.checked.unwrap_or(false)),
        BlockType::Code => a.language = req.language.as_deref().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string),
        _ => {}
    }
    a
}

fn attr_problem(kind: BlockType, req: &Asked) -> Option<ApiError> {
    let not_for = |attr: &str| refused(t("server.artifact.attrNotForType", &[("attr", attr.into()), ("type", type_name(kind).into())]));
    if req.level.is_some() && kind != BlockType::Heading {
        return Some(not_for("level"));
    }
    if req.checked.is_some() && kind != BlockType::Todo {
        return Some(not_for("checked"));
    }
    if req.language.is_some() && kind != BlockType::Code {
        return Some(not_for("language"));
    }
    None
}

fn change_problem(c: &SuggestionChange) -> Option<ApiError> {
    let other = c.text.is_some() || c.r#type.is_some() || c.attrs.is_some() || c.unset.is_some();
    if !other && c.delete != Some(true) {
        return Some(refused(t("server.artifact.suggestion.empty", &[])));
    }
    if c.delete == Some(true) && other {
        return Some(refused(t("server.artifact.suggestion.deleteAlone", &[])));
    }
    if c.r#type.is_some_and(|k| !APPEND_TYPES.contains(&k)) {
        return Some(bad_block_type());
    }
    None
}

fn diverted(block: &str, rev: i64, made: &Suggestion) -> BlockOpResult {
    BlockOpResult {
        status: BlockOpStatus::Rejected,
        block_id: block.into(),
        rev: Some(rev),
        text: None,
        yours: None,
        reason: Some(t("server.artifact.suggestion.suggested", &[("id", made.id.as_str().into())])),
        suggestion: Some(made.id.clone()),
    }
}

fn fresh_id(op: &BlockOp) -> Option<&str> {
    match op {
        BlockOp::InsertBlock(o) => Some(&o.block.id),
        BlockOp::SplitBlock(o) => Some(&o.new_block.id),
        _ => None,
    }
}

fn base_of(op: &BlockOp) -> Option<(&str, i64)> {
    match op {
        BlockOp::UpdateText(o) => Some((&o.block_id, o.base_rev)),
        BlockOp::SplitBlock(o) => Some((&o.block_id, o.base_rev)),
        _ => None,
    }
}

impl Artifacts {
    /// `foundBlocks`: the artifact, refused when it is not written in blocks.
    pub(super) fn found_blocks(&self, db: &mut SqliteConnection, id: &str) -> Result<ArtifactRow, ApiError> {
        let row = self.found(db, id)?;
        if row.body != "blocks" {
            return Err(refused(t("server.artifact.notBlocks", &[("title", row.title.as_str().into())])));
        }
        Ok(row)
    }

    fn blocks_of(&self, id: &str) -> Result<Vec<Block>, ApiError> {
        db::blocks(&mut self.db(), id).map_err(q)
    }

    /// The live blocks in order.
    pub fn live_blocks(&self, id: &str) -> Result<Vec<Block>, ApiError> {
        let mut db = self.db();
        self.found_blocks(&mut db, id)?;
        Ok(ordered(&db::blocks(&mut db, id).map_err(q)?))
    }

    pub fn markdown(&self, id: &str) -> Result<String, ApiError> {
        Ok(markdown_of(&self.live_blocks(id)?))
    }

    fn again(&self, all: &[Block], id: &str, seen: ChangeRow) -> Result<BlockAck, ApiError> {
        if seen.artifact_id != id {
            return Err(refused(t("server.artifact.otherArtifact", &[("batch", seen.batch_id.as_str().into())])));
        }
        let blocks = seen.block_ids.iter().flat_map(|b| all.iter().filter(move |x| &x.id == b).cloned()).collect();
        Ok(BlockAck {
            batch_id: seen.batch_id,
            seq: seen.seq,
            results: seen.results,
            blocks,
        })
    }

    /// `submit`: one batch, in one transaction, one at a time.
    pub fn submit(&self, id: &str, actor: &str, batch_id: &str, ops: Vec<BlockOp>) -> Result<BlockAck, ApiError> {
        let _batches = self.batches.lock();
        self.submit_locked(id, actor, batch_id, ops, None)
    }

    pub fn submit_with_meta(&self, id: &str, actor: &str, batch_id: &str, ops: Vec<BlockOp>, meta: &CommitMeta) -> Result<BlockAck, ApiError> {
        let _batches = self.batches.lock();
        self.submit_locked(id, actor, batch_id, ops, Some(meta))
    }

    /// One batch, under the batch lock the caller holds.
    fn submit_locked(&self, id: &str, actor: &str, batch_id: &str, ops: Vec<BlockOp>, meta: Option<&CommitMeta>) -> Result<BlockAck, ApiError> {
        if batch_id.trim().is_empty() {
            return Err(refused(t("server.artifact.noBatch", &[])));
        }
        let (ack, fresh) = {
            let mut conn = self.db();
            use sqlx::Connection;
            let mut tx = pollster::block_on(conn.begin_with("BEGIN IMMEDIATE")).map_err(q)?;
            let result = self.apply_batch(&mut tx, id, actor, batch_id, &ops, meta)?;
            pollster::block_on(tx.commit()).map_err(q)?;
            result
        };
        if fresh {
            self.publish_change(id, &ack);
        }
        Ok(ack)
    }

    fn apply_batch(
        &self,
        db: &mut SqliteConnection,
        id: &str,
        actor: &str,
        batch_id: &str,
        ops: &[BlockOp],
        explicit_meta: Option<&CommitMeta>,
    ) -> Result<(BlockAck, bool), ApiError> {
        let row = self.found_blocks(db, id)?;
        let all = db::blocks(db, id).map_err(q)?;
        if let Some(seen) = db::change_by_batch(db, batch_id).map_err(q)? {
            return Ok((self.again(&all, id, seen)?, false));
        }
        let at = now();
        let mut p = Page::new(id, actor, at, &all);
        // Page.apply runs without the database: the base texts and the
        // ids other artifacts hold are read first.
        let mut revisions: HashMap<(String, i64), Vec<TextSpan>> = HashMap::new();
        for op in ops {
            let Some((block, base)) = base_of(op) else { continue };
            let Some(b) = p.find(block) else { continue };
            if base > b.rev || revisions.contains_key(&(b.id.clone(), base)) {
                continue;
            }
            if base == b.rev {
                revisions.insert((b.id.clone(), base), b.text.clone());
                continue;
            }
            if let Some(spans) = db::revision(db, &b.id, base).map_err(q)? {
                revisions.insert((b.id.clone(), base), spans);
            }
        }
        let mut taken = HashSet::new();
        for op in ops {
            if let Some(fresh) = fresh_id(op)
                && db::block_owner(db, fresh).map_err(q)?.is_some()
            {
                taken.insert(fresh.to_string());
            }
        }
        p.base = Box::new(move |block, rev| revisions.get(&(block.to_string(), rev)).cloned());
        p.taken = Box::new(move |block| taken.contains(block));
        let results: Vec<BlockOpResult> = ops.iter().map(|op| p.apply(op)).collect();
        let changed = p.changed_blocks();
        let post_all: Vec<Block> = p.all().cloned().collect();
        for b in &changed {
            db::put_block(db, id, b).map_err(q)?;
        }
        for r in &p.revisions {
            db::add_revision(db, &r.block, r.rev, &r.spans, actor, r.kind.as_str(), at).map_err(q)?;
        }
        let seq = row.seq + 1;
        db::add_change(
            db,
            &db::NewChange {
                artifact_id: id,
                seq,
                batch_id,
                actor,
                block_ids: &p.changed,
                results: &results,
                created_at: at,
            },
        )
        .map_err(q)?;
        db::artifact_accepted(db, id, seq, at).map_err(q)?;
        if !changed.is_empty() {
            let meta = explicit_meta.cloned().unwrap_or_else(|| commit_meta_for_actor(actor, None, at));
            self.sync_blocks_to_collab(db, &row, &all, &post_all, &changed, &meta)?;
        }
        Ok((
            BlockAck {
                batch_id: batch_id.into(),
                seq,
                results,
                blocks: changed,
            },
            true,
        ))
    }

    pub(super) fn publish_change(&self, id: &str, ack: &BlockAck) {
        let change = Change {
            artifact: id.into(),
            ack: ack.clone(),
        };
        self.changes.lock().retain(|tx| tx.send(change.clone()).is_ok());
    }

    pub fn insert_block(&self, artifact: &str, actor: &str, req: &BlockCreate) -> Result<BlockOpResult, ApiError> {
        self.insert_block_inner(artifact, actor, req, None)
    }

    pub fn insert_block_with_meta(&self, artifact: &str, actor: &str, req: &BlockCreate, meta: &CommitMeta) -> Result<BlockOpResult, ApiError> {
        self.insert_block_inner(artifact, actor, req, Some(meta))
    }

    fn insert_block_inner(&self, artifact: &str, actor: &str, req: &BlockCreate, meta: Option<&CommitMeta>) -> Result<BlockOpResult, ApiError> {
        self.found_blocks(&mut self.db(), artifact)?;
        let name = req.r#type.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("paragraph");
        let kind = append_type(name).ok_or_else(bad_block_type)?;
        if let Some(problem) = attr_problem(kind, &req.into()) {
            return Err(problem);
        }
        let _batches = self.batches.lock();
        let page = Page::new(artifact, actor, 0, &self.blocks_of(artifact)?);
        let parent = req.parent_id.as_deref().map(str::trim).unwrap_or("").to_string();
        if !parent.is_empty() {
            let Some(b) = page.find(&parent) else {
                return Err(refused(t("server.artifact.op.noBlock", &[("id", parent.as_str().into())])));
            };
            if b.deleted == Some(true) {
                return Err(refused(t("server.artifact.parentDeleted", &[("id", parent.as_str().into())])));
            }
        }
        let siblings = page.children(&parent);
        let (after, before) = match req.after_block.as_deref() {
            None => (siblings.last().map(|b| b.order_key.clone()).unwrap_or_default(), String::new()),
            Some("") => (String::new(), siblings.first().map(|b| b.order_key.clone()).unwrap_or_default()),
            Some(id) => {
                let Some(at) = siblings.iter().position(|b| b.id == id) else {
                    return Err(refused(t("server.artifact.afterNotSibling", &[("id", id.into())])));
                };
                (
                    siblings[at].order_key.clone(),
                    siblings.get(at + 1).map(|b| b.order_key.clone()).unwrap_or_default(),
                )
            }
        };
        let block = BlockInput {
            id: new_id(),
            parent_id: (!parent.is_empty()).then_some(parent),
            order_key: key_or_refuse(&after, &before)?,
            r#type: kind,
            attrs: attrs_for(kind, &req.into()),
            text: spans_of(kind, &req.text),
        };
        let ack = self.submit_locked(artifact, actor, &new_id(), vec![BlockOp::InsertBlock(BlockOpInsertBlock { block })], meta)?;
        ack.results.into_iter().next().ok_or_else(|| refused(t("server.artifact.notApplied", &[])))
    }

    pub fn update_block(&self, artifact: &str, actor: &str, req: &BlockUpdate) -> Result<BlockOpResult, ApiError> {
        self.update_block_inner(artifact, actor, req, None)
    }

    pub fn update_block_with_meta(&self, artifact: &str, actor: &str, req: &BlockUpdate, meta: &CommitMeta) -> Result<BlockOpResult, ApiError> {
        self.update_block_inner(artifact, actor, req, Some(meta))
    }

    fn update_block_inner(&self, artifact: &str, actor: &str, req: &BlockUpdate, meta: Option<&CommitMeta>) -> Result<BlockOpResult, ApiError> {
        let block = req.block.trim().to_string();
        let Some(now_b) = self.blocks_of(artifact)?.into_iter().find(|b| b.id == block) else {
            return Err(refused(t("server.artifact.op.noBlock", &[("id", block.as_str().into())])));
        };
        if actor != USER_ID && now_b.updated_by == USER_ID {
            let wanted = req.r#type.as_deref().map(str::trim);
            let wanted_type = match wanted {
                Some(w) => Some(append_type(w).ok_or_else(bad_block_type)?),
                None => None,
            };
            let attrs = BlockAttrs {
                level: req.level,
                checked: req.checked,
                language: req.language.clone(),
                ..BlockAttrs::default()
            };
            let any_attr = req.level.is_some() || req.checked.is_some() || req.language.is_some();
            let change = SuggestionChange {
                text: req.text.as_deref().map(|t| spans_of(wanted_type.unwrap_or(now_b.r#type), t)),
                r#type: wanted_type,
                attrs: any_attr.then_some(attrs),
                unset: None,
                delete: None,
            };
            let origin = meta.map(|m| m.origin.as_str());
            let made = self.suggest_with_origin(
                artifact,
                actor,
                origin,
                &SuggestionCreate {
                    block: block.clone(),
                    base_rev: req.base_rev,
                    change,
                },
            )?;
            return Ok(diverted(&block, now_b.rev, &made));
        }
        let asked: Asked = req.into();
        let mut ops = vec![];
        let mut kind = now_b.r#type;
        if let Some(name) = &req.r#type {
            let k = append_type(name.trim()).ok_or_else(bad_block_type)?;
            if let Some(problem) = attr_problem(k, &asked) {
                return Err(problem);
            }
            kind = k;
            ops.push(BlockOp::SetType(BlockOpSetType {
                block_id: block.clone(),
                r#type: kind,
                attrs: attrs_for(kind, &asked),
            }));
        } else if asked.level.is_some() || asked.checked.is_some() || asked.language.is_some() {
            if let Some(problem) = attr_problem(now_b.r#type, &asked) {
                return Err(problem);
            }
            ops.push(BlockOp::SetAttrs(BlockOpSetAttrs {
                block_id: block.clone(),
                attrs: attrs_for(now_b.r#type, &asked),
                unset: None,
            }));
        }
        if let Some(text) = &req.text {
            ops.push(BlockOp::UpdateText(BlockOpUpdateText {
                block_id: block.clone(),
                base_rev: req.base_rev,
                text: spans_of(kind, text),
            }));
        }
        if ops.is_empty() {
            return Err(refused(t("server.artifact.nothingToChange", &[])));
        }
        let ack = match meta {
            Some(m) => self.submit_with_meta(artifact, actor, &new_id(), ops, m)?,
            None => self.submit(artifact, actor, &new_id(), ops)?,
        };
        ack.results.into_iter().last().ok_or_else(|| refused(t("server.artifact.notApplied", &[])))
    }

    pub fn move_block_with_meta(
        &self,
        artifact: &str,
        actor: &str,
        block: &str,
        parent_id: Option<&str>,
        after_block: Option<&str>,
        meta: &CommitMeta,
    ) -> Result<BlockOpResult, ApiError> {
        self.found_blocks(&mut self.db(), artifact)?;
        let block_id = block.trim().to_string();
        let _batches = self.batches.lock();
        let page = Page::new(artifact, actor, 0, &self.blocks_of(artifact)?);
        let Some(existing) = page.find(&block_id) else {
            return Err(refused(t("server.artifact.op.noBlock", &[("id", block_id.as_str().into())])));
        };
        if existing.deleted == Some(true) {
            return Err(refused(t("server.artifact.op.noBlock", &[("id", block_id.as_str().into())])));
        }
        let parent = parent_id.map(str::trim).unwrap_or("").to_string();
        if !parent.is_empty() {
            let Some(b) = page.find(&parent) else {
                return Err(refused(t("server.artifact.op.noBlock", &[("id", parent.as_str().into())])));
            };
            if b.deleted == Some(true) {
                return Err(refused(t("server.artifact.parentDeleted", &[("id", parent.as_str().into())])));
            }
        }
        let siblings: Vec<_> = page.children(&parent).into_iter().filter(|b| b.id != block_id).collect();
        let (after, before) = match after_block {
            None => (siblings.last().map(|b| b.order_key.clone()).unwrap_or_default(), String::new()),
            Some("") => (String::new(), siblings.first().map(|b| b.order_key.clone()).unwrap_or_default()),
            Some(id) => {
                let Some(at) = siblings.iter().position(|b| b.id == id) else {
                    return Err(refused(t("server.artifact.afterNotSibling", &[("id", id.into())])));
                };
                (
                    siblings[at].order_key.clone(),
                    siblings.get(at + 1).map(|b| b.order_key.clone()).unwrap_or_default(),
                )
            }
        };
        let op = BlockOp::MoveBlock(BlockOpMoveBlock {
            block_id,
            parent_id: (!parent.is_empty()).then_some(parent),
            order_key: key_or_refuse(&after, &before)?,
        });
        let ack = self.submit_locked(artifact, actor, &new_id(), vec![op], Some(meta))?;
        ack.results.into_iter().next().ok_or_else(|| refused(t("server.artifact.notApplied", &[])))
    }

    pub fn delete_block(&self, artifact: &str, actor: &str, req: &BlockDelete) -> Result<BlockOpResult, ApiError> {
        self.delete_block_inner(artifact, actor, req, None)
    }

    pub fn delete_block_with_meta(&self, artifact: &str, actor: &str, req: &BlockDelete, meta: &CommitMeta) -> Result<BlockOpResult, ApiError> {
        self.delete_block_inner(artifact, actor, req, Some(meta))
    }

    fn delete_block_inner(&self, artifact: &str, actor: &str, req: &BlockDelete, meta: Option<&CommitMeta>) -> Result<BlockOpResult, ApiError> {
        let block = req.block.trim().to_string();
        let now_b = self.blocks_of(artifact)?.into_iter().find(|b| b.id == block);
        if let Some(b) = now_b
            && actor != USER_ID
            && b.updated_by == USER_ID
        {
            let change = SuggestionChange {
                delete: Some(true),
                ..SuggestionChange::default()
            };
            let origin = meta.map(|m| m.origin.as_str());
            let made = self.suggest_with_origin(
                artifact,
                actor,
                origin,
                &SuggestionCreate {
                    block: block.clone(),
                    base_rev: b.rev,
                    change,
                },
            )?;
            return Ok(diverted(&block, b.rev, &made));
        }
        let ops = vec![BlockOp::DeleteBlock(BlockOpDeleteBlock { block_id: block })];
        let ack = match meta {
            Some(m) => self.submit_with_meta(artifact, actor, &new_id(), ops, m)?,
            None => self.submit(artifact, actor, &new_id(), ops)?,
        };
        ack.results.into_iter().next().ok_or_else(|| refused(t("server.artifact.notApplied", &[])))
    }

    pub fn preview_delete_block(&self, artifact: &str, req: &BlockDelete) -> Result<Preview, ApiError> {
        let all = self.blocks_of(artifact)?;
        let Some(block) = all.iter().find(|b| b.id == req.block) else {
            return Err(refused(t("server.artifact.op.noBlock", &[("id", req.block.as_str().into())])));
        };
        let children = all.iter().filter(|b| b.parent_id.as_deref() == Some(block.id.as_str())).count();
        let mut does = vec![t("server.artifact.preview.removeBlock", &[("id", block.id.as_str().into())])];
        if children > 0 {
            does.push(t("server.artifact.preview.removeChildren", &[("n", children.into())]));
        }
        Ok(Preview { does })
    }

    /// `follow`: each batch after `after`, then each from now on; `Reset`
    /// when too far behind.
    pub fn follow(&self, id: &str, after: i64, sink: Sink) -> Result<(), ApiError> {
        let (rx, missed, current) = {
            let mut db = self.db();
            self.found_blocks(&mut db, id)?;
            // Subscribed before the catch-up is read; live ones are told by seq.
            let (tx, rx) = flume::unbounded();
            self.changes.lock().push(tx);
            let missed = db::changes_after(&mut db, id, after, CATCH_UP_MAX as i64 + 1).map_err(q)?;
            (rx, missed, db::blocks(&mut db, id).map_err(q)?)
        };
        let id = id.to_string();
        std::thread::Builder::new()
            .name("vibevalley-artifact-follow".into())
            .spawn(move || {
                if missed.len() > CATCH_UP_MAX {
                    sink.send(&ArtifactEvent::Reset {});
                    return;
                }
                let upto = missed.last().map_or(after, |c| c.seq);
                for c in &missed {
                    let blocks = c.block_ids.iter().flat_map(|b| current.iter().filter(move |x| &x.id == b).cloned()).collect();
                    if !sink.send(&ArtifactEvent::Blocks { seq: c.seq, blocks }) {
                        return;
                    }
                }
                relay(&rx, &sink, |c: Change| {
                    (c.artifact == id && c.ack.seq > upto).then_some(ArtifactEvent::Blocks {
                        seq: c.ack.seq,
                        blocks: c.ack.blocks,
                    })
                });
            })
            .map_err(crate::base::internal)?;
        Ok(())
    }

    pub fn suggestions(&self, id: &str) -> Result<Vec<Suggestion>, ApiError> {
        let mut db = self.db();
        self.found_blocks(&mut db, id)?;
        let mut list = db::suggestions(&mut db, id, SUGGESTIONS_LISTED).map_err(q)?;
        self.hydrate_suggestion_offsets(&mut db, id, &mut list);
        Ok(list)
    }

    fn publish_suggestions(&self, id: &str) -> Result<(), ApiError> {
        let list = self.suggestions(id)?;
        self.suggestion_changes.lock().retain(|tx| tx.send((id.to_string(), list.clone())).is_ok());
        Ok(())
    }

    pub fn suggest(&self, artifact: &str, actor: &str, req: &SuggestionCreate) -> Result<Suggestion, ApiError> {
        self.suggest_with_origin(artifact, actor, None, req)
    }

    pub fn suggest_with_origin(&self, artifact: &str, actor: &str, origin: Option<&str>, req: &SuggestionCreate) -> Result<Suggestion, ApiError> {
        let made = {
            let mut db = self.db();
            let row = self.found_blocks(&mut db, artifact)?;
            let all_blocks = db::blocks(&mut db, artifact).map_err(q)?;
            let block = all_blocks.iter().find(|b| b.id == req.block);
            let Some(block) = block.filter(|b| b.deleted != Some(true)) else {
                return Err(refused(t("server.artifact.suggestion.noBlock", &[("id", req.block.as_str().into())])));
            };
            if let Some(problem) = change_problem(&req.change) {
                return Err(problem);
            }
            if req.base_rev > block.rev {
                return Err(refused(t(
                    "server.artifact.suggestion.beyond",
                    &[("rev", req.base_rev.into()), ("now", block.rev.into())],
                )));
            }
            let at = now();
            let effective_origin = origin.map(str::to_string).unwrap_or_else(|| commit_meta_for_actor(actor, None, at).origin);
            let is_text_only = req.change.text.is_some()
                && req.change.r#type.is_none()
                && req.change.attrs.is_none()
                && req.change.unset.is_none()
                && req.change.delete != Some(true);

            let (cursor_start, cursor_end, start_offset, end_offset, anchor_text, replacement_text) = if let Some(spans) = &req.change.text {
                let new_text = plain(spans);
                let (cs, ce, so, eo, orig, repl) = self.anchor_suggestion_range(&mut db, &row, &all_blocks, block, &new_text)?;
                (Some(cs), Some(ce), Some(so), Some(eo), Some(orig), Some(repl))
            } else {
                (None, None, None, None, None, None)
            };

            // Coalesce overlapping/adjacent text-only suggestions from the same origin on the same block.
            if is_text_only && let (Some(so), Some(eo)) = (start_offset, end_offset) {
                let open_same: Vec<StoredSuggestion> = db::stored_suggestions(&mut db, artifact, SUGGESTIONS_LISTED)
                    .map_err(q)?
                    .into_iter()
                    .filter(|s| {
                        s.wire.status == SuggestionStatus::Open
                            && s.wire.block_id == req.block
                            && s.origin.as_deref() == Some(effective_origin.as_str())
                            && s.wire.change.text.is_some()
                            && s.wire.change.r#type.is_none()
                            && s.wire.change.attrs.is_none()
                            && s.wire.change.unset.is_none()
                            && s.wire.change.delete != Some(true)
                    })
                    .collect();
                if !open_same.is_empty() {
                    let mut spans: Vec<SuggestionSpan> = open_same
                        .iter()
                        .filter_map(|s| {
                            Some(SuggestionSpan {
                                id: s.wire.id.clone(),
                                origin: effective_origin.clone(),
                                text_key: s.wire.block_id.clone(),
                                start: s.wire.start_offset? as usize,
                                end: s.wire.end_offset? as usize,
                                replacement: s.replacement_text.clone().unwrap_or_default(),
                                cursor_start: s.wire.cursor_start.clone(),
                                cursor_end: s.wire.cursor_end.clone(),
                            })
                        })
                        .collect();
                    let new_marker = "__new_suggestion__".to_string();
                    spans.push(SuggestionSpan {
                        id: new_marker.clone(),
                        origin: effective_origin.clone(),
                        text_key: req.block.clone(),
                        start: so as usize,
                        end: eo as usize,
                        replacement: replacement_text.clone().unwrap_or_default(),
                        cursor_start: cursor_start.clone(),
                        cursor_end: cursor_end.clone(),
                    });
                    let before_len = spans.len();
                    let folded = coalesce_suggestions(spans);
                    if folded.len() < before_len
                        && let Some(existing) = open_same
                            .iter()
                            .find(|o| o.wire.start_offset.zip(o.wire.end_offset).is_some_and(|(es, ee)| es <= eo && so <= ee))
                    {
                        let mut updated = StoredSuggestion {
                            wire: Suggestion {
                                base_rev: req.base_rev,
                                change: req.change.clone(),
                                cursor_start: cursor_start.clone(),
                                cursor_end: cursor_end.clone(),
                                start_offset,
                                end_offset,
                                ..existing.wire.clone()
                            },
                            origin: existing.origin.clone(),
                            anchor_text: anchor_text.clone(),
                            replacement_text: replacement_text.clone(),
                        };
                        db::update_suggestion(&mut db, &updated).map_err(q)?;
                        let mut wire = db::suggestion(&mut db, &updated.wire.id).map_err(q)?.unwrap_or_else(|| updated.wire.clone());
                        self.hydrate_suggestion_offsets(&mut db, artifact, std::slice::from_mut(&mut wire));
                        updated.wire = wire;
                        drop(db);
                        self.publish_suggestions(artifact)?;
                        return Ok(updated.wire);
                    }
                }
            }

            let id = new_id();
            let open = StoredSuggestion {
                wire: Suggestion {
                    id: id.clone(),
                    artifact_id: artifact.into(),
                    block_id: req.block.clone(),
                    author: actor.into(),
                    base_rev: req.base_rev,
                    change: req.change.clone(),
                    status: SuggestionStatus::Open,
                    created_at: at,
                    resolved_at: None,
                    resolved_by: None,
                    cursor_start,
                    cursor_end,
                    start_offset,
                    end_offset,
                },
                origin: Some(effective_origin),
                anchor_text,
                replacement_text,
            };
            db::add_suggestion(&mut db, &open).map_err(q)?;
            let mut made = db::suggestion(&mut db, &id)
                .map_err(q)?
                .ok_or_else(|| refused(t("server.artifact.suggestion.missing", &[("id", id.as_str().into())])))?;
            self.hydrate_suggestion_offsets(&mut db, artifact, std::slice::from_mut(&mut made));
            made
        };
        self.publish_suggestions(artifact)?;
        Ok(made)
    }

    fn open_stored_suggestion(&self, artifact: &str, suggestion: &str) -> Result<StoredSuggestion, ApiError> {
        db::stored_suggestion(&mut self.db(), suggestion)
            .map_err(q)?
            .filter(|s| s.wire.artifact_id == artifact)
            .ok_or_else(|| refused(t("server.artifact.suggestion.missing", &[("id", suggestion.into())])))
    }

    fn resolve(&self, artifact: &str, row: &Suggestion, status: SuggestionStatus, actor: &str) -> Result<Suggestion, ApiError> {
        let updated = {
            let mut db = self.db();
            db::resolve_suggestion(&mut db, &row.id, status.as_str(), now(), actor).map_err(q)?;
            db::suggestion(&mut db, &row.id).map_err(q)?
        };
        self.publish_suggestions(artifact)?;
        Ok(updated.unwrap_or_else(|| row.clone()))
    }

    pub fn accept_suggestion(&self, artifact: &str, suggestion: &str, actor: &str) -> Result<Suggestion, ApiError> {
        let _batches = self.batches.lock();
        let stored = self.open_stored_suggestion(artifact, suggestion)?;
        let row = &stored.wire;
        if row.status != SuggestionStatus::Open {
            return Ok(row.clone());
        }
        let block = self.blocks_of(artifact)?.into_iter().find(|b| b.id == row.block_id);
        let Some(block) = block.filter(|b| b.deleted != Some(true)) else {
            return Err(refused(t("server.artifact.suggestion.noBlock", &[("id", row.block_id.as_str().into())])));
        };
        let c = &row.change;
        let is_text_only = c.text.is_some() && c.r#type.is_none() && c.attrs.is_none() && c.unset.is_none() && c.delete != Some(true);
        let ops = if block.rev != row.base_rev {
            // When the block moved on, a persistent Loro `Cursor` anchor lets
            // text-only suggestions apply cleanly if the anchored span is intact.
            if is_text_only && let Some(merged_text) = self.try_merge_cursor_suggestion(artifact, &block, &stored)? {
                vec![BlockOp::UpdateText(BlockOpUpdateText {
                    block_id: block.id.clone(),
                    base_rev: block.rev,
                    text: spans_of(block.r#type, &merged_text),
                })]
            } else {
                return Err(refused(t(
                    "server.artifact.suggestion.stale",
                    &[("rev", row.base_rev.into()), ("now", block.rev.into())],
                )));
            }
        } else {
            let mut ops = vec![];
            if c.delete == Some(true) {
                ops.push(BlockOp::DeleteBlock(BlockOpDeleteBlock { block_id: block.id.clone() }));
            } else {
                if let Some(kind) = c.r#type {
                    ops.push(BlockOp::SetType(BlockOpSetType {
                        block_id: block.id.clone(),
                        r#type: kind,
                        attrs: c.attrs.clone().unwrap_or_default(),
                    }));
                } else if c.attrs.is_some() || c.unset.is_some() {
                    ops.push(BlockOp::SetAttrs(BlockOpSetAttrs {
                        block_id: block.id.clone(),
                        attrs: c.attrs.clone().unwrap_or_default(),
                        unset: c.unset.clone(),
                    }));
                }
                if let Some(text) = &c.text {
                    ops.push(BlockOp::UpdateText(BlockOpUpdateText {
                        block_id: block.id.clone(),
                        base_rev: row.base_rev,
                        text: text.clone(),
                    }));
                }
            }
            ops
        };
        let accept_meta = commit_meta_for_actor(actor, Some(format!("accept suggestion {suggestion}")), now());
        let ack = self.submit_locked(artifact, actor, &format!("suggestion:{suggestion}"), ops, Some(&accept_meta))?;
        if let Some(bad) = ack
            .results
            .iter()
            .find(|r| r.status != BlockOpStatus::Applied && r.status != BlockOpStatus::Noop)
        {
            return Err(refused(bad.reason.clone().unwrap_or_else(|| t("server.artifact.notApplied", &[]))));
        }
        self.resolve(artifact, row, SuggestionStatus::Accepted, actor)
    }

    pub fn reject_suggestion(&self, artifact: &str, suggestion: &str, actor: &str) -> Result<Suggestion, ApiError> {
        let _batches = self.batches.lock();
        let stored = self.open_stored_suggestion(artifact, suggestion)?;
        let row = &stored.wire;
        if row.status != SuggestionStatus::Open {
            return Ok(row.clone());
        }
        self.resolve(artifact, row, SuggestionStatus::Rejected, actor)
    }

    /// `suggestionStream`: the list now, then the whole list after each change.
    pub fn follow_suggestions(&self, id: &str, sink: Sink) -> Result<(), ApiError> {
        let (tx, rx) = flume::unbounded();
        self.suggestion_changes.lock().push(tx);
        let first = self.suggestions(id)?;
        let id = id.to_string();
        std::thread::Builder::new()
            .name("vibevalley-artifact-suggestions".into())
            .spawn(move || {
                let event = |suggestions| SuggestionEvent {
                    tag: SuggestionEventKind::Suggestions,
                    suggestions,
                };
                if !sink.send(&event(first)) {
                    return;
                }
                relay(&rx, &sink, |(artifact, list): (String, Vec<Suggestion>)| (artifact == id).then(|| event(list)));
            })
            .map_err(crate::base::internal)?;
        Ok(())
    }

    /// `fill`: Markdown read into blocks, as one batch.
    pub(super) fn fill_with_meta(
        &self,
        db: &mut SqliteConnection,
        id: &str,
        markdown: &str,
        actor: &str,
        meta: &CommitMeta,
    ) -> Result<Option<BlockAck>, ApiError> {
        self.fill_md_blocks_with_meta(db, id, blocks_of_markdown(markdown), actor, meta)
    }

    /// Inserts pre-parsed Markdown blocks as one atomic batch.
    pub(super) fn fill_md_blocks_with_meta(
        &self,
        db: &mut SqliteConnection,
        id: &str,
        blocks: Vec<MdBlock>,
        actor: &str,
        meta: &CommitMeta,
    ) -> Result<Option<BlockAck>, ApiError> {
        let mut parents: Vec<String> = vec![];
        let mut last: HashMap<String, String> = HashMap::new();
        let mut ops = vec![];
        for b in blocks {
            parents.truncate(b.depth);
            let parent = if b.depth > 0 { parents.get(b.depth - 1).cloned() } else { None };
            let slot = parent.clone().unwrap_or_default();
            let key = key_or_refuse(last.get(&slot).map_or("", String::as_str), "")?;
            last.insert(slot, key.clone());
            let block_id = new_id();
            parents.push(block_id.clone());
            ops.push(BlockOp::InsertBlock(BlockOpInsertBlock {
                block: BlockInput {
                    id: block_id,
                    parent_id: parent,
                    order_key: key,
                    r#type: b.r#type,
                    attrs: b.attrs,
                    text: b.text,
                },
            }));
        }
        if ops.is_empty() {
            return Ok(None);
        }
        let (ack, _) = self.apply_batch(db, id, actor, &new_id(), &ops, Some(meta))?;
        Ok(Some(ack))
    }
}

pub(super) fn relay<T, E: serde::Serialize>(rx: &flume::Receiver<T>, sink: &Sink, keep: impl Fn(T) -> Option<E>) {
    loop {
        if sink.stopped() {
            return;
        }
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(x) => {
                if let Some(e) = keep(x)
                    && !sink.send(&e)
                {
                    return;
                }
            }
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => return,
        }
    }
}
