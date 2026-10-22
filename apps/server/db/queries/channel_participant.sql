-- Who is in the chat: the owner, the orchestrator, the sessions, the farm (channel/store.ts).

-- name: UpsertParticipant :exec
insert into channel_participant (id, kind, name, agent_id, runtime, joined_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(name), sqlc.narg(agent_id), sqlc.narg(runtime), sqlc.arg(joined_at))
on conflict (id) do update set name = excluded.name, agent_id = excluded.agent_id, runtime = excluded.runtime, left_at = null;

-- name: ParticipantLeft :exec
update channel_participant set left_at = sqlc.arg(left_at) where id = sqlc.arg(id) and left_at is null;

-- name: Participants :many
select id, kind, name, agent_id, runtime, joined_at, left_at from channel_participant order by joined_at, seq;
