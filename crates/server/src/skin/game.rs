//! The farm's ledger (VibeValley `modules/game/game.ts`): every entry the
//! facts make is kept in `<home>/ledger.jsonl` and folded into the state's
//! `progress` (`vibevalley_core::progress`). `game.achievement.list`,
//! `game.title.set`.
//!
//! The user's commits are counted now, every two minutes and 15 s after a
//! session reports (`count`, `refresh`; `Game::count_commits`). Not yet:
//! the voice entry.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::progress::{Folded, catch_up, entries_for, progress_fold, progress_step};
use vibevalley_core::{SharedClock, Transition, system_clock};
use vibevalley_protocol::{Fact, FactProgressChanged, FactProgressChangedStation, LedgerEntry, LedgerEntryTitled, ops};

use crate::Hub;
use crate::app::hub::event_bus::Subscription;

const COUNT_EVERY: std::time::Duration = std::time::Duration::from_secs(120);
const COUNT_AFTER_RUN: std::time::Duration = std::time::Duration::from_secs(15);

/// The next session hired within this long goes to the planted station.
const WANT_STATION_FOR_MS: i64 = 10_000;

pub struct Game {
    file: PathBuf,
    hub: Weak<Hub>,
    clock: SharedClock,
    folded: Mutex<Folded>,
    wanted: Mutex<Option<(i64, i64)>>,
    /// Asks the counting task for a count soon.
    soon: Arc<Notify>,
    counter: Mutex<Option<(CancellationToken, TaskHandle<()>)>>,
    sub: Mutex<Option<Subscription>>,
    asked: std::sync::atomic::AtomicU64,
}

fn session_is_farm_worker(t: &Transition, id: &str) -> bool {
    t.after
        .sessions
        .iter()
        .chain(&t.before.sessions)
        .find(|s| s.id == id)
        .is_some_and(vibevalley_core::status::is_farm_worker)
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
    /// The ledger under `home`, folded into the hub's state; from now on
    /// each fact's entries are kept.
    pub fn open(home: &Path, hub: &Arc<Hub>) -> Arc<Game> {
        Self::open_with_clock(home, hub, system_clock())
    }

    /// Same as [`Game::open`], injecting an explicit wall [`Clock`](vibevalley_core::Clock).
    pub fn open_with_clock(home: &Path, hub: &Arc<Hub>, clock: SharedClock) -> Arc<Game> {
        let file = home.join("ledger.jsonl");
        let folded = progress_fold(&read_ledger(&file));
        hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
            at: clock.now_ms(),
            progress: Some(folded.progress.clone()),
            news: None,
            commits: None,
            station: None,
        })]);
        let game = Arc::new(Game {
            file,
            hub: Arc::downgrade(hub),
            clock,
            folded: Mutex::new(folded),
            wanted: Mutex::new(None),
            soon: Arc::new(Notify::new()),
            counter: Mutex::new(None),
            sub: Mutex::new(None),
            asked: Default::default(),
        });
        for e in hub.read(catch_up) {
            game.record(e);
        }
        let g = Arc::downgrade(&game);
        let sub = hub.subscribe_transitions("game", move |hub, t| {
            let Some(game) = g.upgrade() else { return };
            game.on_transition(hub, t);
        });
        let prev = game.sub.lock().replace(sub);
        drop(prev);
        game
    }

    fn on_transition(&self, hub: &Arc<Hub>, t: &Transition) {
        match &t.fact {
            Fact::ProgressChanged(f) if f.commits.is_none() && f.station.is_none() => return,
            Fact::SessionChanged(f) if !vibevalley_core::status::is_farm_worker(&f.session) => return,
            Fact::SessionReported(f) if !session_is_farm_worker(t, &f.id) => return,
            Fact::SessionPhaseChanged(f) if !session_is_farm_worker(t, &f.id) => return,
            Fact::SessionLeft(f) if !session_is_farm_worker(t, &f.id) => return,
            _ => {}
        }
        if let Fact::SessionChanged(f) = &t.fact
            && vibevalley_core::status::is_hired(&f.session)
        {
            let wish = self.wanted.lock().take();
            if let Some((station, until)) = wish
                && until > f.at
            {
                hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
                    at: self.clock.now_ms(),
                    progress: None,
                    news: None,
                    commits: None,
                    station: Some(FactProgressChangedStation {
                        id: f.session.id.clone(),
                        station,
                    }),
                })]);
            }
        }
        if matches!(t.fact, Fact::SessionReported(_)) {
            self.count_soon();
        }
        for e in entries_for(&t.before, &t.fact, &t.after) {
            self.record(e);
        }
    }

    /// `boot`'s counting: the user's commits under the repos counted now,
    /// every two minutes, and once 15 s after runs report (several runs
    /// share one count). One task counts, so an older count never lands
    /// after a newer one.
    pub fn count_commits(self: &Arc<Game>, repos: Arc<crate::work::repo::Repos>, git_emails: Vec<String>) {
        let Some(hub) = self.hub.upgrade() else { return };
        let cancel = hub.child_token();
        let task_cancel = cancel.clone();
        let soon = self.soon.clone();
        let g = Arc::downgrade(self);
        let handle = hub.spawn_task(run_commit_counter_loop(soon, task_cancel, move || {
            let g = g.clone();
            let repos = repos.clone();
            let emails = git_emails.clone();
            async move {
                let Some(game) = g.upgrade() else { return false };
                let counted = repos.contributions_async(emails).await;
                game.set_commits(&counted);
                true
            }
        }));
        *self.counter.lock() = Some((cancel, handle));
    }

    pub async fn close_async(&self) {
        let prev = self.sub.lock().take();
        drop(prev);
        let counter = self.counter.lock().take();
        if let Some((cancel, handle)) = counter {
            cancel.cancel();
            let _ = handle.await;
        }
    }

    pub fn close(&self) {
        let prev = self.sub.lock().take();
        drop(prev);
        if let Some((cancel, handle)) = self.counter.lock().take() {
            cancel.cancel();
            let _ = vibevalley_runtime::rt::block_on(handle);
        }
    }

    /// `setCommits`.
    pub fn set_commits(&self, repos: &[vibevalley_protocol::Repo]) {
        let Some(hub) = self.hub.upgrade() else { return };
        let total = repos.iter().map(|r| r.commits).sum();
        let next = vibevalley_protocol::CommitCount { total, repos: repos.to_vec() };
        if hub.read(|s| match &s.commits {
            None => repos.is_empty(),
            Some(prev) => prev == &next,
        }) {
            return;
        }
        hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
            at: self.clock.now_ms(),
            progress: None,
            news: None,
            commits: Some(next),
            station: None,
        })]);
    }

    /// How many runs' ends asked for a count.
    pub fn asked(&self) -> u64 {
        self.asked.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn count_soon(&self) {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.soon.notify_one();
    }

    /// Keeps one entry (stamped now) and folds it in; one that is not kept
    /// is left out, and the farm goes on.
    pub fn record(&self, entry: LedgerEntry) {
        let at = self.clock.now_ms();
        let entry = entry.with_at(at);
        let Ok(line) = serde_json::to_string(&entry) else { return };
        let fact = {
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
            let told = news.coins.unwrap_or(0) != 0 || !news.unlocked.is_empty();
            let progress = next.progress.clone();
            *folded = next;
            Fact::ProgressChanged(FactProgressChanged {
                at,
                progress: Some(progress),
                news: told.then_some(news),
                commits: None,
                station: None,
            })
        };
        if let Some(hub) = self.hub.upgrade() {
            hub.apply(vec![fact]);
        }
    }

    /// Records that the user inspected a live session's diff.
    pub fn reviewed(&self, session: impl Into<String>) {
        self.record(LedgerEntry::Reviewed(vibevalley_protocol::LedgerEntryReviewed {
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
        *self.wanted.lock() = Some((station, self.clock.now_ms() + WANT_STATION_FOR_MS));
    }
}

pub fn install(hub: &Hub, game: Arc<Game>) {
    hub.on::<ops::GameAchievementList>(|ctx, ()| {
        let items = vibevalley_core::game::achievements()
            .iter()
            .map(vibevalley_core::game::achievement_in_words)
            .collect();
        let standings = ctx.hub.read(|s| vibevalley_core::game::standings_of(s.progress.as_ref()));
        Ok(vibevalley_protocol::AchievementList { items, standings })
    });
    hub.on_async::<ops::GameTitleSet, _, _>(move |_, req| {
        let game = game.clone();
        async move {
            crate::spawn_blocking_traced(move || game.choose_title(req.achievement, req.tier))
                .await
                .map_err(|e| vibevalley_protocol::ApiError::new(vibevalley_protocol::BizCode::InternalError, e.to_string()))?;
            Ok(())
        }
    });
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use vibevalley_core::{ManualClock, empty_space_state};
    use vibevalley_protocol::{
        ContextRef, Doing, ExecutionPolicy, FactSessionChanged, FactSessionPhaseChanged, FactSessionReported, LedgerEntryHarvested, Outcome, Phase,
        PhaseWorking, Session, SessionAction, SessionController, SessionPermissionMode,
    };

    use super::*;
    use crate::now;

    async fn until_async<T>(hub: &Hub, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
        let notify = Arc::new(Notify::new());
        let wake = notify.clone();
        let sub = hub.subscribe_transitions("test-game-wait", move |_, _| {
            wake.notify_one();
        });
        let res = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let notified = notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(v) = f() {
                    return v;
                }
                notified.await;
            }
        })
        .await
        .ok();
        sub.close_async().await;
        res.unwrap_or_else(|| panic!("timed out waiting for {what}"))
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

    fn issue_worker(id: &str, issue: &str, working: bool) -> Session {
        let mut s = Session::new(
            id,
            SessionController::IssueBoard,
            format!("worker-{id}"),
            "scripted",
            ExecutionPolicy::ManagedWorktree {
                repo: "demo".into(),
                branch: None,
            },
            1,
        );
        s.profile = Some("backend".into());
        s.attach_binding(ContextRef::Issue {
            id: issue.into(),
            refining: None,
        });
        if working {
            s.phase = working_phase(1);
        }
        s
    }

    #[tokio::test]
    async fn workspace_sessions_are_filtered_from_station_agents_streak_and_full_house() {
        let home = tempfile::tempdir().unwrap();
        let hub = Hub::new(empty_space_state());
        let game = Game::open(home.path(), &hub);

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
        for i in 1..=6 {
            let ws = workspace_session(&format!("ws{i}"), true);
            hub.apply(vec![Fact::SessionChanged(FactSessionChanged { at: now(), session: ws })]);
        }
        hub.apply(vec![Fact::SessionReported(FactSessionReported {
            at: now(),
            id: "ws1".into(),
            run: None,
            outcome: Outcome::Failed,
            phase: None,
            summary: "failed workspace chat".into(),
            runs: 1,
            spent: None,
            questions: vec![],
            checks: vec![],
            answer: None,
        })]);

        // Now hire a real issue worker and move it to Working so we have a causal barrier on the bus.
        let real = issue_worker("w1", "i1", false);
        hub.apply(vec![Fact::SessionChanged(FactSessionChanged { at: now(), session: real })]);
        hub.apply(vec![Fact::SessionPhaseChanged(FactSessionPhaseChanged {
            at: now(),
            id: "w1".into(),
            phase: working_phase(now()),
            channel: None,
            spent: None,
            brief: None,
        })]);

        // The real worker claims the planted station (ws1..ws6 did NOT steal it) and tallies `backend`.
        until_async(&hub, "real worker station & tally", || {
            hub.read(|s| {
                let station_ok = s.plays.as_ref().and_then(|p| p.get("w1")).map(|p| p.station) == Some(4);
                let hired_ok = s.progress.as_ref().and_then(|p| p.agents.get("backend")).is_some_and(|t| t.hired == 1);
                (station_ok && hired_ok).then_some(())
            })
        })
        .await;

        let progress = hub.read(|s| s.progress.clone().unwrap());
        assert!(
            !progress.agents.contains_key("antigravity"),
            "workspace session leaked into agents: {:?}",
            progress.agents
        );
        assert_eq!(progress.streak, 1, "workspace failure reset streak");
        assert_eq!(progress.counts.get("full_house"), None, "workspace sessions triggered FULL_HOUSE");
        assert_eq!(game.asked(), 0, "workspace report triggered commit count");

        // A real worker failure DOES reset streak, tally failed, and bump asked().
        hub.apply(vec![Fact::SessionReported(FactSessionReported {
            at: now(),
            id: "w1".into(),
            run: None,
            outcome: Outcome::Failed,
            phase: None,
            summary: "failed issue".into(),
            runs: 1,
            spent: None,
            questions: vec![],
            checks: vec![],
            answer: None,
        })]);
        until_async(&hub, "real worker failure resets streak", || {
            hub.read(|s| {
                let p = s.progress.as_ref()?;
                (p.streak == 0 && p.agents.get("backend").is_some_and(|t| t.failed == 1) && game.asked() == 1).then_some(())
            })
        })
        .await;

        game.close_async().await;
        hub.close_bus_async().await;
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
        let hub = Hub::new(empty_space_state());
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let game = Game::open_with_clock(home.path(), &hub, clock.clone());

        // Plant a station wish at t0, advance 9_999ms (still within WANT_STATION_FOR_MS = 10_000ms).
        game.want(4);
        let at_inside = clock.advance(Duration::from_millis((WANT_STATION_FOR_MS - 1) as u64));
        hub.apply(vec![Fact::SessionChanged(FactSessionChanged {
            at: at_inside,
            session: issue_worker("w-in", "i1", false),
        })]);
        until_async(&hub, "station claimed inside window", || {
            hub.read(|s| (s.plays.as_ref().and_then(|p| p.get("w-in")).map(|p| p.station) == Some(4)).then_some(()))
        })
        .await;

        // Plant another wish and advance past WANT_STATION_FOR_MS; the wish must expire without assigning station 5.
        game.want(5);
        let at_expired = clock.advance(Duration::from_millis(WANT_STATION_FOR_MS as u64));
        hub.apply(vec![Fact::SessionChanged(FactSessionChanged {
            at: at_expired,
            session: issue_worker("w-out", "i2", false),
        })]);
        // Send a phase change as causal barrier so we know the game transition handler processed w-out.
        hub.apply(vec![Fact::SessionPhaseChanged(FactSessionPhaseChanged {
            at: at_expired,
            id: "w-out".into(),
            phase: working_phase(at_expired),
            channel: None,
            spent: None,
            brief: None,
        })]);
        until_async(&hub, "second worker hired tally processed", || {
            hub.read(|s| {
                s.progress
                    .as_ref()
                    .and_then(|p| p.agents.get("backend"))
                    .is_some_and(|t| t.hired == 2)
                    .then_some(())
            })
        })
        .await;
        assert_ne!(
            hub.read(|s| s.plays.as_ref().and_then(|p| p.get("w-out")).map(|p| p.station)),
            Some(5),
            "expired station wish must not be applied"
        );

        game.close_async().await;
        hub.close_bus_async().await;
    }
}
