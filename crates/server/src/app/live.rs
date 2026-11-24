//! Pure in-memory ephemeral overlay and telemetry spine (`LiveOverlay`):
//! active session stream state, live event broadcast, and bounded farm effect bursts.
//! Never reads or writes SQL.

// Staged spine module wired into `App` during direct cutover.
#![allow(dead_code)]

use std::collections::{BTreeMap, VecDeque};

use parking_lot::{Mutex, RwLock};
use tokio::sync::broadcast;
use vibevalley_protocol::{
    Doing, GameEffect, LiveEvent, LiveEventNotice, LiveEventRuntime, LiveEventSession, Millis, NoticeLevel, Phase, RuntimeInfo, SessionEvent, SessionId,
    SessionSubagents, Spent, ToolConnection,
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
    pub doing: Option<Doing>,
    pub spent: Option<Spent>,
    pub tool_connections: Option<Vec<ToolConnection>>,
    pub subagents: Option<SessionSubagents>,
    pub last_event_at: Option<Millis>,
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
/// `LiveEvent` broadcast fan-out, and bounded `FarmEffect` bursts.
pub(crate) struct LiveOverlay {
    sessions: RwLock<BTreeMap<SessionId, LiveSessionSnapshot>>,
    live_tx: broadcast::Sender<LiveEvent>,
    effects: Mutex<EffectRing>,
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
            live_tx,
            effects: Mutex::new(EffectRing::new(farm_effect_capacity)),
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

    /// Removes the ephemeral snapshot for `session_id` (e.g. when a run finishes).
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

    /// Number of active sessions tracked in the live overlay.
    pub(crate) fn session_count(&self) -> usize {
        self.sessions.read().len()
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
        // Publishing without subscribers never panics or blocks.
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

        // Overflow capacity=2 to verify bounded broadcast behavior.
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

        // seq=1 was evicted when seq=4 arrived; draining since=2 skips seq=2 and yields [3, 4].
        let drained = live.drain_farm_effects(2);
        assert_eq!(drained, vec![FarmEffectEntry { seq: 3, effect: e3 }, FarmEffectEntry { seq: 4, effect: e4 },]);
        assert_eq!(live.pending_farm_effect_count(), 0);
        assert!(live.drain_farm_effects(0).is_empty());

        let tail_seq = live.push_farm_effects([e2.clone()]);
        assert_eq!(tail_seq, 5);
        assert_eq!(live.drain_farm_effects(4), vec![FarmEffectEntry { seq: 5, effect: e2 }]);
    }
}
