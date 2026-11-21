-- name: GetTask :one
SELECT * FROM durable_task WHERE id=?1;
-- name: TaskByDedup :one
SELECT * FROM durable_task WHERE owner_task_id=?1 AND dedup_key=?2 AND dedup_key<>'';
-- name: ConversationTasks :many
SELECT * FROM durable_task WHERE conversation_id=?1 ORDER BY created_at_ms,id;
-- name: ChildTasks :many
SELECT * FROM durable_task WHERE owner_task_id=?1 ORDER BY created_at_ms,id;
-- name: TasksByStatus :many
SELECT * FROM durable_task WHERE status=?1 ORDER BY created_at_ms,id;
-- name: ActiveTasks :many
SELECT * FROM durable_task WHERE status<>'terminal' ORDER BY created_at_ms,id;
-- name: TaskSignals :many
SELECT id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms FROM durable_signal WHERE task_id=?1 AND (consumed=0 OR CAST(sqlc.arg(include_consumed) AS INTEGER)<>0) ORDER BY insert_seq;
-- name: InsertTask :exec
INSERT INTO durable_task(id,conversation_id,owner_task_id,dedup_key,kind,is_model_task,status,terminal_reason,restart_count,restart_limit,phase_name,checkpoint_json,wake_until_ms,wait_mode,wait_task_ids_json,wait_signal_name,memo_json,result_json,error_text,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
-- name: UpdateTask :execrows
UPDATE durable_task SET status=?,terminal_reason=?,restart_count=?,restart_limit=?,phase_name=?,checkpoint_json=?,wake_until_ms=?,wait_mode=?,wait_task_ids_json=?,wait_signal_name=?,memo_json=?,result_json=?,error_text=?,updated_at_ms=? WHERE id=?;
-- name: SignalByKey :one
SELECT id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms FROM durable_signal WHERE task_id=?1 AND signal_name=?2 AND signal_key=?3;
-- name: InsertSignal :one
INSERT INTO durable_signal(id,task_id,signal_name,signal_key,payload_json,insert_seq,created_at_ms) VALUES (?1,?2,?3,?4,?5,(SELECT COALESCE(MAX(insert_seq),0)+1 FROM durable_signal),?6) RETURNING id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms;
-- name: ConsumeSignal :one
UPDATE durable_signal SET consumed=1,consumed_at_ms=?1 WHERE id=(SELECT next.id FROM durable_signal AS next WHERE next.task_id=?2 AND next.signal_name=?3 AND next.consumed=0 ORDER BY next.insert_seq LIMIT 1) RETURNING id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms;
