-- The account each chat app is connected with, one row for each (connector/connector.go).

-- name: ConnectorAccount :one
select * from connector_account where connector = ?;

-- name: ConnectAccount :exec
-- Connected again: what was kept of the account before goes.
insert into connector_account (connector, secrets, owner_id, pair_code, connected_at) values (?, ?, ?, ?, ?)
on conflict (connector) do update set secrets = excluded.secrets, owner_id = excluded.owner_id, pair_code = excluded.pair_code,
  cursor = '', reply_context = null, reply_at = null, last_inbound = null, paused_until = null, connected_at = excluded.connected_at;

-- name: DisconnectAccount :exec
delete from connector_account where connector = ?;

-- name: PauseAccount :exec
update connector_account set paused_until = ? where connector = ?;

-- name: AccountOwner :exec
update connector_account set owner_id = ?, pair_code = null where connector = ?;

-- name: AccountCursor :exec
update connector_account set cursor = ? where connector = ?;

-- name: AccountReply :exec
update connector_account set reply_context = ?, reply_at = ?, last_inbound = ? where connector = ?;

-- name: AccountChannel :exec
update connector_account set channel_id = ? where connector = ?;
