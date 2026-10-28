-- Crons (cron/cron.ts).

-- name: Crons :many
select * from cron order by id;

-- name: AddCron :exec
-- One waiting for the owner is stored off (pending).
insert into cron (id, name, body, channel_id, agent, project, spec, tz, enabled, set_by, pending, created_at)
values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(body), sqlc.arg(channel_id), sqlc.narg(agent), sqlc.narg(project), sqlc.arg(spec), sqlc.arg(tz),
        not sqlc.arg(pending)::boolean, sqlc.arg(set_by), sqlc.arg(pending), sqlc.arg(created_at));

-- name: CronRan :exec
-- Turned on is the owner's yes: it waits no more.
update cron set last_run = sqlc.arg(last_run), enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled)::boolean where id = sqlc.arg(id);

-- name: EnableCron :exec
update cron set enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled)::boolean where id = sqlc.arg(id);

-- name: RemoveCron :exec
delete from cron where id = sqlc.arg(id);
