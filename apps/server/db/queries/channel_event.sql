-- What happened in the chat, in the order it was committed (channel/writing.ts).

-- name: InsertEvent :one
insert into channel_event (kind, channel_id, message_id, at) values (sqlc.arg(kind), sqlc.arg(channel_id), sqlc.arg(message_id), sqlc.arg(at))
returning seq;

-- name: EventsAfter :many
-- bound: n rows.
select seq, kind, channel_id, message_id, at from channel_event where seq > sqlc.arg(after)::int order by seq limit sqlc.arg(n)::int;

-- name: EventOf :one
select seq, kind, channel_id, message_id, at from channel_event where message_id = sqlc.arg(message_id) and kind = 'posted';
