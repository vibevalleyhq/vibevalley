use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::{Mutex as AsyncMutex, broadcast};
use vibevalley_core::SliceMask;
use vibevalley_protocol::{
    ApiError, LastRun, Millis, Outcome, Phase, Session, SessionChildTranscript, SessionChildTranscriptInput, SessionController, SessionEventListInput,
    SessionEventPage, SessionOpenWorkspaceInput, SessionRespondInteractionInput, SessionRespondPermissionInput, SessionSendInput, SessionSetConfigInput,
    SessionWatchPayload, SessionWorkspace,
};
use vibevalley_runtime::oar::Registry;

use super::session::{
    self, ActiveRunSnapshot, MailboxEntry, MailboxSource, PermissionEvent, Report, RuntimeDriver, SessionDriver, SessionEngine, SessionLifecycleEvent,
    Trajectory,
};
use super::types::{Opened, Result, RuntimeConfig, io};
use crate::context::{Context, now};
use crate::service::DbError;
use crate::storage::Storage;

/// Reopens stored sessions on server boot: interrupts active non-recoverable runs
/// and records drafts for recovery.
pub async fn reopen_sessions_async(ctx: &Arc<Context>, paused_issues: &HashSet<String>) -> Result<Opened> {
    let durable = ctx.service.durable().await?;
    let stored = ctx.service.session.all().await?;
    let all_extras = ctx.service.session.extras().await?;
    let mut recoverable_ids = HashSet::new();
    for s in &stored {
        if s.phase.is_working()
            && !s.is_refining()
            && s.issue_id().is_none_or(|id| !paused_issues.contains(id))
            && s.runtime == vibevalley_runtime::agent::runtime::ID
            && let Some(extra) = all_extras.get(&s.id)
            && let (Some(run_id), Some(vendor)) = (extra.run.as_deref(), extra.agent_session.as_deref())
        {
            let conv = vibevalley_runtime::agent::harness::worker_conversation(vendor);
            let req = format!("work:{run_id}");
            if durable
                .read_with_async((conv.as_str(), req.as_str()), |tx, &(conv, req)| {
                    Box::pin(tx.submission_by_request_async(conv, req))
                })
                .await?
                .is_some()
            {
                recoverable_ids.insert(s.id.clone());
            }
        }
    }

    let mut opened = Opened::default();
    for mut session in stored {
        if session.is_refining() {
            opened.drafts.push(session.id.clone());
        }
        if session.phase.is_working() && !session.is_refining() && recoverable_ids.contains(&session.id) {
            opened.recoverable.push(session.id.clone());
        } else if session.phase.is_working() {
            let at = now();
            let summary = "Interrupted: VibeValley was closed while it worked";
            if let Some(children) = &mut session.subagents {
                children.disconnected_at.get_or_insert(at);
            }
            session.phase = Phase::resting();
            session.runs += 1;
            let session_svc = ctx.service.session.clone();
            let (updated_session, run) = durable
                .write_with_async((session_svc, session, at, summary), |tx, state| {
                    let session_svc = state.0.clone();
                    let mut session = state.1.clone();
                    let at = state.2;
                    let summary = state.3;
                    Box::pin(async move {
                        let extras = session_svc.extras_in_tx(tx.transaction()).await.map_err(DbError::into_durable_error)?;
                        let recovery = session::delivery::interrupt_on_reopen(&session_svc, tx, &session, extras.get(&session.id), at, summary).await?;
                        session.last_run = Some(LastRun {
                            needs_reconciliation: recovery.as_ref().is_some_and(|(_, rec)| *rec),
                            outcome: Outcome::Interrupted,
                            summary: summary.into(),
                            at,
                            spent: None,
                            answer: None,
                        });
                        if let Some(children) = &session.subagents {
                            session_svc
                                .put_subagents_in_tx(tx.transaction(), children)
                                .await
                                .map_err(DbError::into_durable_error)?;
                        }
                        session_svc
                            .put_in_tx(tx.transaction(), &session, false)
                            .await
                            .map_err(DbError::into_durable_error)?;
                        Ok((session, recovery.map(|(run_id, _)| run_id)))
                    })
                })
                .await?;
            if let Some(run) = run {
                opened.interrupted.push((updated_session.id.clone(), run));
            }
        }
    }
    ctx.mark_dirty(SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM);
    Ok(opened)
}

/// Top-level facade grouping the session engine and trajectory logger.
pub struct Runtime {
    ctx: Arc<Context>,
    session: SessionEngine,
    trajectory: Arc<Trajectory>,
}

impl Runtime {
    /// Opens the execution runtime on `ctx` with the given `drivers` and `config`.
    pub async fn open_async(ctx: Arc<Context>, drivers: Arc<dyn SessionDriver>, config: RuntimeConfig) -> Result<(Arc<Runtime>, Opened)> {
        Self::open_with_paused_async(ctx, drivers, config, &HashSet::new()).await
    }

    /// Opens the execution runtime on `ctx`, skipping auto-recovery for issues listed in `paused_issues`.
    pub async fn open_with_paused_async(
        ctx: Arc<Context>,
        drivers: Arc<dyn SessionDriver>,
        config: RuntimeConfig,
        paused_issues: &HashSet<String>,
    ) -> Result<(Arc<Runtime>, Opened)> {
        tokio::fs::create_dir_all(config.data_dir.join("reports")).await.map_err(io)?;
        tokio::fs::create_dir_all(config.data_dir.join("records")).await.map_err(io)?;
        let opened = reopen_sessions_async(&ctx, paused_issues).await?;
        let config = Arc::new(config);
        let trajectory = Trajectory::open(ctx.clone());
        let write_lock = Arc::new(AsyncMutex::new(()));
        let session = SessionEngine::new_async(ctx.clone(), write_lock, drivers, config, Some(trajectory.clone())).await?;
        session.recover_on_connect(opened.recoverable.clone());
        session.record_interrupted_async(opened.interrupted.clone()).await;
        Ok((Arc::new(Runtime { ctx, session, trajectory }), opened))
    }

    /// Standalone convenience constructor using [`RuntimeDriver`] over `registry`.
    pub async fn open_with_registry_async(ctx: Arc<Context>, registry: Arc<Registry>, config: RuntimeConfig) -> Result<(Arc<Runtime>, Opened)> {
        let drivers = Arc::new(RuntimeDriver {
            registry,
            model: config.model.clone(),
        });
        Self::open_async(ctx, drivers, config).await
    }

    pub fn ctx(&self) -> &Arc<Context> {
        &self.ctx
    }

    pub fn session_engine(&self) -> &SessionEngine {
        &self.session
    }

    pub fn trajectory(&self) -> &Arc<Trajectory> {
        &self.trajectory
    }

    pub fn driver(&self) -> &Arc<dyn SessionDriver> {
        self.session.driver()
    }

    pub fn config(&self) -> &RuntimeConfig {
        self.session.config()
    }

    pub fn write_lock(&self) -> &Arc<AsyncMutex<()>> {
        self.session.write_lock()
    }

    pub fn durable_store(&self) -> &vibevalley_runtime::agent::durable::Store {
        self.session.durable_store()
    }

    /// Disposes live agent handles and flushes all open trajectories.
    pub async fn close_async(&self) {
        self.session.close();
        self.trajectory.close_async().await;
    }

    pub fn set_mcp_url(&self, url: String) {
        self.session.set_mcp_url(url);
    }

    pub fn mcp_url(&self) -> Option<String> {
        self.session.mcp_url()
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<SessionLifecycleEvent> {
        self.session.subscribe_events()
    }

    pub fn subscribe_doing(&self) -> broadcast::Receiver<(String, Millis, vibevalley_protocol::Doing)> {
        self.session.subscribe_doing()
    }

    pub fn subscribe_permissions(&self) -> broadcast::Receiver<PermissionEvent> {
        self.session.subscribe_permissions()
    }

    pub fn has_pending_permission(&self, session_id: &str, request_id: &str) -> bool {
        self.session
            .workspace_snapshot(session_id)
            .pending_permissions
            .iter()
            .any(|p| p.request_id == request_id)
    }

    pub fn who(&self, token: &str) -> Option<String> {
        self.session.who(token)
    }

    pub fn opening_session(&self, id: &str) -> Option<Session> {
        self.session.opening_session(id)
    }

    pub fn base_branch(&self, session: &str) -> Option<String> {
        self.session.base_branch(session)
    }

    pub async fn get_async(&self, id: &str) -> Option<Session> {
        self.session.session_async(id).await
    }

    pub async fn session_async(&self, id: &str) -> Option<Session> {
        self.session.session_async(id).await
    }

    pub async fn past_session_async(&self, id: &str) -> Option<Session> {
        self.session.past_session_async(id).await
    }

    pub async fn list_async(&self) -> Vec<Session> {
        self.session.list_async().await
    }

    pub async fn sessions_async(&self) -> Result<Vec<Session>> {
        self.session.sessions_async().await
    }

    pub async fn stop_async(&self, id: &str) -> std::result::Result<Session, ApiError> {
        self.session.stop_async(id).await
    }

    pub async fn report_async(&self, session: &str, report: &Report) -> Result<()> {
        self.session.report_async(session, report).await
    }

    pub async fn upsert_orchestrator_async(&self, session: &Session) -> std::result::Result<(), ApiError> {
        self.session.upsert_orchestrator_async(session).await
    }

    pub async fn active_run_snapshot_async(&self, vendor: &str, run_id: &str) -> Result<Option<ActiveRunSnapshot>> {
        self.session.active_run_snapshot_async(vendor, run_id).await
    }

    pub async fn enqueue_mailbox_async(
        &self,
        session_id: &str,
        idempotency_key: &str,
        source: MailboxSource,
        source_message_id: Option<&str>,
        payload: &str,
    ) -> Result<MailboxEntry> {
        self.session
            .enqueue_mailbox_async(session_id, idempotency_key, source, source_message_id, payload)
            .await
    }

    pub async fn drain_passive_context_async(&self, session_id: &str) -> Result<Vec<MailboxEntry>> {
        self.session.drain_passive_context_async(session_id).await
    }

    pub async fn withdraw_mailbox_async(&self, idempotency_key: &str) -> Result<bool> {
        self.session.withdraw_mailbox_async(idempotency_key).await
    }

    pub async fn withdraw_mailbox_by_message_async(&self, message_id: &str) -> Result<u64> {
        self.session.withdraw_mailbox_by_message_async(message_id).await
    }

    pub async fn claim_next_mailbox_async(&self, session_id: &str) -> Result<Option<MailboxEntry>> {
        self.session.claim_next_mailbox_async(session_id).await
    }

    pub async fn claim_mailbox_by_key_async(&self, idempotency_key: &str) -> Result<bool> {
        self.session.claim_mailbox_by_key_async(idempotency_key).await
    }

    pub async fn settle_mailbox_async(&self, id: i64, ok: bool, result: Option<&str>) -> Result<()> {
        self.session.settle_mailbox_async(id, ok, result).await
    }

    pub async fn mailbox_entries_async(&self, session_id: &str) -> Result<Vec<MailboxEntry>> {
        self.session.mailbox_entries_async(session_id).await
    }

    // --- Router dispatch helpers for `Session*` & `Watch` endpoints ---

    pub(crate) async fn list_endpoint_async(
        &self,
        profile: Option<String>,
        controller: Option<SessionController>,
    ) -> std::result::Result<Vec<Session>, ApiError> {
        self.session.list_endpoint_async(profile, controller).await
    }

    pub(crate) async fn get_endpoint_async(&self, id: &str) -> std::result::Result<Session, ApiError> {
        self.session.get_endpoint_async(id).await
    }

    pub(crate) async fn event_list_endpoint_async(&self, input: &SessionEventListInput) -> std::result::Result<SessionEventPage, ApiError> {
        self.session.event_list_endpoint_async(input).await
    }

    pub(crate) async fn open_workspace_endpoint_async(&self, input: SessionOpenWorkspaceInput) -> std::result::Result<SessionWorkspace, ApiError> {
        self.session.open_workspace_endpoint_async(input).await
    }

    pub(crate) async fn close_workspace_endpoint_async(&self, id: &str) -> std::result::Result<(), ApiError> {
        self.session.close_workspace_endpoint_async(id).await
    }

    pub(crate) async fn send_workspace_endpoint_async(
        &self,
        input: SessionSendInput,
        storage: Option<&Storage>,
        trace_id: Option<u64>,
    ) -> std::result::Result<Session, ApiError> {
        self.session.send_workspace_endpoint_async(input, storage, trace_id).await
    }

    pub(crate) async fn respond_permission_endpoint_async(&self, input: SessionRespondPermissionInput) -> std::result::Result<(), ApiError> {
        self.session.respond_permission_endpoint_async(input).await
    }

    pub(crate) async fn respond_interaction_endpoint_async(&self, input: SessionRespondInteractionInput) -> std::result::Result<(), ApiError> {
        self.session.respond_interaction_endpoint_async(input).await
    }

    pub(crate) async fn set_config_endpoint_async(&self, input: SessionSetConfigInput) -> std::result::Result<SessionWorkspace, ApiError> {
        self.session.set_config_endpoint_async(input).await
    }

    pub(crate) async fn child_transcript_endpoint_async(&self, input: SessionChildTranscriptInput) -> std::result::Result<SessionChildTranscript, ApiError> {
        self.session.child_transcript_endpoint_async(input).await
    }

    pub(crate) async fn compact_live_async(&self, id: &str) -> std::result::Result<(), ApiError> {
        self.session.compact_live_async(id).await
    }

    pub(crate) fn worker_conversation(&self, id: &str) -> Option<String> {
        self.session.worker_conversation(id)
    }

    pub(crate) fn is_live_session(&self, id: &str) -> bool {
        self.session.is_live(id)
    }

    pub(crate) async fn watch_session_async(&self, input: SessionWatchPayload, sink: crate::context::Sink) -> std::result::Result<(), ApiError> {
        self.session.watch_session_async(input, sink).await
    }
}
