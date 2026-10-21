-- Runs: one go at the work each (session/runs.ts).

-- name: StartRun :exec
insert into session_run (id, session, issue, triggered_by, started_at)
values (sqlc.arg(id), sqlc.arg(session), sqlc.narg(issue), sqlc.arg(triggered_by), sqlc.arg(started_at));

-- name: HeardInRun :exec
update session_run set heard = sqlc.arg(heard) where id = sqlc.arg(id);

-- name: EndRun :exec
update session_run set ended_at = sqlc.arg(ended_at), outcome = sqlc.arg(outcome), summary = sqlc.narg(summary), spent = sqlc.narg(spent) where id = sqlc.arg(id);

-- name: OpenRuns :many
-- What a restart finds still going: those runs stopped with the server.
select * from session_run where ended_at is null order by id;

-- name: RunsOfIssue :many
select * from session_run
where session_run.issue = sqlc.arg(issue_id) or session_run.id in (select run from session_run_issue where session_run_issue.issue = sqlc.arg(issue_id))
order by started_at, id;

-- name: RunsOfSession :many
select * from session_run where session = sqlc.arg(session) order by id;

-- name: RunsOfEndedSessions :many
select * from session_run where session in (select id from session where ended_at is not null) order by session, id;
