//! The few git operations `vibevalley-git` does not offer, through the system
//! `git` binary as `vibevalley-git` does.

use std::path::Path;
use std::process::Command;

use vibevalley_git::Repo;

use crate::runtime::{Result, RuntimeError};

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| RuntimeError::Other(format!("git: {e}")))
}

fn text(root: &Path, args: &[&str]) -> Result<String> {
    let out = git(root, args)?;
    if !out.status.success() {
        return Err(RuntimeError::Other(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn branch_exists(root: &Path, branch: &str) -> Result<bool> {
    Ok(git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])?
        .status
        .success())
}

/// A worktree at `dir` on the existing `branch`.
pub fn add_worktree_on(main: &Repo, dir: &Path, branch: &str) -> Result<Repo> {
    let dir_text = dir.to_string_lossy();
    text(main.root(), &["worktree", "add", "--quiet", &dir_text, branch])?;
    Repo::discover(dir)?.ok_or_else(|| RuntimeError::NotARepo(dir.to_path_buf()))
}

pub fn commit_id(root: &Path, rev: &str) -> Result<String> {
    text(root, &["rev-parse", "--verify", "--end-of-options", &format!("{rev}^{{commit}}")])
}

pub fn merge_base(root: &Path, a: &str, b: &str) -> Result<String> {
    text(root, &["merge-base", a, b])
}

/// Files changed on HEAD since it forked from `base`.
pub fn changed_files(root: &Path, base: &str) -> Result<Vec<String>> {
    let from = merge_base(root, base, "HEAD")?;
    let out = text(root, &["diff", "--name-only", &from, "HEAD"])?;
    Ok(out.lines().filter(|l| !l.is_empty()).map(String::from).collect())
}

/// Whether `branch` has commits that `into` does not.
pub fn has_unmerged(root: &Path, branch: &str, into: &str) -> Result<bool> {
    let out = git(root, &["merge-base", "--is-ancestor", branch, into])?;
    match out.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(RuntimeError::Other(String::from_utf8_lossy(&out.stderr).trim().to_string())),
    }
}

pub fn commits_between(root: &Path, from: &str, to: &str) -> Result<usize> {
    Ok(text(root, &["rev-list", "--count", &format!("{from}..{to}")])?.parse().unwrap_or(0))
}

/// Deletes `branch` when every commit on it is in `into`.
pub fn delete_branch_if_merged(root: &Path, branch: &str, into: &str) -> Result<bool> {
    if !branch_exists(root, branch)? || has_unmerged(root, branch, into)? {
        return Ok(false);
    }
    text(root, &["branch", "-D", branch])?;
    Ok(true)
}

pub fn delete_branch(root: &Path, branch: &str) -> Result<()> {
    if branch_exists(root, branch)? {
        text(root, &["branch", "-D", branch])?;
    }
    Ok(())
}

/// The worktree at `dir` removed, also when git no longer knows it.
pub fn remove_worktree(main: &Repo, dir: &Path) -> Result<()> {
    if dir.exists() {
        main.worktree_remove(dir, true)?;
    }
    let _ = git(main.root(), &["worktree", "prune"]);
    Ok(())
}

/// Returns the `origin` remote URL of `root`, if configured.
pub fn remote_origin_url(root: &Path) -> Option<String> {
    text(root, &["remote", "get-url", "origin"]).ok().filter(|u| !u.is_empty())
}
