-- name: ReadMaxSignalInsertSeq :one
SELECT CAST(COALESCE(MAX(insert_seq), 0) AS INTEGER) AS max_insert_seq
FROM durable_signal;

-- name: InsertConversation :exec
INSERT INTO durable_conversation (
	id, owner_task_id, parent_id, fork_entry_seq, head_seq, next_seq,
	provider_affinity, metadata_json, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdateConversation :execrows
UPDATE durable_conversation
SET head_seq = ?, next_seq = ?, metadata_json = ?, updated_at_ms = ?
WHERE id = ?;

-- name: GetConversation :one
SELECT id, owner_task_id, parent_id, fork_entry_seq, head_seq, next_seq,
       provider_affinity, metadata_json, created_at_ms, updated_at_ms
FROM durable_conversation
WHERE id = ?;

-- name: ListConversationsByOwnerTask :many
SELECT id, owner_task_id, parent_id, fork_entry_seq, head_seq, next_seq,
       provider_affinity, metadata_json, created_at_ms, updated_at_ms
FROM durable_conversation
WHERE owner_task_id = ?
ORDER BY created_at_ms ASC, id ASC;

-- name: InsertEntry :exec
INSERT INTO durable_entry (conversation_id, seq, kind, payload_json, created_at_ms)
VALUES (?, ?, ?, ?, ?);

-- name: ListEntriesFrom :many
SELECT conversation_id, seq, kind, payload_json, created_at_ms
FROM durable_entry
WHERE conversation_id = ? AND seq >= ?
ORDER BY seq ASC;

-- name: ListEntriesRange :many
SELECT conversation_id, seq, kind, payload_json, created_at_ms
FROM durable_entry
WHERE conversation_id = ? AND seq >= ? AND seq <= ?
ORDER BY seq ASC;

-- name: GetDocument :one
SELECT scope_kind, scope_id, doc_kind, rev, state_json, updated_at_ms
FROM durable_document
WHERE scope_kind = ? AND scope_id = ? AND doc_kind = ?;

-- name: ListDocumentsByScope :many
SELECT scope_kind, scope_id, doc_kind, rev, state_json, updated_at_ms
FROM durable_document
WHERE scope_kind = ? AND scope_id = ?
ORDER BY doc_kind ASC;

-- name: InsertDocument :exec
INSERT INTO durable_document (scope_kind, scope_id, doc_kind, rev, state_json, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?);

-- name: UpdateDocument :exec
UPDATE durable_document
SET rev = ?, state_json = ?, updated_at_ms = ?
WHERE scope_kind = ? AND scope_id = ? AND doc_kind = ?;

-- name: DeleteDocument :execrows
DELETE FROM durable_document
WHERE scope_kind = ? AND scope_id = ? AND doc_kind = ?;

-- name: InsertSubmission :exec
INSERT INTO durable_submission (
	id, conversation_id, request_id, kind, status, payload_json,
	notify_task_id, result_json, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdateSubmission :execrows
UPDATE durable_submission
SET status = ?, result_json = ?, updated_at_ms = ?
WHERE id = ?;

-- name: GetSubmission :one
SELECT id, conversation_id, request_id, kind, status, payload_json,
       notify_task_id, result_json, created_at_ms, updated_at_ms
FROM durable_submission
WHERE id = ?;

-- name: GetSubmissionByRequestID :one
SELECT id, conversation_id, request_id, kind, status, payload_json,
       notify_task_id, result_json, created_at_ms, updated_at_ms
FROM durable_submission
WHERE conversation_id = ? AND request_id = ?;

-- name: InsertTask :exec
INSERT INTO durable_task (
	id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
	status, terminal_reason, restart_count, restart_limit, phase_name,
	checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
	memo_json, result_json, error_text, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdateTask :execrows
UPDATE durable_task
SET status = ?, terminal_reason = ?, restart_count = ?, restart_limit = ?, phase_name = ?,
    checkpoint_json = ?, wake_until_ms = ?, wait_mode = ?, wait_task_ids_json = ?, wait_signal_name = ?,
    memo_json = ?, result_json = ?, error_text = ?, updated_at_ms = ?
WHERE id = ?;

-- name: GetTask :one
SELECT id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
       status, terminal_reason, restart_count, restart_limit, phase_name,
       checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
       memo_json, result_json, error_text, created_at_ms, updated_at_ms
FROM durable_task
WHERE id = ?;

-- name: GetTaskByDedupKey :one
SELECT id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
       status, terminal_reason, restart_count, restart_limit, phase_name,
       checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
       memo_json, result_json, error_text, created_at_ms, updated_at_ms
FROM durable_task
WHERE owner_task_id = ? AND dedup_key = ?;

-- name: ListTasksByOwner :many
SELECT id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
       status, terminal_reason, restart_count, restart_limit, phase_name,
       checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
       memo_json, result_json, error_text, created_at_ms, updated_at_ms
FROM durable_task
WHERE owner_task_id = ?
ORDER BY created_at_ms ASC, id ASC;

-- name: ListAllTasks :many
SELECT id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
       status, terminal_reason, restart_count, restart_limit, phase_name,
       checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
       memo_json, result_json, error_text, created_at_ms, updated_at_ms
FROM durable_task
ORDER BY created_at_ms ASC, id ASC;

-- name: ListTasksByStatus :many
SELECT id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
       status, terminal_reason, restart_count, restart_limit, phase_name,
       checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
       memo_json, result_json, error_text, created_at_ms, updated_at_ms
FROM durable_task
WHERE status IN (sqlc.slice('statuses'))
ORDER BY created_at_ms ASC, id ASC;

-- name: ListTasksByConversation :many
SELECT id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
       status, terminal_reason, restart_count, restart_limit, phase_name,
       checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
       memo_json, result_json, error_text, created_at_ms, updated_at_ms
FROM durable_task
WHERE conversation_id = ?
ORDER BY created_at_ms ASC, id ASC;

-- name: InsertSignal :exec
INSERT INTO durable_signal (
	id, insert_seq, task_id, signal_name, signal_key, payload_json,
	consumed, consumed_at_ms, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetSignalByKey :one
SELECT id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms
FROM durable_signal
WHERE task_id = ? AND signal_name = ? AND signal_key = ?;

-- name: MarkSignalConsumed :execrows
UPDATE durable_signal
SET consumed = 1, consumed_at_ms = ?
WHERE id = ? AND consumed = 0;

-- name: SignalExists :one
SELECT CAST(1 AS INTEGER) AS found
FROM durable_signal
WHERE id = ?;

-- name: ListSignals :many
SELECT id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms
FROM durable_signal
WHERE task_id = sqlc.arg(task_id)
  AND (CAST(sqlc.arg(signal_name) AS TEXT) = '' OR signal_name = sqlc.arg(signal_name))
  AND (CAST(sqlc.arg(only_unconsumed) AS INTEGER) = 0 OR consumed = 0)
ORDER BY created_at_ms ASC, insert_seq ASC;
