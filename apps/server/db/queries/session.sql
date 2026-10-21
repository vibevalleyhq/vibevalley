-- Every session, on the farm or ended (session/sessions.ts).

-- name: KeepSession :exec
insert into session (id, agent, name, runtime, brief, project, issue, graph, hired_at)
values (sqlc.arg(id), sqlc.arg(agent), sqlc.arg(name), sqlc.arg(runtime), sqlc.arg(brief), sqlc.narg(project), sqlc.narg(issue), sqlc.narg(graph), sqlc.arg(hired_at))
on conflict (id) do nothing;

-- name: EndSession :exec
update session set ended_at = sqlc.arg(ended_at), closed = sqlc.arg(closed) where id = sqlc.arg(id);

-- name: SessionByID :one
select * from session where id = sqlc.arg(id);

-- name: EndedSessions :many
-- Newest first; agent '' is every agent's.
select * from session where ended_at is not null and (sqlc.arg(agent)::text = '' or agent = sqlc.arg(agent)) order by hired_at desc;

-- name: SessionsEndedBefore :many
select id from session where ended_at < sqlc.arg(before);
