-- The sessions that worked each issue, oldest first (issue/issue.ts).

-- name: AddSession :exec
insert into issue_session (session, issue, started_at) values (sqlc.arg(session), sqlc.arg(issue), sqlc.arg(started_at)) on conflict (session) do nothing;

-- name: LastAssigneeIn :one
-- Who was last sent to work in a project: who drafts an issue that names no one.
select issue.assignee from issue_session join issue on issue.id = issue_session.issue
where issue.project = sqlc.arg(project) and issue.assignee is not null
order by issue_session.started_at desc, issue_session.session desc limit 1;

-- name: AllSessions :many
-- bound: a row per issue and the session on it.
select issue, session from issue_session order by started_at, session;
