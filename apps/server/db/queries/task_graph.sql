-- An agent's own task graph (task/store.ts): an owner is whoever keeps it, a session id or the manager.

-- name: OpenGraphTasks :many
select * from task_graph where owner = sqlc.arg(owner) and finished_at is null order by position;

-- name: ClearOpenGraphTasks :exec
delete from task_graph where owner = sqlc.arg(owner) and finished_at is null;

-- name: AddGraphTask :exec
insert into task_graph (graph, owner, id, position, title, brief, after, executor, state, result, tries, updated_at)
values (sqlc.arg(graph), sqlc.arg(owner), sqlc.arg(id), sqlc.arg(position), sqlc.arg(title), sqlc.arg(brief), sqlc.arg(after), sqlc.arg(executor),
        sqlc.arg(state), sqlc.arg(result), sqlc.arg(tries), sqlc.arg(updated_at));

-- name: FinishGraphTasks :exec
update task_graph set finished_at = sqlc.arg(finished_at) where owner = sqlc.arg(owner) and finished_at is null;
