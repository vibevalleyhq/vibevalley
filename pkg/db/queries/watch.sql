-- name: GetCursor :one
SELECT last_global_seq
FROM watch_cursor
WHERE id = 'default';

-- name: UpsertCursor :exec
INSERT INTO watch_cursor (id, last_global_seq, updated_at_ms)
VALUES ('default', ?, ?)
ON CONFLICT (id) DO UPDATE SET
    last_global_seq = CASE WHEN excluded.last_global_seq > watch_cursor.last_global_seq THEN excluded.last_global_seq ELSE watch_cursor.last_global_seq END,
    updated_at_ms = excluded.updated_at_ms;

-- name: GetSeatActive :one
SELECT active
FROM watch_seat
WHERE channel_id = ? AND agent_id = ?;

-- name: CountActiveChannelWorkers :one
SELECT CAST(COUNT(*) AS INTEGER) AS count
FROM watch_seat
WHERE channel_id = ? AND active = 1 AND role = 'worker';

-- name: CountActiveWorkers :one
SELECT CAST(COUNT(*) AS INTEGER) AS count
FROM watch_seat
WHERE active = 1 AND role = 'worker';

-- name: UpsertSeat :exec
INSERT INTO watch_seat (
    channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (channel_id, agent_id) DO UPDATE SET
    role = excluded.role,
    conversation_id = excluded.conversation_id,
    session_id = excluded.session_id,
    thread_owner = excluded.thread_owner,
    home_channel_id = excluded.home_channel_id,
    active = excluded.active,
    seated_at_ms = excluded.seated_at_ms;

-- name: UpsertAgentHome :exec
INSERT INTO watch_agent_home (agent_id, channel_id)
VALUES (?, ?)
ON CONFLICT (agent_id) DO UPDATE SET channel_id = excluded.channel_id;

-- name: VacateSeat :exec
UPDATE watch_seat
SET active = 0
WHERE channel_id = ? AND agent_id = ?;

-- name: GetSeat :one
SELECT
    channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
FROM watch_seat
WHERE channel_id = ? AND agent_id = ?;

-- name: ListWatchSeats :many
SELECT
    channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
FROM watch_seat
WHERE active = 1
ORDER BY channel_id ASC, agent_id ASC;

-- name: ListWatchSeatsByChannel :many
SELECT
    channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
FROM watch_seat
WHERE channel_id = ? AND active = 1
ORDER BY channel_id ASC, agent_id ASC;

-- name: GetAgentHome :one
SELECT channel_id
FROM watch_agent_home
WHERE agent_id = ?;

-- name: GetBrakeState :one
SELECT state_json
FROM watch_brake_state
WHERE id = 'default';

-- name: UpsertBrakeState :exec
INSERT INTO watch_brake_state (id, state_json)
VALUES ('default', ?)
ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json;

-- name: UpsertInbox :exec
INSERT INTO watch_inbox (
    id, kind, title, summary, session_id, issue_id, resolved, channel_id, event_seq, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    kind = excluded.kind,
    title = excluded.title,
    summary = excluded.summary,
    session_id = excluded.session_id,
    issue_id = excluded.issue_id,
    resolved = CASE WHEN watch_inbox.resolved = 1 THEN 1 ELSE excluded.resolved END,
    channel_id = CASE WHEN excluded.channel_id <> '' THEN excluded.channel_id ELSE watch_inbox.channel_id END,
    event_seq = CASE WHEN excluded.event_seq > 0 THEN excluded.event_seq ELSE watch_inbox.event_seq END;

-- name: ResolveInbox :execrows
UPDATE watch_inbox
SET resolved = 1
WHERE id = ?;

-- name: ResolveChannelInboxUpTo :exec
UPDATE watch_inbox
SET resolved = 1
WHERE channel_id = ? AND event_seq > 0 AND event_seq <= ? AND resolved = 0;

-- name: ListWatchInbox :many
SELECT id, kind, title, summary, session_id, issue_id, resolved, created_at_ms
FROM watch_inbox
ORDER BY created_at_ms ASC, id ASC;

-- name: ListUnresolvedWatchInbox :many
SELECT id, kind, title, summary, session_id, issue_id, resolved, created_at_ms
FROM watch_inbox
WHERE resolved = 0
ORDER BY created_at_ms ASC, id ASC;
