-- name: ListSessions :many
SELECT s.id, s.controller, s.role, s.name, s.profile, s.runtime, s.brief, s.cwd, s.policy, s.bindings, s.hired_at, s.runs, s.last_run, s.spent, s.tool_connections, s.machine, s.phase,
  (SELECT r.subagent_summary FROM session_run AS r WHERE r.session = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1) AS subagents
FROM session AS s
WHERE s.departed = 0 ORDER BY s.hired_at, s.id;

-- name: GetPastSession :one
SELECT s.id, s.controller, s.role, s.name, s.profile, s.runtime, s.brief, s.cwd, s.policy, s.bindings, s.hired_at, s.runs, s.last_run, s.spent, s.tool_connections, s.machine, s.phase,
  (SELECT r.subagent_summary FROM session_run AS r WHERE r.session = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1) AS subagents
FROM session AS s
WHERE s.id = ?1 AND s.departed = 1;

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
UPDATE session_run SET subagent_summary = ?2 WHERE id = ?1;

-- name: ListSessionExtras :many
SELECT id AS session, agent_session, base, run
FROM session
WHERE agent_session IS NOT NULL OR base IS NOT NULL OR run IS NOT NULL;

-- name: PutSessionExtra :exec
UPDATE session SET agent_session = ?2, base = ?3, run = ?4 WHERE id = ?1;

-- name: DeleteSessionExtra :exec
UPDATE session SET agent_session = NULL, base = NULL, run = NULL WHERE id = ?1;

-- name: GetRun :one
SELECT r.id, r.session, r.issue, r.triggered_by, r.heard, r.started_at, r.ended_at, r.outcome, r.summary, r.spent, r.subagent_summary AS subagents, d.doc_kind AS reconciliation
FROM session_run AS r
LEFT JOIN durable_document AS d ON d.scope_kind = 'run' AND d.scope_id = r.id AND d.doc_kind = 'workspace.reconciliation' WHERE r.id = ?1;

-- name: ListRuns :many
SELECT r.id, r.session, r.issue, r.triggered_by, r.heard, r.started_at, r.ended_at, r.outcome, r.summary, r.spent, r.subagent_summary AS subagents, d.doc_kind AS reconciliation
FROM session_run AS r
LEFT JOIN durable_document AS d ON d.scope_kind = 'run' AND d.scope_id = r.id AND d.doc_kind = 'workspace.reconciliation' WHERE r.issue = ?1 ORDER BY r.started_at, CAST(substr(r.id, 2) AS INTEGER);

-- name: PutRun :exec
INSERT INTO session_run (id, session, issue, triggered_by, heard, started_at, ended_at, outcome, summary, spent)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT(id) DO UPDATE SET
  session = excluded.session,
  issue = excluded.issue,
  triggered_by = excluded.triggered_by,
  heard = excluded.heard,
  started_at = excluded.started_at,
  ended_at = excluded.ended_at,
  outcome = excluded.outcome,
  summary = excluded.summary,
  spent = excluded.spent;

-- name: ClearSessionRun :exec
UPDATE session SET run = NULL WHERE id = ?1 AND run = ?2;

-- name: FindActiveRun :one
SELECT COUNT(*) AS active FROM session WHERE id = ?1 AND run = ?2 AND agent_session = ?3;

-- name: InsertMailbox :exec
INSERT OR IGNORE INTO session_mailbox (session_id, idempotency_key, source, source_message_id, payload, status, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6);

-- name: GetMailboxByKey :one
SELECT id, session_id, idempotency_key, source, source_message_id, payload, status, created_at, updated_at, result
FROM session_mailbox WHERE idempotency_key = ?1;

-- name: NextPendingMailbox :one
SELECT id, session_id, idempotency_key, source, source_message_id, payload, status, created_at, updated_at, result
FROM session_mailbox WHERE session_id = ?1 AND status = 'pending' ORDER BY id ASC LIMIT 1;

-- name: ClaimMailbox :execrows
UPDATE session_mailbox SET status = 'claimed', updated_at = ?2 WHERE id = ?1 AND status = 'pending';

-- name: ClaimMailboxByKey :execrows
UPDATE session_mailbox SET status = 'claimed', updated_at = ?2 WHERE idempotency_key = ?1 AND status = 'pending';

-- name: WithdrawMailbox :execrows
UPDATE session_mailbox SET status = 'withdrawn', updated_at = ?2 WHERE idempotency_key = ?1 AND status = 'pending';

-- name: WithdrawMailboxByMessage :execrows
UPDATE session_mailbox SET status = 'withdrawn', updated_at = ?2 WHERE source_message_id = ?1 AND status = 'pending';

-- name: SettleMailbox :exec
UPDATE session_mailbox SET status = ?2, result = ?3, updated_at = ?4 WHERE id = ?1;

-- name: ListMailbox :many
SELECT id, session_id, idempotency_key, source, source_message_id, payload, status, created_at, updated_at, result
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
