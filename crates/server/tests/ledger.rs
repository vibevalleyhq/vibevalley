use std::sync::Arc;

use crate::support::{execute_sql, inspect_db};
use vibevalley_protocol::{Fact, Issue};
use vibevalley_server::modules::work::ledger::{Ledger, LocalFacts};

#[test]
fn regression_failed_batch_changes_neither_database_nor_core() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let (ledger, _) = Ledger::open(&path, Arc::new(LocalFacts::default())).unwrap();
    let mut db = inspect_db(&path);
    execute_sql(
        &mut db,
        "create trigger refuse_second before insert on issue when new.id = 'second' begin select raise(abort, 'refused'); end;",
    );
    let before = ledger.bundle();
    let result = ledger.apply(vec![
        Fact::issue_changed(1, Issue::new("first", 1, "First", 1)),
        Fact::issue_changed(1, Issue::new("second", 2, "Second", 1)),
    ]);
    assert!(result.is_err());
    assert_eq!(ledger.bundle(), before);
    assert_eq!(
        pollster::block_on(sqlx::query_scalar::<_, i64>("select count(*) from issue").fetch_one(&mut db)).unwrap(),
        0
    );
}

#[test]
fn regression_invalid_stored_enum_fails_open_instead_of_losing_the_issue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let (ledger, _) = Ledger::open(&path, Arc::new(LocalFacts::default())).unwrap();
    ledger.apply(vec![Fact::issue_changed(1, Issue::new("first", 1, "First", 1))]).unwrap();
    let mut db = inspect_db(&path);
    execute_sql(&mut db, "update issue set priority = 'unknown'");
    assert!(Ledger::snapshot(&path).is_err());
    assert!(Ledger::open(&path, Arc::new(LocalFacts::default())).is_err());
}
