//! `repo.*` and `github.*`: the repositories under `<work root>/repos`,
//! created or cloned by name, their activity and languages, and whether `gh`
//! can open pull requests on them.
//!
//! `git` is the system binary (as everywhere in VibeValley); the calls here
//! (`init`, `clone`, `log --all`) are ones `vibevalley-git` does not offer.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
use tracing::instrument::WithSubscriber;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Author, BizCode, DayCount, GitHubAuthMode, GitHubStatus, Issue, IssueTemplate, JsNumber, LanguageCount, MAX_RUNNING, MountRepo, NewRepo,
    PullRequestCapability, RepoActivity, RepoLanguages, RepoStack, RepoSummary, RepoTemplates, TemplateBlank, TemplateKind, Validation,
};

use crate::context::error::{LookIn, missing};
use crate::context::http::no_redirect_client;
use crate::context::task::TaskGroup;
use crate::context::{Context, now};
use crate::setting::{Secret, Setting};

const REPO_CONCURRENCY: usize = 4;

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

/// Parses a GitHub repository URL into `(name, clone_url)`.
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

/// Extracts `owner/name` from a GitHub remote URL, else `""`.
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

async fn run_async(program: &str, args: &[&str], cwd: Option<&Path>, env: &[(&str, &str)]) -> Run {
    let mut c = tokio::process::Command::new(program);
    c.args(args).stdin(Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = cwd {
        c.current_dir(cwd);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    match c.output().await {
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

/// Git trimmed output, or `""` on failure.
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

/// Last line of git stderr output.
fn reason(err: &str) -> String {
    err.trim().lines().last().unwrap_or("").to_string()
}

/// Parses unix time in seconds as milliseconds, or `0` when invalid.
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

/// Case-insensitive comparison with byte-order tiebreaker.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// Commits per day and per author from `%at\t%aN` lines.
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

/// Parses `tokei --output json`, omitting totals and blank-only languages.
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

pub(crate) const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";

pub(crate) type TokenSource = Arc<dyn Fn() -> Option<Secret> + Send + Sync>;

#[derive(Deserialize)]
struct WireGithubError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct WireGithubUser {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct WireGithubRestRepoPermissions {
    #[serde(default)]
    admin: bool,
    #[serde(default)]
    maintain: bool,
    #[serde(default)]
    push: bool,
}

#[derive(Deserialize)]
struct WireGithubRestRepo {
    #[serde(default)]
    permissions: Option<WireGithubRestRepoPermissions>,
}

#[derive(Debug)]
pub(crate) enum GitHubApiError {
    MissingToken,
    Unauthorized,
    Forbidden,
    NotFound,
    Http(u16, String),
    Network(String),
    Decode,
}

impl GitHubApiError {
    pub(crate) fn summary(&self) -> String {
        match self {
            Self::MissingToken => "missing token".into(),
            Self::Unauthorized => "401 unauthorized".into(),
            Self::Forbidden => "403 forbidden".into(),
            Self::NotFound => "404 not found".into(),
            Self::Http(status, msg) if msg.is_empty() => format!("HTTP {status}"),
            Self::Http(status, msg) => format!("HTTP {status}: {msg}"),
            Self::Network(why) => why.clone(),
            Self::Decode => "response decode".into(),
        }
    }
}

/// Direct GitHub REST API client backed by the shared no-redirect `reqwest::Client`.
#[derive(Clone)]
pub(crate) struct GitHubRest {
    api_base: String,
    token: TokenSource,
}

impl std::fmt::Debug for GitHubRest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHubRest")
            .field("api_base", &self.api_base)
            .field("has_token", &self.has_token())
            .finish()
    }
}

impl GitHubRest {
    pub(crate) fn new(token: TokenSource) -> Self {
        Self::with_base(DEFAULT_GITHUB_API_BASE, token)
    }

    pub(crate) fn with_base(api_base: impl Into<String>, token: TokenSource) -> Self {
        Self {
            api_base: api_base.into().trim_end_matches('/').to_string(),
            token,
        }
    }

    pub(crate) fn from_setting(setting: Arc<Setting>) -> Self {
        Self::new(Arc::new(move || setting.github_token()))
    }

    pub(crate) fn token(&self) -> Option<Secret> {
        (self.token)().filter(|s| !s.expose().trim().is_empty())
    }

    pub(crate) fn has_token(&self) -> bool {
        self.token().is_some()
    }

    async fn send_bytes<B: Serialize + Sync>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&B>,
    ) -> Result<(u16, Vec<u8>), GitHubApiError> {
        let token = self.token().ok_or(GitHubApiError::MissingToken)?;
        let url = format!("{}{}", self.api_base, path);
        let client = no_redirect_client().map_err(GitHubApiError::Network)?;
        let mut req = client
            .request(method, &url)
            .timeout(Duration::from_secs(15))
            .header("authorization", format!("Bearer {}", token.expose().trim()))
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "vibevalley")
            .header("x-github-api-version", "2022-11-28");
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(payload) = body {
            req = req.json(payload);
        }
        let resp = req.send().await.map_err(|e| GitHubApiError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.map_err(|e| GitHubApiError::Network(e.to_string()))?.to_vec();
        match status {
            200..=299 => Ok((status, bytes)),
            401 => Err(GitHubApiError::Unauthorized),
            403 => Err(GitHubApiError::Forbidden),
            404 => Err(GitHubApiError::NotFound),
            s => {
                let message = serde_json::from_slice::<WireGithubError>(&bytes)
                    .map(|e| e.message)
                    .unwrap_or_default();
                Err(GitHubApiError::Http(s, message))
            }
        }
    }

    pub(crate) async fn get_json<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T, GitHubApiError> {
        let (_, bytes) = self.send_bytes(reqwest::Method::GET, path, query, Option::<&()>::None).await?;
        serde_json::from_slice(&bytes).map_err(|_| GitHubApiError::Decode)
    }

    pub(crate) async fn post_json<B: Serialize + Sync, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T, GitHubApiError> {
        let (_, bytes) = self.send_bytes(reqwest::Method::POST, path, &[], Some(body)).await?;
        serde_json::from_slice(&bytes).map_err(|_| GitHubApiError::Decode)
    }

    pub(crate) async fn put_json<B: Serialize + Sync, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T, GitHubApiError> {
        let (_, bytes) = self.send_bytes(reqwest::Method::PUT, path, &[], Some(body)).await?;
        serde_json::from_slice(&bytes).map_err(|_| GitHubApiError::Decode)
    }

    /// Fetches plain-text content (such as failed Actions job logs), following at most one redirect without leaking auth headers.
    pub(crate) async fn get_text_following_redirect_without_auth(&self, path: &str) -> Option<String> {
        let token = self.token()?;
        let url = format!("{}{}", self.api_base, path);
        let client = no_redirect_client().ok()?;
        let resp = client
            .get(&url)
            .timeout(Duration::from_secs(15))
            .header("authorization", format!("Bearer {}", token.expose().trim()))
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "vibevalley")
            .header("x-github-api-version", "2022-11-28")
            .send()
            .await
            .ok()?;
        let status = resp.status();
        if status.is_redirection() {
            let location = resp.headers().get("location")?.to_str().ok()?.to_string();
            let redirected = client.get(&location).timeout(Duration::from_secs(15)).send().await.ok()?;
            return redirected.status().is_success().then_some(redirected.text().await.ok()?);
        }
        status.is_success().then_some(resp.text().await.ok()?)
    }
}

type GhProbeFn = Arc<dyn Fn(&[&str]) -> Run + Send + Sync>;

#[derive(Clone, Default)]
enum GhProbe {
    #[default]
    Cli,
    Custom(GhProbeFn),
}

impl std::fmt::Debug for GhProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cli => f.write_str("GhProbe::Cli"),
            Self::Custom(_) => f.write_str("GhProbe::Custom"),
        }
    }
}

impl GhProbe {
    async fn run(&self, args: &[&str]) -> Run {
        match self {
            Self::Cli => gh_async(args).await,
            Self::Custom(f) => {
                let f = f.clone();
                let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
                crate::log::spawn_blocking_traced(move || {
                    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
                    f(&refs)
                })
                .await
                .unwrap_or(Run {
                    ok: false,
                    out: String::new(),
                    err: String::new(),
                    missing: false,
                })
            }
        }
    }
}

async fn gh_async(args: &[&str]) -> Run {
    let mut r = run_async("gh", args, None, &[("GH_HOST", "github.com"), ("GH_PROMPT_DISABLED", "1")]).await;
    r.out = format!("{}{}", r.out, r.err);
    r
}

fn gh_version_from_output(version: &Run) -> (bool, Option<String>) {
    if !version.ok {
        return (false, None);
    }
    let ver = version
        .out
        .lines()
        .find_map(|l| l.strip_prefix("gh version "))
        .and_then(|rest| rest.split_whitespace().next())
        .map(str::to_string);
    (true, ver)
}

fn parse_github_probe(version: Run, auth: Option<Run>) -> GitHubStatus {
    let mut s = GitHubStatus {
        checked_at: now(),
        auth_mode: GitHubAuthMode::None,
        ..Default::default()
    };
    let (installed, ver) = gh_version_from_output(&version);
    s.installed = installed;
    s.version = ver;
    if !installed {
        s.reason = t("server.repo.github.noneConfigured", &[]);
        return s;
    }
    let Some(auth) = auth else {
        s.reason = t("server.repo.github.noneConfigured", &[]);
        return s;
    };
    if !auth.ok {
        s.reason = t("server.repo.github.noneConfigured", &[]);
        return s;
    }
    let account = auth.out.split("Logged in to github.com account ").nth(1).and_then(|rest| {
        let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        (!name.is_empty()).then_some(name)
    });
    match account {
        Some(a) => {
            s.logged_in = true;
            s.auth_mode = GitHubAuthMode::Gh;
            s.account = Some(a);
        }
        None => s.reason = t("server.repo.github.noneConfigured", &[]),
    }
    s
}

/// Probes local `gh` installation and authentication status asynchronously.
pub async fn probe_github_async() -> GitHubStatus {
    probe_github_with_runner_async(&GhProbe::Cli, None).await
}

async fn probe_github_with_runner_async(gh: &GhProbe, rest: Option<&GitHubRest>) -> GitHubStatus {
    let version = gh.run(&["--version"]).await;
    if let Some(rest) = rest.filter(|r| r.has_token()) {
        let (installed, ver) = gh_version_from_output(&version);
        let mut s = GitHubStatus {
            installed,
            version: ver,
            checked_at: now(),
            auth_mode: GitHubAuthMode::None,
            ..Default::default()
        };
        match rest.get_json::<WireGithubUser>("/user", &[]).await {
            Ok(user) => {
                s.logged_in = true;
                s.auth_mode = GitHubAuthMode::Token;
                s.account = (!user.login.is_empty()).then_some(user.login);
            }
            Err(GitHubApiError::Unauthorized | GitHubApiError::Forbidden) => {
                s.reason = t("server.repo.github.tokenInvalid", &[]);
            }
            Err(err) => {
                s.reason = t("server.repo.github.tokenNetwork", &[("why", err.summary().into())]);
            }
        }
        return s;
    }
    if !version.ok {
        return parse_github_probe(version, None);
    }
    let auth = gh.run(&["auth", "status", "--hostname", "github.com", "--active"]).await;
    parse_github_probe(version, Some(auth))
}

const MOUNTS_FILE: &str = ".mounts.json";

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

/// Repository manager rooted at `<work_root>/repos` plus persisted external mounts.
#[derive(Debug)]
pub struct Repo {
    root: PathBuf,
    canon_root: PathBuf,
    per_repo: usize,
    tokei: String,
    github_rest: Option<GitHubRest>,
    gh_probe: GhProbe,
    github: Mutex<Option<GitHubStatus>>,
    capabilities: Mutex<HashMap<String, PullRequestCapability>>,
    /// One change at a time per repo name; names being created are hidden from listings.
    pending: Mutex<HashSet<String>>,
    /// Mounted external git repositories stored in `<work_root>/repos/.mounts.json`.
    mounts: Mutex<Vec<MountedRepo>>,
    mount_lock: tokio::sync::Mutex<()>,
    health_inputs: Mutex<std::collections::BTreeMap<String, Option<i64>>>,
    cancel: CancellationToken,
    probe: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
            tokei: "tokei".into(),
            github_rest: setting.map(GitHubRest::from_setting),
            gh_probe: GhProbe::Cli,
            github: Mutex::default(),
            capabilities: Mutex::default(),
            pending: Mutex::default(),
            mounts: Mutex::new(mounts),
            mount_lock: tokio::sync::Mutex::new(()),
            health_inputs: Mutex::default(),
            cancel: CancellationToken::new(),
            probe: Mutex::default(),
        }))
    }

    /// Clears cached GitHub readiness and per-repo PR capability results after token changes.
    pub fn invalidate_github_cache(&self) {
        *self.github.lock() = None;
        self.capabilities.lock().clear();
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
        *self.probe.lock() = Some(handle);
    }

    /// Convenience wrapper invoking [`Self::probe_in_background`] on `ctx.task`.
    pub fn probe_in_context(self: &Arc<Repo>, ctx: &Context) {
        self.probe_in_background(&ctx.task);
    }

    pub async fn close_async(&self) {
        self.cancel.cancel();
        let handle = self.probe.lock().take();
        if let Some(handle) = handle {
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
        self.mounts.lock().iter().find(|m| m.name == name).map(|m| m.path.clone())
    }

    /// Synchronously resolves the registered repo name for `top` when known via mounts or `repos_dir`.
    pub fn name_for_path_sync(&self, top: &Path) -> Option<String> {
        if let Some(m) = self.mounts.lock().iter().find(|m| m.path == top) {
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
        let pending = self.pending.lock().clone();
        let mut out = list_folders_async(&self.root, &pending).await;
        let mounts = self.mounts.lock().clone();
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

    /// Zero-I/O snapshot of known repo health inputs populated on repo create/mount/summary scans.
    pub fn cached_health_inputs(&self) -> Vec<vibevalley_core::RepoHealthInput> {
        self.health_inputs
            .lock()
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
            self.health_inputs.lock().insert(summary.name.clone(), summary.last.map(|s| s * 1000));
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
            let next: std::collections::BTreeMap<String, Option<i64>> = out
                .iter()
                .filter(|s| !s.name.is_empty())
                .map(|s| (s.name.clone(), s.last.map(|sec| sec * 1000)))
                .collect();
            *self.health_inputs.lock() = next;
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
        let next: std::collections::BTreeMap<String, Option<i64>> = summaries
            .iter()
            .filter(|s| !s.name.is_empty())
            .map(|s| (s.name.clone(), s.last.map(|sec| sec * 1000)))
            .collect();
        *self.health_inputs.lock() = next;
        summaries
    }

    /// Creates a new repository by name, either empty or cloned from GitHub.
    pub async fn create_async(&self, req: &NewRepo) -> Result<RepoFolder, ApiError> {
        let problem = repo_problem(req);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        if self.mounts.lock().iter().any(|m| m.name == req.name) {
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
        self.pending.lock().insert(req.name.clone());
        struct PendingGuard<'a> {
            pending: &'a Mutex<std::collections::HashSet<String>>,
            name: String,
        }
        impl Drop for PendingGuard<'_> {
            fn drop(&mut self) {
                self.pending.lock().remove(&self.name);
            }
        }
        let _pending_guard = PendingGuard {
            pending: &self.pending,
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

    pub async fn languages_async(&self, name: &str) -> Result<Option<RepoLanguages>, ApiError> {
        let Some(p) = self.find_async(name).await else { return Ok(None) };
        let path = p.path.to_string_lossy().into_owned();
        let mut args = vec!["--output", "json"];
        for x in LEFT_OUT {
            args.extend(["--exclude", x]);
        }
        args.push(&path);
        let r = run_async(&self.tokei, &args, None, &[]).await;
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

    pub async fn activity_async(&self, name: &str) -> Option<RepoActivity> {
        let p = self.find_async(name).await?;
        let name = name.to_string();
        crate::log::spawn_blocking_traced(move || {
            let at = now();
            let mut out = RepoActivity {
                repo: name,
                at,
                ..Default::default()
            };
            if !p.git {
                return out;
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
            out
        })
        .await
        .ok()
    }

    pub fn github_status(&self) -> GitHubStatus {
        if let Some(s) = self.github.lock().clone()
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
        let folders = self.list_async().await;
        let next = if !probed.logged_in {
            let mut map = HashMap::with_capacity(folders.len());
            for p in folders {
                if self.cancel.is_cancelled() {
                    break;
                }
                map.insert(
                    p.name,
                    PullRequestCapability {
                        available: false,
                        reason: probed.reason.clone(),
                    },
                );
            }
            map
        } else {
            let cancel = self.cancel.clone();
            let sem = Arc::new(Semaphore::new(REPO_CONCURRENCY));
            let mut set = JoinSet::new();
            let rest_for_caps = (probed.auth_mode == GitHubAuthMode::Token).then(|| rest.clone()).flatten();
            for p in folders {
                if cancel.is_cancelled() {
                    break;
                }
                let sem = sem.clone();
                let cancel = cancel.clone();
                let rest = rest_for_caps.clone();
                let gh = gh.clone();
                set.spawn(
                    async move {
                        let permit = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => return None,
                            p = sem.acquire_owned() => p.ok()?,
                        };
                        let _permit = permit;
                        if cancel.is_cancelled() {
                            return None;
                        }
                        let c = probe_single_capability_async(&p.path, p.git, &cancel, rest.as_ref(), &gh).await?;
                        Some((p.name, c))
                    }
                    .in_current_span()
                    .with_current_subscriber(),
                );
            }
            let mut map = HashMap::new();
            while let Some(joined) = set.join_next().await {
                if let Ok(Some((name, c))) = joined {
                    map.insert(name, c);
                }
            }
            map
        };
        *self.github.lock() = Some(probed.clone());
        *self.capabilities.lock() = next;
        probed
    }

    /// The user's commits per repository under the root and mounted external repositories.
    pub async fn contributions_async(&self, extra: Vec<String>) -> Vec<vibevalley_protocol::Repo> {
        let mut dirs = repo_dirs_async(self.root(), 3).await;
        for folder in self.list_async().await {
            if folder.git {
                dirs.push(folder.path);
            }
        }
        contributions_for_dirs_async(dirs, extra).await
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
            let rest = (status.auth_mode == GitHubAuthMode::Token).then(|| self.github_rest.as_ref()).flatten();
            if status.logged_in
                && let Some(cap) = probe_single_capability_async(&updated.path, true, &self.cancel, rest, &self.gh_probe).await
            {
                self.capabilities.lock().insert(updated.name.clone(), cap);
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
        taken.extend(self.pending.lock().iter().cloned());
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

        let mut next = self.mounts.lock().clone();
        next.push(MountedRepo {
            name: name.clone(),
            path: canon.clone(),
        });
        write_mounts_async(&self.root.join(MOUNTS_FILE), &next).await?;
        *self.mounts.lock() = next;

        let status = self.github_status();
        let rest = (status.auth_mode == GitHubAuthMode::Token).then(|| self.github_rest.as_ref()).flatten();
        if status.logged_in
            && let Some(cap) = probe_single_capability_async(&canon, true, &self.cancel, rest, &self.gh_probe).await
        {
            self.capabilities.lock().insert(name.clone(), cap);
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
        let current = self.mounts.lock().clone();
        if current.iter().any(|m| m.name == id) {
            let next: Vec<MountedRepo> = current.into_iter().filter(|m| m.name != id).collect();
            write_mounts_async(&self.root.join(MOUNTS_FILE), &next).await?;
            *self.mounts.lock() = next;
            self.capabilities.lock().remove(id);
            self.health_inputs.lock().remove(id);
            return Ok(());
        }
        if self.find_async(id).await.is_some() {
            return Err(refused(t("server.repo.mount.unmountManaged", &[("name", id.into())])));
        }
        Err(repo_ref(id))
    }

    pub async fn languages_endpoint_async(&self, id: &str) -> Result<RepoLanguages, ApiError> {
        self.languages_async(id).await?.ok_or_else(|| repo_ref(id))
    }

    pub async fn activity_endpoint_async(&self, id: &str) -> Result<RepoActivity, ApiError> {
        self.activity_async(id).await.ok_or_else(|| repo_ref(id))
    }

    /// `repo.template.list`: detected stack, recent issue titles, and filled template catalog.
    pub async fn templates_async(&self, id: &str, issues: &[Issue], is_orchestrator: impl Fn(&str) -> bool) -> Result<RepoTemplates, ApiError> {
        let name = id.to_string();
        let stack = self
            .stack_async(&name)
            .await
            .ok_or_else(|| missing(t("server.issue.repoRef", &[("name", name.clone().into())]), LookIn::Repo))?;
        let mut mine: Vec<Issue> = issues
            .iter()
            .filter(|i| {
                i.repo.as_deref() == Some(name.as_str())
                    && i.was_sent()
                    && i.parent.is_none()
                    && i.cron.is_none()
                    && !i.assigned_agent().is_some_and(&is_orchestrator)
            })
            .cloned()
            .collect();
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
    }

    /// Detects the project stack for `name`, returning `None` when no such repo exists.
    pub async fn stack_async(&self, name: &str) -> Option<RepoStack> {
        let p = self.find_async(name).await?;
        let mut owned: Vec<(&'static str, String)> = Vec::new();
        for f in STACK_FILES {
            if let Ok(body) = tokio::fs::read_to_string(p.path.join(f)).await {
                owned.push((f, body));
            }
        }
        let files: std::collections::HashMap<&str, String> = owned.into_iter().collect();
        Some(stack_of(&files))
    }
}

async fn probe_single_capability_async(
    path: &Path,
    git: bool,
    cancel: &CancellationToken,
    rest: Option<&GitHubRest>,
    gh: &GhProbe,
) -> Option<PullRequestCapability> {
    #[derive(Deserialize)]
    struct ViewerPermission {
        #[serde(rename = "viewerPermission")]
        viewer_permission: Option<String>,
    }

    let origin = if git {
        vibevalley_git::read::remote_url(path, "origin")
            .ok()
            .flatten()
            .map(|u| github_origin(&u))
            .unwrap_or_default()
    } else {
        String::new()
    };
    if !git || origin.is_empty() {
        return Some(PullRequestCapability {
            available: false,
            reason: t("server.repo.github.notGithub", &[]),
        });
    }
    if let Some(rest) = rest.filter(|r| r.has_token()) {
        let repo_path = format!("/repos/{origin}");
        let res = tokio::select! {
            biased;
            _ = cancel.cancelled() => return None,
            res = rest.get_json::<WireGithubRestRepo>(&repo_path, &[]) => res,
        };
        return Some(match res {
            Ok(repo) => match repo.permissions {
                Some(p) if p.admin || p.maintain || p.push => PullRequestCapability {
                    available: true,
                    reason: String::new(),
                },
                Some(_) => PullRequestCapability {
                    available: false,
                    reason: t("server.repo.github.readOnly", &[]),
                },
                None => PullRequestCapability {
                    available: false,
                    reason: t("server.repo.github.noPermission", &[]),
                },
            },
            Err(_) => PullRequestCapability {
                available: false,
                reason: t("server.repo.github.noPermission", &[]),
            },
        });
    }
    let view_args = ["repo", "view", &origin, "--json", "viewerPermission"];
    let view = tokio::select! {
        biased;
        _ = cancel.cancelled() => return None,
        view = gh.run(&view_args) => view,
    };
    let permission = if view.ok {
        serde_json::from_str::<ViewerPermission>(&view.out).ok().and_then(|v| v.viewer_permission)
    } else {
        None
    };
    Some(match permission.as_deref() {
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
    })
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

async fn is_dir_or_dir_symlink_async(entry: &tokio::fs::DirEntry) -> bool {
    let Ok(ft) = entry.file_type().await else { return false };
    if ft.is_dir() {
        return true;
    }
    ft.is_symlink() && tokio::fs::metadata(entry.path()).await.is_ok_and(|m| m.is_dir())
}

async fn list_folders_async(root: &Path, pending: &std::collections::HashSet<String>) -> Vec<RepoFolder> {
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

fn repo_ref(id: &str) -> ApiError {
    missing(t("server.repoRef", &[("id", id.into())]), LookIn::Repo)
}

/// Folders `repo_dirs` skips.
const SKIP_DIRS: [&str; 8] = ["node_modules", ".git", ".venv", "vendor", "dist", "build", "target", ".next"];

/// Finds git repositories under `dir` up to `depth` folders deep without descending into a repo.
async fn repo_dirs_async(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![(root.to_path_buf(), max_depth)];
    while let Some((dir, depth)) = stack.pop() {
        let canon = tokio::fs::canonicalize(&dir).await.unwrap_or_else(|_| dir.clone());
        if !visited.insert(canon) {
            continue;
        }
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { continue };
        let mut entries = Vec::new();
        while let Ok(Some(e)) = rd.next_entry().await {
            entries.push(e);
        }
        if entries.iter().any(|e| e.file_name() == ".git") {
            out.push(dir);
            continue;
        }
        if depth == 0 {
            continue;
        }
        for e in entries {
            let name = e.file_name();
            if is_dir_or_dir_symlink_async(&e).await && !SKIP_DIRS.iter().any(|s| name == *s) {
                stack.push((e.path(), depth - 1));
            }
        }
    }
    out.sort();
    out
}

fn global_email() -> String {
    vibevalley_git::read::global_config_value("user", "email")
        .ok()
        .flatten()
        .map(|e| e.trim().to_lowercase())
        .unwrap_or_default()
}

/// Counts the user's commits in each repository under `root`
/// (matching global `user.email`, repo `user.email`, and `extra`).
pub async fn contributions_of_async(root: PathBuf, extra: Vec<String>) -> Vec<vibevalley_protocol::Repo> {
    let dirs = repo_dirs_async(&root, 3).await;
    contributions_for_dirs_async(dirs, extra).await
}

async fn contributions_for_dirs_async(dirs: Vec<PathBuf>, extra: Vec<String>) -> Vec<vibevalley_protocol::Repo> {
    if dirs.is_empty() {
        return vec![];
    }
    let global = global_email();
    let extra_lower: Arc<Vec<String>> = Arc::new(extra.into_iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect());

    let sem = Arc::new(Semaphore::new(REPO_CONCURRENCY));
    let mut set = JoinSet::new();
    for (idx, dir) in dirs.into_iter().enumerate() {
        let sem = sem.clone();
        set.spawn(
            async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                crate::log::spawn_blocking_traced(move || {
                    let common = vibevalley_git::read::git_common_dir(&dir).ok()?;
                    Some((idx, dir, common))
                })
                .await
                .ok()
                .flatten()
            }
            .in_current_span()
            .with_current_subscriber(),
        );
    }
    let mut commons = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(item)) = joined {
            commons.push(item);
        }
    }
    commons.sort_by_key(|(idx, _, _)| *idx);

    // Worktrees share their repository's history: one count per repository.
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<(usize, PathBuf)> = commons
        .into_iter()
        .filter_map(|(idx, dir, common)| seen.insert(common).then_some((idx, dir)))
        .collect();

    let sem = Arc::new(Semaphore::new(REPO_CONCURRENCY));
    let mut set = JoinSet::new();
    for (idx, dir) in unique {
        let sem = sem.clone();
        let global = global.clone();
        let extra_lower = extra_lower.clone();
        set.spawn(
            async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                crate::log::spawn_blocking_traced(move || {
                    let own = git_quiet(&dir, &["config", "user.email"]).to_lowercase();
                    let mine: std::collections::HashSet<String> =
                        [global, own].into_iter().chain(extra_lower.iter().cloned()).filter(|e| !e.is_empty()).collect();
                    let emails = git_quiet(&dir, &["log", "--all", "--format=%ae"]);
                    let commits = emails.lines().filter(|e| !e.is_empty() && mine.contains(&e.to_lowercase())).count() as i64;
                    let top = vibevalley_git::read::discover_root(&dir).ok().flatten();
                    (
                        idx,
                        vibevalley_protocol::Repo {
                            path: top.unwrap_or(dir).display().to_string(),
                            commits,
                        },
                    )
                })
                .await
                .ok()
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
    out.into_iter().map(|(_, repo)| repo).collect()
}

const STACK_FILES: [&str; 11] = [
    "go.mod",
    "Cargo.toml",
    "pubspec.yaml",
    "package.json",
    "pyproject.toml",
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

/// Detects stack commands from root marker files (first match wins).
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
    let pyproject = files.get("pyproject.toml");
    if pyproject.is_some() || has("requirements.txt") || has("setup.py") {
        let lint = if pyproject.is_some_and(|p| p.contains("ruff")) { "ruff check ." } else { "" };
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
        include_str!("../assets/agent/template_catalog.en.json")
    } else {
        include_str!("../assets/agent/template_catalog.json")
    };
    serde_json::from_str(body).expect("template_catalog.json")
}

/// Fills `{test}`, `{lint}`, and `{build}` placeholders with the stack's commands or localized labels.
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

    #[tokio::test]
    async fn regression_pyproject_toml_detects_python_stack_and_ruff() {
        let mut with_ruff = std::collections::HashMap::new();
        with_ruff.insert("pyproject.toml", "[tool.ruff]\nline-length = 100\n".to_string());
        let py = stack_of(&with_ruff);
        assert_eq!(py.name, "python");
        assert_eq!(py.test.as_deref(), Some("pytest"));
        assert_eq!(py.lint.as_deref(), Some("ruff check ."));

        let mut no_ruff = std::collections::HashMap::new();
        no_ruff.insert("pyproject.toml", "[project]\nname = \"demo\"\n".to_string());
        let plain = stack_of(&no_ruff);
        assert_eq!(plain.name, "python");
        assert_eq!(plain.test.as_deref(), Some("pytest"));
        assert_eq!(plain.lint, None);

        let mut typo = std::collections::HashMap::new();
        typo.insert("pyrepo.toml", "[tool.ruff]\n".to_string());
        assert_eq!(stack_of(&typo).name, "");

        let work = tempfile::tempdir().unwrap();
        let repo_dir = work.path().join("repos/pyapp");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let init = std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo_dir).status().unwrap();
        assert!(init.success());
        std::fs::write(repo_dir.join("pyproject.toml"), "[tool.ruff]\n").unwrap();
        let repo = Repo::open_async(work.path(), 3).await.unwrap();
        let detected = repo.stack_async("pyapp").await.unwrap();
        assert_eq!(detected.name, "python");
        assert_eq!(detected.lint.as_deref(), Some("ruff check ."));
        repo.close_async().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_repo_handlers_and_contributions_run_on_repo() {
        let work = tempfile::tempdir().unwrap();
        let repo = Repo::open_async(work.path(), 3).await.unwrap();

        let created = repo
            .create_repo_async(&NewRepo {
                name: "alpha".into(),
                github: None,
            })
            .await
            .unwrap();
        assert_eq!(created.name, "alpha");
        assert!(created.git);

        let _beta = repo
            .create_repo_async(&NewRepo {
                name: "beta".into(),
                github: None,
            })
            .await
            .unwrap();

        let listed = repo.list_summaries_async().await;
        assert_eq!(listed.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["alpha", "beta"]);

        let activity = repo.activity_endpoint_async("alpha").await.unwrap();
        assert_eq!(activity.repo, "alpha");
        assert!(activity.total >= 1);

        let contribs = repo.contributions_async(vec!["vibevalley@localhost".into()]).await;
        assert_eq!(contribs.len(), 2);

        repo.close_async().await;
    }

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

    async fn open_with_github_for_test(work_root: &Path, github_rest: Option<GitHubRest>, gh_probe: GhProbe) -> Arc<Repo> {
        let root = work_root.join("repos");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let canon_root = tokio::fs::canonicalize(&root).await.unwrap();
        Arc::new(Repo {
            root,
            canon_root,
            per_repo: 3,
            tokei: "tokei".into(),
            github_rest,
            gh_probe,
            github: Mutex::default(),
            capabilities: Mutex::default(),
            pending: Mutex::default(),
            mounts: Mutex::default(),
            mount_lock: tokio::sync::Mutex::new(()),
            health_inputs: Mutex::default(),
            cancel: CancellationToken::new(),
            probe: Mutex::default(),
        })
    }

    fn init_git_with_github_origin(dir: &Path, remote_repo: &str) {
        std::fs::create_dir_all(dir).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["remote", "add", "origin", &format!("https://github.com/{remote_repo}.git")],
        ] {
            assert!(
                std::process::Command::new("git")
                    .args(&args)
                    .current_dir(dir)
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn github_status_distinguishes_token_gh_and_unconfigured_modes() {
        use axum::Json;
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::get;

        vibevalley_i18n::set_locale("en");
        let missing_gh = GhProbe::Custom(Arc::new(|_| Run {
            ok: false,
            out: String::new(),
            err: String::new(),
            missing: true,
        }));
        let logged_gh = GhProbe::Custom(Arc::new(|args| match args.first().copied() {
            Some("--version") => Run {
                ok: true,
                out: "gh version 2.62.0 (2025-01-01)\n".into(),
                err: String::new(),
                missing: false,
            },
            Some("auth") => Run {
                ok: true,
                out: "github.com\n  ✓ Logged in to github.com account cli-user (oauth_token)\n".into(),
                err: String::new(),
                missing: false,
            },
            _ => Run {
                ok: false,
                out: String::new(),
                err: String::new(),
                missing: false,
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

        // 1. Token configured + gh missing -> GitHubAuthMode::Token, logged_in = true, writable vs readonly capability checked via REST.
        let work_token = tempfile::tempdir().unwrap();
        init_git_with_github_origin(&work_token.path().join("repos/writable"), "acme/writable");
        init_git_with_github_origin(&work_token.path().join("repos/readonly"), "acme/readonly");
        let rest = GitHubRest::with_base(base_url.clone(), Arc::new(|| Some(Secret::new("ghp_valid"))));
        let repo_token = open_with_github_for_test(work_token.path(), Some(rest), missing_gh.clone()).await;
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

        // 2. Invalid token -> unauthenticated with tokenInvalid reason.
        let work_bad = tempfile::tempdir().unwrap();
        let bad_rest = GitHubRest::with_base(base_url, Arc::new(|| Some(Secret::new("ghp_invalid"))));
        let repo_bad = open_with_github_for_test(work_bad.path(), Some(bad_rest), missing_gh.clone()).await;
        let status_bad = repo_bad.refresh_github_async().await;
        assert_eq!(status_bad.auth_mode, GitHubAuthMode::None);
        assert!(!status_bad.logged_in);
        assert_eq!(status_bad.reason, t("server.repo.github.tokenInvalid", &[]));
        repo_bad.close_async().await;

        // 3. No token + gh installed & logged in -> GitHubAuthMode::Gh.
        let work_gh = tempfile::tempdir().unwrap();
        let repo_gh = open_with_github_for_test(work_gh.path(), None, logged_gh).await;
        let status_gh = repo_gh.refresh_github_async().await;
        assert_eq!(status_gh.auth_mode, GitHubAuthMode::Gh);
        assert!(status_gh.installed);
        assert!(status_gh.logged_in);
        assert_eq!(status_gh.account.as_deref(), Some("cli-user"));
        repo_gh.close_async().await;

        // 4. Neither token nor gh -> GitHubAuthMode::None without hard blocker wording.
        let work_none = tempfile::tempdir().unwrap();
        let repo_none = open_with_github_for_test(work_none.path(), None, missing_gh).await;
        let status_none = repo_none.refresh_github_async().await;
        assert_eq!(status_none.auth_mode, GitHubAuthMode::None);
        assert!(!status_none.installed);
        assert!(!status_none.logged_in);
        assert_eq!(status_none.reason, t("server.repo.github.noneConfigured", &[]));
        repo_none.close_async().await;
    }
}
