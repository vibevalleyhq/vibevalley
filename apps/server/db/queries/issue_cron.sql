-- Crons (issue/cron.ts).

-- name: Crons :many
-- bound: a row per cron the user or the orchestrator set.
select * from issue_cron order by id;

-- name: AddCron :exec
-- One waiting for the user is stored off (pending).
insert into issue_cron (id, name, body, channel_id, agent, repo, spec, tz, enabled, set_by, pending, created_at)
values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(body), sqlc.arg(channel_id), sqlc.narg(agent), sqlc.narg(repo), sqlc.arg(spec), sqlc.arg(tz),
        not sqlc.arg(pending)::boolean, sqlc.arg(set_by), sqlc.arg(pending), sqlc.arg(created_at));

-- name: CronRan :exec
-- Turned on is the user's yes: it waits no more.
update issue_cron set last_run = sqlc.arg(last_run), enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled)::boolean where id = sqlc.arg(id);

-- name: EnableCron :exec
update issue_cron set enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled)::boolean where id = sqlc.arg(id);

-- name: RemoveCron :exec
delete from issue_cron where id = sqlc.arg(id);
