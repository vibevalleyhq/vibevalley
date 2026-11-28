use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::Value;
use vibevalley_core::collab::{CollabDoc, CommitMeta, VersionVector, encode_version_vector};

use crate::engine::whiteboard::{WhiteboardEntry, WhiteboardEntryKind, WhiteboardEntryOp, WhiteboardWriteInput};

/// In-process Loro replica backing [`super::VvWhiteboard`] for zero-roundtrip local redraws
/// and incremental Version-Vector CRDT synchronization.
pub(super) struct WhiteboardLoroReplica {
    doc: CollabDoc,
    last_synced_vv: VersionVector,
    initialized: bool,
    has_elements: bool,
    known_entries: BTreeMap<String, Value>,
}

impl WhiteboardLoroReplica {
    pub(super) fn new() -> Self {
        let doc = CollabDoc::new();
        let last_synced_vv = doc.version_vector();
        Self {
            doc,
            last_synced_vv,
            initialized: false,
            has_elements: false,
            known_entries: BTreeMap::new(),
        }
    }

    fn is_board_entry_path(path: &str) -> bool {
        path == "board/meta" || path.starts_with("elements/")
    }

    fn build_replace_patch(prev: Option<&Value>, next: &Value) -> Value {
        let Some(next_obj) = next.as_object() else {
            return next.clone();
        };
        let mut out = next_obj.clone();
        if let Some(prev_obj) = prev.and_then(Value::as_object) {
            for k in prev_obj.keys() {
                if !out.contains_key(k) {
                    out.insert(k.clone(), Value::Null);
                }
            }
        }
        Value::Object(out)
    }

    fn merge_patch_into_known(target: &mut Value, patch: &Value) {
        let Some(patch_obj) = patch.as_object() else {
            *target = patch.clone();
            return;
        };
        if !target.is_object() {
            *target = Value::Object(serde_json::Map::new());
        }
        if let Some(target_obj) = target.as_object_mut() {
            for (k, v) in patch_obj {
                if v.is_null() {
                    target_obj.remove(k);
                } else if v.is_object()
                    && let Some(existing) = target_obj.get_mut(k)
                    && existing.is_object()
                {
                    Self::merge_patch_into_known(existing, v);
                } else {
                    target_obj.insert(k.clone(), v.clone());
                }
            }
        }
    }

    pub(super) fn apply_local_writes(&mut self, writes: &[WhiteboardWriteInput]) -> (String, String) {
        let mut changed = false;
        for w in writes {
            if w.path.starts_with("presence/") || !Self::is_board_entry_path(&w.path) {
                continue;
            }
            match w.op {
                WhiteboardEntryOp::Delete => {
                    let _ = self.doc.entry_delete(&w.path);
                    self.known_entries.remove(&w.path);
                    changed = true;
                }
                WhiteboardEntryOp::Set => {
                    if let Some(raw) = w.value.as_deref()
                        && let Ok(val) = serde_json::from_str::<Value>(raw)
                    {
                        let patch = Self::build_replace_patch(self.known_entries.get(&w.path), &val);
                        if self.doc.entry_patch_json(&w.path, &patch).is_ok() {
                            self.known_entries.insert(w.path.clone(), val);
                            if w.path.starts_with("elements/") {
                                self.has_elements = true;
                            }
                            changed = true;
                        }
                    }
                }
                WhiteboardEntryOp::Patch => {
                    if let Some(raw) = w.value.as_deref()
                        && let Ok(patch) = serde_json::from_str::<Value>(raw)
                        && self.doc.entry_patch_json(&w.path, &patch).is_ok()
                    {
                        let entry = self
                            .known_entries
                            .entry(w.path.clone())
                            .or_insert_with(|| Value::Object(serde_json::Map::new()));
                        Self::merge_patch_into_known(entry, &patch);
                        if w.path.starts_with("elements/") {
                            self.has_elements = true;
                        }
                        changed = true;
                    }
                }
                WhiteboardEntryOp::Copy => {
                    if let Some(from) = w.from.as_deref()
                        && let Some(val) = self.known_entries.get(from).cloned()
                        && self.doc.entry_patch_json(&w.path, &val).is_ok()
                    {
                        self.known_entries.insert(w.path.clone(), val);
                        if w.path.starts_with("elements/") {
                            self.has_elements = true;
                        }
                        changed = true;
                    }
                }
            }
        }
        self.initialized = true;
        if changed {
            let _ = self.doc.commit(&CommitMeta::user("local", None, 0));
        }
        let update_b64 = if changed {
            self.doc
                .export_sync_since(Some(&self.last_synced_vv))
                .map(|s| BASE64.encode(&s.bytes))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let next_vv = self.doc.version_vector();
        let vv_b64 = encode_version_vector(&next_vv);
        self.last_synced_vv = next_vv;
        (update_b64, vv_b64)
    }

    fn entry_for_value(path: String, val: &Value, seq: i64) -> WhiteboardEntry {
        let encoded = serde_json::to_string(val).unwrap_or_else(|_| "{}".to_owned());
        WhiteboardEntry {
            note_id: String::new(),
            path,
            kind: WhiteboardEntryKind::Json,
            mime: "application/json".to_owned(),
            size: encoded.len() as i64,
            rev: seq,
            updated_by: "remote".to_owned(),
            updated: 0,
            value: Some(encoded),
            attachment_id: None,
        }
    }

    pub(super) fn import_remote_bytes(&mut self, bytes: &[u8], seq: i64) -> Option<(Vec<WhiteboardEntry>, Vec<String>, bool)> {
        let was_init = self.initialized;
        let had_elements = self.has_elements;
        let _ = self.doc.import_bytes_with_status(bytes).ok()?;
        self.initialized = true;
        self.last_synced_vv = self.doc.version_vector();

        let snap = self.doc.project_snapshot();
        let next_entries: BTreeMap<String, Value> = snap.entries.into_iter().filter(|(k, _)| Self::is_board_entry_path(k)).collect();
        let has_elements_now = next_entries.keys().any(|k| k.starts_with("elements/"));
        let is_initial = !was_init || (!had_elements && has_elements_now);
        if has_elements_now {
            self.has_elements = true;
        }

        let mut deleted = Vec::new();
        for old_path in self.known_entries.keys() {
            if !next_entries.contains_key(old_path) {
                deleted.push(old_path.clone());
            }
        }
        let mut updated = Vec::new();
        for (path, val) in &next_entries {
            if is_initial || self.known_entries.get(path) != Some(val) {
                updated.push(Self::entry_for_value(path.clone(), val, seq));
            }
        }
        self.known_entries = next_entries;
        Some((updated, deleted, is_initial))
    }

    pub(super) fn sync_remote_entries(&mut self, entries: &[WhiteboardEntry], seq: i64) -> (Vec<WhiteboardEntry>, Vec<String>, bool) {
        let was_init = self.initialized;
        let had_elements = self.has_elements;
        let mut incoming = BTreeMap::new();
        for entry in entries {
            if !Self::is_board_entry_path(&entry.path) {
                continue;
            }
            if let Some(raw) = entry.value.as_deref()
                && let Ok(val) = serde_json::from_str::<Value>(raw)
            {
                incoming.insert(entry.path.clone(), val);
            }
        }

        let has_elements_now = incoming.keys().any(|k| k.starts_with("elements/"));
        let is_initial = !was_init || (!had_elements && has_elements_now);
        self.initialized = true;
        if has_elements_now {
            self.has_elements = true;
        }

        let mut deleted = Vec::new();
        for old_path in self.known_entries.keys() {
            if !incoming.contains_key(old_path) {
                let _ = self.doc.entry_delete(old_path);
                deleted.push(old_path.clone());
            }
        }

        let mut updated = Vec::new();
        for (path, val) in &incoming {
            let prev = self.known_entries.get(path);
            if prev != Some(val) {
                let patch = Self::build_replace_patch(prev, val);
                let _ = self.doc.entry_patch_json(path, &patch);
                updated.push(Self::entry_for_value(path.clone(), val, seq));
            }
        }

        if !updated.is_empty() || !deleted.is_empty() {
            let _ = self.doc.commit(&CommitMeta::user("remote", None, seq));
            self.last_synced_vv = self.doc.version_vector();
            self.known_entries = incoming;
        }

        (updated, deleted, is_initial)
    }
}
