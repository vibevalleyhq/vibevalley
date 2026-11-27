//! Pure deterministic issue cycle-time and retro analytics computed from
//! persisted [`Issue`] fields (`createdAt`, `queuedAt`, `reviewedAt`, `closedAt`,
//! `startAt`, `dueAt`, `findings`, `tags`, `repo`, `assignments`).

use std::collections::{BTreeMap, BTreeSet};

use vibevalley_protocol::{
    DAY_MS, Issue, IssueRetroReport, IssueStatus, JsNumber, RetroBreakdownBucket, RetroDurationStats, RetroOverdueItem, RetroReworkItem, RetroWindow,
};

fn positive_ts(value: Option<JsNumber>) -> Option<i64> {
    value.and_then(|v| {
        let raw = v.get();
        (raw.is_finite() && raw > 0.0).then(|| raw.round() as i64)
    })
}

fn window_start_at(window: RetroWindow, now_ms: i64) -> Option<i64> {
    let days = match window {
        RetroWindow::Days7 => Some(7),
        RetroWindow::Days14 => Some(14),
        RetroWindow::Days30 => Some(30),
        RetroWindow::All => None,
    }?;
    Some(now_ms.saturating_sub(days * DAY_MS))
}

fn issue_activity_at(issue: &Issue, now_ms: i64) -> i64 {
    if issue.status.is_closed() {
        return issue.closed_at.or(issue.reviewed_at).or(issue.queued_at).unwrap_or(issue.created_at);
    }
    let mut latest = issue.created_at;
    for ts in [
        issue.queued_at,
        issue.reviewed_at,
        positive_ts(issue.start_at).filter(|&t| t <= now_ms),
        positive_ts(issue.due_at).filter(|&t| t <= now_ms),
    ]
    .into_iter()
    .flatten()
    {
        latest = latest.max(ts);
    }
    for finding in &issue.findings {
        latest = latest.max(finding.at);
    }
    for assignment in &issue.assignments {
        latest = latest.max(assignment.assigned_at);
    }
    latest
}

fn issue_repo_key(issue: &Issue) -> String {
    issue.repo.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("").to_string()
}

fn issue_agent_key(issue: &Issue) -> String {
    issue
        .assigned_agent()
        .or_else(|| issue.assignments.last().map(|a| a.agent.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

fn non_empty_opt(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

fn round1_pct(numerator: i64, denominator: i64) -> Option<JsNumber> {
    if denominator <= 0 {
        return None;
    }
    let pct = ((numerator as f64 * 1000.0) / denominator as f64).round() / 10.0;
    Some(JsNumber::from(pct))
}

/// Computes median and P90 (nearest-rank: `ceil(0.9 * n) - 1`) over non-negative duration samples.
fn duration_stats(samples: &mut [i64]) -> RetroDurationStats {
    if samples.is_empty() {
        return RetroDurationStats::default();
    }
    samples.sort_unstable();
    let n = samples.len();
    let median = if n % 2 == 1 {
        samples[n / 2]
    } else {
        ((samples[n / 2 - 1] as i128 + samples[n / 2] as i128) / 2) as i64
    };
    let p90_idx = ((0.9 * n as f64).ceil() as usize).saturating_sub(1).min(n - 1);
    RetroDurationStats {
        sample_count: n as i64,
        median_ms: Some(median),
        p90_ms: Some(samples[p90_idx]),
    }
}

#[derive(Default)]
struct BreakdownAccum {
    total_count: i64,
    completed_count: i64,
    canceled_count: i64,
    overdue_count: i64,
    rework_count: i64,
    cycle_samples: Vec<i64>,
}

impl BreakdownAccum {
    fn record(&mut self, status: IssueStatus, overdue: bool, rework: bool, cycle_ms: Option<i64>) {
        self.total_count += 1;
        match status {
            IssueStatus::Done => self.completed_count += 1,
            IssueStatus::Canceled => self.canceled_count += 1,
            _ => {}
        }
        if overdue {
            self.overdue_count += 1;
        }
        if rework {
            self.rework_count += 1;
        }
        if let Some(ms) = cycle_ms {
            self.cycle_samples.push(ms);
        }
    }

    fn into_bucket(mut self, key: String) -> RetroBreakdownBucket {
        let median_cycle_ms = duration_stats(&mut self.cycle_samples).median_ms;
        RetroBreakdownBucket {
            key,
            total_count: self.total_count,
            completed_count: self.completed_count,
            canceled_count: self.canceled_count,
            overdue_count: self.overdue_count,
            rework_count: self.rework_count,
            median_cycle_ms,
        }
    }
}

fn finalize_buckets(map: BTreeMap<String, BreakdownAccum>) -> Vec<RetroBreakdownBucket> {
    let mut buckets: Vec<RetroBreakdownBucket> = map.into_iter().map(|(k, acc)| acc.into_bucket(k)).collect();
    buckets.sort_by(|a, b| {
        b.total_count
            .cmp(&a.total_count)
            .then_with(|| b.completed_count.cmp(&a.completed_count))
            .then_with(|| a.key.is_empty().cmp(&b.key.is_empty()))
            .then_with(|| a.key.cmp(&b.key))
    });
    buckets
}

/// Computes deterministic issue cycle-time and retro analytics for `window` at `now_ms`.
pub fn issue_retro(issues: &[Issue], window: RetroWindow, now_ms: i64) -> IssueRetroReport {
    let window_start = window_start_at(window, now_ms);

    let mut total_issues = 0_i64;
    let mut open_count = 0_i64;
    let mut completed_count = 0_i64;
    let mut canceled_count = 0_i64;

    let mut cycle_samples = Vec::new();
    let mut review_wait_samples = Vec::new();

    let mut with_due_count = 0_i64;
    let mut without_due_count = 0_i64;
    let mut on_time_count = 0_i64;
    let mut overdue_count = 0_i64;
    let mut upcoming_due_count = 0_i64;

    let mut rework_issue_count = 0_i64;
    let mut total_findings_count = 0_i64;
    let mut unresolved_findings_count = 0_i64;

    let mut overdue_items = Vec::new();
    let mut rework_items = Vec::new();

    let mut by_repo: BTreeMap<String, BreakdownAccum> = BTreeMap::new();
    let mut by_tag: BTreeMap<String, BreakdownAccum> = BTreeMap::new();
    let mut by_agent: BTreeMap<String, BreakdownAccum> = BTreeMap::new();

    for issue in issues {
        if let Some(since) = window_start
            && issue_activity_at(issue, now_ms) < since
        {
            continue;
        }

        total_issues += 1;
        match issue.status {
            IssueStatus::Done => completed_count += 1,
            IssueStatus::Canceled => canceled_count += 1,
            _ => open_count += 1,
        }

        let cycle_ms = if issue.status == IssueStatus::Done {
            issue
                .closed_at
                .filter(|&closed| closed >= issue.created_at)
                .map(|closed| closed - issue.created_at)
        } else {
            None
        };
        if let Some(ms) = cycle_ms {
            cycle_samples.push(ms);
        }

        if let (Some(queued), Some(reviewed)) = (issue.queued_at, issue.reviewed_at)
            && reviewed >= queued
        {
            review_wait_samples.push(reviewed - queued);
        }

        let repo_key = issue_repo_key(issue);
        let agent_key = issue_agent_key(issue);

        let mut is_overdue = false;
        match positive_ts(issue.due_at) {
            None => {
                without_due_count += 1;
            }
            Some(due_at) => {
                with_due_count += 1;
                if issue.status == IssueStatus::Done {
                    let closed_or_done = issue.closed_at.or(issue.reviewed_at).unwrap_or(issue.created_at);
                    if closed_or_done <= due_at {
                        on_time_count += 1;
                    } else {
                        is_overdue = true;
                        overdue_count += 1;
                        overdue_items.push(RetroOverdueItem {
                            id: issue.id.clone(),
                            number: issue.number,
                            title: issue.title.clone(),
                            status: issue.status,
                            repo: non_empty_opt(&repo_key),
                            agent: non_empty_opt(&agent_key),
                            due_at,
                            closed_at: issue.closed_at,
                            overdue_ms: closed_or_done - due_at,
                        });
                    }
                } else if !issue.status.is_closed() {
                    if now_ms > due_at {
                        is_overdue = true;
                        overdue_count += 1;
                        overdue_items.push(RetroOverdueItem {
                            id: issue.id.clone(),
                            number: issue.number,
                            title: issue.title.clone(),
                            status: issue.status,
                            repo: non_empty_opt(&repo_key),
                            agent: non_empty_opt(&agent_key),
                            due_at,
                            closed_at: None,
                            overdue_ms: now_ms - due_at,
                        });
                    } else {
                        upcoming_due_count += 1;
                    }
                } else if let Some(closed) = issue.closed_at
                    && closed > due_at
                {
                    is_overdue = true;
                    overdue_count += 1;
                    overdue_items.push(RetroOverdueItem {
                        id: issue.id.clone(),
                        number: issue.number,
                        title: issue.title.clone(),
                        status: issue.status,
                        repo: non_empty_opt(&repo_key),
                        agent: non_empty_opt(&agent_key),
                        due_at,
                        closed_at: issue.closed_at,
                        overdue_ms: closed - due_at,
                    });
                }
            }
        }

        let findings_count = issue.findings.len() as i64;
        let unresolved_count = issue.findings.iter().filter(|f| !f.resolved).count() as i64;
        let has_rework = findings_count > 0;
        if has_rework {
            rework_issue_count += 1;
            total_findings_count += findings_count;
            unresolved_findings_count += unresolved_count;
            rework_items.push(RetroReworkItem {
                id: issue.id.clone(),
                number: issue.number,
                title: issue.title.clone(),
                status: issue.status,
                repo: non_empty_opt(&repo_key),
                agent: non_empty_opt(&agent_key),
                findings_count,
                unresolved_count,
            });
        }

        by_repo.entry(repo_key).or_default().record(issue.status, is_overdue, has_rework, cycle_ms);
        by_agent.entry(agent_key).or_default().record(issue.status, is_overdue, has_rework, cycle_ms);

        let tags: BTreeSet<String> = issue.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        if tags.is_empty() {
            by_tag.entry(String::new()).or_default().record(issue.status, is_overdue, has_rework, cycle_ms);
        } else {
            for tag in tags {
                by_tag.entry(tag).or_default().record(issue.status, is_overdue, has_rework, cycle_ms);
            }
        }
    }

    overdue_items.sort_by(|a, b| {
        b.overdue_ms
            .cmp(&a.overdue_ms)
            .then_with(|| a.due_at.cmp(&b.due_at))
            .then_with(|| a.number.cmp(&b.number))
            .then_with(|| a.id.cmp(&b.id))
    });
    rework_items.sort_by(|a, b| {
        b.findings_count
            .cmp(&a.findings_count)
            .then_with(|| b.unresolved_count.cmp(&a.unresolved_count))
            .then_with(|| b.number.cmp(&a.number))
            .then_with(|| a.id.cmp(&b.id))
    });

    IssueRetroReport {
        window,
        generated_at: now_ms,
        window_start_at: window_start,
        total_issues,
        open_count,
        completed_count,
        canceled_count,
        completion_rate_pct: round1_pct(completed_count, completed_count + canceled_count),
        cycle_time: duration_stats(&mut cycle_samples),
        review_wait: duration_stats(&mut review_wait_samples),
        with_due_count,
        without_due_count,
        on_time_count,
        overdue_count,
        upcoming_due_count,
        on_time_rate_pct: round1_pct(on_time_count, on_time_count + overdue_count),
        overdue_rate_pct: round1_pct(overdue_count, on_time_count + overdue_count),
        rework_issue_count,
        total_findings_count,
        unresolved_findings_count,
        rework_rate_pct: round1_pct(rework_issue_count, total_issues),
        overdue_items,
        rework_items,
        by_repo: finalize_buckets(by_repo),
        by_tag: finalize_buckets(by_tag),
        by_agent: finalize_buckets(by_agent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_protocol::{Assignment, Finding, IssueCanceled, Landing};

    const HOUR_MS: i64 = 3_600_000;
    const NOW: i64 = 1_800_000_000_000;

    fn make_issue(id: &str, number: i64, status: IssueStatus, created_at: i64) -> Issue {
        let mut issue = Issue::new(id, number, format!("Issue {number}"), created_at);
        issue.status = status;
        issue
    }

    fn assign(issue: &mut Issue, agent: &str, at: i64, ended_at: Option<i64>) {
        issue.assignments.push(Assignment {
            id: format!("a-{agent}-{at}"),
            issue: issue.id.clone(),
            agent: agent.to_string(),
            assigned_at: at,
            ended_at,
            executions: vec![],
        });
    }

    #[test]
    fn empty_board_and_empty_window_produce_zeroed_report() {
        let empty = issue_retro(&[], RetroWindow::Days7, NOW);
        assert_eq!(empty.total_issues, 0);
        assert_eq!(empty.completed_count, 0);
        assert_eq!(empty.canceled_count, 0);
        assert_eq!(empty.completion_rate_pct, None);
        assert_eq!(empty.cycle_time, RetroDurationStats::default());
        assert_eq!(empty.review_wait, RetroDurationStats::default());
        assert_eq!(empty.on_time_rate_pct, None);
        assert_eq!(empty.overdue_rate_pct, None);
        assert_eq!(empty.rework_rate_pct, None);
        assert!(empty.overdue_items.is_empty());
        assert!(empty.rework_items.is_empty());
        assert!(empty.by_repo.is_empty());
        assert!(empty.by_tag.is_empty());
        assert!(empty.by_agent.is_empty());

        // Old issues (> 7d) are excluded from the 7d window but included in 30d / all.
        let mut old_done = make_issue("old-1", 1, IssueStatus::Done, NOW - 20 * DAY_MS);
        old_done.closed_at = Some(NOW - 18 * DAY_MS);
        old_done.delivered = Some(Landing::Merged);
        old_done.due_at = Some(JsNumber::from(NOW - 19 * DAY_MS));

        let mut old_open = make_issue("old-2", 2, IssueStatus::InProgress, NOW - 15 * DAY_MS);
        old_open.due_at = Some(JsNumber::from(NOW - 10 * DAY_MS));

        let issues = vec![old_done, old_open];
        let w7 = issue_retro(&issues, RetroWindow::Days7, NOW);
        assert_eq!(w7.total_issues, 0);
        assert!(w7.overdue_items.is_empty());

        let w30 = issue_retro(&issues, RetroWindow::Days30, NOW);
        assert_eq!(w30.total_issues, 2);
        assert_eq!(w30.completed_count, 1);
        assert_eq!(w30.overdue_count, 2);
    }

    #[test]
    fn median_and_p90_stage_durations_handle_edge_cases() {
        // 1 sample -> median = p90 = sample
        let mut one = make_issue("i1", 1, IssueStatus::Done, NOW - 10 * HOUR_MS);
        one.queued_at = Some(NOW - 9 * HOUR_MS);
        one.reviewed_at = Some(NOW - 7 * HOUR_MS);
        one.closed_at = Some(NOW - 5 * HOUR_MS);
        let r1 = issue_retro(&[one], RetroWindow::Days7, NOW);
        assert_eq!(r1.cycle_time.sample_count, 1);
        assert_eq!(r1.cycle_time.median_ms, Some(5 * HOUR_MS));
        assert_eq!(r1.cycle_time.p90_ms, Some(5 * HOUR_MS));
        assert_eq!(r1.review_wait.sample_count, 1);
        assert_eq!(r1.review_wait.median_ms, Some(2 * HOUR_MS));
        assert_eq!(r1.review_wait.p90_ms, Some(2 * HOUR_MS));

        // 2 samples -> even median average, p90 = max
        let mut a = make_issue("a", 1, IssueStatus::Done, NOW - 10 * HOUR_MS);
        a.closed_at = Some(NOW - 8 * HOUR_MS); // 2h
        let mut b = make_issue("b", 2, IssueStatus::Done, NOW - 10 * HOUR_MS);
        b.closed_at = Some(NOW - 4 * HOUR_MS); // 6h
        let r2 = issue_retro(&[a, b], RetroWindow::Days7, NOW);
        assert_eq!(r2.cycle_time.median_ms, Some(4 * HOUR_MS));
        assert_eq!(r2.cycle_time.p90_ms, Some(6 * HOUR_MS));

        // 10 samples [1h..=10h] -> median = avg(5h, 6h) = 5.5h, p90 = 9h (index 8)
        let ten: Vec<Issue> = (1..=10)
            .map(|k| {
                let mut item = make_issue(&format!("t-{k}"), k, IssueStatus::Done, NOW - 20 * HOUR_MS);
                item.closed_at = Some(NOW - (20 - k) * HOUR_MS);
                item
            })
            .collect();
        let r10 = issue_retro(&ten, RetroWindow::Days7, NOW);
        assert_eq!(r10.cycle_time.sample_count, 10);
        assert_eq!(r10.cycle_time.median_ms, Some(5 * HOUR_MS + HOUR_MS / 2));
        assert_eq!(r10.cycle_time.p90_ms, Some(9 * HOUR_MS));

        // Anomalous negative duration (closed_at < created_at) and canceled issue are excluded from cycle_time.
        let mut bad = make_issue("bad", 11, IssueStatus::Done, NOW - HOUR_MS);
        bad.closed_at = Some(NOW - 2 * HOUR_MS);
        let mut canceled = make_issue("can", 12, IssueStatus::Canceled, NOW - 5 * HOUR_MS);
        canceled.closed_at = Some(NOW - HOUR_MS);
        canceled.canceled = Some(IssueCanceled::Dismissed);
        let r_anom = issue_retro(&[bad, canceled], RetroWindow::Days7, NOW);
        assert_eq!(r_anom.completed_count, 1);
        assert_eq!(r_anom.canceled_count, 1);
        assert_eq!(r_anom.cycle_time.sample_count, 0);
        assert_eq!(r_anom.cycle_time.median_ms, None);
    }

    #[test]
    fn missing_due_at_fallback_and_overdue_classification() {
        // All issues lack dueAt (or non-positive cleared timestamp): rates stay None, counts stay accurate.
        let mut no_due = make_issue("n1", 1, IssueStatus::Done, NOW - 5 * HOUR_MS);
        no_due.closed_at = Some(NOW - HOUR_MS);
        let mut cleared_due = make_issue("n2", 2, IssueStatus::Todo, NOW - 2 * HOUR_MS);
        cleared_due.due_at = Some(JsNumber::from(0_i64));
        let r_missing = issue_retro(&[no_due.clone(), cleared_due], RetroWindow::Days7, NOW);
        assert_eq!(r_missing.with_due_count, 0);
        assert_eq!(r_missing.without_due_count, 2);
        assert_eq!(r_missing.on_time_count, 0);
        assert_eq!(r_missing.overdue_count, 0);
        assert_eq!(r_missing.on_time_rate_pct, None);
        assert_eq!(r_missing.overdue_rate_pct, None);
        assert!(r_missing.overdue_items.is_empty());

        // Mix of on-time done, late done, active overdue, and upcoming open.
        let mut on_time = make_issue("d1", 10, IssueStatus::Done, NOW - 4 * DAY_MS);
        on_time.due_at = Some(JsNumber::from(NOW - DAY_MS));
        on_time.closed_at = Some(NOW - 2 * DAY_MS);

        let mut late_done = make_issue("d2", 11, IssueStatus::Done, NOW - 5 * DAY_MS);
        late_done.due_at = Some(JsNumber::from(NOW - 3 * DAY_MS));
        late_done.closed_at = Some(NOW - DAY_MS); // 2d overdue

        let mut open_overdue = make_issue("d3", 12, IssueStatus::InProgress, NOW - 6 * DAY_MS);
        open_overdue.due_at = Some(JsNumber::from(NOW - 3 * DAY_MS)); // 3d overdue

        let mut upcoming = make_issue("d4", 13, IssueStatus::Todo, NOW - DAY_MS);
        upcoming.due_at = Some(JsNumber::from(NOW + 2 * DAY_MS));

        let r_mix = issue_retro(&[no_due, on_time, late_done, open_overdue, upcoming], RetroWindow::Days7, NOW);
        assert_eq!(r_mix.with_due_count, 4);
        assert_eq!(r_mix.without_due_count, 1);
        assert_eq!(r_mix.on_time_count, 1);
        assert_eq!(r_mix.overdue_count, 2);
        assert_eq!(r_mix.upcoming_due_count, 1);
        assert_eq!(r_mix.on_time_rate_pct, Some(JsNumber::from(33.3)));
        assert_eq!(r_mix.overdue_rate_pct, Some(JsNumber::from(66.7)));
        assert_eq!(r_mix.overdue_items.len(), 2);
        assert_eq!(r_mix.overdue_items[0].id, "d3");
        assert_eq!(r_mix.overdue_items[0].overdue_ms, 3 * DAY_MS);
        assert_eq!(r_mix.overdue_items[1].id, "d2");
        assert_eq!(r_mix.overdue_items[1].overdue_ms, 2 * DAY_MS);
    }

    #[test]
    fn rework_counts_and_repo_tag_agent_breakdowns() {
        let mut i1 = make_issue("i1", 1, IssueStatus::Done, NOW - 3 * DAY_MS);
        i1.repo = Some("api".into());
        i1.tags = vec!["bug".into(), "auth".into(), "bug".into()];
        i1.closed_at = Some(NOW - 2 * DAY_MS);
        assign(&mut i1, "laozhou", NOW - 3 * DAY_MS, None);
        i1.findings = vec![
            Finding {
                id: "f1".into(),
                text: "missing test".into(),
                at: NOW - 2 * DAY_MS - HOUR_MS,
                resolved: true,
            },
            Finding {
                id: "f2".into(),
                text: "edge case".into(),
                at: NOW - 2 * DAY_MS,
                resolved: false,
            },
        ];

        let mut i2 = make_issue("i2", 2, IssueStatus::Done, NOW - 2 * DAY_MS);
        i2.repo = Some("api".into());
        i2.tags = vec!["auth".into()];
        i2.closed_at = Some(NOW - DAY_MS);
        // Ended assignment falls back cleanly when no open assignment remains.
        assign(&mut i2, "xiaolin", NOW - 2 * DAY_MS, Some(NOW - DAY_MS));

        let mut i3 = make_issue("i3", 3, IssueStatus::Canceled, NOW - DAY_MS);
        i3.closed_at = Some(NOW - HOUR_MS);
        i3.canceled = Some(IssueCanceled::Lost);
        i3.findings = vec![Finding {
            id: "f3".into(),
            text: "duplicate".into(),
            at: NOW - 2 * HOUR_MS,
            resolved: false,
        }];

        let report = issue_retro(&[i1, i2, i3], RetroWindow::Days14, NOW);
        assert_eq!(report.total_issues, 3);
        assert_eq!(report.completed_count, 2);
        assert_eq!(report.canceled_count, 1);
        assert_eq!(report.completion_rate_pct, Some(JsNumber::from(66.7)));
        assert_eq!(report.rework_issue_count, 2);
        assert_eq!(report.total_findings_count, 3);
        assert_eq!(report.unresolved_findings_count, 2);
        assert_eq!(report.rework_rate_pct, Some(JsNumber::from(66.7)));

        assert_eq!(report.rework_items.len(), 2);
        assert_eq!(report.rework_items[0].id, "i1");
        assert_eq!(report.rework_items[0].findings_count, 2);
        assert_eq!(report.rework_items[0].unresolved_count, 1);
        assert_eq!(report.rework_items[1].id, "i3");

        // Repo breakdown: "api" (2 issues, 2 completed, 1 rework, 1d median cycle), "" (1 canceled)
        assert_eq!(report.by_repo.len(), 2);
        assert_eq!(report.by_repo[0].key, "api");
        assert_eq!(report.by_repo[0].total_count, 2);
        assert_eq!(report.by_repo[0].completed_count, 2);
        assert_eq!(report.by_repo[0].rework_count, 1);
        assert_eq!(report.by_repo[0].median_cycle_ms, Some(DAY_MS));
        assert_eq!(report.by_repo[1].key, "");
        assert_eq!(report.by_repo[1].canceled_count, 1);

        // Tag breakdown: duplicate "bug" on i1 counted once -> auth=2, bug=1, ""=1
        assert_eq!(report.by_tag[0].key, "auth");
        assert_eq!(report.by_tag[0].total_count, 2);
        assert_eq!(report.by_tag[1].key, "bug");
        assert_eq!(report.by_tag[1].total_count, 1);
        assert_eq!(report.by_tag[2].key, "");
        assert_eq!(report.by_tag[2].total_count, 1);

        // Agent breakdown: laozhou, xiaolin, unassigned ("")
        assert_eq!(report.by_agent.len(), 3);
        assert_eq!(report.by_agent[0].key, "laozhou");
        assert_eq!(report.by_agent[1].key, "xiaolin");
        assert_eq!(report.by_agent[2].key, "");
    }
}
