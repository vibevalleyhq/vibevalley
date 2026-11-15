-- The runs that took an issue's inputs (issue/intake.ts), as the sessions told it: an in-process agent's one run can take several.

-- name: LinkRunIssue :exec
insert into issue_run (run, issue) values (sqlc.arg(run), sqlc.arg(issue)) on conflict do nothing;

-- name: RunIssues :many
-- bound: one run's issues.
select issue from issue_run where run = sqlc.arg(run) order by issue;

-- name: RunsOfIssue :many
-- bound: one issue's runs.
select distinct r.* from session_run r
left join session s on s.id = r.session
left join issue_run ir on ir.run = r.id
where (s.scope_kind in ('issue', 'draft') and s.scope_id = sqlc.arg(issue_id)) or ir.issue = sqlc.arg(issue_id)
order by r.started_at, r.id;
