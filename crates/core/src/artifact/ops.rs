//! Block ops on one artifact's page (`ops.ts`): each op gives a result, the
//! blocks it touched and their text by rev.

use std::collections::HashMap;

use crate::rules::{key_between, valid_key};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Block, BlockAttrs, BlockInput, BlockOp, BlockOpMergeBlocks, BlockOpMoveBlock, BlockOpResult, BlockOpSplitBlock, BlockOpStatus, BlockOpUpdateText,
    BlockType, TextSpan,
};

use crate::artifact::spans::{has_text, joined, rune_len, same_text, split_at, text_for};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionKind {
    Normal,
    Conflict,
}

impl RevisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RevisionKind::Normal => "normal",
            RevisionKind::Conflict => "conflict",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Revision {
    pub block: String,
    pub rev: i64,
    pub spans: Vec<TextSpan>,
    pub kind: RevisionKind,
}

fn result(status: BlockOpStatus, id: &str, rev: i64, yours: Option<Vec<TextSpan>>, reason: Option<String>) -> BlockOpResult {
    BlockOpResult {
        status,
        block_id: id.to_string(),
        rev: (rev != 0).then_some(rev),
        text: None,
        yours,
        reason,
        suggestion: None,
    }
}

fn applied(b: &Block) -> BlockOpResult {
    result(BlockOpStatus::Applied, &b.id, b.rev, None, None)
}

fn rejected(id: &str, reason: String) -> BlockOpResult {
    result(BlockOpStatus::Rejected, id, 0, None, Some(reason))
}

fn gone(b: &Block) -> BlockOpResult {
    result(BlockOpStatus::Conflict, &b.id, b.rev, None, Some(t("server.artifact.op.deleted", &[])))
}

fn missing(id: &str) -> BlockOpResult {
    rejected(id, t("server.artifact.op.missing", &[]))
}

fn parent_of(b: &Block) -> &str {
    b.parent_id.as_deref().unwrap_or("")
}

pub fn is_deleted(b: &Block) -> bool {
    b.deleted == Some(true)
}

fn patched(attrs: &BlockAttrs, patch: &BlockAttrs, unset: &[String]) -> Result<BlockAttrs, String> {
    let mut out = attrs.clone();
    macro_rules! take {
        ($($f:ident),*) => { $( if patch.$f.is_some() { out.$f = patch.$f.clone(); } )* };
    }
    take!(level, checked, language, src, width, height, alt, issue_id, memory_id);
    for name in unset {
        match name.as_str() {
            "level" => out.level = None,
            "checked" => out.checked = None,
            "language" => out.language = None,
            "src" => out.src = None,
            "width" => out.width = None,
            "height" => out.height = None,
            "alt" => out.alt = None,
            "issueId" => out.issue_id = None,
            "memoryId" => out.memory_id = None,
            _ => return Err(t("server.artifact.op.noAttr", &[("name", name.as_str().into())])),
        }
    }
    Ok(out)
}

/// A block as the wire has it: no parent and not deleted are left out.
pub fn wire(mut b: Block) -> Block {
    if b.deleted != Some(true) {
        b.deleted = None;
    }
    b
}

/// A block's text at a rev, if kept.
pub type BaseText = Box<dyn Fn(&str, i64) -> Option<Vec<TextSpan>>>;

pub struct Page {
    pub artifact: String,
    pub actor: String,
    pub now: i64,
    order: Vec<String>,
    blocks: HashMap<String, Block>,
    pub changed: Vec<String>,
    pub revisions: Vec<Revision>,
    /// A block's text at a rev, if kept.
    pub base: BaseText,
    /// Whether an id is taken by another artifact's block.
    pub taken: Box<dyn Fn(&str) -> bool>,
}

impl Page {
    pub fn new(artifact: &str, actor: &str, now: i64, blocks: &[Block]) -> Page {
        let mut p = Page {
            artifact: artifact.to_string(),
            actor: actor.to_string(),
            now,
            order: vec![],
            blocks: HashMap::new(),
            changed: vec![],
            revisions: vec![],
            base: Box::new(|_, _| None),
            taken: Box::new(|_| false),
        };
        for b in blocks {
            p.put(b.clone());
        }
        p
    }

    fn put(&mut self, b: Block) {
        if !self.blocks.contains_key(&b.id) {
            self.order.push(b.id.clone());
        }
        self.blocks.insert(b.id.clone(), b);
    }

    pub fn find(&self, id: &str) -> Option<&Block> {
        self.blocks.get(id)
    }

    fn get(&mut self, id: &str) -> &mut Block {
        self.blocks.get_mut(id).expect("a block found before")
    }

    /// Every block in the order they came, tombstones too.
    pub fn all(&self) -> impl Iterator<Item = &Block> {
        self.order.iter().filter_map(|id| self.blocks.get(id))
    }

    pub fn changed_blocks(&self) -> Vec<Block> {
        self.changed.iter().filter_map(|id| self.blocks.get(id)).cloned().map(wire).collect()
    }

    fn touch(&mut self, id: &str) {
        let (actor, now) = (self.actor.clone(), self.now);
        let b = self.get(id);
        b.rev += 1;
        b.updated_by = actor;
        b.updated = now;
        let (rev, text) = (b.rev, b.text.clone());
        if !self.changed.iter().any(|c| c == id) {
            self.changed.push(id.to_string());
        }
        self.revisions.push(Revision {
            block: id.to_string(),
            rev,
            spans: text,
            kind: RevisionKind::Normal,
        });
    }

    /// A parent's children by (orderKey, id), tombstones too.
    pub fn children(&self, parent: &str) -> Vec<&Block> {
        let mut out: Vec<&Block> = self.all().filter(|b| parent_of(b) == parent).collect();
        out.sort_by(|a, b| a.order_key.cmp(&b.order_key).then_with(|| a.id.cmp(&b.id)));
        out
    }

    fn live_parent(&self, mut parent: String) -> Result<Option<String>, String> {
        while !parent.is_empty() {
            let Some(b) = self.find(&parent) else {
                return Err(t("server.artifact.op.noBlock", &[("id", parent.as_str().into())]));
            };
            if !is_deleted(b) {
                return Ok(Some(b.id.clone()));
            }
            parent = parent_of(b).to_string();
        }
        Ok(None)
    }

    fn fresh(&self, b: &BlockInput) -> Result<Block, String> {
        if b.id.is_empty() {
            return Err(t("server.artifact.op.noId", &[]));
        }
        if self.find(&b.id).is_some() || (self.taken)(&b.id) {
            return Err(t("server.artifact.op.taken", &[("id", b.id.as_str().into())]));
        }
        if !valid_key(&b.order_key) {
            return Err(t("server.artifact.op.badKey", &[("key", b.order_key.as_str().into())]));
        }
        let parent = self.live_parent(b.parent_id.clone().unwrap_or_default())?;
        Ok(Block {
            id: b.id.clone(),
            parent_id: parent,
            order_key: b.order_key.clone(),
            r#type: b.r#type,
            attrs: b.attrs.clone(),
            text: text_for(b.r#type, &b.text),
            artifact_id: self.artifact.clone(),
            rev: 0,
            deleted: None,
            updated_by: String::new(),
            updated: 0,
        })
    }

    fn unchanged_since(&self, b: &Block, rev: i64) -> bool {
        rev == b.rev || (self.base)(&b.id, rev).is_some_and(|base| same_text(&base, &b.text))
    }

    pub fn apply(&mut self, op: &BlockOp) -> BlockOpResult {
        match op {
            BlockOp::InsertBlock(o) => match self.fresh(&o.block) {
                Err(why) => rejected(&o.block.id, why),
                Ok(b) => {
                    let id = b.id.clone();
                    self.put(b);
                    self.touch(&id);
                    applied(self.get(&id))
                }
            },
            BlockOp::UpdateText(o) => self.update_text(o),
            BlockOp::SetAttrs(o) => {
                let Some(b) = self.find(&o.block_id) else { return missing(&o.block_id) };
                if is_deleted(b) {
                    return gone(b);
                }
                match patched(&b.attrs, &o.attrs, o.unset.as_deref().unwrap_or_default()) {
                    Err(why) => rejected(&b.id.clone(), why),
                    Ok(attrs) => {
                        let id = b.id.clone();
                        self.get(&id).attrs = attrs;
                        self.touch(&id);
                        applied(self.get(&id))
                    }
                }
            }
            BlockOp::SetType(o) => {
                let Some(b) = self.find(&o.block_id) else { return missing(&o.block_id) };
                if is_deleted(b) {
                    return gone(b);
                }
                let id = b.id.clone();
                let b = self.get(&id);
                b.r#type = o.r#type;
                b.attrs = o.attrs.clone();
                b.text = text_for(o.r#type, &b.text);
                self.touch(&id);
                applied(self.get(&id))
            }
            BlockOp::MoveBlock(o) => self.move_block(o),
            BlockOp::DeleteBlock(o) => {
                let Some(b) = self.find(&o.block_id) else { return missing(&o.block_id) };
                if is_deleted(b) {
                    return result(BlockOpStatus::Noop, &b.id, b.rev, None, None);
                }
                let id = b.id.clone();
                self.set_deleted(&id, true);
                applied(self.get(&id))
            }
            BlockOp::RestoreBlock(o) => {
                let Some(b) = self.find(&o.block_id) else { return missing(&o.block_id) };
                if !is_deleted(b) {
                    return result(BlockOpStatus::Noop, &b.id, b.rev, None, None);
                }
                let id = b.id.clone();
                match self.live_parent(parent_of(b).to_string()) {
                    Err(why) => return rejected(&id, why),
                    Ok(parent) => self.get(&id).parent_id = parent,
                }
                self.set_deleted(&id, false);
                applied(self.get(&id))
            }
            BlockOp::SplitBlock(o) => self.split(o),
            BlockOp::MergeBlocks(o) => self.merge(o),
        }
    }

    fn update_text(&mut self, o: &BlockOpUpdateText) -> BlockOpResult {
        let Some(b) = self.find(&o.block_id) else { return missing(&o.block_id) };
        if !has_text(b.r#type) {
            return rejected(&b.id, t("server.artifact.op.noText", &[]));
        }
        if o.base_rev > b.rev || o.base_rev < 1 {
            return rejected(&b.id, t("server.artifact.op.noRev", &[("rev", o.base_rev.into())]));
        }
        let yours = text_for(b.r#type, &o.text);
        if is_deleted(b) {
            let r = gone(b);
            self.lost(&o.block_id, yours);
            return r;
        }
        if !self.unchanged_since(b, o.base_rev) {
            let r = result(
                BlockOpStatus::Conflict,
                &b.id,
                b.rev,
                Some(yours.clone()),
                Some(t("server.artifact.op.changed", &[])),
            );
            self.lost(&o.block_id, yours);
            return r;
        }
        if same_text(&yours, &b.text) {
            return applied(b);
        }
        let id = b.id.clone();
        self.get(&id).text = yours;
        self.touch(&id);
        applied(self.get(&id))
    }

    fn lost(&mut self, id: &str, yours: Vec<TextSpan>) {
        let rev = self.find(id).map_or(0, |b| b.rev);
        self.revisions.push(Revision {
            block: id.to_string(),
            rev,
            spans: yours,
            kind: RevisionKind::Conflict,
        });
    }

    fn set_deleted(&mut self, id: &str, deleted: bool) {
        self.get(id).deleted = Some(deleted);
        self.touch(id);
        let kids: Vec<String> = self
            .children(id)
            .into_iter()
            .filter(|c| is_deleted(c) != deleted)
            .map(|c| c.id.clone())
            .collect();
        for c in kids {
            // A child changed by an earlier sibling's turn is not visited twice.
            if self.find(&c).is_some_and(|b| is_deleted(b) != deleted) {
                self.set_deleted(&c, deleted);
            }
        }
    }

    fn move_block(&mut self, o: &BlockOpMoveBlock) -> BlockOpResult {
        let Some(b) = self.find(&o.block_id) else { return missing(&o.block_id) };
        if is_deleted(b) {
            return gone(b);
        }
        let id = b.id.clone();
        if !valid_key(&o.order_key) {
            return rejected(&id, t("server.artifact.op.badKey", &[("key", o.order_key.as_str().into())]));
        }
        let parent = match self.live_parent(o.parent_id.clone().unwrap_or_default()) {
            Ok(p) => p,
            Err(why) => return rejected(&id, why),
        };
        let mut at = parent.clone().unwrap_or_default();
        while !at.is_empty() {
            if at == id {
                return rejected(&id, t("server.artifact.op.underSelf", &[]));
            }
            at = self.find(&at).map(|up| parent_of(up).to_string()).unwrap_or_default();
        }
        let b = self.get(&id);
        b.parent_id = parent;
        b.order_key = o.order_key.clone();
        self.touch(&id);
        applied(self.get(&id))
    }

    fn split(&mut self, o: &BlockOpSplitBlock) -> BlockOpResult {
        let Some(b) = self.find(&o.block_id) else { return missing(&o.block_id) };
        if !has_text(b.r#type) {
            return rejected(&b.id, t("server.artifact.op.noText", &[]));
        }
        if o.base_rev > b.rev || o.base_rev < 1 {
            return rejected(&b.id, t("server.artifact.op.noRev", &[("rev", o.base_rev.into())]));
        }
        if is_deleted(b) {
            return gone(b);
        }
        let id = b.id.clone();
        let mut nb = match self.fresh(&o.new_block) {
            Ok(nb) => nb,
            Err(why) => return rejected(&id, why),
        };
        let b = self.find(&id).expect("found above");
        let mut status = BlockOpStatus::Applied;
        let mut reason = None;
        let mut at = o.offset;
        let len = rune_len(&b.text);
        if !self.unchanged_since(b, o.base_rev) {
            at = len;
            status = BlockOpStatus::Conflict;
            reason = Some(t("server.artifact.op.splitAtEnd", &[]));
        } else if at < 0 || at > len {
            return rejected(&id, t("server.artifact.op.splitOutside", &[("at", at.into()), ("length", len.into())]));
        }
        let (left, right) = split_at(&b.text, at);
        self.get(&id).text = left;
        nb.text = text_for(nb.r#type, &right);
        let nid = nb.id.clone();
        self.put(nb);
        self.touch(&id);
        self.touch(&nid);
        result(status, &id, self.get(&id).rev, None, reason)
    }

    fn merge(&mut self, o: &BlockOpMergeBlocks) -> BlockOpResult {
        let Some(target) = self.find(&o.target_id) else {
            return missing(&o.target_id);
        };
        let Some(source) = self.find(&o.source_id) else {
            return missing(&o.source_id);
        };
        if target.id == source.id {
            return rejected(&target.id, t("server.artifact.op.intoSelf", &[]));
        }
        if is_deleted(source) {
            return result(BlockOpStatus::Noop, &target.id, target.rev, None, None);
        }
        if is_deleted(target) {
            return gone(target);
        }
        if !has_text(target.r#type) {
            return rejected(&target.id, t("server.artifact.op.noText", &[]));
        }
        let (tid, sid) = (target.id.clone(), source.id.clone());
        let text = text_for(target.r#type, &joined(&target.text, &source.text));
        self.get(&tid).text = text;
        let mut last = self.children(&tid).last().map(|b| b.order_key.clone()).unwrap_or_default();
        let kids: Vec<String> = self.children(&sid).iter().map(|b| b.id.clone()).collect();
        for c in kids {
            let key = match key_between(&last, "") {
                Ok(k) => k,
                Err(why) => return rejected(&c, why),
            };
            let b = self.get(&c);
            b.parent_id = Some(tid.clone());
            b.order_key = key.clone();
            last = key;
            self.touch(&c);
        }
        self.touch(&tid);
        self.get(&sid).deleted = Some(true);
        self.touch(&sid);
        applied(self.get(&tid))
    }
}

/// The live blocks in artifact order: each block, then its children.
pub fn ordered(blocks: &[Block]) -> Vec<Block> {
    let p = Page::new(blocks.first().map_or("", |b| b.artifact_id.as_str()), "", 0, blocks);
    let mut out: Vec<Block> = vec![];
    fn walk(p: &Page, parent: &str, out: &mut Vec<Block>) {
        for b in p.children(parent) {
            if is_deleted(b) {
                continue;
            }
            out.push(b.clone());
            walk(p, &b.id, out);
        }
    }
    walk(&p, "", &mut out);
    for b in blocks {
        if !is_deleted(b)
            && let Some(parent) = &b.parent_id
            && p.find(parent).is_none()
        {
            out.push(b.clone());
        }
    }
    out.into_iter().map(wire).collect()
}

pub const BLOCK_TYPES_WITH_TEXT: [BlockType; 8] = [
    BlockType::Paragraph,
    BlockType::Heading,
    BlockType::Bulleted,
    BlockType::Numbered,
    BlockType::Todo,
    BlockType::Quote,
    BlockType::Code,
    BlockType::MemoryItem,
];
