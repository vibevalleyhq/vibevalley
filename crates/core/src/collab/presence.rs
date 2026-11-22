//! Phase A: Pure in-memory real-time presence backed by `loro::awareness::EphemeralStore`.
//!
//! Never writes to SQLite and never bumps `artifact.seq`. Supports configurable
//! TTL eviction (default 30 s) and binary incremental `encode` / `apply` sync.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    last_write_ms: Arc<Mutex<HashMap<String, u128>>>,
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
        self.with_monotonic_key_clock(&key, || {
            self.store.set(&key, encoded);
            self.store.encode(&key)
        })
    }

    /// Removes a participant's presence and returns the encoded tombstone update.
    pub fn remove(&self, id: &str) -> Vec<u8> {
        self.with_monotonic_key_clock(id, || {
            self.store.delete(id);
            self.store.encode(id)
        })
        .unwrap_or_default()
    }

    /// Loro's `EphemeralStore` stamps local mutations with wall-clock milliseconds and
    /// ignores incoming frames whose timestamp is `<=` the peer's stored timestamp.
    /// Wait for the millisecond boundary (at most 2 ms) only on same-millisecond
    /// consecutive writes to the same key so rapid upserts/tombstones always propagate.
    fn with_monotonic_key_clock<T>(&self, key: &str, op: impl FnOnce() -> T) -> Result<T, CollabError> {
        let mut last_writes = self.last_write_ms.lock().unwrap_or_else(|p| p.into_inner());
        let mut now = unix_now_ms();
        if let Some(&prev_ms) = last_writes.get(key)
            && now == prev_ms
        {
            let deadline = Instant::now() + Duration::from_millis(2);
            while now == prev_ms && Instant::now() < deadline {
                let remain_us = 1_000u64.saturating_sub(unix_sub_ms_micros()).max(50);
                std::thread::sleep(Duration::from_micros(remain_us));
                now = unix_now_ms();
            }
        }
        let out = op();
        last_writes.insert(key.to_owned(), unix_now_ms().max(now));
        Ok(out)
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
        let cutoff = unix_now_ms().saturating_sub(self.ttl_ms.max(0) as u128);
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
                let _ = self.with_monotonic_key_clock(&key, || self.store.delete(&key));
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

fn unix_now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

fn unix_sub_ms_micros() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| (d.subsec_micros() % 1_000) as u64)
}
