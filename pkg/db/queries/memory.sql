-- name: EnsureHead :exec
INSERT OR IGNORE INTO memory_heads (scope_id, active_version, next_version, updated_at_ms)
VALUES (?, 0, 1, ?);

-- name: GetHead :one
SELECT active_version, next_version
FROM memory_heads
WHERE scope_id = ?;

-- name: GetActiveVersion :one
SELECT active_version
FROM memory_heads
WHERE scope_id = ?;

-- name: UpdateHeadVersions :exec
UPDATE memory_heads
SET active_version = ?, next_version = ?, updated_at_ms = ?
WHERE scope_id = ?;

-- name: UpdateHeadNextVersion :exec
UPDATE memory_heads
SET next_version = ?, updated_at_ms = ?
WHERE scope_id = ?;

-- name: UpdateHeadActiveVersion :exec
UPDATE memory_heads
SET active_version = ?, updated_at_ms = ?
WHERE scope_id = ?;

-- name: InsertVersion :exec
INSERT INTO memory_versions (
    scope_id, version, parent_version, kind, status, summary, session_id, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetVersion :one
SELECT scope_id, version, parent_version, kind, status, summary, session_id, created_at_ms
FROM memory_versions
WHERE scope_id = ? AND version = ?;

-- name: ListVersionsByScope :many
SELECT version, parent_version, kind, status, summary, session_id, created_at_ms
FROM memory_versions
WHERE scope_id = ?
ORDER BY version ASC;

-- name: UpdateVersionStatus :exec
UPDATE memory_versions
SET status = ?
WHERE scope_id = ? AND version = ?;

-- name: InsertVersionFile :exec
INSERT INTO memory_version_files (
    scope_id, version, rel_path, file_version, sha256, content, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: ListVersionFiles :many
SELECT rel_path, file_version, sha256, content, updated_at_ms
FROM memory_version_files
WHERE scope_id = ? AND version = ?
ORDER BY rel_path ASC;

-- name: InsertConflict :exec
INSERT INTO memory_conflicts (
    conflict_id, scope_id, rel_path, base_version, server_version,
    conflict_rel_path, uploaded_sha256, content, session_id,
    resolved, resolution, created_at_ms, resolved_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, 0);

-- name: GetConflictByID :one
SELECT conflict_id, scope_id, rel_path, base_version, server_version,
       conflict_rel_path, uploaded_sha256, content, session_id,
       resolved, resolution, created_at_ms, resolved_at_ms
FROM memory_conflicts
WHERE conflict_id = ?;

-- name: ListAllConflictsByScope :many
SELECT conflict_id, scope_id, rel_path, base_version, server_version,
       conflict_rel_path, uploaded_sha256, content, session_id,
       resolved, resolution, created_at_ms, resolved_at_ms
FROM memory_conflicts
WHERE scope_id = ?
ORDER BY created_at_ms ASC, conflict_id ASC;

-- name: ListUnresolvedConflictsByScope :many
SELECT conflict_id, scope_id, rel_path, base_version, server_version,
       conflict_rel_path, uploaded_sha256, content, session_id,
       resolved, resolution, created_at_ms, resolved_at_ms
FROM memory_conflicts
WHERE scope_id = ? AND resolved = 0
ORDER BY created_at_ms ASC, conflict_id ASC;

-- name: MarkConflictResolved :exec
UPDATE memory_conflicts
SET resolved = 1, resolution = ?, resolved_at_ms = ?
WHERE conflict_id = ?;

-- name: InsertConflictInbox :exec
INSERT INTO memory_inbox (
    id, scope_id, kind, title, summary, session_id, issue_id,
    proposal_id, conflict_id, resolved, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, 0, ?);

-- name: InsertDreamInbox :exec
INSERT INTO memory_inbox (
    id, scope_id, kind, title, summary, session_id, issue_id,
    proposal_id, conflict_id, resolved, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, '', ?, '', 0, ?);

-- name: ListAllInboxByScope :many
SELECT id, kind, title, summary, session_id, issue_id, resolved, created_at_ms
FROM memory_inbox
WHERE scope_id = ?
ORDER BY created_at_ms ASC, id ASC;

-- name: ListUnresolvedInboxByScope :many
SELECT id, kind, title, summary, session_id, issue_id, resolved, created_at_ms
FROM memory_inbox
WHERE scope_id = ? AND resolved = 0
ORDER BY created_at_ms ASC, id ASC;

-- name: ResolveInboxByConflict :exec
UPDATE memory_inbox
SET resolved = 1
WHERE conflict_id = ?;

-- name: ResolveInboxByProposal :exec
UPDATE memory_inbox
SET resolved = 1
WHERE proposal_id = ?;

-- name: InsertDreamProposal :exec
INSERT INTO memory_dreams (
    proposal_id, scope_id, base_version, candidate_version, deduplicated_count,
    summary, status, runner_session_id, previous_active_version, created_at_ms, resolved_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0);

-- name: GetDreamProposal :one
SELECT scope_id, previous_active_version,
       proposal_id, base_version, candidate_version, deduplicated_count, summary, status, created_at_ms
FROM memory_dreams
WHERE proposal_id = ?;

-- name: ListDreamProposalsByScope :many
SELECT proposal_id, base_version, candidate_version, deduplicated_count, summary, status, created_at_ms
FROM memory_dreams
WHERE scope_id = ?
ORDER BY created_at_ms DESC, candidate_version DESC;

-- name: ApproveDreamProposal :exec
UPDATE memory_dreams
SET status = ?, previous_active_version = ?, resolved_at_ms = ?
WHERE proposal_id = ?;

-- name: UpdateDreamProposalStatus :exec
UPDATE memory_dreams
SET status = ?, resolved_at_ms = ?
WHERE proposal_id = ?;
