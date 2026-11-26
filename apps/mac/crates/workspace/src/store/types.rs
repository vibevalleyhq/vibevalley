use std::path::PathBuf;

use sea_orm::{DatabaseConnection, DatabaseTransaction, DbErr, SqliteTransactionMode, TransactionOptions, TransactionTrait};
use serde::{Deserialize, Serialize};

use super::entities::projects;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Db(String),
    #[error("io: {0}")]
    Io(String),
    #[error("not found")]
    NotFound,
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub type ProjectId = i64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub path: PathBuf,
    pub name: String,
    /// Position in the project rail.
    pub position: i64,
    /// Milliseconds since the Unix epoch.
    pub last_opened_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedTerminal {
    /// Stable id the layout refers to.
    pub id: String,
    pub project_id: ProjectId,
    pub cwd: PathBuf,
    pub title: Option<String>,
    pub scrollback: String,
}

impl From<DbErr> for StoreError {
    fn from(e: DbErr) -> Self {
        match e {
            DbErr::RecordNotFound(_) => StoreError::NotFound,
            other => StoreError::Db(other.to_string()),
        }
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Db(format!("json: {e}"))
    }
}

pub(super) fn project_from_model(row: projects::Model) -> Project {
    Project {
        id: row.id,
        path: row.path.into(),
        name: row.name,
        position: row.position,
        last_opened_ms: row.last_opened_ms,
    }
}

pub(crate) async fn begin_write_tx(conn: &DatabaseConnection) -> Result<DatabaseTransaction> {
    let opts = TransactionOptions {
        sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
        ..Default::default()
    };
    Ok(conn.begin_with_options(opts).await?)
}
