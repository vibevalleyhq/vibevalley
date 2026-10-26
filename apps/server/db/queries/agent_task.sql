-- An agent's own tasks (agent/brain/agentTaskStore.ts): the keeper is whoever keeps them, a session id or the orchestrator.

-- name: OpenAgentTasks :many
select * from agent_task where keeper = sqlc.arg(keeper) and finished_at is null order by position;

-- name: ClearOpenAgentTasks :exec
delete from agent_task where keeper = sqlc.arg(keeper) and finished_at is null;

-- name: AddAgentTask :exec
insert into agent_task (graph, keeper, id, position, title, brief, after, executor, state, result, tries, updated_at)
values (sqlc.arg(graph), sqlc.arg(keeper), sqlc.arg(id), sqlc.arg(position), sqlc.arg(title), sqlc.arg(brief), sqlc.arg(after), sqlc.arg(executor),
        sqlc.arg(state), sqlc.arg(result), sqlc.arg(tries), sqlc.arg(updated_at));

-- name: FinishAgentTasks :exec
update agent_task set finished_at = sqlc.arg(finished_at) where keeper = sqlc.arg(keeper) and finished_at is null;
