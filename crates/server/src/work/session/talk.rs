//! A helper profile talking with the user in its direct channel: a session
//! with no issue, in a folder of its own that it keeps from round to round.
//! Each round's answer is reported whole, and the watch posts it in the
//! channel.

use std::path::PathBuf;

use vibevalley_protocol::{ContextRef, ExecutionPolicy, Fact, Issue, Outcome, Phase, Session, SessionAction, SessionController};
use vibevalley_runtime::oar::{SessionOptions, StopReason};

use super::drivers::Persona;
use super::sessions::{Sessions, text};
use crate::work::ledger::{BoardError, Result, Step, io, now};

impl Sessions {
    /// The session talking for `agent` in `channel`, still on the board.
    pub fn talker(&self, agent: &str, channel: &str) -> Option<Session> {
        self.0.ledger.read(|s| {
            s.sessions
                .iter()
                .filter(|h| h.is_direct_talker() && h.issue_id().is_none() && h.profile_id() == Some(agent) && h.channel_id() == Some(channel))
                .max_by_key(|h| h.hired_at)
                .cloned()
        })
    }

    /// The user's words to `agent` in `channel`: its talking session's next
    /// round, hiring one the first time.
    pub async fn talk_async(&self, agent: &str, channel: &str, words: &str) -> Result<String> {
        let _talking = self.0.talking.lock().await;
        if let Some(session) = self.talker(agent, channel) {
            if let Some(live) = self.live_agent(&session.id) {
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                self.0.ledger.apply_async(vec![self.phase_changed(session.id.clone(), phase)]).await?;
                let words = self.with_recall(&session, words.to_string());
                self.record(&session.id, Step::Asked { text: words.clone() });
                live.prompt(text(&words))?;
                return Ok(session.id);
            }
            return self.open_talk_async(agent, channel, words, Some(session)).await;
        }
        self.open_talk_async(agent, channel, words, None).await
    }

    async fn open_talk_async(&self, agent: &str, channel: &str, words: &str, again: Option<Session>) -> Result<String> {
        let drive = self.0.drivers.drive(Some(agent), &Issue::new("", 0, words, now()))?;
        let resuming = again.is_some();
        let mut session = match again {
            Some(s) => s,
            None => {
                let number = self.0.ledger.next_async("session", 0).await?;
                let id = format!("w{number}");
                let mut s = Session::new(
                    &id,
                    SessionController::Channel,
                    drive.name.clone(),
                    drive.runtime_id.clone(),
                    ExecutionPolicy::SandboxDir,
                    now(),
                );
                s.profile = Some(drive.agent.clone());
                s.machine = (!drive.is_local).then(|| drive.machine_id.clone());
                s.cwd = drive
                    .is_local
                    .then(|| self.0.config.data_dir.join("talk").join(&id).to_string_lossy().into_owned());
                s.attach_binding(ContextRef::Channel { id: channel.to_string() });
                s
            }
        };
        session.brief = vibevalley_core::text::clip(words, 120);
        let cwd = PathBuf::from(session.cwd.clone().unwrap_or_default());
        if drive.is_local {
            std::fs::create_dir_all(&cwd).map_err(io)?;
        }
        let resume = if resuming && drive.runtime.capabilities().resume {
            self.extra(&session.id).agent_session
        } else {
            None
        };
        let rules = self.0.drivers.talk_rules(&cwd.to_string_lossy(), channel, &session.id);
        let (rules, prompt) = match &drive.persona {
            Some(Persona::System(persona)) => (format!("{persona}\n\n{rules}"), words.to_string()),
            Some(Persona::Prompt(persona)) if resume.is_none() => (rules, format!("{persona}\n\n---\n\n{words}")),
            _ => (rules, words.to_string()),
        };
        let system_prompt = match &drive.persona {
            Some(Persona::Replace(persona)) => Some(persona.clone()),
            _ => None,
        };
        let mut mcp_servers: Vec<_> = self.door_for(&session.id).into_iter().collect();
        mcp_servers.extend(drive.mcp_servers.iter().cloned());
        let (append_system_prompt, prompt) = drive.work_instructions(rules, prompt);
        let mut env = drive.env.clone();
        if !drive.is_local {
            let meta = crate::infra::machine::RemoteDispatchMeta {
                session_id: Some(session.id.clone()),
                repo_ref: None,
                branch: None,
                base_ref: None,
                mcp_session_token: Some(self.mcp_token_for(&session.id)),
            };
            crate::infra::machine::attach_dispatch_meta(&mut env, &meta);
        }
        let opts = SessionOptions {
            cwd,
            model: drive.model.clone(),
            resume,
            permission_mode: self.0.config.permission,
            append_system_prompt,
            env,
            record_to: Some(self.record_path(&session.id)),
            effort: drive.effort.clone(),
            mcp_servers,
            disallowed_tools: drive.disallowed_tools.clone(),
            system_prompt,
            ..Default::default()
        };
        let runtime = drive.runtime.clone();
        let agent = crate::spawn_blocking_traced(move || runtime.open(opts))
            .await
            .map_err(|e| BoardError::Other(e.to_string()))??;
        session.phase = Phase::working(now(), SessionAction::Thinking, "");
        self.go_live_async(agent.clone(), session.clone(), None).await?;
        let prompt = self.with_recall(&session, prompt);
        self.record(&session.id, Step::Asked { text: prompt.clone() });
        let prompt_agent = agent.clone();
        crate::spawn_blocking_traced(move || prompt_agent.prompt(text(&prompt)))
            .await
            .map_err(|e| BoardError::Other(e.to_string()))?
            .map_err(BoardError::from)?;
        Ok(session.id)
    }

    /// A talking round's end: what it said, whole, as its report.
    pub(super) async fn finish_talk_async(&self, session: &Session, reason: StopReason, said: &str, spent: Option<vibevalley_protocol::Spent>) {
        let outcome = match reason {
            StopReason::Aborted => Outcome::Interrupted,
            StopReason::Error | StopReason::MaxTurns => Outcome::Failed,
            StopReason::Completed => Outcome::Completed,
        };
        let said = said.trim();
        let summary = if !said.is_empty() {
            said.to_string()
        } else if outcome == Outcome::Completed {
            "Done.".into()
        } else {
            "Did not finish.".into()
        };
        let runs = session.runs + 1;
        let _ = self
            .0
            .ledger
            .apply_async(vec![Fact::SessionReported(vibevalley_protocol::FactSessionReported {
                at: now(),
                id: session.id.clone(),
                run: None,
                outcome,
                phase: None,
                summary,
                runs,
                spent,
                questions: vec![],
                checks: vec![],
                answer: None,
            })])
            .await;
    }
}
