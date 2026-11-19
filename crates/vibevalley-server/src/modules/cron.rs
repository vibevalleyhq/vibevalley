//! `cron.*` and the ticker (VibeValley `modules/issue/cron.ts`,
//! `dispatch.ts` `scheduled`): each cron, when due, keeps one issue going.
//! The rules (when it is due, what is wrong with a request) are
//! `vibevalley-cron`'s; crons are kept in `<home>/crons.json`.
//!
//! A cron's channel is a channel's id, resolved as the user names it once
//! the chat is attached ([`Crons::attach_chat`]); before that it is the
//! name given (`general` when none). A cron for the orchestrator (no
//! profile) is said in its channel and handed to the orchestrator.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use vibevalley_i18n::t;
use vibevalley_protocol::{ActorKind, ApiError, BizCode, Cron, CronRequest, Fact, FactCronChanged, FactCronRemoved, IssueStatus, NoticeLevel, Preview, ops};

use crate::base::{LookIn, missing};
use crate::modules::agent::Agents;
use crate::modules::issue::{Board, NewIssue};
use crate::{Hub, lock, now};

pub const DEFAULT_CHANNEL: &str = "general";
const TICK: Duration = Duration::from_secs(20);

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::CronRefused, text)
}

/// `$TZ` when it names a zone, else the system's.
fn local_zone() -> String {
    std::env::var("TZ")
        .ok()
        .filter(|tz| !tz.is_empty() && vibevalley_cron::given_zone(tz).is_some())
        .or_else(|| jiff::tz::TimeZone::system().iana_name().map(String::from))
        .unwrap_or_else(|| "UTC".into())
}

pub struct Crons {
    file: PathBuf,
    hub: Weak<Hub>,
    board: Board,
    agents: Arc<Agents>,
    /// The ticker, the endpoints and the tools all change the list.
    lock: Mutex<()>,
    chat: std::sync::OnceLock<Weak<crate::modules::channel::Chat>>,
    orchestrator: std::sync::OnceLock<Weak<crate::modules::orchestrator::Orchestrator>>,
    closed: std::sync::atomic::AtomicBool,
    stop: Mutex<Option<flume::Sender<()>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Crons {
    /// The crons kept under `home`, put into the hub's state.
    pub fn open(home: &Path, hub: &Arc<Hub>, board: Board, agents: Arc<Agents>) -> Arc<Crons> {
        let file = home.join("crons.json");
        // A cron this code cannot read any more is left out.
        let kept: Vec<serde_json::Value> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let at = now();
        let facts: Vec<Fact> = kept
            .into_iter()
            .filter_map(|v| serde_json::from_value::<Cron>(v).ok())
            .map(|cron| Fact::CronChanged(FactCronChanged { at, cron }))
            .collect();
        hub.apply(facts);
        Arc::new(Crons {
            file,
            hub: Arc::downgrade(hub),
            board,
            agents,
            lock: Mutex::new(()),
            chat: Default::default(),
            orchestrator: Default::default(),
            closed: Default::default(),
            stop: Mutex::new(None),
            thread: Mutex::new(None),
        })
    }

    /// Stops the ticker.
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = lock(&self.stop).take();
        if let Some(handle) = lock(&self.thread).take()
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }

    /// The chat a cron's channel is found in.
    pub fn attach_chat(&self, chat: &Arc<crate::modules::channel::Chat>) {
        let _ = self.chat.set(Arc::downgrade(chat));
    }

    /// Who a cron for no profile goes to.
    pub fn attach_orchestrator(&self, o: &Arc<crate::modules::orchestrator::Orchestrator>) {
        let _ = self.orchestrator.set(Arc::downgrade(o));
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.hub.upgrade()
    }

    pub fn list(&self) -> Vec<Cron> {
        self.hub().map(|h| h.read(|s| s.crons.clone())).unwrap_or_default()
    }

    fn save(&self, all: &[Cron]) -> Result<(), ApiError> {
        let body = serde_json::to_string_pretty(all).map_err(crate::base::internal)?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, body)
            .and_then(|_| std::fs::rename(&tmp, &self.file))
            .map_err(crate::base::internal)
    }

    /// Keeps `cron` (replacing one with its id) and tells the state.
    fn put(&self, cron: Cron) -> Result<(), ApiError> {
        let mut all = self.list();
        all.retain(|c| c.id != cron.id);
        all.push(cron.clone());
        self.save(&all)?;
        if let Some(hub) = self.hub() {
            hub.apply(vec![Fact::CronChanged(FactCronChanged { at: now(), cron })]);
        }
        Ok(())
    }

    fn find(&self, id: &str) -> Result<Cron, ApiError> {
        self.list()
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| missing(t("server.cron.noCron", &[("id", id.into())]), LookIn::Cron))
    }

    /// `add`: `by` is who asks, and on whose word (`needsOK`).
    pub fn add(&self, req: CronRequest, by: ActorKind) -> Result<Cron, ApiError> {
        let _l = lock(&self.lock);
        let at = now();
        let rules = vibevalley_core::cron_request_to_rules(&req);
        let problem = vibevalley_cron::cron_problem(&rules, at);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let (channel, channel_name, channel_repo) = match self.chat.get().and_then(Weak::upgrade) {
            // A channel as the user names it (general, #general) as well as by id.
            Some(chat) => {
                let want = match req.channel.as_deref() {
                    None => chat.default_channel(),
                    Some(c) => chat.place_of(vibevalley_protocol::USER_ID, c)?,
                };
                let found = chat
                    .channels()
                    .into_iter()
                    .find(|c| c.id == want)
                    .ok_or_else(|| refused(t("server.cron.noChannel", &[("name", want.as_str().into())])).with_next(vec![LookIn::Channel.next()]))?;
                (found.id, found.name, found.repo)
            }
            None => {
                let named = req.channel.as_deref().map(|c| c.trim().trim_start_matches('#')).filter(|c| !c.is_empty());
                let name = named.unwrap_or(DEFAULT_CHANNEL).to_string();
                (name.clone(), name, String::new())
            }
        };
        let named = req.agent.as_deref().unwrap_or("").trim();
        let agent = if named.is_empty() {
            None
        } else {
            let agents = self.agents.profiles.agents();
            let found = agents.iter().find(|a| a.id == named).or_else(|| agents.iter().find(|a| a.name == named));
            Some(
                found
                    .cloned()
                    .ok_or_else(|| refused(t("server.cron.noProfile", &[("name", named.into())])).with_next(vec![LookIn::Agent.next()]))?,
            )
        };
        let repo = req.repo.as_deref().unwrap_or("").trim().to_string();
        if agent.is_some() && repo.is_empty() && channel_repo.is_empty() {
            return Err(refused(t("server.cron.noRepo", &[("channel", channel_name.into())])));
        }
        let pending = vibevalley_cron::needs_ok(&rules, by == ActorKind::User);
        let cron = Cron {
            id: uuid::Uuid::now_v7().to_string(),
            name: req.name.trim().into(),
            text: req.text.trim().into(),
            channel,
            agent: agent.map(|a| a.id),
            repo: Some(repo).filter(|r| !r.is_empty()),
            when: req.when,
            tz: req.tz.unwrap_or_else(local_zone),
            enabled: !pending,
            created: at,
            last_run: None,
            by,
            pending,
        };
        self.put(cron.clone())?;
        Ok(cron)
    }

    /// Turned on is the user's yes; switched back on, it counts from now.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<Cron, ApiError> {
        let _l = lock(&self.lock);
        let was = self.find(id)?;
        let mut cron = Cron {
            enabled,
            pending: was.pending && !enabled,
            ..was.clone()
        };
        if enabled && !was.enabled && !matches!(was.when, vibevalley_protocol::CronWhen::Once(_)) {
            cron.last_run = Some(now());
        }
        self.put(cron.clone())?;
        Ok(cron)
    }

    pub fn remove(&self, id: &str) -> Result<Cron, ApiError> {
        let _l = lock(&self.lock);
        let was = self.find(id)?;
        let mut all = self.list();
        all.retain(|c| c.id != id);
        self.save(&all)?;
        if let Some(hub) = self.hub() {
            hub.apply(vec![Fact::CronRemoved(FactCronRemoved { at: now(), id: id.into() })]);
        }
        Ok(was)
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let was = self.find(id)?;
        let rules = vibevalley_core::cron_to_rules(&was);
        Ok(Preview {
            does: vec![t(
                "server.cron.removeWhen",
                &[
                    ("name", was.name.clone().into()),
                    ("when", vibevalley_cron::when_text(&rules.when, &rules.tz).into()),
                ],
            )],
        })
    }

    /// Runs every cron due now, each once however many runs it missed.
    pub fn tick(&self) {
        let _l = lock(&self.lock);
        let at = now();
        let all = self.list();
        let rules: Vec<vibevalley_cron::Cron> = all.iter().map(vibevalley_core::cron_to_rules).collect();
        for due in vibevalley_cron::due_crons(&rules, at) {
            let missed = vibevalley_cron::is_missed(due, at);
            let after = vibevalley_core::cron_from_rules(vibevalley_cron::after_run(due, at));
            if let Err(e) = self.put(after.clone()) {
                // Not kept: due again at the next tick.
                if let Some(hub) = self.hub() {
                    hub.notice(NoticeLevel::Warn, format!("cron {}: {}", after.id, e.message));
                }
                continue;
            }
            let words = vibevalley_cron::due_text(due, missed);
            if let Err(e) = self.scheduled(&after, &words)
                && let Some(hub) = self.hub()
            {
                hub.notice(NoticeLevel::Warn, format!("{}: {}", after.name, e.message));
            }
        }
    }

    /// A cron for no profile: its words said in its channel and handed to
    /// the channel's orchestrator.
    fn to_orchestrator(&self, cron: &Cron, words: &str) -> Result<(), ApiError> {
        use crate::modules::orchestrator::{Input, words::Source};
        let unserved = || ApiError::new(BizCode::ServiceUnavailable, "no orchestrator takes scheduled tasks".to_string());
        let o = self.orchestrator.get().and_then(Weak::upgrade).ok_or_else(unserved)?;
        let chat = self.chat.get().and_then(Weak::upgrade).ok_or_else(unserved)?;
        let channel = if chat.place(&cron.channel).is_some() {
            cron.channel.clone()
        } else {
            chat.default_channel()
        };
        chat.notice(crate::modules::channel::Noticing {
            channel: channel.clone(),
            text: words.to_string(),
            code: "cron".into(),
            ..Default::default()
        });
        let input = Input {
            agent: Some(chat.orchestrator_in(&channel)),
            channel,
            source: Source::Cron,
            line: words.to_string(),
            user: false,
            picked: None,
            messages: vec![],
            port: None,
        };
        if o.hear(input) { Ok(()) } else { Err(unserved()) }
    }

    /// `scheduled`: the issue the cron made last, started, reopened or told;
    /// else a new one.
    fn scheduled(&self, cron: &Cron, words: &str) -> Result<(), ApiError> {
        let fail = |e: crate::modules::ledger::BoardError| match e {
            crate::modules::ledger::BoardError::Api(e) => e,
            e => ApiError::new(BizCode::IssueRefused, e.to_string()),
        };
        let Some(agent) = &cron.agent else { return self.to_orchestrator(cron, words) };
        let found = self.board.read(|s| {
            s.issues
                .iter()
                .filter(|i| i.cron.as_deref() == Some(cron.id.as_str()))
                .max_by_key(|i| i.number)
                .cloned()
        });
        let Some(issue) = found else {
            let made = self
                .board
                .create(NewIssue {
                    title: cron.name.clone(),
                    description: cron.text.clone(),
                    repo: cron.repo.clone().map(PathBuf::from),
                    agent: agent.clone(),
                    cron: Some(cron.id.clone()),
                    ..Default::default()
                })
                .map_err(fail)?;
            self.board.move_to(&made.id, IssueStatus::Todo, None).map_err(fail)?;
            return Ok(());
        };
        match issue.status {
            IssueStatus::Backlog => self.board.move_to(&issue.id, IssueStatus::Todo, None).map(|_| ()),
            // Waiting for room: it starts when there is some.
            IssueStatus::Todo => Ok(()),
            s if s.is_closed() => self.board.move_to(&issue.id, IssueStatus::Todo, Some(words)).map(|_| ()),
            _ => self.board.tell(&issue.id, words),
        }
        .map_err(fail)
    }
}

/// Every `cron.*` endpoint, and the ticker every 20 s until the hub goes.
pub fn install(hub: &Arc<Hub>, crons: Arc<Crons>, tick: bool) {
    let c = crons.clone();
    hub.on::<ops::CronCreate>(move |_, req| c.add(req, ActorKind::User));
    let c = crons.clone();
    hub.on::<ops::CronList>(move |_, ()| Ok(c.list()));
    let c = crons.clone();
    hub.on::<ops::CronUpdate>(move |_, input| {
        match input.enabled {
            Some(enabled) => {
                c.set_enabled(&input.id, enabled)?;
            }
            None => {
                c.find(&input.id)?;
            }
        }
        Ok(())
    });
    let c = crons.clone();
    hub.on::<ops::CronDelete>(move |_, input| c.remove(&input.id).map(|_| ()));
    let c = crons.clone();
    hub.on::<ops::CronPreviewDelete>(move |_, input| c.preview_remove(&input.id));
    if tick {
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        *lock(&crons.stop) = Some(stop_tx);
        let weak = Arc::downgrade(&crons);
        if let Ok(handle) = std::thread::Builder::new().name("vibevalley-cron".into()).spawn(move || {
            loop {
                let Some(c) = weak.upgrade() else { return };
                if c.hub.strong_count() == 0 || c.closed.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                c.tick();
                drop(c);
                if !matches!(stop_rx.recv_timeout(TICK), Err(flume::RecvTimeoutError::Timeout)) {
                    return;
                }
            }
        }) {
            *lock(&crons.thread) = Some(handle);
        }
    }
}
