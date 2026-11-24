//! Top-level business-perspective data service layer (`Service`).
//!
//! Every SQLite/PostgreSQL SeaORM query in `crates/server` lives behind one of the
//! singular domain sub-services below so business modules across the server can
//! compose typed data operations cleanly without importing `sea_orm::*` or `db::entity`.

use std::path::Path;
use std::sync::Arc;

use vibevalley_core::SliceMask;

use crate::db::{BoxFuture, Database, DatabaseConfig, DbBackend, DbError, DbResult, Tx, commit_tx, rollback_tx};

pub mod artifact;
pub mod channel;
pub mod connector;
pub mod cron;
pub mod issue;
pub mod memory;
pub mod outbox;
pub mod remote;
pub mod session;
pub mod storage;

pub use artifact::ArtifactService;
pub use channel::ChannelService;
pub use connector::ConnectorService;
pub use cron::CronService;
pub use issue::IssueService;
pub use memory::MemoryService;
pub use outbox::OutboxService;
pub use remote::RemoteService;
pub use session::SessionService;
pub use storage::StorageService;

/// Unified entry point for all server data services across SQLite and PostgreSQL.
#[derive(Clone)]
pub struct Service {
    database: Arc<Database>,
    pub outbox: OutboxService,
    pub storage: StorageService,
    pub channel: ChannelService,
    pub connector: ConnectorService,
    pub artifact: ArtifactService,
    pub session: SessionService,
    pub issue: IssueService,
    pub memory: MemoryService,
    pub cron: CronService,
    pub remote: RemoteService,
}

impl Service {
    /// Wraps an already-open [`Database`] handle with all domain data services.
    pub fn new(database: Arc<Database>) -> Arc<Self> {
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

    /// Opens a SQLite database at `path` and returns a ready [`Service`].
    pub async fn open_at(path: &Path) -> DbResult<Arc<Self>> {
        Ok(Self::new(Database::open_at(path).await?))
    }

    /// Opens a SQLite or PostgreSQL database from `url` and returns a ready [`Service`].
    pub async fn open_url(url: &str) -> DbResult<Arc<Self>> {
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

    pub fn backend(&self) -> DbBackend {
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

    pub async fn durable(&self) -> vibevalley_runtime::agent::durable::Result<vibevalley_runtime::agent::durable::Store> {
        self.database.durable().await
    }

    pub async fn next_seq(&self, name: &str, at_least: i64) -> DbResult<i64> {
        self.database.next_seq(name, at_least).await
    }

    pub async fn next_seq_in_tx(&self, tx: &Tx, name: &str, at_least: i64) -> DbResult<i64> {
        self.database.next_seq_in_tx(tx, name, at_least).await
    }

    pub async fn begin_tx(&self) -> DbResult<Tx> {
        self.database.begin_tx().await
    }

    pub async fn commit_tx(&self, tx: Tx) -> DbResult<()> {
        commit_tx(tx).await
    }

    pub async fn rollback_tx(&self, tx: Tx) -> DbResult<()> {
        rollback_tx(tx).await
    }

    pub async fn transaction<T, E>(&self, f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<T, E>> + Send) -> Result<T, E>
    where
        E: From<DbError>,
    {
        self.database.transaction(f).await
    }

    pub async fn transaction_with<T, E>(
        &self,
        map_err: impl FnMut(DbError) -> E,
        f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<T, E>> + Send,
    ) -> Result<T, E> {
        self.database.transaction_with(map_err, f).await
    }

    pub async fn write_dirty<T, E>(&self, f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<(T, SliceMask), E>> + Send) -> Result<(T, SliceMask), E>
    where
        E: From<DbError>,
    {
        self.database.write_dirty(f).await
    }

    pub async fn write_dirty_with<T, E>(
        &self,
        map_err: impl FnMut(DbError) -> E,
        f: impl for<'a> FnOnce(&'a Tx) -> BoxFuture<'a, Result<(T, SliceMask), E>> + Send,
    ) -> Result<(T, SliceMask), E> {
        self.database.write_dirty_with(map_err, f).await
    }
}
