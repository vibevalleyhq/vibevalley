//! Scheduled cron `[digest...]` directive parsing/formatting and progress summary
//! builder/formatter delivered to connectors via [`super::ConnectorWorkflow`].

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use vibevalley_i18n::locale as current_locale;
use vibevalley_i18n::t_in;
use vibevalley_protocol::{
    BacklogTriageSuggestion, ConnectorID, Issue, IssueStageKind, IssueStatus, Millis, MorningDigest, Outcome, RepoHealth, RepoHealthStatus, Run, Session,
    StuckReason,
};

use crate::context::text::clip_plain;

/// Where a scheduled digest cron delivers its summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum DigestTargets {
    /// Configured default targets (linked WeChat when connected).
    #[default]
    Default,
    /// Explicit connector list (e.g. `Weixin`, `Feishu`).
    Connectors(Vec<ConnectorID>),
    /// Every currently connected and paired connector.
    AllConnected,
}

/// Parsed configuration of a scheduled digest cron job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DigestSpec {
    pub targets: DigestTargets,
    pub skip_if_empty: bool,
}

/// Formats a canonical `[digest...]` directive prefix stored inside `Cron.text`.
pub fn format_digest_directive(spec: &DigestSpec, note: &str) -> String {
    let mut tags: Vec<String> = match &spec.targets {
        DigestTargets::Default => Vec::new(),
        DigestTargets::AllConnected => vec!["all".into()],
        DigestTargets::Connectors(ids) => ids.iter().map(|id| id.as_str().to_string()).collect(),
    };
    if spec.skip_if_empty {
        tags.push("skip-empty".into());
    }
    let header = if tags.is_empty() {
        "[digest]".to_string()
    } else {
        format!("[digest:{}]", tags.join(","))
    };
    let trimmed = note.trim();
    if trimmed.is_empty() { header } else { format!("{header} {trimmed}") }
}

/// Recognizes `[digest]`, `[digest:weixin]`, `[digest:all]`, `[简报]`, `[日报]` prefixes in `cron.text`.
pub fn parse_digest_directive(text: &str) -> Option<DigestSpec> {
    let trimmed = text.trim_start();
    let rest = trimmed.strip_prefix('[').and_then(|s| s.split_once(']').map(|(inner, _)| inner.trim()))?;
    let (head, tail) = match rest.split_once(':') {
        Some((h, t)) => (h.trim(), Some(t)),
        None => (rest, None),
    };
    let head_lower = head.to_ascii_lowercase();
    if !matches!(head_lower.as_str(), "digest" | "简报" | "日报" | "早报") {
        return None;
    }
    let mut connectors = Vec::new();
    let mut all = false;
    let mut skip_if_empty = false;
    if let Some(params) = tail {
        for raw in params.split([',', '|', ' ']).map(str::trim).filter(|p| !p.is_empty()) {
            match raw.to_ascii_lowercase().as_str() {
                "all" | "全部" => all = true,
                "skip-empty" | "quiet" | "skip_empty" => skip_if_empty = true,
                "weixin" | "wechat" | "微信" => {
                    if !connectors.contains(&ConnectorID::Weixin) {
                        connectors.push(ConnectorID::Weixin);
                    }
                }
                "feishu" | "lark" | "飞书" => {
                    if !connectors.contains(&ConnectorID::Feishu) {
                        connectors.push(ConnectorID::Feishu);
                    }
                }
                "qq" if !connectors.contains(&ConnectorID::Qq) => {
                    connectors.push(ConnectorID::Qq);
                }
                _ => {}
            }
        }
    }
    let targets = if all {
        DigestTargets::AllConnected
    } else if connectors.is_empty() {
        DigestTargets::Default
    } else {
        DigestTargets::Connectors(connectors)
    };
    Some(DigestSpec { targets, skip_if_empty })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestIssueItem {
    pub number: i64,
    pub title: String,
    pub detail: String,
    pub stuck: Option<StuckReason>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DigestRunStats {
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub interrupted: usize,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProgressDigest {
    pub title: String,
    pub window_start: Millis,
    pub window_end: Millis,
    pub asking: Vec<DigestIssueItem>,
    pub reviewing: Vec<DigestIssueItem>,
    pub stuck: Vec<DigestIssueItem>,
    pub working: Vec<DigestIssueItem>,
    pub completed_recent: Vec<DigestIssueItem>,
    pub runs: DigestRunStats,
    pub repo_health: Vec<RepoHealth>,
    pub triage: Vec<BacklogTriageSuggestion>,
}

impl ProgressDigest {
    pub fn is_empty(&self) -> bool {
        let has_risky_repo = self.repo_health.iter().any(|r| r.status != RepoHealthStatus::OnTrack);
        self.asking.is_empty()
            && self.reviewing.is_empty()
            && self.stuck.is_empty()
            && self.working.is_empty()
            && self.completed_recent.is_empty()
            && self.runs.total == 0
            && !has_risky_repo
            && self.triage.is_empty()
    }
}

/// Converts a [`MorningDigest`] into a renderable [`ProgressDigest`] with all three sections.
pub fn progress_digest_from_morning(title: &str, morning: &MorningDigest) -> ProgressDigest {
    let map_items = |items: &[vibevalley_protocol::DigestIssueRef]| -> Vec<DigestIssueItem> {
        items
            .iter()
            .map(|r| DigestIssueItem {
                number: r.number,
                title: r.title.clone(),
                detail: r.detail.clone(),
                stuck: r.stuck,
            })
            .collect()
    };
    ProgressDigest {
        title: title.to_string(),
        window_start: morning.window_start,
        window_end: morning.window_end,
        asking: map_items(&morning.progress.asking),
        reviewing: map_items(&morning.progress.reviewing),
        stuck: map_items(&morning.progress.stuck),
        working: map_items(&morning.progress.working),
        completed_recent: map_items(&morning.progress.completed_recent),
        runs: DigestRunStats {
            total: morning.progress.runs_total as usize,
            completed: morning.progress.runs_completed as usize,
            failed: morning.progress.runs_failed as usize,
            interrupted: morning.progress.runs_interrupted as usize,
            total_tokens: morning.progress.tokens_spent,
        },
        repo_health: morning.repo_health.clone(),
        triage: morning.triage.clone(),
    }
}

/// Summarizes recent Issues and Runs progress over `[window_start, window_end]`.
pub fn build_progress_digest(title: &str, issues: &[Issue], sessions: &[Session], runs: &[Run], window_start: Millis, window_end: Millis) -> ProgressDigest {
    let mut asking = Vec::new();
    let mut reviewing = Vec::new();
    let mut stuck = Vec::new();
    let mut working = Vec::new();
    let mut completed_recent = Vec::new();

    let session_summary_for = |issue: &Issue| -> Option<&str> {
        let sid = issue.latest_session_id()?;
        sessions
            .iter()
            .find(|s| &s.id == sid)
            .and_then(|s| s.last_run.as_ref())
            .map(|r| r.summary.as_str())
            .filter(|s| !s.is_empty())
    };

    for issue in issues {
        match issue.stage.state {
            IssueStageKind::Asking => asking.push(DigestIssueItem {
                number: issue.number,
                title: clip_plain(&issue.title, 40),
                detail: clip_plain(issue.questions.first().map_or("", |q| q.question.as_str()), 60),
                stuck: None,
            }),
            IssueStageKind::Reviewing if issue.parent.is_none() => reviewing.push(DigestIssueItem {
                number: issue.number,
                title: clip_plain(&issue.title, 40),
                detail: clip_plain(session_summary_for(issue).unwrap_or(""), 60),
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
                stuck.push(DigestIssueItem {
                    number: issue.number,
                    title: clip_plain(&issue.title, 40),
                    detail: clip_plain(&detail, 60),
                    stuck: issue.stage.stuck,
                });
            }
            IssueStageKind::Working if issue.status == IssueStatus::InProgress => working.push(DigestIssueItem {
                number: issue.number,
                title: clip_plain(&issue.title, 40),
                detail: String::new(),
                stuck: None,
            }),
            IssueStageKind::Done if issue.closed_at.is_some_and(|at| at >= window_start && at <= window_end) => {
                completed_recent.push(DigestIssueItem {
                    number: issue.number,
                    title: clip_plain(&issue.title, 44),
                    detail: String::new(),
                    stuck: None,
                });
            }
            _ => {}
        }
    }

    let mut stats = DigestRunStats::default();
    let mut seen_runs = HashSet::new();
    for run in runs {
        let in_window =
            (run.started_at >= window_start && run.started_at <= window_end) || run.ended_at.is_some_and(|at| at >= window_start && at <= window_end);
        if !in_window || !seen_runs.insert(run.id.clone()) {
            continue;
        }
        stats.total += 1;
        if let Some(spent) = &run.spent {
            stats.total_tokens = stats.total_tokens.saturating_add(spent.tokens);
        }
        match run.outcome {
            Some(Outcome::Completed) => stats.completed += 1,
            Some(Outcome::Failed) => stats.failed += 1,
            Some(Outcome::Interrupted) => stats.interrupted += 1,
            None => {}
        }
    }

    // Fallback when only `Issue.last_run` is present (e.g. unit snapshots without `Run` rows).
    if stats.total == 0 {
        for issue in issues {
            if let Some(lr) = &issue.last_run {
                let at = lr.ended_at.unwrap_or(lr.started_at);
                if at >= window_start && at <= window_end {
                    stats.total += 1;
                    match lr.outcome {
                        Some(Outcome::Completed) => stats.completed += 1,
                        Some(Outcome::Failed) => stats.failed += 1,
                        Some(Outcome::Interrupted) => stats.interrupted += 1,
                        None => {}
                    }
                }
            }
        }
    }

    ProgressDigest {
        title: title.to_string(),
        window_start,
        window_end,
        asking,
        reviewing,
        stuck,
        working,
        completed_recent,
        runs: stats,
        repo_health: Vec::new(),
        triage: Vec::new(),
    }
}

const MAX_DIGEST_SECTION_ITEMS: usize = 5;

fn push_capped_lines(locale: &str, out: &mut Vec<String>, items: Vec<String>) {
    let total = items.len();
    for line in items.into_iter().take(MAX_DIGEST_SECTION_ITEMS) {
        out.push(line);
    }
    if total > MAX_DIGEST_SECTION_ITEMS {
        out.push(t_in(
            locale,
            "server.connector.cronDigest.more",
            &[("n", ((total - MAX_DIGEST_SECTION_ITEMS) as i64).into())],
        ));
    }
}

/// Formats a [`ProgressDigest`] into concise i18n plain text for WeChat / connectors.
pub fn format_progress_digest(digest: &ProgressDigest) -> String {
    format_progress_digest_in(&current_locale(), digest)
}

/// Formats a [`ProgressDigest`] in an explicit `locale` without mutating process-wide i18n state.
pub fn format_progress_digest_in(locale: &str, digest: &ProgressDigest) -> String {
    let mut lines = vec![t_in(locale, "server.connector.cronDigest.title", &[("title", digest.title.clone().into())])];
    if digest.is_empty() && digest.repo_health.is_empty() && digest.triage.is_empty() {
        lines.push(t_in(locale, "server.connector.cronDigest.quiet", &[]));
        return lines.join("\n");
    }
    if digest.asking.is_empty()
        && digest.reviewing.is_empty()
        && digest.stuck.is_empty()
        && digest.working.is_empty()
        && digest.completed_recent.is_empty()
        && digest.runs.total == 0
    {
        lines.push(t_in(locale, "server.connector.cronDigest.quiet", &[]));
    } else {
        lines.push(t_in(
            locale,
            "server.connector.cronDigest.counts",
            &[
                ("asking", (digest.asking.len() as i64).into()),
                ("reviewing", (digest.reviewing.len() as i64).into()),
                ("stuck", (digest.stuck.len() as i64).into()),
                ("working", (digest.working.len() as i64).into()),
                ("done", (digest.completed_recent.len() as i64).into()),
            ],
        ));
    }
    if digest.runs.total > 0 {
        lines.push(t_in(
            locale,
            "server.connector.cronDigest.runs",
            &[
                ("completed", (digest.runs.completed as i64).into()),
                ("failed", (digest.runs.failed as i64).into()),
                ("interrupted", (digest.runs.interrupted as i64).into()),
            ],
        ));
    }

    let mut attention = Vec::new();
    for item in &digest.asking {
        attention.push(t_in(
            locale,
            "server.connector.cronDigest.itemAsk",
            &[
                ("number", item.number.into()),
                ("title", item.title.clone().into()),
                ("detail", item.detail.clone().into()),
            ],
        ));
    }
    for item in &digest.stuck {
        let key = match item.stuck {
            Some(StuckReason::Conflict) => "server.connector.cronDigest.itemConflict",
            Some(StuckReason::Interrupted) => "server.connector.cronDigest.itemInterrupted",
            _ => "server.connector.cronDigest.itemFailed",
        };
        attention.push(t_in(
            locale,
            key,
            &[
                ("number", item.number.into()),
                ("title", item.title.clone().into()),
                ("detail", item.detail.clone().into()),
            ],
        ));
    }
    for item in &digest.reviewing {
        attention.push(t_in(
            locale,
            "server.connector.cronDigest.itemReview",
            &[
                ("number", item.number.into()),
                ("title", item.title.clone().into()),
                ("detail", item.detail.clone().into()),
            ],
        ));
    }
    if !attention.is_empty() {
        lines.push(String::new());
        lines.push(t_in(locale, "server.connector.cronDigest.attentionHeader", &[]));
        push_capped_lines(locale, &mut lines, attention);
    }

    if !digest.working.is_empty() {
        lines.push(String::new());
        lines.push(t_in(locale, "server.connector.cronDigest.workingHeader", &[]));
        let working_lines = digest
            .working
            .iter()
            .map(|item| {
                t_in(
                    locale,
                    "server.connector.cronDigest.itemWorking",
                    &[("number", item.number.into()), ("title", item.title.clone().into())],
                )
            })
            .collect();
        push_capped_lines(locale, &mut lines, working_lines);
    }

    if !digest.completed_recent.is_empty() {
        lines.push(String::new());
        lines.push(t_in(locale, "server.connector.cronDigest.completedHeader", &[]));
        let done_lines = digest
            .completed_recent
            .iter()
            .map(|item| {
                t_in(
                    locale,
                    "server.connector.cronDigest.itemDone",
                    &[("number", item.number.into()), ("title", item.title.clone().into())],
                )
            })
            .collect();
        push_capped_lines(locale, &mut lines, done_lines);
    }

    if !digest.repo_health.is_empty() {
        lines.push(String::new());
        lines.push(t_in(locale, "server.connector.cronDigest.healthHeader", &[]));
        let health_lines = digest
            .repo_health
            .iter()
            .map(|h| {
                let status_key = match h.status {
                    RepoHealthStatus::OnTrack => "shared.repoHealth.on_track",
                    RepoHealthStatus::AtRisk => "shared.repoHealth.at_risk",
                    RepoHealthStatus::OffTrack => "shared.repoHealth.off_track",
                };
                let status_label = t_in(locale, status_key, &[]);
                t_in(
                    locale,
                    "server.connector.cronDigest.itemHealth",
                    &[
                        ("repo", h.repo.clone().into()),
                        ("status", status_label.into()),
                        ("open", h.open_issues.into()),
                        ("blocked", h.blocked_issues.into()),
                        ("stuck", h.stuck_issues.into()),
                    ],
                )
            })
            .collect();
        push_capped_lines(locale, &mut lines, health_lines);
    }

    if !digest.triage.is_empty() {
        lines.push(String::new());
        lines.push(t_in(locale, "server.connector.cronDigest.triageHeader", &[]));
        let triage_lines = digest
            .triage
            .iter()
            .map(|s| {
                t_in(
                    locale,
                    "server.connector.cronDigest.itemTriage",
                    &[("number", s.issue_number.into()), ("summary", clip_plain(&s.summary, 60).into())],
                )
            })
            .collect();
        push_capped_lines(locale, &mut lines, triage_lines);
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::{RunTrigger, RunTriggerKind, Spent};

    use super::*;

    #[test]
    fn digest_directives_and_progress_summary_format_cleanly() {
        assert_eq!(parse_digest_directive("写早报"), None);
        assert_eq!(
            parse_digest_directive("[digest] daily"),
            Some(DigestSpec {
                targets: DigestTargets::Default,
                skip_if_empty: false,
            })
        );
        assert_eq!(
            parse_digest_directive("[简报:weixin,skip-empty]"),
            Some(DigestSpec {
                targets: DigestTargets::Connectors(vec![ConnectorID::Weixin]),
                skip_if_empty: true,
            })
        );
        assert_eq!(
            parse_digest_directive("[digest:all]"),
            Some(DigestSpec {
                targets: DigestTargets::AllConnected,
                skip_if_empty: false,
            })
        );
        let roundtrip = format_digest_directive(
            &DigestSpec {
                targets: DigestTargets::Connectors(vec![ConnectorID::Weixin, ConnectorID::Feishu]),
                skip_if_empty: true,
            },
            "每日播报",
        );
        assert_eq!(roundtrip, "[digest:weixin,feishu,skip-empty] 每日播报");
        assert_eq!(
            parse_digest_directive(&roundtrip),
            Some(DigestSpec {
                targets: DigestTargets::Connectors(vec![ConnectorID::Weixin, ConnectorID::Feishu]),
                skip_if_empty: true,
            })
        );

        let empty = build_progress_digest("日报", &[], &[], &[], 1_000, 2_000);
        assert!(empty.is_empty());
        assert!(format_progress_digest_in("zh", &empty).contains("近期暂无新增进度"));

        let mut i1 = Issue::new("i1", 1, "修复登录", 1_000);
        i1.stage.state = IssueStageKind::Asking;
        i1.questions.push(vibevalley_protocol::Question {
            question: "用 OAuth 吗？".into(),
            options: vec![],
        });

        let mut i2 = Issue::new("i2", 2, "微信通知", 1_000);
        i2.status = IssueStatus::Done;
        i2.stage.state = IssueStageKind::Done;
        i2.closed_at = Some(1_500);

        let mut i3 = Issue::new("i3", 3, "旧工单", 500);
        i3.status = IssueStatus::Done;
        i3.stage.state = IssueStageKind::Done;
        i3.closed_at = Some(800);

        let trigger = || RunTrigger {
            kind: RunTriggerKind::Issue,
            message: None,
            channel: None,
            cron: None,
            missed: None,
        };
        let runs = vec![
            Run {
                needs_reconciliation: false,
                id: "r1".into(),
                issue: Some("i2".into()),
                session: "s1".into(),
                subagents: None,
                triggered_by: trigger(),
                heard: vec![],
                started_at: 1_100,
                ended_at: Some(1_400),
                outcome: Some(Outcome::Completed),
                summary: "ok".into(),
                spent: Some(Spent { tokens: 120, cny: None }),
            },
            Run {
                needs_reconciliation: false,
                id: "r2".into(),
                issue: Some("i1".into()),
                session: "s2".into(),
                subagents: None,
                triggered_by: trigger(),
                heard: vec![],
                started_at: 1_200,
                ended_at: Some(1_300),
                outcome: Some(Outcome::Failed),
                summary: "err".into(),
                spent: None,
            },
        ];

        let summary = build_progress_digest("每日进展", &[i1, i2, i3], &[], &runs, 1_000, 2_000);
        assert_eq!(summary.asking.len(), 1);
        assert_eq!(summary.completed_recent.len(), 1);
        assert_eq!(
            (summary.runs.total, summary.runs.completed, summary.runs.failed, summary.runs.total_tokens),
            (2, 1, 1, 120)
        );
        let rendered = format_progress_digest_in("zh", &summary);
        assert!(rendered.contains("【进展简报 · 每日进展】"));
        assert!(rendered.contains("待回复 1"));
        assert!(rendered.contains("近期完成 1"));
        assert!(rendered.contains("完成 1 · 失败 1"));
        assert!(rendered.contains("#1 修复登录"));
        assert!(rendered.contains("#2 微信通知"));
        assert!(!rendered.contains("#3 旧工单"));

        let morning = vibevalley_protocol::MorningDigest {
            generated_at: 2_000,
            window_start: 1_000,
            window_end: 2_000,
            progress: vibevalley_protocol::DigestProgressSummary {
                completed_recent: vec![vibevalley_protocol::DigestIssueRef {
                    id: "i2".into(),
                    number: 2,
                    title: "微信通知".into(),
                    detail: String::new(),
                    stuck: None,
                }],
                ..Default::default()
            },
            repo_health: vec![RepoHealth {
                repo: "alpha".into(),
                status: RepoHealthStatus::AtRisk,
                reasons: vec![vibevalley_protocol::RepoHealthReason::AskingUser],
                open_issues: 2,
                in_progress_issues: 1,
                in_review_issues: 0,
                blocked_issues: 0,
                stuck_issues: 0,
                asking_issues: 1,
                failed_checks: 0,
                overdue_issues: 0,
                last_commit_at: None,
                evaluated_at: 2_000,
            }],
            triage: vec![BacklogTriageSuggestion {
                id: "auto:i4:priority".into(),
                issue_id: "i4".into(),
                issue_number: 4,
                issue_title: "Fix urgent crash".into(),
                reason: "Urgent keyword".into(),
                summary: "Raise #4 priority to High".into(),
                source: vibevalley_protocol::ActorKind::System,
                patch: Default::default(),
                created_at: 2_000,
            }],
        };
        let converted = progress_digest_from_morning("早报", &morning);
        let three_part = format_progress_digest_in("zh", &converted);
        assert!(three_part.contains("仓库健康度："), "{three_part}");
        assert!(three_part.contains("alpha【存在风险】"), "{three_part}");
        assert!(three_part.contains("备选池梳理建议"), "{three_part}");
        assert!(three_part.contains("#4：Raise #4 priority to High"), "{three_part}");
    }
}
