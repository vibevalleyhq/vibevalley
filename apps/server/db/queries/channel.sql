-- The channels, the default one among them, and the threads under their messages (channel/channel.ts).

-- name: DefaultID :one
select id from channel where is_default;

-- name: CreateChannel :exec
insert into channel (id, type, is_default, name, description, repo, created_at)
values (sqlc.arg(id), 'channel', sqlc.arg(is_default), sqlc.arg(name), sqlc.narg(description), sqlc.narg(repo), sqlc.arg(created_at));

-- name: CreateDirect :exec
-- At most one with each peer (peer_id is unique): a second for the same peer is not made.
insert into channel (id, type, peer_id, created_at) values (sqlc.arg(id), 'direct', sqlc.arg(peer_id), sqlc.arg(created_at))
on conflict (peer_id) do nothing;

-- name: ClearDefault :exec
-- Before MakeDefault, in its transaction: one default at a time (channel_one_default).
update channel set is_default = false where is_default;

-- name: MakeDefault :exec
update channel set is_default = true where id = sqlc.arg(id) and type = 'channel';

-- name: UpdateChannel :exec
update channel set description = sqlc.narg(description), repo = sqlc.narg(repo) where id = sqlc.arg(id) and type = 'channel';

-- name: CreateThread :exec
insert into channel (id, type, root_id, root_number, subject_kind, subject_id, parent_id, created_at)
values (sqlc.arg(id), 'thread', sqlc.arg(root_id), sqlc.arg(root_number), sqlc.narg(subject_kind), sqlc.narg(subject_id), sqlc.arg(parent_id), sqlc.arg(created_at));

-- name: AllChannels :many
-- bound: a row per channel, what the chat keeps in memory.
-- What the chat keeps in memory (channel/rooms.ts), loaded when it starts.
select * from channel order by id;

-- name: RecentChannels :many
select * from channel order by coalesce(last_number, 0) desc, id desc limit sqlc.arg(n)::int;

-- name: TouchChannel :exec
update channel
set last_number = greatest(coalesce(last_number, 0), sqlc.arg(number)::int),
    reply_count = reply_count + case when type = 'thread' then 1 else 0 end
where id = sqlc.arg(id);

-- name: UnreadOf :many
-- A participant's unread: the channel it is in and the threads it follows, newest first.
with unread as (
  select c.id, c.type, c.root_id, c.root_number, c.subject_kind, c.subject_id, coalesce(ch.name, c.name, '')::text as channel_name,
         count(m.id)::int as unread,
         bool_or(exists (select 1 from channel_mention x where x.message_id = m.id and x.target_id = sqlc.arg(participant)))::bool as mentions_you,
         coalesce(max(m.number), 0)::int as latest
  from channel c
  left join channel ch on ch.id = c.parent_id
  join channel_message m on m.channel_id = c.id
  left join channel_read_cursor rc on rc.participant_id = sqlc.arg(participant) and rc.channel_id = c.id
  left join channel_member f on f.channel_id = c.id and f.participant_id = sqlc.arg(participant) and f.left_at is null
  where m.sender_id <> sqlc.arg(participant) and m.kind <> 'notice'
    and (c.id = sqlc.arg(channel) or f.participant_id is not null)
    and m.number > greatest(coalesce(rc.read_number, 0), coalesce(f.from_number, 0))
    and not exists (select 1 from session_delivery d where d.session_id = sqlc.arg(participant) and d.message_id = m.id and d.consumed_at is not null)
  group by c.id, ch.name
)
select u.*,
       (select p.name from channel_message lm join channel_participant p on p.id = lm.sender_id
        where lm.channel_id = u.id and lm.number = u.latest)::text? as latest_sender_name
from unread u
order by u.latest desc
limit 20;

-- name: BumpRevision :one
-- In the transaction that writes or changes a message there: the revision it is written with.
update channel set revision = revision + 1 where id = sqlc.arg(id) returning revision;

-- name: RenameChannel :exec
update channel set name = sqlc.narg(name) where id = sqlc.arg(id) and type <> 'direct';

-- name: SetCategory :exec
update channel set category = sqlc.narg(category) where id = sqlc.arg(id) and type = 'channel';

-- name: PlaceChannel :exec
update channel set position = sqlc.arg(position) where id = sqlc.arg(id);

-- name: SetArchived :exec
update channel set archived_at = sqlc.narg(archived_at) where id = sqlc.arg(id) and not is_default;

-- name: SetNotify :exec
update channel set notify = sqlc.arg(notify) where id = sqlc.arg(id);

-- name: TopPlace :one
-- A place's channel or direct channel: itself, or the one a thread hangs in.
with recursive places as (
  select id, type, peer_id, parent_id from channel where id = sqlc.arg(id)
  union
  select c.id, c.type, c.peer_id, c.parent_id
  from channel c join places p on c.id = p.parent_id where p.type = 'thread'
)
select id::channel.id as id, type::channel.type as type, peer_id::channel.peer_id? as peer_id from places where type <> 'thread' limit 1;


-- name: ChannelInUse :one
-- What still points at a channel, so deleting it would take it from under them.
select (select count(*) from issue_cron r where r.channel_id = sqlc.arg(id))::int as crons,
       (select count(*) from connector_account a where a.channel_id = sqlc.arg(id))::int as connectors,
       (select count(distinct i.id) from issue i
        left join session_issue_input m on m.issue_id = i.id and m.state = 'held'
        left join session_trigger t on t.id = m.trigger_id
        where i.queued_at is not null and (t.trigger_json::jsonb ->> 'replyChannel' = sqlc.arg(id)))::int as queued,
       (select count(*) from channel t where t.parent_id = sqlc.arg(id) and t.subject_kind = 'issue')::int as issue_threads;

-- name: DeleteThreadsOf :exec
delete from channel where parent_id = sqlc.arg(id);

-- name: DeleteChannel :exec
delete from channel where id = sqlc.arg(id) and not is_default;
