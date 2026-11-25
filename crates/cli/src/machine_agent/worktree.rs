//! Deterministic isolated git worktree & session directory management strictly guarded under `--workdir`.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use parking_lot::Mutex;
use vibevalley_git::Repo;

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
        let Some(paths) = std::env::var_os("PATH") else {
            return false;
        };
        let bin = if cfg!(windows) { "git.exe" } else { "git" };
        std::env::split_paths(&paths).any(|dir| is_executable_file(&dir.join(bin)))
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

        let repo = Repo::discover(&repo_dir)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("{} is not a git repository", repo_dir.display()))?;
        let branch_exists = vibevalley_git::read::branch_exists(&repo_dir, &branch_name).map_err(|e| e.to_string())?;
        if branch_exists {
            repo.worktree_add_on(&target, &branch_name).map_err(|e| e.to_string())?;
        } else {
            let start_point = base_ref
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .filter(|r| match vibevalley_git::read::commit_id_fast(&repo_dir, r) {
                    Ok(Some(_)) => true,
                    Ok(None) => repo.run(&["rev-parse", "--verify", "--quiet", r]).is_ok_and(|out| out.ok()),
                    Err(_) => false,
                });
            repo.worktree_add(&target, &branch_name, start_point).map_err(|e| e.to_string())?;
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

        if let Some(repo_dir) = repo_dir
            && let Ok(Some(repo)) = Repo::discover(&repo_dir)
        {
            let _ = repo.worktree_remove(&canonical, true);
            let _ = repo.worktree_prune();
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
        if clone_dir.is_dir()
            && let Ok(Some(repo)) = Repo::discover(&clone_dir)
        {
            let _ = repo.run(&["fetch", "--prune", "origin"]);
            return fs::canonicalize(&clone_dir).map_err(|e| format!("failed to canonicalize repo {}: {e}", clone_dir.display()));
        }
        vibevalley_git::clone(trimmed, &clone_dir).map_err(|e| format!("failed to clone {trimmed}: {e}"))?;
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

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::metadata(path).is_ok_and(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn is_git_repo(path: &Path) -> bool {
    Repo::discover(path).is_ok_and(|repo| repo.is_some())
}

fn discover_common_git_repo(worktree: &Path) -> Option<PathBuf> {
    let common = vibevalley_git::read::git_common_dir(worktree).ok()?;
    let canon = fs::canonicalize(&common).unwrap_or(common);
    if canon.file_name().and_then(|n| n.to_str()) == Some(".git") {
        canon.parent().map(Path::to_path_buf)
    } else {
        Some(canon)
    }
}
