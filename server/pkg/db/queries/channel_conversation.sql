-- The general channel, the channels and the threads under their messages (channel/db.go).

-- name: GeneralID :one
select id from channel_conversation where kind = 'general';

-- name: CreateGeneral :one
insert into channel_conversation (kind, name, created_at) values ('general', ?, ?) returning id;

-- name: CreateChannel :one
insert into channel_conversation (kind, name, description, project, created_at) values ('channel', ?, ?, ?, ?) returning id;

-- name: UpdateChannel :exec
update channel_conversation set description = ?, project = ? where id = ? and kind in ('general', 'channel');

-- name: ChannelByName :one
select id from channel_conversation where name = ? and kind in ('general', 'channel');

-- name: Channels :many
-- The general channel first.
select * from channel_conversation where kind in ('general', 'channel') order by case when kind = 'general' then 0 else 1 end, id;

-- name: CreateThread :one
insert into channel_conversation (kind, parent_seq, subject_kind, subject_id, channel_id, created_at) values ('thread', ?, ?, ?, ?, ?) returning id;

-- name: ConversationByID :one
select * from channel_conversation where id = ?;

-- name: ThreadByParent :one
select id from channel_conversation where parent_seq = ?;

-- name: ThreadOfSubject :one
select id from channel_conversation where subject_kind = ? and subject_id = ? order by id desc limit 1;

-- name: RecentConversations :many
select * from channel_conversation order by coalesce(last_seq, 0) desc, id desc limit ?;

-- name: TouchConversation :exec
update channel_conversation
set last_seq = max(coalesce(last_seq, 0), cast(sqlc.arg(seq) as integer)),
    reply_count = reply_count + case when kind = 'thread' then 1 else 0 end
where id = sqlc.arg(id);

-- name: InboxOf :many
-- A participant's unread: the channel it is in and the threads it follows, newest first.
select c.id, c.kind, c.parent_seq, c.subject_kind, c.subject_id, cast(coalesce(ch.name, c.name, '') as text) as channel_name,
       count(m.seq) as unread,
       cast(max(exists (select 1 from channel_mention x where x.message_seq = m.seq and x.target_id = sqlc.arg(participant))) as boolean) as mentions_you,
       cast(max(m.seq) as integer) as latest
from channel_conversation c
left join channel_conversation ch on ch.id = c.channel_id
join channel_message m on m.conversation_id = c.id
left join channel_read_cursor rc on rc.participant_id = sqlc.arg(participant) and rc.conversation_id = c.id
left join channel_follow f on f.conversation_id = c.id and f.participant_id = sqlc.arg(participant) and f.unfollowed_at is null
where m.sender_id <> sqlc.arg(participant) and m.final and m.kind <> 'notice'
  and (c.id = sqlc.arg(channel) or f.participant_id is not null)
  and m.seq > max(coalesce(rc.read_seq, 0), coalesce(f.from_seq, 0))
  and not exists (select 1 from channel_seen_mark s where s.participant_id = sqlc.arg(participant) and s.message_seq = m.seq)
group by c.id
order by max(m.seq) desc
limit 20;
