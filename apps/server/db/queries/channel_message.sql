-- What is said, in order: a message's id is a uuidv7 and sorts by time; its number is its place in its conversation (channel/store.ts).

-- name: InsertMessage :one
insert into channel_message (id, conversation_id, number, sender_id, kind, body, final, meta, send_key, created_at)
values (sqlc.arg(id), sqlc.arg(conversation), (select coalesce(max(number), 0) + 1 from channel_message where conversation_id = sqlc.arg(conversation)),
        sqlc.arg(sender), sqlc.arg(kind), sqlc.arg(body), sqlc.arg(final), sqlc.narg(meta), sqlc.narg(send_key), sqlc.arg(created_at))
returning number;

-- name: UpdateMessageBody :exec
update channel_message set body = sqlc.arg(body), final = sqlc.arg(final), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);

-- name: UpdateMessageMeta :exec
update channel_message set meta = sqlc.narg(meta) where id = sqlc.arg(id);

-- name: MessageByID :one
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.final, m.meta, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.id = sqlc.arg(id);

-- name: MessageBySendKey :one
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.final, m.meta, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.sender_id = sqlc.arg(sender_id) and m.send_key = sqlc.arg(send_key);

-- name: RecentMessages :many
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.final, m.meta, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id order by m.id desc limit sqlc.arg(n)::int;

-- name: MessagesBefore :many
-- Newest first.
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.final, m.meta, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = sqlc.arg(conversation_id) and m.number < sqlc.arg(number) order by m.number desc limit sqlc.arg(n)::int;

-- name: MessagesAfter :many
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.final, m.meta, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = sqlc.arg(conversation_id) and m.number > sqlc.arg(number) order by m.number limit sqlc.arg(n)::int;

-- name: RecentDuplicate :one
select id from channel_message
where sender_id = sqlc.arg(sender_id) and conversation_id = sqlc.arg(conversation_id) and body = sqlc.arg(body) and created_at > sqlc.arg(since)
order by id desc limit 1;

-- name: LatestNumber :one
select coalesce(max(number), 0)::int as n from channel_message where conversation_id = sqlc.arg(conversation_id);

-- name: FinalizeAll :exec
update channel_message set final = true, updated_at = sqlc.arg(updated_at) where not final;

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
select count(*)::int as n from channel_message m
where m.conversation_id = sqlc.arg(conversation) and m.sender_id = 'system' and (m.meta::jsonb ->> 'code') = 'hop_limit'
  and m.id > coalesce((select max(u.id) from channel_message u where u.conversation_id = sqlc.arg(conversation) and u.sender_id = 'user'), '');

-- name: MessageByNumber :one
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.final, m.meta, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = sqlc.arg(conversation_id) and m.number = sqlc.arg(number);
