-- The runs that took an issue's inputs (issue/intake.ts), as the sessions told it: an in-process agent's one run can take several.

-- name: LinkRunIssue :exec
insert into issue_run (run, issue) values (sqlc.arg(run), sqlc.arg(issue)) on conflict do nothing;

-- name: RunIssues :many
-- bound: one run's issues.
select issue from issue_run where run = sqlc.arg(run) order by issue;

-- name: RunsOfIssue :many
-- bound: one issue's runs.
select * from session_run
where session_run.issue = sqlc.arg(issue_id) or session_run.id in (select run from issue_run where issue_run.issue = sqlc.arg(issue_id))
order by started_at, id;
