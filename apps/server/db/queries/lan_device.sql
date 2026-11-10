-- The devices paired for lan access (lan/lan.ts).

-- name: LanDevices :many
-- bound: a row per device the user paired.
select * from lan_device;

-- name: AddLanDevice :exec
insert into lan_device (id, name, key_hash, paired_at) values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(key_hash), sqlc.arg(paired_at));

-- name: RemoveLanDevice :exec
delete from lan_device where id = sqlc.arg(id);

-- name: SeenLanDevice :exec
update lan_device set last_seen = sqlc.arg(last_seen) where id = sqlc.arg(id);
