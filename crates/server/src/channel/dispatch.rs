//! Pure channel audience selection and loop-guard brakes (`hopLimit` and
//! `cooldown`) unified on typed [`ParticipantId`]. Inspects only channel tables
//! and types, with zero imports of `issue`, `runtime`, or `agent`.

use vibevalley_protocol::{Actor, ChannelType, EVERYONE, MessageKind, Outcome, ParticipantId, SubjectKind};

use super::model::ChatModel;
use super::types::{Committed, HeldBy, Reach, Reason, actor_of, agent_seat_id, message_kind, meta_of};
use crate::service::channel::ParticipantRow;

/// How many times Agent -> Agent words may wake another agent in one place
/// before a human speaks there again. Never limits human messages or Agent -> Human mentions.
pub const HOP_LIMIT: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    pub recipient: ParticipantId,
    pub reason: Reason,
    pub wakes: bool,
    pub held_by: Option<HeldBy>,
}

impl Recipient {
    pub fn new(recipient: ParticipantId, reason: Reason, wakes: bool) -> Recipient {
        Recipient {
            recipient,
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
    /// Daemon/orchestrator profile ids seated in this channel.
    pub channel_members: Vec<String>,
    /// All active daemon/orchestrator profile ids.
    pub orchestrators: Vec<String>,
    /// Active human participants (`user:<id>`).
    pub humans: Vec<ParticipantId>,
    pub thread_owner: Option<String>,
    /// The seated worker sessions listening in the place.
    pub sessions: Vec<String>,
    /// Every seated active worker session; none means `sessions`.
    pub present: Option<Vec<String>>,
    /// Thread or direct-channel explicit members (participant ids).
    pub members: Vec<String>,
    pub outcome: Option<Outcome>,
    pub spoken: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedDelivery {
    pub recipient: ParticipantId,
    pub reason: Reason,
    pub wakes: bool,
    pub held_by: Option<HeldBy>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DispatchPlan {
    pub deliveries: Vec<PlannedDelivery>,
    pub hop_limit_hit: bool,
}

fn is_human(a: &Actor) -> bool {
    matches!(a, Actor::User { .. })
}

fn is_agent(a: &Actor) -> bool {
    matches!(a, Actor::Agent { .. })
}

fn sender_participant(from: &str, actor: &Actor, orchestrators: &[String]) -> Option<ParticipantId> {
    if let Some(parsed) = ParticipantId::parse(from) {
        return Some(parsed);
    }
    match actor {
        Actor::User { id, .. } => Some(ParticipantId::parse(id).unwrap_or_else(|| ParticipantId::user(id.clone()))),
        Actor::Agent { .. } => {
            if orchestrators.iter().any(|o| o == from) {
                Some(ParticipantId::agent(from))
            } else {
                Some(ParticipantId::session(from))
            }
        }
        Actor::System { .. } => None,
    }
}

fn resolve_id(raw: &str, orchestrators: &[String]) -> ParticipantId {
    if let Some(parsed) = ParticipantId::parse(raw) {
        return parsed;
    }
    if orchestrators.iter().any(|o| o == raw) {
        ParticipantId::agent(raw)
    } else {
        ParticipantId::session(raw)
    }
}

struct AudienceSink<'a> {
    from_raw: &'a str,
    from_pid: Option<ParticipantId>,
    orchestrators: &'a [String],
    humans: &'a [ParticipantId],
    present: &'a [String],
    out: Vec<Recipient>,
}

impl<'a> AudienceSink<'a> {
    fn new(a: &'a Audience) -> Self {
        Self {
            from_raw: &a.from,
            from_pid: sender_participant(&a.from, &a.actor, &a.orchestrators),
            orchestrators: &a.orchestrators,
            humans: &a.humans,
            present: a.present.as_deref().unwrap_or(&a.sessions),
            out: Vec::new(),
        }
    }

    fn is_self(&self, recipient: &ParticipantId) -> bool {
        if self.from_pid.as_ref() == Some(recipient) {
            return true;
        }
        recipient.to_string() == self.from_raw || recipient.raw_id() == self.from_raw
    }

    fn push(&mut self, recipient: ParticipantId, reason: Reason, wakes: bool) {
        if self.is_self(&recipient) || self.out.iter().any(|d| d.recipient == recipient) {
            return;
        }
        let allowed = match &recipient {
            ParticipantId::User(_) => self.humans.is_empty() || self.humans.contains(&recipient),
            ParticipantId::Agent(profile) => reason == Reason::Direct || self.orchestrators.iter().any(|o| o == profile),
            ParticipantId::Session(sid) => sid.starts_with("issue:") || self.present.iter().any(|p| p == sid),
        };
        if allowed {
            self.out.push(Recipient::new(recipient, reason, wakes));
        }
    }
}

fn is_silent_audience(a: &Audience) -> bool {
    matches!(a.kind, MessageKind::Notice | MessageKind::Dispatch) || matches!(a.actor, Actor::System { .. }) || a.spoken
}

fn add_direct_recipients(a: &Audience, sink: &mut AudienceSink<'_>) {
    if is_human(&a.actor) {
        // Prefer canonical channel `peer` when it points to another participant
        // (e.g. `agent:<profile>` for helper/orchestrator DMs, or `user:<other>` for H2H DMs).
        // Fall back to `a.members` when `peer` is absent or refers to the sender itself (e.g.
        // when the peer replies in a human-to-human DM).
        if let Some(peer) = a.peer.as_deref().filter(|p| !p.is_empty()) {
            let pid = ParticipantId::parse(peer).unwrap_or_else(|| ParticipantId::agent(peer));
            if !sink.is_self(&pid) {
                sink.push(pid, Reason::Direct, true);
                return;
            }
        }
        let mut routed = false;
        for m in &a.members {
            let pid = resolve_id(m, &a.orchestrators);
            if !sink.is_self(&pid) {
                sink.push(pid, Reason::Direct, true);
                routed = true;
            }
        }
        if !routed && let Some(owner) = a.thread_owner.as_deref().filter(|o| !o.is_empty()) {
            sink.push(ParticipantId::session(owner), Reason::Direct, true);
        }
        return;
    }

    if is_agent(&a.actor) {
        // Agent -> Human DM reply: notify the human participant(s) of this DM.
        let mut any_human = false;
        for m in &a.members {
            if let Some(pid) = ParticipantId::parse(m).filter(ParticipantId::is_human) {
                sink.push(pid, Reason::Direct, true);
                any_human = true;
            }
        }
        if !any_human {
            sink.push(ParticipantId::local_user(), Reason::Direct, true);
        }
    }
}

fn add_mention_recipients(a: &Audience, sink: &mut AudienceSink<'_>) {
    let human_sender = is_human(&a.actor);
    for mention in &a.mentions {
        if mention == EVERYONE {
            if human_sender {
                for s in &a.sessions {
                    sink.push(ParticipantId::session(s), Reason::Everyone, true);
                }
            }
            continue;
        }
        let pid = resolve_id(mention, &a.orchestrators);
        sink.push(pid, Reason::Mention, true);
    }
}

fn add_place_recipients(a: &Audience, sink: &mut AudienceSink<'_>) {
    let is_thread = a.channel == ChannelType::Thread;
    if is_thread && let Some(owner) = a.thread_owner.as_deref().filter(|o| !o.is_empty()) {
        sink.push(ParticipantId::session(owner), Reason::OwnThread, true);
    }
    if is_human(&a.actor) {
        if is_thread {
            for m in &a.members {
                sink.push(resolve_id(m, &a.orchestrators), Reason::Member, true);
            }
            return;
        }
        let mentions_other = a.mentions.iter().any(|m| {
            if m == EVERYONE {
                return true;
            }
            !sink.is_self(&resolve_id(m, &a.orchestrators))
        });
        for m in &a.channel_members {
            if !mentions_other {
                sink.push(ParticipantId::agent(m), Reason::Addressed, true);
            } else {
                // Explicit @mention to another participant: daemon orchestrator records passive context (`wakes: false`).
                sink.push(ParticipantId::agent(m), Reason::Channel, false);
            }
        }
        for s in &a.sessions {
            sink.push(ParticipantId::session(s), Reason::Channel, false);
        }
        return;
    }

    if is_agent(&a.actor) && !is_thread {
        // Non-thread channel message from an agent: channel-member orchestrators receive passive context (`wakes: false`),
        // unifying former `ChatIntake::overhear` onto the single durable delivery pipeline.
        for m in &a.channel_members {
            sink.push(ParticipantId::agent(m), Reason::Channel, false);
        }
    }
}

/// `whoHears`: who hears a message before the brakes.
pub fn who_hears(a: &Audience) -> Vec<Recipient> {
    if is_silent_audience(a) {
        return Vec::new();
    }
    let mut sink = AudienceSink::new(a);
    if a.channel == ChannelType::Direct {
        add_direct_recipients(a, &mut sink);
        return sink.out;
    }
    if a.kind == MessageKind::Report {
        for m in &a.channel_members {
            sink.push(ParticipantId::agent(m), Reason::Addressed, a.outcome == Some(Outcome::Failed));
        }
        return sink.out;
    }
    add_mention_recipients(a, &mut sink);
    add_place_recipients(a, &mut sink);
    sink.out
}

pub struct BrakeInput<'a> {
    pub actor: &'a Actor,
    pub orchestrators: &'a [String],
    /// Agent -> Agent wakes in this place since a human last spoke there.
    pub hops: usize,
    /// Recipients still cooling down from the last agent's words that woke them.
    pub cooling: &'a [ParticipantId],
}

/// `brakes`, in priority order (`HopLimit` then `Cooldown`).
///
/// **Invariant (#118)**: `HOP_LIMIT` and `Cooldown` apply **ONLY** to
/// Agent -> Agent wakes (`by_agent && recipient.is_agent()`). Human -> Agent,
/// Human -> Human, and Agent -> Human deliveries are NEVER braked and never
/// increment the agent hop counter.
pub fn brakes(deliveries: Vec<Recipient>, input: &BrakeInput) -> Vec<Recipient> {
    let by_agent = is_agent(input.actor);
    let mut hops = input.hops;
    deliveries
        .into_iter()
        .map(|mut d| {
            let agent_to_agent = d.wakes && by_agent && d.recipient.is_agent();
            let is_orch = matches!(&d.recipient, ParticipantId::Agent(profile) if input.orchestrators.contains(profile));
            let held = if agent_to_agent && hops >= HOP_LIMIT {
                Some(HeldBy::HopLimit)
            } else if agent_to_agent && !is_orch && input.cooling.contains(&d.recipient) {
                Some(HeldBy::Cooldown)
            } else {
                None
            };
            if agent_to_agent && held.is_none() {
                hops += 1;
            }
            d.held_by = held;
            d
        })
        .collect()
}

fn is_active_orchestrator(p: &ParticipantRow) -> bool {
    p.kind == "agent" && p.agent_id.is_none() && p.left_at.is_none()
}

fn is_active_human(p: &ParticipantRow) -> bool {
    p.kind == "user" && p.left_at.is_none()
}

fn is_active_session(p: &ParticipantRow) -> bool {
    p.kind == "agent" && p.left_at.is_none() && p.agent_id.as_deref().is_some_and(|a| p.id != agent_seat_id(a))
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
/// Agent -> Agent `hopLimit` & `cooldown` brakes, updates `reach`, and returns
/// typed [`PlannedDelivery`] rows keyed by [`ParticipantId`].
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
    let humans: Vec<ParticipantId> = model
        .participants()
        .iter()
        .filter(|p| is_active_human(p))
        .map(|p| ParticipantId::parse(&p.id).unwrap_or_else(|| ParticipantId::user(&p.id)))
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
        humans,
        thread_owner: thread_owner.clone(),
        sessions: listening,
        present: Some(present),
        members: c.members.clone(),
        outcome: meta.outcome,
        spoken: meta.spoken == Some(true) && meta.ingress_source.as_deref() != Some("voice"),
    };
    let candidates = match &meta.ingress_recipient {
        Some(to) => vec![Recipient::new(resolve_id(to, &orchestrators), Reason::Addressed, true)],
        None => who_hears(&audience),
    };
    let scope = format!("channel:{}", c.row.channel_id);
    let ids: Vec<ParticipantId> = candidates.iter().map(|d| d.recipient.clone()).collect();
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
            for d in braked.iter().filter(|d| d.wakes && d.held_by.is_none() && d.recipient.is_agent()) {
                reach.woke(&scope, &d.recipient, at);
            }
        }
        Actor::System { .. } => {}
    }
    let hop_limit_hit = braked.iter().any(|d| d.held_by == Some(HeldBy::HopLimit));

    let mut deliveries = Vec::new();
    // Pooled issue thread with no active worker session yet: target the synthetic `session:issue:<id>` slot
    // so DeliveryRouter routes to IssueChat to wake/assign the issue.
    if let (Some((SubjectKind::Issue, issue_id)), Actor::User { .. }, MessageKind::Chat) = (&c.topic, &actor, kind)
        && c.channel_type == ChannelType::Thread
        && thread_owner.is_none()
    {
        deliveries.push(PlannedDelivery {
            recipient: ParticipantId::session(format!("issue:{issue_id}")),
            reason: Reason::OwnThread,
            wakes: true,
            held_by: None,
        });
    }
    for d in braked {
        if deliveries.iter().any(|existing| existing.recipient == d.recipient) {
            continue;
        }
        deliveries.push(PlannedDelivery {
            recipient: d.recipient,
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
    use crate::channel::types::Place;
    use crate::service::channel::{ChannelRow, EventRow, MsgRow};

    fn agent(id: &str, role: AgentRole) -> Actor {
        Actor::Agent {
            id: id.into(),
            role,
            name: None,
            for_user: None,
        }
    }

    fn user(id: &str) -> Actor {
        Actor::User {
            id: ParticipantId::user(id).to_string(),
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
    fn hop_and_cooldown_apply_only_to_agent_to_agent_and_never_to_humans() {
        let two_agents = vec![
            Recipient::new(ParticipantId::session("w1"), Reason::Mention, true),
            Recipient::new(ParticipantId::session("w2"), Reason::Mention, true),
        ];
        let w0 = agent("w0", AgentRole::Worker);
        let none: Vec<String> = vec![];
        let cool = vec![ParticipantId::session("w1")];
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: HOP_LIMIT,
            cooling: &cool,
        };
        assert_eq!(held(&brakes(two_agents.clone(), &i)), vec![Some(HeldBy::HopLimit); 2]);

        // Agent -> Human mention MUST bypass HOP_LIMIT and Cooldown even at HOP_LIMIT!
        let mixed = vec![
            Recipient::new(ParticipantId::user("alice"), Reason::Mention, true),
            Recipient::new(ParticipantId::session("w1"), Reason::Mention, true),
        ];
        assert_eq!(held(&brakes(mixed, &i)), vec![None, Some(HeldBy::HopLimit)]);

        // Agent -> Agent cooldown
        let i_cool = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: 0,
            cooling: &cool,
        };
        assert_eq!(held(&brakes(two_agents.clone(), &i_cool)), vec![Some(HeldBy::Cooldown), None]);

        // Human -> Agent NEVER braked
        let u = user("alice");
        let i_human = BrakeInput {
            actor: &u,
            orchestrators: &none,
            hops: HOP_LIMIT,
            cooling: &cool,
        };
        assert_eq!(brakes(two_agents.clone(), &i_human), two_agents);
    }

    #[test]
    fn each_agent_to_agent_wake_is_a_hop_while_human_and_passive_deliveries_do_not_consume_hops() {
        let many = vec![
            Recipient::new(ParticipantId::user("bob"), Reason::Mention, true),
            Recipient::new(ParticipantId::session("a"), Reason::Mention, true),
            Recipient::new(ParticipantId::session("b"), Reason::Mention, true),
            Recipient::new(ParticipantId::session("c"), Reason::Mention, true),
        ];
        let w0 = agent("w0", AgentRole::Worker);
        let none: Vec<String> = vec![];
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: HOP_LIMIT - 2,
            cooling: &[],
        };
        // user:bob does not consume a hop; a & b consume hops 2->3->4; c hits HopLimit.
        assert_eq!(held(&brakes(many, &i)), vec![None, None, None, Some(HeldBy::HopLimit)]);

        let a = vec![ParticipantId::session("a")];
        let i = BrakeInput {
            actor: &w0,
            orchestrators: &none,
            hops: HOP_LIMIT,
            cooling: &a,
        };
        let quiet = vec![Recipient::new(ParticipantId::session("a"), Reason::Channel, false)];
        assert_eq!(brakes(quiet.clone(), &i), quiet);
    }

    #[test]
    fn reach_counts_hops_until_human_speaks_and_cools_sessions_down() {
        let w1 = ParticipantId::session("w1");
        let w2 = ParticipantId::session("w2");
        let w4 = ParticipantId::session("w4");
        let w5 = ParticipantId::session("w5");
        let mut r = Reach::default();
        r.woke("c", &w1, 1);
        r.woke("c", &w2, 5);
        assert_eq!(r.hops("c"), 2);
        r.user_spoke("c");
        assert_eq!(r.hops("c"), 0);
        r.woke("c", &w2, 6);
        assert_eq!((r.hops("c"), r.hops("elsewhere")), (1, 0));

        let mut r = Reach::default();
        r.woke("c", &w2, 9);
        r.woke("c", &w2, 4);
        r.woke("c", &w4, 12);
        assert_eq!(r.cooling(&[w2.clone(), w4.clone(), w5.clone()], 9 + 1000), vec![w2.clone(), w4.clone()]);
        assert_eq!(r.cooling(&[w2.clone(), w4.clone()], 9 + 60_000), vec![w4.clone()]);
        r.left(&w2);
        assert!(r.cooling(&[w2], 10).is_empty());
    }

    #[test]
    fn multi_human_mentions_passive_orchestrator_context_and_dm_routing() {
        let alice = ParticipantId::user("alice");
        let bob = ParticipantId::user("bob");
        let base = Audience {
            from: alice.to_string(),
            actor: user("alice"),
            kind: MessageKind::Chat,
            mentions: vec![],
            channel: ChannelType::Channel,
            peer: None,
            channel_members: s(&["lead"]),
            orchestrators: s(&["orchestrator", "lead"]),
            humans: vec![alice.clone(), bob.clone()],
            thread_owner: None,
            sessions: s(&["w1"]),
            present: None,
            members: vec![],
            outcome: None,
            spoken: false,
        };
        let heard = |a: &Audience, cooling: &[ParticipantId]| {
            let i = BrakeInput {
                actor: &a.actor,
                orchestrators: &a.orchestrators,
                hops: 0,
                cooling,
            };
            brakes(who_hears(a), &i)
        };

        // Unaddressed human message wakes channel orchestrator and delivers passive context to w1.
        let got: Vec<(ParticipantId, Reason, bool)> = heard(&base, &[]).into_iter().map(|d| (d.recipient, d.reason, d.wakes)).collect();
        assert_eq!(
            got,
            vec![
                (ParticipantId::agent("lead"), Reason::Addressed, true),
                (ParticipantId::session("w1"), Reason::Channel, false),
            ]
        );

        // Alice @mentions Bob: Bob wakes via Mention, lead gets passive context (wakes: false), w1 gets passive context.
        let mention_bob = Audience {
            mentions: vec![bob.to_string()],
            ..base.clone()
        };
        let got: Vec<(ParticipantId, Reason, bool)> = heard(&mention_bob, &[]).into_iter().map(|d| (d.recipient, d.reason, d.wakes)).collect();
        assert_eq!(
            got,
            vec![
                (bob.clone(), Reason::Mention, true),
                (ParticipantId::agent("lead"), Reason::Channel, false),
                (ParticipantId::session("w1"), Reason::Channel, false),
            ]
        );

        // Human -> Human DM (alice -> bob)
        let human_dm = Audience {
            channel: ChannelType::Direct,
            peer: Some(bob.to_string()),
            members: vec![alice.to_string(), bob.to_string()],
            ..base.clone()
        };
        assert_eq!(heard(&human_dm, &[]), vec![Recipient::new(bob.clone(), Reason::Direct, true)]);

        // Worker speaks in channel without mentioning orchestrator: lead gets passive context (wakes: false).
        let worker_chat = Audience {
            from: "w1".into(),
            actor: agent("w1", AgentRole::Worker),
            mentions: vec![],
            ..base.clone()
        };
        assert_eq!(
            heard(&worker_chat, &[]),
            vec![Recipient::new(ParticipantId::agent("lead"), Reason::Channel, false)]
        );

        // Failed report wakes orchestrator; completed report delivers passive context (wakes: false).
        let failed_report = Audience {
            from: "w1".into(),
            actor: agent("w1", AgentRole::Worker),
            kind: MessageKind::Report,
            outcome: Some(Outcome::Failed),
            ..base.clone()
        };
        assert_eq!(
            who_hears(&failed_report),
            vec![Recipient::new(ParticipantId::agent("lead"), Reason::Addressed, true)]
        );
        let ok_report = Audience {
            outcome: Some(Outcome::Completed),
            ..failed_report
        };
        assert_eq!(
            who_hears(&ok_report),
            vec![Recipient::new(ParticipantId::agent("lead"), Reason::Addressed, false)]
        );
    }

    #[test]
    fn plan_deliveries_unifies_issue_threads_and_direct_profiles_on_participant_id() {
        let local = ParticipantId::local_user();
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
            peer_id: Some(agent_seat_id("reviewer")),
            ..ChannelRow::empty("d-1", "direct", 3)
        };
        model.load(
            vec![general, thread, direct],
            vec![
                ParticipantRow {
                    id: local.to_string(),
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
                    id: agent_seat_id("reviewer"),
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
                sender_id: local.to_string(),
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
                recipient: ParticipantId::session("w1"),
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
                peer: Some(agent_seat_id("reviewer")),
                parent: None,
                name: None,
                last_number: 1,
                root: None,
                topic: None,
            },
            channel_name: String::new(),
            mentions: vec![],
            channel_type: ChannelType::Direct,
            peer: Some(agent_seat_id("reviewer")),
            orchestrator: "orchestrator".into(),
            channel_members: vec![],
            members: vec![],
            topic: None,
        };
        let plan = plan_deliveries(&model, &mut reach, &direct_msg, 20);
        assert_eq!(
            plan.deliveries,
            vec![PlannedDelivery {
                recipient: ParticipantId::agent("reviewer"),
                reason: Reason::Direct,
                wakes: true,
                held_by: None,
            }]
        );
    }
}
