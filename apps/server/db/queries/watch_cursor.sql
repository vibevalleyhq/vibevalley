-- How far the watch has handled the chat's events (watch/watch.ts).

-- name: CursorOf :one
select seq from watch_cursor where name = sqlc.arg(name);

-- name: MoveCursor :exec
insert into watch_cursor (name, seq) values (sqlc.arg(name), sqlc.arg(seq))
-- Only on: a message told again (a direct talk's missed words) never takes it back.
on conflict (name) do update set seq = greatest(watch_cursor.seq, excluded.seq);
