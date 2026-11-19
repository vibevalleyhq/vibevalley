//! In-crate fakes for persistence and terminals, so workspace state logic is
//! tested without SQLite or a PTY.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use vibevalley_store::{Project, ProjectId, SavedTerminal, StoreError};

use crate::persist::Persistence;
use crate::workspace::TerminalHandle;

#[derive(Default)]
pub struct MemStore {
    pub projects: Mutex<Vec<Project>>,
    pub layouts: Mutex<HashMap<ProjectId, Value>>,
    pub terminals: Mutex<HashMap<ProjectId, Vec<SavedTerminal>>>,
    pub settings: Mutex<HashMap<String, Value>>,
}

impl Persistence for MemStore {
    fn projects(&self) -> vibevalley_store::Result<Vec<Project>> {
        Ok(self.projects.lock().unwrap().clone())
    }
    fn add_project(&self, path: &Path) -> vibevalley_store::Result<Project> {
        let mut projects = self.projects.lock().unwrap();
        if let Some(p) = projects.iter().find(|p| p.path == path) {
            return Ok(p.clone());
        }
        let id = projects.len() as i64 + 1;
        let project = Project {
            id,
            path: path.to_path_buf(),
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            position: id,
            last_opened_ms: 0,
        };
        projects.push(project.clone());
        Ok(project)
    }
    fn remove_project(&self, id: ProjectId) -> vibevalley_store::Result<()> {
        self.projects.lock().unwrap().retain(|p| p.id != id);
        Ok(())
    }
    fn rename_project(&self, id: ProjectId, name: &str) -> vibevalley_store::Result<()> {
        let mut projects = self.projects.lock().unwrap();
        let p = projects.iter_mut().find(|p| p.id == id).ok_or(StoreError::NotFound)?;
        p.name = name.to_string();
        Ok(())
    }
    fn reorder_projects(&self, ids: &[ProjectId]) -> vibevalley_store::Result<()> {
        for p in self.projects.lock().unwrap().iter_mut() {
            p.position = ids.iter().position(|i| *i == p.id).unwrap_or(usize::MAX) as i64;
        }
        Ok(())
    }
    fn touch_project(&self, _id: ProjectId) -> vibevalley_store::Result<()> {
        Ok(())
    }
    fn layout(&self, id: ProjectId) -> vibevalley_store::Result<Option<Value>> {
        Ok(self.layouts.lock().unwrap().get(&id).cloned())
    }
    fn set_layout(&self, id: ProjectId, layout: &Value) -> vibevalley_store::Result<()> {
        self.layouts.lock().unwrap().insert(id, layout.clone());
        Ok(())
    }
    fn terminals(&self, id: ProjectId) -> vibevalley_store::Result<Vec<SavedTerminal>> {
        Ok(self.terminals.lock().unwrap().get(&id).cloned().unwrap_or_default())
    }
    fn set_terminals(&self, id: ProjectId, terminals: &[SavedTerminal]) -> vibevalley_store::Result<()> {
        self.terminals.lock().unwrap().insert(id, terminals.to_vec());
        Ok(())
    }
    fn setting(&self, key: &str) -> vibevalley_store::Result<Option<Value>> {
        Ok(self.settings.lock().unwrap().get(key).cloned())
    }
    fn set_setting(&self, key: &str, value: &Value) -> vibevalley_store::Result<()> {
        self.settings.lock().unwrap().insert(key.to_string(), value.clone());
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct FakeTerm {
    pub cwd: Option<PathBuf>,
    pub scrollback: String,
    pub killed: Arc<Mutex<bool>>,
}

impl FakeTerm {
    pub fn new(cwd: &str, scrollback: &str) -> Self {
        FakeTerm {
            cwd: Some(cwd.into()),
            scrollback: scrollback.into(),
            killed: Arc::default(),
        }
    }
    pub fn was_killed(&self) -> bool {
        *self.killed.lock().unwrap()
    }
}

impl TerminalHandle for FakeTerm {
    fn cwd(&self) -> Option<PathBuf> {
        self.cwd.clone()
    }
    fn scrollback_text(&self, _max_lines: usize) -> String {
        self.scrollback.clone()
    }
    fn is_alive(&self) -> bool {
        !self.was_killed()
    }
    fn kill(&self) {
        *self.killed.lock().unwrap() = true;
    }
}
