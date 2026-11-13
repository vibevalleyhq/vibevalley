//! Editing, deleting, reviewing, and the runs a timeline is made of.

mod support;

use std::path::Path;

use support::*;
use vibevalley_issues::{BoardError, NewIssue};
use vibevalley_protocol::{IssueStageKind as StageKind, IssueStatus, IssueUpdate, MilestoneKind, Outcome, RunTriggerKind};

fn new(title: &str, repo: Option<&Path>) -> NewIssue {
    NewIssue {
        title: title.into(),
        repo: repo.map(Path::to_path_buf),
        agent: "t".into(),
        ..Default::default()
    }
}

#[test]
fn an_unsent_issue_is_edited_placed_and_deleted() {
    let w = world(vec![HookRuntime::new("t", quick(), |turn| turn.done("ok"))], |_| {});
    let main = repo(w.dir.path(), "app");
    let a = w.board.create(new("First", Some(&main))).unwrap();
    let b = w.board.create(new("Second", Some(&main))).unwrap();
    let edited = w
        .board
        .edit(
            &b.id,
            &IssueUpdate {
                title: Some("Renamed\nwith more words".into()),
                criteria: Some(vec![" one ".into(), "".into()]),
                agent: Some("".into()),
                before: Some(a.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(edited.title, "Renamed");
    assert_eq!(edited.description, "with more words");
    assert_eq!(edited.criteria, vec!["one".to_string()]);
    assert_eq!(edited.assigned_agent(), None);
    let ranks: Vec<(String, Option<i64>)> = w.board.read(|s| s.issues.iter().map(|i| (i.id.clone(), i.rank)).collect());
    let rank = |id: &str| ranks.iter().find(|r| r.0 == id).unwrap().1.unwrap_or(0);
    assert!(rank(&b.id) < rank(&a.id), "{ranks:?}");

    w.board.remove(&b.id).unwrap();
    assert!(w.board.issue(&b.id).is_none());
    assert!(w.board.issue(&a.id).is_some());
}

#[test]
fn a_sent_issue_keeps_what_was_asked_and_its_runs_make_the_timeline() {
    let round = std::sync::atomic::AtomicUsize::new(0);
    let w = world(
        vec![HookRuntime::new("t", quick(), move |turn| {
            let n = round.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            turn.commit("f.txt", &format!("{n}\n"));
            turn.done("Made f.txt");
        })],
        |_| {},
    );
    let main = repo(w.dir.path(), "app");
    let issue = w.board.create(new("Make f", Some(&main))).unwrap();
    w.board.move_to(&issue.id, IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, &issue.id, StageKind::Reviewing);

    let refused = w.board.edit(
        &issue.id,
        &IssueUpdate {
            description: Some("more".into()),
            ..Default::default()
        },
    );
    assert!(matches!(refused, Err(BoardError::Other(_))), "{refused:?}");
    assert!(w.board.remove(&issue.id).is_err());
    let renamed = w
        .board
        .edit(
            &issue.id,
            &IssueUpdate {
                title: Some("Make f now".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(renamed.title, "Make f now");

    // Failing needs words; failing with findings sends another round.
    assert!(w.board.review(&issue.id, false, &[], "").is_err());
    w.board.review(&issue.id, false, &["it is wrong".into()], "").unwrap();
    let back = wait_issue(&w.board, &issue.id, "second round handed back", |i| {
        i.stage.state == StageKind::Reviewing && i.findings.len() == 1
    });
    assert!(!back.findings[0].resolved);
    let passed = w.board.review(&issue.id, true, &[], "").unwrap();
    assert!(passed.reviewed_at.is_some() && passed.findings[0].resolved);

    let runs = w.board.runs(&issue.id).unwrap();
    assert_eq!(runs.len(), 2, "{runs:?}");
    assert_eq!(runs[0].triggered_by.kind, RunTriggerKind::Issue);
    assert_eq!(runs[1].triggered_by.kind, RunTriggerKind::Comment);
    assert!(runs.iter().all(|r| r.outcome == Some(Outcome::Completed) && r.summary == "Made f.txt"));
    let timeline = vibevalley_core::brief::milestones_of(&passed, &runs, |_| Some("helper".into()));
    let kinds: Vec<MilestoneKind> = timeline.milestones.iter().map(|m| m.kind).collect();
    assert_eq!(kinds.first(), Some(&MilestoneKind::Accepted), "{kinds:?}");
    assert_eq!(kinds.last(), Some(&MilestoneKind::Opened));
    assert!(kinds.contains(&MilestoneKind::Told) && kinds.contains(&MilestoneKind::Rejected));
}
