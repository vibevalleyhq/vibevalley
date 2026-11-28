//! Post-commit callback queue and accumulated [`DirtyMask`] that only fire after
//! a transaction commits successfully, and drop silently on rollback or error.

use crate::core::DirtyMask;

type CommitCallback = Box<dyn FnOnce() + Send + 'static>;

/// Collects dirty bitmasks and side-effect callbacks during a database write transaction.
///
/// Side effects (e.g. `outbox.wake()`, cache invalidation, feed notifications) MUST NOT
/// run while a transaction is uncommitted or after rollback. Call [`Self::fire`] only
/// immediately after `tx.commit().await` succeeds; dropping [`PostCommitHooks`] without
/// calling [`Self::fire`] discards all queued callbacks without executing them.
#[derive(Default)]
pub struct PostCommitHooks {
    dirty: DirtyMask,
    callbacks: Vec<CommitCallback>,
}

impl std::fmt::Debug for PostCommitHooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostCommitHooks")
            .field("dirty", &self.dirty)
            .field("callbacks", &self.callbacks.len())
            .finish()
    }
}

impl PostCommitHooks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Accumulates `mask` into the transaction's dirty set.
    pub fn mark_dirty(&mut self, mask: DirtyMask) {
        self.dirty |= mask;
    }

    /// Schedules `cb` to run in FIFO order ONLY after the surrounding transaction commits.
    pub fn on_commit<F>(&mut self, cb: F)
    where
        F: FnOnce() + Send + 'static,
    {
        self.callbacks.push(Box::new(cb));
    }

    /// Returns the accumulated [`DirtyMask`] recorded so far.
    pub fn dirty_mask(&self) -> DirtyMask {
        self.dirty
    }

    /// Number of registered post-commit callbacks.
    pub fn callback_count(&self) -> usize {
        self.callbacks.len()
    }

    /// Returns `true` when no dirty bits and no callbacks have been recorded.
    pub fn is_empty(&self) -> bool {
        self.dirty.is_empty() && self.callbacks.is_empty()
    }

    /// Executes all queued callbacks in registration order and returns the accumulated [`DirtyMask`].
    ///
    /// Call this ONLY after the database transaction has committed successfully.
    pub fn fire(self) -> DirtyMask {
        let dirty = self.dirty;
        for cb in self.callbacks {
            cb();
        }
        dirty
    }

    /// Explicitly discards all queued callbacks without running them (rollback/error path).
    pub fn discard(self) {
        drop(self);
    }
}
