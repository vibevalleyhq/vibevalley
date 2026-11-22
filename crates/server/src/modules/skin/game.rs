//! The farm's ledger (VibeValley `modules/game/game.ts`): every entry the
//! facts make is kept in `<home>/ledger.jsonl` and folded into the state's
//! `progress` (`vibevalley_core::progress`). `game.achievement.list`,
//! `game.title.set`.
//!
//! The user's commits are counted now, every two minutes and 15 s after a
//! session reports (`count`, `refresh`; `Game::count_commits`). Not yet:
//! the voice entry.

use std::borrow::Cow;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use vibevalley_core::Transition;
use vibevalley_core::progress::{Folded, catch_up, entries_for, progress_fold, progress_step};
use vibevalley_protocol::{Fact, FactProgressChanged, FactProgressChangedStation, LedgerEntry, LedgerEntryTitled, SpaceState, ops};

use crate::event_bus::Subscription;
use crate::modules::work::session::is_workspace;
use crate::{Hub, lock, now};

const COUNT_EVERY: std::time::Duration = std::time::Duration::from_secs(120);
const COUNT_AFTER_RUN: std::time::Duration = std::time::Duration::from_secs(15);

/// The next session hired within this long goes to the planted station.
const WANT_STATION_FOR_MS: i64 = 10_000;

pub struct Game {
    file: PathBuf,
    hub: Weak<Hub>,
    folded: Mutex<Folded>,
    wanted: Mutex<Option<(i64, i64)>>,
    /// Asks the counting thread for a count soon.
    soon: Mutex<Option<flume::Sender<()>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    sub: Mutex<Option<Subscription>>,
    asked: std::sync::atomic::AtomicU64,
}

fn strip_workspace_sessions(state: &SpaceState) -> Cow<'_, SpaceState> {
    if !state.sessions.iter().any(is_workspace) {
        return Cow::Borrowed(state);
    }
    let mut filtered = state.clone();
    filtered.sessions.retain(|s| !is_workspace(s));
    Cow::Owned(filtered)
}

fn session_is_workspace(t: &Transition, id: &str) -> bool {
    t.after.sessions.iter().chain(&t.before.sessions).find(|s| s.id == id).is_some_and(is_workspace)
}

/// The ledger's entries that still read as a `LedgerEntry`.
fn read_ledger(file: &Path) -> Vec<LedgerEntry> {
    let Ok(body) = std::fs::read_to_string(file) else { return vec![] };
    body.lines().filter_map(|line| serde_json::from_str::<LedgerEntry>(line).ok()).collect()
}

impl Game {
    /// The ledger under `home`, folded into the hub's state; from now on
    /// each fact's entries are kept.
    pub fn open(home: &Path, hub: &Arc<Hub>) -> Arc<Game> {
        let file = home.join("ledger.jsonl");
        let folded = progress_fold(&read_ledger(&file));
        hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
            at: now(),
            progress: Some(folded.progress.clone()),
            news: None,
            commits: None,
            station: None,
        })]);
        let game = Arc::new(Game {
            file,
            hub: Arc::downgrade(hub),
            folded: Mutex::new(folded),
            wanted: Mutex::new(None),
            soon: Mutex::new(None),
            thread: Mutex::new(None),
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
        let prev = lock(&game.sub).replace(sub);
        drop(prev);
        game
    }

    fn on_transition(&self, hub: &Arc<Hub>, t: &Transition) {
        match &t.fact {
            Fact::ProgressChanged(f) if f.commits.is_none() && f.station.is_none() => return,
            Fact::SessionChanged(f) if is_workspace(&f.session) => return,
            Fact::SessionReported(f) if session_is_workspace(t, &f.id) => return,
            Fact::SessionPhaseChanged(f) if session_is_workspace(t, &f.id) => return,
            Fact::SessionLeft(f) if session_is_workspace(t, &f.id) => return,
            _ => {}
        }
        if let Fact::SessionChanged(f) = &t.fact
            && vibevalley_core::status::is_hired(f.session.role)
        {
            let wish = lock(&self.wanted).take();
            if let Some((station, until)) = wish
                && until > f.at
            {
                hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
                    at: now(),
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
        let before = strip_workspace_sessions(&t.before);
        let after = strip_workspace_sessions(&t.after);
        for e in entries_for(before.as_ref(), &t.fact, after.as_ref()) {
            self.record(e);
        }
    }

    /// `boot`'s counting: the user's commits under the repos counted now,
    /// every two minutes, and once 15 s after runs report (several runs
    /// share one count). One thread counts, so an older count never lands
    /// after a newer one.
    pub fn count_commits(self: &Arc<Game>, repos: Arc<crate::modules::work::repo::Repos>, git_emails: Vec<String>) {
        let (tx, rx) = flume::unbounded::<()>();
        *lock(&self.soon) = Some(tx);
        let g = Arc::downgrade(self);
        let refresh = move || {
            let Some(game) = g.upgrade() else { return false };
            game.set_commits(&repos.contributions(&git_emails));
            true
        };
        let spawned = std::thread::Builder::new().name("vibevalley-game-count".into()).spawn(move || {
            if !refresh() {
                return;
            }
            let mut next = std::time::Instant::now() + COUNT_EVERY;
            loop {
                match rx.recv_deadline(next) {
                    Ok(()) => {
                        let debounce = std::time::Instant::now() + COUNT_AFTER_RUN;
                        loop {
                            match rx.recv_deadline(debounce) {
                                Ok(()) => continue,
                                Err(flume::RecvTimeoutError::Timeout) => break,
                                Err(flume::RecvTimeoutError::Disconnected) => return,
                            }
                        }
                    }
                    Err(flume::RecvTimeoutError::Timeout) => next = std::time::Instant::now() + COUNT_EVERY,
                    Err(flume::RecvTimeoutError::Disconnected) => return,
                }
                if !refresh() {
                    return;
                }
            }
        });
        match spawned {
            Ok(handle) => *lock(&self.thread) = Some(handle),
            Err(e) => eprintln!("vibevalley-server: game: the counting thread: {e}"),
        }
    }

    pub fn close(&self) {
        let prev = lock(&self.sub).take();
        drop(prev);
        let _ = lock(&self.soon).take();
        if let Some(handle) = lock(&self.thread).take()
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }

    /// `setCommits`.
    pub fn set_commits(&self, repos: &[vibevalley_protocol::Repo]) {
        let Some(hub) = self.hub.upgrade() else { return };
        let total = repos.iter().map(|r| r.commits).sum();
        hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
            at: now(),
            progress: None,
            news: None,
            commits: Some(vibevalley_protocol::CommitCount { total, repos: repos.to_vec() }),
            station: None,
        })]);
    }

    /// How many runs' ends asked for a count.
    pub fn asked(&self) -> u64 {
        self.asked.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn count_soon(&self) {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Some(tx) = lock(&self.soon).as_ref() {
            let _ = tx.send(());
        }
    }

    /// Keeps one entry (stamped now) and folds it in; one that is not kept
    /// is left out, and the farm goes on.
    pub fn record(&self, entry: LedgerEntry) {
        let entry = entry.with_at(now());
        let Ok(line) = serde_json::to_string(&entry) else { return };
        let fact = {
            let mut folded = lock(&self.folded);
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
                at: now(),
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
        *lock(&self.wanted) = Some((station, now() + WANT_STATION_FOR_MS));
    }
}

pub fn install(hub: &Hub, game: Arc<Game>) {
    hub.on::<ops::GameAchievementList>(|_, ()| {
        Ok(vibevalley_core::game::achievements()
            .iter()
            .map(vibevalley_core::game::achievement_in_words)
            .collect())
    });
    hub.on::<ops::GameTitleSet>(move |_, req| {
        game.choose_title(req.achievement, req.tier);
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use vibevalley_core::empty_space_state;
    use vibevalley_protocol::{
        Doing, FactSessionChanged, FactSessionPhaseChanged, FactSessionReported, LedgerEntryHarvested, Outcome, Phase, PhaseWorking, Session, SessionAction,
    };

    use super::*;

    fn until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(v) = f() {
                return v;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
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
        let mut s = Session::worker(id, format!("chat-{id}"), 1);
        s.agent = "antigravity".into();
        s.runtime = "antigravity".into();
        if working {
            s.phase = working_phase(1);
        }
        s
    }

    fn issue_worker(id: &str, issue: &str, working: bool) -> Session {
        let mut s = Session::worker(id, format!("worker-{id}"), 1);
        s.agent = "backend".into();
        s.runtime = "scripted".into();
        s.issue = Some(issue.into());
        s.repo = Some("demo".into());
        if working {
            s.phase = working_phase(1);
        }
        s
    }

    #[test]
    fn workspace_sessions_are_filtered_from_station_agents_streak_and_full_house() {
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
        until("real worker station & tally", || {
            hub.read(|s| {
                let station_ok = s.plays.as_ref().and_then(|p| p.get("w1")).map(|p| p.station) == Some(4);
                let hired_ok = s.progress.as_ref().and_then(|p| p.agents.get("backend")).is_some_and(|t| t.hired == 1);
                (station_ok && hired_ok).then_some(())
            })
        });

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
        until("real worker failure resets streak", || {
            hub.read(|s| {
                let p = s.progress.as_ref()?;
                (p.streak == 0 && p.agents.get("backend").is_some_and(|t| t.failed == 1) && game.asked() == 1).then_some(())
            })
        });

        game.close();
        hub.close_bus();
    }
}
