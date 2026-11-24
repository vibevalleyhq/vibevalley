//! Parent and child issues: an open issue split into children that each go
//! once the siblings they need are done, and a child in review checked and
//! merged into its parent's branch.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{Assignment, Deliverable, Issue, IssueConstraints, IssueStageKind as StageKind};

use super::board::Board;
use super::store::{BoardError, IssueChange, Result};
use crate::context::now;
use crate::runtime::{Joined, Leave, OnDisk, Worktree};

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
    pub async fn split_async(&self, reference: &str, drafts: Vec<ChildDraft>) -> Result<Vec<Issue>> {
        let _work = self.work.lock().await;
        let parent = self.stored_async(reference).await?;
        if parent.status.is_closed() {
            return Err(BoardError::Other(format!("issue #{} is closed", parent.number)));
        }
        let Some(repo) = parent.repo.clone() else {
            return Err(BoardError::Other("only an issue with a repository can be split".into()));
        };
        let all_issues = self.issues_async().await?;
        if all_issues.iter().any(|t| t.parent.as_ref() == Some(&parent.id)) {
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
        if let Some(s) = self.on_board_async(&parent).await {
            if s.phase.is_working() {
                return Err(BoardError::Other("the parent's session is working; split it when it rests".into()));
            }
            if let Some(wt) = s.cwd.as_deref() {
                Worktree::commit_leftovers(wt, &format!("Issue #{}: work before the split", parent.number))?;
            }
        }
        let agent_of_parent = parent.assigned_agent().unwrap_or("").to_string();
        for d in &drafts {
            let agent = d.agent.as_deref().unwrap_or(&agent_of_parent);
            if !agent.trim().is_empty() {
                self.runtime.driver().check(agent)?;
            }
        }
        let mut ids: HashMap<String, String> = HashMap::new();
        let mut made = Vec::new();
        let mut children = Vec::new();
        let at = now();
        let max_number = all_issues.iter().map(|t| t.number).max().unwrap_or(0);
        for d in &drafts {
            let number = self.state.next_async("issue", max_number).await?;
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
            children.push(child);
        }
        self.state.put_issues_async(&children).await?;
        self.refresh_queue_locked_async().await;
        let updated = self.issues_async().await?;
        Ok(made.into_iter().filter_map(|id| updated.iter().find(|i| i.id == id).cloned()).collect())
    }

    /// Children whose round is in review are checked and merged into their
    /// parent's branch.
    pub(super) async fn join_children_async(&self) -> Result<()> {
        let issues = self.issues_async().await?;
        let reviewing: Vec<Issue> = issues
            .iter()
            .filter(|t| t.parent.is_some() && t.stage.state == StageKind::Reviewing)
            .cloned()
            .collect();
        for child in reviewing {
            self.join_one_async(&child, &issues).await?;
        }
        Ok(())
    }

    async fn join_one_async(&self, child: &Issue, all_issues: &[Issue]) -> Result<()> {
        let Some(parent) = child.parent.as_deref().and_then(|p| all_issues.iter().find(|i| i.id == p)).cloned() else {
            return Ok(());
        };
        if parent.status.is_closed() {
            return Ok(());
        }
        let wp = self.worktree();
        let Some(main) = wp.main_repo_async(parent.repo.as_deref()).await? else {
            return Ok(());
        };
        let Some(session) = self.on_board_async(child).await else { return Ok(()) };
        // The parent's session is busy in the parent's worktree: wait.
        let parent_session = self.on_board_async(&parent).await;
        if parent_session.as_ref().is_some_and(|s| s.phase.is_working()) {
            return Ok(());
        }
        let checks = vibevalley_core::child_checks(child, all_issues);
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
        let joined = wp.join_async(&main, &child_at, &parent_at, &checks).await?;
        match joined {
            None => {}
            Some(Joined::Stuck { why, conflict }) => {
                self.change_async(&child.id, IssueChange::Stuck { why, conflict }).await?;
            }
            Some(Joined::Merged { frozen }) => {
                self.session_engine().dismiss_async(&session.id, Leave::Discard).await?;
                self.change_async(&child.id, IssueChange::MergedIntoParent { frozen }).await?;
            }
        }
        Ok(())
    }
}
