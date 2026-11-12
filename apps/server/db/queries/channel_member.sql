-- The members of a place: who is in a thread or a channel, why, and from which message number on (channel/hub.ts).

-- name: AddMember :exec
insert into channel_member (channel_id, participant_id, reason, from_number)
values (sqlc.arg(channel_id), sqlc.arg(participant_id), sqlc.arg(reason), sqlc.arg(from_number))
on conflict (channel_id, participant_id) do update set left_at = null;

-- name: RemoveMember :exec
update channel_member set left_at = sqlc.arg(at) where channel_id = sqlc.arg(channel_id) and participant_id = sqlc.arg(participant_id) and left_at is null;

-- name: AllMembers :many
-- bound: a row per place and member.
select channel_id, participant_id from channel_member where left_at is null;

-- name: DeleteMembersIn :exec
delete from channel_member where channel_id = sqlc.arg(id) or channel_id in (select t.id from channel t where t.parent_id = sqlc.arg(id));

-- name: RemoveFromAll :exec
-- A session that left is in nothing: its ids are never taken again.
update channel_member set left_at = sqlc.arg(at) where participant_id = sqlc.arg(participant_id) and left_at is null;
