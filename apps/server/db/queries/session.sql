-- Every session, on the farm or ended (session/sessions.ts).

-- name: KeepSession :exec
insert into session (id, role, agent, name, runtime, brief, project, issue, channel, hired_at)
values (sqlc.arg(id), sqlc.arg(role), sqlc.arg(agent), sqlc.arg(name), sqlc.arg(runtime), sqlc.arg(brief), sqlc.narg(project), sqlc.narg(issue), sqlc.narg(channel), sqlc.arg(hired_at))
on conflict (id) do nothing;

-- name: ForgetSession :exec
delete from session where id = sqlc.arg(id);

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

-- name: SetPendingReport :exec
update session set pending_report = sqlc.arg(report) where id = sqlc.arg(id) and ended_at is null;

-- name: ClearPendingReport :exec
update session set pending_report = null where id = sqlc.arg(id);

-- name: HighestSessionNumber :one
-- The highest n of the ids w<n>, 0 for none.
select coalesce(max(substring(id from '^w([0-9]+)$')::int), 0)::int as n from session;

-- name: ActiveSessions :many
-- bound: all sessions retained for startup.
select * from session where ended_at is null order by hired_at, id;

-- name: KeepSessionState :exec
update session set phase = sqlc.arg(phase), refining = sqlc.arg(refining), runs = sqlc.arg(runs),
  last_run = sqlc.narg(last_run), spent = sqlc.narg(spent), channel = sqlc.narg(channel)
where id = sqlc.arg(id) and ended_at is null;
