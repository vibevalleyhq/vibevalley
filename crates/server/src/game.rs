//! The farm's ledger: every entry the farm events make is kept in
//! `<home>/ledger.jsonl`, folded into `progress` (`vibevalley_core::progress`),
//! reflected into [`LiveState`](crate::context::LiveState), and marked dirty on
//! [`StateFeed`](crate::context::StateFeed).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::SliceMask;
use vibevalley_core::progress::{Folded, family_entry, progress_fold, progress_step};
use vibevalley_protocol::{
    AchievementList, Actor, AgentRole, ApiError, BizCode, ChooseTitleRequest, Doing, EndpointId, Issue, LedgerEntry, LedgerEntryCalled, LedgerEntryConflicted,
    LedgerEntryFailed, LedgerEntryHandoff, LedgerEntryHarvested, LedgerEntryHired, LedgerEntryMoment, LedgerEntryReviewed, LedgerEntryTitled, LedgerEntryTold,
    Op, Outcome, Session, SessionClose, ops,
};

use crate::context::Context;
use crate::repo::Repo;

const COUNT_EVERY: std::time::Duration = std::time::Duration::from_secs(120);
const COUNT_AFTER_RUN: std::time::Duration = std::time::Duration::from_secs(15);

/// The next session hired within this long goes to the planted station.
const WANT_STATION_FOR_MS: i64 = 10_000;

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_json::from_value(payload).map_err(|e| ApiError::new(BizCode::InvalidInput, e.to_string()))
}

fn ok_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

pub struct Game {
    file: PathBuf,
    ctx: Arc<Context>,
    repo: Arc<Repo>,
    folded: Mutex<Folded>,
    wanted: Mutex<Option<(i64, i64)>>,
    /// Asks the counting task for a count soon.
    soon: Arc<Notify>,
    counter: Mutex<Option<(CancellationToken, TaskHandle<()>)>>,
    asked: std::sync::atomic::AtomicU64,
}

/// The ledger's entries that still read as a `LedgerEntry`.
fn read_ledger(file: &Path) -> Vec<LedgerEntry> {
    let Ok(body) = std::fs::read_to_string(file) else { return vec![] };
    body.lines().filter_map(|line| serde_json::from_str::<LedgerEntry>(line).ok()).collect()
}

async fn run_commit_counter_loop<F, Fut>(soon: Arc<Notify>, cancel: CancellationToken, mut run_once: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    if !run_once().await {
        return;
    }
    let mut next = tokio::time::Instant::now() + COUNT_EVERY;
    loop {
        enum Wake {
            Soon,
            Periodic,
            Stop,
        }
        let woke = tokio::select! {
            biased;
            _ = cancel.cancelled() => Wake::Stop,
            _ = soon.notified() => Wake::Soon,
            _ = tokio::time::sleep_until(next) => Wake::Periodic,
        };
        match woke {
            Wake::Stop => return,
            Wake::Soon => {
                let debounce = tokio::time::Instant::now() + COUNT_AFTER_RUN;
                loop {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return,
                        _ = soon.notified() => continue,
                        _ = tokio::time::sleep_until(debounce) => break,
                    }
                }
            }
            Wake::Periodic => next = tokio::time::Instant::now() + COUNT_EVERY,
        }
        if !run_once().await {
            return;
        }
    }
}

impl Game {
    /// Opens the farm ledger under `home`, folds existing entries into `progress`,
    /// seeds `ctx.live`, marks `SliceMask::FARM` dirty, and subscribes to `ctx.outbox`.
    pub fn open(home: &Path, ctx: Arc<Context>, repo: Arc<Repo>) -> Arc<Self> {
        let file = home.join("ledger.jsonl");
        let folded = progress_fold(&read_ledger(&file));
        ctx.live.set_progress(Some(folded.progress.clone()));
        ctx.mark_dirty(SliceMask::FARM);
        let game = Arc::new(Self {
            file,
            ctx,
            repo,
            folded: Mutex::new(folded),
            wanted: Mutex::new(None),
            soon: Arc::new(Notify::new()),
            counter: Mutex::new(None),
            asked: std::sync::atomic::AtomicU64::new(0),
        });
        game.register_outbox();
        game
    }

    /// Dispatches all `Game*` protocol endpoints for `router.rs`.
    pub(crate) async fn dispatch(self: &Arc<Self>, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::GameAchievementList => ok_json(self.achievements_async().await?),
            EndpointId::GameTitleSet => {
                let req: <ops::GameTitleSet as Op>::Input = decode(payload)?;
                self.set_title_async(req).await?;
                Ok(Value::Null)
            }
            other => Err(ApiError::new(BizCode::RouteNotFound, format!("unexpected game endpoint {}", other.as_op()))),
        }
    }

    pub fn progress(&self) -> vibevalley_protocol::Progress {
        self.folded.lock().progress.clone()
    }

    /// Starts the background commit counter loop for the configured repositories.
    pub fn count_commits(self: &Arc<Self>, git_emails: Vec<String>) {
        let cancel = self.ctx.task.child_token();
        let task_cancel = cancel.clone();
        let soon = self.soon.clone();
        let g = Arc::downgrade(self);
        let handle = self.ctx.task.spawn_named(
            "game.commit_counter",
            run_commit_counter_loop(soon, task_cancel, move || {
                let g = g.clone();
                let emails = git_emails.clone();
                async move {
                    let Some(game) = g.upgrade() else { return false };
                    let counted = game.repo.contributions_async(emails).await;
                    game.set_commits(&counted);
                    true
                }
            }),
        );
        *self.counter.lock() = Some((cancel, handle));
    }

    pub async fn close_async(&self) {
        let counter = self.counter.lock().take();
        if let Some((cancel, handle)) = counter {
            cancel.cancel();
            let _ = handle.await;
        }
    }

    /// Updates live commit totals, pushes level-up farm effects, and marks `BOARD | FARM` dirty.
    pub fn set_commits(&self, repos: &[vibevalley_protocol::Repo]) {
        let total = repos.iter().map(|r| r.commits).sum();
        let next = vibevalley_protocol::CommitCount { total, repos: repos.to_vec() };
        let prev = self.ctx.live.commits_snapshot();
        let unchanged = match &prev {
            None => repos.is_empty(),
            Some(prev_commits) => prev_commits == &next,
        };
        if unchanged {
            return;
        }
        let prev_total = prev.as_ref().map(|c| c.total);
        self.ctx.live.set_commits(Some(next.clone()));
        let (level, _) = vibevalley_core::game::level_for_commits(next.total);
        let known = self.folded.lock().progress.counts.get("farm_level").copied().unwrap_or(1);
        if level > known {
            self.record(LedgerEntry::Level(vibevalley_protocol::LedgerEntryLevel { at: 0, level }));
        }
        let effects = vibevalley_core::game::progress_effects(prev_total, None, None, Some(&next));
        if !effects.is_empty() {
            self.ctx.live.push_farm_effects(effects);
        }
        self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::FARM);
    }

    /// How many runs' ends asked for a count.
    pub fn asked(&self) -> u64 {
        self.asked.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn count_soon(&self) {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.soon.notify_one();
    }

    /// Appends one ledger entry, folds it into `progress`, updates `ctx.live`,
    /// pushes progress burst effects, and marks `SliceMask::FARM` dirty.
    pub fn record(&self, entry: LedgerEntry) {
        let at = self.ctx.now();
        let entry = entry.with_at(at);
        let Ok(line) = serde_json::to_string(&entry) else { return };
        let (progress, news) = {
            let mut folded = self.folded.lock();
            let kept = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.file)
                .and_then(|mut f| writeln!(f, "{line}"));
            if kept.is_err() {
                return;
            }
            let (next, news) = progress_step(&folded, &entry);
            let progress = next.progress.clone();
            *folded = next;
            (progress, news)
        };
        self.ctx.live.set_progress(Some(progress.clone()));
        let told = news.coins.unwrap_or(0) != 0 || !news.unlocked.is_empty();
        let effects = vibevalley_core::game::progress_effects(None, told.then_some(&news), Some(&progress), None);
        if !effects.is_empty() {
            self.ctx.live.push_farm_effects(effects);
        }
        self.ctx.mark_dirty(SliceMask::FARM);
    }

    /// Records a newly hired session on the farm, assigning its station (honouring
    /// any active `want` window) and appending `LedgerEntry::Hired`.
    pub fn on_session_hired(&self, session: &Session, other_sessions: &[&Session]) {
        if !vibevalley_core::status::is_hired(session) {
            return;
        }
        let now_ms = self.ctx.now();
        let prefer = self.wanted.lock().take().and_then(|(station, until)| (until > now_ms).then_some(station));
        self.ctx.live.ensure_play_station(session, other_sessions, prefer);
        self.record(LedgerEntry::Hired(LedgerEntryHired {
            at: 0,
            session: session.id.clone(),
            agent: session.profile.clone().filter(|a| !a.is_empty()),
        }));
    }

    /// Records live farm working telemetry for an active farm worker session.
    pub fn on_session_working(&self, session: &Session, was_working: bool, doing: &Doing) {
        if !vibevalley_core::status::is_farm_worker(session) {
            return;
        }
        self.ctx.live.record_play_working(&session.id, self.ctx.now(), was_working, doing);
        self.ctx.mark_dirty(SliceMask::FARM);
    }

    /// Reacts to a finished worker round: debounces commit counting, records
    /// `LedgerEntry::Failed` + penalty effect when a hired worker fails, and
    /// marks `SliceMask::FARM` dirty.
    pub fn on_session_reported(&self, session: &Session, outcome: Outcome) {
        if !vibevalley_core::status::is_farm_worker(session) {
            return;
        }
        self.count_soon();
        if vibevalley_core::status::is_hired(session) {
            if let Some(penalty) = vibevalley_core::game::session_failed_penalty(session, outcome) {
                self.ctx.live.push_farm_effect(penalty);
            }
            if outcome == Outcome::Failed {
                self.record(LedgerEntry::Failed(LedgerEntryFailed {
                    at: 0,
                    session: session.id.clone(),
                    agent: session.profile.clone().filter(|a| !a.is_empty()),
                }));
                return;
            }
        }
        self.ctx.mark_dirty(SliceMask::FARM);
    }

    /// Cleans up a departed session's station and records `LedgerEntry::Harvested`
    /// when a hired worker merged commits.
    pub fn on_session_left(&self, session: &Session, closed: Option<SessionClose>, merged_commits: Option<i64>) {
        if !vibevalley_core::status::is_farm_worker(session) {
            return;
        }
        self.ctx.live.remove_play(&session.id);
        if vibevalley_core::status::is_hired(session)
            && closed == Some(SessionClose::Merged)
            && let Some(commits) = merged_commits.filter(|m| *m > 0)
        {
            self.record(LedgerEntry::Harvested(LedgerEntryHarvested {
                at: 0,
                session: session.id.clone(),
                agent: session.profile.clone().filter(|a| !a.is_empty()),
                repo: session.repo_name().unwrap_or_default().to_string(),
                runtime: session.runtime.clone(),
                commits,
                cny: session.spent.as_ref().and_then(|s| s.cny),
                runs: session.runs,
            }));
            return;
        }
        self.ctx.mark_dirty(SliceMask::FARM);
    }

    pub fn on_call_live(&self) {
        self.record(LedgerEntry::Opened(LedgerEntryMoment { at: 0 }));
    }

    pub fn on_issue_conflicted(&self, session_id: impl Into<String>) {
        self.record(LedgerEntry::Conflicted(LedgerEntryConflicted {
            at: 0,
            session: session_id.into(),
        }));
    }

    pub fn on_issue_split(&self) {
        self.record(LedgerEntry::Split(LedgerEntryMoment { at: 0 }));
    }

    pub fn on_family_done(&self, parent_id: &str, children: &[&Issue]) {
        self.record(family_entry(parent_id, children));
    }

    /// Records ledger entries produced by user/worker channel messages (told/called/handoff).
    pub fn on_message_posted(&self, actor: &Actor, thread_worker_session_id: Option<&str>, mentioned_session_ids: &[String], has_answers: bool) {
        if matches!(actor, Actor::User { .. }) {
            if let Some(session_id) = thread_worker_session_id {
                self.record(LedgerEntry::Told(LedgerEntryTold {
                    at: 0,
                    session: session_id.to_string(),
                }));
            }
            for session_id in mentioned_session_ids {
                self.record(LedgerEntry::Called(LedgerEntryCalled {
                    at: 0,
                    session: session_id.clone(),
                }));
            }
        } else if vibevalley_core::rules::actor_role_of(actor) == Some(AgentRole::Worker) && has_answers {
            self.record(LedgerEntry::Handoff(LedgerEntryHandoff {
                at: 0,
                session: match actor {
                    Actor::Agent { id, .. } => id.clone(),
                    _ => String::new(),
                },
                to: String::new(),
            }));
        }
    }

    /// Registers `game.session_reported` on `ctx.outbox` so committed session
    /// reports also drive farm effects asynchronously when dispatched via outbox.
    pub(crate) fn register_outbox(self: &Arc<Self>) {
        #[derive(serde::Deserialize)]
        struct ReportedPayload {
            session: Session,
            outcome: Outcome,
        }
        let game = Arc::downgrade(self);
        self.ctx.outbox.register("game.session_reported", move |delivery| {
            let game = game.clone();
            async move {
                let Some(game) = game.upgrade() else {
                    return Ok::<(), String>(());
                };
                if let Ok(payload) = serde_json::from_value::<ReportedPayload>(delivery.payload) {
                    game.on_session_reported(&payload.session, payload.outcome);
                }
                Ok(())
            }
        });
    }

    /// Records that the user inspected a live session's diff.
    pub fn reviewed(&self, session: impl Into<String>) {
        self.record(LedgerEntry::Reviewed(LedgerEntryReviewed {
            at: 0,
            session: session.into(),
        }));
    }

    /// The title the user wears; none of either is the plain title.
    pub fn choose_title(&self, achievement: Option<String>, tier: Option<i64>) {
        self.record(LedgerEntry::Titled(LedgerEntryTitled {
            at: 0,
            achievement: achievement.filter(|a| !a.is_empty()),
            tier: tier.filter(|t| *t != 0),
        }));
    }

    /// The next session hired within ten seconds goes to `station`.
    pub fn want(&self, station: i64) {
        *self.wanted.lock() = Some((station, self.ctx.now() + WANT_STATION_FOR_MS));
    }

    pub async fn achievements_async(&self) -> Result<AchievementList, ApiError> {
        let items = vibevalley_core::game::achievements()
            .iter()
            .map(vibevalley_core::game::achievement_in_words)
            .collect();
        let progress = self.progress();
        let standings = vibevalley_core::game::standings_of(Some(&progress));
        Ok(AchievementList { items, standings })
    }

    pub async fn set_title_async(self: &Arc<Self>, req: ChooseTitleRequest) -> Result<(), ApiError> {
        let game = self.clone();
        self.ctx
            .task
            .spawn_blocking(move || game.choose_title(req.achievement, req.tier))
            .await
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use vibevalley_core::{ManualClock, SharedClock};
    use vibevalley_protocol::{ContextRef, ExecutionPolicy, Phase, PhaseWorking, SessionAction, SessionController, SessionPermissionMode};

    use super::*;
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::service::Service;

    async fn test_context(home: &Path, clock: SharedClock) -> Arc<Context> {
        let service = Service::open(home).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        Arc::new(Context::new(
            service,
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            clock,
            Arc::new(Http),
            Arc::new(PublicDownload),
        ))
    }

    fn working_phase(since: i64) -> Phase {
        Phase::Working(PhaseWorking {
            since,
            quiet_since: None,
            retry: None,
            doing: Doing {
                action: SessionAction::None,
                label: String::new(),
            },
        })
    }

    fn workspace_session(id: &str, working: bool) -> Session {
        let mut s = Session::new(
            id,
            SessionController::User,
            format!("chat-{id}"),
            "antigravity",
            ExecutionPolicy::DirectCwd {
                repo: None,
                permission_mode: SessionPermissionMode::AcceptEdits,
            },
            1,
        );
        s.profile = Some("antigravity".into());
        if working {
            s.phase = working_phase(1);
        }
        s
    }

    fn issue_worker(id: &str, issue: &str, working: bool, at: i64) -> Session {
        let mut s = Session::new(
            id,
            SessionController::IssueBoard,
            format!("worker-{id}"),
            "scripted",
            ExecutionPolicy::ManagedWorktree {
                repo: "demo".into(),
                branch: None,
            },
            at,
        );
        s.profile = Some("backend".into());
        s.attach_binding(ContextRef::Issue {
            id: issue.into(),
            refining: None,
        });
        if working {
            s.phase = working_phase(at);
        }
        s
    }

    #[tokio::test]
    async fn workspace_sessions_are_filtered_from_station_agents_streak_and_full_house() {
        let home = tempfile::tempdir().unwrap();
        let ctx = test_context(home.path(), vibevalley_core::system_clock()).await;
        let repo = Repo::open(home.path(), 2).unwrap();
        let game = Game::open(home.path(), ctx.clone(), repo);

        // Seed an active streak and a planted station wish.
        game.record(LedgerEntry::Harvested(LedgerEntryHarvested {
            at: 0,
            session: "h0".into(),
            agent: Some("backend".into()),
            repo: "demo".into(),
            runtime: "scripted".into(),
            commits: 1,
            cny: None,
            runs: 1,
        }));
        game.want(4);

        // Open 6 working workspace sessions and fail one of them.
        let mut ws_list = Vec::new();
        let idle_doing = Doing {
            action: SessionAction::None,
            label: String::new(),
        };
        for i in 1..=6 {
            let ws = workspace_session(&format!("ws{i}"), true);
            game.on_session_hired(&ws, &[]);
            game.on_session_working(&ws, false, &idle_doing);
            ws_list.push(ws);
        }
        game.on_session_reported(&ws_list[0], Outcome::Failed);

        // Now hire a real issue worker and move it to Working.
        let real = issue_worker("w1", "i1", false, 10);
        let others: Vec<&Session> = ws_list.iter().collect();
        game.on_session_hired(&real, &others);
        game.on_session_working(&real, false, &idle_doing);

        assert_eq!(ctx.live.plays_snapshot().get("w1").map(|p| p.station), Some(4));
        let progress = game.progress();
        assert_eq!(progress.agents.get("backend").map(|t| t.hired), Some(1));
        assert!(
            !progress.agents.contains_key("antigravity"),
            "workspace session leaked into agents: {:?}",
            progress.agents
        );
        assert_eq!(progress.streak, 1, "workspace failure reset streak");
        assert_eq!(progress.counts.get("full_house"), None, "workspace sessions triggered FULL_HOUSE");
        assert_eq!(game.asked(), 0, "workspace report triggered commit count");

        // A real worker failure DOES reset streak, tally failed, bump asked(), and emit a penalty effect.
        let effects_before = ctx.live.farm_effect_seq();
        game.on_session_reported(&real, Outcome::Failed);
        let progress = game.progress();
        assert_eq!(progress.streak, 0);
        assert_eq!(progress.agents.get("backend").map(|t| t.failed), Some(1));
        assert_eq!(game.asked(), 1);
        assert!(!ctx.live.drain_farm_effects(effects_before).is_empty());

        game.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }

    #[tokio::test(start_paused = true)]
    async fn commit_counter_loop_debounces_bursts_and_ticks_periodically_on_virtual_clock() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let soon = Arc::new(Notify::new());
        let cancel = CancellationToken::new();
        let runs = Arc::new(AtomicUsize::new(0));
        let wall_start = Instant::now();

        let task = tokio::spawn({
            let soon = soon.clone();
            let cancel = cancel.clone();
            let runs = runs.clone();
            async move {
                run_commit_counter_loop(soon, cancel, move || {
                    let runs = runs.clone();
                    async move {
                        runs.fetch_add(1, Ordering::SeqCst);
                        true
                    }
                })
                .await;
            }
        });

        // Initial run fires immediately at t = 0.
        tokio::task::yield_now().await;
        assert_eq!(runs.load(Ordering::SeqCst), 1);

        // Multiple rapid notifications coalesce into one debounced count after COUNT_AFTER_RUN (15s).
        soon.notify_one();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        soon.notify_one();
        tokio::task::yield_now().await;
        tokio::time::advance(COUNT_AFTER_RUN - Duration::from_secs(5) - Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(runs.load(Ordering::SeqCst), 1, "debounced count must not fire before 15s");

        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(runs.load(Ordering::SeqCst), 2, "debounced count must fire at 15s");

        // Periodic tick fires at COUNT_EVERY (120s from t = 0, i.e., 105s later).
        tokio::time::advance(COUNT_EVERY - COUNT_AFTER_RUN - Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(runs.load(Ordering::SeqCst), 2, "periodic count must not fire before 120s");

        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(runs.load(Ordering::SeqCst), 3, "periodic count must fire at 120s");

        cancel.cancel();
        task.await.unwrap();
        assert!(
            wall_start.elapsed() < Duration::from_secs(1),
            "120s virtual-clock schedule must finish instantaneously, took {:?}",
            wall_start.elapsed()
        );
    }

    #[tokio::test]
    async fn want_station_window_uses_injected_clock_without_sleeping() {
        let home = tempfile::tempdir().unwrap();
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let ctx = test_context(home.path(), clock.clone()).await;
        let repo = Repo::open(home.path(), 2).unwrap();
        let game = Game::open(home.path(), ctx.clone(), repo);

        // Plant a station wish at t0, advance 9_999ms (still within WANT_STATION_FOR_MS = 10_000ms).
        game.want(4);
        let at_inside = clock.advance(Duration::from_millis((WANT_STATION_FOR_MS - 1) as u64));
        let w_in = issue_worker("w-in", "i1", false, at_inside);
        game.on_session_hired(&w_in, &[]);
        assert_eq!(ctx.live.plays_snapshot().get("w-in").map(|p| p.station), Some(4));

        // Plant another wish and advance past WANT_STATION_FOR_MS; the wish must expire without assigning station 5.
        game.want(5);
        let at_expired = clock.advance(Duration::from_millis(WANT_STATION_FOR_MS as u64));
        let w_out = issue_worker("w-out", "i2", false, at_expired);
        game.on_session_hired(&w_out, &[&w_in]);
        assert_eq!(game.progress().agents.get("backend").map(|t| t.hired), Some(2));
        assert_ne!(
            ctx.live.plays_snapshot().get("w-out").map(|p| p.station),
            Some(5),
            "expired station wish must not be applied"
        );

        game.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }
}
