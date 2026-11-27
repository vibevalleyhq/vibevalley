//! Dual-backend persistence for agent memory rows (`memory`).

use std::sync::Arc;

use sea_orm::sea_query::{Alias, Expr, JoinType, LikeExpr, OnConflict, Order, Query};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, QueryFilter, QueryOrder};
use vibevalley_protocol::{ActorKind, Memory, MemoryKind};

use super::{MAX_SQL_BIND_PARAMS, batch_chunk_rows, fts5_trigram_phrase, with_write_tx};
use crate::db::column::{db_word, read_db_word};
use crate::db::entity::memory;
use crate::db::{Database, DbResult, Tx};

#[derive(Debug, Clone)]
pub(crate) struct NewMemory {
    pub(crate) id: String,
    pub(crate) agent: String,
    pub(crate) kind: MemoryKind,
    pub(crate) scope: String,
    pub(crate) title: Option<String>,
    pub(crate) body: String,
    pub(crate) repo: Option<String>,
    pub(crate) session: Option<String>,
    pub(crate) author: ActorKind,
    pub(crate) importance: i64,
    pub(crate) created_at: i64,
}

fn read_memory(row: memory::Model) -> Memory {
    Memory {
        id: row.id,
        agent: row.agent,
        kind: read_db_word(row.kind).unwrap_or(MemoryKind::Note),
        text: row.body,
        author: read_db_word(row.author).unwrap_or(ActorKind::System),
        repo: row.repo,
        session: row.session,
        at: row.created_at,
        recalled: row.recalled,
        recalled_at: row.recalled_at,
        fading: false,
        source: None,
        scope: (!row.scope.is_empty()).then_some(row.scope),
        title: row.title,
        importance: Some(row.importance),
        replaced_by: row.replaced_by,
    }
}

async fn get_impl<C: ConnectionTrait>(db: &C, id: &str) -> DbResult<Option<Memory>> {
    Ok(memory::Entity::find_by_id(id.to_owned()).one(db).await?.map(read_memory))
}

async fn list_impl<C: ConnectionTrait>(db: &C, agent: &str, active_only: bool) -> DbResult<Vec<Memory>> {
    let mut query = memory::Entity::find().filter(memory::Column::Agent.eq(agent));
    if active_only {
        query = query.filter(memory::Column::ReplacedBy.is_null());
    }
    let rows = query.order_by_desc(memory::Column::CreatedAt).order_by_desc(memory::Column::Id).all(db).await?;
    Ok(rows.into_iter().map(read_memory).collect())
}

async fn list_all_active_impl<C: ConnectionTrait>(db: &C) -> DbResult<Vec<Memory>> {
    let rows = memory::Entity::find()
        .filter(memory::Column::ReplacedBy.is_null())
        .order_by_desc(memory::Column::CreatedAt)
        .order_by_desc(memory::Column::Id)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(read_memory).collect())
}

async fn list_farm_profiles_impl<C: ConnectionTrait>(db: &C) -> DbResult<Vec<Memory>> {
    let rows = memory::Entity::find()
        .filter(memory::Column::Kind.eq(db_word(&MemoryKind::Profile)?))
        .filter(memory::Column::Scope.eq("farm"))
        .filter(memory::Column::ReplacedBy.is_null())
        .order_by_desc(memory::Column::Importance)
        .order_by_desc(memory::Column::UpdatedAt)
        .order_by_desc(memory::Column::Id)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(read_memory).collect())
}

async fn list_active_scope_impl<C: ConnectionTrait>(db: &C, agent: &str, kind: MemoryKind, scope: &str, repo: Option<&str>) -> DbResult<Vec<Memory>> {
    let mut query = memory::Entity::find()
        .filter(memory::Column::Kind.eq(db_word(&kind)?))
        .filter(memory::Column::Scope.eq(scope))
        .filter(memory::Column::ReplacedBy.is_null());
    if scope != "farm" {
        query = query.filter(memory::Column::Agent.eq(agent));
    }
    query = match repo {
        Some(r) => query.filter(memory::Column::Repo.eq(r)),
        None => query.filter(memory::Column::Repo.is_null()),
    };
    let rows = query.order_by_desc(memory::Column::CreatedAt).order_by_desc(memory::Column::Id).all(db).await?;
    Ok(rows.into_iter().map(read_memory).collect())
}

const MEMORY_BATCH_ROWS: usize = batch_chunk_rows(15);
const MEMORY_IN_CHUNK_SIZE: usize = MAX_SQL_BIND_PARAMS - 4;

fn memory_active_model(entry: &NewMemory) -> DbResult<memory::ActiveModel> {
    Ok(memory::ActiveModel {
        id: Set(entry.id.clone()),
        agent: Set(entry.agent.clone()),
        kind: Set(db_word(&entry.kind)?),
        scope: Set(entry.scope.clone()),
        title: Set(entry.title.clone()),
        body: Set(entry.body.clone()),
        repo: Set(entry.repo.clone()),
        session: Set(entry.session.clone()),
        author: Set(db_word(&entry.author)?),
        importance: Set(entry.importance),
        replaced_by: Set(None),
        created_at: Set(entry.created_at),
        updated_at: Set(entry.created_at),
        recalled: Set(0),
        recalled_at: Set(None),
    })
}

async fn insert_impl<C: ConnectionTrait>(db: &C, entry: &NewMemory) -> DbResult<()> {
    memory_active_model(entry)?.insert(db).await?;
    Ok(())
}

async fn insert_many_impl<C: ConnectionTrait>(db: &C, entries: &[NewMemory]) -> DbResult<()> {
    if entries.is_empty() {
        return Ok(());
    }
    for chunk in entries.chunks(MEMORY_BATCH_ROWS) {
        let models: Vec<memory::ActiveModel> = chunk.iter().map(memory_active_model).collect::<DbResult<_>>()?;
        memory::Entity::insert_many(models).exec_without_returning(db).await?;
    }
    Ok(())
}

async fn mark_replaced_by_impl<C: ConnectionTrait>(db: &C, ids: &[String], replaced_by: &str, at: i64) -> DbResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut affected = 0u64;
    for chunk in ids.chunks(MEMORY_IN_CHUNK_SIZE) {
        let res = memory::Entity::update_many()
            .col_expr(memory::Column::ReplacedBy, Expr::value(Some(replaced_by.to_owned())))
            .col_expr(memory::Column::UpdatedAt, Expr::value(at))
            .filter(memory::Column::Id.is_in(chunk.iter().cloned()))
            .exec(db)
            .await?;
        affected += res.rows_affected;
    }
    Ok(affected)
}

async fn delete_agent_notes_impl<C: ConnectionTrait>(db: &C, agent: &str) -> DbResult<u64> {
    let res = memory::Entity::delete_many()
        .filter(memory::Column::Agent.eq(agent))
        .filter(memory::Column::Kind.eq("note"))
        .filter(memory::Column::Author.ne("user"))
        .exec(db)
        .await?;
    Ok(res.rows_affected)
}

async fn delete_impl<C: ConnectionTrait>(db: &C, agent: &str, id: &str) -> DbResult<u64> {
    let res = memory::Entity::delete_many()
        .filter(memory::Column::Agent.eq(agent))
        .filter(memory::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(res.rows_affected)
}

async fn delete_many_impl<C: ConnectionTrait>(db: &C, agent: &str, ids: &[String]) -> DbResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut affected = 0u64;
    for chunk in ids.chunks(MEMORY_IN_CHUNK_SIZE) {
        let res = memory::Entity::delete_many()
            .filter(memory::Column::Agent.eq(agent))
            .filter(memory::Column::Id.is_in(chunk.iter().cloned()))
            .exec(db)
            .await?;
        affected += res.rows_affected;
    }
    Ok(affected)
}

async fn upsert_issue_memory_impl<C: ConnectionTrait>(db: &C, entry: &NewMemory) -> DbResult<()> {
    let model = memory::ActiveModel {
        id: Set(entry.id.clone()),
        agent: Set(entry.agent.clone()),
        kind: Set(db_word(&MemoryKind::Issue)?),
        scope: Set(entry.scope.clone()),
        title: Set(entry.title.clone()),
        body: Set(entry.body.clone()),
        repo: Set(entry.repo.clone()),
        session: Set(entry.session.clone()),
        author: Set(db_word(&entry.author)?),
        importance: Set(entry.importance),
        replaced_by: Set(None),
        created_at: Set(entry.created_at),
        updated_at: Set(entry.created_at),
        recalled: Set(0),
        recalled_at: Set(None),
    };
    let on_conflict = OnConflict::columns([memory::Column::Agent, memory::Column::Session])
        .target_and_where(Expr::col(memory::Column::Kind).eq(Expr::cust("'issue'")))
        .update_columns([
            memory::Column::Scope,
            memory::Column::Title,
            memory::Column::Body,
            memory::Column::Repo,
            memory::Column::Importance,
            memory::Column::ReplacedBy,
            memory::Column::CreatedAt,
            memory::Column::UpdatedAt,
        ])
        .to_owned();
    memory::Entity::insert(model).on_conflict(on_conflict).exec(db).await?;
    Ok(())
}

#[derive(Clone)]
pub(crate) struct MemoryService {
    db: Arc<Database>,
}

impl MemoryService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn get(&self, id: &str) -> DbResult<Option<Memory>> {
        get_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn list(&self, agent: &str) -> DbResult<Vec<Memory>> {
        list_impl(self.db.read_conn(), agent, true).await
    }

    pub(crate) async fn list_all(&self, agent: &str) -> DbResult<Vec<Memory>> {
        list_impl(self.db.read_conn(), agent, false).await
    }

    pub(crate) async fn list_all_active(&self) -> DbResult<Vec<Memory>> {
        list_all_active_impl(self.db.read_conn()).await
    }

    pub(crate) async fn list_farm_profiles(&self) -> DbResult<Vec<Memory>> {
        list_farm_profiles_impl(self.db.read_conn()).await
    }

    pub(crate) async fn list_in_tx(&self, tx: &Tx, agent: &str) -> DbResult<Vec<Memory>> {
        list_impl(tx, agent, true).await
    }

    /// Atomically inserts `entry` and marks any overlapping active memory in the same scope
    /// with `replaced_by = Some(entry.id)` inside a single write transaction.
    pub(crate) async fn insert_superseding(&self, entry: &NewMemory, overlaps: impl Fn(&Memory) -> bool + Send) -> DbResult<Vec<String>> {
        with_write_tx(&self.db, async |tx| {
            let candidates = list_active_scope_impl(tx, &entry.agent, entry.kind, &entry.scope, entry.repo.as_deref()).await?;
            let superseded_ids: Vec<String> = candidates.iter().filter(|m| overlaps(m)).map(|m| m.id.clone()).collect();
            insert_impl(tx, entry).await?;
            if !superseded_ids.is_empty() {
                mark_replaced_by_impl(tx, &superseded_ids, &entry.id, entry.created_at).await?;
            }
            Ok(superseded_ids)
        })
        .await
    }

    /// Atomically replaces all non-user notes for `agent` with `notes`.
    pub(crate) async fn rewrite_agent_notes(&self, agent: &str, notes: &[NewMemory]) -> DbResult<usize> {
        with_write_tx(&self.db, async |tx| {
            delete_agent_notes_impl(tx, agent).await?;
            insert_many_impl(tx, notes).await?;
            Ok(notes.len())
        })
        .await
    }

    pub(crate) async fn delete(&self, agent: &str, id: &str) -> DbResult<u64> {
        delete_impl(self.db.write_conn(), agent, id).await
    }

    pub(crate) async fn delete_many_in_tx(&self, tx: &Tx, agent: &str, ids: &[String]) -> DbResult<u64> {
        delete_many_impl(tx, agent, ids).await
    }

    pub(crate) async fn record_recalled(&self, ids: &[String], at: i64) -> DbResult<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut affected = 0u64;
        for chunk in ids.chunks(MEMORY_IN_CHUNK_SIZE) {
            let res = memory::Entity::update_many()
                .col_expr(memory::Column::Recalled, Expr::col(memory::Column::Recalled).add(1))
                .col_expr(memory::Column::RecalledAt, Expr::value(Some(at)))
                .filter(memory::Column::Id.is_in(chunk.iter().cloned()))
                .exec(self.db.write_conn())
                .await?;
            affected += res.rows_affected;
        }
        Ok(affected)
    }

    pub(crate) async fn upsert_issue_memory_in_tx(&self, tx: &Tx, entry: &NewMemory) -> DbResult<()> {
        upsert_issue_memory_impl(tx, entry).await
    }

    /// Searches active memories for `agent` using SQLite FTS5 (`memory_fts`) or PostgreSQL
    /// trigram GIN (`memory_text_trgm_idx`) with exact case-insensitive substring fallback.
    #[allow(dead_code)]
    pub(crate) async fn search(&self, agent: &str, text: &str, limit: u64) -> DbResult<Vec<Memory>> {
        let trimmed = text.trim();
        if trimmed.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.db.read_conn();
        let backend = conn.get_database_backend();
        let mut stmt = Query::select();
        stmt.columns([
            (memory::Entity, memory::Column::Id),
            (memory::Entity, memory::Column::Agent),
            (memory::Entity, memory::Column::Kind),
            (memory::Entity, memory::Column::Scope),
            (memory::Entity, memory::Column::Title),
            (memory::Entity, memory::Column::Body),
            (memory::Entity, memory::Column::Repo),
            (memory::Entity, memory::Column::Session),
            (memory::Entity, memory::Column::Author),
            (memory::Entity, memory::Column::Importance),
            (memory::Entity, memory::Column::ReplacedBy),
            (memory::Entity, memory::Column::CreatedAt),
            (memory::Entity, memory::Column::UpdatedAt),
            (memory::Entity, memory::Column::Recalled),
            (memory::Entity, memory::Column::RecalledAt),
        ])
        .from(memory::Entity)
        .and_where(Expr::col((memory::Entity, memory::Column::Agent)).eq(agent))
        .and_where(Expr::col((memory::Entity, memory::Column::ReplacedBy)).is_null());

        if backend == sea_orm::DatabaseBackend::Sqlite
            && let Some(phrase) = fts5_trigram_phrase(trimmed)
        {
            let fts = Alias::new("memory_fts");
            stmt.join(
                JoinType::InnerJoin,
                fts.clone(),
                Expr::col((fts, Alias::new("rowid"))).equals((memory::Entity, Alias::new("rowid"))),
            )
            .and_where(Expr::cust_with_values("memory_fts MATCH ?", [sea_orm::Value::from(phrase)]));
        } else {
            let pattern = format!("%{}%", super::escape_like(&trimmed.to_lowercase()));
            let combined = Expr::cust("LOWER(COALESCE(memory.title, '') || ' ' || memory.body)");
            stmt.and_where(combined.like(LikeExpr::new(pattern).escape('\\')));
        }

        stmt.order_by((memory::Entity, memory::Column::CreatedAt), Order::Desc)
            .order_by((memory::Entity, memory::Column::Id), Order::Desc)
            .limit(limit);

        let rows = self
            .db
            .query_metrics()
            .observe(
                "memory.search",
                "SELECT memory (search)",
                memory::Model::find_by_statement(backend.build(&stmt)).all(conn),
            )
            .await?;
        Ok(rows.into_iter().map(read_memory).collect())
    }
}
