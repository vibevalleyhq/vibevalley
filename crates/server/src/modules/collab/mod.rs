pub mod channel;
pub mod connector;
pub mod voice;

use sea_orm::{DatabaseConnection, DatabaseTransaction, DbBackend, DbErr, SqliteTransactionMode, TransactionOptions, TransactionTrait};

/// Begins a write transaction (`BEGIN IMMEDIATE` on SQLite so read-then-write
/// upgrades never fail with `SQLITE_BUSY`, standard transaction on PostgreSQL).
pub(super) async fn begin_write_tx(conn: &DatabaseConnection) -> Result<DatabaseTransaction, DbErr> {
    let opts = match conn.get_database_backend() {
        DbBackend::Sqlite => TransactionOptions {
            sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
            ..Default::default()
        },
        _ => TransactionOptions::default(),
    };
    conn.begin_with_options(opts).await
}

/// Sync bridge for non-async callers at collab boundaries.
pub(super) fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    vibevalley_runtime::rt::block_on(fut)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use sea_orm::{ColumnTrait, Database, EntityTrait, QueryFilter};
    use vibevalley_protocol::{ChannelUpdate, ConnectorID, MessageKind, Notify, SubjectKind, USER_ID};

    use super::block_on;
    use crate::Hub;
    use crate::base::ServerDb;
    use crate::db::entities::collab_channel::channel_message;
    use crate::modules::collab::channel::{Chat, DeliveryTargetKind, Noticing, Posting, ReadOptions, Saying, Seat, ThreadSubject, db};
    use crate::modules::collab::connector::adapter::Inbound;
    use crate::modules::collab::connector::store::Store;
    use crate::modules::content::attachment::Attachments;
    use crate::modules::infra::setting::Secret;

    struct EphemeralPostgres {
        data_dir: PathBuf,
        pg_ctl: PathBuf,
        port: u16,
        _temp: tempfile::TempDir,
    }

    impl EphemeralPostgres {
        fn start() -> Option<Self> {
            let initdb = ["/opt/homebrew/bin/initdb", "/usr/local/bin/initdb"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;
            let pg_ctl = ["/opt/homebrew/bin/pg_ctl", "/usr/local/bin/pg_ctl"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;

            let temp = tempfile::tempdir().ok()?;
            let data_dir = temp.path().join("pgdata");
            let sock_dir = temp.path().join("sock");
            std::fs::create_dir_all(&sock_dir).ok()?;

            let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
            let port = listener.local_addr().ok()?.port();
            drop(listener);

            let init = std::process::Command::new(&initdb)
                .arg("-D")
                .arg(&data_dir)
                .args(["--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-sync"])
                .output()
                .ok()?;
            assert!(init.status.success(), "initdb failed: {}", String::from_utf8_lossy(&init.stderr));

            use std::io::Write;
            let conf = format!(
                "\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = '{}'\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n",
                sock_dir.display()
            );
            std::fs::OpenOptions::new()
                .append(true)
                .open(data_dir.join("postgresql.conf"))
                .unwrap()
                .write_all(conf.as_bytes())
                .unwrap();

            let log = temp.path().join("postgres.log");
            let start = std::process::Command::new(&pg_ctl)
                .arg("-D")
                .arg(&data_dir)
                .arg("-l")
                .arg(&log)
                .args(["-w", "start"])
                .output()
                .ok()?;
            assert!(
                start.status.success(),
                "pg_ctl start failed: {}\nlog:\n{}",
                String::from_utf8_lossy(&start.stderr),
                std::fs::read_to_string(&log).unwrap_or_default()
            );

            Some(Self {
                data_dir,
                pg_ctl,
                port,
                _temp: temp,
            })
        }

        fn create_database(&self, db_name: &str) {
            let admin_url = format!("postgres://postgres@127.0.0.1:{}/postgres", self.port);
            let name = db_name.to_owned();
            super::block_on(async move {
                let db = Database::connect(&admin_url).await.expect("connect postgres admin db");
                sea_orm::ConnectionTrait::execute_unprepared(&db, &format!("CREATE DATABASE \"{name}\""))
                    .await
                    .expect("create test database");
                db.close().await.expect("close admin db");
            });
        }

        fn db_url(&self, db_name: &str) -> String {
            format!("postgres://postgres@127.0.0.1:{}/{}", self.port, db_name)
        }
    }

    impl Drop for EphemeralPostgres {
        fn drop(&mut self) {
            let _ = std::process::Command::new(&self.pg_ctl)
                .arg("-D")
                .arg(&self.data_dir)
                .args(["-m", "immediate", "-w", "stop"])
                .output();
        }
    }

    async fn verify_dual_db_collab(db: &Arc<ServerDb>, home: &std::path::Path) {
        let hub = Hub::new(vibevalley_core::empty_space_state());
        let files = Attachments::open(home, db.clone());
        let chat = Chat::open_async(db.clone(), &hub, files, None, false).await.unwrap();

        let general_id = chat.default_channel();
        assert!(!general_id.is_empty());

        // Channel CRUD + update + archive + notify
        let eng = chat.open_channel_async("eng", "Engineering channel", "").await.unwrap();
        assert!(!eng.default);
        chat.update_channel_async(
            &eng.id,
            ChannelUpdate {
                description: Some("Updated eng".into()),
                ..ChannelUpdate::default()
            },
        )
        .await
        .unwrap();
        chat.archive_async(&eng.id, true).await.unwrap();
        chat.archive_async(&eng.id, false).await.unwrap();
        chat.set_notify_async(&eng.id, Notify::All).await.unwrap();

        // User says a message mentioning orchestrator with send_key idempotency
        let (u_msg, again1) = chat
            .say_async(Saying {
                channel: Some(eng.id.clone()),
                text: "check https://example.com/spec @orchestrator".into(),
                send_key: "sk-eng-1".into(),
                ..Saying::default()
            })
            .await
            .unwrap();
        assert!(!again1);
        let (u_msg_dup, again2) = chat
            .say_async(Saying {
                channel: Some(eng.id.clone()),
                text: "check https://example.com/spec @orchestrator".into(),
                send_key: "sk-eng-1".into(),
                ..Saying::default()
            })
            .await
            .unwrap();
        assert!(again2);
        assert_eq!(u_msg.id, u_msg_dup.id);

        // system_code population and notice_since_user suppression
        chat.notice_async(Noticing {
            channel: eng.id.clone(),
            text: "hop limit reached once".into(),
            code: "hop_limit".into(),
            send_key: "notice-hop-1".into(),
            until_user_speaks: true,
        })
        .await;
        assert_eq!(db::notice_since_user(db.read_conn(), &eng.id, "hop_limit").await.unwrap(), 1);

        let sys_entity = channel_message::Entity::find()
            .filter(channel_message::Column::ChannelId.eq(&eng.id))
            .filter(channel_message::Column::SystemCode.eq("hop_limit"))
            .one(db.read_conn())
            .await
            .unwrap()
            .expect("system_code row must exist");
        assert_eq!(sys_entity.kind, "notice");

        // Second notice with until_user_speaks=true is suppressed
        chat.notice_async(Noticing {
            channel: eng.id.clone(),
            text: "hop limit suppressed".into(),
            code: "hop_limit".into(),
            send_key: "notice-hop-2".into(),
            until_user_speaks: true,
        })
        .await;
        assert_eq!(db::notice_since_user(db.read_conn(), &eng.id, "hop_limit").await.unwrap(), 1);

        // Thread creation + joined detail/location queries (no legacy views)
        let thread_id = chat.thread_under_async(&u_msg.id).await.unwrap();
        let (orch_post, _) = chat
            .post_async(Posting {
                from: "orchestrator".into(),
                channel: thread_id.clone(),
                text: "working on @user request".into(),
                send_key: "orch-reply-1".into(),
                ..Posting::default()
            })
            .await
            .unwrap();

        // Seat a helper agent and post a report
        let helper = Seat {
            id: "worker-1".into(),
            name: "Worker One".into(),
            agent: Some("coder".into()),
            home: Some(thread_id.clone()),
        };
        chat.seat_async(&helper).await.unwrap();
        chat.add_follower_async(&thread_id, &helper.id).await.unwrap();
        let (report_msg, _) = chat
            .post_async(Posting {
                from: helper.id.clone(),
                channel: thread_id.clone(),
                text: "done report".into(),
                send_key: "rep-1".into(),
                ..Posting::default()
            })
            .await
            .unwrap();
        let (report_2, _) = chat
            .note_once_async(
                crate::modules::collab::channel::Note {
                    channel: thread_id.clone(),
                    from: helper.id.clone(),
                    kind: MessageKind::Report,
                    text: "formal report".into(),
                    meta: Default::default(),
                    topic: None,
                    member: None,
                    seat: None,
                },
                Some("formal-rep-1".into()),
            )
            .await
            .map(|_| (report_msg.clone(), false))
            .unwrap();
        let _ = report_2;
        chat.pin_async(&report_msg.id, true).await.unwrap();
        chat.react_async(&report_msg.id, USER_ID, "👍", true).await.unwrap();

        // Verify joined detail queries
        let orch_name = chat.participants().into_iter().find(|p| p.id == "orchestrator").unwrap().name;
        let by_id = db::message_by_id(db.read_conn(), &orch_post.id).await.unwrap().unwrap();
        assert_eq!(by_id.sender_name, orch_name);
        let by_num = db::message_by_number(db.read_conn(), &thread_id, orch_post.number).await.unwrap().unwrap();
        assert_eq!(by_num.id, orch_post.id);
        let by_key = db::message_by_send_key(db.read_conn(), USER_ID, "sk-eng-1").await.unwrap().unwrap();
        assert_eq!(by_key.id, u_msg.id);
        assert_eq!(db::pinned_in(db.read_conn(), &thread_id).await.unwrap().len(), 1);
        assert!(!db::messages_changed_after(db.read_conn(), &thread_id, 0, 10).await.unwrap().is_empty());
        assert_eq!(db::recent_reports(db.read_conn(), 10).await.unwrap().len(), 1);
        assert!(db::reports_after(db.read_conn(), "", 10).await.unwrap().len() == 1);
        assert!(!db::events_after(db.read_conn(), 0, 10).await.unwrap().is_empty());
        assert!(db::event_of(db.read_conn(), &orch_post.id).await.unwrap().is_some());
        assert!(!db::unseen_in(db.read_conn(), &thread_id, "orchestrator").await.unwrap().is_empty());
        let _ = db::callers_of(db.read_conn(), &helper.id, &thread_id, "zzzz", 10).await.unwrap();

        // Verify joined location queries: user_mentions + search_messages (channel + parent JOIN)
        let mentions = db::user_mentions(db.read_conn()).await.unwrap();
        assert!(
            mentions
                .iter()
                .any(|m| m.row.id == orch_post.id && m.top_id == eng.id && m.channel_name == "eng")
        );

        let hits = chat.search_async("spec has:link", Some(&eng.id)).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message.id, u_msg.id);
        assert_eq!(hits[0].channel, eng.id);

        // Verify unread_of (portable CASE WHEN + MAX without SQLite-isms)
        let unread = chat.unread_async(USER_ID, Some(&thread_id)).await;
        assert!(!unread.is_empty());
        assert!(unread.iter().any(|u| u.mentions_you && u.channel.contains("#eng")));

        // Verify read cursor, mark_unread, notification_receipt, deliveries, edit & delete
        let thread_target = chat.target_of(&thread_id).unwrap();
        let read_res = chat
            .read_async(
                &helper.id,
                ReadOptions {
                    target: Some(thread_target),
                    ..ReadOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(!read_res.messages.is_empty());
        chat.mark_read_async(&thread_id, report_msg.number + 1).await.unwrap();
        let receipt = db::notification_receipt(db.read_conn(), &orch_post.id).await.unwrap().unwrap();
        assert!(receipt.0.is_some());
        assert!(!db::user_read_reports(db.read_conn()).await.unwrap().is_empty());

        let pending_orch = chat.pending_deliveries_async(DeliveryTargetKind::Orchestrator).await.unwrap();
        assert!(!pending_orch.is_empty());
        assert!(pending_orch.iter().any(|d| d.wakes));
        chat.settle_delivery_async(pending_orch[0].id, true).await.unwrap();

        let edited = chat.edit_async(&u_msg.id, "edited spec https://example.com/spec", None).await.unwrap();
        assert_eq!(edited.text, "edited spec https://example.com/spec");

        // Deleting clears system_code as well
        chat.remove_async(&sys_entity.id).await.unwrap();
        let deleted_sys = channel_message::Entity::find_by_id(sys_entity.id.clone())
            .one(db.read_conn())
            .await
            .unwrap()
            .unwrap();
        assert!(deleted_sys.system_code.is_none());
        assert!(deleted_sys.deleted_at.is_some());

        // Create and delete an unused channel cleanly
        let temp_ch = chat.open_channel_async("temp", "", "").await.unwrap();
        chat.remove_channel_async(&temp_ch.id).await.unwrap();
        assert!(chat.list_async().await.unwrap().iter().all(|c| c.id != temp_ch.id));

        // Leave participant
        chat.leave_async(&helper.id).await.unwrap();

        // Verify Connector Store across SQLite and PostgreSQL
        let store = Store::open(db.clone());
        let cid = ConnectorID::Weixin;
        store
            .connect_async(cid, &Secret::new("tok-1"), "", Some("123456"), 100, "replaced")
            .await
            .unwrap();
        store.set_channel_async(cid, Some(&eng.id)).await.unwrap();
        assert_eq!(store.accounts_in_async(&eng.id).await.unwrap(), 1);

        let accepted = store
            .accept_async(
                cid,
                &[
                    Inbound {
                        id: "ext-pair".into(),
                        from: "wx-user".into(),
                        text: "123456".into(),
                        reply: "ctx-1".into(),
                        quoted: String::new(),
                    },
                    Inbound {
                        id: "ext-msg-1".into(),
                        from: "wx-user".into(),
                        text: "hello from wx".into(),
                        reply: "ctx-2".into(),
                        quoted: String::new(),
                    },
                ],
                "cur-1",
                101,
            )
            .await
            .unwrap();
        assert!(accepted);
        assert_eq!(store.pending_inbound_async(cid).await.unwrap().len(), 2);

        store
            .paired_async(
                cid,
                &Inbound {
                    id: "ext-pair".into(),
                    from: "wx-user".into(),
                    text: "123456".into(),
                    reply: "ctx-1".into(),
                    quoted: String::new(),
                },
                102,
            )
            .await
            .unwrap();
        store.delivered_async(cid, "ext-msg-1", Some(&u_msg.id)).await.unwrap();
        assert!(store.pending_inbound_async(cid).await.unwrap().is_empty());

        store
            .add_outgoing_async(cid, &orch_post.id, &["part-1".into(), "part-2".into()], 103)
            .await
            .unwrap();
        store.add_outgoing_async(cid, "msg-wait", &["wait-1".into()], 104).await.unwrap();
        assert_eq!(store.count_pending_async(cid).await.unwrap(), 3);
        let out = store.pending_outgoing_async(cid).await.unwrap();
        store.sent_async(&[out[0].seq, out[1].seq], 105, "ext-out-1").await.unwrap();
        store.not_sent_async(&[out[2].seq], "temp err").await.unwrap();
        assert_eq!(
            store.message_of_ext_async(cid, "ext-out-1").await.unwrap().as_deref(),
            Some(orch_post.id.as_str())
        );
        assert_eq!(store.message_of_ext_async(cid, "ext-msg-1").await.unwrap().as_deref(), Some(u_msg.id.as_str()));
        store.withdraw_async("msg-wait").await.unwrap();
        assert_eq!(store.count_pending_async(cid).await.unwrap(), 0);

        // Reconnect preserves channel_id and resets cursor
        store
            .connect_async(cid, &Secret::new("tok-2"), "wx-user-2", None, 200, "replaced")
            .await
            .unwrap();
        let acct = store.account_async(cid).await.unwrap().unwrap();
        assert_eq!(acct.user, "wx-user-2");
        assert_eq!(acct.cursor, "");
        assert_eq!(acct.channel.as_deref(), Some(eng.id.as_str()));

        store.pause_async(cid, Some(999_999)).await.unwrap();
        store.prune_async(150).await.unwrap();
        store.disconnect_async(cid, "gone").await.unwrap();
        assert!(store.account_async(cid).await.unwrap().is_none());

        // Suppress unused SubjectKind / MessageKind warning if needed
        let _ = (
            SubjectKind::Talk,
            MessageKind::Chat,
            ThreadSubject {
                kind: SubjectKind::Talk,
                id: String::new(),
                owner: String::new(),
            },
        );

        hub.close_async().await;
    }

    #[test]
    fn dual_db_collab_works_on_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("collab.db");
        let db = ServerDb::open_at(&db_path).unwrap();
        block_on(verify_dual_db_collab(&db, dir.path()));
        db.close();
    }

    #[test]
    fn dual_db_collab_works_on_postgres() {
        let Some(pg) = EphemeralPostgres::start() else {
            eprintln!("skipping dual_db_collab_works_on_postgres: initdb/pg_ctl not found");
            return;
        };
        pg.create_database("collab_wave3_test");
        let url = pg.db_url("collab_wave3_test");
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open_url(&url).unwrap();
        block_on(verify_dual_db_collab(&db, dir.path()));
        db.close();
    }
}
