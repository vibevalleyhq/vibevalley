//! `cron.*` and the ticker: each cron, when due, keeps one issue going or
//! nudges the channel's orchestrator. The rules (when it is due, what is wrong
//! with a request) are `vibevalley-cron`'s; crons live in `server.db`'s `cron`
//! table and own the `issue_id` link (`references issue(id) on delete set null`).

pub(crate) mod db;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_core::{SharedClock, SliceMask, system_clock};
use vibevalley_i18n::t;
use vibevalley_protocol::{ActorKind, ApiError, BizCode, Caller, Cron, CronRequest, IssueStatus, NoticeLevel, Preview};

use crate::app::live::LiveOverlay;
use crate::app::port::{CronOrchestratorPort, CronToolPort};
use crate::app::refusal::{LookIn, missing};
use crate::app::runtime::Runtime;
use crate::app::slice::SliceProjector;
use crate::app::ticker::Ticker;
use crate::collab::channel::{Chat, Noticing};
use crate::db::ServerDb;
use crate::db::error::internal_db;
use crate::team::agent::AgentStore;
use crate::work::issue::{IssueStore, NewIssue};

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

pub struct CronStore {
    db: Arc<ServerDb>,
    crons: Mutex<Vec<Cron>>,
    links: Arc<Mutex<CronLinks>>,
    runtime: Arc<Runtime>,
    live: Arc<LiveOverlay>,
    projector: Arc<SliceProjector>,
    board: IssueStore,
    agents: Arc<AgentStore>,
    /// The ticker, the endpoints and the tools all change the list.
    lock: AsyncMutex<()>,
    chat: Option<Arc<Chat>>,
    orchestrator: Option<Arc<dyn CronOrchestratorPort>>,
    clock: SharedClock,
    closed: std::sync::atomic::AtomicBool,
    ticker: Mutex<Option<Ticker>>,
}

impl CronStore {
    /// Opens `cron` on the shared `ServerDb`, loads stored crons into the
    /// store's slice-projected list, and registers `Issue.cron` projection on `board`.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_async(
        db: Arc<ServerDb>,
        runtime: Arc<Runtime>,
        live: Arc<LiveOverlay>,
        projector: Arc<SliceProjector>,
        board: IssueStore,
        agents: Arc<AgentStore>,
        chat: Option<Arc<Chat>>,
        orchestrator: Option<Arc<dyn CronOrchestratorPort>>,
    ) -> Result<Arc<CronStore>, ApiError> {
        Self::open_with_clock_async(db, runtime, live, projector, board, agents, chat, orchestrator, system_clock()).await
    }

    /// Same as [`CronStore::open_async`], injecting an explicit wall [`Clock`](vibevalley_core::Clock).
    #[allow(clippy::too_many_arguments)]
    pub async fn open_with_clock_async(
        db: Arc<ServerDb>,
        runtime: Arc<Runtime>,
        live: Arc<LiveOverlay>,
        projector: Arc<SliceProjector>,
        board: IssueStore,
        agents: Arc<AgentStore>,
        chat: Option<Arc<Chat>>,
        orchestrator: Option<Arc<dyn CronOrchestratorPort>>,
        clock: SharedClock,
    ) -> Result<Arc<CronStore>, ApiError> {
        let stored = db::list(db.read_conn()).await.map_err(internal_db)?;
        let links = Arc::new(Mutex::new(CronLinks::default()));
        let mut crons = Vec::with_capacity(stored.len());
        let mut has_pending = false;
        {
            let mut map = links.lock();
            for item in stored {
                if let Some(issue_id) = item.issue_id.as_deref() {
                    map.link(&item.cron.id, Some(issue_id));
                }
                has_pending |= item.cron.pending;
                crons.push(item.cron);
            }
        }
        if !crons.is_empty() {
            let mut dirty = SliceMask::OPS;
            if has_pending {
                dirty |= SliceMask::INBOX;
            }
            projector.mark_dirty(dirty);
        }
        let lookup_links = links.clone();
        board
            .use_cron_of_issue_async(Arc::new(move |issue_id| lookup_links.lock().cron_of_issue.get(issue_id).cloned()))
            .await;
        Ok(Arc::new(CronStore {
            db,
            crons: Mutex::new(crons),
            links,
            runtime,
            live,
            projector,
            board,
            agents,
            lock: AsyncMutex::new(()),
            chat,
            orchestrator,
            clock,
            closed: Default::default(),
            ticker: Mutex::new(None),
        }))
    }

    /// Stops the ticker.
    pub async fn close_async(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::Relaxed);
        let ticker = self.ticker.lock().take();
        if let Some(ticker) = ticker {
            ticker.stop_async().await;
        }
    }

    pub fn list(&self) -> Vec<Cron> {
        self.crons.lock().clone()
    }

    pub fn issue_of(&self, cron_id: &str) -> Option<String> {
        self.links.lock().issue_of_cron.get(cron_id).cloned()
    }

    pub fn cron_of(&self, issue_id: &str) -> Option<String> {
        self.links.lock().cron_of_issue.get(issue_id).cloned()
    }

    /// Persists `cron` (keeping its linked issue, if any) and marks dirty slices.
    async fn put_async(&self, cron: Cron) -> Result<(), ApiError> {
        let issue_id = self.issue_of(&cron.id);
        db::upsert(self.db.write_conn(), &cron, issue_id.as_deref()).await.map_err(internal_db)?;
        let (changed, was_pending, is_pending) = {
            let mut list = self.crons.lock();
            let pending_after = cron.pending;
            match list.iter_mut().find(|c| c.id == cron.id) {
                Some(existing) if *existing == cron => (false, existing.pending, pending_after),
                Some(existing) => {
                    let prev = existing.pending;
                    *existing = cron;
                    (true, prev, pending_after)
                }
                None => {
                    list.push(cron);
                    (true, false, pending_after)
                }
            }
        };
        if changed {
            let mut dirty = SliceMask::OPS;
            if was_pending || is_pending {
                dirty |= SliceMask::INBOX;
            }
            self.projector.mark_dirty(dirty);
        }
        Ok(())
    }

    async fn link_issue_async(&self, cron_id: &str, issue_id: Option<&str>) -> Result<(), ApiError> {
        db::set_issue(self.db.write_conn(), cron_id, issue_id).await.map_err(internal_db)?;
        let prev = self.links.lock().link(cron_id, issue_id);
        if let Some(prev_id) = prev
            && prev_id.as_str() != issue_id.unwrap_or("")
        {
            self.board.refresh_issue_async(&prev_id).await;
        }
        if let Some(next_id) = issue_id {
            self.board.refresh_issue_async(next_id).await;
        }
        Ok(())
    }

    fn find(&self, id: &str) -> Result<Cron, ApiError> {
        self.list()
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| missing(t("server.cron.noCron", &[("id", id.into())]), LookIn::Cron))
    }

    /// `add_async`: `by` is who asks, and on whose word (`needsOK`).
    pub async fn add_async(&self, req: CronRequest, by: ActorKind) -> Result<Cron, ApiError> {
        let resolved_channel = match &self.chat {
            Some(chat) => Some(match req.channel.as_deref() {
                None => chat.default_channel(),
                Some(c) => chat.place_of_async(vibevalley_protocol::USER_ID, c).await?,
            }),
            None => None,
        };
        self.add_resolved_async(req, by, resolved_channel).await
    }

    async fn add_resolved_async(&self, req: CronRequest, by: ActorKind, resolved_channel: Option<String>) -> Result<Cron, ApiError> {
        let _l = self.lock.lock().await;
        let at = self.clock.now_ms();
        let rules = vibevalley_core::cron_request_to_rules(&req);
        let problem = vibevalley_core::cron::cron_problem(&rules, at);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let (channel, channel_name, channel_repo) = match (&self.chat, resolved_channel) {
            // A channel as the user names it (general, #general) as well as by id.
            (Some(chat), Some(want)) => {
                let found = chat
                    .channels()
                    .into_iter()
                    .find(|c| c.id == want)
                    .ok_or_else(|| refused(t("server.cron.noChannel", &[("name", want.as_str().into())])).with_next(vec![LookIn::Channel.next()]))?;
                (found.id, found.name, found.repo)
            }
            _ => {
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
        self.put_async(cron.clone()).await?;
        Ok(cron)
    }

    /// Turned on is the user's yes; switched back on, it counts from now.
    pub async fn set_enabled_async(&self, id: &str, enabled: bool) -> Result<Cron, ApiError> {
        let _l = self.lock.lock().await;
        let was = self.find(id)?;
        let mut cron = Cron {
            enabled,
            pending: was.pending && !enabled,
            ..was.clone()
        };
        if enabled && !was.enabled && !matches!(was.when, vibevalley_protocol::CronWhen::Once(_)) {
            cron.last_run = Some(self.clock.now_ms());
        }
        self.put_async(cron.clone()).await?;
        Ok(cron)
    }

    pub async fn remove_async(&self, id: &str) -> Result<Cron, ApiError> {
        let _l = self.lock.lock().await;
        let was = self.find(id)?;
        db::remove(self.db.write_conn(), id).await.map_err(internal_db)?;
        let prev_issue = self.links.lock().link(id, None);
        self.crons.lock().retain(|c| c.id != id);
        let mut dirty = SliceMask::OPS;
        if was.pending {
            dirty |= SliceMask::INBOX;
        }
        self.projector.mark_dirty(dirty);
        if let Some(issue_id) = prev_issue {
            self.board.refresh_issue_async(&issue_id).await;
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
    pub fn tick_async(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let _l = self.lock.lock().await;
            let at = self.clock.now_ms();
            let all = self.list();
            let rules: Vec<vibevalley_core::cron::Cron> = all.iter().map(vibevalley_core::cron_to_rules).collect();
            let due_runs: Vec<_> = vibevalley_core::cron::due_crons(&rules, at)
                .into_iter()
                .map(|due| {
                    let missed = vibevalley_core::cron::is_missed(due, at);
                    let after = vibevalley_core::cron_from_rules(vibevalley_core::cron::after_run(due, at));
                    let words = vibevalley_core::cron::due_text(due, missed);
                    (after, words)
                })
                .collect();
            for (after, words) in due_runs {
                if let Err(e) = self.put_async(after.clone()).await {
                    // Not kept: due again at the next tick.
                    self.live
                        .publish_notice(self.clock.now_ms(), NoticeLevel::Warn, format!("cron {}: {}", after.id, e.message));
                    continue;
                }
                if let Err(e) = self.scheduled_async(&after, &words).await {
                    self.live
                        .publish_notice(self.clock.now_ms(), NoticeLevel::Warn, format!("{}: {}", after.name, e.message));
                }
            }
        })
    }

    /// A cron for no profile: its words said in its channel and handed to
    /// the channel's orchestrator via `CronOrchestratorPort`.
    async fn to_orchestrator_async(&self, cron: &Cron, words: &str) -> Result<(), ApiError> {
        let unserved = || ApiError::new(BizCode::ServiceUnavailable, "no orchestrator takes scheduled tasks".to_string());
        let o = self.orchestrator.as_ref().ok_or_else(unserved)?;
        let chat = self.chat.as_ref().ok_or_else(unserved)?;
        let channel = if chat.place(&cron.channel).is_some() {
            cron.channel.clone()
        } else {
            chat.default_channel()
        };
        chat.notice_async(Noticing {
            channel: channel.clone(),
            text: words.to_string(),
            code: "cron".into(),
            ..Default::default()
        })
        .await;
        let agent = chat.orchestrator_in(&channel);
        if o.hear_cron(&agent, &channel, words) { Ok(()) } else { Err(unserved()) }
    }

    /// `scheduled_async`: the issue the cron owns, started, reopened or told;
    /// else a new one linked back to `cron.issue_id`.
    fn scheduled_async<'a>(&'a self, cron: &'a Cron, words: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ApiError>> + Send + 'a>> {
        Box::pin(async move {
            let fail = |e: crate::work::ledger::BoardError| match e {
                crate::work::ledger::BoardError::Api(e) => e,
                e => ApiError::new(BizCode::IssueRefused, e.to_string()),
            };
            let Some(agent) = &cron.agent else {
                return self.to_orchestrator_async(cron, words).await;
            };
            let found = match self.issue_of(&cron.id) {
                Some(id) => self.board.issue_async(&id).await.map_err(fail)?,
                None => None,
            };
            let Some(issue) = found else {
                let made = self
                    .board
                    .create_async(NewIssue {
                        title: cron.name.clone(),
                        description: cron.text.clone(),
                        repo: cron.repo.clone().map(PathBuf::from),
                        agent: agent.clone(),
                        cron: Some(cron.id.clone()),
                        ..Default::default()
                    })
                    .await
                    .map_err(fail)?;
                self.link_issue_async(&cron.id, Some(&made.id)).await?;
                self.board.move_to_async(&made.id, IssueStatus::Todo, None).await.map_err(fail)?;
                return Ok(());
            };
            match issue.status {
                IssueStatus::Backlog => self.board.move_to_async(&issue.id, IssueStatus::Todo, None).await.map(|_| ()),
                // Waiting for room: it starts when there is some.
                IssueStatus::Todo => Ok(()),
                s if s.is_closed() => self.board.move_to_async(&issue.id, IssueStatus::Todo, Some(words)).await.map(|_| ()),
                _ => self.board.tell_async(&issue.id, words).await,
            }
            .map_err(fail)
        })
    }

    pub(crate) async fn create_endpoint_async(&self, caller: Caller, req: CronRequest) -> Result<Cron, ApiError> {
        let by = match caller {
            Caller::User | Caller::Remote => ActorKind::User,
            Caller::Orchestrator | Caller::Session => ActorKind::Agent,
        };
        self.add_async(req, by).await
    }

    pub(crate) async fn list_endpoint_async(&self) -> Result<Vec<Cron>, ApiError> {
        Ok(self.list())
    }

    pub(crate) async fn update_endpoint_async(&self, id: &str, enabled: Option<bool>) -> Result<(), ApiError> {
        match enabled {
            Some(enabled) => {
                self.set_enabled_async(id, enabled).await?;
            }
            None => {
                self.find(id)?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_endpoint_async(&self, id: &str) -> Result<(), ApiError> {
        self.remove_async(id).await.map(|_| ())
    }

    pub(crate) async fn preview_delete_endpoint_async(&self, id: &str) -> Result<Preview, ApiError> {
        self.preview_remove(id)
    }

    /// Starts the 20 s cron ticker on the shared `Runtime`.
    pub fn start_ticker(self: &Arc<Self>, tick: bool) {
        if !tick {
            return;
        }
        let weak = Arc::downgrade(self);
        let ticker = Ticker::spawn_async_on(&self.runtime, TICK, true, move || {
            let weak = weak.clone();
            Box::pin(async move {
                let Some(c) = weak.upgrade() else { return false };
                if c.runtime.is_cancelled() || c.closed.load(std::sync::atomic::Ordering::Relaxed) {
                    return false;
                }
                c.tick_async().await;
                true
            })
        });
        *self.ticker.lock() = Some(ticker);
    }
}

impl CronToolPort for CronStore {
    fn list_async(&self) -> vibevalley_runtime::agent::durable::BoxFuture<'_, Result<Vec<Cron>, ApiError>> {
        Box::pin(async move { Ok(self.list()) })
    }

    fn create_async<'a>(&'a self, by: &'a str, req: &'a CronRequest) -> vibevalley_runtime::agent::durable::BoxFuture<'a, Result<Cron, ApiError>> {
        Box::pin(async move {
            let actor = match by {
                "user" => ActorKind::User,
                _ => ActorKind::Agent,
            };
            self.add_async(req.clone(), actor).await
        })
    }

    fn delete_async<'a>(&'a self, id: &'a str) -> vibevalley_runtime::agent::durable::BoxFuture<'a, Result<(), ApiError>> {
        Box::pin(async move { self.remove_async(id).await.map(|_| ()) })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use vibevalley_core::{Clock, ManualClock};
    use vibevalley_protocol::{CronRequest, CronWhen, CronWhenOnce};
    use vibevalley_runtime::oar::Registry;

    use super::*;
    use crate::app::outbox::Outbox;
    use crate::work::ledger::BoardConfig;

    struct CountingOrchestrator {
        heard: AtomicUsize,
    }

    impl CronOrchestratorPort for CountingOrchestrator {
        fn hear_cron(&self, _agent: &str, _channel: &str, _words: &str) -> bool {
            self.heard.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn manual_clock_drives_once_due_execution_and_reenable_timestamps_without_sleep() {
        vibevalley_i18n::set_locale("en");
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("server.db");
        let db = ServerDb::open_config(&crate::db::DatabaseConfig::Sqlite { path: db_path.clone() }).unwrap();
        let runtime = Runtime::new();
        let live = LiveOverlay::new();
        let projector = SliceProjector::new();
        let outbox = Outbox::new(db.clone());
        let registry = Arc::new(Registry::new());
        let board = IssueStore::open_async(
            &db_path,
            live.clone(),
            projector.clone(),
            outbox,
            runtime.clone(),
            registry.clone(),
            BoardConfig::under(dir.path()),
            None,
        )
        .await
        .unwrap();
        let agents = AgentStore::open(&runtime, live.clone(), &dir.path().join("agents"), &[], registry, false).unwrap();

        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let orchestrator = Arc::new(CountingOrchestrator { heard: AtomicUsize::new(0) });
        let crons = CronStore::open_with_clock_async(
            db.clone(),
            runtime.clone(),
            live,
            projector,
            board.clone(),
            agents,
            None,
            Some(orchestrator.clone()),
            clock.clone(),
        )
        .await
        .unwrap();

        let past = crons
            .add_async(
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
            )
            .await;
        assert_eq!(past.unwrap_err().biz_code, BizCode::CronRefused);

        let due_at = clock.now_ms() + 60_000;
        let once = crons
            .add_async(
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
            .await
            .unwrap();
        assert_eq!(once.created, 1_700_000_000_000);
        assert!(once.enabled);

        // Before the deadline, tick does not fire.
        clock.advance(Duration::from_millis(59_999));
        crons.tick_async().await;
        assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 0);

        // At the deadline, tick fires exactly once and disables the one-shot cron.
        clock.advance(Duration::from_millis(1));
        crons.tick_async().await;
        assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 1);
        let after = crons.find(&once.id).unwrap();
        assert!(!after.enabled);
        assert_eq!(after.last_run, Some(due_at));

        // Subsequent ticks do not re-fire.
        clock.advance(Duration::from_secs(60));
        crons.tick_async().await;
        assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 1);

        crons.close_async().await;
        board.close();
        let _ = runtime.shutdown(Duration::from_secs(1)).await;
        db.close_async().await;
    }
}
