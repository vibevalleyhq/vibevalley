-- name: OpenGraphTasks :many
select * from task_graph where owner = ? and finished_at is null order by position;

-- name: ClearOpenGraphTasks :exec
delete from task_graph where owner = ? and finished_at is null;

-- name: AddGraphTask :exec
insert into task_graph (graph, owner, id, position, title, brief, after, executor, state, result, tries, updated_at)
values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: FinishGraphTasks :exec
update task_graph set finished_at = ? where owner = ? and finished_at is null;
