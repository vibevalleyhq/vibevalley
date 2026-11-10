-- The user's devices, each with its own key (user/user.ts).

-- name: UserDevices :many
-- bound: a row per device the user paired or signed in on.
select * from user_device;

-- name: AddUserDevice :exec
insert into user_device (id, name, came, key_hash, added_at) values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(came), sqlc.arg(key_hash), sqlc.arg(added_at));

-- name: RemoveUserDevice :exec
delete from user_device where id = sqlc.arg(id);

-- name: SeenUserDevice :exec
update user_device set last_seen = sqlc.arg(last_seen) where id = sqlc.arg(id);
