-- Schedules (schedule/schedule.go).

-- name: Schedules :many
select * from schedule order by id;

-- name: AddSchedule :exec
-- One waiting for the owner is stored off (pending).
insert into schedule (id, name, body, channel_id, agent, project, spec, tz, enabled, by, pending, created_at)
values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(body), sqlc.arg(channel_id), sqlc.arg(agent), sqlc.arg(project), sqlc.arg(spec), sqlc.arg(tz),
        not sqlc.arg(pending), sqlc.arg(by), sqlc.arg(pending), sqlc.arg(created_at));

-- name: ScheduleRan :exec
-- Turned on is the owner's yes: it waits no more.
update schedule set last_run = sqlc.arg(last_run), enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled) where id = sqlc.arg(id);

-- name: EnableSchedule :exec
update schedule set enabled = sqlc.arg(enabled), pending = pending and not sqlc.arg(enabled) where id = sqlc.arg(id);

-- name: RemoveSchedule :exec
delete from schedule where id = ?;
