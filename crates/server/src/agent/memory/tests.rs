use std::sync::Arc;
use std::time::Duration;

use vibevalley_protocol::{BizCode, LastRun, Outcome, Session};

use super::rules as m;
use super::*;
use crate::agent::profile::Profile;
use crate::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use crate::db::DbBackend;
use crate::service::Service;

fn test_context(service: Arc<Service>) -> Arc<Context> {
    let outbox = Arc::new(Outbox::new(service.clone()));
    Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        vibevalley_core::system_clock(),
        Arc::new(Http),
        Arc::new(PublicDownload),
    ))
}

#[tokio::test]
async fn session_reported_keeps_issue_worker_and_skips_workspace_sessions() {
    let home = tempfile::tempdir().unwrap();
    let service = Service::open(home.path()).await.unwrap();
    let ctx = test_context(service.clone());
    let registry = Arc::new(vibevalley_runtime::oar::Registry::new());
    let profile = Profile::open_async(ctx.clone(), home.path(), &[], registry, false).await.unwrap();
    let memories = Memory::open(ctx.clone(), profile);
    memories.register_outbox();

    // Workspace chat session reports: must be skipped cleanly.
    let mut ws = Session::new(
        "ws1",
        vibevalley_protocol::SessionController::User,
        "Direct Chat",
        "antigravity",
        vibevalley_protocol::ExecutionPolicy::DirectCwd {
            repo: None,
            permission_mode: vibevalley_protocol::SessionPermissionMode::AcceptEdits,
        },
        1,
    );
    ws.brief = "workspace chat".into();
    ws.runs = 1;
    ws.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        at: 2,
        summary: "workspace reply".into(),
        spent: None,
        answer: None,
    });
    memories.keep_session_reported_async(&ws).await;

    // Issue worker reports: persisted into memory.
    let mut worker = Session::new(
        "w1",
        vibevalley_protocol::SessionController::IssueBoard,
        "Backend",
        "scripted",
        vibevalley_protocol::ExecutionPolicy::ManagedWorktree {
            repo: "farm".into(),
            branch: None,
        },
        3,
    );
    worker.profile = Some("backend".into());
    worker.attach_binding(vibevalley_protocol::ContextRef::Issue {
        id: "i1".into(),
        refining: None,
    });
    worker.brief = "fix bug".into();
    worker.runs = 1;
    worker.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        at: 4,
        summary: "fixed it".into(),
        spent: None,
        answer: None,
    });
    memories.keep_session_reported_async(&worker).await;

    assert!(
        memories.list_async("antigravity").await.unwrap().is_empty(),
        "workspace session leaked into memory"
    );
    assert_eq!(memories.list_async("backend").await.unwrap().len(), 1);
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
    service.close().await;
}

async fn verify_memory_dual_db(service: Arc<Service>, home: &std::path::Path, expected_backend: DbBackend) {
    assert_eq!(service.backend(), expected_backend);
    let ctx = test_context(service);
    let registry = Arc::new(vibevalley_runtime::oar::Registry::new());
    let profile = Profile::open_async(ctx.clone(), home, &[], registry, false).await.unwrap();
    let memories = Memory::open(ctx.clone(), profile);

    // Blank note is refused.
    let blank_err = memories
        .write_async(&Note {
            agent: "backend".into(),
            text: "   ".into(),
            repo: "farm".into(),
            by: By::User,
        })
        .await
        .unwrap_err();
    assert_eq!(blank_err.biz_code, BizCode::MemoryRefused);

    let user_note = memories
        .write_async(&Note {
            agent: "backend".into(),
            text: "Run cargo test in farm repo".into(),
            repo: "farm".into(),
            by: By::User,
        })
        .await
        .unwrap();
    let _orch_note = memories
        .write_async(&Note {
            agent: "backend".into(),
            text: "Prefer Service queries over raw SQL".into(),
            repo: String::new(),
            by: By::Orchestrator,
        })
        .await
        .unwrap();

    let listed = memories.listed_async("backend").await;
    assert_eq!(listed.len(), 2);

    // Rewrite rollback preserves existing agent notes when a replacement fails validation.
    let before = memories.list_async("backend").await.unwrap();
    let rewrite_err = memories
        .rewrite_async("backend", &["Valid replacement".into(), "  ".into()], By::Orchestrator)
        .await
        .unwrap_err();
    assert_eq!(rewrite_err.biz_code, BizCode::MemoryRefused);
    assert_eq!(memories.list_async("backend").await.unwrap(), before);

    // Successful rewrite replaces agent notes while keeping user notes.
    let replaced = memories
        .rewrite_async("backend", &["Use read_conn for queries".into()], By::Orchestrator)
        .await
        .unwrap();
    assert_eq!(replaced, 1);
    let after = memories.list_async("backend").await.unwrap();
    assert_eq!(after.len(), 2);
    assert!(after.iter().any(|m| m.id == user_note.id && m.author == m::ActorKind::User));
    assert!(after.iter().any(|m| m.text == "Use read_conn for queries" && m.author == m::ActorKind::Agent));

    // Peek recall does not increment recalled counter; active recall increments recalled and sets recalled_at.
    let peeked = memories.recall_async("backend", None, "farm", "cargo test", true).await;
    assert!(!peeked.is_empty());
    let after_peek = memories.list_async("backend").await.unwrap();
    assert!(after_peek.iter().all(|m| m.recalled == 0 && m.recalled_at.is_none()));

    let recalled = memories.recall_async("backend", Some("sess-1"), "farm", "cargo test", false).await;
    assert!(!recalled.is_empty());
    let after_recall = memories.list_async("backend").await.unwrap();
    let recalled_row = after_recall.iter().find(|m| m.id == user_note.id).unwrap();
    assert_eq!(recalled_row.recalled, 1);
    assert!(recalled_row.recalled_at.is_some());

    // keep_async skips Interrupted and upserts on partial unique index (agent, session) WHERE kind = 'issue'.
    memories
        .keep_async(&FinishedRun {
            agent: "backend".into(),
            session: "sess-int".into(),
            issue: Some("iss-int".into()),
            repo: "farm".into(),
            brief: "ignored".into(),
            outcome: Outcome::Interrupted,
            summary: "aborted".into(),
        })
        .await;
    assert!(memories.list_async("backend").await.unwrap().iter().all(|m| m.kind != m::MemoryKind::Issue));

    memories
        .keep_async(&FinishedRun {
            agent: "backend".into(),
            session: "sess-1".into(),
            issue: Some("iss-1".into()),
            repo: "farm".into(),
            brief: "fix dual db".into(),
            outcome: Outcome::Failed,
            summary: "first attempt".into(),
        })
        .await;
    memories
        .keep_async(&FinishedRun {
            agent: "backend".into(),
            session: "sess-1".into(),
            issue: Some("iss-1".into()),
            repo: "farm".into(),
            brief: "fix dual db".into(),
            outcome: Outcome::Completed,
            summary: "second attempt succeeded".into(),
        })
        .await;
    let issue_rows: Vec<_> = memories
        .list_async("backend")
        .await
        .unwrap()
        .into_iter()
        .filter(|m| m.kind == m::MemoryKind::Issue)
        .collect();
    assert_eq!(issue_rows.len(), 1);
    assert!(issue_rows[0].text.contains("second attempt succeeded"), "{}", issue_rows[0].text);

    // Search and forget.
    let search = memories.search_async("backend", "farm", "cargo test", 10).await;
    assert!(search.found.iter().any(|f| f.id == user_note.id));

    let preview = memories.preview_forget_async("backend", &user_note.id).await.unwrap();
    assert!(!preview.does.is_empty());
    memories.forget_async("backend", &user_note.id).await.unwrap();
    let gone = memories.forget_async("backend", &user_note.id).await.unwrap_err();
    assert_eq!(gone.biz_code, BizCode::MemoryNotFound);

    let _ = ctx.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn dual_db_memory_persistence_works_on_sqlite_and_postgres() {
    vibevalley_i18n::set_locale("en");

    let sqlite_home = tempfile::tempdir().unwrap();
    let sqlite_url = format!("sqlite://{}", sqlite_home.path().join("memory.db").display());
    let sqlite_service = Service::open_url(&sqlite_url).await.unwrap();
    verify_memory_dual_db(sqlite_service.clone(), sqlite_home.path(), DbBackend::Sqlite).await;
    sqlite_service.close().await;

    let Some(pg) = crate::db::test_pg::EphemeralPostgres::start() else {
        eprintln!("skipping postgres memory dual-db test: Homebrew initdb/pg_ctl not found");
        return;
    };
    pg.create_database("team_memory_dual").await;
    let pg_home = tempfile::tempdir().unwrap();
    let pg_service = Service::open_url(&pg.db_url("team_memory_dual")).await.unwrap();
    verify_memory_dual_db(pg_service.clone(), pg_home.path(), DbBackend::Postgres).await;
    pg_service.close().await;
}
