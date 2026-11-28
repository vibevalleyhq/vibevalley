//! Parent and child issues: pure DAG decomposition, dependency blocking,
//! directoryless splits, and draft refinement without server-side worktree babysitting.

use std::path::Path;

use crate::support::*;
use vibevalley_protocol::{DeliveryReceipt, IssueStageKind as StageKind, IssueStatus};
use vibevalley_server::issue::{ChildDraft, NewIssue};

fn issue(title: &str, repo: Option<&Path>) -> NewIssue {
    NewIssue {
        title: title.into(),
        repo: repo.map(Path::to_path_buf),
        agent: "t".into(),
        ..Default::default()
    }
}

#[test]
fn a_split_queues_its_children_in_dependency_order_without_server_branch_merging() {
    let gate = TurnGate::new();
    let rt = HookRuntime::new("t", gate.script("done"), |turn| {
        let name = if turn.prompt.contains("Part A") { "a.txt" } else { "b.txt" };
        turn.commit(name, "x\n");
        turn.done("ok");
    });
    let prompts = rt.prompts.clone();
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    let parent = block_on(w.board.create_async(issue("Big", Some(&main)))).unwrap();
    let drafts = vec![
        ChildDraft {
            id: "a".into(),
            title: "Part A".into(),
            brief: "do A".into(),
            ..Default::default()
        },
        ChildDraft {
            id: "b".into(),
            title: "Part B".into(),
            brief: "do B".into(),
            needs: vec!["a".into()],
            check: Some("test -f a.txt".into()),
            ..Default::default()
        },
    ];
    let bad = vec![ChildDraft {
        id: "x".into(),
        needs: vec!["x".into()],
        ..Default::default()
    }];
    assert!(block_on(w.board.split_async(&parent.id, bad)).is_err());
    let children = block_on(w.board.split_async(&parent.id, drafts)).unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(children[1].blocked_by, vec![children[0].id.clone()]);
    assert!(
        block_on(w.board.split_async(
            &parent.id,
            vec![ChildDraft {
                id: "c".into(),
                ..Default::default()
            }]
        ))
        .is_err()
    );
    let first = board_issue(&w.board, &children[0].id).unwrap();
    assert_eq!(first.stage.state, StageKind::Working);
    assert_eq!(board_issue(&w.board, &children[1].id).unwrap().stage.state, StageKind::Queued);
    assert_eq!(board_issue(&w.board, &parent.id).unwrap().status, IssueStatus::InProgress);

    // Child A finishes into InReview; child B stays queued until child A is explicitly closed.
    gate.release();
    wait_stage(&w.board, &children[0].id, StageKind::Reviewing);
    assert_eq!(board_issue(&w.board, &children[1].id).unwrap().stage.state, StageKind::Queued);
    block_on(w.board.move_with_receipt_async(
        &children[0].id,
        IssueStatus::Done,
        None,
        None,
        Some(DeliveryReceipt::Commit {
            sha: git(&main, &["rev-parse", "HEAD"]),
            branch: Some("main".into()),
            summary: Some("Part A committed".into()),
        }),
    ))
    .unwrap();

    // Closing child A releases child B via DAG blocking.
    wait_stage(&w.board, &children[1].id, StageKind::Working);
    gate.release();
    wait_stage(&w.board, &children[1].id, StageKind::Reviewing);
    let b_prompt = prompts.lock().unwrap().iter().find(|p| p.contains("Part B")).cloned().unwrap();
    assert!(b_prompt.contains("检查命令：test -f a.txt"), "{b_prompt}");
    block_on(w.board.move_to_async(&children[1].id, IssueStatus::Done, None)).unwrap();

    // Once all children are closed, parent is ready for review and can be closed cleanly.
    wait_stage(&w.board, &parent.id, StageKind::Reviewing);
    block_on(w.board.move_to_async(&parent.id, IssueStatus::Done, None)).unwrap();
    assert_eq!(board_issue(&w.board, &parent.id).unwrap().status, IssueStatus::Done);
    assert!(!w.dir.path().join("worktrees").exists(), "server must not create worktrees dir");
}

#[test]
fn directoryless_parent_can_split_and_complete_with_note_and_answer_receipts() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        if turn.prompt.contains("Research") {
            turn.report(r#"{"status":"done","summary":"Research done","deliveryReceipt":{"kind":"answer","summary":"Use SQLite WAL"}}"#);
        } else {
            turn.report(r#"{"status":"done","summary":"Doc drafted","deliveryReceipt":{"kind":"note","noteId":"n-arch","title":"Architecture RFC"}}"#);
        }
    });
    let w = world(vec![rt], |_| {});
    let parent = block_on(w.board.create_async(issue("Write RFC", None))).unwrap();
    assert!(parent.repo.is_none());
    let children = block_on(w.board.split_async(
        &parent.id,
        vec![
            ChildDraft {
                id: "research".into(),
                title: "Research".into(),
                brief: "Compare storage options".into(),
                ..Default::default()
            },
            ChildDraft {
                id: "draft".into(),
                title: "Draft note".into(),
                brief: "Write RFC note".into(),
                needs: vec!["research".into()],
                ..Default::default()
            },
        ],
    ))
    .unwrap();
    assert!(children.iter().all(|c| c.repo.is_none()));
    wait_stage(&w.board, &children[0].id, StageKind::Reviewing);
    let c0 = board_issue(&w.board, &children[0].id).unwrap();
    assert_eq!(
        c0.delivery_receipt,
        Some(DeliveryReceipt::Answer {
            summary: "Use SQLite WAL".into(),
        })
    );
    block_on(w.board.move_to_async(&children[0].id, IssueStatus::Done, None)).unwrap();
    wait_stage(&w.board, &children[1].id, StageKind::Reviewing);
    let c1 = board_issue(&w.board, &children[1].id).unwrap();
    assert_eq!(
        c1.delivery_receipt,
        Some(DeliveryReceipt::Note {
            note_id: "n-arch".into(),
            title: Some("Architecture RFC".into()),
            summary: None,
        })
    );
    block_on(w.board.move_to_async(&children[1].id, IssueStatus::Done, None)).unwrap();
    wait_stage(&w.board, &parent.id, StageKind::Reviewing);
    block_on(w.board.move_to_async(&parent.id, IssueStatus::Done, None)).unwrap();
    assert_eq!(board_issue(&w.board, &parent.id).unwrap().status, IssueStatus::Done);
}

#[test]
fn a_draft_writes_the_issue_up_and_leaves_no_trace() {
    let said = "I read the code.\n\nAsk the user: which port? (options: 8080 | 9090)\n\n```json\n\
        {\"title\": \"Serve on a port\", \"why\": \"it has none\", \"todo\": [\"add a flag\"], \
        \"criteria\": [\"app --port 8080 serves\"], \"notDoing\": [], \"files\": [\"src/main.rs\"]}\n```\n\nReady.";
    let gate = TurnGate::new();
    let rt = HookRuntime::new("t", gate.script(said), |turn| {
        assert!(turn.prompt.contains("用户想做的：it should listen somewhere"), "{}", turn.prompt);
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(issue("Port", Some(&main)))).unwrap();
    block_on(w.board.refine_async(&vibevalley_protocol::IssueRefineInput {
        id: "1".into(),
        text: Some("it should listen somewhere".into()),
        edit: None,
    }))
    .unwrap();
    let drafting = board_issue(&w.board, "1").unwrap();
    assert!(drafting.refining.is_some());
    assert!(
        block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).is_err(),
        "a draft being written cannot start"
    );
    gate.release();
    let drafted = wait_issue(&w.board, "1", "drafted", |t| t.refining.is_none() && t.title != "Port");
    assert_eq!(drafted.title, "Serve on a port");
    assert_eq!(drafted.description, "Why\nit has none\n\nTo do\n- add a flag\n\nFiles\n- src/main.rs");
    assert_eq!(drafted.criteria, vec!["app --port 8080 serves"]);
    assert_eq!(drafted.questions[0].options, vec!["8080", "9090"]);
    assert_eq!((drafted.status, drafted.was_sent()), (IssueStatus::Backlog, false));
    assert!(board_bundle(&w.board).sessions.sessions.is_empty());
    assert!(!w.dir.path().join("worktrees").exists());
    assert!(git(&main, &["branch", "--list", "vibevalley/issue-1"]).is_empty());
}
