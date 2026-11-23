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
    let db = crate::base::ServerDb::open(home.path()).unwrap();
    let id = ConnectorID::Weixin;
    let s = Store::open(db.clone());
    let admin = |sql: &'static str| {
        db.run(async |conn| sqlx::raw_sql(sql).execute(&mut *conn).await).unwrap();
    };
    s.connect(id, &Secret::new("first"), "local", None, 1, "replaced").unwrap();
    s.set_channel(id, Some("room")).unwrap();
    s.accept(id, &[message("a"), message("a")], "one", 2).unwrap();
    admin("CREATE TRIGGER refuse_second BEFORE INSERT ON connector_inbound WHEN NEW.ext_id='c' BEGIN SELECT RAISE(ABORT,'interrupted batch'); END;");
    assert!(s.accept(id, &[message("b"), message("c")], "two", 3).is_err());
    drop(s);
    let s = Store::open(db.clone());
    assert_eq!(s.account(id).unwrap().unwrap().cursor, "one");
    assert_eq!(s.pending_inbound(id).unwrap().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a"]);
    admin("DROP TRIGGER refuse_second;");
    s.accept(id, &[message("a"), message("b"), message("c")], "two", 3).unwrap();
    s.delivered(id, "a", Some("farm-a")).unwrap();
    s.add_outgoing(id, "sent", &["p1".into(), "p2".into()], 4).unwrap();
    s.add_outgoing(id, "waiting", &["p3".into()], 5).unwrap();
    let pending = s.pending_outgoing(id).unwrap();
    assert_eq!(pending.iter().map(|p| p.body.as_str()).collect::<Vec<_>>(), ["p1", "p2", "p3"]);
    s.sent(&[pending[0].seq, pending[1].seq], 6, "vendor-out").unwrap();

    admin(
        "CREATE TRIGGER refuse_retirement BEFORE UPDATE OF state ON connector_outbox WHEN NEW.state='dropped' BEGIN SELECT RAISE(ABORT,'failed retirement'); END;",
    );
    assert!(s.connect(id, &Secret::new("second"), "new", None, 7, "replaced").is_err());
    drop(s);
    let s = Store::open(db.clone());
    let a = s.account(id).unwrap().unwrap();
    assert_eq!((a.user.as_str(), a.cursor.as_str(), a.channel.as_deref()), ("local", "two", Some("room")));
    assert_eq!(s.pending_inbound(id).unwrap().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["b", "c"]);
    assert_eq!(
        s.pending_outgoing(id).unwrap().iter().map(|p| p.message.as_str()).collect::<Vec<_>>(),
        ["waiting"]
    );
    assert_eq!(s.message_of_ext(id, "a").unwrap().as_deref(), Some("farm-a"));
    assert_eq!(s.message_of_ext(id, "vendor-out").unwrap().as_deref(), Some("sent"));

    admin("DROP TRIGGER refuse_retirement;");
    s.connect(id, &Secret::new("second"), "new", None, 7, "replaced").unwrap();
    drop(s);
    let s = Store::open(db.clone());
    let a = s.account(id).unwrap().unwrap();
    assert_eq!((a.user.as_str(), a.cursor.as_str(), a.channel.as_deref()), ("new", "", Some("room")));
    assert!(s.pending_inbound(id).unwrap().is_empty());
    assert_eq!(s.count_pending(id).unwrap(), 0);
    assert!(s.message_of_ext(id, "a").unwrap().is_none());
    db.close();
}
