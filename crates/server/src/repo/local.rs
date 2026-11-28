use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
use tracing::instrument::WithSubscriber;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, GitHubAuthMode, GitHubStatus, MAX_RUNNING, MountRepo, NewRepo, PullRequestCapability, RepoSummary, Validation};

use super::github::{
    GhProbe, GitHubCache, GitHubRest, github_origin, github_repository, probe_capabilities_for_folders_async, probe_github_with_runner_async,
    probe_single_capability_async,
};
use crate::context::Context;
use crate::context::error::{LookIn, missing};
use crate::context::task::TaskGroup;
use crate::setting::Setting;

pub(super) const REPO_CONCURRENCY: usize = 4;

const GITIGNORE: &str = "node_modules/\ndist/\nbuild/\n.env\n.env.*\n!.env.example\n.DS_Store\n__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n";
const MOUNTS_FILE: &str = ".mounts.json";

pub(super) fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::RepoRefused, text)
}

/// `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`.
pub fn good_name(name: &str) -> bool {
    let mut c = name.chars();
    c.next().is_some_and(|f| f.is_ascii_alphanumeric()) && name.len() <= 64 && c.all(|x| x.is_ascii_alphanumeric() || matches!(x, '_' | '.' | '-'))
}

pub fn repo_problem(req: &NewRepo) -> String {
    if !good_name(&req.name) {
        return t("server.repo.badName", &[]);
    }
    if req.github.as_deref().is_some_and(|g| github_repository(g).is_none()) {
        return t("server.repo.badGithub", &[]);
    }
    String::new()
}

fn open_repo(cwd: &Path) -> Option<vibevalley_git::Repo> {
    vibevalley_git::Repo::discover(cwd).ok().flatten()
}

fn git_raw(cwd: &Path, args: &[&str]) -> Result<vibevalley_git::RawOutput, ApiError> {
    let repo = open_repo(cwd).ok_or_else(|| refused(format!("{} is not a git repository", cwd.display())))?;
    repo.run(args).map_err(|e| refused(e.to_string()))
}

/// Git trimmed output, or `""` on failure.
pub(super) fn git_quiet(cwd: &Path, args: &[&str]) -> String {
    match git_raw(cwd, args) {
        Ok(r) if r.ok() => String::from_utf8_lossy(&r.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, ApiError> {
    let r = git_raw(cwd, args)?;
    if r.ok() {
        Ok(String::from_utf8_lossy(&r.stdout).into_owned())
    } else {
        Err(refused(reason(&r.stderr)))
    }
}

/// Last line of git stderr output.
fn reason(err: &str) -> String {
    err.trim().lines().last().unwrap_or("").to_string()
}

/// Parses unix time in seconds as milliseconds, or `0` when invalid.
pub(super) fn seconds_of(text: &str) -> i64 {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| (n * 1000.0) as i64)
        .unwrap_or(0)
}

/// Persisted external repository mount record under `<work_root>/repos/.mounts.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountedRepo {
    name: String,
    path: PathBuf,
}

/// A managed folder under the repos root or a mounted external repository.
#[derive(Debug, Clone)]
pub struct RepoFolder {
    pub name: String,
    pub path: PathBuf,
    pub git: bool,
    pub external: bool,
}

#[derive(Debug, Default)]
struct LocalState {
    /// One change at a time per repo name; names being created are hidden from listings.
    pending: HashSet<String>,
    /// Mounted external git repositories stored in `<work_root>/repos/.mounts.json`.
    mounts: Vec<MountedRepo>,
    health_inputs: BTreeMap<String, Option<i64>>,
}

/// Repository manager rooted at `<work_root>/repos` plus persisted external mounts.
#[derive(Debug)]
pub struct Repo {
    root: PathBuf,
    canon_root: PathBuf,
    per_repo: usize,
    pub(super) github_rest: Option<GitHubRest>,
    pub(super) gh_probe: GhProbe,
    pub(super) github: GitHubCache,
    state: Mutex<LocalState>,
    mount_lock: tokio::sync::Mutex<()>,
    pub(super) cancel: CancellationToken,
}

async fn read_mounts_async(file: &Path) -> Vec<MountedRepo> {
    let Ok(body) = tokio::fs::read_to_string(file).await else {
        return Vec::new();
    };
    let mut parsed = serde_json::from_str::<Vec<MountedRepo>>(&body).unwrap_or_default();
    for m in &mut parsed {
        if let Ok(canon) = tokio::fs::canonicalize(&m.path).await {
            m.path = canon;
        }
    }
    parsed
}

async fn write_mounts_async(file: &Path, mounts: &[MountedRepo]) -> Result<(), ApiError> {
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| refused(e.to_string()))?;
    }
    let text = serde_json::to_string_pretty(mounts).unwrap_or_else(|_| "[]".to_string()) + "\n";
    let tmp = file.with_extension("json.tmp");
    tokio::fs::write(&tmp, text.as_bytes()).await.map_err(|e| refused(e.to_string()))?;
    tokio::fs::rename(&tmp, file).await.map_err(|e| refused(e.to_string()))
}

fn sanitize_repo_name(raw: &str) -> String {
    let mut cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '-' })
        .collect();
    while cleaned.starts_with(|c: char| !c.is_ascii_alphanumeric()) {
        cleaned.remove(0);
    }
    if cleaned.is_empty() {
        return "repo".to_string();
    }
    if cleaned.len() > 64 {
        cleaned.truncate(64);
    }
    cleaned
}

fn derive_repo_name(dir: &Path, taken: &HashSet<String>) -> String {
    let raw = dir.file_name().and_then(|n| n.to_str()).unwrap_or("repo");
    let base = sanitize_repo_name(raw);
    if !taken.contains(&base) {
        return base;
    }
    for n in 2usize.. {
        let suffix = format!("-{n}");
        let max_base = 64usize.saturating_sub(suffix.len()).max(1);
        let prefix = &base[..base.len().min(max_base)];
        let candidate = format!("{prefix}{suffix}");
        if good_name(&candidate) && !taken.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

struct PendingGuard<'a> {
    repo: &'a Repo,
    name: String,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.repo.state.lock().pending.remove(&self.name);
    }
}

impl Repo {
    /// Opens `<work_root>/repos` (creating it when missing) and loads mounted external repos.
    pub async fn open_async(work_root: &Path, per_repo: usize) -> std::io::Result<Arc<Repo>> {
        Self::open_with_setting_async(work_root, per_repo, None).await
    }

    /// Opens `<work_root>/repos` with optional [`Setting`] for GitHub Token resolution.
    pub async fn open_with_setting_async(work_root: &Path, per_repo: usize, setting: Option<Arc<Setting>>) -> std::io::Result<Arc<Repo>> {
        let root = work_root.join("repos");
        tokio::fs::create_dir_all(&root).await?;
        let canon_root = tokio::fs::canonicalize(&root).await.unwrap_or_else(|_| root.clone());
        let mounts = read_mounts_async(&root.join(MOUNTS_FILE)).await;
        Ok(Arc::new(Repo {
            root,
            canon_root,
            per_repo,
            github_rest: setting.map(GitHubRest::from_setting),
            gh_probe: GhProbe::Cli,
            github: GitHubCache::default(),
            state: Mutex::new(LocalState {
                mounts,
                ..LocalState::default()
            }),
            mount_lock: tokio::sync::Mutex::new(()),
            cancel: CancellationToken::new(),
        }))
    }

    #[cfg(test)]
    pub(super) async fn open_with_github_for_test(work_root: &Path, github_rest: Option<GitHubRest>, gh_probe: GhProbe) -> Arc<Repo> {
        let root = work_root.join("repos");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let canon_root = tokio::fs::canonicalize(&root).await.unwrap();
        Arc::new(Repo {
            root,
            canon_root,
            per_repo: 3,
            github_rest,
            gh_probe,
            github: GitHubCache::default(),
            state: Mutex::default(),
            mount_lock: tokio::sync::Mutex::new(()),
            cancel: CancellationToken::new(),
        })
    }

    pub async fn close_async(&self) {
        self.cancel.cancel();
        if let Some(handle) = self.github.take_probe() {
            let _ = handle.await;
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn max_sessions(&self) -> i64 {
        let n = self.per_repo;
        (if n == 0 || n > MAX_RUNNING { MAX_RUNNING } else { n }) as i64
    }

    /// Returns the mounted external path for `name` when registered in `.mounts.json`.
    pub fn mounted_path(&self, name: &str) -> Option<PathBuf> {
        self.state.lock().mounts.iter().find(|m| m.name == name).map(|m| m.path.clone())
    }

    /// Synchronously resolves the registered repo name for `top` when known via mounts or `repos_dir`.
    pub fn name_for_path_sync(&self, top: &Path) -> Option<String> {
        if let Some(m) = self.state.lock().mounts.iter().find(|m| m.path == top) {
            return Some(m.name.clone());
        }
        if top.parent() == Some(self.root.as_path()) || top.parent() == Some(self.canon_root.as_path()) {
            return top.file_name().map(|n| n.to_string_lossy().into_owned());
        }
        None
    }

    /// Resolves the registered repo name (managed, symlinked, or mounted) matching `top`.
    pub async fn name_for_path_async(&self, top: &Path) -> Option<String> {
        let canon_top = tokio::fs::canonicalize(top).await.unwrap_or_else(|_| top.to_path_buf());
        self.list_async().await.into_iter().find(|p| p.path == canon_top).map(|p| p.name)
    }

    /// Lists managed folders (including symlinks to real directories) and mounted external repos.
    pub async fn list_async(&self) -> Vec<RepoFolder> {
        let (pending, mounts) = {
            let state = self.state.lock();
            (state.pending.clone(), state.mounts.clone())
        };
        let mut out = list_folders_async(&self.root, &pending).await;
        for m in mounts {
            if pending.contains(&m.name) {
                continue;
            }
            let path = tokio::fs::canonicalize(&m.path).await.unwrap_or_else(|_| m.path.clone());
            if out.iter().any(|p| p.name == m.name || p.path == path) {
                continue;
            }
            let git = tokio::fs::try_exists(path.join(".git")).await.unwrap_or(false);
            out.push(RepoFolder {
                name: m.name,
                path,
                git,
                external: true,
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub async fn find_async(&self, name: &str) -> Option<RepoFolder> {
        self.list_async().await.into_iter().find(|p| p.name == name)
    }

    /// Resolves a repo hint (registered name, mounted repo, or existing local directory path)
    /// to an existing directory on disk without mutating git state.
    pub async fn resolve_dir_async(&self, repo_ref: &str) -> Option<PathBuf> {
        let trimmed = repo_ref.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(mounted) = self.mounted_path(trimmed)
            && tokio::fs::metadata(&mounted).await.is_ok_and(|m| m.is_dir())
        {
            return Some(mounted);
        }
        let candidate = self.root.join(trimmed);
        if tokio::fs::metadata(&candidate).await.is_ok_and(|m| m.is_dir()) {
            return Some(tokio::fs::canonicalize(&candidate).await.unwrap_or(candidate));
        }
        let direct = PathBuf::from(trimmed);
        if direct.is_absolute() && tokio::fs::metadata(&direct).await.is_ok_and(|m| m.is_dir()) {
            return Some(tokio::fs::canonicalize(&direct).await.unwrap_or(direct));
        }
        None
    }

    /// Reads the `origin` remote URL of a local repo hint when available.
    pub async fn origin_url_async(&self, repo_ref: &str) -> Option<String> {
        let dir = self.resolve_dir_async(repo_ref).await?;
        let url = crate::log::spawn_blocking_traced(move || git_quiet(&dir, &["remote", "get-url", "origin"]))
            .await
            .ok()?;
        let trimmed = url.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }

    /// Reads the workspace-level `AGENTS.md` (sibling of `<work_root>/repos`), if present.
    pub async fn house_rules_async(&self) -> String {
        let Some(work_root) = self.root.parent() else {
            return String::new();
        };
        tokio::fs::read_to_string(work_root.join("AGENTS.md"))
            .await
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    }

    /// Discovers the git root for `dir` and returns the matching managed/mounted repo name, if any.
    pub async fn infer_name_for_dir_async(&self, dir: &Path) -> Option<String> {
        let discovered_root = vibevalley_git::Repo::discover_async(dir).await.ok().flatten().map(|r| r.root().to_path_buf())?;
        let root_real = tokio::fs::canonicalize(&discovered_root).await.ok()?;
        for p in self.list_async().await {
            if tokio::fs::canonicalize(&p.path).await.ok().as_ref() == Some(&root_real) {
                return Some(p.name);
            }
        }
        None
    }

    /// Inspects working-tree and recent committed diffs for a local directory (used by `issue.diff.get`).
    pub async fn diff_dir_async(&self, repo_label: &str, dir: &Path) -> Result<vibevalley_protocol::Changes, ApiError> {
        let Some(repo) = vibevalley_git::Repo::discover_async(dir).await.ok().flatten() else {
            return Ok(vibevalley_protocol::Changes {
                repo: repo_label.to_string(),
                ..Default::default()
            });
        };
        let status = repo.status_async().await.map_err(|e| refused(e.to_string()))?;
        let change_code = |change: vibevalley_git::Change| -> &'static str {
            match change {
                vibevalley_git::Change::Added | vibevalley_git::Change::Untracked => "A",
                vibevalley_git::Change::Deleted => "D",
                vibevalley_git::Change::Renamed => "R",
                vibevalley_git::Change::Copied => "C",
                vibevalley_git::Change::TypeChanged => "T",
                vibevalley_git::Change::Conflicted => "U",
                vibevalley_git::Change::Unmodified | vibevalley_git::Change::Modified | vibevalley_git::Change::Ignored => "M",
            }
        };
        let uncommitted: Vec<vibevalley_protocol::UncommittedItem> = status
            .entries
            .iter()
            .map(|entry| {
                let change = if entry.index != vibevalley_git::Change::Unmodified {
                    entry.index
                } else {
                    entry.worktree
                };
                vibevalley_protocol::UncommittedItem {
                    path: entry.path.to_string_lossy().into_owned(),
                    status: change_code(change).into(),
                }
            })
            .collect();

        let default_base = if repo.branch_exists_async("main").await.unwrap_or(false) {
            Some("main".to_string())
        } else if repo.branch_exists_async("master").await.unwrap_or(false) {
            Some("master".to_string())
        } else {
            None
        };
        let on_feature_branch = match (&status.branch, &default_base) {
            (Some(cur), Some(base)) => cur != base,
            _ => false,
        };
        let (base_label, committed_diffs, git_commits) = if on_feature_branch {
            let base = default_base.as_deref().unwrap_or("main");
            let from = repo
                .run_async(&["merge-base", base, "HEAD"])
                .await
                .ok()
                .filter(|o| o.ok())
                .map(|o| o.text())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| base.to_string());
            let diffs = repo
                .diff_async(&vibevalley_git::DiffTarget::Range { from, to: "HEAD".into() }, None)
                .await
                .unwrap_or_default();
            let commits = repo.log_async(Some(&format!("{base}..HEAD")), 0, 50).await.unwrap_or_default();
            (base.to_string(), diffs, commits)
        } else {
            let has_parent = repo.commit_id_async("HEAD~1").await.is_ok();
            let (diffs, commits) = if has_parent {
                (
                    repo.diff_async(&vibevalley_git::DiffTarget::Commit("HEAD".into()), None)
                        .await
                        .unwrap_or_default(),
                    repo.log_async(Some("HEAD"), 0, 1).await.unwrap_or_default(),
                )
            } else {
                (Vec::new(), Vec::new())
            };
            (status.branch.clone().unwrap_or_default(), diffs, commits)
        };

        let uncommitted_diffs = if !status.entries.is_empty() {
            repo.diff_async(&vibevalley_git::DiffTarget::Uncommitted, None).await.unwrap_or_default()
        } else {
            Vec::new()
        };

        let format_file_diff = |f: vibevalley_git::FileDiff| -> vibevalley_protocol::ChangedFile {
            let path = f
                .new_path
                .as_ref()
                .or(f.old_path.as_ref())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut patch = String::new();
            if !f.hunks.is_empty() {
                let old_name = f
                    .old_path
                    .as_ref()
                    .map(|p| format!("a/{}", p.to_string_lossy()))
                    .unwrap_or_else(|| "/dev/null".into());
                let new_name = f
                    .new_path
                    .as_ref()
                    .map(|p| format!("b/{}", p.to_string_lossy()))
                    .unwrap_or_else(|| "/dev/null".into());
                patch.push_str(&format!("--- {old_name}\n+++ {new_name}\n"));
                for hunk in &f.hunks {
                    patch.push_str(&hunk.header);
                    patch.push('\n');
                    for line in &hunk.lines {
                        match line.kind {
                            vibevalley_git::LineKind::Context => {
                                patch.push(' ');
                                patch.push_str(&line.text);
                                patch.push('\n');
                            }
                            vibevalley_git::LineKind::Added => {
                                patch.push('+');
                                patch.push_str(&line.text);
                                patch.push('\n');
                            }
                            vibevalley_git::LineKind::Removed => {
                                patch.push('-');
                                patch.push_str(&line.text);
                                patch.push('\n');
                            }
                            vibevalley_git::LineKind::NoNewline => {
                                patch.push_str(&line.text);
                                patch.push('\n');
                            }
                        }
                    }
                }
            }
            vibevalley_protocol::ChangedFile {
                path,
                status: change_code(f.change).into(),
                added: i64::from(f.added),
                removed: i64::from(f.removed),
                patch: (!patch.is_empty()).then_some(patch),
            }
        };

        let mut files: Vec<vibevalley_protocol::ChangedFile> = uncommitted_diffs.into_iter().map(&format_file_diff).collect();
        let mut seen: std::collections::HashSet<String> = files.iter().map(|f| f.path.clone()).collect();
        for f in committed_diffs {
            let cf = format_file_diff(f);
            if seen.insert(cf.path.clone()) {
                files.push(cf);
            }
        }
        let commits: Vec<vibevalley_protocol::Commit> = git_commits
            .into_iter()
            .map(|c| vibevalley_protocol::Commit {
                hash: c.short_id,
                subject: c.summary,
                at: c.time.saturating_mul(1000),
            })
            .collect();
        let revision = status.head.as_deref().map(|head| vibevalley_protocol::ReviewRevision {
            base_commit: head.to_string(),
            tree: String::new(),
        });
        Ok(vibevalley_protocol::Changes {
            repo: repo_label.to_string(),
            base: base_label,
            branch: status.branch,
            commits,
            revision,
            since_review: None,
            files,
            uncommitted,
            conflicts: vec![],
            behind: 0,
        })
    }

    /// Zero-I/O snapshot of known repo health inputs populated on repo create/mount/summary scans.
    pub fn cached_health_inputs(&self) -> Vec<vibevalley_core::RepoHealthInput> {
        self.state
            .lock()
            .health_inputs
            .iter()
            .map(|(name, last_commit_at)| vibevalley_core::RepoHealthInput {
                name: name.clone(),
                last_commit_at: *last_commit_at,
            })
            .collect()
    }

    pub async fn summary_async(&self, p: RepoFolder) -> RepoSummary {
        let max_sessions = self.max_sessions();
        let pull_request = self.capability(&p.name);
        let summary = crate::log::spawn_blocking_traced(move || summary_of(p, max_sessions, pull_request))
            .await
            .unwrap_or_else(|_| RepoSummary {
                name: String::new(),
                path: String::new(),
                git: false,
                external: false,
                last: None,
                max_sessions,
                pull_request: PullRequestCapability {
                    available: false,
                    reason: t("server.repo.notChecked", &[]),
                },
                health: None,
            });
        if !summary.name.is_empty() {
            self.state.lock().health_inputs.insert(summary.name.clone(), summary.last.map(|s| s * 1000));
        }
        summary
    }

    pub async fn summaries_async(&self) -> Vec<RepoSummary> {
        let folders = self.list_async().await;
        if folders.len() <= 1 {
            let mut out = Vec::with_capacity(folders.len());
            for p in folders {
                out.push(self.summary_async(p).await);
            }
            let next: BTreeMap<String, Option<i64>> = out
                .iter()
                .filter(|s| !s.name.is_empty())
                .map(|s| (s.name.clone(), s.last.map(|sec| sec * 1000)))
                .collect();
            self.state.lock().health_inputs = next;
            return out;
        }
        let max_sessions = self.max_sessions();
        let items: Vec<(usize, RepoFolder, PullRequestCapability)> = folders
            .into_iter()
            .enumerate()
            .map(|(idx, p)| {
                let cap = self.capability(&p.name);
                (idx, p, cap)
            })
            .collect();
        let sem = Arc::new(Semaphore::new(REPO_CONCURRENCY));
        let mut set = JoinSet::new();
        for (idx, p, pull_request) in items {
            let sem = sem.clone();
            set.spawn(
                async move {
                    let Ok(_permit) = sem.acquire_owned().await else { return None };
                    let summary = crate::log::spawn_blocking_traced(move || summary_of(p, max_sessions, pull_request))
                        .await
                        .ok()?;
                    Some((idx, summary))
                }
                .in_current_span()
                .with_current_subscriber(),
            );
        }
        let mut out = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(Some(item)) = joined {
                out.push(item);
            }
        }
        out.sort_by_key(|(idx, _)| *idx);
        let summaries: Vec<RepoSummary> = out.into_iter().map(|(_, s)| s).collect();
        let next: BTreeMap<String, Option<i64>> = summaries
            .iter()
            .filter(|s| !s.name.is_empty())
            .map(|s| (s.name.clone(), s.last.map(|sec| sec * 1000)))
            .collect();
        self.state.lock().health_inputs = next;
        summaries
    }

    /// Creates a new repository by name, either empty or cloned from GitHub.
    pub async fn create_async(&self, req: &NewRepo) -> Result<RepoFolder, ApiError> {
        let problem = repo_problem(req);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        if self.state.lock().mounts.iter().any(|m| m.name == req.name) {
            return Err(refused(t("server.repo.exists", &[("name", req.name.clone().into())])));
        }
        let path = self.root.join(&req.name);
        tokio::fs::create_dir(&path).await.map_err(|e| {
            refused(if e.kind() == std::io::ErrorKind::AlreadyExists {
                t("server.repo.exists", &[("name", req.name.clone().into())])
            } else {
                e.to_string()
            })
        })?;
        self.state.lock().pending.insert(req.name.clone());
        let _pending_guard = PendingGuard {
            repo: self,
            name: req.name.clone(),
        };

        let made = if let Some((_, url)) = req.github.as_deref().and_then(github_repository) {
            let known = self.github_status();
            let known = if known.checked_at != 0 { known } else { self.refresh_github_async().await };
            if known.logged_in && known.auth_mode == GitHubAuthMode::Gh {
                let origin = github_origin(&url);
                let path_text = path.to_string_lossy().into_owned();
                if self.gh_probe.run(&["repo", "clone", &origin, &path_text]).await.ok {
                    Ok(())
                } else {
                    Err(refused(t("server.repo.cloneFailedGh", &[])))
                }
            } else {
                let path = path.clone();
                crate::log::spawn_blocking_traced(move || {
                    vibevalley_git::clone(&url, &path)
                        .map(|_| ())
                        .map_err(|_| refused(t("server.repo.cloneFailed", &[])))
                })
                .await
                .map_err(|e| refused(e.to_string()))
                .and_then(|r| r)
            }
        } else {
            ensure_under_async(&self.root, &req.name).await.map(|_| ())
        };
        drop(_pending_guard);
        match made {
            Ok(()) => {
                let canonical = tokio::fs::canonicalize(&path).await.unwrap_or(path);
                Ok(RepoFolder {
                    name: req.name.clone(),
                    path: canonical,
                    git: true,
                    external: false,
                })
            }
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&path).await;
                Err(e)
            }
        }
    }

    pub async fn list_summaries_async(&self) -> Vec<RepoSummary> {
        self.summaries_async().await
    }

    pub fn validate_repo(&self, req: &NewRepo) -> Validation {
        Validation { problem: repo_problem(req) }
    }

    pub async fn create_repo_async(&self, req: &NewRepo) -> Result<RepoSummary, ApiError> {
        let p = self.create_async(req).await?;
        Ok(self.summary_async(p).await)
    }

    /// Validates and mounts an existing local directory (optionally initializing Git), persisting it across restarts.
    pub async fn mount_repo_async(&self, req: &MountRepo) -> Result<RepoSummary, ApiError> {
        let raw_path = req.path.trim();
        if raw_path.is_empty() {
            return Err(refused(t("server.repo.mount.emptyPath", &[])));
        }
        let path = PathBuf::from(raw_path);
        let meta = match tokio::fs::metadata(&path).await {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(refused(t("server.repo.mount.notFound", &[("path", raw_path.into())])));
            }
            Err(e) => return Err(refused(e.to_string())),
        };
        if !meta.is_dir() {
            return Err(refused(t("server.repo.mount.notDir", &[("path", raw_path.into())])));
        }
        let canon = tokio::fs::canonicalize(&path).await.map_err(|e| refused(e.to_string()))?;

        let _guard = self.mount_lock.lock().await;
        let existing = self.list_async().await;
        if let Some(found) = existing.iter().find(|p| p.path == canon).cloned() {
            if found.git || req.init_git != Some(true) {
                if !found.git {
                    return Err(refused(t("server.repo.mount.notGit", &[("path", canon.display().to_string().into())])));
                }
                return Ok(self.summary_async(found).await);
            }
            init_external_git_async(&canon).await?;
            let updated = RepoFolder { git: true, ..found };
            let status = self.github_status();
            let rest = (status.auth_mode == GitHubAuthMode::Token).then_some(self.github_rest.as_ref()).flatten();
            if status.logged_in
                && let Some(cap) = probe_single_capability_async(&updated.path, true, &self.cancel, rest, &self.gh_probe).await
            {
                self.github.insert_capability(updated.name.clone(), cap);
            }
            return Ok(self.summary_async(updated).await);
        }

        let has_git = tokio::fs::try_exists(canon.join(".git")).await.unwrap_or(false);
        if !has_git {
            if req.init_git == Some(true) {
                init_external_git_async(&canon).await?;
            } else {
                return Err(refused(t("server.repo.mount.notGit", &[("path", canon.display().to_string().into())])));
            }
        }

        let mut taken: HashSet<String> = existing.into_iter().map(|p| p.name).collect();
        let mut next = {
            let state = self.state.lock();
            taken.extend(state.pending.iter().cloned());
            state.mounts.clone()
        };
        let name = if let Some(explicit) = req.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if !good_name(explicit) {
                return Err(refused(t("server.repo.notRepoName", &[("name", explicit.into())])));
            }
            if taken.contains(explicit) {
                return Err(refused(t("server.repo.exists", &[("name", explicit.into())])));
            }
            explicit.to_string()
        } else {
            derive_repo_name(&canon, &taken)
        };

        next.push(MountedRepo {
            name: name.clone(),
            path: canon.clone(),
        });
        write_mounts_async(&self.root.join(MOUNTS_FILE), &next).await?;
        self.state.lock().mounts = next;

        let status = self.github_status();
        let rest = (status.auth_mode == GitHubAuthMode::Token).then_some(self.github_rest.as_ref()).flatten();
        if status.logged_in
            && let Some(cap) = probe_single_capability_async(&canon, true, &self.cancel, rest, &self.gh_probe).await
        {
            self.github.insert_capability(name.clone(), cap);
        }

        Ok(self
            .summary_async(RepoFolder {
                name,
                path: canon,
                git: true,
                external: true,
            })
            .await)
    }

    /// Removes a mounted external repository from the registry without deleting its folder on disk.
    pub async fn unmount_repo_async(&self, id: &str) -> Result<(), ApiError> {
        let _guard = self.mount_lock.lock().await;
        let current = self.state.lock().mounts.clone();
        if current.iter().any(|m| m.name == id) {
            let next: Vec<MountedRepo> = current.into_iter().filter(|m| m.name != id).collect();
            write_mounts_async(&self.root.join(MOUNTS_FILE), &next).await?;
            {
                let mut state = self.state.lock();
                state.mounts = next;
                state.health_inputs.remove(id);
            }
            self.github.remove_capability(id);
            return Ok(());
        }
        if self.find_async(id).await.is_some() {
            return Err(refused(t("server.repo.mount.unmountManaged", &[("name", id.into())])));
        }
        Err(repo_ref(id))
    }

    /// Clears cached GitHub readiness and per-repo PR capability results after token changes.
    pub fn invalidate_github_cache(&self) {
        self.github.invalidate();
    }

    fn has_token(&self) -> bool {
        self.github_rest.as_ref().is_some_and(GitHubRest::has_token)
    }

    /// Spawns a background `gh` capability probe on `task`.
    pub fn probe_in_background(self: &Arc<Repo>, task: &TaskGroup) {
        let weak = Arc::downgrade(self);
        let cancel = task.child_token();
        let handle = task.spawn_named("repo.probe", async move {
            let Some(repos) = weak.upgrade() else { return };
            if !cancel.is_cancelled() && !repos.cancel.is_cancelled() {
                let _ = repos.refresh_github_async().await;
            }
        });
        self.github.set_probe(handle);
    }

    /// Convenience wrapper invoking [`Self::probe_in_background`] on `ctx.task`.
    pub fn probe_in_context(self: &Arc<Repo>, ctx: &Context) {
        self.probe_in_background(&ctx.task);
    }

    pub(super) fn capability(&self, name: &str) -> PullRequestCapability {
        self.github.capability(name)
    }

    pub fn github_status(&self) -> GitHubStatus {
        if let Some(s) = self.github.status()
            && s.checked_at != 0
        {
            return s;
        }
        if self.has_token() {
            return GitHubStatus {
                logged_in: true,
                auth_mode: GitHubAuthMode::Token,
                reason: String::new(),
                ..Default::default()
            };
        }
        GitHubStatus {
            auth_mode: GitHubAuthMode::None,
            reason: t("server.repo.github.unchecked", &[]),
            ..Default::default()
        }
    }

    /// Re-probes GitHub Token / `gh` readiness and refreshes each repo's pull request capability with bounded fan-out.
    pub async fn refresh_github_async(&self) -> GitHubStatus {
        let rest = self.github_rest.clone();
        let gh = self.gh_probe.clone();
        let probed = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return self.github_status(),
            status = probe_github_with_runner_async(&gh, rest.as_ref()) => status,
        };
        let folders: Vec<(String, PathBuf, bool)> = self.list_async().await.into_iter().map(|p| (p.name, p.path, p.git)).collect();
        let next = probe_capabilities_for_folders_async(folders, &probed, &self.cancel, rest, &gh, REPO_CONCURRENCY).await;
        self.github.set_status_and_capabilities(probed.clone(), next);
        probed
    }
}

async fn init_external_git_async(canon: &Path) -> Result<(), ApiError> {
    let p_git = canon.to_path_buf();
    let initial_short = t("server.repo.commit.initialShort", &[]);
    crate::log::spawn_blocking_traced(move || {
        vibevalley_git::init(&p_git, Some("main")).map_err(|e| refused(reason(&e.to_string())))?;
        if vibevalley_git::read::head(&p_git).ok().flatten().is_none() {
            let _ = git_raw(&p_git, &["add", "-A"]);
            commit(&p_git, &initial_short)?;
        }
        Ok::<_, ApiError>(())
    })
    .await
    .map_err(|e| refused(e.to_string()))?
}

pub(super) async fn is_dir_or_dir_symlink_async(entry: &tokio::fs::DirEntry) -> bool {
    let Ok(ft) = entry.file_type().await else { return false };
    if ft.is_dir() {
        return true;
    }
    ft.is_symlink() && tokio::fs::metadata(entry.path()).await.is_ok_and(|m| m.is_dir())
}

async fn list_folders_async(root: &Path, pending: &HashSet<String>) -> Vec<RepoFolder> {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else { return vec![] };
    let mut out = Vec::new();
    while let Ok(Some(e)) = entries.next_entry().await {
        if !is_dir_or_dir_symlink_async(&e).await {
            continue;
        }
        let Ok(name) = e.file_name().into_string() else { continue };
        if name.starts_with('.') || pending.contains(&name) {
            continue;
        }
        let Ok(path) = tokio::fs::canonicalize(e.path()).await else { continue };
        let git = tokio::fs::try_exists(path.join(".git")).await.unwrap_or(false);
        out.push(RepoFolder {
            name,
            path,
            git,
            external: false,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn summary_of(p: RepoFolder, max_sessions: i64, pull_request: PullRequestCapability) -> RepoSummary {
    let last = if p.git {
        seconds_of(&git_quiet(&p.path, &["log", "--all", "-1", "--format=%at"]))
    } else {
        0
    };
    RepoSummary {
        name: p.name,
        path: p.path.to_string_lossy().into_owned(),
        git: p.git,
        external: p.external,
        last: (last > 0).then_some(last),
        max_sessions,
        pull_request,
        health: None,
    }
}

async fn ensure_under_async(repos_root: &Path, name: &str) -> Result<PathBuf, ApiError> {
    if !good_name(name) {
        return Err(refused(t("server.repo.notRepoName", &[("name", name.into())])));
    }
    let made = repos_root.join(name);
    tokio::fs::create_dir_all(&made).await.map_err(|e| refused(e.to_string()))?;
    let path = tokio::fs::canonicalize(&made).await.map_err(|e| refused(e.to_string()))?;
    let root = tokio::fs::canonicalize(repos_root).await.map_err(|e| refused(e.to_string()))?;
    if path.parent() != Some(root.as_path()) {
        return Err(refused(t("server.repo.outside", &[])));
    }
    if !tokio::fs::try_exists(path.join(".git")).await.unwrap_or(false) {
        let p_git = path.clone();
        crate::log::spawn_blocking_traced(move || vibevalley_git::init(&p_git, Some("main")).map_err(|e| refused(reason(&e.to_string()))))
            .await
            .map_err(|e| refused(e.to_string()))??;
        if !tokio::fs::try_exists(path.join(".gitignore")).await.unwrap_or(false) {
            tokio::fs::write(path.join(".gitignore"), GITIGNORE).await.map_err(|e| refused(e.to_string()))?;
        }
        let mut others = 0usize;
        if let Ok(mut d) = tokio::fs::read_dir(&path).await {
            while let Ok(Some(e)) = d.next_entry().await {
                if e.file_name() != ".git" {
                    others += 1;
                }
            }
        }
        if others <= 1 {
            tokio::fs::write(path.join("README.md"), format!("# {name}\n"))
                .await
                .map_err(|e| refused(e.to_string()))?;
        }
        let p_commit = path.clone();
        let initial = t("server.repo.commit.initial", &[]);
        crate::log::spawn_blocking_traced(move || {
            git(&p_commit, &["add", "-A"])?;
            commit(&p_commit, &initial)
        })
        .await
        .map_err(|e| refused(e.to_string()))??;
    } else {
        let p_check = path.clone();
        let initial_short = t("server.repo.commit.initialShort", &[]);
        crate::log::spawn_blocking_traced(move || {
            if vibevalley_git::read::head(&p_check).ok().flatten().is_none() {
                commit(&p_check, &initial_short)?;
            }
            Ok::<_, ApiError>(())
        })
        .await
        .map_err(|e| refused(e.to_string()))??;
    }
    Ok(path)
}

/// Commits as the user, falling back to the farm author identity.
fn commit(path: &Path, message: &str) -> Result<(), ApiError> {
    if git_raw(path, &["commit", "-q", "--allow-empty", "-m", message]).is_ok_and(|r| r.ok()) {
        return Ok(());
    }
    let farm = ["-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"];
    let mut args = farm.to_vec();
    args.extend(["commit", "-q", "--allow-empty", "-m", message]);
    git(path, &args).map(|_| ())
}

pub(super) fn repo_ref(id: &str) -> ApiError {
    missing(t("server.repoRef", &[("id", id.into())]), LookIn::Repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mounts_external_local_repo_persists_handles_collisions_and_unmounts_safely() {
        let work = tempfile::tempdir().unwrap();
        let ext_root = tempfile::tempdir().unwrap();

        // 1. Create an external git repository with an initial commit and Cargo.toml.
        let ext_one = ext_root.path().join("demo-app");
        std::fs::create_dir_all(&ext_one).unwrap();
        std::fs::write(ext_one.join("Cargo.toml"), "[package]\nname = \"demo-app\"\n").unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&ext_one)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::process::Command::new("git")
                .args(["-c", "user.name=tester", "-c", "user.email=tester@example.com", "add", "-A"])
                .current_dir(&ext_one)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::process::Command::new("git")
                .args(["-c", "user.name=tester", "-c", "user.email=tester@example.com", "commit", "-q", "-m", "init"])
                .current_dir(&ext_one)
                .status()
                .unwrap()
                .success()
        );

        // 2. Create a second external folder with the same basename without git.
        let ext_two_parent = ext_root.path().join("other");
        let ext_two = ext_two_parent.join("demo-app");
        std::fs::create_dir_all(&ext_two).unwrap();
        std::fs::write(ext_two.join("package.json"), "{\"scripts\":{\"test\":\"vitest\"}}\n").unwrap();

        // 3. Create a symlink under `<work>/repos` pointing to another external git repo.
        let linked_target = ext_root.path().join("linked-repo");
        std::fs::create_dir_all(&linked_target).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&linked_target)
                .status()
                .unwrap()
                .success()
        );
        #[cfg(unix)]
        {
            std::fs::create_dir_all(work.path().join("repos")).unwrap();
            std::os::unix::fs::symlink(&linked_target, work.path().join("repos/linked-repo")).unwrap();
        }

        let repo = Repo::open_async(work.path(), 3).await.unwrap();

        // Mount external git repo -> succeeds, external = true, canonical path.
        let mounted = repo
            .mount_repo_async(&MountRepo {
                path: ext_one.display().to_string(),
                name: None,
                init_git: None,
            })
            .await
            .unwrap();
        assert_eq!(mounted.name, "demo-app");
        assert!(mounted.external);
        assert!(mounted.git);
        let canon_one = std::fs::canonicalize(&ext_one).unwrap();
        assert_eq!(mounted.path, canon_one.to_string_lossy());

        // Idempotent re-mount returns the existing entry without duplicating.
        let mounted_again = repo
            .mount_repo_async(&MountRepo {
                path: ext_one.display().to_string(),
                name: None,
                init_git: None,
            })
            .await
            .unwrap();
        assert_eq!(mounted_again.name, "demo-app");
        assert_eq!(repo.name_for_path_async(&ext_one).await.as_deref(), Some("demo-app"));

        // Non-git folder is refused unless init_git = Some(true).
        let refused_non_git = repo
            .mount_repo_async(&MountRepo {
                path: ext_two.display().to_string(),
                name: None,
                init_git: None,
            })
            .await
            .unwrap_err();
        assert_eq!(refused_non_git.biz_code, BizCode::RepoRefused);

        // Mounting with init_git = Some(true) initializes git and avoids name collision -> demo-app-2.
        let mounted_two = repo
            .mount_repo_async(&MountRepo {
                path: ext_two.display().to_string(),
                name: None,
                init_git: Some(true),
            })
            .await
            .unwrap();
        assert_eq!(mounted_two.name, "demo-app-2");
        assert!(mounted_two.external);
        assert!(mounted_two.git);
        assert!(ext_two.join(".git").exists());

        // Activity, stack, summaries, and contributions work on mounted repos and symlinks.
        let summaries = repo.list_summaries_async().await;
        assert!(summaries.iter().any(|s| s.name == "demo-app" && s.external));
        assert!(summaries.iter().any(|s| s.name == "demo-app-2" && s.external));
        #[cfg(unix)]
        assert!(summaries.iter().any(|s| s.name == "linked-repo" && !s.external && s.git));

        let activity = repo.activity_endpoint_async("demo-app").await.unwrap();
        assert_eq!(activity.total, 1);
        let stack = repo.stack_async("demo-app").await.unwrap();
        assert_eq!(stack.name, "rust");
        let contribs = repo.contributions_async(vec!["tester@example.com".into()]).await;
        assert!(contribs.iter().any(|c| c.path == canon_one.to_string_lossy() && c.commits == 1));
        repo.close_async().await;

        // Re-opening persists mounts from .mounts.json.
        let reopened = Repo::open_async(work.path(), 3).await.unwrap();
        assert_eq!(reopened.mounted_path("demo-app").as_deref(), Some(canon_one.as_path()));
        assert!(reopened.find_async("demo-app-2").await.is_some());

        // Unmounting removes from registry without deleting user's folder.
        reopened.unmount_repo_async("demo-app").await.unwrap();
        assert!(canon_one.exists());
        assert!(reopened.find_async("demo-app").await.is_none());

        // Refuses unmounting a managed repo.
        let managed = reopened
            .create_repo_async(&NewRepo {
                name: "managed".into(),
                github: None,
            })
            .await
            .unwrap();
        assert!(!managed.external);
        let err = reopened.unmount_repo_async("managed").await.unwrap_err();
        assert_eq!(err.biz_code, BizCode::RepoRefused);
        reopened.close_async().await;
    }

    #[test]
    fn validates_repo_names() {
        assert!(good_name("vibevalley") && good_name("a.b-c_d") && !good_name(".x") && !good_name("a b"));
    }

    async fn spawn_github_mock_async(router: axum::Router) -> (String, tokio_util::sync::DropGuard) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
        });
        (format!("http://{addr}"), guard)
    }

    fn init_git_with_github_origin(dir: &Path, remote_repo: &str) {
        std::fs::create_dir_all(dir).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["remote", "add", "origin", &format!("https://github.com/{remote_repo}.git")],
        ] {
            assert!(std::process::Command::new("git").args(&args).current_dir(dir).status().unwrap().success());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn github_status_distinguishes_token_gh_and_unconfigured_modes() {
        use axum::Json;
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::get;

        use super::super::github::Run;
        use crate::setting::Secret;

        vibevalley_i18n::set_locale("en");
        let missing_gh = GhProbe::Custom(Arc::new(|_| Run {
            ok: false,
            out: String::new(),
            err: String::new(),
        }));
        let logged_gh = GhProbe::Custom(Arc::new(|args| match args.first().copied() {
            Some("--version") => Run {
                ok: true,
                out: "gh version 2.62.0 (2025-01-01)\n".into(),
                err: String::new(),
            },
            Some("auth") => Run {
                ok: true,
                out: "github.com\n  ✓ Logged in to github.com account cli-user (oauth_token)\n".into(),
                err: String::new(),
            },
            _ => Run {
                ok: false,
                out: String::new(),
                err: String::new(),
            },
        }));

        let router = axum::Router::new()
            .route(
                "/user",
                get(|headers: HeaderMap| async move {
                    if headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer ghp_valid") {
                        (StatusCode::OK, Json(serde_json::json!({ "login": "octocat" })))
                    } else {
                        (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "message": "Bad credentials" })))
                    }
                }),
            )
            .route(
                "/repos/acme/writable",
                get(|| async { Json(serde_json::json!({ "permissions": { "push": true } })) }),
            )
            .route(
                "/repos/acme/readonly",
                get(|| async { Json(serde_json::json!({ "permissions": { "push": false } })) }),
            );
        let (base_url, _guard) = spawn_github_mock_async(router).await;

        let work_token = tempfile::tempdir().unwrap();
        init_git_with_github_origin(&work_token.path().join("repos/writable"), "acme/writable");
        init_git_with_github_origin(&work_token.path().join("repos/readonly"), "acme/readonly");
        let rest = GitHubRest::with_base(base_url.clone(), Arc::new(|| Some(Secret::new("ghp_valid"))));
        let repo_token = Repo::open_with_github_for_test(work_token.path(), Some(rest), missing_gh.clone()).await;
        let status_token = repo_token.refresh_github_async().await;
        assert_eq!(status_token.auth_mode, GitHubAuthMode::Token);
        assert!(status_token.logged_in);
        assert!(!status_token.installed);
        assert_eq!(status_token.account.as_deref(), Some("octocat"));
        let summaries = repo_token.list_summaries_async().await;
        let writable = summaries.iter().find(|s| s.name == "writable").unwrap();
        let readonly = summaries.iter().find(|s| s.name == "readonly").unwrap();
        assert!(writable.pull_request.available);
        assert!(!readonly.pull_request.available);
        repo_token.close_async().await;

        let work_bad = tempfile::tempdir().unwrap();
        let bad_rest = GitHubRest::with_base(base_url, Arc::new(|| Some(Secret::new("ghp_invalid"))));
        let repo_bad = Repo::open_with_github_for_test(work_bad.path(), Some(bad_rest), missing_gh.clone()).await;
        let status_bad = repo_bad.refresh_github_async().await;
        assert_eq!(status_bad.auth_mode, GitHubAuthMode::None);
        assert!(!status_bad.logged_in);
        assert_eq!(status_bad.reason, t("server.repo.github.tokenInvalid", &[]));
        repo_bad.close_async().await;

        let work_gh = tempfile::tempdir().unwrap();
        let repo_gh = Repo::open_with_github_for_test(work_gh.path(), None, logged_gh).await;
        let status_gh = repo_gh.refresh_github_async().await;
        assert_eq!(status_gh.auth_mode, GitHubAuthMode::Gh);
        assert!(status_gh.installed);
        assert!(status_gh.logged_in);
        assert_eq!(status_gh.account.as_deref(), Some("cli-user"));
        repo_gh.close_async().await;

        let work_none = tempfile::tempdir().unwrap();
        let repo_none = Repo::open_with_github_for_test(work_none.path(), None, missing_gh).await;
        let status_none = repo_none.refresh_github_async().await;
        assert_eq!(status_none.auth_mode, GitHubAuthMode::None);
        assert!(!status_none.installed);
        assert!(!status_none.logged_in);
        assert_eq!(status_none.reason, t("server.repo.github.noneConfigured", &[]));
        repo_none.close_async().await;
    }
}
