//! Parent and child issues: an open issue split into children that each go
//! once the siblings they need are done, and a child in review checked and
//! merged into its parent's branch.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{Assignment, Deliverable, Fact, Issue, IssueConstraints, IssueStageKind as StageKind};

use super::board::Board;
use crate::modules::work::ledger::{BoardError, IssueChange, Result, lock, now};
use crate::modules::work::workplace::{Joined, Leave, OnDisk, Workplace};

/// One child of a split (`IssueChildDraft`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChildDraft {
    /// The draft's own id, which its siblings' `needs` name.
    pub id: String,
    pub title: String,
    pub brief: String,
    pub needs: Vec<String>,
    pub acceptance: bool,
    pub check: Option<String>,
    pub scope: Vec<String>,
    /// Defaults to the parent's agent.
    pub agent: Option<String>,
}

/// At most this many children per split.
pub const MAX_CHILDREN: usize = 12;

impl Board {
    /// Splits an open issue into child issues, all queued: each goes once
    /// the siblings it needs are done.
    pub fn split(&self, reference: &str, drafts: Vec<ChildDraft>) -> Result<Vec<Issue>> {
        let _work = lock(&self.0.work);
        let parent = self.stored(reference)?;
        if parent.status.is_closed() {
            return Err(BoardError::Other(format!("issue #{} is closed", parent.number)));
        }
        let Some(repo) = parent.repo.clone() else {
            return Err(BoardError::Other("only an issue with a repository can be split".into()));
        };
        let state = self.state();
        if state.issues.iter().any(|t| t.parent.as_ref() == Some(&parent.id)) {
            return Err(BoardError::Other(format!("issue #{} is split already", parent.number)));
        }
        let nodes: Vec<vibevalley_core::DagNode> = drafts
            .iter()
            .map(|d| vibevalley_core::DagNode {
                id: d.id.clone(),
                after: d.needs.clone(),
            })
            .collect();
        if drafts.is_empty()
            || drafts.len() > MAX_CHILDREN
            || drafts.iter().any(|d| !vibevalley_core::dag_id_valid(&d.id))
            || !vibevalley_core::dag_problems(&nodes).is_empty()
        {
            return Err(BoardError::Other(format!(
                "a split is 1 to {MAX_CHILDREN} children with ASCII ids whose needs form a DAG"
            )));
        }
        if drafts.iter().any(|d| d.acceptance && d.check.as_deref().unwrap_or("").trim().is_empty()) {
            return Err(BoardError::Other("an acceptance child needs a check command".into()));
        }
        if let Some(s) = self.on_board(&parent) {
            if s.phase.is_working() {
                return Err(BoardError::Other("the parent's session is working; split it when it rests".into()));
            }
            if let Some(wt) = s.cwd.as_deref() {
                Workplace::commit_leftovers(wt, &format!("Issue #{}: work before the split", parent.number))?;
            }
        }
        let agent_of_parent = parent.assigned_agent().unwrap_or("").to_string();
        for d in &drafts {
            let agent = d.agent.as_deref().unwrap_or(&agent_of_parent);
            if !agent.trim().is_empty() {
                self.0.drivers.check(agent)?;
            }
        }
        let mut ids: HashMap<String, String> = HashMap::new();
        let mut made = Vec::new();
        let at = now();
        for d in &drafts {
            let number = self.0.ledger.next("issue", state.issues.iter().map(|t| t.number).max().unwrap_or(0))?;
            let id = format!("i{number}");
            ids.insert(d.id.clone(), id.clone());
            let (title, description) = if d.title.trim().is_empty() {
                (d.brief.trim().to_string(), String::new())
            } else {
                (d.title.trim().to_string(), d.brief.trim().to_string())
            };
            let mut child = Issue::new(&id, number, title, at);
            child.description = description;
            child.repo = Some(repo.clone());
            child.parent = Some(parent.id.clone());
            child.priority = parent.priority;
            child.deliver = Deliverable::Change;
            child.blocked_by = d.needs.iter().filter_map(|n| ids.get(n).cloned()).collect();
            child.constraints = Some(IssueConstraints {
                acceptance: d.acceptance,
                scope: d.scope.clone(),
                frozen: vec![],
                check: d.check.clone().filter(|c| !c.trim().is_empty()),
            });
            child.queued_at = Some(at);
            let agent = d.agent.clone().unwrap_or_else(|| agent_of_parent.clone());
            if !agent.trim().is_empty() {
                child.assignments = vec![Assignment {
                    id: format!("{id}-a1"),
                    issue: id.clone(),
                    agent,
                    assigned_at: at,
                    ended_at: None,
                    executions: vec![],
                }];
            }
            made.push(id);
            self.0.ledger.apply(vec![Fact::issue_changed(at, child)])?;
        }
        self.refresh_queue_locked();
        Ok(made.iter().filter_map(|id| self.issue(id)).collect())
    }

    /// Children whose round is in review are checked and merged into their
    /// parent's branch.
    pub(super) fn join_children(&self) -> Result<()> {
        let reviewing: Vec<Issue> = self
            .state()
            .issues
            .into_iter()
            .filter(|t| t.parent.is_some() && t.stage.state == StageKind::Reviewing)
            .collect();
        for child in reviewing {
            self.join_one(&child)?;
        }
        Ok(())
    }

    fn join_one(&self, child: &Issue) -> Result<()> {
        let Some(parent) = child.parent.as_deref().and_then(|p| self.issue(p)) else {
            return Ok(());
        };
        if parent.status.is_closed() {
            return Ok(());
        }
        let wp = &self.0.workplaces;
        let Some(main) = wp.main_repo(parent.repo.as_deref())? else { return Ok(()) };
        let Some(session) = self.on_board(child) else { return Ok(()) };
        // The parent's session is busy in the parent's worktree: wait.
        let parent_session = self.on_board(&parent);
        if parent_session.as_ref().is_some_and(|s| s.phase.is_working()) {
            return Ok(());
        }
        let checks = vibevalley_core::child_checks(child, &self.state().issues);
        let parent_worktree = parent_session.and_then(|s| s.cwd);
        let child_at = OnDisk {
            number: child.number,
            title: &child.title,
            worktree: session.cwd.as_deref(),
        };
        let parent_at = OnDisk {
            number: parent.number,
            title: &parent.title,
            worktree: parent_worktree.as_deref(),
        };
        let joined = wp.join(&main, &child_at, &parent_at, &checks)?;
        match joined {
            None => {}
            Some(Joined::Stuck { why, conflict }) => {
                self.change(&child.id, IssueChange::Stuck { why, conflict })?;
            }
            Some(Joined::Merged { frozen }) => {
                self.0.sessions.dismiss(&session.id, Leave::Discard)?;
                self.change(&child.id, IssueChange::MergedIntoParent { frozen })?;
            }
        }
        Ok(())
    }
}
