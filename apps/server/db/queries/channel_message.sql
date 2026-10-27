-- What is said, in order: a message's id is a uuidv7 and sorts by time; its number is its place in its channel (channel/store.ts).

-- name: InsertMessage :one
insert into channel_message (id, channel_id, number, sender_id, kind, body, meta, send_key, created_at, revision, reply_number)
values (sqlc.arg(id), sqlc.arg(channel), (select coalesce(max(number), 0) + 1 from channel_message where channel_id = sqlc.arg(channel)),
        sqlc.arg(sender), sqlc.arg(kind), sqlc.arg(body), sqlc.narg(meta), sqlc.narg(send_key), sqlc.arg(created_at), sqlc.arg(revision),
        sqlc.narg(reply_number))
returning number;

-- name: UpdateMessageMeta :exec
update channel_message set meta = sqlc.narg(meta) where id = sqlc.arg(id);

-- name: MessageByID :one
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.id = sqlc.arg(id);

-- name: MessageBySendKey :one
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.sender_id = sqlc.arg(sender_id) and m.send_key = sqlc.arg(send_key);

-- name: OwnerMentions :many
-- The owner's unresolved mentions, independently of the history window. Reading or replying in that channel completes them.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions,
       p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent,
       c.type as channel_type, c.root_number, coalesce(c.parent_id, c.id)::text as top_id,
       coalesce(ch.name, c.name, '')::text as channel_name
from channel_mention n
join channel_message m on m.id = n.message_id
join channel_participant p on p.id = m.sender_id
join channel c on c.id = m.channel_id
left join channel ch on ch.id = c.parent_id
left join channel_read_cursor r on r.participant_id = 'owner' and r.channel_id = c.id
where n.target_id = 'owner' and m.sender_id <> 'owner'
  and m.number > coalesce(r.read_number, 0)
  and not exists (select 1 from channel_message reply where reply.channel_id = c.id and reply.sender_id = 'owner' and reply.number > m.number)
order by m.id;

-- name: MessagesBefore :many
-- Newest first.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.number < sqlc.arg(number) order by m.number desc limit sqlc.arg(n)::int;

-- name: MessagesAfter :many
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.number > sqlc.arg(number) order by m.number limit sqlc.arg(n)::int;

-- name: RecentReports :many
-- Newest first: the turn reports anywhere on the farm, for its log.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.kind = 'report' order by m.id desc limit sqlc.arg(n)::int;

-- name: ReportsAfter :many
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.kind = 'report' and m.id > sqlc.arg(after) order by m.id limit sqlc.arg(n)::int;

-- name: RecentDuplicate :one
select id from channel_message
where sender_id = sqlc.arg(sender_id) and channel_id = sqlc.arg(channel_id) and body = sqlc.arg(body) and created_at > sqlc.arg(since)
order by id desc limit 1;

-- name: DispatchesIn :one
select count(*)::int as n from channel_message where channel_id = sqlc.arg(channel_id) and kind = 'dispatch';

-- name: OwnerUnread :one
-- What the owner has not read in a channel: others' words past its read number, the farm's notices left out.
select count(*)::int as n from channel_message
where channel_id = sqlc.arg(channel_id) and number > sqlc.arg(read_number) and sender_id <> 'owner' and kind <> 'notice' and deleted_at is null;

-- name: LatestNumber :one
select coalesce(max(number), 0)::int as n from channel_message where channel_id = sqlc.arg(channel_id);

-- name: CalledBy :one
-- The session who last @-ed the speaker here since the speaker last spoke.
select m.sender_id
from channel_message m
join channel_mention n on n.message_id = m.id and n.target_id = sqlc.arg(speaker)
join channel_participant p on p.id = m.sender_id and p.kind = 'session'
where m.channel_id = sqlc.arg(channel) and m.sender_id <> sqlc.arg(speaker) and m.id < sqlc.arg(before)
  and m.id > coalesce((select max(s.id) from channel_message s where s.channel_id = sqlc.arg(channel) and s.sender_id = sqlc.arg(speaker) and s.id < sqlc.arg(before)), '')
order by m.id desc
limit 1;

-- name: UnseenIn :many
-- Newest first.
select m.id from channel_message m
where m.channel_id = sqlc.arg(channel) and m.sender_id <> sqlc.arg(participant)
  and m.number > coalesce((select read_number from channel_read_cursor where participant_id = sqlc.arg(participant) and channel_id = sqlc.arg(channel)), 0)
  and not exists (select 1 from channel_seen_mark s where s.participant_id = sqlc.arg(participant) and s.message_id = m.id)
order by m.number desc;

-- name: HoldNoticeSinceUser :one
select count(*)::int as n from channel_message m
where m.channel_id = sqlc.arg(channel) and m.sender_id = 'system' and (m.meta::jsonb ->> 'code') = 'hop_limit'
  and m.id > coalesce((select max(u.id) from channel_message u where u.channel_id = sqlc.arg(channel) and u.sender_id = 'owner'), '');

-- name: MessageByNumber :one
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.number = sqlc.arg(number);

-- name: OwnerLastMessages :many
-- The owner's last message in each channel, from which agents waking agents are counted (channel/audience.ts).
select channel_id, max(id)::text as id from channel_message where sender_id = 'owner' group by channel_id;

-- name: MessagesChangedAfter :many
-- What changed in a channel after a revision, in the order it changed: a follower's catch-up.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.revision > sqlc.arg(revision) order by m.revision limit sqlc.arg(n)::int;

-- name: EditMessage :exec
update channel_message set body = sqlc.arg(body), edited_at = sqlc.arg(at), revision = sqlc.arg(revision) where id = sqlc.arg(id);

-- name: DeleteMessage :exec
-- Its words, attachments and reactions go; its number stays.
update channel_message set body = '', meta = null, reactions = null, deleted_at = sqlc.arg(at), revision = sqlc.arg(revision) where id = sqlc.arg(id);

-- name: SetReactions :exec
update channel_message set reactions = sqlc.narg(reactions), revision = sqlc.arg(revision) where id = sqlc.arg(id);

-- name: SetPinned :exec
update channel_message set pinned_at = sqlc.narg(pinned_at), revision = sqlc.arg(revision) where id = sqlc.arg(id);

-- name: PinnedIn :many
-- Newest pinned first.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.pinned_at is not null order by m.pinned_at desc;

-- name: SearchMessages :many
-- Newest first: messages with these words, anywhere on the farm or in one channel and its threads.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions,
       p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent,
       c.type as channel_type, c.root_number, coalesce(c.parent_id, c.id)::text as top_id,
       coalesce(ch.name, c.name, '')::text as channel_name
from channel_message m
join channel_participant p on p.id = m.sender_id
join channel c on c.id = m.channel_id
left join channel ch on ch.id = c.parent_id
where m.deleted_at is null and m.kind <> 'notice'
  and (sqlc.arg(text)::text = '' or strpos(lower(m.body), lower(sqlc.arg(text))) > 0)
  and (sqlc.arg(channel)::text = '' or c.id = sqlc.arg(channel) or c.parent_id = sqlc.arg(channel))
  and (sqlc.arg(sender)::text = '' or m.sender_id = sqlc.arg(sender) or lower(p.name) = lower(sqlc.arg(sender)))
  and (not sqlc.arg(has_file)::boolean or strpos(coalesce(m.meta, ''), '"attachments"') > 0)
  and (not sqlc.arg(has_image)::boolean or strpos(coalesce(m.meta, ''), '"type":"image/') > 0)
  and (not sqlc.arg(has_link)::boolean or strpos(m.body, 'http://') > 0 or strpos(m.body, 'https://') > 0)
  and m.created_at >= sqlc.arg(after)::float8 and m.created_at < sqlc.arg(before)::float8
order by m.id desc limit sqlc.arg(n)::int;

-- name: DeleteMessagesIn :exec
-- A channel deleted: what was said in it and its threads goes (their mentions, deliveries and seen marks with them).
delete from channel_message where channel_id = sqlc.arg(id) or channel_id in (select t.id from channel t where t.parent_id = sqlc.arg(id));

-- name: SetEmbeds :exec
-- The previews read for its links, once they are: a change like any other.
update channel_message set meta = sqlc.narg(meta), revision = sqlc.arg(revision) where id = sqlc.arg(id);
