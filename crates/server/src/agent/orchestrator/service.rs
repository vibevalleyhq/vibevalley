use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use vibevalley_protocol::{
    AgentRole, ApiError, NoticeLevel, OrchestratorApproval, OrchestratorApprovalListInput, OrchestratorApprovalResolveInput, OrchestratorEval,
    OrchestratorEvalRequest, OrchestratorStopInput, Outcome,
};
use vibevalley_runtime::agent::Brain;

use super::chat::ChatIntake;
use super::execution::{Execution, OrchestratorHost, TurnInput};
use super::run::Run;
use super::state::{Orchestrator, Parts, Reply};
use super::types::{Input, Instance};
use super::words::Source;
use crate::BoxFuture;
use crate::agent::tool::{Route, RouteSource};
use crate::artifact::Manager as ArtifactManager;
use crate::channel::{Chat, Posting, Saying};
use crate::context::port::{CronOrchestratorPort, VoiceOrchestratorPort};
use crate::issue::Board;
use crate::runtime::{Runtime, Step};

impl OrchestratorHost for Orchestrator {
    fn chat(&self) -> &Chat {
        &self.chat
    }

    fn runtime(&self) -> &Runtime {
        &self.runtime
    }

    fn issue(&self) -> &Board {
        &self.issue
    }

    fn artifact(&self) -> &ArtifactManager {
        &self.artifact
    }

    fn brain_at_async<'a>(&'a self, id: &'a str, route: &'a Arc<Mutex<Route>>, model: &'a str) -> BoxFuture<'a, Brain> {
        Box::pin(Orchestrator::brain_at_async(self, id, route, model))
    }

    fn record_worker_compaction_episode(&self, session_id: &str, level: &str, summary: &str) {
        if summary.trim().is_empty() {
            return;
        }
        let Some(orch) = self.me.upgrade() else { return };
        let session_id = session_id.to_owned();
        let level = level.to_owned();
        let summary = summary.to_owned();
        self.ctx.spawn("memory.compaction_episode", async move {
            let session = orch.runtime.session_async(&session_id).await;
            let agent = session
                .as_ref()
                .and_then(|s| s.profile.clone())
                .unwrap_or_else(|| vibevalley_protocol::DEFAULT_ORCHESTRATOR.to_string());
            let repo = session.as_ref().and_then(|s| s.repo_name()).map(str::to_string);
            orch.memory
                .record_compaction_episode_async(&agent, &session_id, &level, &summary, repo.as_deref())
                .await;
        });
    }
}

impl ChatIntake for Orchestrator {
    fn hear_async(&self, input: Input) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            let Some(me) = self.me.upgrade() else { return false };
            me.hear_async(input).await
        })
    }

    fn overhear(&self, agent: Option<&str>, line: String) {
        if let Some(me) = self.me.upgrade() {
            me.overhear(agent, line);
        }
    }
}

impl Orchestrator {
    pub async fn open_async(mut p: Parts) -> vibevalley_runtime::agent::durable::Result<Arc<Orchestrator>> {
        let store = p.runtime.durable_store().clone();
        let listen_chat = p.listen_chat;
        let pending = p.pending_execution.take();
        let o = Arc::new_cyclic(|weak| {
            let host = weak.clone() as Weak<dyn OrchestratorHost>;
            let execution = match pending {
                Some(pending) => pending.attach(host),
                None => Execution::new(store, host, p.permissions),
            };
            Orchestrator {
                me: weak.clone(),
                execution,
                ctx: p.ctx,
                tool: p.tool,
                profile: p.profile,
                chat: p.chat,
                issue: p.issue,
                runtime: p.runtime,
                repo: p.repo,
                memory: p.memory,
                artifact: p.artifact,
                home: p.home,
                key: p.key,
                client: p.client,
                instances: Default::default(),
                ports: Default::default(),
                chat_listener: Default::default(),
                mcp: Default::default(),
                closed: Default::default(),
            }
        });
        for a in o.profile.orchestrators() {
            o.keep_on_duty_async(&a).await;
        }
        let weak = Arc::downgrade(&o);
        o.profile.store.when_kept(Arc::new(move |a: &vibevalley_protocol::Agent| {
            if let Some(o) = weak.upgrade()
                && a.role == AgentRole::Orchestrator
            {
                o.mcp.forget(&a.id);
                let agent = a.clone();
                let o_spawn = o.clone();
                o.ctx.spawn("orchestrator.keep_on_duty", async move {
                    o_spawn.keep_on_duty_async(&agent).await;
                });
            }
            Ok(())
        }));
        // A turn the last process left unfinished is finished now.
        o.execution.scheduler.recover().await?;
        for a in o.profile.orchestrators() {
            if o.execution.has_inputs_async(&a.id).await? {
                o.instance(&a.id);
            }
        }
        if listen_chat {
            o.start_chat_listener(o.clone());
        }
        Ok(o)
    }

    pub(super) fn instance(self: &Arc<Self>, id: &str) -> Arc<Instance> {
        let (me, inserted) = self.get_or_insert_instance(id);
        if inserted {
            let o = Arc::downgrade(self);
            let i = me.clone();
            let cancel = self.ctx.task.child_token();
            self.ctx.spawn("orchestrator.work", async move { Self::work_async(o, i, cancel).await });
        }
        me
    }

    /// Hands an input to its orchestrator; false when it cannot take it.
    pub async fn hear_async(self: &Arc<Self>, input: Input) -> bool {
        if self.closed.load(Ordering::Relaxed) {
            return false;
        }
        let id = self.target(input.agent.as_deref());
        let me = self.instance(&id);
        if let Err(error) = self.execution.enqueue_async(&id, &input).await {
            self.ctx.live.publish_notice(self.ctx.now(), NoticeLevel::Error, error.to_string());
            return false;
        }
        me.pending.store(true, Ordering::SeqCst);
        me.more.notify_one();
        true
    }

    /// Hands a patrol alert without user words to the channel's orchestrator.
    pub async fn hear_patrol_async(self: &Arc<Self>, channel: &str, line: &str) -> bool {
        let agent = self.chat.orchestrator_in(channel);
        self.hear_async(Input {
            agent: Some(agent),
            channel: channel.to_string(),
            source: Source::Patrol,
            line: line.to_string(),
            user: false,
            picked: None,
            messages: vec![],
            port: None,
            cron_id: None,
        })
        .await
    }

    /// `answerer("phone")`: the user's spoken words go into the chat as any
    /// of theirs do, and the turn they wake is answered here as well.
    pub async fn answer_async(self: &Arc<Self>, text: &str) -> Result<Reply, ApiError> {
        let reply = self.open_port();
        self.chat
            .say_async(Saying {
                text: text.into(),
                send_key: uuid::Uuid::new_v4().to_string(),
                source: Some("voice".into()),
                response_port: Some(reply.id.clone()),
                voice_mode: Some("conversation".into()),
                ..Default::default()
            })
            .await?;
        Ok(reply)
    }

    /// `brief`: a line from a call (what to tell the user, a question its
    /// model passes on) put to the default orchestrator; none when it
    /// cannot take it.
    pub async fn brief_async(self: &Arc<Self>, line: String) -> Option<Reply> {
        let reply = self.open_port();
        self.hear_async(Input {
            agent: None,
            channel: self.chat.default_channel(),
            source: Source::Call,
            line,
            user: false,
            picked: None,
            messages: vec![],
            port: Some(reply.id.clone()),
            cron_id: None,
        })
        .await
        .then_some(reply)
    }

    /// Words it heard that did not wake it: shown with its next input.
    pub fn overhear(self: &Arc<Self>, agent: Option<&str>, line: String) {
        let id = self.target(agent);
        self.instance(&id).news.lock().lines.push(line);
    }

    pub async fn close_async(&self) {
        self.closed.store(true, Ordering::Release);
        let chat_listener = self.chat_listener.lock().take();
        if let Some((cancel, handle)) = chat_listener {
            cancel.cancel();
            let _ = handle.await;
        }
        self.execution.close_async().await;
        self.mcp.close();
        self.ports.lock().clear();
        for me in self.instances.lock().values() {
            me.more.notify_waiters();
        }
    }

    async fn work_async(o: Weak<Orchestrator>, me: Arc<Instance>, cancel: CancellationToken) {
        let span = tracing::debug_span!("orchestrator.work", agent_id = %me.id);
        async move {
            loop {
                let ready = loop {
                    if cancel.is_cancelled() {
                        return;
                    }
                    let Some(orch) = o.upgrade() else { return };
                    if orch.closed.load(Ordering::Relaxed) {
                        return;
                    }
                    let notified = me.more.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if me.pending.swap(false, Ordering::SeqCst) {
                        break true;
                    }
                    let saved = orch.execution.has_inputs_async(&me.id).await.unwrap_or(false);
                    drop(orch);
                    if saved {
                        break true;
                    }
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return,
                        _ = tokio::time::timeout(std::time::Duration::from_secs(1), notified) => {}
                    }
                };
                if !ready || cancel.is_cancelled() {
                    return;
                }
                let Some(orch) = o.upgrade() else { return };
                if orch.closed.load(Ordering::Relaxed) {
                    return;
                }
                let batch = if orch.closed.load(Ordering::Acquire) {
                    None
                } else {
                    match orch.execution.batch_async(&me.id).await {
                        Ok(b) => Some(b),
                        Err(e) => {
                            orch.ctx.live.publish_notice(orch.ctx.now(), NoticeLevel::Error, e.to_string());
                            None
                        }
                    }
                };
                let Some(batch) = batch else {
                    return;
                };
                let seen_ids = if batch.is_empty() { Vec::new() } else { orch.turn_async(&me, batch).await };
                for id in seen_ids {
                    let _ = orch.chat.mark_seen_async(&me.id, &id).await;
                }
            }
        }
        .instrument(span)
        .await
    }

    async fn turn_async(&self, me: &Instance, pending: Vec<(String, Input)>) -> Vec<String> {
        let (requests, batch): (Vec<_>, Vec<_>) = pending.into_iter().unzip();
        let Some(last) = batch.last().cloned() else { return Vec::new() };
        let has_user = batch.iter().any(|i| i.user);
        let source = if has_user {
            RouteSource::User
        } else {
            match last.source {
                Source::User => RouteSource::User,
                Source::Chat => RouteSource::Chat,
                Source::Issue => RouteSource::Issue,
                Source::Cron => RouteSource::Cron,
                Source::Patrol => RouteSource::Patrol,
                Source::Call => RouteSource::Call,
            }
        };
        let cron_id = batch.iter().rev().find_map(|i| i.cron_id.clone());
        let route = Route {
            agent: me.id.clone(),
            channel: last.channel.clone(),
            envelope: last.messages.last().cloned().unwrap_or_default(),
            picked: batch
                .iter()
                .rev()
                .find_map(|i| i.picked.as_ref().and_then(|p| p.agent.clone()))
                .unwrap_or_default(),
            user: has_user,
            source: Some(source),
            cron_id,
        };
        // Taken now: a turn that cannot start ends them unanswered.
        let ports: Vec<mpsc::UnboundedSender<String>> = {
            let mut open = self.ports.lock();
            batch.iter().filter_map(|i| i.port.as_ref().and_then(|p| open.remove(p))).collect()
        };
        *me.route.lock() = route.clone();
        let cannot_reason = if (self.key)().is_none_or(|k| k.trim().is_empty()) && self.client.is_none() {
            Some(vibevalley_i18n::t("server.orchestrator.noKey", &[]))
        } else {
            match self.model_of(&me.id) {
                Ok(_) => None,
                Err(why) => Some(vibevalley_i18n::t("server.orchestrator.cannotStart", &[("why", why.into())])),
            }
        };
        if let Some(why) = cannot_reason {
            let _ = self.execution.finish_inputs_async(&requests, false, &serde_json::json!({"error": why})).await;
            // The round is still in its log, failed: what it was told can be read and judged there.
            let mut run = Run::new_async(self, me, &route).await;
            let prompt = self.input_of_async(me, &batch).await;
            run.asked_async(&prompt).await;
            run.step(Step::RunEnded {
                run: run.run.clone(),
                outcome: Outcome::Failed,
            });
            run.phase(None);
            let should_post = {
                let mut said = me.cannot.lock();
                if said.get(&route.channel) != Some(&why) {
                    said.insert(route.channel.clone(), why.clone());
                    true
                } else {
                    false
                }
            };
            if should_post {
                let _ = self
                    .chat
                    .post_async(Posting {
                        from: me.id.clone(),
                        channel: route.channel.clone(),
                        text: why,
                        run: None,
                        send_key: String::new(),
                        made: None,
                        spoken: false,
                    })
                    .await;
            }
            return Vec::new();
        }
        let model = match self.model_of(&me.id) {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };
        me.cannot.lock().clear();
        let text = self.input_of_async(me, &batch).await;
        let mut run = Run::start_async(self, me, &route, format!("run-{}", requests[0]), Some(&model)).await;
        run.ports = ports;
        run.asked_async(&text).await;
        let input = TurnInput {
            requests: &requests,
            batch: &batch,
            text: &text,
            model: &model,
        };
        let outcome = self.execution.run_async(&mut run, input).await;
        if self.closed.load(Ordering::Acquire) {
            return Vec::new();
        }
        run.finish_async(outcome).await;
        batch.into_iter().flat_map(|i| i.messages).collect()
    }

    pub(crate) async fn open_endpoint_async(&self) -> Result<(), ApiError> {
        self.ensure_open_async().await;
        Ok(())
    }

    pub(crate) async fn stop_endpoint_async(self: &Arc<Self>, input: OrchestratorStopInput) -> Result<(), ApiError> {
        self.stop_async(input.agent.as_deref()).await;
        Ok(())
    }

    pub(crate) async fn approvals_endpoint_async(self: &Arc<Self>, input: OrchestratorApprovalListInput) -> Result<Vec<OrchestratorApproval>, ApiError> {
        self.execution.approvals_async(input.conversation_id.as_deref()).await
    }

    pub(crate) async fn resolve_approval_endpoint_async(self: &Arc<Self>, input: OrchestratorApprovalResolveInput) -> Result<(), ApiError> {
        self.execution.resolve_approval_async(input).await
    }

    pub(crate) async fn eval_create_endpoint_async(self: &Arc<Self>, input: OrchestratorEvalRequest) -> Result<OrchestratorEval, ApiError> {
        self.mark_wrong_async(input.agent.as_deref(), input.on.0 as i64, &input.want).await
    }
}

impl VoiceOrchestratorPort for Orchestrator {
    fn brief<'a>(&'a self, line: String, wait: std::time::Duration) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let me = self.me.upgrade()?;
            let mut reply = me.brief_async(line).await?;
            if wait.is_zero() {
                Some(String::new())
            } else {
                Some(reply.whole_async(wait).await)
            }
        })
    }
}

impl CronOrchestratorPort for Orchestrator {
    fn hear_cron<'a>(&'a self, agent: &'a str, channel: &'a str, cron_id: &'a str, line: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let Some(me) = self.me.upgrade() else { return false };
            me.hear_async(Input {
                agent: Some(agent.to_string()),
                channel: channel.to_string(),
                source: Source::Cron,
                line: line.to_string(),
                user: false,
                picked: None,
                messages: vec![],
                port: None,
                cron_id: Some(cron_id.to_string()),
            })
            .await
        })
    }
}
