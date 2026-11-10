-- The computers helpers work on (machine/machine.ts).

-- name: HereMachine :one
select id, name, joined_at from machine where here;

-- name: AddHereMachine :exec
insert into machine (id, name, here, joined_at) values (sqlc.arg(id), sqlc.arg(name), true, sqlc.arg(joined_at));
