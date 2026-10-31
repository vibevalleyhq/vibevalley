-- The agents' own todos (runtime/todoStore.ts): the keeper is whoever keeps them, a session id or the orchestrator.

-- name: OpenTodos :many
select * from runtime_todo where keeper = sqlc.arg(keeper) and finished_at is null order by position;

-- name: ClearOpenTodos :exec
delete from runtime_todo where keeper = sqlc.arg(keeper) and finished_at is null;

-- name: AddTodo :exec
insert into runtime_todo (graph, keeper, id, position, title, brief, after, executor, state, result, tries, updated_at)
values (sqlc.arg(graph), sqlc.arg(keeper), sqlc.arg(id), sqlc.arg(position), sqlc.arg(title), sqlc.arg(brief), sqlc.arg(after), sqlc.arg(executor),
        sqlc.arg(state), sqlc.arg(result), sqlc.arg(tries), sqlc.arg(updated_at));

-- name: FinishTodos :exec
update runtime_todo set finished_at = sqlc.arg(finished_at) where keeper = sqlc.arg(keeper) and finished_at is null;
