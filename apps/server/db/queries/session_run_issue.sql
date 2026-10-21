-- The issues a run took (session/execution.ts): an in-process agent's one run can take several.

-- name: LinkRunIssue :exec
insert into session_run_issue (run, issue) values (sqlc.arg(run), sqlc.arg(issue)) on conflict do nothing;

-- name: RunIssues :many
select issue from session_run_issue where run = sqlc.arg(run) order by issue;
