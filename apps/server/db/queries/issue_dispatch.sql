-- name: EnqueueDispatch :exec
insert into issue_dispatch (id, issue_id, agent, channel, body, trigger_json, created_at)
values (sqlc.arg(id), sqlc.arg(issue_id), sqlc.arg(agent), sqlc.arg(channel), sqlc.arg(body), sqlc.arg(trigger_json), sqlc.arg(created_at));

-- name: PendingDispatches :many
-- bound: undelivered orchestrator assignments, removed after routing.
select * from issue_dispatch order by created_at, id;

-- name: AcknowledgeDispatch :exec
delete from issue_dispatch where id = sqlc.arg(id);

-- name: CancelDispatches :exec
delete from issue_dispatch where issue_id = sqlc.arg(issue_id);
