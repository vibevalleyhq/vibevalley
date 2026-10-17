-- How far each participant has read in each conversation; it only moves on (channel/db.go).

-- name: SetReadCursor :exec
insert into read_cursor (participant_id, conversation_id, read_seq, updated_at) values (?, ?, ?, ?)
on conflict (participant_id, conversation_id) do update set read_seq = max(read_cursor.read_seq, excluded.read_seq), updated_at = excluded.updated_at;

-- name: ReadCursor :one
select read_seq from read_cursor where participant_id = ? and conversation_id = ?;
