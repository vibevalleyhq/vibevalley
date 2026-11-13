//! The git operations task orchestration needs, as traits so it can be
//! tested without spawning `git`.

use std::path::{Path, PathBuf};

use vibevalley_git::{DiffTarget, FileDiff, MergeCheck, Result};

pub trait RepoOps: Send + Sync {
    fn root(&self) -> PathBuf;
    fn head(&self) -> Result<Option<String>>;
    /// Paths with any uncommitted change, relative to the root.
    fn dirty_paths(&self) -> Result<Vec<PathBuf>>;
    fn diff(&self, target: &DiffTarget) -> Result<Vec<FileDiff>>;
    fn stage(&self, paths: &[PathBuf]) -> Result<()>;
    fn commit(&self, message: &str) -> Result<String>;
    fn snapshot(&self, label: &str) -> Result<String>;
    fn worktree_add(&self, path: &Path, branch: &str) -> Result<Box<dyn RepoOps>>;
    fn worktree_remove(&self, path: &Path, force: bool) -> Result<()>;
    fn merge_check(&self, branch: &str) -> Result<MergeCheck>;
    fn merge(&self, branch: &str, message: Option<&str>) -> Result<String>;
}

pub trait GitProvider: Send + Sync {
    fn discover(&self, path: &Path) -> Result<Option<Box<dyn RepoOps>>>;
}

/// The real thing: `vibevalley_git` driving the system `git`.
pub struct SystemGit;

impl GitProvider for SystemGit {
    fn discover(&self, path: &Path) -> Result<Option<Box<dyn RepoOps>>> {
        Ok(vibevalley_git::Repo::discover(path)?.map(|r| Box::new(r) as Box<dyn RepoOps>))
    }
}

impl RepoOps for vibevalley_git::Repo {
    fn root(&self) -> PathBuf {
        vibevalley_git::Repo::root(self).to_path_buf()
    }
    fn head(&self) -> Result<Option<String>> {
        Ok(self.status()?.head)
    }
    fn dirty_paths(&self) -> Result<Vec<PathBuf>> {
        Ok(self.status()?.entries.into_iter().map(|e| e.path).collect())
    }
    fn diff(&self, target: &DiffTarget) -> Result<Vec<FileDiff>> {
        vibevalley_git::Repo::diff(self, target, None)
    }
    fn stage(&self, paths: &[PathBuf]) -> Result<()> {
        vibevalley_git::Repo::stage(self, paths)
    }
    fn commit(&self, message: &str) -> Result<String> {
        vibevalley_git::Repo::commit(self, message)
    }
    fn snapshot(&self, label: &str) -> Result<String> {
        vibevalley_git::Repo::snapshot(self, label)
    }
    fn worktree_add(&self, path: &Path, branch: &str) -> Result<Box<dyn RepoOps>> {
        Ok(Box::new(vibevalley_git::Repo::worktree_add(self, path, branch, None)?))
    }
    fn worktree_remove(&self, path: &Path, force: bool) -> Result<()> {
        vibevalley_git::Repo::worktree_remove(self, path, force)
    }
    fn merge_check(&self, branch: &str) -> Result<MergeCheck> {
        vibevalley_git::Repo::merge_check(self, branch)
    }
    fn merge(&self, branch: &str, message: Option<&str>) -> Result<String> {
        vibevalley_git::Repo::merge(self, branch, message)
    }
}
