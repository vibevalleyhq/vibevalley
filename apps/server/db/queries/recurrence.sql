-- Recurrences (recurrence/recurrence.ts).

-- name: Recurrences :many
select * from recurrence order by id;

-- name: AddRecurrence :exec
-- One waiting for the owner is stored off (pending).
insert into recurrence (id, name, body, channel_id, agent, project, spec, tz, enabled, set_by, pending, created_at)
values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(body), sqlc.arg(channel_id), sqlc.narg(agent), sqlc.narg(project), sqlc.arg(spec), sqlc.arg(tz),
        not sqlc.arg(pending)::boolean, sqlc.arg(set_by), sqlc.arg(pending), sqlc.arg(created_at));

-- name: RecurrenceRan :exec
-- Turned on is the owner's yes: it waits no more.
update recurrence set last_run = sqlc.arg(last_run), enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled)::boolean where id = sqlc.arg(id);

-- name: EnableRecurrence :exec
update recurrence set enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled)::boolean where id = sqlc.arg(id);

-- name: RemoveRecurrence :exec
delete from recurrence where id = sqlc.arg(id);
