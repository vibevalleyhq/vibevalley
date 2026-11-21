-- name: ListSessions :many
SELECT s.id, s.role, s.name, s.agent, s.runtime, s.brief, s.repo, s.branch, s.worktree, s.hired_at, s.runs, s.last_run, s.spent, s.channel, s.issue, s.refining, s.tool_connections, s.machine, s.phase, a.summary AS subagents
FROM session AS s
LEFT JOIN session_run_subagents AS a ON a.run = (
  SELECT r.id FROM session_run AS r WHERE r.session = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
) WHERE s.departed = 0 ORDER BY s.hired_at, s.id;

-- name: GetPastSession :one
SELECT s.id, s.role, s.name, s.agent, s.runtime, s.brief, s.repo, s.branch, s.worktree, s.hired_at, s.runs, s.last_run, s.spent, s.channel, s.issue, s.refining, s.tool_connections, s.machine, s.phase, a.summary AS subagents
FROM session AS s
LEFT JOIN session_run_subagents AS a ON a.run = (
  SELECT r.id FROM session_run AS r WHERE r.session = s.id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
) WHERE s.id = ?1 AND s.departed = 1;

-- name: PutSession :exec
INSERT OR REPLACE INTO session (id, role, name, agent, runtime, brief, repo, branch, worktree, hired_at, runs, last_run, spent, channel, issue, refining, tool_connections, machine, phase, departed)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20);

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
LEFT JOIN durable_document AS d ON d.scope_kind = 'run' AND d.scope_id = r.id AND d.doc_kind = 'workspace.reconciliation'  WHERE r.id = ?1;

-- name: ListRuns :many
SELECT r.id, r.session, r.issue, r.triggered_by, r.heard, r.started_at, r.ended_at, r.outcome, r.summary, r.spent, a.summary AS subagents, d.doc_kind AS reconciliation
FROM session_run AS r
LEFT JOIN session_run_subagents AS a ON a.run = r.id
LEFT JOIN durable_document AS d ON d.scope_kind = 'run' AND d.scope_id = r.id AND d.doc_kind = 'workspace.reconciliation'  WHERE r.issue = ?1 ORDER BY r.started_at, CAST(substr(r.id, 2) AS INTEGER);

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
