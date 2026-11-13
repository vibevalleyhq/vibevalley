//! Second-round rules. Translated from VibeValley
//! `modules/issue/dependencies.test.ts`, `merge.test.ts`, `landing.test.ts`,
//! `github.test.ts` (checksVerdict), `recorded.test.ts` (drafts),
//! `session/report.test.ts` and `watch/watch.test.ts` (summaryOf) and
//! `watch/patrol.test.ts`; plus checks of `child_checks`.

use std::collections::HashMap;

use vibevalley_protocol::*;

use crate::core::empty_space_state;
use crate::deps::*;
use crate::patrol::*;
use crate::pr::*;
use crate::refine::*;
use crate::text::*;

fn node(id: &str, after: &[&str]) -> DagNode {
    DagNode {
        id: id.into(),
        after: after.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn regression_a_child_cannot_wait_for_the_parent_that_must_wait_for_it() {
    let parent = ("parent".to_string(), None, vec![]);
    let child = ("child".to_string(), Some("parent".to_string()), vec!["parent".to_string()]);
    assert_eq!(
        dependency_problems(&[parent.clone(), child]),
        vec![DagProblem::Circle {
            circle: vec!["parent".into(), "child".into()]
        }]
    );
    let free = ("child".to_string(), Some("parent".to_string()), vec![]);
    assert_eq!(dependency_problems(&[parent, free]), vec![]);
}

#[test]
fn dag_problems_in_order_and_layers() {
    assert_eq!(
        dag_problems(&[node("a", &[]), node("a", &["a", "x"])]),
        vec![
            DagProblem::Duplicate { id: "a".into() },
            DagProblem::SelfLoop { id: "a".into() },
            DagProblem::Missing {
                id: "a".into(),
                other: "x".into()
            },
        ]
    );
    let nodes = [node("a", &[]), node("b", &["a"]), node("c", &["a", "b"]), node("d", &[])];
    assert_eq!(dag_problems(&nodes), vec![]);
    assert_eq!(dag_layers(&nodes), vec![vec!["a".to_string(), "d".into()], vec!["b".into()], vec!["c".into()]]);
    assert!(dag_id_valid("seed-red_1"));
    assert!(!dag_id_valid("-x") && !dag_id_valid("") && !dag_id_valid("ü") && !dag_id_valid(&"a".repeat(33)));
}

fn with_status(id: &str, status: IssueStatus) -> Issue {
    let mut t = Issue::new(id, 1, id, 0);
    t.status = status;
    t
}

#[test]
fn dependencies_release_only_when_completed_or_canceled_missing_issues_remain_blocking() {
    let mut issue = Issue::new("x", 9, "x", 0);
    issue.blocked_by = vec!["done".into(), "canceled".into(), "review".into(), "missing".into()];
    let all = [
        with_status("done", IssueStatus::Done),
        with_status("canceled", IssueStatus::Canceled),
        with_status("review", IssueStatus::InReview),
    ];
    assert_eq!(blocked_issues(&issue, &all), vec!["review".to_string(), "missing".into()]);
}

fn child(id: &str, blocked_by: &[&str], status: IssueStatus, c: Option<IssueConstraints>) -> Issue {
    let mut t = with_status(id, status);
    t.parent = Some("p".into());
    t.blocked_by = blocked_by.iter().map(|s| s.to_string()).collect();
    t.constraints = c;
    t
}

#[test]
fn a_childs_checks_inherit_frozen_files_and_the_leaf_runs_every_acceptance_check() {
    let seed = IssueConstraints {
        acceptance: true,
        check: Some("sh check.sh".into()),
        frozen: vec!["check.sh".into()],
        ..Default::default()
    };
    let own = IssueConstraints {
        check: Some("cargo test".into()),
        ..Default::default()
    };
    let all = vec![
        child("seed", &[], IssueStatus::Done, Some(seed.clone())),
        child("mid", &["seed"], IssueStatus::Todo, Some(own.clone())),
        child("leaf", &["mid"], IssueStatus::Todo, None),
    ];
    assert_eq!(child_checks(&all[0], &all), CheckoutChecks::Acceptance { check: "sh check.sh".into() });
    // Someone waits for it: only its own check.
    assert_eq!(
        child_checks(&all[1], &all),
        CheckoutChecks::Plain {
            frozen: vec!["check.sh".into()],
            checks: vec!["cargo test".into()]
        }
    );
    // The end of the chain runs the acceptance ancestors' checks.
    assert_eq!(
        child_checks(&all[2], &all),
        CheckoutChecks::Plain {
            frozen: vec!["check.sh".into()],
            checks: vec!["sh check.sh".into()]
        }
    );
    let text = work_constraints(Some(&seed), &[]);
    assert!(text.contains("sh check.sh") && text.contains("must fail"));
    assert!(work_constraints(None, &["check.sh".into()]).contains("frozen"));
}

#[test]
fn a_followed_pull_requests_end_finishes_an_open_issue_that_delivers_by_merging() {
    let mut t = Issue::new("t", 1, "t", 0);
    assert!(finishes_with_pull_request(&t));
    t.closed_at = Some(1);
    assert!(!finishes_with_pull_request(&t));
    t.closed_at = None;
    t.deliver = Deliverable::PullRequest;
    assert!(!finishes_with_pull_request(&t));
}

fn open_pr(state: PullRequestState) -> PullRequest {
    PullRequest {
        url: "https://github.com/o/r/pull/1".into(),
        number: 1,
        state,
    }
}

#[test]
fn an_issues_work_goes_in_from_its_own_checkout_its_sessions_workplace_or_not_at_all() {
    let mut demo = Issue::new("t", 1, "t", 0);
    demo.repo = Some("demo".into());
    let none = Issue::new("u", 2, "u", 0);
    let checkout = LandingRoute::Checkout { repo: "demo".into() };
    assert_eq!(landing_route_of(&demo, Some("w1"), false, true, false), checkout);
    assert_eq!(landing_route_of(&demo, None, false, true, false), checkout);
    assert_eq!(
        landing_route_of(&demo, Some("w1"), true, true, false),
        LandingRoute::Merge { session: "w1".into() }
    );
    assert_eq!(landing_route_of(&none, None, false, true, false), LandingRoute::NotStarted);
    assert_eq!(
        landing_route_of(&demo, Some("w1"), false, false, false),
        LandingRoute::HelperGone { session: "w1".into() }
    );
    assert_eq!(
        landing_route_of(&demo, Some("w1"), true, false, true),
        LandingRoute::PullRequest { session: "w1".into() }
    );
    let mut with_pr = demo.clone();
    with_pr.pull_request = Some(open_pr(PullRequestState::Open));
    assert_eq!(
        landing_route_of(&with_pr, Some("w1"), true, false, false),
        LandingRoute::PullRequest { session: "w1".into() }
    );
    assert_eq!(
        landing_route_of(&none, Some("w1"), true, false, true),
        LandingRoute::Merge { session: "w1".into() }
    );
}

#[test]
fn a_pull_request_carries_the_work_when_one_is_open_or_the_repo_goes_by_them() {
    let mut t = Issue::new("t", 1, "t", 0);
    assert!(!goes_by_pull_request(&t, false));
    assert!(goes_by_pull_request(&t, true));
    t.pull_request = Some(open_pr(PullRequestState::Open));
    assert!(goes_by_pull_request(&t, false));
    t.pull_request = Some(open_pr(PullRequestState::Merged));
    assert!(!goes_by_pull_request(&t, false));
}

fn check(status: &str, conclusion: &str) -> CiCheck {
    CiCheck {
        name: format!("{status}{conclusion}"),
        status: status.into(),
        conclusion: conclusion.into(),
    }
}

#[test]
fn a_pull_requests_checks_the_failed_ones_and_whether_all_have_finished() {
    assert_eq!(
        checks_verdict(&[]),
        ChecksVerdict {
            failed: vec![],
            finished: false
        }
    );
    assert_eq!(
        checks_verdict(&[check("IN_PROGRESS", ""), check("COMPLETED", "SUCCESS")]),
        ChecksVerdict {
            failed: vec![],
            finished: false
        }
    );
    assert_eq!(
        checks_verdict(&[check("COMPLETED", "SUCCESS"), check("success", "")]),
        ChecksVerdict {
            failed: vec![],
            finished: true
        }
    );
    let failed = check("COMPLETED", "failure");
    assert_eq!(
        checks_verdict(&[failed.clone(), check("QUEUED", "")]),
        ChecksVerdict {
            failed: vec![failed],
            finished: false
        }
    );
    assert_eq!(checks_verdict(&[check("TIMED_OUT", "")]).failed.len(), 1);
}

#[test]
fn drafts_are_read_from_the_last_block() {
    let said = "Looked.\n\n```json\n{\"title\": \"old\"}\n```\n\nAsk the user: which port?\n\n```json\n\
        {\"title\": \" Drag calls issue.status \", \"why\": \"the old endpoint does nothing\", \"todo\": [\"change board.rs\", \" \"], \
        \"criteria\": \"dragging to todo starts it\", \"notDoing\": [], \"files\": [\"src/board.rs\"]}\n```\n\nDone: drafted.";
    let draft = parse_refinement(said).unwrap();
    assert_eq!(draft.title, "Drag calls issue.status");
    assert_eq!(kept(&draft.criteria), vec!["dragging to todo starts it"]);
    assert_eq!(
        refinement_description(&draft),
        "Why\nthe old endpoint does nothing\n\nTo do\n- change board.rs\n\nFiles\n- src/board.rs"
    );
    for (said, problem) in [
        ("drafted it", "no ```json block"),
        ("```json\n{title: 1}\n```", "the draft block cannot be read"),
        ("```json\n{\"why\": \"x\"}\n```", "the draft has no title"),
        ("```json\n{\"title\": \"x\", \"todo\": [1]}\n```", "the draft block cannot be read"),
    ] {
        assert!(parse_refinement(said).unwrap_err().starts_with(problem), "{said}");
    }
    let later = parse_refinement("```json\n{\"title\": \"x\"}\n```\n```\nnot json\n```").unwrap();
    assert_eq!(later.title, "x");
    assert_eq!(
        questions_from_text(said),
        vec![Question {
            question: "which port?".into(),
            options: vec![]
        }]
    );
}

#[test]
fn briefs_for_a_draft() {
    let first = refinement_brief("New issue", "", &[], &[], "dragging still calls the old endpoint", Some("board"), "");
    for want in [
        REFINEMENT_OPENING,
        "Repository: board",
        "What the user wants: dragging still calls the old endpoint",
        "```json",
        "\"criteria\"",
        "Ask the user:",
    ] {
        assert!(first.contains(want), "{want}");
    }
    let q = [Question {
        question: "Which port?".into(),
        options: vec![],
    }];
    let again = refinement_brief("T", "D", &["c".into()], &q, "8080", None, "earlier talk");
    for want in [
        "No repository is chosen",
        "The previous draft",
        "Title: T",
        "What you asked the user last time",
        "The user's answer: 8080",
        "earlier talk",
    ] {
        assert!(again.contains(want), "{want}");
    }
}

#[test]
fn questions_come_from_their_lines_with_options() {
    let said = "Some text.\n**Ask the user:** Which database? (options: SQLite | Postgres)\n- ask the user: Keep the old API?\n要问用户：端口用哪个？（选项：8080｜9090）\nAsk the user: one option (options: only)";
    assert_eq!(
        questions_from_text(said),
        vec![
            Question {
                question: "Which database?".into(),
                options: vec!["SQLite".into(), "Postgres".into()]
            },
            Question {
                question: "Keep the old API?".into(),
                options: vec![]
            },
            Question {
                question: "端口用哪个？".into(),
                options: vec!["8080".into(), "9090".into()]
            },
            Question {
                question: "one option".into(),
                options: vec![]
            },
        ]
    );
}

#[test]
fn a_summary_is_the_last_paragraphs() {
    assert!(summary_of("Looked first.\n\n**Result:** fixed, tests pass.\n\nNote: none").contains("Note: none"));
    assert_eq!(summary_of("did some things\n\n- result: done"), "did some things\n\n- result: done");
    assert_eq!(summary_of("first\n\nsecond"), "first\n\nsecond");
    let long = format!("{}\n\nlast", "x".repeat(100));
    assert_eq!(summary_of(&long), long);
    let tail = format!("start\n\n{}", "y".repeat(90));
    assert_eq!(summary_of(&tail), "y".repeat(90));
}

fn asking(at: Millis) -> SpaceState {
    let mut state = empty_space_state();
    let mut h = Session::worker("w1", "Helper", at);
    h.issue = Some("t1".into());
    h.phase = Phase::resting();
    h.last_run = Some(LastRun {
        outcome: Outcome::Completed,
        summary: "asked".into(),
        at,
        spent: None,
        answer: None,
    });
    let mut t = Issue::new("t1", 1, "t", at);
    t.status = IssueStatus::InReview;
    t.assignments = vec![Assignment {
        id: "a1".into(),
        issue: "t1".into(),
        agent: "lab".into(),
        assigned_at: at,
        ended_at: None,
        executions: vec![Execution::Worker {
            session: "w1".into(),
            started_at: at,
        }],
    }];
    t.questions = vec![Question {
        question: "which port?".into(),
        options: vec![],
    }];
    state.sessions.push(h);
    state.issues.push(t);
    crate::status::with_issue_statuses(&mut state);
    state
}

#[test]
fn the_patrol_gives_a_seen_user_two_hours_before_another_note() {
    let at = 1_000;
    let state = asking(at);
    let now = at + 16 * 60_000;
    let (out, memory) = patrol_step(&state, now, &PatrolMemory::default(), &HashMap::new());
    assert_eq!(out.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), vec!["w1:ask:0"]);
    assert_eq!(out[0].text, "Helper（w1）问了用户 1 个问题，16 分钟没人回：「which port?」");
    let seen = HashMap::from([("w1:ask:0".to_string(), now - 2 * 60_000)]);
    assert_eq!(patrol_step(&state, now, &PatrolMemory::default(), &seen).0, vec![]);
    // Not again within four hours; again after.
    assert_eq!(patrol_step(&state, now + 60_000, &memory, &HashMap::new()).0, vec![]);
    assert_eq!(patrol_step(&state, now + REPORT_AGAIN_MS, &memory, &HashMap::new()).0.len(), 1);
    // An item that left is forgotten.
    assert!(patrol_step(&empty_space_state(), now, &memory, &HashMap::new()).1.reported.is_empty());
}
