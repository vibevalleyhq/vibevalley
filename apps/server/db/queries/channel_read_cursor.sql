-- How far each participant has read in each channel, by message number; it only moves on (channel/store.ts).

-- name: SetReadCursor :exec
insert into channel_read_cursor (participant_id, channel_id, read_number, updated_at)
values (sqlc.arg(participant_id), sqlc.arg(channel_id), sqlc.arg(read_number), sqlc.arg(updated_at))
on conflict (participant_id, channel_id) do update set read_number = greatest(channel_read_cursor.read_number, excluded.read_number), updated_at = excluded.updated_at;

-- name: ReadCursor :one
select read_number from channel_read_cursor where participant_id = sqlc.arg(participant_id) and channel_id = sqlc.arg(channel_id);

-- name: ReadCursorsOf :many
select channel_id, read_number from channel_read_cursor where participant_id = sqlc.arg(participant_id);
