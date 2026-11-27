//! Phase B & C: `CollabDoc` wrapping `loro::LoroDoc` for content-plane notes.
//!
//! Container layout inside a `LoroDoc`:
//! - `"texts"` (`LoroMap` of mergeable `LoroText`s): character-level Fugue CRDT
//!   for block text, outline body text, store text files, and HTML source (`"html"`).
//! - `"tree"` (`LoroTree` with `enable_fractional_index(0)`): cycle-free movable
//!   hierarchy for outline/block trees and whiteboard nested groups.
//! - `"entries"` (`LoroMap` of mergeable `LoroMap`s): property-level concurrent
//!   merge for structured store JSON entries and whiteboard elements.
//! - `"lists"` (`LoroMap` of mergeable `LoroList`s): ordered collaborative lists.
//! - `"entry_meta"` (`LoroMap`): entry kind/mime metadata keyed by store path.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::ControlFlow;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use loro::cursor::{Cursor, Side};
use loro::{CommitOptions, Counter, ExportMode, Frontiers, ID, LoroDoc, LoroMap, LoroText, LoroTree, LoroValue, TreeID, TreeParentId, VersionVector};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::collab::CollabError;

/// Canonical key inside `"texts"` for an HTML artifact's source text.
pub const HTML_TEXT_KEY: &str = "html";

const TEXTS_ROOT: &str = "texts";
const TREE_ROOT: &str = "tree";
const ENTRIES_ROOT: &str = "entries";
const ENTRY_META_ROOT: &str = "entry_meta";
const LISTS_ROOT: &str = "lists";

/// Persisted commit metadata stored as JSON in Loro's `commit_msg`, because
/// Loro's runtime `origin` is not persisted inside snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub at: i64,
}

impl CommitMeta {
    pub fn user(author: impl Into<String>, summary: Option<String>, at: i64) -> Self {
        Self {
            author: author.into(),
            agent: None,
            session_id: None,
            turn: None,
            origin: "user".to_string(),
            summary,
            at,
        }
    }

    pub fn session(author: impl Into<String>, agent: impl Into<String>, session_id: impl Into<String>, turn: u32, summary: Option<String>, at: i64) -> Self {
        let sid = session_id.into();
        let origin = format!("session:{sid}:turn:{turn}");
        Self {
            author: author.into(),
            agent: Some(agent.into()),
            session_id: Some(sid),
            turn: Some(turn),
            origin,
            summary,
            at,
        }
    }

    pub fn undo(author: impl Into<String>, target_origin: &str, summary: Option<String>, at: i64) -> Self {
        Self {
            author: author.into(),
            agent: None,
            session_id: None,
            turn: None,
            origin: format!("undo:{target_origin}"),
            summary,
            at,
        }
    }
}

/// One history commit entry decoded from the Loro oplog, including its causal
/// `(before_frontiers, after_frontiers)` interval for time travel & selective undo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub id: ID,
    pub lamport: u32,
    pub timestamp: i64,
    pub before_frontiers: Frontiers,
    pub after_frontiers: Frontiers,
    pub meta: Option<CommitMeta>,
}

/// Persistent Loro `Cursor` range anchored on a `"texts"` container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRangeAnchor {
    pub text_key: String,
    pub start_cursor: String,
    pub end_cursor: String,
}

/// Current Unicode character offsets resolved from a `TextRangeAnchor`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRange {
    pub start: usize,
    pub end: usize,
    pub start_cursor: String,
    pub end_cursor: String,
}

/// Suggestion span over a text container, used by the CRDT proxy to coalesce
/// adjacent or overlapping edits from the same `origin` into one suggestion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionSpan {
    pub id: String,
    pub origin: String,
    pub text_key: String,
    pub start: usize,
    pub end: usize,
    pub replacement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_end: Option<String>,
}

/// Folds adjacent or overlapping suggestions from the same `(origin, text_key)`
/// into a single suggestion while leaving disjoint ranges and other origins intact.
pub fn coalesce_suggestions(items: Vec<SuggestionSpan>) -> Vec<SuggestionSpan> {
    if items.len() <= 1 {
        return items;
    }
    let mut grouped: BTreeMap<(String, String), Vec<(usize, SuggestionSpan)>> = BTreeMap::new();
    for (idx, item) in items.into_iter().enumerate() {
        grouped.entry((item.origin.clone(), item.text_key.clone())).or_default().push((idx, item));
    }
    let mut merged_with_order: Vec<(usize, SuggestionSpan)> = Vec::new();
    for (_, mut group) in grouped {
        group.sort_by(|a, b| a.1.start.cmp(&b.1.start).then_with(|| a.1.end.cmp(&b.1.end)).then_with(|| a.0.cmp(&b.0)));
        let mut iter = group.into_iter();
        let Some((mut cur_order, mut cur)) = iter.next() else { continue };
        for (next_order, next) in iter {
            if next.start <= cur.end {
                cur_order = cur_order.min(next_order);
                if next.end >= cur.end {
                    cur.end = next.end;
                    if next.cursor_end.is_some() {
                        cur.cursor_end = next.cursor_end;
                    }
                }
                if !next.replacement.is_empty() {
                    cur.replacement.push_str(&next.replacement);
                }
            } else {
                merged_with_order.push((cur_order, cur));
                cur_order = next_order;
                cur = next;
            }
        }
        merged_with_order.push((cur_order, cur));
    }
    merged_with_order.sort_by_key(|(order, _)| *order);
    merged_with_order.into_iter().map(|(_, s)| s).collect()
}

/// Deterministic projection of one live node in `"tree"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub tree_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub order_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default)]
    pub attrs: BTreeMap<String, Value>,
}

/// Deterministic projection of a block/outline node (tree hierarchy + text).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockNodeSnapshot {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub order_key: String,
    pub block_type: String,
    pub text: String,
    #[serde(default)]
    pub attrs: BTreeMap<String, Value>,
}

/// Deterministic projection of one structured store entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreEntrySnapshot {
    pub path: String,
    pub kind: String,
    pub mime: String,
    pub content: String,
}

/// Complete deterministic projection of a `CollabDoc` at any frontier (latest
/// or historical checkout), suitable for preview, restore, fork, and DB projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSnapshot {
    pub html: Option<String>,
    pub texts: BTreeMap<String, String>,
    pub tree: Vec<TreeNode>,
    pub blocks: Vec<BlockNodeSnapshot>,
    pub entries: BTreeMap<String, Value>,
    pub store_entries: Vec<StoreEntrySnapshot>,
    pub lists: BTreeMap<String, Vec<Value>>,
}

/// Result of exporting an incremental version-vector sync payload (or snapshot fallback).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncExport {
    pub bytes: Vec<u8>,
    pub is_snapshot: bool,
    pub version_vector: VersionVector,
    pub frontiers: Frontiers,
}

/// Encodes Loro `Frontiers` into a base64 string for wire transport / SQLite.
pub fn encode_frontiers(frontiers: &Frontiers) -> String {
    BASE64.encode(frontiers.encode())
}

/// Decodes base64-encoded Loro `Frontiers`.
pub fn decode_frontiers(encoded: &str) -> Result<Frontiers, CollabError> {
    let bytes = BASE64.decode(encoded.trim()).map_err(|e| CollabError::Encoding(e.to_string()))?;
    Frontiers::decode(&bytes).map_err(CollabError::from)
}

/// Encodes a Loro `VersionVector` into a base64 string for delta sync requests.
pub fn encode_version_vector(vv: &VersionVector) -> String {
    BASE64.encode(vv.encode())
}

/// Decodes a base64-encoded Loro `VersionVector`.
pub fn decode_version_vector(encoded: &str) -> Result<VersionVector, CollabError> {
    let bytes = BASE64.decode(encoded.trim()).map_err(|e| CollabError::Encoding(e.to_string()))?;
    VersionVector::decode(&bytes).map_err(CollabError::from)
}

/// Collaborative content document wrapping `loro::LoroDoc`.
pub struct CollabDoc {
    doc: LoroDoc,
}

impl Default for CollabDoc {
    fn default() -> Self {
        Self::new()
    }
}

impl CollabDoc {
    pub fn new() -> Self {
        let doc = LoroDoc::new();
        configure_doc(&doc);
        Self { doc }
    }

    pub fn with_peer_id(peer_id: u64) -> Result<Self, CollabError> {
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id)?;
        configure_doc(&doc);
        Ok(Self { doc })
    }

    pub fn from_snapshot(bytes: &[u8]) -> Result<Self, CollabError> {
        let doc = LoroDoc::new();
        configure_doc(&doc);
        if !bytes.is_empty() {
            doc.import(bytes)?;
        }
        doc.get_tree(TREE_ROOT).enable_fractional_index(0);
        Ok(Self { doc })
    }

    pub fn from_snapshot_with_peer(bytes: &[u8], peer_id: u64) -> Result<Self, CollabError> {
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id)?;
        configure_doc(&doc);
        if !bytes.is_empty() {
            doc.import(bytes)?;
        }
        doc.get_tree(TREE_ROOT).enable_fractional_index(0);
        Ok(Self { doc })
    }

    pub fn inner(&self) -> &LoroDoc {
        &self.doc
    }

    pub fn peer_id(&self) -> u64 {
        self.doc.peer_id()
    }

    pub fn frontiers(&self) -> Frontiers {
        self.doc.oplog_frontiers()
    }

    pub fn version_vector(&self) -> VersionVector {
        self.doc.oplog_vv()
    }

    pub fn is_shallow(&self) -> bool {
        self.doc.is_shallow()
    }

    /// Commits pending operations with persisted JSON `CommitMeta` in `commit_msg`.
    pub fn commit(&self, meta: &CommitMeta) -> Result<Frontiers, CollabError> {
        let msg = serde_json::to_string(meta)?;
        let mut opts = CommitOptions::new().origin(&meta.origin).commit_msg(&msg);
        if meta.at > 0 {
            let secs = if meta.at > 10_000_000_000 { meta.at / 1_000 } else { meta.at };
            opts = opts.timestamp(secs);
        }
        self.doc.commit_with(opts);
        Ok(self.doc.oplog_frontiers())
    }

    /// Exports a full binary snapshot (state + history).
    pub fn export_snapshot(&self) -> Result<Vec<u8>, CollabError> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    /// Exports incremental binary updates since `from` version vector.
    pub fn export_updates_since(&self, from: &VersionVector) -> Result<Vec<u8>, CollabError> {
        Ok(self.doc.export(ExportMode::updates(from))?)
    }

    /// Exports an incremental update since `from` (or full snapshot when `from` is
    /// absent or predates a compacted shallow snapshot root).
    pub fn export_sync_since(&self, from: Option<&VersionVector>) -> Result<SyncExport, CollabError> {
        match from {
            Some(vv) => {
                if self.is_shallow() {
                    let shallow_vv = self.doc.shallow_since_vv();
                    let behind_shallow = shallow_vv.iter().any(|(peer, &counter)| vv.get(peer).copied().unwrap_or(0) < counter);
                    if behind_shallow {
                        return Ok(SyncExport {
                            bytes: self.export_snapshot()?,
                            is_snapshot: true,
                            version_vector: self.version_vector(),
                            frontiers: self.frontiers(),
                        });
                    }
                }
                match self.doc.export(ExportMode::updates(vv)) {
                    Ok(bytes) => Ok(SyncExport {
                        bytes,
                        is_snapshot: false,
                        version_vector: self.version_vector(),
                        frontiers: self.frontiers(),
                    }),
                    Err(_) if self.is_shallow() => Ok(SyncExport {
                        bytes: self.export_snapshot()?,
                        is_snapshot: true,
                        version_vector: self.version_vector(),
                        frontiers: self.frontiers(),
                    }),
                    Err(e) => Err(CollabError::from(e)),
                }
            }
            None => Ok(SyncExport {
                bytes: self.export_snapshot()?,
                is_snapshot: true,
                version_vector: self.version_vector(),
                frontiers: self.frontiers(),
            }),
        }
    }

    /// Imports binary snapshot or incremental update bytes from a peer.
    pub fn import_bytes(&self, bytes: &[u8]) -> Result<(), CollabError> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.doc.import(bytes)?;
        self.doc.get_tree(TREE_ROOT).enable_fractional_index(0);
        Ok(())
    }

    /// Imports binary snapshot or incremental update bytes and reports whether
    /// the document's `VersionVector` advanced with newly integrated operations.
    pub fn import_bytes_with_status(&self, bytes: &[u8]) -> Result<bool, CollabError> {
        if bytes.is_empty() {
            return Ok(false);
        }
        let before = self.version_vector();
        self.import_bytes(bytes)?;
        Ok(self.version_vector() != before)
    }

    /// Returns the decoded `CommitMeta` of the newest reachable commit if present.
    pub fn latest_commit_meta(&self) -> Option<CommitMeta> {
        let tips = self.doc.oplog_frontiers();
        let ids: Vec<ID> = tips.iter().collect();
        if ids.is_empty() {
            return None;
        }
        let mut found = None;
        let _ = self.doc.travel_change_ancestors(&ids, &mut |change| {
            if change.len > 0
                && let Some(meta) = change.message.as_deref().and_then(|raw| serde_json::from_str::<CommitMeta>(raw).ok())
            {
                found = Some(meta);
                return ControlFlow::Break(());
            }
            ControlFlow::Continue(())
        });
        found
    }

    // ---- LoroText operations (blocks, outline, HTML, store text) -------------

    fn texts_root(&self) -> LoroMap {
        self.doc.get_map(TEXTS_ROOT)
    }

    fn text_container(&self, key: &str) -> Result<LoroText, CollabError> {
        Ok(self.texts_root().ensure_mergeable_text(key)?)
    }

    pub fn text_get(&self, key: &str) -> Option<String> {
        let root = self.texts_root();
        let val = root.get_deep_value();
        let LoroValue::Map(map) = val else { return None };
        match map.get(key) {
            Some(LoroValue::String(s)) => Some(s.to_string()),
            _ => None,
        }
    }

    pub fn text_insert(&self, key: &str, pos: usize, text: &str) -> Result<(), CollabError> {
        let container = self.text_container(key)?;
        let clamped = pos.min(container.len_unicode());
        container.insert(clamped, text)?;
        Ok(())
    }

    pub fn text_delete(&self, key: &str, pos: usize, len: usize) -> Result<(), CollabError> {
        let container = self.text_container(key)?;
        let total = container.len_unicode();
        if pos >= total || len == 0 {
            return Ok(());
        }
        container.delete(pos, len.min(total - pos))?;
        Ok(())
    }

    pub fn text_splice(&self, key: &str, pos: usize, delete_len: usize, insert: &str) -> Result<(), CollabError> {
        let container = self.text_container(key)?;
        let total = container.len_unicode();
        let start = pos.min(total);
        let del = delete_len.min(total - start);
        container.splice(start, del, insert)?;
        Ok(())
    }

    /// Replaces text content via minimal character diff (`LoroText::update`),
    /// preserving concurrent edits elsewhere in the same text container.
    pub fn text_update_diff(&self, key: &str, new_text: &str) -> Result<(), CollabError> {
        let container = self.text_container(key)?;
        container
            .update(new_text, loro::UpdateOptions::default())
            .map_err(|e| CollabError::Loro(e.to_string()))?;
        Ok(())
    }

    pub fn html_get(&self) -> Option<String> {
        self.text_get(HTML_TEXT_KEY)
    }

    pub fn html_update(&self, html: &str) -> Result<(), CollabError> {
        self.text_update_diff(HTML_TEXT_KEY, html)
    }

    // ---- Persistent `Cursor` suggestion anchors ------------------------------

    /// Anchors a Unicode character range `[start..end]` on `text_key` using
    /// persistent Loro `Cursor`s that survive upstream insertions and deletions.
    pub fn anchor_text_range(&self, text_key: &str, start: usize, end: usize) -> Result<TextRangeAnchor, CollabError> {
        let container = self.text_container(text_key)?;
        let len = container.len_unicode();
        let clamped_start = start.min(len);
        let clamped_end = end.clamp(clamped_start, len);
        let start_side = if clamped_start < len { Side::Middle } else { Side::Right };
        let start_cursor = container
            .get_cursor(clamped_start, start_side)
            .ok_or_else(|| CollabError::Cursor(format!("cannot anchor start {clamped_start} on `{text_key}`")))?;
        // For non-empty ranges ending before EOF, attach Left to the character at `end`
        // so downstream inserts at `end` stay outside; for ranges ending at EOF, attach
        // Right to the last character inside the range (`end - 1`) so trailing appends do
        // not stretch the anchored range.
        let end_cursor = if clamped_end > clamped_start && clamped_end == len {
            container
                .get_cursor(clamped_end - 1, Side::Right)
                .ok_or_else(|| CollabError::Cursor(format!("cannot anchor end {clamped_end} on `{text_key}`")))?
        } else {
            let end_side = if clamped_end < len { Side::Left } else { Side::Right };
            container
                .get_cursor(clamped_end, end_side)
                .ok_or_else(|| CollabError::Cursor(format!("cannot anchor end {clamped_end} on `{text_key}`")))?
        };
        Ok(TextRangeAnchor {
            text_key: text_key.to_string(),
            start_cursor: BASE64.encode(start_cursor.encode()),
            end_cursor: BASE64.encode(end_cursor.encode()),
        })
    }

    /// Resolves a `TextRangeAnchor` to current Unicode character offsets `[start..end]`.
    pub fn resolve_text_range(&self, anchor: &TextRangeAnchor) -> Result<ResolvedRange, CollabError> {
        let start_cur = decode_cursor(&anchor.start_cursor)?;
        let end_cur = decode_cursor(&anchor.end_cursor)?;
        let start_res = self
            .doc
            .get_cursor_pos(&start_cur)
            .map_err(|e| CollabError::Cursor(format!("resolve start cursor: {e:?}")))?;
        let end_res = self
            .doc
            .get_cursor_pos(&end_cur)
            .map_err(|e| CollabError::Cursor(format!("resolve end cursor: {e:?}")))?;
        let len = self.text_get(&anchor.text_key).map_or(0, |s| s.chars().count());
        let start = start_res.current.pos.min(len);
        // When `end_cur` was pinned with `Side::Right` onto the last character of the
        // anchored slice (and that character is still alive), exclusive end is `pos + 1`.
        let raw_end = if end_cur.id.is_some() && end_cur.side == Side::Right && end_res.update.is_none() {
            end_res.current.pos.saturating_add(1)
        } else {
            end_res.current.pos
        };
        let end = raw_end.clamp(start, len);
        let updated_start = start_res.update.as_ref().map_or_else(|| anchor.start_cursor.clone(), encode_cursor);
        let updated_end = end_res.update.as_ref().map_or_else(|| anchor.end_cursor.clone(), encode_cursor);
        Ok(ResolvedRange {
            start,
            end,
            start_cursor: updated_start,
            end_cursor: updated_end,
        })
    }

    /// Applies an accepted suggestion replacement directly at the resolved cursor
    /// range inside `text_key`.
    pub fn apply_anchored_replacement(&self, anchor: &TextRangeAnchor, replacement: &str) -> Result<ResolvedRange, CollabError> {
        let resolved = self.resolve_text_range(anchor)?;
        self.text_splice(&anchor.text_key, resolved.start, resolved.end - resolved.start, replacement)?;
        Ok(resolved)
    }

    // ---- LoroTree operations (whiteboard groups + outline/block hierarchy) ---

    fn tree(&self) -> LoroTree {
        let tree = self.doc.get_tree(TREE_ROOT);
        tree.enable_fractional_index(0);
        tree
    }

    fn find_tree_id(&self, logical_id: &str) -> Option<TreeID> {
        let tree = self.tree();
        for tid in tree.nodes() {
            if tree.is_node_deleted(&tid).unwrap_or(true) {
                continue;
            }
            if let Ok(meta) = tree.get_meta(tid)
                && let LoroValue::Map(map) = meta.get_deep_value()
                && let Some(LoroValue::String(id)) = map.get("id")
                && id.as_str() == logical_id
            {
                return Some(tid);
            }
        }
        None
    }

    /// Creates a new tree node under `parent_logical_id` (or root when `None`)
    /// at optional child `index`, returning its Loro `TreeID`.
    pub fn tree_create(&self, logical_id: &str, parent_logical_id: Option<&str>, index: Option<usize>, kind: Option<&str>) -> Result<TreeID, CollabError> {
        let tree = self.tree();
        let parent = match parent_logical_id {
            Some(pid) => TreeParentId::Node(self.find_tree_id(pid).ok_or_else(|| CollabError::NotFound(pid.to_string()))?),
            None => TreeParentId::Root,
        };
        let tid = match index {
            Some(i) => {
                let count = tree.children(parent).map_or(0, |c| c.len());
                tree.create_at(parent, i.min(count))?
            }
            None => tree.create(parent)?,
        };
        let meta = tree.get_meta(tid)?;
        meta.insert("id", logical_id)?;
        if let Some(k) = kind {
            meta.insert("kind", k)?;
        }
        Ok(tid)
    }

    /// Moves an existing tree node under `new_parent_logical_id` (or root when `None`).
    /// Loro's Kleppmann Movable Tree guarantees concurrent moves stay cycle-free.
    pub fn tree_move(&self, logical_id: &str, new_parent_logical_id: Option<&str>, index: Option<usize>) -> Result<(), CollabError> {
        let tree = self.tree();
        let target = self.find_tree_id(logical_id).ok_or_else(|| CollabError::NotFound(logical_id.to_string()))?;
        let parent = match new_parent_logical_id {
            Some(pid) => TreeParentId::Node(self.find_tree_id(pid).ok_or_else(|| CollabError::NotFound(pid.to_string()))?),
            None => TreeParentId::Root,
        };
        match index {
            Some(i) => {
                let count = tree.children(parent).map_or(0, |c| c.len());
                tree.mov_to(target, parent, i.min(count))?;
            }
            None => {
                tree.mov(target, parent)?;
            }
        }
        Ok(())
    }

    pub fn tree_move_after(&self, logical_id: &str, after_logical_id: &str) -> Result<(), CollabError> {
        let tree = self.tree();
        let target = self.find_tree_id(logical_id).ok_or_else(|| CollabError::NotFound(logical_id.to_string()))?;
        let after = self
            .find_tree_id(after_logical_id)
            .ok_or_else(|| CollabError::NotFound(after_logical_id.to_string()))?;
        tree.mov_after(target, after)?;
        Ok(())
    }

    pub fn tree_move_before(&self, logical_id: &str, before_logical_id: &str) -> Result<(), CollabError> {
        let tree = self.tree();
        let target = self.find_tree_id(logical_id).ok_or_else(|| CollabError::NotFound(logical_id.to_string()))?;
        let before = self
            .find_tree_id(before_logical_id)
            .ok_or_else(|| CollabError::NotFound(before_logical_id.to_string()))?;
        tree.mov_before(target, before)?;
        Ok(())
    }

    pub fn tree_delete(&self, logical_id: &str) -> Result<(), CollabError> {
        let tree = self.tree();
        let target = self.find_tree_id(logical_id).ok_or_else(|| CollabError::NotFound(logical_id.to_string()))?;
        tree.delete(target)?;
        Ok(())
    }

    /// Patches attribute fields on a tree node using property-level mergeable map.
    pub fn tree_patch_attrs(&self, logical_id: &str, patch: &Value) -> Result<(), CollabError> {
        let tree = self.tree();
        let target = self.find_tree_id(logical_id).ok_or_else(|| CollabError::NotFound(logical_id.to_string()))?;
        let meta = tree.get_meta(target)?;
        let attrs = meta.ensure_mergeable_map("attrs")?;
        apply_json_object_patch(&attrs, patch)
    }

    /// Upserts a block/outline node (hierarchy in `"tree"` + text in `"texts"`).
    pub fn upsert_block(
        &self,
        block_id: &str,
        parent_id: Option<&str>,
        index: Option<usize>,
        block_type: &str,
        text: &str,
        attrs: Option<&Value>,
    ) -> Result<TreeID, CollabError> {
        let tid = if let Some(existing) = self.find_tree_id(block_id) {
            if parent_id.is_some() || index.is_some() {
                self.tree_move(block_id, parent_id, index)?;
            }
            existing
        } else {
            self.tree_create(block_id, parent_id, index, Some("block"))?
        };
        let meta = self.tree().get_meta(tid)?;
        meta.insert("blockType", block_type)?;
        if let Some(a) = attrs {
            let map = meta.ensure_mergeable_map("attrs")?;
            apply_json_object_patch(&map, a)?;
        }
        self.text_update_diff(block_id, text)?;
        Ok(tid)
    }

    // ---- LoroMap / LoroList operations (store entries & whiteboard props) ----

    fn entries_root(&self) -> LoroMap {
        self.doc.get_map(ENTRIES_ROOT)
    }

    fn entry_meta_root(&self) -> LoroMap {
        self.doc.get_map(ENTRY_META_ROOT)
    }

    fn lists_root(&self) -> LoroMap {
        self.doc.get_map(LISTS_ROOT)
    }

    /// Applies an RFC 7396-style property-level patch to a structured JSON entry
    /// (e.g. `elements/card-1` or `board/meta`). Concurrent patches to different
    /// properties converge without conflict.
    pub fn entry_patch_json(&self, path: &str, patch: &Value) -> Result<(), CollabError> {
        let entry_map = self.entries_root().ensure_mergeable_map(path)?;
        apply_json_object_patch(&entry_map, patch)?;
        let meta = self.entry_meta_root().ensure_mergeable_map(path)?;
        meta.insert("kind", "json")?;
        meta.insert("mime", "application/json")?;
        Ok(())
    }

    /// Writes a text store entry into `"texts"` with character-level diff update.
    pub fn entry_put_text(&self, path: &str, mime: &str, content: &str) -> Result<(), CollabError> {
        self.text_update_diff(path, content)?;
        let meta = self.entry_meta_root().ensure_mergeable_map(path)?;
        meta.insert("kind", "text")?;
        meta.insert("mime", mime)?;
        Ok(())
    }

    pub fn entry_delete(&self, path: &str) -> Result<(), CollabError> {
        self.entries_root().delete(path)?;
        self.texts_root().delete(path)?;
        self.entry_meta_root().delete(path)?;
        Ok(())
    }

    pub fn entry_get_json(&self, path: &str) -> Option<Value> {
        let LoroValue::Map(entries) = self.entries_root().get_deep_value() else {
            return None;
        };
        entries.get(path).map(loro_to_json)
    }

    pub fn list_push(&self, key: &str, value: &Value) -> Result<(), CollabError> {
        let list = self.lists_root().ensure_mergeable_list(key)?;
        list.push(json_to_loro_value(value))?;
        Ok(())
    }

    pub fn list_insert(&self, key: &str, pos: usize, value: &Value) -> Result<(), CollabError> {
        let list = self.lists_root().ensure_mergeable_list(key)?;
        let clamped = pos.min(list.len());
        list.insert(clamped, json_to_loro_value(value))?;
        Ok(())
    }

    pub fn list_delete(&self, key: &str, pos: usize, len: usize) -> Result<(), CollabError> {
        let list = self.lists_root().ensure_mergeable_list(key)?;
        let total = list.len();
        if pos >= total || len == 0 {
            return Ok(());
        }
        list.delete(pos, len.min(total - pos))?;
        Ok(())
    }

    pub fn list_get(&self, key: &str) -> Vec<Value> {
        let LoroValue::Map(lists) = self.lists_root().get_deep_value() else {
            return Vec::new();
        };
        match lists.get(key) {
            Some(LoroValue::List(items)) => items.iter().map(loro_to_json).collect(),
            _ => Vec::new(),
        }
    }

    // ---- Deterministic projection (Server DB <-> CollabDoc) ------------------

    /// Deterministic snapshot of the current document state (all texts, tree,
    /// blocks, JSON entries, store entries, and lists).
    pub fn project_snapshot(&self) -> DocSnapshot {
        project_doc(&self.doc)
    }

    // ---- Phase C: Time Travel, Shallow Compaction & Selective Origin Undo ----

    /// Lists all commits reachable from the document's latest frontiers in
    /// deterministic causal/lamport order with decoded `CommitMeta` and exact
    /// `(before_frontiers, after_frontiers)` intervals.
    pub fn history(&self) -> Result<Vec<HistoryEntry>, CollabError> {
        let tips = self.doc.oplog_frontiers();
        if tips.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<ID> = tips.iter().collect();
        let mut entries = Vec::new();
        self.doc
            .travel_change_ancestors(&ids, &mut |change| {
                if change.len > 0 {
                    let end_counter = change.id.counter + (change.len as Counter) - 1;
                    let after_id = ID::new(change.id.peer, end_counter);
                    let meta = change.message.as_deref().and_then(|raw| serde_json::from_str::<CommitMeta>(raw).ok());
                    entries.push(HistoryEntry {
                        id: change.id,
                        lamport: change.lamport,
                        timestamp: change.timestamp,
                        before_frontiers: change.deps.clone(),
                        after_frontiers: Frontiers::from_id(after_id),
                        meta,
                    });
                }
                ControlFlow::Continue(())
            })
            .map_err(|e| CollabError::Loro(format!("travel history: {e:?}")))?;
        entries.sort_by(|a, b| {
            a.lamport
                .cmp(&b.lamport)
                .then_with(|| a.id.peer.cmp(&b.id.peer))
                .then_with(|| a.id.counter.cmp(&b.id.counter))
        });
        Ok(entries)
    }

    /// Read-only projection at an arbitrary historical `Frontiers` (for preview,
    /// restore, or fork) without mutating the live document's checkout state.
    pub fn checkout_snapshot(&self, frontiers: &Frontiers) -> Result<DocSnapshot, CollabError> {
        let forked = self.doc.fork_at(frontiers)?;
        forked.get_tree(TREE_ROOT).enable_fractional_index(0);
        Ok(project_doc(&forked))
    }

    /// Forks a new independent `CollabDoc` rooted at `frontiers`.
    pub fn fork_at(&self, frontiers: &Frontiers) -> Result<CollabDoc, CollabError> {
        let forked = self.doc.fork_at(frontiers)?;
        configure_doc(&forked);
        forked.get_tree(TREE_ROOT).enable_fractional_index(0);
        Ok(CollabDoc { doc: forked })
    }

    /// Restores the document to match the state at `target` frontiers by recording
    /// a new forward commit (preserving full audit history).
    pub fn restore_to(&self, target: &Frontiers, meta: &CommitMeta) -> Result<Frontiers, CollabError> {
        self.doc.try_checkout_to_latest()?;
        self.doc.revert_to(target)?;
        self.commit(meta)
    }

    /// Compacts history using `ExportMode::shallow_snapshot` at the current latest
    /// frontiers, returning the compacted binary snapshot whose projected state is
    /// byte-for-byte identical to the original document.
    pub fn compact_shallow_snapshot(&self) -> Result<Vec<u8>, CollabError> {
        let tips = self.doc.oplog_frontiers();
        if tips.is_empty() {
            return self.export_snapshot();
        }
        Ok(self.doc.export(ExportMode::shallow_snapshot(&tips))?)
    }

    /// Compacts history keeping full operations since `since_frontiers`.
    pub fn compact_shallow_snapshot_since(&self, since_frontiers: &Frontiers) -> Result<Vec<u8>, CollabError> {
        if since_frontiers.is_empty() {
            return self.export_snapshot();
        }
        Ok(self.doc.export(ExportMode::shallow_snapshot(since_frontiers))?)
    }

    /// Selectively undoes all commits whose persisted `CommitMeta.origin` equals
    /// `target_origin`, preserving all edits made by humans and other concurrent
    /// sessions before and after those commits.
    ///
    /// Returns the number of target commits reverted (`0` if none matched or all
    /// were already undone).
    pub fn selective_undo_origin(&self, target_origin: &str, undo_meta: &CommitMeta) -> Result<usize, CollabError> {
        let entries = self.history()?;
        let undo_marker = format!("undo:{target_origin}");
        let last_undo_lamport = entries
            .iter()
            .filter(|e| e.meta.as_ref().is_some_and(|m| m.origin == undo_marker))
            .map(|e| e.lamport)
            .max();

        let targets: Vec<HistoryEntry> = entries
            .into_iter()
            .filter(|e| e.meta.as_ref().is_some_and(|m| m.origin == target_origin) && last_undo_lamport.is_none_or(|ul| e.lamport > ul))
            .collect();
        if targets.is_empty() {
            return Ok(0);
        }

        // Compute each inverse diff on a scratch fork rooted at that commit's causal
        // `after` frontier (merged with any earlier undos from this same call) so text
        // offsets and container IDs are exact, then import the generated CRDT inverse
        // operations into `self.doc`. Loro's CRDT merge automatically shifts text/list
        // ops around concurrent edits and preserves later edits on untouched fields.
        let mut applied_undo_ids: Vec<ID> = Vec::new();
        let mut reverted = 0usize;
        let msg = serde_json::to_string(undo_meta)?;

        for entry in &targets {
            let from_f = self.combine_frontiers(&entry.after_frontiers, &applied_undo_ids)?;
            let to_f = self.combine_frontiers(&entry.before_frontiers, &applied_undo_ids)?;

            let scratch = self.doc.fork_at(&from_f)?;
            configure_doc(&scratch);
            let vv_before = scratch.oplog_vv();
            let inverse = scratch.diff(&from_f, &to_f)?;
            scratch.try_checkout_to_latest()?;
            if inverse.iter().next().is_none() {
                continue;
            }
            scratch.apply_diff(inverse)?;
            let mut opts = CommitOptions::new().origin(&undo_meta.origin).commit_msg(&msg);
            if undo_meta.at > 0 {
                let secs = if undo_meta.at > 10_000_000_000 { undo_meta.at / 1_000 } else { undo_meta.at };
                opts = opts.timestamp(secs);
            }
            scratch.commit_with(opts);
            let delta = scratch.export(ExportMode::updates(&vv_before))?;
            if !delta.is_empty() {
                self.doc.import(&delta)?;
                for id in scratch.oplog_frontiers().iter() {
                    if !applied_undo_ids.contains(&id) {
                        applied_undo_ids.push(id);
                    }
                }
                reverted += 1;
            }
        }
        self.doc.try_checkout_to_latest()?;
        self.doc.get_tree(TREE_ROOT).enable_fractional_index(0);
        Ok(reverted)
    }

    fn combine_frontiers(&self, base: &Frontiers, extra: &[ID]) -> Result<Frontiers, CollabError> {
        if extra.is_empty() {
            return Ok(base.clone());
        }
        let mut combined = base.clone();
        for id in extra {
            combined.push(*id);
        }
        self.doc.try_minimize_frontiers(&combined).map_err(CollabError::from)
    }
}

fn configure_doc(doc: &LoroDoc) {
    // Prevent Loro from coalescing distinct server-proxied commits that happen
    // within the default 1000s merge window on the same peer.
    doc.set_change_merge_interval(0);
    doc.get_tree(TREE_ROOT).enable_fractional_index(0);
}

fn encode_cursor(cursor: &Cursor) -> String {
    BASE64.encode(cursor.encode())
}

fn decode_cursor(encoded: &str) -> Result<Cursor, CollabError> {
    let bytes = BASE64.decode(encoded.trim()).map_err(|e| CollabError::Cursor(e.to_string()))?;
    Cursor::decode(&bytes).map_err(|e| CollabError::Cursor(e.to_string()))
}

fn apply_json_object_patch(map: &LoroMap, patch: &Value) -> Result<(), CollabError> {
    let Some(obj) = patch.as_object() else {
        return Err(CollabError::Encoding("expected JSON object patch".into()));
    };
    for (k, v) in obj {
        match v {
            Value::Null => {
                map.delete(k)?;
            }
            Value::Object(_) => {
                let child = map.ensure_mergeable_map(k)?;
                apply_json_object_patch(&child, v)?;
            }
            other => {
                map.insert(k, json_to_loro_value(other))?;
            }
        }
    }
    Ok(())
}

fn json_to_loro_value(value: &Value) -> LoroValue {
    match value {
        Value::Null => LoroValue::Null,
        Value::Bool(b) => LoroValue::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                LoroValue::I64(i)
            } else {
                LoroValue::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => LoroValue::from(s.as_str()),
        Value::Array(items) => LoroValue::List(items.iter().map(json_to_loro_value).collect::<Vec<_>>().into()),
        Value::Object(map) => {
            let mut out = HashMap::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), json_to_loro_value(v));
            }
            LoroValue::Map(out.into())
        }
    }
}

fn loro_to_json(value: &LoroValue) -> Value {
    match value {
        LoroValue::Null => Value::Null,
        LoroValue::Bool(b) => Value::Bool(*b),
        LoroValue::I64(i) => Value::Number((*i).into()),
        LoroValue::Double(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        LoroValue::String(s) => Value::String(s.to_string()),
        LoroValue::Binary(bytes) => Value::String(BASE64.encode(bytes.as_slice())),
        LoroValue::List(items) => Value::Array(items.iter().map(loro_to_json).collect()),
        LoroValue::Map(map) => {
            let mut sorted: BTreeMap<&str, Value> = BTreeMap::new();
            for (k, v) in map.iter() {
                sorted.insert(k.as_str(), loro_to_json(v));
            }
            let mut obj = serde_json::Map::with_capacity(sorted.len());
            for (k, v) in sorted {
                obj.insert(k.to_string(), v);
            }
            Value::Object(obj)
        }
        LoroValue::Container(cid) => Value::String(cid.to_string()),
    }
}

fn project_doc(doc: &LoroDoc) -> DocSnapshot {
    let mut texts = BTreeMap::new();
    if let LoroValue::Map(map) = doc.get_map(TEXTS_ROOT).get_deep_value() {
        for (k, v) in map.iter() {
            if let LoroValue::String(s) = v {
                texts.insert(k.clone(), s.to_string());
            }
        }
    }
    let html = texts.get(HTML_TEXT_KEY).cloned();

    let mut entries = BTreeMap::new();
    if let LoroValue::Map(map) = doc.get_map(ENTRIES_ROOT).get_deep_value() {
        for (k, v) in map.iter() {
            entries.insert(k.clone(), loro_to_json(v));
        }
    }

    let mut lists = BTreeMap::new();
    if let LoroValue::Map(map) = doc.get_map(LISTS_ROOT).get_deep_value() {
        for (k, v) in map.iter() {
            if let LoroValue::List(items) = v {
                lists.insert(k.clone(), items.iter().map(loro_to_json).collect());
            }
        }
    }

    let mut entry_meta: BTreeMap<String, (String, String)> = BTreeMap::new();
    if let LoroValue::Map(map) = doc.get_map(ENTRY_META_ROOT).get_deep_value() {
        for (path, v) in map.iter() {
            if let LoroValue::Map(m) = v {
                let kind = match m.get("kind") {
                    Some(LoroValue::String(s)) => s.to_string(),
                    _ => "text".to_string(),
                };
                let mime = match m.get("mime") {
                    Some(LoroValue::String(s)) => s.to_string(),
                    _ => "text/plain".to_string(),
                };
                entry_meta.insert(path.clone(), (kind, mime));
            }
        }
    }

    let mut store_entries = Vec::new();
    for (path, (kind, mime)) in &entry_meta {
        let content = if kind == "json" {
            entries
                .get(path)
                .and_then(|v| serde_json::to_string(v).ok())
                .unwrap_or_else(|| "{}".to_string())
        } else {
            texts.get(path).cloned().unwrap_or_default()
        };
        store_entries.push(StoreEntrySnapshot {
            path: path.clone(),
            kind: kind.clone(),
            mime: mime.clone(),
            content,
        });
    }

    let tree_container = doc.get_tree(TREE_ROOT);
    tree_container.enable_fractional_index(0);
    let mut tree_nodes = Vec::new();
    let mut blocks = Vec::new();
    let mut tid_to_logical: HashMap<TreeID, String> = HashMap::new();
    let mut meta_cache: HashMap<TreeID, LoroValue> = HashMap::new();

    for tid in tree_container.nodes() {
        if tree_container.is_node_deleted(&tid).unwrap_or(true) {
            continue;
        }
        if let Ok(meta) = tree_container.get_meta(tid) {
            let deep = meta.get_deep_value();
            let logical = match &deep {
                LoroValue::Map(m) => match m.get("id") {
                    Some(LoroValue::String(s)) if !s.is_empty() => s.to_string(),
                    _ => tid.to_string(),
                },
                _ => tid.to_string(),
            };
            tid_to_logical.insert(tid, logical);
            meta_cache.insert(tid, deep);
        }
    }

    let mut visited = HashSet::new();
    collect_tree_preorder(
        &tree_container,
        TreeParentId::Root,
        None,
        &tid_to_logical,
        &meta_cache,
        &texts,
        &mut visited,
        &mut tree_nodes,
        &mut blocks,
    );

    DocSnapshot {
        html,
        texts,
        tree: tree_nodes,
        blocks,
        entries,
        store_entries,
        lists,
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_tree_preorder(
    tree: &LoroTree,
    parent: TreeParentId,
    parent_logical: Option<&str>,
    tid_to_logical: &HashMap<TreeID, String>,
    meta_cache: &HashMap<TreeID, LoroValue>,
    texts: &BTreeMap<String, String>,
    visited: &mut HashSet<TreeID>,
    out_nodes: &mut Vec<TreeNode>,
    out_blocks: &mut Vec<BlockNodeSnapshot>,
) {
    let Some(children) = tree.children(parent) else { return };
    for tid in children {
        if !visited.insert(tid) || tree.is_node_deleted(&tid).unwrap_or(true) {
            continue;
        }
        let logical_id = tid_to_logical.get(&tid).cloned().unwrap_or_else(|| tid.to_string());
        let order_key = tree.fractional_index(tid).unwrap_or_default();
        let (kind, block_type, attrs) = match meta_cache.get(&tid) {
            Some(LoroValue::Map(m)) => {
                let kind = match m.get("kind") {
                    Some(LoroValue::String(s)) => Some(s.to_string()),
                    _ => None,
                };
                let block_type = match m.get("blockType") {
                    Some(LoroValue::String(s)) => Some(s.to_string()),
                    _ => None,
                };
                let mut attrs_map = BTreeMap::new();
                if let Some(LoroValue::Map(am)) = m.get("attrs") {
                    for (k, v) in am.iter() {
                        attrs_map.insert(k.clone(), loro_to_json(v));
                    }
                }
                (kind, block_type, attrs_map)
            }
            _ => (None, None, BTreeMap::new()),
        };

        out_nodes.push(TreeNode {
            tree_id: tid.to_string(),
            id: logical_id.clone(),
            parent_id: parent_logical.map(str::to_string),
            order_key: order_key.clone(),
            kind: kind.clone(),
            attrs: attrs.clone(),
        });

        if let Some(bt) = block_type {
            out_blocks.push(BlockNodeSnapshot {
                id: logical_id.clone(),
                parent_id: parent_logical.map(str::to_string),
                order_key,
                block_type: bt,
                text: texts.get(&logical_id).cloned().unwrap_or_default(),
                attrs,
            });
        }

        collect_tree_preorder(
            tree,
            TreeParentId::Node(tid),
            Some(&logical_id),
            tid_to_logical,
            meta_cache,
            texts,
            visited,
            out_nodes,
            out_blocks,
        );
    }
}
