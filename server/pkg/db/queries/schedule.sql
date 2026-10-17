-- Schedules (schedule/schedule.go).

-- name: Schedules :many
select * from schedule order by id;

-- name: AddSchedule :execlastid
insert into schedule (name, body, channel_id, agent, project, spec, tz, enabled, created_at) values (?, ?, ?, ?, ?, ?, ?, 1, ?);

-- name: ScheduleRan :exec
update schedule set last_run = ?, enabled = ? where id = ?;

-- name: EnableSchedule :exec
update schedule set enabled = ? where id = ?;

-- name: RemoveSchedule :exec
delete from schedule where id = ?;
