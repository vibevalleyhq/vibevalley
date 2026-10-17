-- Runs: one go at the work each (worker/runs.go).

-- name: StartRun :execlastid
insert into run (worker, issue, triggered_by, started_at) values (?, ?, ?, ?);

-- name: HeardInRun :exec
update run set heard = ? where id = ?;

-- name: EndRun :exec
update run set ended_at = ?, outcome = ?, summary = ?, spent = ? where id = ?;

-- name: OpenRuns :many
-- What a restart finds still going: those runs stopped with the server.
select * from run where ended_at is null order by id;

-- name: RunsOfIssue :many
select * from run where issue = ? order by started_at, id;
