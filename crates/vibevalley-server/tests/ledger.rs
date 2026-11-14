use std::sync::Arc;

use rusqlite::Connection;
use vibevalley_protocol::{Fact, Issue};
use vibevalley_server::modules::ledger::{Ledger, LocalFacts};

#[test]
fn regression_failed_batch_changes_neither_database_nor_core() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let (ledger, _) = Ledger::open(&path, Arc::new(LocalFacts::default())).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("create trigger refuse_second before insert on issue when new.id = 'second' begin select raise(abort, 'refused'); end;")
        .unwrap();
    let before = ledger.frame();
    let result = ledger.apply(vec![
        Fact::issue_changed(1, Issue::new("first", 1, "First", 1)),
        Fact::issue_changed(1, Issue::new("second", 2, "Second", 1)),
    ]);
    assert!(result.is_err());
    assert_eq!(ledger.frame(), before);
    assert_eq!(db.query_row("select count(*) from issue", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn regression_invalid_stored_enum_fails_open_instead_of_losing_the_issue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let (ledger, _) = Ledger::open(&path, Arc::new(LocalFacts::default())).unwrap();
    ledger.apply(vec![Fact::issue_changed(1, Issue::new("first", 1, "First", 1))]).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute("update issue set priority = 'unknown'", []).unwrap();
    assert!(Ledger::snapshot(&path).is_err());
    assert!(Ledger::open(&path, Arc::new(LocalFacts::default())).is_err());
}
