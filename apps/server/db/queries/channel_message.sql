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
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.id = sqlc.arg(id);

-- name: MessageBySendKey :one
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id where m.sender_id = sqlc.arg(sender_id) and m.send_key = sqlc.arg(send_key);

-- name: UserMentions :many
-- bound: only the user's unread mentions; reading or replying in the channel completes them.
-- The user's unresolved mentions, independently of the history window. Reading or replying in that channel completes them.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions,
       p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent,
       c.type as channel_type, c.root_number, coalesce(c.parent_id, c.id)::text as top_id,
       coalesce(ch.name, c.name, '')::text as channel_name
from channel_mention n
join channel_message m on m.id = n.message_id
join channel_participant p on p.id = m.sender_id
join channel c on c.id = m.channel_id
left join channel ch on ch.id = c.parent_id
left join channel_read_cursor r on r.participant_id = 'user' and r.channel_id = c.id
where n.target_id = 'user' and m.sender_id <> 'user'
  and m.number > coalesce(r.read_number, 0)
  and not exists (select 1 from channel_message reply where reply.channel_id = c.id and reply.sender_id = 'user' and reply.number > m.number)
order by m.id;

-- name: MessagesBefore :many
-- Newest first.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.number < sqlc.arg(number) order by m.number desc limit sqlc.arg(n)::int;

-- name: MessagesAfter :many
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.number > sqlc.arg(number) order by m.number limit sqlc.arg(n)::int;

-- name: MissingDirectDeliveries :many
-- bound: user messages committed after a direct session's startup snapshot, without a delivery to that session.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions,
       p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent
from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.number > sqlc.arg(after_number)
  and m.sender_id = 'user' and m.kind = 'chat' and m.deleted_at is null
  and not exists (select 1 from session_delivery d where d.session_id = sqlc.arg(recipient_id) and d.message_id = m.id)
order by m.number;

-- name: RecentReports :many
-- Newest first: the turn reports anywhere on the farm, for its log.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.kind = 'report' order by m.id desc limit sqlc.arg(n)::int;

-- name: ReportsAfter :many
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.kind = 'report' and m.id > sqlc.arg(after) order by m.id limit sqlc.arg(n)::int;

-- name: RecentDuplicate :one
select id from channel_message
where sender_id = sqlc.arg(sender_id) and channel_id = sqlc.arg(channel_id) and body = sqlc.arg(body) and created_at > sqlc.arg(since)
order by id desc limit 1;

-- name: DispatchesIn :one
select count(*)::int as n from channel_message where channel_id = sqlc.arg(channel_id) and kind = 'dispatch';

-- name: UserUnread :one
-- What the user has not read in a channel: others' words past its read number, the farm's notices left out.
select count(*)::int as n from channel_message
where channel_id = sqlc.arg(channel_id) and number > sqlc.arg(read_number) and sender_id <> 'user' and kind <> 'notice' and deleted_at is null;

-- name: LatestNumber :one
select coalesce(max(number), 0)::int as n from channel_message where channel_id = sqlc.arg(channel_id);

-- name: CalledBy :one
-- The session who last @-ed the speaker here since the speaker last spoke.
select m.sender_id
from channel_message m
join channel_mention n on n.message_id = m.id and n.target_id = sqlc.arg(speaker)
join channel_participant p on p.id = m.sender_id and p.role = 'worker' and p.runtime is not null
where m.channel_id = sqlc.arg(channel) and m.sender_id <> sqlc.arg(speaker) and m.id < sqlc.arg(before)
  and m.id > coalesce((select max(s.id) from channel_message s where s.channel_id = sqlc.arg(channel) and s.sender_id = sqlc.arg(speaker) and s.id < sqlc.arg(before)), '')
order by m.id desc
limit 1;

-- name: UnseenIn :many
-- bound: one participant's unread in one channel; the read cursor moves past them.
-- Oldest first, so a partial read can advance the cursor without skipping messages.
select m.id from channel_message m
where m.channel_id = sqlc.arg(channel) and m.sender_id <> sqlc.arg(participant)
  and m.number > coalesce((select read_number from channel_read_cursor where participant_id = sqlc.arg(participant) and channel_id = sqlc.arg(channel)), 0)
  and not exists (select 1 from session_delivery d where d.session_id = sqlc.arg(participant) and d.message_id = m.id and d.consumed_at is not null)
order by m.number;

-- name: HoldNoticeSinceUser :one
select count(*)::int as n from channel_message m
where m.channel_id = sqlc.arg(channel) and m.sender_id = 'system' and (m.meta::jsonb ->> 'code') = 'hop_limit'
  and m.id > coalesce((select max(u.id) from channel_message u where u.channel_id = sqlc.arg(channel) and u.sender_id = 'user'), '');

-- name: MessageByNumber :one
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.number = sqlc.arg(number);

-- name: MessagesChangedAfter :many
-- What changed in a channel after a revision, in the order it changed: a follower's catch-up.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
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
-- bound: one channel's pins, each one pinned by hand.
-- Newest pinned first.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent from channel_message m join channel_participant p on p.id = m.sender_id
where m.channel_id = sqlc.arg(channel_id) and m.pinned_at is not null order by m.pinned_at desc;

-- name: SearchMessages :many
-- Newest first: messages with these words, anywhere on the farm or in one channel and its threads.
select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions,
       p.name as sender_name, p.kind as sender_kind, p.role as sender_role, p.agent_id as sender_agent,
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

-- name: DeleteThreadMessagesIn :exec
-- Remove child messages before their channels, then the root messages those channels reference.
delete from channel_message where channel_id in (select t.id from channel t where t.parent_id = sqlc.arg(id));

-- name: SetEmbeds :exec
-- The previews read for its links, once they are: a change like any other.
update channel_message set meta = sqlc.narg(meta), revision = sqlc.arg(revision) where id = sqlc.arg(id);

-- name: NotificationReceipt :one
select r.updated_at as read_at,
  exists (select 1 from channel_message n where n.channel_id = m.channel_id and n.number > m.number
    and n.deleted_at is null and (n.sender_id = 'user' or (m.kind = 'report' and n.kind = 'report' and n.sender_id = m.sender_id)))::bool as superseded
from channel_message m
left join channel_read_cursor r on r.channel_id = m.channel_id and r.participant_id = 'user' and r.read_number >= m.number
where m.id = sqlc.arg(id);

-- name: UserReadReports :many
-- bound: the latest report per session.
select m.sender_id, m.created_at, r.updated_at
from channel_message m
join channel_read_cursor r on r.channel_id = m.channel_id and r.participant_id = 'user' and r.read_number >= m.number
where m.kind = 'report' and m.deleted_at is null
  and not exists (select 1 from channel_message n where n.channel_id = m.channel_id and n.sender_id = m.sender_id and n.kind = 'report' and n.number > m.number);

-- name: UnroutedChannelMessages :many
select m.id as envelope_id, m.number, m.channel_id, m.sender_id, m.kind, m.body, m.meta, m.reply_number, m.created_at,
       p.name, p.kind as sender_kind, p.role as sender_role, c.type as channel_type, c.root_id, c.root_number, c.subject_kind, c.subject_id,
       coalesce(ch.name, c.name, '')::text as channel_name
from channel_message m
join channel_participant p on p.id = m.sender_id
join channel c on c.id = m.channel_id
left join channel ch on ch.id = c.parent_id
left join session_trigger r on r.id = m.id
where r.routed_at is null and m.deleted_at is null
  and (m.channel_id, m.number) > (sqlc.arg(after_channel)::text, sqlc.arg(after_number)::int)
order by m.channel_id, m.number
limit 1000;
