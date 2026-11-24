use crate::support::{execute_sql, inspect_db};
use vibevalley_protocol::Issue;
use vibevalley_server::db::DatabaseConfig;
use vibevalley_server::issue::IssueState;
use vibevalley_server::service::Service;

#[test]
fn regression_failed_batch_changes_neither_database_nor_core() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let service = vibevalley_runtime::rt::block_on(Service::open_config(&DatabaseConfig::Sqlite { path: path.clone() })).unwrap();
    let mut db = inspect_db(&path);
    execute_sql(
        &mut db,
        "create trigger refuse_second before insert on issue when new.id = 'second' begin select raise(abort, 'refused'); end;",
    );
    let result = vibevalley_runtime::rt::block_on(
        service
            .issue
            .put_batch(&[Issue::new("first", 1, "First", 1), Issue::new("second", 2, "Second", 1)]),
    );
    assert!(result.is_err());
    assert!(vibevalley_runtime::rt::block_on(service.issue.all()).unwrap().is_empty());
    assert_eq!(
        vibevalley_runtime::rt::block_on(sqlx::query_scalar::<_, i64>("select count(*) from issue").fetch_one(&mut db)).unwrap(),
        0
    );
    vibevalley_runtime::rt::block_on(service.close());
}

#[test]
fn regression_invalid_stored_enum_fails_open_instead_of_losing_the_issue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let service = vibevalley_runtime::rt::block_on(Service::open_config(&DatabaseConfig::Sqlite { path: path.clone() })).unwrap();
    vibevalley_runtime::rt::block_on(service.issue.put(&Issue::new("first", 1, "First", 1))).unwrap();
    let mut db = inspect_db(&path);
    execute_sql(&mut db, "update issue set priority = 'unknown'");
    assert!(vibevalley_runtime::rt::block_on(IssueState::snapshot_async(&path)).is_err());
    assert!(vibevalley_runtime::rt::block_on(service.issue.all()).is_err());
    vibevalley_runtime::rt::block_on(service.close());
}
