use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::oar::{
    Capabilities, ContentBlock, EventKind, Installation, PermissionDecision, PermissionMode, Registry, Session, SessionOptions, StopReason, ToolAction,
    tool_action,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::BoxFuture;
use crate::agent::ai::types::ToolCall;
use crate::agent::core::doc::{OarSessionDoc, OarSessionState, TASK_SCOPE, UsageTotals, read_doc, read_doc_opt, write_doc};
use crate::agent::core::engine::{Engine, git_status_summary};
use crate::agent::core::events::AgentEvent;
use crate::agent::core::extension::Extension;
use crate::agent::core::tool::{ReplayPolicy, Tool, ToolContext, TypedTool, TypedToolAdapter, TypedToolOutput};
use crate::agent::durable::{self, Error, Scheduler, Store, Task, TaskContext, TaskStatus, Transition, WaitMode};

pub const OAR_TASK_KIND: &str = "pi.oar.run";
pub const OAR_PHASE_OPEN: &str = "open";
pub const OAR_PHASE_RUN: &str = "run";
const OAR_DEPTH_ENV: &str = "VIBEVALLEY_OAR_DEPTH";

#[derive(Clone, Debug)]
pub struct OarPolicy {
    pub allowed_runtimes: Option<Vec<String>>,
    pub max_concurrent: usize,
    pub max_depth: u32,
    pub default_permission_mode: PermissionMode,
    pub allowed_workdirs: Vec<PathBuf>,
}

impl Default for OarPolicy {
    fn default() -> Self {
        Self {
            allowed_runtimes: None,
            max_concurrent: 2,
            max_depth: 1,
            default_permission_mode: PermissionMode::Plan,
            allowed_workdirs: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct ActiveOarSession {
    pub task_id: String,
    pub conversation_id: String,
    pub runtime_id: String,
    pub vendor_session_id: String,
    pub cwd: PathBuf,
    pub canonical_cwd: PathBuf,
    pub permission_mode: PermissionMode,
    pub session: Arc<dyn Session>,
}

struct ActiveRecord {
    store: Store,
    entry: ActiveOarSession,
}

#[derive(Clone)]
struct OarInner {
    registry: Arc<Registry>,
    policy: OarPolicy,
    active: Arc<Mutex<HashMap<String, ActiveRecord>>>,
}

impl OarInner {
    async fn prune_terminal_active(&self) {
        let entries: Vec<(String, Store)> = self.active.lock().unwrap().iter().map(|(id, rec)| (id.clone(), rec.store.clone())).collect();
        if entries.is_empty() {
            return;
        }
        let mut stale_ids = Vec::new();
        for (id, store) in entries {
            let id_read = id.clone();
            let is_terminal = match store.read_async(move |tx| Box::pin(async move { tx.task_async(&id_read).await })).await {
                Ok(task) => task.status == TaskStatus::Terminal,
                Err(Error::Closed | Error::Missing(_)) => true,
                Err(_) => false,
            };
            if is_terminal {
                stale_ids.push(id);
            }
        }
        if stale_ids.is_empty() {
            return;
        }
        let mut removed = Vec::with_capacity(stale_ids.len());
        {
            let mut guard = self.active.lock().unwrap();
            for id in stale_ids {
                if let Some(rec) = guard.remove(&id) {
                    removed.push(rec.entry);
                }
            }
        }
        for entry in removed {
            let _ = entry.session.abort().await;
            entry.session.dispose().await;
        }
    }
}

#[derive(Clone)]
pub struct OarExtension {
    inner: Arc<OarInner>,
}

impl OarExtension {
    pub fn new(registry: Arc<Registry>, policy: OarPolicy) -> Self {
        Self {
            inner: Arc::new(OarInner {
                registry,
                policy,
                active: Arc::new(Mutex::new(HashMap::new())),
            }),
        }
    }

    pub fn policy(&self) -> &OarPolicy {
        &self.inner.policy
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.inner.registry
    }

    pub async fn active_sessions(&self) -> Vec<ActiveOarSession> {
        self.inner.prune_terminal_active().await;
        self.inner.active.lock().unwrap().values().map(|r| r.entry.clone()).collect()
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct OarListArgs {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OarRuntimeSummary {
    pub id: String,
    pub display_name: String,
    pub installation: Installation,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OarActiveSummary {
    pub task_id: String,
    pub conversation_id: String,
    pub runtime_id: String,
    pub vendor_session_id: String,
    pub cwd: String,
    pub permission_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OarListDetails {
    pub runtimes: Vec<OarRuntimeSummary>,
    pub active_sessions: Vec<OarActiveSummary>,
}

pub struct OarList {
    inner: Arc<OarInner>,
}

impl TypedTool for OarList {
    type Args = OarListArgs;
    type Details = OarListDetails;

    fn name(&self) -> &'static str {
        "oar_list"
    }

    fn description(&self) -> &'static str {
        "List registered OAR runtimes, their installation status, capabilities, and active child OAR sessions."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute<'a>(&'a self, _args: Self::Args, _ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            let mut runtimes = Vec::new();
            for rt in self.inner.registry.list() {
                if !runtime_allowed(&self.inner.policy, rt.id()) {
                    continue;
                }
                let installation = rt.installation().await;
                runtimes.push(OarRuntimeSummary {
                    id: rt.id().to_owned(),
                    display_name: rt.display_name().to_owned(),
                    installation,
                    capabilities: rt.capabilities(),
                });
            }
            self.inner.prune_terminal_active().await;
            let active_sessions: Vec<OarActiveSummary> = self
                .inner
                .active
                .lock()
                .unwrap()
                .values()
                .map(|r| &r.entry)
                .map(|s| OarActiveSummary {
                    task_id: s.task_id.clone(),
                    conversation_id: s.conversation_id.clone(),
                    runtime_id: s.runtime_id.clone(),
                    vendor_session_id: s.vendor_session_id.clone(),
                    cwd: s.cwd.to_string_lossy().into_owned(),
                    permission_mode: permission_mode_str(s.permission_mode).into(),
                })
                .collect();
            let details = OarListDetails { runtimes, active_sessions };
            let text = serde_json::to_string(&details).map_err(|e| e.to_string())?;
            Ok(TypedToolOutput::ok_with(text, details))
        })
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct OarRunArgs {
    pub runtime: String,
    pub cwd: String,
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default, alias = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub resume: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OarRunDetails {
    pub task_id: String,
    pub vendor_session_id: String,
}

pub struct OarRun;

impl TypedTool for OarRun {
    type Args = OarRunArgs;
    type Details = OarRunDetails;

    fn name(&self) -> &'static str {
        "oar_run"
    }

    fn description(&self) -> &'static str {
        "Delegate a coding task to an external OAR runtime (such as claude, codex, acp, or scripted) with durable session tracking and cascade cancellation."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, _args: Self::Args, _ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(std::future::ready(Err("oar_run requires the durable engine dispatcher".into())))
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct OarSteerArgs {
    pub target: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OarSteerDetails {
    pub task_id: String,
    pub vendor_session_id: String,
}

pub struct OarSteer {
    inner: Arc<OarInner>,
}

impl TypedTool for OarSteer {
    type Args = OarSteerArgs;
    type Details = OarSteerDetails;

    fn name(&self) -> &'static str {
        "oar_steer"
    }

    fn description(&self) -> &'static str {
        "Send a steering message to a running child OAR session by task id or vendor session id."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, args: Self::Args, _ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            let active = find_active_session(&self.inner.active, &args.target).ok_or_else(|| format!("no active OAR session matching `{}`", args.target))?;
            active
                .session
                .steer(vec![ContentBlock::Text(args.message)])
                .await
                .map_err(|e| format!("failed to steer OAR session: {e}"))?;
            let details = OarSteerDetails {
                task_id: active.task_id,
                vendor_session_id: active.vendor_session_id,
            };
            let text = serde_json::to_string(&details).map_err(|e| e.to_string())?;
            Ok(TypedToolOutput::ok_with(text, details))
        })
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct OarStopArgs {
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OarStopDetails {
    pub task_id: String,
    pub vendor_session_id: String,
    pub stopped: bool,
}

pub struct OarStop {
    inner: Arc<OarInner>,
}

impl TypedTool for OarStop {
    type Args = OarStopArgs;
    type Details = OarStopDetails;

    fn name(&self) -> &'static str {
        "oar_stop"
    }

    fn description(&self) -> &'static str {
        "Abort and dispose a running child OAR session and cancel its durable task."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            let removed = remove_active_session(&self.inner.active, &args.target).ok_or_else(|| format!("no active OAR session matching `{}`", args.target))?;
            let _ = removed.session.abort().await;
            removed.session.dispose().await;
            if let Some(scheduler) = &ctx.scheduler {
                let _ = scheduler.abort(&removed.task_id).await;
            }
            let details = OarStopDetails {
                task_id: removed.task_id,
                vendor_session_id: removed.vendor_session_id,
                stopped: true,
            };
            let text = serde_json::to_string(&details).map_err(|e| e.to_string())?;
            Ok(TypedToolOutput::ok_with(text, details))
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OarRunCheckpoint {
    parent_tool_task_id: String,
    parent_conv_id: String,
    call_id: String,
    runtime: String,
    cwd: String,
    canonical_cwd: String,
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    permission_mode: PermissionMode,
    #[serde(default)]
    resume: Option<String>,
    #[serde(default)]
    label: Option<String>,
    depth: u32,
}

impl Extension for OarExtension {
    fn name(&self) -> &str {
        "oar"
    }

    fn tools(&self) -> Vec<Box<dyn Tool>> {
        vec![
            Box::new(TypedToolAdapter(OarList { inner: self.inner.clone() })),
            Box::new(TypedToolAdapter(OarRun)),
            Box::new(TypedToolAdapter(OarSteer { inner: self.inner.clone() })),
            Box::new(TypedToolAdapter(OarStop { inner: self.inner.clone() })),
        ]
    }

    fn register_phases(&self, scheduler: &Scheduler, engine: &Engine) {
        let open_ext = self.clone();
        let open_engine = engine.clone();
        scheduler.register(OAR_TASK_KIND, OAR_PHASE_OPEN, move |tc| {
            let open_ext = open_ext.clone();
            let open_engine = open_engine.clone();
            async move { open_ext.phase_open(&tc, &open_engine).await }
        });

        let run_ext = self.clone();
        let run_engine = engine.clone();
        scheduler.register(OAR_TASK_KIND, OAR_PHASE_RUN, move |tc| {
            let run_ext = run_ext.clone();
            let run_engine = run_engine.clone();
            async move { run_ext.phase_run(&tc, &run_engine).await }
        });
    }

    fn on_task_aborted(&self, task_ids: &[String]) {
        let mut removed = Vec::new();
        {
            let mut guard = self.inner.active.lock().unwrap();
            for id in task_ids {
                if let Some(rec) = guard.remove(id) {
                    removed.push(rec.entry);
                }
            }
        }
        if removed.is_empty() {
            return;
        }
        for entry in &removed {
            entry.session.signal_dispose();
        }
        crate::rt::current_or_global_handle().spawn(async move {
            for entry in removed {
                let _ = entry.session.abort().await;
                entry.session.dispose().await;
            }
        });
    }

    fn dispatch_tool<'a>(&'a self, call: &'a ToolCall, tc: &'a TaskContext, engine: &'a Engine) -> BoxFuture<'a, Option<durable::Result<Transition>>> {
        Box::pin(async move {
            if call.name != "oar_run" {
                return None;
            }
            Some(self.dispatch_oar_run(call, tc, engine).await)
        })
    }
}

impl OarExtension {
    async fn dispatch_oar_run(&self, call: &ToolCall, tc: &TaskContext, engine: &Engine) -> durable::Result<Transition> {
        if let Some(res) = engine.check_dispatched_memo(tc) {
            return res;
        }

        let dedup = format!("oar:{}", tc.task.id);
        let tid = tc.task.id.clone();
        let dedup_read = dedup.clone();
        let existing_child = engine
            .store()
            .read_async(move |r| {
                Box::pin(async move {
                    Ok(r.children_async(&tid)
                        .await?
                        .into_iter()
                        .find(|c| c.dedup_key == dedup_read && c.kind == OAR_TASK_KIND))
                })
            })
            .await?;

        if let Some(child) = existing_child {
            if child.status != TaskStatus::Terminal {
                return Ok(Transition::Wait {
                    phase: tc.task.phase_name.clone(),
                    checkpoint: None,
                    mode: WaitMode::AllSettled,
                    children: vec![child.id],
                });
            }
            if child.terminal_reason == "completed" {
                let text = serde_json::to_string(&child.result)?;
                return engine.complete_dispatched_tool(tc, call, text, false).await;
            }
            let err = if child.error_text.is_empty() {
                format!("oar_run failed ({})", child.terminal_reason)
            } else {
                child.error_text
            };
            return engine.complete_dispatched_tool(tc, call, err, true).await;
        }

        let args: OarRunArgs = match serde_json::from_str(&call.arguments) {
            Ok(args) => args,
            Err(err) => {
                return engine
                    .complete_dispatched_tool(tc, call, format!("invalid arguments for `oar_run`: {err}"), true)
                    .await;
            }
        };

        let cp = match self.validate_and_build_checkpoint(&args, call, tc, engine).await {
            Ok(cp) => cp,
            Err(err) => return engine.complete_dispatched_tool(tc, call, err, true).await,
        };

        let mut child = Task::new(OAR_TASK_KIND, OAR_PHASE_OPEN);
        child.dedup_key = dedup;
        child.checkpoint = json!(cp);
        let (spawned, _) = tc.spawn_child(child).await?;

        Ok(Transition::Wait {
            phase: tc.task.phase_name.clone(),
            checkpoint: None,
            mode: WaitMode::AllSettled,
            children: vec![spawned.id],
        })
    }

    async fn validate_and_build_checkpoint(
        &self,
        args: &OarRunArgs,
        call: &ToolCall,
        tc: &TaskContext,
        engine: &Engine,
    ) -> std::result::Result<OarRunCheckpoint, String> {
        if !runtime_allowed(&self.inner.policy, &args.runtime) {
            return Err(format!("runtime `{}` is not allowed by OAR policy", args.runtime));
        }
        self.inner.registry.require(&args.runtime).map_err(|e| e.to_string())?;

        let permission_mode = match args.permission_mode.as_deref() {
            Some(raw) => parse_permission_mode(raw)?,
            None => self.inner.policy.default_permission_mode,
        };

        let raw_cwd = PathBuf::from(args.cwd.trim());
        if raw_cwd.as_os_str().is_empty() {
            return Err("cwd must not be empty".into());
        }
        let canonical_cwd = std::fs::canonicalize(&raw_cwd).map_err(|e| format!("invalid cwd `{}`: {e}", args.cwd))?;
        if !canonical_cwd.is_dir() {
            return Err(format!("cwd `{}` is not a directory", canonical_cwd.display()));
        }
        if !self.inner.policy.allowed_workdirs.is_empty() {
            let mut matched = false;
            for allowed in &self.inner.policy.allowed_workdirs {
                let canon_allowed = std::fs::canonicalize(allowed).unwrap_or_else(|_| allowed.clone());
                if canonical_cwd.starts_with(&canon_allowed) {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return Err(format!("cwd `{}` is outside allowed_workdirs", canonical_cwd.display()));
            }
        }

        let depth = compute_oar_depth(engine.store(), &tc.task.id).await.map_err(|e| e.to_string())?;
        if depth >= self.inner.policy.max_depth {
            return Err(format!("OAR recursion depth {depth} reached max_depth {}", self.inner.policy.max_depth));
        }

        self.inner.prune_terminal_active().await;
        {
            let active = self.inner.active.lock().unwrap();
            if active.len() >= self.inner.policy.max_concurrent {
                return Err(format!("max concurrent OAR sessions ({}) reached", self.inner.policy.max_concurrent));
            }
            if permission_mode != PermissionMode::Plan
                && active
                    .values()
                    .any(|r| r.entry.canonical_cwd == canonical_cwd && r.entry.permission_mode != PermissionMode::Plan)
            {
                return Err(format!("concurrent mutating OAR session already active on `{}`", canonical_cwd.display()));
            }
        }

        Ok(OarRunCheckpoint {
            parent_tool_task_id: tc.task.id.clone(),
            parent_conv_id: tc.task.conversation_id.clone(),
            call_id: call.id.clone(),
            runtime: args.runtime.clone(),
            cwd: raw_cwd.to_string_lossy().into_owned(),
            canonical_cwd: canonical_cwd.to_string_lossy().into_owned(),
            prompt: args.prompt.clone(),
            model: args.model.clone(),
            effort: args.effort.clone(),
            permission_mode,
            resume: args.resume.clone(),
            label: args.label.clone(),
            depth,
        })
    }

    async fn phase_open(&self, tc: &TaskContext, engine: &Engine) -> durable::Result<Transition> {
        let cp: OarRunCheckpoint = serde_json::from_value(tc.task.checkpoint.clone())?;
        let tid = tc.task.id.clone();
        if let Some(existing) = engine
            .store()
            .read_async(move |tx| Box::pin(async move { read_doc_opt::<OarSessionDoc>(tx, TASK_SCOPE, &tid).await }))
            .await?
            && !existing.vendor_session_id.is_empty()
        {
            return Ok(Transition::Next {
                phase: OAR_PHASE_RUN.into(),
                checkpoint: None,
            });
        }

        self.inner.prune_terminal_active().await;
        {
            let active = self.inner.active.lock().unwrap();
            if active.len() >= self.inner.policy.max_concurrent {
                return Err(Error::Invalid(format!(
                    "max concurrent OAR sessions ({}) reached",
                    self.inner.policy.max_concurrent
                )));
            }
            let canon = PathBuf::from(&cp.canonical_cwd);
            if cp.permission_mode != PermissionMode::Plan
                && active
                    .values()
                    .any(|r| r.entry.canonical_cwd == canon && r.entry.permission_mode != PermissionMode::Plan)
            {
                return Err(Error::Invalid(format!(
                    "concurrent mutating OAR session already active on `{}`",
                    cp.canonical_cwd
                )));
            }
        }

        let runtime = self.inner.registry.require(&cp.runtime).map_err(|e| Error::Invalid(e.to_string()))?;
        let opts = session_options(&cp, cp.resume.clone());
        let session = runtime.open(opts).await.map_err(|e| Error::Invalid(e.to_string()))?;

        if tc.is_cancelled() {
            let _ = session.abort().await;
            session.dispose().await;
            return Ok(Transition::Fail("aborted".into()));
        }

        let vendor_session_id = resolve_session_id(&session);
        let state = OarSessionState {
            runtime_id: cp.runtime.clone(),
            vendor_session_id: vendor_session_id.clone(),
            cwd: cp.cwd.clone(),
            permission_mode: permission_mode_str(cp.permission_mode).into(),
            status: "opened".into(),
        };
        let tid = tc.task.id.clone();
        engine
            .store()
            .write_async(move |tx| {
                Box::pin(async move {
                    write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &state).await?;
                    Ok(())
                })
            })
            .await?;

        if tc.is_cancelled() {
            let _ = session.abort().await;
            session.dispose().await;
            return Ok(Transition::Fail("aborted".into()));
        }

        self.inner.active.lock().unwrap().insert(
            tc.task.id.clone(),
            ActiveRecord {
                store: engine.store().clone(),
                entry: ActiveOarSession {
                    task_id: tc.task.id.clone(),
                    conversation_id: cp.parent_conv_id.clone(),
                    runtime_id: cp.runtime.clone(),
                    vendor_session_id: vendor_session_id.clone(),
                    cwd: PathBuf::from(&cp.cwd),
                    canonical_cwd: PathBuf::from(&cp.canonical_cwd),
                    permission_mode: cp.permission_mode,
                    session,
                },
            },
        );

        let child_conv_label = format!("oar:{vendor_session_id}");
        engine.emit(
            &cp.parent_conv_id,
            &cp.parent_tool_task_id,
            AgentEvent::SubagentSpawned {
                parent_conversation_id: cp.parent_conv_id.clone(),
                child_conversation_id: child_conv_label.clone(),
                task_id: tc.task.id.clone(),
                label: cp.label.clone().unwrap_or_else(|| cp.runtime.clone()),
                brief: cp.prompt.clone(),
            },
        );
        engine.emit(
            &cp.parent_conv_id,
            &cp.parent_tool_task_id,
            AgentEvent::SubagentStatusChanged {
                child_conversation_id: child_conv_label,
                task_id: tc.task.id.clone(),
                status: "running".into(),
                message: String::new(),
            },
        );

        Ok(Transition::Next {
            phase: OAR_PHASE_RUN.into(),
            checkpoint: None,
        })
    }

    async fn phase_run(&self, tc: &TaskContext, engine: &Engine) -> durable::Result<Transition> {
        if let Some(saved) = tc.task.memo.get("turnResult") {
            self.inner.active.lock().unwrap().remove(&tc.task.id);
            return Ok(Transition::Complete(saved.clone()));
        }

        let cp: OarRunCheckpoint = serde_json::from_value(tc.task.checkpoint.clone())?;
        let tid = tc.task.id.clone();
        let mut doc = engine
            .store()
            .read_async(move |tx| Box::pin(async move { read_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid).await }))
            .await?;
        if doc.runtime_id.is_empty() {
            doc.runtime_id = cp.runtime.clone();
            doc.cwd = cp.cwd.clone();
            doc.permission_mode = permission_mode_str(cp.permission_mode).into();
        }
        let child_conv_label = format!("oar:{}", doc.vendor_session_id);

        if tc.task.memo.get("turnStarted").and_then(Value::as_bool) == Some(true) {
            let removed = self.inner.active.lock().unwrap().remove(&tc.task.id);
            if let Some(removed) = removed {
                removed.entry.session.dispose().await;
            }
            let git_status = git_status_summary(Some(Path::new(&doc.cwd))).await;
            doc.status = "interrupted".into();
            let tid = tc.task.id.clone();
            let doc_write = doc.clone();
            engine
                .store()
                .write_async(move |tx| {
                    Box::pin(async move {
                        write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &doc_write).await?;
                        Ok(())
                    })
                })
                .await?;
            engine.emit(
                &cp.parent_conv_id,
                &cp.parent_tool_task_id,
                AgentEvent::SubagentStatusChanged {
                    child_conversation_id: child_conv_label,
                    task_id: tc.task.id.clone(),
                    status: "interrupted".into(),
                    message: git_status.clone().unwrap_or_default(),
                },
            );
            let result = json!({
                "interrupted": true,
                "runtimeId": doc.runtime_id,
                "vendorSessionId": doc.vendor_session_id,
                "cwd": doc.cwd,
                "gitStatus": git_status,
            });
            let result_memo = result.clone();
            tc.memo("turnResult", || async move { Ok(result_memo) }).await?;
            return Ok(Transition::Complete(result));
        }

        if tc.is_cancelled() {
            self.inner.active.lock().unwrap().remove(&tc.task.id);
            return Ok(Transition::Fail("aborted".into()));
        }

        let active_session = self.inner.active.lock().unwrap().get(&tc.task.id).map(|r| r.entry.clone());
        let session = match active_session {
            Some(entry) => entry.session,
            None => {
                let runtime = self.inner.registry.require(&cp.runtime).map_err(|e| Error::Invalid(e.to_string()))?;
                let resume = if runtime.capabilities().resume && !doc.vendor_session_id.is_empty() {
                    Some(doc.vendor_session_id.clone())
                } else {
                    cp.resume.clone()
                };
                let reopened = runtime.open(session_options(&cp, resume)).await.map_err(|e| Error::Invalid(e.to_string()))?;
                let new_vid = resolve_session_id(&reopened);
                if !new_vid.is_empty() && doc.vendor_session_id != new_vid {
                    doc.vendor_session_id = new_vid.clone();
                    let tid = tc.task.id.clone();
                    let doc_write = doc.clone();
                    engine
                        .store()
                        .write_async(move |tx| {
                            Box::pin(async move {
                                write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &doc_write).await?;
                                Ok(())
                            })
                        })
                        .await?;
                }
                self.inner.active.lock().unwrap().insert(
                    tc.task.id.clone(),
                    ActiveRecord {
                        store: engine.store().clone(),
                        entry: ActiveOarSession {
                            task_id: tc.task.id.clone(),
                            conversation_id: cp.parent_conv_id.clone(),
                            runtime_id: cp.runtime.clone(),
                            vendor_session_id: doc.vendor_session_id.clone(),
                            cwd: PathBuf::from(&cp.cwd),
                            canonical_cwd: PathBuf::from(&cp.canonical_cwd),
                            permission_mode: cp.permission_mode,
                            session: reopened.clone(),
                        },
                    },
                );
                reopened
            }
        };

        let _guard = ActiveSessionGuard {
            active: self.inner.active.clone(),
            task_id: tc.task.id.clone(),
        };

        let mut events = session.events();
        tc.memo("turnStarted", || async { Ok(json!(true)) }).await?;
        if let Err(err) = session.prompt(vec![ContentBlock::Text(cp.prompt.clone())]).await {
            session.dispose().await;
            doc.status = "errored".into();
            let tid = tc.task.id.clone();
            let doc_write = doc.clone();
            let _ = engine
                .store()
                .write_async(move |tx| {
                    Box::pin(async move {
                        write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &doc_write).await?;
                        Ok(())
                    })
                })
                .await;
            return Err(Error::Invalid(format!("OAR prompt failed: {err}")));
        }

        let cancel_token = tc.cancel_token();
        let mut output = String::new();
        let mut last_error: Option<String> = None;

        enum LoopItem {
            Event(Option<crate::oar::Event>),
            Cancelled,
        }

        loop {
            if tc.is_cancelled() {
                let _ = session.abort().await;
                session.dispose().await;
                doc.status = "aborted".into();
                let tid = tc.task.id.clone();
                let doc_write = doc.clone();
                let _ = engine
                    .store()
                    .write_async(move |tx| {
                        Box::pin(async move {
                            write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &doc_write).await?;
                            Ok(())
                        })
                    })
                    .await;
                engine.emit(
                    &cp.parent_conv_id,
                    &cp.parent_tool_task_id,
                    AgentEvent::SubagentStatusChanged {
                        child_conversation_id: child_conv_label,
                        task_id: tc.task.id.clone(),
                        status: "aborted".into(),
                        message: String::new(),
                    },
                );
                return Ok(Transition::Fail("aborted".into()));
            }

            let next = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => LoopItem::Cancelled,
                ev = events.recv() => LoopItem::Event(ev),
            };

            match next {
                LoopItem::Cancelled => continue,
                LoopItem::Event(None) => {
                    session.dispose().await;
                    let err_msg = last_error.unwrap_or_else(|| "OAR event stream closed unexpectedly".into());
                    doc.status = "errored".into();
                    let tid = tc.task.id.clone();
                    let doc_write = doc.clone();
                    let _ = engine
                        .store()
                        .write_async(move |tx| {
                            Box::pin(async move {
                                write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &doc_write).await?;
                                Ok(())
                            })
                        })
                        .await;
                    return Err(Error::Invalid(err_msg));
                }
                LoopItem::Event(Some(ev)) => match ev.kind {
                    EventKind::TextDelta { text } => {
                        output.push_str(&text);
                        engine.emit(
                            &cp.parent_conv_id,
                            &cp.parent_tool_task_id,
                            AgentEvent::ToolUpdate {
                                id: cp.call_id.clone(),
                                name: "oar_run".into(),
                                text,
                            },
                        );
                    }
                    EventKind::ToolCallStarted { name, .. } => {
                        engine.emit(
                            &cp.parent_conv_id,
                            &cp.parent_tool_task_id,
                            AgentEvent::SubagentStatusChanged {
                                child_conversation_id: child_conv_label.clone(),
                                task_id: tc.task.id.clone(),
                                status: "running".into(),
                                message: format!("calling {name}"),
                            },
                        );
                    }
                    EventKind::PermissionRequested { request_id, tool, input, .. } => {
                        let decision = decide_headless_permission(cp.permission_mode, &tool, &input);
                        let _ = session.respond_permission(&request_id, decision).await;
                    }
                    EventKind::Error { message } => {
                        last_error = Some(message);
                    }
                    EventKind::TurnFinished { reason, usage } => {
                        session.dispose().await;
                        let status = match reason {
                            StopReason::Completed => "completed",
                            StopReason::Aborted => "aborted",
                            StopReason::MaxTurns | StopReason::Error => "errored",
                        };
                        doc.status = status.into();
                        let totals = UsageTotals {
                            input_tokens: usage.input_tokens.unwrap_or_default() as i64,
                            output_tokens: usage.output_tokens.unwrap_or_default() as i64,
                            cost_micros: usage.cost_usd.map(|c| (c * 1_000_000.0).round() as i64),
                            ..Default::default()
                        };
                        let tid = tc.task.id.clone();
                        let doc_write = doc.clone();
                        engine
                            .store()
                            .write_async(move |tx| {
                                Box::pin(async move {
                                    totals.record_task(tx, &tid).await?;
                                    write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &doc_write).await?;
                                    Ok(())
                                })
                            })
                            .await?;

                        let result = json!({
                            "interrupted": false,
                            "runtimeId": doc.runtime_id,
                            "vendorSessionId": doc.vendor_session_id,
                            "stopReason": reason,
                            "output": output,
                            "usage": usage,
                            "error": last_error,
                        });
                        let result_memo = result.clone();
                        tc.memo("turnResult", || async move { Ok(result_memo) }).await?;
                        engine.emit(
                            &cp.parent_conv_id,
                            &cp.parent_tool_task_id,
                            AgentEvent::SubagentStatusChanged {
                                child_conversation_id: child_conv_label,
                                task_id: tc.task.id.clone(),
                                status: status.into(),
                                message: output,
                            },
                        );
                        return Ok(Transition::Complete(result));
                    }
                    EventKind::SessionEnded => {
                        session.dispose().await;
                        doc.status = "errored".into();
                        let tid = tc.task.id.clone();
                        let doc_write = doc.clone();
                        let _ = engine
                            .store()
                            .write_async(move |tx| {
                                Box::pin(async move {
                                    write_doc::<OarSessionDoc>(tx, TASK_SCOPE, &tid, &doc_write).await?;
                                    Ok(())
                                })
                            })
                            .await;
                        let err_msg = last_error.unwrap_or_else(|| "OAR session ended before TurnFinished".into());
                        return Err(Error::Invalid(err_msg));
                    }
                    EventKind::SessionStarted { .. }
                    | EventKind::TurnStarted { .. }
                    | EventKind::ThinkingDelta { .. }
                    | EventKind::ToolCallFinished { .. }
                    | EventKind::SubagentSpawned { .. }
                    | EventKind::SubagentWait { .. }
                    | EventKind::SubagentMessage { .. }
                    | EventKind::SubagentPlanUpdated { .. }
                    | EventKind::SubagentStatusChanged { .. }
                    | EventKind::FileChanged { .. }
                    | EventKind::PermissionResolved { .. }
                    | EventKind::InteractionRequested { .. }
                    | EventKind::InteractionResolved { .. }
                    | EventKind::Question { .. } => {}
                },
            }
        }
    }
}

struct ActiveSessionGuard {
    active: Arc<Mutex<HashMap<String, ActiveRecord>>>,
    task_id: String,
}

impl Drop for ActiveSessionGuard {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.task_id);
    }
}

fn find_active_session(active: &Arc<Mutex<HashMap<String, ActiveRecord>>>, target: &str) -> Option<ActiveOarSession> {
    let guard = active.lock().unwrap();
    guard
        .get(target)
        .or_else(|| guard.values().find(|r| r.entry.vendor_session_id == target))
        .map(|r| r.entry.clone())
}

fn remove_active_session(active: &Arc<Mutex<HashMap<String, ActiveRecord>>>, target: &str) -> Option<ActiveOarSession> {
    let mut guard = active.lock().unwrap();
    if let Some(found) = guard.remove(target) {
        return Some(found.entry);
    }
    let key = guard.values().find(|r| r.entry.vendor_session_id == target).map(|r| r.entry.task_id.clone())?;
    guard.remove(&key).map(|r| r.entry)
}

fn resolve_session_id(session: &Arc<dyn Session>) -> String {
    let direct = session.id();
    if !direct.is_empty() {
        return direct;
    }
    let mut history = session.events_with_history();
    while let Ok(ev) = history.try_recv() {
        if let EventKind::SessionStarted { session_id, .. } = ev.kind {
            return session_id;
        }
    }
    String::new()
}

fn session_options(cp: &OarRunCheckpoint, resume: Option<String>) -> SessionOptions {
    SessionOptions {
        cwd: PathBuf::from(&cp.cwd),
        model: cp.model.clone(),
        effort: cp.effort.clone(),
        permission_mode: cp.permission_mode,
        resume,
        env: vec![(OAR_DEPTH_ENV.into(), (cp.depth + 1).to_string())],
        ..Default::default()
    }
}

fn runtime_allowed(policy: &OarPolicy, runtime_id: &str) -> bool {
    match &policy.allowed_runtimes {
        Some(allowed) => allowed.iter().any(|r| r == runtime_id),
        None => true,
    }
}

fn parse_permission_mode(raw: &str) -> std::result::Result<PermissionMode, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "plan" => Ok(PermissionMode::Plan),
        "ask" => Ok(PermissionMode::Ask),
        "accept_edits" | "acceptedits" => Ok(PermissionMode::AcceptEdits),
        "bypass" => Ok(PermissionMode::Bypass),
        other => Err(format!("invalid permission_mode `{other}`: expected plan, ask, accept_edits, or bypass")),
    }
}

fn permission_mode_str(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Plan => "plan",
        PermissionMode::Ask => "ask",
        PermissionMode::AcceptEdits => "accept_edits",
        PermissionMode::Bypass => "bypass",
    }
}

fn decide_headless_permission(mode: PermissionMode, tool: &str, input: &Value) -> PermissionDecision {
    let action = tool_action(tool, input);
    match mode {
        PermissionMode::Bypass => PermissionDecision::AllowAlways,
        PermissionMode::Plan => match action {
            ToolAction::ReadFile | ToolAction::Search | ToolAction::Wait => PermissionDecision::AllowOnce,
            ToolAction::RunCommand | ToolAction::EditFile | ToolAction::Web | ToolAction::Mcp | ToolAction::Other => PermissionDecision::Deny {
                message: Some("denied non-readonly tool in Plan mode".into()),
            },
        },
        PermissionMode::AcceptEdits => match action {
            ToolAction::ReadFile | ToolAction::Search | ToolAction::EditFile | ToolAction::Wait => PermissionDecision::AllowOnce,
            ToolAction::RunCommand | ToolAction::Web | ToolAction::Mcp | ToolAction::Other => PermissionDecision::Deny {
                message: Some("denied non-edit command in AcceptEdits mode".into()),
            },
        },
        PermissionMode::Ask => match action {
            ToolAction::ReadFile | ToolAction::Search | ToolAction::Wait => PermissionDecision::AllowOnce,
            ToolAction::RunCommand | ToolAction::EditFile | ToolAction::Web | ToolAction::Mcp | ToolAction::Other => PermissionDecision::Deny {
                message: Some("permission confirmation unavailable in headless oar_run".into()),
            },
        },
    }
}

async fn compute_oar_depth(store: &crate::agent::durable::Store, start_task_id: &str) -> durable::Result<u32> {
    let env_depth = std::env::var(OAR_DEPTH_ENV).ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    let start = start_task_id.to_owned();
    let sql_depth = store
        .read_async(move |tx| {
            Box::pin(async move {
                let mut depth = 0_u32;
                let mut seen = HashSet::new();
                let mut cur = start;
                for _ in 0..32 {
                    if cur.is_empty() || !seen.insert(cur.clone()) {
                        break;
                    }
                    let Ok(task) = tx.task_async(&cur).await else {
                        break;
                    };
                    if task.kind == OAR_TASK_KIND {
                        depth = depth.saturating_add(1);
                    }
                    if !task.owner_task_id.is_empty() {
                        cur = task.owner_task_id;
                        continue;
                    }
                    if let Ok(conv) = tx.conversation_async(&task.conversation_id).await
                        && !conv.owner_task_id.is_empty()
                    {
                        cur = conv.owner_task_id;
                        continue;
                    }
                    break;
                }
                Ok(depth)
            })
        })
        .await?;
    Ok(env_depth.max(sql_depth))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use crate::oar::scripted::{Script, ScriptedRuntime, Step, TurnAsk};
    use tempfile::TempDir;
    use tokio::process::Command;

    use super::*;
    use crate::agent::Result as AiResult;
    use crate::agent::ai::ModelClient;
    use crate::agent::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, Role, ToolCall, Usage as AiUsage};
    use crate::agent::core::engine::Request;
    use crate::agent::core::events::Brain;
    use crate::agent::durable::Store;
    use crate::agent::extensions::tree_spend;
    use crate::agent::harness::{Harness, WorkersOnly, worker_conversation};

    struct QueueClient {
        replies: Mutex<VecDeque<Completion>>,
    }

    impl QueueClient {
        fn new(replies: Vec<Completion>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
            }
        }
    }

    impl ModelClient for QueueClient {
        fn complete<'a>(&'a self, _req: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> BoxFuture<'a, AiResult<Completion>> {
            let reply = self.replies.lock().unwrap().pop_front().expect("unexpected model call");
            if let Some(t) = &reply.message.content {
                on(Delta::Text(t.clone()));
            }
            Box::pin(std::future::ready(Ok(reply)))
        }
    }

    #[tokio::test]
    async fn oar_list_filters_allowed_runtimes() {
        let mut reg = Registry::new();
        reg.register(Arc::new(ScriptedRuntime::new("alpha", Script::echo())));
        reg.register(Arc::new(ScriptedRuntime::new("beta", Script::echo())));
        let ext = OarExtension::new(
            Arc::new(reg),
            OarPolicy {
                allowed_runtimes: Some(vec!["beta".into()]),
                ..Default::default()
            },
        );
        let tools = ext.tools();
        let list_tool = tools.iter().find(|t| t.spec().name == "oar_list").unwrap();
        let out = list_tool.execute(&json!({})).await;
        assert!(!out.is_error);
        let parsed: Value = serde_json::from_str(&out.text).unwrap();
        let ids: Vec<_> = parsed["runtimes"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["beta"]);
    }

    #[tokio::test]
    async fn oar_run_handles_plan_vs_bypass_and_records_tree_spend() -> durable::Result<()> {
        let dir = TempDir::new().unwrap();
        let mut reg = Registry::new();
        reg.register(Arc::new(ScriptedRuntime::demo()));

        let store = Store::memory()?;
        let harness = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
        harness.register_extension(Arc::new(OarExtension::new(
            Arc::new(reg),
            OarPolicy {
                allowed_workdirs: vec![dir.path().to_path_buf()],
                ..Default::default()
            },
        )));
        harness.recover().await?;

        let client = Arc::new(QueueClient::new(vec![
            Completion {
                message: Message {
                    role: Role::Assistant,
                    content: None,
                    reasoning: None,
                    tool_calls: vec![ToolCall {
                        id: "c1".into(),
                        name: "oar_run".into(),
                        arguments: json!({
                            "runtime": "scripted",
                            "cwd": dir.path(),
                            "prompt": "inspect",
                            "permissionMode": "plan"
                        })
                        .to_string(),
                    }],
                    tool_call_id: None,
                },
                finish: FinishReason::ToolCalls,
                usage: AiUsage::default(),
            },
            Completion {
                message: Message {
                    role: Role::Assistant,
                    content: None,
                    reasoning: None,
                    tool_calls: vec![ToolCall {
                        id: "c2".into(),
                        name: "oar_run".into(),
                        arguments: json!({
                            "runtime": "scripted",
                            "cwd": dir.path(),
                            "prompt": "write now",
                            "permissionMode": "bypass"
                        })
                        .to_string(),
                    }],
                    tool_call_id: None,
                },
                finish: FinishReason::ToolCalls,
                usage: AiUsage::default(),
            },
            Completion {
                message: Message::assistant("reviewed"),
                finish: FinishReason::Stop,
                usage: AiUsage::default(),
            },
        ]));
        let conv = worker_conversation("oar-1");
        harness
            .attach_worker(&conv, Arc::new(Brain::new(client, "deepseek-chat", "sys")), Arc::new(|_| {}))
            .await?;
        let (_, task, _) = harness
            .submit(Request {
                conversation: &conv,
                provider: "mock",
                request_id: "r1",
                prompt: "delegate",
                source: "user",
                system: "sys",
                ..Default::default()
            })
            .await?;
        let done = harness.scheduler().wait(&task.id, Duration::from_secs(5)).await?;
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(done.result["output"], "reviewed");

        // Call 1 (Plan) denies Write -> "I did not write the file.";
        // Call 2 (Bypass) allows Write -> "Done." and emits cost_usd = 0.0042 (4200 micros).
        let entries = harness.entries(&conv).await?;
        let tool_results: Vec<_> = entries.iter().filter(|e| e.kind == "pi.tool_result").collect();
        assert_eq!(tool_results.len(), 2);
        let out_plan: Value = serde_json::from_str(tool_results[0].payload["output"].as_str().unwrap()).unwrap();
        assert_eq!(out_plan["interrupted"], false);
        assert!(out_plan["output"].as_str().unwrap().contains("I did not write the file."));

        let out_bypass: Value = serde_json::from_str(tool_results[1].payload["output"].as_str().unwrap()).unwrap();
        assert_eq!(out_bypass["interrupted"], false);
        assert!(out_bypass["output"].as_str().unwrap().contains("Done."));

        let conv_read = conv.clone();
        let spent = store.read_async(move |tx| Box::pin(async move { tree_spend(tx, &conv_read).await })).await?;
        assert_eq!(spent, 4200, "expected child OAR cost (4200 micros) in parent tree_spend, got {spent}");
        harness.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn oar_run_crash_after_turn_started_returns_interrupted_without_reprompting() -> durable::Result<()> {
        let dir = TempDir::new().unwrap();
        Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status().await.unwrap();
        std::fs::write(dir.path().join("dirty_oar.txt"), "wip\n").unwrap();

        let prompt_count = Arc::new(AtomicUsize::new(0));
        let count_ref = prompt_count.clone();
        let mut reg = Registry::new();
        reg.register(Arc::new(ScriptedRuntime::new(
            "scripted",
            Script::computed(Arc::new(move |_: &TurnAsk| {
                count_ref.fetch_add(1, Ordering::SeqCst);
                Ok(vec![Step::text("should never run")])
            })),
        )));

        let store = Store::memory()?;
        let harness = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
        harness.register_extension(Arc::new(OarExtension::new(Arc::new(reg), OarPolicy::default())));
        harness.recover().await?;

        let mut crashed = Task::new(OAR_TASK_KIND, OAR_PHASE_RUN);
        crashed.id = "oar-crashed".into();
        crashed.conversation_id = "conv-oar-crash".into();
        crashed.checkpoint = json!({
            "parentToolTaskId": "tool-1",
            "parentConvId": "conv-oar-crash",
            "callId": "call-1",
            "runtime": "scripted",
            "cwd": dir.path().to_string_lossy(),
            "canonicalCwd": std::fs::canonicalize(dir.path()).unwrap().to_string_lossy(),
            "prompt": "do side effect",
            "permissionMode": "Bypass",
            "depth": 0
        });
        crashed.memo = json!({ "turnStarted": true });

        let cwd_str = dir.path().to_string_lossy().into_owned();
        store
            .write_async(move |tx| {
                Box::pin(async move {
                    tx.create_conversation_async("conv-oar-crash", "mock").await?;
                    write_doc::<OarSessionDoc>(
                        tx,
                        TASK_SCOPE,
                        "oar-crashed",
                        &OarSessionState {
                            runtime_id: "scripted".into(),
                            vendor_session_id: "vendor-99".into(),
                            cwd: cwd_str,
                            permission_mode: "bypass".into(),
                            status: "opened".into(),
                        },
                    )
                    .await?;
                    Ok(())
                })
            })
            .await?;
        harness.scheduler().start(crashed).await?;
        let done = harness.scheduler().wait("oar-crashed", Duration::from_secs(3)).await?;
        assert_eq!(done.terminal_reason, "completed");
        assert_eq!(prompt_count.load(Ordering::SeqCst), 0);
        assert_eq!(done.result["interrupted"], true);
        assert_eq!(done.result["vendorSessionId"], "vendor-99");
        assert!(done.result["gitStatus"].as_str().unwrap().contains("dirty_oar.txt"));
        harness.close().await;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn oar_run_enforces_concurrent_mutating_cwd_guard() -> durable::Result<()> {
        let dir = TempDir::new().unwrap();
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel::<()>(1);
        let release_rx = Arc::new(Mutex::new(release_rx));

        let mut reg = Registry::new();
        reg.register(Arc::new(ScriptedRuntime::new(
            "scripted",
            Script::computed(Arc::new(move |_: &TurnAsk| {
                let _ = entered_tx.send(());
                let _ = release_rx.lock().unwrap().recv_timeout(Duration::from_secs(3));
                Ok(vec![Step::text("done"), Step::finish(StopReason::Completed)])
            })),
        )));

        let store = Store::memory()?;
        let ext = Arc::new(OarExtension::new(Arc::new(reg), OarPolicy::default()));
        let harness = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
        harness.register_extension(ext.clone());
        harness.recover().await?;

        // Turn 1: open mutating session in `dir` and block inside ScriptedRuntime.
        let c1 = Arc::new(QueueClient::new(vec![
            Completion {
                message: Message {
                    role: Role::Assistant,
                    content: None,
                    reasoning: None,
                    tool_calls: vec![ToolCall {
                        id: "c1".into(),
                        name: "oar_run".into(),
                        arguments: json!({
                            "runtime": "scripted",
                            "cwd": dir.path(),
                            "prompt": "mut1",
                            "permissionMode": "bypass"
                        })
                        .to_string(),
                    }],
                    tool_call_id: None,
                },
                finish: FinishReason::ToolCalls,
                usage: AiUsage::default(),
            },
            Completion {
                message: Message::assistant("t1 done"),
                finish: FinishReason::Stop,
                usage: AiUsage::default(),
            },
        ]));
        let conv1 = worker_conversation("mut1");
        harness
            .attach_worker(&conv1, Arc::new(Brain::new(c1, "deepseek-chat", "sys")), Arc::new(|_| {}))
            .await?;
        let (_, t1, _) = harness
            .submit(Request {
                conversation: &conv1,
                provider: "mock",
                request_id: "r1",
                prompt: "go",
                source: "user",
                system: "sys",
                ..Default::default()
            })
            .await?;
        tokio::time::timeout(Duration::from_secs(3), entered_rx.recv()).await.unwrap().unwrap();

        // Turn 2 on SAME cwd with mutating mode (`bypass`) is rejected cleanly via tool error!
        let c2 = Arc::new(QueueClient::new(vec![
            Completion {
                message: Message {
                    role: Role::Assistant,
                    content: None,
                    reasoning: None,
                    tool_calls: vec![ToolCall {
                        id: "c2".into(),
                        name: "oar_run".into(),
                        arguments: json!({
                            "runtime": "scripted",
                            "cwd": dir.path(),
                            "prompt": "mut2",
                            "permissionMode": "bypass"
                        })
                        .to_string(),
                    }],
                    tool_call_id: None,
                },
                finish: FinishReason::ToolCalls,
                usage: AiUsage::default(),
            },
            Completion {
                message: Message::assistant("saw conflict"),
                finish: FinishReason::Stop,
                usage: AiUsage::default(),
            },
        ]));
        let conv2 = worker_conversation("mut2");
        harness
            .attach_worker(&conv2, Arc::new(Brain::new(c2, "deepseek-chat", "sys")), Arc::new(|_| {}))
            .await?;
        let (_, t2, _) = harness
            .submit(Request {
                conversation: &conv2,
                provider: "mock",
                request_id: "r2",
                prompt: "go2",
                source: "user",
                system: "sys",
                ..Default::default()
            })
            .await?;
        let d2 = harness.scheduler().wait(&t2.id, Duration::from_secs(3)).await?;
        assert_eq!(d2.result["output"], "saw conflict");
        let e2 = harness.entries(&conv2).await?;
        let res2 = e2.iter().find(|e| e.kind == "pi.tool_result").unwrap();
        assert_eq!(res2.payload["ok"], false);
        assert!(res2.payload["error"].as_str().unwrap().contains("concurrent mutating"));

        let _ = release_tx.send(());
        let d1 = harness.scheduler().wait(&t1.id, Duration::from_secs(3)).await?;
        assert_eq!(d1.result["output"], "t1 done");
        assert!(ext.active_sessions().await.is_empty());
        harness.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn oar_terminal_task_between_open_and_run_prunes_active_session() -> durable::Result<()> {
        let dir = TempDir::new().unwrap();
        let mut reg = Registry::new();
        reg.register(Arc::new(ScriptedRuntime::demo()));
        let rt = reg.require("scripted").unwrap();
        let session = rt
            .open(SessionOptions {
                cwd: dir.path().to_path_buf(),
                ..Default::default()
            })
            .await
            .unwrap();

        let store = Store::memory()?;
        let ext = OarExtension::new(Arc::new(reg), OarPolicy::default());
        let harness = Harness::from_store(store.clone(), Arc::new(WorkersOnly));
        harness.register_extension(Arc::new(ext.clone()));

        let mut task = Task::new(OAR_TASK_KIND, OAR_PHASE_RUN);
        task.id = "oar-aborted-gap".into();
        task.conversation_id = "conv-gap".into();
        let task_write = task.clone();
        store
            .write_async(move |tx| {
                Box::pin(async move {
                    tx.create_conversation_async("conv-gap", "mock").await?;
                    tx.create_task_async(task_write).await?;
                    Ok(())
                })
            })
            .await?;
        ext.inner.active.lock().unwrap().insert(
            task.id.clone(),
            ActiveRecord {
                store: store.clone(),
                entry: ActiveOarSession {
                    task_id: task.id.clone(),
                    conversation_id: "conv-gap".into(),
                    runtime_id: "scripted".into(),
                    vendor_session_id: session.id(),
                    cwd: dir.path().to_path_buf(),
                    canonical_cwd: std::fs::canonicalize(dir.path()).unwrap(),
                    permission_mode: PermissionMode::Plan,
                    session,
                },
            },
        );
        assert_eq!(ext.active_sessions().await.len(), 1);

        // Abort directly via scheduler without Harness::abort_conversation:
        // pruning still cleans up the active session immediately.
        harness.scheduler().abort(&task.id).await?;
        assert!(ext.active_sessions().await.is_empty());
        harness.close().await;
        Ok(())
    }
}
