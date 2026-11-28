mod git;
mod lifecycle;
mod sidebar;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use vibevalley_git::Repo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SidebarTopics {
    pub rail: bool,
    pub files: bool,
    pub git: bool,
}

impl SidebarTopics {
    pub const ALL: Self = Self {
        rail: true,
        files: true,
        git: true,
    };
    pub const RAIL: Self = Self {
        rail: true,
        files: false,
        git: false,
    };
    pub const FILES: Self = Self {
        rail: false,
        files: true,
        git: false,
    };
}

/// Resolves the main git repository root to mount for a Workspace directory, or `None` when not a git repo.
fn git_repo_mount_root(path: &Path) -> Option<PathBuf> {
    let repo = Repo::discover(path).ok()??;
    if let Ok(worktrees) = repo.worktrees()
        && let Some(main) = worktrees.into_iter().find(|w| w.is_main)
    {
        return Some(main.path);
    }
    Some(repo.root().to_path_buf())
}

pub(super) fn first_workspace_repo(work_root: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(work_root).ok()?;
    let mut dirs: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs.iter()
        .find(|p| Repo::discover(p).ok().flatten().is_some())
        .cloned()
        .or_else(|| dirs.into_iter().next())
}
