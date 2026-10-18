-- Durable platform acceptance and manager delivery, owned by connector/inbox.go.

-- name: AcceptInbound :exec
insert into connector_inbound (connector, ext_id, message_id, created_at, payload, delivered)
values (?, ?, null, ?, ?, 0) on conflict (connector, ext_id) do nothing;

-- name: PendingInbound :many
select ext_id, payload from connector_inbound where connector = ? and delivered = 0 order by rowid;

-- name: DeliverInbound :exec
update connector_inbound set delivered = 1, payload = '' where connector = ? and ext_id = ?;

-- name: ClearInbound :exec
delete from connector_inbound where connector = ?;
