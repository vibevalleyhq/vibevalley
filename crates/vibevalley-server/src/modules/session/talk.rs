//! A helper profile talking with the user in its direct channel: a session
//! with no issue, in a folder of its own that it keeps from round to round.
//! Each round's answer is reported whole, and the watch posts it in the
//! channel.

use std::path::PathBuf;

use vibevalley_oar::{SessionOptions, StopReason};
use vibevalley_protocol::{Fact, Issue, Outcome, Phase, Session, SessionAction};

use super::drivers::Persona;
use super::sessions::{Sessions, text};
use crate::modules::ledger::{BoardError, Result, Step, io, lock, now};

impl Sessions {
    /// The session talking for `agent` in `channel`, still on the board.
    pub fn talker(&self, agent: &str, channel: &str) -> Option<Session> {
        self.0.ledger.read(|s| {
            s.sessions
                .iter()
                .filter(|h| h.issue.is_none() && h.agent == agent && h.channel.as_deref() == Some(channel))
                .max_by_key(|h| h.hired_at)
                .cloned()
        })
    }

    /// The user's words to `agent` in `channel`: its talking session's next
    /// round, hiring one the first time.
    pub fn talk(&self, agent: &str, channel: &str, words: &str) -> Result<String> {
        let _talking = lock(&self.0.talking);
        if let Some(session) = self.talker(agent, channel) {
            if let Some(live) = self.live_agent(&session.id) {
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                self.0.ledger.apply(vec![self.phase_changed(session.id.clone(), phase)])?;
                let words = self.with_recall(&session, words.to_string());
                self.record(&session.id, Step::Asked { text: words.clone() });
                live.prompt(text(&words))?;
                return Ok(session.id);
            }
            return self.open_talk(agent, channel, words, Some(session));
        }
        self.open_talk(agent, channel, words, None)
    }

    fn open_talk(&self, agent: &str, channel: &str, words: &str, again: Option<Session>) -> Result<String> {
        let drive = self.0.drivers.drive(Some(agent), &Issue::new("", 0, words, now()))?;
        let mut session = match again {
            Some(s) => s,
            None => {
                let number = self.0.ledger.next("session", 0)?;
                let id = format!("w{number}");
                let mut s = Session::worker(&id, drive.name.clone(), now());
                s.agent = drive.agent.clone();
                s.runtime = drive.runtime_id.clone();
                s.channel = Some(channel.to_string());
                s.worktree = Some(self.0.config.data_dir.join("talk").join(&id).to_string_lossy().into_owned());
                s
            }
        };
        session.brief = vibevalley_core::text::clip(words, 120);
        let cwd = PathBuf::from(session.worktree.clone().unwrap_or_default());
        std::fs::create_dir_all(&cwd).map_err(io)?;
        let rules = self.0.drivers.talk_rules(&cwd.to_string_lossy(), channel, &session.id);
        let (rules, prompt) = match &drive.persona {
            Some(Persona::System(persona)) => (format!("{persona}\n\n{rules}"), words.to_string()),
            Some(Persona::Prompt(persona)) => (rules, format!("{persona}\n\n---\n\n{words}")),
            _ => (rules, words.to_string()),
        };
        let system_prompt = match &drive.persona {
            Some(Persona::Replace(persona)) => Some(persona.clone()),
            _ => None,
        };
        let mut mcp_servers: Vec<_> = self.door_for(&session.id).into_iter().collect();
        mcp_servers.extend(drive.mcp_servers.iter().cloned());
        let (append_system_prompt, prompt) = drive.work_instructions(rules, prompt);
        let opts = SessionOptions {
            cwd,
            model: drive.model.clone(),
            permission_mode: self.0.config.permission,
            append_system_prompt,
            env: drive.env.clone(),
            record_to: Some(self.record_path(&session.id)),
            effort: drive.effort.clone(),
            mcp_servers,
            disallowed_tools: drive.disallowed_tools.clone(),
            system_prompt,
            ..Default::default()
        };
        let agent = drive.runtime.open(opts)?;
        session.phase = Phase::working(now(), SessionAction::Thinking, "");
        self.go_live(agent.clone(), session.clone(), None)?;
        let prompt = self.with_recall(&session, prompt);
        self.record(&session.id, Step::Asked { text: prompt.clone() });
        agent.prompt(text(&prompt)).map_err(BoardError::from)?;
        Ok(session.id)
    }

    /// A talking round's end: what it said, whole, as its report.
    pub(super) fn finish_talk(&self, session: &Session, reason: StopReason, said: &str) {
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
        let _ = self.0.ledger.apply(vec![Fact::SessionReported(vibevalley_protocol::FactSessionReported {
            at: now(),
            id: session.id.clone(),
            run: None,
            outcome,
            phase: None,
            summary,
            runs,
            spent: None,
            questions: vec![],
            checks: vec![],
            answer: None,
        })]);
    }
}
