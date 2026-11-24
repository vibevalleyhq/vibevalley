//! Editing, deleting, reviewing, and the runs a timeline is made of.

use std::path::Path;

use crate::support::*;
use vibevalley_protocol::{IssueStageKind as StageKind, IssueStatus, IssueUpdate, MilestoneKind, Outcome, RunTriggerKind};
use vibevalley_server::work::issue::NewIssue;
use vibevalley_server::work::ledger::BoardError;

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
    let a = block_on(w.board.create_async(new("First", Some(&main)))).unwrap();
    let b = block_on(w.board.create_async(new("Second", Some(&main)))).unwrap();
    let edited = block_on(w.board.edit_async(
        &b.id,
        &IssueUpdate {
            title: Some("Renamed\nwith more words".into()),
            criteria: Some(vec![" one ".into(), "".into()]),
            agent: Some("".into()),
            before: Some(a.id.clone()),
            ..Default::default()
        },
    ))
    .unwrap();
    assert_eq!(edited.title, "Renamed");
    assert_eq!(edited.description, "with more words");
    assert_eq!(edited.criteria, vec!["one".to_string()]);
    assert_eq!(edited.assigned_agent(), None);
    let ranks: Vec<(String, Option<i64>)> = w.board.read(|s| s.issues.iter().map(|i| (i.id.clone(), i.rank)).collect());
    let rank = |id: &str| ranks.iter().find(|r| r.0 == id).unwrap().1.unwrap_or(0);
    assert!(rank(&b.id) < rank(&a.id), "{ranks:?}");

    block_on(w.board.remove_async(&b.id)).unwrap();
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
    let issue = block_on(w.board.create_async(new("Make f", Some(&main)))).unwrap();
    block_on(w.board.move_to_async(&issue.id, IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, &issue.id, StageKind::Reviewing);

    let refused = block_on(w.board.edit_async(
        &issue.id,
        &IssueUpdate {
            description: Some("more".into()),
            ..Default::default()
        },
    ));
    assert!(matches!(refused, Err(BoardError::Other(_))), "{refused:?}");
    assert!(block_on(w.board.remove_async(&issue.id)).is_err());
    let renamed = block_on(w.board.edit_async(
        &issue.id,
        &IssueUpdate {
            title: Some("Make f now".into()),
            ..Default::default()
        },
    ))
    .unwrap();
    assert_eq!(renamed.title, "Make f now");

    // Failing needs words; failing with findings sends another round.
    assert!(block_on(w.board.review_async(&issue.id, false, &[], "", None)).is_err());
    block_on(w.board.review_async(&issue.id, false, &["it is wrong".into()], "", None)).unwrap();
    let back = wait_issue(&w.board, &issue.id, "second round handed back", |i| {
        i.stage.state == StageKind::Reviewing && i.findings.len() == 1
    });
    assert!(!back.findings[0].resolved);
    let passed = block_on(w.board.review_async(&issue.id, true, &[], "", None)).unwrap();
    assert!(passed.reviewed_at.is_some() && passed.findings[0].resolved);

    let runs = block_on(w.board.runs_async(&issue.id)).unwrap();
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
