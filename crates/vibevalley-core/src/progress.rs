//! The farm's ledger folded into `Progress` (VibeValley
//! `modules/game/progress.ts`): coins, the streak, counts toward each
//! achievement, and the entries each fact makes. An entry is the ledger's
//! JSON (`LedgerEntry`: `kind`, `at` and its fields).

use std::collections::BTreeMap;

use serde_json::{Value, json};
use vibevalley_protocol::{
    AgentTally, DEFAULT_ORCHESTRATOR, EVERYONE, Fact, Issue, JsNumber, Outcome, Progress, ProgressNews, ProgressTitle, Session, SessionClose, SpaceState,
    USER_ID, Unlock,
};

use crate::deps::{DagNode, dag_layers};
use crate::game::{AchievementDef, achievements, level_for_commits};
use crate::status::{is_hired, is_on_duty, session_on_issue};

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

pub fn empty_progress() -> Progress {
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

fn s<'a>(e: &'a Value, k: &str) -> &'a str {
    e[k].as_str().unwrap_or("")
}

fn n(e: &Value, k: &str) -> i64 {
    e[k].as_i64().or_else(|| e[k].as_f64().map(|f| f as i64)).unwrap_or(0)
}

fn tallied(p: &mut Progress, e: &Value) {
    let kind = s(e, "kind");
    let agent = s(e, "agent");
    if !matches!(kind, "hired" | "harvested" | "failed") || agent.is_empty() {
        return;
    }
    let t = p.agents.entry(agent.to_string()).or_insert(AgentTally {
        hired: 0,
        harvested: 0,
        failed: 0,
    });
    match kind {
        "hired" => t.hired += 1,
        "harvested" => t.harvested += 1,
        _ => t.failed += 1,
    }
}

/// The local hour and day of the week (0 Sunday) of `at`.
fn local_parts(at: i64) -> (i64, i64) {
    jiff::Timestamp::from_millisecond(at)
        .map(|ts| {
            let z = ts.to_zoned(jiff::tz::TimeZone::system());
            (z.hour() as i64, z.weekday().to_sunday_zero_offset() as i64)
        })
        .unwrap_or((12, 1))
}

/// One entry folded in (`progressStep`), and the news it makes.
pub fn progress_step(folded: &Folded, entry: &Value) -> (Folded, ProgressNews) {
    let mut p = folded.progress.clone();
    let mut seen = folded.seen.clone();
    let mut counts = p.counts.clone();
    let mut coins = 0;
    let mut session = None;
    let at = n(entry, "at");
    match s(entry, "kind") {
        "harvested" => {
            let streak = p.streak + 1;
            p.streak = streak;
            p.best_streak = p.best_streak.max(streak);
            coins += harvest_coins(n(entry, "commits"), streak);
            let id = s(entry, "session");
            session = Some(id.to_string());
            let told = seen.told.iter().any(|x| x == id);
            let failed = seen.failed.iter().any(|x| x == id);
            bump(&mut counts, "harvests", 1);
            if n(entry, "runs") <= 1 && !told && !failed {
                bump(&mut counts, "first_try", 1);
            }
            if seen.conflicted.iter().any(|x| x == id) {
                bump(&mut counts, "untangle", 1);
            }
            if failed {
                bump(&mut counts, "comeback", 1);
            }
            if entry["cny"].as_f64().is_some_and(|c| c < CHEAP_CNY) {
                bump(&mut counts, "thrifty", 1);
            }
            if seen.reviewed.iter().any(|x| x == id) {
                at_least(&mut counts, "s_review", 1);
            }
            added(&mut seen.runtimes, s(entry, "runtime"));
            counts.insert("every_machine".into(), seen.runtimes.len() as i64);
            let (hour, week_day) = local_parts(at);
            if hour < 5 {
                at_least(&mut counts, "night_owl", 1);
            }
            if week_day == 0 || week_day == 6 {
                at_least(&mut counts, "weekend", 1);
            }
        }
        "failed" => {
            p.streak = 0;
            added(&mut seen.failed, s(entry, "session"));
        }
        "conflicted" => added(&mut seen.conflicted, s(entry, "session")),
        "told" => {
            added(&mut seen.told, s(entry, "session"));
            at_least(&mut counts, "s_tell", 1);
        }
        "reviewed" => added(&mut seen.reviewed, s(entry, "session")),
        "family" => {
            coins += task_coins(n(entry, "merged"));
            at_least(&mut counts, "big_graph", n(entry, "merged"));
            if entry["parallel"].as_bool() == Some(true) {
                bump(&mut counts, "parallel_graph", 1);
            }
        }
        "handoff" => bump(&mut counts, "handoff", 1),
        "called" => at_least(&mut counts, "s_call", 1),
        "hired" => at_least(&mut counts, "s_hire", 1),
        "opened" => at_least(&mut counts, "s_open", 1),
        "split" => at_least(&mut counts, "s_split", 1),
        "voice" => at_least(&mut counts, "s_voice", 1),
        "busy6" => at_least(&mut counts, "full_house", 1),
        "level" => at_least(&mut counts, "farm_level", n(entry, "level")),
        "titled" => {
            // Only a tier reached can be worn, and not a starter task's.
            p.title = None;
            let tier = n(entry, "tier");
            let worn = (tier != 0).then(|| achievements().iter().find(|a| a.id == s(entry, "achievement"))).flatten();
            if let Some(a) = worn
                && a.category.as_str() != "starter"
                && tier_of(&p, &a.id) >= tier
            {
                p.title = Some(ProgressTitle { id: a.id.clone(), tier });
            }
        }
        _ => {}
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

pub fn progress_fold(entries: &[Value]) -> Folded {
    entries.iter().fold(Folded::default(), |f, e| progress_step(&f, e).0)
}

fn session_of<'a>(state: &'a SpaceState, id: &str) -> Option<&'a Session> {
    state.sessions.iter().find(|s| s.id == id)
}

fn working(state: &SpaceState) -> usize {
    state.sessions.iter().filter(|h| is_hired(h.role) && h.phase.is_working()).count()
}

fn family_entry(id: &str, children: &[&Issue]) -> Value {
    let merged: Vec<&str> = children
        .iter()
        .filter(|i| i.delivered.map(|d| d.as_str()) == Some("merged_into_parent"))
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
    json!({ "kind": "family", "issue": id, "merged": merged.len(), "parallel": parallel })
}

/// The entries a fact makes (`entriesFor`), without their time.
pub fn entries_for(before: &SpaceState, fact: &Fact, after: &SpaceState) -> Vec<Value> {
    let mut out = Vec::new();
    match fact {
        Fact::SessionReported(f) => {
            let h = session_of(after, &f.id).or_else(|| session_of(before, &f.id));
            if !h.is_some_and(|h| is_on_duty(h.role)) && f.outcome == Outcome::Failed {
                let mut e = json!({ "kind": "failed", "session": f.id });
                if let Some(h) = h.filter(|h| !h.agent.is_empty()) {
                    e["agent"] = h.agent.clone().into();
                }
                out.push(e);
            }
        }
        Fact::CallChanged(f) => {
            if f.state.as_str() == "live" {
                out.push(json!({ "kind": "opened" }));
            }
        }
        Fact::SessionChanged(f) => {
            if is_hired(f.session.role) {
                out.push(json!({ "kind": "hired", "session": f.session.id, "agent": f.session.agent }));
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
                out.push(json!({ "kind": "conflicted", "session": session }));
            }
            if let Some(parent) = &issue.parent
                && !before.issues.iter().any(|i| i.parent.as_ref() == Some(parent))
            {
                out.push(json!({ "kind": "split" }));
            }
            let children: Vec<&Issue> = after.issues.iter().filter(|i| i.parent.as_ref() == Some(&issue.id)).collect();
            let was_done = previous.is_some_and(|p| p.status.as_str() == "done");
            if issue.status.as_str() == "done" && !was_done && !children.is_empty() {
                out.push(family_entry(&issue.id, &children));
            }
        }
        Fact::SessionLeft(f) => {
            if let Some(h) = session_of(before, &f.id)
                && f.closed == Some(SessionClose::Merged)
                && f.merged.is_some_and(|m| m > 0)
            {
                let mut e = json!({
                    "kind": "harvested",
                    "session": f.id,
                    "agent": h.agent,
                    "repo": h.repo.clone().unwrap_or_default(),
                    "runtime": h.runtime,
                    "commits": f.merged,
                    "runs": h.runs,
                });
                if let Some(cny) = h.spent.as_ref().and_then(|s| s.cny) {
                    e["cny"] = serde_json::to_value(cny).unwrap_or_default();
                }
                out.push(e);
            }
        }
        Fact::MessageChanged(f) => {
            let actor = &f.message.actor;
            if matches!(actor, vibevalley_protocol::Actor::User { .. }) {
                if let Some(thread) = &f.thread
                    && let Some(h) = session_on_issue(before, thread)
                {
                    out.push(json!({ "kind": "told", "session": h.id }));
                }
                for named in &f.message.mentions {
                    if named != DEFAULT_ORCHESTRATOR
                        && named != USER_ID
                        && named != EVERYONE
                        && let Some(h) = session_of(before, named)
                    {
                        out.push(json!({ "kind": "called", "session": h.id }));
                    }
                }
            } else if crate::rules::actor_role_of(actor).map(|r| r.as_str()) == Some("worker")
                && let Some(answers) = &f.answers
            {
                out.push(json!({ "kind": "handoff", "session": answers, "to": f.message.from }));
            }
        }
        Fact::ProgressChanged(f) => {
            if let Some(commits) = &f.commits {
                let (level, _) = level_for_commits(commits.total);
                let (was, _) = level_for_commits(before.commits.as_ref().map(|c| c.total).unwrap_or(0));
                if level > was {
                    out.push(json!({ "kind": "level", "level": level }));
                }
            }
        }
        _ => {}
    }
    if working(before) < FULL_HOUSE && working(after) >= FULL_HOUSE {
        out.push(json!({ "kind": "busy6" }));
    }
    out
}

/// A farm level the ledger has not told yet (`catchUp`).
pub fn catch_up(state: &SpaceState) -> Vec<Value> {
    let (level, _) = level_for_commits(state.commits.as_ref().map(|c| c.total).unwrap_or(0));
    let known = state.progress.as_ref().and_then(|p| p.counts.get("farm_level").copied()).unwrap_or(1);
    if level > known {
        vec![json!({ "kind": "level", "level": level })]
    } else {
        vec![]
    }
}
