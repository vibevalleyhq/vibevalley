-- Messages seen past the read cursor, until the cursor catches up (channel/db.go).

-- name: AddSeenMark :exec
insert into channel_seen_mark (participant_id, message_seq) values (?, ?) on conflict do nothing;

-- name: PruneSeenMarks :exec
delete from channel_seen_mark where participant_id = sqlc.arg(participant)
  and message_seq in (select seq from channel_message where conversation_id = sqlc.arg(conversation) and seq <= sqlc.arg(upto));
