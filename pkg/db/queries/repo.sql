-- name: SaveRepo :exec
INSERT INTO repo_repository (id, name, state_json, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
	name = excluded.name,
	state_json = excluded.state_json,
	updated_at_ms = excluded.updated_at_ms;

-- name: GetRepo :one
SELECT state_json
FROM repo_repository
WHERE id = ?;

-- name: GetRepoByName :one
SELECT state_json
FROM repo_repository
WHERE name = ?;

-- name: ListRepos :many
SELECT state_json
FROM repo_repository
ORDER BY created_at_ms ASC, id ASC;

-- name: DeleteWorktreesByRepo :exec
DELETE FROM repo_worktree WHERE repo_id = ?;

-- name: DeleteRepo :exec
DELETE FROM repo_repository WHERE id = ?;

-- name: SaveWorktree :exec
INSERT INTO repo_worktree (repo_id, issue_id, status, state_json, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (repo_id, issue_id) DO UPDATE SET
	status = excluded.status,
	state_json = excluded.state_json,
	updated_at_ms = excluded.updated_at_ms;

-- name: GetWorktree :one
SELECT state_json
FROM repo_worktree
WHERE repo_id = ? AND issue_id = ?;

-- name: ListWorktreesByRepo :many
SELECT state_json
FROM repo_worktree
WHERE repo_id = ?
ORDER BY created_at_ms ASC, issue_id ASC;

-- name: ListAllWorktrees :many
SELECT state_json
FROM repo_worktree
ORDER BY created_at_ms ASC, repo_id ASC, issue_id ASC;
