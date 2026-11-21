#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronWhenOnce {
    pub at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronWhenEvery {
    pub minutes: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronWhenDaily {
    pub time: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronWhenWeekly {
    pub days: Vec<i64>,
    pub time: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronWhenExpr {
    pub expr: String,
}

/// Told apart by `kind`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "kind")]
pub enum CronWhen {
    #[serde(rename = "once")]
    Once(CronWhenOnce),
    #[serde(rename = "every")]
    Every(CronWhenEvery),
    #[serde(rename = "daily")]
    Daily(CronWhenDaily),
    #[serde(rename = "weekly")]
    Weekly(CronWhenWeekly),
    #[serde(rename = "cron")]
    Cron(CronWhenExpr),
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Cron {
    pub id: String,
    pub name: String,
    pub text: String,
    pub channel: String,
    pub agent: Option<String>,
    pub repo: Option<String>,
    pub when: CronWhen,
    pub tz: String,
    pub enabled: bool,
    pub created: i64,
    pub last_run: Option<i64>,
    pub by: ActorKind,
    pub pending: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronView {
    pub id: String,
    pub name: String,
    pub text: String,
    pub channel: String,
    pub agent: Option<String>,
    pub repo: Option<String>,
    pub when: CronWhen,
    pub tz: String,
    pub enabled: bool,
    pub created: i64,
    pub last_run: Option<i64>,
    pub by: ActorKind,
    pub pending: bool,
    pub when_text: String,
    pub next_text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronRequest {
    pub name: String,
    pub text: String,
    pub channel: Option<String>,
    pub agent: Option<String>,
    pub repo: Option<String>,
    pub when: CronWhen,
    pub tz: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronUpdate {
    pub enabled: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactCronChanged {
    pub at: i64,
    pub cron: Cron,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct FactCronRemoved {
    pub at: i64,
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronUpdateInput {
    pub id: String,
    pub enabled: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct CronDeleteInput {
    pub id: String,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "cron";
    types: [CronWhenOnce,
    CronWhenEvery,
    CronWhenDaily,
    CronWhenWeekly,
    CronWhenExpr,
    CronWhen,
    Cron,
    CronView,
    CronRequest,
    CronUpdate,
    FactCronChanged,
    FactCronRemoved,
    CronUpdateInput,
    CronDeleteInput];
    aliases: [];
}
