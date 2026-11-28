//! Active-key reconciliation and grace-period orphan object sweeper over [`StorageBackend`].

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::storage::backend::{ObjectMeta, StorageBackend, StorageError};

/// Single unreferenced storage object eligible for reclamation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrphanCandidate {
    pub key: String,
    pub size: u64,
    pub last_modified_ms: Option<i64>,
}

/// Summary of an [`OrphanSweeper`] scan or deletion pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrphanSweepReport {
    pub dry_run: bool,
    pub candidates: Vec<OrphanCandidate>,
    pub total_bytes: u64,
    pub removed_count: u64,
    pub removed_bytes: u64,
    pub failed_keys: Vec<String>,
}

/// Stateless reconciler comparing objects under a prefix against a caller-supplied
/// set of active keys, honoring a `cutoff_ms` grace boundary and `dry_run` mode.
#[derive(Debug, Default, Clone, Copy)]
pub struct OrphanSweeper;

impl OrphanSweeper {
    /// Lists all objects under `prefix`, selects those passing `include(&meta)` whose key is NOT
    /// in `active_keys` and whose `last_modified_ms < cutoff_ms`, and deletes them unless `dry_run`
    /// is `true`.
    pub async fn sweep_prefix<F>(
        backend: &dyn StorageBackend,
        prefix: &str,
        active_keys: &HashSet<String>,
        cutoff_ms: i64,
        dry_run: bool,
        mut include: F,
    ) -> Result<OrphanSweepReport, StorageError>
    where
        F: FnMut(&ObjectMeta) -> bool,
    {
        let objects = backend.list(prefix).await?;
        let mut candidates = Vec::new();
        for meta in objects {
            if !include(&meta) {
                continue;
            }
            if active_keys.contains(&meta.key) {
                continue;
            }
            if meta.last_modified_ms.is_none_or(|modified| modified >= cutoff_ms) {
                continue;
            }
            candidates.push(OrphanCandidate {
                key: meta.key,
                size: meta.size,
                last_modified_ms: meta.last_modified_ms,
            });
        }

        let total_bytes: u64 = candidates.iter().map(|c| c.size).sum();
        if dry_run || candidates.is_empty() {
            return Ok(OrphanSweepReport {
                dry_run,
                candidates,
                total_bytes,
                removed_count: 0,
                removed_bytes: 0,
                failed_keys: Vec::new(),
            });
        }

        let mut removed_count = 0u64;
        let mut removed_bytes = 0u64;
        let mut failed_keys = Vec::new();
        for candidate in &candidates {
            match backend.delete(&candidate.key).await {
                Ok(_) => {
                    removed_count += 1;
                    removed_bytes = removed_bytes.saturating_add(candidate.size);
                }
                Err(_) => {
                    failed_keys.push(candidate.key.clone());
                }
            }
        }

        Ok(OrphanSweepReport {
            dry_run: false,
            candidates,
            total_bytes,
            removed_count,
            removed_bytes,
            failed_keys,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::core::time::ManualClock;
    use crate::storage::backend::MemoryStorage;

    #[tokio::test]
    async fn orphan_sweeper_reconciles_active_keys_grace_period_and_dry_run() {
        let clock = Arc::new(ManualClock::new(10_000));
        let store = MemoryStorage::with_clock(clock.clone());

        store.put("blobs/keep", b"active".to_vec(), None).await.unwrap();
        store.put("blobs/old-orphan", b"reclaim-me".to_vec(), None).await.unwrap();
        store.put("blobs/skip.tmp", b"ignored".to_vec(), None).await.unwrap();

        clock.set(50_000);
        store.put("blobs/fresh-orphan", b"too-new".to_vec(), None).await.unwrap();

        let active = HashSet::from(["blobs/keep".to_owned()]);
        let cutoff = 30_000;

        let dry = OrphanSweeper::sweep_prefix(&store, "blobs/", &active, cutoff, true, |m| !m.key.ends_with(".tmp"))
            .await
            .unwrap();
        assert!(dry.dry_run);
        assert_eq!(dry.candidates.len(), 1);
        assert_eq!(dry.candidates[0].key, "blobs/old-orphan");
        assert_eq!(dry.total_bytes, 10);
        assert_eq!(dry.removed_count, 0);
        assert!(store.exists("blobs/old-orphan").await.unwrap());

        let live = OrphanSweeper::sweep_prefix(&store, "blobs/", &active, cutoff, false, |m| !m.key.ends_with(".tmp"))
            .await
            .unwrap();
        assert!(!live.dry_run);
        assert_eq!(live.removed_count, 1);
        assert_eq!(live.removed_bytes, 10);
        assert!(!store.exists("blobs/old-orphan").await.unwrap());
        assert!(store.exists("blobs/keep").await.unwrap());
        assert!(store.exists("blobs/fresh-orphan").await.unwrap());
        assert!(store.exists("blobs/skip.tmp").await.unwrap());
    }
}
