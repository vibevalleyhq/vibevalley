-- Every session, on the farm or ended (session/records.go).

-- name: KeepSession :exec
insert into session (id, agent, name, runtime, task, project, issue, playbook, hired_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict (id) do nothing;

-- name: EndSession :exec
update session set ended_at = ?, closed = ? where id = ?;

-- name: SessionByID :one
select * from session where id = ?;

-- name: EndedSessions :many
-- Newest first; agent '' is every agent's.
select * from session where ended_at is not null and (sqlc.arg(agent) = '' or agent = sqlc.arg(agent)) order by hired_at desc;

-- name: SessionsEndedBefore :many
select id from session where ended_at < ?;

-- name: MoveHead :exec
-- A head from before the table, as it was: its end too.
insert into session (id, agent, name, runtime, task, project, issue, playbook, hired_at, ended_at, closed)
values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing;
