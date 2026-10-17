-- Who a message @-ed, and what came of it (channel/db.go).

-- name: InsertMention :exec
insert into channel_mention (message_id, target_id, resolved) values (?, ?, ?) on conflict do nothing;
