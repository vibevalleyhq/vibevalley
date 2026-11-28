//! Configurable periodic retention housekeeping for append-only database tables
//! (`outbox_item`, `channel_delivery`, `session_mailbox`, `note_change`,
//! `session_event`), host disk artifact directories (`debug-bundles/`,
//! `records/`), and safe orphan attachment GC with grace period and dry-run
//! preview.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use parking_lot::Mutex as SyncMutex;
use serde::{Deserialize, Serialize};
use vibevalley_kit::storage::{OrphanSweeper, extract_sha256_tokens, is_sha256_hex};
use vibevalley_protocol::ApiError;

use super::attachment::AttachmentStorage;
use super::backend::StorageBackend;
use crate::context::{Context, Ticker, internal};

const DAY_SECS: u64 = 86_400;
const HOUR_SECS: u64 = 3_600;
const MIB: u64 = 1024 * 1024;

/// Configurable retention windows, batch ceilings, and disk quotas for [`Housekeeper`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionPolicy {
    /// Periodic housekeeping interval (`Duration::ZERO` disables background ticks).
    pub interval: Duration,
    /// Maximum rows deleted per SQLite/PostgreSQL batch statement to avoid long write locks.
    pub batch_size: u64,
    /// Upper bound on batches per table per housekeeping tick.
    pub max_batches_per_tick: usize,
    /// Retention window for completed (`done`) `outbox_item` rows.
    pub outbox_done_ttl: Duration,
    /// Retention window for settled (`status != 'pending'`) `channel_delivery` rows.
    pub channel_delivery_ttl: Duration,
    /// Retention window for settled (`status NOT IN ('pending', 'claimed')`) `session_mailbox` rows.
    pub session_mailbox_ttl: Duration,
    /// Maximum newest `note_change` rows retained per note (0 disables pruning).
    pub note_changes_keep_per_note: u64,
    /// Retention window for historical `session_event` rows belonging to `departed = true` sessions.
    pub departed_session_events_ttl: Duration,
    /// Number of newest diagnostic ZIP archives to retain under `<home>/debug-bundles/`.
    pub debug_bundles_keep: usize,
    /// Retention window for `oar-voyage/3` JSONL files under `<home>/records/`.
    pub records_ttl: Duration,
    /// Maximum total bytes retained under `<home>/records/` after TTL pruning.
    pub records_max_bytes: u64,
    /// Grace window protecting recently created attachments from orphan GC.
    pub orphan_attachment_grace: Duration,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(HOUR_SECS),
            batch_size: 200,
            max_batches_per_tick: 20,
            outbox_done_ttl: Duration::from_secs(7 * DAY_SECS),
            channel_delivery_ttl: Duration::from_secs(30 * DAY_SECS),
            session_mailbox_ttl: Duration::from_secs(30 * DAY_SECS),
            note_changes_keep_per_note: 256,
            departed_session_events_ttl: Duration::from_secs(14 * DAY_SECS),
            debug_bundles_keep: 10,
            records_ttl: Duration::from_secs(14 * DAY_SECS),
            records_max_bytes: 256 * MIB,
            orphan_attachment_grace: Duration::from_secs(24 * HOUR_SECS),
        }
    }
}

impl RetentionPolicy {
    /// Loads [`RetentionPolicy`] with optional `VIBEVALLEY_RETENTION_*` environment overrides.
    pub fn from_env() -> Self {
        let mut policy = Self::default();
        if let Some(secs) = env_u64("VIBEVALLEY_RETENTION_INTERVAL_SECS") {
            policy.interval = Duration::from_secs(secs);
        }
        if let Some(batch) = env_u64("VIBEVALLEY_RETENTION_BATCH_SIZE")
            && batch > 0
        {
            policy.batch_size = batch;
        }
        if let Some(days) = env_u64("VIBEVALLEY_RETENTION_OUTBOX_DAYS") {
            policy.outbox_done_ttl = Duration::from_secs(days.saturating_mul(DAY_SECS));
        }
        if let Some(days) = env_u64("VIBEVALLEY_RETENTION_DELIVERY_DAYS") {
            let ttl = Duration::from_secs(days.saturating_mul(DAY_SECS));
            policy.channel_delivery_ttl = ttl;
            policy.session_mailbox_ttl = ttl;
        }
        if let Some(keep) = env_u64("VIBEVALLEY_RETENTION_NOTE_CHANGES_KEEP") {
            policy.note_changes_keep_per_note = keep;
        }
        if let Some(days) = env_u64("VIBEVALLEY_RETENTION_SESSION_EVENTS_DAYS") {
            policy.departed_session_events_ttl = Duration::from_secs(days.saturating_mul(DAY_SECS));
        }
        if let Some(keep) = env_u64("VIBEVALLEY_RETENTION_DEBUG_BUNDLES_KEEP") {
            policy.debug_bundles_keep = keep as usize;
        }
        if let Some(days) = env_u64("VIBEVALLEY_RETENTION_RECORDS_DAYS") {
            policy.records_ttl = Duration::from_secs(days.saturating_mul(DAY_SECS));
        }
        if let Some(mb) = env_u64("VIBEVALLEY_RETENTION_RECORDS_MAX_MB") {
            policy.records_max_bytes = mb.saturating_mul(MIB);
        }
        if let Some(hours) = env_u64("VIBEVALLEY_RETENTION_ORPHAN_GRACE_HOURS") {
            policy.orphan_attachment_grace = Duration::from_secs(hours.saturating_mul(HOUR_SECS));
        }
        policy
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<u64>().ok())
}

/// Summary produced by a single [`Housekeeper::run_once_async`] pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetentionReport {
    pub outbox_done: u64,
    pub channel_deliveries: u64,
    pub session_mailbox: u64,
    pub note_changes: u64,
    pub departed_session_events: u64,
    pub debug_bundles_removed: u64,
    pub debug_bundles_bytes: u64,
    pub records_removed: u64,
    pub records_bytes: u64,
}

impl RetentionReport {
    pub fn total_removed(&self) -> u64 {
        self.outbox_done
            + self.channel_deliveries
            + self.session_mailbox
            + self.note_changes
            + self.departed_session_events
            + self.debug_bundles_removed
            + self.records_removed
    }
}

/// One unreferenced attachment eligible for orphan GC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrphanAttachmentCandidate {
    pub id: String,
    pub size: u64,
    /// `true` when the blob exists in storage without a matching row in the `attachment` table.
    pub unindexed_blob: bool,
}

/// Result of [`Housekeeper::gc_orphan_attachments_async`] (supports `dry_run = true` preview).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrphanAttachmentReport {
    pub dry_run: bool,
    pub candidates: Vec<OrphanAttachmentCandidate>,
    pub total_bytes: u64,
    pub removed_count: u64,
    pub removed_bytes: u64,
}

/// Periodic maintenance worker owned by [`super::Storage`].
pub struct Housekeeper {
    home: PathBuf,
    backend: Arc<dyn StorageBackend>,
    attachment: Arc<AttachmentStorage>,
    ctx: Arc<Context>,
    policy: RetentionPolicy,
    ticker: SyncMutex<Option<Ticker>>,
}

impl Housekeeper {
    /// Creates a [`Housekeeper`] and starts its periodic ticker on `ctx.task` when `policy.interval > 0`.
    pub fn open_and_start(
        home: &Path,
        backend: Arc<dyn StorageBackend>,
        attachment: Arc<AttachmentStorage>,
        ctx: Arc<Context>,
        policy: RetentionPolicy,
    ) -> Arc<Self> {
        let housekeeper = Arc::new(Self {
            home: home.to_path_buf(),
            backend,
            attachment,
            ctx,
            policy,
            ticker: SyncMutex::new(None),
        });
        housekeeper.start_ticker();
        housekeeper
    }

    pub fn policy(&self) -> &RetentionPolicy {
        &self.policy
    }

    fn start_ticker(self: &Arc<Self>) {
        if self.policy.interval.is_zero() {
            return;
        }
        let weak = Arc::downgrade(self);
        let ticker = self.ctx.every("storage.retention", self.policy.interval, move || {
            let weak = weak.clone();
            async move {
                let Some(hk) = weak.upgrade() else { return false };
                if let Err(err) = hk.run_once_async().await {
                    tracing::warn!(error = %err.message, "storage.retention pass failed");
                }
                true
            }
        });
        *self.ticker.lock() = Some(ticker);
    }

    /// Stops the periodic housekeeping ticker cleanly.
    pub async fn close_async(&self) {
        let ticker = self.ticker.lock().take();
        if let Some(ticker) = ticker {
            ticker.stop().await;
        }
    }

    /// Executes one bounded, batched retention sweep across append-only DB tables and host disk artifacts.
    pub async fn run_once_async(&self) -> Result<RetentionReport, ApiError> {
        let now_ms = self.ctx.now();
        let batch = self.policy.batch_size.max(1);
        let max_batches = self.policy.max_batches_per_tick.max(1);

        let outbox_cutoff = cutoff_ms(now_ms, self.policy.outbox_done_ttl);
        let outbox_done = prune_in_batches(batch, max_batches, |limit| async move {
            self.ctx.service.outbox.prune_done_batch(outbox_cutoff, limit).await
        })
        .await?;

        let delivery_cutoff = cutoff_ms(now_ms, self.policy.channel_delivery_ttl);
        let channel_deliveries = prune_in_batches(batch, max_batches, |limit| async move {
            self.ctx
                .service
                .channel
                .prune_settled_deliveries_batch(delivery_cutoff, limit)
                .await
                .map_err(internal)
        })
        .await?;

        let mailbox_cutoff = cutoff_ms(now_ms, self.policy.session_mailbox_ttl);
        let session_mailbox = prune_in_batches(batch, max_batches, |limit| async move {
            self.ctx
                .service
                .session
                .prune_settled_mailbox_batch(mailbox_cutoff, limit)
                .await
                .map_err(internal)
        })
        .await?;

        let note_changes = if self.policy.note_changes_keep_per_note > 0 {
            let keep = self.policy.note_changes_keep_per_note;
            prune_in_batches(batch, max_batches, |limit| async move {
                self.ctx.service.note.prune_excess_note_changes_batch(keep, limit).await.map_err(internal)
            })
            .await?
        } else {
            0
        };

        let session_events_cutoff = cutoff_ms(now_ms, self.policy.departed_session_events_ttl);
        let departed_session_events = prune_in_batches(batch, max_batches, |limit| async move {
            self.ctx
                .service
                .session
                .prune_departed_events_batch(session_events_cutoff, limit)
                .await
                .map_err(internal)
        })
        .await?;

        let (debug_bundles_removed, debug_bundles_bytes) = prune_debug_bundles_async(&self.home, self.policy.debug_bundles_keep).await?;
        let (records_removed, records_bytes) = prune_records_async(&self.home, now_ms, self.policy.records_ttl, self.policy.records_max_bytes).await?;

        let report = RetentionReport {
            outbox_done,
            channel_deliveries,
            session_mailbox,
            note_changes,
            departed_session_events,
            debug_bundles_removed,
            debug_bundles_bytes,
            records_removed,
            records_bytes,
        };
        if report.total_removed() > 0 {
            tracing::info!(
                outbox_done = report.outbox_done,
                channel_deliveries = report.channel_deliveries,
                session_mailbox = report.session_mailbox,
                note_changes = report.note_changes,
                departed_session_events = report.departed_session_events,
                debug_bundles_removed = report.debug_bundles_removed,
                records_removed = report.records_removed,
                "storage.retention pass pruned stale entries"
            );
        }
        Ok(report)
    }

    /// Scans for unreferenced attachments older than `policy.orphan_attachment_grace`.
    ///
    /// When `dry_run` is `true`, no blobs or database rows are deleted and the returned
    /// report lists every candidate that would be reclaimed.
    pub async fn gc_orphan_attachments_async(&self, dry_run: bool) -> Result<OrphanAttachmentReport, ApiError> {
        let cutoff = cutoff_ms(self.ctx.now(), self.policy.orphan_attachment_grace);

        let db_candidates = self.ctx.service.storage.list_attachments_older_than(cutoff).await.map_err(internal)?;
        let all_db_ids = self.ctx.service.storage.list_all_attachment_ids().await.map_err(internal)?;
        let mut referenced = self.ctx.service.storage.list_referenced_attachment_ids().await.map_err(internal)?;
        let note_refs = collect_note_attachment_refs_async(&self.backend).await?;
        referenced.extend(note_refs);

        let mut candidates = Vec::new();
        let mut seen_ids = HashSet::new();
        let mut db_orphan_ids = Vec::new();

        for (id, size, _created_at) in db_candidates {
            if referenced.contains(&id) {
                continue;
            }
            seen_ids.insert(id.clone());
            db_orphan_ids.push(id.clone());
            candidates.push(OrphanAttachmentCandidate {
                id,
                size: size.max(0) as u64,
                unindexed_blob: false,
            });
        }

        let mut active_blob_keys: HashSet<String> = all_db_ids.iter().chain(referenced.iter()).map(|id| format!("attachments/{id}")).collect();
        for id in &seen_ids {
            active_blob_keys.insert(format!("attachments/{id}"));
        }
        let unindexed_scan = OrphanSweeper::sweep_prefix(self.backend.as_ref(), "attachments/", &active_blob_keys, cutoff, true, |meta| {
            meta.key
                .strip_prefix("attachments/")
                .is_some_and(|name| !name.contains('/') && is_sha256_hex(name))
        })
        .await
        .map_err(internal)?;
        for orphan in unindexed_scan.candidates {
            if let Some(name) = orphan.key.strip_prefix("attachments/") {
                seen_ids.insert(name.to_owned());
                candidates.push(OrphanAttachmentCandidate {
                    id: name.to_owned(),
                    size: orphan.size,
                    unindexed_blob: true,
                });
            }
        }

        let total_bytes: u64 = candidates.iter().map(|c| c.size).sum();
        if dry_run || candidates.is_empty() {
            return Ok(OrphanAttachmentReport {
                dry_run,
                candidates,
                total_bytes,
                removed_count: 0,
                removed_bytes: 0,
            });
        }

        let mut removed_count = 0u64;
        let mut removed_bytes = 0u64;
        let mut db_ids_to_delete = Vec::new();

        for candidate in &candidates {
            let key = format!("attachments/{}", candidate.id);
            match self.backend.delete(&key).await {
                Ok(_) => {
                    // Best-effort eviction of any local read-through cache copy for remote/memory backends.
                    if self.backend.local_path(&key).is_none() {
                        let _ = tokio::fs::remove_file(self.attachment.path_of(&candidate.id)).await;
                    }
                    removed_count += 1;
                    removed_bytes = removed_bytes.saturating_add(candidate.size);
                    if !candidate.unindexed_blob {
                        db_ids_to_delete.push(candidate.id.clone());
                    }
                }
                Err(err) => {
                    tracing::warn!(attachment_id = %candidate.id, error = %err, "storage.orphan_gc failed to delete blob");
                }
            }
        }

        if !db_ids_to_delete.is_empty() {
            self.ctx.service.storage.delete_attachments_batch(&db_ids_to_delete).await.map_err(internal)?;
        }

        if removed_count > 0 {
            tracing::info!(removed_count, removed_bytes, "storage.orphan_gc reclaimed unreferenced attachments");
        }

        Ok(OrphanAttachmentReport {
            dry_run: false,
            candidates,
            total_bytes,
            removed_count,
            removed_bytes,
        })
    }
}

fn cutoff_ms(now_ms: i64, ttl: Duration) -> i64 {
    let ttl_ms = ttl.as_millis().min(i64::MAX as u128) as i64;
    now_ms.saturating_sub(ttl_ms)
}

async fn prune_in_batches<F, Fut>(batch_size: u64, max_batches: usize, mut step: F) -> Result<u64, ApiError>
where
    F: FnMut(u64) -> Fut,
    Fut: std::future::Future<Output = Result<u64, ApiError>>,
{
    let mut total = 0u64;
    for _ in 0..max_batches {
        let deleted = step(batch_size).await?;
        total = total.saturating_add(deleted);
        if deleted < batch_size {
            break;
        }
        tokio::task::yield_now().await;
    }
    Ok(total)
}

#[derive(Debug)]
struct DiskEntry {
    path: PathBuf,
    name: String,
    size: u64,
    modified_ms: i64,
}

fn system_time_ms(res: std::io::Result<SystemTime>) -> i64 {
    res.ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

async fn list_flat_files_async(dir: &Path, suffix: &str) -> Result<Vec<DiskEntry>, ApiError> {
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(internal(format!("read_dir {}: {e}", dir.display()))),
    };
    let mut entries = Vec::new();
    while let Some(entry) = rd.next_entry().await.map_err(internal)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(suffix) {
            continue;
        }
        let Ok(ft) = entry.file_type().await else {
            continue;
        };
        if !ft.is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        entries.push(DiskEntry {
            path: entry.path(),
            name,
            size: meta.len(),
            modified_ms: system_time_ms(meta.modified()),
        });
    }
    Ok(entries)
}

async fn prune_debug_bundles_async(home: &Path, keep: usize) -> Result<(u64, u64), ApiError> {
    let dir = home.join("debug-bundles");
    let mut entries = list_flat_files_async(&dir, ".zip").await?;
    if entries.len() <= keep {
        return Ok((0, 0));
    }
    // Newest first (tie-break by lexicographical filename descending, which encodes timestamp).
    entries.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.name.cmp(&a.name)));
    let mut removed = 0u64;
    let mut bytes = 0u64;
    for entry in entries.into_iter().skip(keep) {
        if tokio::fs::remove_file(&entry.path).await.is_ok() {
            removed += 1;
            bytes = bytes.saturating_add(entry.size);
        }
    }
    Ok((removed, bytes))
}

async fn prune_records_async(home: &Path, now_ms: i64, ttl: Duration, max_bytes: u64) -> Result<(u64, u64), ApiError> {
    let dir = home.join("records");
    let entries = list_flat_files_async(&dir, ".jsonl").await?;
    if entries.is_empty() {
        return Ok((0, 0));
    }
    let cutoff = cutoff_ms(now_ms, ttl);
    let mut removed = 0u64;
    let mut bytes_removed = 0u64;
    let mut survivors = Vec::new();
    let mut total_bytes = 0u64;

    for entry in entries {
        if entry.modified_ms < cutoff {
            if tokio::fs::remove_file(&entry.path).await.is_ok() {
                removed += 1;
                bytes_removed = bytes_removed.saturating_add(entry.size);
            }
        } else {
            total_bytes = total_bytes.saturating_add(entry.size);
            survivors.push(entry);
        }
    }

    if total_bytes > max_bytes {
        // Evict oldest survivors first until total size fits within `max_bytes`.
        survivors.sort_by(|a, b| a.modified_ms.cmp(&b.modified_ms).then_with(|| a.name.cmp(&b.name)));
        for entry in survivors {
            if total_bytes <= max_bytes {
                break;
            }
            if tokio::fs::remove_file(&entry.path).await.is_ok() {
                removed += 1;
                bytes_removed = bytes_removed.saturating_add(entry.size);
                total_bytes = total_bytes.saturating_sub(entry.size);
            }
        }
    }

    Ok((removed, bytes_removed))
}

const NOTE_SCAN_MAX_BYTES: u64 = 4 * MIB;

async fn collect_note_attachment_refs_async(backend: &Arc<dyn StorageBackend>) -> Result<HashSet<String>, ApiError> {
    let mut refs = HashSet::new();
    let objects = backend.list("note/").await.map_err(internal)?;
    for meta in objects {
        if meta.size == 0 || meta.size > NOTE_SCAN_MAX_BYTES {
            continue;
        }
        let is_text =
            meta.key.ends_with(".json") || meta.key.ends_with(".md") || meta.key.ends_with(".html") || meta.key.ends_with(".txt") || meta.key.ends_with(".csv");
        if !is_text {
            continue;
        }
        if let Ok(Some(bytes)) = backend.get(&meta.key).await
            && let Ok(text) = std::str::from_utf8(&bytes)
        {
            extract_sha256_tokens(text, &mut refs);
        }
    }
    Ok(refs)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use vibevalley_core::{ManualClock, SliceMask};
    use vibevalley_protocol::{Attachment, Issue, MediaInputKind, MediaInputRequest};

    use super::*;
    use crate::context::{Context, LiveState, Outbox, StateFeed, TaskGroup};
    use crate::service::Service;
    use crate::storage::Storage;

    async fn open_test_ctx(home: &Path, clock: Arc<ManualClock>) -> Arc<Context> {
        let service = Service::open(home).await.unwrap();
        let task = TaskGroup::new();
        let live = Arc::new(LiveState::new());
        let outbox = Arc::new(Outbox::new(service.clone()).with_clock(clock.clone()));
        let feed = Arc::new(StateFeed::new());
        let http = Arc::new(crate::context::Http);
        Arc::new(Context::new(service, task, live, outbox, feed, clock, http.clone(), http))
    }

    #[test]
    fn extract_sha256_tokens_matches_only_64_lower_hex_ids() {
        let valid = "a".repeat(64);
        let too_short = "b".repeat(63);
        let too_long = "c".repeat(65);
        let upper = "A".repeat(64);
        let text = format!("![img](/api/v1/attachment/{valid}) short={too_short} long={too_long} upper={upper}");
        let mut out = HashSet::new();
        extract_sha256_tokens(&text, &mut out);
        assert_eq!(out, HashSet::from([valid]));
    }

    #[tokio::test]
    async fn prune_debug_bundles_keeps_newest_n_zip_files() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = dir.path().join("debug-bundles");
        tokio::fs::create_dir_all(&bundles).await.unwrap();

        for i in 1..=5 {
            tokio::fs::write(bundles.join(format!("debug-bundle-2026-01-0{i}.zip")), vec![b'z'; 100])
                .await
                .unwrap();
        }
        // Non-zip file should be left untouched.
        tokio::fs::write(bundles.join("README.txt"), b"keep").await.unwrap();

        let (removed, bytes) = prune_debug_bundles_async(dir.path(), 2).await.unwrap();
        assert_eq!(removed, 3);
        assert_eq!(bytes, 300);
        assert!(bundles.join("README.txt").exists());
        assert!(bundles.join("debug-bundle-2026-01-05.zip").exists());
        assert!(bundles.join("debug-bundle-2026-01-04.zip").exists());
        assert!(!bundles.join("debug-bundle-2026-01-01.zip").exists());
    }

    #[tokio::test]
    async fn prune_records_enforces_ttl_and_byte_quota() {
        let dir = tempfile::tempdir().unwrap();
        let records = dir.path().join("records");
        tokio::fs::create_dir_all(&records).await.unwrap();

        for i in 1..=4 {
            tokio::fs::write(records.join(format!("rec-0{i}.jsonl")), vec![b'x'; 500]).await.unwrap();
        }
        // With `now_ms` set far in the future of file mtimes and a 1-day TTL, all 4 files expire by TTL.
        let far_future = system_time_ms(Ok(SystemTime::now())) + 10 * 86_400_000;
        let (removed_ttl, bytes_ttl) = prune_records_async(dir.path(), far_future, Duration::from_secs(86_400), 10_000).await.unwrap();
        assert_eq!(removed_ttl, 4);
        assert_eq!(bytes_ttl, 2_000);

        // Recreate 4 fresh files (500 bytes each = 2000 bytes) and enforce 1100-byte quota -> evicts 2 oldest.
        for i in 1..=4 {
            tokio::fs::write(records.join(format!("fresh-0{i}.jsonl")), vec![b'y'; 500]).await.unwrap();
        }
        let now = system_time_ms(Ok(SystemTime::now()));
        let (removed_quota, bytes_quota) = prune_records_async(dir.path(), now, Duration::from_secs(7 * 86_400), 1_100).await.unwrap();
        assert_eq!(removed_quota, 2);
        assert_eq!(bytes_quota, 1_000);
        assert!(records.join("fresh-04.jsonl").exists());
        assert!(records.join("fresh-03.jsonl").exists());
    }

    #[tokio::test]
    async fn housekeeper_prunes_append_tables_in_batches_and_runs_periodically_on_manual_clock() {
        let dir = tempfile::tempdir().unwrap();
        let base_ms: i64 = 1_700_000_000_000;
        let clock = Arc::new(ManualClock::new(base_ms));
        let ctx = open_test_ctx(dir.path(), clock.clone()).await;

        let policy = RetentionPolicy {
            interval: Duration::from_millis(20),
            batch_size: 2,
            max_batches_per_tick: 10,
            outbox_done_ttl: Duration::from_secs(7 * DAY_SECS),
            channel_delivery_ttl: Duration::from_secs(30 * DAY_SECS),
            session_mailbox_ttl: Duration::from_secs(30 * DAY_SECS),
            note_changes_keep_per_note: 256,
            departed_session_events_ttl: Duration::from_secs(14 * DAY_SECS),
            debug_bundles_keep: 2,
            records_ttl: Duration::from_secs(14 * DAY_SECS),
            records_max_bytes: 10 * MIB,
            orphan_attachment_grace: Duration::from_secs(24 * HOUR_SECS),
        };

        // Seed 5 done outbox rows (exceeding batch_size = 2), 1 pending, and 1 failed at `base_ms`.
        for i in 0..5 {
            let id = ctx.service.outbox.enqueue("test.done", &format!(r#"{{"i":{i}}}"#), base_ms).await.unwrap();
            ctx.service.outbox.complete(id).await.unwrap();
        }
        let pending_id = ctx.service.outbox.enqueue("test.pending", r#"{"p":1}"#, base_ms).await.unwrap();
        let failed_id = ctx.service.outbox.enqueue("test.failed", r#"{"f":1}"#, base_ms).await.unwrap();
        ctx.service.outbox.fail(failed_id, "boom").await.unwrap();

        let backend: Arc<dyn StorageBackend> = Arc::new(crate::storage::LocalFsBackend::new(dir.path()));
        let attachment = AttachmentStorage::open_with_backend(dir.path(), backend.clone(), ctx.clone());
        let housekeeper = Housekeeper::open_and_start(dir.path(), backend, attachment, ctx.clone(), policy);

        // Before TTL expires, nothing is pruned.
        clock.set(base_ms + 3 * (DAY_SECS as i64) * 1000);
        let early = housekeeper.run_once_async().await.unwrap();
        assert_eq!(early.outbox_done, 0);

        // Advance ManualClock past 7-day outbox TTL and wait for the periodic ticker to drain all 5 done rows in batches of 2.
        clock.set(base_ms + 8 * (DAY_SECS as i64) * 1000);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if ctx.service.outbox.list().await.unwrap().len() == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("periodic housekeeper should prune expired done rows");

        // Verify a follow-up manual pass sees 0 remaining expired done rows and pending/failed survive intact.
        let after = housekeeper.run_once_async().await.unwrap();
        assert_eq!(after.outbox_done, 0);
        assert_eq!(ctx.service.outbox.count_failed().await.unwrap(), 1);
        let remaining = ctx.service.outbox.list().await.unwrap();
        let remaining_ids: Vec<i64> = remaining.iter().map(|r| r.id).collect();
        assert_eq!(remaining_ids, vec![pending_id, failed_id]);

        housekeeper.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }

    #[tokio::test]
    async fn orphan_attachment_gc_honors_grace_period_references_and_dry_run() {
        let dir = tempfile::tempdir().unwrap();
        let t0: i64 = 1_700_000_000_000;
        let clock = Arc::new(ManualClock::new(t0));
        let ctx = open_test_ctx(dir.path(), clock.clone()).await;

        let policy = RetentionPolicy {
            interval: Duration::ZERO,
            orphan_attachment_grace: Duration::from_secs(24 * HOUR_SECS),
            ..Default::default()
        };
        let storage = Storage::open_with_backend_and_policy_async(dir.path(), Arc::new(crate::storage::LocalFsBackend::new(dir.path())), ctx.clone(), policy)
            .await
            .unwrap();

        // 1. Old unreferenced attachment (should be reclaimed after grace period).
        let old_orphan = storage
            .keep_async(b"old-orphan-bytes".to_vec(), "orphan.bin".into(), "application/octet-stream".into())
            .await
            .unwrap();
        // 2. Old attachment referenced by an Issue (must be protected).
        let issue_ref = storage
            .keep_async(b"issue-ref-bytes".to_vec(), "issue.png".into(), "image/png".into())
            .await
            .unwrap();
        // 3. Old attachment referenced inside a Note file (must be protected).
        let note_ref = storage
            .keep_async(b"note-ref-bytes".to_vec(), "note.png".into(), "image/png".into())
            .await
            .unwrap();
        storage
            .backend
            .put(
                "note/n1/structure/main.md",
                format!("Embedded ![pic](/api/v1/attachment/{})", note_ref.id).into_bytes(),
                Some("text/markdown"),
            )
            .await
            .unwrap();
        // 4. Old attachment referenced by an active media_input hash (must be protected).
        let media_ref = storage
            .keep_async(b"media-ref-bytes".to_vec(), "clip.mp4".into(), "video/mp4".into())
            .await
            .unwrap();
        let _ = ctx
            .service
            .storage
            .reserve_media_input(
                "mi-1",
                &MediaInputRequest {
                    kind: MediaInputKind::Video,
                    name: "clip.mp4".into(),
                    mime: "video/mp4".into(),
                    size: media_ref.size,
                },
                t0,
                t0 + 100_000_000,
                256,
                1024 * 1024,
            )
            .await
            .unwrap();
        ctx.service.storage.set_media_input_hash("mi-1", &media_ref.id).await.unwrap();
        ctx.service.storage.mark_media_input_ready("mi-1", t0 + 100_000_000).await.unwrap();

        // Attach `issue_ref` to an Issue row.
        let mut issue = Issue::new("iss-1", 1, "Keep attachment", t0);
        issue.attachments = vec![Attachment {
            id: issue_ref.id.clone(),
            name: issue_ref.name.clone(),
            r#type: issue_ref.r#type.clone(),
            size: issue_ref.size,
        }];
        let ctx_issue = ctx.clone();
        ctx.service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    ctx_issue.service.issue.put_in_tx(tx, &issue).await.map_err(internal)?;
                    Ok::<_, ApiError>(((), SliceMask::BOARD))
                })
            })
            .await
            .unwrap();

        // Advance clock by 25 hours so `old_orphan` is past grace, then upload a brand-new unreferenced attachment.
        clock.set(t0 + 25 * (HOUR_SECS as i64) * 1000);
        let fresh_orphan = storage
            .keep_async(b"fresh-orphan-bytes".to_vec(), "fresh.bin".into(), "application/octet-stream".into())
            .await
            .unwrap();

        // Dry-run preview: identifies ONLY `old_orphan` and deletes nothing.
        let preview = storage.gc_orphan_attachments_async(true).await.unwrap();
        assert!(preview.dry_run);
        assert_eq!(preview.removed_count, 0);
        assert_eq!(preview.candidates.len(), 1);
        assert_eq!(preview.candidates[0].id, old_orphan.id);
        assert!(storage.attachment.exists_blob_async(&old_orphan.id).await);

        // Actual GC run: removes `old_orphan`, preserves `fresh_orphan`, `issue_ref`, `note_ref`, and `media_ref`.
        let report = storage.gc_orphan_attachments_async(false).await.unwrap();
        assert!(!report.dry_run);
        assert_eq!(report.removed_count, 1);
        assert_eq!(report.removed_bytes, old_orphan.size as u64);
        assert!(!storage.attachment.exists_blob_async(&old_orphan.id).await);
        assert!(storage.by_id_async(&old_orphan.id).await.unwrap().is_none());

        for protected in [&fresh_orphan.id, &issue_ref.id, &note_ref.id, &media_ref.id] {
            assert!(storage.attachment.exists_blob_async(protected).await, "expected {protected} to survive GC");
            assert!(storage.by_id_async(protected).await.unwrap().is_some());
        }

        // Also test unindexed dangling blob on disk (not in `attachment` table) once past grace window.
        let dangling_id = "d".repeat(64);
        storage
            .backend
            .put(&format!("attachments/{dangling_id}"), b"dangling-blob".to_vec(), None)
            .await
            .unwrap();
        // Set clock far past file mtime + 24h grace.
        clock.set(system_time_ms(Ok(SystemTime::now())) + 48 * (HOUR_SECS as i64) * 1000);
        let preview_dangling = storage.gc_orphan_attachments_async(true).await.unwrap();
        assert!(preview_dangling.candidates.iter().any(|c| c.id == dangling_id && c.unindexed_blob));
        let cleaned_dangling = storage.gc_orphan_attachments_async(false).await.unwrap();
        assert!(cleaned_dangling.removed_count >= 1);
        assert!(!storage.attachment.exists_blob_async(&dangling_id).await);

        storage.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }

    #[tokio::test]
    async fn housekeeper_prunes_channel_deliveries_session_mailbox_note_changes_and_departed_events() {
        use vibevalley_protocol::{ExecutionPolicy, PublishPlatform, PullRequestState, Session, SessionController, SessionEvent, SessionEventType};

        use crate::service::channel::{NewDelivery, NewMessage};
        use crate::service::issue::UpsertPullInput;
        use crate::service::note::NewNote;
        use crate::service::session::MailboxSource;

        let dir = tempfile::tempdir().unwrap();
        let t0: i64 = 1_700_000_000_000;
        let clock = Arc::new(ManualClock::new(t0));
        let ctx = open_test_ctx(dir.path(), clock.clone()).await;

        let policy = RetentionPolicy {
            interval: Duration::ZERO,
            batch_size: 2,
            max_batches_per_tick: 10,
            channel_delivery_ttl: Duration::from_secs(30 * DAY_SECS),
            session_mailbox_ttl: Duration::from_secs(30 * DAY_SECS),
            note_changes_keep_per_note: 2,
            departed_session_events_ttl: Duration::from_secs(14 * DAY_SECS),
            ..Default::default()
        };
        let storage = Storage::open_with_backend_and_policy_async(dir.path(), Arc::new(crate::storage::LocalFsBackend::new(dir.path())), ctx.clone(), policy)
            .await
            .unwrap();

        // 1. Seed participants + channel + messages + 3 settled + 1 pending channel_delivery rows.
        ctx.service.channel.add_participant("user", "user", "User", t0).await.unwrap();
        ctx.service.channel.add_participant("laozhou", "agent", "Laozhou", t0).await.unwrap();
        ctx.service.channel.create_channel("ch-1", false, "general", None, None, t0).await.unwrap();
        let ctx_c = ctx.clone();
        let delivery_ids: Vec<i64> = ctx
            .service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    let mut ids = Vec::new();
                    for i in 0..4 {
                        let msg_id = format!("msg-{i}");
                        ctx_c
                            .service
                            .channel
                            .insert_message_in_tx(
                                tx,
                                &NewMessage {
                                    id: &msg_id,
                                    channel_id: "ch-1",
                                    sender: "user",
                                    kind: vibevalley_protocol::MessageKind::Chat.as_str(),
                                    body: "hello",
                                    meta: None,
                                    system_code: None,
                                    send_key: None,
                                    at: t0,
                                    revision: (i + 1) as i64,
                                    reply_number: None,
                                },
                            )
                            .await
                            .map_err(internal)?;
                        let id = ctx_c
                            .service
                            .channel
                            .insert_delivery_in_tx(
                                tx,
                                &NewDelivery {
                                    message_id: &msg_id,
                                    channel_id: "ch-1",
                                    recipient_kind: "agent",
                                    recipient_id: "laozhou",
                                    reason: "mention",
                                    wakes: true,
                                    held_by: None,
                                    at: t0,
                                },
                            )
                            .await
                            .map_err(internal)?;
                        ids.push(id);
                    }
                    Ok::<_, ApiError>((ids, SliceMask::NONE))
                })
            })
            .await
            .unwrap()
            .0;
        for &id in &delivery_ids[0..3] {
            ctx.service.channel.settle_delivery(id, "delivered", t0).await.unwrap();
        }

        // 2. Seed 3 settled + 1 pending session_mailbox rows.
        for i in 0..3 {
            let entry = ctx
                .service
                .session
                .enqueue_mailbox("sess-1", &format!("k-done-{i}"), MailboxSource::ChannelDirect, None, "hi", t0)
                .await
                .unwrap();
            ctx.service.session.settle_mailbox(entry.id, true, Some("ok"), t0).await.unwrap();
        }
        let pending_mb = ctx
            .service
            .session
            .enqueue_mailbox("sess-1", "k-pending", MailboxSource::ChannelDirect, None, "stay", t0)
            .await
            .unwrap();

        // 3. Seed 5 note_change rows for note-1 (keep_per_note = 2 -> prune oldest 3), plus an expired departed session
        //    with 3 events and an active session with 2 events.
        let ctx_n = ctx.clone();
        ctx.service
            .write_dirty(move |tx| {
                Box::pin(async move {
                    ctx_n
                        .service
                        .note
                        .add_in_tx(
                            tx,
                            NewNote {
                                id: "note-ret".into(),
                                title: "Ret Note".into(),
                                note_type: "doc".into(),
                                parent_id: None,
                                sort_order: 0,
                                channel_id: None,
                                issue: None,
                                by_id: "user".into(),
                                by_name: "User".into(),
                                version: 1,
                                created_at: t0,
                            },
                        )
                        .await
                        .map_err(internal)?;
                    for seq in 1..=5 {
                        ctx_n
                            .service
                            .note
                            .add_file_change_in_tx(tx, "note-ret", seq, "user", None, &["structure/main.md".into()], &[], t0 + seq)
                            .await
                            .map_err(internal)?;
                    }
                    Ok::<_, ApiError>(((), SliceMask::NONE))
                })
            })
            .await
            .unwrap();

        let make_session = |id: &str| Session::new(id, SessionController::IssueBoard, id, "scripted", ExecutionPolicy::SandboxDir, t0);
        let make_ev = |seq: i64| SessionEvent {
            seq,
            revision: 1,
            time: t0 + seq,
            r#type: SessionEventType::AssistantMessage,
            run: None,
            call: None,
            under: None,
            thread_id: None,
            text: format!("ev-{seq}"),
            action: None,
            action_text: None,
            tool: None,
            input: None,
            output: None,
            ok: None,
            tokens: None,
            connection: None,
            permission: None,
            interaction: None,
            interaction_resolution: None,
        };
        ctx.service.session.put(&make_session("sess-departed"), true).await.unwrap();
        ctx.service.session.put(&make_session("sess-active"), false).await.unwrap();
        ctx.service
            .session
            .upsert_events_batch(&[
                ("sess-departed".into(), vec![make_ev(1), make_ev(2), make_ev(3)]),
                ("sess-active".into(), vec![make_ev(1), make_ev(2)]),
            ])
            .await
            .unwrap();

        // 4. Verify known_events are automatically cleared when a pull transitions to Merged.
        let open_pull = ctx
            .service
            .issue
            .upsert_pull(UpsertPullInput {
                platform: PublishPlatform::Github,
                repo: "vibevalley".into(),
                number: 2,
                url: "https://example.test/pr/2".into(),
                branch: "feat/b".into(),
                base: "main".into(),
                state: PullRequestState::Open,
                issue_id: None,
                at: t0,
            })
            .await
            .unwrap();
        ctx.service.issue.keep_pull_event(&open_pull.id, "ev-open", None, None).await.unwrap();
        assert_eq!(ctx.service.issue.known_pull_events(&open_pull.id).await.unwrap().len(), 1);

        // Advance ManualClock by 31 days -> expired deliveries, mailboxes, excess note_changes, and departed session events prune cleanly.
        clock.set(t0 + 31 * (DAY_SECS as i64) * 1000);
        let report = storage.run_housekeeping_async().await.unwrap();
        assert_eq!(report.channel_deliveries, 3);
        assert_eq!(report.session_mailbox, 3);
        assert_eq!(report.note_changes, 3);
        assert_eq!(report.departed_session_events, 3);

        assert!(ctx.service.channel.delivery_is_pending(delivery_ids[3]).await.unwrap());
        let mb_left = ctx.service.session.list_mailbox("sess-1").await.unwrap();
        assert_eq!(mb_left.len(), 1);
        assert_eq!(mb_left[0].id, pending_mb.id);
        let kept_changes = ctx.service.note.file_changes_after("note-ret", 0, 10).await.unwrap();
        let kept_seqs: Vec<i64> = kept_changes.into_iter().map(|c| c.seq).collect();
        assert_eq!(kept_seqs, vec![4, 5]);
        assert!(ctx.service.session.list_events_after("sess-departed", "", 0, 10).await.unwrap().is_empty());
        assert_eq!(ctx.service.session.list_events_after("sess-active", "", 0, 10).await.unwrap().len(), 2);

        ctx.service.issue.set_pull_state(&open_pull.id, PullRequestState::Merged, t0 + 1).await.unwrap();
        assert!(ctx.service.issue.known_pull_events(&open_pull.id).await.unwrap().is_empty());

        storage.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }

    #[tokio::test]
    async fn debug_snapshot_exposes_outbox_dead_letters_and_debug_kit_replays() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = vibevalley_runtime::oar::Registry::new();
        registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
        let app = crate::create_app(crate::Config {
            registry: Some(Arc::new(registry)),
            probe_runtimes: false,
            orchestrator_listens: false,
            link_previews: false,
            tick_crons: false,
            debug_enabled: true,
            ..crate::Config::under(dir.path())
        })
        .await
        .expect("server starts");

        let internals = app.test_internals();
        let dead_id = internals.service.outbox.enqueue("debug.test.dlq", r#"{"x":1}"#, 1_000).await.unwrap();
        internals.service.outbox.fail(dead_id, "forced dlq error").await.unwrap();

        let snap = internals.debug.snapshot_async().await.unwrap();
        let dlq_stat = snap
            .state_cache
            .caches
            .iter()
            .find(|c| c.name == "outbox.failed")
            .expect("debug.snapshot must include outbox.failed metric");
        assert_eq!(dlq_stat.entries, 1);

        let failed = internals.debug.outbox_failed_list_async(10).await.unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].id, dead_id);
        assert_eq!(failed[0].last_error.as_deref(), Some("forced dlq error"));

        internals.ctx.outbox.register("debug.test.dlq", |_| async move { Ok::<(), String>(()) });
        let replayed = internals.debug.outbox_replay_async(Some(dead_id)).await.unwrap();
        assert_eq!(replayed, 1);
        assert_eq!(internals.ctx.outbox.failed_count_async().await.unwrap(), 0);

        app.close().await;
    }
}
