-- The farm's one user: one row, once a name or a password is set (user/user.ts).

-- name: UserAccount :one
select name, password_hash, password_set_at from user_account where id = 1;

-- name: SetUserName :exec
insert into user_account (id, name) values (1, sqlc.arg(name)) on conflict (id) do update set name = excluded.name;

-- name: SetUserPassword :exec
insert into user_account (id, name, password_hash, password_set_at) values (1, '', sqlc.arg(password_hash), sqlc.arg(password_set_at))
on conflict (id) do update set password_hash = excluded.password_hash, password_set_at = excluded.password_set_at;
