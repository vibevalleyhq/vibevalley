use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::Deserialize;
use vibevalley_i18n::t;
use vibevalley_protocol::*;

use crate::rules::{Need, farm_of, need_of, plot_key_of};
use crate::status::{is_farm_worker, is_hired, open_findings, session_of};

const HISTORY_LIMIT: usize = 30;
const FILE_LIMIT: usize = 24;
const COMMAND_LIMIT: usize = 12;

pub fn empty_play() -> SessionPlay {
    SessionPlay {
        station: -1,
        history: vec![],
        tools_this_run: 0,
        counts: BTreeMap::new(),
        files: vec![],
        commands: vec![],
        run_started_at: None,
    }
}

pub fn play_of(plays: Option<&BTreeMap<String, SessionPlay>>, id: &str) -> SessionPlay {
    plays.and_then(|p| p.get(id)).cloned().unwrap_or_else(empty_play)
}

/// `freeStation`: -1 when no station on this repo's farm is free.
pub fn free_station(plays: Option<&BTreeMap<String, SessionPlay>>, sessions: &[&Session], repo: &str, prefer: Option<i64>) -> i64 {
    let taken: Vec<i64> = sessions.iter().filter(|h| farm_of(h) == repo).map(|h| play_of(plays, &h.id).station).collect();
    let max = MAX_RUNNING as i64;
    if let Some(p) = prefer
        && (0..max).contains(&p)
        && !taken.contains(&p)
    {
        return p;
    }
    (0..max).find(|i| !taken.contains(i)).unwrap_or(-1)
}

fn remember(list: &[String], item: &str, limit: usize) -> Vec<String> {
    let mut out: Vec<String> = list.iter().filter(|x| *x != item).cloned().collect();
    out.push(item.to_string());
    let skip = out.len().saturating_sub(limit);
    out.split_off(skip)
}

fn last_n<A: Clone>(list: Vec<A>, n: usize) -> Vec<A> {
    let skip = list.len().saturating_sub(n);
    list[skip..].to_vec()
}

fn is_tool_action(a: SessionAction) -> bool {
    use SessionAction::*;
    matches!(a, RunCommand | ReadFile | EditFile | Search | Web | Mcp | Wait | Other)
}

/// `playedRun`: a new run starts.
pub fn played_run(p: &SessionPlay, at: i64) -> SessionPlay {
    let mut history = p.history.clone();
    history.push(PlayAction {
        at,
        action: SessionAction::Thinking,
        label: String::new(),
    });
    SessionPlay {
        tools_this_run: 0,
        run_started_at: Some(at),
        history: last_n(history, HISTORY_LIMIT),
        ..p.clone()
    }
}

/// `playedDoing`: one step of a run.
pub fn played_doing(p: &SessionPlay, at: i64, action: SessionAction, label: &str) -> SessionPlay {
    if p.history.last().is_some_and(|l| l.action == action && l.label == label) {
        return p.clone();
    }
    let mut history = p.history.clone();
    history.push(PlayAction {
        at,
        action,
        label: label.to_string(),
    });
    let mut next = SessionPlay {
        history: last_n(history, HISTORY_LIMIT),
        ..p.clone()
    };
    if !is_tool_action(action) {
        return next;
    }
    next.tools_this_run = p.tools_this_run + 1;
    *next.counts.entry(action.as_str().to_string()).or_insert(0) += 1;
    if matches!(action, SessionAction::EditFile | SessionAction::ReadFile) && !label.is_empty() {
        next.files = remember(&p.files, label, FILE_LIMIT);
    } else if action == SessionAction::RunCommand && !label.is_empty() {
        next.commands = remember(&p.commands, label, COMMAND_LIMIT);
    }
    next
}

/// `stationed`: only to a bed that is free on its own farm.
pub(crate) fn stationed(state: &mut SpaceState, id: &str, station: i64) -> bool {
    let Some(h) = session_of(state, id) else { return false };
    let play = play_of(state.plays.as_ref(), id);
    if play.station == station {
        return false;
    }
    let others: Vec<&Session> = state.sessions.iter().filter(|x| x.id != id).collect();
    if free_station(state.plays.as_ref(), &others, farm_of(h), Some(station)) != station {
        return false;
    }
    state
        .plays
        .get_or_insert_with(BTreeMap::new)
        .insert(id.to_string(), SessionPlay { station, ..play });
    true
}

fn xp_to_next(level: i64) -> i64 {
    10 * level
}

/// `levelForCommits`: (level, xp into it).
pub fn level_for_commits(total: i64) -> (i64, i64) {
    let mut level = 1;
    let mut rest = total.max(0);
    while rest >= xp_to_next(level) {
        rest -= xp_to_next(level);
        level += 1;
    }
    (level, rest)
}

fn farm_level_of(commits: Option<&CommitCount>) -> FarmLevel {
    let (level, xp) = level_for_commits(commits.map_or(0, |c| c.total));
    FarmLevel {
        level,
        xp,
        need: xp_to_next(level),
    }
}

fn fnv32a(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h = (h ^ u32::from(*b)).wrapping_mul(0x01000193);
    }
    h
}

fn ripe_crop(h: &Session) -> Crop {
    if fnv32a(&h.id) % 2 == 1 { Crop::Carrot } else { Crop::Wheat }
}

fn growth(h: &Session, play: &SessionPlay) -> Crop {
    let since = play.run_started_at.unwrap_or(h.hired_at);
    let mut crop = Crop::Sprout;
    for played in &play.history {
        if played.at < since {
            continue;
        }
        if played.action == SessionAction::EditFile && crop == Crop::Sprout {
            crop = Crop::Leafy;
        } else if played.action == SessionAction::RunCommand && crop == Crop::Leafy {
            crop = Crop::Flowering;
        }
    }
    crop
}

fn badge(key: &str, tone: BadgeTone) -> Option<Badge> {
    Some(Badge { text: t(key, &[]), tone })
}

fn plot(crop: Crop, badge: Option<Badge>) -> PlotView {
    PlotView { crop, badge }
}

/// `plotOf`: a picture of its issue's stage; the session only adds how far
/// this round has grown.
fn plot_of(h: &Session, issue: Option<&Issue>, play: &SessionPlay) -> PlotView {
    let Some(issue) = issue else { return plot_of_session(h, play) };
    let a = &issue.stage;
    match a.state {
        IssueStageKind::Draft | IssueStageKind::Queued | IssueStageKind::Working => {
            if let Phase::Working(p) = &h.phase
                && p.retry.is_some()
            {
                return plot(growth(h, play), badge("server.game.badge.retrying", BadgeTone::Stuck));
            }
            let open = open_findings(issue);
            if open > 0 {
                plot(
                    Crop::Weeds,
                    Some(Badge {
                        text: t("server.game.badge.weeding", &[("n", open.into())]),
                        tone: BadgeTone::Bug,
                    }),
                )
            } else {
                plot(growth(h, play), None)
            }
        }
        IssueStageKind::Asking => plot(Crop::Dry, badge("shared.stage.asking", BadgeTone::Wait)),
        IssueStageKind::Reviewing => {
            if issue.reviewed_at.is_some() {
                plot(ripe_crop(h), badge("server.game.badge.ripe", BadgeTone::Ripe))
            } else if !a.acts.is_empty() {
                plot(Crop::Flowering, badge("shared.stage.reviewing", BadgeTone::Wait))
            } else {
                plot(Crop::Flowering, None)
            }
        }
        IssueStageKind::Stuck => match a.stuck {
            Some(StuckReason::Conflict) => plot(Crop::Withered, badge("shared.stuck.conflict", BadgeTone::Bug)),
            Some(StuckReason::Failed) | None => plot(Crop::Withered, badge("server.game.badge.bugs", BadgeTone::Bug)),
            Some(StuckReason::Interrupted) => plot(growth(h, play), badge("shared.stuck.interrupted", BadgeTone::Stuck)),
            Some(StuckReason::Quiet) => plot(Crop::Dry, badge("shared.stuck.quiet", BadgeTone::Stuck)),
        },
        IssueStageKind::Done | IssueStageKind::Canceled => plot_of_session(h, play),
    }
}

fn plot_of_session(h: &Session, play: &SessionPlay) -> PlotView {
    let need = need_of(h, None);
    let conflict = matches!(need, Some(Need::Conflict { .. }));
    match &h.phase {
        Phase::Working(_) => match need {
            Some(Need::Quiet { .. }) => plot(Crop::Dry, badge("shared.stuck.quiet", BadgeTone::Stuck)),
            Some(Need::Retrying { .. }) => plot(growth(h, play), badge("server.game.badge.retrying", BadgeTone::Stuck)),
            _ => plot(growth(h, play), None),
        },
        Phase::Done(_) => plot(
            ripe_crop(h),
            if conflict {
                badge("shared.stuck.conflict", BadgeTone::Bug)
            } else {
                badge("server.game.badge.ripe", BadgeTone::Ripe)
            },
        ),
        Phase::Failed(_) => plot(Crop::Withered, badge("server.game.badge.bugs", BadgeTone::Bug)),
        Phase::Resting(_) => plot(
            growth(h, play),
            if conflict {
                badge("shared.stuck.conflict", BadgeTone::Bug)
            } else {
                badge("server.game.badge.rest", BadgeTone::Rest)
            },
        ),
        Phase::Closed(_) => plot(Crop::Empty, None),
    }
}

pub fn level_ups(before: Option<i64>, after: i64) -> Vec<GameEffect> {
    let Some(before) = before else { return vec![] };
    let (from, _) = level_for_commits(before);
    let (to, _) = level_for_commits(after);
    (from + 1..=to).map(|level| GameEffect::LevelUp(GameEffectLevelUp { level })).collect()
}

/// Pure farm effect extraction for a progress/commit update without `SpaceState`.
pub fn progress_effects(
    before_commits: Option<i64>,
    news: Option<&ProgressNews>,
    progress: Option<&Progress>,
    commits: Option<&CommitCount>,
) -> Vec<GameEffect> {
    let mut out = vec![];
    if let Some(c) = commits {
        out.extend(level_ups(before_commits, c.total));
    }
    if let (Some(news), Some(progress)) = (news, progress) {
        if let Some(coins) = news.coins
            && coins != 0
        {
            out.push(GameEffect::Reward(GameEffectReward {
                session_id: news.session.clone(),
                coins,
                streak: progress.streak,
            }));
        }
        for u in &news.unlocked {
            out.push(GameEffect::Achievement(achievement_effect(&u.id, u.tier)));
        }
    }
    out
}

/// Pure farm penalty effect when a hired board/channel worker fails a run.
pub fn session_failed_penalty(session: &Session, outcome: Outcome) -> Option<GameEffect> {
    (outcome == Outcome::Failed && is_hired(session)).then(|| {
        GameEffect::Penalty(GameEffectPenalty {
            session_id: session.id.clone(),
        })
    })
}

/// `effectsOf`: what a fact sets off on the farm, from the state before it.
pub fn effects_of(before: &SpaceState, fact: &Fact) -> Vec<GameEffect> {
    match fact {
        Fact::ProgressChanged(f) => progress_effects(
            before.commits.as_ref().map(|c| c.total),
            f.news.as_ref(),
            f.progress.as_ref(),
            f.commits.as_ref(),
        ),
        Fact::SessionReported(f) => session_of(before, &f.id)
            .and_then(|reporter| session_failed_penalty(reporter, f.outcome))
            .into_iter()
            .collect(),
        _ => vec![],
    }
}

/// `viewOf`: a plot per issue (the later hired session when two are on
/// it), each session's play, and the level.
pub(crate) fn view_of(state: &SpaceState) -> FarmView {
    farm_view(&state.issues, &state.sessions, state.plays.as_ref(), state.commits.as_ref())
}

/// Pure farm view projection from derived issues, overlaid sessions, plays, and commit counts.
pub(crate) fn farm_view(
    issues_slice: &[Issue],
    sessions: &[Session],
    plays: Option<&BTreeMap<String, SessionPlay>>,
    commits: Option<&CommitCount>,
) -> FarmView {
    let mut latest: HashMap<&str, &Session> = HashMap::new();
    for h in sessions {
        if !is_farm_worker(h) {
            continue;
        }
        let key = plot_key_of(h);
        if latest.get(key).is_none_or(|was| h.hired_at >= was.hired_at) {
            latest.insert(key, h);
        }
    }
    let issues: HashMap<&str, &Issue> = issues_slice.iter().map(|i| (i.id.as_str(), i)).collect();
    let plots = latest
        .into_iter()
        .map(|(key, h)| {
            let issue = h.issue_id().and_then(|i| issues.get(i).copied());
            (key.to_string(), plot_of(h, issue, &play_of(plays, &h.id)))
        })
        .collect();
    let played = sessions
        .iter()
        .filter(|h| is_farm_worker(h))
        .map(|h| {
            let play = play_of(plays, &h.id);
            let history = play
                .history
                .iter()
                .map(|s| PlayActionView {
                    at: s.at,
                    action: s.action,
                    label: s.label.clone(),
                    action_text: t(&format!("shared.action.{}", s.action.as_str()), &[]),
                })
                .collect();
            let view = SessionPlayView {
                station: play.station,
                tools_this_run: play.tools_this_run,
                counts: play.counts,
                files: play.files,
                commands: play.commands,
                run_started_at: play.run_started_at,
                history,
            };
            (h.id.clone(), view)
        })
        .collect();
    FarmView {
        level: farm_level_of(commits),
        plots,
        plays: played,
    }
}

/// An achievement as `seeds.json` defines it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementDef {
    pub id: String,
    pub category: AchievementCategory,
    pub title: String,
    #[serde(default)]
    pub tier_titles: Option<Vec<String>>,
    pub detail: String,
    pub tiers: Vec<i64>,
    pub coins: Vec<i64>,
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Deserialize)]
struct Seeds {
    achievements: Vec<AchievementDef>,
}

/// The achievements in the language in use (`achievements()`).
pub fn achievements() -> &'static [AchievementDef] {
    static ZH: OnceLock<Vec<AchievementDef>> = OnceLock::new();
    static EN: OnceLock<Vec<AchievementDef>> = OnceLock::new();
    let parse = |text: &str| serde_json::from_str::<Seeds>(text).expect("bundled seeds").achievements;
    if vibevalley_i18n::locale() == "en" {
        EN.get_or_init(|| parse(include_str!("../../data/seeds.en.json")))
    } else {
        ZH.get_or_init(|| parse(include_str!("../../data/seeds.json")))
    }
}

/// `achievementInWords`.
pub fn achievement_in_words(a: &AchievementDef) -> Achievement {
    let tiers = a
        .tiers
        .iter()
        .enumerate()
        .map(|(i, need)| AchievementTier {
            need: *need,
            title: tier_title(a, i + 1),
            coins: a.coins.get(i).copied().unwrap_or(0),
            reached: reached_text(a, i + 1),
        })
        .collect();
    Achievement {
        id: a.id.clone(),
        category: a.category,
        title: a.title.clone(),
        detail: a.detail.clone(),
        unit: a.unit.clone(),
        wearable: a.category != AchievementCategory::Starter,
        tiers,
    }
}

fn tier_title(a: &AchievementDef, tier: usize) -> String {
    if let Some(custom) = a.tier_titles.as_ref().and_then(|t| t.get(tier - 1)) {
        return custom.clone();
    }
    match tier {
        2 => t("server.game.tier.silver", &[("title", a.title.clone().into())]),
        3 => t("server.game.tier.gold", &[("title", a.title.clone().into())]),
        _ => a.title.clone(),
    }
}

fn reached_text(a: &AchievementDef, tier: usize) -> String {
    match a.category {
        AchievementCategory::Starter => t("server.game.reached.starter", &[]),
        AchievementCategory::Secret => t("server.game.reached.secret", &[]),
        _ => match tier {
            3 => t("server.game.reached.gold", &[]),
            2 => t("server.game.reached.silver", &[]),
            _ => t("server.game.reached.unlocked", &[]),
        },
    }
}

fn achievement_effect(id: &str, tier: i64) -> GameEffectAchievement {
    let mut e = GameEffectAchievement {
        achievement: id.to_string(),
        tier,
        title: String::new(),
        reached: String::new(),
        detail: String::new(),
        coins: 0,
        one_off: false,
    };
    for a in achievements().iter().filter(|a| a.id == id) {
        let words = achievement_in_words(a);
        e.detail = a.detail.clone();
        e.one_off = a.tiers.len() == 1;
        if tier >= 1
            && let Some(item) = words.tiers.get(tier as usize - 1)
        {
            e.title = item.title.clone();
            e.reached = item.reached.clone();
            e.coins = item.coins;
        }
    }
    e
}

pub fn standings_of(p: Option<&Progress>) -> Vec<AchievementStanding> {
    achievements()
        .iter()
        .map(|a| {
            let mut s = AchievementStanding {
                id: a.id.clone(),
                tier: 0,
                count: 0,
                next: None,
            };
            if let Some(p) = p {
                s.count = p.counts.get(&a.id).copied().unwrap_or(0);
                for u in &p.unlocked {
                    if u.id == a.id && u.tier > s.tier {
                        s.tier = u.tier;
                    }
                }
            }
            s.next = a.tiers.get(s.tier as usize).copied();
            s
        })
        .collect()
}
