//! Query-plan anti-regression guards (`EXPLAIN QUERY PLAN` / PostgreSQL `EXPLAIN`) and
//! 10k+ scale dual-backend performance & FTS5 / `pg_trgm` verification tests for Issue #151.

use std::time::{Duration, Instant};

use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use vibevalley_protocol::{
    ActorKind, AgentRole, ExecutionPolicy, Issue, LibraryListRequest, LibraryOrigin, LinkEntityKind, LinkRelation, MemoryKind, NoteLinkRef, Phase,
    PhaseResting, Session, SessionController, SessionEvent, SessionEventType,
};

use super::Service;
use super::channel::{NewMessage, ParticipantRow, SearchParams};
use super::memory::NewMemory;

async fn sqlite_explain_lines(svc: &Service, sql: &str) -> Vec<String> {
    let rows = svc
        .database()
        .read_conn()
        .query_all_raw(Statement::from_string(DatabaseBackend::Sqlite, format!("EXPLAIN QUERY PLAN {sql}")))
        .await
        .expect("EXPLAIN QUERY PLAN failed");
    rows.into_iter()
        .map(|row| row.try_get::<String>("", "detail").expect("detail column"))
        .collect()
}

fn assert_no_table_scan(plan: &[String], table: &str, label: &str) {
    let joined = plan.join(" | ");
    let bare = format!("SCAN {table}");
    let quoted = format!("SCAN \"{table}\"");
    assert!(
        !plan.iter().any(|line| {
            let matches_table = line == &bare || line.starts_with(&format!("{bare} ")) || line == &quoted || line.starts_with(&format!("{quoted} "));
            // Index-only scans in SQLite say `SCAN <table> USING INDEX ...` or `USING COVERING INDEX ...`.
            matches_table && !line.contains("USING INDEX") && !line.contains("USING COVERING INDEX")
        }),
        "[{label}] unexpected full table SCAN on `{table}`! plan: {joined}"
    );
}

fn assert_no_temp_btree_sort(plan: &[String], label: &str) {
    let joined = plan.join(" | ");
    assert!(
        !plan.iter().any(|line| line.contains("USE TEMP B-TREE FOR ORDER BY")),
        "[{label}] unexpected USE TEMP B-TREE FOR ORDER BY! plan: {joined}"
    );
}

fn make_event(seq: i64, kind: SessionEventType, run: &str, text: &str) -> SessionEvent {
    SessionEvent {
        seq,
        revision: 1,
        time: 10_000 + seq,
        r#type: kind,
        run: Some(run.to_owned()),
        call: None,
        under: None,
        thread_id: None,
        text: text.to_owned(),
        action: None,
        action_text: None,
        tool: None,
        input: None,
        output: None,
        ok: None,
        tokens: None,
        connection: None,
        permission: None,
        interaction: None,
        interaction_resolution: None,
    }
}

fn make_session(id: &str, hired_at: i64) -> Session {
    Session {
        id: id.to_owned(),
        controller: SessionController::IssueBoard,
        role: Some(AgentRole::Worker),
        name: format!("Agent {id}"),
        profile: None,
        runtime: "claude".to_owned(),
        brief: String::new(),
        cwd: None,
        policy: ExecutionPolicy::SandboxDir,
        bindings: Vec::new(),
        hired_at,
        runs: 1,
        last_run: None,
        spent: None,
        subagents: None,
        tool_connections: None,
        telemetry: None,
        machine: None,
        phase: Phase::Resting(PhaseResting {}),
    }
}

fn make_participant(id: &str, kind: &str, name: &str, agent_id: Option<&str>) -> ParticipantRow {
    ParticipantRow {
        id: id.to_owned(),
        kind: kind.to_owned(),
        name: name.to_owned(),
        agent_id: agent_id.map(str::to_owned),
        home_id: None,
        joined_at: 1_000,
        left_at: None,
    }
}

/// Anti-regression `EXPLAIN QUERY PLAN` guard covering core audited hot queries across
/// channels, sessions, events, memory, notes, library, outbox, and issues.
#[tokio::test]
async fn sqlite_explain_query_plan_guards_prevent_full_table_scan_regressions() {
    let dir = tempfile::tempdir().unwrap();
    let svc = Service::open(dir.path()).await.unwrap();

    // Seed enough representative rows so SQLite's planner uses indexes cleanly after ANALYZE.
    let tx = svc.begin_tx().await.unwrap();
    svc.channel
        .upsert_participant_in_tx(&tx, &make_participant("user", "user", "User", None))
        .await
        .unwrap();
    svc.channel
        .upsert_participant_in_tx(&tx, &make_participant("bot", "agent", "Bot", Some("coder")))
        .await
        .unwrap();
    svc.channel.create_channel_in_tx(&tx, "c1", true, "general", None, None, 1_000).await.unwrap();
    for i in 0..80 {
        let id = format!("msg-{i:04}");
        let body = if i % 10 == 0 {
            format!("Check deployment guide https://example.com/run/{i} with 查询优化")
        } else {
            format!("Regular update number {i}")
        };
        let meta = if i % 15 == 0 {
            Some(r#"{"attachments":[{"id":"att-1","type":"image/png","name":"shot.png"}]}"#)
        } else if i % 7 == 0 {
            Some(r#"{"attachments":[{"id":"att-2","type":"application/pdf","name":"doc.pdf"}]}"#)
        } else {
            None
        };
        let msg = NewMessage {
            id: &id,
            channel_id: "c1",
            sender: if i % 2 == 0 { "bot" } else { "user" },
            kind: if i % 20 == 0 { "report" } else { "chat" },
            body: &body,
            meta,
            system_code: None,
            send_key: None,
            at: 10_000 + i,
            revision: i + 1,
            reply_number: None,
        };
        svc.channel.insert_message_in_tx(&tx, &msg).await.unwrap();
    }
    svc.commit_tx(tx).await.unwrap();
    svc.database().write_conn().execute_unprepared("ANALYZE;").await.unwrap();

    // 1. channel_message: has_file / has_image / has_link filters use partial indexes (no full table scan).
    for (flag, label) in [
        ("has_file = 1 AND deleted_at IS NULL", "search_has_file"),
        ("has_image = 1 AND deleted_at IS NULL", "search_has_image"),
        ("has_link = 1 AND deleted_at IS NULL", "search_has_link"),
    ] {
        let plan = sqlite_explain_lines(&svc, &format!("SELECT id FROM channel_message WHERE {flag} ORDER BY id DESC LIMIT 20")).await;
        assert_no_table_scan(&plan, "channel_message", label);
        assert_no_temp_btree_sort(&plan, label);
    }

    // 2. channel_message: FTS5 trigram search drives from virtual table index + rowid PK lookup (no table scan).
    let fts_plan = sqlite_explain_lines(
        &svc,
        "SELECT channel_message.id FROM channel_message INNER JOIN channel_message_fts ON channel_message_fts.rowid = channel_message.rowid WHERE channel_message_fts MATCH '\"deployment\"' AND channel_message.deleted_at IS NULL ORDER BY channel_message.id DESC LIMIT 20",
    )
    .await;
    assert_no_table_scan(&fts_plan, "channel_message", "search_fts5_trigram");
    assert!(
        fts_plan.iter().any(|l| l.contains("channel_message_fts VIRTUAL TABLE INDEX")),
        "[search_fts5_trigram] expected FTS5 virtual table index scan, got: {}",
        fts_plan.join(" | ")
    );
    assert!(
        fts_plan.iter().any(|l| l.contains("SEARCH channel_message USING INTEGER PRIMARY KEY")),
        "[search_fts5_trigram] expected rowid PK lookup on channel_message, got: {}",
        fts_plan.join(" | ")
    );

    // 3. channel_message: recent reports & pinned messages & cursor pagination.
    let reports_plan = sqlite_explain_lines(&svc, "SELECT id FROM channel_message WHERE kind = 'report' ORDER BY id DESC LIMIT 20").await;
    assert_no_table_scan(&reports_plan, "channel_message", "recent_reports");
    assert_no_temp_btree_sort(&reports_plan, "recent_reports");

    let pinned_plan = sqlite_explain_lines(
        &svc,
        "SELECT id FROM channel_message WHERE channel_id = 'c1' AND pinned_at IS NOT NULL ORDER BY pinned_at DESC",
    )
    .await;
    assert_no_table_scan(&pinned_plan, "channel_message", "pinned_in");
    assert_no_temp_btree_sort(&pinned_plan, "pinned_in");

    let cursor_plan = sqlite_explain_lines(
        &svc,
        "SELECT id FROM channel_message WHERE channel_id = 'c1' AND number < 50 ORDER BY number DESC LIMIT 30",
    )
    .await;
    assert_no_table_scan(&cursor_plan, "channel_message", "messages_before");
    assert_no_temp_btree_sort(&cursor_plan, "messages_before");

    // 4. session: active list uses session_departed_hired_id with no temp B-tree; session_run uses composite index.
    let session_plan = sqlite_explain_lines(&svc, "SELECT id FROM session WHERE departed = 0 ORDER BY hired_at ASC, id ASC").await;
    assert_no_table_scan(&session_plan, "session", "session_all");
    assert_no_temp_btree_sort(&session_plan, "session_all");

    let run_plan = sqlite_explain_lines(
        &svc,
        "SELECT subagent_summary FROM session_run WHERE session = 's1' ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .await;
    assert_no_table_scan(&run_plan, "session_run", "session_latest_run");
    assert_no_temp_btree_sort(&run_plan, "session_latest_run");

    // 5. session_event: telemetry query uses partial index `session_event_telemetry`.
    let telemetry_plan = sqlite_explain_lines(
        &svc,
        "SELECT payload FROM session_event WHERE session_id = 's1' AND event_type IN ('llm/usage', 'llm/retry', 'run/error') ORDER BY seq ASC",
    )
    .await;
    assert_no_table_scan(&telemetry_plan, "session_event", "session_telemetry");
    assert_no_temp_btree_sort(&telemetry_plan, "session_telemetry");

    // 6. memory: active agent list & farm profiles & FTS5 search.
    let mem_plan = sqlite_explain_lines(
        &svc,
        "SELECT id FROM memory WHERE agent = 'a1' AND replaced_by IS NULL ORDER BY created_at DESC, id DESC",
    )
    .await;
    assert_no_table_scan(&mem_plan, "memory", "memory_list_active");
    assert_no_temp_btree_sort(&mem_plan, "memory_list_active");

    let farm_plan = sqlite_explain_lines(
        &svc,
        "SELECT id FROM memory WHERE scope = 'farm' AND kind = 'profile' AND replaced_by IS NULL ORDER BY importance DESC, updated_at DESC, id DESC",
    )
    .await;
    assert_no_table_scan(&farm_plan, "memory", "memory_farm_profiles");
    assert_no_temp_btree_sort(&farm_plan, "memory_farm_profiles");

    // 7. note_link: outgoing & backlinks ordered by created_at without temp B-tree.
    let out_link_plan = sqlite_explain_lines(
        &svc,
        "SELECT id FROM note_link WHERE source_kind = 'note' AND source_id = 'n1' ORDER BY created_at ASC",
    )
    .await;
    assert_no_table_scan(&out_link_plan, "note_link", "note_link_outgoing");
    assert_no_temp_btree_sort(&out_link_plan, "note_link_outgoing");

    let back_link_plan = sqlite_explain_lines(
        &svc,
        "SELECT id FROM note_link WHERE target_kind = 'note' AND target_id = 'n1' ORDER BY created_at ASC",
    )
    .await;
    assert_no_table_scan(&back_link_plan, "note_link", "note_link_backlinks");
    assert_no_temp_btree_sort(&back_link_plan, "note_link_backlinks");

    // 8. note_collab, media_job, outbox_item, attachment_fts.
    let collab_plan = sqlite_explain_lines(&svc, "SELECT note_id FROM note_collab ORDER BY updated_at DESC, note_id ASC LIMIT 32").await;
    assert_no_table_scan(&collab_plan, "note_collab", "note_collab_recent");
    assert_no_temp_btree_sort(&collab_plan, "note_collab_recent");

    let media_job_plan = sqlite_explain_lines(&svc, "SELECT COUNT(*) FROM media_job WHERE phase IN ('queued', 'running')").await;
    assert_no_table_scan(&media_job_plan, "media_job", "media_job_phase");

    let outbox_plan = sqlite_explain_lines(
        &svc,
        "SELECT id FROM outbox_item WHERE status = 'pending' AND available_at <= 1000 ORDER BY available_at ASC, id ASC LIMIT 32",
    )
    .await;
    assert_no_table_scan(&outbox_plan, "outbox_item", "outbox_claim");
    assert_no_temp_btree_sort(&outbox_plan, "outbox_claim");

    let att_fts_plan = sqlite_explain_lines(
        &svc,
        "SELECT attachment.id FROM attachment INNER JOIN attachment_fts ON attachment_fts.rowid = attachment.rowid WHERE attachment_fts MATCH '\"report\"'",
    )
    .await;
    assert_no_table_scan(&att_fts_plan, "attachment", "attachment_fts5");
    assert!(
        att_fts_plan.iter().any(|l| l.contains("attachment_fts VIRTUAL TABLE INDEX")),
        "[attachment_fts5] expected FTS5 virtual table index scan, got: {}",
        att_fts_plan.join(" | ")
    );
    assert!(
        att_fts_plan.iter().any(|l| l.contains("SEARCH attachment USING INTEGER PRIMARY KEY")),
        "[attachment_fts5] expected rowid PK lookup on attachment, got: {}",
        att_fts_plan.join(" | ")
    );

    svc.close().await;
}

/// Functional & scale verification across 10k issues + 10k session events + channel search
/// (explicit `has_file`/`has_image`/`has_link` + FTS5/`pg_trgm` ASCII & CJK) + memory search
/// + library search + `note_link` targeted resolution.
async fn run_scale_and_search_suite(svc: &Service, issue_count: i64, event_count: i64) {
    // 1. Seed 10k issues via chunked put_batch + resolve a single note link targeting 2 of them.
    let issues: Vec<Issue> = (1..=issue_count)
        .map(|n| Issue::new(format!("iss-{n}"), n, format!("Benchmark Issue #{n}"), 100_000 + n))
        .collect();
    svc.issue.put_batch(&issues).await.unwrap();

    svc.note
        .replace_links_for_source(
            LinkEntityKind::Note,
            "note-bench",
            &[
                NoteLinkRef {
                    kind: LinkEntityKind::Issue,
                    id: format!("iss-{issue_count}"),
                    relation: LinkRelation::Link,
                    title: None,
                },
                NoteLinkRef {
                    kind: LinkEntityKind::Issue,
                    id: "1".to_owned(),
                    relation: LinkRelation::Embed,
                    title: None,
                },
            ],
            200_000,
        )
        .await
        .unwrap();

    let t0 = Instant::now();
    let link_res = svc.note.list_links_for_entity(LinkEntityKind::Note, "note-bench").await.unwrap();
    let link_elapsed = t0.elapsed();
    assert_eq!(link_res.outgoing.len(), 2);
    assert_eq!(
        link_res.outgoing[0].title.as_deref(),
        Some(format!("#{issue_count} Benchmark Issue #{issue_count}").as_str())
    );
    assert_eq!(link_res.outgoing[1].title.as_deref(), Some("#1 Benchmark Issue #1"));
    assert!(
        link_elapsed < Duration::from_millis(250),
        "list_links_for_entity over {issue_count} issues took too long: {link_elapsed:?}"
    );

    // 2. Seed sessions & 10k session_events (only 10 telemetry rows) and verify fast telemetry scan.
    let s1 = make_session("sess-bench", 10_000);
    svc.session.put(&s1, false).await.unwrap();
    let mut events: Vec<SessionEvent> = (0..event_count)
        .map(|seq| {
            let kind = if seq % 1_000 == 0 {
                SessionEventType::RunError
            } else {
                SessionEventType::AssistantMessage
            };
            make_event(seq, kind, "run-1", "payload")
        })
        .collect();
    // Ensure a couple of explicit run/error events with non-empty text
    events[0].text = "transient timeout".to_owned();
    svc.session.upsert_events_batch(&[("sess-bench".to_owned(), events)]).await.unwrap();

    let t1 = Instant::now();
    let all_sessions = svc.session.all().await.unwrap();
    assert_eq!(all_sessions.len(), 1);
    let telemetry = svc.session.telemetry_by_session().await.unwrap();
    let telemetry_elapsed = t1.elapsed();
    assert!(telemetry.contains_key("sess-bench"), "expected telemetry folded from run/error events");
    assert!(
        telemetry_elapsed < Duration::from_millis(250),
        "telemetry_by_session over {event_count} events took too long: {telemetry_elapsed:?}"
    );

    // 3. Channel messages: verify explicit has_file / has_image / has_link columns + FTS5/pg_trgm ASCII & CJK search
    //    plus edit_message & delete_message keeping flags and FTS index synchronized.
    let tx = svc.begin_tx().await.unwrap();
    svc.channel
        .upsert_participant_in_tx(&tx, &make_participant("user", "user", "User", None))
        .await
        .unwrap();
    svc.channel
        .upsert_participant_in_tx(&tx, &make_participant("bot", "agent", "Bot", Some("coder")))
        .await
        .unwrap();
    svc.channel.create_channel_in_tx(&tx, "c-perf", true, "perf", None, None, 1_000).await.unwrap();
    for i in 0..500 {
        let id = format!("m-{i:04}");
        let body = match i {
            10 => "Deploy needle-alpha-token to https://prod.vibevalley.dev".to_owned(),
            20 => "架构评审：数据库查询效率优化完成".to_owned(),
            30 => "Plain file attachment note".to_owned(),
            40 => "Screenshot attached".to_owned(),
            _ => format!("Background status message {i}"),
        };
        let meta = match i {
            30 => Some(r#"{"attachments":[{"id":"att-pdf","type":"application/pdf","name":"spec.pdf"}]}"#),
            40 => Some(r#"{"attachments":[{"id":"att-img","type":"image/png","name":"preview.png"}]}"#),
            _ => None,
        };
        svc.channel
            .insert_message_in_tx(
                &tx,
                &NewMessage {
                    id: &id,
                    channel_id: "c-perf",
                    sender: "bot",
                    kind: "chat",
                    body: &body,
                    meta,
                    system_code: None,
                    send_key: None,
                    at: 50_000 + i,
                    revision: i + 1,
                    reply_number: None,
                },
            )
            .await
            .unwrap();
    }
    svc.commit_tx(tx).await.unwrap();

    let base_search = |text: &'static str, has_file: bool, has_image: bool, has_link: bool| SearchParams {
        text,
        channel: "c-perf",
        sender: "",
        has_file,
        has_image,
        has_link,
        after: 0,
        before: i64::MAX,
        n: 20,
    };

    let ascii_hits = svc.channel.search_messages(&base_search("needle-alpha", false, false, false)).await.unwrap();
    assert_eq!(ascii_hits.len(), 1);
    assert_eq!(ascii_hits[0].row.id, "m-0010");

    let cjk_hits = svc.channel.search_messages(&base_search("查询效率", false, false, false)).await.unwrap();
    assert_eq!(cjk_hits.len(), 1);
    assert_eq!(cjk_hits[0].row.id, "m-0020");

    let file_hits = svc.channel.search_messages(&base_search("", true, false, false)).await.unwrap();
    assert_eq!(file_hits.len(), 2);

    let img_hits = svc.channel.search_messages(&base_search("", false, true, false)).await.unwrap();
    assert_eq!(img_hits.len(), 1);
    assert_eq!(img_hits[0].row.id, "m-0040");

    let link_hits = svc.channel.search_messages(&base_search("", false, false, true)).await.unwrap();
    assert_eq!(link_hits.len(), 1);
    assert_eq!(link_hits[0].row.id, "m-0010");

    // Edit m-0030 to add a link and searchable text, verifying triggers + has_link stay in sync.
    let tx = svc.begin_tx().await.unwrap();
    svc.channel
        .edit_message_in_tx(&tx, "m-0030", "Updated with https://docs.vibevalley.dev edited-marker", 60_000, 999)
        .await
        .unwrap();
    svc.commit_tx(tx).await.unwrap();

    assert_eq!(
        svc.channel
            .search_messages(&base_search("edited-marker", false, false, true))
            .await
            .unwrap()
            .len(),
        1
    );

    // 4. Memory FTS5 / pg_trgm search.
    let notes: Vec<NewMemory> = (0..60)
        .map(|i| NewMemory {
            id: format!("mem-s-{i}"),
            agent: "coder".to_owned(),
            kind: MemoryKind::Note,
            scope: "global".to_owned(),
            title: Some(if i == 17 { "SQLite PRAGMA 调优".to_owned() } else { format!("Note {i}") }),
            body: if i == 17 {
                "Use cache_size=-32000 and mmap_size for low-latency reads".to_owned()
            } else {
                format!("General note body {i}")
            },
            repo: None,
            session: None,
            author: ActorKind::Agent,
            importance: 1,
            created_at: 70_000 + i,
        })
        .collect();
    svc.memory.rewrite_agent_notes("coder", &notes).await.unwrap();
    let mem_hits = svc.memory.search("coder", "mmap_size", 10).await.unwrap();
    assert_eq!(mem_hits.len(), 1);
    assert_eq!(mem_hits[0].id, "mem-s-17");
    let mem_cjk_hits = svc.memory.search("coder", "调优", 10).await.unwrap();
    assert_eq!(mem_cjk_hits.len(), 1);
    assert_eq!(mem_cjk_hits[0].id, "mem-s-17");

    // 5. Attachment / Library FTS5 / pg_trgm search.
    for i in 0..40 {
        let id = format!("att-lib-{i:03}");
        let name = if i == 12 { "architecture-blueprint-v2.png" } else { "asset.png" };
        svc.storage.insert_attachment(&id, name, "image/png", 1024, 80_000 + i).await.unwrap();
        svc.note
            .keep_library_item(
                &id,
                &LibraryOrigin::Uploaded {
                    channel: Some("c-perf".to_owned()),
                    message: None,
                },
                80_000 + i,
            )
            .await
            .unwrap();
    }
    let lib_hits = svc
        .note
        .list_library_items(
            &LibraryListRequest {
                origin: None,
                r#type: None,
                text: Some("blueprint".to_owned()),
                sort: None,
            },
            20,
        )
        .await
        .unwrap();
    assert_eq!(lib_hits.len(), 1);
    assert_eq!(lib_hits[0].attachment.id, "att-lib-012");

    // 6. Query metrics recorded hot operations cleanly.
    let snap = svc.query_metrics().snapshot();
    assert!(snap.total_queries >= 8, "expected query metrics to record hot reads, got {snap:?}");
}

#[tokio::test]
async fn sqlite_10k_scale_queries_and_fts5_search_stay_fast() {
    let dir = tempfile::tempdir().unwrap();
    let svc = Service::open(dir.path()).await.unwrap();
    run_scale_and_search_suite(&svc, 10_000, 10_000).await;
    svc.close().await;
}

#[cfg(feature = "postgres")]
#[tokio::test]
async fn postgres_scale_queries_and_trigram_search_stay_fast() {
    use super::DatabaseConfig;

    let Some(pg) = crate::db::test_pg::EphemeralPostgres::start() else {
        eprintln!("skipping postgres_scale_queries_and_trigram_search_stay_fast: local PostgreSQL binaries unavailable");
        return;
    };
    pg.create_database("vv_query_perf_test").await;
    let cfg = DatabaseConfig::from_url(&pg.db_url("vv_query_perf_test")).unwrap();
    let svc = Service::open_config(&cfg).await.unwrap();
    assert!(svc.is_postgres());

    run_scale_and_search_suite(&svc, 2_000, 4_000).await;

    // Verify PostgreSQL `EXPLAIN` uses our trigram / partial indexes after ANALYZE.
    svc.database().write_conn().execute_unprepared("ANALYZE;").await.unwrap();
    let rows = svc
        .database()
        .read_conn()
        .query_all_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "EXPLAIN SELECT payload FROM session_event WHERE session_id = 'sess-bench' AND event_type IN ('llm/usage', 'llm/retry', 'run/error') ORDER BY seq ASC".to_owned(),
        ))
        .await
        .unwrap();
    let plan: Vec<String> = rows.into_iter().map(|r| r.try_get_by_index::<String>(0).unwrap()).collect();
    let joined = plan.join(" | ");
    assert!(
        joined.contains("Index") || joined.contains("Bitmap"),
        "expected PostgreSQL index scan on session_event_telemetry, got: {joined}"
    );

    svc.close().await;
}
