-- Whether the yard gate is open: one row (gate/gate.go).

-- name: GateOpen :one
select open from gate where id = 1;

-- name: SetGateOpen :exec
insert into gate (id, open) values (1, ?) on conflict (id) do update set open = excluded.open;
