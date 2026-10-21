-- Who follows a thread, from which message number on (channel/store.ts).

-- name: Follow :exec
insert into channel_follow (conversation_id, participant_id, reason, from_number)
values (sqlc.arg(conversation_id), sqlc.arg(participant_id), sqlc.arg(reason), sqlc.arg(from_number))
on conflict (conversation_id, participant_id) do update set unfollowed_at = null;

-- name: Followers :many
select participant_id from channel_follow where conversation_id = sqlc.arg(conversation_id) and unfollowed_at is null order by participant_id;
