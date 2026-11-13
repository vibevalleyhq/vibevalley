//! The slice of `vibevalley-store` the workspace needs, as a trait so the state
//! logic is testable without SQLite.

use std::path::Path;

use serde_json::Value;
use vibevalley_store::{AgentSessionRow, Project, ProjectId, Result, SavedTerminal};

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
    fn agent_sessions(&self, project: Option<ProjectId>) -> Result<Vec<AgentSessionRow>>;
    fn upsert_agent_session(&self, row: &AgentSessionRow) -> Result<()>;
    fn delete_agent_session(&self, id: &str) -> Result<()>;
    fn setting(&self, key: &str) -> Result<Option<Value>>;
    fn set_setting(&self, key: &str, value: &Value) -> Result<()>;
}

impl Persistence for vibevalley_store::Store {
    fn projects(&self) -> Result<Vec<Project>> {
        vibevalley_store::Store::projects(self)
    }
    fn add_project(&self, path: &Path) -> Result<Project> {
        vibevalley_store::Store::add_project(self, path)
    }
    fn remove_project(&self, id: ProjectId) -> Result<()> {
        vibevalley_store::Store::remove_project(self, id)
    }
    fn rename_project(&self, id: ProjectId, name: &str) -> Result<()> {
        vibevalley_store::Store::rename_project(self, id, name)
    }
    fn reorder_projects(&self, ids_in_order: &[ProjectId]) -> Result<()> {
        vibevalley_store::Store::reorder_projects(self, ids_in_order)
    }
    fn touch_project(&self, id: ProjectId) -> Result<()> {
        vibevalley_store::Store::touch_project(self, id)
    }
    fn layout(&self, id: ProjectId) -> Result<Option<Value>> {
        vibevalley_store::Store::layout(self, id)
    }
    fn set_layout(&self, id: ProjectId, layout: &Value) -> Result<()> {
        vibevalley_store::Store::set_layout(self, id, layout)
    }
    fn terminals(&self, id: ProjectId) -> Result<Vec<SavedTerminal>> {
        vibevalley_store::Store::terminals(self, id)
    }
    fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> Result<()> {
        vibevalley_store::Store::set_terminals(self, id, terminals)
    }
    fn agent_sessions(&self, project: Option<ProjectId>) -> Result<Vec<AgentSessionRow>> {
        vibevalley_store::Store::agent_sessions(self, project)
    }
    fn upsert_agent_session(&self, row: &AgentSessionRow) -> Result<()> {
        vibevalley_store::Store::upsert_agent_session(self, row)
    }
    fn delete_agent_session(&self, id: &str) -> Result<()> {
        vibevalley_store::Store::delete_agent_session(self, id)
    }
    fn setting(&self, key: &str) -> Result<Option<Value>> {
        vibevalley_store::Store::setting(self, key)
    }
    fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        vibevalley_store::Store::set_setting(self, key, value)
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
    let value = serde_json::to_value(value).map_err(|e| vibevalley_store::StoreError::Db(e.to_string()))?;
    store.set_setting(key, &value)
}
