-- name: MaxGlobalSeq :one
SELECT CAST(COALESCE(MAX(global_seq), 0) AS INTEGER) AS max_global_seq
FROM channel_event;

-- name: InsertChannel :exec
INSERT INTO channel (
    id, type, name, topic, repo_id, default_agent_id, peer_id,
    parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
    created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetChannel :one
SELECT
    id, type, name, topic, repo_id, default_agent_id, peer_id,
    parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
    created_at_ms, updated_at_ms
FROM channel
WHERE id = ?;

-- name: GetThreadByIssue :one
SELECT
    id, type, name, topic, repo_id, default_agent_id, peer_id,
    parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
    created_at_ms, updated_at_ms
FROM channel
WHERE type = 'thread' AND issue_id = ?;

-- name: ListChannels :many
SELECT
    id, type, name, topic, repo_id, default_agent_id, peer_id,
    parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
    created_at_ms, updated_at_ms
FROM channel
ORDER BY created_at_ms ASC, id ASC;

-- name: AddChannelMember :exec
INSERT INTO channel_member (channel_id, member_id, added_at_ms)
VALUES (?, ?, ?)
ON CONFLICT (channel_id, member_id) DO NOTHING;

-- name: RemoveChannelMember :exec
DELETE FROM channel_member
WHERE channel_id = ? AND member_id = ?;

-- name: ListChannelMembers :many
SELECT member_id
FROM channel_member
WHERE channel_id = ?
ORDER BY member_id ASC;

-- name: ChannelExists :one
SELECT CAST(1 AS INTEGER) AS ok
FROM channel
WHERE id = ?;

-- name: GetChannelEventBySendKey :one
SELECT
    global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
    text, session_id, issue_id, mentions_json, target_agent_id, send_key,
    question_json, report_json, reaction_json, created_at_ms
FROM channel_event
WHERE channel_id = ? AND author_id = ? AND send_key = ?;

-- name: MaxChannelSeq :one
SELECT CAST(COALESCE(MAX(seq), 0) AS INTEGER) AS max_seq
FROM channel_event
WHERE channel_id = ?;

-- name: InsertChannelEvent :exec
INSERT INTO channel_event (
    global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
    text, session_id, issue_id, mentions_json, target_agent_id, send_key,
    question_json, report_json, reaction_json, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: TouchChannelUpdatedAt :exec
UPDATE channel
SET updated_at_ms = ?
WHERE id = ?;

-- name: UpsertReadCursor :exec
INSERT INTO channel_read_cursor (channel_id, actor_id, read_seq, updated_at_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT (channel_id, actor_id) DO UPDATE SET
    read_seq = CASE WHEN excluded.read_seq > channel_read_cursor.read_seq THEN excluded.read_seq ELSE channel_read_cursor.read_seq END,
    updated_at_ms = CASE WHEN excluded.read_seq > channel_read_cursor.read_seq THEN excluded.updated_at_ms ELSE channel_read_cursor.updated_at_ms END;

-- name: GetChannelEvent :one
SELECT
    global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
    text, session_id, issue_id, mentions_json, target_agent_id, send_key,
    question_json, report_json, reaction_json, created_at_ms
FROM channel_event
WHERE channel_id = ? AND seq = ?;

-- name: ListChannelEvents :many
SELECT
    global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
    text, session_id, issue_id, mentions_json, target_agent_id, send_key,
    question_json, report_json, reaction_json, created_at_ms
FROM channel_event
WHERE channel_id = ? AND seq > ?
ORDER BY seq ASC;

-- name: ListChannelEventsLimit :many
SELECT
    global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
    text, session_id, issue_id, mentions_json, target_agent_id, send_key,
    question_json, report_json, reaction_json, created_at_ms
FROM channel_event
WHERE channel_id = ? AND seq > ?
ORDER BY seq ASC
LIMIT ?;

-- name: ListEventsAfterGlobal :many
SELECT
    global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
    text, session_id, issue_id, mentions_json, target_agent_id, send_key,
    question_json, report_json, reaction_json, created_at_ms
FROM channel_event
WHERE global_seq > ?
ORDER BY global_seq ASC;

-- name: ListEventsAfterGlobalLimit :many
SELECT
    global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
    text, session_id, issue_id, mentions_json, target_agent_id, send_key,
    question_json, report_json, reaction_json, created_at_ms
FROM channel_event
WHERE global_seq > ?
ORDER BY global_seq ASC
LIMIT ?;

-- name: GetReadCursor :one
SELECT channel_id, actor_id, read_seq, updated_at_ms
FROM channel_read_cursor
WHERE channel_id = ? AND actor_id = ?;

-- name: ListReadCursors :many
SELECT channel_id, actor_id, read_seq, updated_at_ms
FROM channel_read_cursor
WHERE channel_id = ?
ORDER BY actor_id ASC;

-- name: CountUnreadEvents :one
SELECT CAST(COUNT(*) AS INTEGER) AS count
FROM channel_event
WHERE channel_id = ? AND seq > ? AND kind <> 'reaction';
