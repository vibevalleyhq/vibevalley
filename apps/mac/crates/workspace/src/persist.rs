//! The slice of `vibevalley-store` the workspace needs, as a trait so the state
//! logic is testable without SQLite.

use std::path::Path;

use crate::store::{Project, ProjectId, Result, SavedTerminal};
use serde_json::Value;
use vibevalley_terminal::TerminalHooksConfig;

pub const TERMINAL_HOOKS_SETTINGS_KEY: &str = "terminal.hooks";

pub trait Persistence: Send + Sync {
    fn projects(&self) -> Result<Vec<Project>>;
    fn add_project(&self, path: &Path) -> Result<Project>;
    fn remove_project(&self, id: ProjectId) -> Result<()>;
    fn rename_project(&self, id: ProjectId, name: &str) -> Result<()>;
    fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> Result<()>;
    fn touch_project(&self, id: ProjectId) -> Result<()>;
    fn layout(&self, id: ProjectId) -> Result<Option<Value>>;
    fn set_layout(&self, id: ProjectId, layout: &Value) -> Result<()>;
    fn terminals(&self, id: ProjectId) -> Result<Vec<SavedTerminal>>;
    fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> Result<()>;
    fn setting(&self, key: &str) -> Result<Option<Value>>;
    fn set_setting(&self, key: &str, value: &Value) -> Result<()>;
}

impl Persistence for crate::store::Store {
    fn projects(&self) -> Result<Vec<Project>> {
        crate::store::Store::projects(self)
    }
    fn add_project(&self, path: &Path) -> Result<Project> {
        crate::store::Store::add_project(self, path)
    }
    fn remove_project(&self, id: ProjectId) -> Result<()> {
        crate::store::Store::remove_project(self, id)
    }
    fn rename_project(&self, id: ProjectId, name: &str) -> Result<()> {
        crate::store::Store::rename_project(self, id, name)
    }
    fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> Result<()> {
        crate::store::Store::reorder_projects(self, ids_in_order)
    }
    fn touch_project(&self, id: ProjectId) -> Result<()> {
        crate::store::Store::touch_project(self, id)
    }
    fn layout(&self, id: ProjectId) -> Result<Option<Value>> {
        crate::store::Store::layout(self, id)
    }
    fn set_layout(&self, id: ProjectId, layout: &Value) -> Result<()> {
        crate::store::Store::set_layout(self, id, layout)
    }
    fn terminals(&self, id: ProjectId) -> Result<Vec<SavedTerminal>> {
        crate::store::Store::terminals(self, id)
    }
    fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> Result<()> {
        crate::store::Store::set_terminals(self, id, terminals)
    }
    fn setting(&self, key: &str) -> Result<Option<Value>> {
        crate::store::Store::setting(self, key)
    }
    fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        crate::store::Store::set_setting(self, key, value)
    }
}

/// Typed access to one JSON setting. Missing or unreadable values yield the default.
pub fn load_setting<T: serde::de::DeserializeOwned + Default>(store: &dyn Persistence, key: &str) -> T {
    store
        .setting(key)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn save_setting<T: serde::Serialize>(store: &dyn Persistence, key: &str, value: &T) -> Result<()> {
    let value = serde_json::to_value(value).map_err(|e| crate::store::StoreError::Db(e.to_string()))?;
    store.set_setting(key, &value)
}

/// Loads persisted terminal hooks config; returns all-OFF defaults when unset.
pub fn load_terminal_hooks(store: &dyn Persistence) -> TerminalHooksConfig {
    load_setting(store, TERMINAL_HOOKS_SETTINGS_KEY)
}

pub fn save_terminal_hooks(store: &dyn Persistence, config: &TerminalHooksConfig) -> Result<()> {
    save_setting(store, TERMINAL_HOOKS_SETTINGS_KEY, config)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::testing::MemStore;

    #[test]
    fn terminal_hooks_persistence_defaults_to_all_off_and_round_trips() {
        let store = MemStore::default();
        let initial = load_terminal_hooks(&store);
        assert_eq!(initial, TerminalHooksConfig::default());
        assert!(!initial.is_workspace_hook_enabled(Some(Path::new("/work/repo")), "idegraph"));

        let mut updated = initial;
        updated.set_workspace_hook_enabled(Path::new("/work/repo"), "idegraph", true);
        save_terminal_hooks(&store, &updated).unwrap();

        let reloaded = load_terminal_hooks(&store);
        assert!(reloaded.is_workspace_hook_enabled(Some(Path::new("/work/repo")), "idegraph"));
    }
}
