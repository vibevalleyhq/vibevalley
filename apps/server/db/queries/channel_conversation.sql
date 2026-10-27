-- The general channel, the channels and the threads under their messages (channel/store.ts).

-- name: GeneralID :one
select id from channel_conversation where kind = 'general';

-- name: CreateGeneral :exec
insert into channel_conversation (id, kind, name, created_at) values (sqlc.arg(id), 'general', sqlc.arg(name), sqlc.arg(created_at));

-- name: CreateChannel :exec
insert into channel_conversation (id, kind, name, description, project, created_at)
values (sqlc.arg(id), 'channel', sqlc.arg(name), sqlc.narg(description), sqlc.narg(project), sqlc.arg(created_at));

-- name: UpdateChannel :exec
update channel_conversation set description = sqlc.narg(description), project = sqlc.narg(project) where id = sqlc.arg(id) and kind in ('general', 'channel');

-- name: CreateThread :exec
insert into channel_conversation (id, kind, parent_id, parent_number, subject_kind, subject_id, channel_id, created_at)
values (sqlc.arg(id), 'thread', sqlc.arg(parent_id), sqlc.arg(parent_number), sqlc.narg(subject_kind), sqlc.narg(subject_id), sqlc.arg(channel_id), sqlc.arg(created_at));

-- name: AllConversations :many
-- What the chat keeps in memory (channel/model.ts), loaded when it starts.
select * from channel_conversation order by id;

-- name: RecentConversations :many
select * from channel_conversation order by coalesce(last_number, 0) desc, id desc limit sqlc.arg(n)::int;

-- name: TouchConversation :exec
update channel_conversation
set last_number = greatest(coalesce(last_number, 0), sqlc.arg(number)::int),
    reply_count = reply_count + case when kind = 'thread' then 1 else 0 end
where id = sqlc.arg(id);

-- name: InboxOf :many
-- A participant's unread: the channel it is in and the threads it follows, newest first.
select c.id, c.kind, c.parent_id, c.parent_number, c.subject_kind, c.subject_id, coalesce(ch.name, c.name, '')::text as channel_name,
       count(m.id)::int as unread,
       bool_or(exists (select 1 from channel_mention x where x.message_id = m.id and x.target_id = sqlc.arg(participant))) as mentions_you,
       coalesce(max(m.number), 0)::int as latest
from channel_conversation c
left join channel_conversation ch on ch.id = c.channel_id
join channel_message m on m.conversation_id = c.id
left join channel_read_cursor rc on rc.participant_id = sqlc.arg(participant) and rc.conversation_id = c.id
left join channel_follow f on f.conversation_id = c.id and f.participant_id = sqlc.arg(participant) and f.unfollowed_at is null
where m.sender_id <> sqlc.arg(participant) and m.kind <> 'notice'
  and (c.id = sqlc.arg(channel) or f.participant_id is not null)
  and m.number > greatest(coalesce(rc.read_number, 0), coalesce(f.from_number, 0))
  and not exists (select 1 from channel_seen_mark s where s.participant_id = sqlc.arg(participant) and s.message_id = m.id)
group by c.id, ch.name
order by max(m.number) desc
limit 20;
