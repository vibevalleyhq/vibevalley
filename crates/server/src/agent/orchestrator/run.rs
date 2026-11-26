use std::sync::atomic::Ordering;

use tokio::sync::mpsc;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{Doing, NoticeLevel, ORCHESTRATOR_RUNTIME, Outcome, Phase, PhaseResting, PhaseWorking, SessionAction, SessionEventType};
use vibevalley_runtime::BoxFuture;
use vibevalley_runtime::agent::{AgentEvent, TurnOutcome};

use super::execution::RunSink;
use super::state::Orchestrator;
use super::types::Instance;
use crate::agent::tool::Route;
use crate::channel::{Chat, Posting};
use crate::runtime::Step;

/// One turn as the state, the log and the chat see it.
pub(super) struct Run<'a> {
    pub(super) o: &'a Orchestrator,
    pub(super) me: &'a Instance,
    pub(super) route: &'a Route,
    pub(super) run: String,
    said: String,
    calls: u64,
    pub(super) durable: bool,
    /// The live answers this turn's words also go to, read out as they are.
    pub(super) ports: Vec<mpsc::UnboundedSender<String>>,
    /// Per-turn `oar-voyage/3` JSONL recorder (`<home>/records/<id>.jsonl`).
    recorder: Option<vibevalley_runtime::oar::record::Recorder>,
    record_seq: u64,
}

impl<'a> Run<'a> {
    pub(super) async fn new_async(o: &'a Orchestrator, me: &'a Instance, route: &'a Route) -> Run<'a> {
        Self::start_async(o, me, route, format!("run-{}", uuid::Uuid::now_v7()), None).await
    }

    async fn open_recorder_async(o: &Orchestrator, id: &str, model: Option<&str>) -> Option<vibevalley_runtime::oar::record::Recorder> {
        let dir = o.home.join("records");
        tokio::fs::create_dir_all(&dir).await.ok()?;
        let path = dir.join(format!("{id}.jsonl"));
        let id_owned = id.to_string();
        let root = o.repo.root().to_path_buf();
        let model_owned = model.map(str::to_string);
        crate::log::spawn_blocking_traced(move || {
            let file = vibevalley_runtime::oar::record::open_file(Some(&path)).ok()??;
            vibevalley_runtime::oar::record::Recorder::start(Some(file), ORCHESTRATOR_RUNTIME, &id_owned, &root, model_owned.as_deref())
        })
        .await
        .ok()
        .flatten()
    }

    pub(super) async fn start_async(o: &'a Orchestrator, me: &'a Instance, route: &'a Route, run: String, model: Option<&str>) -> Self {
        let started = o
            .runtime
            .trajectory()
            .events_async(&me.id, Some(&run))
            .await
            .is_some_and(|steps| steps.iter().any(|step| step.r#type == SessionEventType::RunStart));
        let recorder = Self::open_recorder_async(o, &me.id, model).await;
        let r = Run {
            o,
            me,
            route,
            run,
            said: String::new(),
            calls: 0,
            durable: false,
            ports: vec![],
            recorder,
            record_seq: 0,
        };
        if !started {
            r.step(Step::RunStarted { run: r.run.clone() });
        }
        r.phase(Some(SessionAction::Thinking));
        r
    }

    pub(super) fn step(&self, step: Step) {
        self.o.runtime.trajectory().record_step(&self.me.id, "", step);
    }

    fn record_event(&mut self, event: &vibevalley_runtime::oar::Event) {
        let Some(rec) = self.recorder.as_mut() else { return };
        let mut row = vibevalley_runtime::oar::voyage::Record::event(self.me.id.clone(), event);
        row.seq = self.record_seq;
        self.record_seq += 1;
        row.span_id = self.run.clone();
        let _ = rec.write(&row);
    }

    fn agent(&mut self, kind: vibevalley_runtime::oar::EventKind) {
        let event = vibevalley_runtime::oar::Event {
            seq: 0,
            agent_path: vec![],
            at_ms: self.o.ctx.now() as u64,
            kind,
        };
        self.record_event(&event);
        self.step(Step::Agent(event));
    }

    pub(super) async fn asked_async(&mut self, text: &str) {
        let turn_started = vibevalley_runtime::oar::Event {
            seq: 0,
            agent_path: vec![],
            at_ms: self.o.ctx.now() as u64,
            kind: vibevalley_runtime::oar::EventKind::TurnStarted { prompt: text.into() },
        };
        self.record_event(&turn_started);
        if self
            .o
            .runtime
            .trajectory()
            .events_async(&self.me.id, Some(&self.run))
            .await
            .is_none_or(|events| !events.iter().any(|e| e.r#type == SessionEventType::UserMessage))
        {
            self.step(Step::Asked { text: text.into() });
        }
    }

    pub(super) fn phase(&self, doing: Option<SessionAction>) {
        let at = self.o.ctx.now();
        let prev_since = self.o.ctx.live.session(&self.me.id).and_then(|s| match &s.phase {
            Some(Phase::Working(w)) => Some(w.since),
            _ => None,
        });
        let phase = match doing {
            Some(action) => Phase::Working(PhaseWorking {
                since: prev_since.unwrap_or(at),
                quiet_since: None,
                retry: None,
                doing: Doing { action, label: String::new() },
            }),
            None => Phase::Resting(PhaseResting {}),
        };
        let channel = self.route.channel.clone();
        self.o.ctx.live.update_session(&self.me.id, move |snap| {
            snap.phase = Some(phase);
            snap.channel = Some(Some(channel));
            snap.last_event_at = Some(at);
        });
        self.o.ctx.mark_dirty(SliceMask::SESSIONS | SliceMask::FARM);
    }

    /// Says what it has written so far, as one message.
    async fn say_async(&mut self) {
        let text = std::mem::take(&mut self.said);
        if text.trim().is_empty() {
            return;
        }
        for port in &self.ports {
            let _ = port.send(text.clone());
        }
        if self.durable {
            return;
        }
        if let Err(e) = self
            .o
            .chat
            .post_async(Posting {
                from: self.me.id.clone(),
                channel: self.route.channel.clone(),
                text,
                run: Some(self.run.clone()),
                send_key: String::new(),
                made: None,
                spoken: !self.ports.is_empty(),
            })
            .await
        {
            self.o.ctx.live.publish_notice(self.o.ctx.now(), NoticeLevel::Warn, e.message);
        }
    }

    pub(super) async fn on_async(&mut self, e: AgentEvent) {
        use vibevalley_runtime::oar::EventKind as K;
        match e {
            AgentEvent::TextDelta { delta } => {
                if self.said.is_empty() {
                    self.phase(Some(SessionAction::SpeakingText));
                }
                self.said.push_str(&delta);
                self.agent(K::TextDelta { text: delta });
            }
            AgentEvent::ReasoningDelta { delta } => self.agent(K::ThinkingDelta { text: delta }),
            AgentEvent::ToolStart { id, name, arguments } => {
                self.say_async().await;
                self.calls += 1;
                self.phase(Some(SessionAction::Other));
                let input = serde_json::from_str(&arguments).unwrap_or(serde_json::Value::String(arguments));
                self.agent(K::ToolCallStarted { id, name, input });
            }
            AgentEvent::ToolEnd { id, name: _, output } => {
                self.agent(K::ToolCallFinished {
                    id,
                    ok: !output.is_error,
                    output: output.text,
                });
                self.phase(Some(SessionAction::Thinking));
            }
            AgentEvent::Error { message } => self.agent(K::Error { message }),
            AgentEvent::AgentStart
            | AgentEvent::TurnStart { .. }
            | AgentEvent::ToolUpdate { .. }
            | AgentEvent::PermissionRequested { .. }
            | AgentEvent::SubagentSpawned { .. }
            | AgentEvent::SubagentStatusChanged { .. }
            | AgentEvent::Compacted { .. }
            | AgentEvent::TurnEnd { .. }
            | AgentEvent::AgentEnd { .. } => {}
        }
    }

    pub(super) async fn finish_async(mut self, outcome: vibevalley_runtime::agent::Result<TurnOutcome>) {
        self.say_async().await;
        let outcome = match outcome {
            Ok(TurnOutcome::Completed) => Outcome::Completed,
            Ok(TurnOutcome::Aborted) => Outcome::Interrupted,
            Ok(_) => Outcome::Failed,
            Err(e) => {
                let label = self.o.profile.agent(&self.me.id).map(|a| a.name).unwrap_or_else(|| self.me.id.clone());
                self.o.ctx.live.publish_notice(
                    self.o.ctx.now(),
                    NoticeLevel::Error,
                    t("server.session.host.failed", &[("label", label.into()), ("why", e.to_string().into())]),
                );
                Outcome::Failed
            }
        };
        let stop_reason = match outcome {
            Outcome::Completed => vibevalley_runtime::oar::StopReason::Completed,
            Outcome::Interrupted => vibevalley_runtime::oar::StopReason::Aborted,
            Outcome::Failed => vibevalley_runtime::oar::StopReason::Error,
        };
        self.record_event(&vibevalley_runtime::oar::Event {
            seq: 0,
            agent_path: vec![],
            at_ms: self.o.ctx.now() as u64,
            kind: vibevalley_runtime::oar::EventKind::TurnFinished {
                reason: stop_reason,
                usage: vibevalley_runtime::oar::Usage::default(),
            },
        });
        self.step(Step::RunEnded {
            run: self.run.clone(),
            outcome,
        });
        self.phase(None);
    }
}

impl RunSink for Run<'_> {
    fn me_id(&self) -> &str {
        &self.me.id
    }

    fn route(&self) -> &Route {
        self.route
    }

    fn run_id(&self) -> &str {
        &self.run
    }

    fn has_ports(&self) -> bool {
        !self.ports.is_empty()
    }

    fn is_closed(&self) -> bool {
        self.o.closed.load(Ordering::Acquire)
    }

    fn chat(&self) -> &Chat {
        &self.o.chat
    }

    fn set_durable(&mut self) {
        self.durable = true;
    }

    fn on_async<'b>(&'b mut self, e: AgentEvent) -> BoxFuture<'b, ()> {
        Box::pin(Run::on_async(self, e))
    }
}
