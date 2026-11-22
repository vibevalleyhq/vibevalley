//! Parent and child issues, splits and drafts. The acceptance test is
//! translated from VibeValley `apps/server/src/flows/acceptance.test.ts`.

use std::path::Path;

use crate::support::*;
use vibevalley_protocol::{IssueConstraints, IssueStageKind as StageKind, IssueStatus, Landing};
use vibevalley_runtime::oar::scripted::{Script, Step};
use vibevalley_server::modules::work::issue::{ChildDraft, NewIssue};

fn issue(title: &str, repo: &Path) -> NewIssue {
    NewIssue {
        title: title.into(),
        repo: Some(repo.to_path_buf()),
        agent: "t".into(),
        ..Default::default()
    }
}

fn read_on(repo: &Path, branch: &str, file: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show", &format!("{branch}:{file}")])
        .output()
        .unwrap();
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Pass,
    Frozen,
    Failed,
}

fn acceptance(mode: Mode) {
    let rt = HookRuntime::new("t", quick(), move |turn| {
        if !turn.cwd.join("check.sh").exists() {
            turn.write("check.sh", "test -f result.txt\n");
        } else {
            if mode != Mode::Failed {
                turn.write("result.txt", "implementation");
            } else {
                turn.write("unrelated.txt", "not implemented");
            }
            if mode == Mode::Frozen {
                turn.write("check.sh", "true\n");
            }
        }
        git(&turn.cwd, &["add", "."]);
        git(&turn.cwd, &["commit", "-q", "-m", "Implement assigned child"]);
        turn.done("finished");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "acceptance");
    let parent = w.board.create(issue("parent", &main)).unwrap();
    let mut seed = issue("seed-red-test", &main);
    seed.parent = Some(parent.id.clone());
    seed.constraints = Some(IssueConstraints {
        acceptance: true,
        check: Some("sh check.sh".into()),
        scope: vec!["check.sh".into()],
        frozen: vec![],
    });
    let seed = w.board.create(seed).unwrap();
    let mut implementation = issue("implement", &main);
    implementation.parent = Some(parent.id.clone());
    implementation.blocked_by = vec![seed.id.clone()];
    let implementation = w.board.create(implementation).unwrap();

    w.board.move_to(&seed.id, IssueStatus::Todo, None).unwrap();
    let red = wait_issue(&w.board, &seed.id, "the red acceptance test merged", |t| t.status == IssueStatus::Done);
    assert_eq!(red.delivered, Some(Landing::MergedIntoParent));
    assert_eq!(red.constraints.unwrap().frozen, vec!["check.sh"]);

    w.board.move_to(&implementation.id, IssueStatus::Todo, None).unwrap();
    let result = wait_issue(&w.board, &implementation.id, "the implementation verified", |t| match mode {
        Mode::Pass => t.status == IssueStatus::Done,
        _ => !t.questions.is_empty(),
    });
    assert_eq!(read_on(&main, "vibevalley/issue-1", "check.sh").as_deref(), Some("test -f result.txt\n"));
    if mode == Mode::Pass {
        assert_eq!(result.delivered, Some(Landing::MergedIntoParent));
        assert_eq!(read_on(&main, "vibevalley/issue-1", "result.txt").as_deref(), Some("implementation"));
        // The parent waits for its final acceptance, then merges into main.
        let parent = wait_stage(&w.board, &parent.id, StageKind::Reviewing);
        assert_eq!(parent.status, IssueStatus::InReview);
        assert!(
            w.board
                .bundle()
                .inbox
                .items
                .iter()
                .any(|i| matches!(&i.target, vibevalley_protocol::InboxTarget::Issue(t) if t.id == parent.id))
        );
        w.board.move_to(&parent.id, IssueStatus::Done, None).unwrap();
        assert_eq!(w.board.issue(&parent.id).unwrap().delivered, Some(Landing::Merged));
        assert_eq!(read_on(&main, "main", "result.txt").as_deref(), Some("implementation"));
        assert!(read_on(&main, "vibevalley/issue-1", "check.sh").is_none(), "the parent's merged branch is gone");
    } else {
        assert_eq!(result.delivered, None);
        let want = if mode == Mode::Frozen { "check.sh" } else { "sh check.sh" };
        assert!(result.questions[0].question.contains(want), "{}", result.questions[0].question);
        assert_eq!(result.stage.state, StageKind::Asking);
    }
}

#[test]
fn regression_native_child_acceptance_passes_before_merging_into_the_parent() {
    acceptance(Mode::Pass);
}

#[test]
fn regression_native_child_acceptance_rejects_changes_to_frozen_tests() {
    acceptance(Mode::Frozen);
}

#[test]
fn regression_native_child_acceptance_rejects_an_implementation_that_fails_the_inherited_check() {
    acceptance(Mode::Failed);
}

#[test]
fn a_split_queues_its_children_in_dependency_order() {
    let rt = HookRuntime::new("t", slow_first(150), |turn| {
        let name = if turn.prompt.contains("Part A") { "a.txt" } else { "b.txt" };
        turn.commit(name, "x\n");
        turn.done("ok");
    });
    let prompts = rt.prompts.clone();
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    let parent = w.board.create(issue("Big", &main)).unwrap();
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
    assert!(w.board.split(&parent.id, bad).is_err());
    let children = w.board.split(&parent.id, drafts).unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(children[1].blocked_by, vec![children[0].id.clone()]);
    assert!(
        w.board
            .split(
                &parent.id,
                vec![ChildDraft {
                    id: "c".into(),
                    ..Default::default()
                }]
            )
            .is_err()
    );
    let first = w.board.issue(&children[0].id).unwrap();
    assert_eq!(first.stage.state, StageKind::Working);
    assert_eq!(w.board.issue(&children[1].id).unwrap().stage.state, StageKind::Queued);
    assert_eq!(w.board.issue(&parent.id).unwrap().status, IssueStatus::InProgress);
    wait_issue(&w.board, &children[1].id, "B merged", |t| t.status == IssueStatus::Done);
    let b_prompt = prompts.lock().unwrap().iter().find(|p| p.contains("Part B")).cloned().unwrap();
    assert!(b_prompt.contains("检查命令：test -f a.txt"), "{b_prompt}");
    wait_stage(&w.board, &parent.id, StageKind::Reviewing);
    // Canceling a parent cancels its open children; here all are done.
    w.board.move_to(&parent.id, IssueStatus::Done, None).unwrap();
    assert!(read_on(&main, "main", "a.txt").is_some() && read_on(&main, "main", "b.txt").is_some());
}

#[test]
fn a_draft_writes_the_issue_up_and_leaves_no_trace() {
    let said = "I read the code.\n\nAsk the user: which port? (options: 8080 | 9090)\n\n```json\n\
        {\"title\": \"Serve on a port\", \"why\": \"it has none\", \"todo\": [\"add a flag\"], \
        \"criteria\": [\"app --port 8080 serves\"], \"notDoing\": [], \"files\": [\"src/main.rs\"]}\n```\n\nReady.";
    let script = Script::new().turn(vec![Step::sleep_ms(100), Step::text(said)]);
    let rt = HookRuntime::new("t", script, |turn| {
        assert!(turn.prompt.contains("用户想做的：it should listen somewhere"), "{}", turn.prompt);
        turn.write("scratch.txt", "drafts leave no files");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    w.board.create(issue("Port", &main)).unwrap();
    w.board.refine("1", "it should listen somewhere").unwrap();
    let drafting = w.board.issue("1").unwrap();
    assert!(drafting.refining.is_some());
    assert!(w.board.move_to("1", IssueStatus::Todo, None).is_err(), "a draft being written cannot start");
    let drafted = wait_issue(&w.board, "1", "drafted", |t| t.refining.is_none() && t.title != "Port");
    assert_eq!(drafted.title, "Serve on a port");
    assert_eq!(drafted.description, "Why\nit has none\n\nTo do\n- add a flag\n\nFiles\n- src/main.rs");
    assert_eq!(drafted.criteria, vec!["app --port 8080 serves"]);
    assert_eq!(drafted.questions[0].options, vec!["8080", "9090"]);
    assert_eq!((drafted.status, drafted.was_sent()), (IssueStatus::Backlog, false));
    assert!(w.board.bundle().sessions.sessions.is_empty());
    assert!(!w.dir.path().join("vibevalley/worktrees/app.1").exists());
    assert!(git(&main, &["branch", "--list", "vibevalley/issue-1"]).is_empty());
}
