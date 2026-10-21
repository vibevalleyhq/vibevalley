-- Who a message @-ed, and what came of it (channel/store.ts).

-- name: InsertMention :exec
insert into channel_mention (message_id, target_id, resolved) values (sqlc.arg(message_id), sqlc.arg(target_id), sqlc.arg(resolved)) on conflict do nothing;
