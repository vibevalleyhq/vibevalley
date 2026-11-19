use crate::{Error, Read, Result, Signal, Task, TaskStatus, Tx, WaitMode, id};
use crate::{queries as q, sqlite::optional};
use serde_json::{Value, json};

impl TryFrom<q::GetTaskRow> for Task {
    type Error = Error;
    fn try_from(r: q::GetTaskRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            conversation_id: r.conversation_id,
            owner_task_id: r.owner_task_id,
            dedup_key: r.dedup_key,
            kind: r.kind,
            is_model_task: r.is_model_task != 0,
            status: r.status.parse()?,
            terminal_reason: r.terminal_reason,
            restart_count: r.restart_count.try_into().map_err(|_| Error::Invalid("invalid restart count".into()))?,
            restart_limit: r.restart_limit.try_into().map_err(|_| Error::Invalid("invalid restart limit".into()))?,
            phase_name: r.phase_name,
            checkpoint: serde_json::from_str(&r.checkpoint_json)?,
            wake_until_ms: r.wake_until_ms,
            wait_mode: if r.wait_mode.is_empty() { None } else { Some(r.wait_mode.parse()?) },
            wait_task_ids: serde_json::from_str(&r.wait_task_ids_json)?,
            wait_signal_name: r.wait_signal_name,
            memo: serde_json::from_str(&r.memo_json)?,
            result: serde_json::from_str(&r.result_json)?,
            error_text: r.error_text,
            created_at_ms: r.created_at_ms,
            updated_at_ms: r.updated_at_ms,
        })
    }
}
impl TryFrom<q::TaskSignalsRow> for Signal {
    type Error = Error;
    fn try_from(r: q::TaskSignalsRow) -> Result<Self> {
        Ok(Self {
            id: r.id,
            task_id: r.task_id,
            signal_name: r.signal_name,
            signal_key: r.signal_key,
            payload: serde_json::from_str(&r.payload_json)?,
            consumed: r.consumed != 0,
            consumed_at_ms: r.consumed_at_ms,
            created_at_ms: r.created_at_ms,
        })
    }
}
impl Read<'_> {
    pub fn task(&self, id: &str) -> Result<Task> {
        optional(self.conn.query(async |db| q::get_task(db, q::GetTaskParams { id: id.into() }).await))?
            .map(TryInto::try_into)
            .transpose()?
            .ok_or_else(|| Error::Missing(id.into()))
    }
    pub fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        optional(self.conn.query(async |db| {
            q::task_by_dedup(
                db,
                q::TaskByDedupParams {
                    owner_task_id: owner.into(),
                    dedup_key: key.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }
    pub fn tasks_by_conversation(&self, id: &str) -> Result<Vec<Task>> {
        self.conn
            .query(async |db| q::conversation_tasks(db, q::ConversationTasksParams { conversation_id: id.into() }).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
    pub fn children(&self, owner: &str) -> Result<Vec<Task>> {
        self.conn
            .query(async |db| q::child_tasks(db, q::ChildTasksParams { owner_task_id: owner.into() }).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
    pub fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        self.conn
            .query(async |db| {
                q::tasks_by_status(
                    db,
                    q::TasksByStatusParams {
                        status: status.as_str().into(),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
    pub(crate) fn active_tasks(&self) -> Result<Vec<Task>> {
        self.conn
            .query(async |db| q::active_tasks(db).await)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
    pub fn signals(&self, id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        self.conn
            .query(async |db| {
                q::task_signals(
                    db,
                    q::TaskSignalsParams {
                        task_id: id.into(),
                        include_consumed: i64::from(include_consumed),
                    },
                )
                .await
            })?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
}
impl Tx<'_> {
    pub fn create_task(&mut self, mut t: Task) -> Result<(Task, bool)> {
        if t.kind.is_empty() {
            return Err(Error::Invalid("task kind is empty".into()));
        }
        if !t.dedup_key.is_empty()
            && let Some(previous) = self.task_by_dedup(&t.owner_task_id, &t.dedup_key)?
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
        self.conn.query(async |db| {
            q::insert_task(
                db,
                q::InsertTaskParams {
                    id: t.id.clone(),
                    conversation_id: t.conversation_id.clone(),
                    owner_task_id: t.owner_task_id.clone(),
                    dedup_key: t.dedup_key.clone(),
                    kind: t.kind.clone(),
                    is_model_task: i64::from(t.is_model_task),
                    status: t.status.as_str().into(),
                    terminal_reason: t.terminal_reason.clone(),
                    restart_count: i64::from(t.restart_count),
                    restart_limit: i64::from(t.restart_limit),
                    phase_name: t.phase_name.clone(),
                    checkpoint_json: t.checkpoint.to_string(),
                    wake_until_ms: t.wake_until_ms,
                    wait_mode: t.wait_mode.map_or("", WaitMode::as_str).into(),
                    wait_task_ids_json: json!(t.wait_task_ids).to_string(),
                    wait_signal_name: t.wait_signal_name.clone(),
                    memo_json: t.memo.to_string(),
                    result_json: t.result.to_string(),
                    error_text: t.error_text.clone(),
                    created_at_ms: t.created_at_ms,
                    updated_at_ms: t.updated_at_ms,
                },
            )
            .await
        })?;
        self.tasks_changed = true;
        Ok((t, false))
    }
    pub fn update_task(&mut self, t: &Task) -> Result<Task> {
        let n = self.conn.query(async |db| {
            q::update_task(
                db,
                q::UpdateTaskParams {
                    status: t.status.as_str().into(),
                    terminal_reason: t.terminal_reason.clone(),
                    restart_count: i64::from(t.restart_count),
                    restart_limit: i64::from(t.restart_limit),
                    phase_name: t.phase_name.clone(),
                    checkpoint_json: t.checkpoint.to_string(),
                    wake_until_ms: t.wake_until_ms,
                    wait_mode: t.wait_mode.map_or("", WaitMode::as_str).into(),
                    wait_task_ids_json: json!(t.wait_task_ids).to_string(),
                    wait_signal_name: t.wait_signal_name.clone(),
                    memo_json: t.memo.to_string(),
                    result_json: t.result.to_string(),
                    error_text: t.error_text.clone(),
                    updated_at_ms: self.now_ms,
                    id: t.id.clone(),
                },
            )
            .await
        })?;
        if n == 0 {
            return Err(Error::Missing(t.id.clone()));
        }
        self.tasks_changed = true;
        self.task(&t.id)
    }

    pub fn send_signal(&mut self, task: &str, name: &str, key: Option<&str>, payload: &Value) -> Result<(Signal, bool)> {
        if task.is_empty() || name.is_empty() {
            return Err(Error::Invalid("signal task and name required".into()));
        }
        let key = key.unwrap_or("");
        if !key.is_empty()
            && let Some(previous) = optional(self.conn.query(async |db| {
                q::signal_by_key(
                    db,
                    q::SignalByKeyParams {
                        task_id: task.into(),
                        signal_name: name.into(),
                        signal_key: key.into(),
                    },
                )
                .await
            }))?
            .map(TryInto::try_into)
            .transpose()?
        {
            return Ok((previous, true));
        }
        let id = id();
        let s = self
            .conn
            .query(async |db| {
                q::insert_signal(
                    db,
                    q::InsertSignalParams {
                        id,
                        task_id: task.into(),
                        signal_name: name.into(),
                        signal_key: key.into(),
                        payload_json: payload.to_string(),
                        created_at_ms: self.now_ms,
                    },
                )
                .await
            })?
            .try_into()?;
        self.tasks_changed = true;
        Ok((s, false))
    }
    pub fn consume_first_signal(&mut self, task: &str, name: &str) -> Result<Option<Signal>> {
        optional(self.conn.query(async |db| {
            q::consume_signal(
                db,
                q::ConsumeSignalParams {
                    consumed_at_ms: self.now_ms,
                    task_id: task.into(),
                    signal_name: name.into(),
                },
            )
            .await
        }))?
        .map(TryInto::try_into)
        .transpose()
    }
}
