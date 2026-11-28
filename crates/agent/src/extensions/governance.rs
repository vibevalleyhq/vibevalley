use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::core::doc::{
    CONVERSATION_SCOPE, DocSpec, GovernanceDoc, GovernanceState, OarSessionDoc, PendingApproval, PermissionEvaluation, read_doc, read_doc_opt, update_doc,
};
use crate::core::events::AgentEvent;
use crate::core::extension::{Extension, HookOutcome, ToolCallHookCtx};
use crate::durable::{self, Entry, Error, Read, Result, Scheduler, Store, TaskStatus, Tx};
use vibevalley_oar::BoxFuture;

pub const SCOPE: &str = CONVERSATION_SCOPE;
pub const GOVERNANCE: &str = GovernanceDoc::KIND;
pub const PERMISSION_SIGNAL: &str = "permission.decision";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    AlwaysAllow,
    AlwaysAsk,
    Auto,
}

impl Policy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AlwaysAllow => "always_allow",
            Self::AlwaysAsk => "always_ask",
            Self::Auto => "auto",
        }
    }
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

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
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
        if matches!(
            input.tool_name,
            "read" | "grep" | "find" | "ls" | "load_skill" | "oar_list" | "todo_list" | "read_file" | "list_dir" | "search" | "glob"
        ) {
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

pub fn evaluate(permissions: &Permissions, classifier: &dyn Classifier, entries: &[Entry], name: &str, args: &Value, is_mcp: bool) -> Evaluation {
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

pub async fn record_evaluation(tx: &mut Tx<'_>, conv: &str, task: &str, call_id: &str, args: &Value, eval: &Evaluation) -> Result<()> {
    if eval.client_overridable && eval.verdict != Verdict::Ask {
        return Ok(());
    }
    let eval_doc = PermissionEvaluation {
        tool_name: eval.tool_name.clone(),
        policy: eval.policy.as_str().to_string(),
        verdict: eval.verdict.as_str().to_string(),
        reason: eval.reason.clone(),
        client_overridable: eval.client_overridable,
    };
    let now_ms = tx.now_ms;
    let mut pending_alert = None;
    update_doc::<GovernanceDoc>(tx, SCOPE, conv, |gov| {
        if !eval.client_overridable {
            gov.hard_denied_calls.insert(call_id.to_owned(), true);
        }
        if eval.verdict == Verdict::Ask {
            let pending = PendingApproval {
                task_id: task.to_owned(),
                tool_call_id: call_id.to_owned(),
                tool_name: eval.tool_name.clone(),
                args_json: args.clone(),
                evaluation: eval_doc.clone(),
                requested_at_ms: now_ms,
            };
            gov.pending_permissions.insert(task.to_owned(), pending.clone());
            pending_alert = Some(pending);
        }
        Ok(())
    })
    .await?;

    if let Some(pending) = pending_alert {
        tx.alert_async(
            Some(conv),
            &json!({
                "kind": "permission_park",
                "taskId": task,
                "conversationId": conv,
                "title": format!("Permission required: {}", eval.tool_name),
                "message": eval.reason,
                "payload": pending,
                "createdAtMs": tx.now_ms,
            }),
        )
        .await?;
    }
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

pub async fn resolve(store: &Store, _scheduler: &Scheduler, conv: &str, task: &str, decision: Decision) -> Result<()> {
    let conv = conv.to_owned();
    let task = task.to_owned();
    store
        .write_async(move |tx| {
            Box::pin(async move {
                let mut gov: GovernanceState = read_doc::<GovernanceDoc>(tx, SCOPE, &conv).await?;
                let owner = tx.task_async(&task).await?;
                if owner.conversation_id != conv {
                    return Err(Error::Invalid("task belongs to another conversation".into()));
                }
                let key = &decision.tool_call_id;
                let signal = json!(decision);
                if let Some(prior) = tx
                    .signals_async(&task, true)
                    .await?
                    .into_iter()
                    .find(|s| s.signal_name == PERMISSION_SIGNAL && s.signal_key == *key)
                {
                    return if prior.payload == signal {
                        Ok(())
                    } else {
                        Err(Error::Invalid("a different decision was already recorded".into()))
                    };
                }
                if gov.hard_denied_calls.get(&decision.tool_call_id) == Some(&true) {
                    return Err(Error::Invalid("permission is not overridable".into()));
                }
                if owner.status == TaskStatus::Terminal {
                    return Err(Error::Invalid("task has already ended".into()));
                }
                let expected_call_id = gov.pending_permissions.get(&task).map(|p| p.tool_call_id.as_str());
                if expected_call_id != Some(key.as_str()) {
                    return Err(Error::Invalid("permission decision belongs to another call".into()));
                }
                tx.send_signal_async(&task, PERMISSION_SIGNAL, Some(key), &signal).await?;
                gov.pending_permissions.remove(&task);
                crate::core::doc::write_doc::<GovernanceDoc>(tx, SCOPE, &conv, &gov).await?;
                Ok(())
            })
        })
        .await
}

pub fn permissions_for_mode(mode: &str, base: &Permissions) -> Permissions {
    match mode {
        "bypass" => Permissions {
            builtin_default: Policy::AlwaysAllow,
            mcp_default: Policy::AlwaysAllow,
            overrides: base.overrides.clone(),
        },
        "accept_edits" => {
            let mut overrides = base.overrides.clone();
            for tool in ["read", "write", "edit", "grep", "find", "ls", "load_skill", "todo_list"] {
                overrides.insert(tool.into(), Policy::AlwaysAllow);
            }
            Permissions {
                builtin_default: Policy::Auto,
                mcp_default: base.mcp_default,
                overrides,
            }
        }
        "ask" | "plan" => Permissions {
            builtin_default: Policy::Auto,
            mcp_default: base.mcp_default,
            overrides: base.overrides.clone(),
        },
        _ => base.clone(),
    }
}

async fn session_permission_mode(tx: &Read<'_>, conv: &str) -> Result<Option<String>> {
    let mut cur = conv.to_owned();
    let mut seen = HashSet::new();
    for _ in 0..8 {
        if !seen.insert(cur.clone()) {
            break;
        }
        if let Some(oar) = read_doc_opt::<OarSessionDoc>(tx, SCOPE, &cur).await?
            && !oar.permission_mode.is_empty()
        {
            return Ok(Some(oar.permission_mode));
        }
        let Ok(record) = tx.conversation_async(&cur).await else {
            break;
        };
        if record.owner_task_id.is_empty() {
            break;
        }
        let Ok(owner) = tx.task_async(&record.owner_task_id).await else {
            break;
        };
        cur = owner.conversation_id;
    }
    Ok(None)
}

pub struct GovernanceExtension {
    pub permissions: Permissions,
    pub classifier: Arc<dyn Classifier>,
}

impl Default for GovernanceExtension {
    fn default() -> Self {
        Self::new(Permissions::default())
    }
}

impl GovernanceExtension {
    pub fn new(permissions: Permissions) -> Self {
        Self {
            permissions,
            classifier: Arc::new(DefaultClassifier),
        }
    }

    pub fn with_classifier(mut self, classifier: Arc<dyn Classifier>) -> Self {
        self.classifier = classifier;
        self
    }

    async fn effective_permissions(&self, store: &Store, conv: &str) -> Result<Permissions> {
        let conv = conv.to_owned();
        let mode = store
            .read_async(move |tx| Box::pin(async move { session_permission_mode(tx, &conv).await }))
            .await?;
        Ok(match mode.as_deref() {
            Some(mode) => permissions_for_mode(mode, &self.permissions),
            None => self.permissions.clone(),
        })
    }
}

impl Extension for GovernanceExtension {
    fn name(&self) -> &str {
        "governance"
    }

    fn on_before_tool<'a>(&'a self, ctx: &'a ToolCallHookCtx<'_>) -> BoxFuture<'a, durable::Result<HookOutcome>> {
        Box::pin(async move {
            let perms = self.effective_permissions(ctx.store, ctx.conversation_id).await?;
            let eval = evaluate(&perms, &*self.classifier, ctx.entries, ctx.tool_name, ctx.args, ctx.is_mcp);
            if !eval.client_overridable || eval.verdict == Verdict::Ask {
                let conv = ctx.conversation_id.to_owned();
                let task = ctx.task_id.to_owned();
                let call_id = ctx.tool_call_id.to_owned();
                let args = ctx.args.clone();
                let eval_write = eval.clone();
                ctx.store
                    .write_async(move |tx| Box::pin(async move { record_evaluation(tx, &conv, &task, &call_id, &args, &eval_write).await }))
                    .await?;
            }

            match eval.verdict {
                Verdict::Allow => Ok(HookOutcome::Continue),
                Verdict::Deny => Ok(HookOutcome::Deny {
                    reason: eval.reason,
                    overridable: eval.client_overridable,
                }),
                Verdict::Ask => {
                    ctx.emit(AgentEvent::PermissionRequested {
                        task_id: ctx.task_id.to_owned(),
                        tool_call_id: ctx.tool_call_id.to_owned(),
                        tool_name: ctx.tool_name.to_owned(),
                        arguments: ctx.args.to_string(),
                        reason: eval.reason,
                    });
                    Ok(HookOutcome::Park {
                        signal: PERMISSION_SIGNAL.into(),
                        until_ms: None,
                    })
                }
            }
        })
    }
}
