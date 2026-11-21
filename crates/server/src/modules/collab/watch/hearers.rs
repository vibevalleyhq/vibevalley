//! Who hears a chat message, and the brakes every automatic wake passes
//! (VibeValley `modules/watch/hearers.ts` and `brakes.ts`): hop limit,
//! cooldown and the wake breaker. A session the breaker holds stays held
//! until the user speaks to it or it leaves; the user's own words pass all
//! three and start the hop count over.

use std::collections::{BTreeSet, HashMap};

use vibevalley_protocol::{Actor, ChannelType, EVERYONE, MessageKind, Outcome, USER_ID};

/// How many times agents' words may wake someone in one place before the
/// user speaks there again.
pub const HOP_LIMIT: usize = 4;
/// A session woken by an agent's words is not woken by another's within
/// this; an orchestrator always is.
const AGENT_WAKE_COOLDOWN_MS: i64 = 60_000;
/// How many wakes running may end without a word before the session is held.
pub const WAKE_BREAKER: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Mention,
    Everyone,
    OwnThread,
    Member,
    Channel,
    Direct,
    Addressed,
}

/// Which brake held a delivery back from waking its session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldBy {
    HopLimit,
    Cooldown,
    WakeBreaker,
}

/// What a delivery is to its session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryEvent {
    Conversation,
    Mention,
    ReportAttention,
    ReportProgress,
    Ambient,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    pub recipient: String,
    pub reason: Reason,
    pub wakes: bool,
    pub held_by: Option<HeldBy>,
}

impl Recipient {
    pub fn new(recipient: impl Into<String>, reason: Reason, wakes: bool) -> Recipient {
        Recipient {
            recipient: recipient.into(),
            reason,
            wakes,
            held_by: None,
        }
    }
}

/// What the watch knows of a message's place and people.
#[derive(Debug, Clone)]
pub struct Audience {
    pub from: String,
    pub actor: Actor,
    pub kind: MessageKind,
    pub mentions: Vec<String>,
    pub channel: ChannelType,
    pub peer: Option<String>,
    pub channel_members: Vec<String>,
    pub orchestrators: Vec<String>,
    pub thread_owner: Option<String>,
    /// The sessions listening in the place.
    pub sessions: Vec<String>,
    /// Every session hired; none means `sessions`.
    pub present: Option<Vec<String>>,
    pub members: Vec<String>,
    pub outcome: Option<Outcome>,
    pub spoken: bool,
}

fn is_user(a: &Actor) -> bool {
    matches!(a, Actor::User { .. })
}

fn is_agent(a: &Actor) -> bool {
    matches!(a, Actor::Agent { .. })
}

/// `whoHears`: who hears a message before the brakes.
pub fn who_hears(a: &Audience) -> Vec<Recipient> {
    let mut out: Vec<Recipient> = vec![];
    if matches!(a.kind, MessageKind::Notice | MessageKind::Dispatch) || matches!(a.actor, Actor::System { .. }) || a.spoken {
        return out;
    }
    let present = a.present.as_ref().unwrap_or(&a.sessions);
    let mut add = |recipient: &str, reason: Reason, wakes: bool| {
        if recipient == a.from || out.iter().any(|d| d.recipient == recipient) {
            return;
        }
        if !a.orchestrators.iter().any(|o| o == recipient) && !present.iter().any(|p| p == recipient) {
            return;
        }
        out.push(Recipient::new(recipient, reason, wakes));
    };
    if a.channel == ChannelType::Direct {
        let peer = a.peer.clone().unwrap_or_default();
        let recipient = if a.orchestrators.contains(&peer) {
            peer
        } else {
            a.thread_owner.clone().unwrap_or_default()
        };
        if is_user(&a.actor) && !recipient.is_empty() {
            add(&recipient, Reason::Direct, true);
        }
        return out;
    }
    if a.kind == MessageKind::Report {
        for m in &a.channel_members {
            add(m, Reason::Addressed, a.outcome == Some(Outcome::Failed));
        }
        return out;
    }
    for mention in &a.mentions {
        if mention == EVERYONE {
            if is_user(&a.actor) {
                for s in &a.sessions {
                    add(s, Reason::Everyone, true);
                }
            }
        } else if mention != USER_ID {
            add(mention, Reason::Mention, true);
        }
    }
    let thread = a.channel == ChannelType::Thread;
    let owner = if thread { a.thread_owner.clone().unwrap_or_default() } else { String::new() };
    if is_user(&a.actor) {
        if !owner.is_empty() {
            add(&owner, Reason::OwnThread, true);
        }
        if thread {
            for m in &a.members {
                add(m, Reason::Member, true);
            }
        } else {
            if !a.mentions.iter().any(|m| m != USER_ID) {
                for m in &a.channel_members {
                    add(m, Reason::Addressed, true);
                }
            }
            for s in &a.sessions {
                add(s, Reason::Channel, false);
            }
        }
    } else if !owner.is_empty() {
        add(&owner, Reason::OwnThread, true);
    }
    out
}

/// `eventOf`: a report's, the user's words, a name called, or what is said around.
pub fn event_of(kind: MessageKind, actor: &Actor, outcome: Option<Outcome>, reason: Reason) -> DeliveryEvent {
    if kind == MessageKind::Report {
        return if matches!(outcome, Some(Outcome::Failed | Outcome::Interrupted)) {
            DeliveryEvent::ReportAttention
        } else {
            DeliveryEvent::ReportProgress
        };
    }
    if is_user(actor) {
        return DeliveryEvent::Conversation;
    }
    if matches!(reason, Reason::Mention | Reason::Everyone) {
        DeliveryEvent::Mention
    } else {
        DeliveryEvent::Ambient
    }
}

pub struct BrakeInput<'a> {
    pub actor: &'a Actor,
    pub orchestrators: &'a [String],
    /// The wakes by agents' words in the place since the user last spoke there.
    pub hops: usize,
    /// The recipients still cooling down from the last agent's words that woke them.
    pub cooling: &'a [String],
    /// The recipients the wake breaker holds.
    pub broken: &'a [String],
}

/// `brakes`, in priority order; each wake let through counts a hop.
pub fn brakes(deliveries: Vec<Recipient>, input: &BrakeInput) -> Vec<Recipient> {
    let by_agent = is_agent(input.actor);
    let mut hops = input.hops;
    deliveries
        .into_iter()
        .map(|mut d| {
            let r = &d.recipient;
            let held = if d.wakes && by_agent && hops >= HOP_LIMIT {
                Some(HeldBy::HopLimit)
            } else if d.wakes && by_agent && !input.orchestrators.contains(r) && input.cooling.contains(r) {
                Some(HeldBy::Cooldown)
            } else if d.wakes && !is_user(input.actor) && input.broken.contains(r) {
                Some(HeldBy::WakeBreaker)
            } else {
                None
            };
            if d.wakes && by_agent && held.is_none() {
                hops += 1;
            }
            d.held_by = held;
            d
        })
        .collect()
}

/// The wake breaker: a session whose wakes end `limit` times running before
/// it says a word is held until the user speaks to it by name or it leaves.
#[derive(Debug)]
pub struct WakeBreaker {
    failures: HashMap<String, u32>,
    open: BTreeSet<String>,
    limit: u32,
}

impl Default for WakeBreaker {
    fn default() -> Self {
        WakeBreaker::new(WAKE_BREAKER)
    }
}

impl WakeBreaker {
    pub fn new(limit: u32) -> WakeBreaker {
        WakeBreaker {
            failures: HashMap::new(),
            open: BTreeSet::new(),
            limit,
        }
    }

    /// A wake ended without a word: the count, and whether this one tripped it.
    pub fn failed(&mut self, id: &str) -> (u32, bool) {
        let count = self.failures.get(id).copied().unwrap_or(0) + 1;
        self.failures.insert(id.to_string(), count);
        if count < self.limit || self.open.contains(id) {
            return (count, false);
        }
        self.open.insert(id.to_string());
        (count, true)
    }

    pub fn spoke(&mut self, id: &str) {
        self.failures.remove(id);
    }

    /// Spoken to by name, or gone: woken again. True when it was held.
    pub fn reset(&mut self, id: &str) -> bool {
        self.failures.remove(id);
        self.open.remove(id)
    }

    pub fn tripped(&self) -> Vec<String> {
        self.open.iter().cloned().collect()
    }
}

/// The hops per place and each session's last wake by agents' words.
#[derive(Debug, Default)]
pub struct Reach {
    hops_in: HashMap<String, usize>,
    last_wake_of: HashMap<String, i64>,
}

impl Reach {
    pub fn load(&mut self, scopes: &[(String, usize)], sessions: &[(String, i64)]) {
        self.hops_in = scopes.iter().cloned().collect();
        self.last_wake_of = sessions.iter().cloned().collect();
    }

    pub fn user_spoke(&mut self, scope: &str) {
        self.hops_in.remove(scope);
    }

    pub fn hops(&self, scope: &str) -> usize {
        self.hops_in.get(scope).copied().unwrap_or(0)
    }

    pub fn cooling(&self, of: &[String], at: i64) -> Vec<String> {
        of.iter()
            .filter(|s| self.last_wake_of.get(*s).is_some_and(|last| at - last < AGENT_WAKE_COOLDOWN_MS))
            .cloned()
            .collect()
    }

    pub fn woke(&mut self, scope: &str, session: &str, at: i64) {
        let last = self.last_wake_of.entry(session.to_string()).or_insert(0);
        *last = (*last).max(at);
        *self.hops_in.entry(scope.to_string()).or_insert(0) += 1;
    }

    pub fn left(&mut self, session: &str) {
        self.last_wake_of.remove(session);
    }
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::AgentRole;

    use super::*;

    fn agent(id: &str, role: AgentRole) -> Actor {
        Actor::Agent {
            id: id.into(),
            role,
            name: None,
            for_user: None,
        }
    }

    fn user() -> Actor {
        Actor::User {
            id: USER_ID.into(),
            name: None,
        }
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn held(d: &[Recipient]) -> Vec<Option<HeldBy>> {
        d.iter().map(|d| d.held_by).collect()
    }

    #[test]
    fn hop_cooldown_and_breaker_in_priority_order_and_the_user_passes() {
        let two = vec![Recipient::new("w1", Reason::Mention, true), Recipient::new("w2", Reason::Mention, true)];
        let w0 = agent("w0", AgentRole::Worker);
        let none: Vec<String> = vec![];
        let (cool, broken) = (s(&["w1"]), s(&["w1", "w2"]));
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: 4,
            cooling: &cool,
            broken: &broken,
        };
        assert_eq!(held(&brakes(two.clone(), &i)), vec![Some(HeldBy::HopLimit); 2]);
        let broken2 = s(&["w2"]);
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: 0,
            cooling: &cool,
            broken: &broken2,
        };
        assert_eq!(held(&brakes(two.clone(), &i)), vec![Some(HeldBy::Cooldown), Some(HeldBy::WakeBreaker)]);
        let u = user();
        let i = BrakeInput {
            actor: &u,
            orchestrators: &none,
            hops: 4,
            cooling: &cool,
            broken: &broken,
        };
        assert_eq!(brakes(two.clone(), &i), two);
    }

    #[test]
    fn each_wake_let_through_is_a_hop_and_quiet_ones_are_not_braked() {
        let many: Vec<Recipient> = ["a", "b", "c"].iter().map(|r| Recipient::new(*r, Reason::Mention, true)).collect();
        let w0 = agent("w0", AgentRole::Worker);
        let none: Vec<String> = vec![];
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: HOP_LIMIT - 2,
            cooling: &none,
            broken: &none,
        };
        assert_eq!(held(&brakes(many, &i)), vec![None, None, Some(HeldBy::HopLimit)]);
        let a = s(&["a"]);
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: HOP_LIMIT,
            cooling: &a,
            broken: &a,
        };
        let quiet = vec![Recipient::new("a", Reason::Channel, false)];
        assert_eq!(brakes(quiet.clone(), &i), quiet);
    }

    #[test]
    fn the_breaker_trips_once_and_opens_when_reset() {
        let mut b = WakeBreaker::new(2);
        assert_eq!(b.failed("w1"), (1, false));
        b.spoke("w1");
        assert_eq!(b.failed("w1"), (1, false));
        assert_eq!(b.failed("w1"), (2, true));
        assert!(!b.failed("w1").1);
        b.spoke("w1");
        assert_eq!(b.tripped(), s(&["w1"]));
        assert!(b.reset("w1"));
        assert!(!b.reset("w1"));
        assert!(b.tripped().is_empty());
    }

    #[test]
    fn the_reach_counts_hops_until_the_user_speaks_and_cools_sessions_down() {
        let mut r = Reach::default();
        r.load(&[("c".into(), 2)], &[]);
        r.woke("c", "w2", 5);
        assert_eq!(r.hops("c"), 3);
        r.user_spoke("c");
        assert_eq!(r.hops("c"), 0);
        r.woke("c", "w2", 6);
        assert_eq!((r.hops("c"), r.hops("elsewhere")), (1, 0));

        let mut r = Reach::default();
        r.load(&[], &[("w2".into(), 9)]);
        r.woke("c", "w2", 4);
        r.woke("c", "w4", 12);
        assert_eq!(r.cooling(&s(&["w2", "w4", "w5"]), 9 + 1000), s(&["w2", "w4"]));
        assert_eq!(r.cooling(&s(&["w2", "w4"]), 9 + 60_000), s(&["w4"]));
        r.left("w2");
        assert!(r.cooling(&s(&["w2"]), 10).is_empty());
    }

    #[test]
    fn with_several_orchestrators_the_places_one_hears_the_user() {
        let base = Audience {
            from: USER_ID.into(),
            actor: user(),
            kind: MessageKind::Chat,
            mentions: vec![],
            channel: ChannelType::Channel,
            peer: None,
            channel_members: s(&["lead"]),
            orchestrators: s(&["orchestrator", "lead"]),
            thread_owner: None,
            sessions: s(&["w1"]),
            present: None,
            members: vec![],
            outcome: None,
            spoken: false,
        };
        let none: Vec<String> = vec![];
        let heard = |a: &Audience, cooling: &[String]| {
            let i = BrakeInput {
                actor: &a.actor,
                orchestrators: &a.orchestrators,
                hops: 0,
                cooling,
                broken: &none,
            };
            brakes(who_hears(a), &i)
        };
        let got: Vec<(String, Reason, bool)> = heard(&base, &none).into_iter().map(|d| (d.recipient, d.reason, d.wakes)).collect();
        assert_eq!(got, vec![("lead".into(), Reason::Addressed, true), ("w1".into(), Reason::Channel, false)]);
        let empty = Audience {
            channel_members: vec![],
            ..base.clone()
        };
        assert_eq!(heard(&empty, &none), vec![Recipient::new("w1", Reason::Channel, false)]);
        let named = Audience {
            mentions: s(&["orchestrator"]),
            ..base.clone()
        };
        let got: Vec<(String, Reason)> = heard(&named, &none).into_iter().map(|d| (d.recipient, d.reason)).collect();
        assert_eq!(got, vec![("orchestrator".into(), Reason::Mention), ("w1".into(), Reason::Channel)]);
        let direct = Audience {
            channel: ChannelType::Direct,
            peer: Some("lead".into()),
            ..base.clone()
        };
        assert_eq!(heard(&direct, &none).into_iter().map(|d| d.recipient).collect::<Vec<_>>(), s(&["lead"]));
        let answering = Audience {
            from: "orchestrator".into(),
            actor: agent("orchestrator", AgentRole::Orchestrator),
            mentions: s(&["lead"]),
            ..base.clone()
        };
        assert_eq!(heard(&answering, &s(&["lead"])), vec![Recipient::new("lead", Reason::Mention, true)]);
    }
}
