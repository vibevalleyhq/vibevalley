-- Who speaks in the chat: the user, the assistants, the helpers the layers above seat, the farm (channel/store.ts).

-- name: UpsertParticipant :exec
-- home_id none keeps the home it had.
insert into channel_participant (id, kind, name, agent_id, home_id, joined_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(name), sqlc.narg(agent_id), sqlc.narg(home_id), sqlc.arg(joined_at))
on conflict (id) do update set name = excluded.name, agent_id = excluded.agent_id,
  home_id = coalesce(excluded.home_id, channel_participant.home_id), left_at = null;

-- name: AddParticipant :exec
-- One already there keeps its seat as it is.
insert into channel_participant (id, kind, name, joined_at) values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(name), sqlc.arg(joined_at))
on conflict (id) do nothing;

-- name: ParticipantLeft :exec
update channel_participant set left_at = sqlc.arg(left_at) where id = sqlc.arg(id) and left_at is null;

-- name: Participants :many
-- bound: a row per participant: the user, the assistants, profiles and the sessions hired.
select id, kind, name, agent_id, home_id, joined_at, left_at from channel_participant order by joined_at, seq;
