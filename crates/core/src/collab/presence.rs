//! Phase A: Pure in-memory real-time presence backed by `loro::awareness::EphemeralStore`.
//!
//! Never writes to SQLite and never bumps `note.seq`. Supports configurable
//! TTL eviction (default 30 s) and binary incremental `encode` / `apply` sync.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use loro::LoroValue;
use loro::awareness::EphemeralStore;
use serde::{Deserialize, Serialize};

use crate::collab::CollabError;

/// Default presence inactivity TTL in milliseconds (30 seconds).
pub const DEFAULT_PRESENCE_TTL_MS: i64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceKind {
    Cursor,
    BlockCursor,
    Selection,
    Highlight,
    Viewport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceViewport {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePayload {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub kind: PresenceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<PresenceViewport>,
    pub updated_at: i64,
}

/// Pure in-memory presence store wrapping `loro::awareness::EphemeralStore`.
#[derive(Clone)]
pub struct PresenceHub {
    store: EphemeralStore,
    ttl_ms: i64,
    last_write_ms: Arc<Mutex<HashMap<String, i64>>>,
}

impl PresenceHub {
    pub fn new(ttl_ms: i64) -> Self {
        let clamped = ttl_ms.max(1);
        Self {
            store: EphemeralStore::new(clamped),
            ttl_ms: clamped,
            last_write_ms: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn with_default_ttl() -> Self {
        Self::new(DEFAULT_PRESENCE_TTL_MS)
    }

    pub fn ttl_ms(&self) -> i64 {
        self.ttl_ms
    }

    /// Inserts or updates a participant's presence and returns the incremental
    /// binary payload to broadcast to peers.
    pub fn upsert(&self, payload: PresencePayload) -> Result<Vec<u8>, CollabError> {
        let key = payload.id.clone();
        let encoded = serde_json::to_string(&payload)?;
        self.mutate_with_monotonic_clock(&key, || {
            self.store.set(&key, encoded);
        })
    }

    /// Removes a participant's presence and returns the encoded tombstone update.
    pub fn remove(&self, id: &str) -> Vec<u8> {
        self.mutate_with_monotonic_clock(id, || {
            self.store.delete(id);
        })
        .unwrap_or_default()
    }

    /// Loro's `EphemeralStore` stamps local mutations with wall-clock milliseconds and
    /// ignores incoming frames whose timestamp is `<=` the peer's stored timestamp.
    /// When consecutive writes to the same key land in the same millisecond, advance
    /// the encoded Loro frame's timestamp by 1 ms and re-apply it locally so rapid
    /// upserts/tombstones always propagate without sleeping.
    fn mutate_with_monotonic_clock(&self, key: &str, op: impl FnOnce()) -> Result<Vec<u8>, CollabError> {
        let mut last_writes = self.last_write_ms.lock().unwrap_or_else(|p| p.into_inner());
        let t_before = unix_now_ms();
        op();
        let t_after = unix_now_ms();
        let mut bytes = self.store.encode(key);
        let prev_ms = last_writes.get(key).copied();

        let mut recorded_ts = t_after;
        if let Some(prev_ms) = prev_ms {
            let stamped = (t_before..=t_after).rev().find(|&ts| bytes.ends_with(&encode_zigzag_varint_i64(ts)));
            if let Some(actual_ts) = stamped {
                if actual_ts <= prev_ms {
                    let next_ts = prev_ms.saturating_add(1);
                    let old_suffix = encode_zigzag_varint_i64(actual_ts);
                    let new_suffix = encode_zigzag_varint_i64(next_ts);
                    bytes.truncate(bytes.len() - old_suffix.len());
                    bytes.extend_from_slice(&new_suffix);
                    self.store.apply(&bytes).map_err(|e| CollabError::Encoding(e.to_string()))?;
                    recorded_ts = next_ts;
                } else {
                    recorded_ts = actual_ts;
                }
            } else {
                recorded_ts = t_after.max(prev_ms);
            }
        }

        last_writes.insert(key.to_owned(), recorded_ts);
        Ok(bytes)
    }

    /// Encodes the latest state for a single participant (empty if missing or expired).
    pub fn encode_key(&self, id: &str) -> Vec<u8> {
        self.store.encode(id)
    }

    /// Evicts expired entries and encodes all active participants.
    pub fn encode_all(&self) -> Vec<u8> {
        self.store.remove_outdated();
        self.store.encode_all()
    }

    /// Applies a binary update produced by another `PresenceHub::upsert` / `remove` / `encode_all`.
    pub fn apply(&self, data: &[u8]) -> Result<(), CollabError> {
        if data.is_empty() {
            return Ok(());
        }
        self.store.apply(data).map_err(|e| CollabError::Encoding(e.to_string()))
    }

    /// Evicts entries past the configured wall-clock TTL and returns removed IDs.
    pub fn evict_expired(&self) -> Vec<String> {
        let before = self.store.keys();
        self.store.remove_outdated();
        let after = self.store.keys();
        let mut evicted: Vec<String> = before.into_iter().filter(|k| !after.contains(k)).collect();
        evicted.sort();
        let cutoff = unix_now_ms().saturating_sub(self.ttl_ms.max(0));
        self.last_write_ms.lock().unwrap_or_else(|p| p.into_inner()).retain(|_, ts| *ts >= cutoff);
        evicted
    }

    /// Evicts entries past wall-clock TTL AND entries whose `updated_at` is older
    /// than `now_ms - ttl_ms` (enables deterministic clock-driven eviction).
    pub fn evict_stale(&self, now_ms: i64) -> Vec<String> {
        let mut evicted = self.evict_expired();
        let states = self.store.get_all_states();
        for (key, value) in states {
            let expired_by_payload = decode_payload(&value).is_none_or(|p| p.updated_at > 0 && now_ms.saturating_sub(p.updated_at) > self.ttl_ms);
            if expired_by_payload {
                let _ = self.mutate_with_monotonic_clock(&key, || self.store.delete(&key));
                if !evicted.contains(&key) {
                    evicted.push(key);
                }
            }
        }
        evicted.sort();
        evicted
    }

    pub fn get(&self, id: &str) -> Option<PresencePayload> {
        self.store.remove_outdated();
        self.store.get(id).and_then(|v| decode_payload(&v))
    }

    /// Returns all active non-expired presence payloads sorted deterministically by `id`.
    pub fn snapshot(&self) -> Vec<PresencePayload> {
        self.store.remove_outdated();
        let mut out: Vec<PresencePayload> = self.store.get_all_states().into_values().filter_map(|v| decode_payload(&v)).collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn len(&self) -> usize {
        self.store.remove_outdated();
        self.store.keys().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for PresenceHub {
    fn default() -> Self {
        Self::with_default_ttl()
    }
}

fn decode_payload(value: &LoroValue) -> Option<PresencePayload> {
    let LoroValue::String(raw) = value else { return None };
    serde_json::from_str::<PresencePayload>(raw.as_str()).ok()
}

fn unix_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn encode_zigzag_varint_i64(value: i64) -> Vec<u8> {
    let mut n = ((value << 1) ^ (value >> 63)) as u64;
    let mut out = Vec::with_capacity(10);
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor(id: &str, x: f64, updated_at: i64) -> PresencePayload {
        PresencePayload {
            id: id.into(),
            name: "Alice".into(),
            color: "#22c55e".into(),
            avatar: None,
            kind: PresenceKind::Cursor,
            x: Some(x),
            y: Some(0.0),
            w: None,
            h: None,
            status: None,
            block_id: None,
            offset: None,
            end_offset: None,
            selector: None,
            viewport: None,
            updated_at,
        }
    }

    #[test]
    fn rapid_same_key_mutations_propagate_monotonically_without_sleeping() {
        let a = PresenceHub::with_default_ttl();
        let b = PresenceHub::with_default_ttl();

        for i in 0..50 {
            let p1 = cursor("peer:1", i as f64, 1_000 + i * 2);
            let d1 = a.upsert(p1.clone()).unwrap();
            b.apply(&d1).unwrap();
            assert_eq!(b.get("peer:1"), Some(p1));

            let p2 = cursor("peer:1", 100.0 + i as f64, 1_001 + i * 2);
            let d2 = a.upsert(p2.clone()).unwrap();
            b.apply(&d2).unwrap();
            assert_eq!(b.get("peer:1"), Some(p2));

            let tombstone = a.remove("peer:1");
            b.apply(&tombstone).unwrap();
            assert!(b.is_empty());
        }
    }
}
