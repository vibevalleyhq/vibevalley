use serde_json::Value;

use super::{Error, Read, Result, Signal, Task, TaskStatus, Tx, id};

impl Read<'_> {
    pub async fn task_async(&self, id: &str) -> Result<Task> {
        self.ops.task_async(id).await?.ok_or_else(|| Error::Missing(id.into()))
    }

    pub async fn task_by_dedup_async(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        self.ops.task_by_dedup_async(owner, key).await
    }

    pub async fn tasks_by_conversation_async(&self, id: &str) -> Result<Vec<Task>> {
        self.ops.tasks_by_conversation_async(id).await
    }

    pub async fn children_async(&self, owner: &str) -> Result<Vec<Task>> {
        self.ops.children_async(owner).await
    }

    pub async fn tasks_by_status_async(&self, status: TaskStatus) -> Result<Vec<Task>> {
        self.ops.tasks_by_status_async(status).await
    }

    pub async fn active_tasks_async(&self) -> Result<Vec<Task>> {
        self.ops.active_tasks_async().await
    }

    pub async fn signals_async(&self, id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        self.ops.signals_async(id, include_consumed).await
    }
}

impl Tx<'_> {
    pub async fn create_task_async(&mut self, mut t: Task) -> Result<(Task, bool)> {
        if t.kind.is_empty() {
            return Err(Error::Invalid("task kind is empty".into()));
        }
        if !t.dedup_key.is_empty()
            && let Some(previous) = self.task_by_dedup_async(&t.owner_task_id, &t.dedup_key).await?
        {
            return Ok((previous, true));
        }
        if t.id.is_empty() {
            t.id = id();
        }
        if t.created_at_ms == 0 {
            t.created_at_ms = self.now_ms;
        }
        t.updated_at_ms = self.now_ms;
        if t.restart_limit == 0 {
            t.restart_limit = 5;
        }
        self.write.insert_task_async(&t).await?;
        self.tasks_changed = true;
        Ok((t, false))
    }

    pub async fn update_task_async(&mut self, t: &Task) -> Result<Task> {
        if !self.write.update_task_async(t, self.now_ms).await? {
            return Err(Error::Missing(t.id.clone()));
        }
        self.tasks_changed = true;
        self.task_async(&t.id).await
    }

    pub async fn send_signal_async(&mut self, task: &str, name: &str, key: Option<&str>, payload: &Value) -> Result<(Signal, bool)> {
        if task.is_empty() || name.is_empty() {
            return Err(Error::Invalid("signal task and name required".into()));
        }
        let key = key.unwrap_or("");
        if !key.is_empty()
            && let Some(previous) = self.ops.signal_by_key_async(task, name, key).await?
        {
            return Ok((previous, true));
        }
        let signal = Signal {
            id: id(),
            task_id: task.into(),
            signal_name: name.into(),
            signal_key: key.into(),
            payload: payload.clone(),
            consumed: false,
            consumed_at_ms: 0,
            created_at_ms: self.now_ms,
        };
        let inserted = self.write.insert_signal_async(&signal).await?;
        self.tasks_changed = true;
        Ok((inserted, false))
    }

    pub async fn consume_first_signal_async(&mut self, task: &str, name: &str) -> Result<Option<Signal>> {
        self.write.consume_first_signal_async(task, name, self.now_ms).await
    }
}
