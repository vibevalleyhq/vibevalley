-- The account each chat app is connected with, one row for each (connector/connector.ts).

-- name: ConnectorAccount :one
select * from connector_account where connector = sqlc.arg(connector);

-- name: ConnectAccount :exec
-- Connected again: what was kept of the account before goes.
insert into connector_account (connector, secrets, owner_id, pair_code, connected_at)
values (sqlc.arg(connector), sqlc.arg(secrets), sqlc.narg(owner_id), sqlc.narg(pair_code), sqlc.arg(connected_at))
on conflict (connector) do update set secrets = excluded.secrets, owner_id = excluded.owner_id, pair_code = excluded.pair_code,
  cursor = '', reply_context = null, reply_at = null, last_inbound = null, paused_until = null, connected_at = excluded.connected_at;

-- name: DisconnectAccount :exec
delete from connector_account where connector = sqlc.arg(connector);

-- name: PauseAccount :exec
update connector_account set paused_until = sqlc.narg(paused_until) where connector = sqlc.arg(connector);

-- name: AccountOwner :exec
update connector_account set owner_id = sqlc.narg(owner_id), pair_code = null where connector = sqlc.arg(connector);

-- name: AccountCursor :exec
update connector_account set cursor = sqlc.arg(cursor) where connector = sqlc.arg(connector);

-- name: AccountReply :exec
update connector_account set reply_context = sqlc.narg(reply_context), reply_at = sqlc.arg(at), last_inbound = sqlc.arg(at) where connector = sqlc.arg(connector);

-- name: AccountChannel :exec
update connector_account set channel_id = sqlc.narg(channel_id) where connector = sqlc.arg(connector);
