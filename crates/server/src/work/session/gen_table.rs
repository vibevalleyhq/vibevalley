//! Generation-stamped live session handle table for [`super::Sessions`].
//!
//! Allocates monotonic generation numbers and inserts entries under the same
//! mutex so concurrent `go_live` calls can never interleave and let an older
//! generation overwrite a newer one, and exiting pumps can never evict a newer
//! generation.

use std::collections::HashMap;

use crate::app::hub::loom_sync::Mutex;

struct Entry<V> {
    generation: u64,
    value: V,
}

struct TableInner<V> {
    next_generation: u64,
    entries: HashMap<String, Entry<V>>,
}

/// Synchronized map from session ID to generation-stamped live handle `V`.
pub(crate) struct SessionGenerationTable<V> {
    inner: Mutex<TableInner<V>>,
}

impl<V> Default for SessionGenerationTable<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> SessionGenerationTable<V> {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(TableInner {
                next_generation: 0,
                entries: HashMap::new(),
            }),
        }
    }

    /// Atomically allocates the next strictly monotonic generation and installs
    /// `value` for `id`, returning `(generation, replaced_value)`.
    pub(crate) fn install(&self, id: String, value: V) -> (u64, Option<V>) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.next_generation = guard.next_generation.checked_add(1).expect("session generation overflow");
        let generation = guard.next_generation;
        let previous = guard.entries.insert(id, Entry { generation, value }).map(|entry| entry.value);
        (generation, previous)
    }

    /// Whether `id` currently has any live entry.
    pub(crate) fn contains(&self, id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.entries.contains_key(id)
    }

    /// Whether `id` is currently installed at `generation`.
    pub(crate) fn is_current(&self, id: &str, generation: u64) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.entries.get(id).is_some_and(|entry| entry.generation == generation)
    }

    /// Invokes `f` with the handle for `id` only if `generation` is still current.
    #[allow(dead_code, reason = "part of SessionGenerationTable contract alongside get_if_current")]
    pub(crate) fn with_current<R>(&self, id: &str, generation: u64, f: impl FnOnce(&V) -> R) -> Option<R> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entries
            .get(id)
            .filter(|entry| entry.generation == generation)
            .map(|entry| f(&entry.value))
    }

    /// Removes and returns the handle for `id` only if `generation` is still current.
    pub(crate) fn remove_if_current(&self, id: &str, generation: u64) -> Option<V> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let is_match = guard.entries.get(id).is_some_and(|entry| entry.generation == generation);
        if is_match { guard.entries.remove(id).map(|entry| entry.value) } else { None }
    }

    /// Unconditionally removes and returns the current handle for `id`, if any.
    pub(crate) fn remove_any(&self, id: &str) -> Option<V> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.entries.remove(id).map(|entry| entry.value)
    }

    /// Drains and returns every live handle in the table.
    pub(crate) fn drain_all(&self) -> Vec<V> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.entries.drain().map(|(_, entry)| entry.value).collect()
    }
}

impl<V: Clone> SessionGenerationTable<V> {
    /// Clones the current handle for `id`, regardless of generation.
    pub(crate) fn get(&self, id: &str) -> Option<V> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.entries.get(id).map(|entry| entry.value.clone())
    }

    /// Clones the handle for `id` only if `generation` is still current.
    pub(crate) fn get_if_current(&self, id: &str, generation: u64) -> Option<V> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entries
            .get(id)
            .filter(|entry| entry.generation == generation)
            .map(|entry| entry.value.clone())
    }
}

#[cfg(all(test, not(feature = "loom")))]
mod tests {
    use super::SessionGenerationTable;

    #[test]
    fn install_is_monotonic_and_remove_if_current_guards_generation() {
        let table = SessionGenerationTable::<u32>::new();
        assert!(!table.contains("s1"));
        assert_eq!(table.get("s1"), None);

        let (g1, prev1) = table.install("s1".into(), 10);
        assert_eq!(g1, 1);
        assert_eq!(prev1, None);
        assert!(table.contains("s1"));
        assert!(table.is_current("s1", g1));
        assert_eq!(table.get_if_current("s1", g1), Some(10));
        assert_eq!(table.with_current("s1", g1, |v| *v + 1), Some(11));

        let (g2, prev2) = table.install("s1".into(), 20);
        assert_eq!(g2, 2);
        assert_eq!(prev2, Some(10));
        assert!(!table.is_current("s1", g1));
        assert!(table.is_current("s1", g2));
        assert_eq!(table.remove_if_current("s1", g1), None);
        assert_eq!(table.get("s1"), Some(20));

        assert_eq!(table.remove_if_current("s1", g2), Some(20));
        assert!(!table.contains("s1"));
    }
}

#[cfg(all(test, feature = "loom"))]
mod loom_models {
    use loom::thread;

    use super::SessionGenerationTable;
    use crate::app::hub::loom_sync::Arc;

    #[test]
    fn concurrent_installs_and_old_pump_exit_preserve_monotonicity_and_handles() {
        loom::model(|| {
            let table = Arc::new(SessionGenerationTable::<u32>::new());
            let (g0, prev0) = table.install("s1".into(), 10);
            assert_eq!(g0, 1);
            assert_eq!(prev0, None);

            let installer_a = {
                let table = table.clone();
                thread::spawn(move || table.install("s1".into(), 20))
            };
            let installer_b = {
                let table = table.clone();
                thread::spawn(move || table.install("s1".into(), 30))
            };
            let old_pump = {
                let table = table.clone();
                thread::spawn(move || table.remove_if_current("s1", g0))
            };

            let (g1, prev1) = installer_a.join().unwrap();
            let (g2, prev2) = installer_b.join().unwrap();
            let old_removed = old_pump.join().unwrap();

            // (a) Strictly monotonic generation allocation and installation.
            assert!(g1 > g0 && g2 > g0 && g1 != g2);
            let newest_gen = g1.max(g2);
            let older_new_gen = g1.min(g2);
            assert_eq!(newest_gen, 3);
            let expected_winner = if g1 == newest_gen { 20 } else { 30 };

            // (b) Old pump exit can never evict a newer generation.
            if let Some(removed) = old_removed {
                assert_eq!(removed, 10, "old pump may only remove its own handle");
            }
            assert!(table.is_current("s1", newest_gen));
            assert!(!table.is_current("s1", older_new_gen));
            assert_eq!(table.get_if_current("s1", newest_gen), Some(expected_winner));
            assert_eq!(table.get_if_current("s1", older_new_gen), None);

            // (c) Every handle is owned by exactly one caller (zero leaks, zero double-dispose).
            let mut handles = Vec::new();
            handles.extend(prev1);
            handles.extend(prev2);
            handles.extend(old_removed);
            handles.extend(table.drain_all());
            handles.sort_unstable();
            assert_eq!(handles, vec![10, 20, 30]);
        });
    }

    #[test]
    fn concurrent_install_dismiss_and_old_pump_exit_never_leak_or_double_dispose() {
        loom::model(|| {
            let table = Arc::new(SessionGenerationTable::<u32>::new());
            let (g0, prev0) = table.install("s1".into(), 10);
            assert_eq!(g0, 1);
            assert_eq!(prev0, None);

            let installer = {
                let table = table.clone();
                thread::spawn(move || table.install("s1".into(), 20))
            };
            let dismisser = {
                let table = table.clone();
                thread::spawn(move || table.remove_any("s1"))
            };
            let old_pump = {
                let table = table.clone();
                thread::spawn(move || table.remove_if_current("s1", g0))
            };

            let (g1, prev1) = installer.join().unwrap();
            let dismissed = dismisser.join().unwrap();
            let old_removed = old_pump.join().unwrap();

            assert_eq!(g1, 2);
            if let Some(removed) = old_removed {
                assert_eq!(removed, 10, "old pump may never evict generation 2");
            }

            let mut handles = Vec::new();
            handles.extend(prev1);
            handles.extend(dismissed);
            handles.extend(old_removed);
            handles.extend(table.drain_all());
            handles.sort_unstable();
            assert_eq!(handles, vec![10, 20]);
        });
    }

    #[test]
    fn concurrent_install_drain_all_and_old_pump_exit_account_for_every_handle() {
        loom::model(|| {
            let table = Arc::new(SessionGenerationTable::<u32>::new());
            let (g0, _) = table.install("s1".into(), 10);

            let installer = {
                let table = table.clone();
                thread::spawn(move || table.install("s1".into(), 20))
            };
            let closer = {
                let table = table.clone();
                thread::spawn(move || table.drain_all())
            };
            let old_pump = {
                let table = table.clone();
                thread::spawn(move || table.remove_if_current("s1", g0))
            };

            let (g1, prev1) = installer.join().unwrap();
            let drained = closer.join().unwrap();
            let old_removed = old_pump.join().unwrap();

            assert_eq!(g1, 2);
            if let Some(removed) = old_removed {
                assert_eq!(removed, 10, "old pump may never evict generation 2");
            }

            let mut handles = Vec::new();
            handles.extend(prev1);
            handles.extend(drained);
            handles.extend(old_removed);
            handles.extend(table.drain_all());
            handles.sort_unstable();
            assert_eq!(handles, vec![10, 20]);
        });
    }
}
