-- The devices paired for lan access (lan/lan.ts).

-- name: LanDevices :many
-- bound: a row per device the owner paired.
select * from lan_device;

-- name: AddLanDevice :exec
insert into lan_device (id, name, key_hash, paired_at) values ($1, $2, $3, $4);

-- name: RemoveLanDevice :exec
delete from lan_device where id = $1;

-- name: SeenLanDevice :exec
update lan_device set last_seen = $1 where id = $2;
