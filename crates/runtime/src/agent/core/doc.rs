use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::ai::models::{charge_usd, deepseek_price};
use crate::agent::ai::types::{ToolSpec, Usage};
use crate::agent::compaction::FileOps;
use crate::agent::core::extension::RubricVerdict;
use crate::agent::core::pipeline::PromptSection;
use crate::agent::durable::{self, Document, Read, Tx};

pub const CONVERSATION_SCOPE: &str = "conversation";
pub const TASK_SCOPE: &str = "task";

pub trait DocSpec {
    const KIND: &'static str;
    const VERSION: u32;
    type State: Serialize + DeserializeOwned + Default;
}

pub fn read_doc_opt<D: DocSpec>(tx: &Read<'_>, scope: &str, scope_id: &str) -> durable::Result<Option<D::State>> {
    tx.document(scope, scope_id, D::KIND)?
        .map(|doc| serde_json::from_value(doc.state).map_err(Into::into))
        .transpose()
}

pub fn read_doc<D: DocSpec>(tx: &Read<'_>, scope: &str, scope_id: &str) -> durable::Result<D::State> {
    Ok(read_doc_opt::<D>(tx, scope, scope_id)?.unwrap_or_default())
}

pub fn write_doc<D: DocSpec>(tx: &mut Tx<'_>, scope: &str, scope_id: &str, state: &D::State) -> durable::Result<Document> {
    let value = serde_json::to_value(state)?;
    tx.put_document(scope, scope_id, D::KIND, &value)
}

pub fn update_doc<D: DocSpec>(tx: &mut Tx<'_>, scope: &str, scope_id: &str, f: impl FnOnce(&mut D::State) -> durable::Result<()>) -> durable::Result<D::State> {
    let mut state = read_doc::<D>(tx, scope, scope_id)?;
    f(&mut state)?;
    write_doc::<D>(tx, scope, scope_id, &state)?;
    Ok(state)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentState {
    pub role: String,
    pub model: String,
    pub read_only: bool,
    pub tools: Vec<String>,
    pub max_iterations: Option<u32>,
}

pub struct AgentDoc;
impl DocSpec for AgentDoc {
    const KIND: &'static str = "pi.agent";
    const VERSION: u32 = 1;
    type State = AgentState;
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InboxState {
    pub items: Vec<Value>,
}

pub struct InboxDoc;
impl DocSpec for InboxDoc {
    const KIND: &'static str = "pi.inbox";
    const VERSION: u32 = 1;
    type State = InboxState;
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveState {
    pub text: String,
    pub reasoning: String,
}

pub struct LiveDoc;
impl DocSpec for LiveDoc {
    const KIND: &'static str = "pi.live";
    const VERSION: u32 = 1;
    type State = LiveState;
}

pub struct FileOpsDoc;
impl DocSpec for FileOpsDoc {
    const KIND: &'static str = "pi.file_ops";
    const VERSION: u32 = 1;
    type State = FileOps;
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_micros: Option<i64>,
}

impl UsageTotals {
    pub fn from_usage(model: &str, usage: Usage) -> Self {
        let cost = deepseek_price(model).map(|p| (charge_usd(p, usage) * 1_000_000.0).round() as i64);
        Self {
            input_tokens: usage.input as i64,
            output_tokens: usage.output as i64,
            cache_read_tokens: usage.cache_read as i64,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            cost_micros: cost,
        }
    }

    pub fn add(&mut self, other: UsageTotals) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self.cache_read_tokens.saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self.cache_write_tokens.saturating_add(other.cache_write_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
        if let Some(spend) = other.cost_micros {
            self.cost_micros = Some(self.cost_micros.unwrap_or(0).saturating_add(spend));
        }
    }

    pub fn record(self, tx: &mut Tx<'_>, conv: &str) -> durable::Result<()> {
        update_doc::<UsageDoc>(tx, CONVERSATION_SCOPE, conv, |cur| {
            cur.add(self);
            Ok(())
        })?;
        Ok(())
    }

    pub fn record_task(self, tx: &mut Tx<'_>, task_id: &str) -> durable::Result<()> {
        update_doc::<UsageDoc>(tx, TASK_SCOPE, task_id, |cur| {
            cur.add(self);
            Ok(())
        })?;
        Ok(())
    }
}

pub struct UsageDoc;
impl DocSpec for UsageDoc {
    const KIND: &'static str = "pi.usage";
    const VERSION: u32 = 1;
    type State = UsageTotals;
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BudgetConfig {
    pub max_cost_micros: i64,
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BudgetSnapshot {
    pub spent_micros: i64,
    pub max_cost_micros: i64,
    pub reached: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionEvaluation {
    pub tool_name: String,
    pub policy: String,
    pub verdict: String,
    pub reason: String,
    pub client_overridable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PendingApproval {
    pub task_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args_json: Value,
    pub evaluation: PermissionEvaluation,
    pub requested_at_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GovernanceState {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<BudgetConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_snapshot: Option<BudgetSnapshot>,
    pub evaluated_permissions: Vec<PermissionEvaluation>,
    pub hard_denied_calls: BTreeMap<String, bool>,
    pub pending_permissions: BTreeMap<String, PendingApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_rubric_verdict: Option<RubricVerdict>,
    pub rubric_history: Vec<RubricVerdict>,
}

pub struct GovernanceDoc;
impl DocSpec for GovernanceDoc {
    const KIND: &'static str = "pi.governance";
    const VERSION: u32 = 1;
    type State = GovernanceState;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoState {
    #[default]
    Waiting,
    Working,
    Done,
    Failed,
    Skipped,
}

impl TodoState {
    pub fn word(self) -> &'static str {
        match self {
            TodoState::Waiting => "还没做",
            TodoState::Working => "在做",
            TodoState::Done => "做完了",
            TodoState::Failed => "没做成",
            TodoState::Skipped => "跳过了",
        }
    }

    pub fn settled(self) -> bool {
        matches!(self, TodoState::Done | TodoState::Skipped)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub brief: String,
    pub after: Vec<String>,
    pub state: TodoState,
    pub result: Option<String>,
    pub tries: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoDocState {
    pub items: Vec<TodoItem>,
}

pub struct TodoDoc;
impl DocSpec for TodoDoc {
    const KIND: &'static str = "vibevalley.todo";
    const VERSION: u32 = 1;
    type State = TodoDocState;
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OarSessionState {
    pub runtime_id: String,
    pub vendor_session_id: String,
    pub cwd: String,
    pub permission_mode: String,
    pub status: String,
}

pub struct OarSessionDoc;
impl DocSpec for OarSessionDoc {
    const KIND: &'static str = "vibevalley.oar";
    const VERSION: u32 = 1;
    type State = OarSessionState;
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StandInState {
    pub sections: Vec<PromptSection>,
    pub tool_specs: Vec<ToolSpec>,
}

pub struct StandInDoc;
impl DocSpec for StandInDoc {
    const KIND: &'static str = "pi.standin";
    const VERSION: u32 = 1;
    type State = StandInState;
}
