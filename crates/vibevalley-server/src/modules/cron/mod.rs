//! `cron.*` and the ticker: each cron, when due, keeps one issue going or
//! nudges the channel's orchestrator. The rules (when it is due, what is wrong
//! with a request) are `vibevalley-cron`'s; crons live in `server.db`'s `cron`
//! table and own the `issue_id` link (`references issue(id) on delete set null`).

mod db;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use pollster::block_on;
use sqlx::SqliteConnection;
use vibevalley_i18n::t;
use vibevalley_protocol::{ActorKind, ApiError, BizCode, Cron, CronRequest, Fact, FactCronChanged, FactCronRemoved, IssueStatus, NoticeLevel, Preview, ops};

use crate::base::{LookIn, internal, missing, open_sqlx_db};
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

#[derive(Default)]
struct CronLinks {
    issue_of_cron: HashMap<String, String>,
    cron_of_issue: HashMap<String, String>,
}

impl CronLinks {
    fn link(&mut self, cron_id: &str, issue_id: Option<&str>) -> Option<String> {
        let prev_issue = self.issue_of_cron.remove(cron_id);
        if let Some(prev) = &prev_issue {
            self.cron_of_issue.remove(prev);
        }
        if let Some(issue_id) = issue_id {
            if let Some(prev_cron) = self.cron_of_issue.insert(issue_id.into(), cron_id.into()) {
                self.issue_of_cron.remove(&prev_cron);
            }
            self.issue_of_cron.insert(cron_id.into(), issue_id.into());
        }
        prev_issue
    }
}

pub struct Crons {
    db: Mutex<SqliteConnection>,
    links: Arc<Mutex<CronLinks>>,
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
    /// Opens `cron` in `<home>/server.db`, puts stored crons into the hub's
    /// state, and registers `Issue.cron` projection on `board`.
    pub fn open(home: &Path, hub: &Arc<Hub>, board: Board, agents: Arc<Agents>) -> Result<Arc<Crons>, ApiError> {
        let mut conn = block_on(async {
            let mut db = open_sqlx_db(home).await?;
            sqlx::raw_sql(db::SCHEMA).execute(&mut db).await?;
            Ok::<_, sqlx::Error>(db)
        })
        .map_err(internal)?;
        let stored = db::list(&mut conn).map_err(internal)?;
        let links = Arc::new(Mutex::new(CronLinks::default()));
        let at = now();
        let mut facts = Vec::with_capacity(stored.len());
        {
            let mut map = lock(&links);
            for item in stored {
                if let Some(issue_id) = item.issue_id.as_deref() {
                    map.link(&item.cron.id, Some(issue_id));
                }
                facts.push(Fact::CronChanged(FactCronChanged { at, cron: item.cron }));
            }
        }
        if !facts.is_empty() {
            hub.apply(facts);
        }
        let lookup_links = links.clone();
        board.use_cron_of_issue(Arc::new(move |issue_id| lock(&lookup_links).cron_of_issue.get(issue_id).cloned()));
        Ok(Arc::new(Crons {
            db: Mutex::new(conn),
            links,
            hub: Arc::downgrade(hub),
            board,
            agents,
            lock: Mutex::new(()),
            chat: Default::default(),
            orchestrator: Default::default(),
            closed: Default::default(),
            stop: Mutex::new(None),
            thread: Mutex::new(None),
        }))
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

    pub fn issue_of(&self, cron_id: &str) -> Option<String> {
        lock(&self.links).issue_of_cron.get(cron_id).cloned()
    }

    pub fn cron_of(&self, issue_id: &str) -> Option<String> {
        lock(&self.links).cron_of_issue.get(issue_id).cloned()
    }

    /// Persists `cron` (keeping its linked issue, if any) and tells the state.
    fn put(&self, cron: Cron) -> Result<(), ApiError> {
        let issue_id = self.issue_of(&cron.id);
        db::upsert(&mut lock(&self.db), &cron, issue_id.as_deref()).map_err(internal)?;
        if let Some(hub) = self.hub() {
            hub.apply(vec![Fact::CronChanged(FactCronChanged { at: now(), cron })]);
        }
        Ok(())
    }

    fn link_issue(&self, cron_id: &str, issue_id: Option<&str>) -> Result<(), ApiError> {
        db::set_issue(&mut lock(&self.db), cron_id, issue_id).map_err(internal)?;
        let prev = lock(&self.links).link(cron_id, issue_id);
        if let Some(prev_id) = prev
            && prev_id.as_str() != issue_id.unwrap_or("")
        {
            self.board.refresh_issue(&prev_id);
        }
        if let Some(next_id) = issue_id {
            self.board.refresh_issue(next_id);
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
        db::remove(&mut lock(&self.db), id).map_err(internal)?;
        let prev_issue = lock(&self.links).link(id, None);
        if let Some(hub) = self.hub() {
            hub.apply(vec![Fact::CronRemoved(FactCronRemoved { at: now(), id: id.into() })]);
        }
        if let Some(issue_id) = prev_issue {
            self.board.refresh_issue(&issue_id);
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

    /// `scheduled`: the issue the cron owns, started, reopened or told;
    /// else a new one linked back to `cron.issue_id`.
    fn scheduled(&self, cron: &Cron, words: &str) -> Result<(), ApiError> {
        let fail = |e: crate::modules::ledger::BoardError| match e {
            crate::modules::ledger::BoardError::Api(e) => e,
            e => ApiError::new(BizCode::IssueRefused, e.to_string()),
        };
        let Some(agent) = &cron.agent else { return self.to_orchestrator(cron, words) };
        let found = self.issue_of(&cron.id).and_then(|id| self.board.issue(&id));
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
            self.link_issue(&cron.id, Some(&made.id))?;
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
