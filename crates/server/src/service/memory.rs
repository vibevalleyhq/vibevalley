//! Dual-backend persistence for agent memory rows (`memory`).

use std::sync::Arc;

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, QueryFilter, QueryOrder};
use vibevalley_protocol::{ActorKind, Memory, MemoryKind};

use crate::db::column::{db_word, read_db_word};
use crate::db::entity::memory;
use crate::db::{Database, DbResult, Tx, begin_write_tx, commit_tx, rollback_tx};

#[derive(Debug, Clone)]
pub struct NewMemory {
    pub id: String,
    pub agent: String,
    pub kind: MemoryKind,
    pub body: String,
    pub repo: Option<String>,
    pub session: Option<String>,
    pub author: ActorKind,
    pub created_at: i64,
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
    }
}

async fn list_impl<C: ConnectionTrait>(db: &C, agent: &str) -> DbResult<Vec<Memory>> {
    let rows = memory::Entity::find()
        .filter(memory::Column::Agent.eq(agent))
        .order_by_desc(memory::Column::CreatedAt)
        .order_by_desc(memory::Column::Id)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(read_memory).collect())
}

async fn insert_impl<C: ConnectionTrait>(db: &C, entry: &NewMemory) -> DbResult<()> {
    memory::ActiveModel {
        id: Set(entry.id.clone()),
        agent: Set(entry.agent.clone()),
        kind: Set(db_word(&entry.kind)?),
        body: Set(entry.body.clone()),
        repo: Set(entry.repo.clone()),
        session: Set(entry.session.clone()),
        author: Set(db_word(&entry.author)?),
        created_at: Set(entry.created_at),
        updated_at: Set(entry.created_at),
        recalled: Set(0),
        recalled_at: Set(None),
    }
    .insert(db)
    .await?;
    Ok(())
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
    let res = memory::Entity::delete_many()
        .filter(memory::Column::Agent.eq(agent))
        .filter(memory::Column::Id.is_in(ids.iter().cloned()))
        .exec(db)
        .await?;
    Ok(res.rows_affected)
}

async fn upsert_issue_memory_impl<C: ConnectionTrait>(db: &C, entry: &NewMemory) -> DbResult<()> {
    let model = memory::ActiveModel {
        id: Set(entry.id.clone()),
        agent: Set(entry.agent.clone()),
        kind: Set(db_word(&MemoryKind::Issue)?),
        body: Set(entry.body.clone()),
        repo: Set(entry.repo.clone()),
        session: Set(entry.session.clone()),
        author: Set(db_word(&entry.author)?),
        created_at: Set(entry.created_at),
        updated_at: Set(entry.created_at),
        recalled: Set(0),
        recalled_at: Set(None),
    };
    let on_conflict = OnConflict::columns([memory::Column::Agent, memory::Column::Session])
        .target_and_where(Expr::col(memory::Column::Kind).eq(Expr::cust("'issue'")))
        .update_columns([memory::Column::Body, memory::Column::Repo, memory::Column::CreatedAt, memory::Column::UpdatedAt])
        .to_owned();
    memory::Entity::insert(model).on_conflict(on_conflict).exec(db).await?;
    Ok(())
}

#[derive(Clone)]
pub struct MemoryService {
    db: Arc<Database>,
}

impl MemoryService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub async fn list(&self, agent: &str) -> DbResult<Vec<Memory>> {
        list_impl(self.db.read_conn(), agent).await
    }

    pub async fn list_in_tx(&self, tx: &Tx, agent: &str) -> DbResult<Vec<Memory>> {
        list_impl(tx, agent).await
    }

    pub async fn insert(&self, entry: &NewMemory) -> DbResult<()> {
        insert_impl(self.db.write_conn(), entry).await
    }

    pub async fn insert_in_tx(&self, tx: &Tx, entry: &NewMemory) -> DbResult<()> {
        insert_impl(tx, entry).await
    }

    /// Deletes all non-user notes for `agent` inside `tx`.
    pub async fn delete_agent_notes_in_tx(&self, tx: &Tx, agent: &str) -> DbResult<u64> {
        delete_agent_notes_impl(tx, agent).await
    }

    /// Atomically replaces all non-user notes for `agent` with `notes`.
    pub async fn rewrite_agent_notes(&self, agent: &str, notes: &[NewMemory]) -> DbResult<usize> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        let outcome: DbResult<usize> = async {
            delete_agent_notes_impl(&tx, agent).await?;
            for entry in notes {
                insert_impl(&tx, entry).await?;
            }
            Ok(notes.len())
        }
        .await;
        match outcome {
            Ok(count) => {
                commit_tx(tx).await?;
                Ok(count)
            }
            Err(err) => {
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    pub async fn delete(&self, agent: &str, id: &str) -> DbResult<u64> {
        delete_impl(self.db.write_conn(), agent, id).await
    }

    pub async fn delete_in_tx(&self, tx: &Tx, agent: &str, id: &str) -> DbResult<u64> {
        delete_impl(tx, agent, id).await
    }

    pub async fn delete_many(&self, agent: &str, ids: &[String]) -> DbResult<u64> {
        delete_many_impl(self.db.write_conn(), agent, ids).await
    }

    pub async fn delete_many_in_tx(&self, tx: &Tx, agent: &str, ids: &[String]) -> DbResult<u64> {
        delete_many_impl(tx, agent, ids).await
    }

    pub async fn record_recalled(&self, ids: &[String], at: i64) -> DbResult<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let res = memory::Entity::update_many()
            .col_expr(memory::Column::Recalled, Expr::col(memory::Column::Recalled).add(1))
            .col_expr(memory::Column::RecalledAt, Expr::value(Some(at)))
            .filter(memory::Column::Id.is_in(ids.iter().cloned()))
            .exec(self.db.write_conn())
            .await?;
        Ok(res.rows_affected)
    }

    pub async fn upsert_issue_memory(&self, entry: &NewMemory) -> DbResult<()> {
        upsert_issue_memory_impl(self.db.write_conn(), entry).await
    }

    pub async fn upsert_issue_memory_in_tx(&self, tx: &Tx, entry: &NewMemory) -> DbResult<()> {
        upsert_issue_memory_impl(tx, entry).await
    }
}
