-- Runs: one go at the work each (session/runs.go).

-- name: StartRun :exec
insert into session_run (id, session, issue, triggered_by, started_at) values (?, ?, ?, ?, ?);

-- name: HeardInRun :exec
update session_run set heard = ? where id = ?;

-- name: EndRun :exec
update session_run set ended_at = ?, outcome = ?, summary = ?, spent = ? where id = ?;

-- name: OpenRuns :many
-- What a restart finds still going: those runs stopped with the server.
select * from session_run where ended_at is null order by id;

-- name: RunsOfIssue :many
select * from session_run where issue = ? order by started_at, id;

-- name: RunsOfSession :many
select * from session_run where session = ? order by id;

-- name: RunsOfEndedSessions :many
select * from session_run where session in (select id from session where ended_at is not null) order by session, id;
