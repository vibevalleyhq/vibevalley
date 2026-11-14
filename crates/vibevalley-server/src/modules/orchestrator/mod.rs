//! The orchestrator (VibeValley `modules/orchestrator/orchestrator.ts`): one
//! assistant per orchestrator profile, each a durable conversation on
//! `vibevalley-agent` (`<home>/agent/<id>/conversation.jsonl`) holding the farm's
//! tools. The watch hands it what the chat says to it; crons for no profile
//! come to it too. Before each input it is shown the time and the farm
//! (`situation`), or what changed since; its words are said in the place it
//! answers.
//!
//! Inputs that come while it works wait and go in together as the next
//! turn (VibeValley steers the user's words into the turn under way; the
//! brain has no steering).

pub mod words;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};

use vibevalley_agent::{Brain, BrainEvent, Conversation, Entry, Message, ModelClient, OpenAiClient, Tool, TurnOutcome, kit};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    AgentRole, ApiError, BizCode, Doing, Fact, FactSessionChanged, FactSessionPhaseChanged, NoticeLevel, ORCHESTRATOR_RUNTIME, OrchestratorEval, Outcome,
    Phase, PhaseResting, PhaseWorking, Session, SessionAction, SessionEventType, ops,
};

use self::words::Source;
use crate::Hub;
use crate::base::{LookIn, missing, refused};
use crate::modules::channel::{Picked, Posting};
use crate::modules::ledger::Step;
use crate::modules::session::Trajectories;
use crate::modules::tool::{Farm, Route, held};
use crate::{lock, now};

const DEFAULT_MODEL: &str = "deepseek-flash";
/// `quotaLow`: a runtime with less left than this is nearly used up.
const QUOTA_LOW: f64 = 15.0;
const SKILLS: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/assets/orchestrator/skills");

/// One input to an orchestrator (`Handed`).
#[derive(Debug, Clone)]
pub struct Input {
    /// The orchestrator it is for; none is the place's.
    pub agent: Option<String>,
    /// The place it came from, where the answer goes.
    pub channel: String,
    pub source: Source,
    /// The input's words, after the source's head.
    pub line: String,
    pub user: bool,
    pub picked: Option<Picked>,
    /// The messages it carries.
    pub messages: Vec<String>,
    /// The live answer waiting for this turn's words (`Orchestrator::answer`, `brief`).
    pub port: Option<String>,
}

/// A live answer (VibeValley `response.ts`): the turn's words as they are
/// said, ending with the turn. Dropped, it stops waiting.
pub struct Reply {
    id: String,
    words: flume::Receiver<String>,
    orchestrator: Weak<Orchestrator>,
}

impl Reply {
    /// The next words, none once the turn is over or nothing came in `wait`.
    pub fn next(&self, wait: std::time::Duration) -> Option<String> {
        self.words.recv_timeout(wait).ok()
    }

    /// Everything said until the turn ends, or what came within `wait` of each other.
    pub fn whole(&self, wait: std::time::Duration) -> String {
        let mut said = vec![];
        while let Some(words) = self.next(wait) {
            said.push(words);
        }
        said.join("\n").trim().to_string()
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        if let Some(o) = self.orchestrator.upgrade() {
            lock(&o.ports).remove(&self.id);
        }
    }
}

/// Messages heard but not woken for: shown with the next input (`digest`).
#[derive(Default)]
struct Waiting {
    lines: Vec<String>,
}

struct Instance {
    id: String,
    queue: Mutex<VecDeque<Input>>,
    more: Condvar,
    route: Arc<Mutex<Route>>,
    abort: Mutex<Option<Arc<AtomicBool>>>,
    /// The situation it was last shown whole; "" shows it whole again.
    shown: Mutex<String>,
    /// What it last said it cannot start for, per place.
    cannot: Mutex<HashMap<String, String>>,
    news: Mutex<Waiting>,
}

pub struct Orchestrator {
    hub: Weak<Hub>,
    farm: Arc<Farm>,
    home: PathBuf,
    trajectories: Arc<Trajectories>,
    key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    client: Option<Arc<dyn ModelClient>>,
    instances: Mutex<HashMap<String, Arc<Instance>>>,
    /// The live answers not yet taken by a turn.
    ports: Mutex<HashMap<String, flume::Sender<String>>>,
    closed: AtomicBool,
}

/// One turn the user marked wrong (`<home>/evals/<id>.json`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalCase {
    id: String,
    created_at: i64,
    model: String,
    want: String,
    memory: String,
    tools: Vec<String>,
    before: Vec<Message>,
    input: String,
    did: Vec<Message>,
    expect: Vec<String>,
}

/// What the model had in front of it before a turn: the last summary, then every message since.
fn told_before(entries: &[Entry]) -> Vec<Message> {
    let from = entries.iter().rposition(|e| matches!(e, Entry::Compacted { .. })).unwrap_or(0);
    entries[from..]
        .iter()
        .filter_map(|e| match e {
            Entry::Compacted { summary } => Some(Message::system(summary.clone())),
            Entry::Message { message, .. } => Some(message.clone()),
            Entry::TurnStarted { input } => Some(Message::user(input.clone())),
            Entry::ToolStarted { .. } | Entry::TurnFinished { .. } => None,
        })
        .collect()
}

/// A turn's own messages, up to where the next turn starts.
fn message_of_turn(entry: &Entry) -> Option<Option<Message>> {
    match entry {
        Entry::TurnStarted { .. } => None,
        Entry::Message { message, .. } => Some(Some(message.clone())),
        Entry::ToolStarted { .. } | Entry::Compacted { .. } | Entry::TurnFinished { .. } => Some(None),
    }
}

/// What the orchestrator is made with.
pub struct Parts {
    pub hub: Weak<Hub>,
    pub farm: Arc<Farm>,
    pub home: PathBuf,
    pub trajectories: Arc<Trajectories>,
    /// The DeepSeek key, read at each turn.
    pub key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Talks to this model instead of DeepSeek (tests).
    pub client: Option<Arc<dyn ModelClient>>,
}

impl Orchestrator {
    pub fn open(p: Parts) -> Arc<Orchestrator> {
        let o = Arc::new(Orchestrator {
            hub: p.hub,
            farm: p.farm,
            home: p.home,
            trajectories: p.trajectories,
            key: p.key,
            client: p.client,
            instances: Default::default(),
            ports: Default::default(),
            closed: AtomicBool::new(false),
        });
        for a in o.farm.agents.profiles.orchestrators() {
            o.keep_on_duty(&a);
        }
        let weak = Arc::downgrade(&o);
        o.farm.agents.profiles.when_kept(Arc::new(move |a: &vibevalley_protocol::Agent| {
            if let Some(o) = weak.upgrade()
                && a.role == AgentRole::Orchestrator
            {
                o.keep_on_duty(a);
            }
            Ok(())
        }));
        // A turn the last process left unfinished is finished now.
        for a in o.farm.agents.profiles.orchestrators() {
            if Self::conversation_file(&o.home, &a.id).is_file() {
                o.instance(&a.id);
            }
        }
        o
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.hub.upgrade()
    }

    fn conversation_file(home: &std::path::Path, id: &str) -> PathBuf {
        home.join("agent").join(id).join("conversation.jsonl")
    }

    pub fn ensure_open(&self) {
        for a in self.farm.agents.profiles.orchestrators() {
            self.keep_on_duty(&a);
        }
    }

    /// `keepOnDuty`: an orchestrator's standing session in the state.
    fn keep_on_duty(&self, a: &vibevalley_protocol::Agent) {
        let Some(hub) = self.hub() else { return };
        let name = if a.name.trim().is_empty() {
            t("server.channel.name.orchestrator", &[])
        } else {
            a.name.trim().to_string()
        };
        let kept = hub.read(|s| s.sessions.iter().find(|h| h.id == a.id).cloned());
        if kept.as_ref().is_some_and(|k| k.name == name) {
            return;
        }
        let at = now();
        let session = match kept {
            Some(k) => Session { name, ..k },
            None => Session {
                id: a.id.clone(),
                role: AgentRole::Orchestrator,
                name,
                agent: a.id.clone(),
                runtime: ORCHESTRATOR_RUNTIME.into(),
                brief: a.duty.clone(),
                repo: None,
                branch: None,
                worktree: None,
                hired_at: at,
                runs: 0,
                last_run: None,
                spent: None,
                channel: None,
                issue: None,
                refining: false,
                tool_connections: None,
                machine: None,
                phase: Phase::Resting(PhaseResting {}),
            },
        };
        hub.apply(vec![Fact::SessionChanged(FactSessionChanged { at, session })]);
    }

    /// The orchestrator `agent` names, or the default one.
    fn target(&self, agent: Option<&str>) -> String {
        match agent {
            Some(a) if self.farm.agents.profiles.is_orchestrator(a) => a.to_string(),
            _ => vibevalley_protocol::DEFAULT_ORCHESTRATOR.to_string(),
        }
    }

    fn instance(self: &Arc<Self>, id: &str) -> Arc<Instance> {
        let mut all = lock(&self.instances);
        if let Some(i) = all.get(id) {
            return i.clone();
        }
        let me = Arc::new(Instance {
            id: id.to_string(),
            queue: Default::default(),
            more: Condvar::new(),
            route: Arc::new(Mutex::new(Route {
                channel: self.farm.chat.default_channel(),
                ..Route::default()
            })),
            abort: Mutex::new(None),
            shown: Default::default(),
            cannot: Default::default(),
            news: Default::default(),
        });
        all.insert(id.to_string(), me.clone());
        let o = Arc::downgrade(self);
        let i = me.clone();
        let _ = std::thread::Builder::new()
            .name(format!("vibevalley-orchestrator-{id}"))
            .spawn(move || Self::work(o, i));
        me
    }

    /// Hands an input to its orchestrator; false when it cannot take it.
    pub fn hear(self: &Arc<Self>, input: Input) -> bool {
        if self.closed.load(Ordering::Relaxed) {
            return false;
        }
        let id = self.target(input.agent.as_deref());
        let me = self.instance(&id);
        lock(&me.queue).push_back(input);
        me.more.notify_all();
        true
    }

    fn open_port(self: &Arc<Self>) -> Reply {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, words) = flume::unbounded();
        lock(&self.ports).insert(id.clone(), tx);
        Reply {
            id,
            words,
            orchestrator: Arc::downgrade(self),
        }
    }

    /// `answerer("phone")`: the user's spoken words go into the chat as any
    /// of theirs do, and the turn they wake is answered here as well.
    pub fn answer(self: &Arc<Self>, text: &str) -> Result<Reply, vibevalley_protocol::ApiError> {
        let reply = self.open_port();
        self.farm.chat.say(crate::modules::channel::Saying {
            text: text.into(),
            send_key: uuid::Uuid::new_v4().to_string(),
            source: Some("voice".into()),
            response_port: Some(reply.id.clone()),
            voice_mode: Some("conversation".into()),
            ..Default::default()
        })?;
        Ok(reply)
    }

    /// `brief`: a line from a call (what to tell the user, a question its
    /// model passes on) put to the default orchestrator; none when it
    /// cannot take it.
    pub fn brief(self: &Arc<Self>, line: String) -> Option<Reply> {
        let reply = self.open_port();
        self.hear(Input {
            agent: None,
            channel: self.farm.chat.default_channel(),
            source: Source::Call,
            line,
            user: false,
            picked: None,
            messages: vec![],
            port: Some(reply.id.clone()),
        })
        .then_some(reply)
    }

    /// Words it heard that did not wake it: shown with its next input.
    pub fn overhear(self: &Arc<Self>, agent: Option<&str>, line: String) {
        let id = self.target(agent);
        lock(&self.instance(&id).news).lines.push(line);
    }

    /// `stop`: ends its turn under way and drops what waits for it.
    pub fn stop(&self, agent: Option<&str>) {
        let id = self.target(agent);
        let Some(me) = lock(&self.instances).get(&id).cloned() else { return };
        lock(&me.queue).clear();
        if let Some(a) = lock(&me.abort).as_ref() {
            a.store(true, Ordering::SeqCst);
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        for me in lock(&self.instances).values() {
            if let Some(a) = lock(&me.abort).as_ref() {
                a.store(true, Ordering::SeqCst);
            }
            me.more.notify_all();
        }
    }

    fn model_of(&self, id: &str) -> Result<String, String> {
        let configured = self.farm.agents.profiles.agent(id).map(|a| a.model.trim().to_string()).unwrap_or_default();
        if configured.is_empty() {
            return Ok(DEFAULT_MODEL.into());
        }
        match configured.split_once('/') {
            None => Ok(configured),
            Some(("deepseek", m)) => Ok(m.to_string()),
            Some(_) => Err(t("server.orchestrator.onlyDeepseek", &[("configured", configured.clone().into())])),
        }
    }

    fn client(&self) -> Arc<dyn ModelClient> {
        self.client.clone().unwrap_or_else(|| {
            let key = self.key.clone();
            Arc::new(OpenAiClient::deepseek(move || key()))
        })
    }

    fn system_prompt(&self, id: &str, home: &std::path::Path, memory: &dyn kit::MemoryPort) -> String {
        let p = &*words::PROMPTS;
        let profile = self.farm.agents.profiles.agent(id);
        let mut s = p.system.clone() + &p.agent;
        if id != vibevalley_protocol::DEFAULT_ORCHESTRATOR
            && let Some(a) = &profile
        {
            s += &words::identity_note(&a.name, &a.persona);
        }
        s = s.trim().to_string();
        s += "\n\n";
        s += &p.env.replace("{cwd}", &self.farm.repos.root().display().to_string());
        let skills = kit::scan_skills(&[home.join("skills")]);
        if !skills.is_empty() {
            s += "\n\n";
            s += &p.skills.replace("{skills}", &kit::skill_index(&skills, 160));
        }
        let mem = memory.prompt();
        if !mem.is_empty() {
            s += "\n\n";
            s += &p.memory.replace("{memory}", &mem);
        }
        s
    }

    /// Everything it can call: the farm's tools for where it is, its skills and its memory.
    fn tools(&self, me: &Instance, skills_dir: PathBuf, memory: Arc<dyn kit::MemoryPort>) -> Vec<Box<dyn Tool>> {
        let mut tools = held(&self.farm, &me.route);
        let dirs = vec![skills_dir];
        tools.push(Box::new(kit::LoadSkill {
            skills: Box::new(move || kit::scan_skills(&dirs)),
        }));
        tools.push(Box::new(kit::Remember(memory.clone())));
        tools.push(Box::new(kit::RewriteMemory(memory)));
        tools
    }

    /// Keeps the turn that answered step `on` of its log as a case to replay: what it had been told before, what it was
    /// asked, what it did, and what the user says it should have done.
    pub fn mark_wrong(self: &Arc<Self>, agent: Option<&str>, on: i64, want: &str) -> Result<OrchestratorEval, ApiError> {
        let want = want.trim();
        if want.is_empty() {
            return Err(refused(BizCode::Refused, t("server.session.host.markNeedsWords", &[])));
        }
        let id = self.target(agent);
        let label = self.farm.agents.profiles.agent(&id).map(|a| a.name).unwrap_or_else(|| id.clone());
        let log = self.trajectories.events(&id, None).unwrap_or_default();
        let Some(asked) = log.iter().find(|e| e.seq == on) else {
            return Err(missing(
                t("server.session.host.noStep", &[("label", label.into()), ("on", on.into())]),
                LookIn::Session,
            ));
        };
        if asked.r#type != SessionEventType::UserMessage {
            return Err(refused(
                BizCode::Refused,
                t("server.session.host.notAsked", &[("on", on.into()), ("label", label.into())]),
            ));
        }
        // The same words asked twice are two turns: the one meant is as far along among them as its step is in the log.
        let nth = log
            .iter()
            .filter(|e| e.seq < on && e.r#type == SessionEventType::UserMessage && e.text == asked.text)
            .count();
        let entries = vibevalley_agent::read_entries(&Self::conversation_file(&self.home, &id)).map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        let turns = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| matches!(e, Entry::TurnStarted { input } if input.contains(&asked.text)));
        let Some((at, Entry::TurnStarted { input })) = turns.clone().nth(nth).or_else(|| turns.clone().next_back()) else {
            return Err(refused(
                BizCode::Refused,
                t("server.session.host.notInConversation", &[("on", on.into()), ("label", label.into())]),
            ));
        };
        let model = self.model_of(&id).map_err(|e| refused(BizCode::Refused, e))?;
        let me = self.instance(&id);
        let memory = self.farm.memories.port(&id, crate::modules::memory::By::Orchestrator);
        let case = EvalCase {
            id: uuid::Uuid::now_v7().to_string(),
            created_at: now(),
            model,
            want: want.into(),
            memory: memory.prompt(),
            tools: self
                .tools(&me, self.home.join("agent").join(&id).join("skills"), memory)
                .iter()
                .map(|tool| tool.spec().name)
                .collect(),
            before: told_before(&entries[..at]),
            input: input.clone(),
            did: entries[at + 1..].iter().map_while(message_of_turn).flatten().collect(),
            expect: vec![],
        };
        let dir = self.home.join("evals");
        let file = dir.join(format!("{}.json", case.id));
        let written = std::fs::create_dir_all(&dir).and_then(|()| {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file)?;
            out.write_all(format!("{}\n", serde_json::to_string_pretty(&case).unwrap_or_default()).as_bytes())
        });
        written.map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        Ok(OrchestratorEval {
            id: case.id,
            file: file.to_string_lossy().into_owned(),
        })
    }

    /// The conversation, opened as its turn starts (its prompt as it is now).
    fn conversation(&self, me: &Instance, model: &str) -> Result<Conversation, String> {
        let home = self.home.join("agent").join(&me.id);
        let skills_dir = home.join("skills");
        if !skills_dir.is_dir() {
            let _ = std::fs::create_dir_all(&skills_dir);
            let _ = SKILLS.extract(&skills_dir);
        }
        let memory = self.farm.memories.port(&me.id, crate::modules::memory::By::Orchestrator);
        let mut brain = Brain::new(self.client(), model, self.system_prompt(&me.id, &home, memory.as_ref()));
        brain.tools = self.tools(me, skills_dir, memory);
        Conversation::open(Self::conversation_file(&self.home, &me.id), brain).map_err(|e| e.to_string())
    }

    fn work(o: Weak<Orchestrator>, me: Arc<Instance>) {
        // A turn cut short by the last process goes on first.
        if let Some(o) = o.upgrade() {
            o.resume(&me);
        }
        loop {
            let batch: Vec<Input> = {
                let mut q = lock(&me.queue);
                loop {
                    let Some(o) = o.upgrade() else { return };
                    if o.closed.load(Ordering::Relaxed) {
                        return;
                    }
                    drop(o);
                    if !q.is_empty() {
                        break q.drain(..).collect();
                    }
                    q = me.more.wait_timeout(q, std::time::Duration::from_secs(1)).unwrap_or_else(|e| e.into_inner()).0;
                }
            };
            let Some(o) = o.upgrade() else { return };
            o.turn(&me, batch);
        }
    }

    fn resume(&self, me: &Instance) {
        let Ok(model) = self.model_of(&me.id) else { return };
        if (self.key)().is_none() && self.client.is_none() {
            return;
        }
        let Ok(mut conv) = self.conversation(me, &model) else { return };
        if conv.unfinished_turn().is_none() {
            return;
        }
        *lock(&me.abort) = Some(conv.abort_handle());
        let route = lock(&me.route).clone();
        let mut run = Run::new(self, me, &route);
        let outcome = conv.resume(&mut |e| run.on(e)).unwrap_or(Ok(TurnOutcome::Completed));
        run.finish(outcome);
    }

    /// The farm as it is shown before an input (`situation`).
    fn situation(&self, channel: &str) -> String {
        let f = &self.farm;
        let mut agents = vec![];
        for a in f.agents.profiles.agents() {
            let assessed = f.agents.fleet.assess(&a);
            let p = &assessed.agent;
            let mut traits = vec![];
            if !p.duty.is_empty() {
                traits.push(format!("职责：{}", p.duty));
            }
            if !p.tags.is_empty() {
                traits.push(format!("适合的活：{}", p.tags.join("、")));
            }
            let mut line = words::agent_line(&p.name, &p.id, &p.runtime, &traits.join("；"));
            if p.enabled && assessed.blocking.is_empty() {
                let info = assessed.info.as_ref();
                let quota = info.and_then(|i| i.quota.as_ref());
                let low = quota.and_then(|q| q.left.as_ref()).is_some_and(|l| l.get() < QUOTA_LOW);
                let budget = info.and_then(|i| i.settings.daily_budget.as_ref()).map(|b| b.get()).unwrap_or(0.0);
                let spent = info.and_then(|i| i.spent_today.as_ref()).map(|s| s.get());
                line += &format!("；{}", words::quota_line(quota.map(|q| q.text.as_str()), low, spent, budget));
            } else if let Some(b) = assessed.blocking.first() {
                line += &words::blocked(&b.text);
            } else {
                line += words::DISABLED;
            }
            agents.push(line);
        }
        let roster = f.roster();
        let default = f.chat.default_channel();
        let by_channel: Vec<String> = f
            .chat
            .channels()
            .iter()
            .map(|c| {
                let theirs: Vec<String> = roster
                    .iter()
                    .filter(|h| h.channel.clone().unwrap_or_else(|| default.clone()) == c.id)
                    .map(|h| f.session_line(h))
                    .collect();
                let head = words::channel_line(&c.name, c.default, &c.description, &c.repo);
                format!(
                    "{head}\n{}",
                    if theirs.is_empty() {
                        words::NO_HELPERS.to_string()
                    } else {
                        theirs.join("\n")
                    }
                )
            })
            .collect();
        let repos = f.repos.list();
        let folders = if repos.is_empty() {
            words::NO_REPOS.to_string()
        } else {
            repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join("、")
        };
        let (direct, target) = f.chat.address_of(channel);
        words::whole(
            &f.repos.root().display().to_string(),
            &folders,
            &agents.join("\n"),
            &by_channel.join("\n"),
            &if direct { words::direct(&target) } else { target },
            &words::users_language(),
        )
    }

    /// The whole input of a turn on `batch`.
    fn input_of(&self, me: &Instance, batch: &[Input]) -> String {
        let channel = batch.last().map(|i| i.channel.clone()).unwrap_or_default();
        let situation = self.situation(&channel);
        let shown = {
            let mut was = lock(&me.shown);
            let delta = if was.is_empty() {
                situation.clone()
            } else {
                words::situation_delta(&was, &situation)
            };
            *was = situation;
            delta
        };
        let heard: Vec<String> = std::mem::take(&mut lock(&me.news).lines);
        let news = if heard.is_empty() { String::new() } else { words::news(&heard.join("\n")) };
        let at = jiff::Timestamp::from_millisecond(now())
            .unwrap_or_default()
            .to_zoned(jiff::tz::TimeZone::system());
        let time = at.strftime("%Y/%-m/%-d %H:%M").to_string();
        let asked: Vec<String> = batch.iter().map(|i| format!("{}{}", i.source.head(), i.line)).collect();
        [words::now_line(&time), shown, news, asked.join("\n\n")]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn turn(&self, me: &Instance, batch: Vec<Input>) {
        let Some(last) = batch.last().cloned() else { return };
        let route = Route {
            agent: me.id.clone(),
            channel: last.channel.clone(),
            envelope: last.messages.last().cloned().unwrap_or_default(),
            picked: batch
                .iter()
                .rev()
                .find_map(|i| i.picked.as_ref().and_then(|p| p.agent.clone()))
                .unwrap_or_default(),
            user: batch.iter().any(|i| i.user),
        };
        // Taken now: a turn that cannot start ends them unanswered.
        let ports: Vec<flume::Sender<String>> = {
            let mut open = lock(&self.ports);
            batch.iter().filter_map(|i| i.port.as_ref().and_then(|p| open.remove(p))).collect()
        };
        *lock(&me.route) = route.clone();
        let cannot = |why: String| {
            // The round is still in its log, failed: what it was told can be read and judged there.
            let run = Run::new(self, me, &route);
            run.asked(&self.input_of(me, &batch));
            run.step(Step::RunEnded {
                run: run.run.clone(),
                outcome: Outcome::Failed,
            });
            run.phase(None);
            let mut said = lock(&me.cannot);
            if said.get(&route.channel) != Some(&why) {
                said.insert(route.channel.clone(), why.clone());
                let _ = self.farm.chat.post(Posting {
                    from: me.id.clone(),
                    channel: route.channel.clone(),
                    text: why,
                    run: None,
                    send_key: String::new(),
                    made: None,
                    spoken: false,
                });
            }
        };
        if (self.key)().is_none_or(|k| k.trim().is_empty()) && self.client.is_none() {
            return cannot(t("server.orchestrator.noKey", &[]));
        }
        let model = match self.model_of(&me.id) {
            Ok(m) => m,
            Err(why) => return cannot(t("server.orchestrator.cannotStart", &[("why", why.into())])),
        };
        let mut conv = match self.conversation(me, &model) {
            Ok(c) => c,
            Err(why) => return cannot(t("server.orchestrator.cannotStart", &[("why", why.into())])),
        };
        lock(&me.cannot).clear();
        *lock(&me.abort) = Some(conv.abort_handle());
        let text = self.input_of(me, &batch);
        let mut run = Run::new(self, me, &route);
        run.ports = ports;
        run.asked(&text);
        let outcome = conv.send(&text, &mut |e| run.on(e));
        run.finish(outcome);
        for id in batch.iter().flat_map(|i| &i.messages) {
            let _ = self.farm.chat.mark_seen(&me.id, id);
        }
    }
}

/// One turn as the state, the log and the chat see it.
struct Run<'a> {
    o: &'a Orchestrator,
    me: &'a Instance,
    route: &'a Route,
    run: String,
    said: String,
    calls: u64,
    /// The live answers this turn's words also go to, read out as they are.
    ports: Vec<flume::Sender<String>>,
}

impl<'a> Run<'a> {
    fn new(o: &'a Orchestrator, me: &'a Instance, route: &'a Route) -> Run<'a> {
        let run = format!("run-{}", uuid::Uuid::now_v7());
        let r = Run {
            o,
            me,
            route,
            run,
            said: String::new(),
            calls: 0,
            ports: vec![],
        };
        r.step(Step::RunStarted { run: r.run.clone() });
        r.phase(Some(SessionAction::Thinking));
        r
    }

    fn step(&self, step: Step) {
        self.o.trajectories.step(&self.me.id, "", step);
    }

    fn agent(&self, kind: vibevalley_oar::EventKind) {
        self.step(Step::Agent(vibevalley_oar::Event {
            seq: 0,
            agent_path: vec![],
            at_ms: now() as u64,
            kind,
        }));
    }

    fn asked(&self, text: &str) {
        self.step(Step::Asked { text: text.into() });
    }

    fn phase(&self, doing: Option<SessionAction>) {
        let Some(hub) = self.o.hub() else { return };
        let at = now();
        let since = hub.read(|s| {
            s.sessions.iter().find(|h| h.id == self.me.id).and_then(|h| match &h.phase {
                Phase::Working(w) => Some(w.since),
                _ => None,
            })
        });
        let phase = match doing {
            Some(action) => Phase::Working(PhaseWorking {
                since: since.unwrap_or(at),
                quiet_since: None,
                retry: None,
                doing: Doing { action, label: String::new() },
            }),
            None => Phase::Resting(PhaseResting {}),
        };
        hub.apply(vec![Fact::SessionPhaseChanged(FactSessionPhaseChanged {
            at,
            id: self.me.id.clone(),
            phase,
            channel: Some(self.route.channel.clone()),
            spent: None,
            brief: None,
        })]);
    }

    /// Says what it has written so far, as one message.
    fn say(&mut self) {
        let text = std::mem::take(&mut self.said);
        if text.trim().is_empty() {
            return;
        }
        for port in &self.ports {
            let _ = port.send(text.clone());
        }
        if let Err(e) = self.o.farm.chat.post(Posting {
            from: self.me.id.clone(),
            channel: self.route.channel.clone(),
            text,
            run: Some(self.run.clone()),
            send_key: String::new(),
            made: None,
            spoken: !self.ports.is_empty(),
        }) && let Some(hub) = self.o.hub()
        {
            hub.notice(NoticeLevel::Warn, e.message);
        }
    }

    fn on(&mut self, e: BrainEvent) {
        use vibevalley_oar::EventKind as K;
        match e {
            BrainEvent::Text(text) => {
                if self.said.is_empty() {
                    self.phase(Some(SessionAction::SpeakingText));
                }
                self.said.push_str(&text);
                self.agent(K::TextDelta { text });
            }
            BrainEvent::Reasoning(text) => self.agent(K::ThinkingDelta { text }),
            BrainEvent::ToolStarted { id, name, arguments } => {
                self.say();
                self.calls += 1;
                self.phase(Some(SessionAction::Other));
                let input = serde_json::from_str(&arguments).unwrap_or(serde_json::Value::String(arguments));
                self.agent(K::ToolCallStarted { id, name, input });
            }
            BrainEvent::ToolFinished { id, output } => {
                self.agent(K::ToolCallFinished {
                    id,
                    ok: !output.is_error,
                    output: output.text,
                });
                self.phase(Some(SessionAction::Thinking));
            }
            BrainEvent::Error(message) => self.agent(K::Error { message }),
            BrainEvent::TurnStarted { .. } | BrainEvent::Compacted | BrainEvent::TurnFinished { .. } => {}
        }
    }

    fn finish(mut self, outcome: vibevalley_agent::Result<TurnOutcome>) {
        self.say();
        let outcome = match outcome {
            Ok(TurnOutcome::Completed) => Outcome::Completed,
            Ok(TurnOutcome::Aborted) => Outcome::Interrupted,
            Ok(_) => Outcome::Failed,
            Err(e) => {
                if let Some(hub) = self.o.hub() {
                    let label = self
                        .o
                        .farm
                        .agents
                        .profiles
                        .agent(&self.me.id)
                        .map(|a| a.name)
                        .unwrap_or_else(|| self.me.id.clone());
                    hub.notice(
                        NoticeLevel::Error,
                        t("server.session.host.failed", &[("label", label.into()), ("why", e.to_string().into())]),
                    );
                }
                Outcome::Failed
            }
        };
        self.step(Step::RunEnded {
            run: self.run.clone(),
            outcome,
        });
        self.phase(None);
    }
}

/// `orchestrator.open`, `orchestrator.stop`.
pub fn install(hub: &Hub, o: Arc<Orchestrator>) {
    let opened = o.clone();
    hub.on::<ops::OrchestratorOpen>(move |_, ()| {
        opened.ensure_open();
        Ok(())
    });
    let stopped = o.clone();
    hub.on::<ops::OrchestratorStop>(move |_, input| {
        stopped.stop(input.agent.as_deref());
        Ok(())
    });
    hub.on::<ops::OrchestratorEvalCreate>(move |_, input| o.mark_wrong(input.agent.as_deref(), input.on.0 as i64, &input.want));
}
