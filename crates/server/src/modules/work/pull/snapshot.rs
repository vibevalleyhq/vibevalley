//! GitHub pull request snapshots (`gh api`), CI verdicts, and check fingerprinting.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vibevalley_protocol::{ApiError, BizCode};

use crate::base::refused as refuse;
use crate::modules::work::pull::publish::HostRun;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHubCheck {
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHubReview {
    pub id: String,
    pub author: String,
    pub bot: bool,
    pub state: String,
    pub body: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubComment {
    pub id: String,
    pub author: String,
    pub bot: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_hunk: Option<String>,
    pub body: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHubPullSnapshot {
    pub repo: String,
    pub number: i64,
    pub state: String,
    pub head: String,
    pub viewer: String,
    pub checks: Vec<GitHubCheck>,
    pub reviews: Vec<GitHubReview>,
    pub comments: Vec<GitHubComment>,
}

const FAILED_CHECKS: &[&str] = &[
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "CANCELED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
];

const FINISHED_CHECKS: &[&str] = &["COMPLETED", "SUCCESS", "FAILURE", "ERROR"];

/// Returns `(failed_checks, all_finished)`.
pub fn checks_verdict(checks: &[GitHubCheck]) -> (Vec<&GitHubCheck>, bool) {
    let failed: Vec<&GitHubCheck> = checks
        .iter()
        .filter(|check| {
            let token = if check.conclusion.is_empty() {
                check.status.as_str()
            } else {
                check.conclusion.as_str()
            };
            FAILED_CHECKS.contains(&token.to_ascii_uppercase().as_str())
        })
        .collect();
    let finished = !checks.is_empty()
        && checks
            .iter()
            .all(|check| !check.conclusion.is_empty() || FINISHED_CHECKS.contains(&check.status.to_ascii_uppercase().as_str()));
    (failed, finished)
}

/// Canonical SHA-256 hex fingerprint of `(head, sorted checks)`.
pub fn checks_fingerprint(head: &str, checks: &[GitHubCheck]) -> String {
    let mut sorted = checks.to_vec();
    sorted.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.url.cmp(&b.url)));
    #[derive(Serialize)]
    struct Input<'a> {
        head: &'a str,
        checks: &'a [GitHubCheck],
    }
    let payload = serde_json::to_vec(&Input { head, checks: &sorted }).unwrap_or_default();
    let digest = Sha256::digest(&payload);
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

/// Extracts the GitHub Actions job id from a check-run HTML URL.
pub fn actions_job_of(check_url: &str) -> Option<String> {
    let after = check_url.split("/job/").nth(1)?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { None } else { Some(digits) }
}

fn gh_call(gh: &HostRun, args: &[&str]) -> Result<String, ApiError> {
    let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let ans = gh(&owned);
    if !ans.ok {
        let stage = if ans.missing { "gh missing" } else { "gh snapshot" };
        return Err(refuse(BizCode::RepoRefused, format!("GitHub {stage} failed")));
    }
    Ok(ans.out)
}

#[derive(Deserialize)]
struct RawPrView {
    #[serde(default)]
    state: String,
    #[serde(default, rename = "headRefOid")]
    head_ref_oid: String,
    #[serde(default, rename = "statusCheckRollup")]
    status_check_rollup: Vec<RawCheck>,
}

#[derive(Deserialize)]
struct RawCheck {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default, rename = "detailsUrl")]
    details_url: Option<String>,
    #[serde(default, rename = "targetUrl")]
    target_url: Option<String>,
}

#[derive(Deserialize)]
struct RawUser {
    #[serde(default)]
    login: String,
    #[serde(default, rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct RawReview {
    id: serde_json::Number,
    user: Option<RawUser>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    submitted_at: Option<String>,
}

#[derive(Deserialize)]
struct RawIssueComment {
    id: serde_json::Number,
    user: Option<RawUser>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct RawReviewComment {
    id: serde_json::Number,
    user: Option<RawUser>,
    #[serde(default)]
    pull_request_review_id: Option<serde_json::Number>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<i64>,
    #[serde(default)]
    original_line: Option<i64>,
    #[serde(default)]
    diff_hunk: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct RawViewer {
    #[serde(default)]
    login: String,
}

fn is_bot(user: &RawUser) -> bool {
    user.kind.eq_ignore_ascii_case("Bot") || user.login.ends_with("[bot]")
}

/// Fetches a GitHub PR snapshot (`pr view`, `reviews`, `comments`, `issue comments`, `viewer`).
pub fn fetch_snapshot(gh: &HostRun, remote_repo: &str, number: i64) -> Result<GitHubPullSnapshot, ApiError> {
    let pr_out = gh_call(
        gh,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            remote_repo,
            "--json",
            "state,headRefOid,statusCheckRollup",
        ],
    )?;
    let pr: RawPrView = serde_json::from_str(&pr_out).map_err(|_| refuse(BizCode::RepoRefused, "GitHub PR decode failed"))?;
    let viewer = gh_call(gh, &["api", "user"])
        .ok()
        .and_then(|s| serde_json::from_str::<RawViewer>(&s).ok())
        .map(|v| v.login)
        .unwrap_or_default();

    let mut checks: Vec<GitHubCheck> = pr
        .status_check_rollup
        .into_iter()
        .map(|c| GitHubCheck {
            name: c.name.or(c.context).unwrap_or_default(),
            status: c.status.or(c.state).unwrap_or_default(),
            conclusion: c.conclusion.unwrap_or_default(),
            url: c.details_url.or(c.target_url).unwrap_or_default(),
        })
        .collect();
    checks.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.url.cmp(&b.url)));

    let reviews_raw: Vec<RawReview> = gh_call(gh, &["api", &format!("repos/{remote_repo}/pulls/{number}/reviews")])
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<RawReview>>(&s).ok())
        .unwrap_or_default();
    let reviews: Vec<GitHubReview> = reviews_raw
        .into_iter()
        .map(|r| {
            let (author, bot) = r.user.as_ref().map_or((String::new(), false), |u| (u.login.clone(), is_bot(u)));
            GitHubReview {
                id: r.id.to_string(),
                author,
                bot,
                state: r.state,
                body: r.body.unwrap_or_default(),
                at: r.submitted_at.unwrap_or_default(),
            }
        })
        .collect();

    let review_comments_raw: Vec<RawReviewComment> = gh_call(gh, &["api", &format!("repos/{remote_repo}/pulls/{number}/comments")])
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<RawReviewComment>>(&s).ok())
        .unwrap_or_default();
    let issue_comments_raw: Vec<RawIssueComment> = gh_call(gh, &["api", &format!("repos/{remote_repo}/issues/{number}/comments")])
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<RawIssueComment>>(&s).ok())
        .unwrap_or_default();

    let mut comments: Vec<GitHubComment> = Vec::with_capacity(review_comments_raw.len() + issue_comments_raw.len());
    for c in review_comments_raw {
        let (author, bot) = c.user.as_ref().map_or((String::new(), false), |u| (u.login.clone(), is_bot(u)));
        comments.push(GitHubComment {
            id: c.id.to_string(),
            author,
            bot,
            review_id: c.pull_request_review_id.map(|n| n.to_string()),
            path: c.path,
            line: c.line.or(c.original_line),
            diff_hunk: c.diff_hunk,
            body: c.body.unwrap_or_default(),
            at: c.created_at.unwrap_or_default(),
        });
    }
    for c in issue_comments_raw {
        let (author, bot) = c.user.as_ref().map_or((String::new(), false), |u| (u.login.clone(), is_bot(u)));
        comments.push(GitHubComment {
            id: c.id.to_string(),
            author,
            bot,
            review_id: None,
            path: None,
            line: None,
            diff_hunk: None,
            body: c.body.unwrap_or_default(),
            at: c.created_at.unwrap_or_default(),
        });
    }

    Ok(GitHubPullSnapshot {
        repo: remote_repo.into(),
        number,
        state: pr.state,
        head: pr.head_ref_oid,
        viewer,
        checks,
        reviews,
        comments,
    })
}

/// Tail of a failed GitHub Actions job log (last 40 lines, capped at 4000 bytes).
pub fn failed_job_log(gh: &HostRun, remote_repo: &str, check_url: &str) -> String {
    let Some(job) = actions_job_of(check_url) else {
        return String::new();
    };
    let Ok(out) = gh_call(gh, &["run", "view", "--job", &job, "--log-failed", "--repo", remote_repo]) else {
        return String::new();
    };
    let lines: Vec<&str> = out.trim().lines().collect();
    let start = lines.len().saturating_sub(40);
    let joined = lines[start..].join("\n");
    if joined.len() <= 4000 {
        joined
    } else {
        let mut cut = joined.len() - 4000;
        while !joined.is_char_boundary(cut) {
            cut += 1;
        }
        joined[cut..].to_string()
    }
}
