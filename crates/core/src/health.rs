//! Deterministic repo health evaluation, backlog triage suggestion rules, and
//! three-part morning digest aggregation (SSOT for server, slices, CLI, UI, and orchestrator).

use std::collections::{BTreeSet, HashSet};

use vibevalley_protocol::{
    ActorKind, BacklogTriageSuggestion, DigestIssueRef, DigestProgressSummary, Issue, IssueRelation, IssueRelationKind, IssueStageKind, IssueStatus, Millis,
    MorningDigest, Outcome, Priority, ProjectCheckStatus, RepoHealth, RepoHealthReason, RepoHealthStatus, Run, Session, StuckReason, TriagePatch,
};

use crate::deps::blocked_issues;
use crate::status::{apply_issue_statuses, retain_recent_closed_and_sort};

fn derive_issues_local(issues: &[Issue], sessions: &[Session]) -> Vec<Issue> {
    let mut out = issues.to_vec();
    retain_recent_closed_and_sort(&mut out);
    apply_issue_statuses(&mut out, sessions);
    out
}

const STALE_ACTIVITY_WINDOW_MS: i64 = 14 * 24 * 60 * 60_000;
const STALE_BACKLOG_WINDOW_MS: i64 = 3 * 24 * 60 * 60_000;
const URGENT_DUE_WINDOW_MS: i64 = 48 * 60 * 60_000;

/// Minimal repo metadata needed by [`assess_repo_health`] and [`assess_repos_health`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoHealthInput {
    pub name: String,
    /// Last commit timestamp in Unix milliseconds, if any.
    pub last_commit_at: Option<i64>,
}

fn repo_matches(issue_repo: Option<&str>, repo_name: &str) -> bool {
    let Some(raw) = issue_repo.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    if raw == repo_name {
        return true;
    }
    raw.rsplit(['/', '\\']).next() == Some(repo_name)
}

/// Evaluates deterministic health (`on_track` / `at_risk` / `off_track`) for one repo
/// from already-derived issues and repo commit recency.
pub fn assess_repo_health(repo: &RepoHealthInput, issues: &[Issue], evaluated_at: i64) -> RepoHealth {
    let mut open_issues: i64 = 0;
    let mut in_progress_issues: i64 = 0;
    let mut in_review_issues: i64 = 0;
    let mut blocked_count: i64 = 0;
    let mut stuck_issues: i64 = 0;
    let mut asking_issues: i64 = 0;
    let mut failed_checks: i64 = 0;
    let mut overdue_issues: i64 = 0;

    for issue in issues {
        if issue.status.is_closed() || !repo_matches(issue.repo.as_deref(), &repo.name) {
            continue;
        }
        open_issues += 1;
        match issue.status {
            IssueStatus::InProgress => in_progress_issues += 1,
            IssueStatus::InReview => in_review_issues += 1,
            _ => {}
        }
        if !blocked_issues(issue, issues).is_empty() {
            blocked_count += 1;
        }
        match issue.stage.state {
            IssueStageKind::Stuck => stuck_issues += 1,
            IssueStageKind::Asking => asking_issues += 1,
            _ => {}
        }
        if issue
            .delivery_evidence
            .as_ref()
            .and_then(|d| d.check.as_ref())
            .is_some_and(|c| c.status == ProjectCheckStatus::Failed)
        {
            failed_checks += 1;
        }
        if evaluated_at > 0 && issue.due_at.is_some_and(|due| (due.get() as i64) < evaluated_at) {
            overdue_issues += 1;
        }
    }

    let mut reasons = Vec::new();
    if stuck_issues > 0 {
        reasons.push(RepoHealthReason::StuckIssues);
    }
    if failed_checks > 0 {
        reasons.push(RepoHealthReason::FailedChecks);
    }
    if overdue_issues > 0 {
        reasons.push(RepoHealthReason::OverdueIssues);
    }
    if asking_issues > 0 {
        reasons.push(RepoHealthReason::AskingUser);
    }
    if blocked_count > 0 {
        reasons.push(RepoHealthReason::BlockedIssues);
    }
    if open_issues > 0 && in_progress_issues == 0 && in_review_issues == 0 {
        reasons.push(RepoHealthReason::NoActiveProgress);
    }
    if open_issues > 0
        && evaluated_at > 0
        && repo
            .last_commit_at
            .is_some_and(|last| evaluated_at.saturating_sub(last) > STALE_ACTIVITY_WINDOW_MS)
    {
        reasons.push(RepoHealthReason::StaleActivity);
    }

    let status = if stuck_issues > 0 || failed_checks > 0 || overdue_issues >= 2 || (overdue_issues >= 1 && blocked_count > 0) {
        RepoHealthStatus::OffTrack
    } else if !reasons.is_empty() {
        RepoHealthStatus::AtRisk
    } else {
        reasons.push(RepoHealthReason::Healthy);
        RepoHealthStatus::OnTrack
    };

    RepoHealth {
        repo: repo.name.clone(),
        status,
        reasons,
        open_issues,
        in_progress_issues,
        in_review_issues,
        blocked_issues: blocked_count,
        stuck_issues,
        asking_issues,
        failed_checks,
        overdue_issues,
        last_commit_at: repo.last_commit_at,
        evaluated_at,
    }
}

/// Evaluates deterministic health across all given repos sorted by repo name.
/// Derives issue stages from `sessions` when `sessions` are provided so every caller
/// (Repo page, BoardSlice, CLI, orchestrator, morning digest) reads the exact same result.
pub fn assess_repos_health(repos: &[RepoHealthInput], issues: &[Issue], sessions: &[Session], evaluated_at: i64) -> Vec<RepoHealth> {
    let derived;
    let effective_issues = if sessions.is_empty() {
        issues
    } else {
        derived = derive_issues_local(issues, sessions);
        &derived
    };
    let mut sorted = repos.to_vec();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    sorted.into_iter().map(|r| assess_repo_health(&r, effective_issues, evaluated_at)).collect()
}

fn title_tokens(title: &str) -> BTreeSet<String> {
    title
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .map(str::trim)
        .filter(|w| w.chars().count() >= 3)
        .map(|w| w.to_ascii_lowercase())
        .collect()
}

fn titles_look_duplicate(a: &str, b: &str) -> bool {
    let ta = a.trim().to_ascii_lowercase();
    let tb = b.trim().to_ascii_lowercase();
    if ta.is_empty() || tb.is_empty() {
        return false;
    }
    if ta == tb {
        return true;
    }
    let wa = title_tokens(a);
    let wb = title_tokens(b);
    if wa.len() < 2 || wb.len() < 2 {
        return false;
    }
    let overlap = wa.intersection(&wb).count();
    overlap * 2 >= wa.len().max(wb.len())
}

fn has_duplicate_relation(issue: &Issue, other_id: &str) -> bool {
    issue.relations.iter().any(|r| r.kind == IssueRelationKind::Duplicate && r.issue == other_id)
}

fn single_repo_name(repos: &[RepoHealthInput]) -> Option<&str> {
    if repos.len() == 1 { Some(repos[0].name.as_str()) } else { None }
}

/// Computes deterministic, confirmable triage suggestions for open `backlog` issues.
/// Never modifies any issue fields directly.
pub fn suggest_backlog_triage(issues: &[Issue], repos: &[RepoHealthInput], evaluated_at: i64, dismissed_ids: &HashSet<String>) -> Vec<BacklogTriageSuggestion> {
    let mut out = Vec::new();
    let default_repo = single_repo_name(repos);

    let mut backlog: Vec<&Issue> = issues.iter().filter(|i| i.status == IssueStatus::Backlog).collect();
    backlog.sort_by_key(|i| i.number);

    for issue in backlog {
        if let Some(dup_target) = issues.iter().find(|other| {
            other.id != issue.id
                && !other.status.is_closed()
                && !has_duplicate_relation(issue, &other.id)
                && titles_look_duplicate(&issue.title, &other.title)
                && (issue.repo == other.repo || issue.repo.is_none() || other.repo.is_none())
        }) {
            let id = format!("auto:{}:duplicate:{}", issue.id, dup_target.id);
            if !dismissed_ids.contains(&id) {
                let mut next_relations = issue.relations.clone();
                next_relations.push(IssueRelation {
                    kind: IssueRelationKind::Duplicate,
                    issue: dup_target.id.clone(),
                });
                out.push(BacklogTriageSuggestion {
                    id,
                    issue_id: issue.id.clone(),
                    issue_number: issue.number,
                    issue_title: issue.title.clone(),
                    reason: format!("Title overlaps with #{} ({})", dup_target.number, dup_target.title),
                    summary: format!("Link #{} as duplicate of #{}", issue.number, dup_target.number),
                    source: ActorKind::System,
                    patch: TriagePatch {
                        relations: Some(next_relations),
                        ..Default::default()
                    },
                    created_at: evaluated_at,
                });
            }
        }

        if issue.priority == Priority::Medium {
            let due_soon = evaluated_at > 0
                && issue
                    .due_at
                    .is_some_and(|d| (d.get() as i64) <= evaluated_at.saturating_add(URGENT_DUE_WINDOW_MS));
            let lower = issue.title.to_ascii_lowercase();
            let urgent_kw = ["urgent", "blocker", "crash", "outage", "critical", "p0", "hotfix"]
                .iter()
                .any(|kw| lower.contains(kw));
            if due_soon || urgent_kw {
                let id = format!("auto:{}:priority", issue.id);
                if !dismissed_ids.contains(&id) {
                    let reason = if due_soon {
                        "Due date is within 48 hours while priority is still Medium".to_string()
                    } else {
                        "Urgent/blocker signal in title while priority is still Medium".to_string()
                    };
                    out.push(BacklogTriageSuggestion {
                        id,
                        issue_id: issue.id.clone(),
                        issue_number: issue.number,
                        issue_title: issue.title.clone(),
                        reason,
                        summary: format!("Raise #{} priority to High", issue.number),
                        source: ActorKind::System,
                        patch: TriagePatch {
                            priority: Some(Priority::High),
                            ..Default::default()
                        },
                        created_at: evaluated_at,
                    });
                }
            }
        }

        if issue.repo.is_none()
            && let Some(repo_name) = default_repo
        {
            let id = format!("auto:{}:repo", issue.id);
            if !dismissed_ids.contains(&id) {
                out.push(BacklogTriageSuggestion {
                    id,
                    issue_id: issue.id.clone(),
                    issue_number: issue.number,
                    issue_title: issue.title.clone(),
                    reason: format!("Backlog issue has no repository; workspace only has `{repo_name}`"),
                    summary: format!("Assign #{} to repo `{repo_name}`", issue.number),
                    source: ActorKind::System,
                    patch: TriagePatch {
                        repo: Some(repo_name.to_string()),
                        ..Default::default()
                    },
                    created_at: evaluated_at,
                });
            }
        }

        let ready_to_promote = blocked_issues(issue, issues).is_empty()
            && issue.repo.as_deref().is_some_and(|r| !r.trim().is_empty())
            && !issue.criteria.is_empty()
            && evaluated_at > 0
            && evaluated_at.saturating_sub(issue.created_at) >= STALE_BACKLOG_WINDOW_MS;
        if ready_to_promote {
            let id = format!("auto:{}:promote", issue.id);
            if !dismissed_ids.contains(&id) {
                out.push(BacklogTriageSuggestion {
                    id,
                    issue_id: issue.id.clone(),
                    issue_number: issue.number,
                    issue_title: issue.title.clone(),
                    reason: "Has repo + criteria, unblocked, and sitting in backlog > 3 days".to_string(),
                    summary: format!("Move #{} from Backlog to Todo", issue.number),
                    source: ActorKind::System,
                    patch: TriagePatch {
                        status: Some(IssueStatus::Todo),
                        ..Default::default()
                    },
                    created_at: evaluated_at,
                });
            }
        }
    }

    out
}

fn clip_digest_text(input: &str, max_chars: usize) -> String {
    let collapsed = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut iter = collapsed.chars();
    let collected: String = iter.by_ref().take(max_chars).collect();
    if iter.next().is_some() { format!("{collected}...") } else { collected }
}

/// Borrowed inputs for [`build_morning_digest`].
pub struct MorningDigestInput<'a> {
    pub repos: &'a [RepoHealthInput],
    pub issues: &'a [Issue],
    pub sessions: &'a [Session],
    pub runs: &'a [Run],
    pub window_start: Millis,
    pub window_end: Millis,
    pub custom_triage: &'a [BacklogTriageSuggestion],
    pub dismissed_ids: &'a HashSet<String>,
}

/// Builds the 3-part morning digest combining (1) overnight progress, (2) deterministic
/// repo health, and (3) confirmable backlog triage suggestions.
pub fn build_morning_digest(input: &MorningDigestInput<'_>) -> MorningDigest {
    let MorningDigestInput {
        repos,
        issues,
        sessions,
        runs,
        window_start,
        window_end,
        custom_triage,
        dismissed_ids,
    } = *input;
    let derived = if sessions.is_empty() {
        issues.to_vec()
    } else {
        derive_issues_local(issues, sessions)
    };
    let mut progress = DigestProgressSummary::default();

    let session_summary_for = |issue: &Issue| -> Option<&str> {
        let sid = issue.latest_session_id()?;
        sessions
            .iter()
            .find(|s| &s.id == sid)
            .and_then(|s| s.last_run.as_ref())
            .map(|r| r.summary.as_str())
            .filter(|s| !s.is_empty())
    };

    for issue in &derived {
        match issue.stage.state {
            IssueStageKind::Asking => progress.asking.push(DigestIssueRef {
                id: issue.id.clone(),
                number: issue.number,
                title: clip_digest_text(&issue.title, 40),
                detail: clip_digest_text(issue.questions.first().map_or("", |q| q.question.as_str()), 60),
                stuck: None,
            }),
            IssueStageKind::Reviewing if issue.parent.is_none() => progress.reviewing.push(DigestIssueRef {
                id: issue.id.clone(),
                number: issue.number,
                title: clip_digest_text(&issue.title, 40),
                detail: clip_digest_text(session_summary_for(issue).unwrap_or(""), 60),
                stuck: None,
            }),
            IssueStageKind::Stuck => {
                let detail = if issue.stage.stuck == Some(StuckReason::Conflict)
                    && let Some(c) = &issue.conflict
                {
                    c.files.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
                } else {
                    session_summary_for(issue)
                        .or_else(|| issue.questions.first().map(|q| q.question.as_str()))
                        .unwrap_or("")
                        .to_string()
                };
                progress.stuck.push(DigestIssueRef {
                    id: issue.id.clone(),
                    number: issue.number,
                    title: clip_digest_text(&issue.title, 40),
                    detail: clip_digest_text(&detail, 60),
                    stuck: issue.stage.stuck,
                });
            }
            IssueStageKind::Working if issue.status == IssueStatus::InProgress => progress.working.push(DigestIssueRef {
                id: issue.id.clone(),
                number: issue.number,
                title: clip_digest_text(&issue.title, 40),
                detail: String::new(),
                stuck: None,
            }),
            IssueStageKind::Done if issue.closed_at.is_some_and(|at| at >= window_start && at <= window_end) => {
                progress.completed_recent.push(DigestIssueRef {
                    id: issue.id.clone(),
                    number: issue.number,
                    title: clip_digest_text(&issue.title, 44),
                    detail: String::new(),
                    stuck: None,
                });
            }
            _ => {}
        }
    }

    let mut seen_runs = HashSet::new();
    for run in runs {
        let in_window =
            (run.started_at >= window_start && run.started_at <= window_end) || run.ended_at.is_some_and(|at| at >= window_start && at <= window_end);
        if !in_window || !seen_runs.insert(run.id.clone()) {
            continue;
        }
        progress.runs_total += 1;
        if let Some(spent) = &run.spent {
            progress.tokens_spent = progress.tokens_spent.saturating_add(spent.tokens);
        }
        match run.outcome {
            Some(Outcome::Completed) => progress.runs_completed += 1,
            Some(Outcome::Failed) => progress.runs_failed += 1,
            Some(Outcome::Interrupted) => progress.runs_interrupted += 1,
            None => {}
        }
    }

    if progress.runs_total == 0 {
        for issue in &derived {
            if let Some(lr) = &issue.last_run {
                let at = lr.ended_at.unwrap_or(lr.started_at);
                if at >= window_start && at <= window_end {
                    progress.runs_total += 1;
                    match lr.outcome {
                        Some(Outcome::Completed) => progress.runs_completed += 1,
                        Some(Outcome::Failed) => progress.runs_failed += 1,
                        Some(Outcome::Interrupted) => progress.runs_interrupted += 1,
                        None => {}
                    }
                }
            }
        }
    }

    let repo_health = assess_repos_health(repos, &derived, &[], window_end);
    let mut triage = suggest_backlog_triage(&derived, repos, window_end, dismissed_ids);
    for custom in custom_triage {
        if !dismissed_ids.contains(&custom.id)
            && !triage.iter().any(|t| t.id == custom.id)
            && derived.iter().any(|i| i.id == custom.issue_id && i.status == IssueStatus::Backlog)
        {
            triage.push(custom.clone());
        }
    }

    MorningDigest {
        generated_at: window_end,
        window_start,
        window_end,
        progress,
        repo_health,
        triage,
    }
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::{DeliveryEvidence, IssueStage, JsNumber, ProjectCheckReceipt};

    use super::*;

    fn sample_repo(name: &str, last_commit_at: Option<i64>) -> RepoHealthInput {
        RepoHealthInput {
            name: name.into(),
            last_commit_at,
        }
    }

    #[test]
    fn repo_health_rules_classify_on_track_at_risk_and_off_track() {
        let now = 20 * 24 * 60 * 60_000;
        let repo = sample_repo("alpha", Some(now - 60_000));

        // Active in_progress issue, no problems -> on_track.
        let mut active = Issue::new("i1", 1, "Ship endpoint", now - 10_000);
        active.repo = Some("alpha".into());
        active.status = IssueStatus::InProgress;
        let h = assess_repo_health(&repo, &[active.clone()], now);
        assert_eq!(h.status, RepoHealthStatus::OnTrack);
        assert_eq!(h.reasons, vec![RepoHealthReason::Healthy]);

        // Non-blocking relation alone must NEVER mark an issue blocked or off/at-risk.
        let mut related_target = Issue::new("i2", 2, "Companion doc", now - 10_000);
        related_target.repo = Some("alpha".into());
        related_target.status = IssueStatus::InProgress;
        related_target.relations = vec![IssueRelation {
            kind: IssueRelationKind::Related,
            issue: "i1".into(),
        }];
        let h_rel = assess_repo_health(&repo, &[active.clone(), related_target], now);
        assert_eq!(h_rel.blocked_issues, 0);
        assert_eq!(h_rel.status, RepoHealthStatus::OnTrack);

        // Waiting on user (Asking) -> at_risk.
        let mut asking = active.clone();
        asking.stage = IssueStage {
            state: IssueStageKind::Asking,
            since: Some(now - 5_000),
            stuck: None,
            lead: None,
            acts: vec![],
        };
        let h_ask = assess_repo_health(&repo, &[asking], now);
        assert_eq!(h_ask.status, RepoHealthStatus::AtRisk);
        assert!(h_ask.reasons.contains(&RepoHealthReason::AskingUser));

        // 1 overdue issue -> at_risk.
        let mut overdue = active.clone();
        overdue.due_at = Some(JsNumber::from(now - 1_000));
        let h_due1 = assess_repo_health(&repo, &[overdue.clone()], now);
        assert_eq!(h_due1.status, RepoHealthStatus::AtRisk);
        assert!(h_due1.reasons.contains(&RepoHealthReason::OverdueIssues));

        // Stuck issue -> off_track.
        let mut stuck = active.clone();
        stuck.stage = IssueStage {
            state: IssueStageKind::Stuck,
            since: Some(now - 1_000),
            stuck: Some(StuckReason::Conflict),
            lead: None,
            acts: vec![],
        };
        let h_stuck = assess_repo_health(&repo, &[stuck], now);
        assert_eq!(h_stuck.status, RepoHealthStatus::OffTrack);
        assert!(h_stuck.reasons.contains(&RepoHealthReason::StuckIssues));

        // Failed check -> off_track.
        let mut failed = active.clone();
        failed.delivery_evidence = Some(DeliveryEvidence {
            check: Some(ProjectCheckReceipt {
                target_branch: "main".into(),
                target_commit: "abc".into(),
                source_tree: "def".into(),
                candidate_commit: "ghi".into(),
                candidate_tree: "jkl".into(),
                status: ProjectCheckStatus::Failed,
                command: Some("cargo test".into()),
                output: Some("cargo test failed".into()),
            }),
            ..Default::default()
        });
        let h_failed = assess_repo_health(&repo, &[failed], now);
        assert_eq!(h_failed.status, RepoHealthStatus::OffTrack);
        assert!(h_failed.reasons.contains(&RepoHealthReason::FailedChecks));

        // 2+ overdue issues -> off_track.
        let mut overdue2 = overdue.clone();
        overdue2.id = "i3".into();
        overdue2.number = 3;
        let h_due2 = assess_repo_health(&repo, &[overdue, overdue2], now);
        assert_eq!(h_due2.status, RepoHealthStatus::OffTrack);
    }

    #[test]
    fn backlog_triage_suggests_without_mutating_issues_and_respects_dismiss() {
        let now = 10 * 24 * 60 * 60_000;
        let repos = vec![sample_repo("alpha", Some(now - 60_000))];

        let mut b1 = Issue::new("i1", 1, "Urgent fix oauth token refresh", now - 4 * 24 * 60 * 60_000);
        b1.repo = Some("alpha".into());
        b1.criteria = vec!["oauth passes".into()];

        let b2 = Issue::new("i2", 2, "Fix oauth token refresh", now - 1_000);

        let issues = vec![b1.clone(), b2.clone()];
        let mut dismissed = HashSet::new();
        let suggestions = suggest_backlog_triage(&issues, &repos, now, &dismissed);
        assert!(suggestions.iter().any(|s| s.issue_id == "i1" && s.patch.priority == Some(Priority::High)));
        assert!(suggestions.iter().any(|s| s.issue_id == "i1" && s.patch.status == Some(IssueStatus::Todo)));
        assert!(suggestions.iter().any(|s| s.issue_id == "i2" && s.patch.repo.as_deref() == Some("alpha")));
        assert!(suggestions.iter().any(|s| {
            s.patch
                .relations
                .as_ref()
                .is_some_and(|rels| rels.iter().any(|r| r.kind == IssueRelationKind::Duplicate))
        }));

        dismissed.insert("auto:i1:priority".into());
        let after_dismiss = suggest_backlog_triage(&issues, &repos, now, &dismissed);
        assert!(!after_dismiss.iter().any(|s| s.id == "auto:i1:priority"));
    }
}
