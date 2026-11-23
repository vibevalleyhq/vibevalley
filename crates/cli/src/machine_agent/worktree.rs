//! Deterministic isolated git worktree & session directory management strictly guarded under `--workdir`.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use parking_lot::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedWorktree {
    pub workdir: PathBuf,
    pub branch: String,
    pub repo_dir: PathBuf,
}

/// Manages per-task git worktrees and isolated session workspaces strictly beneath `root`.
pub struct WorktreeManager {
    root: PathBuf,
    tracked_worktrees: Mutex<HashMap<PathBuf, PathBuf>>,
    ephemeral_dirs: Mutex<Vec<PathBuf>>,
}

impl WorktreeManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            tracked_worktrees: Mutex::new(HashMap::new()),
            ephemeral_dirs: Mutex::new(Vec::new()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// Creates a deterministic isolated directory under `<root>/sessions/<sanitized_session_id>`
    /// so coding sessions never share a dirty working directory.
    pub fn prepare_session_dir(&self, session_id: &str, track_ephemeral: bool) -> Result<PathBuf, String> {
        let slug = sanitize_segment(session_id)?;
        let base = self.root.join("sessions");
        fs::create_dir_all(&base).map_err(|e| format!("failed to create sessions dir {}: {e}", base.display()))?;
        let target = base.join(slug);
        fs::create_dir_all(&target).map_err(|e| format!("failed to create session dir {}: {e}", target.display()))?;
        let canonical = canonicalize_within(&base, &target)?;
        if track_ephemeral {
            self.ephemeral_dirs.lock().push(canonical.clone());
        }
        Ok(canonical)
    }

    /// Resolves a caller-supplied explicit workdir (relative paths are rooted under `self.root`),
    /// creating it if inside `self.root` or verifying it exists when absolute.
    pub fn resolve_explicit_workdir(&self, raw: &str) -> Result<PathBuf, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("workdir must not be empty".into());
        }
        let candidate = PathBuf::from(trimmed);
        if candidate.is_absolute() {
            if !candidate.is_dir() {
                return Err(format!("workdir `{}` does not exist or is not a directory", candidate.display()));
            }
            return Ok(candidate);
        }
        if candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
        {
            return Err(format!("relative workdir `{trimmed}` must not traverse outside --workdir"));
        }
        let joined = self.root.join(candidate);
        fs::create_dir_all(&joined).map_err(|e| format!("failed to create workdir {}: {e}", joined.display()))?;
        canonicalize_within(&self.root, &joined)
    }

    /// Deterministically prepares an isolated git worktree under `<root>/worktrees/<sanitized_task_id>`.
    pub fn prepare_worktree(&self, task_id: &str, repo_ref: &str, branch: Option<&str>, base_ref: Option<&str>) -> Result<PreparedWorktree, String> {
        let task_slug = sanitize_segment(task_id)?;
        let repo_dir = self.resolve_repo(repo_ref)?;
        let worktrees_root = self.root.join("worktrees");
        fs::create_dir_all(&worktrees_root).map_err(|e| format!("failed to create worktrees dir {}: {e}", worktrees_root.display()))?;

        let target = worktrees_root.join(&task_slug);
        let branch_name = branch
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("vv/{task_slug}"));

        if target.exists() {
            if is_git_repo(&target) {
                let canonical = canonicalize_within(&worktrees_root, &target)?;
                self.tracked_worktrees.lock().insert(canonical.clone(), repo_dir.clone());
                return Ok(PreparedWorktree {
                    workdir: canonical,
                    branch: branch_name,
                    repo_dir,
                });
            }
            fs::remove_dir_all(&target).map_err(|e| format!("failed to clear stale directory {}: {e}", target.display()))?;
        }

        let branch_exists = git_ok(&repo_dir, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch_name}")]);
        let target_str = target.to_string_lossy().to_string();
        if branch_exists {
            run_git(&repo_dir, &["worktree", "add", &target_str, &branch_name])?;
        } else {
            let start_point = base_ref
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .filter(|r| git_ok(&repo_dir, &["rev-parse", "--verify", "--quiet", r]))
                .unwrap_or("HEAD");
            run_git(&repo_dir, &["worktree", "add", "-b", &branch_name, &target_str, start_point])?;
        }

        let canonical = canonicalize_within(&worktrees_root, &target)?;
        self.tracked_worktrees.lock().insert(canonical.clone(), repo_dir.clone());
        Ok(PreparedWorktree {
            workdir: canonical,
            branch: branch_name,
            repo_dir,
        })
    }

    /// Removes a git worktree strictly guarded beneath `<root>/worktrees/` via `git worktree remove --force`.
    pub fn cleanup_worktree(&self, workdir: &Path) -> Result<(), String> {
        let worktrees_root = self.root.join("worktrees");
        if !worktrees_root.exists() {
            return Err(format!("refusing to clean `{}`: path is outside worktrees root", workdir.display()));
        }
        if !workdir.exists() {
            // Still verify lexical containment so arbitrary outside paths are never accepted silently.
            ensure_lexical_child(&worktrees_root, workdir)?;
            self.tracked_worktrees.lock().remove(workdir);
            return Ok(());
        }

        let canonical = canonicalize_within(&worktrees_root, workdir)?;
        let repo_dir = self
            .tracked_worktrees
            .lock()
            .remove(&canonical)
            .or_else(|| discover_common_git_repo(&canonical));

        if let Some(repo) = repo_dir {
            let target_str = canonical.to_string_lossy().to_string();
            let _ = run_git(&repo, &["worktree", "remove", "--force", &target_str]);
            let _ = run_git(&repo, &["worktree", "prune"]);
        }

        if canonical.exists() {
            fs::remove_dir_all(&canonical).map_err(|e| format!("failed to remove worktree directory {}: {e}", canonical.display()))?;
        }
        Ok(())
    }

    /// Best-effort cleanup of all tracked ephemeral worktrees and session directories on shutdown.
    pub fn cleanup_all_tracked(&self) {
        let worktrees: Vec<PathBuf> = self.tracked_worktrees.lock().keys().cloned().collect();
        for wt in worktrees {
            let _ = self.cleanup_worktree(&wt);
        }
        let dirs: Vec<PathBuf> = std::mem::take(&mut *self.ephemeral_dirs.lock());
        let sessions_root = self.root.join("sessions");
        for dir in dirs {
            if dir.exists() && canonicalize_within(&sessions_root, &dir).is_ok() {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }

    fn resolve_repo(&self, repo_ref: &str) -> Result<PathBuf, String> {
        let trimmed = repo_ref.trim();
        if trimmed.is_empty() {
            return Err("repo_ref must not be empty".into());
        }

        // 1. Existing local git repository path.
        let as_path = PathBuf::from(trimmed);
        if as_path.is_dir() && is_git_repo(&as_path) {
            return fs::canonicalize(&as_path).map_err(|e| format!("failed to canonicalize repo {}: {e}", as_path.display()));
        }

        // 2. Named local repository under `<workdir>/repos/<name>` or `<workdir>/<name>`.
        if !looks_like_git_url(trimmed) {
            if Path::new(trimmed)
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
            {
                return Err(format!("invalid local repo_ref `{trimmed}`"));
            }
            for candidate in [self.root.join("repos").join(trimmed), self.root.join(trimmed)] {
                if candidate.is_dir() && is_git_repo(&candidate) {
                    return fs::canonicalize(&candidate).map_err(|e| format!("failed to canonicalize repo {}: {e}", candidate.display()));
                }
            }
            return Err(format!("local git repository `{trimmed}` not found under {}", self.root.display()));
        }

        // 3. Remote/file git URL: clone deterministically into `<workdir>/repos/<slug>`.
        let repos_root = self.root.join("repos");
        fs::create_dir_all(&repos_root).map_err(|e| format!("failed to create repos dir {}: {e}", repos_root.display()))?;
        let slug = sanitize_repo_slug(trimmed);
        let clone_dir = repos_root.join(slug);
        if clone_dir.is_dir() && is_git_repo(&clone_dir) {
            let _ = run_git(&clone_dir, &["fetch", "--prune", "origin"]);
            return fs::canonicalize(&clone_dir).map_err(|e| format!("failed to canonicalize repo {}: {e}", clone_dir.display()));
        }
        let clone_str = clone_dir.to_string_lossy().to_string();
        run_git(&repos_root, &["clone", trimmed, &clone_str])?;
        fs::canonicalize(&clone_dir).map_err(|e| format!("failed to canonicalize cloned repo {}: {e}", clone_dir.display()))
    }
}

fn looks_like_git_url(raw: &str) -> bool {
    raw.starts_with("https://") || raw.starts_with("http://") || raw.starts_with("ssh://") || raw.starts_with("git@") || raw.starts_with("file://")
}

fn sanitize_repo_slug(url: &str) -> String {
    let tail = url.trim_end_matches('/').trim_end_matches(".git").rsplit(['/', ':']).next().unwrap_or("repo");
    let clean: String = tail
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    let trimmed = clean.trim_matches('.');
    if trimmed.is_empty() { "repo".into() } else { trimmed.to_string() }
}

pub fn sanitize_segment(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("identifier must not be empty".into());
    }
    let clean: String = trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    if clean == "." || clean == ".." || clean.chars().all(|c| c == '.') {
        return Err(format!("invalid path identifier `{raw}`"));
    }
    Ok(clean)
}

fn canonicalize_within(base: &Path, target: &Path) -> Result<PathBuf, String> {
    let base_canon = fs::canonicalize(base).map_err(|e| format!("failed to resolve base {}: {e}", base.display()))?;
    let target_canon = fs::canonicalize(target).map_err(|e| format!("failed to resolve path {}: {e}", target.display()))?;
    if target_canon == base_canon || !target_canon.starts_with(&base_canon) {
        return Err(format!(
            "refusing to operate on `{}`: path must be strictly inside `{}`",
            target.display(),
            base_canon.display()
        ));
    }
    Ok(target_canon)
}

fn ensure_lexical_child(base: &Path, target: &Path) -> Result<(), String> {
    if target.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("refusing to operate on `{}`: parent traversal is not allowed", target.display()));
    }
    let base_canon = fs::canonicalize(base).map_err(|e| format!("failed to resolve base {}: {e}", base.display()))?;
    if target == base_canon || !target.starts_with(&base_canon) && !target.starts_with(base) {
        return Err(format!(
            "refusing to operate on `{}`: path must be strictly inside `{}`",
            target.display(),
            base_canon.display()
        ));
    }
    Ok(())
}

fn is_git_repo(path: &Path) -> bool {
    git_ok(path, &["rev-parse", "--git-dir"])
}

fn discover_common_git_repo(worktree: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["rev-parse", "--git-common-dir"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8(out.stdout).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let git_dir = PathBuf::from(trimmed);
    let abs = if git_dir.is_absolute() { git_dir } else { worktree.join(git_dir) };
    let canon = fs::canonicalize(&abs).unwrap_or(abs);
    if canon.file_name().and_then(|n| n.to_str()) == Some(".git") {
        canon.parent().map(Path::to_path_buf)
    } else {
        Some(canon)
    }
}

fn git_ok(cwd: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to spawn git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("git {} failed: {stderr}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
