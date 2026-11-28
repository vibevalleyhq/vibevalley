//! Dead-letter queue (DLQ) DTOs for failed outbox items.

use serde::{Deserialize, Serialize};

use super::OutboxItem;

/// Dead-lettered (`failed`) outbox row exposed for diagnostics and manual replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxDeadLetter {
    pub id: i64,
    pub topic: String,
    pub payload_json: String,
    pub attempts: i64,
    pub created_at: i64,
    pub last_error: Option<String>,
}

impl From<OutboxItem> for OutboxDeadLetter {
    fn from(item: OutboxItem) -> Self {
        Self {
            id: item.id,
            topic: item.topic,
            payload_json: item.payload_json,
            attempts: item.attempts,
            created_at: item.created_at,
            last_error: item.last_error,
        }
    }
}

/// Summary count and newest sample of dead-lettered outbox items.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadLetterSummary {
    pub failed_count: u64,
    pub recent: Vec<OutboxDeadLetter>,
}
