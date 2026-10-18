-- What happened to each task graph (task/log.go).

-- name: AddGraphEvent :exec
insert into task_event (id, graph_id, task_id, kind, actor, payload, created_at) values (?, ?, ?, ?, ?, ?, ?);

-- name: GraphEvents :many
select * from task_event where graph_id = ? order by id limit ?;
