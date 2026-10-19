-- Whether lan access is open: one row (lan/lan.go).

-- name: LanOpen :one
select open from lan where id = 1;

-- name: SetLanOpen :exec
insert into lan (id, open) values (1, ?) on conflict (id) do update set open = excluded.open;
