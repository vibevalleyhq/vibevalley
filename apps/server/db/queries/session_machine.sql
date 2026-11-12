-- The computers helpers work on (session/machine.ts).

-- name: HereMachine :one
select id, name, joined_at from session_machine where here;

-- name: AddHereMachine :exec
insert into session_machine (id, name, here, joined_at) values (sqlc.arg(id), sqlc.arg(name), true, sqlc.arg(joined_at));
