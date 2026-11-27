//! Background PR refresh (`open` -> `merged`/`closed` settlement) and GitHub
//! CI/review/comment polling with bot-round deduplication.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::Instrument;
use tracing::instrument::WithSubscriber;
use vibevalley_protocol::{PublishPlatform, PullRequestState};

use super::publish::{HostRunner, HostedRepo, remote_pull_state};
use super::service::{DEFAULT_POLL_SECONDS, Pull};
use super::snapshot::{GitHubCheck, GitHubComment, GitHubPullSnapshot, GitHubReview, checks_fingerprint, checks_verdict, failed_job_log, fetch_snapshot};
use crate::context::now;
use crate::repo::GitHubRest;
use crate::service::issue::{KnownPullEvent, PullRecord};

const POLL_CONCURRENCY: usize = 4;

/// Polls every tracked `open` PR's remote state in parallel (bounded); settles linked issues on `merged` / `closed`.
pub async fn refresh(pulls: &Pull) {
    let _guard = pulls.refresh_lock.lock().await;
    let open = pulls.open_pulls();
    let mut targets: Vec<(usize, PullRecord, HostedRepo, HostRunner)> = Vec::with_capacity(open.len());
    for (idx, row) in open.into_iter().enumerate() {
        let Ok(hosted) = pulls.hosted_repo_of_async(&row.repo, Some(row.platform)).await else {
            continue;
        };
        let runner = match hosted.platform {
            PublishPlatform::Github => pulls.gh.clone(),
            PublishPlatform::Gitlab => pulls.glab.clone(),
        };
        targets.push((idx, row, hosted, runner));
    }
    if targets.is_empty() {
        return;
    }

    let sem = Arc::new(Semaphore::new(POLL_CONCURRENCY));
    let mut set = JoinSet::new();
    let github_rest = pulls.publisher.github_rest().cloned();
    for (idx, row, hosted, runner) in targets {
        let sem = sem.clone();
        let rest = github_rest.clone();
        set.spawn(
            async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                let number = row.number;
                let state = remote_pull_state(&hosted, number, &runner, rest.as_ref()).await.ok()?;
                Some((idx, row, state))
            }
            .in_current_span()
            .with_current_subscriber(),
        );
    }
    let mut settled = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(item)) = joined {
            settled.push(item);
        }
    }
    settled.sort_by_key(|(idx, _, _)| *idx);

    for (_, row, state) in settled {
        if state == PullRequestState::Open {
            continue;
        }
        if let Err(err) = pulls.set_state_async(&row.id, state, now()).await {
            tracing::warn!(pull_id = %row.id, state = ?state, error = %err, "pull.poll failed to persist settled PR state");
            continue;
        }
        if let (Some(board), Some(issue_id)) = (pulls.board.as_ref(), row.issue_id.as_deref())
            && let Err(err) = board.settle_pull_async(issue_id, state).await
        {
            tracing::warn!(pull_id = %row.id, issue_id, state = ?state, error = %err, "pull.poll failed to settle linked issue for PR");
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
pub async fn poll(pulls: &Pull) {
    let _guard = pulls.poll_lock.lock().await;
    let open = pulls.open_pulls();
    let mut targets: Vec<(usize, PullRecord, String)> = Vec::new();
    for (idx, row) in open.into_iter().filter(|row| row.platform == PublishPlatform::Github).enumerate() {
        let Ok(remote) = pulls.github_remote_async(&row.repo).await else {
            continue;
        };
        targets.push((idx, row, remote));
    }
    if targets.is_empty() {
        return;
    }

    let sem = Arc::new(Semaphore::new(POLL_CONCURRENCY));
    let mut set = JoinSet::new();
    let github_rest = pulls.publisher.github_rest().cloned();
    for (idx, row, remote) in targets {
        let sem = sem.clone();
        let gh = pulls.gh.clone();
        let rest = github_rest.clone();
        set.spawn(
            async move {
                let Ok(_permit) = sem.acquire_owned().await else { return None };
                let number = row.number;
                let snapshot = fetch_snapshot(&gh, rest.as_ref(), &remote, number).await.ok()?;
                Some((idx, row, remote, snapshot))
            }
            .in_current_span()
            .with_current_subscriber(),
        );
    }
    let mut snapshots = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(item)) = joined {
            snapshots.push(item);
        }
    }
    snapshots.sort_by_key(|(idx, _, _, _)| *idx);

    for (_, row, remote, current) in snapshots {
        poll_one(pulls, &row, &remote, current).await;
    }
}

async fn fetch_failed_job_logs(gh: &HostRunner, github_rest: Option<&GitHubRest>, remote: &str, failed: &[&GitHubCheck]) -> Vec<String> {
    if failed.len() <= 1 {
        let mut out = Vec::with_capacity(failed.len());
        for check in failed {
            out.push(failed_job_log(gh, github_rest, remote, &check.url).await);
        }
        return out;
    }
    let items: Vec<(usize, String)> = failed.iter().enumerate().map(|(idx, check)| (idx, check.url.clone())).collect();
    let sem = Arc::new(Semaphore::new(POLL_CONCURRENCY));
    let mut set = JoinSet::new();
    let github_rest = github_rest.cloned();
    for (idx, url) in items {
        let sem = sem.clone();
        let gh = gh.clone();
        let rest = github_rest.clone();
        let remote = remote.to_string();
        set.spawn(
            async move {
                let Ok(_permit) = sem.acquire_owned().await else {
                    return (idx, String::new());
                };
                let log = failed_job_log(&gh, rest.as_ref(), &remote, &url).await;
                (idx, log)
            }
            .in_current_span()
            .with_current_subscriber(),
        );
    }
    let mut logs = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(item) = joined {
            logs.push(item);
        }
    }
    logs.sort_by_key(|(idx, _)| *idx);
    logs.into_iter().map(|(_, log)| log).collect()
}

fn check_status_label(check: &GitHubCheck) -> &str {
    if check.conclusion.is_empty() {
        check.status.as_str()
    } else {
        check.conclusion.as_str()
    }
}

async fn format_ci_report_async(gh: &HostRunner, github_rest: Option<&GitHubRest>, remote: &str, checks: &[GitHubCheck], failed: &[&GitHubCheck]) -> String {
    if failed.is_empty() {
        return checks
            .iter()
            .map(|check| format!("{}: {}", check.name, check_status_label(check)))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let logs = fetch_failed_job_logs(gh, github_rest, remote, failed).await;
    failed
        .iter()
        .zip(logs)
        .map(|(check, log)| {
            let status = check_status_label(check);
            if log.is_empty() {
                format!("{}: {status}", check.name)
            } else {
                format!("{}: {status}\n{log}", check.name)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn observe_checks_async(pulls: &Pull, row: &PullRecord, remote: &str, current: &GitHubPullSnapshot, linked_issue_id: Option<&str>, at: i64) {
    let fingerprint = checks_fingerprint(&current.head, &current.checks);
    if fingerprint == row.check_fingerprint {
        return;
    }
    let revision = row.check_revision + 1;
    let (failed, finished) = checks_verdict(&current.checks);
    if let Err(err) = pulls.observe_checks_async(&row.id, &fingerprint, revision, at).await {
        tracing::warn!(pull_id = %row.id, revision, error = %err, "pull.poll failed to persist observed CI checks");
    }

    let (Some(board), Some(issue_id)) = (&pulls.board, linked_issue_id) else {
        return;
    };
    if failed.is_empty() && !finished {
        return;
    }
    let text = format_ci_report_async(&pulls.gh, pulls.publisher.github_rest(), remote, &current.checks, &failed).await;
    let key = format!("{}#{}:ci:{revision}", row.repo, row.number);
    if let Err(err) = board.tell_message_async(issue_id, &text, &key).await {
        tracing::warn!(pull_id = %row.id, issue_id, key = %key, error = %err, "pull.poll failed to notify issue of CI verdict");
    }
}

fn format_comment_text(comment: &GitHubComment) -> String {
    let mut parts = Vec::new();
    if !comment.author.is_empty() {
        parts.push(comment.author.clone());
    }
    if let Some(path) = &comment.path {
        let loc = match comment.line {
            Some(line) => format!("{path}:{line}"),
            None => path.clone(),
        };
        parts.push(loc);
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
    parts.join("\n")
}

fn review_to_poll_event(row: &PullRecord, review: &GitHubReview) -> PollEvent {
    PollEvent {
        key: format!("{}#{}:review:{}", row.repo, row.number, review.id),
        author: review.author.clone(),
        bot: review.bot,
        round_key: format!("{}:review:{}", review.author, review.id),
        occurred: review.at.clone(),
        text: format!("{} {}\n{}", review.author, review.state, review.body).trim().into(),
    }
}

fn comment_to_poll_event(row: &PullRecord, comment: &GitHubComment) -> PollEvent {
    let round_key = match &comment.review_id {
        Some(rid) => format!("{}:review:{rid}", comment.author),
        None => format!("{}:comment:{}", comment.author, comment.id),
    };
    PollEvent {
        key: format!("{}#{}:comment:{}", row.repo, row.number, comment.id),
        author: comment.author.clone(),
        bot: comment.bot,
        round_key,
        occurred: comment.at.clone(),
        text: format_comment_text(comment),
    }
}

fn collect_sorted_poll_events(row: &PullRecord, current: &GitHubPullSnapshot) -> Vec<PollEvent> {
    let mut events: Vec<PollEvent> = Vec::with_capacity(current.reviews.len() + current.comments.len());
    events.extend(current.reviews.iter().map(|review| review_to_poll_event(row, review)));
    events.extend(current.comments.iter().map(|comment| comment_to_poll_event(row, comment)));
    events.sort_by(|a, b| a.occurred.cmp(&b.occurred).then_with(|| a.key.cmp(&b.key)));
    events
}

struct KnownPollState {
    seen_keys: HashSet<String>,
    rounds: HashMap<String, i64>,
    bot_round: i64,
}

impl KnownPollState {
    fn from_known(known: Vec<KnownPullEvent>) -> Self {
        let seen_keys = known.iter().map(|e| e.key.clone()).collect();
        let rounds: HashMap<String, i64> = known.into_iter().filter_map(|e| Some((e.bot_round_key?, e.bot_round?))).collect();
        let bot_round = rounds.values().copied().max().unwrap_or(0);
        Self { seen_keys, rounds, bot_round }
    }

    async fn record_and_notify_async(&mut self, pulls: &Pull, row: &PullRecord, viewer: &str, linked_issue_id: Option<&str>, event: PollEvent) {
        if self.seen_keys.contains(&event.key) || (!viewer.is_empty() && event.author.eq_ignore_ascii_case(viewer)) {
            return;
        }
        let round = event.bot.then(|| self.rounds.get(&event.round_key).copied().unwrap_or(self.bot_round + 1));
        let round_key = round.map(|_| event.round_key.as_str());
        if let Err(err) = pulls.keep_event_async(&row.id, &event.key, round_key, round).await {
            tracing::warn!(pull_id = %row.id, event_key = %event.key, error = %err, "pull.poll failed to record PR event");
            return;
        }
        self.seen_keys.insert(event.key.clone());
        if let Some(r) = round {
            self.rounds.insert(event.round_key, r);
            self.bot_round = self.bot_round.max(r);
        }
        if let (Some(board), Some(issue_id)) = (&pulls.board, linked_issue_id)
            && !event.text.is_empty()
            && let Err(err) = board.tell_message_async(issue_id, &event.text, &event.key).await
        {
            tracing::warn!(pull_id = %row.id, issue_id, event_key = %event.key, error = %err, "pull.poll failed to deliver PR review/comment to issue");
        }
    }
}

async fn poll_one(pulls: &Pull, row: &PullRecord, remote: &str, current: GitHubPullSnapshot) {
    let at = now();
    let linked_open = match (row.issue_id.as_deref(), pulls.board.as_ref()) {
        (Some(id), Some(board)) => board.issue_async(id).await.ok().flatten().filter(|issue| !issue.status.is_closed()),
        _ => None,
    };
    let linked_issue_id = linked_open.as_ref().map(|issue| issue.id.as_str());

    observe_checks_async(pulls, row, remote, &current, linked_issue_id, at).await;

    let Ok(known) = pulls.known_events_async(&row.id).await else {
        return;
    };
    let mut state = KnownPollState::from_known(known);
    let events = collect_sorted_poll_events(row, &current);
    for event in events {
        state.record_and_notify_async(pulls, row, &current.viewer, linked_issue_id, event).await;
    }
}

impl Pull {
    pub async fn refresh_async(&self) {
        refresh(self).await;
    }

    pub async fn poll_async(&self) {
        poll(self).await;
    }

    /// Starts the background PR refresh/poll loop on `ctx.task`.
    pub fn start_poller(self: &Arc<Self>, poll_seconds: Option<u64>) {
        let Some(secs) = poll_seconds else { return };
        let interval = Duration::from_secs(if secs > 0 { secs } else { DEFAULT_POLL_SECONDS });
        let cancel = self.ctx.task.child_token();
        let task_cancel = cancel.clone();
        let weak = Arc::downgrade(self);
        let span = tracing::debug_span!("pull.poll", interval_secs = interval.as_secs());
        let handle = self.ctx.task.spawn(
            async move {
                let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        biased;
                        _ = task_cancel.cancelled() => return,
                        _ = timer.tick() => {}
                    }
                    if task_cancel.is_cancelled() {
                        return;
                    }
                    let Some(p) = weak.upgrade() else { return };
                    if p.closed.load(std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    tokio::select! {
                        biased;
                        _ = task_cancel.cancelled() => return,
                        _ = async {
                            p.refresh_async().await;
                            p.poll_async().await;
                        } => {}
                    }
                }
            }
            .instrument(span),
        );
        *self.poller.lock() = Some((cancel, handle));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull_row() -> PullRecord {
        PullRecord {
            id: "pr-1".into(),
            repo: "org/repo".into(),
            platform: PublishPlatform::Github,
            number: 42,
            url: "https://github.com/org/repo/pull/42".into(),
            branch: "feat/x".into(),
            base: "main".into(),
            state: PullRequestState::Open,
            issue_id: Some("i-1".into()),
            check_fingerprint: String::new(),
            check_revision: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn check_status_label_prefers_conclusion_over_status() {
        let finished = GitHubCheck {
            name: "clippy".into(),
            status: "COMPLETED".into(),
            conclusion: "FAILURE".into(),
            url: String::new(),
        };
        let running = GitHubCheck {
            name: "test".into(),
            status: "IN_PROGRESS".into(),
            conclusion: String::new(),
            url: String::new(),
        };
        assert_eq!(check_status_label(&finished), "FAILURE");
        assert_eq!(check_status_label(&running), "IN_PROGRESS");
    }

    #[test]
    fn format_comment_text_keeps_author_location_last_three_hunk_lines_and_body() {
        let comment = GitHubComment {
            id: "c1".into(),
            author: "bot".into(),
            bot: true,
            review_id: Some("r1".into()),
            path: Some("src/lib.rs".into()),
            line: Some(12),
            diff_hunk: Some("l1\nl2\nl3\nl4".into()),
            body: "fix this".into(),
            at: "2026-01-01T00:00:02Z".into(),
        };
        assert_eq!(format_comment_text(&comment), "bot\nsrc/lib.rs:12\nl2\nl3\nl4\nfix this");
    }

    #[test]
    fn collect_sorted_poll_events_orders_by_timestamp_then_key() {
        let row = pull_row();
        let snap = GitHubPullSnapshot {
            repo: "org/repo".into(),
            number: 42,
            state: "OPEN".into(),
            head: "abc".into(),
            viewer: "me".into(),
            checks: vec![],
            reviews: vec![GitHubReview {
                id: "r1".into(),
                author: "rev".into(),
                bot: true,
                state: "COMMENTED".into(),
                body: "looks ok".into(),
                at: "2026-01-01T00:00:02Z".into(),
            }],
            comments: vec![GitHubComment {
                id: "c1".into(),
                author: "rev".into(),
                bot: true,
                review_id: Some("r1".into()),
                path: None,
                line: None,
                diff_hunk: None,
                body: "nit".into(),
                at: "2026-01-01T00:00:02Z".into(),
            }],
        };
        let events = collect_sorted_poll_events(&row, &snap);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].key, "org/repo#42:comment:c1");
        assert_eq!(events[1].key, "org/repo#42:review:r1");
        assert_eq!(events[0].round_key, "rev:review:r1");
    }
}
