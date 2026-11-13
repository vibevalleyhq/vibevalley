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
use std::sync::{Arc, Mutex, Weak};

use serde_json::{Value, json};
use vibevalley_core::progress::{Folded, catch_up, entries_for, progress_fold, progress_step};
use vibevalley_protocol::{Fact, FactProgressChanged, FactProgressChangedStation, LedgerEntry, ops};

use crate::{Hub, now};

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
    asked: std::sync::atomic::AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The ledger's entries that still read as a `LedgerEntry`.
fn read_ledger(file: &Path) -> Vec<Value> {
    let Ok(body) = std::fs::read_to_string(file) else { return vec![] };
    body.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|v| serde_json::from_value::<LedgerEntry>(v.clone()).is_ok())
        .collect()
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
            asked: Default::default(),
        });
        for e in hub.read(catch_up) {
            game.record(e);
        }
        let g = Arc::downgrade(&game);
        hub.watch(Arc::new(move |hub, t| {
            let Some(game) = g.upgrade() else { return };
            if let Fact::ProgressChanged(f) = &t.fact
                && f.commits.is_none()
                && f.station.is_none()
            {
                return;
            }
            if let Fact::SessionChanged(f) = &t.fact
                && vibevalley_core::status::is_hired(f.session.role)
            {
                let wish = lock(&game.wanted).take();
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
                game.count_soon();
            }
            for e in entries_for(&t.before, &t.fact, &t.after) {
                game.record(e);
            }
        }));
        game
    }

    /// `boot`'s counting: the user's commits under the repos counted now,
    /// every two minutes, and once 15 s after runs report (several runs
    /// share one count). One thread counts, so an older count never lands
    /// after a newer one.
    pub fn count_commits(self: &Arc<Game>, repos: Arc<super::repo::Repos>, git_emails: Vec<String>) {
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
                        std::thread::sleep(COUNT_AFTER_RUN);
                        while rx.try_recv().is_ok() {}
                    }
                    Err(flume::RecvTimeoutError::Timeout) => next = std::time::Instant::now() + COUNT_EVERY,
                    Err(flume::RecvTimeoutError::Disconnected) => return,
                }
                if !refresh() {
                    return;
                }
            }
        });
        if let Err(e) = spawned {
            eprintln!("vibevalley-server: game: the counting thread: {e}");
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
    pub fn record(&self, mut entry: Value) {
        entry["at"] = now().into();
        if serde_json::from_value::<LedgerEntry>(entry.clone()).is_err() {
            return;
        }
        let fact = {
            let mut folded = lock(&self.folded);
            let kept = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.file)
                .and_then(|mut f| writeln!(f, "{entry}"));
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

    /// The title the user wears; none of either is the plain title.
    pub fn choose_title(&self, achievement: Option<String>, tier: Option<i64>) {
        let mut e = json!({ "kind": "titled" });
        if let Some(a) = achievement.filter(|a| !a.is_empty()) {
            e["achievement"] = a.into();
        }
        if let Some(t) = tier.filter(|t| *t != 0) {
            e["tier"] = t.into();
        }
        self.record(e);
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
