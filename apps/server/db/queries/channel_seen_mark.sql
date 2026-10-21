-- Messages seen past the read cursor, until the cursor catches up (channel/store.ts).

-- name: AddSeenMark :exec
insert into channel_seen_mark (participant_id, message_id) values (sqlc.arg(participant_id), sqlc.arg(message_id)) on conflict do nothing;

-- name: PruneSeenMarks :exec
delete from channel_seen_mark where participant_id = sqlc.arg(participant)
  and message_id in (select id from channel_message where conversation_id = sqlc.arg(conversation) and number <= sqlc.arg(upto));
