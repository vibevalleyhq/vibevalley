-- name: AddExecution :one
insert into issue_assignment_execution (assignment, executor_kind, executor, started_at)
values (sqlc.arg(assignment), sqlc.arg(executor_kind), sqlc.arg(executor), sqlc.arg(started_at))
on conflict (assignment, executor_kind, executor) do update set assignment = issue_assignment_execution.assignment
returning *;

-- name: AllExecutions :many
-- bound: execution contexts retained with each responsibility assignment.
select issue_assignment_execution.*, issue_assignment.issue from issue_assignment_execution
join issue_assignment on issue_assignment.id = issue_assignment_execution.assignment
order by started_at, executor;
