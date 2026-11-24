pub mod chat;
pub mod cron;
pub mod issue;
pub mod ledger;
pub mod pull;
pub mod repo;
pub mod session;
pub mod workplace;

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sea_orm::DatabaseBackend;
    use vibevalley_protocol::{
        ActorKind, Cron, CronWhen, CronWhenOnce, ExecutionPolicy, Issue, Outcome, PublishPlatform, PullRequestState, Run, RunTrigger, RunTriggerKind, Session,
        SessionController, SessionEvent, SessionEventType, SessionPermissionMode, SessionSubagents, SliceMask,
    };

    use super::cron::db as cron_db;
    use super::issue::{SqliteIssueStore, db as issue_db};
    use super::ledger::Ledger;
    use super::pull::{PullRepo, UpsertPullInput};
    use super::session::mailbox::{MailboxSource, MailboxStatus, SessionMailbox};
    use super::session::{SqliteSessionStore, db as session_db};
    use crate::app::{live::LiveOverlay, outbox::Outbox, slice::SliceProjector};
    use crate::db::ServerDb;
    use crate::db::test_pg::EphemeralPostgres;

    async fn verify_work_dual_db_async(db: Arc<ServerDb>, expected_backend: DatabaseBackend) {
        assert_eq!(db.backend(), expected_backend);

        // 1. Ledger + issue + sequence persistence inside durable tx
        let live = Arc::new(LiveOverlay::new());
        let projector = Arc::new(SliceProjector::new());
        let outbox = Arc::new(Outbox::new(db.clone()));
        let (ledger, opened) = Ledger::open_async(
            db.clone(),
            live.clone(),
            projector.clone(),
            outbox.clone(),
            Arc::new(SqliteIssueStore),
            Arc::new(SqliteSessionStore),
        )
        .await
        .unwrap();
        assert!(opened.interrupted.is_empty());

        let n1 = ledger.next_async("issue", 0).await.unwrap();
        let n2 = ledger.next_async("issue", 10).await.unwrap();
        assert_eq!(n1, 1);
        assert_eq!(n2, 11);

        let mut iss1 = Issue::new("iss-1", n1, "First issue", 100);
        iss1.description = "details".into();
        let iss2 = Issue::new("iss-2", n2, "Second issue", 101);
        ledger.put_issues_async(&[iss1.clone(), iss2]).await.unwrap();

        // Queued words survive subsequent PutIssue ON CONFLICT DO UPDATE
        ledger
            .write_db_async(async |c| issue_db::keep_words(c, "iss-1", "follow up").await)
            .await
            .unwrap();
        let mut iss1_updated = iss1.clone();
        iss1_updated.title = "First issue updated".into();
        ledger.put_issues_async(&[iss1_updated]).await.unwrap();
        let kept = ledger.write_db_async(async |c| issue_db::take_words(c, "iss-1").await).await.unwrap();
        assert_eq!(kept, vec!["follow up".to_string()]);
        assert!(
            ledger
                .write_db_async(async |c| issue_db::take_words(c, "iss-1").await)
                .await
                .unwrap()
                .is_empty()
        );

        // 2. Session, runs, subagents, reconciliation join, config, extras, mailbox, events
        let s1 = Session::new("s-1", SessionController::IssueBoard, "Alice", "scripted", ExecutionPolicy::SandboxDir, 200);
        let s2 = Session::new("s-2", SessionController::User, "Bob", "scripted", ExecutionPolicy::SandboxDir, 201);
        ledger
            .commit_tx_async(SliceMask::SESSIONS, move |tx, _, session_store| {
                Box::pin(async move {
                    session_store.put(tx, &s1, false).await?;
                    session_store.put(tx, &s2, false).await?;
                    Ok(((), false))
                })
            })
            .await
            .unwrap();

        let cfg = session_db::SessionConfig {
            title: Some("Workspace".into()),
            model: Some("claude".into()),
            effort: Some("high".into()),
            permission_mode: Some(SessionPermissionMode::AcceptEdits),
        };
        ledger.write_db_async(async |c| session_db::put_config(c, "s-2", &cfg).await).await.unwrap();
        assert_eq!(ledger.read_db_async(async |c| session_db::config(c, "s-2").await).await.unwrap(), Some(cfg));

        let extra = super::session::Extra {
            agent_session: Some("vendor-1".into()),
            base: Some("main".into()),
            run: Some("r1".into()),
        };
        ledger.write_db_async(async |c| session_db::put_extra(c, "s-1", &extra).await).await.unwrap();
        let extras = ledger.read_db_async(async |c| session_db::extras(c).await).await.unwrap();
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
            .write_with_async((&run1, &subagents), |tx, (run1, subagents)| {
                let run1 = (*run1).clone();
                let subagents = (*subagents).clone();
                Box::pin(async move {
                    session_db::put_run(tx.transaction(), &run1)
                        .await
                        .map_err(|e| vibevalley_runtime::agent::durable::Error::Invalid(e.to_string()))?;
                    session_db::put_subagents(tx.transaction(), &subagents)
                        .await
                        .map_err(|e| vibevalley_runtime::agent::durable::Error::Invalid(e.to_string()))?;
                    tx.put_document_async("run", "r1", "workspace.reconciliation", &serde_json::json!({"branch": "b1"}))
                        .await?;
                    Ok(())
                })
            })
            .await
            .unwrap();

        let loaded_run = ledger.read_db_async(async |c| session_db::run(c, "r1").await).await.unwrap().unwrap();
        assert!(loaded_run.needs_reconciliation);
        assert_eq!(loaded_run.subagents.as_ref().map(|s| s.run.as_str()), Some("r1"));
        let issue_runs = ledger.read_db_async(async |c| session_db::runs(c, "iss-1").await).await.unwrap();
        assert_eq!(issue_runs.len(), 1);

        // Depart s-2 and verify past_session_async works
        ledger
            .commit_tx_async(SliceMask::SESSIONS, |tx, _, session_store| {
                Box::pin(async move {
                    session_store.leave(tx, "s-2", 250).await?;
                    Ok(((), false))
                })
            })
            .await
            .unwrap();
        assert!(ledger.session_async("s-2").await.unwrap().is_none());
        assert_eq!(ledger.past_session_async("s-2").await.map(|s| s.id), Some("s-2".into()));

        // Mailbox idempotency, claim_next, withdraw_by_message, settle
        let m1 = SessionMailbox::enqueue(db.write_conn(), "s-1", "k-1", MailboxSource::WorkspaceUser, None, "hello", 400)
            .await
            .unwrap();
        let m1_dup = SessionMailbox::enqueue(db.write_conn(), "s-1", "k-1", MailboxSource::WorkspaceUser, None, "ignored", 401)
            .await
            .unwrap();
        assert_eq!(m1_dup.id, m1.id);
        assert_eq!(m1_dup.payload, "hello");

        SessionMailbox::enqueue(db.write_conn(), "s-1", "k-2", MailboxSource::ChannelDirect, Some("msg-9"), "withdrawable", 402)
            .await
            .unwrap();
        assert_eq!(SessionMailbox::withdraw_by_message(db.write_conn(), "msg-9", 403).await.unwrap(), 1);
        let claimed = SessionMailbox::claim_next(db.write_conn(), "s-1", 404).await.unwrap().unwrap();
        assert_eq!(claimed.id, m1.id);
        assert_eq!(claimed.status, MailboxStatus::Claimed);
        SessionMailbox::settle(db.write_conn(), claimed.id, true, Some("ok"), 405).await.unwrap();
        let listed = SessionMailbox::list(db.read_conn(), "s-1").await.unwrap();
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
        session_db::upsert_events(db.write_conn(), "s-1", &evs).await.unwrap();
        assert_eq!(session_db::max_event_seq(db.read_conn(), "s-1").await.unwrap(), 1);
        assert_eq!(session_db::list_events_tail(db.read_conn(), "s-1", "r1", 10).await.unwrap().len(), 2);
        assert_eq!(session_db::list_events_after(db.read_conn(), "s-1", "r1", 0, 10).await.unwrap().len(), 1);
        assert_eq!(session_db::list_events_before(db.read_conn(), "s-1", "r1", 1, 10).await.unwrap().len(), 1);
        session_db::delete_events(db.write_conn(), "s-1").await.unwrap();
        assert_eq!(session_db::max_event_seq(db.read_conn(), "s-1").await.unwrap(), -1);

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
        cron_db::upsert(db.write_conn(), &cron, Some("iss-2")).await.unwrap();
        let crons = cron_db::list(db.read_conn()).await.unwrap();
        assert_eq!(crons.len(), 1);
        assert!(crons[0].cron.enabled);
        assert!(!crons[0].cron.pending);
        assert_eq!(crons[0].issue_id.as_deref(), Some("iss-2"));

        ledger.remove_issue_async("iss-2").await.unwrap();
        let crons_after_delete = cron_db::list(db.read_conn()).await.unwrap();
        assert_eq!(crons_after_delete[0].issue_id, None);
        cron_db::remove(db.write_conn(), "cron-1").await.unwrap();
        assert!(cron_db::list(db.read_conn()).await.unwrap().is_empty());

        // 4. PullRepo persistence + ON CONFLICT COALESCE + pull_event ON CONFLICT DO NOTHING
        let pulls = PullRepo::open_async(db.clone()).await.unwrap();
        let p = pulls
            .upsert_async(UpsertPullInput {
                platform: PublishPlatform::Github,
                repo: "acme/app".into(),
                number: 7,
                url: "https://github.com/acme/app/pull/7".into(),
                branch: "feat/x".into(),
                base: "main".into(),
                state: PullRequestState::Open,
                issue_id: Some("iss-1".into()),
                at: 700,
            })
            .await
            .unwrap();
        let p_up = pulls
            .upsert_async(UpsertPullInput {
                platform: PublishPlatform::Github,
                repo: "acme/app".into(),
                number: 7,
                url: "https://github.com/acme/app/pull/7".into(),
                branch: "feat/x".into(),
                base: "main".into(),
                state: PullRequestState::Merged,
                issue_id: None,
                at: 701,
            })
            .await
            .unwrap();
        assert_eq!(p_up.id, p.id);
        assert_eq!(p_up.issue_id.as_deref(), Some("iss-1"));
        assert_eq!(p_up.state, PullRequestState::Merged);

        pulls.observe_checks_async(&p.id, "fp1", 1, 702).await.unwrap();
        pulls.keep_event_async(&p.id, "ev-1", Some("rk-1"), Some(1)).await.unwrap();
        pulls.keep_event_async(&p.id, "ev-1", Some("rk-1"), Some(1)).await.unwrap();
        let known = pulls.known_events_async(&p.id).await.unwrap();
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].bot_round, Some(1));

        let reopened_pulls = PullRepo::open_async(db.clone()).await.unwrap();
        assert_eq!(reopened_pulls.find("acme/app", 7).unwrap().check_revision, 1);

        // 5. Reopen Ledger on fresh spine primitives to verify end-to-end reload from DB
        let (reloaded, _) = Ledger::open_async(db, live, projector, outbox, Arc::new(SqliteIssueStore), Arc::new(SqliteSessionStore))
            .await
            .unwrap();
        assert_eq!(reloaded.issue_async("iss-1").await.unwrap().unwrap().title, "First issue updated");
        assert!(reloaded.issue_async("iss-2").await.unwrap().is_none());
        let reloaded_s1 = reloaded.session_async("s-1").await.unwrap().unwrap();
        assert_eq!(reloaded_s1.subagents.as_ref().map(|s| s.run.as_str()), Some("r1"));
        assert!(reloaded.session_async("s-2").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn work_domain_persists_across_sqlite_and_postgres() {
        let dir = tempfile::tempdir().unwrap();
        let sqlite_url = format!("sqlite://{}", dir.path().join("work-sqlite.db").display());
        let sqlite_db = ServerDb::open_url(&sqlite_url).unwrap();
        verify_work_dual_db_async(sqlite_db.clone(), DatabaseBackend::Sqlite).await;
        sqlite_db.close_async().await;

        let Some(pg) = EphemeralPostgres::start() else {
            eprintln!("skipping postgres branch of work_domain_persists_across_sqlite_and_postgres: initdb/pg_ctl not found");
            return;
        };
        pg.create_database("work_wave3_dual");
        let pg_db = ServerDb::open_url(&pg.db_url("work_wave3_dual")).unwrap();
        verify_work_dual_db_async(pg_db.clone(), DatabaseBackend::Postgres).await;
        pg_db.close_async().await;
    }
}
