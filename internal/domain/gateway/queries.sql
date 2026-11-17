-- name: UpsertGatewayKV :exec
INSERT INTO gateway_kv (key, value_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;

-- name: ListGatewayKV :many
SELECT key, value_json, updated_at
FROM gateway_kv
ORDER BY key ASC;

-- name: DeleteGatewayKV :exec
DELETE FROM gateway_kv WHERE key = ?;

-- name: UpsertGatewayIssue :exec
INSERT INTO gateway_issue (id, identifier, status, updated_at, payload_json)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    identifier = excluded.identifier,
    status = excluded.status,
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayIssues :many
SELECT id, identifier, status, updated_at, payload_json
FROM gateway_issue
ORDER BY id ASC;

-- name: DeleteGatewayIssue :exec
DELETE FROM gateway_issue WHERE id = ?;

-- name: UpsertGatewayChannel :exec
INSERT INTO gateway_channel (id, kind, updated_at, payload_json)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayChannels :many
SELECT id, kind, updated_at, payload_json
FROM gateway_channel
ORDER BY id ASC;

-- name: DeleteGatewayChannel :exec
DELETE FROM gateway_channel WHERE id = ?;

-- name: UpsertGatewayAgent :exec
INSERT INTO gateway_agent (id, name, updated_at, payload_json)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayAgents :many
SELECT id, name, updated_at, payload_json
FROM gateway_agent
ORDER BY id ASC;

-- name: DeleteGatewayAgent :exec
DELETE FROM gateway_agent WHERE id = ?;

-- name: UpsertGatewayTemplate :exec
INSERT INTO gateway_template (id, updated_at, payload_json)
VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayTemplates :many
SELECT id, updated_at, payload_json
FROM gateway_template
ORDER BY id ASC;

-- name: DeleteGatewayTemplate :exec
DELETE FROM gateway_template WHERE id = ?;

-- name: UpsertGatewayRuntime :exec
INSERT INTO gateway_runtime (id, updated_at, payload_json)
VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayRuntimes :many
SELECT id, updated_at, payload_json
FROM gateway_runtime
ORDER BY id ASC;

-- name: DeleteGatewayRuntime :exec
DELETE FROM gateway_runtime WHERE id = ?;

-- name: UpsertGatewayCron :exec
INSERT INTO gateway_cron (id, enabled, next_run_at, updated_at, payload_json)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    enabled = excluded.enabled,
    next_run_at = excluded.next_run_at,
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayCrons :many
SELECT id, enabled, next_run_at, updated_at, payload_json
FROM gateway_cron
ORDER BY id ASC;

-- name: DeleteGatewayCron :exec
DELETE FROM gateway_cron WHERE id = ?;

-- name: UpsertGatewayArtifact :exec
INSERT INTO gateway_artifact (id, kind, updated_at, payload_json)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayArtifacts :many
SELECT id, kind, updated_at, payload_json
FROM gateway_artifact
ORDER BY id ASC;

-- name: DeleteGatewayArtifact :exec
DELETE FROM gateway_artifact WHERE id = ?;

-- name: UpsertGatewayLibraryItem :exec
INSERT INTO gateway_library_item (id, kind, created_at, payload_json)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    created_at = excluded.created_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayLibraryItems :many
SELECT id, kind, created_at, payload_json
FROM gateway_library_item
ORDER BY created_at DESC, id ASC;

-- name: DeleteGatewayLibraryItem :exec
DELETE FROM gateway_library_item WHERE id = ?;

-- name: UpsertGatewayMediaInput :exec
INSERT INTO gateway_media_input (id, mime_type, byte_size, blob_path, expires_at, created_at, payload_json)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    mime_type = excluded.mime_type,
    byte_size = excluded.byte_size,
    blob_path = excluded.blob_path,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    payload_json = excluded.payload_json;

-- name: GetGatewayMediaInput :one
SELECT id, mime_type, byte_size, blob_path, expires_at, created_at, payload_json
FROM gateway_media_input
WHERE id = ?;

-- name: ListGatewayMediaInputs :many
SELECT id, mime_type, byte_size, blob_path, expires_at, created_at, payload_json
FROM gateway_media_input
ORDER BY created_at DESC, id ASC;

-- name: DeleteGatewayMediaInput :exec
DELETE FROM gateway_media_input WHERE id = ?;

-- name: UpsertGatewayMediaJob :exec
INSERT INTO gateway_media_job (id, kind, status, created_at, payload_json)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    status = excluded.status,
    created_at = excluded.created_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayMediaJobs :many
SELECT id, kind, status, created_at, payload_json
FROM gateway_media_job
ORDER BY created_at ASC, id ASC;

-- name: DeleteGatewayMediaJob :exec
DELETE FROM gateway_media_job WHERE id = ?;

-- name: UpsertGatewayPKMPage :exec
INSERT INTO gateway_pkm_page (path, updated_at, payload_json)
VALUES (?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayPKMPages :many
SELECT path, updated_at, payload_json
FROM gateway_pkm_page
ORDER BY path ASC;

-- name: DeleteGatewayPKMPage :exec
DELETE FROM gateway_pkm_page WHERE path = ?;

-- name: UpsertGatewayPKMComment :exec
INSERT INTO gateway_pkm_comment (id, page_path, created_at, payload_json)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    page_path = excluded.page_path,
    created_at = excluded.created_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayPKMComments :many
SELECT id, page_path, created_at, payload_json
FROM gateway_pkm_comment
ORDER BY created_at ASC, id ASC;

-- name: DeleteGatewayPKMComment :exec
DELETE FROM gateway_pkm_comment WHERE id = ?;

-- name: UpsertGatewayPKMClip :exec
INSERT INTO gateway_pkm_clip (id, created_at, payload_json)
VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    created_at = excluded.created_at,
    payload_json = excluded.payload_json;

-- name: ListGatewayPKMClips :many
SELECT id, created_at, payload_json
FROM gateway_pkm_clip
ORDER BY id ASC;

-- name: DeleteGatewayPKMClip :exec
DELETE FROM gateway_pkm_clip WHERE id = ?;

-- name: UpsertGatewaySession :exec
INSERT INTO gateway_session (id, issue_id, status, updated_at, payload_json)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    issue_id = excluded.issue_id,
    status = excluded.status,
    updated_at = excluded.updated_at,
    payload_json = excluded.payload_json;

-- name: ListGatewaySessions :many
SELECT id, issue_id, status, updated_at, payload_json
FROM gateway_session
ORDER BY id ASC;

-- name: DeleteGatewaySession :exec
DELETE FROM gateway_session WHERE id = ?;

-- name: UpsertGatewaySessionEvent :exec
INSERT INTO gateway_session_event (session_id, seq, created_at, payload_json)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id, seq) DO UPDATE SET
    created_at = excluded.created_at,
    payload_json = excluded.payload_json;

-- name: ListGatewaySessionEvents :many
SELECT session_id, seq, created_at, payload_json
FROM gateway_session_event
ORDER BY session_id ASC, seq ASC;

-- name: DeleteGatewaySessionEventsBySession :exec
DELETE FROM gateway_session_event WHERE session_id = ?;

-- name: UpsertGatewayRequestKey :exec
INSERT INTO gateway_request_key (scope_key, created_at, response_json)
VALUES (?, ?, ?)
ON CONFLICT(scope_key) DO UPDATE SET
    created_at = excluded.created_at,
    response_json = excluded.response_json;

-- name: ListGatewayRequestKeys :many
SELECT scope_key, created_at, response_json
FROM gateway_request_key
ORDER BY scope_key ASC;

-- name: DeleteGatewayRequestKey :exec
DELETE FROM gateway_request_key WHERE scope_key = ?;
