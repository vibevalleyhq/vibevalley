-- name: LinkRunIssue :exec
insert into session_run_issue (run, issue) values (?, ?) on conflict do nothing;

-- name: RunIssues :many
select issue from session_run_issue where run = ? order by issue;
