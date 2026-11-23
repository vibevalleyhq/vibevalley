//! `cron.*` and the ticker: each cron, when due, keeps one issue going or
//! nudges the channel's orchestrator. The rules (when it is due, what is wrong
//! with a request) are `vibevalley-cron`'s; crons live in `server.db`'s `cron`
//! table and own the `issue_id` link (`references issue(id) on delete set null`).

mod db;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use vibevalley_core::{SharedClock, system_clock};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ActorKind, ApiError, BizCode, Caller, Cron, CronRequest, Fact, FactCronChanged, FactCronRemoved, IssueStatus, NoticeLevel, Preview, ops,
};

use crate::Hub;
use crate::base::{LookIn, ServerDb, Ticker, internal, missing};
use crate::modules::collab::channel::{Chat, Noticing};
use crate::modules::team::agent::Agents;
use crate::modules::work::issue::{Board, NewIssue};
use crate::ports::CronOrchestratorPort;

pub const DEFAULT_CHANNEL: &str = "general";
const TICK: Duration = Duration::from_secs(20);

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::CronRefused, text)
}

/// `$TZ` when it names a zone, else the system's.
fn local_zone() -> String {
    std::env::var("TZ")
        .ok()
        .filter(|tz| !tz.is_empty() && vibevalley_core::cron::given_zone(tz).is_some())
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
    db: Arc<ServerDb>,
    links: Arc<Mutex<CronLinks>>,
    hub: Weak<Hub>,
    board: Board,
    agents: Arc<Agents>,
    /// The ticker, the endpoints and the tools all change the list.
    lock: Mutex<()>,
    chat: Option<Arc<Chat>>,
    orchestrator: Option<Arc<dyn CronOrchestratorPort>>,
    clock: SharedClock,
    closed: std::sync::atomic::AtomicBool,
    ticker: Mutex<Option<Ticker>>,
}

impl Crons {
    /// Opens `cron` on the shared `ServerDb`, puts stored crons into the hub's
    /// state, and registers `Issue.cron` projection on `board`. Constructed
    /// bottom-up with `chat` and `orchestrator` directly (zero late bindings).
    pub fn open(
        db: Arc<ServerDb>,
        hub: &Arc<Hub>,
        board: Board,
        agents: Arc<Agents>,
        chat: Option<Arc<Chat>>,
        orchestrator: Option<Arc<dyn CronOrchestratorPort>>,
    ) -> Result<Arc<Crons>, ApiError> {
        Self::open_with_clock(db, hub, board, agents, chat, orchestrator, system_clock())
    }

    /// Same as [`Crons::open`], injecting an explicit wall [`Clock`](vibevalley_core::Clock).
    pub fn open_with_clock(
        db: Arc<ServerDb>,
        hub: &Arc<Hub>,
        board: Board,
        agents: Arc<Agents>,
        chat: Option<Arc<Chat>>,
        orchestrator: Option<Arc<dyn CronOrchestratorPort>>,
        clock: SharedClock,
    ) -> Result<Arc<Crons>, ApiError> {
        let stored = db.run(async |conn| db::list(conn).await).map_err(internal)?;
        let links = Arc::new(Mutex::new(CronLinks::default()));
        let at = clock.now_ms();
        let mut facts = Vec::with_capacity(stored.len());
        {
            let mut map = links.lock();
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
        board.use_cron_of_issue(Arc::new(move |issue_id| lookup_links.lock().cron_of_issue.get(issue_id).cloned()));
        Ok(Arc::new(Crons {
            db,
            links,
            hub: Arc::downgrade(hub),
            board,
            agents,
            lock: Mutex::new(()),
            chat,
            orchestrator,
            clock,
            closed: Default::default(),
            ticker: Mutex::new(None),
        }))
    }

    /// Stops the ticker.
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(ticker) = self.ticker.lock().take() {
            ticker.stop();
        }
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.hub.upgrade()
    }

    pub fn list(&self) -> Vec<Cron> {
        self.hub().map(|h| h.read(|s| s.crons.clone())).unwrap_or_default()
    }

    pub fn issue_of(&self, cron_id: &str) -> Option<String> {
        self.links.lock().issue_of_cron.get(cron_id).cloned()
    }

    pub fn cron_of(&self, issue_id: &str) -> Option<String> {
        self.links.lock().cron_of_issue.get(issue_id).cloned()
    }

    /// Persists `cron` (keeping its linked issue, if any) and tells the state.
    fn put(&self, cron: Cron) -> Result<(), ApiError> {
        let issue_id = self.issue_of(&cron.id);
        self.db.run(async |conn| db::upsert(conn, &cron, issue_id.as_deref()).await).map_err(internal)?;
        if let Some(hub) = self.hub() {
            hub.apply(vec![Fact::CronChanged(FactCronChanged { at: self.clock.now_ms(), cron })]);
        }
        Ok(())
    }

    fn link_issue(&self, cron_id: &str, issue_id: Option<&str>) -> Result<(), ApiError> {
        self.db.run(async |conn| db::set_issue(conn, cron_id, issue_id).await).map_err(internal)?;
        let prev = self.links.lock().link(cron_id, issue_id);
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
        let _l = self.lock.lock();
        let at = self.clock.now_ms();
        let rules = vibevalley_core::cron_request_to_rules(&req);
        let problem = vibevalley_core::cron::cron_problem(&rules, at);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let (channel, channel_name, channel_repo) = match &self.chat {
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
        let pending = vibevalley_core::cron::needs_ok(&rules, by == ActorKind::User);
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
        let _l = self.lock.lock();
        let was = self.find(id)?;
        let mut cron = Cron {
            enabled,
            pending: was.pending && !enabled,
            ..was.clone()
        };
        if enabled && !was.enabled && !matches!(was.when, vibevalley_protocol::CronWhen::Once(_)) {
            cron.last_run = Some(self.clock.now_ms());
        }
        self.put(cron.clone())?;
        Ok(cron)
    }

    pub fn remove(&self, id: &str) -> Result<Cron, ApiError> {
        let _l = self.lock.lock();
        let was = self.find(id)?;
        self.db.run(async |conn| db::remove(conn, id).await).map_err(internal)?;
        let prev_issue = self.links.lock().link(id, None);
        if let Some(hub) = self.hub() {
            hub.apply(vec![Fact::CronRemoved(FactCronRemoved {
                at: self.clock.now_ms(),
                id: id.into(),
            })]);
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
                    ("when", vibevalley_core::cron::when_text(&rules.when, &rules.tz).into()),
                ],
            )],
        })
    }

    /// Runs every cron due now, each once however many runs it missed.
    pub fn tick(&self) {
        let _l = self.lock.lock();
        let at = self.clock.now_ms();
        let all = self.list();
        let rules: Vec<vibevalley_core::cron::Cron> = all.iter().map(vibevalley_core::cron_to_rules).collect();
        for due in vibevalley_core::cron::due_crons(&rules, at) {
            let missed = vibevalley_core::cron::is_missed(due, at);
            let after = vibevalley_core::cron_from_rules(vibevalley_core::cron::after_run(due, at));
            if let Err(e) = self.put(after.clone()) {
                // Not kept: due again at the next tick.
                if let Some(hub) = self.hub() {
                    hub.notice(NoticeLevel::Warn, format!("cron {}: {}", after.id, e.message));
                }
                continue;
            }
            let words = vibevalley_core::cron::due_text(due, missed);
            if let Err(e) = self.scheduled(&after, &words)
                && let Some(hub) = self.hub()
            {
                hub.notice(NoticeLevel::Warn, format!("{}: {}", after.name, e.message));
            }
        }
    }

    /// A cron for no profile: its words said in its channel and handed to
    /// the channel's orchestrator via `CronOrchestratorPort`.
    fn to_orchestrator(&self, cron: &Cron, words: &str) -> Result<(), ApiError> {
        let unserved = || ApiError::new(BizCode::ServiceUnavailable, "no orchestrator takes scheduled tasks".to_string());
        let o = self.orchestrator.as_ref().ok_or_else(unserved)?;
        let chat = self.chat.as_ref().ok_or_else(unserved)?;
        let channel = if chat.place(&cron.channel).is_some() {
            cron.channel.clone()
        } else {
            chat.default_channel()
        };
        chat.notice(Noticing {
            channel: channel.clone(),
            text: words.to_string(),
            code: "cron".into(),
            ..Default::default()
        });
        let agent = chat.orchestrator_in(&channel);
        if o.hear_cron(&agent, &channel, words) { Ok(()) } else { Err(unserved()) }
    }

    /// `scheduled`: the issue the cron owns, started, reopened or told;
    /// else a new one linked back to `cron.issue_id`.
    fn scheduled(&self, cron: &Cron, words: &str) -> Result<(), ApiError> {
        let fail = |e: crate::modules::work::ledger::BoardError| match e {
            crate::modules::work::ledger::BoardError::Api(e) => e,
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
    hub.on::<ops::CronCreate>(move |ctx, req| {
        let by = match ctx.caller {
            Caller::User | Caller::Remote => ActorKind::User,
            Caller::Orchestrator | Caller::Session => ActorKind::Agent,
        };
        c.add(req, by)
    });
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
        let weak = Arc::downgrade(&crons);
        let ticker = Ticker::spawn_on(hub, TICK, true, move || {
            let Some(c) = weak.upgrade() else { return false };
            if c.hub.strong_count() == 0 || c.closed.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            c.tick();
            true
        });
        *crons.ticker.lock() = Some(ticker);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use vibevalley_core::{Clock, ManualClock};
    use vibevalley_protocol::{CronRequest, CronWhen, CronWhenOnce};

    use super::*;
    use crate::ServerConfig;

    struct CountingOrchestrator {
        heard: AtomicUsize,
    }

    impl CronOrchestratorPort for CountingOrchestrator {
        fn hear_cron(&self, _agent: &str, _channel: &str, _words: &str) -> bool {
            self.heard.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    #[test]
    fn manual_clock_drives_once_due_execution_and_reenable_timestamps_without_sleep() {
        vibevalley_i18n::set_locale("en");
        let dir = tempfile::tempdir().unwrap();
        let started = crate::start(ServerConfig {
            probe_runtimes: false,
            orchestrator_listens: false,
            link_previews: false,
            tick_crons: false,
            ..ServerConfig::under(dir.path())
        })
        .unwrap();

        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let orchestrator = Arc::new(CountingOrchestrator { heard: AtomicUsize::new(0) });
        let crons = Crons::open_with_clock(
            started.db.clone(),
            &started.hub,
            started.board.clone(),
            started.agents.clone(),
            Some(started.chat.clone()),
            Some(orchestrator.clone()),
            clock.clone(),
        )
        .unwrap();

        let past = crons.add(
            CronRequest {
                name: "too late".into(),
                text: "expired".into(),
                channel: None,
                agent: None,
                repo: None,
                when: CronWhen::Once(CronWhenOnce { at: clock.now_ms() - 1 }),
                tz: None,
            },
            ActorKind::User,
        );
        assert_eq!(past.unwrap_err().biz_code, BizCode::CronRefused);

        let due_at = clock.now_ms() + 60_000;
        let once = crons
            .add(
                CronRequest {
                    name: "standup".into(),
                    text: "post standup notes".into(),
                    channel: None,
                    agent: None,
                    repo: None,
                    when: CronWhen::Once(CronWhenOnce { at: due_at }),
                    tz: None,
                },
                ActorKind::User,
            )
            .unwrap();
        assert_eq!(once.created, 1_700_000_000_000);
        assert!(once.enabled);

        // Before the deadline, tick does not fire.
        clock.advance(Duration::from_millis(59_999));
        crons.tick();
        assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 0);

        // At the deadline, tick fires exactly once and disables the one-shot cron.
        clock.advance(Duration::from_millis(1));
        crons.tick();
        assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 1);
        let after = crons.find(&once.id).unwrap();
        assert!(!after.enabled);
        assert_eq!(after.last_run, Some(due_at));

        // Subsequent ticks do not re-fire.
        clock.advance(Duration::from_secs(60));
        crons.tick();
        assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 1);

        crons.close();
        started.close();
    }
}
