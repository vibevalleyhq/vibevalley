//! Parent and child issues: pure task decomposition and DAG blocking.
//! Each child runs once the siblings it depends on are closed; agents manage
//! their own Git branches/worktrees autonomously and record a `DeliveryReceipt`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{ActorRef, Assignment, Deliverable, Issue, IssueConstraints};

use super::board::Board;
use super::store::{BoardError, Result};
use crate::context::now;

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
        if let Some(s) = self.on_board_async(&parent).await
            && s.phase.is_working()
        {
            return Err(BoardError::Other("the parent's session is working; split it when it rests".into()));
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
            child.repo = parent.repo.clone();
            child.parent = Some(parent.id.clone());
            child.priority = parent.priority;
            child.owner = parent.owner.clone().or_else(|| Some(ActorRef::self_user()));
            child.deliver = Deliverable::Change;
            child.blocked_by = d.needs.iter().filter_map(|n| ids.get(n).cloned()).collect();
            child.constraints = Some(IssueConstraints {
                acceptance: d.acceptance,
                scope: d.scope.clone(),
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
}
