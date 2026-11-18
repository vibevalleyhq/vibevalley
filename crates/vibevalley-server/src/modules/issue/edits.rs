//! What the user changes on an issue besides moving it: its fields
//! (`issue.update`), deleting it, and the verdict on what was handed back
//! (`issue.review`).

use vibevalley_core::brief::{failed_text, issue_words};
use vibevalley_git::Repo;
use vibevalley_i18n::t;
use vibevalley_protocol::{Assignment, Fact, Finding, Issue, IssueStatus, IssueUpdate};

use super::board::Board;
use crate::modules::ledger::{BoardError, IssueChange, Result, lock, now};
use crate::modules::workplace::Leave;

const RANK_STEP: i64 = 1024;
const RANK_BOUND: i64 = 2_000_000_000;

fn refused(key: &str, params: vibevalley_i18n::Params) -> BoardError {
    BoardError::Other(t(key, params))
}

impl Board {
    /// The title, the priority and `deliver` may change while the issue is
    /// open; the rest is what the helper was asked, so only before it is
    /// sent. An empty `agent` leaves it unassigned; `before` places it on
    /// the board before that issue ("" last).
    pub fn edit(&self, reference: &str, upd: &IssueUpdate) -> Result<Issue> {
        let _work = lock(&self.0.work);
        let was = self.stored(reference)?;
        let while_open = upd.description.is_none() && upd.repo.is_none() && upd.agent.is_none() && upd.criteria.is_none() && upd.before.is_none();
        if while_open {
            if was.status.is_closed() {
                return Err(refused("server.issue.closed", &[]));
            }
        } else if was.executions().next().is_some() {
            return Err(refused("server.issue.started", &[]));
        }
        let (title, description) = issue_words(
            upd.title.as_deref().unwrap_or(&was.title),
            upd.description.as_deref().unwrap_or(&was.description),
        )
        .ok_or_else(|| refused("server.issue.noTitle", &[]))?;
        let repo = match upd.repo.as_deref().map(str::trim) {
            None => was.repo.clone(),
            Some("") => None,
            Some(path) => {
                let dir = self.0.workplaces.repo_dir(path);
                let found = Repo::discover(&dir)?.ok_or(BoardError::NotARepo(dir))?;
                Some(self.0.workplaces.repo_ref(found.root()))
            }
        };
        if let Some(agent) = upd.agent.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            self.0.drivers.check(agent)?;
        }
        let at = now();
        let mut issue = was.clone();
        issue.title = title;
        issue.description = description;
        issue.repo = repo;
        if let Some(p) = upd.priority {
            issue.priority = p;
        }
        if let Some(c) = &upd.criteria {
            issue.criteria = vibevalley_core::refine::kept(c);
        }
        if let Some(d) = upd.deliver {
            issue.deliver = d;
        }
        if let Some(agent) = upd.agent.as_deref().map(str::trim) {
            assign(&mut issue, agent, at);
        }
        let mut facts = vec![Fact::issue_changed(at, issue)];
        if let Some(before) = &upd.before {
            facts.extend(self.placed(&was.id, before).into_iter().map(|i| Fact::issue_changed(at, i)));
        }
        // The placing reads the edit's fields from the issue it is given.
        let mut merged: Vec<Fact> = Vec::new();
        for f in facts {
            if let Fact::IssueChanged(c) = &f
                && let Some(Fact::IssueChanged(earlier)) = merged.iter_mut().find(|m| matches!(m, Fact::IssueChanged(e) if e.issue.id == c.issue.id))
            {
                earlier.issue.rank = c.issue.rank;
                continue;
            }
            merged.push(f);
        }
        self.0.ledger.apply(merged)?;
        self.stored(&was.id)
    }

    /// The unsent issues reranked so `id` stands before `before` ("" or
    /// unknown: last). Only those whose rank changes.
    fn placed(&self, id: &str, before: &str) -> Vec<Issue> {
        let mut unsent: Vec<Issue> = self.read(|s| s.issues.iter().filter(|i| i.executions().next().is_none()).cloned().collect());
        unsent.sort_by(vibevalley_core::issue_order);
        let Some(from) = unsent.iter().position(|i| i.id == id) else { return vec![] };
        let moving = unsent.remove(from);
        let at = unsent.iter().position(|i| i.id == before).unwrap_or(unsent.len());
        if at == from {
            return vec![];
        }
        let prev = at.checked_sub(1).map(|p| unsent[p].rank.unwrap_or(0));
        let next = unsent.get(at).map(|n| n.rank.unwrap_or(0));
        let single = match (prev, next) {
            (None, Some(n)) if n - RANK_STEP >= -RANK_BOUND => Some(n - RANK_STEP),
            (Some(p), None) if p + RANK_STEP <= RANK_BOUND => Some(p + RANK_STEP),
            (Some(p), Some(n)) if n - p >= 2 => Some((p + n) / 2),
            _ => None,
        };
        if let Some(rank) = single {
            return vec![Issue { rank: Some(rank), ..moving }];
        }
        unsent.insert(at, moving);
        unsent
            .into_iter()
            .enumerate()
            .filter_map(|(i, mut issue)| {
                let target = (i as i64 + 1) * RANK_STEP;
                (issue.rank.unwrap_or(0) != target).then(|| {
                    issue.rank = Some(target);
                    issue
                })
            })
            .collect()
    }

    /// Deletes an issue never sent: a draft being written goes home, its
    /// checkout is cleared.
    pub fn remove(&self, reference: &str) -> Result<()> {
        let _work = lock(&self.0.work);
        let issue = self.stored(reference)?;
        if issue.executions().next().is_some() {
            return Err(refused("server.issue.started", &[]));
        }
        if let Some(r) = &issue.refining {
            self.0.sessions.dismiss(&r.session, Leave::Discard)?;
        }
        if let Some(main) = self.0.workplaces.main_repo(issue.repo.as_deref())?
            && !self.0.workplaces.discard(&main, issue.number)?
        {
            return Err(refused(
                "server.issue.cannotDelete",
                &[("n", issue.number.into()), ("why", t("server.issue.does.cleanWorktree", &[]).into())],
            ));
        }
        let _ = self.take_words(&issue.id);
        self.0.ledger.apply(vec![Fact::issue_removed(now(), issue.id.clone())])
    }

    /// The verdict on what was handed back: a pass marks it reviewed (the
    /// user completes it by moving it to done); a fail records the findings
    /// and sends them to the session for another round.
    pub fn review(&self, reference: &str, pass: bool, findings: &[String], text: &str) -> Result<Issue> {
        let issue = self.stored(reference)?;
        if issue.status != IssueStatus::InReview {
            return Err(refused("server.issue.nothingToAccept", &[]));
        }
        if pass {
            return self.change(&issue.id, IssueChange::Reviewed);
        }
        let fresh = vibevalley_core::refine::kept(findings);
        let text = text.trim();
        if fresh.is_empty() && text.is_empty() {
            return Err(refused("server.issue.failNeedsFindings", &[]));
        }
        let at = now();
        let mut all = issue.findings.clone();
        for f in fresh {
            all.push(Finding {
                id: format!("f{}", self.0.ledger.next("finding", 0)?),
                text: f,
                at,
                resolved: false,
            });
        }
        let words = failed_text(&all, text);
        self.change(&issue.id, IssueChange::Failed { findings: all })?;
        self.tell(&issue.id, &words)?;
        self.stored(&issue.id)
    }
}

/// The issue's current assignment ends and `agent` (none when empty) takes
/// it on, unless it is the one it has.
pub(super) fn assign(issue: &mut Issue, agent: &str, at: i64) {
    let current = issue.assignments.iter().rposition(|a| a.ended_at.is_none());
    if current.is_some_and(|c| issue.assignments[c].agent == agent) || (current.is_none() && agent.is_empty()) {
        return;
    }
    if let Some(c) = current {
        issue.assignments[c].ended_at = Some(at);
    }
    if !agent.is_empty() {
        let n = issue.assignments.len() + 1;
        issue.assignments.push(Assignment {
            id: format!("{}-a{n}", issue.id),
            issue: issue.id.clone(),
            agent: agent.to_string(),
            assigned_at: at,
            ended_at: None,
            executions: vec![],
        });
    }
}

impl Board {
    pub fn hand_over_and_move(&self, reference: &str, agent: &str, words: Option<&str>, findings: &[String]) -> Result<vibevalley_core::Move> {
        let _work = lock(&self.0.work);
        let issue = self.stored(reference)?;
        let agent = agent.trim();
        self.0.drivers.check(agent)?;
        let words = words.map(str::trim).filter(|w| !w.is_empty()).map(String::from);
        if issue.delivered == Some(vibevalley_protocol::Landing::MergedIntoParent) {
            return Err(BoardError::Refused(vibevalley_core::Refusal::InGraph));
        }
        let mv = if issue.status == IssueStatus::Todo {
            vibevalley_core::Move::Start
        } else {
            vibevalley_core::status_move(&issue, IssueStatus::Todo).map_err(BoardError::Refused)?
        };
        let mut send_words = match mv {
            vibevalley_core::Move::Start => words,
            vibevalley_core::Move::Round | vibevalley_core::Move::Reopen => {
                let required = mv == vibevalley_core::Move::Reopen || issue.stage.state == vibevalley_protocol::IssueStageKind::Reviewing;
                match words {
                    Some(w) => Some(w),
                    None if required => return Err(BoardError::WordsRequired),
                    None => Some(super::board::default_words(&issue)),
                }
            }
            _ => {
                return Err(BoardError::Refused(vibevalley_core::Refusal::Cannot {
                    from: issue.status,
                    to: IssueStatus::Todo,
                }));
            }
        };
        if mv == vibevalley_core::Move::Round && issue.stage.state == vibevalley_protocol::IssueStageKind::Reviewing {
            let fresh = vibevalley_core::refine::kept(findings);
            let text = send_words.as_deref().unwrap_or("");
            if fresh.is_empty() && text.is_empty() {
                return Err(refused("server.issue.failNeedsFindings", &[]));
            }
            let at = now();
            let mut all = issue.findings.clone();
            for f in fresh {
                all.push(Finding {
                    id: format!("f{}", self.0.ledger.next("finding", 0)?),
                    text: f,
                    at,
                    resolved: false,
                });
            }
            send_words = Some(failed_text(&all, if findings.is_empty() { text } else { "" }));
            self.change(&issue.id, IssueChange::Failed { findings: all })?;
        }
        if let Some(s) = self.on_board(&issue) {
            self.0.sessions.dismiss(&s.id, Leave::KeepBranch)?;
        }
        self.change(&issue.id, IssueChange::Assigned(agent.to_string()))?;
        let kind = if mv == vibevalley_core::Move::Start {
            self.change(&issue.id, IssueChange::Queued)?;
            vibevalley_protocol::RunTriggerKind::Issue
        } else {
            self.change(&issue.id, IssueChange::Reopened)?;
            vibevalley_protocol::RunTriggerKind::Comment
        };
        self.send(&issue.id, send_words, kind)?;
        self.refresh_queue_locked();
        Ok(mv)
    }

    /// Why one more session cannot start on `issue` now (`noRoom`), or ""
    /// when there is room. Its own session does not count against it.
    pub fn no_room(&self, issue: &Issue) -> String {
        let except = issue.latest_session_id().cloned().unwrap_or_default();
        let repo = issue.repo.clone().unwrap_or_default();
        let config = &self.0.config;
        let room = self.read(|s| vibevalley_core::rules::room_left(&s.sessions, &repo, config.space_limit, config.per_repo, &except));
        if room.farm == 0 {
            return t("server.session.noRoom.farm", &[("max", config.space_limit.into())]);
        }
        if room.repo == Some(0) {
            return t(
                "server.session.noRoom.repo",
                &[("repo", repo.into()), ("on", room.in_repo.into()), ("max", config.per_repo.into())],
            );
        }
        String::new()
    }
}
