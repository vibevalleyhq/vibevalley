use std::collections::HashSet;

use serde_json::json;

use crate::BoxFuture;
use crate::agent::core::doc::{BudgetConfig, CONVERSATION_SCOPE, DocSpec, GovernanceDoc, TASK_SCOPE, UsageDoc, read_doc, read_doc_opt, write_doc};
use crate::agent::core::extension::{DurableHookCtx, Extension, HookOutcome};
use crate::agent::durable::{self, Error, Read, Result, Scheduler, Store, Tx};

pub const BUDGET_SIGNAL: &str = "budget.updated";

pub use crate::agent::core::doc::BudgetSnapshot as Budget;

pub async fn tree_spend(tx: &Read<'_>, conv: &str) -> Result<i64> {
    let mut conversations = vec![conv.to_owned()];
    let mut seen_conversations = HashSet::new();
    let mut seen_tasks = HashSet::new();
    let mut total = 0_i64;
    while let Some(id) = conversations.pop() {
        if !seen_conversations.insert(id.clone()) {
            continue;
        }
        let conv_usage = read_doc::<UsageDoc>(tx, CONVERSATION_SCOPE, &id).await?;
        total = total.saturating_add(conv_usage.cost_micros.unwrap_or_default());
        let mut tasks = tx.tasks_by_conversation_async(&id).await?;
        while let Some(task) = tasks.pop() {
            if !seen_tasks.insert(task.id.clone()) {
                continue;
            }
            let task_usage = read_doc::<UsageDoc>(tx, TASK_SCOPE, &task.id).await?;
            total = total.saturating_add(task_usage.cost_micros.unwrap_or_default());
            conversations.extend(tx.conversations_by_owner_task_async(&task.id).await?.into_iter().map(|c| c.id));
            tasks.extend(tx.children_async(&task.id).await?);
        }
    }
    Ok(total)
}

async fn budget_snapshot(tx: &Read<'_>, conv: &str, max: i64) -> Result<Budget> {
    let spent = tree_spend(tx, conv).await?;
    Ok(Budget {
        spent_micros: spent,
        max_cost_micros: max,
        reached: max > 0 && spent >= max,
    })
}

pub async fn set_budget(store: &Store, _scheduler: &Scheduler, conv: &str, task: Option<&str>, max: i64) -> Result<Budget> {
    let conv = conv.to_owned();
    let task = task.map(str::to_owned);
    store
        .write_async(move |tx| {
            Box::pin(async move {
                tx.conversation_async(&conv).await?;
                if let Some(id) = &task
                    && tx.task_async(id).await?.conversation_id != conv
                {
                    return Err(Error::Invalid("budget update belongs to another conversation".into()));
                }
                let mut gov = read_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &conv).await?;
                let prev = gov.clone();
                let snap = budget_snapshot(tx, &conv, max).await?;
                gov.budget = Some(BudgetConfig { max_cost_micros: max });
                gov.budget_snapshot = Some(snap);
                gov.status = if snap.reached { "budget_reached".into() } else { "active".into() };
                let rev = if prev != gov {
                    write_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &conv, &gov).await?.rev
                } else {
                    tx.document_async(CONVERSATION_SCOPE, &conv, GovernanceDoc::KIND).await?.map_or(0, |d| d.rev)
                };
                if let Some(id) = &task {
                    tx.send_signal_async(id, BUDGET_SIGNAL, Some(&format!("budget:{rev}")), &json!(snap)).await?;
                }
                Ok(snap)
            })
        })
        .await
}

pub async fn check_budget(tx: &mut Tx<'_>, conv: &str, task: &str) -> Result<Budget> {
    let Some(mut gov) = read_doc_opt::<GovernanceDoc>(tx, CONVERSATION_SCOPE, conv).await? else {
        return Ok(Budget::default());
    };
    let max = gov.budget.map_or(0, |b| b.max_cost_micros);
    if max <= 0 {
        return Ok(Budget::default());
    }
    let snap = budget_snapshot(tx, conv, max).await?;
    let next_status = if snap.reached { "budget_reached" } else { "active" };
    if snap.reached && (gov.status != "budget_reached" || gov.budget_snapshot != Some(snap)) {
        tx.alert_async(
            Some(conv),
            &json!({
                "kind": "budget_reached",
                "taskId": task,
                "conversationId": conv,
                "title": "Session budget reached",
                "payload": snap,
                "createdAtMs": tx.now_ms,
            }),
        )
        .await?;
    }
    if gov.status != next_status || gov.budget_snapshot != Some(snap) {
        gov.status = next_status.into();
        gov.budget_snapshot = Some(snap);
        write_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, conv, &gov).await?;
    }
    Ok(snap)
}

/// Checks budget via a read-only fast path so conversations without a configured
/// budget never open an empty write transaction.
pub(crate) async fn check_budget_if_configured(store: &Store, conv: &str, task: &str) -> Result<Budget> {
    let conv_read = conv.to_owned();
    let configured = store
        .read_async(move |tx| {
            Box::pin(async move {
                Ok(read_doc_opt::<GovernanceDoc>(tx, CONVERSATION_SCOPE, &conv_read)
                    .await?
                    .and_then(|g| g.budget)
                    .is_some_and(|b| b.max_cost_micros > 0))
            })
        })
        .await?;
    if !configured {
        return Ok(Budget::default());
    }
    let conv_write = conv.to_owned();
    let task_write = task.to_owned();
    store
        .write_async(move |tx| Box::pin(async move { check_budget(tx, &conv_write, &task_write).await }))
        .await
}

#[derive(Clone, Default)]
pub struct BudgetExtension;

impl Extension for BudgetExtension {
    fn name(&self) -> &str {
        "budget"
    }

    fn on_before_turn<'a>(&'a self, ctx: &'a DurableHookCtx<'_>) -> BoxFuture<'a, durable::Result<HookOutcome>> {
        Box::pin(async move {
            let snap = check_budget_if_configured(ctx.store, ctx.conversation_id, ctx.task_id).await?;
            if snap.reached {
                Ok(HookOutcome::Park {
                    signal: BUDGET_SIGNAL.into(),
                    until_ms: None,
                })
            } else {
                Ok(HookOutcome::Continue)
            }
        })
    }
}
