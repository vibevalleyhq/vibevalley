//! Deterministic JavaScript turns driven by durable child tasks and timers.
mod instrument;
mod vm;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::durable::{Error, Result, Scheduler, Task, TaskContext, TaskStatus, Transition, WaitMode};

pub const KIND: &str = "pi.codemode";
pub const EXEC: &str = "codemode_exec";
const TOOL: &str = "pi.codemode.tool";
pub const RUN: &str = "codemode_tool_run";
const WAKE: &str = "codemode_sleep_wake";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodeModeSpec {
    pub script: String,
    pub seed: u64,
    pub start_time_ms: i64,
    pub max_steps: i64,
    pub max_vars: i64,
    pub max_output_bytes: i64,
    pub max_memory_bytes: i64,
    pub max_string_bytes: i64,
    pub timeout_ms: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeModeResult {
    pub value: Value,
    pub executed_steps: u64,
    pub replayed_calls: u64,
    pub replayed_sleeps: u64,
    pub virtual_now_ms: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolRecord {
    tool_name: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sleep {
    spec: CodeModeSpec,
    sleep_key: String,
    sleep_ms: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    tool_name: String,
    args: Value,
}
enum Outcome {
    Complete(CodeModeResult),
    Tool(String, Tool),
    Sleep(String, i64),
}

pub fn register<F, Fut>(scheduler: &Scheduler, tool: F)
where
    F: Fn(TaskContext, String, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value>> + Send + 'static,
{
    let tool = Arc::new(tool);
    register_with(scheduler, move |tc, name, args| {
        let tool = Arc::clone(&tool);
        async move { Ok(Transition::Complete(tool(tc, name, args).await?)) }
    });
}

/// The caller may park a tool on the same permission or budget signal as generation.
pub fn register_with<F, Fut>(scheduler: &Scheduler, tool: F)
where
    F: Fn(TaskContext, String, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Transition>> + Send + 'static,
{
    let tool = Arc::new(tool);
    scheduler.register(KIND, EXEC, exec);
    scheduler.register(KIND, WAKE, |tc| async move {
        let sleep: Sleep = serde_json::from_value(tc.task.checkpoint.clone())?;
        tc.memo(&sleep.sleep_key, || async { Ok(json!(true)) }).await?;
        Ok(Transition::Next {
            phase: EXEC.into(),
            checkpoint: Some(serde_json::to_value(sleep.spec)?),
        })
    });
    scheduler.register(TOOL, RUN, move |tc| {
        let tool = Arc::clone(&tool);
        async move {
            let call: Tool = serde_json::from_value(tc.task.checkpoint.clone())?;
            tool(tc, call.tool_name, call.args).await
        }
    });
}

async fn exec(tc: TaskContext) -> Result<Transition> {
    let spec: CodeModeSpec = serde_json::from_value(tc.task.checkpoint.clone())?;
    let mut records = HashMap::new();
    let mut sleeps = HashSet::new();
    let prefix = format!("{}:call:", tc.task.id);
    if let Some(memo) = tc.task.memo.as_object() {
        for (key, v) in memo {
            if key.starts_with(&prefix) {
                records.insert(key.clone(), serde_json::from_value::<ToolRecord>(v.clone())?);
            }
            if key.starts_with("__cm_sleep_") {
                sleeps.insert(key.clone());
            }
        }
    }
    let tid = tc.task.id.clone();
    for child in tc.store.read_async(move |r| Box::pin(async move { r.children_async(&tid).await })).await? {
        if child.kind != TOOL || child.status != TaskStatus::Terminal || records.contains_key(&child.dedup_key) {
            continue;
        }
        let call: Tool = serde_json::from_value(child.checkpoint)?;
        let ok = child.terminal_reason == "completed";
        let error = if child.error_text.is_empty() {
            child.terminal_reason
        } else {
            child.error_text
        };
        let rec = ToolRecord {
            tool_name: call.tool_name,
            ok,
            result: ok.then_some(child.result),
            error: (!ok).then_some(error),
        };
        let rec_val = serde_json::to_value(&rec)?;
        tc.memo(&child.dedup_key, || async move { Ok(rec_val) }).await?;
        records.insert(child.dedup_key, rec);
    }
    let task_id = tc.task.id.clone();
    let created_at_ms = tc.task.created_at_ms;
    let cancel = tc.cancel_token();
    let spec_for_vm = spec.clone();
    let outcome = tokio::task::spawn_blocking(move || vm::execute(task_id, created_at_ms, cancel, &spec_for_vm, records, sleeps))
        .await
        .map_err(|e| Error::Invalid(format!("codemode vm task failed: {e}")))?
        .map_err(Error::Invalid)?;
    match outcome {
        Outcome::Complete(result) => Ok(Transition::Complete(serde_json::to_value(result)?)),
        Outcome::Tool(key, call) => {
            let mut child = Task::new(TOOL, RUN);
            child.dedup_key = key;
            child.checkpoint = serde_json::to_value(call)?;
            let (child, _) = tc.spawn_child(child).await?;
            Ok(Transition::Wait {
                phase: EXEC.into(),
                checkpoint: None,
                mode: WaitMode::FailFast,
                children: vec![child.id],
            })
        }
        Outcome::Sleep(key, ms) => {
            let until_ms = tc
                .store
                .now_ms()
                .checked_add(ms)
                .ok_or_else(|| Error::Invalid("sleep duration overflow".into()))?;
            Ok(Transition::Sleep {
                phase: WAKE.into(),
                checkpoint: Some(serde_json::to_value(Sleep {
                    spec,
                    sleep_key: key,
                    sleep_ms: ms,
                })?),
                until_ms: Some(until_ms.max(1)),
                signal: None,
            })
        }
    }
}
