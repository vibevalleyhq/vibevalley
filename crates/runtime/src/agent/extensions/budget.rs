use std::collections::HashSet;

use serde_json::json;

use crate::agent::core::doc::{BudgetConfig, CONVERSATION_SCOPE, DocSpec, GovernanceDoc, TASK_SCOPE, UsageDoc, read_doc, write_doc};
use crate::agent::core::extension::{DurableHookCtx, Extension, HookOutcome};
use crate::agent::durable::{self, Error, Read, Result, Scheduler, Store, Tx};

pub const BUDGET_SIGNAL: &str = "budget.updated";

pub use crate::agent::core::doc::BudgetSnapshot as Budget;

pub fn tree_spend(tx: &Read<'_>, conv: &str) -> Result<i64> {
    let mut conversations = vec![conv.to_owned()];
    let mut seen_conversations = HashSet::new();
    let mut seen_tasks = HashSet::new();
    let mut total = 0_i64;
    while let Some(id) = conversations.pop() {
        if !seen_conversations.insert(id.clone()) {
            continue;
        }
        let conv_usage = read_doc::<UsageDoc>(tx, CONVERSATION_SCOPE, &id)?;
        total = total.saturating_add(conv_usage.cost_micros.unwrap_or_default());
        let mut tasks = tx.tasks_by_conversation(&id)?;
        while let Some(task) = tasks.pop() {
            if !seen_tasks.insert(task.id.clone()) {
                continue;
            }
            let task_usage = read_doc::<UsageDoc>(tx, TASK_SCOPE, &task.id)?;
            total = total.saturating_add(task_usage.cost_micros.unwrap_or_default());
            conversations.extend(tx.conversations_by_owner_task(&task.id)?.into_iter().map(|c| c.id));
            tasks.extend(tx.children(&task.id)?);
        }
    }
    Ok(total)
}

fn budget_snapshot(tx: &Read<'_>, conv: &str, max: i64) -> Result<Budget> {
    let spent = tree_spend(tx, conv)?;
    Ok(Budget {
        spent_micros: spent,
        max_cost_micros: max,
        reached: max > 0 && spent >= max,
    })
}

pub fn set_budget(store: &Store, _scheduler: &Scheduler, conv: &str, task: Option<&str>, max: i64) -> Result<Budget> {
    store.write(|tx| {
        tx.conversation(conv)?;
        if let Some(id) = task
            && tx.task(id)?.conversation_id != conv
        {
            return Err(Error::Invalid("budget update belongs to another conversation".into()));
        }
        let mut gov = read_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, conv)?;
        let prev = gov.clone();
        let snap = budget_snapshot(tx, conv, max)?;
        gov.budget = Some(BudgetConfig { max_cost_micros: max });
        gov.budget_snapshot = Some(snap);
        gov.status = if snap.reached { "budget_reached".into() } else { "active".into() };
        let rev = if prev != gov {
            write_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, conv, &gov)?.rev
        } else {
            tx.document(CONVERSATION_SCOPE, conv, GovernanceDoc::KIND)?.map_or(0, |d| d.rev)
        };
        if let Some(id) = task {
            tx.send_signal(id, BUDGET_SIGNAL, Some(&format!("budget:{rev}")), &json!(snap))?;
        }
        Ok(snap)
    })
}

pub fn check_budget(tx: &mut Tx<'_>, conv: &str, task: &str) -> Result<Budget> {
    let mut gov = read_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, conv)?;
    let max = gov.budget.map_or(0, |b| b.max_cost_micros);
    let snap = budget_snapshot(tx, conv, max)?;
    if snap.reached && (gov.status != "budget_reached" || gov.budget_snapshot != Some(snap)) {
        tx.alert(
            Some(conv),
            &json!({
                "kind": "budget_reached",
                "taskId": task,
                "conversationId": conv,
                "title": "Session budget reached",
                "payload": snap,
                "createdAtMs": tx.now_ms,
            }),
        )?;
    }
    gov.status = if snap.reached { "budget_reached".into() } else { "active".into() };
    gov.budget_snapshot = Some(snap);
    write_doc::<GovernanceDoc>(tx, CONVERSATION_SCOPE, conv, &gov)?;
    Ok(snap)
}

#[derive(Clone, Default)]
pub struct BudgetExtension;

impl Extension for BudgetExtension {
    fn name(&self) -> &str {
        "budget"
    }

    fn on_before_turn(&self, ctx: &DurableHookCtx<'_>) -> durable::Result<HookOutcome> {
        let snap = ctx.store.write(|tx| check_budget(tx, ctx.conversation_id, ctx.task_id))?;
        if snap.reached {
            Ok(HookOutcome::Park {
                signal: BUDGET_SIGNAL.into(),
                until_ms: None,
            })
        } else {
            Ok(HookOutcome::Continue)
        }
    }
}
