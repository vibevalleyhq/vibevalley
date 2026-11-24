//! Pure channel audience selection and loop-guard brakes (`hopLimit` and
//! `cooldown`). Inspects only channel tables and types, with zero imports of
//! `issue`, `session`, or `orchestrator`.

use std::collections::HashMap;
use std::sync::Arc;

use vibevalley_protocol::{Actor, ChannelType, EVERYONE, MessageKind, Outcome, SubjectKind, USER_ID};

use super::db::ParticipantRow;
use super::model::ChatModel;
use super::service::profile_id;
use super::types::{Committed, actor_of, message_kind, meta_of};

/// How many times agents' words may wake someone in one place before the
/// user speaks there again.
pub const HOP_LIMIT: usize = 4;
/// A session woken by an agent's words is not woken by another's within
/// this; an orchestrator always is.
const AGENT_WAKE_COOLDOWN_MS: i64 = 60_000;

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

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Mention => "mention",
            Reason::Everyone => "everyone",
            Reason::OwnThread => "own_thread",
            Reason::Member => "member",
            Reason::Channel => "channel",
            Reason::Direct => "direct",
            Reason::Addressed => "addressed",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "mention" => Reason::Mention,
            "everyone" => Reason::Everyone,
            "own_thread" => Reason::OwnThread,
            "member" => Reason::Member,
            "channel" => Reason::Channel,
            "direct" => Reason::Direct,
            _ => Reason::Addressed,
        }
    }
}

/// Which brake held a delivery back from waking its recipient.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldBy {
    HopLimit,
    Cooldown,
}

impl HeldBy {
    pub fn as_str(self) -> &'static str {
        match self {
            HeldBy::HopLimit => "hop_limit",
            HeldBy::Cooldown => "cooldown",
        }
    }

    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "hop_limit" => Some(HeldBy::HopLimit),
            "cooldown" => Some(HeldBy::Cooldown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryTargetKind {
    Session,
    Issue,
    Orchestrator,
    Direct,
}

impl DeliveryTargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryTargetKind::Session => "session",
            DeliveryTargetKind::Issue => "issue",
            DeliveryTargetKind::Orchestrator => "orchestrator",
            DeliveryTargetKind::Direct => "direct",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "session" => DeliveryTargetKind::Session,
            "issue" => DeliveryTargetKind::Issue,
            "orchestrator" => DeliveryTargetKind::Orchestrator,
            _ => DeliveryTargetKind::Direct,
        }
    }
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

/// What channel dispatch knows of a message's place and participants.
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
    /// The seated worker sessions listening in the place.
    pub sessions: Vec<String>,
    /// Every seated active worker session; none means `sessions`.
    pub present: Option<Vec<String>>,
    pub members: Vec<String>,
    pub outcome: Option<Outcome>,
    pub spoken: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedDelivery {
    pub recipient_kind: DeliveryTargetKind,
    pub recipient_id: String,
    pub reason: Reason,
    pub wakes: bool,
    pub held_by: Option<HeldBy>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DispatchPlan {
    pub deliveries: Vec<PlannedDelivery>,
    pub hop_limit_hit: bool,
}

/// A durable pending delivery written to `channel_delivery` on commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedDelivery {
    pub id: i64,
    pub message_id: String,
    pub channel_id: String,
    pub recipient_kind: DeliveryTargetKind,
    pub recipient_id: String,
    pub reason: Reason,
    pub wakes: bool,
    pub held_by: Option<HeldBy>,
}

/// Non-blocking dispatch notification emitted after a message and its pending
/// `channel_delivery` rows commit.
#[derive(Debug, Clone)]
pub struct ChannelDispatched {
    pub committed: Arc<Committed>,
    pub deliveries: Vec<QueuedDelivery>,
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

pub struct BrakeInput<'a> {
    pub actor: &'a Actor,
    pub orchestrators: &'a [String],
    /// The wakes by agents' words in the place since the user last spoke there.
    pub hops: usize,
    /// The recipients still cooling down from the last agent's words that woke them.
    pub cooling: &'a [String],
}

/// `brakes`, in priority order (`HopLimit` then `Cooldown`); each wake let
/// through counts a hop.
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

/// The hops per place and each session's last wake by agents' words.
#[derive(Debug, Clone, Default)]
pub struct Reach {
    hops_in: HashMap<String, usize>,
    last_wake_of: HashMap<String, i64>,
}

impl Reach {
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

    pub fn channel_removed(&mut self, channel: &str) {
        self.hops_in.remove(&format!("channel:{channel}"));
    }
}

fn is_active_orchestrator(p: &ParticipantRow) -> bool {
    p.kind == "agent" && p.agent_id.is_none() && p.left_at.is_none()
}

fn is_active_session(p: &ParticipantRow) -> bool {
    p.kind == "agent" && p.left_at.is_none() && p.agent_id.as_deref().is_some_and(|a| p.id != profile_id(a))
}

fn channel_of_participant(model: &ChatModel, p: &ParticipantRow) -> String {
    match p.home_id.as_deref().and_then(|h| model.channel(h)) {
        Some(home) if home.r#type == "direct" => home.id.clone(),
        Some(home) if home.r#type == "thread" => home.parent_id.clone().unwrap_or_else(|| model.default_id()),
        Some(home) => home.id.clone(),
        None => model.default_id(),
    }
}

fn thread_owner_of(c: &Committed, active_sessions: &[&ParticipantRow]) -> Option<String> {
    if c.channel_type != ChannelType::Thread {
        return None;
    }
    match &c.topic {
        Some((SubjectKind::Talk, id)) => active_sessions.iter().any(|p| &p.id == id).then(|| id.clone()),
        Some((SubjectKind::Issue, _)) => active_sessions
            .iter()
            .filter(|p| p.home_id.as_deref() == Some(c.row.channel_id.as_str()))
            .max_by_key(|p| p.joined_at)
            .map(|p| p.id.clone()),
        None => None,
    }
}

/// Pure synchronous delivery policy: evaluates who hears `c`, applies
/// `hopLimit` & `cooldown` brakes, updates `reach`, and returns the durable
/// deliveries to enqueue.
pub fn plan_deliveries(model: &ChatModel, reach: &mut Reach, c: &Committed, at: i64) -> DispatchPlan {
    let kind = message_kind(&c.row.kind);
    if matches!(kind, MessageKind::Notice | MessageKind::Dispatch) {
        return DispatchPlan::default();
    }
    let meta = meta_of(c.row.meta.as_deref());
    let actor = actor_of(&c.row.sender_kind, c.row.sender_agent.as_deref(), &c.row.sender_id, Some(&c.row.sender_name));
    let orchestrators: Vec<String> = model
        .participants()
        .iter()
        .filter(|p| is_active_orchestrator(p))
        .map(|p| p.id.clone())
        .collect();
    let active_sessions: Vec<&ParticipantRow> = model.participants().iter().filter(|p| is_active_session(p)).collect();
    let present: Vec<String> = active_sessions.iter().map(|p| p.id.clone()).collect();
    let listening: Vec<String> = active_sessions
        .iter()
        .filter(|p| c.channel_type == ChannelType::Thread || channel_of_participant(model, p) == c.row.channel_id)
        .map(|p| p.id.clone())
        .collect();
    let thread_owner = thread_owner_of(c, &active_sessions);

    let audience = Audience {
        from: c.row.sender_id.clone(),
        actor: actor.clone(),
        kind,
        mentions: c.mentions.clone(),
        channel: c.channel_type,
        peer: c.peer.clone(),
        channel_members: c.channel_members.clone(),
        orchestrators: orchestrators.clone(),
        thread_owner: thread_owner.clone(),
        sessions: listening,
        present: Some(present),
        members: c.members.clone(),
        outcome: meta.outcome,
        spoken: meta.spoken == Some(true) && meta.ingress_source.as_deref() != Some("voice"),
    };
    let candidates = match &meta.ingress_recipient {
        Some(to) => vec![Recipient::new(to.clone(), Reason::Addressed, true)],
        None => who_hears(&audience),
    };
    let scope = format!("channel:{}", c.row.channel_id);
    let ids: Vec<String> = candidates.iter().map(|d| d.recipient.clone()).collect();
    let cooling = reach.cooling(&ids, at);
    let braked = brakes(
        candidates,
        &BrakeInput {
            actor: &actor,
            orchestrators: &orchestrators,
            hops: reach.hops(&scope),
            cooling: &cooling,
        },
    );
    match actor {
        Actor::User { .. } => reach.user_spoke(&scope),
        Actor::Agent { .. } => {
            for d in braked.iter().filter(|d| d.wakes && d.held_by.is_none()) {
                reach.woke(&scope, &d.recipient, at);
            }
        }
        Actor::System { .. } => {}
    }
    let hop_limit_hit = braked.iter().any(|d| d.held_by == Some(HeldBy::HopLimit));

    let mut deliveries = Vec::new();
    let pooled_issue = match (&c.topic, &actor, kind) {
        (Some((SubjectKind::Issue, issue)), Actor::User { .. }, MessageKind::Chat) if c.channel_type == ChannelType::Thread => Some(issue.clone()),
        _ => None,
    };
    if let Some(issue_id) = &pooled_issue {
        deliveries.push(PlannedDelivery {
            recipient_kind: DeliveryTargetKind::Issue,
            recipient_id: issue_id.clone(),
            reason: Reason::OwnThread,
            wakes: true,
            held_by: None,
        });
    }
    if c.channel_type == ChannelType::Direct
        && matches!(actor, Actor::User { .. })
        && kind == MessageKind::Chat
        && let Some(peer) = c.peer.as_deref()
        && let Some(p) = model.participant(peer)
        && let Some(agent) = p.agent_id.as_deref()
        && p.id == profile_id(agent)
    {
        deliveries.push(PlannedDelivery {
            recipient_kind: DeliveryTargetKind::Direct,
            recipient_id: agent.to_string(),
            reason: Reason::Direct,
            wakes: true,
            held_by: None,
        });
    }
    for d in braked {
        if pooled_issue.is_some() && thread_owner.as_deref() == Some(d.recipient.as_str()) {
            continue;
        }
        let recipient_kind = if orchestrators.iter().any(|o| o == &d.recipient) {
            DeliveryTargetKind::Orchestrator
        } else {
            DeliveryTargetKind::Session
        };
        deliveries.push(PlannedDelivery {
            recipient_kind,
            recipient_id: d.recipient,
            reason: d.reason,
            wakes: d.wakes && d.held_by.is_none(),
            held_by: d.held_by,
        });
    }
    DispatchPlan { deliveries, hop_limit_hit }
}

#[cfg(test)]
mod tests {
    use vibevalley_protocol::AgentRole;

    use super::*;
    use crate::collab::channel::db::{ChannelRow, EventRow, MsgRow};
    use crate::collab::channel::types::Place;

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
    fn hop_and_cooldown_in_priority_order_and_the_user_passes() {
        let two = vec![Recipient::new("w1", Reason::Mention, true), Recipient::new("w2", Reason::Mention, true)];
        let w0 = agent("w0", AgentRole::Worker);
        let none: Vec<String> = vec![];
        let cool = s(&["w1"]);
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: HOP_LIMIT,
            cooling: &cool,
        };
        assert_eq!(held(&brakes(two.clone(), &i)), vec![Some(HeldBy::HopLimit); 2]);
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: 0,
            cooling: &cool,
        };
        assert_eq!(held(&brakes(two.clone(), &i)), vec![Some(HeldBy::Cooldown), None]);
        let u = user();
        let i = BrakeInput {
            actor: &u,
            orchestrators: &none,
            hops: HOP_LIMIT,
            cooling: &cool,
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
        };
        assert_eq!(held(&brakes(many, &i)), vec![None, None, Some(HeldBy::HopLimit)]);
        let a = s(&["a"]);
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: HOP_LIMIT,
            cooling: &a,
        };
        let quiet = vec![Recipient::new("a", Reason::Channel, false)];
        assert_eq!(brakes(quiet.clone(), &i), quiet);
    }

    #[test]
    fn the_reach_counts_hops_until_the_user_speaks_and_cools_sessions_down() {
        let mut r = Reach::default();
        r.woke("c", "w1", 1);
        r.woke("c", "w2", 5);
        assert_eq!(r.hops("c"), 2);
        r.user_spoke("c");
        assert_eq!(r.hops("c"), 0);
        r.woke("c", "w2", 6);
        assert_eq!((r.hops("c"), r.hops("elsewhere")), (1, 0));

        let mut r = Reach::default();
        r.woke("c", "w2", 9);
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

    #[test]
    fn plan_deliveries_routes_issue_threads_and_direct_profiles_from_channel_model() {
        let mut model = ChatModel::default();
        let general = ChannelRow {
            is_default: true,
            name: Some("general".into()),
            ..ChannelRow::empty("c-gen", "channel", 1)
        };
        let thread = ChannelRow {
            parent_id: Some("c-gen".into()),
            subject_kind: Some("issue".into()),
            subject_id: Some("i1".into()),
            ..ChannelRow::empty("t-1", "thread", 2)
        };
        let direct = ChannelRow {
            peer_id: Some(profile_id("reviewer")),
            ..ChannelRow::empty("d-1", "direct", 3)
        };
        model.load(
            vec![general, thread, direct],
            vec![
                ParticipantRow {
                    id: USER_ID.into(),
                    kind: "user".into(),
                    name: "User".into(),
                    agent_id: None,
                    home_id: None,
                    joined_at: 1,
                    left_at: None,
                },
                ParticipantRow {
                    id: "orchestrator".into(),
                    kind: "agent".into(),
                    name: "Assistant".into(),
                    agent_id: None,
                    home_id: None,
                    joined_at: 1,
                    left_at: None,
                },
                ParticipantRow {
                    id: profile_id("reviewer"),
                    kind: "agent".into(),
                    name: "Reviewer".into(),
                    agent_id: Some("reviewer".into()),
                    home_id: None,
                    joined_at: 2,
                    left_at: None,
                },
                ParticipantRow {
                    id: "w1".into(),
                    kind: "agent".into(),
                    name: "Reviewer #1".into(),
                    agent_id: Some("reviewer".into()),
                    home_id: Some("t-1".into()),
                    joined_at: 3,
                    left_at: None,
                },
            ],
            vec![],
            &[("c-gen".into(), "orchestrator".into()), ("t-1".into(), "w1".into())],
        );
        let mut reach = Reach::default();

        let thread_msg = Committed {
            event: EventRow {
                seq: 1,
                kind: "posted".into(),
                channel_id: "t-1".into(),
                message_id: "m1".into(),
                at: 10,
            },
            row: MsgRow {
                id: "m1".into(),
                channel_id: "t-1".into(),
                number: 1,
                sender_id: USER_ID.into(),
                kind: "chat".into(),
                body: "please re-check".into(),
                meta: None,
                send_key: None,
                created_at: 10,
                revision: 1,
                reply_number: None,
                edited_at: None,
                deleted_at: None,
                pinned_at: None,
                reactions: None,
                sender_name: "User".into(),
                sender_kind: "user".into(),
                sender_agent: None,
            },
            place: Place {
                id: "t-1".into(),
                r#type: ChannelType::Thread,
                peer: None,
                parent: Some("c-gen".into()),
                name: None,
                last_number: 1,
                root: None,
                topic: Some((SubjectKind::Issue, "i1".into())),
            },
            channel_name: "general".into(),
            mentions: vec![],
            channel_type: ChannelType::Thread,
            peer: None,
            orchestrator: "orchestrator".into(),
            channel_members: vec!["orchestrator".into()],
            members: vec!["w1".into()],
            topic: Some((SubjectKind::Issue, "i1".into())),
        };
        let plan = plan_deliveries(&model, &mut reach, &thread_msg, 10);
        assert!(!plan.hop_limit_hit);
        assert_eq!(
            plan.deliveries,
            vec![PlannedDelivery {
                recipient_kind: DeliveryTargetKind::Issue,
                recipient_id: "i1".into(),
                reason: Reason::OwnThread,
                wakes: true,
                held_by: None,
            }]
        );

        let direct_msg = Committed {
            event: EventRow {
                seq: 2,
                kind: "posted".into(),
                channel_id: "d-1".into(),
                message_id: "m2".into(),
                at: 20,
            },
            row: MsgRow {
                id: "m2".into(),
                channel_id: "d-1".into(),
                ..thread_msg.row.clone()
            },
            place: Place {
                id: "d-1".into(),
                r#type: ChannelType::Direct,
                peer: Some(profile_id("reviewer")),
                parent: None,
                name: None,
                last_number: 1,
                root: None,
                topic: None,
            },
            channel_name: String::new(),
            mentions: vec![],
            channel_type: ChannelType::Direct,
            peer: Some(profile_id("reviewer")),
            orchestrator: "orchestrator".into(),
            channel_members: vec![],
            members: vec![],
            topic: None,
        };
        let plan = plan_deliveries(&model, &mut reach, &direct_msg, 20);
        assert_eq!(
            plan.deliveries,
            vec![PlannedDelivery {
                recipient_kind: DeliveryTargetKind::Direct,
                recipient_id: "reviewer".into(),
                reason: Reason::Direct,
                wakes: true,
                held_by: None,
            }]
        );
    }
}
