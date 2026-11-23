//! An issue's board status, stage and moves, derived from what its sessions
//! did. Only the user's intent is stored (backlog, todo, done, canceled);
//! in_progress and in_review are worked out here.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use vibevalley_protocol::*;

use crate::moves::status_moves;
use crate::rules::{compare_text, is_busy};

/// On duty: an orchestrator's standing session.
fn is_on_duty(session: &Session) -> bool {
    session.is_orchestrator()
}

/// Hired: a session bound to work an issue on the board.
pub fn is_hired(session: &Session) -> bool {
    session.is_board_worker()
}

/// Managed farm helper: board workers and channel talkers, never free user chats or orchestrators.
pub fn is_farm_worker(session: &Session) -> bool {
    session.is_board_worker() || session.is_direct_talker()
}

pub(crate) fn session_of<'a>(state: &'a SpaceState, id: &str) -> Option<&'a Session> {
    state.sessions.iter().find(|h| h.id == id)
}

/// `sessionOnIssue`: the latest hired of those on the issue.
pub(crate) fn session_on_issue<'a>(state: &'a SpaceState, issue: &str) -> Option<&'a Session> {
    let mut on: Option<&Session> = None;
    for h in &state.sessions {
        if h.issue_id() == Some(issue) && on.is_none_or(|o| h.hired_at >= o.hired_at) {
            on = Some(h);
        }
    }
    on
}

fn awaits_feedback(issue: &Issue, session: Option<&Session>) -> bool {
    session.is_some_and(|s| {
        matches!(s.phase, Phase::Resting(_)) && s.last_run.as_ref().is_some_and(|r| r.outcome == Outcome::Completed) && issue.questions.is_empty()
    })
}

fn mv(act: IssueAct, status: IssueStatus, words: ActWords) -> IssueAction {
    IssueAction::Move { act, status, words }
}

fn say(act: IssueAct) -> IssueAction {
    IssueAction::Say { act }
}

fn stop() -> IssueAction {
    IssueAction::Stop { act: IssueAct::Stop }
}

fn close() -> IssueAction {
    mv(IssueAct::Close, IssueStatus::Canceled, ActWords::None)
}

fn stage(state: IssueStageKind, since: Option<i64>, lead: Option<IssueAct>, acts: Vec<IssueAction>) -> IssueStage {
    IssueStage {
        state,
        since,
        stuck: None,
        lead,
        acts,
    }
}

fn stuck(reason: StuckReason, since: Option<i64>, lead: IssueAct, acts: Vec<IssueAction>) -> IssueStage {
    IssueStage {
        state: IssueStageKind::Stuck,
        since,
        stuck: Some(reason),
        lead: Some(lead),
        acts,
    }
}

/// `issueStageOf`: `session` is the issue's newest one, `None` while none
/// is on the farm.
fn issue_stage_of(t: &Issue, session: Option<&Session>) -> IssueStage {
    use IssueAct as A;
    use IssueStageKind as K;
    let last = session.and_then(|s| s.last_run.as_ref());
    let finish = mv(
        if t.deliver == Deliverable::Answer { A::Acknowledge } else { A::Complete },
        IssueStatus::Done,
        ActWords::None,
    );
    let finish_act = if t.deliver == Deliverable::Answer { A::Acknowledge } else { A::Complete };
    let reopen = if t.was_sent() {
        mv(A::Reopen, IssueStatus::Todo, ActWords::Required)
    } else {
        mv(A::Reopen, IssueStatus::Backlog, ActWords::None)
    };
    match t.status {
        IssueStatus::Done => {
            let acts = if t.delivered == Some(Landing::MergedIntoParent) {
                vec![]
            } else {
                vec![reopen]
            };
            stage(K::Done, t.closed_at, None, acts)
        }
        IssueStatus::Canceled => stage(K::Canceled, t.closed_at, Some(A::Reopen), vec![reopen]),
        IssueStatus::Backlog => {
            if t.refining.is_some() {
                stage(K::Draft, Some(t.created_at), None, vec![])
            } else {
                stage(
                    K::Draft,
                    Some(t.created_at),
                    Some(A::Start),
                    vec![mv(A::Start, IssueStatus::Todo, ActWords::None), close()],
                )
            }
        }
        IssueStatus::Todo => stage(K::Queued, Some(t.queued_at.unwrap_or(t.created_at)), None, vec![close()]),
        IssueStatus::InProgress => {
            if awaits_feedback(t, session) {
                return stage(K::Working, last.map(|l| l.at), Some(A::Tell), vec![say(A::Tell), close()]);
            }
            if let Some(Phase::Working(p)) = session.map(|s| &s.phase) {
                if let Some(q) = p.quiet_since {
                    return stuck(StuckReason::Quiet, Some(q), A::Stop, vec![stop(), say(A::Tell), close()]);
                }
                return stage(K::Working, Some(p.since), None, vec![say(A::Tell), stop(), close()]);
            }
            if session.and_then(|s| s.last_run.as_ref()).is_none() && t.last_run.as_ref().is_none_or(|r| r.ended_at.is_none()) {
                let since = t.last_run.as_ref().map_or(t.created_at, |r| r.started_at);
                return stage(K::Working, Some(since), None, vec![close()]);
            }
            let mut in_review = t.clone();
            in_review.status = IssueStatus::InReview;
            issue_stage_of(&in_review, session)
        }
        IssueStatus::InReview => {
            if session.is_none()
                && let Some(lr) = &t.last_run
            {
                let ended = lr.outcome.unwrap_or(Outcome::Completed);
                let done = lr.ended_at;
                return match ended {
                    Outcome::Failed => stuck(StuckReason::Failed, done, A::Close, vec![close()]),
                    Outcome::Interrupted => stuck(StuckReason::Interrupted, done, finish_act, vec![finish, close()]),
                    Outcome::Completed => stage(K::Reviewing, done, Some(finish_act), vec![finish, close()]),
                };
            }
            let since = last.map(|l| l.at);
            if t.conflict.is_some() && t.deliver == Deliverable::Change {
                return stuck(
                    StuckReason::Conflict,
                    since,
                    A::Resolve,
                    vec![mv(A::Resolve, IssueStatus::Todo, ActWords::None), say(A::Tell), close()],
                );
            }
            if !t.questions.is_empty() {
                return stage(K::Asking, since, Some(A::Answer), vec![say(A::Answer), close()]);
            }
            let unread = t.deliver == Deliverable::Answer && last.is_some_and(|l| l.outcome == Outcome::Completed && l.answer.is_none());
            if last.is_some_and(|l| l.outcome == Outcome::Failed) || unread {
                return stuck(
                    StuckReason::Failed,
                    since,
                    A::Cure,
                    vec![mv(A::Cure, IssueStatus::Todo, ActWords::None), say(A::Tell), close()],
                );
            }
            if last.is_some_and(|l| l.outcome == Outcome::Interrupted) {
                return stuck(
                    StuckReason::Interrupted,
                    since,
                    A::Resume,
                    vec![mv(A::Resume, IssueStatus::Todo, ActWords::None), finish, say(A::Tell), close()],
                );
            }
            let mut acts = vec![finish];
            if t.reviewed_at.is_none() {
                acts.push(mv(A::Reject, IssueStatus::Todo, ActWords::Required));
            }
            acts.push(say(A::Tell));
            acts.push(close());
            stage(K::Reviewing, since, Some(finish_act), acts)
        }
    }
}

struct Lookup<'a> {
    sessions: HashMap<&'a str, &'a Session>,
    refining: HashMap<&'a str, IssueRefining>,
    children: HashMap<&'a str, Vec<&'a Issue>>,
}

fn lookup_of(state: &SpaceState) -> Lookup<'_> {
    let mut sessions = HashMap::new();
    let mut refining = HashMap::new();
    for h in &state.sessions {
        sessions.insert(h.id.as_str(), h);
        if h.is_refining()
            && let Some(issue) = h.issue_id()
        {
            refining.entry(issue).or_insert_with(|| IssueRefining {
                session: h.id.clone(),
                name: h.name.clone(),
            });
        }
    }
    let mut children: HashMap<&str, Vec<&Issue>> = HashMap::new();
    for item in &state.issues {
        if let Some(parent) = &item.parent {
            children.entry(parent.as_str()).or_default().push(item);
        }
    }
    Lookup { sessions, refining, children }
}

fn status_with_lookup(t: &Issue, lookup: &Lookup) -> IssueStatus {
    use IssueStatus::*;
    if t.delivered.is_some() || t.canceled.is_some() || t.closed_at.is_some() {
        return if t.delivered.is_some() { Done } else { Canceled };
    }
    let latest = t.latest_session_id();
    if let Some(active) = latest
        && lookup.sessions.get(active.as_str()).is_some_and(|h| h.phase.is_working())
    {
        return InProgress;
    }
    if let Some(children) = lookup.children.get(t.id.as_str())
        && !children.is_empty()
    {
        let statuses: Vec<IssueStatus> = children.iter().map(|c| status_with_lookup(c, lookup)).collect();
        if statuses.iter().all(|s| s.is_closed()) {
            return InReview;
        }
        if statuses.iter().any(|s| *s != Backlog) {
            return InProgress;
        }
    }
    if let Some(latest) = latest {
        let Some(h) = lookup.sessions.get(latest.as_str()) else { return Todo };
        let unfinished = !t.questions.is_empty()
            || h.last_run.as_ref().is_none_or(|r| r.outcome != Outcome::Completed)
            || (t.deliver == Deliverable::Answer && h.last_run.as_ref().is_none_or(|r| r.answer.is_none()));
        return if is_busy(h) || awaits_feedback(t, Some(h)) || unfinished {
            InProgress
        } else {
            InReview
        };
    }
    if t.queued_at.is_some() {
        return Todo;
    }
    if let Some(lr) = &t.last_run {
        return if lr.ended_at.is_none() || lr.outcome != Some(Outcome::Completed) || !t.questions.is_empty() {
            InProgress
        } else {
            InReview
        };
    }
    Backlog
}

/// `withIssueStatuses`: every issue's status, drafting session, stage and
/// moves brought up to date. False when none changed.
pub(crate) fn with_issue_statuses(state: &mut SpaceState) -> bool {
    if state.issues.is_empty() {
        return false;
    }
    let lookup = lookup_of(state);
    let mut changes: Vec<(usize, Issue)> = Vec::new();
    for (i, t) in state.issues.iter().enumerate() {
        let status = status_with_lookup(t, &lookup);
        let drafting = lookup.refining.get(t.id.as_str()).cloned();
        let session = t.latest_session_id().and_then(|id| lookup.sessions.get(id.as_str()).copied());
        let mut next = t.clone();
        next.status = status;
        next.refining = drafting;
        next.stage = issue_stage_of(&next, session);
        next.moves = status_moves(&next);
        if next.status == t.status && next.refining == t.refining && next.stage == t.stage && next.moves == t.moves {
            continue;
        }
        changes.push((i, next));
    }
    let changed = !changes.is_empty();
    for (i, next) in changes {
        state.issues[i] = next;
    }
    changed
}

const KEEP_CLOSED_ISSUES: usize = 50;

/// `issueOrder`: the never-sent by rank, then the sent newest first.
pub fn issue_order(a: &Issue, b: &Issue) -> Ordering {
    let sent_a = a.executions().next().is_some();
    let sent_b = b.executions().next().is_some();
    match (sent_a, sent_b) {
        (false, false) => a
            .rank
            .unwrap_or(0)
            .cmp(&b.rank.unwrap_or(0))
            .then(a.created_at.cmp(&b.created_at))
            .then_with(|| compare_text(&a.id, &b.id)),
        (false, true) => Ordering::Less,
        (true, false) => Ordering::Greater,
        (true, true) => b.created_at.cmp(&a.created_at).then_with(|| compare_text(&a.id, &b.id)),
    }
}

/// `withIssue`: keeps the latest `KEEP_CLOSED_ISSUES` closed top-level
/// issues; a sub-issue goes with its parent.
pub(crate) fn with_issue(all: &mut Vec<Issue>, t: Issue) {
    all.retain(|x| x.id != t.id);
    all.push(t);
    let mut closed: Vec<(String, i64)> = all
        .iter()
        .filter(|x| x.parent.is_none())
        .filter_map(|x| x.closed_at.map(|at| (x.id.clone(), at)))
        .collect();
    if closed.len() > KEEP_CLOSED_ISSUES {
        closed.sort_by_key(|c| std::cmp::Reverse(c.1));
        let drop: std::collections::HashSet<String> = closed[KEEP_CLOSED_ISSUES..].iter().map(|x| x.0.clone()).collect();
        all.retain(|x| !drop.contains(&x.id) && !x.parent.as_ref().is_some_and(|p| drop.contains(p)));
    }
    all.sort_by(issue_order);
}

/// `pickIssues`: what a filter picks, newest first; waiting on the user,
/// the longest waiting first.
pub fn pick_issues(all: &[Issue], f: &IssueFilter, now: i64) -> Vec<Issue> {
    let words: Vec<&str> = f.text.as_deref().unwrap_or("").split_whitespace().collect();
    let repo = f.repo.as_deref().unwrap_or("").trim();
    let mut found: Vec<Issue> = all
        .iter()
        .filter(|item| {
            (match f.status {
                Some(s) => item.status == s,
                None => f.closed == Some(true) || !item.status.is_closed(),
            }) && (f.wants_user != Some(true) || item.stage.state.wants_user())
                && (repo.is_empty() || item.repo.as_deref() == Some(repo))
                && words.iter().all(|w| format!("{}\n{}", item.title, item.description).contains(w))
        })
        .cloned()
        .collect();
    if f.wants_user == Some(true) {
        found.sort_by_key(|x| x.stage.since.unwrap_or(now));
    }
    match f.limit {
        Some(n) if n > 0 => {
            found.truncate(n as usize);
            found
        }
        _ => found,
    }
}

/// `openFindings`: a failed acceptance's findings not yet resolved.
pub(crate) fn open_findings(t: &Issue) -> usize {
    t.findings.iter().filter(|f| !f.resolved).count()
}

/// `assignedOnDuty`.
fn assigned_on_duty(t: &Issue, on_duty: impl Fn(&str) -> bool) -> bool {
    on_duty(t.assigned_agent().unwrap_or(""))
}

/// Maps an issue's board status onto one of the four UI lanes.
fn issue_lane_of(status: IssueStatus) -> IssueLane {
    match status {
        IssueStatus::Backlog | IssueStatus::Todo => IssueLane::Todo,
        IssueStatus::InProgress => IssueLane::Working,
        IssueStatus::InReview => IssueLane::Waiting,
        IssueStatus::Done | IssueStatus::Canceled => IssueLane::Closed,
    }
}

/// Structured, locale-free user prompt kind for an issue's current stage.
fn issue_prompt_of(issue: &Issue) -> Option<IssuePromptKind> {
    match issue.stage.state {
        IssueStageKind::Asking => Some(IssuePromptKind::Asking),
        IssueStageKind::Reviewing => {
            if issue
                .delivery_evidence
                .as_ref()
                .and_then(|e| e.check.as_ref())
                .is_some_and(|c| c.status == ProjectCheckStatus::Failed)
            {
                Some(IssuePromptKind::ReviewAfterFailedCheck)
            } else if issue.reviewed_at.is_some() {
                Some(IssuePromptKind::Reviewed)
            } else {
                Some(IssuePromptKind::HandedBack)
            }
        }
        IssueStageKind::Stuck => Some(match issue.stage.stuck {
            Some(StuckReason::Conflict) => IssuePromptKind::StuckConflict,
            Some(StuckReason::Failed) => IssuePromptKind::StuckFailed,
            Some(StuckReason::Interrupted) => IssuePromptKind::StuckInterrupted,
            Some(StuckReason::Quiet) => IssuePromptKind::StuckQuiet,
            None => IssuePromptKind::StuckUnknown,
        }),
        IssueStageKind::Canceled => (issue.stage.lead == Some(IssueAct::Reopen)).then_some(IssuePromptKind::CanceledReopenable),
        IssueStageKind::Draft | IssueStageKind::Queued | IssueStageKind::Working | IssueStageKind::Done => None,
    }
}

/// Deterministic board summary folded into `BoardSlice`: identical lane counts
/// for wide and narrow views, active worker slot usage, and per-issue metadata.
pub(crate) fn board_summary(state: &SpaceState) -> BoardSummary {
    let lookup = lookup_of(state);
    let mut on_duty_agents: HashSet<&str> = HashSet::from([DEFAULT_ORCHESTRATOR]);
    for s in &state.sessions {
        if is_on_duty(s)
            && let Some(agent) = s.profile_id()
            && !agent.is_empty()
        {
            on_duty_agents.insert(agent);
        }
    }
    if let Some(chat) = &state.chat {
        for c in &chat.channels {
            if let Some(orch) = c.orchestrator.as_deref()
                && !orch.is_empty()
            {
                on_duty_agents.insert(orch);
            }
        }
    }

    let mut lane_counts = BoardLaneCounts::default();
    let mut by_issue = BTreeMap::new();
    for issue in &state.issues {
        let lane = issue_lane_of(issue.status);
        match lane {
            IssueLane::Todo => lane_counts.todo += 1,
            IssueLane::Working => lane_counts.working += 1,
            IssueLane::Waiting => lane_counts.waiting += 1,
            IssueLane::Closed => lane_counts.closed += 1,
        }

        let kids = lookup.children.get(issue.id.as_str()).map_or(&[][..], Vec::as_slice);
        let family_total = kids.len() as i64;
        let family_done = kids.iter().filter(|c| c.status.is_closed()).count() as i64;

        let is_orch = assigned_on_duty(issue, |a| on_duty_agents.contains(a))
            || (issue.latest_session_id().is_none() && issue.executions().any(|e| matches!(e, Execution::Orchestrator { .. })));
        let card_kind = if family_total > 0 {
            IssueCardKind::Family
        } else if is_orch {
            IssueCardKind::Orchestrator
        } else if issue.executions().next().is_none() {
            IssueCardKind::Todo
        } else {
            IssueCardKind::Issue
        };

        let session = issue.latest_session_id().and_then(|id| lookup.sessions.get(id.as_str()).copied());
        let needs_worktree_check =
            !issue.status.is_closed() && session.is_some_and(|s| !s.phase.is_working() && s.last_run.as_ref().is_some_and(|r| r.needs_reconciliation));

        by_issue.insert(
            issue.id.clone(),
            BoardIssueSummary {
                lane,
                card_kind,
                family_done,
                family_total,
                needs_worktree_check,
                prompt: issue_prompt_of(issue),
            },
        );
    }

    let running_slots = state.sessions.iter().filter(|s| is_hired(s) && is_busy(s)).count() as i64;

    BoardSummary {
        lane_counts,
        running_slots,
        max_running: MAX_RUNNING as i64,
        by_issue,
    }
}
