//! Task execution graph projection aligned with `pi-durable`'s `watchTaskGraph`.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use super::{Read, Result, Store, Task, TaskStatus};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraphNode {
    pub id: String,
    pub conversation_id: String,
    pub owner_task_id: String,
    pub kind: String,
    pub phase: String,
    pub status: TaskStatus,
    pub terminal_reason: String,
    pub restart_count: u32,
    pub aborted: bool,
    pub background: bool,
    pub owned_conversations: Vec<String>,
    pub children: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraph {
    pub root_conversation_id: Option<String>,
    pub nodes: Vec<TaskGraphNode>,
}

impl Store {
    /// Collects the execution graph of tasks, child tasks, and owned subagent conversations.
    pub fn task_graph(&self, root_conversation_id: Option<&str>) -> Result<TaskGraph> {
        self.read(|r| build_task_graph(r, root_conversation_id))
    }
}

fn build_task_graph(r: &Read<'_>, root_conversation_id: Option<&str>) -> Result<TaskGraph> {
    let mut tasks_by_id: HashMap<String, Task> = HashMap::new();
    let mut queue = VecDeque::new();
    let mut seen_convs = HashSet::new();

    if let Some(root) = root_conversation_id {
        if r.conversation(root).is_ok() {
            seen_convs.insert(root.to_owned());
        }
        for t in r.tasks_by_conversation(root)? {
            let id = t.id.clone();
            if tasks_by_id.insert(id.clone(), t).is_none() {
                queue.push_back(id);
            }
        }
        while let Some(task_id) = queue.pop_front() {
            for child in r.children(&task_id)? {
                let cid = child.id.clone();
                if tasks_by_id.insert(cid.clone(), child).is_none() {
                    queue.push_back(cid);
                }
            }
            for child_conv in r.conversations_by_owner_task(&task_id)? {
                if seen_convs.insert(child_conv.id.clone()) {
                    for t in r.tasks_by_conversation(&child_conv.id)? {
                        let tid = t.id.clone();
                        if tasks_by_id.insert(tid.clone(), t).is_none() {
                            queue.push_back(tid);
                        }
                    }
                }
            }
        }
    } else {
        for conv in r.conversations()? {
            if seen_convs.insert(conv.id.clone()) {
                for t in r.tasks_by_conversation(&conv.id)? {
                    tasks_by_id.insert(t.id.clone(), t);
                }
            }
        }
        for t in r.active_tasks()? {
            tasks_by_id.insert(t.id.clone(), t);
        }
    }

    let mut nodes = Vec::with_capacity(tasks_by_id.len());
    for task in tasks_by_id.into_values() {
        let owned_conversations = r.conversations_by_owner_task(&task.id)?.into_iter().map(|c| c.id).collect();
        let children = r.children(&task.id)?.into_iter().map(|c| c.id).collect();
        let aborted = task.terminal_reason == "aborted" || task.terminal_reason == "restart_limit";
        let background = !task.owner_task_id.is_empty();
        nodes.push(TaskGraphNode {
            id: task.id,
            conversation_id: task.conversation_id,
            owner_task_id: task.owner_task_id,
            kind: task.kind,
            phase: task.phase_name,
            status: task.status,
            terminal_reason: task.terminal_reason,
            restart_count: task.restart_count,
            aborted,
            background,
            owned_conversations,
            children,
            created_at_ms: task.created_at_ms,
            updated_at_ms: task.updated_at_ms,
        });
    }

    nodes.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
    Ok(TaskGraph {
        root_conversation_id: root_conversation_id.map(str::to_owned),
        nodes,
    })
}
