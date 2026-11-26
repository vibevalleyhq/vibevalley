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
    let board = Board::with_storage(ctx.clone(), runtime, opened, None, None, Some(storage.clone()))
        .await
        .unwrap();

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
        })
        .await
        .unwrap();
    assert_eq!(back.status, IssueStatus::Backlog);
    assert_eq!(back.reviewed_at, None);

    board3.close_async().await;
    let _ = ctx3.shutdown(Duration::from_secs(1)).await;
}
