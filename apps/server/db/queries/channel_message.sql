-- What is said, in order: a message's id is a uuidv7 and sorts by time; its number is its place in its conversation (channel/store.ts).

-- name: InsertMessage :one
insert into channel_message (id, conversation_id, number, sender_id, kind, body, meta, send_key, created_at)
values (sqlc.arg(id), sqlc.arg(conversation), (select coalesce(max(number), 0) + 1 from channel_message where conversation_id = sqlc.arg(conversation)),
        sqlc.arg(sender), sqlc.arg(kind), sqlc.arg(body), sqlc.narg(meta), sqlc.narg(send_key), sqlc.arg(created_at))
returning number;

-- name: UpdateMessageMeta :exec
update channel_message set meta = sqlc.narg(meta) where id = sqlc.arg(id);

-- name: MessageByID :one
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.id = sqlc.arg(id);

-- name: MessageBySendKey :one
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.sender_id = sqlc.arg(sender_id) and m.send_key = sqlc.arg(send_key);

-- name: OwnerMentions :many
-- The owner's unresolved mentions, independently of the history window. Reading or replying in that conversation completes them.
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at,
       p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent,
       c.kind as conversation_kind, c.parent_number, coalesce(c.channel_id, c.id)::text as channel_id,
       coalesce(ch.name, c.name, '')::text as channel_name
from channel_mention n
join channel_message m on m.id = n.message_id
join channel_participant p on p.id = m.sender_id
join channel_conversation c on c.id = m.conversation_id
left join channel_conversation ch on ch.id = c.channel_id
left join channel_read_cursor r on r.participant_id = 'owner' and r.conversation_id = c.id
where n.target_id = 'owner' and m.sender_id <> 'owner'
  and m.number > coalesce(r.read_number, 0)
  and not exists (select 1 from channel_message reply where reply.conversation_id = c.id and reply.sender_id = 'owner' and reply.number > m.number)
order by m.id;

-- name: MessagesBefore :many
-- Newest first.
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = sqlc.arg(conversation_id) and m.number < sqlc.arg(number) order by m.number desc limit sqlc.arg(n)::int;

-- name: MessagesAfter :many
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = sqlc.arg(conversation_id) and m.number > sqlc.arg(number) order by m.number limit sqlc.arg(n)::int;

-- name: RecentReports :many
-- Newest first: the turn reports anywhere on the farm, for its log.
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.kind = 'report' order by m.id desc limit sqlc.arg(n)::int;

-- name: ReportsAfter :many
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.kind = 'report' and m.id > sqlc.arg(after) order by m.id limit sqlc.arg(n)::int;

-- name: RecentDuplicate :one
select id from channel_message
where sender_id = sqlc.arg(sender_id) and conversation_id = sqlc.arg(conversation_id) and body = sqlc.arg(body) and created_at > sqlc.arg(since)
order by id desc limit 1;

-- name: DispatchesIn :one
select count(*)::int as n from channel_message where conversation_id = sqlc.arg(conversation_id) and kind = 'dispatch';

-- name: OwnerUnread :one
-- What the owner has not read in a conversation: others' words past its read number, the farm's notices left out.
select count(*)::int as n from channel_message
where conversation_id = sqlc.arg(conversation_id) and number > sqlc.arg(read_number) and sender_id <> 'owner' and kind <> 'notice';

-- name: LatestNumber :one
select coalesce(max(number), 0)::int as n from channel_message where conversation_id = sqlc.arg(conversation_id);

-- name: CalledBy :one
-- The session who last @-ed the speaker here since the speaker last spoke.
select m.sender_id
from channel_message m
join channel_mention n on n.message_id = m.id and n.target_id = sqlc.arg(speaker)
join channel_participant p on p.id = m.sender_id and p.kind = 'session'
where m.conversation_id = sqlc.arg(conversation) and m.sender_id <> sqlc.arg(speaker) and m.id < sqlc.arg(before)
  and m.id > coalesce((select max(s.id) from channel_message s where s.conversation_id = sqlc.arg(conversation) and s.sender_id = sqlc.arg(speaker) and s.id < sqlc.arg(before)), '')
order by m.id desc
limit 1;

-- name: UnseenIn :many
-- Newest first.
select m.id from channel_message m
where m.conversation_id = sqlc.arg(conversation) and m.sender_id <> sqlc.arg(participant)
  and m.number > coalesce((select read_number from channel_read_cursor where participant_id = sqlc.arg(participant) and conversation_id = sqlc.arg(conversation)), 0)
  and not exists (select 1 from channel_seen_mark s where s.participant_id = sqlc.arg(participant) and s.message_id = m.id)
order by m.number desc;

-- name: HoldNoticeSinceUser :one
select count(*)::int as n from channel_message m
where m.conversation_id = sqlc.arg(conversation) and m.sender_id = 'system' and (m.meta::jsonb ->> 'code') = 'hop_limit'
  and m.id > coalesce((select max(u.id) from channel_message u where u.conversation_id = sqlc.arg(conversation) and u.sender_id = 'owner'), '');

-- name: MessageByNumber :one
select m.id, m.conversation_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.conversation_id = sqlc.arg(conversation_id) and m.number = sqlc.arg(number);

-- name: OwnerLastMessages :many
-- The owner's last message in each conversation, from which agents waking agents are counted (channel/audience.ts).
select conversation_id, max(id)::text as id from channel_message where sender_id = 'owner' group by conversation_id;
