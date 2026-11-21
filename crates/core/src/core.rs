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
use crate::status::{board_summary, is_on_duty, session_of, with_issue, with_issue_statuses};

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

/// `reduce`: folds one fact in. False when it changes nothing (and is not
/// sent); facts about sessions not on the farm change nothing.
pub fn reduce(state: &mut SpaceState, fact: &Fact) -> bool {
    let before_phase = match fact {
        Fact::SessionPhaseChanged(f) => session_of(state, &f.id).map(|s| s.phase.clone()),
        _ => None,
    };
    let (changed, touched_board) = fold(state, fact);
    if !changed {
        return false;
    }
    if let (Fact::SessionPhaseChanged(f), Some(before)) = (fact, &before_phase)
        && !phase_affects_issue(before, &f.phase)
    {
        return true;
    }
    if touched_board {
        with_issue_statuses(state);
    }
    true
}

/// (changed, whether issues or sessions changed).
fn fold(state: &mut SpaceState, f: &Fact) -> (bool, bool) {
    let changed_only = |c: bool| (c, false);
    let board = |c: bool| (c, c);
    match f {
        Fact::MediaChanged(f) => {
            if state.media.as_ref() == Some(&f.jobs) {
                return (false, false);
            }
            state.media = Some(f.jobs.clone());
            (true, false)
        }
        Fact::CallChanged(f) => {
            if state.call == f.state && state.call_reason == f.reason {
                return (false, false);
            }
            state.call = f.state;
            state.call_reason = f.reason.clone();
            (true, false)
        }
        Fact::SessionToolsReset(f) => board(with_session(state, &f.id, |h| h.tool_connections = Some(vec![]))),
        Fact::SessionToolChanged(f) => board(with_session(state, &f.id, |h| {
            let mut all: Vec<ToolConnection> = h
                .tool_connections
                .take()
                .unwrap_or_default()
                .into_iter()
                .filter(|c| c.server != f.connection.server)
                .collect();
            all.push(f.connection.clone());
            h.tool_connections = Some(all);
        })),
        Fact::SessionSubagentsChanged(f) => {
            if session_of(state, &f.id).is_none_or(|s| s.subagents == f.subagents) {
                return (false, false);
            }
            changed_only(with_session(state, &f.id, |s| s.subagents.clone_from(&f.subagents)))
        }
        Fact::SessionPhaseChanged(f) => {
            let Some(session) = session_of(state, &f.id) else { return (false, false) };
            if session.phase == f.phase
                && session.channel == f.channel
                && f.spent.as_ref().is_none_or(|s| session.spent.as_ref() == Some(s))
                && f.brief.as_ref().is_none_or(|b| *b == session.brief)
            {
                return (false, false);
            }
            let was_working = session.phase.is_working();
            with_session(state, &f.id, |h| {
                h.phase = f.phase.clone();
                h.channel = f.channel.clone();
                if let Some(b) = &f.brief {
                    h.brief = b.clone();
                }
                if let Some(s) = &f.spent {
                    h.spent = Some(s.clone());
                }
            });
            let plays = state.plays.get_or_insert_with(BTreeMap::new);
            let before = play_of(Some(plays), &f.id);
            let play = match &f.phase {
                Phase::Working(p) if was_working => played_doing(&before, f.at, p.doing.action, &p.doing.label),
                Phase::Working(_) => played_run(&before, f.at),
                _ => before,
            };
            plays.insert(f.id.clone(), play);
            (true, true)
        }
        Fact::MessageChanged(f) => changed_only(with_message(&mut state.chat, &f.message)),
        Fact::ChannelChanged(f) => {
            if state
                .chat
                .as_ref()
                .is_some_and(|c| c.channels.iter().any(|x| x.id == f.channel.id && *x == f.channel))
            {
                return (false, false);
            }
            with_channel(&mut state.chat, f.channel.clone());
            (true, false)
        }
        Fact::ChannelRemoved(f) => {
            let Some(chat) = state.chat.as_mut() else { return (false, false) };
            let before = chat.channels.len();
            chat.channels.retain(|c| c.id != f.id && c.parent.as_deref() != Some(f.id.as_str()));
            changed_only(chat.channels.len() != before)
        }
        Fact::UserMentionsChanged(f) => {
            if state.chat.as_ref().map(|c| &c.user_mentions) == Some(&f.mentions) {
                return (false, false);
            }
            with_user_mentions(&mut state.chat, f.mentions.clone());
            (true, false)
        }
        Fact::SessionChanged(f) => {
            let was = session_of(state, &f.session.id).is_some();
            state.sessions.retain(|h| h.id != f.session.id);
            if !is_on_duty(f.session.role) {
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
            (true, true)
        }
        Fact::SessionReported(f) => {
            if session_of(state, &f.id).is_none() {
                return (false, false);
            }
            let open_pr = |issue: &Option<IssueId>, issues: &[Issue]| {
                issue.as_ref().is_some_and(|i| {
                    issues
                        .iter()
                        .any(|x| x.id == *i && x.pull_request.as_ref().is_some_and(|p| p.state == PullRequestState::Open))
                })
            };
            let issues = state.issues.clone();
            with_session(state, &f.id, |x| {
                x.runs = f.runs;
                x.phase = if f.outcome == Outcome::Completed && f.phase.is_some() && open_pr(&x.issue, &issues) {
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
            (true, true)
        }
        Fact::SessionLeft(f) => {
            if let Some(plays) = state.plays.as_mut() {
                plays.remove(&f.id);
            }
            state.sessions.retain(|h| h.id != f.id);
            (true, true)
        }
        Fact::ProgressChanged(f) => {
            let mut changed = false;
            if let Some(c) = &f.commits
                && state.commits.as_ref() != Some(c)
            {
                state.commits = Some(c.clone());
                changed = true;
            }
            if let Some(p) = &f.progress
                && state.progress.as_ref() != Some(p)
            {
                state.progress = Some(p.clone());
                changed = true;
            }
            if let Some(s) = &f.station
                && stationed(state, &s.id, s.station)
            {
                changed = true;
            }
            (changed, false)
        }
        Fact::CronChanged(f) => {
            match state.crons.iter_mut().find(|x| x.id == f.cron.id) {
                Some(x) if *x == f.cron => return (false, false),
                Some(x) => *x = f.cron.clone(),
                None => state.crons.push(f.cron.clone()),
            }
            (true, false)
        }
        Fact::CronRemoved(f) => {
            let before = state.crons.len();
            state.crons.retain(|x| x.id != f.id);
            changed_only(state.crons.len() != before)
        }
        Fact::IssueChanged(f) => {
            if state.issues.iter().any(|x| x.id == f.issue.id && *x == f.issue) {
                return (false, false);
            }
            with_issue(&mut state.issues, f.issue.clone());
            (true, true)
        }
        Fact::IssueRemoved(f) => {
            let before = state.issues.len();
            state.issues.retain(|x| x.id != f.id);
            board(state.issues.len() != before)
        }
        Fact::ConnectorChanged(f) => {
            match state.connectors.iter_mut().find(|x| x.id == f.status.id) {
                Some(x) if *x == f.status => return (false, false),
                Some(x) => *x = f.status.clone(),
                None => state.connectors.push(f.status.clone()),
            }
            (true, false)
        }
        Fact::MachineChanged(f) => {
            match state.machines.iter_mut().find(|x| x.id == f.machine.id) {
                Some(x) if *x == f.machine => return (false, false),
                Some(x) => *x = f.machine.clone(),
                None => state.machines.push(f.machine.clone()),
            }
            (true, false)
        }
    }
}

/// `frameOf`: the state in the user's words, the inbox, the farm and the
/// effects since the last frame.
pub fn frame_of(state: &SpaceState, effects: Vec<GameEffect>, seq: i64) -> StateFrame {
    StateFrame {
        seq,
        state: with_words(state),
        inbox: inbox(state),
        view: view_of(state),
        effects,
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
        role: h.role,
        name: h.name.clone(),
        agent: h.agent.clone(),
        runtime: h.runtime.clone(),
        brief: h.brief.clone(),
        repo: h.repo.clone(),
        branch: h.branch.clone(),
        worktree: h.worktree.clone(),
        hired_at: h.hired_at,
        runs: h.runs,
        phase,
        last_run: h.last_run.clone(),
        spent: h.spent.clone(),
        channel: h.channel.clone(),
        issue: h.issue.clone(),
        refining: h.refining,
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

fn with_words(state: &SpaceState) -> SpaceView {
    let conflicts: std::collections::HashMap<&str, Option<&Conflict>> = state.issues.iter().map(|i| (i.id.as_str(), i.conflict.as_ref())).collect();
    SpaceView {
        call: state.call,
        call_reason: state.call_reason.clone(),
        media: state.media.clone(),
        chat: state.chat.clone(),
        commits: state.commits.clone(),
        progress: state.progress.clone(),
        issues: state.issues.clone(),
        connectors: state.connectors.clone(),
        machines: state.machines.clone(),
        sessions: state
            .sessions
            .iter()
            .map(|h| session_view(h, h.issue.as_deref().and_then(|i| conflicts.get(i).copied().flatten())))
            .collect(),
        crons: state.crons.iter().map(cron_view).collect(),
        board_summary: Some(board_summary(state)),
        media_summary: Some(media_summary(state)),
        channel_summary: Some(channel_summary(state)),
    }
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

/// What one `apply` did: the facts that changed the state, in order, and
/// the farm effects they set off.
#[derive(Debug, Clone, Default)]
pub struct Applied {
    pub transitions: Vec<Transition>,
    pub effects: Vec<GameEffect>,
}

impl Core {
    pub fn new(state: SpaceState) -> Core {
        Core { state, seq: 0 }
    }

    pub fn state(&self) -> &SpaceState {
        &self.state
    }

    /// How many commits have changed the state (`StateFrame.seq`).
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
            if !reduce(&mut next, &fact) {
                continue;
            }
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

    pub fn frame(&self, effects: Vec<GameEffect>) -> StateFrame {
        frame_of(&self.state, effects, self.seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::{Density, preset};

    #[test]
    fn dense_board_summary_reconciles_lane_counts_and_running_slots() {
        let dense = preset(Density::Dense);
        let board = dense.state.board_summary.as_ref().expect("board_summary");
        let working_issues = dense.state.issues.iter().filter(|i| i.status == IssueStatus::InProgress).count() as i64;
        assert_eq!(board.lane_counts.working, working_issues);
        assert_eq!(board.running_slots, 6);
        assert_eq!(board.max_running, MAX_RUNNING as i64);
    }

    #[test]
    fn empty_state_produces_zeroed_summaries() {
        let frame = Core::default().frame(vec![]);
        let board = frame.state.board_summary.as_ref().expect("board_summary");
        assert_eq!(board.lane_counts, BoardLaneCounts::default());
        assert_eq!(board.running_slots, 0);
        assert_eq!(board.max_running, MAX_RUNNING as i64);
        assert!(board.by_issue.is_empty());

        let media = frame.state.media_summary.as_ref().expect("media_summary");
        assert_eq!(media.active_count, 0);
        assert!(media.active_ids.is_empty());

        let channel = frame.state.channel_summary.as_ref().expect("channel_summary");
        assert_eq!(channel.unread_total, 0);
        assert!(channel.unread_under.is_empty());
    }
}
