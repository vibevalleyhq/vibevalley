-- What each agent is handed of the chat, and how far it got: pending, announced, handed, then seen or dropped (channel/store.ts).

-- name: InsertDelivery :exec
insert into channel_delivery (recipient_id, message_id, reason, wakes, held_by, created_at)
values (sqlc.arg(recipient_id), sqlc.arg(message_id), sqlc.arg(reason), sqlc.arg(wakes), sqlc.narg(held_by), sqlc.arg(created_at)) on conflict do nothing;

-- name: MarkAnnounced :exec
update channel_delivery set state = 'announced', launch = sqlc.arg(launch), announced_at = sqlc.arg(announced_at)
where recipient_id = sqlc.arg(recipient_id) and message_id = sqlc.arg(message_id) and state in ('pending', 'announced');

-- name: MarkHanded :exec
update channel_delivery set state = 'handed', launch = sqlc.arg(launch), handed_at = sqlc.arg(handed_at)
where recipient_id = sqlc.arg(recipient_id) and message_id = sqlc.arg(message_id) and state in ('pending', 'announced');

-- name: SeenHanded :many
update channel_delivery set state = 'seen', seen_at = sqlc.arg(seen_at)
where recipient_id = sqlc.arg(recipient_id) and state = 'handed' and launch = sqlc.arg(launch)
returning message_id;

-- name: RollbackHanded :many
update channel_delivery set state = 'pending', launch = null where recipient_id = sqlc.arg(recipient_id) and state = 'handed'
returning message_id;

-- name: RollbackAll :exec
update channel_delivery set state = 'pending', launch = null where state in ('announced', 'handed');

-- name: RollbackAnnounced :exec
update channel_delivery set state = 'pending', launch = null where recipient_id = sqlc.arg(recipient_id) and state = 'announced' and launch = sqlc.arg(launch);

-- name: SeenUpTo :exec
update channel_delivery set state = 'seen', seen_at = sqlc.arg(at)
where recipient_id = sqlc.arg(recipient) and message_id in (
    select id from channel_message where conversation_id = sqlc.arg(conversation) and number <= sqlc.arg(upto))
  and state in ('pending', 'announced', 'handed');

-- name: SeenOne :exec
update channel_delivery set state = 'seen', seen_at = sqlc.arg(seen_at)
where recipient_id = sqlc.arg(recipient_id) and message_id = sqlc.arg(message_id) and state in ('pending', 'announced', 'handed');

-- name: DropOpen :exec
update channel_delivery set state = 'dropped', dropped_why = sqlc.arg(dropped_why), launch = null
where recipient_id = sqlc.arg(recipient_id) and state in ('pending', 'announced', 'handed');

-- name: AgentWakesByConversation :many
-- Agents waking agents in each conversation since the owner last spoke there, held ones not counted: what the chat
-- keeps in memory (channel/audience.ts) when it starts.
select m.conversation_id, count(*)::int as n from channel_delivery d
join channel_message m on m.id = d.message_id
join channel_participant s on s.id = m.sender_id
join channel_participant r on r.id = d.recipient_id
where m.id > coalesce((select max(u.id) from channel_message u where u.conversation_id = m.conversation_id and u.sender_id = 'user'), '')
  and s.kind in ('agent', 'orchestrator') and r.kind in ('agent', 'orchestrator') and d.wakes and d.held_by is null
group by m.conversation_id;

-- name: LastAgentWakes :many
-- When each recipient was last woken by an agent (channel/audience.ts).
select d.recipient_id, max(d.created_at)::float8 as at from channel_delivery d
join channel_message m on m.id = d.message_id
join channel_participant s on s.id = m.sender_id
where s.kind in ('agent', 'orchestrator') and d.wakes and d.held_by is null
group by d.recipient_id;

-- name: AllOpenDeliveries :many
-- The deliveries still open, with what an inbox shows of each: what the chat keeps in memory (channel/deliveries.ts).
select d.recipient_id, d.message_id, m.number, d.reason, d.wakes, d.held_by, d.state, d.launch, m.conversation_id, m.sender_id, m.kind, m.body,
       m.created_at, p.name, p.kind as sender_kind, c.kind as conversation_kind, c.parent_id, c.parent_number, c.subject_kind, c.subject_id,
       coalesce(ch.name, c.name, '')::text as channel_name
from channel_delivery d
join channel_message m on m.id = d.message_id
join channel_participant p on p.id = m.sender_id
join channel_conversation c on c.id = m.conversation_id
left join channel_conversation ch on ch.id = c.channel_id
where d.state in ('pending', 'announced', 'handed')
order by m.id;
