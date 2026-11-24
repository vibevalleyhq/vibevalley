//! Loro 1.18.0 content-plane integration for artifacts:
//! - Phase A: pure in-memory `PresenceHub` (`artifact.presence.{update,follow}`,
//!   strict-CSP sandbox highlight injection).
//! - Phase B: `CollabDoc` CRDT proxy (lazy bootstrap from SQLite, `CommitMeta`
//!   persistence, persistent `Cursor` suggestion anchoring & same-origin folding).
//! - Phase C: time-travel timeline (`list`/`preview`/`restore`/`fork`), shallow
//!   snapshot compaction (`compact`), and selective per-origin undo (`undoOrigin`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use sea_orm::ConnectionTrait;
use serde_json::{Map, Value};
use tokio::sync::broadcast;
use vibevalley_core::artifact::shell::{presence_highlight_from_payloads, presence_highlight_script};
use vibevalley_core::artifact::{INLINE_EVENT_MAX_BYTES, markdown_of, ordered, plain};
use vibevalley_core::collab::{
    BlockNodeSnapshot, CollabDoc, CommitMeta, HistoryEntry, PresenceHub, PresenceKind, PresencePayload, PresenceViewport, StoreEntrySnapshot, TextRangeAnchor,
    decode_frontiers, encode_frontiers,
};
use vibevalley_core::rules::key_between;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Artifact as Wire, ArtifactBody, ArtifactDisplay, ArtifactEntry, ArtifactEntryKind, ArtifactHistoryCompactRequest, ArtifactHistoryEntry,
    ArtifactHistoryForkRequest, ArtifactHistoryListRequest, ArtifactHistoryPreviewRequest, ArtifactHistoryPreviewResult, ArtifactHistoryRestoreRequest,
    ArtifactHistoryUndoOriginRequest, ArtifactPresence, ArtifactPresenceEvent, ArtifactPresenceKind, ArtifactPresenceUpdateRequest, Block, BlockAck,
    BlockAttrs, BlockType, JsNumber, Suggestion, USER_ID, ViewportRect,
};

use super::blocks::spans_of;
use super::db::{self, ArtifactRow, StoredSuggestion};
use super::entries::EntryChange;
use super::{Artifacts, Maker, artifact_type_of, new_id, q, refused};
use crate::db::begin_write_tx;
use crate::{Hub, Sink, now};

const DEFAULT_PRESENCE_COLORS: [&str; 6] = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
const PRESENCE_EVICT_INTERVAL: Duration = Duration::from_secs(2);
const ASSET_SENTINEL_KEY: &str = "__vvAsset";

pub(super) fn commit_meta_for_actor(actor: &str, summary: Option<String>, at: i64) -> CommitMeta {
    if actor == USER_ID {
        CommitMeta::user(USER_ID, summary, at)
    } else {
        CommitMeta {
            author: actor.to_string(),
            agent: Some(actor.to_string()),
            session_id: None,
            turn: None,
            origin: format!("agent:{actor}"),
            summary,
            at,
        }
    }
}

pub(super) fn commit_meta_for_maker(maker: &Maker, summary: Option<String>, at: i64) -> CommitMeta {
    if maker.by == USER_ID {
        CommitMeta::user(USER_ID, summary, at)
    } else if maker.from != maker.by && !maker.from.is_empty() {
        CommitMeta::session(&maker.by, &maker.by, &maker.from, 1, summary, at)
    } else {
        commit_meta_for_actor(&maker.by, summary, at)
    }
}

fn default_color_for(id: &str) -> String {
    let hash = id.bytes().fold(0usize, |acc, b| acc.wrapping_mul(31).wrapping_add(b as usize));
    DEFAULT_PRESENCE_COLORS[hash % DEFAULT_PRESENCE_COLORS.len()].to_string()
}

fn presence_kind_to_core(kind: ArtifactPresenceKind) -> PresenceKind {
    match kind {
        ArtifactPresenceKind::Cursor => PresenceKind::Cursor,
        ArtifactPresenceKind::BlockCursor => PresenceKind::BlockCursor,
        ArtifactPresenceKind::Selection => PresenceKind::Selection,
        ArtifactPresenceKind::Highlight => PresenceKind::Highlight,
        ArtifactPresenceKind::Viewport => PresenceKind::Viewport,
    }
}

fn presence_kind_from_core(kind: PresenceKind) -> ArtifactPresenceKind {
    match kind {
        PresenceKind::Cursor => ArtifactPresenceKind::Cursor,
        PresenceKind::BlockCursor => ArtifactPresenceKind::BlockCursor,
        PresenceKind::Selection => ArtifactPresenceKind::Selection,
        PresenceKind::Highlight => ArtifactPresenceKind::Highlight,
        PresenceKind::Viewport => ArtifactPresenceKind::Viewport,
    }
}

fn presence_to_payload(p: &ArtifactPresence) -> PresencePayload {
    PresencePayload {
        id: p.id.clone(),
        name: p.name.clone(),
        color: p.color.clone().unwrap_or_else(|| default_color_for(&p.id)),
        kind: presence_kind_to_core(p.kind),
        x: p.x.map(JsNumber::get),
        y: p.y.map(JsNumber::get),
        w: p.w.map(JsNumber::get),
        h: p.h.map(JsNumber::get),
        status: p.status.clone(),
        block_id: p.block_id.clone(),
        offset: p.offset,
        end_offset: p.end_offset,
        selector: p.selector.clone(),
        viewport: p.viewport.map(|v| PresenceViewport {
            x: v.x.get(),
            y: v.y.get(),
            w: v.w.get(),
            h: v.h.get(),
            zoom: v.zoom.map(JsNumber::get),
        }),
        updated_at: p.updated_at,
    }
}

fn payload_to_presence(p: PresencePayload, extra: Option<(Option<String>, Option<String>)>) -> ArtifactPresence {
    let (path, session_id) = extra.unwrap_or((None, None));
    ArtifactPresence {
        id: p.id,
        name: p.name,
        color: Some(p.color),
        kind: presence_kind_from_core(p.kind),
        x: p.x.map(JsNumber),
        y: p.y.map(JsNumber),
        w: p.w.map(JsNumber),
        h: p.h.map(JsNumber),
        status: p.status,
        block_id: p.block_id,
        offset: p.offset,
        end_offset: p.end_offset,
        selector: p.selector,
        path,
        viewport: p.viewport.map(|v| ViewportRect {
            x: JsNumber(v.x),
            y: JsNumber(v.y),
            w: JsNumber(v.w),
            h: JsNumber(v.h),
            zoom: v.zoom.map(JsNumber),
        }),
        session_id,
        updated_at: p.updated_at,
    }
}

fn collab_err(e: vibevalley_core::collab::CollabError) -> ApiError {
    refused(e.to_string())
}

fn block_type_from_str(s: &str) -> BlockType {
    BlockType::ALL.into_iter().find(|bt| bt.as_str() == s).unwrap_or(BlockType::Paragraph)
}

fn block_attrs_to_value(attrs: &BlockAttrs) -> Value {
    let mut map = Map::new();
    map.insert("level".into(), attrs.level.map_or(Value::Null, |v| Value::Number(v.into())));
    map.insert("checked".into(), attrs.checked.map_or(Value::Null, Value::Bool));
    map.insert("language".into(), attrs.language.as_ref().map_or(Value::Null, |v| Value::String(v.clone())));
    map.insert("src".into(), attrs.src.as_ref().map_or(Value::Null, |v| Value::String(v.clone())));
    map.insert("width".into(), attrs.width.map_or(Value::Null, |v| Value::Number(v.into())));
    map.insert("height".into(), attrs.height.map_or(Value::Null, |v| Value::Number(v.into())));
    map.insert("alt".into(), attrs.alt.as_ref().map_or(Value::Null, |v| Value::String(v.clone())));
    map.insert("issueId".into(), attrs.issue_id.as_ref().map_or(Value::Null, |v| Value::String(v.clone())));
    map.insert("memoryId".into(), attrs.memory_id.as_ref().map_or(Value::Null, |v| Value::String(v.clone())));
    Value::Object(map)
}

fn block_attrs_from_map(attrs: &BTreeMap<String, Value>) -> BlockAttrs {
    let obj: Map<String, Value> = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    serde_json::from_value(Value::Object(obj)).unwrap_or_default()
}

/// Computes a minimal RFC 7396 patch turning `old` into `new` for JSON object
/// entries so removed keys become explicit `null` while untouched keys stay
/// free for concurrent CRDT edits and selective undo.
fn diff_json_object(old: Option<&Value>, new: &Value) -> Value {
    let Some(new_obj) = new.as_object() else {
        return new.clone();
    };
    let Some(old_obj) = old.and_then(Value::as_object) else {
        return new.clone();
    };
    let mut patch = Map::new();
    for k in old_obj.keys() {
        if !new_obj.contains_key(k) {
            patch.insert(k.clone(), Value::Null);
        }
    }
    for (k, new_val) in new_obj {
        match old_obj.get(k) {
            Some(old_val) if old_val == new_val => {}
            Some(old_val) if old_val.is_object() && new_val.is_object() => {
                let nested = diff_json_object(Some(old_val), new_val);
                if nested.as_object().is_some_and(|m| !m.is_empty()) {
                    patch.insert(k.clone(), nested);
                }
            }
            _ => {
                patch.insert(k.clone(), new_val.clone());
            }
        }
    }
    Value::Object(patch)
}

fn apply_entry_row_to_doc(doc: &CollabDoc, entry: &db::EntryRow) -> Result<(), ApiError> {
    if entry.kind == "asset" {
        let mut obj = Map::new();
        obj.insert(ASSET_SENTINEL_KEY.into(), Value::String(entry.attachment_id.clone().unwrap_or_default()));
        obj.insert("mime".into(), Value::String(entry.mime.clone()));
        obj.insert("size".into(), Value::Number(entry.size.into()));
        doc.entry_patch_json(&entry.path, &Value::Object(obj)).map_err(collab_err)?;
        return Ok(());
    }
    if entry.kind == "json" {
        let raw = entry.value.as_deref().unwrap_or("{}");
        if let Ok(val) = serde_json::from_str::<Value>(raw)
            && val.is_object()
        {
            let prev = doc.entry_get_json(&entry.path);
            let patch = diff_json_object(prev.as_ref(), &val);
            if patch.as_object().is_some_and(|m| !m.is_empty()) || prev.is_none() {
                doc.entry_patch_json(&entry.path, &patch).map_err(collab_err)?;
            }
            return Ok(());
        }
        doc.entry_put_text(&entry.path, &entry.mime, raw).map_err(collab_err)?;
        return Ok(());
    }
    let raw = entry.value.as_deref().unwrap_or("");
    doc.entry_put_text(&entry.path, &entry.mime, raw).map_err(collab_err)?;
    Ok(())
}

/// Computes the minimal Unicode character range `[start..end]` changed between
/// `old_text` and `new_text`, returning `(start, end, original_slice, replacement)`.
pub(super) fn diff_unicode_span(old_text: &str, new_text: &str) -> (usize, usize, String, String) {
    let old_chars: Vec<char> = old_text.chars().collect();
    let new_chars: Vec<char> = new_text.chars().collect();
    let mut prefix = 0;
    while prefix < old_chars.len() && prefix < new_chars.len() && old_chars[prefix] == new_chars[prefix] {
        prefix += 1;
    }
    let mut old_end = old_chars.len();
    let mut new_end = new_chars.len();
    while old_end > prefix && new_end > prefix && old_chars[old_end - 1] == new_chars[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }
    let original: String = old_chars[prefix..old_end].iter().collect();
    let replacement: String = new_chars[prefix..new_end].iter().collect();
    (prefix, old_end, original, replacement)
}

fn history_entry_wire(e: &HistoryEntry) -> ArtifactHistoryEntry {
    let meta = e.meta.as_ref();
    ArtifactHistoryEntry {
        frontiers: encode_frontiers(&e.after_frontiers),
        author: meta.map_or_else(|| "system".to_string(), |m| m.author.clone()),
        agent: meta.and_then(|m| m.agent.clone()),
        session_id: meta.and_then(|m| m.session_id.clone()),
        turn: meta.and_then(|m| m.turn.map(i64::from)),
        origin: meta.map_or_else(|| "system".to_string(), |m| m.origin.clone()),
        summary: meta.and_then(|m| m.summary.clone()),
        at: meta.map_or(e.timestamp.saturating_mul(1_000), |m| m.at),
    }
}

fn snapshot_blocks_to_wire(artifact_id: &str, snap_blocks: &[BlockNodeSnapshot], existing: &[Block], at: i64) -> Vec<Block> {
    let prev_by_id: HashMap<&str, &Block> = existing.iter().map(|b| (b.id.as_str(), b)).collect();
    let mut last_key_by_parent: HashMap<String, String> = HashMap::new();
    let mut out = Vec::with_capacity(snap_blocks.len());
    for bn in snap_blocks {
        let slot = bn.parent_id.clone().unwrap_or_default();
        let prev_key = last_key_by_parent.get(&slot).map_or("", String::as_str);
        let order_key = key_between(prev_key, "").unwrap_or_else(|_| bn.order_key.clone());
        last_key_by_parent.insert(slot, order_key.clone());
        let kind = block_type_from_str(&bn.block_type);
        let prev = prev_by_id.get(bn.id.as_str()).copied();
        out.push(Block {
            id: bn.id.clone(),
            parent_id: bn.parent_id.clone(),
            order_key,
            r#type: kind,
            attrs: block_attrs_from_map(&bn.attrs),
            text: spans_of(kind, &bn.text),
            artifact_id: artifact_id.to_string(),
            rev: prev.map_or(1, |b| b.rev),
            deleted: None,
            updated_by: prev.map_or_else(|| USER_ID.to_string(), |b| b.updated_by.clone()),
            updated: prev.map_or(at, |b| b.updated),
        });
    }
    out
}

fn snapshot_store_entries_to_wire(artifact_id: &str, snap_entries: &[StoreEntrySnapshot], existing: &[db::EntryRow], at: i64) -> Vec<ArtifactEntry> {
    let prev_by_path: HashMap<&str, &db::EntryRow> = existing.iter().map(|r| (r.path.as_str(), r)).collect();
    let mut out = Vec::with_capacity(snap_entries.len());
    for se in snap_entries {
        let prev = prev_by_path.get(se.path.as_str()).copied();
        if se.kind == "json"
            && let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&se.content)
            && let Some(Value::String(att_id)) = map.get(ASSET_SENTINEL_KEY)
        {
            let mime = map.get("mime").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| se.mime.clone());
            let size = map.get("size").and_then(Value::as_i64).unwrap_or(0);
            out.push(ArtifactEntry {
                artifact_id: artifact_id.to_string(),
                path: se.path.clone(),
                kind: ArtifactEntryKind::Asset,
                mime,
                size,
                rev: prev.map_or(1, |r| r.rev),
                updated_by: prev.map_or_else(|| USER_ID.to_string(), |r| r.updated_by.clone()),
                updated: prev.map_or(at, |r| r.updated_at),
                value: None,
                attachment_id: Some(att_id.clone()),
            });
            continue;
        }
        let kind = match se.kind.as_str() {
            "json" => ArtifactEntryKind::Json,
            "asset" => ArtifactEntryKind::Asset,
            _ => ArtifactEntryKind::Text,
        };
        out.push(ArtifactEntry {
            artifact_id: artifact_id.to_string(),
            path: se.path.clone(),
            kind,
            mime: se.mime.clone(),
            size: se.content.len() as i64,
            rev: prev.map_or(1, |r| r.rev),
            updated_by: prev.map_or_else(|| USER_ID.to_string(), |r| r.updated_by.clone()),
            updated: prev.map_or(at, |r| r.updated_at),
            value: Some(se.content.clone()),
            attachment_id: None,
        });
    }
    out
}

impl Artifacts {
    // ---- Phase A: Pure in-memory PresenceHub --------------------------------

    fn presence_hub(&self, artifact_id: &str) -> PresenceHub {
        let mut map = self.presences.lock();
        map.entry(artifact_id.to_string()).or_default().clone()
    }

    pub(super) fn drop_presence_state(&self, artifact_id: &str) {
        self.presences.lock().remove(artifact_id);
        self.presence_extra.lock().retain(|(aid, _), _| aid != artifact_id);
    }

    fn publish_presence_event(&self, artifact_id: &str, event: ArtifactPresenceEvent) {
        let _ = self.presence_changes.send((artifact_id.to_string(), event));
    }

    pub(super) fn evict_expired_presence(&self, artifact_id: &str) {
        let hub = {
            let map = self.presences.lock();
            let Some(hub) = map.get(artifact_id) else { return };
            hub.clone()
        };
        let evicted = hub.evict_stale(now());
        if evicted.is_empty() {
            return;
        }
        {
            let mut extra = self.presence_extra.lock();
            for peer_id in &evicted {
                extra.remove(&(artifact_id.to_string(), peer_id.clone()));
            }
        }
        for peer_id in evicted {
            self.publish_presence_event(artifact_id, ArtifactPresenceEvent::Remove { peer_id });
        }
    }

    pub(super) fn presence_snapshot(&self, artifact_id: &str) -> Vec<ArtifactPresence> {
        self.evict_expired_presence(artifact_id);
        let hub = {
            let map = self.presences.lock();
            let Some(hub) = map.get(artifact_id) else {
                return Vec::new();
            };
            hub.clone()
        };
        let payloads = hub.snapshot();
        let extra = self.presence_extra.lock();
        payloads
            .into_iter()
            .map(|p| {
                let meta = extra.get(&(artifact_id.to_string(), p.id.clone())).cloned();
                payload_to_presence(p, meta)
            })
            .collect()
    }

    pub(super) fn presence_payloads(&self, artifact_id: &str) -> Vec<PresencePayload> {
        self.evict_expired_presence(artifact_id);
        let map = self.presences.lock();
        map.get(artifact_id).map_or_else(Vec::new, PresenceHub::snapshot)
    }

    /// Upserts one live presence record purely in memory and broadcasts `Upsert`.
    pub(super) fn upsert_presence_entry(&self, artifact_id: &str, mut presence: ArtifactPresence) -> Result<(), ApiError> {
        if presence.updated_at <= 0 {
            presence.updated_at = now();
        }
        if presence.color.as_deref().is_none_or(|c| c.trim().is_empty()) {
            presence.color = Some(default_color_for(&presence.id));
        }
        let hub = self.presence_hub(artifact_id);
        let payload = presence_to_payload(&presence);
        hub.upsert(payload).map_err(collab_err)?;
        {
            let mut extra = self.presence_extra.lock();
            if presence.path.is_some() || presence.session_id.is_some() {
                extra.insert(
                    (artifact_id.to_string(), presence.id.clone()),
                    (presence.path.clone(), presence.session_id.clone()),
                );
            } else {
                extra.remove(&(artifact_id.to_string(), presence.id.clone()));
            }
        }
        self.publish_presence_event(artifact_id, ArtifactPresenceEvent::Upsert { peer: presence });
        Ok(())
    }

    /// Removes one live presence record purely in memory and broadcasts `Remove`.
    pub(super) fn remove_presence_entry(&self, artifact_id: &str, peer_id: &str) {
        let hub = {
            let map = self.presences.lock();
            map.get(artifact_id).cloned()
        };
        if let Some(hub) = hub {
            let _ = hub.remove(peer_id);
        }
        self.presence_extra.lock().remove(&(artifact_id.to_string(), peer_id.to_string()));
        self.publish_presence_event(artifact_id, ArtifactPresenceEvent::Remove { peer_id: peer_id.to_string() });
    }

    /// Pure in-memory presence update (`artifact.presence.update`): never writes
    /// to SQLite and never increments `artifact.seq`.
    pub async fn update_presence_async(&self, actor: &str, req: &ArtifactPresenceUpdateRequest) -> Result<(), ApiError> {
        // Read-only existence check.
        self.found(self.db.read_conn(), &req.id).await?;
        self.evict_expired_presence(&req.id);
        match &req.presence {
            Some(p) => {
                let mut next = p.clone();
                if next.id.trim().is_empty() {
                    next.id = req.peer_id.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(actor).to_string();
                }
                self.upsert_presence_entry(&req.id, next)
            }
            None => {
                let peer_id = req.peer_id.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(actor);
                self.remove_presence_entry(&req.id, peer_id);
                Ok(())
            }
        }
    }

    /// Streams initial `Snapshot` of live peers followed by incremental `Upsert`
    /// and `Remove` events (including TTL evictions).
    pub async fn follow_presence_async(self: &Arc<Self>, hub: &Hub, id: &str, sink: Sink) -> Result<(), ApiError> {
        self.found(self.db.read_conn(), id).await?;
        let mut rx = self.presence_changes.subscribe();
        let initial = self.presence_snapshot(id);
        let weak = Arc::downgrade(self);
        let artifact_id = id.to_string();
        let hub_cancel = hub.child_token();
        let closed = self.cancel.clone();
        hub.spawn_task(async move {
            if !sink.send(&ArtifactPresenceEvent::Snapshot { peers: initial }) {
                return;
            }
            let mut evict = tokio::time::interval(PRESENCE_EVICT_INTERVAL);
            evict.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // Skip immediate tick; `presence_snapshot` just evicted expired peers.
            evict.tick().await;
            loop {
                if sink.stopped() {
                    return;
                }
                tokio::select! {
                    biased;
                    _ = hub_cancel.cancelled() => return,
                    _ = closed.cancelled() => return,
                    _ = sink.stop.recv_async() => return,
                    _ = evict.tick() => {
                        let Some(a) = weak.upgrade() else { return };
                        a.evict_expired_presence(&artifact_id);
                    }
                    res = rx.recv() => match res {
                        Ok((aid, ev)) => {
                            if aid == artifact_id && !sink.send(&ev) {
                                return;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let Some(a) = weak.upgrade() else { return };
                            let peers = a.presence_snapshot(&artifact_id);
                            if !sink.send(&ArtifactPresenceEvent::Snapshot { peers }) {
                                return;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                }
            }
        });
        Ok(())
    }

    /// Injects strict-CSP-safe presence highlight listener and initial active
    /// highlights into sandboxed HTML / store viewer output.
    pub(super) fn inject_presence_highlights(&self, artifact_id: &str, mut html: String, include_script: bool) -> String {
        let payloads = self.presence_payloads(artifact_id);
        let cmd = presence_highlight_from_payloads(&payloads);
        let mut snippet = String::new();
        if include_script {
            snippet.push_str(presence_highlight_script());
        }
        if !cmd.items.is_empty()
            && let Ok(raw) = serde_json::to_string(&cmd)
        {
            let escaped = raw.replace("</", "<\\/");
            snippet.push_str(&format!("<script>window.postMessage({escaped},\"*\");</script>"));
        }
        if snippet.is_empty() {
            return html;
        }
        if let Some(pos) = html.rfind("</body>") {
            html.insert_str(pos, &snippet);
        } else {
            html.push_str(&snippet);
        }
        html
    }

    // ---- Phase B: CollabDoc bootstrap, sync & durable Cursor helpers --------

    pub(super) async fn load_or_bootstrap_blocks_doc_async<C: ConnectionTrait>(
        &self,
        db: &C,
        row: &ArtifactRow,
        existing: &[Block],
    ) -> Result<CollabDoc, ApiError> {
        if let Some(bytes) = db::artifact_collab(db, &row.id).await.map_err(q)? {
            return CollabDoc::from_snapshot(&bytes).map_err(collab_err);
        }
        let doc = CollabDoc::new();
        let live = ordered(existing);
        if !live.is_empty() {
            let mut sibling_counts: HashMap<Option<&str>, usize> = HashMap::new();
            for b in &live {
                let idx = sibling_counts.entry(b.parent_id.as_deref()).or_insert(0);
                let pos = *idx;
                *idx += 1;
                let attrs = block_attrs_to_value(&b.attrs);
                doc.upsert_block(&b.id, b.parent_id.as_deref(), Some(pos), b.r#type.as_str(), &plain(&b.text), Some(&attrs))
                    .map_err(collab_err)?;
            }
            let meta = commit_meta_for_actor(&row.by_id, Some("bootstrap".into()), row.created_at);
            doc.commit(&meta).map_err(collab_err)?;
        }
        Ok(doc)
    }

    pub(super) async fn sync_blocks_to_collab_async<C: ConnectionTrait>(
        &self,
        db: &C,
        row: &ArtifactRow,
        pre_blocks: &[Block],
        post_all: &[Block],
        changed: &[Block],
        meta: &CommitMeta,
    ) -> Result<(), ApiError> {
        if changed.is_empty() {
            return Ok(());
        }
        let doc = self.load_or_bootstrap_blocks_doc_async(db, row, pre_blocks).await?;
        let prev_by_id: HashMap<&str, &Block> = pre_blocks.iter().map(|b| (b.id.as_str(), b)).collect();
        let live_post = ordered(post_all);
        let mut live_index: HashMap<&str, usize> = HashMap::new();
        let mut sibling_counts: HashMap<Option<&str>, usize> = HashMap::new();
        for b in &live_post {
            let idx = sibling_counts.entry(b.parent_id.as_deref()).or_insert(0);
            live_index.insert(b.id.as_str(), *idx);
            *idx += 1;
        }
        let changed_ids: HashSet<&str> = changed.iter().map(|b| b.id.as_str()).collect();
        // Apply live changed blocks in parent-before-child preorder so `LoroTree`
        // always finds newly created parents before their children.
        for b in &live_post {
            if !changed_ids.contains(b.id.as_str()) {
                continue;
            }
            let prev = prev_by_id.get(b.id.as_str()).copied();
            let moved_or_new = prev.is_none_or(|p| p.deleted == Some(true) || p.parent_id != b.parent_id || p.order_key != b.order_key);
            let target_parent = if moved_or_new { b.parent_id.as_deref() } else { None };
            let target_index = if moved_or_new { live_index.get(b.id.as_str()).copied() } else { None };
            let attrs = block_attrs_to_value(&b.attrs);
            doc.upsert_block(&b.id, target_parent, target_index, b.r#type.as_str(), &plain(&b.text), Some(&attrs))
                .map_err(collab_err)?;
        }
        for b in changed {
            if b.deleted == Some(true) {
                let _ = doc.tree_delete(&b.id);
            }
        }
        doc.commit(meta).map_err(collab_err)?;
        let snapshot = doc.export_snapshot().map_err(collab_err)?;
        db::upsert_artifact_collab(db, &row.id, &snapshot, meta.at).await.map_err(q)?;
        Ok(())
    }

    pub(super) async fn load_or_bootstrap_store_doc_async<C: ConnectionTrait>(
        &self,
        db: &C,
        row: &ArtifactRow,
        existing: &[db::EntryRow],
    ) -> Result<CollabDoc, ApiError> {
        if let Some(bytes) = db::artifact_collab(db, &row.id).await.map_err(q)? {
            return CollabDoc::from_snapshot(&bytes).map_err(collab_err);
        }
        let doc = CollabDoc::new();
        if !existing.is_empty() {
            for e in existing {
                apply_entry_row_to_doc(&doc, e)?;
            }
            let meta = commit_meta_for_actor(&row.by_id, Some("bootstrap".into()), row.created_at);
            doc.commit(&meta).map_err(collab_err)?;
        }
        Ok(doc)
    }

    pub(super) async fn sync_store_to_collab_async<C: ConnectionTrait>(
        db: &C,
        artifact_id: &str,
        doc: &CollabDoc,
        working: &BTreeMap<String, db::EntryRow>,
        changed_paths: &[String],
        removed_paths: &[String],
        meta: &CommitMeta,
    ) -> Result<(), ApiError> {
        if changed_paths.is_empty() && removed_paths.is_empty() {
            return Ok(());
        }
        for p in removed_paths {
            doc.entry_delete(p).map_err(collab_err)?;
        }
        for p in changed_paths {
            if let Some(entry) = working.get(p) {
                apply_entry_row_to_doc(doc, entry)?;
            }
        }
        doc.commit(meta).map_err(collab_err)?;
        let snapshot = doc.export_snapshot().map_err(collab_err)?;
        db::upsert_artifact_collab(db, artifact_id, &snapshot, meta.at).await.map_err(q)?;
        Ok(())
    }

    pub(super) async fn sync_html_to_collab_async<C: ConnectionTrait>(
        &self,
        db: &C,
        artifact_id: &str,
        prior_html: Option<&str>,
        new_html: &str,
        meta: &CommitMeta,
    ) -> Result<(), ApiError> {
        let doc = if let Some(bytes) = db::artifact_collab(db, artifact_id).await.map_err(q)? {
            CollabDoc::from_snapshot(&bytes).map_err(collab_err)?
        } else {
            let d = CollabDoc::new();
            if let Some(prev) = prior_html {
                d.html_update(prev).map_err(collab_err)?;
                d.commit(&CommitMeta::user(USER_ID, Some("bootstrap".into()), meta.at.saturating_sub(1)))
                    .map_err(collab_err)?;
            }
            d
        };
        doc.html_update(new_html).map_err(collab_err)?;
        doc.commit(meta).map_err(collab_err)?;
        let snapshot = doc.export_snapshot().map_err(collab_err)?;
        db::upsert_artifact_collab(db, artifact_id, &snapshot, meta.at).await.map_err(q)?;
        Ok(())
    }

    async fn load_collab_for_row_async<C: ConnectionTrait>(&self, db: &C, row: &ArtifactRow) -> Result<CollabDoc, ApiError> {
        if let Some(bytes) = db::artifact_collab(db, &row.id).await.map_err(q)? {
            return CollabDoc::from_snapshot(&bytes).map_err(collab_err);
        }
        match row.body.as_str() {
            "blocks" => {
                let blocks = db::blocks(db, &row.id).await.map_err(q)?;
                self.load_or_bootstrap_blocks_doc_async(db, row, &blocks).await
            }
            "store" => {
                let entries = db::entries(db, &row.id).await.map_err(q)?;
                self.load_or_bootstrap_store_doc_async(db, row, &entries).await
            }
            "html" => {
                let doc = CollabDoc::new();
                if row.version > 0
                    && let Some(v) = db::version(db, &row.id, row.version).await.map_err(q)?
                    && let Ok(source) = self.page_of_async(row, &v).await
                {
                    doc.html_update(&source).map_err(collab_err)?;
                    let meta = commit_meta_for_actor(&v.by_id, v.note.clone(), v.created_at);
                    doc.commit(&meta).map_err(collab_err)?;
                }
                Ok(doc)
            }
            _ => Ok(CollabDoc::new()),
        }
    }

    /// Anchors a text suggestion range on `block` using persistent Loro `Cursor`s,
    /// returning `(cursor_start, cursor_end, start_offset, end_offset, anchor_text, replacement_text)`.
    pub(super) async fn anchor_suggestion_range_async<C: ConnectionTrait>(
        &self,
        db: &C,
        row: &ArtifactRow,
        all_blocks: &[Block],
        block: &Block,
        new_text: &str,
    ) -> Result<(String, String, u32, u32, String, String), ApiError> {
        let doc = self.load_or_bootstrap_blocks_doc_async(db, row, all_blocks).await?;
        let old_text = doc.text_get(&block.id).unwrap_or_else(|| plain(&block.text));
        if doc.text_get(&block.id).is_none() {
            let attrs = block_attrs_to_value(&block.attrs);
            doc.upsert_block(&block.id, block.parent_id.as_deref(), None, block.r#type.as_str(), &old_text, Some(&attrs))
                .map_err(collab_err)?;
            let meta = commit_meta_for_actor(&block.updated_by, Some("anchor-seed".into()), block.updated);
            doc.commit(&meta).map_err(collab_err)?;
            let snapshot = doc.export_snapshot().map_err(collab_err)?;
            db::upsert_artifact_collab(db, &row.id, &snapshot, now()).await.map_err(q)?;
        }
        let (start, end, original, replacement) = diff_unicode_span(&old_text, new_text);
        let anchor = doc.anchor_text_range(&block.id, start, end).map_err(collab_err)?;
        Ok((
            anchor.start_cursor,
            anchor.end_cursor,
            u32::try_from(start).unwrap_or(u32::MAX),
            u32::try_from(end).unwrap_or(u32::MAX),
            original,
            replacement,
        ))
    }

    /// Resolves live drifted offsets for any suggestion carrying persistent cursors.
    pub(super) async fn hydrate_suggestion_offsets_async<C: ConnectionTrait>(&self, db: &C, artifact_id: &str, items: &mut [Suggestion]) {
        if !items.iter().any(|s| s.cursor_start.is_some() && s.cursor_end.is_some()) {
            return;
        }
        let Ok(Some(bytes)) = db::artifact_collab(db, artifact_id).await else {
            return;
        };
        let Ok(doc) = CollabDoc::from_snapshot(&bytes) else {
            return;
        };
        for s in items {
            if let (Some(cs), Some(ce)) = (&s.cursor_start, &s.cursor_end) {
                let anchor = TextRangeAnchor {
                    text_key: s.block_id.clone(),
                    start_cursor: cs.clone(),
                    end_cursor: ce.clone(),
                };
                if let Ok(resolved) = doc.resolve_text_range(&anchor) {
                    s.start_offset = u32::try_from(resolved.start).ok();
                    s.end_offset = u32::try_from(resolved.end).ok();
                }
            }
        }
    }

    /// Attempts to merge a text-only suggestion whose `base_rev` moved on due to
    /// upstream/downstream edits, using its persistent Loro `Cursor` range.
    /// Returns `Ok(Some(merged_plain_text))` when the anchored span is intact, or
    /// `Ok(None)` when the anchored span itself was overwritten (caller refuses as stale).
    pub(super) async fn try_merge_cursor_suggestion_async(
        &self,
        artifact_id: &str,
        block: &Block,
        stored: &StoredSuggestion,
    ) -> Result<Option<String>, ApiError> {
        let (Some(cs), Some(ce)) = (&stored.wire.cursor_start, &stored.wire.cursor_end) else {
            return Ok(None);
        };
        let Some(replacement) = &stored.replacement_text else {
            return Ok(None);
        };
        let conn = self.db.read_conn();
        let row = self.found_blocks_async(conn, artifact_id).await?;
        let doc = self.load_collab_for_row_async(conn, &row).await?;
        let anchor = TextRangeAnchor {
            text_key: block.id.clone(),
            start_cursor: cs.clone(),
            end_cursor: ce.clone(),
        };
        let Ok(resolved) = doc.resolve_text_range(&anchor) else {
            return Ok(None);
        };
        let current_text = doc.text_get(&block.id).unwrap_or_else(|| plain(&block.text));
        let current_chars: Vec<char> = current_text.chars().collect();
        if resolved.start > current_chars.len() || resolved.end > current_chars.len() || resolved.start > resolved.end {
            return Ok(None);
        }
        let current_slice: String = current_chars[resolved.start..resolved.end].iter().collect();
        let expected_slice = stored.anchor_text.as_deref().unwrap_or("");
        if !expected_slice.is_empty() && current_slice != expected_slice {
            // The anchored characters themselves were overwritten by the user.
            return Ok(None);
        }
        // Apply on a scratch clone of the text so `apply_batch` remains the single
        // atomic commit point that updates both `artifact_block` and `artifact_collab`.
        let mut merged = String::new();
        for ch in &current_chars[..resolved.start] {
            merged.push(*ch);
        }
        merged.push_str(replacement);
        for ch in &current_chars[resolved.end..] {
            merged.push(*ch);
        }
        Ok(Some(merged))
    }

    // ---- Phase C: Time Travel, Compaction & Selective Per-Origin Undo -------

    pub async fn history_list_async(&self, req: &ArtifactHistoryListRequest) -> Result<Vec<ArtifactHistoryEntry>, ApiError> {
        let conn = self.db.read_conn();
        let row = self.found(conn, &req.id).await?;
        let doc = self.load_collab_for_row_async(conn, &row).await?;
        let mut list: Vec<ArtifactHistoryEntry> = doc.history().map_err(collab_err)?.iter().map(history_entry_wire).collect();
        list.reverse();
        if let Some(limit) = req.limit {
            list.truncate(limit.max(0) as usize);
        }
        Ok(list)
    }

    pub async fn history_preview_async(&self, req: &ArtifactHistoryPreviewRequest) -> Result<ArtifactHistoryPreviewResult, ApiError> {
        let conn = self.db.read_conn();
        let row = self.found(conn, &req.id).await?;
        let doc = self.load_collab_for_row_async(conn, &row).await?;
        let frontiers = decode_frontiers(&req.frontiers).map_err(collab_err)?;
        let snap = doc.checkout_snapshot(&frontiers).map_err(collab_err)?;
        let entry = doc
            .history()
            .map_err(collab_err)?
            .iter()
            .find(|e| encode_frontiers(&e.after_frontiers) == req.frontiers)
            .map(history_entry_wire);
        let at = entry.as_ref().map_or(row.updated_at, |e| e.at);
        let artifact_type = row.artifact_type.as_deref().and_then(artifact_type_of);
        match row.body.as_str() {
            "blocks" => {
                let existing = db::blocks(conn, &row.id).await.map_err(q)?;
                let blocks = snapshot_blocks_to_wire(&row.id, &snap.blocks, &existing, at);
                let md = markdown_of(&blocks);
                Ok(ArtifactHistoryPreviewResult {
                    artifact_id: row.id,
                    body: ArtifactBody::Blocks,
                    artifact_type,
                    frontiers: req.frontiers.clone(),
                    entry,
                    blocks: Some(blocks),
                    entries: None,
                    html: None,
                    markdown: Some(md),
                })
            }
            "store" => {
                let existing = db::entries(conn, &row.id).await.map_err(q)?;
                let entries = snapshot_store_entries_to_wire(&row.id, &snap.store_entries, &existing, at);
                Ok(ArtifactHistoryPreviewResult {
                    artifact_id: row.id,
                    body: ArtifactBody::Store,
                    artifact_type,
                    frontiers: req.frontiers.clone(),
                    entry,
                    blocks: None,
                    entries: Some(entries),
                    html: None,
                    markdown: None,
                })
            }
            _ => Ok(ArtifactHistoryPreviewResult {
                artifact_id: row.id,
                body: ArtifactBody::Html,
                artifact_type,
                frontiers: req.frontiers.clone(),
                entry,
                blocks: None,
                entries: None,
                html: snap.html,
                markdown: None,
            }),
        }
    }

    /// Projects a mutated `CollabDoc` (after `restore_to` or `selective_undo_origin`)
    /// back into SQLite/PostgreSQL projection tables + `artifact_collab` and broadcasts live updates.
    async fn apply_collab_projection_async(&self, row: &ArtifactRow, doc: &CollabDoc, actor: &str, note: Option<String>, at: i64) -> Result<Wire, ApiError> {
        let snap = doc.project_snapshot();
        let bytes = doc.export_snapshot().map_err(collab_err)?;
        match row.body.as_str() {
            "blocks" => {
                let ack = {
                    let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
                    let outcome: Result<BlockAck, ApiError> = async {
                        let current_row = self.found_blocks_async(&tx, &row.id).await?;
                        let existing = db::blocks(&tx, &row.id).await.map_err(q)?;
                        let existing_by_id: HashMap<String, Block> = existing.iter().cloned().map(|b| (b.id.clone(), b)).collect();
                        let projected = snapshot_blocks_to_wire(&row.id, &snap.blocks, &existing, at);
                        let projected_ids: HashSet<String> = projected.iter().map(|b| b.id.clone()).collect();
                        let mut changed = Vec::new();
                        for mut b in projected {
                            let prev = existing_by_id.get(&b.id);
                            let rev = prev.map_or(1, |p| p.rev + 1);
                            b.rev = rev;
                            b.deleted = Some(false);
                            b.updated_by = prev.map_or_else(|| actor.to_string(), |p| p.updated_by.clone());
                            b.updated = at;
                            db::put_block(&tx, &row.id, &b).await.map_err(q)?;
                            db::add_revision(&tx, &b.id, b.rev, &b.text, actor, "normal", at).await.map_err(q)?;
                            changed.push(b);
                        }
                        // Tombstone blocks absent from the restored snapshot instead of hard-deleting
                        // so foreign keys from `artifact_suggestion` stay intact and followers see removals.
                        for old in &existing {
                            if old.deleted != Some(true) && !projected_ids.contains(&old.id) {
                                let mut tomb = old.clone();
                                tomb.rev += 1;
                                tomb.deleted = Some(true);
                                tomb.updated = at;
                                db::put_block(&tx, &row.id, &tomb).await.map_err(q)?;
                                changed.push(tomb);
                            }
                        }
                        let seq = current_row.seq + 1;
                        let batch_id = new_id();
                        let block_ids: Vec<String> = changed.iter().map(|b| b.id.clone()).collect();
                        db::add_change(
                            &tx,
                            &db::NewChange {
                                artifact_id: &row.id,
                                seq,
                                batch_id: &batch_id,
                                actor,
                                block_ids: &block_ids,
                                results: &[],
                                created_at: at,
                            },
                        )
                        .await
                        .map_err(q)?;
                        db::artifact_accepted(&tx, &row.id, seq, at).await.map_err(q)?;
                        db::upsert_artifact_collab(&tx, &row.id, &bytes, at).await.map_err(q)?;
                        Ok(BlockAck {
                            batch_id,
                            seq,
                            results: vec![],
                            blocks: changed,
                        })
                    }
                    .await;
                    match outcome {
                        Ok(ack) => {
                            tx.commit().await.map_err(q)?;
                            ack
                        }
                        Err(err) => {
                            let _ = tx.rollback().await;
                            return Err(err);
                        }
                    }
                };
                self.publish_change(&row.id, &ack);
                self.get_now_async(&row.id).await
            }
            "store" => {
                let change = {
                    let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
                    let outcome: Result<EntryChange, ApiError> = async {
                        let current_row = self.found(&tx, &row.id).await?;
                        let existing = db::entries(&tx, &row.id).await.map_err(q)?;
                        let prev_rev_by_path: HashMap<String, i64> = existing.iter().map(|r| (r.path.clone(), r.rev)).collect();
                        let projected = snapshot_store_entries_to_wire(&row.id, &snap.store_entries, &existing, at);
                        let projected_paths: HashSet<String> = projected.iter().map(|e| e.path.clone()).collect();
                        let mut deleted_paths = Vec::new();
                        for old in &existing {
                            if !projected_paths.contains(&old.path) {
                                db::delete_entry(&tx, &row.id, &old.path).await.map_err(q)?;
                                deleted_paths.push(old.path.clone());
                            }
                        }
                        let mut changed_paths = Vec::new();
                        let mut event_entries = Vec::new();
                        for mut e in projected {
                            let prev_rev = prev_rev_by_path.get(&e.path).copied().unwrap_or(0);
                            e.rev = prev_rev + 1;
                            e.updated = at;
                            db::upsert_entry(
                                &tx,
                                db::UpsertEntry {
                                    artifact_id: row.id.clone(),
                                    path: e.path.clone(),
                                    kind: e.kind.as_str().to_string(),
                                    mime: e.mime.clone(),
                                    value: e.value.clone(),
                                    attachment_id: e.attachment_id.clone(),
                                    size: e.size,
                                    rev: e.rev,
                                    updated_by: e.updated_by.clone(),
                                    updated_at: at,
                                },
                            )
                            .await
                            .map_err(q)?;
                            changed_paths.push(e.path.clone());
                            if e.size > INLINE_EVENT_MAX_BYTES as i64 {
                                e.value = None;
                            }
                            event_entries.push(e);
                        }
                        let seq = current_row.seq + 1;
                        db::add_entry_change(&tx, &row.id, seq, actor, &changed_paths, &deleted_paths, at)
                            .await
                            .map_err(q)?;
                        db::artifact_accepted(&tx, &row.id, seq, at).await.map_err(q)?;
                        db::upsert_artifact_collab(&tx, &row.id, &bytes, at).await.map_err(q)?;
                        Ok(EntryChange {
                            artifact: row.id.clone(),
                            seq,
                            entries: event_entries,
                            deleted: deleted_paths,
                        })
                    }
                    .await;
                    match outcome {
                        Ok(change) => {
                            tx.commit().await.map_err(q)?;
                            change
                        }
                        Err(err) => {
                            let _ = tx.rollback().await;
                            return Err(err);
                        }
                    }
                };
                let _ = self.entry_changes.send(change);
                self.get_now_async(&row.id).await
            }
            _ => {
                let html = snap.html.unwrap_or_default();
                let file = self.keep_async(html.as_bytes().to_vec(), &row.title).await?;
                {
                    let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
                    let outcome: Result<(), ApiError> = async {
                        let current_row = self.found(&tx, &row.id).await?;
                        let next = current_row.version + 1;
                        db::add_version(
                            &tx,
                            db::NewVersion {
                                artifact_id: row.id.clone(),
                                version: next,
                                attachment_id: file,
                                size: html.len() as i64,
                                note,
                                by_id: actor.to_string(),
                                by_name: if actor == USER_ID {
                                    t("server.channel.name.user", &[])
                                } else {
                                    actor.to_string()
                                },
                                created_at: at,
                            },
                        )
                        .await
                        .map_err(q)?;
                        db::artifact_versioned(&tx, &row.id, next, at).await.map_err(q)?;
                        db::upsert_artifact_collab(&tx, &row.id, &bytes, at).await.map_err(q)?;
                        Ok(())
                    }
                    .await;
                    match outcome {
                        Ok(()) => tx.commit().await.map_err(q)?,
                        Err(err) => {
                            let _ = tx.rollback().await;
                            return Err(err);
                        }
                    }
                }
                self.get_now_async(&row.id).await
            }
        }
    }

    async fn lock_body(&self, row: &ArtifactRow) -> BodyLockGuard<'_> {
        match row.body.as_str() {
            "blocks" => BodyLockGuard::Blocks {
                _guard: self.batches.lock().await,
            },
            "store" => BodyLockGuard::Store {
                _guard: self.entry_lock(&row.id).lock_owned().await,
            },
            _ => BodyLockGuard::Rows {
                _guard: self.rows.lock().await,
            },
        }
    }

    pub async fn history_restore_async(&self, req: &ArtifactHistoryRestoreRequest) -> Result<Wire, ApiError> {
        let row = self.found(self.db.read_conn(), &req.id).await?;
        let target = decode_frontiers(&req.frontiers).map_err(collab_err)?;
        let at = now();
        let note = req.note.clone().or_else(|| Some("restore".to_string()));
        let meta = CommitMeta::user(USER_ID, note.clone(), at);
        let _body_lock = self.lock_body(&row).await;
        let doc = self.load_collab_for_row_async(self.db.read_conn(), &row).await?;
        if doc.restore_to(&target, &meta).is_err() {
            // Fallback when Loro's `revert_to` cannot emit an inverse diff across
            // a child container deleted in an earlier commit: materialize the target
            // snapshot via `checkout_snapshot` and apply it as a clean forward commit.
            let target_snap = doc.checkout_snapshot(&target).map_err(collab_err)?;
            let current_snap = doc.project_snapshot();
            match row.body.as_str() {
                "blocks" => {
                    let keep_ids: HashSet<&str> = target_snap.blocks.iter().map(|b| b.id.as_str()).collect();
                    for cur in &current_snap.blocks {
                        if !keep_ids.contains(cur.id.as_str()) {
                            let _ = doc.tree_delete(&cur.id);
                        }
                    }
                    let mut sibling_counts: HashMap<Option<&str>, usize> = HashMap::new();
                    for bn in &target_snap.blocks {
                        let idx = sibling_counts.entry(bn.parent_id.as_deref()).or_insert(0);
                        let pos = *idx;
                        *idx += 1;
                        let attrs = block_attrs_from_map(&bn.attrs);
                        let attrs_val = block_attrs_to_value(&attrs);
                        doc.upsert_block(&bn.id, bn.parent_id.as_deref(), Some(pos), &bn.block_type, &bn.text, Some(&attrs_val))
                            .map_err(collab_err)?;
                    }
                }
                "store" => {
                    let keep_paths: HashSet<&str> = target_snap.store_entries.iter().map(|e| e.path.as_str()).collect();
                    for cur in &current_snap.store_entries {
                        if !keep_paths.contains(cur.path.as_str()) {
                            doc.entry_delete(&cur.path).map_err(collab_err)?;
                        }
                    }
                    for se in &target_snap.store_entries {
                        if se.kind == "json"
                            && let Ok(val) = serde_json::from_str::<Value>(&se.content)
                            && val.is_object()
                        {
                            let prev = doc.entry_get_json(&se.path);
                            let patch = diff_json_object(prev.as_ref(), &val);
                            if patch.as_object().is_some_and(|m| !m.is_empty()) || prev.is_none() {
                                doc.entry_patch_json(&se.path, &patch).map_err(collab_err)?;
                            }
                        } else {
                            doc.entry_put_text(&se.path, &se.mime, &se.content).map_err(collab_err)?;
                        }
                    }
                }
                _ => {
                    doc.html_update(&target_snap.html.unwrap_or_default()).map_err(collab_err)?;
                }
            }
            doc.commit(&meta).map_err(collab_err)?;
        }
        self.apply_collab_projection_async(&row, &doc, USER_ID, note, at).await
    }

    pub async fn history_undo_origin_async(&self, req: &ArtifactHistoryUndoOriginRequest) -> Result<Wire, ApiError> {
        let origin = req.origin.trim();
        if origin.is_empty() {
            return Err(refused(t("server.artifact.nothingToChange", &[])));
        }
        let row = self.found(self.db.read_conn(), &req.id).await?;
        let at = now();
        let note = Some(format!("undo {origin}"));
        let meta = CommitMeta::undo(USER_ID, origin, note.clone(), at);
        let _body_lock = self.lock_body(&row).await;
        let doc = self.load_collab_for_row_async(self.db.read_conn(), &row).await?;
        let reverted = doc.selective_undo_origin(origin, &meta).map_err(collab_err)?;
        if reverted == 0 {
            return self.get_now_async(&row.id).await;
        }
        self.apply_collab_projection_async(&row, &doc, USER_ID, note, at).await
    }

    pub async fn history_compact_async(&self, req: &ArtifactHistoryCompactRequest) -> Result<Wire, ApiError> {
        let row = self.found(self.db.read_conn(), &req.id).await?;
        let _body_lock = self.lock_body(&row).await;
        let conn = self.db.write_conn();
        let doc = self.load_collab_for_row_async(conn, &row).await?;
        let shallow = doc.compact_shallow_snapshot().map_err(collab_err)?;
        db::upsert_artifact_collab(conn, &row.id, &shallow, now()).await.map_err(q)?;
        self.get_now_async(&row.id).await
    }

    pub async fn history_fork_async(&self, req: &ArtifactHistoryForkRequest) -> Result<Wire, ApiError> {
        let (row, forked_doc, snap) = {
            let conn = self.db.read_conn();
            let row = self.found(conn, &req.id).await?;
            let doc = self.load_collab_for_row_async(conn, &row).await?;
            let target = decode_frontiers(&req.frontiers).map_err(collab_err)?;
            let forked = doc.fork_at(&target).map_err(collab_err)?;
            let snap = forked.project_snapshot();
            (row, forked, snap)
        };
        let title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} (fork)", row.title));
        let channel = match req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(c) => Some(self.channel.place_of(USER_ID, c)?),
            None => row.channel_id.clone(),
        };
        let artifact_type = row.artifact_type.as_deref().and_then(artifact_type_of);
        let at = now();
        let new_art_id = new_id();
        let maker = Maker::user();
        let user_name = t("server.channel.name.user", &[]);

        match row.body.as_str() {
            "blocks" => {
                // Remap block IDs so the forked rows never collide with the global
                // primary key on `artifact_block(id)`.
                let mut id_map: HashMap<String, String> = HashMap::new();
                for bn in &snap.blocks {
                    id_map.insert(bn.id.clone(), new_id());
                }
                let remapped_doc = CollabDoc::new();
                let mut last_key_by_parent: HashMap<String, String> = HashMap::new();
                let mut sibling_counts: HashMap<Option<String>, usize> = HashMap::new();
                let mut new_blocks = Vec::with_capacity(snap.blocks.len());
                for bn in &snap.blocks {
                    let bid = id_map.get(&bn.id).cloned().unwrap_or_else(new_id);
                    let pid = bn.parent_id.as_ref().and_then(|p| id_map.get(p).cloned());
                    let slot = pid.clone().unwrap_or_default();
                    let prev_key = last_key_by_parent.get(&slot).map_or("", String::as_str);
                    let order_key = key_between(prev_key, "").unwrap_or_else(|_| bn.order_key.clone());
                    last_key_by_parent.insert(slot, order_key.clone());
                    let idx = sibling_counts.entry(pid.clone()).or_insert(0);
                    let pos = *idx;
                    *idx += 1;
                    let kind = block_type_from_str(&bn.block_type);
                    let attrs = block_attrs_from_map(&bn.attrs);
                    let attrs_val = block_attrs_to_value(&attrs);
                    remapped_doc
                        .upsert_block(&bid, pid.as_deref(), Some(pos), kind.as_str(), &bn.text, Some(&attrs_val))
                        .map_err(collab_err)?;
                    new_blocks.push(Block {
                        id: bid,
                        parent_id: pid,
                        order_key,
                        r#type: kind,
                        attrs,
                        text: spans_of(kind, &bn.text),
                        artifact_id: new_art_id.clone(),
                        rev: 1,
                        deleted: Some(false),
                        updated_by: USER_ID.to_string(),
                        updated: at,
                    });
                }
                if !new_blocks.is_empty() {
                    remapped_doc.commit(&CommitMeta::user(USER_ID, Some("fork".into()), at)).map_err(collab_err)?;
                }
                let collab_bytes = remapped_doc.export_snapshot().map_err(collab_err)?;
                let seq = i64::from(!new_blocks.is_empty());
                {
                    let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
                    let outcome: Result<(), ApiError> = async {
                        db::add_artifact(
                            &tx,
                            db::NewArtifact {
                                id: new_art_id.clone(),
                                title,
                                body: "blocks".into(),
                                artifact_type: artifact_type.map(|ty| ty.as_str().into()),
                                is_default: false,
                                display: None,
                                channel_id: channel,
                                issue: None,
                                by_id: maker.by,
                                by_name: user_name,
                                version: 0,
                                created_at: at,
                            },
                        )
                        .await
                        .map_err(q)?;
                        for b in &new_blocks {
                            db::put_block(&tx, &new_art_id, b).await.map_err(q)?;
                            db::add_revision(&tx, &b.id, 1, &b.text, USER_ID, "normal", at).await.map_err(q)?;
                        }
                        if seq > 0 {
                            db::artifact_accepted(&tx, &new_art_id, seq, at).await.map_err(q)?;
                        }
                        db::upsert_artifact_collab(&tx, &new_art_id, &collab_bytes, at).await.map_err(q)?;
                        Ok(())
                    }
                    .await;
                    match outcome {
                        Ok(()) => tx.commit().await.map_err(q)?,
                        Err(err) => {
                            let _ = tx.rollback().await;
                            return Err(err);
                        }
                    }
                }
                self.get_now_async(&new_art_id).await
            }
            "store" => {
                let entries = snapshot_store_entries_to_wire(&new_art_id, &snap.store_entries, &[], at);
                let collab_bytes = forked_doc.export_snapshot().map_err(collab_err)?;
                let seq = i64::from(!entries.is_empty());
                {
                    let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
                    let outcome: Result<(), ApiError> = async {
                        db::add_artifact(
                            &tx,
                            db::NewArtifact {
                                id: new_art_id.clone(),
                                title,
                                body: "store".into(),
                                artifact_type: artifact_type.map(|ty| ty.as_str().into()),
                                is_default: false,
                                display: None,
                                channel_id: channel,
                                issue: None,
                                by_id: maker.by,
                                by_name: user_name,
                                version: 0,
                                created_at: at,
                            },
                        )
                        .await
                        .map_err(q)?;
                        let mut paths = Vec::with_capacity(entries.len());
                        for e in &entries {
                            db::upsert_entry(
                                &tx,
                                db::UpsertEntry {
                                    artifact_id: new_art_id.clone(),
                                    path: e.path.clone(),
                                    kind: e.kind.as_str().to_string(),
                                    mime: e.mime.clone(),
                                    value: e.value.clone(),
                                    attachment_id: e.attachment_id.clone(),
                                    size: e.size,
                                    rev: 1,
                                    updated_by: USER_ID.to_string(),
                                    updated_at: at,
                                },
                            )
                            .await
                            .map_err(q)?;
                            paths.push(e.path.clone());
                        }
                        if seq > 0 {
                            db::add_entry_change(&tx, &new_art_id, seq, USER_ID, &paths, &[], at).await.map_err(q)?;
                            db::artifact_accepted(&tx, &new_art_id, seq, at).await.map_err(q)?;
                        }
                        db::upsert_artifact_collab(&tx, &new_art_id, &collab_bytes, at).await.map_err(q)?;
                        Ok(())
                    }
                    .await;
                    match outcome {
                        Ok(()) => tx.commit().await.map_err(q)?,
                        Err(err) => {
                            let _ = tx.rollback().await;
                            return Err(err);
                        }
                    }
                }
                self.get_now_async(&new_art_id).await
            }
            _ => {
                let html = snap.html.unwrap_or_default();
                let file = self.keep_async(html.as_bytes().to_vec(), &title).await?;
                let collab_bytes = forked_doc.export_snapshot().map_err(collab_err)?;
                {
                    let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
                    let outcome: Result<(), ApiError> = async {
                        db::add_artifact(
                            &tx,
                            db::NewArtifact {
                                id: new_art_id.clone(),
                                title,
                                body: "html".into(),
                                artifact_type: None,
                                is_default: false,
                                display: row.display.clone().or_else(|| Some(ArtifactDisplay::Page.as_str().into())),
                                channel_id: channel,
                                issue: None,
                                by_id: maker.by.clone(),
                                by_name: user_name.clone(),
                                version: 1,
                                created_at: at,
                            },
                        )
                        .await
                        .map_err(q)?;
                        db::add_version(
                            &tx,
                            db::NewVersion {
                                artifact_id: new_art_id.clone(),
                                version: 1,
                                attachment_id: file,
                                size: html.len() as i64,
                                note: Some("fork".into()),
                                by_id: maker.by,
                                by_name: user_name,
                                created_at: at,
                            },
                        )
                        .await
                        .map_err(q)?;
                        db::upsert_artifact_collab(&tx, &new_art_id, &collab_bytes, at).await.map_err(q)?;
                        Ok(())
                    }
                    .await;
                    match outcome {
                        Ok(()) => tx.commit().await.map_err(q)?,
                        Err(err) => {
                            let _ = tx.rollback().await;
                            return Err(err);
                        }
                    }
                }
                self.get_now_async(&new_art_id).await
            }
        }
    }
}

enum BodyLockGuard<'a> {
    Blocks { _guard: tokio::sync::MutexGuard<'a, ()> },
    Store { _guard: tokio::sync::OwnedMutexGuard<()> },
    Rows { _guard: tokio::sync::MutexGuard<'a, ()> },
}
