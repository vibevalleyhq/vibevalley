use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vibevalley_durable::{Entry, Error, Read, Result, Scheduler, Store, TaskStatus, Tx};

pub const SCOPE: &str = "conversation";
pub const GOVERNANCE: &str = "pi.governance";
pub const BUDGET_SIGNAL: &str = "budget.updated";
pub const PERMISSION_SIGNAL: &str = "permission.decision";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    AlwaysAllow,
    AlwaysAsk,
    Auto,
}

#[derive(Clone)]
pub struct Permissions {
    pub builtin_default: Policy,
    pub mcp_default: Policy,
    pub overrides: BTreeMap<String, Policy>,
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            builtin_default: Policy::AlwaysAllow,
            mcp_default: Policy::AlwaysAsk,
            overrides: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    Ask,
    Deny,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub tool_name: String,
    pub policy: Policy,
    pub verdict: Verdict,
    pub reason: String,
    pub client_overridable: bool,
}

pub struct Classification<'a> {
    pub tool_name: &'a str,
    pub args: &'a Value,
    pub intents: Vec<String>,
    pub recent_calls: Vec<String>,
}

pub trait Classifier: Send + Sync {
    fn evaluate(&self, input: &Classification<'_>) -> Result<(Verdict, String)>;
}

pub struct DefaultClassifier;
impl Classifier for DefaultClassifier {
    fn evaluate(&self, input: &Classification<'_>) -> Result<(Verdict, String)> {
        if matches!(input.tool_name, "read_file" | "list_dir" | "grep" | "search" | "glob") {
            return Ok((Verdict::Allow, "readonly_builtin".into()));
        }
        let args = input.args.to_string().to_lowercase();
        let trusted = input.intents.join("\n").to_lowercase();
        for pattern in [
            "delete production db",
            "drop database",
            "drop table",
            "truncate table",
            "rm -rf",
            "mkfs.",
            ":(){",
            "curl ",
            "wget ",
            "printenv",
            "exfiltrate",
            "shutdown",
        ] {
            if args.contains(pattern) && !trusted.contains(pattern) {
                return Ok((
                    Verdict::Deny,
                    format!("high_risk pattern {:?} not present in trusted user intent", pattern.trim()),
                ));
            }
        }
        if input.tool_name == "web_fetch" && !args.contains("metadata") && !args.contains("169.254.169.254") {
            return Ok((Verdict::Allow, "benign_web_fetch".into()));
        }
        Ok((Verdict::Ask, "requires_user_confirmation".into()))
    }
}

fn trusted_text(e: &Entry) -> Option<String> {
    if e.kind != "pi.user" {
        return None;
    }
    let p = &e.payload;
    if let Some(src) = p.get("source").and_then(Value::as_str)
        && !matches!(src.to_ascii_lowercase().as_str(), "user" | "human")
    {
        return None;
    }
    if let Some(intent) = p.get("trustedIntent").and_then(Value::as_str) {
        return Some(intent.to_owned());
    }
    p.as_str()
        .or_else(|| ["text", "prompt", "content", "message"].iter().find_map(|k| p[k].as_str()))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

pub(crate) fn evaluate(permissions: &Permissions, classifier: &dyn Classifier, entries: &[Entry], name: &str, args: &Value, is_mcp: bool) -> Evaluation {
    let policy = permissions
        .overrides
        .get(name)
        .copied()
        .unwrap_or(if is_mcp || name.starts_with("mcp:") || name.starts_with("mcp_") {
            permissions.mcp_default
        } else {
            permissions.builtin_default
        });
    let (verdict, reason) = match policy {
        Policy::AlwaysAllow => (Verdict::Allow, "policy_always_allow".into()),
        Policy::AlwaysAsk => (Verdict::Ask, "policy_always_ask".into()),
        Policy::Auto => {
            let input = Classification {
                tool_name: name,
                args,
                intents: entries.iter().filter_map(trusted_text).collect(),
                recent_calls: entries
                    .iter()
                    .rev()
                    .filter(|e| e.kind == "pi.assistant")
                    .flat_map(|e| e.payload["toolCalls"].as_array().into_iter().flatten())
                    .filter_map(|c| c["toolName"].as_str().map(str::to_owned))
                    .take(8)
                    .collect(),
            };
            classifier.evaluate(&input).unwrap_or((Verdict::Ask, "classifier_error_fallback_ask".into()))
        }
    };
    Evaluation {
        tool_name: name.into(),
        policy,
        verdict,
        reason,
        client_overridable: verdict != Verdict::Deny,
    }
}

pub(crate) fn document(tx: &Read<'_>, conv: &str, kind: &str) -> Result<Value> {
    Ok(tx.document(SCOPE, conv, kind)?.map(|d| d.state).unwrap_or_else(|| json!({})))
}

pub(crate) fn push(doc: &mut Value, key: &str, value: Value) -> Result<()> {
    if doc[key].is_null() {
        doc[key] = json!([]);
    }
    doc[key]
        .as_array_mut()
        .ok_or_else(|| Error::Invalid(format!("invalid governance array {key}")))?
        .push(value);
    Ok(())
}

pub(crate) fn record_evaluation(tx: &mut Tx<'_>, conv: &str, task: &str, call_id: &str, args: &Value, eval: &Evaluation) -> Result<()> {
    let mut gov = document(tx, conv, GOVERNANCE)?;
    push(&mut gov, "evaluatedPermissions", json!(eval))?;
    if !eval.client_overridable {
        gov["hardDeniedCalls"][call_id] = json!(true);
    }
    if eval.verdict == Verdict::Ask {
        let pending = json!({"taskId":task,"toolCallId":call_id,"toolName":eval.tool_name,"argsJson":args,"evaluation":eval});
        gov["pendingPermissions"][task] = pending.clone();
        gov["pendingPermissions"][task]["requestedAtMs"] = json!(tx.now_ms);
        tx.alert(Some(conv),&json!({"kind":"permission_park","taskId":task,"conversationId":conv,"title":format!("Permission required: {}",eval.tool_name),"message":eval.reason,"payload":pending,"createdAtMs":tx.now_ms}))?;
    }
    tx.put_document(SCOPE, conv, GOVERNANCE, &gov)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub tool_call_id: String,
    pub approved: bool,
    #[serde(default)]
    pub reason: String,
}

pub fn resolve(store: &Store, _scheduler: &Scheduler, conv: &str, task: &str, decision: Decision) -> Result<()> {
    store.write(|tx| {
        let mut gov = document(tx, conv, GOVERNANCE)?;
        let owner = tx.task(task)?;
        if owner.conversation_id != conv {
            return Err(Error::Invalid("task belongs to another conversation".into()));
        }
        let key = &decision.tool_call_id;
        let signal = json!(decision);
        if let Some(prior) = tx
            .signals(task, true)?
            .into_iter()
            .find(|s| s.signal_name == PERMISSION_SIGNAL && s.signal_key == *key)
        {
            return if prior.payload == signal {
                Ok(())
            } else {
                Err(Error::Invalid("a different decision was already recorded".into()))
            };
        }
        if gov["hardDeniedCalls"][&decision.tool_call_id] == true {
            return Err(Error::Invalid("permission is not overridable".into()));
        }
        if owner.status == TaskStatus::Terminal {
            return Err(Error::Invalid("task has already ended".into()));
        }
        if gov["pendingPermissions"][task]["toolCallId"].as_str() != Some(key) {
            return Err(Error::Invalid("permission decision belongs to another call".into()));
        }
        tx.send_signal(task, PERMISSION_SIGNAL, Some(key), &signal)?;
        gov["pendingPermissions"].as_object_mut().unwrap().remove(task);
        tx.put_document(SCOPE, conv, GOVERNANCE, &gov)?;
        Ok(())
    })
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Serialize, Deserialize)]
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
    pub(crate) fn record(self, tx: &mut Tx<'_>, conv: &str) -> Result<()> {
        let mut cur: Self = serde_json::from_value(document(tx, conv, "pi.usage")?)?;
        cur.input_tokens = cur.input_tokens.saturating_add(self.input_tokens);
        cur.output_tokens = cur.output_tokens.saturating_add(self.output_tokens);
        cur.cache_read_tokens = cur.cache_read_tokens.saturating_add(self.cache_read_tokens);
        cur.cache_write_tokens = cur.cache_write_tokens.saturating_add(self.cache_write_tokens);
        cur.reasoning_tokens = cur.reasoning_tokens.saturating_add(self.reasoning_tokens);
        if let Some(spend) = self.cost_micros {
            cur.cost_micros = Some(cur.cost_micros.unwrap_or(0).saturating_add(spend));
        }
        tx.put_document(SCOPE, conv, "pi.usage", &json!(cur))?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub spent_micros: i64,
    pub max_cost_micros: i64,
    pub reached: bool,
}

fn tree_spend(tx: &Read<'_>, conv: &str) -> Result<i64> {
    let mut conversations = vec![conv.to_owned()];
    let mut seen_conversations = HashSet::new();
    let mut seen_tasks = HashSet::new();
    let mut total = 0i64;
    while let Some(id) = conversations.pop() {
        if !seen_conversations.insert(id.clone()) {
            continue;
        }
        total = total.saturating_add(document(tx, &id, "pi.usage")?["costMicros"].as_i64().unwrap_or_default());
        let mut tasks = tx.tasks_by_conversation(&id)?;
        while let Some(task) = tasks.pop() {
            if !seen_tasks.insert(task.id.clone()) {
                continue;
            }
            if let Some(d) = tx.document("task", &task.id, "pi.usage")? {
                total = total.saturating_add(d.state["costMicros"].as_i64().unwrap_or_default())
            }
            conversations.extend(tx.conversations_by_owner_task(&task.id)?.into_iter().map(|c| c.id));
            tasks.extend(tx.children(&task.id)?);
        }
    }
    Ok(total)
}

fn budget(tx: &Read<'_>, conv: &str, max: i64) -> Result<Budget> {
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
        let mut gov = document(tx, conv, GOVERNANCE)?;
        let snap = budget(tx, conv, max)?;
        gov["budget"] = json!({"maxCostMicros":max});
        gov["budgetSnapshot"] = json!(snap);
        gov["status"] = json!(if snap.reached { "budget_reached" } else { "active" });
        let prev = document(tx, conv, GOVERNANCE)?;
        let rev = if prev != gov {
            tx.put_document(SCOPE, conv, GOVERNANCE, &gov)?.rev
        } else {
            tx.document(SCOPE, conv, GOVERNANCE)?.map_or(0, |d| d.rev)
        };
        if let Some(id) = task {
            tx.send_signal(id, BUDGET_SIGNAL, Some(&format!("budget:{rev}")), &json!(snap))?;
        }
        Ok(snap)
    })
}

pub(crate) fn check_budget(tx: &mut Tx<'_>, conv: &str, task: &str) -> Result<Budget> {
    let mut gov = document(tx, conv, GOVERNANCE)?;
    let max = gov["budget"]["maxCostMicros"].as_i64().unwrap_or_default();
    let snap = budget(tx, conv, max)?;
    if snap.reached && (gov["status"] != "budget_reached" || gov["budgetSnapshot"] != json!(snap)) {
        tx.alert(
            Some(conv),
            &json!({"kind":"budget_reached","taskId":task,"conversationId":conv,"title":"Session budget reached","payload":snap,"createdAtMs":tx.now_ms}),
        )?;
    }
    gov["status"] = json!(if snap.reached { "budget_reached" } else { "active" });
    gov["budgetSnapshot"] = json!(snap);
    tx.put_document(SCOPE, conv, GOVERNANCE, &gov)?;
    Ok(snap)
}
