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
-- Newest first, the newest n; agent '' is every agent's.
select * from session where ended_at is not null and (sqlc.arg(agent)::text = '' or agent = sqlc.arg(agent)) order by hired_at desc limit sqlc.arg(n)::int;

-- name: SessionsEndedBefore :many
-- bound: read to drop their trajectories, which then are gone.
select id from session where ended_at < sqlc.arg(before);

-- name: KeepHand :exec
-- What a session on the farm needs to be taken up again after a restart: where it works (JSON), its oar session, its
-- last words, the memories it was reminded of (JSON).
update session set place = sqlc.narg(place), oar_session = sqlc.narg(oar_session), last_text = sqlc.narg(last_text), recalled = sqlc.narg(recalled)
where id = sqlc.arg(id);

-- name: Hands :many
-- bound: only sessions on the farm now.
select id, place, oar_session, last_text, recalled from session where ended_at is null and place is not null;

-- name: HighestSessionNumber :one
-- The highest n of the ids w<n>, 0 for none.
select coalesce(max(substring(id from '^w([0-9]+)$')::int), 0)::int as n from session;
