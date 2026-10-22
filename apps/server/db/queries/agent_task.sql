-- An agent's own task graph (agent/brain/taskStore.ts): an owner is whoever keeps it, a session id or the orchestrator.

-- name: OpenGraphTasks :many
select * from agent_task where owner = sqlc.arg(owner) and finished_at is null order by position;

-- name: ClearOpenGraphTasks :exec
delete from agent_task where owner = sqlc.arg(owner) and finished_at is null;

-- name: AddGraphTask :exec
insert into agent_task (graph, owner, id, position, title, brief, after, executor, state, result, tries, updated_at)
values (sqlc.arg(graph), sqlc.arg(owner), sqlc.arg(id), sqlc.arg(position), sqlc.arg(title), sqlc.arg(brief), sqlc.arg(after), sqlc.arg(executor),
        sqlc.arg(state), sqlc.arg(result), sqlc.arg(tries), sqlc.arg(updated_at));

-- name: FinishGraphTasks :exec
update agent_task set finished_at = sqlc.arg(finished_at) where owner = sqlc.arg(owner) and finished_at is null;
