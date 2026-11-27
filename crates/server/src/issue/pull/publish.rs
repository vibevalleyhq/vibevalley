//! `repo.pr.submit`: an existing branch pushed and a pull (or merge)
//! request opened for it. Only the user publishes: the checkout must
//! be its root, clean and at the given sha; the one remote must read and
//! push to the same GitHub or GitLab repository; the base must merge
//! cleanly and `.vibevalley/check` pass before the push.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use vibevalley_git::{MergeCheck, Repo};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, BranchCheck, BranchPublication, BranchPublicationState, PublishPlatform, PullRequestState, SubmitBranch};

use crate::context::error::refused as refuse;
use crate::log::spawn_blocking_traced;
use crate::repo::{GitHubApiError, GitHubRest, TokenSource};
use crate::setting::Secret;

/// What a `gh`/`glab` call answered: ok, its output, and whether the tool is missing.
pub struct Answer {
    pub ok: bool,
    pub out: String,
    pub missing: bool,
}

pub type HostRun = Arc<dyn Fn(&[String]) -> Answer + Send + Sync>;

/// Native async CLI runner for `gh`/`glab`, or an injected test callback.
#[derive(Clone)]
pub(crate) enum HostRunner {
    Cli(&'static str),
    Custom(HostRun),
}

impl HostRunner {
    pub(crate) async fn run_async(&self, args: Vec<String>) -> Answer {
        match self {
            Self::Cli(tool) => {
                let mut c = tokio::process::Command::new(tool);
                c.args(&args);
                if *tool == "glab" {
                    c.env("GITLAB_HOST", "gitlab.com").env("GLAB_PROMPT_DISABLED", "1");
                } else {
                    c.env("GH_PROMPT_DISABLED", "1");
                }
                match output_within_async(c, Duration::from_secs(15)).await {
                    Ok(Some((code, out))) => Answer {
                        ok: code == 0,
                        out,
                        missing: false,
                    },
                    Ok(None) => Answer {
                        ok: false,
                        out: String::new(),
                        missing: false,
                    },
                    Err(missing) => Answer {
                        ok: false,
                        out: String::new(),
                        missing,
                    },
                }
            }
            Self::Custom(f) => {
                let f = f.clone();
                spawn_blocking_traced(move || f(&args)).await.unwrap_or(Answer {
                    ok: false,
                    out: String::new(),
                    missing: false,
                })
            }
        }
    }
}

/// git's network, apart so tests can stand in for a hosted remote.
pub trait Network: Send + Sync {
    fn tip(&self, cwd: &Path, url: &str, branch: &str) -> Result<String, String>;
    fn fetch(&self, cwd: &Path, url: &str, branch: &str) -> Result<(), String>;
    fn push(&self, cwd: &Path, url: &str, branch: &str, sha: &str) -> Result<(), String>;
}

struct Git;

fn sha_like(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Network for Git {
    fn tip(&self, cwd: &Path, url: &str, branch: &str) -> Result<String, String> {
        let head = format!("refs/heads/{branch}");
        let out = git(cwd, &["ls-remote", "--exit-code", "--refs", "--", url, &head])?;
        let line = out.trim();
        let (sha, r) = line.split_once('\t').unwrap_or((line, ""));
        if !sha_like(sha) || r != head {
            return Err("Invalid remote ref".into());
        }
        Ok(sha.to_string())
    }

    fn fetch(&self, cwd: &Path, url: &str, branch: &str) -> Result<(), String> {
        git(
            cwd,
            &["fetch", "--no-tags", "--no-write-fetch-head", "--", url, &format!("refs/heads/{branch}")],
        )
        .map(|_| ())
    }

    fn push(&self, cwd: &Path, url: &str, branch: &str, sha: &str) -> Result<(), String> {
        let refspec = format!("{sha}:refs/heads/{branch}");
        git(
            cwd,
            &["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--", url, &refspec],
        )
        .map(|_| ())
    }
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let repo = Repo::discover(cwd)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not a git repository".to_string())?;
    let out = repo.run(args).map_err(|e| e.to_string())?;
    if out.ok() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(out.stderr.trim().lines().last().unwrap_or("git failed").to_string())
    }
}

/// A command's exit code and stdout; none when it ran out of time; Err(true)
/// when it is not installed.
pub(crate) async fn output_within_async(c: tokio::process::Command, limit: Duration) -> Result<Option<(i32, String)>, bool> {
    let out = vibevalley_runtime::oar::run_output_with_timeout(c, limit, None)
        .await
        .map_err(|e| e.kind() == std::io::ErrorKind::NotFound)?;
    if out.timed_out {
        return Ok(None);
    }
    Ok(Some((out.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned())))
}

/// `hostedOrigin`.
#[derive(Debug, Clone, PartialEq)]
pub struct HostedRepo {
    pub platform: PublishPlatform,
    pub host: String,
    pub name: String,
}

pub fn hosted_origin(url: &str) -> Option<HostedRepo> {
    static HOSTED_ORIGIN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"^(?:https://(github\.com|gitlab\.com)/|ssh://git@(github\.com|gitlab\.com)/|git@(github\.com|gitlab\.com):)([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)/?$",
        )
        .expect("regex")
    });
    let m = HOSTED_ORIGIN.captures(url)?;
    let host = m.get(1).or(m.get(2)).or(m.get(3))?.as_str().to_string();
    let name = m.get(4)?.as_str();
    let name = name.strip_suffix(".git").unwrap_or(name).to_string();
    let parts: Vec<&str> = name.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") || (host == "github.com" && parts.len() != 2) {
        return None;
    }
    let platform = if host == "github.com" {
        PublishPlatform::Github
    } else {
        PublishPlatform::Gitlab
    };
    Some(HostedRepo { platform, host, name })
}

fn refused(detail: &str) -> ApiError {
    refuse(BizCode::RepoRefused, t("server.repo.publish.refused", &[("detail", detail.into())]))
}

fn platform_failed(stage: &str) -> ApiError {
    refuse(BizCode::RepoRefused, t("server.repo.publish.platformFailed", &[("stage", stage.into())]))
}

pub(crate) fn missing_credentials() -> ApiError {
    refuse(BizCode::RepoRefused, t("server.repo.publish.missingCredentials", &[]))
}

fn rest_failed(stage: &str, err: GitHubApiError) -> ApiError {
    match err {
        GitHubApiError::MissingToken => missing_credentials(),
        GitHubApiError::Unauthorized | GitHubApiError::Forbidden => refuse(BizCode::RepoRefused, t("server.repo.github.tokenInvalid", &[])),
        _ => platform_failed(&format!("{stage} ({})", err.summary())),
    }
}

#[derive(Deserialize)]
struct WireGithubRestRepo {
    default_branch: String,
}

#[derive(Deserialize)]
struct WireGithubRestRepoRef {
    #[serde(default)]
    full_name: String,
}

#[derive(Deserialize)]
struct WireGithubRestBranchRef {
    #[serde(default)]
    repo: Option<WireGithubRestRepoRef>,
}

#[derive(Deserialize)]
struct WireGithubRestPull {
    #[serde(default)]
    number: i64,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    head: Option<WireGithubRestBranchRef>,
}

#[derive(Serialize)]
struct CreateGithubPullBody<'a> {
    title: &'a str,
    head: &'a str,
    base: &'a str,
    body: &'a str,
}

#[derive(Serialize)]
struct MergeGithubPullBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    merge_method: Option<&'a str>,
}

#[derive(Deserialize)]
struct WireGithubRestMerge {
    #[serde(default)]
    merged: bool,
}

#[derive(Deserialize)]
struct WirePullState {
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireGithubRepoView {
    default_branch_ref: WireBranchRef,
}

#[derive(Deserialize)]
struct WireBranchRef {
    name: String,
}

#[derive(Deserialize)]
struct WireGitlabProject {
    default_branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireGithubPr {
    #[serde(default)]
    number: i64,
    #[serde(default)]
    url: String,
    #[serde(default)]
    is_cross_repository: bool,
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
struct WireGitlabMr {
    #[serde(default)]
    iid: i64,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    source_project_id: Option<i64>,
    #[serde(default)]
    target_project_id: Option<i64>,
    #[serde(default)]
    state: String,
}

impl WireGitlabMr {
    fn is_same_project_open(&self) -> bool {
        self.source_project_id == self.target_project_id && matches!(self.state.as_str(), "opened" | "locked")
    }
}

struct Hosting<'a> {
    repo: &'a HostedRepo,
    run: &'a HostRunner,
    github_rest: Option<&'a GitHubRest>,
}

impl<'a> Hosting<'a> {
    fn github(&self) -> bool {
        self.repo.platform == PublishPlatform::Github
    }

    fn rest(&self) -> Option<&'a GitHubRest> {
        self.github().then_some(self.github_rest).flatten().filter(|r| r.has_token())
    }

    fn project(&self) -> String {
        format!(
            "projects/{}",
            url::form_urlencoded::byte_serialize(self.repo.name.as_bytes()).collect::<String>()
        )
    }

    async fn request(&self, args: &[&str]) -> Result<String, ApiError> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let r = self.run.run_async(args.clone()).await;
        if !r.ok {
            if self.github() && (r.missing || args.first().map(String::as_str) == Some("auth")) {
                return Err(missing_credentials());
            }
            let stage = if r.missing {
                "glab missing".to_string()
            } else {
                args.iter().take(2).cloned().collect::<Vec<_>>().join(" ")
            };
            return Err(platform_failed(&stage));
        }
        Ok(r.out)
    }

    fn receipt(&self, number: i64, url: &str) -> Result<(i64, String), ApiError> {
        let kind = if self.github() { "pull" } else { "-/merge_requests" };
        let prefix = format!("https://{}/{}/{kind}/", self.repo.host, self.repo.name);
        if number <= 0 || url != format!("{prefix}{number}") {
            return Err(platform_failed("receipt"));
        }
        Ok((number, url.to_string()))
    }

    /// Reads a hosted pull/merge request's remote state (`open`, `merged`, `closed`).
    pub(crate) async fn state(&self, number: i64) -> Result<PullRequestState, ApiError> {
        if let Some(rest) = self.rest() {
            let path = format!("/repos/{}/pulls/{number}", self.repo.name);
            let wire: WireGithubRestPull = rest.get_json(&path, &[]).await.map_err(|e| rest_failed("pull state", e))?;
            if wire.merged || wire.merged_at.is_some() {
                return Ok(PullRequestState::Merged);
            }
            return match wire.state.to_ascii_lowercase().as_str() {
                "open" => Ok(PullRequestState::Open),
                "closed" => Ok(PullRequestState::Closed),
                _ => Err(platform_failed("pull state decode")),
            };
        }
        let out = if self.github() {
            let num = number.to_string();
            self.request(&["pr", "view", &num, "--repo", &self.repo.name, "--json", "state"]).await?
        } else {
            let path = format!("{}/merge_requests/{number}", self.project());
            self.request(&["api", &path]).await?
        };
        let wire: WirePullState = serde_json::from_str(&out).map_err(|_| platform_failed("pull state decode"))?;
        match wire.state.to_ascii_lowercase().as_str() {
            "open" | "opened" => Ok(PullRequestState::Open),
            "merged" => Ok(PullRequestState::Merged),
            "closed" => Ok(PullRequestState::Closed),
            _ => Err(platform_failed("pull state decode")),
        }
    }

    async fn inspect(&self) -> Result<String, ApiError> {
        if let Some(rest) = self.rest() {
            let path = format!("/repos/{}", self.repo.name);
            let wire: WireGithubRestRepo = rest.get_json(&path, &[]).await.map_err(|e| rest_failed("repository", e))?;
            return Ok(wire.default_branch);
        }
        self.request(&["auth", "status", "--hostname", &self.repo.host]).await?;
        if self.github() {
            let out = self.request(&["repo", "view", &self.repo.name, "--json", "defaultBranchRef"]).await?;
            let wire: WireGithubRepoView = serde_json::from_str(&out).map_err(|_| platform_failed("repository decode"))?;
            Ok(wire.default_branch_ref.name)
        } else {
            let project = self.project();
            let out = self.request(&["api", &project]).await?;
            let wire: WireGitlabProject = serde_json::from_str(&out).map_err(|_| platform_failed("repository decode"))?;
            Ok(wire.default_branch)
        }
    }

    async fn find(&self, branch: &str, base: &str) -> Result<Option<(i64, String)>, ApiError> {
        if let Some(rest) = self.rest() {
            let owner = self.repo.name.split('/').next().unwrap_or("");
            let head = format!("{owner}:{branch}");
            let path = format!("/repos/{}/pulls", self.repo.name);
            let list: Vec<WireGithubRestPull> = rest
                .get_json(&path, &[("state", "open"), ("head", &head), ("base", base), ("per_page", "2")])
                .await
                .map_err(|e| rest_failed("list pulls", e))?;
            if list.len() > 1 {
                return Err(platform_failed("list decode"));
            }
            return list
                .iter()
                .find(|p| {
                    p.state.eq_ignore_ascii_case("open")
                        && p.head
                            .as_ref()
                            .and_then(|h| h.repo.as_ref())
                            .is_none_or(|r| r.full_name.eq_ignore_ascii_case(&self.repo.name))
                })
                .map(|p| self.receipt(p.number, &p.html_url))
                .transpose();
        }
        if self.github() {
            let out = self
                .request(&[
                    "pr",
                    "list",
                    "--repo",
                    &self.repo.name,
                    "--head",
                    branch,
                    "--base",
                    base,
                    "--state",
                    "open",
                    "--json",
                    "url,number,isCrossRepository,state",
                ])
                .await?;
            let list: Vec<WireGithubPr> = serde_json::from_str(&out).map_err(|_| platform_failed("list decode"))?;
            if list.len() > 1 {
                return Err(platform_failed("list decode"));
            }
            return list
                .iter()
                .find(|p| !p.is_cross_repository && p.state == "OPEN")
                .map(|p| self.receipt(p.number, &p.url))
                .transpose();
        }
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let query = format!(
            "{}/merge_requests?state=opened&source_branch={}&target_branch={}&per_page=2",
            self.project(),
            enc(branch),
            enc(base)
        );
        let out = self.request(&["api", &query]).await?;
        let list: Vec<WireGitlabMr> = serde_json::from_str(&out).map_err(|_| platform_failed("list decode"))?;
        if list.len() > 1 {
            return Err(platform_failed("list decode"));
        }
        list.iter()
            .find(|m| m.is_same_project_open())
            .map(|m| self.receipt(m.iid, &m.web_url))
            .transpose()
    }

    async fn create(&self, req: &SubmitBranch) -> Result<(i64, String), ApiError> {
        if let Some(rest) = self.rest() {
            let path = format!("/repos/{}/pulls", self.repo.name);
            let body = CreateGithubPullBody {
                title: &req.title,
                head: &req.branch,
                base: &req.base,
                body: &req.body,
            };
            let created: WireGithubRestPull = rest.post_json(&path, &body).await.map_err(|e| rest_failed("create pull", e))?;
            return self.receipt(created.number, &created.html_url);
        }
        if self.github() {
            let out = self
                .request(&[
                    "pr",
                    "create",
                    "--repo",
                    &self.repo.name,
                    "--head",
                    &req.branch,
                    "--base",
                    &req.base,
                    "--title",
                    &req.title,
                    "--body",
                    &req.body,
                ])
                .await?;
            let url = out.trim();
            let n = url.rsplit('/').next().and_then(|n| n.parse().ok()).unwrap_or(0);
            return self.receipt(n, url);
        }
        let path = format!("{}/merge_requests", self.project());
        let source_branch = format!("source_branch={}", req.branch);
        let target_branch = format!("target_branch={}", req.base);
        let title = format!("title={}", req.title);
        let description = format!("description={}", req.body);
        let out = self
            .request(&[
                "api",
                &path,
                "--method",
                "POST",
                "--raw-field",
                &source_branch,
                "--raw-field",
                &target_branch,
                "--raw-field",
                &title,
                "--raw-field",
                &description,
            ])
            .await?;
        let m: WireGitlabMr = serde_json::from_str(&out).map_err(|_| platform_failed("create decode"))?;
        if !m.is_same_project_open() {
            return Err(platform_failed("create decode"));
        }
        self.receipt(m.iid, &m.web_url)
    }

    async fn merge(&self, number: i64, method: Option<&str>) -> Result<(), ApiError> {
        if let Some(rest) = self.rest() {
            let path = format!("/repos/{}/pulls/{number}/merge", self.repo.name);
            let body = MergeGithubPullBody { merge_method: method };
            let res: WireGithubRestMerge = rest.put_json(&path, &body).await.map_err(|e| rest_failed("merge pull", e))?;
            if !res.merged {
                return Err(platform_failed("merge"));
            }
            return Ok(());
        }
        if self.github() {
            let num = number.to_string();
            let flag = match method {
                Some("squash") => "--squash",
                Some("rebase") => "--rebase",
                _ => "--merge",
            };
            self.request(&["pr", "merge", &num, "--repo", &self.repo.name, flag]).await?;
            return Ok(());
        }
        let path = format!("{}/merge_requests/{number}/merge", self.project());
        self.request(&["api", &path, "--method", "PUT"]).await?;
        Ok(())
    }
}

/// `checkRepository`: `.vibevalley/check` at cwd: not run when there is
/// none, passed, or refused with its last lines.
pub async fn check_repository(cwd: &Path, limit: Duration) -> Result<BranchCheck, ApiError> {
    use crate::runtime::worktree::check::{ScriptOutcome, run_project_check_script, tail};

    let (why, said) = match run_project_check_script(cwd, limit).await {
        ScriptOutcome::NotConfigured => return Ok(BranchCheck::NotRun),
        ScriptOutcome::Passed => return Ok(BranchCheck::Passed),
        ScriptOutcome::TimedOut(limit) => (t("server.repo.check.timedOut", &[("seconds", (limit.as_secs() as i64).into())]), String::new()),
        ScriptOutcome::Exited { code, output } => (t("server.repo.check.exited", &[("code", i64::from(code).into())]), output),
        ScriptOutcome::Failed(why) => (t("server.repo.check.failed", &[("why", why.into())]), String::new()),
    };
    let tail = tail(said.trim(), 40);
    Err(refuse(BizCode::RepoRefused, format!("{why}\n{tail}")))
}

/// The publisher, with its tools.
pub struct Publisher {
    gh: HostRunner,
    glab: HostRunner,
    github_rest: Option<GitHubRest>,
    pub network: Arc<dyn Network>,
    pub check_timeout: Duration,
    serial: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Default for Publisher {
    fn default() -> Self {
        Publisher {
            gh: HostRunner::Cli("gh"),
            glab: HostRunner::Cli("glab"),
            github_rest: None,
            network: Arc::new(Git),
            check_timeout: Duration::from_secs(600),
            serial: Mutex::default(),
        }
    }
}

struct Remote {
    name: String,
    read: String,
    write: String,
    target: HostedRepo,
}

async fn verify_unchanged_async(repo: &Repo, branch_want: &str, sha_want: &str) -> Result<(), ApiError> {
    let status = repo.status_async().await.map_err(|_| refused("git failed; checkout retained"))?;
    if status.branch.as_deref() != Some(branch_want) || status.head.as_deref() != Some(sha_want) || !status.entries.is_empty() {
        return Err(refused("checkout changed or dirty"));
    }
    Ok(())
}

async fn read_destination_async(repo: &Repo) -> Result<Remote, ApiError> {
    let out = repo
        .run_async(&["config", "--null", "--list"])
        .await
        .ok()
        .filter(|o| o.ok())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .ok_or_else(|| refused("git failed; checkout retained"))?;
    let config: Vec<(String, String)> = out
        .split('\0')
        .filter(|e| !e.is_empty())
        .map(|e| match e.split_once('\n') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (e.to_string(), String::new()),
        })
        .collect();
    static URL_REWRITE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^url\..*\.(insteadof|pushinsteadof)$").expect("regex"));
    if config.iter().any(|(k, _)| URL_REWRITE.is_match(k)) {
        return Err(refused("URL rewrite configuration"));
    }
    static REMOTE_NAME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^remote\.(.+)\.[^.]+$").expect("regex"));
    let mut names: Vec<String> = vec![];
    for (k, _) in &config {
        if let Some(n) = REMOTE_NAME.captures(k).and_then(|c| c.get(1))
            && !names.iter().any(|x| x == n.as_str())
        {
            names.push(n.as_str().to_string());
        }
    }
    let [name] = names.as_slice() else { return Err(refused("ambiguous remote")) };
    if name.starts_with('-') {
        return Err(refused("ambiguous remote"));
    }
    let reads: Vec<&String> = config.iter().filter(|(k, _)| *k == format!("remote.{name}.url")).map(|(_, v)| v).collect();
    let writes: Vec<&String> = config.iter().filter(|(k, _)| *k == format!("remote.{name}.pushurl")).map(|(_, v)| v).collect();
    let read = reads.first().map(|s| s.to_string()).unwrap_or_default();
    let write = writes.first().map(|s| s.to_string()).unwrap_or_else(|| read.clone());
    let (target, pushed) = (hosted_origin(&read), hosted_origin(&write));
    match (target, pushed) {
        (Some(target), Some(pushed)) if reads.len() == 1 && writes.len() <= 1 && target.host == pushed.host && target.name == pushed.name => Ok(Remote {
            name: name.clone(),
            read,
            write,
            target,
        }),
        _ => Err(refused("remote read / push destination")),
    }
}

impl Publisher {
    pub fn new(gh: HostRun, glab: HostRun, network: Arc<dyn Network>) -> Publisher {
        Publisher {
            gh: HostRunner::Custom(gh),
            glab: HostRunner::Custom(glab),
            github_rest: None,
            network,
            check_timeout: Duration::from_secs(600),
            serial: Mutex::default(),
        }
    }

    pub(crate) fn with_github_token(mut self, token: TokenSource) -> Self {
        self.github_rest = Some(GitHubRest::new(token));
        self
    }

    pub(crate) fn github_rest(&self) -> Option<&GitHubRest> {
        self.github_rest.as_ref()
    }

    /// Configures a custom GitHub REST API base URL and optional token for offline tests.
    #[doc(hidden)]
    pub fn with_github_api_for_test(mut self, api_base: impl Into<String>, token: Option<String>) -> Self {
        let token_src: TokenSource = Arc::new(move || token.clone().map(Secret::new));
        self.github_rest = Some(GitHubRest::with_base(api_base, token_src));
        self
    }

    /// Merges a pull/merge request via GitHub REST API (when Token is configured) or `gh`/`glab`.
    pub async fn merge_pull_async(&self, repo: &HostedRepo, number: i64, method: Option<&str>) -> Result<(), ApiError> {
        let run = if repo.platform == PublishPlatform::Github { &self.gh } else { &self.glab };
        Hosting {
            repo,
            run,
            github_rest: self.github_rest.as_ref(),
        }
        .merge(number, method)
        .await
    }

    /// `submitBranch` (async).
    pub async fn submit_async(&self, req: &SubmitBranch) -> Result<BranchPublication, ApiError> {
        if !Path::new(&req.cwd).is_absolute() || !sha_like(&req.sha) || req.title.trim().is_empty() {
            return Err(refused("cwd / sha / title"));
        }
        let cwd = tokio::fs::canonicalize(&req.cwd).await.map_err(|_| refused("cwd"))?;
        let cwd_for_git = cwd.clone();
        let (repo, key) = spawn_blocking_traced(move || {
            let Some(repo) = Repo::discover(&cwd_for_git).map_err(|_| refused("git failed; checkout retained"))? else {
                return Err(refused("git failed; checkout retained"));
            };
            if repo.root() != cwd_for_git {
                return Err(refused("checkout root"));
            }
            let common = vibevalley_git::read::git_common_dir(repo.root()).map_err(|_| refused("git failed; checkout retained"))?;
            let key = if common.file_name().is_some_and(|n| n == ".git") {
                common.parent().unwrap_or(&common)
            } else {
                &common
            };
            Ok((repo, key.display().to_string()))
        })
        .await
        .map_err(|_| refused("git failed; checkout retained"))??;
        let gate = self.serial.lock().entry(key).or_default().clone();
        let _held = gate.lock_owned().await;
        self.publish_async(&repo, req).await
    }

    async fn publish_async(&self, repo: &Repo, req: &SubmitBranch) -> Result<BranchPublication, ApiError> {
        let cwd = repo.root();
        let branch_ok = repo.check_ref_format_async(&format!("refs/heads/{}", req.branch)).await.unwrap_or(false);
        let base_ok = repo.check_ref_format_async(&format!("refs/heads/{}", req.base)).await.unwrap_or(false);
        if !branch_ok || !base_ok || req.branch.starts_with('-') || req.base.starts_with('-') {
            return Err(refused("branch / base"));
        }
        verify_unchanged_async(repo, &req.branch, &req.sha).await?;
        let remote = read_destination_async(repo).await?;
        let run = if remote.target.platform == PublishPlatform::Github {
            &self.gh
        } else {
            &self.glab
        };
        let host = Hosting {
            repo: &remote.target,
            run,
            github_rest: self.github_rest.as_ref(),
        };
        let default_branch = host.inspect().await?;
        if req.branch == req.base || req.branch == default_branch {
            return Err(refused("default / base branch"));
        }
        let mut result = BranchPublication {
            platform: remote.target.platform,
            repository: remote.target.name.clone(),
            branch: req.branch.clone(),
            sha: req.sha.clone(),
            base: req.base.clone(),
            check: BranchCheck::Preview,
            pushed: false,
            url: None,
            number: None,
            reused: None,
            state: None,
        };
        if req.dry_run == Some(true) {
            return Ok(result);
        }
        let base_sha = {
            let network = self.network.clone();
            let cwd = cwd.to_path_buf();
            let read = remote.read.clone();
            let base = req.base.clone();
            spawn_blocking_traced(move || {
                let net = |_: String| refused("git failed; checkout retained");
                let base_sha = network.tip(&cwd, &read, &base).map_err(net)?;
                network.fetch(&cwd, &read, &base).map_err(net)?;
                Ok::<_, ApiError>(base_sha)
            })
            .await
            .map_err(|_| refused("git failed; checkout retained"))??
        };
        match repo.merge_check_between_async(&base_sha, &req.sha).await {
            Ok(MergeCheck::Clean | MergeCheck::UpToDate) => {}
            Ok(MergeCheck::Conflicts(_)) => {
                return Err(refuse(BizCode::RepoRefused, t("server.repo.conflict", &[("base", req.base.clone().into())])));
            }
            Err(_) => return Err(refused("git failed; checkout retained")),
        }
        result.check = check_repository(cwd, self.check_timeout).await?;
        let after = read_destination_async(repo).await?;
        if after.name != remote.name || after.read != remote.read || after.write != remote.write {
            return Err(refused("remote changed during check"));
        }
        verify_unchanged_async(repo, &req.branch, &req.sha).await?;
        {
            let network = self.network.clone();
            let cwd = cwd.to_path_buf();
            let remote_read = remote.read.clone();
            let remote_write = remote.write.clone();
            let branch = req.branch.clone();
            let base = req.base.clone();
            let sha = req.sha.clone();
            spawn_blocking_traced(move || {
                let net = |_: String| refused("git failed; checkout retained");
                if network.tip(&cwd, &remote_read, &base).map_err(net)? != base_sha {
                    return Err(refused("remote changed during check"));
                }
                network
                    .push(&cwd, &remote_write, &branch, &sha)
                    .map_err(|_| refuse(BizCode::RepoRefused, t("server.repo.publish.pushUnconfirmed", &[("sha", sha.into())])))
            })
            .await
            .map_err(|_| refused("git failed; checkout retained"))??;
        }
        let linked = match host.find(&req.branch, &req.base).await {
            Ok(Some(r)) => Ok((r, true)),
            Ok(None) => host.create(req).await.map(|r| (r, false)),
            Err(e) => Err(e),
        };
        let ((number, url), reused) = linked.map_err(|e| {
            refuse(
                BizCode::RepoRefused,
                t(
                    "server.repo.publish.pushedWithoutLink",
                    &[("sha", req.sha.clone().into()), ("why", e.message.into())],
                ),
            )
        })?;
        result.pushed = true;
        result.number = Some(number);
        result.url = Some(url);
        result.reused = Some(reused);
        result.state = Some(BranchPublicationState::Open);
        Ok(result)
    }
}

/// Queries the hosted platform (`GitHub REST` / `gh` / `glab`) for a pull/merge request's current state.
pub(crate) async fn remote_pull_state(
    repo: &HostedRepo,
    number: i64,
    run: &HostRunner,
    github_rest: Option<&GitHubRest>,
) -> Result<PullRequestState, ApiError> {
    Hosting { repo, run, github_rest }.state(number).await
}
