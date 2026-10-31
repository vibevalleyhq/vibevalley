-- What goes out to each chat app, in order (connector/outbox.ts). Ids are made in time order.

-- name: AddOutbox :exec
insert into connector_outbox (id, connector, message_id, body, created_at) values (sqlc.arg(id), sqlc.arg(connector), sqlc.arg(message_id), sqlc.arg(body), sqlc.arg(created_at));

-- name: PendingOutbox :many
-- bound: only what waits; each is sent or dropped.
select id, body from connector_outbox where connector = sqlc.arg(connector) and state = 'pending' order by id;

-- name: CountPendingOutbox :one
select count(*)::int as n from connector_outbox where connector = sqlc.arg(connector) and state = 'pending';

-- name: OutboxSent :exec
update connector_outbox set state = 'sent', sent_at = sqlc.arg(sent_at), ext_id = sqlc.narg(ext_id), tries = tries + 1, error = null where id = sqlc.arg(id);

-- name: OutboxFailed :exec
update connector_outbox set tries = tries + 1, error = sqlc.narg(error) where id = sqlc.arg(id);

-- name: DropPendingOutbox :exec
update connector_outbox set state = 'dropped', error = sqlc.narg(error) where connector = sqlc.arg(connector) and state = 'pending';

-- name: MessageOfExt :many
-- The farm's message an app's id stands for: one this farm sent, or one it heard.
select message_id from connector_outbox where connector_outbox.connector = sqlc.arg(connector) and connector_outbox.ext_id = sqlc.arg(ext_id)
union all
select message_id from connector_inbound where connector_inbound.connector = sqlc.arg(connector) and connector_inbound.ext_id = sqlc.arg(ext_id) and message_id is not null
limit 1;

-- name: PruneOutbox :exec
-- A sent or dropped message older than before: what a reply that old points at is not looked up.
delete from connector_outbox where state <> 'pending' and created_at < sqlc.arg(before);
