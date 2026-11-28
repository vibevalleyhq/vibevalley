use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::durable::{Result, Submission, SubmissionStatus, Tx};

pub const KIND_PROMPT: &str = "prompt";
pub const KIND_STEER: &str = "steer";
pub const KIND_FOLLOW_UP: &str = "follow_up";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhenBusy {
    Steer,
    Queue,
    #[default]
    Reject,
}

pub async fn submit_prompt(tx: &mut Tx<'_>, conv: &str, request_id: &str, payload: &Value, notify_task: Option<&str>) -> Result<(Submission, bool)> {
    tx.submit_async(conv, request_id, KIND_PROMPT, payload, notify_task).await
}

pub async fn submit_steer(tx: &mut Tx<'_>, conv: &str, request_id: &str, text: &str) -> Result<(Submission, bool)> {
    let payload = json!({
        "text": text,
        "source": "user",
        "steered": true,
    });
    tx.submit_async(conv, request_id, KIND_STEER, &payload, None).await
}

pub async fn submit_follow_up(tx: &mut Tx<'_>, conv: &str, request_id: &str, text: &str, notify_task: Option<&str>) -> Result<(Submission, bool)> {
    let payload = json!({
        "text": text,
        "source": "user",
    });
    tx.submit_async(conv, request_id, KIND_FOLLOW_UP, &payload, notify_task).await
}

pub async fn take_pending_steers(tx: &mut Tx<'_>, conv: &str) -> Result<Vec<Submission>> {
    take_queued_kind(tx, conv, KIND_STEER).await
}

pub async fn take_pending_follow_ups(tx: &mut Tx<'_>, conv: &str) -> Result<Vec<Submission>> {
    take_queued_kind(tx, conv, KIND_FOLLOW_UP).await
}

async fn take_queued_kind(tx: &mut Tx<'_>, conv: &str, kind: &str) -> Result<Vec<Submission>> {
    let queued: Vec<_> = tx
        .submissions_async(conv)
        .await?
        .into_iter()
        .filter(|s| s.kind == kind && s.status == SubmissionStatus::Queued)
        .collect();
    let mut placed = Vec::with_capacity(queued.len());
    for sub in queued {
        placed.push(tx.set_submission_status_async(&sub.id, SubmissionStatus::Placed).await?);
    }
    Ok(placed)
}
