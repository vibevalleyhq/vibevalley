//! Background PR refresh (`open` -> `merged`/`closed` settlement) and GitHub
//! CI/review/comment polling with bot-round deduplication.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use vibevalley_protocol::{PublishPlatform, PullRequestState};

use crate::modules::work::pull::Pulls;
use crate::modules::work::pull::publish::{HostRun, HostedRepo, remote_pull_state};
use crate::modules::work::pull::snapshot::{GitHubCheck, GitHubPullSnapshot, checks_fingerprint, checks_verdict, failed_job_log, fetch_snapshot};
use crate::modules::work::pull::store::PullRecord;
use crate::now;

const POLL_CONCURRENCY: usize = 4;

/// Polls every tracked `open` PR's remote state in parallel (bounded); settles linked issues on `merged` / `closed`.
pub fn refresh(pulls: &Pulls) {
    let _guard = pulls.refresh_lock.lock();
    let targets: Vec<(usize, PullRecord, HostedRepo, HostRun)> = pulls
        .store
        .open_pulls()
        .into_iter()
        .enumerate()
        .filter_map(|(idx, row)| {
            let hosted = pulls.hosted_repo_of(&row.repo, Some(row.platform)).ok()?;
            let runner = match hosted.platform {
                PublishPlatform::Github => pulls.gh.clone(),
                PublishPlatform::Gitlab => pulls.glab.clone(),
            };
            Some((idx, row, hosted, runner))
        })
        .collect();
    if targets.is_empty() {
        return;
    }

    let mut settled = vibevalley_runtime::rt::block_on(async move {
        let sem = Arc::new(Semaphore::new(POLL_CONCURRENCY));
        let mut set = JoinSet::new();
        for (idx, row, hosted, runner) in targets {
            let sem = sem.clone();
            set.spawn(async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                let number = row.number;
                let state = tokio::task::spawn_blocking(move || remote_pull_state(&hosted, number, &runner))
                    .await
                    .ok()?
                    .ok()?;
                Some((idx, row, state))
            });
        }
        let mut out = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(Some(item)) = joined {
                out.push(item);
            }
        }
        out
    });
    settled.sort_by_key(|(idx, _, _)| *idx);

    for (_, row, state) in settled {
        if state == PullRequestState::Open {
            continue;
        }
        if pulls.store.set_state(&row.id, state, now()).is_err() {
            continue;
        }
        if let (Some(board), Some(issue_id)) = (&pulls.board, row.issue_id.as_deref()) {
            let _ = board.settle_pull(issue_id, state);
        }
    }
}

struct PollEvent {
    key: String,
    author: String,
    bot: bool,
    round_key: String,
    occurred: String,
    text: String,
}

/// Polls GitHub CI checks, reviews, and comments for every tracked `open` GitHub PR.
pub fn poll(pulls: &Pulls) {
    let _guard = pulls.poll_lock.lock();
    let targets: Vec<(usize, PullRecord, String)> = pulls
        .store
        .open_pulls()
        .into_iter()
        .filter(|row| row.platform == PublishPlatform::Github)
        .enumerate()
        .filter_map(|(idx, row)| {
            let remote = pulls.github_remote(&row.repo).ok()?;
            Some((idx, row, remote))
        })
        .collect();
    if targets.is_empty() {
        return;
    }

    let gh = pulls.gh.clone();
    let mut snapshots = vibevalley_runtime::rt::block_on(async move {
        let sem = Arc::new(Semaphore::new(POLL_CONCURRENCY));
        let mut set = JoinSet::new();
        for (idx, row, remote) in targets {
            let sem = sem.clone();
            let gh = gh.clone();
            set.spawn(async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                let number = row.number;
                let remote_for_fetch = remote.clone();
                let snapshot = tokio::task::spawn_blocking(move || fetch_snapshot(&gh, &remote_for_fetch, number))
                    .await
                    .ok()?
                    .ok()?;
                Some((idx, row, remote, snapshot))
            });
        }
        let mut out = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(Some(item)) = joined {
                out.push(item);
            }
        }
        out
    });
    snapshots.sort_by_key(|(idx, _, _, _)| *idx);

    for (_, row, remote, current) in snapshots {
        poll_one(pulls, &row, &remote, current);
    }
}

fn fetch_failed_job_logs(gh: &HostRun, remote: &str, failed: &[&GitHubCheck]) -> Vec<String> {
    if failed.len() <= 1 {
        return failed.iter().map(|check| failed_job_log(gh, remote, &check.url)).collect();
    }
    let items: Vec<(usize, String)> = failed.iter().enumerate().map(|(idx, check)| (idx, check.url.clone())).collect();
    let gh = gh.clone();
    let remote = remote.to_string();
    let mut logs = vibevalley_runtime::rt::block_on(async move {
        let sem = Arc::new(Semaphore::new(POLL_CONCURRENCY));
        let mut set = JoinSet::new();
        for (idx, url) in items {
            let sem = sem.clone();
            let gh = gh.clone();
            let remote = remote.clone();
            set.spawn(async move {
                let Ok(_permit) = sem.acquire_owned().await else {
                    return (idx, String::new());
                };
                let log = tokio::task::spawn_blocking(move || failed_job_log(&gh, &remote, &url))
                    .await
                    .unwrap_or_default();
                (idx, log)
            });
        }
        let mut out = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(item) = joined {
                out.push(item);
            }
        }
        out
    });
    logs.sort_by_key(|(idx, _)| *idx);
    logs.into_iter().map(|(_, log)| log).collect()
}

fn poll_one(pulls: &Pulls, row: &PullRecord, remote: &str, current: GitHubPullSnapshot) {
    let at = now();
    let linked_open = row
        .issue_id
        .as_deref()
        .and_then(|id| pulls.board.as_ref().and_then(|b| b.issue(id)))
        .filter(|issue| !issue.status.is_closed());

    let fingerprint = checks_fingerprint(&current.head, &current.checks);
    if fingerprint != row.check_fingerprint {
        let revision = row.check_revision + 1;
        let (failed, finished) = checks_verdict(&current.checks);
        let _ = pulls.store.observe_checks(&row.id, &fingerprint, revision, at);
        if let (Some(board), Some(issue)) = (&pulls.board, &linked_open)
            && (!failed.is_empty() || finished)
        {
            let text = if !failed.is_empty() {
                let logs = fetch_failed_job_logs(&pulls.gh, remote, &failed);
                failed
                    .iter()
                    .zip(logs)
                    .map(|(check, log)| {
                        let status = if check.conclusion.is_empty() {
                            check.status.as_str()
                        } else {
                            check.conclusion.as_str()
                        };
                        if log.is_empty() {
                            format!("{}: {status}", check.name)
                        } else {
                            format!("{}: {status}\n{log}", check.name)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                current
                    .checks
                    .iter()
                    .map(|check| {
                        let status = if check.conclusion.is_empty() {
                            check.status.as_str()
                        } else {
                            check.conclusion.as_str()
                        };
                        format!("{}: {status}", check.name)
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let key = format!("{}#{}:ci:{revision}", row.repo, row.number);
            let _ = board.tell_message(&issue.id, &text, &key);
        }
    }

    let Ok(known) = pulls.store.known_events(&row.id) else {
        return;
    };
    let mut seen_keys: HashSet<String> = known.iter().map(|e| e.key.clone()).collect();
    let mut rounds: HashMap<String, i64> = known.into_iter().filter_map(|e| Some((e.bot_round_key?, e.bot_round?))).collect();
    let mut bot_round = rounds.values().copied().max().unwrap_or(0);

    let mut events: Vec<PollEvent> = Vec::with_capacity(current.reviews.len() + current.comments.len());
    for review in &current.reviews {
        events.push(PollEvent {
            key: format!("{}#{}:review:{}", row.repo, row.number, review.id),
            author: review.author.clone(),
            bot: review.bot,
            round_key: format!("{}:review:{}", review.author, review.id),
            occurred: review.at.clone(),
            text: format!("{} {}\n{}", review.author, review.state, review.body).trim().into(),
        });
    }
    for comment in &current.comments {
        let round_key = match &comment.review_id {
            Some(rid) => format!("{}:review:{rid}", comment.author),
            None => format!("{}:comment:{}", comment.author, comment.id),
        };
        let mut parts = Vec::new();
        if !comment.author.is_empty() {
            parts.push(comment.author.clone());
        }
        if let Some(path) = &comment.path {
            parts.push(match comment.line {
                Some(line) => format!("{path}:{line}"),
                None => path.clone(),
            });
        }
        if let Some(hunk) = &comment.diff_hunk {
            let lines: Vec<&str> = hunk.lines().collect();
            let tail = lines[lines.len().saturating_sub(3)..].join("\n");
            if !tail.is_empty() {
                parts.push(tail);
            }
        }
        if !comment.body.is_empty() {
            parts.push(comment.body.clone());
        }
        events.push(PollEvent {
            key: format!("{}#{}:comment:{}", row.repo, row.number, comment.id),
            author: comment.author.clone(),
            bot: comment.bot,
            round_key,
            occurred: comment.at.clone(),
            text: parts.join("\n"),
        });
    }
    events.sort_by(|a, b| a.occurred.cmp(&b.occurred).then_with(|| a.key.cmp(&b.key)));

    for event in events {
        if seen_keys.contains(&event.key) || (!current.viewer.is_empty() && event.author.eq_ignore_ascii_case(&current.viewer)) {
            continue;
        }
        let round = if event.bot {
            Some(rounds.get(&event.round_key).copied().unwrap_or(bot_round + 1))
        } else {
            None
        };
        let round_key = round.map(|_| event.round_key.as_str());
        if pulls.store.keep_event(&row.id, &event.key, round_key, round).is_err() {
            continue;
        }
        seen_keys.insert(event.key.clone());
        if let Some(r) = round {
            rounds.insert(event.round_key, r);
            bot_round = bot_round.max(r);
        }
        if let (Some(board), Some(issue)) = (&pulls.board, &linked_open)
            && !event.text.is_empty()
        {
            let _ = board.tell_message(&issue.id, &event.text, &event.key);
        }
    }
}
