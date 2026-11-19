//! Ported from VibeValley `apps/server/src/modules/issue/moves.test.ts`,
//! plus checks of the inbox, board order and the core.

use crate::*;

fn assigned(sessions: &[&str]) -> Vec<Assignment> {
    vec![Assignment {
        id: "a1".into(),
        agent: "lab".into(),
        assigned_at: 0,
        ended_at: None,
        executions: sessions
            .iter()
            .map(|s| Execution { session: s.to_string(), started_at: 0, in_process: false })
            .collect(),
    }]
}

fn reviewing() -> Stage {
    Stage { state: StageKind::Reviewing, since: None, stuck: None, lead: None, acts: vec![] }
}

fn stuck_stage(reason: StuckReason) -> Stage {
    Stage { state: StageKind::Stuck, since: None, stuck: Some(reason), lead: None, acts: vec![] }
}

fn issue(status: IssueStatus, sent: bool) -> Issue {
    let mut t = Issue::new("t1", 1, "Task", 0);
    t.status = status;
    t.assignments = if sent { assigned(&["w1"]) } else { vec![] };
    t.stage = reviewing();
    t
}

fn ran(status: IssueStatus, outcome: Outcome) -> Issue {
    let mut t = issue(status, false);
    t.last_run = Some(IssueLastRun { started_at: 1, ended_at: Some(2), outcome: Some(outcome) });
    t
}

use IssueStatus::*;

#[test]
fn where_each_status_may_go() {
    for (from, sent, to) in [
        (Backlog, false, vec![Todo, Canceled]),
        (Todo, false, vec![Backlog, Canceled]),
        (InProgress, true, vec![Canceled]),
        (InReview, true, vec![Todo, Done, Canceled]),
        (Done, true, vec![Todo]),
        (Canceled, true, vec![Todo]),
        (Canceled, false, vec![Backlog]),
    ] {
        let t = issue(from, sent);
        assert_eq!(status_moves(&t), to, "{from:?}");
        for s in IssueStatus::ALL {
            // Every refusal has a reason; every move is a move.
            let _ = status_move(&t, s);
        }
    }
    let mut drafting = issue(Backlog, false);
    drafting.refining = Some(IssueRefining { session: "w2".into(), name: "试验田".into() });
    assert_eq!(status_moves(&drafting), vec![Canceled]);
    assert_eq!(status_move(&drafting, Todo), Err(Refusal::Drafting { name: "试验田".into() }));
    let mut in_process = issue(InProgress, false);
    in_process.last_run = Some(IssueLastRun { started_at: 1, ended_at: None, outcome: None });
    assert_eq!(status_moves(&in_process), vec![Canceled]);
}

#[test]
fn a_round_that_failed_is_not_completed() {
    let mut failed = issue(InReview, true);
    failed.stage = stuck_stage(StuckReason::Failed);
    assert_eq!(status_moves(&failed), vec![Todo, Canceled]);
    assert_eq!(status_move(&failed, Done), Err(Refusal::Failed));
    let mut interrupted = issue(InReview, true);
    interrupted.stage = stuck_stage(StuckReason::Interrupted);
    assert_eq!(status_moves(&interrupted), vec![Todo, Done, Canceled]);
}

#[test]
fn an_issue_run_by_no_session_goes_by_the_same_table() {
    assert_eq!(status_moves(&ran(InReview, Outcome::Completed)), vec![Todo, Done, Canceled]);
    assert_eq!(status_move(&ran(InReview, Outcome::Completed), Done), Ok(Move::Complete));
    let mut failed = ran(InReview, Outcome::Completed);
    failed.stage = stuck_stage(StuckReason::Failed);
    assert_eq!(status_moves(&failed), vec![Todo, Canceled]);
    let mut done = ran(Done, Outcome::Completed);
    done.delivered = Some(Landing::None);
    assert_eq!(status_moves(&done), vec![Todo]);
    let mut canceled = ran(Canceled, Outcome::Completed);
    canceled.canceled = Some(IssueCanceled::Dismissed);
    assert_eq!(status_moves(&canceled), vec![Todo]);
}

fn worker(outcome: Outcome) -> Session {
    let mut s = Session::worker("w1", "Helper", 0);
    s.agent = "lab".into();
    s.runtime = "claude".into();
    s.brief = "Task".into();
    s.runs = 1;
    s.phase = Phase::Done;
    s.last_run = Some(LastRun { needs_reconciliation: false, outcome, summary: "Result".into(), at: 1, answer: None });
    s
}

fn seed() -> Issue {
    let mut t = Issue::new("t1", 1, "Task", 0);
    t.assignments = assigned(&["w1"]);
    t
}

#[test]
fn questions_and_failed_runs_stay_in_progress_with_recovery_actions() {
    for outcome in [Outcome::Failed, Outcome::Interrupted, Outcome::Completed] {
        let mut t = seed();
        if outcome == Outcome::Completed {
            t.questions = vec![Question { question: "Which scope?".into(), options: vec![] }];
        }
        let mut issues = vec![t];
        with_issue_statuses(&mut issues, &[worker(outcome)]);
        assert_eq!(issues[0].status, InProgress, "{outcome:?}");
        let lead = match outcome {
            Outcome::Failed => Act::Cure,
            Outcome::Interrupted => Act::Resume,
            Outcome::Completed => Act::Answer,
        };
        assert_eq!(issues[0].stage.lead, Some(lead), "{outcome:?}");

        let mut delivered = worker(outcome);
        delivered.last_run = Some(LastRun { needs_reconciliation: false, outcome: Outcome::Completed, summary: "Delivered".into(), at: 2, answer: None });
        let mut issues = vec![seed()];
        with_issue_statuses(&mut issues, std::slice::from_ref(&delivered));
        assert_eq!(issues[0].status, InReview);

        let mut resting = delivered;
        resting.phase = Phase::Resting;
        with_issue_statuses(&mut issues, &[resting]);
        assert_eq!(issues[0].status, InProgress);
    }
}

fn base() -> Issue {
    let mut t = seed();
    t.status = InReview;
    t
}

fn answered_worker() -> Session {
    let mut s = worker(Outcome::Completed);
    s.last_run.as_mut().unwrap().answer =
        Some(IssueAnswer { conclusion: "慢在读配置".into(), evidence: vec!["clock.ts:1".into()] });
    s
}

#[test]
fn an_answer_issue_waits_on_a_conclusion_it_can_read() {
    let mut answer = base();
    answer.deliver = Deliverable::Answer;
    let unread = issue_stage_of(&answer, Some(&worker(Outcome::Completed)));
    assert_eq!((unread.state, unread.stuck, unread.lead), (StageKind::Stuck, Some(StuckReason::Failed), Some(Act::Cure)));
    let read = issue_stage_of(&answer, Some(&answered_worker()));
    let acts: Vec<Act> = read.acts.iter().map(Action::act).collect();
    assert_eq!(read.state, StageKind::Reviewing);
    assert_eq!(read.lead, Some(Act::Acknowledge));
    assert_eq!(acts, vec![Act::Acknowledge, Act::Reject, Act::Tell, Act::Close]);
    let change = issue_stage_of(&base(), Some(&worker(Outcome::Completed)));
    assert_eq!((change.state, change.lead), (StageKind::Reviewing, Some(Act::Complete)));
}

#[test]
fn a_button_that_moves_is_a_move_the_table_allows() {
    let in_process = |outcome| {
        let mut t = base();
        t.assignments = vec![];
        t.deliver = Deliverable::Answer;
        t.last_run = Some(IssueLastRun { started_at: 1, ended_at: Some(2), outcome: Some(outcome) });
        t
    };
    let reviewed = Issue { reviewed_at: Some(5), ..base() };
    let branch = Issue { deliver: Deliverable::Branch, ..base() };
    let answer = Issue { deliver: Deliverable::Answer, ..base() };
    let cases: Vec<(Issue, Option<Session>)> = vec![
        (base(), Some(worker(Outcome::Completed))),
        (base(), Some(worker(Outcome::Failed))),
        (base(), Some(worker(Outcome::Interrupted))),
        (reviewed, Some(worker(Outcome::Completed))),
        (branch, Some(worker(Outcome::Completed))),
        (answer.clone(), Some(worker(Outcome::Completed))),
        (answer, Some(answered_worker())),
        (in_process(Outcome::Completed), None),
        (in_process(Outcome::Failed), None),
        (in_process(Outcome::Interrupted), None),
    ];
    for (t, s) in cases {
        let stage = issue_stage_of(&t, s.as_ref());
        let moves = status_moves(&Issue { stage: stage.clone(), ..t.clone() });
        let offered = stage.acts.iter().any(|a| matches!(a, Action::Move { status: Done, .. }));
        assert_eq!(offered, moves.contains(&Done), "{t:?}");
        for a in &stage.acts {
            if let Action::Move { status, act, .. } = a {
                assert!(moves.contains(status), "{act:?} → {status:?} not allowed for {t:?}");
            }
        }
    }
}

fn working(since: Millis, quiet: Option<Millis>) -> Phase {
    Phase::Working { since, doing: String::new(), quiet_since: quiet }
}

#[test]
fn reduce_changes_the_moves_when_the_round_fails() {
    let mut hired = Session::worker("w1", "阿狐", 1);
    hired.runs = 1;
    hired.issue = Some("t1".into());
    hired.phase = working(1, None);
    let mut t = seed();
    t.status = InProgress;
    let mut state = SpaceState::default();
    for fact in [
        Fact::SessionChanged { at: 1, session: hired },
        Fact::IssueChanged { at: 1, issue: t },
        Fact::SessionReported {
            at: 2,
            id: "w1".into(),
            outcome: Outcome::Completed,
            summary: "做完了".into(),
            runs: 1,
            answer: None,
            resting: false,
        },
    ] {
        assert!(reduce(&mut state, &fact));
    }
    assert!(state.issues[0].moves.contains(&Done));

    let phase = |p| Fact::SessionPhaseChanged { at: 2, id: "w1".into(), phase: p, brief: None };
    reduce(&mut state, &phase(working(2, None)));
    reduce(&mut state, &phase(working(2, Some(2))));
    let st = &state.issues[0].stage;
    assert_eq!((st.state, st.stuck, st.since), (StageKind::Stuck, Some(StuckReason::Quiet), Some(2)));
    reduce(&mut state, &phase(working(2, None)));
    assert_eq!(state.issues[0].stage.state, StageKind::Working);
    // Only `doing` changed: no recompute, and the same fact twice is no change.
    let doing = Fact::SessionPhaseChanged {
        at: 2,
        id: "w1".into(),
        phase: Phase::Working { since: 2, doing: "reading".into(), quiet_since: None },
        brief: None,
    };
    assert!(reduce(&mut state, &doing));
    assert!(!reduce(&mut state, &doing));

    reduce(
        &mut state,
        &Fact::SessionReported {
            at: 3,
            id: "w1".into(),
            outcome: Outcome::Failed,
            summary: "没做成".into(),
            runs: 2,
            answer: None,
            resting: false,
        },
    );
    assert_eq!(state.issues[0].moves, vec![Todo, Canceled]);
}

#[test]
fn the_inbox_lists_what_waits_on_the_user_and_ids_stay_stable() {
    let mut core = Core::new();
    let mut s = worker(Outcome::Completed);
    s.issue = Some("t1".into());
    let mut t = seed();
    t.title = "Fix the clock".into();
    core.apply([Fact::SessionChanged { at: 1, session: s.clone() }, Fact::IssueChanged { at: 1, issue: t.clone() }]);
    let frame = core.frame();
    assert_eq!(frame.seq, 1);
    assert_eq!(frame.inbox.len(), 1);
    assert_eq!(frame.inbox[0].kind, InboxKind::Review);
    assert_eq!(frame.inbox[0].id, "w1:review:1");
    assert_eq!(frame.inbox[0].who.as_deref(), Some("Helper"));

    // A question turns the need into an ask; answering clears it.
    t.questions = vec![Question { question: "Which time zone?".into(), options: vec![] }];
    core.apply([Fact::IssueChanged { at: 2, issue: t.clone() }]);
    let ask = &core.frame().inbox[0];
    assert_eq!((ask.kind, ask.text.as_str()), (InboxKind::Ask, "Which time zone?"));

    let seen: std::collections::HashSet<String> = core.frame().inbox.iter().map(|i| i.id.clone()).collect();
    assert!(fresh(&core.frame().inbox, &seen).is_empty());

    // Nothing changes: no new seq.
    assert!(core.apply([Fact::IssueChanged { at: 3, issue: t }]).is_empty());
    assert_eq!(core.seq(), 2);
}

#[test]
fn a_parent_whose_children_closed_waits_for_review_in_the_inbox() {
    let parent = Issue::new("p", 1, "Big job", 0);
    let mut child = Issue::new("c", 2, "Part", 1);
    child.parent = Some("p".into());
    child.delivered = Some(Landing::MergedIntoParent);
    child.closed_at = Some(5);
    let mut core = Core::new();
    core.apply([Fact::IssueChanged { at: 0, issue: parent }, Fact::IssueChanged { at: 5, issue: child }]);
    let p = core.state().issues.iter().find(|t| t.id == "p").unwrap();
    assert_eq!(p.status, InReview);
    let inbox = core.frame().inbox;
    assert_eq!(inbox.len(), 1);
    assert_eq!((inbox[0].kind, inbox[0].at), (InboxKind::Review, 5));
    assert_eq!(inbox[0].target, Target::Issue { id: "p".into() });
}

#[test]
fn board_order_and_closed_issue_limit() {
    let mut all = Vec::new();
    let mut a = Issue::new("a", 1, "a", 10);
    a.rank = Some(2);
    let mut b = Issue::new("b", 2, "b", 20);
    b.rank = Some(1);
    let mut sent = Issue::new("s", 3, "s", 5);
    sent.assignments = assigned(&["w9"]);
    for t in [a, b, sent] {
        with_issue(&mut all, t);
    }
    let order: Vec<&str> = all.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(order, vec!["b", "a", "s"], "unsent by rank first, sent ones after");

    let mut all = Vec::new();
    for n in 0..(KEEP_CLOSED_ISSUES as i64 + 5) {
        let mut t = Issue::new(format!("x{n}"), n as u64, "x", n);
        t.closed_at = Some(n);
        t.delivered = Some(Landing::Merged);
        with_issue(&mut all, t);
    }
    assert_eq!(all.len(), KEEP_CLOSED_ISSUES);
    assert!(all.iter().all(|t| t.closed_at.unwrap() >= 5), "the oldest closed ones go");
}

#[test]
fn room_counts_busy_sessions_in_the_space_and_the_repo() {
    let mut a = Session::worker("a", "a", 0);
    a.repo = Some("r1".into());
    a.phase = working(0, None);
    let mut b = Session::worker("b", "b", 0);
    b.repo = Some("r2".into());
    b.phase = working(0, None);
    let idle = Session::worker("c", "c", 0);
    let sessions = vec![a, b, idle];
    assert_eq!(room_left(&sessions, "r1", 6, 3, ""), (4, 2));
    assert_eq!(room_left(&sessions, "r1", 6, 3, "a"), (5, 3));
    assert_eq!(room_left(&sessions, "r1", 2, 0, ""), (0, usize::MAX));
}

#[test]
fn frames_serialize_for_the_view_layer() {
    let mut core = Core::new();
    core.apply([Fact::IssueChanged { at: 0, issue: Issue::new("t", 1, "标题", 0) }]);
    let json = serde_json::to_value(core.frame()).unwrap();
    assert_eq!(json["issues"][0]["status"], "backlog");
    assert_eq!(json["issues"][0]["stage"]["state"], "draft");
    assert_eq!(json["issues"][0]["stage"]["acts"][0]["does"], "move");
    let back: Frame = serde_json::from_value(json).unwrap();
    assert_eq!(back, core.frame());
}
