//! The farm's ledger folded into `Progress` (VibeValley
//! `modules/game/progress.ts`): coins, the streak, counts toward each
//! achievement, and the typed `LedgerEntry` values each fact makes.

use std::collections::BTreeMap;

use vibevalley_protocol::{
    AchievementCategory, Actor, AgentRole, AgentTally, CallState, DEFAULT_ORCHESTRATOR, EVERYONE, Fact, Issue, IssueStatus, JsNumber, Landing, LedgerEntry,
    LedgerEntryCalled, LedgerEntryConflicted, LedgerEntryFailed, LedgerEntryFamily, LedgerEntryHandoff, LedgerEntryHarvested, LedgerEntryHired,
    LedgerEntryLevel, LedgerEntryMoment, LedgerEntryTold, Outcome, Progress, ProgressNews, ProgressTitle, SessionClose, SpaceState, USER_ID, Unlock,
};

use crate::deps::{DagNode, dag_layers};
use crate::game::{AchievementDef, achievements, level_for_commits};
use crate::status::{is_hired, session_of, session_on_issue};

const CHEAP_CNY: f64 = 0.05;
const FULL_HOUSE: usize = 6;

fn tier_of(p: &Progress, id: &str) -> i64 {
    p.unlocked.iter().filter(|u| u.id == id).map(|u| u.tier).max().unwrap_or(0)
}

fn tier_coins(a: &AchievementDef, tier: i64) -> i64 {
    if tier >= 1 {
        a.coins.get((tier - 1) as usize).copied().unwrap_or(0)
    } else {
        0
    }
}

fn streak_multiplier(streak: i64) -> f64 {
    (1.0 + 0.1 * (streak - 1).max(0) as f64).min(2.0)
}

pub fn harvest_coins(commits: i64, streak: i64) -> i64 {
    ((30 + (commits * 5).min(30)) as f64 * streak_multiplier(streak)).round() as i64
}

fn task_coins(merged: i64) -> i64 {
    30 + 10 * merged
}

/// What the fold remembers beside the progress.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Seen {
    pub told: Vec<String>,
    pub failed: Vec<String>,
    pub conflicted: Vec<String>,
    pub reviewed: Vec<String>,
    pub runtimes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Folded {
    pub progress: Progress,
    pub seen: Seen,
}

fn empty_progress() -> Progress {
    Progress {
        coins: 0,
        streak: 0,
        best_streak: 0,
        counts: BTreeMap::new(),
        unlocked: vec![],
        title: None,
        agents: BTreeMap::new(),
        multiplier: Some(JsNumber::from(1.0)),
    }
}

impl Default for Folded {
    fn default() -> Folded {
        Folded {
            progress: empty_progress(),
            seen: Seen::default(),
        }
    }
}

fn added(list: &mut Vec<String>, item: &str) {
    if !list.iter().any(|x| x == item) {
        list.push(item.to_string());
    }
}

fn bump(counts: &mut BTreeMap<String, i64>, id: &str, by: i64) {
    *counts.entry(id.to_string()).or_insert(0) += by;
}

fn at_least(counts: &mut BTreeMap<String, i64>, id: &str, value: i64) {
    let c = counts.entry(id.to_string()).or_insert(0);
    if *c < value {
        *c = value;
    }
}

fn tally_of<'a>(p: &'a mut Progress, agent: Option<&str>) -> Option<&'a mut AgentTally> {
    let agent = agent.filter(|a| !a.is_empty())?;
    Some(p.agents.entry(agent.to_string()).or_insert(AgentTally {
        hired: 0,
        harvested: 0,
        failed: 0,
    }))
}

fn tallied(p: &mut Progress, entry: &LedgerEntry) {
    match entry {
        LedgerEntry::Hired(e) => {
            if let Some(t) = tally_of(p, e.agent.as_deref()) {
                t.hired += 1;
            }
        }
        LedgerEntry::Harvested(e) => {
            if let Some(t) = tally_of(p, e.agent.as_deref()) {
                t.harvested += 1;
            }
        }
        LedgerEntry::Failed(e) => {
            if let Some(t) = tally_of(p, e.agent.as_deref()) {
                t.failed += 1;
            }
        }
        LedgerEntry::Conflicted(_)
        | LedgerEntry::Told(_)
        | LedgerEntry::Reviewed(_)
        | LedgerEntry::Family(_)
        | LedgerEntry::Handoff(_)
        | LedgerEntry::Called(_)
        | LedgerEntry::Opened(_)
        | LedgerEntry::Split(_)
        | LedgerEntry::Voice(_)
        | LedgerEntry::Busy6(_)
        | LedgerEntry::Level(_)
        | LedgerEntry::Titled(_) => {}
    }
}

/// The local hour and day of the week (0 Sunday) of `at`.
fn local_parts(at: i64) -> (i64, i64) {
    jiff::Timestamp::from_millisecond(at)
        .map(|ts| {
            let z = ts.to_zoned_datetime(jiff::tz::TimeZone::system());
            (z.hour() as i64, z.weekday().to_sunday_zero_offset() as i64)
        })
        .unwrap_or((12, 1))
}

/// One entry folded in (`progressStep`), and the news it makes.
pub fn progress_step(folded: &Folded, entry: &LedgerEntry) -> (Folded, ProgressNews) {
    let mut p = folded.progress.clone();
    let mut seen = folded.seen.clone();
    let mut counts = p.counts.clone();
    let mut coins = 0;
    let mut session = None;
    let at = entry.at();
    match entry {
        LedgerEntry::Harvested(e) => {
            let streak = p.streak + 1;
            p.streak = streak;
            p.best_streak = p.best_streak.max(streak);
            coins += harvest_coins(e.commits, streak);
            session = Some(e.session.clone());
            let told = seen.told.iter().any(|x| x == &e.session);
            let failed = seen.failed.iter().any(|x| x == &e.session);
            bump(&mut counts, "harvests", 1);
            if e.runs <= 1 && !told && !failed {
                bump(&mut counts, "first_try", 1);
            }
            if seen.conflicted.iter().any(|x| x == &e.session) {
                bump(&mut counts, "untangle", 1);
            }
            if failed {
                bump(&mut counts, "comeback", 1);
            }
            if e.cny.is_some_and(|c| c.0 < CHEAP_CNY) {
                bump(&mut counts, "thrifty", 1);
            }
            if seen.reviewed.iter().any(|x| x == &e.session) {
                at_least(&mut counts, "s_review", 1);
            }
            added(&mut seen.runtimes, &e.runtime);
            counts.insert("every_machine".into(), seen.runtimes.len() as i64);
            let (hour, week_day) = local_parts(at);
            if hour < 5 {
                at_least(&mut counts, "night_owl", 1);
            }
            if week_day == 0 || week_day == 6 {
                at_least(&mut counts, "weekend", 1);
            }
        }
        LedgerEntry::Failed(e) => {
            p.streak = 0;
            added(&mut seen.failed, &e.session);
        }
        LedgerEntry::Conflicted(e) => added(&mut seen.conflicted, &e.session),
        LedgerEntry::Told(e) => {
            added(&mut seen.told, &e.session);
            at_least(&mut counts, "s_tell", 1);
        }
        LedgerEntry::Reviewed(e) => added(&mut seen.reviewed, &e.session),
        LedgerEntry::Family(e) => {
            coins += task_coins(e.merged);
            at_least(&mut counts, "big_graph", e.merged);
            if e.parallel {
                bump(&mut counts, "parallel_graph", 1);
            }
        }
        LedgerEntry::Handoff(_) => bump(&mut counts, "handoff", 1),
        LedgerEntry::Called(_) => at_least(&mut counts, "s_call", 1),
        LedgerEntry::Hired(_) => at_least(&mut counts, "s_hire", 1),
        LedgerEntry::Opened(_) => at_least(&mut counts, "s_open", 1),
        LedgerEntry::Split(_) => at_least(&mut counts, "s_split", 1),
        LedgerEntry::Voice(_) => at_least(&mut counts, "s_voice", 1),
        LedgerEntry::Busy6(_) => at_least(&mut counts, "full_house", 1),
        LedgerEntry::Level(e) => at_least(&mut counts, "farm_level", e.level),
        LedgerEntry::Titled(e) => {
            // Only a tier reached can be worn, and not a starter task's.
            p.title = None;
            let tier = e.tier.unwrap_or(0);
            let worn = e
                .achievement
                .as_deref()
                .filter(|_| tier != 0)
                .and_then(|id| achievements().iter().find(|a| a.id == id));
            if let Some(a) = worn
                && a.category != AchievementCategory::Starter
                && tier_of(&p, &a.id) >= tier
            {
                p.title = Some(ProgressTitle { id: a.id.clone(), tier });
            }
        }
    }
    at_least(&mut counts, "steady", p.best_streak);

    let mut unlocked = Vec::new();
    for a in achievements() {
        let count = counts.get(&a.id).copied().unwrap_or(0);
        let had = tier_of(&p, &a.id);
        for (i, need) in a.tiers.iter().enumerate() {
            let tier = i as i64 + 1;
            if tier > had && count >= *need {
                unlocked.push(Unlock { id: a.id.clone(), tier, at });
                coins += tier_coins(a, tier);
            }
        }
    }
    tallied(&mut p, entry);
    p.coins += coins;
    p.counts = counts;
    p.unlocked.extend(unlocked.clone());
    p.multiplier = Some(JsNumber::from(streak_multiplier(p.streak)));
    let news = ProgressNews {
        coins: (coins != 0).then_some(coins),
        session,
        unlocked,
    };
    (Folded { progress: p, seen }, news)
}

pub fn progress_fold(entries: &[LedgerEntry]) -> Folded {
    entries.iter().fold(Folded::default(), |f, e| progress_step(&f, e).0)
}

fn working(state: &SpaceState) -> usize {
    state.sessions.iter().filter(|h| is_hired(h) && h.phase.is_working()).count()
}

fn family_entry(id: &str, children: &[&Issue]) -> LedgerEntry {
    let merged: Vec<&str> = children
        .iter()
        .filter(|i| i.delivered == Some(Landing::MergedIntoParent))
        .map(|i| i.id.as_str())
        .collect();
    let nodes: Vec<DagNode> = children
        .iter()
        .map(|i| DagNode {
            id: i.id.clone(),
            after: i.blocked_by.clone(),
        })
        .collect();
    let parallel = dag_layers(&nodes)
        .iter()
        .any(|layer| layer.iter().filter(|id| merged.contains(&id.as_str())).count() >= 2);
    LedgerEntry::Family(LedgerEntryFamily {
        at: 0,
        issue: id.to_string(),
        merged: merged.len() as i64,
        parallel,
    })
}

/// The entries a fact makes (`entriesFor`), before `Game::record` stamps `at`.
pub fn entries_for(before: &SpaceState, fact: &Fact, after: &SpaceState) -> Vec<LedgerEntry> {
    let mut out = Vec::new();
    match fact {
        Fact::SessionReported(f) => {
            let h = session_of(after, &f.id).or_else(|| session_of(before, &f.id));
            if h.is_some_and(is_hired) && f.outcome == Outcome::Failed {
                out.push(LedgerEntry::Failed(LedgerEntryFailed {
                    at: 0,
                    session: f.id.clone(),
                    agent: h.and_then(|h| h.profile.clone()).filter(|a| !a.is_empty()),
                }));
            }
        }
        Fact::CallChanged(f) => {
            if f.state == CallState::Live {
                out.push(LedgerEntry::Opened(LedgerEntryMoment { at: 0 }));
            }
        }
        Fact::SessionChanged(f) => {
            if is_hired(&f.session) {
                out.push(LedgerEntry::Hired(LedgerEntryHired {
                    at: 0,
                    session: f.session.id.clone(),
                    agent: f.session.profile.clone().filter(|a| !a.is_empty()),
                }));
            }
        }
        Fact::IssueChanged(f) => {
            let issue = &f.issue;
            let previous = before.issues.iter().find(|i| i.id == issue.id);
            let session = issue.latest_session_id();
            if issue.conflict.is_some()
                && let Some(session) = session
                && (previous.is_none_or(|p| p.conflict.is_none() || p.latest_session_id() != Some(session)))
            {
                out.push(LedgerEntry::Conflicted(LedgerEntryConflicted {
                    at: 0,
                    session: session.to_string(),
                }));
            }
            if let Some(parent) = &issue.parent
                && !before.issues.iter().any(|i| i.parent.as_ref() == Some(parent))
            {
                out.push(LedgerEntry::Split(LedgerEntryMoment { at: 0 }));
            }
            let children: Vec<&Issue> = after.issues.iter().filter(|i| i.parent.as_ref() == Some(&issue.id)).collect();
            let was_done = previous.is_some_and(|p| p.status == IssueStatus::Done);
            if issue.status == IssueStatus::Done && !was_done && !children.is_empty() {
                out.push(family_entry(&issue.id, &children));
            }
        }
        Fact::SessionLeft(f) => {
            if let Some(h) = session_of(before, &f.id)
                && is_hired(h)
                && f.closed == Some(SessionClose::Merged)
                && let Some(commits) = f.merged.filter(|m| *m > 0)
            {
                out.push(LedgerEntry::Harvested(LedgerEntryHarvested {
                    at: 0,
                    session: f.id.clone(),
                    agent: h.profile.clone().filter(|a| !a.is_empty()),
                    repo: h.repo_name().unwrap_or_default().to_string(),
                    runtime: h.runtime.clone(),
                    commits,
                    cny: h.spent.as_ref().and_then(|s| s.cny),
                    runs: h.runs,
                }));
            }
        }
        Fact::MessageChanged(f) => {
            let actor = &f.message.actor;
            if matches!(actor, Actor::User { .. }) {
                if let Some(thread) = &f.thread
                    && let Some(h) = session_on_issue(before, thread)
                {
                    out.push(LedgerEntry::Told(LedgerEntryTold { at: 0, session: h.id.clone() }));
                }
                for named in &f.message.mentions {
                    if named != DEFAULT_ORCHESTRATOR
                        && named != USER_ID
                        && named != EVERYONE
                        && let Some(h) = session_of(before, named)
                    {
                        out.push(LedgerEntry::Called(LedgerEntryCalled { at: 0, session: h.id.clone() }));
                    }
                }
            } else if crate::rules::actor_role_of(actor) == Some(AgentRole::Worker)
                && let Some(answers) = &f.answers
            {
                out.push(LedgerEntry::Handoff(LedgerEntryHandoff {
                    at: 0,
                    session: answers.clone(),
                    to: f.message.from.clone(),
                }));
            }
        }
        Fact::ProgressChanged(f) => {
            if let Some(commits) = &f.commits {
                let (level, _) = level_for_commits(commits.total);
                let (was, _) = level_for_commits(before.commits.as_ref().map(|c| c.total).unwrap_or(0));
                if level > was {
                    out.push(LedgerEntry::Level(LedgerEntryLevel { at: 0, level }));
                }
            }
        }
        Fact::MediaChanged(_)
        | Fact::ChannelChanged(_)
        | Fact::ChannelRemoved(_)
        | Fact::UserMentionsChanged(_)
        | Fact::SessionPhaseChanged(_)
        | Fact::SessionToolChanged(_)
        | Fact::SessionSubagentsChanged(_)
        | Fact::SessionToolsReset(_)
        | Fact::IssueRemoved(_)
        | Fact::CronChanged(_)
        | Fact::CronRemoved(_)
        | Fact::MachineChanged(_)
        | Fact::MachineRemoved(_)
        | Fact::ConnectorChanged(_)
        | Fact::RuntimeInboxChanged(_) => {}
    }
    if working(before) < FULL_HOUSE && working(after) >= FULL_HOUSE {
        out.push(LedgerEntry::Busy6(LedgerEntryMoment { at: 0 }));
    }
    out
}

/// A farm level the ledger has not told yet (`catchUp`).
pub fn catch_up(state: &SpaceState) -> Vec<LedgerEntry> {
    let (level, _) = level_for_commits(state.commits.as_ref().map(|c| c.total).unwrap_or(0));
    let known = state.progress.as_ref().and_then(|p| p.counts.get("farm_level").copied()).unwrap_or(1);
    if level > known {
        vec![LedgerEntry::Level(LedgerEntryLevel { at: 0, level })]
    } else {
        vec![]
    }
}
