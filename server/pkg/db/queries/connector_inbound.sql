-- The messages each chat app sent in, so one is heard once (connector/connector.go).

-- name: InboundSeen :one
select ext_id from connector_inbound where connector = ? and ext_id = ?;

-- name: AddInbound :exec
insert into connector_inbound (connector, ext_id, message_seq, created_at) values (?, ?, null, ?) on conflict (connector, ext_id) do nothing;
