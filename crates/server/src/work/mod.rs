pub mod chat;
pub mod cron;
pub mod issue;
pub mod ledger;
pub mod pull;
pub mod repo;
pub mod session;
pub mod workplace;

pub(crate) fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    vibevalley_runtime::rt::block_on(fut)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sea_orm::DatabaseBackend;
    use vibevalley_protocol::{
        ActorKind, Cron, CronWhen, CronWhenOnce, ExecutionPolicy, Fact, Issue, Outcome, PublishPlatform, PullRequestState, Run, RunTrigger, RunTriggerKind,
        Session, SessionController, SessionEvent, SessionEventType, SessionPermissionMode, SessionSubagents,
    };

    use super::block_on;
    use super::cron::db as cron_db;
    use super::issue::{SqliteIssueStore, db as issue_db};
    use super::ledger::{Ledger, LocalFacts};
    use super::pull::{PullStore, UpsertPullInput};
    use super::session::mailbox::{MailboxSource, MailboxStatus, SessionMailbox};
    use super::session::{SqliteSessionStore, db as session_db};
    use crate::db::ServerDb;
    use crate::db::test_pg::EphemeralPostgres;

    fn verify_work_dual_db(db: Arc<ServerDb>, expected_backend: DatabaseBackend) {
        assert_eq!(db.backend(), expected_backend);

        // 1. Ledger + issue + sequence persistence inside durable tx
        let (ledger, opened) = Ledger::open(
            db.clone(),
            Arc::new(LocalFacts::default()),
            Arc::new(SqliteIssueStore),
            Arc::new(SqliteSessionStore),
        )
        .unwrap();
        assert!(opened.interrupted.is_empty());

        let n1 = ledger.next("issue", 0).unwrap();
        let n2 = ledger.next("issue", 10).unwrap();
        assert_eq!(n1, 1);
        assert_eq!(n2, 11);

        let mut iss1 = Issue::new("iss-1", n1, "First issue", 100);
        iss1.description = "details".into();
        let iss2 = Issue::new("iss-2", n2, "Second issue", 101);
        ledger
            .apply(vec![Fact::issue_changed(100, iss1.clone()), Fact::issue_changed(101, iss2)])
            .unwrap();

        // Queued words survive subsequent PutIssue ON CONFLICT DO UPDATE
        ledger.write_db(async |c| issue_db::keep_words(c, "iss-1", "follow up").await).unwrap();
        let mut iss1_updated = iss1.clone();
        iss1_updated.title = "First issue updated".into();
        ledger.apply(vec![Fact::issue_changed(102, iss1_updated)]).unwrap();
        let kept = ledger.write_db(async |c| issue_db::take_words(c, "iss-1").await).unwrap();
        assert_eq!(kept, vec!["follow up".to_string()]);
        assert!(ledger.write_db(async |c| issue_db::take_words(c, "iss-1").await).unwrap().is_empty());

        // 2. Session, runs, subagents, reconciliation join, config, extras, mailbox, events
        let s1 = Session::new("s-1", SessionController::IssueBoard, "Alice", "scripted", ExecutionPolicy::SandboxDir, 200);
        let s2 = Session::new("s-2", SessionController::User, "Bob", "scripted", ExecutionPolicy::SandboxDir, 201);
        ledger
            .apply(vec![Fact::session_changed(200, s1.clone()), Fact::session_changed(201, s2.clone())])
            .unwrap();

        let cfg = session_db::SessionConfig {
            title: Some("Workspace".into()),
            model: Some("claude".into()),
            effort: Some("high".into()),
            permission_mode: Some(SessionPermissionMode::AcceptEdits),
        };
        ledger.write_db(async |c| session_db::put_config(c, "s-2", &cfg).await).unwrap();
        assert_eq!(ledger.read_db(async |c| session_db::config(c, "s-2").await).unwrap(), Some(cfg));

        let extra = super::session::Extra {
            agent_session: Some("vendor-1".into()),
            base: Some("main".into()),
            run: Some("r1".into()),
        };
        ledger.write_db(async |c| session_db::put_extra(c, "s-1", &extra).await).unwrap();
        let extras = ledger.read_db(async |c| session_db::extras(c).await).unwrap();
        assert_eq!(extras.get("s-1").and_then(|e| e.run.as_deref()), Some("r1"));

        let run1 = Run {
            id: "r1".into(),
            session: "s-1".into(),
            issue: Some("iss-1".into()),
            triggered_by: RunTrigger {
                kind: RunTriggerKind::Issue,
                message: Some("start".into()),
                channel: None,
                cron: None,
                missed: None,
            },
            heard: vec!["req-1".into()],
            started_at: 300,
            ended_at: Some(310),
            outcome: Some(Outcome::Completed),
            summary: "done".into(),
            spent: None,
            subagents: None,
            needs_reconciliation: false,
        };
        let subagents = SessionSubagents {
            run: "r1".into(),
            root_thread_id: "vendor-1".into(),
            disconnected_at: None,
            threads: vec![],
            waits: vec![],
        };
        ledger
            .durable
            .write(|tx| {
                block_on(session_db::put_run(tx.transaction(), &run1))?;
                block_on(session_db::put_subagents(tx.transaction(), &subagents))?;
                tx.put_document("run", "r1", "workspace.reconciliation", &serde_json::json!({"branch": "b1"}))?;
                Ok(())
            })
            .unwrap();

        let loaded_run = ledger.read_db(async |c| session_db::run(c, "r1").await).unwrap().unwrap();
        assert!(loaded_run.needs_reconciliation);
        assert_eq!(loaded_run.subagents.as_ref().map(|s| s.run.as_str()), Some("r1"));
        let issue_runs = ledger.read_db(async |c| session_db::runs(c, "iss-1").await).unwrap();
        assert_eq!(issue_runs.len(), 1);

        // Depart s-2 and verify past_session works
        ledger.apply(vec![Fact::session_left(250, "s-2", None)]).unwrap();
        assert!(ledger.session("s-2").is_none());
        assert_eq!(ledger.past_session("s-2").map(|s| s.id), Some("s-2".into()));

        // Mailbox idempotency, claim_next, withdraw_by_message, settle
        let m1 = block_on(SessionMailbox::enqueue(
            db.write_conn(),
            "s-1",
            "k-1",
            MailboxSource::WorkspaceUser,
            None,
            "hello",
            400,
        ))
        .unwrap();
        let m1_dup = block_on(SessionMailbox::enqueue(
            db.write_conn(),
            "s-1",
            "k-1",
            MailboxSource::WorkspaceUser,
            None,
            "ignored",
            401,
        ))
        .unwrap();
        assert_eq!(m1_dup.id, m1.id);
        assert_eq!(m1_dup.payload, "hello");

        block_on(SessionMailbox::enqueue(
            db.write_conn(),
            "s-1",
            "k-2",
            MailboxSource::ChannelDirect,
            Some("msg-9"),
            "withdrawable",
            402,
        ))
        .unwrap();
        assert_eq!(block_on(SessionMailbox::withdraw_by_message(db.write_conn(), "msg-9", 403)).unwrap(), 1);
        let claimed = block_on(SessionMailbox::claim_next(db.write_conn(), "s-1", 404)).unwrap().unwrap();
        assert_eq!(claimed.id, m1.id);
        assert_eq!(claimed.status, MailboxStatus::Claimed);
        block_on(SessionMailbox::settle(db.write_conn(), claimed.id, true, Some("ok"), 405)).unwrap();
        let listed = block_on(SessionMailbox::list(db.read_conn(), "s-1")).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].status, MailboxStatus::Done);
        assert_eq!(listed[1].status, MailboxStatus::Withdrawn);

        // Session events
        let evs = vec![
            SessionEvent {
                seq: 0,
                revision: 0,
                time: 500,
                r#type: SessionEventType::UserMessage,
                run: Some("r1".into()),
                call: None,
                under: None,
                thread_id: None,
                text: "hi".into(),
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
            },
            SessionEvent {
                seq: 1,
                revision: 0,
                time: 501,
                r#type: SessionEventType::AssistantMessage,
                run: Some("r1".into()),
                call: None,
                under: None,
                thread_id: None,
                text: "yo".into(),
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
            },
        ];
        block_on(session_db::upsert_events(db.write_conn(), "s-1", &evs)).unwrap();
        assert_eq!(block_on(session_db::max_event_seq(db.read_conn(), "s-1")).unwrap(), 1);
        assert_eq!(block_on(session_db::list_events_tail(db.read_conn(), "s-1", "r1", 10)).unwrap().len(), 2);
        assert_eq!(block_on(session_db::list_events_after(db.read_conn(), "s-1", "r1", 0, 10)).unwrap().len(), 1);
        assert_eq!(block_on(session_db::list_events_before(db.read_conn(), "s-1", "r1", 1, 10)).unwrap().len(), 1);
        block_on(session_db::delete_events(db.write_conn(), "s-1")).unwrap();
        assert_eq!(block_on(session_db::max_event_seq(db.read_conn(), "s-1")).unwrap(), -1);

        // 3. Cron persistence + bool fields + FK ON DELETE SET NULL
        let cron = Cron {
            id: "cron-1".into(),
            name: "daily".into(),
            text: "check".into(),
            channel: "general".into(),
            agent: None,
            repo: None,
            when: CronWhen::Once(CronWhenOnce { at: 9_999_999 }),
            tz: "UTC".into(),
            enabled: true,
            created: 600,
            last_run: None,
            by: ActorKind::User,
            pending: false,
        };
        block_on(cron_db::upsert(db.write_conn(), &cron, Some("iss-2"))).unwrap();
        let crons = block_on(cron_db::list(db.read_conn())).unwrap();
        assert_eq!(crons.len(), 1);
        assert!(crons[0].cron.enabled);
        assert!(!crons[0].cron.pending);
        assert_eq!(crons[0].issue_id.as_deref(), Some("iss-2"));

        ledger.apply(vec![Fact::issue_removed(601, "iss-2")]).unwrap();
        let crons_after_delete = block_on(cron_db::list(db.read_conn())).unwrap();
        assert_eq!(crons_after_delete[0].issue_id, None);
        block_on(cron_db::remove(db.write_conn(), "cron-1")).unwrap();
        assert!(block_on(cron_db::list(db.read_conn())).unwrap().is_empty());

        // 4. PullStore persistence + ON CONFLICT COALESCE + pull_event ON CONFLICT DO NOTHING
        let pulls = PullStore::open(db.clone()).unwrap();
        let p = block_on(pulls.upsert_async(UpsertPullInput {
            platform: PublishPlatform::Github,
            repo: "acme/app".into(),
            number: 7,
            url: "https://github.com/acme/app/pull/7".into(),
            branch: "feat/x".into(),
            base: "main".into(),
            state: PullRequestState::Open,
            issue_id: Some("iss-1".into()),
            at: 700,
        }))
        .unwrap();
        let p_up = block_on(pulls.upsert_async(UpsertPullInput {
            platform: PublishPlatform::Github,
            repo: "acme/app".into(),
            number: 7,
            url: "https://github.com/acme/app/pull/7".into(),
            branch: "feat/x".into(),
            base: "main".into(),
            state: PullRequestState::Merged,
            issue_id: None,
            at: 701,
        }))
        .unwrap();
        assert_eq!(p_up.id, p.id);
        assert_eq!(p_up.issue_id.as_deref(), Some("iss-1"));
        assert_eq!(p_up.state, PullRequestState::Merged);

        block_on(pulls.observe_checks_async(&p.id, "fp1", 1, 702)).unwrap();
        block_on(pulls.keep_event_async(&p.id, "ev-1", Some("rk-1"), Some(1))).unwrap();
        block_on(pulls.keep_event_async(&p.id, "ev-1", Some("rk-1"), Some(1))).unwrap();
        let known = block_on(pulls.known_events_async(&p.id)).unwrap();
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].bot_round, Some(1));

        let reopened_pulls = PullStore::open(db.clone()).unwrap();
        assert_eq!(reopened_pulls.find("acme/app", 7).unwrap().check_revision, 1);

        // 5. Reopen Ledger on fresh LocalFacts to verify end-to-end reload from DB
        let (reloaded, _) = Ledger::open(db, Arc::new(LocalFacts::default()), Arc::new(SqliteIssueStore), Arc::new(SqliteSessionStore)).unwrap();
        assert_eq!(reloaded.issue("iss-1").unwrap().title, "First issue updated");
        assert!(reloaded.issue("iss-2").is_none());
        let reloaded_s1 = reloaded.session("s-1").unwrap();
        assert_eq!(reloaded_s1.subagents.as_ref().map(|s| s.run.as_str()), Some("r1"));
        assert!(reloaded.session("s-2").is_none());
    }

    #[test]
    fn work_domain_persists_across_sqlite_and_postgres() {
        let dir = tempfile::tempdir().unwrap();
        let sqlite_url = format!("sqlite://{}", dir.path().join("work-sqlite.db").display());
        let sqlite_db = ServerDb::open_url(&sqlite_url).unwrap();
        verify_work_dual_db(sqlite_db.clone(), DatabaseBackend::Sqlite);
        sqlite_db.close();

        let Some(pg) = EphemeralPostgres::start() else {
            eprintln!("skipping postgres branch of work_domain_persists_across_sqlite_and_postgres: initdb/pg_ctl not found");
            return;
        };
        pg.create_database("work_wave3_dual");
        let pg_db = ServerDb::open_url(&pg.db_url("work_wave3_dual")).unwrap();
        verify_work_dual_db(pg_db.clone(), DatabaseBackend::Postgres);
        pg_db.close();
    }
}
