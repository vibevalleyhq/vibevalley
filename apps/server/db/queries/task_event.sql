-- What happened to each task graph (task/task.ts).

-- name: AddGraphEvent :exec
insert into task_event (id, graph_id, task_id, kind, actor, payload, created_at)
values (sqlc.arg(id), sqlc.arg(graph_id), sqlc.narg(task_id), sqlc.arg(kind), sqlc.arg(actor), sqlc.arg(payload), sqlc.arg(created_at));

-- name: GraphEvents :many
select * from task_event where graph_id = sqlc.arg(graph_id) order by id limit sqlc.arg(n)::int;
