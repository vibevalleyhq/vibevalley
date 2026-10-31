-- Who follows a thread, from which message number on (channel/store.ts).

-- name: Follow :exec
insert into channel_follow (channel_id, participant_id, reason, from_number)
values (sqlc.arg(channel_id), sqlc.arg(participant_id), sqlc.arg(reason), sqlc.arg(from_number))
on conflict (channel_id, participant_id) do update set unfollowed_at = null;

-- name: AllFollows :many
-- bound: a row per channel and follower.
select channel_id, participant_id from channel_follow where unfollowed_at is null;

-- name: DeleteFollowsIn :exec
delete from channel_follow where channel_id = sqlc.arg(id) or channel_id in (select t.id from channel t where t.parent_id = sqlc.arg(id));

-- name: UnfollowAllOf :exec
-- A session that left follows nothing: its ids are never taken again.
update channel_follow set unfollowed_at = sqlc.arg(at) where participant_id = sqlc.arg(participant_id) and unfollowed_at is null;
