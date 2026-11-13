//! The board end to end on real temporary git repositories and the scripted
//! runtime (no quota). Each turn's hook plays the agent: it writes and
//! commits files in the worktree and writes the report.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use support::*;
use vibevalley_core::Move;
use vibevalley_issues::{Board, BoardError, NewIssue, Sent, Undelivered};
use vibevalley_oar::scripted::{Script, Step};
use vibevalley_oar::{PermissionMode, Runtime, StopReason};
use vibevalley_protocol::{Deliverable, IssueCanceled, IssueStageKind as StageKind, IssueStatus, Landing, Outcome, Phase, StuckReason};

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
    let issue = w.board.create(new("Add the feature", Some(&main))).unwrap();
    assert_eq!((issue.number, issue.status, issue.stage.state), (1, IssueStatus::Backlog, StageKind::Draft));
    assert_eq!(w.board.move_to("#1", IssueStatus::Todo, None).unwrap(), Move::Start);

    let reviewing = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(reviewing.status, IssueStatus::InReview);
    let session = w.board.session(reviewing.latest_session_id().unwrap()).unwrap();
    assert_eq!(session.phase, Phase::done());
    assert_eq!(session.last_run.as_ref().unwrap().summary, "Added feature.txt");
    assert_eq!(session.branch.as_deref(), Some("vibevalley/issue-1"));
    assert_eq!(w.board.base_branch(&session.id).as_deref(), Some("main"));
    let worktree = session.worktree.clone().unwrap();
    assert!(worktree.ends_with("worktrees/app.1"), "{worktree}");
    assert!(prompts.lock().unwrap()[0].starts_with("Add the feature"));
    assert!(prompts.lock().unwrap()[0].contains("1. it is there"));
    let inbox = w.board.frame().inbox;
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].kind, vibevalley_protocol::InboxKind::Review);

    let changes = w.board.changes("1").unwrap();
    assert_eq!(changes.commits.len(), 1);
    assert_eq!(changes.files.len(), 1);
    assert!(changes.uncommitted.is_empty() && changes.conflicts.is_empty());

    assert_eq!(w.board.move_to("1", IssueStatus::Done, None).unwrap(), Move::Complete);
    let done = w.board.issue("1").unwrap();
    assert_eq!((done.status, done.delivered), (IssueStatus::Done, Some(Landing::Merged)));
    assert!(exists_on(&main, "main", "feature.txt"));
    assert!(!Path::new(&worktree).exists(), "the worktree is removed");
    assert!(!branch_exists(&main, "vibevalley/issue-1"), "the merged branch is deleted");
    assert!(w.board.frame().state.sessions.is_empty(), "its session left");
    assert!(w.board.frame().inbox.is_empty());
}

#[test]
fn uncommitted_leftovers_go_in_with_the_rest() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.write("loose.txt", "not committed\n");
        turn.done("left it uncommitted");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    w.board.create(new("Loose", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(w.board.changes("1").unwrap().uncommitted.len(), 1);
    w.board.move_to("1", IssueStatus::Done, None).unwrap();
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
    w.board.create(new("Fragile", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let stuck = wait_stage(&w.board, "1", StageKind::Stuck);
    assert_eq!((stuck.status, stuck.stage.stuck), (IssueStatus::InProgress, Some(StuckReason::Failed)));
    assert!(!stuck.moves.contains(&IssueStatus::Done));
    assert!(matches!(w.board.move_to("1", IssueStatus::Done, None), Err(BoardError::Refused(_))));
    assert_eq!(w.board.frame().inbox[0].kind, vibevalley_protocol::InboxKind::Fix);
    // Cure: back to todo with the server's own words.
    assert_eq!(w.board.move_to("1", IssueStatus::Todo, None).unwrap(), Move::Round);
    let fixed = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(w.board.session(fixed.latest_session_id().unwrap()).unwrap().runs, 2);
    assert_eq!(vibevalley_core::rules::session_ids_of(&fixed).len(), 1, "the same session takes the next round");
}

#[test]
fn a_turn_that_errors_is_a_failed_round() {
    let script = Script::new().turn(vec![Step::text("oops"), Step::finish(StopReason::Error)]);
    let rt = HookRuntime::new("t", script, |_| {});
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    w.board.create(new("Crash", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let stuck = wait_stage(&w.board, "1", StageKind::Stuck);
    assert_eq!(stuck.stage.stuck, Some(StuckReason::Failed));
    let s = w.board.session(stuck.latest_session_id().unwrap()).unwrap();
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
    w.board.create(new("Pick a port", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let asking = wait_stage(&w.board, "1", StageKind::Asking);
    assert_eq!(asking.status, IssueStatus::InProgress);
    assert_eq!(asking.questions[0].options, vec!["8080", "9090"]);
    let inbox = w.board.frame().inbox;
    assert_eq!((inbox[0].kind, inbox[0].text.as_str()), (vibevalley_protocol::InboxKind::Ask, "Which port?"));
    w.board.tell("1", "Use 9090").unwrap();
    let done = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert!(done.questions.is_empty());
}

#[test]
fn questions_are_read_from_what_the_agent_said_without_a_report() {
    let script = Script::new().turn(vec![Step::text("I looked.\n\nAsk the user: keep the old API? (options: yes | no)\n")]);
    let w = world(vec![HookRuntime::new("t", script, |_| {})], |_| {});
    let main = repo(w.dir.path(), "app");
    w.board.create(new("API", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
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
    w.board.create(new("Long", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let working = wait_stage(&w.board, "1", StageKind::Working);
    assert_eq!(working.status, IssueStatus::InProgress);
    // Telling a working session steers it.
    w.board.tell("1", "also add docs").unwrap();
    w.board.stop("1").unwrap();
    let stuck = wait_stage(&w.board, "1", StageKind::Stuck);
    assert_eq!(stuck.stage.stuck, Some(StuckReason::Interrupted));
    assert!(stuck.moves.contains(&IssueStatus::Done), "what is there can be completed");
    assert_eq!(w.board.frame().inbox[0].kind, vibevalley_protocol::InboxKind::Interrupted);
    assert_eq!(w.board.move_to("1", IssueStatus::Todo, None).unwrap(), Move::Round);
    wait_stage(&w.board, "1", StageKind::Reviewing);
    w.board.move_to("1", IssueStatus::Done, None).unwrap();
    assert!(exists_on(&main, "main", "half.txt") && exists_on(&main, "main", "rest.txt"));
}

#[test]
fn canceling_lets_the_session_go_and_keeps_a_branch_with_work() {
    let rt = HookRuntime::new("t", slow_first(30_000), |turn| turn.commit("wip.txt", &turn.prompt));
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    w.board.create(new("Doomed", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let working = wait_stage(&w.board, "1", StageKind::Working);
    let worktree = w.board.session(working.latest_session_id().unwrap()).unwrap().worktree.unwrap();
    w.board.tell("1", "x").unwrap();
    std::fs::write(Path::new(&worktree).join("loose.txt"), "uncommitted").unwrap();
    assert_eq!(w.board.move_to("1", IssueStatus::Canceled, None).unwrap(), Move::Cancel);
    let canceled = w.board.issue("1").unwrap();
    assert_eq!((canceled.status, canceled.canceled), (IssueStatus::Canceled, Some(IssueCanceled::Dismissed)));
    assert!(w.board.frame().state.sessions.is_empty());
    assert!(!Path::new(&worktree).exists());
    assert!(exists_on(&main, "vibevalley/issue-1", "wip.txt") && exists_on(&main, "vibevalley/issue-1", "loose.txt"));
    // Reopened, it is sent again on the same branch.
    assert!(matches!(w.board.move_to("1", IssueStatus::Todo, None), Err(BoardError::WordsRequired)));
    w.board.move_to("1", IssueStatus::Todo, Some("try again")).unwrap();
    wait_stage(&w.board, "1", StageKind::Working);
    w.board.stop("1").unwrap();

    // Dropped before it was ever sent: nothing to let go.
    w.board.create(new("Never", Some(&main))).unwrap();
    assert_eq!(w.board.move_to("2", IssueStatus::Canceled, None).unwrap(), Move::Drop);
    assert_eq!(w.board.move_to("2", IssueStatus::Backlog, None).unwrap(), Move::Revive);
}

#[test]
fn the_queue_waits_for_room_in_the_space_and_sends_the_next() {
    let rt = HookRuntime::new("t", slow_first(400), |turn| {
        turn.commit(&format!("f{}.txt", turn.prompt.len()), "x\n");
        turn.done("ok");
    });
    let w = world(vec![rt], |c| c.space_limit = 1);
    let main = repo(w.dir.path(), "app");
    for title in ["First", "Second"] {
        w.board.create(new(title, Some(&main))).unwrap();
    }
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, "1", StageKind::Working);
    w.board.move_to("2", IssueStatus::Todo, None).unwrap();
    let queued = w.board.issue("2").unwrap();
    assert_eq!((queued.status, queued.stage.state), (IssueStatus::Todo, StageKind::Queued));
    assert!(queued.queued_at.is_some());
    // When the first round ends there is room: the second goes by itself.
    wait_stage(&w.board, "1", StageKind::Reviewing);
    wait_stage(&w.board, "2", StageKind::Working);
    // A round for the first now finds no room, and says so.
    assert!(matches!(w.board.move_to("1", IssueStatus::Todo, Some("more")), Err(BoardError::NoRoom(_))));
    wait_stage(&w.board, "2", StageKind::Reviewing);
    // Unqueue before it goes.
    w.board.create(new("Third", Some(&main))).unwrap();
    w.board.create(new("Fourth", Some(&main))).unwrap();
    w.board.move_to("3", IssueStatus::Todo, Some("go")).unwrap();
    w.board.move_to("4", IssueStatus::Todo, None).unwrap();
    assert_eq!(w.board.move_to("4", IssueStatus::Backlog, None).unwrap(), Move::Unqueue);
    wait_stage(&w.board, "3", StageKind::Reviewing);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(w.board.issue("4").unwrap().status, IssueStatus::Backlog);
}

#[test]
fn the_per_repo_limit_holds_one_repo_back_and_not_another() {
    let rt = HookRuntime::new("t", slow_first(400), |turn| turn.done("ok"));
    let w = world(vec![rt], |c| {
        c.space_limit = 5;
        c.per_repo = 1;
    });
    let a = repo(w.dir.path(), "a");
    let b = repo(w.dir.path(), "b");
    w.board.create(new("a1", Some(&a))).unwrap();
    w.board.create(new("a2", Some(&a))).unwrap();
    w.board.create(new("b1", Some(&b))).unwrap();
    for n in ["1", "2", "3"] {
        w.board.move_to(n, IssueStatus::Todo, None).unwrap();
    }
    assert_eq!(w.board.issue("1").unwrap().stage.state, StageKind::Working);
    assert_eq!(w.board.issue("2").unwrap().stage.state, StageKind::Queued);
    assert_eq!(w.board.issue("3").unwrap().stage.state, StageKind::Working);
    wait_stage(&w.board, "2", StageKind::Reviewing);
    // Words for a queued issue go with it when it is sent.
}

#[test]
fn words_for_a_queued_issue_go_with_it() {
    let rt = HookRuntime::new("t", slow_first(300), |turn| turn.done("ok"));
    let prompts = rt.prompts.clone();
    let w = world(vec![rt], |c| c.space_limit = 1);
    let main = repo(w.dir.path(), "app");
    w.board.create(new("One", Some(&main))).unwrap();
    w.board.create(new("Two", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    w.board.move_to("2", IssueStatus::Todo, None).unwrap();
    w.board.tell("2", "mind the tests").unwrap();
    wait_stage(&w.board, "2", StageKind::Reviewing);
    let all = prompts.lock().unwrap().clone();
    assert!(
        all.iter().any(|p| p.starts_with("mind the tests") && p.contains("这张工单原来是：Two")),
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
    w.board.create(new("Survive", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let working = wait_stage(&w.board, "1", StageKind::Working);
    let session_id = working.latest_session_id().unwrap().clone();
    // Another process cannot take the board while this one holds it.
    let busy = Board::open(w.store.clone(), w.registry.clone(), config(w.dir.path()));
    assert!(matches!(busy, Err(BoardError::Busy(_))));
    w.board.close();

    let board = Board::open(w.store.clone(), w.registry.clone(), config(w.dir.path())).unwrap();
    let issue = board.issue("1").unwrap();
    assert_eq!(issue.stage.stuck, Some(StuckReason::Interrupted));
    let session = board.session(&session_id).unwrap();
    assert_eq!(session.phase, Phase::resting());
    assert_eq!(session.last_run.unwrap().outcome, Outcome::Interrupted);
    assert!(!board.is_live(&session_id));
    board.move_to("1", IssueStatus::Todo, None).unwrap();
    let done = wait_stage(&board, "1", StageKind::Reviewing);
    assert_eq!(done.latest_session_id(), Some(&session_id), "the same session, reopened");
    board.move_to("1", IssueStatus::Done, None).unwrap();
    assert!(exists_on(&main, "main", "before.txt") && exists_on(&main, "main", "after.txt"));
}

#[test]
fn a_lost_worktree_cancels_its_issue_on_open() {
    let rt = HookRuntime::new("t", quick(), |turn| turn.done("ok"));
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    w.board.create(new("Lost", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let issue = wait_stage(&w.board, "1", StageKind::Reviewing);
    let worktree = w.board.session(issue.latest_session_id().unwrap()).unwrap().worktree.unwrap();
    w.board.close();
    std::fs::remove_dir_all(&worktree).unwrap();
    let board = Board::open(w.store.clone(), w.registry.clone(), config(w.dir.path())).unwrap();
    let lost = board.issue("1").unwrap();
    assert_eq!((lost.status, lost.canceled), (IssueStatus::Canceled, Some(IssueCanceled::Lost)));
    assert!(board.frame().state.sessions.is_empty());
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
    w.board.create(new("Readme", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    std::fs::write(main.join("README.md"), "from main\n").unwrap();
    git(&main, &["commit", "-q", "-am", "main moves on"]);
    assert_eq!(w.board.changes("1").unwrap().conflicts, vec![std::path::PathBuf::from("README.md")]);

    match w.board.move_to("1", IssueStatus::Done, None) {
        Err(BoardError::NotDelivered(Undelivered::Conflict { base, files })) => {
            assert_eq!((base.as_str(), files), ("main", vec!["README.md".to_string()]));
        }
        other => panic!("{other:?}"),
    }
    let conflicted = w.board.issue("1").unwrap();
    assert_eq!(
        (conflicted.status, conflicted.stage.stuck),
        (IssueStatus::InReview, Some(StuckReason::Conflict))
    );
    assert_eq!(w.board.frame().inbox[0].kind, vibevalley_protocol::InboxKind::Conflict);
    // Resolve: back to its session with the server's words.
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let resolved = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert!(resolved.conflict.is_none());
    w.board.move_to("1", IssueStatus::Done, None).unwrap();
    assert_eq!(w.board.issue("1").unwrap().delivered, Some(Landing::Merged));
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
    w.board.create(new("Checked", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    match w.board.move_to("1", IssueStatus::Done, None) {
        Err(BoardError::NotDelivered(Undelivered::CheckFailed { output, sent_back })) => {
            assert!(sent_back);
            assert_eq!(output, "ok.txt is missing");
        }
        other => panic!("{other:?}"),
    }
    let back = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(w.board.session(back.latest_session_id().unwrap()).unwrap().runs, 2);
    w.board.move_to("1", IssueStatus::Done, None).unwrap();
    assert!(exists_on(&main, "main", "ok.txt"));
}

#[test]
fn an_answer_issue_is_acknowledged_with_its_conclusion() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.report(r#"{"status":"done","summary":"found it","answer":{"conclusion":"It is 42.","evidence":["README.md:1"]}}"#);
    });
    let w = world(vec![rt], |_| {});
    let issue = w
        .board
        .create(NewIssue {
            deliver: Deliverable::Answer,
            ..new("What is it?", None)
        })
        .unwrap();
    assert_eq!(issue.deliver, Deliverable::Answer);
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let reviewing = wait_stage(&w.board, "1", StageKind::Reviewing);
    assert_eq!(reviewing.answer.as_ref().unwrap().conclusion, "It is 42.");
    assert_eq!(reviewing.stage.lead, Some(vibevalley_protocol::IssueAct::Acknowledge));
    w.board.move_to("1", IssueStatus::Done, None).unwrap();
    assert_eq!(w.board.issue("1").unwrap().delivered, Some(Landing::None));
}

#[test]
fn an_answer_issue_in_a_repo_without_a_conclusion_is_stuck() {
    let rt = HookRuntime::new("t", Script::new().turn(vec![]), |_| {});
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    let mut ask = new("Why?", Some(&main));
    ask.deliver = Deliverable::Answer;
    w.board.create(ask).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
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
    w.board.create(b).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    w.board.move_to("1", IssueStatus::Done, None).unwrap();
    assert_eq!(w.board.issue("1").unwrap().delivered, Some(Landing::Kept));
    assert!(exists_on(&main, "vibevalley/issue-1", "b.txt") && !exists_on(&main, "main", "b.txt"));
}

#[test]
fn a_quiet_session_is_stuck_until_it_speaks() {
    let script = Script::new().turn(vec![Step::sleep_ms(1_500), Step::text("back")]);
    let rt = HookRuntime::new("t", script, |turn| turn.done("ok"));
    let w = world(vec![rt], |c| c.quiet_after = Duration::from_millis(300));
    let main = repo(w.dir.path(), "app");
    w.board.create(new("Quiet", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    let quiet = wait_issue(&w.board, "1", "quiet", |t| t.stage.stuck == Some(StuckReason::Quiet));
    assert_eq!(quiet.status, IssueStatus::InProgress);
    assert_eq!(w.board.frame().inbox[0].kind, vibevalley_protocol::InboxKind::Quiet);
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
    w.board.create(new("Ask first", Some(&main))).unwrap();
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
}

#[test]
fn frames_reach_subscribers_newest_first() {
    let rt = HookRuntime::new("t", quick(), |turn| turn.done("ok"));
    let w = world(vec![rt], |_| {});
    let rx = w.board.subscribe();
    assert_eq!(rx.recv().unwrap().state.issues.len(), 0);
    let main = repo(w.dir.path(), "app");
    for n in 0..5 {
        w.board.create(new(&format!("n{n}"), Some(&main))).unwrap();
    }
    // Fell behind: only the newest frame waits.
    assert_eq!(rx.recv().unwrap().state.issues.len(), 5);
    assert!(rx.try_recv().is_err());
    let snapshot = Board::snapshot(&w.store).unwrap();
    assert_eq!(snapshot.state.issues.len(), 5);
}

#[test]
fn a_queued_issue_waits_for_the_issue_it_is_blocked_by() {
    let rt = HookRuntime::new("t", quick(), |turn| {
        turn.commit(&format!("{}.txt", turn.prompt.lines().next().unwrap().len()), "x\n");
        turn.done("ok");
    });
    let w = world(vec![rt], |_| {});
    let main = repo(w.dir.path(), "app");
    w.board.create(new("Base", Some(&main))).unwrap();
    let mut after = new("After", Some(&main));
    after.blocked_by = vec!["1".into()];
    w.board.create(after).unwrap();
    w.board.move_to("2", IssueStatus::Todo, None).unwrap();
    assert_eq!(w.board.issue("2").unwrap().stage.state, StageKind::Queued);
    w.board.move_to("1", IssueStatus::Todo, None).unwrap();
    wait_stage(&w.board, "1", StageKind::Reviewing);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(w.board.issue("2").unwrap().stage.state, StageKind::Queued, "in review is not done");
    w.board.move_to("1", IssueStatus::Done, None).unwrap();
    wait_stage(&w.board, "2", StageKind::Reviewing);
    // A cycle is refused.
    let mut circle = new("Circle", Some(&main));
    circle.parent = Some("2".into());
    circle.blocked_by = vec!["2".into()];
    assert!(w.board.create(circle).is_err());
}

#[allow(dead_code)]
fn sent(s: &Sent) -> bool {
    matches!(s, Sent::Working { .. })
}
