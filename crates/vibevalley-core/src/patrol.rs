//! The patrol: what has waited on the user too long, told to the
//! orchestrator. Ported from VibeValley `apps/server/src/modules/watch/patrol.ts`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{InboxKind, Millis, SpaceState};

use crate::inbox::{brief, inbox_entries};

const MINUTE: Millis = 60_000;
const HOUR: Millis = 60 * MINUTE;
/// The same item is not told again within this.
pub const REPORT_AGAIN_MS: Millis = 4 * HOUR;
/// A seen item waits at least this long from when it was seen.
pub const SEEN_GRACE_MS: Millis = 2 * HOUR;

/// How long an item may wait before the patrol tells of it; `None`: never
/// (a failed run reaches the orchestrator as it happens; a cron waiting is
/// the person's to look at).
pub fn grace(kind: InboxKind) -> Option<Millis> {
    match kind {
        InboxKind::Mention | InboxKind::Ask => Some(15 * MINUTE),
        InboxKind::Interrupted => Some(30 * MINUTE),
        InboxKind::Quiet => Some(20 * MINUTE),
        InboxKind::Review | InboxKind::Conflict => Some(2 * HOUR),
        InboxKind::Fix | InboxKind::CronAsk => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatrolMemory {
    pub first_seen: HashMap<String, Millis>,
    pub reported: HashMap<String, Millis>,
}

/// One thing the patrol tells, in the channel it belongs to (`None`: the
/// general one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatrolNote {
    pub key: String,
    pub channel: Option<String>,
    pub text: String,
}

/// `patrolStep`. Things no longer hanging are forgotten, so if they come
/// back they are new. `user_seen` holds when the user last looked at an item.
pub fn patrol_step(state: &SpaceState, now: Millis, memory: &PatrolMemory, user_seen: &HashMap<String, Millis>) -> (Vec<PatrolNote>, PatrolMemory) {
    let mut next = PatrolMemory::default();
    let mut report = Vec::new();
    for e in inbox_entries(state) {
        let key = e.item.id.clone();
        let seen_at = user_seen.get(&key).copied();
        let grace = match seen_at {
            None => grace(e.item.kind),
            Some(_) => Some(grace(e.item.kind).unwrap_or(0).max(SEEN_GRACE_MS)),
        };
        let Some(grace) = grace else { continue };
        let seen = memory.first_seen.get(&key).copied().unwrap_or(now);
        next.first_seen.insert(key.clone(), seen);
        let since = e.since.unwrap_or(seen).max(seen_at.unwrap_or(0));
        let last = memory.reported.get(&key).copied();
        if let Some(last) = last {
            next.reported.insert(key.clone(), last);
        }
        if now - since < grace || last.is_some_and(|last| now - last < REPORT_AGAIN_MS) {
            continue;
        }
        next.reported.insert(key.clone(), now);
        report.push(PatrolNote {
            key,
            channel: e.channel,
            text: e.brief.replacen("{ago}", &brief::ago(now - since), 1),
        });
    }
    (report, next)
}

/// `patrolText`: the patrol's message to the orchestrator.
pub fn patrol_text(channel_name: &str, found: &[PatrolNote]) -> String {
    let lines: Vec<String> = found.iter().map(|n| format!("- {}", n.text)).collect();
    format!(
        "【巡查】#{channel_name} 里有几件事放着没人管：\n{}\n\n看看要不要提醒用户（一两句，说在 #{channel_name}）、催帮工或者叫停；都不用管就什么也别说。",
        lines.join("\n")
    )
}
