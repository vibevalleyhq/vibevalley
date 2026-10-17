-- What goes out to each chat app, in order (connector/connector.go).

-- name: AddOutbox :exec
insert into connector_outbox (id, connector, message_id, body, created_at) values (?, ?, ?, ?, ?);

-- name: PendingOutbox :many
select id, body from connector_outbox where connector = ? and state = 'pending' order by id;

-- name: CountPendingOutbox :one
select count(*) from connector_outbox where connector = ? and state = 'pending';

-- name: OutboxSent :exec
update connector_outbox set state = 'sent', sent_at = ?, ext_id = ?, tries = tries + 1, error = null where id = ?;

-- name: OutboxFailed :exec
update connector_outbox set tries = tries + 1, error = ? where id = ?;

-- name: DropPendingOutbox :exec
update connector_outbox set state = 'dropped', error = ? where connector = ? and state = 'pending';

-- name: MessageOfExt :one
-- The farm's message an app's id stands for: one this farm sent, or one it heard.
select message_id from connector_outbox where connector_outbox.connector = ?1 and connector_outbox.ext_id = ?2
union all
select message_id from connector_inbound where connector_inbound.connector = ?1 and connector_inbound.ext_id = ?2 and message_id is not null
limit 1;
