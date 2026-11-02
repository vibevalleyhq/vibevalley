-- name: RecordTrigger :exec
insert into ingress_trigger (id, source, source_key, trigger_json, payload_json, occurred_at)
values (sqlc.arg(id), sqlc.arg(source), sqlc.arg(source_key), sqlc.arg(trigger_json), sqlc.arg(payload_json), sqlc.arg(occurred_at))
on conflict do nothing;

-- name: TriggerById :one
select trigger_json, payload_json from ingress_trigger where id = sqlc.arg(id);

-- name: UnroutedTriggers :many
select t.id, t.seq, t.trigger_json from ingress_trigger t
where t.seq > sqlc.arg(after)
  and t.source <> 'cron'
  and t.payload_json::jsonb->'data'->>'kind' is distinct from 'channel_message'
  and t.routed_at is null
order by t.seq limit 1000;

-- name: KnownGitHubEvents :many
-- bound: accepted event identities for one pull request.
select source_key, (trigger_json::jsonb->'meta'->>'botRoundKey')::text as bot_round_key,
       routed_at is not null as routed,
       (trigger_json::jsonb->'meta'->>'botRound')::int as bot_round
from ingress_trigger where source = 'github' and trigger_json::jsonb->'meta'->>'project' = sqlc.arg(project)
  and trigger_json::jsonb->'meta'->>'pr' = sqlc.arg(pr_number)::int::text;

-- name: MarkRouted :one
update ingress_trigger set
  routing_position = case when routed_at is null then nextval('mailbox_order') else routing_position end,
  routing_scope = coalesce(routing_scope, sqlc.arg(scope)),
  routed_at = coalesce(routed_at, sqlc.arg(routed_at))
where id = sqlc.arg(envelope_id)
returning routing_position as position, routing_scope as scope,
  (trigger_json::jsonb->'actor'->>'kind' = 'owner')::bool as from_owner;

-- name: IsRouted :one
select exists (select 1 from ingress_trigger where id = sqlc.arg(envelope_id) and routed_at is not null) as routed;

-- name: RetireIssueDispatches :exec
-- A session started on the issue: the assignment's own dispatch is not a second brief for it.
update ingress_trigger set
  routing_position = coalesce(routing_position, nextval('mailbox_order')),
  routing_scope = coalesce(routing_scope, 'issue:' || sqlc.arg(issue_id)),
  routed_at = coalesce(routed_at, sqlc.arg(at))
where routed_at is null
  and trigger_json::jsonb->'meta'->>'dispatch' = 'true'
  and trigger_json::jsonb->'meta'->>'issue' = sqlc.arg(issue_id);


-- name: UnroutedCronTriggers :many
select id, seq, trigger_json, payload_json from ingress_trigger
where source = 'cron' and routed_at is null and seq > sqlc.arg(after)
order by seq limit 1000;
