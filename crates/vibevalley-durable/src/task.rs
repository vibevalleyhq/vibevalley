use crate::{Error, Read, Result, Signal, Task, TaskStatus, Tx, WaitMode, id};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::{Value, json};

fn task(r: &Row<'_>) -> rusqlite::Result<Task> {
    let wait: String = r.get("wait_mode")?;
    let mode = match wait.as_str() {
        "" => None,
        _ => Some(r.get::<_, WaitMode>("wait_mode")?),
    };
    let wait_task_ids = serde_json::from_str(&r.get::<_, String>("wait_task_ids_json")?)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(14, rusqlite::types::Type::Text, Box::new(e)))?;
    Ok(Task {
        id: r.get("id")?,
        conversation_id: r.get("conversation_id")?,
        owner_task_id: r.get("owner_task_id")?,
        dedup_key: r.get("dedup_key")?,
        kind: r.get("kind")?,
        is_model_task: r.get("is_model_task")?,
        status: r.get("status")?,
        terminal_reason: r.get("terminal_reason")?,
        restart_count: r.get("restart_count")?,
        restart_limit: r.get("restart_limit")?,
        phase_name: r.get("phase_name")?,
        checkpoint: r.get("checkpoint_json")?,
        wake_until_ms: r.get("wake_until_ms")?,
        wait_mode: mode,
        wait_task_ids,
        wait_signal_name: r.get("wait_signal_name")?,
        memo: r.get("memo_json")?,
        result: r.get("result_json")?,
        error_text: r.get("error_text")?,
        created_at_ms: r.get("created_at_ms")?,
        updated_at_ms: r.get("updated_at_ms")?,
    })
}
fn signal(r: &Row<'_>) -> rusqlite::Result<Signal> {
    Ok(Signal {
        id: r.get("id")?,
        task_id: r.get("task_id")?,
        signal_name: r.get("signal_name")?,
        signal_key: r.get("signal_key")?,
        payload: r.get("payload_json")?,
        consumed: r.get("consumed")?,
        consumed_at_ms: r.get("consumed_at_ms")?,
        created_at_ms: r.get("created_at_ms")?,
    })
}

impl Read<'_> {
    pub fn task(&self, id: &str) -> Result<Task> {
        self.conn
            .query_row("SELECT * FROM durable_task WHERE id=?", [id], task)
            .optional()?
            .ok_or_else(|| Error::Missing(id.into()))
    }
    pub fn task_by_dedup(&self, owner: &str, key: &str) -> Result<Option<Task>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM durable_task WHERE owner_task_id=? AND dedup_key=? AND dedup_key<>''",
                params![owner, key],
                task,
            )
            .optional()?)
    }
    fn query_tasks(&self, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Task>> {
        let mut q = self.conn.prepare(sql)?;
        Ok(q.query_map(args, task)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn tasks_by_conversation(&self, id: &str) -> Result<Vec<Task>> {
        self.query_tasks("SELECT * FROM durable_task WHERE conversation_id=? ORDER BY created_at_ms,id", [id])
    }
    pub fn children(&self, owner: &str) -> Result<Vec<Task>> {
        self.query_tasks("SELECT * FROM durable_task WHERE owner_task_id=? ORDER BY created_at_ms,id", [owner])
    }
    pub fn tasks_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        self.query_tasks("SELECT * FROM durable_task WHERE status=? ORDER BY created_at_ms,id", [status])
    }
    pub(crate) fn active_tasks(&self) -> Result<Vec<Task>> {
        self.query_tasks("SELECT * FROM durable_task WHERE status<>'terminal' ORDER BY created_at_ms,id", [])
    }
    pub fn signals(&self, id: &str, include_consumed: bool) -> Result<Vec<Signal>> {
        let mut q = self
            .conn
            .prepare("SELECT * FROM durable_signal WHERE task_id=? AND (consumed=0 OR ?) ORDER BY insert_seq")?;
        Ok(q.query_map(params![id, include_consumed], signal)?.collect::<rusqlite::Result<Vec<_>>>()?)
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
        self.conn.execute("INSERT INTO durable_task(id,conversation_id,owner_task_id,dedup_key,kind,is_model_task,status,terminal_reason,restart_count,restart_limit,phase_name,checkpoint_json,wake_until_ms,wait_mode,wait_task_ids_json,wait_signal_name,memo_json,result_json,error_text,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![t.id,t.conversation_id,t.owner_task_id,t.dedup_key,t.kind,t.is_model_task,t.status,t.terminal_reason,t.restart_count,t.restart_limit,t.phase_name,t.checkpoint.to_string(),t.wake_until_ms,t.wait_mode.map_or("",WaitMode::as_str),json!(t.wait_task_ids).to_string(),t.wait_signal_name,t.memo.to_string(),t.result.to_string(),t.error_text,t.created_at_ms,t.updated_at_ms])?;
        self.tasks_changed = true;
        Ok((t, false))
    }
    pub fn update_task(&mut self, t: &Task) -> Result<Task> {
        let n=self.conn.execute("UPDATE durable_task SET status=?,terminal_reason=?,restart_count=?,restart_limit=?,phase_name=?,checkpoint_json=?,wake_until_ms=?,wait_mode=?,wait_task_ids_json=?,wait_signal_name=?,memo_json=?,result_json=?,error_text=?,updated_at_ms=? WHERE id=?",params![t.status,t.terminal_reason,t.restart_count,t.restart_limit,t.phase_name,t.checkpoint.to_string(),t.wake_until_ms,t.wait_mode.map_or("",WaitMode::as_str),json!(t.wait_task_ids).to_string(),t.wait_signal_name,t.memo.to_string(),t.result.to_string(),t.error_text,self.now_ms,t.id])?;
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
            && let Some(previous) = self
                .conn
                .query_row(
                    "SELECT * FROM durable_signal WHERE task_id=? AND signal_name=? AND signal_key=?",
                    params![task, name, key],
                    signal,
                )
                .optional()?
        {
            return Ok((previous, true));
        }
        let id = id();
        let s=self.conn.query_row("INSERT INTO durable_signal(id,task_id,signal_name,signal_key,payload_json,insert_seq,created_at_ms) VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(insert_seq),0)+1 FROM durable_signal),?) RETURNING *",params![id,task,name,key,payload.to_string(),self.now_ms],signal)?;
        self.tasks_changed = true;
        Ok((s, false))
    }
    pub fn consume_first_signal(&mut self, task: &str, name: &str) -> Result<Option<Signal>> {
        Ok(self.conn.query_row("UPDATE durable_signal SET consumed=1,consumed_at_ms=? WHERE id=(SELECT id FROM durable_signal WHERE task_id=? AND signal_name=? AND consumed=0 ORDER BY insert_seq LIMIT 1) RETURNING *",params![self.now_ms,task,name],signal).optional()?)
    }
}
