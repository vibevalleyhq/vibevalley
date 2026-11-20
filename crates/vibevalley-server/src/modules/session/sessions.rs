//! The board's sessions at work: hiring a helper on an issue, each round it
//! works, the words it is sent, its agent's events turned into facts,
//! stopping it and letting it go. A work round's report goes onto its issue
//! as an [`IssueChange::Reported`]; a draft's end and the moment after every
//! round are the issue module's ([`Rounds`]); a direct talk ends here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use vibevalley_oar::{ContentBlock, EventKind, McpServer, PermissionDecision, PermissionMode, SessionOptions, StopReason};
use vibevalley_protocol::{
    Deliverable, Doing, Fact, Issue, IssueAnswer, Millis, Outcome, Phase, PhaseWorking, Question, RunTrigger, Session, SessionAction, Spent,
};

use super::drivers::{Drive, Drivers, HelperPlace, Persona};
use super::report::{Report, ReportQuestion, ReportStatus};
use crate::modules::ledger::{BoardConfig, BoardError, IssueChange, Ledger, Result, Step, io, lock, now};
use crate::modules::workplace::{Leave, Leaving, Workplace};

/// What the board keeps of a session beyond the wire `Session`: the
/// runtime's own session to resume, and the branch its work forked from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Extra {
    pub agent_session: Option<String>,
    pub base: Option<String>,
    /// The run going on now, until its round ends.
    #[serde(default)]
    pub run: Option<String>,
}

/// A session this process is driving. `generation` tells a pump whether
/// the session it reads is still the one on the board.
struct Live {
    agent: Arc<dyn vibevalley_oar::Session>,
    generation: u64,
}

/// The helpers' MCP door as the board hands it out: where it is, and which
/// helper each bearer token names.
#[derive(Default)]
struct Door {
    url: Option<String>,
    tokens: HashMap<String, String>,
}

/// A drafting round that ended: what the drafter said, for the issue
/// module to read the draft from.
pub struct DraftEnd {
    pub spent: Option<Spent>,
    pub session: Session,
    pub issue: Issue,
    pub reason: StopReason,
    pub said: String,
    pub asked: Vec<Question>,
}

/// What the issue module does when rounds end.
pub trait Rounds: Send + Sync {
    /// A drafting round ended; the draft goes onto the issue and the
    /// drafter goes home.
    fn drafted(&self, end: DraftEnd);
    /// After every round: what waits may go now.
    fn after(&self);
}

/// A new session on an issue: who, where, and its first prompt.
pub struct Hire<'a> {
    pub issue: &'a Issue,
    pub drive: Drive,
    pub cwd: PathBuf,
    pub branch: Option<String>,
    /// The branch its work forks from.
    pub base: Option<String>,
    pub name: String,
    pub brief: String,
    pub drafting: bool,
    pub prompt: String,
    pub trigger: RunTrigger,
}

pub(super) fn text(s: &str) -> Vec<ContentBlock> {
    vec![ContentBlock::Text(s.to_string())]
}

#[derive(Clone)]
pub struct Sessions(pub(super) Arc<Inner>);

pub(super) struct Inner {
    pub ledger: Arc<Ledger>,
    pub durable: vibevalley_agent::durable::Store,
    pub drivers: Arc<dyn Drivers>,
    pub workplaces: Arc<Workplace>,
    pub config: Arc<BoardConfig>,
    live: Mutex<HashMap<String, Live>>,
    generation: AtomicU64,
    pub(super) extras: Mutex<HashMap<String, Extra>>,
    door: Mutex<Door>,
    rounds: OnceLock<Box<dyn Rounds>>,
    pub(super) recovering: Mutex<Vec<String>>,
    pub(super) listeners: Mutex<Vec<super::news::Listener>>,
    /// Held while a direct talk finds or hires its session.
    pub talking: Mutex<()>,
}

impl Sessions {
    pub fn new(
        durable: vibevalley_agent::durable::Store,
        ledger: Arc<Ledger>,
        drivers: Arc<dyn Drivers>,
        workplaces: Arc<Workplace>,
        config: Arc<BoardConfig>,
    ) -> Result<Sessions> {
        let extras = ledger.database(super::db::extras)?;
        Ok(Sessions(Arc::new(Inner {
            durable,
            ledger,
            drivers,
            workplaces,
            config,
            live: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            extras: Mutex::new(extras),
            door: Mutex::new(Door::default()),
            rounds: OnceLock::new(),
            listeners: Mutex::new(Vec::new()),
            recovering: Default::default(),
            talking: Mutex::new(()),
        })))
    }

    /// Who hears rounds end; set once.
    pub fn on_rounds(&self, rounds: Box<dyn Rounds>) {
        let _ = self.0.rounds.set(rounds);
    }

    /// The agents this process drives stop; their rounds are recorded as
    /// interrupted when the board opens next.
    pub fn close(&self) {
        let live: Vec<Live> = lock(&self.0.live).drain().map(|(_, l)| l).collect();
        for l in live {
            l.agent.dispose();
        }
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        self.0.ledger.session(id)
    }

    /// Whether this process drives the session now.
    pub fn is_live(&self, session: &str) -> bool {
        lock(&self.0.live).contains_key(session)
    }

    pub(super) fn live_agent(&self, session: &str) -> Option<Arc<dyn vibevalley_oar::Session>> {
        lock(&self.0.live).get(session).map(|l| l.agent.clone())
    }

    /// The record file of a session's agent events.
    pub fn record_path(&self, session: &str) -> PathBuf {
        self.0.config.data_dir.join("records").join(format!("{session}.jsonl"))
    }

    pub fn report_path(&self, session: &str) -> PathBuf {
        self.0.config.data_dir.join("reports").join(format!("{session}.json"))
    }

    /// What the helper hands back at the end of its round (`issue_report`),
    /// read when the round ends.
    pub fn report(&self, session: &str, report: &Report) -> Result<()> {
        let path = self.report_path(session);
        let failed = |e: &dyn std::fmt::Display| BoardError::Other(format!("the report for {session}: {e}"));
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| failed(&e))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(report).map_err(|e| failed(&e))?).map_err(|e| failed(&e))?;
        std::fs::rename(tmp, path).map_err(|e| failed(&e))
    }

    /// Where helpers reach the farm's MCP door (`http://<addr>/mcp`); a helper
    /// started before it is known gets no door.
    pub fn set_mcp_url(&self, url: String) {
        lock(&self.0.door).url = Some(url);
        let ids = std::mem::take(&mut *lock(&self.0.recovering));
        for id in ids {
            if let Err(e) = self.restore_generation(&id) {
                eprintln!("vibevalley: restoring {id}: {e}");
                lock(&self.0.recovering).push(id);
            }
        }
    }

    /// The helper a bearer token names.
    pub fn who(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        lock(&self.0.door).tokens.get(token).cloned()
    }

    /// The helper's door entry, minting its token once.
    pub(super) fn door_for(&self, session: &str) -> Option<McpServer> {
        let mut door = lock(&self.0.door);
        let url = door.url.clone()?;
        let token = match door.tokens.iter().find(|(_, s)| s.as_str() == session) {
            Some((t, _)) => t.clone(),
            None => {
                let t = uuid::Uuid::new_v4().simple().to_string();
                door.tokens.insert(t.clone(), session.to_string());
                t
            }
        };
        Some(McpServer::Http {
            name: "vibevalley".into(),
            url,
            headers: vec![("authorization".into(), format!("Bearer {token}"))],
        })
    }

    pub(super) fn extra(&self, session: &str) -> Extra {
        lock(&self.0.extras).get(session).cloned().unwrap_or_default()
    }

    pub(super) fn set_extra(&self, session: &str, change: impl FnOnce(&mut Extra)) -> Result<()> {
        let mut extras = lock(&self.0.extras);
        let extra = extras.entry(session.to_string()).or_default();
        change(extra);
        self.0.ledger.database(|db| super::db::put_extra(db, session, extra))?;
        Ok(())
    }

    /// The branch a session's work forked from.
    pub fn base_branch(&self, session: &str) -> Option<String> {
        self.extra(session).base
    }

    pub(crate) fn record_interrupted(&self, runs: Vec<(String, String)>) {
        for (session, run) in runs {
            self.record(
                &session,
                Step::RunEnded {
                    run,
                    outcome: Outcome::Interrupted,
                },
            );
        }
    }

    /// A new session on an issue, its agent opened and its first prompt sent.
    pub fn hire(&self, h: Hire) -> Result<String> {
        let number = self.0.ledger.next("session", 0)?;
        let id = format!("w{number}");
        let mut session = Session::worker(&id, h.name, now());
        session.agent = h.drive.agent.clone();
        session.runtime = h.drive.runtime_id.clone();
        session.brief = h.brief;
        session.repo = h.issue.repo.clone();
        session.branch = h.branch;
        self.set_extra(&id, |e| e.base = h.base)?;
        session.worktree = Some(h.cwd.to_string_lossy().into_owned());
        session.issue = Some(h.issue.id.clone());
        session.refining = h.drafting;
        self.start(h.drive, session, h.issue, h.prompt, false, h.trigger)
    }

    /// Opens the agent for `session`, puts it on the board and sends the
    /// first prompt. `resume` reopens the runtime's own session.
    fn start(&self, drive: Drive, mut session: Session, issue: &Issue, prompt: String, resume: bool, trigger: RunTrigger) -> Result<String> {
        let _ = std::fs::remove_file(self.report_path(&session.id));
        let (agent, prompt) = self.open_for(drive, &session, issue, prompt, resume)?;
        session.phase = Phase::working(now(), SessionAction::Thinking, "");
        let started = IssueChange::Started {
            session: session.id.clone(),
            worker: !session.refining,
        };
        self.go_live(agent.clone(), session.clone(), Some((issue.id.as_str(), started)))?;
        let run = self.begin_run(&session.id, &issue.id, trigger)?;
        let prompt = self.with_recall(&session, prompt);
        self.record(&session.id, Step::Asked { text: prompt.clone() });
        if let Err(e) = Self::prompt_run(&*agent, &run, &prompt) {
            let _ = self.dismiss(&session.id, Leave::Keep);
            return Err(e.into());
        }
        Ok(session.id)
    }

    fn prompt_run(agent: &dyn vibevalley_oar::Session, run: &str, prompt: &str) -> vibevalley_oar::Result<()> {
        if agent.runtime_id() != vibevalley_agent::runtime::ID {
            return agent.prompt(text(prompt));
        }
        let key = format!("work:{run}");
        let outcome = agent.control(vibevalley_oar::ControlAction::Prompt, prompt, &key, &key)?;
        if outcome.status != vibevalley_oar::ControlStatus::Accepted {
            return Err(vibevalley_oar::AgentError::Rejected(format!("{}: {}", outcome.code, outcome.reason)));
        }
        Ok(())
    }
    pub(crate) fn recover_on_connect(&self, ids: Vec<String>) {
        lock(&self.0.recovering).extend(ids);
    }

    fn restore_generation(&self, id: &str) -> Result<()> {
        let session = self.session(id).ok_or_else(|| BoardError::Other(format!("missing session {id}")))?;
        let issue = session
            .issue
            .as_ref()
            .and_then(|i| self.0.ledger.issue(i))
            .ok_or_else(|| BoardError::Other(format!("missing issue for {id}")))?;
        let extra = self.extra(id);
        let run = extra.run.ok_or_else(|| BoardError::Other(format!("missing open run for {id}")))?;
        let vendor = extra.agent_session.ok_or_else(|| BoardError::Other(format!("missing driver id for {id}")))?;
        let conv = vibevalley_agent::harness::worker_conversation(&vendor);
        let sub = self
            .0
            .durable
            .read(|tx| tx.submission_by_request(&conv, &format!("work:{run}")))?
            .ok_or_else(|| BoardError::Other(format!("missing generation for {run}")))?;
        let task = self.0.durable.read(|tx| tx.task(&format!("gen-{}", sub.id)))?;
        let drive = self.0.drivers.drive(Some(&session.agent), &issue)?;
        let (agent, _) = self.open_for(drive, &session, &issue, String::new(), true)?;
        self.go_live(agent.clone(), session, None)?;
        if task.status == vibevalley_agent::durable::TaskStatus::Terminal {
            Self::prompt_run(&*agent, &run, sub.payload["text"].as_str().unwrap_or_default())?;
        }
        Ok(())
    }

    fn open_for(&self, drive: Drive, session: &Session, issue: &Issue, prompt: String, resume: bool) -> Result<(Arc<dyn vibevalley_oar::Session>, String)> {
        let cwd = PathBuf::from(session.worktree.clone().unwrap_or_default());
        let instructions = if session.refining {
            "You are drafting an issue for VibeValley's board. Do not change or commit files.".to_string()
        } else {
            let place = HelperPlace {
                repo: session.repo.clone().unwrap_or_default(),
                branch: session.branch.clone(),
                cwd: session.worktree.clone().unwrap_or_default(),
                id: session.id.clone(),
                pull_request: issue.deliver == Deliverable::PullRequest,
                house: self.0.workplaces.house_rules(),
            };
            self.0.drivers.rules(&place, issue.deliver)
        };
        let system_prompt = match &drive.persona {
            Some(Persona::Replace(persona)) => Some(persona.clone()),
            _ => None,
        };
        let (instructions, prompt) = match &drive.persona {
            Some(Persona::System(persona)) => (format!("{persona}\n\n{instructions}"), prompt),
            Some(Persona::Prompt(persona)) if !resume => (instructions, format!("{persona}\n\n---\n\n{prompt}")),
            _ => (instructions, prompt),
        };
        let mut mcp_servers: Vec<McpServer> = self.door_for(&session.id).into_iter().collect();
        mcp_servers.extend(drive.mcp_servers.iter().cloned());
        #[allow(clippy::needless_update, reason = "fields vibevalley-oar adds later")]
        let (append_system_prompt, prompt) = drive.work_instructions(instructions, prompt);
        let opts = SessionOptions {
            cwd,
            model: drive.model.clone(),
            resume: if resume { self.extra(&session.id).agent_session } else { None },
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
        Ok((drive.runtime.open(opts)?, prompt))
    }

    /// `session` on the board, driven by `agent` from now on: its events
    /// pumped into facts. The issue it works changes in the same commit.
    pub(super) fn go_live(&self, agent: Arc<dyn vibevalley_oar::Session>, session: Session, issue: Option<(&str, IssueChange)>) -> Result<()> {
        let events = agent.events_with_history();
        self.set_extra(&session.id, |e| e.agent_session = agent.resume_id())?;
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        lock(&self.0.live).insert(
            session.id.clone(),
            Live {
                agent: agent.clone(),
                generation,
            },
        );
        let id = session.id.clone();
        let previous = session
            .subagents
            .as_ref()
            .filter(|s| s.disconnected_at.is_some() && s.root_thread_id == agent.id())
            .cloned();
        let changed = Fact::session_changed(now(), session);
        match issue.filter(|(i, _)| self.0.ledger.issue(i).is_some()) {
            Some((issue, change)) => {
                self.0.ledger.change_with(issue, change, |fact| vec![changed, fact])?;
            }
            None => self.0.ledger.apply(vec![changed])?,
        }
        if let Some(before) = previous {
            let me = self.clone();
            let session_id = id.clone();
            if let Err(err) = std::thread::Builder::new().name(format!("vibevalley-read-children-{id}")).spawn(move || {
                let mut after = before.clone();
                let changed = super::subagents::read_back(&mut after, |thread, turn| agent.read_subagent(thread, turn), now);
                if changed
                    && me.current(&session_id, generation)
                    && let Err(err) = me.0.ledger.reconcile_subagents(&session_id, &before, after)
                {
                    eprintln!("could not reconcile subagents for {session_id}: {err}");
                }
            }) {
                eprintln!("could not start subagent history lookup for {id}: {err}");
            }
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name(format!("vibevalley-{id}"))
            .spawn(move || me.pump(&id, generation, events))
            .map_err(io)?;
        Ok(())
    }

    /// `withRecall`: what the agent remembers, set apart before the input.
    pub(super) fn with_recall(&self, session: &Session, input: String) -> String {
        let block = self
            .0
            .drivers
            .recall(&session.agent, &session.id, session.repo.as_deref().unwrap_or(""), &input);
        if block.is_empty() { input } else { format!("{block}\n\n---\n\n{input}") }
    }

    /// The next round for a session on the board: its agent if this process
    /// still drives it, else reopened (resumed when the runtime can, else
    /// told `again`).
    pub fn next_round(&self, issue: &Issue, session: &Session, words: String, again: impl FnOnce(&str) -> String, trigger: RunTrigger) -> Result<String> {
        let agent = lock(&self.0.live).get(&session.id).map(|l| l.agent.clone());
        match agent {
            Some(agent) => {
                let _ = std::fs::remove_file(self.report_path(&session.id));
                // Working from now, not from when the pump reads the turn's
                // start: the room is counted by it.
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                self.0.ledger.apply(vec![self.phase_changed(session.id.clone(), phase)])?;
                let run = self.begin_run(&session.id, &issue.id, trigger)?;
                let words = self.with_recall(session, words);
                self.record(&session.id, Step::Asked { text: words.clone() });
                Self::prompt_run(&*agent, &run, &words)?;
                self.0.ledger.change(&issue.id, IssueChange::Unqueued)?;
                Ok(session.id.clone())
            }
            None => {
                let drive = self.0.drivers.drive(Some(session.agent.as_str()).filter(|a| !a.is_empty()), issue)?;
                let resume = drive.runtime.capabilities().resume && self.extra(&session.id).agent_session.is_some();
                let prompt = if resume { words } else { again(&words) };
                self.start(drive, session.clone(), issue, prompt, resume, trigger)
            }
        }
    }

    /// Words into the running turn of a working session this process
    /// drives (queued for after it when the runtime cannot steer); none when
    /// it is not working here.
    pub fn steer(&self, session: &Session, words: &str) -> Option<Result<()>> {
        if !session.phase.is_working() {
            return None;
        }
        let agent = lock(&self.0.live).get(&session.id).map(|l| l.agent.clone())?;
        self.record(&session.id, Step::Asked { text: words.to_string() });
        Some(match agent.steer(text(words)) {
            Ok(()) => Ok(()),
            Err(_) => agent.queue(text(words)).map_err(BoardError::from),
        })
    }

    /// Stops the running turn of `session`.
    pub fn stop(&self, session: &str) -> Result<()> {
        let agent = lock(&self.0.live).get(session).map(|l| l.agent.clone());
        let agent = agent.ok_or_else(|| BoardError::Other("nothing is running".into()))?;
        agent.abort()?;
        Ok(())
    }

    /// Lets a session go: its agent stops, its open round ends, its
    /// workplace is left as `leave` says, and it leaves the board.
    pub fn dismiss(&self, session_id: &str, leave: Leave) -> Result<()> {
        let live = lock(&self.0.live).remove(session_id);
        if let Some(live) = live {
            let _ = live.agent.abort();
            live.agent.dispose();
        }
        let session = self.session(session_id);
        if session.as_ref().is_some_and(|s| s.phase.is_working()) {
            self.end_run(session_id, Outcome::Interrupted, "", None)?;
        }
        if let Some(s) = &session
            && let (Some(repo), Some(worktree), Some(branch)) = (&s.repo, &s.worktree, &s.branch)
        {
            let leaving = Leaving {
                repo,
                worktree,
                branch,
                base: self.extra(&s.id).base,
                name: &s.name,
                drafting: s.refining,
            };
            self.0.workplaces.release(&leaving, leave)?;
        }
        let _ = std::fs::remove_file(self.report_path(session_id));
        lock(&self.0.door).tokens.retain(|_, s| s != session_id);
        if session.is_some() {
            self.0.ledger.apply(vec![Fact::session_left(now(), session_id, None)])?;
        }
        lock(&self.0.extras).remove(session_id);
        self.0.ledger.database(|db| super::db::remove_extra(db, session_id))?;
        Ok(())
    }

    // ----- a session's events -----

    fn current(&self, session: &str, generation: u64) -> bool {
        lock(&self.0.live).get(session).is_some_and(|l| l.generation == generation)
    }

    /// Turns the agent's events into facts until the session ends or leaves.
    fn pump(&self, session_id: &str, generation: u64, events: flume::Receiver<vibevalley_oar::Event>) {
        let quiet_after = self.0.config.quiet_after;
        let mut observed_run = None;
        let mut said = String::new();
        let mut asked: Vec<Question> = Vec::new();
        let mut failure = None;
        let mut last_event = Instant::now();
        let tick = quiet_after.min(Duration::from_secs(5)).max(Duration::from_millis(20));
        loop {
            let event = match events.recv_timeout(tick) {
                Ok(event) => event,
                Err(flume::RecvTimeoutError::Timeout) => {
                    if !self.current(session_id, generation) {
                        return;
                    }
                    if last_event.elapsed() >= quiet_after {
                        self.set_quiet(session_id, Some(now()));
                    }
                    continue;
                }
                Err(flume::RecvTimeoutError::Disconnected) => break,
            };
            if !self.current(session_id, generation) {
                return;
            }
            last_event = Instant::now();
            self.set_quiet(session_id, None);
            let root = event.agent_path.is_empty();
            if root && matches!(event.kind, EventKind::TurnStarted { .. }) {
                observed_run = self.extra(session_id).run;
            }
            if let Some(run) = observed_run.as_deref()
                && super::subagents::relevant(&event)
                && let Err(error) = self.observe_subagents(session_id, generation, run, &event)
            {
                eprintln!("could not record subagent progress for {session_id}: {error}");
            }
            self.record(session_id, Step::Agent(event.clone()));
            match event.kind {
                EventKind::SessionStarted { session_id: vendor, .. } if root => {
                    let _ = self.set_extra(session_id, |e| e.agent_session = Some(vendor));
                }
                EventKind::TurnStarted { .. } if root => {
                    said.clear();
                    asked.clear();
                    failure = None;
                    let phase = Phase::working(now(), SessionAction::Thinking, "");
                    let _ = self.0.ledger.apply(vec![self.phase_changed(session_id, phase)]);
                }
                EventKind::TextDelta { text } if root => said.push_str(&text),
                EventKind::ToolCallStarted { name, input, .. } if root => {
                    let action = super::journal::tool_action(&name, &input);
                    let detail = super::journal::tool_detail(&input, "");
                    let label = if detail.is_empty() && action == vibevalley_protocol::ToolAction::Other {
                        name
                    } else {
                        detail.chars().take(512).collect()
                    };
                    self.set_doing(session_id, Doing { action: action.into(), label });
                }
                EventKind::Question { text } if root => {
                    asked.push(Question {
                        question: text,
                        options: vec![],
                    });
                }
                EventKind::PermissionRequested { request_id, .. } if self.0.config.permission == PermissionMode::Bypass => {
                    let agent = lock(&self.0.live).get(session_id).map(|l| l.agent.clone());
                    if let Some(agent) = agent {
                        let _ = agent.respond_permission(&request_id, PermissionDecision::AllowOnce);
                    }
                }
                EventKind::Error { message } if root => failure = Some(message),
                EventKind::TurnFinished { reason, usage } if root => {
                    observed_run = None;
                    self.finish(session_id, reason, reported_spent(&usage), &said, &asked, failure.as_deref());
                    if let Some(rounds) = self.0.rounds.get() {
                        rounds.after();
                    }
                }
                EventKind::SessionEnded => break,
                _ => {}
            }
        }
        let mut live = lock(&self.0.live);
        if live.get(session_id).is_some_and(|l| l.generation == generation) {
            live.remove(session_id);
        }
    }

    fn observe_subagents(&self, session_id: &str, generation: u64, run: &str, event: &vibevalley_oar::Event) -> Result<()> {
        if !self.current(session_id, generation) {
            return Ok(());
        }
        let Some(root) = self.extra(session_id).agent_session else { return Ok(()) };
        self.0
            .ledger
            .update_subagents(session_id, run, &root, |session| super::subagents::observe(session, run, &root, event))
    }

    /// A phase change keeps the session where it talks: the fact carries
    /// the channel, and an absent one would clear it.
    pub(super) fn phase_changed(&self, id: impl Into<String>, phase: Phase) -> Fact {
        let id = id.into();
        let channel = self.session(&id).and_then(|s| s.channel);
        Fact::session_phase_changed(now(), id, phase, channel)
    }

    fn working(&self, session_id: &str) -> Option<PhaseWorking> {
        self.session(session_id).and_then(|s| match s.phase {
            Phase::Working(p) => Some(p),
            _ => None,
        })
    }

    fn set_doing(&self, session_id: &str, doing: Doing) {
        let Some(p) = self.working(session_id) else { return };
        let phase = Phase::Working(PhaseWorking { doing, quiet_since: None, ..p });
        let _ = self.0.ledger.apply(vec![self.phase_changed(session_id, phase)]);
    }

    fn set_quiet(&self, session_id: &str, quiet: Option<Millis>) {
        let Some(p) = self.working(session_id) else { return };
        if p.quiet_since.is_some() == quiet.is_some() {
            return;
        }
        let phase = Phase::Working(PhaseWorking { quiet_since: quiet, ..p });
        let _ = self.0.ledger.apply(vec![self.phase_changed(session_id, phase)]);
    }

    pub(crate) fn review_work(&self, vendor: &str, run_id: &str, candidate: &str) -> Result<Option<(Issue, Report)>> {
        let Some(run) = self.0.ledger.database(|db| super::db::run(db, run_id))? else {
            return Ok(None);
        };
        let Some(session) = self.session(&run.session) else { return Ok(None) };
        let extra = self.extra(&run.session);
        if session.refining
            || run.outcome.is_some()
            || session.runtime != vibevalley_agent::runtime::ID
            || extra.run.as_deref() != Some(run_id)
            || extra.agent_session.as_deref() != Some(vendor)
        {
            return Ok(None);
        }
        let Some(issue) = run.issue.as_deref().and_then(|id| self.0.ledger.issue(id)) else {
            return Ok(None);
        };
        if issue.criteria.iter().all(|line| line.trim().is_empty()) {
            return Ok(None);
        }
        let report = Report::read(&self.report_path(&run.session));
        let round = read_round(&issue, StopReason::Completed, report.as_ref(), candidate, &[]);
        if round.outcome != Outcome::Completed || !round.questions.is_empty() {
            return Ok(None);
        }
        Ok(Some((
            issue,
            Report {
                summary: round.summary,
                checks: round.checks,
                answer: round.answer,
                ..Report::default()
            },
        )))
    }

    /// A round's end: a talk's answer, a draft for the issue module, or a
    /// work round's report onto its issue.
    fn finish(&self, session_id: &str, reason: StopReason, spent: Option<Spent>, said: &str, asked: &[Question], failure: Option<&str>) {
        let Some(session) = self.session(session_id) else { return };
        if session.issue.is_none() && session.channel.is_some() {
            self.finish_talk(&session, reason, said, spent);
            return;
        }
        let Some(issue) = session.issue.as_deref().and_then(|i| self.0.ledger.issue(i)) else {
            return;
        };
        if session.refining {
            if let Some(rounds) = self.0.rounds.get() {
                rounds.drafted(DraftEnd {
                    spent,
                    session,
                    issue,
                    reason,
                    said: said.to_string(),
                    asked: asked.to_vec(),
                });
            }
            return;
        }
        let extra = self.extra(session_id);
        let output = match self.graded_output(&session, &extra) {
            Ok(output) => output,
            Err(e) => {
                eprintln!("vibevalley: reading the outcome for {session_id}: {e}");
                return;
            }
        };
        let report = Report::read(&self.report_path(session_id));
        let failed = matches!(reason, StopReason::Error | StopReason::MaxTurns);
        let mut round = read_round(&issue, reason, report.as_ref(), output.as_deref().unwrap_or(said), asked);
        if failed && let Some(error) = failure {
            round.summary = vibevalley_core::text::clip(error, 400);
        }
        let run_id = extra.run;
        let summary = round.summary.clone();
        let outcome = round.outcome;
        let reported = Fact::SessionReported(vibevalley_protocol::FactSessionReported {
            at: now(),
            id: session_id.into(),
            run: run_id.clone(),
            outcome: round.outcome,
            phase: None,
            summary: round.summary,
            runs: session.runs + 1,
            spent: spent.clone(),
            questions: vec![],
            checks: round.checks.clone(),
            answer: round.answer.clone(),
        });
        let change = IssueChange::Reported {
            questions: (round.outcome != Outcome::Interrupted).then_some(round.questions),
            checks: round.checks,
            answer: round.answer,
        };
        if let Err(error) = self.0.ledger.change_commit(
            &issue.id,
            change,
            |fact| vec![fact, reported],
            |tx| {
                if let Some(id) = run_id.as_deref()
                    && let Some(mut r) = super::db::run(tx.connection(), id)?
                {
                    r.ended_at = Some(now());
                    r.outcome = Some(outcome);
                    r.summary = summary;
                    r.spent = spent;
                    super::db::put_run(tx.connection(), &r)?;
                    super::delivery::settle_run(tx, &r)?;
                    super::db::clear_run(tx.connection(), session_id, id)?;
                }
                Ok(())
            },
        ) {
            eprintln!("vibevalley: settling {session_id}: {error}");
            return;
        }
        if let Some(id) = run_id {
            if let Some(extra) = lock(&self.0.extras).get_mut(session_id)
                && extra.run.as_ref() == Some(&id)
            {
                extra.run = None;
            }
            self.record(session_id, Step::RunEnded { run: id, outcome });
        }
        if let Some(r) = report.as_ref().filter(|r| !r.remember.is_empty()) {
            self.announce(super::News::Remember {
                agent: session.agent.clone(),
                session: session_id.to_string(),
                repo: session.repo.clone().unwrap_or_default(),
                memories: r.remember.clone(),
            });
        }
    }
}

fn reported_spent(usage: &vibevalley_oar::Usage) -> Option<Spent> {
    let tokens = usage.input_tokens?.checked_add(usage.output_tokens?)?;
    Some(Spent {
        tokens: i64::try_from(tokens).ok()?,
        cny: None,
    })
}

/// What a work round handed back, from its report or else from what the
/// agent said.
struct Round {
    outcome: Outcome,
    summary: String,
    questions: Vec<Question>,
    checks: Vec<vibevalley_protocol::CriterionCheck>,
    answer: Option<IssueAnswer>,
}

fn read_round(issue: &Issue, reason: StopReason, report: Option<&Report>, said: &str, asked: &[Question]) -> Round {
    let outcome = match (&reason, report) {
        (StopReason::Aborted, _) => Outcome::Interrupted,
        (StopReason::Error | StopReason::MaxTurns, _) => Outcome::Failed,
        (StopReason::Completed, Some(r)) if r.status == ReportStatus::Failed => Outcome::Failed,
        (StopReason::Completed, _) => Outcome::Completed,
    };
    let declared = report.map(|r| r.summary.trim().to_string()).filter(|s| !s.is_empty());
    let summary = declared.unwrap_or_else(|| {
        let read = vibevalley_core::text::summary_of(said);
        if !read.is_empty() {
            read
        } else if outcome == Outcome::Completed {
            "Done.".into()
        } else {
            "Did not finish.".into()
        }
    });
    let summary = vibevalley_core::text::clip(&summary, 400);
    let mut questions: Vec<Question> = match report {
        Some(r) if !r.questions.is_empty() => r.questions.iter().map(ReportQuestion::to_question).collect(),
        _ => vibevalley_core::text::questions_from_text(said),
    };
    questions.extend(asked.iter().cloned());
    if outcome == Outcome::Completed && questions.is_empty() && report.is_some_and(|r| r.status == ReportStatus::Blocked) {
        questions.push(Question {
            question: summary.clone(),
            options: vec![],
        });
    }
    let questions = vibevalley_core::refine::open_questions(&questions);
    let answer: Option<IssueAnswer> = report.and_then(|r| r.answer.clone()).or_else(|| {
        (issue.deliver == Deliverable::Answer && outcome == Outcome::Completed && !said.trim().is_empty()).then(|| IssueAnswer {
            conclusion: said.trim().to_string(),
            evidence: vec![],
            unsure: vec![],
            next: vec![],
        })
    });
    let checks = report
        .map(|r| r.checks.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| vibevalley_core::text::checks_from_text(said));
    Round {
        outcome,
        summary,
        questions,
        checks,
        answer,
    }
}
