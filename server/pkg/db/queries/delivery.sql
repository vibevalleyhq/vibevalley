-- What each agent is handed of the chat, and how far it got: pending, announced, handed, then seen or dropped (channel/db.go, deliver.go).

-- name: InsertDelivery :exec
insert into delivery (recipient_id, message_seq, reason, wakes, held_by, created_at) values (?, ?, ?, ?, ?, ?) on conflict do nothing;

-- name: OpenDeliveries :many
select d.message_seq, d.reason, d.wakes, d.held_by, d.state, d.launch, m.conversation_id, m.sender_id, m.kind, m.body, m.created_at,
       p.name, p.kind as sender_kind, c.kind as conversation_kind, c.parent_seq, c.subject_kind, c.subject_id,
       cast(coalesce(ch.name, c.name, '') as text) as channel_name
from delivery d
join message m on m.seq = d.message_seq
join participant p on p.id = m.sender_id
join conversation c on c.id = m.conversation_id
left join conversation ch on ch.id = c.channel_id
where d.recipient_id = ? and d.state in ('pending', 'announced', 'handed')
order by d.message_seq;

-- name: MarkAnnounced :exec
update delivery set state = 'announced', launch = ?, announced_at = ?
where recipient_id = ? and message_seq = ? and state in ('pending', 'announced');

-- name: MarkHanded :exec
update delivery set state = 'handed', launch = ?, handed_at = ?
where recipient_id = ? and message_seq = ? and state in ('pending', 'announced');

-- name: SeenHanded :many
update delivery set state = 'seen', seen_at = ?
where recipient_id = ? and state = 'handed' and launch = ?
returning message_seq;

-- name: RollbackHanded :execrows
update delivery set state = 'pending', launch = null where recipient_id = ? and state = 'handed';

-- name: RollbackAll :exec
update delivery set state = 'pending', launch = null where state in ('announced', 'handed');

-- name: RollbackAnnounced :exec
update delivery set state = 'pending', launch = null where recipient_id = ? and state = 'announced' and launch = ?;

-- name: SeenUpTo :exec
update delivery set state = 'seen', seen_at = sqlc.arg(at)
where recipient_id = sqlc.arg(recipient) and message_seq <= sqlc.arg(upto) and state in ('pending', 'announced', 'handed')
  and message_seq in (select seq from message where message.conversation_id = sqlc.arg(conversation));

-- name: SeenOne :exec
update delivery set state = 'seen', seen_at = ?
where recipient_id = ? and message_seq = ? and state in ('pending', 'announced', 'handed');

-- name: DropOpen :exec
update delivery set state = 'dropped', dropped_why = ?, launch = null
where recipient_id = ? and state in ('pending', 'announced', 'handed');

-- name: AgentWakesSinceUser :one
-- Agents waking agents since the owner last spoke here, held ones not counted.
select count(*) from delivery d
join message m on m.seq = d.message_seq
join participant s on s.id = m.sender_id
join participant r on r.id = d.recipient_id
where m.conversation_id = sqlc.arg(conversation)
  and m.seq > coalesce((select max(u.seq) from message u where u.conversation_id = sqlc.arg(conversation) and u.sender_id = 'user'), 0)
  and s.kind in ('worker', 'manager') and r.kind in ('worker', 'manager') and d.wakes and d.held_by is null;

-- name: LastAgentWake :one
select cast(coalesce(max(d.created_at), 0) as integer) from delivery d
join message m on m.seq = d.message_seq
join participant s on s.id = m.sender_id
where d.recipient_id = ? and s.kind in ('worker', 'manager') and d.wakes and d.held_by is null;
