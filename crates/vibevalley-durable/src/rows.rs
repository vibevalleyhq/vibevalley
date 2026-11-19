use crate::id;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct Conversation {
    pub id: String,
    pub owner_task_id: String,
    pub parent_id: String,
    pub fork_entry_seq: i64,
    pub head_seq: i64,
    pub next_seq: i64,
    pub provider_affinity: String,
    pub metadata: Value,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub conversation_id: String,
    pub seq: i64,
    pub kind: String,
    pub payload: Value,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub scope_kind: String,
    pub scope_id: String,
    pub doc_kind: String,
    pub rev: i64,
    pub state: Value,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentEvent {
    pub document: Document,
    pub retired: bool,
    pub durable: bool,
}

macro_rules! sql_enum {
    ($name:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $s)] $variant),+
        }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
        }
        impl std::str::FromStr for $name {
            type Err = crate::Error;
            fn from_str(value: &str) -> crate::Result<Self> {
                match value {
                    $($s => Ok(Self::$variant)),+,
                    other => Err(crate::Error::Invalid(format!("unrecognized {} {other:?}", stringify!($name)))),
                }
            }
        }
    }
}
sql_enum!(SubmissionStatus { Queued => "queued", Placed => "placed", Done => "done", Unanswered => "unanswered" });
sql_enum!(TaskStatus {
    Pending => "pending", Running => "running", Sleeping => "sleeping",
    Waiting => "waiting", Completing => "completing", Terminal => "terminal"
});
sql_enum!(WaitMode { AllSettled => "allSettled", FailFast => "failFast", Any => "any" });

#[derive(Debug, Clone)]
pub struct Submission {
    pub id: String,
    pub conversation_id: String,
    pub request_id: String,
    pub kind: String,
    pub status: SubmissionStatus,
    pub payload: Value,
    pub notify_task_id: String,
    pub result: Value,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub id: String,
    pub task_id: String,
    pub signal_name: String,
    pub signal_key: String,
    #[serde(rename = "payloadJson", with = "json_bytes")]
    pub payload: Value,
    pub consumed: bool,
    pub consumed_at_ms: i64,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub conversation_id: String,
    pub owner_task_id: String,
    pub dedup_key: String,
    pub kind: String,
    pub is_model_task: bool,
    pub status: TaskStatus,
    pub terminal_reason: String,
    pub restart_count: u32,
    pub restart_limit: u32,
    pub phase_name: String,
    pub checkpoint: Value,
    pub wake_until_ms: i64,
    pub wait_mode: Option<WaitMode>,
    pub wait_task_ids: Vec<String>,
    pub wait_signal_name: String,
    pub memo: Value,
    pub result: Value,
    pub error_text: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl Task {
    pub fn new(kind: &str, phase: &str) -> Self {
        Self {
            id: id(),
            kind: kind.into(),
            phase_name: phase.into(),
            conversation_id: String::new(),
            owner_task_id: String::new(),
            dedup_key: String::new(),
            is_model_task: false,
            status: TaskStatus::Pending,
            terminal_reason: String::new(),
            restart_count: 0,
            restart_limit: 5,
            checkpoint: json!({}),
            wake_until_ms: 0,
            wait_mode: None,
            wait_task_ids: vec![],
            wait_signal_name: String::new(),
            memo: json!({}),
            result: json!({}),
            error_text: String::new(),
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Compaction<'a> {
    pub level: &'a str,
    pub base_head: i64,
    pub from: i64,
    pub cut: i64,
    pub summary: &'a str,
    pub token_count: i64,
}
#[derive(Debug, Clone, Copy, Default)]
pub struct CommitStats {
    pub requests: u64,
    pub batches: u64,
    pub committed_ops: u64,
    pub failed_ops: u64,
    pub coalesced_live_memory: u64,
    pub coalesced_live_disk: u64,
}

// The Go checkpoint encodes its raw JSON byte slice as base64 inside the wake memo.
mod json_bytes {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _};
    use serde_json::Value;

    pub fn serialize<S: Serializer>(value: &Value, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(value.to_string()))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
        let bytes = STANDARD.decode(String::deserialize(deserializer)?).map_err(D::Error::custom)?;
        serde_json::from_slice(&bytes).map_err(D::Error::custom)
    }
}
