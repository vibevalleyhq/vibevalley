-- Runs: one go at the work each (session/runs.ts).

-- name: StartRun :exec
insert into session_run (id, session, issue, triggered_by, started_at)
values (sqlc.arg(id), sqlc.arg(session), sqlc.narg(issue), sqlc.arg(triggered_by), sqlc.arg(started_at));

-- name: HeardInRun :exec
update session_run set heard = sqlc.arg(heard) where id = sqlc.arg(id);

-- name: EndRun :exec
update session_run set ended_at = sqlc.arg(ended_at), outcome = sqlc.arg(outcome), summary = sqlc.narg(summary), spent = sqlc.narg(spent) where id = sqlc.arg(id);

-- name: OpenRuns :many
-- bound: only runs still going, at most one per session.
-- What a restart finds still going: those runs stopped with the server.
select * from session_run where ended_at is null order by id;

-- name: RunsOfSession :many
-- bound: one session's runs.
select * from session_run where session = sqlc.arg(session) order by id;

-- name: RunsOfSessions :many
-- bound: the runs of the sessions given, which a list takes limited.
select * from session_run where session in (select unnest(sqlc.arg(sessions)::text[])) order by session, id;
