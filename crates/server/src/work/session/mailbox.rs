//! Persistent dual-backend mailbox for every `AgentSession`.
//!
//! All external message inputs (workspace chat, direct channel talks,
//! orchestrator wakes, issue comments) enter `session_mailbox` with an
//! `idempotency_key` (and optional `source_message_id`) so retries are
//! deduplicated and deleted channel messages withdraw pending entries before claim.

use sea_orm::sea_query::{Expr, Order, Query};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, Update};
use serde::{Deserialize, Serialize};

use crate::db::column::{db_word as word, read_db_word as read_word};
use crate::db::entities::work_session::session_mailbox;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailboxSource {
    WorkspaceUser,
    ChannelDirect,
    ChannelOrchestrator,
    IssueComment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailboxStatus {
    Pending,
    Claimed,
    Done,
    Failed,
    Withdrawn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailboxEntry {
    pub id: i64,
    pub session_id: String,
    pub idempotency_key: String,
    pub source: MailboxSource,
    pub source_message_id: Option<String>,
    pub payload: String,
    pub status: MailboxStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub result: Option<String>,
}

fn read_row(r: session_mailbox::Model) -> Result<MailboxEntry, DbErr> {
    Ok(MailboxEntry {
        id: r.id,
        session_id: r.session_id,
        idempotency_key: r.idempotency_key,
        source: read_word(r.source)?,
        source_message_id: r.source_message_id,
        payload: r.payload,
        status: read_word(r.status)?,
        created_at: r.created_at,
        updated_at: r.updated_at,
        result: r.result,
    })
}

/// Persistent dual-backend mailbox operations for session deliveries.
pub struct SessionMailbox;

impl SessionMailbox {
    pub async fn enqueue<C: ConnectionTrait>(
        db: &C,
        session_id: &str,
        idempotency_key: &str,
        source: MailboxSource,
        source_message_id: Option<&str>,
        payload: &str,
        at: i64,
    ) -> Result<MailboxEntry, DbErr> {
        let model = session_mailbox::ActiveModel {
            session_id: Set(session_id.to_owned()),
            idempotency_key: Set(idempotency_key.to_owned()),
            source: Set(word(&source)?),
            source_message_id: Set(source_message_id.map(str::to_owned)),
            payload: Set(payload.to_owned()),
            status: Set("pending".to_owned()),
            created_at: Set(at),
            updated_at: Set(at),
            result: Set(None),
            ..Default::default()
        };
        session_mailbox::Entity::insert(model)
            .on_conflict_do_nothing_on([session_mailbox::Column::IdempotencyKey])
            .exec(db)
            .await?;
        let row = session_mailbox::Entity::find()
            .filter(session_mailbox::Column::IdempotencyKey.eq(idempotency_key))
            .one(db)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("mailbox entry {idempotency_key} missing")))?;
        read_row(row)
    }

    pub async fn withdraw<C: ConnectionTrait>(db: &C, idempotency_key: &str, at: i64) -> Result<bool, DbErr> {
        let res = Update::many(session_mailbox::Entity)
            .col_expr(session_mailbox::Column::Status, Expr::value("withdrawn"))
            .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
            .filter(session_mailbox::Column::IdempotencyKey.eq(idempotency_key))
            .filter(session_mailbox::Column::Status.eq("pending"))
            .exec(db)
            .await?;
        Ok(res.rows_affected > 0)
    }

    pub async fn withdraw_by_message<C: ConnectionTrait>(db: &C, message_id: &str, at: i64) -> Result<u64, DbErr> {
        let res = Update::many(session_mailbox::Entity)
            .col_expr(session_mailbox::Column::Status, Expr::value("withdrawn"))
            .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
            .filter(session_mailbox::Column::SourceMessageId.eq(message_id))
            .filter(session_mailbox::Column::Status.eq("pending"))
            .exec(db)
            .await?;
        Ok(res.rows_affected)
    }

    pub async fn claim_next<C: ConnectionTrait>(db: &C, session_id: &str, at: i64) -> Result<Option<MailboxEntry>, DbErr> {
        let next_id_subquery = Query::select()
            .column(session_mailbox::Column::Id)
            .from(session_mailbox::Entity)
            .and_where(session_mailbox::Column::SessionId.eq(session_id))
            .and_where(session_mailbox::Column::Status.eq("pending"))
            .order_by(session_mailbox::Column::Id, Order::Asc)
            .limit(1)
            .to_owned();
        let rows = Update::many(session_mailbox::Entity)
            .col_expr(session_mailbox::Column::Status, Expr::value("claimed"))
            .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
            .filter(session_mailbox::Column::Id.in_subquery(next_id_subquery))
            .filter(session_mailbox::Column::Status.eq("pending"))
            .exec_with_returning(db)
            .await?;
        rows.into_iter().next().map(read_row).transpose()
    }

    pub async fn claim_by_key<C: ConnectionTrait>(db: &C, idempotency_key: &str, at: i64) -> Result<bool, DbErr> {
        let res = Update::many(session_mailbox::Entity)
            .col_expr(session_mailbox::Column::Status, Expr::value("claimed"))
            .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
            .filter(session_mailbox::Column::IdempotencyKey.eq(idempotency_key))
            .filter(session_mailbox::Column::Status.eq("pending"))
            .exec(db)
            .await?;
        Ok(res.rows_affected > 0)
    }

    pub async fn settle<C: ConnectionTrait>(db: &C, id: i64, ok: bool, result: Option<&str>, at: i64) -> Result<(), DbErr> {
        let status = word(&if ok { MailboxStatus::Done } else { MailboxStatus::Failed })?;
        Update::many(session_mailbox::Entity)
            .col_expr(session_mailbox::Column::Status, Expr::value(status))
            .col_expr(session_mailbox::Column::Result, Expr::value(result.map(str::to_owned)))
            .col_expr(session_mailbox::Column::UpdatedAt, Expr::value(at))
            .filter(session_mailbox::Column::Id.eq(id))
            .exec(db)
            .await?;
        Ok(())
    }

    pub async fn list<C: ConnectionTrait>(db: &C, session_id: &str) -> Result<Vec<MailboxEntry>, DbErr> {
        session_mailbox::Entity::find()
            .filter(session_mailbox::Column::SessionId.eq(session_id))
            .order_by_asc(session_mailbox::Column::Id)
            .all(db)
            .await?
            .into_iter()
            .map(read_row)
            .collect()
    }
}

impl super::sessions::Sessions {
    pub fn enqueue_mailbox(
        &self,
        session_id: &str,
        idempotency_key: &str,
        source: MailboxSource,
        source_message_id: Option<&str>,
        payload: &str,
    ) -> crate::work::ledger::Result<MailboxEntry> {
        let at = crate::work::ledger::now();
        self.0
            .ledger
            .write_db(async |db| SessionMailbox::enqueue(db, session_id, idempotency_key, source, source_message_id, payload, at).await)
    }

    pub fn withdraw_mailbox(&self, idempotency_key: &str) -> crate::work::ledger::Result<bool> {
        let at = crate::work::ledger::now();
        self.0.ledger.write_db(async |db| SessionMailbox::withdraw(db, idempotency_key, at).await)
    }

    pub fn withdraw_mailbox_by_message(&self, message_id: &str) -> crate::work::ledger::Result<u64> {
        let at = crate::work::ledger::now();
        self.0.ledger.write_db(async |db| SessionMailbox::withdraw_by_message(db, message_id, at).await)
    }

    pub fn claim_next_mailbox(&self, session_id: &str) -> crate::work::ledger::Result<Option<MailboxEntry>> {
        let at = crate::work::ledger::now();
        self.0.ledger.write_db(async |db| SessionMailbox::claim_next(db, session_id, at).await)
    }

    pub fn claim_mailbox_by_key(&self, idempotency_key: &str) -> crate::work::ledger::Result<bool> {
        let at = crate::work::ledger::now();
        self.0.ledger.write_db(async |db| SessionMailbox::claim_by_key(db, idempotency_key, at).await)
    }

    pub fn settle_mailbox(&self, id: i64, ok: bool, result: Option<&str>) -> crate::work::ledger::Result<()> {
        let at = crate::work::ledger::now();
        self.0.ledger.write_db(async |db| SessionMailbox::settle(db, id, ok, result, at).await)
    }

    pub fn mailbox_entries(&self, session_id: &str) -> crate::work::ledger::Result<Vec<MailboxEntry>> {
        self.0.ledger.read_db(async |db| SessionMailbox::list(db, session_id).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ServerDb;

    #[test]
    fn mailbox_enqueue_idempotency_single_claim_and_withdraw_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let server_db = ServerDb::open(dir.path()).unwrap();
        let w = server_db.write_conn();
        let r = server_db.read_conn();

        crate::work::block_on(async {
            let a = SessionMailbox::enqueue(w, "s1", "k1", MailboxSource::WorkspaceUser, None, "hello", 10)
                .await
                .unwrap();
            let a_dup = SessionMailbox::enqueue(w, "s1", "k1", MailboxSource::WorkspaceUser, None, "changed", 20)
                .await
                .unwrap();
            assert_eq!(a_dup.id, a.id);
            assert_eq!(a_dup.payload, "hello");
            assert_eq!(a_dup.status, MailboxStatus::Pending);

            let b = SessionMailbox::enqueue(w, "s1", "k2", MailboxSource::ChannelDirect, Some("m-2"), "second", 30)
                .await
                .unwrap();
            let c = SessionMailbox::enqueue(w, "orch", "k3", MailboxSource::ChannelOrchestrator, Some("m-2"), "second", 30)
                .await
                .unwrap();
            let d = SessionMailbox::enqueue(w, "issue:1", "k4", MailboxSource::IssueComment, Some("m-2"), "second", 30)
                .await
                .unwrap();
            assert_eq!(SessionMailbox::withdraw_by_message(w, "m-2", 31).await.unwrap(), 3);
            assert_eq!(SessionMailbox::withdraw_by_message(w, "m-2", 32).await.unwrap(), 0);
            assert!(!SessionMailbox::withdraw(w, "k2", 32).await.unwrap());

            assert!(SessionMailbox::claim_by_key(w, "k1", 40).await.unwrap());
            assert!(!SessionMailbox::claim_by_key(w, "k1", 41).await.unwrap());
            assert!(!SessionMailbox::withdraw(w, "k1", 42).await.unwrap());
            assert!(!SessionMailbox::claim_by_key(w, "k2", 43).await.unwrap());

            SessionMailbox::settle(w, a.id, true, Some("ok"), 50).await.unwrap();
            let entries = SessionMailbox::list(r, "s1").await.unwrap();
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].id, a.id);
            assert_eq!(entries[0].status, MailboxStatus::Done);
            assert_eq!(entries[0].result.as_deref(), Some("ok"));
            assert_eq!(entries[1].id, b.id);
            assert_eq!(entries[1].status, MailboxStatus::Withdrawn);
            assert_eq!(SessionMailbox::list(r, "orch").await.unwrap()[0].id, c.id);
            assert_eq!(SessionMailbox::list(r, "orch").await.unwrap()[0].status, MailboxStatus::Withdrawn);
            assert_eq!(SessionMailbox::list(r, "issue:1").await.unwrap()[0].id, d.id);
            assert_eq!(SessionMailbox::list(r, "issue:1").await.unwrap()[0].status, MailboxStatus::Withdrawn);
        });
        server_db.close();
    }
}
