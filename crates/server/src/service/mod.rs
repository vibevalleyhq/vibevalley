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

pub(crate) mod channel;
pub(crate) mod connector;
pub(crate) mod cron;
pub(crate) mod issue;
pub(crate) mod memory;
pub(crate) mod note;
pub(crate) mod outbox;
#[cfg(test)]
mod query_perf_tests;
pub(crate) mod remote;
pub(crate) mod session;
pub(crate) mod storage;

pub(crate) use channel::ChannelService;
pub(crate) use connector::ConnectorService;
pub(crate) use cron::CronService;
pub(crate) use issue::IssueService;
pub(crate) use memory::MemoryService;
pub(crate) use note::NoteService;
pub(crate) use outbox::OutboxService;
pub(crate) use remote::RemoteService;
pub(crate) use session::SessionService;
pub(crate) use storage::StorageService;

/// Conservative bind-parameter budget per multi-row SQL statement so chunked
/// `insert_many` and `IN (...)` queries stay below SQLite's 999-parameter default
/// limit as well as PostgreSQL's 65,535 limit.
pub(super) const MAX_SQL_BIND_PARAMS: usize = 900;

pub(super) const fn batch_chunk_rows(columns_per_row: usize) -> usize {
    let rows = MAX_SQL_BIND_PARAMS / columns_per_row;
    if rows == 0 { 1 } else { rows }
}

/// Formats a search string as a quoted SQLite FTS5 trigram phrase when it has at least
/// 3 Unicode scalar characters (the minimum length supported by FTS5's `trigram` tokenizer).
pub(super) fn fts5_trigram_phrase(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.chars().count() < 3 {
        return None;
    }
    Some(format!("\"{}\"", trimmed.replace('"', "\"\"")))
}

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
    pub(crate) note: NoteService,
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
            note: NoteService::new(database.clone()),
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

    pub fn query_metrics(&self) -> &Arc<crate::db::QueryMetrics> {
        self.database.query_metrics()
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

    /// Loads only the sessions needed to derive a single issue (and its descendants):
    /// targeted PK lookups for `session_ids` plus any active refining sessions bound to `issue_ids`.
    pub(crate) async fn sessions_for_issues(&self, session_ids: &[String], issue_ids: &[String]) -> DbResult<Vec<vibevalley_protocol::Session>> {
        use std::collections::HashSet;

        use crate::db::entity::session;
        use sea_orm::QuerySelect;

        let mut needed: HashSet<String> = session_ids.iter().cloned().collect();
        if !issue_ids.is_empty() {
            let refining_ids: Vec<String> = session::Entity::find()
                .select_only()
                .column(session::Column::Id)
                .filter(session::Column::Departed.eq(false))
                .filter(session::Column::Bindings.contains("\"refining\":true"))
                .into_tuple()
                .all(self.database.read_conn())
                .await?;
            needed.extend(refining_ids);
        }

        let mut out = Vec::with_capacity(needed.len());
        for sid in needed {
            if let Some(sess) = self.session.get(&sid).await? {
                out.push(sess);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod batch_tests {
    use super::connector::ConnectorInboundRow;
    use super::memory::NewMemory;
    use super::*;
    use vibevalley_protocol::{ActorKind, ConnectorID, Issue, LinkEntityKind, LinkRelation, MemoryKind, NoteLinkRef, SessionEvent, SessionEventType};

    fn make_event(seq: i64, run: Option<&str>, text: &str) -> SessionEvent {
        SessionEvent {
            seq,
            revision: 1,
            time: 1_000 + seq,
            r#type: SessionEventType::AssistantMessage,
            run: run.map(str::to_owned),
            call: None,
            under: None,
            thread_id: None,
            text: text.to_owned(),
            action: None,
            action_text: None,
            tool: None,
            input: None,
            output: None,
            ok: None,
            tokens: None,
            connection: None,
            permission: None,
            interaction: None,
            interaction_resolution: None,
        }
    }

    async fn assert_large_batch_writes(svc: &Service) {
        // 1. session.upsert_events_batch: >500 events across multiple sessions + duplicate `(session_id, seq)`
        //    updates verifying `COALESCE(excluded.run_id, existing.run_id)` and latest payload semantics.
        let mut s1_events: Vec<SessionEvent> = (0..350).map(|seq| make_event(seq, Some("run-1"), &format!("s1-initial-{seq}"))).collect();
        // Duplicate seq 42 in the same batch with run=None: must keep run="run-1" and update payload.
        s1_events.push(make_event(42, None, "s1-updated-in-batch-42"));
        let s2_events: Vec<SessionEvent> = (0..260).map(|seq| make_event(seq, Some("run-2"), &format!("s2-event-{seq}"))).collect();
        let s3_events: Vec<SessionEvent> = (0..40).map(|seq| make_event(seq, Some("run-3"), &format!("s3-event-{seq}"))).collect();

        svc.session
            .upsert_events_batch(&[
                ("sess-1".to_owned(), s1_events),
                ("sess-2".to_owned(), s2_events),
                ("sess-3".to_owned(), s3_events),
            ])
            .await
            .unwrap();

        // Cross-batch update on seq 42 with run=None must still preserve existing run="run-1".
        svc.session
            .upsert_events_batch(&[("sess-1".to_owned(), vec![make_event(42, None, "s1-updated-again-42")])])
            .await
            .unwrap();

        assert_eq!(svc.session.max_event_seq("sess-1").await.unwrap(), 349);
        assert_eq!(svc.session.max_event_seq("sess-2").await.unwrap(), 259);
        assert_eq!(svc.session.max_event_seq("sess-3").await.unwrap(), 39);

        let s1_loaded = svc.session.list_events_after("sess-1", "run-1", -1, 500).await.unwrap();
        assert_eq!(s1_loaded.len(), 350);
        assert_eq!(s1_loaded[42].text, "s1-updated-again-42");
        assert_eq!(s1_loaded[42].run, None); // payload has None, while DB run_id column stayed "run-1" so run filter matched it!

        let s2_loaded = svc.session.list_events_after("sess-2", "run-2", -1, 500).await.unwrap();
        assert_eq!(s2_loaded.len(), 260);
        assert_eq!(s2_loaded[259].text, "s2-event-259");

        // 2. issue.put_batch: >70 issues crossing multiple 24-row chunks + duplicate ID in same batch + subsequent update.
        let mut issues: Vec<Issue> = (1..=75).map(|n| Issue::new(format!("iss-{n}"), n, format!("Issue #{n}"), 10_000 + n)).collect();
        issues.push(Issue::new("iss-10".to_owned(), 10, "Issue #10 revised".to_owned(), 10_010));
        svc.issue.put_batch(&issues).await.unwrap();

        let loaded_issues = svc.issue.all().await.unwrap();
        assert_eq!(loaded_issues.len(), 75);
        assert_eq!(loaded_issues[9].title, "Issue #10 revised");

        // Update existing issues in a second batch across chunk boundaries.
        let updated: Vec<Issue> = (1..=30)
            .map(|n| Issue::new(format!("iss-{n}"), n, format!("Issue #{n} v2"), 10_000 + n))
            .collect();
        svc.issue.put_batch(&updated).await.unwrap();
        assert_eq!(svc.issue.get("iss-1").await.unwrap().unwrap().title, "Issue #1 v2");
        assert_eq!(svc.issue.get("iss-30").await.unwrap().unwrap().title, "Issue #30 v2");

        // 3. memory.rewrite_agent_notes: 140 notes crossing multiple 60-row chunks.
        let notes: Vec<NewMemory> = (0..140)
            .map(|i| NewMemory {
                id: format!("mem-{i}"),
                agent: "agent-a".to_owned(),
                kind: MemoryKind::Note,
                scope: "global".to_owned(),
                title: Some(format!("Title {i}")),
                body: format!("Body {i}"),
                repo: None,
                session: None,
                author: ActorKind::Agent,
                importance: 1,
                created_at: 20_000 + i,
            })
            .collect();
        assert_eq!(svc.memory.rewrite_agent_notes("agent-a", &notes).await.unwrap(), 140);
        assert_eq!(svc.memory.list("agent-a").await.unwrap().len(), 140);

        // 4. connector.accept (230 inbound messages with duplicates) & add_outgoing (250 pieces in order).
        svc.connector.connect(ConnectorID::Feishu, "{}", "u1", None, 30_000, "retired").await.unwrap();
        let mut inbound: Vec<ConnectorInboundRow> = (0..230)
            .map(|i| ConnectorInboundRow {
                id: format!("ext-{i}"),
                from: "u1".to_owned(),
                text: format!("msg-{i}"),
                reply: String::new(),
                quoted: String::new(),
            })
            .collect();
        inbound.push(inbound[0].clone()); // duplicate ext_id ignored by ON CONFLICT DO NOTHING
        assert!(svc.connector.accept(ConnectorID::Feishu, &inbound, "cur-230", 30_001).await.unwrap());
        let pending_in = svc.connector.pending_inbound(ConnectorID::Feishu).await.unwrap();
        assert_eq!(pending_in.len(), 230);
        assert_eq!(pending_in[0].id, "ext-0");
        assert_eq!(pending_in[229].id, "ext-229");

        let pieces: Vec<String> = (0..250).map(|i| format!("piece-{i}")).collect();
        assert!(svc.connector.add_outgoing_once(ConnectorID::Feishu, "m-1", &pieces, 30_002).await.unwrap());
        assert!(!svc.connector.add_outgoing_once(ConnectorID::Feishu, "m-1", &pieces, 30_003).await.unwrap());
        let pending_out = svc.connector.pending_outgoing(ConnectorID::Feishu).await.unwrap();
        assert_eq!(pending_out.len(), 250);
        assert_eq!(pending_out[0].body, "piece-0");
        assert_eq!(pending_out[249].body, "piece-249");

        // 5. note.replace_links_for_source: 240 links + 1 self-link filtered out across chunks.
        let mut links: Vec<NoteLinkRef> = (0..240)
            .map(|i| NoteLinkRef {
                kind: LinkEntityKind::Note,
                id: format!("note-target-{i}"),
                relation: LinkRelation::Link,
                title: Some(format!("Target {i}")),
            })
            .collect();
        links.push(NoteLinkRef {
            kind: LinkEntityKind::Note,
            id: "note-src".to_owned(),
            relation: LinkRelation::Link,
            title: Some("Self".to_owned()),
        });
        svc.note
            .replace_links_for_source(LinkEntityKind::Note, "note-src", &links, 40_000)
            .await
            .unwrap();
        let link_list = svc.note.list_links_for_entity(LinkEntityKind::Note, "note-src").await.unwrap();
        assert_eq!(link_list.outgoing.len(), 240);
    }

    #[tokio::test]
    async fn sqlite_large_batch_writes_succeed_across_chunk_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let svc = Service::open(dir.path()).await.unwrap();
        assert_large_batch_writes(&svc).await;
        svc.close().await;
    }

    #[cfg(feature = "postgres")]
    #[tokio::test]
    async fn postgres_large_batch_writes_and_pool_config_succeed() {
        use std::time::Duration;

        let Some(pg) = crate::db::test_pg::EphemeralPostgres::start() else {
            eprintln!("skipping postgres_large_batch_writes_and_pool_config_succeed: local PostgreSQL binaries unavailable");
            return;
        };
        pg.create_database("vv_batch_test").await;
        let url = pg.db_url("vv_batch_test");
        let cfg = DatabaseConfig::Postgres {
            url,
            max_connections: 8,
            min_connections: 2,
            acquire_timeout: Duration::from_secs(5),
            idle_timeout: Duration::from_secs(120),
            max_lifetime: Duration::from_secs(600),
        };
        let svc = Service::open_config(&cfg).await.unwrap();
        assert!(svc.is_postgres());
        assert_large_batch_writes(&svc).await;
        svc.close().await;
    }
}
