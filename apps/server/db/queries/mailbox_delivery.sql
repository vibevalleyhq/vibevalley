-- What each Agent Session is handed, and how far it got: pending, handed, then consumed or dropped.

-- name: InsertDelivery :many
-- bound: at most one newly inserted delivery.
-- The position is taken here, not by a trigger: RETURNING does not see what an AFTER trigger changes.
insert into mailbox_delivery (position, session_id, envelope_id, scope, channel_id, message_id, source, urgency, reason, wakes, held_by, payload_json,
                              created_at)
values ((select coalesce(max(id), 0) + 1 from mailbox_order), sqlc.arg(session_id), sqlc.arg(envelope_id), sqlc.arg(scope), sqlc.narg(channel_id),
        sqlc.narg(message_id), sqlc.arg(source), sqlc.arg(urgency), sqlc.arg(reason), sqlc.arg(wakes), sqlc.narg(held_by), sqlc.arg(payload_json),
        sqlc.arg(created_at)) on conflict do nothing
returning position;

-- name: MarkHanded :exec
update mailbox_delivery set state = 'handed', launch = sqlc.arg(launch), handed_at = sqlc.arg(handed_at)
where session_id = sqlc.arg(session_id) and envelope_id = sqlc.arg(envelope_id) and state = 'pending';

-- name: DeliveryReceipt :one
select state, dropped_why from mailbox_delivery where session_id = sqlc.arg(session_id) and envelope_id = sqlc.arg(envelope_id);

-- name: DeliveryPayload :one
select payload_json from mailbox_delivery where session_id = sqlc.arg(session_id) and envelope_id = sqlc.arg(envelope_id);

-- name: DropReassigned :exec
update mailbox_delivery set state = 'dropped', dropped_why = 'reassigned', launch = null
where session_id = sqlc.arg(session_id) and envelope_id = sqlc.arg(envelope_id) and state in ('pending', 'handed');

-- name: RollbackHanded :many
-- bound: what is handed to one recipient and not seen yet.
update mailbox_delivery set state = 'pending', launch = null where session_id = sqlc.arg(session_id) and state = 'handed'
returning envelope_id;

-- name: RollbackOne :exec
update mailbox_delivery set state = 'pending', launch = null
where session_id = sqlc.arg(session_id) and envelope_id = sqlc.arg(envelope_id) and state = 'handed';

-- name: RollbackAll :exec
update mailbox_delivery set state = 'pending', launch = null where state = 'handed';

-- name: ConsumeDelivery :exec
update mailbox_delivery set state = 'consumed', consumed_at = sqlc.arg(consumed_at)
where session_id = sqlc.arg(session_id) and envelope_id = sqlc.arg(envelope_id) and state in ('pending', 'handed');

-- name: DropOpen :exec
update mailbox_delivery set state = 'dropped', dropped_why = sqlc.arg(dropped_why), launch = null
where session_id = sqlc.arg(session_id) and state in ('pending', 'handed');

-- name: AgentWakesByScope :many
-- bound: a row per routing scope.
with owners as (
  select scope, max(position) as position from mailbox_owner_route group by scope
)
select d.scope, count(*)::int as n from mailbox_delivery d
left join owners o on o.scope = d.scope
where d.position > coalesce(o.position, 0)
  and d.payload_json -> 'trigger' -> 'actor' ->> 'kind' in ('session', 'orchestrator') and d.wakes and d.held_by is null
group by d.scope;

-- name: LastAgentWakes :many
-- bound: a row per participant.
select d.session_id, max(d.created_at)::float8 as at from mailbox_delivery d
where d.payload_json -> 'trigger' -> 'actor' ->> 'kind' in ('session', 'orchestrator') and d.wakes and d.held_by is null
group by d.session_id;

-- name: AllOpenDeliveries :many
-- bound: only open deliveries; each closes when seen, dropped or its message deleted.
-- Input snapshots are independent of channel_message; machine deliveries have no message_id.
select d.session_id, d.envelope_id, d.position, d.scope, d.message_id, coalesce(d.channel_id, '')::text as channel_id,
       d.source, d.urgency, d.reason, d.wakes, d.held_by, d.state, d.launch, d.created_at, d.payload_json
from mailbox_delivery d
where d.state in ('pending', 'handed')
order by d.position;

-- name: DropOpenOf :many
-- bound: one message's open deliveries, one per recipient.
-- A message deleted: what it was still waiting to hand goes.
update mailbox_delivery set state = 'dropped', dropped_why = 'deleted'
where message_id = sqlc.arg(message_id) and state in ('pending', 'handed')
returning session_id;

-- name: WaitingOn :many
-- bound: one message's open deliveries, one per recipient.
-- Who a message is still waiting to be handed to.
select session_id from mailbox_delivery where message_id = sqlc.arg(message_id) and state in ('pending', 'handed');

-- name: LastOwnerRoutes :many
-- bound: one owner epoch per routing scope, including returned deliveries.
select scope, max(position)::int as position from mailbox_owner_route group by scope;
