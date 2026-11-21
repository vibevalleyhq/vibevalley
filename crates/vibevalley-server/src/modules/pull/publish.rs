//! `repo.pr.submit`: an existing branch pushed and a pull (or merge)
//! request opened for it (VibeValley `modules/repo/publish.ts`,
//! `hosting.ts`, `check.ts`). Only the user publishes: the checkout must
//! be its root, clean and at the given sha; the one remote must read and
//! push to the same GitHub or GitLab repository; the base must merge
//! cleanly and `.vibevalley/check` pass before the push.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, BizCode, BranchCheck, BranchPublication, BranchPublicationState, Caller, PublishPlatform, PullRequest, PullRequestState, SubmitBranch, ops,
};

use crate::Hub;
use crate::base::refused as refuse;

/// What a `gh`/`glab` call answered: ok, its output, and whether the tool is missing.
pub struct Answer {
    pub ok: bool,
    pub out: String,
    pub missing: bool,
}

pub type HostRun = Arc<dyn Fn(&[String]) -> Answer + Send + Sync>;

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

/// `runGitHub` / `runGitLab`: the tool on PATH, 15 s at most.
pub(crate) fn host_command(tool: &'static str) -> HostRun {
    Arc::new(move |args: &[String]| {
        let mut c = Command::new(tool);
        c.args(args);
        if tool == "glab" {
            c.env("GITLAB_HOST", "gitlab.com").env("GLAB_PROMPT_DISABLED", "1");
        } else {
            c.env("GH_PROMPT_DISABLED", "1");
        }
        match output_within(c, Duration::from_secs(15)) {
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
    })
}

/// A command's exit code and stdout; none when it ran out of time; Err(true)
/// when it is not installed.
pub(crate) fn output_within(mut c: Command, limit: Duration) -> Result<Option<(i32, String)>, bool> {
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = c.spawn().map_err(|e| e.kind() == std::io::ErrorKind::NotFound)?;
    let (tx, rx) = flume::bounded(1);
    let id = child.id();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(limit) {
        Ok(Ok(o)) => Ok(Some((o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned()))),
        Ok(Err(_)) => Err(false),
        Err(_) => {
            let _ = Command::new("kill").arg(id.to_string()).status();
            Ok(None)
        }
    }
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

struct Hosting<'a> {
    repo: &'a HostedRepo,
    run: &'a HostRun,
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

    fn request(&self, args: &[&str]) -> Result<String, ApiError> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let r = (self.run)(&args);
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
    pub(crate) fn state(&self, number: i64) -> Result<PullRequestState, ApiError> {
        let out = if self.github() {
            self.request(&["pr", "view", &number.to_string(), "--repo", &self.repo.name, "--json", "state"])?
        } else {
            self.request(&["api", &format!("{}/merge_requests/{number}", self.project())])?
        };
        let v: Value = serde_json::from_str(&out).map_err(|_| platform_failed("pull state decode"))?;
        let raw = v["state"].as_str().ok_or_else(|| platform_failed("pull state decode"))?;
        match raw.to_ascii_lowercase().as_str() {
            "open" | "opened" => Ok(PullRequestState::Open),
            "merged" => Ok(PullRequestState::Merged),
            "closed" => Ok(PullRequestState::Closed),
            _ => Err(platform_failed("pull state decode")),
        }
    }

    fn inspect(&self) -> Result<String, ApiError> {
        self.request(&["auth", "status", "--hostname", &self.repo.host])?;
        let out = if self.github() {
            self.request(&["repo", "view", &self.repo.name, "--json", "defaultBranchRef"])?
        } else {
            self.request(&["api", &self.project()])?
        };
        let v: Value = serde_json::from_str(&out).map_err(|_| platform_failed("repository decode"))?;
        let base = if self.github() {
            &v["defaultBranchRef"]["name"]
        } else {
            &v["default_branch"]
        };
        base.as_str().map(str::to_string).ok_or_else(|| platform_failed("repository decode"))
    }

    fn find(&self, branch: &str, base: &str) -> Result<Option<(i64, String)>, ApiError> {
        if self.github() {
            let out = self.request(&[
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
            ])?;
            let list: Vec<Value> = serde_json::from_str(&out).map_err(|_| platform_failed("list decode"))?;
            if list.len() > 1 {
                return Err(platform_failed("list decode"));
            }
            return list
                .iter()
                .find(|p| p["isCrossRepository"] == false && p["state"] == "OPEN")
                .map(|p| self.receipt(p["number"].as_i64().unwrap_or(0), p["url"].as_str().unwrap_or("")))
                .transpose();
        }
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let out = self.request(&[
            "api",
            &format!(
                "{}/merge_requests?state=opened&source_branch={}&target_branch={}&per_page=2",
                self.project(),
                enc(branch),
                enc(base)
            ),
        ])?;
        let list: Vec<Value> = serde_json::from_str(&out).map_err(|_| platform_failed("list decode"))?;
        if list.len() > 1 {
            return Err(platform_failed("list decode"));
        }
        list.iter()
            .find(|m| m["source_project_id"] == m["target_project_id"] && (m["state"] == "opened" || m["state"] == "locked"))
            .map(|m| self.receipt(m["iid"].as_i64().unwrap_or(0), m["web_url"].as_str().unwrap_or("")))
            .transpose()
    }

    fn create(&self, req: &SubmitBranch) -> Result<(i64, String), ApiError> {
        if self.github() {
            let out = self.request(&[
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
            ])?;
            let url = out.trim();
            let n = url.rsplit('/').next().and_then(|n| n.parse().ok()).unwrap_or(0);
            return self.receipt(n, url);
        }
        let out = self.request(&[
            "api",
            &format!("{}/merge_requests", self.project()),
            "--method",
            "POST",
            "--raw-field",
            &format!("source_branch={}", req.branch),
            "--raw-field",
            &format!("target_branch={}", req.base),
            "--raw-field",
            &format!("title={}", req.title),
            "--raw-field",
            &format!("description={}", req.body),
        ])?;
        let m: Value = serde_json::from_str(&out).map_err(|_| platform_failed("create decode"))?;
        if m["source_project_id"] != m["target_project_id"] || !(m["state"] == "opened" || m["state"] == "locked") {
            return Err(platform_failed("create decode"));
        }
        self.receipt(m["iid"].as_i64().unwrap_or(0), m["web_url"].as_str().unwrap_or(""))
    }
}

/// `checkRepository`: `.vibevalley/check` at cwd: not run when there is
/// none, passed, or refused with its last lines.
pub fn check_repository(cwd: &Path, limit: Duration) -> Result<BranchCheck, ApiError> {
    let file = cwd.join(".vibevalley").join("check");
    if std::fs::symlink_metadata(&file).is_err() {
        return Ok(BranchCheck::NotRun);
    }
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut path: Vec<String> = vec![cwd.join("node_modules").join(".bin").display().to_string()];
    path.extend(inherited.split(':').filter(|p| !p.contains("node_modules/.bin")).map(str::to_string));
    let mut c = Command::new(&file);
    c.current_dir(cwd).env("PATH", path.join(":"));
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = c
        .spawn()
        .map_err(|e| refuse(BizCode::RepoRefused, t("server.repo.check.failed", &[("why", e.to_string().into())])))?;
    let (tx, rx) = flume::bounded(1);
    let id = child.id();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let (why, said) = match rx.recv_timeout(limit) {
        Ok(Ok(o)) if o.status.success() => return Ok(BranchCheck::Passed),
        Ok(Ok(o)) => (
            t("server.repo.check.exited", &[("code", i64::from(o.status.code().unwrap_or(-1)).into())]),
            format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
        ),
        Ok(Err(e)) => (t("server.repo.check.failed", &[("why", e.to_string().into())]), String::new()),
        Err(_) => {
            let _ = Command::new("kill").arg(id.to_string()).status();
            (t("server.repo.check.timedOut", &[("seconds", (limit.as_secs() as i64).into())]), String::new())
        }
    };
    let tail: Vec<&str> = said.trim().lines().collect();
    let tail = tail[tail.len().saturating_sub(40)..].join("\n");
    Err(refuse(BizCode::RepoRefused, format!("{why}\n{tail}")))
}

/// The publisher, with its tools.
pub struct Publisher {
    pub gh: HostRun,
    pub glab: HostRun,
    pub network: Arc<dyn Network>,
    pub check_timeout: Duration,
    serial: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Default for Publisher {
    fn default() -> Self {
        Publisher::new(host_command("gh"), host_command("glab"), Arc::new(Git))
    }
}

struct Remote {
    name: String,
    read: String,
    write: String,
    target: HostedRepo,
}

impl Publisher {
    pub fn new(gh: HostRun, glab: HostRun, network: Arc<dyn Network>) -> Publisher {
        Publisher {
            gh,
            glab,
            network,
            check_timeout: Duration::from_secs(600),
            serial: Mutex::default(),
        }
    }

    /// `submitBranch` (blocking).
    pub fn submit(&self, req: &SubmitBranch) -> Result<BranchPublication, ApiError> {
        if !Path::new(&req.cwd).is_absolute() || !sha_like(&req.sha) || req.title.trim().is_empty() {
            return Err(refused("cwd / sha / title"));
        }
        let cwd = std::fs::canonicalize(&req.cwd).map_err(|_| refused("cwd"))?;
        let loc =
            git(&cwd, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).map_err(|_| refused("git failed; checkout retained"))?;
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
        let gate = self
            .serial
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key.display().to_string())
            .or_default()
            .clone();
        let _held = gate.lock().unwrap_or_else(|e| e.into_inner());
        self.publish(&cwd, req)
    }

    fn unchanged(&self, cwd: &Path, req: &SubmitBranch) -> Result<(), ApiError> {
        let status = git(cwd, &["status", "--porcelain=v2", "--branch", "--untracked-files=all"]).map_err(|_| refused("git failed; checkout retained"))?;
        let branch = status.lines().find_map(|l| l.strip_prefix("# branch.head ")).unwrap_or("");
        let sha = status.lines().find_map(|l| l.strip_prefix("# branch.oid ")).unwrap_or("");
        let clean = status.lines().all(|l| l.starts_with("# ") || l.is_empty());
        if branch != req.branch || sha != req.sha || !clean {
            return Err(refused("checkout changed or dirty"));
        }
        Ok(())
    }

    fn destination(&self, cwd: &Path) -> Result<Remote, ApiError> {
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

    fn publish(&self, cwd: &Path, req: &SubmitBranch) -> Result<BranchPublication, ApiError> {
        let valid = |b: &str| run_git(cwd, &["check-ref-format", &format!("refs/heads/{b}")]).is_some_and(|r| r.0 == 0);
        if !valid(&req.branch) || !valid(&req.base) || req.branch.starts_with('-') || req.base.starts_with('-') {
            return Err(refused("branch / base"));
        }
        self.unchanged(cwd, req)?;
        let remote = self.destination(cwd)?;
        let run = if remote.target.platform == PublishPlatform::Github {
            &self.gh
        } else {
            &self.glab
        };
        let host = Hosting { repo: &remote.target, run };
        let default_branch = host.inspect()?;
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
        let net = |_: String| refused("git failed; checkout retained");
        let base_sha = self.network.tip(cwd, &remote.read, &req.base).map_err(net)?;
        self.network.fetch(cwd, &remote.read, &req.base).map_err(net)?;
        let merged = run_git(cwd, &["merge-tree", "--write-tree", "--name-only", "--no-messages", &base_sha, &req.sha]);
        match merged {
            Some((0, _, _)) => {}
            Some((1, _, _)) => {
                return Err(refuse(BizCode::RepoRefused, t("server.repo.conflict", &[("base", req.base.clone().into())])));
            }
            _ => return Err(refused("git failed; checkout retained")),
        }
        result.check = check_repository(cwd, self.check_timeout)?;
        let after = self.destination(cwd)?;
        if after.name != remote.name
            || after.read != remote.read
            || after.write != remote.write
            || self.network.tip(cwd, &remote.read, &req.base).map_err(net)? != base_sha
        {
            return Err(refused("remote changed during check"));
        }
        self.unchanged(cwd, req)?;
        self.network.push(cwd, &remote.write, &req.branch, &req.sha).map_err(|_| {
            refuse(
                BizCode::RepoRefused,
                t("server.repo.publish.pushUnconfirmed", &[("sha", req.sha.clone().into())]),
            )
        })?;
        let linked = host.find(&req.branch, &req.base).and_then(|existing| match existing {
            Some(r) => Ok((r, true)),
            None => host.create(req).map(|r| (r, false)),
        });
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
pub fn remote_pull_state(repo: &HostedRepo, number: i64, run: &HostRun) -> Result<PullRequestState, ApiError> {
    Hosting { repo, run }.state(number)
}

/// Extracts the protocol `PullRequest` when a branch publication pushed and
/// opened or reused a hosted pull/merge request.
pub fn pull_request_of(pubbed: &BranchPublication) -> Option<PullRequest> {
    let (true, Some(number), Some(url)) = (pubbed.pushed, pubbed.number, pubbed.url.as_ref()) else {
        return None;
    };
    let state = match pubbed.state.unwrap_or(BranchPublicationState::Open) {
        BranchPublicationState::Open => PullRequestState::Open,
    };
    Some(PullRequest {
        url: url.clone(),
        number,
        state,
    })
}

/// `repo.pr.submit`, for the user only.
pub fn install(hub: &Hub, publisher: Arc<Publisher>) {
    install_with_board(hub, publisher, None);
}

pub fn install_with_board(hub: &Hub, publisher: Arc<Publisher>, board: Option<crate::modules::issue::Board>) {
    hub.on::<ops::RepoPrSubmit>(move |ctx, req| {
        if ctx.caller != Caller::User {
            return Err(refuse(BizCode::RepoRefused, t("server.repo.publish.userOnly", &[])));
        }
        let out = publisher.submit(&req)?;
        if let (Some(board), Some(pr)) = (&board, pull_request_of(&out))
            && let Some(issue) = board.open_issue_for_branch(&req.cwd, &req.branch)
        {
            let _ = board.record_pull_request(&issue.id, pr);
        }
        Ok(out)
    });
}
