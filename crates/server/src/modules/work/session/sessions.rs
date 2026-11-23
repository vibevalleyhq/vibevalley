//! The board's sessions at work: hiring a helper on an issue, each round it
//! works, the words it is sent, its agent's events turned into facts,
//! stopping it and letting it go. A work round's report goes onto its issue
//! as an [`IssueChange::Reported`]; a draft's end and the moment after every
//! round are the issue module's ([`Rounds`]); a direct talk ends here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;
use vibevalley_protocol::{
    Caller, Deliverable, Doing, Fact, Issue, IssueAnswer, IssueReportMemoryScope, MemoryCreateInput, Millis, Outcome, Phase, PhaseWorking, Question,
    RunTrigger, Session, SessionAction, Spent, ops,
};
use vibevalley_runtime::oar::{ContentBlock, EventKind, McpServer, PermissionDecision, PermissionMode, SessionOptions, StopReason};

use super::drivers::{Drive, Drivers, HelperPlace, Persona};
use super::report::{Report, ReportQuestion, ReportStatus};
use crate::modules::work::ledger::{BoardConfig, BoardError, IssueChange, Ledger, Result, Step, now};
use crate::modules::work::workplace::{Leave, Leaving, Workplace};
use crate::{CallerContext, CallerPrincipal, ClientIdentity, ClientKind, Hub};

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
    agent: Arc<dyn vibevalley_runtime::oar::Session>,
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
    pub durable: vibevalley_runtime::agent::durable::Store,
    pub drivers: Arc<dyn Drivers>,
    pub workplaces: Arc<Workplace>,
    pub config: Arc<BoardConfig>,
    pub hub: Option<Weak<Hub>>,
    live: Mutex<HashMap<String, Live>>,
    generation: AtomicU64,
    pub(super) extras: Mutex<HashMap<String, Extra>>,
    door: Mutex<Door>,
    rounds: OnceLock<Box<dyn Rounds>>,
    pub(super) recovering: Mutex<Vec<String>>,
    pub(super) listeners: Mutex<Vec<super::news::Listener>>,
    /// Held while a direct talk finds or hires its session.
    pub talking: Mutex<()>,
    pub(super) workspaces: Mutex<HashMap<String, super::workspace::WorkspaceState>>,
}

impl Sessions {
    pub fn new(
        durable: vibevalley_runtime::agent::durable::Store,
        ledger: Arc<Ledger>,
        drivers: Arc<dyn Drivers>,
        workplaces: Arc<Workplace>,
        config: Arc<BoardConfig>,
        hub: Option<Weak<Hub>>,
    ) -> Result<Sessions> {
        let extras = ledger.database(super::db::extras)?;
        Ok(Sessions(Arc::new(Inner {
            durable,
            ledger,
            drivers,
            workplaces,
            config,
            hub,
            live: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            extras: Mutex::new(extras),
            door: Mutex::new(Door::default()),
            rounds: OnceLock::new(),
            listeners: Mutex::new(Vec::new()),
            recovering: Default::default(),
            talking: Mutex::new(()),
            workspaces: Mutex::new(HashMap::new()),
        })))
    }

    /// Who hears rounds end; set once.
    pub fn on_rounds(&self, rounds: Box<dyn Rounds>) {
        let _ = self.0.rounds.set(rounds);
    }

    /// The agents this process drives stop; their rounds are recorded as
    /// interrupted when the board opens next.
    pub fn close(&self) {
        let live: Vec<Live> = self.0.live.lock().drain().map(|(_, l)| l).collect();
        for l in live {
            l.agent.dispose();
        }
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        self.0.ledger.session(id)
    }

    /// Whether this process drives the session now.
    pub fn is_live(&self, session: &str) -> bool {
        self.0.live.lock().contains_key(session)
    }

    pub(super) fn live_agent(&self, session: &str) -> Option<Arc<dyn vibevalley_runtime::oar::Session>> {
        self.0.live.lock().get(session).map(|l| l.agent.clone())
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
        self.0.door.lock().url = Some(url);
        let ids = std::mem::take(&mut *self.0.recovering.lock());
        for id in ids {
            if let Err(e) = self.restore_generation(&id) {
                eprintln!("vibevalley: restoring {id}: {e}");
                self.0.recovering.lock().push(id);
            }
        }
    }

    /// The helper a bearer token names.
    pub fn who(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        self.0.door.lock().tokens.get(token).cloned()
    }

    /// Mints (or reuses) the per-session MCP bearer token so remote sessions can
    /// authenticate over the WS MCP reverse tunnel even without a local HTTP MCP URL.
    pub(super) fn mcp_token_for(&self, session: &str) -> String {
        let mut door = self.0.door.lock();
        match door.tokens.iter().find(|(_, s)| s.as_str() == session) {
            Some((t, _)) => t.clone(),
            None => {
                let t = uuid::Uuid::new_v4().simple().to_string();
                door.tokens.insert(t.clone(), session.to_string());
                t
            }
        }
    }

    /// The helper's door entry, minting its token once.
    pub(super) fn door_for(&self, session: &str) -> Option<McpServer> {
        let url = self.0.door.lock().url.clone()?;
        let token = self.mcp_token_for(session);
        Some(McpServer::Http {
            name: "vibevalley".into(),
            url,
            headers: vec![("authorization".into(), format!("Bearer {token}"))],
        })
    }

    pub(super) fn extra(&self, session: &str) -> Extra {
        self.0.extras.lock().get(session).cloned().unwrap_or_default()
    }

    pub(super) fn set_extra(&self, session: &str, change: impl FnOnce(&mut Extra)) -> Result<()> {
        let mut extras = self.0.extras.lock();
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
        let policy = match h.issue.repo.clone() {
            Some(repo) => vibevalley_protocol::ExecutionPolicy::ManagedWorktree { repo, branch: h.branch },
            None => vibevalley_protocol::ExecutionPolicy::SandboxDir,
        };
        let mut session = Session::new(
            &id,
            vibevalley_protocol::SessionController::IssueBoard,
            h.name,
            h.drive.runtime_id.clone(),
            policy,
            now(),
        );
        session.profile = (!h.drive.agent.is_empty()).then(|| h.drive.agent.clone());
        session.machine = (!h.drive.is_local).then(|| h.drive.machine_id.clone());
        session.brief = h.brief;
        self.0.extras.lock().entry(id.clone()).or_default().base = h.base;
        session.cwd = (!h.cwd.as_os_str().is_empty()).then(|| h.cwd.to_string_lossy().into_owned());
        session.attach_binding(vibevalley_protocol::ContextRef::Issue {
            id: h.issue.id.clone(),
            refining: h.drafting.then_some(true),
        });
        let started = self.start(h.drive, session, h.issue, h.prompt, false, h.trigger);
        if started.is_err() {
            self.0.extras.lock().remove(&id);
        }
        started
    }

    /// Opens the agent for `session`, puts it on the board and sends the
    /// first prompt. `resume` reopens the runtime's own session.
    fn start(&self, drive: Drive, mut session: Session, issue: &Issue, prompt: String, resume: bool, trigger: RunTrigger) -> Result<String> {
        let _ = std::fs::remove_file(self.report_path(&session.id));
        let is_remote = !drive.is_local;
        let (agent, prompt) = self.open_for(drive, &session, issue, prompt, resume)?;
        session.phase = Phase::working(now(), SessionAction::Thinking, "");
        let started = IssueChange::Started {
            session: session.id.clone(),
            worker: !session.is_refining(),
        };
        self.go_live(agent.clone(), session.clone(), Some((issue.id.as_str(), started)))?;
        let run = self.begin_run(&session.id, &issue.id, trigger)?;
        let prompt = self.with_recall(&session, prompt);
        self.record(&session.id, Step::Asked { text: prompt.clone() });
        if let Err(e) = Self::prompt_run(&*agent, is_remote, &run, &prompt) {
            let _ = self.dismiss(&session.id, Leave::Keep);
            return Err(e.into());
        }
        Ok(session.id)
    }

    fn prompt_run(agent: &dyn vibevalley_runtime::oar::Session, is_remote: bool, run: &str, prompt: &str) -> vibevalley_runtime::oar::Result<()> {
        if !is_remote && agent.runtime_id() != vibevalley_runtime::agent::runtime::ID {
            return agent.prompt(text(prompt));
        }
        let key = format!("work:{run}");
        let outcome = agent.control(vibevalley_runtime::oar::ControlAction::Prompt, prompt, &key, &key)?;
        if outcome.status != vibevalley_runtime::oar::ControlStatus::Accepted {
            return Err(vibevalley_runtime::oar::AgentError::Rejected(format!("{}: {}", outcome.code, outcome.reason)));
        }
        Ok(())
    }
    pub(crate) fn recover_on_connect(&self, ids: Vec<String>) {
        self.0.recovering.lock().extend(ids);
    }

    fn restore_generation(&self, id: &str) -> Result<()> {
        let session = self.session(id).ok_or_else(|| BoardError::Other(format!("missing session {id}")))?;
        let issue = session
            .issue_id()
            .and_then(|i| self.0.ledger.issue(i))
            .ok_or_else(|| BoardError::Other(format!("missing issue for {id}")))?;
        let extra = self.extra(id);
        let run = extra.run.ok_or_else(|| BoardError::Other(format!("missing open run for {id}")))?;
        let vendor = extra.agent_session.ok_or_else(|| BoardError::Other(format!("missing driver id for {id}")))?;
        let conv = vibevalley_runtime::agent::harness::worker_conversation(&vendor);
        let sub = self
            .0
            .durable
            .read(|tx| tx.submission_by_request(&conv, &format!("work:{run}")))?
            .ok_or_else(|| BoardError::Other(format!("missing generation for {run}")))?;
        let task = self.0.durable.read(|tx| tx.task(&format!("gen-{}", sub.id)))?;
        let is_remote = session.machine.is_some();
        let drive = self.0.drivers.drive(session.profile_id(), &issue)?;
        let (agent, _) = self.open_for(drive, &session, &issue, String::new(), true)?;
        self.go_live(agent.clone(), session, None)?;
        if task.status == vibevalley_runtime::agent::durable::TaskStatus::Terminal {
            Self::prompt_run(&*agent, is_remote, &run, sub.payload["text"].as_str().unwrap_or_default())?;
        }
        Ok(())
    }

    fn open_for(
        &self,
        drive: Drive,
        session: &Session,
        issue: &Issue,
        prompt: String,
        resume: bool,
    ) -> Result<(Arc<dyn vibevalley_runtime::oar::Session>, String)> {
        let cwd = PathBuf::from(session.cwd.clone().unwrap_or_default());
        let instructions = if session.is_refining() {
            "You are drafting an issue for VibeValley's board. Do not change or commit files.".to_string()
        } else {
            let place = HelperPlace {
                repo: session.repo_name().unwrap_or("").to_string(),
                branch: session.worktree_branch().map(String::from),
                cwd: session.cwd.clone().unwrap_or_default(),
                id: session.id.clone(),
                pull_request: issue.deliver == Deliverable::PullRequest || !drive.is_local,
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
        let mut env = drive.env.clone();
        if !drive.is_local {
            let repo_ref = issue
                .repo
                .as_deref()
                .map(|r| self.0.workplaces.repo_remote_url(r).unwrap_or_else(|| r.to_string()));
            let branch = session.worktree_branch().map(String::from);
            let base_ref = self.extra(&session.id).base;
            let meta = crate::modules::infra::machine::RemoteDispatchMeta {
                session_id: Some(session.id.clone()),
                repo_ref,
                branch,
                base_ref,
                mcp_session_token: Some(self.mcp_token_for(&session.id)),
            };
            crate::modules::infra::machine::attach_dispatch_meta(&mut env, &meta);
        }
        let opts = SessionOptions {
            cwd,
            model: drive.model.clone(),
            resume: if resume { self.extra(&session.id).agent_session } else { None },
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
        Ok((drive.runtime.open(opts)?, prompt))
    }

    /// `session` on the board, driven by `agent` from now on: its events
    /// pumped into facts. The issue it works changes in the same commit.
    pub(super) fn go_live(&self, agent: Arc<dyn vibevalley_runtime::oar::Session>, session: Session, issue: Option<(&str, IssueChange)>) -> Result<()> {
        let events = agent.events_with_history();
        let extra = {
            let mut extras = self.0.extras.lock();
            let entry = extras.entry(session.id.clone()).or_default();
            entry.agent_session = agent.resume_id();
            entry.clone()
        };
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.live.lock().insert(
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
        // Persist extra columns after the `session` row exists in SQLite.
        self.0.ledger.database(|db| super::db::put_extra(db, &id, &extra))?;
        let hub = self.0.hub.as_ref().and_then(Weak::upgrade);
        if let Some(before) = previous {
            let me = self.clone();
            let session_id = id.clone();
            let reconcile = move || {
                let mut after = before.clone();
                let changed = super::subagents::read_back(&mut after, |thread, turn| agent.read_subagent(thread, turn), now);
                if changed
                    && me.current(&session_id, generation)
                    && let Err(err) = me.0.ledger.reconcile_subagents(&session_id, &before, after)
                {
                    eprintln!("could not reconcile subagents for {session_id}: {err}");
                }
            };
            if let Some(hub) = &hub {
                hub.spawn_blocking_task(reconcile);
            } else {
                crate::spawn_blocking_traced(reconcile);
            }
        }
        let me = self.clone();
        let cancel = hub.as_ref().map(|h| h.child_token()).unwrap_or_default();
        let pump = async move {
            me.pump_async(id, generation, events, cancel).await;
        };
        if let Some(hub) = &hub {
            hub.spawn_task(pump);
        } else {
            vibevalley_runtime::rt::current_or_global_handle().spawn(pump.in_current_span().with_current_subscriber());
        }
        Ok(())
    }

    /// `withRecall`: what the agent remembers, set apart before the input.
    pub(super) fn with_recall(&self, session: &Session, input: String) -> String {
        let Some(profile) = session.profile_id() else { return input };
        let block = self.0.drivers.recall(profile, &session.id, session.repo_name().unwrap_or(""), &input);
        if block.is_empty() { input } else { format!("{block}\n\n---\n\n{input}") }
    }

    /// The next round for a session on the board: its agent if this process
    /// still drives it, else reopened (resumed when the runtime can, else
    /// told `again`).
    pub fn next_round(&self, issue: &Issue, session: &Session, words: String, again: impl FnOnce(&str) -> String, trigger: RunTrigger) -> Result<String> {
        let agent = self.0.live.lock().get(&session.id).map(|l| l.agent.clone());
        match agent {
            Some(agent) => {
                let _ = std::fs::remove_file(self.report_path(&session.id));
                // Working from now, not from when the pump reads the turn's
                // start: the room is counted by it. Apply `Answered` atomically
                // so an `Asking` issue never flickers through `InReview`.
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                self.0.ledger.change_with(&issue.id, IssueChange::Answered, |fact| {
                    vec![self.phase_changed(session.id.clone(), phase), fact]
                })?;
                let run = self.begin_run(&session.id, &issue.id, trigger)?;
                let words = self.with_recall(session, words);
                self.record(&session.id, Step::Asked { text: words.clone() });
                Self::prompt_run(&*agent, session.machine.is_some(), &run, &words)?;
                self.0.ledger.change(&issue.id, IssueChange::Unqueued)?;
                Ok(session.id.clone())
            }
            None => {
                let drive = self.0.drivers.drive(session.profile_id().filter(|a| !a.is_empty()), issue)?;
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
        let agent = self.0.live.lock().get(&session.id).map(|l| l.agent.clone())?;
        self.record(&session.id, Step::Asked { text: words.to_string() });
        Some(match agent.steer(text(words)) {
            Ok(()) => Ok(()),
            Err(_) => agent.queue(text(words)).map_err(BoardError::from),
        })
    }

    /// Stops the running turn of `session`.
    pub fn stop(&self, session: &str) -> Result<()> {
        let agent = self.0.live.lock().get(session).map(|l| l.agent.clone());
        let agent = agent.ok_or_else(|| BoardError::Other("nothing is running".into()))?;
        agent.abort()?;
        Ok(())
    }

    /// Attaches a context reference to an existing session.
    pub fn attach_binding(&self, input: vibevalley_protocol::SessionBindingInput) -> Result<Session> {
        let mut session = self.session(&input.id).ok_or_else(|| {
            BoardError::Api(crate::base::missing(
                vibevalley_i18n::t("server.helperRef", &[("id", input.id.clone().into())]),
                crate::base::LookIn::Session,
            ))
        })?;
        if session.attach_binding(input.binding) {
            self.0.ledger.apply(vec![Fact::session_changed(now(), session.clone())])?;
        }
        Ok(self.session(&session.id).unwrap_or(session))
    }

    /// Detaches a context reference from an existing session.
    pub fn detach_binding(&self, input: vibevalley_protocol::SessionBindingInput) -> Result<Session> {
        let mut session = self.session(&input.id).ok_or_else(|| {
            BoardError::Api(crate::base::missing(
                vibevalley_i18n::t("server.helperRef", &[("id", input.id.clone().into())]),
                crate::base::LookIn::Session,
            ))
        })?;
        if session.detach_binding(&input.binding) {
            self.0.ledger.apply(vec![Fact::session_changed(now(), session.clone())])?;
        }
        Ok(self.session(&session.id).unwrap_or(session))
    }

    /// Lets a session go: its agent stops, its open round ends, its
    /// workplace is left as `leave` says, and it leaves the board.
    pub fn dismiss(&self, session_id: &str, leave: Leave) -> Result<()> {
        let live = self.0.live.lock().remove(session_id);
        if let Some(live) = live {
            let _ = live.agent.abort();
            live.agent.dispose();
        }
        let session = self.session(session_id);
        if session.as_ref().is_some_and(|s| s.phase.is_working()) {
            self.end_run(session_id, Outcome::Interrupted, "", None)?;
        }
        if let Some(s) = &session
            && s.machine.is_none()
            && let (Some(repo), Some(worktree), Some(branch)) = (s.repo_name(), s.cwd.as_deref(), s.worktree_branch())
        {
            let leaving = Leaving {
                repo,
                worktree,
                branch,
                base: self.extra(&s.id).base,
                name: &s.name,
                drafting: s.is_refining(),
            };
            self.0.workplaces.release(&leaving, leave)?;
        }
        let _ = std::fs::remove_file(self.report_path(session_id));
        self.0.door.lock().tokens.retain(|_, s| s != session_id);
        if session.is_some() {
            self.0.ledger.apply(vec![Fact::session_left(now(), session_id, None)])?;
        }
        self.0.extras.lock().remove(session_id);
        self.0.ledger.database(|db| super::db::remove_extra(db, session_id))?;
        self.remove_workspace_meta(session_id);
        Ok(())
    }

    fn current(&self, session: &str, generation: u64) -> bool {
        self.0.live.lock().get(session).is_some_and(|l| l.generation == generation)
    }

    /// Turns the agent's events into facts until the session ends or leaves,
    /// without pinning an OS thread while idle between agent events.
    async fn pump_async(&self, session_id: String, generation: u64, events: flume::Receiver<vibevalley_runtime::oar::Event>, cancel: CancellationToken) {
        let span = tracing::debug_span!("session.pump", session_id = %session_id, generation);
        async move {
            let quiet_after = self.0.config.quiet_after;
            let tick = quiet_after.min(Duration::from_secs(5)).max(Duration::from_millis(20));
            let mut last_event = tokio::time::Instant::now();
            let mut state = PumpState::default();
            loop {
                let event = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    res = tokio::time::timeout(tick, events.recv_async()) => match res {
                        Ok(Ok(event)) => event,
                        Ok(Err(flume::RecvError::Disconnected)) => break,
                        Err(_) => {
                            if !self.current(&session_id, generation) {
                                return;
                            }
                            if last_event.elapsed() >= quiet_after {
                                let me = self.clone();
                                let sid = session_id.clone();
                                let _ = crate::spawn_blocking_traced(move || me.set_quiet(&sid, Some(now()))).await;
                            }
                            continue;
                        }
                    },
                };
                if cancel.is_cancelled() || !self.current(&session_id, generation) {
                    return;
                }
                last_event = tokio::time::Instant::now();
                let me = self.clone();
                let sid = session_id.clone();
                let Ok((next_state, ended)) = crate::spawn_blocking_traced(move || {
                    let ended = me.handle_pump_event(&sid, generation, event, &mut state);
                    (state, ended)
                })
                .await
                else {
                    return;
                };
                state = next_state;
                if ended {
                    break;
                }
            }
            if cancel.is_cancelled() {
                return;
            }
            let me = self.clone();
            let _ = crate::spawn_blocking_traced(move || {
                let mut live = me.0.live.lock();
                let was_current = live.get(&session_id).is_some_and(|l| l.generation == generation);
                if was_current {
                    live.remove(&session_id);
                }
                drop(live);
                if was_current {
                    me.on_workspace_pump_exited(&session_id);
                }
            })
            .await;
        }
        .instrument(span)
        .await
    }

    fn handle_pump_event(&self, session_id: &str, generation: u64, event: vibevalley_runtime::oar::Event, state: &mut PumpState) -> bool {
        if !self.current(session_id, generation) {
            return true;
        }
        self.set_quiet(session_id, None);
        let root = event.agent_path.is_empty();
        if root && matches!(event.kind, EventKind::TurnStarted { .. }) {
            state.observed_run = self.extra(session_id).run;
        }
        if let Some(run) = state.observed_run.as_deref()
            && super::subagents::relevant(&event)
            && let Err(error) = self.observe_subagents(session_id, generation, run, &event)
        {
            eprintln!("could not record subagent progress for {session_id}: {error}");
        }
        self.record(session_id, Step::Agent(event.clone()));
        match event.kind {
            EventKind::SessionStarted { session_id: vendor, model } if root => {
                let _ = self.set_extra(session_id, |e| e.agent_session = Some(vendor));
                self.on_workspace_session_started(session_id, model);
            }
            EventKind::TurnStarted { .. } if root => {
                state.said.clear();
                state.asked.clear();
                state.failure = None;
                let phase = Phase::working(now(), SessionAction::Thinking, "");
                let _ = self.0.ledger.apply(vec![self.phase_changed(session_id, phase)]);
            }
            EventKind::TextDelta { text } if root => state.said.push_str(&text),
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
                state.asked.push(Question {
                    question: text,
                    options: vec![],
                });
            }
            EventKind::PermissionRequested {
                request_id,
                tool,
                input,
                summary,
            } => {
                if self
                    .session(session_id)
                    .is_some_and(|s| s.controller == vibevalley_protocol::SessionController::User)
                {
                    self.on_workspace_permission_requested(session_id, request_id, tool, input, summary);
                } else if self.0.config.permission == PermissionMode::Bypass {
                    let agent = self.0.live.lock().get(session_id).map(|l| l.agent.clone());
                    if let Some(agent) = agent {
                        let _ = agent.respond_permission(&request_id, PermissionDecision::AllowOnce);
                    }
                }
            }
            EventKind::PermissionResolved { request_id, .. } => {
                self.on_workspace_permission_resolved(session_id, &request_id);
            }
            EventKind::InteractionRequested {
                request_id,
                question,
                options,
                allow_custom,
            } => {
                if self
                    .session(session_id)
                    .is_some_and(|s| s.controller == vibevalley_protocol::SessionController::User)
                {
                    self.on_workspace_interaction_requested(session_id, request_id, question, options, allow_custom);
                } else if root {
                    state.asked.push(Question {
                        question,
                        options: options.into_iter().map(|o| o.label).collect(),
                    });
                }
            }
            EventKind::InteractionResolved { request_id, .. } => {
                self.on_workspace_interaction_resolved(session_id, &request_id);
            }
            EventKind::Error { message } if root => state.failure = Some(message),
            EventKind::TurnFinished { reason, usage } if root => {
                state.observed_run = None;
                let is_user = self
                    .session(session_id)
                    .is_some_and(|s| s.controller == vibevalley_protocol::SessionController::User);
                if is_user {
                    self.on_workspace_turn_finished(session_id, &usage);
                }
                self.finish(session_id, reason, reported_spent(&usage), &state.said, &state.asked, state.failure.as_deref());
                if !is_user && let Some(rounds) = self.0.rounds.get() {
                    rounds.after();
                }
            }
            EventKind::SessionEnded => return true,
            _ => {}
        }
        false
    }

    fn observe_subagents(&self, session_id: &str, generation: u64, run: &str, event: &vibevalley_runtime::oar::Event) -> Result<()> {
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
        let channel = self.session(&id).and_then(|s| s.channel_id().map(str::to_string));
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
        if session.is_refining()
            || run.outcome.is_some()
            || session.runtime != vibevalley_runtime::agent::runtime::ID
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
        if session.controller == vibevalley_protocol::SessionController::User && !session.is_board_worker() {
            self.finish_workspace(&session, reason, spent, said, failure);
            return;
        }
        if session.is_direct_talker() && session.issue_id().is_none() {
            self.finish_talk(&session, reason, said, spent);
            return;
        }
        let Some(issue) = session.issue_id().and_then(|i| self.0.ledger.issue(i)) else {
            if session.controller == vibevalley_protocol::SessionController::User {
                self.finish_workspace(&session, reason, spent, said, failure);
            }
            return;
        };
        if session.is_refining() {
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
            if let Some(extra) = self.0.extras.lock().get_mut(session_id)
                && extra.run.as_ref() == Some(&id)
            {
                extra.run = None;
            }
            self.record(session_id, Step::RunEnded { run: id, outcome });
        }
        if let Some(r) = report.as_ref().filter(|r| !r.remember.is_empty())
            && let Some(agent) = session.profile.clone()
            && let Some(hub) = self.0.hub.as_ref().and_then(Weak::upgrade)
        {
            let repo_name = session.repo_name().unwrap_or_default().to_string();
            let ctx = CallerContext {
                caller: Caller::Session,
                principal: CallerPrincipal::LocalOwner,
                client: Some(ClientIdentity {
                    id: session_id.to_string(),
                    kind: ClientKind::Internal,
                    label: session_id.to_string(),
                }),
                trace_id: 0,
            };
            for m in &r.remember {
                let repo = match m.scope {
                    IssueReportMemoryScope::Repo => (!repo_name.is_empty()).then(|| repo_name.clone()),
                    IssueReportMemoryScope::All => None,
                };
                if let Err(e) = hub.invoke::<ops::MemoryCreate>(
                    &ctx,
                    MemoryCreateInput {
                        agent: agent.clone(),
                        text: m.text.clone(),
                        repo,
                        request_key: None,
                    },
                ) {
                    eprintln!("memory: {session_id}'s report note was not kept: {}", e.message);
                }
            }
        }
    }
}

#[derive(Default)]
struct PumpState {
    observed_run: Option<String>,
    said: String,
    asked: Vec<Question>,
    failure: Option<String>,
}

fn reported_spent(usage: &vibevalley_runtime::oar::Usage) -> Option<Spent> {
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

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;
    use tracing::instrument::WithSubscriber as _;
    use vibevalley_core::Applied;
    use vibevalley_protocol::{ExecutionPolicy, Fact, Phase, Session, SessionAction, SessionController, SliceBundle, SpaceState};
    use vibevalley_runtime::oar::{
        Capabilities, ContentBlock, ControlAction, ControlOutcome, ControlStatus, Event, EventKind, Installation, ModelInfo, PermissionDecision, Registry,
        Runtime, Session as OarSession, SessionOptions, SessionStatus, voyage,
    };

    use super::Sessions;
    use crate::Hub;
    use crate::modules::work::ledger::{BoardConfig, Facts, IssueStore, Ledger, LocalFacts, now};
    use crate::modules::work::session::RuntimeDrivers;
    use crate::modules::work::workplace::Workplace;

    #[derive(Clone, Default)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    struct BufWriter(Arc<Mutex<Vec<u8>>>);

    impl io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedBuf {
        type Writer = BufWriter;

        fn make_writer(&'a self) -> Self::Writer {
            BufWriter(self.0.clone())
        }
    }

    struct QuietTrackingFacts {
        inner: LocalFacts,
        quiet_spans: Mutex<Vec<(Option<&'static str>, bool)>>,
        quiet_set: Arc<tokio::sync::Notify>,
        quiet_cleared: Arc<tokio::sync::Notify>,
    }

    impl QuietTrackingFacts {
        fn new() -> Self {
            Self {
                inner: LocalFacts::default(),
                quiet_spans: Mutex::new(Vec::new()),
                quiet_set: Arc::new(tokio::sync::Notify::new()),
                quiet_cleared: Arc::new(tokio::sync::Notify::new()),
            }
        }
    }

    impl Facts for QuietTrackingFacts {
        fn apply(&self, facts: Vec<Fact>) -> Applied {
            let quiet_events: Vec<(Option<&'static str>, bool)> = facts
                .iter()
                .filter_map(|fact| match fact {
                    Fact::SessionPhaseChanged(changed) => match &changed.phase {
                        Phase::Working(working) => {
                            let current = tracing::Span::current();
                            let span_name = current.metadata().map(|m| m.name());
                            let is_quiet = working.quiet_since.is_some();
                            tracing::debug!(is_quiet, "sessions.test.facts_apply");
                            Some((span_name, is_quiet))
                        }
                        _ => None,
                    },
                    _ => None,
                })
                .collect();
            let applied = self.inner.apply(facts);
            if !quiet_events.is_empty() {
                self.quiet_spans.lock().extend(quiet_events.iter().copied());
                for (_, is_quiet) in quiet_events {
                    if is_quiet {
                        self.quiet_set.notify_one();
                    } else {
                        self.quiet_cleared.notify_one();
                    }
                }
            }
            applied
        }

        fn read(&self, f: &mut dyn FnMut(&SpaceState)) {
            self.inner.read(f);
        }

        fn bundle(&self) -> SliceBundle {
            self.inner.bundle()
        }
    }

    struct StubSession {
        id: String,
        tx: flume::Sender<Event>,
        rx: flume::Receiver<Event>,
    }

    impl OarSession for StubSession {
        fn id(&self) -> String {
            self.id.clone()
        }

        fn control(&self, action: ControlAction, _: &str, input_id: &str, span_id: &str) -> vibevalley_runtime::oar::Result<ControlOutcome> {
            Ok(ControlOutcome {
                action,
                status: ControlStatus::Accepted,
                code: String::new(),
                reason: String::new(),
                span_id: span_id.into(),
                input_id: input_id.into(),
            })
        }

        fn records(&self) -> Vec<voyage::Record> {
            vec![]
        }

        fn subscribe_records(&self, _: Option<u64>) -> flume::Receiver<voyage::Record> {
            let (_tx, rx) = flume::bounded(1);
            rx
        }

        fn runtime_id(&self) -> &str {
            "stub"
        }

        fn status(&self) -> SessionStatus {
            SessionStatus::Idle
        }

        fn events(&self) -> flume::Receiver<Event> {
            self.rx.clone()
        }

        fn prompt(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn steer(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn queue(&self, _: Vec<ContentBlock>) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn abort(&self) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn respond_permission(&self, _: &str, _: PermissionDecision) -> vibevalley_runtime::oar::Result<()> {
            Ok(())
        }

        fn dispose(&self) {
            let _ = self.tx.try_send(Event {
                seq: 0,
                at_ms: 0,
                agent_path: vec![],
                kind: EventKind::SessionEnded,
            });
        }
    }

    struct StubRuntime;

    impl Runtime for StubRuntime {
        fn id(&self) -> &str {
            "stub"
        }

        fn display_name(&self) -> &str {
            "Stub"
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }

        fn installation(&self) -> Installation {
            Installation::Available {
                version: None,
                path: std::path::PathBuf::from("/bin/true"),
            }
        }

        fn list_models(&self) -> vibevalley_runtime::oar::Result<Vec<ModelInfo>> {
            Ok(vec![])
        }

        fn open(&self, _: SessionOptions) -> vibevalley_runtime::oar::Result<Arc<dyn OarSession>> {
            let (tx, rx) = flume::unbounded();
            Ok(Arc::new(StubSession { id: "stub-1".into(), tx, rx }))
        }
    }

    struct NoopIssueStore;

    impl IssueStore for NoopIssueStore {
        fn all(&self, _db: &vibevalley_runtime::agent::durable::Sqlite<'_>) -> sqlx::Result<Vec<vibevalley_protocol::Issue>> {
            Ok(vec![])
        }

        fn put(&self, _db: &vibevalley_runtime::agent::durable::Sqlite<'_>, _issue: &vibevalley_protocol::Issue) -> sqlx::Result<()> {
            Ok(())
        }

        fn remove(&self, _db: &vibevalley_runtime::agent::durable::Sqlite<'_>, _id: &str) -> sqlx::Result<()> {
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pump_async_quiet_timer_uses_virtual_clock_and_propagates_session_pump_span() {
        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_ansi(false)
            .with_writer(buf.clone())
            .finish();

        async {
            let dir = tempfile::tempdir().unwrap();
            let db = crate::base::ServerDb::open(dir.path()).unwrap();
            let facts = Arc::new(QuietTrackingFacts::new());
            let (ledger, _) = Ledger::open(
                db.clone(),
                facts.clone(),
                Arc::new(NoopIssueStore),
                Arc::new(super::super::db::SqliteSessionStore),
            )
            .unwrap();
            let durable = db.durable().unwrap();
            let mut cfg = BoardConfig::under(dir.path());
            cfg.quiet_after = Duration::from_secs(300);
            let config = Arc::new(cfg);
            let workplaces = Arc::new(Workplace::new(config.worktrees_dir.clone(), config.repos_dir.clone(), config.data_dir.clone()));
            let mut registry = Registry::new();
            registry.register(Arc::new(StubRuntime));
            let drivers = Arc::new(RuntimeDrivers {
                registry: Arc::new(registry),
                model: None,
            });
            let hub = Hub::new(vibevalley_core::empty_space_state());
            let sessions = Sessions::new(durable, Arc::new(ledger), drivers, workplaces, config, Some(Arc::downgrade(&hub))).unwrap();

            let (tx, rx) = flume::unbounded();
            let agent = Arc::new(StubSession {
                id: "stub-quiet".into(),
                tx: tx.clone(),
                rx,
            });
            let mut session = Session::new(
                "w-quiet",
                SessionController::IssueBoard,
                "Quiet test",
                "stub",
                ExecutionPolicy::SandboxDir,
                now(),
            );
            session.phase = Phase::working(now(), SessionAction::Thinking, "");

            let wall_start = std::time::Instant::now();
            sessions.go_live(agent, session, None).unwrap();
            tokio::task::yield_now().await;

            // Advance 290 virtual seconds (< 300s): session must not be marked quiet yet.
            tokio::time::advance(Duration::from_secs(290)).await;
            tokio::task::yield_now().await;
            assert!(
                matches!(sessions.session("w-quiet").unwrap().phase, Phase::Working(ref w) if w.quiet_since.is_none()),
                "session must not be quiet before quiet_after elapses"
            );

            // Advance past 300 virtual seconds: quiet timer fires via spawn_blocking_traced under session.pump span.
            tokio::time::advance(Duration::from_secs(15)).await;
            facts.quiet_set.notified().await;
            assert!(
                matches!(sessions.session("w-quiet").unwrap().phase, Phase::Working(ref w) if w.quiet_since.is_some()),
                "session must become quiet once virtual quiet_after elapses"
            );
            assert!(
                wall_start.elapsed() < Duration::from_secs(2),
                "5 virtual minutes must elapse instantaneously, took {:?}",
                wall_start.elapsed()
            );

            // Delivering a new event clears quiet_since via spawn_blocking_traced under the same session.pump span.
            tx.send(Event {
                seq: 1,
                at_ms: now() as u64,
                agent_path: vec![],
                kind: EventKind::TextDelta { text: "progress".into() },
            })
            .unwrap();
            facts.quiet_cleared.notified().await;
            assert!(
                matches!(sessions.session("w-quiet").unwrap().phase, Phase::Working(ref w) if w.quiet_since.is_none()),
                "event arrival must clear quiet_since"
            );

            let recorded = facts.quiet_spans.lock().clone();
            assert_eq!(recorded, vec![(Some("session.pump"), true), (Some("session.pump"), false)]);

            hub.close_async().await;

            let logs = String::from_utf8(buf.0.lock().clone()).unwrap();
            assert!(
                logs.contains("session.pump{session_id=w-quiet generation=1}")
                    && logs.contains("sessions.test.facts_apply is_quiet=true")
                    && logs.contains("sessions.test.facts_apply is_quiet=false"),
                "expected session.pump span around blocking facts_apply:\n{logs}"
            );
        }
        .with_subscriber(subscriber)
        .await;
    }
}
