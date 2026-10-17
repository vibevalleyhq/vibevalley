-- What is said, in order: seq is the order of the whole chat (channel/db.go).

-- name: InsertMessage :one
insert into message (conversation_id, sender_id, kind, body, final, meta, created_at) values (?, ?, ?, ?, ?, ?, ?) returning seq;

-- name: UpdateMessageBody :exec
update message set body = ?, final = ?, updated_at = ? where seq = ?;

-- name: UpdateMessageMeta :exec
update message set meta = ? where seq = ?;

-- name: MessageBySeq :one
select sqlc.embed(m), sqlc.embed(p) from message m join participant p on p.id = m.sender_id where m.seq = ?;

-- name: RecentMessages :many
select sqlc.embed(m), sqlc.embed(p) from message m join participant p on p.id = m.sender_id order by m.seq desc limit ?;

-- name: MessagesBefore :many
-- Newest first.
select sqlc.embed(m), sqlc.embed(p) from message m join participant p on p.id = m.sender_id
where m.conversation_id = ? and m.seq < ? order by m.seq desc limit ?;

-- name: MessagesAfter :many
select sqlc.embed(m), sqlc.embed(p) from message m join participant p on p.id = m.sender_id
where m.conversation_id = ? and m.seq > ? order by m.seq limit ?;

-- name: RecentDuplicate :one
select seq from message where sender_id = ? and conversation_id = ? and body = ? and created_at > ? order by seq desc limit 1;

-- name: LatestSeq :one
select cast(coalesce(max(seq), 0) as integer) from message where conversation_id = ?;

-- name: FinalizeAll :exec
update message set final = 1, updated_at = ? where not final;

-- name: CalledBy :one
-- The session who last @-ed the speaker here since the speaker last spoke.
select m.sender_id
from message m
join mention n on n.message_seq = m.seq and n.target_id = sqlc.arg(speaker)
join participant p on p.id = m.sender_id and p.kind = 'agent'
where m.conversation_id = sqlc.arg(conversation) and m.sender_id <> sqlc.arg(speaker) and m.seq < sqlc.arg(before)
  and m.seq > coalesce((select max(s.seq) from message s where s.conversation_id = sqlc.arg(conversation) and s.sender_id = sqlc.arg(speaker) and s.seq < sqlc.arg(before)), 0)
order by m.seq desc
limit 1;

-- name: UnseenIn :many
-- Newest first.
select m.seq from message m
where m.conversation_id = sqlc.arg(conversation) and m.sender_id <> sqlc.arg(participant) and m.final
  and m.seq > coalesce((select read_seq from read_cursor where participant_id = sqlc.arg(participant) and conversation_id = sqlc.arg(conversation)), 0)
  and not exists (select 1 from seen_mark s where s.participant_id = sqlc.arg(participant) and s.message_seq = m.seq)
order by m.seq desc;

-- name: HoldNoticeSinceUser :one
select count(*) from message m
where m.conversation_id = sqlc.arg(conversation) and m.sender_id = 'system' and json_extract(m.meta, '$.code') = 'hop_limit'
  and m.seq > coalesce((select max(u.seq) from message u where u.conversation_id = sqlc.arg(conversation) and u.sender_id = 'user'), 0);
