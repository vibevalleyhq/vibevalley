-- The channels, the default one among them, and the threads under their messages (channel/chat.ts).

-- name: DefaultID :one
select id from channel where is_default;

-- name: CreateChannel :exec
insert into channel (id, type, is_default, name, description, project, created_at)
values (sqlc.arg(id), 'channel', sqlc.arg(is_default), sqlc.arg(name), sqlc.narg(description), sqlc.narg(project), sqlc.arg(created_at));

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
update channel set description = sqlc.narg(description), project = sqlc.narg(project) where id = sqlc.arg(id) and type = 'channel';

-- name: CreateThread :exec
insert into channel (id, type, root_id, root_number, subject_kind, subject_id, parent_id, created_at)
values (sqlc.arg(id), 'thread', sqlc.arg(root_id), sqlc.arg(root_number), sqlc.narg(subject_kind), sqlc.narg(subject_id), sqlc.arg(parent_id), sqlc.arg(created_at));

-- name: AllChannels :many
-- What the chat keeps in memory (channel/model.ts), loaded when it starts.
select * from channel order by id;

-- name: RecentChannels :many
select * from channel order by coalesce(last_number, 0) desc, id desc limit sqlc.arg(n)::int;

-- name: TouchChannel :exec
update channel
set last_number = greatest(coalesce(last_number, 0), sqlc.arg(number)::int),
    reply_count = reply_count + case when type = 'thread' then 1 else 0 end
where id = sqlc.arg(id);

-- name: InboxOf :many
-- A participant's unread: the channel it is in and the threads it follows, newest first.
select c.id, c.type, c.root_id, c.root_number, c.subject_kind, c.subject_id, coalesce(ch.name, c.name, '')::text as channel_name,
       count(m.id)::int as unread,
       bool_or(exists (select 1 from channel_mention x where x.message_id = m.id and x.target_id = sqlc.arg(participant))) as mentions_you,
       coalesce(max(m.number), 0)::int as latest
from channel c
left join channel ch on ch.id = c.parent_id
join channel_message m on m.channel_id = c.id
left join channel_read_cursor rc on rc.participant_id = sqlc.arg(participant) and rc.channel_id = c.id
left join channel_follow f on f.channel_id = c.id and f.participant_id = sqlc.arg(participant) and f.unfollowed_at is null
where m.sender_id <> sqlc.arg(participant) and m.kind <> 'notice'
  and (c.id = sqlc.arg(channel) or f.participant_id is not null)
  and m.number > greatest(coalesce(rc.read_number, 0), coalesce(f.from_number, 0))
  and not exists (select 1 from channel_seen_mark s where s.participant_id = sqlc.arg(participant) and s.message_id = m.id)
group by c.id, ch.name
order by max(m.number) desc
limit 20;
