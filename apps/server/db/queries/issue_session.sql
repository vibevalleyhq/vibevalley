-- The sessions that worked each issue, oldest first (issue/issue.ts).

-- name: AddSession :exec
insert into issue_session (session, issue, started_at) values (sqlc.arg(session), sqlc.arg(issue), sqlc.arg(started_at)) on conflict (session) do nothing;

-- name: LastAssigneeIn :one
-- Who was last sent to work in a project: who drafts an issue that names no one.
select issue.assignee from issue_session join issue on issue.id = issue_session.issue
where issue.project = sqlc.arg(project) and issue.assignee is not null
order by issue_session.started_at desc, issue_session.session desc limit 1;

-- name: IssueOfSession :one
select issue from issue_session where session = sqlc.arg(session);

-- name: AllSessions :many
select issue, session from issue_session order by started_at, session;

-- name: SessionsOf :many
select session from issue_session where issue = sqlc.arg(issue) order by started_at, session;

-- name: SessionsOfKept :many
with latest as (select id from issue where parent is null and closed_at is not null order by closed_at desc limit sqlc.arg(closed)::int)
select issue_session.issue, issue_session.session from issue_session
where issue_session.issue in (
  select id from issue
  where closed_at is null or id in (select id from latest) or parent in (select id from latest)
     or parent in (select id from issue where closed_at is null))
order by issue_session.started_at, issue_session.session;

-- name: SessionsOfFamily :many
select issue_session.issue, issue_session.session from issue_session
where issue_session.issue in (select id from issue where id = sqlc.arg(id) or parent = sqlc.arg(id))
order by issue_session.started_at, issue_session.session;
