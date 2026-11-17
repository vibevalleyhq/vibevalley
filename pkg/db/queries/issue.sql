-- name: UpsertIssue :exec
INSERT INTO issue (
    id, title, status, repo_id, assignee_id, session_id, conversation_id, state_json, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    title = excluded.title,
    status = excluded.status,
    repo_id = excluded.repo_id,
    assignee_id = excluded.assignee_id,
    session_id = excluded.session_id,
    conversation_id = excluded.conversation_id,
    state_json = excluded.state_json,
    updated_at_ms = excluded.updated_at_ms;

-- name: GetIssue :one
SELECT state_json
FROM issue
WHERE id = ?;

-- name: GetIssueByConversation :one
SELECT state_json
FROM issue
WHERE conversation_id = ?
LIMIT 1;

-- name: GetIssueBySession :one
SELECT state_json
FROM issue
WHERE session_id = ?
LIMIT 1;

-- name: ListIssues :many
SELECT state_json
FROM issue
ORDER BY created_at_ms ASC, id ASC;

-- name: ListIssuesByStatus :many
SELECT state_json
FROM issue
WHERE status IN (sqlc.slice('statuses'))
ORDER BY created_at_ms ASC, id ASC;

-- name: UpsertCron :exec
INSERT INTO issue_cron (
    id, enabled, pending_approval, next_run_at_ms, last_run_at_ms, state_json, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    enabled = excluded.enabled,
    pending_approval = excluded.pending_approval,
    next_run_at_ms = excluded.next_run_at_ms,
    last_run_at_ms = excluded.last_run_at_ms,
    state_json = excluded.state_json,
    updated_at_ms = excluded.updated_at_ms;

-- name: GetCron :one
SELECT state_json
FROM issue_cron
WHERE id = ?;

-- name: ListCrons :many
SELECT state_json
FROM issue_cron
ORDER BY created_at_ms ASC, id ASC;

-- name: ListDueCrons :many
SELECT state_json
FROM issue_cron
WHERE enabled = 1 AND pending_approval = 0 AND next_run_at_ms > 0 AND next_run_at_ms <= ?
ORDER BY next_run_at_ms ASC, id ASC;
