-- name: GetAccount :one
select secrets, user_id, pair_code, cursor, reply_context, last_inbound, paused_until, connected_at, channel_id
from connector_account where connector = ?1;

-- name: ConnectAccount :exec
insert into connector_account (connector, secrets, user_id, pair_code, connected_at) values (?1, ?2, ?3, ?4, ?5)
on conflict (connector) do update set secrets = excluded.secrets, user_id = excluded.user_id, pair_code = excluded.pair_code,
  cursor = '', reply_context = null, last_inbound = null, paused_until = null, connected_at = excluded.connected_at;

-- name: DeleteAccount :exec
delete from connector_account where connector = ?1;

-- name: PauseAccount :exec
update connector_account set paused_until = ?2 where connector = ?1;

-- name: PairAccount :exec
update connector_account set user_id = ?2, pair_code = null, reply_context = ?3, last_inbound = ?4 where connector = ?1;

-- name: FinishPairing :exec
update connector_inbound set delivered = 1, body = '' where connector = ?1 and ext_id = ?2;

-- name: UpdateReply :exec
update connector_account set reply_context = ?2, last_inbound = ?3 where connector = ?1;

-- name: SetChannel :exec
update connector_account set channel_id = ?2 where connector = ?1;

-- name: AccountsInChannel :one
select count(*) AS count from connector_account where channel_id = ?1;

-- name: AccountCount :one
select count(*) AS count from connector_account where connector = ?1;

-- name: AcceptInbound :exec
insert into connector_inbound (connector, ext_id, from_id, body, reply, quoted, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
on conflict (connector, ext_id) do nothing;

-- name: UpdateCursor :exec
update connector_account set cursor = ?2 where connector = ?1;

-- name: PendingInbound :many
select ext_id, from_id, body, reply, quoted from connector_inbound where connector = ?1 and delivered = 0 order by seq;

-- name: MarkDelivered :exec
update connector_inbound set delivered = 1, body = '', message_id = ?3 where connector = ?1 and ext_id = ?2;

-- name: AddOutgoing :exec
insert into connector_outbox (connector, message_id, body, created_at) values (?1, ?2, ?3, ?4);

-- name: PendingOutgoing :many
select seq, message_id, body from connector_outbox where connector = ?1 and state = 'pending' order by seq;

-- name: PendingCount :one
select count(*) AS count from connector_outbox where connector = ?1 and state = 'pending';

-- name: WithdrawOutgoing :exec
update connector_outbox set state = 'dropped', error = 'withdrawn' where message_id = ?1 and state = 'pending';

-- name: MarkSent :exec
update connector_outbox set state = 'sent', sent_at = ?2, ext_id = ?3, error = null where seq = ?1;

-- name: MarkSendError :exec
update connector_outbox set error = ?2 where seq = ?1;

-- name: MessageOfExternal :one
select o.message_id from connector_outbox o where o.connector = ?1 and o.ext_id = ?2
union all
select i.message_id from connector_inbound i where i.connector = ?1 and i.ext_id = ?2 and i.message_id is not null
limit 1;

-- name: PruneInbound :exec
delete from connector_inbound where delivered = 1 and created_at < ?1;

-- name: PruneOutgoing :exec
delete from connector_outbox where state <> 'pending' and created_at < ?1;

-- name: ForgetInbound :exec
delete from connector_inbound where connector = ?1;

-- name: RetirePending :exec
update connector_outbox set state = 'dropped', error = ?2 where connector = ?1 and state = 'pending';
