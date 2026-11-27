//! The slice of `vibevalley-store` the workspace needs, as a trait so the state
//! logic is testable without SQLite.

use std::future::Future;
use std::path::Path;

use crate::store::{Project, ProjectId, Result, SavedTerminal};
use serde_json::Value;
use vibevalley_terminal::TerminalHooksConfig;

pub const TERMINAL_HOOKS_SETTINGS_KEY: &str = "terminal.hooks";

pub trait Persistence: Send + Sync {
    fn projects(&self) -> impl Future<Output = Result<Vec<Project>>> + Send;
    fn add_project(&self, path: &Path) -> impl Future<Output = Result<Project>> + Send;
    fn remove_project(&self, id: ProjectId) -> impl Future<Output = Result<()>> + Send;
    fn rename_project(&self, id: ProjectId, name: &str) -> impl Future<Output = Result<()>> + Send;
    fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> impl Future<Output = Result<()>> + Send;
    fn touch_project(&self, id: ProjectId) -> impl Future<Output = Result<()>> + Send;
    fn layout(&self, id: ProjectId) -> impl Future<Output = Result<Option<Value>>> + Send;
    fn set_layout(&self, id: ProjectId, layout: &Value) -> impl Future<Output = Result<()>> + Send;
    fn terminals(&self, id: ProjectId) -> impl Future<Output = Result<Vec<SavedTerminal>>> + Send;
    fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> impl Future<Output = Result<()>> + Send;
    fn setting(&self, key: &str) -> impl Future<Output = Result<Option<Value>>> + Send;
    fn set_setting(&self, key: &str, value: &Value) -> impl Future<Output = Result<()>> + Send;
}

impl Persistence for crate::store::Store {
    async fn projects(&self) -> Result<Vec<Project>> {
        crate::store::Store::projects(self).await
    }
    async fn add_project(&self, path: &Path) -> Result<Project> {
        crate::store::Store::add_project(self, path).await
    }
    async fn remove_project(&self, id: ProjectId) -> Result<()> {
        crate::store::Store::remove_project(self, id).await
    }
    async fn rename_project(&self, id: ProjectId, name: &str) -> Result<()> {
        crate::store::Store::rename_project(self, id, name).await
    }
    async fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> Result<()> {
        crate::store::Store::reorder_projects(self, ids_in_order).await
    }
    async fn touch_project(&self, id: ProjectId) -> Result<()> {
        crate::store::Store::touch_project(self, id).await
    }
    async fn layout(&self, id: ProjectId) -> Result<Option<Value>> {
        crate::store::Store::layout(self, id).await
    }
    async fn set_layout(&self, id: ProjectId, layout: &Value) -> Result<()> {
        crate::store::Store::set_layout(self, id, layout).await
    }
    async fn terminals(&self, id: ProjectId) -> Result<Vec<SavedTerminal>> {
        crate::store::Store::terminals(self, id).await
    }
    async fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> Result<()> {
        crate::store::Store::set_terminals(self, id, terminals).await
    }
    async fn setting(&self, key: &str) -> Result<Option<Value>> {
        crate::store::Store::setting(self, key).await
    }
    async fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        crate::store::Store::set_setting(self, key, value).await
    }
}

/// Typed access to one JSON setting. Missing or unreadable values yield the default.
pub async fn load_setting<T: serde::de::DeserializeOwned + Default>(store: &(impl Persistence + ?Sized), key: &str) -> T {
    store
        .setting(key)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub async fn save_setting<T: serde::Serialize + Sync>(store: &(impl Persistence + ?Sized), key: &str, value: &T) -> Result<()> {
    let value = serde_json::to_value(value).map_err(|e| crate::store::StoreError::Db(e.to_string()))?;
    store.set_setting(key, &value).await
}

/// Loads persisted terminal hooks config; returns all-OFF defaults when unset.
pub async fn load_terminal_hooks(store: &(impl Persistence + ?Sized)) -> TerminalHooksConfig {
    load_setting(store, TERMINAL_HOOKS_SETTINGS_KEY).await
}

pub async fn save_terminal_hooks(store: &(impl Persistence + ?Sized), config: &TerminalHooksConfig) -> Result<()> {
    save_setting(store, TERMINAL_HOOKS_SETTINGS_KEY, config).await
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::testing::MemStore;

    #[tokio::test]
    async fn terminal_hooks_persistence_defaults_to_all_off_and_round_trips() {
        let store = MemStore::default();
        let initial = load_terminal_hooks(&store).await;
        assert_eq!(initial, TerminalHooksConfig::default());
        assert!(!initial.is_workspace_hook_enabled(Some(Path::new("/work/repo")), "idegraph"));

        let mut updated = initial;
        updated.set_workspace_hook_enabled(Path::new("/work/repo"), "idegraph", true);
        save_terminal_hooks(&store, &updated).await.unwrap();

        let reloaded = load_terminal_hooks(&store).await;
        assert!(reloaded.is_workspace_hook_enabled(Some(Path::new("/work/repo")), "idegraph"));
    }
}
