-- What is said, in order: a message's id is a uuidv7 and sorts by time; its number is its place in its conversation (channel/db.go).

-- name: InsertMessage :one
insert into channel_message (id, conversation_id, number, sender_id, kind, body, final, meta, send_key, created_at)
values (sqlc.arg(id), sqlc.arg(conversation), (select coalesce(max(number), 0) + 1 from channel_message where conversation_id = sqlc.arg(conversation)),
        sqlc.arg(sender), sqlc.arg(kind), sqlc.arg(body), sqlc.arg(final), sqlc.arg(meta), sqlc.arg(send_key), sqlc.arg(created_at))
returning number;

-- name: UpdateMessageBody :exec
update channel_message set body = ?, final = ?, updated_at = ? where id = ?;

-- name: UpdateMessageMeta :exec
update channel_message set meta = ? where id = ?;

-- name: MessageByID :one
select sqlc.embed(m), sqlc.embed(p) from channel_message m join channel_participant p on p.id = m.sender_id where m.id = ?;

-- name: MessageBySendKey :one
select sqlc.embed(m), sqlc.embed(p) from channel_message m join channel_participant p on p.id = m.sender_id where m.sender_id = ? and m.send_key = ?;

-- name: RecentMessages :many
select sqlc.embed(m), sqlc.embed(p) from channel_message m join channel_participant p on p.id = m.sender_id order by m.id desc limit ?;

-- name: MessagesBefore :many
-- Newest first.
select sqlc.embed(m), sqlc.embed(p) from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = ? and m.number < ? order by m.number desc limit ?;

-- name: MessagesAfter :many
select sqlc.embed(m), sqlc.embed(p) from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = ? and m.number > ? order by m.number limit ?;

-- name: RecentDuplicate :one
select id from channel_message where sender_id = ? and conversation_id = ? and body = ? and created_at > ? order by id desc limit 1;

-- name: LatestNumber :one
select cast(coalesce(max(number), 0) as integer) from channel_message where conversation_id = ?;

-- name: FinalizeAll :exec
update channel_message set final = 1, updated_at = ? where not final;

-- name: CalledBy :one
-- The session who last @-ed the speaker here since the speaker last spoke.
select m.sender_id
from channel_message m
join channel_mention n on n.message_id = m.id and n.target_id = sqlc.arg(speaker)
join channel_participant p on p.id = m.sender_id and p.kind = 'agent'
where m.conversation_id = sqlc.arg(conversation) and m.sender_id <> sqlc.arg(speaker) and m.id < sqlc.arg(before)
  and m.id > coalesce((select max(s.id) from channel_message s where s.conversation_id = sqlc.arg(conversation) and s.sender_id = sqlc.arg(speaker) and s.id < sqlc.arg(before)), '')
order by m.id desc
limit 1;

-- name: UnseenIn :many
-- Newest first.
select m.id from channel_message m
where m.conversation_id = sqlc.arg(conversation) and m.sender_id <> sqlc.arg(participant) and m.final
  and m.number > coalesce((select read_number from channel_read_cursor where participant_id = sqlc.arg(participant) and conversation_id = sqlc.arg(conversation)), 0)
  and not exists (select 1 from channel_seen_mark s where s.participant_id = sqlc.arg(participant) and s.message_id = m.id)
order by m.number desc;

-- name: HoldNoticeSinceUser :one
select count(*) from channel_message m
where m.conversation_id = sqlc.arg(conversation) and m.sender_id = 'system' and json_extract(m.meta, '$.code') = 'hop_limit'
  and m.id > coalesce((select max(u.id) from channel_message u where u.conversation_id = sqlc.arg(conversation) and u.sender_id = 'user'), '');

-- name: MessageByNumber :one
select sqlc.embed(m), sqlc.embed(p) from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = ? and m.number = ?;
