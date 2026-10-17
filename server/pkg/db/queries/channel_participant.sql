-- Who is in the chat: the owner, the manager, the sessions, the farm (channel/db.go).

-- name: UpsertParticipant :exec
insert into channel_participant (id, kind, name, agent_id, runtime, joined_at) values (?, ?, ?, ?, ?, ?)
on conflict (id) do update set name = excluded.name, agent_id = excluded.agent_id, runtime = excluded.runtime, left_at = null;

-- name: ParticipantLeft :exec
update channel_participant set left_at = ? where id = ? and left_at is null;

-- name: Participants :many
select * from channel_participant order by joined_at, rowid;
