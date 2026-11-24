//! Pure in-memory ephemeral overlay and telemetry spine (`LiveOverlay`):
//! active session stream state, farm plays & effect bursts, live runtime/connector/
//! machine/call/inbox state, and `LiveEvent` broadcast fan-out. Never reads or writes SQL.

use std::collections::{BTreeMap, VecDeque};

use parking_lot::{Mutex, RwLock};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_core::LiveSessionOverlay;
use vibevalley_core::game::{empty_play, free_station, play_of, played_doing, played_run};
use vibevalley_core::rules::farm_of;
use vibevalley_protocol::{
    CallState, CommitCount, ConnectorStatus, Doing, GameEffect, InboxItem, LiveEvent, LiveEventNotice, LiveEventRuntime, LiveEventSession, Machine,
    Millis, NoticeLevel, Phase, Progress, RuntimeInfo, Session, SessionAction, SessionEvent, SessionId, SessionPlay, SessionSubagents, Spent,
    ToolConnection,
};

const DEFAULT_LIVE_CAPACITY: usize = 512;
const DEFAULT_FARM_EFFECT_CAPACITY: usize = 256;

/// Ephemeral farm animation effect alias matching the protocol effect union.
pub(crate) type FarmEffect = GameEffect;

/// Ephemeral telemetry snapshot for an active session while it is running in memory.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct LiveSessionSnapshot {
    pub run_id: Option<String>,
    pub phase: Option<Phase>,
    pub channel: Option<Option<String>>,
    pub brief: Option<String>,
    pub spent: Option<Spent>,
    pub tool_connections: Option<Vec<ToolConnection>>,
    pub subagents: Option<SessionSubagents>,
    pub last_event_at: Option<Millis>,
}

impl LiveSessionSnapshot {
    pub(crate) fn to_core_overlay(&self) -> LiveSessionOverlay {
        LiveSessionOverlay {
            phase: self.phase.clone(),
            channel: self.channel.clone(),
            brief: self.brief.clone(),
            spent: self.spent.clone(),
            subagents: self.subagents.as_ref().map(|s| Some(s.clone())),
            tool_connections: self.tool_connections.clone(),
        }
    }
}

/// Sequenced farm effect stored inside [`LiveOverlay`]'s bounded burst ring.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FarmEffectEntry {
    pub seq: u64,
    pub effect: FarmEffect,
}

struct EffectRing {
    capacity: usize,
    next_seq: u64,
    items: VecDeque<FarmEffectEntry>,
}

impl EffectRing {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            next_seq: 0,
            items: VecDeque::with_capacity(capacity.max(1)),
        }
    }

    fn push(&mut self, effect: FarmEffect) -> u64 {
        self.next_seq += 1;
        let seq = self.next_seq;
        if self.items.len() >= self.capacity {
            self.items.pop_front();
        }
        self.items.push_back(FarmEffectEntry { seq, effect });
        seq
    }

    fn drain_since(&mut self, since: u64) -> Vec<FarmEffectEntry> {
        let mut out = Vec::new();
        while let Some(entry) = self.items.pop_front() {
            if entry.seq > since {
                out.push(entry);
            }
        }
        out
    }
}

/// Pure in-memory live overlay holding ephemeral session stream snapshots,
/// farm plays & effects, live machines/connectors/call/commits/progress,
/// `pi.inbox` alerts, and `LiveEvent` broadcast fan-out.
pub(crate) struct LiveOverlay {
    sessions: RwLock<BTreeMap<SessionId, LiveSessionSnapshot>>,
    plays: RwLock<BTreeMap<SessionId, SessionPlay>>,
    effects: Mutex<EffectRing>,
    machines: RwLock<Vec<Machine>>,
    connectors: RwLock<Vec<ConnectorStatus>>,
    commits: RwLock<Option<CommitCount>>,
    progress: RwLock<Option<Progress>>,
    call: RwLock<(CallState, String)>,
    runtime_inbox: RwLock<Vec<InboxItem>>,
    live_tx: broadcast::Sender<LiveEvent>,
}

impl LiveOverlay {
    /// Creates a [`LiveOverlay`] with default broadcast and farm-effect ring capacities.
    pub(crate) fn new() -> Self {
        Self::with_capacities(DEFAULT_LIVE_CAPACITY, DEFAULT_FARM_EFFECT_CAPACITY)
    }

    /// Creates a [`LiveOverlay`] with explicit broadcast and farm-effect ring capacities.
    pub(crate) fn with_capacities(live_capacity: usize, farm_effect_capacity: usize) -> Self {
        let (live_tx, _) = broadcast::channel(live_capacity.max(1));
        Self {
            sessions: RwLock::new(BTreeMap::new()),
            plays: RwLock::new(BTreeMap::new()),
            effects: Mutex::new(EffectRing::new(farm_effect_capacity)),
            machines: RwLock::new(Vec::new()),
            connectors: RwLock::new(Vec::new()),
            commits: RwLock::new(None),
            progress: RwLock::new(None),
            call: RwLock::new((CallState::Idle, String::new())),
            runtime_inbox: RwLock::new(Vec::new()),
            live_tx,
        }
    }

    /// Replaces or inserts the live snapshot for `session_id`.
    pub(crate) fn set_session(&self, session_id: SessionId, snapshot: LiveSessionSnapshot) {
        self.sessions.write().insert(session_id, snapshot);
    }

    /// Mutates the live snapshot for `session_id`, creating a default entry if absent.
    pub(crate) fn update_session(&self, session_id: &str, update: impl FnOnce(&mut LiveSessionSnapshot)) {
        let mut map = self.sessions.write();
        if let Some(entry) = map.get_mut(session_id) {
            update(entry);
        } else {
            let mut entry = LiveSessionSnapshot::default();
            update(&mut entry);
            map.insert(session_id.to_owned(), entry);
        }
    }

    /// Removes the ephemeral snapshot for `session_id` (e.g. when a run finishes or session leaves).
    pub(crate) fn remove_session(&self, session_id: &str) -> Option<LiveSessionSnapshot> {
        self.sessions.write().remove(session_id)
    }

    /// Returns a cloned live snapshot for `session_id`, if active.
    pub(crate) fn session(&self, session_id: &str) -> Option<LiveSessionSnapshot> {
        self.sessions.read().get(session_id).cloned()
    }

    /// Returns a consistent clone of all active live session snapshots.
    pub(crate) fn sessions_snapshot(&self) -> BTreeMap<SessionId, LiveSessionSnapshot> {
        self.sessions.read().clone()
    }

    /// Returns the `vibevalley_core` overlay map for projection.
    pub(crate) fn core_session_overlays(&self) -> BTreeMap<SessionId, LiveSessionOverlay> {
        self.sessions
            .read()
            .iter()
            .map(|(k, v)| (k.clone(), v.to_core_overlay()))
            .collect()
    }

    /// Number of active sessions tracked in the live overlay.
    pub(crate) fn session_count(&self) -> usize {
        self.sessions.read().len()
    }

    /// Ensures a farm worker session has an assigned station & play state.
    pub(crate) fn ensure_play_station(&self, session: &Session, other_sessions: &[&Session], prefer: Option<i64>) -> bool {
        let mut plays = self.plays.write();
        if let Some(existing) = plays.get(&session.id)
            && prefer.is_none_or(|p| existing.station == p)
        {
            return false;
        }
        let current = play_of(Some(&plays), &session.id);
        let station = free_station(Some(&plays), other_sessions, farm_of(session), prefer);
        if prefer.is_some_and(|p| station != p) {
            return false;
        }
        plays.insert(session.id.clone(), SessionPlay { station, ..current });
        true
    }

    /// Records a run start or working action step in `plays` for a farm worker.
    pub(crate) fn record_play_working(&self, session_id: &str, at: Millis, was_working: bool, doing: &Doing) {
        let mut plays = self.plays.write();
        let before = play_of(Some(&plays), session_id);
        let next = if was_working {
            played_doing(&before, at, doing.action, &doing.label)
        } else {
            played_run(&before, at)
        };
        plays.insert(session_id.to_owned(), next);
    }

    /// Removes farm play state when a session leaves.
    pub(crate) fn remove_play(&self, session_id: &str) {
        self.plays.write().remove(session_id);
    }

    /// Returns a cloned snapshot of all farm plays.
    pub(crate) fn plays_snapshot(&self) -> BTreeMap<SessionId, SessionPlay> {
        self.plays.read().clone()
    }

    /// Builds a [`vibevalley_core::LiveSnapshot`], optionally draining buffered farm effects.
    pub(crate) fn to_core_snapshot(&self, drain_effects: bool) -> vibevalley_core::LiveSnapshot {
        let effects = if drain_effects {
            self.drain_farm_effects(0).into_iter().map(|e| e.effect).collect()
        } else {
            Vec::new()
        };
        vibevalley_core::LiveSnapshot {
            sessions: self.core_session_overlays(),
            plays: self.plays_snapshot(),
            effects,
        }
    }

    /// Upserts an execution machine into `machines` and returns whether it changed.
    pub(crate) fn upsert_machine(&self, machine: Machine) -> bool {
        let mut list = self.machines.write();
        match list.iter_mut().find(|m| m.id == machine.id) {
            Some(existing) if *existing == machine => false,
            Some(existing) => {
                *existing = machine;
                true
            }
            None => {
                list.push(machine);
                true
            }
        }
    }

    /// Removes an execution machine by `id` and returns whether one was removed.
    pub(crate) fn remove_machine(&self, id: &str) -> bool {
        let mut list = self.machines.write();
        let before = list.len();
        list.retain(|m| m.id != id);
        list.len() != before
    }

    pub(crate) fn machines_snapshot(&self) -> Vec<Machine> {
        self.machines.read().clone()
    }

    /// Upserts a connector status into `connectors` and returns whether it changed.
    pub(crate) fn upsert_connector(&self, status: ConnectorStatus) -> bool {
        let mut list = self.connectors.write();
        match list.iter_mut().find(|c| c.id == status.id) {
            Some(existing) if *existing == status => false,
            Some(existing) => {
                *existing = status;
                true
            }
            None => {
                list.push(status);
                true
            }
        }
    }

    pub(crate) fn connectors_snapshot(&self) -> Vec<ConnectorStatus> {
        self.connectors.read().clone()
    }

    /// Replaces `commits` and returns `(previous_total, changed)`.
    pub(crate) fn set_commits(&self, next: Option<CommitCount>) -> (Option<i64>, bool) {
        let mut guard = self.commits.write();
        let prev_total = guard.as_ref().map(|c| c.total);
        if *guard == next {
            return (prev_total, false);
        }
        *guard = next;
        (prev_total, true)
    }

    pub(crate) fn commits_snapshot(&self) -> Option<CommitCount> {
        self.commits.read().clone()
    }

    /// Replaces `progress` and returns whether it changed.
    pub(crate) fn set_progress(&self, next: Option<Progress>) -> bool {
        let mut guard = self.progress.write();
        if *guard == next {
            return false;
        }
        *guard = next;
        true
    }

    pub(crate) fn progress_snapshot(&self) -> Option<Progress> {
        self.progress.read().clone()
    }

    /// Updates voice call banner state and returns whether it changed.
    pub(crate) fn set_call(&self, state: CallState, reason: String) -> bool {
        let mut guard = self.call.write();
        if guard.0 == state && guard.1 == reason {
            return false;
        }
        *guard = (state, reason);
        true
    }

    pub(crate) fn call_snapshot(&self) -> (CallState, String) {
        self.call.read().clone()
    }

    /// Replaces projected runtime `pi.inbox` items and returns whether they changed.
    pub(crate) fn set_runtime_inbox(&self, items: Vec<InboxItem>) -> bool {
        let mut guard = self.runtime_inbox.write();
        if *guard == items {
            return false;
        }
        *guard = items;
        true
    }

    pub(crate) fn runtime_inbox_snapshot(&self) -> Vec<InboxItem> {
        self.runtime_inbox.read().clone()
    }

    /// Subscribes to ephemeral [`LiveEvent`] broadcasts.
    pub(crate) fn subscribe_live(&self) -> broadcast::Receiver<LiveEvent> {
        self.live_tx.subscribe()
    }

    /// Broadcasts one [`LiveEvent`], silently dropping when there are no active listeners.
    pub(crate) fn publish_live(&self, event: LiveEvent) {
        let _ = self.live_tx.send(event);
    }

    /// Broadcasts a live session activity event.
    pub(crate) fn publish_session_event(&self, at: Millis, id: SessionId, activity: SessionEvent) {
        self.publish_live(LiveEvent::Event(LiveEventSession { at, id, activity }));
    }

    /// Broadcasts a live notice banner event.
    pub(crate) fn publish_notice(&self, at: Millis, level: NoticeLevel, text: impl Into<String>) {
        self.publish_live(LiveEvent::Notice(LiveEventNotice { at, level, text: text.into() }));
    }

    /// Broadcasts a live runtime health/probe update.
    pub(crate) fn publish_runtime(&self, at: Millis, info: RuntimeInfo) {
        self.publish_live(LiveEvent::Runtime(LiveEventRuntime { at, info }));
    }

    /// Current number of active [`LiveEvent`] broadcast subscribers.
    pub(crate) fn live_subscriber_count(&self) -> usize {
        self.live_tx.receiver_count()
    }

    /// Appends one `FarmEffect` to the bounded burst buffer, returning its monotonic sequence.
    pub(crate) fn push_farm_effect(&self, effect: FarmEffect) -> u64 {
        self.effects.lock().push(effect)
    }

    /// Appends a batch of `FarmEffect`s to the bounded burst buffer, returning the latest sequence.
    pub(crate) fn push_farm_effects(&self, effects: impl IntoIterator<Item = FarmEffect>) -> u64 {
        let mut ring = self.effects.lock();
        let mut last = ring.next_seq;
        for effect in effects {
            last = ring.push(effect);
        }
        last
    }

    /// Drains all buffered `FarmEffect` entries with `seq > since` in ascending sequence order,
    /// discarding any entries with `seq <= since`.
    pub(crate) fn drain_farm_effects(&self, since: u64) -> Vec<FarmEffectEntry> {
        self.effects.lock().drain_since(since)
    }

    /// Latest monotonic farm effect sequence assigned by this overlay.
    pub(crate) fn farm_effect_seq(&self) -> u64 {
        self.effects.lock().next_seq
    }

    /// Number of currently buffered, un-drained farm effects.
    pub(crate) fn pending_farm_effect_count(&self) -> usize {
        self.effects.lock().items.len()
    }
}

impl Default for LiveOverlay {
    fn default() -> Self {
        Self::new()
    }
}

/// Adapts a Tokio `broadcast::Receiver<LiveEvent>` onto a bounded `flume::Receiver<LiveEvent>`
/// for sync trait callers (`Server::live`).
pub(crate) fn bridge_live_receiver(mut rx: broadcast::Receiver<LiveEvent>, cancel: CancellationToken) -> flume::Receiver<LiveEvent> {
    let (tx, out) = flume::unbounded();
    vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
        loop {
            let item = tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                res = rx.recv() => match res {
                    Ok(ev) => ev,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            if tx.send(item).is_err() {
                break;
            }
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::{Doing, GameEffectLevelUp, GameEffectPenalty, GameEffectReward, NoticeLevel, SessionAction};

    use super::*;

    #[test]
    fn session_overlay_tracks_updates_snapshots_and_removals() {
        let live = LiveOverlay::new();
        assert_eq!(live.session_count(), 0);

        live.update_session("sess-1", |snap| {
            snap.run_id = Some("run-1".into());
            snap.doing = Some(Doing {
                action: SessionAction::ReadFile,
                label: "src/lib.rs".into(),
            });
            snap.last_event_at = Some(100);
        });
        assert_eq!(live.session_count(), 1);
        let s1 = live.session("sess-1").unwrap();
        assert_eq!(s1.run_id.as_deref(), Some("run-1"));
        assert_eq!(s1.doing.as_ref().map(|d| d.label.as_str()), Some("src/lib.rs"));

        live.set_session(
            "sess-2".into(),
            LiveSessionSnapshot {
                run_id: Some("run-2".into()),
                last_event_at: Some(200),
                ..Default::default()
            },
        );
        let snapshot = live.sessions_snapshot();
        assert_eq!(snapshot.len(), 2);
        assert!(snapshot.contains_key("sess-1"));
        assert!(snapshot.contains_key("sess-2"));

        let removed = live.remove_session("sess-1").unwrap();
        assert_eq!(removed.run_id.as_deref(), Some("run-1"));
        assert!(live.session("sess-1").is_none());
        assert_eq!(live.session_count(), 1);
    }

    #[tokio::test]
    async fn live_event_broadcast_delivers_to_subscribers_and_handles_lag() {
        let live = LiveOverlay::with_capacities(2, 8);
        live.publish_notice(1, NoticeLevel::Info, "nobody listening");

        let mut rx = live.subscribe_live();
        assert_eq!(live.live_subscriber_count(), 1);

        live.publish_notice(2, NoticeLevel::Warn, "first");
        match rx.recv().await.unwrap() {
            LiveEvent::Notice(n) => {
                assert_eq!(n.at, 2);
                assert_eq!(n.level, NoticeLevel::Warn);
                assert_eq!(n.text, "first");
            }
            other => panic!("unexpected live event: {other:?}"),
        }

        live.publish_notice(3, NoticeLevel::Info, "a");
        live.publish_notice(4, NoticeLevel::Info, "b");
        live.publish_notice(5, NoticeLevel::Error, "c");
        assert!(matches!(rx.recv().await, Err(broadcast::error::RecvError::Lagged(1))));
        match rx.recv().await.unwrap() {
            LiveEvent::Notice(n) => assert_eq!(n.text, "b"),
            other => panic!("unexpected live event: {other:?}"),
        }
        match rx.recv().await.unwrap() {
            LiveEvent::Notice(n) => assert_eq!(n.text, "c"),
            other => panic!("unexpected live event: {other:?}"),
        }
    }

    #[test]
    fn farm_effect_ring_is_bounded_monotonic_and_drains_since() {
        let live = LiveOverlay::with_capacities(8, 3);
        let e1 = FarmEffect::Reward(GameEffectReward {
            session_id: Some("s1".into()),
            coins: 10,
            streak: 1,
        });
        let e2 = FarmEffect::Penalty(GameEffectPenalty { session_id: "s2".into() });
        let e3 = FarmEffect::LevelUp(GameEffectLevelUp { level: 2 });
        let e4 = FarmEffect::LevelUp(GameEffectLevelUp { level: 3 });

        assert_eq!(live.push_farm_effect(e1), 1);
        assert_eq!(live.push_farm_effect(e2.clone()), 2);
        assert_eq!(live.push_farm_effect(e3.clone()), 3);
        assert_eq!(live.push_farm_effect(e4.clone()), 4);
        assert_eq!(live.farm_effect_seq(), 4);
        assert_eq!(live.pending_farm_effect_count(), 3);

        let drained = live.drain_farm_effects(2);
        assert_eq!(drained, vec![FarmEffectEntry { seq: 3, effect: e3 }, FarmEffectEntry { seq: 4, effect: e4 }]);
        assert_eq!(live.pending_farm_effect_count(), 0);
        assert!(live.drain_farm_effects(0).is_empty());

        let tail_seq = live.push_farm_effects([e2]);
        assert_eq!(tail_seq, 5);
    }
}
