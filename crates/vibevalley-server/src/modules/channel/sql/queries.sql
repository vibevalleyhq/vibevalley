-- name: DefaultId :one
select id from channel where is_default;

-- name: CreateChannel :exec
insert into channel (id, type, is_default, name, description, repo, created_at) values (?1, 'channel', ?2, ?3, ?4, ?5, ?6);

-- name: CreateDirect :exec
insert into channel (id, type, peer_id, created_at) values (?1, 'direct', ?2, ?3) on conflict (peer_id) do nothing;

-- name: ClearDefault :exec
update channel set is_default = 0 where is_default;

-- name: MakeDefault :exec
update channel set is_default = 1 where id = ?1 and type = 'channel';

-- name: UpdateChannel :exec
update channel set description = ?1, repo = ?2 where id = ?3 and type = 'channel';

-- name: CreateThread :exec
insert into channel (id, type, root_id, root_number, subject_kind, subject_id, parent_id, created_at) values (?1, 'thread', ?2, ?3, ?4, ?5, ?6, ?7);

-- name: AllChannels :many
select * from channel order by id;

-- name: RecentChannels :many
select * from channel order by coalesce(last_number, 0) desc, id desc limit ?1;

-- name: TouchChannel :exec
update channel set last_number = max(coalesce(last_number, 0), cast(sqlc.arg(last_number) as integer)),
reply_count = reply_count + case when type = 'thread' then 1 else 0 end where id = sqlc.arg(id);

-- name: UnreadOf :many
with unread as (
  select c.id, c.type, c.root_number, cast(coalesce(ch.name, c.name, '') as text) as channel_name,
         count(m.id) as unread,
         cast(max(exists (select 1 from channel_mention x where x.message_id = m.id and x.target_id = ?1)) as integer) as mentions_you,
         coalesce(max(m.number), 0) as latest
  from channel c
  left join channel ch on ch.id = c.parent_id
  join channel_message m on m.channel_id = c.id
  left join channel_read_cursor rc on rc.participant_id = ?1 and rc.channel_id = c.id
  left join channel_member f on f.channel_id = c.id and f.participant_id = ?1 and f.left_at is null
  where m.sender_id <> ?1 and m.kind <> 'notice'
    and (c.id = ?2 or f.participant_id is not null)
    and m.number > max(coalesce(rc.read_number, 0), coalesce(f.from_number, 0))
    and not exists (select 1 from channel_seen s where s.participant_id = ?1 and s.message_id = m.id)
  group by c.id, ch.name
)
select u.type, u.root_number, u.channel_name, u.unread, u.mentions_you, p.name as latest_sender_name
from unread u left join channel_message lm on lm.channel_id = u.id and lm.number = u.latest
left join channel_participant p on p.id = lm.sender_id
order by u.latest desc limit 20;

-- name: BumpRevision :one
update channel set revision = revision + 1 where id = ?1 returning revision;

-- name: RenameChannel :exec
update channel set name = ?1 where id = ?2 and type <> 'direct';

-- name: SetCategory :exec
update channel set category = ?1 where id = ?2 and type = 'channel';

-- name: PlaceChannel :exec
update channel set position = ?1 where id = ?2;

-- name: SetArchived :exec
update channel set archived_at = ?1 where id = ?2 and not is_default;

-- name: SetNotify :exec
update channel set notify = ?1 where id = ?2;

-- name: TopicThreadsIn :one
select count(*) as total from channel t where t.parent_id = ?1 and t.subject_kind = 'issue';

-- name: UpsertParticipant :exec
insert into channel_participant (id, kind, name, agent_id, home_id, joined_at) values (?1, ?2, ?3, ?4, ?5, ?6)
on conflict (id) do update set name = excluded.name, agent_id = excluded.agent_id,
  home_id = coalesce(excluded.home_id, channel_participant.home_id), left_at = null;

-- name: AddParticipant :exec
insert into channel_participant (id, kind, name, joined_at) values (?1, ?2, ?3, ?4) on conflict (id) do nothing;

-- name: ParticipantLeft :exec
update channel_participant set left_at = ?1 where id = ?2 and left_at is null;

-- name: Participants :many
select id, kind, name, agent_id, home_id, joined_at, left_at from channel_participant order by joined_at, rowid;

-- name: AddMember :exec
insert into channel_member (channel_id, participant_id, reason, from_number) values (?1, ?2, ?3, ?4)
on conflict (channel_id, participant_id) do update set left_at = null;

-- name: RemoveMember :exec
update channel_member set left_at = ?1 where channel_id = ?2 and participant_id = ?3 and left_at is null;

-- name: AllMembers :many
select channel_id, participant_id from channel_member where left_at is null;

-- name: RemoveFromAll :exec
update channel_member set left_at = ?1 where participant_id = ?2 and left_at is null;

-- name: InsertMention :exec
insert into channel_mention (message_id, target_id, resolved) values (?1, ?2, ?3) on conflict do nothing;

-- name: MarkSeen :exec
insert into channel_seen (participant_id, message_id, seen_at)
select p.id, m.id, cast(sqlc.arg(seen_at) as integer) from channel_message m, channel_participant p where m.id = sqlc.arg(message_id) and p.id = sqlc.arg(participant_id)
on conflict do nothing;

-- name: SetReadCursor :exec
insert into channel_read_cursor (participant_id, channel_id, read_number, updated_at) values (?1, ?2, ?3, ?4)
on conflict (participant_id, channel_id) do update set
  read_number = max(channel_read_cursor.read_number, excluded.read_number), updated_at = excluded.updated_at;

-- name: ReadCursor :one
select read_number from channel_read_cursor where participant_id = ?1 and channel_id = ?2;

-- name: ReadCursorsOf :many
select channel_id, read_number from channel_read_cursor where participant_id = ?1;

-- name: MarkUnread :exec
insert into channel_read_cursor (participant_id, channel_id, read_number, updated_at) values ('user', ?1, ?2, ?3)
on conflict (participant_id, channel_id) do update set read_number = excluded.read_number, updated_at = excluded.updated_at;

-- name: InsertEvent :one
insert into channel_event (kind, channel_id, message_id, at) values (?1, ?2, ?3, ?4) returning seq;

-- name: EventsAfter :many
select seq, kind, channel_id, message_id, at from channel_event where seq > ?1 order by seq limit ?2;

-- name: EventOf :one
select seq, kind, channel_id, message_id, at from channel_event where message_id = ?1 and kind = 'posted';

-- name: InsertMessage :one
insert into channel_message (id, channel_id, number, sender_id, kind, body, meta, send_key, created_at, revision, reply_number)
values (?1, ?2, (select coalesce(max(number), 0) + 1 from channel_message where channel_id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
returning number;

-- name: UpdateMessageMeta :exec
update channel_message set meta = ?1 where id = ?2;

-- name: MessageById :one
select d.* from channel_message_detail d where d.id = ?1;

-- name: MessageBySendKey :one
select d.* from channel_message_detail d where d.sender_id = ?1 and d.send_key = ?2;

-- name: MessageByNumber :one
select d.* from channel_message_detail d where d.channel_id = ?1 and d.number = ?2;

-- name: UserMentions :many
select d.* from channel_message_location d join channel_mention n on n.message_id = d.id left join channel_read_cursor r on r.channel_id = d.channel_id and r.participant_id = 'user' where n.target_id = 'user' and d.sender_id <> 'user'
  and d.number > coalesce(r.read_number, 0)
  and not exists (select 1 from channel_message reply where reply.channel_id = d.channel_id and reply.sender_id = 'user' and reply.number > d.number)
order by d.id;

-- name: MessagesBefore :many
select d.* from channel_message_detail d where d.channel_id = ?1 and d.number < ?2 order by d.number desc limit ?3;

-- name: MessagesAfter :many
select d.* from channel_message_detail d where d.channel_id = ?1 and d.number > ?2 order by d.number limit ?3;

-- name: RecentReports :many
select d.* from channel_message_detail d where d.kind = 'report' order by d.id desc limit ?1;

-- name: ReportsAfter :many
select d.* from channel_message_detail d where d.kind = 'report' and d.id > ?1 order by d.id limit ?2;

-- name: RecentDuplicate :one
select id from channel_message where sender_id = ?1 and channel_id = ?2 and body = ?3 and created_at > ?4 order by id desc limit 1;

-- name: DispatchesIn :one
select count(*) as total from channel_message where channel_id = ?1 and kind = 'dispatch';

-- name: UserUnread :one
select count(*) as total from channel_message where channel_id = ?1 and number > ?2 and sender_id <> 'user' and kind <> 'notice' and deleted_at is null;

-- name: LatestNumber :one
select cast(coalesce(max(number), 0) as integer) as number from channel_message where channel_id = ?1;

-- name: CallersOf :many
select m.sender_id from channel_message m
join channel_mention n on n.message_id = m.id and n.target_id = ?1
where m.channel_id = ?2 and m.sender_id <> ?1 and m.id < ?3
  and m.id > coalesce((select max(s.id) from channel_message s where s.channel_id = ?2 and s.sender_id = ?1 and s.id < ?3), '')
order by m.id desc limit ?4;

-- name: UnseenIn :many
select m.id from channel_message m
where m.channel_id = ?1 and m.sender_id <> ?2
  and m.number > coalesce((select read_number from channel_read_cursor where participant_id = ?2 and channel_id = ?1), 0)
  and not exists (select 1 from channel_seen s where s.participant_id = ?2 and s.message_id = m.id)
order by m.number;

-- name: NoticeSinceUser :one
select count(*) as total from channel_message m
where m.channel_id = ?1 and m.sender_id = 'system' and json_extract(m.meta, '$.code') = ?2
  and m.id > coalesce((select max(u.id) from channel_message u where u.channel_id = ?1 and u.sender_id = 'user'), '');

-- name: MessagesChangedAfter :many
select d.* from channel_message_detail d where d.channel_id = ?1 and d.revision > ?2 order by d.revision limit ?3;

-- name: EditMessage :exec
update channel_message set body = ?1, edited_at = ?2, revision = ?3 where id = ?4;

-- name: DeleteMessage :exec
update channel_message set body = '', meta = null, reactions = null, deleted_at = ?1, revision = ?2 where id = ?3;

-- name: SetReactions :exec
update channel_message set reactions = ?1, revision = ?2 where id = ?3;

-- name: SetPinned :exec
update channel_message set pinned_at = ?1, revision = ?2 where id = ?3;

-- name: SetMeta :exec
update channel_message set meta = ?1, revision = ?2 where id = ?3;

-- name: PinnedIn :many
select d.* from channel_message_detail d where d.channel_id = ?1 and d.pinned_at is not null order by d.pinned_at desc;

-- name: SearchMessages :many
select d.* from channel_message_location d where d.deleted_at is null and d.kind <> 'notice'
  and (cast(sqlc.arg(needle) as text) = '' or instr(lower(d.body), lower(cast(sqlc.arg(needle) as text))) > 0)
  and (cast(sqlc.arg(place) as text) = '' or d.channel_id = cast(sqlc.arg(place) as text) or d.top_id = cast(sqlc.arg(place) as text))
  and (cast(sqlc.arg(sender) as text) = '' or d.sender_id = cast(sqlc.arg(sender) as text) or lower(d.sender_name) = lower(cast(sqlc.arg(sender) as text)))
  and (not cast(sqlc.arg(file_only) as integer) or instr(coalesce(d.meta, ''), '"attachments"') > 0)
  and (not cast(sqlc.arg(image_only) as integer) or instr(coalesce(d.meta, ''), '"type":"image/') > 0)
  and (not cast(sqlc.arg(link_only) as integer) or instr(d.body, 'http://') > 0 or instr(d.body, 'https://') > 0)
  and d.created_at >= cast(sqlc.arg(since) as integer) and d.created_at < cast(sqlc.arg(until_time) as integer)
order by d.id desc limit cast(sqlc.arg(page_size) as integer);

-- name: NotificationReceipt :one
select r.updated_at,
  cast(exists (select 1 from channel_message n where n.channel_id = m.channel_id and n.number > m.number
    and n.deleted_at is null and (n.sender_id = 'user' or (m.kind = 'report' and n.kind = 'report' and n.sender_id = m.sender_id))) as integer) as superseded
from channel_message m
left join channel_read_cursor r on r.channel_id = m.channel_id and r.participant_id = 'user' and r.read_number >= m.number
where m.id = ?1;

-- name: UserReadReports :many
select m.sender_id, m.created_at, r.updated_at from channel_message m
join channel_read_cursor r on r.channel_id = m.channel_id and r.participant_id = 'user' and r.read_number >= m.number
where m.kind = 'report' and m.deleted_at is null
  and not exists (select 1 from channel_message n where n.channel_id = m.channel_id and n.sender_id = m.sender_id and n.kind = 'report' and n.number > m.number);

-- name: CursorOf :one
select seq from watch_cursor where name = ?1;

-- name: MoveCursor :exec
insert into watch_cursor (name, seq) values (?1, ?2) on conflict (name) do update set seq = max(seq, excluded.seq);

-- name: RemoveThreadMessages :exec
delete from channel_message where channel_id in (select id from channel where parent_id = ?1);

-- name: RemoveChannelMembers :exec
delete from channel_member where channel_id = ?1 or channel_id in (select id from channel where parent_id = ?1);

-- name: RemoveChannelCursors :exec
delete from channel_read_cursor where channel_id = ?1 or channel_id in (select id from channel where parent_id = ?1);

-- name: RemoveThreads :exec
delete from channel where parent_id = ?1;

-- name: RemoveMessages :exec
delete from channel_message where channel_id = ?1;

-- name: RemoveChannel :exec
delete from channel where id = ?1 and not is_default;
