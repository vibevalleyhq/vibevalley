//! Single write-ownership ("Hoe Handoff") registry for local and remote worktrees.
//!
//! Ensures at most one active writing session owns a worktree at any time and
//! cleanly commits or stashes uncommitted working-tree changes before
//! transferring write ownership to another helper.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_git::Repo;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode};

use crate::context::now;
use crate::runtime::{Result, RuntimeError};

/// Identifies a writable worktree either on disk locally or on a remote machine.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorktreeKey {
    Local(PathBuf),
    Remote { machine_id: String, repo: String, branch: String },
}

impl WorktreeKey {
    /// Builds a normalized local key using async canonical path resolution when available.
    pub async fn local_async(path: &Path) -> Self {
        Self::Local(tokio::fs::canonicalize(path).await.unwrap_or_else(|_| path.to_path_buf()))
    }

    /// Builds a remote worktree ownership key matching remote dispatch metadata.
    pub fn remote(machine_id: impl Into<String>, repo: impl Into<String>, branch: impl Into<String>) -> Self {
        Self::Remote {
            machine_id: machine_id.into(),
            repo: repo.into(),
            branch: branch.into(),
        }
    }

    /// Returns a human-readable target label for error diagnostics.
    pub fn label(&self) -> String {
        match self {
            Self::Local(path) => path.display().to_string(),
            Self::Remote { machine_id, repo, branch } => format!("{machine_id}:{repo}@{branch}"),
        }
    }
}

/// How uncommitted working-tree changes are preserved prior to transferring write ownership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffCleanup {
    Commit { message: String },
    Stash { message: String },
}

/// Active single-writer ownership lease on a worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteLease {
    pub session_id: String,
    pub agent: Option<String>,
    pub machine_id: Option<String>,
    pub branch: Option<String>,
    pub acquired_at: i64,
}

impl WriteLease {
    pub fn new(session_id: impl Into<String>, agent: Option<String>, machine_id: Option<String>, branch: Option<String>) -> Self {
        Self {
            session_id: session_id.into(),
            agent,
            machine_id,
            branch,
            acquired_at: now(),
        }
    }
}

/// Outcome returned after completing a serialized worktree write-ownership handoff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffRecord {
    pub previous_owner: Option<WriteLease>,
    pub new_owner: Option<WriteLease>,
    pub cleanup_commit: Option<String>,
    pub cleanup_stash: Option<String>,
}

/// Enforces single-writer ownership and serialized cleanup handoffs per [`WorktreeKey`].
#[derive(Default)]
pub struct HoeRegistry {
    leases: Mutex<HashMap<WorktreeKey, WriteLease>>,
    gates: Mutex<HashMap<WorktreeKey, Arc<AsyncMutex<()>>>>,
}

impl HoeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn gate(&self, key: &WorktreeKey) -> Arc<AsyncMutex<()>> {
        self.gates.lock().entry(key.clone()).or_insert_with(|| Arc::new(AsyncMutex::new(()))).clone()
    }

    /// Returns the active write lease for `key`, if any.
    pub fn owner(&self, key: &WorktreeKey) -> Option<WriteLease> {
        self.leases.lock().get(key).cloned()
    }

    /// Returns the key and write lease held by `session_id`, if any.
    pub fn owner_for_session(&self, session_id: &str) -> Option<(WorktreeKey, WriteLease)> {
        self.leases
            .lock()
            .iter()
            .find(|(_, lease)| lease.session_id == session_id)
            .map(|(k, v)| (k.clone(), v.clone()))
    }

    /// Acquires exclusive write ownership of `key` for `lease`.
    ///
    /// Re-acquiring for the same `session_id` is idempotent. Acquiring while another
    /// session still holds the lease is refused cleanly.
    pub async fn acquire_async(&self, key: &WorktreeKey, lease: WriteLease) -> Result<()> {
        let gate = self.gate(key);
        let _guard = gate.lock().await;
        let mut leases = self.leases.lock();
        if let Some(current) = leases.get(key)
            && current.session_id != lease.session_id
        {
            return Err(refused_write_lock(key, current));
        }
        leases.insert(key.clone(), lease);
        Ok(())
    }

    /// Releases the write lease on `key` when held by `session_id`.
    pub fn release(&self, key: &WorktreeKey, session_id: &str) -> Option<WriteLease> {
        let mut leases = self.leases.lock();
        if leases.get(key).is_some_and(|l| l.session_id == session_id) {
            return leases.remove(key);
        }
        None
    }

    /// Releases whichever worktree lease is held by `session_id`.
    pub fn release_session(&self, session_id: &str) -> Option<(WorktreeKey, WriteLease)> {
        let mut leases = self.leases.lock();
        let key = leases.iter().find(|(_, l)| l.session_id == session_id).map(|(k, _)| k.clone())?;
        leases.remove(&key).map(|lease| (key, lease))
    }

    /// Cleanly commits or stashes uncommitted changes in `key` and transfers (or releases) write ownership.
    pub async fn handoff_async(
        &self,
        key: &WorktreeKey,
        expected_from: Option<&str>,
        to: Option<WriteLease>,
        cleanup: HandoffCleanup,
    ) -> Result<HandoffRecord> {
        let gate = self.gate(key);
        let _guard = gate.lock().await;

        if let Some(expected) = expected_from
            && let Some(current) = self.leases.lock().get(key).cloned()
            && current.session_id != expected
        {
            return Err(refused_write_lock(key, &current));
        }

        let (cleanup_commit, cleanup_stash) = match key {
            WorktreeKey::Local(dir) => match Repo::discover_async(dir).await? {
                Some(wt) if wt.has_uncommitted_async().await? => match cleanup {
                    HandoffCleanup::Commit { message } => (wt.commit_all_async(&message).await?, None),
                    HandoffCleanup::Stash { message } => (None, wt.stash_push_async(&message).await?),
                },
                _ => (None, None),
            },
            WorktreeKey::Remote { .. } => (None, None),
        };

        let mut leases = self.leases.lock();
        let previous_owner = leases.remove(key);
        if let Some(next) = to.clone() {
            leases.insert(key.clone(), next);
        }

        Ok(HandoffRecord {
            previous_owner,
            new_owner: to,
            cleanup_commit,
            cleanup_stash,
        })
    }
}

fn refused_write_lock(key: &WorktreeKey, holder: &WriteLease) -> RuntimeError {
    RuntimeError::Api(ApiError::new(
        BizCode::IssueRefused,
        t(
            "server.session.writeLockHeld",
            &[("holder", holder.session_id.clone().into()), ("worktree", key.label().into())],
        ),
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;

    use super::*;

    fn init_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&root).status().unwrap().success());
        fs::write(root.join("README.md"), "hello\n").unwrap();
        assert!(
            Command::new("git")
                .args(["-c", "user.name=tester", "-c", "user.email=tester@example.com", "add", "-A"])
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args(["-c", "user.name=tester", "-c", "user.email=tester@example.com", "commit", "-q", "-m", "init"])
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
        (dir, root)
    }

    #[tokio::test]
    async fn single_writer_blocks_concurrent_writer_and_allows_idempotent_reacquire() {
        vibevalley_i18n::set_locale("en");
        let (_dir, root) = init_repo();
        let key = WorktreeKey::local_async(&root).await;
        let reg = HoeRegistry::new();

        reg.acquire_async(&key, WriteLease::new("w1", Some("coder".into()), None, Some("issue-1".into())))
            .await
            .unwrap();
        reg.acquire_async(&key, WriteLease::new("w1", Some("coder".into()), None, Some("issue-1".into())))
            .await
            .unwrap();

        let err = reg
            .acquire_async(&key, WriteLease::new("w2", Some("helper".into()), None, Some("issue-1".into())))
            .await
            .unwrap_err();
        assert!(matches!(err, RuntimeError::Api(ref e) if e.biz_code == BizCode::IssueRefused));
        assert_eq!(reg.owner(&key).unwrap().session_id, "w1");

        reg.release(&key, "w1");
        assert!(reg.owner(&key).is_none());
        reg.acquire_async(&key, WriteLease::new("w2", Some("helper".into()), None, Some("issue-1".into())))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn handoff_commits_or_stashes_uncommitted_changes_before_transferring_ownership() {
        let (_dir, root) = init_repo();
        let key = WorktreeKey::local_async(&root).await;
        let reg = HoeRegistry::new();

        reg.acquire_async(&key, WriteLease::new("w1", Some("alpha".into()), None, Some("issue-2".into())))
            .await
            .unwrap();
        fs::write(root.join("wip.txt"), "from w1\n").unwrap();

        let rec = reg
            .handoff_async(
                &key,
                Some("w1"),
                Some(WriteLease::new("w2", Some("beta".into()), None, Some("issue-2".into()))),
                HandoffCleanup::Commit {
                    message: "w1: handoff wip".into(),
                },
            )
            .await
            .unwrap();
        assert!(rec.cleanup_commit.is_some());
        assert!(rec.cleanup_stash.is_none());
        assert_eq!(rec.previous_owner.unwrap().session_id, "w1");
        assert_eq!(rec.new_owner.unwrap().session_id, "w2");
        assert!(!Repo::discover_async(&root).await.unwrap().unwrap().has_uncommitted_async().await.unwrap());

        fs::write(root.join("scratch.txt"), "from w2\n").unwrap();
        let rec2 = reg
            .handoff_async(
                &key,
                Some("w2"),
                Some(WriteLease::new("w3", Some("gamma".into()), None, Some("issue-2".into()))),
                HandoffCleanup::Stash {
                    message: "w2: stash scratch".into(),
                },
            )
            .await
            .unwrap();
        assert!(rec2.cleanup_commit.is_none());
        assert!(rec2.cleanup_stash.is_some());
        assert!(!root.join("scratch.txt").exists());
        assert_eq!(reg.owner(&key).unwrap().session_id, "w3");
    }

    #[tokio::test]
    async fn handoff_handles_remote_worktree_key_cleanly() {
        let reg = HoeRegistry::new();
        let remote = WorktreeKey::remote("mac-mini", "acme/app", "issue-9");
        reg.acquire_async(
            &remote,
            WriteLease::new("w10", Some("coder".into()), Some("mac-mini".into()), Some("issue-9".into())),
        )
        .await
        .unwrap();
        let rec = reg
            .handoff_async(
                &remote,
                Some("w10"),
                Some(WriteLease::new("w11", Some("fixer".into()), Some("mac-mini".into()), Some("issue-9".into()))),
                HandoffCleanup::Commit { message: "handoff".into() },
            )
            .await
            .unwrap();
        assert_eq!(rec.previous_owner.unwrap().session_id, "w10");
        assert_eq!(rec.new_owner.unwrap().session_id, "w11");
    }
}
