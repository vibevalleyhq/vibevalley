-- name: AddAssignment :one
-- Repeating the current responsibility preserves its identity and first assignment time.
insert into issue_assignment (id, issue, agent, assigned_at)
values (sqlc.arg(id), sqlc.arg(issue), sqlc.arg(agent), sqlc.arg(assigned_at))
on conflict (issue) where ended_at is null do update set id = issue_assignment.id
returning *;

-- name: EndAssignments :many
-- bound: at most one current assignment per issue.
update issue_assignment set ended_at = sqlc.arg(ended_at)
where issue = sqlc.arg(issue) and ended_at is null and (sqlc.narg(agent)::text is null or agent <> sqlc.narg(agent))
returning *;

-- name: LastAssigneeIn :one
-- Who actually worked in a project, even after the issue was assigned to another profile.
select issue_assignment.agent from issue_assignment
join issue on issue.id = issue_assignment.issue
join issue_assignment_execution on issue_assignment_execution.assignment = issue_assignment.id
join session on session.id = issue_assignment_execution.executor
where issue.project = sqlc.arg(project) and session.role = 'worker'
order by issue_assignment_execution.started_at desc, issue_assignment_execution.executor desc limit 1;

-- name: AllAssignments :many
-- bound: responsibility history retained with each issue.
select * from issue_assignment order by assigned_at, id;
