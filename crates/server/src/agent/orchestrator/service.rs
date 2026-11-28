use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, AgentRole, ApiError, BizCode, ChannelType, NoticeLevel, Outcome, Phase, SessionApproval, SessionApprovalListInput, SessionApprovalResolveInput,
    SessionCompactResult, SessionController, SessionEval, SessionEvalRequest, SessionRunCodeInput, SessionRunCodeResult,
};
use vibevalley_runtime::agent::ai::CancelToken;
use vibevalley_runtime::agent::durable::Error as DurableError;
use vibevalley_runtime::agent::{ChatRequest, Delta, Message};

use super::execution::{Execution, TurnInput};
use super::run::Run;
use super::state::{Orchestrator, Parts, Reply};
use super::types::{Input, Instance};
use super::words::{self, Source};
use crate::agent::profile::text;
use crate::agent::tool::{Route, RouteSource};
use crate::channel::{Committed, Posting, QueuedDelivery, Saying, actor_of, meta_of};
use crate::context::error::{LookIn, missing};
use crate::context::text::format_note_view_context;
use crate::runtime::Step;
use crate::service::session::{MailboxSource, MailboxStatus};

impl Orchestrator {
    pub(super) fn record_worker_compaction_episode(&self, session_id: &str, level: &str, summary: &str) {
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

    pub async fn open_async(mut p: Parts) -> vibevalley_runtime::agent::durable::Result<Arc<Orchestrator>> {
        let store = p.runtime.durable_store().clone();
        let pending = p.pending_execution.take();
        let o = Arc::new_cyclic(|weak| {
            let execution = match pending {
                Some(pending) => pending.attach(weak.clone()),
                None => Execution::new(store, weak.clone(), p.permissions),
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
                note: p.note,
                home: p.home,
                key: p.key,
                client: p.client,
                state: Default::default(),
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
        Ok(o)
    }

    /// Returns true if `profile` is a daemon built-in orchestrator session profile.
    pub fn is_daemon_profile(&self, profile: &str) -> bool {
        self.profile.is_orchestrator(profile)
    }

    /// Unified channel delivery entry point called by [`crate::orchestration::DeliveryRouter`]'s
    /// `AgentAdapter`:
    /// - `wakes == false`: durably appends to `session_mailbox` (`MailboxSource::PassiveContext`) without waking.
    /// - `wakes == true`: enqueues & claims `MailboxSource::ChannelOrchestrator` and triggers a daemon turn.
    pub async fn deliver_channel_async(self: &Arc<Self>, profile: &str, d: &QueuedDelivery, c: &Committed) -> Result<bool, ApiError> {
        const HANDED_EMOJI: &str = "👀";
        if !self.is_daemon_profile(profile) {
            return Ok(false);
        }
        let m = self.chat.addressed_of(&c.row);
        let line = words::orchestrator_lines(std::slice::from_ref(&m));
        if !d.wakes {
            let key = format!("passive:{profile}:{}", d.message_id);
            let _ = self
                .runtime
                .enqueue_mailbox_async(profile, &key, MailboxSource::PassiveContext, Some(&d.message_id), &line)
                .await;
            return Ok(true);
        }

        let sessions = &self.ctx.service.session;
        let now_ms = self.ctx.now();
        let mail_key = format!("orchestrator:{profile}:{}", d.message_id);
        let mail_entry = match sessions
            .enqueue_mailbox(profile, &mail_key, MailboxSource::ChannelOrchestrator, Some(&d.message_id), &c.row.body, now_ms)
            .await
        {
            Ok(entry) => Some(entry),
            Err(err) => {
                tracing::warn!(mail_key = %mail_key, error = %err, "daemon session enqueue_mailbox failed");
                None
            }
        };
        let claimed = match sessions.claim_mailbox_by_key(&mail_key, now_ms).await {
            Ok(claimed) => claimed,
            Err(err) => {
                tracing::warn!(mail_key = %mail_key, error = %err, "daemon session claim_mailbox_by_key failed");
                false
            }
        };
        if !claimed
            && mail_entry
                .as_ref()
                .is_some_and(|e| matches!(e.status, MailboxStatus::Withdrawn | MailboxStatus::Done | MailboxStatus::Claimed))
        {
            return Ok(true);
        }
        let settle_id = mail_entry.as_ref().map(|e| e.id);
        let actor = actor_of(&c.row.sender_kind, c.row.sender_agent.as_deref(), &c.row.sender_id, Some(&c.row.sender_name));
        let meta = meta_of(c.row.meta.as_deref());
        let from_user = matches!(actor, Actor::User { .. });
        let mut picked_note = String::new();
        if let Some(p) = &meta.picked {
            if let Some(a) = p.agent.as_deref().and_then(|a| self.profile.agent(a)) {
                picked_note += &words::picked_agent(&a.name);
            }
            if let Some(r) = &p.repo {
                picked_note += &words::picked_repo(r);
            }
        }
        let view_note = meta
            .view_context
            .as_ref()
            .filter(|_| c.row.deleted_at.is_none())
            .map(|vc| format!("{}\n", format_note_view_context(vc)))
            .unwrap_or_default();
        let command_note = meta
            .command
            .as_ref()
            .filter(|cmd| !cmd.name.trim().is_empty())
            .map(|cmd| words::command_note(cmd.name.trim(), cmd.args.trim()))
            .unwrap_or_default();
        let text = c.row.body.trim();
        let said = match meta.voice_mode.as_deref() {
            Some("dictated") => format!("{picked_note}{view_note}{command_note}{}{}", words::DICTATED, words::user_line(text)),
            Some("conversation") => format!("{}\n{command_note}{}", text::PROMPTS.voice, words::user_line(text)),
            _ if from_user && (c.channel_type == ChannelType::Direct || c.row.channel_id == self.chat.default_channel()) => {
                format!("{picked_note}{view_note}{command_note}{}", words::user_line(text))
            }
            _ => format!("{picked_note}{command_note}{}", words::chat_line(&m.target, &line)),
        };
        let input = Input {
            agent: Some(profile.to_string()),
            channel: c.row.channel_id.clone(),
            source: if from_user { Source::User } else { Source::Chat },
            line: said,
            user: from_user,
            picked: meta.picked.clone(),
            messages: vec![c.row.id.clone()],
            port: meta.response_port.clone(),
            cron_id: None,
        };
        let heard = self.hear_async(input).await;
        if heard {
            if let Some(id) = settle_id
                && let Err(err) = sessions.settle_mailbox(id, true, Some(profile), self.ctx.now()).await
            {
                tracing::warn!(mailbox_id = id, recipient = profile, error = %err, "daemon session settle_mailbox failed");
            }
            if let Err(e) = self.chat.react_async(&c.row.id, profile, HANDED_EMOJI, true).await {
                tracing::warn!(message_id = %c.row.id, recipient = profile, error = %e.message, "daemon session react 👀 failed");
            }
            Ok(true)
        } else {
            if !self.closed.load(Ordering::Acquire)
                && let Some(id) = settle_id
                && let Err(err) = sessions.settle_mailbox(id, false, Some("rejected"), self.ctx.now()).await
            {
                tracing::warn!(mailbox_id = id, recipient = profile, error = %err, "daemon session settle_mailbox failed");
            }
            Ok(false)
        }
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

    pub async fn close_async(&self) {
        self.closed.store(true, Ordering::Release);
        self.execution.close_async().await;
        self.mcp.close();
        let mut state = self.state.lock();
        state.ports.clear();
        for me in state.instances.values() {
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
        let ports: Vec<mpsc::Sender<String>> = {
            let mut state = self.state.lock();
            batch.iter().filter_map(|i| i.port.as_ref().and_then(|p| state.ports.remove(p))).collect()
        };
        me.route.store(Arc::new(route.clone()));
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
                let mut state = me.state.lock();
                if state.cannot.get(&route.channel) != Some(&why) {
                    state.cannot.insert(route.channel.clone(), why.clone());
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
        me.state.lock().cannot.clear();
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

    pub(crate) async fn approvals_endpoint_async(self: &Arc<Self>, input: SessionApprovalListInput) -> Result<Vec<SessionApproval>, ApiError> {
        self.execution.approvals_async(input.id.as_deref()).await
    }

    pub(crate) async fn resolve_approval_endpoint_async(self: &Arc<Self>, input: SessionApprovalResolveInput) -> Result<(), ApiError> {
        self.execution.resolve_approval_async(input).await
    }

    pub(crate) async fn eval_create_endpoint_async(self: &Arc<Self>, input: SessionEvalRequest) -> Result<SessionEval, ApiError> {
        self.mark_wrong_async(input.id.as_deref(), input.on.0 as i64, &input.want).await
    }

    pub(crate) async fn compact_session_endpoint_async(self: &Arc<Self>, id: &str) -> Result<SessionCompactResult, ApiError> {
        let id = id.trim();
        if id.is_empty() {
            return Err(ApiError::new(BizCode::InvalidInput, "session id must be nonempty"));
        }
        let session = self.runtime.session_async(id).await;
        let is_daemon = session.as_ref().is_some_and(|s| s.controller == SessionController::Daemon) || self.profile.is_orchestrator(id);
        if is_daemon {
            let model = self.model_of(id).unwrap_or_default();
            return match self.execution.harness.engine().compact_manual(id, &model).await {
                Ok(Some(summary)) => {
                    self.memory
                        .record_compaction_episode_async(id, "manual-compact", "manual", &summary, None)
                        .await;
                    Ok(SessionCompactResult {
                        id: id.into(),
                        compacted: true,
                        summary: Some(summary),
                        reason: None,
                    })
                }
                Ok(None) => Ok(SessionCompactResult {
                    id: id.into(),
                    compacted: false,
                    summary: None,
                    reason: Some(t("server.session.compact.notEnoughEntries", &[])),
                }),
                Err(DurableError::Missing(_)) => Ok(SessionCompactResult {
                    id: id.into(),
                    compacted: false,
                    summary: None,
                    reason: Some(t("server.session.compact.empty", &[])),
                }),
                Err(DurableError::Invalid(msg)) => Err(ApiError::new(BizCode::SessionRefused, msg)),
                Err(err) => Err(ApiError::new(BizCode::InternalError, err.to_string())),
            };
        }
        let Some(session) = session else {
            if self.runtime.past_session_async(id).await.is_some() {
                return Err(ApiError::new(BizCode::SessionRefused, t("server.session.compact.closed", &[])));
            }
            return Err(missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session));
        };
        if matches!(session.phase, Phase::Closed(_)) {
            return Err(ApiError::new(BizCode::SessionRefused, t("server.session.compact.closed", &[])));
        }
        if session.runtime != vibevalley_runtime::agent::runtime::ID {
            self.runtime.compact_live_async(id).await?;
            return Ok(SessionCompactResult {
                id: id.into(),
                compacted: true,
                summary: None,
                reason: None,
            });
        }
        let conv = self.runtime.worker_conversation(id);
        let prev = match conv.as_deref() {
            Some(c) => self.execution.latest_compaction_async(c).await.ok().flatten().map(|(seq, _)| seq),
            None => None,
        };
        if self.runtime.is_live_session(id) {
            self.runtime.compact_live_async(id).await?;
            let after = match conv.as_deref() {
                Some(c) => self.execution.latest_compaction_async(c).await.ok().flatten(),
                None => None,
            };
            if let Some((seq, summary)) = after
                && Some(seq) != prev
            {
                return Ok(SessionCompactResult {
                    id: id.into(),
                    compacted: true,
                    summary: Some(summary),
                    reason: None,
                });
            }
            return Ok(SessionCompactResult {
                id: id.into(),
                compacted: false,
                summary: None,
                reason: Some(t("server.session.compact.notEnoughEntries", &[])),
            });
        }
        let Some(conv) = conv else {
            return Ok(SessionCompactResult {
                id: id.into(),
                compacted: false,
                summary: None,
                reason: Some(t("server.session.compact.empty", &[])),
            });
        };
        match self.execution.harness.engine().compact_manual(&conv, "").await {
            Ok(Some(summary)) => Ok(SessionCompactResult {
                id: id.into(),
                compacted: true,
                summary: Some(summary),
                reason: None,
            }),
            Ok(None) => Ok(SessionCompactResult {
                id: id.into(),
                compacted: false,
                summary: None,
                reason: Some(t("server.session.compact.notEnoughEntries", &[])),
            }),
            Err(DurableError::Missing(_)) => Ok(SessionCompactResult {
                id: id.into(),
                compacted: false,
                summary: None,
                reason: Some(t("server.session.compact.empty", &[])),
            }),
            Err(DurableError::Invalid(msg)) => Err(ApiError::new(BizCode::SessionRefused, msg)),
            Err(err) => Err(ApiError::new(BizCode::InternalError, err.to_string())),
        }
    }

    pub(crate) async fn run_code_endpoint_async(self: &Arc<Self>, input: SessionRunCodeInput) -> Result<SessionRunCodeResult, ApiError> {
        let id = input.id.trim();
        if id.is_empty() {
            return Err(ApiError::new(BizCode::InvalidInput, "session id must be nonempty"));
        }
        if input.script.trim().is_empty() {
            return Err(ApiError::new(BizCode::InvalidInput, t("server.session.codemode.emptyScript", &[])));
        }
        let session = self.runtime.session_async(id).await;
        let is_daemon = session.as_ref().is_some_and(|s| s.controller == SessionController::Daemon) || self.profile.is_orchestrator(id);
        let conv = if is_daemon {
            id.to_owned()
        } else {
            let Some(session) = session else {
                if self.runtime.past_session_async(id).await.is_some() {
                    return Err(ApiError::new(BizCode::SessionRefused, t("server.session.compact.closed", &[])));
                }
                return Err(missing(t("server.helperRef", &[("id", id.into())]), LookIn::Session));
            };
            if matches!(session.phase, Phase::Closed(_)) {
                return Err(ApiError::new(BizCode::SessionRefused, t("server.session.compact.closed", &[])));
            }
            if session.runtime != vibevalley_runtime::agent::runtime::ID {
                return Err(ApiError::new(
                    BizCode::RuntimeRefused,
                    t("server.session.codemode.unsupportedRuntime", &[("runtime", session.runtime.into())]),
                ));
            }
            self.runtime
                .worker_conversation(id)
                .ok_or_else(|| ApiError::new(BizCode::SessionRefused, t("server.session.compact.empty", &[])))?
        };
        let seed = input.seed.map(|s| s.get().max(0.0) as u64);
        let (task_id, res) = self
            .execution
            .harness
            .engine()
            .run_codemode_script(&conv, &input.script, seed, input.timeout_ms, input.max_steps)
            .await
            .map_err(|err| match err {
                DurableError::Invalid(msg) => ApiError::new(BizCode::SessionRefused, msg),
                other => ApiError::new(BizCode::InternalError, other.to_string()),
            })?;
        let output_json = serde_json::to_string(&res.value).unwrap_or_else(|_| "null".into());
        Ok(SessionRunCodeResult {
            id: id.to_owned(),
            task_id,
            output_json,
            executed_steps: i64::try_from(res.executed_steps).unwrap_or(i64::MAX),
            replayed_calls: i64::try_from(res.replayed_calls).unwrap_or(i64::MAX),
            replayed_sleeps: i64::try_from(res.replayed_sleeps).unwrap_or(i64::MAX),
            virtual_now_ms: res.virtual_now_ms,
        })
    }
    /// Submits a voice call briefing line and waits up to `wait` for the orchestrator's answer.
    pub async fn brief_wait_async(&self, line: String, wait: std::time::Duration) -> Option<String> {
        let me = self.me.upgrade()?;
        let mut reply = me.brief_async(line).await?;
        if wait.is_zero() {
            Some(String::new())
        } else {
            Some(reply.whole_async(wait).await)
        }
    }

    /// Polishes a raw ASR transcript using the orchestrator's configured model client.
    pub async fn polish_text_async(&self, system: &str, text: &str) -> Result<String, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        if self.client.is_none() && (self.key)().is_none() {
            return Ok(trimmed.to_string());
        }
        let req = ChatRequest {
            model: "deepseek-flash".into(),
            messages: vec![Message::system(system), Message::user(trimmed)],
            temperature: Some(0.1),
            max_tokens: Some(2048),
            ..Default::default()
        };
        let cancel_token = CancellationToken::new();
        let cancel = CancelToken::from_tokio(cancel_token.clone());
        let mut sink = |_delta: Delta| {};
        let completion = tokio::time::timeout(std::time::Duration::from_secs(10), self.client().complete_cancellable(&req, &cancel, &mut sink))
            .await
            .map_err(|_| {
                cancel_token.cancel();
                "ASR polish timed out".to_string()
            })?
            .map_err(|e| e.to_string())?;
        let polished = completion.message.content.unwrap_or_default().trim().to_string();
        Ok(if polished.is_empty() { trimmed.to_string() } else { polished })
    }

    /// Delivers a scheduled cron trigger into the target orchestrator instance.
    pub async fn hear_cron_async(&self, agent: &str, channel: &str, cron_id: &str, line: &str) -> bool {
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
    }
}
