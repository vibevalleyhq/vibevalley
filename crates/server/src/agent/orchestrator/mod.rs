//! The orchestrator: one assistant per orchestrator profile, each a durable
//! conversation on `vibevalley-runtime::agent` holding the farm's tools.
//! Subscribes to orchestrator-targeted dispatches from `Chat`; crons for no
//! profile come to it too. Before each input it is shown the time and the farm
//! (`situation`), or what changed since; its words are said in the place it
//! answers.
//!
//! Inputs that come while it works wait and go in together as the next turn.

mod execution;
pub mod inbox;
mod mcp;
pub mod words;

pub use execution::Execution;
pub use inbox::RuntimeInboxObserver;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, AgentRole, ApiError, BizCode, ChannelType, Doing, ExecutionPolicy, NoticeLevel, ORCHESTRATOR_RUNTIME, OrchestratorApproval,
    OrchestratorApprovalListInput, OrchestratorApprovalResolveInput, OrchestratorEval, OrchestratorEvalRequest, OrchestratorStopInput, Outcome, Phase,
    PhaseResting, PhaseWorking, Session, SessionAction, SessionController, SessionEventType,
};
use vibevalley_runtime::agent::extensions::governance::Permissions;
use vibevalley_runtime::agent::extensions::memory::{MemoryPort, Remember, RewriteMemory};
use vibevalley_runtime::agent::resources::skills::{LoadSkill, scan_skills, skill_index};
use vibevalley_runtime::agent::{AgentEvent, Brain, Message, ModelClient, OpenAiClient, Tool, TurnOutcome, TypedToolAdapter};

use self::words::Source;
use crate::BoxFuture;
use crate::agent::memory::{By, Memory};
use crate::agent::profile::Profile;
use crate::agent::tool::{Route, ToolRegistry, held};
use crate::artifact::Manager as ArtifactManager;
use crate::channel::{Chat, Committed, DeliveryTargetKind, Picked, Posting, QueuedDelivery, Saying, actor_of, meta_of};
use crate::context::Context;
use crate::context::error::{LookIn, missing, refused};
use crate::context::port::{CronOrchestratorPort, VoiceOrchestratorPort};
use crate::issue::Board;
use crate::repo::Repo;
use crate::runtime::{Runtime, Step};
use crate::service::session::{MailboxSource, MailboxStatus};

const DEFAULT_MODEL: &str = "deepseek-flash";
/// `quotaLow`: a runtime with less left than this is nearly used up.
const QUOTA_LOW: f64 = 15.0;
const SKILLS: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/assets/orchestrator/skills");

/// One input to an orchestrator (`Handed`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    /// The live answer waiting for this turn's words (`Orchestrator::answer_async`, `brief`).
    pub port: Option<String>,
}

/// A live answer: the turn's words as they are said, ending with the turn.
/// Dropped, it stops waiting.
pub struct Reply {
    id: String,
    words: flume::Receiver<String>,
    orchestrator: Weak<Orchestrator>,
}

impl Reply {
    /// The next words, none once the turn is over or nothing came in `wait`.
    pub async fn next_async(&self, wait: std::time::Duration) -> Option<String> {
        tokio::time::timeout(wait, self.words.recv_async()).await.ok().and_then(Result::ok)
    }

    /// Everything said until the turn ends, or what came within `wait` of each other.
    pub async fn whole_async(&self, wait: std::time::Duration) -> String {
        let mut said = vec![];
        while let Some(words) = self.next_async(wait).await {
            said.push(words);
        }
        said.join("\n").trim().to_string()
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        if let Some(o) = self.orchestrator.upgrade() {
            o.ports.lock().remove(&self.id);
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
    queue: Mutex<VecDeque<()>>,
    more: Arc<Notify>,
    route: Arc<Mutex<Route>>,
    /// The situation it was last shown whole; "" shows it whole again.
    shown: Mutex<String>,
    /// What it last said it cannot start for, per place.
    cannot: Mutex<HashMap<String, String>>,
    news: Mutex<Waiting>,
}

pub struct Orchestrator {
    me: Weak<Orchestrator>,
    pub(super) ctx: Arc<Context>,
    tool: Arc<ToolRegistry>,
    profile: Arc<Profile>,
    pub(super) chat: Arc<Chat>,
    pub(super) issue: Arc<Board>,
    pub(super) runtime: Arc<Runtime>,
    repo: Arc<Repo>,
    memory: Arc<Memory>,
    pub(super) artifact: Arc<ArtifactManager>,
    home: PathBuf,
    key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    client: Option<Arc<dyn ModelClient>>,
    instances: Mutex<HashMap<String, Arc<Instance>>>,
    pub execution: Execution,
    mcp: mcp::ProfileServers,
    /// The live answers not yet taken by a turn.
    ports: Mutex<HashMap<String, flume::Sender<String>>>,
    chat_listener: Mutex<Option<(CancellationToken, TaskHandle<()>)>>,
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
fn told_before(entries: &[execution::EvalEntry]) -> Vec<Message> {
    let from = entries.iter().rposition(|e| matches!(e, execution::EvalEntry::Compacted { .. })).unwrap_or(0);
    entries[from..]
        .iter()
        .map(|e| match e {
            execution::EvalEntry::Compacted { summary } => Message::system(summary.clone()),
            execution::EvalEntry::Message(message) => message.clone(),
            execution::EvalEntry::TurnStarted { input } => Message::user(input.clone()),
        })
        .collect()
}

/// A turn's own messages, up to where the next turn starts.
fn message_of_turn(entry: &execution::EvalEntry) -> Option<Option<Message>> {
    match entry {
        execution::EvalEntry::TurnStarted { .. } => None,
        execution::EvalEntry::Message(message) => Some(Some(message.clone())),
        execution::EvalEntry::Compacted { .. } => Some(None),
    }
}

/// Dependencies required to open [`Orchestrator`].
pub struct Parts {
    pub ctx: Arc<Context>,
    pub permissions: Permissions,
    pub tool: Arc<ToolRegistry>,
    pub profile: Arc<Profile>,
    pub chat: Arc<Chat>,
    pub issue: Arc<Board>,
    pub runtime: Arc<Runtime>,
    pub repo: Arc<Repo>,
    pub memory: Arc<Memory>,
    pub artifact: Arc<ArtifactManager>,
    pub home: PathBuf,
    /// The DeepSeek key, read at each turn.
    pub key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Talks to this model instead of DeepSeek (tests).
    pub client: Option<Arc<dyn ModelClient>>,
    /// Whether to start listening to orchestrator-targeted dispatches from `chat` on open.
    pub listen_chat: bool,
}

impl Orchestrator {
    pub async fn open_async(p: Parts) -> vibevalley_runtime::agent::durable::Result<Arc<Orchestrator>> {
        let store = p.runtime.durable_store().clone();
        let listen_chat = p.listen_chat;
        let o = Arc::new_cyclic(|weak| Orchestrator {
            me: weak.clone(),
            execution: Execution::new(store, weak.clone(), p.permissions),
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
            closed: AtomicBool::new(false),
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
        o.execution.scheduler.recover()?;
        for a in o.profile.orchestrators() {
            if o.execution.has_inputs(&a.id)? {
                o.instance(&a.id);
            }
        }
        if listen_chat {
            o.start_chat_listener();
        }
        Ok(o)
    }

    /// Starts projecting durable `pi.inbox` alerts into `ctx.live` and `SliceMask::INBOX`.
    pub fn start_inbox_observer(&self) -> vibevalley_runtime::agent::durable::Result<()> {
        RuntimeInboxObserver::start(self.execution.store(), &self.ctx)
    }

    pub async fn ensure_open_async(&self) {
        for a in self.profile.orchestrators() {
            self.keep_on_duty_async(&a).await;
        }
    }

    /// `keepOnDuty`: ensures an orchestrator's standing session is persisted.
    async fn keep_on_duty_async(&self, a: &vibevalley_protocol::Agent) {
        let name = if a.name.trim().is_empty() {
            t("server.channel.name.orchestrator", &[])
        } else {
            a.name.trim().to_string()
        };
        let kept = self.ctx.service.session.get(&a.id).await.ok().flatten();
        if kept.as_ref().is_some_and(|k| k.name == name) {
            return;
        }
        let at = self.ctx.now();
        let session = match kept {
            Some(k) => Session { name, ..k },
            None => {
                let mut s = Session::new(
                    &a.id,
                    SessionController::Orchestrator,
                    name,
                    ORCHESTRATOR_RUNTIME,
                    ExecutionPolicy::SandboxDir,
                    at,
                );
                s.profile = Some(a.id.clone());
                s.brief = a.duty.clone();
                s
            }
        };
        if let Err(e) = self.runtime.upsert_orchestrator_async(&session).await {
            self.ctx.live.publish_notice(at, NoticeLevel::Warn, e.to_string());
            return;
        }
        self.ctx.mark_dirty(SliceMask::SESSIONS | SliceMask::BOARD | SliceMask::FARM);
    }

    /// The orchestrator `agent` names, or the default one.
    fn target(&self, agent: Option<&str>) -> String {
        match agent {
            Some(a) if self.profile.is_orchestrator(a) => a.to_string(),
            _ => vibevalley_protocol::DEFAULT_ORCHESTRATOR.to_string(),
        }
    }

    fn instance(self: &Arc<Self>, id: &str) -> Arc<Instance> {
        let mut all = self.instances.lock();
        if let Some(i) = all.get(id) {
            return i.clone();
        }
        let me = Arc::new(Instance {
            id: id.to_string(),
            queue: Default::default(),
            more: Arc::new(Notify::new()),
            route: Arc::new(Mutex::new(Route {
                channel: self.chat.default_channel(),
                ..Route::default()
            })),
            shown: Default::default(),
            cannot: Default::default(),
            news: Default::default(),
        });
        all.insert(id.to_string(), me.clone());
        let o = Arc::downgrade(self);
        let i = me.clone();
        let cancel = self.ctx.task.child_token();
        self.ctx.spawn("orchestrator.work", async move { Self::work_async(o, i, cancel).await });
        me
    }

    /// Hands an input to its orchestrator; false when it cannot take it.
    pub fn hear(self: &Arc<Self>, input: Input) -> bool {
        if self.closed.load(Ordering::Relaxed) {
            return false;
        }
        let id = self.target(input.agent.as_deref());
        let me = self.instance(&id);
        let mut queue = me.queue.lock();
        if let Err(error) = self.execution.enqueue(&id, &input) {
            self.ctx.live.publish_notice(self.ctx.now(), NoticeLevel::Error, error.to_string());
            return false;
        }
        queue.push_back(());
        drop(queue);
        me.more.notify_one();
        true
    }

    fn open_port(self: &Arc<Self>) -> Reply {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, words) = flume::unbounded();
        self.ports.lock().insert(id.clone(), tx);
        Reply {
            id,
            words,
            orchestrator: Arc::downgrade(self),
        }
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
    pub fn brief(self: &Arc<Self>, line: String) -> Option<Reply> {
        let reply = self.open_port();
        self.hear(Input {
            agent: None,
            channel: self.chat.default_channel(),
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
        self.instance(&id).news.lock().lines.push(line);
    }

    /// `stop`: ends its turn under way and drops what waits for it.
    pub fn stop(&self, agent: Option<&str>) {
        let id = self.target(agent);
        let Some(me) = self.instances.lock().get(&id).cloned() else { return };
        me.queue.lock().clear();
        let _ = self.execution.stop(&id);
    }

    /// Subscribes to orchestrator-targeted deliveries from `self.chat` on `ctx.task`
    /// (plus replays any pending deliveries left from a prior process).
    fn start_chat_listener(self: &Arc<Self>) {
        let dispatches = self.chat.dispatches();
        let o = Arc::downgrade(self);
        let chat = self.chat.clone();
        let cancel = self.ctx.task.child_token();
        let task_cancel = cancel.clone();
        let handle = self.ctx.spawn("orchestrator.chat_listener", async move {
            if let Some(o) = o.upgrade()
                && let Ok(pending) = chat.pending_deliveries_async(DeliveryTargetKind::Orchestrator).await
            {
                for d in pending {
                    if o.closed.load(Ordering::Acquire) {
                        return;
                    }
                    o.handle_chat_delivery_async(&chat, &d, None).await;
                }
            }
            loop {
                let dispatched = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = dispatches.recv_async() => match res {
                        Ok(dispatched) => dispatched,
                        Err(_) => return,
                    },
                };
                let Some(o) = o.upgrade() else { return };
                if o.closed.load(Ordering::Acquire) {
                    return;
                }
                for d in &dispatched.deliveries {
                    if d.recipient_kind == DeliveryTargetKind::Orchestrator {
                        o.handle_chat_delivery_async(&chat, d, Some(&dispatched.committed)).await;
                    }
                }
            }
        });
        let prev = self.chat_listener.lock().replace((cancel, handle));
        if let Some((old_cancel, old_handle)) = prev {
            old_cancel.cancel();
            self.ctx.spawn("orchestrator.chat_listener_drain", async move {
                let _ = old_handle.await;
            });
        }
    }

    async fn handle_chat_delivery_async(self: &Arc<Self>, chat: &Chat, d: &QueuedDelivery, committed: Option<&Arc<Committed>>) {
        const HANDED_EMOJI: &str = "👀";
        let sessions = &self.ctx.service.session;
        let now_ms = self.ctx.now();
        if !chat.delivery_is_pending_async(d.id).await.unwrap_or(false) {
            let _ = sessions.withdraw_mailbox_by_message(&d.message_id, now_ms).await;
            return;
        }
        if !self.profile.is_orchestrator(&d.recipient_id) {
            let _ = chat.settle_delivery_async(d.id, false).await;
            return;
        }
        let owned;
        let c = match committed {
            Some(c) => c.as_ref(),
            None => match chat.committed_of_async(&d.message_id).await.ok().flatten() {
                Some(c) => {
                    owned = c;
                    &owned
                }
                None => {
                    let _ = sessions.withdraw_mailbox_by_message(&d.message_id, now_ms).await;
                    let _ = chat.withdraw_delivery_async(d.id).await;
                    return;
                }
            },
        };
        if c.row.deleted_at.is_some() {
            let _ = sessions.withdraw_mailbox_by_message(&d.message_id, now_ms).await;
            let _ = chat.withdraw_delivery_async(d.id).await;
            return;
        }
        let m = chat.addressed_of(&c.row);
        let line = words::orchestrator_lines(std::slice::from_ref(&m));
        if !d.wakes {
            self.overhear(Some(&d.recipient_id), line);
            let _ = chat.settle_delivery_async(d.id, true).await;
            return;
        }
        let mail_key = format!("orchestrator:{}:{}", d.recipient_id, d.message_id);
        let mail_entry = sessions
            .enqueue_mailbox(
                &d.recipient_id,
                &mail_key,
                MailboxSource::ChannelOrchestrator,
                Some(&d.message_id),
                &c.row.body,
                now_ms,
            )
            .await
            .ok();
        let claimed = sessions.claim_mailbox_by_key(&mail_key, now_ms).await.unwrap_or(false);
        if !claimed
            && mail_entry
                .as_ref()
                .is_some_and(|e| matches!(e.status, MailboxStatus::Withdrawn | MailboxStatus::Done | MailboxStatus::Claimed))
        {
            return;
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
            .map(|vc| format!("{}\n", words::format_artifact_view_context(vc)))
            .unwrap_or_default();
        let text = c.row.body.trim();
        let said = match meta.voice_mode.as_deref() {
            Some("dictated") => format!("{picked_note}{view_note}{}{}", words::DICTATED, words::user_line(text)),
            Some("conversation") => format!("{}\n{}", words::PROMPTS.voice, words::user_line(text)),
            _ if from_user && (c.channel_type == ChannelType::Direct || c.row.channel_id == chat.default_channel()) => {
                format!("{picked_note}{view_note}{}", words::user_line(text))
            }
            _ => format!("{picked_note}{}", words::chat_line(&m.target, &line)),
        };
        let input = Input {
            agent: Some(d.recipient_id.clone()),
            channel: c.row.channel_id.clone(),
            source: if from_user { Source::User } else { Source::Chat },
            line: said,
            user: from_user,
            picked: meta.picked.clone(),
            messages: vec![c.row.id.clone()],
            port: meta.response_port.clone(),
        };
        let o = self.clone();
        let heard = self.ctx.task.spawn_blocking(move || o.hear(input)).await.unwrap_or(false);
        if heard {
            if let Some(id) = settle_id {
                let _ = sessions.settle_mailbox(id, true, Some(&d.recipient_id), self.ctx.now()).await;
            }
            let _ = chat.settle_delivery_async(d.id, true).await;
            if let Err(e) = chat.react_async(&c.row.id, &d.recipient_id, HANDED_EMOJI, true).await {
                eprintln!("vibevalley-server: orchestrator: 👀: {}", e.message);
            }
        } else if !self.closed.load(Ordering::Acquire) {
            if let Some(id) = settle_id {
                let _ = sessions.settle_mailbox(id, false, Some("rejected"), self.ctx.now()).await;
            }
            let _ = chat.settle_delivery_async(d.id, false).await;
        }
    }

    pub async fn close_async(&self) {
        self.closed.store(true, Ordering::Release);
        let chat_listener = self.chat_listener.lock().take();
        if let Some((cancel, handle)) = chat_listener {
            cancel.cancel();
            let _ = handle.await;
        }
        self.execution.close();
        self.mcp.close();
        self.ports.lock().clear();
        for me in self.instances.lock().values() {
            me.more.notify_waiters();
        }
    }

    fn model_of(&self, id: &str) -> Result<String, String> {
        let configured = self.profile.agent(id).map(|a| a.model.trim().to_string()).unwrap_or_default();
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

    pub(crate) fn system_prompt_snapshot(&self, id: &str) -> String {
        let home = self.home.join("agent").join(id);
        let memory = self.memory.port(id, By::Orchestrator);
        self.system_prompt(id, &home, memory.as_ref())
    }

    fn system_prompt(&self, id: &str, home: &std::path::Path, memory: &dyn MemoryPort) -> String {
        let p = &*words::PROMPTS;
        let profile = self.profile.agent(id);
        let mut s = p.system.clone() + &p.agent;
        if id != vibevalley_protocol::DEFAULT_ORCHESTRATOR
            && let Some(a) = &profile
        {
            s += &words::identity_note(&a.name, &a.persona);
        }
        s = s.trim().to_string();
        s += "\n\n";
        s += &p.env.replace("{cwd}", &self.repo.root().display().to_string());
        let skills = scan_skills(&[home.join("skills")]);
        if !skills.is_empty() {
            s += "\n\n";
            s += &p.skills.replace("{skills}", &skill_index(&skills, 160));
        }
        let mem = memory.prompt();
        if !mem.is_empty() {
            s += "\n\n";
            s += &p.memory.replace("{memory}", &mem);
        }
        s
    }

    /// Everything it can call: the farm's tools for where it is, its skills and its memory.
    fn tools(&self, me: &Instance, skills_dir: PathBuf, memory: Arc<dyn MemoryPort>) -> Vec<Box<dyn Tool>> {
        self.tools_for(&me.id, &me.route, skills_dir, memory)
    }

    fn tools_for(&self, id: &str, route: &Arc<Mutex<Route>>, skills_dir: PathBuf, memory: Arc<dyn MemoryPort>) -> Vec<Box<dyn Tool>> {
        let mut tools = held(&self.tool, route);
        if let Some(profile) = self.profile.agent(id) {
            tools.extend(self.mcp.tools(&profile));
        }
        let dirs = vec![skills_dir];
        tools.push(Box::new(LoadSkill {
            skills: Box::new(move || scan_skills(&dirs)),
        }));
        tools.push(Box::new(TypedToolAdapter(Remember(memory.clone()))));
        tools.push(Box::new(TypedToolAdapter(RewriteMemory(memory))));
        tools
    }

    /// Keeps the turn that answered step `on` of its log as a case to replay: what it had been told before, what it was
    /// asked, what it did, and what the user says it should have done.
    pub async fn mark_wrong_async(self: &Arc<Self>, agent: Option<&str>, on: i64, want: &str) -> Result<OrchestratorEval, ApiError> {
        let want = want.trim().to_string();
        if want.is_empty() {
            return Err(refused(BizCode::Refused, t("server.session.host.markNeedsWords", &[])));
        }
        let id = self.target(agent);
        let label = self.profile.agent(&id).map(|a| a.name).unwrap_or_else(|| id.clone());
        let log = self.runtime.trajectory().events_async(&id, None).await.unwrap_or_default();
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
        let entries = self.execution.entries(&id).map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        let turns = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| matches!(e, execution::EvalEntry::TurnStarted { input } if input.contains(&asked.text)));
        let Some((at, execution::EvalEntry::TurnStarted { input })) = turns.clone().nth(nth).or_else(|| turns.clone().next_back()) else {
            return Err(refused(
                BizCode::Refused,
                t("server.session.host.notInConversation", &[("on", on.into()), ("label", label.into())]),
            ));
        };
        let model = self.model_of(&id).map_err(|e| refused(BizCode::Refused, e))?;
        let me = self.instance(&id);
        let memory = self.memory.port(&id, By::Orchestrator);
        let case = EvalCase {
            id: uuid::Uuid::now_v7().to_string(),
            created_at: self.ctx.now(),
            model,
            want,
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
        let case_id = case.id.clone();
        let file_for_write = file.clone();
        let written = self
            .ctx
            .task
            .spawn_blocking(move || {
                std::fs::create_dir_all(&dir).and_then(|()| {
                    use std::io::Write;
                    use std::os::unix::fs::OpenOptionsExt;
                    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file_for_write)?;
                    out.write_all(format!("{}\n", serde_json::to_string_pretty(&case).unwrap_or_default()).as_bytes())
                })
            })
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        written.map_err(|e| refused(BizCode::Refused, e.to_string()))?;
        Ok(OrchestratorEval {
            id: case_id,
            file: file.to_string_lossy().into_owned(),
        })
    }

    fn brain_at(&self, id: &str, route: &Arc<Mutex<Route>>, model: &str) -> Brain {
        let home = self.home.join("agent").join(id);
        let skills_dir = home.join("skills");
        if !skills_dir.is_dir() {
            let _ = std::fs::create_dir_all(&skills_dir);
            let _ = SKILLS.extract(&skills_dir);
        }
        let memory = self.memory.port(id, By::Orchestrator);
        let mut brain = Brain::new(self.client(), model, self.system_prompt(id, &home, memory.as_ref()));
        brain.tools = self.tools_for(id, route, skills_dir, memory);
        brain
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
                    {
                        let mut q = me.queue.lock();
                        if !q.is_empty() {
                            q.clear();
                            break true;
                        }
                    }
                    let check_o = orch.clone();
                    let check_id = me.id.clone();
                    let saved = orch
                        .ctx
                        .task
                        .spawn_blocking(move || check_o.execution.has_inputs(&check_id).unwrap_or(false))
                        .await
                        .unwrap_or(false);
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
                let inst = me.clone();
                let orch_batch = orch.clone();
                let batch = orch
                    .ctx
                    .task
                    .spawn_blocking(move || {
                        if orch_batch.closed.load(Ordering::Acquire) {
                            return None;
                        }
                        match orch_batch.execution.batch(&inst.id) {
                            Ok(b) => Some(b),
                            Err(e) => {
                                orch_batch.ctx.live.publish_notice(orch_batch.ctx.now(), NoticeLevel::Error, e.to_string());
                                None
                            }
                        }
                    })
                    .await
                    .ok()
                    .flatten();
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

    /// The farm as it is shown before an input (`situation`).
    async fn situation_async(&self, channel: &str) -> String {
        let mut agents = vec![];
        for a in self.profile.agents() {
            let assessed = self.profile.fleet.assess_async(&a).await;
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
        let roster = self.tool.roster_async().await;
        let default = self.chat.default_channel();
        let channels = self.chat.channels();
        let mut by_channel = Vec::with_capacity(channels.len());
        for c in &channels {
            let mut theirs = Vec::new();
            for h in roster.iter().filter(|h| h.channel_id().unwrap_or(default.as_str()) == c.id) {
                theirs.push(self.tool.session_line_async(h).await);
            }
            let head = words::channel_line(&c.name, c.default, &c.description, &c.repo);
            by_channel.push(format!(
                "{head}\n{}",
                if theirs.is_empty() {
                    words::NO_HELPERS.to_string()
                } else {
                    theirs.join("\n")
                }
            ));
        }
        let repos = self.repo.list_async().await;
        let folders = if repos.is_empty() {
            words::NO_REPOS.to_string()
        } else {
            repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join("、")
        };
        let (direct, target) = self.chat.address_of(channel);
        words::whole(
            &self.repo.root().display().to_string(),
            &folders,
            &agents.join("\n"),
            &by_channel.join("\n"),
            &if direct { words::direct(&target) } else { target },
            &words::users_language(),
        )
    }

    /// The whole input of a turn on `batch`.
    async fn input_of_async(&self, me: &Instance, batch: &[Input]) -> String {
        let channel = batch.last().map(|i| i.channel.clone()).unwrap_or_default();
        let situation = self.situation_async(&channel).await;
        let shown = {
            let mut was = me.shown.lock();
            let delta = if was.is_empty() {
                situation.clone()
            } else {
                words::situation_delta(&was, &situation)
            };
            *was = situation;
            delta
        };
        let heard: Vec<String> = std::mem::take(&mut me.news.lock().lines);
        let news = if heard.is_empty() { String::new() } else { words::news(&heard.join("\n")) };
        let at = jiff::Timestamp::from_millisecond(self.ctx.now())
            .unwrap_or_default()
            .to_zoned_datetime(jiff::tz::TimeZone::system());
        let time = at.strftime("%Y/%-m/%-d %H:%M").to_string();
        let asked: Vec<String> = batch.iter().map(|i| format!("{}{}", i.source.head(), i.line)).collect();
        [words::now_line(&time), shown, news, asked.join("\n\n")]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    async fn turn_async(&self, me: &Instance, pending: Vec<(String, Input)>) -> Vec<String> {
        let (requests, batch): (Vec<_>, Vec<_>) = pending.into_iter().unzip();
        let Some(last) = batch.last().cloned() else { return Vec::new() };
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
            let mut open = self.ports.lock();
            batch.iter().filter_map(|i| i.port.as_ref().and_then(|p| open.remove(p))).collect()
        };
        *me.route.lock() = route.clone();
        let cannot_reason = if (self.key)().is_none_or(|k| k.trim().is_empty()) && self.client.is_none() {
            Some(t("server.orchestrator.noKey", &[]))
        } else {
            match self.model_of(&me.id) {
                Ok(_) => None,
                Err(why) => Some(t("server.orchestrator.cannotStart", &[("why", why.into())])),
            }
        };
        if let Some(why) = cannot_reason {
            let _ = self.execution.finish_inputs(&requests, false, &serde_json::json!({"error": why}));
            // The round is still in its log, failed: what it was told can be read and judged there.
            let run = Run::new_async(self, me, &route).await;
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
        let input = execution::TurnInput {
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
        let o = self.clone();
        self.ctx
            .task
            .spawn_blocking(move || o.stop(input.agent.as_deref()))
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        Ok(())
    }

    pub(crate) async fn approvals_endpoint_async(self: &Arc<Self>, input: OrchestratorApprovalListInput) -> Result<Vec<OrchestratorApproval>, ApiError> {
        let o = self.clone();
        self.ctx
            .task
            .spawn_blocking(move || o.execution.approvals(input.conversation_id.as_deref()))
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
    }

    pub(crate) async fn resolve_approval_endpoint_async(self: &Arc<Self>, input: OrchestratorApprovalResolveInput) -> Result<(), ApiError> {
        let o = self.clone();
        self.ctx
            .task
            .spawn_blocking(move || o.execution.resolve_approval(input))
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?
    }

    pub(crate) async fn eval_create_endpoint_async(self: &Arc<Self>, input: OrchestratorEvalRequest) -> Result<OrchestratorEval, ApiError> {
        self.mark_wrong_async(input.agent.as_deref(), input.on.0 as i64, &input.want).await
    }
}

impl VoiceOrchestratorPort for Orchestrator {
    fn brief<'a>(&'a self, line: String, wait: std::time::Duration) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let me = self.me.upgrade()?;
            let reply = me.brief(line)?;
            if wait.is_zero() {
                Some(String::new())
            } else {
                Some(reply.whole_async(wait).await)
            }
        })
    }
}

impl CronOrchestratorPort for Orchestrator {
    fn hear_cron(&self, agent: &str, channel: &str, line: &str) -> bool {
        let Some(me) = self.me.upgrade() else { return false };
        me.hear(Input {
            agent: Some(agent.to_string()),
            channel: channel.to_string(),
            source: Source::Cron,
            line: line.to_string(),
            user: false,
            picked: None,
            messages: vec![],
            port: None,
        })
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
    durable: bool,
    /// The live answers this turn's words also go to, read out as they are.
    ports: Vec<flume::Sender<String>>,
    /// Per-turn `oar-voyage/3` JSONL recorder (`<home>/records/<id>.jsonl`).
    recorder: Mutex<Option<vibevalley_runtime::oar::record::Recorder>>,
    record_seq: std::sync::atomic::AtomicU64,
}

impl<'a> Run<'a> {
    async fn new_async(o: &'a Orchestrator, me: &'a Instance, route: &'a Route) -> Run<'a> {
        Self::start_async(o, me, route, format!("run-{}", uuid::Uuid::now_v7()), None).await
    }

    fn open_recorder(o: &Orchestrator, id: &str, model: Option<&str>) -> Option<vibevalley_runtime::oar::record::Recorder> {
        let dir = o.home.join("records");
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join(format!("{id}.jsonl"));
        let file = vibevalley_runtime::oar::record::open_file(Some(&path)).ok()??;
        vibevalley_runtime::oar::record::Recorder::start(Some(file), ORCHESTRATOR_RUNTIME, id, o.repo.root(), model)
    }

    async fn start_async(o: &'a Orchestrator, me: &'a Instance, route: &'a Route, run: String, model: Option<&str>) -> Self {
        let started = o
            .runtime
            .trajectory()
            .events_async(&me.id, Some(&run))
            .await
            .is_some_and(|steps| steps.iter().any(|step| step.r#type == SessionEventType::RunStart));
        let recorder = Self::open_recorder(o, &me.id, model);
        let r = Run {
            o,
            me,
            route,
            run,
            said: String::new(),
            calls: 0,
            durable: false,
            ports: vec![],
            recorder: Mutex::new(recorder),
            record_seq: std::sync::atomic::AtomicU64::new(0),
        };
        if !started {
            r.step(Step::RunStarted { run: r.run.clone() });
        }
        r.phase(Some(SessionAction::Thinking));
        r
    }

    fn step(&self, step: Step) {
        self.o.runtime.trajectory().step(&self.me.id, "", step);
    }

    fn record_event(&self, event: &vibevalley_runtime::oar::Event) {
        let mut slot = self.recorder.lock();
        let Some(rec) = slot.as_mut() else { return };
        let mut row = vibevalley_runtime::oar::voyage::Record::event(self.me.id.clone(), event);
        row.seq = self.record_seq.fetch_add(1, Ordering::Relaxed);
        row.span_id = self.run.clone();
        let _ = rec.write(&row);
    }

    fn agent(&self, kind: vibevalley_runtime::oar::EventKind) {
        let event = vibevalley_runtime::oar::Event {
            seq: 0,
            agent_path: vec![],
            at_ms: self.o.ctx.now() as u64,
            kind,
        };
        self.record_event(&event);
        self.step(Step::Agent(event));
    }

    async fn asked_async(&self, text: &str) {
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

    fn phase(&self, doing: Option<SessionAction>) {
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

    async fn on_async(&mut self, e: AgentEvent) {
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

    async fn finish_async(mut self, outcome: vibevalley_runtime::agent::Result<TurnOutcome>) {
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
