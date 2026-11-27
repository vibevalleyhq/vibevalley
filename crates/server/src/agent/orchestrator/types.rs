use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use tokio::sync::Notify;

use super::words::Source;
use crate::agent::tool::Route;
use crate::channel::Picked;

/// One input to an orchestrator (`Handed`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Input {
    /// The orchestrator it is for; none is the place's.
    pub agent: Option<String>,
    /// The place it came from, where the answer goes.
    pub channel: String,
    pub source: Source,
    /// The input's words, after the source's head.
    pub line: String,
    pub user: bool,
    pub picked: Option<Picked>,
    /// The messages it carries.
    pub messages: Vec<String>,
    /// The live answer waiting for this turn's words (`Orchestrator::answer_async`, `brief`).
    pub port: Option<String>,
    /// Owning cron id when `source == Source::Cron`.
    #[serde(default)]
    pub cron_id: Option<String>,
}

/// Messages heard but not woken for: shown with the next input (`digest`).
#[derive(Default)]
pub(super) struct Waiting {
    pub(super) lines: Vec<String>,
}

pub(super) struct Instance {
    pub(super) id: String,
    pub(super) pending: AtomicBool,
    pub(super) more: Arc<Notify>,
    pub(super) route: Arc<Mutex<Route>>,
    /// The situation it was last shown whole; "" shows it whole again.
    pub(super) shown: ArcSwap<String>,
    /// What it last said it cannot start for, per place.
    pub(super) cannot: Mutex<HashMap<String, String>>,
    pub(super) news: Mutex<Waiting>,
}
