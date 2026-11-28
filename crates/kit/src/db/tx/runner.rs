//! Generic transaction execution helper enforcing commit-only [`PostCommitHooks`] delivery.

use std::future::Future;

use super::hook::PostCommitHooks;
use crate::core::DirtyMask;

/// Executes an async transaction lifecycle `(begin, body, commit / rollback)` with an
/// attached [`PostCommitHooks`] collector.
///
/// Guarantees:
/// - If `body` returns `Ok(val)` AND `commit` returns `Ok(())`, every registered `on_commit`
///   hook runs in FIFO order and `Ok((val, dirty_mask))` is returned.
/// - If `body` returns `Err(err)`, `rollback` is awaited and hooks are dropped without firing.
/// - If `commit` returns `Err(err)`, hooks are dropped without firing and `Err(err)` is returned.
pub async fn run_with_hooks<Tx, T, E, BeginFut, CommitFut, RollbackFut>(
    begin: impl FnOnce() -> BeginFut,
    commit: impl FnOnce(Tx) -> CommitFut,
    rollback: impl FnOnce(Tx) -> RollbackFut,
    body: impl AsyncFnOnce(&mut Tx, &mut PostCommitHooks) -> Result<T, E>,
) -> Result<(T, DirtyMask), E>
where
    BeginFut: Future<Output = Result<Tx, E>>,
    CommitFut: Future<Output = Result<(), E>>,
    RollbackFut: Future<Output = Result<(), E>>,
{
    let mut tx = begin().await?;
    let mut hooks = PostCommitHooks::new();
    match body(&mut tx, &mut hooks).await {
        Ok(value) => {
            if let Err(err) = commit(tx).await {
                hooks.discard();
                return Err(err);
            }
            let dirty = hooks.fire();
            Ok((value, dirty))
        }
        Err(err) => {
            hooks.discard();
            let _ = rollback(tx).await;
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use parking_lot::Mutex;

    use super::*;

    #[tokio::test]
    async fn hooks_fire_in_fifo_order_and_return_dirty_mask_only_after_commit() {
        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let committed = Arc::new(AtomicBool::new(false));
        let rolled_back = Arc::new(AtomicBool::new(false));

        let log_commit = log.clone();
        let committed_c = committed.clone();
        let rolled_c = rolled_back.clone();
        let log_body = log.clone();

        let (val, dirty) = run_with_hooks(
            || async { Ok::<_, &'static str>(()) },
            move |()| async move {
                committed_c.store(true, Ordering::SeqCst);
                log_commit.lock().push("commit");
                Ok(())
            },
            move |()| async move {
                rolled_c.store(true, Ordering::SeqCst);
                Ok(())
            },
            async move |_tx, hooks| {
                hooks.mark_dirty(DirtyMask::bit(0));
                hooks.mark_dirty(DirtyMask::bit(2));
                let l1 = log_body.clone();
                hooks.on_commit(move || l1.lock().push("hook-1"));
                let l2 = log_body.clone();
                hooks.on_commit(move || l2.lock().push("hook-2"));
                Ok(99usize)
            },
        )
        .await
        .unwrap();

        assert_eq!(val, 99);
        assert_eq!(dirty, DirtyMask::bit(0) | DirtyMask::bit(2));
        assert!(committed.load(Ordering::SeqCst));
        assert!(!rolled_back.load(Ordering::SeqCst));
        assert_eq!(*log.lock(), vec!["commit", "hook-1", "hook-2"]);
    }

    #[tokio::test]
    async fn hooks_are_dropped_without_firing_on_body_error_or_commit_failure() {
        let fired = Arc::new(AtomicBool::new(false));
        let rolled_back = Arc::new(AtomicBool::new(false));

        let fired_c = fired.clone();
        let rolled_c = rolled_back.clone();
        let err = run_with_hooks(
            || async { Ok::<_, &'static str>(()) },
            |()| async { Ok(()) },
            move |()| async move {
                rolled_c.store(true, Ordering::SeqCst);
                Ok(())
            },
            async move |_tx, hooks| {
                hooks.mark_dirty(DirtyMask::bit(1));
                hooks.on_commit(move || {
                    fired_c.store(true, Ordering::SeqCst);
                });
                Err::<(), _>("boom")
            },
        )
        .await
        .unwrap_err();

        assert_eq!(err, "boom");
        assert!(rolled_back.load(Ordering::SeqCst));
        assert!(!fired.load(Ordering::SeqCst), "hook must never fire on rollback");

        // Commit failure must also suppress hooks.
        let fired2 = Arc::new(AtomicBool::new(false));
        let fired2_c = fired2.clone();
        let err2 = run_with_hooks(
            || async { Ok::<_, &'static str>(()) },
            |()| async { Err("commit failed") },
            |()| async { Ok(()) },
            async move |_tx, hooks| {
                hooks.mark_dirty(DirtyMask::bit(3));
                hooks.on_commit(move || {
                    fired2_c.store(true, Ordering::SeqCst);
                });
                Ok(123)
            },
        )
        .await
        .unwrap_err();

        assert_eq!(err2, "commit failed");
        assert!(!fired2.load(Ordering::SeqCst), "hook must never fire when commit fails");
    }
}
