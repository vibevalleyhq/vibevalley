-- Triggers: each input as it reaches an agent, kept before Mailbox routes it (mailbox/triggers.ts), and its routing receipt.


-- name: RecordTrigger :exec
insert into session_trigger (id, source, source_key, actor_kind, is_channel_message, trigger_json, payload_json, occurred_at)
values (sqlc.arg(id), sqlc.arg(source), sqlc.arg(source_key), sqlc.arg(actor_kind), sqlc.arg(is_channel_message), sqlc.arg(trigger_json),
        sqlc.arg(payload_json), sqlc.arg(occurred_at))
on conflict do nothing;

-- name: TriggerById :one
select trigger_json, payload_json from session_trigger where id = sqlc.arg(id);

-- name: UnroutedTriggers :many
-- bound: a page; the chat's messages are not here (the watch reads them again from its own cursor).
select t.id, t.seq, t.trigger_json, t.payload_json from session_trigger t
where t.seq > sqlc.arg(after)
  and not t.is_channel_message
  and t.routed_at is null
order by t.seq limit 1000;

-- name: MarkRouted :one
update session_trigger set
  routing_position = case when routed_at is null then (select coalesce(max(id), 0) + 1 from session_order) else routing_position end,
  routing_scope = coalesce(routing_scope, sqlc.arg(scope)),
  routed_at = coalesce(routed_at, sqlc.arg(routed_at))
where id = sqlc.arg(envelope_id)
returning routing_position as position, routing_scope as scope,
  (actor_kind = 'user')::bool as from_user;

-- name: IsRouted :one
select exists (select 1 from session_trigger where id = sqlc.arg(envelope_id) and routed_at is not null)::bool as routed;
