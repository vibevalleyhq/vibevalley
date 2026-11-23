//! The one live state, the facts that change it and the frames the page
//! reads: owners write to storage first, then apply facts; `reduce` is pure;
//! the page reads frames.

use std::collections::BTreeMap;

use vibevalley_i18n::t;
use vibevalley_protocol::*;

use crate::channel::{with_channel, with_message, with_user_mentions};
use crate::game::{effects_of, empty_play, free_station, play_of, played_doing, played_run, stationed, view_of};
use crate::inbox::inbox;
use crate::rules::{farm_of, phase_words};
use crate::status::{board_summary, is_farm_worker, session_of, with_issue, with_issue_statuses};

/// Bitmask of state slices dirtied by one or more applied facts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct SliceMask(u8);

impl SliceMask {
    pub const NONE: Self = Self(0);
    pub const BOARD: Self = Self(1 << 0);
    pub const SESSIONS: Self = Self(1 << 1);
    pub const COLLAB: Self = Self(1 << 2);
    pub const INBOX: Self = Self(1 << 3);
    pub const OPS: Self = Self(1 << 4);
    pub const FARM: Self = Self(1 << 5);
    pub const ALL: Self = Self((1 << 6) - 1);

    pub const fn from_kind(kind: SliceKind) -> Self {
        match kind {
            SliceKind::Board => Self::BOARD,
            SliceKind::Sessions => Self::SESSIONS,
            SliceKind::Collab => Self::COLLAB,
            SliceKind::Inbox => Self::INBOX,
            SliceKind::Ops => Self::OPS,
            SliceKind::Farm => Self::FARM,
        }
    }

    pub const fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }

    pub const fn intersects(self, other: Self) -> bool {
        (self.0 & other.0) != 0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub fn kinds(self) -> impl Iterator<Item = SliceKind> {
        SliceKind::ALL.into_iter().filter(move |&k| self.contains(Self::from_kind(k)))
    }
}

impl std::ops::BitOr for SliceMask {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

impl std::ops::BitOrAssign for SliceMask {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl std::ops::BitAnd for SliceMask {
    type Output = Self;

    fn bitand(self, rhs: Self) -> Self {
        Self(self.0 & rhs.0)
    }
}

impl std::ops::BitAndAssign for SliceMask {
    fn bitand_assign(&mut self, rhs: Self) {
        self.0 &= rhs.0;
    }
}

/// `emptySpaceState`.
pub fn empty_space_state() -> SpaceState {
    SpaceState {
        call: CallState::Idle,
        call_reason: String::new(),
        media: None,
        chat: None,
        commits: None,
        progress: None,
        issues: vec![],
        connectors: vec![],
        machines: vec![],
        sessions: vec![],
        crons: vec![],
        plays: Some(BTreeMap::new()),
    }
}

fn ended(outcome: Outcome) -> Phase {
    match outcome {
        Outcome::Completed => Phase::Done(PhaseDone {}),
        Outcome::Failed => Phase::Failed(PhaseFailed {}),
        Outcome::Interrupted => Phase::Resting(PhaseResting {}),
    }
}

/// Pure `doing` or `spent` updates during a run never change an issue.
fn phase_affects_issue(before: &Phase, after: &Phase) -> bool {
    match (before, after) {
        (Phase::Working(a), Phase::Working(b)) => !(a.since == b.since && a.quiet_since == b.quiet_since),
        _ => true,
    }
}

fn with_session(state: &mut SpaceState, id: &str, change: impl FnOnce(&mut Session)) -> bool {
    match state.sessions.iter_mut().find(|h| h.id == id) {
        Some(h) => {
            change(h);
            true
        }
        None => false,
    }
}

/// `reduce`: folds one fact in. Returns `SliceMask::NONE` when it changes
/// nothing (and is not sent); facts about sessions not on the farm change
/// nothing.
pub fn reduce(state: &mut SpaceState, fact: &Fact) -> SliceMask {
    let before_phase = match fact {
        Fact::SessionPhaseChanged(f) => session_of(state, &f.id).map(|s| s.phase.clone()),
        _ => None,
    };
    let (mut dirty, touched_board) = fold(state, fact);
    if dirty.is_empty() {
        return SliceMask::NONE;
    }
    if let (Fact::SessionPhaseChanged(f), Some(before)) = (fact, &before_phase) {
        if phase_affects_issue(before, &f.phase) {
            dirty |= SliceMask::BOARD;
            with_issue_statuses(state);
        }
        return dirty;
    }
    if touched_board {
        with_issue_statuses(state);
    }
    dirty
}

/// (dirty slices, whether issue statuses must be recomputed).
fn fold(state: &mut SpaceState, f: &Fact) -> (SliceMask, bool) {
    match f {
        Fact::MediaChanged(f) => {
            if state.media.as_ref() == Some(&f.jobs) {
                return (SliceMask::NONE, false);
            }
            state.media = Some(f.jobs.clone());
            (SliceMask::OPS, false)
        }
        Fact::CallChanged(f) => {
            if state.call == f.state && state.call_reason == f.reason {
                return (SliceMask::NONE, false);
            }
            state.call = f.state;
            state.call_reason = f.reason.clone();
            (SliceMask::INBOX, false)
        }
        Fact::SessionToolsReset(f) => {
            let changed = with_session(state, &f.id, |h| h.tool_connections = Some(vec![]));
            (if changed { SliceMask::SESSIONS } else { SliceMask::NONE }, false)
        }
        Fact::SessionToolChanged(f) => {
            let changed = with_session(state, &f.id, |h| {
                let mut all: Vec<ToolConnection> = h
                    .tool_connections
                    .take()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|c| c.server != f.connection.server)
                    .collect();
                all.push(f.connection.clone());
                h.tool_connections = Some(all);
            });
            (if changed { SliceMask::SESSIONS } else { SliceMask::NONE }, false)
        }
        Fact::SessionSubagentsChanged(f) => {
            if session_of(state, &f.id).is_none_or(|s| s.subagents == f.subagents) {
                return (SliceMask::NONE, false);
            }
            let changed = with_session(state, &f.id, |s| s.subagents.clone_from(&f.subagents));
            (if changed { SliceMask::SESSIONS } else { SliceMask::NONE }, false)
        }
        Fact::SessionPhaseChanged(f) => {
            let Some(session) = session_of(state, &f.id) else {
                return (SliceMask::NONE, false);
            };
            if session.phase == f.phase
                && session.channel_id() == f.channel.as_deref()
                && f.spent.as_ref().is_none_or(|s| session.spent.as_ref() == Some(s))
                && f.brief.as_ref().is_none_or(|b| *b == session.brief)
            {
                return (SliceMask::NONE, false);
            }
            let was_working = session.phase.is_working();
            let track_play = is_farm_worker(session);
            with_session(state, &f.id, |h| {
                h.phase = f.phase.clone();
                match &f.channel {
                    Some(ch) => {
                        h.attach_binding(ContextRef::Channel { id: ch.clone() });
                    }
                    None => {
                        h.bindings.retain(|b| !matches!(b, ContextRef::Channel { .. }));
                    }
                }
                if let Some(b) = &f.brief {
                    h.brief = b.clone();
                }
                if let Some(s) = &f.spent {
                    h.spent = Some(s.clone());
                }
            });
            if track_play {
                let plays = state.plays.get_or_insert_with(BTreeMap::new);
                let before = play_of(Some(plays), &f.id);
                let play = match &f.phase {
                    Phase::Working(p) if was_working => played_doing(&before, f.at, p.doing.action, &p.doing.label),
                    Phase::Working(_) => played_run(&before, f.at),
                    _ => before,
                };
                plays.insert(f.id.clone(), play);
            }
            (SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM, false)
        }
        Fact::MessageChanged(f) => {
            let changed = with_message(&mut state.chat, &f.message);
            (if changed { SliceMask::COLLAB } else { SliceMask::NONE }, false)
        }
        Fact::ChannelChanged(f) => {
            if state
                .chat
                .as_ref()
                .is_some_and(|c| c.channels.iter().any(|x| x.id == f.channel.id && *x == f.channel))
            {
                return (SliceMask::NONE, false);
            }
            with_channel(&mut state.chat, f.channel.clone());
            (SliceMask::COLLAB, false)
        }
        Fact::ChannelRemoved(f) => {
            let Some(chat) = state.chat.as_mut() else {
                return (SliceMask::NONE, false);
            };
            let before = chat.channels.len();
            chat.channels.retain(|c| c.id != f.id && c.parent.as_deref() != Some(f.id.as_str()));
            (if chat.channels.len() != before { SliceMask::COLLAB } else { SliceMask::NONE }, false)
        }
        Fact::UserMentionsChanged(f) => {
            if state.chat.as_ref().map(|c| &c.user_mentions) == Some(&f.mentions) {
                return (SliceMask::NONE, false);
            }
            with_user_mentions(&mut state.chat, f.mentions.clone());
            (SliceMask::COLLAB | SliceMask::INBOX, false)
        }
        Fact::SessionChanged(f) => {
            let was = session_of(state, &f.session.id).is_some();
            state.sessions.retain(|h| h.id != f.session.id);
            if is_farm_worker(&f.session) {
                let play = if was {
                    play_of(state.plays.as_ref(), &f.session.id)
                } else {
                    let others: Vec<&Session> = state.sessions.iter().collect();
                    let station = free_station(state.plays.as_ref(), &others, farm_of(&f.session), None);
                    SessionPlay { station, ..empty_play() }
                };
                state.plays.get_or_insert_with(BTreeMap::new).insert(f.session.id.clone(), play);
            }
            state.sessions.push(f.session.clone());
            (SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM, true)
        }
        Fact::SessionReported(f) => {
            if session_of(state, &f.id).is_none() {
                return (SliceMask::NONE, false);
            }
            let open_pr = |issue: Option<&str>, issues: &[Issue]| {
                issue.is_some_and(|i| {
                    issues
                        .iter()
                        .any(|x| x.id == *i && x.pull_request.as_ref().is_some_and(|p| p.state == PullRequestState::Open))
                })
            };
            let issues = state.issues.clone();
            with_session(state, &f.id, |x| {
                x.runs = f.runs;
                x.phase = if f.outcome == Outcome::Completed && f.phase.is_some() && open_pr(x.issue_id(), &issues) {
                    Phase::Resting(PhaseResting {})
                } else {
                    ended(f.outcome)
                };
                x.last_run = Some(LastRun {
                    needs_reconciliation: false,
                    outcome: f.outcome,
                    summary: f.summary.clone(),
                    at: f.at,
                    spent: f.spent.clone(),
                    answer: f.answer.clone(),
                });
            });
            (SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM, true)
        }
        Fact::SessionLeft(f) => {
            if let Some(plays) = state.plays.as_mut() {
                plays.remove(&f.id);
            }
            state.sessions.retain(|h| h.id != f.id);
            (SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM, true)
        }
        Fact::ProgressChanged(f) => {
            let mut dirty = SliceMask::NONE;
            if let Some(c) = &f.commits
                && state.commits.as_ref() != Some(c)
            {
                state.commits = Some(c.clone());
                dirty |= SliceMask::FARM | SliceMask::BOARD;
            }
            if let Some(p) = &f.progress
                && state.progress.as_ref() != Some(p)
            {
                state.progress = Some(p.clone());
                dirty |= SliceMask::FARM;
            }
            if let Some(s) = &f.station
                && stationed(state, &s.id, s.station)
            {
                dirty |= SliceMask::FARM;
            }
            (dirty, false)
        }
        Fact::CronChanged(f) => {
            let was_pending = match state.crons.iter_mut().find(|x| x.id == f.cron.id) {
                Some(x) if *x == f.cron => return (SliceMask::NONE, false),
                Some(x) => {
                    let prev = x.pending;
                    *x = f.cron.clone();
                    prev
                }
                None => {
                    state.crons.push(f.cron.clone());
                    false
                }
            };
            let mut dirty = SliceMask::OPS;
            if was_pending || f.cron.pending {
                dirty |= SliceMask::INBOX;
            }
            (dirty, false)
        }
        Fact::CronRemoved(f) => {
            let had_pending = state.crons.iter().any(|x| x.id == f.id && x.pending);
            let before = state.crons.len();
            state.crons.retain(|x| x.id != f.id);
            if state.crons.len() == before {
                return (SliceMask::NONE, false);
            }
            let mut dirty = SliceMask::OPS;
            if had_pending {
                dirty |= SliceMask::INBOX;
            }
            (dirty, false)
        }
        Fact::IssueChanged(f) => {
            if state.issues.iter().any(|x| x.id == f.issue.id && *x == f.issue) {
                return (SliceMask::NONE, false);
            }
            let old_conflict = state.issues.iter().find(|x| x.id == f.issue.id).and_then(|x| x.conflict.as_ref());
            let conflict_changed = old_conflict != f.issue.conflict.as_ref();
            with_issue(&mut state.issues, f.issue.clone());
            let mut dirty = SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM;
            if conflict_changed {
                dirty |= SliceMask::SESSIONS;
            }
            (dirty, true)
        }
        Fact::IssueRemoved(f) => {
            let had_conflict = state.issues.iter().any(|x| x.id == f.id && x.conflict.is_some());
            let before = state.issues.len();
            state.issues.retain(|x| x.id != f.id);
            if state.issues.len() == before {
                return (SliceMask::NONE, false);
            }
            let mut dirty = SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM;
            if had_conflict {
                dirty |= SliceMask::SESSIONS;
            }
            (dirty, true)
        }
        Fact::ConnectorChanged(f) => {
            match state.connectors.iter_mut().find(|x| x.id == f.status.id) {
                Some(x) if *x == f.status => return (SliceMask::NONE, false),
                Some(x) => *x = f.status.clone(),
                None => state.connectors.push(f.status.clone()),
            }
            (SliceMask::COLLAB, false)
        }
        Fact::MachineChanged(f) => {
            match state.machines.iter_mut().find(|x| x.id == f.machine.id) {
                Some(x) if *x == f.machine => return (SliceMask::NONE, false),
                Some(x) => *x = f.machine.clone(),
                None => state.machines.push(f.machine.clone()),
            }
            (SliceMask::SESSIONS, false)
        }
    }
}

pub fn board_slice(state: &SpaceState, seq: i64) -> BoardSlice {
    BoardSlice {
        seq,
        issues: state.issues.clone(),
        board_summary: Some(board_summary(state)),
        commits: state.commits.clone(),
    }
}

pub fn sessions_slice(state: &SpaceState, seq: i64) -> SessionsSlice {
    let conflicts: std::collections::HashMap<&str, Option<&Conflict>> = state.issues.iter().map(|i| (i.id.as_str(), i.conflict.as_ref())).collect();
    SessionsSlice {
        seq,
        sessions: state
            .sessions
            .iter()
            .map(|h| session_view(h, h.issue_id().and_then(|i| conflicts.get(i).copied().flatten())))
            .collect(),
        machines: state.machines.clone(),
    }
}

pub fn collab_slice(state: &SpaceState, seq: i64) -> CollabSlice {
    CollabSlice {
        seq,
        chat: state.chat.clone(),
        channel_summary: Some(channel_summary(state)),
        connectors: state.connectors.clone(),
    }
}

pub fn inbox_slice(state: &SpaceState, seq: i64, extra_items: &[InboxItem]) -> InboxSlice {
    let mut items = inbox(state);
    if !extra_items.is_empty() {
        items.extend(extra_items.iter().cloned());
        items.sort_by_key(|i| std::cmp::Reverse(i.at));
    }
    InboxSlice {
        seq,
        items,
        call: state.call,
        call_reason: state.call_reason.clone(),
    }
}

pub fn ops_slice(state: &SpaceState, seq: i64) -> OpsSlice {
    OpsSlice {
        seq,
        crons: state.crons.iter().map(cron_view).collect(),
        media: state.media.clone(),
        media_summary: Some(media_summary(state)),
    }
}

pub fn farm_frame(state: &SpaceState, effects: Vec<GameEffect>, seq: i64) -> FarmFrame {
    FarmFrame {
        seq,
        view: view_of(state),
        progress: state.progress.clone(),
        effects,
    }
}

/// Offline snapshot, scenario, and fixture bundle assembling every slice.
pub fn slice_bundle(state: &SpaceState, effects: Vec<GameEffect>, seq: i64) -> SliceBundle {
    SliceBundle {
        seq,
        board: board_slice(state, seq),
        sessions: sessions_slice(state, seq),
        collab: collab_slice(state, seq),
        inbox: inbox_slice(state, seq, &[]),
        ops: ops_slice(state, seq),
        farm: farm_frame(state, effects, seq),
    }
}

fn doing_view(d: &Doing) -> DoingView {
    DoingView {
        action: d.action,
        label: d.label.clone(),
        action_text: t(&format!("shared.action.{}", d.action.as_str()), &[]),
    }
}

/// A session as the frame shows it (`withWords`).
pub fn session_view(h: &Session, conflict: Option<&Conflict>) -> SessionView {
    let phase = match &h.phase {
        Phase::Working(p) => PhaseView::Working(PhaseWorkingView {
            since: p.since,
            quiet_since: p.quiet_since,
            retry: p.retry.clone(),
            doing: doing_view(&p.doing),
        }),
        Phase::Done(p) => PhaseView::Done(p.clone()),
        Phase::Failed(p) => PhaseView::Failed(p.clone()),
        Phase::Resting(p) => PhaseView::Resting(p.clone()),
        Phase::Closed(p) => PhaseView::Closed(p.clone()),
    };
    SessionView {
        id: h.id.clone(),
        controller: h.controller,
        role: h.role,
        name: h.name.clone(),
        profile: h.profile.clone(),
        runtime: h.runtime.clone(),
        brief: h.brief.clone(),
        cwd: h.cwd.clone(),
        policy: h.policy.clone(),
        bindings: h.bindings.clone(),
        hired_at: h.hired_at,
        runs: h.runs,
        phase,
        last_run: h.last_run.clone(),
        spent: h.spent.clone(),
        subagents: h.subagents.clone(),
        tool_connections: h.tool_connections.clone(),
        machine: h.machine.clone(),
        phase_text: phase_words(h, conflict),
    }
}

fn when_to_rules(when: &vibevalley_protocol::CronWhen) -> crate::cron::CronWhen {
    match when {
        vibevalley_protocol::CronWhen::Once(w) => crate::cron::CronWhen::Once { at: w.at },
        vibevalley_protocol::CronWhen::Every(w) => crate::cron::CronWhen::Every { minutes: w.minutes as f64 },
        vibevalley_protocol::CronWhen::Daily(w) => crate::cron::CronWhen::Daily { time: w.time.clone() },
        vibevalley_protocol::CronWhen::Weekly(w) => crate::cron::CronWhen::Weekly {
            days: w.days.clone(),
            time: w.time.clone(),
        },
        vibevalley_protocol::CronWhen::Cron(w) => crate::cron::CronWhen::Cron { expr: w.expr.clone() },
    }
}

fn when_from_rules(when: crate::cron::CronWhen) -> vibevalley_protocol::CronWhen {
    match when {
        crate::cron::CronWhen::Once { at } => vibevalley_protocol::CronWhen::Once(vibevalley_protocol::CronWhenOnce { at }),
        crate::cron::CronWhen::Every { minutes } => vibevalley_protocol::CronWhen::Every(vibevalley_protocol::CronWhenEvery { minutes: minutes as i64 }),
        crate::cron::CronWhen::Daily { time } => vibevalley_protocol::CronWhen::Daily(vibevalley_protocol::CronWhenDaily { time }),
        crate::cron::CronWhen::Weekly { days, time } => vibevalley_protocol::CronWhen::Weekly(vibevalley_protocol::CronWhenWeekly { days, time }),
        crate::cron::CronWhen::Cron { expr } => vibevalley_protocol::CronWhen::Cron(vibevalley_protocol::CronWhenExpr { expr }),
    }
}

pub fn cron_to_rules(c: &Cron) -> crate::cron::Cron {
    crate::cron::Cron {
        id: c.id.clone(),
        name: c.name.clone(),
        text: c.text.clone(),
        channel: c.channel.clone(),
        agent: c.agent.clone(),
        repo: c.repo.clone(),
        when: when_to_rules(&c.when),
        tz: c.tz.clone(),
        enabled: c.enabled,
        created: c.created,
        last_run: c.last_run,
        by: match c.by {
            vibevalley_protocol::ActorKind::User => crate::cron::ActorKind::User,
            vibevalley_protocol::ActorKind::Agent => crate::cron::ActorKind::Agent,
            vibevalley_protocol::ActorKind::System => crate::cron::ActorKind::System,
        },
        pending: c.pending,
    }
}

pub fn cron_from_rules(c: crate::cron::Cron) -> Cron {
    Cron {
        id: c.id,
        name: c.name,
        text: c.text,
        channel: c.channel,
        agent: c.agent,
        repo: c.repo,
        when: when_from_rules(c.when),
        tz: c.tz,
        enabled: c.enabled,
        created: c.created,
        last_run: c.last_run,
        by: match c.by {
            crate::cron::ActorKind::User => vibevalley_protocol::ActorKind::User,
            crate::cron::ActorKind::Agent => vibevalley_protocol::ActorKind::Agent,
            crate::cron::ActorKind::System => vibevalley_protocol::ActorKind::System,
        },
        pending: c.pending,
    }
}

pub fn cron_request_to_rules(r: &vibevalley_protocol::CronRequest) -> crate::cron::CronRequest {
    crate::cron::CronRequest {
        name: r.name.clone(),
        text: r.text.clone(),
        channel: r.channel.clone(),
        agent: r.agent.clone(),
        repo: r.repo.clone(),
        when: when_to_rules(&r.when),
        tz: r.tz.clone(),
    }
}

/// A cron with its words (`whenText`, `nextText` of `issue/when.ts`, in
/// `vibevalley-core::cron`).
pub fn cron_view(c: &Cron) -> CronView {
    let ec = cron_to_rules(c);
    let when_text = crate::cron::when_text(&ec.when, &ec.tz);
    let next_text = crate::cron::next_text(&ec);
    CronView {
        id: c.id.clone(),
        name: c.name.clone(),
        text: c.text.clone(),
        channel: c.channel.clone(),
        agent: c.agent.clone(),
        repo: c.repo.clone(),
        when: c.when.clone(),
        tz: c.tz.clone(),
        enabled: c.enabled,
        created: c.created,
        last_run: c.last_run,
        by: c.by,
        pending: c.pending,
        when_text,
        next_text,
    }
}

fn is_active_media_phase(phase: MediaPhase) -> bool {
    match phase {
        MediaPhase::Queued | MediaPhase::Generating | MediaPhase::Downloading => true,
        MediaPhase::Ready | MediaPhase::Failed | MediaPhase::Unknown | MediaPhase::Canceled | MediaPhase::DownloadFailed => false,
    }
}

/// Active file-producing media jobs (excludes understanding jobs, which produce no file).
pub fn media_summary(state: &SpaceState) -> MediaSummary {
    let active_ids: Vec<String> = state
        .media
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|job| match job {
            MediaJob::MediaImageJob(j) => is_active_media_phase(j.phase).then(|| j.id.clone()),
            MediaJob::MediaSpeechJob(j) => is_active_media_phase(j.phase).then(|| j.id.clone()),
            MediaJob::MediaAudioJob(j) => {
                let (id, phase) = match j {
                    MediaAudioJob::Speakers { id, phase, .. }
                    | MediaAudioJob::VoiceDesign { id, phase, .. }
                    | MediaAudioJob::Clone { id, phase, .. }
                    | MediaAudioJob::Transcription { id, phase, .. } => (id, *phase),
                };
                is_active_media_phase(phase).then(|| id.clone())
            }
            MediaJob::MediaUnderstandingJob(_) => None,
        })
        .collect();
    MediaSummary {
        active_count: active_ids.len() as i64,
        active_ids,
    }
}

/// Total unread count across all channels plus per-channel unread rolled up with direct child threads.
pub fn channel_summary(state: &SpaceState) -> ChannelSummary {
    let channels = state.chat.as_ref().map_or(&[][..], |c| &c.channels[..]);
    let mut unread_total: i64 = 0;
    let mut children_unread: BTreeMap<&str, i64> = BTreeMap::new();
    for c in channels {
        let n = c.unread.unwrap_or(0);
        unread_total += n;
        if let Some(parent) = c.parent.as_deref()
            && parent != c.id.as_str()
        {
            *children_unread.entry(parent).or_default() += n;
        }
    }
    let mut unread_under = BTreeMap::new();
    for c in channels {
        let own = c.unread.unwrap_or(0);
        let kids = children_unread.get(c.id.as_str()).copied().unwrap_or(0);
        unread_under.insert(c.id.clone(), own + kids);
    }
    ChannelSummary { unread_total, unread_under }
}

/// A fact with the state just before and just after it.
#[derive(Debug, Clone)]
pub struct Transition {
    pub before: SpaceState,
    pub fact: Fact,
    pub after: SpaceState,
}

/// The farm's one state (`makeCore`, without its streams: the server adds
/// those). `apply` folds a batch as one commit.
#[derive(Debug, Clone)]
pub struct Core {
    state: SpaceState,
    seq: i64,
}

impl Default for Core {
    fn default() -> Self {
        Core {
            state: empty_space_state(),
            seq: 0,
        }
    }
}

/// What one `apply` did: the facts that changed the state, in order, the
/// slices they dirtied, and the farm effects they set off.
#[derive(Debug, Clone, Default)]
pub struct Applied {
    pub transitions: Vec<Transition>,
    pub effects: Vec<GameEffect>,
    pub dirty: SliceMask,
}

impl Core {
    pub fn new(state: SpaceState) -> Core {
        Core { state, seq: 0 }
    }

    pub fn state(&self) -> &SpaceState {
        &self.state
    }

    /// How many commits have changed the state (slice `seq`).
    pub fn seq(&self) -> i64 {
        self.seq
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        session_of(&self.state, id)
    }

    /// Folds `facts` in as one commit. Each fact's `at` is taken as given
    /// (the caller stamps them with its clock).
    pub fn apply(&mut self, facts: Vec<Fact>) -> Applied {
        let mut next = self.state.clone();
        let mut out = Applied::default();
        for fact in facts {
            let before = next.clone();
            let dirty = reduce(&mut next, &fact);
            if dirty.is_empty() {
                continue;
            }
            out.dirty |= dirty;
            out.effects.extend(effects_of(&before, &fact));
            out.transitions.push(Transition {
                before,
                fact,
                after: next.clone(),
            });
        }
        if !out.transitions.is_empty() {
            self.state = next;
            self.seq += 1;
        }
        out
    }

    pub fn board_slice(&self) -> BoardSlice {
        board_slice(&self.state, self.seq)
    }

    pub fn sessions_slice(&self) -> SessionsSlice {
        sessions_slice(&self.state, self.seq)
    }

    pub fn collab_slice(&self) -> CollabSlice {
        collab_slice(&self.state, self.seq)
    }

    pub fn inbox_slice(&self, extra_items: &[InboxItem]) -> InboxSlice {
        inbox_slice(&self.state, self.seq, extra_items)
    }

    pub fn ops_slice(&self) -> OpsSlice {
        ops_slice(&self.state, self.seq)
    }

    pub fn farm_frame(&self, effects: Vec<GameEffect>) -> FarmFrame {
        farm_frame(&self.state, effects, self.seq)
    }

    pub fn slice_bundle(&self, effects: Vec<GameEffect>) -> SliceBundle {
        slice_bundle(&self.state, effects, self.seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::{Density, preset};

    #[test]
    fn dense_board_summary_reconciles_lane_counts_and_running_slots() {
        let dense = preset(Density::Dense);
        let board = dense.board.board_summary.as_ref().expect("board_summary");
        let working_issues = dense.board.issues.iter().filter(|i| i.status == IssueStatus::InProgress).count() as i64;
        assert_eq!(board.lane_counts.working, working_issues);
        assert_eq!(board.running_slots, 6);
        assert_eq!(board.max_running, MAX_RUNNING as i64);
    }

    #[test]
    fn empty_state_produces_zeroed_summaries() {
        let bundle = Core::default().slice_bundle(vec![]);
        let board = bundle.board.board_summary.as_ref().expect("board_summary");
        assert_eq!(board.lane_counts, BoardLaneCounts::default());
        assert_eq!(board.running_slots, 0);
        assert_eq!(board.max_running, MAX_RUNNING as i64);
        assert!(board.by_issue.is_empty());

        let media = bundle.ops.media_summary.as_ref().expect("media_summary");
        assert_eq!(media.active_count, 0);
        assert!(media.active_ids.is_empty());

        let channel = bundle.collab.channel_summary.as_ref().expect("channel_summary");
        assert_eq!(channel.unread_total, 0);
        assert!(channel.unread_under.is_empty());
    }

    #[test]
    fn slice_mask_flags_and_kinds_round_trip() {
        assert!(SliceMask::NONE.is_empty());
        assert!(!SliceMask::ALL.is_empty());
        let mut mask = SliceMask::NONE;
        for kind in SliceKind::ALL {
            let bit = SliceMask::from_kind(kind);
            assert!(!bit.is_empty());
            assert!(SliceMask::ALL.contains(bit));
            mask |= bit;
        }
        assert_eq!(mask, SliceMask::ALL);
        assert_eq!(mask.kinds().collect::<Vec<_>>(), SliceKind::ALL);
        assert_eq!(SliceMask::BOARD | SliceMask::INBOX, SliceMask::INBOX | SliceMask::BOARD);
        assert!((SliceMask::BOARD | SliceMask::INBOX).contains(SliceMask::BOARD));
        assert!(!(SliceMask::BOARD | SliceMask::INBOX).contains(SliceMask::OPS));
    }

    #[test]
    fn reduce_reports_exact_dirty_slices_for_each_fact() {
        let mut core = Core::default();

        // CallChanged -> INBOX
        let a = core.apply(vec![Fact::CallChanged(FactCallChanged {
            at: 1,
            state: CallState::Live,
            reason: "on".into(),
        })]);
        assert_eq!(a.dirty, SliceMask::INBOX);
        // No-op CallChanged -> NONE
        assert_eq!(
            core.apply(vec![Fact::CallChanged(FactCallChanged {
                at: 2,
                state: CallState::Live,
                reason: "on".into(),
            })])
            .dirty,
            SliceMask::NONE
        );

        // ChannelChanged & MessageChanged -> COLLAB
        let ch = Channel {
            id: "general".into(),
            r#type: ChannelType::Channel,
            default: true,
            peer: None,
            orchestrator: None,
            members: None,
            parent: None,
            category: String::new(),
            position: None,
            archived: None,
            notify: Notify::All,
            root: None,
            root_number: None,
            name: Some("general".into()),
            description: String::new(),
            repo: None,
            subject_kind: None,
            subject_id: None,
            last_number: None,
            replies: 0,
            read: None,
            unread: None,
            title: "general".into(),
            last: None,
            at: 1,
        };
        assert_eq!(
            core.apply(vec![Fact::ChannelChanged(FactChannelChanged { at: 1, channel: ch })]).dirty,
            SliceMask::COLLAB
        );

        // UserMentionsChanged -> COLLAB | INBOX
        let mention_msg = ChatMessage {
            id: "m1".into(),
            number: 1,
            channel: "general".into(),
            from: "w1".into(),
            actor: Actor::Agent {
                id: "lab".into(),
                role: AgentRole::Worker,
                name: Some("Lab".into()),
                for_user: None,
            },
            name: "Lab".into(),
            agent: Some("lab".into()),
            kind: MessageKind::Chat,
            text: "@user ping".into(),
            mentions: vec!["user".into()],
            session: Some("w1".into()),
            run: None,
            outcome: None,
            spent: None,
            spoken: false,
            send_key: None,
            at: 2,
            revision: 1,
            reply_to: None,
            edited: None,
            deleted: None,
            pinned: None,
            reactions: vec![],
            attachments: vec![],
            embeds: vec![],
            artifact: None,
            blocks: None,
            view_context: None,
        };
        assert_eq!(
            core.apply(vec![Fact::MessageChanged(FactMessageChanged {
                at: 2,
                message: mention_msg.clone(),
                thread: None,
                answers: None,
            })])
            .dirty,
            SliceMask::COLLAB
        );
        assert_eq!(
            core.apply(vec![Fact::UserMentionsChanged(FactUserMentionsChanged {
                at: 2,
                mentions: vec![UserMention {
                    message: mention_msg,
                    channel: "general".into(),
                    address: "#general".into(),
                }],
            })])
            .dirty,
            SliceMask::COLLAB | SliceMask::INBOX
        );

        // ConnectorChanged -> COLLAB
        assert_eq!(
            core.apply(vec![Fact::ConnectorChanged(FactConnectorChanged {
                at: 3,
                status: ConnectorStatus {
                    id: ConnectorID::Weixin,
                    state: ConnectorState::Connected,
                    qr: String::new(),
                    pair_code: String::new(),
                    channel: Some("general".into()),
                    user: Some("u".into()),
                    since: Some(3),
                    last_inbound: None,
                    paused_until: None,
                    pending: 0,
                    error: String::new(),
                },
            })])
            .dirty,
            SliceMask::COLLAB
        );

        // MachineChanged -> SESSIONS
        assert_eq!(
            core.apply(vec![Fact::MachineChanged(FactMachineChanged {
                at: 3,
                machine: Machine {
                    id: "local".into(),
                    name: "Mac".into(),
                    here: true,
                    online: true,
                    joined_at: 3,
                },
            })])
            .dirty,
            SliceMask::SESSIONS
        );

        // IssueChanged (no conflict change) -> BOARD | INBOX | FARM
        let issue = Issue::new("i1", 1, "Task", 4);
        assert_eq!(
            core.apply(vec![Fact::issue_changed(4, issue)]).dirty,
            SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM
        );

        // SessionChanged -> BOARD | SESSIONS | INBOX | FARM
        let mut s = Session::new(
            "w1",
            SessionController::IssueBoard,
            "Helper",
            "claude",
            ExecutionPolicy::ManagedWorktree {
                repo: "demo".into(),
                branch: None,
            },
            5,
        );
        s.phase = Phase::working(5, SessionAction::Thinking, "");
        assert_eq!(
            core.apply(vec![Fact::session_changed(5, s)]).dirty,
            SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM
        );

        // SessionPhaseChanged (only doing changed) -> SESSIONS | INBOX | FARM (no BOARD)
        assert_eq!(
            core.apply(vec![Fact::session_phase_changed(
                6,
                "w1",
                Phase::working(5, SessionAction::ReadFile, "lib.rs"),
                None,
            )])
            .dirty,
            SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM
        );

        // SessionPhaseChanged (phase kind changed) -> BOARD | SESSIONS | INBOX | FARM
        assert_eq!(
            core.apply(vec![Fact::session_phase_changed(7, "w1", Phase::done(), None)]).dirty,
            SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM
        );

        // SessionToolChanged / SessionToolsReset / SessionSubagentsChanged -> SESSIONS
        assert_eq!(
            core.apply(vec![Fact::SessionToolChanged(FactSessionToolChanged {
                at: 8,
                id: "w1".into(),
                connection: ToolConnection {
                    server: "mcp".into(),
                    status: ToolConnectionStatus::Ready,
                    reason: None,
                },
            })])
            .dirty,
            SliceMask::SESSIONS
        );
        assert_eq!(
            core.apply(vec![Fact::SessionToolsReset(FactSessionToolsReset { at: 9, id: "w1".into() })])
                .dirty,
            SliceMask::SESSIONS
        );
        assert_eq!(
            core.apply(vec![Fact::SessionSubagentsChanged(FactSessionSubagentsChanged {
                at: 10,
                id: "w1".into(),
                subagents: Some(SessionSubagents {
                    run: "r1".into(),
                    root_thread_id: "root".into(),
                    disconnected_at: None,
                    threads: vec![],
                    waits: vec![],
                }),
            })])
            .dirty,
            SliceMask::SESSIONS
        );

        // CronChanged (non-pending) / MediaChanged -> OPS
        let c = Cron {
            id: "c1".into(),
            name: "Daily".into(),
            text: "check".into(),
            channel: "general".into(),
            agent: None,
            repo: None,
            when: CronWhen::Daily(CronWhenDaily { time: "09:00".into() }),
            tz: "Asia/Shanghai".into(),
            enabled: true,
            created: 11,
            last_run: None,
            by: ActorKind::User,
            pending: false,
        };
        assert_eq!(core.apply(vec![Fact::CronChanged(FactCronChanged { at: 11, cron: c })]).dirty, SliceMask::OPS);
        assert_eq!(
            core.apply(vec![Fact::CronRemoved(FactCronRemoved { at: 12, id: "c1".into() })]).dirty,
            SliceMask::OPS
        );
        assert_eq!(
            core.apply(vec![Fact::MediaChanged(FactMediaChanged { at: 13, jobs: vec![] })]).dirty,
            SliceMask::OPS
        );

        // ProgressChanged without commits -> FARM only; with commits -> FARM | BOARD
        assert_eq!(
            core.apply(vec![Fact::ProgressChanged(FactProgressChanged {
                at: 14,
                progress: Some(Progress {
                    coins: 10,
                    ..Progress::default()
                }),
                news: None,
                commits: None,
                station: None,
            })])
            .dirty,
            SliceMask::FARM
        );
        assert_eq!(
            core.apply(vec![Fact::ProgressChanged(FactProgressChanged {
                at: 15,
                progress: None,
                news: None,
                commits: Some(CommitCount { total: 5, repos: vec![] }),
                station: None,
            })])
            .dirty,
            SliceMask::FARM | SliceMask::BOARD
        );

        // SessionLeft -> BOARD | SESSIONS | INBOX | FARM
        assert_eq!(
            core.apply(vec![Fact::session_left(16, "w1", Some(SessionClose::Completed))]).dirty,
            SliceMask::BOARD | SliceMask::SESSIONS | SliceMask::INBOX | SliceMask::FARM
        );

        // IssueRemoved -> BOARD | INBOX | FARM
        assert_eq!(
            core.apply(vec![Fact::issue_removed(17, "i1")]).dirty,
            SliceMask::BOARD | SliceMask::INBOX | SliceMask::FARM
        );
    }

    #[test]
    fn inbox_slice_merges_and_sorts_extra_runtime_items() {
        let mut core = Core::default();
        let mut s = Session::new("w1", SessionController::IssueBoard, "Lab", "claude", ExecutionPolicy::SandboxDir, 100);
        s.phase = Phase::done();
        s.last_run = Some(LastRun {
            needs_reconciliation: false,
            outcome: Outcome::Completed,
            summary: "Done".into(),
            at: 200,
            spent: None,
            answer: None,
        });
        core.apply(vec![Fact::session_changed(200, s)]);

        let runtime_item = InboxItem {
            id: "durable:budget_reached:t1:300:0".into(),
            kind: InboxKind::BudgetReached,
            from: InboxFrom::Runtime(InboxFromRuntime {}),
            who: "Runtime".into(),
            text: "Budget limit reached".into(),
            at: 300,
            target: InboxTarget::Runtime(InboxTargetRuntime {
                task_id: "t1".into(),
                session_id: Some("w1".into()),
            }),
            words: InboxWords {
                label: "Budget".into(),
                title: "Budget reached".into(),
                body: "Budget limit reached".into(),
                tray: "Budget limit reached".into(),
            },
        };
        let slice = core.inbox_slice(std::slice::from_ref(&runtime_item));
        assert_eq!(slice.seq, core.seq());
        assert_eq!(slice.items.len(), 2);
        assert_eq!(slice.items[0], runtime_item);
        assert_eq!(slice.items[1].kind, InboxKind::Review);
    }
}
