//! Persistent SQLite mailbox for every `AgentSession`.
//!
//! All external message inputs (workspace chat, direct channel talks,
//! orchestrator wakes, issue comments) enter `session_mailbox` with an
//! `idempotency_key` (and optional `source_message_id`) so retries are
//! deduplicated and deleted channel messages withdraw pending entries before claim.

use serde::{Deserialize, Serialize};
use vibevalley_runtime::agent::durable::Sqlite;

use crate::db::generated::work_session as queries;
use crate::modules::infra::column::{optional, read_word, word};

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

fn read_row(r: queries::GetMailboxByKeyRow) -> sqlx::Result<MailboxEntry> {
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

/// Persistent SQLite mailbox operations for session deliveries.
pub struct SessionMailbox;

impl SessionMailbox {
    pub fn enqueue(
        db: &Sqlite<'_>,
        session_id: &str,
        idempotency_key: &str,
        source: MailboxSource,
        source_message_id: Option<&str>,
        payload: &str,
        at: i64,
    ) -> sqlx::Result<MailboxEntry> {
        let source_word = word(&source)?;
        db.query(async |c| {
            queries::insert_mailbox(
                &mut *c,
                queries::InsertMailboxParams {
                    session_id: session_id.to_string(),
                    idempotency_key: idempotency_key.to_string(),
                    source: source_word,
                    source_message_id: source_message_id.map(str::to_string),
                    payload: payload.to_string(),
                    created_at: at,
                },
            )
            .await?;
            queries::get_mailbox_by_key(
                c,
                queries::GetMailboxByKeyParams {
                    idempotency_key: idempotency_key.to_string(),
                },
            )
            .await
        })
        .and_then(read_row)
    }

    pub fn withdraw(db: &Sqlite<'_>, idempotency_key: &str, at: i64) -> sqlx::Result<bool> {
        let affected = db.query(async |c| {
            queries::withdraw_mailbox(
                c,
                queries::WithdrawMailboxParams {
                    idempotency_key: idempotency_key.to_string(),
                    updated_at: at,
                },
            )
            .await
        })?;
        Ok(affected > 0)
    }

    pub fn withdraw_by_message(db: &Sqlite<'_>, message_id: &str, at: i64) -> sqlx::Result<u64> {
        db.query(async |c| {
            queries::withdraw_mailbox_by_message(
                c,
                queries::WithdrawMailboxByMessageParams {
                    source_message_id: Some(message_id.to_string()),
                    updated_at: at,
                },
            )
            .await
        })
    }

    pub fn claim_next(db: &Sqlite<'_>, session_id: &str, at: i64) -> sqlx::Result<Option<MailboxEntry>> {
        db.query(async |c| {
            let Some(row) = optional(
                queries::next_pending_mailbox(
                    &mut *c,
                    queries::NextPendingMailboxParams {
                        session_id: session_id.to_string(),
                    },
                )
                .await,
            )?
            else {
                return Ok(None);
            };
            let claimed = queries::claim_mailbox(c, queries::ClaimMailboxParams { id: row.id, updated_at: at }).await?;
            if claimed == 0 {
                return Ok(None);
            }
            let mut entry = read_row(row)?;
            entry.status = MailboxStatus::Claimed;
            entry.updated_at = at;
            Ok(Some(entry))
        })
    }

    pub fn claim_by_key(db: &Sqlite<'_>, idempotency_key: &str, at: i64) -> sqlx::Result<bool> {
        let claimed = db.query(async |c| {
            queries::claim_mailbox_by_key(
                c,
                queries::ClaimMailboxByKeyParams {
                    idempotency_key: idempotency_key.to_string(),
                    updated_at: at,
                },
            )
            .await
        })?;
        Ok(claimed > 0)
    }

    pub fn settle(db: &Sqlite<'_>, id: i64, ok: bool, result: Option<&str>, at: i64) -> sqlx::Result<()> {
        let status = word(&if ok { MailboxStatus::Done } else { MailboxStatus::Failed })?;
        db.query(async |c| {
            queries::settle_mailbox(
                c,
                queries::SettleMailboxParams {
                    id,
                    status,
                    result: result.map(str::to_string),
                    updated_at: at,
                },
            )
            .await
        })
    }

    pub fn list(db: &Sqlite<'_>, session_id: &str) -> sqlx::Result<Vec<MailboxEntry>> {
        db.query(async |c| {
            queries::list_mailbox(
                c,
                queries::ListMailboxParams {
                    session_id: session_id.to_string(),
                },
            )
            .await
        })?
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
    ) -> crate::modules::work::ledger::Result<MailboxEntry> {
        self.0.ledger.database(|db| {
            SessionMailbox::enqueue(
                db,
                session_id,
                idempotency_key,
                source,
                source_message_id,
                payload,
                crate::modules::work::ledger::now(),
            )
        })
    }

    pub fn withdraw_mailbox(&self, idempotency_key: &str) -> crate::modules::work::ledger::Result<bool> {
        self.0
            .ledger
            .database(|db| SessionMailbox::withdraw(db, idempotency_key, crate::modules::work::ledger::now()))
    }

    pub fn withdraw_mailbox_by_message(&self, message_id: &str) -> crate::modules::work::ledger::Result<u64> {
        self.0
            .ledger
            .database(|db| SessionMailbox::withdraw_by_message(db, message_id, crate::modules::work::ledger::now()))
    }

    pub fn claim_next_mailbox(&self, session_id: &str) -> crate::modules::work::ledger::Result<Option<MailboxEntry>> {
        self.0
            .ledger
            .database(|db| SessionMailbox::claim_next(db, session_id, crate::modules::work::ledger::now()))
    }

    pub fn claim_mailbox_by_key(&self, idempotency_key: &str) -> crate::modules::work::ledger::Result<bool> {
        self.0
            .ledger
            .database(|db| SessionMailbox::claim_by_key(db, idempotency_key, crate::modules::work::ledger::now()))
    }

    pub fn settle_mailbox(&self, id: i64, ok: bool, result: Option<&str>) -> crate::modules::work::ledger::Result<()> {
        self.0
            .ledger
            .database(|db| SessionMailbox::settle(db, id, ok, result, crate::modules::work::ledger::now()))
    }

    pub fn mailbox_entries(&self, session_id: &str) -> crate::modules::work::ledger::Result<Vec<MailboxEntry>> {
        self.0.ledger.database(|db| SessionMailbox::list(db, session_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::base::ServerDb;

    #[test]
    fn mailbox_enqueue_idempotency_single_claim_and_withdraw_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let server_db = ServerDb::open(dir.path()).unwrap();
        let mut conn = server_db.acquire().unwrap();
        let db = Sqlite::new(&mut conn);

        let a = SessionMailbox::enqueue(&db, "s1", "k1", MailboxSource::WorkspaceUser, None, "hello", 10).unwrap();
        let a_dup = SessionMailbox::enqueue(&db, "s1", "k1", MailboxSource::WorkspaceUser, None, "changed", 20).unwrap();
        assert_eq!(a_dup.id, a.id);
        assert_eq!(a_dup.payload, "hello");
        assert_eq!(a_dup.status, MailboxStatus::Pending);

        let b = SessionMailbox::enqueue(&db, "s1", "k2", MailboxSource::ChannelDirect, Some("m-2"), "second", 30).unwrap();
        let c = SessionMailbox::enqueue(&db, "orch", "k3", MailboxSource::ChannelOrchestrator, Some("m-2"), "second", 30).unwrap();
        let d = SessionMailbox::enqueue(&db, "issue:1", "k4", MailboxSource::IssueComment, Some("m-2"), "second", 30).unwrap();
        assert_eq!(SessionMailbox::withdraw_by_message(&db, "m-2", 31).unwrap(), 3);
        assert_eq!(SessionMailbox::withdraw_by_message(&db, "m-2", 32).unwrap(), 0);
        assert!(!SessionMailbox::withdraw(&db, "k2", 32).unwrap());

        assert!(SessionMailbox::claim_by_key(&db, "k1", 40).unwrap());
        assert!(!SessionMailbox::claim_by_key(&db, "k1", 41).unwrap());
        assert!(!SessionMailbox::withdraw(&db, "k1", 42).unwrap());
        assert!(!SessionMailbox::claim_by_key(&db, "k2", 43).unwrap());

        SessionMailbox::settle(&db, a.id, true, Some("ok"), 50).unwrap();
        let entries = SessionMailbox::list(&db, "s1").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, a.id);
        assert_eq!(entries[0].status, MailboxStatus::Done);
        assert_eq!(entries[0].result.as_deref(), Some("ok"));
        assert_eq!(entries[1].id, b.id);
        assert_eq!(entries[1].status, MailboxStatus::Withdrawn);
        assert_eq!(SessionMailbox::list(&db, "orch").unwrap()[0].id, c.id);
        assert_eq!(SessionMailbox::list(&db, "orch").unwrap()[0].status, MailboxStatus::Withdrawn);
        assert_eq!(SessionMailbox::list(&db, "issue:1").unwrap()[0].id, d.id);
        assert_eq!(SessionMailbox::list(&db, "issue:1").unwrap()[0].status, MailboxStatus::Withdrawn);
    }
}
