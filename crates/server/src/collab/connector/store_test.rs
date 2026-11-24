use sea_orm::ConnectionTrait;

use super::*;

fn message(id: &str) -> Inbound {
    Inbound {
        id: id.into(),
        from: "local".into(),
        text: id.into(),
        reply: String::new(),
        quoted: String::new(),
    }
}

#[test]
fn regression_cursor_inbound_and_account_retirement_survive_rollback_and_restart() {
    let home = tempfile::tempdir().unwrap();
    let db = crate::db::ServerDb::open(home.path()).unwrap();
    let id = ConnectorID::Weixin;
    vibevalley_runtime::rt::block_on(async {
        let s = Store::open(db.clone());
        let admin = |sql: &'static str| {
            let db = db.clone();
            async move {
                db.write_conn().execute_unprepared(sql).await.unwrap();
            }
        };
        s.connect_async(id, &Secret::new("first"), "local", None, 1, "replaced").await.unwrap();
        s.set_channel_async(id, Some("room")).await.unwrap();
        s.accept_async(id, &[message("a"), message("a")], "one", 2).await.unwrap();
        admin("CREATE TRIGGER refuse_second BEFORE INSERT ON connector_inbound WHEN NEW.ext_id='c' BEGIN SELECT RAISE(ABORT,'interrupted batch'); END;").await;
        assert!(s.accept_async(id, &[message("b"), message("c")], "two", 3).await.is_err());
        drop(s);
        let s = Store::open(db.clone());
        assert_eq!(s.account_async(id).await.unwrap().unwrap().cursor, "one");
        assert_eq!(
            s.pending_inbound_async(id).await.unwrap().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
        admin("DROP TRIGGER refuse_second;").await;
        s.accept_async(id, &[message("a"), message("b"), message("c")], "two", 3).await.unwrap();
        s.delivered_async(id, "a", Some("farm-a")).await.unwrap();
        s.add_outgoing_async(id, "sent", &["p1".into(), "p2".into()], 4).await.unwrap();
        s.add_outgoing_async(id, "waiting", &["p3".into()], 5).await.unwrap();
        let pending = s.pending_outgoing_async(id).await.unwrap();
        assert_eq!(pending.iter().map(|p| p.body.as_str()).collect::<Vec<_>>(), ["p1", "p2", "p3"]);
        s.sent_async(&[pending[0].seq, pending[1].seq], 6, "vendor-out").await.unwrap();

        admin(
            "CREATE TRIGGER refuse_retirement BEFORE UPDATE OF state ON connector_outbox WHEN NEW.state='dropped' BEGIN SELECT RAISE(ABORT,'failed retirement'); END;",
        )
        .await;
        assert!(s.connect_async(id, &Secret::new("second"), "new", None, 7, "replaced").await.is_err());
        drop(s);
        let s = Store::open(db.clone());
        let a = s.account_async(id).await.unwrap().unwrap();
        assert_eq!((a.user.as_str(), a.cursor.as_str(), a.channel.as_deref()), ("local", "two", Some("room")));
        assert_eq!(
            s.pending_inbound_async(id).await.unwrap().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["b", "c"]
        );
        assert_eq!(
            s.pending_outgoing_async(id)
                .await
                .unwrap()
                .iter()
                .map(|p| p.message.as_str())
                .collect::<Vec<_>>(),
            ["waiting"]
        );
        assert_eq!(s.message_of_ext_async(id, "a").await.unwrap().as_deref(), Some("farm-a"));
        assert_eq!(s.message_of_ext_async(id, "vendor-out").await.unwrap().as_deref(), Some("sent"));

        admin("DROP TRIGGER refuse_retirement;").await;
        s.connect_async(id, &Secret::new("second"), "new", None, 7, "replaced").await.unwrap();
        drop(s);
        let s = Store::open(db.clone());
        let a = s.account_async(id).await.unwrap().unwrap();
        assert_eq!((a.user.as_str(), a.cursor.as_str(), a.channel.as_deref()), ("new", "", Some("room")));
        assert!(s.pending_inbound_async(id).await.unwrap().is_empty());
        assert_eq!(s.count_pending_async(id).await.unwrap(), 0);
        assert!(s.message_of_ext_async(id, "a").await.unwrap().is_none());
    });
    db.close();
}
