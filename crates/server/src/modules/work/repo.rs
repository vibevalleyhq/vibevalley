//! `repo.*` and `github.*`: the repositories under `<work root>/repos`,
//! made or cloned by name, their activity and languages, and whether gh
//! can open pull requests on them.
//!
//! git is the system binary (as everywhere in VibeValley); the calls here
//! (`init`, `clone`, `log --all`) are ones `vibevalley-git` does not offer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Author, BizCode, DayCount, GitHubStatus, IssueTemplate, JsNumber, LanguageCount, MAX_RUNNING, NewRepo, PullRequestCapability, RepoActivity,
    RepoLanguages, RepoStack, RepoSummary, RepoTemplates, TemplateBlank, TemplateKind, Validation, ops,
};

use crate::base::{LookIn, missing};
use crate::{Hub, now};

const GITIGNORE: &str = "node_modules/\ndist/\nbuild/\n.env\n.env.*\n!.env.example\n.DS_Store\n__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n";
const YEAR_DAYS: i64 = 53 * 7;
const LEFT_OUT: [&str; 25] = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
    "*.min.js",
    "*.min.css",
    "*.map",
    "node_modules/",
    "vendor/",
    "dist/",
    "build/",
    "target/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".next/",
    "coverage/",
];

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::RepoRefused, text)
}

/// `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`.
pub fn good_name(name: &str) -> bool {
    let mut c = name.chars();
    c.next().is_some_and(|f| f.is_ascii_alphanumeric()) && name.len() <= 64 && c.all(|x| x.is_ascii_alphanumeric() || matches!(x, '_' | '.' | '-'))
}

/// `githubRepository`: a GitHub home URL as its name and clone URL.
pub fn github_repository(input: &str) -> Option<(String, String)> {
    let rest = input.trim().strip_prefix("https://github.com/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    let owner_ok = !owner.is_empty() && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let name_ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if !owner_ok || !name_ok {
        return None;
    }
    let name = name.strip_suffix(".git").unwrap_or(name);
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    Some((name.into(), format!("https://github.com/{owner}/{name}.git")))
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

/// `githubOrigin`: `owner/name` of a GitHub remote, else "".
pub fn github_origin(origin: &str) -> String {
    let o = origin.trim();
    let rest = ["git@github.com:", "https://github.com/", "ssh://git@github.com/", "http://github.com/"]
        .iter()
        .find_map(|p| o.strip_prefix(p));
    let Some(rest) = rest else { return String::new() };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    match rest.split_once('/') {
        Some((a, b)) if !a.is_empty() && !b.is_empty() && !b.contains('/') => rest.into(),
        _ => String::new(),
    }
}

struct Run {
    ok: bool,
    out: String,
    err: String,
    missing: bool,
}

fn run(program: &str, args: &[&str], cwd: Option<&Path>, env: &[(&str, &str)]) -> Run {
    let mut c = Command::new(program);
    c.args(args).stdin(Stdio::null());
    if let Some(cwd) = cwd {
        c.current_dir(cwd);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    match c.output() {
        Ok(o) => Run {
            ok: o.status.success(),
            out: String::from_utf8_lossy(&o.stdout).into_owned(),
            err: String::from_utf8_lossy(&o.stderr).into_owned(),
            missing: false,
        },
        Err(e) => Run {
            ok: false,
            out: String::new(),
            err: e.to_string(),
            missing: e.kind() == std::io::ErrorKind::NotFound,
        },
    }
}

fn open_repo(cwd: &Path) -> Option<vibevalley_git::Repo> {
    vibevalley_git::Repo::discover(cwd).ok().flatten()
}

fn git_raw(cwd: &Path, args: &[&str]) -> Result<vibevalley_git::RawOutput, ApiError> {
    let repo = open_repo(cwd).ok_or_else(|| refused(format!("{} is not a git repository", cwd.display())))?;
    repo.run(args).map_err(|e| refused(e.to_string()))
}

/// `gitQuiet`: git's trimmed output, "" when it fails.
fn git_quiet(cwd: &Path, args: &[&str]) -> String {
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

/// `reason`: the last line git said.
fn reason(err: &str) -> String {
    err.trim().lines().last().unwrap_or("").to_string()
}

/// `secondsOf`: a unix time in seconds as milliseconds, 0 when none.
fn seconds_of(text: &str) -> i64 {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| (n * 1000.0) as i64)
        .unwrap_or(0)
}

fn local_day(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms)
        .map(|ts| ts.to_zoned_datetime(jiff::tz::TimeZone::system()).strftime("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Case ignored first, then by bytes.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// `activityOf`: commits per day and per author from `%at\t%aN` lines.
pub fn activity_of(log: &str, day_of: impl Fn(i64) -> String) -> (Vec<DayCount>, Vec<Author>) {
    let mut by_day: HashMap<String, i64> = HashMap::new();
    let mut by_author: HashMap<String, i64> = HashMap::new();
    for line in log.lines() {
        let Some((at, name)) = line.split_once('\t') else { continue };
        let Ok(seconds) = at.trim().parse::<f64>() else { continue };
        if !seconds.is_finite() || seconds <= 0.0 {
            continue;
        }
        *by_day.entry(day_of((seconds * 1000.0) as i64)).or_default() += 1;
        let name = if name.trim().is_empty() {
            t("server.repo.noName", &[])
        } else {
            name.trim().to_string()
        };
        *by_author.entry(name).or_default() += 1;
    }
    let mut days: Vec<DayCount> = by_day.into_iter().map(|(day, commits)| DayCount { day, commits }).collect();
    days.sort_by(|a, b| a.day.cmp(&b.day));
    let mut authors: Vec<Author> = by_author.into_iter().map(|(name, commits)| Author { name, commits }).collect();
    authors.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| locale_compare(&a.name, &b.name)));
    (days, authors)
}

/// `countsOf`: tokei's JSON, its total and blank-only languages left out.
pub fn counts_of(output: &str) -> Option<Vec<LanguageCount>> {
    let raw: serde_json::Map<String, Value> = serde_json::from_str(output).ok()?;
    let mut out = Vec::new();
    for (name, l) in raw {
        let (code, comments, blanks) = (l["code"].as_f64()?, l["comments"].as_f64()?, l["blanks"].as_f64()?);
        let files = l["reports"].as_array()?.len() as i64;
        if name == "Total" || code + comments <= 0.0 {
            continue;
        }
        out.push(LanguageCount {
            name,
            files,
            code: code as i64,
            comments: comments as i64,
            blanks: blanks as i64,
        });
    }
    out.sort_by(|a, b| (b.code + b.comments).cmp(&(a.code + a.comments)).then_with(|| locale_compare(&a.name, &b.name)));
    Some(out)
}

fn gh(args: &[&str]) -> Run {
    let mut r = run("gh", args, None, &[("GH_HOST", "github.com"), ("GH_PROMPT_DISABLED", "1")]);
    r.out = format!("{}{}", r.out, r.err);
    r
}

/// `probeGitHub`.
pub fn probe_github() -> GitHubStatus {
    let mut s = GitHubStatus {
        checked_at: now(),
        ..Default::default()
    };
    let version = gh(&["--version"]);
    if !version.ok {
        s.reason = t(if version.missing { "server.repo.gh.missing" } else { "server.repo.gh.failed" }, &[]);
        return s;
    }
    s.installed = true;
    s.version = version
        .out
        .lines()
        .find_map(|l| l.strip_prefix("gh version "))
        .and_then(|rest| rest.split_whitespace().next())
        .map(str::to_string);
    let auth = gh(&["auth", "status", "--hostname", "github.com", "--active"]);
    if !auth.ok {
        s.reason = t("server.repo.gh.signedOut", &[]);
        return s;
    }
    let account = auth.out.split("Logged in to github.com account ").nth(1).and_then(|rest| {
        let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        (!name.is_empty()).then_some(name)
    });
    match account {
        Some(a) => {
            s.logged_in = true;
            s.account = Some(a);
        }
        None => s.reason = t("server.repo.gh.noAccount", &[]),
    }
    s
}

/// A folder under the repos root.
#[derive(Debug, Clone)]
pub struct RepoFolder {
    pub name: String,
    pub path: PathBuf,
    pub git: bool,
}

pub struct Repos {
    root: PathBuf,
    per_repo: usize,
    tokei: String,
    github: Mutex<Option<GitHubStatus>>,
    capabilities: Mutex<HashMap<String, PullRequestCapability>>,
    /// One change at a time per repo name; names being made are not listed.
    pending: Mutex<std::collections::HashSet<String>>,
    closed: AtomicBool,
    probe: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Repos {
    /// The repos under `<work_root>/repos` (made when missing).
    pub fn open(work_root: &Path, per_repo: usize) -> std::io::Result<Arc<Repos>> {
        let root = work_root.join("repos");
        std::fs::create_dir_all(&root)?;
        Ok(Arc::new(Repos {
            root,
            per_repo,
            tokei: "tokei".into(),
            github: Mutex::default(),
            capabilities: Mutex::default(),
            pending: Mutex::default(),
            closed: AtomicBool::new(false),
            probe: Mutex::default(),
        }))
    }

    pub fn probe_in_background(self: &Arc<Repos>) {
        let weak = Arc::downgrade(self);
        if let Ok(handle) = std::thread::Builder::new().name("vibevalley-github-probe".into()).spawn(move || {
            let Some(repos) = weak.upgrade() else { return };
            if !repos.closed.load(Ordering::Relaxed) {
                repos.refresh_github();
            }
        }) {
            *self.probe.lock() = Some(handle);
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        if let Some(handle) = self.probe.lock().take() {
            let _ = handle.join();
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn max_sessions(&self) -> i64 {
        let n = self.per_repo;
        (if n == 0 || n > MAX_RUNNING { MAX_RUNNING } else { n }) as i64
    }

    /// The folders under the root; links are not repos.
    pub fn list(&self) -> Vec<RepoFolder> {
        let Ok(entries) = std::fs::read_dir(&self.root) else { return vec![] };
        let pending = self.pending.lock().clone();
        let mut out: Vec<RepoFolder> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                if name.starts_with('.') || pending.contains(&name) {
                    return None;
                }
                let path = std::fs::canonicalize(e.path()).ok()?;
                let git = path.join(".git").exists();
                Some(RepoFolder { name, path, git })
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub fn find(&self, name: &str) -> Option<RepoFolder> {
        self.list().into_iter().find(|p| p.name == name)
    }

    fn capability(&self, name: &str) -> PullRequestCapability {
        if let Some(c) = self.capabilities.lock().get(name) {
            return c.clone();
        }
        let status = self.github.lock().clone();
        match status {
            Some(s) if !s.reason.is_empty() => PullRequestCapability {
                available: false,
                reason: s.reason,
            },
            _ => PullRequestCapability {
                available: false,
                reason: t("server.repo.notChecked", &[]),
            },
        }
    }

    pub fn summary(&self, p: &RepoFolder) -> RepoSummary {
        let last = if p.git {
            seconds_of(&git_quiet(&p.path, &["log", "--all", "-1", "--format=%at"]))
        } else {
            0
        };
        RepoSummary {
            name: p.name.clone(),
            path: p.path.to_string_lossy().into_owned(),
            git: p.git,
            last: (last > 0).then_some(last),
            max_sessions: self.max_sessions(),
            pull_request: self.capability(&p.name),
        }
    }

    pub fn summaries(&self) -> Vec<RepoSummary> {
        self.list().iter().map(|p| self.summary(p)).collect()
    }

    /// The repo's folder, a repository with a first commit (`ensure`).
    pub fn ensure(&self, name: &str) -> Result<PathBuf, ApiError> {
        if !good_name(name) {
            return Err(refused(t("server.repo.notRepoName", &[("name", name.into())])));
        }
        let made = self.root.join(name);
        std::fs::create_dir_all(&made).map_err(|e| refused(e.to_string()))?;
        let path = std::fs::canonicalize(&made).map_err(|e| refused(e.to_string()))?;
        let root = std::fs::canonicalize(&self.root).map_err(|e| refused(e.to_string()))?;
        if path.parent() != Some(root.as_path()) {
            return Err(refused(t("server.repo.outside", &[])));
        }
        if !path.join(".git").exists() {
            vibevalley_git::init(&path, Some("main")).map_err(|e| refused(reason(&e.to_string())))?;
            if !path.join(".gitignore").exists() {
                std::fs::write(path.join(".gitignore"), GITIGNORE).map_err(|e| refused(e.to_string()))?;
            }
            let others = std::fs::read_dir(&path).map(|d| d.filter_map(Result::ok).filter(|e| e.file_name() != ".git").count());
            if others.unwrap_or(0) <= 1 {
                std::fs::write(path.join("README.md"), format!("# {name}\n")).map_err(|e| refused(e.to_string()))?;
            }
            git(&path, &["add", "-A"])?;
            commit(&path, &t("server.repo.commit.initial", &[]))?;
        } else if !git_raw(&path, &["rev-parse", "--verify", "HEAD"]).is_ok_and(|r| r.ok()) {
            commit(&path, &t("server.repo.commit.initialShort", &[]))?;
        }
        Ok(path)
    }

    /// `create`: a new repo by name, empty or cloned from GitHub.
    pub fn create(&self, req: &NewRepo) -> Result<RepoFolder, ApiError> {
        let problem = repo_problem(req);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let path = self.root.join(&req.name);
        if let Err(e) = std::fs::create_dir(&path) {
            return Err(refused(if e.kind() == std::io::ErrorKind::AlreadyExists {
                t("server.repo.exists", &[("name", req.name.clone().into())])
            } else {
                e.to_string()
            }));
        }
        self.pending.lock().insert(req.name.clone());
        let made = (|| {
            if let Some((_, url)) = req.github.as_deref().and_then(github_repository) {
                let known = self.github_status();
                let known = if known.checked_at != 0 { known } else { self.refresh_github() };
                let path_text = path.to_string_lossy().into_owned();
                if known.logged_in {
                    if !gh(&["repo", "clone", &github_origin(&url), &path_text]).ok {
                        return Err(refused(t("server.repo.cloneFailedGh", &[])));
                    }
                } else {
                    if vibevalley_git::clone(&url, &path).is_err() {
                        return Err(refused(t("server.repo.cloneFailed", &[])));
                    }
                }
                Ok(())
            } else {
                self.ensure(&req.name).map(|_| ())
            }
        })();
        self.pending.lock().remove(&req.name);
        match made {
            Ok(()) => {
                let path = std::fs::canonicalize(&path).unwrap_or(path);
                Ok(RepoFolder {
                    name: req.name.clone(),
                    path,
                    git: true,
                })
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&path);
                Err(e)
            }
        }
    }

    pub fn languages(&self, name: &str) -> Result<Option<RepoLanguages>, ApiError> {
        let Some(p) = self.find(name) else { return Ok(None) };
        let path = p.path.to_string_lossy().into_owned();
        let mut args = vec!["--output", "json"];
        for x in LEFT_OUT {
            args.extend(["--exclude", x]);
        }
        args.push(&path);
        let r = run(&self.tokei, &args, None, &[]);
        if r.missing {
            return Err(refused(t("server.repo.noTokei", &[])));
        }
        if !r.ok {
            return Err(refused(t("server.repo.tokeiFailed", &[("why", reason(&r.err).into())])));
        }
        let languages = counts_of(&r.out).ok_or_else(|| refused(t("server.repo.tokeiUnread", &[])))?;
        Ok(Some(RepoLanguages {
            repo: name.into(),
            at: now(),
            languages,
        }))
    }

    pub fn activity(&self, name: &str) -> Option<RepoActivity> {
        let p = self.find(name)?;
        let at = now();
        let mut out = RepoActivity {
            repo: name.into(),
            at,
            ..Default::default()
        };
        if !p.git {
            return Some(out);
        }
        let since = jiff::Timestamp::from_millisecond(at - YEAR_DAYS * 86_400_000)
            .map(|t| t.to_string())
            .unwrap_or_default();
        let log = git_quiet(&p.path, &["log", "--all", "--no-merges", &format!("--since={since}"), "--format=%at%x09%aN"]);
        let total = git_quiet(&p.path, &["rev-list", "--all", "--no-merges", "--count"]);
        let roots = git_quiet(&p.path, &["log", "--all", "--max-parents=0", "--format=%at"]);
        let last = seconds_of(&git_quiet(&p.path, &["log", "--all", "-1", "--format=%at"]));
        let (days, authors) = activity_of(&log, local_day);
        out.days = days;
        out.authors = authors;
        out.total = total.trim().parse().unwrap_or(0);
        out.first = roots.lines().map(seconds_of).filter(|x| *x > 0).min();
        out.last = (last > 0).then_some(last);
        Some(out)
    }

    pub fn github_status(&self) -> GitHubStatus {
        match self.github.lock().clone() {
            Some(s) if s.checked_at != 0 => s,
            _ => GitHubStatus {
                reason: t("server.repo.github.unchecked", &[]),
                ..Default::default()
            },
        }
    }

    /// `refreshGitHub`: gh probed again, and each repo's pull requests.
    pub fn refresh_github(&self) -> GitHubStatus {
        #[derive(Deserialize)]
        struct ViewerPermission {
            #[serde(rename = "viewerPermission")]
            viewer_permission: Option<String>,
        }

        let probed = probe_github();
        let mut next = HashMap::new();
        for p in self.list() {
            if self.closed.load(Ordering::Relaxed) {
                break;
            }
            let mut c = PullRequestCapability {
                available: false,
                reason: probed.reason.clone(),
            };
            if probed.logged_in {
                let repo = github_origin(&git_quiet(&p.path, &["remote", "get-url", "origin"]));
                c = if !p.git || repo.is_empty() {
                    PullRequestCapability {
                        available: false,
                        reason: t("server.repo.github.notGithub", &[]),
                    }
                } else {
                    let view = gh(&["repo", "view", &repo, "--json", "viewerPermission"]);
                    let permission = if view.ok {
                        serde_json::from_str::<ViewerPermission>(&view.out).ok().and_then(|v| v.viewer_permission)
                    } else {
                        None
                    };
                    match permission.as_deref() {
                        None => PullRequestCapability {
                            available: false,
                            reason: t("server.repo.github.noPermission", &[]),
                        },
                        Some("ADMIN" | "MAINTAIN" | "WRITE") => PullRequestCapability {
                            available: true,
                            reason: String::new(),
                        },
                        Some(_) => PullRequestCapability {
                            available: false,
                            reason: t("server.repo.github.readOnly", &[]),
                        },
                    }
                };
            }
            next.insert(p.name, c);
        }
        *self.github.lock() = Some(probed.clone());
        *self.capabilities.lock() = next;
        probed
    }
}

/// A commit as the user, else as the farm (`repository.commit`).
fn commit(path: &Path, message: &str) -> Result<(), ApiError> {
    if git_raw(path, &["commit", "-q", "--allow-empty", "-m", message]).is_ok_and(|r| r.ok()) {
        return Ok(());
    }
    let farm = ["-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"];
    let mut args = farm.to_vec();
    args.extend(["commit", "-q", "--allow-empty", "-m", message]);
    git(path, &args).map(|_| ())
}

fn repo_ref(id: &str) -> ApiError {
    missing(t("server.repoRef", &[("id", id.into())]), LookIn::Repo)
}

/// Folders `repo_dirs` does not look into.
const SKIP_DIRS: [&str; 8] = ["node_modules", ".git", ".venv", "vendor", "dist", "build", "target", ".next"];

/// `repoDirs`: the repositories under dir, at most depth folders down; a
/// repository's own folders are not looked into.
fn repo_dirs(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let entries: Vec<_> = entries.flatten().collect();
    if entries.iter().any(|e| e.file_name() == ".git") {
        return vec![dir.to_path_buf()];
    }
    if depth == 0 {
        return vec![];
    }
    let mut out = vec![];
    for e in entries {
        let name = e.file_name();
        if e.file_type().is_ok_and(|t| t.is_dir()) && !SKIP_DIRS.iter().any(|s| name == *s) {
            out.extend(repo_dirs(&e.path(), depth - 1));
        }
    }
    out.sort();
    out
}

fn global_email() -> String {
    std::process::Command::new("git")
        .args(["config", "--global", "user.email"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_lowercase())
        .unwrap_or_default()
}

/// `contributionsOf`: the user's commits in each repository under `root`
/// (by the global and the repo's own `user.email`, and `extra`).
pub fn contributions_of(root: &Path, extra: &[String]) -> Vec<vibevalley_protocol::Repo> {
    let global = global_email();
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for dir in repo_dirs(root, 3) {
        // Worktrees share their repository's history: one count per repository.
        let common = git_quiet(&dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if common.is_empty() || !seen.insert(common) {
            continue;
        }
        let own = git_quiet(&dir, &["config", "user.email"]).to_lowercase();
        let mine: std::collections::HashSet<String> = [global.clone(), own]
            .into_iter()
            .chain(extra.iter().map(|e| e.trim().to_lowercase()))
            .filter(|e| !e.is_empty())
            .collect();
        let emails = git_quiet(&dir, &["log", "--all", "--format=%ae"]);
        let commits = emails.lines().filter(|e| !e.is_empty() && mine.contains(&e.to_lowercase())).count() as i64;
        let top = git_quiet(&dir, &["rev-parse", "--show-toplevel"]);
        out.push(vibevalley_protocol::Repo {
            path: if top.is_empty() { dir.display().to_string() } else { top },
            commits,
        });
    }
    out
}

impl Repos {
    /// `contributions`: the user's commits per repository under the root.
    pub fn contributions(&self, extra: &[String]) -> Vec<vibevalley_protocol::Repo> {
        contributions_of(self.root(), extra)
    }
}

pub fn install(hub: &Hub, repos: Arc<Repos>) {
    let r = repos.clone();
    hub.on::<ops::RepoList>(move |_, ()| Ok(r.summaries()));
    hub.on::<ops::RepoValidate>(move |_, req| Ok(Validation { problem: repo_problem(&req) }));
    let r = repos.clone();
    hub.on::<ops::RepoCreate>(move |_, req| r.create(&req).map(|p| r.summary(&p)));
    let r = repos.clone();
    hub.on::<ops::RepoLanguageList>(move |_, i| r.languages(&i.id)?.ok_or_else(|| repo_ref(&i.id)));
    let r = repos.clone();
    hub.on::<ops::RepoActivityGet>(move |_, i| r.activity(&i.id).ok_or_else(|| repo_ref(&i.id)));
    let r = repos.clone();
    hub.on::<ops::GithubGet>(move |_, ()| Ok(r.github_status()));
    hub.on::<ops::GithubRefresh>(move |_, ()| Ok(repos.refresh_github()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_github_urls() {
        assert!(good_name("vibevalley") && good_name("a.b-c_d") && !good_name(".x") && !good_name("a b"));
        assert_eq!(
            github_repository("https://github.com/botiverse/oar/"),
            Some(("oar".into(), "https://github.com/botiverse/oar.git".into()))
        );
        assert!(github_repository("git@github.com:a/b").is_none());
        assert!(github_repository("https://github.com/a/..").is_none());
        assert_eq!(github_origin("git@github.com:botiverse/oar.git"), "botiverse/oar");
        assert_eq!(github_origin("https://gitlab.com/a/b"), "");
    }

    #[test]
    fn activity_and_counts() {
        let (days, authors) = activity_of("100\tAnn\n200\tbob\n86500\tAnn\nbad\n", |ms| (ms / 86_400_000).to_string());
        assert_eq!(days.iter().map(|d| (d.day.as_str(), d.commits)).collect::<Vec<_>>(), vec![("0", 2), ("1", 1)]);
        assert_eq!(authors[0].name, "Ann");
        let tokei = r#"{"Rust":{"code":10,"comments":2,"blanks":1,"reports":[1,2]},"Total":{"code":10,"comments":2,"blanks":1,"reports":[]},"Text":{"code":0,"comments":0,"blanks":3,"reports":[]}}"#;
        let counts = counts_of(tokei).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!((counts[0].name.as_str(), counts[0].files), ("Rust", 2));
    }
}

const STACK_FILES: [&str; 11] = [
    "go.mod",
    "Cargo.toml",
    "pubspec.yaml",
    "package.json",
    "pyrepo.toml",
    "requirements.txt",
    "setup.py",
    "bun.lock",
    "bun.lockb",
    "pnpm-lock.yaml",
    "yarn.lock",
];

fn stack(name: &str, label: String, test: &str, lint: &str, build: &str) -> RepoStack {
    let some = |s: &str| Some(s.to_string()).filter(|s| !s.is_empty());
    RepoStack {
        name: name.into(),
        label,
        test: some(test),
        lint: some(lint),
        build: some(build),
    }
}

/// `stackOf`: what a repo is built with, from the markers at its root
/// (`files`: marker name → what it says), first one wins.
pub fn stack_of(files: &std::collections::HashMap<&str, String>) -> RepoStack {
    let has = |n: &str| files.contains_key(n);
    if has("go.mod") {
        return stack("go", "Go".into(), "go test ./...", "go vet ./...", "go build ./...");
    }
    if has("Cargo.toml") {
        return stack("rust", "Rust".into(), "cargo test", "cargo clippy", "cargo build");
    }
    if let Some(pubspec) = files.get("pubspec.yaml") {
        return if pubspec.contains("flutter") {
            stack("flutter", "Flutter".into(), "flutter test", "flutter analyze", "")
        } else {
            stack("dart", "Dart".into(), "dart test", "dart analyze", "")
        };
    }
    if let Some(pkg) = files.get("package.json") {
        let pm = if has("bun.lock") || has("bun.lockb") {
            "bun"
        } else if has("pnpm-lock.yaml") {
            "pnpm"
        } else if has("yarn.lock") {
            "yarn"
        } else {
            "npm"
        };
        let scripts: std::collections::HashMap<String, String> = serde_json::from_str::<serde_json::Value>(pkg)
            .ok()
            .and_then(|v| serde_json::from_value(v["scripts"].clone()).ok())
            .unwrap_or_default();
        let run = |s: &str| {
            if scripts.get(s).is_some_and(|v| !v.trim().is_empty()) {
                format!("{pm} run {s}")
            } else {
                String::new()
            }
        };
        let label = t("shared.join.aside", &[("text", "Node".into()), ("aside", pm.into())]);
        return stack("node", label, &run("test"), &run("lint"), &run("build"));
    }
    let pyrepo = files.get("pyrepo.toml");
    if pyrepo.is_some() || has("requirements.txt") || has("setup.py") {
        let lint = if pyrepo.is_some_and(|p| p.contains("ruff")) { "ruff check ." } else { "" };
        return stack("python", "Python".into(), "pytest", lint, "");
    }
    RepoStack {
        name: String::new(),
        label: String::new(),
        test: None,
        lint: None,
        build: None,
    }
}

#[derive(serde::Deserialize)]
struct WrittenTemplate {
    id: String,
    title: String,
    done: String,
}

#[derive(serde::Deserialize)]
struct WrittenKind {
    id: String,
    name: String,
    icon: String,
    templates: Vec<WrittenTemplate>,
}

#[derive(serde::Deserialize)]
struct Catalog {
    kinds: Vec<WrittenKind>,
}

fn catalog() -> Catalog {
    let body = if vibevalley_i18n::locale().starts_with("en") {
        include_str!("../../../assets/agent/template_catalog.en.json")
    } else {
        include_str!("../../../assets/agent/template_catalog.json")
    };
    serde_json::from_str(body).expect("template_catalog.json")
}

/// `filledTemplate`: `{test}`, `{lint}`, `{build}` become the stack's
/// command as code, or the word for it when there is none.
fn filled_template(s: &WrittenTemplate, stack: &RepoStack) -> IssueTemplate {
    static HOLES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let holes = HOLES.get_or_init(|| regex::Regex::new(r"\s?\{(test|lint|build)\}\s?").expect("regex"));
    let done = holes
        .replace_all(&s.done, |c: &regex::Captures| {
            let hole = &c[0];
            let name = &c[1];
            let command = match name {
                "test" => stack.test.as_deref(),
                "lint" => stack.lint.as_deref(),
                _ => stack.build.as_deref(),
            };
            match command {
                Some(cmd) => hole.replace(&format!("{{{name}}}"), &format!("`{cmd}`")),
                None => vibevalley_i18n::maybe(&format!("server.issue.template.commands.{name}")).unwrap_or_else(|| hole.to_string()),
            }
        })
        .into_owned();
    let text = t(
        "server.issue.template.done",
        &[("title", s.title.clone().into()), ("done", done.clone().into())],
    );
    let blank = text.find('〔').and_then(|start| {
        let end = start + text[start..].find('〕')? + '〕'.len_utf8();
        let units = |b: usize| text[..b].encode_utf16().count() as f64;
        Some(TemplateBlank {
            start: JsNumber::from(units(start)),
            end: JsNumber::from(units(end)),
        })
    });
    IssueTemplate {
        id: s.id.clone(),
        title: s.title.clone(),
        done,
        text,
        blank,
    }
}

impl Repos {
    /// `stack`: none when there is no repo by that name.
    pub fn stack(&self, name: &str) -> Option<RepoStack> {
        let p = self.find(name)?;
        let files: std::collections::HashMap<&str, String> = STACK_FILES
            .iter()
            .filter_map(|f| std::fs::read_to_string(p.path.join(f)).ok().map(|body| (*f, body)))
            .collect();
        Some(stack_of(&files))
    }
}

/// `repo.template.list` (`issue.templates`): the stack, the titles last
/// sent there, and the catalog filled with its commands.
pub fn install_templates(hub: &Hub, repos: Arc<Repos>, board: super::issue::Board, agents: Arc<crate::modules::team::agent::Agents>) {
    hub.on::<ops::RepoTemplateList>(move |_, input| {
        let name = input.id;
        let stack = repos
            .stack(&name)
            .ok_or_else(|| missing(t("server.issue.repoRef", &[("name", name.clone().into())]), LookIn::Repo))?;
        let mut mine: Vec<vibevalley_protocol::Issue> = board.read(|s| {
            s.issues
                .iter()
                .filter(|i| {
                    i.repo.as_deref() == Some(name.as_str())
                        && i.was_sent()
                        && i.parent.is_none()
                        && i.cron.is_none()
                        && !i.assigned_agent().is_some_and(|a| agents.profiles.is_orchestrator(a))
                })
                .cloned()
                .collect()
        });
        mine.sort_by_key(|i| std::cmp::Reverse(i.created_at));
        let mut recent: Vec<String> = Vec::new();
        for i in mine {
            let title = i.title.split_whitespace().collect::<Vec<_>>().join(" ");
            if title.is_empty() || title.chars().count() > 60 || recent.contains(&title) {
                continue;
            }
            recent.push(title);
            if recent.len() == 5 {
                break;
            }
        }
        let kinds = catalog()
            .kinds
            .iter()
            .map(|k| TemplateKind {
                id: k.id.clone(),
                name: k.name.clone(),
                icon: k.icon.clone(),
                templates: k.templates.iter().map(|s| filled_template(s, &stack)).collect(),
            })
            .collect();
        Ok(RepoTemplates {
            repo: name,
            stack,
            recent,
            kinds,
        })
    });
}
