-- name: ListSessions :many
SELECT s.id, s.controller, s.role, s.name, s.profile, s.runtime, s.brief, s.cwd, s.policy, s.bindings, s.hired_at, s.runs, s.last_run, s.spent, s.tool_connections, s.machine, s.phase, a.summary AS subagents
FROM session AS s
LEFT JOIN session_run_subagents AS a ON a.run = (
  SELECT r.id FROM session_run AS r WHERE r.session = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
) WHERE s.departed = 0 ORDER BY s.hired_at, s.id;

-- name: GetPastSession :one
SELECT s.id, s.controller, s.role, s.name, s.profile, s.runtime, s.brief, s.cwd, s.policy, s.bindings, s.hired_at, s.runs, s.last_run, s.spent, s.tool_connections, s.machine, s.phase, a.summary AS subagents
FROM session AS s
LEFT JOIN session_run_subagents AS a ON a.run = (
  SELECT r.id FROM session_run AS r WHERE r.session = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
) WHERE s.id = ?1 AND s.departed = 1;

-- name: PutSession :exec
INSERT INTO session (id, controller, role, name, profile, runtime, brief, cwd, policy, bindings, hired_at, runs, last_run, spent, tool_connections, machine, phase, departed)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
ON CONFLICT(id) DO UPDATE SET
  controller = excluded.controller,
  role = excluded.role,
  name = excluded.name,
  profile = excluded.profile,
  runtime = excluded.runtime,
  brief = excluded.brief,
  cwd = excluded.cwd,
  policy = excluded.policy,
  bindings = excluded.bindings,
  hired_at = excluded.hired_at,
  runs = excluded.runs,
  last_run = excluded.last_run,
  spent = excluded.spent,
  tool_connections = excluded.tool_connections,
  machine = excluded.machine,
  phase = excluded.phase,
  departed = excluded.departed;

-- name: GetSessionConfig :one
SELECT title, model, effort, permission_mode FROM session WHERE id = ?1;

-- name: PutSessionConfig :exec
UPDATE session SET title = ?2, model = ?3, effort = ?4, permission_mode = ?5 WHERE id = ?1;

-- name: PutSubagents :exec
INSERT INTO session_run_subagents (run, summary) VALUES (?1, ?2) ON CONFLICT(run) DO UPDATE SET summary = excluded.summary;

-- name: ListSessionExtras :many
SELECT session, agent_session, base, run FROM session_extra;

-- name: PutSessionExtra :exec
INSERT OR REPLACE INTO session_extra (session, agent_session, base, run)
VALUES (?1, ?2, ?3, ?4);

-- name: DeleteSessionExtra :exec
DELETE FROM session_extra WHERE session = ?1;

-- name: GetRun :one
SELECT r.id, r.session, r.issue, r.triggered_by, r.heard, r.started_at, r.ended_at, r.outcome, r.summary, r.spent, a.summary AS subagents, d.doc_kind AS reconciliation
FROM session_run AS r
LEFT JOIN session_run_subagents AS a ON a.run = r.id
LEFT JOIN durable_document AS d ON d.scope_kind = 'run' AND d.scope_id = r.id AND d.doc_kind = 'workspace.reconciliation' WHERE r.id = ?1;

-- name: ListRuns :many
SELECT r.id, r.session, r.issue, r.triggered_by, r.heard, r.started_at, r.ended_at, r.outcome, r.summary, r.spent, a.summary AS subagents, d.doc_kind AS reconciliation
FROM session_run AS r
LEFT JOIN session_run_subagents AS a ON a.run = r.id
LEFT JOIN durable_document AS d ON d.scope_kind = 'run' AND d.scope_id = r.id AND d.doc_kind = 'workspace.reconciliation' WHERE r.issue = ?1 ORDER BY r.started_at, CAST(substr(r.id, 2) AS INTEGER);

-- name: PutRun :exec
INSERT OR REPLACE INTO session_run (id, session, issue, triggered_by, heard, started_at, ended_at, outcome, summary, spent)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);

-- name: ReadSessionCounter :one
SELECT last_number FROM session_counter WHERE name = ?1;

-- name: WriteSessionCounter :exec
INSERT OR REPLACE INTO session_counter (name, last_number)
VALUES (?1, ?2);

-- name: ClearSessionRun :exec
UPDATE session_extra SET run = NULL WHERE session = ?1 AND run = ?2;

-- name: FindActiveRun :one
SELECT COUNT(*) AS active FROM session_extra WHERE session = ?1 AND run = ?2 AND agent_session = ?3;

-- name: InsertMailbox :exec
INSERT OR IGNORE INTO session_mailbox (session_id, idempotency_key, source, payload, status, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5);

-- name: GetMailboxByKey :one
SELECT id, session_id, idempotency_key, source, payload, status, created_at, updated_at, result
FROM session_mailbox WHERE idempotency_key = ?1;

-- name: NextPendingMailbox :one
SELECT id, session_id, idempotency_key, source, payload, status, created_at, updated_at, result
FROM session_mailbox WHERE session_id = ?1 AND status = 'pending' ORDER BY id ASC LIMIT 1;

-- name: ClaimMailbox :execrows
UPDATE session_mailbox SET status = 'claimed', updated_at = ?2 WHERE id = ?1 AND status = 'pending';

-- name: ClaimMailboxByKey :execrows
UPDATE session_mailbox SET status = 'claimed', updated_at = ?2 WHERE idempotency_key = ?1 AND status = 'pending';

-- name: WithdrawMailbox :execrows
UPDATE session_mailbox SET status = 'withdrawn', updated_at = ?2 WHERE idempotency_key = ?1 AND status = 'pending';

-- name: SettleMailbox :exec
UPDATE session_mailbox SET status = ?2, result = ?3, updated_at = ?4 WHERE id = ?1;

-- name: ListMailbox :many
SELECT id, session_id, idempotency_key, source, payload, status, created_at, updated_at, result
FROM session_mailbox WHERE session_id = ?1 ORDER BY id ASC;

-- name: UpsertSessionEvent :exec
INSERT INTO session_event (session_id, seq, run_id, payload)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(session_id, seq) DO UPDATE SET
  run_id = COALESCE(excluded.run_id, session_event.run_id),
  payload = excluded.payload;

-- name: DeleteSessionEvents :exec
DELETE FROM session_event WHERE session_id = ?1;

-- name: MaxSessionEventSeq :one
SELECT CAST(COALESCE(MAX(seq), -1) AS INTEGER) AS max_seq FROM session_event WHERE session_id = ?1;

-- name: ListSessionEventsTail :many
SELECT seq, payload FROM session_event
WHERE session_id = cast(sqlc.arg(session_id) as text)
  AND (cast(sqlc.arg(run_id) as text) = '' OR run_id = cast(sqlc.arg(run_id) as text))
ORDER BY seq DESC
LIMIT cast(sqlc.arg(limit) as integer);

-- name: ListSessionEventsBefore :many
SELECT seq, payload FROM session_event
WHERE session_id = cast(sqlc.arg(session_id) as text)
  AND (cast(sqlc.arg(run_id) as text) = '' OR run_id = cast(sqlc.arg(run_id) as text))
  AND seq < cast(sqlc.arg(before_seq) as integer)
ORDER BY seq DESC
LIMIT cast(sqlc.arg(limit) as integer);

-- name: ListSessionEventsAfter :many
SELECT seq, payload FROM session_event
WHERE session_id = cast(sqlc.arg(session_id) as text)
  AND (cast(sqlc.arg(run_id) as text) = '' OR run_id = cast(sqlc.arg(run_id) as text))
  AND seq > cast(sqlc.arg(after_seq) as integer)
ORDER BY seq ASC
LIMIT cast(sqlc.arg(limit) as integer);
