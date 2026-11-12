-- Who is in the chat: the user, the orchestrator, the sessions, the farm (channel/store.ts).

-- name: UpsertParticipant :exec
-- home_id none keeps the home it had.
insert into channel_participant (id, kind, role, name, agent_id, runtime, home_id, joined_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.narg(role), sqlc.arg(name), sqlc.narg(agent_id), sqlc.narg(runtime), sqlc.narg(home_id), sqlc.arg(joined_at))
on conflict (id) do update set role = excluded.role, name = excluded.name, agent_id = excluded.agent_id, runtime = excluded.runtime,
  home_id = coalesce(excluded.home_id, channel_participant.home_id), left_at = null;

-- name: ParticipantLeft :exec
update channel_participant set left_at = sqlc.arg(left_at) where id = sqlc.arg(id) and left_at is null;

-- name: Participants :many
-- bound: a row per participant: the user, the orchestrators, profiles and the sessions hired.
select id, kind, role, name, agent_id, runtime, home_id, joined_at, left_at from channel_participant order by joined_at, seq;
