//! The board end to end on real temporary git repositories and the scripted
//! runtime (no quota). Each turn's hook plays the agent: it writes and
//! commits files in the worktree and writes the report.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::support::*;
use vibevalley_core::Move;
use vibevalley_protocol::{Deliverable, IssueCanceled, IssueStageKind as StageKind, IssueStatus, Landing, Outcome, Phase, StuckReason};
use vibevalley_runtime::oar::scripted::{Script, Step};
use vibevalley_runtime::oar::{PermissionMode, Runtime, StopReason};
use vibevalley_server::issue::{Board, NewIssue};
use vibevalley_server::runtime::{BoardError, Undelivered};

fn new(title: &str, repo: Option<&Path>) -> NewIssue {
    NewIssue {
        title: title.into(),
        description: format!("{title}, please."),
        criteria: vec!["it is there".into()],
        repo: repo.map(Path::to_path_buf),
        agent: "t".into(),
        ..Default::default()
    }
}

fn exists_on(repo: &Path, branch: &str, file: &str) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "-e", &format!("{branch}:{file}")])
        .status()
        .unwrap()
        .success()
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    !git(repo, &["branch", "--list", branch]).is_empty()
}

#[test]
fn an_issue_goes_from_backlog_to_merged() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.commit("feature.txt", "made by the agent\n");
        turn.done("Added feature.txt");
    });
    let prompts = rt.prompts.clone();
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    let issue = block_on(w.board.create_async(new("Add the feature", Some(&main)))).unwrap();
    assert_eq!((issue.number, issue.status, issue.stage.state), (1, IssueStatus::Backlog, StageKind::Draft));
    assert_eq!(block_on(w.board.move_to_async("#1", IssueStatus::Todo, None)).unwrap(), Move::Start);

    let reviewing = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(reviewing.status, IssueStatus::InReview);
    let session = board_session(&w.board, reviewing.latest_session_id().unwrap()).unwrap();
    assert_eq!(session.phase, Phase::done());
    assert_eq!(session.last_run.as_ref().unwrap().summary, "Added feature.txt");
    assert_eq!(session.worktree_branch(), Some("vibevalley/issue-1"));
    assert_eq!(w.board.sessions().base_branch(&session.id).as_deref(), Some("main"));
    let worktree = session.cwd.clone().unwrap();
    assert!(worktree.ends_with("worktrees/app.1"), "{worktree}");
    assert!(prompts.lock().unwrap()[0].starts_with("Add the feature"));
    assert!(prompts.lock().unwrap()[0].contains("1. it is there"));
    let inbox = board_bundle(&w.board).inbox.items;
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].kind, vibevalley_protocol::InboxKind::Review);

    let changes = board_changes(&w.board, "1").unwrap();
    assert_eq!(changes.commits.len(), 1);
    assert_eq!(changes.files.len(), 1);
    assert!(changes.uncommitted.is_empty() && changes.conflicts.is_empty());

    assert_eq!(block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap(), Move::Complete);
    let done = board_issue(&w.board, "1").unwrap();
    assert_eq!((done.status, done.delivered), (IssueStatus::Done, Some(Landing::Merged)));
    assert!(exists_on(&main, "main", "feature.txt"));
    assert!(!Path::new(&worktree).exists(), "the worktree is removed");
    assert!(!branch_exists(&main, "vibevalley/issue-1"), "the merged branch is deleted");
    assert!(board_bundle(&w.board).sessions.sessions.is_empty(), "its session left");
    assert!(board_bundle(&w.board).inbox.items.is_empty());
}

#[test]
fn uncommitted_leftovers_go_in_with_the_rest() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.write("loose.txt", "not committed\n");
        turn.done("left it uncommitted");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Loose", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(board_changes(&w.board, "1").unwrap().uncommitted.len(), 1);
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert!(exists_on(&main, "main", "loose.txt"));
}

#[test]
fn a_failed_round_is_cured_not_completed() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        if turn.index == 0 {
            turn.report(r#"{"status":"failed","summary":"the build broke"}"#);
        } else {
            assert!(turn.prompt.contains("The last round failed"), "{}", turn.prompt);
            turn.commit("fixed.txt", "ok\n");
            turn.done("fixed it");
        }
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Fragile", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let stuck = wait_stage(&w.board, "1", StageKind::Stuck);
    assert_eq!((stuck.status, stuck.stage.stuck), (IssueStatus::InProgress, Some(StuckReason::Failed)));
    assert!(!stuck.moves.contains(&IssueStatus::Done));
    assert!(matches!(
        block_on(w.board.move_to_async("1", IssueStatus::Done, None)),
        Err(BoardError::Refused(_))
    ));
    assert_eq!(board_bundle(&w.board).inbox.items[0].kind, vibevalley_protocol::InboxKind::Fix);
    // Cure: back to todo with the server's own words.
    assert_eq!(block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap(), Move::Round);
    let fixed = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(board_session(&w.board, fixed.latest_session_id().unwrap()).unwrap().runs, 2);
    assert_eq!(vibevalley_core::rules::session_ids_of(&fixed).len(), 1, "the same session takes the next round");
}

#[test]
fn a_turn_that_errors_is_a_failed_round() {
    let script = Script::new().turn(vec![Step::text("oops"), Step::finish(StopReason::Error)]);
    let rt = HookRuntime::new("t", script, |_| {});
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Crash", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let stuck = wait_stage(&w.board, "1", StageKind::Stuck);
    assert_eq!(stuck.stage.stuck, Some(StuckReason::Failed));
    let s = board_session(&w.board, stuck.latest_session_id().unwrap()).unwrap();
    assert_eq!(s.last_run.unwrap().outcome, Outcome::Failed);
}

#[test]
fn a_question_waits_for_the_answer_and_the_round_goes_on() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        if turn.index == 0 {
            turn.report(r#"{"status":"blocked","summary":"need a port","questions":[{"question":"Which port?","options":["8080","9090"]}]}"#);
        } else {
            assert!(turn.prompt.starts_with("Use 9090"), "{}", turn.prompt);
            turn.commit("port.txt", "9090\n");
            turn.done("port set");
        }
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Pick a port", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let asking = wait_stage(&w.board, "1", StageKind::Asking);
    assert_eq!(asking.status, IssueStatus::InProgress);
    assert_eq!(asking.questions[0].options, vec!["8080", "9090"]);
    let inbox = board_bundle(&w.board).inbox.items;
    assert_eq!((inbox[0].kind, inbox[0].text.as_str()), (vibevalley_protocol::InboxKind::Ask, "Which port?"));
    block_on(w.board.tell_async("1", "Use 9090")).unwrap();
    let done = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert!(done.questions.is_empty());
}

#[test]
fn questions_are_read_from_what_the_agent_said_without_a_report() {
    let script = Script::new().turn(vec![Step::text("I looked.\n\nAsk the user: keep the old API? (options: yes | no)\n")]);
    let w = world(vec![HookRuntime::new("t", script, |_| {})], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("API", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let asking = wait_stage(&w.board, "1", StageKind::Asking);
    assert_eq!(asking.questions[0].question, "keep the old API?");
}

#[test]
fn an_interrupted_round_resumes_or_completes() {
    let rt = HookRuntime::new("t", slow_first(30_000), |turn| {
        if turn.index == 0 {
            turn.commit("half.txt", "half\n");
        } else {
            assert!(turn.prompt.contains("You were interrupted"));
            turn.commit("rest.txt", "rest\n");
            turn.done("finished");
        }
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Long", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let working = wait_stage(&w.board, "1", StageKind::Working);
    assert_eq!(working.status, IssueStatus::InProgress);
    // Telling a working session steers it.
    block_on(w.board.tell_async("1", "also add docs")).unwrap();
    block_on(w.board.stop_async("1")).unwrap();
    let stuck = wait_stage(&w.board, "1", StageKind::Stuck);
    assert_eq!(stuck.stage.stuck, Some(StuckReason::Interrupted));
    assert!(!block_on(w.board.runs_async(&stuck.id)).unwrap().last().unwrap().needs_reconciliation);
    let session = board_session(&w.board, stuck.latest_session_id().unwrap()).unwrap();
    assert!(!session.last_run.unwrap().needs_reconciliation);

    assert!(stuck.moves.contains(&IssueStatus::Done), "what is there can be completed");
    assert_eq!(board_bundle(&w.board).inbox.items[0].kind, vibevalley_protocol::InboxKind::Interrupted);
    assert_eq!(block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap(), Move::Round);
    wait_stage(&w.board, "1", StageKind::Reviewing);
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert!(exists_on(&main, "main", "half.txt") && exists_on(&main, "main", "rest.txt"));
}

#[test]
fn canceling_lets_the_session_go_and_keeps_a_branch_with_work() {
    let rt = HookRuntime::new("t", slow_first(30_000), |turn| turn.commit("wip.txt", &turn.prompt));
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Doomed", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let working = wait_stage(&w.board, "1", StageKind::Working);
    let worktree = board_session(&w.board, working.latest_session_id().unwrap()).unwrap().cwd.unwrap();
    block_on(w.board.tell_async("1", "x")).unwrap();
    std::fs::write(Path::new(&worktree).join("loose.txt"), "uncommitted").unwrap();
    assert_eq!(block_on(w.board.move_to_async("1", IssueStatus::Canceled, None)).unwrap(), Move::Cancel);
    let canceled = board_issue(&w.board, "1").unwrap();
    assert_eq!((canceled.status, canceled.canceled), (IssueStatus::Canceled, Some(IssueCanceled::Dismissed)));
    assert!(board_bundle(&w.board).sessions.sessions.is_empty());
    assert!(!Path::new(&worktree).exists());
    assert!(exists_on(&main, "vibevalley/issue-1", "wip.txt") && exists_on(&main, "vibevalley/issue-1", "loose.txt"));
    // Reopened, it is sent again on the same branch.
    assert!(matches!(
        block_on(w.board.move_to_async("1", IssueStatus::Todo, None)),
        Err(BoardError::WordsRequired)
    ));
    block_on(w.board.move_to_async("1", IssueStatus::Todo, Some("try again"))).unwrap();
    wait_stage(&w.board, "1", StageKind::Working);
    block_on(w.board.stop_async("1")).unwrap();

    // Dropped before it was ever sent: nothing to let go.
    block_on(w.board.create_async(new("Never", Some(&main)))).unwrap();
    assert_eq!(block_on(w.board.move_to_async("2", IssueStatus::Canceled, None)).unwrap(), Move::Drop);
    assert_eq!(block_on(w.board.move_to_async("2", IssueStatus::Backlog, None)).unwrap(), Move::Revive);
}

#[test]
fn the_queue_waits_for_room_in_the_space_and_sends_the_next() {
    let gate = TurnGate::new();
    let rt = HookRuntime::new("t", gate.script("done"), |turn| {
        turn.commit(&format!("f{}.txt", turn.prompt.len()), "x\n");
        turn.done("ok");
    });
    let w = world(vec![rt], |c| c.space_limit = 1);
    let main = repo(w.dir.path(), "app");
    for title in ["First", "Second"] {
        block_on(w.board.create_async(new(title, Some(&main)))).unwrap();
    }
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Working);
    block_on(w.board.move_to_async("2", IssueStatus::Todo, None)).unwrap();
    let queued = board_issue(&w.board, "2").unwrap();
    assert_eq!((queued.status, queued.stage.state), (IssueStatus::Todo, StageKind::Queued));
    assert!(queued.queued_at.is_some());
    // When the first round ends there is room: the second goes by itself.
    gate.release();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    wait_stage(&w.board, "2", StageKind::Working);
    // A round for the first now finds no room, and says so.
    assert!(matches!(
        block_on(w.board.move_to_async("1", IssueStatus::Todo, Some("more"))),
        Err(BoardError::NoRoom(_))
    ));
    gate.release();
    wait_stage(&w.board, "2", StageKind::Reviewing);
    // Unqueue before it goes.
    block_on(w.board.create_async(new("Third", Some(&main)))).unwrap();
    block_on(w.board.create_async(new("Fourth", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("3", IssueStatus::Todo, Some("go"))).unwrap();
    block_on(w.board.move_to_async("4", IssueStatus::Todo, None)).unwrap();
    assert_eq!(block_on(w.board.move_to_async("4", IssueStatus::Backlog, None)).unwrap(), Move::Unqueue);
    gate.release();
    wait_stage(&w.board, "3", StageKind::Reviewing);
    block_on(w.board.refresh_queue_async()).unwrap();
    assert_eq!(board_issue(&w.board, "4").unwrap().status, IssueStatus::Backlog);
}

#[test]
fn the_per_repo_limit_holds_one_repo_back_and_not_another() {
    let gate = TurnGate::new();
    let rt = HookRuntime::new("t", gate.script("done"), |turn| turn.done("ok"));
    let w = world(vec![rt], |c| {
        c.space_limit = 5;
        c.per_repo = 1;
    });
    let a = repo(w.dir.path(), "a");
    let b = repo(w.dir.path(), "b");
    block_on(w.board.create_async(new("a1", Some(&a)))).unwrap();
    block_on(w.board.create_async(new("a2", Some(&a)))).unwrap();
    block_on(w.board.create_async(new("b1", Some(&b)))).unwrap();
    for n in ["1", "2", "3"] {
        block_on(w.board.move_to_async(n, IssueStatus::Todo, None)).unwrap();
    }
    assert_eq!(board_issue(&w.board, "1").unwrap().stage.state, StageKind::Working);
    assert_eq!(board_issue(&w.board, "2").unwrap().stage.state, StageKind::Queued);
    assert_eq!(board_issue(&w.board, "3").unwrap().stage.state, StageKind::Working);
    gate.release_n(3);
    wait_stage(&w.board, "2", StageKind::Reviewing);
    // Words for a queued issue go with it when it is sent.
}

#[test]
fn words_for_a_queued_issue_go_with_it() {
    let gate = TurnGate::new();
    let rt = HookRuntime::new("t", gate.script("done"), |turn| turn.done("ok"));
    let prompts = rt.prompts.clone();
    let w = world(vec![rt], |c| c.space_limit = 1);
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("One", Some(&main)))).unwrap();
    block_on(w.board.create_async(new("Two", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    block_on(w.board.move_to_async("2", IssueStatus::Todo, None)).unwrap();
    block_on(w.board.tell_async("2", "mind the tests")).unwrap();
    gate.release_n(2);
    wait_stage(&w.board, "2", StageKind::Reviewing);
    let all = prompts.lock().unwrap().clone();
    assert!(
        all.iter().any(|p| p.starts_with("mind the tests") && p.contains("这个任务原来是：Two")),
        "{all:?}"
    );
}

#[test]
fn a_restart_marks_a_working_session_interrupted_and_it_goes_on() {
    let rt = HookRuntime::with_later("t", slow_first(30_000), vec![quick()], |turn| {
        if turn.index == 0 && !turn.prompt.contains("taking this issue up again") {
            turn.commit("before.txt", "x\n");
        } else {
            assert!(turn.prompt.contains("git log"), "{}", turn.prompt);
            turn.commit("after.txt", "y\n");
            turn.done("carried on");
        }
    });
    let runtimes: Vec<Arc<dyn Runtime>> = vec![rt.clone()];
    let w = world(runtimes, |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Survive", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let working = wait_stage(&w.board, "1", StageKind::Working);
    let session_id = working.latest_session_id().unwrap().clone();
    // Another process cannot take the board while this one holds it.
    let busy = open_board(&w.store, w.registry.clone(), config(w.dir.path()));
    assert!(matches!(busy, Err(BoardError::Busy(_))));
    w.board.close();

    let (board, _ctx) = open_board(&w.store, w.registry.clone(), config(w.dir.path())).unwrap();
    let issue = board_issue(&board, "1").unwrap();
    assert_eq!(issue.stage.stuck, Some(StuckReason::Interrupted));
    let session = board_session(&board, &session_id).unwrap();
    assert_eq!(session.phase, Phase::resting());
    assert_eq!(session.last_run.unwrap().outcome, Outcome::Interrupted);
    assert!(!board.sessions().is_live(&session_id));
    block_on(board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let done = wait_stage(&board, "1", StageKind::Reviewing);
    assert_eq!(done.latest_session_id(), Some(&session_id), "the same session, reopened");
    block_on(board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert!(exists_on(&main, "main", "before.txt") && exists_on(&main, "main", "after.txt"));
}

#[test]
fn a_lost_worktree_cancels_its_issue_on_open() {
    let rt = HookRuntime::new("t", quick(), |turn| turn.done("ok"));
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Lost", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let issue = wait_stage(&w.board, "1", StageKind::Reviewing);
    let worktree = board_session(&w.board, issue.latest_session_id().unwrap()).unwrap().cwd.unwrap();
    w.board.close();
    std::fs::remove_dir_all(&worktree).unwrap();
    let (board, _ctx) = open_board(&w.store, w.registry.clone(), config(w.dir.path())).unwrap();
    let lost = board_issue(&board, "1").unwrap();
    assert_eq!((lost.status, lost.canceled), (IssueStatus::Canceled, Some(IssueCanceled::Lost)));
    assert!(board_bundle(&board).sessions.sessions.is_empty());
}

#[test]
fn a_merge_conflict_stays_in_review_and_resolve_sends_it_back() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        if turn.index == 0 {
            turn.commit("README.md", "from the branch\n");
            turn.done("changed the readme");
        } else {
            assert!(turn.prompt.contains("conflicts with main"), "{}", turn.prompt);
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&turn.cwd)
                .args(["merge", "-q", "-X", "ours", "main", "-m", "merge main"])
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            turn.done("resolved");
        }
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Readme", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    std::fs::write(main.join("README.md"), "from main\n").unwrap();
    git(&main, &["commit", "-q", "-am", "main moves on"]);
    assert_eq!(board_changes(&w.board, "1").unwrap().conflicts, vec![std::path::PathBuf::from("README.md")]);

    match block_on(w.board.move_to_async("1", IssueStatus::Done, None)) {
        Err(BoardError::NotDelivered(Undelivered::Conflict { base, files })) => {
            assert_eq!((base.as_str(), files), ("main", vec!["README.md".to_string()]));
        }
        other => panic!("{other:?}"),
    }
    let conflicted = board_issue(&w.board, "1").unwrap();
    assert_eq!(
        (conflicted.status, conflicted.stage.stuck),
        (IssueStatus::InReview, Some(StuckReason::Conflict))
    );
    assert_eq!(board_bundle(&w.board).inbox.items[0].kind, vibevalley_protocol::InboxKind::Conflict);
    // Resolve: back to its session with the server's words.
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let resolved = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert!(resolved.conflict.is_none());
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert_eq!(board_issue(&w.board, "1").unwrap().delivered, Some(Landing::Merged));
    assert_eq!(std::fs::read_to_string(main.join("README.md")).unwrap(), "from the branch\n");
}

#[test]
fn a_failing_check_sends_the_work_back_with_the_output_tail() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        if turn.index == 0 {
            turn.commit("code.txt", "code\n");
        } else {
            assert!(turn.prompt.contains("The project check failed"), "{}", turn.prompt);
            assert!(turn.prompt.contains("ok.txt is missing"), "{}", turn.prompt);
            turn.commit("ok.txt", "ok\n");
        }
        turn.done("done");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    std::fs::create_dir_all(main.join(".vibevalley")).unwrap();
    std::fs::write(
        main.join(".vibevalley/check"),
        "#!/bin/sh\ntest -f ok.txt || { echo ok.txt is missing; exit 1; }\n",
    )
    .unwrap();
    git(&main, &["add", "."]);
    git(&main, &["commit", "-q", "-m", "a check (not executable: run through sh)"]);
    block_on(w.board.create_async(new("Checked", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    match block_on(w.board.move_to_async("1", IssueStatus::Done, None)) {
        Err(BoardError::NotDelivered(Undelivered::CheckFailed { output, sent_back })) => {
            assert!(sent_back);
            assert_eq!(output, "ok.txt is missing");
        }
        other => panic!("{other:?}"),
    }
    let back = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(board_session(&w.board, back.latest_session_id().unwrap()).unwrap().runs, 2);
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert!(exists_on(&main, "main", "ok.txt"));
}

#[test]
fn regression_review_keeps_the_seen_tree_and_records_the_delivered_commit() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.write("first.txt", "review me");
        turn.done("ready");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Review the content", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    let first = board_changes(&w.board, "1").unwrap();
    assert_eq!(first.files.len(), 1, "the displayed patch includes uncommitted files");
    assert_eq!(first.uncommitted[0].new_path.as_deref(), Some(Path::new("first.txt")));
    block_on(w.board.review_async("1", true, &[], "", Some(&first.revision))).unwrap();
    std::fs::write(first.worktree.join("second.txt"), "new edit").unwrap();
    assert!(block_on(w.board.review_async("1", true, &[], "", Some(&first.revision))).is_err());
    assert!(block_on(w.board.move_to_async("1", IssueStatus::Done, None)).is_err());
    assert!(!main.join("first.txt").exists());
    let next = board_changes(&w.board, "1").unwrap();
    let added = next.since_review.unwrap();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].new_path.as_deref(), Some(Path::new("second.txt")));
    block_on(w.board.review_async("1", true, &[], "", Some(&next.revision))).unwrap();
    assert!(
        block_on(w.board.move_reviewed_async("1", IssueStatus::Done, None, Some(&first.revision))).is_err(),
        "a stale completion cannot adopt another reviewer's pass"
    );
    std::fs::write(main.join("unrelated"), "another issue").unwrap();
    git(&main, &["add", "unrelated"]);
    git(&main, &["commit", "-qm", "advance the target"]);
    let target = git(&main, &["rev-parse", "HEAD"]);
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();

    w.board.close();
    let (board, _ctx) = open_board(&w.store, w.registry.clone(), config(w.dir.path())).unwrap();
    let archived = block_on(board.changes_since_async("1", Some(&first.revision.tree))).unwrap();
    assert_eq!(archived.revision, next.revision);
    assert_eq!(archived.files.len(), 2);
    assert_eq!(archived.since_review.unwrap().len(), 1);
    let delivery = board_issue(&board, "1").unwrap().delivery_evidence.unwrap();
    assert_eq!(
        delivery.reviews.iter().map(|r| &r.revision).collect::<Vec<_>>(),
        [&first.revision, &next.revision]
    );
    let check = delivery.check.unwrap();
    assert_eq!(check.target_commit, target);
    assert_eq!(check.source_tree, next.revision.tree);
    assert_eq!(check.candidate_tree, git(&main, &["rev-parse", "HEAD^{tree}"]));
    assert_eq!(check.status, vibevalley_protocol::ProjectCheckStatus::NotConfigured);
    assert_eq!(check.command, None);
    assert_eq!(delivery.merged_commit.as_deref(), Some(check.candidate_commit.as_str()));
    assert_eq!(check.candidate_commit, git(&main, &["rev-parse", "HEAD"]));
}

#[test]
fn regression_reopen_recognizes_an_already_published_candidate_without_running_git_again() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.commit("work", "reviewed");
        turn.done("ready");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Recover delivery", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    let mut db = inspect_db(&w.store);
    execute_sql(
        &mut db,
        "create trigger stop_delivery before insert on issue when new.delivered = 'merged' begin select raise(fail, 'stop after Git accepted the commit'); end;",
    );
    let err = block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap_err();
    assert!(err.to_string().contains("stop after Git"), "{err}");
    let head = git(&main, &["rev-parse", "HEAD"]);
    assert_eq!(git(&main, &["show", "HEAD:work"]), "reviewed");
    assert!(!branch_exists(&main, "vibevalley/issue-1"));
    w.board.close();
    execute_sql(&mut db, "drop trigger stop_delivery");
    let (board, _ctx) = open_board(&w.store, w.registry.clone(), config(w.dir.path())).unwrap();
    let restored = board_issue(&board, "1").unwrap();
    assert_eq!(restored.status, IssueStatus::Done);
    assert_eq!(restored.delivery_evidence.unwrap().merged_commit.as_deref(), Some(head.as_str()));
    assert_eq!(git(&main, &["rev-parse", "HEAD"]), head);
}

#[test]
fn regression_project_check_runs_on_the_combined_tree_before_delivery() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.commit("jobs", if turn.index == 0 { "2" } else { "1" });
        turn.done("updated jobs");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    std::fs::create_dir(main.join(".vibevalley")).unwrap();
    std::fs::write(
        main.join(".vibevalley/check"),
        r#"test "$(cat jobs)" -le "$(cat limit)" || { echo "too many jobs"; exit 1; }"#,
    )
    .unwrap();
    std::fs::write(main.join("jobs"), "1").unwrap();
    std::fs::write(main.join("limit"), "2").unwrap();
    git(&main, &["add", "."]);
    git(&main, &["commit", "-qm", "initial capacity"]);
    block_on(w.board.create_async(new("Increase jobs", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let reviewing = wait_stage(&w.board, "1", StageKind::Reviewing);
    let session = board_session(&w.board, reviewing.latest_session_id().unwrap()).unwrap();
    let worktree = Path::new(session.cwd.as_ref().unwrap());
    std::fs::write(main.join("limit"), "1").unwrap();
    git(&main, &["commit", "-qam", "decrease capacity"]);
    let target = git(&main, &["rev-parse", "HEAD"]);
    for dir in [&*main, worktree] {
        assert!(
            std::process::Command::new("sh")
                .arg(".vibevalley/check")
                .current_dir(dir)
                .status()
                .unwrap()
                .success()
        );
    }

    let result = block_on(w.board.move_to_async("1", IssueStatus::Done, None));
    assert!(
        matches!(result, Err(BoardError::NotDelivered(Undelivered::CheckFailed { ref output, .. })) if output == "too many jobs"),
        "{result:?}"
    );
    let failed = board_issue(&w.board, "1").unwrap().delivery_evidence.unwrap().check.unwrap();
    assert_eq!(failed.status, vibevalley_protocol::ProjectCheckStatus::Failed);
    assert_eq!(failed.output.as_deref(), Some("too many jobs"));
    assert_eq!(git(&main, &["rev-parse", "HEAD"]), target);
    assert_eq!(std::fs::read_to_string(main.join("jobs")).unwrap(), "1");
    wait_stage(&w.board, "1", StageKind::Reviewing);
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert_eq!(board_issue(&w.board, "1").unwrap().delivered, Some(Landing::Merged));
    assert_eq!(std::fs::read_to_string(main.join("limit")).unwrap(), "1");
}

#[test]
fn an_answer_issue_is_acknowledged_with_its_conclusion() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.report(r#"{"status":"done","summary":"found it","answer":{"conclusion":"It is 42.","evidence":["README.md:1"]}}"#);
    });
    let w = world(vec![rt], |_| {});
    let issue = block_on(w.board.create_async(NewIssue {
        deliver: Deliverable::Answer,
        ..new("What is it?", None)
    }))
    .unwrap();
    assert_eq!(issue.deliver, Deliverable::Answer);
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let reviewing = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(reviewing.answer.as_ref().unwrap().conclusion, "It is 42.");
    assert_eq!(reviewing.stage.lead, Some(vibevalley_protocol::IssueAct::Acknowledge));
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert_eq!(board_issue(&w.board, "1").unwrap().delivered, Some(Landing::None));
}

#[test]
fn an_answer_issue_in_a_repo_without_a_conclusion_is_stuck() {
    let rt = HookRuntime::new("t", Script::new().turn(vec![]), |_| {});
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    let mut ask = new("Why?", Some(&main));
    ask.deliver = Deliverable::Answer;
    block_on(w.board.create_async(ask)).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let stuck = wait_stage(&w.board, "1", StageKind::Stuck);
    assert_eq!(stuck.stage.stuck, Some(StuckReason::Failed));
}

#[test]
fn a_branch_issue_keeps_its_branch() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.commit("b.txt", "b\n");
        turn.done("ok");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    let mut b = new("Branch only", Some(&main));
    b.deliver = Deliverable::Branch;
    block_on(w.board.create_async(b)).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    assert_eq!(board_issue(&w.board, "1").unwrap().delivered, Some(Landing::Kept));
    assert!(exists_on(&main, "vibevalley/issue-1", "b.txt") && !exists_on(&main, "main", "b.txt"));
}

#[test]
fn a_quiet_session_is_stuck_until_it_speaks() {
    let gate = TurnGate::new();
    let rt = HookRuntime::new("t", gate.script("back"), |turn| turn.done("ok"));
    let w = world(vec![rt], |c| c.quiet_after = Duration::from_millis(25));
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Quiet", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    let quiet = wait_issue(&w.board, "1", "quiet", |t| t.stage.stuck == Some(StuckReason::Quiet));
    assert_eq!(quiet.status, IssueStatus::InProgress);
    assert_eq!(board_bundle(&w.board).inbox.items[0].kind, vibevalley_protocol::InboxKind::Quiet);
    gate.release();
    wait_stage(&w.board, "1", StageKind::Reviewing);
}

#[test]
fn permission_requests_are_allowed_when_prompts_are_off() {
    let script = Script::new().turn(vec![
        Step::Permission {
            request_id: "p1".into(),
            tool: "Write".into(),
            input: serde_json::json!({}),
            summary: "write".into(),
            denied: vec![Step::text("denied")],
        },
        Step::text("allowed"),
    ]);
    let w = world(vec![HookRuntime::new("t", script, |turn| turn.done("ok"))], |c| {
        c.permission = PermissionMode::Bypass;
    });
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Ask first", Some(&main)))).unwrap();
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
}

#[test]
fn snapshot_reads_stored_issues() {
    let rt = HookRuntime::new("t", quick(), |turn| turn.done("ok"));
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    for n in 0..5 {
        block_on(w.board.create_async(new(&format!("n{n}"), Some(&main)))).unwrap();
    }
    let snapshot = block_on(Board::snapshot_async(&w.store)).unwrap();
    assert_eq!(snapshot.board.issues.len(), 5);
}

#[test]
fn a_queued_issue_waits_for_the_issue_it_is_blocked_by() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.commit(&format!("{}.txt", turn.prompt.lines().next().unwrap().len()), "x\n");
        turn.done("ok");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    block_on(w.board.create_async(new("Base", Some(&main)))).unwrap();
    let mut after = new("After", Some(&main));
    after.blocked_by = vec!["1".into()];
    block_on(w.board.create_async(after)).unwrap();
    block_on(w.board.move_to_async("2", IssueStatus::Todo, None)).unwrap();
    assert_eq!(board_issue(&w.board, "2").unwrap().stage.state, StageKind::Queued);
    block_on(w.board.move_to_async("1", IssueStatus::Todo, None)).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    block_on(w.board.refresh_queue_async()).unwrap();
    assert_eq!(board_issue(&w.board, "2").unwrap().stage.state, StageKind::Queued, "in review is not done");
    block_on(w.board.move_to_async("1", IssueStatus::Done, None)).unwrap();
    wait_stage(&w.board, "2", StageKind::Reviewing);
    // A cycle is refused.
    let mut circle = new("Circle", Some(&main));
    circle.parent = Some("2".into());
    circle.blocked_by = vec!["2".into()];
    assert!(block_on(w.board.create_async(circle)).is_err());
}
