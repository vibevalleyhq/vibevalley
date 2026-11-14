#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

#[allow(unused_imports)]
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use ts_rs::TS;

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::wire::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum AchievementCategory {
    #[serde(rename = "starter")]
    Starter,
    #[serde(rename = "harvest")]
    Harvest,
    #[serde(rename = "craft")]
    Craft,
    #[serde(rename = "thrift")]
    Thrift,
    #[serde(rename = "team")]
    Team,
    #[serde(rename = "secret")]
    Secret,
}

impl AchievementCategory {
    pub const ALL: [AchievementCategory; 6] = [
        AchievementCategory::Starter,
        AchievementCategory::Harvest,
        AchievementCategory::Craft,
        AchievementCategory::Thrift,
        AchievementCategory::Team,
        AchievementCategory::Secret,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            AchievementCategory::Starter => "starter",
            AchievementCategory::Harvest => "harvest",
            AchievementCategory::Craft => "craft",
            AchievementCategory::Thrift => "thrift",
            AchievementCategory::Team => "team",
            AchievementCategory::Secret => "secret",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AchievementTier {
    pub need: i64,
    pub title: String,
    pub coins: i64,
    pub reached: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Achievement {
    pub id: String,
    pub category: AchievementCategory,
    pub title: String,
    pub detail: String,
    pub unit: Option<String>,
    pub wearable: bool,
    pub tiers: Vec<AchievementTier>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AchievementStanding {
    pub id: String,
    pub tier: i64,
    pub count: i64,
    pub next: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PlayAction {
    pub at: i64,
    pub action: SessionAction,
    pub label: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PlayActionView {
    pub at: i64,
    pub action: SessionAction,
    pub label: String,
    pub action_text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlay {
    pub station: i64,
    pub tools_this_run: i64,
    pub counts: BTreeMap<String, i64>,
    pub files: Vec<String>,
    pub commands: Vec<String>,
    pub run_started_at: Option<i64>,
    pub history: Vec<PlayAction>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlayView {
    pub station: i64,
    pub tools_this_run: i64,
    pub counts: BTreeMap<String, i64>,
    pub files: Vec<String>,
    pub commands: Vec<String>,
    pub run_started_at: Option<i64>,
    pub history: Vec<PlayActionView>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct CommitCount {
    pub total: i64,
    pub repos: Vec<Repo>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Unlock {
    pub id: String,
    pub tier: i64,
    pub at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct AgentTally {
    pub hired: i64,
    pub harvested: i64,
    pub failed: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProgressTitle {
    pub id: String,
    pub tier: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub coins: i64,
    pub streak: i64,
    pub best_streak: i64,
    pub counts: BTreeMap<String, i64>,
    pub unlocked: Vec<Unlock>,
    pub title: Option<ProgressTitle>,
    pub agents: BTreeMap<String, AgentTally>,
    pub multiplier: Option<JsNumber>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ProgressNews {
    pub coins: Option<i64>,
    #[ts(as = "Option<crate::typescript::SessionId>")]
    pub session: Option<SessionId>,
    pub unlocked: Vec<Unlock>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FarmLevel {
    pub level: i64,
    pub xp: i64,
    pub need: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum Crop {
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "seeded")]
    Seeded,
    #[serde(rename = "sprout")]
    Sprout,
    #[serde(rename = "leafy")]
    Leafy,
    #[serde(rename = "flowering")]
    Flowering,
    #[serde(rename = "wheat")]
    Wheat,
    #[serde(rename = "carrot")]
    Carrot,
    #[serde(rename = "withered")]
    Withered,
    #[serde(rename = "weeds")]
    Weeds,
    #[serde(rename = "dry")]
    Dry,
    #[serde(rename = "harvested")]
    Harvested,
    #[serde(rename = "locked")]
    Locked,
}

impl Crop {
    pub const ALL: [Crop; 12] = [
        Crop::Empty,
        Crop::Seeded,
        Crop::Sprout,
        Crop::Leafy,
        Crop::Flowering,
        Crop::Wheat,
        Crop::Carrot,
        Crop::Withered,
        Crop::Weeds,
        Crop::Dry,
        Crop::Harvested,
        Crop::Locked,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Crop::Empty => "empty",
            Crop::Seeded => "seeded",
            Crop::Sprout => "sprout",
            Crop::Leafy => "leafy",
            Crop::Flowering => "flowering",
            Crop::Wheat => "wheat",
            Crop::Carrot => "carrot",
            Crop::Withered => "withered",
            Crop::Weeds => "weeds",
            Crop::Dry => "dry",
            Crop::Harvested => "harvested",
            Crop::Locked => "locked",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum BadgeTone {
    #[serde(rename = "ripe")]
    Ripe,
    #[serde(rename = "bug")]
    Bug,
    #[serde(rename = "stuck")]
    Stuck,
    #[serde(rename = "rest")]
    Rest,
    #[serde(rename = "wait")]
    Wait,
}

impl BadgeTone {
    pub const ALL: [BadgeTone; 5] = [BadgeTone::Ripe, BadgeTone::Bug, BadgeTone::Stuck, BadgeTone::Rest, BadgeTone::Wait];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            BadgeTone::Ripe => "ripe",
            BadgeTone::Bug => "bug",
            BadgeTone::Stuck => "stuck",
            BadgeTone::Rest => "rest",
            BadgeTone::Wait => "wait",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Badge {
    pub text: String,
    pub tone: BadgeTone,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct PlotView {
    pub crop: Crop,
    pub badge: Option<Badge>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FarmView {
    pub level: FarmLevel,
    /// Each issue's plot, by the issue's id (`plotKeyOf`): a reopened issue's new session draws on the same one.
    pub plots: BTreeMap<String, PlotView>,
    /// Each session's station and step history, by the session's id; the farm reads only this.
    pub plays: BTreeMap<String, SessionPlayView>,
    pub achievements: Vec<AchievementStanding>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct GameEffectReward {
    /// The session whose work paid; none for a reward of the farm as a whole.
    #[ts(as = "Option<crate::typescript::SessionId>")]
    pub session_id: Option<SessionId>,
    pub coins: i64,
    pub streak: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct GameEffectPenalty {
    #[ts(as = "crate::typescript::SessionId")]
    pub session_id: SessionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct GameEffectLevelUp {
    pub level: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct GameEffectAchievement {
    pub achievement: String,
    pub tier: i64,
    pub title: String,
    pub reached: String,
    pub detail: String,
    pub coins: i64,
    pub one_off: bool,
}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "kind")]
pub enum GameEffect {
    #[serde(rename = "reward")]
    Reward(GameEffectReward),
    #[serde(rename = "penalty")]
    Penalty(GameEffectPenalty),
    #[serde(rename = "levelUp")]
    LevelUp(GameEffectLevelUp),
    #[serde(rename = "achievement")]
    Achievement(GameEffectAchievement),
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryHarvested {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
    pub agent: Option<String>,
    pub repo: String,
    pub runtime: String,
    pub commits: i64,
    pub cny: Option<JsNumber>,
    pub runs: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryFailed {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
    pub agent: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryConflicted {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryTold {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryReviewed {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryFamily {
    pub at: i64,
    #[ts(as = "crate::typescript::IssueId")]
    pub issue: IssueId,
    pub merged: i64,
    pub parallel: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryHandoff {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
    pub to: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryCalled {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryHired {
    pub at: i64,
    #[ts(as = "crate::typescript::SessionId")]
    pub session: SessionId,
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum LedgerEntryMomentKind {
    #[serde(rename = "opened")]
    Opened,
    #[serde(rename = "split")]
    Split,
    #[serde(rename = "voice")]
    Voice,
    #[serde(rename = "busy6")]
    Busy6,
}

impl LedgerEntryMomentKind {
    pub const ALL: [LedgerEntryMomentKind; 4] = [
        LedgerEntryMomentKind::Opened,
        LedgerEntryMomentKind::Split,
        LedgerEntryMomentKind::Voice,
        LedgerEntryMomentKind::Busy6,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            LedgerEntryMomentKind::Opened => "opened",
            LedgerEntryMomentKind::Split => "split",
            LedgerEntryMomentKind::Voice => "voice",
            LedgerEntryMomentKind::Busy6 => "busy6",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryMoment {
    pub at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryLevel {
    pub at: i64,
    pub level: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryTitled {
    pub at: i64,
    pub achievement: Option<String>,
    pub tier: Option<i64>,
}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "kind")]
pub enum LedgerEntry {
    #[serde(rename = "harvested")]
    Harvested(LedgerEntryHarvested),
    #[serde(rename = "failed")]
    Failed(LedgerEntryFailed),
    #[serde(rename = "conflicted")]
    Conflicted(LedgerEntryConflicted),
    #[serde(rename = "told")]
    Told(LedgerEntryTold),
    #[serde(rename = "reviewed")]
    Reviewed(LedgerEntryReviewed),
    #[serde(rename = "family")]
    Family(LedgerEntryFamily),
    #[serde(rename = "handoff")]
    Handoff(LedgerEntryHandoff),
    #[serde(rename = "called")]
    Called(LedgerEntryCalled),
    #[serde(rename = "hired")]
    Hired(LedgerEntryHired),
    #[serde(rename = "opened")]
    Opened(LedgerEntryMoment),
    #[serde(rename = "split")]
    Split(LedgerEntryMoment),
    #[serde(rename = "voice")]
    Voice(LedgerEntryMoment),
    #[serde(rename = "busy6")]
    Busy6(LedgerEntryMoment),
    #[serde(rename = "level")]
    Level(LedgerEntryLevel),
    #[serde(rename = "titled")]
    Titled(LedgerEntryTitled),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ChooseTitleRequest {
    pub achievement: Option<String>,
    pub tier: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactProgressChangedStation {
    #[ts(as = "crate::typescript::SessionId")]
    pub id: SessionId,
    pub station: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct FactProgressChanged {
    pub at: i64,
    pub progress: Option<Progress>,
    pub news: Option<ProgressNews>,
    pub commits: Option<CommitCount>,
    pub station: Option<FactProgressChangedStation>,
}

crate::typescript::module! {
    "game";
    types: [AchievementCategory,
    AchievementTier,
    Achievement,
    AchievementStanding,
    PlayAction,
    PlayActionView,
    SessionPlay,
    SessionPlayView,
    CommitCount,
    Unlock,
    AgentTally,
    ProgressTitle,
    Progress,
    ProgressNews,
    FarmLevel,
    Crop,
    BadgeTone,
    Badge,
    PlotView,
    FarmView,
    GameEffectReward,
    GameEffectPenalty,
    GameEffectLevelUp,
    GameEffectAchievement,
    GameEffect,
    LedgerEntryHarvested,
    LedgerEntryFailed,
    LedgerEntryConflicted,
    LedgerEntryTold,
    LedgerEntryReviewed,
    LedgerEntryFamily,
    LedgerEntryHandoff,
    LedgerEntryCalled,
    LedgerEntryHired,
    LedgerEntryMomentKind,
    LedgerEntryMoment,
    LedgerEntryLevel,
    LedgerEntryTitled,
    LedgerEntry,
    ChooseTitleRequest,
    FactProgressChangedStation,
    FactProgressChanged];
    aliases: [];
}
