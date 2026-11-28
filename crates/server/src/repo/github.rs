use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
use tracing::instrument::WithSubscriber;
use vibevalley_i18n::t;
use vibevalley_kit::cache::LruCache;
use vibevalley_protocol::{GitHubAuthMode, GitHubStatus, PullRequestCapability};

use crate::context::http::no_redirect_client;
use crate::context::now;
use crate::setting::{Secret, Setting};

pub(crate) const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";

pub(crate) type TokenSource = Arc<dyn Fn() -> Option<Secret> + Send + Sync>;

const REPO_CAPABILITY_CACHE_CAPACITY: NonZeroUsize = NonZeroUsize::new(256).expect("non-zero capacity");

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

pub(super) struct Run {
    pub(super) ok: bool,
    pub(super) out: String,
    pub(super) err: String,
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
        },
        Err(e) => Run {
            ok: false,
            out: String::new(),
            err: e.to_string(),
        },
    }
}

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
    pub(crate) fn describe(&self) -> String {
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
        let base_url = format!("{}{}", self.api_base, path);
        let url = if query.is_empty() {
            base_url
        } else {
            url::Url::parse_with_params(&base_url, query)
                .map(|u| u.to_string())
                .map_err(|e| GitHubApiError::Network(e.to_string()))?
        };
        let client = no_redirect_client().map_err(GitHubApiError::Network)?;
        let mut req = client
            .request(method, &url)
            .timeout(Duration::from_secs(15))
            .header("authorization", format!("Bearer {}", token.expose().trim()))
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "vibevalley")
            .header("x-github-api-version", "2022-11-28");
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
                let message = serde_json::from_slice::<WireGithubError>(&bytes).map(|e| e.message).unwrap_or_default();
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

#[cfg(test)]
pub(super) type GhProbeFn = Arc<dyn Fn(&[&str]) -> Run + Send + Sync>;

#[derive(Clone, Default)]
pub(super) enum GhProbe {
    #[default]
    Cli,
    #[cfg(test)]
    Custom(GhProbeFn),
}

impl std::fmt::Debug for GhProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cli => f.write_str("GhProbe::Cli"),
            #[cfg(test)]
            Self::Custom(_) => f.write_str("GhProbe::Custom"),
        }
    }
}

impl GhProbe {
    pub(super) async fn run(&self, args: &[&str]) -> Run {
        match self {
            Self::Cli => gh_async(args).await,
            #[cfg(test)]
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

pub(super) async fn probe_github_with_runner_async(gh: &GhProbe, rest: Option<&GitHubRest>) -> GitHubStatus {
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
                s.reason = t("server.repo.github.tokenNetwork", &[("why", err.describe().into())]);
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

#[derive(Debug)]
struct GitHubCacheInner {
    capabilities: LruCache<String, PullRequestCapability>,
    probe: Option<tokio::task::JoinHandle<()>>,
}

/// Cached GitHub readiness (`ArcSwap` for lock-free reads), per-repo PR capabilities, and background probe task.
#[derive(Debug)]
pub(super) struct GitHubCache {
    status: ArcSwap<Option<GitHubStatus>>,
    inner: Mutex<GitHubCacheInner>,
}

impl Default for GitHubCache {
    fn default() -> Self {
        Self {
            status: ArcSwap::from_pointee(None),
            inner: Mutex::new(GitHubCacheInner {
                capabilities: LruCache::new(REPO_CAPABILITY_CACHE_CAPACITY),
                probe: None,
            }),
        }
    }
}

impl GitHubCache {
    pub(super) fn invalidate(&self) {
        self.status.store(Arc::new(None));
        self.inner.lock().capabilities.clear();
    }

    pub(super) fn status(&self) -> Option<GitHubStatus> {
        (**self.status.load()).clone()
    }

    pub(super) fn capability(&self, name: &str) -> PullRequestCapability {
        if let Some(c) = self.inner.lock().capabilities.get(name) {
            return c.clone();
        }
        match self.status() {
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

    pub(super) fn set_status_and_capabilities(&self, status: GitHubStatus, next: HashMap<String, PullRequestCapability>) {
        self.status.store(Arc::new(Some(status)));
        let mut inner = self.inner.lock();
        inner.capabilities.clear();
        for (name, cap) in next {
            inner.capabilities.insert(name, cap);
        }
    }

    pub(super) fn insert_capability(&self, name: String, cap: PullRequestCapability) {
        self.inner.lock().capabilities.insert(name, cap);
    }

    pub(super) fn remove_capability(&self, name: &str) {
        self.inner.lock().capabilities.remove(name);
    }

    pub(super) fn set_probe(&self, handle: tokio::task::JoinHandle<()>) {
        self.inner.lock().probe = Some(handle);
    }

    pub(super) fn take_probe(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.inner.lock().probe.take()
    }
}

pub(super) async fn probe_capabilities_for_folders_async(
    folders: Vec<(String, std::path::PathBuf, bool)>,
    probed: &GitHubStatus,
    cancel: &CancellationToken,
    rest: Option<GitHubRest>,
    gh: &GhProbe,
    concurrency: usize,
) -> HashMap<String, PullRequestCapability> {
    if !probed.logged_in {
        let mut map = HashMap::with_capacity(folders.len());
        for (name, _, _) in folders {
            if cancel.is_cancelled() {
                break;
            }
            map.insert(
                name,
                PullRequestCapability {
                    available: false,
                    reason: probed.reason.clone(),
                },
            );
        }
        return map;
    }
    let sem = Arc::new(Semaphore::new(concurrency));
    let mut set = JoinSet::new();
    let rest_for_caps = (probed.auth_mode == GitHubAuthMode::Token).then_some(rest).flatten();
    for (name, path, git) in folders {
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
                let c = probe_single_capability_async(&path, git, &cancel, rest.as_ref(), &gh).await?;
                Some((name, c))
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
}

pub(super) async fn probe_single_capability_async(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_url_parsers() {
        assert_eq!(
            github_repository("https://github.com/botiverse/oar/"),
            Some(("oar".into(), "https://github.com/botiverse/oar.git".into()))
        );
        assert!(github_repository("git@github.com:a/b").is_none());
        assert!(github_repository("https://github.com/a/..").is_none());
        assert_eq!(github_origin("git@github.com:botiverse/oar.git"), "botiverse/oar");
        assert_eq!(github_origin("https://gitlab.com/a/b"), "");
    }
}
