//! `repo.pr.submit`: an existing branch pushed and a pull (or merge)
//! request opened for it. Only the user publishes: the checkout must
//! be its root, clean and at the given sha; the one remote must read and
//! push to the same GitHub or GitLab repository; the base must merge
//! cleanly and `.vibevalley/check` pass before the push.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, BranchCheck, BranchPublication, BranchPublicationState, PublishPlatform, PullRequestState, SubmitBranch};

use crate::context::error::refused as refuse;
use crate::log::spawn_blocking_traced;

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

fn run_git(cwd: &Path, args: &[&str]) -> Option<(i32, String, String)> {
    let o = Command::new("git").arg("-C").arg(cwd).args(args).output().ok()?;
    Some((
        o.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&o.stdout).into_owned(),
        String::from_utf8_lossy(&o.stderr).into_owned(),
    ))
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    match run_git(cwd, args) {
        Some((0, out, _)) => Ok(out),
        Some((_, _, err)) => Err(err.trim().lines().last().unwrap_or("git failed").to_string()),
        None => Err("git did not run".into()),
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
}

impl Hosting<'_> {
    fn github(&self) -> bool {
        self.repo.platform == PublishPlatform::Github
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
            let stage = if r.missing {
                if self.github() {
                    "gh missing".to_string()
                } else {
                    "glab missing".to_string()
                }
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
}

/// `checkRepository`: `.vibevalley/check` at cwd: not run when there is
/// none, passed, or refused with its last lines.
pub async fn check_repository(cwd: &Path, limit: Duration) -> Result<BranchCheck, ApiError> {
    let file = cwd.join(".vibevalley").join("check");
    if tokio::fs::symlink_metadata(&file).await.is_err() {
        return Ok(BranchCheck::NotRun);
    }
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut path: Vec<String> = vec![cwd.join("node_modules").join(".bin").display().to_string()];
    path.extend(inherited.split(':').filter(|p| !p.contains("node_modules/.bin")).map(str::to_string));
    let mut c = tokio::process::Command::new(&file);
    c.current_dir(cwd).env("PATH", path.join(":"));
    let (why, said) = match vibevalley_runtime::oar::run_output_with_timeout(c, limit, None).await {
        Ok(o) if o.timed_out => (t("server.repo.check.timedOut", &[("seconds", (limit.as_secs() as i64).into())]), String::new()),
        Ok(o) if o.success() => return Ok(BranchCheck::Passed),
        Ok(o) => (
            t("server.repo.check.exited", &[("code", i64::from(o.code().unwrap_or(-1)).into())]),
            format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
        ),
        Err(e) => (t("server.repo.check.failed", &[("why", e.to_string().into())]), String::new()),
    };
    let tail: Vec<&str> = said.trim().lines().collect();
    let tail = tail[tail.len().saturating_sub(40)..].join("\n");
    Err(refuse(BizCode::RepoRefused, format!("{why}\n{tail}")))
}

/// The publisher, with its tools.
pub struct Publisher {
    gh: HostRunner,
    glab: HostRunner,
    pub network: Arc<dyn Network>,
    pub check_timeout: Duration,
    serial: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Default for Publisher {
    fn default() -> Self {
        Publisher {
            gh: HostRunner::Cli("gh"),
            glab: HostRunner::Cli("glab"),
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

fn verify_unchanged(cwd: &Path, branch_want: &str, sha_want: &str) -> Result<(), ApiError> {
    let status = git(cwd, &["status", "--porcelain=v2", "--branch", "--untracked-files=all"]).map_err(|_| refused("git failed; checkout retained"))?;
    let branch = status.lines().find_map(|l| l.strip_prefix("# branch.head ")).unwrap_or("");
    let sha = status.lines().find_map(|l| l.strip_prefix("# branch.oid ")).unwrap_or("");
    let clean = status.lines().all(|l| l.starts_with("# ") || l.is_empty());
    if branch != branch_want || sha != sha_want || !clean {
        return Err(refused("checkout changed or dirty"));
    }
    Ok(())
}

fn read_destination(cwd: &Path) -> Result<Remote, ApiError> {
    let out = git(cwd, &["config", "--null", "--list"]).map_err(|_| refused("git failed; checkout retained"))?;
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
            network,
            check_timeout: Duration::from_secs(600),
            serial: Mutex::default(),
        }
    }

    /// `submitBranch` (async).
    pub async fn submit_async(&self, req: &SubmitBranch) -> Result<BranchPublication, ApiError> {
        if !Path::new(&req.cwd).is_absolute() || !sha_like(&req.sha) || req.title.trim().is_empty() {
            return Err(refused("cwd / sha / title"));
        }
        let req_cwd = req.cwd.clone();
        let (cwd, key) = spawn_blocking_traced(move || {
            let cwd = std::fs::canonicalize(&req_cwd).map_err(|_| refused("cwd"))?;
            let loc = git(&cwd, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])
                .map_err(|_| refused("git failed; checkout retained"))?;
            let mut lines = loc.lines();
            let (top, common) = (lines.next().unwrap_or(""), lines.next().unwrap_or(""));
            if Path::new(top) != cwd || common.is_empty() {
                return Err(refused("checkout root"));
            }
            let common = PathBuf::from(common);
            let key = if common.file_name().is_some_and(|n| n == ".git") {
                common.parent().unwrap_or(&common)
            } else {
                &common
            };
            Ok((cwd, key.display().to_string()))
        })
        .await
        .map_err(|_| refused("git failed; checkout retained"))??;
        let gate = self.serial.lock().entry(key).or_default().clone();
        let _held = gate.lock_owned().await;
        self.publish_async(&cwd, req).await
    }

    async fn publish_async(&self, cwd: &Path, req: &SubmitBranch) -> Result<BranchPublication, ApiError> {
        let remote = {
            let cwd = cwd.to_path_buf();
            let branch = req.branch.clone();
            let base = req.base.clone();
            let sha = req.sha.clone();
            spawn_blocking_traced(move || {
                let valid = |b: &str| run_git(&cwd, &["check-ref-format", &format!("refs/heads/{b}")]).is_some_and(|r| r.0 == 0);
                if !valid(&branch) || !valid(&base) || branch.starts_with('-') || base.starts_with('-') {
                    return Err(refused("branch / base"));
                }
                verify_unchanged(&cwd, &branch, &sha)?;
                read_destination(&cwd)
            })
            .await
            .map_err(|_| refused("git failed; checkout retained"))??
        };
        let run = if remote.target.platform == PublishPlatform::Github {
            &self.gh
        } else {
            &self.glab
        };
        let host = Hosting { repo: &remote.target, run };
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
            let sha = req.sha.clone();
            spawn_blocking_traced(move || {
                let net = |_: String| refused("git failed; checkout retained");
                let base_sha = network.tip(&cwd, &read, &base).map_err(net)?;
                network.fetch(&cwd, &read, &base).map_err(net)?;
                let merged = run_git(&cwd, &["merge-tree", "--write-tree", "--name-only", "--no-messages", &base_sha, &sha]);
                match merged {
                    Some((0, _, _)) => Ok(base_sha),
                    Some((1, _, _)) => Err(refuse(BizCode::RepoRefused, t("server.repo.conflict", &[("base", base.into())]))),
                    _ => Err(refused("git failed; checkout retained")),
                }
            })
            .await
            .map_err(|_| refused("git failed; checkout retained"))??
        };
        result.check = check_repository(cwd, self.check_timeout).await?;
        {
            let network = self.network.clone();
            let cwd = cwd.to_path_buf();
            let remote_name = remote.name.clone();
            let remote_read = remote.read.clone();
            let remote_write = remote.write.clone();
            let branch = req.branch.clone();
            let base = req.base.clone();
            let sha = req.sha.clone();
            spawn_blocking_traced(move || {
                let net = |_: String| refused("git failed; checkout retained");
                let after = read_destination(&cwd)?;
                if after.name != remote_name
                    || after.read != remote_read
                    || after.write != remote_write
                    || network.tip(&cwd, &remote_read, &base).map_err(net)? != base_sha
                {
                    return Err(refused("remote changed during check"));
                }
                verify_unchanged(&cwd, &branch, &sha)?;
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

/// Queries the hosted platform (`gh`/`glab`) for a pull/merge request's current state.
pub(crate) async fn remote_pull_state(repo: &HostedRepo, number: i64, run: &HostRunner) -> Result<PullRequestState, ApiError> {
    Hosting { repo, run }.state(number).await
}
