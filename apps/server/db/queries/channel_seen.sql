-- What a participant took in without reading it in the chat (channel/channel.ts).

-- name: MarkSeen :exec
-- Only a message there, by a participant there: an envelope that is no message (words told to a session alone) marks nothing.
insert into channel_seen (participant_id, message_id, seen_at)
select p.id, m.id, sqlc.arg(seen_at) from channel_message m, channel_participant p
where m.id = sqlc.arg(message_id) and p.id = sqlc.arg(participant_id)
on conflict do nothing;
