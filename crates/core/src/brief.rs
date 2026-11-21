//! Words the issue module says to a session and about an issue. Ported from
//! VibeValley `apps/server/src/modules/issue/brief.ts` (`splitBrief`,
//! `findingsOf`, `cureWords`, `resumeWords`, `milestonesOf`) and
//! `issue.ts` (`failedText`).

use vibevalley_i18n::t;
use vibevalley_protocol::*;

use crate::rules::{closed_text, plain_text, short_title};

/// `splitBrief`: the first line with words is the title, the rest the
/// description; a first line too long for a title is cut and kept whole in
/// the description.
pub fn split_brief(brief: &str) -> (String, String) {
    let text = brief.replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(i) = lines.iter().position(|l| !l.trim().is_empty()) else {
        return (String::new(), String::new());
    };
    let first = lines[i].trim();
    let title = short_title(first);
    if title != first {
        return (title, lines[i..].join("\n").trim().to_string());
    }
    (first.to_string(), lines[i + 1..].join("\n").trim().to_string())
}

/// `issueWords`: title and description as stored; None when there is no
/// title.
pub fn issue_words(title: &str, description: &str) -> Option<(String, String)> {
    let (title, rest) = split_brief(title);
    if title.is_empty() {
        return None;
    }
    let mut description = description.trim().to_string();
    if !rest.is_empty() {
        description = format!("{rest}\n\n{description}").trim().to_string();
    }
    Some((title, description))
}

/// `findingsOf`: one finding a non-blank line.
pub fn findings_of(text: &str) -> Vec<String> {
    text.split('\n').map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

pub fn resume_words() -> String {
    t("server.issue.brief.resume", &[])
}

/// `cureWords`: the same brief however often it is told.
pub fn cure_words(brief: &str) -> String {
    let head = t("server.issue.brief.cureHead", &[]);
    let tail = t("server.issue.brief.cureTail", &[]);
    let mut original = brief;
    if let Some(rest) = original.strip_prefix(head.as_str()) {
        original = rest;
    }
    if let Some(rest) = original.strip_suffix(tail.as_str()) {
        original = rest;
    }
    t("server.issue.brief.cure", &[("brief", original.to_string().into())])
}

/// `failedText`: the open findings, numbered, and the user's words.
pub fn failed_text(findings: &[Finding], text: &str) -> String {
    let mut out = t("server.issue.brief.failedHead", &[]);
    for (n, f) in findings.iter().filter(|f| !f.resolved).enumerate() {
        out.push_str(&format!("\n{}. {}", n + 1, f.text));
    }
    if !text.is_empty() {
        out.push_str("\n\n");
        out.push_str(text);
    }
    out + &t("server.issue.brief.failedEnd", &[])
}

fn start_words(trigger: &RunTrigger, first: bool) -> (MilestoneKind, String) {
    match trigger.kind {
        RunTriggerKind::Refine => (MilestoneKind::Started, t("server.issue.timeline.refine", &[])),
        RunTriggerKind::Comment => (MilestoneKind::Told, t("server.issue.timeline.told", &[])),
        RunTriggerKind::Issue if first => (MilestoneKind::Started, t("server.issue.timeline.start", &[])),
        RunTriggerKind::Issue => (MilestoneKind::Started, t("server.issue.timeline.restart", &[])),
        RunTriggerKind::Cron => (
            MilestoneKind::Started,
            t("server.issue.timeline.cron", &[("missed", trigger.missed.unwrap_or(false).into())]),
        ),
        RunTriggerKind::Runtime => (MilestoneKind::Started, t("server.issue.timeline.runtime", &[])),
    }
}

/// `milestonesOf`: runs oldest first; `name_of` a session's name by id.
pub fn milestones_of(issue: &Issue, runs: &[Run], name_of: impl Fn(&str) -> Option<String>) -> IssueTimeline {
    let mut out = vec![Milestone {
        at: issue.created_at,
        kind: MilestoneKind::Opened,
        who: None,
        text: t("server.issue.timeline.opened", &[]),
    }];
    let last_done = runs.iter().rposition(|r| r.ended_at.is_some());
    for (i, r) in runs.iter().enumerate() {
        let who = name_of(&r.session);
        let draft = r.triggered_by.kind == RunTriggerKind::Refine;
        let first = !runs[..i].iter().any(|x| x.triggered_by.kind != RunTriggerKind::Refine);
        let (kind, text) = start_words(&r.triggered_by, first);
        out.push(Milestone {
            at: r.started_at,
            kind,
            who: who.clone(),
            text,
        });
        let (Some(ended), Some(outcome)) = (r.ended_at, r.outcome) else { continue };
        let said = if r.summary.is_empty() {
            String::new()
        } else {
            t("server.issue.timeline.said", &[("summary", plain_text(&r.summary).into())])
        };
        let (kind, text) = match outcome {
            Outcome::Completed if Some(i) == last_done && !issue.questions.is_empty() => {
                let questions: Vec<&str> = issue.questions.iter().map(|q| q.question.as_str()).collect();
                (
                    MilestoneKind::Asked,
                    t("server.issue.timeline.asked", &[("questions", questions.join(" / ").into())]),
                )
            }
            Outcome::Completed if draft => (MilestoneKind::Refined, t("server.issue.timeline.refined", &[]) + &said),
            Outcome::Completed => (MilestoneKind::Reported, t("server.issue.timeline.reported", &[]) + &said),
            Outcome::Failed => (MilestoneKind::Failed, t("shared.outcome.failed", &[]) + &said),
            Outcome::Interrupted => (MilestoneKind::Stopped, t("shared.outcome.interrupted", &[]) + &said),
        };
        out.push(Milestone { at: ended, kind, who, text });
    }
    let mut sent_back: Vec<(i64, Vec<String>)> = Vec::new();
    for f in &issue.findings {
        match sent_back.iter_mut().find(|(at, _)| *at == f.at) {
            Some((_, lines)) => lines.push(f.text.clone()),
            None => sent_back.push((f.at, vec![f.text.clone()])),
        }
    }
    let separator = t("server.issue.timeline.rejectedSeparator", &[]);
    for (at, lines) in sent_back {
        out.push(Milestone {
            at,
            kind: MilestoneKind::Rejected,
            who: None,
            text: t("server.issue.timeline.rejected", &[("lines", lines.join(&separator).into())]),
        });
    }
    if let Some(at) = issue.reviewed_at {
        out.push(Milestone {
            at,
            kind: MilestoneKind::Accepted,
            who: None,
            text: t("server.issue.timeline.accepted", &[]),
        });
    }
    if let Some(at) = issue.closed_at {
        out.push(Milestone {
            at,
            kind: MilestoneKind::Closed,
            who: None,
            text: closed_text(issue),
        });
    }
    // Newest first; at the same moment, the later step of the story first.
    let mut indexed: Vec<(usize, Milestone)> = out.into_iter().enumerate().collect();
    indexed.sort_by(|a, b| b.1.at.cmp(&a.1.at).then(b.0.cmp(&a.0)));
    let spent = runs.iter().filter_map(|r| r.spent.as_ref()).fold(None::<Spent>, |sum, s| {
        let cny = match (s.cny, sum.as_ref().and_then(|x| x.cny)) {
            (None, before) => before,
            (Some(c), before) => Some(JsNumber(before.map(|b| b.0).unwrap_or(0.0) + c.0)),
        };
        Some(Spent {
            tokens: sum.map(|x| x.tokens).unwrap_or(0) + s.tokens,
            cny,
        })
    });
    IssueTimeline {
        milestones: indexed.into_iter().map(|(_, m)| m).collect(),
        spent,
    }
}
