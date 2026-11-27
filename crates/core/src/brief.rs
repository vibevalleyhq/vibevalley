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
fn split_brief(brief: &str) -> (String, String) {
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

fn start_words(trigger: &RunTrigger, first: bool) -> String {
    match trigger.kind {
        RunTriggerKind::Refine => t("server.issue.timeline.refine", &[]),
        RunTriggerKind::Comment => t("server.issue.timeline.told", &[]),
        RunTriggerKind::Issue if first => t("server.issue.timeline.start", &[]),
        RunTriggerKind::Issue => t("server.issue.timeline.restart", &[]),
        RunTriggerKind::Cron => t("server.issue.timeline.cron", &[("missed", trigger.missed.unwrap_or(false).into())]),
        RunTriggerKind::Runtime => t("server.issue.timeline.runtime", &[]),
    }
}

/// `milestonesOf`: chronological oldest-first milestones; `name_of` a session's name by id.
pub fn milestones_of(issue: &Issue, runs: &[Run], name_of: impl Fn(&str) -> Option<String>) -> IssueTimeline {
    let mut out = vec![Milestone {
        at: issue.created_at,
        kind: MilestoneKind::Opened,
        who: None,
        text: t("server.issue.timeline.opened", &[]),
        said: None,
        run: None,
    }];
    let last_done = runs.iter().rposition(|r| r.ended_at.is_some());
    for (i, r) in runs.iter().enumerate() {
        let who = name_of(&r.session);
        let draft = r.triggered_by.kind == RunTriggerKind::Refine;
        let first = !runs[..i].iter().any(|x| x.triggered_by.kind != RunTriggerKind::Refine);
        out.push(Milestone {
            at: r.started_at,
            kind: MilestoneKind::Started,
            who: who.clone(),
            text: start_words(&r.triggered_by, first),
            said: None,
            run: Some(r.id.clone()),
        });
        let (Some(ended), Some(outcome)) = (r.ended_at, r.outcome) else { continue };
        let summary_said = Some(plain_text(&r.summary)).filter(|s| !s.is_empty());
        let (kind, text, said) = match outcome {
            Outcome::Completed if Some(i) == last_done && !issue.questions.is_empty() => {
                let questions: Vec<&str> = issue.questions.iter().map(|q| q.question.as_str()).collect();
                (
                    MilestoneKind::Asked,
                    t("server.issue.timeline.asked", &[("questions", questions.join(" / ").into())]),
                    None,
                )
            }
            Outcome::Completed if draft => (MilestoneKind::Refined, t("server.issue.timeline.refined", &[]), summary_said),
            Outcome::Completed => (MilestoneKind::Reported, t("server.issue.timeline.reported", &[]), summary_said),
            Outcome::Failed => (MilestoneKind::Failed, t("shared.outcome.failed", &[]), summary_said),
            Outcome::Interrupted => (MilestoneKind::Stopped, t("shared.outcome.interrupted", &[]), summary_said),
        };
        out.push(Milestone {
            at: ended,
            kind,
            who,
            text,
            said,
            run: Some(r.id.clone()),
        });
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
            said: None,
            run: None,
        });
    }
    if let Some(at) = issue.reviewed_at {
        out.push(Milestone {
            at,
            kind: MilestoneKind::Accepted,
            who: None,
            text: t("server.issue.timeline.accepted", &[]),
            said: None,
            run: None,
        });
    }
    if let Some(at) = issue.closed_at {
        out.push(Milestone {
            at,
            kind: MilestoneKind::Closed,
            who: None,
            text: closed_text(issue),
            said: None,
            run: None,
        });
    }
    // Oldest first; at the same moment, preserve earlier story step first.
    let mut indexed: Vec<(usize, Milestone)> = out.into_iter().enumerate().collect();
    indexed.sort_by(|a, b| a.1.at.cmp(&b.1.at).then(a.0.cmp(&b.0)));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_run(id: &str, trigger: RunTriggerKind, started_at: i64, ended_at: Option<i64>, outcome: Option<Outcome>, summary: &str) -> Run {
        Run {
            needs_reconciliation: false,
            id: id.to_string(),
            session: "s1".into(),
            issue: Some("i1".into()),
            subagents: None,
            triggered_by: RunTrigger {
                kind: trigger,
                message: None,
                channel: None,
                cron: None,
                missed: None,
            },
            heard: vec![],
            started_at,
            ended_at,
            outcome,
            summary: summary.to_string(),
            spent: None,
        }
    }

    #[test]
    fn brief_helpers_split_cure_and_format_findings() {
        assert_eq!(issue_words("  \n ", "ignored"), None);
        let (title, desc) = issue_words("Short title\nExtra line", "Body").unwrap();
        assert_eq!(title, "Short title");
        assert_eq!(desc, "Extra line\n\nBody");

        let long_first = "word ".repeat(30);
        let (cut_title, full_desc) = issue_words(&long_first, "More").unwrap();
        assert!(cut_title.ends_with('…'));
        assert!(full_desc.contains("More") && full_desc.contains("word"));

        assert_eq!(findings_of("  one \n\n two  "), vec!["one", "two"]);
        assert_eq!(cure_words(&cure_words("test failed")), cure_words("test failed"));
        let failed = failed_text(
            &[
                Finding {
                    id: "f1".into(),
                    at: 1,
                    text: "fix A".into(),
                    resolved: false,
                },
                Finding {
                    id: "f2".into(),
                    at: 2,
                    text: "already ok".into(),
                    resolved: true,
                },
            ],
            "please verify",
        );
        assert!(failed.contains("1. fix A") && !failed.contains("already ok") && failed.contains("please verify"));
    }

    #[test]
    fn milestones_emit_chronological_oldest_first_with_run_and_separated_said() {
        let mut issue = Issue::new("i1", 1, "Fix auth", 100);
        issue.findings = vec![Finding {
            id: "f1".into(),
            at: 250,
            text: "Add edge test".into(),
            resolved: true,
        }];
        issue.reviewed_at = Some(400);
        issue.closed_at = Some(400);
        issue.status = IssueStatus::Done;
        issue.delivered = Some(Landing::Merged);

        let mut r1 = make_run("r1", RunTriggerKind::Refine, 110, Some(150), Some(Outcome::Completed), "**Drafted** scope");
        r1.spent = Some(Spent {
            tokens: 100,
            cny: Some(JsNumber(0.10)),
        });
        let mut r2 = make_run("r2", RunTriggerKind::Issue, 200, Some(240), Some(Outcome::Completed), "Fixed `auth.rs`");
        r2.spent = Some(Spent {
            tokens: 250,
            cny: Some(JsNumber(0.25)),
        });
        let r3 = make_run("r3", RunTriggerKind::Comment, 300, Some(350), Some(Outcome::Failed), "Test **failed**");
        let r4 = make_run("r4", RunTriggerKind::Runtime, 360, None, None, "");

        let tl = milestones_of(&issue, &[r1, r2, r3, r4], |_| Some("helper".into()));
        let kinds: Vec<MilestoneKind> = tl.milestones.iter().map(|m| m.kind).collect();
        assert_eq!(
            kinds,
            vec![
                MilestoneKind::Opened,
                MilestoneKind::Started,
                MilestoneKind::Refined,
                MilestoneKind::Started,
                MilestoneKind::Reported,
                MilestoneKind::Rejected,
                MilestoneKind::Started,
                MilestoneKind::Failed,
                MilestoneKind::Started,
                MilestoneKind::Accepted,
                MilestoneKind::Closed,
            ]
        );
        assert!(tl.milestones.windows(2).all(|w| w[0].at <= w[1].at));
        assert_eq!(tl.milestones[0].run, None);
        assert_eq!(tl.milestones[1].run.as_deref(), Some("r1"));
        assert_eq!(tl.milestones[2].run.as_deref(), Some("r1"));
        assert_eq!(tl.milestones[2].said.as_deref(), Some("Drafted scope"));
        assert!(!tl.milestones[2].text.contains("Drafted scope"));
        assert_eq!(tl.milestones[4].said.as_deref(), Some("Fixed auth.rs"));
        assert_eq!(tl.milestones[6].kind, MilestoneKind::Started);
        assert_eq!(tl.milestones[6].run.as_deref(), Some("r3"));
        assert_eq!(tl.milestones[7].kind, MilestoneKind::Failed);
        assert_eq!(tl.milestones[7].said.as_deref(), Some("Test failed"));
        assert_eq!(tl.milestones[8].kind, MilestoneKind::Started);
        assert_eq!(tl.milestones[8].run.as_deref(), Some("r4"));
        assert_eq!(tl.milestones[9].run, None);
        assert_eq!(tl.milestones[10].run, None);

        let spent = tl.spent.expect("spent should sum across runs");
        assert_eq!(spent.tokens, 350);
        assert!((spent.cny.unwrap().0 - 0.35).abs() < 1e-6);
    }

    #[test]
    fn milestones_asking_omits_said_and_same_timestamp_keeps_story_order() {
        let mut issue = Issue::new("i2", 2, "Pick port", 100);
        issue.questions = vec![Question {
            question: "Which port?".into(),
            options: vec!["8080".into(), "8790".into()],
        }];
        let r1 = make_run(
            "r1",
            RunTriggerKind::Issue,
            100,
            Some(100),
            Some(Outcome::Completed),
            "Ask the user: Which port?",
        );
        let tl = milestones_of(&issue, &[r1], |_| None);
        let kinds: Vec<MilestoneKind> = tl.milestones.iter().map(|m| m.kind).collect();
        assert_eq!(kinds, vec![MilestoneKind::Opened, MilestoneKind::Started, MilestoneKind::Asked]);
        assert_eq!(tl.milestones[2].said, None);
        assert_eq!(tl.milestones[2].run.as_deref(), Some("r1"));
        assert!(tl.milestones[2].text.contains("Which port?"));
    }
}
