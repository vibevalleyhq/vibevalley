use std::sync::Arc;
use std::time::Duration;

use vibevalley_core::ManualClock;
use vibevalley_protocol::{BizCode, IssueFilter, IssueLastRun, IssueRequest, IssueUpdateInput, Landing, Outcome};
use vibevalley_runtime::oar::Registry;

use super::*;
use crate::context::{Context, Http, LiveState, Outbox, StateFeed, TaskGroup};
use crate::service::Service;

#[tokio::test]
async fn issue_list_uses_injected_clock_for_patrol_order() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path()).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
    let ctx = Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        vibevalley_core::system_clock(),
        http.clone(),
        http,
    ));
    let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
        .await
        .unwrap();
    let clock = ManualClock::new(1_000);

    // A parent whose children are all closed is InReview with `stage.since == None`,
    // so `pick_issues(..., clock.now_ms())` falls back to `clock.now_ms()`.
    let first = board
        .create_async(NewIssue {
            title: "no-since".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut child = board
        .create_async(NewIssue {
            title: "closed-child".into(),
            parent: Some(first.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    child.delivered = Some(Landing::Merged);
    child.closed_at = Some(900);

    let mut second = board
        .create_async(NewIssue {
            title: "explicit-since".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    second.last_run = Some(IssueLastRun {
        started_at: 4_000,
        ended_at: Some(5_000),
        outcome: Some(Outcome::Completed),
    });
    board.state().put_issues_async(&[child, second]).await.unwrap();

    let filter = IssueFilter {
        wants_user: Some(true),
        ..Default::default()
    };
    // At clock=1_000, `first` falls back to `clock.now_ms()` (1_000) < 5_000, so `first` sorts before `second`.
    let list_early = board.issue_list_endpoint_async(&filter, &clock).await.unwrap();
    let titles_early: Vec<&str> = list_early.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles_early, vec!["no-since", "explicit-since"]);

    // Advancing ManualClock past 5_000 flips the patrol ordering deterministically.
    clock.advance(Duration::from_secs(10));
    let list_late = board.issue_list_endpoint_async(&filter, &clock).await.unwrap();
    let titles_late: Vec<&str> = list_late.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles_late, vec!["explicit-since", "no-since"]);

    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn issue_attachments_create_update_closed_rejection_and_brief_paths() {
    use vibevalley_protocol::{Assignment, Execution, IssueCanceled};

    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path()).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
    let ctx = Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        vibevalley_core::system_clock(),
        http.clone(),
        http,
    ));
    let storage = crate::storage::Storage::open_async(dir.path(), ctx.clone()).await.unwrap();
    let (runtime, opened) = crate::runtime::Runtime::open_with_registry_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
        .await
        .unwrap();
    let board = Board::with_storage(ctx.clone(), runtime, opened, None, Some(storage.clone())).await.unwrap();

    let att1 = storage
        .keep_async(b"spec document bytes".to_vec(), "spec.md".into(), "text/markdown".into())
        .await
        .unwrap();
    let att2 = storage
        .keep_async(b"\x89PNG\r\n\x1a\nmock".to_vec(), "mockup.png".into(), "image/png".into())
        .await
        .unwrap();

    // Creating an issue with duplicate attachment IDs resolves & deduplicates them.
    let created = board
        .create_from_request_async(&IssueRequest {
            title: "Attach files".into(),
            description: Some("Check the attached spec.".into()),
            attachments: Some(vec![att1.id.clone(), att1.id.clone()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(created.attachments, vec![att1.clone()]);

    // Creating with an unknown attachment ID fails with NotFound.
    let missing_err = board
        .create_from_request_async(&IssueRequest {
            title: "Missing file".into(),
            attachments: Some(vec!["nonexistent-sha256".into()]),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(missing_err.biz_code, BizCode::NotFound);

    // `brief()` includes local CAS paths when attachments are non-empty.
    let with_att = board::brief(&created, std::slice::from_ref(&created), None, Some(storage.as_ref()));
    assert!(with_att.contains("Attachments:"));
    assert!(with_att.contains("spec.md"));
    assert!(with_att.contains(&storage.path_of(&att1.id).display().to_string()));

    // `brief()` is unchanged when attachments are empty.
    let plain = board
        .create_from_request_async(&IssueRequest {
            title: "Plain issue".into(),
            description: Some("No files.".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(plain.attachments.is_empty());
    let without_att = board::brief(&plain, std::slice::from_ref(&plain), None, Some(storage.as_ref()));
    let expected_plain = vibevalley_core::prompts::issue_brief(&plain.title, &plain.description, &plain.criteria, plain.deliver);
    assert_eq!(without_att, expected_plain);

    // Updating attachments on an open issue that has already started (in_progress/in_review) is allowed.
    let mut started = board.get_async(&created.id).await.unwrap();
    started.assignments = vec![Assignment {
        id: format!("{}-a1", started.id),
        issue: started.id.clone(),
        agent: "scripted".into(),
        assigned_at: 100,
        ended_at: None,
        executions: vec![Execution::Worker {
            session: "s-run-1".into(),
            started_at: 100,
        }],
    }];
    board.state().put_issues_async(&[started]).await.unwrap();

    let updated = board
        .update_from_input_async(IssueUpdateInput {
            id: created.id.clone(),
            attachments: Some(vec![att1.id.clone(), att2.id.clone()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(updated.attachments, vec![att1.clone(), att2.clone()]);

    // Clearing attachments on an open issue works and persists.
    let cleared = board
        .update_from_input_async(IssueUpdateInput {
            id: created.id.clone(),
            attachments: Some(vec![]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(cleared.attachments.is_empty());

    // Rejecting attachment updates on closed issues (Done & Canceled).
    let mut done_issue = board.get_async(&created.id).await.unwrap();
    done_issue.delivered = Some(Landing::Merged);
    done_issue.closed_at = Some(500);
    let mut canceled_issue = board.get_async(&plain.id).await.unwrap();
    canceled_issue.canceled = Some(IssueCanceled::Dismissed);
    canceled_issue.closed_at = Some(600);
    board.state().put_issues_async(&[done_issue, canceled_issue]).await.unwrap();

    let err_done = board
        .update_from_input_async(IssueUpdateInput {
            id: created.id.clone(),
            attachments: Some(vec![att1.id.clone()]),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(err_done.biz_code, BizCode::IssueRefused);

    let err_canceled = board
        .update_from_input_async(IssueUpdateInput {
            id: plain.id.clone(),
            attachments: Some(vec![att1.id.clone()]),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(err_canceled.biz_code, BizCode::IssueRefused);

    storage.close_async().await;
    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn issue_tags_dates_cycle_safe_parent_and_manual_done_roundtrip() {
    use vibevalley_protocol::{IssueStatus, JsNumber};

    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path()).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
    let ctx = Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        vibevalley_core::system_clock(),
        http.clone(),
        http,
    ));
    let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
        .await
        .unwrap();

    // Create parent with tags and start/due dates.
    let parent = board
        .create_from_request_async(&IssueRequest {
            title: "Parent epic".into(),
            tags: Some(vec![" UX ".into(), "架构".into(), "UX".into(), "".into()]),
            start_at: Some(JsNumber::from(1_760_000_000_000_i64)),
            due_at: Some(JsNumber::from(1_760_864_000_000_i64)),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(parent.tags, vec!["UX".to_string(), "架构".to_string()]);
    assert_eq!(parent.start_at, Some(JsNumber::from(1_760_000_000_000_i64)));
    assert_eq!(parent.due_at, Some(JsNumber::from(1_760_864_000_000_i64)));
    assert_eq!(parent.owner, Some(vibevalley_protocol::ActorRef::User { id: "self".into() }));
    assert!(parent.assignments.is_empty());

    // Update owner to collaborator and then to agent, and clear via empty id.
    let owned_collab = board
        .update_from_input_async(IssueUpdateInput {
            id: parent.id.clone(),
            owner: Some(vibevalley_protocol::ActorRef::User { id: " alice ".into() }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(owned_collab.owner, Some(vibevalley_protocol::ActorRef::User { id: "alice".into() }));
    assert!(owned_collab.assignments.is_empty());

    let owned_agent = board
        .update_from_input_async(IssueUpdateInput {
            id: parent.id.clone(),
            owner: Some(vibevalley_protocol::ActorRef::Agent { id: "expert-arch".into() }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(owned_agent.owner, Some(vibevalley_protocol::ActorRef::Agent { id: "expert-arch".into() }));
    assert!(owned_agent.assignments.is_empty());

    let cleared_owner = board
        .update_from_input_async(IssueUpdateInput {
            id: parent.id.clone(),
            owner: Some(vibevalley_protocol::ActorRef::User { id: String::new() }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(cleared_owner.owner, None);

    // Create child & grandchild, then update parent dynamically and verify cycle protection.
    let child = board
        .create_from_request_async(&IssueRequest {
            title: "Child task".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let grandchild = board
        .create_from_request_async(&IssueRequest {
            title: "Grandchild task".into(),
            ..Default::default()
        })
        .await
        .unwrap();

    let child = board
        .update_from_input_async(IssueUpdateInput {
            id: child.id.clone(),
            parent: Some(format!("#{}", parent.number)),
            tags: Some(vec!["MCP".into(), "Bug".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(child.parent.as_deref(), Some(parent.id.as_str()));
    assert_eq!(child.tags, vec!["MCP".to_string(), "Bug".to_string()]);

    let grandchild = board
        .update_from_input_async(IssueUpdateInput {
            id: grandchild.id.clone(),
            parent: Some(child.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(grandchild.parent.as_deref(), Some(child.id.as_str()));

    // Self-parenting and ancestor cycle are both refused.
    let self_err = board
        .update_from_input_async(IssueUpdateInput {
            id: parent.id.clone(),
            parent: Some(parent.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(self_err.biz_code, BizCode::IssueRefused);

    let cycle_err = board
        .update_from_input_async(IssueUpdateInput {
            id: parent.id.clone(),
            parent: Some(grandchild.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(cycle_err.biz_code, BizCode::IssueRefused);

    // Clearing parent via "" and clearing dates via 0 persists cleanly.
    let cleared = board
        .update_from_input_async(IssueUpdateInput {
            id: grandchild.id.clone(),
            parent: Some(String::new()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(cleared.parent, None);

    let cleared_dates = board
        .update_from_input_async(IssueUpdateInput {
            id: parent.id.clone(),
            start_at: Some(JsNumber::from(0_i64)),
            due_at: Some(JsNumber::from(0_i64)),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(cleared_dates.start_at, None);
    assert_eq!(cleared_dates.due_at, None);

    // Direct backlog -> done (manual completion without agent session) and revive -> backlog.
    assert_eq!(
        board.move_to_async(&cleared.id, IssueStatus::Done, None).await.unwrap(),
        vibevalley_core::Move::Complete
    );
    let done = board.get_async(&cleared.id).await.unwrap();
    assert_eq!(done.status, IssueStatus::Done);
    assert_eq!(done.delivered, Some(Landing::None));
    assert!(done.closed_at.is_some());

    assert_eq!(
        board.move_to_async(&cleared.id, IssueStatus::Backlog, None).await.unwrap(),
        vibevalley_core::Move::Revive
    );
    let revived = board.get_async(&cleared.id).await.unwrap();
    assert_eq!(revived.status, IssueStatus::Backlog);
    assert_eq!(revived.delivered, None);
    assert_eq!(revived.closed_at, None);

    // Direct backlog -> canceled.
    assert_eq!(
        board.move_to_async(&cleared.id, IssueStatus::Canceled, None).await.unwrap(),
        vibevalley_core::Move::Drop
    );
    assert_eq!(board.get_async(&cleared.id).await.unwrap().status, IssueStatus::Canceled);

    // Effective concurrency limits are unbounded by default (no 6-slot blocking).
    let default_cfg = BoardConfig::under(dir.path());
    assert_eq!(board::effective_limits(&default_cfg), (0, 0));

    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn unsent_issue_workflow_tracks_in_progress_in_review_and_criteria_persisting_across_reopen() {
    use vibevalley_protocol::{IssueAct, IssueAction, IssueStageKind, IssueStatus, IssueStatusUpdateInput};

    let dir = tempfile::tempdir().unwrap();
    let open_board = || async {
        let service = Service::open(dir.path()).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
        let ctx = Arc::new(Context::new(
            service,
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            http.clone(),
            http,
        ));
        let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
            .await
            .unwrap();
        (ctx, board)
    };

    let (ctx, board) = open_board().await;
    let created = board
        .create_from_request_async(&IssueRequest {
            title: "External MCP workflow".into(),
            criteria: Some(vec!["First check".into(), "Second check".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(created.status, IssueStatus::Backlog);
    assert!(created.moves.contains(&IssueStatus::InProgress));
    assert!(created.moves.contains(&IssueStatus::InReview));

    // Move backlog -> in_progress (persisted across DB reopen).
    let in_prog = board
        .status_from_input_async(&IssueStatusUpdateInput {
            revision: None,
            id: created.id.clone(),
            status: IssueStatus::InProgress,
            text: None,
            agent: None,
            edit: None,
            request_key: None,
            delivery_receipt: None,
        })
        .await
        .unwrap();
    assert_eq!(in_prog.status, IssueStatus::InProgress);
    assert_eq!(in_prog.stage.state, IssueStageKind::Working);
    assert_eq!(in_prog.queued_at, None);

    // Toggle criteria checkbox while in_progress.
    let checked = board
        .update_from_input_async(IssueUpdateInput {
            id: created.id.clone(),
            criteria: Some(vec!["[x] First check".into(), "Second check".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(checked.criteria, vec!["[x] First check", "Second check"]);

    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;

    // Reopen DB & Board: verify `in_progress` and criteria persisted cleanly.
    let (ctx2, board2) = open_board().await;
    let reloaded = board2.get_async(&created.id).await.unwrap();
    assert_eq!(reloaded.status, IssueStatus::InProgress);
    assert_eq!(reloaded.criteria, vec!["[x] First check", "Second check"]);

    // Move in_progress -> in_review: shows Reviewing stage with one-click Complete & Close acts, and appears in wants_user list.
    let in_rev = board2
        .status_from_input_async(&IssueStatusUpdateInput {
            revision: None,
            id: created.id.clone(),
            status: IssueStatus::InReview,
            text: None,
            agent: None,
            edit: None,
            request_key: None,
            delivery_receipt: None,
        })
        .await
        .unwrap();
    assert_eq!(in_rev.status, IssueStatus::InReview);
    assert_eq!(in_rev.stage.state, IssueStageKind::Reviewing);
    assert_eq!(in_rev.stage.lead, Some(IssueAct::Complete));
    assert!(in_rev.reviewed_at.is_some());
    assert!(matches!(
        in_rev.stage.acts.first(),
        Some(IssueAction::Move {
            act: IssueAct::Complete,
            status: IssueStatus::Done,
            ..
        })
    ));
    let patrol = board2
        .list_async(&IssueFilter {
            wants_user: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(patrol.len(), 1);
    assert_eq!(patrol[0].id, created.id);

    board2.close_async().await;
    let _ = ctx2.shutdown(Duration::from_secs(1)).await;

    // Reopen again and verify `in_review` persisted, then accept to `done`, then track back to `in_progress` and `backlog`.
    let (ctx3, board3) = open_board().await;
    let reloaded_review = board3.get_async(&created.id).await.unwrap();
    assert_eq!(reloaded_review.status, IssueStatus::InReview);
    assert_eq!(reloaded_review.stage.state, IssueStageKind::Reviewing);

    let done = board3
        .status_from_input_async(&IssueStatusUpdateInput {
            revision: None,
            id: created.id.clone(),
            status: IssueStatus::Done,
            text: None,
            agent: None,
            edit: None,
            request_key: None,
            delivery_receipt: None,
        })
        .await
        .unwrap();
    assert_eq!(done.status, IssueStatus::Done);
    assert_eq!(done.delivered, Some(Landing::None));

    let reopened_progress = board3
        .status_from_input_async(&IssueStatusUpdateInput {
            revision: None,
            id: created.id.clone(),
            status: IssueStatus::InProgress,
            text: None,
            agent: None,
            edit: None,
            request_key: None,
            delivery_receipt: None,
        })
        .await
        .unwrap();
    assert_eq!(reopened_progress.status, IssueStatus::InProgress);
    assert_eq!(reopened_progress.closed_at, None);
    assert_eq!(reopened_progress.delivered, None);

    let back = board3
        .status_from_input_async(&IssueStatusUpdateInput {
            revision: None,
            id: created.id.clone(),
            status: IssueStatus::Backlog,
            text: None,
            agent: None,
            edit: None,
            request_key: None,
            delivery_receipt: None,
        })
        .await
        .unwrap();
    assert_eq!(back.status, IssueStatus::Backlog);
    assert_eq!(back.reviewed_at, None);

    board3.close_async().await;
    let _ = ctx3.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn issue_retro_uses_injected_clock_and_full_persisted_issues() {
    use vibevalley_protocol::{DAY_MS, Finding, IssueRetroGetInput, IssueStatus, JsNumber, RetroWindow};

    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path()).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
    let now_ms = 1_800_000_000_000_i64;
    let clock = Arc::new(ManualClock::new(now_ms));
    let ctx = Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        clock.clone(),
        http.clone(),
        http,
    ));
    let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
        .await
        .unwrap();

    let mut recent_done = board
        .create_async(NewIssue {
            title: "recent-done".into(),
            tags: vec!["retro".into()],
            due_at: Some(JsNumber::from(now_ms - DAY_MS)),
            ..Default::default()
        })
        .await
        .unwrap();
    recent_done.created_at = now_ms - 4 * DAY_MS;
    recent_done.queued_at = Some(now_ms - 3 * DAY_MS);
    recent_done.reviewed_at = Some(now_ms - 2 * DAY_MS);
    recent_done.closed_at = Some(now_ms - 2 * DAY_MS);
    recent_done.delivered = Some(Landing::Merged);
    recent_done.status = IssueStatus::Done;
    recent_done.findings.push(Finding {
        id: "f1".into(),
        text: "needs edge test".into(),
        at: now_ms - 2 * DAY_MS,
        resolved: true,
    });

    let mut older_done = board
        .create_async(NewIssue {
            title: "older-done".into(),
            tags: vec!["legacy".into()],
            due_at: Some(JsNumber::from(now_ms - 12 * DAY_MS)),
            ..Default::default()
        })
        .await
        .unwrap();
    older_done.created_at = now_ms - 15 * DAY_MS;
    older_done.closed_at = Some(now_ms - 10 * DAY_MS);
    older_done.delivered = Some(Landing::Merged);
    older_done.status = IssueStatus::Done;

    board.state().put_issues_async(&[recent_done, older_done]).await.unwrap();

    let report_7d = board
        .issue_retro_endpoint_async(
            &IssueRetroGetInput {
                window: Some(RetroWindow::Days7),
            },
            clock.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(report_7d.total_issues, 1);
    assert_eq!(report_7d.completed_count, 1);
    assert_eq!(report_7d.on_time_count, 1);
    assert_eq!(report_7d.rework_issue_count, 1);
    assert_eq!(report_7d.cycle_time.median_ms, Some(2 * DAY_MS));
    assert_eq!(report_7d.review_wait.median_ms, Some(DAY_MS));

    let report_14d = board
        .issue_retro_endpoint_async(
            &IssueRetroGetInput {
                window: Some(RetroWindow::Days14),
            },
            clock.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(report_14d.total_issues, 2);
    assert_eq!(report_14d.completed_count, 2);
    assert_eq!(report_14d.on_time_count, 1);
    assert_eq!(report_14d.overdue_count, 1);
    assert_eq!(report_14d.overdue_items.len(), 1);

    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn issue_blocked_by_update_validates_cycles_dedup_clear_and_parent_composition() {
    use vibevalley_protocol::ActorRef;

    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path()).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
    let ctx = Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        vibevalley_core::system_clock(),
        http.clone(),
        http,
    ));
    let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
        .await
        .unwrap();

    let a = board
        .create_from_request_async(&IssueRequest {
            title: "Issue A".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let b = board
        .create_from_request_async(&IssueRequest {
            title: "Issue B".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let c = board
        .create_from_request_async(&IssueRequest {
            title: "Issue C".into(),
            ..Default::default()
        })
        .await
        .unwrap();

    // Update A.blocked_by using #number and id, deduplicating cleanly alongside owner update.
    let a = board
        .update_from_input_async(IssueUpdateInput {
            id: a.id.clone(),
            blocked_by: Some(vec![format!("#{}", b.number), b.id.clone(), String::new()]),
            owner: Some(ActorRef::Agent { id: "laozhou".into() }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(a.blocked_by, vec![b.id.clone()]);
    assert_eq!(a.owner, Some(ActorRef::Agent { id: "laozhou".into() }));

    // B blocked by C succeeds (chain A -> B -> C).
    let b = board
        .update_from_input_async(IssueUpdateInput {
            id: b.id.clone(),
            blocked_by: Some(vec![c.id.clone()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(b.blocked_by, vec![c.id.clone()]);

    // Self-blocking is refused.
    let self_err = board
        .update_from_input_async(IssueUpdateInput {
            id: a.id.clone(),
            blocked_by: Some(vec![a.id.clone()]),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(self_err.biz_code, BizCode::IssueRefused);

    // Transitive cycle C -> A (with A -> B -> C) is refused.
    let cycle_err = board
        .update_from_input_async(IssueUpdateInput {
            id: c.id.clone(),
            blocked_by: Some(vec![format!("#{}", a.number)]),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(cycle_err.biz_code, BizCode::IssueRefused);

    // Parent + blocked_by cycle: setting C.parent = A while A -> B -> C would make A wait on child C and C transitively already reached from A -> B -> C? Wait:
    // If C is child of A, A waits on C; if C is also blocked_by A, that's a cycle.
    let parent_cycle_err = board
        .update_from_input_async(IssueUpdateInput {
            id: c.id.clone(),
            parent: Some(a.id.clone()),
            blocked_by: Some(vec![a.id.clone()]),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(parent_cycle_err.biz_code, BizCode::IssueRefused);

    // Clearing blocked_by via [] persists and unblocks, preserving owner.
    let cleared = board
        .update_from_input_async(IssueUpdateInput {
            id: a.id.clone(),
            blocked_by: Some(vec![]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(cleared.blocked_by.is_empty());
    assert_eq!(cleared.owner, Some(ActorRef::Agent { id: "laozhou".into() }));

    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn issue_relations_sync_bidirectionally_and_never_block_or_cycle_and_triage_requires_confirm() {
    use vibevalley_core::ManualClock;
    use vibevalley_protocol::{
        BacklogTriageConfirmInput, BacklogTriageSuggestInput, Caller, IssueDigestGetInput, IssueRelation, IssueRelationKind, Priority, TriagePatch,
    };

    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let service = Service::open(dir.path()).await.unwrap();
    let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
    let ctx = Arc::new(Context::new(
        service.clone(),
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        Arc::new(Outbox::new(service)),
        Arc::new(StateFeed::new()),
        clock.clone(),
        http.clone(),
        http,
    ));
    let mut reg = Registry::new();
    reg.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let board = Board::open_standalone_async(ctx.clone(), Arc::new(reg), BoardConfig::under(dir.path()))
        .await
        .unwrap();

    let a = board
        .create_async(NewIssue {
            title: "Urgent auth token crash".into(),
            agent: "scripted".into(),
            deliver: vibevalley_protocol::Deliverable::Answer,
            ..Default::default()
        })
        .await
        .unwrap();
    let b = board
        .create_async(NewIssue {
            title: "Auth token refresh crash".into(),
            agent: "scripted".into(),
            deliver: vibevalley_protocol::Deliverable::Answer,
            relations: vec![IssueRelation {
                kind: IssueRelationKind::Duplicate,
                issue: a.id.clone(),
            }],
            ..Default::default()
        })
        .await
        .unwrap();

    // Bidirectional creation syncs back onto A.
    let a_fresh = board.issue_async(&a.id).await.unwrap().unwrap();
    assert_eq!(
        a_fresh.relations,
        vec![IssueRelation {
            kind: IssueRelationKind::Duplicate,
            issue: b.id.clone(),
        }]
    );

    // Non-blocking: B can leave Backlog and start work even while duplicate/related to open A.
    board.move_to_async(&b.id, vibevalley_protocol::IssueStatus::Todo, None).await.unwrap();
    assert_ne!(
        board.issue_async(&b.id).await.unwrap().unwrap().status,
        vibevalley_protocol::IssueStatus::Backlog
    );

    // Updating A's relations to Related updates B bidirectionally.
    board
        .update_from_input_async(IssueUpdateInput {
            id: a.id.clone(),
            relations: Some(vec![IssueRelation {
                kind: IssueRelationKind::Related,
                issue: format!("#{}", b.number),
            }]),
            ..Default::default()
        })
        .await
        .unwrap();
    let b_fresh = board.issue_async(&b.id).await.unwrap().unwrap();
    assert_eq!(
        b_fresh.relations,
        vec![IssueRelation {
            kind: IssueRelationKind::Related,
            issue: a.id.clone(),
        }]
    );

    // Clearing relations on A removes reverse relation from B.
    board
        .update_from_input_async(IssueUpdateInput {
            id: a.id.clone(),
            relations: Some(vec![]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(board.issue_async(&b.id).await.unwrap().unwrap().relations.is_empty());

    // Triage suggestion never mutates A until explicit confirm.
    let suggestion = board
        .issue_triage_suggest_endpoint_async(
            Caller::Orchestrator,
            BacklogTriageSuggestInput {
                issue_id: a.id.clone(),
                reason: "High urgency crash".into(),
                summary: Some("Set priority Urgent".into()),
                patch: TriagePatch {
                    priority: Some(Priority::Urgent),
                    ..Default::default()
                },
            },
            clock.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(board.issue_async(&a.id).await.unwrap().unwrap().priority, Priority::Medium);

    let digest = board
        .issue_digest_get_endpoint_async(&IssueDigestGetInput { window_hours: Some(24) }, clock.as_ref())
        .await
        .unwrap();
    assert!(digest.triage.iter().any(|s| s.id == suggestion.id));

    let applied = board
        .issue_triage_confirm_endpoint_async(&BacklogTriageConfirmInput { id: suggestion.id.clone() }, clock.as_ref())
        .await
        .unwrap();
    assert_eq!(applied.priority, Priority::Urgent);

    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn issue_state_decoupled_from_runtime_write_lock_and_uses_targeted_derivation() {
    use vibevalley_protocol::{Issue, IssueUpdate, Priority};

    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path()).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
    let ctx = Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        vibevalley_core::system_clock(),
        http.clone(),
        http,
    ));
    let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
        .await
        .unwrap();

    // 1. Seed 120 archived closed issues + 1 parent + 1 open child to verify board window & local derivation.
    let mut archived = Vec::with_capacity(120);
    for n in 1..=120i64 {
        let mut item = Issue::new(format!("arch-{n}"), n, format!("Archived #{n}"), 1_000 + n);
        item.delivered = Some(Landing::Merged);
        item.closed_at = Some(2_000 + n);
        archived.push(item);
    }
    board.state.put_issues_async(&archived).await.unwrap();

    let parent = board
        .create_async(NewIssue {
            title: "Parent feature".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let child = board
        .create_async(NewIssue {
            title: "Child task".into(),
            parent: Some(parent.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let sibling = board
        .create_async(NewIssue {
            title: "Independent task".into(),
            ..Default::default()
        })
        .await
        .unwrap();

    // Board window returns only open issues + top 50 closed issues (not all 120 archived rows).
    let window = board.raw_issues_for_board_async(&[]).await.unwrap();
    assert_eq!(window.len(), 50 + 3, "board window must prune archived history beyond top 50 closed");

    // Targeted single-issue lookup (by id, number, #number) matches full-table derivation.
    let full = board.issues_async().await.unwrap();
    let full_parent = full.iter().find(|i| i.id == parent.id).unwrap();
    assert_eq!(board.issue_async(&parent.id).await.unwrap().unwrap(), *full_parent);
    assert_eq!(board.issue_async(&format!("#{}", parent.number)).await.unwrap().unwrap(), *full_parent);
    assert_eq!(board.issue_async(&parent.number.to_string()).await.unwrap().unwrap(), *full_parent);

    // 2. Hold `runtime.write_lock()` exclusively (simulating an active SessionEngine turn commit).
    //    Unrelated IssueState edits MUST proceed immediately without blocking on runtime.write_lock().
    let _held_session_lock = board.runtime.write_lock().lock().await;
    let drafted = tokio::time::timeout(
        Duration::from_secs(2),
        board.state.change_async(
            &sibling.id,
            IssueChange::Drafted {
                title: "Drafted while session write_lock held".into(),
                description: "Targeted single-issue write".into(),
                criteria: vec!["fast".into()],
                questions: vec![],
            },
        ),
    )
    .await
    .expect("IssueState::change_async must never block on SessionEngine write_lock")
    .unwrap();
    assert_eq!(drafted.title, "Drafted while session write_lock held");

    let edited = tokio::time::timeout(
        Duration::from_secs(2),
        board.edit_async(
            &sibling.id,
            &IssueUpdate {
                priority: Some(Priority::High),
                ..Default::default()
            },
        ),
    )
    .await
    .expect("Board::edit_async must never block on SessionEngine write_lock")
    .unwrap();
    assert_eq!(edited.priority, Priority::High);

    // 3. Concurrent changes on two different issues succeed cleanly while runtime.write_lock() is held.
    let (r1, r2) = tokio::join!(
        board.state.change_async(
            &child.id,
            IssueChange::Drafted {
                title: "Child updated".into(),
                description: String::new(),
                criteria: vec![],
                questions: vec![],
            },
        ),
        board.state.change_async(
            &sibling.id,
            IssueChange::Drafted {
                title: "Sibling updated".into(),
                description: String::new(),
                criteria: vec![],
                questions: vec![],
            },
        ),
    );
    assert_eq!(r1.unwrap().title, "Child updated");
    assert_eq!(r2.unwrap().title, "Sibling updated");

    drop(_held_session_lock);
    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn delivery_receipt_polymorphic_persists_via_update_and_done_across_reopen() {
    use vibevalley_protocol::{Deliverable, DeliveryReceipt, IssueStatus, IssueStatusUpdateInput, Landing};

    let dir = tempfile::tempdir().unwrap();
    let open_board = || async {
        let service = Service::open(dir.path()).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let http: Arc<dyn crate::context::Fetch> = Arc::new(Http);
        let ctx = Arc::new(Context::new(
            service,
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            http.clone(),
            http,
        ));
        let board = Board::open_standalone_async(ctx.clone(), Arc::new(Registry::new()), BoardConfig::under(dir.path()))
            .await
            .unwrap();
        (ctx, board)
    };

    let (ctx, board) = open_board().await;
    let pr_issue = board
        .create_from_request_async(&IssueRequest {
            title: "Ship autonomous PR".into(),
            deliver: Some(Deliverable::PullRequest),
            ..Default::default()
        })
        .await
        .unwrap();
    let pr_receipt = DeliveryReceipt::PullRequest {
        url: "https://github.com/acme/repo/pull/42".into(),
        number: Some(42),
        branch: Some("feat/autonomous-pr".into()),
        summary: Some("All checks green".into()),
    };
    let done_pr = board
        .status_from_input_async(&IssueStatusUpdateInput {
            id: pr_issue.id.clone(),
            status: IssueStatus::Done,
            text: None,
            agent: None,
            edit: None,
            delivery_receipt: Some(pr_receipt.clone()),
            request_key: None,
            revision: None,
        })
        .await
        .unwrap();
    assert_eq!(done_pr.status, IssueStatus::Done);
    assert_eq!(done_pr.delivered, Some(Landing::Submitted));
    assert_eq!(done_pr.delivery_receipt, Some(pr_receipt.clone()));

    let commit_issue = board
        .create_from_request_async(&IssueRequest {
            title: "Ship commit receipt".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let commit_receipt = DeliveryReceipt::Commit {
        sha: "abc123def".into(),
        branch: Some("main".into()),
        summary: Some("Refactored module".into()),
    };
    let updated_commit = board
        .update_from_input_async(IssueUpdateInput {
            id: commit_issue.id.clone(),
            delivery_receipt: Some(commit_receipt.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(updated_commit.delivery_receipt, Some(commit_receipt.clone()));
    let done_commit = board
        .status_from_input_async(&IssueStatusUpdateInput {
            id: commit_issue.id.clone(),
            status: IssueStatus::Done,
            text: None,
            agent: None,
            edit: None,
            delivery_receipt: None,
            request_key: None,
            revision: None,
        })
        .await
        .unwrap();
    assert_eq!(done_commit.delivered, Some(Landing::Merged));
    assert_eq!(done_commit.delivery_receipt, Some(commit_receipt.clone()));

    let note_issue = board
        .create_from_request_async(&IssueRequest {
            title: "Deliver architecture note".into(),
            deliver: Some(Deliverable::Answer),
            ..Default::default()
        })
        .await
        .unwrap();
    let note_receipt = DeliveryReceipt::Note {
        note_id: "n-arch-36".into(),
        title: Some("RFC #36".into()),
        summary: Some("Documented autonomous delivery".into()),
    };
    let done_note = board
        .status_from_input_async(&IssueStatusUpdateInput {
            id: note_issue.id.clone(),
            status: IssueStatus::Done,
            text: None,
            agent: None,
            edit: None,
            delivery_receipt: Some(note_receipt.clone()),
            request_key: None,
            revision: None,
        })
        .await
        .unwrap();
    assert_eq!(done_note.delivered, Some(Landing::None));
    assert_eq!(done_note.delivery_receipt, Some(note_receipt.clone()));

    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;

    let (ctx2, board2) = open_board().await;
    assert_eq!(board2.get_async(&pr_issue.id).await.unwrap().delivery_receipt, Some(pr_receipt));
    assert_eq!(board2.get_async(&commit_issue.id).await.unwrap().delivery_receipt, Some(commit_receipt));
    assert_eq!(board2.get_async(&note_issue.id).await.unwrap().delivery_receipt, Some(note_receipt));
    board2.close_async().await;
    let _ = ctx2.shutdown(Duration::from_secs(1)).await;
}
