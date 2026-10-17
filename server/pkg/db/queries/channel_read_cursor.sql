-- How far each participant has read in each conversation, by message number; it only moves on (channel/db.go).

-- name: SetReadCursor :exec
insert into channel_read_cursor (participant_id, conversation_id, read_number, updated_at) values (?, ?, ?, ?)
on conflict (participant_id, conversation_id) do update set read_number = max(channel_read_cursor.read_number, excluded.read_number), updated_at = excluded.updated_at;

-- name: ReadCursor :one
select read_number from channel_read_cursor where participant_id = ? and conversation_id = ?;
