//! Top-level business-perspective data service layer (`Service`).
//!
//! Every SQLite/PostgreSQL SeaORM query in `crates/server` lives behind one of the
//! singular domain sub-services below so business modules across the server can
//! compose typed data operations cleanly without importing `sea_orm::*` or `db::entity`.

use std::path::Path;
use std::sync::Arc;

#[cfg(test)]
use crate::db::DbBackend;
pub(crate) use crate::db::error::internal_db;
use crate::db::{BoxFuture, Database, begin_write_tx, commit_tx, rollback_tx};
pub(crate) use crate::db::{DatabaseConfig, DbError, DbResult, Tx};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PrimaryKeyTrait, QueryFilter, Update};
use vibevalley_core::SliceMask;

pub(crate) mod artifact;
pub(crate) mod channel;
pub(crate) mod connector;
pub(crate) mod cron;
pub(crate) mod issue;
pub(crate) mod memory;
pub(crate) mod outbox;
pub(crate) mod remote;
pub(crate) mod session;
pub(crate) mod storage;

pub(crate) use artifact::ArtifactService;
pub(crate) use channel::ChannelService;
pub(crate) use connector::ConnectorService;
pub(crate) use cron::CronService;
pub(crate) use issue::IssueService;
pub(crate) use memory::MemoryService;
pub(crate) use outbox::OutboxService;
pub(crate) use remote::RemoteService;
pub(crate) use session::SessionService;
pub(crate) use storage::StorageService;

pub(super) fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

pub(super) async fn update_col_by_id<E, C, V>(db: &C, id_col: E::Column, id: &str, col: E::Column, val: V) -> DbResult<()>
where
    E: EntityTrait + Default,
    E::Column: ColumnTrait,
    V: Into<sea_orm::Value>,
    C: ConnectionTrait,
{
    Update::many(E::default())
        .col_expr(col, Expr::value(val))
        .filter(id_col.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub(super) async fn delete_by_id<E, C>(db: &C, id: &str) -> DbResult<()>
where
    E: EntityTrait,
    C: ConnectionTrait,
    <E::PrimaryKey as PrimaryKeyTrait>::ValueType: From<String>,
{
    E::delete_by_id(id.to_owned()).exec(db).await?;
    Ok(())
}

/// Runs a write transaction, committing on `Ok` and rolling back on `Err`.
pub(super) async fn with_write_tx<T, E>(db: &Database, f: impl AsyncFnOnce(&Tx) -> Result<T, E>) -> Result<T, E>
where
    E: From<DbError>,
{
    let tx = begin_write_tx(db.write_conn()).await.map_err(E::from)?;
    match f(&tx).await {
        Ok(val) => {
            commit_tx(tx).await.map_err(E::from)?;
            Ok(val)
        }
        Err(err) => {
            let _ = rollback_tx(tx).await;
            Err(err)
        }
    }
}

/// Unified entry point for all server data services across SQLite and PostgreSQL.
#[derive(Clone)]
pub struct Service {
    database: Arc<Database>,
    pub(crate) outbox: OutboxService,
    pub(crate) storage: StorageService,
    pub(crate) channel: ChannelService,
    pub(crate) connector: ConnectorService,
    pub(crate) artifact: ArtifactService,
    pub session: SessionService,
    pub issue: IssueService,
    pub(crate) memory: MemoryService,
    pub(crate) cron: CronService,
    pub(crate) remote: RemoteService,
}

impl Service {
    /// Wraps an already-open [`Database`] handle with all domain data services.
    pub(crate) fn new(database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            outbox: OutboxService::new(database.clone()),
            storage: StorageService::new(database.clone()),
            channel: ChannelService::new(database.clone()),
            connector: ConnectorService::new(database.clone()),
            artifact: ArtifactService::new(database.clone()),
            session: SessionService::new(database.clone()),
            issue: IssueService::new(database.clone()),
            memory: MemoryService::new(database.clone()),
            cron: CronService::new(database.clone()),
            remote: RemoteService::new(database.clone()),
            database,
        })
    }

    /// Opens `<home>/server.db` and returns a ready [`Service`].
    pub async fn open(home: &Path) -> DbResult<Arc<Self>> {
        Ok(Self::new(Database::open(home).await?))
    }

    /// Opens a SQLite or PostgreSQL database from `url` and returns a ready [`Service`].
    pub(crate) async fn open_url(url: &str) -> DbResult<Arc<Self>> {
        Ok(Self::new(Database::open_url(url).await?))
    }

    /// Opens a database from [`DatabaseConfig`] and returns a ready [`Service`].
    pub async fn open_config(config: &DatabaseConfig) -> DbResult<Arc<Self>> {
        Ok(Self::new(Database::open_config(config).await?))
    }

    /// Closes the underlying database pools and durable store cleanly.
    pub async fn close(&self) {
        self.database.close().await;
    }

    #[cfg(test)]
    pub(crate) fn backend(&self) -> DbBackend {
        self.database.backend()
    }

    pub fn is_postgres(&self) -> bool {
        self.database.is_postgres()
    }

    pub fn path(&self) -> Option<&Path> {
        self.database.path()
    }

    /// Exposes the underlying [`Database`] handle for tests and migration checks.
    pub fn database(&self) -> &Arc<Database> {
        &self.database
    }

    pub(crate) async fn durable(&self) -> vibevalley_runtime::agent::durable::Result<vibevalley_runtime::agent::durable::Store> {
        self.database.durable().await
    }

    pub(crate) async fn next_seq(&self, name: &str, at_least: i64) -> DbResult<i64> {
        self.database.next_seq(name, at_least).await
    }

    pub(crate) async fn begin_tx(&self) -> DbResult<Tx> {
        self.database.begin_tx().await
    }

    pub(crate) async fn commit_tx(&self, tx: Tx) -> DbResult<()> {
        commit_tx(tx).await
    }

    pub(crate) async fn rollback_tx(&self, tx: Tx) -> DbResult<()> {
        rollback_tx(tx).await
    }

    pub(crate) async fn transaction<T, E>(&self, f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<T, E>> + Send) -> Result<T, E>
    where
        E: From<DbError>,
    {
        self.database.transaction(f).await
    }

    #[cfg(test)]
    pub(crate) async fn write_dirty<T, E>(&self, f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<(T, SliceMask), E>> + Send) -> Result<(T, SliceMask), E>
    where
        E: From<DbError>,
    {
        self.database.write_dirty(f).await
    }

    pub(crate) async fn write_dirty_with<T, E>(
        &self,
        map_err: impl FnMut(DbError) -> E,
        f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<(T, SliceMask), E>> + Send,
    ) -> Result<(T, SliceMask), E> {
        self.database.write_dirty_with(map_err, f).await
    }
}
