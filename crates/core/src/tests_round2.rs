//! Second-round rules. Translated from VibeValley
//! `modules/issue/dependencies.test.ts`, `merge.test.ts`, `recorded.test.ts` (drafts),
//! `session/report.test.ts` and `watch/watch.test.ts` (summaryOf); plus checks of `child_checks`.

use vibevalley_protocol::*;

use crate::deps::*;
use crate::pr::*;
use crate::prompts::work_constraints;
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

#[test]
fn work_constraints_formats_scope_check_and_acceptance() {
    let seed = IssueConstraints {
        acceptance: true,
        check: Some("sh check.sh".into()),
        scope: vec!["crates/core".into()],
    };
    let text = work_constraints(Some(&seed), &[]);
    assert!(text.contains("crates/core"));
    assert!(text.contains("sh check.sh") && text.contains("检查应当失败"));
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
fn a_pull_request_carries_the_work_when_one_is_open_or_the_repo_goes_by_them() {
    let mut t = Issue::new("t", 1, "t", 0);
    assert!(!goes_by_pull_request(&t, false));
    assert!(goes_by_pull_request(&t, true));
    t.pull_request = Some(open_pr(PullRequestState::Open));
    assert!(goes_by_pull_request(&t, false));
    t.pull_request = Some(open_pr(PullRequestState::Merged));
    assert!(!goes_by_pull_request(&t, false));
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
