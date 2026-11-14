use rusqlite::Connection;

use crate::{Result, StoreError};

/// One entry per schema version; `user_version` counts how many have run.
/// Append only: never edit an entry that has shipped.
pub(crate) const MIGRATIONS: &[&str] = &["
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        last_opened_ms INTEGER NOT NULL
    );
    CREATE TABLE layouts (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        json TEXT NOT NULL
    );
    CREATE TABLE terminals (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT,
        scrollback TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
    );
    CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        session_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        worktree_path TEXT,
        branch TEXT,
        record_path TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE INDEX agent_sessions_by_project ON agent_sessions(project_id, created_ms);
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"];

pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let target = MIGRATIONS.len() as i64;
    if current > target {
        return Err(StoreError::Db(format!(
            "database schema version {current} is newer than this build supports ({target})"
        )));
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}
