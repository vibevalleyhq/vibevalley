-- Who a message @-ed, and what came of it (channel/db.go).

-- name: InsertMention :exec
insert into mention (message_seq, target_id, resolved) values (?, ?, ?) on conflict do nothing;
