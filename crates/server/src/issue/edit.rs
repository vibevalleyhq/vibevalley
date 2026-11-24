//! What the user changes on an issue besides moving it: its fields
//! (`issue.update`), deleting it, and the verdict on what was handed back
//! (`issue.review`).

use vibevalley_core::brief::{failed_text, issue_words};
use vibevalley_git::Repo;
use vibevalley_i18n::t;
use vibevalley_protocol::{Assignment, Deliverable, Finding, Issue, IssueStatus, IssueUpdate, ReviewRevision};

use super::board::Board;
use super::store::{BoardError, IssueChange, Result};
use crate::context::now;
use crate::runtime::Leave;

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
    pub fn edit_async<'a>(
        &'a self,
        reference: &'a str,
        upd: &'a IssueUpdate,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Issue>> + Send + 'a>> {
        Box::pin(async move {
            let _work = self.work.lock().await;
            let was = self.stored_async(reference).await?;
            let while_open = upd.description.is_none()
                && upd.repo.is_none()
                && upd.agent.is_none()
                && upd.machine_id.is_none()
                && upd.criteria.is_none()
                && upd.before.is_none();
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
                    let dir = self.worktree().repo_dir(path);
                    let found = Repo::discover(&dir)?.ok_or(BoardError::NotARepo(dir))?;
                    Some(self.worktree().repo_ref(found.root()))
                }
            };
            if let Some(agent) = upd.agent.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
                self.runtime.driver().check(agent)?;
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
            if let Some(machine) = upd.machine_id.as_deref().map(str::trim) {
                issue.machine_id = (!machine.is_empty()).then(|| machine.to_string());
            }
            let mut edited = vec![issue];
            if let Some(before) = &upd.before {
                for placed in self.placed_async(&was.id, before).await? {
                    if let Some(earlier) = edited.iter_mut().find(|m| m.id == placed.id) {
                        earlier.rank = placed.rank;
                    } else {
                        edited.push(placed);
                    }
                }
            }
            self.state.put_issues_async(&edited).await?;
            self.stored_async(&was.id).await
        })
    }

    /// The unsent issues reranked so `id` stands before `before` ("" or
    /// unknown: last). Only those whose rank changes.
    async fn placed_async(&self, id: &str, before: &str) -> Result<Vec<Issue>> {
        let mut unsent: Vec<Issue> = self.issues_async().await?.into_iter().filter(|i| i.executions().next().is_none()).collect();
        unsent.sort_by(vibevalley_core::issue_order);
        let Some(from) = unsent.iter().position(|i| i.id == id) else {
            return Ok(vec![]);
        };
        let moving = unsent.remove(from);
        let at = unsent.iter().position(|i| i.id == before).unwrap_or(unsent.len());
        if at == from {
            return Ok(vec![]);
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
            return Ok(vec![Issue { rank: Some(rank), ..moving }]);
        }
        unsent.insert(at, moving);
        Ok(unsent
            .into_iter()
            .enumerate()
            .filter_map(|(i, mut issue)| {
                let target = (i as i64 + 1) * RANK_STEP;
                (issue.rank.unwrap_or(0) != target).then(|| {
                    issue.rank = Some(target);
                    issue
                })
            })
            .collect())
    }

    /// Deletes an issue never sent: a draft being written goes home, its
    /// checkout is cleared.
    pub async fn remove_async(&self, reference: &str) -> Result<()> {
        let _work = self.work.lock().await;
        let issue = self.stored_async(reference).await?;
        if issue.executions().next().is_some() {
            return Err(refused("server.issue.started", &[]));
        }
        if let Some(r) = &issue.refining {
            self.sessions().dismiss_async(&r.session, Leave::Discard).await?;
        }
        if let Some(main) = self.worktree().main_repo(issue.repo.as_deref())?
            && !self.worktree().discard(&main, issue.number)?
        {
            return Err(refused(
                "server.issue.cannotDelete",
                &[("n", issue.number.into()), ("why", t("server.issue.does.cleanWorktree", &[]).into())],
            ));
        }
        let _ = self.take_words_async(&issue.id).await;
        self.state.remove_issue_async(&issue.id).await
    }

    /// The verdict on what was handed back: a pass marks it reviewed (the
    /// user completes it by moving it to done); a fail records the findings
    /// and sends them to the session for another round.
    pub fn review_async<'a>(
        &'a self,
        reference: &'a str,
        pass: bool,
        findings: &'a [String],
        text: &'a str,
        seen: Option<&'a ReviewRevision>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Issue>> + Send + 'a>> {
        Box::pin(async move {
            let _work = if pass { Some(self.work.lock().await) } else { None };
            let issue = self.stored_async(reference).await?;
            if issue.status != IssueStatus::InReview {
                return Err(refused("server.issue.nothingToAccept", &[]));
            }
            if pass {
                let revision = if issue.deliver == Deliverable::Change && issue.repo.is_some() && issue.parent.is_none() {
                    let c = self.changes_async(&issue.id).await?;
                    if seen.is_some_and(|seen| seen != &c.revision) {
                        return Err(refused("server.issue.reviewChanged", &[]));
                    }
                    let repo = Repo::discover(&c.worktree)?.ok_or_else(|| BoardError::NotARepo(c.worktree.clone()))?;
                    repo.retain_review(&c.revision.base_commit, &c.revision.tree)?;
                    Some(c.revision)
                } else {
                    None
                };
                return self.change_async(&issue.id, IssueChange::Reviewed(revision)).await;
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
                    id: format!("f{}", self.state.next_async("finding", 0).await?),
                    text: f,
                    at,
                    resolved: false,
                });
            }
            let words = failed_text(&all, text);
            self.change_async(&issue.id, IssueChange::Failed { findings: all }).await?;
            self.tell_async(&issue.id, &words).await?;
            self.stored_async(&issue.id).await
        })
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
    pub fn hand_over_and_move_async<'a>(
        &'a self,
        reference: &'a str,
        agent: &'a str,
        words: Option<&'a str>,
        findings: &'a [String],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<vibevalley_core::Move>> + Send + 'a>> {
        Box::pin(async move {
            let _work = self.work.lock().await;
            let issue = self.stored_async(reference).await?;
            let agent = agent.trim();
            self.runtime.driver().check(agent)?;
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
                        id: format!("f{}", self.state.next_async("finding", 0).await?),
                        text: f,
                        at,
                        resolved: false,
                    });
                }
                send_words = Some(failed_text(&all, if findings.is_empty() { text } else { "" }));
                self.change_async(&issue.id, IssueChange::Failed { findings: all }).await?;
            }
            if let Some(s) = self.on_board_async(&issue).await {
                self.sessions().dismiss_async(&s.id, Leave::KeepBranch).await?;
            }
            self.change_async(&issue.id, IssueChange::Assigned(agent.to_string())).await?;
            let kind = if mv == vibevalley_core::Move::Start {
                self.change_async(&issue.id, IssueChange::Queued).await?;
                vibevalley_protocol::RunTriggerKind::Issue
            } else {
                self.change_async(&issue.id, IssueChange::Reopened).await?;
                vibevalley_protocol::RunTriggerKind::Comment
            };
            self.send_async(&issue.id, send_words, kind).await?;
            self.refresh_queue_locked_async().await;
            Ok(mv)
        })
    }

    /// Why one more session cannot start on `issue` now (`noRoom`), or ""
    /// when there is room. Its own session does not count against it.
    pub async fn no_room_async(&self, issue: &Issue) -> String {
        let except = issue.latest_session_id().cloned().unwrap_or_default();
        let repo = issue.repo.clone().unwrap_or_default();
        let config = self.config();
        let sessions = self.sessions_async().await.unwrap_or_default();
        let room = vibevalley_core::rules::room_left(&sessions, &repo, config.space_limit, config.per_repo, &except);
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
