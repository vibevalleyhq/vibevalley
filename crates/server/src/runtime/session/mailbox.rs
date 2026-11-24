//! Persistent dual-backend mailbox helpers for [`super::SessionEngine`],
//! delegating all database operations to `ctx.service.session.*`.

pub use crate::service::session::{MailboxEntry, MailboxSource, MailboxStatus};

use super::engine::SessionEngine;
use crate::context::now;
use crate::runtime::Result;

impl SessionEngine {
    pub async fn enqueue_mailbox_async(
        &self,
        session_id: &str,
        idempotency_key: &str,
        source: MailboxSource,
        source_message_id: Option<&str>,
        payload: &str,
    ) -> Result<MailboxEntry> {
        Ok(self
            .0
            .ctx
            .service
            .session
            .enqueue_mailbox(session_id, idempotency_key, source, source_message_id, payload, now())
            .await?)
    }

    pub async fn withdraw_mailbox_async(&self, idempotency_key: &str) -> Result<bool> {
        Ok(self.0.ctx.service.session.withdraw_mailbox(idempotency_key, now()).await?)
    }

    pub async fn withdraw_mailbox_by_message_async(&self, message_id: &str) -> Result<u64> {
        Ok(self.0.ctx.service.session.withdraw_mailbox_by_message(message_id, now()).await?)
    }

    pub async fn claim_next_mailbox_async(&self, session_id: &str) -> Result<Option<MailboxEntry>> {
        Ok(self.0.ctx.service.session.claim_next_mailbox(session_id, now()).await?)
    }

    pub async fn claim_mailbox_by_key_async(&self, idempotency_key: &str) -> Result<bool> {
        Ok(self.0.ctx.service.session.claim_mailbox_by_key(idempotency_key, now()).await?)
    }

    pub async fn settle_mailbox_async(&self, id: i64, ok: bool, result: Option<&str>) -> Result<()> {
        Ok(self.0.ctx.service.session.settle_mailbox(id, ok, result, now()).await?)
    }

    pub async fn mailbox_entries_async(&self, session_id: &str) -> Result<Vec<MailboxEntry>> {
        Ok(self.0.ctx.service.session.list_mailbox(session_id).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::Service;

    #[tokio::test]
    async fn mailbox_enqueue_idempotency_single_claim_and_withdraw_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let sessions = &service.session;

        let a = sessions
            .enqueue_mailbox("s1", "k1", MailboxSource::WorkspaceUser, None, "hello", 10)
            .await
            .unwrap();
        let a_dup = sessions
            .enqueue_mailbox("s1", "k1", MailboxSource::WorkspaceUser, None, "changed", 20)
            .await
            .unwrap();
        assert_eq!(a_dup.id, a.id);
        assert_eq!(a_dup.payload, "hello");
        assert_eq!(a_dup.status, MailboxStatus::Pending);

        let b = sessions
            .enqueue_mailbox("s1", "k2", MailboxSource::ChannelDirect, Some("m-2"), "second", 30)
            .await
            .unwrap();
        let c = sessions
            .enqueue_mailbox("orch", "k3", MailboxSource::ChannelOrchestrator, Some("m-2"), "second", 30)
            .await
            .unwrap();
        let d = sessions
            .enqueue_mailbox("issue:1", "k4", MailboxSource::IssueComment, Some("m-2"), "second", 30)
            .await
            .unwrap();
        assert_eq!(sessions.withdraw_mailbox_by_message("m-2", 31).await.unwrap(), 3);
        assert_eq!(sessions.withdraw_mailbox_by_message("m-2", 32).await.unwrap(), 0);
        assert!(!sessions.withdraw_mailbox("k2", 32).await.unwrap());

        assert!(sessions.claim_mailbox_by_key("k1", 40).await.unwrap());
        assert!(!sessions.claim_mailbox_by_key("k1", 41).await.unwrap());
        assert!(!sessions.withdraw_mailbox("k1", 42).await.unwrap());
        assert!(!sessions.claim_mailbox_by_key("k2", 43).await.unwrap());

        sessions.settle_mailbox(a.id, true, Some("ok"), 50).await.unwrap();
        let entries = sessions.list_mailbox("s1").await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, a.id);
        assert_eq!(entries[0].status, MailboxStatus::Done);
        assert_eq!(entries[0].result.as_deref(), Some("ok"));
        assert_eq!(entries[1].id, b.id);
        assert_eq!(entries[1].status, MailboxStatus::Withdrawn);
        assert_eq!(sessions.list_mailbox("orch").await.unwrap()[0].id, c.id);
        assert_eq!(sessions.list_mailbox("orch").await.unwrap()[0].status, MailboxStatus::Withdrawn);
        assert_eq!(sessions.list_mailbox("issue:1").await.unwrap()[0].id, d.id);
        assert_eq!(sessions.list_mailbox("issue:1").await.unwrap()[0].status, MailboxStatus::Withdrawn);
        service.close().await;
    }
}
