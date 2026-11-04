-- name: AddExecution :one
insert into issue_assignment_execution (assignment, executor, started_at)
values (sqlc.arg(assignment), sqlc.arg(executor), sqlc.arg(started_at))
on conflict (assignment, executor) do update set assignment = issue_assignment_execution.assignment
returning *, (select session.role from session where session.id = issue_assignment_execution.executor)::session.role as role;

-- name: AllExecutions :many
-- bound: execution contexts retained with each responsibility assignment.
select issue_assignment_execution.*, issue_assignment.issue, session.role from issue_assignment_execution
join issue_assignment on issue_assignment.id = issue_assignment_execution.assignment
join session on session.id = issue_assignment_execution.executor
order by started_at, executor;
