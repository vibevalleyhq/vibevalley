-- Durable platform acceptance and orchestrator delivery (connector/inbox.ts).

-- name: AcceptInbound :exec
insert into connector_inbound (connector, ext_id, message_id, created_at, payload, delivered)
values (sqlc.arg(connector), sqlc.arg(ext_id), null, sqlc.arg(created_at), sqlc.arg(payload), false) on conflict (connector, ext_id) do nothing;

-- name: PendingInbound :many
select ext_id, payload from connector_inbound where connector = sqlc.arg(connector) and not delivered order by seq;

-- name: DeliverInbound :exec
update connector_inbound set delivered = true, payload = '' where connector = sqlc.arg(connector) and ext_id = sqlc.arg(ext_id);

-- name: ClearInbound :exec
delete from connector_inbound where connector = sqlc.arg(connector);
